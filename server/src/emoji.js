/**
 * 表情包：文件夹当图库，一个情绪一个子文件夹。
 *
 *   data/images/emojis/紧张/xxx.gif
 *   data/images/emojis/开心/yyy.png
 *
 * 子文件夹名就是**情绪标签**，也就是模型写在 `[send_emoji:紧张]` 方括号里的那个词。
 * 这一层不需要任何配置文件 —— 用户往文件夹里丢图、建文件夹，这里 readdir 就看得见。
 *
 * 硬盘上有的标签**默认全都能用**，只被角色自己的黑名单减一遍（那道闸在
 * prompt.js / imessage.js 里）。这个文件只回答三件事：「硬盘上有什么」、
 * 「给我一个标签，随机挑一张图」、「把这张图存进某个标签」。
 *
 * 后缀白名单直接复用 media.js 的 REF_EXTS —— 参考图认哪几种，表情包就认哪几种。
 * 比后缀时一律 toLowerCase：实测用户的表情包里有几十个 `.GIF` 大写后缀的文件，
 * Windows 上无所谓，Linux 上大小写敏感，不统一就会漏掉一大批。
 */

import fs from "node:fs";
import path from "node:path";

import { EMOJI_DIR } from "./datadir.js";
import { logDebug, logWarn } from "./logs.js";
import { REF_EXTS, mimeForExt, safeUploadName, sniffImageType } from "./media.js";

/**
 * 每个标签最近发过哪几张，用来躲开「连着几次挑到同一张」。
 *
 * 值是一个先进先出的小队列（最近的在末尾）。躲几张由角色的
 * `stickerSend.noRepeat` 决定（「连着 N 次不重样」= 躲开最近 N-1 张），
 * 所以这里统一多留几条，N 调大了也能立刻生效。
 *
 * 只在内存里，重启就忘 —— 这不是需要持久化的状态，忘了最多是重启后头几次
 * 可能和重启前撞上。文件夹里图不够多时会自动往下夹（见 pickEmoji）。
 */
const recentPicks = new Map();

/** 每个标签最多记住这么多条历史。上限 = noRepeat 的上限 50 减 1，取整到 50。 */
const HISTORY_CAP = 50;

/**
 * 标签名 → 那个文件夹的绝对路径。不合法或者不存在返回 null。
 *
 * `path.basename` 是**安全边界**：标签会从模型的回复里、也会从前端的 URL 里
 * 进来，`../../..` 到这儿只剩最后一段。再挡掉点开头的（`.` / `..` / 隐藏文件夹），
 * 最后要求它真的是个文件夹 —— 三条加起来，越不出 emojis/ 这一层。
 */
export function resolveEmojiTag(tag) {
  const base = path.basename(String(tag ?? "").trim());
  if (!base || base.startsWith(".")) return null;
  const full = path.join(EMOJI_DIR, base);
  try {
    return fs.statSync(full).isDirectory() ? full : null;
  } catch {
    return null;
  }
}

/**
 * emojis/ 下面有哪些标签，各有几张图。
 *
 * 空文件夹**也列出来**（count 为 0）：用户刚建好文件夹还没往里放图的时候，
 * 界面上得看得见它，不然会以为建错地方了。真正拦住「空标签别注入给模型」
 * 的是 prompt.js 那边 —— 那里按 count 过滤。
 */
export function listEmojiTags() {
  let entries = [];
  try {
    entries = fs.readdirSync(EMOJI_DIR, { withFileTypes: true });
  } catch {
    return []; // 文件夹还没建 / 读不了，当没有表情包，不该让接口挂掉
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith(".")) continue; // .DS_Store 之类的隐藏目录
    out.push({ tag: e.name, count: listEmojiFiles(e.name).length });
  }
  out.sort((a, b) => a.tag.localeCompare(b.tag, "zh"));
  return out;
}

/** 一个标签下面的图片文件（按名字排）。标签不存在就是空数组。 */
export function listEmojiFiles(tag) {
  const dir = resolveEmojiTag(tag);
  if (!dir) return [];
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    if (f.startsWith(".")) continue;
    if (!REF_EXTS.includes(path.extname(f).toLowerCase())) continue;
    let size = 0;
    try {
      size = fs.statSync(path.join(dir, f)).size;
    } catch {
      continue; // 刚被删掉之类，跳过
    }
    out.push({ file: f, size });
  }
  // 「开心 (2).gif」和「开心 (10).gif」按数字排更顺眼，numeric 就是干这个的
  out.sort((a, b) => a.file.localeCompare(b.file, "zh", { numeric: true }));
  return out;
}

/**
 * 标签 + 文件名 → 绝对路径。找不到返回 null。
 *
 * 两段各自过一遍 `path.basename`（缺一不可：只挡标签的话
 * `?tag=开心&file=../../../data.config.json` 就穿出去了），后缀必须在白名单里。
 */
export function resolveEmojiFile(tag, file) {
  const dir = resolveEmojiTag(tag);
  if (!dir) return null;
  const base = path.basename(String(file ?? "").trim());
  if (!base || base.startsWith(".")) return null;
  if (!REF_EXTS.includes(path.extname(base).toLowerCase())) return null;
  const full = path.join(dir, base);
  return fs.existsSync(full) ? full : null;
}

/**
 * 从一个标签里随机挑一张，连内容一起读出来。
 *
 * 挑不到（标签不存在 / 文件夹是空的 / 图读不出来）返回 null，让调用方决定是
 * 退化成文字还是只记一条日志 —— 表情包发不出去不该把整条回复卡住。
 *
 * `noRepeat` 是角色配置里的「连着 N 次不会挑到同一张」（默认 5）：
 *
 *   - N = 5 → 躲开最近 **4** 张，这次挑出来的就跟前 4 次都不一样，
 *     连起来看就是「连着 5 次没重样」；
 *   - N = 1 → 不躲，每次都在全部图里随机（可能连着两次一样）。
 *
 * 文件夹里图不够的时候自己往下夹：只有 3 张图却要求连着 5 次不重样，
 * 数学上做不到，就退化成「躲开最近 2 张」，而不是躲到没得挑。
 *
 * @returns {{tag:string, file:string, path:string, buffer:Buffer, mimeType:string, ext:string}|null}
 */
export function pickEmoji(tag, noRepeat = 5) {
  const dir = resolveEmojiTag(tag);
  if (!dir) return null;
  const files = listEmojiFiles(tag);
  if (!files.length) return null;

  const key = path.basename(String(tag).trim());
  const history = recentPicks.get(key) ?? [];

  // 要躲开的张数：N-1，再夹到「文件夹里的张数 - 1」，至少 0
  const n = Number.isFinite(Number(noRepeat)) ? Math.round(Number(noRepeat)) : 5;
  const window = Math.max(0, Math.min(n - 1, files.length - 1));
  const avoid = new Set(window ? history.slice(-window) : []);

  // 历史里可能有已经被删掉的文件名，过滤完反而更宽 —— 无所谓，够挑就行。
  // rest 为空只会发生在「历史里全是现存文件且刚好占满」的边界上，兜底照发全部。
  const rest = avoid.size ? files.filter((f) => !avoid.has(f.file)) : files;
  const pool = rest.length ? rest : files;

  const hit = pool[Math.floor(Math.random() * pool.length)];
  const full = path.join(dir, hit.file);
  let buffer;
  try {
    buffer = fs.readFileSync(full);
  } catch (e) {
    logWarn("表情包", `读不了 ${key}/${hit.file}：${String(e?.message ?? e)}`);
    return null;
  }
  // 多留几条：N 被调大之后不用等历史重新攒够才生效
  recentPicks.set(key, [...history, hit.file].slice(-HISTORY_CAP));

  const ext = path.extname(hit.file).toLowerCase();

  // 后缀以**字节**为准，不信文件名。
  //
  // 用户攒的图库里大约六分之一的文件后缀是错的（JPEG 存成 .gif 最多，其次是
  // PNG 存成 .jpg）—— 图库这边无所谓，看图软件都按内容认；但发给对方时
  // 文件名是 iMessage 唯一的判断依据，后缀和内容对不上那头就不当图片渲染，
  // 气泡里变成一个灰色文件图标。「gif 发过去变成文件」就是这么来的。
  //
  // 只改**发出去的后缀**，硬盘上的文件一个都不动 —— 图库是用户自己的东西。
  // 认不出的类型（比如 REF_EXTS 之外混进来的）退回文件名后缀，保持原样。
  const sniffed = sniffImageType(buffer);
  if (sniffed && sniffed.mimeType !== mimeForExt(ext)) {
    logDebug("表情包", `${key}/${hit.file} 实际是 ${sniffed.mimeType}，按真实格式发（后缀 ${ext} 是错的）`);
  }

  return {
    tag: key,
    file: hit.file,
    path: full,
    buffer,
    mimeType: sniffed?.mimeType ?? mimeForExt(ext),
    ext: sniffed?.ext ?? ext,
  };
}

/**
 * 删一张表情包。删的是**硬盘上的文件**，没有回收站。
 *
 * 界面上「方便删减表情包」要的就是这个 —— 用户看着缩略图挑出不想要的那几张
 * 直接删，比开文件管理器一张张对着看快得多。删不掉（不存在 / 路径不合法）
 * 返回 false，调用方回 404。
 */
export function removeEmojiFile(tag, file) {
  const full = resolveEmojiFile(tag, file);
  if (!full) return false;
  fs.rmSync(full, { force: true });
  return true;
}

/**
 * 建一个标签（也就是 emojis/ 下面的一个子文件夹），返回真正落盘的名字。
 * 名字被剔干净之后什么都不剩就返回 null。
 *
 * 界面上得能建：全新安装时 emojis/ 是空的，「直接在图库里上传」没有文件夹可传。
 * 让用户为了传第一张图先去开文件管理器，那这个上传功能等于白做。
 *
 * 剔字符的规矩和 config.js 的 normalizeEmojiTag 对齐（Windows 非法字符 + 控制
 * 字符 + 连续的点），外加 `path.basename` 兜路径穿越、去掉首尾的点和空格。
 * 已经存在的话 mkdir recursive 不报错，直接当「就用这个」——「建一个已经有的
 * 标签」在用户看来本来就该是无事发生。
 */
export function createEmojiTag(name) {
  const base = path
    .basename(String(name ?? "").trim())
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "")
    .replace(/\.{2,}/g, "")
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "")
    .trim()
    .slice(0, 40);
  if (!base) return null;
  fs.mkdirSync(path.join(EMOJI_DIR, base), { recursive: true });
  return base;
}

/**
 * 存一张图到某个标签下，返回落盘的文件名。标签不存在返回 null（不替用户建）。
 *
 * 压缩在**浏览器里**做（client/src/imagefile.js）：几百张表情包一张张读进
 * Node 再解码重编码，内存会顶到天上，而且这台机器还挂着几条 Photon 线路。
 * 传上来的已经是压好的 base64，这里只负责挑个不撞的文件名写进去。
 */
export function saveEmojiFile(tag, rawName, base64, mimeType) {
  const dir = resolveEmojiTag(tag);
  if (!dir) return null;
  const file = safeUploadName({
    raw: rawName,
    mimeType,
    fallback: "表情包",
    taken: (n) => fs.existsSync(path.join(dir, n)),
  });
  fs.writeFileSync(path.join(dir, file), Buffer.from(String(base64 ?? ""), "base64"));
  return file;
}
