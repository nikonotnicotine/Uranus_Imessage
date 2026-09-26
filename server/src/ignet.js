/**
 * 真 Instagram 那几个域名的网络出口：超时 + 统一的错误话术。
 *
 * Meta 的 `graph.instagram.com` / `graph.facebook.com` 在国内直连不通（实测
 * 8 秒超时、一次都没成）。要用的话在系统层面开全局代理（Clash 的 TUN 模式）——
 * Node 的 fetch 不认系统代理，只开「系统代理」那个开关不够。
 *
 * ── 这个文件还管什么 ──
 *
 * 超时（`IG_TIMEOUT`，60 秒，因为发布那步 Meta 要自己去下载我们给的图片 URL）、
 * Meta 的错误码翻译（`whyMeta`）、「Meta 取不到图、换个地址重传就有救」
 * 那一族错误码的识别（`isMediaFetchError`），以及 URL 里 token 的脱敏。
 */

import { whyNetwork } from "./net.js";

/**
 * 请求超时。
 *
 * 发布那一步 Meta 要**自己去下载**我们给的图片 URL，所以 `/media` 那个请求
 * 里包含一次它到图床的往返，比普通接口慢得多。60 秒是留够余量的值 ——
 * 卡在这儿超时的话前面生图、转码、上传图床的活儿全白做了。
 */
export const IG_TIMEOUT = 60_000;

/* ================= 请求 ================= */

/** 响应体截短，进日志和错误信息用。Meta 的报错 JSON 能很长。 */
function clip(text, max = 400) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * 「我取不到你给的那个图片 URL」这一类错误码。
 *
 * ── 为什么要单独认出这一类 ──
 *
 * 实测（scripts 里那几个 diag-ig*.mjs）：同一张图、同一个账号、同一个图床，
 * 建容器成功率只有一半左右，失败时清一色 `9004 / 2207052`。而且：
 *
 *   · 自己先 GET 一次预热 —— **没用**（4/6 → 4/6），所以不是图床还没就绪
 *   · 重试**同一个 URL** —— 时好时坏，有的 URL 连试 4 次全失败
 *   · 重新传一份、换一个**新 URL** —— 8/8 成功，平均 1.5 份
 *
 * 结论：Meta 把「这个 URL 取不到」的结果按 URL 缓存住了，所以对着老地址
 * 干等或重试都白费，唯一能救的办法是**换个地址重来**。9007/2207003/2207032
 * 是同一族的老错误码，一起归进来。
 *
 * 认出它之后，igreal.js:syncOut 会重新传一份再试（见那边的 UPLOAD_TRIES）。
 */
const MEDIA_FETCH_CODES = new Set([9004, 9007]);
const MEDIA_FETCH_SUBCODES = new Set([2207052, 2207003, 2207032]);

/** 这个异常是不是「Meta 取不到图」——换个图床地址重传就有救。 */
export function isMediaFetchError(e) {
  return Boolean(e?.igMediaFetch);
}

/**
 * Meta 的报错里挑出真正有用的那句。
 *
 * 它的错误结构是 `{error: {message, type, code, error_subcode,
 * error_user_title, error_user_msg}}`。`error_user_msg` 是给终端用户看的
 * 人话版本（有时是中文），优先用它；没有就退回 `message`。
 *
 * 三个最常撞上的 code 单独翻译 —— 这几条光看英文原文不知道该去改什么。
 */
function whyMeta(data, status) {
  const err = data?.error;
  if (!err) return `HTTP ${status}`;

  const code = Number(err.code);
  const sub = Number(err.error_subcode);
  const raw = String(err.error_user_msg || err.message || "").trim();

  if (code === 190) {
    return `token 失效了（${raw || "OAuthException"}）—— 去 Meta 后台重新生成一个粘进来`;
  }
  if (code === 4 || code === 17 || code === 32 || sub === 2207051) {
    return `撞到 Meta 的限流了（${raw || "rate limit"}）—— 过一阵子自己会好`;
  }
  if (MEDIA_FETCH_CODES.has(code) || MEDIA_FETCH_SUBCODES.has(sub)) {
    return `Meta 取不到我们给的图片（${raw || "media fetch failed"}）—— 已经换地址重传过几次都没成`;
  }
  if (code === 100 && /aspect ratio|4:5|1.91/i.test(raw)) {
    return `图片比例不合规（${raw}）—— 必须在 4:5 到 1.91:1 之间`;
  }
  return raw || `HTTP ${status}`;
}

/**
 * 打一次 Meta 的接口。
 *
 * 统一在这儿加超时、错误翻译，上层（igapi.js）只管拼 URL 和读结果。
 *
 * **token 绝不写进日志**。这个函数会把 URL 记进 debug 日志，而 Graph API 的
 * token 是走 query string 的 —— 不脱敏的话日志文件里就躺着一个能发帖删帖的
 * 凭据，而日志用户是会拷给别人看的。
 *
 * @param {string} url 完整 URL（token 已经在 query 里）
 * @param {object} [init] fetch 的 init
 * @returns {Promise<object>} 解析好的 JSON
 * @throws {Error} 中文原因
 */
export async function igFetch(url, init = {}) {
  let res;
  try {
    res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(IG_TIMEOUT),
    });
  } catch (e) {
    throw new Error(`${maskToken(url)} 请求失败：${whyNetwork(e, IG_TIMEOUT)}`);
  }

  const raw = await res.text();
  let data = null;
  if (raw.trim()) {
    try {
      data = JSON.parse(raw);
    } catch {
      if (!res.ok) throw new Error(`Meta 返回 ${res.status}：${clip(raw)}`);
      throw new Error(`Meta 返回的不是 JSON：${clip(raw)}`);
    }
  }
  if (!res.ok || data?.error) {
    const err = new Error(whyMeta(data, res.status));
    /*
     * 打个标记，让上层能认出「换个地址重传就有救」这一类。
     *
     * 挂在异常对象上而不是让上层去 match 错误文案：文案是中文、会改，
     * 而 code 是 Meta 定的、不会变。
     */
    const code = Number(data?.error?.code);
    const sub = Number(data?.error?.error_subcode);
    if (MEDIA_FETCH_CODES.has(code) || MEDIA_FETCH_SUBCODES.has(sub)) {
      err.igMediaFetch = true;
    }
    throw err;
  }
  return data ?? {};
}

/**
 * URL 里的 token 换成 `***`。日志和错误信息都过这一道。
 *
 * 两种形态都盖：query 参数 `access_token=…`，和 Cloudinary 那种
 * `api_secret=…`。宁可多盖几个字段，也不要漏一个。
 */
export function maskToken(url) {
  return String(url ?? "").replace(
    /((?:access_token|client_secret|api_secret|api_key|signature)=)[^&]+/gi,
    "$1***"
  );
}
