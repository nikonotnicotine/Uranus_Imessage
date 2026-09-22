/**
 * 两家云驱动共用的网络层。
 *
 * ── 为什么需要这么一层 ──
 *
 * `fetch` 在**传输层**失败时（连接被掐、超时、DNS 不通、证书验不过）抛的
 * 永远是同一句话：
 *
 *     TypeError: fetch failed
 *
 * 真正的原因被 undici 埋在 `e.cause` 里，有时还套好几层。不挖出来的话，
 * 界面上就只有那句英文，用户和我们都没法判断是网络抽了一下、还是域名填
 * 错了、还是中间有东西在拦 HTTPS。
 *
 * 另一半职责是**重试**：传输层的失败经常是一次性的（尤其 GitHub），隔一
 * 秒再来就通了。HTTP 状态码一律不重试 —— 401 试一百次还是 401。
 *
 * 顺带还有第三件事：两家云的**所有**网络请求都从这儿出去，所以「后台发了
 * 什么请求」这件事记在这一个地方就全了（见 makeNet 里那两条 logDebug）。
 */

import { logDebug } from "../logs.js";
import { netCode, proxyFor } from "../proxy.js";

/**
 * 最里面那个真正的错误码。
 *
 * 两种套法都得认：
 *  - `e.cause`：undici 的常规套娃（`TypeError: fetch failed` → 真正的 Error）
 *  - `e.errors[]`：域名同时有 A 和 AAAA 记录时 undici 会挨个试，全失败就包成
 *    一个 `AggregateError`，**它自己没有 `code`**，得钻进去拿。api.github.com
 *    就是双栈的，所以这条真的会踩到
 *
 * 这两件事 proxy.js:netCodes 已经在做了（而且是**每一条**分支都收，不像这里
 * 原来那样一进 `errors[]` 就只顺着第一条往下走 —— IPv6 那条常是没有 code 的
 * 包装错，真正的 ECONNREFUSED 挂在 IPv4 那条上，挑错分支就什么都读不到）。
 * 所以这里转给它，`name` 兜底留着：TimeoutError 是靠名字认的，它没有 code。
 */
function codeOf(e) {
  return netCode(e) || String(e?.name ?? "").trim();
}

/** 这些是「网络抽了一下」，再来一次多半就好了。 */
const RETRYABLE = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ECONNABORTED",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "TimeoutError",
]);

/** 一共试几次、失败之后各等多久（毫秒）。 */
const TRIES = 3;
const BACKOFF = [500, 1500];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 从请求地址里取域名，给报错用。取不到就空着。 */
function hostOf(url) {
  try {
    return new URL(String(url)).host;
  } catch {
    return "";
  }
}

/**
 * 把传输层的失败翻成能照着办的中文。
 *
 * @param {unknown} e    fetch 抛出来的那个东西
 * @param {{who: string, hint?: string, what?: string, url?: string, tried?: number}} ctx
 */
export function explainNetwork(e, { who, hint = "", what = "请求", url = "", tried = 1 }) {
  const code = codeOf(e);
  const host = hostOf(url);

  let why;
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET" || code === "EPIPE") {
    why = "连接被中途掐断了";
  } else if (code === "ETIMEDOUT" || code === "TimeoutError" || code.includes("TIMEOUT")) {
    why = "连上之后一直没有回应，超时了";
  } else if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    why = `域名解析不了${host ? `（${host}）` : ""}，先看看 DNS 和地址有没有填错`;
  } else if (code === "ECONNREFUSED") {
    why = "对方拒绝了连接";
  } else if (
    code.startsWith("CERT_") ||
    code.includes("SELF_SIGNED") ||
    code.includes("UNABLE_TO_VERIFY") ||
    code.includes("ALT_NAME")
  ) {
    why = "HTTPS 证书验不过 —— 中间有东西在拦（企业网关、杀毒软件的 HTTPS 扫描，或者代理）";
  } else {
    why = `底层报的是 ${code || "一个没带错误码的失败"}`;
  }

  // 试了几次要说实话：不该重试的错误只试一次，写成「重试 3 次」是骗人
  const again = tried > 1 ? `已经自动重试 ${tried} 次还是不行。` : "";
  return `连不上${who}（${what}）：${why}。${again}${hint ? `\n${hint}` : ""}`;
}

/**
 * 做一个绑定了服务商名字的网络层。
 *
 * @param {{who: string, hint?: string, scope?: string}} opts
 *   who   服务商名字，进报错第一句（「连不上 GitHub」）
 *   hint  这家特有的补充提示，附在通用说明后面
 *   scope 日志标签（「云备份」）。两家云都归在同一个标签下 —— 用户不关心
 *         这条请求是哪个文件发的，只关心是哪个功能在动
 */
export function makeNet({ who, hint = "", scope = "云备份" }) {
  /**
   * 包一层 fetch：传输层失败重试几次，最后还是不行就抛中文。
   *
   * `init` 可以是函数 —— 上传那次的 body 是个读流，重试必须重新开一个，
   * 不能把已经读完的流再交出去一遍。
   *
   * 每次请求前后各记一条 debug。这是**唯一**能让人看见「后台到底发了什么
   * 请求」的地方 —— 两家云的所有网络动作都从这儿出去，所以记在这里就够了，
   * 不用在 github.js / s3.js 里各写一遍。重试也要说出来：以前静默重试
   * 三次，用户只看到「慢了四秒」，不知道中间发生过什么。
   *
   * @param {string} url
   * @param {object | (() => object)} init
   * @param {string} what 这一步在干嘛，进报错（「查询 release」「上传」）
   */
  async function call(url, init, what = "请求") {
    let last;
    let tried = 0;
    const where = safePath(url);
    for (let i = 0; i < TRIES; i++) {
      tried++;
      const opts = typeof init === "function" ? init() : init;
      const again = tried > 1 ? `（第 ${tried} 次 / 共 ${TRIES} 次）` : "";
      logDebug(scope, `→ ${who} ${what}：${opts?.method ?? "GET"} ${where}${again}`);

      const t0 = Date.now();
      try {
        // 每次重试都重新取一遍：中间用户可能刚在控制台改了代理，没必要让这一
        // 轮继续用旧的（agent 本身是缓存的，重复取不额外建连接）
        const res = await fetch(url, { ...opts, ...(await proxyFor("cloud")) });
        const size = res.headers.get("content-length");
        logDebug(
          scope,
          `← ${who} ${what}：${res.status}（${Date.now() - t0}ms${size ? `，${size}B` : ""}）`
        );
        return res;
      } catch (e) {
        last = e;
        const retry = RETRYABLE.has(codeOf(e));
        logDebug(
          scope,
          `× ${who} ${what}：${codeOf(e) || "没带错误码"}（${Date.now() - t0}ms）` +
            `${retry && i < TRIES - 1 ? `，等 ${BACKOFF[i] ?? 1500}ms 再试` : "，不重试"}`
        );
        if (!retry) break;
        if (i < TRIES - 1) await sleep(BACKOFF[i] ?? 1500);
      }
    }
    throw new Error(explainNetwork(last, { who, hint, what, url, tried }));
  }

  return { fetch: call };
}

/**
 * 请求地址里可能带凭据 —— 缤纷云那条路的签名整个在 query 里
 * （`X-Amz-Credential` 带着 Access Key ID、`X-Amz-Signature` 是签名本身）。
 * 日志里只留 path，query 一律换成 `?…`：那串东西对排查没有帮助，
 * 而 Access Key ID 是真凭据。
 *
 * 解析不出来的（相对地址之类）就整条不打 —— 宁可少说一句，不能漏出去。
 */
function safePath(url) {
  try {
    const u = new URL(String(url));
    return `${u.pathname}${u.search ? "?…" : ""}`;
  } catch {
    return "";
  }
}

/**
 * 小请求（列表、查询、删除这些，响应都是几 KB 的 JSON/XML）给个 30 秒上限，
 * 免得网络半死不活的时候界面上那个按钮转五分钟。
 *
 * **上传和下载不要用**：几十 MB 的包在慢线路上传十分钟是正常的，掐了反而
 * 坏事。那两个动作靠 undici 自己的 body 超时兜底。
 */
export const apiTimeout = () => AbortSignal.timeout(30_000);
