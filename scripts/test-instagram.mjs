/*
 * Instagram 的离线验证：文件层 + 标签解析 + 过期算法 + 队列 + 预设正文 + 互动链路。
 *
 * 指向临时数据目录（URANUS_DATA_DIR），绝不碰用户真实的 data/ ——
 * 那里面有真的 API key、Photon 凭据和聊天记录。
 * 最后一节会起一个假的 OpenAI 兼容服务在 127.0.0.1 上（随机端口），
 * 除此之外全程不联网，也不 import server/src/index.js（那个一进来就占 8787）。
 * 跑法：node scripts/test-instagram.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "uranus-ig-"));
process.env.URANUS_DATA_DIR = TMP;
process.env.IMESSAGE_BRIDGE = "off";

const store = await import("../server/src/igstore.js");
const tags = await import("../server/src/igtags.js");
const { ensureLayout, INSTAGRAM_DIR } = await import("../server/src/datadir.js");

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

ensureLayout();

console.log("\n=== 1. 目录布局 ===");
for (const sub of ["profiles", "posts", "stories", "highlights", "media"]) {
  checkThat(`data/instagram/${sub}/ 建出来了`, fs.existsSync(path.join(INSTAGRAM_DIR, sub)));
}

console.log("\n=== 2. ownerKeyFor：文件名安全 ===");
check("user 保持原样", store.ownerKeyFor("user"), "user");
check("英文名直接用", store.ownerKeyFor("Alex"), "Alex");
check("空格换下划线", store.ownerKeyFor("Ning Ning"), "Ning_Ning");
checkThat("中文名走十六进制", /^c_[0-9a-f]+$/.test(store.ownerKeyFor("小樱")));
checkThat("路径穿越算不出斜杠", !/[\\/.]/.test(store.ownerKeyFor("../../etc/passwd")));
check("空 owner 返回空串", store.ownerKeyFor(""), "");
checkThat(
  "两个不同中文名不撞",
  store.ownerKeyFor("小樱") !== store.ownerKeyFor("小桃")
);

console.log("\n=== 3. mediaPathFor：URL 里那段必须卡死 ===");
checkThat("正常文件名放行", Boolean(store.mediaPathFor("ig-abc-1.png")));
check("带斜杠挡掉", store.mediaPathFor("a/b.png"), null);
check("上跳目录挡掉", store.mediaPathFor("..\\..\\data.config.json"), null);
check("中文名挡掉（媒体名是程序生成的，不该有中文）", store.mediaPathFor("图.png"), null);
check("空名挡掉", store.mediaPathFor(""), null);

console.log("\n=== 4. 主页资料 ===");
const prof = store.writeProfile("小明", { name: "小明", followers: "1,137万", verified: true });
check("写完读回来一致", store.readProfile("小明").followers, "1,137万");
check("蓝勾存下来了", store.readProfile("小明").verified, true);
check("没写过的 owner 给默认值", store.readProfile("阿瑞").name, "阿瑞");
check("用户自己的默认名是空的", store.readProfile("user").name, "");
check("三个计数默认是空串（= 显示真实数量）", [
  store.readProfile("Zed").posts,
  store.readProfile("Zed").followers,
  store.readProfile("Zed").following,
], ["", "", ""]);
checkThat("owner 字段带上了", prof.owner === "小明");

console.log("\n=== 5. 帖子 ===");
const p1 = store.addPost("user", { caption: "第一条", images: [{ file: "a.png", alt: "猫" }] });
const p2 = store.addPost("user", { caption: "第二条" });
check("新帖排在最前面", store.readPosts("user").map((p) => p.caption), ["第二条", "第一条"]);
check("id 不重复", p1.id === p2.id, false);
check("图片规范化成对象", p1.images, [{ file: "a.png", alt: "猫" }]);
check("字符串图片也认", store.addPost("x", { images: ["b.png"] }).images, [
  { file: "b.png", alt: "" },
]);
check("likes 默认空数组", p1.likes, []);
check("visionNote 默认空串", p1.visionNote, "");

store.updatePost("user", p2.id, { caption: "改过的", likes: ["小明"] });
check("改配文", store.readPosts("user")[0].caption, "改过的");
check("改点赞", store.readPosts("user")[0].likes, ["小明"]);
check("改不存在的帖子返回 null", store.updatePost("user", "没有这个", { caption: "x" }), null);

check("删帖", store.removePost("user", p2.id), true);
check("删完只剩一条", store.readPosts("user").length, 1);
check("删不存在的返回 false", store.removePost("user", "没有这个"), false);

console.log("\n=== 6. 评论：平铺 + replyTo ===");
store.updatePost("user", p1.id, {
  comments: [
    { id: "c1", owner: "小明", text: "好看" },
    { id: "c2", owner: "user", text: "谢谢", replyTo: "c1" },
  ],
});
const withComments = store.readPosts("user")[0];
check("两条评论都在", withComments.comments.length, 2);
check("顶层评论的 replyTo 是空串", withComments.comments[0].replyTo, "");
check("回复指向父评论", withComments.comments[1].replyTo, "c1");
checkThat("评论自动补 at", Boolean(withComments.comments[0].at));

console.log("\n=== 7. 快拍过期：读的时候算 ===");
const now = Date.parse("2026-09-12T12:00:00Z");
const fresh = { createdAt: "2026-09-12T11:00:00Z" };
const old = { createdAt: "2026-09-11T00:00:00Z" };
check("1 小时前的没过期", store.storyExpired(fresh, 24, now), false);
check("36 小时前的过期了", store.storyExpired(old, 24, now), true);
check("整好 24 小时算过期", store.storyExpired({ createdAt: "2026-09-11T12:00:00Z" }, 24, now), true);
check("hours=0 表示永不过期", store.storyExpired(old, 0, now), false);
check("时间读不出来的当没过期", store.storyExpired({ createdAt: "坏的" }, 24, now), false);

store.addStory("小明", { caption: "早", createdAt: "2026-09-12T11:00:00Z" });
store.addStory("小明", { caption: "昨天的", createdAt: "2026-09-11T00:00:00Z" });
check("活着的只有一条", store.activeStories("小明", 24, now).map((s) => s.caption), ["早"]);
check("过期的那条能单独找出来", store.expiredStories("小明", 24, now).map((s) => s.caption), [
  "昨天的",
]);
check("改成 48 小时后两条都活着", store.activeStories("小明", 48, now).length, 2);

console.log("\n=== 8. 精选快拍：最多三个 ===");
const s1 = store.addStory("阿瑞", { caption: "一", image: { file: "s1.png", alt: "" } });
const s2 = store.addStory("阿瑞", { caption: "二", image: { file: "s2.png", alt: "" } });
const h1 = store.saveToHighlight("阿瑞", s1.id, { title: "旅行" });
checkThat("新建一组精选", h1 && h1.title === "旅行");
check("封面默认用这条快拍的图", h1.cover, "s1.png");
check("里面有那条快拍", h1.storyIds, [s1.id]);

store.saveToHighlight("阿瑞", s2.id, { highlightId: h1.id });
check("往同一组里加第二条", store.readHighlights("阿瑞")[0].storyIds.length, 2);
store.saveToHighlight("阿瑞", s2.id, { highlightId: h1.id });
check("重复存不会加两次", store.readHighlights("阿瑞")[0].storyIds.length, 2);

store.saveToHighlight("阿瑞", s1.id, { title: "二组" });
store.saveToHighlight("阿瑞", s1.id, { title: "三组" });
check("三组满了", store.readHighlights("阿瑞").length, 3);
check("第四组被拒", store.saveToHighlight("阿瑞", s1.id, { title: "四组" }), null);
check("存不存在的快拍返回 null", store.saveToHighlight("阿瑞", "没有", {}), null);
check("删一组", store.removeHighlight("阿瑞", h1.id), true);
check("删完剩两组", store.readHighlights("阿瑞").length, 2);

console.log("\n=== 9. 互动记录 ===");
store.addActivity({ kind: "like", actor: "小明", target: { owner: "user", postId: p1.id } });
store.addActivity({ kind: "comment", actor: "阿瑞", text: "好看", target: { postId: p1.id } });
check("两条都在", store.readActivity().length, 2);
check("新的在最前面", store.readActivity()[0].actor, "阿瑞");
check("默认未读", store.readActivity()[0].read, false);
store.markActivityRead();
check("全标已读", store.readActivity().every((a) => a.read), true);

console.log("\n=== 10. 互动队列：要落盘 ===");
const t1 = store.pushQueue({ at: now - 1000, roleId: "r-1", kind: "comment", postId: p1.id });
store.pushQueue({ at: now + 3600_000, roleId: "r-2", kind: "comment", postId: p1.id });
check("排了两个", store.readQueue().length, 2);
check("只有一个到点了", store.dueTasks(now).map((t) => t.roleId), ["r-1"]);
check("chain 默认 0", store.readQueue()[0].chain, 0);
checkThat("真的写进文件了", fs.existsSync(path.join(INSTAGRAM_DIR, "queue.json")));
check("删一个", store.dropQueue(t1.id), true);
check("删完剩一个", store.readQueue().length, 1);
check("删不存在的返回 false", store.dropQueue("没有这个"), false);

console.log("\n=== 11. 识图缓存过期就清 ===");
const vp = store.addPost("user", { caption: "带图", createdAt: "2026-09-11T00:00:00Z" });
store.updatePost("user", vp.id, { visionNote: "一只橘猫" });
check("先存进去了", store.readPosts("user").find((p) => p.id === vp.id).visionNote, "一只橘猫");
store.pruneVisionNotes(["user"], 24, now);
check("超 24 小时被清空", store.readPosts("user").find((p) => p.id === vp.id).visionNote, "");
store.updatePost("user", p1.id, { visionNote: "留着", createdAt: "2026-09-12T11:00:00Z" });
store.pruneVisionNotes(["user"], 24, now);
check("没超时的不动", store.readPosts("user").find((p) => p.id === p1.id).visionNote, "留着");

console.log("\n=== 12. 设置 ===");
check("默认 24 小时", store.readSettings().storyHours, 24);
store.writeSettings({ storyHours: 48 });
check("改成 48", store.readSettings().storyHours, 48);
store.writeSettings({ storyHours: -5 });
check("负数被挡回默认值", store.readSettings().storyHours, 24);
store.writeSettings({ promptTemplates: { userPost: "自定义" } });
check("提示词模板存下来了", store.readSettings().promptTemplates.userPost, "自定义");
check("没改的模板还是空串", store.readSettings().promptTemplates.charComment, "");

console.log("\n=== 13. 标签解析：hasIgTag ===");
check("[post:] 认得", tags.hasIgTag("[post:今天真好]"), true);
check("[快拍:] 认得", tags.hasIgTag("[快拍:出门了]"), true);
check("全角括号认得", tags.hasIgTag("［post：好］"), true);
check("[image:] 认得", tags.hasIgTag("[image:一只猫]"), true);
check("[comment:] 认得", tags.hasIgTag("[comment:好看]"), true);
check("纯私聊不认", tags.hasIgTag("今天去哪吃饭"), false);
check("私聊里的语音标签不认", tags.hasIgTag("[audio_message:喂]"), false);
check("thinking 里复述格式不算", tags.hasIgTag("<thinking>格式是 [post:文案]</thinking>好的"), false);

console.log("\n=== 14. 标签解析：post / story / image 归属 ===");
{
  const r = tags.splitIg("[post:刚去吃了火锅][image:一桌火锅]", "$");
  check("一条帖子", r.posts.length, 1);
  check("配文是 post 体内的内容", r.posts[0].caption, "刚去吃了火锅");
  check("图归给它", r.posts[0].images, [{ alt: "一桌火锅" }]);
  check("没有快拍", r.stories.length, 0);
  check("rest 是空的", r.rest, "");
}
{
  const r = tags.splitIg("[story:出门][图片:街景]", "$");
  check("快拍也能带图", r.stories[0].images, [{ alt: "街景" }]);
  check("快拍配文", r.stories[0].caption, "出门");
}
{
  const r = tags.splitIg("[image:一只躺在沙发上的猫]", "$");
  check("只有图 → 发快拍", r.stories.length, 1);
  check("而且不带文字", r.stories[0].caption, "");
  check("不产出帖子", r.posts.length, 0);
}
{
  const r = tags.splitIg("[post:三张图][image:一][image:二][image:三]", "$");
  check("一个帖子带多张图（轮播）", r.posts[0].images.length, 3);
}
{
  const r = tags.splitIg("[post:甲][image:图甲][story:乙][image:图乙]", "$");
  check("图各归各家：帖子", r.posts[0].images, [{ alt: "图甲" }]);
  check("图各归各家：快拍", r.stories[0].images, [{ alt: "图乙" }]);
}
{
  const r = tags.splitIg("[post]", "$");
  check("裸 [post] 当空配文帖子", r.posts, [{ caption: "", images: [] }]);
}
{
  const r = tags.splitIg("[快拍]", "$");
  check("裸 [快拍] 当空配文快拍", r.stories.length, 1);
}

console.log("\n=== 15. 标签解析：分隔符换逗号（用户特别强调的） ===");
check("post 体内的 $ 换逗号", tags.splitIg("[post:今天真好$明天也会]", "$").posts[0].caption, "今天真好，明天也会");
check(
  "comment 体内的 $ 换逗号",
  tags.splitIg("[comment:其实我觉得$那里的菜很一般]", "$").comments,
  ["其实我觉得，那里的菜很一般"]
);
check("image 体内的也换", tags.splitIg("[image:一只猫$在桌上]", "$").stories[0].images, [
  { alt: "一只猫，在桌上" },
]);
check("连着几个 $ 收成一个逗号", tags.splitIg("[post:甲$$$乙]", "$").posts[0].caption, "甲，乙");
check("$ 两边的空格一并吃掉", tags.splitIg("[post:甲 $ 乙]", "$").posts[0].caption, "甲，乙");
check(
  "括号外的 $ 不动（还是气泡分隔符）",
  tags.splitIg("[comment:好看]下次带你去$怎么样？", "$").rest,
  "下次带你去$怎么样？"
);
check("分隔符是正则元字符也不炸", tags.splitIg("[post:甲$乙]", "$").posts[0].caption, "甲，乙");
check("换成别的分隔符照样管用", tags.splitIg("[post:甲||乙]", "||").posts[0].caption, "甲，乙");
check("没给分隔符就不动", tags.splitIg("[post:甲$乙]", "").posts[0].caption, "甲$乙");

console.log("\n=== 16. 标签解析：三种输出形态 ===");
{
  // 用户给的第一种：只有评论
  const r = tags.splitIg("[comment:看起来好好吃]", "$");
  check("只有评论", r.comments, ["看起来好好吃"]);
  check("没有要发的短信", r.rest, "");
}
{
  // 第二种：只有私聊（压根没 IG 标签）
  check("纯私聊不进 IG", tags.hasIgTag("下次我带你去吃更好吃的吧$怎么样？"), false);
}
{
  // 第三种：评论 + 私聊
  const r = tags.splitIg("[comment:踩雷了吧]下次我带你去吃更好吃的吧$怎么样？", "$");
  check("评论切出来了", r.comments, ["踩雷了吧"]);
  check("短信留在 rest 里、分隔符原样", r.rest, "下次我带你去吃更好吃的吧$怎么样？");
}
{
  const r = tags.splitIg("[comment:一][comment:二]", "$");
  check("多条评论都收", r.comments, ["一", "二"]);
}
{
  const r = tags.splitIg("[comment:好看][image:一只猫]", "$");
  check("评论后面的图不塞进评论，落到新快拍", r.stories.length, 1);
  check("评论本身没被影响", r.comments, ["好看"]);
}

console.log("\n=== 17. stripIgTags ===");
check("标签清掉、文字留下", tags.stripIgTags("[post:配文]顺便说一句"), "顺便说一句");
check("全清就是空串", tags.stripIgTags("[story:啊][image:图]"), "");
check("没标签原样返回", tags.stripIgTags("普通一句话"), "普通一句话");
check(
  "thinking 里的不清（那本来就是要被别的地方收掉的）",
  tags.stripIgTags("<thinking>[post:x]</thinking>"),
  "<thinking>[post:x]</thinking>"
);

console.log("\n=== 18. 角色间互动的 N：首评不计、按线程算 ===");
{
  const ig = await import("../server/src/instagram.js");
  // 用户给的那个例子：A 评论帖子 → B 回 A → A 再回 B → 停
  const post = {
    comments: [
      { id: "t1", owner: "小明", text: "首评", replyTo: "" },
      { id: "t2", owner: "阿瑞", text: "回 小明", replyTo: "t1" },
      { id: "t3", owner: "小明", text: "再回 阿瑞", replyTo: "t2" },
    ],
  };
  check("首评不计，这条线程算 2 条", ig.threadReplyCount(post, "t1"), 2);
  check("maxChain=2 时已经满了", ig.canChain(post, "t1", 2), false);
  check("maxChain=3 还能再回", ig.canChain(post, "t1", 3), true);
  check("maxChain=0 表示不互动", ig.canChain(post, "t1", 0), false);

  const onlyRoot = { comments: [{ id: "t1", owner: "小明", text: "首评", replyTo: "" }] };
  check("只有首评时是 0", ig.threadReplyCount(onlyRoot, "t1"), 0);
  check("只有首评时还能回", ig.canChain(onlyRoot, "t1", 2), true);

  // 用户参与的不消耗角色间额度
  const withUser = {
    comments: [
      { id: "t1", owner: "小明", text: "首评", replyTo: "" },
      { id: "t2", owner: "user", text: "用户插话", replyTo: "t1" },
      { id: "t3", owner: "阿瑞", text: "角色回", replyTo: "t2" },
    ],
  };
  check("用户那条不算进 N", ig.threadReplyCount(withUser, "t1"), 1);

  // 按线程算，不按帖子算：两串各有自己的额度
  const twoThreads = {
    comments: [
      { id: "a1", owner: "小明", text: "串一首评", replyTo: "" },
      { id: "a2", owner: "阿瑞", text: "回", replyTo: "a1" },
      { id: "a3", owner: "小明", text: "再回", replyTo: "a2" },
      { id: "b1", owner: "Zed", text: "串二首评", replyTo: "" },
    ],
  };
  check("串一满了", ig.canChain(twoThreads, "a1", 2), false);
  check("串二不受影响", ig.canChain(twoThreads, "b1", 2), true);
  check("不存在的线程算 0", ig.threadReplyCount(twoThreads, "没有这条"), 0);
}

console.log("\n=== 19. peerAllowed：看发起方自己那份名单 ===");
{
  const ig = await import("../server/src/instagram.js");
  const cfg = {
    roles: [
      { id: "r-1", name: "小明", instagram: { enabled: true, peers: ["r-2"] } },
      { id: "r-2", name: "阿瑞", instagram: { enabled: true, peers: [] } },
      { id: "r-3", name: "Zed", instagram: { enabled: false, peers: ["r-1"] } },
    ],
  };
  const niki = cfg.roles[0];
  const charlie = cfg.roles[1];
  const zed = cfg.roles[2];
  check("小明 勾了 阿瑞 → 能互动", ig.peerAllowed(cfg, niki, "阿瑞"), true);
  check("单向就够（阿瑞 没勾 小明 也不影响上面那条）", ig.peerAllowed(cfg, charlie, "小明"), false);
  check("没开 IG 的角色不参与", ig.peerAllowed(cfg, zed, "小明"), false);
  check("勾了但对方不存在", ig.peerAllowed(cfg, niki, "不存在的人"), false);
  check("不能对用户用这个（用户不是 peer）", ig.peerAllowed(cfg, niki, "user"), false);
}

console.log("\n=== 20. 坏数据不炸、不删 ===");
const badFile = path.join(INSTAGRAM_DIR, "posts", "bad.json");
fs.writeFileSync(badFile, "{ 这不是 JSON", "utf-8");
check("读坏文件当空的", store.readPosts("bad"), []);
checkThat("坏文件还留着（用户攒的内容不能悄悄删）", fs.existsSync(badFile));

fs.writeFileSync(path.join(INSTAGRAM_DIR, "posts", "arr.json"), '"不是数组"', "utf-8");
check("内容不是数组也当空的", store.readPosts("arr"), []);

/*
 * 预设正文和解析器是两个文件，中间没有任何编译期约束 —— 正文里把标签写错一个字，
 * 模型会照着写，解析器认不出来，帖子就悄悄变成了短信正文。所以把正文里那几条
 * 示例真的喂给 splitIg 跑一遍：教的和认的必须是同一套。
 */
console.log("\n=== 21. 预设正文教的格式 = 解析器认的格式 ===");
const preset = await import("../server/src/preset.js");
const igBody = preset.DEFAULT_FORMAT_CHILDREN.instagram ?? "";

checkThat("instagram 在固定子条目里", preset.FORMAT_CHILD_KINDS.includes("instagram"));
check("它压着角色那道闸", preset.ROLE_GATED_CHILDREN.instagram, "instagram");
checkThat("正文非空", igBody.length > 0);

// 用户明确废弃了 [caption:]；[comment:] 那一轮由 igprompt.js 单独拼，不在这儿教
checkThat("正文不教 [caption:]（用户废弃的）", !/\[caption[:：]/i.test(igBody));
checkThat("正文不教 [comment:]（评论那轮单独拼提示词）", !/\[comment[:：]/i.test(igBody));

// 正文自己定的规矩：方括号里不许出现 {{sep}}。它得先管住自己的示例
const brackets = igBody.match(/[[［][^\]］]*[\]］]/g) ?? [];
checkThat(
  "正文的示例里，方括号内部没有 {{sep}}",
  brackets.every((b) => !b.includes("{{sep}}")),
  brackets.filter((b) => b.includes("{{sep}}")).join(" ")
);

// 三条「正确示例」逐条过解析器
const SEP = "\n\n";
const examples = igBody
  .split("\n")
  .filter((l) => l.trim().startsWith("- ["))
  .map((l) => l.trim().slice(2).replaceAll("{{sep}}", SEP));
checkThat(`挑出了 ${examples.length} 条示例`, examples.length === 3);

const parsed = examples.map((ex) => tags.splitIg(ex, SEP));
check(
  "示例一：一条帖子配一张图，没有多余的短信",
  [parsed[0].posts.length, parsed[0].posts[0]?.images.length, parsed[0].stories.length, parsed[0].rest],
  [1, 1, 0, ""]
);
check("示例一的配文就是方括号里那句", parsed[0].posts[0]?.caption, "下班路上的天，值了");
check(
  "示例二：一条快拍配一张图",
  [parsed[1].stories.length, parsed[1].stories[0]?.images.length, parsed[1].posts.length, parsed[1].rest],
  [1, 1, 0, ""]
);
check(
  "示例三：一条帖子两张图，外加一条真发出去的短信",
  [parsed[2].posts.length, parsed[2].posts[0]?.images.length, parsed[2].rest],
  [1, 2, "刚从书店出来，给你也带了一本"]
);
checkThat("三条示例都被 hasIgTag 认出来", examples.every((ex) => tags.hasIgTag(ex)));

console.log("\n=== 22. igprompt：段落顺序和行动指令 ===");
const igprompt = await import("../server/src/igprompt.js");

// 模板键名要和 igstore 的默认设置一一对上，少一个就等于永远读不到用户改的那份
check(
  "IG_SCENES + 三条指令 = promptTemplates 的键",
  Object.keys(store.defaultSettings().promptTemplates).sort(),
  [...igprompt.IG_SCENES, "action", "peerAction", "compose"].sort()
);
checkThat(
  "每个场景都有代码默认值",
  igprompt.IG_SCENES.every((k) => igprompt.defaultTemplate(k).length > 0)
);

const igConfig = {
  chat: { separator: "||" },
  presets: [],
  worldBooks: [],
  providers: [],
  roles: [
    {
      id: "r1",
      name: "林一",
      description: "{{char}} 是个摄影师。",
      memories: { memory: {}, memo: {}, diary: {} },
    },
  ],
  users: [{ id: "u1", name: "小满", enabled: true, scope: "global", description: "{{user}} 在念书。" }],
};
const igRole = igConfig.roles[0];
const NOW = Date.parse("2026-09-12T20:00:00Z");
const userPost = {
  id: "p1",
  owner: "user",
  caption: "下班路上的天",
  images: [{ file: "a.png", alt: "橘粉色的晚霞" }],
  createdAt: new Date(NOW - 3 * 3600e3).toISOString(),
  likes: [],
  comments: [],
};
const build = (scene, opts = {}) =>
  igprompt.buildIgPrompt(igConfig, igRole, scene, { now: NOW, templates: {}, ...opts });

const basic = await build({ kind: "userPost", owner: "user", post: userPost });
const flat = basic.messages.map((m) => m.content).join("\n");
checkThat("第一条就是 <Instagram>", basic.messages[0].content.startsWith("<Instagram>"));
checkThat(
  "最后一条是行动指令",
  basic.messages.at(-1).content.trimEnd().endsWith("别用任何旁白或动作描写。")
);
checkThat("场景排在人设前面", flat.indexOf("<Instagram>") < flat.indexOf("<Character>"));
checkThat("人设排在用户人设前面", flat.indexOf("<Character>") < flat.indexOf("<User>"));
checkThat("变量替换到位（{{char}} 没漏出去）", !flat.includes("{{char}}") && flat.includes("林一 是个摄影师"));
checkThat("分隔符换成了真符号", flat.includes("用 || 隔开") && !flat.includes("{{sep}}"));
checkThat("日记没进这一轮（用户只列了三样记忆）", !flat.includes("<日记>"));

// 上文走 filterHistory：思维链不能原样喂回去
const withHist = await build(
  { kind: "userPost", owner: "user", post: userPost },
  { history: [{ role: "user", content: "在干嘛" }, { role: "assistant", content: "<thinking>想想</thinking>刚下班" }] }
);
const histText = withHist.messages.map((m) => m.content).join("\n");
checkThat("上文夹在 <Chat_History> 里", histText.includes("<Chat_History>") && histText.includes("</Chat_History>"));
checkThat("思维链被滤掉了", !histText.includes("<thinking>") && histText.includes("刚下班"));
checkThat("没有上文时不留空标记", !flat.includes("<Chat_History>"));

/*
 * 上文为空时必须留下一条 user 消息。
 *
 * 这几条不是形状洁癖，是一次真实的 400。除了上文，igprompt 里每一段都是
 * system，所以上下文一空，mergeAdjacent 会把整份提示词并成**一条 system**，
 * 一条 user 都不剩。Gemini 系的上游把 system 当 systemInstruction 拿走，
 * contents 就空了，直接回 `contents is not specified`，整轮白打。
 *
 * 而「上文是空的」是条**正常路径**：进程刚重启、对方还没说过话的时候，
 * runIgTask 照样会被队列叫起来（它自己的日志写着「这一轮照跑，但上文是空的」）。
 * 修法是把最底下那条行动指令的 role 换成 user —— 谁把它改回无条件 system，
 * 下面第一条就会红。
 */
check("没有上文：最后一条得是 user", basic.messages.at(-1).role, "user");
checkThat("没有上文：至少留下一条 user", basic.messages.some((m) => m.role === "user"));
checkThat(
  "没有上文：user 那条就是行动指令",
  basic.messages.at(-1).content.startsWith("现在轮到你了")
);
// 有上文的正常情况一个字不动：行动指令还是并进 </Chat_History> 那条 system
check(
  "有上文：形状还是老样子",
  withHist.messages.map((m) => m.role),
  ["system", "user", "assistant", "system"]
);
checkThat(
  "有上文：行动指令并进了 </Chat_History>",
  withHist.messages.at(-1).role === "system" &&
    withHist.messages.at(-1).content.startsWith("</Chat_History>") &&
    withHist.messages.at(-1).content.includes("现在轮到你了")
);

// 预设里关掉的条目，这一轮也不产出
const offConfig = {
  ...igConfig,
  presets: [preset.makeDefaultPreset({ id: "px" })],
  roles: [{ ...igRole, presetRef: "px" }],
};
for (const e of offConfig.presets[0].entries) {
  if (e.kind === "world" || e.kind === "user") e.enabled = false;
}
const gated = await igprompt.buildIgPrompt(offConfig, offConfig.roles[0], {
  kind: "userPost",
  owner: "user",
  post: userPost,
}, { now: NOW, templates: {} });
const gatedText = gated.messages.map((m) => m.content).join("\n");
checkThat("预设关掉「用户人设」就没有 <User>", !gatedText.includes("<User>"));
checkThat("预设关掉「世界书」就没有 <World_Info>", !gatedText.includes("<World_Info>"));
checkThat("没关的那条还在", gatedText.includes("<Character>"));

// 角色间那一轮：只能评论，不能顺带发短信
const peer = await build({
  kind: "charPost",
  owner: "阿哲",
  peerName: "阿哲",
  post: { id: "p2", owner: "阿哲", caption: "搬家了", images: [], createdAt: new Date(NOW).toISOString(), likes: [], comments: [] },
});
const peerText = peer.messages.at(-1).content;
checkThat("{{对方}} 换成了对方的名字", peer.messages[0].content.includes("阿哲 刚在 Instagram"));
checkThat("角色间那轮明确禁止发短信", peerText.includes("不要发短信"));
checkThat("角色间那轮不提「三种做法」", !peerText.includes("三种做法"));
checkThat("对着用户那轮才有短信那一路", basic.messages.at(-1).content.includes("只私下给 小满 发消息"));

// 自定义模板优先于代码默认值
const custom = await build({ kind: "userPost", owner: "user", post: userPost }, {
  templates: { userPost: "{{user}} 又发疯了。" },
});
checkThat("存了自定义模板就用自定义的", custom.messages[0].content.includes("小满 又发疯了。"));

console.log("\n=== 23. igprompt：快照 ===");
const snapVars = { char: "林一", user: "小满", sep: "||" };
const ownPost = {
  id: "p3",
  owner: "林一",
  caption: "今天的片子",
  images: [{ file: "c.png", alt: "" }, { file: "d.png", alt: "巷口" }],
  visionNote: "两张街拍",
  createdAt: new Date(NOW - 26 * 3600e3).toISOString(),
  likes: ["user"],
  comments: [
    { id: "c1", owner: "林一", text: "凑合" },
    { id: "c2", owner: "user", text: "在哪拍的", replyTo: "c1" },
  ],
};
const snap = igprompt.snapshot({ kind: "userComment", post: ownPost, commentId: "c2" }, snapVars, "林一", NOW);
checkThat("自己的帖子说「你的」", snap.includes("—— 你的帖子（1 天前） ——"));
checkThat("识图结果盖过 alt", snap.includes("两张街拍") && !snap.includes("巷口"));
checkThat("自己的评论标了「（你）」", snap.includes("林一（你）：凑合"));
checkThat("回复关系摊平成「A 回复 B」", snap.includes("小满 回复 林一：在哪拍的"));
checkThat("要回的那条被标出来", /在哪拍的\s+← 你要回的就是这条/.test(snap));
checkThat("说清自己已经说过几句", snap.includes("你在这条下面已经说过 1 句了。"));

const otherSnap = igprompt.snapshot({ post: userPost }, snapVars, "林一", NOW);
checkThat("别人的帖子用名字", otherSnap.includes("—— 小满的帖子（3 小时前） ——"));
checkThat("没人评论时说清楚", otherSnap.includes("这条帖子还没有人评论。"));
checkThat("没有点赞就不提点赞", !otherSnap.includes("点赞"));

const storySnap = igprompt.snapshot(
  {
    story: {
      id: "s1",
      owner: "user",
      caption: "",
      image: { file: "b.png", alt: "地铁车窗" },
      createdAt: new Date(NOW - 20 * 60e3).toISOString(),
      likes: [],
      replies: [],
    },
  },
  snapVars,
  "林一",
  NOW
);
checkThat("快拍认 image / replies 这两个字段名", storySnap.includes("快拍（20 分钟前）") && storySnap.includes("地铁车窗"));
checkThat("没配文说「（没写字）」", storySnap.includes("配文：（没写字）"));
check("没东西可看时快照是空的", igprompt.snapshot({ kind: "userPost" }, snapVars, "林一", NOW), "");

console.log("\n=== 24. igprompt 教的格式 = 解析器认的格式 ===");
// 和第 21 节同一个道理：指令里写的示例，得真能被 splitIg 解出来
for (const key of ["action", "peerAction", "compose"]) {
  const body = igprompt.defaultTemplate(key);
  const inside = body.match(/[[［][^\]］]*[\]］]/g) ?? [];
  checkThat(
    `${key}：示例的方括号里没有 {{sep}}`,
    inside.every((b) => !b.includes("{{sep}}")),
    inside.filter((b) => b.includes("{{sep}}")).join(" ")
  );
}

const actionParsed = tags.splitIg("[comment:哈哈这张好看]", SEP);
check("行动指令教的 [comment:] 真能解出来", actionParsed.comments, ["哈哈这张好看"]);
check("评论不会被当成短信", actionParsed.rest, "");
const bothParsed = tags.splitIg(`[comment:好看]${SEP}你在哪拍的`, SEP);
check("评论 + 短信两样都在", [bothParsed.comments, bothParsed.rest], [["好看"], "你在哪拍的"]);

// compose 那条教的三种写法
const composeBody = igprompt.defaultTemplate("compose");
checkThat("compose 教了 [post:]", /\[post[:：]/.test(composeBody));
checkThat("compose 教了 [story:]", /\[story[:：]/.test(composeBody));
checkThat("compose 说了光写 [image:] 是发快拍", composeBody.includes("没有文字的快拍"));
const bare = tags.splitIg("[image:一只橘猫趴在窗台]", SEP);
check(
  "光一个 [image:] 解出来确实是无字快拍",
  [bare.stories.length, bare.stories[0]?.caption, bare.stories[0]?.images.length, bare.posts.length],
  [1, "", 1, 0]
);
checkThat("compose 不教 [comment:]（那是评论轮的事）", !/\[comment[:：]/i.test(composeBody));

/*
 * ── 互动链路（igrun.js）──
 *
 * 队列是**落盘**的，前面第 10 节还留了一条没到点的任务在里面。凡是要数
 * 「排了几条」的地方先 writeQueue([]) 清干净，不然会把它一起数进去。
 *
 * 骰子全靠注入：hit() 是 `roll() * 100 < chance`，所以 `() => 0` 必中、
 * `() => 0.99` 必不中（这儿的概率都 ≤ 99）。一个真随机数都不用。
 */
const run = await import("../server/src/igrun.js");
const TQ = Date.parse("2026-09-12T20:00:00Z");
const zero = () => 0;
const miss = () => 0.99;

console.log("\n=== 25. delayFor：在等待窗口里挑一刻 ===");
{
  const win = (min, max) => ({ instagram: { replyWindow: { minMinutes: min, maxMinutes: max } } });
  check("roll=0 落在下限", run.delayFor(win(30, 120), TQ, zero), TQ + 30 * 60000);
  check("roll=1 落在上限", run.delayFor(win(30, 120), TQ, () => 1), TQ + 120 * 60000);
  check("roll=0.5 落在正中间", run.delayFor(win(30, 120), TQ, () => 0.5), TQ + 75 * 60000);
  // 字段名写错过一次（min/max ↔ minMinutes/maxMinutes）。错了不会报任何错，
  // 只是用户设的窗口静悄悄失效、永远按 30–120 走 —— 所以单独钉一条
  check("读的是 minMinutes / maxMinutes", run.delayFor(win(5, 5), TQ, () => 0.7), TQ + 5 * 60000);
  check("没配就是默认的 30–120", run.delayFor({}, TQ, zero), TQ + 30 * 60000);
  check("上下限填反了也认", run.delayFor(win(90, 10), TQ, zero), TQ + 10 * 60000);
  check("填 0 当没填", run.delayFor(win(0, 0), TQ, () => 1), TQ + 120 * 60000);
}

console.log("\n=== 26. audienceFor / schedulePublish：谁会刷到 ===");
// 白名单是单向的：阿瑞 勾了 小明，小明 也勾了 阿瑞；Momo 谁都没勾；Zed 关着 IG
const netCfg = {
  roles: [
    { id: "r-1", name: "小明", instagram: { enabled: true, peers: ["r-2"], maxChain: 2, replyWindow: { minMinutes: 10, maxMinutes: 10 } } },
    { id: "r-2", name: "阿瑞", instagram: { enabled: true, peers: ["r-1", "r-3"], maxChain: 2, replyWindow: { minMinutes: 10, maxMinutes: 10 } } },
    { id: "r-3", name: "Zed", instagram: { enabled: false, peers: ["r-1"], maxChain: 2 } },
    { id: "r-4", name: "Momo", instagram: { enabled: true, peers: [], maxChain: 2, replyWindow: { minMinutes: 10, maxMinutes: 10 } } },
  ],
};
const who = (list) => list.map((r) => r.name);

check("用户发的，所有开了 IG 的角色都刷得到", who(run.audienceFor(netCfg, "user")), ["小明", "阿瑞", "Momo"]);
check("关了 IG 的不在受众里", who(run.audienceFor(netCfg, "user")).includes("Zed"), false);
check("小明 发的，只有勾了 小明 的人刷得到", who(run.audienceFor(netCfg, "小明")), ["阿瑞"]);
check("阿瑞 发的同理", who(run.audienceFor(netCfg, "阿瑞")), ["小明"]);
check("Momo 谁都没勾，可别人也没勾它 —— 它发的没人来", who(run.audienceFor(netCfg, "Momo")), []);
check("自己不会刷到自己", who(run.audienceFor(netCfg, "阿瑞")).includes("阿瑞"), false);

store.writeQueue([]);
const pubTasks = run.schedulePublish(netCfg, "user", { id: "p-u" }, { isStory: false, now: TQ, roll: zero });
check("用户发帖 → 三个角色各排一条", pubTasks.length, 3);
check("kind 都是 userPost", [...new Set(pubTasks.map((t) => t.kind))], ["userPost"]);
check("postId 填上、storyId 空着", [pubTasks[0].postId, pubTasks[0].storyId], ["p-u", ""]);
check("到点时间按各自的等待窗口算", pubTasks[0].at, TQ + 10 * 60000);
check("确实落盘了", store.readQueue().length, 3);

store.writeQueue([]);
const stTasks = run.schedulePublish(netCfg, "user", { id: "s-u" }, { isStory: true, now: TQ, roll: zero });
check("用户发快拍照样排", stTasks.map((t) => t.kind), ["userStory", "userStory", "userStory"]);
check("快拍填 storyId、postId 空着", [stTasks[0].storyId, stTasks[0].postId], ["s-u", ""]);

store.writeQueue([]);
// 场景模板里没有 charStory 这一条，角色的快拍不惊动任何人
check("角色的快拍谁都不叫", run.schedulePublish(netCfg, "小明", { id: "s-n" }, { isStory: true, now: TQ, roll: zero }), []);
check(
  "角色的帖子只叫勾了它的人",
  run.schedulePublish(netCfg, "小明", { id: "p-n" }, { isStory: false, now: TQ, roll: zero }).map((t) => [t.roleId, t.kind]),
  [["r-2", "charPost"]]
);
check("没 id 的东西不排队", run.schedulePublish(netCfg, "user", {}, { now: TQ }), []);
check("排完队列里只剩角色那条", store.readQueue().length, 1);

console.log("\n=== 27. scheduleComment：四道闸 ===");
{
  const post = (owner, comments) => ({ id: `p-${owner}`, owner, comments });
  store.writeQueue([]);

  const a = post("小明", [{ id: "c1", owner: "user", text: "好看", replyTo: "" }]);
  const aT = run.scheduleComment(netCfg, "小明", a, a.comments[0], { now: TQ, roll: zero });
  check("用户评论角色的帖子 → 帖主被叫起来", [aT.length, aT[0]?.roleId, aT[0]?.kind], [1, "r-1", "userComment"]);
  check("带上是哪条评论", aT[0]?.commentId, "c1");

  const b = post("小明", [{ id: "c1", owner: "小明", text: "自己说两句", replyTo: "" }]);
  check("自言自语不触发", run.scheduleComment(netCfg, "小明", b, b.comments[0], { now: TQ }), []);

  // 要回的是用户，用户不是模型 —— 回不回是他自己的事
  const c = post("user", [{ id: "c1", owner: "小明", text: "好看", replyTo: "" }]);
  check("冲着用户说的那条不排队", run.scheduleComment(netCfg, "user", c, c.comments[0], { now: TQ }), []);

  const d = post("小明", [
    { id: "c1", owner: "阿瑞", text: "首评", replyTo: "" },
    { id: "c2", owner: "小明", text: "回 阿瑞", replyTo: "c1" },
  ]);
  const dT = run.scheduleComment(netCfg, "小明", d, d.comments[1], { now: TQ, roll: zero });
  check("角色回角色 → 对面被叫起来", [dT.length, dT[0]?.roleId, dT[0]?.kind], [1, "r-2", "charComment"]);

  // 首评不计：c2、c3 是两条，帖主 小明 的 maxChain=2，到这儿打住
  const e = post("小明", [
    { id: "c1", owner: "阿瑞", text: "首评", replyTo: "" },
    { id: "c2", owner: "小明", text: "回", replyTo: "c1" },
    { id: "c3", owner: "阿瑞", text: "再回", replyTo: "c2" },
  ]);
  check("这条线程聊够了就打住", run.scheduleComment(netCfg, "小明", e, e.comments[2], { now: TQ }), []);

  // 小明 的名单里只有 阿瑞，Momo 说什么它都不接
  const f = post("Momo", [
    { id: "c1", owner: "小明", text: "首评", replyTo: "" },
    { id: "c2", owner: "Momo", text: "回 小明", replyTo: "c1" },
  ]);
  check("没勾对方就不接话", run.scheduleComment(netCfg, "Momo", f, f.comments[1], { now: TQ }), []);

  const g = { id: "s-n", owner: "小明", replies: [{ id: "sr1", owner: "user", text: "哈哈", replyTo: "" }] };
  const gT = run.scheduleComment(netCfg, "小明", g, g.replies[0], { isStory: true, now: TQ, roll: zero });
  check("用户回快拍照样叫人", [gT.length, gT[0]?.kind, gT[0]?.storyId, gT[0]?.postId], [1, "userComment", "s-n", ""]);

  const h = { id: "s-n2", owner: "小明", replies: [{ id: "sr1", owner: "阿瑞", text: "哟", replyTo: "" }] };
  check("角色之间不在快拍底下接话（那儿数不出线程）", run.scheduleComment(netCfg, "小明", h, h.replies[0], { isStory: true, now: TQ }), []);

  check("没 id 的评论不排队", run.scheduleComment(netCfg, "小明", a, { owner: "user", text: "x" }, { now: TQ }), []);
  check("一共只排了三条", store.readQueue().length, 3);

  /*
   * 真 IG 白名单里的外人（owner 是白名单里给它起的显示名，不是本地任何角色）。
   *
   * 不给 outsider 的话这条**永远排不出来**：peerAllowed 查的是「目标角色的
   * peers 里有没有行动方这个角色」，而外人不是角色 —— 查出来一律 false，
   * 等于白名单形同虚设。这几条断言就是钉住那个洞。
   */
  store.writeQueue([]);
  const out = post("小明", [{ id: "c1", owner: "小明粉丝", text: "好看", replyTo: "" }]);
  check("不给 outsider → 排不出来（peerAllowed 那道闸拦下）",
    run.scheduleComment(netCfg, "小明", out, out.comments[0], { now: TQ, roll: zero }), []);
  const outT = run.scheduleComment(netCfg, "小明", out, out.comments[0], { now: TQ, roll: zero, outsider: true });
  check("给了 outsider → 帖主被叫起来，算 userComment",
    [outT.length, outT[0]?.roleId, outT[0]?.kind], [1, "r-1", "userComment"]);

  // 传错了也不能让角色绕过 peers：Momo 没被 小明 勾，套个 outsider 照样不行
  const fake = post("小明", [{ id: "c1", owner: "Momo", text: "好看", replyTo: "" }]);
  check("outsider 骗不过 peers 名单（说话的是本地角色就照老规矩查）",
    run.scheduleComment(netCfg, "小明", fake, fake.comments[0], { now: TQ, roll: zero, outsider: true }), []);

  // 线程上限对外人不生效 —— 那是防角色间永动机的，真人一句一句手打没这问题
  const deep = post("小明", [
    { id: "c1", owner: "小明粉丝", text: "首评", replyTo: "" },
    { id: "c2", owner: "小明", text: "回", replyTo: "c1" },
    { id: "c3", owner: "小明粉丝", text: "再回", replyTo: "c2" },
  ]);
  check("聊久了的外人照样能回（真人不是永动机）",
    run.scheduleComment(netCfg, "小明", deep, deep.comments[2], { now: TQ, roll: zero, outsider: true }).length, 1);

  // 外人回的是别人说的话就不该惊动帖主（自言自语那道闸照旧）
  const toUser = post("小明", [
    { id: "c1", owner: "user", text: "你在哪", replyTo: "" },
    { id: "c2", owner: "小明粉丝", text: "我知道", replyTo: "c1" },
  ]);
  check("外人回用户那条 → 不排队（回不回是用户自己的事）",
    run.scheduleComment(netCfg, "小明", toUser, toUser.comments[1], { now: TQ, roll: zero, outsider: true }), []);
}

console.log("\n=== 28. 新冒出来的评论靠 id 认（路由按这个排队）===");
{
  // index.js 的 igNewEntries 就吃这条：评论 id 是**落盘那一步**才发的，
  // 所以前端整个数组覆盖着 PUT 回来，也分得清哪条是新的、哪条是编辑过的
  const base = store.addPost("user", { caption: "认 id 用", comments: [{ owner: "user", text: "第一条" }] });
  checkThat("落盘那一步就发了 id", Boolean(base.comments[0].id));
  const after = store.updatePost("user", base.id, {
    comments: [...base.comments, { owner: "小明", text: "后来的" }],
  });
  const had = new Set(base.comments.map((c) => c.id));
  check("整个数组写回来也认得出哪条是新的", after.comments.filter((c) => !had.has(c.id)).map((c) => c.text), ["后来的"]);
  check("老的那条 id 没变（变了就每次都像全是新的）", after.comments[0].id, base.comments[0].id);
}

console.log("\n=== 29. igRouteFor：[image:] 归私聊还是归 IG ===");
{
  const on = { instagram: { enabled: true } };
  const onDraw = { instagram: { enabled: true }, imageGen: { enabled: true } };
  check("没开 IG 一律不走", run.igRouteFor({ instagram: { enabled: false } }, "[post:今天天气好]"), false);
  check("[post:] 明确是 IG 的事", run.igRouteFor(on, "[post:今天天气好]"), true);
  check("[story:] 同理", run.igRouteFor(on, "[story:路上]"), true);
  check("[comment:] 同理", run.igRouteFor(on, "[comment:好看]"), true);
  // 这条是保命的：开了生图的角色发张自拍，还是老的私聊发图，一个字不动
  check("只有 [image:] 且开着生图 → 还是私聊发图", run.igRouteFor(onDraw, "[image:一只橘猫]"), false);
  check("只有 [image:] 且没开生图 → 当无字快拍发到 IG", run.igRouteFor(on, "[image:一只橘猫]"), true);
  check("[post:] 带图，开着生图也走 IG", run.igRouteFor(onDraw, "[post:出门][image:一只橘猫]"), true);
  check("什么标签都没有就是纯私聊", run.igRouteFor(on, "在干嘛"), false);
}

console.log("\n=== 30. publishIgTags / publishLines：私聊里顺手发的那条 ===");
{
  // providers 里没有任何 categories 含 image 的模型 → resolveImageEndpoint 返回
  // null → renderImage 一律返回空串，全部走「文字图」降级。整节不联网
  const pubCfg = { chat: { separator: "$" }, providers: [], roles: [] };
  const pubRole = { id: "r-p", name: "发布测试", instagram: { enabled: true } };
  store.writeQueue([]);

  const got = await run.publishIgTags(pubCfg, pubRole, tags.splitIg("[post:今天的天]$[image:橘粉色的晚霞]", "$"));
  check("帖子落盘了", [got.posts.length, got.stories.length], [1, 0]);
  check("配文里的分隔符换成了逗号", got.posts[0].caption, "今天的天");
  check("图没生成出来，但 alt 留着（前端画文字图）", got.posts[0].images, [{ file: "", alt: "橘粉色的晚霞" }]);
  check("真写进了这个角色的帖子里", store.readPosts("发布测试").length, 1);

  const st = await run.publishIgTags(pubCfg, pubRole, tags.splitIg("[image:地铁车窗]", "$"));
  check("光一张图 → 一条无字快拍", [st.stories.length, st.stories[0]?.caption, st.stories[0]?.image.alt], [1, "", "地铁车窗"]);

  const empty = await run.publishIgTags(pubCfg, pubRole, { posts: [{ caption: "  ", images: [] }], stories: [] });
  check("空的不存", [empty.posts.length, store.readPosts("发布测试").length], [0, 1]);
  // 私聊轮里写 [comment:] 没有对应的帖子，只能丢掉（会记一条日志）
  const orphan = await run.publishIgTags(pubCfg, pubRole, { posts: [], stories: [], comments: ["好看"] });
  check("落单的 [comment:] 丢掉", [orphan.posts.length, orphan.stories.length], [0, 0]);
  check("没名字的角色什么都不发", await run.publishIgTags(pubCfg, { id: "x" }, tags.splitIg("[post:x]", "$")), { posts: [], stories: [] });

  check(
    "publishLines 把帖子写成一行",
    run.publishLines({ posts: [{ caption: "今天的天", images: [{ file: "", alt: "橘粉色的晚霞" }] }] }),
    ["[Instagram 帖子] 今天的天 （配图：橘粉色的晚霞）"]
  );
  check(
    "快拍读的是 image.alt 那个字段名",
    run.publishLines({ stories: [{ caption: "", image: { file: "", alt: "地铁车窗" } }] }),
    ["[Instagram 快拍] （配图：地铁车窗）"]
  );
  check("什么都没有时不留空行", run.publishLines({ posts: [{ caption: "", images: [] }] }), ["[Instagram 帖子] （没配文字）"]);
  check("没发东西就没有行", run.publishLines({}), []);
}

console.log("\n=== 31. runIgTask：掷骰子、落盘、交给 commit ===");
// 唯一要联网的一节，所以起一个假的 OpenAI 兼容服务在 127.0.0.1 的随机端口上。
// **不 import server/src/index.js** —— 那个文件一 import 就 listen 8787 / 6873，
// 会和用户正在跑的后端撞port
const http = await import("node:http");
let nextReply = "";
const llmHits = [];
const fakeLlm = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    llmHits.push({ url: req.url, body });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: nextReply } }] }));
  });
});
await new Promise((done) => fakeLlm.listen(0, "127.0.0.1", done));
const llmPort = fakeLlm.address().port;

{
  // 第 12 节把 userPost 的模板改成了「自定义」，这儿改回代码默认，免得
  // 这一节的断言依赖上一节留下的状态
  store.writeSettings({
    storyHours: 24,
    promptTemplates: { userPost: "", userStory: "", userComment: "", charPost: "", charComment: "" },
  });
  store.writeQueue([]);

  const chatModel = { provider: "pv", modelId: "m1" };
  const igOf = (peers, recordPeer) => ({
    enabled: true,
    peers,
    maxChain: 2,
    likeChance: 45,
    replyChance: 60,
    recordPeer,
    replyWindow: { minMinutes: 10, maxMinutes: 10 },
  });
  const taskCfg = {
    chat: { separator: "$" },
    presets: [],
    worldBooks: [],
    providers: [
      {
        id: "pv",
        name: "假服务商",
        url: `http://127.0.0.1:${llmPort}/v1`,
        keys: ["k"],
        // 没有 categories 含 image 的条目 → 生图一律降级成文字图，不联网
        models: [{ id: "m1", model: "fake", enabled: true, categories: ["chat"] }],
      },
    ],
    roles: [
      { id: "r-1", name: "小明", description: "{{char}} 是个摄影师。", chatModel, memories: { memory: {}, memo: {}, diary: {} }, instagram: igOf(["r-2"], true) },
      { id: "r-2", name: "阿瑞", description: "{{char}} 开咖啡店。", chatModel, memories: { memory: {}, memo: {}, diary: {} }, instagram: igOf(["r-1"], false) },
    ],
    users: [{ id: "u1", name: "小满", enabled: true, scope: "global", description: "{{user}} 在念书。" }],
  };
  const committed = [];
  const session = async () => ({ history: [], commit: (o) => { committed.push(o); } });
  const doTask = (task, opts) => run.runIgTask(taskCfg, { id: "q-x", chain: 0, postOwner: "", postId: "", storyId: "", commentId: "", ...task }, { now: TQ, session, ...opts });

  // ── 到点了但没事可做的几种 ──
  const gone = await doTask({ roleId: "r-9", kind: "userPost" }, { roll: zero });
  check("角色没了", [gone.action, gone.reason], ["none", "这个角色没了，或者 Instagram 已经关掉"]);
  const off = await run.runIgTask(
    { ...taskCfg, roles: [{ ...taskCfg.roles[0], instagram: { ...taskCfg.roles[0].instagram, enabled: false } }] },
    { id: "q-x", roleId: "r-1", kind: "userPost", postOwner: "user", postId: "p-1" },
    { now: TQ, session, roll: zero }
  );
  check("IG 已经关掉", off.action, "none");
  const deleted = await doTask({ roleId: "r-1", kind: "userPost", postOwner: "user", postId: "p-没有这条" }, { roll: zero });
  check("内容被删了", [deleted.action, deleted.reason], ["none", "那条内容已经被删了"]);

  const oldStory = store.addStory("user", { caption: "48 小时前", createdAt: new Date(TQ - 48 * 3600e3).toISOString() });
  const stale = await doTask({ roleId: "r-1", kind: "userStory", postOwner: "user", storyId: oldStory.id }, { roll: zero });
  check("快拍过期了", [stale.action, stale.reason], ["none", "快拍已经过期了"]);
  check("这四种都没打模型", llmHits.length, 0);

  // ── 中了点赞就到此为止，不打模型 ──
  const liked = store.addPost("user", { caption: "点赞用", createdAt: new Date(TQ - 3600e3).toISOString() });
  const likeOut = await doTask({ roleId: "r-1", kind: "userPost", postOwner: "user", postId: liked.id }, { roll: zero });
  check("掷中了就只点赞", [likeOut.action, likeOut.comment, likeOut.dm], ["like", "", ""]);
  check("赞落盘了", store.readPosts("user").find((p) => p.id === liked.id)?.likes, ["小明"]);
  check("点赞不打模型", llmHits.length, 0);
  check("用户的帖子被赞了要进爱心页", [store.readActivity()[0].kind, store.readActivity()[0].actor], ["like", "小明"]);
  check("点赞不惊动私聊", committed.length, 0);

  // ── 用户来评论，按概率这次不回 ──
  const skipped = store.addPost("小明", {
    caption: "不回用",
    createdAt: new Date(TQ - 3600e3).toISOString(),
    comments: [{ id: "c-u", owner: "user", text: "在哪拍的" }],
  });
  const noReply = await doTask({ roleId: "r-1", kind: "userComment", postOwner: "小明", postId: skipped.id, commentId: "c-u" }, { roll: miss });
  check("没中就当没看见", [noReply.action, noReply.reason], ["none", "按概率这次不回"]);
  const ghost = await doTask({ roleId: "r-1", kind: "userComment", postOwner: "小明", postId: skipped.id, commentId: "c-没有这条" }, { roll: zero });
  check("评论被删了", [ghost.action, ghost.reason], ["none", "那条评论已经被删了"]);
  check("到这儿还是一次模型都没打", llmHits.length, 0);

  // ── 模型这一轮：评论 + 私聊短信 ──
  const mine = store.addPost("user", { caption: "模型用", createdAt: new Date(TQ - 3600e3).toISOString() });
  const actsBefore = store.readActivity().length;
  nextReply = "[comment:这张好看]$晚点打给你";
  const out = await doTask({ roleId: "r-1", kind: "userPost", postOwner: "user", postId: mine.id }, { roll: miss });
  check("打了一次模型", llmHits.length, 1);
  check("评论和短信各归各的", [out.action, out.comment, out.dm], ["comment", "这张好看", "$晚点打给你"]);
  // dm 里那个打头的分隔符是有意留着的：rest 原样保留分隔符交给私聊链路切气泡，
  // 切出来的空气泡在那边会被丢掉
  check("上下文里替代「对方发了条消息」的那句", out.mark, "[Instagram] 小满 发了一条新帖子，你刷到了");
  check("给待总结用的那行", out.commentLine, "[Instagram 评论] 这张好看");
  check("对用户的互动一律记上下文", out.record, true);
  const landed = store.readPosts("user").find((p) => p.id === mine.id)?.comments ?? [];
  check("评论落到帖子上了", landed.map((c) => [c.owner, c.text, c.replyTo]), [["小明", "这张好看", ""]]);
  check("commentId 是落盘后那条的 id", out.commentId, landed[0].id);
  check("进了爱心页", [store.readActivity().length - actsBefore, store.readActivity()[0].kind, store.readActivity()[0].text], [1, "comment", "这张好看"]);
  check("交给 commit 去写上下文 / 发短信", [committed.length, committed[0]?.comment], [1, "这张好看"]);
  check("回用户的帖子不会再排队（要不要回是用户的事）", store.readQueue().length, 0);

  // ── 角色对角色：不发短信，但要记上下文，并且可能把对面叫起来 ──
  const nikisPost = store.addPost("小明", {
    caption: "角色间用",
    createdAt: new Date(TQ - 3600e3).toISOString(),
    comments: [{ id: "c-ch", owner: "阿瑞", text: "这组绝了" }],
  });
  const actsBefore2 = store.readActivity().length;
  nextReply = "[comment:恭喜]$这段不该发出去";
  const peerOut = await doTask({ roleId: "r-1", kind: "charComment", postOwner: "小明", postId: nikisPost.id, commentId: "c-ch" }, { roll: zero });
  check("评论发了，短信按规矩不发", [peerOut.action, peerOut.comment, peerOut.dm], ["comment", "恭喜", ""]);
  check("mark 里引了对方那句", peerOut.mark, "[Instagram] 阿瑞 在 Instagram 上跟你说：这组绝了");
  check("recordPeer 开着 → 记上下文", peerOut.record, true);
  check("commit 被叫了", committed.length, 2);
  check("角色之间的来回不进爱心页", store.readActivity().length, actsBefore2);
  check("把对面叫起来了", store.readQueue().map((t) => [t.roleId, t.kind, t.chain]), [["r-2", "charComment", 1]]);

  // 同一件事换成 recordPeer 关着的 阿瑞
  store.writeQueue([]);
  const charliesPost = store.addPost("阿瑞", {
    caption: "不记上下文用",
    createdAt: new Date(TQ - 3600e3).toISOString(),
    comments: [{ id: "c-nk", owner: "小明", text: "什么时候开的" }],
  });
  nextReply = "[comment:上周]";
  const quiet = await doTask({ roleId: "r-2", kind: "charComment", postOwner: "阿瑞", postId: charliesPost.id, commentId: "c-nk" }, { roll: zero });
  check("IG 上照样留痕", [quiet.action, quiet.comment], ["comment", "上周"]);
  check("recordPeer 关着 → 不记上下文", quiet.record, false);
  check("commit 没被叫（用户那边一个字都看不见）", committed.length, 2);
  check("评论还是落盘了", store.readPosts("阿瑞").find((p) => p.id === charliesPost.id)?.comments.length, 2);

  // ── 线程聊够了 / 模型什么都没说 ──
  const full = store.addPost("小明", {
    caption: "聊够了用",
    createdAt: new Date(TQ - 3600e3).toISOString(),
    comments: [
      { id: "f1", owner: "阿瑞", text: "首评" },
      { id: "f2", owner: "小明", text: "回", replyTo: "f1" },
      { id: "f3", owner: "阿瑞", text: "再回", replyTo: "f2" },
    ],
  });
  const capped = await doTask({ roleId: "r-1", kind: "charComment", postOwner: "小明", postId: full.id, commentId: "f3" }, { roll: zero });
  check("到点再算一次线程上限", [capped.action, capped.reason], ["none", "这条线程已经聊够了"]);

  const mute = store.addPost("user", { caption: "闭嘴用", createdAt: new Date(TQ - 3600e3).toISOString() });
  nextReply = "   ";
  const said = await doTask({ roleId: "r-1", kind: "userPost", postOwner: "user", postId: mute.id }, { roll: miss });
  check("模型什么都没说就当没发生", [said.action, said.reason], ["none", "模型这一轮什么都没说"]);
  check("评论轮里冒出来的 [post:] 不照做", await (async () => {
    nextReply = "[post:我也发一条][comment:好看]";
    const o = await doTask({ roleId: "r-1", kind: "userPost", postOwner: "user", postId: mute.id }, { roll: miss });
    return [o.comment, store.readPosts("小明").length];
  })(), ["好看", 3]);
}

console.log("\n=== 32. igComposeNote：主动消息那一轮缀的发帖说明 ===");
/*
 * 这段是**缀在主动消息提示词末尾**的，不走 buildIgPrompt —— 角色想发条动态
 * 和角色想找人说话本来就是一件事的两种出口，共用一套等待窗口和勿扰时段。
 * 所以这里只验「给不给这个选项」和「变量替没替」，别的归 imessage.js 管。
 */
const composeCfg = {
  chat: { separator: "$" },
  users: [{ id: "u-1", name: "阿岚", enabled: true, scope: "global", roleRefs: [] }],
  roles: netCfg.roles,
};
const noteRole = (instagram) => ({ id: "r-9", name: "小明", instagram });

check("没开 IG → 一个字都不给", run.igComposeNote(composeCfg, noteRole({ enabled: false, autoPublish: true })), "");
check("开了 IG 但没开主动发布 → 还是不给", run.igComposeNote(composeCfg, noteRole({ enabled: true, autoPublish: false })), "");
check("instagram 整个缺失也不炸", run.igComposeNote(composeCfg, { id: "r-9", name: "小明" }), "");

const note = run.igComposeNote(composeCfg, noteRole({ enabled: true, autoPublish: true }));
check("两道闸都开了才给", note.length > 0, true);
check("三种格式都写进去了", [note.includes("[post:"), note.includes("[story:"), note.includes("[image:")].join(), "true,true,true");
check("{{sep}} 换成真的分隔符", note.includes("方括号**里面**不能出现 $"), true);
check("{{char}} 换成角色名", note.includes("按 小明 平时打字的样子写"), true);
check("{{user}} 换成用户名", note.includes("不是发给 阿岚 的私信"), true);
check("没有漏网的 {{…}}", /\{\{/.test(note), false);

check(
  "自定义模板照用",
  run.igComposeNote(composeCfg, noteRole({ enabled: true, autoPublish: true }), {
    templates: { compose: "  {{char}} 现在想发个 {{user}} 看的东西  " },
  }),
  "小明 现在想发个 阿岚 看的东西"
);
check(
  "模板存空串 = 用代码默认值",
  run.igComposeNote(composeCfg, noteRole({ enabled: true, autoPublish: true }), { templates: { compose: "   " } }),
  note
);
check(
  "不传 templates 就从 settings 里读",
  run.igComposeNote(composeCfg, noteRole({ enabled: true, autoPublish: true })),
  note
);

// 没有可用用户的时候退回 applyVars 的兜底词，不该冒出空白
check(
  "没配用户 → {{user}} 退回「用户」",
  run.igComposeNote({ chat: { separator: "$" }, roles: [] }, noteRole({ enabled: true, autoPublish: true })).includes("不是发给 用户 的私信"),
  true
);

fakeLlm.closeAllConnections?.();
fakeLlm.close();

/* ================================================================== */
/* 真 IG 那一摊                                                        */
/* ================================================================== */

/*
 * 这几节**一个字节都不出网**：验的全是纯函数（比例裁剪、勿扰、闸门、脱敏）和
 * 本地文件读写。真正要联网的那几个（bindAccount / publishMedia / pollOnce）
 * 在这儿不碰 —— 它们要一个真 token，而验证它们的唯一办法是真发一条帖子，
 * 那玩意儿删不掉。
 */

console.log("\n=== 33. accounts.json：凭据只落在这儿 ===");
const accts = await import("../server/src/igaccounts.js");

check("默认轮询 3 小时（用户定的）", accts.defaultSettings().intervalHours, 3);
check("默认勿扰 23:00–09:00（用户定的）", [
  accts.defaultSettings().dnd.enabled,
  accts.defaultSettings().dnd.start,
  accts.defaultSettings().dnd.end,
], [true, "23:00", "09:00"]);
check("白名单默认空 = 谁都不理", accts.defaultSettings().allowFrom, []);
check("默认不同步用户自己的号（用户定的）", accts.defaultSettings().syncUser, false);
check("图床默认 cloudinary", accts.defaultSettings().imageHost.provider, "cloudinary");

accts.writeAccount("小明", { token: "IGQ-fake", userId: "1789", username: "@NiKi_Real" });
check("绑完读回来", accts.readAccount("小明").username, "niki_real");
check("用户名规范化：去 @ 转小写", accts.normalizeUsername(" @Foo.Bar_1 "), "foo.bar_1");
check("用户名剔非法字符", accts.normalizeUsername("中文abc!!"), "abc");
check("没绑过的角色给默认值而不是 null", accts.readAccount("Zed").token, "");
check("token 清空 = 整条删掉", accts.writeAccount("小明", { token: "" }), null);
checkThat("删完 accounts 里就没这个键了", !accts.readAccounts().accounts.小明);

accts.writeAccount("小明", { token: "IGQ-fake", userId: "1789", username: "niki_real" });
accts.writeRealSettings({ intervalHours: 6 });
check("改间隔不动图床", accts.readRealSettings().imageHost.cloudName, "");
accts.writeRealSettings({ imageHost: { cloudName: "demo" } });
check("图床浅合并：只传 cloudName 不抹 key", [
  accts.readRealSettings().imageHost.cloudName,
  accts.readRealSettings().intervalHours,
], ["demo", 6]);
accts.writeRealSettings({ dnd: { enabled: false } });
check("dnd 浅合并：只传 enabled 不抹时间", [
  accts.readRealSettings().dnd.enabled,
  accts.readRealSettings().dnd.start,
], [false, "23:00"]);
check("间隔上限一周", accts.writeRealSettings({ intervalHours: 999 }).intervalHours, 168);
check("间隔可以是 0（= 不轮询）", accts.writeRealSettings({ intervalHours: 0 }).intervalHours, 0);
/*
 * 白名单：一条 { name, username }。名字是**给模型看的**那个（用户的原话：
 * 「不带用户名（太长），就显示 小明 给 LLM 就可以了」），用户名只用来对上是谁。
 */
check(
  "白名单：名字 + 用户名分开存",
  accts.writeRealSettings({
    allowFrom: [{ name: "小明", username: "@MyIgAccount " }],
  }).allowFrom,
  [{ name: "小明", username: "myigaccount" }]
);
check(
  "白名单按用户名去重（留第一条，那条的名字说话）",
  accts.writeRealSettings({
    allowFrom: [
      { name: "小明", username: "aki" },
      { name: "又是他", username: "@Aki" },
    ],
  }).allowFrom,
  [{ name: "小明", username: "aki" }]
);
check(
  "用户名剔成空的那条整条丢掉（名字再好看也没用）",
  accts.writeRealSettings({ allowFrom: [{ name: "小明", username: "中文" }] }).allowFrom,
  []
);
check(
  "名字可以是中文 / emoji，只卡长度",
  accts.writeRealSettings({ allowFrom: [{ name: "小满 🌾", username: "man" }] }).allowFrom,
  [{ name: "小满 🌾", username: "man" }]
);
// 老文件里存的是一串裸用户名，读回来不能让用户重填一遍
check(
  "老形态（裸字符串）自动迁移成没名字的条目",
  accts.writeRealSettings({ allowFrom: ["@Aki", "aki", "小明"] }).allowFrom,
  [{ name: "", username: "aki" }]
);
check("名字没填就返回空串", accts.allowLabelFor("aki", accts.readRealSettings()), "");
accts.writeRealSettings({ allowFrom: [{ name: "小明", username: "aki" }] });
check("查显示名", accts.allowLabelFor("@AKI", accts.readRealSettings()), "小明");
check("不在名单里的查不到", accts.allowLabelFor("stranger", accts.readRealSettings()), "");
check("空用户名查不到", accts.allowLabelFor("", accts.readRealSettings()), "");

checkThat(
  "accounts.json 权限收到 0600（Windows 上跳过）",
  process.platform === "win32" ||
    (fs.statSync(path.join(INSTAGRAM_DIR, "accounts.json")).mode & 0o777) === 0o600
);

console.log("\n=== 34. inDnd：跨零点 ===");
const at = (h, m = 0) => new Date(2026, 0, 15, h, m).getTime();
const dnd = { enabled: true, start: "23:00", end: "09:00" };
check("23:30 在里面", accts.inDnd({ dnd }, at(23, 30)), true);
check("凌晨 3 点在里面", accts.inDnd({ dnd }, at(3)), true);
check("08:59 在里面", accts.inDnd({ dnd }, at(8, 59)), true);
check("09:00 出来了（左闭右开）", accts.inDnd({ dnd }, at(9)), false);
check("下午不在里面", accts.inDnd({ dnd }, at(15)), false);
check("关了就永远不在", accts.inDnd({ dnd: { ...dnd, enabled: false } }, at(3)), false);
check(
  "不跨零点的时段也对（13:00–14:00）",
  [
    accts.inDnd({ dnd: { enabled: true, start: "13:00", end: "14:00" } }, at(13, 30)),
    accts.inDnd({ dnd: { enabled: true, start: "13:00", end: "14:00" } }, at(20)),
  ],
  [true, false]
);
check(
  "两头一样 = 不勿扰（而不是勿扰一整天）",
  accts.inDnd({ dnd: { enabled: true, start: "09:00", end: "09:00" } }, at(9, 30)),
  false
);

console.log("\n=== 35. token 寿命 ===");
const day = 86400_000;
check("有 token 没 userId 不能用", accts.accountUsable({ token: "x" }), false);
check("齐了就能用", accts.accountUsable({ token: "x", userId: "1", expiresAt: at(12) + day }, at(12)), true);
check("过期了不能用", accts.accountUsable({ token: "x", userId: "1", expiresAt: at(12) - 1 }, at(12)), false);
check("expiresAt 是 0（还没探过）当能用", accts.accountUsable({ token: "x", userId: "1", expiresAt: 0 }), true);
check("还有 30 天不用续", accts.needsRefresh({ token: "x", expiresAt: at(12) + 30 * day }, at(12)), false);
check("还有 3 天该续了", accts.needsRefresh({ token: "x", expiresAt: at(12) + 3 * day }, at(12)), true);
check("已经过期了续不了（只能重粘）", accts.needsRefresh({ token: "x", expiresAt: at(12) - day }, at(12)), false);

console.log("\n=== 36. allowedFrom：空名单 = 谁都不理，自己人永远算 ===");
const wl = { allowFrom: [{ name: "阿 A", username: "friend_a" }] };
const own = { accounts: { 小明: { username: "niki_real" } }, user: { username: "me_big" } };
check("名单里的放行", accts.allowedFrom("friend_a", wl, own), true);
check("陌生人不放行", accts.allowedFrom("stranger", wl, own), false);
check("空名单谁都不放行", accts.allowedFrom("stranger", { allowFrom: [] }, own), false);
check("角色自己的小号永远算（角色互评靠这条）", accts.allowedFrom("niki_real", { allowFrom: [] }, own), true);
check("你的大号永远算", accts.allowedFrom("@Me_Big", { allowFrom: [] }, own), true);
check("空用户名不放行", accts.allowedFrom("", wl, own), false);

console.log("\n=== 37. 发布配额：本地数 50 条 / 24 小时 ===");
check("上限是 50", accts.PUBLISH_LIMIT, 50);
const nowQ = at(12);
check(
  "只数 24 小时内的",
  accts.publishedInWindow({ publishedAt: [nowQ - 2 * day, nowQ - day - 1, nowQ - 3600_000, nowQ] }, nowQ),
  2
);
check("没发过是 0", accts.publishedInWindow({}), 0);

console.log("\n=== 38. 图片：Meta 的比例硬约束 ===");
const img = await import("../server/src/igimage.js");
check("正方形不用裁", img.cropFor(1024, 1024), null);
check("4:5 正好不用裁（下边界）", img.cropFor(1080, 1350), null);
check("1.91:1 附近不用裁（上边界）", img.cropFor(1910, 1000), null);
checkThat("9:16 手机截图要裁", Boolean(img.cropFor(1080, 1920)));
checkThat("21:9 超宽要裁", Boolean(img.cropFor(2100, 900)));
check("坏尺寸返回 null 而不是炸", [img.cropFor(0, 100), img.cropFor(100, -1)], [null, null]);

// 裁出来的必须落进合规区间，而且是居中裁
for (const [w, h] of [[1080, 1920], [2100, 900], [500, 2000], [4000, 1000]]) {
  const c = img.cropFor(w, h);
  const ratio = c.w / c.h;
  checkThat(
    `${w}×${h} 裁成 ${c.w}×${c.h}（${ratio.toFixed(2)}）落在 4:5~1.91:1 里`,
    ratio >= img.MIN_RATIO - 1e-9 && ratio <= img.MAX_RATIO + 1e-9,
    `得到 ${ratio.toFixed(4)}`
  );
  checkThat(`${w}×${h} 裁的是居中那块`, c.x * 2 + c.w <= w && c.y * 2 + c.h <= h);
  checkThat(`${w}×${h} 没裁出画面外`, c.x >= 0 && c.y >= 0 && c.x + c.w <= w && c.y + c.h <= h);
}

check("快拍的比例区间宽一档（9:16 只是推荐）", img.STORY_RATIO > 0, true);
check("图床三项缺一就算没配", [
  img.hostReady({ cloudName: "a", apiKey: "b", apiSecret: "c" }),
  img.hostReady({ cloudName: "a", apiKey: "b" }),
  img.hostReady(null),
], [true, false, false]);

console.log("\n=== 39. realGate：三道闸 ===");
const real = await import("../server/src/igreal.js");
const gateCfg = {
  roles: [
    { id: "r-a", name: "小明", instagram: { enabled: true, syncReal: true } },
    { id: "r-b", name: "Kira", instagram: { enabled: true, syncReal: false } },
    { id: "r-c", name: "Zed", instagram: { enabled: false, syncReal: true } },
  ],
};
const gateData = (over = {}) => ({
  settings: { imageHost: { cloudName: "c", apiKey: "k", apiSecret: "s" }, ...over.settings },
  accounts: { 小明: { token: "t", userId: "1", expiresAt: 0 }, ...over.accounts },
  user: { username: "" },
});
check("三样齐了才开", real.realGate(gateCfg, "小明", gateData()).ok, true);
check("角色没开 IG → 关", real.realGate(gateCfg, "Zed", gateData()).ok, false);
check("没开同步 → 关", real.realGate(gateCfg, "Kira", gateData()).ok, false);
check("没绑号 → 关", real.realGate(gateCfg, "小明", gateData({ accounts: { 小明: null } })).ok, false);
check(
  "图床没配 → 关",
  real.realGate(gateCfg, "小明", gateData({ settings: { imageHost: {} } })).ok,
  false
);
check(
  "token 过期 → 关",
  real.realGate(gateCfg, "小明", gateData({ accounts: { 小明: { token: "t", userId: "1", expiresAt: 1 } } })).ok,
  false
);
checkThat(
  "关掉的时候给一句中文原因（界面要原样显示）",
  /没开|还没绑|过期|图床/.test(real.realGate(gateCfg, "Kira", gateData()).why)
);
check("不存在的角色也不炸", real.realGate(gateCfg, "查无此人", gateData()).ok, false);

console.log("\n=== 40. pollDue：0 = 不轮询，勿扰时段不轮询 ===");
const due = (over) => real.pollDue({ intervalHours: 3, lastPollAt: 0, dnd: { enabled: false }, ...over }, at(15));
check("到点了就轮", due({}), true);
check("刚轮过不轮", due({ lastPollAt: at(15) - 3600_000 }), false);
check("0 = 永不轮询", due({ intervalHours: 0 }), false);
check("负数也不轮", due({ intervalHours: -1 }), false);
check(
  "勿扰时段里不轮（哪怕早该轮了）",
  real.pollDue({ intervalHours: 3, lastPollAt: 0, dnd: { enabled: true, start: "23:00", end: "09:00" } }, at(3)),
  false
);

console.log("\n=== 41. 帖子删不掉，但评论删得掉 ===");
const igapi = await import("../server/src/igapi.js");
check("canDeleteMedia 必须是 false", igapi.canDeleteMedia(), false);
// 评论是另一回事：DELETE /{comment-id} 2026-09-13 实测回 {"success":true}，
// peerComment 靠它把铺路那条 @ 用完就删。这里只验函数在、且参数校验对 ——
// 真调用要联网，归 scripts/try-peer-comment.mjs 管
check("deleteComment 得导出来", typeof igapi.deleteComment, "function");
const why = async (fn) => {
  try {
    await fn();
    return "（居然没抛）";
  } catch (e) {
    return String(e?.message ?? e);
  }
};
check("没绑号不给删", await why(() => igapi.deleteComment({}, "1")), "这个账号还没绑好");
check("没评论 id 不给删", await why(() => igapi.deleteComment({ token: "t" }, "")), "没有评论 id");

console.log("\n=== 42. 日志脱敏：token 一个字都不许落盘 ===");
const { maskToken } = await import("../server/src/ignet.js");
for (const key of ["access_token", "client_secret", "api_secret", "api_key", "signature"]) {
  const masked = maskToken(`https://x/y?${key}=SECRETVALUE&fields=id`);
  checkThat(`${key} 被打码`, !masked.includes("SECRETVALUE"), masked);
  checkThat(`${key} 后面的参数还在`, masked.includes("fields=id"));
}
checkThat("大写的 ACCESS_TOKEN 也打码", !maskToken("https://x?ACCESS_TOKEN=abc").includes("abc"));
check("没有敏感参数就原样返回", maskToken("https://x/y?fields=id"), "https://x/y?fields=id");
check("空值不炸", maskToken(null), "");

// 代理地址：日志和错误信息里都会出现，而这种串很多带 user:pass@
const { maskProxy } = await import("../server/src/ignet.js");
checkThat(
  "代理里的密码抹掉",
  !maskProxy("http://alice:hunter2@proxy.corp:8080").includes("hunter2"),
  maskProxy("http://alice:hunter2@proxy.corp:8080")
);
checkThat(
  "抹了密码还留主机和端口（不然没法定位问题）",
  maskProxy("http://alice:hunter2@proxy.corp:8080").includes("proxy.corp:8080")
);
check("没带凭据的原样留 origin", maskProxy("http://127.0.0.1:7890"), "http://127.0.0.1:7890");
check("socks5 也认", maskProxy("socks5://127.0.0.1:1080"), "socks5://127.0.0.1:1080");
check("解析不了就整个换掉（宁可少条线索）", maskProxy("这不是个地址"), "***");
check("空值返回空串", maskProxy(""), "");

console.log("\n=== 43. remote：本地那条记着「发到真 IG 了吗」 ===");
const EMPTY_REMOTE = { mediaId: "", permalink: "", at: "", error: "" };
const rPost = store.addPost("小明", { caption: "看海", images: [] });
check("新帖子的 remote 是空的", rPost.remote, EMPTY_REMOTE);
store.updatePost("小明", rPost.id, {
  remote: { mediaId: "17900", permalink: "https://instagram.com/p/x", at: 1, error: "" },
});
check(
  "回写之后读得到 mediaId（补发靠它做幂等）",
  store.readPosts("小明").find((p) => p.id === rPost.id).remote.mediaId,
  "17900"
);
check("at 是 ISO 串（igreal 写的就是这个）", typeof store.readPosts("小明")[0].remote.at, "string");

const rStory = store.addStory("小明", { caption: "路上", image: null });
check("快拍也有 remote", store.readStories("小明").find((s) => s.id === rStory.id).remote.mediaId, "");

// 手写坏数据进文件，读回来必须是规范的空壳而不是抛异常 ——
// normalizePost 不导出，只能这么从外面打
store.writePosts("Zed", [
  { id: "p-bad-1", remote: "???" },
  { id: "p-bad-2", remote: { mediaId: 17900, permalink: null } },
]);
const bad = store.readPosts("Zed");
check("remote 是字符串 → 规范成空壳", bad[0].remote, EMPTY_REMOTE);
check("mediaId 是数字 → 转成串", bad[1].remote.mediaId, "17900");
check("permalink 是 null → 空串", bad[1].remote.permalink, "");
store.writePosts("Zed", []);

console.log("\n=== 44. realOverview：**一个凭据都不许回前端** ===");
accts.writeRealSettings({ imageHost: { cloudName: "demo", apiKey: "KEY-123", apiSecret: "SEC-456" } });
accts.writeUserAccount({ token: "IGQ-user-token", userId: "9", username: "me_big" });
accts.writeAccount("小明", { token: "IGQ-role-token", userId: "1789", username: "niki_real" });

const ov = real.realOverview({ roles: [{ id: "r-a", name: "小明", instagram: { enabled: true, syncReal: true } }] });
const ovJson = JSON.stringify(ov);
for (const secret of ["IGQ-user-token", "IGQ-role-token", "KEY-123", "SEC-456"]) {
  checkThat(`${secret} 没出现在响应里`, !ovJson.includes(secret));
}
checkThat("整份响应里没有 token 字段", !/"token"/.test(ovJson), ovJson.slice(0, 200));
check("图床只回一个 configured 布尔", ov.settings.imageHost, {
  provider: "cloudinary",
  cloudName: "demo",
  configured: true,
});
check("角色那条带着 bound / username / syncReal", [
  ov.accounts[0].bound,
  ov.accounts[0].username,
  ov.accounts[0].syncReal,
], [true, "niki_real", true]);
check("你的大号那条也带 bound", ov.user.bound, true);
checkThat("代理只回「配没配」和来源变量名，不回地址", !("url" in (ov.proxy ?? {})));

/*
 * 没名字的角色不能出现在列表里。
 *
 * bind 那条路由里 roleName 是空串**表示你自己的大号** —— 列出来的话，给一个
 * 没名字的角色点「绑定」会悄悄把大号的 token 换掉。
 */
const ovNameless = real.realOverview({
  roles: [
    { id: "r-x", name: "", instagram: { enabled: true, syncReal: true } },
    { id: "r-y", name: "   ", instagram: { enabled: true, syncReal: true } },
    { id: "r-z", name: "小明", instagram: { enabled: true, syncReal: true } },
  ],
});
check("没名字的角色不列出来（不然会顶掉你的大号）", ovNameless.accounts.map((a) => a.roleName), ["小明"]);
check(
  "没开 IG 的角色也不列",
  real.realOverview({ roles: [{ id: "r-q", name: "Kira", instagram: { enabled: false } }] }).accounts,
  []
);

const net = await import("../server/src/ignet.js");

console.log("\n=== 45. isMediaFetchError：认出「Meta 取不到图」 ===");
/*
 * 这一族错误码是**换个地址重传就有救**的那一类，认错了代价不对称：
 *   · 认漏了 → 白白放弃一条帖子（实测首次成功率只有 60~70%）
 *   · 认多了 → 对着一个永远不会成功的错误重传 5 次，浪费流量和配额
 *
 * 实测数据见 scripts/diag-igfresh.mjs 那一组：同一张图，重试老 URL 救不回来，
 * 换新 URL 8/8 全成。
 */
{
  const { isMediaFetchError } = net;
  const tagged = (code, sub) => {
    const e = new Error("x");
    // igFetch 里就是这么打标的
    if ([9004, 9007].includes(code) || [2207052, 2207003, 2207032].includes(sub)) {
      e.igMediaFetch = true;
    }
    return e;
  };
  checkThat("9004/2207052（实测撞到的那个）认得出", isMediaFetchError(tagged(9004, 2207052)));
  checkThat("9007 老错误码也认", isMediaFetchError(tagged(9007, 0)));
  checkThat("2207003 子码认", isMediaFetchError(tagged(0, 2207003)));
  checkThat("2207032 子码认", isMediaFetchError(tagged(0, 2207032)));
  checkThat("190（token 失效）不认 —— 重传也白搭", !isMediaFetchError(tagged(190, 0)));
  checkThat("4（限流）不认", !isMediaFetchError(tagged(4, 0)));
  checkThat("100（比例不合规）不认", !isMediaFetchError(tagged(100, 0)));
  checkThat("没打标的普通异常不认", !isMediaFetchError(new Error("fetch failed")));
  checkThat("null / undefined 不炸", !isMediaFetchError(null) && !isMediaFetchError(undefined));
}

console.log("\n=== 46. igFetch 给这一族错误打标 ===");
/*
 * 起一个假的 Graph 服务，让 igFetch 真的打一次 —— 验证标记是从**响应 JSON 的
 * code/error_subcode** 来的，而不是靠 match 中文错误文案（文案会改，code 不会）。
 */
{
  /*
   * 前面某一节为了测 maskProxy 设过代理环境变量，而 igFetch 会给**所有**请求
   * 挂上 dispatcher —— 挂着的话这个跑在 127.0.0.1 上的假服务压根连不上。
   * 存下来、跑完还回去，别影响后面的节。
   */
  const savedProxy = {};
  for (const k of ["URANUS_IG_PROXY", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]) {
    savedProxy[k] = process.env[k];
    delete process.env[k];
  }

  const http = await import("node:http");
  let body = {};
  const srv = http.createServer((req, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  const grab = async () => {
    try {
      await net.igFetch(`${base}/x`);
      return null;
    } catch (e) {
      return e;
    }
  };

  body = { error: { code: 9004, error_subcode: 2207052, message: "cannot retrieve media" } };
  const e1 = await grab();
  checkThat("9004/2207052 被打上 igMediaFetch", net.isMediaFetchError(e1));
  checkThat("错误话术提到换地址重传过", /重传/.test(String(e1?.message)), String(e1?.message));

  body = { error: { code: 190, message: "OAuthException" } };
  const e2 = await grab();
  checkThat("190 没被打标", !net.isMediaFetchError(e2));
  checkThat("190 的话术还是让人去重新生成 token", /重新生成/.test(String(e2?.message)));

  body = { error: { code: 4, message: "rate limit" } };
  checkThat("限流没被打标", !net.isMediaFetchError(await grab()));

  await new Promise((r) => srv.close(r));
  for (const [k, v] of Object.entries(savedProxy)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

console.log("\n=== 47. 野图清理：留在用的、删没人要的 ===");
/*
 * media/ 只涨不落是个真问题（帖子没落盘、用户换过图、拉回来的图没用上），
 * 但**误删一张在用的图**比多留一百张野图严重得多 —— 界面上直接裂图，而且
 * 用户的原图找不回来。所以这一节主要在证「四种引用形态一个都不漏」。
 *
 * 头像那条是回归测试：`usedMediaFiles` 之前不扫 profiles/，删一条共用了头像
 * 文件的帖子会把头像顺手删掉。
 *
 * ── 为什么起一个子进程 ──
 *
 * 这一节要一个**干净空目录**才能断言准确的「删了几张、留了几张」，而上面几十
 * 节已经在 TMP 里堆了帖子、快拍和几个故意写坏的 JSON。换目录得重新加载
 * datadir.js（路径是模块加载那一刻算好的常量），但 igstore 里 import 它用的是
 * 静态路径 —— 给 igstore 加 `?v=` 只会拿到一个仍指着老目录的新实例。
 * 子进程是唯一干净的办法，代价是几百毫秒的启动。
 */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uranus-prune-"));
  const runner = path.join(dir, "run.mjs");
  const storeUrl = new URL("../server/src/igstore.js", import.meta.url).href;
  fs.writeFileSync(
    runner,
    `
import fs from "node:fs";
import path from "node:path";
const st = await import(${JSON.stringify(storeUrl)});
const inPost = st.saveMedia(Buffer.from("post").toString("base64"), "jpg");
const inStory = st.saveMedia(Buffer.from("story").toString("base64"), "jpg");
const avatar = st.saveMedia(Buffer.from("avatar").toString("base64"), "webp");
const cover = st.saveMedia(Buffer.from("cover").toString("base64"), "jpg");
const junkA = st.saveMedia(Buffer.from("junk-a").toString("base64"), "png");
const junkB = st.saveMedia(Buffer.from("junk-b").toString("base64"), "webp");
st.addPost("阿瑞", { caption: "x", images: [{ file: inPost, alt: "" }] });
const story = st.addStory("阿瑞", { caption: "y", image: { file: inStory, alt: "" } });
st.saveToHighlight("阿瑞", story.id, { title: "t", cover });
st.writeProfile("阿瑞", { avatar });

const mediaDir = path.join(process.env.URANUS_DATA_DIR, "instagram", "media");
const first = st.pruneOrphanMedia();
const left = fs.readdirSync(mediaDir);
const again = st.pruneOrphanMedia();

// 回归：同一个文件既是帖子的图、又是头像，删帖不能把头像带走
const shared = st.saveMedia(Buffer.from("shared").toString("base64"), "jpg");
const post2 = st.addPost("米洛", { caption: "z", images: [{ file: shared, alt: "" }] });
st.writeProfile("米洛", { avatar: shared });
st.removePost("米洛", post2.id);

console.log("@@" + JSON.stringify({
  first,
  again,
  keptPost: left.includes(inPost),
  keptStory: left.includes(inStory),
  keptCover: left.includes(cover),
  keptAvatar: left.includes(avatar),
  goneA: !left.includes(junkA),
  goneB: !left.includes(junkB),
  sharedSurvived: fs.readdirSync(mediaDir).includes(shared),
}));
`,
    "utf-8"
  );

  const { execFileSync } = await import("node:child_process");
  const stdout = execFileSync(process.execPath, [runner], {
    encoding: "utf-8",
    env: { ...process.env, URANUS_DATA_DIR: dir },
  });
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith("@@")) ?? "@@{}";
  const r = JSON.parse(line.slice(2));

  check("野图删掉两张", r.first?.removed, 2);
  check("在用的四张都留着", r.first?.kept, 4);
  checkThat("腾出来的字节数是正的", r.first?.bytes > 0, `bytes=${r.first?.bytes}`);
  checkThat("帖子里那张还在", r.keptPost);
  checkThat("快拍里那张还在", r.keptStory);
  checkThat("精选封面还在", r.keptCover);
  checkThat("头像还在（profiles/ 不能漏）", r.keptAvatar);
  checkThat("野图 A 清了", r.goneA);
  checkThat("野图 B 清了", r.goneB);
  // 幂等：用户连点两下不该有惊喜
  check("再清一次删 0 张", r.again?.removed, 0);
  checkThat("删帖不会删掉还在当头像用的那张", r.sharedSurvived);

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\n=== 48. 配文里的 @：认人、跳过点赞那一掷 ===");
{
  const { mentionedHandles, roleHandleMap } = await import("../server/src/igaccounts.js");

  check("普通一句", mentionedHandles("全靠 @alex_ig 撑着"), ["alex_ig"]);
  check("行首的 @", mentionedHandles("@alex_ig 看这个"), ["alex_ig"]);
  check("大写归一成小写", mentionedHandles("@Alex_IG"), ["alex_ig"]);
  // IG 不允许用户名以点或下划线结尾，所以尾部那个字符是标点、不是名字的一部分
  check("尾部的点是标点", mentionedHandles("@alex_ig."), ["alex_ig"]);
  check("中文句号也剃掉", mentionedHandles("谢谢 @alex_ig。"), ["alex_ig"]);
  check("中间的点留着", mentionedHandles("@char.lie"), ["char.lie"]);
  check("@ 两个人按顺序", mentionedHandles("@a_one 和 @b_two"), ["a_one", "b_two"]);
  check("重复的只算一次", mentionedHandles("@a_one @a_one"), ["a_one"]);
  // 配文里写个联系邮箱不该凭空多出一个「被点名的人」
  check("邮箱不算提及", mentionedHandles("联系我 me@x.com"), []);
  check("邮箱和真提及混在一句", mentionedHandles("me@x.com 还有 @c_ig"), ["c_ig"]);
  check("没有 @ 就是空", mentionedHandles("干净的桌子"), []);

  const { writeAccount } = await import("../server/src/igaccounts.js");
  const { readAccounts } = await import("../server/src/igaccounts.js");
  writeAccount("MentionA", { token: "t", userId: "1", username: "a_ig" });
  writeAccount("MentionB", { token: "t", userId: "2", username: "b_ig" });
  const map = roleHandleMap(readAccounts());
  checkThat("用户名 → 角色名认得出来", map.get("a_ig") === "MentionA" && map.get("b_ig") === "MentionB");
  checkThat("没绑号的角色不在里面", !map.has("nobody_ig"));

  /*
   * 被 @ 的角色**跳过点赞那一掷**。
   *
   * likeChance 焊成 100 + roll 焊成 0 = 那一掷必中，也就是「只点赞、不打模型」。
   * 被点名的角色应该无视它 —— 你 @ 它是要它说话，不是要它点个赞。
   * 判据是赞有没有落盘：没落盘就说明它冲过了那道闸（后面打模型会失败，
   * tickIgQueue 自己 catch 掉，不影响这个判断）。
   */
  const run = await import("../server/src/igrun.js");
  const mk = (id, name) => ({
    id,
    name,
    instagram: {
      enabled: true,
      likeChance: 100,
      replyChance: 100,
      syncReal: true,
      replyWindow: { minMinutes: 1, maxMinutes: 1 },
    },
  });
  const cfg = { chat: { separator: "|" }, roles: [mk("r-ma", "MentionA"), mk("r-mb", "MentionB")] };

  const p = store.addPost(store.USER_OWNER, {
    caption: "收拾干净了 @a_ig。",
    images: [{ file: "", alt: "书桌" }],
    remote: { mediaId: "fake-1", permalink: "", at: "", error: "" },
  });
  const q = run.schedulePublish(cfg, store.USER_OWNER, p, { isStory: false });
  check("两个角色各排一条", q.length, 2);
  await run.tickIgQueue(cfg, { now: Math.max(...q.map((t) => t.at)) + 60_000, roll: () => 0 });

  const done = store.readPosts(store.USER_OWNER).find((x) => x.id === p.id);
  checkThat("没被点名的照旧只点赞", (done?.likes ?? []).includes("MentionB"));
  checkThat("被点名的不点赞（走向模型）", !(done?.likes ?? []).includes("MentionA"));

  /*
   * commentOnUserPost 的判据是配文里那句 @。
   *
   * 这一步**不该打网络**：配文里没 @ 就直接返回。重判一次是因为判错的代价不
   * 对称 —— 没被 @ 就打 /mentions 会被 Meta 拒，而一次被拒会关掉角色互评。
   */
  const real = await import("../server/src/igreal.js");
  const noMention = await real.commentOnUserPost(cfg, "MentionB", done, "我也想收拾");
  checkThat("没被 @ 的角色直接被拒", noMention.ok === false);
  checkThat("拒的原因点明是配文里没 @ 它", /配文里没有 @b_ig/.test(noMention.why ?? ""));

  const noRemote = { ...done, remote: { mediaId: "", permalink: "", at: "", error: "" } };
  const local = await real.commentOnUserPost(cfg, "MentionA", noRemote, "真舒服");
  checkThat("纯本地的帖子（没 mediaId）也被拒", local.ok === false);
  checkThat("原因说的是没从真 IG 拉进来", /不是从真 IG 拉进来的/.test(local.why ?? ""));

  /*
   * 纯文字评论不传图，所以不该被「图床还没配」挡住。
   *
   * 前面的小节往这个临时目录里配过图床，先清掉 —— 要验的正是「没配图床时」
   * 两条路的分岔（不清的话两条都会过，这个断言就白写了）。
   */
  const { writeRealSettings } = await import("../server/src/igaccounts.js");
  const hostBefore = readAccounts().settings.imageHost;
  writeRealSettings({ imageHost: { cloudName: "", apiKey: "", apiSecret: "" } });

  const gate = real.realGate(cfg, "MentionA", readAccounts(), { needsHost: false });
  checkThat("没配图床也能只发文字", gate.ok === true, gate.why ?? "");
  const gateHost = real.realGate(cfg, "MentionA", readAccounts());
  checkThat("发图那条路照旧要图床", gateHost.ok === false && /图床/.test(gateHost.why ?? ""));

  writeRealSettings({ imageHost: hostBefore });
}

console.log(`\n${fail ? "✗" : "✓"} ${pass} 通过、${fail} 失败`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
