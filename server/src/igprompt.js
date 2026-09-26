/**
 * Instagram 那一轮的提示词。
 *
 * 角色去点赞 / 评论 / 回评论，用的**不是**聊天那一轮的提示词。聊天那轮
 * （prompt.js:buildPrompt）按预设的条目顺序拼，模型收到的任务是「回短信」；
 * 这一轮的任务是「在 Instagram 上说句话」，场景要压在最顶上，格式要压在最底下，
 * 中间那一摞人设 / 世界书 / 记忆 / 上文还是原来那些。
 *
 * 段落顺序是用户钉死的，**不跟预设的条目顺序走**：
 *
 *     <Instagram>   场景 + 帖子快照     ← 最顶上
 *     <Character>   角色人设
 *     <User>        用户人设
 *     <World_Info>  世界书
 *     <近期记忆>
 *     <过往回忆>    向量检索回来的
 *     <备忘录>
 *     <Chat_History> … </Chat_History>  当前所有上下文
 *     行动指令                           ← 最底下
 *
 * 顺序不跟预设走，但**开关跟预设走**：预设里把「世界书」关了的人，在这一轮
 * 也不该收到世界书。所以每一段都再看一眼 preset.entries 里对应条目的 enabled。
 *
 * **日记故意不注入**。用户列的是「近 N 天记忆 → 向量检索的记忆 → 备忘录」
 * 三样，没有日记。每条帖子每个角色都要跑一轮，多塞一段就是每轮多烧一笔钱，
 * 而日记对「该回一句什么」几乎不提供信息。真要加就是在 memoryParts 的返回里
 * 多接一个 diaryText、多 push 一条 wrap("日记", …)，一行的事。
 *
 * 这个文件是**纯的**：只 import config / igstore / preset / prompt / worldinfo，
 * 不认识 runner、不碰队列、不打模型 —— 上文当参数传进来，端点由调用方解析。
 * 和 proactive.js 一个路子，为的是能离线测（scripts/test-instagram.mjs）。
 */

import { applyVars, resolveUser } from "./config.js";
import { USER_OWNER, readSettings } from "./igstore.js";
import { resolvePreset } from "./preset.js";
import {
  HISTORY_CLOSE,
  HISTORY_OPEN,
  filterHistory,
  memoryParts,
  mergeAdjacent,
  trimHistory,
  weaveDepths,
  wrap,
} from "./prompt.js";
import { activate, worldBooksFor } from "./worldinfo.js";

/* ================= 场景 ================= */

/**
 * 这一轮是因为什么被叫起来的。队列任务里的 kind 就是这几个值之一，
 * 也正好是 settings.promptTemplates 里的键名 —— 一一对应，不用再映射一次。
 *
 * user* 是冲着用户来的（可以顺带发短信），char* 是冲着别的角色来的（只能评论）。
 */
export const IG_SCENES = ["userPost", "userStory", "userComment", "charPost", "charComment"];

/** 冲着别的角色的那几个场景：输出形态受限，用 peerAction 那条行动指令。 */
const PEER_SCENES = new Set(["charPost", "charComment"]);

/**
 * 提示词模板的代码默认值。
 *
 * settings.json 里存空串就回落到这里（见 igstore.js:defaultSettings），
 * 所以改这里等于给所有没自定义过的用户同步更新。
 *
 * 三条硬约束，每条都对应解析器里的一条规则（igtags.js）：
 *
 * 1. `[comment:…]` **只在这里教**。聊天那轮的预设（preset.js 的 instagram
 *    子条目）里一个字都没提它 —— 用户定的：评论不在预设里露面，只在角色被
 *    叫起来评论的这一刻才交代格式。
 * 2. 方括号**里面**不许出现 {{sep}}。分隔符在括号外是「分气泡」，在括号里会
 *    被 commaSeparators 换成英文逗号，模型以为自己在断句、实际在改标点。
 * 3. 这一轮**不发帖**。解析器认 [post:] / [story:]，但评论轮里冒出一条帖子
 *    是模型跑偏，不是功能。
 */
const DEFAULT_TEMPLATES = {
  userPost: "{{user}} 刚在 Instagram 上发了一条新帖子，你刷到了。",
  userStory: "{{user}} 刚发了一条快拍，你点开看了。",
  userComment: "{{user}} 在 Instagram 上给你留了言。",
  charPost: "{{对方}} 刚在 Instagram 上发了一条新帖子，你刷到了。",
  charComment: "{{对方}} 在 Instagram 上给你留了言。",

  action: [
    "现在轮到你了，三种做法挑一种：",
    "",
    "  1. 只在 Instagram 上留一句评论 —— 写成 [comment:要说的话]；",
    "  2. 只私下给 {{user}} 发消息 —— 照平时发短信那样写，不带任何方括号；",
    "  3. 两样都做 —— 先写 [comment:…]，换行之后再写要发的短信。",
    "",
    "几条硬规矩：",
    "  - 方括号**里面**不能出现 {{sep}}，要断句就用标点。",
    "  - [comment:…] 是发到 Instagram 上的，不会变成短信；方括号之外的文字才是短信，",
    "    要分成几条气泡就照旧用 {{sep}} 隔开。",
    "  - 这一轮只留评论，不发新的帖子和快拍。",
    "  - 评论按 {{char}} 平时打字的样子写：短、随口。别写读后感，别复述图里有什么，",
    "    别用任何旁白或动作描写。",
  ].join("\n"),

  peerAction: [
    "现在轮到你了：在这条下面留一句评论，写成 [comment:要说的话]。",
    "",
    "几条硬规矩：",
    "  - 方括号**里面**不能出现 {{sep}}，要断句就用标点。",
    "  - 这一轮**只能**留评论。不要发短信、不要发新的帖子或快拍 ——",
    "    方括号之外一个字都不要写。",
    "  - 评论按 {{char}} 平时打字的样子写：短、随口。别写读后感，别复述图里有什么，",
    "    别用任何旁白或动作描写。",
  ].join("\n"),

  compose: [
    "你现在想发点东西到自己的 Instagram 上。",
    "",
    "  - 发帖子：[post:配文]，紧接着写 [image:这张图里有什么] 说明配图。",
    "  - 发快拍：[story:配文]，同样紧接着写 [image:…]。配文可以留空：[story:]。",
    "  - 只写 [image:…]、前面什么标记都不带，就是发一条没有文字的快拍。",
    "",
    "几条硬规矩：",
    "  - 方括号**里面**不能出现 {{sep}}，要断句就用标点。",
    "  - 一次只发一条。配文按 {{char}} 平时打字的样子写，短，别写成文案。",
    "  - 这是发给所有人看的，不是发给 {{user}} 的私信。",
  ].join("\n"),
};

/** 某个模板的代码默认值（没这个键就返回空串）。 */
export function defaultTemplate(key) {
  return DEFAULT_TEMPLATES[key] ?? "";
}

/**
 * 八条模板的键名，也就是 settings.promptTemplates 里的全部字段。
 *
 * 前五条是场景（IG_SCENES），后三条是行动指令（action / peerAction / compose）。
 * 控制台照这个顺序排那八个输入框，所以这里的顺序有意义 —— 是 DEFAULT_TEMPLATES
 * 的字面量顺序，别改成排序后的。
 */
export const IG_PROMPT_KEYS = Object.keys(DEFAULT_TEMPLATES);

/* ================= 快照 ================= */

/**
 * 时间说成人话。模型对 ISO 时间戳没什么感觉，「3 小时前」才是它能用的信息
 * ——「刚发的」和「昨天发的」该留的评论不一样。
 */
function agoText(iso, now) {
  const at = Date.parse(iso ?? "");
  if (!Number.isFinite(at)) return "";
  const mins = Math.floor((now - at) / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/**
 * owner 换成能念出来的名字。
 *
 * IG 这边的 owner 是**角色名**本身（USER_OWNER 那条除外），所以角色的直接用；
 * 用户那条要换成当前生效的那条用户人设的名字 —— 模型认识的是那个名字。
 */
function ownerLabel(owner, vars) {
  if (owner === USER_OWNER) return String(vars?.user ?? "").trim() || "用户";
  return String(owner ?? "").trim();
}

/**
 * 图片那一行。
 *
 * 两个描述来源，优先级不一样：`visionNote` 是识图模型**看着真图**写的，
 * `alt` 只是当初生图时用的那句提示词（用户自己传的照片压根没有 alt）。
 * 有识图结果就以它为准，两个都摆上去只会让模型在两份描述之间来回找。
 */
function mediaText(images, visionNote) {
  const list = (Array.isArray(images) ? images : []).filter(Boolean);
  if (!list.length) return "";

  const note = String(visionNote ?? "").trim();
  const count = list.length > 1 ? `（${list.length} 张）` : "";
  if (note) return `图片${count}：${note}`;

  const alts = list.map((im) => String(im?.alt ?? "").trim());
  if (!alts.some(Boolean)) return `图片：${list.length} 张，没有描述`;
  if (list.length === 1) return `图片：${alts[0] || "（没有描述）"}`;
  return ["图片：", ...alts.map((a, i) => `  ${i + 1}. ${a || "（没有描述）"}`)].join("\n");
}

/**
 * 评论列表。
 *
 * 存的是**平铺**的，层级靠 replyTo 表达（igstore.js 的注释讲了为什么），
 * 所以这里渲染成「A 回复 B：…」而不是缩进树 —— 平铺一行一条，模型不会数错层，
 * 也省掉一层缩进的 token。
 *
 * `targetId` 是这一轮要回的那条，标出来；不标的话模型会挑列表里最后一条回，
 * 而队列任务指的未必是最后一条（30–120 分钟的窗口里可能又来了别的评论）。
 */
function commentText(list, vars, selfOwner, targetId, noun) {
  const all = (Array.isArray(list) ? list : []).filter(Boolean);
  if (!all.length) return `这条${noun}还没有人评论。`;

  const byId = new Map(all.map((c) => [c.id, c]));
  const rows = all.map((c, i) => {
    const who = ownerLabel(c.owner, vars) + (c.owner === selfOwner ? "（你）" : "");
    const to = c.replyTo ? byId.get(c.replyTo) : null;
    const head = to ? `${who} 回复 ${ownerLabel(to.owner, vars)}` : who;
    const mark = targetId && c.id === targetId ? "   ← 你要回的就是这条" : "";
    return `  ${i + 1}. ${head}：${String(c.text ?? "").trim()}${mark}`;
  });
  return [`已有的评论（按时间正序）：`, ...rows].join("\n");
}

/**
 * 帖子 / 快拍的快照：这一轮模型要看着说话的那个东西。
 *
 * 这段是**程序生成**的，不做成模板 —— 它是数据不是文案。用户能改的是上面
 * 那句场景交代（promptTemplates），不是数据怎么摆。
 */
export function snapshot(scene, vars, selfOwner, now) {
  const story = scene?.story ?? null;
  const post = scene?.post ?? null;
  const item = story ?? post;
  if (!item) return "";

  const noun = story ? "快拍" : "帖子";
  const images = story ? (story.image ? [story.image] : []) : item.images;
  const comments = story ? story.replies : item.comments;

  const ago = agoText(item.createdAt, now);
  // 自己的帖子说「你的」——「林一的帖子」+「林一（你）：凑合」两种说法混在
  // 一段里，模型要多绕一道才知道这是它自己的东西
  const whose = item.owner === selfOwner ? "你" : ownerLabel(item.owner, vars);
  const lines = [`—— ${whose}的${noun}${ago ? `（${ago}）` : ""} ——`];

  const caption = String(item.caption ?? "").trim();
  lines.push(caption ? `配文：${caption}` : "配文：（没写字）");

  const media = mediaText(images, item.visionNote);
  if (media) lines.push(media);

  const likes = (Array.isArray(item.likes) ? item.likes : []).filter(Boolean);
  if (likes.length) {
    lines.push(`点赞：${likes.length} 个${likes.includes(selfOwner) ? "，你已经赞过了" : ""}`);
  }

  /*
   * 被点名了就说一句。
   *
   * 判断在调用方（igrun.js:mentionsRole 查的是「配文里那个 @ 对得上这个角色
   * 绑的真 IG 用户名」），这里只负责让模型知道。不说的话模型看到的就是一条
   * 普通帖子，会随口评一句 —— 而配文里那句「@它」明明是冲着它来的，读起来
   * 就成了没接上话。
   *
   * 不写「你必须回」：该不该热情、回什么，是人设的事。
   */
  if (scene?.mentioned) lines.push(`${whose}在配文里 @ 了你，是点名叫你的。`);

  lines.push(commentText(comments, vars, selfOwner, scene?.commentId, noun));

  // 已经说过话了还被叫起来，是允许的（对方回了你就该再接一句），但模型得知道
  const mine = (Array.isArray(comments) ? comments : []).filter((c) => c?.owner === selfOwner);
  if (mine.length) lines.push(`你在这条下面已经说过 ${mine.length} 句了。`);

  return lines.join("\n");
}

/**
 * 场景块：<Instagram> 里面那一坨。上面一句人话交代发生了什么，下面是快照。
 *
 * `{{对方}}` 不走 applyVars，只在这一段里 replace —— 和 formatBlock 里的
 * `{{图生图变量}}` 一个理由：它只在这一段有意义，进了 applyVars 就成了全局变量，
 * 人设里写一个也会被换掉。
 */
export function sceneBlock(scene, vars, selfOwner, now, templates) {
  const kind = scene?.kind ?? "";
  const custom = String(templates?.[kind] ?? "").trim();
  const raw = custom || defaultTemplate(kind);

  const peer = String(scene?.peerName ?? "").trim() || ownerLabel(scene?.owner, vars);
  const head = applyVars(raw, vars)
    .replace(/\{\{\s*对方\s*\}\}/g, peer)
    .trim();

  return [head, snapshot(scene, vars, selfOwner, now)].filter(Boolean).join("\n\n");
}

/* ================= 拼提示词 ================= */

/**
 * 拼出 Instagram 那一轮要发的 messages。
 *
 * 只负责拼，不打模型 —— 端点由调用方按 role.chatModel 解析（和 buildPrompt
 * 一样的分工）。params 从预设里带出来：这一轮说的话也是这个角色说的，
 * temperature 之类的不该和聊天那轮不一样。
 *
 * @param {object} config 完整配置
 * @param {object} role 要说话的那个角色
 * @param {object} scene {kind, owner, post?, story?, commentId?, peerName?, mentioned?}
 * @param {object} [opts] {user?, history?, now?, templates?, tag?, block?, action?}
 *   tag / block / action 是给小红书那一轮借壳用的（xhsrun.js）：同一套人设 /
 *   世界书 / 记忆 / 上文的结构，只换最顶上的场景块和最底下的行动指令。
 *   不传就是 Instagram 原样。
 * @returns {Promise<{messages:{role:string,content:string}[], params:object,
 *                    preset:object, vars:object, worldInfo:object}>}
 */
export async function buildIgPrompt(config, role, scene, opts = {}) {
  const preset = resolvePreset(config, role);
  const user = opts.user ?? resolveUser(config, role);
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const templates = opts.templates ?? readSettings().promptTemplates;

  const vars = {
    char: role?.name ?? "",
    user: user?.name ?? "",
    sep: config?.chat?.separator ?? "",
  };
  const fill = (text) => applyVars(text, vars).trim();

  // IG 这边角色的 owner 就是它的名字（instagram.js:igOwners 定的）
  const selfOwner = role?.name ?? "";

  // 发给模型的那份上文。这一轮没有天气 —— 天气是「对方发消息进来」那一刻
  // 掺进最后一条 user 消息里的（env.js），评论轮不是由消息触发的，没有那条消息
  const hist = trimHistory(opts.history, role);
  const sent = filterHistory(hist, preset.regex, { char: vars.char, user: vars.user });

  const block =
    typeof opts.block === "string"
      ? applyVars(opts.block, vars).trim()
      : sceneBlock(scene, vars, selfOwner, now, templates);

  // 预设里关掉的条目，这一轮也不产出
  const entryOn = (kind) => preset.entries.find((e) => e.kind === kind)?.enabled !== false;

  // 世界书扫描文本 = 上文 + 场景块。帖子配文里的关键词也该能触发条目 ——
  // 模型看得到的内容都该参与触发，和 buildPrompt 里天气的道理一样
  let world = { before: "", after: "", depths: new Map(), hitNames: [] };
  let books = [];
  if (entryOn("world")) {
    books = worldBooksFor(config, role);
    if (books.length) world = activate(books, [...sent, { role: "user", content: block }]);
  }

  const mem = entryOn("memory")
    ? await memoryParts(role, config, sent)
    : { recentText: "", recalledText: "", memoText: "" };

  const parts = [];

  // 1. 场景压在最顶上
  parts.push({ role: "system", content: wrap(opts.tag || "Instagram", block) });

  // 2. 人设
  if (entryOn("char")) {
    parts.push({ role: "system", content: wrap("Character", fill(role?.description)) });
  }
  if (entryOn("user")) {
    parts.push({ role: "system", content: wrap("User", fill(user?.description)) });
  }

  // 3. 世界书
  if (entryOn("world")) {
    parts.push({
      role: "system",
      content: wrap("World_Info", [world.before, world.after].filter(Boolean).join("\n")),
    });
  }

  // 4. 记忆三件套。标签名和预设里那条记忆条目的默认正文一致
  //    （preset.js:DEFAULT_MEMORY_ENTRY），模型两轮看到的结构是同一套
  parts.push({ role: "system", content: wrap("近期记忆", mem.recentText) });
  parts.push({ role: "system", content: wrap("过往回忆", mem.recalledText) });
  parts.push({ role: "system", content: wrap("备忘录", mem.memoText) });

  // 5. 当前上下文
  if (entryOn("context")) {
    const woven = weaveDepths(sent, world.depths);
    if (woven.length) {
      parts.push({ role: "system", content: HISTORY_OPEN });
      parts.push(...woven);
      parts.push({ role: "system", content: HISTORY_CLOSE });
    }
  }

  /*
   * 6. 行动指令压在最底下。
   *
   * 默认用 system 而不是 user —— 这不是谁说的话，而且 system 能和上面那条
   * `</Chat_History>` 合并掉，省一条消息。
   *
   * ── 但「最后一条不是 system 的消息」得是 user，不然必然 400 ──
   *
   * Gemini 系的上游把 system 提走当 systemInstruction，剩下的才是它眼里的
   * contents。所以判据不是「数组里有没有 user」，是**跳过末尾的 system 之后，
   * 最后那条是谁说的**。两种情况都会炸，而且都是 IG 这一轮的常态：
   *
   *   a. 上文为空 → 所有条目都是 system，mergeAdjacent 合成一条，contents 空了，
   *      上游回 400 `contents is not specified`。runIgTask 里那句「现在没有可用的
   *      会话，这一轮照跑，但上文是空的」写的就是它：进程刚重启、对方还没说过话
   *      的时候，IG 那一轮照样会被队列叫起来。
   *   b. 上文以角色的话结尾（**从存档恢复的上文十有八九如此**）→ contents 的最后
   *      一条是 assistant，上游回 400
   *      `Requests ending with a model turn are not supported.`
   *
   * b 那条以前漏了：`parts.some(p => p.role === "user")` 只要上文里有过一句用户的
   * 话就判「有 user」，于是行动指令挂 system，末尾成了 `assistant, system` ——
   * 我们这边看着不以 assistant 结尾，上游眼里正是。结果每条互动任务都吃一个
   * 400、出队即丢，整个 Instagram 分区只剩「掷中 likeChance 直接点赞」那条不打
   * 模型的路还活着。
   *
   * 挑这一条来换，是因为它语义上最接近 user（「现在轮到你了」本来就是冲着
   * 模型说的一句指令），而且它已经在最底下，换个 role 不动任何顺序。
   * **只在真的需要时才换** —— 上文正好以用户那句话结尾的话一个字不变，
   * 免得白改了模型看惯的那个形状。
   *
   * llm.js:moveModelTail 那边也补了同一条口径（跳过尾部 system 再找 assistant），
   * 两层都有：这里从源头不产出这种形状，那里给所有链路兜底。
   */
  const actionKey = PEER_SCENES.has(scene?.kind) ? "peerAction" : "action";
  const action =
    typeof opts.action === "string"
      ? opts.action
      : String(templates?.[actionKey] ?? "").trim() || defaultTemplate(actionKey);
  const lastTurn = parts.filter((p) => p.role !== "system" && String(p.content ?? "").trim()).at(-1);
  parts.push({
    role: lastTurn?.role === "user" ? "system" : "user",
    content: applyVars(action, vars).trim(),
  });

  return {
    messages: mergeAdjacent(parts),
    params: preset.params,
    preset,
    vars,
    worldInfo: { hitNames: world.hitNames, bookCount: books.length },
  };
}
