/**
 * 真 Instagram 的**业务规则**：什么时候发、发给谁、拉回来的东西怎么落地、
 * 出了错怎么降级。
 *
 * ── 一条铁律：本地永远是主本 ──
 *
 * 这个文件里每一个函数都**不允许**因为真 IG 那边失败而影响本地。帖子已经写进
 * data/instagram/ 了，角色的记忆里已经有了，用户在面板上看得见 —— 真 IG 只是
 * 一个额外的橱窗。所以：
 *
 *   · 所有对外调用都包在 try 里，失败只记 `remote.error` 和一条日志
 *   · 一次都不重试（下一轮轮询会自然再试一次，见 `retryPending`）
 *   · 没绑号 / 开关没开 / 勿扰时段，直接返回，连日志都不打
 *
 * ── 三道闸 ──
 *
 * 一条内容要发到真 IG，得同时满足：
 *
 *   1. 角色的 `instagram.syncReal` 开着（默认关，config.js:normalizeInstagram）
 *   2. 这个角色在 accounts.json 里绑了个能用的账号
 *   3. 图床配好了（Meta 只接受它自己能下载的公网 URL）
 *
 * 任何一道不过就静默跳过。这是刻意的：用户开着 IG 但没绑真号是**最常见**的
 * 状态，那种状态不该往日志里刷东西。
 */

import fs from "node:fs";

import {
  accountUsable,
  allowLabelFor,
  allowedFrom,
  inDnd,
  mentionedHandles,
  needsRefresh,
  normalizeUsername,
  notePublished,
  readAccounts,
  roleHandleMap,
  writeRealSettings,
} from "./igaccounts.js";
import {
  addComment,
  deleteComment,
  listComments,
  listMedia,
  listStories,
  publishMedia,
  refreshAccount,
  replyAsMentioned,
  replyToComment,
} from "./igapi.js";
import { deleteFromHost, hostReady, toIgJpeg, uploadToHost } from "./igimage.js";
import { IG_TIMEOUT, isMediaFetchError } from "./ignet.js";
import {
  USER_OWNER,
  addPost,
  addStory,
  mediaPathFor,
  readPosts,
  readStories,
  saveMedia,
  updatePost,
  updateStory,
} from "./igstore.js";
import { roleFor } from "./instagram.js";
import { logInfo, logWarn } from "./logs.js";
import { proxyFor, proxyStatus, usesProxy } from "./proxy.js";

const SCOPE = "Instagram";

/**
 * 「传图 + 让 Meta 去取」最多试几遍。
 *
 * Meta 那一步的首次成功率实测只有 60~70%，而且失败是**按 URL 缓存**的 ——
 * 换个新地址重传才有救（见 ignet.js:MEDIA_FETCH_CODES 那段）。
 *
 * 3 次的时候 10 轮里还有 1 轮全军覆没，5 次把那个概率压到千分之几
 * （单次失败按 0.35 算，0.35^5 ≈ 0.5%）。代价是最坏情况多传四份几十 KB 的图，
 * 而且只在真失败时才会走到后面几次 —— 顺利的话第一次就出去了。
 *
 * 这一步失败意味着前面生图、转码、上传全白做，多花点流量换成功率是划算的。
 */
const UPLOAD_TRIES = 5;

/**
 * 两次重传之间等一下。
 *
 * 不是为了等图床就绪（实测预热没用），而是别在 Meta 那边连着砸五个请求 ——
 * 那种形状容易被当成异常流量。1.5 秒，最坏情况总共多等 6 秒。
 */
const RETRY_GAP = 1500;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ================= 闸门 ================= */

/**
 * 这个角色现在能往真 IG 上发东西吗。
 *
 * 返回 `{ok, acc, why}`。`why` 只在**用户主动点了同步**时才拿去显示 ——
 * 自动链路上不过闸就是静默跳过。
 *
 * ── `needsHost`：只发文字的路径不该被图床卡住 ──
 *
 * 图床的用途只有一个：发**图**时把图片传上去拿一个公网 URL 给 Meta 下载
 * （Meta 只接受它能自己下载的 URL）。而发一条**纯文字评论**一个字节都不用传，
 * 所以那种路径传 `needsHost: false`，别为一个用不到的东西挡下来 ——
 * 只绑了 token、没配图床的用户照样该能让角色评论。
 *
 * 默认还是 `true`：发布那条路（syncOut）是这个函数最早的调用方，不改它的行为。
 */
export function realGate(config, roleName, data = readAccounts(), opts = {}) {
  const role = roleFor(config, roleName);
  if (!role?.instagram?.enabled) return { ok: false, why: "这个角色没开 Instagram" };
  if (!role.instagram.syncReal) return { ok: false, why: "这个角色没开「同步到真实 IG」" };

  const acc = data.accounts[String(roleName)];
  if (!acc?.token) return { ok: false, why: "这个角色还没绑真 Instagram 账号" };
  if (!accountUsable(acc)) return { ok: false, why: "token 已经过期了，要重新去 Meta 后台生成" };
  if (opts.needsHost !== false && !hostReady(data.settings.imageHost)) {
    return { ok: false, why: "图床还没配" };
  }

  return { ok: true, acc, role };
}

/* ================= 发布 ================= */

/**
 * 把一条**本地已经存好**的帖子 / 快拍同步到真 IG。
 *
 * 顺序是：转 JPEG → 传图床 → 建容器 → 发布 → 回写 media_id → **删图床上那张**。
 *
 * ── 为什么先转格式再传 ──
 *
 * 图床上那张图是给 Meta 下载用的，传上去的越小越快，而 Meta 只吃 JPEG。
 * 先转再传省一次「传了 PNG 又发现不合规」的往返。
 *
 * ── 为什么发完要删 ──
 *
 * 那是一张公网可匿名访问的图。它的用途在 Meta 下载完的那一刻就结束了 ——
 * 留着只是让角色的照片无限期躺在第三方服务器上。删掉之后真 IG 上的帖子
 * 不受影响（Meta 早就存了自己那一份）。
 *
 * ── 幂等 ──
 *
 * `remote.mediaId` 有值就直接返回 —— 已经发过了。这一条让重跑变安全：
 * 轮询里的 `retryPending` 会把失败的重新捡起来，不判这个的话用户会看到
 * 同一条帖子在真 IG 上出现两次。
 *
 * @param {object} config
 * @param {string} roleName
 * @param {object} item 本地那条帖子 / 快拍
 * @param {{isStory?: boolean}} [opts]
 * @returns {Promise<{ok: boolean, mediaId?: string, why?: string}>} **不抛**
 */
export async function syncOut(config, roleName, item, opts = {}) {
  const isStory = Boolean(opts.isStory);
  if (item?.remote?.mediaId) return { ok: true, mediaId: item.remote.mediaId };

  const data = readAccounts();
  const gate = realGate(config, roleName, data);
  if (!gate.ok) return { ok: false, why: gate.why };

  const file = isStory ? item?.image?.file : (item?.images ?? []).find((im) => im.file)?.file;
  if (!file) {
    // 没有真图片的帖子（前端画成「文字图」的那种）发不到真 IG —— Meta 的
    // 发布接口必须有 image_url，没有图就没有帖子。本地照常留着
    return { ok: false, why: "这条没有图片，真 IG 上必须有图才能发" };
  }
  const local = mediaPathFor(file);
  if (!local || !fs.existsSync(local)) return { ok: false, why: "本地那张图找不到了" };

  const noteError = (why) => {
    const remote = { ...(item.remote ?? {}), error: why };
    if (isStory) updateStory(roleName, item.id, { remote });
    else updatePost(roleName, item.id, { remote });
  };

  // 传过的都记下来，finally 里一起删 —— 重传过的那几份也是垃圾
  const uploaded = [];
  try {
    const jpeg = await toIgJpeg(local, { isStory });

    /*
     * 「传图 → 让 Meta 去取」这一对要一起重试。
     *
     * Meta 取不到图时（9004/2207052）会把结果按 URL 记住，所以重试**必须换
     * 一个新地址** —— 对着老 URL 再试多少次都是同一个答案。实测首次成功率
     * 只有一半，换新地址重传之后 8/8 都成了（scripts/diag-igfresh.mjs）。
     *
     * 只对这一种错误重传。别的错误（比例不合规、限流、token 失效）重传一遍
     * 结果一模一样，白花一次上传流量和一次配额。
     */
    let published = null;
    let lastErr = null;
    for (let attempt = 1; attempt <= UPLOAD_TRIES; attempt += 1) {
      const up = await uploadToHost(jpeg.buffer, data.settings.imageHost);
      uploaded.push(up);
      try {
        published = await publishMedia(gate.acc, {
          imageUrl: up.url,
          caption: isStory ? "" : item.caption,
          isStory,
        });
        break;
      } catch (e) {
        lastErr = e;
        if (!isMediaFetchError(e) || attempt === UPLOAD_TRIES) throw e;
        logInfo(
          SCOPE,
          `Meta 取不到刚传上去那张图（第 ${attempt}/${UPLOAD_TRIES} 次），换个地址重传再试`
        );
        await sleep(RETRY_GAP);
      }
    }
    if (!published) throw lastErr ?? new Error("发布没成功");

    const { mediaId, permalink } = published;
    const remote = { mediaId, permalink, at: new Date().toISOString(), error: "" };
    if (isStory) updateStory(roleName, item.id, { remote });
    else updatePost(roleName, item.id, { remote });
    notePublished(roleName);

    logInfo(SCOPE, `${roleName} 的${isStory ? "快拍" : "帖子"}发到真 Instagram 了：${permalink || mediaId}`);
    return { ok: true, mediaId };
  } catch (e) {
    const why = String(e?.message ?? e);
    noteError(why);
    logWarn(SCOPE, `${roleName} 的${isStory ? "快拍" : "帖子"}没发到真 Instagram（本地照常）`, e);
    return { ok: false, why };
  } finally {
    // 发成功也删、发失败也删 —— 失败的那几张更该删，已经没人会去下载了。
    // 重传过的话这里有好几份，一份都不留
    for (const up of uploaded) {
      await deleteFromHost(up.publicId, data.settings.imageHost);
    }
  }
}

/**
 * 把**失败过**的重新发一次。轮询那一轮顺手调。
 *
 * 只捡「有 error、没 mediaId」的，而且**只看最近的**（`limit`）—— 一条三天前
 * 因为图床没配而失败的帖子，现在补发出去也没意义，时间线上会很奇怪。
 *
 * 一轮最多补 3 条：真发布是重活（转码 + 上传 + 两次 Meta 往返），一次全补完
 * 会把这一轮轮询拖很久。
 */
export async function retryPending(config, roleName, limit = 8, max = 3) {
  const posts = readPosts(roleName)
    .slice(0, limit)
    .filter((p) => p.remote?.error && !p.remote?.mediaId);
  const out = [];
  for (const post of posts.slice(0, max)) {
    out.push(await syncOut(config, roleName, post, { isStory: false }));
  }
  return out;
}

/* ================= 铺路 @ + 角色互评 ================= */

/**
 * 让 `actorName` 去评论 `ownerName` 在真 IG 上的那条帖子。
 *
 * 这是**唯一**需要两个 token 配合的动作，也是全套里最脆的一环：
 *
 *   ① 帖主用自己的 token 在自己帖子下发 `@actor …`（通行证）
 *   ② actor 用自己的 token 打 `/{actor的ig-id}/mentions` 说话
 *
 * ── 2026-09-13 实测：两步都通 ──
 *
 * ① `POST /{media}/comments` 回了 id，② `POST /{ig-id}/mentions` 也回了 id
 * （`{"id":"17956034805218766"}`）。Mentions 接口在 Instagram Login 路线下
 * **是可用的** —— 这一条以前标着「未实测」，现在实测过了。
 *
 * 唯一没法自证的是「评论区里最终长什么样」：`/{media}/comments` 现在读不回
 * 内容（token 缺 `instagram_business_manage_comments`，详见 igapi.js:listComments
 * 那段注释），所以只能靠 `comments_count` 涨了来确认东西进去了。
 *
 * ── ① 那条 @ 用完就删 ──
 *
 * 通行证的用途在②成功的那一刻就结束了。`DELETE /{comment-id}` 实测是通的
 * （回 `{"success":true}`，count 跟着降），所以这里删掉它 —— 评论区不留
 * 「@某人」这种人工痕迹。删不掉也不算失败：②已经成功，正文已经在了。
 *
 * ②失败的话同样删掉①，然后把这个能力关掉（`settings.mentionsBroken`），
 * 之后角色互评只走本地，不再每轮留一句无人应答的 @。用户可以在界面上重置。
 *
 * @returns {Promise<{ok: boolean, why?: string}>} **不抛**
 */
export async function peerComment(config, ownerName, actorName, item, text) {
  const mediaId = item?.remote?.mediaId;
  if (!mediaId) return { ok: false, why: "帖主那条帖子还没同步到真 IG" };

  const data = readAccounts();
  if (data.settings.mentionsBroken) {
    return { ok: false, why: "Mentions 接口之前试过不通，角色互评只走本地" };
  }

  // 铺路的 @ 和正文都是纯文字，两边都不用图床
  const ownerGate = realGate(config, ownerName, data, { needsHost: false });
  if (!ownerGate.ok) return { ok: false, why: `帖主那边：${ownerGate.why}` };
  const actorGate = realGate(config, actorName, data, { needsHost: false });
  if (!actorGate.ok) return { ok: false, why: `评论方那边：${actorGate.why}` };

  const handle = actorGate.acc.username;
  if (!handle) return { ok: false, why: "不知道评论方的 IG 用户名（重新验证一次 token 就有了）" };

  // ① 铺路。@ 藏在评论区，不污染正文文案
  let passId = "";
  try {
    passId = await addComment(ownerGate.acc, mediaId, `@${handle}`);
  } catch (e) {
    const why = String(e?.message ?? e);
    logWarn(SCOPE, `${ownerName} 铺不了那条 @ 评论，${actorName} 的互评只留在本地`, e);
    return { ok: false, why };
  }

  /**
   * 把①那条通行证删掉。成功失败都调 —— 它的用途到这儿就结束了。
   *
   * 用帖主的 token：那是帖主自己发在自己帖子下的评论，权限天然具备。
   * 删失败只记一句日志，不影响返回值：正文该在的已经在了，多留一句 @
   * 是审美问题，不是功能问题。
   */
  const dropPass = async () => {
    try {
      await deleteComment(ownerGate.acc, passId);
    } catch (e) {
      logWarn(SCOPE, `${ownerName} 那条铺路的 @ 评论没删掉（真 IG 上会留一句）`, e);
    }
  };

  // ② 进门
  try {
    await replyAsMentioned(actorGate.acc, mediaId, passId, text);
    await dropPass();
    logInfo(SCOPE, `${actorName} 在真 Instagram 上评论了 ${ownerName} 的帖子`);
    return { ok: true };
  } catch (e) {
    const why = String(e?.message ?? e);
    await dropPass();
    // 关掉这个能力：不然每一轮都会在评论区留一句没人应答的 @
    writeRealSettings({ mentionsBroken: true });
    logWarn(
      SCOPE,
      "Mentions 接口不通，角色互评从现在起只走本地（Instagram 那一页可以重置这个状态）",
      e
    );
    return { ok: false, why };
  }
}

/**
 * 让角色去评论**你自己**真 IG 上的那条帖子 —— 靠你在配文里写的那句 `@角色`。
 *
 * ── 为什么这条要单独存在 ──
 *
 * 我们没有你帖子的写权限（那是你的号），所以角色的评论一直只能留在本地
 * （igrun.js:commentToReal 那条 `owner === USER_OWNER` 的短路）。但 Meta 留了
 * 一个后门：**被 @ 的人可以进来说话**。而在你自己的帖子里 @ 谁，是你说了算的。
 *
 * 和 `peerComment` 的区别只在通行证是谁铺的：
 *
 *   peerComment       程序用帖主的 token 铺一条 `@角色` 评论，用完删掉
 *   这里（用户的帖子） **你自己**在配文里写 `@角色` —— 我们连铺都不用铺
 *
 * 所以这条比角色互评**更省**：不需要额外权限、不需要发一条再删一条、真 IG 的
 * 评论区不留任何程序痕迹。代价是那句 @ 会留在你的配文里给所有人看见 ——
 * 那是你自己写的，删不删由你。
 *
 * ── 为什么认配文、不认评论区的 @ ──
 *
 * 用户最自然的做法是发完帖子在下面评论一句 `@角色`，但那条路现在走不通：要认出
 * 它得先能**读**自己帖子下的评论，而评论读权限是缺的（igapi.js:listComments 那段
 * 注释）。配文相反 —— `GET /me/media?fields=caption` 是基础权限，今天就能读。
 *
 * 权限齐了之后评论区那条也能通（`replyAsMentioned` 的 commentId 形态就是为它
 * 留的），到时候在 `syncUserIn` 里多认一次评论即可，这个函数一行都不用改。
 *
 * @param {object} config
 * @param {string} roleName 被 @ 的那个角色
 * @param {object} post 你那条帖子（本地那份，要有 remote.mediaId）
 * @param {string} text 角色要说的话
 * @returns {Promise<{ok: boolean, why?: string}>} **不抛**
 */
export async function commentOnUserPost(config, roleName, post, text) {
  const mediaId = post?.remote?.mediaId;
  if (!mediaId) return { ok: false, why: "你那条帖子不是从真 IG 拉进来的" };

  const data = readAccounts();
  if (data.settings.mentionsBroken) {
    return { ok: false, why: "Mentions 接口之前试过不通，这条评论只走本地" };
  }

  // 一条纯文字评论不传图，别被图床卡住
  const gate = realGate(config, roleName, data, { needsHost: false });
  if (!gate.ok) return { ok: false, why: gate.why };

  const handle = gate.acc.username;
  if (!handle) return { ok: false, why: "不知道这个角色的 IG 用户名（重新验证一次 token 就有了）" };

  /*
   * 再验一次「配文里真的 @ 了它」。
   *
   * 调用方（igrun.js:commentToReal）已经判过一次，这里重判是因为**判错的代价
   * 不对称**：没被 @ 就打这个端点，Meta 会拒（那条 @ 是唯一的授权依据），
   * 而一次被拒会把 `mentionsBroken` 置上、连**角色互评**一起关掉。
   * 多读一个字符串换掉这个风险很划算。
   */
  if (!mentionedHandles(post.caption).includes(handle)) {
    return { ok: false, why: `你那条帖子的配文里没有 @${handle}` };
  }

  try {
    // commentId 留空 = 回配文里那个 @，会在帖子下生成一条顶层评论
    await replyAsMentioned(gate.acc, mediaId, "", text);
    logInfo(SCOPE, `${roleName} 在真 Instagram 上评论了你的帖子（靠你配文里那句 @）`);
    return { ok: true };
  } catch (e) {
    const why = String(e?.message ?? e);
    /*
     * 这里**不置 mentionsBroken**。
     *
     * peerComment 那边置它是因为失败会在评论区留一条没人应答的 @（我们自己铺的），
     * 每轮都留就成了噪音。这条链路没有铺路那一步，失败什么痕迹都不留 ——
     * 而顺手把角色互评一起关掉是过度反应。下一条帖子照常再试。
     */
    logWarn(SCOPE, `${roleName} 那条评论没发到你的真 IG（本地照常）`, e);
    return { ok: false, why };
  }
}

/**
 * 角色回一条真 IG 上的评论。**自己的帖子，不需要 @** —— 最稳的一条链路。
 */
export async function replyOut(config, roleName, commentRemoteId, text) {
  if (!commentRemoteId) return { ok: false, why: "那条评论没有真 IG 的 id" };
  const data = readAccounts();
  // 纯文字回复，不传图
  const gate = realGate(config, roleName, data, { needsHost: false });
  if (!gate.ok) return { ok: false, why: gate.why };

  try {
    await replyToComment(gate.acc, commentRemoteId, text);
    logInfo(SCOPE, `${roleName} 在真 Instagram 上回了一条评论`);
    return { ok: true };
  } catch (e) {
    logWarn(SCOPE, `${roleName} 那条回复没发到真 Instagram（本地照常）`, e);
    return { ok: false, why: String(e?.message ?? e) };
  }
}

/* ================= 拉回来 ================= */

/**
 * 下载一张远端图片，存进 media/，返回本地文件名。
 *
 * **必须现在就下**：Meta 给的 `media_url` 是 CDN 链接，几小时到几天就失效。
 * 只存 URL 的话过一阵子本地面板全是裂图，识图那一步也拿不到图。
 *
 * 跟着「Instagram」那个勾走（和 uploadToHost 同理）。CDN 本身国内直连大多通，
 * 但它和上面那一串 Graph API 调用是同一条链路 —— 一个勾管到底，用户才猜得到
 * 勾了会发生什么。
 */
async function downloadMedia(url) {
  if (!url) return "";
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(IG_TIMEOUT),
      ...(await proxyFor("ig")),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error("下回来是空的");
    // Meta 的 CDN 给的都是 jpg
    const ext = /\.png(\?|$)/i.test(url) ? "png" : "jpg";
    return saveMedia(buf.toString("base64"), ext);
  } catch (e) {
    logWarn(SCOPE, "远端那张图没下下来（这条会当成没有图片处理）", e);
    return "";
  }
}

/**
 * 把**你自己**真 IG 上的新帖子和快拍镜像进本地。
 *
 * 默认**不做**（`settings.syncUser` 是 false，用户定的）。开了要额外一条大号
 * token，而且会把你的真实生活内容喂给模型 —— 那得是明确的选择。
 *
 * 去重靠 `remote.mediaId`：本地已经有同一个 mediaId 的就跳过。**不用「最后
 * 看到的 id」**那种游标 —— 游标会在「你删了一条帖子」时错位，而按 id 比对
 * 只是多读一个文件，帖子数量级就几百条。
 *
 * 镜像进来的 owner 是 `user`，所以角色的常规掷骰子逻辑会自然触发（刷到你的
 * 新帖 → 点赞或评论），一行都不用改。
 *
 * ── 配文里那句 @ 是有用的 ──
 *
 * 你在真 IG 的配文里写 `@角色的用户名`，那句 @ 跟着 `caption` 一起镜像进来，
 * 然后有两处会认它：igrun.js:mentionsRole 让被点名的角色跳过点赞那一掷、直接
 * 说话，igreal.js:commentOnUserPost 拿它当通行证把那句评论发回你的真帖子下。
 * 这一段本身不用为它做任何事 —— 照原样存下 caption 就够了。
 *
 * @returns {Promise<{posts: number, stories: number}>} 这次新拉进来几条
 */
export async function syncUserIn(config, opts = {}) {
  const data = opts.data ?? readAccounts();
  const out = { posts: 0, stories: 0 };
  if (!data.settings.syncUser) return out;
  if (!accountUsable(data.user)) return out;

  const known = new Set(
    readPosts(USER_OWNER)
      .map((p) => p.remote?.mediaId)
      .filter(Boolean)
  );
  const knownStories = new Set(
    readStories(USER_OWNER)
      .map((s) => s.remote?.mediaId)
      .filter(Boolean)
  );

  const { schedulePublish } = await import("./igrun.js");

  try {
    for (const m of await listMedia(data.user)) {
      if (!m.id || known.has(m.id)) continue;
      const file = await downloadMedia(m.mediaUrl);
      const post = addPost(USER_OWNER, {
        caption: m.caption,
        images: file ? [{ file, alt: "" }] : [],
        createdAt: m.timestamp || new Date().toISOString(),
        remote: { mediaId: m.id, permalink: m.permalink, at: new Date().toISOString(), error: "" },
      });
      // 角色照常刷到它 —— 镜像进来的帖子和你在面板上手发的没有区别
      schedulePublish(config, USER_OWNER, post, { isStory: false });
      out.posts += 1;
    }
  } catch (e) {
    logWarn(SCOPE, "拉你自己的真 IG 帖子时出错（本地不受影响）", e);
  }

  try {
    for (const m of await listStories(data.user)) {
      if (!m.id || knownStories.has(m.id)) continue;
      const file = await downloadMedia(m.mediaUrl);
      const story = addStory(USER_OWNER, {
        caption: m.caption,
        image: file ? { file, alt: "" } : { file: "", alt: "" },
        createdAt: m.timestamp || new Date().toISOString(),
        remote: { mediaId: m.id, permalink: m.permalink, at: new Date().toISOString(), error: "" },
      });
      schedulePublish(config, USER_OWNER, story, { isStory: true });
      out.stories += 1;
    }
  } catch (e) {
    logWarn(SCOPE, "拉你自己的真 IG 快拍时出错（本地不受影响）", e);
  }

  if (out.posts || out.stories) {
    logInfo(SCOPE, `从你的真 Instagram 拉进来 ${out.posts} 条帖子、${out.stories} 条快拍`);
  }
  return out;
}

/**
 * 拉角色帖子下的**新评论**，写进本地，并触发角色回应。
 *
 * ── 白名单在这儿把关 ──
 *
 * 谁的评论都镜像进本地（那是「真 IG 上发生了什么」的忠实记录），但**只有
 * 白名单里的人**能让角色回应。空白名单 = 谁都不理，只镜像 —— 用户定的默认，
 * 理由在 igaccounts.js:defaultSettings 里：小号是公开的，任何陌生人都能留言，
 * 角色自动回复陌生人既烧钱又可能说出不该说的话。
 *
 * 自己人（已绑定的角色小号、你的大号）永远算数，不用手填 —— 角色互评那条
 * 链路正是靠这个走通的。
 *
 * ── 评论的 owner 怎么定 ──
 *
 * 四种，从近到远：
 *
 *   你的大号        → `user`（那就是你在说话，走最稳的那条回复链路）
 *   另一个角色的小号 → 那个角色名（角色互评靠这条）
 *   白名单里的人     → 白名单里给它起的**显示名**（「小明」），模型看到的就是这个
 *   剩下的（陌生人） → `@用户名` 原样。本地面板上看得见，但角色不会理它
 *
 * 白名单那条为什么要换成显示名：`@myigaccount` 这种串模型念不出来，还会
 * 学着在评论里叫它。用户的原话是「不带用户名（太长），就显示小明给 LLM
 * 就可以了」。没填显示名就退回 `@用户名`。
 */
export async function syncCommentsIn(config, roleName, opts = {}) {
  const data = opts.data ?? readAccounts();
  // 只读评论，一张图都不传
  const gate = realGate(config, roleName, data, { needsHost: false });
  if (!gate.ok) return { added: 0 };

  const { scheduleComment } = await import("./igrun.js");

  // 谁的用户名对应哪个本地 owner
  const byHandle = new Map();
  if (data.user.username) byHandle.set(data.user.username, USER_OWNER);
  for (const acc of Object.values(data.accounts)) {
    if (acc.username && acc.roleName) byHandle.set(acc.username, acc.roleName);
  }

  let added = 0;
  // 只看最近几条帖子：老帖子下面基本不会再有新评论，而每条帖子都是一次请求
  const posts = readPosts(roleName)
    .filter((p) => p.remote?.mediaId)
    .slice(0, 5);

  for (const post of posts) {
    let remoteList = [];
    try {
      remoteList = await listComments(gate.acc, post.remote.mediaId);
    } catch (e) {
      logWarn(SCOPE, `拉 ${roleName} 那条帖子的评论时出错（跳过）`, e);
      continue;
    }

    // 本地已经有的（含我们自己发出去的），靠 remote.mediaId 去重
    const fresh = readPosts(roleName).find((p) => p.id === post.id);
    if (!fresh) continue;
    const known = new Set(
      (fresh.comments ?? []).map((c) => c.remote?.mediaId).filter(Boolean)
    );
    // 本地评论 id ← 远端 id，用来把「回复某条评论」对上
    const localByRemote = new Map(
      (fresh.comments ?? []).filter((c) => c.remote?.mediaId).map((c) => [c.remote.mediaId, c.id])
    );

    const incoming = remoteList.filter((c) => c.id && !known.has(c.id));
    if (!incoming.length) continue;

    let list = [...(fresh.comments ?? [])];
    const saved = [];
    for (const c of incoming) {
      const handle = normalizeUsername(c.username);
      // 角色自己发的（我们自己刚发出去那条）—— 补上 remote id 就好，不是新评论
      if (handle && handle === gate.acc.username) continue;

      /*
       * 自己人 → 角色名 / user；白名单里的 → 给它起的显示名；都没有 → @用户名。
       *
       * 显示名**不许撞角色名**：白名单里把某人起名叫「阿瑞」的话，这条评论
       * 的 owner 就成了本地那个 阿瑞，界面上显示成角色自己说的话，
       * `peerAllowed` 也会拿它当角色去查名单。撞了就退回 `@用户名` —— 宁可
       * 名字丑一点，也不能让外人顶着角色的身份说话。
       */
      const mine = byHandle.get(handle) ?? "";
      const label = allowLabelFor(handle, data.settings);
      const usable = label && label !== USER_OWNER && !roleFor(config, label) ? label : "";
      const owner = mine || usable || (handle ? `@${handle}` : "匿名");
      // 既不是用户也不是本地角色 = 真 IG 上的外人，走 scheduleComment 的 outsider 那条
      const outsider = !mine;
      list = [
        ...list,
        {
          owner,
          text: c.text,
          at: c.timestamp || new Date().toISOString(),
          replyTo: c.replyTo ? localByRemote.get(c.replyTo) ?? "" : "",
          remote: { mediaId: c.id, permalink: "", at: new Date().toISOString(), error: "" },
        },
      ];
      saved.push({ handle, owner, outsider });
    }
    if (!saved.length) continue;

    const after = updatePost(roleName, post.id, { comments: list });
    const stored = (after?.comments ?? []).slice(-saved.length);
    added += saved.length;

    for (const [i, entry] of saved.entries()) {
      const comment = stored[i];
      if (!comment) continue;
      // 白名单：不在里面的只镜像，不惊动角色
      if (!allowedFrom(entry.handle, data.settings, data)) {
        logInfo(
          SCOPE,
          `@${entry.handle || "匿名"} 在 ${roleName} 的帖子下留了言，不在可互动白名单里，只记进本地`
        );
        continue;
      }
      scheduleComment(config, roleName, after, comment, {
        isStory: false,
        outsider: entry.outsider,
      });
    }
  }

  if (added) logInfo(SCOPE, `${roleName} 的真 Instagram 帖子下拉到 ${added} 条新评论`);
  return { added };
}

/* ================= 轮询 ================= */

/**
 * 到点了吗。
 *
 * `intervalHours = 0` 表示**不轮询**（只发不收）。勿扰时段里也不轮询 ——
 * 拉到一条新评论会让角色排队回复，而那一轮**可能顺带发一条短信**
 * （runIgTask 的 dm 分支）。半夜被角色的 IG 回复吵醒和被主动消息吵醒是
 * 同一件事，该守同一条规矩。
 */
export function pollDue(settings, now = Date.now()) {
  const hours = Number(settings?.intervalHours);
  if (!Number.isFinite(hours) || hours <= 0) return false;
  if (inDnd(settings, now)) return false;
  return now - Number(settings.lastPollAt ?? 0) >= hours * 3600_000;
}

/**
 * 一轮轮询：续 token → 拉你的帖子 → 拉角色帖子下的评论 → 补发失败的。
 *
 * ── 为什么续期在这儿、不另开定时器 ──
 *
 * token 60 天到期、提前 7 天开始续，也就是说「多久检查一次」只要远小于 7 天
 * 就行 —— 默认 3 小时的轮询绰绰有余。为它单独挂一路定时器，只会多一个能
 * 忘记停掉的东西。
 *
 * ── 顺序有讲究 ──
 *
 * 续期在最前面：后面几步全要用 token，先把快过期的换掉，免得这一轮做到一半
 * 撞上 190（token 失效）。
 *
 * @param {object} config
 * @param {{now?: number, force?: boolean}} [opts] `force` 跳过「到点了吗」，
 *        给界面上那个「立刻同步一次」按钮用
 * @returns {Promise<object>} 这一轮做了什么，给界面显示
 */
export async function pollOnce(config, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const data = readAccounts();
  const out = { ran: false, refreshed: [], user: { posts: 0, stories: 0 }, comments: 0, retried: 0 };

  if (!opts.force && !pollDue(data.settings, now)) return out;
  out.ran = true;

  // ① 续期。你的大号和所有角色一起过一遍
  for (const [name, acc] of [["", data.user], ...Object.entries(data.accounts)]) {
    if (!needsRefresh(acc, now)) continue;
    const next = await refreshAccount(name, acc);
    if (next) out.refreshed.push(name || "你的大号");
  }

  // 续完重读一份，后面用的是新 token
  const fresh = readAccounts();

  // ② 你的真 IG → 本地（默认关）
  out.user = await syncUserIn(config, { data: fresh });

  // ③ 角色帖子下的新评论 → 本地 → 触发回应
  for (const name of Object.keys(fresh.accounts)) {
    const r = await syncCommentsIn(config, name, { data: fresh });
    out.comments += r.added;
  }

  // ④ 之前发失败的补一发
  for (const name of Object.keys(fresh.accounts)) {
    const results = await retryPending(config, name);
    out.retried += results.filter((r) => r.ok).length;
  }

  writeRealSettings({ lastPollAt: now });
  return out;
}

/**
 * 起轮询定时器。
 *
 * 每 5 分钟看一眼「到点了吗」，而不是直接按 `intervalHours` 设一个长间隔 ——
 * 用户随时会把间隔从 3 小时改成 1 小时，长间隔的话得重启进程才生效。
 * 一次 tick 的成本是读一个 JSON 文件加一次减法。
 *
 * 形状照抄 igrun.js:startIgQueue：unref 掉别拖着进程退出，返回停止函数。
 */
const TICK_MS = 5 * 60_000;

export function startIgPolling(getConfig, opts = {}) {
  const tick = async () => {
    const config = getConfig?.();
    if (!config) return;
    const data = readAccounts();
    // 一个真号都没绑就什么都不做 —— 这是绝大多数用户的状态
    if (!data.user.token && !Object.keys(data.accounts).length) return;
    await pollOnce(config, opts);
  };

  const timer = setInterval(() => {
    void tick().catch((e) => logWarn(SCOPE, "真 Instagram 这一轮轮询出错（本地不受影响）", e));
  }, TICK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/* ================= 给界面用的概览 ================= */

/**
 * Instagram 那一页要显示的状态。
 *
 * **绝不返回 token 本身** —— 只返回「绑了没有」和用户名。前端不需要 token，
 * 而 `GET /api/ig/real` 的响应会进浏览器的网络面板、可能被截图分享出去。
 * 图床的 secret 同理：只回一个 `configured` 布尔值。
 */
export function realOverview(config) {
  const data = readAccounts();
  const now = Date.now();

  const one = (name, acc) => ({
    roleName: name,
    bound: Boolean(acc.token),
    username: acc.username,
    userId: acc.userId,
    expiresAt: acc.expiresAt,
    // 还能用几天，界面上显示「还有 N 天到期」
    days: acc.expiresAt ? Math.max(0, Math.round((acc.expiresAt - now) / 86400_000)) : 0,
    refreshedAt: acc.refreshedAt,
    lastError: acc.lastError,
    published24h: (acc.publishedAt ?? []).filter((t) => now - t < 86400_000).length,
  });

  return {
    settings: {
      ...data.settings,
      imageHost: {
        provider: data.settings.imageHost.provider,
        cloudName: data.settings.imageHost.cloudName,
        // key / secret 不回前端
        configured: hostReady(data.settings.imageHost),
      },
    },
    user: one("", data.user),
    /*
     * 没起名字的角色**不列出来**。
     *
     * 空名字会让整条链路对不上：IG 这一整套拿角色名当标识（igstore.js:ownerKeyFor），
     * 而 `POST /api/ig/real/bind` 里 `roleName` 是空串**表示你自己的大号** ——
     * 列出来的话，给一个没名字的角色点「绑定」会悄悄把你大号的 token 换掉。
     * 主页那一栏对没名字的角色也是同样的处理（instagram.jsx 里那张「还没起名字」的卡）。
     */
    accounts: (config?.roles ?? [])
      .filter((r) => r?.instagram?.enabled && String(r.name ?? "").trim())
      .map((r) => {
        const name = String(r.name).trim();
        const acc = data.accounts[name];
        return {
          ...one(name, acc ?? { token: "", username: "", userId: "", publishedAt: [] }),
          roleId: String(r.id ?? ""),
          syncReal: Boolean(r.instagram.syncReal),
        };
      }),
    inDnd: inDnd(data.settings, now),
    pollDue: pollDue(data.settings, now),
    proxy: proxyNote(),
  };
}

/**
 * 代理配没配，Instagram 那一页上提示一句。**不显示地址** —— 里面可能带账号密码。
 *
 * 判据是 `usesProxy("ig")`，也就是「地址填了**并且**Instagram 这一类勾上了」——
 * 光看有没有地址不够：现在一个地址下面挂着九个勾，只勾了天气的人在这一页
 * 会看到「代理已配好」，然后照旧连不上 Meta，界面上还告诉他配好了。
 *
 * `from` 是这个地址读自哪儿（控制台 / 某个环境变量），照旧只给来源不给值。
 */
function proxyNote() {
  const on = usesProxy("ig");
  return { configured: on, from: on ? proxyStatus().from : "" };
}
