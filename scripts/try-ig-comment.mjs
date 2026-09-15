/**
 * 手动把「有人在角色帖子下留言 → 角色回一句」这条链路推一遍。
 *
 * 留言的人默认是你（userComment），`--as 别的角色名` 换成角色互评
 * （charComment）—— 两条链路的闸门和输出形态都不一样，见下面 `--as` 那段。
 *
 * ── 为什么需要这个脚本 ──
 *
 * 这条链路本身是**慢的**：评论落盘之后 scheduleComment 会在 30–120 分钟里
 * 随机挑一个时刻（igrun.js:delayFor），到点了才由每 60 秒一次的定时器
 * （igrun.js:TICK_MS）捞起来跑。等着看没意义 —— 一个多小时之后才有反应，
 * 而且反应发生在后端进程里，看不见过程。
 *
 * 所以这里只动**时间**：`tickIgQueue` 收一个 `opts.now`，给它一个「未来的
 * 现在」，排着的那条就立刻算到点。别的一个字都不改 —— 掷骰子、打模型、
 * 落盘、写上下文全走真代码，跑出来的结果和你等一小时拿到的是同一份。
 *
 * ── 会不会碰到真 Instagram ──
 *
 * 不会，前提是目标帖子的 `remote.mediaId` 是空的（没同步到真 IG）。
 * 那时 igrun.js:commentToReal 里两个分支都不成立：`parentRemote` 是空串，
 * `owner === actor`（角色回自己帖子下的评论），于是直接返回。
 * 脚本启动时会把这一点验一遍，不满足就拒绝跑。
 *
 * ── 怎么用 ──
 *
 *   node scripts/try-ig-comment.mjs                     # 用现成那条没人回的评论
 *   node scripts/try-ig-comment.mjs --text "这车真好看"   # 先替你留一条新评论
 *   node scripts/try-ig-comment.mjs --owner 阿瑞 --post p-xxx
 *   node scripts/try-ig-comment.mjs --force             # 无视概率，必回
 *   node scripts/try-ig-comment.mjs --as 米洛 --text "nice" --force   # 角色互评
 *
 * 跑完东西**留在盘上**：评论进 data/instagram/posts/<角色>.json，
 * 爱心页记录进 activity.json，上下文进 data/sessions/。网页上刷新就能看见。
 *
 * 后端正在跑也能用 —— 两边都是「读文件、改文件、写回去」，而这个脚本几秒钟
 * 就结束了。唯一要留意的是它不共享后端内存里的 history，所以写进上下文那一步
 * 走不了（下面 session 那段有说明）。
 */

import process from "node:process";

import { loadConfig } from "../server/src/config.js";
import { readPosts, readQueue, readActivity, updatePost } from "../server/src/igstore.js";
import { scheduleComment, tickIgQueue } from "../server/src/igrun.js";

/* ================= 参数 ================= */

const argv = process.argv.slice(2);
const flag = (name, fallback = "") => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const wantOwner = flag("owner");
const wantPost = flag("post");
const newText = flag("text");
const force = has("force");
/*
 * `--as <角色名>`：让**另一个角色**来留这条评论，而不是你。
 *
 * 这两条是不同的链路，不是同一条的参数差异：
 *
 *   你留言   → kind=userComment → 掷 replyChance → 回复里可以顺带发短信
 *   角色留言 → kind=charComment → **不掷骰子**（igrun.js 开头讲了为什么），
 *              但要过 peers 白名单和 maxChain，而且只能评论、不许发短信
 *
 * 真 IG 那一侧差别更大：你那条走 `POST /{comment-id}/replies`（角色自己的
 * 帖子，权限天然具备）；角色互评要帖主先铺一条 @ 当通行证，走 Mentions
 * 接口 —— 那条没实测过。所以这里只在**没同步到真 IG**的帖子上跑（下面
 * 那道 mediaId 闸门管着），验的是本地那半条链路。
 */
const asRole = flag("as");

/* ================= 找一条能测的帖子 ================= */

// logs.js:log 自己就往 console 打，所以后端那些 [Instagram] 开头的行会直接
// 混在下面的输出里 —— 模型那一步失败时能看见原因，不用另接订阅

const config = loadConfig();
const roles = (config.roles ?? []).filter((r) => r?.instagram?.enabled);
if (!roles.length) {
  console.error("没有开着 Instagram 的角色，测不了。");
  process.exit(1);
}

/** 候选：角色自己的帖子，且**没同步到真 IG**（那样才碰不到真号）。 */
function candidates() {
  const out = [];
  for (const role of roles) {
    const owner = String(role.name ?? "");
    if (wantOwner && owner !== wantOwner) continue;
    for (const post of readPosts(owner)) {
      if (wantPost && post.id !== wantPost) continue;
      out.push({ role, owner, post });
    }
  }
  return out;
}

const all = candidates();
if (!all.length) {
  console.error("找不到符合条件的帖子。现有的：");
  for (const role of roles) {
    for (const p of readPosts(String(role.name ?? ""))) {
      console.error(`  ${role.name}  ${p.id}  ${JSON.stringify(p.caption)}`);
    }
  }
  process.exit(1);
}

/*
 * 优先挑「已经有一条用户评论、角色还没回」的那条 —— 那正是等着被测的状态，
 * 不用再往盘上添东西。没有的话就挑第一条，下面会替用户留一句。
 */
const pending = all.find(({ owner, post }) =>
  post.comments.some((c) => c.owner === "user") &&
  !post.comments.some((c) => c.owner === owner)
);
const picked = pending ?? all[0];
const { role, owner, post } = picked;

console.log(`目标：${owner} 的 ${post.id}（${JSON.stringify(post.caption)}）`);

/*
 * 安全闸。真 IG 上有这条帖子的话，角色的回复会被 commentToReal 发到真评论区。
 * 评论**能删**（igapi.js:deleteComment，2026-09-13 实测通），但这个脚本不知道
 * 自己发出去的那条的 id（回复是 runIgTask 内部发的），也读不回来
 * （listComments 现在拿不到内容），所以删不掉 —— 等于每跑一次真号上多一条。
 * 测试脚本不该有这种代价。
 */
if (post.remote?.mediaId) {
  console.error(
    `\n✗ 这条帖子已经同步到真 Instagram 了（mediaId ${post.remote.mediaId}）。\n` +
      "  角色的回复会真的发到评论区，而这个脚本拿不到那条的 id、事后删不掉，所以不跑。\n" +
      "  换一条没同步的帖子，或者先在角色设置里关掉「同步到真实账号」。"
  );
  process.exit(1);
}

/* ================= 让评论就位 ================= */

let fresh = post;
let target = null;

/*
 * 留言人。默认是你（owner 存的就是字符串 "user"，见 igstore.js:USER_OWNER），
 * `--as 角色名` 换成那个角色 —— 那样走的是 charComment 那条链路。
 */
const actor = asRole || "user";
const actorLabel = asRole ? asRole : "你";

if (asRole) {
  const known = roles.map((r) => String(r.name ?? ""));
  if (!known.includes(asRole)) {
    console.error(`没有叫 ${asRole} 的角色（开着 Instagram 的有：${known.join("、")}）。`);
    process.exit(1);
  }
  if (asRole === owner) {
    console.error(`${asRole} 是这条帖子的主人，自言自语不触发任何人。换一个角色。`);
    process.exit(1);
  }
}

if (newText) {
  // 走和 POST /api/ig/posts/:owner/:id/comments 一样的两步：落盘、再排队
  const before = fresh.comments;
  const saved = updatePost(owner, fresh.id, {
    comments: [...before, { owner: actor, text: newText, replyTo: "" }],
  });
  const had = new Set(before.map((c) => c.id));
  target = (saved?.comments ?? []).find((c) => !had.has(c.id)) ?? null;
  fresh = saved ?? fresh;
  console.log(`替${actorLabel}留了一条评论：${JSON.stringify(newText)}（${target?.id}）`);
} else {
  target = [...fresh.comments].reverse().find((c) => c.owner === actor) ?? null;
  if (!target) {
    console.error(
      `这条帖子下没有${actorLabel}的评论。加 --text "要说的话" 让脚本替${actorLabel}留一条。`
    );
    process.exit(1);
  }
  console.log(`用现成那条评论：${JSON.stringify(target.text)}（${target.id}）`);
}

const queued = scheduleComment(config, owner, fresh, target, { isStory: false });
if (!queued.length) {
  console.error(
    "\n✗ 排不进队列。scheduleComment 会在这几种情况下什么都不做：\n" +
      "  · 被说话的那个人是你自己（角色不会替你回话）\n" +
      "  · 那个角色的 Instagram 开关关着\n" +
      "  · 这条线程已经聊到 maxChain 上限\n" +
      (asRole
        ? `  · 角色互评还要过白名单：${owner} 的「可以互动的角色」里没有 ${asRole}\n` +
          "    （单向，查的是**帖主**愿不愿意理留言的人）"
        : "")
  );
  process.exit(1);
}

const task = queued[0];
const waitMin = Math.round((task.at - Date.now()) / 60000);
console.log(`排进队列了：${task.id}（正常要等 ${waitMin} 分钟，这里直接跳过去）`);

/* ================= 假装时间到了 ================= */

/*
 * session 回调。**故意返回 null**：真正的那份（imessage.js:igSessionFor）要
 * 后端进程内存里的 runner 才拿得到，脚本里没有。
 *
 * 代价写在 runIgTask 里：上文是空的、顺带那条短信发不出去。IG 上的评论照发、
 * 照落盘、照进爱心页 —— 也就是这次要看的东西一样不缺。想连上下文一起测，
 * 就别用脚本，去网页上留言然后等那 30–120 分钟。
 */
const session = null;

const before = readActivity().length;
console.log("\n跑起来了（这一步要打模型，等十几秒）：");

const results = await tickIgQueue(config, {
  // 往后挪一天，保证队列里那条稳稳到点
  now: task.at + 86400_000,
  // --force 时把骰子焊死成 0：hit() 里 `roll()*100 < chance`，0 永远中
  roll: force ? () => 0 : undefined,
  session: session ? () => session : undefined,
});

/* ================= 结果 ================= */

console.log("\n──────── 结果 ────────");
for (const r of results) {
  if (!r.ok) {
    console.log(`没动作：${r.reason}`);
    continue;
  }
  console.log(`${r.roleName} → ${r.action}`);
  if (r.comment) console.log(`  评论：${r.comment}`);
  if (r.dm) console.log(`  想顺带发的短信：${r.dm}`);
}
if (!results.length) console.log("队列里没有到点的任务（不该出现，上面排进去了）");

const after = readPosts(owner).find((p) => p.id === post.id);
console.log(`\n${owner} 的 ${post.id} 现在有 ${after?.comments.length ?? 0} 条评论：`);
for (const c of after?.comments ?? []) {
  const who = c.owner === "user" ? "你" : c.owner;
  const re = c.replyTo ? `（回 ${c.replyTo}）` : "";
  console.log(`  ${who}${re}：${c.text}`);
}

const activity = readActivity();
if (activity.length > before) {
  console.log(`\n爱心页多了 ${activity.length - before} 条：`);
  for (const a of activity.slice(0, activity.length - before)) {
    console.log(`  ${a.kind}  ${a.actor}  ${JSON.stringify(a.text ?? "")}`);
  }
}

const left = readQueue();
console.log(`\n队列里还剩 ${left.length} 条（跑过的会出队，剩下的是别人排的）`);
console.log("这些都留在盘上了，网页上刷新「Instagram → 帖子」就能看见。");
