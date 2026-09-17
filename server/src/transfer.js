/*
 * 单件的导出 / 导入：一份预设、一本世界书、一个角色的记忆库。
 *
 * 和 backup.js 的分工：那边是「整份配置一锅端」，用来换机器、留快照；
 * 这边是「把手里的这一件递出去」—— 发一份预设给别人、把旧机器上某个角色
 * 的记忆搬过来。两边共用同一个信封（app / kind / version / exportedAt），
 * 只是 kind 不一样，所以文件选错时能说清「你给的是整份备份，不是预设」。
 *
 * 四条贯穿全文的规矩：
 *
 *  1. **导入一律重新发 id**。别人那份预设的 id 很可能和本地某份撞上，沿用
 *     的话不是顶掉人家的就是留下两份同 id。导入永远是「多出一件」，
 *     从不覆盖现有的任何一件。
 *  2. **正文一个字都不改**。记忆里的 `$`（气泡分隔）、`[无语]`、`【转账】`
 *     是原始记录的一部分 —— 用户钉死过「绝对禁止虚构与{{char}}的互动记录」，
 *     那也包括不许「顺手规整」已有记录。
 *  3. **成品日记只加不删**。用户钉死过「生成后的日记默认永远都不会清空」，
 *     导入不能变成删日记的后门：包里有的写进去（同名覆盖），本地多出来的
 *     原样留着。
 *  4. **覆盖之前先备份**。和记忆库自己的规矩同一条（「每个待总结的文件，
 *     都必须在生成之前备份一次」），用的也是同一个 `backupPathFor`。
 *
 * 向量单独说一句：`embedMissing` 只补 `embedding` 为 null 的那些，
 * 从不重算已有的 —— 余弦要求两边同一个模型同一种截断，混着算等于白算。
 */

import fs from "node:fs";

import { embedText } from "./llm.js";
import { extractKeywords, truncate } from "./memory.js";
import {
  backupPathFor,
  diaryLogPath,
  listDiaries,
  memoryItemsPath,
  pendingLogPath,
  putDiary,
  readDiary,
  readDiaryLog,
  readDiaryState,
  readMemo,
  readMemories,
  readPending,
  writeDiaryLog,
  writeDiaryState,
  writeMemo,
  writeMemories,
  writePendingText,
} from "./memorystore.js";
import { str } from "./normalize.js";
import { normalizePresets, normalizeRegexRules, presetLabel } from "./preset.js";
import { normalizeWorldBooks, worldBookLabel } from "./worldinfo.js";

const APP = "uranus-imessage";
const VERSION = 1;

/** 四种单件。值会写进文件里，改了就读不了旧文件，别动。 */
export const KIND = {
  preset: "preset",
  world: "worldbook",
  memory: "memorybank",
  regex: "regexrules",
};

/** 报错时说人话用的。backup 也列进来 —— 拿备份文件来导预设是最常见的手滑。 */
const KIND_LABEL = {
  preset: "预设",
  worldbook: "世界书",
  memorybank: "记忆库",
  regexrules: "正则规则",
  backup: "整份备份",
};

/* ================= 信封 ================= */

function envelope(kind, body) {
  return {
    app: APP,
    kind,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    ...body,
  };
}

/**
 * 拆信封：确认这个文件确实是「这一种」东西，不是就抛一句能照着办的中文。
 *
 * 版本只挡「比我新」：老版本导出的文件照读不误（字段少了 normalize 会补），
 * 新版本导出的可能有这边不认识的结构，猜着读只会读出一份残缺的东西。
 */
export function openBundle(raw, want) {
  const wantLabel = KIND_LABEL[want] ?? want;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`这个文件的内容不是一份${wantLabel}`);
  }
  if (raw.app !== APP) {
    throw new Error("这不是 Uranus iMessage 导出的文件");
  }
  if (raw.kind !== want) {
    const got = KIND_LABEL[raw.kind] ?? `「${raw.kind || "不认识的类型"}」`;
    throw new Error(`这份文件是${got}，不是${wantLabel}，选错文件了`);
  }
  if (Number(raw.version) > VERSION) {
    throw new Error(
      `这份${wantLabel}文件是更新版本（v${raw.version}）的程序导出的，当前版本读不了，先升级程序`
    );
  }
  return raw;
}

/** 导出的文件名：`uranus-preset-日常闲聊-20260913-1530.json`。 */
export function transferFileName(kind, label, now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}`;
  // 文件名里不能有的字符换成 `-`；名字可能很长，截到 40 个字够认了
  const slug = String(label ?? "")
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `uranus-${kind}-${slug ? `${slug}-` : ""}${stamp}.json`;
}

/**
 * 重名时加后缀。
 *
 * 名字不是正文，动它不违反「正文一个字都不改」—— 而两份都叫「日常闲聊」的
 * 预设摆在列表里，用户根本分不出哪份是刚导进来的。
 */
function uniqueName(name, taken) {
  const used = new Set(taken);
  if (!used.has(name)) return name;
  let out = `${name}（导入）`;
  let n = 2;
  while (used.has(out)) out = `${name}（导入 ${n++}）`;
  return out;
}

/* ================= 预设 ================= */

/**
 * 打包一份预设。
 *
 * **不带 id**：id 是本地的事，收件那台机器自己重新发一个。
 */
export function exportPreset(preset) {
  const { id: _drop, ...body } = preset ?? {};
  return envelope(KIND.preset, { name: presetLabel(preset), preset: body });
}

/**
 * 导入认两种文件：
 *
 *  1. 「导出」按钮产出的信封格式（app / kind / version 包着 preset）；
 *  2. **裸的预设本体** —— data/presets/ 里一份一个文件的那种。用户从备份里
 *     翻出一份直接拖进导入是最顺手的动作，没理由被「这不是导出的文件」
 *     拦在门外。判别用预设独有的字段（mode / regex / params）：世界书的
 *     存储文件也长着 entries，光看那个会认错人。
 *
 * 顺手认一下 SillyTavern 的预设（prompts + prompt_order）—— 这是导入失败
 * 最常见的来路，明说「两边格式不同」比一句笼统的报错有用。
 */
function unwrapPresetFile(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw) && raw.app === undefined) {
    if (Array.isArray(raw.prompts) && Array.isArray(raw.prompt_order)) {
      throw new Error("这是 SillyTavern 的预设文件，两边格式不同，导不进来");
    }
    const presetShaped =
      raw.mode === "online" ||
      raw.mode === "offline" ||
      Array.isArray(raw.regex) ||
      (raw.params && typeof raw.params === "object" && !Array.isArray(raw.params));
    if (presetShaped) return raw;
  }
  return openBundle(raw, KIND.preset).preset;
}

/**
 * 读一份预设出来，**只解析不落盘**，返回规范化之后的对象（已经带好新 id）。
 *
 * 借 `normalizePresets` 顺手发 id：把待导入的这份挂在现有列表末尾走一遍，
 * `pickId` 会避开所有已占用的 id，再把最后一个取回来。这样发 id 的规则
 * 全项目只有一份实现，不会有第二套在这儿慢慢走样。
 */
export function importPreset(bundle, current) {
  const raw = unwrapPresetFile(bundle);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("文件里没有 preset 这一块，内容不完整");
  }
  const list = Array.isArray(current) ? current : [];
  const seed = { ...raw, id: "", name: uniqueName(presetLabel(raw), list.map(presetLabel)) };
  const all = normalizePresets([...list, seed]);
  return all[all.length - 1];
}

/* ================= 正则规则 ================= */

/*
 * 和预设、世界书**不一样**：这边导入**保留原来的 id**，也不改名。
 *
 * 上面那条「导入一律重新发 id」的规矩是为「两件不同的东西」定的 —— 两份预设
 * 撞 id 就是两份打架的文件，所以必须换。规则是另一回事：
 *
 *  1. 用户导出一套八股文规则、粘到另一份预设里，要的正是「同一套规则出现在
 *     两处」，id 一致反而方便对照、方便再导一次、方便两边一起改。
 *  2. **顺序有意义**：`rx-r-16`（如同…岩浆…灌进/满）必须排在 `rx-r-17`
 *     （岩浆）前面。重发 id 会把这个顺序连同「谁是原来那条」一起抹掉。
 *  3. 规则是**追加**进某份预设的，不产生新的「件」；也不像预设那样有列表、
 *     有唯一定位，id 撞了不会让谁找不到谁。
 *
 * 撞 id 的处理是**跳过**，不是改名：导进来的这条已经在这一份里了，再来一条
 * 一模一样的是重复。改名（rx-d-1-2）会留下两条内容相同、名字看着就像同一套
 * 的规则，用户还得自己猜该删哪条。
 */

/** 打包一组正则规则。**带 id** —— 理由见上面那段注释。 */
export function exportRegexRules(rules, label = "") {
  const list = Array.isArray(rules) ? rules : [];
  return envelope(KIND.regex, {
    name: str(label).trim(),
    count: list.length,
    rules: list,
  });
}

/**
 * 读一份规则出来，**只解析不落盘**，返回「该追加进这份预设的那几条」。
 *
 * 已经有的（按 id 认）不重复加，所以同一份文件连导两次不会翻倍 —— 用户想
 * 拿回被自己删掉的某几条时，把整套再导一次也只会补回缺的那几条。
 *
 * 补字段走 normalizeRegexRules（和保存预设时同一份实现），所以导进来的规则
 * 和用户手写一条新规则得到的字段完全一样；缺 flags / targets 的老文件也能读。
 */
export function importRegexRules(bundle, current) {
  const raw = openBundle(bundle, KIND.regex).rules;
  if (!Array.isArray(raw)) {
    throw new Error("文件里没有 rules 这一块，内容不完整");
  }
  const list = Array.isArray(current) ? current : [];
  const have = new Set(list.map((r) => str(r?.id).trim()).filter(Boolean));
  // 没带 id 的（手写的包）也算新的，normalize 会给它发一个
  const fresh = raw.filter((r) => {
    const id = str(r?.id).trim();
    return !id || !have.has(id);
  });
  if (!fresh.length) return { rules: [], added: 0, skipped: raw.length, skippedIds: [] };

  // 现有规则一起过一遍：normalizeRegexRules 的 id 去重是整表算的，
  // 只喂新规则的话它不知道哪些 id 已经被占
  const normalized = normalizeRegexRules([...list, ...fresh]).slice(list.length);
  const taken = new Set(have);
  const rules = normalized.map((r, i) => {
    // 原来的 id 优先（见上面那段注释）；没带 id 的用 normalize 发的那个
    let id = str(fresh[i]?.id).trim() || r.id;
    // normalize 是拿「在整张表里的位置」发 id 的（rx-3 这种），跳过重名的
    // 那几条之后有可能撞上表里已有的 id —— 换上没被占的
    let n = 2;
    while (taken.has(id)) id = `${r.id}-${n++}`;
    taken.add(id);
    return { ...r, id };
  });
  const skippedIds = raw.map((r) => str(r?.id).trim()).filter((id) => id && have.has(id));
  return { rules, added: rules.length, skipped: skippedIds.length, skippedIds };
}

/* ================= 世界书 ================= */

export function exportWorldBook(book) {
  const { id: _drop, ...body } = book ?? {};
  return envelope(KIND.world, { name: worldBookLabel(book), book: body });
}

/** 和 importPreset 一个套路，换成世界书那套 normalize。 */
export function importWorldBook(bundle, current) {
  const raw = openBundle(bundle, KIND.world).book;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("文件里没有 book 这一块，内容不完整");
  }
  const list = Array.isArray(current) ? current : [];
  const seed = { ...raw, id: "", name: uniqueName(worldBookLabel(raw), list.map(worldBookLabel)) };
  const all = normalizeWorldBooks([...list, seed]);
  return all[all.length - 1];
}

/* ================= 记忆库 ================= */

const hasVec = (m) => Array.isArray(m?.embedding) && m.embedding.length > 0;

/** 覆盖前留一份 `.bak`。备不成只告警不拦 —— 拦了用户就什么也做不成。 */
function backupFile(file) {
  if (!file || !fs.existsSync(file)) return;
  try {
    fs.copyFileSync(file, backupPathFor(file));
  } catch {
    /* 备份失败不影响导入，原文件还在 .bak 那次的位置上 */
  }
}

/**
 * 打包一个角色的整个记忆库：记忆条目、备忘录、成品日记、日记流水、
 * 两份待总结的流水，外加定时日记那个小时间戳。
 *
 * `vectors` 默认关着。一条 1536 维的向量摊成 JSON 大概 30KB，几百条就是
 * 十几 MB —— 平时搬家不需要（换机器之后手动补算一次就行），真要连算好的
 * 向量一起带走才勾上。勾了就别再 pretty print：`JSON.stringify(arr, null, 2)`
 * 会把每个数字单独放一行，文件直接翻几倍。
 */
export function exportMemoryBank(key, roleName, { vectors = false } = {}) {
  const memories = readMemories(key).map((m) => ({
    ...m,
    embedding: vectors && hasVec(m) ? m.embedding : null,
  }));
  return envelope(KIND.memory, {
    role: String(roleName ?? ""),
    key,
    includesVectors: Boolean(vectors),
    memories,
    memo: readMemo(key),
    diaries: listDiaries(key).map((d) => ({
      file: d.file,
      date: d.date,
      text: readDiary(key, d.file),
    })),
    diaryLog: readDiaryLog(key),
    diaryState: { lastDiaryAt: String(readDiaryState(key)?.lastDiaryAt ?? "") },
    pending: {
      memory: readPending("memory", key).text,
      memo: readPending("memo", key).text,
    },
  });
}

/** 数一数这个包里有什么。导入前的确认框和导入后的回执都用它。 */
export function summarizeMemoryBundle(bundle) {
  const memories = Array.isArray(bundle?.memories) ? bundle.memories : [];
  const diaries = Array.isArray(bundle?.diaries) ? bundle.diaries : [];
  const lines = (t) => String(t ?? "").split(/\r?\n/).filter((s) => s.trim()).length;
  return {
    role: String(bundle?.role ?? ""),
    includesVectors: Boolean(bundle?.includesVectors),
    memories: memories.length,
    withVectors: memories.filter(hasVec).length,
    memoChars: String(bundle?.memo ?? "").trim().length,
    diaries: diaries.length,
    diaryLogLines: lines(bundle?.diaryLog),
    pendingMemoryLines: lines(bundle?.pending?.memory),
    pendingMemoLines: lines(bundle?.pending?.memo),
  };
}

/** 包里的一条记忆 → 能落盘的条目。字段缺了就补，多出来的丢掉。 */
function cleanMemory(raw, used) {
  const content = String(raw?.content ?? "").trim();
  if (!content) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(raw?.date ?? "")) ? raw.date : "";
  const ts = Number(raw?.timestamp);
  const timestamp = Number.isFinite(ts) && ts > 0 ? ts : dateStamp(date || "1970-01-01", 0);
  return {
    id: uniqueId(String(raw?.id ?? "").trim() || "m-imp", used),
    date: date || isoDate(timestamp),
    timestamp,
    content,
    keywords: Array.isArray(raw?.keywords)
      ? raw.keywords.map((k) => String(k)).filter(Boolean)
      : extractKeywords(content),
    embedding: hasVec(raw) ? raw.embedding.map(Number) : null,
  };
}

/**
 * 导入整包：**包里出现的那几块整体替换，没出现的一个字节都不动**
 * （和备份导入同一套语义，用户已经熟了）。
 *
 * 唯一的例外是成品日记：只写进包里有的（同名覆盖），本地多出来的留着。
 * 用户钉死过「生成后的日记默认永远都不会清空」，导入不能绕过这条。
 */
export function importMemoryBank(key, bundle) {
  const b = openBundle(bundle, KIND.memory);
  const applied = { memories: 0, memo: false, diaries: 0, diaryLog: false, pending: [] };

  if (Array.isArray(b.memories)) {
    const used = new Set();
    const list = b.memories.map((m) => cleanMemory(m, used)).filter(Boolean);
    backupFile(memoryItemsPath(key));
    writeMemories(key, list);
    applied.memories = list.length;
  }

  if (typeof b.memo === "string") {
    // writeMemo 自己会先备份，这儿不用再来一次
    writeMemo(key, b.memo);
    applied.memo = true;
  }

  for (const d of Array.isArray(b.diaries) ? b.diaries : []) {
    if (putDiary(key, d?.file, String(d?.text ?? ""))) applied.diaries += 1;
  }

  if (typeof b.diaryLog === "string") {
    backupFile(diaryLogPath(key));
    writeDiaryLog(key, b.diaryLog);
    applied.diaryLog = true;
  }

  for (const kind of ["memory", "memo"]) {
    const text = b.pending?.[kind];
    if (typeof text !== "string") continue;
    backupFile(pendingLogPath(kind, key));
    writePendingText(kind, key, text);
    applied.pending.push(kind);
  }

  if (b.diaryState?.lastDiaryAt) {
    writeDiaryState(key, { lastDiaryAt: String(b.diaryState.lastDiaryAt) });
  }

  return { applied, counts: summarizeMemoryBundle(b) };
}

/* ================= 纯文本记忆导入 ================= */

/** 一行条目：`2026-09-09 | 正文`。日期后面的竖线两边可以有空格。 */
const ENTRY = /^(\d{4}-\d{2}-\d{2})\s*\|\s*(.+)$/;

/**
 * 一份 txt → 条目数组（**按日期正序**，老的在前）。
 *
 * 纯函数，不碰磁盘 —— 离线测试直接喂字符串（scripts/test-memory.mjs 第 18 节
 * 从 scripts/import-memories.mjs 转口 import 这个函数）。
 *
 * 源文件是**倒序**的（导出时新的在最上面），这里翻成正序，理由是记忆库里的
 * 数组顺序就是追加顺序：正序存进去，以后新总结的记忆继续往后追加，
 * 整个文件从头到尾就是一条时间线。
 *
 * 同一天有好几条时（最多见过 11 条），文件里也是新的在前，所以翻转之后
 * 那一天内部同样是正序。
 *
 * 正文**一个字都不改**：`$`（气泡分隔）、`[无语]`（表情标记）、`【转账】`
 * 这些是原始记录的一部分，用户钉死过「绝对禁止虚构与{{char}}的互动记录」——
 * 那也包括不许「顺手规整」已有记录。
 *
 * @param {string} text 整个文件的内容
 * @returns {{entries: {date: string, content: string}[], skipped: string[]}}
 *          skipped 是**看着像内容却没匹配上**的行，调用方要报出来 ——
 *          静悄悄少导几条比整个失败更糟
 */
export function parseMemoryFile(text) {
  const raw = String(text ?? "").replace(/^﻿/, "");
  const entries = [];
  const skipped = [];

  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    // 包裹标签本来就该在，不算「漏掉的行」
    if (s === "<memories>" || s === "</memories>") continue;

    const m = ENTRY.exec(s);
    if (!m) {
      skipped.push(s);
      continue;
    }
    const content = m[2].trim();
    if (content) entries.push({ date: m[1], content });
    else skipped.push(s);
  }

  // 源文件是倒序，翻成正序（`reverse` 够了：同一天内部的相对次序跟着一起翻）
  entries.reverse();
  return { entries, skipped };
}

/**
 * 日期 → 时间戳。**取当天中午 12:00**，同一天的第 i 条再加 i 分钟。
 * 这就是「自动按时间分类」落地的地方 —— 有了 timestamp，条目才会排进
 * 时间线，「近 N 天记忆」那一路才拿得到它。
 *
 * 源文件只有年月日，没有钟点。落成 00:00 的话「近 3 天」那一路会在跨日
 * 的边界上把当天的记忆算成第 4 天（cutoff 是 `now - 3×24h`），取中午
 * 离两边都远、最不容易踩到边界。
 *
 * 加分钟是为了让同一天的几条有**确定的先后**：`filterRecent` 按 timestamp
 * 排序，全都一模一样的话次序就只能靠 sort 的稳定性兜着，读起来没保证。
 */
export function dateStamp(date, indexInDay = 0) {
  const [y, m, d] = String(date).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1, 12, indexInDay, 0, 0).getTime();
}

/** 时间戳 → 本地 `YYYY-MM-DD`（条目里 date 缺了才用得上）。 */
function isoDate(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 发一个没被占用的 id。
 *
 * 导入的条目用一眼能认出来的前缀（`m-imp-20260909-1`），以后翻 JSON 时
 * 知道这几条是搬进来的。带去重是因为分两次导两份日期重叠的文件时，
 * 光按「日期 + 当天第几条」算出来的 id 会撞上 —— 而界面上改一条、删一条
 * 全靠 id 认人，撞了就是改错删错。
 */
function uniqueId(base, used) {
  let id = base;
  let n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  used.add(id);
  return id;
}

/**
 * 把解析出来的条目变成记忆条目，**按正文去重**。
 *
 * 去重让整个导入可以反复跑：同一份文件导第二遍不会多出条目来。
 * `embedding` 一律留 null —— 向量要打网络、几百条要几分钟，交给用户
 * 在界面上手动触发一次（记忆页的「补算向量」）。
 */
export function buildImportRecords(entries, existing) {
  const have = new Set((existing ?? []).map((m) => String(m.content ?? "").trim()));
  const used = new Set((existing ?? []).map((m) => String(m.id ?? "")).filter(Boolean));
  const seenInDay = new Map();
  const fresh = [];
  let duplicates = 0;

  for (const e of entries ?? []) {
    if (have.has(e.content)) {
      duplicates += 1;
      continue;
    }
    have.add(e.content); // 文件内部万一有重复，也只进一条
    const i = seenInDay.get(e.date) ?? 0;
    seenInDay.set(e.date, i + 1);
    fresh.push({
      id: uniqueId(`m-imp-${e.date.replace(/-/g, "")}-${i + 1}`, used),
      date: e.date,
      timestamp: dateStamp(e.date, i),
      content: e.content,
      keywords: extractKeywords(e.content),
      embedding: null,
    });
  }
  return { fresh, duplicates };
}

/**
 * 纯文本记忆导入的整条流程：解析 → 去重 → 备份 → 落盘。
 *
 * 已有的排前面：它们的 timestamp 未必比导入的这批老，但数组顺序表达的是
 * 「什么时候进的库」，界面按 timestamp 排序显示，不看数组顺序。
 */
export function importMemoryText(key, text) {
  const { entries, skipped } = parseMemoryFile(text);
  const existing = readMemories(key);
  const { fresh, duplicates } = buildImportRecords(entries, existing);

  if (fresh.length) {
    backupFile(memoryItemsPath(key));
    writeMemories(key, [...existing, ...fresh]);
  }
  return {
    parsed: entries.length,
    added: fresh.length,
    duplicates,
    skipped,
    from: entries[0]?.date ?? "",
    to: entries.at(-1)?.date ?? "",
    total: existing.length + fresh.length,
  };
}

/* ================= 补算向量 ================= */

/** 还差多少条没算向量。界面上那个按钮要不要显示就看它。 */
export function vectorGap(key) {
  const list = readMemories(key);
  const missing = list.filter((m) => !hasVec(m)).length;
  return { total: list.length, missing, done: list.length - missing };
}

/**
 * 把 `embedding` 还是 null 的那些补上向量。**一次只算一批**。
 *
 * 和 summarizeMemory 走同一条路（`embedText` + 同一个 `maxInputChars`），
 * 算出来的向量才和以后新总结的那些可比 —— 余弦要求两边同一个模型
 * 同一种截断。已经有向量的一条都不动。
 *
 * 几条规矩：
 *  - **分批**：一条一次网络请求，几百条要几分钟，一个 HTTP 请求扛不住。
 *    `limit` 封顶，剩下多少在 `left` 里回给前端，前端接着叫下一批。
 *  - **每 20 条落一次盘**：中途掐掉时已经算好的不该白算。
 *  - **连着失败 5 次就停手**（额度用完 / 密钥失效 / 服务挂了都是这个样子），
 *    剩下的留 null，下次再点接着补。
 *  - 单条失败不算数：留 null，继续往下走。
 *
 * `onProgress` 是给命令行用的（每落一次盘叫一次）；HTTP 那边不用，
 * 它靠分批本身就能在界面上走进度条。
 */
export async function embedMissing(
  key,
  endpoint,
  { maxInputChars = 4000, limit = 40, onProgress = null } = {}
) {
  const list = readMemories(key);
  const todo = list.filter((m) => !hasVec(m));
  if (!todo.length) return { done: 0, failed: 0, left: 0, total: 0, stopped: false, errors: [] };

  const batch = limit > 0 ? todo.slice(0, limit) : todo;
  let done = 0;
  let failed = 0;
  let streak = 0;
  let dirty = 0;
  let stopped = false;
  const errors = [];

  for (const item of batch) {
    try {
      // batch 里是 list 里那些对象的引用，改它就是改 list
      item.embedding = await embedText(endpoint, truncate(item.content, maxInputChars));
      done += 1;
      streak = 0;
      dirty += 1;
    } catch (e) {
      failed += 1;
      streak += 1;
      if (errors.length < 3) errors.push(`${item.id}：${String(e?.message ?? e).slice(0, 160)}`);
      if (streak >= 5) {
        stopped = true;
        break;
      }
      continue;
    }
    if (dirty >= 20) {
      writeMemories(key, list);
      dirty = 0;
      onProgress?.({ done, failed, total: todo.length });
    }
  }
  if (dirty) writeMemories(key, list);

  const left = list.filter((m) => !hasVec(m)).length;
  return { done, failed, left, total: todo.length, stopped, errors };
}
