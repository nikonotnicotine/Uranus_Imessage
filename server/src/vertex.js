/**
 * Google Vertex AI：密钥怎么认、access token 怎么换、地址怎么拼。
 *
 * 发请求、重试、报错这些和别家共用一套（llm.js / media.js）；这个文件只放
 * 「Vertex 自己的形状」，所以**没有文件读写、没有 node: 的依赖** —— 小手机
 * （Cloudflare Worker）和桌面版跑的是同一份，和 novelai.js 同一个规矩。
 *
 * 这也是下面 JWT 用 `crypto.subtle` 而不是 `node:crypto` 的唯一理由：
 * Workers 的 runtime 里只有 WebCrypto，`createSign` 压根不存在。
 *
 * ── 和「Google Gemini」那个类型的区别 ──
 *
 * 那个打的是 AI Studio 那条线（`generativelanguage.googleapis.com`，
 * `x-goog-api-key`，路径里只有模型名）。Vertex 是 GCP 自己那套：
 *
 *   POST {根}/v1/projects/{项目}/locations/{区域}/publishers/{厂商}/models/{模型}:{方法}
 *   Authorization: Bearer {access token}
 *
 * 两条线的模型名、计费、配额全是分开的，同一把密钥互相不通 —— 所以是两种类型，
 * 不是同一种类型的两个地址。
 *
 * ── 两种鉴权 ──
 *
 * 密钥框里粘什么就按什么认，不多加字段（用户要填的东西越少越好）：
 *
 *  - **服务账号 JSON**（`{` 开头）：正常路子。拿里面的私钥签一个 JWT，换成
 *    access token 再打。项目 ID 也在这份 JSON 里（`project_id`），不用另填。
 *  - **API key**（别的）：Vertex 的 express 模式。路径里**没有** projects /
 *    locations 那两段，也**不托管 Claude** —— 这是 Google 那边的限制，不是我们
 *    偷懒，见 vertexModelUrl 的注释。
 *
 * ── 区域 ──
 *
 * 从接口地址的域名认（见 vertexRegion），因为区域本来就写在域名里，再要用户
 * 在界面上填一遍纯属重复。三种端点（全局 / 多区域 / 单区域）都认得出来。
 */

/** 去掉末尾斜杠。和 apitype.js / llm.js 里那份是同一个规矩。 */
function trimEnd(url) {
  return String(url ?? "").trim().replace(/\/+$/, "");
}

export const VERTEX_DEFAULT_URL = "https://aiplatform.googleapis.com";

/** Vertex 上有模型的两家。拉模型列表时两家都问一遍（见 llm.js:listModels）。 */
export const VERTEX_PUBLISHERS = ["google", "anthropic"];

/** 换 access token 的端点。Google 的 OAuth2 服务，不随区域变。 */
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** access token 要的权限范围。Vertex 的生成接口认这一个。 */
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";

/** 换 token 这一步的超时。它只是一次轻量的 POST，卡住就该早点报出来。 */
const TOKEN_TIMEOUT = 15000;

/**
 * 这个模型是不是 Vertex 上托管的 Claude。
 *
 * 按名字认而不是让用户再选一次：`publishers/anthropic` 和
 * `publishers/google` 是两条路径、两种请求体，而模型名里本来就带着答案。
 */
export function isVertexClaude(model) {
  return /claude/i.test(String(model ?? ""));
}

/**
 * 接口地址剥到根（域名那一层）。
 *
 * 用户可能照 Google 文档填到 `/v1`，也可能把整条路径贴进来。按从长到短剥，
 * 不然长的那条永远轮不到 —— 和 apitype.js:geminiRoot 同一个写法。
 */
export function vertexRoot(url) {
  const base = trimEnd(url);
  for (const suffix of ["/v1/chat/completions", "/v1beta1", "/v1"]) {
    if (base.endsWith(suffix)) return base.slice(0, -suffix.length);
  }
  return base;
}

/**
 * 从地址认区域。Vertex 的三种端点，区域都写在域名里：
 *
 *   aiplatform.googleapis.com                → global（全局，推荐）
 *   aiplatform.us.rep.googleapis.com         → us（多区域，us / eu）
 *   us-central1-aiplatform.googleapis.com    → us-central1（单区域）
 *
 * 认不出来（自建反代、中转站那种随便起的域名）按 `global` —— 那是 Vertex 自己
 * 的默认，而且反代多半只是把路径原样转出去，区域由它那边决定。
 */
export function vertexRegion(url) {
  let host = "";
  try {
    host = new URL(trimEnd(url)).hostname.toLowerCase();
  } catch {
    return "global";
  }
  // us-central1-aiplatform.googleapis.com
  const regional = /^([a-z]+-[a-z]+\d+)-aiplatform\./.exec(host);
  if (regional) return regional[1];
  // aiplatform.us.rep.googleapis.com
  const multi = /^aiplatform\.([a-z]{2})\.rep\./.exec(host);
  if (multi) return multi[1];
  return "global";
}

/**
 * 密钥框里那串东西是什么。
 *
 * @returns {{kind:"sa", email:string, privateKey:string, project:string}
 *          | {kind:"apikey", key:string}}
 * @throws {Error} 中文原因，并盖上 `configFault` —— 这是用户填的东西不对，
 *                 调用方据此标成配置错误，别让用户拿着它去问 Google 客服
 */
export function parseVertexKey(key) {
  const raw = String(key ?? "").trim();
  if (!raw) throw configError("Vertex 没填密钥");

  // `{` 开头才当 JSON 试。普通 API key 里不会有花括号
  if (!raw.startsWith("{")) return { kind: "apikey", key: raw };

  let sa;
  try {
    sa = JSON.parse(raw);
  } catch {
    throw configError(
      "Vertex 的密钥看着像服务账号 JSON，但解析不了 —— 请把下载的那个 .json 文件**整个**内容粘进来"
    );
  }
  const email = String(sa?.client_email ?? "").trim();
  const privateKey = String(sa?.private_key ?? "").trim();
  const project = String(sa?.project_id ?? "").trim();
  if (!email || !privateKey) {
    throw configError(
      "Vertex 的服务账号 JSON 里缺 client_email 或 private_key —— 要的是「服务账号密钥」那种 JSON，不是 OAuth 客户端的那种"
    );
  }
  if (!project) {
    throw configError("Vertex 的服务账号 JSON 里缺 project_id，没法拼接口地址");
  }
  return { kind: "sa", email, privateKey, project };
}

function configError(message) {
  const err = new Error(message);
  err.configFault = true;
  return err;
}

/* ================= JWT 签名 → access token ================= */

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlText(text) {
  return b64url(new TextEncoder().encode(text));
}

/**
 * PEM 私钥 → DER 字节。
 *
 * 服务账号 JSON 里那个 `private_key` 是 PKCS#8 的 PEM，而 `crypto.subtle`
 * 的 importKey 要的是裸 DER。头尾那两行和所有换行去掉，剩下的 base64 解开就是。
 *
 * `\n` 要先还原：JSON 里是转义过的，但有人会把 JSON 再过一手工具，拿到手的
 * 可能是字面上的两个字符。
 */
function pemToDer(pem) {
  const body = String(pem)
    .replace(/\\n/g, "\n")
    .replace(/-----[^-]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * 换出来的 token 存一会儿。
 *
 * 一轮聊天可能打好几次请求（抖动重试、脱参数重打、换说法），每次都签一遍 JWT
 * 再多等一个 RTT 去换 token 纯属白等。**纯内存、不落盘** —— 和
 * config.js:keyCursors 同一个理由：重启后重新换一次，结果一模一样。
 *
 * key 是服务账号邮箱：一台机器上配两个 GCP 项目是常事，不能互相串。
 */
const tokenCache = new Map();

/** 提前这么多毫秒就当它过期了，免得正好卡在边界上被 401。 */
const TOKEN_EARLY = 60000;

/**
 * 服务账号 → access token。缓存里有没过期的就直接用。
 *
 * @param {{email:string, privateKey:string}} sa parseVertexKey 的结果
 * @returns {Promise<string>}
 * @throws {Error} 换不出来时带上 Google 回的原话 —— 那句话里一般直接写着
 *                 原因（私钥作废了、服务账号被删了、系统时间差太多）
 */
export async function vertexAccessToken(sa, fetchImpl = fetch) {
  const hit = tokenCache.get(sa.email);
  if (hit && hit.expiresAt > Date.now() + TOKEN_EARLY) return hit.token;

  const now = Math.floor(Date.now() / 1000);
  const header = b64urlText(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64urlText(
    JSON.stringify({
      iss: sa.email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    })
  );
  const signingInput = `${header}.${claims}`;

  let signature;
  try {
    const cryptoKey = await crypto.subtle.importKey(
      "pkcs8",
      pemToDer(sa.privateKey),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"]
    );
    signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      new TextEncoder().encode(signingInput)
    );
  } catch (e) {
    // 到这儿一定是私钥本身的问题（格式坏了、被截断了），不是网络
    throw configError(
      `Vertex 的服务账号私钥用不了（${String(e?.message ?? e)}）—— 检查 JSON 里的 private_key 是不是被改过或截断了`
    );
  }

  const jwt = `${signingInput}.${b64url(new Uint8Array(signature))}`;

  let res;
  let text = "";
  try {
    res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }).toString(),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT),
    });
    text = await res.text();
  } catch (e) {
    const err = new Error(`Vertex 换 access token 没连上：${String(e?.message ?? e)}`);
    // 请求压根没出去。调用方据此配「先看网络通不通」那句建议，而不是「去问服务商」
    err.networkFault = true;
    throw err;
  }

  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* 非 JSON：下面按 status + 原文报 */
  }
  if (!res.ok || !data?.access_token) {
    const why = data?.error_description || data?.error || text.slice(0, 300) || "（空响应体）";
    throw new Error(`Vertex 换 access token 失败（${res.status}）：${why}`);
  }

  const ttl = Number(data.expires_in) > 0 ? Number(data.expires_in) * 1000 : 3600000;
  tokenCache.set(sa.email, { token: data.access_token, expiresAt: Date.now() + ttl });
  return data.access_token;
}

/** 清掉 token 缓存。测试用；跑着的时候没人调。 */
export function clearVertexTokenCache() {
  tokenCache.clear();
}

/* ================= 地址 ================= */

/**
 * 拼一条 Vertex 的接口地址。
 *
 * 两种形状，取决于鉴权方式：
 *
 *  - **服务账号**：`{根}/v1/projects/{项目}/locations/{区域}/publishers/{厂商}/models/{模型}:{方法}`
 *  - **express 模式的 API key**：`{根}/v1/publishers/google/models/{模型}:{方法}`
 *
 * express 那条**没有** projects / locations 两段 —— 不是我们省了，是 Google 的
 * express 模式压根不认它们（带上去是 404）。它也只有 `publishers/google`，
 * 所以 Claude 在 express 下走不通，调用方要先拦住（见 apitype.js）。
 *
 * 模型名原样拼进去，只剥一个 `models/` 前缀（有人会把列表里的全名复制过来）。
 * 别的一概不动 —— 理由和 llm.js:geminiNativeUrl 那段一样：名字里的 `@日期`、
 * 中转站的分组标签都是模型名的一部分，剥掉就 404。
 */
export function vertexModelUrl({ root, project, region, model, method, publisher = "google" }) {
  const name = String(model ?? "").replace(/^models\//, "");
  const path = `publishers/${publisher}/models/${encodeURIComponent(name)}:${method}`;
  if (!project) return `${vertexRoot(root)}/v1/${path}`;
  return `${vertexRoot(root)}/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(
    region || "global"
  )}/${path}`;
}

/**
 * 一次 Vertex 请求的鉴权头和地址要用的那几个值。
 *
 * 服务账号那条会 await 换 token（缓存命中就不打网络），所以这个函数是 async。
 *
 * @returns {Promise<{headers:object, project:string, region:string, root:string, express:boolean}>}
 */
export async function vertexAuth(url, key) {
  const parsed = parseVertexKey(key);
  const root = vertexRoot(url);
  const region = vertexRegion(url);
  if (parsed.kind === "apikey") {
    return {
      headers: { "Content-Type": "application/json", "x-goog-api-key": parsed.key },
      project: "",
      region,
      root,
      express: true,
    };
  }
  const token = await vertexAccessToken(parsed);
  return {
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    project: parsed.project,
    region,
    root,
    express: false,
  };
}

/**
 * 列某一家 publisher 的模型：`publishers.models.list`。
 *
 * ── 为什么是 v1beta1，为什么带 projects/locations ──
 *
 * 官方参考里 parent 写的是 `publishers/{publisher}`，不带项目。但那条裸路径在
 * 全局端点上的行为和带项目的不一样（Genkit 的 Vertex 插件、vertex-ai-mcp 都
 * 换成了带 `projects/{项目}/locations/{区域}/` 的区域形式），所以有项目的时候
 * 用带项目那条 —— 它回的是「这个项目在这个区域能看到什么」，正是用户想知道的。
 * express 模式没有项目，只能走裸路径。
 *
 * 这条接口只在 `v1beta1` 上，不是生成接口那个 `v1`。
 *
 * 要的权限是 `aiplatform.models.list`（`roles/aiplatform.user` 就带着）。
 * 没有的话回 403，调用方据此提示去用「自定义模型」手填。
 */
export function vertexListUrl({ root, project, region, publisher = "google", pageToken = "" }) {
  const base = vertexRoot(root);
  const parent = project
    ? `projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(region || "global")}/publishers/${publisher}`
    : `publishers/${publisher}`;
  const q = new URLSearchParams({ pageSize: "1000" });
  if (pageToken) q.set("pageToken", pageToken);
  return `${base}/v1beta1/${parent}/models?${q}`;
}

/**
 * 列表响应里那一页的模型名。
 *
 * 回的是 `{publisherModels:[{name:"publishers/google/models/gemini-x"}], nextPageToken}`。
 * 名字要剥掉 `publishers/*​/models/` 那一截 —— 拼生成地址时 vertexModelUrl 自己会加。
 *
 * @returns {{names:string[], next:string}}
 */
export function readVertexModelPage(data) {
  const list = Array.isArray(data?.publisherModels) ? data.publisherModels : [];
  const names = [];
  for (const m of list) {
    const raw = typeof m?.name === "string" ? m.name : "";
    const hit = /\/models\/(.+)$/.exec(raw);
    const name = hit ? hit[1] : "";
    // 带 `@版本` 的在 Claude 那边就是正式名字的一部分，别剥
    if (name) names.push(name);
  }
  return { names, next: typeof data?.nextPageToken === "string" ? data.nextPageToken : "" };
}
