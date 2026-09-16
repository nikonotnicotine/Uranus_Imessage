/**
 * 「我发了条帖子 / 快拍 → 角色刷到了 → 来评论」这条链路，跑一遍看结果。
 *
 * ── 为什么要造一条帖子出来 ──
 *
 * 本地压根没有你的帖子（data/instagram/posts/ 下只有角色的文件）。你自己那些
 * 真 IG 内容要靠 igreal.js:syncUserIn 镜像进来，而那个默认是关的
 * （`settings.syncUser`，你定的），还得先绑大号。所以这里**替你造一条**占位的
 * 帖子和快拍 —— 从 addPost / addStory 那一步往后，和真的镜像进来的一模一样
 * （syncUserIn 也就是调这两个函数 + schedulePublish）。
 *
 * ── 不会碰到真 Instagram ──
 *
 * 造出来的帖子 `remote.mediaId` 是空的，而且 owner 是 `user`：
 *   · 发布那一侧：脚本直接调 addPost，不走 publishIgTags，没有 syncToReal 那一步
 *   · 评论那一侧：igrun.js:commentToReal 开头就是 `owner === USER_OWNER` 直接返回
 *     —— 我们没有你帖子的写权限（那是你的号），角色的评论只落在本地
 *
 * ── 只动时间，不动逻辑 ──
 *
 * 排队要等 30–120 分钟（igrun.js:delayFor），所以给 tickIgQueue 一个「未来的
 * 现在」让它立刻到点。掷骰子、打模型、落盘全走真代码。
 *
 * 骰子只焊死**一处**：`likeChance`。不焊的话 50% 概率角色只点个赞就收工
 * （igrun.js 里那条规矩：中了就只点赞、不打模型），这一趟就看不到评论了。
 * 第二段反过来焊成必中，因为那一段要过的是 `replyChance`。
 *
 * 跑法：node scripts/try-user-post.mjs
 *
 * 跑完东西**留在盘上**（你说过测好了不用删）：网页上「Instagram」那一页
 * 刷新就能看见你的帖子和角色的评论。
 */

import process from "node:process";

import { loadConfig, resolveUser } from "../server/src/config.js";
import { sceneBlock } from "../server/src/igprompt.js";
import {
  USER_OWNER,
  addPost,
  addStory,
  readActivity,
  readPosts,
  readQueue,
  readSettings,
  readStories,
  updatePost,
} from "../server/src/igstore.js";
import { scheduleComment, schedulePublish, tickIgQueue } from "../server/src/igrun.js";

const line = (s = "") => console.log(s);
const config = loadConfig();

const roles = (config.roles ?? []).filter((r) => r?.instagram?.enabled);
if (!roles.length) {
  console.error("没有开着 Instagram 的角色，测不了。");
  process.exit(1);
}
line(`开着 Instagram 的角色：${roles.map((r) => r.name).join("、")}`);

/* ================= 造内容 ================= */

/*
 * 不给图片文件、只给一句描述。
 *
 * 生图要花钱，而这一趟要看的是「角色说了什么」，不是图好不好看。没有 file
 * 的图片前端会画成一张「文字图」（把描述写在框里），提示词那边
 * igprompt.js:mediaText 会退回用 alt —— 模型照样知道图里有什么。
 */
const post = addPost(USER_OWNER, {
  caption: "终于把桌面收拾干净了",
  images: [{ file: "", alt: "书桌上摆着一台笔记本、一杯冰咖啡，窗外是傍晚的城市" }],
});
const story = addStory(USER_OWNER, {
  caption: "下班路上",
  image: { file: "", alt: "地铁车窗外掠过的霓虹灯，玻璃上有反光" },
});

line();
line(`替你造了一条帖子：${post.id}  ${JSON.stringify(post.caption)}`);
line(`替你造了一条快拍：${story.id}  ${JSON.stringify(story.caption)}`);

/* ================= 第一段：刷到 → 评论 ================= */

const queuedPost = schedulePublish(config, USER_OWNER, post, { isStory: false });
const queuedStory = schedulePublish(config, USER_OWNER, story, { isStory: true });
line();
line(`帖子排了 ${queuedPost.length} 条任务，快拍排了 ${queuedStory.length} 条`);
for (const t of [...queuedPost, ...queuedStory]) {
  const who = roles.find((r) => String(r.id) === t.roleId)?.name ?? t.roleId;
  line(`   ${t.kind}  ${who}  正常要等 ${Math.round((t.at - Date.now()) / 60000)} 分钟`);
}

/*
 * 往后挪到「最后那条任务的时刻再加一分钟」。
 *
 * **别挪一天** —— 快拍 24 小时就过期了（igstore.js:storyExpired），挪一天
 * 之后 runIgTask 开头那道 `storyExpired` 闸会把两条快拍任务全判成
 * 「快拍已经过期了」，那一段就白跑了（第一次写这个脚本就是这么踩的）。
 * 一分钟足够让排在最后的那条也算到点。
 */
const latest = () => Math.max(...[...queuedPost, ...queuedStory].map((t) => t.at));
const beforeActivity = readActivity().length;

line();
line("跑第一段（每个角色一次模型调用，等十几秒）：");
const round1 = await tickIgQueue(config, {
  now: latest() + 60_000,
  // 0.99：likeChance 那一掷必不中 → 不点赞、往下走到模型
  roll: () => 0.99,
});

line();
line("──── 第一段结果 ────");
for (const r of round1) {
  if (r.action === "none") {
    line(`${r.roleName}  ${r.kind}  没动作：${r.reason}`);
    continue;
  }
  line(`${r.roleName}  ${r.kind}  →  ${r.action}`);
  if (r.comment) line(`   评论：${r.comment}`);
  if (r.dm) line(`   想顺带发的短信（没会话，丢了）：${r.dm}`);
}

/* ================= 角色之间看得见对方吗 ================= */

/*
 * 两个问题，分开答：
 *
 *   「看得到对方的评论吗」  → 看得到。快照里是**整条评论列表**
 *                            （igprompt.js:commentText），别人说的都在里面。
 *   「能选回复谁吗」        → 不能。落盘时 replyTo 由代码定
 *                            （igrun.js:663，`isReply ? task.commentId : ""`），
 *                            模型只能写 [comment:…]，没有指定回复对象的语法。
 *
 * 下面把第二个角色**当时看到的那段快照**原样打出来 —— 眼见为实。
 */
const afterPost = readPosts(USER_OWNER).find((p) => p.id === post.id);
const second = roles[1] ?? roles[0];
const vars = {
  char: second.name ?? "",
  user: resolveUser(config, second)?.name ?? "",
  sep: config?.chat?.separator ?? "",
};
line();
line(`──── ${second.name} 被叫起来时看到的那段（<Instagram> 块） ────`);
line(
  sceneBlock(
    { kind: "userPost", owner: USER_OWNER, post: afterPost, commentId: "", peerName: "" },
    vars,
    String(second.name ?? ""),
    Date.now(),
    readSettings().promptTemplates
  )
);

/*
 * 队列里有没有「角色去回另一个角色」的任务 —— 应该一条都没有。
 *
 * scheduleComment 只给**被说话的那个人**排任务，而在你帖子下留言，被说话的人
 * 是你（`targetOwner === USER_OWNER` 那一行直接返回空）。所以角色在你帖子下
 * 各说各的，不会互相追着回。
 */
line();
const pending = readQueue();
line(`队列里现在 ${pending.length} 条任务：`);
for (const t of pending) {
  const who = roles.find((r) => String(r.id) === t.roleId)?.name ?? t.roleId;
  line(`   ${t.kind}  ${who}  postOwner=${t.postOwner}`);
}
if (!pending.some((t) => t.kind === "charComment")) {
  line("   （没有 charComment —— 角色不会因为「另一个角色在你帖子下留言」被叫起来）");
}

/* ================= 第二段：我回一句 → 角色回我 ================= */

/*
 * 挑第一段里留了评论的那个角色，回它一句。这一段走的是 userComment 那条链路：
 * 被说话的人是那个角色（不是你），所以排得进队列。
 */
const theirs = (afterPost?.comments ?? []).filter((c) => c.owner !== USER_OWNER);
if (!theirs.length) {
  line();
  line("第一段没有角色留下评论，第二段跳过。");
} else {
  const reply = theirs[0];
  const saved = updatePost(USER_OWNER, post.id, {
    comments: [
      ...(afterPost.comments ?? []),
      { owner: USER_OWNER, text: "哈哈这杯咖啡撑了我一整天", replyTo: reply.id },
    ],
  });
  const mine = (saved?.comments ?? []).at(-1);
  line();
  line(`你回了 ${reply.owner} 一句：${JSON.stringify(mine.text)}`);

  const q2 = scheduleComment(config, USER_OWNER, saved, mine, { isStory: false });
  if (!q2.length) {
    line("排不进队列 —— 不该出现，回的是角色的评论。");
  } else {
    line();
    line("跑第二段：");
    const round2 = await tickIgQueue(config, {
      now: q2[0].at + 60_000,
      // 0：replyChance 那一掷必中 → 一定回
      roll: () => 0,
    });
    line();
    line("──── 第二段结果 ────");
    for (const r of round2) {
      if (r.action === "none") {
        line(`${r.roleName}  ${r.kind}  没动作：${r.reason}`);
        continue;
      }
      line(`${r.roleName}  ${r.kind}  →  ${r.action}`);
      if (r.comment) line(`   评论：${r.comment}`);
      if (r.dm) line(`   想顺带发的短信（没会话，丢了）：${r.dm}`);
    }
  }
}

/* ================= 盘上留下了什么 ================= */

const finalPost = readPosts(USER_OWNER).find((p) => p.id === post.id);
const finalStory = readStories(USER_OWNER).find((s) => s.id === story.id);

line();
line(`──── 你那条帖子（${post.id}）现在 ────`);
line(`点赞：${(finalPost?.likes ?? []).join("、") || "（没有）"}`);
for (const c of finalPost?.comments ?? []) {
  const who = c.owner === USER_OWNER ? "你" : c.owner;
  const to = c.replyTo ? (finalPost.comments.find((x) => x.id === c.replyTo)?.owner ?? "?") : "";
  line(`   ${who}${to ? `（回 ${to === USER_OWNER ? "你" : to}）` : ""}：${c.text}`);
}

line();
line(`──── 你那条快拍（${story.id}）现在 ────`);
line(`点赞：${(finalStory?.likes ?? []).join("、") || "（没有）"}`);
for (const c of finalStory?.replies ?? []) {
  line(`   ${c.owner === USER_OWNER ? "你" : c.owner}：${c.text}`);
}

const activity = readActivity();
if (activity.length > beforeActivity) {
  line();
  line(`爱心页多了 ${activity.length - beforeActivity} 条：`);
  for (const a of activity.slice(0, activity.length - beforeActivity)) {
    line(`   ${a.kind}  ${a.actor}  ${JSON.stringify(a.text ?? "")}`);
  }
}

line();
line("这些都在盘上了，网页上「Instagram」那一页刷新就能看见。");
