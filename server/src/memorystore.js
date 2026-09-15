/**
 * 记忆库的文件层：只管「东西存在哪、怎么读怎么写」，不懂 LLM 也不懂检索。
 *
 * 三样东西按角色隔离（用户的要求：每个角色的记忆都不一样，活人感最重要），
 * 落在 `data/memories/` 下面，布局见 datadir.js 的注释。
 *
 * 这个文件里最要紧的是**失败语义**，用户逐字钉死过两条：
 *
 *   1「记忆库的内容如果生成失败的话，绝对不会删掉记录文件，
 *      而是继续加入新的聊天记录内容」
 *   2「每个待总结的文件，都必须在生成之前备份一次，
 *      等到下一次生成新的总结时，再去覆盖旧的待总结」
 *
 * 落地成一条规矩：**清空只发生在总结成功之后**，而且清空之前先备份。
 * 所以这里没有「开始生成前先清掉缓存」这种写法 —— `commitPending` /
 * `commitDiaryLog` 都是拿到结果才调的，调不到就一个字节都不动。
 * 失败时调用方只该调 `markFail`，它只改计数，不碰正文。
 *
 * **三份待总结是同一种东西**：日记流水、待总结记忆、待总结备忘录，全都是
 * `2026-09-08 星期二 09:45:18 | [小明] 在吗` 这样一行一条的 txt（用户的要求：
 * 「待总结的记忆和备忘录都用 diary_log.txt 的这个记录形式」），拼行的
 * `diaryLogLine` 也只有一个。总结时把整份 txt 原样发过去，不再有渲染那一步。
 *
 * 写盘一律 `.tmp` + rename：中途断电最多丢这一次的内容，不会留下半个文件
 * 把上一次的好数据也毁掉。追加流水是例外（appendFileSync 本来就不重写全文）。
 */

import fs from "node:fs";
import path from "node:path";

import {
  DIARY_DIR,
  MEMO_DIR,
  MEMORY_ITEMS_DIR,
  PENDING_MEMO_DIR,
  PENDING_MEMORY_DIR,
} from "./datadir.js";
import { stripEnvPrefix } from "./env.js";
import { logInfo, logWarn } from "./logs.js";

/** 文件名白名单。key 是从角色名派生的，而角色名是用户随便填的。 */
const SAFE_KEY = /^[A-Za-z0-9_-]+$/;

/** 成品日记的文件名：`2026-09-09.md`，同一天再生成就是 `2026-09-09-2.md`。 */
const DIARY_FILE = /^(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.md$/;

/**
 * 角色 → 记忆库的 key，也就是文件名。
 *
 * 手法和 `sessions.js:sessionIdFor` 的头部一样：中文名在白名单这步会被剔干净，
 * 所以要有 `role.id` 兜底；兜底时保留 `-` 和 `_`，否则 `r-1` 和 `r1`
 * 会算出同一个 key，两个角色的记忆串到一起。
 *
 * 和会话 ID 的区别是**这里只有角色名，没有号码那一截** —— 记忆库天生按角色
 * 隔离，用不着再分号码，所以「会话 ID 不带对方号码」那次改动跟这儿无关。
 *
 * **角色改名 = 换一份新的记忆库**（和会话存档一个道理）。这是有意的：
 * 记忆是跟着「这个人」走的，改名意味着换了个人。界面上要写明这一点。
 */
export function memoryKeyFor(role) {
  const name = String(role?.name ?? "").replace(/[^A-Za-z0-9]/g, "");
  const key = name || `role-${String(role?.id ?? "").replace(/[^A-Za-z0-9_-]/g, "") || "x"}`;
  // 再兜一层：万一上面的规则漏了什么，也不能让它变成路径
  return SAFE_KEY.test(key) ? key : `mem-${Buffer.from(key).toString("hex").slice(0, 24)}`;
}

/** key 合法才给路径，否则返回 null —— 挡 `../` 那一类。 */
function safe(dir, key, ext) {
  if (!SAFE_KEY.test(String(key ?? ""))) return null;
  return path.join(dir, `${key}${ext}`);
}

const itemsFile = (key) => safe(MEMORY_ITEMS_DIR, key, ".json");
const memoFile = (key) => safe(MEMO_DIR, key, ".md");

/**
 * 记忆条目那个文件的路径。和 `pendingLogPath` / `diaryLogPath` 一样导出去，
 * 是给「要整份动这个文件」的工具用的（scripts/import-memories.mjs 备份用）。
 * 平时读写走 readMemories / writeMemories，别自己拿路径去写。
 */
export function memoryItemsPath(key) {
  return itemsFile(key);
}

/** 待总结所在的文件夹（记忆一个、备忘录一个）。 */
const pendingDir = (kind) => (kind === "memo" ? PENDING_MEMO_DIR : PENDING_MEMORY_DIR);

/**
 * 待总结的流水文件。**和 diary_log.txt 是同一种东西**（用户的要求：
 * 「待总结的记忆和备忘录都用 diary_log.txt 的这个记录形式」）。
 */
export function pendingLogPath(kind, key) {
  return safe(pendingDir(kind), key, ".txt");
}

/** 旁边那个小状态文件：失败计数、退避位置。正文一个字都不放在里面。 */
const pendingStateFile = (kind, key) => safe(pendingDir(kind), key, ".state.json");

/** 改格式之前的老缓存 `<角色>.json`，只有 migratePendingJson 会碰它。 */
const legacyPendingFile = (kind, key) => safe(pendingDir(kind), key, ".json");

/** 某个角色的日记文件夹（成品 + 流水都在里面）。 */
export function diaryDirFor(key) {
  return safe(DIARY_DIR, key, "");
}

/** 日记流水：每轮往里追加一行，生成成功后才清空。 */
export function diaryLogPath(key) {
  const dir = diaryDirFor(key);
  return dir ? path.join(dir, "diary_log.txt") : null;
}

/* ================= 底层读写 ================= */

/** 备份文件名：后缀前面插一个 `.bak`（`a.txt` → `a.bak.txt`）。 */
export function backupPathFor(file) {
  const ext = path.extname(file);
  return ext ? `${file.slice(0, -ext.length)}.bak${ext}` : `${file}.bak`;
}

/** 写一个文本文件：先 .tmp 再 rename，中途出事不会毁掉原文件。 */
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, "utf-8");
  fs.renameSync(tmp, file);
}

function readText(file, fallback = "") {
  if (!file || !fs.existsSync(file)) return fallback;
  try {
    return fs.readFileSync(file, "utf-8");
  } catch (e) {
    logWarn("记忆库", `${path.basename(file)} 读不出来`, e);
    return fallback;
  }
}

function readJsonFile(file, fallback) {
  const text = readText(file, "");
  if (!text.trim()) return fallback;
  try {
    return JSON.parse(text);
  } catch (e) {
    // 不删也不改名：记忆是用户攒出来的，读不出来也得留着让人自己看
    logWarn("记忆库", `${path.basename(file)} 不是合法 JSON，这次当空的用`, e);
    return fallback;
  }
}

/**
 * 备份，然后清空 —— 用户硬要求 2 的落点。
 *
 * 顺序不能反：`copyFile` 成功之后**才**动原文件。备份都没留成就清空，
 * 等于把待总结的内容直接扔了。备份失败就整个不做，返回 false，
 * 调用方当这次没清（下次连着一起总结，最多重复一点内容，不会丢）。
 *
 * @param {string} file 要清空的文件
 * @param {string} empty 清空后写什么（JSON 缓存写 `{}`，纯文本写 ""）
 */
function backupThenClear(file, empty = "") {
  if (!file || !fs.existsSync(file)) return true; // 本来就没有，不用备份
  try {
    fs.copyFileSync(file, backupPathFor(file));
  } catch (e) {
    logWarn("记忆库", `${path.basename(file)} 备份失败，这次就不清空了`, e);
    return false;
  }
  try {
    writeAtomic(file, empty);
    return true;
  } catch (e) {
    logWarn("记忆库", `${path.basename(file)} 清空失败，内容还在，下次一起总结`, e);
    return false;
  }
}

/* ================= 一、记忆 ================= */

/**
 * 一条记忆长这样：
 *   { id, date: "2026-09-09", timestamp: 毫秒, content, keywords: [], embedding: [] | null }
 * `embedding` 可以是 null —— 向量模型没配 / 打不通时照样存正文，
 * 只是这条暂时进不了语义检索（近 N 天那一路还能拿到它）。
 */
export function readMemories(key) {
  const list = readJsonFile(itemsFile(key), []);
  return Array.isArray(list) ? list.filter((m) => m && typeof m === "object") : [];
}

export function writeMemories(key, list) {
  const file = itemsFile(key);
  if (!file) return false;
  writeAtomic(file, JSON.stringify(Array.isArray(list) ? list : [], null, 2));
  return true;
}

let seq = 0;
function newId(prefix) {
  seq = (seq + 1) % 100000;
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}`;
}

/** 追加一条记忆，返回落盘后的那条（带上生成的 id / 时间）。 */
export function appendMemory(key, record) {
  const now = record?.timestamp ? new Date(record.timestamp) : new Date();
  const item = {
    id: record?.id || newId("m"),
    date: record?.date || localDate(now),
    timestamp: now.getTime(),
    content: String(record?.content ?? "").trim(),
    keywords: Array.isArray(record?.keywords) ? record.keywords.map(String) : [],
    embedding: Array.isArray(record?.embedding) ? record.embedding : null,
  };
  if (!item.content) return null;
  const list = readMemories(key);
  list.push(item);
  writeMemories(key, list);
  return item;
}

export function updateMemory(key, id, patch) {
  const list = readMemories(key);
  const i = list.findIndex((m) => m.id === id);
  if (i < 0) return null;
  // 正文改了，旧向量就对不上了 —— 置空，等下次检索前重算
  const content = patch?.content === undefined ? list[i].content : String(patch.content);
  const changed = content !== list[i].content;
  list[i] = {
    ...list[i],
    ...patch,
    id: list[i].id,
    content,
    embedding: changed ? null : (patch?.embedding ?? list[i].embedding ?? null),
  };
  writeMemories(key, list);
  return list[i];
}

export function removeMemory(key, id) {
  const list = readMemories(key);
  const next = list.filter((m) => m.id !== id);
  if (next.length === list.length) return false;
  writeMemories(key, next);
  return true;
}

/* ================= 二、备忘录 ================= */

/** 备忘录只有一份，每次生成整份覆盖（生成前会先备份）。 */
export function readMemo(key) {
  return readText(memoFile(key), "");
}

export function writeMemo(key, text) {
  const file = memoFile(key);
  if (!file) return false;
  // 覆盖之前先留一份：模型偶尔会把清单写残，用户能从 .bak 里捞回来
  if (fs.existsSync(file)) {
    try {
      fs.copyFileSync(file, backupPathFor(file));
    } catch (e) {
      logWarn("记忆库", "备忘录备份失败，还是照常覆盖", e);
    }
  }
  writeAtomic(file, String(text ?? ""));
  return true;
}

/* ================= 三、日记 ================= */

/** 本地日期 `YYYY-MM-DD`（不是 UTC —— 用户看的是自己的日历）。 */
export function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ---------------- 流水的那一行（三份文件共用） ---------------- */

/**
 * 流水一行：`2026-09-08 星期二 09:45:18 | [小明] 在吗`（用户钉死的格式）。
 *
 * **三份待总结共用这一个函数**：日记流水、待总结记忆、待总结备忘录。用户的原话
 * 是「待总结的记忆和备忘录都用 diary_log.txt 的这个记录形式」，格式各写各的
 * 只会让人以后改漏一处。
 *
 * 放在 memorystore 而不是 memory.js，是因为改成 txt 之后**存的时候**就要拼行了
 * （以前是存 `{at,user,assistant}`、渲染时才拼）。memory.js 那边 import 了
 * llm/prompt 一大串，反过来引就成环了。memory.js 仍然 re-export 它，
 * 老的引用（memoryhooks、测试）照常能用。
 *
 * 星期用**中文**：用户的示例是「星期二」，不是 `Tuesday`。这一行是要喂给模型
 * 读的，通篇中文里夹一个英文星期也没道理。
 *
 * 行首那个时间是**系统时间**，所以正文里再剥一次环境前缀 —— 不剥的话同一个
 * 时刻会用两种格式写两遍（`22:12:07 | [小明] [{{user}}发送当地时间 CST : … ]我刚睡醒`），
 * 而且流水按规范是**不带天气**的，前缀里却可能夹着天气段。
 *
 * 正文里的消息格式标记（`$` 气泡分隔、`[表情:…]`、`[audio_message:…]`、
 * `<quoted_message>`、`【转账】`…）**一个都不动**：用户要求「消息格式与功能的
 * 每条都要记录」，模型总结时也要能看出这一轮到底发生了什么。只把换行压成空格，
 * 因为流水是一条一行的。
 */
const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
export function diaryLogLine(who, text, now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const time =
    `${localDate(now)} ${WEEKDAYS[now.getDay()]} ` +
    `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
  return `${time} | [${who}] ${stripEnvPrefix(text).replace(/\r?\n/g, " ").trim()}`;
}

/**
 * 往一个流水文件里追加一行。
 * 用 append 而不是「读全文再写回」：聊上几个月这个文件不小，每轮重写太亏。
 */
function appendLine(file, line) {
  if (!file) return false;
  const text = String(line ?? "").trim();
  if (!text) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${text}\r\n`, "utf-8");
  return true;
}

/**
 * 整份覆盖一个流水文件：换行统一成 CRLF、去掉尾部空行再补一个。
 * 和 `appendLine` 追加出来的形状保持一致，否则手改过一次之后再自动追加
 * 会多出或少掉一个空行。
 */
function writeLines(file, text) {
  if (!file) return false;
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trimEnd());
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  writeAtomic(file, lines.length ? `${lines.join("\r\n")}\r\n` : "");
  return true;
}

/** 往日记流水里追加一行。 */
export function appendDiaryLine(key, line) {
  return appendLine(diaryLogPath(key), line);
}

export function readDiaryLog(key) {
  return readText(diaryLogPath(key), "");
}

/**
 * 整份覆盖流水 —— **只有用户在界面上手改才走这条路**。
 *
 * 程序自己永远不用它：自动那边只有 `appendDiaryLine`（追加）和
 * `commitDiaryLog`（成功之后备份 + 清空）两条路。
 *
 * **不动 `.bak`**：那一份是留给「上次生成时用的那批」的（用户钉死的规矩 2），
 * 手改顺手覆盖掉的话，生成失败之后就再也翻不出原始流水了。
 *
 * 换行统一成 CRLF、去掉尾部空行再补一个 —— 和 `appendDiaryLine` 追加出来的
 * 形状保持一致，否则手改过一次之后再自动追加会多出或少掉一个空行。
 */
export function writeDiaryLog(key, text) {
  return writeLines(diaryLogPath(key), text);
}

/**
 * 日记生成成功之后：把流水备份一份，然后清空。
 * **只有成功才调**。失败时压根不该走到这里 —— 用户的原话是
 * 「无论什么错误，只要没有成功生成日记的情况下，都不会删除 {{char}}_diary_log.txt」。
 */
export function commitDiaryLog(key) {
  const file = diaryLogPath(key);
  return file ? backupThenClear(file, "") : false;
}

/**
 * 存一篇成品日记，返回它的文件名。
 *
 * 同一天再生成一篇不覆盖，改叫 `2026-09-09-2.md`：
 * 「生成后的日记默认永远都不会清空」，那重新生成一次也不该把上一篇顶掉。
 */
export function writeDiary(key, date, text) {
  const dir = diaryDirFor(key);
  if (!dir) return null;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(date ?? "")) ? date : localDate();
  fs.mkdirSync(dir, { recursive: true });

  let name = `${day}.md`;
  let n = 1;
  while (fs.existsSync(path.join(dir, name))) {
    n += 1;
    name = `${day}-${n}.md`;
  }
  writeAtomic(path.join(dir, name), String(text ?? ""));
  return name;
}

/** 某个角色的全部成品日记，按日期倒序（新的在前）。不含正文。 */
export function listDiaries(key) {
  const dir = diaryDirFor(key);
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const m = DIARY_FILE.exec(name);
    if (!m) continue;
    let chars = 0;
    try {
      chars = fs.statSync(path.join(dir, name)).size;
    } catch {
      /* 读不到大小不影响列表 */
    }
    out.push({ file: name, date: m[1], seq: Number(m[2] ?? 1), bytes: chars });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || b.seq - a.seq);
}

export function readDiary(key, file) {
  const dir = diaryDirFor(key);
  if (!dir || !DIARY_FILE.test(String(file ?? ""))) return "";
  return readText(path.join(dir, file), "");
}

/**
 * 手改一篇成品日记。
 *
 * 文件必须**已经存在** —— 这是「改」不是「新建一篇」。新建走 `writeDiary`
 * （它会算 `-2` 后缀），从这儿凭空造一个文件名出来会绕开那套编号。
 */
export function writeDiaryFile(key, file, text) {
  const dir = diaryDirFor(key);
  if (!dir || !DIARY_FILE.test(String(file ?? ""))) return false;
  const full = path.join(dir, file);
  if (!fs.existsSync(full)) return false;
  writeAtomic(full, String(text ?? ""));
  return true;
}

/**
 * 按**指定文件名**放一篇成品日记进去，没有就新建。只有整包导入用得上它。
 *
 * 三个写日记的函数各管各的：程序自己生成走 `writeDiary`（它会算 `-2` 后缀，
 * 绝不覆盖）；用户手改走 `writeDiaryFile`（只认已经存在的文件）；
 * 导入要的是第三种 —— 把包里那篇按**原来的文件名**原样放回去，同名就覆盖。
 * 覆盖是有意的：同一天同一篇重导一次应该还是一篇，不该变成两篇。
 */
export function putDiary(key, file, text) {
  const dir = diaryDirFor(key);
  if (!dir || !DIARY_FILE.test(String(file ?? ""))) return false;
  fs.mkdirSync(dir, { recursive: true });
  writeAtomic(path.join(dir, file), String(text ?? ""));
  return true;
}

/** 删一篇成品日记。**只有用户在界面上点删除才会走到这**，程序自己永远不删。 */
export function removeDiary(key, file) {
  const dir = diaryDirFor(key);
  if (!dir || !DIARY_FILE.test(String(file ?? ""))) return false;
  const full = path.join(dir, file);
  if (!fs.existsSync(full)) return false;
  fs.unlinkSync(full);
  return true;
}

/**
 * 近 N 天的日记，按日期正序（老的在前，读起来是时间顺序）。
 *
 * 「近 N 天」= 今天往前数 N 天、**含今天**，所以 N=1 拿到的是昨天和今天。
 * 这么算是有意的：日记通常是当天夜里生成的，只算「今天」的话，
 * 白天聊天时那一段永远是空的。
 */
export function readRecentDiaries(key, days, now = new Date()) {
  const n = Math.max(0, Number(days) || 0);
  if (!n) return [];
  const from = new Date(now.getTime());
  from.setDate(from.getDate() - n);
  const floor = localDate(from);
  return listDiaries(key)
    .filter((d) => d.date >= floor)
    .sort((a, b) => a.date.localeCompare(b.date) || a.seq - b.seq)
    .map((d) => ({ ...d, text: readDiary(key, d.file) }))
    .filter((d) => d.text.trim());
}

/* ================= 定时日记的时间戳 ================= */

/**
 * 每个角色一个小状态文件，只放「最后一次写成日记是什么时候」。
 *
 * 定时日记靠它算下一次该什么时候写。**必须落盘**：存在内存里的话，重启一次
 * 就等于把间隔重新从零数起，用户设「每 12 小时一篇」而服务每天重启几次，
 * 那就永远写不出来。
 *
 * 不并进备忘录或记忆的文件里 —— 那两个是用户会在界面上直接编辑的内容，
 * 混一个程序自己用的时间戳进去，用户删一下就把定时搞坏了。
 */
function stateFile(key) {
  const dir = diaryDirFor(key);
  return dir ? path.join(dir, "state.json") : null;
}

export function readDiaryState(key) {
  const raw = readJsonFile(stateFile(key), null);
  return raw && typeof raw === "object" ? raw : { lastDiaryAt: "" };
}

/** 合并写：只覆盖传进来的那几个字段。 */
export function writeDiaryState(key, patch) {
  const file = stateFile(key);
  if (!file) return false;
  const next = { ...readDiaryState(key), ...patch };
  writeAtomic(file, JSON.stringify(next, null, 2));
  return next;
}

/* ================= 待总结缓存（记忆 / 备忘录） ================= */

/*
 * 待总结的**正文就是一个 txt 流水**，和 diary_log.txt 一模一样的形状：
 *
 *   2026-09-08 星期二 09:45:18 | [小明] 在吗
 *   2026-09-08 星期二 09:45:18 | [阿瑞] 在啊$咋了$[疑问]
 *
 * 用户的要求：「待总结的记忆和备忘录都用 diary_log.txt 的这个记录形式吧，
 * 不弄 json 文件夹了，就相当于到时候把 txt 的 log 文件也直接发过去总结」。
 * 所以总结时不再有「渲染」这一步 —— 读出来什么样就发过去什么样。
 *
 * 换来的问题是**轮数从哪儿数**。以前 `turns.length` 既是内容也是计数，现在
 * 内容是纯文本，计数只能另放一个地方：`<角色>.state.json`，和日记那边的
 * `日记/<key>/state.json` 是同一个套路 —— 程序自己用的计数，不混进用户会手改
 * 的正文里。这个小文件丢了最多让一次总结早触发或晚触发一轮，正文不受影响。
 *
 *   rounds    到目前为止记进去多少轮（一轮 = recordTurn 的一次调用）
 *   lastTry   上次尝试总结时 rounds 是多少 —— 失败之后靠它退避
 *   fails     连续失败次数，到了 maxFails 就发消息告诉用户
 *
 * 流水**不做长度截断**：用户要的是「失败就继续往里加」，截断等于悄悄丢内容。
 * 太长的那部分在生成时按字符预算取尾巴，存的一直是全的。
 */
function emptyPending() {
  return { text: "", lines: 0, rounds: 0, lastTry: 0, fails: 0, lastError: "", updatedAt: "" };
}

/** 只读小状态文件，不读正文。轮数判断和失败计数走它。 */
function readPendingState(kind, key) {
  const raw = readJsonFile(pendingStateFile(kind, key), null);
  const base = { rounds: 0, lastTry: 0, fails: 0, lastError: "", updatedAt: "" };
  return raw && typeof raw === "object" ? { ...base, ...raw } : base;
}

function writePendingState(kind, key, state) {
  const file = pendingStateFile(kind, key);
  if (!file) return false;
  writeAtomic(file, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2));
  return true;
}

/** 数一份流水有多少行（空行不算）。 */
function countLines(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter((l) => l.trim()).length;
}

/**
 * 一份待总结：正文 + 状态。
 *
 * `text` 就是要原样发给模型的那段（`rounds` 是给触发条件用的计数）。
 * 老的 `.json` 缓存还在的话先就地迁一次（见 migratePendingJson）。
 */
export function readPending(kind, key) {
  migratePendingJson(kind, key);
  const text = readText(pendingLogPath(kind, key), "");
  const state = readPendingState(kind, key);
  return { ...emptyPending(), ...state, text, lines: countLines(text) };
}

/**
 * 追加一轮：对方一行、角色一行，格式和日记流水一致。
 *
 * 返回追加之后的状态，调用方拿 `rounds` 判够不够触发。
 * 两边都空的一轮不记 —— 那样只会让轮数虚高。
 */
export function appendPending(kind, key, turn) {
  const user = String(turn?.user ?? "").trim();
  const assistant = String(turn?.assistant ?? "").trim();
  if (!user && !assistant) return readPending(kind, key);

  const at = turn?.at ? new Date(turn.at) : new Date();
  const now = Number.isNaN(at.getTime()) ? new Date() : at;
  const file = pendingLogPath(kind, key);
  if (!file) return readPending(kind, key);

  // 发送人用真名，和日记流水一致（模型要能看出谁是谁）
  if (user) appendLine(file, diaryLogLine(turn?.userName || "对方", user, now));
  if (assistant) appendLine(file, diaryLogLine(turn?.charName || "角色", assistant, now));

  const state = readPendingState(kind, key);
  state.rounds = (Number(state.rounds) || 0) + 1;
  writePendingState(kind, key, state);
  return readPending(kind, key);
}

/**
 * 该不该触发这一类的总结。
 *
 * 攒够 `rounds` 轮就触发；失败之后 `lastTry` 会推到当前轮数，
 * 所以下一次要**再攒满一轮** rounds 才会重试 —— 不然一直失败的话
 * 每来一条消息都会去打一次接口。
 *
 * 流水是空的就一定不触发：状态文件和正文可能对不上（用户把 txt 清空了、
 * 或者状态文件是从老 JSON 迁过来的），以正文为准 —— 没内容还去打接口
 * 只会白花一次钱换一句「没有待总结的对话」。
 */
export function shouldSummarize(pending, rounds) {
  if (!String(pending?.text ?? "").trim()) return false;
  const n = Math.max(1, Number(rounds) || 1);
  return (Number(pending.rounds) || 0) - (Number(pending.lastTry) || 0) >= n;
}

/**
 * 手改待总结的流水 —— **只有用户在界面上手改才走这条路**。
 *
 * 只覆盖正文，`fails` / `lastTry` / `lastError` 全部保留：那三个是程序的进度
 * 和失败状态，用户改的是「要拿去总结的原文」，两件事不该互相影响。尤其
 * `lastTry` —— 手改一下就把它清零的话，一个一直失败的角色会立刻又去打一次接口。
 *
 * **不动 `.bak`**：那一份留给「上次生成时用的那批」（用户钉死的规矩 2）。
 *
 * 手改之后按**行数**重算轮数（一轮通常两行，向上取整），并把 `lastTry` 夹进
 * 区间：删掉大半之后 `lastTry` 可能比现在的轮数还大，那样 `shouldSummarize`
 * 会算出负数、永远不再触发。
 */
export function writePendingText(kind, key, text) {
  const file = pendingLogPath(kind, key);
  if (!file) return readPending(kind, key);
  writeLines(file, text);

  const state = readPendingState(kind, key);
  const rounds = Math.ceil(countLines(readText(file, "")) / 2);
  state.rounds = rounds;
  state.lastTry = Math.min(Number(state.lastTry) || 0, rounds);
  writePendingState(kind, key, state);
  return readPending(kind, key);
}

/**
 * 总结失败：只动计数和原因，**正文一个字节不动**。
 *
 * `pushTry` 决定要不要把 `lastTry` 推到当前轮数，也就是要不要占用
 * 「自动总结」的退避额度：
 *
 *  - 自动那条路（runSummaries）**要推**：不推的话每来一条消息都会去打一次
 *    接口，配错了就是每条消息一次收费请求。
 *  - 用户手点的那次（界面按钮、`/记忆`）**不推**。手点失败不该让自动那条路
 *    跟着哑掉 —— 之前就是这么丢的：手点了一次记忆、失败，`lastTry` 被推到
 *    当前轮数，等自动总结跑起来时 `shouldSummarize` 算出 0 >= 3 不成立，
 *    记忆整个被跳过，用户只看到备忘录动了、记忆「没总结」。
 *    和日记那边一个道理（见 memoryhooks.js:markDiaryError 的 pushTime）。
 */
export function markFail(kind, key, message, { pushTry = true } = {}) {
  const state = readPendingState(kind, key);
  state.fails = (Number(state.fails) || 0) + 1;
  if (pushTry) state.lastTry = Number(state.rounds) || 0;
  // 界面上要显示这句，留够长度 —— 中转站的 400 常把真正的原因写在很后面
  state.lastError = String(message ?? "").slice(0, 2000);
  writePendingState(kind, key, state);
  return readPending(kind, key);
}

/**
 * 连续失败计数归零。**正文和 lastTry 都不碰。**
 *
 * 用在「已经告诉过用户失败原因」之后（memoryhooks.js）：不归零的话之后每次
 * 失败都会再发一条同样的消息，变成刷屏。归零之后要再连着失败 maxFails 次
 * 才会再提醒一次。
 */
export function resetFails(kind, key) {
  const state = readPendingState(kind, key);
  if (!state.fails) return readPending(kind, key);
  state.fails = 0;
  writePendingState(kind, key, state);
  return readPending(kind, key);
}

/**
 * 总结成功：先备份流水，再清空。备份失败就不清 —— 见 backupThenClear。
 * 备份文件（`<角色>.bak.txt`）里躺着的就是「上一次总结用的那批对话」。
 *
 * 轮数和失败计数一起归零：这一批已经总结掉了，下一次要从头攒。
 * **状态清不掉不算失败** —— 正文已经备份并清空了，状态最多让下一次早触发
 * 一轮，不值得为它把「总结成功」判成失败。
 */
export function commitPending(kind, key) {
  const file = pendingLogPath(kind, key);
  if (!file) return false;
  if (!backupThenClear(file, "")) return false;
  writePendingState(kind, key, { rounds: 0, lastTry: 0, fails: 0, lastError: "" });
  return true;
}

/**
 * 老的 `待总结/<类>/<角色>.json` 就地迁成 txt。
 *
 * 改格式之前存的是 `{turns:[{at,user,assistant}]}`，直接不认的话用户攒着的那批
 * 对话就凭空消失了 —— 而「绝不丢待总结的内容」是这个项目最硬的一条规矩。
 *
 * 迁法：把每一轮按 `diaryLogLine` 拼成两行**追加**到 txt 后面（追加不是覆盖：
 * 万一新老并存，新的那批在前面，一行都不能顶掉），失败计数原样搬进 state，
 * 然后把老文件改名成 `.migrated.json` 留着 —— 不删，用户想核对还能翻。
 *
 * `.bak.json` 不动：那是上一次生成时的备份，本来就是历史档案。
 */
function migratePendingJson(kind, key) {
  const legacy = legacyPendingFile(kind, key);
  if (!legacy || !fs.existsSync(legacy)) return;

  const raw = readJsonFile(legacy, null);
  const turns = Array.isArray(raw?.turns) ? raw.turns : [];
  const file = pendingLogPath(kind, key);
  if (!file) return;

  try {
    for (const t of turns) {
      const at = t?.at ? new Date(t.at) : null;
      const when = at && !Number.isNaN(at.getTime()) ? at : new Date();
      const user = String(t?.user ?? "").trim();
      const assistant = String(t?.assistant ?? "").trim();
      // 老记录里没存发送人的名字，只能用通用称呼 —— 内容一个字都不少
      if (user) appendLine(file, diaryLogLine("对方", user, when));
      if (assistant) appendLine(file, diaryLogLine("角色", assistant, when));
    }
    const state = readPendingState(kind, key);
    writePendingState(kind, key, {
      ...state,
      rounds: (Number(state.rounds) || 0) + turns.length,
      lastTry: Number(raw?.lastTry) || 0,
      fails: Number(raw?.fails) || 0,
      lastError: String(raw?.lastError ?? ""),
    });
    fs.renameSync(legacy, `${legacy.slice(0, -".json".length)}.migrated.json`);
    logInfo("记忆库", `${key} 的待总结${kind === "memo" ? "备忘录" : "记忆"}已改存成 txt 流水（${turns.length} 轮）`);
  } catch (e) {
    // 迁不动就留着老文件，下次再试 —— 绝不能把它删了
    logWarn("记忆库", `${key} 的老待总结缓存迁移失败，原文件留着没动`, e);
  }
}

/* ================= 概览（给界面用） ================= */

/** 这个角色的记忆库里现在有多少东西。界面的角标和面板顶部都用它。 */
export function statsFor(key) {
  const diaries = listDiaries(key);
  const pendingMemory = readPending("memory", key);
  const pendingMemo = readPending("memo", key);
  return {
    memories: readMemories(key).length,
    memoChars: readMemo(key).trim().length,
    diaries: diaries.length,
    lastDiary: diaries[0]?.date ?? "",
    diaryLogChars: readDiaryLog(key).trim().length,
    // 待总结现在是纯文本流水，界面按**行数**显示（一轮通常两行）
    pendingMemory: pendingMemory.lines,
    pendingMemo: pendingMemo.lines,
    pendingMemoryChars: pendingMemory.text.trim().length,
    pendingMemoChars: pendingMemo.text.trim().length,
  };
}
