/**
 * xiaohongshu-mcp 的 HTTP 客户端。
 *
 * 上游：https://github.com/xpzouying/xiaohongshu-mcp —— 用户自己在本机跑起来
 * （默认 http://localhost:18060），扫码登好号。它同时开着 MCP 和一套普通的
 * REST 接口（/api/v1/...），我们只用后者：**不把它的工具注入给模型**
 * （理由见 xhstags.js 顶上），模型写标签，这里替它去调接口。
 *
 * ── 为什么要串行 ──
 *
 * 它每个请求都现开一个无头 Chrome、登着同一套 cookie 去点网页。两个请求
 * 一起来就是两个浏览器同时操作一个号 —— 轻则互相踩（发笔记的编辑器被另一个
 * 页面顶掉），重则触发风控。所以同一个地址上的请求一个接一个排队。
 *
 * ── 超时为什么这么长 ──
 *
 * 发一篇笔记要开浏览器 → 上传每张图 → 填标题正文 → 一个个敲话题 → 点发布，
 * 中间还夹着它自己加的「像人一样」的随机停顿，九张图的笔记两三分钟很正常。
 * 读通知、回评论也得开浏览器翻页，一分钟上下。
 */

import { tokenFor } from "./xhsstore.js";
import { whyNetwork } from "./net.js";

const TIMEOUT = {
  publish: 6 * 60 * 1000,
  list: 3 * 60 * 1000,
  reply: 3 * 60 * 1000,
  status: 90 * 1000,
};

/** 每个地址一条队。value 是队尾那个 promise。 */
const lanes = new Map();

function enqueue(baseUrl, fn) {
  const prev = lanes.get(baseUrl) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  // 队尾存一个永不 reject 的，免得一个请求失败把后面的全带挂
  const tail = run.catch(() => {});
  lanes.set(baseUrl, tail);
  void tail.then(() => {
    if (lanes.get(baseUrl) === tail) lanes.delete(baseUrl);
  });
  return run;
}

export class XhsError extends Error {
  constructor(message, { status = 0, code = "" } = {}) {
    super(message);
    this.name = "XhsError";
    this.status = status;
    this.code = code;
  }
}

async function call(baseUrl, method, route, { body, query, timeout } = {}) {
  const base = String(baseUrl ?? "").replace(/\/+$/, "");
  const url = new URL(`${base}/api/v1${route}`);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));

  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const token = tokenFor(base);
  if (token) headers.Authorization = `Bearer ${token}`;

  return enqueue(base, async () => {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout ?? TIMEOUT.status),
      });
    } catch (e) {
      const why =
        e?.name === "TimeoutError"
          ? `等了 ${Math.round((timeout ?? TIMEOUT.status) / 1000)} 秒没回`
          : whyNetwork(e, timeout);
      throw new XhsError(`连不上 xiaohongshu-mcp（${base}）：${why}。它跑起来了吗？`);
    }

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* 下面按非 JSON 处理 */
    }

    if (res.status === 401) {
      throw new XhsError("xiaohongshu-mcp 要访问令牌（它启动时带了 -token / AUTH_TOKEN），这边没配或者配错了", {
        status: 401,
        code: "UNAUTHORIZED",
      });
    }
    if (!res.ok || !json || json.success === false || json.error) {
      const msg = String(json?.error || json?.message || text || `HTTP ${res.status}`).slice(0, 300);
      const details = json?.details ? `：${String(json.details).slice(0, 300)}` : "";
      throw new XhsError(`${msg}${details}`, { status: res.status, code: String(json?.code ?? "") });
    }
    return json.data;
  });
}

/** 登录状态。{isLoggedIn, username, userId} */
export async function loginStatus(baseUrl) {
  const d = await call(baseUrl, "GET", "/login/status", { timeout: TIMEOUT.status });
  return {
    isLoggedIn: Boolean(d?.is_logged_in),
    username: String(d?.username ?? ""),
    userId: String(d?.user_id ?? ""),
  };
}

/**
 * 发一篇图文笔记。images 是**本地绝对路径**（路径里不能有中文，见 xhsstore.js:stageDir）。
 * 上游发完不回笔记 id，所以这里也没有。
 */
export async function publishNote(baseUrl, { title, content, images, tags }) {
  return call(baseUrl, "POST", "/publish", {
    body: {
      title: String(title ?? ""),
      content: String(content ?? ""),
      images: [...(images ?? [])],
      tags: (tags ?? []).map((t) => String(t).replace(/^[#＃]+/, "").trim()).filter(Boolean).slice(0, 10),
    },
    timeout: TIMEOUT.publish,
  });
}

/** 小红书那边的时间有时是秒、有时是毫秒，统一成毫秒。 */
function ms(t) {
  const n = Number(t) || 0;
  return n > 0 && n < 1e12 ? n * 1000 : n;
}

/**
 * 「评论和@」分区的通知，**新的在前**（小红书通知页本来就是按时间倒序）。
 *
 * @returns {Promise<{id,type,time,commentId,text,fromId,fromName,feedId,feedTitle}[]>}
 */
export async function listMentions(baseUrl, limit = 20) {
  const d = await call(baseUrl, "GET", "/notifications/list", {
    query: { tab: "mentions", limit },
    timeout: TIMEOUT.list,
  });
  // handler 又包了一层 {data: result}
  const list = d?.data ?? d;
  return (list?.items ?? []).map((it) => ({
    id: String(it?.id ?? ""),
    type: String(it?.type ?? ""),
    time: ms(it?.time),
    commentId: String(it?.comment_id ?? ""),
    text: String(it?.comment_text ?? ""),
    fromId: String(it?.from?.user_id ?? ""),
    fromName: String(it?.from?.nickname ?? ""),
    feedId: String(it?.feed_id ?? ""),
    feedTitle: String(it?.feed_title ?? ""),
  }));
}

/** 回一条通知里的评论。 */
export async function replyComment(baseUrl, commentId, content) {
  const d = await call(baseUrl, "POST", "/notifications/reply", {
    body: { comment_id: String(commentId ?? ""), content: String(content ?? "") },
    timeout: TIMEOUT.reply,
  });
  return d?.data ?? d;
}
