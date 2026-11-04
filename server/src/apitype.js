/**
 * 服务商源的「API 类型」：同一份 OpenAI 形状的请求，落到各家原生接口上长什么样。
 *
 * 六种类型（config.js:PROVIDER_TYPES）：
 *
 *  - `custom`    自定义。OpenAI 兼容的 `/chat/completions`，中转站、自建反代都是这种。
 *                老版本升上来的、没选过类型的一律是它 —— 行为和以前一个字都不差。
 *  - `openai`    OpenAI 官方。请求形状和 custom **完全一样**，区别只在新建时预填的
 *                地址。单列出来是给用户一个「我选的就是官方」的入口，不是另一套协议。
 *  - `gemini`    Google AI Studio 的原生接口：`/v1beta/models/{model}:generateContent`，
 *                `x-goog-api-key` 鉴权，安全过滤全关。
 *  - `vertex`    Google Vertex AI（GCP 那套）：
 *                `/v1/projects/{项目}/locations/{区域}/publishers/{厂商}/models/{模型}:{方法}`，
 *                服务账号签 JWT 换 access token 鉴权（细节在 vertex.js）。
 *                **同一个类型下有两种请求体** —— 模型名带 `claude` 的是 Vertex 上托管的
 *                Claude，走 `publishers/anthropic` + `:rawPredict`，请求体是 Claude 那套；
 *                其余走 `publishers/google` + `:generateContent`，请求体是 Gemini 那套。
 *                和 `gemini` 是两条完全分开的线（模型名、计费、配额都不通用），所以是两种
 *                类型，不是一种类型的两个地址。
 *  - `anthropic` Claude 官方原生接口：`/v1/messages`，`x-api-key` 鉴权。
 *  - `novelai`   NovelAI 生图：`/ai/generate-image`，只能画图，聊天那条路不走它
 *                （请求在 media.js:novelaiImage 里拼，这个文件只认个名字）。
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
 *
 * ── 为什么 chatRequest 是 async ──
 *
 * 只有 Vertex 一家需要：服务账号那条路要先用私钥签个 JWT 换 access token。
 * 换出来的 token 在 vertex.js 里缓存着，所以绝大多数圈数并不真打网络 ——
 * 但第一圈会，签名本身也是异步的（WebCrypto），所以这个函数只能是 async。
 */

import {
  isVertexClaude,
  vertexAuth,
  vertexModelUrl,
} from "./vertex.js";

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
  return t === "openai" || t === "gemini" || t === "vertex" || t === "anthropic" || t === "novelai"
    ? t
    : "custom";
}

/** 这个类型打的是不是原生接口（要翻译请求体的那几种）。 */
export function isNativeType(type) {
  return type === "gemini" || type === "vertex" || type === "anthropic";
}

/** 中文叫法，进错误文案用。 */
export const API_TYPE_NAMES = {
  custom: "自定义",
  openai: "OpenAI",
  gemini: "Google Gemini",
  vertex: "Google Vertex AI",
  anthropic: "Anthropic Claude",
  novelai: "NovelAI",
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
function splitRoles(messages, convert, tooling = {}) {
  const system = [];
  const turns = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const parts = partsOf(m?.content);
    if (m?.role === "system") {
      for (const p of parts) if (p.text?.trim()) system.push(p.text);
      continue;
    }
    const role = m?.role === "assistant" ? "assistant" : "user";
    /*
     * 原生 function calling 的那两种消息（见 mcp.js）：assistant 带 tool_calls、
     * role 为 tool 的工具结果。两家原生接口都把工具结果算在 user 名下，
     * 所以 tool 消息并进 user 那一轮。
     */
    const blocks =
      m?.role === "tool"
        ? [tooling.result?.(m)].filter(Boolean)
        : parts.map(convert).filter(Boolean);
    if (role === "assistant" && Array.isArray(m?.tool_calls) && tooling.call) {
      blocks.push(...m.tool_calls.map(tooling.call).filter(Boolean));
    }
    if (!blocks.length) continue;
    const prev = turns.at(-1);
    if (prev?.role === role) prev.blocks.push(...blocks);
    else turns.push({ role, blocks });
  }
  return { system: system.join("\n\n"), turns };
}

/** tool_calls 里的 arguments 是 JSON 字符串，两家原生接口要的是对象。 */
function callArgs(tc) {
  const raw = tc?.function?.arguments;
  if (raw && typeof raw === "object") return raw;
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** 工具结果的正文。content 可能是字符串，也可能是 OpenAI 那种分段数组。 */
function toolText(m) {
  return partsOf(m?.content)
    .map((p) => p.text ?? "")
    .join("\n");
}

/**
 * Gemini 只认 OpenAPI 那个子集的 schema，多一个它不认的键（$schema、
 * additionalProperties 这些）就 400。MCP 服务器给的是完整的 JSON Schema，
 * 翻过去之前洗一遍。
 */
const GEMINI_SCHEMA_KEYS = new Set([
  "type",
  "description",
  "properties",
  "required",
  "items",
  "enum",
  "format",
  "nullable",
  "anyOf",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
]);
function geminiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (!GEMINI_SCHEMA_KEYS.has(k)) continue;
    if (k === "properties") {
      out.properties = Object.fromEntries(
        Object.entries(v ?? {}).map(([p, s]) => [p, geminiSchema(s)])
      );
    } else if (k === "type" && Array.isArray(v)) {
      // ["string", "null"] 这种：取第一个非 null 的，null 那半换成 nullable
      out.type = v.find((t) => t !== "null") ?? "string";
      if (v.includes("null")) out.nullable = true;
    } else if (k === "items" || k === "anyOf") {
      out[k] = geminiSchema(v);
    } else {
      out[k] = v;
    }
  }
  if (Array.isArray(out.enum)) out.enum = out.enum.map(String);
  return out;
}

/** OpenAI 的 tools → Gemini 的 functionDeclarations。 */
function geminiTools(tools) {
  const decls = tools.map((t) => {
    const params = geminiSchema(t.function?.parameters);
    // 没有参数的工具不能带一个空 properties 的 object（Gemini 会 400），干脆不带
    const empty = !params?.properties || !Object.keys(params.properties).length;
    return {
      name: t.function?.name,
      ...(t.function?.description ? { description: t.function.description } : {}),
      ...(empty ? {} : { parameters: params }),
    };
  });
  return [{ functionDeclarations: decls }];
}

/** OpenAI body → Gemini `generateContent` 的请求体。 */
export function toGeminiBody(body) {
  // 工具结果那头只有 tool_call_id，Gemini 的 functionResponse 要的是函数名
  const nameOf = new Map();
  for (const m of Array.isArray(body?.messages) ? body.messages : []) {
    for (const tc of Array.isArray(m?.tool_calls) ? m.tool_calls : []) {
      nameOf.set(tc.id, tc.function?.name);
    }
  }
  const { system, turns } = splitRoles(
    body?.messages,
    (p) => {
      if (p.image) return { inline_data: { mime_type: p.image.mime, data: p.image.data } };
      if (p.imageUrl) return { text: `[图片] ${p.imageUrl}` };
      return p.text ? { text: p.text } : null;
    },
    {
      call: (tc) => {
        // Gemini 3 要求把上一次的 thoughtSignature 原样带回去，不带就 400
        const sig = tc.extra_content?.google?.thought_signature;
        return {
          functionCall: { name: tc.function?.name, args: callArgs(tc) },
          ...(sig ? { thoughtSignature: sig } : {}),
        };
      },
      result: (m) => ({
        functionResponse: {
          name: nameOf.get(m.tool_call_id) ?? m.name ?? "tool",
          response: { result: toolText(m) },
        },
      }),
    }
  );

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

  /*
   * 少思考（通话那条路要的）。OpenAI 形状里是 `reasoning_effort`，原生这边
   * 叫 `thinkingConfig.thinkingLevel`，档位名是同一套（none / minimal / low…）。
   *
   * 关不掉的型号会回 400 并列出它认的档位，`llm.js:rejectsThinking` 认得出
   * 那句话、会降一档重打 —— 所以这里原样传过去就行，不在这儿猜哪个型号认哪档。
   */
  if (body?.reasoning_effort) {
    gen.thinkingConfig = { thinkingLevel: body.reasoning_effort };
  }

  const hasTools = Array.isArray(body?.tools) && body.tools.length > 0;
  return {
    ...(sys ? { systemInstruction: { parts: [{ text: sys }] } } : {}),
    contents,
    ...(Object.keys(gen).length ? { generationConfig: gen } : {}),
    safetySettings: GEMINI_SAFETY_OFF,
    ...(hasTools ? { tools: geminiTools(body.tools) } : {}),
    ...(hasTools && body.tool_choice
      ? {
          toolConfig: {
            functionCallingConfig: { mode: body.tool_choice === "none" ? "NONE" : "AUTO" },
          },
        }
      : {}),
  };
}

/** OpenAI body → Anthropic `/v1/messages` 的请求体。 */
export function toAnthropicBody(body, streaming) {
  const { system, turns } = splitRoles(
    body?.messages,
    (p) => {
      if (p.image) {
        return { type: "image", source: { type: "base64", media_type: p.image.mime, data: p.image.data } };
      }
      if (p.imageUrl) return { type: "image", source: { type: "url", url: p.imageUrl } };
      // 纯空白的文本块上游不收（text content blocks must contain non-whitespace text）
      return p.text?.trim() ? { type: "text", text: p.text } : null;
    },
    {
      call: (tc) => ({ type: "tool_use", id: tc.id, name: tc.function?.name, input: callArgs(tc) }),
      result: (m) => ({ type: "tool_result", tool_use_id: m.tool_call_id, content: toolText(m) || "（空）" }),
    }
  );

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
  if (Array.isArray(body?.tools) && body.tools.length) {
    out.tools = body.tools.map((t) => ({
      name: t.function?.name,
      ...(t.function?.description ? { description: t.function.description } : {}),
      input_schema: t.function?.parameters ?? { type: "object", properties: {} },
    }));
    if (body.tool_choice) out.tool_choice = { type: body.tool_choice === "none" ? "none" : "auto" };
  }
  if (streaming) out.stream = true;
  return out;
}

/**
 * Vertex 上托管的 Claude：请求体和官方 Messages API 差两处。
 *
 *  - **`model` 要去掉**：模型名在 URL 的路径里，body 里再带一个就 400；
 *  - **`anthropic_version` 要加上**：官方那边这是个 HTTP 头，Vertex 这边挪进了
 *    body。写死 `vertex-2023-10-16` —— 这是 Vertex 上这套接口唯一的版本号，
 *    和官方的 `anthropic-version` 不是同一套取值。
 */
const VERTEX_ANTHROPIC_VERSION = "vertex-2023-10-16";

function toVertexAnthropicBody(body, streaming) {
  const out = toAnthropicBody(body, streaming);
  delete out.model;
  return { anthropic_version: VERTEX_ANTHROPIC_VERSION, ...out };
}

/**
 * 一次聊天请求的「发到哪、带什么头、发什么」。
 *
 * custom / openai 原样返回（headers 为 null = 用默认的 Bearer）；原生那几种每次都
 * 从当下的 body 重新翻译 —— 循环可能刚脱掉一个参数、换了一句说法。
 *
 * `shape` 是响应该按谁家来读。除 Vertex 以外都和 `type` 一个值；Vertex 一个类型
 * 下有两种形状（Gemini / Claude），所以要单独带出来给 nativeResult 用。
 *
 * @returns {Promise<{url:string, headers:object|null, body:object,
 *                    decode:Function|null, native:boolean, shape:string|null}>}
 */
export async function chatRequest(type, base, key, body, streaming) {
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
      shape: "gemini",
    };
  }
  if (type === "vertex") {
    const auth = await vertexAuth(base, key);
    const claude = isVertexClaude(body.model);
    /*
     * express 模式（API key）只有 `publishers/google`。Claude 要的是
     * `publishers/anthropic`，在 express 下压根不存在 —— 早点说清楚，
     * 不然用户看到的是一句没头没尾的 404。
     */
    if (claude && auth.express) {
      const err = new Error(
        "Vertex 的 express 模式（API key）用不了 Claude 模型 —— 要么换成服务账号 JSON 当密钥，要么选一个 Gemini 模型"
      );
      err.configFault = true;
      throw err;
    }
    const method = claude
      ? streaming
        ? "streamRawPredict"
        : "rawPredict"
      : streaming
        ? "streamGenerateContent?alt=sse"
        : "generateContent";
    return {
      url: vertexModelUrl({
        root: auth.root,
        project: auth.project,
        region: auth.region,
        model: body.model,
        method,
        publisher: claude ? "anthropic" : "google",
      }),
      headers: auth.headers,
      body: claude ? toVertexAnthropicBody(body, streaming) : toGeminiBody(body),
      decode: claude ? decodeAnthropicChunk : decodeGeminiChunk,
      native: true,
      shape: claude ? "anthropic" : "gemini",
    };
  }
  if (type === "anthropic") {
    return {
      url: `${anthropicRoot(base)}/v1/messages`,
      headers: anthropicHeaders(base, key),
      body: toAnthropicBody(body, streaming),
      decode: decodeAnthropicChunk,
      native: true,
      shape: "anthropic",
    };
  }
  return {
    url: `${base}/chat/completions`,
    headers: null,
    body,
    decode: null,
    native: false,
    shape: null,
  };
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
  // 原生 function calling：模型要调的函数。thoughtSignature 放进 extra_content ——
  // 和 Gemini 自己的 OpenAI 兼容接口同一个位置，下一趟原样带回去（toGeminiBody）
  const toolCalls = (cand?.content?.parts ?? [])
    .filter((p) => p?.functionCall?.name)
    .map((p, i) => ({
      id: p.functionCall.id || `call_${Date.now().toString(36)}_${i}`,
      type: "function",
      function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) },
      ...(p.thoughtSignature
        ? { extra_content: { google: { thought_signature: p.thoughtSignature } } }
        : {}),
    }));
  const finish = cand?.finishReason ?? null;
  const promptBlock = data?.promptFeedback?.blockReason;
  let blocked = null;
  if (promptBlock) blocked = blockedText("Gemini", "blockReason", promptBlock);
  else if (!text && !toolCalls.length && finish && GEMINI_BLOCK_FINISH.test(finish)) {
    blocked = blockedText("Gemini", "finishReason", finish);
  }
  return {
    text,
    toolCalls,
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
  const toolCalls = (Array.isArray(data?.content) ? data.content : [])
    .filter((b) => b?.type === "tool_use" && b.name)
    .map((b) => ({
      id: b.id,
      type: "function",
      function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
    }));
  const finish = data?.stop_reason ?? null;
  return {
    text,
    toolCalls,
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
 * 第一个参数是**响应的形状**（`chatRequest` 返回的 `shape`），不是服务商类型：
 * Vertex 一个类型下既有 Gemini 形状也有 Claude 形状，只看类型分不出来。
 *
 * 已经是 OpenAI 形状的（流式那条路在 requestStream 里就拼好了）原样放过；
 * 翻不出来的也原样放过，让 chatCompletion 照旧报「返回格式看不懂」并带上原文。
 */
export function nativeResult(shape, result) {
  if (!result?.ok || result.data?.choices) return result;
  const data = result.data;
  if (!data || typeof data !== "object") return result;

  // 200 里夹着一个错误（中转站把上游的失败原样转出来）：当失败处理
  if (data.error) {
    return { ...result, ok: false, status: statusOfError(data.error, result.status) };
  }

  const r = shape === "gemini" ? readGemini(data) : readAnthropic(data);
  if (r.blocked) {
    return { ok: false, status: 400, data: { error: { message: r.blocked } }, text: r.blocked };
  }
  if (!r.hasCandidates) return result;

  return {
    ok: true,
    status: result.status,
    data: {
      ...(r.model ? { model: r.model } : {}),
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: r.text,
            ...(r.toolCalls?.length ? { tool_calls: r.toolCalls } : {}),
          },
          finish_reason: r.finish,
        },
      ],
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
