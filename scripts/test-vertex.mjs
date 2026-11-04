/**
 * Google Vertex AI 那条线：密钥怎么认、地址怎么拼、请求体翻成什么样。
 *
 * 跑法：`node scripts/test-vertex.mjs`（`npm test` 会一起跑）
 *
 * ── 为什么要专门测这个 ──
 *
 * Vertex 是**一个类型下两套协议**：模型名带 `claude` 的走
 * `publishers/anthropic` + `:rawPredict`、请求体是 Claude 那套；其余走
 * `publishers/google` + `:generateContent`、请求体是 Gemini 那套。再加上两种
 * 鉴权（服务账号 JSON 签 JWT 换 token / express 模式的 API key），一共四种
 * 组合，而**错了都不会在本地报错** —— 全要等真打到 Google 那边才看得见 404
 * 或者 400，报出来的还是一句没头没尾的英文。
 *
 * 另外 `chatRequest` 为了 Vertex 从同步改成了 async，其余四种类型的输出形状
 * 一个字都不该变 —— 文件末尾那组回归就是盯这件事的。
 *
 * 一次网络都不打：换 token 那一步把 `globalThis.fetch` 临时换掉
 * （这个项目里已有的测试手法，见 docs/实现细节.md 的「临时替换 fetch」那几处）。
 */

import { generateKeyPairSync } from "node:crypto";

import {
  VERTEX_PUBLISHERS,
  clearVertexTokenCache,
  isVertexClaude,
  parseVertexKey,
  readVertexModelPage,
  vertexAccessToken,
  vertexListUrl,
  vertexModelUrl,
  vertexRegion,
  vertexRoot,
} from "../server/src/vertex.js";
import {
  apiType,
  assertKeyIsNotServiceAccount,
  chatRequest,
  isNativeType,
  nativeResult,
} from "../server/src/apitype.js";

let pass = 0;
let fail = 0;

function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${what}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${what}\n      得到：${JSON.stringify(got)}\n      期望：${JSON.stringify(want)}`);
  }
}

function ok(what, cond) {
  check(what, Boolean(cond), true);
}

/** 跑一段会抛错的代码，返回那句话（没抛的话返回空串）。 */
async function thrown(fn) {
  try {
    await fn();
    return "";
  } catch (e) {
    return String(e?.message ?? e);
  }
}

/** 同上，同步版。 */
function thrownSync(fn) {
  try {
    fn();
    return "";
  } catch (e) {
    return String(e?.message ?? e);
  }
}

function group(name) {
  console.log(`\n${name}`);
}

/** 一把真的 RSA 私钥：JWT 那段签名是真签的，不是假装的。 */
const { privateKey: PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const SA = JSON.stringify({
  type: "service_account",
  project_id: "my-proj",
  private_key_id: "kid",
  private_key: PEM,
  client_email: "robot@my-proj.iam.gserviceaccount.com",
});

const MSG = [{ role: "user", content: "你好" }];

/* ================= 密钥 ================= */

group("parseVertexKey：粘什么就认什么");
{
  const sa = parseVertexKey(SA);
  check("服务账号 JSON 认成 sa", sa.kind, "sa");
  check("项目 ID 从 JSON 里取", sa.project, "my-proj");
  check("服务账号邮箱也取出来", sa.email, "robot@my-proj.iam.gserviceaccount.com");

  const ak = parseVertexKey("AIzaSyFakeKeyForTest");
  check("别的一律当 express 模式的 API key", ak.kind, "apikey");
  check("key 原样留着", ak.key, "AIzaSyFakeKeyForTest");

  // 前后有空白是粘贴时最常见的事，不该因此失败
  check("两头的空白不算", parseVertexKey(`  ${SA}  `).kind, "sa");
}

group("parseVertexKey：填错了要说清是哪儿错，而且算配置问题");
{
  const cases = [
    ["空的", "", /没填密钥/],
    ["`{` 开头但不是 JSON", '{"type": 这不是 JSON', /解析不了/],
    ["JSON 但缺 private_key", '{"client_email":"a@b.c"}', /client_email 或 private_key/],
    ["JSON 但缺 client_email", '{"private_key":"x"}', /client_email 或 private_key/],
    ["齐了但没有 project_id", `{"client_email":"a@b.c","private_key":"x"}`, /project_id/],
  ];
  for (const [what, key, re] of cases) {
    let err = null;
    try {
      parseVertexKey(key);
    } catch (e) {
      err = e;
    }
    ok(`${what}：抛错且点名原因`, re.test(String(err?.message ?? "")));
    // 盖了这个标记，llm.js 才会配上「去连接里补配置」而不是「去问服务商」
    ok(`${what}：标成配置问题`, err?.configFault === true);
  }
}

/* ================= 地址 ================= */

group("vertexRoot：填到哪一层都剥回根上");
{
  check("只有域名", vertexRoot("https://aiplatform.googleapis.com"), "https://aiplatform.googleapis.com");
  check("末尾斜杠", vertexRoot("https://aiplatform.googleapis.com/"), "https://aiplatform.googleapis.com");
  check("填到 /v1", vertexRoot("https://aiplatform.googleapis.com/v1"), "https://aiplatform.googleapis.com");
  check(
    "填到 /v1beta1",
    vertexRoot("https://aiplatform.googleapis.com/v1beta1"),
    "https://aiplatform.googleapis.com"
  );
  check(
    "照 OpenAI 的习惯贴了整条",
    vertexRoot("https://relay.example.com/v1/chat/completions"),
    "https://relay.example.com"
  );
}

group("vertexRegion：区域写在域名里，不用另填");
{
  check("全局端点", vertexRegion("https://aiplatform.googleapis.com"), "global");
  check("单区域端点", vertexRegion("https://us-central1-aiplatform.googleapis.com"), "us-central1");
  check("另一个区域", vertexRegion("https://europe-west4-aiplatform.googleapis.com/v1"), "europe-west4");
  check("多区域端点（us）", vertexRegion("https://aiplatform.us.rep.googleapis.com"), "us");
  check("多区域端点（eu）", vertexRegion("https://aiplatform.eu.rep.googleapis.com"), "eu");
  // 自建反代、中转站那种随便起的域名：按 Vertex 自己的默认走
  check("认不出来按 global", vertexRegion("https://relay.example.com/v1"), "global");
  check("压根不是网址也不炸", vertexRegion("这不是网址"), "global");
}

group("vertexModelUrl：服务账号带 projects/locations，express 不带");
{
  check(
    "服务账号 + Gemini",
    vertexModelUrl({
      root: "https://aiplatform.googleapis.com",
      project: "my-proj",
      region: "global",
      model: "gemini-2.5-pro",
      method: "generateContent",
    }),
    "https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global/publishers/google/models/gemini-2.5-pro:generateContent"
  );
  check(
    "服务账号 + Claude 换 publisher",
    vertexModelUrl({
      root: "https://aiplatform.googleapis.com",
      project: "my-proj",
      region: "us-east5",
      model: "claude-opus-4-5@20251101",
      method: "rawPredict",
      publisher: "anthropic",
    }),
    "https://aiplatform.googleapis.com/v1/projects/my-proj/locations/us-east5/publishers/anthropic/models/claude-opus-4-5%4020251101:rawPredict"
  );
  // express 模式没有 projects / locations 两段 —— 带上去是 404
  check(
    "express（没有 project）",
    vertexModelUrl({
      root: "https://aiplatform.googleapis.com",
      project: "",
      region: "global",
      model: "gemini-2.5-flash",
      method: "generateContent",
    }),
    "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-flash:generateContent"
  );
  // 从模型列表里复制过来的全名
  check(
    "只剥一个 models/ 前缀",
    vertexModelUrl({
      root: "https://aiplatform.googleapis.com",
      project: "p",
      region: "global",
      model: "models/gemini-2.5-pro",
      method: "generateContent",
    }),
    "https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/google/models/gemini-2.5-pro:generateContent"
  );
  check("根上的 /v1 不会拼成两遍", vertexModelUrl({
    root: "https://aiplatform.googleapis.com/v1",
    project: "p",
    region: "global",
    model: "m",
    method: "generateContent",
  }), "https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/google/models/m:generateContent");
}

group("isVertexClaude：按模型名分流");
{
  for (const m of ["claude-opus-4-5@20251101", "claude-sonnet-4-5@20250929", "CLAUDE-haiku"]) {
    check(`${m} 是 Claude`, isVertexClaude(m), true);
  }
  for (const m of ["gemini-2.5-pro", "imagen-4.0-generate-001", "text-embedding-005", ""]) {
    check(`${m || "(空)"} 不是`, isVertexClaude(m), false);
  }
}

group("vertexListUrl：列模型走 v1beta1，有项目就带 projects/locations");
{
  // 这条接口只在 v1beta1 上，不是生成接口那个 v1
  check(
    "服务账号（带项目）",
    vertexListUrl({ root: "https://aiplatform.googleapis.com", project: "my-proj", region: "us-east5" }),
    "https://aiplatform.googleapis.com/v1beta1/projects/my-proj/locations/us-east5/publishers/google/models?pageSize=1000"
  );
  check(
    "换 publisher",
    vertexListUrl({
      root: "https://aiplatform.googleapis.com",
      project: "my-proj",
      region: "global",
      publisher: "anthropic",
    }),
    "https://aiplatform.googleapis.com/v1beta1/projects/my-proj/locations/global/publishers/anthropic/models?pageSize=1000"
  );
  // express 模式没有项目，只能走裸路径
  check(
    "express（没有项目）",
    vertexListUrl({ root: "https://aiplatform.googleapis.com", project: "", region: "global" }),
    "https://aiplatform.googleapis.com/v1beta1/publishers/google/models?pageSize=1000"
  );
  ok(
    "翻页带上 pageToken",
    vertexListUrl({
      root: "https://aiplatform.googleapis.com",
      project: "p",
      region: "global",
      pageToken: "tok123",
    }).includes("pageToken=tok123")
  );
}

group("readVertexModelPage：剥掉 publishers/*/models/ 前缀");
{
  const r = readVertexModelPage({
    publisherModels: [
      { name: "publishers/google/models/gemini-4-argon" },
      { name: "publishers/google/models/gemini-3.8-flash" },
      { name: "publishers/anthropic/models/claude-opus-4-5@20251101" },
      { name: "" },
      {},
    ],
    nextPageToken: "next-page",
  });
  check("取出模型名", r.names, [
    "gemini-4-argon",
    "gemini-3.8-flash",
    "claude-opus-4-5@20251101",
  ]);
  // Claude 的 @日期 是正式名字的一部分，剥掉就 404
  ok("@日期 保住了", r.names.some((n) => n.includes("@20251101")));
  check("带出 nextPageToken", r.next, "next-page");

  const empty = readVertexModelPage({});
  check("空响应不炸", empty.names, []);
  check("没有下一页就是空串", empty.next, "");
}

group("两家 publisher 的清单");
{
  check("google 和 anthropic 都问", VERTEX_PUBLISHERS, ["google", "anthropic"]);
}

group("assertKeyIsNotServiceAccount：服务账号 JSON 粘错类型时，报错里不能带密钥");
{
  // Vertex 本来就收 JSON，不该拦
  check("vertex 放过", thrownSync(() => assertKeyIsNotServiceAccount("vertex", SA, "源")), "");
  check("novelai 放过", thrownSync(() => assertKeyIsNotServiceAccount("novelai", SA, "源")), "");
  // 普通的一行密钥不该被当成 JSON
  check("普通 key 放过", thrownSync(() => assertKeyIsNotServiceAccount("custom", "sk-abc", "源")), "");

  for (const t of ["custom", "openai", "gemini", "anthropic"]) {
    const why = thrownSync(() => assertKeyIsNotServiceAccount(t, SA, "源"));
    ok(`${t} 拦住了`, why.length > 0);
    /*
     * 这一条是这个函数存在的全部理由：以前这份 JSON 会被拼进
     * `Authorization: Bearer …`，fetch 抛的异常 message 里带着完整私钥，
     * 那句话进日志、上界面、被复制出去问人。
     */
    ok(`${t}：报错里没有私钥`, !why.includes("PRIVATE KEY") && !why.includes(PEM.slice(40, 80)));
    ok(`${t}：报错里没有服务账号邮箱`, !why.includes("robot@"));
    ok(`${t}：说清了该改成哪种类型`, why.includes("Google Vertex AI"));
    ok(`${t}：提了「重启后端」这条可能`, why.includes("重启"));
  }
}

/* ================= 换 access token ================= */

/**
 * 把 fetch 换成一个假的 token 端点，记下它被打了几次。
 * 真 Google 那边的响应形状：`{access_token, expires_in, token_type}`。
 */
function fakeTokenServer({ status = 200, body = { access_token: "ya29.fake", expires_in: 3599 } } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    };
  };
  return { impl, calls };
}

group("vertexAccessToken：签 JWT 换 token");
{
  clearVertexTokenCache();
  const sa = parseVertexKey(SA);
  const srv = fakeTokenServer();
  const token = await vertexAccessToken(sa, srv.impl);

  check("拿到 token", token, "ya29.fake");
  check("只打了一次", srv.calls.length, 1);
  check("打的是 Google 的 OAuth2 端点", srv.calls[0].url, "https://oauth2.googleapis.com/token");
  ok("用的是 JWT bearer 那种授权方式", srv.calls[0].body.includes("jwt-bearer"));

  // JWT 的头和载荷要能解回来，而且字段对
  const assertion = new URLSearchParams(srv.calls[0].body).get("assertion");
  const [h, c, s] = String(assertion).split(".");
  const un = (seg) => JSON.parse(Buffer.from(seg.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
  check("算法是 RS256", un(h).alg, "RS256");
  check("iss 是服务账号邮箱", un(c).iss, sa.email);
  check("aud 是 token 端点", un(c).aud, "https://oauth2.googleapis.com/token");
  check("要的是 cloud-platform 权限", un(c).scope, "https://www.googleapis.com/auth/cloud-platform");
  ok("exp 在未来", un(c).exp > Math.floor(Date.now() / 1000));
  ok("签名段不是空的", s && s.length > 0);

  /*
   * 这一条是性能上的事，但它值一个测试：一轮聊天会打好几次请求（抖动重试、
   * 脱参数重打、换说法），每次都重签 JWT 再多等一个 RTT 是白等。
   */
  const again = await vertexAccessToken(sa, srv.impl);
  check("第二次命中缓存，不再打 token 端点", srv.calls.length, 1);
  check("拿到的还是同一个 token", again, "ya29.fake");

  // 换个服务账号不能串（一台机器上配两个 GCP 项目是常事）
  const other = parseVertexKey(
    JSON.stringify({
      project_id: "p2",
      private_key: PEM,
      client_email: "other@p2.iam.gserviceaccount.com",
    })
  );
  await vertexAccessToken(other, srv.impl);
  check("另一个服务账号自己换一次", srv.calls.length, 2);
}

group("vertexAccessToken：换不出来时说清原因");
{
  clearVertexTokenCache();
  const sa = parseVertexKey(SA);
  const srv = fakeTokenServer({
    status: 400,
    body: { error: "invalid_grant", error_description: "Invalid JWT Signature." },
  });
  const why = await thrown(() => vertexAccessToken(sa, srv.impl));
  ok("带上 Google 回的原话", why.includes("Invalid JWT Signature."));
  ok("带上状态码", why.includes("400"));

  clearVertexTokenCache();
  const broken = { email: "a@b.c", privateKey: "-----BEGIN PRIVATE KEY-----\n这不是私钥\n-----END PRIVATE KEY-----" };
  const why2 = await thrown(() => vertexAccessToken(broken, srv.impl));
  ok("私钥坏了点名是私钥的事", /私钥/.test(why2));
}

/* ================= chatRequest ================= */

const VERTEX_BASE = "https://aiplatform.googleapis.com";

group("chatRequest(vertex)：Gemini 模型走 publishers/google");
{
  clearVertexTokenCache();
  const saved = globalThis.fetch;
  globalThis.fetch = fakeTokenServer().impl;
  try {
    const body = { model: "gemini-2.5-pro", messages: MSG, temperature: 0.8 };
    const w = await chatRequest("vertex", VERTEX_BASE, SA, body, false);

    check(
      "地址",
      w.url,
      `${VERTEX_BASE}/v1/projects/my-proj/locations/global/publishers/google/models/gemini-2.5-pro:generateContent`
    );
    check("鉴权头是换来的 access token", w.headers.Authorization, "Bearer ya29.fake");
    ok("请求体是 Gemini 那套", Array.isArray(w.body.contents));
    ok("安全过滤全关（直连官方要自己关）", Array.isArray(w.body.safetySettings));
    check("温度翻过去了", w.body.generationConfig.temperature, 0.8);
    check("形状标成 gemini", w.shape, "gemini");
    ok("标成原生接口（响应要翻回 OpenAI 形状）", w.native);

    const s = await chatRequest("vertex", VERTEX_BASE, SA, body, true);
    ok("流式打 streamGenerateContent", s.url.includes(":streamGenerateContent"));
    ok("流式带 alt=sse", s.url.endsWith("?alt=sse"));
  } finally {
    globalThis.fetch = saved;
  }
}

group("chatRequest(vertex)：Claude 模型走 publishers/anthropic + rawPredict");
{
  clearVertexTokenCache();
  const saved = globalThis.fetch;
  globalThis.fetch = fakeTokenServer().impl;
  try {
    const body = { model: "claude-opus-4-5@20251101", messages: MSG, max_tokens: 500 };
    const w = await chatRequest("vertex", VERTEX_BASE, SA, body, false);

    ok("publisher 换成 anthropic", w.url.includes("/publishers/anthropic/"));
    ok("方法是 rawPredict", w.url.endsWith(":rawPredict"));
    /*
     * 这两条是 Vertex 上 Claude 和官方 Messages API 唯一的两处差别，
     * 错一个就 400：模型名在路径里，body 里不能再带；版本号从 HTTP 头
     * 挪进了 body。
     */
    check("body 里不带 model", "model" in w.body, false);
    check("body 里带 anthropic_version", w.body.anthropic_version, "vertex-2023-10-16");
    ok("请求体是 Claude 那套", Array.isArray(w.body.messages));
    check("max_tokens 带过去了", w.body.max_tokens, 500);
    check("形状标成 anthropic", w.shape, "anthropic");

    const s = await chatRequest("vertex", VERTEX_BASE, SA, body, true);
    ok("流式打 streamRawPredict", s.url.endsWith(":streamRawPredict"));
    check("流式 body 里有 stream", s.body.stream, true);
    check("流式 body 里照样不带 model", "model" in s.body, false);
  } finally {
    globalThis.fetch = saved;
  }
}

group("chatRequest(vertex)：express 模式的 API key");
{
  const body = { model: "gemini-2.5-flash", messages: MSG };
  const w = await chatRequest("vertex", VERTEX_BASE, "AIzaFake", body, false);

  check("鉴权走 x-goog-api-key", w.headers["x-goog-api-key"], "AIzaFake");
  check("不带 Authorization", "Authorization" in w.headers, false);
  // express 模式路径里没有 projects / locations
  check("地址", w.url, `${VERTEX_BASE}/v1/publishers/google/models/gemini-2.5-flash:generateContent`);

  /*
   * express 模式只有 publishers/google，Claude 在那儿压根不存在。早点
   * 说清楚，不然用户看到的是一句没头没尾的 404。
   */
  const why = await thrown(() =>
    chatRequest("vertex", VERTEX_BASE, "AIzaFake", { model: "claude-opus-4-5@20251101", messages: MSG }, false)
  );
  ok("Claude + express 直接拦住", /express/.test(why) && /Claude/.test(why));
}

group("nativeResult：Vertex 的两种响应按 shape 分别翻回 OpenAI 形状");
{
  // Claude on Vertex 回的就是官方 Messages 那个形状
  const claude = nativeResult("anthropic", {
    ok: true,
    status: 200,
    text: "",
    data: {
      model: "claude-opus-4-5",
      content: [{ type: "text", text: "你好呀" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 3 },
    },
  });
  check("Claude 形状的正文", claude.data.choices[0].message.content, "你好呀");
  check("Claude 形状的结束原因", claude.data.choices[0].finish_reason, "end_turn");

  const gem = nativeResult("gemini", {
    ok: true,
    status: 200,
    text: "",
    data: {
      modelVersion: "gemini-2.5-pro",
      candidates: [{ content: { parts: [{ text: "在呢" }] }, finishReason: "STOP" }],
    },
  });
  check("Gemini 形状的正文", gem.data.choices[0].message.content, "在呢");
}

/* ================= 别把别家弄坏 ================= */

group("apiType / isNativeType 认得 vertex");
{
  check("vertex 原样认出", apiType({ type: "vertex" }), "vertex");
  check("vertex 是原生接口", isNativeType("vertex"), true);
  // 老配置没有 type 字段，一律算自定义 —— 这条规矩不能因为多了一种类型而变
  check("缺字段还是 custom", apiType({}), "custom");
  check("认不出的还是 custom", apiType({ type: "蛤" }), "custom");
}

group("回归：chatRequest 改成 async，别家的输出一个字都不该变");
{
  const body = { model: "gpt-4o", messages: MSG, temperature: 0.7 };

  const custom = await chatRequest("custom", "https://relay.example.com/v1", "sk-x", body, false);
  check("custom 的地址", custom.url, "https://relay.example.com/v1/chat/completions");
  check("custom 不翻译请求体", custom.body, body);
  check("custom 不是原生", custom.native, false);
  check("custom 用默认的 Bearer（headers 为 null）", custom.headers, null);

  const openai = await chatRequest("openai", "https://api.openai.com/v1", "sk-x", body, false);
  check("openai 和 custom 一模一样", openai.url, "https://api.openai.com/v1/chat/completions");

  const gem = await chatRequest(
    "gemini",
    "https://generativelanguage.googleapis.com",
    "AIzaX",
    { model: "gemini-2.5-pro", messages: MSG },
    false
  );
  check(
    "gemini 的地址没变",
    gem.url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent"
  );
  check("gemini 官方只带 x-goog-api-key", "Authorization" in gem.headers, false);
  check("gemini 的 shape", gem.shape, "gemini");

  const ant = await chatRequest(
    "anthropic",
    "https://api.anthropic.com",
    "sk-ant-x",
    { model: "claude-opus-4-5", messages: MSG },
    false
  );
  check("anthropic 的地址没变", ant.url, "https://api.anthropic.com/v1/messages");
  // 官方那条**要**带 model（和 Vertex 正好相反），这是最容易改串的一处
  check("anthropic 官方 body 里带 model", ant.body.model, "claude-opus-4-5");
  check("anthropic 不带 anthropic_version 字段（它是 HTTP 头）", "anthropic_version" in ant.body, false);
  check("anthropic 的版本号在头里", ant.headers["anthropic-version"], "2023-06-01");
  check("anthropic 的 shape", ant.shape, "anthropic");
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
