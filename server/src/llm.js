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
import { DEFAULT_AUDIO_PROMPT, DEFAULT_VISION_PROMPT } from "./config.js";
import { proxyFor } from "./proxy.js";

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
 */
function isTransient(status, error) {
  if (status) return status === 429 || (status >= 500 && status <= 504);
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return true;
  const code = error?.cause?.code ?? "";
  return (
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_SOCKET" ||
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "EAI_AGAIN" || // DNS 临时故障（ENOTFOUND 是真打错了，不重试）
    /Connect Timeout/i.test(error?.cause?.message ?? "")
  );
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
 */
function moveModelTail(messages, label) {
  const out = (Array.isArray(messages) ? messages : []).slice();
  // 尾部可能连着好几条（预设里能写多条预填条目），一路收到不是 assistant 为止
  const tails = [];
  while (out.length && out.at(-1)?.role === "assistant") {
    const content = out.pop()?.content;
    if (typeof content === "string") tails.unshift(content);
  }
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

  logWarn(
    label,
    "这个模型不收以 assistant 结尾的消息数组，末尾的预填已改挂到 user 名下",
    text
      ? `预填正文（${text.length} 字）并进了最后一条 user，预填本身的效果在这个模型上拿不到`
      : "预填是空的，整条去掉了"
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
function describeUpstream(status, text, data) {
  const detail =
    data?.error?.message ??
    data?.error?.code ??
    data?.message ??
    (typeof data?.error === "string" ? data.error : null) ??
    (text ? text.slice(0, UPSTREAM_DETAIL_MAX) : "");
  // 不带「API」二字：调用方会在前面拼 label（「主 API」「视觉 API」），
  // 否则会拼出「视觉 API API 返回 429」这种叠字
  return `返回 ${status}${detail ? `：${detail}` : ""}`;
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
 * 每种情况后面都带上原始错误码：这句话会原样发到用户的 iMessage 里
 * （见 imessage.js:notifyFailure），有个能搜的关键词比一句中文描述管用。
 */
function describeNetworkError(e) {
  if (e?.name === "TimeoutError" || e?.name === "AbortError") {
    return `上游超时，没在限定时间内响应（代码 ${e.name}）`;
  }

  const cause = e?.cause;
  if (cause) {
    const code = cause.code ?? "";
    const tail = code ? `（代码 ${code}）` : "";
    // 常见几种给一句中文解释，其余原样带出来
    if (code === "UND_ERR_CONNECT_TIMEOUT" || /Connect Timeout/i.test(cause.message ?? "")) {
      return `连不上接口地址，TCP 连接超时，可能是网络不通、被墙或需要代理${
        tail || "（代码 UND_ERR_CONNECT_TIMEOUT）"
      }`;
    }
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
      return `域名解析失败，接口地址是不是打错了？${tail}`;
    }
    if (code === "ECONNREFUSED") return `对方拒绝连接，端口不对或服务没起来${tail}`;
    if (code === "ECONNRESET") return `连接被对方掐断了${tail}`;
    if (code?.startsWith?.("ERR_TLS") || code === "CERT_HAS_EXPIRED") {
      return `HTTPS 证书有问题${tail}`;
    }
    const detail = cause.message ?? String(cause);
    return `${e.message}：${detail}${tail}`;
  }

  return String(e?.message ?? e);
}

/**
 * 发一个 JSON 请求并把响应解析好。
 *
 * `headers` 给非 OpenAI 形状的接口用（Gemini 原生那条路要的是
 * `x-goog-api-key` 而不是 `Authorization`，见 transcribeAudio）。给了它就
 * 完全接管鉴权头，`key` 不再自动拼成 Bearer。
 *
 * @returns {Promise<{ok: boolean, status: number, data: any, text: string}>}
 */
async function requestJson(
  url,
  { method = "POST", key, body, timeout = REQUEST_TIMEOUT, headers }
) {
  const res = await fetch(url, {
    method,
    headers: headers ?? {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
    // 模型 API 那一类**默认不走代理**：中转站在国内直连本来就通，套上代理多半
    // 更慢，还可能因为落地 IP 变了被风控。要走的话在控制台的「代理」那节勾上
    ...(await proxyFor("llm")),
  });

  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* 非 JSON：调用方按 status/text 处理 */
  }
  return { ok: res.ok, status: res.status, data, text };
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
 * @param {{label?:string, timeout?:number, maxTokens?:number, retries?:number,
 *          params?:object}} [opts] label 只用于日志；params 见 preset.js 的
 *        DEFAULT_PARAMS（温度 / Top P / 最大token / 频率惩罚 / 存在惩罚）
 */
export async function chatCompletion(endpoint, messages, opts = {}) {
  const label = opts.label ?? "API";
  const base = trimBase(endpoint?.url);
  const key = endpoint?.key ?? "";
  const model = endpoint?.model ?? "";

  if (!base) throw new Error(`${label} 没填接口地址`);
  if (!key) throw new Error(`${label} 没填密钥`);
  if (!model) throw new Error(`${label} 没填模型名`);

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

  // 测试连接这类「用户正盯着等结果」的场合可以传 retries: 0 关掉重试
  const delays = RETRY_DELAYS.slice(0, opts.retries ?? RETRY_DELAYS.length);

  const startedAt = Date.now();
  let result;
  /*
   * attempt 只数「因为网络抖动 / 上游 5xx 重打」的次数，它决定下次等多久。
   * 下面「脱参数重打」那条路**不算**在里面：那不是碰运气再试一次，是换了个
   * 请求体，既不该占抖动的重试额度，也没有等的必要。
   */
  let attempt = 0;
  for (;;) {
    const retryIn = delays[attempt];
    try {
      result = await requestJson(`${base}/chat/completions`, {
        key,
        body,
        timeout: opts.timeout ?? REQUEST_TIMEOUT,
      });
    } catch (e) {
      const why = describeNetworkError(e);
      if (retryIn !== undefined && isTransient(null, e)) {
        logWarn(label, `第 ${attempt + 1} 次请求失败，${retryIn}ms 后重试`, why);
        attempt += 1;
        await wait(retryIn);
        continue;
      }
      throw new Error(`${label} 请求失败：${why}`);
    }

    if (result.ok) break;

    const why = describeUpstream(result.status, result.text, result.data);
    if (retryIn !== undefined && isTransient(result.status, null)) {
      logWarn(label, `第 ${attempt + 1} 次${why}，${retryIn}ms 后重试`);
      attempt += 1;
      await wait(retryIn);
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

    // 摘要那句会被截断（要发成短信），全文只在日志里 —— 这是最后一次机会
    logUpstreamFailure(label, result.status, result.text, body);
    throw new Error(`${label} ${why}`);
  }

  const ms = Date.now() - startedAt;

  const content = result.data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error(
      `${label} 返回格式看不懂（缺 choices[0].message.content）：${result.text.slice(0, 300)}`
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
 * @returns {Promise<{content: string, usedFallback: boolean}>}
 * @throws {Error} 两条线都失败时抛出，消息里带上两边的原因
 */
export async function chatWithFallback(primary, fallback, messages, params = {}) {
  const primaryLabel = primary?.label ? `主 API（${primary.label}）` : "主 API";
  const fallbackLabel = fallback?.label ? `副 API（${fallback.label}）` : "副 API";

  try {
    const content = await chatCompletion(primary ?? {}, messages, {
      label: primaryLabel,
      params,
      timeout: CHAT_TIMEOUT,
    });
    return { content, usedFallback: false };
  } catch (primaryError) {
    const primaryMsg = String(primaryError?.message ?? primaryError);

    if (!endpointUsable(fallback)) {
      /*
       * 括号里这句是**补充说明**，不是失败原因。
       *
       * 原文是「副 API 没启用或引用的模型已失效」，跟在一句 401 / 503 后面读起来
       * 像在说「因为副 API 没开所以这轮废了」—— 收到的用户反馈全是跑去折腾副
       * API、连换好几家模型，换一圈还是同样的报错，因为真正的原因一直摆在
       * 前半句里（密钥无效 / 上游容量不够）。所以这里明说两件事：前面那句是
       * 谁回的，以及我们为什么没换线。
       */
      const why = !fallback
        ? "这是模型服务商回的；副 API 没开着，换不了线"
        : "这是模型服务商回的；副 API 信息不全（地址/密钥/模型缺一项），换不了线";
      logError("LLM", `主 API 失败，且${why}`, primaryMsg);
      throw new Error(`${primaryMsg}（${why}）`);
    }

    logWarn("LLM", "主 API 失败，改用副 API", primaryMsg);

    try {
      const content = await chatCompletion(fallback, messages, {
        label: fallbackLabel,
        params,
        timeout: CHAT_TIMEOUT,
      });
      logInfo("LLM", "副 API 顶上了，这轮由它回复");
      return { content, usedFallback: true };
    } catch (fallbackError) {
      const fallbackMsg = String(fallbackError?.message ?? fallbackError);
      logError("LLM", "主副两条 API 都失败", `主：${primaryMsg}\n副：${fallbackMsg}`);
      throw new Error(`主副都失败 —— 主：${primaryMsg}；副：${fallbackMsg}`);
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
    const error = `${label} 拉模型失败：${describeNetworkError(e)}`;
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
  if (!text) throw new Error("视觉 API 返回了空描述");
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
 * 让多模态模型听一段音频，返回一段文字。
 *
 * **这是这个文件里唯一不打 OpenAI 兼容接口的聊天类请求**，所以没复用
 * chatCompletion，理由是实测出来的：OpenAI 那个
 * `{type:"input_audio", input_audio:{data, format}}` 字段，三家中转站
 * 没有一家往上游透传 —— 模型收到的是一条没有音频的空消息，然后开始编。
 * 换成 Gemini 原生的 `inline_data` 打 `:generateContent` 就全通了。
 *
 * 除了请求形状，别的都和这个文件里其他函数一样：同一批服务商源、同一套
 * 密钥轮换（endpoint 由 config.js:resolveEndpoint 解析好传进来）、同一套
 * 重试规则、同一套错误摘要。
 *
 * @param {object} endpoint 听音模型的 endpoint（url / key / model / label）
 * @param {string} prompt 听音提示词，空则用 DEFAULT_AUDIO_PROMPT
 * @param {{base64:string, mimeType:string, name?:string, seconds?:number}} audio
 * @returns {Promise<string>} 转写/描述文本
 * @throws {Error} 识别失败
 */
export async function transcribeAudio(endpoint, prompt, audio) {
  const label = endpoint?.label ? `听音 API（${endpoint.label}）` : "听音 API";
  const base = trimBase(endpoint?.url);
  const key = endpoint?.key ?? "";
  const model = endpoint?.model ?? "";

  if (!base) throw new Error(`${label} 没填接口地址`);
  if (!key) throw new Error(`${label} 没填密钥`);
  if (!model) throw new Error(`${label} 没填模型名`);
  if (!audio?.base64) throw new Error(`${label} 拿到的是一段空音频`);

  const usePrompt = String(prompt ?? "").trim() || DEFAULT_AUDIO_PROMPT;
  const mimeType = audio.mimeType || "audio/mpeg";
  const url = geminiNativeUrl(base, model);

  /*
   * parts 的顺序：音频在前、提示词在后。
   *
   * 官方文档的例子就是这个顺序，参考插件也是。反过来放不会报错，但
   * 「先听完再看要求」比「先看要求再听」更贴近模型的注意力实现。
   */
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { inline_data: { mime_type: mimeType, data: audio.base64 } },
          { text: usePrompt },
        ],
      },
    ],
  };

  const headers = isOfficialGemini(base)
    ? { "Content-Type": "application/json", "x-goog-api-key": key }
    : { "Content-Type": "application/json", Authorization: `Bearer ${key}` };

  const kb = Math.round((audio.base64.length * 3) / 4 / 1024);
  logDebug(
    "听音",
    `开始识别语音${audio.name ? `「${audio.name}」` : ""}（约 ${kb}KB, ${mimeType}${
      audio.seconds ? `, ${audio.seconds.toFixed(1)}s` : ""
    }）`,
    `POST ${url}`
  );

  const delays = RETRY_DELAYS;
  const startedAt = Date.now();
  let result;
  for (let attempt = 0; ; attempt += 1) {
    const retryIn = delays[attempt];
    try {
      // 音频体积和图片一个量级（甚至更大），超时跟着识图一起放宽
      result = await requestJson(url, { body, headers, timeout: VISION_TIMEOUT });
    } catch (e) {
      const why = describeNetworkError(e);
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
    // 请求体里绝大部分是 base64 音频，原样记进日志没意义也没法看，
    // 所以这里不走 logUpstreamFailure（它是照 OpenAI 的 messages 结构写的）
    logWarn(
      label,
      `上游返回 ${result.status}，完整响应体如下`,
      `请求：${model}，音频 ${kb}KB / ${mimeType}\n响应：${result.text || "（空响应体）"}`
    );
    throw new Error(`${label} ${why}`);
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
    throw new Error(
      `${label} 返回了空结果${reason ? `（${reason}）` : ""}：${result.text.slice(0, 300)}`
    );
  }

  const usage = result.data?.usageMetadata;
  logDebug(
    "听音",
    `${model} 回了 ${text.length} 字，耗时 ${ms}ms`,
    usage ? `token 用量：${JSON.stringify(usage)}` : undefined
  );

  return text;
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
      const why = describeNetworkError(e);
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