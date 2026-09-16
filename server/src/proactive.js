import { applyVars, resolveEndpoint } from "./config.js";
import { chatCompletion } from "./llm.js";
import { logDebug, logInfo, logWarn } from "./logs.js";
import { wrap } from "./prompt.js";

/**
 * 主动消息的**算时间**那一半。
 *
 * 「隔多久开口」「现在是不是勿扰时段」「问模型要一个小时数」「那条 user
 * 消息正文长什么样」都在这里；真正的**发**（排队、打字指示器、拆气泡、
 * 写存档、记忆库）留在 imessage.js —— sendBubbles / chain / appendTurn
 * 那几个都长在那边，搬过来两个模块就得互相 import，绕成循环依赖。
 *
 * 所以这个文件是纯的：只 import config / llm / logs / prompt，
 * 不认识 runner，也不碰 space。和 websearch.js、env.js 是一个位置。
 *
 * 时间一律用**系统本地时间**（用户规范里写死的），不做时区换算。
 */

/** 上下文里代替那段长提示词的占位符。见 buildProactiveInput 的注释。 */
export const PROACTIVE_MARK = "[触发了主动消息]";

/**
 * 发完一条主动消息之后额外压的冷却。
 *
 * 用户规范里的「发完后等待十分钟再次计时」。做成常量而不是配置项：
 * 它防的是「模型连着自言自语」这种坏掉的状态，不是给人调风格的旋钮。
 */
export const COOLDOWN_MS = 10 * 60 * 1000;

/** 自主判断模式下模型给的小时数的合法区间。 */
const MIN_HOURS = 0.05; // 3 分钟。再短就是刷屏了
const MAX_HOURS = 24;
/** 模型答了个看不懂的东西时退到这个间隔。 */
const FALLBACK_HOURS = 1;

/** 判断请求给的余量：只要一个数字，用不着 60 秒也用不着重试到天荒地老。 */
const JUDGE_TIMEOUT = 30_000;
const JUDGE_MAX_TOKENS = 16;

/** "HH:MM" → 当天第几分钟。解析不出来返回 null。 */
function clockMinutes(text) {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(text ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * 现在是不是在勿扰时段里。
 *
 * 跨零点要单独判：默认的 00:00-08:00 起点比终点小，是普通区间；
 * 但用户完全可能填 23:00-07:00，那时候「在区间内」= 晚于起点**或**早于终点。
 *
 * 起止相同（例 09:00-09:00）当成**不勿扰**——「全天勿扰」等于把这个功能
 * 关掉，用户要那个效果直接关开关就行，不该靠一个容易手滑填出来的值实现。
 */
export function inFocus(focus, now = new Date()) {
  if (!focus?.enabled) return false;
  const start = clockMinutes(focus.start);
  const end = clockMinutes(focus.end);
  if (start === null || end === null || start === end) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

/**
 * 距勿扰结束还有多少毫秒。不在勿扰时段里返回 0。
 *
 * 加一分钟余量：不加的话定时器会正好落在结束的那一秒上，
 * 时钟差个几百毫秒就又被判成「还在勿扰里」，白白多绕一圈。
 */
export function msUntilFocusEnd(focus, now = new Date()) {
  if (!inFocus(focus, now)) return 0;
  const end = clockMinutes(focus.end);
  const cur = now.getHours() * 60 + now.getMinutes();
  const mins = end > cur ? end - cur : 24 * 60 - cur + end;
  return (mins + 1) * 60 * 1000;
}

/** 随机等待模式：在 [minHours, maxHours] 里掷一个点。 */
export function randomWaitMs(proactive) {
  const lo = Number(proactive?.random?.minHours) || 1;
  const hi = Number(proactive?.random?.maxHours) || 3;
  const min = Math.min(lo, hi);
  const max = Math.max(lo, hi);
  return (min + Math.random() * (max - min)) * 3600_000;
}

/** 自主判断模式的第一段：干等「用户多久没回」。 */
export function judgeWaitMs(proactive) {
  const mins = Number(proactive?.auto?.minWaitMinutes) || 60;
  return mins * 60_000;
}

/** 把勿扰时段填进判断提示词里的 {Focus_time_start} / {Focus_time_end}。 */
function fillFocusVars(text, focus) {
  const on = Boolean(focus?.enabled);
  return String(text ?? "")
    .replace(/\{Focus_time_start\}/g, on ? String(focus.start ?? "") : "无")
    .replace(/\{Focus_time_end\}/g, on ? String(focus.end ?? "") : "无");
}

/**
 * 「对方读了没」这一项现在生效吗。
 *
 * 两道闸：角色自己的开关（`proactive.notifyRead`，默认开，见
 * config.js:normalizeProactive），以及「已读与不回 → 已读回执」
 * （`leaveOnRead.receipt`）—— 已读状态就是从那个回执里读的，关着的话
 * 根本不知道对方读没读，这一项也就无从谈起。
 *
 * 导出是给测试和界面对口径用的：面板上写「这一项要先打开已读回执」，
 * 依据就是这个函数。
 */
export function notifyReadOn(role) {
  if (role?.proactive?.notifyRead === false) return false;
  return Boolean(role?.leaveOnRead?.receipt);
}

/** 把内存历史拍成给判断模型看的几行文本。 */
function historyLines(history, vars) {
  return (history ?? [])
    .map((m) => {
      const who = m.role === "assistant" ? vars.char || "助手" : vars.user || "用户";
      const text = String(m.content ?? "").trim();
      return text ? `${who}：${text}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * 主动消息那条 user 消息的**两份**正文。
 *
 * `toModel` 是真发给模型的：主动消息提示词（变量替换过），必要时后面缀一句
 * 「已读了但没回复」。`toHistory` 是进内存历史和落盘存档的那份，永远只有
 * `[触发了主动消息]` —— 用户规范里的省 token 那条：提示词可能有好几百字，
 * 原样存下去的话之后每一轮都要把它重发一遍。
 *
 * 两份分开还有个副作用是好的：模型下一轮看到的是「我当时被触发了」，
 * 而不是「我当时收到了一段元指令」，不容易学着把提示词本身当台词念出来。
 *
 * @param {object} role 角色（要 name / proactive）
 * @param {object|null} user 生效的用户人设
 * @param {{read?: boolean}} [opts] read = 上一条主动消息被读了但没回
 */
export function buildProactiveInput(role, user, opts = {}) {
  const vars = { char: role?.name ?? "", user: user?.name ?? "" };
  let toModel = applyVars(role?.proactive?.prompt ?? "", vars).trim();

  /*
   * 「{{user}}已读了你发的信息，但还没回复」。
   *
   * 用户规范里要求缀在主动消息提示词**后面**，所以是拼在这份 toModel 上，
   * 而不是单开一条消息 —— 单开一条的话它会以自己的身份进上下文，
   * 而这句是元信息，不该在存档里留痕（存档那份只有 PROACTIVE_MARK）。
   *
   * 三个条件都要成立：这轮真的被读了没回（opts.read，由调度槽记着）、
   * 角色开着「对方读了没」（notifyRead，默认开）、并且已读回执开着
   * （receipt —— 关着的话 opts.read 压根不会为真，这里再判一遍是为了
   * 「关了回执但槽里还留着上一轮的 read」那种时序）。
   */
  if (opts.read && notifyReadOn(role)) {
    toModel += `\n${applyVars("{{user}}已读了你发的信息，但还没回复。", vars)}`;
  }

  return { toModel, toHistory: PROACTIVE_MARK };
}

/**
 * 自主判断模式：问模型「隔多久再主动开口」，返回毫秒数。
 *
 * **刻意不走 buildPrompt。** 那份要拼预设的十几个条目、世界书、完整上文，
 * 动辄几千 token；而这里只要一个数字。所以自己拼一份最小的：人设 +
 * 最近几条上文 + 判断提示词，配合 max_tokens=16，一次判断的成本可以忽略。
 *
 * 服务商没选就用这个角色的主聊天模型（用户规范里的「不选择的话默认使用
 * 主 API」）。判断模型解析不出来（被删了 / 被关了）时同样退回主 API。
 *
 * @param {object} config 规范化后的整份配置
 * @param {object} role 角色
 * @param {object|null} user 生效的用户人设
 * @param {Array<{role:string,content:string}>} history 内存里的上文
 * @param {string} scope 日志 scope
 * @returns {Promise<number>} 等待毫秒数。请求失败会 throw，由调用方决定退路
 */
export async function judgeWaitByLLM(config, role, user, history, scope) {
  const p = role?.proactive ?? {};
  const ref = p.auto?.model;
  const picked = ref?.provider && ref?.modelId ? resolveEndpoint(config, ref) : null;
  const endpoint = picked ?? resolveEndpoint(config, role?.chatModel);
  if (!endpoint) throw new Error("这个角色的聊天模型没配好，判断不了主动消息的时间");
  if (ref?.modelId && !picked) {
    logWarn(scope, "选的时间判断模型解析不出来（可能被删了或被关掉了），改用主 API");
  }

  const vars = { char: role?.name ?? "", user: user?.name ?? "" };
  const count = Number.isFinite(p.contextCount) ? p.contextCount : 10;
  const recent = count > 0 ? (history ?? []).slice(-count) : [];

  const system = [
    wrap("Character", applyVars(role?.description ?? "", vars)),
    wrap("Chat_History", historyLines(recent, vars)),
  ]
    .filter(Boolean)
    .join("\n\n");

  const ask = applyVars(fillFocusVars(p.auto?.prompt ?? "", p.focus), vars);
  const messages = [
    ...(system ? [{ role: "system", content: system }] : []),
    { role: "user", content: ask },
  ];

  // chatCompletion 返回的是**裸字符串**，不是 { content }。
  // 按对象解构过一次，结果是每次都拿到 undefined、每次都退到 FALLBACK_HOURS
  // —— 表现就是日志里那句「模型没给出能用的小时数」一直刷，而模型其实答得很好
  const content = await chatCompletion(endpoint, messages, {
    label: endpoint.label || "时间判断",
    timeout: JUDGE_TIMEOUT,
    maxTokens: JUDGE_MAX_TOKENS,
    // 温度压到 0：要的是一个数，不是创意
    params: { temperature: 0 },
  });

  return parseHours(content, scope);
}

/**
 * 从模型的回答里抠出小时数，钳进 [MIN_HOURS, MAX_HOURS] 再换成毫秒。
 *
 * 取**第一个**数字：提示词要求只回一个数，但模型爱写「2小时」「大约1.5」
 * 甚至「2-3」。这些取第一个都是对的答案。一个数字都没有（「明天早上」）
 * 才退到 FALLBACK_HOURS —— 退比不发好，也比无限等下去好。
 */
export function parseHours(text, scope) {
  const raw = String(text ?? "").trim();
  const m = /-?\d+(?:\.\d+)?/.exec(raw);
  let hours = m ? Number(m[0]) : NaN;

  if (!Number.isFinite(hours) || hours <= 0) {
    logWarn(scope, `模型没给出能用的小时数，按 ${FALLBACK_HOURS} 小时算`, raw.slice(0, 200));
    hours = FALLBACK_HOURS;
  }

  const clamped = Math.min(MAX_HOURS, Math.max(MIN_HOURS, hours));
  if (clamped !== hours) {
    logDebug(scope, `模型给的 ${hours} 小时超出范围，按 ${clamped} 小时算`);
  }
  logInfo(scope, `下一条主动消息安排在 ${clamped} 小时后`);
  return clamped * 3600_000;
}

/** 给日志用：把毫秒说成人话。 */
export function humanizeWait(ms) {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins} 分钟`;
  return `${(mins / 60).toFixed(1)} 小时`;
}
