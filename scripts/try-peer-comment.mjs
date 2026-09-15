/*
 * 真 IG 上「角色评论另一个角色的帖子」这条链路的**一次性实测**。
 *
 * ── 为什么单独一个脚本 ──
 *
 * 这条链路（igreal.js:peerComment）以前是全套里唯一没实测过的一环。
 * 2026-09-13 实测过了：两步都通，而且铺路那条 @ 用完就删（`DELETE /{comment-id}`
 * 是通的）。但它**会在真号上留下一条真评论**，所以不能塞进 test-instagram.mjs
 * —— 那个是随时可重跑的离线套件，这个是「按一次就在真 IG 上多一条评论」。
 *
 * 跑法：node scripts/try-peer-comment.mjs [帖主] [评论方]
 * 默认 阿瑞（帖主）← 米洛（评论方）。
 *
 * 会做的事，按顺序：
 *   1. 读真实的 data/instagram/accounts.json（**不改**它，除了失败时那次
 *      mentionsBroken —— 那是 peerComment 自己写的，见下）
 *   2. 找帖主最近一条**已经同步到真 IG**的帖子
 *   3. 打 peerComment：帖主发 `@评论方`，评论方用 mentions 接口进门说话
 *   4. 把 Meta 的原始返回 / 原始报错打出来
 *   5. 回读那条帖子的评论列表，看真 IG 上到底留下了什么
 *
 * token 一个字节都不会打出来 —— 全程只打用户名和 media id。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
process.chdir(path.join(HERE, ".."));

const ownerName = process.argv[2] || "阿瑞";
const actorName = process.argv[3] || "米洛";

const { loadConfig } = await import("../server/src/config.js");
const { readAccounts, writeRealSettings } = await import("../server/src/igaccounts.js");
const { readPosts } = await import("../server/src/igstore.js");
const { peerComment, realGate } = await import("../server/src/igreal.js");
const { listComments } = await import("../server/src/igapi.js");

const line = (s = "") => console.log(s);

line(`帖主：${ownerName}    评论方：${actorName}`);
line();

const config = loadConfig();
const data = readAccounts();

/* ── 1. 两边都得能用 ── */
const og = realGate(config, ownerName, data);
const ag = realGate(config, actorName, data);
line(`帖主 ${ownerName}：${og.ok ? `ok，@${og.acc.username}` : `不行 —— ${og.why}`}`);
line(`评论方 ${actorName}：${ag.ok ? `ok，@${ag.acc.username}` : `不行 —— ${ag.why}`}`);
if (!og.ok || !ag.ok) process.exit(1);

if (data.settings.mentionsBroken) {
  line();
  line("settings.mentionsBroken 是 true —— 之前试过不通。这次先把它清掉再试。");
  writeRealSettings({ mentionsBroken: false });
}

/* ── 2. 找一条真的在线上的帖子 ── */
const post = readPosts(ownerName).find((p) => p.remote?.mediaId);
if (!post) {
  line();
  line(`${ownerName} 没有任何已经同步到真 IG 的帖子，没法试。`);
  process.exit(1);
}
line();
line(`拿 ${ownerName} 的帖子 ${post.id}（真 IG media ${post.remote.mediaId}）来试`);

/* ── 3. 试之前，真 IG 上现在有几条评论 ── */
let before = [];
try {
  before = await listComments(og.acc, post.remote.mediaId);
  line(`试之前，这条帖子在真 IG 上有 ${before.length} 条评论`);
} catch (e) {
  line(`读不到现有评论（不影响继续试）：${e?.message ?? e}`);
}

/* ── 4. 真打 ── */
const text = `这张的光真好看`;
line();
line(`要发的内容：「${text}」`);
line("开始 —— ① 帖主铺 @ ② 评论方走 mentions 接口");
line();

const t0 = Date.now();
const r = await peerComment(config, ownerName, actorName, post, text);
const ms = Date.now() - t0;

line(r.ok ? `✓ peerComment 说成功了（${ms}ms）` : `✗ peerComment 失败了（${ms}ms）`);
if (r.why) line(`  原因：${r.why}`);

/* ── 5. 真 IG 上实际留下了什么 ── */
line();
line("回读真 IG 上这条帖子的评论：");
try {
  const after = await listComments(og.acc, post.remote.mediaId);
  line(`  现在 ${after.length} 条（之前 ${before.length} 条）`);
  const seen = new Set(before.map((c) => c.id));
  const fresh = after.filter((c) => !seen.has(c.id));
  if (!fresh.length) line("  没有新增 —— 两步都没留下痕迹");
  for (const c of fresh) {
    line(`  + @${c.username}：${c.text}${c.replyTo ? `（回复 ${c.replyTo}）` : ""}`);
  }
} catch (e) {
  line(`  读不到：${e?.message ?? e}`);
}

/* ── 6. 失败的话，peerComment 已经把开关关了 ── */
const now = readAccounts();
line();
line(`settings.mentionsBroken 现在是：${now.settings.mentionsBroken}`);
if (now.settings.mentionsBroken) {
  line("（peerComment 自己关的 —— 之后角色互评只走本地，界面上可以重置）");
}
