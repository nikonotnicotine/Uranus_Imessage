import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

// labels.js 是纯常量 + 纯函数，不 import 这个文件，不会成环
import { FORMAT_CHILD_KINDS } from "./labels.js";
// 八股文规则的客户端副本，内容和服务端 cliche.js 一致（那边是单一事实来源）
import { clicheRules } from "./clicherules.js";

const ConfigContext = createContext(null);
const LogContext = createContext(null);

const BASE = "";

/**
 * 会话掉了的时候通知外壳。
 *
 * 模块级的一个回调，由 AuthGate 在挂载时注册。这么做而不是让每个面板自己判
 * 401：这个项目有一百多处 `api(...)` 调用，逐处判等于漏一处就有一个面板会在
 * 会话过期后卡在「读取中」。集中在这里，任何一次请求撞上 401 都能把界面
 * 整个切回登录页。
 */
let onSessionLost = null;

/** AuthGate 注册「会话掉了」的处理。返回一个注销函数。 */
export function watchSession(fn) {
  onSessionLost = fn;
  return () => {
    if (onSessionLost === fn) onSessionLost = null;
  };
}

async function api(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    // 尽量把后端给的中文错误带出来，而不是只报状态码
    let detail = "";
    let data = null;
    try {
      data = await res.json();
      detail = data?.error ?? "";
    } catch {
      /* 非 JSON 就算了 */
    }
    // 401 = 没登录或会话过期，403 + mustChange = 还在用默认密码。
    // 两种都要让外壳换页面，光把错误抛给调用方的话用户只会看到一句红字
    if (res.status === 401 || data?.needLogin || data?.mustChange) {
      onSessionLost?.(res.status === 401 ? "login" : "change");
    }
    throw new Error(detail || `请求失败 (${res.status})`);
  }
  return res.json();
}

/**
 * 从 Content-Disposition 里取文件名。
 *
 * **先认 `filename*`**：文件名里带角色名、预设名，多半是中文，后端按
 * RFC 5987 编码放在 `filename*=UTF-8''...` 里；旁边那个 `filename="..."`
 * 只是给老浏览器的 ASCII 兜底名（中文全被换成了下划线），认错了会得到
 * 一堆 `___.json`。
 */
function fileNameFrom(disposition, fallback) {
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition ?? "")?.[1];
  if (star) {
    try {
      return decodeURIComponent(star.trim());
    } catch {
      /* 编码坏了就退到下面那个 */
    }
  }
  return /filename="([^"]+)"/.exec(disposition ?? "")?.[1] || fallback;
}

/**
 * 叫一个会回文件的接口，然后弹浏览器的下载。
 *
 * 走 fetch 而不是直接把地址塞给 `<a href>`：那样失败了浏览器只会打开一个
 * 错误页，界面上报不出原因。而且导出预设/世界书是 POST（要把草稿发上去），
 * `<a>` 根本做不到。
 *
 * @returns {Promise<string>} 实际下载下来的文件名，调用方拿去显示
 */
export async function apiDownload(path, options = {}, fallback = "uranus.json") {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json())?.error ?? "";
    } catch {
      /* 非 JSON 就算了 */
    }
    throw new Error(detail || `导出失败 (${res.status})`);
  }

  const name = fileNameFrom(res.headers.get("Content-Disposition"), fallback);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return name;
}

export const ROLE_LABELS = {
  system: "系统",
  user: "用户",
  assistant: "助手",
};

export function newMessage(role = "user") {
  return { id: `c-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, role, content: "" };
}

function blankProvider(index) {
  // id 用位置生成而不是时间戳：服务端 normalizeConfig 也是这么排的，
  // 两边算出来一致，密钥才能按 id 对上（data.config.json 里就是按 id 索引）
  return {
    id: `prov-${index + 1}`,
    name: "",
    url: "",
    keys: [""],
    models: [],
  };
}

/** 新建角色 / 项目用的本地 id。带时间戳，避免和已有的撞上。 */
function newId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function blankProject() {
  return {
    id: newId("p"),
    mode: "cloud",
    projectId: "",
    projectSecret: "",
    localPath: "",
    myPhone: "",
    linePhone: "",
  };
}

function blankRole(projectRef = "") {
  return {
    id: newId("r"),
    name: "",
    description: "",
    projectRef,
    // 温度等生成参数不在这儿了 —— 它们是「怎么生成」而不是「用哪条连接」，
    // 现在归预设管（presetRef）
    chatModel: { provider: "", modelId: "" },
    fallbackModel: { enabled: false, provider: "", modelId: "" },
    visionModel: { enabled: true, provider: "", modelId: "", maxImages: 3 },
    // 听音默认关：它按秒计费，得用户自己点开（和后端 DEFAULT_CONFIG 一致）
    audioModel: { enabled: false, provider: "", modelId: "", maxClips: 2, emotion: false },
    // 读文件默认开：本地解压 / 抽文本，不打模型也不花钱（和识图一致）
    fileRead: { enabled: true, maxChars: 2000 },
    maxContext: 20,
    dropCount: 1,
    presetRef: "",
    worldBookRefs: [],
  };
}

/**
 * 新建的用户人设默认全局生效 —— 大多数人只会建一条「我自己」，
 * 建完直接就能用，不用再去理解「生效范围」这个概念。
 */
function blankUser() {
  return {
    id: newId("u"),
    name: "",
    description: "",
    scope: "global",
    roleRefs: [],
    enabled: true,
  };
}

/* ---------- 预设 / 世界书的空白模板 ---------- */

/**
 * 「消息格式与功能」的引言和十三个子条目的默认内容。
 *
 * 和 server/src/preset.js 的 DEFAULT_FORMAT_INTRO / DEFAULT_FORMAT_CHILDREN
 * 是同一批文字 —— 前端不能 import 服务端代码，所以两处各留一份，改的时候一起改。
 * （不一致也不会出错：新建的预设带前端这份，服务端只在字段压根不存在时
 * 才补它自己那份。但界面上显示的和真发出去的应该是同一段话。）
 *
 * 引言只有两行：领起子条目的那句话由服务端在真有子条目要注入时才加
 * （preset.js:formatChildLead），写在这儿会出现两遍。
 */
const DEFAULT_FORMAT_INTRO = [
  "你在用 iMessage 和对方聊天，请像真人发消息那样说话：短句、口语、不要小标题和列表。",
  "想分成多条气泡发出去时，用 {{sep}} 隔开，例如「在的{{sep}}怎么了？」。",
].join("\n");

const DEFAULT_FORMAT_CHILDREN = {
  voice: [
    "发送语音消息功能",
    "描述：根据当前人设与状态，你会在适合的场景下进行交流。",
    "触发条件：忙碌或不便打字时（开车、做饭、健身或手里拿着东西）；表达情绪时，语音更能传递情感。",
    "规则：格式必须严格遵循 [audio_message:语音内容]；" +
      "语音条与文字消息之间必须使用 {{sep}} 符号分隔，语音内容本身严禁使用 {{sep}}；" +
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
  /*
   * 查岗。两个标签都教给模型，**按角色开着哪条腿裁剪是服务端的事**
   * （server/src/spy.js:trimSpyPrompt）—— 只开一条腿时另一头那几行会被删掉，
   * 所以这份死文本里两头都写着，别在这儿按开关分叉。
   */
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
 * 子条目固定十一条、不能增删，id 也是定死的（服务端按 kind 认）。
 *
 * 十二条默认全开：它们各自还压着角色那道开关（labels.js:ROLE_GATED_CHILDREN），
 * 而那些开关默认全是关的 —— 这儿再关一道，用户就得猜「还有第二个开关在哪」。
 * 引用回复是例外，它没有角色开关，开了就直接生效。
 */
function defaultFormatChildren() {
  return FORMAT_CHILD_KINDS.map((kind) => ({
    id: `f-${kind}`,
    kind,
    enabled: true,
    content: DEFAULT_FORMAT_CHILDREN[kind],
  }));
}

/**
 * 新建预设。
 *
 * 六个固定条目的顺序、默认开关、默认参数、默认正则都和
 * server/src/preset.js 对齐（format 和 memory 默认关着，见那边的注释）。
 *
 * 线下预设（`mode: "offline"`）多一条「用户选项」，且它和 format 都默认关：
 * 用户点名用户选项默认关，而 format 在线下是被 buildPrompt **无条件跳过**的，
 * 留着开着只会让人以为它生效了。
 */
function blankPreset(mode = "online") {
  const offline = mode === "offline";
  return {
    id: newId("ps"),
    name: "",
    mode: offline ? "offline" : "online",
    params: {
      temperature: 0.7,
      topP: 1,
      maxTokens: 0, // 0 = 不发 max_tokens，交给上游默认
      frequencyPenalty: 0,
      presencePenalty: 0,
    },
    entries: [
      { id: newId("e"), kind: "char", enabled: true },
      { id: newId("e"), kind: "user", enabled: true },
      { id: newId("e"), kind: "world", enabled: true },
      {
        id: newId("e"),
        kind: "format",
        enabled: false,
        content: DEFAULT_FORMAT_INTRO,
        children: defaultFormatChildren(),
      },
      // onlineHistory 挨在 context 前面 —— 那批线上消息是「以前发生过的事」，
      // 摆在上文之前读起来才像一段旧事（服务端 OFFLINE_FIXED_KINDS 同序）
      ...(offline ? [{ id: newId("e"), kind: "onlineHistory", enabled: true }] : []),
      { id: newId("e"), kind: "context", enabled: true },
      { id: newId("e"), kind: "memory", enabled: false },
      // 正文不写在这儿：`content` 压根不给，服务端 normalizeEntries 会补上它那份
      // DEFAULT_ONLINE_HISTORY / DEFAULT_USER_CHOICE。和上面的 memory 一个办法 ——
      // 那两段话挺长，前端再抄一遍就多一处会和服务端分叉的文字
      ...(offline ? [{ id: newId("e"), kind: "userChoice", enabled: false }] : []),
    ],
    /*
     * 「去掉思维链」+ 线下那批八股文规则。
     *
     * 八股文规则来自 clicherules.js（服务端 cliche.js 的副本），**新建时就摆进
     * 草稿里**，用户一打开正则那一栏就能看见它们、能一条条开关 —— 这正是当初
     * 提的需求（「我要在正则里的，不然我都不知道我要怎么开关」）。服务端那份是
     * 单一事实来源，这份副本只是让草稿在保存之前就有内容。
     *
     * ID 在这儿重新生成（newId("rx")），不用 clicheRules 里手写的 rx-d-1 那套：
     * 手写 ID 是给**导出/粘贴**用的，同一份预设里两条规则撞 ID 会出乱子，而这份
     * 草稿将来会和别处来的规则合在一起。顺序照抄 clicheRules —— rx-r-16 必须
     * 在 rx-r-17 前面。
     */
    regex: [
      {
        id: newId("rx"),
        name: "去掉思维链",
        enabled: true,
        // 同时收掉 <thinking>（Claude）和 <think>（DeepSeek-R1 系）
        find: "<(thinking|think)>[\\s\\S]*?</\\1>",
        flags: "gi",
        action: "replace",
        replace: "",
        alternatives: [],
        targets: ["aiOutput"],
        toUser: true,
        toHistory: true,
      },
      ...(offline ? clicheRules().map((r) => ({ ...r, id: newId("rx") })) : []),
    ],
  };
}

function blankPresetEntry() {
  return {
    id: newId("e"),
    kind: "custom",
    name: "",
    role: "system",
    enabled: true,
    content: "",
  };
}

function blankRegexRule() {
  return {
    id: newId("rx"),
    name: "",
    enabled: true,
    find: "",
    flags: "g",
    // 两类规则：替换（换个说法）和删除（这个词整个不要了）。两类都跑时
    // **先删后改** —— 顺序由服务端 regex.js:selectRules 定，界面上的拖动
    // 只在同一类里生效
    action: "replace",
    replace: "",
    // 替换词的候选表，一处匹配随机挑一个。界面上是「一个说法一行」
    alternatives: [],
    targets: ["aiOutput"],
    toUser: true,
    toHistory: true,
  };
}

/** 新建世界书。默认不是全局的 —— 全局会影响所有角色，得用户自己去开。 */
/** 图库里一条新的参考图记录。名称留空，用户填完才对得上文件。 */
function blankReferenceImage() {
  return { id: newId("ri"), name: "", description: "" };
}

function blankWorldBook() {
  return {
    id: newId("wb"),
    name: "",
    enabled: true,
    global: false,
    scanDepth: 4,
    recursive: true,
    maxRecursion: 3,
    entries: [],
  };
}

function blankWorldEntry() {
  return {
    id: newId("we"),
    name: "",
    enabled: true,
    constant: false,
    keys: [],
    secondaryKeys: [],
    caseSensitive: false,
    matchWholeWords: false,
    position: "before",
    depth: 4,
    depthRole: "system",
    order: 100,
    excludeRecursion: false,
    content: "",
  };
}

/**
 * 数组里把某一项挪 delta 格。越界就原样返回（调用方不用先判边界）。
 * 预设条目、正则规则、世界书条目三处共用。
 */
function moveInList(list, id, delta) {
  const from = list.findIndex((x) => x.id === id);
  if (from < 0) return list;
  const to = from + delta;
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** 数组里把某一项挪到指定下标（拖放用）。 */
function reorderList(list, id, toIndex) {
  const from = list.findIndex((x) => x.id === id);
  if (from < 0) return list;
  const to = Math.max(0, Math.min(list.length - 1, toIndex));
  if (to === from) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** 一条规则属于哪一组。缺字段的算替换 —— 老规则全是替换。 */
export function regexActionOf(rule) {
  return rule?.action === "delete" ? "delete" : "replace";
}

/**
 * 正则规则的排列：**先删除、后替换**，两组各自保持数组里的顺序。
 *
 * 和服务端 regex.js:selectRules 是同一套规则（那边也不能 import，各写一份）。
 * 执行顺序由 action 分组说了算，不是数组顺序 —— 两类规则常常盯着同一个词
 * （「极其」既在删除表里也在替换表里），先替换成「分外」的话，删除那条就再也
 * 碰不到原文了。
 *
 * 所以拖动只在同一组里有效：挪出组等于执行顺序没变，那是假的。
 */
export function sortRegexRules(list) {
  return (Array.isArray(list) ? list : [])
    .filter(Boolean)
    .sort((a, b) => (regexActionOf(a) === "delete" ? 0 : 1) - (regexActionOf(b) === "delete" ? 0 : 1));
}

/**
 * 同一组内挪 delta 格。到组的边界就停住 —— 跨组挪没有意义（见 sortRegexRules），
 * 直接不动比挪过去再被排序弹回来好。
 */
function moveInGroup(list, id, delta) {
  const from = list.findIndex((x) => x.id === id);
  if (from < 0) return list;
  const action = regexActionOf(list[from]);
  // 同一组在数组里未必连续，所以「相邻的那一条同组项」得自己找
  let to = from;
  for (let i = from + delta; i >= 0 && i < list.length; i += delta) {
    if (regexActionOf(list[i]) === action) {
      to = i;
      break;
    }
  }
  if (to === from) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/**
 * 拖到 toIndex：只能落在同一组里，落在别组就顺次找该组离它最近的那个位置。
 *
 * 不能直接「不同组就不动」—— 界面上两组是分开渲染的，往下拖必然会划过别组的
 * 行；每划过一次都原地不动，看起来就是拖不动。找最近的位置至少方向是对的。
 */
function reorderInGroup(list, id, toIndex) {
  const from = list.findIndex((x) => x.id === id);
  if (from < 0) return list;
  const action = regexActionOf(list[from]);
  const want = Math.max(0, Math.min(list.length - 1, toIndex));
  if (want === from || regexActionOf(list[want]) === action) {
    if (want === from) return list;
    return reorderList(list, id, want);
  }
  for (let step = 1; step < list.length; step++) {
    for (const i of [want - step, want + step]) {
      if (i >= 0 && i < list.length && regexActionOf(list[i]) === action) {
        return reorderList(list, id, i);
      }
    }
  }
  return list;
}

export function ConfigProvider({ children }) {
  const [config, setConfigState] = useState(null); // 本地草稿
  const [savedConfig, setSavedConfig] = useState(null); // 最后一次落盘的内容
  const [loadError, setLoadError] = useState(null);
  const [saveState, setSaveState] = useState("idle"); // idle | saving | saved | error
  const [saveError, setSaveError] = useState(null);
  const configRef = useRef(null);

  // 初始加载
  useEffect(() => {
    api("/api/config")
      .then((c) => {
        configRef.current = c;
        setConfigState(c);
        setSavedConfig(c);
      })
      .catch((e) => setLoadError(String(e?.message ?? e)));
  }, []);

  // 改配置只动本地草稿，不再自动落盘——由「保存」按钮触发
  const updateConfig = useCallback((updater) => {
    const next = typeof updater === "function" ? updater(configRef.current) : updater;
    configRef.current = next;
    setConfigState(next);
    setSaveState("idle");
    setSaveError(null);
  }, []);

  /** 把当前草稿写盘。后端保存后会顺带重启 iMessage 桥接。 */
  const save = useCallback(async () => {
    const payload = configRef.current;
    if (!payload) return null;
    setSaveState("saving");
    setSaveError(null);
    try {
      const saved = await api("/api/config", { method: "PUT", body: payload });
      configRef.current = saved;
      setConfigState(saved);
      setSavedConfig(saved);
      setSaveState("saved");
      return saved;
    } catch (e) {
      const msg = String(e?.message ?? e);
      setSaveState("error");
      setSaveError(msg);
      throw new Error(msg);
    }
  }, []);

  /** 丢掉未保存的改动，回到磁盘上的内容。 */
  const revert = useCallback(() => {
    if (!savedConfig) return;
    configRef.current = savedConfig;
    setConfigState(savedConfig);
    setSaveState("idle");
    setSaveError(null);
  }, [savedConfig]);

  /**
   * 重新从后端读一遍配置，草稿和「已落盘」一起刷新。
   * 用在后端自己改了配置的场合（比如登记手机号会写入线路号码）。
   */
  const reload = useCallback(async () => {
    const c = await api("/api/config");
    configRef.current = c;
    setConfigState(c);
    setSavedConfig(c);
    setSaveState("idle");
    setSaveError(null);
    return c;
  }, []);

  /* ---------- 备份导出 / 导入 ---------- */

  /** 下载一份备份，返回文件名。 */
  const exportBackup = useCallback(
    (includeKeys = false) =>
      apiDownload(
        `/api/backup/export${includeKeys ? "?keys=1" : ""}`,
        {},
        "uranus-backup.json"
      ),
    []
  );

  /** 导入一份备份，然后把草稿和「已落盘」一起刷成导入后的内容。 */
  const importBackup = useCallback(
    async (bundle) => {
      const result = await api("/api/backup/import", { method: "POST", body: { bundle } });
      await reload();
      return result;
    },
    [reload]
  );

  /* ---------- 完整备份（整个 data/） ---------- */

  /**
   * 下载完整备份包，返回文件名。
   *
   * 和 `exportBackup` 一样走 `apiDownload`，只是回来的是 .tar.gz 而不是 JSON。
   * 包可能上百兆，`apiDownload` 里那句 `res.blob()` 会把它整个读进内存 ——
   * 浏览器扛得住（下载文件本来就得落地一遍），但**别在这里加进度条**：
   * fetch + blob 拿不到分段进度，要做得换 ReadableStream 手动攒。
   */
  const exportFullBackup = useCallback(
    (includeKeys = false) =>
      apiDownload(
        `/api/backup/full${includeKeys ? "?keys=1" : ""}`,
        {},
        "uranus-data.tar.gz"
      ),
    []
  );

  /** 完整备份大概多大。界面上那行说明用它，不用真打一次包。 */
  const estimateFullBackup = useCallback(
    (includeKeys = false) =>
      api(`/api/backup/full/estimate${includeKeys ? "?keys=1" : ""}`),
    []
  );

  /**
   * 拿一个完整备份包恢复。
   *
   * 直接把 `File` 当 body 发，**不包 JSON、不转 base64**：包上百兆，base64
   * 还要再涨三分之一，而后端那条路由收的就是原始字节（见 index.js 里
   * /api/backup/full/restore 的注释）。这也是这个文件里唯一一处绕开 `api()`
   * 的请求 —— 那个函数固定发 JSON。
   */
  const restoreFullBackup = useCallback(
    async (file) => {
      const res = await fetch(`${BASE}/api/backup/full/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/gzip" },
        body: file,
      });
      let data = null;
      try {
        data = await res.json();
      } catch {
        /* 后端出错时也是 JSON，解不出来说明连接断了 */
      }
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || `恢复失败 (${res.status})`);
      }
      await reload();
      return data;
    },
    [reload]
  );

  /* ---------- 云备份 ---------- */

  /*
   * 六个动作分成两拨，区别在**读的是哪一份配置**：
   *
   *  - `cloudCheck` / `cloudEstimate` 把**草稿**发上去。测连接和看体积都是
   *    「我刚填的这串密钥对不对」「我刚勾的这几块有多大」，要求先点保存
   *    才能试就本末倒置了。
   *  - `cloudPush` / `cloudList` / `cloudPull` / `cloudDelete` 用**后端落盘
   *    的那份**，什么都不发。真往云上传的东西必须是保存过的配置 —— 不然
   *    云端那份快照对应的设置在本地根本不存在，下次自动备份行为就对不上了。
   *    面板里那句「先保存」说的就是这件事。
   */

  const cloudCheck = useCallback(
    (cloudBackup) => api("/api/cloud/check", { method: "POST", body: { cloudBackup } }),
    []
  );

  /** 「这个包大概多大」。只 stat 不读内容，勾选时可以随手调。 */
  const cloudEstimate = useCallback(
    (cloudBackup) => api("/api/cloud/estimate", { method: "POST", body: { cloudBackup } }),
    []
  );

  const cloudPush = useCallback(() => api("/api/cloud/push", { method: "POST" }), []);

  const cloudList = useCallback(async () => (await api("/api/cloud/list")).snapshots ?? [], []);

  /**
   * 从云端恢复。后端已经把 data/ 换掉了，内存里这份草稿还是旧的，
   * 必须 `reload()` 刷一遍 —— 不然用户看着的还是恢复前的角色列表，
   * 一点保存就把刚恢复的东西又盖回去了。
   */
  const cloudPull = useCallback(
    async (name) => {
      const result = await api("/api/cloud/pull", { method: "POST", body: { name } });
      await reload();
      return result;
    },
    [reload]
  );

  const cloudDelete = useCallback(
    (name) => api("/api/cloud/snapshot", { method: "DELETE", body: { name } }),
    []
  );

  /** 云备份配置。和 updateMaintenance 一样兜两层，老配置里没这一块。 */
  const updateCloudBackup = useCallback(
    (patch) =>
      updateConfig((c) => ({
        ...c,
        cloudBackup: { ...(c.cloudBackup ?? {}), ...patch },
      })),
    [updateConfig]
  );

  /** 某一家的凭据（`which` 是 "s3" 或 "github"），再往里兜一层。 */
  const updateCloudCreds = useCallback(
    (which, patch) =>
      updateConfig((c) => ({
        ...c,
        cloudBackup: {
          ...(c.cloudBackup ?? {}),
          [which]: { ...(c.cloudBackup?.[which] ?? {}), ...patch },
        },
      })),
    [updateConfig]
  );

  /* ---------- 单份预设 / 单本世界书的导出导入 ---------- */

  /*
   * 和整份备份不一样的地方，两条：
   *
   * 1. **导出发的是草稿**（`preset` 参数就是界面上那份），所以刚改还没保存的
   *    内容也能导出去 —— 后端读磁盘只能读到上次保存的样子。
   * 2. **导入只进草稿，不落盘**：后端只负责规范化（发 id、补字段、重名加
   *    「（导入）」），回来的那份直接追加进 config，用户点底下的保存才写进去。
   *    所以导入不会冲掉没保存的改动，也能后悔 —— 点撤销就没了。
   */

  const exportPreset = useCallback(
    (preset) =>
      apiDownload("/api/preset/export", { method: "POST", body: { preset } }, "uranus-preset.json"),
    []
  );

  /** 导入一份预设，追加到草稿里，返回新那份（调用方拿 id 去选中）。 */
  const importPreset = useCallback(
    async (bundle) => {
      const { preset } = await api("/api/preset/import", { method: "POST", body: { bundle } });
      updateConfig((c) => ({ ...c, presets: [...(c.presets ?? []), preset] }));
      return preset;
    },
    [updateConfig]
  );

  /*
   * 正则规则的单独导出导入。
   *
   * 和预设那对的两点不同：导出的文件名带上预设名（「uranus-regexrules-线下默认预设-
   * …json」），一眼看得出这套规则是从哪儿来的；导入是**往眼前这份预设里补几条**，
   * 落在草稿上、点保存才写盘，已经是这套规则里的（按 id 认）会被跳过，所以
   * 同一份文件导两次不会翻倍，被删掉的那几条倒会补回来。
   *
   * 导出的规则用 `preset.regex`（草稿里那份），不是磁盘上的 —— 和导出预设同理。
   */
  const exportRegexRules = useCallback((rules, presetName) => {
    const slug = String(presetName ?? "").trim() || "未命名预设";
    const safe = slug.replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 40);
    return apiDownload(
      "/api/regex/export",
      { method: "POST", body: { rules, presetName: slug } },
      `uranus-regexrules-${safe}.json`
    );
  }, []);

  /** 把一批规则补进某份预设，返回一句给用户看的结果。 */
  const importRegexRules = useCallback(
    async (presetId, bundle) => {
      const target = config?.presets?.find((p) => p.id === presetId);
      const { rules, added, skipped } = await api("/api/regex/import", {
        method: "POST",
        body: { bundle, rules: target?.regex ?? [] },
      });
      if (added) {
        updateConfig((c) => ({
          ...c,
          presets: (c.presets ?? []).map((p) =>
            p.id === presetId ? { ...p, regex: [...(p.regex ?? []), ...rules] } : p
          ),
        }));
      }
      const parts = [`导入 ${added} 条`];
      if (skipped) parts.push(`已有 ${skipped} 条跳过（同一份规则不用导两遍）`);
      parts.push("还没落盘 —— 点下面的保存才写进去");
      return parts.join("，");
    },
    [config, updateConfig]
  );

  const exportWorldBook = useCallback(
    (book) =>
      apiDownload("/api/world/export", { method: "POST", body: { book } }, "uranus-worldbook.json"),
    []
  );

  /** 导入一本世界书，追加到草稿里，返回新那本。 */
  const importWorldBook = useCallback(
    async (bundle) => {
      const { book } = await api("/api/world/import", { method: "POST", body: { bundle } });
      updateConfig((c) => ({ ...c, worldBooks: [...(c.worldBooks ?? []), book] }));
      return book;
    },
    [updateConfig]
  );

  // 有没有未保存的改动
  const dirty = useMemo(() => {
    if (!config || !savedConfig) return false;
    return JSON.stringify(config) !== JSON.stringify(savedConfig);
  }, [config, savedConfig]);

  // 有未保存改动时关页面/刷新，先提醒一下
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const updateChat = useCallback(
    (patch) => updateConfig((c) => ({ ...c, chat: { ...c.chat, ...patch } })),
    [updateConfig]
  );
  const updateDelay = useCallback(
    (patch) =>
      updateConfig((c) => ({
        ...c,
        chat: { ...c.chat, delay: { ...c.chat.delay, ...patch } },
      })),
    [updateConfig]
  );
  /**
   * 定时维护（定时重启 / 定时清缓存）。`which` 是 "restart" 或 "cache"。
   *
   * `c.maintenance` 可能压根不存在（老配置里没这个字段，后端 normalize 会补上，
   * 但前端在保存之前拿到的还是老的那份），所以两层都兜一下。
   */
  const updateMaintenance = useCallback(
    (which, patch) =>
      updateConfig((c) => ({
        ...c,
        maintenance: {
          ...(c.maintenance ?? {}),
          [which]: { ...(c.maintenance?.[which] ?? {}), ...patch },
        },
      })),
    [updateConfig]
  );
  /**
   * 防相亲（开关 + 暗号）。
   *
   * 和 updateMaintenance 一样兜两层 —— 老配置里没有 `privacy` 这个字段。
   *
   * 注意这一块**在 iMessage 那头也能改**（发一次暗号就翻一次开关），所以
   * 网页上摊开的这份草稿有可能已经过时了。点保存会把草稿整份写回去，
   * 于是手机上刚开的防相亲可能被这里的旧值关掉。面板里那句提示说的就是这件事。
   */
  const updatePrivacy = useCallback(
    (patch) =>
      updateConfig((c) => ({
        ...c,
        privacy: { ...(c.privacy ?? {}), ...patch },
      })),
    [updateConfig]
  );
  /*
   * 天气 API 的 Host / Key。**全局一份，所有角色共用**。
   *
   * 不放进 role.env 是因为备份：backup.js 把 roles 原样拷进不含密钥的
   * 备份里，密钥藏在角色里就会从「不含密钥」的文件里漏出去。
   */
  const updateWeatherApi = useCallback(
    (patch) =>
      updateConfig((c) => ({ ...c, weatherApi: { ...c.weatherApi, ...patch } })),
    [updateConfig]
  );
  /**
   * 搜索 API 的密钥（Tavily / Brave）。同样**全局一份**，理由同上。
   *
   * 角色那边只有一个 role.webSearch.enabled 开关，密钥不挂在角色上。
   */
  const updateSearchApi = useCallback(
    (patch) =>
      updateConfig((c) => ({ ...c, searchApi: { ...c.searchApi, ...patch } })),
    [updateConfig]
  );
  /**
   * 手机查岗的邮件触发凭据（SMTP 账号 + 收件 iCloud 邮箱 + 校验密钥）。
   * 同样**全局一份**，理由同上 —— 而且它描述的是「用户那部 iPhone」，
   * 本来就不属于哪个角色；角色那边只有 role.spy 里的开关和模板。
   */
  const updateSpyApi = useCallback(
    (patch) => updateConfig((c) => ({ ...c, spyApi: { ...c.spyApi, ...patch } })),
    [updateConfig]
  );
  /**
   * 语音合成的凭据（MiniMax / ElevenLabs / GPT-SoVITS）。同样**全局一份**。
   *
   * 角色那边只有 role.voiceSend.enabled 和音色 ID —— 音色 ID 不是密钥，
   * 跟着角色文件一起分享出去也没关系。
   */
  const updateTtsApi = useCallback(
    (patch) => updateConfig((c) => ({ ...c, ttsApi: { ...c.ttsApi, ...patch } })),
    [updateConfig]
  );
  /**
   * 记忆库的**设置**（三个模型引用、轮数、四段提示词、日记的定时和字数…）。
   * 同样**全局一份**，角色那边只有三个开关。
   *
   * `patch` 是三块（memory / memo / diary）里的一块或几块，**每块自己也是浅合并**
   * —— 记忆那块有十几个字段，界面上改一个数就得整块重传的话，
   * 两个输入框同一帧各改一次就会互相覆盖。
   *
   * 记忆 / 日记的**正文不在这儿**：它们在 data/memories/ 下的文件里，走
   * /api/memories 那几条路由（见下面的 memoryApi），不进配置草稿 ——
   * 正文动辄几万字，跟着「保存」按钮整份来回传不合理。
   */
  const updateMemories = useCallback(
    (patch) =>
      updateConfig((c) => {
        const cur = c.memories ?? {};
        const next = { ...cur };
        for (const [kind, part] of Object.entries(patch ?? {})) {
          next[kind] = { ...(cur[kind] ?? {}), ...part };
        }
        return { ...c, memories: next };
      }),
    [updateConfig]
  );

  /* ---------- 服务商源 / 模型注册表 ---------- */

  /** 新增一个空的服务商源，返回它的 id（调用方拿去选中）。 */
  const addProvider = useCallback(() => {
    let id = "";
    updateConfig((c) => {
      const list = c.providers ?? [];
      // 位置生成的 id 可能和已有的撞上（删过中间那个再加），往后找到空位
      let n = list.length;
      let candidate = blankProvider(n);
      while (list.some((p) => p.id === candidate.id)) candidate = blankProvider(++n);
      id = candidate.id;
      return { ...c, providers: [...list, candidate] };
    });
    return id;
  }, [updateConfig]);

  const updateProvider = useCallback(
    (providerId, patch) =>
      updateConfig((c) => ({
        ...c,
        providers: (c.providers ?? []).map((p) =>
          p.id === providerId ? { ...p, ...patch } : p
        ),
      })),
    [updateConfig]
  );

  /**
   * 删服务商源。
   * 指向它的角色引用留着不动 —— 界面会标红「引用的服务商已删除」，
   * 让用户自己决定改成哪个，不偷偷改配置。
   */
  const removeProvider = useCallback(
    (providerId) =>
      updateConfig((c) => ({
        ...c,
        providers: (c.providers ?? []).filter((p) => p.id !== providerId),
      })),
    [updateConfig]
  );

  /* ---------- 密钥（一个源可以有多把，轮换用来分摊限流）---------- */

  const addProviderKey = useCallback(
    (providerId) =>
      updateConfig((c) => ({
        ...c,
        providers: (c.providers ?? []).map((p) =>
          p.id === providerId ? { ...p, keys: [...p.keys, ""] } : p
        ),
      })),
    [updateConfig]
  );

  const updateProviderKey = useCallback(
    (providerId, index, value) =>
      updateConfig((c) => ({
        ...c,
        providers: (c.providers ?? []).map((p) =>
          p.id === providerId
            ? { ...p, keys: p.keys.map((k, i) => (i === index ? value : k)) }
            : p
        ),
      })),
    [updateConfig]
  );

  /** 删一把 key。删到一把不剩时留一个空格子，不然界面上没地方填。 */
  const removeProviderKey = useCallback(
    (providerId, index) =>
      updateConfig((c) => ({
        ...c,
        providers: (c.providers ?? []).map((p) => {
          if (p.id !== providerId) return p;
          const keys = p.keys.filter((_, i) => i !== index);
          return { ...p, keys: keys.length ? keys : [""] };
        }),
      })),
    [updateConfig]
  );

  /* ---------- 模型 ---------- */

  /**
   * 把模型名批量加进某个源（「获取模型列表」弹窗的 ＋ 用这个）。
   * 已经加过的跳过，不产生重复条目。
   *
   * @param {string[]} names 上游返回的模型名
   * @param {string[]} [categories] 默认分类，不传就是聊天
   */
  const addModels = useCallback(
    (providerId, names, categories = ["chat"]) =>
      updateConfig((c) => ({
        ...c,
        providers: (c.providers ?? []).map((p) => {
          if (p.id !== providerId) return p;
          const models = [...p.models];
          for (const raw of names) {
            const model = String(raw ?? "").trim();
            if (!model || models.some((m) => m.model === model)) continue;
            // id 也按位置生成，和服务端 pickId 的规则对齐
            let n = models.length;
            let id = `m-${n + 1}`;
            while (models.some((m) => m.id === id)) id = `m-${++n + 1}`;
            models.push({
              id,
              model,
              alias: "",
              enabled: true,
              pinned: false,
              categories: [...categories],
              visionPrompt: "",
              audioPrompt: "",
              imagePrompt: "",
            });
          }
          return { ...p, models };
        }),
      })),
    [updateConfig]
  );

  const updateModel = useCallback(
    (providerId, modelId, patch) =>
      updateConfig((c) => ({
        ...c,
        providers: (c.providers ?? []).map((p) =>
          p.id === providerId
            ? {
                ...p,
                models: p.models.map((m) => (m.id === modelId ? { ...m, ...patch } : m)),
              }
            : p
        ),
      })),
    [updateConfig]
  );

  /** 删模型。同样不去动指向它的角色引用（见 removeProvider）。 */
  const removeModel = useCallback(
    (providerId, modelId) =>
      updateConfig((c) => ({
        ...c,
        providers: (c.providers ?? []).map((p) =>
          p.id === providerId
            ? { ...p, models: p.models.filter((m) => m.id !== modelId) }
            : p
        ),
      })),
    [updateConfig]
  );

  /** 勾掉/勾上一个分类。 */
  const toggleModelCategory = useCallback(
    (providerId, modelId, category) =>
      updateConfig((c) => ({
        ...c,
        providers: (c.providers ?? []).map((p) => {
          if (p.id !== providerId) return p;
          return {
            ...p,
            models: p.models.map((m) => {
              if (m.id !== modelId) return m;
              const has = (m.categories ?? []).includes(category);
              return {
                ...m,
                categories: has
                  ? m.categories.filter((x) => x !== category)
                  : [...(m.categories ?? []), category],
              };
            }),
          };
        }),
      })),
    [updateConfig]
  );

  /* ---------- 角色 ---------- */

  const updateRole = useCallback(
    (roleId, patch) =>
      updateConfig((c) => ({
        ...c,
        roles: c.roles.map((r) => (r.id === roleId ? { ...r, ...patch } : r)),
      })),
    [updateConfig]
  );

  /**
   * 新增角色。有空闲的未绑定项目就顺手绑上第一个，没有就留空 ——
   * 项目只在 iMessage 面板里新建（用户明确要求），这里不偷偷造项目，
   * 否则连点几次「新增角色」会攒出一堆空项目卡。
   * 没绑上的话「角色」面板会提示去 iMessage 面板建一个。
   *
   * @returns {string} 新角色的 id，调用方拿它切过去
   */
  const addRole = useCallback(() => {
    const id = newId("r");
    updateConfig((c) => {
      const free = c.projects.find((p) => !c.roles.some((r) => r.projectRef === p.id));
      return {
        ...c,
        roles: [...c.roles, { ...blankRole(free?.id ?? ""), id }],
      };
    });
    return id;
  }, [updateConfig]);

  /** 删角色。它绑的项目留着（凭据还有用），变回未绑定状态。 */
  const removeRole = useCallback(
    (roleId) =>
      updateConfig((c) => ({ ...c, roles: c.roles.filter((r) => r.id !== roleId) })),
    [updateConfig]
  );

  /**
   * 把一个角色的 API 配置复制给别的角色（「应用到其他角色」）。
   *
   * 复制 API 相关的八项：四条模型引用 + 读文件 + 上下文限制两项 + 用的哪份预设。
   * 预设算进来是因为它就是「这个角色怎么说话」的一部分（生成参数 + 提示词
   * 结构），和模型一起复制才配得上。
   *
   * 听音和读文件跟着识图一起复制：这三条都是**被动**的 —— 只有对方真发了图、
   * 发了语音、发了文件才会动，不会自己找上门（读文件连钱都不花，纯本地解析）。
   * 下面不复制的那几项是反过来的。
   *
   * 人设、绑定的项目、对话存档、挂的世界书一律不动 —— 那些是每个角色
   * 自己的东西，世界书更是「这个角色的设定集」，复制过去等于串设定。
   *
   * 环境感知（env）、联网搜索（webSearch）、发语音（voiceSend）、生图
   * （imageGen）、记忆库（memories）、已读不回（leaveOnRead）和主动消息
   * （proactive）都不复制。前五个会往外发请求、花额外的钱和时间，一次点击就给
   * 所有角色打开是很难收回的那种操作 —— 和天气一直以来的处理保持一致。语音和
   * 生图尤其如此：一条语音、一张图都是按次计费的；记忆库还会在磁盘上替每个角色攒流水。
   *
   * leaveOnRead 不花钱，但它那个已读回执是**会话级、不可逆**的
   * （见 imessage.js:markRead），批量替所有角色打开等于替用户改了隐私设置。
   *
   * proactive 更不能复制：它是唯一**没人操作也会自己打模型、自己往真号码发短信**
   * 的功能，一次点击等于让所有角色都开始自己找人说话。
   */
  const applyApiToRoles = useCallback(
    (fromRoleId, toRoleIds) =>
      updateConfig((c) => {
        const from = c.roles.find((r) => r.id === fromRoleId);
        if (!from) return c;
        const targets = new Set(toRoleIds);
        return {
          ...c,
          roles: c.roles.map((r) =>
            targets.has(r.id) && r.id !== fromRoleId
              ? {
                  ...r,
                  chatModel: structuredClone(from.chatModel),
                  fallbackModel: structuredClone(from.fallbackModel),
                  visionModel: structuredClone(from.visionModel),
                  audioModel: structuredClone(from.audioModel),
                  fileRead: structuredClone(from.fileRead ?? { enabled: true, maxChars: 2000 }),
                  maxContext: from.maxContext,
                  dropCount: from.dropCount,
                  presetRef: from.presetRef ?? "",
                }
              : r
          ),
        };
      }),
    [updateConfig]
  );

  /**
   * 给角色挂上/取下一本世界书。
   *
   * global 的书不用挂（它对所有角色生效），界面上那些只做只读展示。
   */
  const toggleRoleWorldBook = useCallback(
    (roleId, bookId) =>
      updateConfig((c) => ({
        ...c,
        roles: c.roles.map((r) => {
          if (r.id !== roleId) return r;
          const refs = r.worldBookRefs ?? [];
          return {
            ...r,
            worldBookRefs: refs.includes(bookId)
              ? refs.filter((x) => x !== bookId)
              : [...refs, bookId],
          };
        }),
      })),
    [updateConfig]
  );

  /* ---------- 用户人设 ---------- */

  /** 新增一条用户人设，返回它的 id（调用方拿去选中）。 */
  const addUser = useCallback(() => {
    const user = blankUser();
    updateConfig((c) => ({ ...c, users: [...(c.users ?? []), user] }));
    return user.id;
  }, [updateConfig]);

  const updateUser = useCallback(
    (userId, patch) =>
      updateConfig((c) => ({
        ...c,
        users: (c.users ?? []).map((u) => (u.id === userId ? { ...u, ...patch } : u)),
      })),
    [updateConfig]
  );

  const removeUser = useCallback(
    (userId) =>
      updateConfig((c) => ({
        ...c,
        users: (c.users ?? []).filter((u) => u.id !== userId),
      })),
    [updateConfig]
  );

  /**
   * 勾上/取消勾选一个角色（生效范围选「指定角色」时用）。
   *
   * 和项目绑定不一样：一条人设可以绑多个角色，一个角色也可能被多条人设绑
   * —— 真发出去的时候按 resolveUser 的优先级取一条，这里不做互斥。
   */
  const toggleUserRole = useCallback(
    (userId, roleId) =>
      updateConfig((c) => ({
        ...c,
        users: (c.users ?? []).map((u) => {
          if (u.id !== userId) return u;
          const refs = u.roleRefs ?? [];
          return {
            ...u,
            roleRefs: refs.includes(roleId)
              ? refs.filter((x) => x !== roleId)
              : [...refs, roleId],
          };
        }),
      })),
    [updateConfig]
  );

  /* ---------- 预设 ---------- */

  /**
   * 新增一份预设，返回它的 id（调用方拿去选中）。
   *
   * `mode` 由调用方给（预设面板上那个「新增线下预设」）。侧栏那个「+」不传，
   * 走默认的线上 —— 大多数人建的是线上预设，而建完在基本信息里点一下就能切。
   */
  const addPreset = useCallback(
    (mode = "online") => {
      const preset = blankPreset(mode);
      updateConfig((c) => ({ ...c, presets: [...(c.presets ?? []), preset] }));
      return preset.id;
    },
    [updateConfig]
  );

  const updatePreset = useCallback(
    (presetId, patch) =>
      updateConfig((c) => ({
        ...c,
        presets: (c.presets ?? []).map((p) =>
          p.id === presetId ? { ...p, ...patch } : p
        ),
      })),
    [updateConfig]
  );

  const updatePresetParams = useCallback(
    (presetId, patch) =>
      updateConfig((c) => ({
        ...c,
        presets: (c.presets ?? []).map((p) =>
          p.id === presetId ? { ...p, params: { ...p.params, ...patch } } : p
        ),
      })),
    [updateConfig]
  );

  /**
   * 删预设。指向它的角色引用留着不动 —— 界面会标红「原来选的预设已被删除」，
   * 和模型引用一个道理，不偷偷改配置。
   */
  const removePreset = useCallback(
    (presetId) =>
      updateConfig((c) => ({
        ...c,
        presets: (c.presets ?? []).filter((p) => p.id !== presetId),
      })),
    [updateConfig]
  );

  /* ---------- 预设里的条目 ---------- */

  /** 加一条可移动条目（固定条目由 normalize 补齐，这里只加 custom）。 */
  const addPresetEntry = useCallback(
    (presetId) => {
      const entry = blankPresetEntry();
      updateConfig((c) => ({
        ...c,
        presets: (c.presets ?? []).map((p) =>
          p.id === presetId ? { ...p, entries: [...(p.entries ?? []), entry] } : p
        ),
      }));
      return entry.id;
    },
    [updateConfig]
  );

  const updatePresetEntry = useCallback(
    (presetId, entryId, patch) =>
      updateConfig((c) => ({
        ...c,
        presets: (c.presets ?? []).map((p) =>
          p.id === presetId
            ? {
                ...p,
                entries: (p.entries ?? []).map((e) =>
                  e.id === entryId ? { ...e, ...patch } : e
                ),
              }
            : p
        ),
      })),
    [updateConfig]
  );

  /**
   * 改「消息格式与功能」的某个子条目（固定那十一条，见
   * labels.js:FORMAT_CHILD_KINDS）。
   *
   * 子条目不能增删，所以只有 update，没有 add / remove。按 kind 匹配而不是
   * 按 id —— 老配置迁过来的 children 是服务端补的，id 由它定。
   */
  const updateFormatChild = useCallback(
    (presetId, entryId, childKind, patch) =>
      updateConfig((c) => ({
        ...c,
        presets: (c.presets ?? []).map((p) =>
          p.id === presetId
            ? {
                ...p,
                entries: (p.entries ?? []).map((e) =>
                  e.id === entryId
                    ? {
                        ...e,
                        children: (e.children ?? []).map((ch) =>
                          ch.kind === childKind ? { ...ch, ...patch } : ch
                        ),
                      }
                    : e
                ),
              }
            : p
        ),
      })),
    [updateConfig]
  );

  /**
   * 删条目。固定条目删不掉 —— 后端 normalizeEntries 会把缺的补回末尾，
   * 删了等于把它挪到最后，比不让删更难理解。界面上也不给固定条目删除按钮。
   */
  const removePresetEntry = useCallback(
    (presetId, entryId) =>
      updateConfig((c) => ({
        ...c,
        presets: (c.presets ?? []).map((p) =>
          p.id === presetId
            ? {
                ...p,
                entries: (p.entries ?? []).filter(
                  (e) => e.id !== entryId || e.kind !== "custom"
                ),
              }
            : p
        ),
      })),
    [updateConfig]
  );

  /** 条目上移/下移（↑↓ 按钮用，delta = -1 / +1）。 */
  const movePresetEntry = useCallback(
    (presetId, entryId, delta) =>
      updateConfig((c) => ({
        ...c,
        presets: (c.presets ?? []).map((p) =>
          p.id === presetId
            ? { ...p, entries: moveInList(p.entries ?? [], entryId, delta) }
            : p
        ),
      })),
    [updateConfig]
  );

  /** 条目拖到某个下标（拖放用）。 */
  const reorderPresetEntry = useCallback(
    (presetId, entryId, toIndex) =>
      updateConfig((c) => ({
        ...c,
        presets: (c.presets ?? []).map((p) =>
          p.id === presetId
            ? { ...p, entries: reorderList(p.entries ?? [], entryId, toIndex) }
            : p
        ),
      })),
    [updateConfig]
  );

  /* ---------- 预设里的正则 ---------- */

  /** 新规则一律追加在末尾 = 落在「替换」那一组的最后（默认 action 就是替换）。 */
  const addRegexRule = useCallback(
    (presetId) => {
      const rule = blankRegexRule();
      updateConfig((c) => ({
        ...c,
        presets: (c.presets ?? []).map((p) =>
          p.id === presetId ? { ...p, regex: [...(p.regex ?? []), rule] } : p
        ),
      }));
      return rule.id;
    },
    [updateConfig]
  );

  const updateRegexRule = useCallback(
    (presetId, ruleId, patch) =>
      updateConfig((c) => ({
        ...c,
        presets: (c.presets ?? []).map((p) =>
          p.id === presetId
            ? {
                ...p,
                regex: (p.regex ?? []).map((r) =>
                  r.id === ruleId ? { ...r, ...patch } : r
                ),
              }
            : p
        ),
      })),
    [updateConfig]
  );

  const removeRegexRule = useCallback(
    (presetId, ruleId) =>
      updateConfig((c) => ({
        ...c,
        presets: (c.presets ?? []).map((p) =>
          p.id === presetId
            ? { ...p, regex: (p.regex ?? []).filter((r) => r.id !== ruleId) }
            : p
        ),
      })),
    [updateConfig]
  );

  /**
   * 正则顺序有意义，能调 —— 但只在同一类里。整体永远是**先删除、后替换**
   * （见 sortRegexRules），所以这里用 group 版的挪动函数。
   */
  const moveRegexRule = useCallback(
    (presetId, ruleId, delta) =>
      updateConfig((c) => ({
        ...c,
        presets: (c.presets ?? []).map((p) =>
          p.id === presetId
            ? { ...p, regex: moveInGroup(p.regex ?? [], ruleId, delta) }
            : p
        ),
      })),
    [updateConfig]
  );

  const reorderRegexRule = useCallback(
    (presetId, ruleId, toIndex) =>
      updateConfig((c) => ({
        ...c,
        presets: (c.presets ?? []).map((p) =>
          p.id === presetId
            ? { ...p, regex: reorderInGroup(p.regex ?? [], ruleId, toIndex) }
            : p
        ),
      })),
    [updateConfig]
  );

  /** 勾掉/勾上一路作用范围（userInput / aiOutput）。 */
  const toggleRegexTarget = useCallback(
    (presetId, ruleId, target) =>
      updateConfig((c) => ({
        ...c,
        presets: (c.presets ?? []).map((p) => {
          if (p.id !== presetId) return p;
          return {
            ...p,
            regex: (p.regex ?? []).map((r) => {
              if (r.id !== ruleId) return r;
              const targets = r.targets ?? [];
              return {
                ...r,
                targets: targets.includes(target)
                  ? targets.filter((x) => x !== target)
                  : [...targets, target],
              };
            }),
          };
        }),
      })),
    [updateConfig]
  );

  /* ---------- 参考图图库 ---------- */

  /**
   * 图库条目 = 名称 + 描述，图片文件本身在 data/images/ 里，不经过前端。
   *
   * 名称同时是三样东西：文件名（不带后缀）、模型写在 `[小猫]` 里的那个词、
   * 角色 imageGen.refs 里存的值。所以改名之后角色那边的引用会失效 ——
   * 和世界书被删一样，不静默清理，界面上标出来让用户自己改。
   */
  const addReferenceImage = useCallback(() => {
    const ref = blankReferenceImage();
    updateConfig((c) => ({
      ...c,
      referenceImages: [...(c.referenceImages ?? []), ref],
    }));
    return ref.id;
  }, [updateConfig]);

  const updateReferenceImage = useCallback(
    (refId, patch) =>
      updateConfig((c) => ({
        ...c,
        referenceImages: (c.referenceImages ?? []).map((r) =>
          r.id === refId ? { ...r, ...patch } : r
        ),
      })),
    [updateConfig]
  );

  /**
   * 删一条图库记录。
   *
   * `data/images/` 里那个图片文件**不动** —— 前端删不了用户的文件，
   * 而且删配置和删图片是两件事，后者用户自己去文件夹里做。
   * 角色 imageGen.refs 里的引用也留着，理由同 removeWorldBook。
   */
  const removeReferenceImage = useCallback(
    (refId) =>
      updateConfig((c) => ({
        ...c,
        referenceImages: (c.referenceImages ?? []).filter((r) => r.id !== refId),
      })),
    [updateConfig]
  );

  /*
   * 表情包图库这儿一个动作都没有，不是漏了。
   *
   * 一个标签 = data/images/emojis/ 下的一个文件夹，建标签、传图、删图全都是
   * 直接打后端接口（/api/emojis…）改硬盘，立刻生效，不走 config、不用点保存。
   * 硬盘上有图的标签**默认全都注入**，只被角色自己的黑名单
   * （role.stickerSend.blacklist，在角色配置里）减一遍 —— 以前还额外存过一份
   * 「勾了哪些允许注入」，和黑名单是同一件事说两遍，已经整个删掉。
   */

  /* ---------- 世界书 ---------- */

  /** 新增一本世界书，返回它的 id。 */
  const addWorldBook = useCallback(() => {
    const book = blankWorldBook();
    updateConfig((c) => ({ ...c, worldBooks: [...(c.worldBooks ?? []), book] }));
    return book.id;
  }, [updateConfig]);

  const updateWorldBook = useCallback(
    (bookId, patch) =>
      updateConfig((c) => ({
        ...c,
        worldBooks: (c.worldBooks ?? []).map((b) =>
          b.id === bookId ? { ...b, ...patch } : b
        ),
      })),
    [updateConfig]
  );

  /**
   * 删世界书。角色的 worldBookRefs 里那条引用留着不动（和模型引用一个道理），
   * 界面会标红。
   */
  const removeWorldBook = useCallback(
    (bookId) =>
      updateConfig((c) => ({
        ...c,
        worldBooks: (c.worldBooks ?? []).filter((b) => b.id !== bookId),
      })),
    [updateConfig]
  );

  /* ---------- 世界书里的条目 ---------- */

  const addWorldEntry = useCallback(
    (bookId) => {
      const entry = blankWorldEntry();
      updateConfig((c) => ({
        ...c,
        worldBooks: (c.worldBooks ?? []).map((b) =>
          b.id === bookId ? { ...b, entries: [...(b.entries ?? []), entry] } : b
        ),
      }));
      return entry.id;
    },
    [updateConfig]
  );

  const updateWorldEntry = useCallback(
    (bookId, entryId, patch) =>
      updateConfig((c) => ({
        ...c,
        worldBooks: (c.worldBooks ?? []).map((b) =>
          b.id === bookId
            ? {
                ...b,
                entries: (b.entries ?? []).map((e) =>
                  e.id === entryId ? { ...e, ...patch } : e
                ),
              }
            : b
        ),
      })),
    [updateConfig]
  );

  const removeWorldEntry = useCallback(
    (bookId, entryId) =>
      updateConfig((c) => ({
        ...c,
        worldBooks: (c.worldBooks ?? []).map((b) =>
          b.id === bookId
            ? { ...b, entries: (b.entries ?? []).filter((e) => e.id !== entryId) }
            : b
        ),
      })),
    [updateConfig]
  );

  /**
   * 条目上移/下移。
   *
   * 注意这只是**界面上的**顺序 —— 真正决定注入顺序的是每条的 order 字段
   * （见 worldinfo.js:activate）。挪动时不去动 order，否则用户精心排的
   * order 会被一次拖动搞乱。
   */
  const moveWorldEntry = useCallback(
    (bookId, entryId, delta) =>
      updateConfig((c) => ({
        ...c,
        worldBooks: (c.worldBooks ?? []).map((b) =>
          b.id === bookId
            ? { ...b, entries: moveInList(b.entries ?? [], entryId, delta) }
            : b
        ),
      })),
    [updateConfig]
  );

  const reorderWorldEntry = useCallback(
    (bookId, entryId, toIndex) =>
      updateConfig((c) => ({
        ...c,
        worldBooks: (c.worldBooks ?? []).map((b) =>
          b.id === bookId
            ? { ...b, entries: reorderList(b.entries ?? [], entryId, toIndex) }
            : b
        ),
      })),
    [updateConfig]
  );

  /**
   * 关键词是分隔符隔开的一行字，存的是数组，这里做转换。
   *
   * 分隔符要连顿号一起收 —— 界面上回显用的就是「、」（`keys.join("、")`），
   * 输入框的 placeholder 也写着「王都、阿瓦隆」。只认逗号的话，用户照着提示
   * 打出来的一串会被存成**一个**关键词，而且界面回显看着一模一样，根本发现
   * 不了。分号也一起收，中英文都收。
   */
  const setWorldEntryKeys = useCallback(
    (bookId, entryId, field, raw) =>
      updateConfig((c) => ({
        ...c,
        worldBooks: (c.worldBooks ?? []).map((b) =>
          b.id === bookId
            ? {
                ...b,
                entries: (b.entries ?? []).map((e) =>
                  e.id === entryId
                    ? {
                        ...e,
                        [field]: String(raw ?? "")
                          .split(/[,，、;；\n]/)
                          .map((k) => k.trim())
                          .filter(Boolean),
                      }
                    : e
                ),
              }
            : b
        ),
      })),
    [updateConfig]
  );

  /* ---------- 项目 ---------- */

  const updateProject = useCallback(
    (projectRefId, patch) =>
      updateConfig((c) => ({
        ...c,
        projects: c.projects.map((p) => (p.id === projectRefId ? { ...p, ...patch } : p)),
      })),
    [updateConfig]
  );

  /** 新建一个空项目，返回它的 id。 */
  const addProject = useCallback(() => {
    const project = blankProject();
    updateConfig((c) => ({ ...c, projects: [...c.projects, project] }));
    return project.id;
  }, [updateConfig]);

  /** 删项目。绑在它上面的角色变回未绑定。 */
  const removeProject = useCallback(
    (projectRefId) =>
      updateConfig((c) => ({
        ...c,
        projects: c.projects.filter((p) => p.id !== projectRefId),
        roles: c.roles.map((r) =>
          r.projectRef === projectRefId ? { ...r, projectRef: "" } : r
        ),
      })),
    [updateConfig]
  );

  /**
   * 把项目绑给角色。一个项目只能被一个角色绑，所以原来绑它的角色要先松手
   * （否则后端 normalizeConfig 会把后来者的绑定置空，用户看着像没生效）。
   *
   * @param {string} projectRefId 传 "" 表示解绑
   */
  const bindProject = useCallback(
    (roleId, projectRefId) =>
      updateConfig((c) => ({
        ...c,
        roles: c.roles.map((r) => {
          if (r.id === roleId) return { ...r, projectRef: projectRefId };
          // 别人正占着这个项目，让它松手
          if (projectRefId && r.projectRef === projectRefId) return { ...r, projectRef: "" };
          return r;
        }),
      })),
    [updateConfig]
  );

  return (
    <ConfigContext.Provider
      value={{
        config,
        /*
         * 最后一次落盘的那份。绝大多数界面只该看草稿（`config`），这个是给
         * 「这一格存了没」这类判断用的 —— 天气密钥那块要知道预览接口读到的
         * 是哪一版（预览只从已保存的配置读密钥，不收查询参数）。
         */
        savedConfig,
        loadError,
        saveState,
        saveError,
        dirty,
        save,
        revert,
        reload,
        updateConfig,
        updateChat,
        updateDelay,
        updateMaintenance,
        updatePrivacy,
        updateWeatherApi,
        updateSearchApi,
        updateSpyApi,
        updateTtsApi,
        updateMemories,
        // 备份
        exportBackup,
        importBackup,
        exportFullBackup,
        estimateFullBackup,
        restoreFullBackup,
        // 云备份
        updateCloudBackup,
        updateCloudCreds,
        cloudCheck,
        cloudEstimate,
        cloudPush,
        cloudList,
        cloudPull,
        cloudDelete,
        // 单份预设 / 单本世界书的搬家
        exportPreset,
        importPreset,
        exportRegexRules,
        importRegexRules,
        exportWorldBook,
        importWorldBook,
        // 服务商源
        addProvider,
        updateProvider,
        removeProvider,
        addProviderKey,
        updateProviderKey,
        removeProviderKey,
        // 模型注册表
        addModels,
        updateModel,
        removeModel,
        toggleModelCategory,
        // 角色
        addRole,
        removeRole,
        updateRole,
        applyApiToRoles,
        toggleRoleWorldBook,
        // 用户人设
        addUser,
        updateUser,
        removeUser,
        toggleUserRole,
        // 预设
        addPreset,
        updatePreset,
        updatePresetParams,
        removePreset,
        addPresetEntry,
        updatePresetEntry,
        updateFormatChild,
        removePresetEntry,
        movePresetEntry,
        reorderPresetEntry,
        // 正则（属于预设）
        addRegexRule,
        updateRegexRule,
        removeRegexRule,
        moveRegexRule,
        reorderRegexRule,
        toggleRegexTarget,
        // 世界书
        addWorldBook,
        updateWorldBook,
        removeWorldBook,
        addWorldEntry,
        updateWorldEntry,
        removeWorldEntry,
        moveWorldEntry,
        reorderWorldEntry,
        setWorldEntryKeys,
        // 参考图图库
        addReferenceImage,
        updateReferenceImage,
        removeReferenceImage,
        // 项目
        addProject,
        removeProject,
        updateProject,
        bindProject,
      }}
    >
      {children}
    </ConfigContext.Provider>
  );
}

export function useConfig() {
  const ctx = useContext(ConfigContext);
  if (!ctx) throw new Error("useConfig 必须用在 <ConfigProvider> 内");
  return ctx;
}

/* ================= 运行日志 ================= */

const LOG_MAX = 1000; // 前端只留最近这么多条，再多就吃内存

/**
 * 订阅后端日志流（SSE）。
 *
 * 全局只开一条连接：Provider 挂在最外层，控制台面板切走了也继续收，
 * 这样切回来能看到期间发生的事。断线由浏览器的 EventSource 自动重连，
 * 重连时带上最后一条 id，避免补发已经看过的日志。
 */
export function LogProvider({ children }) {
  const [logs, setLogs] = useState([]);
  const [connected, setConnected] = useState(false);
  const lastIdRef = useRef(0);
  const esRef = useRef(null);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const bufferRef = useRef([]);
  // 暂停期间攒了多少条。ref 变化不会触发重渲染，所以计数单独用 state。
  const [pendingCount, setPendingCount] = useState(0);

  const append = useCallback((entries) => {
    if (!entries.length) return;
    setLogs((prev) => {
      const next = prev.concat(entries);
      return next.length > LOG_MAX ? next.slice(next.length - LOG_MAX) : next;
    });
  }, []);

  useEffect(() => {
    let closed = false;

    function connect() {
      if (closed) return;
      // 带 since：重连后只要没见过的，别把历史再刷一遍
      const url = `/api/logs/stream${lastIdRef.current ? `?since=${lastIdRef.current}` : ""}`;
      const es = new EventSource(url);
      esRef.current = es;

      es.onopen = () => setConnected(true);
      es.onmessage = (e) => {
        let entry;
        try {
          entry = JSON.parse(e.data);
        } catch {
          return;
        }
        if (typeof entry?.id === "number") {
          // 后端清空日志会让 id 从头开始，这时别再拿旧 id 当水位
          if (entry.id > lastIdRef.current || entry.id === 1) lastIdRef.current = entry.id;
        }
        if (pausedRef.current) {
          bufferRef.current.push(entry);
          setPendingCount(bufferRef.current.length);
        } else {
          append([entry]);
        }
      };
      es.onerror = () => {
        setConnected(false);
        // EventSource 自己会重连，但连接已经彻底关掉时要手动再开
        if (es.readyState === EventSource.CLOSED && !closed) {
          setTimeout(connect, 2000);
        }
      };
    }

    connect();
    return () => {
      closed = true;
      esRef.current?.close();
    };
  }, [append]);

  /** 暂停时新日志先进缓冲区，恢复时一次性倒进来（方便盯住某一行看）。 */
  const setPausedSafe = useCallback(
    (value) => {
      pausedRef.current = value;
      setPaused(value);
      if (!value) {
        if (bufferRef.current.length) append(bufferRef.current);
        bufferRef.current = [];
        setPendingCount(0);
      }
    },
    [append]
  );

  /** 清空：后端和前端一起清，不然刷新页面旧日志又回来了。 */
  const clear = useCallback(async () => {
    setLogs([]);
    bufferRef.current = [];
    setPendingCount(0);
    lastIdRef.current = 0;
    try {
      await api("/api/logs", { method: "DELETE" });
    } catch {
      /* 后端没起来也让前端先清掉 */
    }
  }, []);

  return (
    <LogContext.Provider
      value={{
        logs,
        connected,
        paused,
        setPaused: setPausedSafe,
        pendingCount,
        clear,
      }}
    >
      {children}
    </LogContext.Provider>
  );
}

export function useLogs() {
  const ctx = useContext(LogContext);
  if (!ctx) throw new Error("useLogs 必须用在 <LogProvider> 内");
  return ctx;
}

export { api };