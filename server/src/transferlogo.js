/**
 * 转账卡片上那张缩略图：SVG / 位图 → 卡片能收的 JPEG 字节。
 *
 * ── 为什么卡片值得有张图 ──
 *
 * `MiniAppLayout` 只给六个文字槽（金额、备注、状态），排版权在苹果手上。
 * 那张 `image` 是这张卡片上**唯一一块我们能自己画的地方** —— 有没有它，
 * 一张「转账凭证」像不像样差得很远。
 *
 * proto 那边的约束抄在这儿（message_service.proto:MiniAppLayout）：
 *
 *   image           JPEG 字节，**服务端会验它真能解成 JPEG**
 *   image_title     必须和 image 一起给
 *   image_subtitle  要求先有 image
 *
 * 也就是说给了图就必须给 `imageTitle`。这个功能里那行字放「谁发的」
 * （`role.transfer.appName`），空着就退回「转账」—— 不是配置的兜底，是
 * 协议要求这个字段非空，见 card.js:transferLayout。
 *
 * ── 为什么用 @napi-rs/canvas，而不是 ffmpeg ──
 *
 * 项目里转图一向靠 `ffmpeg-static`（igimage.js 就是），但 **ffmpeg 这个构建
 * 没有 SVG 解码器**（实测 `no decoder found for: svg`，因为 SVG 要 librsvg，
 * 静态包里没编进去）。而用户手上的品牌 logo 基本都是 SVG —— 那是这类素材的
 * 通行格式，硬要用户先自己转成 PNG 不合理。
 *
 * `@napi-rs/canvas` 是 skia 绑定，SVG 和位图都吃，输出直接是 JPEG。它本来就
 * 在 node_modules 里（`pdf-parse` 的依赖），但**在 server/package.json 里
 * 显式声明了**：靠别人的传递依赖当基础设施，哪天 pdf-parse 换实现就静默塌掉。
 *
 * ── 为什么统一画到同一块画布上 ──
 *
 * 用户找来的 logo 什么比例都有（Chase 那个 5.4:1 的长条、微信支付近正方形）。
 * 直接把原图交上去，苹果会按它自己的规则裁 —— 长条 logo 会被裁得只剩中间
 * 几个字母。所以这里一律**等比缩放后居中放到一块固定画布上**，留白填背景色：
 * 原图是方的还是长的，出来的卡片都一样高，不会因为换个 logo 整张卡片变形。
 *
 * 渲染结果缓存在内存里（按文件路径 + mtime + 尺寸），同一个 logo 连发十笔
 * 转账只光栅化一次。缓存只是省 CPU，丢了也只是重画一遍。
 */

import fs from "node:fs";
import path from "node:path";

import { BUILTIN_TRANSFER_LOGO_DIR, TRANSFER_LOGO_DIR, ensureLayout } from "./datadir.js";
import { logDebug, logWarn } from "./logs.js";

const SCOPE = "转账";

/**
 * 认这几种后缀。
 *
 * 比 media.js 的 `REF_EXTS` 多一个 `.svg`、少一个 `.gif`：
 * logo 就该是矢量的（缩放不糊），而动图在这儿没有意义（只能取一帧）。
 */
export const LOGO_EXTS = [".svg", ".png", ".jpg", ".jpeg", ".webp"];

/**
 * 画布尺寸。
 *
 * 600×300 是 2:1，接近 iMessage 给卡片缩略图的显示比例。再大没用 —— 那张图在
 * 气泡里就一两百像素宽，600 已经够 Retina 了，而字节是要走 gRPC 的。
 */
export const CANVAS_W = 600;
export const CANVAS_H = 300;

/** logo 四周留白。留白不够的话图会顶到边上，看着像截断的。 */
const PADDING = 48;

/** JPEG 质量。88 在这个尺寸下通常 10–30KB，肉眼看不出压缩痕迹。 */
const JPEG_QUALITY = 88;

/**
 * 字节上限，超了就不发这张图（卡片照旧发，只是没图）。
 *
 * proto 和 SDK 都没写上限，服务端的真实限制不清楚。600×300 的 JPEG 正常
 * 20KB 左右，256KB 已经远超任何合理值 —— 真到了那个数，说明输入是张
 * 不该拿来当 logo 的巨图，宁可不带图也别拿整条转账去赌。
 */
const MAX_BYTES = 256 * 1024;

/** 渲染结果缓存：`路径|mtime|背景色` → JPEG Buffer。 */
const cache = new Map();

/** 一个文件夹里合法的 logo 文件。读不了就当空的。 */
function scanDir(dir) {
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    if (!LOGO_EXTS.includes(path.extname(f).toLowerCase())) continue;
    let size = 0;
    try {
      size = fs.statSync(path.join(dir, f)).size;
    } catch {
      continue; // 刚好被删掉之类，跳过
    }
    out.push({ file: f, size });
  }
  out.sort((a, b) => a.file.localeCompare(b.file));
  return out;
}

/** assets/transfer-logos/ 里那几个（随代码发，界面上删不掉）。 */
export function listBuiltinLogos() {
  return scanDir(BUILTIN_TRANSFER_LOGO_DIR).map((l) => ({ ...l, builtin: true }));
}

/**
 * 界面上能选的全部 logo：内置的排前面，用户自己放的排后面。
 *
 * 同名时以用户的为准（内置那条从清单里去掉）—— 和 wallpaper.js:listWallpapers
 * 同一条规矩：一个名字对应一个文件，清单里出现两个一样的 `file` 会让前端的
 * key 撞上、resolveLogo 也会挑得莫名其妙。
 */
export function listLogos() {
  const mine = scanDir(TRANSFER_LOGO_DIR);
  const taken = new Set(mine.map((l) => l.file));
  return [...listBuiltinLogos().filter((l) => !taken.has(l.file)), ...mine];
}

/**
 * 文件名 → 绝对路径。找不到返回 null。
 *
 * 安全边界和 wallpaper.js:resolveWallpaper 一样：`path.basename` 挡路径穿越
 * （`../../data.config.json` 到这儿只剩 `data.config.json`）、点开头的挡掉、
 * 后缀必须在白名单里 —— 所以 config.json、data.config.json 都读不到。
 */
export function resolveLogo(file) {
  const base = path.basename(String(file ?? "").trim());
  if (!base || base.startsWith(".")) return null;
  if (!LOGO_EXTS.includes(path.extname(base).toLowerCase())) return null;
  for (const dir of [TRANSFER_LOGO_DIR, BUILTIN_TRANSFER_LOGO_DIR]) {
    const full = path.join(dir, base);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

/** `#fff` / `#ffffff` → 规整成六位；不合法返回 null。 */
export function normalizeColor(raw) {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(t);
  if (!m) return null;
  const hex = m[1].toLowerCase();
  return `#${hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex}`;
}

/** 背景色默认纯白 —— 绝大多数品牌 logo 都是按白底设计的。 */
export const DEFAULT_BG = "#ffffff";

/**
 * 把一个 logo 文件渲染成卡片能收的 JPEG 字节。
 *
 * 失败**一律返回 null 并只记一条 warn**，绝不抛错：这是卡片上的装饰，
 * 一张图读不出来不该让整笔转账发不出去（口径和 linkmeta.js 一致）。
 *
 * @param {string} file 文件名（不是路径 —— 走 resolveLogo 那道白名单）
 * @param {{bg?: string, scope?: string}} [opts]
 * @returns {Promise<Buffer|null>} JPEG 字节；读不出来 / 太大就是 null
 */
export async function renderLogo(file, opts = {}) {
  const scope = opts.scope ?? SCOPE;
  const full = resolveLogo(file);
  if (!full) {
    if (String(file ?? "").trim()) logWarn(scope, `找不到这个转账 logo：${file}（这张卡片不带图）`);
    return null;
  }

  const bg = normalizeColor(opts.bg) ?? DEFAULT_BG;

  let mtime = 0;
  try {
    mtime = fs.statSync(full).mtimeMs;
  } catch {
    return null; // 刚被删掉
  }
  const key = `${full}|${mtime}|${bg}`;
  const hit = cache.get(key);
  if (hit) return hit;

  try {
    /*
     * 动态 import：这个包带原生模块（skia），而绝大多数用户压根不发转账卡片。
     * 顶层 import 会让「装不上 @napi-rs/canvas 的机器」整个服务起不来，
     * 放在这儿最坏的后果只是这张卡片没图。同一个道理写在 imessage.js 的
     * `await import("spectrum-ts")` 那儿。
     */
    const { createCanvas, loadImage } = await import("@napi-rs/canvas");
    const img = await loadImage(await fs.promises.readFile(full));
    if (!(img.width > 0) || !(img.height > 0)) {
      logWarn(scope, `这个 logo 读出来是 0×0：${file}（这张卡片不带图）`);
      return null;
    }

    const canvas = createCanvas(CANVAS_W, CANVAS_H);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    /*
     * 等比缩放到留白框里，居中。
     *
     * 两个方向都要收（`Math.min`）—— 只按宽度算的话，一张竖图会超出上下边界
     * 被裁掉头尾。**不放大**：小图拉大只会糊，宁可它在中间小小一块。
     */
    const boxW = CANVAS_W - PADDING * 2;
    const boxH = CANVAS_H - PADDING * 2;
    const k = Math.min(boxW / img.width, boxH / img.height, 1);
    const w = Math.max(1, Math.round(img.width * k));
    const h = Math.max(1, Math.round(img.height * k));
    ctx.drawImage(img, Math.round((CANVAS_W - w) / 2), Math.round((CANVAS_H - h) / 2), w, h);

    const buf = await canvas.encode("jpeg", JPEG_QUALITY);
    if (!buf?.length) {
      logWarn(scope, `这个 logo 编出来是空的：${file}（这张卡片不带图）`);
      return null;
    }
    if (buf.length > MAX_BYTES) {
      logWarn(
        scope,
        `这个 logo 编出来 ${Math.round(buf.length / 1024)}KB，超过 ${MAX_BYTES / 1024}KB（这张卡片不带图）`
      );
      return null;
    }

    const out = Buffer.from(buf);
    cache.set(key, out);
    logDebug(scope, `转账 logo 渲染好了：${file} → ${CANVAS_W}×${CANVAS_H}、${Math.round(out.length / 1024)}KB`);
    return out;
  } catch (e) {
    logWarn(scope, `这个 logo 渲染不了：${file}（这张卡片不带图）`, e);
    return null;
  }
}

/**
 * 上传上来的文件名 → 能安全落盘的文件名。
 *
 * 和 wallpaper.js:safeWallpaperName 同一条规矩，包括「内置的名字也算重名」——
 * 传一个同名文件上来应该变成 `Chase-2.svg`，而不是把内置那个藏起来
 * （内置的删不掉，一旦重名 listLogos 会把它滤掉，看着像内置 logo 没了）。
 */
export function safeLogoName(raw, mimeType) {
  const builtin = new Set(listBuiltinLogos().map((l) => l.file));
  const base = path.basename(String(raw ?? "").trim()) || "logo";
  const ext = extFor(base, mimeType);
  const stem = base.slice(0, base.length - path.extname(base).length) || "logo";
  const taken = (name) => builtin.has(name) || fs.existsSync(path.join(TRANSFER_LOGO_DIR, name));

  let name = `${stem}${ext}`;
  for (let i = 2; taken(name); i += 1) name = `${stem}-${i}${ext}`;
  return name;
}

/**
 * 后缀。文件名上带合法后缀就用它，否则按 MIME 猜，都认不出来当 `.png`。
 *
 * 不复用 media.js:safeUploadName 是因为那边的白名单里没有 `.svg`（而 svg 正是
 * 这里最主要的格式），多一个参数去改公共函数不值得。
 */
function extFor(base, mimeType) {
  const own = path.extname(base).toLowerCase();
  if (LOGO_EXTS.includes(own)) return own;
  const mime = String(mimeType ?? "").toLowerCase();
  if (mime.includes("svg")) return ".svg";
  if (mime.includes("jpeg") || mime.includes("jpg")) return ".jpg";
  if (mime.includes("webp")) return ".webp";
  return ".png";
}

/**
 * 后缀 → Content-Type，给「前端预览原图」那条路由用。
 *
 * 不用 media.js:mimeForExt 是因为那张表认不出 `.svg`（它是参考图的白名单，
 * 那边确实不该收 svg）—— 认不出就按 png 发，浏览器会把一份 XML 当 PNG 解，
 * 预览直接是个碎图。
 */
export function logoMime(file) {
  switch (path.extname(String(file ?? "")).toLowerCase()) {
    case ".svg":
      return "image/svg+xml";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return "image/png";
  }
}

/** 写一个 logo 到 data/transfer-logos/，返回最终落盘的文件名。 */
export function saveLogo(rawName, base64, mimeType) {
  ensureLayout();
  const name = safeLogoName(rawName, mimeType);
  const buf = Buffer.from(String(base64 ?? "").replace(/^data:[^,]+,/, ""), "base64");
  if (!buf.length) throw new Error("这个文件解出来是空的");
  fs.writeFileSync(path.join(TRANSFER_LOGO_DIR, name), buf);
  return name;
}

/** 这个名字是内置 logo 吗。删除那条路要用它挡一下。 */
export function isBuiltinLogo(file) {
  const base = path.basename(String(file ?? "").trim());
  if (!base) return false;
  return listBuiltinLogos().some((l) => l.file === base);
}

/**
 * 删一个用户自己放的 logo。
 *
 * 内置的**抛错**而不是返回 false —— 它确实在，只是不给删，和「找不到」是
 * 两回事，得让前端把话说清楚（照 wallpaper.js:removeWallpaper 的口径）。
 *
 * @returns {boolean} 删掉了没有（false = 找不到）
 */
export function removeLogo(file) {
  const base = path.basename(String(file ?? "").trim());
  if (!base || base.startsWith(".")) return false;
  if (!LOGO_EXTS.includes(path.extname(base).toLowerCase())) return false;
  if (isBuiltinLogo(base) && !fs.existsSync(path.join(TRANSFER_LOGO_DIR, base))) {
    throw new Error("这是随程序自带的 logo，删不掉");
  }
  const full = path.join(TRANSFER_LOGO_DIR, base);
  if (!fs.existsSync(full)) return false;
  fs.unlinkSync(full);
  return true;
}
