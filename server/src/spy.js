/**
 * 查岗：让角色看一眼用户此刻的电脑屏幕或手机屏幕。
 *
 * ── 两条腿，两种形态 ──
 *
 *   [查岗实时电脑屏幕]   **拉**：打用户机器上的截图服务，`GET /screenshot` 拿一张 JPEG
 *   [查岗实时手机屏幕]   **推 + 等**：发一封触发邮件，等 iPhone 把截图 POST 回来
 *
 * 电脑那头是现成的本地 Windows 截图程序（astrbot_plugin_screen_monitor_exe），
 * 默认监听 127.0.0.1:6878，换成别的截图服务也不用改代码 —— 只要求一件事：
 * GET 回一张图。
 *
 * 手机那头**不能这么拉**。iOS 上没有能后台常驻监听端口的东西，唯一能被外部
 * 叫醒的入口是快捷指令的自动化，而它只认「收到邮件」「收到信息」这类事件。
 * 所以手机是三步：发触发邮件 → 邮件自动化跑快捷指令截屏 → 图 POST 回服务端。
 * 那一整套在 spyphone.js 里，这边只管调用和等结果。
 *
 * 走邮件不走 iMessage 是用户定的：角色本来就在 iMessage 上和用户聊天，用同一条
 * 线路发触发消息会让 `PHONESPY_TRIGGER` 出现在两人的对话气泡里。邮件是另一个
 * 信道，不打扰聊天。
 *
 * ── 为什么不做成工具调用 ──
 *
 * 用户明确要求「LLM 可使用标签查岗，不要调用工具」。本项目的模型走的是纯文本
 * 补全，标签是全局唯一的约定（media.js / igtags.js / websearch.js 都是这套），
 * function calling 那条路在这儿反而是异类：中转站不一定支持，而且和现有的
 * `[搜索:…]`、`[image:…]` 两种风格并存会让提示词自相矛盾。
 *
 * ── 和 `[搜索:…]` 是同一个形态 ──
 *
 * 模型第一次回复里写了查岗标签 → 真去抓一张图 → 识图 → 把描述接在后面
 * 再问一次模型 → **对方只收到第二次的回复**。整趟往返在 imessage.js:spyRound
 * 里驱动，那个函数刻意照着 searchRound 写，连「中间这一趟不进 history、
 * 不进存档」这条都一样：屏幕内容是只对这一轮有意义的东西，进了存档就要在
 * 后面每一轮里重发一遍过期画面（和天气、搜索结果同一个道理，见 env.js 文件头）。
 *
 * ── 互相兜底 ──
 *
 * 用户要求「手机查岗失败时自动改查电脑，电脑查岗失败时自动查岗手机」。
 * 所以 `runSpy` 失败后会自动倒向另一头，一共四种结局，各有一份提示模板：
 *
 *   1. 直接成功        → `SPY_OK_TEMPLATE`
 *   2. 回退之后成功    → `role.spy.fallbackTemplate`（提示模型「你想看的那个
 *                        没看到，这是另一个」，免得它张口就说错设备）
 *   3. 只看了一头、没成 → `role.spy.bothFailedTemplate`，默认文案是
 *                        `DEFAULT_ONE_FAILED_TEMPLATE`（回退关着，或者另一条腿
 *                        的开关是关的 —— 那时候一个字都不许提另一头）
 *   4. 两头都失败      → 同一栏，默认文案是 `DEFAULT_BOTH_FAILED_TEMPLATE`
 *
 * 回退**只走一次**，不来回弹：两头都不通时第二次注定也不通，多打一轮只是让
 * 用户在那头多等十几秒。
 */

import { logDebug, logInfo, logWarn } from "./logs.js";
import { describeImage } from "./llm.js";
import {
  cancelShot,
  createShotRequest,
  phoneConfigProblem,
  sendTriggerMail,
  waitForShot,
} from "./spyphone.js";
import { xmlBlockRanges } from "./websearch.js";

/** 抓一张图最多等多久。截图服务是本机/局域网的，慢成这样基本就是没开。 */
const GRAB_TIMEOUT = 15000;

/**
 * 手机那头最多等多久（毫秒）。
 *
 * 比电脑那头宽得多：这段时间里要走完「SMTP 投递 → iCloud 推送 → 邮件自动化
 * 冷启动 → 截屏 → 转 JPEG → 上传」。参考插件的默认值是 90 秒，实测正常
 * 10–30 秒完成。可以在配置里调，钳在 20–180 秒之间。
 */
const PHONE_WAIT_DEFAULT = 90000;

/**
 * 一张截图最多多大（20MB）。
 *
 * 4K 屏的 JPEG 通常两三 MB，留足余量。设上限是因为这头连的可能是用户填错的
 * 地址，返回体不一定是图 —— 没有上限的话一个流式接口能把内存吃光。
 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** 两个标签。中文写法、全角方括号和全角冒号一律认，理由见 igtags.js 文件头。 */
const PC_TAG = /[[［]\s*查岗(?:实时)?电脑屏幕\s*[\]］]/g;
const PHONE_TAG = /[[［]\s*查岗(?:实时)?手机屏幕\s*[\]］]/g;
/** 两个一起认，用来剥标签和判「这轮要不要查岗」。 */
const ANY_TAG = new RegExp(`${PC_TAG.source}|${PHONE_TAG.source}`, "g");

/** 两头各自的中文名。日志、提示模板、给模型的说明都用这两个词。 */
export const DEVICE_NAMES = { pc: "电脑", phone: "手机" };

/** 谁失败了倒向谁。 */
const OTHER = { pc: "phone", phone: "pc" };

/**
 * 这个角色的两条腿各自开没开。
 *
 * 角色上是两个独立开关（`spy.pcEnabled` / `spy.phoneEnabled`，老配置的单个
 * `enabled` 由 config.js:normalizeSpy 迁过来）。三个地方要问同一个问题 ——
 * 提示词注入哪几行（prompt.js）、这轮要不要真去抓（imessage.js:spyRound）、
 * 失败了能不能倒向另一头（runSpy）—— 所以答案只在这儿算一次。
 *
 * @returns {{pc:boolean, phone:boolean, any:boolean}}
 */
export function spyLegs(role) {
  const spy = role?.spy ?? {};
  const pc = Boolean(spy.pcEnabled);
  const phone = Boolean(spy.phoneEnabled);
  return { pc, phone, any: pc || phone };
}

/**
 * 只开一条腿时，把提示词正文改成「只有这一头」。
 *
 * 三件事：
 *
 *  1. **删掉关着那条腿的行。** 按标签字面量认行 —— 默认正文里 `看电脑:` /
 *     `看手机:` 和「正确示例」下面那两行各自带着自己的标签，一删就干净。
 *     按标签认而不是按 `看电脑:` 这种小标题认，是因为这段正文用户能改：
 *     他把小标题改成别的词，标签本身还是得原样写（不然功能就废了）。
 *  2. **删掉讲自动回退的那行。** 单腿时压根不会倒向另一头（runSpy 拦着），
 *     留着就是一句和事实相反的话。这一条是**尽力而为**的：按默认正文里那句
 *     「自动改看另一头」的措辞认，用户把它改写成别的说法就认不出来了 ——
 *     所以还有下面第 3 条兜底。
 *  3. **在末尾补一句程序生成的话**，点明只有哪一头、不会自动改看另一头。
 *     前两步都是删，删不干净的靠这一句压住：正文里「按你想知道的挑一头……
 *     该在躺着刷手机就看手机」这类话还在，模型凭它硬编一个手机标签是有的
 *     （那种情况 imessage.js:spyRound 会拦下来，但白烧一轮）。补在最后是因为
 *     靠后的指令压得住前面的泛泛之谈。
 *
 * 两条腿都开时原样返回，一个字不动。
 *
 * @param {string} text 子条目正文（已经填过 {{变量}}）
 * @param {{pc:boolean, phone:boolean}} legs spyLegs 的结果
 * @returns {string} 裁过的正文；两条腿都关时返回空串（调用方据此整条跳过）
 */
export function trimSpyPrompt(text, legs) {
  const src = String(text ?? "");
  if (!legs?.pc && !legs?.phone) return "";
  if (legs.pc && legs.phone) return src;

  const only = legs.pc ? "pc" : "phone";
  const goneTag = new RegExp((only === "pc" ? PHONE_TAG : PC_TAG).source);
  // 默认正文里讲自动回退的那句。改过措辞的认不出来，末尾那句补充兜底
  const FALLBACK_LINE = /自动改看另一头|没看到时会自动/;
  const kept = src
    .split("\n")
    .filter((line) => !goneTag.test(line) && !FALLBACK_LINE.test(line))
    .join("\n")
    .trim();
  if (!kept) return "";

  const name = DEVICE_NAMES[only];
  const other = DEVICE_NAMES[OTHER[only]];
  const tag = only === "pc" ? "[查岗实时电脑屏幕]" : "[查岗实时手机屏幕]";
  return (
    `${kept}\n` +
    `        补充: "你现在只能看${name}屏幕。查岗标签只有 ${tag} 这一个，` +
    `别写${other}屏幕那种标签 —— 那一头没开，写了也看不到，` +
    `${name}这头没看到时也不会自动改看${other}。"`
  );
}

/**
 * 识图时给视觉模型的提示词。
 *
 * 和角色自己的识图提示词（那个是用来看**对方发来的图**的）分开：这里要的不是
 * 「描述这张图」，而是「说清楚这个人现在在干什么」—— 查岗真正想知道的是活动，
 * 不是像素。写明「直接描述、不要寒暄」是因为视觉模型很爱先来一句
 * 「这是一张屏幕截图」，那句话进了第二轮提示词纯属噪音。
 */
const SPY_VISION_PROMPT = {
  pc:
    "这是用户此刻的电脑屏幕截图。请直接描述你看到的内容，" +
    "重点说清楚这个人现在大概在做什么：在写代码还是在看视频、" +
    "开着哪些软件、网页或视频的标题是什么、在和谁聊天、在玩什么游戏。" +
    "看得见的文字尽量照实说出来。不要寒暄，不要说「这是一张截图」。",
  phone:
    "这是用户此刻的手机屏幕截图。请直接描述你看到的内容，" +
    "重点说清楚这个人现在大概在做什么：开着哪个 App、" +
    "在刷什么内容、在和谁聊天、屏幕上有什么文字。" +
    "如果是锁屏或桌面，就照实说明并把时间、通知这些细节说出来。" +
    "不要寒暄，不要说「这是一张截图」。",
};

/** 成功那一路给模型的话。`{{device}}` / `{{screen}}` 两个变量。 */
export const SPY_OK_TEMPLATE =
  "<{{device}}屏幕>\n{{screen}}\n</{{device}}屏幕>\n\n" +
  "上面是你刚看到的、{{user}}此刻的{{device}}屏幕内容。现在正式回答对方，" +
  "别再写查岗标签。就当是你自己亲眼看到的，别提「截图」「系统」「工具」这些词，" +
  "也别把上面这段原文抄给对方。";

/** 回退成功那一路。`{{failed}}` 是没看成的那个，`{{device}}` 是实际看到的那个。 */
export const DEFAULT_FALLBACK_TEMPLATE =
  "{{failed}}屏幕这次没看到（{{error}}），但{{device}}屏幕看到了：\n\n" +
  "<{{device}}屏幕>\n{{screen}}\n</{{device}}屏幕>\n\n" +
  "现在正式回答对方，别再写查岗标签。你看到的是{{device}}上的画面，" +
  "别说成{{failed}}。就当是你自己亲眼看到的，别提「截图」「系统」「工具」这些词。";

/**
 * 只看了一头、那一头没看成。
 *
 * 和下面那份「两头都没看到」分开，是因为**只开了一条腿的时候不能提另一头** ——
 * 用户只开电脑查岗，说明他压根不想让角色碰他手机，那句「电脑和手机都没看到」
 * 既是假话，又把一个关着的功能说给了模型听（它会顺着接一句「你手机也没动？」）。
 * 自动回退关着、两条腿都开的情况也走这份：那一轮确实只看了一头。
 *
 * `{{device}}` 是实际看的那头。
 */
export const DEFAULT_ONE_FAILED_TEMPLATE =
  "{{user}}的{{device}}屏幕这次没看到（{{error}}）。" +
  "对方可能不在{{device}}前，或者正忙着、已经睡了。" +
  "现在正式回答对方，别再写查岗标签。**别告诉对方你在查他的屏幕**，" +
  "也别提「截图」「失败」「系统」这些词 —— 就按你的人设正常说话，" +
  "可以顺口问一句在干什么。";

/** 两头都失败。给的是「没看到」这个事实，让模型自己按人设找台词。 */
export const DEFAULT_BOTH_FAILED_TEMPLATE =
  "{{user}}的电脑和手机屏幕这次都没看到（{{error}}）。" +
  "对方可能不在电脑前、手机锁着屏，或者正忙着、已经睡了。" +
  "现在正式回答对方，别再写查岗标签。**别告诉对方你在查他的屏幕**，" +
  "也别提「截图」「失败」「系统」这些词 —— 就按你的人设正常说话，" +
  "可以顺口问一句在干什么。";

/** 把 `{{x}}` 换成值。留着没给值的变量不动，和 igrun.js:markFor 一个路子。 */
function fill(template, vars) {
  let out = String(template ?? "");
  for (const [k, v] of Object.entries(vars)) {
    out = out.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, "g"), String(v ?? ""));
  }
  return out;
}

/** 这段文字里，`re` 在 xml 块之外命中过没有（`<thinking>` 里复述格式不算）。 */
function matchesOutsideXml(text, re) {
  const src = String(text ?? "");
  if (!src) return false;
  const ranges = xmlBlockRanges(src);
  for (const m of src.matchAll(re)) {
    if (!ranges.some(([a, b]) => m.index >= a && m.index < b)) return true;
  }
  return false;
}

/**
 * 这轮模型要查哪一头？两个都写了按**先出现**的算。
 *
 * 只查一头是刻意的：两头都查要打两次识图、等两趟网络，而查岗的用处是
 * 「现在在干什么」—— 一个屏幕就够回答了。而且回退机制已经保证「这一头
 * 不通就看另一头」，模型想全都看到的需求本来就被覆盖了。
 *
 * @returns {"pc"|"phone"|null} 不查岗时返回 null
 */
export function spyTargetIn(text) {
  const src = String(text ?? "");
  if (!src) return null;
  const ranges = xmlBlockRanges(src);
  const outside = (m) => !ranges.some(([a, b]) => m.index >= a && m.index < b);

  let best = null;
  for (const [kind, re] of [
    ["pc", new RegExp(PC_TAG.source, "g")],
    ["phone", new RegExp(PHONE_TAG.source, "g")],
  ]) {
    for (const m of src.matchAll(re)) {
      if (!outside(m)) continue;
      if (best === null || m.index < best.at) best = { kind, at: m.index };
      break;
    }
  }
  return best?.kind ?? null;
}

/** 有没有查岗标签。 */
export function hasSpyTag(text) {
  return matchesOutsideXml(text, new RegExp(ANY_TAG.source, "g"));
}

/**
 * 去掉查岗标签，只留文字。
 *
 * 和 stripSearchTags 一样只在**发给对方**那一路上用 —— 内存历史、落盘存档、
 * 「上下文」面板里都该看得见模型的原文（用户明确要求过「使用功能的时候
 * 不要过滤任何标签」）。
 */
export function stripSpyTags(text) {
  const src = String(text ?? "");
  if (!src) return "";
  const ranges = xmlBlockRanges(src);
  let out = "";
  let cursor = 0;
  for (const m of src.matchAll(new RegExp(ANY_TAG.source, "g"))) {
    if (ranges.some(([a, b]) => m.index >= a && m.index < b)) continue;
    out += src.slice(cursor, m.index);
    cursor = m.index + m[0].length;
  }
  out += src.slice(cursor);
  return out.trim();
}

/**
 * 一头的地址。`base` 用户填的可能是 `127.0.0.1:6878`、
 * `http://127.0.0.1:6878` 或者带路径的完整 URL，都得认。
 *
 * 没写路径时补 `/screenshot` —— 那是截图服务的约定端点。
 */
function urlFor(base) {
  const raw = String(base ?? "").trim();
  if (!raw) return "";
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const u = new URL(withScheme);
    if (u.pathname === "" || u.pathname === "/") u.pathname = "/screenshot";
    return u.toString();
  } catch {
    return "";
  }
}

/**
 * 抓失败时给人看的原因。措辞要能让用户看出下一步该查什么。
 *
 * **得往 cause 里挖。** `fetch` 连不上时抛的是一个 message 只有 `fetch failed`
 * 的 TypeError，真正有用的 `ECONNREFUSED` 埋在 `e.cause.code` 里（undici 的
 * 行为）；超时那条又是 cause 本身带 name。两层都看，而且**挖不出来时不能
 * 回落到 e.message** —— 那样用户看到的就是「fetch failed」，等于没说。
 */
function whyGrab(e) {
  const cause = e?.cause;
  const code = e?.code || cause?.code || "";
  const name = e?.name || cause?.name || "";

  if (name === "AbortError" || name === "TimeoutError" || code === "ABORT_ERR") {
    return `超过 ${Math.round(GRAB_TIMEOUT / 1000)} 秒没响应`;
  }
  if (code === "ECONNREFUSED") return "截图服务没在运行";
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return "网络不通";
  if (code === "ETIMEDOUT") return "连接超时";
  if (code === "ENOTFOUND") return "地址解析不了";
  if (code === "ECONNRESET") return "连接被截图服务掐断了";
  if (code === "CERT_HAS_EXPIRED" || code === "ERR_TLS_CERT_ALTNAME_INVALID") {
    return "证书不对（截图服务一般走 http，别写 https）";
  }

  // 认不出来的：宁可报 code 也别报「fetch failed」，那句话对排障毫无帮助
  const msg = String(e?.message ?? "");
  if (code) return `连不上（${code}）`;
  return msg && msg !== "fetch failed" ? msg : "连不上（地址填错或者服务没开）";
}

/**
 * 电脑那头：拉一张图回来。
 *
 * @returns {Promise<{base64:string, mimeType:string}>}
 * @throws {Error} 抓不到（地址没配、连不上、返回的不是图、图太大）
 */
async function grabPc(base, kind = "pc") {
  const url = urlFor(base);
  if (!url) throw new Error("截图地址没配");

  logDebug("查岗", `正在抓${DEVICE_NAMES[kind]}屏幕：${url}`);

  /*
   * 这条**不走代理**，而且「代理」那一节里刻意没有查岗这一类。
   *
   * 抓的是用户自己那台电脑上跑的截图服务，地址基本都是 `192.168.x.x` 或者
   * `127.0.0.1`（见 urlFor 的默认端口）。局域网地址交给机场代理只有一种结果：
   * 代理那头连不上，本来好的功能反而坏了。真要抓一台公网上的机器，也是直连
   * 就能到 —— 需要代理的是「出国」，不是「出局域网」。
   */
  let resp;
  try {
    resp = await fetch(url, {
      signal: AbortSignal.timeout(GRAB_TIMEOUT),
      // 截图服务不带鉴权，但有些会看 UA 判断是不是浏览器
      headers: { Accept: "image/*,*/*" },
    });
  } catch (e) {
    throw new Error(whyGrab(e));
  }

  if (!resp.ok) throw new Error(`截图服务返回 ${resp.status}`);

  /*
   * Content-Length 先挡一道 —— 有的话就不用把整个响应读进来才发现太大。
   * 没有这个头（chunked）时下面读完再量一次。
   */
  const claimed = Number(resp.headers.get("content-length") ?? 0);
  if (claimed > MAX_IMAGE_BYTES) {
    throw new Error(`截图太大（${Math.round(claimed / 1024 / 1024)}MB）`);
  }

  const buf = Buffer.from(await resp.arrayBuffer());
  if (!buf.length) throw new Error("截图服务返回了空内容");
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new Error(`截图太大（${Math.round(buf.length / 1024 / 1024)}MB）`);
  }

  /*
   * 真的是张图吗。用户把地址填成别的服务时，返回的多半是一段 HTML 或 JSON ——
   * 那玩意儿送进视觉模型只会换回一句「我看不出这是什么」，白烧一次识图钱。
   * 认魔数不认 Content-Type：截图服务的头不一定写对。
   */
  const mimeType = sniffImage(buf);
  if (!mimeType) throw new Error("返回的不是图片（地址可能填错了）");

  logDebug(
    "查岗",
    `${DEVICE_NAMES[kind]}屏幕抓到了，约 ${Math.round(buf.length / 1024)}KB（${mimeType}）`
  );
  return { base64: buf.toString("base64"), mimeType };
}

/**
 * 手机那头：发触发邮件，等 iPhone 把截图 POST 回来。
 *
 * **先挂等待条目再发邮件**。反过来的话，网络快的时候图可能比条目先到，
 * 那张图会因为「没有待处理请求」被丢掉，然后这边一直等到超时。
 *
 * @param {object} api 全局那份 spyApi（SMTP 凭据 + 校验密钥 + 等待时长）
 * @returns {Promise<{base64:string, mimeType:string}>}
 * @throws {Error} 配置不全、邮件发不出去、等超时、回来的不是图
 */
async function grabPhone(api) {
  const problem = phoneConfigProblem(api);
  if (problem) throw new Error(problem);

  const waitMs = clampWait(api?.waitSeconds);
  const id = createShotRequest("手机屏幕");

  try {
    await sendTriggerMail(api);
  } catch (e) {
    // 邮件都没发出去，没必要让条目在队列里占着位等超时
    cancelShot(id);
    throw e;
  }

  logDebug("查岗", `触发邮件发出去了，最多等 ${Math.round(waitMs / 1000)} 秒`);
  const buf = await waitForShot(id, waitMs);

  if (!buf.length) throw new Error("手机传回来的是空内容");
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new Error(`手机截图太大（${Math.round(buf.length / 1024 / 1024)}MB）`);
  }
  const mimeType = sniffImage(buf);
  if (!mimeType) throw new Error("手机传回来的不是图片（检查快捷指令里的转换图像那步）");

  logDebug(
    "查岗",
    `手机屏幕拿到了，约 ${Math.round(buf.length / 1024)}KB（${mimeType}）`
  );
  return { base64: buf.toString("base64"), mimeType };
}

/** 手机等多久，钳在 20–180 秒。填空或填得离谱都用默认的 90 秒。 */
function clampWait(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return PHONE_WAIT_DEFAULT;
  return Math.min(180, Math.max(20, Math.round(n))) * 1000;
}

/** 认图片魔数。和 media.js:sniffImageType 同一套，这里只要这四种。 */
function sniffImage(buf) {
  if (buf.length < 12) return "";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.toString("latin1", 0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") {
    return "image/webp";
  }
  if (buf.toString("latin1", 0, 3) === "GIF") return "image/gif";
  return "";
}

/**
 * 查一头：抓图 + 识图。
 *
 * @returns {Promise<{ok:true, screen:string}|{ok:false, error:string}>}
 *          从不抛错 —— 调用方要靠返回值决定倒不倒向另一头
 */
async function lookAt(kind, { role, eps, spyApi, scope }) {
  const name = DEVICE_NAMES[kind];

  /*
   * 先把「没开识图模型」这一道挡在抓图之前。
   *
   * 顺序有讲究：手机那头抓一次要发一封邮件、把用户手机唤起来截一张屏、等上
   * 十几秒 —— 全都做完了才发现没模型可看，那是白折腾用户一趟。电脑那头顺带
   * 也省一次请求。
   */
  if (!eps?.vision) {
    logWarn(scope, `${name}查岗没做：这个角色没开识图模型，抓回来也看不出内容`);
    return { ok: false, error: "没开识图模型" };
  }

  let image;
  try {
    image =
      kind === "pc" ? await grabPc(role?.spy?.pcUrl, "pc") : await grabPhone(spyApi);
  } catch (e) {
    logWarn(scope, `${name}查岗没抓到屏幕：${e.message}`);
    return { ok: false, error: e.message };
  }

  /*
   * 识图走角色自己选的识图模型（eps.vision，上面已经确认有了）。
   *
   * 复用它而不是另给查岗配一个：那条线本来就是「把图看成文字」，
   * 用户已经在角色里选好了模型，再多一份配置只会出现两边选了不同模型、
   * 用户以为改了其实没生效的情况。
   *
   * 提示词**不复用** eps.visionPrompt —— 那个是用来看对方发来的图的，
   * 查岗要问的是「这个人在干什么」，见 SPY_VISION_PROMPT。
   */
  try {
    const screen = await describeImage(eps.vision, SPY_VISION_PROMPT[kind], {
      ...image,
      name: `${name}屏幕`,
    });
    logInfo(scope, `${name}查岗成功，识图 ${screen.length} 字`, screen);
    return { ok: true, screen };
  } catch (e) {
    logWarn(scope, `${name}查岗抓到了屏幕，但识图失败：${e.message}`);
    return { ok: false, error: `识图失败（${e.message}）` };
  }
}

/**
 * 查岗那一趟：查模型要的那头，不成就倒向另一头。
 *
 * @param {"pc"|"phone"} want 模型想看哪头（spyTargetIn 的结果）
 * @param {object} ctx
 * @param {object} ctx.role   当前角色（要 role.spy 那几个字段）
 * @param {object} ctx.eps    这个角色解析好的几条线（要 eps.vision）
 * @param {object} ctx.spyApi 全局那份 spyApi（手机那条腿的 SMTP 凭据等）
 * @param {string} ctx.userName 对方的名字，填模板里的 `{{user}}`
 * @param {string} ctx.scope  日志作用域
 * @returns {Promise<string>} 接在第一次回复后面、要当 user 消息问回去的那段话
 *
 * 调用方（imessage.js:spyRound）保证 `want` 那条腿的开关是开着的。回退那一步
 * 这儿自己再查一次另一条腿 —— 用户只开了电脑腿的话，「电脑没看到」不该变成
 * 「那就去把他手机唤起来」。
 */
export async function runSpy(want, { role, eps, spyApi, userName, scope }) {
  const spy = role?.spy ?? {};
  const legs = spyLegs(role);
  const first = await lookAt(want, { role, eps, spyApi, scope });

  if (first.ok) {
    return fill(SPY_OK_TEMPLATE, {
      device: DEVICE_NAMES[want],
      screen: first.screen,
      user: userName || "对方",
    });
  }

  /*
   * 倒向另一头。
   *
   * 两种情况不倒，都直接收尾、不白打第二次网络。措辞里的 error 用第一次那个原因。
   *
   *  1. 用户关了自动回退。
   *  2. **另一条腿的开关是关的。** 这道检查比第一条更要紧：用户只开电脑腿
   *     就是在说「别动我手机」，一次抓图失败不该成为把他手机唤起来的理由。
   *
   * 这一路给的是 DEFAULT_ONE_FAILED_TEMPLATE 而不是「两头都没看到」那份 ——
   * 这轮确实只看了一头，说成两头是假话，而且只开一条腿时那句话会把关着的
   * 那条腿说给模型听。用户自己填过模板就照他的（界面上这一栏在单腿模式下
   * 的标题就是「没看到时」）。
   */
  const other = OTHER[want];
  if (!spy.autoFallback || !legs[other]) {
    const why = legs[other] ? "自动回退是关的" : `${DEVICE_NAMES[other]}查岗的开关是关的`;
    logInfo(scope, `${DEVICE_NAMES[want]}查岗没成，${why}，这轮就不看了`);
    return fill(spy.bothFailedTemplate || DEFAULT_ONE_FAILED_TEMPLATE, {
      device: DEVICE_NAMES[want],
      error: first.error,
      user: userName || "对方",
    });
  }

  logInfo(
    scope,
    `${DEVICE_NAMES[want]}查岗没成（${first.error}），自动改查${DEVICE_NAMES[other]}`
  );
  const second = await lookAt(other, { role, eps, spyApi, scope });

  if (second.ok) {
    return fill(spy.fallbackTemplate || DEFAULT_FALLBACK_TEMPLATE, {
      failed: DEVICE_NAMES[want],
      device: DEVICE_NAMES[other],
      screen: second.screen,
      error: first.error,
      user: userName || "对方",
    });
  }

  logWarn(
    scope,
    `两头都没看到 —— ${DEVICE_NAMES[want]}：${first.error}；` +
      `${DEVICE_NAMES[other]}：${second.error}`
  );
  return fill(spy.bothFailedTemplate || DEFAULT_BOTH_FAILED_TEMPLATE, {
    // 同一栏的模板两条路都在用（单腿那路在上面），用户要是在里面写了
    // {{device}}，这儿给它一个说得通的值，别让占位符原样漏进提示词
    device: `${DEVICE_NAMES[want]}和${DEVICE_NAMES[other]}`,
    // 两个原因都给模型，它按人设挑一个说（或者干脆都不说）
    error: `${DEVICE_NAMES[want]}${first.error}，${DEVICE_NAMES[other]}${second.error}`,
    user: userName || "对方",
  });
}
