/**
 * 发语音 + 生成图片：标记解析、TTS 适配、生图适配。
 *
 * 模型在回复里写 `[audio_message:我刚下班]` 或 `[image:一只橘猫]`，这里把它们
 * 从正文里切出来，真的去合成 / 出图，最后由 imessage.js 发成语音条和图片。
 * `[send_emoji:紧张]` 也在这儿一起切出来，不过它不用调任何服务 —— 挑图那步
 * 在 emoji.js 里（本地文件夹里随机一张），这个文件只管把标记认出来。
 * `[card:https://…]` 和 `[music:歌手-歌名]` 同理，只切标记，真发在 imessage.js
 * （分别见 card.js 和 music.js 的文件头）。
 * 和联网搜索（websearch.js）是并列的一层：那边是「拿回来再问一次模型」，
 * 这边是「直接变成一条要发出去的消息」。
 *
 * **三道闸不在这个文件里。** 角色开关 → 子条目 enabled → 条目 enabled，
 * 这三道由 prompt.js（决定注不注入提示词）和 imessage.js（决定执不执行）各自把守。
 * 这里只负责「给我一段文字，我给你一段音频 / 一张图」，以及「这段回复里有哪些标记」。
 *
 * **凭据全局一份。** ttsApi 在 config.js 里和 weatherApi / searchApi 并列，只落
 * data.config.json；生图走已有的服务商 + 模型注册表（标了 image 分类的那个），
 * 所以第三方中转站天然支持。角色上只有开关、音色 ID、能用哪几张参考图 ——
 * 都不是密钥，可以跟着角色文件一起分享（见 backup.js 文件头）。
 *
 * **失败一律抛错，不静默。** 和 websearch.js 那边「搜不到就安静退化」不一样：
 * 搜索失败最多是回答里少点实时信息，语音/图片失败则是「该发的东西没发出去」，
 * 用户必须在控制台里看得见。调用方接住之后决定是退化成文字还是只记一条日志。
 */

import fs from "node:fs";
import path from "node:path";

import { IMAGES_DIR, REF_IMAGES_DIR, ensureLayout } from "./datadir.js";
import { ffmpegPath, runFfmpeg } from "./ffmpeg.js";
import { logDebug, logInfo, logWarn } from "./logs.js";
import { proxyFor } from "./proxy.js";
import { xmlBlockRanges } from "./websearch.js";

/** 合成一条语音最多等多久。对方在 iMessage 那头看着打字指示器干等。 */
const TTS_TIMEOUT = 30000;

/**
 * 连接失败之后再试几次。
 *
 * 只有 1 次：语音是同步发的，连着吃两个 30s 超时比早点退化成文字更难受。
 * 判据在 worthRetry —— 只有连接层的错才重试，鉴权/余额/参数错误不重。
 */
const TTS_RETRIES = 1;

/** 出一张图最多等多久 —— 比聊天慢一个量级，30s 是常态。 */
const IMAGE_TIMEOUT = 90000;

/**
 * 一条语音最多念多少字。
 *
 * 各家上限不一样（minimax 一万、elevenlabs 五千），但这里是聊天气泡，
 * 正常就几十个字。超过这个数多半是模型把整段回复塞进了标记里，
 * 截断比合成一条两分钟的语音好。
 */
export const MAX_TTS_CHARS = 1000;

/* ================= 标记解析 ================= */

/**
 * 语音、表情包、图片的标记。一条正则同时认三种，好按**出现顺序**切分。
 *
 * 几种写法都认（和 SEARCH_TAG 一个口径：全角方括号和全角冒号都收）：
 *
 *   语音    [audio_message:内容]   ← 现在的默认格式，用户给的规范
 *           [语音:内容]            ← 顺手认一下
 *           [语音]内容             ← 接链路之前那版提示词的格式，后面整段都是要说的话
 *   表情包  [send_emoji:紧张]      ← 现在的默认格式，方括号里是情绪标签
 *           [表情包:紧张]/[表情:紧张]  ← 接链路之前那版提示词写的是 [表情:开心]
 *   图片    [image:描述]           ← 现在的默认格式
 *           [Image:描述]           ← 大小写都认（内置线上预设写的就是大写）
 *           [生成图片：描述]/[生图:描述]/[画图:描述]
 *           [image:描述][小猫]     ← 后面那个方括号是参考图名（图生图）
 *   撤回    [undosend:1]           ← 撤回自己倒数第 1 条已发出去的消息
 *           [undo_send:2]/[撤回:1]/[undosend]（不写数字当 1）
 *   卡片    [card:https://…]       ← 把一条网址发成带预览的链接卡片
 *           [卡片:https://…]/[分享:https://…]
 *   点歌    [music:周杰伦-晴天]    ← 只写歌手和歌名，网址由 music.js 现查
 *           [音乐:周杰伦-晴天]/[歌曲:…]/[点歌:…]
 *   位置    [location:南宁万象城]  ← 发一张苹果地图卡片，地名可以是编的
 *           [location:南宁万象城:22.8170,108.3665]  ← 带坐标，图钉钉在这个点上
 *           [位置:…]/[定位:…]/[share_location:…]
 *   回应    [react:😂]             ← 给对方最后一条气泡贴一个 emoji（tapback）
 *           [react:😂:2]           ← 往回数第 2 条
 *           [react:❤️:我想你了]     ← 按原文找那条
 *           [回应:😂]/[贴纸:😂]/[tapback:😂]
 *
 * 认旧格式是因为**用户改过的提示词原文会留着**（见 preset.js 的
 * LEGACY_VOICE_CHILD）—— 那些配置里模型仍然按老格式写，解析不到就等于功能没了。
 *
 * 参考图那一节里排掉冒号，否则 `[image:a][audio_message:b]` 会把后面那条语音
 * 当成参考图名吞掉。图库名本来也不允许有冒号（config.js:normalizeReferenceImages）。
 *
 * 撤回和上面三种不一样：它**不产出要发的内容**，是一条「把刚发的那条收回去」
 * 的指令。放进同一条正则是因为它的位置有意义 —— 规范里写明「必须紧跟在被撤回
 * 的文字内容正后方」，得和前后的文字保持原来的先后顺序才能照着执行。
 *
 * 卡片那一节**只认 http(s) 开头的东西**，不像别的那样收任意文字。道理是卡片
 * 本身没有内容可言，它就是一条网址 —— 模型写 `[card:一首好听的歌]` 是发不出去
 * 的，与其切出来再在发送时失败，不如压根不认，让它原样当文字留着。
 *
 * 点歌恰好反过来：它收的**就是**「歌手-歌名」这种自然语言（模型记不住歌曲 ID，
 * 见 music.js 文件头）。所以它得排在卡片后面 —— 前面那条先吃掉 http 开头的，
 * 剩下 `[music:https://…]` 这种写法才由发送那边自己判成卡片。
 *
 * 位置和点歌是同一个模式：模型只写地名（**允许编**，那正是这个功能的用途），
 * 网址由 card.js:mapsUrlFor 现拼。也排在卡片后面，同一个道理。坐标是可选的
 * 尾巴，切分在 splitMedia 里做（按最后一个冒号切，且后半段得像坐标）。
 *
 * 回应（tapback）和撤回同类：**不产出要发的内容**，是一条「给那条气泡贴个 emoji」
 * 的指令。标签体里第一个冒号之前是 emoji、之后是「贴哪条」（数字或原文片段），
 * emoji 本身不含冒号所以这么切没歧义 —— 真正的切分在 splitMedia 里做，正则只
 * 负责把整段抠出来。
 */
/*
 * 语音和图片那两组的标记体：不许裸的方括号，但**允许嵌成对的**。
 *
 * 最早的写法是简单的 `[^…]`（不吃右括号），后果是模型写带语气词标签的语音
 * `[audio_message:[whispers] …正文… [sighs] …]` 时，标记在 `[whispers]` 的
 * 那个 `]` 上就提前闭了 —— 抠出来的一条语音只有 `[whispers` 九个字，剩下的
 * 正文漏出去当了普通文字。语气标签（[whispers]、[sighs]）和画面描述
 * （[image:[特写] …]）都是模型的自然习惯，所以这两组换成上面这条：
 * 三选一循环 —— 普通字符、一对半角括号、一对全角括号。每个位置只有一种走法，
 * 没有回溯炸弹；碰上不成对的 `]` 照旧在它前面停下，退化成老行为。
 *
 * 其他组**不**换：表情包是个情绪标签、点歌是「歌手-歌名」、位置是地名 ——
 * 这些内容里出现方括号多半是模型写坏了，在第一个 `]` 前面刹住更安全。
 */
const BRACKET_BODY = "(?:[^\\[\\]］［]|\\[[^\\[\\]］［]*\\]|［[^\\[\\]］［]*］){1,2000}?";

const MEDIA_TAG = new RegExp(
  [
    "[[［]\\s*(?:audio_message|audio|语音|voice)\\s*[:：]\\s*(?<audio>" +
      BRACKET_BODY +
      ")\\s*[\\]］]",
    "[[［]\\s*语音\\s*[\\]］]\\s*(?<audioRest>[^\\n]{1,2000})",
    "[[［]\\s*(?:send_emoji|sticker|emoji|表情包|表情)\\s*[:：]\\s*(?<sticker>[^\\]］]{1,60}?)\\s*[\\]］]",
    "[[［]\\s*(?:image|生成图片|生图|画图|图片)\\s*[:：]\\s*(?<image>" +
      BRACKET_BODY +
      ")\\s*[\\]］]" +
      "(?:\\s*[[［]\\s*(?<ref>[^\\]］:：]{1,60}?)\\s*[\\]］])?",
    "[[［]\\s*(?:undosend|undo_send|unsend|撤回消息|撤回)\\s*[:：]\\s*(?<undo>\\d{1,2})\\s*[\\]］]",
    "[[［]\\s*(?<undoBare>undosend|undo_send|unsend)\\s*[\\]］]",
    "[[［]\\s*(?:card|link_card|卡片|链接卡片|分享)\\s*[:：]\\s*(?<card>https?://[^\\]］\\s]{1,500}?)\\s*[\\]］]",
    "[[［]\\s*(?:music|song|音乐|歌曲|点歌)\\s*[:：]\\s*(?<music>[^\\]］]{1,120}?)\\s*[\\]］]",
    "[[［]\\s*(?:share_location|location|位置|定位|共享位置)\\s*[:：]\\s*(?<location>[^\\]］]{1,160}?)\\s*[\\]］]",
    "[[［]\\s*(?:reaction|react|tapback|回应|贴纸)\\s*[:：]\\s*(?<react>[^\\]］]{1,80}?)\\s*[\\]］]",
  ].join("|"),
  /*
   * `i`：标签名不分大小写。
   *
   * 起因是内置的「线上默认预设」自己就写着 `Output format: Must start with
   * [Image:].`，模型照着写出来的是大写开头的 `[Image:…]`，而这条正则以前只认
   * 小写 —— 于是那句标记原样当短信发出去了，图一张也不出。用户改过的预设里
   * 这种写法同样留着（预设是导出来互相分享的，让人一个个去改不现实）。
   *
   * 中文那几个别名不受影响；英文的 `[Audio_message:]`、`[Card:]`、`[React:]`
   * 也跟着一起认了 —— 同一个毛病，没有理由只修图片这一个。
   */
  "gi"
);

/**
 * 一段文字切成「文字 / 语音 / 表情包 / 图片 / 撤回」几段，保持原来的先后顺序。
 *
 * **XML 标签里的标记不算数**（和联网搜索同一条规则，见 websearch.js:stripXmlBlocks
 * 的注释）：模型在 `<thinking>` 里复述「格式是 [image:xxx]」的情况实测很常见，
 * 真去出一张「xxx」的图纯属浪费钱。这里不能像搜索那样先把标签块扒掉再扫 ——
 * 那样后面所有下标都会错位 —— 所以改成照原文扫、落在标签块区间里的跳过，
 * 跳过的那一段原样留在文字里（模型的思维链本来就会被正则收掉）。
 *
 * @param {string} text 一条气泡的正文（调用方已经按分隔符切过）
 * @returns {{kind:"text"|"audio"|"sticker"|"image"|"undo"|"card"|"music"|"location"|"react",
 *            text:string, ref?:string, n?:number, ll?:string, emoji?:string, spec?:string}[]}
 *          text 段已经 trim 过，空段不产出；sticker 段的 text 是情绪标签；
 *          image 段的 ref 是参考图名（没有就是空串）；undo 段的 n 是倒数第几条；
 *          card 段的 text 是那条网址；music 段的 text 是「歌手-歌名」那串；
 *          location 段的 text 是地名、ll 是「纬度,经度」（没写就是空串）；
 *          react 段的 emoji 是要贴的 emoji、spec 是贴哪条（没写就是空串）
 */
export function splitMedia(text) {
  const src = String(text ?? "");
  const parts = [];
  if (!src.trim()) return parts;

  const ranges = xmlBlockRanges(src);
  const inXml = (at) => ranges.some(([a, b]) => at >= a && at < b);

  const pushText = (chunk) => {
    const t = chunk.trim();
    if (t) parts.push({ kind: "text", text: t });
  };

  let cursor = 0;
  for (const m of src.matchAll(MEDIA_TAG)) {
    // 标签块里的：不切，留给后面那段文字原样带走
    if (inXml(m.index)) continue;
    pushText(src.slice(cursor, m.index));

    const g = m.groups ?? {};
    const audio = g.audio ?? g.audioRest;
    if (audio !== undefined) {
      const t = audio.trim();
      if (t) parts.push({ kind: "audio", text: t });
    } else if (g.sticker !== undefined) {
      const t = g.sticker.trim();
      if (t) parts.push({ kind: "sticker", text: t });
    } else if (g.undo !== undefined || g.undoBare !== undefined) {
      // 不写数字当 1 —— 规范里「紧跟在被撤回内容正后方」的写法几乎都是撤自己刚说的那句
      const n = g.undo === undefined ? 1 : Number(g.undo);
      if (Number.isFinite(n) && n >= 1) parts.push({ kind: "undo", text: "", n });
    } else if (g.card !== undefined) {
      const t = g.card.trim();
      if (t) parts.push({ kind: "card", text: t });
    } else if (g.music !== undefined) {
      const t = g.music.trim();
      if (t) parts.push({ kind: "music", text: t });
    } else if (g.location !== undefined) {
      /*
       * 按**最后一个**冒号切，而且后半段得真像一对坐标才算。
       *
       * 不像 [react:] 那样按第一个冒号切：地名在前、坐标在后，而地名里
       * 出现冒号不算离谱（`[location:星巴克:朝阳门店]`）。要求后半段匹配
       * `数字,数字` 就把这种情况挡住了 —— 匹配不上就整串当地名。
       */
      const body = g.location.trim();
      const at = Math.max(body.lastIndexOf(":"), body.lastIndexOf("："));
      const tail = at < 0 ? "" : body.slice(at + 1).trim();
      const isLL = /^-?\d{1,3}(?:\.\d+)?\s*[,，]\s*-?\d{1,3}(?:\.\d+)?$/.test(tail);
      const name = (isLL ? body.slice(0, at) : body).trim();
      if (name) parts.push({ kind: "location", text: name, ll: isLL ? tail : "" });
    } else if (g.react !== undefined) {
      // 第一个冒号切开：前面是 emoji，后面是「贴哪条」。
      // 后半段照 [reply:] 的规矩，数字 = 倒数第几条、其它 = 原文片段，
      // 真正的解析交给 imessage.js:resolveReplyTarget。
      const body = g.react.trim();
      const at = body.search(/[:：]/);
      const emoji = (at < 0 ? body : body.slice(0, at)).trim();
      const spec = at < 0 ? "" : body.slice(at + 1).trim();
      if (emoji) parts.push({ kind: "react", text: "", emoji, spec });
    } else {
      const t = String(g.image ?? "").trim();
      if (t) parts.push({ kind: "image", text: t, ref: String(g.ref ?? "").trim() });
    }
    cursor = m.index + m[0].length;
  }
  pushText(src.slice(cursor));
  return parts;
}

/** 这段文字里有没有语音 / 表情包 / 图片 / 撤回 / 卡片 / 点歌 / 位置 / 回应标记。 */
export function hasMedia(text) {
  return splitMedia(text).some((p) => p.kind !== "text");
}

/**
 * 把标记退化掉，只留能当普通文字发的部分。
 *
 * 语音变成它要念的那句话（`[audio_message:你好]` → `你好`）—— 功能关着的时候
 * 至少把话说出去，比让对方收到一串方括号强。**卡片同理**，退化成那条光秃秃的
 * 网址：网址本身就是有用的东西，对方点得开，只是不带预览图。**点歌也一样**，
 * 退化成「周杰伦-晴天」这句话 —— 对方照样知道说的是哪首歌，只是要自己去搜。
 * **位置**退化成那个地名（`[location:南宁万象城]` → `南宁万象城`），坐标丢掉 ——
 * 一串经纬度对人没用，地名本身就是要说的那句话。
 * 图片和表情包直接**丢掉**：图片那段是给出图模型看的画面描述（「浅木桌，
 * 蓝莓芋泥蛋糕，白瓷盘」），表情包那段是个情绪标签（「紧张」），单独发给人看
 * 都莫名其妙。撤回也丢掉 —— 它本来就不产出内容。**回应同理**：功能关着的时候
 * 一个光秃秃的 emoji 单发一条也不像话，直接丢。
 *
 * 几段之间不加分隔符 —— 正常情况下模型会用气泡分隔符隔开，走到这儿的都是
 * 同一条气泡里的相邻内容。
 */
export function stripMediaTags(text) {
  return splitMedia(text)
    .filter(
      (p) =>
        p.kind !== "image" && p.kind !== "sticker" && p.kind !== "undo" && p.kind !== "react"
    )
    .map((p) => p.text)
    .join("")
    .trim();
}

/**
 * 把一条气泡降成「线下能当普通文字发出去的部分」。
 *
 * 线下模式没有媒体那条路（预设的 format 条目整段不进提示词，模型照理学不会
 * 写标记），但「照理」不兜底：线下预设里那路「线上聊天记录」会把带标记的
 * 线上发言摆到模型眼前，有样学样写出 `[audio_message:…]` 不是不可能。原样
 * 发出去就是一对方括号，所以照线上「功能关着」的同一套待遇退化：
 * 语音变成它要念的那句话、卡片退成网址、位置退成地名，图片/表情包/撤回/
 * 回应直接丢掉 —— 再加上摘掉引用和特效这两个「气泡属性」标记。
 *
 * @returns {string} 可能是空串（整条都是要丢的标记）—— 调用方跳过这条不发
 */
export function degradeToPlain(text) {
  const noReply = takeReplyTag(String(text ?? "")).text;
  return stripMediaTags(takeEffectTag(noReply).text);
}

/* ================= 引用回复 ================= */

/**
 * 引用回复的标记。
 *
 * 和撤回一样不产出内容，但也不像已读不回那样是条全局指令 —— 它是**这条气泡**
 * 的一个属性（「这句话是冲着哪条说的」），所以既不进 splitMedia 也不单独判，
 * 而是从气泡里摘下来、把剩下的正文原样发出去。
 *
 * 冒号后面两种写法都认（见 takeReplyTag）：纯数字 = 对方倒数第 N 条，
 * 其它 = 原文。中括号内不允许再出现右括号，所以 `[reply:好的[image:x]` 这种
 * 拼错的写法会匹配失败、原样留在正文里 —— 比错引用一条无关消息强。
 */
const REPLY_TAG = /[[［【]\s*(?:reply|引用回复|引用|回复)\s*[:：]\s*([^\]］】]{1,400}?)\s*[\]］】]/gi;

/**
 * 从一条气泡里摘掉引用标记，返回引用目标和剩下的正文。
 *
 * **只认第一个**：规范里写死了「每条消息最多使用一次 [reply:]」，模型违规写了两个
 * 的时候取第一个、后面的照样剥掉 —— 留在正文里发出去更难看。
 *
 * **XML 标签里的不算**（和别的标记同一条规则）：模型在 `<thinking>` 里复述格式
 * 很常见，照那个去引用等于把思考当成了决定。落在标签块里的原样留着。
 *
 * @returns {{spec:string, text:string}} spec 是冒号后面的原始内容（没写就是空串），
 *          解析成「第 N 条」还是「原文匹配」交给调用方（imessage.js:resolveReplyTarget）
 */
export function takeReplyTag(text) {
  const src = String(text ?? "");
  if (!src) return { spec: "", text: "" };

  const ranges = xmlBlockRanges(src);
  let spec = "";
  let out = "";
  let cursor = 0;
  for (const m of src.matchAll(REPLY_TAG)) {
    if (ranges.some(([a, b]) => m.index >= a && m.index < b)) continue;
    out += src.slice(cursor, m.index);
    if (!spec) spec = String(m[1] ?? "").trim();
    cursor = m.index + m[0].length;
  }
  out += src.slice(cursor);
  return { spec, text: out.trim() };
}

/* ================= 消息特效 ================= */

/**
 * iMessage 的 13 个消息特效，key → Apple 的完整常量。
 *
 * **必须硬编**：SDK 自己也有一份同样的表（`@spectrum-ts/imessage/dist/index.js:152`
 * 的 `messageEffects`），但那个 const **没有 export**，`effect(input, id)` 的第二个参数
 * 要的就是右边这串完整常量。所以这里照抄一份，改动时务必和 SDK 那份一字不差 ——
 * 对不上的话 effect() 会直接抛 `Unsupported iMessage message effect`。
 *
 * 两类的区别在对方那头看起来天差地别：
 *  - 屏幕（`com.apple.messages.effect.CK*`）：整块屏幕放动画，气球/烟花/爱心那种；
 *  - 气泡（`com.apple.MobileSMS.expressivesend.*`）：只有那条气泡自己动一下。
 * 入站识别（imessage.js 的 D2）就靠这个前缀分辨该说「屏幕效果」还是「气泡效果」。
 */
export const MESSAGE_EFFECT_IDS = {
  balloons: "com.apple.messages.effect.CKBalloonEffect",
  celebration: "com.apple.messages.effect.CKHappyBirthdayEffect",
  confetti: "com.apple.messages.effect.CKConfettiEffect",
  echo: "com.apple.messages.effect.CKEchoEffect",
  fireworks: "com.apple.messages.effect.CKFireworksEffect",
  gentle: "com.apple.MobileSMS.expressivesend.gentle",
  heart: "com.apple.messages.effect.CKHeartEffect",
  invisible: "com.apple.MobileSMS.expressivesend.invisibleink",
  lasers: "com.apple.messages.effect.CKLasersEffect",
  loud: "com.apple.MobileSMS.expressivesend.loud",
  slam: "com.apple.MobileSMS.expressivesend.impact",
  sparkles: "com.apple.messages.effect.CKSparklesEffect",
  spotlight: "com.apple.messages.effect.CKSpotlightEffect",
};

/** 全屏特效的 key，界面上单独一栏（会占满对方整个屏幕，得提醒一句）。 */
export const SCREEN_EFFECT_KEYS = [
  "balloons",
  "celebration",
  "confetti",
  "echo",
  "fireworks",
  "heart",
  "lasers",
  "sparkles",
  "spotlight",
];

/** 气泡特效的 key —— 只有那条气泡自己动。 */
export const BUBBLE_EFFECT_KEYS = ["gentle", "loud", "slam", "invisible"];

/** 13 个 key 的全集，config.js 校验白名单用。 */
export const EFFECT_KEYS = [...SCREEN_EFFECT_KEYS, ...BUBBLE_EFFECT_KEYS];

/** key → 中文名。界面上是中英对照，提示词里给模型的是英文 key。 */
export const EFFECT_LABELS = {
  balloons: "气球",
  celebration: "生日",
  confetti: "彩纸",
  echo: "回声",
  fireworks: "烟花",
  heart: "爱心",
  lasers: "镭射",
  sparkles: "闪光",
  spotlight: "聚光灯",
  gentle: "轻轻地",
  loud: "大声",
  slam: "用力",
  invisible: "隐形墨水",
};

/**
 * 中文别名 → key。
 *
 * 提示词里写的是英文 key，但用户改过的提示词原文会留着、模型也可能顺手写中文，
 * 多认几个不花钱（和 MEDIA_TAG 认旧格式一个道理）。
 */
const EFFECT_ALIASES = {
  气球: "balloons",
  生日: "celebration",
  生日快乐: "celebration",
  彩纸: "confetti",
  五彩纸屑: "confetti",
  回声: "echo",
  烟花: "fireworks",
  爱心: "heart",
  心: "heart",
  镭射: "lasers",
  激光: "lasers",
  闪光: "sparkles",
  聚光灯: "spotlight",
  聚光: "spotlight",
  轻轻地: "gentle",
  轻轻: "gentle",
  大声: "loud",
  用力: "slam",
  重锤: "slam",
  隐形墨水: "invisible",
  隐形: "invisible",
};

/**
 * 把「heart」「爱心」「HEART」这些写法归一成 key，认不出来返回空串。
 */
export function resolveEffectKey(name) {
  const raw = String(name ?? "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  if (Object.hasOwn(MESSAGE_EFFECT_IDS, lower)) return lower;
  return EFFECT_ALIASES[raw] ?? "";
}

/**
 * 反查一条入站消息的 expressiveSendStyleId，说清它是哪个特效、属于哪一类。
 *
 * @returns {{key:string, label:string, scope:"屏幕"|"气泡"}|null} 认不出来返回 null
 *          （调用方打一条 debug 日志就行，不要瞎猜 —— 苹果以后加新特效很正常）
 */
export function describeEffectId(id) {
  const raw = String(id ?? "").trim();
  if (!raw) return null;
  for (const [key, full] of Object.entries(MESSAGE_EFFECT_IDS)) {
    if (full !== raw) continue;
    return {
      key,
      label: EFFECT_LABELS[key] ?? key,
      scope: SCREEN_EFFECT_KEYS.includes(key) ? "屏幕" : "气泡",
    };
  }
  return null;
}

/**
 * 逐词效果（给某几个字单独套的动效）认这 8 个，**其他一律不要**。
 *
 * 用户的原话就是「:big / small / shake / nod / explode / ripple / bloom / jitter，
 * 其他不要」—— 粗体/斜体/下划线/删除线那些 formatting 项明确排除在外。
 *
 * 只用于**识别对方发来的**（imessage.js 的 D2）。模型自己发不了 —— 逐词效果要裸
 * gRPC 手搓 formatting 数组，SDK 没有封装，本次不做。
 */
export const WORD_EFFECT_LABELS = {
  big: "变大",
  small: "变小",
  shake: "抖动",
  nod: "点头",
  explode: "爆炸",
  ripple: "涟漪",
  bloom: "绽放",
  jitter: "颤抖",
};

/**
 * 消息特效的标记。
 *
 * 和引用回复同类：不产出内容，是**这条气泡**的一个属性（「这条气泡带什么特效」），
 * 所以既不进 splitMedia 也不单独判，而是从气泡开头摘下来、正文照常发。
 */
const EFFECT_TAG =
  /[[［【]\s*(?:message_effect|effect|消息特效|特效|效果)\s*[:：]\s*([^\]］】]{1,40}?)\s*[\]］】]/gi;

/**
 * 从一条气泡里摘掉特效标记，返回特效和剩下的正文。
 *
 * 规矩和 takeReplyTag 完全一致：**只认第一个**（一条气泡只能有一个特效，
 * 多写的照样剥掉）、**XML 标签里的不算**（模型在 `<thinking>` 里复述格式很常见，
 * 照那个真发一屏烟花就等于把思考当成了决定）。
 *
 * **认不出来的名字当没写过** —— 标记照样剜掉（留在正文里发出去更难看），
 * 但不发特效，继续往后找下一个。模型编一个 `[effect:雪花]` 不该让整条气泡变形。
 *
 * @returns {{key:string, id:string, text:string}} key 是归一后的英文 key，
 *          id 是交给 SDK effect() 的完整常量，都没命中就都是空串
 */
export function takeEffectTag(text) {
  const src = String(text ?? "");
  if (!src) return { key: "", id: "", text: "" };

  const ranges = xmlBlockRanges(src);
  let key = "";
  let out = "";
  let cursor = 0;
  for (const m of src.matchAll(EFFECT_TAG)) {
    if (ranges.some(([a, b]) => m.index >= a && m.index < b)) continue;
    out += src.slice(cursor, m.index);
    if (!key) key = resolveEffectKey(m[1]);
    cursor = m.index + m[0].length;
  }
  out += src.slice(cursor);
  return { key, id: key ? MESSAGE_EFFECT_IDS[key] : "", text: out.trim() };
}

/* ================= 已读不回 ================= */

/**
 * 已读不回的指令。
 *
 * 和语音/图片那些不一样，这个标记**不带内容**，也不是「切出一段来单独发」——
 * 它是一条「这轮什么都别发」的指令，所以不进 splitMedia，单独判一次。
 *
 * 写法上宽松一点：下划线可以是空格或横线，大小写不论，中文「已读不回」也认。
 * 模型把它写成 `[leave_on_read]。` 或者 `【leave on read】` 都还算数 ——
 * 这条指令判错的代价是不对称的：漏判 = 该装死的时候硬回了一句，
 * 误判 = 该说的话没说出去，后者严重得多，所以只在**没有别的可发内容**时
 * 才真的静默（见 imessage.js 那边的兜底）。
 */
const LEAVE_ON_READ_TAG =
  /[[［【]\s*(?:leave[\s_-]*on[\s_-]*read|已读不回)\s*[\]］】]/gi;

/**
 * 这段回复里有没有「已读不回」指令。
 *
 * **XML 标签里的不算**（和语音/图片/搜索同一条规则）：模型在 `<thinking>` 里
 * 盘算「这里是不是该 [leave_on_read]」是很常见的，照那个真去装死就等于
 * 把思考当成了决定。
 */
export function hasLeaveOnRead(text) {
  const src = String(text ?? "");
  if (!src) return false;
  const ranges = xmlBlockRanges(src);
  for (const m of src.matchAll(LEAVE_ON_READ_TAG)) {
    if (!ranges.some(([a, b]) => m.index >= a && m.index < b)) return true;
  }
  return false;
}

/**
 * 把已读不回的指令从正文里去掉。
 *
 * 用来判断「除了这条指令之外还有没有别的正文」。注意**不**做 XML 感知：
 * 这个函数的调用方（imessage.js）已经先用 hasLeaveOnRead 判过了，
 * 到这一步是要把所有形态的标记都清干净好看剩下什么。
 */
export function stripLeaveOnRead(text) {
  return String(text ?? "").replace(LEAVE_ON_READ_TAG, "").trim();
}

/* ================= 参考图 ================= */

/** 参考图认这几种后缀。也是 /api/images 那条路由的白名单。 */
export const REF_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".gif"];

const REF_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** 后缀 → MIME。认不出的按 png 走（下游只用它填 Content-Type）。 */
export function mimeForExt(ext) {
  return REF_MIME[String(ext ?? "").toLowerCase()] ?? "image/png";
}

/**
 * MIME → 后缀。上传上来的文件名不一定带后缀（浏览器里粘贴的截图常常叫
 * 「image.png」，但从相册选的可能就叫「截图」），认不出的按 png 走。
 */
const EXT_FOR_MIME = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

export function extForMime(mimeType) {
  return EXT_FOR_MIME[String(mimeType ?? "").trim().toLowerCase()] ?? ".png";
}

/**
 * 从**字节**里认图片类型，认不出返回 null（后缀带点，和 REF_EXTS 一个形状）。
 *
 * 存在的理由是「文件名会撒谎」：用户攒的表情包里大量文件后缀和内容对不上
 * （JPEG 存成 `.gif`、PNG 存成 `.jpg`…），而对方手机是**只看后缀**认类型的
 * —— iMessage 那边对不上就不当图片渲染，气泡里变成一个灰色文件图标。
 * 网上下回来的图同理：中转站给的 Content-Type 经常是 application/octet-stream。
 *
 * 认不出时返回 null 而不是兜底成 png：调用方自己决定是退回文件名后缀
 * （表情包）还是硬按 png 走（生图），这里不替它们选。
 */
export function sniffImageType(buf) {
  if (!buf || buf.length < 3) return null;
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50) {
    return { mimeType: "image/png", ext: ".png" };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    return { mimeType: "image/jpeg", ext: ".jpg" };
  }
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    return { mimeType: "image/webp", ext: ".webp" };
  }
  if (buf.toString("ascii", 0, 3) === "GIF") {
    return { mimeType: "image/gif", ext: ".gif" };
  }
  return null;
}

/**
 * 上传上来的文件名 → 能安全落盘、且不撞名的文件名。
 *
 * 壁纸、参考图、表情包三处上传共用这一份 —— 三边的规矩本来就该一样，
 * 各写各的迟早会漏掉其中一条。
 *
 * 剔的字符集和 datadir.js 的 safeName 一致（Windows 非法字符 + 控制字符），
 * 外加 `path.basename` 兜路径穿越、去掉开头的点。后缀不在白名单里就按
 * mimeType 补一个。
 *
 * 重名**不覆盖**，追加 `-2`、`-3`：用户传两张都叫 IMG_0001.jpg 的图很常见，
 * 悄悄盖掉前一张会让人以为上传失败了。「已经被占了吗」由调用方给 —— 壁纸要
 * 连内置的一起算，参考图要按不带后缀的名字算（同名不同后缀在图库里是一条）。
 *
 * @param {object} o
 * @param {string} o.raw 浏览器给的原始文件名
 * @param {string} o.mimeType 浏览器给的 MIME，只在原名没有可用后缀时才用
 * @param {string} o.fallback 名字被剔干净之后的兜底名
 * @param {(name:string)=>boolean} o.taken 判断这个文件名是否已被占用
 */
export function safeUploadName({ raw, mimeType, fallback = "图片", taken = () => false }) {
  const base = path.basename(String(raw ?? "").trim());
  let stem = base
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "")
    .replace(/^\.+/, "")
    .trim();
  let ext = path.extname(stem).toLowerCase();
  if (REF_EXTS.includes(ext)) {
    stem = stem.slice(0, -ext.length);
  } else {
    ext = extForMime(mimeType);
  }
  // 结尾的点和空格要去掉：Windows 会把「a.」存成「a」，再按名字找就找不着了
  stem = stem.replace(/[. ]+$/, "").slice(0, 60).trim();
  if (!stem) stem = fallback;

  let name = `${stem}${ext}`;
  for (let i = 2; taken(name); i += 1) {
    name = `${stem}-${i}${ext}`;
  }
  return name;
}

/**
 * 参考图往哪几个文件夹里找，按优先级排。
 *
 *   data/images/参考图/  现在推荐放这儿 —— 隔壁就是 emojis/，分得清楚
 *   data/images/         老位置，直接摊在 images 根下
 *
 * 两个都认是因为**老用户的图已经在根目录躺着了**，改个推荐位置不能让他们的
 * 图生图突然找不到文件。同名时以 参考图/ 里的为准。
 */
const REF_DIRS = [REF_IMAGES_DIR, IMAGES_DIR];

/**
 * 图库里的名字 → 那个文件的绝对路径。找不到返回 null。
 *
 * 名字就是**文件名不带后缀**（用户的规范里定的），所以这里按 REF_EXTS 逐个探。
 * 用户手滑把后缀也填进去了（「小猫.jpg」）也认 —— 那种情况直接当完整文件名试。
 *
 * `path.basename` 是**安全边界**：名字会被拼进文件路径，config.js 那边已经
 * 剔过路径分隔符了，这里再兜一道，`../../data.config.json` 到这儿只剩
 * `data.config.json`，而它不在 REF_EXTS 白名单里，探不到。
 */
export function resolveRefFile(name) {
  const base = path.basename(String(name ?? "").trim());
  // 点开头的当隐藏文件挡掉，顺手把 ".." 这种也挡了
  if (!base || base.startsWith(".")) return null;

  const ext = path.extname(base).toLowerCase();
  for (const dir of REF_DIRS) {
    if (REF_EXTS.includes(ext)) {
      const full = path.join(dir, base);
      if (fs.existsSync(full)) return full;
      continue;
    }
    for (const e of REF_EXTS) {
      const full = path.join(dir, base + e);
      if (fs.existsSync(full)) return full;
      // Windows 不区分大小写，Linux 区分 —— 大写后缀也试一次
      const upper = path.join(dir, base + e.toUpperCase());
      if (fs.existsSync(upper)) return upper;
    }
  }
  return null;
}

/**
 * 参考图文件夹里实际有哪些图片，返回**不带后缀**的名字。
 *
 * 前端的「图库 → 参考图」分区拿它标出「图库里填了这条、但文件夹里没有这个
 * 文件」，也用它反过来提示「文件在那儿但还没登记」。
 *
 * 两个文件夹合起来看，同名只留一条（和 resolveRefFile 一样，参考图/ 优先）——
 * 重名在界面上是两行一模一样的记录，看不出区别，反而像 bug。
 */
export function listRefFiles() {
  const out = [];
  const seen = new Set();
  for (const dir of REF_DIRS) {
    let files = [];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue; // 文件夹不存在（老装机没有 参考图/）就跳过
    }
    for (const f of files) {
      const ext = path.extname(f).toLowerCase();
      if (!REF_EXTS.includes(ext)) continue;
      const name = path.basename(f, path.extname(f));
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, file: f });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * 存一张参考图到 data/images/参考图/，返回 `{file, name}`。
 *
 * 一律往 参考图/ 里写，不往老位置（images/ 根）写 —— 根目录那份只为兼容老用户，
 * 新传的图没理由再摊在那儿。
 *
 * 撞名按**不带后缀的名字**算：图库里一条记录就是一个名字，`猫.png` 和 `猫.jpg`
 * 在 listRefFiles 里会被去重成一条，真让它们并存的话用户会看见「删了还在」。
 * resolveRefFile 两个文件夹都探，所以老位置上的同名图也算数。
 */
export function saveRefFile(rawName, base64, mimeType) {
  ensureLayout();
  const file = safeUploadName({
    raw: rawName,
    mimeType,
    fallback: "参考图",
    taken: (n) => Boolean(resolveRefFile(path.basename(n, path.extname(n)))),
  });
  fs.writeFileSync(path.join(REF_IMAGES_DIR, file), Buffer.from(String(base64 ?? ""), "base64"));
  return { file, name: path.basename(file, path.extname(file)) };
}

/**
 * 从一段自由文本里摘出参考图名（`/image` 快捷指令用）。
 *
 * 两种写法：
 *   `/image [小猫] 躺在地上`  ← 方括号，明确
 *   `/image 小猫 躺在地上`    ← 第一个词**恰好**是图库里的名字才算
 *
 * 第二种要求完全相等，不做模糊匹配 —— 「小猫咪很可爱」不该被当成调用「小猫」。
 * 名字里带空格的图库条目只能用方括号那种写法，这个在界面上写了。
 *
 * @param {string} text 指令后面那整段
 * @param {string[]} names 这个角色能用的图库名
 * @returns {{ref: string, prompt: string}} ref 为空串表示纯文生图
 */
export function pickRefFromText(text, names) {
  const src = String(text ?? "").trim();
  const known = (Array.isArray(names) ? names : []).map((n) => String(n).trim()).filter(Boolean);

  const bracket = /^[[［]\s*([^\]］]{1,60}?)\s*[\]］]\s*([\s\S]*)$/.exec(src);
  if (bracket) {
    const hit = known.find((n) => n === bracket[1]);
    // 方括号里写的不是图库里的名字：整段当描述（可能只是描述里恰好用了方括号）
    if (hit) return { ref: hit, prompt: bracket[2].trim() };
    return { ref: "", prompt: src };
  }

  // 名字里可能有空格，所以按名字去比而不是先切词。长的先比，
  // 免得「小猫」抢在「小猫咪」前面把后者截成「咪…」
  for (const n of [...known].sort((a, b) => b.length - a.length)) {
    if (!src.startsWith(n)) continue;
    const rest = src.slice(n.length);
    // 后面必须是空白或者到头了 —— 不然「小猫咪很可爱」会被当成调用「小猫」
    if (rest && !/^\s/.test(rest)) continue;
    return { ref: n, prompt: rest.trim() };
  }
  return { ref: "", prompt: src };
}

/* ================= 网络请求的公共部分 ================= */

/** 去掉末尾斜杠，避免拼出 //v1/tts。 */
function trimBase(url) {
  return String(url ?? "").trim().replace(/\/+$/, "");
}

/**
 * 网络层错误挖出人能看的一句话。
 *
 * 和 llm.js:describeNetworkError 同一个用意（undici 只抛一句没信息量的
 * "fetch failed"，真原因在 e.cause 里）。没直接复用是因为那个没 export，
 * 而且这里要的短得多 —— 这句话会进控制台，不会发给对方。
 */
function whyFetch(e) {
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "请求超时";
  const code = e?.cause?.code;
  if (code) return `${e.message}（${code}）`;
  return String(e?.message ?? e);
}

/**
 * 这个错误值不值得再试一次。
 *
 * 只认**连接层**的失败：TCP 连不上、握手超时、连接被掐断。这类错误重试一次
 * 通常就过去了（走代理的时候尤其常见 —— 偶发的连接卡死不该让整条语音发不出去）。
 *
 * 反过来，鉴权失败、余额不足、参数不对、上游明确报错，重试只是多花一次钱、
 * 多等一个超时，所以一律不重试。HTTP 状态码类的错误在各家适配器里就抛成
 * 普通 Error 了，走不到这里。
 */
function worthRetry(e) {
  const code = e?.cause?.code ?? e?.code;
  return (
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "EPIPE" ||
    code === "UND_ERR_SOCKET" ||
    e?.name === "TimeoutError"
  );
}

/** 从 ffmpeg 的 stderr 里抠出 `Duration: 00:00:03.06` 那个秒数。 */
function parseFfmpegDuration(stderr) {
  const m = /Duration:\s*(\d+):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/.exec(String(stderr));
  if (!m) return undefined;
  const seconds =
    Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4] ?? 0}`);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

/**
 * 自己把音频转成 m4a，顺手读出时长。
 *
 * **为什么不让 spectrum 转。** 它的 transcodeToM4a 跑的是
 * `ffmpeg -i in -f ipod -c:a aac out.m4a`，**没有 `-movflags +faststart`**，
 * 于是 moov 原子落在文件末尾（实测 27KB 的文件里 moov 在 26411 字节处、
 * mdat 在 40 字节处）。moov 里装的是时长、采样率、每一帧的偏移表 ——
 * 播放器不读到它就既不知道多长、也不知道怎么定位。这正好对上两个现象：
 *
 *   - 语音条显示 **0 秒**：苹果那边扫文件头拿不到时长。
 *   - 当场能听、**退出聊天再进来就没了**：刚发完客户端手里有完整的字节，
 *     重进之后走的是按需加载，读不到前面的 moov 就渲染不出可播的语音条。
 *
 * 加上 `+faststart` 之后 ffmpeg 会把 moov 挪到最前面（实测 moov @ 32、
 * mdat @ 1183），文件大小一个字节都不变。
 *
 * 我们转好之后 spectrum 的 ensureM4a 会认出它已经是 m4a（isM4a 只看
 * `ftyp` 和 brand，`-f ipod` 出的 brand 是 `M4A `，在它的白名单里），
 * 于是原样放行、不会再转第二遍。
 *
 * 转不动就**原样退回**（返回原 buffer、不带时长），让 spectrum 按老路走 ——
 * 语音条显示 0 秒总比发不出去好。所以这个函数**永不抛错**。
 */
async function toFaststartM4a(buffer, ext, scope) {
  try {
    const bin = await ffmpegPath();
    if (!bin) {
      logWarn(scope, "找不到 ffmpeg（静态包没装、PATH 上也没有），语音条可能显示 0 秒且重进后消失");
      return { buffer, duration: undefined };
    }

    const os = await import("node:os");
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "uranus-voice-"));
    const inPath = path.join(dir, `in.${ext || "bin"}`);
    const outPath = path.join(dir, "out.m4a");
    try {
      await fs.promises.writeFile(inPath, buffer);
      const { code, stderr } = await runFfmpeg(bin, [
        "-y",
        "-i",
        inPath,
        "-f",
        "ipod",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        outPath,
      ]);

      if (code !== 0) {
        logWarn(scope, `ffmpeg 转 m4a 失败（退出码 ${code}），这条按原格式发`, clipBody(stderr));
        return { buffer, duration: undefined };
      }
      const out = await fs.promises.readFile(outPath);
      if (!out.length) {
        logWarn(scope, "ffmpeg 转出来是空文件，这条按原格式发");
        return { buffer, duration: undefined };
      }
      return { buffer: out, duration: parseFfmpegDuration(stderr) };
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (e) {
    logWarn(scope, "转 m4a 出错，这条按原格式发", String(e?.message ?? e));
    return { buffer, duration: undefined };
  }
}

/**
 * 把**收到的**语音条转成 mp3，喂给多模态模型听。顺手读出时长。
 *
 * 方向和上面那个函数相反：`toFaststartM4a` 管发出去的，这个管收进来的。
 *
 * **为什么一定要转。** iMessage 的语音条是苹果自家的容器（`.caf`，
 * 里面多半是 Opus 或 AMR），而 Gemini 支持的十三种音频 MIME 里
 * **没有 caf**。更麻烦的是我们事先并不确定 Photon 那边把附件的 mimeType
 * 报成什么 —— 与其猜，不如一律过一遍 ffmpeg：不管进来的是什么，出去的
 * 都是 `audio/mpeg`，这是那十三种里最没有争议的一个。
 *
 * **参数是按语音识别挑的，不是按音质。** 16kHz 单声道：Gemini 自己收到
 * 音频后也会降采样并把多声道并成一路，先降在这边等于把这段上传时间省了。
 * 64k 的码率在 16kHz 下已经接近透明，环境音（键盘、风、远处人声）该留的
 * 细节都还在 —— 「情绪识别」那套提示词要靠它。
 *
 * 和 toFaststartM4a 一样**永不抛错**：转不动就原样退回，让上层拿原始
 * mimeType 去碰运气（有些中转站的模型确实吃得下 caf），总比整轮放弃好。
 *
 * @param {Buffer} buffer 原始音频字节
 * @param {{ext?: string, mimeType?: string, scope: string}} opts
 *   ext 原始后缀（不带点，只用来给临时文件命名）、mimeType 原始 MIME
 *   （转不动时原样退回它）、scope 日志作用域
 * @returns {Promise<{buffer: Buffer, mimeType: string, duration?: number}>}
 */
export async function toMp3ForStt(buffer, { ext = "", mimeType = "", scope }) {
  const fallback = () => ({
    buffer,
    mimeType: mimeType || "application/octet-stream",
    duration: undefined,
  });

  try {
    const bin = await ffmpegPath();
    if (!bin) {
      logWarn(scope, "找不到 ffmpeg（静态包没装、PATH 上也没有），语音按原格式送去识别，模型可能读不了");
      return fallback();
    }

    const os = await import("node:os");
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "uranus-stt-"));
    const inPath = path.join(dir, `in.${ext || "bin"}`);
    const outPath = path.join(dir, "out.mp3");
    try {
      await fs.promises.writeFile(inPath, buffer);
      const { code, stderr } = await runFfmpeg(bin, [
        "-y",
        "-i",
        inPath,
        "-vn", // 有些容器里塞了封面图，识别用不上，去掉省流量
        "-acodec",
        "libmp3lame",
        "-ar",
        "16000",
        "-ac",
        "1",
        "-b:a",
        "64k",
        outPath,
      ]);

      if (code !== 0) {
        logWarn(scope, `ffmpeg 转 mp3 失败（退出码 ${code}），按原格式送去识别`, clipBody(stderr));
        return fallback();
      }
      const out = await fs.promises.readFile(outPath);
      if (!out.length) {
        logWarn(scope, "ffmpeg 转出来是空文件，按原格式送去识别");
        return fallback();
      }
      const duration = parseFfmpegDuration(stderr);
      logDebug(
        scope,
        `语音转码完成：${(buffer.length / 1024).toFixed(0)}KB ${ext || "?"} → ` +
          `${(out.length / 1024).toFixed(0)}KB mp3${duration ? `，${duration.toFixed(1)}s` : ""}`
      );
      return { buffer: out, mimeType: "audio/mpeg", duration };
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (e) {
    logWarn(scope, "转 mp3 出错，按原格式送去识别", String(e?.message ?? e));
    return fallback();
  }
}

/**
 * 小于这个的图**压根不动**。
 *
 * 700KB 的图上传只要一两秒，跑一趟 ffmpeg（起进程 + 读写临时文件）省下来的
 * 时间抵不上折腾。手机直出的照片、微信转发的截图基本都在这条线以上，
 * 表情包和小图标在这条线以下 —— 正好是想要的分界。
 */
const VISION_SHRINK_MIN = 700 * 1024;

/**
 * 压完最长边不超过这个。
 *
 * 各家多模态模型内部都会把图切成固定大小的 tile（Gemini 是 768、GPT 是 512），
 * 再高的分辨率进去也是先被它压掉。1600 已经比任何一家的内部尺寸都大，
 * 留的余量是给「看图里的小字」这种用法的。
 */
const VISION_MAX_SIDE = 1600;

/**
 * 把**收到的**图片压小再送去识别。
 *
 * ── 为什么要压 ──
 *
 * 上限是 20MB，而 base64 还要再胀三分之一 —— 一张手机原图能让请求体到 27MB。
 * 那 27MB 要先老老实实上传给中转站，用户在 iMessage 那头看着打字指示器等。
 * 而模型自己会把图切成 768px 的 tile，多传的那几十兆**一点用都没有**，
 * 纯粹是白等。压到 1600 边长、JPEG 质量 4，通常是几百 KB，识别结果没区别。
 *
 * ── 永不抛错 ──
 *
 * 和 toMp3ForStt 一个口径：ffmpeg 找不到、转失败、转出来反而更大，一律原样退回。
 * 压缩是**纯粹的优化**，为它让整轮识图失败是本末倒置。
 *
 * 一个已知的取舍：带透明通道的图转成 JPEG 会把透明填成黑色。真透明的图
 * （贴纸、图标）几乎都在 700KB 以下、压根走不到这儿；而 700KB 以上的 PNG
 * 基本是截图，alpha 通道全是 255，转过去颜色一模一样。
 *
 * @param {Buffer} buffer 原始图片字节
 * @param {{mimeType?: string, name?: string, scope: string}} opts
 * @returns {Promise<{buffer: Buffer, mimeType: string}>} 压不动时原样退回
 */
export async function shrinkForVision(buffer, { mimeType = "", name = "", scope }) {
  const fallback = () => ({ buffer, mimeType: mimeType || "image/jpeg" });
  const kb = (n) => (n / 1024).toFixed(0);
  if (!buffer?.length || buffer.length <= VISION_SHRINK_MIN) return fallback();

  try {
    const bin = await ffmpegPath();
    if (!bin) {
      logWarn(
        scope,
        `找不到 ffmpeg（静态包没装、PATH 上也没有），这张 ${kb(buffer.length)}KB 的图按原样送去识别，会慢一些`
      );
      return fallback();
    }

    const os = await import("node:os");
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "uranus-vis-"));
    const ext = sniffImage(buffer).ext;
    const inPath = path.join(dir, `in.${ext}`);
    const outPath = path.join(dir, "out.jpg");
    try {
      await fs.promises.writeFile(inPath, buffer);
      const { code, stderr } = await runFfmpeg(bin, [
        "-y",
        "-hide_banner",
        "-i",
        inPath,
        /*
         * 装成 `min(边长, 1600)` 的框再 decrease 收进去 —— 这样**不会放大**。
         * 直接写 `scale=1600:1600:force_original_aspect_ratio=decrease` 的话，
         * 一张 400×300 的图会被拉到 1600×1200，字节数反而涨。
         * force_divisible_by=2 是给 JPEG 的色度采样对齐用的。
         */
        "-vf",
        `scale='min(iw,${VISION_MAX_SIDE})':'min(ih,${VISION_MAX_SIDE})'` +
          ":force_original_aspect_ratio=decrease:force_divisible_by=2",
        // 动图只取第一帧：不加这个 ffmpeg 会按帧写出一串文件，而模型也只看一帧
        "-frames:v",
        "1",
        "-q:v",
        "4",
        "-pix_fmt",
        "yuvj420p",
        outPath,
      ]);

      if (code !== 0) {
        logWarn(scope, `ffmpeg 压图失败（退出码 ${code}），按原图送去识别`, clipBody(stderr));
        return fallback();
      }
      const out = await fs.promises.readFile(outPath);
      if (!out.length) {
        logWarn(scope, "ffmpeg 压出来是空文件，按原图送去识别");
        return fallback();
      }
      /*
       * 压完反而更大就别用压完的。走到这儿的多半是本来就压得很狠的 JPEG ——
       * 重新编码一次只会掉质量、还多花几百 KB。
       */
      if (out.length >= buffer.length) {
        logDebug(scope, `这张图压完反而更大（${kb(buffer.length)}KB → ${kb(out.length)}KB），按原图送`);
        return fallback();
      }

      logDebug(
        scope,
        `图片压小${name ? `「${name}」` : ""}：${kb(buffer.length)}KB ${ext} → ${kb(out.length)}KB jpg` +
          `（省了 ${Math.round((1 - out.length / buffer.length) * 100)}%）`
      );
      return { buffer: out, mimeType: "image/jpeg" };
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (e) {
    logWarn(scope, "压图出错，按原图送去识别", String(e?.message ?? e));
    return fallback();
  }
}

/** 上游错误体截一段出来，别把整页 HTML 灌进日志。 */
function clipBody(text) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

/**
 * 从字节里认图片类型，认不出按 png 走（后缀不带点）。
 *
 * 中转站给的 Content-Type 经常是 application/octet-stream 或者干脆是
 * application/json（里面装着 base64），指望不上。魔数是可靠的。
 *
 * 生图这条路上认不出也得发出去，所以这里兜底成 png；不兜底的那版在
 * `sniffImageType`。
 */
function sniffImage(buf) {
  const hit = sniffImageType(buf);
  if (!hit) return { mimeType: "image/png", ext: "png" };
  return { mimeType: hit.mimeType, ext: hit.ext.slice(1) };
}

/* ================= 语音合成 ================= */

/**
 * MiniMax 的两个站点。国内号和海外号的域名互不通用。
 *
 * 界面上是国内/国外二选一，不让用户拼域名 —— 填错站了上游只报鉴权失败。
 */
const MINIMAX_HOSTS = {
  domestic: "https://api.minimaxi.com",
  global: "https://api.minimax.io",
};

const minimaxHost = (region) =>
  region === "global" ? MINIMAX_HOSTS.global : MINIMAX_HOSTS.domestic;

/**
 * MiniMax T2A v2。
 *
 * 两个坑：
 *   1. GroupId 是**查询参数**不是请求体字段，少了它直接 401。
 *   2. `output_format: "hex"` 时 `data.audio` 是**十六进制字符串**，不是 base64。
 *      按 base64 解会得到一堆噪音（能出声，但全是杂音），排查起来很费劲。
 * HTTP 200 也不代表成功，还要看 base_resp.status_code。
 *
 * 站点由 `region` 决定（国内 / 海外），域名在这里拼 —— 两套账号的域名互不通用，
 * 拿国内的 key 打海外站报的是鉴权失败，不说「你填错站了」，让用户自己填域名
 * 是猜不出来的。`host` 只有配了自建反代时才有值（见 config.js:minimaxHost 的迁移）。
 */
async function ttsMinimax(cfg, text, voiceId) {
  const host = trimBase(cfg?.host) || minimaxHost(cfg?.region);
  const group = String(cfg?.groupId ?? "").trim();
  const url = `${host}/v1/t2a_v2${group ? `?GroupId=${encodeURIComponent(group)}` : ""}`;

  const res = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(TTS_TIMEOUT),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${String(cfg?.key ?? "").trim()}`,
    },
    body: JSON.stringify({
      model: String(cfg?.model ?? "").trim() || "speech-02-hd",
      text,
      stream: false,
      language_boost: "auto",
      output_format: "hex",
      // 音色 ID 留空时用官方的系统音色，让「没填也能出声」
      voice_setting: {
        voice_id: voiceId || "male-qn-qingse",
        speed: 1,
        vol: 1,
        pitch: 0,
      },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
    }),
    ...(await proxyFor("tts")),
  });

  const body = await res.text();
  if (!res.ok) throw new Error(`MiniMax 返回 ${res.status}：${clipBody(body)}`);

  let data = null;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`MiniMax 返回的不是 JSON：${clipBody(body)}`);
  }

  const status = data?.base_resp?.status_code;
  if (status && status !== 0) {
    throw new Error(`MiniMax 报错 ${status}：${data?.base_resp?.status_msg ?? "没给原因"}`);
  }
  const hex = data?.data?.audio;
  if (typeof hex !== "string" || !hex) {
    throw new Error(`MiniMax 没返回音频：${clipBody(body)}`);
  }
  return { buffer: Buffer.from(hex, "hex"), mimeType: "audio/mpeg", ext: "mp3" };
}

/**
 * ElevenLabs。音色 ID 在**路径**里，密钥走 xi-api-key 头（不是 Bearer）。
 *
 * 响应直接就是二进制 mp3，出错时才是 JSON —— 所以先看 res.ok 再读 body。
 */
async function ttsElevenLabs(cfg, text, voiceId) {
  // 留空时用官方文档里那个公开示例音色（Rachel），至少能出声
  const id = voiceId || "21m00Tcm4TlvDq8ikWAM";
  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(id)}` +
    "?output_format=mp3_44100_128";

  const res = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(TTS_TIMEOUT),
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": String(cfg?.key ?? "").trim(),
    },
    body: JSON.stringify({
      text,
      model_id: String(cfg?.model ?? "").trim() || "eleven_multilingual_v2",
      voice_settings: {
        stability: Number(cfg?.stability ?? 0.5),
        similarity_boost: Number(cfg?.similarityBoost ?? 0.75),
        /*
         * 风格夸张度**只在大于 0 时才发**。
         *
         * 这一项是 v2 系模型的（multilingual_v2 / turbo_v2_5）；eleven_v3 的
         * voice_settings 认的是另一套，多塞一个它不认的字段有被整个请求打回的
         * 风险。默认 0 时干脆不发，请求体和加这个功能之前一模一样 —— 不碰
         * 已经调好的配置。官方也提醒 style > 0 会让合成变慢、更容易念飘。
         */
        ...(Number(cfg?.style ?? 0) > 0 ? { style: Number(cfg.style) } : {}),
      },
    }),
    ...(await proxyFor("tts")),
  });

  if (!res.ok) {
    throw new Error(`ElevenLabs 返回 ${res.status}：${clipBody(await res.text())}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new Error("ElevenLabs 返回了空音频");
  return { buffer, mimeType: "audio/mpeg", ext: "mp3" };
}

/**
 * 本地部署的 GPT-SoVITS（api_v2.py）。没有密钥。
 *
 * `ref_audio_path` **每次都要传**，即使事先调过 /set_refer_audio —— 那个接口
 * 只是预热，参数校验照样会拦下缺这个字段的请求。所以角色上那个「音色 ID」
 * 在这一家的含义是**参考音频的路径**（界面上写了这句话），留空就退回全局配的那条。
 *
 * **这一家刻意不走代理**（另外两家 TTS 都挂了 `proxyFor("tts")`）：它打的是
 * 本机或局域网地址，把 127.0.0.1 交给机场代理多半直接连不上 —— 而用户在
 * 「代理」里勾「语音合成」，想的是 ElevenLabs 那种出不了国的，不是自己电脑上
 * 跑着的这个。
 */
async function ttsSovits(cfg, text, voiceId) {
  const base = trimBase(cfg?.url) || "http://127.0.0.1:9880";
  const refAudio = String(voiceId || cfg?.refAudioPath || "").trim();
  if (!refAudio) throw new Error("SoVITS 没填参考音频路径（角色的音色 ID 或全局配置里填一个）");

  const res = await fetch(`${base}/tts`, {
    method: "POST",
    signal: AbortSignal.timeout(TTS_TIMEOUT),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      text_lang: String(cfg?.textLang ?? "").trim() || "zh",
      ref_audio_path: refAudio,
      prompt_text: String(cfg?.promptText ?? ""),
      prompt_lang: String(cfg?.promptLang ?? "").trim() || "zh",
      text_split_method: "cut5",
      batch_size: 1,
      speed_factor: 1,
      media_type: "wav",
      streaming_mode: false,
    }),
  });

  if (!res.ok) {
    throw new Error(`SoVITS 返回 ${res.status}：${clipBody(await res.text())}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new Error("SoVITS 返回了空音频");
  return { buffer, mimeType: "audio/wav", ext: "wav" };
}

/**
 * 挑一家 TTS。顺序：minimax → elevenlabs → sovits，取第一个**开着且凭据齐**的。
 *
 * 和 websearch.js:pickSource 一个写法，区别是这里没有「不要密钥的兜底源」——
 * 三家都没配就返回 null，调用方据此退化成文字。
 *
 * `keepTags` 是给 synthesizeVoice 看的：这一家的**这个模型**认不认方括号的
 * 语气标签。ElevenLabs 只有 eleven_v3 认（[whispers] 这类是 v3 的功能），
 * v2 和另外两家都会把它们当正文念出来 —— 那种情况下不如剥掉。
 *
 * @returns {{name: string, keepTags?: boolean,
 *            run: (text: string, voiceId: string) => Promise<object>}|null}
 */
export function pickTtsSource(api) {
  const mm = api?.minimax;
  if (mm?.enabled && String(mm.key ?? "").trim()) {
    return { name: "MiniMax", run: (t, v) => ttsMinimax(mm, t, v) };
  }
  const el = api?.elevenlabs;
  if (el?.enabled && String(el.key ?? "").trim()) {
    return {
      name: "ElevenLabs",
      keepTags: /v3/i.test(String(el?.model ?? "")),
      run: (t, v) => ttsElevenLabs(el, t, v),
    };
  }
  const sv = api?.sovits;
  if (sv?.enabled && String(sv.url ?? "").trim()) {
    return { name: "GPT-SoVITS", run: (t, v) => ttsSovits(sv, t, v) };
  }
  return null;
}

/**
 * 把方括号的语气标签从要念的文本里剥掉。
 *
 * `[whispers] 过来 [sighs] 坐下` → `过来 坐下`。半角全角都认；长度限在 24 字
 * 以内 —— 语气标签就该是「一个词」的规模，更长的括号内容更像是有意义的正文
 * （引用、示例），不该顺手删。
 *
 * 只在 TTS 不认这些标签时用（见 pickTtsSource 的 keepTags）：模型写标签是想让
 * 声音带情绪，TTS 念不了的时候把它们原样喂进去，出来的语音会真的说一句
 * 「whispers」，那比没有情绪更糟。
 *
 * @returns {string} 剥完的文本。一条标签不剩时可能是空串 —— 调用方要自己兜
 */
export function stripToneTags(text) {
  return String(text ?? "")
    .replace(/[[［][^[［\]］]{1,24}[\]］]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * 合成一条语音。
 *
 * @param {object} api config.ttsApi
 * @param {string} voiceId 角色上填的音色 ID（SoVITS 那家是参考音频路径），可空
 * @param {string} text 要念的内容
 * @param {string} [scope] 日志作用域
 * @returns {Promise<{buffer: Buffer, mimeType: string, ext: string, duration: number|undefined, source: string, ms: number}>}
 *   `duration` 是秒数，读不出来时是 undefined —— 调用方**一定要**把它传给 voice()，
 *   不然 iMessage 那头的语音条显示 0:00。
 * @throws {Error} 中文原因。调用方接住之后退化成文字发出去
 */
export async function synthesizeVoice(api, voiceId, text, scope = "语音") {
  const source = pickTtsSource(api);
  if (!source) {
    throw new Error("没有可用的语音合成服务（「连接」面板里三家 TTS 都没开，或者凭据没填全）");
  }

  let clean = String(text ?? "").trim();
  if (!clean) throw new Error("语音内容是空的");

  /*
   * 语气标签剥不剥，跟着 TTS 的能力走：ElevenLabs 的 v3 认方括号音效标签，
   * 其他模型和另外两家都会把它们当正文念出来（语音里真的说一句 "whispers"）。
   * 剥掉少一分情绪，留着多一句怪话 —— 取剥掉。
   * 整条剥完一件不剩（极端情况：整条语音就是个 [laughs]）时留着原样，
   * 让合成那边自己对付，比走「内容是空的」报错再退化成文字强。
   */
  if (!source.keepTags) {
    const plain = stripToneTags(clean);
    if (plain) clean = plain;
  }

  if (clean.length > MAX_TTS_CHARS) {
    logWarn(scope, `语音内容 ${clean.length} 字，超过 ${MAX_TTS_CHARS} 字上限，已截断`);
    clean = clean.slice(0, MAX_TTS_CHARS);
  }

  const startedAt = Date.now();
  const id = String(voiceId ?? "").trim();
  // 和生图同理：合成也是同步等的，只有完成那行的话中间那段没有交代
  logInfo(scope, `开始合成语音（${source.name}，${clean.length} 字）…`);

  /*
   * 连接类的失败重试一次。
   *
   * 这台机器上的请求是走代理出去的（三个官方域名都解析到 198.18.x.x），
   * 偶发的 UND_ERR_CONNECT_TIMEOUT 是常态 —— 同一个配置上一条刚合成成功、
   * 下一条就连不上。一次连接抖动不该让这条语音退化成文字。
   *
   * 只重一次：语音是**同步**发的，对方在那头看着打字指示器，
   * 连着等两个 30s 超时比发条文字过去更糟。
   */
  let out;
  for (let attempt = 1; ; attempt += 1) {
    try {
      out = await source.run(clean, id);
      break;
    } catch (e) {
      if (attempt <= TTS_RETRIES && worthRetry(e)) {
        logWarn(scope, `${source.name} 没连上（${whyFetch(e)}），重试一次`);
        continue;
      }
      throw new Error(`${source.name} 合成失败：${whyFetch(e)}`);
    }
  }
  const ms = Date.now() - startedAt;

  /*
   * 在这里就转成 m4a，别交给 spectrum —— 它转的时候不加 +faststart，
   * moov 原子留在文件末尾，语音条会显示 0 秒、退出聊天再进来就变成一条空壳。
   * 详见 toFaststartM4a 的注释。转不动就原样退回，按老路走。
   */
  const fixed = await toFaststartM4a(out.buffer, out.ext, scope);
  const m4a = fixed.buffer !== out.buffer;

  logInfo(
    scope,
    `${source.name} 合成了 ${clean.length} 字，` +
      `${Math.round(fixed.buffer.length / 1024)}KB ${m4a ? "m4a" : out.ext}` +
      `${fixed.duration ? `／${fixed.duration.toFixed(1)}s` : "（时长读不出来）"}，耗时 ${ms}ms`
  );

  return {
    buffer: fixed.buffer,
    // 转成 m4a 了就得改口，不然 ensureM4a 会拿旧的 audio/mpeg 去判断、白转一遍
    mimeType: m4a ? "audio/mp4" : out.mimeType,
    ext: m4a ? "m4a" : out.ext,
    duration: fixed.duration,
    source: source.name,
    ms,
  };
}

/* ================= 生成图片 ================= */

/**
 * 响应里的图片可能是 base64，也可能是一条 URL。两种都认。
 *
 * **先判 URL 再判 base64**，顺序不能反：数组元素直接是个裸字符串时，
 * parseImageResponse 会把它同时当成 `b64_json` 和 `url` 试一遍
 * （中转站两种都返回过），先按 base64 解的话，一条长链接会被解成一堆垃圾字节，
 * 然后当成一张坏图发出去 —— 报错都不报。
 */
async function readImageFrom(item, scope) {
  const url = item?.url;
  if (typeof url === "string" && /^https?:\/\//i.test(url)) {
    logDebug(scope, "上游返回的是图片链接，再取一次字节");
    // 跟着「模型 API」那个勾走：这条链接是出图接口自己给的，域名通常和它同一家
    const res = await fetch(url, {
      signal: AbortSignal.timeout(IMAGE_TIMEOUT),
      ...(await proxyFor("llm")),
    });
    if (!res.ok) throw new Error(`取图片链接失败：HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  const b64 = item?.b64_json ?? item?.b64 ?? item?.image;
  // 有些中转站会带上 data:image/png;base64, 前缀
  if (typeof b64 === "string" && b64.replace(/^data:[^,]*,/, "").length >= 8) {
    return Buffer.from(b64.replace(/^data:[^,]*,/, ""), "base64");
  }
  return null;
}

/** 解析出图接口的响应体。data / images / output 三种字段名都见过。 */
async function parseImageResponse(data, raw, scope) {
  const list = Array.isArray(data?.data)
    ? data.data
    : Array.isArray(data?.images)
    ? data.images
    : Array.isArray(data?.output)
    ? data.output
    : null;
  if (!list?.length) {
    throw new Error(`返回里没有图片（缺 data 数组）：${clipBody(raw)}`);
  }
  // 数组元素也可能直接就是一个 base64 字符串或者 URL
  const first = typeof list[0] === "string" ? { b64_json: list[0], url: list[0] } : list[0];
  const buffer = await readImageFrom(first, scope);
  if (!buffer?.length) throw new Error(`返回的图片是空的：${clipBody(raw)}`);
  return buffer;
}

/**
 * 出一张图。
 *
 * 两条路：
 *   文生图  POST {base}/images/generations，JSON
 *   图生图  POST {base}/images/edits，multipart/form-data（参考图当文件传上去）
 *
 * 比例**默认一个字都不传** —— 各家默认尺寸不一样，写死一个很容易撞上「这个
 * 模型不支持 1024x1024」然后整个请求 400。所以除非用户在那个模型上明确选了
 * 一档（config.js:IMAGE_RATIOS），否则让上游用自己的默认值，行为和以前一样。
 *
 * 选了的话 `size` 和 `aspect_ratio` **两个一起发**：OpenAI 那套认前者（像素串），
 * Imagen 那套认后者（比例串），没有一个字段是通用的。多发一个不认识的字段，
 * 中转站的处理是忽略 —— 和 negative_prompt 同一个赌法。
 *
 * 正面提示词拼在画面描述**前面**（它多半是「masterpiece, best quality」这类
 * 风格词，放前面权重更高）；负面提示词走 negative_prompt 字段 —— 这不是
 * OpenAI 官方字段，但中转站普遍认，不认的会直接忽略掉，没有副作用。
 *
 * @param {object} endpoint config.js:resolveImageEndpoint 的结果
 * @param {{prompt: string, refFile?: string|null}} req refFile 是参考图的绝对路径
 * @param {string} [scope] 日志作用域
 * @returns {Promise<{buffer: Buffer, mimeType: string, ext: string, ms: number}>}
 * @throws {Error} 中文原因
 */
export async function generateImage(endpoint, req, scope = "生图") {
  const base = trimBase(endpoint?.url);
  const key = String(endpoint?.key ?? "").trim();
  const model = String(endpoint?.model ?? "").trim();
  if (!base) throw new Error("生图模型没填接口地址");
  if (!model) throw new Error("生图模型没填模型名");

  const desc = String(req?.prompt ?? "").trim();
  if (!desc) throw new Error("画面描述是空的");
  const positive = String(endpoint?.positivePrompt ?? "").trim();
  const negative = String(endpoint?.negativePrompt ?? "").trim();
  const prompt = positive ? `${positive}, ${desc}` : desc;

  const refFile = req?.refFile || null;
  const auth = key ? { Authorization: `Bearer ${key}` } : {};
  const startedAt = Date.now();
  // 出图要几十秒，而且是**同步**的（对方在那头看着打字指示器等）。
  // 以前只有成功那行日志，失败或者卡住时这段等待在控制台里没有任何痕迹
  logInfo(
    scope,
    `开始出图（${endpoint?.label ?? model}${refFile ? `，参考图 ${path.basename(refFile)}` : ""}）…`,
    desc
  );
  // 用户没选比例时是 null，下面两条路都据此整个跳过，一个字段都不加
  const ratio = endpoint?.ratio ?? null;

  let res;
  try {
    if (refFile) {
      // Node 18+ 自带 FormData / Blob / File，不需要额外依赖
      const form = new FormData();
      form.append("model", model);
      form.append("prompt", prompt);
      form.append("n", "1");
      form.append("response_format", "b64_json");
      if (negative) form.append("negative_prompt", negative);
      if (ratio) {
        form.append("size", ratio.size);
        form.append("aspect_ratio", ratio.key);
      }
      const bytes = await fs.promises.readFile(refFile);
      const ext = path.extname(refFile).toLowerCase();
      form.append(
        "image",
        new Blob([bytes], { type: mimeForExt(ext) }),
        path.basename(refFile)
      );
      res = await fetch(`${base}/images/edits`, {
        method: "POST",
        signal: AbortSignal.timeout(IMAGE_TIMEOUT),
        // Content-Type 不能自己写 —— multipart 的 boundary 要让 fetch 自己填
        headers: auth,
        body: form,
        ...(await proxyFor("llm")),
      });
    } else {
      res = await fetch(`${base}/images/generations`, {
        method: "POST",
        signal: AbortSignal.timeout(IMAGE_TIMEOUT),
        headers: { "Content-Type": "application/json", ...auth },
        body: JSON.stringify({
          model,
          prompt,
          n: 1,
          response_format: "b64_json",
          ...(negative ? { negative_prompt: negative } : {}),
          ...(ratio ? { size: ratio.size, aspect_ratio: ratio.key } : {}),
        }),
        ...(await proxyFor("llm")),
      });
    }
  } catch (e) {
    throw new Error(`生图请求失败：${whyFetch(e)}`);
  }

  const raw = await res.text();
  if (!res.ok) throw new Error(`生图接口返回 ${res.status}：${clipBody(raw)}`);

  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`生图接口返回的不是 JSON：${clipBody(raw)}`);
  }

  const buffer = await parseImageResponse(data, raw, scope);
  const ms = Date.now() - startedAt;
  const { mimeType, ext } = sniffImage(buffer);

  logInfo(
    scope,
    `${endpoint?.label ?? model} 出图成功，${Math.round(buffer.length / 1024)}KB ${ext}，` +
      `耗时 ${ms}ms${ratio ? `（要的是 ${ratio.key}）` : ""}` +
      `${refFile ? `（参考图 ${path.basename(refFile)}）` : ""}`
  );
  return { buffer, mimeType, ext, ms };
}