/*
 * 小红书的离线验证：标签解析 + 挑评论（水位 / 最新 N 条）+ xiaohongshu-mcp 客户端
 * + 一整轮「看评论 → 打模型 → 回」+ 发笔记。
 *
 * 指向临时数据目录（URANUS_DATA_DIR），绝不碰用户真实的 data/。
 * 起两个假服务在 127.0.0.1 的随机端口上：一个假 xiaohongshu-mcp、一个假的
 * OpenAI 兼容服务（聊天 + 生图）。除此之外不联网，也不 import index.js。
 * 跑法：node scripts/test-xiaohongshu.mjs
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "uranus-xhs-"));
process.env.URANUS_DATA_DIR = TMP;
process.env.IMESSAGE_BRIDGE = "off";
delete process.env.XHS_MCP_TOKEN;

const tags = await import("../server/src/xhstags.js");
const run = await import("../server/src/xhsrun.js");
const api = await import("../server/src/xhsapi.js");
const store = await import("../server/src/xhsstore.js");
const { ensureLayout } = await import("../server/src/datadir.js");
const { normalizeConfig } = await import("../server/src/config.js");
ensureLayout();

let pass = 0;
let fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}\n      得到 ${JSON.stringify(got)}\n      期望 ${JSON.stringify(want)}`);
  }
}
function checkThat(name, cond, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? `  ${detail}` : ""}`);
  }
}

console.log("=== 1. 标题长度（抄 xiaohongshu-mcp 的 title.go）===");
check("纯中文", tags.titleLength("终于吃到这家了"), 7);
check("纯英文两个算一个", tags.titleLength("abcd"), 2);
check("奇数英文向上取整", tags.titleLength("abc"), 2);
check("emoji 算两个字", tags.titleLength("🥹"), 2);
check("截到 20 以内", tags.titleLength(tags.clipTitle("一".repeat(30))), 20);

console.log("\n=== 2. splitXhs ===");
{
  const src = "[小红书:终于吃到这家了|排了四十分钟，但是值 🥹 #探店 #周末去哪儿][image:一碗拉丝的芝士面] [image:店门口]$下次带你去";
  const r = tags.splitXhs(src, "$");
  check("一篇", r.notes.length, 1);
  check("标题", r.notes[0].title, "终于吃到这家了");
  check("正文去掉了话题", r.notes[0].body, "排了四十分钟，但是值 🥹");
  check("话题", r.notes[0].topics, ["探店", "周末去哪儿"]);
  check("两张图都归它", r.notes[0].images.map((i) => i.alt), ["一碗拉丝的芝士面", "店门口"]);
  check("剩下的短信", r.rest, "$下次带你去");

  const mixed = tags.splitXhs("[xhs:今天好累啊。躺平]说句话[image:一只猫]", "$");
  check("没写 | 从正文取标题", mixed.notes[0].title, "今天好累啊");
  check("隔了文字的图不归小红书", mixed.notes[0].images, []);
  check("那张图留给别人", mixed.rest, "说句话[image:一只猫]");

  check("全角方括号也认", tags.splitXhs("［小红书：标题｜正文］", "").notes[0]?.title, "标题");
  check("xml 块里的不算", tags.hasXhsTag("<thinking>[小红书:a|b]</thinking>"), false);
  check("没开标签", tags.hasXhsTag("随便说点什么"), false);
  check("图最多 9 张", tags.splitXhs(`[小红书:a|b]${"[image:x]".repeat(12)}`, "").notes[0].images.length, 9);
  check("stripXhsTags", tags.stripXhsTags("前[小红书:a|b][image:x]后"), "前后");
}

console.log("\n=== 3. parseReplies ===");
{
  const out = tags.parseReplies("[回复:1:哈哈谢谢] 废话 [回复评论:3：下次一起] [xhs_reply:1:重复的] [reply:2:引用回复不算]", "$");
  check("认中文和 xhs_reply，不认 reply，同编号只认第一次", out, [
    { no: 1, text: "哈哈谢谢" },
    { no: 3, text: "下次一起" },
  ]);
}

console.log("\n=== 4. pickComments：水位 + 最新 N 条 ===");
{
  const T = 1_800_000_000_000;
  const c = (id, dt, extra = {}) => ({ id, type: "comment/item", time: T + dt, commentId: `c${id}`, text: `评论${id}`, fromId: "u", fromName: `路人${id}`, ...extra });
  const first = run.pickComments([c(1, 10), c(2, 20)], { watermark: 0, seen: [] }, { topN: 5, now: T });
  check("第一次只立水位", [first.first, first.picked.length, first.watermark], [true, 0, T + 20]);
  const empty = run.pickComments([], { watermark: 0, seen: [] }, { now: T });
  check("一条通知都没有就拿现在当水位", empty.watermark, T);

  const items = [
    ...Array.from({ length: 30 }, (_, i) => c(100 + i, 1000 + i)),
    c(5, 5), // 水位之前的老评论
    c(9, 2000, { fromId: "me" }), // 自己的
    c(8, 2001, { type: "mention/item" }), // @ 不是评论
    c(7, 2002, { commentId: "cseen" }), // 回过的
  ];
  const r = run.pickComments(items, { watermark: T + 20, seen: ["cseen"] }, { topN: 3, selfId: "me", now: T });
  check("爆了只取最新 3 条", r.picked.map((x) => x.commentId), ["c129", "c128", "c127"]);
  check("其余的记成跳过", r.dropped, 27);
  check("水位推到最新那条通知", r.watermark, T + 2002);
}

console.log("\n=== 5. normalizeConfig 里的小红书 ===");
{
  const cfg = normalizeConfig({ roles: [{ id: "r1", name: "A", xiaohongshu: { enabled: true, topN: 99, pollMinutes: 1, baseUrl: "http://127.0.0.1:1234///" } }] });
  const x = cfg.roles[0].xiaohongshu;
  check("夹紧 + 去尾斜杠", [x.enabled, x.topN, x.pollMinutes, x.baseUrl], [true, 20, 5, "http://127.0.0.1:1234"]);
  const bad = normalizeConfig({ roles: [{ id: "r1", name: "A", xiaohongshu: { baseUrl: "ftp://x" } }] }).roles[0].xiaohongshu;
  check("不是 http(s) 就回默认", [bad.enabled, bad.baseUrl], [false, "http://localhost:18060"]);
}

/* ================= 假服务 ================= */

const T0 = Date.now();
const mcpHits = [];
let mentions = [];
let requireToken = "";
const mcp = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const url = new URL(req.url, "http://x");
    mcpHits.push({ method: req.method, path: url.pathname, query: url.search, body: body ? JSON.parse(body) : null, auth: req.headers.authorization ?? "" });
    const send = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (requireToken && req.headers.authorization !== `Bearer ${requireToken}`) return send(401, { error: "unauthorized", code: "UNAUTHORIZED" });
    if (url.pathname === "/api/v1/login/status") return send(200, { success: true, data: { is_logged_in: true, username: "角色本号", user_id: "me" } });
    if (url.pathname === "/api/v1/notifications/list") {
      return send(200, { success: true, data: { data: { tab: "mentions", items: mentions } } });
    }
    if (url.pathname === "/api/v1/notifications/reply") {
      const b = JSON.parse(body);
      if (b.comment_id === "boom") return send(500, { error: "回复失败", code: "REPLY_FAILED", details: "风控" });
      return send(200, { success: true, data: { data: { comment_id: b.comment_id, content: b.content } } });
    }
    if (url.pathname === "/api/v1/publish") return send(200, { success: true, data: { title: "ok" } });
    send(404, { error: "not found" });
  });
});
await new Promise((r) => mcp.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${mcp.address().port}`;

let nextReply = "";
const llmHits = [];
// 1x1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const llm = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    llmHits.push({ url: req.url, body });
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url.includes("/images/")) return res.end(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }));
    res.end(JSON.stringify({ choices: [{ message: { content: nextReply } }] }));
  });
});
await new Promise((r) => llm.listen(0, "127.0.0.1", r));
const LLM = `http://127.0.0.1:${llm.address().port}/v1`;

console.log("\n=== 6. xhsapi 客户端 ===");
{
  const st = await api.loginStatus(BASE);
  check("登录状态", st, { isLoggedIn: true, username: "角色本号", userId: "me" });
  mentions = [{ id: "n1", type: "comment/item", time: Math.floor(T0 / 1000), comment_id: "c1", comment_text: "好看", from: { user_id: "u1", nickname: "路人甲" }, feed_id: "f1", feed_title: "我的笔记" }];
  const list = await api.listMentions(BASE, 7);
  check("秒转毫秒 + 字段映射", [list[0].time, list[0].commentId, list[0].fromName, list[0].feedTitle], [Math.floor(T0 / 1000) * 1000, "c1", "路人甲", "我的笔记"]);
  check("limit 带过去了", mcpHits.at(-1).query, "?tab=mentions&limit=7");

  let err = null;
  try { await api.replyComment(BASE, "boom", "x"); } catch (e) { err = e; }
  check("错误带上 details", [err?.name, err?.message, err?.code], ["XhsError", "回复失败：风控", "REPLY_FAILED"]);

  requireToken = "sekrit";
  err = null;
  try { await api.loginStatus(BASE); } catch (e) { err = e; }
  check("没配令牌 → 401 说人话", err?.status, 401);
  store.saveToken(BASE, "sekrit");
  check("存了令牌就带上", (await api.loginStatus(BASE)).isLoggedIn, true);
  check("hasToken", store.hasToken(BASE), true);
  store.saveToken(BASE, "");
  check("清掉令牌", store.hasToken(BASE), false);
  requireToken = "";

  err = null;
  try { await api.loginStatus("http://127.0.0.1:1"); } catch (e) { err = e; }
  checkThat("连不上给句人话", /连不上 xiaohongshu-mcp/.test(err?.message ?? ""), err?.message);

  // 串行：两个请求一起发，服务端看到的顺序和发出顺序一致
  mcpHits.length = 0;
  await Promise.all([api.loginStatus(BASE), api.listMentions(BASE, 1), api.loginStatus(BASE)]);
  check("同一地址串行", mcpHits.map((h) => h.path.split("/").pop()), ["status", "list", "status"]);
}

const chatModel = { provider: "pv", modelId: "m1" };
const baseCfg = (withImage) => ({
  chat: { separator: "$" },
  presets: [],
  worldBooks: [],
  providers: [
    {
      id: "pv",
      name: "假服务商",
      url: LLM,
      keys: ["k"],
      models: [
        { id: "m1", model: "fake", enabled: true, categories: ["chat"] },
        ...(withImage ? [{ id: "m2", model: "fake-img", enabled: true, categories: ["image"] }] : []),
      ],
    },
  ],
  users: [{ id: "u1", name: "小满", enabled: true, scope: "global", description: "" }],
});
const role = {
  id: "r-x",
  name: "小明",
  description: "{{char}} 是个摄影师。",
  chatModel,
  memories: { memory: {}, memo: {}, diary: {} },
  xiaohongshu: { enabled: true, autoPublish: true, replyEnabled: true, topN: 2, pollMinutes: 30, baseUrl: BASE },
};

console.log("\n=== 7. pollXhsReplies：一整轮 ===");
{
  const cfg = { ...baseCfg(false), roles: [role] };
  const committed = [];
  const session = async () => ({ history: [], commit: (o) => { committed.push(o); } });
  const at = (dt) => T0 + dt;
  const n = (id, dt, from = "u") => ({ id, type: "comment/item", time: at(dt), comment_id: `c${id}`, comment_text: `评论${id}`, from: { user_id: from, nickname: `路人${id}` }, feed_title: "今天的咖啡" });

  mentions = [n(1, 0)];
  const r1 = await run.pollXhsReplies(cfg, role, { session, now: at(10) });
  check("第一轮只立水位，不打模型", [r1.reason, llmHits.length, committed.length], ["第一次只立水位", 0, 0]);
  check("水位落盘", store.roleState("r-x").watermark, at(0));

  mentions = [n(5, 500), n(4, 400), n(3, 300, "me"), n(2, 200), n(1, 0)];
  nextReply = "[回复:1:谢谢喜欢～] [回复:2:哈哈对] [回复:9:没这条]";
  const r2 = await run.pollXhsReplies(cfg, role, { session, now: at(1000) });
  check("取最新 2 条（自己的滤掉）", [r2.picked, r2.dropped], [2, 1]);
  check("回了两条", r2.replied.map((d) => [d.comment.commentId, d.text]), [["c5", "谢谢喜欢～"], ["c4", "哈哈对"]]);
  const replyHits = mcpHits.filter((h) => h.path.endsWith("/notifications/reply")).slice(-2);
  check("发给 MCP 的", replyHits.map((h) => h.body), [{ comment_id: "c5", content: "谢谢喜欢～" }, { comment_id: "c4", content: "哈哈对" }]);
  const prompt = JSON.parse(llmHits.at(-1).body).messages.map((m) => m.content).join("\n");
  checkThat("提示词里有 <小红书> 块和编号", prompt.includes("<小红书>") && prompt.includes("1. 路人5 在笔记「今天的咖啡」下评论：评论5"), prompt.slice(0, 300));
  checkThat("跳过的那条没进提示词", !prompt.includes("评论2"));
  check("写进上下文", [committed.length, committed[0]?.kind, committed[0]?.commentLine], [1, "xhsReply", "[小红书 回复] 回 路人5：谢谢喜欢～\n[小红书 回复] 回 路人4：哈哈对"]);
  check("水位推到最新", store.roleState("r-x").watermark, at(500));
  check("流水", store.roleState("r-x").replies.map((x) => x.reply), ["谢谢喜欢～", "哈哈对"]);

  const hits = llmHits.length;
  const r3 = await run.pollXhsReplies(cfg, role, { session, now: at(2000) });
  check("没新评论就不打模型", [r3.reason, llmHits.length], ["没有新评论", hits]);

  const off = await run.pollXhsReplies(cfg, { ...role, xiaohongshu: { ...role.xiaohongshu, replyEnabled: false } }, { session });
  check("没开回评论", off.reason, "没开回评论");

  check("同地址只让第一个角色回", run.pollTargets({ roles: [role, { ...role, id: "r-y" }] }).map((r) => r.id), ["r-x"]);
}

console.log("\n=== 8. 发笔记 ===");
{
  const note = tags.splitXhs("[小红书:咖啡|今天的拉花 #咖啡][image:一杯拉花拿铁]", "$").notes[0];
  let err = null;
  try { await run.publishOne({ ...baseCfg(false), roles: [role] }, role, note); } catch (e) { err = e; }
  checkThat("没配生图就说清楚", /生图/.test(err?.message ?? ""), err?.message);

  mcpHits.length = 0;
  const out = await run.publishOne({ ...baseCfg(true), roles: [role] }, role, note);
  check("一张图", out.images, 1);
  const pub = mcpHits.find((h) => h.path.endsWith("/publish"))?.body;
  check("标题正文话题", [pub?.title, pub?.content, pub?.tags], ["咖啡", "今天的拉花", ["咖啡"]]);
  checkThat("图片路径是 ASCII", /^[\x20-\x7e]+$/.test(pub?.images?.[0] ?? ""), pub?.images?.[0]);
  checkThat("发完删掉暂存图", pub?.images?.[0] && !fs.existsSync(pub.images[0]));

  // 没写图 → 按标题正文自动配一张
  mcpHits.length = 0;
  await run.publishOne({ ...baseCfg(true), roles: [role] }, role, { title: "无图", body: "就一段话", topics: [], images: [] });
  check("自动配一张", mcpHits.find((h) => h.path.endsWith("/publish"))?.body.images.length, 1);

  const lines = run.publishXhsNotes({ ...baseCfg(true), roles: [role] }, role, [note]);
  check("上下文那句人话（立刻返回）", lines, ["[小红书 笔记] 咖啡｜今天的拉花 #咖啡（配图：一杯拉花拿铁）"]);
  // 等后台发完
  for (let i = 0; i < 50 && !store.roleState("r-x").notes.length; i += 1) await new Promise((r) => setTimeout(r, 50));
  check("后台发完记了流水", store.roleState("r-x").notes.at(-1)?.ok, true);

  // MCP 不在本机
  check("回环才算本机", ["http://localhost:18060", "http://127.0.0.1:1", "http://[::1]:1", "http://100.64.0.2:18060", "http://pc.tail1234.ts.net:18060"].map(run.isLocalMcp), [true, true, true, false, false]);
  const remote = { ...role, xiaohongshu: { ...role.xiaohongshu, baseUrl: "http://100.64.0.2:18060" } };
  err = null;
  try { await run.publishOne({ ...baseCfg(true), roles: [remote] }, remote, note); } catch (e) { err = e; }
  checkThat("MCP 在别处、没填 Uranus 地址 → 说清楚", /Uranus 地址/.test(err?.message ?? ""), err?.message);

  const staged = store.stageImage(PNG, "png");
  check("本机给路径", run.imageRefs([staged], BASE, ""), [staged]);
  const [link] = run.imageRefs([staged], "http://100.64.0.2:18060", "http://100.64.0.1:8787");
  const m = /^http:\/\/100\.64\.0\.1:8787\/xhs-img\/([0-9a-f]{32})\.png$/.exec(link);
  checkThat("别处给一次性链接", Boolean(m), link);
  check("令牌换得回文件", store.sharedFile(m?.[1]), staged);
  check("瞎编的令牌不行", store.sharedFile("0".repeat(32)), "");
  store.unstage([staged]);
  check("发完就作废", store.sharedFile(m?.[1]), "");
  checkThat("配置里留着 imageBase", normalizeConfig({ roles: [{ id: "r", name: "A", xiaohongshu: { imageBase: "http://100.64.0.1:8787/" } }] }).roles[0].xiaohongshu.imageBase === "http://100.64.0.1:8787");

  check("composeNote 两道闸", [
    Boolean(run.xhsComposeNote(baseCfg(false), role)),
    run.xhsComposeNote(baseCfg(false), { ...role, xiaohongshu: { ...role.xiaohongshu, autoPublish: false } }),
  ], [true, ""]);
}

mcp.close();
llm.close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} 过、${fail} 挂`);
process.exit(fail ? 1 : 0);
