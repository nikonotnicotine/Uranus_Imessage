/*
 * 「我在真 IG 配文里 @ 了角色」这条链路的**只读**诊断。
 *
 * 一个字都不往真 IG 上写：只 GET 你的帖子列表，然后拿配文和本地已绑的用户名
 * 对一遍。要真发评论是下一步的事（scripts/try-user-mention-live.mjs）。
 *
 * ── 为什么要单独有这一步 ──
 *
 * 这条链路有四个能悄悄断掉的地方，断在哪儿现象都一样（角色没反应）：
 *
 *   1. 大号没绑         → 压根拉不到你的帖子
 *   2. syncUser 关着    → 拉了也不进本地
 *   3. 配文里的 @ 写错   → 最常见。@ 的得是角色**绑的那个 IG 用户名**，
 *                          不是角色名（@阿瑞 ≠ @charlie_ig）
 *   4. 帖子还没镜像进来  → 轮询没跑到
 *
 * 一个个试要打好几次网络，还可能在真 IG 上留下没用的评论。所以先只读地看一遍。
 *
 * **不打印 token**，只打用户名和判断结果。
 *
 * 跑法：node scripts/diag-user-mention.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
process.chdir(path.join(HERE, ".."));

const { loadConfig } = await import("../server/src/config.js");
const { readAccounts, mentionedHandles, roleHandleMap, accountUsable } = await import(
  "../server/src/igaccounts.js"
);
const { listMedia } = await import("../server/src/igapi.js");
const { USER_OWNER, readPosts } = await import("../server/src/igstore.js");

const line = (s = "") => console.log(s);
const config = loadConfig();
const data = readAccounts();

/* ================= 1. 三个开关 ================= */

line("──── 前置条件 ────");
const userBound = Boolean(data.user.token);
line(`你的大号：${userBound ? `已绑 @${data.user.username || "(没拿到用户名)"}` : "✗ 没绑"}`);
if (userBound && !accountUsable(data.user)) {
  line("   ⚠ 这条 token 已经过期了，要重新去 Meta 后台生成");
}
line(`同步你自己的号（syncUser）：${data.settings.syncUser ? "开着" : "✗ 关着"}`);
line(`Mentions 之前试过不通（mentionsBroken）：${data.settings.mentionsBroken ? "⚠ 是" : "否"}`);

const byHandle = roleHandleMap(data);
line();
line("──── 角色绑的用户名（配文里要 @ 的就是这个）────");
if (!byHandle.size) line("   ✗ 一个角色都没绑真号");
for (const [handle, roleName] of byHandle) {
  const role = (config.roles ?? []).find((r) => String(r.name) === roleName);
  const syncReal = role?.instagram?.syncReal;
  line(`   @${handle}  →  ${roleName}${syncReal ? "" : "   ⚠ 它没开「同步到真实 IG」"}`);
}

if (!userBound) {
  line();
  line("大号没绑，拉不到你的帖子。先去 Instagram 那一页绑上。");
  process.exit(1);
}

/* ================= 2. 你真 IG 上的帖子 ================= */

line();
line("──── 你真 IG 上最近的帖子 ────");
let media = [];
try {
  media = await listMedia(data.user, 5);
} catch (e) {
  line(`✗ 拉不回来：${String(e?.message ?? e).slice(0, 160)}`);
  process.exit(1);
}
if (!media.length) line("   （一条都没有）");

// 本地已经镜像进来的，靠 mediaId 比对
const localIds = new Set(
  readPosts(USER_OWNER)
    .map((p) => p.remote?.mediaId)
    .filter(Boolean)
);

for (const m of media) {
  const hits = mentionedHandles(m.caption).filter((h) => byHandle.has(h));
  const missed = mentionedHandles(m.caption).filter((h) => !byHandle.has(h));
  line();
  line(`   ${m.id}   ${m.timestamp}`);
  line(`   配文：${JSON.stringify(m.caption).slice(0, 160)}`);
  line(`   本地镜像：${localIds.has(m.id) ? "已经有了" : "还没拉进来"}`);
  if (hits.length) {
    line(`   ✓ 点名了：${hits.map((h) => `${byHandle.get(h)}（@${h}）`).join("、")}`);
  } else {
    line("   ✗ 没有点到任何已绑的角色");
  }
  if (missed.length) {
    // 这一行是最有用的诊断：@ 了、但那串名字对不上任何角色
    line(`   ⚠ 配文里这几个 @ 谁也对不上：${missed.map((h) => `@${h}`).join("、")}`);
  }
}

line();
line("只读诊断到此为止 —— 什么都没往真 IG 上写。");
