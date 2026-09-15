/**
 * 线下模式的文件层：一个角色一份索引、一条剧情一个文件、原子写。
 *
 * 这个文件**只管「东西长什么样、存哪儿」**，不懂业务规则 —— 提示词怎么拼、
 * 什么时候该总结、选项怎么摘，都在 offline.js 里。分开是因为文件层要被
 * 三个地方用（HTTP 接口、iMessage 那条链、总结），混在一起会绕成环。
 *
 * ── 为什么不进 config.json ──
 *
 * `PUT /api/config` 会顺带重启所有 iMessage 桥接（见 index.js）。剧情是
 * **每一轮都写** —— 发一句、改一条、隐藏一条、重 roll 一次都要落盘，
 * 走 config 等于每说一句话把所有线路踢下线一次。IG 和壁纸当初单独开目录
 * 也是这个原因。
 *
 * ── 为什么分索引和正文两层 ──
 *
 * 索引（`index/<roleKey>.json`）里只有「开没开、当前是哪条、有哪几条」这种
 * 一行字的东西，每收一条消息都要读一次；正文按剧情分文件，演一轮只重写
 * 当前那一条。一条演久了的剧情能有几百轮几十万字，全塞一个文件里的话
 * 每轮都得整份重写，而且归档的老剧情会跟着一起抖。
 *
 * ── 「线下开着吗」只有一个真相 ──
 *
 * 就是索引里的 `open`。**不另立一张全局状态表** —— 两份地方记同一件事，
 * 迟早会漂移（一边说开着一边说关着，用户的消息就会卡在中间谁也不处理）。
 * 和 promptmode.js 的「关闭 = 真删行」是同一个思路：状态只有一处。
 *
 * ── 坏文件不删 ──
 *
 * readJson 读不出来只 warn 然后当空的用，**绝不删也不改名**。这是用户攒了
 * 几十轮的剧情，读不出来也得留着让他自己去看、自己去救。照 igstore.js。
 */

import fs from "node:fs";
import path from "node:path";

import {
  OFFLINE_INDEX_DIR,
  OFFLINE_MEDIA_DIR,
  OFFLINE_STORIES_DIR,
  ensureLayout,
} from "./datadir.js";
import { logWarn } from "./logs.js";

const SCOPE = "线下模式";

/**
 * 文件名白名单。roleKey 来自 memorystore.js:memoryKeyFor（同一个正则），
 * storyId 是自己生成的 —— 两者都会进路径，必须卡死。
 */
const SAFE_KEY = /^[A-Za-z0-9_-]+$/;

/** 媒体文件名白名单。这个值会进 URL。 */
const SAFE_MEDIA = /^[A-Za-z0-9_.-]+$/;

/** 一条剧情最多留几轮。再往上翻只会把上下文窗口挤爆，而且文件读写也开始肉眼可见地慢。 */
export const MAX_TURNS = 2000;

/** 一轮正文最多这么长。剧情本来就长，给得比协助模式（8000）宽。 */
export const MAX_TURN_CHARS = 20000;

/** 一条总结最多这么长。 */
export const MAX_SUMMARY_CHARS = 20000;

/** 用户选项固定四条 —— 用户点名的「剧情选项就切割为 4 个气泡出来」。 */
export const CHOICE_COUNT = 4;

/* ================= 路径 ================= */

/** key 合法才给路径，否则 null —— 挡 `../` 那一类。 */
function safeFile(dir, key) {
  if (!SAFE_KEY.test(String(key ?? ""))) return null;
  return path.join(dir, `${key}.json`);
}

const indexFile = (roleKey) => safeFile(OFFLINE_INDEX_DIR, roleKey);
const storyFile = (storyId) => safeFile(OFFLINE_STORIES_DIR, storyId);

export function mediaPathFor(file) {
  const name = String(file ?? "");
  if (!name || !SAFE_MEDIA.test(name) || name.includes("..")) return null;
  return path.join(OFFLINE_MEDIA_DIR, name);
}

/* ================= 底层读写 ================= */

/** 先 .tmp 再 rename：中途出事不会毁掉原文件（照抄 memorystore 的写法）。 */
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, "utf-8");
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  if (!file || !fs.existsSync(file)) return fallback;
  let text = "";
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (e) {
    logWarn(SCOPE, `${path.basename(file)} 读不出来，这次当空的用`, e);
    return fallback;
  }
  if (!text.trim()) return fallback;
  try {
    return JSON.parse(text);
  } catch (e) {
    // 不删也不改名：这是用户攒出来的剧情，读不出来也得留着让他自己救
    logWarn(SCOPE, `${path.basename(file)} 不是合法 JSON，这次当空的用`, e);
    return fallback;
  }
}

function writeJson(file, value) {
  if (!file) return false;
  try {
    writeAtomic(file, JSON.stringify(value, null, 2));
    return true;
  } catch (e) {
    logWarn(SCOPE, `${path.basename(file)} 写不进去`, e);
    return false;
  }
}

let seq = 0;
/** 短 id。和 igstore/memorystore 的 newId 同一个写法。 */
export function newId(prefix) {
  seq = (seq + 1) % 100000;
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}`;
}

const str = (v) => String(v ?? "");
const clip = (v, limit) => {
  const s = str(v);
  return s.length <= limit ? s : s.slice(0, limit);
};

/* ================= 索引 ================= */

function blankIndex(roleId = "") {
  return { roleId: str(roleId), open: false, currentId: "", stories: [] };
}

/**
 * 一条剧情在索引里的样子。正文不在这儿 —— 这一份要被每轮读，得小。
 *
 * `turnCount` 是**冗余**的（正文里数一遍也能得到），故意存着：侧栏和概览
 * 要显示「演了多少轮」，不存的话画一次列表就得把每条剧情的正文全读出来。
 */
function normalizeStub(raw) {
  const id = str(raw?.id);
  if (!SAFE_KEY.test(id)) return null;
  return {
    id,
    name: str(raw?.name),
    startedAt: str(raw?.startedAt),
    endedAt: str(raw?.endedAt),
    turnCount: Number.isFinite(Number(raw?.turnCount)) ? Math.max(0, Number(raw.turnCount)) : 0,
  };
}

function normalizeIndex(raw, roleId) {
  const def = blankIndex(roleId);
  if (!raw || typeof raw !== "object") return def;
  const stories = (Array.isArray(raw.stories) ? raw.stories : [])
    .map(normalizeStub)
    .filter(Boolean);
  const currentId = str(raw.currentId);
  return {
    roleId: str(raw.roleId) || def.roleId,
    open: Boolean(raw.open),
    // 指向一条已经不存在的剧情就当没有 —— 免得后面每处都得自己防一次
    currentId: stories.some((s) => s.id === currentId) ? currentId : "",
    stories,
  };
}

export function readIndex(roleKey, roleId = "") {
  ensureLayout();
  return normalizeIndex(readJson(indexFile(roleKey), null), roleId);
}

export function writeIndex(roleKey, value) {
  ensureLayout();
  return writeJson(indexFile(roleKey), normalizeIndex(value, value?.roleId));
}

/** 改索引的一站式入口：读 → 交给 fn 改 → 写回去 → 返回新的那份。 */
function patchIndex(roleKey, fn) {
  const idx = readIndex(roleKey);
  const next = fn(idx) ?? idx;
  writeIndex(roleKey, next);
  return next;
}

/**
 * 这个角色的线下开着吗。
 *
 * 每收一条 iMessage 都会问一次（imessage.js 的消息循环里），所以这里只读
 * 索引那个小文件、不碰正文。
 */
export function isOfflineOn(roleKey) {
  return readIndex(roleKey).open === true;
}

/** 所有角色的线下状态。侧栏 publish 用 —— 只读索引，不读正文。 */
export function listAll() {
  ensureLayout();
  let names = [];
  try {
    names = fs.readdirSync(OFFLINE_INDEX_DIR);
  } catch (e) {
    logWarn(SCOPE, "线下索引目录读不出来", e);
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const roleKey = name.slice(0, -5);
    if (!SAFE_KEY.test(roleKey)) continue;
    const idx = readIndex(roleKey);
    out.push({ roleKey, ...idx });
  }
  return out;
}

/* ================= 剧情正文 ================= */

function normalizeTurn(raw) {
  const id = str(raw?.id) || newId("t");
  return {
    id,
    role: raw?.role === "user" ? "user" : "assistant",
    content: clip(raw?.content, MAX_TURN_CHARS),
    // 用户选项：只有助手那一侧才有，一条一句
    options: (Array.isArray(raw?.options) ? raw.options : [])
      .map((o) => clip(o, MAX_TURN_CHARS))
      .filter((o) => o.trim())
      .slice(0, CHOICE_COUNT),
    hidden: Boolean(raw?.hidden),
    ts: str(raw?.ts) || new Date().toISOString(),
  };
}

function normalizeSummary(raw) {
  return {
    id: str(raw?.id) || newId("s"),
    kind: raw?.kind === "big" ? "big" : "small",
    text: clip(raw?.text, MAX_SUMMARY_CHARS),
    // 概括了哪一段（轮次序号，含头不含尾）。界面上显示「第 1-6 轮」用
    from: Math.max(0, Number(raw?.from) || 0),
    to: Math.max(0, Number(raw?.to) || 0),
    ts: str(raw?.ts) || new Date().toISOString(),
  };
}

function normalizeStory(raw, id) {
  return {
    id,
    roleId: str(raw?.roleId),
    name: str(raw?.name),
    presetRef: str(raw?.presetRef),
    startedAt: str(raw?.startedAt) || new Date().toISOString(),
    endedAt: str(raw?.endedAt),
    turns: (Array.isArray(raw?.turns) ? raw.turns : []).map(normalizeTurn).slice(-MAX_TURNS),
    summaries: (Array.isArray(raw?.summaries) ? raw.summaries : []).map(normalizeSummary),
  };
}

export function readStory(storyId) {
  ensureLayout();
  const file = storyFile(storyId);
  if (!file) return null;
  const raw = readJson(file, null);
  if (!raw) return null;
  return normalizeStory(raw, str(storyId));
}

function writeStory(story) {
  ensureLayout();
  const file = storyFile(story?.id);
  if (!file) return false;
  return writeJson(file, normalizeStory(story, str(story.id)));
}

/** 改一条剧情：读 → 交给 fn 改 → 写回去 → 返回新的那份（读不到就 null）。 */
function patchStory(storyId, fn) {
  const story = readStory(storyId);
  if (!story) return null;
  const next = fn(story) ?? story;
  return writeStory(next) ? next : null;
}

/**
 * 索引里那条摘要跟着正文对齐。
 *
 * 每次动正文都调一次。不调的话侧栏上的轮数会停在旧值 —— 那是用户唯一能
 * 一眼看到「这条演到哪了」的地方。
 */
function syncStub(roleKey, story) {
  patchIndex(roleKey, (idx) => ({
    ...idx,
    stories: idx.stories.map((s) =>
      s.id === story.id
        ? { ...s, name: story.name, endedAt: story.endedAt, turnCount: story.turns.length }
        : s
    ),
  }));
}

/* ================= 开关和剧情管理 ================= */

/**
 * 开线下。没有在演的剧情就顺手起一条 —— 用户在手机上发 `/开启线下`
 * 想的是「开始演」，不该再要求他先去网页上建一条剧情。
 *
 * 已经开着就原样返回（幂等），不会把正在演的那条冲掉。
 */
export function openOffline(roleKey, { roleId = "", presetRef = "", name = "" } = {}) {
  const idx = readIndex(roleKey, roleId);
  if (idx.open && idx.currentId) return idx;

  // 关着但有当前剧情 → 接着演那条，不新建
  if (idx.currentId) {
    return patchIndex(roleKey, (i) => ({ ...i, roleId: roleId || i.roleId, open: true }));
  }
  const created = newStory(roleKey, { roleId, presetRef, name });
  return patchIndex(roleKey, (i) => ({
    ...i,
    roleId: roleId || i.roleId,
    open: true,
    currentId: created?.id || i.currentId,
  }));
}

/**
 * 关线下。
 *
 * **`currentId` 留着不清** —— 用户关了再开，想接着演的是同一条，不是新的一条。
 * 「这段演完了」是 `endStory` 的事，两件事分开。
 */
export function closeOffline(roleKey) {
  return patchIndex(roleKey, (idx) => ({ ...idx, open: false }));
}

/** 新起一条剧情，并设成当前那条。返回新剧情（正文那一份）。 */
export function newStory(roleKey, { roleId = "", presetRef = "", name = "" } = {}) {
  ensureLayout();
  const id = newId("st");
  const idx = readIndex(roleKey, roleId);
  const story = normalizeStory(
    {
      roleId: roleId || idx.roleId,
      name: str(name).trim() || `剧情 ${idx.stories.length + 1}`,
      presetRef,
      startedAt: new Date().toISOString(),
    },
    id
  );
  if (!writeStory(story)) return null;
  patchIndex(roleKey, (i) => ({
    ...i,
    roleId: roleId || i.roleId,
    currentId: id,
    stories: [
      ...i.stories,
      {
        id,
        name: story.name,
        startedAt: story.startedAt,
        endedAt: "",
        turnCount: 0,
      },
    ],
  }));
  return story;
}

/** 当前在演的那条剧情（正文）。没有就 null。 */
export function currentStory(roleKey) {
  const idx = readIndex(roleKey);
  return idx.currentId ? readStory(idx.currentId) : null;
}

/** 切到另一条剧情（网页上换剧情看/接着演）。那条不存在就不动。 */
export function setCurrent(roleKey, storyId) {
  return patchIndex(roleKey, (idx) =>
    idx.stories.some((s) => s.id === storyId) ? { ...idx, currentId: storyId } : idx
  );
}

/**
 * 改剧情名。索引和正文两处都得改 —— 索引那份是侧栏读的，正文那份是
 * 导出和日志读的，只改一边会看到两个名字。
 */
export function renameStory(roleKey, storyId, name) {
  const story = patchStory(storyId, (s) => ({ ...s, name: str(name).trim() || s.name }));
  if (story) syncStub(roleKey, story);
  return story;
}

/** 给剧情盖上「演完了」的时间戳。正文和总结都留着，只是不再是进行中。 */
export function endStory(roleKey, storyId) {
  const story = patchStory(storyId, (s) => ({ ...s, endedAt: new Date().toISOString() }));
  if (story) syncStub(roleKey, story);
  return story;
}

/**
 * 删一条剧情：正文文件和索引里那条一起删。
 *
 * 删的正好是当前那条时，`currentId` 会被 normalizeIndex 自动清掉
 * （它只认列表里还在的 id）—— 不用在这儿单独判一次。
 */
export function removeStory(roleKey, storyId) {
  const file = storyFile(storyId);
  if (file && fs.existsSync(file)) {
    try {
      fs.unlinkSync(file);
    } catch (e) {
      logWarn(SCOPE, "剧情文件删不掉", e);
      return false;
    }
  }
  patchIndex(roleKey, (idx) => ({
    ...idx,
    stories: idx.stories.filter((s) => s.id !== storyId),
  }));
  return true;
}

/* ================= 轮次 ================= */

/**
 * 追加一轮到当前剧情。返回新那一轮（没有当前剧情就 null）。
 *
 * 超过 MAX_TURNS 时丢最旧的 —— normalizeStory 的 `slice(-MAX_TURNS)` 干这件事。
 * 磁盘上的存档也跟着掉，这是有意的：几千轮之后最早那几轮已经进过总结了。
 */
export function appendTurn(roleKey, turn) {
  const idx = readIndex(roleKey);
  if (!idx.currentId) return null;
  const one = normalizeTurn(turn);
  const story = patchStory(idx.currentId, (s) => ({ ...s, turns: [...s.turns, one] }));
  if (!story) return null;
  syncStub(roleKey, story);
  return one;
}

/**
 * 改一轮。能改的只有 `content` 和 `hidden` —— 身份和时间戳不给改，
 * 那两样一改，上下文的顺序和「谁说的」就乱了。
 *
 * **id 不存在时返回 null**（不是「改了个空」）。下面 remove/summary 那几个同理：
 * `map`/`filter` 对着一个不存在的 id 会安安静静什么都不做，接口那边就会回一句
 * 「改好了」而磁盘上一个字没动 —— 用户看到的是「我编辑的内容没保存」。
 */
export function updateTurn(roleKey, storyId, turnId, patch) {
  if (!(readStory(storyId)?.turns ?? []).some((t) => t.id === turnId)) return null;
  const story = patchStory(storyId, (s) => ({
    ...s,
    turns: s.turns.map((t) =>
      t.id !== turnId
        ? t
        : {
            ...t,
            ...(patch?.content === undefined ? {} : { content: clip(patch.content, MAX_TURN_CHARS) }),
            ...(patch?.hidden === undefined ? {} : { hidden: Boolean(patch.hidden) }),
          }
    ),
  }));
  if (story) syncStub(roleKey, story);
  return story;
}

export function removeTurn(roleKey, storyId, turnId) {
  if (!(readStory(storyId)?.turns ?? []).some((t) => t.id === turnId)) return null;
  const story = patchStory(storyId, (s) => ({
    ...s,
    turns: s.turns.filter((t) => t.id !== turnId),
  }));
  if (story) syncStub(roleKey, story);
  return story;
}

/**
 * 重 roll 用：把末尾**连续的**助手轮次删掉，返回删了几条。
 *
 * 连续地删是因为一轮可能落了不止一条（将来若要分段落盘）。用户那一句留着，
 * 调用方按同一份上文再生成一次 —— 这就是「重 roll 这次回复」。
 */
export function dropLastAssistant(roleKey, storyId) {
  let dropped = 0;
  const story = patchStory(storyId, (s) => {
    const turns = [...s.turns];
    while (turns.length && turns[turns.length - 1].role === "assistant") {
      turns.pop();
      dropped += 1;
    }
    return { ...s, turns };
  });
  if (story) syncStub(roleKey, story);
  return dropped;
}

/* ================= 总结 ================= */

export function appendSummary(storyId, summary) {
  const one = normalizeSummary(summary);
  const story = patchStory(storyId, (s) => ({ ...s, summaries: [...s.summaries, one] }));
  return story ? one : null;
}

/** 这条剧情里有这份总结吗。上面那条「不存在就返回 null」的规矩要用。 */
function hasSummary(storyId, summaryId) {
  return (readStory(storyId)?.summaries ?? []).some((x) => x.id === summaryId);
}

/** 手改总结正文。`kind`/`from`/`to` 不给改 —— 那是「概括了哪一段」的事实。 */
export function updateSummary(storyId, summaryId, text) {
  if (!hasSummary(storyId, summaryId)) return null;
  return patchStory(storyId, (s) => ({
    ...s,
    summaries: s.summaries.map((x) =>
      x.id === summaryId ? { ...x, text: clip(text, MAX_SUMMARY_CHARS) } : x
    ),
  }));
}

export function removeSummary(storyId, summaryId) {
  if (!hasSummary(storyId, summaryId)) return null;
  return patchStory(storyId, (s) => ({
    ...s,
    summaries: s.summaries.filter((x) => x.id !== summaryId),
  }));
}

/* ================= 头像 ================= */

/** base64 存成文件，返回文件名。照 igstore:saveMedia 的写法。 */
export function saveMedia(base64, ext = "png") {
  ensureLayout();
  const clean = String(base64 ?? "").replace(/^data:[^;]+;base64,/, "");
  if (!clean) return "";
  const safeExt = /^[A-Za-z0-9]{1,5}$/.test(ext) ? ext : "png";
  const name = `${newId("av")}.${safeExt}`;
  try {
    fs.writeFileSync(path.join(OFFLINE_MEDIA_DIR, name), Buffer.from(clean, "base64"));
    return name;
  } catch (e) {
    logWarn(SCOPE, "头像存不下来", e);
    return "";
  }
}
