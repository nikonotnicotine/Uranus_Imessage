/**
 * 线下模式：一轮剧情生成 + 两级总结 + 结束时归档进记忆库。
 *
 * 这是**和 iMessage 那条链并行的第二条生成链**。区别不是「多几个开关」，
 * 而是整条链换了一套东西：自己的预设（`mode: "offline"`）、自己的世界书书单
 * （`role.offline.worldBookRefs`）、自己的 API、自己的存档（`data/offline/`）、
 * 自己的总结节奏。用户的原话是「线下模式开启后会自动关闭掉当前角色线上所有
 * 功能（包括主动消息与消息格式与功能等内容），保持真实性」。
 *
 * **这个文件不 import `imessage.js`**，和 `promptmode.js` / `commands.js` /
 * `proactive.js` / `assistant.js` 一样 —— 那边要调这边（消息循环里拦一手），
 * 这边再反过来 import 就成环了。要让 iMessage 干活（发气泡）就靠返回值，
 * 由 `imessage.js` 自己去发。记提示词走 `lastprompt.js`（当初就是为了这条链
 * 才把 `notePrompt` 从 `imessage.js` 里搬出来的）。
 *
 * 网页上的「线下模式」分区和 iMessage 里的线下模式**跑的是同一条链、同一份存档**，
 * 所以在手机上发 `/开启线下` 起的头，能在浏览器里接着演。
 *
 * 三个刻意的取舍：
 *
 *  - **生成参数用预设里的那一份**（`built.params`），不像协助模式那样传 `{}`。
 *    协助模式图的是稳（诊断要可复现），线下剧情图的是有变化。
 *  - **存档里存模型原文**，两份都在出口现算：发给人看的那份过 `toUser`，
 *    发给模型的那份过 `toHistory`（在 `prompt.js:filterHistory`，拼提示词时才跑）。
 *    用户拿正则渲染 HTML 状态栏正是 `toUser` 那一路 —— 那堆 `<div>` 绝对不能
 *    进上下文，否则模型下一轮会开始模仿自己吐 HTML，所以过滤照旧要做，只是
 *    挪到了拼提示词那一刻（和 `imessage.js` 那条链同一个做法）。
 *
 *    以前这儿存的是过完 `toHistory` 的那份，后果是**状态栏只能看一次**：
 *    `不对Ai发送多余内容` 那类删除规则会把 `<状态面板>` 整段从存档里剥掉，
 *    重新打开剧情时 `toUser` 再宽容也没有原料可抓，那一栏就永远空着。
 *    存原文之后「改了渲染正则整条剧情立刻跟着变」才真正成立。
 *  - **总结失败不影响这一轮**。剧情正文已经落盘了，总结只是附加动作。
 *    这跟记忆库那条铁律是一个意思：宁可总结晚一点，也绝不弄丢正文。
 */

import { applyVars, resolveEndpoint, resolveRoleEndpoints, resolveUser } from "./config.js";
import { buildEnv } from "./env.js";
import { notePrompt } from "./lastprompt.js";
import { chatCompletion, chatWithFallback } from "./llm.js";
import { logError, logInfo, logWarn } from "./logs.js";
import {
  SUMMARY_PARAMS,
  SUMMARY_REFUSAL_RETRIES,
  SUMMARY_TIMEOUT,
  pendingText,
  summaryMessages,
} from "./memory.js";
import { appendPending, memoryKeyFor } from "./memorystore.js";
import {
  CHOICE_COUNT,
  appendSummary,
  appendTurn,
  closeOffline,
  currentStory,
  dropLastAssistant,
  endStory,
  isOfflineOn,
  readIndex,
  readStory,
  setCurrent,
} from "./offlinestore.js";
import { presetLabel, resolvePreset } from "./preset.js";
import { buildPrompt, wrap } from "./prompt.js";
import { applyAndLog, applyRules } from "./regex.js";

const SCOPE = "线下模式";

/**
 * 喂给总结的材料上限。
 *
 * 比记忆库那条链的默认值（4000）大得多：一份小总结要读六轮剧情正文，
 * 而线下一轮动辄上千字，4000 字连两轮都装不下。超了取尾巴（`pendingText`
 * 按整行对齐地截），越靠近现在的越该被总结进去。
 */
const MAX_SUMMARY_INPUT = 40000;

/** 「[名字] 正文」这一行的写法，和记忆库流水看起来是一路货，模型读着不别扭。 */
function turnLine(turn, charName, userName) {
  const who = turn.role === "user" ? userName || "对方" : charName || "角色";
  return `[${who}] ${turn.content}`;
}

/**
 * 总结材料。
 *
 * 助手那侧先过一遍 `toHistory` —— 存档里现在是模型原文（含 `<状态面板>` 那
 * 几千字），原样喂给总结等于让它去读一堆坐标和服装字段，还白烧 token。
 * 走的是和拼提示词同一套规则，所以「模型看不见的东西」在总结里也看不见。
 */
function turnsText(turns, charName, userName, rules = [], vars = {}) {
  const clean = turns.map((t) =>
    t.role === "assistant" && rules.length
      ? {
          ...t,
          content: applyRules(t.content, rules, {
            target: "aiOutput",
            field: "toHistory",
            vars,
          }).text,
        }
      : t
  );
  return pendingText(
    clean
      .filter((t) => String(t.content ?? "").trim())
      .map((t) => turnLine(t, charName, userName))
      .join("\n\n"),
    MAX_SUMMARY_INPUT
  );
}

/**
 * 小总结的提示词。
 *
 * 写死在这儿、不做成配置项：用户点名要配的是**轮数和模型**，没提要改这段话。
 * 多一个能填错的输入框，就多一种「总结出来是空的」的报障。
 *
 * 也**不注入世界书** —— 材料本身就是刚刚演过的正文，世界书只会把输入撑大、
 * 把真正要概括的内容挤到截断线外面去。
 */
const SMALL_PROMPT = [
  "下面是 {{user}} 和 {{char}} 刚刚线下相处的一段经过。",
  "把它概括成一段**给 {{char}} 自己留着的记录**，之后要当记忆用。",
  "",
  "要求：",
  "- 只写真的发生过的事：谁做了什么、说定了什么、关系和心情有什么变化。",
  "- 时间、地点、在场的人、身上的伤和衣着这类会延续到下一次的细节要留住。",
  "- 用第三人称叙述，别写「总结如下」这种开场，直接从事情写起。",
  "- 一段到三段，别分点。没发生的不要补，不确定的不要猜。",
].join("\n");

/**
 * 大总结的提示词。材料是若干份小总结 —— 它是「把几段浓缩成一段」，
 * 不是「再读一遍正文」，所以规矩里要特意说一句别丢掉时间线。
 */
const BIG_PROMPT = [
  "下面是 {{user}} 和 {{char}} 这段线下剧情的几份分段记录，按先后顺序排列。",
  "把它们合并成一份**整段剧情的记录**，之后要当记忆用。",
  "",
  "要求：",
  "- 保住先后顺序和因果：先发生什么、后来怎么变的。",
  "- 留住会延续下去的结果（说定的事、关系的变化、还没了结的事）。",
  "- 重复的话合并，细枝末节可以省，但别把某一段整个丢掉。",
  "- 用第三人称叙述，直接从事情写起。三段以内。",
].join("\n");

/* ================= 端点 ================= */

function refUsable(ref) {
  return Boolean(ref?.provider && ref?.modelId);
}

/**
 * 这一轮剧情用哪个模型。
 *
 * 顺序：角色的线下 API → 角色的聊天模型。用户可以「单独选择线下模式 API」，
 * 没选就跟着线上那个走 —— 不然刚打开线下模式会一句话都发不出来。
 *
 * 线下 API 选过、但引用已经失效（服务商或模型被删/被关）时**退回聊天模型并
 * 记一条 warn**：静默换模型不好，但让整条剧情发不出去更糟，而日志里说清了
 * 是哪一种情况。
 */
function offlineEndpoint(config, role) {
  const eps = resolveRoleEndpoints(config, role);
  const ref = role?.offline?.model;
  if (refUsable(ref)) {
    const own = resolveEndpoint(config, ref);
    if (own) return { endpoint: own, fallback: eps.fallback };
    logWarn(SCOPE, "线下 API 选的模型引用失效了（服务商或模型被删/被关），这轮用角色的聊天模型");
  }
  return { endpoint: eps.chat, fallback: eps.fallback };
}

/** 两份总结各自的模型。没单独选就用这一轮剧情的那个。 */
function summaryEndpoint(config, role, kind, base) {
  const ref = kind === "big" ? role?.offline?.bigModel : role?.offline?.smallModel;
  if (refUsable(ref)) {
    const own = resolveEndpoint(config, ref);
    if (own) return own;
    logWarn(SCOPE, `${kind === "big" ? "大" : "小"}总结选的模型引用失效了，这次用线下主模型`);
  }
  return base;
}

/* ================= 用户选项 ================= */

/**
 * 这一轮要不要选项。
 *
 * 两道闸都得开：角色那边的总开关（用户要的「是否开启用户选项：默认为关」），
 * 加上预设里那条【用户选项】自己开着。这是这套程序里现成的做法 ——
 * 「消息格式与功能」那十一个子条目也都压着角色那一侧的开关
 * （见 `prompt.js:formatBlock`）：预设说「怎么写」，角色说「开不开」。
 */
function choicesOn(role, preset) {
  if (!role?.offline?.userChoice) return false;
  return Boolean(preset?.entries?.find((e) => e.kind === "userChoice")?.enabled);
}

const CHOICE_OPEN = /<\s*选项\s*>/;
const CHOICE_CLOSE = /<\s*\/\s*选项\s*>/;
/** 行首的序号或短横线：`1.` `1、` `1)` `-` `*` `•` 都算。 */
const BULLET = /^\s*(?:[（(]?\d+[.)、．]?|[-*•—])\s*/;

/**
 * 把模型这一轮的输出切成「正文」和「四条选项」。
 *
 * 只在用户选项开着的时候才调（见 `choicesOn`）—— 关着的时候剧情正文里
 * 本来就可能有编号列表（「他掏出三样东西：1. …」），拿这套规则去切会把
 * 正文末尾吃掉。
 *
 * 两种认法，先严后松：
 *  1. `<选项>…</选项>`。预设默认正文（`preset.js:DEFAULT_USER_CHOICE`）
 *     要求的就是这对标记，有它就一刀两断，不用猜。
 *  2. 没有标记时，看**结尾**那一串连续的带序号的行。用户改预设正文时很容易
 *     把标记那句话删掉，为这个留一条退路。
 *
 * 一条都摘不到就 `{body: 原文, options: []}` —— 选项没吐出来不该让整轮失败，
 * 那是「这次没选项」，不是「这次没回复」。
 */
export function splitChoices(text) {
  const raw = String(text ?? "");
  const open = raw.search(CHOICE_OPEN);

  if (open >= 0) {
    const rest = raw.slice(open).replace(CHOICE_OPEN, "");
    const close = rest.search(CHOICE_CLOSE);
    const inner = close >= 0 ? rest.slice(0, close) : rest;
    const options = inner
      .split(/\r?\n/)
      .map((l) => l.replace(BULLET, "").trim())
      .filter(Boolean)
      .slice(0, CHOICE_COUNT);
    // 标记后面还有话（模型偶尔在 </选项> 之后又补一句）就并回正文
    const tail = close >= 0 ? rest.slice(close).replace(CHOICE_CLOSE, "") : "";
    const body = `${raw.slice(0, open)}\n${tail}`.trim();
    return { body, options };
  }

  const lines = raw.split(/\r?\n/);
  const picked = [];
  let cut = lines.length;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.trim()) {
      // 空行：选项块到头了。再往上就是正文
      if (picked.length) break;
      cut = i;
      continue;
    }
    if (!BULLET.test(line)) break;
    picked.unshift(line.replace(BULLET, "").trim());
    cut = i;
    if (picked.length >= CHOICE_COUNT) break;
  }

  // 只有一条的时候不算选项块 —— 正文最后一行正好以「-」开头太常见了。
  // 也不能把整段回复都当成选项（正文空了等于这轮白跑）
  if (picked.length < 2 || cut === 0) return { body: raw.trim(), options: [] };
  return { body: lines.slice(0, cut).join("\n").trim(), options: picked };
}

/* ================= 出口：给人看的那一份 ================= */

/**
 * 把存档里的一条剧情算成「界面上那一份」。
 *
 * 每条助手轮次多一个 `display` —— 存档里那份（`content`）过的是 `toHistory`，
 * 这里再拿 `toUser` 现算一遍。所以用户改了渲染 HTML 的那条正则，整段剧情
 * 立刻跟着变，不用回去重写存档（见文件头第二条取舍）。
 *
 * 用户那一侧不动：`aiOutput` 那一路规则跟他打的字没关系。
 *
 * 顺带把「这个角色现在要不要显示选项」一起算好（`choices`）—— 那是两道闸
 * （角色开关 + 预设条目）的结果，让前端自己再推一遍就多一处会分叉的规则。
 *
 * `folded` 同理：哪几轮因为超出上下文上限被总结顶掉了，由这边算完告诉前端。
 * 让前端拿 `maxContext` 自己推一遍，就等于把「切点落在总结边界上」那套规则
 * 抄第二份 —— 两份一分叉，界面上折起来的和真正没发出去的就不是同一批。
 *
 * @returns {{story: object, choices: boolean, presetName: string, folded: object}}
 */
export function storyForView(config, role, story) {
  const preset = resolvePreset(config, role, "offline");
  const user = resolveUser(config, role);
  const vars = {
    char: role?.name ?? "",
    user: user?.name ?? "",
    sep: config?.chat?.separator ?? "",
  };
  const turns = (story?.turns ?? []).map((t) =>
    t.role === "assistant"
      ? {
          ...t,
          // trim 跟 runTurn 那边保持一致 —— 剥 <content> 会留下一个行首空行，
          // 一边 trim 一边不 trim 的话，同一条气泡刷新前后长得不一样
          display: applyRules(t.content, preset.regex, {
            target: "aiOutput",
            field: "toUser",
            vars,
          }).text.trim(),
        }
      : { ...t, display: t.content }
  );
  const cut = offlineCut(story, role);
  return {
    story: { ...story, turns },
    choices: choicesOn(role, preset),
    presetName: presetLabel(preset),
    /*
     * 折起来的那截。三个字段各有用处：
     *   - `count` 是**消息条数**，前端拿它切数组；
     *   - `rounds` 是**轮数**（角色开口几次），给人看的那行文案用它 ——
     *     用户在设置里填的是「轮」，界面上报条数会对不上；
     *   - `text` 是顶替它们的总结正文，展开时直接给人看「模型这轮读到的是什么」。
     */
    folded: {
      count: cut.at,
      rounds: assistantCount((story?.turns ?? []).slice(0, cut.at)),
      text: cut.text,
    },
  };
}

/* ================= 上下文上限 ================= */

/**
 * 盖住 `[0, at)` 这段轮次的总结正文。**大的优先**。
 *
 * 用户的原话是「有小总结用小总结有大总结用大总结」：同一段两边都盖到时用大的
 * 更省 token，大的没盖到的那截再拿小的补上。所以是从头往后走，每一步先找能盖住
 * 当前位置的大总结（取伸得最远的那份），找不到再退回小总结。
 *
 * 返回的 `to` 是**实际**盖到第几轮。中间断了一截（用户手删过总结）就停在断口，
 * 由调用方把切点缩回来 —— 宁可多发几轮原文，也绝不让哪几轮既不在总结里
 * 又不在原文里。
 */
function summaryCover(story, at) {
  const list = (story?.summaries ?? []).filter((s) => s.text?.trim() && s.to <= at);
  const texts = [];
  let p = 0;
  while (p < at) {
    const pick = (kind) =>
      list
        .filter((s) => s.kind === kind && s.from <= p && s.to > p)
        .sort((a, b) => b.to - a.to)[0] ?? null;
    const one = pick("big") ?? pick("small");
    if (!one) break;
    texts.push(one.text.trim());
    p = one.to;
  }
  return { text: texts.join("\n\n"), to: p };
}

/**
 * 这条剧情的前几轮该折起来换成总结吗，该折到第几轮。
 *
 * `role.offline.maxContext` 是**轮**数（默认 6 轮 = 12 条消息），0 = 不限制。
 * 一轮按「角色开口一次」算，和 `smallEvery` 同一个口径；隐藏的轮次不计数
 * ——它本来就不进上下文，算上它等于偷偷把上限调小。
 *
 * 切点**只落在总结边界上**，这是这个函数里唯一要紧的规则：
 *
 *  - 往回找不超过「至少要留的那截」的最后一个边界，所以实际发出去的原文在
 *    `maxContext` 到 `maxContext + smallEvery` 轮之间浮动；
 *  - 于是同一段绝不会既在总结里又在原文里（那是白烧两遍 token），
 *    也绝不会有哪几轮既没进总结又被丢掉（那是剧情凭空消失）。
 *
 * 一份总结都还没出的时候返回 `{at: 0}` —— 宁可这一轮超出上限，也不能把还没
 * 被总结过的剧情扔了。
 *
 * @returns {{at: number, text: string}} `at` = 原文从第几轮开始发，`text` = 顶上那段总结
 */
export function offlineCut(story, role) {
  const none = { at: 0, text: "" };
  const limit = Number(role?.offline?.maxContext ?? 6);
  const turns = story?.turns ?? [];
  if (!Number.isFinite(limit) || limit <= 0 || !turns.length) return none;

  // 从末尾往前数够 limit 轮，多出来的那一轮开头就是「最多能切到哪」
  let want = 0;
  let seen = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const t = turns[i];
    if (t.role === "assistant" && !t.hidden && t.content?.trim()) seen += 1;
    if (seen > limit) {
      want = i + 1;
      break;
    }
  }
  if (!want) return none;

  const bounds = (story.summaries ?? [])
    .filter((s) => s.text?.trim() && s.to <= want)
    .map((s) => s.to);
  if (!bounds.length) return none;

  const cover = summaryCover(story, Math.max(...bounds));
  return cover.to > 0 && cover.text ? { at: cover.to, text: cover.text } : none;
}

/* ================= 一轮剧情 ================= */

/**
 * 存档里的轮次 → 发给模型的上文。
 *
 * 两处要扣掉的：用户点了「隐藏回复」的那些（`hidden`），和超出上下文上限、
 * 已经被总结盖住的开头那截（`offlineCut`）。后者不是凭空删掉 —— 顶上会补一条
 * `<剧情前情>`，里面是那段的总结正文，所以剧情记得住、token 又省下来了。
 *
 * 那条补出来的是 `system`：`filterHistory` 只对 assistant 跑正则，system 原样
 * 穿过去，正好。它落在 `<Chat_History>` 里面，紧贴着第一条原文。
 */
function historyOf(story, role) {
  const cut = offlineCut(story, role);
  const out = [];
  if (cut.text) out.push({ role: "system", content: wrap("剧情前情", cut.text) });
  for (const t of story.turns.slice(cut.at)) {
    if (t.hidden || !t.content.trim()) continue;
    out.push({ role: t.role, content: t.content });
  }
  return out;
}

/**
 * 演一轮。
 *
 * 顺序是**先把用户那句落盘，再去生成** —— 和 `runAssistTurn` 的「先落表再发」
 * 同一个道理，但这里还多一层好处：生成失败的时候用户那句话还在剧情里，
 * 点一下「重 roll」就能重来，不用重打一遍。
 *
 * @param {object} config 完整配置
 * @param {object} role 当前角色
 * @param {object|null} user 生效的用户人设
 * @param {object} opts
 * @param {string} [opts.text] 用户这一轮说的话
 * @param {number} [opts.choiceIndex] 点的是上一轮第几条选项（1 起）。
 *        给了这个就不用再传 text —— 网页上点「直接发送」走的是这条
 * @param {string} [opts.storyId] 演哪一条剧情。给了且和当前那条不同就先切过去
 * @param {boolean} [opts.reroll] 重 roll：删掉末尾的助手轮次，按同一份上文再生成
 * @param {AbortSignal} [opts.signal] 用户按「停下」用的。中止时上游那个 fetch
 *        当场断开，抛出来的错带 `aborted = true`；**用户那句已经落盘了**，
 *        所以点一下「再来一次」就能按同一份上文重来
 * @param {(text: string) => void} [opts.onDelta] 有它就按流式生成，每收到一小块
 *        正文调一次。**只影响「边生成边看」**：落盘、正则、摘选项那几步和非流式
 *        一模一样（存档存的照旧是模型原文）。是不是要传由路由层按
 *        `config.stream.mode` 决定 —— 这个函数不读那份配置
 * @param {() => void} [opts.onRestart] 换到副 API 之前调一次，让前端把已经显示
 *        出来的半截清掉（副 API 会从头再说一遍）
 * @returns {Promise<{turn: object, display: string, options: string[],
 *   story: object, usedFallback: boolean, summary: object|null}>}
 *   `display` 是过了 `toUser` 正则的那份（发气泡 / 网页上显示用），
 *   `turn.content` 是存档里那份 —— **模型原文**，`toHistory` 留到拼提示词时才跑
 * @throws {Error} 没有在演的剧情、没配模型、模型返回空、两条 API 都挂 —— 都抛
 */
export async function runOfflineTurn(config, role, user, opts = {}) {
  const roleKey = memoryKeyFor(role);
  const {
    text = "",
    choiceIndex = 0,
    storyId = "",
    reroll = false,
    signal = undefined,
    onDelta = undefined,
    onRestart = undefined,
  } = opts ?? {};

  /*
   * 开着才演。
   *
   * 「有在演的剧情」和「线下开着」**不是一件事** —— `closeOffline` 故意留着
   * `currentId`（关了再开要接着演同一条）。所以光判有没有剧情的话，关掉之后
   * 照样能生成。
   *
   * 这道闸真正挡的是**排在队列里的那几轮**：iMessage 那头连发三条，
   * `chain(runner, spaceId, …)` 一条一条来，用户在网页上按了「结束线下」
   * 之后，剩下那两条的入口早就过了（消息循环那道闸在入队之前）。不在这儿
   * 再问一次，它们会接着按线下预设生成、接着发四条选项 —— 用户看到的就是
   * 「明明关了还在线下」。
   *
   * 放在这儿而不是各调用方各判一次：两处（`imessage.js` 的 `runOfflineTurnHere`、
   * `index.js` 的 `/turn` `/reroll`）判出分歧的话，又多一个「一边说开着一边说
   * 关着」的来源，而这正是文件头说的那件事 —— 状态只有一处。
   */
  if (!isOfflineOn(roleKey)) {
    const e = new Error("线下模式已经关了（这句没进剧情）。要接着演就再开一次线下。");
    // 调用方要分得出这不是「生成失败」。iMessage 那头靠它换一句话说 ——
    // 报「这轮没回上来」会让用户以为是模型挂了，然后一直重试
    e.offlineClosed = true;
    throw e;
  }

  if (storyId && readIndex(roleKey).currentId !== storyId) setCurrent(roleKey, storyId);
  let story = currentStory(roleKey);
  if (!story) throw new Error("这个角色现在没有在演的剧情（先在「线下模式」里开一条）");

  const { endpoint, fallback } = offlineEndpoint(config, role);
  if (!endpoint) {
    throw new Error(
      "线下模式没有可用的模型：去「角色」面板的「线下模式」里选一个线下 API，" +
        "或者给这个角色配上聊天模型。"
    );
  }

  const preset = resolvePreset(config, role, "offline");
  const vars = {
    char: role?.name ?? "",
    user: user?.name ?? "",
    sep: config?.chat?.separator ?? "",
  };

  if (reroll) {
    /*
     * 重 roll：只删末尾的助手轮次，用户那句留着。
     *
     * 这条路**不再跑一遍 userInput 正则** —— 用户那句是从存档里摘回来的，
     * 第一次进存档之前就已经过滤过了，再来一遍等于同一条规则连着作用两次
     * （`imessage.js` 的重 roll 也是这么定的，同一个坑）。
     */
    const dropped = dropLastAssistant(roleKey, story.id);
    logInfo(SCOPE, `重 roll：删掉末尾 ${dropped} 条回复，按同一份上文重来`);
    story = readStory(story.id) ?? story;
  } else {
    let said = String(text ?? "");
    if (!said.trim() && choiceIndex >= 1) {
      // 点选项发送：从最后一条助手轮次上取。序号按界面上看到的来，1 起
      const last = [...story.turns].reverse().find((t) => t.role === "assistant");
      said = last?.options?.[choiceIndex - 1] ?? "";
      if (!said.trim()) throw new Error("上一轮没有这条选项（可能已经重 roll 过了）");
    }
    if (!said.trim()) throw new Error("这一轮没有内容可发");

    const filtered = applyAndLog(
      said,
      preset.regex,
      { target: "userInput", vars },
      "线下用户输入"
    ).text;
    if (!appendTurn(roleKey, { role: "user", content: filtered })) {
      throw new Error("这一轮存不下来（剧情文件写失败）");
    }
    story = readStory(story.id) ?? story;
  }

  /*
   * 天气和时间。线下也带上：用户点名了拿正则渲染「当前时间、天气、地点」
   * 那种状态栏，模型得先知道现在几点、外面什么天。取不到就少这一行，
   * 不影响这轮 —— 和 iMessage 那条链一个处理。
   */
  let weatherNote = "";
  try {
    weatherNote = (await buildEnv(role, config.weatherApi)).weather;
  } catch (e) {
    logWarn(SCOPE, "取天气失败，这轮提示词里不带天气", e);
  }

  let built;
  try {
    built = await buildPrompt(config, role, user, historyOf(story, role), weatherNote, {
      mode: "offline",
    });
  } catch (e) {
    logError(SCOPE, "线下提示词组不出来", e);
    throw new Error(`提示词组不出来：${e?.message ?? e}`);
  }

  notePrompt(
    {
      roleId: role.id,
      // 缀一下，「最后一次发给模型的提示词」面板上才分得清是哪条链
      roleName: `${role.name}（线下）`,
      sessionId: story.id,
      userId: user?.id ?? "",
      userName: user?.name ?? "",
      model: endpoint.label ?? "",
      presetName: presetLabel(built.preset),
      worldHits: built.worldInfo.hitNames,
    },
    built.messages
  );

  logInfo(
    SCOPE,
    `线下这轮发给模型 ${built.messages.length} 段，预设「${presetLabel(built.preset)}」，` +
      `上文 ${built.history.length} 条`
  );

  let reply;
  let usedFallback = false;
  try {
    // params 用预设那一份：线下要的就是有变化，这是和协助模式最大的区别
    const out = await chatWithFallback(endpoint, fallback, built.messages, built.params, {
      signal,
      onDelta,
      onRestart,
    });
    reply = out.content;
    usedFallback = out.usedFallback;
  } catch (e) {
    // 用户按的「停下」不是故障，日志里别报红
    if (e?.aborted) logInfo(SCOPE, "线下这轮被用户按停了");
    else logError(SCOPE, "线下这轮没回上来", e);
    throw e;
  }
  if (usedFallback) logWarn(SCOPE, "线下这轮走的是副 API");
  if (!String(reply ?? "").trim()) throw new Error("模型这轮返回是空的（可以直接重 roll）");

  /*
   * 先摘选项、再跑正则。反过来的话，渲染 HTML 那类规则会把 `<选项>` 那段
   * 也一起吃进 `<div>` 里，摘不出来了。
   */
  const wantChoices = choicesOn(role, built.preset);
  const cut = wantChoices ? splitChoices(reply) : { body: String(reply), options: [] };
  if (wantChoices && !cut.options.length) {
    logWarn(SCOPE, "这轮没摘到用户选项（模型没按格式吐），只当这轮没选项");
  }

  /*
   * 存档存原文，只算「给人看」这一路。
   *
   * `toHistory` 那一路**不在这里跑** —— 挪到了 `prompt.js:filterHistory`，
   * 下一轮拼提示词时才执行（`buildPrompt` 已经在调，见 historyOf 那条路）。
   * 所以模型看到的上文照旧是滤过的，没有 HTML 泄进去。
   */
  const display = applyAndLog(
    cut.body,
    built.preset.regex,
    { target: "aiOutput", field: "toUser", vars },
    "线下回复（给人看）"
  ).text;

  const turn = appendTurn(roleKey, {
    role: "assistant",
    content: cut.body,
    options: cut.options,
  });
  if (!turn) throw new Error("这轮回复存不下来（剧情文件写失败）");

  // 总结单独一层 try：它失败只是「总结晚一点」，正文已经落盘了
  let summary = null;
  try {
    summary = await maybeSummarize(config, role, story.id);
  } catch (e) {
    logWarn(SCOPE, "这轮之后的自动总结没成，正文不受影响", e);
  }

  return {
    turn,
    display: display.trim(),
    options: cut.options,
    story: readStory(story.id),
    usedFallback,
    summary,
  };
}

/* ================= 总结 ================= */

/** 小总结覆盖到第几轮为止（轮次下标，含头不含尾）。一份都没有就是 0。 */
function smallCoverage(story) {
  return story.summaries.reduce((n, s) => (s.kind === "small" ? Math.max(n, s.to) : n), 0);
}

/** 大总结覆盖到第几轮为止。 */
function bigCoverage(story) {
  return story.summaries.reduce((n, s) => (s.kind === "big" ? Math.max(n, s.to) : n), 0);
}

/**
 * 还没被小总结概括过的轮次。
 *
 * 用「覆盖到第几轮」而不是「上次总结完还剩几条」来算：轮次可以被删、被隐藏、
 * 被编辑，只有下标区间这种写法在改过之后还站得住。
 */
function uncoveredTurns(story) {
  return story.turns.slice(smallCoverage(story));
}

/** 还没被大总结合并过的小总结。 */
function uncoveredSmalls(story) {
  const at = bigCoverage(story);
  return story.summaries.filter((s) => s.kind === "small" && s.to > at);
}

/** 一轮 = 角色开口一次。用户连发两条不该把总结提前催出来。 */
function assistantCount(turns) {
  return turns.filter((t) => t.role === "assistant").length;
}

/**
 * 生成一份总结并存进剧情。材料是空的就返回 null（不打接口）。
 *
 * @param {"small"|"big"} kind
 */
async function makeSummary(config, role, story, kind) {
  const user = resolveUser(config, role);
  const charName = role?.name ?? "";
  const userName = user?.name ?? "";
  const vars = { char: charName, user: userName, sep: "" };
  // 存档是模型原文，喂给总结之前得过一遍 toHistory（见 turnsText）
  const rules = resolvePreset(config, role, "offline").regex ?? [];

  let material = "";
  let from = 0;
  let to = story.turns.length;

  if (kind === "small") {
    const turns = uncoveredTurns(story);
    if (!turns.length) return null;
    material = turnsText(turns, charName, userName, rules, vars);
    from = smallCoverage(story);
  } else {
    const smalls = uncoveredSmalls(story);
    if (smalls.length) {
      material = pendingText(smalls.map((s) => s.text).join("\n\n"), MAX_SUMMARY_INPUT);
      from = smalls[0].from;
      to = smalls[smalls.length - 1].to;
    } else {
      // 一份小总结都没有就直接读正文 —— 手动点「大总结」的短剧情会走到这儿
      if (!story.turns.length) return null;
      material = turnsText(story.turns, charName, userName, rules, vars);
    }
  }
  if (!material.trim()) return null;

  const { endpoint: base } = offlineEndpoint(config, role);
  const endpoint = summaryEndpoint(config, role, kind, base);
  if (!endpoint) throw new Error("总结没有可用的模型（去「角色」面板的「线下模式」里选一个）");

  const what = kind === "big" ? "大总结" : "小总结";
  const messages = summaryMessages(
    [
      applyVars(kind === "big" ? BIG_PROMPT : SMALL_PROMPT, vars),
      wrap(kind === "big" ? "分段记录" : "剧情", material),
    ]
      .filter((s) => s && s.trim())
      .join("\n\n")
  );

  const raw = await chatCompletion(endpoint, messages, {
    label: endpoint.label ? `线下${what}（${endpoint.label}）` : `线下${what}`,
    params: SUMMARY_PARAMS,
    timeout: SUMMARY_TIMEOUT,
    retryOnRefusal: SUMMARY_REFUSAL_RETRIES,
  });
  const content = String(raw ?? "").trim();
  if (!content) throw new Error(`模型返回了空的${what}`);

  const saved = appendSummary(story.id, { kind, text: content, from, to });
  if (!saved) throw new Error(`${what}存不下来（剧情文件写失败）`);
  logInfo(SCOPE, `出了一份${what}（第 ${from + 1}-${to} 轮，${content.length} 字）`, content);
  return saved;
}

/**
 * 该出总结了吗，该就出一份。
 *
 * 轮数够 `role.offline.smallEvery`（默认 6）出一份小总结；小总结攒够
 * `role.offline.bigEvery`（默认 8，开关默认关）再出一份大总结。
 *
 * 一次最多出一份小 + 一份大：两份都要打接口，用户正等着下一轮剧情。
 *
 * @returns {Promise<object|null>} 这次出的那份（小和大都出了就返回大的），没出就 null
 */
export async function maybeSummarize(config, role, storyId) {
  const cfg = role?.offline ?? {};
  const story = readStory(storyId);
  if (!story) return null;

  let made = null;
  const every = Number(cfg.smallEvery) || 6;
  if (assistantCount(uncoveredTurns(story)) >= every) {
    made = await makeSummary(config, role, story, "small");
  }

  if (!cfg.bigEnabled) return made;
  const after = made ? readStory(storyId) ?? story : story;
  const bigEvery = Number(cfg.bigEvery) || 8;
  if (uncoveredSmalls(after).length >= bigEvery) {
    made = (await makeSummary(config, role, after, "big")) ?? made;
  }
  return made;
}

/**
 * 手动出一份（iMessage 的 `/小总结` `/大总结`，网页上那两个按钮）。
 *
 * 不看轮数、不看大总结那个开关 —— 用户自己点的就是他自己的判断。
 * 没有材料时返回 null，调用方回一句「还没有可以总结的内容」。
 */
export async function summarizeNow(config, role, storyId, kind = "small") {
  const story = readStory(storyId);
  if (!story) return null;
  return makeSummary(config, role, story, kind === "big" ? "big" : "small");
}

/* ================= 结束线下 ================= */

/**
 * 结束当前线下模式：补一次大总结 → 注入待总结 → 关线下 → 给剧情盖上时间戳。
 *
 * 用户的原话：「每次剧情结束后需要用户选择自动结束当前线下模式，这次线下就
 * 结束了，可以回归线上功能，且会自动触发一次大总结，并把总结后的内容加入到
 * 记忆库里」。
 *
 * 几个定死的点：
 *
 *  - **那次大总结不看 `bigEnabled`**。那个开关管的是「演到一半自动出大总结」，
 *    结束时这一份是用户点的，一定要有。出之前先补一份小总结，把最后那几轮
 *    也盖进去 —— 不然大总结是「几份小总结的合并」，结尾那段会凭空消失。
 *  - **只注入小/大总结，不注入原始轮次**（用户点名的）。剧情正文动辄几万字，
 *    整段灌进待总结会把记忆总结那条链的输入撑爆，而且那不是「记忆」，
 *    是逐字记录。
 *  - **发送人写「线下剧情」**。落到 `.txt` 里就是 `… | [线下剧情] …`，
 *    和角色自己说过的话分得开，而 `memorystore.js` 一个字节都不用改。
 *  - **总结失败照样结束**。生成失败就没有那一份，已经有的照旧注入 ——
 *    卡在这儿不放人才是最糟的结果（用户会被困在线下模式里）。
 *  - **开关一进门就按掉，不等总结**。见下面那段。
 *
 * ── 为什么开关必须第一步按掉 ──
 *
 * 收尾要打两次模型（补一份小总结 + 出一份大总结），而这条链的超时是
 * `SUMMARY_TIMEOUT`（10 分钟）、被拒还重试 `SUMMARY_REFUSAL_RETRIES` 次。
 * 开关要是放在最后按，这几分钟里磁盘上的 `open` 还是 `true`，而「线下开着吗」
 * 全靠它：聊天框那道闸（`imessage.js` 的消息循环）继续把话当剧情、主动消息
 * 继续被压着、`/api/offline` 也照样回「开着」。用户点完「结束线下」之后还在
 * 线下模式里待好几分钟 —— 中间发的话全进了剧情，而他以为已经回线上了。
 *
 * 网页那条更难看：反代一般 60 秒就把这条请求掐了，前端拿不到那份新 state，
 * 页面上就一直挂着「线下开着」，怎么刷都不变（因为后端也确实还开着）。
 *
 * 按掉之后再去出总结：总结是「这段剧情记点什么」，和「现在还在不在线下」
 * 是两件事，没有理由让后者等前者。
 *
 * @param {{inject?: boolean}} [opts] `inject: false` = 结束但不写记忆库
 * @returns {Promise<{ok: boolean, injected: number, summary: object|null,
 *   story: object|null, error: string}>}
 */
export async function endOffline(config, role, opts = {}) {
  const inject = opts?.inject !== false;
  const roleKey = memoryKeyFor(role);
  const idx = readIndex(roleKey);
  const storyId = idx.currentId;

  // 第一件事。后面那几步全都可能花上几分钟，一步都不能让开关等着
  closeOffline(roleKey);

  if (!storyId) {
    return { ok: true, injected: 0, summary: null, story: null, error: "" };
  }

  const before = readStory(storyId);
  // 上一次结束的时间戳。再次结束时只注入这之后新出的总结，免得同一份
  // 总结在待总结里出现两遍（用户完全可能关了又开、再关一次）
  const since = before?.endedAt ?? "";

  let summary = null;
  let error = "";
  try {
    const story = readStory(storyId);
    if (story) {
      if (assistantCount(uncoveredTurns(story)) > 0) {
        await makeSummary(config, role, story, "small");
      }
      summary = await makeSummary(config, role, readStory(storyId) ?? story, "big");
    }
  } catch (e) {
    error = String(e?.message ?? e);
    logWarn(SCOPE, "结束时那份大总结没生成出来，已经有的总结照旧注入", e);
  }

  let injected = 0;
  const story = readStory(storyId);
  if (inject && story) {
    const list = story.summaries
      .filter((s) => s.text.trim() && (!since || s.ts > since))
      .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    for (const s of list) {
      appendPending("memory", roleKey, {
        at: s.ts,
        charName: "线下剧情",
        user: "",
        assistant: s.text,
      });
      injected += 1;
    }
    logInfo(
      SCOPE,
      `线下剧情「${story.name}」结束，往待总结写了 ${injected} 份总结（记忆库 key：${roleKey}）`
    );
  }

  endStory(roleKey, storyId);
  /*
   * 这儿**不再按一次开关**。开头那一次就是生效的那次，而收尾这几分钟里用户
   * 完全可能又开了一次（手机上发 `/开启线下`，或者网页那条请求被反代掐了之后
   * 点「接着演」）—— 那是他更晚的、更明确的意思，收尾跑完了再把人踢出来
   * 就又变成「状态和我刚点的那下对不上」，跟这次要修的是同一个毛病。
   */
  return { ok: true, injected, summary, story: readStory(storyId), error };
}
