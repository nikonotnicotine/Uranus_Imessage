/**
 * 缤纷云（S3 兼容）的四个动作：传、列、取、删。
 *
 * ── 为什么手写签名而不用 aws-sdk ──
 *
 * `@aws-sdk/client-s3` 装下来是几十 MB、上百个包，而这里要的只有四个请求。
 * SigV4 本身是一套写死的字符串拼接 + 三次 HMAC，`node:crypto` 就够，
 * 一百来行。这个项目已经有 `ffmpeg-static` 那种大依赖了，不该再加一个
 * 只用到 2% 的。
 *
 * 顺带一个好处：这套代码对任何 S3 兼容的服务都能用（R2、B2、MinIO、
 * 阿里 OSS 的 S3 网关…），endpoint 和 region 都是界面上填的。
 *
 * ── 缤纷云的几个具体事实 ──
 *
 *  - Endpoint 是 `https://s3.bitiful.net`，**必须带 https://**
 *  - region 填控制台「Bucket 设置」页面底部显示的可用区码（`cn-east-1`
 *    这种）。官方不同 SDK 示例里写的值不一样，所以这个字段让用户自己填，
 *    我们不猜
 *  - 走 virtual-hosted 风格（`<桶名>.s3.bitiful.net`），官方 PHP 示例里
 *    `use_path_style_endpoint => false`
 *  - 子账户建完要手动分权限，而且**子账户名不能和桶名相同**（会上传失败）。
 *    这两条是文档里的坑，报错时提一句
 *
 * ── 签名的两个坑 ──
 *
 *  1. **流式 body 不能算 sha256**。要算就得先把整个文件读进内存 —— 91MB
 *     的包不行。所以 `x-amz-content-sha256` 发 `UNSIGNED-PAYLOAD`，这是
 *     S3 官方支持的做法，前提是走 https（否则中间人能改 body）。
 *  2. **URI 编码要编两次**，但只在 canonical query 里、而且 key 里的 `/`
 *     不编。见 `encodeKey` 和 `canonicalQuery`。
 */

import crypto from "node:crypto";
import fs from "node:fs";

import { makeNet, apiTimeout } from "./net.js";

/**
 * 网络层（重试 + 把 `TypeError: fetch failed` 翻成中文）在 net.js 里，
 * 两家云共用。
 *
 * 重试会把同一份签名再发一次 —— 没问题，SigV4 允许 15 分钟的时间偏差，
 * 而这里最多隔两秒。
 */
const { fetch: netFetch } = makeNet({
  who: "缤纷云",
  hint: "Endpoint 或可用区填错了也会是这个症状，对一下控制台上给的地址。",
});

const ALGO = "AWS4-HMAC-SHA256";
const SERVICE = "s3";
const UNSIGNED = "UNSIGNED-PAYLOAD";

/* ================= 签名 ================= */

const sha256hex = (data) => crypto.createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();

/** `20260913T101530Z` 和 `20260913`。 */
function stamps(now = new Date()) {
  const iso = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { amzDate: iso, dateOnly: iso.slice(0, 8) };
}

/**
 * 路径里每一段单独 encode，`/` 留着。
 *
 * `encodeURIComponent` 不编 `!'()*`，但 S3 的规范要求编 —— 表情包的文件名
 * 里真有带括号的（`开心(1).jpg`），不补这几个签名就对不上。
 */
function encodeSegment(s) {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/** 对象 key → canonical URI。中文文件名走这条路编成 %E4%B8%AD 那种。 */
function encodeKey(key) {
  return String(key)
    .split("/")
    .map(encodeSegment)
    .join("/");
}

/** canonical query：按 key 排序，键和值都编一遍。 */
function canonicalQuery(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => [encodeSegment(k), encodeSegment(String(v))])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/**
 * 攒好一个签过名的请求（返回 url 和 headers，调用方拿去 fetch）。
 *
 * `payloadHash` 默认 UNSIGNED-PAYLOAD；带 body 的小请求（没有）可以传真的
 * sha256。GET / DELETE 这类空 body 的按规范该发空串的 sha256，但 S3 对
 * UNSIGNED-PAYLOAD 一样认，统一成一个值少一处出错的地方。
 */
function signRequest({
  cfg,
  method,
  key = "",
  query = {},
  headers = {},
  payloadHash = UNSIGNED,
  now = new Date(),
}) {
  const { host, origin, basePath } = hostFor(cfg);
  const { amzDate, dateOnly } = stamps(now);
  // path-style 时桶名是**路径的一部分**，必须一起进 canonical URI ——
  // 只拼进 url 不拼进签名的话签名永远对不上
  const canonicalUri = `${basePath}/${encodeKey(key)}`;

  const allHeaders = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...headers,
  };

  // canonical headers：名字小写、按名排序、值 trim，末尾每行一个 \n
  const sorted = Object.entries(allHeaders)
    .map(([k, v]) => [k.toLowerCase(), String(v).trim()])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonicalHeaders = sorted.map(([k, v]) => `${k}:${v}\n`).join("");
  const signedHeaders = sorted.map(([k]) => k).join(";");

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery(query),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateOnly}/${cfg.region}/${SERVICE}/aws4_request`;
  const stringToSign = [ALGO, amzDate, scope, sha256hex(canonicalRequest)].join("\n");

  // 四级派生：日期 → region → 服务 → aws4_request
  let signingKey = hmac(`AWS4${cfg.secretAccessKey}`, dateOnly);
  for (const part of [cfg.region, SERVICE, "aws4_request"]) {
    signingKey = hmac(signingKey, part);
  }
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  const qs = canonicalQuery(query);
  return {
    // origin 是协议 + 域名，canonicalUri 已经带上了 path-style 的桶名
    url: `${origin}${canonicalUri}${qs ? `?${qs}` : ""}`,
    headers: {
      ...allHeaders,
      Authorization:
        `${ALGO} Credential=${cfg.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

/**
 * 桶名放哪儿：域名里（virtual-hosted）还是路径里（path-style）。
 *
 * 默认 virtual-hosted —— 缤纷云官方 PHP 示例里 `use_path_style_endpoint`
 * 是 false。例外是**桶名带点**（`my.bucket`）：`*.s3.bitiful.net` 这张
 * 通配证书只覆盖一级子域，`my.bucket.s3.bitiful.net` 会撞证书错误，
 * 那种桶只能走 path-style。缤纷云的桶名规则允许点，所以这条会真的踩到。
 *
 * `basePath` 是要拼进 **canonical URI** 的那一段（签名和 url 都用它）——
 * path-style 下桶名是路径的一部分，漏了签名就对不上。
 */
function hostFor(cfg) {
  const base = new URL(cfg.endpoint);
  if (cfg.bucket.includes(".")) {
    return {
      host: base.host,
      origin: base.origin,
      basePath: `/${encodeSegment(cfg.bucket)}`,
    };
  }
  const host = `${cfg.bucket}.${base.host}`;
  return { host, origin: `${base.protocol}//${host}`, basePath: "" };
}

/* ================= 配置校验 ================= */

/**
 * 把界面上填的那几个字段整理成能用的形状，缺了就抛中文。
 *
 * 在这里一次挡掉，后面四个动作都不用再判 —— 而且用户看到的是「桶名没填」
 * 而不是 `TypeError: Cannot read properties of undefined`。
 */
export function normalize(raw) {
  const str = (v) => String(v ?? "").trim();
  const endpoint = str(raw?.endpoint) || "https://s3.bitiful.net";
  const cfg = {
    endpoint,
    region: str(raw?.region),
    bucket: str(raw?.bucket),
    prefix: str(raw?.prefix).replace(/^\/+/, ""),
    accessKeyId: str(raw?.accessKeyId),
    secretAccessKey: str(raw?.secretAccessKey),
  };

  if (!cfg.bucket) throw new Error("桶名没填");
  if (!cfg.region) throw new Error("可用区（region）没填 —— 在缤纷云控制台的「Bucket 设置」页面底部能看到");
  if (!cfg.accessKeyId) throw new Error("Access Key ID 没填");
  if (!cfg.secretAccessKey) throw new Error("Secret Access Key 没填");

  let url;
  try {
    url = new URL(cfg.endpoint);
  } catch {
    throw new Error(`Endpoint「${cfg.endpoint}」不是一个合法的地址，应该长这样：https://s3.bitiful.net`);
  }
  if (url.protocol !== "https:") {
    // 签名走 UNSIGNED-PAYLOAD，那个前提就是 https（见文件头）
    throw new Error("Endpoint 必须是 https:// 开头");
  }
  if (cfg.prefix && !cfg.prefix.endsWith("/")) cfg.prefix += "/";
  return cfg;
}

/** prefix + 文件名。prefix 空着就是桶根。 */
function keyFor(cfg, name) {
  return `${cfg.prefix}${name}`;
}

/* ================= 报错说人话 ================= */

/**
 * S3 的错误响应是 XML，`<Code>` 那个词是给机器看的。翻成能照着办的中文。
 *
 * 缤纷云文档里点名的两个坑（子账户没分权限、子账户名和桶名相同）都会
 * 表现成 AccessDenied / SignatureDoesNotMatch，所以那两条提示里带上。
 */
function explain(status, body, cfg) {
  const code = /<Code>([^<]+)<\/Code>/.exec(body ?? "")?.[1] ?? "";
  const msg = /<Message>([^<]+)<\/Message>/.exec(body ?? "")?.[1] ?? "";

  const known = {
    NoSuchBucket: `桶「${cfg.bucket}」不存在 —— 名字拼错了，或者不在这个可用区`,
    AccessDenied:
      "没有权限。缤纷云的子账户建完要手动分权限（对象读写 + 列举），" +
      "另外子账户名不能和桶名相同，那种情况下上传会失败",
    SignatureDoesNotMatch:
      "签名对不上，通常是 Secret Access Key 抄错了（末尾多个空格也算）",
    InvalidAccessKeyId: "Access Key ID 不存在，对一下控制台里那一串",
    RequestTimeTooSkewed: "本机时间和服务器差得太多，校一下系统时间",
    AuthorizationHeaderMalformed: `可用区填错了 —— 报错里说的是：${msg}`,
    EntityTooLarge: "这个包超过了单次上传的上限",
  };
  if (known[code]) return known[code];
  if (code) return `${code}${msg ? `：${msg}` : ""}`;
  if (status === 403) return "没有权限（403），对一下密钥和子账户的权限设置";
  if (status === 404) return `桶「${cfg.bucket}」或这个文件不存在（404）`;
  return `缤纷云返回 ${status}${msg ? `：${msg}` : ""}`;
}

/** 读一点响应体出来给报错用，读不出来也不能让报错本身挂掉。 */
async function bodyText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/* ================= 四个动作 ================= */

/**
 * 传一个本地文件上去。
 *
 * body 走 `createReadStream` 而不是 `readFile`：91MB 全读进内存太糙，而且
 * Node 的 fetch 支持流式 body（`duplex: "half"` 是必须的，不给会报
 * `RequestInit: duplex option is required`）。
 */
export async function put(raw, name, file, bytes) {
  const cfg = normalize(raw);
  const key = keyFor(cfg, name);
  const { url, headers } = signRequest({
    cfg,
    method: "PUT",
    key,
    headers: {
      "content-type": "application/gzip",
      "content-length": String(bytes),
    },
  });

  const res = await netFetch(
    url,
    // 函数形式：每次重试都得重新开一个读流
    () => ({
      method: "PUT",
      headers,
      body: fs.createReadStream(file),
      duplex: "half",
    }),
    "上传"
  );
  if (!res.ok) throw new Error(explain(res.status, await bodyText(res), cfg));
  return { key, bytes };
}

/**
 * 列出 prefix 下的快照。
 *
 * 响应是 ListObjectsV2 的 XML，用正则摘 `<Contents>` 里的 Key 和 Size ——
 * 不引 XML 解析器：这个响应的结构十几年没变过，而项目里没有现成的解析器，
 * 为三个字段加一个依赖不值得。
 *
 * 分页跟到底（`IsTruncated` + `NextContinuationToken`）。保留份数最多 50，
 * 正常一页就完了，但桶里可能还有别的东西垫着。
 */
export async function list(raw) {
  const cfg = normalize(raw);
  const out = [];
  let token = "";

  for (let page = 0; page < 20; page++) {
    const query = {
      "list-type": "2",
      "max-keys": "1000",
      ...(cfg.prefix ? { prefix: cfg.prefix } : {}),
      ...(token ? { "continuation-token": token } : {}),
    };
    const { url, headers } = signRequest({ cfg, method: "GET", query });
    const res = await netFetch(url, { headers, signal: apiTimeout() }, "列出备份");
    const body = await bodyText(res);
    if (!res.ok) throw new Error(explain(res.status, body, cfg));

    for (const chunk of body.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? []) {
      const key = /<Key>([^<]+)<\/Key>/.exec(chunk)?.[1];
      if (!key) continue;
      out.push({
        // 界面上显示的是文件名，prefix 是配置不是内容
        name: key.slice(cfg.prefix.length),
        key,
        bytes: Number(/<Size>(\d+)<\/Size>/.exec(chunk)?.[1] ?? 0),
      });
    }

    const more = /<IsTruncated>true<\/IsTruncated>/.test(body);
    token = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(body)?.[1] ?? "";
    if (!more || !token) break;
  }
  return out;
}

/** 下载一份快照到本地路径。 */
export async function get(raw, name, toFile) {
  const cfg = normalize(raw);
  const { url, headers } = signRequest({ cfg, method: "GET", key: keyFor(cfg, name) });
  // 下载不设超时：几十 MB 的包在慢线路上要传一会儿
  const res = await netFetch(url, { headers }, "下载");
  if (!res.ok) throw new Error(explain(res.status, await bodyText(res), cfg));
  if (!res.body) throw new Error("缤纷云没有返回文件内容");

  const { pipeline } = await import("node:stream/promises");
  const { Readable } = await import("node:stream");
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(toFile));
  return (await fs.promises.stat(toFile)).size;
}

/** 删一份快照。S3 删不存在的对象也返回 204，所以这里不特殊处理 404。 */
export async function del(raw, name) {
  const cfg = normalize(raw);
  const { url, headers } = signRequest({ cfg, method: "DELETE", key: keyFor(cfg, name) });
  const res = await netFetch(url, { method: "DELETE", headers, signal: apiTimeout() }, "删除备份");
  if (!res.ok && res.status !== 404) {
    throw new Error(explain(res.status, await bodyText(res), cfg));
  }
}

/**
 * 探一次连通性：能列出来就算通。
 *
 * 用 list 而不是 HeadBucket —— 列举本身就是备份要用的权限（清理旧快照靠
 * 它），能列说明真的能用；HeadBucket 过了但没有列举权限的话，用户会在
 * 第一次自动清理时才发现。
 */
export async function check(raw) {
  const cfg = normalize(raw);
  const items = await list(raw);
  return {
    ok: true,
    where: `${cfg.bucket}${cfg.prefix ? `/${cfg.prefix}` : ""}`,
    count: items.length,
  };
}

/**
 * 只给离线测试用的口子：把签名过程摊出来，好拿 AWS 文档里那个「GET Object」
 * 的完整示例对一遍（scripts/test-cloudbackup.mjs 第 9 节）。
 *
 * 签名是这个文件里唯一「错了也不报错、只是 403」的部分 —— 手写的东西必须
 * 能被测到，否则出问题时分不清是密钥抄错了还是代码算错了。
 *
 * 参数直接透给 signRequest，`now` 固定住时间戳（示例要求那一天那一秒）。
 */
export function __signForTest(args) {
  return signRequest(args);
}

/** 界面上显示「往哪儿传」。凭据一个字都不带。 */
export function describe(raw) {
  const bucket = String(raw?.bucket ?? "").trim();
  const prefix = String(raw?.prefix ?? "").trim();
  if (!bucket) return "";
  return `${bucket}/${prefix}`;
}
