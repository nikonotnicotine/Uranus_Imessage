/**
 * 模型接口的统一出口。
 *
 * 几个用途共用这里的代码：
 *  - 聊天（主 API 失败自动退到备用 API）
 *  - 测试连接 / 拉模型列表（前端 API 面板那两个按钮）
 *  - 识别图片（把用户发的图转成一段文字描述）
 *  - 识别语音（把用户发的语音条转成一段文字）
 *
 * 除了最后一条，全都打 OpenAI 兼容的 `/chat/completions`。听音那条是例外：
 * OpenAI 那个 `input_audio` 字段实测没有一家中转站往上游透传，只能走
 * Gemini 原生的 `/v1beta/models/{model}:generateContent`，见 transcribeAudio。
 *
 * 所有请求都会往日志中枢写一条，前端控制台能看到打给了哪条线、花了多久、
 * 失败时上游到底回了什么。
 */

import { logDebug, logError, logInfo, logWarn } from "./logs.js";
import { DEFAULT_AUDIO_PROMPT, DEFAULT_VIDEO_PROMPT, DEFAULT_VISION_PROMPT } from "./config.js";
import { fetchVia, netCodes, whyNetwork } from "./proxy.js";

const REQUEST_TIMEOUT = 60000;
const TEST_TIMEOUT = 30000;
/**
 * 聊天单独一档，比 REQUEST_TIMEOUT 宽得多。
 *
 * 60 秒这个默认值是照「一问一答的纯文本」定的，但真实用法早就不是了：
 * 用户会拿 Claude 的 thinking 档当聊天模型，那种模型思考两三分钟才吐第一个
 * 字是正常的，不是卡住；上下文里还带着世界书、记忆库和几十条上文，光让上游
 * 读完就要时间。
 *
 * 超时的代价在聊天这条路上格外难看：这一轮直接判失败 → 跳副 API 再花一次
 * 钱、再等一遍 → 两边都超时就给对方发一句「出错了」。而模型可能只是还在想。
 * 宁可让对方多等一会儿（iMessage 那边一直显示「正在输入」），也比白丢一轮好。
 *
 * 300 秒的上限仍然有意义 —— 上游把连接吊死不回的情况是真的存在，
 * 总得有个头，否则这条会话的处理链会被一个永远不返回的请求堵住。
 */
const CHAT_TIMEOUT = 300000;
/**
 * 识图单独给更长的超时。
 *
 * 一张图 base64 之后能有好几 MB，光把请求体传上去就要几十秒 —— 和一次纯文本
 * 请求共用 60s 太紧，网络稍微抖一下就整轮失败。
 */
const VISION_TIMEOUT = 180000;

/**
 * 重试等待（毫秒）。数组长度 = 最多补打几次。
 *
 * 前两档短，是给「网络抖一下」用的 —— TCP 连接超时、被掐断这类，几百毫秒后
 * 再打一次通常就过去了。
 *
 * 第三档 15 秒是给**上游容量耗尽**用的（503 MODEL_CAPACITY_EXHAUSTED）。
 * 原来只有前两档，三次请求全挤在 3.3 秒内打完：容量不够的时候 3 秒后照样
 * 不够，等于白打两次然后报错。热门模型（Claude 的 thinking 档尤其）的容量
 * 是一阵一阵放出来的，隔十几秒再问一次，成功率完全不一样。
 *
 * 代价是最坏情况多等 15 秒。这三条链（聊天、记忆库、主动消息）都不是
 * 「用户盯着按钮等」的场合 —— 真正盯着的「测试连接」传 retries: 0，
 * 压根不走这个数组。
 */
const RETRY_DELAYS = [800, 2500, 15000];

/**
 * 错误摘要里最多带多少字上游原文。
 *
 * 这个上限只管**摘要**那一句（它会发成短信），不管日志 —— 失败时完整的
 * 响应体会原样记进日志的 detail，见 logUpstreamFailure。原来是 300，
 * 中转站把真正的原因写在后面时就被切掉了，用户看到的是一句半截话。
 */
const UPSTREAM_DETAIL_MAX = 1200;

/**
 * 这个错误值不值得重试。
 *
 * 只重试「再打一次可能就好了」的：连不上、超时、被掐断、以及上游的
 * 429/500/502/503/504。密钥错、模型名错、请求体不合法这类重试一百次也一样，
 * 白等而已。
 *
 * **错误码用 netCodes 挖**（不是 `error.cause.code`）。这不是讲究：原来只挖
 * 一层，于是 `AggregateError`（IPv6 / IPv4 都连不上时 Node 抛的那种，具体原因
 * 在 `errors[]` 里）整个读不到码，一律被当成「不值得重试」—— 一次本该自动
 * 重试就过去的连接抖动，变成了当场换副 API、甚至整轮失败。
 */
function isTransient(status, error) {
  if (status) return status === 429 || (status >= 500 && status <= 504);
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return true;
  // netCodes 排过序，但这里是「有没有一条值得重试」，所以全看一遍
  const codes = netCodes(error);
  if (
    codes.some(
      (c) =>
        c === "UND_ERR_CONNECT_TIMEOUT" ||
        c === "UND_ERR_SOCKET" ||
        c === "ECONNRESET" ||
        c === "ECONNREFUSED" ||
        c === "ETIMEDOUT" ||
        c === "EPIPE" ||
        c === "EAI_AGAIN" // DNS 临时故障（ENOTFOUND 是真打错了，不重试）
    )
  ) {
    return true;
  }
  return /Connect Timeout/i.test(error?.cause?.message ?? "");
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 「用户自己按停的」这一句。
 *
 * 单独拎出来是因为它要被三处认出来：`chatWithFallback` 靠 `err.aborted` 决定
 * **不换线**（按停了就是按停了，不是主 API 坏了）、路由靠它把这轮记成「用户
 * 取消」而不是故障、前端靠「按停」这两个字在错误条旁边挂一个「再来一次」。
 */
export const ABORTED_MESSAGE = "这次生成被你按停了";

function abortedError() {
  const err = new Error(ABORTED_MESSAGE);
  err.aborted = true;
  return err;
}

/** 去掉末尾斜杠，避免拼出 //chat/completions。 */
function trimBase(url) {
  return String(url ?? "").trim().replace(/\/+$/, "");
}

/* ================= Gemini 3.7 / 3.8 的两条硬规矩 ================= */

/**
 * 这两个版本比别的模型多两条限制（实测）：
 *
 * 1. **消息数组不能以 assistant 结尾**，上游直接回 400
 *    `Requests ending with a model turn are not supported.`
 *    也就是「预填」（prefill）这套玩法在这两个版本上整个不支持。
 *    注意「结尾」是**跳过 system 之后**的结尾：中转站会把所有 system 提走当
 *    `systemInstruction`，剩下的才是 Gemini 眼里的 contents。所以
 *    `[…, assistant, system]` 在我们这边看着不以 assistant 结尾，到了上游
 *    照样挨这个 400 —— 见 moveModelTail。
 * 2. **生成参数一个都不能带**：temperature / top_p / top_k /
 *    frequency_penalty / presence_penalty，带上就报错。
 *
 * 3.1、2.5 和别家的模型都没这两条 —— 预填在它们身上是正常功能，预设里那条
 * 「卡思维链（预填）」就是为它们写的。所以只能按模型名认人，不能一刀切。
 *
 * 认名字而不是让用户手动勾一个开关：中转站的模型名前面挂着分组标签
 * （`逆[Ag1-次-0.02￥]gemini-3.8-flash-high`），但 `gemini-3.8` 这截总在里面。
 */
const GEMINI_STRICT = /gemini[^0-9]{0,4}3[._-][78](?![0-9])/i;

/**
 * 把消息数组的 assistant 尾巴挪走，返回改过的数组（本来就不以 assistant
 * 结尾时原样返回）。
 *
 * 预填的正文**不扔掉**，改挂到 user 名下 —— 预填那个效果是保不住的（上游
 * 不支持），但正文里写的格式要求还是让模型看到，比直接丢掉强。前面紧跟着
 * 就是 user 的话并进那条，避免发出两条连着的 user。
 *
 * ── 为什么要先跳过尾部的 system ──
 *
 * 上游判的不是「数组以 assistant 结尾」，是「**contents** 以 model turn 结尾」，
 * 而 system 压根不在 contents 里（被提走当 systemInstruction 了）。所以
 * `[…, user, assistant, system]` 这种形状，我们这边看着好好的，到上游那边
 * contents 的最后一条就是 assistant，照样 400。
 *
 * IG 那一轮天然长这个样：它不是被消息触发的，末尾那条行动指令挂的是 system
 * （igprompt.js 结尾那段），而从存档恢复的上文最后一轮往往是角色说的话。
 * 结果就是每条互动任务都必然吃一个 400、出队即丢 —— 点赞（不打模型那条路）
 * 之外整个 Instagram 分区都不动。
 *
 * 摘下来的 system 原样放回数组末尾：它们该发还是要发，只是不参与「谁是最后
 * 一个 turn」这个判断。
 */
function moveModelTail(messages, label) {
  const out = (Array.isArray(messages) ? messages : []).slice();

  // 1. 尾部的 system 先搁一边，它们挡不住这条 400
  const trailing = [];
  while (out.length && out.at(-1)?.role === "system") trailing.unshift(out.pop());

  // 2. 剩下的尾部可能连着好几条 assistant（预设里能写多条预填条目），
  //    一路收到不是 assistant 为止
  const tails = [];
  while (out.length && out.at(-1)?.role === "assistant") {
    const content = out.pop()?.content;
    if (typeof content === "string") tails.unshift(content);
  }
  // 真的不以 assistant 收尾（跳过 system 之后），原样返回，一个字都不动
  if (!tails.length) return messages;

  const text = tails.filter((s) => s.trim()).join("\n\n");
  if (text) {
    const prev = out.at(-1);
    if (prev?.role === "user" && typeof prev.content === "string") {
      out[out.length - 1] = { ...prev, content: `${prev.content}\n\n${text}` };
    } else {
      out.push({ role: "user", content: text });
    }
  }

  // 3. system 放回去。位置在最后 —— 它们本来就在最后，而且 systemInstruction
  //    不看顺序
  out.push(...trailing);

  logWarn(
    label,
    "这个模型不收以 assistant 结尾的消息数组，末尾的预填已改挂到 user 名下",
    [
      text
        ? `预填正文（${text.length} 字）并进了最后一条 user，预填本身的效果在这个模型上拿不到`
        : "预填是空的，整条去掉了",
      trailing.length
        ? `末尾那 ${trailing.length} 条 system 不算 turn（上游拿它当 systemInstruction），已跳过去找的 assistant`
        : "",
    ]
      .filter(Boolean)
      .join("；")
  );
  return out;
}

/**
 * 上游错误体可能是 JSON 也可能是 HTML，尽量挖出人能看的一句话。
 *
 * 挖出来的这句会进抛出的 Error，而那个 Error 的话**会原样发到用户的
 * iMessage 里**（见 imessage.js:notifyFailure），所以这里必须有个上限 ——
 * 不能把一整页 HTML 错误页发成一条短信。完整的响应体走另一条路：由调用方
 * 记进日志的 detail 里（见 chatCompletion），前端控制台展开那一行就能看到、
 * 「复制」也会带上。
 */
/**
 * HTTP 状态码翻译成一句人话。
 *
 * 用户反馈里最常见的一类是「我收到一串数字，不知道是什么意思」—— 光一个
 * `返回 503` 对着聊天的人毫无信息量，他既不知道这是谁家的错，也不知道该
 * 找谁。于是默认归因给 Uranus，一路问上来。
 *
 * 所以每个码后面缀一句「这个码通常意味着什么」。措辞刻意短：这句话最终要
 * 发成一条 iMessage，跟在它后面的还有上游原文和「找服务商」那半句。
 *
 * 只写**最常见**的那个成因，不写「也可能是 A 也可能是 B」—— 拿不准的时候
 * 上游原文（detail）比我们的猜测准，多说一种可能只会挤掉那段原文。
 * 表里没有的码就不猜，光报数字。
 */
const STATUS_HINTS = {
  400: "上游不收这个请求",
  401: "密钥不对或已失效",
  402: "账户余额不够了",
  403: "这把密钥没有用这个模型的权限",
  404: "上游没有这个模型，或者接口地址填错了",
  408: "上游自己超时了",
  413: "这一轮要发的内容太长，上游不收",
  422: "上游不收这个请求里的某个字段",
  429: "打得太频繁，或者额度/余额用完了",
  500: "上游服务器内部出错",
  502: "上游网关不通",
  503: "上游这会儿没有可用的渠道",
  504: "上游超时没回",
  529: "上游过载了",
};

function describeUpstream(status, text, data) {
  const detail =
    data?.error?.message ??
    data?.error?.code ??
    data?.message ??
    (typeof data?.error === "string" ? data.error : null) ??
    (text ? text.slice(0, UPSTREAM_DETAIL_MAX) : "");
  const hint = STATUS_HINTS[status];
  // 不带「API」二字：调用方会在前面拼 label（「主 API」「视觉 API」），
  // 否则会拼出「视觉 API API 返回 429」这种叠字
  return `返回 ${status}${hint ? `（${hint}）` : ""}${detail ? `：${detail}` : ""}`;
}

/**
 * 一次失败该由谁负责，以及那句「该找谁」怎么说。
 *
 * 为什么需要这句话：聊天失败的错误会**原样发进用户的 iMessage**
 * （imessage.js:notifyFailure）。那条短信的读者不是机主，是正在和角色聊天
 * 的人 —— 他看到一句光秃秃的「返回 503：分组下无可用渠道」，第一反应是
 * 「Uranus 坏了」，于是来问机主，机主再来问项目。链条上每个人都在查错的地方。
 *
 * 分四档而不是一律说「上游的问题」：`401 密钥不对` 和「没填密钥」的解决方式
 * 完全相反，前者要找服务商、后者自己去界面里补一栏。都推给服务商的话，一半
 * 的人会带着一个 Uranus 侧的配置问题去找客服，客服查半天也查不出东西。
 */
const FAULT_ADVICE = {
  // 上游收到了请求、明确回了个错误码。Uranus 改不了它
  upstream: "这是模型服务商回的错，不是 Uranus 的问题，请把上面这句话发给你的 API 服务商",
  // 请求压根没到上游。可能是本机出不了网，也可能是那家站点挂了/域名填错了
  network: "这一步没能连上模型服务商，先看网络和代理通不通、接口地址有没有填错",
  // 内容安全。也在上游那一侧，但解决办法是换说法/换模型，不是找客服要额度
  blocked: "这是模型服务商的内容审核拦下的，不是 Uranus 的问题，换个说法或换个模型再试",
  // 这一档是我们自己的事，别往外推
  config: "这是 Uranus 里还没填全的配置，去「连接」或「角色」里补上就行",
};

/** 在错误上盖一个归属标记，`faultAdvice` 靠它挑那句「该找谁」。 */
function faultKind(err, kind) {
  err.faultKind = kind;
  return err;
}

/**
 * 这个错误该配哪句「找谁解决」。
 *
 * 由 imessage.js:notifyFailure 在**真要发给对方**的那一刻调 —— 不在抛出的地方
 * 拼死。两个理由：
 *
 *  - 日志里只要原因，缀一句「请联系服务商」纯属噪音，而且中途还要经过重试和
 *    换线，提前定死措辞会让最后成功的那一轮也带着一句道歉；
 *  - 发给对方的路不止聊天一条（看图、听语音也会失败），advice 挂在那个共同的
 *    出口上，新加的失败路径自动带上，不会漏。
 *
 * 没标过的按 upstream 算：走到用户面前的失败，绝大多数是上游回的状态码。
 *
 * @returns {string} 那句建议；`faultNote` 有的话拼在它前面
 */
export function faultAdvice(err) {
  const kind = err?.faultKind ?? (err?.blocked ? "blocked" : "upstream");
  return [err?.faultNote, FAULT_ADVICE[kind] ?? FAULT_ADVICE.upstream].filter(Boolean).join("；");
}

/** 我们会往请求体里塞的生成参数，按「被拒了就脱掉」的顺序列。 */
const TUNABLE_FIELDS = ["temperature", "top_p", "frequency_penalty", "presence_penalty"];

/**
 * 上游是不是在说「你发的某个生成参数我不收」，是的话返回那个字段名。
 *
 * 起因是一批用户的报错：
 *   `400 Unsupported value: 'temperature' does not support 0.7 with this
 *    model. Only the default (1) value is supported.`
 *
 * 新一代的推理型模型（OpenAI 的 o / GPT-5 系、以及跟着学的几家）把采样参数
 * 锁死在默认值上，发了就整轮 400。而预设的 DEFAULT_PARAMS 里 temperature
 * 是 0.7、topP 是 1 —— normalizeParams 保证这几项**永远是数字**，所以
 * 「没配的就别发」那套判断在这里根本不成立，我们是无条件发的，撞上这类模型
 * 必废，而且 400 不属于可重试，副 API 也只是拿同一份参数再废一次。
 *
 * 按模型名维护一张黑名单（GEMINI_STRICT 那种）在这里不管用：中转站的模型名
 * 五花八门，新模型每周都有。改成认**上游的抱怨**——它指名道姓说哪个字段不行，
 * 就把哪个字段脱掉重打一次，脱到能过为止。管你是今天的哪家、明天的哪个。
 */
function rejectedParamField(status, text) {
  if (status !== 400) return null;
  const s = String(text ?? "");
  // 先确认这是一句「不支持」，免得把正文里碰巧出现 temperature 的错误也算上
  if (!/unsupported|not support|unrecognized|invalid[_ ]?(value|parameter|argument)/i.test(s)) {
    return null;
  }
  return TUNABLE_FIELDS.find((f) => new RegExp(`\\b${f}\\b`, "i").test(s)) ?? null;
}

/**
 * 上游是不是在说「我不收 stream 这个字段」。
 *
 * 和 rejectedParamField 同一个路子（认上游的抱怨，不维护模型黑名单），单独一个
 * 函数是因为处理不一样：脱掉 `stream` 还得把**读法**也换回非流式，见调用点。
 *
 * 认得比那边松一点，允许 `stream is not supported` / `streaming is disabled`
 * 这类没有 `unsupported` 字样的说法 —— 自建反代的报错措辞比正规厂商随意得多。
 */
function rejectsStream(status, text) {
  if (status !== 400 && status !== 422 && status !== 501) return false;
  const s = String(text ?? "");
  if (!/\bstream(ing)?\b/i.test(s)) return false;
  return /unsupported|not\s+support|unrecognized|invalid|disabled|not\s+allowed|cannot|can't/i.test(s);
}

/* ================= 内容安全那一类失败 ================= */

/**
 * 上游是不是在说「这段内容我不做」。
 *
 * 起因是记忆库总结的两条真实报错：
 *   `The prompt could not be submitted. The prompt contains sensitive words
 *    that violate Google's Generative AI Prohibited Use policy.`
 * 以及 Gemini 那边的 `PROHIBITED_CONTENT` / `SAFETY`。
 *
 * 这类失败和别的不一样：它**不是**网络抖动（重打一模一样的没用），也不是配置
 * 错（换个模型可能就过了，但那得用户动手）。它是「同一份请求体换个说法可能就
 * 过得去」—— 总结这件事本来就该是中立的第三人称摘要，把这一点在提示词里说死，
 * 成功率会完全不同。所以单独认出来，交给 retryOnRefusal 那套换说法重试。
 *
 * 状态码卡在这几个上，是为了不把 503「分组下无可用渠道」这类误判成内容拦截 ——
 * 那种要重试的是**同一份请求**，走 isTransient 那条路。
 */
const BLOCK_PATTERNS = [
  /prohibited[_ ]?(use|content)/i,
  /sensitive\s+words?/i,
  /content[_ ]?filter/i,
  /safety[_ ]?(settings?|filters?|polic|block)/i,
  /blocked\s+by/i,
  /\bRECITATION\b/,
  /违规|敏感词|内容(安全|审核|政策)/,
];

export function isContentBlocked(status, text) {
  // 0/undefined = 不是上游回的（比如正文被判成拒答），那就只看措辞
  if (status && ![400, 403, 422, 451].includes(status)) return false;
  const s = String(text ?? "");
  return BLOCK_PATTERNS.some((re) => re.test(s));
}

/**
 * 这段正文是不是「模型答应了，但回的是一句道歉」。
 *
 * 比上游明着拦下更阴险：HTTP 200、格式完全正常，于是调用方把这句道歉当成合格
 * 的总结写了进去 —— 而备忘录是**整份覆盖**的（memory.js:summarizeMemo），
 * 一句「很抱歉，我无法协助」能把用户攒了几个月的备忘录冲干净。
 *
 * 判得很紧，两个条件都要满足：
 *
 *  1. **短**。真的总结是几百上千字；拒答就那么一两句。
 *  2. **拒答的话出现在开头**。角色在剧情里说「很抱歉」是常事，而模型要拒绝
 *     你的时候一定是开门见山。放在正文中间的「抱歉」不算。
 *
 * 只在调用方明确传了 retryOnRefusal 时才会被问到（见 chatCompletion）——
 * 正常聊天那条路压根不走这里，角色想道歉就让它道歉。
 */
const REFUSAL_PATTERNS = [
  /(很|非常|十分)?抱歉[，,、]/,
  /我(不能|无法|不便|没办法|恐怕不能)(协助|帮助|继续|提供|生成|完成|处理|总结)/,
  /(不能|无法)(满足|回应|处理)(你|您)的(这个|这项)?(请求|要求)/,
  /作为(一个|一名)?(AI|人工智能|语言模型|大语言模型)/i,
  /违反了?(相关)?(的)?(内容)?(政策|规定|准则|使用条款)/,
  /\bI(?:'m| am) (?:sorry|unable|not able)\b/i,
  /\bI (?:can(?:no|')?t|cannot|won't) (?:help|assist|continue|provide|create|generate|comply)\b/i,
  /\bAs an AI\b/i,
  /(?:violat\w+|against) (?:our |the )?(?:usage |content )?polic/i,
];
/** 超过这个字数就当它真的在总结 —— 拒答不会写这么长。 */
const REFUSAL_MAX_CHARS = 400;
/** 拒答的话必须出现在开头这一段里。 */
const REFUSAL_HEAD_CHARS = 120;

export function looksLikeRefusal(text) {
  const s = String(text ?? "").trim();
  if (!s || s.length > REFUSAL_MAX_CHARS) return false;

  /*
   * 中转站把审核提示语**塞进 200 的正文里**这一种，单独认。
   *
   * 用户丢备忘录就是这么丢的：上游没回 400，而是回了 HTTP 200，正文是
   *   `The prompt could not be submitted. The prompt contains sensitive words
   *    that violate Google's Generative AI Prohibited Use policy. Try
   *    rephrasing the prompt. If you think this was an error, send feedback.`
   * 这句话既不是道歉（REFUSAL_PATTERNS 一条都不沾 —— 它没说「抱歉」、没说
   * 「我无法」，主语压根不是模型），也不走 isContentBlocked（那个只在非 2xx
   * 时被问到）。于是两道闸同时漏，它被当成一份合格的备忘录**整份覆盖**写了
   * 进去。第二次总结时 writeMemo 又把这份坏的复制进 `.bak`，原来那份就彻底
   * 没了 —— 用户的原话：「我回去找备份，也是一样的。我原来的备忘录直接不见了」。
   *
   * 所以这里复用 BLOCK_PATTERNS（`sensitive words` / `prohibited use` 那几条）
   * 直接判正文。不管措辞是道歉还是平台提示，结论都一样：这不是总结，
   * 换个说法重问，用尽还不行就当失败。
   */
  if (BLOCK_PATTERNS.some((re) => re.test(s))) return true;

  const head = s.slice(0, REFUSAL_HEAD_CHARS);
  return REFUSAL_PATTERNS.some((re) => re.test(head));
}

/**
 * 在异常上盖一个 `blocked` 标记。
 *
 * 给调用方留个**能判**的钩子：这一类失败换条线、隔一会儿再试都一样过不去，
 * 和「网络抖动」「额度用完」不是一回事。目前没人读它（记忆库那边失败就是失败，
 * 一律不清 pending），留着是为了以后想在界面上把这一类单独说一句时不用再改
 * llm.js —— 话本身已经说清了，标记只是省掉一次字符串匹配。
 */
function blockedIf(err, blocked) {
  if (blocked) err.blocked = true;
  return err;
}

/**
 * 被拦下之后追加的那句话，一档比一档收敛。
 *
 * 原样重打三次大概率是三次一样的结果 —— 拦住它的是请求体本身，不是运气。
 * 所以每次换个说法：先把「你要做的是中立摘要」说死，还不行就连原文引用都不要。
 *
 * 追加成一条 **user** 消息而不是改 system：中转站对 system 的处理五花八门
 * （有的合并、有的丢弃），而最后一条 user 是一定会被看到的。这也顺带满足了
 * Gemini 3.7/3.8 那条「消息数组不能以 assistant 结尾」的硬规矩。
 */
const SAFETY_NUDGES = [
  "上一次的回答因为内容安全被拒了。请注意：这是一份**客观、中立、第三人称**的" +
    "事实摘要任务，不是续写也不是创作。只概括发生了什么、谁做了什么决定、有哪些" +
    "要点需要记住；不要复述敏感细节、露骨描写或原话。不要解释你的顾虑，直接给结果。",
  "仍然被拒。请把上面的材料当成**已经脱敏的事件记录**来处理：只输出要点列表，" +
    "每条一行，用最平实的措辞概括「谁、做了什么、结论是什么」。不要引用任何原文，" +
    "不要描述任何具体动作或身体细节，不要作任何评价。只输出列表本身。",
  "还是不行。那就只抽**最外层的事实骨架**：时间、地点、在场的人、达成的约定或" +
    "结论、需要记住的偏好与禁忌。凡是涉及具体情节、身体、情绪细节的一律跳过不写。" +
    "宁可写得少、写得干，也不要漏掉时间和约定。直接输出，不要任何前言后语。",
];

/**
 * 上游报错时把**完整的响应体**记进日志。
 *
 * 抛出去的那句话有长度上限（要发成短信），日志没有 —— 用户排查问题看的是
 * 控制台，那里必须有全文。logs.js 自己会在 4000 字处截断并标明「已截断」，
 * 所以这里原样传，不预先切。
 *
 * 请求体也一起记：中转站回 400 说「某个字段不对」时，光看它那句话猜不出
 * 我们到底发了什么，两边对着看才能定位。**只记结构不记正文** ——
 * messages 里是人设、聊天记录、日记流水，那些不该往日志里抄一份。
 */
function logUpstreamFailure(label, status, text, body) {
  const shape = (body?.messages ?? []).map((m) => `${m.role}(${String(m.content ?? "").length}字)`);
  logWarn(
    label,
    `上游返回 ${status}，完整响应体如下`,
    `请求：${body?.model ?? "?"}，消息 ${shape.length} 条 [${shape.join(", ")}]\n` +
      `响应：${text || "（空响应体）"}`
  );
}

/**
 * 网络层的错误。
 *
 * undici 抛出来的多半是一句没信息量的 "fetch failed"，真正的原因埋在
 * e.cause 里（连不上、DNS 解析不了、证书不对…）。控制台就是给用户排查
 * 问题用的，所以这里要把 cause 挖出来。
 *
 * ── 为什么改成转给 proxy.js:whyNetwork ──
 *
 * 这里原来自己挖 `e.cause.code`，**只挖一层**，而真正的原因经常比一层深：
 *
 *  - Node 20 起默认开 Happy Eyeballs，IPv6 和 IPv4 都连不上时抛的是
 *    `AggregateError`，外层只有一个笼统的 code，**每条具体原因在
 *    `e.errors[]` 里**。只看 `cause.code` 的话一条都读不到，于是掉到最后那个
 *    兜底，把 undici 的 `fetch failed` 原样吐出去 —— 用户报上来的就是这句。
 *  - 走代理时 TLS / HTTP 隧道里的错还会再包一层。
 *
 * `netCodes` 会把 `errors[]` 和 `cause` 一起往下走四层，而 `whyNetwork` 还多
 * 做一件这里做不到的事：**区分「走着代理出的错」和「直连出的错」**。同一个
 * ECONNREFUSED，走代理时该去看代理开没开，直连时该去看地址填对没有 ——
 * 两种要改的地方完全不同，而这里压根不知道这一类有没有挂代理。
 *
 * 传的 scope 是 `"llm"`，和这条路 `fetchVia("llm", …)` 用的是同一个 key ——
 * 「挂代理看哪个开关，报错就照哪个开关说话」，两边不会各说一套。
 *
 * 每种情况都带上原始错误码：这句话会原样发到用户的 iMessage 里
 * （见 imessage.js:notifyFailure），有个能搜的关键词比一句中文描述管用。
 */
function describeNetworkError(e, timeout = REQUEST_TIMEOUT) {
  // AbortError 是「用户按停」和「我们自己的超时」共用的名字，whyNetwork
  // 认不出后者的语义（它只看错误码），所以这一种留在这儿自己说
  if (e?.name === "AbortError") return `上游超时，没在限定时间内响应（代码 AbortError）`;
  return whyNetwork(e, "llm", timeout);
}

/**
 * 发一个 JSON 请求并把响应解析好。
 *
 * `headers` 给非 OpenAI 形状的接口用（Gemini 原生那条路要的是
 * `x-goog-api-key` 而不是 `Authorization`，见 transcribeAudio）。给了它就
 * 完全接管鉴权头，`key` 不再自动拼成 Bearer。
 *
 * `signal` 是「用户按停」那条路（线下模式的「停下」按钮）。它和超时那个
 * 信号用 `AbortSignal.any` 并起来 —— 谁先响都算，fetch 当场断开，不是等它
 * 跑完再把结果丢掉。
 *
 * @returns {Promise<{ok: boolean, status: number, data: any, text: string}>}
 */
async function requestJson(
  url,
  { method = "POST", key, body, timeout = REQUEST_TIMEOUT, headers, signal }
) {
  /*
   * 模型 API 那一类**默认不走代理**：中转站在国内直连本来就通，套上代理多半
   * 更慢，还可能因为落地 IP 变了被风控。要走的话在控制台的「代理」那节勾上。
   *
   * 走 `fetchVia` 而不是自己挂 dispatcher：勾了代理的人，代理没开时会自动脱开
   * 代理直连补一刀 —— 对这一类尤其划算，因为目标本来就直连通。
   *
   * `init` 每次重造：`signal` 里有 `AbortSignal.timeout`，第一发用掉就在计时了。
   */
  const init = () => {
    const timer = AbortSignal.timeout(timeout);
    return {
      method,
      headers: headers ?? {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([timer, signal]) : timer,
    };
  };
  const res = await fetchVia("llm", url, init, (why) => logDebug("LLM", why));

  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* 非 JSON：调用方按 status/text 处理 */
  }
  return { ok: res.ok, status: res.status, data, text };
}

/* ================= 流式 ================= */

/**
 * 同 requestJson，但按 SSE 边收边喂。**返回的是一模一样的形状**
 * `{ok, status, data, text}`。
 *
 * 形状一致这件事是刻意的，也是这个函数存在的全部理由：chatCompletion 那个
 * 重试循环里有一大堆判断（isTransient 退避、rejectedParamField 脱参数重打、
 * 换说法重试、logUpstreamFailure、最后取 `choices[0].message.content`），
 * 它们**一行都不用为流式改**。收完之后把拼好的全文塞回
 * `data.choices[0].message.content`，下游根本看不出这轮是流式收的。
 *
 * ── 三种「其实不是流」的情况都要兜住 ──
 *
 *  1. **非 2xx**：读完 body 当 text 返回，照走原来的错误分支。错误响应从来
 *     不是 SSE，硬按 SSE 解析只会把一段好好的 JSON 错误信息弄丢。
 *  2. **Content-Type 不是 event-stream**：整包 `JSON.parse`，按非流式返回 ——
 *     这就是「跟随模型」那一档。自己部署的反代和一些中转站不管你发没发
 *     `stream: true`，回的都是普通 JSON。
 *  3. **流中间来一条 `data: {"error":...}`**：当上游错误返回，别把半截正文
 *     当成成功的结果交出去。
 *
 * `onDelta` 每收到一小块正文调一次。它自己抛的异常**不会**打断这一轮 ——
 * 那是「写给前端的管子断了」，而模型这边还在正常吐字；断的是显示，不是生成。
 *
 * @param {(text: string) => void} onDelta 每一小块正文
 * @returns {Promise<{ok: boolean, status: number, data: any, text: string}>}
 */
async function requestStream(url, { key, body, timeout = REQUEST_TIMEOUT, signal, onDelta }) {
  // 和 requestJson 同一条规矩：模型 API 默认不走代理，勾了的话代理挂了自动直连
  const init = () => {
    const timer = AbortSignal.timeout(timeout);
    return {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        // 有些反代靠这个头决定回不回 SSE
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([timer, signal]) : timer,
    };
  };
  const res = await fetchVia("llm", url, init, (why) => logDebug("LLM", why));

  // 错误响应不是 SSE，原样读成文本交给调用方那套错误处理
  if (!res.ok) {
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* 同 requestJson */
    }
    return { ok: false, status: res.status, data, text };
  }

  const kind = String(res.headers.get("content-type") ?? "");
  if (!/event-stream/i.test(kind)) {
    // 「跟随模型」：上游没给流，那就当普通 JSON 收下。一个字都不丢
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* 非 JSON 也非 SSE：交给调用方按 text 报错 */
    }
    logDebug("LLM", `上游没回流式（Content-Type: ${kind || "空"}），这轮当整段收下`);
    return { ok: true, status: res.status, data, text };
  }

  let full = "";
  let usage = null;
  let finish = null;
  let model = "";
  let upstreamError = null;

  await readSse(res, (payload) => {
    if (payload === "[DONE]") return true;
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      // 心跳、注释、反代插的那点垃圾 —— 跳过，别为此毁掉一整轮
      return false;
    }
    // 流中途报错：`data: {"error":{...}}`
    if (chunk?.error) {
      upstreamError = chunk.error;
      return true;
    }
    const choice = chunk.choices?.[0];
    // reasoning_content 是思考过程（DeepSeek R1 那一路），不是正文，不累进去
    const piece = choice?.delta?.content;
    if (typeof piece === "string" && piece) {
      full += piece;
      // 前端的管子断了不该连累这一轮生成
      try {
        onDelta?.(piece);
      } catch {
        /* 显示断了，生成继续 */
      }
    }
    if (choice?.finish_reason) finish = choice.finish_reason;
    // usage 一般只挂在最后一个 chunk 上（有的源压根不给）
    if (chunk.usage) usage = chunk.usage;
    if (chunk.model) model = String(chunk.model);
    return false;
  });

  if (upstreamError) {
    const text = JSON.stringify({ error: upstreamError });
    return { ok: false, status: 200, data: { error: upstreamError }, text };
  }

  /*
   * 拼回非流式的形状。`text` 那一份是给日志和错误信息用的（调用方会
   * `.slice(0, 300)`），所以只放拼好的全文，不留 SSE 的原始帧 —— 几百个
   * `data: {...}` 塞进日志没有任何可读性。
   */
  const data = {
    ...(model ? { model } : {}),
    choices: [{ index: 0, message: { role: "assistant", content: full }, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  };
  return { ok: true, status: res.status, data, text: JSON.stringify(data) };
}

/**
 * 把响应体按 SSE 拆成一条条 `data:` 负载。
 *
 * 自己拆而不用 EventSource：那个只认 GET。规则按 SSE 那份规范来的最小子集 ——
 * 事件之间空行分隔、`data:` 后面那截是负载、一个事件里多条 data 用 `\n` 接上。
 *
 * `\r\n` 也认：有的反代（尤其 IIS / nginx 中间加了一层的）回的是 CRLF，
 * 只按 `\n\n` 切会把 `\r` 留在负载末尾，JSON.parse 照样能过但不干净；
 * 而只按 `\n\n` 找边界在纯 CRLF 的流上直接找不到事件边界。
 *
 * @param {Response} res
 * @param {(payload: string) => boolean} onPayload 返回 true 表示到此为止
 */
async function readSse(res, onPayload) {
  const reader = res.body?.getReader?.();
  if (!reader) throw new Error("上游没给响应体");
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  let done = false;

  /** 处理缓冲区里所有**完整**的事件（末尾那个不完整的留着等下一块）。 */
  const drain = (flush) => {
    for (;;) {
      const m = /\r?\n\r?\n/.exec(buf);
      let raw;
      if (m) {
        raw = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
      } else if (flush && buf.trim()) {
        // 流断了但缓冲区里还剩一个没有尾随空行的事件（有的源最后一帧就这样）
        raw = buf;
        buf = "";
      } else {
        return;
      }
      const lines = raw.split(/\r?\n/);
      const payload = lines
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!payload) continue; // 注释行（`: keep-alive`）和别的字段一律跳过
      if (onPayload(payload)) {
        done = true;
        return;
      }
    }
  };

  try {
    for (;;) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      buf += decoder.decode(value, { stream: true });
      drain(false);
      if (done) break;
    }
    if (!done) {
      buf += decoder.decode();
      drain(true);
    }
  } finally {
    // 提前收工（[DONE]、流里报错、用户按停）要主动掐掉连接，
    // 不然这条 socket 会挂在那儿直到上游自己超时
    try {
      await reader.cancel();
    } catch {
      /* 已经断了 */
    }
  }
}

/**
 * 调一次 /chat/completions，成功返回助手文本。
 * 失败一律 throw Error（带中文原因），由调用方决定要不要换线。
 *
 * 网络抖动（连不上、超时、被掐断）和上游的 429/5xx 会自动补打几次，
 * 见 RETRY_DELAYS —— 实测中转站偶发 TCP 连接超时，一次重试就过去了，
 * 没必要为此丢掉整轮对话。
 *
 * @param {{url:string,key:string,model:string,temperature?:number}} endpoint
 *        temperature 只是给「测试连接」那条路留的回落 —— 正式对话的生成参数
 *        走 opts.params（来自预设）
 * @param {Array} messages OpenAI 格式的消息数组
 * 传了 `onDelta` 就按流式发，边收边喂给它；收完返回的还是拼好的全文，
 * 调用方不传就完全是原来那条路（见 requestStream）。
 *
 * @param {{label?:string, timeout?:number, maxTokens?:number, retries?:number,
 *          params?:object, signal?:AbortSignal, retryOnRefusal?:number,
 *          onDelta?:(text:string)=>void}} [opts]
 *        label 只用于日志；params 见 preset.js 的 DEFAULT_PARAMS（温度 / Top P /
 *        最大token / 频率惩罚 / 存在惩罚）；signal 是「用户按停」，命中就抛
 *        ABORTED_MESSAGE；retryOnRefusal 是「被内容安全拦下时换个说法再试几次」，
 *        默认 0（只有记忆库那几条总结链传，见 SAFETY_NUDGES）；onDelta 有就走
 *        流式，每收到一小块正文调一次
 */
export async function chatCompletion(endpoint, messages, opts = {}) {
  const label = opts.label ?? "API";
  const base = trimBase(endpoint?.url);
  const key = endpoint?.key ?? "";
  const model = endpoint?.model ?? "";

  // 这三条是 Uranus 侧的配置没填全，不是上游的错 —— 标成 config，
  // 免得用户拿着「没填密钥」去问服务商客服
  if (!base) throw faultKind(new Error(`${label} 没填接口地址`), "config");
  if (!key) throw faultKind(new Error(`${label} 没填密钥`), "config");
  if (!model) throw faultKind(new Error(`${label} 没填模型名`), "config");

  // Gemini 3.7 / 3.8 的两条硬规矩，见 GEMINI_STRICT
  const strict = GEMINI_STRICT.test(model);

  const body = { model, messages: strict ? moveModelTail(messages, label) : messages };

  /*
   * 生成参数。逐个判 typeof 再发，而不是一股脑塞进去 ——
   * 有些中转站对 top_p / penalty 这些字段挑食，没配的就别发。
   *
   * strict 的模型一个都不发（连 temperature 都不行），预设里配了也当没配 ——
   * 那不是我们能替用户绕过去的事，发了整轮请求就废了。
   */
  const p = strict ? {} : opts.params ?? {};
  const temperature =
    typeof p.temperature === "number" ? p.temperature : strict ? undefined : endpoint.temperature;
  if (typeof temperature === "number") body.temperature = temperature;
  if (typeof p.topP === "number") body.top_p = p.topP;
  if (typeof p.frequencyPenalty === "number") body.frequency_penalty = p.frequencyPenalty;
  if (typeof p.presencePenalty === "number") body.presence_penalty = p.presencePenalty;
  if (strict) {
    logDebug(label, `${model} 不收生成参数，这轮温度 / Top P / 两个惩罚项都不发`);
  }

  // 0 = 不限制，交给上游默认。opts.maxTokens 是「测试连接」那种场合直接指定的
  const maxTokens = opts.maxTokens ?? p.maxTokens;
  if (maxTokens > 0) body.max_tokens = maxTokens;

  /*
   * 流式。**由调用方给不给 onDelta 决定** —— 有人接着增量才值得按流式发，
   * 没人接的话开了流只是把一整段拆成几百个包再拼回来，白费劲。
   *
   * 「跟随模型」那一档不在这里判：这边照样发 `stream: true`，上游要是回的
   * 不是 SSE，requestStream 会当整段收下（见那边的注释）。判 auto / on / off
   * 是上层的事（offline.js 读 config.stream.mode 决定要不要传 onDelta）。
   */
  let streaming = typeof opts.onDelta === "function";
  if (streaming) {
    body.stream = true;
    // 有的中转站要这个才在最后一帧给 usage；不认的会忽略掉，发了不亏
    body.stream_options = { include_usage: true };
  }

  // 测试连接这类「用户正盯着等结果」的场合可以传 retries: 0 关掉重试
  const delays = RETRY_DELAYS.slice(0, opts.retries ?? RETRY_DELAYS.length);

  /*
   * 内容安全那一类失败：还能换几次说法。默认 0 = 和以前一模一样。
   *
   * 只有记忆库那几条总结链会传（memory.js / offline.js）。正常聊天**刻意不传** ——
   * 角色在剧情里说「抱歉，我不能这样」是再正常不过的台词，那条路上一个字都不该
   * 被这套逻辑碰到。
   *
   * 和上面 attempt 那套是两本账：那是「同一份请求碰运气再打一次」，这是「请求体
   * 本身过不去，得换个说法」，互不占额度。
   */
  // 调用方给的额度。refusalLeft 会被减到 0，所以「这条链接不接受拒答吗」
  // 得另存一份 —— 最后那道闸要靠它判（见函数末尾 refusalAllowed 那段）
  const refusalAllowed = Math.max(0, Math.floor(Number(opts.retryOnRefusal) || 0));
  let refusalLeft = refusalAllowed;
  let refusalTries = 0;
  let nudged = false;

  /** 换一档说法。替换上一句而不是往上堆 —— 堆三句自相矛盾的要求只会更糟。 */
  const nudge = () => {
    const note = SAFETY_NUDGES[Math.min(refusalTries - 1, SAFETY_NUDGES.length - 1)];
    const head = nudged ? body.messages.slice(0, -1) : body.messages;
    nudged = true;
    body.messages = [...head, { role: "user", content: note }];
  };

  const startedAt = Date.now();
  let result;
  /*
   * attempt 只数「因为网络抖动 / 上游 5xx 重打」的次数，它决定下次等多久。
   * 下面「脱参数重打」那条路**不算**在里面：那不是碰运气再试一次，是换了个
   * 请求体，既不该占抖动的重试额度，也没有等的必要。
   */
  let attempt = 0;
  for (;;) {
    // 每圈开头看一眼：等重试的那几秒里用户可能已经按停了
    if (opts.signal?.aborted) throw abortedError();
    const retryIn = delays[attempt];
    try {
      /*
       * 流式和非流式走两个函数，但**返回同一个形状** —— 下面整段重试、脱参数、
       * 取正文的逻辑因此完全不用分叉，见 requestStream 的注释。
       *
       * 重打时 onDelta 照样会被调，所以上游拦一次再重来，前端会收到两段增量；
       * 那就是 chatWithFallback 的 onRestart 要解决的事（换线之前让前端清屏）。
       * 这里不自己去清：chatCompletion 不知道前端长什么样。
       */
      result = streaming
        ? await requestStream(`${base}/chat/completions`, {
            key,
            body,
            timeout: opts.timeout ?? REQUEST_TIMEOUT,
            signal: opts.signal,
            onDelta: opts.onDelta,
          })
        : await requestJson(`${base}/chat/completions`, {
            key,
            body,
            timeout: opts.timeout ?? REQUEST_TIMEOUT,
            signal: opts.signal,
          });
    } catch (e) {
      /*
       * 按停要在 isTransient 之前判掉。
       *
       * 被 abort 掐断的 fetch 抛的是 AbortError，而 isTransient 把 AbortError
       * 当「网络抖动」—— 不先拦这一下，用户按一次停会换来「第 1 次请求失败，
       * 800ms 后重试」三轮，然后还要再去打一遍副 API。
       */
      if (opts.signal?.aborted) throw abortedError();
      const why = describeNetworkError(e, opts.timeout ?? REQUEST_TIMEOUT);
      if (retryIn !== undefined && isTransient(null, e)) {
        logWarn(label, `第 ${attempt + 1} 次请求失败，${retryIn}ms 后重试`, why);
        attempt += 1;
        await wait(retryIn);
        continue;
      }
      // 请求没能到上游：可能是这台机器出不了网/要代理，也可能是那家站点自己挂了。
      // 两边都有可能，所以建议是「先看网络和地址」而不是「去找服务商」
      throw faultKind(new Error(`${label} 请求失败：${why}`), "network");
    }

    if (result.ok) {
      /*
       * HTTP 200 也可能是「模型答应了，但回的是一句道歉」。这一步在跳出循环
       * **之前**判，才能用同一个循环换说法重打；判据很紧，见 looksLikeRefusal。
       */
      const reply = result.data?.choices?.[0]?.message?.content;
      if (refusalLeft > 0 && looksLikeRefusal(reply)) {
        refusalLeft -= 1;
        refusalTries += 1;
        nudge();
        logWarn(
          label,
          `模型回的是一句道歉/拒答，换个说法重问（还能试 ${refusalLeft} 次）`,
          String(reply).slice(0, 200)
        );
        continue;
      }
      break;
    }

    const why = describeUpstream(result.status, result.text, result.data);
    if (retryIn !== undefined && isTransient(result.status, null)) {
      logWarn(label, `第 ${attempt + 1} 次${why}，${retryIn}ms 后重试`);
      attempt += 1;
      await wait(retryIn);
      continue;
    }

    /*
     * 上游明着说「这段内容我不做」。原样重打没有意义（isTransient 也不会认它），
     * 但换个说法有希望 —— 总结本来就该是中立的第三人称摘要。
     */
    if (refusalLeft > 0 && isContentBlocked(result.status, result.text)) {
      refusalLeft -= 1;
      refusalTries += 1;
      nudge();
      logWarn(label, `被内容安全拦下，换个说法重问（还能试 ${refusalLeft} 次）`, why);
      continue;
    }

    // 上游点名说某个生成参数它不收（见 rejectedParamField）：脱掉立刻重打。
    // 一轮只脱一个，脱掉的字段下一轮已经不在 body 里了，所以最多转几圈就收敛。
    const dropped = rejectedParamField(result.status, result.text);
    if (dropped && body[dropped] !== undefined) {
      delete body[dropped];
      logWarn(label, `${model} 不收 ${dropped}，去掉这个参数重打一次`, why);
      continue;
    }

    /*
     * 上游连 `stream` 都不收。和上面脱参数是同一个套路，但多一步：`streaming`
     * 也要关掉，不然下一圈还是走 requestStream、还是按 SSE 去读一个普通 JSON。
     *
     * 「跟随模型」那一档兜的是「发了 stream 但回的不是 SSE」，这里兜的是
     * **发都不让发**（有些老的自建反代会 400）。两处合起来才算真的「跟随」。
     */
    if (streaming && body.stream && rejectsStream(result.status, result.text)) {
      delete body.stream;
      delete body.stream_options;
      streaming = false;
      logWarn(label, `${model} 不收 stream，改成整段拿一次`, why);
      continue;
    }

    // 摘要那句会被截断（要发成短信），全文只在日志里 —— 这是最后一次机会
    logUpstreamFailure(label, result.status, result.text, body);
    const contentBlocked = isContentBlocked(result.status, result.text);
    throw faultKind(
      blockedIf(
        new Error(
          refusalTries
            ? `${label} 连着 ${refusalTries + 1} 次被内容安全拦下：${why}`
            : `${label} ${why}`
        ),
        refusalTries && contentBlocked
      ),
      // 内容审核也在上游那一侧，但办法是换说法/换模型，不是找客服要额度 ——
      // 所以和普通的状态码错误分开标。`blocked` 那个标记管的是重试策略，
      // 这里管的是「跟对方怎么说」，两件事各走各的
      contentBlocked ? "blocked" : "upstream"
    );
  }

  const ms = Date.now() - startedAt;

  const content = result.data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error(
      `${label} 返回格式看不懂（缺 choices[0].message.content）：${result.text.slice(0, 300)}`
    );
  }

  /*
   * 试到最后一次还是拒答 / 审核提示语：**当失败抛出去**，不把它当成合格的结果。
   *
   * 这是这一整段的要点所在。以前这种回复会被调用方当成正常总结 —— 而备忘录是
   * 整份覆盖的，一句「很抱歉，我无法协助」就能把用户攒了几个月的备忘录冲干净。
   * 抛出去之后走的是既有的失败路径：pending 不清、备忘录不动（用户的原话是
   * 「还是不行就默认成功不成功」）。
   *
   * 条件是 `retryOnRefusal > 0` 而不是 `refusalTries > 0`。差别在**第一次**：
   * 以前要「已经换过说法」才判，可 refusalTries 是在上面那个循环里加的，
   * 而循环 `continue` 的前提正是判出了拒答 —— 所以走到这儿只剩两种情况：
   * 试满了（refusalTries > 0），或者**压根没判出来**。后者就是用户遇到的那次：
   * 上游回 200、正文是 Google 那句 `sensitive words...`，looksLikeRefusal
   * 当时不认它，refusalTries 停在 0，于是这道闸也跳过，那句话直接写进了备忘录。
   * 现在措辞那一侧已经认了（见 looksLikeRefusal 里的 BLOCK_PATTERNS），
   * 这里把条件放宽是第二道保险：只要调用方说了「这条链不接受拒答」，
   * 就一次都不放过。
   */
  if (refusalAllowed > 0 && looksLikeRefusal(content)) {
    throw blockedIf(
      new Error(
        refusalTries
          ? `${label} 连着 ${refusalTries + 1} 次都被内容安全拦下（换了 ${refusalTries} 次说法），` +
            `没给出总结：${content.slice(0, 200)}`
          : `${label} 被内容安全拦下，没给出总结：${content.slice(0, 200)}`
      ),
      true
    );
  }

  const usage = result.data?.usage;
  logDebug(
    label,
    `${model} 回了 ${content.length} 字，耗时 ${ms}ms`,
    usage ? `token 用量：${JSON.stringify(usage)}` : undefined
  );

  return content;
}

/** 解析出来的 endpoint 够不够打一次请求。 */
function endpointUsable(ep) {
  return Boolean(ep && trimBase(ep.url) && ep.key && ep.model);
}

/**
 * 聊天主入口：先打角色选的聊天模型，报错就退到它的副 API。
 *
 * 两个 endpoint 都由 config.js 的 resolveRoleEndpoints 解析好再传进来 ——
 * 这里不碰配置结构，只管打请求和换线。fallback 传 null 表示没配/没开。
 *
 * @param {object|null} primary 聊天模型的 endpoint
 * @param {object|null} fallback 副 API 的 endpoint，没有就传 null
 * @param {object} [params] 预设里的生成参数。主副共用同一份 —— 一个角色一份预设
 * @param {{signal?:AbortSignal, onDelta?:(text:string)=>void,
 *          onRestart?:()=>void}} [opts] signal 是用户按停。按停**不换线** ——
 *        那不是主 API 坏了。onDelta 有就走流式；onRestart 在**换到副 API 之前**
 *        调一次，让调用方把已经显示出来的半截清掉（见下面那段注释）
 * @returns {Promise<{content: string, usedFallback: boolean}>}
 * @throws {Error} 两条线都失败时抛出，消息里带上两边的原因
 */
export async function chatWithFallback(primary, fallback, messages, params = {}, opts = {}) {
  const primaryLabel = primary?.label ? `主 API（${primary.label}）` : "主 API";
  const fallbackLabel = fallback?.label ? `副 API（${fallback.label}）` : "副 API";

  try {
    const content = await chatCompletion(primary ?? {}, messages, {
      label: primaryLabel,
      params,
      timeout: CHAT_TIMEOUT,
      signal: opts.signal,
      onDelta: opts.onDelta,
    });
    return { content, usedFallback: false };
  } catch (primaryError) {
    // 用户按停的：原样抛出去，不换线、不写「主 API 失败」那条日志
    if (primaryError?.aborted || opts.signal?.aborted) throw primaryError;

    const primaryMsg = String(primaryError?.message ?? primaryError);

    if (!endpointUsable(fallback)) {
      /*
       * 主 API 挂了、副 API 没配 —— 这条路上**一个「副 API」都不许出现**。
       *
       * 原来这里会在错误后面缀一句「副 API 没开着，换不了线」，本意是解释
       * 「我们为什么没换线」。实际效果是所有人都以为「没接副 API」才是这轮
       * 失败的原因，于是跑去接副 API、连换好几家模型 —— 换一圈还是同样的
       * 报错，因为真正的原因从头到尾就摆在前半句里（密钥错、余额空、
       * 上游容量不够）。副 API 是个可选的容灾开关，不是能不能跑的前提。
       *
       * 所以现在只说两件事：这句话是**谁**说的（模型服务商，不是 Uranus），
       * 以及该**找谁**（服务商，不是这个项目）。把话说到这个份上，用户
       * 转述给服务商客服时也不用再解释一遍。
       *
       * 日志里保留「副 API 没开着」那一句 —— 排查的人需要知道为什么没换线，
       * 而日志只有机主自己看得到，不会被当成待办事项。
       */
      const noFallback = !fallback
        ? "副 API 没开着，所以没换线"
        : "副 API 信息不全（地址/密钥/模型缺一项），所以没换线";
      logError("LLM", `主 API 失败，${noFallback}`, primaryMsg);
      throw primaryError;
    }

    logWarn("LLM", "主 API 失败，改用副 API", primaryMsg);

    /*
     * 换线之前让调用方清屏。
     *
     * 流式那条路上主 API 可能已经吐了半截、前端也已经显示出来了 —— 副 API
     * 会从头再说一遍，不清的话用户看到的是两段接在一起的重复正文。放在
     * chatCompletion 外面是因为它不知道前端长什么样，也不该知道。
     *
     * 非流式那条路 onRestart 压根没人传，这一句是空转。
     */
    try {
      opts.onRestart?.();
    } catch {
      /* 前端的管子断了不该连累换线 */
    }

    try {
      const content = await chatCompletion(fallback, messages, {
        label: fallbackLabel,
        params,
        timeout: CHAT_TIMEOUT,
        signal: opts.signal,
        onDelta: opts.onDelta,
      });
      logInfo("LLM", "副 API 顶上了，这轮由它回复");
      return { content, usedFallback: true };
    } catch (fallbackError) {
      // 副 API 打到一半被按停：同样原样抛，别报成「主副都失败」
      if (fallbackError?.aborted || opts.signal?.aborted) throw fallbackError;
      const fallbackMsg = String(fallbackError?.message ?? fallbackError);
      logError("LLM", "主副两条 API 都失败", `主：${primaryMsg}\n副：${fallbackMsg}`);
      /*
       * 两条都配了、两条都挂了。这一路**可以**提副 API —— 用户确实开着它，
       * 说「两条线都不通」是在陈述事实，不会让人以为该去接一条没接的线。
       *
       * 但两句原因都带上就太长了（发到 iMessage 是一条短信），而且多半是
       * 同一个原因说两遍（同一个中转站的两个模型、同一把密钥）。所以摘要
       * 只留主 API 那句，副 API 那句留在日志的 detail 里。
       *
       * `faultNote` 由 faultAdvice 拼进那句建议 —— 抛的还是主 API 那个错误
       * 对象本身，措辞照旧在 notifyFailure 那一刻才定。
       */
      primaryError.faultNote = "副 API 也试过了，同样没通";
      throw primaryError;
    }
  }
}

/**
 * 测试一条线路能不能用。不抛错，把结果包成对象返回，方便前端直接渲染。
 * @returns {Promise<{ok:boolean, reply?:string, error?:string, ms:number}>}
 */
export async function testEndpoint(endpoint, label = "API") {
  const startedAt = Date.now();
  try {
    const content = await chatCompletion(
      endpoint,
      [{ role: "user", content: "ping" }],
      // 不重试：用户正盯着等结果，失败就立刻告诉他，别让按钮转半分钟
      { label, timeout: TEST_TIMEOUT, maxTokens: 5, retries: 0 }
    );
    const ms = Date.now() - startedAt;
    logInfo(label, `测试连接通过（${ms}ms）`);
    return { ok: true, reply: content || "连接正常", ms };
  } catch (e) {
    const error = String(e?.message ?? e);
    const ms = Date.now() - startedAt;
    logWarn(label, "测试连接失败", error);
    return { ok: false, error, ms };
  }
}

/**
 * 拉模型列表（GET /models）。
 * 不同中转站返回结构有差异，这里尽量兼容 {data:[{id}]} 和 {data:["name"]}。
 *
 * @returns {Promise<{ok:boolean, models?:string[], error?:string}>}
 */
export async function listModels(endpoint, label = "API") {
  const base = trimBase(endpoint?.url);
  const key = endpoint?.key ?? "";
  if (!base) return { ok: false, error: `${label} 没填接口地址` };
  if (!key) return { ok: false, error: `${label} 没填密钥` };

  let result;
  try {
    result = await requestJson(`${base}/models`, {
      method: "GET",
      key,
      timeout: TEST_TIMEOUT,
    });
  } catch (e) {
    const error = `${label} 拉模型失败：${describeNetworkError(e, TEST_TIMEOUT)}`;
    logWarn(label, "获取模型列表失败", error);
    return { ok: false, error };
  }

  if (!result.ok) {
    const error = `${label} ${describeUpstream(result.status, result.text, result.data)}`;
    logWarn(label, "获取模型列表失败", error);
    return { ok: false, error };
  }

  const raw = Array.isArray(result.data?.data)
    ? result.data.data
    : Array.isArray(result.data?.models)
    ? result.data.models
    : Array.isArray(result.data)
    ? result.data
    : null;

  if (!raw) {
    const error = `${label} 返回格式看不懂（缺 data 数组）：${result.text.slice(0, 300)}`;
    logWarn(label, "获取模型列表失败", error);
    return { ok: false, error };
  }

  const models = raw
    .map((m) => (typeof m === "string" ? m : m?.id ?? m?.name ?? m?.model))
    .filter((m) => typeof m === "string" && m.length > 0);

  // 排序方便找，但别去重掉大小写不同的同名模型
  models.sort((a, b) => a.localeCompare(b));

  logInfo(label, `拉到 ${models.length} 个模型`);
  return { ok: true, models: Array.from(new Set(models)) };
}

/**
 * 让视觉模型看一张图，返回一段文字描述。
 *
 * endpoint 和提示词都由调用方解析好（角色各自选的识图模型），
 * 这里只负责把图片拼成 OpenAI 的多模态格式再打过去。
 *
 * @param {object} endpoint 识图模型的 endpoint
 * @param {string} prompt 识图提示词，空则用 DEFAULT_VISION_PROMPT
 * @param {{base64:string, mimeType:string, name?:string}} image
 * @returns {Promise<string>} 图片描述
 * @throws {Error} 识别失败
 */
export async function describeImage(endpoint, prompt, image) {
  const usePrompt = String(prompt ?? "").trim() || DEFAULT_VISION_PROMPT;
  const mimeType = image?.mimeType || "image/jpeg";

  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: usePrompt },
        {
          type: "image_url",
          image_url: { url: `data:${mimeType};base64,${image.base64}` },
        },
      ],
    },
  ];

  const kb = Math.round((image.base64.length * 3) / 4 / 1024);
  logDebug("视觉", `开始识别图片${image.name ? `「${image.name}」` : ""}（约 ${kb}KB, ${mimeType}）`);

  const content = await chatCompletion(endpoint ?? {}, messages, {
    label: endpoint?.label ? `视觉 API（${endpoint.label}）` : "视觉 API",
    // 请求体比纯文本大几个数量级，光上传就要时间，超时单独放宽
    timeout: VISION_TIMEOUT,
  });
  const text = content.trim();
  // 200 + 空正文：模型收了钱、什么都没说。和聊天那边的空回是同一件事
  if (!text) {
    throw faultKind(
      new Error("视觉 API 返回了成功，但描述是空的（这一轮的 token 照样会扣）"),
      "upstream"
    );
  }
  return text;
}

/* ================= 听音：Gemini 原生 generateContent ================= */

/**
 * Gemini 官方自己的域名。官方认 `x-goog-api-key`，中转站一律认
 * `Authorization: Bearer`（它们前面挡着一层 OpenAI 网关）。
 */
const GEMINI_OFFICIAL_HOSTS = new Set([
  "generativelanguage.googleapis.com",
  "aiplatform.googleapis.com",
]);

function isOfficialGemini(url) {
  try {
    return GEMINI_OFFICIAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * 从服务商的 base URL 拼出 Gemini 原生的 generateContent 地址。
 *
 * 配置里那个地址是给 `/chat/completions` 用的（`https://xxx.com/v1`），
 * 原生接口在**同一个域名的另一条路径**上（`/v1beta/models/...`），所以要先
 * 把 OpenAI 那截后缀剥掉再拼。四种写法都见过，按从长到短匹配 ——
 * 先试 `/v1beta/openai` 再试 `/v1beta`，反过来的话前者永远轮不到。
 */
function geminiNativeUrl(url, model) {
  let base = trimBase(url);
  for (const suffix of ["/v1/chat/completions", "/v1beta/openai", "/v1beta", "/v1"]) {
    if (base.endsWith(suffix)) {
      base = base.slice(0, -suffix.length);
      break;
    }
  }
  /*
   * 模型名**原样拼进 URL，不做任何清洗**。
   *
   * 参考插件那边会把 `[标签]`、`models/`、`厂商/` 前缀统统剥掉，那是给
   * 「用户从模型列表里复制粘贴」的场合兜底的。我们这边模型名是从服务商的
   * /v1/models 拉下来的原文，中转站的分组标签（`逆[Ag1-次-0.02￥]xxx`）
   * **就是模型名的一部分** —— 实测剥掉之后上游回 503 model_not_found。
   */
  return `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
}

/**
 * 把一段媒体（音频 / 视频）连同提示词打 Gemini 原生的 generateContent。
 *
 * **这是这个文件里唯一不打 OpenAI 兼容接口的聊天类请求**，所以没复用
 * chatCompletion，理由是实测出来的：OpenAI 那个
 * `{type:"input_audio", input_audio:{data, format}}` 字段，三家中转站
 * 没有一家往上游透传 —— 模型收到的是一条没有音频的空消息，然后开始编。
 * 换成 Gemini 原生的 `inline_data` 打 `:generateContent` 就全通了。
 * 视频同理，而且实测过五家中转站都能真的读到画面（见下面 describeVideo）。
 *
 * 除了请求形状，别的都和这个文件里其他函数一样：同一批服务商源、同一套
 * 密钥轮换（endpoint 由 config.js:resolveEndpoint 解析好传进来）、同一套
 * 重试规则、同一套错误摘要。
 *
 * ── 为什么音频和视频共用这一个函数 ──
 *
 * 两条路的请求体**逐字段完全一样**，只有 `mime_type` 和默认提示词不同。
 * 各写一份的话下次改重试规则、改错误归因、改空回复的处理就要改两处，
 * 而漏改的那一处只会在真出错时才暴露 —— 那时候在意的人正在等回复。
 *
 * @param {object} endpoint 模型的 endpoint（url / key / model / label）
 * @param {string} prompt 提示词，空则用 kind.defaultPrompt
 * @param {{base64:string, mimeType:string, name?:string, seconds?:number}} media
 * @param {{what:string, noun:string, defaultPrompt:string, fallbackMime:string}} kind
 *   what 进日志和错误文案（「听音」/「看视频」）、noun 是东西名（「音频」/「视频」）
 * @returns {Promise<string>} 转写/描述文本
 * @throws {Error} 识别失败
 */
async function inlineMedia(endpoint, prompt, media, kind) {
  const label = endpoint?.label ? `${kind.what} API（${endpoint.label}）` : `${kind.what} API`;
  const base = trimBase(endpoint?.url);
  const key = endpoint?.key ?? "";
  const model = endpoint?.model ?? "";

  // 前三条是配置没填全（Uranus 侧的事），第四条是这边把字节取坏了，都别推给服务商
  if (!base) throw faultKind(new Error(`${label} 没填接口地址`), "config");
  if (!key) throw faultKind(new Error(`${label} 没填密钥`), "config");
  if (!model) throw faultKind(new Error(`${label} 没填模型名`), "config");
  if (!media?.base64) {
    throw faultKind(new Error(`${label} 拿到的是一段空${kind.noun}`), "config");
  }

  const usePrompt = String(prompt ?? "").trim() || kind.defaultPrompt;
  const mimeType = media.mimeType || kind.fallbackMime;
  const url = geminiNativeUrl(base, model);

  /*
   * parts 的顺序：媒体在前、提示词在后。
   *
   * 官方文档的例子就是这个顺序，参考插件也是。反过来放不会报错，但
   * 「先听完再看要求」比「先看要求再听」更贴近模型的注意力实现。
   */
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { inline_data: { mime_type: mimeType, data: media.base64 } },
          { text: usePrompt },
        ],
      },
    ],
  };

  const headers = isOfficialGemini(base)
    ? { "Content-Type": "application/json", "x-goog-api-key": key }
    : { "Content-Type": "application/json", Authorization: `Bearer ${key}` };

  const kb = Math.round((media.base64.length * 3) / 4 / 1024);
  logDebug(
    kind.what,
    `开始识别${kind.noun}${media.name ? `「${media.name}」` : ""}（约 ${kb}KB, ${mimeType}${
      media.seconds ? `, ${media.seconds.toFixed(1)}s` : ""
    }）`,
    `POST ${url}`
  );

  const delays = RETRY_DELAYS;
  const startedAt = Date.now();
  let result;
  for (let attempt = 0; ; attempt += 1) {
    const retryIn = delays[attempt];
    try {
      // 音频体积和图片一个量级（甚至更大），超时跟着识图一起放宽。
      // 视频更慢 —— 实测 19MB 在某家中转站要 69 秒，所以这个超时不能缩
      result = await requestJson(url, { body, headers, timeout: VISION_TIMEOUT });
    } catch (e) {
      const why = describeNetworkError(e, VISION_TIMEOUT);
      if (retryIn !== undefined && isTransient(null, e)) {
        logWarn(label, `第 ${attempt + 1} 次请求失败，${retryIn}ms 后重试`, why);
        await wait(retryIn);
        continue;
      }
      throw faultKind(new Error(`${label} 请求失败：${why}`), "network");
    }

    if (result.ok) break;

    const why = describeUpstream(result.status, result.text, result.data);
    if (retryIn !== undefined && isTransient(result.status, null)) {
      logWarn(label, `第 ${attempt + 1} 次${why}，${retryIn}ms 后重试`);
      await wait(retryIn);
      continue;
    }
    // 请求体里绝大部分是 base64 字节，原样记进日志没意义也没法看，
    // 所以这里不走 logUpstreamFailure（它是照 OpenAI 的 messages 结构写的）
    logWarn(
      label,
      `上游返回 ${result.status}，完整响应体如下`,
      `请求：${model}，${kind.noun} ${kb}KB / ${mimeType}\n响应：${result.text || "（空响应体）"}`
    );
    throw faultKind(
      new Error(`${label} ${why}`),
      isContentBlocked(result.status, result.text) ? "blocked" : "upstream"
    );
  }

  const ms = Date.now() - startedAt;

  /*
   * 原生接口会在 HTTP 200 里夹带错误 —— 中转站把上游的失败原样转出来，
   * 自己却回了 200。不单独判的话下面取 candidates 会拿到 undefined，
   * 报出去的就是一句「返回格式看不懂」，把真正的原因盖掉了。
   */
  const upstreamError = result.data?.error;
  if (upstreamError) {
    const detail = upstreamError.message ?? upstreamError.status ?? JSON.stringify(upstreamError);
    throw new Error(`${label} 上游报错：${String(detail).slice(0, UPSTREAM_DETAIL_MAX)}`);
  }

  const candidate = result.data?.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .map((p) => (typeof p?.text === "string" ? p.text : ""))
    .join("")
    .trim();

  if (!text) {
    /*
     * 空回复多半有个说得出口的原因，都在 finishReason 里：
     * SAFETY（被安全过滤拦了）、MAX_TOKENS（输出被截断）、RECITATION…
     * 把它带上，比一句「返回了空描述」有用得多。
     */
    const reason = candidate?.finishReason ?? result.data?.promptFeedback?.blockReason;
    throw faultKind(
      new Error(
        `${label} 返回了空结果${reason ? `（${reason}）` : ""}：${result.text.slice(0, 300)}`
      ),
      // SAFETY / RECITATION / PROHIBITED_CONTENT 都是审核拦的，办法是换说法不是找客服
      /safety|recitation|prohibited|blocked/i.test(String(reason ?? "")) ? "blocked" : "upstream"
    );
  }

  const usage = result.data?.usageMetadata;
  logDebug(
    kind.what,
    `${model} 回了 ${text.length} 字，耗时 ${ms}ms`,
    usage ? `token 用量：${JSON.stringify(usage)}` : undefined
  );

  return text;
}

/**
 * 让多模态模型听一段音频，返回一段文字。请求形状见 inlineMedia。
 *
 * @param {object} endpoint 听音模型的 endpoint（url / key / model / label）
 * @param {string} prompt 听音提示词，空则用 DEFAULT_AUDIO_PROMPT
 * @param {{base64:string, mimeType:string, name?:string, seconds?:number}} audio
 * @returns {Promise<string>} 转写/描述文本
 */
export async function transcribeAudio(endpoint, prompt, audio) {
  return inlineMedia(endpoint, prompt, audio, {
    what: "听音",
    noun: "音频",
    defaultPrompt: DEFAULT_AUDIO_PROMPT,
    fallbackMime: "audio/mpeg",
  });
}

/**
 * 让多模态模型看一段视频，返回一段文字。请求形状见 inlineMedia。
 *
 * ── 这条路是实测验过的，不是照文档抄的 ──
 *
 * 用一段刻意设计成「答案没法猜」的测试视频（画面上写着 CAT 42、一个绿方块
 * 从左匀速移到右）问过用户那五家中转站：文字、颜色、**移动方向**三样全对，
 * 而方向这件事只看一帧是答不出来的。中途还反过来验过一次 —— 第一版测试视频
 * 我的 ffmpeg 命令写错了、方块压根没画上去，五家**一致说「没有方块、画面
 * 静止」**，没有一家顺着提问编一个出来。所以画面是真读进去了。
 *
 * ── 但体积卡得很死 ──
 *
 * 同一批实测：12MB 有一家（网关那层）直接 413；52MB 五家里两家 413。所以
 * 上游能不能吃下来跟中转站强相关，调用方必须先过 MAX_VIDEO_BYTES 那道闸
 * （见 imessage.js:readVideo），别指望这里能兜。
 *
 * @param {object} endpoint 看视频模型的 endpoint（url / key / model / label）
 * @param {string} prompt 提示词，空则用 DEFAULT_VIDEO_PROMPT
 * @param {{base64:string, mimeType:string, name?:string, seconds?:number}} video
 * @returns {Promise<string>} 画面描述
 */
export async function describeVideo(endpoint, prompt, video) {
  return inlineMedia(endpoint, prompt, video, {
    what: "看视频",
    noun: "视频",
    defaultPrompt: DEFAULT_VIDEO_PROMPT,
    fallbackMime: "video/mp4",
  });
}

/**
 * 把一段文字算成向量，给记忆库做语义检索。
 *
 * 打的是 `/embeddings` 而不是 `/chat/completions` —— 这是这个文件里唯一
 * 不走后者的接口。别的都一样：同一批服务商源、同一套密钥轮换（endpoint 由
 * config.js 的 resolveEndpoint 解析好传进来），所以「向量」是模型的第四个
 * 分类，而不是另一套单独配的凭据。
 *
 * **重试次数比聊天少**：这条在每轮消息的关键路径上（拼提示词时要检索一次），
 * 让对方多等三轮重试不值得 —— 检索失败只是少注入几条旧记忆，退化成
 * 「只注入近 N 天」照样能回消息，见 prompt.js:memoryBlock。
 *
 * @param {{url:string,key:string,model:string,label?:string}} endpoint 向量模型
 * @param {string} text 要算的文本，调用方应先用 memory.js:truncate 截过
 * @param {{label?:string, timeout?:number, retries?:number}} [opts]
 * @returns {Promise<number[]>} 向量本身
 * @throws {Error} 带中文原因，调用方决定要不要退化
 */
export async function embedText(endpoint, text, opts = {}) {
  const label = opts.label ?? (endpoint?.label ? `向量 API（${endpoint.label}）` : "向量 API");
  const base = trimBase(endpoint?.url);
  const key = endpoint?.key ?? "";
  const model = endpoint?.model ?? "";
  const input = String(text ?? "").trim();

  if (!base) throw new Error(`${label} 没填接口地址`);
  if (!key) throw new Error(`${label} 没填密钥`);
  if (!model) throw new Error(`${label} 没填模型名`);
  // 空文本算出来的向量没有意义，白花一次请求
  if (!input) throw new Error(`${label} 收到空文本`);

  const delays = RETRY_DELAYS.slice(0, opts.retries ?? 1);

  let result;
  for (let attempt = 0; ; attempt += 1) {
    const retryIn = delays[attempt];
    try {
      result = await requestJson(`${base}/embeddings`, {
        key,
        body: { model, input },
        timeout: opts.timeout ?? REQUEST_TIMEOUT,
      });
    } catch (e) {
      const why = describeNetworkError(e, opts.timeout ?? REQUEST_TIMEOUT);
      if (retryIn !== undefined && isTransient(null, e)) {
        logWarn(label, `第 ${attempt + 1} 次请求失败，${retryIn}ms 后重试`, why);
        await wait(retryIn);
        continue;
      }
      throw new Error(`${label} 请求失败：${why}`);
    }

    if (result.ok) break;

    const why = describeUpstream(result.status, result.text, result.data);
    if (retryIn !== undefined && isTransient(result.status, null)) {
      logWarn(label, `第 ${attempt + 1} 次${why}，${retryIn}ms 后重试`);
      await wait(retryIn);
      continue;
    }
    logUpstreamFailure(label, result.status, result.text, { model });
    throw new Error(`${label} ${why}`);
  }

  const vector = result.data?.data?.[0]?.embedding;
  if (!Array.isArray(vector) || !vector.length) {
    throw new Error(
      `${label} 返回格式看不懂（缺 data[0].embedding）：${result.text.slice(0, 300)}`
    );
  }
  // 有的中转站会把数字发成字符串，这里统一成 number —— 余弦那边要算术运算
  return vector.map((n) => Number(n) || 0);
}