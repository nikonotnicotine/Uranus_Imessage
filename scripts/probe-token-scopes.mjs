/*
 * 每个号的 token 上有哪些权限 —— 用来诊断「评论读不回来」这类权限问题。
 * **不打印 token 本身**，只打用户名和各个边通不通。
 *
 * ── 怎么读输出 ──
 *
 * 关键那一行是最后的「media 内联 comments 字段在不在」。Graph API 对**没权限
 * 的字段是静默丢掉、不报错**，所以：
 *
 *   false = 缺 `instagram_business_manage_comments`（或 App 还在 Development
 *           模式）→ `/{media}/comments` 会一直回空数组，收信链路是断的
 *   true  = 权限齐了，评论能读回来
 *
 * 2026-09-13 跑的结果：两个号都是 false，`comments_count` 却是对的 ——
 * 也就是「写得进去、读不回来」。要修得去 Meta 开发者后台加权限 + 切 Live，
 * 代码这边不用改（见 igapi.js:listComments 那段注释）。
 *
 * debug_token 那个更直接的办法用不了：它只在 graph.facebook.com 上，
 * 而 Instagram Login 发的 token 那个域拒收（回「Cannot parse access token」）。
 * 所以这里用「打那些要权限才给的字段，能读到就说明有权限」来反推。
 *
 * 跑法：node scripts/probe-token-scopes.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
process.chdir(path.join(HERE, ".."));

const { loadConfig } = await import("../server/src/config.js");
const { readAccounts } = await import("../server/src/igaccounts.js");
const { readPosts } = await import("../server/src/igstore.js");
const { realGate } = await import("../server/src/igreal.js");
const { igFetch } = await import("../server/src/ignet.js");

const line = (s = "") => console.log(s);
const GRAPH = "https://graph.instagram.com";
const url = (p, params, token) => {
  const u = new URL(`${GRAPH}${p}`);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
  }
  if (token) u.searchParams.set("access_token", token);
  return u.toString();
};

const config = loadConfig();
const data = readAccounts();

for (const roleName of ["阿瑞", "米洛"]) {
  const g = realGate(config, roleName, data);
  if (!g.ok) {
    line(`${roleName}: ${g.why}`);
    continue;
  }
  const token = g.acc.token;
  line(`── ${roleName} @${g.acc.username} ──`);

  // 基础信息（instagram_business_basic 就够）
  try {
    const me = await igFetch(
      url("/me", { fields: "user_id,username,account_type,media_count,followers_count" }, token)
    );
    line(`   /me: ${JSON.stringify(me)}`);
  } catch (e) {
    line(`   /me ✗ ${String(e?.message ?? e).slice(0, 120)}`);
  }

  // 这几个边各要一个不同的权限，用「通不通」反推权限有没有
  const probes = [
    ["media（basic）", "/me/media", { fields: "id", limit: 1 }],
    ["mentioned_comment（manage_comments）", "/me", { fields: "mentioned_comment.comment_id(1)" }],
    ["conversations（manage_messages）", "/me/conversations", { fields: "id", limit: 1 }],
    ["insights（manage_insights）", "/me/insights", { metric: "reach", period: "day" }],
  ];
  for (const [label, p, params] of probes) {
    try {
      const r = await igFetch(url(p, params, token));
      line(`   ${label} → ok ${JSON.stringify(r).slice(0, 90)}`);
    } catch (e) {
      line(`   ${label} → ✗ ${String(e?.message ?? e).slice(0, 100)}`);
    }
  }

  // 自己帖子下的评论：这是关键的那个
  const post = readPosts(roleName).find((x) => x.remote?.mediaId);
  if (post) {
    const mid = post.remote.mediaId;
    try {
      const m = await igFetch(url(`/${mid}`, { fields: "comments_count,comments{id,text}" }, token));
      const hasEdge = Object.prototype.hasOwnProperty.call(m, "comments");
      line(`   media 内联 comments 字段在不在：${hasEdge}    ${JSON.stringify(m).slice(0, 140)}`);
      line(`   （字段被静默丢掉 = 缺 instagram_business_manage_comments）`);
    } catch (e) {
      line(`   media ✗ ${String(e?.message ?? e).slice(0, 120)}`);
    }
  }
  line();
}
