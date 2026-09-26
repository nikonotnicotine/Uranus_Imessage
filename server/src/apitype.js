/**
 * 服务商源的「API 类型」：同一份 OpenAI 形状的请求，落到各家原生接口上长什么样。
 *
 * 四种类型（config.js:PROVIDER_TYPES）：
 *
 *  - `custom`    自定义。OpenAI 兼容的 `/chat/completions`，中转站、自建反代都是这种。
 *                老版本升上来的、没选过类型的一律是它 —— 行为和以前一个字都不差。
 *  - `openai`    OpenAI 官方。请求形状和 custom **完全一样**，区别只在新建时预填的
 *                地址。单列出来是给用户一个「我选的就是官方」的入口，不是另一套协议。
 *  - `gemini`    Google 官方原生接口：`/v1beta/models/{model}:generateContent`，
 *                `x-goog-api-key` 鉴权，安全过滤全关。
 *  - `anthropic` Claude 官方原生接口：`/v1/messages`，`x-api-key` 鉴权。
 *
 * ── 为什么在「发出去那一刻」才翻译 ──
 *
 * llm.js 的 chatCompletion 里那个重试循环攒了一大堆判断：抖动退避、上游嫌弃哪个
 * 参数就脱掉哪个、stream 不收就改整段、被内容安全拦了换说法……它们全都是改
 * **OpenAI 形状的 body**。如果每种类型各写一套请求体，这些判断就得各抄一份，
 * 漏改一处只在真出错时才暴露。
 *
 * 所以 body 永远是 OpenAI 形状，循环照旧改它；每一圈发请求之前才翻译成原生
 * 形状，收到响应再翻回 `choices[0].message.content`。循环里的代码看不出这一轮
 * 打的是谁家。
 */

/** 去掉末尾斜杠。和 llm.js / media.js 里那份是同一个规矩。 */
function trimBase(url) {
  return String(url ?? "").trim().replace(/\/+$/, "");
}

/** 剥掉第一个命中的后缀。列表要按从长到短排，不然长的那条永远轮不到。 */
function stripSuffix(url, suffixes) {
  const base = trimBase(url);
  const hit = suffixes.find((s) => base.endsWith(s));
  return hit ? base.slice(0, -hit.length) : base;
}

/** 端点上的类型。缺的、不认识的一律当自定义 —— 和 config.js 的规矩一致。 */
export function apiType(endpoint) {
  const t = endpoint?.type;
  return t === "openai" || t === "gemini" || t === "anthropic" ? t : "custom";
}

/** 这个类型打的是不是原生接口（要翻译请求体的那两种）。 */
export function isNativeType(type) {
  return type === "gemini" || type === "anthropic";
}

/** 中文叫法，进错误文案用。 */
export const API_TYPE_NAMES = {
  custom: "自定义",
  openai: "OpenAI",
  gemini: "Google Gemini",
  anthropic: "Anthropic Claude",
};

/* ================= Gemini ================= */

/**
 * Gemini 官方自己的域名。官方认 `x-goog-api-key`；中转站前面多半挡着一层
 * OpenAI 网关，认的是 `Authorization: Bearer`。
 */
const GEMINI_OFFICIAL_HOSTS = new Set([
  "generativelanguage.googleapis.com",
  "aiplatform.googleapis.com",
]);

export function isOfficialGemini(url) {
  try {
    return GEMINI_OFFICIAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Gemini 接口的根（域名那一层）。
 *
 * 用户可能照着 OpenAI 的习惯填到 `/v1`，也可能照 Google 文档填到 `/v1beta`，
 * 或者直接贴了 OpenAI 兼容层的地址 `/v1beta/openai`。都剥到根上再拼原生路径。
 */
export function geminiRoot(url) {
  return stripSuffix(url, [
    "/v1beta/openai/chat/completions",
    "/v1/chat/completions",
    "/v1beta/openai",
    "/v1beta",
    "/v1",
  ]);
}

/**
 * `{根}/v1beta/models/{模型}:{方法}`。
 *
 * 模型名只剥一个 `models/` 前缀 —— 官方的模型列表回的名字自带它
 * （`models/gemini-2.5-pro`），拼进路径就成了 `models/models/…`。别的一概不动。
 */
export function geminiModelUrl(url, model, method) {
  const name = String(model ?? "").replace(/^models\//, "");
  return `${geminiRoot(url)}/v1beta/models/${encodeURIComponent(name)}:${method}`;
}

/**
 * 官方只认 `x-goog-api-key`。别的域名（反代到 Google 的中转站）两个头都带上：
 * 透传给 Google 的那种认前者，前面挡着网关的认后者，多带一个不碍事。
 */
export function geminiHeaders(url, key) {
  return {
    "Content-Type": "application/json",
    "x-goog-api-key": key,
    ...(isOfficialGemini(url) ? {} : { Authorization: `Bearer ${key}` }),
  };
}

/**
 * 安全过滤全关。
 *
 * 默认档会把角色扮演里再平常不过的情节拦掉，而且拦下来是一段空回复 ——
 * 走中转站的时候中转站替你关了，直连官方就得自己关。
 */
export const GEMINI_SAFETY_OFF = [
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
].map((category) => ({ category, threshold: "BLOCK_NONE" }));

/** 这几个 finishReason 意思都是「被审核拦了」，不是模型自己没话说。 */
const GEMINI_BLOCK_FINISH = /^(SAFETY|PROHIBITED_CONTENT|BLOCKLIST|SPII|RECITATION|IMAGE_SAFETY)$/;

/* ================= Anthropic ================= */

const ANTHROPIC_OFFICIAL_HOST = "api.anthropic.com";

/** 接口版本头。这是 Messages API 唯一的版本号，新功能走 beta 头，不改它。 */
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Claude 必须带 max_tokens，不带直接 400。预设里「最大 token」填 0 的意思是
 * 「不限制、交给上游」，而这家上游不接受「不限制」—— 给一个够聊天用的数。
 * 撞上某个老模型的上限时 llm.js 会照上游报的上限改小重打（maxTokensCap）。
 */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 8192;

export function isOfficialAnthropic(url) {
  try {
    return new URL(url).hostname === ANTHROPIC_OFFICIAL_HOST;
  } catch {
    return false;
  }
}

/** `/v1/messages` 前面那一截。填到 `/v1` 或者整条贴进来都认。 */
export function anthropicRoot(url) {
  return stripSuffix(url, ["/v1/messages", "/v1"]);
}

/**
 * 官方只要 `x-api-key`。别的域名同样两个头都带：官方那边 `Authorization` 是
 * 给 OAuth 令牌用的，带了普通密钥反而会被拒，所以只对非官方域名加。
 */
export function anthropicHeaders(url, key) {
  return {
    "Content-Type": "application/json",
    "x-api-key": key,
    "anthropic-version": ANTHROPIC_VERSION,
    ...(isOfficialAnthropic(url) ? {} : { Authorization: `Bearer ${key}` }),
  };
}

/**
 * 流里的 `error` 事件没有 HTTP 状态码（响应头早就发成 200 了），按错误类型
 * 补一个，好让 llm.js 那套「429/5xx 退避重试」照样认得出来。
 */
const ANTHROPIC_ERROR_STATUS = {
  invalid_request_error: 400,
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  overloaded_error: 529,
};

/* ================= 请求体翻译 ================= */

/**
 * 拆一条 OpenAI 消息的 content：字符串，或者 `[{type:"text"}, {type:"image_url"}]`。
 * 图片只认 data URI 的字节（识图那条路就是这么拼的，见 llm.js:describeImage），
 * 别的 URL 原样留着交给各家自己决定怎么放。
 *
 * @returns {Array<{text:string}|{image:{mime:string,data:string}}|{imageUrl:string}>}
 */
function partsOf(content) {
  if (typeof content === "string") return [{ text: content }];
  if (!Array.isArray(content)) return content == null ? [] : [{ text: String(content) }];
  const out = [];
  for (const p of content) {
    if (typeof p === "string") out.push({ text: p });
    else if (p?.type === "text") out.push({ text: String(p.text ?? "") });
    else if (p?.type === "image_url") {
      const url = String(p.image_url?.url ?? p.image_url ?? "");
      const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
      if (m) out.push({ image: { mime: m[1], data: m[2] } });
      else if (url) out.push({ imageUrl: url });
    }
  }
  return out;
}

/**
 * 按角色归拢：system 一律提出去（中转站也是这么干的 —— 所有 system 收进
 * systemInstruction，不管它在数组的哪儿），其余相邻同角色的并成一条。
 *
 * 「所有 system 都提走」这件事刻意和中转站保持一致：预设是照着中转站的行为
 * 调出来的，换成直连之后同一份预设应该得到同一个效果。
 */
function splitRoles(messages, convert) {
  const system = [];
  const turns = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const parts = partsOf(m?.content);
    if (m?.role === "system") {
      for (const p of parts) if (p.text?.trim()) system.push(p.text);
      continue;
    }
    const role = m?.role === "assistant" ? "assistant" : "user";
    const blocks = parts.map(convert).filter(Boolean);
    if (!blocks.length) continue;
    const prev = turns.at(-1);
    if (prev?.role === role) prev.blocks.push(...blocks);
    else turns.push({ role, blocks });
  }
  return { system: system.join("\n\n"), turns };
}

/** OpenAI body → Gemini `generateContent` 的请求体。 */
export function toGeminiBody(body) {
  const { system, turns } = splitRoles(body?.messages, (p) => {
    if (p.image) return { inline_data: { mime_type: p.image.mime, data: p.image.data } };
    if (p.imageUrl) return { text: `[图片] ${p.imageUrl}` };
    return p.text ? { text: p.text } : null;
  });

  let sys = system;
  const contents = turns.map((t) => ({
    role: t.role === "assistant" ? "model" : "user",
    parts: t.blocks,
  }));
  // contents 不能是空的。整个请求只有 system 的时候（有这种总结链），把它挪成 user
  if (!contents.length) {
    contents.push({ role: "user", parts: [{ text: sys || "…" }] });
    sys = "";
  }

  const gen = {};
  if (typeof body?.temperature === "number") gen.temperature = body.temperature;
  if (typeof body?.top_p === "number") gen.topP = body.top_p;
  if (body?.max_tokens > 0) gen.maxOutputTokens = body.max_tokens;
  // 两个惩罚项不翻：好几个 Gemini 型号收到就 400，而它们对聊天效果几乎没影响

  return {
    ...(sys ? { systemInstruction: { parts: [{ text: sys }] } } : {}),
    contents,
    ...(Object.keys(gen).length ? { generationConfig: gen } : {}),
    safetySettings: GEMINI_SAFETY_OFF,
  };
}

/** OpenAI body → Anthropic `/v1/messages` 的请求体。 */
export function toAnthropicBody(body, streaming) {
  const { system, turns } = splitRoles(body?.messages, (p) => {
    if (p.image) {
      return { type: "image", source: { type: "base64", media_type: p.image.mime, data: p.image.data } };
    }
    if (p.imageUrl) return { type: "image", source: { type: "url", url: p.imageUrl } };
    // 纯空白的文本块上游不收（text content blocks must contain non-whitespace text）
    return p.text?.trim() ? { type: "text", text: p.text } : null;
  });

  let sys = system;
  const messages = turns.map((t) => ({ role: t.role, content: t.blocks }));
  if (!messages.length) {
    messages.push({ role: "user", content: [{ type: "text", text: sys || "…" }] });
    sys = "";
  }

  // 预填（最后一条是 assistant）的末尾不能带空白，否则 400
  const last = messages.at(-1);
  if (last.role === "assistant") {
    const tail = last.content.at(-1);
    if (tail?.type === "text") {
      tail.text = tail.text.trimEnd();
      if (!tail.text) last.content.pop();
      if (!last.content.length) messages.pop();
    }
  }

  const out = {
    model: body?.model,
    max_tokens: body?.max_tokens > 0 ? body.max_tokens : ANTHROPIC_DEFAULT_MAX_TOKENS,
    messages,
  };
  if (sys) out.system = sys;
  /*
   * 温度只收 0～1（OpenAI 那边是 0～2），夹一下。
   * top_p 和 temperature 在新一代 Claude 上**不能同时带**，带了就 400；预设里两个
   * 永远都有值，所以只在没有温度、而且 top_p 不是默认的 1 时才发它。
   */
  if (typeof body?.temperature === "number") {
    out.temperature = Math.min(1, Math.max(0, body.temperature));
  } else if (typeof body?.top_p === "number" && body.top_p < 1) {
    out.top_p = body.top_p;
  }
  if (streaming) out.stream = true;
  return out;
}

/**
 * 一次聊天请求的「发到哪、带什么头、发什么」。
 *
 * custom / openai 原样返回（headers 为 null = 用默认的 Bearer）；另外两种每次都
 * 从当下的 body 重新翻译 —— 循环可能刚脱掉一个参数、换了一句说法。
 *
 * @returns {{url:string, headers:object|null, body:object, decode:Function|null, native:boolean}}
 */
export function chatRequest(type, base, key, body, streaming) {
  if (type === "gemini") {
    return {
      url: geminiModelUrl(
        base,
        body.model,
        streaming ? "streamGenerateContent?alt=sse" : "generateContent"
      ),
      headers: geminiHeaders(base, key),
      body: toGeminiBody(body),
      decode: decodeGeminiChunk,
      native: true,
    };
  }
  if (type === "anthropic") {
    return {
      url: `${anthropicRoot(base)}/v1/messages`,
      headers: anthropicHeaders(base, key),
      body: toAnthropicBody(body, streaming),
      decode: decodeAnthropicChunk,
      native: true,
    };
  }
  return { url: `${base}/chat/completions`, headers: null, body, decode: null, native: false };
}

/* ================= 响应翻译 ================= */

/** 被审核拦下时交给 llm.js 的那句话 —— 措辞刻意撞上它的 BLOCK_PATTERNS（safety filter）。 */
function blockedText(vendor, field, reason) {
  return `${vendor} safety filter blocked this request (${field}: ${reason})`;
}

/** 一段 Gemini 响应（整包或者流里的一帧）里的正文和附带信息。 */
function readGemini(data) {
  const cand = data?.candidates?.[0];
  // thought 为 true 的是思考过程，不是正文
  const text = (cand?.content?.parts ?? [])
    .filter((p) => typeof p?.text === "string" && !p.thought)
    .map((p) => p.text)
    .join("");
  const finish = cand?.finishReason ?? null;
  const promptBlock = data?.promptFeedback?.blockReason;
  let blocked = null;
  if (promptBlock) blocked = blockedText("Gemini", "blockReason", promptBlock);
  else if (!text && finish && GEMINI_BLOCK_FINISH.test(finish)) {
    blocked = blockedText("Gemini", "finishReason", finish);
  }
  return {
    text,
    finish,
    usage: data?.usageMetadata ?? null,
    model: data?.modelVersion ?? "",
    blocked,
    hasCandidates: Array.isArray(data?.candidates),
  };
}

/** 整包的 Claude 响应。 */
function readAnthropic(data) {
  const text = (Array.isArray(data?.content) ? data.content : [])
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
  const finish = data?.stop_reason ?? null;
  return {
    text,
    finish,
    usage: data?.usage ?? null,
    model: data?.model ?? "",
    blocked: finish === "refusal" && !text ? blockedText("Claude", "stop_reason", finish) : null,
    hasCandidates: Array.isArray(data?.content),
  };
}

/** 原生错误体里挑一个像样的 HTTP 状态码（200 里夹带错误那种用得上）。 */
function statusOfError(error, fallback) {
  const code = Number(error?.code);
  if (code >= 400 && code <= 599) return code;
  return ANTHROPIC_ERROR_STATUS[error?.type] ?? fallback;
}

/**
 * 原生响应翻回 llm.js 认的 `{ok, status, data:{choices:[…]}, text}`。
 *
 * 已经是 OpenAI 形状的（流式那条路在 requestStream 里就拼好了）原样放过；
 * 翻不出来的也原样放过，让 chatCompletion 照旧报「返回格式看不懂」并带上原文。
 */
export function nativeResult(type, result) {
  if (!result?.ok || result.data?.choices) return result;
  const data = result.data;
  if (!data || typeof data !== "object") return result;

  // 200 里夹着一个错误（中转站把上游的失败原样转出来）：当失败处理
  if (data.error) {
    return { ...result, ok: false, status: statusOfError(data.error, result.status) };
  }

  const r = type === "gemini" ? readGemini(data) : readAnthropic(data);
  if (r.blocked) {
    return { ok: false, status: 400, data: { error: { message: r.blocked } }, text: r.blocked };
  }
  if (!r.hasCandidates) return result;

  return {
    ok: true,
    status: result.status,
    data: {
      ...(r.model ? { model: r.model } : {}),
      choices: [{ index: 0, message: { role: "assistant", content: r.text }, finish_reason: r.finish }],
      ...(r.usage ? { usage: r.usage } : {}),
    },
    text: result.text,
  };
}

/*
 * 流式的每一帧怎么读。约定（llm.js:requestStream 用）：返回
 *   { piece?, finish?, usage?, model?, error?, status?, blocked?, stop? }
 * 或 null（这帧没东西）。
 */

/** Gemini 的 SSE：每帧就是一个完整的 generateContent 响应，只是正文是增量。 */
export function decodeGeminiChunk(chunk) {
  if (chunk?.error) return { error: chunk.error, status: statusOfError(chunk.error, 200) };
  const r = readGemini(chunk);
  return {
    piece: r.text,
    finish: r.finish,
    usage: r.usage,
    model: r.model,
    blocked: r.blocked,
  };
}

/** Claude 的 SSE：按事件类型分。只收 text_delta，thinking_delta 是思考过程不算正文。 */
export function decodeAnthropicChunk(chunk) {
  switch (chunk?.type) {
    case "message_start":
      return { model: chunk.message?.model, usage: chunk.message?.usage };
    case "content_block_delta":
      return chunk.delta?.type === "text_delta" ? { piece: chunk.delta.text } : null;
    case "message_delta": {
      const finish = chunk.delta?.stop_reason ?? null;
      return {
        finish,
        usage: chunk.usage,
        blocked: finish === "refusal" ? blockedText("Claude", "stop_reason", finish) : null,
      };
    }
    case "message_stop":
      return { stop: true };
    case "error":
      return { error: chunk.error, status: statusOfError(chunk.error, 200) };
    default:
      return null;
  }
}
