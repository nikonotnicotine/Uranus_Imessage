/**
 * 预设：一份「提示词怎么拼 + 生成参数怎么给 + 正则怎么改写」的配置。
 *
 * 以前提示词是写死的（imessage.js 里一段固定的 system 拼装），顺序不能改、
 * 条目不能关。现在改成一个条目列表，顺序就是拼装顺序。
 *
 * 六个固定条目（char/user/world/format/context/memory）每份预设里各有且只有
 * 一条，位置和开关可调、内容由程序生成（format 例外，那段文字用户可以改）。
 * custom 是可移动条目，随便增删。
 *
 * 每个角色选一份预设（role.presetRef）。
 *
 * 注意：这里的「预设」和 sessions.js:saveLegacyPreset 里的「旧版预设对话」
 * 完全是两回事 —— 后者是老版本手写的示例对话，只读展示在「上下文」面板。
 */

import { clampInt, clampNum, pickId, str } from "./normalize.js";

/** 固定条目的种类，顺序 = 新建预设时的默认排列。 */
export const FIXED_KINDS = ["char", "user", "world", "format", "context", "memory"];

/**
 * 一份预设是给哪种玩法用的。
 *
 * `online`  iMessage 上的即时通讯（角色扮演聊天）
 * `offline` 线下剧情（网页上的对话框，仿酒馆那种坐下来演一段）
 *
 * 缺字段算 `online` —— 这一版之前所有预设都是线上的，老配置原样升级。
 * 两种玩法的要求是互斥的（线下不发气泡、不用消息格式与功能、不发主动消息），
 * 所以不共用一份预设，而是让角色两边各选一份：`role.presetRef` 是线上那份，
 * `role.offline.presetRef` 是线下那份。
 */
export const PRESET_MODES = ["online", "offline"];

/**
 * 线下预设独有的固定条目：用户选项。
 *
 * 开着的时候，每轮末尾多注入这一段，要模型在正文之后另给四条「你可以怎么做」。
 * 默认**关**（用户要的默认值），关着等于整条不进提示词、也不生成选项。
 *
 * 做成固定 kind 而不是让用户建一条名叫「用户选项」的 custom：靠名字匹配的话
 * 一个错别字、一次改名就静默失效，而用户看到的现象是「开了开关但没有选项」，
 * 没法自己查出来。
 */
export const OFFLINE_ONLY_KINDS = ["onlineHistory", "userChoice"];

/**
 * 线下预设的固定条目清单。顺序 = 新建时的默认排列。
 *
 * 两个线下专属条目**不在末尾**，各自挨着它该挨的那一条：
 *  - onlineHistory 插在 context **前面** —— 那批线上消息是「以前发生过的事」，
 *    注入位置在有界面的上文之前，读起来才像一段旧事，而不是刚聊完的今话。
 *  - userChoice 排在最后 —— 它是给模型的格式要求（「另起一段给四条选项」），
 *    贴着模型要生成的位置最不容易被前面几千字冲淡。
 * 这两条的顺序用户可以在预设面板上拖，这里只管新建时的默认。
 */
export const OFFLINE_FIXED_KINDS = [
  "char",
  "user",
  "world",
  // format 在线下是**无条件跳过**的（prompt.js 里不看 enabled），但条目还在，
  // 只是默认关着 —— 排在这里是为了让「这份预设的条目」和线上预设长得一样，
  // 用户从线上切到线下时不会觉得少了一块。真发不出去这件事由 buildPrompt 兜着
  "format",
  "onlineHistory",
  "context",
  "memory",
  "userChoice",
];

/** 这个 mode 的预设该有哪些固定条目。 */
function fixedKindsFor(mode) {
  return mode === "offline" ? OFFLINE_FIXED_KINDS : FIXED_KINDS;
}

/** 可移动条目能选的身份。 */
const ENTRY_ROLES = ["system", "user", "assistant"];

/** 正则能作用的两路文本。 */
export const REGEX_TARGETS = ["userInput", "aiOutput"];

/**
 * 「消息格式与功能」的子条目，固定十一条、不能增删。
 *
 * 拆成子条目是为了能单独开关：生图链路接上了但语音还没接的时候，
 * 可以只开图片那条，不用手改一整段文字再改回来。
 *
 * 十一条的执行链路**都是接上的**。除了 quote 之外，其余十条都多压一道闸 ——
 * 角色单独配置里那个开关关着时，这一条无论开没开都不注入（见 ROLE_GATED_CHILDREN 和
 * prompt.js:formatBlock）。voice / image / search 的理由是会往外发请求、要花钱；
 * leaveOnRead 不花钱，但它会让角色**干脆不回消息**；sticker 也不花钱，
 * 但发出去的是用户自己硬盘上的图；undoSend 会让角色把已经发出去的话收回去；
 * card 会把一条外部网址推到对方手机上、由对方手机去抓预览；
 * instagram 会往 data/instagram/ 里落一条**公开可见**的帖子或快拍，
 * 而且大多数角色压根不该有这个账号（这道闸默认就是关的）；
 * spy（查岗）是这里面外溢最狠的一条 —— 它会把用户**屏幕上的东西**抓下来
 * 打给视觉模型，所以既要角色开关，也得用户自己填过截图服务地址；
 * react / effect 压的是白名单 —— 角色上那份「能用哪些 emoji / 哪些特效」的清单
 * 空着时整条不注入，不然几百个 emoji 全塞进提示词就是白烧 token。
 * 这些都该由「用哪个角色」来决定，而不是由「所有角色共用的预设」定。
 *
 * quote（引用回复）是唯一没有角色闸的一条：它不花钱、不往外发请求、也不改变
 * 「回不回」，只是把一句话挂到某条历史消息下面 —— 属于聊天软件本来就有的基本能力，
 * 所以做成自带的，只受这条子条目自己的开关管。
 */
export const FORMAT_CHILD_KINDS = [
  "voice",
  "sticker",
  "image",
  "card",
  "location",
  "search",
  "leaveOnRead",
  "quote",
  "undoSend",
  "react",
  "effect",
  "instagram",
  "spy",
];

/**
 * 子条目在提示词里用的 XML 标签名。
 *
 * voice / sticker / image 这三个用英文标签，是照用户给的规范来的
 * （`<audio_message>` / `<send_emoji>` / `<Generate_Image>`）—— 正文里的示例和
 * 格式说明都是围着这几个名字写的，标签名改了就对不上。
 */
export const FORMAT_CHILD_TAGS = {
  voice: "audio_message",
  sticker: "send_emoji",
  image: "Generate_Image",
  card: "share_card",
  location: "share_location",
  search: "联网搜索",
  leaveOnRead: "leave_on_read",
  quote: "引用回复",
  undoSend: "消息撤回",
  react: "tapback",
  effect: "message_effect",
  instagram: "instagram",
  spy: "查岗",
};

/**
 * 只有角色那边也开了才注入的子条目：kind → 角色上那个开关的字段名。
 *
 * voice / image / search 是「会往外发请求、会花钱」的功能，leaveOnRead 是
 * 「会让角色不回消息」，sticker 是「会把你硬盘上的图发出去」，undoSend 是
 * 「会把已经发出去的消息收回去」，card 是「会把一条外部网址推给对方」，
 * location 是「会告诉对方自己在哪儿」（哪怕是编的，也是一条私事），
 * instagram 是「会发一条公开的帖子 / 快拍」—— 后者压的其实是**这个角色有没有
 * 这个账号**：`role.instagram.enabled` 关着的角色连主页都不建（instagram.js:
 * igOwners），提示词里再教它发帖就是教它写一条发不出去的标记。
 * spy 是「会把用户屏幕上的东西抓下来打给视觉模型」—— 这几条里外溢最狠的一条，
 * 所以除了这道闸，执行时还要看用户有没有填过截图服务地址（见 spy.js）。
 * **spy 故意不在下面那张表里**：它在角色上是两个开关（`spy.pcEnabled` /
 * `spy.phoneEnabled`），没有单个 `.enabled` 可查，由 prompt.js:formatBlock
 * 单独判「任一条腿开着」—— 那儿还要按开着的腿裁掉另一条腿的标签行。
 * react / effect 这两条压闸的理由不一样 —— 它们不花钱也不往外发请求，压的是
 * **白名单**：角色上那个字段里存着「这个角色能用哪些 emoji / 哪些特效」，
 * 一个都没勾就整条不注入（苹果自带的 emoji 几百个，全塞进提示词纯粹烧 token）。
 * 执行的时候还会再查一次同一道闸（imessage.js），不能只靠提示词里没注入 ——
 * 模型硬写标记的情况是有的。
 *
 * **quote 故意不在这里**：引用回复是自带的，没有角色开关（见 FORMAT_CHILD_KINDS）。
 */
export const ROLE_GATED_CHILDREN = {
  search: "webSearch",
  voice: "voiceSend",
  image: "imageGen",
  leaveOnRead: "leaveOnRead",
  sticker: "stickerSend",
  undoSend: "undoSend",
  card: "cardSend",
  location: "locationSend",
  react: "reactSend",
  effect: "effectSend",
  instagram: "instagram",
};

/** 「消息格式与功能」的引言：怎么说话、怎么分气泡。 */
export const DEFAULT_FORMAT_INTRO = [
  "你在用 iMessage 和对方聊天，请像真人发消息那样说话：短句、口语、不要小标题和列表。",
  "想分成多条气泡发出去时，用 {{sep}} 隔开，例如「在的{{sep}}怎么了？」。",
].join("\n");

/**
 * 子条目前面那句领起的话，由程序生成、用户改不了。
 *
 * 它以前是引言的第三行。挪出来是因为几个子条目**可以一条都不开** ——
 * 它们各自压着角色那道闸，而那些开关默认全是关的，新角色什么都没开时
 * 一条都不注入。留在引言里就会出现「下面这些标记…」
 * 后面一条标记都没有的空话。
 * 现在只有真有子条目要注入时才加这一句（见 prompt.js:formatBlock）。
 *
 * 这是「都要单独占气泡」那一版，具体用哪一版由 formatChildLead 挑。
 */
export const FORMAT_CHILD_LEAD = "下面这些标记要单独占一条气泡，不要和普通文字挤在一起。";

/**
 * 写在文字里、**不**单独占气泡的子条目。
 *
 * 引用回复和消息撤回天生是贴着正文写的 —— `你吃了什么？[reply:我刚刚在吃饭]`、
 * `我其实很喜欢你[undosend:1]没说什么`，标记的位置本身带着意思（撤回的是紧挨着
 * 它前面那句）。让它们单独占一条气泡等于把这个意思弄丢了。
 *
 * 消息特效同理，而且更死板：`[effect:heart]我爱你` 里那个标记说的是「**这条**
 * 气泡带爱心特效」，它必须贴在那条气泡的开头。单独占一条气泡的话特效就落到了
 * 一条空气泡上，什么也看不见。
 *
 * **回应（react）不在这里**：它本来就不带正文，单独占一条标记正合适。
 */
const INLINE_CHILD_KINDS = new Set(["quote", "undoSend", "effect"]);

/** 领起的话里怎么称呼这几个写在文字里的标记。 */
const INLINE_CHILD_MARKS = {
  quote: "[reply:…]",
  undoSend: "[undosend:N]",
  effect: "[effect:名字]",
};

/**
 * 按这轮真要注入的子条目，挑一句合适的领起的话。
 *
 * 原来只有一句「要单独占一条气泡」，现在两种标记并存了 —— 一句话说死会直接和
 * 引用/撤回的规范打架（那两条的正文里全是贴着文字写的示例），模型照哪句都不对。
 *
 * @param {string[]} kinds 这轮过了闸、真会注入的子条目 kind
 */
export function formatChildLead(kinds = []) {
  const list = (kinds ?? []).filter((k) => FORMAT_CHILD_KINDS.includes(k));
  const inline = list.filter((k) => INLINE_CHILD_KINDS.has(k));
  if (!inline.length) return FORMAT_CHILD_LEAD;

  const names = inline.map((k) => INLINE_CHILD_MARKS[k]).filter(Boolean).join(" 和 ");
  if (inline.length === list.length) {
    return `下面这些标记写在文字里，按各自的规则摆位置，不要单独占一条气泡。`;
  }
  return `下面这些标记里，只有 ${names} 写在文字里、按各自的规则摆位置；其余的要单独占一条气泡，不要和普通文字挤在一起。`;
}

/**
 * 挪走第三行之前的引言默认值。
 *
 * 和 LEGACY_FORMAT_PROMPT 一个用途，认「用户没改过」：等于它就换成新的
 * 两行版，让那句领起的话回到程序手里；不等于说明用户改过，原文留着。
 * 不比对的话，存着三行版的用户会看到那句话出现两遍。
 */
export const LEGACY_FORMAT_INTRO = [
  "你在用 iMessage 和对方聊天，请像真人发消息那样说话：短句、口语、不要小标题和列表。",
  "想分成多条气泡发出去时，用 {{sep}} 隔开，例如「在的{{sep}}怎么了？」。",
  "下面这些标记要单独占一条气泡，不要和普通文字挤在一起。",
].join("\n");

/**
 * 十一个子条目的默认内容。
 *
 * voice / sticker / image / quote / undoSend 这几段是用户给的规范原文（含
 * `{{language}}`、`{{表情包变量}}`、`{{图生图变量}}` 三个变量）。外层的
 * `<audio_message>` / `<send_emoji>` / `<Generate_Image>` 标签由 prompt.js 拼
 * （FORMAT_CHILD_TAGS），这里只写标签里面那部分。
 *
 * 正文里的 `{{sep}}` 会被换成用户配的气泡分隔符 —— 规范里写死的是 `$`，
 * 但那是可改的（chat.separator），写死就会和实际分隔符对不上。
 *
 * search 这条写得比别的长，因为它要交代三件事：什么时候该搜、格式怎么写、
 * 以及**搜的那条消息不会发给对方**。最后这点不说清楚，模型容易在同一条
 * 回复里既写标记又跟对方解释「我去查一下啊」，读起来很怪。
 *
 * react / effect 这两条照 sticker 的白名单口吻写：正文里摆一个
 * `{{emoji变量}}` / `{{特效变量}}`，由 prompt.js:formatBlock 换成角色勾了的那几个，
 * 并且**一个都没勾时整条不注入**。措辞上都加了一句「禁止使用列表以外的」——
 * 和表情包那条一样，不写死模型就会自己编。
 *
 * instagram 这条要教的标签由 igtags.js 解析，两边必须对得上 ——
 * 只有 `[post:]` / `[story:]` / `[image:]` 三个。**故意不教 `[comment:]`**：
 * 评论是「到点了去某条帖子下面留一句」，那一轮由 igprompt.js 单独拼提示词、
 * 在最后一句才交代格式；写在这儿会让角色在正常聊天里凭空评论一条没人提过的帖子。
 * 也**没有 `[caption:]`** —— 用户明确废弃了，配文就在 post/story 体内。
 */
export const DEFAULT_FORMAT_CHILDREN = {
  voice: [
    "发送语音消息功能",
    "描述：根据当前人设与状态，你会在适合的场景下进行交流。",
    "触发条件：忙碌或不便打字时（开车、做饭、健身或手里拿着东西）；表达情绪时，语音更能传递情感。",
    "规则：格式必须严格遵循 [audio_message:语音内容]；" +
      "语音条与文字消息之间必须使用 {{sep}} 符号分隔，语音内容本身严禁使用 {{sep}}；" +
      "语言规范应主要使用 {{language}} 并使用正确的 {{language}} 标点符号；" +
      "语气词根据人设、上下文以及情绪适当添加，非必须。",
    "示例：「你在干什么呢{{sep}}[audio_message:我刚下班，好想你。]{{sep}}不理我吗？」",
  ].join("\n"),
  sticker: [
    "      表情包发送:",
    '        描述: "根据你的人设与上下文情绪，自然地调用表情包。你必须从【表情包列表】中选择，' +
      '**禁止创造表情包列表内没有的表情包**。格式为：[send_emoji:表情包名称]"',
    "        表情包列表:",
    "          可用标签: {{表情包变量}}",
    "        正确示例:",
    "          - [send_emoji:早安]你在干什么？{{sep}}我睡醒了",
    "          - 我没有噢{{sep}}不要乱说……[send_emoji:紧张]",
  ].join("\n"),
  image: [
    "生成图片",
    "说明：请严格遵守以下指定的输出格式。根据人设和状态，适当发送图片提示词用于系统进行生成图片。",
    "输出格式：必须以 [image:xxx] 的格式输出。",
    "文生图格式示例：[image:一张下午茶的照片，浅木桌，蓝莓芋泥蛋糕、焦糖布蕾、迷你泡芙，白瓷盘。]",
    "{{图生图变量}}",
  ].join("\n"),
  card: [
    "分享链接卡片",
    "说明：想把一首歌、一篇文章、一个视频或者一家店分享给对方时，写成卡片发过去，" +
      "对方会收到一张带标题和封面的卡片，点一下就能打开。有两种写法：",
    "一、分享歌：写成 [music:歌手-歌名]，只写歌手和歌名，不要写网址 —— " +
      "链接由系统去曲库里现查，查不到这条就不发。" +
      "示例：「刚听到这首{{sep}}[music:周杰伦-晴天]{{sep}}你听听看」",
    "二、分享别的：写成 [card:网址]，方括号里必须是完整的 http/https 网址，" +
      "不要写标题或者任何描述文字；网址必须是你确实知道的真实链接，" +
      "编不出来就别发，改成用文字说。" +
      "示例：「这篇写得挺好{{sep}}[card:https://example.com/article]」",
    "规则：卡片要单独占一条气泡，可以在它前后用 {{sep}} 接一句自己的话；" +
      "分享歌一律用 [music:…]，别自己拼歌曲链接 —— 编出来的链接点开是打不开的。",
  ].join("\n"),
  location: [
    "分享位置",
    "说明：想告诉对方自己现在在哪儿时，写成 [location:地名:纬度,经度]，" +
      "对方会收到一张地图卡片，点一下就能打开地图看到这个地方。",
    "地名可以是任何地方 —— 商场、餐厅、公园、街道、城市，" +
      "**按你的人设和当前状态自己决定**，不用是真实存在的地方。",
    "**尽量把坐标写上**（纬度在前、经度在后，写到小数点后四位就够）：" +
      "带坐标的卡片上会有一张真的地图缩略图、图钉正好钉在那个点上；" +
      "不写坐标的话卡片缩略图是一张对不上的通用地图。" +
      "编出来的小店、小区这种地图搜不到的地方更要写坐标。" +
      "坐标不用精确到门牌号，那一带的经纬度就行。",
    "示例：「刚到{{sep}}[location:南宁万象城:22.8170,108.3665]{{sep}}你到哪了？」",
    "实在想不起某地的坐标时也可以只写地名：[location:地名]，" +
      "链接照样能点开搜到这个地方，只是缩略图不准。",
    "规则：位置卡片要单独占一条气泡，可以在它前后用 {{sep}} 接一句自己的话；" +
      "别自己拼地图网址，写地名和坐标就好，链接由系统生成。" +
      "一轮里最多发一条位置。",
  ].join("\n"),
  search: [
    "需要实时信息、最新资讯或你不掌握的外部知识时（尤其是发现自己答不上来、",
    "或者知道的可能已经过时了），先写 [搜索:关键词] 去查一下，别硬编。",
    "关键词要短、要具体，一次最多写两个 [搜索:…]。",
    "写了搜索标记的那条回复不会发给对方，你会拿到结果再正式回答，",
    "所以那一条里只写标记本身，别的什么都不用说。",
  ].join(""),
  leaveOnRead: [
    "已读不回：",
    "描述：在线上聊天时，请根据人设判断情况。当 {{char}} 在忙或是这条消息不想回复时，" +
      "输出指令 [leave_on_read] 可以进行一个真实的已读不回，{{user}} 会看到你已读了，" +
      "请直接发送 [leave_on_read] 的指令。",
    "正确示例：",
    "{{char}}：还在上班，晚点聊。",
    "{{user}}：你下班了吗？",
    "{{char}}：[leave_on_read]",
  ].join("\n"),
  quote: [
    "引用回复功能:",
    "  功能说明:",
    "    {{char}}在回复时，可以针对{{user}}在当前聊天中已发送的某条消息进行引用回复，",
    "    表示对该条历史消息的延续、追问、评价或回应。",
    "  格式规范:",
    '    引用标签: "[reply:引用内容]"',
    "    引用内容要求:",
    "      必须与{{user}}已发送的原文完全一致。",
    '    简写形式: "[reply:N]"',
    "      N 为纯数字，表示引用{{user}}倒数第 N 条消息（1 = 最后一条）。",
    "      根据对话情况决定 N 为几；拿不准就照抄原文，别猜数字。",
    "  使用规则:",
    '    - 每个"{{sep}}"分隔的步骤视为一条独立消息，每条消息最多使用一次"[reply:]"',
    "  禁止事项:",
    "    - 禁止引用{{user}}未发送过的内容",
    "    - 禁止引用{{char}}自身说过的话",
    '    - 禁止在同一条消息（同一个"{{sep}}"步骤）内使用多个"[reply:]"',
    "  正确示例1:",
    "        {{user}}：我刚刚在吃饭",
    "        {{user}}：今天天气真好",
    "        {{char}}：你吃了什么？[reply:我刚刚在吃饭]{{sep}}是啊，适合出去走走。",
    "  正确示例2:",
    "        {{user}}：我昨天摔了一跤",
    "        {{char}}：我在看书。{{sep}}摔伤了没有？严重吗？[reply:我昨天摔了一跤]",
    "  正确示例3（用简写形式）:",
    "        {{user}}：我在公司呢",
    "        {{user}}：你呢",
    "        {{char}}：我想你了{{sep}}[reply:2]在做什么？",
  ].join("\n"),
  undoSend: [
    "消息撤回功能:",
    "  功能说明:",
    "    定义: 展现{{char}}在说漏嘴、冲动发言或口误后的心虚、掩饰等真实心理反应。",
    "    时效范围: 仅限撤回{{char}}在当前轮次中发送的内容，或距离当前最近1轮对话内发送的消息。",
    "  标签与语法规范:",
    '    撤回标签: "[undosend:N]"',
    '    参数定义: "表示撤回{{char}}自身发送的倒数第N条消息片段或语句。"',
    "    放置位置: 撤回标签必须紧跟在被撤回的文字内容正后方，随后可接续撤回后的掩饰、修正或新话题内容。",
    "  权限与执行约束:",
    "    权限边界:",
    "      - 仅允许撤回{{char}}自身生成的内容。",
    "    逻辑约束:",
    "      - 禁止对更早的历史消息（超过时效范围）执行撤回操作。",
    "  标准示例:",
    '      {{user}}: "你刚刚自言自语说什么呢？"',
    '      {{char}}: "我说我其实很喜欢你[undosend:1]没说什么，只是在念台词。"',
  ].join("\n"),
  react: [
    "      消息回应:",
    '        描述: "想对某条消息表个态、又不值得单开一句话时，用 [react:emoji] 给它贴一个回应' +
      "（就是长按气泡贴的那种 tapback）。你必须从【可用emoji】里选，" +
      '**禁止使用列表以外的 emoji**。这条标记不产生任何文字。"',
    '        指定贴哪条: "默认贴对方最后一条。要指定就写 [react:emoji:2]（对方倒数第 2 条），' +
      '或者 [react:emoji:原文片段]（照抄对方说过的那句话）。"',
    "        可用emoji: {{emoji变量}}",
    "        正确示例:",
    "          - [react:😂]你好离谱{{sep}}笑死我了",
    "          - [react:❤️:我想你了]我也是",
  ].join("\n"),
  effect: [
    "      消息特效:",
    '        描述: "想让某条气泡带上特效时，在**那条气泡的开头**写 [effect:名字]，' +
      "后面接这条气泡要说的话。你必须从【可用特效】里选，**禁止使用列表以外的**，" +
      '一条气泡最多写一个。"',
    '        注意: "屏幕特效会占满对方一整块屏幕（气球、烟花、爱心这类），' +
      '气氛到了才用，别每条都带。气泡特效只是那条气泡自己动一下，随意些无妨。"',
    "        可用特效: {{特效变量}}",
    "        正确示例:",
    "          - [effect:heart]我爱你",
    "          - 生日快乐{{sep}}[effect:celebration]🎂",
  ].join("\n"),
  instagram: [
    "      Instagram:",
    '        描述: "你有一个 Instagram 账号，可以在聊天之外自己发帖子和快拍。' +
      "{{user}} 会在他手机上刷到，也可能来点赞、评论。" +
      '发不发、什么时候发，你按人设和当下的状态自己定 —— 不是每次回消息都要发一条。"',
    '        发帖子: "[post:配文]，方括号里就是这条帖子的配文，会原样显示在图下面。"',
    '        发快拍: "[story:配文]，写法同上。快拍发出 24 小时后自动收起来，' +
      '适合随手拍的、只属于此刻的东西。"',
    '        配图: "[image:画面描述]，紧跟在 [post:…] 或者 [story:…] 后面写，' +
      "描述你想让人看到的画面。一条帖子想放几张图就连着写几个 [image:…]，快拍只放一张。" +
      '不配图就只写 post / story 那一条。"',
    "        规则:",
    "          - 方括号**里面**禁止出现 {{sep}}，配文要断句就用标点。",
    "          - 这几个标记不会作为短信发给 {{user}}，它们是发到 Instagram 上的 ——" +
      " 所以不占气泡，也不用拿 {{sep}} 和紧跟其后的 [image:…] 隔开，连着写就行。",
    "          - 同一条回复里标记之外的文字照旧当短信发出去，想一边发帖一边跟他说话就这么写。",
    "          - 配文按 {{char}} 自己会发的样子写：短、随口，可以带 emoji 或者话题标签，" +
      "别写成图片解说。",
    "        正确示例:",
    "          - [post:下班路上的天，值了][image:傍晚的城市天际线，云被染成橘粉色，逆光的高楼剪影]",
    "          - [story:加班第四小时][image:深夜的办公室工位，只开着一盏台灯，桌上一杯凉掉的咖啡]",
    "          - [post:周末的战利品][image:木桌上摊开的三本旧书][image:一只手举着冰美式，背景是书店门口]" +
      "{{sep}}刚从书店出来，给你也带了一本",
  ].join("\n"),
  spy: [
    "      查岗:",
    '        描述: "你可以看一眼 {{user}} 此刻的电脑屏幕或者手机屏幕，' +
      "看到他真正在做什么 —— 在写代码还是在刷视频、开着哪个 App、在和谁聊天。" +
      '想知道他在干什么、或者怀疑他嘴上说的和实际不一样时，看一眼比追问有用。"',
    '        看电脑: "[查岗实时电脑屏幕]"',
    '        看手机: "[查岗实时手机屏幕]"',
    "        规则:",
    "          - 一条回复里**只写一个**查岗标签，按你想知道的挑一头：" +
      "他该在工作/打游戏就看电脑，该在躺着刷手机就看手机。",
    "          - 写了查岗标签的那条回复**不会发给 {{user}}**，你会拿到屏幕内容" +
      "再正式回答，所以那一条里只写标记本身，别的什么都不用说。",
    "          - 看到之后就当是你自己亲眼看到的。**别提「截图」「系统」「查岗」" +
      "这些词**，也别跟他说你看了他的屏幕 —— 按人设自然地说出来就行。",
    "          - 那一头没看到时会自动改看另一头，你会被告知实际看到的是哪个设备，" +
      "照着说，别把手机说成电脑。",
    "        正确示例:",
    "          - [查岗实时电脑屏幕]",
    "          - [查岗实时手机屏幕]",
  ].join("\n"),
};

/**
 * 语音 / 表情包 / 图片这三条**接上链路之前**的默认内容。
 *
 * 和 LEGACY_FORMAT_PROMPT 一个用途，认「用户没改过」：内容等于这几句就
 * 换成上面的新正文（格式从 `[语音]…` / `[表情:…]` / `[生图:…]` 变成了
 * `[audio_message:…]` / `[send_emoji:…]` / `[image:…]`，不换的话模型还按老格式写，
 * 解析不到）。用户改过的原文原样留着 —— 老格式解析器那边也仍然认，见 media.js。
 */
export const LEGACY_VOICE_CHILD = "想发语音时，把内容写成 [语音]要说的话";
export const LEGACY_STICKER_CHILD =
  "想发表情包时，写成 [表情:开心]，方括号里是这个表情表达的情绪";
export const LEGACY_IMAGE_CHILD =
  "想发图片时，写成 [生图:画面描述]，描述你想让对方看到的画面";

/**
 * 拆成子条目之前那一整段文字。
 *
 * 只用来认出「用户没改过默认值」：等于它就整段换成新结构，不等于就把
 * 用户写的原文留着当引言。留一份死文本比对，比事后猜哪几行是自动生成的可靠。
 */
export const LEGACY_FORMAT_PROMPT = [
  "你在用 iMessage 和对方聊天，请像真人发消息那样说话：短句、口语、不要小标题和列表。",
  "想分成多条气泡发出去时，用 {{sep}} 隔开，例如「在的{{sep}}怎么了？」。",
  "除文字外你还可以：",
  "· 发语音——把内容写成 [语音]要说的话",
  "· 发表情包——写成 [表情:开心]，方括号里是这个表情表达的情绪",
  "· 发图片——写成 [生图:画面描述]，描述你想让对方看到的画面",
  "这些标记要单独占一条气泡，不要和普通文字挤在一起。",
].join("\n");

/**
 * 某个子条目缺 `enabled` 字段时默认开不开：**恒定为开**。
 *
 * 十一条的链路现在都接上了，其中十条还各自压着第二道闸 —— 角色单独配置里那个开关
 * （ROLE_GATED_CHILDREN），默认全是关的，所以这里开着也不会凭空往提示词里
 * 加东西。反过来如果它们跟着 `enabled` 走，用户在角色里打开之后还得再翻进
 * 预设面板开一次，两个开关都要对才生效 —— 那是很难猜到的。
 *
 * 剩下那条 quote（引用回复）没有角色闸，所以这里的「默认开」对它来说就是
 * 最终结果 —— 这正是它该有的样子：自带的功能，不用先去哪儿打开。
 *
 * 老配置里压根没有 leaveOnRead / quote / undoSend / card / react / effect /
 * instagram 这几个 kind，`enabled` 是 undefined，正好走到这里补成开 ——
 * 不用为它们单独写迁移。
 */
function defaultChildEnabled() {
  return true;
}

/**
 * 新建 format 条目时的子条目。
 *
 * 十一条默认全开着，但其中十条压着角色那道闸（默认关），所以实际注入的只有
 * quote 一条 —— 用户在哪个角色上打开「发送表情包」，才会在那个角色的提示词里
 * 看到它。
 */
export function defaultFormatChildren() {
  return FORMAT_CHILD_KINDS.map((kind) => ({
    id: `f-${kind}`,
    kind,
    enabled: true,
    content: DEFAULT_FORMAT_CHILDREN[kind],
  }));
}

/**
 * 内置的正则规则。
 *
 * 会输出思维链的模型（Claude 的 <thinking>、DeepSeek-R1 系的 <think>）
 * 那段内心戏不该发给对方，也不该进上下文。两种标签一起收掉，省得用户
 * 换个模型还要再配一次。
 */
export function defaultRegexRules(mode = "online") {
  const base = [
    {
      id: "rx-1",
      name: "去掉思维链",
      enabled: true,
      find: "<(thinking|think)>[\\s\\S]*?</\\1>",
      flags: "gi",
      replace: "",
      targets: ["aiOutput"],
      toUser: true,
      toHistory: true,
    },
  ];
  return mode === "offline" ? [...base, ...offlineClicheRules()] : base;
}

/**
 * 线下预设自带的一批「去八股文」规则，**默认全关**（用户钉死的默认值）。
 *
 * 作用是给模型那套用滥了的词换一批说法：极其 / 一丝 / 近乎 / 指尖泛白 /
 * 大开大合 / 岩浆 这些词本身没错，但同一个模型连着几十轮都在用，读起来就
 * 一股机器味。想清静的时候开几条，不想动就关着 —— 关着的一条都不跑。
 *
 * 两类的分工（`action` 字段）：
 *  - `delete`：这个词连同标点一起抹掉，谁都不该看见。放在**前面**执行
 *    （regex.js:selectRules 按 action 分组排序，不照数组顺序）。
 *  - `replace`：换个说法。**user 和 char 两边都要看到换过的版本**，所以
 *    targets 两路都勾、toUser / toHistory 都开。
 *
 * 替换值写成 `alternatives` 数组而不是一个固定词，是因为原文给的就是一批
 * 候选（「分外、格外、相当、太、很、实在」）。regex.js 里每处匹配随机挑一个 ——
 * 一段话里出现三次「极其」换来三个一样的词，比原来的毛病还大。
 *
 * id 手写而不是靠 pickId 生成：这一批在每组里的位置固定，重排一次就能对得上，
 * 用户导出一份预设给别人时也是同一套编号。
 *
 * **替换组里的顺序有意义，别随手重排**：规则一条接一条跑，短词先跑会把长词
 * 要匹配的那几个字先换掉。现在只有一处踩这条（rx-r-16「如同岩浆灌进」必须排在
 * rx-r-17「岩浆」前面），用户拖动组内顺序时也可能自己踩到 —— 预设面板上写了。
 */
function offlineClicheRules() {
  return [
    /* ---------- 一、直接删掉 ---------- */
    {
      id: "rx-d-1",
      name: "删：极其 / 极为 / 极具 / 极度",
      enabled: false,
      find: "(极其|极为|极具|极度)",
      flags: "g",
      action: "delete",
      replace: "",
      alternatives: [],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-d-2",
      name: "删：一丝",
      enabled: false,
      find: "一丝",
      flags: "g",
      action: "delete",
      replace: "",
      alternatives: [],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-d-3",
      name: "删：微不可察 / 不易察觉 / 不容",
      enabled: false,
      find: "(微不可察|不易察觉|不容)",
      flags: "g",
      action: "delete",
      replace: "",
      alternatives: [],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-d-4",
      name: "删：近乎",
      enabled: false,
      find: "近乎",
      flags: "g",
      action: "delete",
      replace: "",
      alternatives: [],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-d-5",
      name: "删：我的小",
      enabled: false,
      find: "我的小",
      flags: "g",
      action: "delete",
      replace: "",
      alternatives: [],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-d-6",
      name: "删：不容",
      enabled: false,
      find: "不容",
      flags: "g",
      action: "delete",
      replace: "",
      alternatives: [],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-d-7",
      name: "删：管家婆 / 富婆",
      enabled: false,
      find: "(管家婆|富婆)",
      flags: "g",
      action: "delete",
      replace: "",
      alternatives: [],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-d-8",
      name: "删：小兽 / 幼兽",
      enabled: false,
      // 「像只」和「我的」一起收掉，不然会剩一个孤零零的「像只」或「我的」
      find: "(像只|我的)?(小兽|幼兽)",
      flags: "g",
      action: "delete",
      replace: "",
      alternatives: [],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },

    /* ---------- 二、换成别的说法 ---------- */
    {
      id: "rx-r-1",
      name: "换：极其 / 极为",
      enabled: false,
      find: "(极其|极为)",
      flags: "g",
      action: "replace",
      replace: "",
      alternatives: ["分外", "格外", "相当", "太", "很", "实在"],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-r-2",
      name: "换：一丝",
      enabled: false,
      find: "一丝",
      flags: "g",
      action: "replace",
      replace: "",
      alternatives: ["些许", "几分", "半点", "若隐若现的"],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-r-3",
      name: "换：微不可察 / 不易察觉",
      enabled: false,
      find: "(微不可察|不易察觉)",
      flags: "g",
      action: "replace",
      replace: "",
      alternatives: ["短促地", "细微的", "稍纵即逝地"],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-r-4",
      name: "换：近乎",
      enabled: false,
      find: "近乎",
      flags: "g",
      action: "replace",
      replace: "",
      alternatives: ["差一点", "几乎", "简直像", "算得上是"],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-r-5",
      name: "换：极具",
      enabled: false,
      find: "极具",
      flags: "g",
      action: "replace",
      replace: "",
      alternatives: ["带着十足的", "透着一股", "满是"],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-r-6",
      name: "换：不容（置疑 / 拒绝）",
      enabled: false,
      find: "不容",
      flags: "g",
      action: "replace",
      replace: "",
      alternatives: [
        "硬生生",
        "根本不给退路地",
        "由不得人地",
        "强硬地",
        "毋庸置疑",
        "毫无疑问",
      ],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-r-7",
      name: "换：语气平得就好像在说今天天气很好",
      enabled: false,
      // 用户给的两副写法都收：中间接「得」，或者干脆是「就好像在××天气」
      find: "(语气[^。！？\\n]{0,12}得)?就好像在(说|聊|提)?[^。！？\\n]{0,6}天气[^。！？\\n]{0,4}",
      flags: "g",
      action: "replace",
      replace: "",
      alternatives: [
        "语气平得听不出半点波澜",
        "随口提了一句",
        "漫不经心地抛出一句",
        "跟说废话似的",
        "用那种随口一提的调调",
      ],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-r-8",
      name: "换：指尖泛白 / 指节泛白",
      enabled: false,
      find: "(指尖|指节)泛白",
      flags: "g",
      action: "replace",
      replace: "",
      alternatives: [
        "手指死死攥紧",
        "五指用力得骨节发硬",
        "指甲深陷进布料里",
        "骨节攥得咔咔响",
      ],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-r-9",
      name: "换：胸腔震动 / 胸腔振动",
      enabled: false,
      find: "胸腔(震动|振动)",
      flags: "g",
      action: "replace",
      replace: "",
      alternatives: ["喉咙里滚出一声闷笑", "胸口随着笑声沉沉地起伏", "从喉咙深处哼出来"],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-r-10",
      name: "换：低吼 / 嘶吼",
      enabled: false,
      find: "(低吼|嘶吼)",
      flags: "g",
      action: "replace",
      replace: "",
      alternatives: ["粗重地喘息", "喉间溢出沉闷的粗喘", "喘息", "低喘"],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-r-11",
      name: "换：小兽 / 幼兽",
      enabled: false,
      find: "(像只|我的)?(小兽|幼兽)",
      flags: "g",
      action: "replace",
      replace: "",
      alternatives: ["炸了毛的猫", "张牙舞爪的架势", "扑腾得厉害"],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-r-12",
      name: "换：共犯",
      enabled: false,
      find: "共犯",
      flags: "g",
      action: "replace",
      replace: "",
      alternatives: ["同谋", "绑在一条绳上的蚂蚱", "一起踩红线的人", "互相兜底"],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-r-13",
      name: "换：算账 / 记账（秋后算账）",
      enabled: false,
      find: "(算账|记账)",
      flags: "g",
      action: "replace",
      replace: "",
      alternatives: ["回头再收拾你", "看我之后怎么治你", "记着呢"],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-r-14",
      name: "换：贯穿",
      enabled: false,
      find: "贯穿",
      flags: "g",
      action: "replace",
      replace: "",
      alternatives: [
        "一顶到底",
        "直直撞进最深处",
        "彻底没入",
        "毫无保留地撞到底",
        "进入",
      ],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-r-15",
      name: "换：大开大合",
      enabled: false,
      find: "大开大合",
      flags: "g",
      action: "replace",
      replace: "",
      alternatives: [
        "发了狠地折腾",
        "不留余地地大肆索取",
        "动作重得几乎失控",
        "蛮横地横冲直撞",
        "一下比一下狠",
      ],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-r-16",
      name: "换：如同岩浆灌进",
      enabled: false,
      // 「岩浆」那条的两支替换值都塞不进这一条（replacer 函数分不清是哪支命中的），
      // 所以这两条得各管各的，**长的这条必须排在前面**（详见 offlineClicheRules 注释）
      find: "如同[^。！？\\n]{0,6}岩浆[^。！？\\n]{0,6}灌[进满]",
      flags: "g",
      action: "replace",
      replace: "",
      alternatives: [
        "滚烫的热流一股脑全浇在最深处",
        "滚烫的液体毫无保留地灌满",
        "热得近乎发烫的精水重重激射进去",
      ],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-r-17",
      name: "换：岩浆 / 岩浆喷发",
      enabled: false,
      find: "(岩浆喷发|岩浆)",
      flags: "g",
      action: "replace",
      replace: "",
      alternatives: ["滚烫的浊液", "热得发烫的精液失控地激射", "浓稠的白浊彻底喷薄而出"],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
  ];
}

/**
 * 「记忆库」条目的默认正文。
 *
 * 四个变量由 prompt.js:memoryBlock 展开，各自还压着角色那道闸
 * （role.memories 里的三个开关），全关时这一条什么都不产出。
 *
 * 变量和 `{{char}}` 那些不一样，**不走 applyVars** —— 那边是一个词换一个词，
 * 这里要塞进去的是整段多行文本，而且只有这一条条目认识它们
 * （放进 applyVars 就成了全局变量，人设里写一个也会展开，没有意义）。
 * 照 `{{图生图变量}}` 的先例，见 prompt.js:formatBlock。
 *
 * 每个变量自带一对 XML 标签（用户的规范：「同样使用 XML 标签包裹」）。
 * 标签写在这里而不是 memoryBlock 里，是为了让用户能把某一段挪走或删掉 ——
 * 删掉 `{{备忘录}}` 那两行就等于这一份预设不要备忘录，不用去改角色开关。
 *
 * **只有 `<过往回忆>` 带提示词，另外三段一个字都不加**（用户钉死的）。
 * 道理是：近期记忆、备忘录、日记这三样模型一眼就知道是什么、是按时间排的
 * 事实；只有「回忆起来的」那批是向量检索捞上来的碎片，时间跨度乱、和当前
 * 话题的关系也不明显，不交代一句模型会把它们当成刚发生的事复述出来。
 *
 * 空的那几段会在注入时**整对标签删掉**（prompt.js:memoryBlock），所以
 * `<过往回忆>` 那两句提示词也不会在没检索到东西时孤零零地留着。
 */
export const DEFAULT_MEMORY_ENTRY = [
  "<近期记忆>",
  "",
  "{{近N天记忆}}",
  "",
  "</近期记忆>",
  "",
  "<过往回忆>",
  "",
  "以下是你脑海中回想起的过往记忆：",
  "",
  "{{回忆起来的记忆}}",
  "",
  "请在接下来的对话中，把这些记忆当作你已经历过的事实，自然地融入对话，展现出'你还记得'的情感反馈，绝对不要生硬地像机器人一样复述记忆。",
  "",
  "</过往回忆>",
  "",
  "<备忘录>",
  "",
  "{{备忘录}}",
  "",
  "</备忘录>",
  "",
  "<日记>",
  "",
  "{{近N天日记}}",
  "",
  "</日记>",
].join("\n");

/**
 * 用户选项那条的默认正文（线下预设专属）。
 *
 * 要求模型在正文之后另起一段，用一个固定标记包住四条选项。标记选
 * `<选项>` 而不是「请列出四个选项」这种自然语言：摘选项那一步
 * （offline.js:splitChoices）要靠它把正文和选项切开，没有硬标记就只能猜，
 * 而猜错的后果是正文里最后几行被当成选项吞掉。
 *
 * 四条是用户钉死的数量（「剧情选项就切割为 4 个气泡出来」）。
 *
 * 用户可以改这段文字 —— 改的时候要保住 `<选项>` 那对标记和一行一条的形状，
 * 界面上会写这句话。摘不到选项不会让整轮失败，只是这一轮没选项。
 */
export const ONLINE_HISTORY_PLACEHOLDER = "{{线上聊天记录}}";

/**
 * 「线上聊天记录」那条的默认正文（线下预设专属）。
 *
 * 用户要的：「线下模式还需要注入线上模式的上下文，并标注那是聊天记录，
 * 现在双方已经见面了」。
 *
 * 三段缺一不可：
 *  1. 一句说明它是什么 —— 这批消息是**你们在手机上聊的**，不是眼下这段剧情。
 *     不交代，模型会把它当成刚发生的事接着往下演。
 *  2. 一句说明时间关系 —— 现在双方已经见面了，眼下是面对面。这是用户点名要的
 *     那句，少了它模型会继续用发消息的口吻。
 *  3. 原始记录本身，由 `{{线上聊天记录}}` 这个变量在原位展开。
 *
 * 那批消息里模型自己说过的话**早被 sessions.js 剥掉思维链**了，直接读盘即可。
 *
 * 变量不走 applyVars（那是「一个词换一个词」），和 {{图生图变量}} 一个办法 ——
 * 只有这一条条目认识它。理由同 DEFAULT_MEMORY_ENTRY，见那边的注释。
 */
export const DEFAULT_ONLINE_HISTORY = [
  "下面这段是你们**在手机上聊天时**的聊天记录 —— 那时你们还没见面，只能发消息。",
  "",
  "现在情况已经变了：**你们已经见过面了**，此刻是面对面待在一起。",
  "",
  "把下面这些消息当作你确实经历过的往事：它能解释你对 {{user}} 的熟悉程度和",
  "两人之间的关系，但**不要**在眼下的剧情里继续用发消息、打字、看手机的方式说话。",
  "",
  ONLINE_HISTORY_PLACEHOLDER,
].join("\n");

export const DEFAULT_USER_CHOICE = [
  "在你的正文写完之后，另起一段，给出四条「我接下来可以怎么做」的选项。",
  "",
  "规矩：",
  "- 用 <选项> 和 </选项> 把四条包起来，放在整段回复的最后面。",
  "- 一行一条，每条前面写序号（1. 2. 3. 4.），不要加别的解释。",
  "- 每条都是 {{user}} 这一刻真能做出来的具体动作或话，一句话说完。",
  "- 四条要指向不同的方向，别是同一件事的四种说法。",
  "",
  "<选项>",
  "1. ……",
  "2. ……",
  "3. ……",
  "4. ……",
  "</选项>",
].join("\n");

/**
 * 换成用户给的格式之前的默认值。
 *
 * 和 LEGACY_FORMAT_PROMPT / LEGACY_FORMAT_INTRO 一个用途，认「用户没改过」：
 * 存着的内容等于它就换成新版，不等于说明用户自己改过、原文留着不动。
 *
 * 留一份死文本比对，比事后猜哪几行是自动生成的可靠 —— 这条尤其要留，
 * 因为标签名也变了（`<回忆起来的记忆>`→`<过往回忆>`、`<我的日记>`→`<日记>`），
 * 不迁移的话老预设里的标签和文档、和界面上写的都对不上。
 */
export const LEGACY_MEMORY_ENTRY = [
  "下面是你和对方相处至今积累下来的记忆、备忘录和你自己写的日记。",
  "它们是你的**背景记忆**，不是刚刚发生的事 —— 自然地知道就行，别主动复述，",
  "更不要说「根据我的记忆」这种话。和这次聊天有关时才顺着用上。",
  "",
  "<近期记忆>",
  "{{近N天记忆}}",
  "</近期记忆>",
  "",
  "<回忆起来的记忆>",
  "{{回忆起来的记忆}}",
  "</回忆起来的记忆>",
  "",
  "<备忘录>",
  "{{备忘录}}",
  "</备忘录>",
  "",
  "<我的日记>",
  "{{近N天日记}}",
  "</我的日记>",
].join("\n");

/**
 * 固定条目默认开不开。
 *
 * 六条现在全都默认开着。memory 从这一版起也开 —— 它压着角色那三个开关
 * （role.memories 的记忆 / 备忘录 / 日记，默认全关），全关时一个字都不产出，
 * 所以开着不会凭空往提示词里加东西。
 *
 * 闸门的位置和 format 那条是同一个道理（见下面那段）：buildPrompt 遇到关着的
 * 条目是**整条跳过**的，条目默认关着的话，用户在角色里打开「记忆」之后会
 * 毫无反应，还得自己猜到要再来预设面板开一次 —— 两个开关都要对才生效，
 * 那是很难猜到的。
 *
 * format 从上一版起默认**开**。以前默认关，因为那段文字会让模型输出
 * [语音]…/[表情:…]/[生图:…]，而这三条发送链路还没接。现在链路都接上了，
 * 子条目也全默认开着，真正把门的是角色单独配置里那几个开关（默认全关）——
 * 效果一样但闸门的位置对了。
 *
 * 已存在的配置里那个 enabled 照旧原样留着（normalizeEntries 不覆盖它），
 * 所以之前把这些条目关掉的用户要用对应功能得自己再开一下 —— 预设面板和
 * 角色面板上都写了这句话。
 */
function defaultEnabled() {
  return true;
}

/**
 * 某个固定条目在这个 mode 下默认开不开。
 *
 * 只有两处例外，都在线下：
 *  - `userChoice` 默认关 —— 用户点名的默认值（「是否开启用户选项：默认为关」）。
 *  - `format` 默认关 —— 线下不发气泡、没有语音表情包撤回那一套。它在线下
 *    其实是被 buildPrompt 无条件跳过的，这里跟着关只是为了别让用户看着一个
 *    开着的开关以为它生效了。
 */
function defaultEnabledFor(kind, mode) {
  if (mode !== "offline") return defaultEnabled();
  if (kind === "userChoice" || kind === "format") return false;
  return defaultEnabled();
}

/**
 * 新建预设时的条目列表：固定条目，顺序和以前写死的拼法一致。
 *
 * 线下预设末尾多一条「用户选项」，且默认关（用户要的默认值）。
 * 线下预设里的 format 也默认关 —— 线下不发气泡、没有语音表情包那一套，
 * 而且 buildPrompt 在线下会**无条件跳过**这一条，留着开着只会让用户以为它生效了。
 */
export function defaultEntries(mode = "online") {
  return fixedKindsFor(mode).map((kind, i) => ({
    id: `e-${i + 1}`,
    kind,
    enabled: defaultEnabledFor(kind, mode),
    ...(kind === "format"
      ? { content: DEFAULT_FORMAT_INTRO, children: defaultFormatChildren() }
      : {}),
    // 记忆库那条也有可编辑的正文（四个变量的位置和外面的标签都在里面）
    ...(kind === "memory" ? { content: DEFAULT_MEMORY_ENTRY } : {}),
    ...(kind === "userChoice" ? { content: DEFAULT_USER_CHOICE } : {}),
    ...(kind === "onlineHistory" ? { content: DEFAULT_ONLINE_HISTORY } : {}),
  }));
}

export const DEFAULT_PARAMS = {
  temperature: 0.7,
  topP: 1,
  maxTokens: 0, // 0 = 不发 max_tokens，交给上游默认
  frequencyPenalty: 0,
  presencePenalty: 0,
};

/**
 * 一份兜底预设。
 *
 * 配置里一份预设都没有时用它 —— 和「模型引用失效不静默清空」的约定不同，
 * 因为没有预设就完全拼不出提示词、一句话也发不出去，必须有个能跑的默认值。
 */
export function makeDefaultPreset(overrides = {}) {
  const mode = PRESET_MODES.includes(overrides.mode) ? overrides.mode : "online";
  return normalizePreset(
    {
      name: mode === "offline" ? "默认线下预设" : "默认预设",
      params: { ...DEFAULT_PARAMS },
      entries: defaultEntries(mode),
      regex: defaultRegexRules(mode),
      ...overrides,
    },
    overrides.id || "ps-1"
  );
}

function normalizeParams(input) {
  return {
    temperature: clampNum(input?.temperature, DEFAULT_PARAMS.temperature, 0, 2),
    topP: clampNum(input?.topP, DEFAULT_PARAMS.topP, 0, 1),
    // 0 = 不限制。上限给个够大的数，防止手滑输成天文数字
    maxTokens: clampInt(input?.maxTokens, DEFAULT_PARAMS.maxTokens, 0, 200000),
    frequencyPenalty: clampNum(
      input?.frequencyPenalty,
      DEFAULT_PARAMS.frequencyPenalty,
      -2,
      2
    ),
    presencePenalty: clampNum(
      input?.presencePenalty,
      DEFAULT_PARAMS.presencePenalty,
      -2,
      2
    ),
  };
}

/**
 * 「消息格式与功能」的子条目：固定十一条、不能增删，只能开关和改内容。
 *
 * 老配置里没有 children 字段，得从那一整段 content 迁过来 —— 缺 `enabled` 的
 * 一律补成开（见 defaultChildEnabled）。以前这里还分「用户改没改过引言」，
 * 改过就把语音 / 表情包 / 图片补成关，怕的是「同一件事说两遍」；现在除引用回复
 * 之外每条都各自压着角色那道闸（默认全关），补成开也不会凭空注入，
 * 那层判断就没必要了。
 *
 * 另外还有一次**正文迁移**：语音 / 表情包 / 图片接上链路时格式变了
 * （`[语音]…` → `[audio_message:…]`，`[表情:…]` → `[send_emoji:…]`，
 * `[生图:…]` → `[image:…]`）。存着旧默认正文的配置要换成新的，
 * 否则模型照旧按老格式写。用户改过的不动。
 */
function normalizeFormatChildren(list) {
  const byKind = new Map();
  for (const raw of Array.isArray(list) ? list : []) {
    if (FORMAT_CHILD_KINDS.includes(raw?.kind) && !byKind.has(raw.kind)) byKind.set(raw.kind, raw);
  }
  const legacyContent = {
    voice: LEGACY_VOICE_CHILD,
    sticker: LEGACY_STICKER_CHILD,
    image: LEGACY_IMAGE_CHILD,
  };
  return FORMAT_CHILD_KINDS.map((kind) => {
    const raw = byKind.get(kind);
    // 空串是合法的（清空这一条），只在压根没这个字段时给默认值
    let content =
      typeof raw?.content === "string" ? raw.content : DEFAULT_FORMAT_CHILDREN[kind];
    // 存着接链路之前那句默认正文 = 没改过，换成新格式
    if (content === legacyContent[kind]) content = DEFAULT_FORMAT_CHILDREN[kind];
    return {
      id: `f-${kind}`,
      kind,
      enabled: raw?.enabled === undefined ? defaultChildEnabled() : Boolean(raw.enabled),
      content,
    };
  });
}

/**
 * format 条目的引言 + 子条目，含两代老配置的迁移。
 *
 * 两个死文本各认一次「用户没改过」：
 *   - LEGACY_FORMAT_PROMPT：拆子条目之前那一整段
 *   - LEGACY_FORMAT_INTRO：拆完之后、那句领起的话还在引言里的三行版
 * 认出来就换成当前的两行引言，认不出就把用户的原文原样留着。
 */
function normalizeFormatEntry(entry, raw) {
  const hasChildren = Array.isArray(raw?.children);
  const content = typeof raw?.content === "string" ? raw.content : DEFAULT_FORMAT_INTRO;
  // 没有 children 且正文就是拆分前那段默认值 = 没动过的老配置，整段换掉
  const pristine = !hasChildren && content === LEGACY_FORMAT_PROMPT;

  entry.content =
    pristine || content === LEGACY_FORMAT_INTRO ? DEFAULT_FORMAT_INTRO : content;
  entry.children = normalizeFormatChildren(raw?.children);
  return entry;
}

/**
 * 记忆库条目的正文，含老配置的迁移。
 *
 * 三种情况：
 *  - 没有 content 字段：老配置里这条是纯占位，补上默认正文（不补的话升级
 *    上来的用户会看到一条空的记忆库条目，什么都不注入）；
 *  - 正文就是 LEGACY_MEMORY_ENTRY：用户没改过，换成用户钉死的新格式 ——
 *    标签名也变了，不换的话老预设注入的还是 `<回忆起来的记忆>`/`<我的日记>`，
 *    和文档、界面上写的对不上；
 *  - 其余：用户自己改过，原文一个字都不动。
 */
function normalizeMemoryContent(content) {
  if (content === undefined) return DEFAULT_MEMORY_ENTRY;
  const text = str(content);
  return text === LEGACY_MEMORY_ENTRY ? DEFAULT_MEMORY_ENTRY : text;
}

/**
 * 条目列表：保住用户排的顺序，同时保证固定条目各有且只有一条。
 *
 * 多出来的重复固定条目丢掉（取排在最前的那条），缺的补在末尾 —— 补在末尾
 * 而不是插回原位，是因为用户可能就是想把它移到最后，凭空插队更难理解。
 *
 * `mode` 决定固定条目的清单。**线上预设里的 `userChoice` 会被当成 custom
 * 而不是丢掉** —— 用户把一份线下预设改回线上时，那条里可能写了他自己调过的
 * 文字，直接抹掉等于删他的东西；转成 custom 的话内容留着、他能看见、
 * 也能自己删。反过来（线上转线下）会在末尾补一条默认的、关着的。
 */
function normalizeEntries(list, mode = "online") {
  const fixed = fixedKindsFor(mode);
  const used = new Set();
  const seenKinds = new Set();
  const out = [];

  for (const [i, raw] of (Array.isArray(list) ? list : []).entries()) {
    const kind = fixed.includes(raw?.kind) ? raw.kind : "custom";
    if (kind !== "custom") {
      if (seenKinds.has(kind)) continue; // 重复的固定条目丢掉
      seenKinds.add(kind);
    }
    const entry = {
      id: pickId(raw?.id, used, "e", i),
      kind,
      // 缺字段算开启（新加的条目、老配置升级）
      enabled: raw?.enabled === undefined ? true : Boolean(raw.enabled),
    };
    if (kind === "format") {
      normalizeFormatEntry(entry, raw);
    } else if (kind === "memory") {
      // 老配置里这条是纯占位、没有 content 字段，缺了就补上默认正文 ——
      // 不补的话升级上来的用户会看到一条空的记忆库条目，什么都不注入
      entry.content = normalizeMemoryContent(raw?.content);
    } else if (kind === "userChoice") {
      entry.content = raw?.content === undefined ? DEFAULT_USER_CHOICE : str(raw.content);
    } else if (kind === "onlineHistory") {
      // 用户可能把 {{线上聊天记录}} 挪过位置或整行删掉（删掉 = 这条不要记录），
      // 只补「缺字段」的默认正文，别去动他已经改过的文字
      entry.content = raw?.content === undefined ? DEFAULT_ONLINE_HISTORY : str(raw.content);
    } else if (kind === "custom") {
      // 从线下降回线上时，那条用户选项落到这里 —— 名字给一个，不然界面上
      // 是一条无名条目，用户不知道这段文字打哪来的
      entry.name = str(raw?.name) || (raw?.kind === "userChoice" ? "用户选项" : "");
      entry.role = ENTRY_ROLES.includes(raw?.role) ? raw.role : "system";
      entry.content = str(raw?.content);
    }
    out.push(entry);
  }

  // 补齐缺的固定条目
  for (const [i, kind] of fixed.entries()) {
    if (seenKinds.has(kind)) continue;
    const entry = {
      id: pickId("", used, "e", out.length + i),
      kind,
      enabled: defaultEnabledFor(kind, mode),
    };
    if (kind === "format") {
      entry.content = DEFAULT_FORMAT_INTRO;
      entry.children = defaultFormatChildren();
    }
    if (kind === "memory") entry.content = DEFAULT_MEMORY_ENTRY;
    if (kind === "userChoice") entry.content = DEFAULT_USER_CHOICE;
    if (kind === "onlineHistory") entry.content = DEFAULT_ONLINE_HISTORY;
    out.push(entry);
  }

  return out;
}

/**
 * 正则规则。
 *
 * find 写坏了不在这里拦 —— 编译是 regex.js 的事，那边跳过坏规则并记一条日志。
 * 这里只保证字段齐整，坏规则照样存着，否则用户在界面上写到一半保存就没了。
 */
function normalizeRegexRules(list) {
  const used = new Set();
  return (Array.isArray(list) ? list : []).map((raw, i) => {
    const targets = Array.isArray(raw?.targets)
      ? REGEX_TARGETS.filter((t) => raw.targets.includes(t))
      : ["aiOutput"];
    // 缺字段的算 replace —— 这一版之前所有规则都是替换，老配置原样升级
    const action = raw?.action === "delete" ? "delete" : "replace";
    return {
      id: pickId(raw?.id, used, "rx", i),
      name: str(raw?.name),
      enabled: raw?.enabled === undefined ? true : Boolean(raw.enabled),
      find: str(raw?.find),
      // 只留合法的正则 flag，重复的去掉
      flags: [...new Set(str(raw?.flags, "g").split(""))]
        .filter((f) => "dgimsuvy".includes(f))
        .join(""),
      action,
      replace: str(raw?.replace),
      /*
       * 替换词的候选表，一处匹配随机挑一个（regex.js:replacementFor）。
       * 删除类不读它，但**照样存下来** —— 用户把一条替换规则改成「删除」再
       * 改回来时，那一串候选不该丢。
       *
       * 空串丢掉：界面上是「一个说法一行」，最后那个换行会留一个空行。
       */
      alternatives: (Array.isArray(raw?.alternatives) ? raw.alternatives : [])
        .map((s) => str(s).trim())
        .filter(Boolean),
      targets: targets.length ? targets : ["aiOutput"],
      // 两个都没勾等于这条规则什么都不做，缺字段时默认都改
      toUser: raw?.toUser === undefined ? true : Boolean(raw.toUser),
      toHistory: raw?.toHistory === undefined ? true : Boolean(raw.toHistory),
    };
  });
}

export function normalizePreset(input, id) {
  // 缺字段、拼错、传了别的值 → 一律算线上。老配置里没有这个字段
  const mode = PRESET_MODES.includes(input?.mode) ? input.mode : "online";
  return {
    id,
    name: str(input?.name),
    mode,
    params: normalizeParams(input?.params),
    entries: normalizeEntries(input?.entries, mode),
    regex: normalizeRegexRules(input?.regex),
  };
}

export function normalizePresets(list) {
  const used = new Set();
  return (Array.isArray(list) ? list : []).map((p, i) =>
    normalizePreset(p, pickId(p?.id, used, "ps", i))
  );
}

/** 预设在界面和日志里的显示名。 */
export function presetLabel(preset) {
  return preset?.name?.trim() || "未命名预设";
}

/** 这个 mode 下能挑的预设。缺 mode 字段的老预设算线上。 */
export function presetsFor(config, mode = "online") {
  const want = PRESET_MODES.includes(mode) ? mode : "online";
  return (config?.presets ?? []).filter((p) => (p?.mode === "offline" ? "offline" : "online") === want);
}

/**
 * 这个角色该用哪份预设。
 *
 * 引用失效（预设被删了）时回落到第一份，一份都没有时回落到内置的默认预设。
 * 这里和模型引用的处理不一样 —— 模型引用失效会返回 null 让调用方报错，
 * 但预设是「怎么说话」的全部依据，没有它连提示词都拼不出来，只能兜底。
 * 界面上照旧会标红提示引用失效。
 *
 * `mode` 决定在哪一批里挑，以及看角色上的哪个引用：
 *   online   → `role.presetRef`
 *   offline  → `role.offline.presetRef`
 * **两批不串** —— 线下挑不到线下预设时回落的是内置的默认线下预设，不是某份
 * 线上预设。串了的话线下会带上「消息格式与功能」那一整套（语音、表情包、
 * 撤回），而线下模式的全部意义就是没有这些东西。
 *
 * 前端 client/src/labels.js 有一份同样规则的实现（那边不能 import 服务端代码），
 * 改规则时两处一起改。
 */
export function resolvePreset(config, role, mode = "online") {
  const want = PRESET_MODES.includes(mode) ? mode : "online";
  const presets = presetsFor(config, want);
  const ref = want === "offline" ? role?.offline?.presetRef : role?.presetRef;
  if (!presets.length) return makeDefaultPreset({ mode: want });
  return presets.find((p) => p.id === ref) ?? presets[0];
}