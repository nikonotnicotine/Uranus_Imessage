/**
 * 离线自测：发语音 + 表情包 + 生成图片（含图生图）。
 *
 * **不打真的上游。** 三家 TTS 和生图那几段临时把 globalThis.fetch 换成假函数，
 * 返回各家真实的响应形状（minimax 的 hex、elevenlabs 的裸二进制、生图的
 * b64_json / url 两种），跑完在 finally 里换回去。所以这里验的是「我们的适配器
 * 会不会把这些形状读对」，不是「那几家今天还通不通」。
 *
 * 数据目录指向临时的 URANUS_DATA_DIR，绝不碰用户真实的 data/ ——
 * 那里面有真的 API key、Photon 凭据和聊天记录。
 *
 * 跑：node scripts/test-media.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "uranus-media-"));
process.env.URANUS_DATA_DIR = TMP;
process.env.IMESSAGE_BRIDGE = "off";

// 参考图：resolveRefFile 只看文件在不在，不校验内容，几个字节的假 PNG 就够
fs.mkdirSync(path.join(TMP, "images"), { recursive: true });
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
fs.writeFileSync(path.join(TMP, "images", "小猫.png"), PNG_MAGIC);
fs.writeFileSync(path.join(TMP, "images", "自拍.JPG"), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
fs.writeFileSync(path.join(TMP, "images", "笔记.txt"), "不是图片");

/*
 * 表情包：一个情绪一个子文件夹，文件夹名就是标签名（见 emoji.js 的文件头）。
 * 内容同样不重要 —— listEmojiFiles 只看后缀，pickEmoji 只是把字节读出来。
 */
const EMOJI_FIXTURES = {
  开心: ["a.png", "b.GIF", "c.jpeg"], // 大写后缀：Windows 无所谓，Linux 上不认就会漏一批
  紧张: ["only.png"], // 只有一张时躲不开「连着两次同一张」
  早安: ["x.png", "笔记.txt"], // 白名单外的那个不该被列出来
  空的: [], // 建了文件夹还没放图：界面上列得出来，但不该注入给模型
};
for (const [tag, files] of Object.entries(EMOJI_FIXTURES)) {
  const dir = path.join(TMP, "images", "emojis", tag);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(dir, f), PNG_MAGIC);
}
// 隐藏目录、散落在 emojis/ 里的文件、标签文件夹里的隐藏文件，都不该算数
fs.mkdirSync(path.join(TMP, "images", "emojis", ".git"), { recursive: true });
fs.writeFileSync(path.join(TMP, "images", "emojis", "说明.txt"), "不是标签");
fs.writeFileSync(path.join(TMP, "images", "emojis", "开心", ".DS_Store"), "");

const { loadConfig, normalizeConfig, resolveImageEndpoint, saveConfig } = await import(
  "../server/src/config.js"
);
const {
  createEmojiTag,
  listEmojiFiles,
  listEmojiTags,
  pickEmoji,
  removeEmojiFile,
  resolveEmojiFile,
  resolveEmojiTag,
  saveEmojiFile,
} = await import("../server/src/emoji.js");
const {
  degradeToPlain,
  generateImage,
  hasLeaveOnRead,
  hasMedia,
  listRefFiles,
  mimeForExt,
  pickRefFromText,
  pickTtsSource,
  resolveRefFile,
  safeUploadName,
  saveRefFile,
  splitMedia,
  stripLeaveOnRead,
  stripMediaTags,
  stripToneTags,
  synthesizeVoice,
} = await import("../server/src/media.js");
const {
  DEFAULT_VEIL,
  listWallpapers,
  readWallpaperSettings,
  removeWallpaper,
  resolveWallpaper,
  safeWallpaperName,
  saveWallpaper,
  writeWallpaperSettings,
} = await import("../server/src/wallpaper.js");

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ok  ${name}`);
}

/** splitMedia 的结果压成一行，好写断言也好看失败输出。 */
const shape = (parts) =>
  parts.map((p) => (p.kind === "image" ? [p.kind, p.text, p.ref] : [p.kind, p.text]));

/* ================= 1. 标记解析 ================= */

console.log("\n[标记解析：语音]");
{
  assert.deepEqual(shape(splitMedia("[audio_message:我刚下班]")), [["audio", "我刚下班"]]);
  ok("默认格式 [audio_message:…]");

  assert.deepEqual(shape(splitMedia("［audio_message：我刚下班］")), [["audio", "我刚下班"]]);
  ok("全角方括号和全角冒号");

  assert.deepEqual(shape(splitMedia("[语音:我刚下班]")), [["audio", "我刚下班"]]);
  ok("中文写法 [语音:…]");

  // 接链路之前那版提示词的格式，用户改过的配置里还留着（preset.js:LEGACY_VOICE_CHILD）
  assert.deepEqual(shape(splitMedia("[语音]我刚下班了，好想你")), [["audio", "我刚下班了，好想你"]]);
  ok("旧格式 [语音]整句 —— 后面整段都是要说的话");

  assert.deepEqual(
    shape(splitMedia("你在干什么呢[audio_message:我刚下班，好想你。]不理我吗？")),
    [["text", "你在干什么呢"], ["audio", "我刚下班，好想你。"], ["text", "不理我吗？"]]
  );
  ok("夹在文字中间时按出现顺序切成三段");

  assert.deepEqual(shape(splitMedia("[audio_message:   ]")), []);
  ok("空内容不产出一段");
}

console.log("\n[标记解析：图片]");
{
  assert.deepEqual(shape(splitMedia("[image:一只橘猫]")), [["image", "一只橘猫", ""]]);
  ok("默认格式 [image:…]");

  for (const s of ["[生成图片：一只橘猫]", "[生图:一只橘猫]", "[画图:一只橘猫]", "［image：一只橘猫］"]) {
    assert.deepEqual(shape(splitMedia(s)), [["image", "一只橘猫", ""]], s);
  }
  ok("兼容 [生成图片：…] / [生图:…] / [画图:…] / 全角");

  // 内置的「线上默认预设」自己写的就是 `Must start with [Image:]`，
  // 模型照着写出来是大写开头的 —— 认不出来就等于生图整个功能没了
  for (const s of ["[Image:一只橘猫]", "[IMAGE:一只橘猫]", "［Image：一只橘猫］"]) {
    assert.deepEqual(shape(splitMedia(s)), [["image", "一只橘猫", ""]], s);
  }
  assert.deepEqual(shape(splitMedia("[Image:趴在窗台上][小猫]")), [
    ["image", "趴在窗台上", "小猫"],
  ]);
  ok("标签名不分大小写：[Image:…] / [IMAGE:…] 一样出图，参考图名也跟得上");

  // 同一条正则里的其它标签跟着一起不分大小写
  assert.deepEqual(shape(splitMedia("[Audio_message:我刚下班]")), [["audio", "我刚下班"]]);
  assert.deepEqual(shape(splitMedia("[Send_emoji:开心]")), [["sticker", "开心"]]);
  ok("语音和表情包的标签名同样不分大小写");

  assert.deepEqual(shape(splitMedia("[image:让它躺在地上][小猫]")), [
    ["image", "让它躺在地上", "小猫"],
  ]);
  ok("紧跟的方括号是参考图名（图生图）");

  assert.deepEqual(shape(splitMedia("[image:让它躺着] [小猫]")), [
    ["image", "让它躺着", "小猫"],
  ]);
  ok("参考图和描述之间有空格也认");

  // 排掉冒号那一手：不然后面那条语音会被当成参考图名吞掉
  assert.deepEqual(shape(splitMedia("[image:一只猫][audio_message:你看]")), [
    ["image", "一只猫", ""],
    ["audio", "你看"],
  ]);
  ok("后面跟着语音标记时，不把它误当参考图");

  assert.deepEqual(
    shape(splitMedia("你看这个[image:一只橘猫]好不好看[audio_message:是不是很可爱]")),
    [
      ["text", "你看这个"],
      ["image", "一只橘猫", ""],
      ["text", "好不好看"],
      ["audio", "是不是很可爱"],
    ]
  );
  ok("语音和图片混在一条里，顺序不乱");
}

console.log("\n[标记解析：嵌套括号]");
{
  // 用户实测翻车的原句：老正则在 [whispers] 的 ] 上提前闭了，语音只剩 9 个字
  assert.deepEqual(
    shape(
      splitMedia(
        "[audio_message:[whispers] Needy little thing... [sighs] I'm right here, puppy.]$happy now"
      )
    ),
    [
      ["audio", "[whispers] Needy little thing... [sighs] I'm right here, puppy."],
      ["text", "$happy now"],
    ]
  );
  ok("语音里嵌语气标签，整段都算语音内容");

  assert.deepEqual(shape(splitMedia("［audio_message：［气声］过来……坐好。］")), [
    ["audio", "［气声］过来……坐好。"],
  ]);
  ok("全角括号嵌套同理");

  assert.deepEqual(shape(splitMedia("[image:[特写] 她抬眼的样子][小猫]")), [
    ["image", "[特写] 她抬眼的样子", "小猫"],
  ]);
  ok("图片描述里嵌括号，参考图名照旧认");

  // 不成对的 ] 保持老行为：在它前面刹住，别把后面整段吞进标记里
  assert.deepEqual(shape(splitMedia("[audio_message:说一句]然后]")), [
    ["audio", "说一句"],
    ["text", "然后]"],
  ]);
  ok("不成对的 ] 退化成老行为");

  // 表情包/点歌这些**没有**换嵌套写法：里面出现方括号多半是写坏了，在第一个 ] 刹住
  assert.deepEqual(shape(splitMedia("[send_emoji:开心]后缀")), [
    ["sticker", "开心"],
    ["text", "后缀"],
  ]);
  ok("其他标记不吃嵌套，行为不变");
}

console.log("\n[标记解析：表情包]");
{
  assert.deepEqual(shape(splitMedia("[send_emoji:紧张]")), [["sticker", "紧张"]]);
  ok("默认格式 [send_emoji:…]");

  assert.deepEqual(shape(splitMedia("［send_emoji：紧张］")), [["sticker", "紧张"]]);
  ok("全角方括号和全角冒号");

  for (const s of ["[表情包:紧张]", "[表情:紧张]", "[sticker:紧张]", "[emoji:紧张]"]) {
    assert.deepEqual(shape(splitMedia(s)), [["sticker", "紧张"]], s);
  }
  ok("兼容 [表情包:…] / [表情:…] / [sticker:…] / [emoji:…]");

  // 用户给的规范里那两个正确示例（气泡分隔符由调用方先切，这里只看一条气泡）
  assert.deepEqual(shape(splitMedia("[send_emoji:早安]你在干什么？")), [
    ["sticker", "早安"],
    ["text", "你在干什么？"],
  ]);
  assert.deepEqual(shape(splitMedia("不要乱说……[send_emoji:紧张]")), [
    ["text", "不要乱说……"],
    ["sticker", "紧张"],
  ]);
  ok("规范里那两个示例都切得出来");

  assert.deepEqual(
    shape(splitMedia("[audio_message:我刚下班][send_emoji:开心]你看这个[image:一只橘猫]")),
    [
      ["audio", "我刚下班"],
      ["sticker", "开心"],
      ["text", "你看这个"],
      ["image", "一只橘猫", ""],
    ]
  );
  ok("三种标记混在一条里，顺序不乱");

  assert.deepEqual(shape(splitMedia("[send_emoji:   ]")), []);
  ok("空标签不产出一段");

  // 标签名有 60 字上限：超了整段当普通文字，不会把半句话当成文件夹名去找
  const tooLong = `[send_emoji:${"紧".repeat(61)}]`;
  assert.deepEqual(shape(splitMedia(tooLong)), [["text", tooLong]]);
  ok("标签超过 60 字 → 不当标记");

  assert.equal(
    splitMedia("<thinking>要不要 [send_emoji:开心] 呢</thinking>好呀").some(
      (p) => p.kind === "sticker"
    ),
    false
  );
  ok("XML 标签里的不算数（和语音/图片同一条规则）");

  assert.equal(hasMedia("[send_emoji:开心]"), true);
  ok("hasMedia 认得出表情包标记");
}

console.log("\n[标签里的标记不算数]");
{
  /*
   * 和联网搜索同一条规则（websearch.js:stripXmlBlocks 的注释）：模型在
   * <thinking> 里复述格式的情况实测很常见，真去出一张「xxx」的图纯属浪费钱。
   * 搜索那边是先扒掉标签再扫，这边不能 —— 扒掉会让后面所有下标错位，
   * 所以改成照原文扫、落在标签区间里的跳过。
   */
  const reply = [
    "<thinking>",
    "格式是 [image:画面描述]，语音是 [audio_message:内容]。",
    "她刚才问我在干嘛，回一条语音比较自然。",
    "</thinking>",
    "[audio_message:我在楼下便利店呢]",
  ].join("\n");

  const parts = splitMedia(reply);
  assert.equal(parts.filter((p) => p.kind !== "text").length, 1);
  assert.deepEqual(parts.filter((p) => p.kind === "audio"), [
    { kind: "audio", text: "我在楼下便利店呢" },
  ]);
  ok("思维链里复述的标记不触发，只认标签外面那个");

  assert.equal(hasMedia("<thinking>要不要[image:一只猫]呢</thinking>"), false);
  ok("整条只有标签里有标记 → hasMedia 是 false");

  // 跳过的那段原样留在文字里（正常情况下正则会把思维链收掉，不归这里管）
  const kept = splitMedia("<推演>写成 [image:x]</推演>后面");
  assert.ok(kept.every((p) => p.kind === "text"), JSON.stringify(kept));
  assert.ok(kept.map((p) => p.text).join("").includes("[image:x]"));
  ok("标签块原样留在文字段里，不被切走");
}

console.log("\n[stripMediaTags：功能关掉时的退化]");
{
  assert.equal(stripMediaTags("[audio_message:你好呀]"), "你好呀");
  ok("语音退化成它要念的那句话");

  assert.equal(stripMediaTags("[image:一张下午茶的照片，白瓷盘]"), "");
  ok("图片整段丢掉（那是给出图模型看的画面描述，发给人没意义）");

  assert.equal(stripMediaTags("[send_emoji:紧张]"), "");
  assert.equal(stripMediaTags("在吗[send_emoji:紧张]"), "在吗");
  ok("表情包整段丢掉（方括号里是个情绪标签，单独发给人看莫名其妙）");

  assert.equal(stripMediaTags("在吗[audio_message:我在的][image:自拍]"), "在吗我在的");
  ok("混在一起时只留文字和语音内容");

  assert.equal(hasMedia("今天天气不错"), false);
  assert.equal(hasMedia("[image:一只猫]"), true);
  ok("hasMedia 认得出有没有标记");
}

console.log("[degradeToPlain：线下模式的退化]");
{
  // 线下模式整条走 space.send 之前把媒体标记降级 —— 线上「功能关着」的同一套待遇
  assert.equal(
    degradeToPlain("[audio_message:[whispers] 我在的 [sighs] 别怕]"),
    "[whispers] 我在的 [sighs] 别怕"
  );
  ok("带嵌套语气标签的语音降成那句话");

  assert.equal(degradeToPlain("[reply:2][effect:烟花]我在的"), "我在的");
  ok("引用和特效这两个气泡属性先摘掉");

  assert.equal(degradeToPlain("[image:一张照片][send_emoji:紧张]"), "");
  ok("全是该丢的标记时是空串（调用方跳过不发）");
}

/* ================= 2. 参考图 ================= */

console.log("\n[参考图：找文件]");
{
  assert.equal(path.basename(resolveRefFile("小猫")), "小猫.png");
  ok("名字不带后缀 → 按 REF_EXTS 逐个探");

  assert.equal(path.basename(resolveRefFile("小猫.png")), "小猫.png");
  ok("用户手滑把后缀也填了也认");

  // 大写后缀：Windows 不区分大小写（小写那次探测就命中了），Linux 区分，
  // 靠 resolveRefFile 里额外那次 toUpperCase 探测。两边都该找得到这张图
  assert.equal(path.basename(resolveRefFile("自拍")).toLowerCase(), "自拍.jpg");
  ok("大写后缀也找得到");

  assert.equal(resolveRefFile("不存在的图"), null);
  assert.equal(resolveRefFile("笔记"), null);
  ok("找不到、或者不是白名单后缀 → null");

  // 安全边界：名字会被拼进文件路径
  assert.equal(resolveRefFile("../../data.config.json"), null);
  assert.equal(resolveRefFile("..\\config.json"), null);
  assert.equal(resolveRefFile(".hidden"), null);
  assert.equal(resolveRefFile(""), null);
  ok("路径穿越和点开头的都挡掉");

  const names = listRefFiles().map((r) => r.name);
  assert.deepEqual(names.sort(), ["小猫", "自拍"]);
  ok("listRefFiles 只列白名单后缀，去掉后缀名");

  assert.equal(mimeForExt(".JPG"), "image/jpeg");
  assert.equal(mimeForExt(".webp"), "image/webp");
  assert.equal(mimeForExt(".xyz"), "image/png");
  ok("mimeForExt 大小写不敏感，认不出的按 png");
}

console.log("\n[参考图：从 /image 的自由文本里摘名字]");
{
  const names = ["小猫", "小猫咪", "我的 自拍"];

  assert.deepEqual(pickRefFromText("小猫 躺在地上", names), { ref: "小猫", prompt: "躺在地上" });
  ok("裸名字写法");

  assert.deepEqual(pickRefFromText("[小猫] 躺在地上", names), { ref: "小猫", prompt: "躺在地上" });
  assert.deepEqual(pickRefFromText("［小猫］躺在地上", names), { ref: "小猫", prompt: "躺在地上" });
  ok("方括号写法（半角和全角）");

  // 长的先比 —— 不然「小猫」会抢在「小猫咪」前面把后者截成「咪…」
  assert.deepEqual(pickRefFromText("小猫咪 躺着", names), { ref: "小猫咪", prompt: "躺着" });
  ok("前缀撞名时取更长的那个");

  // 后面必须是空白或到头，不然「小猫咪很可爱」会被当成调用「小猫」
  assert.deepEqual(pickRefFromText("小猫咪很可爱", names), { ref: "", prompt: "小猫咪很可爱" });
  ok("名字后面接着别的字 → 不算调用，整段是描述");

  assert.deepEqual(pickRefFromText("我的 自拍 换个背景", names), {
    ref: "我的 自拍",
    prompt: "换个背景",
  });
  ok("名字里带空格的也能裸写（按名字比，不是先切词）");

  assert.deepEqual(pickRefFromText("一只小狗", names), { ref: "", prompt: "一只小狗" });
  ok("没撞上任何名字 → 纯文生图");

  // 方括号里写的不是图库里的名字：整段当描述（可能描述里恰好用了方括号）
  assert.deepEqual(pickRefFromText("[风格] 水彩画", names), { ref: "", prompt: "[风格] 水彩画" });
  ok("方括号里不是图库名 → 整段当描述");

  assert.deepEqual(pickRefFromText("小猫 躺着", []), { ref: "", prompt: "小猫 躺着" });
  ok("图库为空（图生图关着）→ 一个字都不摘");
}

/* ================= 3. 表情包图库 ================= */

console.log("\n[表情包：扫文件夹]");
{
  const tags = listEmojiTags();

  assert.deepEqual(Object.fromEntries(tags.map((t) => [t.tag, t.count])), {
    开心: 3,
    紧张: 1,
    早安: 1,
    空的: 0,
  });
  ok("子文件夹就是标签，各自数得出有几张图");

  // 空文件夹**也列出来**：用户刚建好还没放图时，界面上得看得见它
  assert.equal(tags.some((t) => t.tag === "空的"), true);
  ok("空标签也列出来（count 是 0，拦它的是 prompt.js 那道）");

  assert.equal(tags.some((t) => t.tag === "说明.txt" || t.tag === ".git"), false);
  ok("散落的文件和隐藏目录都不是标签");

  assert.deepEqual(
    listEmojiFiles("开心").map((f) => f.file),
    ["a.png", "b.GIF", "c.jpeg"]
  );
  ok("列图按名字排，大写后缀（.GIF）也认，隐藏文件不列");

  assert.deepEqual(
    listEmojiFiles("早安").map((f) => f.file),
    ["x.png"]
  );
  ok("白名单外的后缀不列（和参考图同一份 REF_EXTS）");

  assert.ok(listEmojiFiles("开心").every((f) => f.size > 0));
  ok("带上文件大小（界面上缩略图旁边显示的那个）");

  assert.deepEqual(listEmojiFiles("不存在的标签"), []);
  assert.deepEqual(listEmojiFiles("空的"), []);
  ok("标签不存在 / 文件夹是空的 → 空数组");
}

console.log("\n[表情包：安全边界]");
{
  // 标签会从模型的回复里、也会从前端的 URL 里进来，两处都不可信
  assert.equal(path.basename(resolveEmojiTag("开心")), "开心");
  ok("正常标签解析得出文件夹");

  assert.equal(resolveEmojiTag("../../wallpapers"), null);
  assert.equal(resolveEmojiTag("..\\..\\characters"), null);
  assert.equal(resolveEmojiTag(".git"), null);
  assert.equal(resolveEmojiTag(""), null);
  assert.equal(resolveEmojiTag("说明.txt"), null);
  ok("穿越路径、点开头的、不是文件夹的都挡掉");

  assert.equal(path.basename(resolveEmojiFile("开心", "b.GIF")), "b.GIF");
  ok("标签 + 文件名找得到图");

  assert.equal(resolveEmojiFile("开心", "../../../data.config.json"), null);
  assert.equal(resolveEmojiFile("../../wallpapers", "settings.json"), null);
  ok("两段各自过一遍 basename，缺一不可");

  // 只挡标签不挡文件名的话，这一条就能从别的标签里读图出来
  assert.equal(resolveEmojiFile("开心", "../紧张/only.png"), null);
  ok("跨标签也读不到（文件名那段的 basename 挡住了）");

  assert.equal(resolveEmojiFile("早安", "笔记.txt"), null);
  assert.equal(resolveEmojiFile("开心", ".DS_Store"), null);
  assert.equal(resolveEmojiFile("开心", "不存在.png"), null);
  ok("白名单外的后缀、点开头的、不存在的都读不到");
}

console.log("\n[表情包：随机挑一张]");
{
  const hit = pickEmoji("紧张");
  assert.equal(hit?.file, "only.png");
  assert.equal(hit?.tag, "紧张");
  assert.equal(hit?.mimeType, "image/png");
  assert.ok(hit?.buffer?.length > 0);
  ok("挑出来的那张连内容一起读出来了");

  // 只有一张时躲不掉「连着两次同一张」，那就照发
  assert.equal(pickEmoji("紧张")?.file, "only.png");
  ok("文件夹里只有一张 → 连着挑两次都是它");

  /*
   * 「连着 N 次不会挑到同一张」= 躲开最近 N-1 张。默认 N=5，而这个标签只有
   * 3 张图 —— 躲 4 张会躲到没得挑，所以往下夹到 2 张，连起来看是「连着 3 次
   * 不重样」，也就是三张轮着来。
   */
  const picks = [];
  for (let i = 0; i < 12; i += 1) picks.push(pickEmoji("开心").file);
  assert.ok(
    picks.every((f) => ["a.png", "b.GIF", "c.jpeg"].includes(f)),
    picks.join(",")
  );
  assert.ok(
    picks.every((f, i) => i < 2 || (f !== picks[i - 1] && f !== picks[i - 2])),
    picks.join(",")
  );
  ok("默认 5 次不重样，图不够时自动往下夹（3 张 → 连着 3 次不重样）");

  // N=2 就是老行为：只躲上一张，第三次可以回到第一张
  const two = [];
  for (let i = 0; i < 30; i += 1) two.push(pickEmoji("开心", 2).file);
  assert.ok(
    two.every((f, i) => i === 0 || f !== two[i - 1]),
    two.join(",")
  );
  assert.ok(
    two.some((f, i) => i >= 2 && f === two[i - 2]),
    "N=2 时第三次应该有机会回到第一张，30 次都没回过说明躲多了"
  );
  ok("N=2 → 只躲上一张");

  // N=1 是「不躲」。30 次里一次都没连上的概率是 (2/3)^29，小到可以当不可能
  const one = [];
  for (let i = 0; i < 30; i += 1) one.push(pickEmoji("开心", 1).file);
  assert.ok(
    one.some((f, i) => i > 0 && f === one[i - 1]),
    one.join(",")
  );
  ok("N=1 → 不躲，允许连着两次同一张");

  // 乱填的（undefined 之外的脏值）按默认 5 走，不能让它躲到没得挑
  assert.ok(["a.png", "b.GIF", "c.jpeg"].includes(pickEmoji("开心", "乱填的").file));
  assert.ok(["a.png", "b.GIF", "c.jpeg"].includes(pickEmoji("开心", 999).file));
  ok("noRepeat 是脏值 / 大得离谱时照样挑得出来");

  assert.equal(pickEmoji("空的"), null);
  assert.equal(pickEmoji("不存在的标签"), null);
  assert.equal(pickEmoji("../../wallpapers"), null);
  ok("空文件夹 / 标签不存在 / 穿越路径 → null（调用方据此放弃这一段）");
}

console.log("\n[表情包：注入前那几道闸]");
{
  const { resolvePreset } = await import("../server/src/preset.js");
  const { buildPrompt } = await import("../server/src/prompt.js");

  /** 整份提示词拼成一段，好判断某一节注没注入。 */
  const promptOf = async (config, role) => {
    const { messages } = await buildPrompt(config, role, null, [
      { role: "user", content: "在吗" },
    ]);
    return messages.map((m) => m.content).join("\n\n");
  };

  /*
   * 只看「可用标签」那一行。正文里的正确示例本来就写着 [send_emoji:紧张]，
   * 拿整段去判断「紧张在不在」会永远命中，黑名单那条就白测了。
   */
  const tagsLine = (text) => text.split("\n").find((l) => l.includes("可用标签")) ?? "";

  /**
   * 一份只改「角色开关 / 子条目」的配置。
   *
   * 注意没有「图库里勾了哪些」这一项了 —— 硬盘上有什么标签就注入什么
   * （用户原话：「允许注入给模型和黑名单不会有点重复了吗……就留下黑名单吧」）。
   */
  const make = ({ send = {}, children } = {}) =>
    normalizeConfig({
      presets: [
        {
          id: "ps-1",
          name: "默认",
          ...(children ? { entries: [{ kind: "format", children }] } : {}),
        },
      ],
      roles: [{ id: "r-1", name: "小雨", presetRef: "ps-1", stickerSend: send }],
    });

  const base = make();
  const child = resolvePreset(base, base.roles[0])
    .entries.find((e) => e.kind === "format")
    ?.children?.find((c) => c.kind === "sticker");
  assert.equal(child?.enabled, true);
  ok("（预设里那个子条目确实默认开着）");

  // 第一道闸：角色单独配置里那个开关，用户定的是「默认为关」
  assert.equal((await promptOf(base, base.roles[0])).includes("<send_emoji>"), false);
  ok("角色没开 → 不注入（尽管子条目是开的、文件夹里也有图）");

  /*
   * 期望的清单直接从硬盘算出来，不写死顺序 —— listEmojiTags 用
   * localeCompare(…, "zh") 排序，不同 ICU 版本对中文的排法未必一致，
   * 写死会在别人机器上莫名其妙地挂。这里要验的是「有图的全都在、顺序跟着它」。
   */
  const stocked = listEmojiTags()
    .filter((t) => t.count > 0)
    .map((t) => t.tag);
  assert.deepEqual([...stocked].sort(), ["开心", "早安", "紧张"].sort());

  const on = make({ send: { enabled: true } });
  const text = await promptOf(on, on.roles[0]);
  assert.ok(text.includes("<send_emoji>"));
  assert.ok(tagsLine(text).includes(stocked.join("、")), tagsLine(text));
  ok("角色开了 → 硬盘上有图的标签默认全都注入（顺序跟着文件夹排）");

  // 文件夹里没图：注入了也只会诱模型发一个发不出去的标记
  assert.equal(tagsLine(text).includes("空的"), false);
  ok("文件夹是空的 → 不进清单");

  // 两个变量都必须换掉，原样发过去等于让模型自己编
  assert.equal(text.includes("{{表情包变量}}"), false);
  assert.equal(text.includes("{{sep}}"), false);
  assert.equal(text.includes("{{char}}"), false);
  ok("{{表情包变量}} / {{sep}} / {{char}} 都换成了实际内容");

  // 第二道闸：角色自己的标签黑名单（用户原话「LLM 也则不会知道有这个表情包」）
  const banned = make({ send: { enabled: true, blacklist: ["紧张"] } });
  const bannedLine = tagsLine(await promptOf(banned, banned.roles[0]));
  assert.ok(bannedLine.includes(stocked.filter((t) => t !== "紧张").join("、")), bannedLine);
  assert.equal(bannedLine.includes("紧张"), false);
  ok("黑名单里的标签不进清单");

  const allBanned = make({
    send: { enabled: true, blacklist: ["开心", "紧张", "早安", "空的"] },
  });
  assert.equal((await promptOf(allBanned, allBanned.roles[0])).includes("<send_emoji>"), false);
  ok("全禁掉 → 整条跳过（不给模型一个空清单）");

  // 第三道闸：预设里那条子条目
  const childOff = make({ send: { enabled: true }, children: [{ kind: "sticker", enabled: false }] });
  assert.equal((await promptOf(childOff, childOff.roles[0])).includes("<send_emoji>"), false);
  ok("子条目关掉 → 角色开着也不注入");

  // 最外面那道：整条「消息格式与功能」关掉
  const entryOff = normalizeConfig({
    presets: [{ id: "ps-1", entries: [{ kind: "format", enabled: false }] }],
    roles: [{ id: "r-1", name: "小雨", presetRef: "ps-1", stickerSend: { enabled: true } }],
  });
  assert.equal((await promptOf(entryOff, entryOff.roles[0])).includes("<send_emoji>"), false);
  ok("整条条目关掉 → 里面的子条目一条都不注入");

  /*
   * 用户给的规范原文里占位符写的是 {{变量}}，默认正文里改成了和
   * {{图生图变量}} 对称的 {{表情包变量}} —— 两种都得认，否则用户把规范
   * 原文粘回编辑框，模型就会收到一个没换过的占位符。
   */
  const spec = make({
    send: { enabled: true, blacklist: ["紧张"] },
    children: [{ kind: "sticker", content: "可用标签: {{变量}}" }],
  });
  const specLine = tagsLine(await promptOf(spec, spec.roles[0]));
  assert.ok(specLine.includes(stocked.filter((t) => t !== "紧张").join("、")), specLine);
  ok("用户规范里那个 {{变量}} 也认");
}

console.log("\n[表情包：删文件]");
{
  // 界面上是「挑着缩略图删」，删的是硬盘上的文件，所以边界和读取一样严
  assert.equal(removeEmojiFile("开心", "../紧张/only.png"), false);
  assert.equal(removeEmojiFile("早安", "笔记.txt"), false);
  assert.equal(removeEmojiFile("开心", "不存在.png"), false);
  assert.equal(fs.existsSync(path.join(TMP, "images", "emojis", "紧张", "only.png")), true);
  ok("穿越路径、白名单外的、不存在的都删不动，别的标签的图也没被殃及");

  assert.equal(removeEmojiFile("开心", "c.jpeg"), true);
  assert.equal(fs.existsSync(path.join(TMP, "images", "emojis", "开心", "c.jpeg")), false);
  assert.deepEqual(
    listEmojiFiles("开心").map((f) => f.file),
    ["a.png", "b.GIF"]
  );
  ok("删掉的图真的没了，列表跟着少一张");

  // 删的是图不是标签 —— 文件夹留着，用户还能再往里放
  assert.equal(listEmojiTags().some((t) => t.tag === "开心"), true);
  ok("标签文件夹本身不动");
}

/* ================= 上传落盘（参考图 / 表情包共用同一套清洗） ================= */

console.log("\n[上传：文件名清洗]");
{
  /*
   * safeUploadName 是三处上传（壁纸 / 参考图 / 表情包）共用的那一份规矩。
   * 名字来自**浏览器里用户选的文件**，等于外部输入，所以边界和读取时一样严：
   * 先 basename 兜路径穿越，再剔 Windows 非法字符和控制字符，最后后缀必须
   * 落在 REF_EXTS 白名单里 —— 否则按 mimeType 补一个。
   */
  const png = { mimeType: "image/png" };

  assert.equal(safeUploadName({ raw: "../../坏.png", ...png }), "坏.png");
  assert.equal(safeUploadName({ raw: "..\\..\\坏.png", ...png }), "坏.png");
  ok("路径穿越只剩最后那段文件名");

  assert.equal(safeUploadName({ raw: '坏<名>字:"|?*.png', ...png }), "坏名字.png");
  assert.equal(safeUploadName({ raw: "名 字.png", ...png }), "名字.png");
  ok("Windows 非法字符和控制字符都剔掉");

  assert.equal(safeUploadName({ raw: ".hidden.png", ...png }), "hidden.png");
  ok("点开头的不会落成隐藏文件");

  // 结尾的点和空格：Windows 会把「名字.」存成「名字」，再按名字找就对不上了
  assert.equal(safeUploadName({ raw: "名字. ", ...png }), "名字.png");
  ok("结尾的点和空格去掉");

  assert.equal(safeUploadName({ raw: "自拍", mimeType: "image/webp" }), "自拍.webp");
  assert.equal(safeUploadName({ raw: "自拍", mimeType: "image/jpeg" }), "自拍.jpg");
  assert.equal(safeUploadName({ raw: "自拍", mimeType: "谁知道是啥" }), "自拍.png");
  ok("没后缀时按 mimeType 补，认不出的按 png");

  assert.equal(safeUploadName({ raw: "自拍.JPG", ...png }), "自拍.jpg");
  ok("大写后缀统一成小写（Linux 上大小写敏感，不统一会漏）");

  // 白名单外的后缀不是「剪掉」而是「整个当名字的一部分」，再补一个真后缀 ——
  // 剪掉的话 `木马.exe` 会变成 `木马.png`，看起来像是我们认可了这个名字
  assert.equal(safeUploadName({ raw: "木马.exe", ...png }), "木马.exe.png");
  ok("白名单外的后缀留在名字里，后面再补一个白名单后缀");

  assert.equal(safeUploadName({ raw: "", ...png }), "图片.png");
  assert.equal(safeUploadName({ raw: "..", ...png, fallback: "表情包" }), "表情包.png");
  assert.equal(safeUploadName({ raw: "///", ...png, fallback: "表情包" }), "表情包.png");
  ok("名字被剔光了也有兜底");

  const long = safeUploadName({ raw: `${"长".repeat(80)}.png`, ...png });
  assert.equal(long, `${"长".repeat(60)}.png`);
  ok("名字太长截到 60 个字");

  // 重名往后排：taken 由调用方给（壁纸要连内置的一起比，参考图比的是去后缀的名字）
  const taken = new Set(["猫.png", "猫-2.png"]);
  assert.equal(safeUploadName({ raw: "猫.png", ...png, taken: (n) => taken.has(n) }), "猫-3.png");
  ok("重名一直往后排到不撞为止");
}

console.log("\n[上传：参考图落盘]");
{
  const b64 = PNG_MAGIC.toString("base64");
  // 新传的一律进 参考图/，images/ 根那份只为兼容老用户（见 media.js:saveRefFile）
  const REF_DIR = path.join(TMP, "images", "参考图");

  const first = saveRefFile("新图.png", b64, "image/png");
  assert.deepEqual(first, { file: "新图.png", name: "新图" });
  assert.deepEqual(fs.readFileSync(path.join(REF_DIR, "新图.png")), PNG_MAGIC);
  assert.equal(fs.existsSync(path.join(TMP, "images", "新图.png")), false);
  assert.ok(listRefFiles().some((r) => r.name === "新图"));
  ok("传上来的 base64 解成文件写进 参考图/，列表里立刻看得见");

  const second = saveRefFile("新图.png", b64, "image/png");
  assert.equal(second.file, "新图-2.png");
  assert.equal(fs.existsSync(path.join(REF_DIR, "新图.png")), true);
  ok("同名不覆盖，第二张变成 -2");

  /*
   * 撞名比的是**去掉后缀的名字**，不是文件名：listRefFiles 按去后缀的名字去重，
   * 真让 `小猫.png` 和 `小猫.jpg` 同时存在，界面上只会显示一条，
   * 删的时候用户会觉得「删了怎么还在」。老位置上的同名图也算数。
   */
  const sameStem = saveRefFile("小猫.jpg", b64, "image/jpeg");
  assert.equal(sameStem.file, "小猫-2.jpg");
  assert.deepEqual(fs.readFileSync(path.join(TMP, "images", "小猫.png")), PNG_MAGIC);
  ok("后缀不同但名字相同也算撞名（列表按名字去重，两个文件夹一起比）");

  saveRefFile("../../坏.png", b64, "image/png");
  assert.equal(fs.existsSync(path.join(REF_DIR, "坏.png")), true);
  assert.equal(fs.existsSync(path.join(TMP, "images", "坏.png")), false);
  assert.equal(fs.existsSync(path.join(TMP, "坏.png")), false);
  ok("路径穿越写不出 参考图/ 这一层");
}

console.log("\n[上传：表情包建标签]");
{
  /*
   * 全新安装时 emojis/ 是空的 ——「直接在图库里上传」得先有个文件夹，
   * 所以界面上要能建标签，不然这个上传按钮等于白做。
   */
  assert.equal(createEmojiTag("  委屈  "), "委屈");
  assert.equal(fs.statSync(path.join(TMP, "images", "emojis", "委屈")).isDirectory(), true);
  assert.deepEqual(
    listEmojiTags().find((t) => t.tag === "委屈"),
    { tag: "委屈", count: 0 }
  );
  ok("建出来的空标签列得出来，count 是 0");

  // 重复建当无事发生：用户看来「这个标签本来就该在」，不该弹个错
  assert.equal(createEmojiTag("开心"), "开心");
  assert.deepEqual(
    listEmojiFiles("开心").map((f) => f.file),
    ["a.png", "b.GIF"]
  );
  ok("建一个已经有的标签不报错，也不动里面的图");

  assert.equal(createEmojiTag(""), null);
  assert.equal(createEmojiTag("   "), null);
  assert.equal(createEmojiTag(".."), null);
  assert.equal(createEmojiTag("<>:\"|?*"), null);
  ok("剔干净之后什么都不剩 → null（不建空文件夹）");

  // 边界和 resolveEmojiTag 对齐：穿越只剩最后一段，点开头的不会变成隐藏文件夹
  assert.equal(createEmojiTag("../../坏标签"), "坏标签");
  assert.equal(fs.existsSync(path.join(TMP, "images", "emojis", "坏标签")), true);
  assert.equal(fs.existsSync(path.join(TMP, "坏标签")), false);
  assert.equal(createEmojiTag(".git2"), "git2");
  assert.equal(fs.existsSync(path.join(TMP, "images", "emojis", "git2")), true);
  ok("穿越路径和点开头的都落在 emojis/ 里面且不隐藏");
}

console.log("\n[上传：表情包落盘]");
{
  const b64 = PNG_MAGIC.toString("base64");

  // 不替用户建标签：传到一个不存在的标签下面，多半是前端拿了份过期的列表
  assert.equal(saveEmojiFile("没这个标签", "笑.png", b64, "image/png"), null);
  assert.equal(saveEmojiFile("", "笑.png", b64, "image/png"), null);
  ok("标签不存在 → null（接口回 404，不顺手建文件夹）");

  assert.equal(saveEmojiFile("委屈", "笑.png", b64, "image/png"), "笑.png");
  assert.deepEqual(fs.readFileSync(path.join(TMP, "images", "emojis", "委屈", "笑.png")), PNG_MAGIC);
  assert.equal(listEmojiTags().find((t) => t.tag === "委屈").count, 1);
  ok("写进标签文件夹，count 跟着涨");

  assert.equal(saveEmojiFile("委屈", "笑.png", b64, "image/png"), "笑-2.png");
  assert.deepEqual(
    listEmojiFiles("委屈").map((f) => f.file),
    ["笑-2.png", "笑.png"]
  );
  ok("同名不覆盖，第二张变成 -2");

  // GIF 在浏览器那边是原样上传的（重编码会把动图压成一张静态图），后缀得留住
  assert.equal(saveEmojiFile("委屈", "跳舞.gif", b64, "image/gif"), "跳舞.gif");
  ok("GIF 后缀原样留着（前端不重编码动图）");

  // 标签同样过 basename：穿越只会落到 emojis/ 里另一个已存在的标签下
  assert.equal(saveEmojiFile("../紧张", "混进来.png", b64, "image/png"), "混进来.png");
  assert.equal(fs.existsSync(path.join(TMP, "images", "emojis", "紧张", "混进来.png")), true);
  assert.equal(fs.existsSync(path.join(TMP, "images", "混进来.png")), false);
  ok("标签里的穿越路径出不了 emojis/");
}

/* ================= 4. 配置：默认值、收口、密钥分家 ================= */

console.log("\n[配置：默认值]");
{
  const c = normalizeConfig({});

  assert.deepEqual(Object.keys(c.ttsApi).sort(), ["elevenlabs", "fish", "minimax", "sovits"]);
  assert.equal(c.ttsApi.minimax.enabled, false);
  assert.equal(c.ttsApi.minimax.model, "speech-02-hd");
  assert.equal(c.ttsApi.minimax.region, "domestic");
  assert.equal(c.ttsApi.minimax.host, "");
  assert.equal(c.ttsApi.elevenlabs.model, "eleven_multilingual_v2");
  assert.equal(c.ttsApi.sovits.promptLang, "zh");
  ok("ttsApi 四家默认结构，各自 enabled 独立");

  /*
   * region 的迁移。
   *
   * 这个字段之前是一个自己填的 host 输入框，老配置里可能填过官方域名。
   * 按域名反推出地区、把 host 清掉；不认的域名（自建反代）原样留着 ——
   * 那是能用的配置，不能因为换了个控件就给人改坏。
   */
  {
    const from = (minimax) => normalizeConfig({ ttsApi: { minimax } }).ttsApi.minimax;

    let m = from({ host: "https://api.minimaxi.com" });
    assert.equal(m.region, "domestic");
    assert.equal(m.host, "");
    ok("迁移：老配置填了 api.minimaxi.com → region=domestic，host 清空");

    m = from({ host: "https://api.minimax.io" });
    assert.equal(m.region, "global");
    assert.equal(m.host, "");
    ok("迁移：老配置填了 api.minimax.io → region=global，host 清空");

    m = from({ host: "https://api.minimax.chat/" });
    assert.equal(m.region, "global");
    ok("迁移：旧的 api.minimax.chat 也算海外站");

    m = from({ host: "https://my.proxy.internal" });
    assert.equal(m.host, "https://my.proxy.internal");
    ok("迁移：自建反代的地址原样留着，继续生效");

    // 已经存了 region 的，不要再被 host 反推覆盖
    m = from({ region: "global", host: "https://api.minimaxi.com" });
    assert.equal(m.region, "global");
    ok("已经有 region 时不被 host 反推覆盖");

    assert.equal(from({ region: "乱填的" }).region, "domestic");
    ok("region 只认 domestic / global，别的收成 domestic");
  }

  assert.deepEqual(c.referenceImages, []);
  // 「勾了哪些表情包标签」这份清单已经整个删掉了：硬盘上有什么就注入什么，
  // 只被角色的黑名单减一遍（用户：「就留下黑名单吧」）
  assert.equal("emojiTags" in c, false);
  ok("referenceImages 默认空；config 里不再有 emojiTags 这一项");

  const role = normalizeConfig({ roles: [{ name: "小柚" }] }).roles[0];
  assert.equal("language" in role, false);
  assert.deepEqual(role.voiceSend, { enabled: false, voiceId: "" });
  assert.deepEqual(role.imageGen, { enabled: false, img2img: false, refs: [] });
  assert.deepEqual(role.stickerSend, { enabled: false, blacklist: [], noRepeat: 5 });
  ok("角色上三块默认值（三个功能默认关、连着 5 次不重样；language 已整个删掉）");
}

console.log("\n[配置：收口]");
{
  const c = normalizeConfig({
    ttsApi: {
      minimax: { enabled: 1, key: "  k  ", groupId: " g ", model: "" },
      elevenlabs: { enabled: false, key: "e" },
      sovits: { enabled: true, url: " http://127.0.0.1:9880/ " },
    },
    referenceImages: [
      { name: "  小猫  ", description: "喵" },
      // 名称会被拼进文件路径，路径分隔符和 .. 必须拦下来
      { name: "../../data.config", description: "坏的" },
      { name: "a/b\\c:d", description: "也坏" },
    ],
    // 老配置里可能还留着 emojiTags，收口时该被整个丢掉（那份清单已经删了）
    emojiTags: ["  开心  ", "开心", "a/b\\c:d", "..", "  ", "紧张"],
    roles: [
      {
        name: "小柚",
        voiceSend: { enabled: true, voiceId: " v-1 " },
        imageGen: { enabled: true, img2img: true, refs: ["小猫", "小猫", " ", "自拍"] },
        stickerSend: {
          enabled: 1,
          blacklist: ["  紧张  ", "紧张", "", ".."],
          noRepeat: "3.6", // 数字型字符串照收，四舍五入
        },
      },
    ],
  });

  assert.equal(c.ttsApi.minimax.enabled, true);
  assert.equal(c.ttsApi.minimax.key, "k");
  assert.equal(c.ttsApi.minimax.groupId, "g");
  assert.equal(c.ttsApi.minimax.model, "speech-02-hd");
  assert.equal(c.ttsApi.elevenlabs.enabled, false);
  ok("凭据去空格、enabled 归成布尔、空模型名补默认");

  assert.deepEqual(
    c.referenceImages.map((r) => r.name),
    ["小猫", "data.config", "abcd"]
  );
  assert.ok(c.referenceImages.every((r) => r.id));
  ok("图库名去空格、剔掉路径分隔符和 ..，各自补 id");

  assert.equal("emojiTags" in c, false);
  ok("老配置里的 emojiTags 收口时整个丢掉（下次保存就从磁盘上消失）");

  const role = c.roles[0];
  assert.equal(role.voiceSend.voiceId, "v-1");
  assert.deepEqual(role.imageGen.refs, ["小猫", "自拍"]);
  assert.deepEqual(role.stickerSend, { enabled: true, blacklist: ["紧张"], noRepeat: 4 });
  ok("角色：音色 ID 去空格、refs 和表情包黑名单去重去空");

  // 「连着 N 次不重样」夹在 1~50：0 和负数没有意义，大到离谱也只是白占内存
  const noRepeat = (v) =>
    normalizeConfig({ roles: [{ name: "小柚", stickerSend: { noRepeat: v } }] }).roles[0]
      .stickerSend.noRepeat;
  assert.equal(noRepeat(1), 1);
  assert.equal(noRepeat(0), 1);
  assert.equal(noRepeat(-3), 1);
  assert.equal(noRepeat(999), 50);
  assert.equal(noRepeat("乱填的"), 5);
  assert.equal(noRepeat(undefined), 5);
  ok("noRepeat 夹到 1~50，填不出数就回默认的 5");
}

console.log("\n[配置：密钥不落进能分享的那份]");
{
  /*
   * backup.js:buildBundle 把 roles 原样拷进「不含密钥」的备份包，所以密钥
   * 必须全局。落盘时 data.config.json 收密钥、config.json 里那块抹成空壳，
   * 两处少写一处就会在重启后丢配置（searchKeys 那条注释里踩过）。
   */
  saveConfig({
    ...loadConfig(),
    ttsApi: {
      minimax: { enabled: true, key: "SECRET-MM", groupId: "GID", model: "speech-02-hd" },
      elevenlabs: { enabled: true, key: "SECRET-EL" },
      fish: { enabled: true, key: "SECRET-FA", referenceId: "REF-1" },
      sovits: { enabled: false, url: "http://10.0.0.2:9880" },
    },
    referenceImages: [{ id: "ri-1", name: "小猫", description: "喵" }],
    roles: [
      {
        id: "r-1",
        name: "小柚",
        // 角色上塞密钥：应该被丢掉（normalizeVoiceSend 只留 enabled + voiceId）
        voiceSend: { enabled: true, voiceId: "v-1", key: "SECRET-ON-ROLE" },
      },
    ],
  });

  const shared = JSON.parse(fs.readFileSync(path.join(TMP, "config.json"), "utf-8"));
  const secrets = JSON.parse(fs.readFileSync(path.join(TMP, "data.config.json"), "utf-8"));

  /*
   * 结构留着、值抹空 —— writeToDisk 里那个 `ttsApi: {}` 会再过一遍
   * normalizeConfig，所以磁盘上是一份「字段齐全但凭据为空」的壳子。
   * 前端因此不用到处判 undefined，而真凭据一个字符都不在这份文件里。
   */
  assert.deepEqual(Object.keys(shared.ttsApi).sort(), ["elevenlabs", "fish", "minimax", "sovits"]);
  assert.equal(shared.ttsApi.fish.key, "");
  assert.equal(JSON.stringify(shared).includes("SECRET-FA"), false);
  assert.equal(shared.ttsApi.minimax.key, "");
  assert.equal(shared.ttsApi.minimax.groupId, "");
  assert.equal(shared.ttsApi.elevenlabs.key, "");
  assert.equal(shared.ttsApi.sovits.url, "");
  // enabled 跟着密钥一起走（它和密钥在同一个对象里，整块抹空）
  assert.equal(shared.ttsApi.minimax.enabled, false);
  ok("config.json 里 ttsApi 只剩空壳，一个凭据都没有");

  // 只看结构，不打印内容
  assert.equal(Boolean(secrets.ttsKeys?.minimax?.key), true);
  assert.equal(secrets.ttsKeys.minimax.enabled, true);
  assert.equal(secrets.ttsKeys.sovits.enabled, false);
  assert.equal(Boolean(secrets.ttsKeys?.fish?.key), true);
  ok("data.config.json 里 ttsKeys 有值，enabled 跟着密钥一起走");

  // 图库不含密钥，留在能分享的那份里（换台机器导入角色还认得出 [小猫]）
  assert.deepEqual(shared.referenceImages?.map((r) => r.name), ["小猫"]);
  ok("referenceImages 留在 config.json（它不是密钥）");

  const roleOnDisk = JSON.parse(
    fs.readFileSync(path.join(TMP, "characters", fs.readdirSync(path.join(TMP, "characters"))[0]), "utf-8")
  );
  assert.equal(roleOnDisk.voiceSend.key, undefined);
  assert.equal(roleOnDisk.voiceSend.voiceId, "v-1");
  ok("角色上塞的密钥被丢掉，音色 ID 留着");

  // 往返：读回来还是原来那份（少写一处 mergeSecrets 就会在这里断）
  const back = loadConfig();
  assert.equal(back.ttsApi.minimax.enabled, true);
  assert.equal(Boolean(back.ttsApi.minimax.key), true);
  assert.equal(back.ttsApi.minimax.groupId, "GID");
  assert.equal(Boolean(back.ttsApi.elevenlabs.key), true);
  ok("重启后读回来配置还在（mergeSecrets 往返）");
}

console.log("\n[配置：生图模型是全局挑的]");
{
  assert.equal(resolveImageEndpoint({ providers: [] }), null);
  ok("一个生图模型都没有 → null（调用方据此提示去连接里勾分类）");

  const cfg = {
    providers: [
      {
        id: "p1",
        name: "甲源",
        url: "https://a.example.com/v1",
        keys: ["K1"],
        models: [
          { id: "m1", model: "gpt-4o", enabled: true, categories: ["chat"] },
          // 关着的不算 —— 列出来也打不通
          { id: "m2", model: "sd-off", enabled: false, categories: ["image"] },
          {
            id: "m3",
            model: "sd-xl",
            enabled: true,
            categories: ["image"],
            imagePrompt: "masterpiece, best quality",
            negativePrompt: "lowres, bad hands",
          },
        ],
      },
    ],
  };
  const ep = resolveImageEndpoint(cfg);
  assert.equal(ep.model, "sd-xl");
  assert.equal(ep.url, "https://a.example.com/v1");
  assert.equal(ep.positivePrompt, "masterpiece, best quality");
  assert.equal(ep.negativePrompt, "lowres, bad hands");
  ok("挑第一个「开着 + 有 image 分类」的，带出它自己的正负面提示词");
}

/* ================= 5. TTS 适配器（假 fetch） ================= */

console.log("\n[TTS：挑哪一家]");
{
  const cfg = normalizeConfig({}).ttsApi;
  assert.equal(pickTtsSource(cfg), null);
  ok("三家都没开 → null（调用方退化成文字）");

  // 开着但密钥空：不算数，不然会打出一次必然 401 的请求
  assert.equal(pickTtsSource({ ...cfg, minimax: { enabled: true, key: "" } }), null);
  ok("开着但凭据没填全 → 仍然是 null");

  assert.equal(pickTtsSource({ ...cfg, minimax: { enabled: true, key: "k" } }).name, "MiniMax");
  assert.equal(
    pickTtsSource({ ...cfg, elevenlabs: { enabled: true, key: "k" } }).name,
    "ElevenLabs"
  );
  assert.equal(
    pickTtsSource({ ...cfg, sovits: { enabled: true, url: "http://x" } }).name,
    "GPT-SoVITS"
  );
  assert.equal(pickTtsSource({ ...cfg, fish: { enabled: true, key: "k" } }).name, "Fish Audio");
  assert.equal(pickTtsSource({ ...cfg, fish: { enabled: true, key: " " } }), null);
  ok("四家各自认得出来（Fish Audio 密钥空白不算数）");

  const all = pickTtsSource({
    minimax: { enabled: true, key: "k" },
    elevenlabs: { enabled: true, key: "k" },
    fish: { enabled: true, key: "k" },
    sovits: { enabled: true, url: "http://x" },
  });
  assert.equal(all.name, "MiniMax");
  assert.equal(
    pickTtsSource({ fish: { enabled: true, key: "k" }, sovits: { enabled: true, url: "http://x" } }).name,
    "Fish Audio"
  );
  ok("都开着时按 minimax → elevenlabs → fish → sovits 的顺序");

  // 语气标签认不认跟着模型走：[whispers] 这类是 ElevenLabs v3 的功能
  assert.equal(pickTtsSource({ minimax: { enabled: true, key: "k" } }).keepTags, undefined);
  assert.equal(
    pickTtsSource({ sovits: { enabled: true, url: "http://x" } }).keepTags,
    undefined
  );
  assert.equal(
    pickTtsSource({ elevenlabs: { enabled: true, key: "k" } }).keepTags,
    false,
    "默认模型 v2 不认标签"
  );
  assert.equal(
    pickTtsSource({ elevenlabs: { enabled: true, key: "k", model: "eleven_multilingual_v2" } })
      .keepTags,
    false
  );
  assert.equal(
    pickTtsSource({ elevenlabs: { enabled: true, key: "k", model: "eleven_v3" } }).keepTags,
    true
  );
  ok("keepTags：ElevenLabs 只有 v3 模型留着语气标签");

  // Fish Audio S2 系列认 [方括号] 标签；s1 用的是 (圆括号)，方括号会被念出来
  assert.equal(pickTtsSource({ fish: { enabled: true, key: "k" } }).keepTags, true);
  assert.equal(pickTtsSource({ fish: { enabled: true, key: "k", model: "s2-pro" } }).keepTags, true);
  assert.equal(pickTtsSource({ fish: { enabled: true, key: "k", model: "s1" } }).keepTags, false);
  ok("keepTags：Fish Audio 默认（S2）保留，s1 剥掉");

  const n = normalizeConfig({
    ttsApi: { minimax: { speed: 9 }, fish: { enabled: 1, key: " k ", speed: 0.1, model: " s1 " } },
  }).ttsApi;
  assert.equal(n.minimax.speed, 2);
  assert.equal(n.fish.speed, 0.5);
  assert.equal(n.fish.key, "k");
  assert.equal(n.fish.model, "s1");
  assert.equal(n.fish.enabled, true);
  assert.equal(normalizeConfig({}).ttsApi.fish.speed, 1);
  assert.equal(normalizeConfig({}).ttsApi.minimax.speed, 1);
  ok("语速：MiniMax / Fish 都夹在 0.5–2，默认 1");
}

console.log("\n[TTS：语气标签剥不剥]");
{
  const realFetch = globalThis.fetch;
  try {
    const bodies = [];
    globalThis.fetch = async (url, init) => {
      bodies.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      if (String(url).includes("elevenlabs")) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      return new Response(
        JSON.stringify({ data: { audio: "494433" }, base_resp: { status_code: 0 } }),
        { status: 200 }
      );
    };

    // MiniMax 不认标签：剥掉再合成，别让语音里真的念出一句 "whispers"
    await synthesizeVoice(
      { minimax: { enabled: true, key: "k", groupId: "G" } },
      "v",
      "[whispers] 过来 [sighs] 坐下",
      "测试"
    );
    assert.equal(bodies[0].body.text, "过来 坐下");
    ok("MiniMax：请求里的 text 已剥掉语气标签");

    // v2 同理；v3 认标签，原样保留
    await synthesizeVoice(
      { elevenlabs: { enabled: true, key: "k", model: "eleven_multilingual_v2" } },
      "v",
      "[whispers] 过来",
      "测试"
    );
    assert.equal(bodies[1].body.text, "过来");
    await synthesizeVoice(
      { elevenlabs: { enabled: true, key: "k", model: "eleven_v3" } },
      "v",
      "[whispers] 过来",
      "测试"
    );
    assert.equal(bodies[2].body.text, "[whispers] 过来");
    ok("ElevenLabs：v2 剥掉、v3 原样保留");

    // MiniMax 语速进 voice_setting.speed
    await synthesizeVoice(
      { minimax: { enabled: true, key: "k", groupId: "G", speed: 1.3 } },
      "v",
      "你好",
      "测试"
    );
    assert.equal(bodies[3].body.voice_setting.speed, 1.3);
    ok("MiniMax：语速写进 voice_setting.speed");

    // stripToneTags 本体：全角也认；整条都是标签时剥成空串 —— synthesizeVoice
    // 见空会留着原样交给合成那边，这里只验剥的部分
    assert.equal(stripToneTags("［气声］过来［叹气］坐好。"), "过来 坐好。");
    assert.equal(stripToneTags("没有标签的话"), "没有标签的话");
    assert.equal(stripToneTags("[laughs]"), "");
    ok("stripToneTags：全角认、没标签不动、整条都是标签时剥成空串");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("\n[TTS：三家的响应形状]");

console.log("\n[TTS：三家的响应形状]");
{
  const realFetch = globalThis.fetch;
  const seen = [];
  try {
    // --- MiniMax：data.audio 是 hex，不是 base64（按 base64 解会得到一堆噪音）
    globalThis.fetch = async (url, init) => {
      seen.push({ url: String(url), init });
      return new Response(
        JSON.stringify({ data: { audio: "494433" }, base_resp: { status_code: 0 } }),
        { status: 200 }
      );
    };
    let out = await synthesizeVoice(
      { minimax: { enabled: true, key: "k", groupId: "G", model: "speech-02-hd" } },
      "voice-x",
      "我刚下班",
      "测试"
    );
    assert.deepEqual([...out.buffer], [0x49, 0x44, 0x33]);
    assert.equal(out.mimeType, "audio/mpeg");
    assert.equal(out.source, "MiniMax");
    ok("MiniMax：hex 解成字节（不是 base64）");

    assert.ok(seen[0].url.includes("GroupId=G"), seen[0].url);
    ok("MiniMax：GroupId 走查询参数（少了它直接 401）");

    // 地区二选一：国内和海外是两套互不通用的域名，密钥也不通用
    assert.ok(seen[0].url.startsWith("https://api.minimaxi.com/"), seen[0].url);
    ok("MiniMax：region 默认国内，打 api.minimaxi.com");
    {
      // 这两条各自记自己的请求，不动外面那个 seen —— 后面还要拿 seen[0] 断音色 ID
      const urls = [];
      const prev = globalThis.fetch;
      globalThis.fetch = async (url) => {
        urls.push(String(url));
        return new Response(
          JSON.stringify({ data: { audio: "494433" }, base_resp: { status_code: 0 } }),
          { status: 200 }
        );
      };
      await synthesizeVoice(
        { minimax: { enabled: true, key: "k", groupId: "G", region: "global" } },
        "",
        "x",
        "测试"
      );
      assert.ok(urls[0].startsWith("https://api.minimax.io/"), urls[0]);
      ok("MiniMax：region=global 打 api.minimax.io");

      // 自建反代优先于地区选择，别把人家能用的配置改坏
      await synthesizeVoice(
        { minimax: { enabled: true, key: "k", region: "global", host: "https://my.proxy/" } },
        "",
        "x",
        "测试"
      );
      assert.ok(urls[1].startsWith("https://my.proxy/v1/t2a_v2"), urls[1]);
      ok("MiniMax：配了 host 时以 host 为准，末尾斜杠不会拼出 //");
      globalThis.fetch = prev;
    }
    {
      const body = JSON.parse(seen[0].init.body);
      assert.equal(body.voice_setting.voice_id, "voice-x");
      assert.equal(body.output_format, "hex");
      ok("MiniMax：角色的音色 ID 传进 voice_setting");
    }

    // HTTP 200 也不代表成功，还要看 base_resp.status_code
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ base_resp: { status_code: 1004, status_msg: "鉴权失败" } }), {
        status: 200,
      });
    await assert.rejects(
      () => synthesizeVoice({ minimax: { enabled: true, key: "k" } }, "", "x", "测试"),
      /1004|鉴权失败/
    );
    ok("MiniMax：HTTP 200 但 base_resp 报错 → 抛错");

    /*
     * 连接抖动重试一次。
     *
     * 走代理的时候 UND_ERR_CONNECT_TIMEOUT 是常态 —— 同一个配置上一条刚成功、
     * 下一条就连不上。一次连接抖动不该让这条语音退化成文字。
     */
    {
      let calls = 0;
      globalThis.fetch = async () => {
        calls += 1;
        if (calls === 1) {
          const e = new Error("fetch failed");
          e.cause = { code: "UND_ERR_CONNECT_TIMEOUT" };
          throw e;
        }
        return new Response(
          JSON.stringify({ data: { audio: "494433" }, base_resp: { status_code: 0 } }),
          { status: 200 }
        );
      };
      const retried = await synthesizeVoice(
        { minimax: { enabled: true, key: "k", groupId: "G" } },
        "",
        "你好",
        "测试"
      );
      assert.equal(calls, 2);
      assert.deepEqual([...retried.buffer], [0x49, 0x44, 0x33]);
      ok("连接超时会重试一次，第二次成功就当成功");
    }
    {
      // 鉴权失败重试只是多花一次钱、多等一个超时，所以不重试
      let calls = 0;
      globalThis.fetch = async () => {
        calls += 1;
        return new Response(
          JSON.stringify({ base_resp: { status_code: 1004, status_msg: "鉴权失败" } }),
          { status: 200 }
        );
      };
      await assert.rejects(
        () => synthesizeVoice({ minimax: { enabled: true, key: "k" } }, "", "x", "测试"),
        /1004|鉴权失败/
      );
      assert.equal(calls, 1);
      ok("上游明确报错（鉴权/余额/参数）不重试");
    }
    {
      // 一直连不上：重试一次之后就放弃，不能连着吃两个超时还继续
      let calls = 0;
      globalThis.fetch = async () => {
        calls += 1;
        const e = new Error("fetch failed");
        e.cause = { code: "ECONNRESET" };
        throw e;
      };
      await assert.rejects(
        () => synthesizeVoice({ minimax: { enabled: true, key: "k" } }, "", "x", "测试"),
        /ECONNRESET|合成失败/
      );
      assert.equal(calls, 2);
      ok("一直连不上时只试 2 次就放弃（语音是同步发的，不能干等）");
    }

    // --- ElevenLabs：响应直接是二进制 mp3，音色 ID 在路径里
    seen.length = 0;
    globalThis.fetch = async (url, init) => {
      seen.push({ url: String(url), init });
      return new Response(PNG_MAGIC, { status: 200 });
    };
    out = await synthesizeVoice(
      { elevenlabs: { enabled: true, key: "k" } },
      "VOICE-ID",
      "你好",
      "测试"
    );
    assert.equal(out.buffer.length, PNG_MAGIC.length);
    assert.equal(out.ext, "mp3");
    assert.ok(seen[0].url.includes("/text-to-speech/VOICE-ID"), seen[0].url);
    assert.equal(seen[0].init.headers["xi-api-key"], "k");
    ok("ElevenLabs：音色 ID 在路径、密钥走 xi-api-key、响应是裸二进制");

    // --- Fish Audio：模型走请求头 model，音色是 body.reference_id，语速在 prosody.speed
    seen.length = 0;
    globalThis.fetch = async (url, init) => {
      seen.push({ url: String(url), init });
      return new Response(PNG_MAGIC, { status: 200 });
    };
    out = await synthesizeVoice(
      { fish: { enabled: true, key: "fk", model: "s2-pro", referenceId: "FALLBACK", speed: 1.2 } },
      "REF-ID",
      "[whispers] 你好",
      "测试"
    );
    assert.equal(out.source, "Fish Audio");
    assert.equal(out.buffer.length, PNG_MAGIC.length);
    assert.equal(seen[0].url, "https://api.fish.audio/v1/tts");
    assert.equal(seen[0].init.headers.Authorization, "Bearer fk");
    assert.equal(seen[0].init.headers.model, "s2-pro");
    {
      const body = JSON.parse(seen[0].init.body);
      assert.equal(body.reference_id, "REF-ID");
      assert.equal(body.prosody.speed, 1.2);
      assert.equal(body.format, "mp3");
      assert.equal(body.text, "[whispers] 你好", "S2 认方括号标签，原样保留");
    }
    ok("Fish Audio：Bearer + 头里的 model；角色音色优先于兜底；语速进 prosody");

    // 角色没填音色 → 用兜底 referenceId；模型空 → 不带 model 头（服务端默认）
    seen.length = 0;
    await synthesizeVoice({ fish: { enabled: true, key: "fk", referenceId: "FALLBACK" } }, "", "你好", "测试");
    assert.equal(JSON.parse(seen[0].init.body).reference_id, "FALLBACK");
    assert.equal("model" in seen[0].init.headers, false);
    ok("Fish Audio：角色音色空时用兜底 ID；模型空时不带 model 头");

    // 报错是 JSON {status, message}
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ status: 402, message: "Insufficient balance" }), { status: 402 });
    await assert.rejects(
      () => synthesizeVoice({ fish: { enabled: true, key: "fk" } }, "", "你好", "测试"),
      /402|Insufficient/
    );
    ok("Fish Audio：非 2xx → 抛错并带上服务端的 message");

    // --- SoVITS：没有密钥，但 ref_audio_path 每次都要传
    seen.length = 0;
    globalThis.fetch = async (url, init) => {
      seen.push({ url: String(url), init });
      return new Response(Buffer.from("RIFFxxxx"), { status: 200 });
    };
    out = await synthesizeVoice(
      { sovits: { enabled: true, url: "http://127.0.0.1:9880/", textLang: "zh" } },
      "/root/ref.wav",
      "你好",
      "测试"
    );
    assert.equal(out.mimeType, "audio/wav");
    assert.equal(seen[0].url, "http://127.0.0.1:9880/tts");
    assert.equal(JSON.parse(seen[0].init.body).ref_audio_path, "/root/ref.wav");
    ok("SoVITS：末尾斜杠不会拼出 //tts；音色 ID 当参考音频路径传");

    // 参考音频一个都没有：本地就拦下来，别打一次必然 400 的请求
    await assert.rejects(
      () => synthesizeVoice({ sovits: { enabled: true, url: "http://x" } }, "", "你好", "测试"),
      /参考音频/
    );
    ok("SoVITS：参考音频路径为空 → 本地就报错");

    // --- 公共部分
    await assert.rejects(
      () => synthesizeVoice(normalizeConfig({}).ttsApi, "", "你好", "测试"),
      /没有可用的语音合成服务/
    );
    ok("一家都没配 → 抛「没有可用的语音合成服务」");

    globalThis.fetch = async () => new Response("upstream is down", { status: 500 });
    await assert.rejects(
      () => synthesizeVoice({ minimax: { enabled: true, key: "k" } }, "", "你好", "测试"),
      /MiniMax.*500/
    );
    ok("上游 5xx → 错误里带上是哪家、什么状态码");
  } finally {
    globalThis.fetch = realFetch;
  }
}

/* ================= 6. 生图适配器（假 fetch） ================= */

console.log("\n[生图：文生图]");
{
  const realFetch = globalThis.fetch;
  const seen = [];
  const ep = {
    url: "https://a.example.com/v1/",
    key: "K1",
    model: "sd-xl",
    label: "甲源 · sd-xl",
    positivePrompt: "masterpiece",
    negativePrompt: "lowres",
  };
  try {
    globalThis.fetch = async (url, init) => {
      seen.push({ url: String(url), init });
      return new Response(
        JSON.stringify({ data: [{ b64_json: PNG_MAGIC.toString("base64") }] }),
        { status: 200 }
      );
    };

    const out = await generateImage(ep, { prompt: "一只橘猫" }, "测试");
    assert.deepEqual([...out.buffer], [...PNG_MAGIC]);
    assert.equal(out.mimeType, "image/png");
    assert.equal(out.ext, "png");
    ok("b64_json 解成字节，按魔数认出是 png");

    assert.equal(seen[0].url, "https://a.example.com/v1/images/generations");
    ok("末尾斜杠不会拼出 //images/generations");

    const body = JSON.parse(seen[0].init.body);
    assert.equal(body.prompt, "masterpiece, 一只橘猫");
    assert.equal(body.negative_prompt, "lowres");
    assert.equal(body.model, "sd-xl");
    assert.equal(body.size, undefined);
    ok("正面提示词拼在前面、负面走 negative_prompt、不传 size");

    assert.equal(seen[0].init.headers.Authorization, "Bearer K1");
    ok("密钥走 Bearer 头");

    // 中转站的字段名五花八门，几种都认
    for (const [name, payload] of [
      ["images 数组", { images: [{ b64_json: PNG_MAGIC.toString("base64") }] }],
      ["output 数组", { output: [{ b64: PNG_MAGIC.toString("base64") }] }],
      ["元素直接是 base64 字符串", { data: [PNG_MAGIC.toString("base64")] }],
      ["带 data: 前缀", { data: [{ b64_json: `data:image/png;base64,${PNG_MAGIC.toString("base64")}` }] }],
    ]) {
      globalThis.fetch = async () => new Response(JSON.stringify(payload), { status: 200 });
      const r = await generateImage(ep, { prompt: "猫" }, "测试");
      assert.deepEqual([...r.buffer], [...PNG_MAGIC], name);
    }
    ok("data / images / output、裸字符串、data: 前缀都认");

    // 返回的是链接：再取一次字节
    let hops = 0;
    globalThis.fetch = async (url) => {
      hops += 1;
      return String(url).startsWith("https://cdn.")
        ? new Response(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), { status: 200 })
        : new Response(JSON.stringify({ data: [{ url: "https://cdn.example.com/a.jpg" }] }), {
            status: 200,
          });
    };
    const viaUrl = await generateImage(ep, { prompt: "猫" }, "测试");
    assert.equal(hops, 2);
    assert.equal(viaUrl.mimeType, "image/jpeg");
    ok("返回图片链接时再取一次字节，按魔数认出 jpeg");

    /*
     * 取链接那一下握手超时：图已经画好、钱已经扣了，只重新下载，不重新出图。
     * 实测 open.kcai.asia 直连偶尔 UND_ERR_CONNECT_TIMEOUT。
     */
    let gens = 0;
    let pulls = 0;
    globalThis.fetch = async (url) => {
      if (!String(url).startsWith("https://cdn.")) {
        gens += 1;
        return new Response(JSON.stringify({ data: [{ url: "https://cdn.example.com/a.jpg" }] }));
      }
      pulls += 1;
      if (pulls < 3) {
        const e = new TypeError("fetch failed");
        e.cause = { code: "UND_ERR_CONNECT_TIMEOUT" };
        throw e;
      }
      return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    };
    await generateImage(ep, { prompt: "猫" }, "测试");
    assert.equal(gens, 1);
    assert.equal(pulls, 3);
    ok("取图片链接连不上 → 只重新下载（最多三次），不重新出图");

    gens = 0;
    pulls = 0;
    globalThis.fetch = async (url) => {
      if (!String(url).startsWith("https://cdn.")) {
        gens += 1;
        return new Response(JSON.stringify({ data: [{ url: "https://cdn.example.com/a.jpg" }] }));
      }
      pulls += 1;
      return new Response("gone", { status: 404 });
    };
    await assert.rejects(() => generateImage(ep, { prompt: "猫" }, "测试"), /图画好了.*404/);
    assert.equal(gens, 1);
    assert.equal(pulls, 1);
    ok("图片链接 404 → 不重取，报「图画好了但取不到」");

    // 出错路径
    globalThis.fetch = async () => new Response("<html>502 Bad Gateway</html>", { status: 502 });
    await assert.rejects(() => generateImage(ep, { prompt: "猫" }, "测试"), /502/);
    ok("上游报错 → 抛错并带上状态码");

    globalThis.fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });
    await assert.rejects(() => generateImage(ep, { prompt: "猫" }, "测试"), /没有图片/);
    ok("200 但没有图片 → 抛错（不静默返回空 Buffer）");

    await assert.rejects(() => generateImage(ep, { prompt: "  " }, "测试"), /画面描述是空的/);
    await assert.rejects(() => generateImage({ model: "x" }, { prompt: "猫" }, "测试"), /接口地址/);
    ok("描述为空 / 没填地址 → 本地就拦下来");
  } finally {
    globalThis.fetch = realFetch;
  }
}

/*
 * 上游不认某个可选字段就剥掉重发。
 *
 * 这一段对应用户报的「测试能出图、快捷指令和角色自己出图就 400」—— 其实和
 * 入口无关：官方 gpt-image 系列会因为不认识的字段把整个请求 400 掉，
 * 而一家中转站背后挂着好几条渠道，轮到严格的那条就 400、宽松的那条就出图，
 * 于是看起来像「一会儿行一会儿不行」。
 */
console.log("\n[生图：上游不认某个可选字段就剥掉重发]");
{
  const realFetch = globalThis.fetch;
  const ep = {
    url: "https://a.example.com/v1",
    key: "K1",
    model: "gpt-image-2.5",
    label: "dzz · gpt-image-2.5",
    negativePrompt: "lowres",
    ratio: { key: "9:16", size: "768x1344" },
  };
  const okBody = JSON.stringify({ data: [{ b64_json: PNG_MAGIC.toString("base64") }] });
  const unknownParam = (name) =>
    new Response(
      JSON.stringify({
        error: {
          message: `Unknown parameter: '${name}'.`,
          type: "invalid_request_error",
          param: name,
          code: "unknown_parameter",
        },
      }),
      { status: 400 }
    );

  try {
    // 一发就中：aspect_ratio 被嫌弃，去掉它第二发成功
    let bodies = [];
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return bodies.length === 1 ? unknownParam("aspect_ratio") : new Response(okBody);
    };
    let out = await generateImage(ep, { prompt: "毛血旺" }, "测试");
    assert.deepEqual([...out.buffer], [...PNG_MAGIC]);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].aspect_ratio, "9:16");
    assert.equal("aspect_ratio" in bodies[1], false);
    ok("400 说不认 aspect_ratio → 去掉它重发，这一发出图成功");

    /*
     * response_format 压根不发。要 b64_json 的话上游得把整张 PNG 编进响应，
     * 实测 5w5.wtf 的 gpt-image-2.5 九次只成两次、其余卡在中转站 60 秒那条线上 504，
     * 不要就十五次成十三次 —— 「Cherry Studio 能出、这边不能」差的就是它。
     */
    assert.equal("response_format" in bodies[0], false);
    ok("出图请求不带 response_format（让上游回链接，别逼它塞 base64）");

    // 剩下的字段一个都不许丢：少发 prompt 或 model 的话这次重发毫无意义
    assert.equal(bodies[1].prompt, "毛血旺");
    assert.equal(bodies[1].model, "gpt-image-2.5");
    assert.equal(bodies[1].negative_prompt, "lowres");
    assert.equal(bodies[1].size, "768x1344");
    ok("只剥被点名的那一个，描述 / 模型 / 负面 / 尺寸照旧");

    // 连着撞好几个：n → aspect_ratio → 成功
    bodies = [];
    globalThis.fetch = async (_url, init) => {
      const b = JSON.parse(init.body);
      bodies.push(b);
      if ("n" in b) return unknownParam("n");
      if ("aspect_ratio" in b) return unknownParam("aspect_ratio");
      return new Response(okBody);
    };
    out = await generateImage(ep, { prompt: "毛血旺" }, "测试");
    assert.deepEqual([...out.buffer], [...PNG_MAGIC]);
    assert.equal(bodies.length, 3);
    assert.equal(bodies[2].size, "768x1344");
    ok("一轮剥一个，连着撞两个也能收敛（aspect_ratio 走了 size 还留着）");

    // 给不出 param 的站：从 message 里抠引号里那个词
    bodies = [];
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return bodies.length === 1
        ? new Response(
            JSON.stringify({ error: { message: "unsupported parameter \"negative_prompt\"" } }),
            { status: 400 }
          )
        : new Response(okBody);
    };
    await generateImage(ep, { prompt: "毛血旺" }, "测试");
    assert.equal("negative_prompt" in bodies[1], false);
    ok("没有 param 字段时从 message 里抠字段名");

    // 400 但不是「不认识某字段」：原样抛出去，别把 prompt 剥成空请求
    let hits = 0;
    globalThis.fetch = async () => {
      hits += 1;
      return new Response(
        JSON.stringify({
          error: { message: "Invalid value: '768x1344'", param: "size", code: "invalid_value" },
        }),
        { status: 400 }
      );
    };
    await assert.rejects(() => generateImage(ep, { prompt: "毛血旺" }, "测试"), /400/);
    // size 在白名单里，所以这里会剥一次；剥完还是 400 就不再试了
    assert.equal(hits, 2);
    ok("剥完还是 400 → 老老实实抛错，不无限重发");

    hits = 0;
    globalThis.fetch = async () => {
      hits += 1;
      return new Response(
        JSON.stringify({ error: { message: "Unknown parameter: 'prompt'.", param: "prompt" } }),
        { status: 400 }
      );
    };
    await assert.rejects(() => generateImage(ep, { prompt: "毛血旺" }, "测试"), /400/);
    assert.equal(hits, 1);
    ok("被点名的是 prompt / model 这种必需字段 → 一次都不剥（剥了请求就没意义了）");

    // 内容审查那类 400 也不该被当成「字段问题」反复发
    hits = 0;
    globalThis.fetch = async () => {
      hits += 1;
      return new Response(
        JSON.stringify({ error: { message: "Your request was rejected by safety system" } }),
        { status: 400 }
      );
    };
    await assert.rejects(() => generateImage(ep, { prompt: "毛血旺" }, "测试"), /400/);
    assert.equal(hits, 1);
    ok("认不出字段名的 400（比如内容审查）只发一次");

    /*
     * HTTP 200 装着一个报错。
     *
     * 用户日志里同一个 `Unknown parameter: 'response_format'`，这家中转站有时给
     * 400、有时给 200。给 200 的那次原来报「缺 data 数组」，剥字段那条路没走到。
     */
    bodies = [];
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length > 1) return new Response(okBody);
      const r = unknownParam("aspect_ratio");
      return new Response(await r.text(), { status: 200 });
    };
    out = await generateImage(ep, { prompt: "毛血旺" }, "测试");
    assert.deepEqual([...out.buffer], [...PNG_MAGIC]);
    assert.equal(bodies.length, 2);
    assert.equal("aspect_ratio" in bodies[1], false);
    ok("200 但响应体是「不认某个字段」→ 一样剥掉重发");

    hits = 0;
    globalThis.fetch = async () => {
      hits += 1;
      return new Response(JSON.stringify({ error: { message: "insufficient balance" } }), {
        status: 200,
      });
    };
    await assert.rejects(
      () => generateImage(ep, { prompt: "毛血旺" }, "测试"),
      /HTTP 200.*insufficient balance/
    );
    assert.equal(hits, 1);
    ok("200 装着认不出字段的报错 → 原样报出来（说清是 200），不重发");

    // 图出来了、顺带捎了个 error 字段：图照收，别当失败
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          data: [{ b64_json: PNG_MAGIC.toString("base64") }],
          error: { message: "deprecated field ignored" },
        })
      );
    out = await generateImage(ep, { prompt: "毛血旺" }, "测试");
    assert.deepEqual([...out.buffer], [...PNG_MAGIC]);
    ok("有图又带 error 字段的 200 → 图照收");

    // 图生图那条路也要跟着剥 —— 发的是同一份字段，只是换了 multipart 的载体
    const forms = [];
    globalThis.fetch = async (_url, init) => {
      forms.push(init.body);
      return forms.length === 1 ? unknownParam("aspect_ratio") : new Response(okBody);
    };
    await generateImage(ep, { prompt: "让它躺下", refFile: resolveRefFile("小猫") }, "测试");
    assert.equal(forms.length, 2);
    assert.equal(forms[0].get("response_format"), null);
    assert.equal(forms[1].get("aspect_ratio"), null);
    assert.equal(forms[1].get("prompt"), "让它躺下");
    // 参考图那个文件字段得还在，不然第二发等于降级成了文生图
    assert.equal(forms[1].get("image")?.name, "小猫.png");
    ok("图生图同样剥字段，参考图文件还在（不会静默降级成文生图）");
  } finally {
    globalThis.fetch = realFetch;
  }
}

/*
 * 上游抖一下不该让这张图彻底发不出去。
 *
 * 用户的原话是「同一把密钥同一个模型名，我在 Cherry Studio 里能正常出」——
 * 那边失败了他会手点一下重发，而这边原来一次都不重，于是中转站一次 504 / 一次
 * 「连不上上游渠道」就是一张图没了。
 *
 * **这里只测「重试了没有」和「该不该重」，不测把重试次数耗尽。** 耗尽要真等完
 * 1.2s + 5s 的退避，理由同 test-video.mjs:762 那条注释：一条断言不值得让整个
 * 套件多跑六秒，而次数上限就是两行 `+= 1`，不是会跑歪的逻辑。
 */
console.log("\n[生图：上游抖动会重试]");
{
  const realFetch = globalThis.fetch;
  const ep = {
    url: "https://a.example.com/v1",
    key: "K1",
    model: "gpt-image-2.5",
    label: "55 · gpt-image-2.5",
  };
  const okBody = JSON.stringify({ data: [{ b64_json: PNG_MAGIC.toString("base64") }] });

  try {
    // 504：中转站超时，第二发就好了
    let hits = 0;
    globalThis.fetch = async () => {
      hits += 1;
      return hits === 1 ? new Response("upstream timeout", { status: 504 }) : new Response(okBody);
    };
    let out = await generateImage(ep, { prompt: "毛血旺" }, "测试");
    assert.deepEqual([...out.buffer], [...PNG_MAGIC]);
    assert.equal(hits, 2);
    ok("504 会重试，第二发成功就当成功");

    // 429：限流，同样值得再等一下
    hits = 0;
    globalThis.fetch = async () => {
      hits += 1;
      return hits === 1 ? new Response("rate limited", { status: 429 }) : new Response(okBody);
    };
    await generateImage(ep, { prompt: "毛血旺" }, "测试");
    assert.equal(hits, 2);
    ok("429 会重试");

    /*
     * 中转站拿 404 转述「我连不上上游渠道」。
     *
     * 这是最坑的一种：404 的字面意思是「没有这个模型」「地址填错了」，会把人
     * 带到配置里去查，而实际上同一个配置下一发就可能轮到一条通的渠道。
     */
    hits = 0;
    globalThis.fetch = async () => {
      hits += 1;
      return hits === 1
        ? new Response(JSON.stringify({ error: { type: "openai_error", message: "404" } }), {
            status: 404,
          })
        : new Response(okBody);
    };
    await generateImage(ep, { prompt: "毛血旺" }, "测试");
    assert.equal(hits, 2);
    ok("中转站拿 404 转述的上游故障（openai_error）会重试");

    // 干净的 404 是真·模型名写错，重试一百次也一样
    hits = 0;
    globalThis.fetch = async () => {
      hits += 1;
      return new Response(JSON.stringify({ error: { message: "model not found" } }), {
        status: 404,
      });
    };
    await assert.rejects(() => generateImage(ep, { prompt: "毛血旺" }, "测试"), /404/);
    assert.equal(hits, 1);
    ok("干净的 404（模型名写错）不重试");

    // 401 / 余额不足这类：重试只是多烧一次额度
    hits = 0;
    globalThis.fetch = async () => {
      hits += 1;
      return new Response("bad key", { status: 401 });
    };
    await assert.rejects(() => generateImage(ep, { prompt: "毛血旺" }, "测试"), /401/);
    assert.equal(hits, 1);
    ok("鉴权失败不重试");

    // 连接层抖动（走代理时是常态）
    hits = 0;
    globalThis.fetch = async () => {
      hits += 1;
      if (hits === 1) {
        const e = new Error("fetch failed");
        e.cause = { code: "ECONNRESET" };
        throw e;
      }
      return new Response(okBody);
    };
    await generateImage(ep, { prompt: "毛血旺" }, "测试");
    assert.equal(hits, 2);
    ok("连接被掐断会重试");

    /*
     * 我们自己的请求超时不重试。
     *
     * 用户日志里的样子：一条慢渠道 66s 出图，下一次正好 90s 被掐断。等满一整个
     * 超时说明上游在画、只是慢，再发一次只会让对方多等一整轮、按次计费的再扣一次。
     */
    hits = 0;
    globalThis.fetch = async () => {
      hits += 1;
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };
    await assert.rejects(() => generateImage(ep, { prompt: "毛血旺" }, "测试"), /生图请求失败/);
    assert.equal(hits, 1);
    ok("请求超时（TimeoutError）不重试，一次就报错");

    /*
     * 剥字段和重试是两份预算。
     *
     * 混在一个计数里的话，「剥掉 n 之后又赶上一次 504」会被当成
     * 第二次重试 —— 而这两件事一件是「把请求改对」、一件是「再碰一次运气」。
     */
    hits = 0;
    const seen = [];
    globalThis.fetch = async (_url, init) => {
      hits += 1;
      const b = JSON.parse(init.body);
      seen.push(b);
      if ("n" in b) {
        return new Response(
          JSON.stringify({ error: { message: "Unknown parameter: 'n'.", param: "n" } }),
          { status: 400 }
        );
      }
      return hits === 2 ? new Response("upstream timeout", { status: 504 }) : new Response(okBody);
    };
    out = await generateImage(ep, { prompt: "毛血旺" }, "测试");
    assert.deepEqual([...out.buffer], [...PNG_MAGIC]);
    // 1 剥字段 + 2 撞 504 + 3 成功
    assert.equal(hits, 3);
    assert.equal("n" in seen[2], false);
    ok("剥字段不占重试预算（剥完又撞 504 照样能重试成功）");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("\n[生图：图生图走 multipart]");
{
  const realFetch = globalThis.fetch;
  try {
    let hit = null;
    globalThis.fetch = async (url, init) => {
      hit = { url: String(url), init };
      return new Response(JSON.stringify({ data: [{ b64_json: PNG_MAGIC.toString("base64") }] }), {
        status: 200,
      });
    };

    await generateImage(
      { url: "https://a.example.com/v1", key: "K1", model: "sd-xl", negativePrompt: "lowres" },
      { prompt: "让它躺在地上", refFile: resolveRefFile("小猫") },
      "测试"
    );

    assert.equal(hit.url, "https://a.example.com/v1/images/edits");
    ok("有参考图 → 走 /images/edits");

    assert.ok(hit.init.body instanceof FormData, typeof hit.init.body);
    assert.equal(hit.init.body.get("prompt"), "让它躺在地上");
    assert.equal(hit.init.body.get("negative_prompt"), "lowres");
    ok("body 是 FormData，描述和负面提示词都在里面");

    const file = hit.init.body.get("image");
    assert.equal(file.name, "小猫.png");
    assert.equal(file.type, "image/png");
    assert.equal(file.size, PNG_MAGIC.length);
    ok("参考图当文件字段传上去，MIME 按后缀填");

    // boundary 要让 fetch 自己填 —— 手写 Content-Type 会让上游解不出分段
    const ct = Object.keys(hit.init.headers ?? {}).find(
      (k) => k.toLowerCase() === "content-type"
    );
    assert.equal(ct, undefined);
    ok("不手写 Content-Type（boundary 交给 fetch）");
  } finally {
    globalThis.fetch = realFetch;
  }
}

/* ================= 已读不回 ================= */

console.log("\n[已读不回：标记解析]");
{
  assert.equal(hasLeaveOnRead("[leave_on_read]"), true);
  ok("认得标准写法");

  assert.equal(hasLeaveOnRead("[LEAVE_ON_READ]"), true);
  assert.equal(hasLeaveOnRead("[Leave_On_Read]"), true);
  ok("大小写不敏感");

  assert.equal(hasLeaveOnRead("[leave on read]"), true);
  assert.equal(hasLeaveOnRead("[leave-on-read]"), true);
  ok("下划线换成空格或横线也认");

  assert.equal(hasLeaveOnRead("［leave_on_read］"), true);
  assert.equal(hasLeaveOnRead("【leave_on_read】"), true);
  ok("全角方括号和中文方头括号都认");

  assert.equal(hasLeaveOnRead("[已读不回]"), true);
  ok("中文写法也认");

  assert.equal(hasLeaveOnRead("在的，怎么了？"), false);
  assert.equal(hasLeaveOnRead(""), false);
  assert.equal(hasLeaveOnRead(null), false);
  ok("普通文字和空值不误判");

  // 这条最关键：思维链里盘算「是不是该已读不回」不能真去装死
  assert.equal(
    hasLeaveOnRead("<thinking>这里是不是该 [leave_on_read]？算了还是回一句</thinking>在的"),
    false
  );
  ok("XML 标签里的不算数（和语音/图片/搜索同一条规则）");

  assert.equal(
    hasLeaveOnRead("<thinking>盘算一下</thinking>[leave_on_read]"),
    true
  );
  ok("标签外面那个照样算");
}

console.log("\n[已读不回：把指令剥掉之后还剩什么]");
{
  assert.equal(stripLeaveOnRead("[leave_on_read]"), "");
  ok("只有指令 → 剥完是空的（这轮纯静默）");

  assert.equal(stripLeaveOnRead("[leave_on_read]别烦我"), "别烦我");
  ok("指令后面跟着文字 → 剥出那段文字（调用方会丢掉它）");

  assert.equal(stripLeaveOnRead("[leave_on_read]$别烦我"), "$别烦我");
  ok("带气泡分隔符时也剥得出来");

  assert.equal(stripLeaveOnRead("忙着呢[已读不回]"), "忙着呢");
  ok("指令在后面也剥得掉");

  assert.equal(stripLeaveOnRead("[leave on read]  [LEAVE_ON_READ]"), "");
  ok("多个不同写法一起剥干净");
}

console.log("\n[已读不回：压着角色那道闸]");
{
  const { resolvePreset } = await import("../server/src/preset.js");
  const { buildPrompt } = await import("../server/src/prompt.js");

  /** 整份提示词拼成一段，好判断某一节注没注入。 */
  const promptOf = async (config, role) => {
    const { messages } = await buildPrompt(config, role, null, [
      { role: "user", content: "在吗" },
    ]);
    return messages.map((m) => m.content).join("\n\n");
  };

  const base = normalizeConfig({
    presets: [{ id: "ps-1", name: "默认" }],
    roles: [{ id: "r-1", name: "小雨", presetRef: "ps-1" }],
  });

  // 子条目默认是开的（defaultChildEnabled 恒为 true）
  const child = resolvePreset(base, base.roles[0])
    .entries.find((e) => e.kind === "format")
    ?.children?.find((c) => c.kind === "leaveOnRead");
  assert.equal(child?.enabled, true);
  ok("（预设里那个子条目确实默认开着）");

  // 角色默认不开 → 不注入
  assert.equal((await promptOf(base, base.roles[0])).includes("leave_on_read"), false);
  ok("角色没开 → 不注入（尽管子条目是开的）");

  const onConfig = normalizeConfig({
    presets: [{ id: "ps-1", name: "默认" }],
    roles: [
      {
        id: "r-1",
        name: "小雨",
        presetRef: "ps-1",
        leaveOnRead: { enabled: true, receipt: false },
      },
    ],
  });
  const text = await promptOf(onConfig, onConfig.roles[0]);
  assert.ok(text.includes("<leave_on_read>"));
  assert.ok(text.includes("已读不回"));
  ok("角色开了 → 注入，标签名是 leave_on_read");

  // {{char}} 要换成实际名字，不能把变量原样发给模型
  assert.equal(text.includes("{{char}}"), false);
  assert.ok(text.includes("小雨"));
  ok("正文里的 {{char}} 换成了角色名");

  // 第三道闸：子条目关掉
  const off = normalizeConfig({
    presets: [
      {
        id: "ps-1",
        entries: [{ kind: "format", children: [{ kind: "leaveOnRead", enabled: false }] }],
      },
    ],
    roles: [{ id: "r-1", name: "小雨", presetRef: "ps-1", leaveOnRead: { enabled: true } }],
  });
  assert.equal((await promptOf(off, off.roles[0])).includes("leave_on_read"), false);
  ok("子条目关掉 → 角色开着也不注入");
}

console.log("\n[已读不回：角色配置的收口]");
{
  const c = normalizeConfig({ roles: [{ id: "r-1", name: "甲" }] });
  assert.deepEqual(c.roles[0].leaveOnRead, { enabled: false, receipt: false });
  ok("老配置没这个字段 → 两个开关都默认关");

  const t = normalizeConfig({
    roles: [{ id: "r-1", name: "甲", leaveOnRead: { enabled: "yes", receipt: 1 } }],
  });
  assert.deepEqual(t.roles[0].leaveOnRead, { enabled: true, receipt: true });
  ok("非布尔值收成布尔");

  // 两个开关是分开的：只要回执、不要装死是合法组合
  const only = normalizeConfig({
    roles: [{ id: "r-1", name: "甲", leaveOnRead: { receipt: true } }],
  });
  assert.deepEqual(only.roles[0].leaveOnRead, { enabled: false, receipt: true });
  ok("只开回执、不开已读不回是合法组合");
}

/* ================= 7. 界面壁纸 ================= */

console.log("\n[壁纸：文件名清洗]");
{
  // 安全边界：这个名字是浏览器传上来的，会被直接拼进落盘路径
  // 剩下的那截不含任何分隔符，后缀也被强制换成白名单里的 —— 落不到 data/ 外面去
  assert.equal(safeWallpaperName("../../data.config.json", "image/png"), "data.config.json.png");
  assert.equal(safeWallpaperName("..\\..\\config.json", "image/png"), "config.json.png");
  ok("路径穿越只剩安全的文件名，且后缀被换成白名单里的");

  assert.equal(safeWallpaperName('海:边*的?图"片<>|.jpg', "image/jpeg"), "海边的图片.jpg");
  ok("Windows 非法字符被剔掉");

  assert.equal(safeWallpaperName("风景.png", "image/png"), "风景.png");
  ok("控制字符被剔掉");

  assert.equal(safeWallpaperName(".hidden.png", "image/png"), "hidden.png");
  ok("点开头的不会落成隐藏文件");

  // 浏览器给的 name 可能压根没后缀（截图、粘贴板），按 MIME 补
  assert.equal(safeWallpaperName("截图", "image/webp"), "截图.webp");
  assert.equal(safeWallpaperName("笔记.txt", "image/jpeg"), "笔记.txt.jpg");
  ok("后缀不在白名单时按 mimeType 补一个");

  assert.equal(safeWallpaperName("", "image/png"), "壁纸.png");
  assert.equal(safeWallpaperName("///", "image/png"), "壁纸.png");
  ok("名字被剔光了也有兜底");

  // 内置那两张的名字也算「已经被占了」：传一张同名的上来不该把内置的挤下去
  assert.equal(safeWallpaperName("壁纸2.jpg", "image/jpeg"), "壁纸2-2.jpg");
  ok("和内置壁纸重名时同样往后排");
}

console.log("\n[壁纸：落盘与重名]");
{
  const first = saveWallpaper("风景.jpg", PNG_MAGIC.toString("base64"), "image/jpeg");
  const second = saveWallpaper("风景.jpg", Buffer.from("另一张").toString("base64"), "image/jpeg");
  assert.equal(first, "风景.jpg");
  assert.equal(second, "风景-2.jpg");
  ok("同名上传两次不覆盖，第二张变成 -2");

  // 第一张必须原样还在 —— 悄悄盖掉会让人以为上传失败了
  assert.deepEqual(fs.readFileSync(path.join(TMP, "wallpapers", "风景.jpg")), PNG_MAGIC);
  ok("第一张的内容没被动过");

  const listed = listWallpapers();
  const names = listed.map((w) => w.file);
  assert.ok(names.includes("风景.jpg") && names.includes("风景-2.jpg"), names.join(","));
  ok("listWallpapers 只列白名单后缀");

  // 内置的排在前面并带标记 —— 前端靠这个标记把删除按钮藏掉
  assert.deepEqual(names.slice(0, 2), ["壁纸1.jpg", "壁纸2.jpg"]);
  assert.ok(listed.slice(0, 2).every((w) => w.builtin === true));
  assert.ok(listed.slice(2).every((w) => !w.builtin));
  assert.equal(names.length, 4);
  ok("内置那两张也在清单里，排最前面且标了 builtin");
}

console.log("\n[壁纸：找文件]");
{
  assert.equal(path.basename(resolveWallpaper("风景.jpg")), "风景.jpg");
  ok("正常文件名找得到");

  assert.equal(resolveWallpaper("../../data.config.json"), null);
  assert.equal(resolveWallpaper(".hidden"), null);
  assert.equal(resolveWallpaper(""), null);
  ok("路径穿越和点开头的都挡掉");

  // settings.json 就躺在同一个文件夹里，白名单是唯一挡住它的东西
  fs.writeFileSync(path.join(TMP, "wallpapers", "settings.json"), "{}");
  assert.equal(resolveWallpaper("settings.json"), null);
  assert.equal(resolveWallpaper("不存在的图.png"), null);
  ok("白名单外的后缀读不到");

  // data/wallpapers/ 里没有就回落到 assets/ —— 内置那两张就是这么找到的
  assert.equal(path.basename(resolveWallpaper("壁纸2.jpg")), "壁纸2.jpg");
  ok("内置壁纸也找得到（回落到 assets/wallpapers/）");
}

console.log("\n[壁纸：设置读写]");
{
  // 上一节往里写了个空壳 settings.json，先删掉 —— 这条试的是「全新安装」那条路
  fs.rmSync(path.join(TMP, "wallpapers", "settings.json"), { force: true });
  assert.deepEqual(readWallpaperSettings(), { current: "壁纸2.jpg", veil: 0.2 });
  ok("没有 settings.json → 新用户一进来就是内置的壁纸2，遮罩淡到看得见图");

  // 文件在就完全照它来：current 是空字符串代表用户主动选了「不用壁纸」
  writeWallpaperSettings({ current: "", veil: 0.5 });
  assert.deepEqual(readWallpaperSettings(), { current: "", veil: 0.5 });
  ok("主动选「不用壁纸」不会被内置默认值顶回去");

  assert.deepEqual(writeWallpaperSettings({ current: "风景.jpg", veil: 0.5 }), {
    current: "风景.jpg",
    veil: 0.5,
  });
  assert.deepEqual(readWallpaperSettings(), { current: "风景.jpg", veil: 0.5 });
  ok("写进去再读出来是同一份");

  assert.equal(writeWallpaperSettings({ current: "风景.jpg", veil: 5 }).veil, 1);
  assert.equal(writeWallpaperSettings({ current: "风景.jpg", veil: -1 }).veil, 0.2);
  assert.equal(writeWallpaperSettings({ current: "风景.jpg", veil: "浓" }).veil, DEFAULT_VEIL);
  ok("veil 夹到 0.2~1，非数字走默认值");

  assert.equal(writeWallpaperSettings({ current: "../../config.json" }).current, "");
  assert.equal(writeWallpaperSettings({ current: "没传过这张.png" }).current, "");
  ok("current 不在文件夹里就当没设");

  // 用户绕过界面直接删文件的情况：设置里还指着它，读的时候得发现
  writeWallpaperSettings({ current: "风景-2.jpg", veil: 0.6 });
  fs.rmSync(path.join(TMP, "wallpapers", "风景-2.jpg"));
  assert.deepEqual(readWallpaperSettings(), { current: "", veil: 0.6 });
  ok("文件被手动删掉 → current 读出来是空，遮罩浓度不受影响");
}

console.log("\n[壁纸：删除]");
{
  writeWallpaperSettings({ current: "风景.jpg", veil: 0.7 });
  assert.equal(removeWallpaper("../../data.config.json"), false);
  assert.equal(removeWallpaper("settings.json"), false);
  ok("穿越路径和白名单外的删不动");

  assert.equal(removeWallpaper("风景.jpg"), true);
  assert.equal(fs.existsSync(path.join(TMP, "wallpapers", "风景.jpg")), false);
  ok("删掉的文件真的没了");

  // 删的正好是当前那张：不清空的话界面会去请求一个不存在的文件
  assert.deepEqual(readWallpaperSettings(), { current: "", veil: 0.7 });
  ok("删掉当前壁纸后 current 被一并清空");

  /*
   * 内置壁纸**抛错**而不是返回 false：它确实在清单里，只是不给删。
   * 前端要据此说「这是内置壁纸」，而不是「找不到这张图」。
   */
  assert.throws(() => removeWallpaper("壁纸2.jpg"), /内置/);
  assert.ok(listWallpapers().some((w) => w.file === "壁纸2.jpg"));
  ok("内置壁纸删不掉，并且报的是「内置」而不是「找不到」");
}

console.log("\n[只改已有气泡的那一轮：不许当成失败]");
{
  /*
   * 起因是一条真实的错报。对方说「晚安 你别回我了」，角色回了个
   * `[react:❤️]` —— 爱心贴上去了，日志里却紧跟着一句「这轮一条消息都没能
   * 发出去（多半是生成图片失败了）」，然后真给对方发了一条「这轮回复里只有
   * 图片，而图片没生成成功」。那一轮压根没有图片。
   *
   * 根因是 `sendBubbles` 只往外报 `sent`（新起的消息条数），而 `[react:]` 和
   * `[undosend:]` 刻意不计进 `sent`（它们改的是已有气泡，不新起消息）。于是
   * 「只贴了个爱心」和「只有一张图且出图失败了」在调用方眼里一模一样，报错
   * 那句话只能猜 —— 猜错了就是一句和事实无关的话发给对方。
   *
   * sendBubbles 不导出（它要 runner 和 space 两个活对象），所以这里直接
   * 验源码结构：三个调用点都得判 `acted`，报错那句话不许写死「图片」。
   */
  const src = fs.readFileSync(new URL("../server/src/imessage.js", import.meta.url), "utf8");

  // 三个调用点：正常轮、IG 顺带那条、主动消息
  const calls = src.match(/=\s*await sendBubbles\(/g) ?? [];
  assert.equal(calls.length, 3, `sendBubbles 应该有 3 个调用点，实际 ${calls.length}`);
  const destructured = src.match(/\{\s*sent,\s*acted,\s*failed\s*\}\s*=\s*await sendBubbles\(/g) ?? [];
  assert.equal(destructured.length, 3, "三个调用点都该解出 { sent, acted, failed }");
  ok("三个调用点都拿到了 acted，不是只看 sent");

  // 报错的闸判 acted。`if (!sent)` 一个都不许剩下 —— 那就是这个 bug 本身
  assert.equal((src.match(/if \(!acted\)/g) ?? []).length, 3, "三处兜底都该判 !acted");
  ok("三处兜底判的是 acted（做成了事没有），不是 sent（发出了消息没有）");

  /*
   * 这句话曾经写死在代码里。留一条断言钉住它 —— 表情包失败、爱心贴不上去都会
   * 走同一条兜底，说成「图片」就是在骗人。
   */
  assert.ok(!src.includes("多半是生成图片失败了"), "报错那句话不该写死「图片」");
  assert.ok(src.includes("KIND_NAMES"), "该有一张「标记种类 → 中文名」的表");
  ok("报错那句话说的是真的什么没成，不是写死「图片」");

  /*
   * `slot.awaiting` 和 messageCount 必须继续卡在 `sent` 上。
   *
   * 这是修这个 bug 时最容易顺手改错的地方：把它们一起改成 `acted` 的话，
   * 「主动消息只贴了个爱心」会让 slot 进入「等对方回话」—— 可对方屏幕上什么
   * 新东西都没有，那一等就是白等，后面的主动消息全堵住。
   */
  // 找**赋值**那一处，不是注释里提到它的那几处（所以带上行首缩进和分号）
  const awaiting = src.indexOf("\n    slot.awaiting = true;");
  assert.ok(awaiting > 0, "找不到 slot.awaiting = true; 那一行赋值");
  const guard = src.lastIndexOf("if (!sent) {", awaiting);
  assert.ok(guard > 0 && awaiting - guard < 700, "slot.awaiting 前面该有一道 if (!sent) 的闸");
  assert.ok(
    (src.match(/if \(sent\) runner\.messageCount \+= 1;/g) ?? []).length === 2,
    "两处 messageCount 该卡在 sent 上（前端那是「已回复」的计数）"
  );
  ok("slot.awaiting 和 messageCount 继续卡在 sent 上（没有新消息就不该等对方回话）");

  // 那两个函数得真的返回布尔，不然 acted 永远加不上
  for (const fn of ["runReactPart", "runUndoPart"]) {
    const at = src.indexOf(`async function ${fn}(`);
    assert.ok(at > 0, `找不到 ${fn}`);
    const body = src.slice(at, at + 2600);
    assert.ok(body.includes("return true"), `${fn} 该在做成时 return true`);
    assert.ok(body.includes("return false"), `${fn} 该在没做成时 return false`);
  }
  ok("runReactPart / runUndoPart 都会报「做成了没有」");

  /*
   * 出图用的模型必须**当场重新解析**，不许吃这一轮开头的快照。
   *
   * 这个 bug 的样子是：用户在「连接」面板把生图模型换了（或者把出错的那个关掉），
   * 「测试出图」立刻就好，私聊里却还在拿旧模型撞同一个错 —— 于是看起来像
   * 「测试能出图、真聊天就不行」，而其实两条路走的是同一个 generateImage。
   *
   * 成因是 `eps?.image ?? resolveImageEndpoint(config)` 这个顺序：eps 是这一轮开头
   * 解析的，而出图排在整轮最后，一张图四五十秒、一轮几条气泡能跑好几分钟。调用方
   * 明明特意重读了 config（「传的是**这一刻**重新读的 config」），却被快照盖掉。
   *
   * sendImagePart 不导出，所以照上面那个路子验源码结构。
   */
  const at = src.indexOf("async function sendImagePart(");
  assert.ok(at > 0, "找不到 sendImagePart");
  // 注释**必须先剥掉**：那上面就写着 `eps?.image ?? …` 当反面教材，
  // 不剥的话下面那两条断言会被解释 bug 的话本身绊倒
  const imgBody = src
    .slice(at, at + 2600)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  assert.ok(
    /const endpoint = resolveImageEndpoint\(config\);/.test(imgBody),
    "出图该当场 resolveImageEndpoint(config)"
  );
  // 这两种写法都会让几分钟前的快照赢，是这个 bug 本身
  assert.ok(
    !/eps\??\.image\s*\?\?/.test(imgBody),
    "不许写 eps?.image ?? …（快照会盖过刚存的配置）"
  );
  assert.ok(
    !/resolveImageEndpoint\(config\)\s*\?\?\s*eps/.test(imgBody),
    "也不许拿 eps 兜底（现读为 null 的典型场景正是「用户刚把那个模型关掉」）"
  );
  ok("出图的模型当场重解析，不吃这一轮开头的快照");
}

/* ================= 收尾 ================= */

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} 项全部通过\n`);