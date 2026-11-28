/**
 * 通话里的一轮：对方说了一句 → 转写 → 打模型 → 一句一句合成送回去。
 *
 * ── 为什么另开一条路，不走 handleTurn ──
 *
 * `imessage.js:handleTurn` 有 700 多行，一多半是**只在发短信时才成立**的事：
 * 拆气泡、已读不回、撤回、表情包、Instagram、投递检测、打字指示器。通话里这些
 * 要么没有意义（说出口的话收不回来），要么会把整轮吞掉（已读不回 —— 实测它
 * 真的把入会指令吃掉过一次）。
 *
 * 所以这里是一条**轻链路**，和线下模式（`offline.js:runOfflineTurn`）一个待遇：
 * 自己拼提示词、自己打模型，但**存档和记忆走的是和发短信完全一样的那两个函数**
 * （`appendTurn` / `recordTurn`）。上下文也是同一条历史 —— 这是用户钉死的：
 * 一接通就知道之前聊了什么，挂断之后在 iMessage 里能接着聊刚才通话的内容。
 *
 * ── 怎么把延迟压下来 ──
 *
 * 一轮下来的账：FaceTime 自身 1～2 秒（实测，走代理更久）+ 转写 + 模型 + 合成
 * + 传回去 1～2 秒。老实等的话五到八秒，没法聊天。
 *
 * 两刀下去：
 *
 *  1. **模型流式输出**。`llm.js` 本来就支持（传 `onDelta`），只是发短信那条路
 *     用不上 —— 半截文本没法按 `$` 切气泡（`config.js:441` 的注释）。通话正好
 *     相反：**第一个句子一凑齐就能开始合成播放**，不用等整段写完。
 *  2. **一句一句合成**。`media.js` 那四家 TTS 全是整段合成（`media.js:1496`
 *     写死 `stream: false`），但我们可以自己按句切。第一句刻意切短，它决定
 *     对方多久能听到声音；后面的句子在它播的时候已经在合成了。
 *
 * 压完预期 3～5 秒，当成「信号不太好的电话」能接受。
 */

import {
  callPrefix,
  interruptedNotice,
  readHangUp,
  silenceNotice,
  speakableFrom,
  splitSentences,
  stripCallTags,
  typedPrefix,
} from "./calltags.js";
import { elapsedMs, recordCallTurn, sayDuration } from "./callsession.js";
import { resolveEndpoint, resolveRoleEndpoints } from "./config.js";
import { chatWithFallback, describeImage, transcribeAudio } from "./llm.js";
import { logDebug, logInfo, logWarn } from "./logs.js";
import { pickTtsSource, splitMedia, stripToneTags, synthesizeVoice } from "./media.js";
import { transcribe as sttTranscribe } from "./stt.js";

const SCOPE = "通话";

/**
 * 这个模型引用填全了吗。
 *
 * 和 `offline.js:150` 同一个判据（那边是私有函数）。两行代码，不值得为了
 * 复用去改线下模式那个文件 —— 但改判据的时候两处要一起改。
 */
function refUsable(ref) {
  return Boolean(ref?.provider && ref?.modelId);
}

/**
 * 通话这一轮用哪个模型。
 *
 * 和线下模式同一个路子（`offline.js:offlineEndpoint`）：角色上单独选一个，
 * 没选就用主聊天模型。**选了但引用失效时退回主模型并记一条 warn** —— 静默
 * 换模型不好，但让一通电话打不通更糟。
 *
 * 为什么值得单独配：通话对延迟敏感得多，带 thinking 的模型在电话里是灾难
 * （实测那条日志里主模型想了 7.3 秒）。
 */
export function callEndpoint(config, role) {
  const eps = resolveRoleEndpoints(config, role);
  const ref = role?.call?.model;
  if (refUsable(ref)) {
    const own = resolveEndpoint(config, ref);
    if (own) return { endpoint: own, fallback: eps.fallback };
    logWarn(SCOPE, "通话单独选的模型引用失效了（服务商或模型被删/被关），这轮用角色的聊天模型");
  }
  return { endpoint: eps.chat, fallback: eps.fallback };
}

/**
 * 把对方说的那段话转成文字。
 *
 * 复用角色的「听音」配置（`role.audioModel`）—— 和 iMessage 里的语音条走的是
 * 同一个模型、同一个提示词，没必要为通话另配一套。
 *
 * @param {object} config
 * @param {object} role
 * @param {Buffer} wav 16kHz 单声道 WAV（节点那边包好的）
 * @param {object} [opts]
 * @param {boolean} [opts.tone] 要不要顺带听语气（`role.call.hearTone`）
 * @returns {Promise<{text: string, tone: string}>} 转写出来的文字（听不出来是空串），
 *   以及语气（「开心」「生气」这种两三个字；平常语气或者没听出来是空串）
 */
export async function transcribe(config, role, wav, opts = {}) {
  const wantTone = opts.tone !== false;
  /*
   * ── 优先走专门的 STT ──
   *
   * 配了的话用它：1 秒内返回、只给原话、便宜一个数量级。多模态那条路
   * （下面那段）慢好几秒，而且会"理解"而不是"转写" —— 实测把一句「Hi」
   * 扩写成了六段式报告。通话最受不了这两样。
   */
  const stt = await sttTranscribe(config.sttApi, wav, {
    mimeType: "audio/wav",
    scope: SCOPE,
  }).catch((e) => {
    // 转写服务挂了就退回多模态，别让一通电话哑掉
    logWarn(SCOPE, "专门的转写服务没转出来，退回多模态模型", e);
    return null;
  });
  /*
   * 语气：Qwen 每次都顺带回一个情绪标签，不用另外请求、不多花一毫秒。
   * 别家专门的转写不给，那就没有 —— 不为它再打一次多模态，那会把这一轮拖慢。
   */
  if (stt) return { text: stt.text, tone: wantTone ? toneWord(stt.emotion) : "" };

  const eps = resolveRoleEndpoints(config, role);
  if (!eps.audio) {
    logWarn(
      SCOPE,
      "没配转写服务，这个角色也没开「听音」—— 通话里对方说的话没法转成文字。" +
        "去「连接」面板配一个转写服务（OpenAI 兼容 / Qwen / 讯飞都行）"
    );
    return { text: "", tone: "" };
  }

  const audio = {
    base64: wav.toString("base64"),
    mimeType: "audio/wav",
    name: "call.wav",
  };

  try {
    /*
     * ── 通话里**不用**角色那份「听音」提示词 ──
     *
     * 角色开了「结构化」模式（`role.audioModel.emotion`）的话，那份提示词会
     * 要求模型输出六段式的分析报告：
     *
     *   1) 原话转写：Hi
     *   2) 语言：英语
     *   3) 语气/情绪：轻松友好，伴随着轻笑
     *   …
     *
     * 那是给语音条用的 —— 对方发一条语音过来，角色「听」出情绪和环境是加分项。
     * 但**通话里这整段会原样进上下文**，模型看到的不是「对方说了 Hi」而是一份
     * 报告，于是它开始对着报告说话（实测第一通电话就是这样）。而且多生成
     * 这六段还要多花好几秒 —— 通话最不能忍的就是这个。
     *
     * 所以这里写死用简洁版：只要原话。听语气的话只多要**一行**、而且只在
     * 语气明显时才写（见 CALL_TONE_LINE），平常一个字都不多。
     */
    const prompt = wantTone ? CALL_AUDIO_PROMPT + CALL_TONE_LINE : CALL_AUDIO_PROMPT;
    const raw = await transcribeAudio(eps.audio, prompt, audio);
    const { text, tone } = splitToneLine(raw);
    logDebug(SCOPE, `听清了：${text.slice(0, 60)}${tone ? `（语气：${tone}）` : ""}`);
    return { text, tone: wantTone ? tone : "" };
  } catch (e) {
    logWarn(SCOPE, "这段没听清", e);
    return { text: "", tone: "" };
  }
}

/**
 * Qwen 的情绪标签 → 给角色看的词。
 *
 * neutral（平静）不报：绝大多数话都是它，每句都标一个「平静」只是噪音，
 * 角色还会以为这是件值得回应的事。
 */
const TONE_WORDS = {
  happy: "开心",
  sad: "难过",
  angry: "生气",
  surprised: "惊讶",
  fearful: "害怕",
  disgusted: "嫌弃",
};

export function toneWord(emotion) {
  return TONE_WORDS[String(emotion ?? "").trim().toLowerCase()] ?? "";
}

/**
 * 多模态那条路要它听语气时，提示词后面多的那一行。
 *
 * 刻意只要**最后单独一行**、**语气明显才写**：要它每句都分析一遍语气的话，
 * 它会回到语音条那种报告体（见上面 transcribe 里的那段），而且慢。
 */
const CALL_TONE_LINE =
  "\n如果对方的语气很明显（在笑、带哭腔、在生气、很激动、很低落、在小声说话这类），" +
  "在最后另起一行写「语气：」加两三个字；语气平常就不要写这一行。";

/**
 * 从多模态的回复里把「语气：xx」那一行拆出来。
 *
 * 只认**最后一行**：前面要是出现「语气」两个字，那是对方真说的话。
 *
 * @returns {{text: string, tone: string}}
 */
export function splitToneLine(raw) {
  const lines = String(raw ?? "").trim().split(/\r?\n/);
  const last = lines[lines.length - 1]?.trim() ?? "";
  const m = /^[(（【[]?语气[:：]\s*([^)）】\]]{1,12})[)）】\]]?$/.exec(last);
  if (!m || lines.length < 2) return { text: lines.join("\n").trim(), tone: "" };
  return { text: lines.slice(0, -1).join("\n").trim(), tone: m[1].trim() };
}

/* ── 背景声音：在外面、车里、旁边有人 ─────────────────────────── */

/**
 * 隔多久听一次背景。
 *
 * 背景不会每句话都变，每句都听是白花钱；而且它是**晚一轮**才告诉角色的
 * （见 listenAmbience），听得再勤也快不了。30 秒一次够看出「从屋里走到街上」。
 */
export const AMBIENCE_EVERY_MS = 30_000;

/**
 * 听背景声音用的提示词。
 *
 * 把**上一次听到的**带上，让它和那次比 —— 不然每次措辞都不一样
 * （「街上，车声」「户外，有汽车经过」），程序分不出是真换了地方还是换了说法，
 * 只能每 30 秒都报一次，角色就会一直念叨「你那边好吵」。
 */
export function ambiencePrompt(last = "") {
  return (
    "你在听一通电话里对方那头的背景声音，不用管对方说的内容。\n" +
    "用一句不超过 20 个字的话描述背景：大概在什么地方（屋里、街上、车里、商场、饭馆……），" +
    "有什么明显的声音（车流、风声、音乐、电视、旁边有别人在说话……）。\n" +
    "背景很安静、听不出什么的话，只输出两个字：安静。\n" +
    (last ? `上次听到的背景是「${last}」。如果现在和它差不多，只输出两个字：同上。\n` : "") +
    "只写确实听到的声音，禁止推测和补全。不要任何格式、引号或解释。"
  );
}

/**
 * 听到一次背景之后，要不要告诉角色、告诉什么。纯函数，状态由调用方存。
 *
 *  - 「同上」或者空：没变，不报
 *  - 「安静」：一开始就安静的不报（打电话默认就是安静的，报了反而奇怪）；
 *    之前报过吵、现在安静了，报一次「安静下来了」
 *  - 别的：报
 *
 * @param {string} last 上一次记下的背景
 * @param {string} raw 这次模型回的
 * @returns {{note: string, last: string}} note 空 = 这次不用告诉角色
 */
export function nextAmbience(last, raw) {
  const line = String(raw ?? "")
    .trim()
    .split(/\r?\n/)[0]
    .replace(/^["'“”「『]+|["'“”」』。.]+$/g, "")
    .trim()
    .slice(0, 30);
  if (!line || /^同上/.test(line)) return { note: "", last };
  if (/^安静/.test(line)) {
    const wasNoisy = Boolean(last) && !/^安静/.test(last);
    return { note: wasNoisy ? "安静下来了" : "", last: "安静" };
  }
  return { note: line, last: line };
}

/**
 * 在后台听一下这段的背景声音。**不等它**。
 *
 * 结果存在这通电话上，**下一轮**拿出来告诉角色（takeAmbience）。为什么不等：
 * 转写快（Qwen 一秒内），多模态听背景要两三秒 —— 等它的话每轮都慢这么多，
 * 而「你那边好吵」晚一句说出来完全不碍事。
 *
 * 走的是角色的「听音」模型（`role.audioModel`）。没配就不听 —— 专门的转写
 * 服务只会转字，听不出背景。
 *
 * @param {object} args
 * @param {object} args.call 这通电话（callsession 里那个对象，状态就挂在它上面）
 * @param {number} [args.now] 测试用
 * @param {Function} [args.listen] 测试用：替掉真的那次模型请求
 * @returns {Promise<void>|null} 这次没听（太勤、正在听、没模型）返回 null
 */
export function listenAmbience({ config, role, call, wav, now = Date.now(), listen }) {
  if (!call || !wav?.length) return null;
  const st = (call.ambience ??= { last: "", pending: "", busy: false, at: 0, warned: false });
  if (st.busy || (st.at && now - st.at < AMBIENCE_EVERY_MS)) return null;

  const eps = listen ? null : resolveRoleEndpoints(config, role);
  if (!listen && !eps?.audio) {
    if (!st.warned) {
      st.warned = true;
      logInfo(SCOPE, "开着「听背景声音」，但这个角色没配「听音」模型 —— 背景听不了，只转写原话");
    }
    return null;
  }

  st.busy = true;
  st.at = now;
  const ask =
    listen ??
    ((prompt) =>
      transcribeAudio(eps.audio, prompt, {
        base64: wav.toString("base64"),
        mimeType: "audio/wav",
        name: "ambience.wav",
      }));

  return Promise.resolve()
    .then(() => ask(ambiencePrompt(st.last)))
    .then((raw) => {
      const { note, last } = nextAmbience(st.last, raw);
      st.last = last;
      if (note) {
        st.pending = note;
        logInfo(SCOPE, `听到背景：${note}（下一轮告诉角色）`);
      } else {
        logDebug(SCOPE, `背景没变（${String(raw ?? "").trim().slice(0, 30)}）`);
      }
    })
    .catch((e) => logDebug(SCOPE, "这次背景没听成", e))
    .finally(() => {
      st.busy = false;
    });
}

/** 把攒着的背景拿出来（拿了就清掉，同一句不说两遍）。 */
export function takeAmbience(call) {
  const st = call?.ambience;
  if (!st?.pending) return "";
  const note = st.pending;
  st.pending = "";
  return note;
}

/* ── 摄像头：角色看得到对方 ─────────────────────────────────── */

/**
 * 对方一开口，节点就从 FaceTime 的视频里截一帧送过来（facetime-node 的
 * call.mjs:#snapFrame）。这里用角色的「识图」模型描述成一句话，贴进**这一轮**。
 *
 * ── 为什么在开口时截、而不是说完时 ──
 *
 * 识图要一两秒。开口时截的话，它和「对方说话 + 转写」同时跑，说完转写完
 * 多半已经看好了，这一轮直接用上，不拖慢回话。没看完的话最多再等
 * FRAME_WAIT_MS，还不好就先不带，留给下一轮。
 *
 * ── 为什么描述成文字、不直接把图塞给聊天模型 ──
 *
 * 和 iMessage 里收到照片一个路子（imessage.js 里 describeImage 那段）：
 * 聊天模型不一定看得懂图，识图模型是用户专门配的；而且文字能进历史和记忆，
 * 图进不去 —— 角色下一轮还记得「你刚才在吃面」。
 *
 * ── 什么时候报 ──
 *
 * 和背景声音一样**只报变化**：提示词带上上一张的描述，差不多就回「同上」不报，
 * 不然每句话前面都顶着一段一模一样的画面描述。关掉摄像头报一次；一开始就没开
 * 的什么都不报 —— 默认通话预设里写了「没识别到画面就当语音通话」。
 */

/** 转写完之后，最多再等识图多久。 */
export const FRAME_WAIT_MS = 2_000;

/** 一帧最大多大。640px 的 JPEG 一般三五十 KB，给到 1MB 很宽裕。 */
export const MAX_FRAME_BYTES = 1024 * 1024;

/** 识图用的提示词。带上上一张的描述，理由同 ambiencePrompt。 */
export function framePrompt(last = "") {
  return (
    "这是一通视频通话里，对方摄像头传过来的一帧画面。\n" +
    "用一两句话（不超过 60 个字）客观描述你看到的：画面里的人在做什么、什么表情、" +
    "手里拿着什么、在什么地方。称呼画面里的人用「对方」。\n" +
    "黑屏、糊得看不清、或者画面里什么都看不出来，只输出三个字：看不清。\n" +
    (last ? `上一张画面是「${last}」。如果现在和它差不多（在做的事、地方、手里的东西都没变），只输出两个字：同上。\n` : "") +
    "只写确实看到的，不要猜画面里的人是谁，不要编。不要任何格式、引号或解释。"
  );
}

/**
 * 看到一帧之后，要不要告诉角色、告诉什么。纯函数。
 *
 * @param {string} last 上一张的描述（空 = 还没看到过）
 * @param {string} raw 识图模型回的
 * @returns {{note: string, last: string}}
 */
export function nextFrame(last, raw) {
  const line = String(raw ?? "")
    .trim()
    .split(/\r?\n/)
    .join("")
    .replace(/^["'“”「『]+|["'“”」』]+$/g, "")
    .trim()
    .slice(0, 80);
  // 看不清不算「看到了」：不报，上一张也不动（等下一帧再说）
  if (!line || /^同上/.test(line) || /^看不清/.test(line)) return { note: "", last };
  return { note: line, last: line };
}

/**
 * 收到节点送来的一帧（或者「摄像头关了」）。**不等识图**，结果挂在这通电话上。
 *
 * @param {object} args
 * @param {object} args.call
 * @param {{off?: boolean, jpeg?: string}} args.frame jpeg 是 base64
 * @param {Function} [args.describe] 测试用：替掉真的那次识图
 * @returns {Promise<void>|null} 没在看（关着、没模型、正在看上一张）返回 null
 */
export function seeFrame({ config, role, call, frame, describe }) {
  if (!call || !frame) return null;
  const st = (call.camera ??= { last: "", pending: null, job: null, on: false, warned: false });

  if (frame.off) {
    // 开过、现在关了：报一次。从来没开过就什么都不说
    if (st.on) {
      st.on = false;
      st.last = "";
      st.pending = { off: true };
      logInfo(SCOPE, "对方关掉了摄像头（下一轮告诉角色）");
    }
    return null;
  }

  const jpeg = String(frame.jpeg ?? "");
  if (!jpeg) return null;
  // 上一张还没看完就不叠一个 —— 对方连着说短句时节点会一直截
  if (st.job) return null;

  const eps = describe ? null : resolveRoleEndpoints(config, role);
  if (!describe && !eps?.vision) {
    if (!st.warned) {
      st.warned = true;
      logInfo(SCOPE, "开着「看摄像头」，但这个角色没配「识图」模型 —— 画面看不了，当语音通话");
    }
    return null;
  }

  const ask =
    describe ??
    ((prompt) => describeImage(eps.vision, prompt, { base64: jpeg, mimeType: "image/jpeg", name: "camera.jpg" }));

  st.job = Promise.resolve()
    .then(() => ask(framePrompt(st.last)))
    .then((raw) => {
      const { note, last } = nextFrame(st.last, raw);
      st.last = last;
      if (note) {
        st.on = true;
        st.pending = { text: note };
        logInfo(SCOPE, `看到画面：${note}`);
      } else {
        // 「同上」也说明摄像头开着；「看不清」不算
        if (/^同上/.test(String(raw ?? "").trim())) st.on = true;
        logDebug(SCOPE, `画面没变（${String(raw ?? "").trim().slice(0, 30)}）`);
      }
    })
    .catch((e) => logDebug(SCOPE, "这一帧没看成", e))
    .finally(() => {
      st.job = null;
    });
  return st.job;
}

/**
 * 这一轮要告诉角色的画面。识图还在跑的话最多等 waitMs。
 *
 * @returns {Promise<{text?: string, off?: boolean} | null>} 拿了就清掉
 */
export async function takeFrame(call, waitMs = FRAME_WAIT_MS) {
  const st = call?.camera;
  if (!st) return null;
  if (st.job && !st.pending) {
    await Promise.race([st.job, new Promise((r) => setTimeout(r, waitMs))]);
  }
  const note = st.pending;
  st.pending = null;
  return note;
}

/**
 * 通话里转写用的提示词。
 *
 * 和 `config.js:DEFAULT_AUDIO_PROMPT` 几乎一样，只多两条通话特有的要求：
 *
 *  - **没人说话就回空**。语音条那边要描述环境音（「轻微键盘声、室内安静」），
 *    通话里不需要 —— VAD 已经切过一道了，走到这儿还没人声的多半是误触，
 *    回一句环境描述只会让角色对着噪音搭话。
 *  - **别加标点之外的任何东西**。
 */
const CALL_AUDIO_PROMPT =
  "你是一个语音转写器，正在转写一通电话里对方说的话。\n" +
  "直接输出原话纯文本，不要任何格式、编号、引号或说明。\n" +
  "如果这段音频里没有人说话（只有环境音、噪音、呼吸声），只输出两个字：无声。\n" +
  "只写你确实听到的内容，听不清就写听不清，禁止凭空推测或补全。";

/**
 * 跑一轮通话：打模型，一句一句往外吐合成好的音频。
 *
 * 这是个**异步生成器** —— 调用方 `for await` 拿到一句就立刻播一句，不等整段
 * 写完。这是延迟能压下来的关键，别改成返回数组。
 *
 * @param {object} args
 * @param {object} args.config
 * @param {object} args.role
 * @param {object[]} args.messages 已经拼好的提示词（含通话预设）
 * @param {object} args.params 温度那些
 * @param {AbortSignal} [args.signal] 被打断时用它掐掉模型请求
 * @yields {{text: string, audio: Buffer}}
 */
export async function* runCallTurn({ config, role, messages, params, signal }) {
  const { endpoint, fallback } = callEndpoint(config, role);
  const sep = config?.chat?.separator ?? "$";
  const voice = callVoice(config, role);

  /*
   * 流式接收，攒够一句就吐出去。
   *
   * `pending` 是还没成句的尾巴。`onDelta` 只管往里攒 —— 真正的切句和合成在
   * 下面那个循环里做，因为 `onDelta` 是同步回调，不能在里面 await。
   */
  let buffer = "";
  let cursor = 0; // 已经处理到 buffer 的哪里了
  const ready = []; // 攒好的、等着合成的句子
  let done = false;
  let failed = null;
  let wake = null;

  const poke = () => {
    const fn = wake;
    wake = null;
    fn?.();
  };

  const pull = () => {
    // 从没处理过的那截里切出完整的句子
    const rest = buffer.slice(cursor);
    const parts = splitSentences(rest, { minChars: ready.length ? 24 : 2 });
    if (parts.length <= 1) return; // 只有一截还没成句的尾巴，等更多字
    // 最后一段可能还没写完，留着
    const take = parts.slice(0, -1);
    for (const t of take) ready.push(t);
    cursor += take.join("").length;
    poke();
  };

  const task = chatWithFallback(endpoint, fallback, messages, params, {
    signal,
    /*
     * 少思考。默认开着，角色那栏能关。
     *
     * 这是通话延迟的**大头**：实测 gemini-3.8-flash 一轮生成 611–2212 个
     * token，而实际说出口的只有 23–67 字 —— 剩下全是思考，一轮等 8 到 25 秒。
     * 具体发什么字段、关不掉的型号怎么降档，见 llm.js:THINKING_LADDER。
     */
    noThinking: role?.call?.noThinking !== false,
    onDelta: (chunk) => {
      buffer += chunk;
      pull();
    },
  })
    .then((r) => {
      // 收尾：把剩下的尾巴也算成一句
      const rest = buffer.slice(cursor).trim();
      if (rest) ready.push(rest);
      done = true;
      poke();
      return r;
    })
    .catch((e) => {
      failed = e;
      done = true;
      poke();
    });

  let seq = 0;
  while (true) {
    if (ready.length === 0) {
      if (done) break;
      // 等下一句攒齐，或者等整段结束
      await new Promise((resolve) => {
        wake = resolve;
        // 兜底：万一 onDelta 一直不来（非流式的上游），别死等
        setTimeout(resolve, 500);
      });
      continue;
    }

    const raw = ready.shift();
    if (signal?.aborted) break;

    yield* sayOne(raw, { config, voiceId: voice.voiceId, sep, seq: seq++, voice });
  }

  await task;
  if (failed) throw failed;
}

/**
 * 把一句话合成出来。`runCallTurn` 和 `synthesizeSay` 共用这一段。
 *
 * 是生成器而不是普通函数，只为了「整句都是标记、没字可念」那种情况能
 * **一个都不 yield**（而不是 yield 一个空的让调用方再判一次）。
 *
 * @yields {{text: string, audio: Buffer|null, media: object[], seq?: number, hangUp?: boolean}}
 */
async function* sayOne(raw, { config, voiceId, sep, seq, voice }) {
  /*
   * 角色要挂电话吗 —— **在剥标记之前**就看。
   *
   * 下面 speakableFrom 会把 [结束通话] 剥掉（不然会被念出来），而调用方拿到的
   * text 是剥过的。以前挂断是在调用方对 text 拼起来那一段判的，于是永远看不到
   * 这个标记，角色自己挂电话从来没生效过（用户实测「你挂一下」它不挂）。
   * 所以这里单独带一个 hangUp 出去；整句只有这个标记、没字可念时也要 yield。
   *
   * **判据必须用 calltags.js 那一份**，别在这里另写一条正则：抄过来的那条
   * 反斜杠被吃掉了（`/[s*结束通话s*]/` 其实是个字符类），于是只要这一句里出现
   * 小写 s、星号，或者「结束通话」里任意一个字，就判成要挂 —— 英文回复几乎
   * 句句带 s，表现是角色说完第一句就莫名挂断，而上下文里压根找不到那个标记。
   */
  const { hangUp } = readHangUp(raw);
  /*
   * 功能保留，但不念出来。
   *
   * `splitMedia` 把这一句切成一条条带类型的 part（`media.js:250`）。只有
   * `text` 那些拿去念；转账、链接卡片、图片那些**照常交给各自的执行器**发出去
   * —— 打电话时角色突然想转个钱，这很真实，只是不该念出「transfer 冒号 4000」。
   */
  const parts = splitMedia(raw);
  /*
   * 语气标签留不留，跟着这一家 TTS 认不认走（见 callVoice）。认的话
   * `[warmly]` / `[sighs]` 原样交给它念 —— 发语音条那条路一直是这个待遇，
   * 通话这条以前一律剥，于是电话里的角色永远没有语气。
   */
  const speakable = speakableFrom(parts, sep, { keepTone: Boolean(voice?.keepTone) });
  const media = parts.filter((p) => p.kind !== "text");

  /*
   * 整句只剩语气标签（切句切出来一个光秃秃的 `[sighs]`）—— 当没字可念。
   *
   * 留着标签送进 ElevenLabs 会直接 400：它把方括号当 speaker tag 剥掉之后
   * 什么都不剩（「Input at position 0 has empty text」）。
   */
  if (speakable && !stripToneTags(speakable)) {
    if (media.length || hangUp) yield { text: "", audio: null, media, hangUp };
    return;
  }

  if (!speakable) {
    // 整句只有标记（比如单独一个 [transfer:…] 或 [结束通话]），不用合成，
    // 但媒体和挂断要带出去
    if (media.length || hangUp) yield { text: "", audio: null, media, hangUp };
    return;
  }

  let audio = null;
  try {
    /*
     * 语言和口音跟发语音条用的是**同一份**配置（角色栏「发送语音」里那两项）：
     * 不同步的话同一个角色在短信里是英音、电话里却是美音，很怪。
     */
    const out = await synthesizeVoice(config.ttsApi, voiceId, speakable, SCOPE, {
      language: voice?.language ?? "",
      accent: voice?.accent ?? "",
      channelId: voice?.channelId ?? "",
    });
    audio = out?.buffer ?? null;
  } catch (e) {
    /*
     * 合成失败不中断这一轮。
     *
     * 对方听不到这一句，但剩下的句子还能说 —— 比整通电话哑掉好。
     * TTS 四家全没配的时候也走这儿（`synthesizeVoice` 返回 null）。
     */
    logWarn(SCOPE, `这一句没合成出来：${speakable.slice(0, 30)}`, e);
  }

  yield { text: speakable, audio, media, seq, hangUp };
}

/**
 * 把一段**已经写好**的话合成好 —— 不打模型。
 *
 * 现在只有一个用处：接通后的开场白。角色在答应接电话的那一轮里就把它写好了
 * （`[接受通话]` 后面那段），所以这里只剩合成，省掉一整轮模型（实测 8 到
 * 25 秒，对方接起来先听一片沉默）。
 *
 * ── 为什么是「全部做完再返回」，不是边做边吐 ──
 *
 * 模型那条路必须边做边吐（第一句一凑齐就播，见 runCallTurn 的文件头）。
 * 开场白正相反：它在**接通之前**就开始合成了 —— 角色答应接之后，浏览器要开、
 * 对方还要在 iPhone 上点「允许」，实测这段死时间十几秒。合成塞进这段时间里
 * 做完，接通那一刻只剩「把字节发给节点」。
 *
 * 所以这里要赶的不是「现在出第一句」，而是「接通那一刻一句都不等」。
 * 返回的形状和 `runCallTurn` 产出的一致，调用方不用分叉。
 *
 * @param {object} args
 * @param {object} args.config
 * @param {object} args.role
 * @param {string} args.text 要说的话
 * @returns {Promise<object[]>} 几句 `{text, audio, media, seq}`
 */
export async function synthesizeSay({ config, role, text }) {
  const sep = config?.chat?.separator ?? "$";
  const voice = callVoice(config, role);
  const out = [];
  let seq = 0;
  for (const piece of splitSentences(String(text ?? ""), { minChars: 24 })) {
    for await (const part of sayOne(piece, { config, voiceId: voice.voiceId, sep, seq: seq++, voice })) {
      out.push(part);
    }
  }
  return out;
}

/**
 * 通话里念字用哪个音色、什么语言口音、语气标签留不留。
 *
 * 四样全是**借发语音条那套**（`role.voiceSend`）：音色一直是借的（见
 * `config.js:2280`），语言和口音以前漏了 —— 于是角色栏里填了 `en-GB` +
 * `strong British accent`，短信里的语音条是英音、电话里却是美音。
 *
 * `keepTone` 跟着挑中的那一家 TTS 走（`media.js:pickTtsSource` 的 `keepTags`）：
 * 认方括号标签的（ElevenLabs v3 起、Fish Audio S2 系）就把 `[sighs]` 留给它念，
 * 不认的照旧剥掉 —— 不然语音里会真的说一句 "sighs"。
 *
 * **不看 `voiceSend.enabled`**：那个开关管的是线上要不要把回复转成语音条，
 * 打电话本来就是说话，和它无关（和 `index.js:3968` 线下念台词同一个理由）。
 */
export function callVoice(config, role) {
  return {
    voiceId: role?.voiceSend?.voiceId ?? "",
    channelId: role?.voiceSend?.channelId ?? "",
    language: role?.voiceSend?.language ?? "",
    accent: role?.voiceSend?.accent ?? "",
    keepTone: Boolean(pickTtsSource(config?.ttsApi, { channelId: role?.voiceSend?.channelId })?.keepTags),
  };
}

/**
 * 这一轮给模型的那条用户消息。
 *
 * 三种来源各有自己的前缀，都带上**已接通多久** —— 模型据此知道这段是打电话
 * 说的、聊了多久了。
 *
 * @param {object} opts
 * @param {string} opts.kind "said"（说的）/ "typed"（iMessage 打字）/ "silence"（没说话）
 * @param {string} [opts.text] said 和 typed 要
 * @param {number} [opts.seconds] silence 要
 * @param {string} [opts.userName]
 * @param {boolean} [opts.micOff] 对方是不是正处在「可能关麦了」的状态
 * @param {string} [opts.tone] 这句话的语气（said 才有）
 * @param {string} [opts.ambience] 对方那头的背景声音（上一轮听出来的，见 listenAmbience）
 * @param {{text?: string, off?: boolean} | null} [opts.camera] 摄像头画面（见 seeFrame）
 */
export function callUserMessage({
  kind,
  text = "",
  seconds = 0,
  userName = "{{user}}",
  micOff = false,
  tone = "",
  ambience = "",
  camera = null,
}) {
  // 画面和背景是「那边的情况」，放在最前面；语气贴着那句话。
  // 画面的写法和默认通话预设「摄像头」那一节里说的一致，改一边要改两边
  const seen = camera?.off
    ? `[${userName}关掉了摄像头]`
    : camera?.text
      ? `[${userName}的摄像头画面：${camera.text}]`
      : "";
  const head =
    callPrefix(sayDuration(elapsedMs())) + seen + (ambience ? `[背景声音：${ambience}]` : "");

  if (kind === "silence") {
    return `${head}${silenceNotice(seconds, userName)}`;
  }
  if (kind === "typed") {
    // 关麦期间打字发来的，两个标记都带上
    const mic = micOff ? `[${userName}已关闭麦克风]` : "";
    return `${head}${mic}${typedPrefix(userName)}${text}`;
  }
  return `${head}${tone ? `[${userName}的语气：${tone}]` : ""}${text}`;
}

/** 被打断时补进历史的那一条。让模型知道它实际说出口了什么。 */
export function interruptedMessage(said, dropped, userName = "{{user}}") {
  return `${callPrefix(sayDuration(elapsedMs()))}${interruptedNotice(said, dropped, userName)}`;
}

/**
 * 这一轮聊完了，记下来。
 *
 * **走的是和发短信完全一样的两个函数** —— `appendTurn` 进存档、`recordTurn`
 * 进记忆/备忘录/日记的待总结。通话不另开一套记忆，这是用户钉死的。
 *
 * 由 imessage.js 那边调，因为 `afterTurn` 和 `appendTurn` 都在那个文件里，
 * 搬过来会互相 import。这里只管把内存里那份通话记录记上。
 */
export function noteTurn(user, assistant) {
  return recordCallTurn(user, assistant);
}

/** 挂断时写进聊天记录的那条。翻记录时看得到什么时候通过话。 */
export function callRecordLine(call) {
  const dur = sayDuration(call?.durationMs ?? 0);
  const turns = call?.turns ?? 0;
  return `通话结束 · ${dur}${turns ? ` · ${turns} 轮对话` : ""}`;
}
