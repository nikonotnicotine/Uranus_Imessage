/**
 * Instagram 那一轮真正**跑起来**的地方：排队 → 到点 → 掷骰子 → 打模型 → 落盘。
 *
 * ── 为什么要排队、而不是当场跑 ──
 *
 * 用户发一条帖子，五个开了 IG 的角色不该在同一秒齐刷刷冒出来评论 —— 那看着
 * 就像机器人。每个角色各自有个等待窗口（默认 30–120 分钟），在窗口里随机挑
 * 一个时刻，到点才轮到它。窗口跨得比进程寿命长，所以队列**落盘**
 * （igstore.js:pushQueue），重启接着跑。
 *
 * ── 骰子在哪儿掷 ──
 *
 * 全部在 `runIgTask` 里、到点那一刻掷，排队那一步一个随机数都不用。这样
 * 「排了几条任务」是确定的，能离线测；概率这种会变的策略只长在一个地方。
 *
 *   likeChance   刷到新帖 / 新快拍时掷。**中了就只点赞、不打模型**
 *                （config.js 里那行注释定的：一次互动只花一次钱）。
 *   replyChance  用户来评论时掷。没中就当没看见 —— 不改成「那就点个赞」，
 *                不然动态列表里会冒出一堆没人要的赞。
 *
 * 角色之间的评论（charComment）不掷 replyChance，它由白名单（peerAllowed）
 * 和线程条数上限（canChain）管着，已经够严了。
 *
 * ── 这个文件的边界 ──
 *
 * 只 import 叶子模块：config / llm / logs / media / igstore / igprompt /
 * igtags / instagram / igaccounts。**不认识 runner，也不碰 space** —— 和 proactive.js
 * 一个路子。上文怎么拿、短信怎么发、这一轮怎么写进记忆库，全由调用方通过
 * `opts.session` 那个回调提供（真正的实现在 imessage.js，那边才有 sendBubbles
 * / appendTurn / afterTurn）。搬过来就是循环依赖。
 */

import fs from "node:fs";
import path from "node:path";

import { applyVars, resolveImageEndpoint, resolveRoleEndpoints, resolveUser } from "./config.js";
import { mentionedHandles, readAccounts, roleHandleMap } from "./igaccounts.js";
import { buildIgPrompt, defaultTemplate } from "./igprompt.js";
import {
  DEFAULT_STORY_HOURS,
  USER_OWNER,
  addActivity,
  addPost,
  addStory,
  dropQueue,
  dueTasks,
  mediaPathFor,
  pruneVisionNotes,
  pushQueue,
  readPosts,
  readQueue,
  readSettings,
  readStories,
  saveMedia,
  storyExpired,
  updatePost,
  updateStory,
} from "./igstore.js";
import { hasIgPublishTag, hasImageTag, splitIg } from "./igtags.js";
import { canChain, igOwners, peerAllowed, roleFor } from "./instagram.js";
import { chatWithFallback, describeImage } from "./llm.js";
import { logDebug, logError, logInfo, logWarn } from "./logs.js";
import { generateImage, mimeForExt } from "./media.js";

const SCOPE = "Instagram";

/* ================= 小工具 ================= */

function roleById(config, id) {
  const want = String(id ?? "");
  if (!want) return null;
  return (config?.roles ?? []).find((r) => String(r?.id ?? "") === want) ?? null;
}

/** 这个角色现在开着 IG 没有。角色被删了、开关关了，排着的任务就作废。 */
function igOn(role) {
  return Boolean(role?.instagram?.enabled);
}

/**
 * 这条任务什么时候跑：等待窗口里随机挑一个时刻。
 *
 * normalizeInstagram 已经把上下限夹好、反了的换过来了，这里再兜一层是因为
 * 这个函数也被测试直接调，给它传一份手搓的 role 不该炸。
 */
export function delayFor(role, now = Date.now(), roll = Math.random) {
  const w = role?.instagram?.replyWindow ?? {};
  const a = Number(w.minMinutes) > 0 ? Number(w.minMinutes) : 30;
  const b = Number(w.maxMinutes) > 0 ? Number(w.maxMinutes) : 120;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return now + Math.round((lo + roll() * (hi - lo)) * 60_000);
}

/** 百分数掷骰子。`chance` 是 0–100 的整数。 */
function hit(chance, roll) {
  const c = Number(chance);
  if (!Number.isFinite(c) || c <= 0) return false;
  return roll() * 100 < c;
}

/**
 * 这条内容的配文里**点名**了这个角色吗（`@它的真 IG 用户名`）。
 *
 * ── 为什么点名要影响掷骰子 ──
 *
 * 你在配文里 @ 一个角色，意思是「我要它来说话」，不是「请它掷一次骰子」。
 * 默认 50% 的 `likeChance` 中了就只点个赞、不打模型（runIgTask 里那条规矩），
 * 也就是说你 @ 完有一半概率只收到一个赞 —— 那不是你要的。
 *
 * 所以被点名的角色**跳过点赞那一掷**，直接走到模型。只跳这一掷：白名单、
 * 快拍过期、线程上限那些闸一个都不动 —— 那几个管的是别的事。
 *
 * 只认**已经绑了真号**的角色（`roleHandleMap`）：没绑号的角色没有 IG 用户名，
 * 配文里那串 @ 指不到它。所以纯本地玩法（一个真号都没绑）行为完全不变。
 *
 * 读不到账号文件就当没点名 —— 这个判断只用来放宽概率，失败该退回默认行为。
 */
function mentionsRole(item, role) {
  const caption = String(item?.caption ?? "");
  if (!caption.includes("@")) return false;
  const name = String(role?.name ?? "");
  if (!name) return false;
  try {
    const byHandle = roleHandleMap(readAccounts());
    return mentionedHandles(caption).some((h) => byHandle.get(h) === name);
  } catch {
    return false;
  }
}

/** 一条评论所在线程的根评论 id（顺着 replyTo 往上走）。 */
export function rootOf(list, id) {
  const byId = new Map((list ?? []).map((c) => [c.id, c]));
  let cur = byId.get(String(id ?? ""));
  // IG 的评论只有两层，走两步就到头了；给个上限纯粹是防脏数据自己指自己
  for (let i = 0; i < 8 && cur?.replyTo && byId.has(cur.replyTo); i += 1) {
    cur = byId.get(cur.replyTo);
  }
  return cur?.id ?? String(id ?? "");
}

/* ================= 排队 ================= */

/**
 * 谁会刷到 `owner` 发的东西。
 *
 * 用户发的：所有开了 IG 的角色都刷得到（用户是主角，不受白名单管）。
 * 角色发的：只有把它加进自己互动名单的角色刷得到 —— 名单是**单向**的
 * （instagram.js:peerAllowed 只看行动方自己那份），A 愿意理 B 不代表 B 愿意理 A。
 */
export function audienceFor(config, owner) {
  const roles = (config?.roles ?? []).filter(igOn);
  if (owner === USER_OWNER) return roles;
  return roles.filter((r) => String(r?.name ?? "") !== owner && peerAllowed(config, r, owner));
}

/**
 * 有人发了新帖 / 新快拍 → 给每个刷得到的角色排一条任务。
 *
 * **角色发的快拍不触发任何人**：场景模板里压根没有 charStory 这一条
 * （igprompt.js:IG_SCENES）。快拍在 IG 上本来就是「看过就算」的东西，
 * 让角色之间互相追着对方的快拍评论，只会把上下文撑爆。
 *
 * @returns {object[]} 排进去的任务
 */
export function schedulePublish(config, owner, item, opts = {}) {
  const isStory = Boolean(opts.isStory);
  if (!item?.id) return [];
  if (isStory && owner !== USER_OWNER) return [];

  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const roll = opts.roll ?? Math.random;
  const kind = owner === USER_OWNER ? (isStory ? "userStory" : "userPost") : "charPost";

  const out = [];
  for (const role of audienceFor(config, owner)) {
    out.push(
      pushQueue({
        at: delayFor(role, now, roll),
        roleId: String(role.id ?? ""),
        kind,
        postOwner: owner,
        postId: isStory ? "" : item.id,
        storyId: isStory ? item.id : "",
        commentId: "",
        chain: 0,
      })
    );
  }
  return out;
}

/**
 * 有人留了条评论 / 回了条快拍 → 给**被说话的那个人**排一条任务。
 *
 * 「被说话的那个人」= 回复某条评论时是那条评论的作者，顶层评论时是内容的主人。
 * 目标是用户就不排 —— 回不回是用户自己的事，轮不到程序替他决定。
 *
 * 角色对角色那条还要过两道闸：
 *   1. 白名单（peerAllowed）：目标角色愿不愿意理行动方。
 *   2. 线程上限（canChain）：这条线程已经来回够了就打住。上限取**帖主**那份
 *      设置 —— 一条线程的长短该由地盘的主人定；帖主是用户的话他没有这项设置，
 *      退回到要说话的那个角色自己的。
 *
 * ── `opts.outsider`：真 IG 上的外人 ──
 *
 * 说话的既不是用户、也不是本地任何一个角色 —— 那是**真 IG 白名单里的某个人**
 * （igreal.js:syncCommentsIn 拉回来的评论，owner 是白名单里给它起的显示名）。
 * 这种要单独放一条路，因为上面那两道闸对它都是错的：
 *
 *   · `peerAllowed` 查的是「目标角色的 peers 里有没有行动方**这个角色**」，
 *     而外人不是角色 —— 查出来永远是 false，等于白名单形同虚设。
 *     **这是这一条存在的直接原因**：在它之前，白名单里加谁都不会有人回。
 *   · `canChain` 是防角色之间「变成永动机」的。外人是真人，一句一句手打的，
 *     没有永动机可言；套上去的效果是真朋友聊两句就被无视。
 *
 * 只认调用方明确传进来的 `outsider`，而且**行动方必须真的不是本地角色** ——
 * 传错了也不能让一个角色绕过 peers 名单。谁是外人由 syncCommentsIn 判断，
 * 它在那之前已经过了 `allowedFrom` 那道闸：不在白名单里的评论只镜像，压根
 * 走不到这儿（用户定的「陌生人不要让 LLM 回复」）。
 */
export function scheduleComment(config, owner, item, comment, opts = {}) {
  const isStory = Boolean(opts.isStory);
  if (!item?.id || !comment?.id) return [];

  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const roll = opts.roll ?? Math.random;
  const actor = String(comment.owner ?? "");
  const list = (isStory ? item.replies : item.comments) ?? [];

  const parent = comment.replyTo ? list.find((c) => c.id === comment.replyTo) : null;
  const targetOwner = parent ? String(parent.owner ?? "") : String(owner ?? "");
  if (!targetOwner || targetOwner === actor) return []; // 自言自语不触发
  if (targetOwner === USER_OWNER) return [];

  const role = roleFor(config, targetOwner);
  if (!igOn(role)) return [];

  const fromUser = actor === USER_OWNER;
  // 外人：调用方说是，而且这个名字确实不对应任何本地角色（防传错绕过 peers）
  const fromOutsider = Boolean(opts.outsider) && !fromUser && !roleFor(config, actor);

  if (!fromUser && !fromOutsider) {
    // 角色之间：快拍底下不接，那儿没有线程结构，数不出来回了几次
    if (isStory) return [];
    if (!peerAllowed(config, role, actor)) return [];
    const max = (roleFor(config, owner) ?? role)?.instagram?.maxChain;
    if (!canChain(item, rootOf(list, comment.id), max)) return [];
  }

  return [
    pushQueue({
      at: delayFor(role, now, roll),
      roleId: String(role.id ?? ""),
      /*
       * 外人算 `userComment`。
       *
       * 那个 kind 决定两件事：走哪条场景模板（igprompt.js），以及**能不能顺带
       * 发条短信**（runIgTask 里 isPeer 那个判断）。外人更像「有人来跟你说话」
       * 而不是「另一个角色来跟你说话」：模板里那句「{{user}} 在 Instagram 上给
       * 你留了言」会被 markFor 换成真正的说话人，而角色为此跟用户提一句
       * 「刚有人在我帖子下面留言」是合理的 —— 反倒是 charComment 那条规矩
       * （角色互动一律不发短信）套在真人身上没道理。
       *
       * 代价：replyChance 那道概率闸对外人也生效（runIgTask 里 userComment
       * 分支掷的那次）。这是对的 —— 角色不该雷打不动地回每一条。
       */
      kind: fromUser || fromOutsider ? "userComment" : "charComment",
      postOwner: String(owner ?? ""),
      postId: isStory ? "" : item.id,
      storyId: isStory ? item.id : "",
      commentId: comment.id,
      chain: Number(opts.chain) || 0,
    }),
  ];
}

/* ================= 私聊那一轮的路由 ================= */

/**
 * 角色在**私聊**里回的这段话，该不该走 IG 链路。
 *
 * `[image:]` 是个两边都认的标签：私聊里它是「给用户发张图」（media.js），
 * IG 里它是配图。所以判据分两段：
 *
 *   - 写了 post / story / comment → 明确是 IG 的事，走。
 *   - **只有** `[image:]`：角色开着生图就还是私聊发图（老功能，一个字不动）；
 *     没开生图的话那张图在私聊里本来就会被丢掉（imessage.js:sendImagePart
 *     直接 return false），这时候按用户定的默认当成「一条没有文字的快拍」
 *     发到 IG 上 —— 从「丢掉」变成「发出去」，不抢任何已有行为。
 */
export function igRouteFor(role, text) {
  if (!igOn(role)) return false;
  if (hasIgPublishTag(text)) return true;
  return hasImageTag(text) && !role?.imageGen?.enabled;
}

/* ================= 出图 ================= */

/**
 * 按描述出一张图，存进 data/instagram/media/，返回文件名。
 *
 * 出不来就返回空串 —— 调用方会把 `{file:"", alt}` 原样存下去，前端遇到
 * 没有 file 的图会画成一张「文字图」（把描述写在框里）。用户明确要的降级：
 * 没配生图模型的人也该能看见帖子长什么样，而不是一片空白。
 */
async function renderImage(config, alt) {
  const desc = String(alt ?? "").trim();
  if (!desc) return "";
  const endpoint = resolveImageEndpoint(config);
  if (!endpoint) {
    logInfo(SCOPE, `没有可用的生图模型，这张图按文字图处理：${desc}`);
    return "";
  }
  try {
    const img = await generateImage(endpoint, { prompt: desc }, SCOPE);
    return saveMedia(img.buffer.toString("base64"), (img.ext ?? "png").replace(/^\./, ""));
  } catch (e) {
    logWarn(SCOPE, `这张图没出来，按文字图处理：${desc}`, e);
    return "";
  }
}

/**
 * 识一次图，结果写回内容本身（`visionNote`）。
 *
 * 缓存的理由在 igstore.js 的注释里：五个角色要评论同一张图，识一次够了。
 * 角色没开识图就直接返回空串 —— 和 imessage.js:describeImages 一样的降级：
 * 模型看不见图，但配文和 alt 还在，照样能说句话。
 *
 * 一条帖子可能有好几张图（轮播），只识第一张有文件的。轮播里后面几张多半是
 * 同一场景的补充，为它们各花一次钱不划算。
 */
async function ensureVisionNote(config, role, owner, item, isStory) {
  if (item?.visionNote) return item.visionNote;

  const file = isStory ? item?.image?.file : (item?.images ?? []).find((im) => im.file)?.file;
  if (!file) return "";

  const eps = resolveRoleEndpoints(config, role);
  if (!eps.vision) return "";

  const p = mediaPathFor(file);
  if (!p || !fs.existsSync(p)) return "";

  try {
    const base64 = fs.readFileSync(p).toString("base64");
    const note = String(
      await describeImage(eps.vision, eps.visionPrompt, {
        base64,
        mimeType: mimeForExt(path.extname(p)),
        name: file,
      })
    ).trim();
    if (!note) return "";
    if (isStory) updateStory(owner, item.id, { visionNote: note });
    else updatePost(owner, item.id, { visionNote: note });
    logInfo(SCOPE, `识了一次图（${owner} 的${isStory ? "快拍" : "帖子"}），结果存下来给后面的角色共用`);
    return note;
  } catch (e) {
    logWarn(SCOPE, "识图失败，这一轮按图片描述说话", e);
    return "";
  }
}

/* ================= 发布 ================= */

/**
 * 本地存好之后，看要不要往**真** Instagram 上也发一份。
 *
 * ── 为什么是动态 import ──
 *
 * igreal.js 要 import igrun.js（拉回来的帖子和评论得走 schedulePublish /
 * scheduleComment 触发角色），静态互相 import 就是循环依赖。动态 import 的
 * 代价只有第一次那点解析时间，而这条路径本来就要等网络。
 *
 * ── 为什么吞掉所有异常 ──
 *
 * 本地那条已经落盘了、上下文那几行也要照写。真 IG 发不出去是**预期内**的
 * 常态（没绑号、没配图床、代理断了、Meta 限流），把它变成异常会让整个私聊
 * 那一轮挂掉 —— 用户丢的是一条消息，换来的只是一条本来就在日志里的错误。
 * 失败的原因已经写进了 `remote.error`，界面上看得见，下一轮轮询也会补发。
 */
async function syncToReal(config, owner, item, isStory) {
  try {
    const { syncOut } = await import("./igreal.js");
    await syncOut(config, owner, item, { isStory });
  } catch (e) {
    logWarn(SCOPE, `${owner} 这条没能同步到真 Instagram（本地已经存好了）`, e);
  }
}

/**
 * 把 `splitIg` 的产物真的发出去。
 *
 * 私聊那一轮（角色自己写了 `[post:…]`）和主动发帖那一轮共用这里。
 * 发完顺手给刷得到的人排队 —— 角色发的帖子也该有人来评论。
 *
 * 绑了真号、开了 `syncReal` 的角色还会多走一步真发布（`syncToReal`）——
 * 那一步失败**不影响**这里的返回值：本地永远是主本。
 *
 * @returns {Promise<{posts:object[], stories:object[]}>} 真的落盘了的那些
 */
export async function publishIgTags(config, role, parsed, opts = {}) {
  const owner = String(role?.name ?? "");
  const out = { posts: [], stories: [] };
  if (!owner) return out;

  const make = async (draft, isStory) => {
    const images = [];
    for (const im of draft.images ?? []) {
      images.push({ file: await renderImage(config, im.alt), alt: String(im.alt ?? "") });
    }
    // 一条什么都没有的（配文空、图也没描述）不落盘，那是模型空转
    if (!String(draft.caption ?? "").trim() && !images.length) return null;

    if (isStory) {
      const story = addStory(owner, { caption: draft.caption, image: images[0] ?? { file: "", alt: "" } });
      schedulePublish(config, owner, story, { isStory: true, now: opts.now, roll: opts.roll });
      await syncToReal(config, owner, story, true);
      out.stories.push(story);
      return story;
    }
    const post = addPost(owner, { caption: draft.caption, images });
    schedulePublish(config, owner, post, { isStory: false, now: opts.now, roll: opts.roll });
    await syncToReal(config, owner, post, false);
    out.posts.push(post);
    return post;
  };

  for (const draft of parsed?.posts ?? []) await make(draft, false);
  for (const draft of parsed?.stories ?? []) await make(draft, true);

  if (parsed?.comments?.length) {
    // 私聊那一轮不该冒出评论 —— 预设里没教过 [comment:]（用户定的：只在
    // 被叫起来评论的那一刻才交代格式）。冒出来就是模型自己脑补的，丢掉
    logInfo(SCOPE, `${owner} 在私聊里写了 ${parsed.comments.length} 条评论标签，没有对应的帖子，丢掉`);
  }
  return out;
}

/**
 * 发布完之后，写进上下文的那几行。
 *
 * 帖子已经落到 data/instagram/ 了，历史里再留一份 `[post:…]` 原文只会让模型
 * 下一轮跟着复读格式（igtags.js:stripIgTags 的注释是同一个道理）。所以换成
 * 一句人话的陈述，模型知道「我发过这个」就够了。
 */
export function publishLines(published) {
  const lines = [];
  const one = (item, noun) => {
    const alt = item.images?.[0]?.alt || item.image?.alt || "";
    const body = [item.caption, alt ? `（配图：${alt}）` : ""].filter(Boolean).join(" ");
    lines.push(`[Instagram ${noun}] ${body || "（没配文字）"}`);
  };
  for (const p of published?.posts ?? []) one(p, "帖子");
  for (const s of published?.stories ?? []) one(s, "快拍");
  return lines;
}

/**
 * 主动消息那一轮缀在提示词末尾的那段「你也可以顺手发条 Instagram」。
 *
 * **两道闸都要开**：`instagram.enabled` 只代表「这个角色注册了 IG」（会点赞、
 * 会回评论），`autoPublish` 才是「它自己会想发点什么」—— config.js:736 那条
 * 注释定的分工。只开第一道的角色永远不会主动发帖。
 *
 * 为什么挂在主动消息上、而不是自己起一路定时器：角色想发条动态和角色想找人
 * 说话，本来就是同一件事的两种出口 —— 都是「这会儿它有话想说」。共用那套
 * 等待窗口、勿扰时段和冷却，用户调一处就够了，也不会出现「勿扰时间里不发
 * 短信、但照样在发帖」这种说不通的事。所以 autoPublish 实际上还隐含一个
 * 前提：`proactive.enabled` 也得开着，不然这一轮压根不会被叫起来。
 *
 * 发不发、发帖还是发快拍，全交给模型自己决定 —— 模板写的是「你现在想发点
 * 东西」而不是「你必须发」。这一轮它只写短信、一个方括号都不带也是合法输出，
 * igRouteFor 那边当作没发生过。
 *
 * @returns {string} 空串 = 这个角色这一轮没有「发帖」这个选项
 */
export function igComposeNote(config, role, opts = {}) {
  if (!igOn(role) || !role?.instagram?.autoPublish) return "";
  const templates = opts.templates ?? readSettings().promptTemplates;
  const raw = String(templates?.compose ?? "").trim() || defaultTemplate("compose");
  const user = opts.user ?? resolveUser(config, role);
  return applyVars(raw, {
    char: role?.name ?? "",
    user: user?.name ?? "",
    sep: config?.chat?.separator ?? "",
  }).trim();
}

/* ================= 跑一条任务 ================= */

/** 没做事的那种结果。 */
function nothing(task, role, reason) {
  return {
    ok: true,
    taskId: String(task?.id ?? ""),
    roleId: String(role?.id ?? task?.roleId ?? ""),
    roleName: String(role?.name ?? ""),
    kind: String(task?.kind ?? ""),
    action: "none",
    reason,
    comment: "",
    dm: "",
    mark: "",
    commentLine: "",
  };
}

/** 上下文里代替「对方发了条消息」的那一句。 */
function markFor(kind, vars, peerName, quote) {
  const who = kind.startsWith("user") ? String(vars?.user ?? "") || "用户" : peerName || "对方";
  const said = quote ? `：${quote.length > 60 ? `${quote.slice(0, 60)}…` : quote}` : "";
  switch (kind) {
    case "userPost":
    case "charPost":
      return `[Instagram] ${who} 发了一条新帖子，你刷到了`;
    case "userStory":
      return `[Instagram] ${who} 发了一条快拍，你点开看了`;
    case "userComment":
    case "charComment":
      return `[Instagram] ${who} 在 Instagram 上跟你说${said || "了句话"}`;
    default:
      return `[Instagram] ${who} 那边有了新动静`;
  }
}

/** 给 `owner` 的东西点个赞（帖子和快拍共用）。 */
function like(owner, item, isStory, actor) {
  const likes = [...(item.likes ?? []), actor];
  if (isStory) updateStory(owner, item.id, { likes });
  else updatePost(owner, item.id, { likes });
}

/**
 * 这条刚落盘的评论，要不要也发到真 Instagram 上。
 *
 * 分三种走法，难度天差地别：
 *
 *   自己帖子下回一条真评论   `POST /{comment-id}/replies` —— 最稳，权限天然具备
 *   别人（角色）的帖子       要帖主先铺一条 @ 当通行证，见 igreal.js:peerComment
 *                            2026-09-13 实测通了，失败就只留本地
 *   用户的帖子              只有**你在配文里 @ 了这个角色**才发，见下
 *
 * ── 用户的帖子那一条 ──
 *
 * 我们没有用户帖子的写权限（那是他的号），所以默认只留本地。唯一的例外是
 * Meta 留的那个后门：**被 @ 的人可以进来说话**。你在自己帖子的配文里写一句
 * `@角色的用户名`，那个角色就能用自己的 token 打 `/mentions` 进来评论 ——
 * 作者显示的是**角色自己**，不是你代发。判断和发送都在
 * igreal.js:commentOnUserPost 里，配文里没 @ 的话它自己就返回了，不打网络。
 *
 * 没 @ 的帖子行为一个字没变：角色照常刷到、照常在本地评论，真 IG 上没有。
 *
 * 快拍一律不发：真 IG 的快拍回复走私信通道，不是评论；而且快拍的 @ 提及
 * Mentions API 明确不支持。
 *
 * 和 `syncToReal` 一样吞掉所有异常 —— 本地那条已经存好了。
 */
async function commentToReal(config, owner, actor, item, comment, target, isStory) {
  if (isStory) return;
  try {
    const { commentOnUserPost, peerComment, replyOut } = await import("./igreal.js");
    if (owner === USER_OWNER) {
      // 靠配文里那句 @ 进门。没 @ 的话这个函数不打网络就返回了
      await commentOnUserPost(config, actor, item, comment.text);
      return;
    }
    // 回的是一条从真 IG 拉回来的评论 → 用 replies 接口，权限天然具备
    const parentRemote = target?.remote?.mediaId ?? "";
    if (parentRemote && owner === actor) {
      await replyOut(config, actor, parentRemote, comment.text);
      return;
    }
    // 在**别的角色**的帖子下说话 → 得走铺路 @ 那条路
    if (owner !== actor) await peerComment(config, owner, actor, item, comment.text);
  } catch (e) {
    logWarn(SCOPE, `${actor} 这条评论没能同步到真 Instagram（本地已经存好了）`, e);
  }
}

/**
 * 跑一条到点的任务。
 *
 * **不负责发短信、也不负责写上下文** —— 那两样都要 runner，由 `opts.session`
 * 提供的 `commit` 回调去做。这里只做三件事：掷骰子、打模型、把 IG 上的痕迹
 * （赞 / 评论 / 动态记录）落盘。
 *
 * @param {object} config 完整配置
 * @param {object} task igstore.js:readQueue 里的一条
 * @param {object} [opts] {now?, roll?, session?} session(role) → {history, commit}
 * @returns {Promise<object>} 见 `nothing` 的字段表
 */
export async function runIgTask(config, task, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const roll = opts.roll ?? Math.random;
  const settings = readSettings();
  const hours = settings.storyHours ?? DEFAULT_STORY_HOURS;

  const role = roleById(config, task?.roleId);
  if (!igOn(role)) return nothing(task, role, "这个角色没了，或者 Instagram 已经关掉");

  const owner = String(task.postOwner ?? "");
  const isStory = Boolean(task.storyId);
  const item = isStory
    ? readStories(owner).find((s) => s.id === task.storyId)
    : readPosts(owner).find((p) => p.id === task.postId);
  if (!item) return nothing(task, role, "那条内容已经被删了");
  if (isStory && storyExpired(item, hours, now)) return nothing(task, role, "快拍已经过期了");

  const ig = role.instagram;
  const self = String(role.name ?? "");
  const isReply = task.kind === "userComment" || task.kind === "charComment";
  const list = (isStory ? item.replies : item.comments) ?? [];

  /** 要回的那条评论（只有 reply 类任务有）。 */
  let target = null;

  if (isReply) {
    target = list.find((c) => c.id === task.commentId);
    if (!target) return nothing(task, role, "那条评论已经被删了");
    if (task.kind === "userComment" && !hit(ig.replyChance ?? 60, roll)) {
      return nothing(task, role, "按概率这次不回");
    }
    if (task.kind === "charComment" && !isStory) {
      // 排队那会儿算过一次，但中间可能又来了几条 —— 到点再算一次才准
      const max = (roleFor(config, owner) ?? role)?.instagram?.maxChain;
      if (!canChain(item, rootOf(list, target.id), max)) {
        return nothing(task, role, "这条线程已经聊够了");
      }
    }
  } else if (
    !(item.likes ?? []).includes(self) &&
    // 配文里点了名就不掷这一掷 —— 你 @ 它是要它说话，不是要它点赞
    !mentionsRole(item, role) &&
    hit(ig.likeChance ?? 45, roll)
  ) {
    // 刷到新东西先掷点赞。中了就到此为止，不打模型
    like(owner, item, isStory, self);
    if (owner === USER_OWNER) {
      addActivity({
        kind: isStory ? "storyLike" : "like",
        actor: self,
        target: { owner, postId: task.postId, storyId: task.storyId },
        at: new Date(now).toISOString(),
      });
    }
    return { ...nothing(task, role, ""), action: "like" };
  }

  // ── 到这儿才轮到模型 ──

  await ensureVisionNote(config, role, owner, item, isStory);
  const fresh = isStory
    ? readStories(owner).find((s) => s.id === item.id) ?? item
    : readPosts(owner).find((p) => p.id === item.id) ?? item;

  const session = opts.session ? await opts.session(role) : null;
  if (!session) {
    logWarn(SCOPE, `${self} 现在没有可用的会话，这一轮照跑，但上文是空的、短信发不出去`);
  }

  const peerName =
    task.kind === "charComment" ? String(target?.owner ?? "") : task.kind === "charPost" ? owner : "";

  const built = await buildIgPrompt(
    config,
    role,
    {
      kind: task.kind,
      owner,
      post: isStory ? null : fresh,
      story: isStory ? fresh : null,
      commentId: task.commentId || "",
      peerName,
      // 配文里点名了就在快照里说一句，免得模型当成一条普通帖子随口评
      mentioned: mentionsRole(fresh, role),
    },
    { history: session?.history ?? [], now, templates: settings.promptTemplates }
  );

  const eps = resolveRoleEndpoints(config, role);
  const { content } = await chatWithFallback(eps.chat, eps.fallback, built.messages, built.params);

  const parsed = splitIg(content, config?.chat?.separator ?? "");
  if (parsed.comments.length > 1) {
    logInfo(SCOPE, `${self} 这一轮写了 ${parsed.comments.length} 条评论，只发第一条`);
  }
  if (parsed.posts.length || parsed.stories.length) {
    // 评论轮里冒出帖子是模型跑偏（三条模板里每条都写了「这一轮不发帖」）
    logInfo(SCOPE, `${self} 在评论轮里想发帖 / 发快拍，不照做`);
  }

  const text = String(parsed.comments[0] ?? "").trim();
  const isPeer = task.kind === "charPost" || task.kind === "charComment";
  let dm = isPeer ? "" : String(parsed.rest ?? "").trim();
  if (isPeer && parsed.rest?.trim()) {
    // 角色之间的互动按用户定的规矩**不触发 iMessage 回复**
    logInfo(SCOPE, `${self} 冲着 ${peerName} 那轮还写了段私聊，按规矩不发`);
  }
  if (dm && !session) {
    logWarn(SCOPE, `${self} 这一轮想给用户发条短信，但没有可用的会话，只好丢掉`);
    dm = "";
  }

  if (!text && !dm) return nothing(task, role, "模型这一轮什么都没说");

  // ── 评论落盘 ──
  let saved = null;
  if (text) {
    const entry = { owner: self, text, replyTo: isReply ? String(task.commentId) : "" };
    const next = [...list, entry];
    const after = isStory
      ? updateStory(owner, item.id, { replies: next })
      : updatePost(owner, item.id, { comments: next });
    saved = ((isStory ? after?.replies : after?.comments) ?? []).at(-1) ?? null;

    if (owner === USER_OWNER || (isReply && target?.owner === USER_OWNER)) {
      addActivity({
        kind: isStory ? "storyReply" : isReply ? "reply" : "comment",
        actor: self,
        target: {
          owner,
          postId: task.postId,
          storyId: task.storyId,
          commentId: saved?.id ?? "",
        },
        text,
        at: new Date(now).toISOString(),
      });
    }

    // 角色之间的来回：这条评论也可能把对面叫起来
    if (saved) {
      scheduleComment(config, owner, after ?? fresh, saved, {
        isStory,
        now,
        roll,
        chain: (Number(task.chain) || 0) + 1,
      });
      await commentToReal(config, owner, self, after ?? fresh, saved, target, isStory);
    }
  }

  const outcome = {
    ok: true,
    taskId: String(task.id ?? ""),
    roleId: String(role.id ?? ""),
    roleName: self,
    kind: String(task.kind ?? ""),
    action: text ? "comment" : "dm",
    reason: "",
    comment: text,
    commentId: saved?.id ?? "",
    dm,
    mark: markFor(task.kind, built.vars, peerName, isReply ? target?.text ?? "" : ""),
    commentLine: text ? `[Instagram 评论] ${text}` : "",
    // 角色间的互动要不要让模型知道。关了就只在 IG 上留个痕，不进上下文、
    // 也不进待总结 —— 用户那边一个字都看不见，本来也不该替他攒记忆
    record: !isPeer || ig.recordPeer !== false,
  };

  // 写上下文 + 发短信。出岔子不该把已经发出去的评论回滚掉（IG 上那条是真的
  // 已经发了），所以吞掉异常、只记一条日志
  if (outcome.record && session?.commit) {
    try {
      await session.commit(outcome);
    } catch (e) {
      logError(SCOPE, `${self} 这一轮的上下文 / 短信没落下去（IG 上的评论已经发了）`, e);
    }
  }
  return outcome;
}

/* ================= 定时器 ================= */

/** 多久看一眼队列。和记忆库那个日记定时器同一个节奏。 */
const TICK_MS = 60000;

/**
 * 扫一遍到点的任务。
 *
 * **先出队再执行**：跑挂了就当这一条没了，不会下一轮又来一次 —— 重试一条
 * 会打模型的任务，代价是用户白花钱、IG 上还可能冒出两条一样的评论。
 *
 * `opts.all` 是 `/立即触发评论` 那条指令用的：不管 `at` 排在多久以后，
 * 队列里排着的**全部**立刻跑掉。不写成「传一个未来的 now」——
 * 同一个 now 还喂给了下面的 pruneVisionNotes，那样会把识图缓存整个清空，
 * 下次刷到同一张图又要花一次钱重新识。
 */
export async function tickIgQueue(config, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const settings = readSettings();

  try {
    pruneVisionNotes(
      igOwners(config).map((o) => o.owner),
      settings.storyHours,
      now
    );
  } catch (e) {
    logWarn(SCOPE, "清识图缓存时出错（不影响别的）", e);
  }

  const tasks = opts.all ? readQueue().sort((a, b) => a.at - b.at) : dueTasks(now);
  if (tasks.length) {
    // 队列里的任务是**延后**执行的（角色刷到一条内容，掷骰子决定几分钟后
    // 再点赞/评论），所以「到点了、开始跑」这件事以前只能从结果反推
    logDebug(SCOPE, `${tasks.length} 条互动任务到点：${tasks.map((t) => t.kind).join("、")}`);
  }
  const out = [];
  for (const task of tasks) {
    dropQueue(task.id);
    const t0 = Date.now();
    try {
      out.push(await runIgTask(config, task, opts));
      logDebug(SCOPE, `互动任务 ${task.kind} 跑完，用了 ${Date.now() - t0}ms`);
    } catch (e) {
      logError(
        SCOPE,
        `一条互动任务跑挂了（${task.kind}，已经出队，不重试）：${String(e?.message ?? e)}`,
        e
      );
    }
  }
  return out;
}

/**
 * 起定时器。形状照抄 memoryhooks.js:startDiaryTimer —— unref 掉，让它不要
 * 拖着进程不退出；返回一个停止函数给热重启用。
 *
 * @param {() => object} getConfig 每次 tick 现读一份配置（用户随时在改）
 * @param {object} [opts] {session?} 见 runIgTask
 */
export function startIgQueue(getConfig, opts = {}) {
  const tick = async () => {
    const config = getConfig?.();
    if (!config) return;
    // 一个开着 IG 的角色都没有就别读队列了
    if (!(config.roles ?? []).some(igOn)) return;
    await tickIgQueue(config, opts);
  };

  const timer = setInterval(() => {
    void tick().catch((e) => logError(SCOPE, "互动队列这一轮出错", e));
  }, TICK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
