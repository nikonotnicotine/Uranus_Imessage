/**
 * 小红书真正**跑起来**的地方：发笔记、定时看新评论、回评论。
 *
 * 干活的是用户自己跑的 xiaohongshu-mcp（xhsapi.js），这里只管「什么时候、
 * 以谁的身份、发什么」。和 IG 最大的不同：IG 的帖子落在我们自己的
 * data/instagram/ 里，小红书的笔记**直接发到真的小红书上**，我们只留一份流水。
 *
 * ── 发笔记为什么在后台发 ──
 *
 * 一篇带图的笔记要先生图、再让 MCP 开浏览器一张张上传，两三分钟很正常。
 * 私聊那一轮要是干等着，对方就得多等三分钟才收到那句话。所以标签一认出来
 * 就先把「我发了这篇」那几句人话交回去写上下文，发布本身丢到后台慢慢跑，
 * 成没成写日志和流水（data/xiaohongshu/state.json）。
 *
 * 代价是：发失败了上下文里也留着「发了」。这和 IG 的 syncToReal 是同一个
 * 取舍 —— 角色的确「想发、写了」这篇，发没发出去是网络和风控的事。
 *
 * ── 回评论：水位线 + 最新 N 条 ──
 *
 * 每个角色记一个时间水位。每轮只看水位之后的新评论，按时间从新到旧取前 N 条，
 * 一次模型调用批量回，然后把水位推到这批里最新的那条。**超出 N 的老评论
 * 直接跳过、不留到下一轮** —— 帖子爆了一晚上来几百条，也只回最新的 N 条，
 * 不会越积越多、也不会第二天还在回昨天的评论。
 *
 * 第一次轮询只立水位、一条不回：刚开这个功能的人，账号底下可能躺着几年的
 * 老评论，一股脑回过去很吓人。
 *
 * 水位**在打模型之前**就推进 —— 和 igrun.js「先出队再执行」一个道理：
 * 这一轮跑挂了就当这批没了，不会下一轮又回一遍（重复回复在小红书上很难看，
 * 也更容易被判成机器号）。
 *
 * ── 这个文件的边界 ──
 *
 * 和 igrun.js 一样只 import 叶子模块，上文怎么拿、这一轮怎么写进上下文，由
 * 调用方通过 `opts.session` 提供（真正的实现是 imessage.js:igSessionFor，
 * 两边共用那套 commit）。
 */

import { applyVars, resolveImageEndpoint, resolveRoleEndpoints, resolveUser } from "./config.js";
import { buildIgPrompt } from "./igprompt.js";
import { readSettings } from "./igstore.js";
import { chatWithFallback } from "./llm.js";
import { logError, logInfo, logWarn } from "./logs.js";
import { generateImage } from "./media.js";
import { XhsError, listMentions, loginStatus, publishNote, replyComment } from "./xhsapi.js";
import { recordNote, roleState, stageImage, unstage, updateRoleState } from "./xhsstore.js";
import { hasXhsTag, parseReplies } from "./xhstags.js";

const SCOPE = "小红书";

/* ================= 小工具 ================= */

export function xhsOn(role) {
  return Boolean(role?.xiaohongshu?.enabled);
}

/** 私聊 / 主动消息这一轮的输出要不要走小红书那条路。 */
export function xhsRouteFor(role, text) {
  return xhsOn(role) && hasXhsTag(text);
}

function baseOf(role) {
  return String(role?.xiaohongshu?.baseUrl || "http://localhost:18060").replace(/\/+$/, "");
}

function clip(text, n) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function errText(e) {
  return e instanceof XhsError ? e.message : String(e?.message ?? e);
}

/* ================= 发笔记 ================= */

/** 出一张图、落到 ASCII 路径下。出不来返回空串。 */
async function renderImage(config, alt) {
  const desc = String(alt ?? "").trim();
  if (!desc) return "";
  const endpoint = resolveImageEndpoint(config);
  if (!endpoint) return "";
  try {
    const img = await generateImage(endpoint, { prompt: desc }, SCOPE);
    return stageImage(img.buffer, img.ext ?? "png");
  } catch (e) {
    logWarn(SCOPE, `这张配图没出来：${desc}`, e);
    return "";
  }
}

/**
 * 真的发一篇。出错抛出去，由调用方记日志。
 *
 * 小红书的笔记**必须有图**（MCP 那边 images 是 required、min=1）。模型一张都没
 * 写的话按标题 + 正文自动配一张；生图模型也没配的话就发不了，直接报错说清楚。
 */
export async function publishOne(config, role, note) {
  const base = baseOf(role);
  const alts = note.images?.length
    ? note.images.map((im) => im.alt)
    : [`小红书笔记配图：${note.title}。${clip(note.body, 120)}`];

  if (!resolveImageEndpoint(config)) {
    throw new XhsError("小红书的笔记必须带图，但还没配生图模型（设置 → 生图），这篇发不了");
  }

  const files = [];
  try {
    for (const alt of alts) {
      const f = await renderImage(config, alt);
      if (f) files.push(f);
    }
    if (!files.length) throw new XhsError("配图一张都没生成出来，这篇发不了（小红书的笔记必须带图）");

    await publishNote(base, {
      title: note.title || clip(note.body, 10) || "分享",
      content: note.body || note.title,
      images: files,
      tags: note.topics,
    });
    return { images: files.length };
  } finally {
    unstage(files);
  }
}

/**
 * 私聊 / 主动消息那一轮认出来的笔记：**立刻**返回写上下文用的那几句人话，
 * 发布本身在后台跑（理由见文件顶上）。
 *
 * @param {object[]} notes splitXhs 的产物
 * @returns {string[]} 写进上下文的行
 */
export function publishXhsNotes(config, role, notes) {
  const list = (notes ?? []).filter((n) => n && (n.title || n.body));
  if (!list.length) return [];
  const who = String(role?.name ?? "");

  void (async () => {
    for (const note of list) {
      try {
        const r = await publishOne(config, role, note);
        recordNote(role.id, { title: note.title, body: note.body, topics: note.topics, images: r.images, ok: true });
        logInfo(SCOPE, `${who} 发了一篇笔记「${note.title}」（${r.images} 张图）`);
      } catch (e) {
        recordNote(role.id, { title: note.title, body: note.body, topics: note.topics, ok: false, error: errText(e) });
        logError(SCOPE, `${who} 的笔记「${note.title}」没发出去`, e);
      }
    }
  })();

  return xhsPublishLines(list);
}

/** 上下文里那几句「我发了什么」。和 igrun.js:publishLines 同一个理由：不留标签原文。 */
export function xhsPublishLines(notes) {
  return (notes ?? []).map((n) => {
    const alt = n.images?.[0]?.alt ? `（配图：${n.images[0].alt}）` : "";
    const topics = n.topics?.length ? ` ${n.topics.map((t) => `#${t}`).join(" ")}` : "";
    return `[小红书 笔记] ${n.title}｜${n.body}${topics}${alt}`;
  });
}

/**
 * 主动消息那一轮缀在提示词末尾的「你也可以顺手发篇小红书」。
 * 和 igComposeNote 同样两道闸：enabled + autoPublish（后者依赖 proactive.enabled）。
 */
export function xhsComposeNote(config, role, opts = {}) {
  if (!xhsOn(role) || !role?.xiaohongshu?.autoPublish) return "";
  const user = opts.user ?? resolveUser(config, role);
  return applyVars(COMPOSE, {
    char: role?.name ?? "",
    user: user?.name ?? "",
    sep: config?.chat?.separator ?? "",
  }).trim();
}

const COMPOSE = [
  "你也可以发一篇小红书笔记（发出去的是真的小红书，所有人都看得到）。",
  "",
  "  - 写法：[小红书:标题|正文]，紧接着写 [image:这张图里有什么]，想放几张就写几个。",
  "  - 标题 20 字以内；正文里的 #话题 会变成能点的话题标签。",
  "",
  "几条硬规矩：",
  "  - 方括号**里面**不能出现 {{sep}}，要断句就用标点。",
  "  - 一次最多发一篇，按 {{char}} 平时分享日常的样子写，别写成营销文案。",
  "  - 不想发就不写，这不是必须的。",
].join("\n");

/* ================= 回评论 ================= */

const REPLY_BLOCK = [
  "你（{{char}}）在小红书上发过笔记。下面是笔记底下新来的评论，按时间从新到旧排，每条前面是编号：",
].join("\n");

const REPLY_ACTION = [
  "现在逐条决定要不要回。",
  "",
  "  - 要回的写 [回复:编号:回复内容]，一条评论最多回一次。",
  "  - 不想回的直接跳过，不用每条都回；全都不想回就什么都不写。",
  "  - 回复按 {{char}} 平时在小红书上回评论的样子写：短、口语，可以带 emoji。",
  "  - 这是公开的评论区，不是和 {{user}} 的私聊。",
  "  - 方括号里面不能出现 {{sep}} 和方括号。这一轮只写回复标记，标记之外的文字都会被丢掉。",
].join("\n");

/** 每个地址当前登录号的 user_id，用来滤掉自己的评论。进程内缓存。 */
const selfIds = new Map();

async function selfIdFor(base) {
  if (selfIds.has(base)) return selfIds.get(base);
  try {
    const st = await loginStatus(base);
    if (!st.isLoggedIn) throw new XhsError("xiaohongshu-mcp 那边还没登录小红书（先在它那边扫码登录）");
    selfIds.set(base, st.userId);
    return st.userId;
  } catch (e) {
    if (e instanceof XhsError && /没登录/.test(e.message)) throw e;
    // 查不到就先不滤，别因为这一步把整轮卡住
    logWarn(SCOPE, "查不到当前登录的是哪个号，这一轮不滤自己的评论", e);
    return "";
  }
}

/**
 * 从通知里挑这一轮要回的评论。纯函数，方便离线测。
 *
 * @returns {{picked:object[], dropped:number, watermark:number, first:boolean}}
 */
export function pickComments(items, state, { topN = 5, selfId = "", now = Date.now() } = {}) {
  const comments = (items ?? []).filter(
    (it) =>
      String(it.type).startsWith("comment/") &&
      it.commentId &&
      String(it.text ?? "").trim() &&
      !(selfId && it.fromId === selfId)
  );
  const newest = Math.max(0, ...(items ?? []).map((it) => Number(it.time) || 0));

  // 第一次：只立水位。通知一条都没有就拿现在当水位
  if (!state.watermark) {
    return { picked: [], dropped: 0, watermark: newest || now, first: true };
  }

  const seen = new Set(state.seen ?? []);
  const fresh = comments
    .filter((c) => c.time > state.watermark && !seen.has(c.commentId))
    .sort((a, b) => b.time - a.time);
  const picked = fresh.slice(0, topN);
  return {
    picked,
    dropped: fresh.length - picked.length,
    watermark: Math.max(state.watermark, newest),
    first: false,
  };
}

function commentLabel(c) {
  const where = c.feedTitle ? `在笔记「${clip(c.feedTitle, 20)}」下` : "在你的笔记下";
  const how = c.type === "comment/comment" ? "回复了你的评论" : "评论";
  return `${c.fromName || "有人"} ${where}${how}：${clip(c.text, 200)}`;
}

/**
 * 给一个角色跑一轮「看新评论 → 回」。
 *
 * @param {object} opts {session?, now?, force?} session 见 igrun.js:runIgTask；
 *   force = 不管 replyEnabled 开没开都跑（手动触发用）
 * @returns {Promise<{ok:boolean, reason?:string, picked?:number, dropped?:number, replied?:object[]}>}
 */
export async function pollXhsReplies(config, role, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const who = String(role?.name ?? "");
  if (!xhsOn(role)) return { ok: false, reason: "这个角色没开小红书" };
  if (!role.xiaohongshu.replyEnabled && !opts.force) return { ok: false, reason: "没开回评论" };

  const cfg = role.xiaohongshu;
  const base = baseOf(role);
  const topN = cfg.topN ?? 5;

  let items;
  let selfId = "";
  try {
    selfId = await selfIdFor(base);
    // 多拿一点：通知里还混着 @ 和被过滤掉的，只拿 N 条可能凑不够
    items = await listMentions(base, Math.max(topN * 2, 20));
  } catch (e) {
    updateRoleState(role.id, (s) => ({ ...s, lastPollAt: now, lastError: errText(e) }));
    throw e;
  }

  const state = roleState(role.id);
  const pick = pickComments(items, state, { topN, selfId, now });

  // 水位先推，再干活（理由见文件顶上）
  updateRoleState(role.id, (s) => ({
    ...s,
    watermark: pick.watermark,
    lastPollAt: now,
    lastError: "",
    seen: [...s.seen, ...pick.picked.map((c) => c.commentId)],
  }));

  if (pick.first) {
    logInfo(SCOPE, `${who} 第一次看评论：只记下现在的位置，之前的老评论不回`);
    return { ok: true, reason: "第一次只立水位", picked: 0, dropped: 0, replied: [] };
  }
  if (pick.dropped > 0) {
    logInfo(SCOPE, `${who} 这一轮新评论太多，只回最新的 ${pick.picked.length} 条，跳过更早的 ${pick.dropped} 条`);
  }
  if (!pick.picked.length) return { ok: true, reason: "没有新评论", picked: 0, dropped: 0, replied: [] };

  const session = opts.session ? await opts.session(role) : null;
  const block = [
    REPLY_BLOCK,
    "",
    ...pick.picked.map((c, i) => `${i + 1}. ${commentLabel(c)}`),
  ].join("\n");

  const built = await buildIgPrompt(
    config,
    role,
    { kind: "xhsReply" },
    {
      history: session?.history ?? [],
      now,
      templates: readSettings().promptTemplates,
      tag: "小红书",
      block,
      action: REPLY_ACTION,
    }
  );

  const eps = resolveRoleEndpoints(config, role);
  const { content } = await chatWithFallback(eps.chat, eps.fallback, built.messages, built.params);
  const replies = parseReplies(content, config?.chat?.separator ?? "");

  // 一条一条回。MCP 那边本来就串行，这里再串一次是为了失败了不影响后面的
  const done = [];
  for (const r of replies) {
    const c = pick.picked[r.no - 1];
    if (!c) {
      logInfo(SCOPE, `${who} 回了编号 ${r.no}，但没有这条评论，丢掉`);
      continue;
    }
    try {
      await replyComment(base, c.commentId, r.text);
      done.push({ comment: c, text: r.text });
      logInfo(SCOPE, `${who} 回了 ${c.fromName}：${r.text}`);
    } catch (e) {
      logError(SCOPE, `${who} 回 ${c.fromName} 那条没回出去`, e);
    }
  }

  if (done.length) {
    updateRoleState(role.id, (s) => ({
      ...s,
      replies: [
        ...s.replies,
        ...done.map((d) => ({
          commentId: d.comment.commentId,
          from: d.comment.fromName,
          comment: d.comment.text,
          feedTitle: d.comment.feedTitle,
          reply: d.text,
          at: new Date(now).toISOString(),
        })),
      ],
    }));
  }

  // 写进上下文：模型下一轮私聊时知道自己在小红书上回过谁、说了什么
  if (session?.commit) {
    const mark = [
      `[小红书] 你的笔记下面来了 ${pick.picked.length} 条新评论：`,
      ...pick.picked.map((c) => `- ${c.fromName || "有人"}：${clip(c.text, 60)}`),
    ].join("\n");
    const commentLine = done.length
      ? done.map((d) => `[小红书 回复] 回 ${d.comment.fromName || "对方"}：${d.text}`).join("\n")
      : "[小红书] 你看了这些评论，没有回";
    try {
      await session.commit({
        ok: true,
        roleId: String(role.id ?? ""),
        roleName: who,
        kind: "xhsReply",
        action: done.length ? "comment" : "skip",
        mark,
        commentLine,
        dm: "",
        record: true,
      });
    } catch (e) {
      logError(SCOPE, `${who} 这一轮回评论没写进上下文（评论已经回了）`, e);
    }
  }

  return { ok: true, picked: pick.picked.length, dropped: pick.dropped, replied: done };
}

/* ================= 定时器 ================= */

const TICK_MS = 60000;

/**
 * 同一个地址（= 同一个小红书号）只让排在前面的那个角色回。两个角色填了
 * 同一个地址，一条评论就会被回两遍。
 */
export function pollTargets(config) {
  const seen = new Set();
  const out = [];
  for (const role of config?.roles ?? []) {
    if (!xhsOn(role) || !role.xiaohongshu.replyEnabled) continue;
    const base = baseOf(role);
    if (seen.has(base)) continue;
    seen.add(base);
    out.push(role);
  }
  return out;
}

/**
 * 起定时器：每分钟看一眼哪个角色到点了。到点 = 距上次轮询过了 pollMinutes，
 * 再加一点抖动（0–20%）—— 每次都卡整点去翻通知页，看着就像脚本。
 */
export function startXhsPolling(getConfig, opts = {}) {
  let running = false;
  const nextAt = new Map();

  const tick = async () => {
    if (running) return;
    const config = getConfig?.();
    if (!config) return;
    const targets = pollTargets(config);
    if (!targets.length) return;

    running = true;
    try {
      const now = Date.now();
      for (const role of targets) {
        const every = (role.xiaohongshu.pollMinutes ?? 30) * 60000;
        if (!nextAt.has(role.id)) {
          const last = roleState(role.id).lastPollAt;
          nextAt.set(role.id, last ? last + every : now);
        }
        if (now < nextAt.get(role.id)) continue;
        nextAt.set(role.id, now + every * (1 + Math.random() * 0.2));
        try {
          await pollXhsReplies(config, role, opts);
        } catch (e) {
          logWarn(SCOPE, `${role.name} 这一轮看评论失败`, e);
        }
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick().catch((e) => logError(SCOPE, "看评论这一轮出错", e));
  }, TICK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
