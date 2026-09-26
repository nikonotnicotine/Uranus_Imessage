/**
 * Meta Graph API 的调用层：探账号、续 token、发帖、读评论、回评论、Mentions。
 *
 * 走的是 **"Instagram API with Instagram Login"** 这条路线（不绑 Facebook 主页），
 * 所以域名是 `graph.instagram.com`，账号 id 用 `/me` 拿。
 *
 * ── 这一层只管「打通接口」 ──
 *
 * 什么时候该发、发给谁、发不出去怎么办，都不在这儿 —— 那是 igreal.js 的事。
 * 这里每个函数都是「一次请求 + 把结果整理成本地形状」，失败就抛一个中文 Error。
 * 分开的好处是这一层可以照着 Meta 的文档一条条对，不用同时想业务规则。
 *
 * ── 版本号 ──
 *
 * URL 里**不写版本号**（不是 `/v23.0/me` 而是 `/me`）。Instagram Login 这条路线
 * 允许省略，省略时走 Meta 的当前稳定版。写死版本号的代价是它到期下线时功能
 * 突然全挂，而收益（行为固定）对我们没意义 —— 我们用的都是最基础的端点，
 * 几年没变过。
 */

import { igFetch, maskToken } from "./ignet.js";
import { logInfo, logWarn } from "./logs.js";
import {
  PUBLISH_LIMIT,
  TOKEN_DAYS,
  publishedInWindow,
  writeAccount,
  writeUserAccount,
} from "./igaccounts.js";

const SCOPE = "Instagram";

const GRAPH = "https://graph.instagram.com";

/** 拼一个 URL：`/me?fields=…&access_token=…`。token 永远走 query。 */
function api(pathname, params = {}, token = "") {
  const url = new URL(`${GRAPH}${pathname}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  if (token) url.searchParams.set("access_token", token);
  return url.toString();
}

/* ================= 账号 ================= */

/**
 * 探一次 token：它是谁、还能活多久。
 *
 * 两件事一起做，因为用户粘完 token 点「验证」时想知道的就是这两件：
 * 绑上的是哪个号（`username` 显示出来，防止粘错号）、什么时候要重新弄。
 *
 * ── 为什么 expiresAt 是算的、不是问的 ──
 *
 * `/me` 不返回过期时间。Meta 后台点出来的长效 token 是 60 天，所以这里按
 * 「现在 + 60 天」算。算出来可能偏晚（token 是几天前生成的），偏晚的后果是
 * 续期时机晚几天 —— 而 REFRESH_BEFORE_DAYS 留了 7 天余量，兜得住。
 * 真正的过期时间会在**第一次续期成功**时从 `expires_in` 拿到，之后就准了。
 *
 * @param {string} token
 * @returns {Promise<{userId: string, username: string, expiresAt: number}>}
 * @throws {Error} 中文原因（token 无效、网络不通…）
 */
export async function probeToken(token) {
  const clean = String(token ?? "").trim();
  if (!clean) throw new Error("token 是空的");

  const data = await igFetch(api("/me", { fields: "user_id,username" }, clean));
  const userId = String(data.user_id ?? data.id ?? "").trim();
  const username = String(data.username ?? "").trim();
  if (!userId) throw new Error("Meta 没返回 user_id —— 这个 token 可能不是 Instagram 的");

  return { userId, username, expiresAt: Date.now() + TOKEN_DAYS * 86400_000 };
}

/**
 * 验证并绑定一个角色的账号。用户在界面上粘完 token 点「验证」走这里。
 *
 * 探成功才落盘：**探不通的 token 不存**。存一个连 `/me` 都打不通的 token
 * 只会让后面每一轮轮询都白撞一次网络，而用户以为绑好了。
 *
 * @param {string} roleName 角色名（空 = 绑你自己的大号）
 * @param {string} token
 */
export async function bindAccount(roleName, token) {
  const info = await probeToken(token);
  const patch = {
    token: String(token).trim(),
    userId: info.userId,
    username: info.username,
    expiresAt: info.expiresAt,
    lastError: "",
  };
  const saved = roleName ? writeAccount(roleName, patch) : writeUserAccount(patch);
  logInfo(
    SCOPE,
    `${roleName || "你的大号"} 绑上了真 Instagram：@${info.username || info.userId}`
  );
  return saved;
}

/**
 * 续期。`GET /refresh_access_token`，换回来一个新的 60 天 token。
 *
 * Meta 的规矩：token 必须**活过 24 小时**才能续、**过期了就不能续**。
 * 所以这个函数只在 `needsRefresh` 为真时被调（还没过期、但快了）。
 *
 * 失败**不清空 token**：网络抖一下、断网了都会失败，而那个 token 还能用好几天。
 * 只把原因记进 `lastError` 让界面上显示，下一轮再试。
 *
 * @param {string} roleName 空串 = 你自己的大号
 * @param {object} acc 当前记录
 * @returns {Promise<object|null>} 续好的记录；失败返回 null
 */
export async function refreshAccount(roleName, acc) {
  const write = roleName ? (p) => writeAccount(roleName, p) : writeUserAccount;
  const who = roleName || "你的大号";
  try {
    const data = await igFetch(
      api("/refresh_access_token", { grant_type: "ig_refresh_token" }, acc.token)
    );
    const token = String(data.access_token ?? "").trim();
    if (!token) throw new Error("Meta 没返回新 token");

    // expires_in 是秒。缺了就按 60 天算（文档上一直是 5184000）
    const seconds = Number(data.expires_in);
    const life = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : TOKEN_DAYS * 86400_000;
    const next = write({
      token,
      expiresAt: Date.now() + life,
      refreshedAt: Date.now(),
      lastError: "",
    });
    logInfo(SCOPE, `${who} 的 token 续期成功，还能用 ${Math.round(life / 86400_000)} 天`);
    return next;
  } catch (e) {
    const why = String(e?.message ?? e);
    write({ lastError: `续期失败：${why}` });
    logWarn(SCOPE, `${who} 的 token 续期失败（旧的还能用一阵，下一轮再试）`, e);
    return null;
  }
}

/* ================= 发布 ================= */

/**
 * 两步发布：建容器 → 发布。
 *
 * Meta 的发布是异步的：`/media` 只是登记「我要发这张图」，它**自己**去下载
 * `image_url`，下完才算容器就绪，然后 `/media_publish` 才能成。
 *
 * ── 为什么要等 ──
 *
 * 图片走的是图床，Meta 从美国拉一张几百 KB 的图通常一两秒，但偶尔更久。
 * 不等就直接 publish 的话会撞上 `9007`（媒体没准备好）。所以这里**查状态**：
 * `GET /{container-id}?fields=status_code`，`FINISHED` 才发。
 *
 * 图片其实多半一次就 FINISHED（Meta 对图片是同步下载的），这几行是给
 * 「图床慢了一下」兜底 —— 省掉它的话失败率会莫名升高，而重发一次的代价是
 * 又一次生图、转码、上传。
 *
 * @param {object} acc 账号记录
 * @param {{imageUrl: string, caption?: string, isStory?: boolean}} input
 * @returns {Promise<{mediaId: string, permalink: string}>}
 * @throws {Error} 中文原因
 */
export async function publishMedia(acc, input) {
  if (!acc?.token || !acc?.userId) throw new Error("这个账号还没绑好（缺 token 或 user_id）");

  // 24 小时配额本地兜底。Meta 的限制是 50 条/账号，超了它直接拒
  const used = publishedInWindow(acc);
  if (used >= PUBLISH_LIMIT) {
    throw new Error(`24 小时里已经发了 ${used} 条，到 Meta 的 ${PUBLISH_LIMIT} 条上限了`);
  }

  const params = { image_url: input.imageUrl };
  if (input.isStory) {
    params.media_type = "STORIES";
    // 快拍没有文案字段，传了会被拒
  } else if (input.caption) {
    params.caption = String(input.caption).slice(0, 2200); // IG 的文案上限
  }

  const created = await igFetch(api(`/${acc.userId}/media`, params, acc.token), { method: "POST" });
  const containerId = String(created.id ?? "").trim();
  if (!containerId) throw new Error("Meta 没返回容器 id");

  await waitContainer(acc, containerId);

  const published = await igFetch(
    api(`/${acc.userId}/media_publish`, { creation_id: containerId }, acc.token),
    { method: "POST" }
  );
  const mediaId = String(published.id ?? "").trim();
  if (!mediaId) throw new Error("Meta 没返回 media id（容器发布了但拿不到 id）");

  const permalink = await permalinkFor(acc, mediaId);
  return { mediaId, permalink };
}

/** 容器状态轮询的节奏：最多 6 次、间隔 2 秒 = 12 秒。图片够了。 */
const CONTAINER_TRIES = 6;
const CONTAINER_GAP = 2000;

async function waitContainer(acc, containerId) {
  for (let i = 0; i < CONTAINER_TRIES; i += 1) {
    const data = await igFetch(
      api(`/${containerId}`, { fields: "status_code,status" }, acc.token)
    );
    const code = String(data.status_code ?? "").toUpperCase();
    if (code === "FINISHED") return;
    if (code === "ERROR" || code === "EXPIRED") {
      throw new Error(`Meta 处理这张图失败（${code}）：${String(data.status ?? "").slice(0, 200)}`);
    }
    // IN_PROGRESS / PUBLISHED 之外的都当还在处理
    await sleep(CONTAINER_GAP);
  }
  throw new Error(
    `等了 ${(CONTAINER_TRIES * CONTAINER_GAP) / 1000} 秒 Meta 还没下完那张图 —— 图床可能太慢`
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 拿 permalink（`https://www.instagram.com/p/…`）。
 *
 * **拿不到不算失败**：帖子已经发出去了，permalink 只是为了让本地面板上能点开
 * 看真帖。把它变成异常会让调用方以为发布失败、然后重发一遍 —— 那才是真损失。
 */
async function permalinkFor(acc, mediaId) {
  try {
    const data = await igFetch(api(`/${mediaId}`, { fields: "permalink" }, acc.token));
    return String(data.permalink ?? "");
  } catch (e) {
    logWarn(SCOPE, `拿不到 ${mediaId} 的 permalink（帖子已经发出去了，不影响）`, e);
    return "";
  }
}

/**
 * 删一条真 IG 上的帖子。
 *
 * Instagram Graph API **没有删除媒体的端点** —— 这是 Meta 的限制，不是我们没做。
 * 留这个函数是为了让调用方有个明确的地方看到这句话，而不是自己去猜。
 *
 * 所以真发布是**不可逆**的，这也是 `syncReal` 默认关的主要理由。
 *
 * 注意：**评论不一样，评论能删**（见下面的 deleteComment）。别把这两件事
 * 混成一句「真 IG 上的东西都删不掉」—— 帖子删不掉，评论删得掉。
 */
export function canDeleteMedia() {
  return false;
}

/**
 * 删一条评论。**这个是通的**，2026-09-13 实测：回 `{"success":true}`，
 * 帖子的 comments_count 跟着降。
 *
 * 用途是给「铺路 @」兜底：角色互评那条链路要帖主先在自己帖子下发一条
 * `@某人` 当通行证（见 replyAsMentioned），发完之后那句 @ 就没用了。
 * 有了这个函数，那句 @ 可以**用完就删**，评论区不留人工痕迹。
 *
 * 只能删自己帖子下的评论，或者自己发的评论 —— 别人的会回
 * 「does not exist, cannot be loaded due to missing permissions」。
 */
export async function deleteComment(acc, commentId) {
  if (!acc?.token) throw new Error("这个账号还没绑好");
  const id = String(commentId ?? "").trim();
  if (!id) throw new Error("没有评论 id");
  const data = await igFetch(api(`/${id}`, {}, acc.token), { method: "DELETE" });
  return Boolean(data?.success);
}

/* ================= 读取 ================= */

/**
 * 读一个账号自己的帖子。
 *
 * `media_url` 是 **CDN 链接、会过期**（几小时到几天），所以调用方必须**立刻**
 * 下载落地，绝不能只存这个字符串 —— 存了的话本地面板过一阵子全是裂图。
 * 这一层只负责把 URL 交出去，落地在 igreal.js。
 *
 * `limit` 默认 12：轮询是每几小时一次，一个人几小时内发不了 12 条。
 * 拉太多是白花配额（Meta 按调用次数限流，不按条数，但响应体大了慢）。
 *
 * @returns {Promise<Array<{id, caption, mediaUrl, mediaType, permalink, timestamp, commentCount}>>}
 */
export async function listMedia(acc, limit = 12) {
  if (!acc?.token) throw new Error("这个账号还没绑好");
  const fields = "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,comments_count";
  const data = await igFetch(api("/me/media", { fields, limit }, acc.token));
  return (Array.isArray(data.data) ? data.data : []).map(normalizeMedia);
}

/**
 * 读 24 小时内的快拍。
 *
 * `/me/stories` 只返回**还没过期**的 —— 也就是说轮询间隔超过 24 小时的话，
 * 会漏掉整段时间里的快拍。默认 3 小时的间隔没这个问题，但用户可以把间隔调到
 * 168 小时，那时漏是预期行为（界面上的说明里会写）。
 */
export async function listStories(acc) {
  if (!acc?.token) throw new Error("这个账号还没绑好");
  const fields = "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp";
  const data = await igFetch(api("/me/stories", { fields }, acc.token));
  return (Array.isArray(data.data) ? data.data : []).map(normalizeMedia);
}

function normalizeMedia(raw) {
  const type = String(raw?.media_type ?? "").toUpperCase();
  return {
    id: String(raw?.id ?? ""),
    caption: String(raw?.caption ?? ""),
    mediaType: type,
    // 视频用缩略图：我们的本地面板只放静态图，而识图也只吃图片
    mediaUrl: String((type === "VIDEO" ? raw?.thumbnail_url : raw?.media_url) ?? ""),
    permalink: String(raw?.permalink ?? ""),
    timestamp: String(raw?.timestamp ?? ""),
    commentCount: Number(raw?.comments_count ?? 0) || 0,
  };
}

/**
 * 读一条帖子下的评论（含二层回复）。
 *
 * `replies{…}` 是嵌套展开：一次请求把评论和它们的回复都拿回来，省掉「每条评论
 * 再打一次接口」。本地的评论结构是**平铺 + replyTo**（见 igstore.js 的注释），
 * 所以这里就地摊平，让调用方拿到的形状和本地一致。
 *
 * `from` 字段只在**自己的**媒体上才有 —— 那正是我们唯一会读的场合。
 *
 * ── 🔴 2026-09-13 实测：这个接口现在读不回东西 ──
 *
 * 现象很干净，也很容易误判成「没人评论」：
 *
 *   `GET /{media}?fields=comments_count`   → 4（数字是**对的**，会跟着涨）
 *   `GET /{media}/comments`                → `{"data":[],"paging":{…}}`
 *   `GET /{comment-id}?fields=id,text`     → `{}`（不是报错，是空对象）
 *   `GET /{media}?fields=comments{id,text}` → 返回里**根本没有** comments 这个键
 *
 * 最后那条是判据：Graph API 对**没权限的字段**是静默丢掉，不报错。所以这不是
 * 我们的 query 写错了，是这个 token 上少 `instagram_business_manage_comments`
 * （两个号都少，`/me?fields=mentioned_comment` 也回「nonexisting field」）。
 * 另一种可能是 App 还在 Development 模式 —— 那个模式下只给测试数据。
 *
 * 写评论**不受影响**（POST 都成功、id 也回了），所以「角色主动发帖 / 发评论」
 * 一切照常。断掉的只有**收信**：`syncCommentsIn` 会一直拿到空列表，
 * 也就是说「你在真 IG 上给角色留言，角色回你」这条链路现在走不通 ——
 * 不是代码的问题，是 Meta 那边的权限。要修得去开发者后台加那个权限
 * 并把 App 切到 Live，之后这里不用改一行。
 *
 * 参考：https://developers.facebook.com/community/threads/4288466748042535/
 */
export async function listComments(acc, mediaId, limit = 50) {
  if (!acc?.token) throw new Error("这个账号还没绑好");
  const fields = "id,text,timestamp,username,from,replies{id,text,timestamp,username,from}";
  const data = await igFetch(api(`/${mediaId}/comments`, { fields, limit }, acc.token));

  const out = [];
  for (const raw of Array.isArray(data.data) ? data.data : []) {
    const top = normalizeComment(raw, "");
    if (top.id) out.push(top);
    for (const rep of Array.isArray(raw?.replies?.data) ? raw.replies.data : []) {
      const child = normalizeComment(rep, top.id);
      if (child.id) out.push(child);
    }
  }
  return out;
}

function normalizeComment(raw, replyTo) {
  return {
    id: String(raw?.id ?? ""),
    text: String(raw?.text ?? ""),
    // username 在顶层，from 里也有一份 —— 哪个有用哪个
    username: String(raw?.username ?? raw?.from?.username ?? ""),
    userId: String(raw?.from?.id ?? ""),
    timestamp: String(raw?.timestamp ?? ""),
    replyTo: String(replyTo ?? ""),
  };
}

/* ================= 回复 ================= */

/**
 * 在自己的帖子下留一条顶层评论。
 *
 * 这是「铺路 @」用的入口：帖主用自己的 token 在自己帖子下发 `@某人 …`，
 * 给那个人开一张通行证（见下面 replyAsMentioned 的注释）。
 */
export async function addComment(acc, mediaId, message) {
  if (!acc?.token) throw new Error("这个账号还没绑好");
  const text = String(message ?? "").trim();
  if (!text) throw new Error("评论内容是空的");
  const data = await igFetch(
    api(`/${mediaId}/comments`, { message: text.slice(0, 2200) }, acc.token),
    { method: "POST" }
  );
  return String(data.id ?? "");
}

/**
 * 回复一条评论。**自己的帖子，不需要 @**。
 *
 * 这是整套互动里最稳的一条链路：你在角色的帖子下留言，角色用自己的 token
 * 回你 —— 那是它自己的帖子，权限天然具备。所以「你 ↔ 角色」永远能走通，
 * 不依赖任何待实测的东西。
 */
export async function replyToComment(acc, commentId, message) {
  if (!acc?.token) throw new Error("这个账号还没绑好");
  const text = String(message ?? "").trim();
  if (!text) throw new Error("回复内容是空的");
  const data = await igFetch(
    api(`/${commentId}/replies`, { message: text.slice(0, 2200) }, acc.token),
    { method: "POST" }
  );
  return String(data.id ?? "");
}

/**
 * 被 @ 之后，去**别人的**帖子下说话。
 *
 * ── 这是「在别人地盘上说话」的唯一支点 ──
 *
 * Graph API 判断「能不能在这条媒体下发言」只看一件事：这条媒体是不是你的。
 * 所以角色 A 想评论角色 B 的帖子，只有一条路：B 先在自己帖子下发一条
 * `@a_的用户名 …`，那条 @ 相当于一张临时通行证，A 才能用**自己的** token
 * 打 `POST /{A的ig-id}/mentions` 回一句。
 *
 * ── `commentId` 是可选的，两种形态 ──
 *
 * 这是这个端点最有用的一点，也是「用户手动 @ 角色」那条链路的支点：
 *
 *   给了 commentId  → 回复**评论**里的 @，变成那条评论下的子回复
 *   留空            → 回复**配文**里的 @，在帖子下生成一条顶层评论
 *
 * 第二种让用户能不靠任何额外权限就把角色叫到自己的真帖子下：发帖时在配文里
 * 写一句 `@角色的用户名`，配文经 `listMedia` 就能读回来（那是基础权限），
 * 角色照着它打这个端点即可。第一种（用户在评论区手动 @）反而更麻烦 —— 得先
 * 能读到评论，而评论读权限现在是缺的（见上面 listComments 那段）。
 *
 * ── 2026-09-13 实测：通了 ──
 *
 * Mentions API 的文档写在**老路线**（Facebook 主页 + Instagram Graph API）下，
 * Meta 没明说它在 Instagram Login 路线上可用，所以这一条以前标着「未实测」。
 * 实测过了：`POST /{ig-id}/mentions` 回了 id（`{"id":"17956034805218766"}`），
 * 帖子的 `comments_count` 跟着涨。这条路线是可用的。
 *
 * 但**失败仍然必须能降级**，而且这里的降级比别处更重要 —— 这个端点的可用性
 * 由 Meta 单方面决定，哪天变了我们只会从一个异常里知道。调用方接到异常时
 * 不能中断整轮：本地那条评论已经写好了，用户在面板上照样看得见，只是真 IG
 * 上没有。igreal.js:peerComment 还会顺手把这个能力关掉（`mentionsBroken`），
 * 免得每轮都在评论区留一句没人应答的 @。
 *
 * 这也是为什么这个函数抛的错里带「真 IG 上没发出去，本地照常」这句话：
 * 它会出现在日志和界面上，用户看到时不会以为功能坏了。
 *
 * @param {object} acc 说话的那个角色的账号
 * @param {string} mediaId 别人那条帖子
 * @param {string} commentId 铺路那条 @ 评论的 id；**留空 = 回配文里的 @**
 * @param {string} message 要说的话
 */
export async function replyAsMentioned(acc, mediaId, commentId, message) {
  if (!acc?.token || !acc?.userId) throw new Error("这个账号还没绑好");
  const text = String(message ?? "").trim();
  if (!text) throw new Error("评论内容是空的");

  try {
    const data = await igFetch(
      api(
        `/${acc.userId}/mentions`,
        // comment_id 空串会被 api() 跳过（那里判了空）—— 正好是「回配文的 @」那一种
        { media_id: mediaId, comment_id: commentId, message: text.slice(0, 2200) },
        acc.token
      ),
      { method: "POST" }
    );
    return String(data.id ?? "ok");
  } catch (e) {
    throw new Error(
      `角色互评没发到真 IG（本地照常）：${String(e?.message ?? e)}` +
        " —— Mentions 接口 2026-09-13 实测是通的，现在不通多半是权限或 App 模式变了"
    );
  }
}

/* ================= 调试用 ================= */

/**
 * 把一次调用的 URL 写进日志时用这个。
 *
 * 直接导出 `maskToken` 的别名，是为了让别的模块不用为了脱敏去 import ignet ——
 * 忘了脱敏的成本是日志文件里躺着一个能发帖删帖的凭据，而日志是用户会拷给
 * 别人看的东西。
 */
export const maskUrl = maskToken;
