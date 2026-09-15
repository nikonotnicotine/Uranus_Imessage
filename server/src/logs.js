/**
 * 运行日志中枢。
 *
 * 后端各模块把「发生了什么」写到这里，前端控制台通过 SSE 实时拉走。
 * 同时照旧打到 stdout，这样 .bat 窗口和前端控制台看到的是同一份东西。
 *
 * 日志只在内存里留最近 RING_MAX 条——这是给人排查用的，不是审计日志。
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 内存里留多少条。
 *
 * 2000 而不是 800：级别切到 DEBUG 之后条数是原来的好几倍（每个 HTTP 请求
 * 两条），800 条撑不到几分钟，等用户发现出问题再去翻，出问题那一刻已经被
 * 挤出去了。每条都是短字符串（`detail` 本来就截在 4000 字符），2000 条的
 * 内存代价可以忽略。
 */
const RING_MAX = 2000;

/**
 * 允许的级别，按严重程度从低到高排列（前端过滤按这个顺序算「以上」）。
 *
 * `critical` 排在 `error` 后面而不是别的位置 —— 这个数组的**顺序就是语义**：
 * 前端的「xx 以上」是拿 indexOf 比大小算出来的，插错位置的话「只看问题」
 * 会把最严重的那一档漏掉。
 *
 * `error` 和 `critical` 的分界：error 是「这件事没做成」（一轮回复没生成、
 * 一张图没出来），服务本身还好好的；critical 是「服务本身出问题了」
 * （数据写不进去、进程要退了）。分不清就用 error —— 宁可少喊一声。
 */
export const LEVELS = ["debug", "info", "warn", "error", "critical"];

let seq = 0;
const ring = [];
const subscribers = new Set();

/* ================= 错误栈说人话 ================= */

/**
 * 项目根目录，用来把栈里的绝对路径压成相对路径。
 *
 * 自己算而**不是**从 datadir.js 拿它的 `ROOT` —— datadir.js 反过来 import
 * 了这个文件（它要 logWarn），那样是循环依赖。
 */
const ROOT_SLASH = path
  .resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
  .replace(/\\/g, "/");

/** 一条栈最多留几帧。再往下都是框架内部，看了也不知道该改哪儿。 */
const MAX_FRAMES = 6;

/**
 * 把栈里的一个 `file:///…` 地址压成人能读的相对路径。
 *
 * 这个项目的路径里有中文（「小手机」），Node 打出来的栈是**百分号编码**的：
 *
 *     at call (file:///F:/qq/%E5%B0%8F%E6%89%8B%E6%9C%BA/imessage/server/src/cloud/github.js:145:11)
 *
 * 那串 `%E5%B0%8F%E6%89%8B%E6%9C%BA` 就是「小手机」。不解码的话，报错里
 * 「是哪个文件」这个最要紧的信息压根看不出来。这跟哪个模块无关 —— 全项目
 * 每一条栈都长这样，所以修在这儿，一处管所有人。
 *
 * 上面那一帧最后会变成 `server/src/cloud/github.js:145`。
 */
function tidyFrame(url) {
  let text = url;
  try {
    text = decodeURIComponent(url);
  } catch {
    // 畸形的百分号序列（`%E0%A4%A` 这种）decodeURIComponent 会抛。
    // 原样留着也比让整条日志消失好
  }
  text = text.replace(/^file:\/{2,3}/, "");
  // 大小写不敏感地砍掉项目根：Windows 上盘符的大小写不固定（F: / f: 都有）
  const root = `${ROOT_SLASH.toLowerCase()}/`;
  if (text.toLowerCase().startsWith(root)) text = text.slice(root.length);
  // 只留行号 —— 列号对「该改哪儿」没有帮助，白占宽度
  return text.replace(/:(\d+):\d+$/, ":$1");
}

/**
 * 一整条栈：路径解码 + 扔掉没信息量的帧。
 *
 * 扔的是 `node:internal/*`（`processTicksAndRejections` 那种），它们在每条
 * async 栈里都有、每条都一样。**全是内部帧的时候留一条** —— 那说明是 Node
 * 自己抛的，一帧不留就只剩一句光秃秃的消息，连从哪儿来的都不知道。
 */
function tidyStack(text) {
  const cleaned = String(text).replace(/file:\/{2,3}[^\s)]+/g, tidyFrame);

  const isFrame = (l) => /^\s*at /.test(l);
  const isInternal = (l) => /node:internal\//.test(l);
  const lines = cleaned.split("\n");
  const frames = lines.filter(isFrame);
  if (!frames.length) return cleaned;

  const hasMine = frames.some((l) => !isInternal(l));
  const limit = hasMine ? MAX_FRAMES : 1;

  const out = [];
  let kept = 0;
  let internal = 0; // 扔掉的框架内部帧
  let overflow = 0; // 超出上限扔掉的
  for (const line of lines) {
    if (!isFrame(line)) {
      out.push(line);
      continue;
    }
    if (hasMine && isInternal(line)) {
      internal += 1;
      continue;
    }
    if (kept >= limit) {
      overflow += 1;
      continue;
    }
    kept += 1;
    out.push(line);
  }
  // 两种「扔掉」分别说 —— 「都是框架内部」套在超出上限的帧上是假话，
  // 那些是自己的代码，人可能正想看
  const why = [
    overflow ? `另有 ${overflow} 帧` : "",
    internal ? `${internal} 帧框架内部` : "",
  ].filter(Boolean);
  if (why.length) out.push(`    …（${why.join("，")}）`);
  return out.join("\n");
}

/** detail 可能是 Error / 对象 / 长字符串，统一压成可读的短文本。 */
function stringifyDetail(detail) {
  if (detail == null) return undefined;
  let text;
  if (typeof detail === "string") {
    text = detail;
  } else if (detail instanceof Error) {
    text = detail.stack ?? `${detail.name}: ${detail.message}`;
  } else {
    try {
      text = JSON.stringify(detail, null, 2);
    } catch {
      text = String(detail);
    }
  }
  // 字符串那一支也要过一遍：上游有时候是把 `e.stack` 当字符串传进来的
  text = tidyStack(text);
  // 上游偶尔会回几十 KB 的 HTML 错误页，截断避免把内存和前端都撑爆。
  // 排在整理**之后**：整理会缩短文本，先截的话有用的那几帧可能正好被切掉
  return text.length > 4000 ? `${text.slice(0, 4000)}\n…（已截断）` : text;
}

const CONSOLE_FN = {
  debug: console.debug,
  info: console.log,
  warn: console.warn,
  error: console.error,
  critical: console.error,
};

/**
 * 记一条日志。
 * @param {"debug"|"info"|"warn"|"error"|"critical"} level
 *   不认识的级别降级成 info（老调用方传什么都不会炸）
 * @param {string} scope 来源标签，例如 "桥接" / "LLM" / "视觉"
 * @param {string} message 一句话说清发生了什么
 * @param {unknown} [detail] 需要展开才看的原始内容（错误栈、响应体…）
 */
export function log(level, scope, message, detail) {
  const lv = LEVELS.includes(level) ? level : "info";
  const entry = {
    id: ++seq,
    ts: new Date().toISOString(),
    level: lv,
    scope: scope ?? "系统",
    message: String(message ?? ""),
    detail: stringifyDetail(detail),
  };

  ring.push(entry);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);

  (CONSOLE_FN[lv] ?? console.log)(
    `[${entry.scope}] ${entry.message}${entry.detail ? `\n  ${entry.detail}` : ""}`
  );

  for (const fn of subscribers) {
    try {
      fn(entry);
    } catch {
      /* 某个订阅者炸了不该影响别人 */
    }
  }
  return entry;
}

export const logDebug = (scope, message, detail) => log("debug", scope, message, detail);
export const logInfo = (scope, message, detail) => log("info", scope, message, detail);
export const logWarn = (scope, message, detail) => log("warn", scope, message, detail);
export const logError = (scope, message, detail) => log("error", scope, message, detail);
/** 服务本身出问题了（不是「某件事没做成」）。分不清就用 logError，见 LEVELS。 */
export const logCritical = (scope, message, detail) =>
  log("critical", scope, message, detail);

/**
 * 取历史日志快照。
 * @param {{since?: number, limit?: number}} [opts] since = 只要 id 大于它的
 */
export function getLogs({ since, limit } = {}) {
  let out = ring;
  if (Number.isFinite(since)) out = out.filter((e) => e.id > since);
  if (Number.isFinite(limit) && limit > 0 && out.length > limit) {
    out = out.slice(out.length - limit);
  }
  return out.slice();
}

export function clearLogs() {
  ring.length = 0;
  const entry = log("info", "系统", "日志已清空");
  return entry;
}

/** 订阅新日志，返回退订函数。 */
export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function subscriberCount() {
  return subscribers.size;
}