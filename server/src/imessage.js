import { readBytes } from "./attachread.js";
import {
  cardHintFor,
  embeddedKindOf,
  fetchEmbeddedMedia,
  formatAmount,
  isCardUrl,
  mapsUrlFor,
  renderMapsLinks,
  sendTransferCard,
  updateTransferCard,
} from "./card.js";
import { watchChatBackground } from "./chatbg.js";
import { normalizeForHistory, splitBubbles, sleep } from "./delay.js";
import { checkLineRegistered, watchDelivery } from "./delivery.js";
import {
  chatWithFallback,
  describeImage,
  describeVideo,
  faultAdvice,
  transcribeAudio,
} from "./llm.js";
import { logDebug, logError, logInfo, logWarn } from "./logs.js";
import {
  DEFAULT_DIGITAL_TOUCH_PROMPT,
  DEFAULT_HANDWRITING_PROMPT,
  projectLabel,
  projectReady,
  resolveEndpoint,
  resolveImageEndpoint,
  resolveRoleEndpoints,
  resolveUser,
  roleForProject,
  userLabel,
} from "./config.js";
import { isCommandMessage, privacyOn, tryCommand } from "./commands.js";
import { buildEnv } from "./env.js";
import { pickEmoji } from "./emoji.js";
import { isDocAttachment, readDocument } from "./docread.js";
import { notePrompt } from "./lastprompt.js";
import { fetchLinkImages, fetchLinkVideos, renderLinks } from "./linkmeta.js";
import { igComposeNote, igRouteFor, publishIgTags, publishLines, tickIgQueue } from "./igrun.js";
import { splitIg, stripIgTags } from "./igtags.js";
import {
  WORD_EFFECT_LABELS,
  degradeToPlain,
  describeEffectId,
  generateImage,
  hasLeaveOnRead,
  resolveRefFile,
  shrinkForVision,
  splitMedia,
  stripLeaveOnRead,
  synthesizeVoice,
  takeEffectTag,
  takeReplyTag,
  toMp3ForStt,
} from "./media.js";
import { resolveMusic } from "./music.js";
import { clampInt } from "./normalize.js";
import {
  addPollOption,
  castVote,
  letterFor,
  matchOption,
  renderOptions,
  watchPolls,
} from "./poll.js";
import { findLatestPoll, findPoll, putPoll } from "./pollstore.js";
import { presetLabel, resolvePreset } from "./preset.js";
import {
  manualDiary,
  manualMemory,
  recordTurn,
  runSummaries,
} from "./memoryhooks.js";
import { memoryKeyFor } from "./memorystore.js";
import { endOffline, runOfflineTurn, summarizeNow } from "./offline.js";
import {
  closeOffline,
  currentStory,
  isOfflineOn,
  openOffline,
  readIndex,
} from "./offlinestore.js";
import {
  COOLDOWN_MS,
  FALLBACK_HOURS,
  buildProactiveInput,
  humanizeWait,
  judgeWaitByLLM,
  judgeWaitMs,
  msUntilFocusEnd,
  randomWaitMs,
} from "./proactive.js";
import { buildPrompt } from "./prompt.js";
import { dropSlot, pruneSchedule, saveSlot, slotsFor } from "./proactivestore.js";
import {
  appendAssist,
  assistTurns,
  buildAssistMessages,
  closeAssist,
  isAssistOn,
  openAssist,
  pruneAssist,
} from "./promptmode.js";
import { applyAndLog } from "./regex.js";
import { requestRestart } from "./restart.js";
import { appendTurn, recentMessages, sessionIdFor } from "./sessions.js";
import {
  DEVICE_NAMES,
  phonePool,
  phoneTargetIn,
  runPhone,
  runSpy,
  spyLegs,
  spyTargetIn,
  stripSpyTags,
} from "./spy.js";
import { renderLogo } from "./transferlogo.js";
import { findTransfer, putTransfer, readTransfers } from "./transferstore.js";
import { parseSearchQueries, runSearch, stripSearchTags } from "./websearch.js";

/**
 * iMessage 桥接模块（多号码版）。
 *
 * 一个 Photon 项目 = 一条 iMessage 号码 = 一条独立连接（下面叫 runner）。
 * 每个 runner 有自己的消息历史、去重集合、合并队列，互不干扰；
 * 绑定在这个项目上的角色决定人设、用哪几个模型、以及上下文限制。
 *
 * 历史和存档按「会话 ID」（角色名 + 对方号码，例 Jack1234658）索引，
 * 不按 space —— 这样存档文件名一眼能看出是谁跟谁的对话。
 *
 * 可选两种接入方式（由 project.mode 决定）：
 *  - "cloud"  使用 Photon 云端 provider（@spectrum-ts/imessage），
 *             需要 projectId + projectSecret（Spectrum 会自动铸币换取账号）。
 *  - "local"  使用本地 macOS provider（@spectrum-ts/imessage-local），
 *             直接读本机 Messages 数据库，无需云端凭据。
 *
 * 对外暴露 syncBridges() / stopBridge() / stopAllBridges() / getStatus()。
 */

/**
 * 单张图最大 20MB。
 *
 * **原来是 8MB，实机撞出来的**：`图片 9.8MB，超过 8MB 上限`。iPhone 随手一张
 * 就能过 8MB（实况照片、48MP 原图、HEIC 转出来的 JPEG），所以那道闸不是在防
 * 异常情况，是在拒正常照片。
 *
 * 当初写 8MB 的理由是「再大 base64 之后请求体会顶到中转站的上限」—— 那句话
 * 把两条路搞混了。12mb 那个限制是 **express 的 body-parser**，管的是浏览器往
 * 后端传（试图那个按钮）；对方发来的图是**后端直接往中转站发**，压根不经过
 * body-parser。这条路上没有 12mb 这道闸。
 *
 * 20MB 是照着这个文件里另外两道闸对齐的（语音、视频），而且 `spy.js` 和
 * `spyphone.js` 收图早就是 20MB —— 同一个仓库里同一件事只有这里卡在 8。
 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * 单条语音最大 20MB。
 *
 * 比图片宽是因为它进来时还没转码 —— iMessage 那个 caf 容器里可能是未压缩的
 * PCM，一分钟就能到十几 MB，过完 ffmpeg（16kHz 单声道 64k mp3）只剩几百 KB。
 * 真正上传给模型的是转码后的字节，所以这道闸放宽一点不会撑爆请求体。
 */
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

/**
 * 单段视频最大 20MB，**这是实测定出来的，不是随手取的整数**。
 *
 * 拿三档体积（12 / 19 / 52MB）问过用户那五家中转站：12MB 四家过一家 413，
 * 19MB 同样四家过，52MB 只有两家过。19MB 那档是「绝大多数能过」和
 * 「一半会被拒」的分界，所以闸设在 20MB。
 *
 * 另外两个理由：
 *
 *  - **时延**。19MB 在最慢那家要 69 秒（52MB 在能过的那家要 113 秒）。对方在
 *    iMessage 那头看着「已读」等回复，一分多钟已经是极限了；再放宽只会让
 *    等待变成分钟级。
 *  - **内存**。base64 会把字节撑成 4/3，20MB 的视频进请求体是 27MB 的字符串，
 *    加上原始 Buffer 本身，一段视频的峰值就是 47MB 上下。几条会话同时来的话
 *    这个数字是要乘的，所以不能按「最大那家能吃多少」来定。
 *
 * 超了**不下载**（见 readVideo：先看 SDK 给的 size 字段），也就是说超大的视频
 * 一个字节都不会进内存。
 */
const MAX_VIDEO_BYTES = 20 * 1024 * 1024;

const SEEN_MAX = 2000;

/**
 * 重启后，关机期间已经到点的主动消息延后多久再补（毫秒）。
 *
 * 不立刻开火有两个原因：一是号码刚连上，这会儿正忙着握手；二是一台机器上
 * 可能挂着十几条会话，全在同一毫秒往外发，看着像群发。一分钟足够连接稳住，
 * 对「隔几小时说句话」这个尺度来说也完全不算晚。
 */
const SETTLE_MS = 60_000;

/**
 * 到点了却拿不到 space 时，隔多久再试（毫秒）。
 *
 * 这种情况基本只有一个来源：号码这会儿没连上。**不撤表** —— 撤了就再也
 * 不会自己起来了，只把下一跳推远一点，等连接恢复。
 */
const RETRY_SPACE_MS = 10 * 60 * 1000;

/**
 * 提示词协助模式开着时，主动消息隔多久回来看一眼（毫秒）。
 *
 * 一次诊断聊十分钟二十分钟都正常，所以这里不轮询式地频繁重排。协助模式
 * 一结束，下一句正常对话就会把计时重新拉起来（见消息循环里的 armProactive），
 * 这个值只是「用户一直没说话、也一直没关协助模式」时的兜底。
 */
const ASSIST_HOLD_MS = 10 * 60 * 1000;

/**
 * 引用/撤回的环形缓冲每条会话留多少条。
 *
 * 30 条够覆盖 `[reply:N]` 和 `[undosend:N]` 的合理取值范围（规范里 N 是个位数），
 * 也够 `[reply:原文]` 在最近的对话里找到那句话。再多没意义 —— 苹果的撤回窗口
 * 只有两分钟，太早的消息就算翻出来也撤不掉；引用倒是能引很早的，但模型看到的
 * 上文本来也只有最近 maxContext 条。
 */
const MSG_RING = 30;

/**
 * 引用提示里被引用的原文最多带多少字。
 *
 * 超了截断加省略号：对方引用一段长文时，把整段原样塞进这轮的用户消息里
 * 会把真正要回的那句话淹掉。够认出「引的是哪条」就行了。
 */
const QUOTE_HINT_MAX = 80;

/**
 * 发出去到撤回之间等多久（毫秒）。
 *
 * 撤回这个功能演的是「说漏嘴之后心虚」，得让对方**真的看到过**那句话才有意义 ——
 * 发完立刻撤，对方屏幕上可能根本没来得及渲染，只剩一条「已撤回」的灰条，
 * 观感上和没发过一样，那句漏嘴的话白写了。
 */
const UNDO_DELAY_MS = 900;

/**
 * 撤回的时效窗口（毫秒）。
 *
 * 苹果给的窗口是 2 分钟，这里留 10 秒余量 —— 超了再调 unsend 是必然失败的，
 * 与其让 SDK 抛一个看不懂的错，不如提前跳过并记一条 warn。
 */
const UNDO_WINDOW_MS = 110_000;

/**
 * 连接挂掉之后自己重试的间隔（毫秒），按已经试过几次往后取，取完了一直用最后一个。
 *
 * **为什么必须有这个：** 以前失败的 runner 就那么留在表里挂着 `status:"error"`，
 * 而真正会去重启它的只有 `syncBridges`，那个函数只在「保存配置 / 登记号码 /
 * 手点重连 / 进程启动」时被调。于是开机时网络还没通、Spectrum 那一下
 * `fetch failed`，桥接就永久地死在那儿了 —— 网络两秒后恢复也没人管，
 * 界面上一直红着「启动失败」，用户只能自己去点重连。
 *
 * 间隔从 5 秒起、翻到 5 分钟封顶：前几次密是因为开机时那种失败通常几秒内
 * 就自愈了（网卡还没起来、DNS 还没通）；封顶是因为真正连不上的时候
 * （凭据被吊销、Photon 挂了）每 5 分钟打一次就够了，再密只是刷屏。
 */
const RETRY_DELAYS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];

/** projects[].id -> runner */
const runners = new Map();

/**
 * 丢掉某条会话（或全部会话）的内存历史，下一轮从磁盘重新读。
 *
 * **为什么必须有这个：** 内存历史和磁盘存档是两层，各管一件事（见 README
 * 的「对话记录」）。用户在「上下文」面板里清空/删除/改一条走的是
 * `PUT|DELETE /api/sessions/:id`，那只动磁盘 —— 挂着的 runner 手里还攥着
 * 一份完整的内存历史，下一轮照旧发给模型。表现就是「我明明清空了上下文，
 * 模型的思维链里还看得见我之前发的那几条」。
 *
 * 不做「改完存档就立刻回填内存」而是**直接丢掉**：回填要把裁剪、思维链剥离
 * 那套规则再走一遍，两条路很容易走出不一致。丢掉之后 handleTurn 开头本来
 * 就有「内存里没有就从磁盘读最后 maxContext 条」的分支，复用它只有一条路。
 *
 * 会话 ID 全局唯一（角色名 + 对方号码），所以不需要知道是哪个 runner，
 * 挨个问一遍就行 —— runner 数量是号码数量，个位数。
 *
 * @param {string} [sessionId] 不传 = 清掉所有会话的内存历史
 * @returns {number} 真正丢掉了几条会话的历史
 */
export function forgetHistory(sessionId) {
  let dropped = 0;
  for (const runner of runners.values()) {
    if (!sessionId) {
      dropped += runner.history.size;
      runner.history.clear();
      continue;
    }
    if (runner.history.delete(sessionId)) dropped += 1;
  }
  return dropped;
}

/**
 * 一条连接的全部状态。
 * 以前这些是模块级变量，现在每个项目一份。
 */
function createRunner(projectRefId) {
  return {
    projectRefId,
    status: "idle", // idle | connecting | connected | error
    mode: "cloud",
    error: null,
    startedAt: null,
    instance: null,
    // provider 的「窄化器」（imessage / localIMessage），startRunner 动态 import
    // 之后存下来。`platform(instance)` 才拿得到 space.get —— 主动消息重启后
    // 补 space 全靠它，见 ensureSpace
    platform: null,
    messageCount: 0,
    imageCount: 0,
    audioCount: 0,
    videoCount: 0,
    fingerprint: "", // 凭据/模式指纹，变了才需要重连
    // 云端模式的项目凭据。存一份在 runner 上是为了投递检测（delivery.js）——
    // 它挂在 noteSent 里，而那条路上只有 runner 和 ctx，够不到 project。
    // 本地 Mac 模式留空串：那边没有 Photon 可问（见 startRunner）
    projectId: "",
    projectSecret: "",
    history: new Map(), // spaceId -> [{role, content}]
    seen: new Set(), // 消息 id 去重
    pending: new Map(), // spaceId -> { texts, images, timer, space }
    // spaceId -> 还有几条消息正在拆附件。合并窗口到点时看它决定「发」还是
    // 「再等等」—— 图和文字被拆成两轮的根因就在这儿，见 holdPending
    holds: new Map(),
    chains: new Map(), // spaceId -> Promise（同一会话串行处理）
    proactive: new Map(), // spaceId -> 主动消息的调度槽，见 proactiveSlot
    // 最近一条入站消息所在的会话。Instagram 那条链路要用：角色在别人帖子底下
    // 评论完顺手发条短信，可发不出去的地方去 —— space 只能从入站消息上拿到。
    // 和 proactive 那个 Map 分开存：proactive 是按 spaceId 分的调度槽、还得
    // 角色开了主动消息才有；这个是「这个号现在能往哪儿发」，一份就够
    lastSpace: null, // { space, spaceId, peer, at } | null
    // 引用/撤回要的两个环形缓冲，都按 spaceId 分开、都只留最近 MSG_RING 条：
    // inbox 是对方发来的消息（[reply:N] 要按它数「倒数第 N 条」，
    // [reply:原文] 要在里面找那句话），outbox 是自己发出去的
    // （[undosend:N] 要拿 space.send() 还回来的那个 Message 才撤得掉）
    inbox: new Map(), // spaceId -> [{ id, text, message, at }]
    outbox: new Map(), // spaceId -> [{ message, at }]
    // 聊天背景变更：chatbg.js 那条独立 gRPC 订阅。只有角色开了
    // chatBackground.enabled 且是云端模式才起（见 startRunner）
    bgWatcher: null, // { stop() } | null
    // 这两条附加订阅都是「先返回、连接在后台慢慢建」的，所以起的过程中要立个牌子：
    // syncWatchers 会被反复调用（每次保存配置都调一次），光看 bgWatcher 是不是
    // null 的话，第一次还在 await 里就会被起第二遍，留下一条收不到停止指令的野订阅
    bgWatcherStarting: false,
    // peerKey -> 待认领的背景变更。用户换完背景不一定会马上说话，所以先存着，
    // 等这个人下一条消息进来时再塞进同一个合并槽里 —— 见 takeBgHint
    bgPending: new Map(),
    // 投票：poll.js 那条独立 gRPC 订阅。和 bgWatcher 同一个待遇 —— 只有角色开了
    // poll.enabled 且是云端模式才起（见 startPollWatcher）
    pollWatcher: null, // { stop() } | null
    pollWatcherStarting: false,
    // spaceId -> { title, at }。发起投票时那行标题会作为一条**独立的普通文本
    // 消息**再进来一次，靠这张表把它压掉，免得模型看两遍。见 notePollTitle
    pollTitles: new Map(),
    // peerKey -> 待认领的 tapback（对方给某条气泡贴的 emoji）。和 bgPending
    // 同一个路子，区别是**存数组** —— 一个人可以连着贴好几条，
    // 一条一条报给模型才说得清「哪句话被贴了什么」。见 takeReactHints
    reactPending: new Map(),
    // 「转出去一直没人收」的提醒定时器，按 `角色key::卡片guid` 索引。
    // 这张表**只是内存里的排期**，「提醒过了没有」那个事实记在磁盘上
    // （transferstore 的 reminded）—— 只提醒一次这件事不能靠定时器保证，
    // 定时器活不过重启。见 armTransferRemind
    transferRemind: new Map(),
    stopped: false, // stopBridge 之后消息循环要认得出自己已经过期
    retries: 0, // 连续失败了几次，决定下次等多久（见 RETRY_DELAYS）
    retryTimer: null, // 待触发的自动重连
    nextRetryAt: null, // 下次自动重连的时刻（ISO），给界面显示用
  };
}

/**
 * 只有影响「连不连得上」的字段进指纹。
 * 人设、上下文、发送节奏改了不该踢掉连接 —— 那些是每轮现读的。
 */
function fingerprintOf(project) {
  return [
    project.mode,
    project.mode === "local" ? project.localPath : project.projectId,
    project.mode === "local" ? "" : project.projectSecret,
  ].join("|");
}

/** 日志 scope 带上角色名，控制台里才分得清是哪个号在动。 */
function scopeOf(runner, base) {
  return runner.label ? `${base}·${runner.label}` : base;
}

/**
 * 从某个时刻到现在过了几秒，保留一位小数。
 *
 * 每个耗时步骤的「完成」那行都带上这个。不带的话日志只能回答「做完了吗」，
 * 回答不了「慢在哪一步」—— 而用户报上来的问题基本都是后者（「发视频要好久
 * 才回复」）。秒而不是毫秒：这些步骤都是几秒到几十秒的量级，毫秒只是噪音。
 */
function secsSince(startedAt) {
  return ((Date.now() - startedAt) / 1000).toFixed(1);
}

/**
 * 把一个地址归一成「人」的键，用来对上 chatbg.js 报上来的 peerKey。
 *
 * 两边必须算出同一个字符串，否则背景变更永远匹配不到发消息的那个人：
 *  - chatbg 拿到的是 chat guid（`iMessage;-;+1628...`），从最后一段抠出地址；
 *  - 这里拿到的是 message.sender.id，本来就是地址。
 * 归一规则和 chatbg.js:peerKeyFromChatGuid 一字不差 —— 邮箱转小写，
 * 号码只留数字和加号（iMessage 的地址可能带括号、空格、连字符）。
 *
 * 归一不出来就返回空串，调用方按「这条不算」处理。
 */
function peerKeyOf(address) {
  const raw = String(address ?? "").trim();
  if (!raw) return "";
  if (raw.includes("@")) return raw.toLowerCase();
  const digits = raw.replace(/[^\d+]/g, "");
  return digits.length >= 6 ? digits : "";
}

/** 背景变更提示最多留多久。超了就当没发生过，免得半天后才回一句莫名其妙的话。 */
const BG_HINT_TTL_MS = 10 * 60_000;

/**
 * 取走这个人待认领的背景变更提示，顺便把过期的清掉。
 *
 * 用户换完背景不一定马上说话（可能几分钟后才开口），所以不能像撤回那样
 * 立刻发一条 —— 那会变成角色主动搭话。存下来、下条消息一起送进去，
 * 时间上也正好是同一次「轮到你说话」。
 *
 * 提示语里的 {{user}} 是字面量，和 handleUserUnsend 里那句撤回提示一个规矩，
 * 由 prompt.js:applyVars 在拼提示词时才替换。
 */
function takeBgHint(runner, peerKey) {
  if (!runner.bgPending.size) return "";
  const now = Date.now();
  for (const [key, item] of runner.bgPending) {
    if (now - item.at > BG_HINT_TTL_MS) runner.bgPending.delete(key);
  }
  if (!peerKey) return "";
  const hit = runner.bgPending.get(peerKey);
  if (!hit) return "";
  runner.bgPending.delete(peerKey);
  return hit.kind === "removed"
    ? "[系统提示:{{user}}移除了当前聊天背景]"
    : "[系统提示:{{user}}更改了当前聊天背景]";
}

/* ================= 回应（tapback）与文字效果 ================= */

/** 一个人最多攒几条待认领的 tapback。再多也只会把提示词灌满，报最近的几条就够。 */
const REACT_PENDING_MAX = 5;

/** 被贴的那句原文报给模型时截到多长。只是用来指认「哪一句」，不需要全文。 */
const REACT_QUOTE_MAX = 30;

/**
 * 对方给某条气泡贴了个 emoji，先攒着。
 *
 * 为什么不立刻发一轮：贴 tapback 是个很轻的动作，对方常常连着贴好几条，
 * 也常常贴完就没下文了。每贴一次就让角色开口回一句，既吵又不像人。
 * 所以和背景变更同一个待遇 —— 存下来，等这个人**下一条真的消息**进来时
 * 一起送进去（takeReactHints），时间上正好是同一次「轮到你说话」。
 *
 * 存的是已经成文的那句提示，不是原始对象 —— 被贴的那条 Message 在
 * content.target 上，现在不抠出来，等会儿 target 可能已经不在手边了。
 *
 * `hint` 是给**收转账**用的口子：那件事也是「对方贴了个 emoji」触发的，
 * 但要说的不是「他贴了个 👍」而是「他收下了你转的钱」，emoji 本身反倒
 * 不重要（贴什么都算收）。给了 hint 就整句原样存，emoji / quoted 不看。
 */
function noteReaction(runner, peerKey, emoji, quoted, hint) {
  if (!peerKey) return;
  if (hint) {
    const list = runner.reactPending.get(peerKey) ?? [];
    list.push({ hint, at: Date.now() });
    while (list.length > REACT_PENDING_MAX) list.shift();
    runner.reactPending.set(peerKey, list);
    return;
  }
  if (!emoji) return;
  const list = runner.reactPending.get(peerKey) ?? [];
  list.push({ emoji, quoted, at: Date.now() });
  // 超了从头上丢：留新的那几条比留最早的有用
  while (list.length > REACT_PENDING_MAX) list.shift();
  runner.reactPending.set(peerKey, list);
}

/**
 * 取走这个人待认领的 tapback 提示，顺便把过期的清掉。
 *
 * TTL 和背景变更共用一个（BG_HINT_TTL_MS）—— 都是「刚刚发生的事才值得提」，
 * 半小时前贴的一个 👍 现在才说出来只会让对话莫名其妙。
 *
 * 提示语里的 {{user}} 留字面量，由 prompt.js:applyVars 在拼提示词时才替换，
 * 和 takeBgHint、handleUserUnsend 一个规矩。
 *
 * @returns {string[]} 一条一行，没有就是空数组
 */
function takeReactHints(runner, peerKey) {
  if (!runner.reactPending.size) return [];
  const now = Date.now();
  for (const [key, list] of runner.reactPending) {
    const live = list.filter((r) => now - r.at <= BG_HINT_TTL_MS);
    if (live.length) runner.reactPending.set(key, live);
    else runner.reactPending.delete(key);
  }
  if (!peerKey) return [];
  const hits = runner.reactPending.get(peerKey);
  if (!hits?.length) return [];
  runner.reactPending.delete(peerKey);
  return hits.map((r) =>
    // 已经成文的（收转账那一路）直接用
    r.hint
      ? r.hint
      : r.quoted
        ? `[系统提示:{{user}}给"${r.quoted}"这句话贴上了${r.emoji}的贴纸]`
        : `[系统提示:{{user}}给你的一条消息贴上了${r.emoji}的贴纸]`
  );
}

/**
 * 这条入站消息上带的文字效果，说成一句给模型看的系统提示。
 *
 * 两类东西，来源完全不同，但对模型来说是同一件事「对方把某段字弄花了」：
 *
 *  - **逐词效果**：`message.formatting[]` 里 effectName ∈ 八个白名单值的那些项。
 *    ⚠ `start` / `length` 是 **UTF-16 code unit 偏移**，配 `message.nativeText`
 *    用（不是我们拼过 cardHint 的那个 userText）。JS 的 String.prototype.slice
 *    本来就按 code unit 走，所以直接切就是对的 —— **别**转成 code point 数组，
 *    那样带 emoji 的句子会整体错位。
 *    白名单之外的一律不要（粗体/斜体/下划线/删除线），用户原话「其他不要」。
 *  - **屏幕/气泡特效**：`message.expressiveSendStyleId` 反查 media.js 那张表，
 *    认不出来的当没有。
 *
 * 认不出的 effectName 打一条 debug —— 这八个字符串是照 SDK 的 d.ts 写的，
 * 真机上要是对不上，日志里一眼就能看见该改成什么。
 *
 * @returns {string} 空串表示这条消息没带任何效果，调用方就不 enqueue
 */
function effectHintOf(message, scope) {
  const notes = [];
  const native = String(message?.nativeText ?? "");

  // 屏幕/气泡特效是**整条消息**的属性，所以引的是整句话（截断）——
  // 用户给的样板就是 `对"我爱你"这段文字使用了{{屏幕/气泡效果}}`
  const style = describeEffectId(message?.expressiveSendStyleId);
  if (style) {
    const whole = clip(native, REACT_QUOTE_MAX);
    notes.push(
      whole
        ? `对"${whole}"这段文字使用了${style.label}${style.scope}效果`
        : `这条消息带了${style.label}${style.scope}效果`
    );
  }

  const formatting = Array.isArray(message?.formatting) ? message.formatting : [];
  for (const item of formatting) {
    const name = String(item?.effectName ?? "").trim();
    if (!name) continue;
    const label = WORD_EFFECT_LABELS[name];
    if (!label) {
      logDebug(scope, `不认识的逐词效果 effectName=${name}，这条先忽略`);
      continue;
    }
    const start = Number(item?.start);
    const length = Number(item?.length);
    if (!Number.isFinite(start) || !Number.isFinite(length) || length <= 0) continue;
    const piece = native.slice(start, start + length).trim();
    if (!piece) continue;
    notes.push(`对"${piece}"这几个字使用了${label}（${name}）逐词效果`);
  }

  if (!notes.length) return "";
  return `[系统提示:{{user}}${notes.join("；")}。]`;
}

/** 引原文时统一的截断：超了掐掉加省略号，只是用来指认「哪一句」。 */
function clip(text, max) {
  const one = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

export function getStatus() {
  const projects = [];
  for (const runner of runners.values()) {
    projects.push({
      id: runner.projectRefId,
      roleId: runner.roleId ?? "",
      roleName: runner.roleName ?? "",
      label: runner.label ?? "",
      mode: runner.mode,
      linePhone: runner.linePhone ?? "",
      status: runner.status,
      error: runner.error,
      // 界面靠这两个把「启动失败」说成「还在自己重试」——
      // 没有它们的话一条正在退避的连接看着和永久死掉的一模一样
      retries: runner.retries ?? 0,
      nextRetryAt: runner.nextRetryAt ?? null,
      startedAt: runner.startedAt,
      messageCount: runner.messageCount,
      imageCount: runner.imageCount,
      audioCount: runner.audioCount,
      videoCount: runner.videoCount,
    });
  }
  const summary = {
    total: projects.length,
    connected: projects.filter((p) => p.status === "connected").length,
    messageCount: projects.reduce((n, p) => n + p.messageCount, 0),
    imageCount: projects.reduce((n, p) => n + p.imageCount, 0),
    audioCount: projects.reduce((n, p) => n + p.audioCount, 0),
    videoCount: projects.reduce((n, p) => n + (p.videoCount ?? 0), 0),
  };
  return { projects, summary };
}

function noteSeen(runner, id) {
  runner.seen.add(id);
  if (runner.seen.size > SEEN_MAX) {
    const first = runner.seen.values().next().value;
    runner.seen.delete(first);
  }
}

/** 从 message.content 提取纯文本（只处理 text / markdown，忽略附件等）。 */
function extractText(content) {
  if (!content) return null;
  if (typeof content === "string") return content;
  if (content.type === "text") return content.text;
  if (content.type === "markdown") return content.markdown;
  return null;
}

/** 判断一条 attachment 内容是不是图片。 */
function isImageAttachment(content) {
  return (
    content?.type === "attachment" &&
    typeof content.mimeType === "string" &&
    content.mimeType.startsWith("image/")
  );
}

/**
 * 判断一条内容是不是音频。
 *
 * **两种 type 都要认，这是实机日志教的**：iMessage 的语音条（按住话筒录的
 * 那种）在 Spectrum 里是**独立的 `type:"voice"`**，不是 `attachment` ——
 * 只认 attachment 的话它会一路掉到「都不是就跳过」，日志里只留一行
 * 「忽略一条 voice 类型的消息」，模型什么都不知道。而当作普通文件发过来的
 * 音频（拖一个 mp3 进对话）走的才是 `attachment`。
 *
 * 除了 type，故意只看 `audio/` 前缀，不对具体子类型做白名单：苹果自家的
 * 容器（`.caf`）Photon 报成什么并不确定 —— 可能是 `audio/x-caf`，也可能是
 * `audio/amr`、`audio/mp4`。列白名单只会把真语音挡在外面。
 *
 * 反正后面 readAudio 会把它整个过一遍 ffmpeg 转成 mp3，认错了也就是白转
 * 一次（转不动会原样退回），比漏掉划算。
 */
function isAudioAttachment(content) {
  if (content?.type === "voice") return true;
  return (
    content?.type === "attachment" &&
    typeof content.mimeType === "string" &&
    content.mimeType.startsWith("audio/")
  );
}

/**
 * 判断一条 attachment 内容是不是视频。
 *
 * SDK 里**没有** `type:"video"` 这种东西（翻过 core 的 contentSchema，音频有
 * 独立的 `voice`，视频没有对应物），所以视频就是一条普通 attachment，只能靠
 * mime 前缀认。这也是它以前被静默丢掉的原因：过不了图片、语音、文件三个
 * 分类器，就一路掉到「都不是就跳过」，控制台只留一行「忽略一条 attachment
 * 类型的消息」—— 对方发了段视频，模型完全不知道。和卡片当初那个洞一样。
 *
 * 和 isAudioAttachment 一样只看前缀不列白名单：iPhone 拍的是 `video/quicktime`
 * （.mov），转发过来的可能是 `video/mp4`，Android 那边来的还可能是 `video/3gpp`。
 * 认错了的代价只是白传一次，漏掉的代价是角色答得像什么都没收到。
 *
 * **必须排在 isDocAttachment 之前挑走**：docread 那边对没有后缀的附件会看
 * mimeType 兜底，虽然它兜的三种里没有 video/*，但顺序摆对了就不用依赖那个细节。
 */
function isVideoAttachment(content) {
  return (
    content?.type === "attachment" &&
    typeof content.mimeType === "string" &&
    content.mimeType.startsWith("video/")
  );
}

/**
 * 把一条消息的 content 摊平成「一层裸内容」的数组。
 *
 * SDK 会用两种壳子包住真正的内容：
 *  - group：一次发多张图（相册）会打成一个 group，图片都在 items[].content 里。
 *    iMessage 里长按发一组图、或者一条消息里同时有文字和图，走的就是这条。
 *  - reply：引用回复，被引用的那条在 .content 里。
 *
 * 不摊平的话 isImageAttachment(content) 看到的是 type:"group"，既不是文本
 * 也不是图片，整条消息就被当成「贴纸/位置」跳过了 —— 这就是发图没有任何
 * 回复、控制台只留一行「忽略一条 group 类型的消息」的原因。
 *
 * group 不嵌套（SDK 的 group() 构造器保证），所以只摊一层就够；reply 里
 * 也不允许再套 group，一层同样够。
 */
function flattenContent(content) {
  if (!content) return [];
  if (content.type === "group") {
    return (content.items ?? []).map((item) => item?.content).filter(Boolean);
  }
  if (content.type === "reply" && content.content) return [content.content];
  return [content];
}

/* ================= 引用与撤回：两个环形缓冲 ================= */

/**
 * 往某条会话的环形缓冲里压一条，超了从头上丢。
 *
 * 按 spaceId 分开存，不按 sessionId —— 撤回和引用都要拿 SDK 的 Message 对象去
 * 调接口，那是**连接级**的东西，换了号码就不是同一条了；sessionId 只是给
 * 存档命名用的。
 */
function pushRing(map, spaceId, item) {
  const list = map.get(spaceId) ?? [];
  list.push(item);
  while (list.length > MSG_RING) list.shift();
  map.set(spaceId, list);
  return list;
}

/** 取某条会话的环形缓冲（没有就是空数组，不建表）。 */
function ringOf(map, spaceId) {
  return map.get(spaceId) ?? [];
}

/**
 * 记下一条刚发出去的消息，好让后面的 `[undosend:N]` 能撤掉它。
 *
 * `space.send()` 还回来的那个 Message **是撤回唯一的把手** —— SDK 明说
 * `space.getMessage(id)` 捞回来的会被当成入站消息，对它调 unsend 直接抛错。
 * 以前这个返回值是丢掉的，所以撤回功能压根无从下手。
 *
 * 发送方法本来就可能返回 undefined（平台不支持时 SDK 会警告并跳过），
 * 那种情况不记 —— 记进去等于在环里埋一条撤不掉的占位，把 N 数错。
 *
 * 顺带挂投递检测。选这儿是因为**所有**出站消息都从这一个口子过（文字、图片、
 * 语音、卡片、引用回复各有各的发送路径，但都要来这儿登记），挂在别处必定漏。
 * watchDelivery 自己是攒批 + 延时的，这里只是登记，不花时间、不抛错。
 */
function noteSent(runner, ctx, message) {
  const spaceId = ctx?.spaceId;
  if (spaceId && message) pushRing(runner.outbox, spaceId, { message, at: Date.now() });
  if (message?.id && ctx?.peer) {
    watchDelivery({
      projectId: runner.projectId,
      projectSecret: runner.projectSecret,
      label: scopeOf(runner, "投递"),
      guid: String(message.id),
      peer: ctx.peer,
    });
  }
  return message;
}

/**
 * 记下一条对方发来的消息，好让后面的 `[reply:N]` / `[reply:原文]` 能指回它。
 *
 * 文本和图片都记：`[reply:N]` 数的是「对方的倒数第 N 条消息」，对方发了张图
 * 也占一条，漏记会让 N 整体错位。图片那条 text 是空串，所以它只可能被数字
 * 形式引到 —— 原文匹配那条路 want 非空，撞不上空串。
 *
 * at 是收到的时刻，撤回那边要拿它算「几秒内撤回的不给模型看」。
 */
function noteInbound(runner, spaceId, message, text) {
  if (!spaceId || !message) return;
  pushRing(runner.inbox, spaceId, {
    id: message.id ?? "",
    text: String(text ?? ""),
    message,
    at: Date.now(),
  });
}

/**
 * 一条对方发来的消息里，被引用的那条原文是什么。
 *
 * SDK 把引用包成 `{type:"reply", content, target}`，flattenContent 只取了
 * `.content`（要发给模型的正文），`.target` 就丢了 —— 于是模型看到的是一句
 * 没头没尾的「我刚刚说我在外面」，完全不知道对方是在回哪条。这个函数负责把
 * target 捞回来。
 *
 * 拿不到就返回空串，几种情况都算拿不到：
 *  - 云端回源失败时 SDK 给的是个占位 target（`stub:true`），里面没有正文；
 *  - 引用的是图片/语音（extractText 只认文本）；
 *  - 本地 Mac 模式下 target 只有 id、没内容。
 * 这几种都退化成「当作没引用」—— 硬编一句「引用了一条消息」反而会让模型
 * 去猜引的是什么。
 */
function quotedTextOf(message) {
  const content = message?.content;
  if (content?.type !== "reply") return "";
  const target = content.target;
  if (!target || target.custom?.stub) return "";
  // 被引的那句要是一条地图链接，同样换成 `[location:…]`（理由见正文那处）
  const raw = renderMapsLinks(extractText(target.content));
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > QUOTE_HINT_MAX ? `${text.slice(0, QUOTE_HINT_MAX)}…` : text;
}

/**
 * 把 `[reply:…]` 里那串东西解析成缓冲区里的某一条。
 *
 * 两种写法（见 preset.js 的 quote 正文）：
 *  - 纯数字 1–99 → 对方的倒数第 N 条（1 = 最后一条）；
 *  - 其它 → 照原文找，先要求整条完全相等，找不到再退一步找「包含」。
 *
 * 先全等再包含，是因为规范里要求「必须与已发送的原文完全一致」，但模型很爱
 * 顺手把标点改掉或者只抄前半句；退到包含能救回大部分这种，同时不至于把
 * 「嗯」这种一个字的引用匹配到随便哪条。**从后往前找** —— 同一句话说过两遍时
 * 引的几乎总是近的那条。
 *
 * @returns {object|null} SDK 的 Message 对象，找不到返回 null（调用方发普通消息）
 */
function resolveReplyTarget(runner, spaceId, spec) {
  const raw = String(spec ?? "").trim();
  if (!raw) return null;
  const list = ringOf(runner.inbox, spaceId);
  if (!list.length) return null;

  if (/^\d{1,2}$/.test(raw)) {
    const n = Number(raw);
    if (n < 1 || n > list.length) return null;
    return list[list.length - n]?.message ?? null;
  }

  const norm = (s) => String(s ?? "").replace(/\s+/g, "").trim();
  const want = norm(raw);
  if (!want) return null;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (norm(list[i].text) === want) return list[i].message ?? null;
  }
  // 退一步：太短的不做包含匹配，「好」「嗯」能撞上任何一条
  if (want.length < 3) return null;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const have = norm(list[i].text);
    if (have && (have.includes(want) || want.includes(have))) return list[i].message ?? null;
  }
  return null;
}

/**
 * 对方撤回了一条消息，决定要不要告诉模型、告诉到什么程度。
 *
 * ⚠ 这个分支目前**永远不会触发**，原因在 SDK 那边：@spectrum-ts/imessage 的
 * toMessageItem 只认 message.received / message.reactionAdded / message.read
 * 三种上游事件，message.unsent 落进最后那个 `values: []` 被丢掉了；本地 Mac
 * 模式同理，它读库时直接跳过已撤回的行。等 SDK 补上这个事件，这里自动活过来，
 * 在那之前角色配置里那三个开关是「配好了但没东西喂给它们」。
 *
 * 规则按用户的规范来：
 *  - seeUser 关（默认）→ 模型什么都看不到，跟没发生过一样；
 *  - 开着，但撤得比 graceSeconds 还快 → 也当没发生过。打错字、发错人就是这几秒
 *    里撤的，这种既不该让模型看见，也不该白白触发一轮回复；填 0 表示每条都算；
 *  - 剩下的按 chance 掷一次骰子：中了连原文一起给模型看，没中只说撤了一条。
 *
 * 提示里留的是字面 {{user}}，和 env.js 里那些前缀一个路子 —— 存档存字面量，
 * 换了用户人设名以后回看历史才不会张冠李戴，替换在 prompt.js 里做。
 */
function handleUserUnsend(getConfig, runner, space, spaceId, message, peer) {
  const config = getConfig();
  const role = currentRole(config, runner);
  const cfg = role?.undoSend;
  if (!cfg?.seeUser) return;

  const scope = scopeOf(runner, "桥接");
  // 撤回事件带的是「被撤的那条」的 id，去环形缓冲里换回原文和收到的时间。
  // 拿不到 id 就退而认最后一条 —— 撤回几乎总是撤刚发的那句
  const targetId =
    message?.content?.target?.id ?? message?.content?.targetId ?? "";
  const list = ringOf(runner.inbox, spaceId);
  const idx = targetId
    ? list.findIndex((it) => it.id && it.id === targetId)
    : list.length - 1;
  const slot = idx >= 0 ? list[idx] : null;
  // 撤掉的那条不能再被 [reply:] 引到 —— 它在对方屏幕上已经没了
  if (idx >= 0) list.splice(idx, 1);

  const grace = Number(cfg.graceSeconds) || 0;
  if (grace > 0 && slot && Date.now() - slot.at < grace * 1000) {
    logDebug(scope, `对方在 ${grace} 秒内撤回了一条消息，不告诉模型`);
    return;
  }

  // 原文没留住（图片、或者早被挤出环形缓冲了）就只能发不带原文的那句
  const seen = slot?.text && Math.random() * 100 < (Number(cfg.chance) || 0);
  const hint = seen
    ? `[{{user}}撤回了一条消息，但你已经看到了，原内容是：${slot.text}]`
    : "[{{user}}撤回了一条消息]";
  logInfo(scope, `对方撤回了一条消息${seen ? "（原文一起给模型看）" : ""}`);
  enqueue(getConfig, runner, space, spaceId, { text: hint, message }, peer);
}

/**
 * 把 attachment 读成 base64。
 * SDK 的 read() 是懒加载的（云端要回源下载），所以这里才是真正拿字节的地方。
 */
async function readImage(content, scope = "桥接") {
  const mb = (n) => (n / 1024 / 1024).toFixed(1);
  const cap = MAX_IMAGE_BYTES / 1024 / 1024;

  // 和视频一样先问 SDK 报的大小：超了压根不下载（size 是可选字段，没有就跳过这步）
  const claimed = Number(content?.size ?? 0);
  if (claimed > MAX_IMAGE_BYTES) {
    throw new Error(`图片 ${mb(claimed)}MB，超过 ${cap}MB 上限（没有下载）`);
  }

  const buf = await readBytes(content, scope, "图片");
  if (!buf?.length) throw new Error("附件读出来是空的");
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new Error(`图片 ${mb(buf.length)}MB，超过 ${cap}MB 上限`);
  }

  /*
   * 压小再识别。上限判定用的是**原图**大小（上面那两处）—— 压缩是优化，
   * 不该顺手把「超过 20MB 上限」这条规则放宽；压不动时（没 ffmpeg / 转失败）
   * 原样退回，识别照跑，只是慢一些。详见 media.js:shrinkForVision。
   */
  const small = await shrinkForVision(buf, {
    mimeType: content.mimeType,
    name: content.name,
    scope,
  });
  return {
    base64: small.buffer.toString("base64"),
    mimeType: small.mimeType,
    name: content.name,
  };
}

/**
 * 把语音附件读出来、转成 mp3、再转 base64。
 *
 * 比 readImage 多一步转码，理由见 media.js:toMp3ForStt —— 一句话说就是
 * iMessage 的语音条是 caf，而 Gemini 不收 caf。
 *
 * 顺带把原始的 mimeType / 后缀原样记进日志：到今天为止我们还没有一条实机
 * 日志能证明 Photon 把 iMessage 语音条的 mimeType 报成什么，用户下次发一条
 * 语音，答案就在这行里。
 */
async function readAudio(content, scope) {
  const buf = await readBytes(content, scope, content.type === "voice" ? "语音" : "音频");
  if (!buf?.length) throw new Error("附件读出来是空的");
  if (buf.length > MAX_AUDIO_BYTES) {
    throw new Error(
      `语音 ${(buf.length / 1024 / 1024).toFixed(1)}MB，超过 ${MAX_AUDIO_BYTES / 1024 / 1024}MB 上限`
    );
  }

  const name = content.name ?? "";
  const ext = (name.split(".").pop() ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  logInfo(
    scope,
    `收到${content.type === "voice" ? "语音条" : "音频文件"}：${(buf.length / 1024).toFixed(0)}KB，` +
      `mimeType=${content.mimeType ?? "（空）"}，文件名=${name || "（空）"}` +
      (typeof content.duration === "number" ? `，时长=${content.duration}s` : "")
  );

  const out = await toMp3ForStt(buf, { ext, mimeType: content.mimeType, scope });
  return {
    base64: out.buffer.toString("base64"),
    mimeType: out.mimeType,
    name,
    // type:"voice" 自带 duration（苹果录制时写进去的），比 ffmpeg 探出来的准；
    // 当文件发来的音频没这个字段，退回 ffmpeg 那个
    seconds: typeof content.duration === "number" ? content.duration : out.duration,
  };
}

/**
 * 把视频附件读成 base64，**带一个撒手用的 release()**。
 *
 * ── 为什么这条路要单独管内存 ──
 *
 * 图片 8MB、语音转完码只剩几百 KB，都小到可以放着不管。视频是 20MB 起步，
 * base64 之后 27MB，而它在队列里要躺满 queueWait 秒、再跟着 handleTurn 走完
 * 整轮（打模型、发气泡、写存档），真正「用到」它的只有中间那一次上传。
 * 不撒手的话这 27MB 会一直挂在那条会话的处理链上，几条会话同时来就是要乘的。
 *
 * 所以返回的对象上挂了个 `release()`：describeVideos 识别完 / 报错之后立刻调，
 * 把 base64 置空让 GC 收走（见那个函数里的 finally）。
 *
 * ── 超限的不下载 ──
 *
 * SDK 的 attachment 上有个可选的 `size`，先看它 —— 有值就能在**一个字节都没
 * 下载之前**判出「太大了」。拿不到（chunked、或者提供方没填）才退回「读完再量
 * 一次」。两段式和 spy.js 那边看 Content-Length 是同一个套路。
 *
 * 不转码压缩：`ffmpeg -crf` 把一段 50MB 的视频压到 20MB 以内要几十秒 CPU，
 * 而上传本身已经要几十秒了，再叠上去对方那头就是分钟级的静默。真需要的话
 * 这里是加它的地方（media.js:toMp3ForStt 有现成的临时目录 + 收尾模式可抄）。
 */
async function readVideo(content, scope) {
  const name = String(content?.name ?? "").trim();
  const mb = (n) => (n / 1024 / 1024).toFixed(1);
  const cap = MAX_VIDEO_BYTES / 1024 / 1024;

  // 先问 SDK 报的大小：超了就压根不下载，那 20MB 一个字节都不进内存
  const claimed = Number(content?.size ?? 0);
  if (claimed > MAX_VIDEO_BYTES) {
    throw new Error(`视频 ${mb(claimed)}MB，超过 ${cap}MB 上限（没有下载）`);
  }

  const buf = await readBytes(content, scope, "视频");
  if (!buf?.length) throw new Error("附件读出来是空的");
  // size 是可选字段，没有的话只能读完再量。这时候字节已经进内存了，
  // 但下面立刻就没有引用了，GC 收得掉 —— 真正要防的是 base64 那份长期驻留
  if (buf.length > MAX_VIDEO_BYTES) {
    throw new Error(`视频 ${mb(buf.length)}MB，超过 ${cap}MB 上限`);
  }

  logInfo(
    scope,
    `收到视频：${mb(buf.length)}MB，mimeType=${content.mimeType ?? "（空）"}，` +
      `文件名=${name || "（空）"}`
  );

  const item = {
    base64: buf.toString("base64"),
    mimeType: content.mimeType,
    name,
  };
  // 识别完就撒手，别让 27MB 跟着整轮走（理由见上面的注释）
  item.release = () => {
    item.base64 = "";
  };
  return item;
}

/**
 * 找到这个 runner 当前绑定的角色。
 * 每轮都重新查：用户随时可能改人设或换绑，不能缓存住启动那一刻的快照。
 */
function currentRole(config, runner) {
  return roleForProject(config, runner.projectRefId);
}

/**
 * 这条会话的存档 ID。四个调用点（指令、正常轮次、主动消息的两段）都走这里。
 *
 * 尾巴是**自己这条线路的号码**，不是对方号码 —— 理由见 sessions.js:sessionIdFor
 * 的注释（会话 ID 会出现在日志和「上下文」列表里，截图求助时不该带出对方的号）。
 * `runner.linePhone` 由 startRunner 写入、syncBridges 每次对齐时刷新，
 * 所以这里现读就行，不用再翻一遍 config.projects。
 *
 * peer 仍然要传：本地 Mac 模式和「云端项目还没登记号码」这两种情况没有线路号，
 * sessionIdFor 会退到 peer 的哈希（不是明文号码）。
 */
function sessionIdOf(runner, role, peer) {
  return sessionIdFor(role.name, role.id, runner.linePhone ?? "", peer);
}

/**
 * 拿这条会话的内存上文，内存里没有就从存档回填最后 maxContext 条。
 * 只读这几条：磁盘上存了几千条也不影响内存占用。
 *
 * 正常对话和主动消息共用 —— 主动消息经常发生在进程刚重启之后，
 * 那时候内存是空的，回填这一步不能少，否则模型看不到任何上文。
 */
function loadHistory(runner, role, sessionId, scope) {
  if (!runner.history.has(sessionId)) {
    const recent = recentMessages(sessionId, role.maxContext ?? 20);
    if (recent.length) {
      logDebug(scope, `从存档恢复会话 ${sessionId} 的最近 ${recent.length} 条上文`);
    }
    runner.history.set(sessionId, recent);
  }
  return runner.history.get(sessionId) ?? [];
}

/**
 * 把一件事串到某条会话的处理链尾部，保证一轮结束再开下一轮。
 * 正常对话和快捷指令共用这一条链 —— 指令改存档时不能和正在跑的那轮抢。
 */
function chain(runner, spaceId, task, what) {
  const prev = runner.chains.get(spaceId) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(task)
    .catch((err) => logError(scopeOf(runner, "桥接"), what, err));
  runner.chains.set(spaceId, next);
  next.finally(() => {
    if (runner.chains.get(spaceId) === next) runner.chains.delete(spaceId);
  });
  return next;
}

/**
 * 把一条消息放进这条会话的合并队列。
 * 导出仅为便于单独测试合并逻辑。
 *
 * ── 窗口以**第一条**消息为基准 ──
 *
 * 第一条消息开一个 queueWait 秒的窗口，窗口内后来的消息只是往里加，**不会**
 * 把计时器推后。到点一次性全带上交给 handleTurn()。
 *
 * 以前是每来一条就清零重算（debounce）。那样最坏情况没有上界 —— 对方一直断断
 * 续续地打，每条都在计时器到点前落地，这一轮就一直不结算，人已经说完三句了还
 * 在等。现在最多等 queueWait 秒，从第一条算起。
 *
 * 代价是对方要是打得慢，第五句可能落在窗口外、被分到下一轮去。这是刻意换的：
 * 「偶尔分两轮回」比「说完了还在干等」体感好，而且下一轮的上下文里前一轮就在
 * 上面，接得上。
 *
 * @param {{text?: string, image?: object, voice?: object}} item
 *   文本、图片附件、或语音附件（三选一）
 * @param {string} [peer] 对方地址（E.164 手机号或邮箱），用来算会话 ID
 */
export function enqueue(getConfig, runner, space, spaceId, item, peer = "") {
  const waitSec = Number(getConfig().chat?.queueWait);
  const wait = Number.isFinite(waitSec) && waitSec > 0 ? waitSec : 0;

  const slot =
    runner.pending.get(spaceId) ??
    { texts: [], images: [], voices: [], videos: [], timer: null, space, peer };
  slot.space = space; // 同一会话可能拿到新的 space 实例，用最新的
  if (peer) slot.peer = peer;
  if (item?.text) slot.texts.push(item.text);
  if (item?.image) slot.images.push(item.image);
  // 老的 slot 可能是这版代码之前建的，没有 voices / videos 字段
  if (item?.voice) (slot.voices ??= []).push(item.voice);
  if (item?.video) (slot.videos ??= []).push(item.video);
  /*
   * 留一份原始 message，发已读回执要用它（read(target) 只收 Message 对象，
   * 不收 id 字符串）。一轮里可能攒了好几条，留**最后**那条就够 ——
   * iMessage 的已读是会话级的：markRead 一次会把这个 chat 里所有未读
   * 都标成已读（见 spectrum 的 read() 文档）。
   */
  if (item?.message) slot.message = item.message;

  /**
   * 引爆这一轮。
   *
   * @param {boolean} [force] 附件还在下载也照发。只有 flushPending 传 true ——
   *   那三处（指令 / 协助模式 / 线下模式）要的正是「排在前面的那一轮先跑完」。
   */
  const fire = (force = false) => {
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    /*
     * 还有附件正在拆 → 这一轮先挂起。
     *
     * 这就是「图 + 字被拆成两轮」的修法（整个来龙去脉见 holdPending）。到点了
     * 却有东西还在路上时，把窗口挂起：`slot.due` 记着「已经到点，只差附件」，
     * slot 留在 runner.pending 里**不动**，最后一个附件落地时由 releasePending
     * 补上这一次引爆。
     *
     * 不额外加兜底计时器：hold 的寿命就是 readBytes 的寿命（重试到头 17.8 秒，
     * 见 attachread.js），而且释放写在调用方的 finally 里，读崩了照样放。
     *
     * `wait === 0`（用户把合并关了）那条路走不到这儿的挂起分支：那时候 slot
     * 压根没进 runner.pending，挂起就等于把这一轮丢掉。判据写成「表里那个
     * 就是我」而不是 `wait === 0`，因为被 flushPending 引爆过的 slot 也已经
     * 不在表里了。
     */
    const holds =
      force || runner.pending.get(spaceId) !== slot
        ? 0
        : runner.holds?.get(spaceId) ?? 0;
    if (holds > 0) {
      slot.due = true;
      logDebug(
        scopeOf(runner, "桥接"),
        `这一轮到点了，但还有附件在下载，等它拆完一起发`
      );
      return;
    }
    slot.due = false;
    runner.pending.delete(spaceId);
    const videos = slot.videos ?? [];
    if (runner.stopped) {
      // 桥接已经停了，别再发出去。攒着的视频字节顺手放掉 —— handleTurn 不跑，
      // describeVideos 那个 finally 就没机会执行（同 stopRunner 里那段）
      for (const v of videos) v.release?.();
      return;
    }
    const merged = slot.texts.join("\n").trim();
    const voices = slot.voices ?? [];
    /*
     * 只发了图片、语音或视频、一个字都没打，也要处理——不能因为 merged 为空就丢掉。
     *
     * 真要在这儿返回的话，**videos 里那几十 MB 得先撒手** —— slot 马上就从
     * runner.pending 里删掉了，但 handleTurn 压根没跑，describeVideos 那个
     * finally 也就没机会执行。这条路实际走不到（有视频必然有 videos.length），
     * 写在这儿是因为下次有人往这个判断里加条件时不会想起这件事。
     */
    if (!merged && slot.images.length === 0 && voices.length === 0 && videos.length === 0) {
      for (const v of videos) v.release?.();
      return;
    }
    chain(
      runner,
      spaceId,
      () =>
        handleTurn(getConfig, runner, slot.space, spaceId, merged, slot.images, slot.peer, {
          message: slot.message,
          voices,
          videos,
        }),
      "处理这一轮消息出错"
    );
  };
  // 挂到 slot 上，好让 flushPending 能从外面提前引爆这一轮
  slot.fire = fire;

  if (wait === 0) {
    fire();
    return;
  }

  runner.pending.set(spaceId, slot);
  const counts =
    `${slot.texts.length} 条文本 / ${slot.images.length} 张图 / ` +
    `${(slot.voices ?? []).length} 条语音` +
    // 视频那一段只在真有的时候才写：绝大多数轮次没有，多一句「0 段视频」
    // 会把这行日志撑长，而它是每轮都打的
    ((slot.videos ?? []).length ? ` / ${slot.videos.length} 段视频` : "");

  /*
   * 计时器只在**开窗那一下**装，后来的消息一律不碰它 —— 这就是「以第一条为
   * 基准」的全部实现。判据用 `slot.timer` 而不是「texts 是不是空的」：只发了
   * 一张图、一条语音那轮一个字都没有，但窗口一样已经开着了。
   */
  if (slot.timer) {
    const left = Math.max(0, Math.round((slot.firesAt - Date.now()) / 100) / 10);
    logDebug(scopeOf(runner, "桥接"), `又攒一条：${counts}，还有 ${left}s 就发`);
    return;
  }

  /*
   * 窗口已经到点、正等着附件拆完（slot.due）—— 那**不能重新装一个计时器**。
   *
   * 走到这儿的典型情形就是被修的那个 bug 的下半段：窗口到点挂起，紧接着那张图
   * 读好了、进这个 slot。这时候重开一个 6 秒的窗口，等于附件每拆完一件就把这
   * 一轮往后推一次 —— 那又是 debounce。该由 releasePending 立刻引爆。
   */
  if (slot.due) {
    logDebug(scopeOf(runner, "桥接"), `又攒一条：${counts}，这一轮已经到点，拆完就发`);
    return;
  }

  logDebug(scopeOf(runner, "桥接"), `攒消息中：${counts}，${wait}s 后把这期间的一起发`);
  slot.firesAt = Date.now() + wait * 1000;
  slot.timer = setTimeout(fire, wait * 1000);
}

/**
 * 把这一轮收到的图片逐张交给视觉模型，拼成一段文字描述。
 * 单张失败不影响其他张，也不该让整轮对话挂掉。
 *
 * 识图模型是角色各自选的（endpoint / prompt / max 都由调用方解析好传进来），
 * 计数记在自己 runner 上。
 *
 * @param {object|null} endpoint 识图模型的 endpoint，null = 没开或引用失效
 * @returns {Promise<{text:string,total:number,failed:number,firstError:Error|null}>}
 *   text 是追加到用户消息后面的描述（可能为空串）；后三项给调用方判断
 *   「是不是整轮都识别失败了」—— 那种情况要把原因发回给对方
 */
async function describeImages(endpoint, prompt, max, runner, images) {
  const scope = scopeOf(runner, "视觉");
  if (!images.length) return { text: "", total: 0, failed: 0, firstError: null };

  if (!endpoint) {
    logInfo(scope, `收到 ${images.length} 张图，但这个角色没启用识图（或引用的模型已失效），已跳过`);
    return {
      text: `（用户发了 ${images.length} 张图片，但图片识别未启用，你看不到内容）`,
      total: images.length,
      failed: 0,
      firstError: null,
    };
  }

  const use = images.slice(0, max);
  if (images.length > use.length) {
    logWarn(scope, `这轮收到 ${images.length} 张图，按上限只识别前 ${use.length} 张`);
  }

  /*
   * 几张图**同时**识别。
   *
   * 以前是 for 里逐张 await：三张图就是三个来回串起来，每个来回十几秒，用户
   * 等的是它们的和。而这几张之间毫无依赖，各打一次接口而已。
   *
   * 用 Promise.all 收，顺序由数组下标定，不靠谁先回来 —— 所以「图片1 / 图片2」
   * 的编号和拼出来的顺序还是用户发的那个顺序。失败也按下标顺序归并（firstError
   * 要的是「排最前面那张的错」，上游拿它给用户报一句原因）。
   *
   * 并发数就是 max（默认 3），不另外限流：这是**一轮对话内**的几张图，量级摆在
   * 那儿；真正要防的是几条会话同时来，那个由别处的会话级排队管。
   */
  const settled = await Promise.all(
    use.map(async (image, i) => {
      /*
       * 手写消息 / Digital Touch 那两路自带 label 和 prompt（见入站循环里
       * embeddedKindOf 那一段）。它们跟普通图片挤在同一个数组里、占同一份
       * maxImages 额度、走同一个并发 —— 唯一的区别就是这两行：
       *
       *  - label：「手写消息内容：今晚一起吃饭吗」比「图片1内容：…」有用得多；
       *  - prompt：通用那句问的是「描述这张图片」，拿它去看手写消息，模型会答
       *    「一张蓝色的手写字迹」而不是把字读出来。
       *
       * 普通图片这两个字段都是 undefined，行为和以前一个字不差。
       */
      const label = image?.label || (use.length > 1 ? `图片${i + 1}` : "图片");
      const ask = image?.prompt || prompt;
      // 开始那行也要有：识图要打一次模型（VISION_TIMEOUT 是 180 秒），只有
      // 「完成」那行的话，这中间几十秒在控制台里看不出是在识别还是卡住了
      logInfo(scope, `开始识别${label}${use.length > 1 ? `（共 ${use.length} 张，并发）` : ""}…`);
      const startedAt = Date.now();
      try {
        const desc = await describeImage(endpoint, ask, image);
        logInfo(
          scope,
          `${label}识别完成（${secsSince(startedAt)}s）：${desc.slice(0, 60)}${desc.length > 60 ? "…" : ""}`
        );
        runner.imageCount += 1;
        return { part: `${label}内容：${desc}`, err: null };
      } catch (e) {
        logError(scope, `${label}识别失败（等了 ${secsSince(startedAt)}s）`, e);
        return { part: `${label}：识别失败（${String(e?.message ?? e)}）`, err: e };
      }
    })
  );

  const parts = settled.map((r) => r.part);
  const failed = settled.filter((r) => r.err).length;
  const firstError = settled.find((r) => r.err)?.err ?? null;

  const skipped =
    images.length > use.length
      ? `\n（另有 ${images.length - use.length} 张图片未识别，超出上限）`
      : "";
  return {
    text: `[用户发来的图片]\n${parts.join("\n")}${skipped}`,
    total: use.length,
    failed,
    firstError,
  };
}

/**
 * 把这一轮收到的语音条逐条交给多模态模型听，拼成一段文字。
 *
 * 结构和 describeImages 一模一样（单条失败不拖垮整轮、超上限的截断并说明、
 * 没启用时给一句让模型知道「有东西但你听不到」的降级文案），区别只在
 * 打的是哪个接口 —— 见 llm.js:transcribeAudio。
 *
 * 提示词有两套（只转写 / 连语气环境音一起报），选哪套在 config.js 里按角色的
 * 「情绪识别」开关决定，到这里已经是一个字符串了。
 *
 * @param {object|null} endpoint 听音模型的 endpoint，null = 没开或引用失效
 * @returns {Promise<{text:string,total:number,failed:number,firstError:Error|null}>}
 */
async function describeVoices(endpoint, prompt, max, runner, voices) {
  const scope = scopeOf(runner, "听音");
  if (!voices.length) return { text: "", total: 0, failed: 0, firstError: null };

  if (!endpoint) {
    logInfo(
      scope,
      `收到 ${voices.length} 条语音，但这个角色没启用语音识别（或引用的模型已失效），已跳过`
    );
    return {
      text: `（用户发了 ${voices.length} 条语音，但语音识别未启用，你听不到内容）`,
      total: voices.length,
      failed: 0,
      firstError: null,
    };
  }

  const use = voices.slice(0, max);
  if (voices.length > use.length) {
    logWarn(scope, `这轮收到 ${voices.length} 条语音，按上限只识别前 ${use.length} 条`);
  }

  // 同 describeImages：几条语音同时听，顺序按下标定（见那边的注释）
  const settled = await Promise.all(
    use.map(async (voice, i) => {
      const label = use.length > 1 ? `语音${i + 1}` : "语音";
      const dur = voice.seconds ? `（${voice.seconds.toFixed(1)} 秒）` : "";
      logInfo(
        scope,
        `开始识别${label}${dur}${use.length > 1 ? `（共 ${use.length} 条，并发）` : ""}…`
      );
      const startedAt = Date.now();
      try {
        const desc = await transcribeAudio(endpoint, prompt, voice);
        logInfo(
          scope,
          `${label}识别完成（${secsSince(startedAt)}s）：${desc.slice(0, 60)}${desc.length > 60 ? "…" : ""}`
        );
        runner.audioCount += 1;
        return { part: `${label}${dur}内容：${desc}`, err: null };
      } catch (e) {
        logError(scope, `${label}识别失败（等了 ${secsSince(startedAt)}s）`, e);
        return { part: `${label}${dur}：识别失败（${String(e?.message ?? e)}）`, err: e };
      }
    })
  );

  const parts = settled.map((r) => r.part);
  const failed = settled.filter((r) => r.err).length;
  const firstError = settled.find((r) => r.err)?.err ?? null;

  const skipped =
    voices.length > use.length
      ? `\n（另有 ${voices.length - use.length} 条语音未识别，超出上限）`
      : "";
  return {
    text: `[用户发来的语音]\n${parts.join("\n")}${skipped}`,
    total: use.length,
    failed,
    firstError,
  };
}

/**
 * 把这一轮收到的视频逐段交给多模态模型看，拼成一段文字。
 *
 * 结构和 describeVoices 一样（单段失败不拖垮整轮、超上限的截断并说明、
 * 没启用时给一句降级文案），打的接口见 llm.js:describeVideo。
 *
 * ── 多出来的那件事：撒手 ──
 *
 * **不管识别成没成，每一段的字节都在这儿放掉**（`finally` 里的 release）。
 * 一段视频的 base64 是 27MB 上下，而它从这个函数返回之后就再也用不到了 ——
 * 进历史、进存档、发给聊天模型的都只是这段描述文字。不放的话它会跟着
 * handleTurn 剩下的全程（打模型、发气泡、写存档）一直挂着，几条会话同时来
 * 就是要乘的。超上限没识别的那几段同样要放，它们压根没被用过。
 */
async function describeVideos(endpoint, prompt, max, runner, videos) {
  const scope = scopeOf(runner, "看视频");
  if (!videos.length) return { text: "", total: 0, failed: 0, firstError: null };

  /*
   * 没开也要撒手。
   *
   * 这一条是真会走到的：对方发来视频、角色没开「看视频」，字节已经被
   * readVideo 读进内存了（那一步不看角色配置，理由见调用处的注释）。
   * 早年漏了这个 return 里的 release，那就是「关着这个功能反而更费内存」。
   */
  if (!endpoint) {
    for (const v of videos) v.release?.();
    logInfo(
      scope,
      `收到 ${videos.length} 段视频，但这个角色没启用视频识别（或引用的模型已失效），已跳过`
    );
    return {
      text: `（用户发了 ${videos.length} 段视频，但视频识别未启用，你看不到内容）`,
      total: videos.length,
      failed: 0,
      firstError: null,
    };
  }

  const use = videos.slice(0, max);
  if (videos.length > use.length) {
    logWarn(scope, `这轮收到 ${videos.length} 段视频，按上限只识别前 ${use.length} 段`);
    // 超出上限那几段这辈子都用不到了，立刻放掉
    for (const v of videos.slice(use.length)) v.release?.();
  }

  const parts = [];
  let failed = 0;
  let firstError = null;
  for (const [i, video] of use.entries()) {
    const label = use.length > 1 ? `视频${i + 1}` : "视频";
    // 视频是三路里最慢的：几十 MB 的 base64 光上传就要一阵，识别本身更久。
    // 把体积一起报出来 —— 「等了 90 秒」配上「27MB」才知道是正常还是卡了
    const mb = video.base64 ? ((video.base64.length * 3) / 4 / 1024 / 1024).toFixed(1) : "";
    logInfo(scope, `开始识别${label}${mb ? `（约 ${mb}MB）` : ""}，这一步比识图慢得多…`);
    const startedAt = Date.now();
    try {
      const desc = await describeVideo(endpoint, prompt, video);
      logInfo(
        scope,
        `${label}识别完成（${secsSince(startedAt)}s）：${desc.slice(0, 60)}${desc.length > 60 ? "…" : ""}`
      );
      runner.videoCount += 1;
      parts.push(`${label}内容：${desc}`);
    } catch (e) {
      logError(scope, `${label}识别失败（等了 ${secsSince(startedAt)}s）`, e);
      parts.push(`${label}：识别失败（${String(e?.message ?? e)}）`);
      failed += 1;
      firstError ??= e;
    } finally {
      // 成了也放、崩了也放 —— 描述已经拿到手（或者永远拿不到了），
      // 这几十 MB 没有任何理由跟着后面的流程走
      video.release?.();
    }
  }

  const skipped =
    videos.length > use.length
      ? `\n（另有 ${videos.length - use.length} 段视频未识别，超出上限）`
      : "";
  return {
    text: `[用户发来的视频]\n${parts.join("\n")}${skipped}`,
    total: use.length,
    failed,
    firstError,
  };
}

/**
 * 「正在输入…」套着干一件事 —— 替代 `space.responding(fn)`。
 *
 * ── 为什么不用 SDK 那个 ──
 *
 * spectrum 的 responding 是这样写的（@spectrum-ts/core）：
 *
 *     responding: async (fn) => {
 *       await space.send(typing("start"));        ← 没保护
 *       try { return await fn(); }
 *       finally { await space.send(typing("stop")).catch(() => {}); }  ← 这个包了
 *     }
 *
 * 收尾那句包了 `.catch`，**开头那句没有**。于是打字指示器没开成功的时候，
 * `fn` 压根不会被执行 —— 而 fn 才是真正要干的事（发那条消息）。
 *
 * 实机上撞到的就是这个，用户反馈里那条栈：
 *
 *     IMessageError: fetch failed
 *       at fromGrpcError  (@photon-ai/advanced-imessage)
 *       at ChatsResource.setTyping          ← 失败的是打字气泡
 *       at async startTyping / handleTyping
 *       at async Object.send                ← 把整个 responding 带崩了
 *     [桥接·某某] 处理这一轮消息出错
 *
 * `fetch failed` 是 undici 对一切网络失败的统称，这里是我们和 Photon 之间那条
 * gRPC 连接抖了一下（共享线路上躲不掉，attachread.js 的文件头记过同一件事：
 * 底下连接一抖，挂在上面的流会一起断）。
 *
 * 症状是**角色偶尔整轮不回**，而日志里只有一句没信息量的 fetch failed ——
 * 一个纯装饰性的省略号气泡，代价是一整轮回复。
 *
 * ── 这里的规矩 ──
 *
 * 打字指示器是**装饰**，`fn` 是**正事**。所以两头的 typing 都各自 catch 掉，
 * 不让它们有任何机会挡住 fn。我们自己那三处裸的 `space.startTyping()` 早就
 * 是这么包的（见 sendBubbles），这个函数只是把同样的规矩补到 responding 上。
 *
 * fn 自己抛的错**照旧往外抛** —— 那才是真的失败，调用方要知道。
 */
async function respondingWhile(space, fn, runner = null) {
  try {
    await space.startTyping();
  } catch (e) {
    /*
     * 只在明细档记一行：这事不影响结果，但排查「省略号怎么不出来」时要看得见。
     * 而且它**不能**升到 warn —— 共享线路上这种抖动是常态，每次都喊一声等于
     * 把真正的问题埋掉。
     *
     * runner 可以不传（几处静态调用点手上没有），所以这里自己兜一下标签，
     * 不走 scopeOf（那个直接读 runner.label，传 null 会炸）。
     */
    logDebug(
      runner?.label ? `桥接·${runner.label}` : "桥接",
      `打字指示器没开起来，照常发内容：${String(e?.message ?? e)}`
    );
  }
  try {
    return await fn();
  } finally {
    try {
      await space.stopTyping();
    } catch {
      /* 灭不掉就算了：对方那头几秒后自己会灭 */
    }
  }
}

/**
 * 发一条**系统发言**。
 *
 * 系统发言 = 这个程序自己说的话：指令的确认、出错提示、`/memory` 和 `/diary`
 * 总结出来的那一大段。和角色的回复（sendBubbles / 语音 / 图片那几条路）是
 * 两回事 —— 那些是「人」在说话，这些一看就是机器在说话。
 *
 * **防相亲开着的时候，这些一条都不发**，只留在控制台日志里。用户的原话：
 * 「防止别人无意间看到你手机屏幕的时候系统突然触发了某个功能或报错」——
 * 会露馅的正是这一类，而不是聊天内容本身。角色的回复照常发，不然开着就没法聊了。
 *
 * 所有系统发言都得走这里。漏掉一条，防相亲就等于没开：别人瞄到的那一眼
 * 撞上的是哪一条，事先并不知道。
 *
 * @param {object} opts
 *   `what` 只进日志，说明被拦下的是什么；`responding` 为真时套一层「正在输入」
 *   —— 被拦下时连这个省略号都不冒出来，那也是系统在说话
 * @returns {Promise<boolean>} 真发出去了才是 true
 */
async function sendSystem(runner, space, text, opts = {}) {
  const { what = "系统消息", responding = false } = opts;
  if (privacyOn()) {
    const peek = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    logInfo(scopeOf(runner, "桥接"), `防相亲开着，${what}没发进聊天：${peek}`);
    return false;
  }
  if (responding) await respondingWhile(space, () => space.send(text), runner);
  else await space.send(text);
  return true;
}

/**
 * 把出错原因发回给对方。
 *
 * 用户在 iMessage 里等回复，不该为了知道「为什么没回」去翻控制台。
 * 所以这里发一条短的、人能看懂的说明。
 *
 * 发失败就只记日志 —— 报错通知本身再抛异常没有意义，
 * 而且大多数情况下发不出去的原因和刚才失败的原因是同一个。
 */
async function notifyFailure(runner, space, what, err) {
  const scope = scopeOf(runner, "桥接");
  const reason = String(err?.message ?? err ?? "").trim();
  // 去掉「主 API（xxx · 模型名）」这种前缀里的模型名 —— 对方是普通用户，
  // 不需要知道你用的是哪个中转站的哪个模型，但要知道是网络还是配置问题
  const clean = reason.replace(/^(主|副|视觉)\s*API(（[^）]*）)?\s*/g, "").trim();
  /*
   * 补一句「这是谁的错、该找谁」。
   *
   * 这是所有失败通知的**唯一出口**（聊天、看图、听语音、协助模式都走这儿），
   * 所以那句归因挂在这里而不是各个抛错的地方 —— 新加一条失败路径自动带上。
   *
   * 起因是一批反馈：对方收到的是一句光秃秃的「返回 503」，既不知道这串数字
   * 什么意思，也不知道该找谁，于是一律当成 Uranus 坏了。llm.js:faultAdvice
   * 按错误的归属（上游 / 网络 / 内容审核 / 本地配置没填全）各给一句话。
   *
   * 传进来的 `err` 是字符串时（空回那几条自己写好了全文）不加 —— 那些话里
   * 已经把该说的说完了，再缀一句会重复。
   */
  const advice = typeof err === "object" && err ? faultAdvice(err) : "";
  const body = advice ? `${clean || "未知错误"}（${advice}）` : clean || "未知错误";
  const text = `⚠️ ${what}：${body}`;

  try {
    if (await sendSystem(runner, space, text, { what: "出错原因" })) {
      logInfo(scope, "已把出错原因发回给对方");
    }
  } catch (e) {
    logWarn(scope, "想把出错原因发回给对方，但这条也发不出去", e);
  }
}

/**
 * 这一轮聊完了，交给记忆库。
 *
 * 两条出口都调这里（正常路径和已读不回那条）—— 「一轮」的定义要一致，
 * 不然已读不回的那些轮就不进待总结，轮数会漏、日记流水也会缺一半。
 *
 * **绝不 await 总结那一步。** 记一笔待总结是同步的两次追加写（很轻），
 * 但总结要打一次模型、几十秒起步。对方这时候正在等消息，所以
 * `runSummaries` 一律 `void ... .catch()` 扔到后台：这一轮的气泡照常发，
 * 总结在后面自己跑完。失败也不会丢东西 —— memoryhooks 那边只改失败计数，
 * 待总结的内容一个字节都不删（用户钉死的第一条硬约束）。
 *
 * 整个函数用 try 包住：记忆库出任何岔子都不该影响已经发出去的回复。
 */
function afterTurn(runner, space, config, role, turn) {
  const scope = scopeOf(runner, "记忆库");
  try {
    if (!recordTurn(config, role, turn)) return; // 三道闸全关，什么都不做
  } catch (e) {
    logWarn(scope, "这一轮没记进记忆库（不影响回复）", e);
    return;
  }

  // 连续失败到上限时由 memoryhooks 调这个 notify，把原因发回给对方。
  // 走 sendSystem：这是程序自己在说话，防相亲开着时不该冒出来
  const notify = async (text) => {
    try {
      await sendSystem(runner, space, text, { what: "记忆库的提示" });
    } catch (e) {
      logWarn(scope, "总结失败的说明发不出去", e);
    }
  };

  void runSummaries(config, role, notify).catch((e) => {
    logError(scope, "后台总结出错（待总结的内容都还在）", e);
  });
}

/**
 * 把某条会话攒在合并队列里、还没到点的那一轮**提前引爆**。
 *
 * 为的是「先说话、紧接着发指令」这一串：
 *
 *   你好            → 进队列，等 queueWait 秒
 *   /del            → 指令立刻执行，清空存档
 *   （几秒后队列到点）→ handleTurn 跑「你好」，往刚清空的存档里写一轮
 *
 * 结果是清完又冒出两条。所以指令执行前先把队列里那一轮引爆，它会串到
 * 同一条链上排在指令**前面** —— 顺序就回到了用户发消息的顺序。
 *
 * 不选「直接把队列丢掉」：那样用户刚说的那句话凭空消失，而他并没有要求
 * 撤回它，只是想清上下文而已。
 */
function flushPending(runner, spaceId) {
  const slot = runner.pending.get(spaceId);
  if (!slot?.fire) return false;
  logDebug(scopeOf(runner, "桥接"), "有攒着的消息，先把它这一轮跑完再执行指令");
  // 硬引爆：附件还在下载也照发。这三处调用（指令 / 协助模式 / 线下模式）要的是
  // 「排在它前面的那一轮先跑完」，等下载会把顺序又倒过来 —— 那正是这个函数要治的病
  slot.fire(true);
  return true;
}

/**
 * 占住这条会话的合并窗口：这条消息还在拆附件，到点了也先别发。
 *
 * ── 治的是什么 ──
 *
 * 用户报的原话：「发了图 + 字，LLM 先回了文字，图片过了好一会儿才发出去」。
 * 根因是两件独立正确的事撞在一起：
 *
 *  - 合并窗口以**第一条**消息为基准，后来的不推后计时器（见 enqueue 的注释）；
 *  - 附件字节是在消息循环里**同步**读的，断流还要重试，最多 17.8 秒
 *    （见 attachread.js 的 RETRY_MS）。
 *
 * 于是文字先落地的那种顺序就成了：
 *
 *     T+0.0  文字进队列，窗口开，6s 后引爆
 *     T+0.3  图片开始回源下载，断了自己重试
 *     T+6.0  窗口到点 → 只带着文字去打模型      ← 角色回了文字
 *     T+12   图片终于读到 → 进了一个新的空队列
 *     T+18   第二轮才去识图                      ← 图「过了好一会儿」
 *
 * 图先落地时没事：消息循环是 `for await` 串行的，下载那会儿文字压根还没被读出来。
 * 所以这个 bug 只在「字在前、图在后」时出现 —— 而那恰好是大多数人的习惯。
 *
 * ── 为什么不是「下载时把计时器推后」 ──
 *
 * 推后就等于把 debounce 请回来了（那是上一版刻意换掉的东西，见 enqueue）：
 * 一直有附件在传，这一轮就一直不结算。这里的语义严格得多 —— 窗口该到点就到点，
 * 只是**兑现推迟到手上的东西拆完**，而拆附件的时长本来就有上界。
 *
 * 计数不是布尔：一条消息可以同时带图、语音、视频、文件。而消息循环是串行的，
 * 所以同一时刻只有一条消息在拆，计数实际只会是 0 或 1 —— 写成计数是为了下次
 * 有人把某一路改成并发读时，这里不用跟着改。
 */
function holdPending(runner, spaceId) {
  if (!runner.holds) runner.holds = new Map();
  runner.holds.set(spaceId, (runner.holds.get(spaceId) ?? 0) + 1);
}

/**
 * 拆完了，放掉窗口。要是这期间窗口已经到点（slot.due），就在这儿补上那一次引爆。
 *
 * **必须写在调用方的 finally 里**：漏放一次，这条会话的合并窗口就永久挂起了 ——
 * 后面的消息全进同一个 slot、再也没人引爆它，表现是「这个号不说话了」。
 * 读附件失败、超上限、甚至拆到一半抛异常，都得照放。
 */
function releasePending(runner, spaceId) {
  const left = (runner.holds?.get(spaceId) ?? 0) - 1;
  if (left > 0) {
    runner.holds.set(spaceId, left);
    return;
  }
  runner.holds?.delete(spaceId);
  const slot = runner.pending.get(spaceId);
  if (!slot?.due || !slot.fire) return;
  logDebug(scopeOf(runner, "桥接"), "附件拆完了，把刚才等着的那一轮发出去");
  slot.fire();
}

/**
 * 快捷指令：不打模型，直接改配置或存档，然后回一条确认。
 *
 * **这条消息不会进上下文存档**：写存档只发生在 handleTurn 里，指令走的是
 * 这条路，压根到不了那儿。前端「已回复」的计数同理（runner.messageCount
 * 只在 handleTurn 里加）。
 *
 * **为什么要串到 runner.chains 上**（和 handleTurn 共用一条链）：
 * 上一轮可能正在等模型回复。那一轮结束时会往存档里 appendTurn，
 * 如果 /del 抢在它前面清空，模型的回复随后又会被写回去 —— 表现就是
 * 「清空了但过两秒又冒出来两条」。串行之后 /del 一定在那一轮落盘之后跑。
 *
 * **不调用 syncBridges**：切模型只动 role.chatModel，而 fingerprintOf 里
 * 压根没有模型引用（那些是每轮现读的，见它上面的注释）。真调了反而会把
 * 正在处理这条消息的连接重启掉。
 *
 * 回复用 sendSystem 直接发（不走 sendBubbles）：
 *  - 指令回复不该按字数模拟打字延迟，用户要的是立刻看到「操作成功」
 *  - /provider 的列表是多行文本，走 splitBubbles 会被分隔符拆成好几条气泡
 *  - 走 sendSystem 而不是裸的 space.send，是因为这些全是系统发言 ——
 *    防相亲开着的时候一条都不该冒出来
 *
 * @returns {Promise<boolean>} true = 这条消息已经作为指令处理掉了
 */
async function handleCommand(getConfig, runner, space, spaceId, userText, peer = "") {
  if (!isCommandMessage(userText)) return false;

  const scope = scopeOf(runner, "指令");
  const role = currentRole(getConfig(), runner);
  const sessionId = role ? sessionIdOf(runner, role, peer || spaceId) : "";

  let result;
  try {
    result = tryCommand(userText, { role, sessionId, forget: forgetHistory });
  } catch (e) {
    logError(scope, `执行「${userText}」出错`, e);
    try {
      await sendSystem(runner, space, `⚠️ 指令执行出错：${String(e?.message ?? e)}`, {
        what: "指令的出错说明",
      });
    } catch (sendErr) {
      logWarn(scope, "连出错说明都发不出去", sendErr);
    }
    return true;
  }

  // isCommandMessage 认了 tryCommand 就一定给结果（两边判断的是同一套）。
  // 真走到这儿说明两边走岔了 —— 那就当普通消息放过去，别把消息吞掉。
  if (!result) {
    logWarn(scope, `「${userText}」认出是指令却没拿到结果，当普通消息处理`);
    return false;
  }

  logInfo(scope, result.log ?? `执行「${userText}」`);

  /*
   * `/image`：真正的生成和发送在这里做，不在 commands.js 里。
   *
   * 那个文件故意不 import 这个文件（循环依赖），所以它只做检查和参数解析，
   * 把「要出一张什么图」放在 result.image 里带回来。
   *
   * **不进历史、不进存档、不打模型** —— 和别的指令一个待遇（用户明确要求的：
   * 「不经过 LLM，也不会注入上下文」）。所以这里不碰 runner.history，
   * 也不调 appendTurn。
   */
  if (result.image) {
    try {
      await respondingWhile(space, async () => {
        const ok = await sendImagePart(
          runner,
          space,
          { kind: "image", text: result.image.prompt, ref: result.image.ref },
          { role, config: getConfig(), eps: null }
        );
        if (!ok) {
          await sendSystem(runner, space, "⚠️ 这张图没生成成功，具体原因看控制台的「生图」日志。", {
            what: "出图失败的提示",
          });
        }
      }, runner);
    } catch (e) {
      logError(scope, "快捷指令出图失败", e);
    }
    return true;
  }

  /*
   * `/memory`、`/diary`：同一个路子 —— commands.js 只做检查，真正的总结在这儿。
   *
   * **这条要 await**，和别的指令不一样：总结要打一次模型，几十秒。用户是自己
   * 敲的指令，等着看结果，所以放在 space.responding 里（对方会看到「正在输入」），
   * 跑完把成品发回去。自动触发那条路才是不能等的（见 handleTurn 里的 recordTurn）。
   *
   * 成功失败都只发一条消息、都不进历史存档 —— 和别的指令一个待遇。
   */
  if (result.memory) {
    try {
      await respondingWhile(space, async () => {
        const config = getConfig();
        const out =
          result.memory.kind === "diary"
            ? await manualDiary(config, role)
            : await manualMemory(config, role);
        if (out.log) logInfo(scope, out.log);
        await sendSystem(runner, space, out.text, {
          what: result.memory.kind === "diary" ? "日记" : "记忆总结",
        });
      }, runner);
    } catch (e) {
      // manualMemory / manualDiary 自己吞了业务错误，走到这儿是发送本身出了事
      logError(scope, `快捷指令「${result.memory.kind}」失败`, e);
    }
    return true;
  }

  /*
   * `/重roll`：commands.js 已经把存档退回到上一轮之前，并把那条 user 消息
   * 原文交了回来。这里拿它重跑一次 handleTurn。
   *
   * 走的是**正常那条路**（同一个函数），所以气泡节奏、正则、联网搜索、
   * 已读不回、出图全都和第一次生成一模一样 —— 重 roll 该只换一次骰子，
   * 不该换一条代码路径。区别只有 meta.reroll 那三处（不重复过滤、不重复
   * 加时间前缀、不重复记待总结），见 handleTurn 的注释。
   *
   * 要 await：用户敲了指令等着看新回复。生成失败时 handleTurn 自己会
   * notifyFailure，这里只兜住异常别让链断掉。
   */
  if (result.reroll) {
    try {
      await handleTurn(
        getConfig,
        runner,
        space,
        spaceId,
        result.reroll.userText,
        [],
        peer,
        { reroll: true }
      );
    } catch (e) {
      logError(scope, "重新生成失败", e);
    }
    return true;
  }

  /*
   * `/立即触发评论`：把 IG 互动队列里排着的任务全部立刻跑掉。
   *
   * 同样是 commands.js 只给 marker、这里干活（那边不能 import igrun.js）。
   *
   * **要 await**，和 /memory 一个道理：每条任务都要打一次模型，几十秒起，
   * 用户敲了指令等着看结果，所以包在 space.responding 里让对方看到「正在输入」。
   *
   * 跑的是**整条队列**（所有角色的），不只当前这条号码绑的那个 —— 用户要的
   * 就是「别等计时器了」，而计时器本来也是一把扫全部。所以上面 commands.js
   * 把它排在了角色检查前面，没绑角色的号码也能敲。
   */
  if (result.igtick) {
    try {
      await respondingWhile(space, async () => {
        const done = await tickIgQueue(getConfig(), {
          session: igSessionFor(getConfig),
          all: true,
        });
        await sendSystem(
          runner,
          space,
          done.length
            ? `✅ 已经把 Instagram 排着的 ${done.length} 条互动全部跑完了。`
            : "队列里现在没有排着的互动。",
          { what: "IG 队列的执行结果" }
        );
      }, runner);
    } catch (e) {
      // tickIgQueue 自己吞了单条任务的异常，走到这儿是发送本身出了事
      logError(scope, "快捷指令「立即触发评论」失败", e);
    }
    return true;
  }

  /*
   * `/提示词协助模式`、`/提示词协助模式关闭`：切这条会话的协助模式开关。
   *
   * 还是老规矩，commands.js 只给 marker —— 开关是按「线路 + 会话」存的
   * （promptmode.js），而那个文件不认识 runner，拿不到这两个 id。
   *
   * 确认语单独在这儿发、不走下面那条通路，只为了一件事：**判重**。
   * 重复敲一遍 `/提示词协助模式` 是很常见的手滑，这时候回一句「已开启」会让人
   * 以为刚才那次没生效，而真正发生的是什么都没变（openAssist 不会清掉聊了
   * 一半的诊断记录）。所以按表的实际变化换一句话。
   *
   * 「已开启…」那句是用户逐字指定的措辞，别改。
   */
  if (result.promptMode) {
    const on = result.promptMode === "on";
    let text = result.text;
    if (on) {
      if (!openAssist(runner.projectRefId, spaceId, peer)) {
        text = "提示词协助模式已经开着了，有什么问题直接说。";
      }
    } else if (!closeAssist(runner.projectRefId, spaceId)) {
      text = "现在不在提示词协助模式里，不用关。";
    }
    try {
      await sendSystem(runner, space, text, { what: "协助模式的回复", responding: true });
    } catch (e) {
      logError(scope, "协助模式的回复发不出去（开关已经切了）", e);
    }
    return true;
  }

  /*
   * `/开启线下`、`/关闭线下`、`/小总结`、`/大总结`。
   *
   * 老规矩：commands.js 只给 marker，干活在这儿 —— 那边不能 import offline.js
   * （那条链要 buildPrompt）。
   *
   * 三件事在这里做，commands.js 都做不了：
   *  - **和协助模式互斥**。那张表按「线路 + 会话」存，commands.js 拿不到这两个 id。
   *    两条并行链同时开着会抢同一条消息（都是在合并队列之前拦的）。
   *  - **判重**。开着的时候再敲一遍 `/开启线下`，得回「已经开着了」而不是
   *    「已开启」—— 后者会让人以为刚才那次没生效。判重要看存档。
   *  - **总结和结束要 await**，和 `/memory` 一个道理：都要打一次模型，几十秒，
   *    包在 space.responding 里让对方看到「正在输入」。
   */
  if (result.offline) {
    await runOfflineCommand(getConfig, runner, space, spaceId, {
      action: result.offline.action,
      role,
      scope,
    });
    return true;
  }

  /*
   * 剩下所有指令的确认都从这条路出去。
   *
   * 防相亲那条暗号也走这里 —— 而且**开**的那一下会被自己拦下：cmdPrivacy
   * 在返回之前就把 enabled 写成 true 了，等走到这儿，sendSystem 已经开始拦人。
   * 这正是想要的：一条「✅ 防相亲已开启」是最露馅的那种消息。关的时候
   * enabled 已经是 false，「已关闭」照常发得出去。见 commands.js:cmdPrivacy。
   */
  try {
    await sendSystem(runner, space, result.text, {
      what: "指令的回复",
      responding: true,
    });
  } catch (e) {
    // 发不出去也别当成普通消息重发一遍给模型 —— 配置已经改了
    logError(scope, "指令的回复发不出去（操作已经生效）", e);
  }

  /*
   * `/重启`：**先把话发出去，再**让进程退出。
   *
   * 顺序是关键 —— requestRestart 之后几百毫秒进程就没了，先退再发的话那条
   * 气泡永远送不到，对方只看到连接断开，分不清是自己点的还是崩了。
   * 所以它排在上面那个 space.send 后面，而不是和别的分支一样提前 return。
   */
  if (result.restart) requestRestart(`快捷指令 ${scope}`);

  return true;
}

/* ───────────────────────── 提示词协助模式 ───────────────────────── */

/**
 * 一条气泡最多多少字。
 *
 * iMessage 本身不卡长度，但工程师的诊断动辄两三千字，一坨发过去在手机上
 * 就是一堵墙。按段落切开更像人说话，也方便用户单独引用某一段回复。
 */
const ASSIST_CHUNK = 1400;

/**
 * 一轮最多发几条。
 *
 * 8 条 ≈ 一万一千字，已经远超正常诊断的篇幅。再多的话多半是模型在把整份
 * 提示词抄一遍 —— 截断并提示它分点重说，比让对方手机震二十下强。
 */
const ASSIST_MAX_CHUNKS = 8;

/** 把一串碎片按上限攒成尽量满的几段。攒不下的原样吐出去，交给下一层再切。 */
function packPieces(pieces, glue, limit) {
  const out = [];
  let buf = "";
  for (const piece of pieces) {
    if (!buf) {
      buf = piece;
      continue;
    }
    if (buf.length + glue.length + piece.length <= limit) buf += glue + piece;
    else {
      out.push(buf);
      buf = piece;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * 切协助模式的回复。
 *
 * 三层，一层比一层粗暴：先按空行分段，段太长再按行分，行还太长才硬切。
 * 这个顺序是有意的 —— 工程师的回复大量是「1. …／2. …」这种列表，
 * 在行中间截断会把一条建议劈成两半，读的人得自己拼回去。
 */
function chunkAssist(text, limit = ASSIST_CHUNK) {
  const clean = String(text ?? "").trim();
  if (!clean) return [];
  if (clean.length <= limit) return [clean];

  const paras = clean
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);

  const out = [];
  for (const para of packPieces(paras, "\n\n", limit)) {
    if (para.length <= limit) {
      out.push(para);
      continue;
    }
    for (const line of packPieces(para.split("\n"), "\n", limit)) {
      if (line.length <= limit) {
        out.push(line);
        continue;
      }
      for (let i = 0; i < line.length; i += limit) out.push(line.slice(i, i + limit));
    }
  }
  return out;
}

/**
 * 协助模式的一轮往返。
 *
 * 和 runProactiveTurn / handleTurn 摆在一起看，区别只有一条但很要命：
 * **这一轮不属于角色**。所以它：
 *
 *  - 不写 runner.history、不调 appendTurn、不碰 messageCount、不走 afterTurn；
 *  - 不套 splitBubbles、不解析 [语音]/[图片]/[表情] 那些标记 —— 工程师写的是
 *    诊断报告，把它当角色台词拆气泡、抽标记只会把内容弄坏；
 *  - 不过正则规则（aiOutput 那套是给角色台词写的，用在这儿会误伤）。
 *
 * 但它**要读**角色的 history：那份上文正是用户要诊断的证据（用户原话：
 * 「<Chat_History> 是你分析 OOC 原因和定位问题的证据来源」）。读而不写。
 *
 * 发送照旧走 sendSystem —— 防相亲开着的时候这些也一并咽掉。协助模式说的是
 * 「你的人设第三条和世界书冲突」，恰恰是最不能让旁人看见的那类内容。
 */
async function runAssistTurn(getConfig, runner, space, spaceId, userText, peer = "") {
  const config = getConfig();
  const role = currentRole(config, runner);
  const scope = scopeOf(runner, "协助模式");
  const llmScope = scopeOf(runner, "LLM");

  const asked = String(userText ?? "").trim();
  if (!asked) return;

  if (!role) {
    await sendSystem(
      runner,
      space,
      "⚠️ 这条线路现在没绑角色，没有提示词可查。发 /提示词协助模式关闭 退出。",
      { what: "协助模式的提示" }
    );
    return;
  }

  const assist = role.promptAssist ?? {};

  /*
   * 默认用角色自己的聊天 API，勾了「独立 API」才另开一条。
   *
   * 独立那条解析不出来（服务商删了、模型关了）**不报错退出**，退回主模型继续
   * 干活 —— 用户这会儿正卡在一个 OOC 问题上，因为一个模型选择器失效就把
   * 协助模式也堵死，是最糟的时机。记条日志让他事后去改。
   */
  const eps = resolveRoleEndpoints(config, role);
  const own =
    assist.useOwnModel && assist.model?.provider && assist.model?.modelId
      ? resolveEndpoint(config, assist.model)
      : null;
  if (assist.useOwnModel && !own) {
    logWarn(scope, "协助模式的独立 API 没解析出来，这轮改用角色的聊天模型");
  }
  const endpoint = own ?? eps.chat;
  if (!endpoint) {
    await sendSystem(runner, space, "⚠️ 这个角色的聊天 API 没配好，协助模式没法回复。", {
      what: "协助模式的提示",
    });
    return;
  }

  const sessionId = sessionIdOf(runner, role, peer || spaceId);
  loadHistory(runner, role, sessionId, scope);
  const user = resolveUser(config, role);
  const history = runner.history.get(sessionId) ?? [];

  /*
   * 关键的一步：**一字不改**地重组一遍这一刻会发给角色的提示词。
   *
   * 用的是和正常轮次同一个 buildPrompt，同一份 config / role / user / history，
   * 所以预设条目的顺序、世界书这一刻的命中、深度插入的位置、上下文裁到哪里，
   * 全都是真实的那份。工程师看见的就是角色看见的 —— 否则诊断出来的是另一份
   * 提示词的毛病，改了也白改。
   */
  let weatherNote = "";
  try {
    weatherNote = (await buildEnv(role, config.weatherApi)).weather;
  } catch (e) {
    // 天气挂了不影响诊断，少一行环境说明而已
    logDebug(scope, "取天气失败，这份原始提示词里不带天气", e);
  }

  let built;
  try {
    built = await buildPrompt(config, role, user, [...history], weatherNote);
  } catch (e) {
    logError(scope, "原始提示词组不出来，协助模式这轮跳过", e);
    await notifyFailure(runner, space, "协助模式取不到原始提示词", e);
    return;
  }

  const vars = {
    char: role?.name ?? "",
    user: user?.name ?? "",
    sep: config?.chat?.separator ?? "",
  };

  const messages = buildAssistMessages({
    assistPrompt: assist.prompt,
    originalMessages: built.messages,
    turns: assistTurns(runner.projectRefId, spaceId),
    userText: asked,
    vars,
  });

  logInfo(
    scope,
    `协助模式这轮带上了原始提示词 ${built.messages.length} 段（${sessionId}）`,
    asked
  );

  /*
   * promptMeta 沿用正常轮次的字段，网页端的「提示词」面板才认得出来。
   * roleName 后面缀一下，不然面板上两种轮次混在一起分不清哪条是诊断用的。
   */
  const promptMeta = {
    roleId: role.id,
    roleName: `${role.name}（协助模式）`,
    sessionId,
    userId: user?.id ?? "",
    userName: user ? userLabel(user) : "",
    model: endpoint.label ?? "",
    presetName: presetLabel(built.preset),
    worldHits: built.worldInfo.hitNames,
  };
  notePrompt(promptMeta, messages);

  let reply;
  try {
    /*
     * params 传空对象是**故意的**：预设里的温度、Top P、惩罚项都是为角色扮演
     * 调的（通常偏高，图的是说话有变化）。诊断要的是稳，用上游自己的默认值。
     */
    const { content, usedFallback } = await chatWithFallback(endpoint, eps.fallback, messages, {});
    if (usedFallback) logWarn(llmScope, "协助模式这轮走的是副 API");
    reply = content;
  } catch (e) {
    logError(llmScope, "协助模式这轮没回上来", e);
    await notifyFailure(runner, space, "协助模式这条没回上来", e);
    return;
  }

  logInfo(llmScope, `提示词工程师回复 ${reply.length} 字`, reply);

  let chunks = chunkAssist(reply);
  if (!chunks.length) {
    await sendSystem(runner, space, "⚠️ 这轮返回是空的，换个说法再问一次。", {
      what: "协助模式的提示",
    });
    return;
  }
  if (chunks.length > ASSIST_MAX_CHUNKS) {
    logWarn(scope, `回复被切成 ${chunks.length} 条，只发前 ${ASSIST_MAX_CHUNKS} 条`);
    chunks = chunks.slice(0, ASSIST_MAX_CHUNKS);
    chunks.push("……（这条回复太长，后面截断了。可以让它只讲某一个模块，或者分点重说。）");
  }

  /*
   * 先落表再发。
   *
   * 反过来的话，发了一半崩掉，下一轮的上下文里就没有刚才那段诊断，用户接着说
   * 「那就按你说的第二条改」会得到一句「我不知道你指哪条」。宁可发失败，
   * 也别让上下文和对方屏幕上看到的对不上。
   */
  appendAssist(runner.projectRefId, spaceId, "user", asked);
  appendAssist(runner.projectRefId, spaceId, "assistant", reply);

  for (const [i, chunk] of chunks.entries()) {
    // 太快连发，iMessage 那边的先后顺序不一定保得住。
    // 单位是**秒**（delay.js:sleep）—— 这里曾经写成 600，等于每条之间隔十分钟
    if (i) await sleep(0.6);
    try {
      await sendSystem(runner, space, chunk, { what: "协助模式的回复", responding: true });
    } catch (e) {
      logError(scope, `协助模式第 ${i + 1} 条发不出去`, e);
      break;
    }
  }
}

/* ---------------- 线下模式 ---------------- */

/**
 * 线下那四条指令的执行体（commands.js 只给 marker，见那边的注释）。
 *
 * 开/关是**同步**的（只动一个小 JSON），两条总结和「关闭线下」要打模型，
 * 所以包在 `space.responding` 里让对方看到「正在输入」—— 和 `/memory` 一样。
 */
async function runOfflineCommand(getConfig, runner, space, spaceId, { action, role, scope }) {
  const say = async (text, what = "线下模式的回复") => {
    try {
      await sendSystem(runner, space, text, { what, responding: true });
    } catch (e) {
      logError(scope, "线下模式的回复发不出去（操作已经生效）", e);
    }
  };

  /*
   * `/关闭线下` 排在角色检查前面（commands.js 那边也是这个顺序）：角色解绑之后
   * 得能把人从线下模式里放出来。捞不到角色就只能把开关按掉 —— 那份总结注入
   * 需要 `memoryKeyFor(role)`，没角色就没有记忆库可写。
   */
  if (!role) {
    if (action === "off") {
      await say("已退出线下模式（这条号码现在没绑角色，所以没有总结可以写进记忆库）。");
    } else {
      await say("⚠️ 这条号码还没绑定角色，线下模式用不了。");
    }
    return;
  }

  const config = getConfig();
  const roleKey = memoryKeyFor(role);

  if (action === "on") {
    /*
     * 两条并行链互斥。协助模式和线下都是在「指令之后、合并队列之前」拦消息的，
     * 同时开着会抢同一条 —— 而抢到的那条链完全取决于代码里谁排在前面，
     * 用户看到的是「说了话没反应」。所以这里直接拒绝，并说清该先关哪个。
     */
    if (isAssistOn(runner.projectRefId, spaceId)) {
      await say("⚠️ 提示词协助模式正开着。先发 /提示词协助模式关闭，再开线下。");
      return;
    }
    if (isOfflineOn(roleKey)) {
      const story = currentStory(roleKey);
      await say(
        `线下模式已经开着了${story ? `，正在演「${story.name}」（${story.turns.length} 轮）` : ""}。直接说话就行。`
      );
      return;
    }
    const idx = openOffline(roleKey, {
      roleId: role.id,
      presetRef: role.offline?.presetRef ?? "",
    });
    if (!idx.open) {
      await say("⚠️ 线下模式开不起来（剧情文件写失败），看控制台的「线下模式」日志。");
      return;
    }
    const story = currentStory(roleKey);
    await say(
      `已开启线下模式，接下来演「${story?.name ?? "新剧情"}」。\n` +
        `这期间${role.name} 的线上功能全部停用（主动消息、语音表情包那一套都不生效）。\n` +
        `演完发 /关闭线下 结束，会自动出一份大总结写进记忆库。`
    );
    return;
  }

  if (action === "off") {
    if (!isOfflineOn(roleKey) && !readIndex(roleKey).currentId) {
      await say("现在不在线下模式里，不用关。");
      return;
    }
    await respondingWhile(space, async () => {
      let out;
      try {
        out = await endOffline(config, role, { inject: true });
      } catch (e) {
        // endOffline 自己吞了总结的异常，走到这儿是更意外的情况。
        // 开关一定要按掉 —— 卡在线下模式里出不来是最糟的结果
        logError(scope, "结束线下模式出错，强行把开关按掉", e);
        closeOffline(roleKey);
        await say("⚠️ 结束时出了点问题，线下模式已经关掉了。总结和剧情都还在，可以去网页端看。");
        return;
      }
      const lines = [`已结束线下剧情${out.story ? `「${out.story.name}」` : ""}，回到正常聊天。`];
      if (out.injected) lines.push(`往待总结写了 ${out.injected} 份总结，${role.name} 之后就记得这段了。`);
      else lines.push("这次没有可写进记忆库的总结（剧情还没演出内容）。");
      if (out.error) lines.push(`⚠️ 结束时那份大总结没生成出来：${out.error}`);
      await say(lines.join("\n"));
    }, runner);
    return;
  }

  // 手动小/大总结
  const kind = action === "sumbig" ? "big" : "small";
  const what = kind === "big" ? "大总结" : "小总结";
  const storyId = readIndex(roleKey).currentId;
  if (!storyId) {
    await say(`现在没有在演的剧情，出不了${what}。发 /开启线下 起一段。`);
    return;
  }
  await respondingWhile(space, async () => {
    let made;
    try {
      made = await summarizeNow(config, role, storyId, kind);
    } catch (e) {
      logError(scope, `手动${what}失败`, e);
      await say(`⚠️ ${what}没生成出来：${String(e?.message ?? e)}`);
      return;
    }
    if (!made) {
      await say(`还没有可以${what}的内容。`);
      return;
    }
    await say(`✅ 出了一份${what}（第 ${made.from + 1}-${made.to} 轮）：\n\n${made.text}`);
  }, runner);
}

/**
 * 线下模式的一轮：iMessage 这一侧。
 *
 * 生成本身全在 `offline.js`（存档、提示词、正则、总结都在那边），这里只管
 * 「怎么发出去」这一件事：
 *
 *  - 正文走 `splitBubbles` 拆气泡，和角色平时说话一个待遇 —— 用的是同一个
 *    分隔符设置，用户在预设里怎么排版，线下就怎么出来。
 *  - **四条选项各发一条气泡**（用户点名的：「剧情选项就切割为 4 个气泡出来」），
 *    前面缀上序号，对方直接回「2」或者把那句话打出来都行。
 *  - 落盘在 `runOfflineTurn` 里就做完了（先落盘再发，照 runAssistTurn），
 *    所以这里发失败最多是这一轮没看到，剧情不会缺。
 *
 * 这一轮**不属于线上**：不写 runner.history、不调 sessions 的 appendTurn、
 * 不碰 messageCount、不走 afterTurn（记忆库、日记、IG 那些钩子都在那里面）。
 * 线下的记忆走的是「结束时把总结注入待总结」那条路，不是每轮都记。
 */
async function runOfflineTurnHere(getConfig, runner, space, spaceId, userText, peer = "") {
  const config = getConfig();
  const role = currentRole(config, runner);
  const scope = scopeOf(runner, "线下模式");

  const said = String(userText ?? "").trim();
  if (!said) return;

  if (!role) {
    await sendSystem(runner, space, "⚠️ 这条线路现在没绑角色。发 /关闭线下 退出线下模式。", {
      what: "线下模式的提示",
    });
    return;
  }

  let out;
  try {
    out = await respondingWhile(
      space,
      () => runOfflineTurn(config, role, resolveUser(config, role), { text: said }),
      runner
    );
  } catch (e) {
    /*
     * 线下在这一轮排队期间被关掉了（人在网页上按了「结束线下」，而这条早就
     * 进了 `chain`）。这不是故障，所以不报 error、也不说「没回上来」——
     * 那句话会让用户以为模型挂了，然后一直重发。
     */
    if (e?.offlineClosed) {
      logInfo(scope, "这一轮排队时线下已经被关掉了，不生成");
      try {
        await sendSystem(runner, space, `⚠️ ${String(e?.message ?? e)}`, {
          what: "线下模式的提示",
        });
      } catch (sendErr) {
        logWarn(scope, "连提示都发不出去", sendErr);
      }
      return;
    }
    logError(scope, "线下这轮没回上来", e);
    try {
      await sendSystem(runner, space, `⚠️ 这轮没回上来：${String(e?.message ?? e)}`, {
        what: "线下模式的出错说明",
      });
    } catch (sendErr) {
      logWarn(scope, "连出错说明都发不出去", sendErr);
    }
    return;
  }

  const bubbles = splitBubbles(out.display, config.chat);
  let sent = 0;
  for (const [i, bubble] of bubbles.entries()) {
    /*
     * 线下没有媒体那条路（format 条目整段不进提示词，模型照理学不会写标记），
     * 但「照理」不兜底：线下预设里那条「线上聊天记录」会把带标记的线上发言摆
     * 到模型眼前，有样学样写出 `[audio_message:…]` 不是不可能。原样发出去就是
     * 一对方括号，所以照线上「功能关着」的同一套待遇退化 —— 语音变文字、
     * 图片描述丢弃。整条都是要丢的标记时这条就不发了。
     */
    const plain = degradeToPlain(bubble.text, role?.transfer?.currency);
    if (!plain) continue;
    try {
      await sleep(bubble.delay); // 秒。按字数算的打字停顿，和线上一套（delay.js）
      await space.send(plain);
      sent += 1;
    } catch (e) {
      logError(scope, `线下正文第 ${i + 1} 条发不出去`, e);
      break;
    }
  }

  /*
   * 选项。走 `space.send` 而不是 `sendSystem` —— 它们是剧情的一部分
   * （模型写的、进了存档的），不是系统发言。防相亲开着的时候也照发：
   * 那道闸挡的是「指令确认、报错、总结」这类一眼就露馅的东西，
   * 而线下剧情本身用户是主动开着在演的。
   */
  for (const [i, option] of out.options.entries()) {
    try {
      await sleep(0.6); // 秒。太快连发，iMessage 那边的先后顺序不一定保得住
      await space.send(`${i + 1}. ${option}`);
    } catch (e) {
      logError(scope, `线下第 ${i + 1} 条选项发不出去`, e);
      break;
    }
  }

  logInfo(
    scope,
    `线下这轮发了 ${sent} 条正文${out.options.length ? ` + ${out.options.length} 条选项` : ""}` +
      `（会话 ${sessionIdOf(runner, role, peer || spaceId)}）`
  );
}

/**
 * 联网搜索的那一趟往返。
 *
 * 模型第一次回复里写了 `[搜索:关键词]` 时：真的去搜一次，把结果接在那条回复
 * 后面当一条 user 消息，再问一次模型。对方只会收到第二次的回复。
 *
 * 几条刻意的选择：
 *
 *  - **只搜一轮。** 第二次回复里再写 [搜索:…] 也不管了（提示词里也说了一次
 *    最多两个）。允许套娃的话一轮对话能打好几次上游，用户在那头干等着。
 *  - **中间这一趟不进 history、不进存档。** 调用方拿到的是最终那条回复，
 *    那条才写历史。搜索结果和模型自己写的标记都是只对这一轮有意义的东西，
 *    进了存档就要在后面每一轮里重发一遍过期内容（和天气一个道理，
 *    见 env.js 文件头）。所以这里只在 messages 的**副本**上加东西。
 *  - **搜不到不算失败。** runSearch 从不抛错；一条结果都没有时照样问第二次，
 *    只是那段话变成「没搜到」—— 让模型自己跟对方说不知道，比让这轮
 *    静默失败强。
 *  - 第二次生成失败**不吞异常**：让调用方的 catch 去 notifyFailure，
 *    和主副 API 都挂掉是同一种处理。
 *
 * @param {object} ctx
 * @param {(followUp: object[]) => void} [ctx.onPrompt] 第二次那份提示词组好时回调一次，
 *        调用方用它更新「原始提示词」面板 —— 搜完之后真正最后发出去的是第二份
 * @returns {Promise<string|null>} 第二次的回复原文；这轮不需要搜索时返回 null
 */
async function searchRound(
  reply,
  { role, config, eps, params, messages, scope, llmScope, onPrompt }
) {
  // 角色那道闸。提示词那边也拦着（prompt.js:formatBlock 关着时压根不会
  // 告诉模型有这个功能），这里再拦一次 —— 模型凭自己的记忆瞎写一个
  // [搜索:…] 出来也不该真的往外发请求
  if (!role?.webSearch?.enabled) return null;

  // 三个额度都来自这个角色（config.js:normalizeWebSearch 已经收过口）。
  // 搜几次这道要在解析时就用上 —— 模型写了五个标记，认前两个，
  // 后面三个连请求都不发
  const limits = role.webSearch;
  const queries = parseSearchQueries(reply, limits.maxQueries);
  if (!queries.length) return null;

  logInfo(scope, `模型要求联网搜索 ${queries.length} 条：${queries.join(" / ")}`);

  const { text, hits, source, cut } = await runSearch(
    queries,
    config.searchApi,
    scope,
    limits
  );

  /*
   * 结果拼成一条 user 消息。用 user 而不是 system：这段是「刚拿到的资料」，
   * 摆在对话末尾最自然，也不用去改前面那些 system 块的结构。
   *
   * **「照原来的格式」这句必须有。** 只写「现在正式回答对方」的话，模型会把
   * 它当成「跳过前面所有格式要求，直接说话」—— 实测就是这样：预设里那个
   * 思维链条目还在提示词里，第二次回复却一个 <thinking> 都不写。而存档里存的
   * 是第二次那条，于是「上下文」面板里的思维链整轮消失（这是用户报的第二个
   * 问题）。这里明确说一遍格式照旧，思考块该写还得写。
   */
  const keepFormat =
    "照你原来的格式回答（预设里要求的思考块、气泡分隔这些照旧写，别因为这段资料就省掉）。";
  const note = text
    ? `<搜索结果>\n${text}\n</搜索结果>\n\n上面是刚查到的资料。现在正式回答对方，别再写 [搜索:…]。` +
      `资料里没提到的别硬说，也不用跟对方交代你查过东西。${keepFormat}`
    : "<搜索结果>\n这次没查到有用的结果。\n</搜索结果>\n\n" +
      `现在正式回答对方，别再写 [搜索:…]。不知道就照实说不清楚，别编。${keepFormat}`;

  // 副本 —— 原数组是 notePrompt 记下的那一份，不能动
  const followUp = [
    ...messages,
    // 模型自己写的标记也带上：不带的话它看不出这段资料是自己要的
    { role: "assistant", content: reply },
    { role: "user", content: note },
  ];

  /*
   * 搜到的正文写进控制台，级别是 info 不是 debug。
   *
   * 用户要求「在控制台内可以看到联网返回的内容」。debug 那一档默认是被
   * 前端的级别过滤挡掉的，放 info 才是真的看得见。第二个参数（detail）
   * 前端点开才展开，所以正文再长也不会把日志列表冲垮。
   *
   * 注意这是**唯一**一份留痕：note 只进 followUp 那个副本，不进 history、
   * 不进存档（见本函数上面的说明），所以想回看这轮搜到了什么只能靠这条。
   */
  logInfo(
    llmScope,
    `联网搜索注入 ${hits} 条结果（${source}，${text.length} 字` +
      `${cut ? `，已按 ${limits.maxChars} 字截断` : ""}），只注入这一次`,
    text || "（没搜到结果）"
  );
  logDebug(llmScope, "正在等搜索后的第二次回复…");

  // 「原始提示词」面板里换成第二次这份 —— 搜完之后真正最后发出去的是它，
  // 留着第一次那份会让人以为搜索结果压根没注入
  onPrompt?.(followUp);

  const { content } = await chatWithFallback(eps.chat, eps.fallback, followUp, params);
  logInfo(llmScope, `搜索后的回复 ${content.length} 字`, content);
  return content;
}

/**
 * 查岗的那一趟往返。
 *
 * 模型第一次回复里写了 `[查岗实时电脑屏幕]` / `[查岗实时手机屏幕]` 时：真去抓
 * 一张屏幕、识成文字，接在那条回复后面当一条 user 消息，再问一次模型。
 * 对方只会收到第二次的回复。
 *
 * **整个函数刻意照着上面 searchRound 写**，那几条选择在这儿是同样的道理：
 *
 *  - **只查一轮。** 第二次回复里再写查岗标签也不管了。允许套娃的话一轮对话
 *    能抓好几次屏幕、打好几次识图，用户在那头干等着。
 *  - **中间这一趟不进 history、不进存档。** 屏幕内容是只对这一轮有意义的东西
 *    （比搜索结果更甚 —— 三小时后那个画面早翻篇了），进了存档就要在后面
 *    每一轮里重发一遍过期画面（见 env.js 文件头）。所以只在 messages 的
 *    **副本**上加东西。想回看这轮看到了什么，看控制台里那条 info 日志。
 *  - **没看到不算失败。** runSpy 从不抛错；两头都没抓到时照样问第二次，
 *    只是那段话变成「都没看到」—— 让模型按人设自己找台词，比让这轮
 *    静默失败强（用户要的「都失败时的提示模板」就是这一路）。
 *  - 第二次生成失败**不吞异常**：交给调用方的 catch，和搜索那条一样。
 *
 * @param {object} ctx 同 searchRound，另外要 `user` 来填模板里的 `{{user}}`，
 *                     以及 `spyApi`（全局那份，手机那条腿的 SMTP 凭据）
 * @returns {Promise<string|null>} 第二次的回复原文；这轮不查岗时返回 null
 */
async function spyRound(
  reply,
  { role, eps, spyApi, params, messages, user, scope, llmScope, onPrompt }
) {
  /*
   * 角色那道闸。提示词那边也拦着（prompt.js:formatBlock 两条腿都关时压根不会
   * 告诉模型有这个功能），这里再拦一次 —— 模型凭记忆硬写一个标签出来，不该
   * 真的就去抓用户的屏幕。这道闸比搜索那道更要紧：那边泄的是关键词，这边是屏幕。
   */
  const legs = spyLegs(role);
  if (!legs.any) return null;

  let want = spyTargetIn(reply);
  if (!want) return null;

  /*
   * 模型要的那条腿关着。
   *
   * 只开一条腿时提示词里已经把另一条腿的标签删掉了（spy.js:trimSpyPrompt），
   * 但模型凭记忆硬写是有的 —— 这儿是那种情况唯一的拦法。
   *
   * 开着的那条腿当「它其实想看一眼屏幕」来满足，前提是自动回退开着：这和
   * 「想看的那头没看到就改看另一头」是同一件事，只是原因从「没抓到」变成
   * 「那条腿没开」。回退关着就当这轮没查岗 —— 用户明说了不要跨腿。
   */
  if (!legs[want]) {
    const other = want === "pc" ? "phone" : "pc";
    if (!role?.spy?.autoFallback) {
      logWarn(
        scope,
        `模型要看${DEVICE_NAMES[want]}屏幕，但这条腿的开关是关的，自动回退也关着，这轮不查岗`
      );
      return null;
    }
    logInfo(
      scope,
      `模型要看${DEVICE_NAMES[want]}屏幕，但这条腿的开关是关的，改看${DEVICE_NAMES[other]}屏幕`
    );
    want = other;
  }

  logInfo(scope, `模型要求查岗：看${DEVICE_NAMES[want]}屏幕`);

  const note = await runSpy(want, {
    role,
    eps,
    spyApi,
    userName: user?.name ?? "",
    scope,
  });

  /*
   * 和搜索那边同一个理由，「照原来的格式」这句必须有：只说「现在正式回答对方」
   * 的话，模型会当成「跳过前面所有格式要求」，第二次回复里一个 <thinking> 都
   * 不写，而存档里存的正是第二次那条 —— 「上下文」面板里的思维链会整轮消失。
   */
  const followUp = [
    ...messages,
    // 模型自己写的标签也带上：不带的话它看不出这段屏幕内容是自己要的
    { role: "assistant", content: reply },
    {
      role: "user",
      content:
        `${note}\n\n` +
        "照你原来的格式回答（预设里要求的思考块、气泡分隔这些照旧写，" +
        "别因为这段内容就省掉）。",
    },
  ];

  logInfo(llmScope, `查岗内容注入 ${note.length} 字，只注入这一次`, note);
  logDebug(llmScope, "正在等查岗后的第二次回复…");

  // 「原始提示词」面板里换成第二次这份 —— 真正最后发出去的是它
  onPrompt?.(followUp);

  const { content } = await chatWithFallback(eps.chat, eps.fallback, followUp, params);
  logInfo(llmScope, `查岗后的回复 ${content.length} 字`, content);
  return content;
}

/**
 * 手机里那一趟往返。
 *
 * 模型回复里写了 `[查岗手机:支付宝账单]` / `[操控手机:锁屏]` 时：真去做那件事，
 * 把结果接在那条回复后面当一条 user 消息，再问一次模型。对方只收到第二次的回复。
 *
 * **和上面 spyRound 是同一个形态**，那几条选择在这儿同样成立（只一轮、中间这趟
 * 不进 history 不进存档、没做成也照样问第二次、第二次生成失败不吞异常）。
 *
 * 但有一处刻意不一样：**没有互相兜底。** 屏幕那两条腿是「想知道他在干什么」的
 * 两种办法，一头不通换另一头是同一个目的；这儿的十九件事各是各的，「支付宝账单
 * 没看到」不能改成「那看看微信吧」—— 模型要的是账单，给它别的等于答错题。
 *
 * 操控类那一路更不能兜：「锁屏没成功那就放首歌」是荒谬的。
 *
 * @param {object} ctx 同 spyRound
 * @returns {Promise<string|null>} 第二次的回复原文；这轮没写手机标签时返回 null
 */
async function phoneRound(
  reply,
  { role, eps, spyApi, params, messages, user, scope, llmScope, onPrompt }
) {
  /*
   * 角色那三道闸。提示词那边也拦着（spy.js:trimSpyPrompt 会把关掉那几组的行
   * 删掉），这里再拦一次 —— 模型凭记忆硬写一个标签出来，不该就真的去开用户的
   * 支付宝、或者把他手机锁掉。这道闸比屏幕那道更要紧：那边泄的是一张桌面截图，
   * 这边是账单流水，而操控那半边压根不是「泄」，是**改**用户手机的状态。
   */
  const legs = spyLegs(role);
  if (!legs.view && !legs.control && !legs.music) return null;

  const want = phoneTargetIn(reply);
  if (!want) return null;

  /*
   * 这一类的开关关着。
   *
   * 不像屏幕那边能倒向另一条腿 —— 这儿没有「另一头」（见函数头），所以直接
   * 当这轮没写标签。pool 空了也走这条：查看类没开、或者操控类那两个开关都没开。
   */
  const pool = phonePool(want.kind, legs);
  if (!pool.length) {
    const what = want.kind === "view" ? "看他手机里的东西" : "操控他手机";
    logWarn(scope, `模型想${what}（${want.keyword}），但这一类的开关是关的，这轮不做`);
    return null;
  }

  logInfo(
    scope,
    `模型要${want.kind === "view" ? "看手机里的" : "操控手机："}${want.keyword}`
  );

  const note = await runPhone(want, {
    role,
    eps,
    spyApi,
    userName: user?.name ?? "",
    scope,
  });

  // 「照原来的格式」这句必须有，和 spyRound 同一个理由（不写的话第二次回复里
  // 一个 <thinking> 都没有，而存档里存的正是第二次那条）
  const followUp = [
    ...messages,
    { role: "assistant", content: reply },
    {
      role: "user",
      content:
        `${note}\n\n` +
        "照你原来的格式回答（预设里要求的思考块、气泡分隔这些照旧写，" +
        "别因为这段内容就省掉）。",
    },
  ];

  logInfo(llmScope, `手机那件事的结果注入 ${note.length} 字，只注入这一次`, note);
  logDebug(llmScope, "正在等手机那件事之后的第二次回复…");

  onPrompt?.(followUp);

  const { content } = await chatWithFallback(eps.chat, eps.fallback, followUp, params);
  logInfo(llmScope, `手机那件事之后的回复 ${content.length} 字`, content);
  return content;
}

/**
 * 发一个已读回执，让对方那头的气泡显示「已读」。
 *
 * **会话级、不可逆。** iMessage 远端模式走的是 `chats.markRead(chatGuid)`，
 * 一次会把这个 chat 里**所有**未读都标成已读，没法只标某一条 ——
 * 所以角色那边默认关着，得用户自己打开（见 config.js:normalizeLeaveOnRead）。
 *
 * 本地 Mac 模式（@spectrum-ts/imessage-local）会抛 UnsupportedError。
 * 这里不让它影响这轮回复：发不出去就记一条 debug 继续走 ——
 * 已读回执是锦上添花，为它中断一轮对话不值得。
 *
 * @returns {Promise<boolean>} 发出去了没有
 */
async function markRead(runner, space, message, scope) {
  if (!message) return false;
  try {
    const { read } = await import("spectrum-ts");
    await space.send(read(message));
    logDebug(scope, "已发已读回执");
    return true;
  } catch (e) {
    // 本地模式不支持、或者这条消息已经不在会话里了。都不是错，别惊动用户
    logDebug(scope, "已读回执发不出去（这个平台可能不支持）", String(e?.message ?? e));
    return false;
  }
}

/**
 * 一轮完整对话：识别图片 → 写历史 → 问 LLM →（要搜就搜）→ 记回复 → 分气泡发出 → 落盘存档。
 *
 * `meta.message` 是这一轮里最后收到的那条原始 Message，只用来发已读回执
 * （read() 不收 id 字符串）。攒队列时带进来的，见 enqueue。
 *
 * `meta.reroll` 是 `/重roll` 那条路：userText 传的是**从存档里摘回来的那条
 * user 消息原文**，而不是对方刚打的字。差别有三处，都在下面标了 `meta.reroll`：
 * 不再走一遍 userInput 正则、不再加时间前缀（这两样在它第一次进存档时就做过了，
 * 再来一遍就是双份），以及**不调 afterTurn** —— 重生成的是「同一轮」，
 * 记忆库那笔待总结在第一次就记过了，再记一次会把这轮算成两轮。
 */
async function handleTurn(
  getConfig,
  runner,
  space,
  spaceId,
  userText,
  images = [],
  peer = "",
  meta = {}
) {
  const config = getConfig();
  const role = currentRole(config, runner);
  const scope = scopeOf(runner, "桥接");
  const isReroll = Boolean(meta.reroll);
  const voices = meta.voices ?? [];
  const videos = meta.videos ?? [];

  logInfo(
    scope,
    `${isReroll ? "重新生成上一轮" : "收到一轮消息"}（${spaceId}）：${
      userText ? `“${userText.slice(0, 80)}${userText.length > 80 ? "…" : ""}”` : "无文本"
    }${images.length ? ` + ${images.length} 张图片` : ""}${
      voices.length ? ` + ${voices.length} 条语音` : ""
    }${videos.length ? ` + ${videos.length} 段视频` : ""}`
  );

  /*
   * 这一轮要是提前退了，视频的字节得撒手。
   *
   * describeVideos 里那个 finally 是这几十 MB 的正常归宿，但它在下面好几十行
   * 之后 —— 中间有两处 return（没绑角色、聊天模型没配好）跳过它。不放的话
   * 那段 base64 会跟着 meta.videos 一直挂到 GC 把整条闭环收走为止，而
   * 「配置没填好」恰恰是会反复触发的状态：对方每发一段视频就多攒 27MB。
   */
  const dropVideos = () => {
    for (const v of videos) v.release?.();
  };

  // 角色被解绑/删掉了：连接还在但没人该回话，说清楚而不是拿空人设硬答
  if (!role) {
    dropVideos();
    logWarn(scope, "这个项目当前没有绑定角色，这轮不回复");
    return;
  }

  // 会话 ID = 角色名 + 自己这条线路的号码（例 阿瑞18005550100）。历史和存档
  // 都按它索引，所以同一条线路换了角色就是另一份存档。见 sessionIdOf
  const sessionId = sessionIdOf(runner, role, peer || spaceId);

  const eps = resolveRoleEndpoints(config, role);

  // 聊天模型没配好（没选、被删、被关掉）就别硬打上游 —— 说清楚哪里缺
  if (!eps.chat) {
    dropVideos();
    const why =
      "去「角色」面板的「单独配置」里选一个聊天模型；如果原来选过，可能是那个模型被删了或被关掉了。";
    logError(scope, "这个角色的聊天 API 没配好，这轮不回复", why);
    await notifyFailure(runner, space, "这个角色的聊天模型还没配好", why);
    return;
  }

  /*
   * 已读回执：放在这里发，也就是**开始想怎么回之前**。
   *
   * 时机是刻意的 —— 真人是「读完 → 开始打字 → 发出来」，所以已读要先于
   * 打字指示器（sendBubbles 里那个 startTyping）出现。放到发气泡的时候再标，
   * 对方会看到「已读」和回复几乎同时冒出来，反而更像机器。
   *
   * 识图和 LLM 加起来要好几秒到几十秒，这段时间对方看着「已读」等回复，
   * 正是真实聊天的样子。已读不回那条路更依赖这个顺序：标记要生效，
   * 前提是对方已经看到「已读」了。
   */
  if (role.leaveOnRead?.receipt) {
    await markRead(runner, space, meta.message, scope);
  }

  // 内存里没有这条会话的历史时，从磁盘回填最后 maxContext 条。
  // 只读这几条：磁盘上存了几千条也不影响内存占用。
  loadHistory(runner, role, sessionId, scope);

  /*
   * 图、语音、视频先各自转成文字，再和用户的原话拼成一条 user 消息进历史。
   *
   * 三条线**同时**跑：它们互相不依赖（各自的模型、各自的上限、一路失败不影响
   * 另一路），以前串着 await 纯粹是白等 —— 图文语音混发的那一轮，用户等的是
   * 三段时间的和。三个 describe* 内部都已经把单条的失败吃掉了，只会 resolve，
   * 所以这里用 Promise.all 不会漏掉谁的清理。
   *
   * 视频那一路识别完会在自己内部把字节放掉（见 describeVideos），所以从这行
   * 往下，这一轮只剩几百字的描述在手上。
   */
  const [vision, voice, video] = await Promise.all([
    describeImages(eps.vision, eps.visionPrompt, eps.maxImages, runner, images),
    describeVoices(eps.audio, eps.audioPrompt, eps.maxClips, runner, voices),
    describeVideos(eps.video, eps.videoPrompt, eps.maxVideos, runner, videos),
  ]);
  /*
   * 正则第一路：对方发来的原话。
   *
   * 只作用于他真正打的字，在和识图描述拼成 combined **之前** ——
   * 不去动我们自己生成的「[用户发来的图片] …」那段：用户写的规则不该有机会
   * 把程序生成的文本改坏。
   *
   * 预设在这里先解析一次（拿正则规则），下面 buildPrompt 里还会再解析一次。
   * 两次之间配置可能被改过，但那影响不了正确性，也没必要为此把 preset 传来传去。
   */
  const rules = resolvePreset(config, role).regex;
  // 重 roll 那条路不再跑一遍 userInput 正则：userText 是从存档摘回来的，
  // 第一次进存档之前就已经过滤过了，再来一遍等于同一条规则连着作用两次
  const cleanUserText = isReroll
    ? userText
    : applyAndLog(
        userText,
        rules,
        { target: "userInput", vars: { char: role?.name ?? "", user: "" } },
        "对方的消息"
      ).text;

  const said = [cleanUserText, vision.text, voice.text, video.text]
    .filter(Boolean)
    .join("\n\n");
  if (!said) {
    // 正则把对方的话整段吃掉、这轮又没有图也没有语音，等于没有输入可发。
    // 判的是**前缀之外**的部分 —— 环境前缀总是非空的，算进来这个分支就永远走不到
    logWarn(scope, "这一轮既没文本，也没能识别出图片或语音内容，跳过");
    return;
  }

  const llmScope = scopeOf(runner, "LLM");
  const freshConfig = getConfig();
  const freshRole = currentRole(freshConfig, runner) ?? role;
  const user = resolveUser(freshConfig, freshRole);

  /*
   * 环境信息：时间和天气**分两条路**走。
   *
   * 时间拼成方括号前缀加在对方原话前面，跟着 combined 一起进内存历史、
   * 进存档、进提示词 —— 于是每条历史消息都自带它当时的时间戳。
   *
   * 天气不进存档：它是只对「现在」有意义的瞬时值，进了存档就要在后面
   * 每一轮里被重发一遍（maxContext = 20 时是 20 份过期天气、约 900 token
   * 白花）。所以它单独交给 buildPrompt，只并进这一轮发给模型的最新一条
   * user 消息里。
   *
   * 同样在 userInput 正则**之后** —— 和上面一个道理：用户写的规则不该有
   * 机会改坏程序生成的文本。
   *
   * 里面的 {{user}} / {{char}} 是字面量，替换在 prompt.js 里做
   * （存档存字面量，角色改名后旧存档不失效）。
   *
   * 拿不到就是空串，绝不因为查不到天气而挡住一条回复。
   */
  const { time: timePrefix, weather: weatherNote } = await buildEnv(
    freshRole,
    freshConfig.weatherApi
  );

  /*
   * 重 roll 不再加时间前缀：`said` 本身就是当时那条带前缀的原文（从存档摘回来的）。
   * 再加一层就成了「[现在的时间][当时的时间] 原话」，而且重生成的是**同一轮**，
   * 时间戳本来也该保持是原来那个。天气照旧现查现注入 —— 它不进存档，
   * 每次生成都是拿此刻的那份（和用户「什么时候生成就注入什么时间的天气」一致）。
   */
  const combined = isReroll ? said : timePrefix + said;

  /*
   * 一个字没打、而且这轮收到的图 / 语音 / 视频**全都**识别失败：模型拿到的
   * 只是几行「识别失败（…）」，硬答出来的东西必然是瞎猜的。直接把真正的原因
   * 发回去，别让对方以为 AI 看到/听到了。
   *
   * 判的是「全都」——有文本、或者三路里有任意一路成功了，就照常回：
   * 那半轮是有效的（发了图又发语音，图挂了但语音听清了，还是能接上话）。
   *
   * 三路是**按表遍历**而不是写死 `a.total + b.total`：加第四路多媒体时只要
   * 往表里加一行，这段判断和下面那句人话都自动跟上。原来那个两路版本写的是
   * 嵌套三目（`图 && !语音 ? … : 语音 && !图 ? … : …`），加第三路就得写六种
   * 组合，而漏掉一种的后果是对方收到一句词不达意的道歉。
   */
  const lanes = [
    { r: vision, unit: (n) => `${n} 张图`, alone: "这几张图没能看清" },
    { r: voice, unit: (n) => `${n} 条语音`, alone: "这条语音没能听清" },
    { r: video, unit: (n) => `${n} 段视频`, alone: "这段视频没能看清" },
  ];
  const got = lanes.filter((l) => l.r.total > 0);
  const mediaTotal = got.reduce((n, l) => n + l.r.total, 0);
  const mediaFailed = got.reduce((n, l) => n + l.r.failed, 0);
  if (!cleanUserText && mediaTotal > 0 && mediaFailed === mediaTotal) {
    const what = got.map((l) => l.unit(l.r.total)).join("、");
    const why = got.find((l) => l.r.firstError)?.r.firstError ?? null;
    logError(scope, `这轮 ${what}全部识别失败，不发给模型`, why);
    await notifyFailure(
      runner,
      space,
      // 只有一路的时候说得具体些；好几路一起挂就报个总数，别硬凑组合句
      got.length === 1 ? got[0].alone : `这轮的${what}都没能识别出来`,
      why
    );
    return;
  }

  const historyArr = runner.history.get(sessionId) ?? [];
  historyArr.push({ role: "user", content: combined });
  runner.history.set(sessionId, historyArr);

  // 提示词组装：预设的条目顺序 + 世界书 + 裁剪过的上文，见 prompt.js。
  // 天气单独传 —— 它只进这一份，不进 history
  const built = await buildPrompt(
    freshConfig,
    freshRole,
    user,
    runner.history.get(sessionId) ?? [],
    weatherNote
  );
  const { messages, params, preset, worldInfo } = built;
  // buildPrompt 裁剪过上文，把结果写回内存 —— 以前是 buildMessages 里做的
  runner.history.set(sessionId, built.history);

  if (worldInfo.hitNames.length) {
    logInfo(
      scope,
      `世界书命中 ${worldInfo.hitNames.length} 条：${worldInfo.hitNames.join("、")}`
    );
  }

  // 记下这次的完整提示词（只留最后一次），前端「原始提示词」看的就是它。
  // 搜索那趟的第二次请求会用同一份 meta 再记一次（见下面的 onPrompt）
  const promptMeta = {
    roleId: freshRole.id,
    roleName: freshRole.name,
    sessionId,
    userId: user?.id ?? "",
    userName: user ? userLabel(user) : "",
    model: eps.chat.label ?? "",
    presetName: presetLabel(preset),
    worldHits: worldInfo.hitNames,
  };
  notePrompt(promptMeta, messages);
  /*
   * 这行以前是 debug —— 也就是默认那档看不见。
   *
   * 于是一轮里**最长**的那段等待（CHAT_TIMEOUT 是 300 秒，还要加上重试）在
   * 控制台里是完全空白的：上一行是「收到一轮消息」，下一行就是「模型回复
   * xx 字」，中间那一两分钟没有任何东西说明「正在等模型」。用户看到的就是
   * 日志停住不动，分不出是在等模型、卡死了、还是压根没收到消息。
   *
   * 所以提到 info。每轮只多一行，换来的是「静默的这段时间在干什么」有答案。
   */
  logInfo(
    llmScope,
    `发给模型 ${messages.length} 条消息${user ? `（用户人设：${userLabel(user)}）` : ""}，` +
      `预设「${presetLabel(preset)}」，正在等回复…`
  );

  let reply;
  const askedAt = Date.now();
  try {
    // 主模型失败自动退到这个角色自己的副 API。生成参数来自预设，主副共用
    const { content } = await chatWithFallback(eps.chat, eps.fallback, messages, params);
    reply = content;
  } catch (e) {
    // 主副都挂了：历史里那条 user 消息留着（下轮还能带上），但要说清楚。
    // 带上等了多久 —— 「等 3 秒就报错」和「等满 300 秒超时」是两种毛病
    logError(llmScope, `这一轮没能拿到回复（等了 ${secsSince(askedAt)}s）`, e);
    // 让对方知道这轮为什么没回，不用去翻控制台
    await respondingWhile(space, () => notifyFailure(runner, space, "这条消息没回上来", e), runner);
    throw e;
  }

  logInfo(llmScope, `模型回复 ${reply.length} 字，花了 ${secsSince(askedAt)}s`, reply);

  /*
   * 联网搜索：回复里写了 [搜索:…] 就真去搜一趟，拿结果再问一次。
   *
   * 换掉 reply 之后下面的一切都照常走 —— 存档、历史、正则、气泡拆分看到的
   * 都是搜索**之后**那条最终回复。
   *
   * **搜索结果只注入这一次。** 那 800 字只活在 searchRound 里面那个 followUp
   * 副本上，出了这个 try 就没人引用它了：下面写进 history 和存档的是 reply
   * （模型的回复本身），不含 <搜索结果>。所以哪怕上下文限制是 20 条，
   * 也不会有 20 份过期资料被反复重发（和天气同一个道理，见 env.js 文件头）。
   * 想回看这轮搜到了什么，看控制台里那条 info 日志。
   *
   * 第二次生成也挂了的话和第一次一样处理（notifyFailure + throw）：历史里
   * 那条 user 消息留着，下轮还能带上。
   */
  try {
    const searched = await searchRound(reply, {
      role: freshRole,
      config: freshConfig,
      eps,
      params,
      messages,
      scope,
      llmScope,
      onPrompt: (followUp) => notePrompt(promptMeta, followUp),
    });
    if (searched !== null) reply = searched;
  } catch (e) {
    logError(llmScope, "联网搜索之后那次生成失败，这一轮没能拿到回复", e);
    await respondingWhile(space, () => notifyFailure(runner, space, "这条消息没回上来", e), runner);
    throw e;
  }

  /*
   * 查岗：回复里写了 `[查岗实时电脑屏幕]` / `[查岗实时手机屏幕]` 就真去抓一张
   * 屏幕，识成文字再问一次。和上面的搜索是同一个形态（见 spyRound）。
   *
   * **排在搜索之后**：两个标签都写了的话先搜再查岗。搜索那趟返回的是最终回复，
   * 查岗在它的结果上再判一次 —— 也就是说模型在第二次回复里写查岗标签同样有效。
   * 反过来（先查岗再搜索）会让「查完屏幕想搜一下屏幕上那个东西」变成死路。
   *
   * 屏幕内容同样**只注入这一次**，不进 history 也不进存档，理由见 spyRound。
   */
  try {
    const spied = await spyRound(reply, {
      role: freshRole,
      eps,
      // 全局那份：手机那条腿的 SMTP 凭据。用 freshConfig 和 freshRole 保持同一份快照
      spyApi: freshConfig?.spyApi,
      params,
      messages,
      user,
      scope,
      llmScope,
      onPrompt: (followUp) => notePrompt(promptMeta, followUp),
    });
    if (spied !== null) reply = spied;
  } catch (e) {
    logError(llmScope, "查岗之后那次生成失败，这一轮没能拿到回复", e);
    await respondingWhile(space, () => notifyFailure(runner, space, "这条消息没回上来", e), runner);
    throw e;
  }

  /*
   * 手机里那十九件事。和上面查岗同一个形态（见 phoneRound）。
   *
   * **排在屏幕查岗之后**，理由和「搜索排在查岗之前」一样：查岗那趟返回的是最终
   * 回复，这儿在它的结果上再判一次 —— 也就是「先看一眼他手机屏幕，发现他在刷
   * 淘宝，那再看看他购物车」这条路是通的。反过来排的话那条路是死的。
   */
  try {
    const phoned = await phoneRound(reply, {
      role: freshRole,
      eps,
      spyApi: freshConfig?.spyApi,
      params,
      messages,
      user,
      scope,
      llmScope,
      onPrompt: (followUp) => notePrompt(promptMeta, followUp),
    });
    if (phoned !== null) reply = phoned;
  } catch (e) {
    logError(llmScope, "动手机之后那次生成失败，这一轮没能拿到回复", e);
    await respondingWhile(space, () => notifyFailure(runner, space, "这条消息没回上来", e), runner);
    throw e;
  }

  /*
   * 正则第二路：发回 iMessage 的那份。
   *
   * 勾了 toHistory 的规则**不在这里跑** —— 内存历史和落盘存档一律留模型原文，
   * 那份过滤挪到了 prompt.js 的 filterHistory，拼提示词时才执行。这样思维链在
   * 「上下文」面板里看得见（能知道模型当时怎么理解剧情），发给模型的那份里没有。
   */
  const vars = { char: freshRole?.name ?? "", user: user?.name ?? "" };
  let forUser = applyAndLog(
    reply,
    rules,
    { target: "aiOutput", field: "toUser", vars },
    "AI 回复（发给对方）"
  ).text;

  /*
   * 搜索标记只在**发给对方**这一路上收掉，不动 reply。
   *
   * 用户明确要求「使用功能的时候不要过滤任何标签」：`[搜索:…]` 和 <thinking>
   * 一样是模型的原文，内存历史、落盘存档、「上下文」面板里都该看得见 ——
   * 之前是直接改 reply，等于把存档也一起洗了，那条正好违反上面那段说的
   * 「存档一律留模型原文」。
   *
   * 对方那头还是不能看到这个标记（内部约定，看不懂），所以收在这里：
   * 排在正则之后，用户自己写的规则先跑，行为和 <thinking> 那条完全对称。
   * 收完整条空了的话走下面那个空正文分支。
   */
  const withoutTags = stripSearchTags(forUser);
  if (withoutTags !== forUser.trim()) {
    logInfo(scope, "发给对方的那份里收掉了 [搜索:…] 标记（存档留原文）", forUser);
    forUser = withoutTags;
  }

  // 查岗标签同理：只在发给对方那一路上收掉，reply 不动（见 spy.js:stripSpyTags）
  const withoutSpy = stripSpyTags(forUser);
  if (withoutSpy !== forUser.trim()) {
    logInfo(scope, "发给对方的那份里收掉了查岗标签（存档留原文）", forUser);
    forUser = withoutSpy;
  }

  /*
   * 已读不回：这一轮什么都不发。
   *
   * 排在正则和搜索标记之后 —— 用户自己的规则先跑完，判的是最终要发出去的那份。
   *
   * **兜底：混着文字时把文字丢掉。** 用户明确要求过这一条：模型写
   * `[leave_on_read]{{sep}}别烦我` 的时候，那句「别烦我」不能发出去 ——
   * 已读不回的意思就是没有回应，发一句话出去等于这个功能没生效。
   *
   * 但**上下文只记 `[leave_on_read]`**（也是用户要求的）：把「别烦我」也存进去，
   * 下一轮模型会以为自己上次说过这话，越滚越偏。所以这里改的是 reply 本身 ——
   * 这是整个 handleTurn 里唯一一处动 reply 的地方（别处一律「存档留原文」），
   * 因为这里的原文**本身就是污染源**，留着比洗掉更糟。
   *
   * 角色那道闸在这里再查一次：提示词里没注入过，但模型可能凭记忆硬写一个出来。
   * 那种情况按普通文字走 —— 标记会被下面的正则/气泡逻辑当文本发出去，
   * 对方看到一串方括号，比莫名其妙不回话容易看出是配置没开。
   */
  if (hasLeaveOnRead(forUser)) {
    if (!role.leaveOnRead?.enabled) {
      logInfo(scope, "模型写了 [leave_on_read]，但这个角色没开「已读不回」，按普通文字发", forUser);
    } else {
      const dropped = stripLeaveOnRead(forUser);
      if (dropped) {
        logWarn(
          scope,
          "已读不回：模型除了指令还写了正文，按约定丢掉那段文字（上下文只记指令）",
          dropped
        );
      }
      logInfo(scope, "已读不回：这轮不发任何消息，只留一条 [leave_on_read] 进上下文");

      // 上下文只记指令本身，不记被丢掉的那段文字 —— 理由见上面
      const hist = runner.history.get(sessionId) ?? [];
      hist.push({ role: "assistant", content: "[leave_on_read]" });
      runner.history.set(sessionId, hist);

      // 存档同样只记指令。这里和「存档留原文」那条通例相反，是刻意的：
      // 存档会被 recentMessages 读回来当上文，留原文等于把污染写进磁盘
      try {
        appendTurn(
          sessionId,
          { roleId: role.id, roleName: role.name, peer: peer || spaceId },
          [
            { role: "user", content: combined },
            { role: "assistant", content: "[leave_on_read]" },
          ],
          (msg) => logWarn(scope, msg)
        );
      } catch (e) {
        logError(scope, `会话 ${sessionId} 存档写入失败`, e);
      }

      // 已读不回也算聊了一轮：记忆库要记这一笔（助手那边记标记本身，
      // 和上面的历史/存档保持一致 —— 总结时模型看到的就是「这轮我没回」）。
      // 重 roll 除外：这一轮的待总结在第一次生成时就记过了，再记一次会算成两轮
      if (!isReroll) {
        afterTurn(runner, space, freshConfig, freshRole, {
          user: combined,
          assistant: "[leave_on_read]",
        });
      }

      /*
       * 已读回执补一次。
       *
       * 上面那次是 receipt 开着才发的，可「已读不回」这个功能本身就要求
       * 对方**必须**看到已读 —— 不然就是纯粹的失踪，和网络故障没区别，
       * 提示词里承诺的「{{user}} 会看到你已读了」也就落不了地。
       * 所以这条路上无条件补一次；已经标过了的话再标一次也没有副作用
       * （markRead 是幂等的，会话里没有未读就什么都不做）。
       */
      if (!role.leaveOnRead.receipt) {
        await markRead(runner, space, meta.message, scope);
      }
      return;
    }
  }

  /*
   * Instagram：模型这轮写了 [post:…] / [story:…]（或者只写了张图、而这个角色
   * 没开生图 —— 判据见 igrun.js:igRouteFor）。
   *
   * 发布完把标签从 forUser 里摘掉，**剩下的照旧当短信发** —— 那正是用户要的
   * 第三种输出：发个帖，顺手再说句话。一条标签都没有的输出根本进不来这里。
   *
   * 历史和存档里留的不是模型原文，是 publishLines 那几句人话。这和「存档
   * 一律留原文」的通例相反，和上面已读不回那条是同一个理由：帖子本身已经
   * 落到 data/instagram/ 了，上下文里再留一份 `[post:…]` 只会教模型下一轮
   * 接着复读格式。
   */
  let recorded = reply;
  let igDone = false;
  if (igRouteFor(freshRole, forUser)) {
    try {
      const parsed = splitIg(forUser, freshConfig.chat?.separator ?? "");
      const lines = publishLines(await publishIgTags(freshConfig, freshRole, parsed));
      igDone = lines.length > 0;
      if (igDone) {
        logInfo(scope, `Instagram：发了 ${lines.length} 条`, lines.join("\n"));
        recorded = [lines.join("\n"), stripIgTags(reply)].filter(Boolean).join("\n");
      }
      forUser = parsed.rest;
    } catch (e) {
      /*
       * IG 那边挂了不该连短信一起黄掉。但标签必须摘干净 —— 原样发出去的话
       * 对方收到的是一串 `[post:…]`，比少发一条帖子难看得多。
       */
      logError(scope, "Instagram 这一轮没发出去（短信照发）", e);
      forUser = stripIgTags(forUser);
    }
  }

  /*
   * 正则把整条回复吃光了（模型这轮只输出了一个思维链块）。
   *
   * 不发空气泡 —— sendBubbles 会把空文本换成「（我暂时答不上来）」，
   * 那句话在这里是误导：不是模型答不上来，是被规则过滤掉了。
   * 静默不回复正是上一版修过的坑，所以照旧走 notifyFailure 说清楚。
   *
   * 整条回复只有一个 `[image:一只橘猫]` 的情况是**正常**的（模型就想发张图，
   * 不想说话），它 trim 出来非空，走不到这个分支。真到了「该发的都没发出去」
   * 那一步由下面 sendBubbles 的返回值兜底。
   *
   * `igDone` 那一轮也是正常的：帖子发出去了、方括号之外一个字没写，forUser
   * 本来就该是空的。那不是失败，别弹「这条没能生成正文」。
   */
  if (!forUser.trim() && !igDone) {
    /*
     * 四种空回，**责任方各不相同** —— 所以每种都要点出该去动哪儿。
     *
     * 以前四句话都只描述现象（「返回的是空内容」「被正则过滤掉了」），
     * 读的人只能得出一个结论：Uranus 坏了。而实际上第一种是上游的事
     * （模型服务商收了 token、回了个 200、正文一个字没有，这我们改不了），
     * 后三种是这台机器上的预设/模型选择的事。指错了方向比不说更费时间。
     */
    const why = !reply.trim()
      ? // 最常见、也最容易被误判成 Uranus 的一种：HTTP 200 + 空正文。
        // token 照扣。多见于推理型模型（思维链吃满了输出长度，正文没写出来）
        // 和中转站的空响应。说清楚是上游回的，并给一条自己能动的路
        "模型服务商返回了成功，但正文是空的（这一轮的 token 照样会扣）。" +
        "这是上游返回的结果，与 Uranus 无关 —— 常见于推理型模型把输出长度全用在" +
        "思维链上，或者中转站回了空响应。可以换个模型再试，或者把这句话发给你的 API 服务商。"
      : stripSearchTags(reply) === ""
        ? "模型这轮只写了 [搜索:…] 标记，没写给对方看的正文。换个更听话的模型会好一些。"
        : // 查岗只查一轮，所以第二次回复里再写标签是没用的 —— 那种回复剥完就空了。
          // 单独说清楚，不然用户看到的是「被正则过滤掉了」，去翻正则规则白费功夫
          stripSpyTags(reply) === ""
          ? "模型这轮只写了查岗标签，没写给对方看的正文（查岗一轮只查一次，" +
            "第二次回复里再写标签不会再查）。"
          : "模型这轮写的东西被预设里的正则规则全部删掉了（大概只输出了思维链，没写正文）。" +
            "这一条不是上游的问题，去「预设 → 正则」里看看哪条规则吃掉了整段。";
    /*
     * 空回按 error 记，不再是 warn。
     *
     * 前端控制台默认只看 info 及以上，warn 本来也能看到 —— 但一屏几十条
     * warn 里混着这一条，等于没有。空回是「花了钱没拿到东西」，和上游报错
     * 同一个量级，理应和它们排在一起。
     */
    logError(scope, "这一轮没有可发送的正文（token 已消耗）", `原文 ${reply.length} 字：${reply}`);
    await respondingWhile(space, () => notifyFailure(runner, space, "这条没能生成正文", why), runner);
    return;
  }

  /*
   * 记下助手回复进历史：存**原文**，过滤是 prompt.js 拼提示词时的事。
   * （例外之一是上面那一轮发了 IG —— recorded 里的标签换成了人话，理由见那儿）
   *
   * 例外之二是开了强制分隔：那时候存的是按 `$` 改写过的那一份。发出去的是
   * 七条气泡、历史里却躺着一整段「你好呀，我刚刚订到…」的话，模型下一轮照着
   * 上文学，只会更不肯自己分段 —— 关掉开关立刻退回大段文字就是这么来的。
   * 见 delay.js:normalizeForHistory。
   */
  const forHist = normalizeForHistory(recorded, freshConfig.chat);
  const hist = runner.history.get(sessionId) ?? [];
  hist.push({ role: "assistant", content: forHist });
  runner.history.set(sessionId, hist);

  // 落盘存档：完整记录，不受上下文限制影响。写失败不该让这轮回复发不出去
  try {
    appendTurn(
      sessionId,
      { roleId: role.id, roleName: role.name, peer: peer || spaceId },
      [
        { role: "user", content: combined },
        // 和内存历史用同一个变量，否则存档和上文会不一致
        { role: "assistant", content: forHist },
      ],
      (msg) => logWarn(scope, msg)
    );
  } catch (e) {
    logError(scope, `会话 ${sessionId} 存档写入失败（这轮回复照发）`, e);
  }

  /*
   * 记忆库：记一笔待总结 + 轮数到了在后台总结。**不 await**，见 afterTurn。
   *
   * 重 roll 跳过（用户明确要求 `/clear` 和 `/重roll` 都不进待总结）：这一轮的
   * 待总结在第一次生成的时候就记过了。这里再记一次的话，同一句话会在待总结
   * 流水里出现两遍，轮数也多算一轮 —— 记忆和备忘录的触发点跟着一起错位。
   *
   * 代价是待总结里留着的是**被重 roll 掉的那版回复**。这是刻意的取舍：改写
   * 已经落盘的流水要按内容去回溯匹配，一旦匹配错就是删掉别的轮次，
   * 比留一版旧回复糟得多。用户真在意的话，待总结那几个 txt 随时能手改。
   */
  if (!isReroll) {
    afterTurn(runner, space, freshConfig, freshRole, { user: combined, assistant: forHist });
  }

  /*
   * 这一轮只发了 Instagram，方括号之外一个字都没写 —— 到此为止。
   *
   * 放在存档和记忆库**之后**：这一轮确实发生过（模型发了条帖子），上下文和
   * 待总结都该记上，只是没有要发给对方的短信。
   */
  if (!forUser.trim()) {
    logInfo(scope, "这轮只发了 Instagram，没有要发给对方的短信");
    return;
  }

  // 用 responding 串行化本条 space 的回包
  await respondingWhile(space, async () => {
    const freshest = getConfig();
    const chat = freshest.chat ?? {};
    /*
     * 媒体标记在这里才消费（角色开关 + 凭据都在 ctx 里）。
     *
     * 注意传的是**这一刻**重新读的 config 和角色 —— 出图要几十秒，这段时间
     * 用户可能在界面上改了配置。eps 顺手带上，省得 sendImagePart 再解析一次。
     */
    const { sent, acted, failed } = await sendBubbles(runner, space, chat, forUser, {
      role: currentRole(freshest, runner) ?? freshRole,
      config: freshest,
      eps,
      // 引用和撤回要按 spaceId 去查两个环形缓冲（见 sendBubbles 的注释）
      spaceId,
      // 投递检测要拿它去查「这条到底送到没有」，以及探这个地址支不支持 iMessage
      peer,
      // 转账那条路要它：排「一直没收款就提醒一次」的定时器，到点得能重读配置
      getConfig,
    });

    /*
     * 一件事都没做成 —— 整条回复就一个媒体标记，而那个标记失败了。图片、
     * 表情包这些失败时刻意不发占位文字（见 sendImagePart），但整轮静默就成了
     * 「消息发出去了却什么都没回」，那正是之前修过的坑。所以这里兜一句。
     *
     * 判的是 `acted` 不是 `sent`：只贴了个 `[react:❤️]` 的那种回复 `sent` 是 0
     * 但确实做了事（对方说「你别回我了」，角色贴一颗心就收尾），报错就错了。
     *
     * 那句话里说的是**真的**什么没成（sendBubbles 记着这一轮出现过哪几种
     * 标记）—— 原先那句话把原因写死成图片，遇上表情包或者贴爱心失败就是一句
     * 和事实无关的话，对方照着去看「生图」日志什么也找不到。
     */
    if (!acted) {
      const what = failed || "这条回复";
      logWarn(scope, `这轮一件事都没做成（${what}）`);
      await notifyFailure(
        runner,
        space,
        "这条没能发出来",
        `这轮回复里只有${what}，而它没成功。具体原因看控制台上面几行日志。`
      );
      return;
    }
    // 计数只数真发出去的消息 —— 只贴了个爱心那轮不该让「已回复」多一条
    if (sent) runner.messageCount += 1;
  }, runner);
}

/* ------------------------------------------------------------------ *
 * Instagram：给 igrun.js 那条链路当「会话提供方」。
 *
 * igrun.js 不认识 runner、也拿不到 space（那是刻意的，和 proactive.js 一个
 * 路子）。它跑完一条互动任务，把结果交给 `opts.session(role)` 返回的那个
 * 对象：`history` 给提示词当上文、`commit(outcome)` 负责「这一轮怎么落下去」
 * —— 写内存历史、写存档、记记忆库、顺带那条短信怎么发。
 *
 * 那些事全在这个文件里（sendBubbles / appendTurn / afterTurn 都在这儿），
 * 搬过去就成循环引用了，所以反过来：igrun 定接口，这边填实现。
 * ------------------------------------------------------------------ */

/**
 * 现在哪个 runner 跑着这个角色。
 *
 * 一个角色同一时刻只可能挂在一条连接上（runner 是按项目建的，项目绑角色），
 * 所以第一个对上的就是答案。桥没开、或者刚被 stopBridge 掉的返回 null ——
 * 那种情况下 IG 上的评论照发，只是没有上文、也发不了短信。
 */
function runnerForRole(config, role) {
  const want = String(role?.id ?? "");
  if (!want) return null;
  for (const runner of runners.values()) {
    if (runner.stopped) continue;
    const now = currentRole(config, runner);
    if (now && String(now.id ?? "") === want) return runner;
  }
  return null;
}

/**
 * 把 igrun 跑出来的一轮落到会话里。
 *
 * 写进上下文的**不是模型原文**，是 `commentLine`（`[Instagram 评论] …`）加上
 * 那条短信 —— 和 handleTurn 里发了帖的那一轮同一个理由：IG 上的痕迹已经落到
 * data/instagram/ 了，上下文里再留一份标签只会教模型复读格式。
 *
 * 用户那一侧记的是 `outcome.mark`（「[Instagram] 用户发了一条新帖子，你刷到了」）。
 * 这一轮确实是被什么事情触发的，上下文里得有个由头，不然读起来就是角色
 * 凭空冒了一句话。
 *
 * 整段跑在 `chain` 里：对方可能正好在这一秒发消息进来，两边同时写 history
 * 和存档会串不起来（和 fireProactive 同一个考虑）。
 */
async function commitIgTurn(getConfig, runner, role, outcome) {
  const config = getConfig?.() ?? {};
  const fresh = currentRole(config, runner) ?? role;
  const scope = scopeOf(runner, "Instagram");
  const last = runner.lastSpace;
  const peer = last?.peer ?? "";
  const spaceId = last?.spaceId || peer || "instagram";

  await chain(
    runner,
    spaceId,
    async () => {
      const sessionId = sessionIdOf(runner, fresh, peer);
      const user = resolveUser(config, fresh);
      const rules = resolvePreset(config, fresh).regex;
      const vars = { char: fresh?.name ?? "", user: user?.name ?? "" };

      const dm = String(outcome.dm ?? "").trim();
      const forUser = dm
        ? applyAndLog(
            dm,
            rules,
            { target: "aiOutput", field: "toUser", vars },
            "AI 回复（Instagram 顺带的那条短信）"
          ).text.trim()
        : "";

      /*
       * 发不发得出去要**在写历史之前**定下来。
       *
       * 进程刚起来还没收到过任何消息时 runner.lastSpace 是 null，这条短信
       * 就发不出去。那它绝不能进上下文 —— 留了的话模型下一轮会以为自己
       * 说过那句话，接着往下聊一件用户根本没看见的事。IG 上的评论不受
       * 影响，那个是真发出去了的。
       */
      const canSend = Boolean(forUser && last?.space);
      if (dm && !canSend) {
        logWarn(
          scope,
          `${outcome.roleName} 这轮想顺带发条短信，可现在没有能发消息的会话（要等对方先说一句），只记 Instagram 那条`
        );
      }

      /*
       * 只有那条短信按 `$` 改写，`commentLine` 不动。
       *
       * 改写是为了让上文和**真发出去的那几条气泡**对得上（见
       * delay.js:normalizeForHistory），而 commentLine 是我们自己写给模型看的
       * 一句旁白（`[Instagram 评论] …`），它压根没走 sendBubbles。
       * 一起切了的话上下文里会多出一堆假装是气泡的碎句。
       */
      const assistant = [
        outcome.commentLine,
        canSend ? normalizeForHistory(outcome.dm, config.chat) : "",
      ]
        .filter((s) => String(s ?? "").trim())
        .join("\n");
      /*
       * 两侧都得有字才写。
       *
       * assistant 空 = 评论也没有、短信也发不了，这一轮什么都没发生，
       * 别往上下文里塞空壳。
       *
       * mark 空 = 「对方那边发生了什么」这句旁白没拼出来。存档里留一条空的
       * user 消息，下一轮拼提示词时就是个空 turn，有的上游直接回 400。
       * 走到这儿说明 markFor 漏了一种 kind，所以记一条 warn 而不是静默跳过。
       */
      if (!assistant) return;
      if (!String(outcome.mark ?? "").trim()) {
        logWarn(
          scope,
          `${outcome.roleName} 这一轮（${outcome.kind || "未知类型"}）没有上文旁白，跳过不记`,
          assistant
        );
        return;
      }

      loadHistory(runner, fresh, sessionId, scope);
      const hist = runner.history.get(sessionId) ?? [];
      hist.push({ role: "user", content: outcome.mark });
      hist.push({ role: "assistant", content: assistant });
      runner.history.set(sessionId, hist);

      try {
        appendTurn(
          sessionId,
          { roleId: fresh.id, roleName: fresh.name, peer: peer || spaceId },
          [
            { role: "user", content: outcome.mark },
            { role: "assistant", content: assistant },
          ],
          (msg) => logWarn(scope, msg)
        );
      } catch (e) {
        logError(scope, `会话 ${sessionId} 存档写入失败（IG 上那条已经发了）`, e);
      }

      /*
       * 记忆库照记 —— 用户明确要过「角色发帖和评论要保存到记忆库的待总结」。
       * space 可能是 null，afterTurn 里那个 notify 自己兜着（总结失败的说明
       * 发不出去只会记一条警告）。
       */
      afterTurn(runner, last?.space, config, fresh, { user: outcome.mark, assistant });

      if (!canSend) return;
      await respondingWhile(last.space, async () => {
        const { sent, acted, failed } = await sendBubbles(
          runner,
          last.space,
          config.chat ?? {},
          forUser,
          {
            role: fresh,
            config,
            eps: resolveRoleEndpoints(config, fresh),
            // 引用和撤回要按 spaceId 去查两个环形缓冲（见 sendBubbles 的注释）
            spaceId,
            peer,
            // 转账那条路排「一直没收款就提醒一次」要它（见 sendTransferPart）
            getConfig,
          }
        );
        // 判 acted 不判 sent：只贴了个 [react:] 的那轮也算做了事（见 sendBubbles）
        if (!acted) {
          logWarn(scope, `Instagram 顺带的那条短信一件事都没做成（${failed || "没有内容"}）`);
          return;
        }
        if (sent) runner.messageCount += 1;
      }, runner);
    },
    "Instagram 这一轮没能落到会话里"
  );
}

/**
 * 造一个 `session(role)` 回调给 startIgQueue / runIgTask 用。
 *
 * 为什么是工厂而不是直接导出 `session`：`session(role)` 只收一个角色，
 * 可 runnerForRole 要配置才找得到人，所以把 getConfig 先包进来。
 *
 * 返回 null 的那两种情况（桥没开、角色不在任何一条连接上）在 runIgTask 里
 * 有明确的退化路径：上文是空的、短信丢掉，IG 上的赞和评论照发。
 */
export function igSessionFor(getConfig) {
  return (role) => {
    const config = getConfig?.();
    if (!config) return null;
    const runner = runnerForRole(config, role);
    if (!runner) return null;
    const scope = scopeOf(runner, "Instagram");
    const sessionId = sessionIdOf(runner, role, runner.lastSpace?.peer ?? "");
    return {
      history: loadHistory(runner, role, sessionId, scope),
      commit: (outcome) => commitIgTurn(getConfig, runner, role, outcome),
    };
  };
}

/* ------------------------------------------------------------------ *
 * 主动消息：隔一阵子没人说话，角色自己开口。
 *
 * 分工见 proactive.js 的文件头 —— 那边算时间（等多久、是不是勿扰、
 * 问模型要个小时数），这边负责真的发出去（排队、拆气泡、写存档）。
 *
 * 「下次几点开口」**落盘**，见 proactivestore.js：等待窗口动辄几小时，
 * 只放内存的话重启一次全归零，随机时间和自主判断两种模式一起废。
 *
 * space 对象也不必非得等入站消息 —— SDK 的 `platform(instance).space.get(id)`
 * 能按 chat GUID 现造一个（12.8 起两种 provider 都实现了），所以连上之后
 * 直接照着存下来的表把 space 补回来接着数，见 rehydrateProactive。
 *
 * 保存配置不会重启 runner（见 fingerprintOf），所以改人设不影响正在跑的表。
 * ------------------------------------------------------------------ */

/**
 * 拿（或新建）某条会话的主动消息调度槽。
 *
 *  stage      "judge" = 到点先问模型下次什么时候发；"send" = 到点直接发
 *  awaiting   上一条主动消息发出去了，还没等到对方回话
 *  read       awaiting 期间收到过已读回执（下一条会缀上「已读但没回复」）
 *  lastTalkAt 最后一次真有人说话的时刻（判时给模型看「多久没说话」用）
 *  judgeFails 「问模型隔多久开口」连着失败几次了，成功一次清零
 *
 * 后两个**不落盘**（saveSlot 只挑前面那几个字段）：重启后从零数起正合适。
 */
function proactiveSlot(runner, spaceId) {
  let slot = runner.proactive.get(spaceId);
  if (!slot) {
    slot = {
      timer: null,
      nextAt: null,
      space: null,
      peer: "",
      stage: "send",
      awaiting: false,
      read: false,
      lastTalkAt: 0,
      judgeFails: 0,
    };
    runner.proactive.set(spaceId, slot);
  }
  return slot;
}

/**
 * 撤掉某条会话的主动消息计时（关开关、解绑角色都会走到）。
 *
 * 硬盘上那行也一起删 —— 撤表是「以后不再发了」的意思，留着的话下次启动
 * 又会把它捞回来。**停连接不走这里**（见 stopRunner）：那是「先下班」，
 * 不是「别发了」。
 */
function disarmProactive(runner, spaceId) {
  dropSlot(runner.projectRefId, spaceId);
  const slot = runner.proactive.get(spaceId);
  if (!slot) return;
  if (slot.timer) clearTimeout(slot.timer);
  runner.proactive.delete(spaceId);
}

/**
 * 排下一次主动消息。
 *
 * 每次调用都会把旧的定时器顶掉 —— 对方一说话就重新排，正好对应用户规范里
 * 「用户多少分钟没回复」：那个计时是从**最后一条消息**开始算的。
 *
 * 排完顺手落盘（proactivestore.js）：等待窗口动辄几小时，不写下来的话
 * 重启一次就白等。**没有 space 也照排** —— space 到点再补（fireProactive
 * 会现要一个），不能因为进程刚起来还没收到过消息就把整条表停掉。
 *
 * @param {object} [opts]
 * @param {object} [opts.space] 入站消息上的 space；没有也行，到点现要
 * @param {string} [opts.peer]  对方地址，算会话 ID 用
 * @param {boolean} [opts.replied] 对方回话了：把「已读没回」那笔勾销
 * @param {boolean} [opts.talked] 刚有人说过话（角色自己发完一条也算），刷新沉默计时
 * @param {number} [opts.delayMs] 指定等待毫秒；不给就按模式算
 * @param {"judge"|"send"} [opts.stage] 指定这次到点干什么；不给就按模式定
 */
function armProactive(getConfig, runner, spaceId, opts = {}) {
  if (runner.stopped) return;
  const scope = scopeOf(runner, "主动消息");
  const role = currentRole(getConfig(), runner);
  const p = role?.proactive;

  // 开关关了 / 角色被解绑：把表撤干净，别留一个几小时后才发现没人管的定时器
  if (!p?.enabled) {
    disarmProactive(runner, spaceId);
    return;
  }

  const slot = proactiveSlot(runner, spaceId);
  if (opts.space) slot.space = opts.space;
  if (opts.peer) slot.peer = opts.peer;
  if (opts.replied) {
    slot.awaiting = false;
    slot.read = false;
  }
  /*
   * 「多久没说话」的起点。只有**真的有人开口**才动它：对方回了话
   * （replied），或者角色自己刚发完一条主动消息（talked）。
   *
   * 勿扰 / 协助 / 线下 / 要不到 space 那几条路径也在反复调这个函数，
   * 跟着它们一起刷新的话这个数永远接近 0，喂给判断模型就成了假情报。
   */
  if (opts.replied || opts.talked) slot.lastTalkAt = Date.now();
  if (slot.timer) {
    clearTimeout(slot.timer);
    slot.timer = null;
  }

  // 自主判断模式的第一段是「干等对方多久没回」，等完才去问模型
  const stage = opts.stage ?? (p.mode === "auto" ? "judge" : "send");
  const wait = opts.delayMs ?? (stage === "judge" ? judgeWaitMs(p) : randomWaitMs(p));

  slot.stage = stage;
  slot.nextAt = Date.now() + wait;
  slot.timer = setTimeout(() => {
    slot.timer = null;
    void fireProactive(getConfig, runner, spaceId);
  }, wait);
  // 不拖着进程不退出：HTTP 服务本来就吊着事件循环，这个表不该有话语权
  slot.timer.unref?.();

  saveSlot(runner.projectRefId, spaceId, slot);

  logDebug(
    scope,
    `${spaceId}：${humanizeWait(wait)}后${stage === "judge" ? "问模型下次什么时候开口" : "主动发一条"}`
  );
}

/**
 * 把某条会话的 space 补回来。
 *
 * 进程刚起来、或者这条会话从来没收到过消息时，内存里是没有 space 的。
 * spaceId 就是 iMessage 的 chat GUID，拿它跟 SDK 要一个就行 —— 出来的
 * space 和入站消息上那个是同一条流水线造的（core 的 buildSpace），
 * 发消息、输入中、特效一样都不少。
 *
 * 先不带参数要：云端单客户端和共享号都能直接给。只有一个项目下挂了多条
 * 号码时它才会要 phone，那时候再用线路号重试一次。两次都不行就返回 null，
 * 调用方按「这次先跳过」处理，别把表撤了。
 */
async function ensureSpace(runner, slot, spaceId) {
  if (slot.space) return slot.space;
  if (!runner.instance || !runner.platform) return null;
  const scope = scopeOf(runner, "主动消息");

  const ask = async (params) => {
    const platform = runner.platform(runner.instance);
    return params ? platform.space.get(spaceId, params) : platform.space.get(spaceId);
  };

  try {
    slot.space = await ask();
  } catch (first) {
    if (!runner.linePhone) {
      logWarn(scope, `${spaceId}：拿不到会话，这次先跳过`, first);
      return null;
    }
    try {
      slot.space = await ask({ phone: runner.linePhone });
    } catch (second) {
      logWarn(scope, `${spaceId}：拿不到会话，这次先跳过`, second);
      return null;
    }
  }
  return slot.space;
}

/**
 * 连上之后，把硬盘上记着的表接着数。
 *
 * 这就是「重启不清计时器」的落点：读出这条线路名下的所有会话，算还剩多久，
 * 把 space 补回来，原样排回去。两种模式一视同仁 —— 存下来的 stage 是什么
 * 就接着做什么（judge 的接着去问模型，send 的接着发）。
 *
 * 已经过期的（关机期间到点了）不立刻开火：挪到 SETTLE_MS 之后，免得一开机
 * 十几条会话同时往外发；勿扰时段照样由 fireProactive 那道闸挡着。
 */
function rehydrateProactive(getConfig, runner) {
  const scope = scopeOf(runner, "主动消息");
  const rows = slotsFor(runner.projectRefId);
  if (!rows.length) return;

  const role = currentRole(getConfig(), runner);
  if (!role?.proactive?.enabled) {
    // 关掉主动消息之后才重启的：把死行清掉，别留着下次又捞出来
    for (const row of rows) dropSlot(runner.projectRefId, row.spaceId);
    return;
  }

  let overdue = 0;
  for (const row of rows) {
    const slot = proactiveSlot(runner, row.spaceId);
    slot.peer = row.peer;
    slot.awaiting = row.awaiting;
    slot.read = row.read;

    const left = row.nextAt - Date.now();
    if (left <= 0) overdue += 1;
    armProactive(getConfig, runner, row.spaceId, {
      delayMs: Math.max(left, SETTLE_MS),
      stage: row.stage,
    });
  }

  logInfo(
    scope,
    `接着上次的表跑：${rows.length} 条会话${overdue ? `（其中 ${overdue} 条关机期间已经到点，${humanizeWait(SETTLE_MS)}后补上）` : ""}`
  );
}

/**
 * 定时器到点了。
 *
 * 三件事按顺序判：开关还开着吗 → 现在是不是勿扰 → 该问模型还是该发。
 * 配置都是**此刻**重新读的，所以用户中途改了模式/时段，下一次到点就生效。
 */
async function fireProactive(getConfig, runner, spaceId) {
  if (runner.stopped) return;
  const scope = scopeOf(runner, "主动消息");
  const config = getConfig();
  const role = currentRole(config, runner);
  const p = role?.proactive;
  const slot = runner.proactive.get(spaceId);
  if (!slot) return;

  if (!p?.enabled) {
    disarmProactive(runner, spaceId);
    return;
  }

  /*
   * 提示词协助模式开着：一个字也别发，往后推一段再看。
   *
   * 这会儿角色已经让位了，对面正在和提示词工程师排查人设。这时候角色自己
   * 蹦出来发一条「在干嘛呀」，既把诊断打断，又正好演示了一遍用户要修的毛病。
   *
   * 和勿扰一样是**推迟**不是取消：stage 原样带过去，本来排着要「自主判断」
   * 的那一轮，协助模式结束后接着判。
   */
  if (isAssistOn(runner.projectRefId, spaceId)) {
    logDebug(scope, `协助模式开着，主动消息推迟到 ${humanizeWait(ASSIST_HOLD_MS)}后再看`);
    armProactive(getConfig, runner, spaceId, { delayMs: ASSIST_HOLD_MS, stage: slot.stage });
    return;
  }

  /*
   * 线下模式开着：同样一个字都不发，往后推一段再看。
   *
   * 这是用户点名的那一条：「线下模式开启后会自动关闭掉当前角色线上所有功能
   * （包括主动消息与消息格式与功能等内容），保持真实性」。两个人正坐着演剧情，
   * 手机上却弹出一条「你在干嘛呀」，真实性当场就没了。
   *
   * 和协助模式一样是**推迟**不是取消：stage 原样带过去，线下结束之后接着排。
   * 复用 ASSIST_HOLD_MS —— 两者要的都是「过一阵再看看还开着没」，
   * 没有理由给线下另开一个常数。
   */
  if (isOfflineOn(memoryKeyFor(role))) {
    logDebug(scope, `线下模式开着，主动消息推迟到 ${humanizeWait(ASSIST_HOLD_MS)}后再看`);
    armProactive(getConfig, runner, spaceId, { delayMs: ASSIST_HOLD_MS, stage: slot.stage });
    return;
  }

  /*
   * 勿扰时段：到点也不发，改排到时段结束。
   *
   * 「自主判断」那一步也一起推迟 —— 半夜问模型「隔多久开口合适」既花钱
   * 又没意义，它给的小时数还得再被这道闸推一次。
   */
  const hold = msUntilFocusEnd(p.focus);
  if (hold > 0) {
    logDebug(
      scope,
      `现在是勿扰时段（${p.focus.start}-${p.focus.end}），推迟到 ${humanizeWait(hold)}后`
    );
    armProactive(getConfig, runner, spaceId, { delayMs: hold, stage: slot.stage });
    return;
  }

  /*
   * space 可能还没有（进程重启后头一次到点）。现要一个 —— 要不到就再等
   * 一个周期，**不撤表**：号码可能只是这会儿没连上，撤了就再也不会自己起来。
   */
  if (!(await ensureSpace(runner, slot, spaceId))) {
    if (runner.stopped) return;
    armProactive(getConfig, runner, spaceId, { delayMs: RETRY_SPACE_MS, stage: slot.stage });
    return;
  }

  if (slot.stage === "judge") {
    const sessionId = sessionIdOf(runner, role, slot.peer || spaceId);
    const history = loadHistory(runner, role, sessionId, scope);
    let wait;
    try {
      wait = await judgeWaitByLLM(config, role, resolveUser(config, role), history, scope, {
        silenceMs: slot.lastTalkAt ? Date.now() - slot.lastTalkAt : 0,
      });
      slot.judgeFails = 0;
    } catch (e) {
      /*
       * 判断打不通了。以前这里一律「等一个周期再问」——判断模型要是配坏了
       * （模型名写错、渠道没了、返回格式不对），这就是个**无限循环**：每隔
       * minWaitMinutes 刷一条同样的报错，主动消息一条也发不出去。用户日志里
       * 那串每 30 分钟一条的「返回格式看不懂」就是这么来的。
       *
       * 所以只白问一次。第二次还不通就认了，按 FALLBACK_HOURS 直接排发送
       * ——判不出时间总比彻底哑掉强，用户要的是角色会主动说话，不是一个
       * 精确的时间。
       */
      slot.judgeFails = (slot.judgeFails ?? 0) + 1;
      if (slot.judgeFails >= 2) {
        logWarn(
          scope,
          `问模型「隔多久再开口」连着失败 ${slot.judgeFails} 次，不问了，改成 ${FALLBACK_HOURS} 小时后直接发`,
          e
        );
        slot.judgeFails = 0;
        armProactive(getConfig, runner, spaceId, {
          delayMs: FALLBACK_HOURS * 3600_000,
          stage: "send",
        });
        return;
      }
      logWarn(scope, "问模型「隔多久再开口」失败，过一阵再问", e);
      armProactive(getConfig, runner, spaceId, { delayMs: judgeWaitMs(p), stage: "judge" });
      return;
    }
    armProactive(getConfig, runner, spaceId, { delayMs: wait, stage: "send" });
    return;
  }

  /*
   * 串进这条会话的处理链：对方可能正好在这一秒发了消息，两边同时写
   * history / 存档会串行不了。chain 自己吞异常并记日志，所以这里 await
   * 不会抛 —— 无论成没成，下面照样把下一次排上。
   */
  await chain(
    runner,
    spaceId,
    () => runProactiveTurn(getConfig, runner, slot, spaceId),
    "主动消息发送出错"
  );

  if (runner.stopped) return;
  // 「发完后等待十分钟再次计时」——冷却压在正常间隔前面，两种模式都压
  const fresh = currentRole(getConfig(), runner)?.proactive ?? p;
  const stage = fresh.mode === "auto" ? "judge" : "send";
  const base = stage === "judge" ? judgeWaitMs(fresh) : randomWaitMs(fresh);
  // talked：角色自己刚开过口，沉默计时从这一刻重新算
  armProactive(getConfig, runner, spaceId, { delayMs: COOLDOWN_MS + base, stage, talked: true });
}

/**
 * 真的发一条主动消息。
 *
 * 和 handleTurn 是同一套流程（组提示词 → 打模型 → 搜索 → 正则 → 拆气泡 →
 * 写存档 → 记忆库），差别只有开头那条 user 消息的来路：
 *
 *  - 发给模型的是**主动消息提示词**（必要时缀上「已读了但还没回复」）；
 *  - 进历史和存档的只有 `[触发了主动消息]`（见 proactive.js 的
 *    buildProactiveInput）—— 提示词可能几百字，原样存下去之后每一轮都要
 *    重发一遍，纯粹是白烧 token。
 *
 * 时间前缀照加：和别的 user 轮次一致，「自主判断」那边也要靠它才知道
 * 上一次是什么时候的事。
 */
async function runProactiveTurn(getConfig, runner, slot, spaceId) {
  const config = getConfig();
  const role = currentRole(config, runner);
  const scope = scopeOf(runner, "主动消息");
  const llmScope = scopeOf(runner, "LLM");
  const space = slot.space;
  const peer = slot.peer || spaceId;

  if (!role?.proactive?.enabled) return;

  const eps = resolveRoleEndpoints(config, role);
  if (!eps.chat) {
    logError(scope, "这个角色的聊天 API 没配好，主动消息发不了");
    return;
  }

  const sessionId = sessionIdOf(runner, role, peer);
  loadHistory(runner, role, sessionId, scope);

  const user = resolveUser(config, role);
  const { toModel, toHistory } = buildProactiveInput(role, user, { read: slot.read });
  if (!toModel.trim()) {
    logWarn(scope, "主动消息提示词是空的，这次不发");
    return;
  }

  /*
   * 开了「主动发布帖子/快拍」的角色，这一轮多一个选项：把发帖的格式缀在
   * 提示词末尾，它可以选择发条动态而不是（或者不只是）来找人说话。
   *
   * 只进**这一次请求**，和上面那段提示词一样不落历史 —— 落了的话每轮都要
   * 重发一遍，而且模型会以为自己刚被要求发帖，下一轮接着发。
   */
  const composeNote = igComposeNote(config, role, { user });
  const forModel = composeNote ? `${toModel}\n\n${composeNote}` : toModel;
  if (composeNote) logDebug(scope, `${role.name} 这一轮可以顺手发条 Instagram`);

  logInfo(
    scope,
    `触发主动消息（${sessionId}）${slot.read ? "，对方已读上一条但没回" : ""}`
  );

  // 时间前缀和正常轮次同一个来路；天气照旧只进这一份提示词，不进存档
  const { time: timePrefix, weather: weatherNote } = await buildEnv(role, config.weatherApi);
  const forHistory = timePrefix + toHistory;

  /*
   * 发给模型的那一条 = 时间前缀 + 主动消息提示词（+ 可能缀上的发帖说明），
   * **只活在这次请求里**；写进 runner.history 的是 forHistory。所以先把
   * 提示词那份塞进副本，让 buildPrompt 看到它，再把 history 换回省 token 的那份。
   */
  const historyArr = runner.history.get(sessionId) ?? [];
  const forPrompt = [...historyArr, { role: "user", content: timePrefix + forModel }];

  const built = await buildPrompt(config, role, user, forPrompt, weatherNote);
  const { messages, params, preset, worldInfo } = built;

  // buildPrompt 会按上下文上限裁剪。裁完的最后一条是提示词那份，换成占位符
  // 再写回内存 —— 从这一刻起，上下文里留下的就只有 [触发了主动消息]
  const trimmed = built.history.slice(0, -1);
  trimmed.push({ role: "user", content: forHistory });
  runner.history.set(sessionId, trimmed);

  if (worldInfo.hitNames.length) {
    logInfo(scope, `世界书命中 ${worldInfo.hitNames.length} 条：${worldInfo.hitNames.join("、")}`);
  }

  const promptMeta = {
    roleId: role.id,
    roleName: role.name,
    sessionId,
    userId: user?.id ?? "",
    userName: user ? userLabel(user) : "",
    model: eps.chat.label ?? "",
    presetName: presetLabel(preset),
    worldHits: worldInfo.hitNames,
  };
  notePrompt(promptMeta, messages);

  let reply;
  try {
    const { content } = await chatWithFallback(eps.chat, eps.fallback, messages, params);
    reply = content;
  } catch (e) {
    /*
     * 主副都挂了。**不 notifyFailure** —— 对方压根不知道这里要发消息，
     * 平白收到一句「这条消息没回上来」只会莫名其妙。记日志就够，
     * 内存历史里那条也撤掉，免得下次带着一条没有回复的 user 消息去问模型。
     */
    logError(llmScope, "主动消息没能生成，这次跳过", e);
    runner.history.set(sessionId, historyArr);
    return;
  }

  logInfo(llmScope, `模型回复 ${reply.length} 字`, reply);

  try {
    const searched = await searchRound(reply, {
      role,
      config,
      eps,
      params,
      messages,
      scope,
      llmScope,
      onPrompt: (followUp) => notePrompt(promptMeta, followUp),
    });
    if (searched !== null) reply = searched;
  } catch (e) {
    logError(llmScope, "主动消息搜索之后那次生成失败，这次跳过", e);
    runner.history.set(sessionId, historyArr);
    return;
  }

  /*
   * 查岗。主动消息这一路也给 —— 「隔了两小时自己开口」正是最想先看一眼
   * 对方在干什么的场景（在忙就别打扰，在刷手机就聊两句）。
   * 失败的处理照这条路的通例：撤掉历史里那条、这次跳过。
   */
  try {
    const spied = await spyRound(reply, {
      role,
      eps,
      spyApi: config?.spyApi,
      params,
      messages,
      user,
      scope,
      llmScope,
      onPrompt: (followUp) => notePrompt(promptMeta, followUp),
    });
    if (spied !== null) reply = spied;
  } catch (e) {
    logError(llmScope, "主动消息查岗之后那次生成失败，这次跳过", e);
    runner.history.set(sessionId, historyArr);
    return;
  }

  // 手机里那十九件事。主动消息这一路也给 —— 「早上自己开口」正是最想先看一眼
  // 他电量还剩多少、或者顺手放首歌的场景（见 phoneRound）
  try {
    const phoned = await phoneRound(reply, {
      role,
      eps,
      spyApi: config?.spyApi,
      params,
      messages,
      user,
      scope,
      llmScope,
      onPrompt: (followUp) => notePrompt(promptMeta, followUp),
    });
    if (phoned !== null) reply = phoned;
  } catch (e) {
    logError(llmScope, "主动消息动手机之后那次生成失败，这次跳过", e);
    runner.history.set(sessionId, historyArr);
    return;
  }

  const rules = resolvePreset(config, role).regex;
  const vars = { char: role?.name ?? "", user: user?.name ?? "" };
  let forUser = applyAndLog(
    reply,
    rules,
    { target: "aiOutput", field: "toUser", vars },
    "AI 回复（发给对方）"
  ).text;

  const withoutTags = stripSearchTags(forUser);
  if (withoutTags !== forUser.trim()) {
    logInfo(scope, "发给对方的那份里收掉了 [搜索:…] 标记（存档留原文）", forUser);
    forUser = withoutTags;
  }

  const withoutSpy = stripSpyTags(forUser);
  if (withoutSpy !== forUser.trim()) {
    logInfo(scope, "发给对方的那份里收掉了查岗标签（存档留原文）", forUser);
    forUser = withoutSpy;
  }

  /*
   * 模型写了 [leave_on_read]：这次就当没触发过。
   *
   * 「已读不回」的意思是「不回应」，用在主动消息上只能理解成「这会儿
   * 不想开口」。既然一个字都不发，历史和存档也不该留痕 —— 留了的话
   * 上下文里会攒出一串「触发了 / 没说话」，下一轮反而在教模型别开口。
   */
  if (hasLeaveOnRead(forUser) && role.leaveOnRead?.enabled) {
    logInfo(scope, "模型这次选择不开口（[leave_on_read]），跳过这条主动消息");
    runner.history.set(sessionId, historyArr);
    return;
  }

  /*
   * Instagram：模型这一轮选择了发帖/发快拍。走的是和正常轮次**同一条路**
   * （见上面 igRouteFor 那段的长注释），只有开了「主动发布帖子/快拍」的角色
   * 才在提示词里看得到那段格式 —— 没开的角色写不出标签，这里直接判否。
   *
   * config 重新取一份：LLM 那一轮可能跑了几十秒，期间用户完全可能在控制台
   * 里改了角色（比如刚把 IG 关掉）。以最新的那份为准。
   */
  const freshConfig = getConfig();
  const freshRole = currentRole(freshConfig, runner) ?? role;
  let recorded = reply;
  let igDone = false;
  if (igRouteFor(freshRole, forUser)) {
    try {
      const parsed = splitIg(forUser, freshConfig.chat?.separator ?? "");
      const lines = publishLines(await publishIgTags(freshConfig, freshRole, parsed));
      igDone = lines.length > 0;
      if (igDone) {
        logInfo(scope, `Instagram：发了 ${lines.length} 条`, lines.join("\n"));
        recorded = [lines.join("\n"), stripIgTags(reply)].filter(Boolean).join("\n");
      }
      forUser = parsed.rest;
    } catch (e) {
      logError(scope, "Instagram 这一轮没发出去（短信照发）", e);
      forUser = stripIgTags(forUser);
    }
  }

  /*
   * `igDone` 的时候正文为空是**正常**的：帖子发出去了，方括号之外一个字
   * 没写 —— 那一轮的意思就是「它想发条动态，不想找人说话」。这条照旧要
   * 进历史和存档（角色确实做了件事），只是不发短信。
   */
  if (!forUser.trim() && !igDone) {
    logWarn(scope, "过滤后没有可发送的正文，这条主动消息不发", `原文 ${reply.length} 字：${reply}`);
    runner.history.set(sessionId, historyArr);
    return;
  }

  /*
   * 助手那条进历史。IG 那一轮存的是 publishLines 那几句人话，别的都存原文 ——
   * 开了强制分隔时是按 `$` 改写过的那一份，和正常轮次同一个道理
   * （见上面那处 forHist 的注释，以及 delay.js:normalizeForHistory）。
   */
  const forHist = normalizeForHistory(recorded, freshConfig.chat);
  const hist = runner.history.get(sessionId) ?? [];
  hist.push({ role: "assistant", content: forHist });
  runner.history.set(sessionId, hist);

  try {
    appendTurn(
      sessionId,
      { roleId: role.id, roleName: role.name, peer },
      [
        // 存档里同样只留占位符，和内存历史一致
        { role: "user", content: forHistory },
        { role: "assistant", content: forHist },
      ],
      (msg) => logWarn(scope, msg)
    );
  } catch (e) {
    logError(scope, `会话 ${sessionId} 存档写入失败（这条照发）`, e);
  }

  // 主动消息也算聊了一轮，记忆库照记（不 await，见 afterTurn）
  afterTurn(runner, space, config, role, { user: forHistory, assistant: forHist });

  /*
   * 只发了 IG、没有短信正文的那一轮到此为止 —— 和正常轮次那条同一个道理
   * （见 imessage.js:1894 那段），放在存档和记忆库之后：这一轮确实发生过。
   *
   * 不能往下走：sendBubbles 会把空文本换成「（我暂时答不上来）」凭空发给对方，
   * 而 `slot.awaiting = true` 是「等对方回话」的意思 —— 对方压根没收到东西，
   * 那一等就是白等，还会把后面的主动消息全堵住。
   *
   * messageCount 也不加：那是前端「已回复」的计数，一条短信都没发出去。
   */
  if (!forUser.trim()) {
    logInfo(scope, "这轮只发了 Instagram，没有要发给对方的短信");
    return;
  }

  await respondingWhile(space, async () => {
    const freshest = getConfig();
    const { sent, acted, failed } = await sendBubbles(runner, space, freshest.chat ?? {}, forUser, {
      role: currentRole(freshest, runner) ?? role,
      config: freshest,
      eps,
      // 引用和撤回要按 spaceId 去查两个环形缓冲（见 sendBubbles 的注释）
      spaceId,
      peer,
      // 转账那条路排「一直没收款就提醒一次」要它（见 sendTransferPart）
      getConfig,
    });
    if (!acted) {
      logWarn(scope, `这条主动消息一件事都没做成（${failed || "没有内容"}）`);
      return;
    }
    /*
     * `slot.awaiting` 卡在 `sent` 上，不是 `acted`。
     *
     * 那个标志是「等对方回话」的意思，而主动消息里一条新消息都没发出去
     * （比如整条就一个 `[react:]`）时对方屏幕上什么新东西都没有 —— 那一等
     * 就是白等，还会把后面的主动消息全堵住（和上面「只发了 IG」那一条同一个
     * 道理）。messageCount 同理：前端那是「已回复」的计数。
     */
    if (!sent) {
      logInfo(scope, "这条主动消息没有新消息、只改了已有的气泡，不进入「等对方回话」");
      return;
    }
    runner.messageCount += 1;
    // 从这一刻起等对方回话：期间收到已读回执就记一笔，下一条会缀上那句话
    slot.awaiting = true;
    slot.read = false;
    // 这两笔要跟着表一起落盘，不然重启后「已读但没回」就丢了
    saveSlot(runner.projectRefId, spaceId, slot);
  }, runner);
}

/**
 * 对方读了我们发的消息（入站的 read 回执）。
 *
 * 只在「发过主动消息、对方还没回话」这段时间里记 —— 平时的已读没有用处，
 * 记了反而会让下一条主动消息凭空缀上一句「已读但没回复」。
 *
 * iMessage 的已读是**会话级**的，回执不告诉你读的是哪一条，所以这里也只
 * 记一个布尔值，不去对号入座。
 */
function noteProactiveRead(runner, spaceId) {
  const slot = runner.proactive.get(spaceId);
  if (!slot?.awaiting || slot.read) return;
  slot.read = true;
  saveSlot(runner.projectRefId, spaceId, slot);
  logDebug(scopeOf(runner, "主动消息"), `${spaceId}：对方读了上一条主动消息，还没回话`);
}

/**
 * 一条语音气泡。
 *
 * 合成失败**退化成文字**：把该念的那句话原样发出去。语音发不出去至少话要
 * 到，对方看到一条文字消息不会觉得哪里不对；发一句「语音生成失败」才是真的
 * 破坏沉浸感。
 *
 * `voice()` 拿 Buffer 时必须显式给 mimeType —— spectrum 的 resolveVoiceMimeType
 * 猜不出来会直接抛错。发出去之前 provider 那边会用 ffmpeg 转成 m4a
 * （mp3 和 wav 都不是 iMessage 的语音条格式），ffmpeg 走的是我们装的
 * ffmpeg-static，用户不用自己装。
 *
 * **文件名必须写死 .m4a，不能跟着合成出来的格式写 .mp3。** spectrum 的
 * uploadVoice 会把音频转成 m4a，但**文件名用的是我们传进去的那个**：
 *
 *     const { buffer } = await ensureM4a(await content.read(), content.mimeType);
 *     const name = content.name ?? "voice.m4a";
 *
 * 上传接口只发 { fileName, data } 两样，苹果那边**按扩展名认类型**。传
 * `voice.mp3` 的话，进去的是 m4a 的字节、贴的是 mp3 的名字，苹果拿 MPEG 的
 * 格式去解 MP4 容器，解不出时长 —— 语音条能发出去、能播，但显示 0 秒。
 * 时长本身没法由我们指定（sendAttachment 的请求体里没有这个字段），
 * 苹果只从文件里读，所以名字对了时长就对了。
 *
 * @returns {Promise<boolean>} 真的发出语音了没有（false = 已退化成文字发出）
 */
async function sendVoicePart(runner, space, part, ctx) {
  const scope = scopeOf(runner, "语音");
  const { role, config } = ctx;

  // 角色那道闸。提示词里没注入过这个功能，但模型可能凭记忆硬写一个标记出来
  if (!role?.voiceSend?.enabled) {
    logInfo(scope, "这个角色没开「发送语音」，标记退化成文字发出", part.text);
    noteSent(runner, ctx, await space.send(part.text));
    return false;
  }

  try {
    const { voice } = await import("spectrum-ts");
    const out = await synthesizeVoice(
      config?.ttsApi,
      role.voiceSend.voiceId,
      part.text,
      scope
    );
    // name 写死 .m4a —— 理由见上面的注释（写 .mp3 会让语音条显示 0 秒）。
    // mimeType 仍然给合成出来的真实类型，ensureM4a 靠它判断要不要转码。
    // duration 是 media.js 用 ffmpeg 读出来的秒数，读不出来时是 undefined
    // （voiceSchema 里这个字段是 optional，给 undefined 等于不传）。
    noteSent(
      runner,
      ctx,
      await space.send(
        voice(out.buffer, {
          mimeType: out.mimeType,
          name: "voice.m4a",
          duration: out.duration,
        })
      )
    );
    return true;
  } catch (e) {
    logError(scope, "语音发不出去，这一条退化成文字", e);
    noteSent(runner, ctx, await space.send(part.text));
    return false;
  }
}

/**
 * 一条图片气泡。
 *
 * 和语音相反，失败时**什么都不发**：那段文字是给出图模型看的画面描述
 * （「浅木桌，蓝莓芋泥蛋糕，白瓷盘」），发给人看毫无意义，发一句「图挂了」
 * 更糟。只记一条 error，用户去控制台看。整轮一条都没发出去的情况由调用方
 * 兜底（notifyFailure）。
 *
 * 参考图三个条件缺一不可：角色开着图生图、这张图在角色勾选的 refs 里、
 * data/images/ 里文件真的存在。差一个就降级成纯文生图并记一条日志 ——
 * 静默降级的话用户只会觉得「图生图没生效」，查不出是哪一步没对上。
 *
 * @returns {Promise<boolean>} 发出去了没有
 */
async function sendImagePart(runner, space, part, ctx) {
  const scope = scopeOf(runner, "生图");
  const { role, config, eps } = ctx;

  if (!role?.imageGen?.enabled) {
    logInfo(scope, `这个角色没开「生成图片」，跳过这条：${part.text}`);
    return false;
  }
  const endpoint = eps?.image ?? resolveImageEndpoint(config);
  if (!endpoint) {
    logError(
      scope,
      "没有可用的生图模型，这张图发不出来",
      "去「连接」面板给某个模型勾上「生图」分类（或者那个模型被关掉了）"
    );
    return false;
  }

  // 参考图
  let refFile = null;
  if (part.ref) {
    const gen = role.imageGen;
    if (!gen.img2img) {
      logInfo(scope, `模型点名了参考图「${part.ref}」，但这个角色没开图生图，按文生图处理`);
    } else if (!(gen.refs ?? []).includes(part.ref)) {
      logInfo(scope, `参考图「${part.ref}」不在这个角色勾选的范围里，按文生图处理`);
    } else {
      refFile = resolveRefFile(part.ref);
      if (!refFile) {
        logWarn(scope, `图库里有「${part.ref}」，但 data/images/ 里没找到对应的图片文件，按文生图处理`);
      }
    }
  }

  try {
    const { attachment } = await import("spectrum-ts");
    const out = await generateImage(endpoint, { prompt: part.text, refFile }, scope);
    noteSent(
      runner,
      ctx,
      await space.send(
        attachment(out.buffer, { mimeType: out.mimeType, name: `image.${out.ext}` })
      )
    );
    return true;
  } catch (e) {
    // 不发占位文字：发一句「图挂了」比不发更破坏沉浸感
    logError(scope, `这张图没能发出去（描述：${part.text}）`, e);
    return false;
  }
}

/**
 * 一条表情包气泡。
 *
 * 和生图一样，失败时**什么都不发**：`[send_emoji:紧张]` 里的「紧张」是给
 * 挑图用的标签，不是给人看的话，原样发出去只会让对方莫名其妙。只记一条
 * 日志，整轮一条都没发出去的情况由调用方兜底（notifyFailure）。
 *
 * 两道闸和 prompt.js:stickerTagsFor 那两道**一模一样**，在这儿再查一遍：
 * 提示词里没注入过的标签，模型照样可能凭记忆硬写一个出来（这也正是
 * 用户要黑名单的原因 ——「黑名单不会给 LLM 注入相关表情包标签」只挡住
 * 「知道」，挡不住「乱写」，真正兜住的是这里）。第三道「文件夹里真有图」
 * 由 pickEmoji 顺带把住 —— 它挑不出来就返回 null。
 *
 * 挑图那步在 emoji.js:pickEmoji：文件夹里随机一张，按角色配的
 * `stickerSend.noRepeat`（默认 5）躲开最近发过的那几张。
 *
 * @returns {Promise<boolean>} 发出去了没有
 */
async function sendStickerPart(runner, space, part, ctx) {
  const scope = scopeOf(runner, "表情包");
  const { role } = ctx;

  if (!role?.stickerSend?.enabled) {
    logInfo(scope, `这个角色没开「发送表情包」，跳过这条：[send_emoji:${part.text}]`);
    return false;
  }
  const tag = part.text;
  if ((role.stickerSend.blacklist ?? []).includes(tag)) {
    logInfo(scope, `「${tag}」在这个角色的黑名单里，跳过（模型不该知道它，但它写出来了）`);
    return false;
  }

  const hit = pickEmoji(tag, role.stickerSend.noRepeat);
  if (!hit) {
    logWarn(scope, `data/images/emojis/${tag}/ 里没有能用的图片 —— 要么这个标签不存在（模型自己编的），要么文件夹是空的`);
    return false;
  }

  try {
    const { attachment } = await import("spectrum-ts");

    // 文件名 = 标签名 + **真实**后缀。对方那头看到的是「紧张.gif」而不是一串乱码。
    //
    // 后缀由 pickEmoji 按字节认出来（不是 path.extname）—— iMessage 只看后缀
    // 决定这附件是图还是文件，后缀骗了它就渲染成灰色文件图标。mimeType 只在
    // 本进程里用，真正发出去的只有这个 name。
    //
    // 标签名用 hit.tag（pickEmoji 过过 basename 的那个）而不是模型原样写的 tag ——
    // 模型要是写了带斜杠的标签，别让它跑进文件名里。剔完一个字符都不剩就退回
    // sticker：文件名不能是光秃秃的「.gif」，那在对方那头是个无后缀的隐藏文件。
    const stem = hit.tag.replace(/[\\/:*?"<>|]/g, "").trim() || "sticker";
    const name = `${stem}${hit.ext}`;

    noteSent(
      runner,
      ctx,
      await space.send(attachment(hit.buffer, { mimeType: hit.mimeType, name }))
    );
    logDebug(scope, `发了 ${tag}/${hit.file} → ${name}`);
    return true;
  } catch (e) {
    logError(scope, `表情包「${tag}」没能发出去（${hit.file}）`, e);
    return false;
  }
}

/**
 * 真正把一条网址发成链接卡片。`[card:…]` 和 `[music:…]` 最后都落到这儿。
 *
 * 走 spectrum-ts 的 `richlink(url)`，云端 provider 会把它翻译成「发这条网址 +
 * 打开链接预览」，落到对方手机上就是一张带标题和封面图的卡片。
 *
 * **发不出网易云音乐那种带 app 图标和自定义排版的卡片** —— 那种得用
 * `customizedMiniApp` 并填上真实的 Apple teamId 和扩展 bundleId，等于冒充
 * 人家 app 的身份（详见 card.js 的文件头）。这里发的是链接卡片：链接是真的，
 * 标题和封面是对方手机自己抓的。
 *
 * @returns {Promise<boolean>} 发出去了没有
 */
async function sendLinkCard(runner, space, url, ctx, scope) {
  try {
    const { richlink } = await import("spectrum-ts");
    noteSent(runner, ctx, await space.send(richlink(url)));
    logDebug(scope, `发了一张链接卡片：${url}`);
    return true;
  } catch (e) {
    /*
     * 只有「这个平台压根不支持富链接」才退化成发纯网址。
     *
     * 本地 Mac 模式没有 richlink 这条分支（@spectrum-ts/imessage-local 的 switch
     * 直接落到 default，抛的是 UnsupportedError），那时候退化成把网址当普通文字发 ——
     * 对方的 iMessage 收到纯网址时多半也会自己抓预览，只是这事保证不了。
     *
     * **别的错一律不重发。** 这条 catch 原来是不挑错的：网络抖一下、gRPC 超时,
     * 只要 send 这个 Promise 拒了就补一条纯网址。但「拒了」不等于「没发出去」——
     * 消息很可能已经到了对方手机上，只是回执没回来，于是对方连着收到两张一模一样
     * 的卡片（纯网址在 iMessage 那头照样渲染成卡片，肉眼看不出这两条是不同类型）。
     * 宁可这一条没发出去、日志里留个案底，也不能凭空多发一条。
     */
    if (e?.name !== "UnsupportedError") {
      logError(scope, `链接卡片没能发出去：${url}（不重发，避免对方收到两条）`, e);
      return false;
    }
    logWarn(scope, "这个模式发不了链接卡片，改成直接发这条网址（本地 Mac 模式）", e);
    try {
      noteSent(runner, ctx, await space.send(url));
      return true;
    } catch (err) {
      logError(scope, `这条网址也没能发出去：${url}`, err);
      return false;
    }
  }
}

/**
 * 执行一个 `[card:网址]`：发一张链接卡片。
 *
 * 两道闸：角色开关（提示词里没注入不代表模型不会硬写），再加一次
 * `isCardUrl` —— media.js 那条正则本来就只切 http(s)，这里是发之前再确认，
 * 免得把 `https://` 这种残缺的东西当网址发出去。
 *
 * @returns {Promise<boolean>} 发出去了没有
 */
async function sendCardPart(runner, space, part, ctx) {
  const scope = scopeOf(runner, "卡片");
  const url = String(part.text ?? "").trim();

  if (!ctx?.role?.cardSend?.enabled) {
    logInfo(scope, `这个角色没开「分享链接卡片」，跳过这条：[card:${url}]`);
    return false;
  }
  if (!isCardUrl(url)) {
    logWarn(scope, `[card:${url}] 不是一条能发的 http/https 网址，跳过`);
    return false;
  }

  return sendLinkCard(runner, space, url, ctx, scope);
}

/**
 * 转账发不成卡片时的退路：当普通文字发一句。
 *
 * 两处都用它 —— 本地 Mac 模式（压根没这条 RPC）和云端发失败。这笔钱的意思
 * 必须送出去，哪怕丢了卡片那层样子。
 *
 * 金额跟着角色那个货币符号走 —— 退化版和卡片版说的该是同一笔钱。
 *
 * @param {string} why 日志里说清是哪一种，两种排查方向完全不同
 * @returns {Promise<boolean>} 这句文字发出去了没有
 */
async function sendTransferText(runner, space, ctx, amount, note, scope, why) {
  const money = formatAmount(amount, ctx?.role?.transfer?.currency);
  const text = `转账 ${money}${note ? ` ${note}` : ""}`;
  logWarn(scope, `${why}，改成发一句文字：${text}`);
  try {
    noteSent(runner, ctx, await space.send(text));
    return true;
  } catch (e) {
    logError(scope, "这句转账文字也没能发出去", e);
    return false;
  }
}

/* ================= 转出去一直没人收：提醒一次 ================= */

/**
 * 那张内存表的键。一个角色可以同时挂着好几笔没收的，所以角色 key 还不够，
 * 得连卡片的 guid 一起。
 */
function remindKey(roleKey, guid) {
  return `${roleKey}::${guid}`;
}

/** 撤掉某一笔的提醒排期（收款了、或者线路停了）。只动内存。 */
function disarmTransferRemind(runner, roleKey, guid) {
  const key = remindKey(roleKey, guid);
  const timer = runner.transferRemind?.get(key);
  if (timer) clearTimeout(timer);
  runner.transferRemind?.delete(key);
}

/**
 * 排一笔「到点还没收款就提醒角色一次」。
 *
 * ── 为什么不能只靠这个定时器保证「只提醒一次」──
 *
 * 定时器活不过重启，而这个功能的等待窗口默认是两小时 —— 那两小时里进程重启一次
 * 是很正常的事。所以重启后必须把它捞回来接着数（rehydrateTransferReminders），
 * 而一旦有了「捞回来」这一步，「提醒过了」就不能只是「定时器已经不在了」——
 * 那两件事在重启之后长得一模一样。判据只能在磁盘上：那笔转账的 `reminded`。
 *
 * 所以这里排的定时器只负责**什么时候去看一眼**，去不去说话由
 * remindTransferPending 现读磁盘决定。
 *
 * @param {number} [delayMs] 指定还等多久；不给就按配置算整段（重启接着数时要传）
 */
function armTransferRemind(getConfig, runner, roleKey, guid, delayMs) {
  if (runner.stopped) return;
  /*
   * 拿不到 getConfig 就不排。
   *
   * 到点那一下**必须**重读配置（这中间过了两小时，开关可能已经关了），所以没有
   * 它就没有能安全执行的提醒。排一个注定要崩的定时器不如干脆不排 ——
   * sendBubbles 的 ctx 是各条调用路径自己拼的，漏一处这里就得兜住。
   */
  if (typeof getConfig !== "function" || !roleKey || !guid) return;
  const wait = Number.isFinite(delayMs) ? Math.max(delayMs, 0) : null;

  disarmTransferRemind(runner, roleKey, guid);
  const key = remindKey(roleKey, guid);
  const timer = setTimeout(() => {
    runner.transferRemind?.delete(key);
    void remindTransferPending(getConfig, runner, roleKey, guid);
  }, wait ?? 0);
  // 和主动消息那张表同一个理由：不该由它决定进程能不能退出
  timer.unref?.();
  runner.transferRemind?.set(key, timer);
}

/**
 * 到点了：这笔还没收款的话，提醒角色一次。
 *
 * 每一道判都是**此刻**重新读的，因为这中间过了两个小时：用户可能已经把开关关了、
 * 把角色换了、或者早就收了款。
 *
 * ── 为什么先落 reminded 再说话 ──
 *
 * 落盘写在 enqueue **之前**：那一句进了队列就等于这次提醒已经发生了，先说话
 * 再落盘的话，中间崩一次就会重启后再提醒一遍。反过来「落了盘但那句没送出去」
 * 最多是这笔转账没被提醒 —— 一个不该发生两次的提醒，宁可零次。
 *
 * ── 勿扰 / 协助 / 线下怎么办 ──
 *
 * 和 fireProactive 那三道闸一样是**推迟**而不是取消（推迟就是重排一个定时器，
 * reminded 还没落，所以这一次提醒还在账上）。区别只在勿扰：那边推到时段结束，
 * 这边也一样 —— 半夜把角色叫起来说「钱还没收」和主动消息一个性质。
 */
async function remindTransferPending(getConfig, runner, roleKey, guid) {
  if (runner.stopped) return;
  const scope = scopeOf(runner, "转账");
  const config = getConfig();
  const role = currentRole(config, runner);

  // 角色被解绑/换人了：这笔的账跟着作废（磁盘上那条留着，它还要能收款）
  if (!role || memoryKeyFor(role) !== roleKey) return;

  const tr = role.transfer;
  // 开关中途关了、或者整个转账功能关了 —— 不提醒，也不落 reminded：
  // 用户再打开的话这笔已经错过窗口了，但至少不留一个「提醒过了」的假记录
  if (!tr?.enabled || !tr.remindOnPending) return;

  const hit = findTransfer(roleKey, guid);
  if (!hit) return; // 记录被挤掉了（MAX_ENTRIES），没法说清是哪笔
  if (hit.state === "received") return; // 已经收了，这就是这个功能最常见的结局
  if (hit.reminded) {
    // 正常走不到：排期那会儿就滤过一遍了。留着是因为「只提醒一次」这件事
    // 值得在真正开口前再问一遍磁盘
    logDebug(scope, "这笔转账早就提醒过了，不提醒第二遍");
    return;
  }

  /*
   * 往哪条会话说。
   *
   * 优先用那笔存下来的 peerKey —— 转账是发给具体某个人的，提醒当然要回到
   * 同一条会话里去。（这也是 peerKey 这个字段第一个真正的读者：以前只存不读。）
   * 拿不到就退到「这个号最近一条入站消息所在的会话」，那是 runner 上唯一一个
   * 随时可用的 space。
   */
  const last = runner.lastSpace;
  const wantPeer = String(hit.peerKey ?? "");
  const peer = wantPeer || String(last?.peer ?? "");
  const sameSession = !wantPeer || !last?.peer || peerKeyOf(last.peer) === wantPeer;

  let space = sameSession ? last?.space : null;
  let spaceId = sameSession ? last?.spaceId : "";

  /*
   * 内存里没有能用的 space（进程重启后一直没人说话，正是这个功能最常见的场景）：
   * 拿卡片自己的 chatGuid 现要一个 —— 那就是这条会话的 ID。
   *
   * ensureSpace 要一个「主动消息形状」的槽，所以现造一个临时的给它填。
   */
  if (!space) {
    spaceId = String(hit.chatGuid ?? "");
    if (!spaceId) return;
    const tmp = { space: null };
    space = await ensureSpace(runner, tmp, spaceId);
    /*
     * 要不到（号码这会儿没连上）：隔一段再试，**不落 reminded** ——
     * 这一次提醒还没发生过。和 fireProactive 拿不到 space 时同一个处理。
     */
    if (!space) {
      armTransferRemind(getConfig, runner, roleKey, guid, RETRY_SPACE_MS);
      return;
    }
  }
  if (runner.stopped) return;

  // 协助模式：提示词工程师正在排查人设，角色让位了，别插一句催款进去
  if (isAssistOn(runner.projectRefId, spaceId)) {
    logDebug(scope, `协助模式开着，这笔转账的提醒推迟到 ${humanizeWait(ASSIST_HOLD_MS)}后`);
    armTransferRemind(getConfig, runner, roleKey, guid, ASSIST_HOLD_MS);
    return;
  }
  // 线下模式：两个人正坐着演剧情，手机上不该冒出一句「钱怎么还没收」
  if (isOfflineOn(roleKey)) {
    logDebug(scope, `线下模式开着，这笔转账的提醒推迟到 ${humanizeWait(ASSIST_HOLD_MS)}后`);
    armTransferRemind(getConfig, runner, roleKey, guid, ASSIST_HOLD_MS);
    return;
  }
  // 勿扰时段：推到时段结束。半夜提醒和主动消息半夜开口是同一件事
  const hold = msUntilFocusEnd(role.proactive?.focus);
  if (hold > 0) {
    logDebug(scope, `现在是勿扰时段，这笔转账的提醒推迟到 ${humanizeWait(hold)}后`);
    armTransferRemind(getConfig, runner, roleKey, guid, hold);
    return;
  }

  /*
   * 先把「提醒过了」钉在磁盘上，再说话（理由见函数头）。
   *
   * 写不进去就干脆不提醒 —— 写不进去意味着下次重启还会再提醒一遍，
   * 而这个功能的全部承诺就是「只提醒一次」。
   */
  if (!putTransfer(roleKey, { ...hit, reminded: true })) {
    logWarn(scope, "这笔转账的「提醒过了」没能落盘，这次就不提醒了（免得重启后又提醒一遍）");
    return;
  }

  const money = formatAmount(hit.amount, hit.currency);
  const memo = hit.note ? `（${hit.note}）` : "";
  const mins = clampInt(tr.remindMinutes, 120, 1, 1440);
  const hint =
    `[系统提示:你转给{{user}}的 ${money}${memo}已经 ${humanizeWait(mins * 60_000)}没被领取了，` +
    `{{user}}一直没点收款。这件事只会提醒你这一次]`;
  logInfo(scope, `这笔转账挂了 ${humanizeWait(mins * 60_000)}还没人收，提醒角色一次：${money}`);
  // 走 enqueue 不走 noteReaction：那条路的提示有 10 分钟保质期
  // （BG_HINT_TTL_MS），而这句话本身就是「等了两小时」才有的，攒着等于必然丢掉
  enqueue(getConfig, runner, space, spaceId, { text: hint }, peer);
}

/**
 * 连上之后，把硬盘上那些还没收、也还没提醒过的转账接着数。
 *
 * 这是「只提醒一次」能跨重启成立的另一半：内存表空了，但磁盘上记着
 * `state: "pending"` 且 `reminded` 还是假的那几笔 —— 那才是真的还欠一次提醒。
 * 已经提醒过的（`reminded` 为真）在这儿被滤掉，所以重启多少次都只有那一次。
 *
 * 关机期间已经到点的不立刻开口：挪到 SETTLE_MS 之后，和 rehydrateProactive
 * 同一个理由 —— 一开机十几笔同时往外发不像话。
 */
function rehydrateTransferReminders(getConfig, runner) {
  const scope = scopeOf(runner, "转账");
  const role = currentRole(getConfig(), runner);
  const tr = role?.transfer;
  if (!tr?.enabled || !tr.remindOnPending) return;

  const roleKey = memoryKeyFor(role);
  if (!roleKey) return;
  const mins = clampInt(tr.remindMinutes, 120, 1, 1440);
  const waitMs = mins * 60_000;

  let armed = 0;
  let overdue = 0;
  for (const it of readTransfers(roleKey).items) {
    if (it?.state === "received" || it?.reminded) continue;
    const guid = String(it?.messageGuid ?? "");
    if (!guid) continue;
    const left = (Number(it.at) || Date.now()) + waitMs - Date.now();
    if (left <= 0) overdue += 1;
    armTransferRemind(getConfig, runner, roleKey, guid, Math.max(left, SETTLE_MS));
    armed += 1;
  }

  if (armed) {
    logInfo(
      scope,
      `还有 ${armed} 笔转账没收、也没提醒过，接着数` +
        `${overdue ? `（其中 ${overdue} 笔关机期间已经到点，${humanizeWait(SETTLE_MS)}后补上）` : ""}`
    );
  }
}

/**
 * 执行一个 `[transfer:4000:零花钱]`：发一张转账卡片，并把句柄存下来。
 *
 * 三道闸：
 *
 *  1. **角色开关**（提示词里没注入不代表模型不会硬写）；
 *  2. **只有云端模式**能发 —— 本地 Mac 模式没有 Photon 那两条 RPC；
 *  3. 金额认得出来（media.js 那条正则已经要求数字打头，这里不再重复判）。
 *
 * 第 2 条和「云端发失败」都退化成**当普通文字发一句**（sendTransferText），
 * 不是什么都不发：这笔钱的意思得说出去。
 *
 * 句柄存不下来的时候**照样算发出去了** —— 卡片已经在对方手机上，只是以后
 * 改不成「已收款」。报成失败会让用户以为这笔没发出去，那更糟。
 *
 * @returns {Promise<boolean>} 发出去了没有
 */
async function sendTransferPart(runner, space, part, ctx) {
  const scope = scopeOf(runner, "转账");
  const amount = String(part.text ?? "").trim();
  const note = String(part.note ?? "").trim();
  const role = ctx?.role;

  if (!role?.transfer?.enabled) {
    logInfo(scope, `这个角色没开「转账卡片」，跳过这条：[transfer:${amount}]`);
    return false;
  }
  if (!amount) return false;

  /*
   * 本地 Mac 模式：没有 sendCustomizedMiniApp 这条路，退化成一句文字。
   * 和 sendLinkCard 碰上 UnsupportedError 时退回纯网址是同一个处理。
   */
  if (runner.mode !== "cloud") {
    return sendTransferText(runner, space, ctx, amount, note, scope, "本地 Mac 模式发不了转账卡片");
  }

  /*
   * 卡片上那张缩略图。没配 logo 就是 null，卡片照旧发（只是不带图）。
   *
   * 渲染放在发之前、`await` 着等：这一步有缓存，同一个 logo 第二次几乎零成本，
   * 而**图和卡片必须一起送上去** —— 卡片一旦发出去就只能靠 updateCustomizedMiniApp
   * 整条换掉，没有「补一张图上去」这种操作。
   */
  const image = await renderLogo(role.transfer.logo, {
    bg: role.transfer.logoBg,
    style: role.transfer.logoStyle,
    scope,
  });

  const session = await sendTransferCard({
    projectId: runner.projectId,
    projectSecret: runner.projectSecret,
    chatGuid: ctx?.spaceId ?? "",
    amount,
    note,
    appName: role.transfer.appName,
    currency: role.transfer.currency,
    image,
    scope,
  });
  /*
   * 云端也没发出去（线路不让发这种卡片、超时、凭据过期…）：同样退化成一句
   * 文字，不能让整轮回复跟着一起没。
   *
   * 这条以前是 `return false`，于是「只写了一个 [transfer:…] 的那一轮」会被
   * 上游判成「一件事都没做成」，对方收到的是一句「这条没能发出来」——
   * 这笔钱的意思一个字都没送出去。而本地模式明明早就退化成文字了，
   * 两边不一致纯属漏了一处。
   *
   * 卡片发出去但**没拿到句柄**的情况也走到这儿（sendTransferCard 返回 null）。
   * 那种情况下对方手机上已经有一张卡片了，再补一句文字等于说两遍 —— 认了，
   * 说两遍比一笔转账彻底消失好，而且那条路极少见（见 card.js 那句 logWarn）。
   */
  if (!session) {
    return sendTransferText(runner, space, ctx, amount, note, scope, "这张转账卡片没发出去");
  }

  /*
   * 存句柄。存不下来只 warn —— 卡片已经发出去了，这一步失败只意味着
   * 「以后改不了状态」，不该反过来说这笔转账失败了。
   *
   * appName / currency / logo 也存进去：用户中途改了配置，老卡片还得能用原来那个
   * 名字去改、还得显示原来那个符号和同一张脸（见 card.js:updateTransferCard 的注释）。
   *
   * logo 存的是**文件名**，不是刚渲出来那堆字节 —— 收款时按名字重渲一遍。
   */
  const ok = putTransfer(memoryKeyFor(role), {
    ...session,
    amount,
    note,
    state: "pending",
    peerKey: peerKeyOf(ctx?.peer ?? ""),
    appName: role.transfer.appName,
    currency: role.transfer.currency,
    logo: role.transfer.logo,
    logoBg: role.transfer.logoBg,
    logoStyle: role.transfer.logoStyle,
  });
  if (!ok) logWarn(scope, "这笔转账的句柄没存下来，之后改不了「已收款」");

  /*
   * 排一次「到点还没收就提醒一下」。默认关，开了默认 120 分钟。
   *
   * 句柄没存下来就不排（`ok` 为假）：那笔查不回来，到点既认不出金额、也没法
   * 把 `reminded` 钉上去 —— 而钉不上就等于下次重启还会再提醒一遍。
   */
  if (ok && role.transfer.remindOnPending) {
    const mins = clampInt(role.transfer.remindMinutes, 120, 1, 1440);
    armTransferRemind(
      ctx?.getConfig,
      runner,
      memoryKeyFor(role),
      String(session.messageGuid ?? ""),
      mins * 60_000
    );
    logDebug(scope, `这笔要是 ${humanizeWait(mins * 60_000)}还没人收，就提醒角色一次`);
  }

  logInfo(
    scope,
    `发了一张转账卡片：${formatAmount(amount, role.transfer.currency)}${note ? `（${note}）` : ""}`
  );
  return true;
}

/**
 * 对方给一张转账卡片贴了 emoji → 把它原地改成「已收款」。
 *
 * 这是整个功能里最像真转账的一步：改的是**同一条气泡**，对方看着那张卡片
 * 右上角从「待收款」变成「已收款」。
 *
 * ── 为什么用贴 emoji 而不是点卡片 ──
 *
 * 卡片上的文字槽是纯展示，苹果不给第三方在气泡里放按钮；而「用户点了卡片」
 * 这个动作也**传不回来**（事件流只有消息/群/投票/会话四种变化）。贴 tapback
 * 是唯一一个「在那条气泡上操作、而且我们收得到」的动作。
 *
 * ── 为什么拦在 reactSend 那道闸之前 ──
 *
 * 那道闸管的是「把对方贴的 emoji 告诉模型」。收款是另一件事 —— 用户没开
 * 「消息回应」不代表他不想收款，卡在闸后面会让这个功能在大多数角色上悄悄失效。
 *
 * @param {object} message 那条 reaction 消息
 * @returns {Promise<null | {amount: string, note: string}>}
 *   真收了款就返回那笔的金额和备注（调用方拿它给模型写一句提示）；
 *   不是转账卡片、功能没开、已经收过了、改失败了 —— 都返回 null
 */
async function claimTransferOnReact(runner, role, message, scope) {
  if (!role?.transfer?.enabled || !role.transfer.confirmOnReact) return null;
  if (runner.mode !== "cloud") return null;

  /*
   * 被贴的那条气泡。认不出 guid 就没法查。
   *
   * 相册/图文混发那种一条消息带好几个气泡的，provider 会把 target 收窄成其中
   * 一个子项、id 长成 `p:0/<父 guid>`（@spectrum-ts/imessage 的 formatChildId）。
   * 转账卡片是单气泡，照理撞不上，但 `parentId` 在的时候优先用它 ——
   * 我们存的是父 guid，拿子 id 去查必定查不到。
   */
  const target = message?.content?.target;
  const targetGuid = String(target?.parentId ?? target?.id ?? "").trim();
  if (!targetGuid) return null;

  const roleKey = memoryKeyFor(role);
  const hit = findTransfer(roleKey, targetGuid);
  if (!hit) return null; // 贴的是普通消息，不是转账卡片

  if (hit.state === "received") {
    // 已经收过了。再贴一个 emoji 不该让卡片闪一下、也不该再告诉模型一遍
    logDebug(scope, `这笔转账早就收过了（${formatAmount(hit.amount, hit.currency)}），不重复处理`);
    return null;
  }

  /*
   * 重渲一遍那张缩略图。
   *
   * 字节没落盘（只存了文件名），而 updateCustomizedMiniApp 是**整条 layout 换掉**
   * 而不是改某个字段 —— 这儿不给图，那张卡片收款时就会当场把图丢了。
   *
   * 按**存下来的** logo / logoBg / logoStyle 渲，不读当前配置：和 appName、
   * currency 同一个道理，用户中途换了 logo 或者把它从横幅调成小图标，老卡片
   * 收款时不该当场换张脸、换个高矮。
   *
   * 那个文件被删了的话 renderLogo 返回 null，卡片退化成不带图的样子 —— 认了，
   * 总比为此把 JPEG 字节塞进转账记录里好。
   */
  const image = await renderLogo(hit.logo, { bg: hit.logoBg, style: hit.logoStyle, scope });

  const ok = await updateTransferCard({
    projectId: runner.projectId,
    projectSecret: runner.projectSecret,
    session: hit,
    amount: hit.amount,
    note: hit.note,
    // 用**存下来那个** appName，不读当前配置：改卡片的身份必须和发的时候一致
    appName: hit.appName,
    // 货币符号同理：用户中途换了符号，老卡片收款时不该当场换一个金额
    currency: hit.currency,
    image,
    state: "received",
    scope,
  });
  if (!ok) return null;

  putTransfer(roleKey, { ...hit, state: "received" });
  /*
   * 收款了，那笔的「一直没人收」提醒就不该再发了。
   *
   * 撤的是**内存里的排期**，磁盘上那条不动 —— 它已经是 `state: "received"` 了，
   * 重启后 rehydrateTransferReminders 压根不会把它捞回来（见那边的过滤）。
   *
   * 撤的时候用**那笔自己的** messageGuid，不是被贴的那个 guid：排期是按前者
   * 索引的，而 findTransfer 两个 guid 都能命中（见 transferstore.js）。
   */
  disarmTransferRemind(runner, roleKey, String(hit.messageGuid ?? ""));
  logInfo(
    scope,
    `对方收了这笔转账：${formatAmount(hit.amount, hit.currency)}${hit.note ? `（${hit.note}）` : ""}`
  );
  return { amount: hit.amount, note: hit.note, currency: hit.currency };
}

/**
 * 执行一个 `[music:歌手-歌名]`：查出真实链接，发成一张音乐卡片。
 *
 * 和 `[card:…]` 共用「分享链接卡片」那个角色开关 —— 对用户来说这俩是同一件事
 * （往对话里丢一张能点开的卡片），分成两个开关只会让人多勾一次。
 *
 * 查不到不发。搜索接口对着一串中文总会返回点什么，music.js 那边按歌名打分筛过
 * 一道，够不上就返回 null；这时候这条标记退化成什么都不发（前后的文字照常发），
 * 比把一首别人的歌发过去强 —— 后者对方是真会点开的。
 *
 * @returns {Promise<boolean>} 发出去了没有
 */
async function sendMusicPart(runner, space, part, ctx) {
  const scope = scopeOf(runner, "点歌");
  const query = String(part.text ?? "").trim();

  if (!ctx?.role?.cardSend?.enabled) {
    logInfo(scope, `这个角色没开「分享链接卡片」，跳过这条：[music:${query}]`);
    return false;
  }
  if (!query) return false;

  // 模型直接写了网址的话就当卡片发，别再拿它去搜索
  if (isCardUrl(query)) {
    logDebug(scope, `[music:${query}] 里写的是网址，按链接卡片发`);
    return sendLinkCard(runner, space, query, ctx, scope);
  }

  let hit = null;
  try {
    hit = await resolveMusic(query, { source: ctx?.role?.cardSend?.musicSource, scope });
  } catch (e) {
    logWarn(scope, `查「${query}」这首歌的时候出错了，这条不发`, e);
    return false;
  }
  if (!hit) {
    logInfo(scope, `没查到「${query}」这首歌（或者搜出来的对不上），这条不发`);
    return false;
  }

  logInfo(scope, `[music:${query}] → ${hit.artist} - ${hit.title}`);
  return sendLinkCard(runner, space, hit.url, ctx, scope);
}

/**
 * 执行一个 `[location:地名]` / `[location:地名:纬度,经度]`：发一张苹果地图卡片。
 *
 * iMessage **没有**「原生位置气泡」那种 content 类型（@spectrum-ts/core 把 22 种
 * 全列出来了，没有 location），所以能做到的就是拼一条 maps.apple.com 的网址、
 * 照卡片那条路发出去 —— 对方看到的是一张能点开的卡片，点一下直接跳地图。
 *
 * 用**自己那个** locationSend 开关，不蹭 cardSend：卡片那条提示词写着「网址
 * 必须是你确实知道的真实链接」，而位置这条恰恰允许角色编（详见
 * config.js:normalizeLocationSend）。
 *
 * 网址由 card.js:mapsUrlFor 现拼、不让模型自己写，和点歌一个道理。
 *
 * @returns {Promise<boolean>} 发出去了没有
 */
async function sendLocationPart(runner, space, part, ctx) {
  const scope = scopeOf(runner, "位置");
  const name = String(part.text ?? "").trim();
  const ll = String(part.ll ?? "").trim();

  if (!ctx?.role?.locationSend?.enabled) {
    logInfo(scope, `这个角色没开「分享位置」，跳过这条：[location:${name}]`);
    return false;
  }
  if (!name) return false;

  const url = mapsUrlFor(name, ll);
  if (!url) return false;

  logInfo(scope, `[location:${name}]${ll ? `（${ll}）` : ""} → ${url}`);
  return sendLinkCard(runner, space, url, ctx, scope);
}

/** 投票最多几个选项。苹果那边的上限，Spectrum 的 schema 也是 2–10。 */
const MAX_POLL_OPTIONS = 10;

/** 投票标题最多多少字。超了截断，不让整条发不出去。 */
const MAX_POLL_TITLE = 300;

/**
 * 单个选项最多多少字。
 *
 * 比标题短得多：选项在对方手机上是并排的小按钮，写一段话进去谁也看不清，而且
 * 那句系统提示里还要把全部选项列一遍（`【A…】【B…】`），个个几百字就没法读了。
 */
const MAX_POLL_OPTION_TEXT = 60;

/**
 * 执行一个 `[vote:A]`：在对方那个投票里投一票。
 *
 * 四道闸：
 *  1. **角色开关**（提示词里没注入不代表模型不会硬写）；
 *  2. **只有云端模式**能投 —— 本地 Mac provider 压根收不到投票事件，也没这条 RPC；
 *  3. 这条会话上得真有一个投票（pollstore 里最近活动的那个）；
 *  4. 模型写的那个 X 得对得上某个选项（见 poll.js:matchOption）。
 *
 * 认不出的时候**什么都不做**，不瞎投一个 —— 投错票比不投票糟得多，对方手机上
 * 会看到角色选了个它压根没提过的选项。
 *
 * 不写「投哪个投票」是故意的：提示词里也没让模型说。投的就是刚刚随着那句系统
 * 提示送进去的那个（findLatestPoll，理由见 pollstore.js 那边的注释）。
 *
 * @returns {Promise<boolean>} 真投上了没有。**不计进「发了几条」**（它改的是
 *   已有气泡，不新起消息），但算 `acted` —— 整条回复只有一个 `[vote:B]` 是
 *   完全正常的一轮，见 sendBubbles 里那段分工。
 */
async function runVotePart(runner, part, ctx) {
  const scope = scopeOf(runner, "投票");
  const want = String(part?.text ?? "").trim();
  const role = ctx?.role;

  if (!role?.poll?.enabled) {
    logInfo(scope, `这个角色没开「投票」，跳过这条：[vote:${want}]`);
    return false;
  }
  if (!want) return false;
  if (runner.mode !== "cloud") {
    logWarn(scope, `本地 Mac 模式投不了票，[vote:${want}] 跳过`);
    return false;
  }

  const chatGuid = String(ctx?.spaceId ?? "");
  const hit = findLatestPoll(memoryKeyFor(role), chatGuid);
  if (!hit) {
    logWarn(scope, `[vote:${want}] 这条会话里没有记着的投票，投不了`);
    return false;
  }

  const picked = matchOption(hit.options, want);
  if (!picked) {
    logWarn(
      scope,
      `[vote:${want}] 对不上那个投票的任何选项（${renderOptions(hit.options)}），不瞎投`
    );
    return false;
  }

  const ok = await castVote({
    projectId: runner.projectId,
    projectSecret: runner.projectSecret,
    pollMessageGuid: hit.pollMessageGuid,
    optionIdentifier: picked.optionIdentifier,
    scope,
  });
  // 标题可能是空的（Photon 那边的投票资源常常没 title，见 handlePollEvent 的注释）
  if (ok) logInfo(scope, `已在「${hit.title || "那个投票"}」里投了【${picked.text}】`);
  return ok;
}

/**
 * 执行一个 `[poll_add:炸鸡]`：给这条会话里最近那个投票加一个选项。
 *
 * 闸门和 runVotePart 一模一样（角色开关 / 只有云端 / 得真有个投票），外加一条：
 * **选项不能和已有的重复** —— 苹果那边允许加重的，加出来两个「炸鸡」谁也分不清
 * 该投哪个，而且后面 matchOption 按文字匹配时只会命中第一个。
 *
 * 加完把新的选项表落盘覆盖掉。这一步不是可选的：`addOption` 生成的新 id 只在
 * 这次返回值里出现一次，不存的话角色紧接着写 `[vote:E]` 就对不上东西（自己发起
 * 的投票那份本来 id 全是空串，见 sendPollPart）。
 *
 * @returns {Promise<boolean>} 加上了没有。同 runVotePart **不计进「发了几条」**
 *   ——它改的是已有气泡，不新起消息 —— 但算 `acted`。
 */
async function runPollAddPart(runner, part, ctx) {
  const scope = scopeOf(runner, "投票");
  const want = String(part?.text ?? "").trim();
  const role = ctx?.role;

  if (!role?.poll?.enabled) {
    logInfo(scope, `这个角色没开「投票」，跳过这条：[poll_add:${want}]`);
    return false;
  }
  if (!want) return false;
  if (runner.mode !== "cloud") {
    logWarn(scope, `本地 Mac 模式加不了选项，[poll_add:${want}] 跳过`);
    return false;
  }
  if (want.length > MAX_POLL_OPTION_TEXT) {
    logWarn(scope, `这个选项太长（${want.length} 字），截到 ${MAX_POLL_OPTION_TEXT} 字`);
  }
  const text = want.slice(0, MAX_POLL_OPTION_TEXT);

  const chatGuid = String(ctx?.spaceId ?? "");
  const hit = findLatestPoll(memoryKeyFor(role), chatGuid);
  if (!hit) {
    logWarn(scope, `[poll_add:${text}] 这条会话里没有记着的投票，加不了`);
    return false;
  }

  // 重了就不加：加出来两个一样的选项没人分得清，matchOption 也只会命中第一个
  const dupe = (hit.options ?? []).some((o) => String(o?.text ?? "").trim() === text);
  if (dupe) {
    logWarn(scope, `[poll_add:${text}] 这个选项已经有了（${renderOptions(hit.options)}），不重复加`);
    return false;
  }
  // 满了就不加：苹果那边上限 10，硬加只会白打一次 RPC
  if ((hit.options ?? []).length >= MAX_POLL_OPTIONS) {
    logWarn(scope, `[poll_add:${text}] 那个投票已经有 ${MAX_POLL_OPTIONS} 个选项了，加不下`);
    return false;
  }

  const fresh = await addPollOption({
    projectId: runner.projectId,
    projectSecret: runner.projectSecret,
    pollMessageGuid: hit.pollMessageGuid,
    text,
    scope,
  });
  if (!fresh) return false;

  /*
   * 把新表覆盖回去。`fresh.length` 那道判空同 handlePollEvent 那边：putPoll 的
   * `entry.options ?? prev.options` 拦不住空数组，会把好好的那份洗成空的。
   */
  if (fresh.length) {
    putPoll(memoryKeyFor(role), {
      pollMessageGuid: hit.pollMessageGuid,
      chatGuid: hit.chatGuid,
      peerKey: hit.peerKey,
      options: fresh,
    });
  }

  logInfo(
    scope,
    `已给「${hit.title || "那个投票"}」加了选项【${text}】` +
      (fresh.length ? `，现在是${renderOptions(fresh)}` : "")
  );
  return true;
}

/**
 * 执行一个 `[poll:今晚吃什么|麻辣烫|炸鸡|海底捞]`：自己发起一个投票。
 *
 * 三道闸 + 一条退路，和转账卡片同一个结构：
 *  1. **角色开关**；
 *  2. **只有云端模式**能发 —— `@spectrum-ts/imessage-local` 的 poll 分支直接
 *     `throw unsupportedLocalContent("poll")`，本地模式退化成一句文字；
 *  3. 标题和选项过一遍校验（见下面那几行）。
 *
 * 发不出去就退化成一句人话（`今晚吃什么：麻辣烫 / 炸鸡 / 海底捞`），照转账那条
 * 规矩 —— 这件事的意思得说出去，不能让整轮回复跟着一起没。
 *
 * **不能当引用回复发**：SDK 明确 `polls cannot be sent as replies`，所以这里
 * 直接 `space.send`，忽略这条气泡上的引用目标。
 *
 * @returns {Promise<boolean>} 发出去了没有（退化成文字也算发出去了）
 */
async function sendPollPart(runner, space, part, ctx) {
  const scope = scopeOf(runner, "投票");
  const title = String(part?.text ?? "").trim();
  const role = ctx?.role;

  if (!role?.poll?.enabled) {
    logInfo(scope, `这个角色没开「投票」，跳过这条：[poll:${title}]`);
    return false;
  }
  if (!title) return false;

  /*
   * 选项：去重 + 掐掉空的。顺序保持模型写的那个 —— 它就是字母顺序，
   * 而落盘那份也按这个顺序存（pollstore 的 options 注释）。
   */
  const seen = new Set();
  const options = [];
  for (const raw of part?.options ?? []) {
    const t = String(raw ?? "").trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    options.push(t);
  }

  const asText = `${title}${options.length ? `：${options.join(" / ")}` : ""}`;

  // 苹果的投票最少两个选项。一个都没写/只写了一个 → 当句话发出去
  if (options.length < 2) {
    return sendPollText(runner, space, ctx, asText, scope, "投票至少要两个选项");
  }
  // 上限 10（Spectrum 的 schema 也是 2–10）。多写的截掉，别整条发不出去
  if (options.length > MAX_POLL_OPTIONS) {
    logWarn(scope, `这个投票写了 ${options.length} 个选项，超了，只取前 ${MAX_POLL_OPTIONS} 个`);
    options.length = MAX_POLL_OPTIONS;
  }
  if (title.length > MAX_POLL_TITLE) {
    logWarn(scope, `投票标题太长（${title.length} 字），截到 ${MAX_POLL_TITLE} 字`);
  }
  const askTitle = title.slice(0, MAX_POLL_TITLE);

  if (runner.mode !== "cloud") {
    return sendPollText(runner, space, ctx, asText, scope, "本地 Mac 模式发不了投票");
  }

  let message;
  try {
    const { poll } = await import("spectrum-ts");
    message = noteSent(runner, ctx, await space.send(poll(askTitle, options)));
  } catch (e) {
    logWarn(scope, "这个投票没发出去", e);
    return sendPollText(runner, space, ctx, asText, scope, "这个投票没发出去");
  }

  logInfo(scope, `发起了一个投票：${askTitle}（${options.length} 个选项）`);

  /*
   * 存下来。`message.id` **就是** pollMessageGuid（provider 的 outboundPoll 拿
   * `poll.pollMessageGuid` 当 id），也就是对方投票时那个事件上的 guid ——
   * 存了这一笔，后面才认得出「他投的是哪个选项」，以及那句提示里该说
   * 「在**你发起的**投票里」。
   *
   * optionIdentifier 这会儿拿不到（space.send 只还回来一个 Message），先留空串。
   * 真 id 要等对方在这个投票上动一下：poll.js 收到事件会回源问一次 `polls.get`
   * 拿完整选项表，handlePollEvent 顺手覆盖掉这一笔。
   *
   * 所以在那之前角色投不了自己刚发起的那个投票（id 是空的，matchOption 返回的
   * 选项会被 castVote 的入参判空挡掉）—— 自己发的投票自己投本来也不像话。
   */
  const stored = putPoll(memoryKeyFor(role), {
    pollMessageGuid: String(message?.id ?? ""),
    chatGuid: String(ctx?.spaceId ?? ""),
    peerKey: peerKeyOf(ctx?.peer ?? ""),
    title: askTitle,
    options: options.map((text) => ({ text, optionIdentifier: "" })),
    mine: true,
  });
  if (!stored) logWarn(scope, "这个投票没存下来，对方投票时认不出是哪个选项");

  return true;
}

/**
 * 投票发不成气泡时的退路：当普通文字发一句。照 sendTransferText 那条规矩。
 *
 * @param {string} why 日志里说清是哪一种（本地模式 / 选项不够 / 云端发失败）
 * @returns {Promise<boolean>} 这句文字发出去了没有
 */
async function sendPollText(runner, space, ctx, text, scope, why) {
  logWarn(scope, `${why}，改成发一句文字：${text}`);
  try {
    noteSent(runner, ctx, await space.send(text));
    return true;
  } catch (e) {
    logError(scope, "这句投票文字也没能发出去", e);
    return false;
  }
}

/**
 * 执行一个 `[undosend:N]`：把自己倒数第 N 条已发出去的消息撤回。
 *
 * 三道闸按顺序过：
 *  1. 角色没开「消息撤回」就直接忽略（和别的标记一样，提示词里没注入不代表
 *     模型不会硬写）；
 *  2. 环形缓冲里数不到第 N 条 —— 多半是模型把 N 写大了，跳过比乱撤一条强；
 *  3. 超过苹果那个两分钟窗口的，提前跳过（见 UNDO_WINDOW_MS）。
 *
 * 撤成功之后要**把它从环里删掉**，否则连着两个 `[undosend:1]` 会对同一条
 * 撤两次（第二次必然失败），而不是往前数一条。
 *
 * 本地 Mac 模式不支持撤回（@spectrum-ts/imessage-local 直接返回
 * unsupportedAction），SDK 会抛错 —— 这里吞掉记一条 warn，那句漏嘴的话就
 * 留在对话里，比整轮回复因此中断强。
 *
 * @returns {Promise<boolean>} 真撤掉了没有。**不计进「发了几条」**（它不产出
 *   内容），但调用方要靠它判断「这一轮到底做了事没有」—— 见 sendBubbles 里
 *   `acted` 和 `sent` 的分工。
 */
async function runUndoPart(runner, space, part, ctx) {
  const scope = scopeOf(runner, "桥接");
  if (!ctx?.role?.undoSend?.enabled) {
    logInfo(scope, "这个角色没开「消息撤回」，[undosend] 忽略");
    return false;
  }

  const list = ringOf(runner.outbox, ctx?.spaceId);
  const n = Math.max(1, Number(part.n) || 1);
  if (n > list.length) {
    logWarn(scope, `[undosend:${n}] 撤不了：这条会话只发出去过 ${list.length} 条`);
    return false;
  }
  const idx = list.length - n;
  const slot = list[idx];

  // 先让那句话在对方屏幕上停一会儿 —— 没被看到过的撤回等于没说过，
  // 「说漏嘴然后心虚」这出戏就白演了
  await sleep(UNDO_DELAY_MS / 1000);

  if (Date.now() - slot.at > UNDO_WINDOW_MS) {
    logWarn(scope, `[undosend:${n}] 撤不了：那条已经发出去超过两分钟，过了苹果的撤回窗口`);
    return false;
  }

  try {
    await slot.message.unsend();
    list.splice(idx, 1);
    logInfo(scope, `已撤回自己倒数第 ${n} 条消息`);
    return true;
  } catch (e) {
    logWarn(scope, `[undosend:${n}] 撤回没成功（本地 Mac 模式不支持撤回）`, e);
    return false;
  }
}

/**
 * `[react:emoji]` / `[react:emoji:2]` / `[react:emoji:原文]`：
 * 给对方的某条气泡贴一个 emoji 回应（tapback）。
 *
 * 和撤回同类 —— **不产出任何内容**，不打 typing、不进 outbox、不计进「发了几条」。
 * 它改的是对方那条已有气泡的样子，不是新起一条消息。
 *
 * 两道校验缺一不可：
 *  - 角色开关（role.reactSend.enabled）—— 和别的功能一个规矩；
 *  - **emoji 在白名单里** —— 提示词里只列了勾中的那几个，但模型完全可能自己
 *    编一个出来（表情包那条也是这么防的，见 sendStickerPart）。不在就跳过，
 *    记一行 warn 让人看得见。
 *
 * 目标那条用 resolveReplyTarget 找（数字 = 往回数第几条、文字 = 找原文），
 * 没写就取 inbox 环里最后一条 —— 「默认贴对方最后一条」是提示词里教的默认值。
 *
 * 本地 Mac 模式整个不支持（imessage-local 的 react 直接返回 unsupportedAction），
 * 所以包在 try 里退化成一行 warn：贴不上一个 emoji，不该让这一轮回复崩掉。
 *
 * @returns {Promise<boolean>} 真贴上了没有。**不计进「发了几条」**（它不新起
 *   消息），但调用方要靠它判断「这一轮到底做了事没有」—— 只贴了个爱心的那种
 *   回复（对方说「你别回我了」，角色贴一颗心）是完全正常的一轮，不该被当成
 *   「一条都没发出去」去报错。见 sendBubbles 里 `acted` 和 `sent` 的分工。
 */
async function runReactPart(runner, space, part, ctx) {
  const scope = scopeOf(runner, "桥接");
  if (!ctx?.role?.reactSend?.enabled) {
    logInfo(scope, "这个角色没开「消息回应」，[react] 忽略");
    return false;
  }

  const emoji = String(part?.emoji ?? "").trim();
  const allow = Array.isArray(ctx.role.reactSend.emojis) ? ctx.role.reactSend.emojis : [];
  if (!allow.includes(emoji)) {
    logWarn(scope, `[react:${emoji}] 不在这个角色的 emoji 清单里，不贴`);
    return false;
  }

  // 没写「贴哪条」就贴对方最后一条
  const list = ringOf(runner.inbox, ctx?.spaceId);
  const target = part.spec
    ? resolveReplyTarget(runner, ctx?.spaceId, part.spec)
    : (list[list.length - 1]?.message ?? null);
  if (!target) {
    logWarn(
      scope,
      part.spec
        ? `[react:${emoji}:${part.spec}] 没在最近的消息里找到对应的那条，不贴`
        : `[react:${emoji}] 这条会话还没收到过消息，没东西可贴`
    );
    return false;
  }

  try {
    const { reaction } = await import("spectrum-ts");
    await space.send(reaction(emoji, target));
    logInfo(scope, `已给对方${part.spec ? `「${part.spec}」那条` : "最后一条"}贴上 ${emoji}`);
    return true;
  } catch (e) {
    logWarn(scope, `[react:${emoji}] 贴不上去（本地 Mac 模式不支持消息回应）`, e);
    return false;
  }
}

/**
 * 模型写的 `[effect:xxx]` 这一次算不算数。
 *
 * 和 `[react:]` 压的是同两道闸：角色开关 + 白名单。提示词里只列了勾中的那几个，
 * 但模型完全可能自己编一个出来（`[effect:雪花]`、或者用一个没勾的），
 * 不在清单里就当没写过 —— 标记 takeEffectTag 已经剜掉了，正文照常发，
 * 只是不带特效。
 *
 * 没写特效（key 为空）是最常见的情况，不记日志。
 */
function effectAllowed(ctx, key, scope) {
  if (!key) return false;
  if (!ctx?.role?.effectSend?.enabled) {
    logInfo(scope, `这个角色没开「消息特效」，[effect:${key}] 忽略`);
    return false;
  }
  const allow = Array.isArray(ctx.role.effectSend.effects) ? ctx.role.effectSend.effects : [];
  if (!allow.includes(key)) {
    logWarn(scope, `[effect:${key}] 不在这个角色的特效清单里，这条按纯文本发`);
    return false;
  }
  return true;
}

/**
 * 逐条气泡发送：先 typing 提示，发送气泡间按 delay 暂停。
 *
 * 每条气泡先摘掉 `[reply:…]`（那是**整条气泡**的属性，不是要发的内容），
 * 再过一遍 splitMedia，把 `[audio_message:…]` / `[send_emoji:…]` /
 * `[image:…]` / `[card:…]` / `[music:…]` / `[transfer:…]` / `[vote:A]` /
 * `[poll:注释|A|B]` / `[undosend:N]`
 * 从正文里切出来，各自走自己那条路（合成语音 / 挑一张表情包 / 出图 /
 * 发链接卡片 / 查歌再发卡片 / 发一张转账卡片 / 在对方那个投票里投一票 /
 * 自己发起一个投票 / 撤回刚发的那条），
 * 剩下的照旧当文字发。
 * 一条气泡里混着文字和标记时按**原来的先后顺序**发，模型写
 * 「你看这个[image:…]好不好看」出来的就是三条消息，顺序不乱；
 * 撤回尤其依赖这个顺序 —— 它撤的就是紧挨着它前面那条。
 *
 * ctx 是 `{ role, config, eps, spaceId }`，没传（或者角色没开对应的开关）时
 * 标记会退化 —— 语音退化成它要念的那句话，图片、表情包、卡片和点歌直接丢掉，
 * 撤回忽略。
 * `spaceId` 是引用和撤回要的：两个环形缓冲都按它索引，没有就退化成
 * 「引用发不出去、撤回撤不了」，普通文字照发。
 *
 * @returns {Promise<{sent:number, acted:number, failed:string}>}
 *   `sent` 是**新起的消息**条数（前端的「已回复」计数、主动消息的
 *   `slot.awaiting` 都按它算）；`acted` 是**做成的事**条数，多算上
 *   `[react:]` 和 `[undosend:]` 那两个不新起消息的；`failed` 只在
 *   `acted === 0` 时非空，说明是什么没做成（给对方那句报错用）。
 *
 *   调用方该看 `acted` 而不是 `sent` —— 整条回复只有一个 `[react:❤️]` 是
 *   完全正常的一轮（`sent` 是 0，`acted` 是 1），不该报错。
 */
async function sendBubbles(runner, space, chat, text, ctx = {}) {
  const scope = scopeOf(runner, "桥接");
  const bubbles = splitBubbles(text || "（我暂时答不上来）", chat);
  /*
   * 这行以前是 debug，而且不说要等多久。
   *
   * 「模型回复 xx 字」之后到对方真收到消息之间，是按字数算的打字停顿
   * （delay.js:computeDelay，一条长消息几十秒是正常的）。默认那档看不见
   * 这行的话，这段等待又是一片空白 —— 而它恰恰是**故意**等的，不是故障。
   *
   * 所以提到 info，并且把总时长先算出来报掉：看到「预计 42s 发完」就知道
   * 接下来的静默是设计如此，不用去怀疑是不是卡了。
   */
  const totalDelay = bubbles.reduce((sum, b) => sum + (b.delay ?? 0), 0);
  logInfo(
    scope,
    `拆成 ${bubbles.length} 条气泡，开始按打字节奏发` +
      `${totalDelay >= 1 ? `（预计 ${totalDelay.toFixed(0)}s 发完）` : ""}`
  );
  const startedAt = Date.now();
  try {
    await space.startTyping();
  } catch {
    /* 部分平台不支持 typing，忽略 */
  }

  let sent = 0;
  /*
   * `acted` 和 `sent` 不是一回事。
   *
   * `sent` 数的是**新起的消息**（前端「已回复」的计数、`slot.awaiting` 都按它
   * 算）。但 `[react:❤️]`、`[undosend:1]` 和 `[vote:A]` 不新起消息 —— 它们改的是
   * 已有气泡，所以刻意不进 `sent`。
   *
   * 于是「整条回复只有一个 [react:❤️]」这种完全正常的一轮（对方说「晚安 你别
   * 回我了」，角色贴一颗心就收尾）会走出 `sent === 0`，然后被调用方当成
   * 「一条都没发出去」，凭空给对方发一句「图片没生成成功」—— 那一轮压根没有
   * 图片。`acted` 就是为了分开这两件事：**做成了事**，和**发出了消息**。
   *
   * 失败的那几种（图没出来、表情包文件夹是空的、爱心贴不上去）一律不算
   * `acted`，该报错的照样报。
   */
  let acted = 0;
  /*
   * 这一轮到底出现过哪几种标记。整轮什么都没做成时，报错那句话要靠它说清
   * 「是什么没成」—— 原先那句话是猜的（一律归给出图失败），猜错了就变成一句
   * 和事实无关的话发给对方，而真正的原因在控制台里也对不上号。
   */
  const tried = new Set();
  for (const [i, bubble] of bubbles.entries()) {
    await sleep(bubble.delay);

    // 引用标记先摘掉：它不产出内容，只决定这条气泡挂在哪条消息下面。
    // 一条气泡里的每一段都挂同一个目标 —— 模型写「[reply:x]看这个[image:y]」
    // 时，文字和图本来就是冲着同一条说的
    const { spec, text: replied } = takeReplyTag(bubble.text);
    const target = spec ? resolveReplyTarget(runner, ctx?.spaceId, spec) : null;
    if (spec && !target) {
      // 找不到就当普通消息发。硬挂到一条猜出来的消息上，比不引用糟得多
      logWarn(scope, `[reply:${spec}] 没在最近的消息里找到对应的那条，这条按普通消息发`);
    }

    // 特效标记同理，也是整条气泡的属性（「这条以什么方式弹出来」），不产出内容。
    // 只作用于**文字**段 —— 图片/语音/卡片是各自的 sendXxxPart 直接 space.send
    // 的，不经过 emit，套不上
    const { key: effectKey, id: rawEffectId, text: body } = takeEffectTag(replied);
    const effectId = effectAllowed(ctx, effectKey, scope) ? rawEffectId : "";

    /**
     * 把一段内容真的交出去：有引用目标就挂上去，没有就直接发。
     * 两条路都把返回的 Message 记进 outbox，供后面的 [undosend:N] 取用。
     *
     * 引用在本地 Mac 模式下不支持（imessage-local 会抛 UnsupportedError），
     * 那时退回普通发送 —— 少一个引用框，总比这条消息发不出去强。
     */
    const deliver = async (payload) => {
      if (target) {
        try {
          return noteSent(runner, ctx, await target.reply(payload));
        } catch (e) {
          logWarn(scope, "引用回复发不出去，这一条按普通消息发（本地模式不支持引用）", e);
        }
      }
      return noteSent(runner, ctx, await space.send(payload));
    };

    /**
     * 一段文字发出去。带特效的先试特效版本，失败了拿原文再发一遍 ——
     * 本地 Mac 模式的 effect 是直接抛 unsupportedLocalContent 的，
     * 到不了对面。少一屏烟花没关系，那句话本身不能丢。
     */
    const emit = async (chunk) => {
      if (effectId) {
        try {
          const { effect } = await import("@spectrum-ts/imessage");
          return await deliver(effect(chunk, effectId));
        } catch (e) {
          logWarn(scope, `[effect:${effectKey}] 特效没发出去，这条按纯文本重发`, e);
        }
      }
      return deliver(chunk);
    };

    const parts = splitMedia(body);
    // 一个标记都没有：走原来那条路，一个字都不动
    if (!parts.some((p) => p.kind !== "text")) {
      // 摘掉引用标记后可能什么都不剩（模型写了条只有 [reply:x] 的气泡），
      // 那就不发 —— 空消息发出去是一条空白气泡
      if (body) {
        await emit(body);
        sent += 1;
        acted += 1;
      }
      logDebug(
        scope,
        `已发第 ${i + 1}/${bubbles.length} 条气泡（等了 ${bubble.delay.toFixed(2)}s）`
      );
      continue;
    }

    for (const part of parts) {
      if (part.kind === "text") {
        await emit(part.text);
        sent += 1;
        acted += 1;
        continue;
      }
      // 撤回不产出内容，也不需要打字指示器 —— 它撤的是刚发出去那条
      if (part.kind === "undo") {
        tried.add("undo");
        if (await runUndoPart(runner, space, part, ctx)) acted += 1;
        continue;
      }
      // 回应同理：贴的是对方那条已有的气泡，不是新起一条消息，
      // 所以既不打 typing 也不计进 sent（但算 acted，见上面那段）
      if (part.kind === "react") {
        tried.add("react");
        if (await runReactPart(runner, space, part, ctx)) acted += 1;
        continue;
      }
      // 投票同一档：改的是对方那个投票气泡，不新起消息，所以不计 sent、
      // 也不用打 typing（它不像出图那样要花几十秒）
      if (part.kind === "vote") {
        tried.add("vote");
        if (await runVotePart(runner, part, ctx)) acted += 1;
        continue;
      }
      // 加选项同上一档：改的也是那个已有的投票气泡
      if (part.kind === "poll_add") {
        tried.add("poll_add");
        if (await runPollAddPart(runner, part, ctx)) acted += 1;
        continue;
      }
      /*
       * 媒体这一条要花好几十秒（出图 10–40s，合成 2–5s），中间对方那头的
       * 打字指示器会灭掉。每条之前补发一次 —— 让对方看到「还在打」，
       * 而不是以为这轮已经结束了。
       */
      try {
        await space.startTyping();
      } catch {
        /* ignore */
      }
      let ok;
      tried.add(part.kind);
      if (part.kind === "audio") ok = await sendVoicePart(runner, space, part, ctx);
      else if (part.kind === "sticker") ok = await sendStickerPart(runner, space, part, ctx);
      else if (part.kind === "card") ok = await sendCardPart(runner, space, part, ctx);
      else if (part.kind === "music") ok = await sendMusicPart(runner, space, part, ctx);
      else if (part.kind === "location") ok = await sendLocationPart(runner, space, part, ctx);
      else if (part.kind === "transfer") ok = await sendTransferPart(runner, space, part, ctx);
      else if (part.kind === "poll") ok = await sendPollPart(runner, space, part, ctx);
      else ok = await sendImagePart(runner, space, part, ctx);
      // 语音退化成文字时也算发出去了一条（sendVoicePart 里已经发过）
      if (ok || part.kind === "audio") {
        sent += 1;
        acted += 1;
      }
    }
    logDebug(
      scope,
      `已发第 ${i + 1}/${bubbles.length} 条气泡（含媒体，等了 ${bubble.delay.toFixed(2)}s）`
    );
  }

  try {
    await space.stopTyping();
  } catch {
    /* ignore */
  }
  logInfo(
    scope,
    `回复发完，共 ${bubbles.length} 条气泡、${sent} 条消息，花了 ${secsSince(startedAt)}s`
  );
  return { sent, acted, failed: failedKinds(tried, acted) };
}

/** 标记种类 → 报错那句话里怎么称呼它。只有会「整轮只剩这一个」的那几种。 */
const KIND_NAMES = {
  image: "图片",
  sticker: "表情包",
  audio: "语音",
  card: "链接卡片",
  music: "音乐卡片",
  location: "位置",
  transfer: "转账卡片",
  react: "emoji 回应",
  undo: "撤回",
  vote: "投票",
  poll_add: "给投票加选项",
  poll: "发起投票",
};

/**
 * 整轮一件事都没做成时，是**什么**没成。
 *
 * 只在 `acted === 0` 时有意义 —— 做成了一件事就不该报错，哪怕别的几件失败了
 * （对方收到了东西，那一轮不是白的）。
 *
 * 返回空串表示「没有任何标记，纯文字却一条都没发出去」—— 那不该发生（文字
 * 那条路只要 body 非空就 `sent += 1`），真出现了就是别的 bug，措辞上留个口子。
 */
function failedKinds(tried, acted) {
  if (acted > 0 || !tried.size) return "";
  return [...tried].map((k) => KIND_NAMES[k] ?? k).join("、");
}

/**
 * 起一条连接。
 * @param {object} project 项目配置
 * @param {object} meta 显示用的信息（角色名等），日志和状态要用
 * @param {number} [retries] 已经连续失败了几次。自动重连接着往下数，
 *        手动重连/保存配置那条路一律从 0 开始（退避重新起步）
 */
/**
 * 起「聊天背景变更」的订阅（只有角色开了这个开关才起）。
 *
 * 为什么不能像别的功能那样直接在消息循环里做：Spectrum 的 iMessage provider
 * 只订阅 message / poll / group 三种事件流（见 @spectrum-ts/imessage 的
 * provider 初始化），chat 事件压根没进它的门，所以背景变更**到不了**我们手上。
 * chatbg.js 因此另开一条 @photon-ai/advanced-imessage/grpc 连接，
 * `chats.subscribeEvents()` 直接问 Photon 要。
 *
 * 代价是这条线路会多一个常驻连接，所以默认关、且只认云端模式
 * （本地 Mac provider 没有 IssueImessageTokens 那套铸币流程，连不上）。
 *
 * 起不起来都不影响主连接 —— 失败了只记一行日志，背景提示没有而已。
 */
function startBgWatcher(getConfig, runner, project) {
  if (runner.mode !== "cloud") {
    if (roleWantsChatBg(getConfig, runner) && !runner.bgLocalWarned) {
      // 只说一次：这个函数现在每次保存配置都会走一遍（见 syncWatchers），
      // 每次都喊一句的话本地模式的用户改一次设置就多一行重复警告
      runner.bgLocalWarned = true;
      logWarn(scopeOf(runner, "背景"), "本地 Mac 模式拿不到聊天背景变更，这个开关先不起作用");
    }
    return;
  }
  if (!roleWantsChatBg(getConfig, runner)) return;
  // 已经有了、或者正在建 —— 别起第二条
  if (runner.bgWatcher || runner.bgWatcherStarting) return;
  runner.bgWatcherStarting = true;

  watchChatBackground({
    projectId: project.projectId,
    projectSecret: project.projectSecret,
    // 角色名，不是拼好的前缀 —— watchChatBackground 会自己拼成「聊天背景·Nero」。
    // 传 scopeOf(...) 会拼两遍，同 startPollWatcher 那边的注释
    label: runner.label ?? "",
    onChanged: ({ kind, peerKey, chatGuid }) => {
      if (runner.stopped) return;
      // 归一不出来就只是不知道是谁换的 —— 记一笔日志，别硬塞给某个人
      if (!peerKey) {
        logDebug(scopeOf(runner, "背景"), `${chatGuid} 背景变了，但认不出对面是谁，忽略`);
        return;
      }
      runner.bgPending.set(peerKey, { kind, at: Date.now() });
      logInfo(scopeOf(runner, "背景"), `对方（${peerKey}）${kind === "removed" ? "移除了" : "换了"}聊天背景，等价下一条消息一起送进去`);
    },
  })
    .then((watcher) => {
      runner.bgWatcherStarting = false;
      /*
       * 订阅起得来的话 watchChatBackground 是立刻返回的，真正断线由它自己退避重连；
       * 但 await 期间这条连接可能被停掉、或者用户又把开关关回去了（现在开关是
       * 热生效的，见 syncWatchers），这两种都得把刚建好的这条收掉，别留野订阅。
       */
      if (runner.stopped || !roleWantsChatBg(getConfig, runner)) {
        watcher.stop();
        return;
      }
      runner.bgWatcher = watcher;
    })
    .catch((e) => {
      runner.bgWatcherStarting = false;
      logWarn(scopeOf(runner, "背景"), `聊天背景订阅没起来，这个功能本次连接不可用：${e?.message ?? e}`);
    });
}

/**
 * 停掉「聊天背景变更」的订阅（开关被关掉、或者这条连接要下线了）。
 *
 * 正在建的那条没法在这里停（把手还没拿到），所以只翻牌子 —— 建完的那一刻
 * `.then` 会重新问一次开关，发现关了就自己收掉。
 */
function stopBgWatcher(runner) {
  if (runner.bgWatcher) {
    try {
      runner.bgWatcher.stop();
    } catch {
      /* ignore */
    }
    runner.bgWatcher = null;
  }
  /*
   * 待认领的背景变更一起清掉：开关关了就不该再往模型嘴里塞这句提示。
   * （连接下线走的也是这里，那种情况下清掉的理由见 stopRunner 那边的注释）
   */
  runner.bgPending.clear();
}

/**
 * 当前角色要不要收聊天背景变更提示（角色是绑在项目上的，见 currentRole）。
 *
 * `getConfig()` 要**调**。currentRole 收的是配置对象，而 roleForProject 里做的是
 * `config?.roles ?? []` —— 把函数本身传进去不会报错，只会永远拿不到角色，于是
 * 这个开关恒为假、订阅一次都起不来。1.2.8 就是这么漏的。
 */
function roleWantsChatBg(getConfig, runner) {
  return Boolean(currentRole(getConfig(), runner)?.chatBackground?.enabled);
}

/* ================= 投票 ================= */

/**
 * 「发起投票时那行标题」的压重窗口。
 *
 * 30 秒：投票气泡和那条标题文本是同一个动作产生的，正常间隔在毫秒级；
 * 留这么宽只是为了覆盖推送乱序和慢网。过了就认了 —— 那条文本确实是
 * iMessage 送来的真实消息，宁可让模型看两遍标题，也不能把一条真消息
 * 无限期地吞掉（见 notePollTitle）。
 */
const POLL_TITLE_TTL_MS = 30_000;

/** 一条会话最多攒几个待压的标题。同一个 30 秒窗口里发两个投票已经很离谱了。 */
const POLL_TITLE_MAX = 3;

/**
 * 当前角色开了投票没有（四件事共用一个开关，见 config.js:normalizePoll）。
 *
 * `getConfig()` 要**调** —— 同 roleWantsChatBg，漏了括号这个开关就恒为假。
 */
function rolePollEnabled(getConfig, runner) {
  return Boolean(currentRole(getConfig(), runner)?.poll?.enabled);
}

/**
 * 起「投票」的订阅（只有角色开了这个开关才起）。
 *
 * 和 startBgWatcher 一样是「Spectrum 没给就自己开一条 gRPC」：它的 provider
 * 虽然订阅了 poll 流，但 `toPollDeltaMessages` 只把 voted / unvoted 转成消息，
 * `created` / `optionAdded` 一律扔掉 —— 「对方发起了一个投票，选项有哪几个」
 * 从设计上就到不了我们手上（整个来龙去脉见 poll.js 的文件头）。
 *
 * 代价同样是多一条常驻连接，所以默认关、且只认云端模式。
 * 起不起来都不影响主连接。
 */
function startPollWatcher(getConfig, runner, project) {
  if (runner.mode !== "cloud") {
    // 同 startBgWatcher：这句只说一次，别让每次保存配置都刷一行
    if (rolePollEnabled(getConfig, runner) && !runner.pollLocalWarned) {
      runner.pollLocalWarned = true;
      logWarn(scopeOf(runner, "投票"), "本地 Mac 模式拿不到投票事件，这个开关先不起作用");
    }
    return;
  }
  if (!rolePollEnabled(getConfig, runner)) return;
  if (runner.pollWatcher || runner.pollWatcherStarting) return;
  runner.pollWatcherStarting = true;

  watchPolls({
    projectId: project.projectId,
    projectSecret: project.projectSecret,
    /*
     * 这里给的是**角色名**，不是拼好的前缀 —— watchPolls 自己会拼成
     * 「投票·Nero」。传 scopeOf(...) 进去会拼两遍，日志里出现
     * `[投票·投票·Nero]`。背景那条（startBgWatcher）是同一个毛病。
     */
    label: runner.label ?? "",
    onEvent: (ev) => {
      if (runner.stopped) return;
      // 串进这条会话的处理链：要 await 一次 ensureSpace，不能和正在跑的那一轮抢
      chain(
        runner,
        ev.chatGuid,
        () => handlePollEvent(getConfig, runner, ev),
        "处理投票事件出错"
      );
    },
  })
    .then((watcher) => {
      runner.pollWatcherStarting = false;
      // 同 startBgWatcher：await 期间这条连接被停掉、或者开关又被关回去了的话，
      // 别留野订阅
      if (runner.stopped || !rolePollEnabled(getConfig, runner)) {
        watcher.stop();
        return;
      }
      runner.pollWatcher = watcher;
    })
    .catch((e) => {
      runner.pollWatcherStarting = false;
      logWarn(scopeOf(runner, "投票"), `投票订阅没起来，这个功能本次连接不可用：${e?.message ?? e}`);
    });
}

/**
 * 停掉「投票」的订阅（开关被关掉、或者这条连接要下线了）。
 *
 * 正在建的那条同 stopBgWatcher —— 建完那一刻会自己重问开关。
 */
function stopPollWatcher(runner) {
  if (runner.pollWatcher) {
    try {
      runner.pollWatcher.stop();
    } catch {
      /* ignore */
    }
    runner.pollWatcher = null;
  }
  // 待压的投票标题只在订阅活着的时候有意义（理由见 stopRunner 那边）
  runner.pollTitles?.clear();
}

/**
 * 让这条连接的两条附加订阅（背景 / 投票）对齐当前配置。
 *
 * **为什么要单独来这么一趟**：这两条订阅原来只在 startRunner 里起一次，而
 * `poll.enabled` / `chatBackground.enabled` 都不在 fingerprintOf 里（它只管
 * 「连不连得上」）—— 于是在界面上刚打开投票开关、保存配置时，syncBridges 判定
 * 「保持」，订阅压根没起。发起投票那一侧是每轮现读配置的，照样发得出去，所以
 * 表现成「角色能发投票，但用户投了它看不见、也收不到自己那份选项记录」。
 * 关开关同理：关掉之后那条 gRPC 还挂在那儿收事件，要等到重启桥接才停。
 *
 * 只动该动的：开了没订阅就起，关了有订阅就停，其余原样留着 —— 这里绝不能
 * 无脑先停再起，那样每次保存配置都会把两条常驻连接重建一遍。
 */
function syncWatchers(getConfig, runner) {
  if (runner.stopped || runner.status !== "connected") return;

  const project = (getConfig().projects ?? []).find((p) => p.id === runner.projectRefId);
  if (!project) return;

  if (roleWantsChatBg(getConfig, runner)) startBgWatcher(getConfig, runner, project);
  else stopBgWatcher(runner);

  if (rolePollEnabled(getConfig, runner)) startPollWatcher(getConfig, runner, project);
  else stopPollWatcher(runner);
}

/**
 * 这条会话的 space 对象，三步取。
 *
 * 投票事件是从**另一条** gRPC 流来的，手上只有一个 chatGuid，没有 Spectrum 的
 * space —— 而 enqueue 要 space（这一轮回完话得从它发出去）。
 *
 * 1. 合并窗口里现成的那个（对方刚说过话，最常见）
 * 2. 这个号最近一条入站消息的（同一条会话才算）
 * 3. 现要一个（ensureSpace → platform.space.get，见那边的注释）
 *
 * 三步都不成返回 null，调用方记一句 warn 跳过这次事件。
 */
async function spaceForChat(runner, chatGuid) {
  const inWindow = runner.pending.get(chatGuid)?.space;
  if (inWindow) return inWindow;

  const last = runner.lastSpace;
  if (last?.space && last.spaceId === chatGuid) return last.space;

  return ensureSpace(runner, { space: null }, chatGuid);
}

/**
 * 记下「这个标题刚刚作为投票出现过」，顺手把已经在队列里的那条同名文本删掉。
 *
 * 治的是什么：手机上发起一个投票，iMessage 会**同时**送来两样东西 —— 一个
 * 投票气泡（走 poll.js 那条流）和一条内容就是标题的普通文本消息（走主消息流，
 * 用户日志里那句「收到一轮消息：今晚我要吃什么」就是它）。不管的话模型看到的是
 *
 *   今晚我要吃什么
 *   [系统提示:{{user}}向你发起了一个投票，注释是："今晚我要吃什么"…]
 *
 * 同一句话两遍。两个方向都要覆盖，因为谁先到是不定的：
 *  - 文本**晚到** → 记在 runner.pollTitles 里，等它进来时由 isPollTitleEcho 拦掉；
 *  - 文本**早到** → 这会儿它还在合并窗口的 slot.texts 里（窗口默认几秒还没引爆），
 *    直接从那个数组里摘掉。
 *
 * 窗口已经引爆过的那种（罕见）就认了，见 POLL_TITLE_TTL_MS 的注释。
 */
function notePollTitle(runner, chatGuid, title) {
  const want = String(title ?? "").trim();
  if (!want) return;

  const list = runner.pollTitles.get(chatGuid) ?? [];
  list.push({ title: want, at: Date.now() });
  while (list.length > POLL_TITLE_MAX) list.shift();
  runner.pollTitles.set(chatGuid, list);

  const slot = runner.pending.get(chatGuid);
  if (!slot?.texts?.length) return;
  const kept = slot.texts.filter((t) => String(t ?? "").trim() !== want);
  if (kept.length !== slot.texts.length) {
    logDebug(scopeOf(runner, "投票"), `队列里那条和投票标题一样的文本已摘掉：${want}`);
    slot.texts = kept;
  }
}

/**
 * 这条入站文本是不是刚才那个投票的标题回声。是就该跳过不进队列。
 *
 * 认出来就把记录**消掉**（一条标题只压一次）：对方过一会儿真的又打了一遍
 * 同样的字，那是他自己说的话，该照常送给模型。
 */
function isPollTitleEcho(runner, chatGuid, text) {
  if (!runner.pollTitles.size) return false;
  const now = Date.now();
  // 顺手清过期的。这张表只有发起投票时才写，平时是空的，扫一遍不花钱
  for (const [key, list] of runner.pollTitles) {
    const live = list.filter((it) => now - it.at <= POLL_TITLE_TTL_MS);
    if (live.length) runner.pollTitles.set(key, live);
    else runner.pollTitles.delete(key);
  }

  const list = runner.pollTitles.get(chatGuid);
  if (!list?.length) return false;
  const want = String(text ?? "").trim();
  if (!want) return false;

  const idx = list.findIndex((it) => it.title === want);
  if (idx < 0) return false;
  list.splice(idx, 1);
  if (list.length) runner.pollTitles.set(chatGuid, list);
  else runner.pollTitles.delete(chatGuid);
  return true;
}

/**
 * 一个投票事件落地：存盘 + 拼一句系统提示 + 直接进队列。
 *
 * ── 为什么不像背景变更那样攒着 ──
 *
 * 背景变更和 tapback 都是「存下来等这个人下一条消息」，因为那两件事太轻、
 * 而且对方多半马上就会说话。投票**不能**这么办：对方在投票里点一下之后
 * iMessage 压根不会再发文本消息，攒着就等于永远等不到 —— 角色问了「今晚吃
 * 什么」，就该听见回答。
 *
 * 发起投票那次倒是有一条文本（标题）几乎同时到，但那条恰恰是要被压掉的
 * （见 notePollTitle），更不能指望它来引爆。
 *
 * 连点改主意产生的好几条事件由合并窗口自己收敛成一段，不用额外去抖。
 */
async function handlePollEvent(getConfig, runner, ev) {
  const scope = scopeOf(runner, "投票");
  const config = getConfig();
  const role = currentRole(config, runner);
  // 一路走到这儿才发现开关被关了（改配置不重启桥接的那条路）：静静收手
  if (!role?.poll?.enabled) return;

  const roleKey = memoryKeyFor(role);
  const { kind, chatGuid, peerKey, pollMessageGuid, title, options } = ev;

  /*
   * 先落盘，再说话。
   *
   * 字母 → optionIdentifier 那张表是角色之后投票的唯一凭据，而「说话」这一步
   * 会去打模型、可能几十秒，中间进程完全可能被重启掉。顺序反了的话就会出现
   * 「模型收到了投票、也回了 [vote:B]，但没人知道 B 是哪个 id」。
   */
  if (kind === "created" || kind === "optionAdded") {
    /*
     * title **只在拿到了的时候传**，同下面 voted/unvoted 那一支。
     *
     * 这不是对称性洁癖：Photon 那边投票资源的 title 本来就常常是空的（用户日志里
     * Spectrum 那条 `failed to cache poll / path:["title"] / Too small` 说的就是
     * 这件事，回源问 `polls.get` 拿到的也是空串）。而**角色自己发起的**那些投票，
     * 标题是 sendPollPart 存进去的，只存在我们这份记录里。无条件传的话，对方一
     * 「加选项」就把它洗成空串 —— 接着那句日志就成了「已在「」里投了【X】」，
     * 而 pollHintFor 里那句「注释是：""」也跟着废了。
     */
    putPoll(roleKey, { pollMessageGuid, chatGuid, peerKey, options, ...(title ? { title } : {}) });
    // 标题那条文本的压重登记要在「说话」之前做完 —— 它可能已经在队列里躺着了
    notePollTitle(runner, chatGuid, title);
  } else if (options.length) {
    /*
     * voted / unvoted 也要存：poll.js 在这两种事件上回源补了一张完整的
     * 「id → 文字」表，而**角色自己发起的**那些投票落盘时 optionIdentifier
     * 全是空串（见 sendPollPart）—— 这是唯一能把真 id 填上的时机，不存的话
     * 角色永远投不了自己发起的那个投票，也说不出对方投了哪个。
     *
     * `options.length` 那道判空是必须的：回源失败时 options 是空数组，而
     * putPoll 的 `entry.options ?? prev.options` 拦不住空数组（它不是
     * nullish），会把好好的那份洗成空的。
     *
     * mine / peerKey 那些字段由 putPoll 从上一笔继承，这里不用重复传。
     * title 同理**只在拿到了的时候传** —— 空串不是 nullish，传进去会把存好的
     * 标题洗成空的，那句「注释是：…」就没了。
     */
    putPoll(roleKey, {
      pollMessageGuid,
      chatGuid,
      peerKey,
      options,
      ...(title ? { title } : {}),
    });
  }
  /*
   * 拼提示要用的那份。刚存过就是权威的那份（带 mine），没存过（voted/unvoted
   * 而记录被 MAX_ENTRIES 挤掉了）就退到「这条会话最近那个投票」—— 认不出具体
   * 是哪个也还能说出「他投了一票」。
   */
  const known = findPoll(roleKey, pollMessageGuid) ?? findLatestPoll(roleKey, chatGuid);

  const hint = pollHintFor(kind, ev, known);
  if (!hint) {
    logDebug(scope, `这条投票事件（${kind}）没什么可告诉模型的，跳过`);
    return;
  }

  const space = await spaceForChat(runner, chatGuid);
  if (!space) {
    logWarn(scope, `${chatGuid}：拿不到会话，这条投票提示这次送不进去`);
    return;
  }
  if (runner.stopped) return;

  /*
   * peer 是「对方的地址」，enqueue 拿它当会话槽的 peer。最近一条入站消息上
   * 那个是原样的（大小写、格式和 SDK 一致），对得上就优先用；对不上就拿
   * chatGuid 归一出来的那个当地址 —— 它本身就是个手机号或邮箱。
   */
  const last = runner.lastSpace;
  const peer = last?.peer && peerKeyOf(last.peer) === peerKey ? last.peer : peerKey;

  logInfo(scope, `${hint.replace(/\s+/g, " ")}`);
  enqueue(getConfig, runner, space, chatGuid, { text: hint }, peer);
}

/**
 * 一个投票事件说给模型听是哪一句。
 *
 * 格式是用户定的样板（`[vote:A]` 那个写法和 preset.js 的 poll 子条目、
 * media.js 的 MEDIA_TAG 三处必须一致）。`{{user}}` 留字面量，由
 * prompt.js:applyVars 在拼提示词时替换 —— 和 takeBgHint 一个规矩。
 *
 * 返回空串 = 这条不值得说（认不出选项、或者本来就没上下文）。
 */
function pollHintFor(kind, ev, known) {
  const options = known?.options?.length ? known.options : (ev.options ?? []);

  if (kind === "created") {
    /*
     * 标题**可能是空的**，那就整句不提注释。
     *
     * Photon 送来的 created delta 里 title 经常是空串（标题作为一条普通文本另
     * 走一路进来，见 poll.js 头部），回源也未必补得上。硬拼的话模型会读到
     * `注释是：""` —— 那比不提更糟，它会当成「对方发了个没标题的投票」去演。
     */
    const title = String(ev.title ?? known?.title ?? "").trim();
    if (!options.length) return "";
    return (
      `[系统提示:{{user}}向你发起了一个投票${title ? `，注释是："${title}"` : ""}，` +
      `选项有${renderOptions(options)}。\n` +
      `你可以选择投票，格式：[vote:A]。一次只能投一个选项。\n` +
      `你也可以给这个投票加一个新选项，格式：[poll_add:选项文字]。\n` +
      `你也可以什么都不做，直接回复文字即可]`
    );
  }

  if (kind === "optionAdded") {
    if (!options.length) return "";
    return (
      `[系统提示:{{user}}给刚才那个投票加了个新选项，现在选项有${renderOptions(options)}。\n` +
      `你可以投票（[vote:A]）、也可以再加一个选项（[poll_add:选项文字]），也可以都不做]`
    );
  }

  // voted / unvoted：delta 里只有 optionIdentifier，选项文字得从存下来的那份查
  const idx = options.findIndex((o) => o.optionIdentifier === ev.optionIdentifier);
  const picked = idx >= 0 ? `【${letterFor(idx)}${options[idx].text}】` : "";
  const where = known?.mine ? "在你发起的投票里" : "在那个投票里";

  if (kind === "voted") {
    // 认不出是哪个选项也照样报一句 —— 「他投了票」这件事本身就是信息
    return picked
      ? `[系统提示:{{user}}${where}投了${picked}]`
      : `[系统提示:{{user}}${where}投了一票]`;
  }
  return picked
    ? `[系统提示:{{user}}把${where}投的${picked}撤回了]`
    : `[系统提示:{{user}}把${where}投的票撤回了]`;
}

async function startRunner(getConfig, project, meta, retries = 0) {
  const runner = createRunner(project.id);
  Object.assign(runner, meta);
  runner.mode = project.mode === "local" ? "local" : "cloud";
  runner.fingerprint = fingerprintOf(project);
  runner.linePhone = project.linePhone ?? "";
  // 投递检测要拿它去开 gRPC。本地 Mac 模式没有铸币流程，留空 = 那边不做检测
  runner.projectId = runner.mode === "cloud" ? (project.projectId ?? "") : "";
  runner.projectSecret = runner.mode === "cloud" ? (project.projectSecret ?? "") : "";
  runner.status = "connecting";
  runner.startedAt = new Date().toISOString();
  runner.retries = retries;
  runners.set(project.id, runner);

  const scope = scopeOf(runner, "桥接");
  const platformId = runner.mode === "local" ? "local_imessage" : "imessage";
  logInfo(scope, `正在启动（${runner.mode === "cloud" ? "云端 Photon" : "本地 Mac"}）…`);

  try {
    const { Spectrum } = await import("spectrum-ts");
    let providers;

    if (runner.mode === "cloud") {
      const { imessage } = await import("@spectrum-ts/imessage");
      providers = [imessage.config()];
      // 留着这个「窄化器」：`imessage(instance).space.get(id)` 能按 chat GUID
      // 现造一个 space，重启后主动消息就是靠它接着数的（见 ensureSpace）
      runner.platform = imessage;
    } else {
      const { localIMessage } = await import("@spectrum-ts/imessage-local");
      providers = [localIMessage.config()];
      runner.platform = localIMessage;
    }

    const opts =
      runner.mode === "cloud"
        ? { projectId: project.projectId, projectSecret: project.projectSecret }
        : {};

    const instance = await Spectrum({ ...opts, providers });

    // 起的过程中被 stopBridge 了：把刚建好的实例收掉，别留个野连接
    if (runner.stopped) {
      try {
        await instance.stop();
      } catch {
        /* ignore */
      }
      return runner;
    }

    runner.instance = instance;
    runner.status = "connected";
    runner.error = null;
    // 连上了就把退避清零：下一次万一再挂，从 5 秒重新起步，
    // 而不是接着上次那个已经涨到 5 分钟的间隔慢慢等
    runner.retries = 0;
    runner.nextRetryAt = null;
    logInfo(
      scope,
      project.linePhone
        ? `已连接，等消息中（线路号码 ${project.linePhone}）`
        : "已连接，等消息中"
    );

    startBgWatcher(getConfig, runner, project);
    startPollWatcher(getConfig, runner, project);

    /*
     * 探一下这条线路的号码有没有真的注册成 iMessage。
     *
     * 「连上了但收不到消息」里最隐蔽的一种就在这儿 —— 号码分配了、连接也起来了，
     * 但它没在 iMessage 上激活，于是对方发的是绿色短信、根本不进这条线路。
     * 光看「已连接」是看不出来的，所以连上就问一句，把它变成控制台里的一行。
     *
     * 不 await：探活要走一次 gRPC，不该拖住消息循环开始接消息。
     * 里面自己兜住所有异常，探不出来只记 debug。
     */
    void checkLineRegistered({
      projectId: runner.projectId,
      projectSecret: runner.projectSecret,
      label: scopeOf(runner, "投递"),
      linePhone: project.linePhone ?? "",
    });

    // 重启前排着的主动消息接着数 —— 这一步就是「关机不清计时器」
    rehydrateProactive(getConfig, runner);

    /*
     * 还没人收、也还没提醒过的转账同理接着数。
     *
     * 这是「只提醒一次」跨重启成立的另一半：`reminded` 为真的那几笔在这儿被滤掉，
     * 所以重启多少次都只有那一次（见 rehydrateTransferReminders）。
     */
    rehydrateTransferReminders(getConfig, runner);

    (async () => {
      try {
        for await (const [space, message] of instance.messages) {
          /*
           * 「这条消息拆完了」的收尾，**声明在 try 外面**：下面 catch 里也要调
           * （拆到一半崩了同样得放掉合并窗口），而 try 块里的 const 在 catch 里
           * 是看不见的。还没占过窗口就崩的情况留 null，那时候压根没东西要放。
           */
          let doneUnpacking = null;
          try {
            if (runner.stopped) break; // 这条连接已经被换掉了
            if (message.direction === "outbound") continue; // 忽略自己发的
            if (message.platform !== platformId) continue; // 非当前 provider
            if (message.id && runner.seen.has(message.id)) continue; // 去重

            const spaceId = message.space?.id ?? message.sender?.id ?? "unknown";
            // 对方的规范地址（E.164 手机号或 iMessage 邮箱）。会话 ID 拿它当后缀
            const peer = message.sender?.id ?? "";

            /*
             * 这条消息在路上走了多久。
             *
             * 排查「对方说他早就发了，我们这边怎么才收到」时，光看我们自己的
             * 日志时间戳是分不清两种情况的：
             *
             *   a) 对方 3 分钟前就发了，推送刚到 —— 慢在 Photon / iMessage 那头
             *   b) 推送早到了，我们处理慢 —— 慢在我们这头
             *
             * 实机撞到过一次：对方 15 分发的一段 2MB 视频，18 分才进日志，而从
             * 推送到达到攒批完成全程只花了几毫秒（也就是 a）。当时这条差完全没
             * 记录，只能靠比对两头的表才看出来。
             *
             * `dateCreated` 是消息在对方设备上建立的时刻，`isDelayed` 是 Apple
             * 自己标的「这条是延迟送达的」。只在差得明显（超过 30 秒）时才打一行，
             * 正常消息不占日志。
             */
            const bornAt = message.dateCreated ? new Date(message.dateCreated).getTime() : 0;
            const lagMs = bornAt ? Date.now() - bornAt : 0;
            if (lagMs > 30000 || message.isDelayed) {
              logInfo(
                scope,
                `这条消息在路上走了 ${Math.round(lagMs / 1000)}s` +
                  `（对方发出时间 ${new Date(bornAt).toLocaleTimeString("zh-CN")}` +
                  `${message.isDelayed ? "，Apple 标了延迟送达" : ""}）—— ` +
                  `慢在网络或 Photon 那头，不是这边处理慢`
              );
            }

            /*
             * 记下「现在能往哪儿发消息」。
             *
             * 放在这么靠前的位置是有意的：下面已读回执 / 撤回 / tapback 那几个
             * 分支都会 continue，可它们同样证明这个会话是活的、能发东西。
             * armProactive 那次（在这段循环的末尾）记不到它们。
             *
             * 只有 Instagram 那条链路读它 —— 角色在 IG 上评论完想顺手发条短信，
             * 得有个 space 才发得出去。进程刚起来还没收到过消息时它是 null，
             * 那一轮就只发 IG、不发短信（见 igSessionFor）。
             */
            runner.lastSpace = { space, spaceId, peer, at: Date.now() };

            /*
             * 已读回执：对方读了我们发出去的某条消息。
             *
             * provider 把它当成一条 content.type === "read" 的**入站消息**推过来
             * （见 @spectrum-ts/imessage 的 read-receipts.ts），它既不是文本也不是
             * 图片，所以必须拦在下面那个「都不是就跳过」之前，否则整条被吞掉。
             *
             * 只有开了「发送已读回执」的角色才记 —— 用户的规范把这条闸接在
             * 已读相关的功能上；何况本地 Mac 模式压根收不到回执，那边自然退化成
             * 「从不附加已读那句话」。
             */
            if (message.content?.type === "read") {
              if (message.id) noteSeen(runner, message.id);
              const who = currentRole(getConfig(), runner);
              if (who?.leaveOnRead?.receipt) noteProactiveRead(runner, spaceId);
              continue;
            }

            /*
             * 对方撤回：和已读回执一样，是一条没有正文的入站消息，同样要拦在
             * 下面那个「都不是就跳过」之前。要不要告诉模型、告不告诉原文，
             * 全在 handleUserUnsend 里判 —— 那里也写着它为什么现在触发不了。
             */
            if (message.content?.type === "unsend") {
              if (message.id) noteSeen(runner, message.id);
              handleUserUnsend(getConfig, runner, space, spaceId, message, peer);
              continue;
            }

            /*
             * 对方给某条气泡贴了 emoji（tapback）。第三条「没有正文的入站消息」，
             * 同样要拦在下面那个「都不是就跳过」之前。
             *
             * 不当场回一轮，只攒进 reactPending：贴 tapback 太轻了，当场回等于
             * 角色被一个 👍 勾着说话。等这个人下一条真的消息进来时一起送 ——
             * 见 takeReactHints。所以这里 continue，不走队列也不占一轮。
             *
             * 被贴的那条在 content.target 上（是条完整 Message），从它身上抠原文
             * 来指认「哪一句被贴了」。本地 Mac 模式压根收不到 reaction
             * （imessage-local 读到带 reaction 的行直接丢），那边自然就没有这功能。
             *
             * 压 role.reactSend.enabled 这道闸 —— 界面上那个开关管的是整件事
             * （「长按对方的气泡贴一个 emoji；对方贴了什么也会告诉模型」）。
             * 想「只看不发」就开开关、一个 emoji 都不勾：读这一路照常走，
             * 发那一路因为白名单是空的，提示词里根本不会出现（prompt.js）。
             */
            if (message.content?.type === "reaction") {
              if (message.id) noteSeen(runner, message.id);
              const who = currentRole(getConfig(), runner);

              /*
               * 先问一句：贴的是不是一张待收款的转账卡片。
               *
               * **拦在 reactSend 那道闸之前** —— 那道闸管的是「把对方贴的
               * emoji 告诉模型」，收款是另一件事。用户没开「消息回应」不代表
               * 他不想收款，卡在闸后面会让这个功能在大多数角色上悄悄失效。
               *
               * 收款成功了默认只攒一句提示（走和背景变更、tapback 同一条路：
               * 不当场回一轮，等这个人下条真消息进来时一起送）—— 贴个 emoji
               * 收钱太轻了，当场回等于角色被一次点击勾着说话。
               *
               * 角色开了「收款后立刻通知」（transfer.notifyOnClaim，默认关）
               * 就当场起一轮，见下面那个分叉。
               */
              const claimed = await claimTransferOnReact(
                runner,
                who,
                message,
                scopeOf(runner, "转账")
              );
              if (claimed) {
                // 用**那笔存下来的**符号，不读当前配置：告诉模型的金额和卡片上一致
                const money = formatAmount(claimed.amount, claimed.currency);
                const memo = claimed.note ? `（${claimed.note}）` : "";
                const hint = `[系统提示:{{user}}收下了你转的 ${money}${memo}]`;
                /*
                 * 开了「收款后立刻通知」就当场起一轮，否则照旧攒着。
                 *
                 * 立刻那一路走 enqueue 而不是直接 handleTurn：合并窗口正是这儿要的
                 * —— 对方常常贴完表情紧接着就打字过来（「收到啦」），走队列的话这
                 * 两件事并成同一轮，角色只回一次。直接开一轮会先回一句「钱收到了
                 * 吧」，紧接着又为那句「收到啦」回第二轮。
                 *
                 * `message` 不往 item 里放：那是给已读回执用的，而这条 reaction
                 * 不是一条能标已读的消息（它没有正文，对方屏幕上也没有未读）。
                 * 真正的未读在下条消息进来时自然会带上它自己的 message。
                 */
                if (who?.transfer?.notifyOnClaim) {
                  logInfo(scope, "开了「收款后立刻通知」，这就让角色回一句");
                  enqueue(getConfig, runner, space, spaceId, { text: hint }, peer);
                } else {
                  noteReaction(runner, peerKeyOf(peer), "", "", hint);
                }
                continue;
              }

              if (!who?.reactSend?.enabled) {
                logDebug(scope, "这个角色没开「消息回应」，对方贴的 tapback 不告诉模型");
                continue;
              }
              const quoted = clip(
                flattenContent(message.content.target?.content)
                  .map(extractText)
                  .filter(Boolean)
                  .join(" "),
                REACT_QUOTE_MAX
              );
              noteReaction(runner, peerKeyOf(peer), message.content.emoji, quoted);
              logInfo(
                scope,
                `对方给${quoted ? `「${quoted}」` : "一条消息"}贴了 ${message.content.emoji ?? "?"}，先记下，等下条消息一起送`
              );
              continue;
            }

            // group（相册 / 图文混发）和 reply（引用回复）要先摊平，
            // 否则一条 type:"group" 既不是文本也不是图片，整条就被跳过了
            const parts = flattenContent(message.content);
            const imageParts = parts.filter(isImageAttachment);
            const audioParts = parts.filter(isAudioAttachment);
            // 视频。SDK 里没有 type:"video"，只能靠 mime 前缀认 ——
            // 以前这一类过不了任何分类器，一路掉到下面「都不是就跳过」，
            // 对方发了段视频而模型完全不知道（见 isVideoAttachment）
            const videoParts = parts.filter(isVideoAttachment);
            // txt / md / json / docx / pdf。图片、语音、视频上面已经挑走了，
            // 剩下认得出的文件在这儿（见 docread.js:isDocAttachment）
            const docParts = parts.filter(isDocAttachment);
            /*
             * 正文。renderMapsLinks 只动一件事：里头要是有苹果地图的链接，
             * 换成 `[location:地名:坐标]`。
             *
             * 为什么要换：对方长按地图放一个大头针分享过来，这条消息的正文就是
             *
             *   https://maps.apple.com/place?coordinate=22.807250,108.411844
             *     &name=%E5%B7%B2%E6%94%BE%E7%BD%AE%E7%9A%84%E5%A4%A7%E5%A4%B4%E9%92%88&span=…
             *
             * 手机上它渲染成一张地图卡片，人一眼就看懂了；模型收到的却是这么一串
             * 百分号编码，既读不出地名也读不出「这是个位置」。换完之后模型看到的是
             * `[location:已放置的大头针:22.807250,108.411844]` —— 和我们教它**发**
             * 位置用的是同一个写法（preset.js 的 location 子条目），两边对得上。
             *
             * 只在正文上改，不动任何原始数据：这条消息本身、发已读回执、
             * 撤回比对用的还是 message 对象。没有地图链接时原样返回，不花时间。
             */
            const plainText = renderMapsLinks(
              parts.map(extractText).filter(Boolean).join("\n")
            );

            /*
             * 卡片（网易云音乐那种从 app 的 iMessage 扩展里发出来的气泡）。
             *
             * 这种消息**既没有正文也没有附件** —— 内容全压在一个私有 payload 里，
             * Spectrum 认不出来就退化成 unsupported-message，正好撞上下面那句
             * 「都不是就跳过」，结果是对方发了、模型完全不知道。所以在那道门
             * 之前先问一句 card.js：认得出就换成一句系统提示当正文用，模型至少
             * 知道「对方分享了一张网易云音乐的卡片：歌名 · 歌手」。
             *
             * 普通消息身上没有 balloonBundleId，cardHintFor 会立刻返回空串，
             * 不联网也不花时间；只有真碰上卡片才会去底层 gRPC 问一次详情，
             * 所以项目凭据只在云端模式给（本地 Mac 模式没有 Photon 可问）。
             */
            const cardHint = await cardHintFor(message, {
              projectId: runner.mode === "cloud" ? project.projectId : "",
              projectSecret: runner.mode === "cloud" ? project.projectSecret : "",
              label: runner.label,
            });
            const userText = [cardHint, plainText].filter(Boolean).join("\n") || null;

            // 文本、图片、语音、视频、能读的文件都不是（贴纸、位置…）就跳过
            if (
              !imageParts.length &&
              !audioParts.length &&
              !videoParts.length &&
              !docParts.length &&
              !userText
            ) {
              logDebug(scope, `忽略一条 ${message.content?.type ?? "未知"} 类型的消息`);
              continue;
            }

            /*
             * 发起投票时那行标题会作为一条**独立的普通文本消息**再来一次，
             * 在这儿把它吞掉（整个来龙去脉见 notePollTitle）。
             *
             * 位置在去重之后、noteInbound 之前：这条消息对模型来说压根不存在，
             * 也就不该进 `[reply:N]` 那个环形缓冲去占一格。但 noteSeen 照打 ——
             * 同一条消息要是被推送重投一次，别又跑一遍这套判断。
             *
             * 只认纯文本（带附件的不算）：投票标题不会带附件，而一张图配的
             * 文字恰好和标题一样时，那张图绝不能跟着被吞掉。
             */
            if (
              userText &&
              !imageParts.length &&
              !audioParts.length &&
              !videoParts.length &&
              !docParts.length &&
              isPollTitleEcho(runner, spaceId, userText)
            ) {
              if (message.id) noteSeen(runner, message.id);
              logDebug(scope, "这条文本就是刚才那个投票的标题，不重复送给模型");
              continue;
            }

            if (message.id) noteSeen(runner, message.id);

            // 存进环形缓冲：后面 [reply:N] / [reply:原文] 要靠它找回这条
            // Message 对象去调 SDK 的 reply()（见 resolveReplyTarget）。
            // 放在去重之后、快捷指令之前 —— 指令那条虽然不进上下文，但它
            // 确实是对方发出来的一条消息，倒数第 N 条得把它数进去
            noteInbound(runner, spaceId, message, userText ?? "");

            /*
             * 主动消息的计时从**最后一条入站消息**重新算。
             *
             * 放在这里（而不是 handleTurn 里）有两个理由：合并队列会等
             * queueWait 秒，那几秒不该算进「对方多久没回」；快捷指令走的是
             * 另一条路，压根到不了 handleTurn，但它同样说明人还在。
             *
             * space 也顺手存下来：入站消息上这个是现成的，省掉一次
             * `space.get`。拿不到的时候（比如刚重启还没人说话）也不影响 ——
             * 到点会自己去要一个，见 ensureSpace。
             */
            armProactive(getConfig, runner, spaceId, { space, peer, replied: true });

            /*
             * 快捷指令先拦一道，在合并队列**之前**。
             *
             * 不进队列的两个理由：
             *  - 队列会把 queueWait 秒内的消息拼成一条（默认几秒）。指令混进去
             *    就变成「/del 你好」这种四不像，既不是干净的指令也不是干净的聊天。
             *  - 指令要的是立刻生效、立刻回确认，等几秒没有意义。
             *
             * 拦的是**认得出的那几条**（isCommandMessage，和 tryCommand 里
             * 判断的是同一套）。`/` 开头不等于指令：网址、路径 `/Users/me/a.jpg`、
             * 顺手打的 `/ 明天见` 都照常进队列发给模型 —— 把这些劫走的话，
             * 用户发个链接却收到一句「不认识这条指令」，比白花一次生成更糟。
             *
             * 反过来，防相亲的暗号**不带 `/` 也会被拦**（用户要的就是「发出
             * 指定词即可」）。所以这里不能只看 parseCommand ——
             * 那样暗号会被原样送给模型，角色回一句「什么防相亲？」，
             * 要藏的东西反倒被念了出来。
             *
             * 认出来的这条消息**不会进上下文存档**：写存档只发生在 handleTurn
             * 里，而这里 continue 掉了，压根走不到那儿。
             *
             * 只拦纯文本消息：图文混发时那段文字是给识图模型的指令，
             * 不该被当成快捷指令（imageParts / audioParts / docParts 非空就跳过
             * 这里）—— 拖一个文件进来顺手打一句 `/del`，那个文件不该被吞掉。
             */
            if (
              userText &&
              !imageParts.length &&
              !audioParts.length &&
              !videoParts.length &&
              !docParts.length &&
              isCommandMessage(userText)
            ) {
              // 队列里攒着的那一轮先引爆，让它在指令之前跑完（见 flushPending）
              flushPending(runner, spaceId);
              // 串进处理链，别和正在跑的那一轮抢存档（见 handleCommand 的注释）
              chain(
                runner,
                spaceId,
                () => handleCommand(getConfig, runner, space, spaceId, userText, peer),
                "执行快捷指令出错"
              );
              continue;
            }

            /*
             * 提示词协助模式：角色让位之后，这条会话里的话全归工程师。
             *
             * 位置卡在快捷指令**之后**、进队列**之前**，两头都是必须的：
             *
             *  - 在指令之后 → `/提示词协助模式关闭`、`/help`、防相亲暗号照常好使。
             *    放到指令前面的话，用户一进协助模式就再也出不来了。
             *  - 在队列之前 → 合并队列的下游是 handleTurn，那是角色那条路。走到
             *    那儿这句话就写进角色的上下文和存档了，用户要的「协助模式期间
             *    不会计入角色的上下文」当场就破。
             *
             * 附件也一并截走。协助模式只看文字，但图片/语音**绝不能**漏回角色 ——
             * 用户多半正拿着一张 OOC 的截图问「为什么会这样」，这时候角色跳出来
             * 演一段，正是他刚花一条指令想制止的事。
             */
            if (isAssistOn(runner.projectRefId, spaceId)) {
              const extra = imageParts.length + audioParts.length + docParts.length;
              const asked = (userText ?? "").trim();
              if (!asked) {
                if (extra) {
                  logInfo(scope, `协助模式里收到 ${extra} 个附件，没有文字，已挡下`);
                  chain(
                    runner,
                    spaceId,
                    () =>
                      sendSystem(
                        runner,
                        space,
                        "协助模式只看文字。把要问的打出来，附件里的内容可以直接贴过来。",
                        { what: "协助模式的提示" }
                      ),
                    "协助模式的提示发不出去"
                  );
                }
                continue;
              }
              if (extra) logInfo(scope, `协助模式里收到 ${extra} 个附件，只取文字那部分`);
              // 队列里攒着的那一轮先引爆 —— 那是开协助模式之前就该属于角色的话
              flushPending(runner, spaceId);
              chain(
                runner,
                spaceId,
                () => runAssistTurn(getConfig, runner, space, spaceId, asked, peer),
                "协助模式这轮出错"
              );
              continue;
            }

            /*
             * 线下模式：这条会话里的话进的是剧情，不是短信。
             *
             * 位置和协助模式**同一处**（指令之后、合并队列之前），两头的理由
             * 一模一样：在指令之后 → `/关闭线下`、`/小总结`、`/help`、防相亲
             * 暗号照常好使；在队列之前 → 队列下游是 handleTurn，那是线上那条路，
             * 走到那儿这句话就写进角色的上下文存档、还会顺带触发主动消息的
             * 计时器、记忆库钩子、IG 那一摊。
             *
             * **这一整段跳过就等于「线上功能全部停用」**（用户钉死的那条）——
             * 已读不回、撤回、回应、特效、链接卡片、位置、语音、表情包的入口
             * 全都在 handleTurn 里面，不需要各自再加一个判断。
             *
             * 附件一并截走，理由同协助模式：线下只看文字，但图片/语音绝不能
             * 漏回线上那条路 —— 那会让角色在剧情演到一半时突然发一条短信。
             *
             * 按**角色**判（memoryKeyFor），不按会话：线下剧情是跟着角色走的，
             * 一个角色一份存档（`data/offline/index/<roleKey>.json`）。协助模式
             * 那个按「线路 + 会话」判是因为它排查的是这条会话的提示词。
             */
            const offlineRole = currentRole(getConfig(), runner);
            if (offlineRole && isOfflineOn(memoryKeyFor(offlineRole))) {
              const extra = imageParts.length + audioParts.length + docParts.length;
              const said = (userText ?? "").trim();
              if (!said) {
                if (extra) {
                  logInfo(scope, `线下模式里收到 ${extra} 个附件，没有文字，已挡下`);
                  chain(
                    runner,
                    spaceId,
                    () =>
                      sendSystem(
                        runner,
                        space,
                        "线下剧情只看文字。把要做的、要说的打出来就行。",
                        { what: "线下模式的提示" }
                      ),
                    "线下模式的提示发不出去"
                  );
                }
                continue;
              }
              if (extra) logInfo(scope, `线下模式里收到 ${extra} 个附件，只取文字那部分`);
              // 队列里攒着的那一轮先引爆 —— 那是开线下之前就该属于线上的话
              flushPending(runner, spaceId);
              chain(
                runner,
                spaceId,
                () => runOfflineTurnHere(getConfig, runner, space, spaceId, said, peer),
                "线下这轮出错"
              );
              continue;
            }

            /*
             * 从这儿开始是「拆这条消息」：图片、语音、视频、文件、链接。
             * 每一样都要回源下载或者出网抓，都是秒级的。
             *
             * **先把合并窗口占住**：这条会话可能已经有一轮在倒计时了（典型就是
             * 对方先打字、紧接着发图），窗口到点时手上这些东西还没拆完，那一轮
             * 就会只带着文字走 —— 用户报的「LLM 先回了文字、图片过了好一会儿才
             * 发出去」正是这个。占住之后到点也会等，等拆完立刻发。
             *
             * 放和占必须配对，所以下面收尾和 catch 里都调 doneUnpacking()
             * （它自己防重复）。漏放的后果是这条会话的窗口永久挂起，
             * 表现为「这个号从此不说话了」—— 所以宁可多调一次。
             */
            holdPending(runner, spaceId);
            let unpacked = false;
            doneUnpacking = () => {
              if (unpacked) return;
              unpacked = true;
              releasePending(runner, spaceId);
            };

            // 图文混发时两样都要进队列：合并队列会在 queueWait 内攒成一轮，
            // 文字是「看这张图里的字」这种指令时缺一半就答不对
            let imagesSent = 0;
            // 读崩了的图有几张。它也算「这轮收到东西了」—— 见下面 gotSomething
            let failedImages = 0;
            for (const part of imageParts) {
              // 读附件要回源下载（断流会自己重试，见 attachread.js）。
              // 试完还是不行才当没收到这张图
              try {
                const image = await readImage(part, scope);
                logInfo(
                  scope,
                  `收到图片附件${image.name ? `「${image.name}」` : ""}，进队列等识别`
                );
                enqueue(getConfig, runner, space, spaceId, { image, message }, peer);
                imagesSent += 1;
              } catch (e) {
                logError(scope, "读取图片附件失败", e);
                /*
                 * 重试也没救回来时，**得告诉模型这里本来有张图**。
                 *
                 * 以前这儿只记一条日志就完了 —— 那轮发给模型的是「1 条文本 /
                 * 0 张图」，模型压根不知道有过一张图，于是角色答得像对方什么都
                 * 没发（用户报的「识图出 bug」就是这个观感）。图读不到是没办法，
                 * 但「没看见」和「看见了看不清」是两种回法，后者才对得上现实。
                 *
                 * 走 text 进队列，和读文件那一路同一个套路：下游 handleTurn、
                 * 提示词、上下文存档都不用改。`{{user}}` 由 applyVars 换成用户的
                 * 名字（和撤回提示一致，见 handleUserUnsend）。
                 */
                failedImages += 1;
                enqueue(
                  getConfig,
                  runner,
                  space,
                  spaceId,
                  {
                    text: `[{{user}}发来一张图片，但没能加载出来，你看不到内容。别猜图里是什么，就当没看清，可以让对方再发一次或者说说图里是什么。]`,
                    message,
                  },
                  peer
                );
              }
            }

            /*
             * 手写消息 / Digital Touch：把那条气泡的内容取回来，当一张图去识别。
             *
             * 上面 cardHint 那一段已经认出这是什么了，模型也已经收到
             * `[系统提示:{{user}}发来了一条手写消息]`。缺的是**内容** ——
             * 手写消息里那几个字是对方真正说的话，只说「有这么一条」等于把话丢了。
             *
             * 这些气泡**既没有正文也没有附件**（所以走不到上面那个 imageParts
             * 循环），字节压在一个私有 payload 里，只有 Photon 的
             * getEmbeddedMedia 取得到（见 card.js:fetchEmbeddedMedia）。
             *
             * 三道闸，缺一个就一个字节都不取：
             *  - 角色开着 handwriting（默认关，每条这种消息要多打一次识图模型）
             *  - 云端模式（本地 Mac 没这条 RPC）
             *  - 识图模型开着 —— 取回来没人看就是纯浪费。和视频那条路同一个规矩
             *    （见下面 videoOn 那段），现读现判，用户随时可能改配置。
             *
             * **取不到、或者取回来不是图片就什么都不做**，上面那句系统提示照常
             * 生效。Digital Touch 回的到底是静态图还是别的东西我没有实物验过，
             * 这条退路必须留着 —— 别为了多一句描述把已经能用的那句话弄丢。
             */
            const embedKind = embeddedKindOf(message?.balloonBundleId);
            if (embedKind && message.id) {
              const who = currentRole(getConfig(), runner);
              const embedWhat = embedKind === "handwriting" ? "手写消息" : "Digital Touch";
              if (!who?.handwriting?.enabled) {
                logDebug(scope, `收到一条${embedWhat}，但这个角色没开「看手写和 Digital Touch」，不取内容`);
              } else if (runner.mode !== "cloud") {
                logDebug(scope, `收到一条${embedWhat}，本地 Mac 模式取不到它的内容`);
              } else if (!resolveRoleEndpoints(getConfig(), who).vision) {
                logInfo(scope, `收到一条${embedWhat}，但这个角色没启用识图，不取内容`);
              } else {
                const media = await fetchEmbeddedMedia({
                  projectId: project.projectId,
                  projectSecret: project.projectSecret,
                  chatGuid: spaceId,
                  messageGuid: String(message.id),
                  scope,
                });
                const mime = media?.mimeType ?? "";
                if (!media) {
                  logDebug(scope, `这条${embedWhat}的内容没取回来，只给那句系统提示`);
                } else if (!mime.startsWith("image/")) {
                  logInfo(
                    scope,
                    `这条${embedWhat}的内容不是图片（${mime || "没报类型"}），看不了，只给那句系统提示`
                  );
                } else if (media.buffer.length > MAX_IMAGE_BYTES) {
                  logWarn(
                    scope,
                    `这条${embedWhat}的内容有 ${(media.buffer.length / 1024 / 1024).toFixed(1)}MB，超过上限，不识别`
                  );
                } else {
                  // 压小再识别，和 readImage 走的是同一条（压不动时原样退回）
                  const small = await shrinkForVision(media.buffer, {
                    mimeType: mime,
                    name: embedWhat,
                    scope,
                  });
                  logInfo(scope, `取到这条${embedWhat}的内容，进队列等识别`);
                  enqueue(
                    getConfig,
                    runner,
                    space,
                    spaceId,
                    {
                      image: {
                        base64: small.buffer.toString("base64"),
                        mimeType: small.mimeType,
                        name: embedWhat,
                        // 必须用专用提示词：通用那句问的是「描述这张图片」，
                        // 拿它去看手写消息，模型会答「一张蓝色的手写字迹」而不是
                        // 把字读出来（见 config.js 那两个常量）
                        prompt:
                          embedKind === "handwriting"
                            ? DEFAULT_HANDWRITING_PROMPT
                            : DEFAULT_DIGITAL_TOUCH_PROMPT,
                        // 于是模型看到的是「手写消息内容：今晚一起吃饭吗」
                        label: embedWhat,
                      },
                      message,
                    },
                    peer
                  );
                  imagesSent += 1;
                }
              }
            }

            /*
             * 语音条同样进队列。
             *
             * 读附件之外还多一步 ffmpeg 转码（见 readAudio），几十毫秒到一两秒，
             * 在这里同步等着是有意的 —— 队列本来就要等 queueWait 秒，转码顺着
             * 那段时间做完，下游 handleTurn 拿到的就是可以直接上传的字节。
             *
             * 读失败/转码失败都只丢这一条，不影响同一批里的其他内容。
             */
            let voicesSent = 0;
            for (const part of audioParts) {
              try {
                const voice = await readAudio(part, scope);
                enqueue(getConfig, runner, space, spaceId, { voice, message }, peer);
                voicesSent += 1;
              } catch (e) {
                logError(scope, "读取语音附件失败", e);
              }
            }

            /*
             * 视频，同样进队列。
             *
             * ── 关着「看视频」就压根不下载 ──
             *
             * 图片和语音都是先读进来、到 handleTurn 才按 eps.vision / eps.audio
             * 判「这个角色开没开」，视频**不跟这个规矩**。原因是体积：一段视频
             * 15MB 起步，而下载是在消息循环里同步等的（见下面 readVideo 那行），
             * 这几十秒里整条线路的消息全堵在 SDK 缓冲里不动 —— 用户报的
             * 「发视频像卡死了」就是这个。
             *
             * 早年这儿是照图片语音的规矩走的，理由写的是「关着也让模型收到一句
             * 『对方发了段视频但你看不到』」。但那句降级文案是 describeVideos 里
             * **写死的字符串**，压根不需要字节 —— 于是代价是整段下载，换回一句
             * 本来就不要钱的话。所以现在开关关着就在这儿直接兑现那句话。
             *
             * 文案和 describeVideos 那条保持一致（同一件事只该有一种说法）。
             * 走 text 进队列，和读图失败那一路同一个套路：下游 handleTurn、
             * 提示词、上下文存档都不用改。
             *
             * ── 超上限的那条错误要发给模型 ──
             *
             * 和读图失败那一路同一个套路（见上面那段长注释）：只记日志的话，
             * 对方发了个 4K 视频、这边一声不响，角色答得像没收到东西。所以
             * 把原因换成一句模型看得懂的话进队列。**话里不提「20MB」这个数字** ——
             * 那是我们的实现细节，模型转述出来只会让对方莫名其妙；说「太长了」
             * 才是对方能照着做的（重发个短的）。
             */
            let videosSent = 0;
            // 现读现判：用户随时可能改角色配置，不能缓存住这一轮开始那一刻的快照
            const videoOn = videoParts.length
              ? Boolean(resolveRoleEndpoints(getConfig(), currentRole(getConfig(), runner)).video)
              : false;
            if (videoParts.length && !videoOn) {
              logInfo(
                scope,
                `对方发来 ${videoParts.length} 段视频，但这个角色没启用视频识别，不下载`
              );
              enqueue(
                getConfig,
                runner,
                space,
                spaceId,
                {
                  text: `（用户发了 ${videoParts.length} 段视频，但视频识别未启用，你看不到内容）`,
                  message,
                },
                peer
              );
              videosSent += videoParts.length;
            }
            for (const part of videoOn ? videoParts : []) {
              try {
                const video = await readVideo(part, scope);
                logInfo(
                  scope,
                  `收到视频附件${video.name ? `「${video.name}」` : ""}，进队列等识别`
                );
                enqueue(getConfig, runner, space, spaceId, { video, message }, peer);
                videosSent += 1;
              } catch (e) {
                logError(scope, "读取视频附件失败", e);
                videosSent += 1; // 这轮确实要去打模型（下面塞了一句提示），算进去
                enqueue(
                  getConfig,
                  runner,
                  space,
                  spaceId,
                  {
                    text:
                      `[{{user}}发来一段视频，但太大或者没能加载出来，你看不到里面的内容。` +
                      `别猜视频里是什么，就当没看清，可以让对方剪短一点再发或者说说视频里是什么。]`,
                    message,
                  },
                  peer
                );
              }
            }

            /*
             * 文件（txt / md / json / docx / pdf）：抽出正文，当成**一条普通文本**
             * 进队列。
             *
             * 走 text 而不是像图片语音那样自成一路，是因为读文件压根不需要下游
             * 做任何事 —— 抽出来就已经是文字了。当成文本进去，handleTurn、
             * 提示词、上下文存档全都不用改一个字，模型看到的就是「对方发来一个
             * 文件『名字』，内容：…」。`{{user}}` 这个写法和撤回提示一致
             * （见 handleUserUnsend），applyVars 会在拼提示词时换成用户的名字。
             *
             * 读失败只丢这一个文件，同一批里的图片和语音照常处理。
             */
            let docsSent = 0;
            if (docParts.length) {
              const who = currentRole(getConfig(), runner);
              const fileRead = who?.fileRead;
              if (fileRead?.enabled === false) {
                logInfo(
                  scope,
                  `对方发来 ${docParts.length} 个文件，但这个角色没开「读文件」，跳过`
                );
              } else {
                const maxChars = Number(fileRead?.maxChars) || 2000;
                for (const part of docParts) {
                  try {
                    const doc = await readDocument(part, { maxChars, scope });
                    const tail = doc.truncated
                      ? `\n…（后面还有，超出 ${maxChars} 字上限没读）`
                      : "";
                    enqueue(
                      getConfig,
                      runner,
                      space,
                      spaceId,
                      {
                        text: `[{{user}}发来一个文件「${doc.name}」，内容：\n${doc.text}${tail}]`,
                        message,
                      },
                      peer
                    );
                    docsSent += 1;
                  } catch (e) {
                    logError(scope, "读取文件失败", e);
                  }
                }
              }
            }

            /*
             * 这轮到底收到东西没有：下面几处提示要靠它决定兑不兑现。
             *
             * `failedImages` 也算 —— 那张图虽然读崩了，但上面已经往队列里塞了
             * 一句「有张图没加载出来」，这轮**确实**要去打模型。不算的话，
             * 对方只发了一张图（没配文字）而它正好读失败时，gotSomething 是假，
             * 攒着的背景变更和 tapback 提示就白等这一轮了。
             */
            const gotSomething = Boolean(
              imagesSent || failedImages || voicesSent || videosSent || docsSent || userText
            );

            /*
             * 换过背景就先垫一句系统提示。
             *
             * 单独 enqueue 一条、排在正文前面：合并队列会把 queueWait 内的东西
             * 拼成一段文本（slot.texts.join("\n")），所以顺序天然就是「系统提示
             * 在上、用户说的话在下」—— 模型看到的是「对方刚换了背景，然后说了
             * 这句话」，正好是真实发生的顺序。
             *
             * 只在真的收到东西时才垫（imagesSent / voicesSent 记着图片和语音
             * 各成功读出来几条）：用户光换背景没说话，这里压根走不到，提示会
             * 一直躺在 bgPending 里等下一条消息（超过 BG_HINT_TTL_MS 作废）。
             * 这么设计是为了不让角色主动搭话 —— 那是 proactive 该干的事。
             */
            const bgHint = gotSomething ? takeBgHint(runner, peerKeyOf(peer)) : "";
            if (bgHint) {
              enqueue(getConfig, runner, space, spaceId, { text: bgHint, message }, peer);
            }

            /*
             * 攒着的 tapback 也在这儿兑现，规矩和背景变更一模一样：
             * 单独 enqueue、排在正文**前面**，模型看到的顺序是「对方先给你那句话
             * 贴了个 😂，然后说了这句」—— 正好是真实发生的顺序。
             *
             * 同样只在真的收到东西时才兑现：光贴不说话的话这里走不到，
             * 提示躺在 reactPending 里等下一条消息（超过 TTL 作废）。
             */
            const reactHints = gotSomething ? takeReactHints(runner, peerKeyOf(peer)) : [];
            for (const hint of reactHints) {
              enqueue(getConfig, runner, space, spaceId, { text: hint, message }, peer);
            }

            // 不直接请求 LLM，先进合并队列（见 chat.queueWait）。
            // message 一起带上：发已读回执要用原始 Message 对象
            if (userText) {
              /*
               * 对方是引用着某条在说话的话，把被引的那句拼在前面。
               *
               * 不这么做的话模型收到的是一句没头没尾的「我刚刚说我在外面」——
               * flattenContent 只把 reply 的正文摊出来，target 丢掉了。格式和
               * 提示词里教模型写的那个一样（`[reply:原文]正文`），两边对得上，
               * 模型照着学也顺手。放在 isCommandMessage 之后加，免得
               * 「[reply:…]/del」这种引用着发的指令认不出来。
               */
              const quoted = quotedTextOf(message);
              /*
               * 正文里的链接解开成一句人话（见 linkmeta.js）。
               *
               * **只在这一份上做**，不动 userText 本身 —— 上面那几处要的都是原文：
               * 指令识别（`/del` 那道闸）、去重、noteInbound（`[reply:原文]` 要
               * 靠它把这条消息找回来）。补过说明的文本只往队列里去，也就是只给
               * 模型看。
               *
               * 放在这儿而不是 plainText 那一步，还有个好处是**没链接的消息一分钱
               * 不花**：renderLinks 第一行就是「正文里没有 http 就原样返回」。
               * 真有链接时解不开就原样进队列。
               *
               * 带图的链接（抖音）比别的慢一截：解析两个来回 + 下图，实测一条
               * 4 图的图文作品前后 4 秒上下。对方那头看着已读和打字指示器，
               * 这点等待换来「模型真看见了那几张图」，划得来。
               */
              const linkScope = scopeOf(runner, "链接");
              const {
                text: shown,
                images: linkImageUrls,
                videos: linkVideoUrls,
                covers: linkCoverUrls,
              } = await renderLinks(userText, linkScope);

              /*
               * 链接里的视频（抖音视频作品，够短的那些）走识视频那条路。
               *
               * **先看角色开没开视频识别**，没开就一个字节都不下 —— 这和对方
               * 直接发视频那条路的规矩一致（见上面 videoOn 那段）：几 MB 的东西
               * 下回来没人看是纯浪费。现读现判，因为用户随时可能改配置。
               *
               * 放在下图之前，因为下面要的「封面还是视频」取决于这一步的结果。
               */
              const linkVideoOn = linkVideoUrls.length
                ? Boolean(
                    resolveRoleEndpoints(getConfig(), currentRole(getConfig(), runner)).video
                  )
                : false;
              if (linkVideoUrls.length && !linkVideoOn) {
                logInfo(
                  linkScope,
                  `链接里有 ${linkVideoUrls.length} 段视频，但这个角色没启用视频识别，只看封面`
                );
              }
              const linkVideos = linkVideoOn
                ? await fetchLinkVideos(linkVideoUrls, linkScope)
                : [];

              /*
               * 链接里带图的（抖音图文、小红书笔记）把图真下下来，走识图那条路。
               *
               * 视频作品的**封面只在视频没下成的时候**才加进来（角色没开视频
               * 识别、或者下失败了）。视频下到了就不要它 —— 封面是视频第一帧，
               * 视频模型自己看得到，再单独识一次图等于为同一帧画面多打一次模型，
               * 还占掉对方的 maxImages 额度。
               *
               * 不设自己的数量上限：原样全推进队列，由 describeImages 用角色的
               * eps.maxImages 统一截断。这样「对方发了 2 张图 + 一条 4 图抖音」
               * 一轮最多还是 maxImages 张，不会因为一条链接把额度吃光 ——
               * 那边本来就有现成的「超上限截断并在尾巴说明」。
               */
              const wantCovers = linkCoverUrls.length && !linkVideos.length;
              const linkImages = await fetchLinkImages(
                wantCovers ? [...linkImageUrls, ...linkCoverUrls] : linkImageUrls,
                linkScope
              );

              /*
               * 有图但一张都没取到时，在正文里说明一句。
               *
               * 直链带签名和过期时间，下不下来是常态。配文和配乐那部分跟图片
               * 无关、照样补得上，所以只在尾巴补一句「看不见图」——
               * 和 describeImages 没开识图时那句降级文案同一个做法：让模型知道
               * 「有东西但你读不到」，比压根不提好。
               */
              const blind =
                linkImageUrls.length && !linkImages.length
                  ? `（这条链接里有 ${linkImageUrls.length} 张图片，但没能取到，你看不到图的内容）`
                  : "";
              /*
               * 视频没看到时补一句，说清模型手里到底有什么。
               *
               * 两种情况都要说，但说法不同：
               *
               *  - 角色没开视频识别 → 封面进了队列，所以是「只看到封面那一帧」
               *  - 开着但下失败了（风控、超时、码率撞上限）→ 封面**也**跟着补上了
               *    （wantCovers 那一步），所以同样是这句话
               *
               * 真正要让模型知道的是「你手里那张是静止画面，不是整段视频」——
               * 不说的话它会拿一帧当成整段来聊。至于为什么没下到，模型不需要
               * 知道，那是我们的实现细节。
               *
               * 视频作品**没有封面可退**的情况（连封面都没取到）由上面那句
               * `blind` 覆盖，这里不重复说。
               */
              const videoBlind =
                linkVideoUrls.length && !linkVideos.length
                  ? `（这条链接是个视频，但你只能看到封面那一帧，看不到视频里的动态内容和声音）`
                  : "";
              const body = `${shown}${blind}${videoBlind}`;
              const text = quoted ? `[reply:${quoted}]${body}` : body;
              enqueue(getConfig, runner, space, spaceId, { text, message }, peer);
              for (const image of linkImages) {
                enqueue(getConfig, runner, space, spaceId, { image, message }, peer);
              }
              for (const video of linkVideos) {
                enqueue(getConfig, runner, space, spaceId, { video, message }, peer);
              }
            }

            /*
             * 文字效果的提示排在正文**之后** —— 这是用户给的样板定死的顺序：
             *
             *   user：晚安噢$我爱你
             *   system：[系统提示:{{user}}对"我爱你"这段文字使用了…效果。]
             *
             * 想想也对：得先看见那句话，「对『我爱你』这段文字」才有所指。
             * 贴纸提示反过来排在前面，因为它说的是**上一轮**那句话。
             *
             * 没带任何效果时 effectHintOf 返回空串，这里就不占一条 —— 绝大多数
             * 消息都是这种，不能让每条消息后面都拖一句废话。
             */
            const effectHint = userText ? effectHintOf(message, scope) : "";
            if (effectHint) {
              enqueue(getConfig, runner, space, spaceId, { text: effectHint, message }, peer);
            }

            /*
             * 这条消息拆完了，放掉窗口。要是它是在**到点之后**才拆完的，
             * 这一句就是那一轮真正的引爆点（见 releasePending）。
             *
             * 放在这儿而不是 finally 里：这样顺序是「这条消息的东西全进队列了，
             * 然后才放」。放在 finally 里也对，但下面那个 catch 已经兜住了异常，
             * 两处各调一次更看得出「正常走完」和「崩了也要放」是两件事。
             */
            doneUnpacking();
          } catch (err) {
            logError(scope, "处理消息出错", err);
            // 拆到一半崩了也得放，不然这条会话的合并窗口就永久挂起了。
            // 还没走到 holdPending 就崩的（过滤、取 spaceId 那一段）这里还是
            // null，`?.` 正好跳过 —— 那时候压根没占过窗口
            doneUnpacking?.();
          }
        }
      } catch (err) {
        if (runner.stopped) return; // 主动停掉时流会断，这不算错
        logError(scope, "消息流断了", err);
        runner.status = "error";
        runner.error = err?.message ?? String(err);
        scheduleRetry(getConfig, runner, err);
      }
    })();
  } catch (err) {
    logError(scope, "启动失败", err);
    runner.status = "error";
    runner.error = err?.message ?? String(err);
    scheduleRetry(getConfig, runner, err);
  }
  return runner;
}

/**
 * 挂了之后自己爬起来。
 *
 * 这个函数存在的全部理由是：`syncBridges` 只在「保存配置 / 登记号码 /
 * 手点重连 / 进程启动」时跑，没有任何定时器。以前一条连接失败之后就以
 * `status:"error"` 留在表里等着 —— 而那四件事都要用户动手，所以开机时
 * 网络还没通导致的那一下 `fetch failed`，会让桥接永久躺平，界面上一直红着。
 *
 * 三条边界：
 *  - **停掉的不重试**（`runner.stopped`）：stopRunner 已经把它从表里摘了，
 *    再起一条就是野连接。
 *  - **被换掉的不重试**：定时器到点时先看 `runners.get(id)` 还是不是自己，
 *    不是就说明中途已经有人重启过（用户点了重连、或者改了凭据），
 *    那条新的连接归它自己管。
 *  - **配置里已经没有它了就不重试**：角色解绑、项目删掉、凭据被清空之后
 *    这条号码本来就不该在线，`syncBridges` 会顺手把它停掉。
 *
 * 重试成功与否由 `startRunner` 自己决定：连上就清零，再挂就再排一次，
 * 次数一路往上加，间隔按 RETRY_DELAYS 走到 5 分钟封顶。
 */
function scheduleRetry(getConfig, runner, err) {
  if (runner.stopped) return;
  if (runner.retryTimer) clearTimeout(runner.retryTimer);

  const tries = (runner.retries ?? 0) + 1;
  runner.retries = tries;
  const wait = RETRY_DELAYS[Math.min(tries - 1, RETRY_DELAYS.length - 1)];
  runner.nextRetryAt = new Date(Date.now() + wait).toISOString();

  const scope = scopeOf(runner, "桥接");
  logWarn(
    scope,
    `连接失败第 ${tries} 次，${Math.round(wait / 1000)} 秒后自己重试`,
    err?.stack ?? String(err ?? "")
  );

  runner.retryTimer = setTimeout(() => {
    runner.retryTimer = null;
    runner.nextRetryAt = null;
    // 这期间被停掉 / 被换成另一条连接了，就不归这次重试管了
    if (runner.stopped) return;
    if (runners.get(runner.projectRefId) !== runner) return;

    const config = getConfig();
    const project = (config.projects ?? []).find((p) => p.id === runner.projectRefId);
    const role = project ? roleForProject(config, project.id) : null;
    if (!project || !role || !projectReady(project)) {
      logInfo(scope, "配置里已经不需要这条连接了，停止重试");
      runner.status = "idle";
      runner.error = null;
      runners.delete(runner.projectRefId);
      return;
    }

    logInfo(scope, `第 ${tries} 次自动重连…`);
    // 旧的这条已经没有 instance 了（起都没起来），直接换一个新 runner 上去。
    // 标记 stopped 是为了万一它那个消息循环还活着，认得出自己已经过期
    runner.stopped = true;
    void startRunner(
      getConfig,
      project,
      {
        roleId: role.id,
        roleName: role.name,
        label: projectLabel(config, project.id),
        linePhone: project.linePhone ?? "",
      },
      tries
    ).catch((e) => logError(scope, "自动重连出错", e));
  }, wait);

  // 这个定时器不该拖着进程不让退出（Ctrl+C 时还有一个 5 分钟的在排队）
  runner.retryTimer.unref?.();
}

/** 停掉一条连接，清干净它的定时器。 */
async function stopRunner(runner) {
  runner.stopped = true;
  // 清掉未触发的合并定时器，避免桥接停掉后还去发消息
  for (const slot of runner.pending.values()) {
    if (slot.timer) clearTimeout(slot.timer);
    /*
     * 攒在队列里的视频字节要撒手。
     *
     * 这一批消息永远不会被处理了（定时器刚撤掉，下面整张表也清了），所以
     * describeVideos 那个 finally 不会执行。一段视频是 27MB 的 base64，
     * 而停连接恰恰是会连着发生好几次的操作 —— 改一次配置 syncBridges 就把
     * 所有号码停掉重连一遍。
     */
    for (const v of slot.videos ?? []) v.release?.();
  }
  runner.pending.clear();

  /*
   * 主动消息的表同理 —— 这条线路都下线了，那个定时器揣着的 space 已经失效。
   *
   * 只清内存，**硬盘上那份原样留着**：这正是「重启/关机不清计时器」的落点。
   * 下次这条线路连上，rehydrateProactive 会把它们捞回来接着数。真要撤表走的
   * 是 disarmProactive（用户关了开关），那边才会连硬盘上那行一起删。
   */
  for (const slot of runner.proactive.values()) {
    if (slot.timer) clearTimeout(slot.timer);
  }
  runner.proactive.clear();

  // 排着队的自动重连也要撤掉，否则「停掉的号码」几分钟后自己又连回来了
  if (runner.retryTimer) {
    clearTimeout(runner.retryTimer);
    runner.retryTimer = null;
  }
  runner.nextRetryAt = null;

  /*
   * 背景订阅是另一条 gRPC 连接，不跟着 instance.stop() 走 —— 不显式停掉的话
   * 这条线路下线了，它还揣着 projectSecret 在那儿替它收事件。投票那条同理。
   *
   * 这两个函数顺手把各自的待认领数据也清了（bgPending / pollTitles）：待压的
   * 投票标题只活在这一次连接里，留着的话重连后第一条恰好同名的真消息会被莫名
   * 吞掉（磁盘上那份投票记录不受影响，照旧能投）。
   *
   * `stopped` 已经在上面置过了，所以正在建的那两条订阅建完也会自己收掉。
   */
  stopBgWatcher(runner);
  stopPollWatcher(runner);
  // 待认领的 tapback 同理：这条线路都停了，重连后再补报一句「刚才给你贴了个👍」
  // 只会莫名其妙
  runner.reactPending.clear();

  /*
   * 「一直没人收」的提醒排期：和主动消息那张表同一个处理 —— **只清内存**。
   *
   * 磁盘上那几笔原样留着（`state` 还是 pending、`reminded` 还是假），下次这条线路
   * 连上，rehydrateTransferReminders 会把它们捞回来接着数。这里要是顺手把
   * `reminded` 钉上，那就成了「停一次连接等于取消一次提醒」——而改配置
   * （syncBridges）就会停所有连接。
   */
  for (const timer of runner.transferRemind?.values() ?? []) clearTimeout(timer);
  runner.transferRemind?.clear();

  if (runner.instance) {
    try {
      await runner.instance.stop();
    } catch {
      /* ignore */
    }
    logInfo(scopeOf(runner, "桥接"), "已停止");
  }
  runner.instance = null;
  runner.platform = null;
  runner.status = "idle";
  runners.delete(runner.projectRefId);
}

/**
 * 让实际连接对齐配置。
 *
 * 该在线的项目 = 绑定了角色 且 凭据齐全。和现有 runner 做差集：
 * 缺的启动、多的停掉、凭据/模式变了的重启。
 *
 * 关键在于「只动该动的」：保存角色 A 的人设不该把角色 B 的号码踢下线。
 *
 * @returns {Promise<{started:string[], stopped:string[], restarted:string[], kept:string[]}>}
 */
export async function syncBridges(getConfig) {
  const config = getConfig();
  const projects = config.projects ?? [];

  const want = new Map(); // projectRefId -> { project, meta }
  // IMESSAGE_BRIDGE=off 时 want 留空：现有连接会被停掉，也不会起新的。
  // 放在这里而不是只挡启动流程 —— 否则 /api/imessage/restart 会绕过开关，
  // 在本该完全离线的进程里连上真实线路。
  const disabled = process.env.IMESSAGE_BRIDGE === "off";
  for (const project of disabled ? [] : projects) {
    const role = roleForProject(config, project.id);
    if (!role) continue; // 没绑角色的项目不上线：没人回话
    if (!projectReady(project)) continue; // 凭据不全，连不上
    want.set(project.id, {
      project,
      meta: {
        roleId: role.id,
        roleName: role.name,
        label: projectLabel(config, project.id),
        linePhone: project.linePhone ?? "",
      },
    });
  }

  const result = { started: [], stopped: [], restarted: [], kept: [] };

  // 1. 不该在线的：停掉
  for (const runner of [...runners.values()]) {
    if (!want.has(runner.projectRefId)) {
      await stopRunner(runner);
      result.stopped.push(runner.projectRefId);
    }
  }

  // 2. 该在线的：起新的 / 重启凭据变了的 / 其余原样留着
  for (const [id, { project, meta }] of want) {
    const runner = runners.get(id);
    if (!runner) {
      await startRunner(getConfig, project, meta);
      result.started.push(id);
      continue;
    }

    const changed = runner.fingerprint !== fingerprintOf(project);
    const broken = runner.status === "error";
    if (changed || broken) {
      await stopRunner(runner);
      await startRunner(getConfig, project, meta);
      result.restarted.push(id);
      continue;
    }

    // 连接不用动，但显示信息（角色名、线路号）可能变了
    Object.assign(runner, meta);
    /*
     * 连接不用动 ≠ 什么都不用动：背景 / 投票那两条**附加订阅**是照开关起的，
     * 而开关不在 fingerprintOf 里（它只管连不连得上）。不在这儿对齐一次的话，
     * 刚在界面上打开投票开关、保存配置，走的就是这条「保持」分支 —— 订阅压根
     * 没起，于是角色发得出投票、却收不到用户投的那一票（见 syncWatchers）。
     */
    syncWatchers(getConfig, runner);
    result.kept.push(id);
  }

  /*
   * 主动消息表里的死行清一清：项目被删了，它名下那几条会话再也不会有人
   * 来撤，留着只会一次次被 rehydrateProactive 捞出来。
   *
   * 比的是**配置里还有没有这个项目**，不是「这次该不该上线」—— 没绑角色、
   * 凭据填了一半、IMESSAGE_BRIDGE=off，都是暂时的，不该顺手把用户排了
   * 几小时的表抹掉。
   */
  pruneSchedule(projects.map((p) => p.id));

  // 协助模式那张表同理：项目没了，那几行永远不会有人来关
  pruneAssist(projects.map((p) => p.id));

  const parts = [
    result.started.length ? `启动 ${result.started.length}` : "",
    result.restarted.length ? `重启 ${result.restarted.length}` : "",
    result.stopped.length ? `停止 ${result.stopped.length}` : "",
    result.kept.length ? `保持 ${result.kept.length}` : "",
  ].filter(Boolean);
  logInfo(
    "桥接",
    disabled
      ? "IMESSAGE_BRIDGE=off，这个进程不连任何号码"
      : `连接已对齐配置：${parts.join(" / ") || "无需变动"}`
  );

  return result;
}

/**
 * 重启指定项目的连接（不带参数就全部重启）。
 * 前端「重启桥接」按钮用。
 */
export async function restartBridges(getConfig, projectRefId) {
  if (projectRefId) {
    const runner = runners.get(projectRefId);
    if (runner) await stopRunner(runner);
  } else {
    await stopAllBridges();
  }
  return syncBridges(getConfig);
}

/** 停掉指定项目的连接。 */
export async function stopBridge(projectRefId) {
  const runner = runners.get(projectRefId);
  if (runner) await stopRunner(runner);
}

/** 全部停掉。 */
export async function stopAllBridges() {
  await Promise.all([...runners.values()].map((r) => stopRunner(r)));
}