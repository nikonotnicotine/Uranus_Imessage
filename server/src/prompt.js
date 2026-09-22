/**
 * 提示词组装。
 *
 * 以前这段是 imessage.js 里的 buildMessages()：一段写死的 system + 上文，
 * 顺序不能改、条目不能关。现在按预设的 entries 顺序拼，世界书在这里注入。
 *
 * 搬出来单独一个文件是因为 imessage.js 已经 700 行了，而这部分逻辑
 * （条目顺序、世界书插入位置、相邻消息合并）自己就有相当的分量，
 * 也方便离线单测。
 *
 * 每类内容用一对 XML 标签包起来（<Character> / <User> / <World_Info> /
 * <消息格式与功能> / <Chat_History>），模型一眼能看出哪句是人设、哪句是
 * 世界设定。标签名写死在这里，界面上不给改 —— 用户能改的是内容，不是结构。
 *
 * 人设是**原文直接注入**的，不再加「你是「X」。」「人设：」那种程序拼的前缀 ——
 * 那些前缀表达的边界信息现在由标签承担，每轮还白占 token。副作用是角色名
 * 不再自动出现在提示词里，要的话在人设正文里写 {{char}}。
 *
 * 这里也是**过滤发给模型的上文**的地方：正则里勾了 toHistory 的规则在拼装时
 * 才跑，存档和内存历史留的是模型原文。所以 <thinking> 在「上下文」面板里
 * 看得到，发给模型的那份里没有。
 *
 * 同理，天气段也是在这里才掺进最后一条 user 消息的（injectWeather）——
 * 天气是瞬时值，进存档就等于在后面每一轮里重发一遍过期数据。时间不一样，
 * 它跟着消息进存档，见 env.js 的文件头。
 */

import { applyVars, resolveEndpoint } from "./config.js";
import { listEmojiTags } from "./emoji.js";
import { embedText } from "./llm.js";
import { logWarn } from "./logs.js";
import { EFFECT_LABELS, SCREEN_EFFECT_KEYS } from "./media.js";
import {
  cosineDistance,
  dedupeAgainst,
  filterRecent,
  formatMemoryLines,
  formatRecentLines,
  rankCandidates,
  selectForInjection,
  semanticScore,
  truncate,
} from "./memory.js";
import {
  memoryKeyFor,
  readMemo,
  readMemories,
  readRecentDiaries,
} from "./memorystore.js";
import {
  FORMAT_CHILD_TAGS,
  ROLE_GATED_CHILDREN,
  SPY_CHILD_KINDS,
  formatChildLead,
  resolvePreset,
} from "./preset.js";
import { applyRules } from "./regex.js";
// 只为了线下模式的「线上聊天记录」条目 —— 线上存档是那批消息唯一的来源
import { listSessions, recentMessages } from "./sessions.js";
import { spyLegs, trimSpyPrompt } from "./spy.js";
import { activate, worldBooksFor } from "./worldinfo.js";

/** 上下文那段前后的标记。两条极短的 system，夹住真正的多轮消息。 */
export const HISTORY_OPEN = "<Chat_History>";
export const HISTORY_CLOSE = "</Chat_History>";

/**
 * 上下文裁剪：超了就丢最旧的几条。
 *
 * 原样搬自 buildMessages —— 内存里只留这么多，磁盘上的完整存档另算。
 * 发给模型的越少越省 token，小 VPS 上同时挂几个号码也不会被历史撑爆。
 *
 * @returns 裁剪后的数组（可能就是原数组本身，没超上限时不复制）
 */
export function trimHistory(history, role) {
  const maxContext = role?.maxContext ?? 20;
  const dropCount = role?.dropCount ?? 1;
  let hist = Array.isArray(history) ? history : [];
  while (hist.length > maxContext) {
    hist = hist.slice(dropCount);
  }
  return hist;
}

/**
 * 用一对标签把一段内容包起来。
 *
 * 正文空就返回空串 —— 空条目照旧不占一条消息（见 mergeAdjacent），
 * 不会发出去一个 <Character></Character> 的空壳。
 *
 * export 出去是给 memory.js 用的：三条总结链（记忆 / 备忘录 / 日记）的每一段
 * 也要 XML 包裹（用户的规范钉死的），包法必须和这里一模一样。
 */
export function wrap(tag, body) {
  const text = String(body ?? "").trim();
  return text ? `<${tag}>\n${text}\n</${tag}>` : "";
}

/**
 * 图生图的参考图清单，展开成一段能直接给模型看的说明。
 *
 * 图片这条子条目的正文里有一个 `{{图生图变量}}` 占位符（用户可以把它挪到
 * 别处、也可以删掉）。这里按角色勾选的那几张图把它换成一段清单。
 *
 * 和 {{char}} 那些不一样，它不走 applyVars —— 那边是「名字替换」，
 * 一个词换一个词；这里要塞进去的是好几行结构化文本，而且**只有图片这一条
 * 子条目认识它**（放进 applyVars 就等于全局变量，人设里写一个也会展开，
 * 那没有意义）。
 *
 * 三个条件缺一不可：角色开了图生图、勾了至少一张、图库里确实有这条。
 * 不满足就换成空串 —— 说明一堆参考图然后一张都不给用，只会让模型乱写。
 */
function img2imgList(config, role) {
  const gen = role?.imageGen;
  if (!gen?.enabled || !gen?.img2img) return "";
  const refs = Array.isArray(gen.refs) ? gen.refs : [];
  if (!refs.length) return "";

  const gallery = Array.isArray(config?.referenceImages) ? config.referenceImages : [];
  const lines = [];
  const names = [];
  for (const name of refs) {
    const hit = gallery.find((r) => r.name === name);
    if (!hit?.name) continue;
    names.push(hit.name);
    lines.push(`- [${hit.name}]：${hit.description || "（没有写描述）"}`);
  }
  // 勾了几张但图库里一条都对不上（改过名 / 删过条目）—— 当成没开
  if (!lines.length) return "";

  // 示例里用第一张**真的对得上**的图，不能用 refs[0]（那条可能已经失效了）
  const sample = names[0];
  return [
    "图生图变量说明：",
    "系统内目前存有以下参考图，当你需要基于以下图片生成时，请务必在生成指令后加上对应的 [参考图名字]。",
    "清单：",
    ...lines,
    `图生图格式示例（假设调用上面的 ${sample}）：` +
      `[image:一只胖胖的橘猫，脖子戴着红项圈，正趴在阳光明媚的窗台上睡觉。][${sample}]`,
  ].join("\n");
}

/**
 * 这个角色能用的表情包标签，展开成一行 `早安、紧张、开心`。
 *
 * 表情包这条子条目的正文里有一个 `{{表情包变量}}` 占位符（用户给的规范里
 * 写的是 `{{变量}}`，两种都认，见 formatBlock）。硬盘上的标签**默认全都注入**，
 * 两道过滤：
 *
 *   1. **文件夹里真有图**（emoji.js:listEmojiTags 的 count）—— 空文件夹注入了
 *      也只会让模型发一个发不出去的标记。
 *   2. **不在这个角色的黑名单里**（role.stickerSend.blacklist）—— 用户原话是
 *      「黑名单不会给 LLM 注入相关表情包标签，LLM 也则不会知道有这个表情包」。
 *
 * 以前这儿还有一道「图库里勾了的」（config.emojiTags），用户后来说
 * 「允许注入给模型和黑名单不会有点重复了吗……就留下黑名单吧」—— 确实是同一件事
 * 说两遍，勾选那道已经整个删掉了。
 *
 * 顺序跟着文件夹走（listEmojiTags 按标签名排过），不重排。
 *
 * 和 img2imgList 一样不走 applyVars：那边是「一个词换一个词」的全局替换，
 * 这个只有表情包这一条子条目认识。
 */
function stickerTagsFor(role) {
  const send = role?.stickerSend;
  if (!send?.enabled) return [];

  const banned = new Set(Array.isArray(send.blacklist) ? send.blacklist : []);
  // 硬盘上真有图的标签（listEmojiTags 读不到目录时返回空数组，那就一条都不注入）
  return listEmojiTags()
    .filter((t) => t.count > 0)
    .map((t) => t.tag)
    .filter((tag) => !banned.has(tag));
}

/**
 * 角色勾中的特效 key → 提示词里那一行清单。
 *
 * 写成 `heart 爱心（屏幕）、loud 大声（气泡）` 这种三段式，三样信息缺一不可：
 * 英文 key 是模型真正要写进标记里的东西；中文名让模型知道这个特效是什么意思
 * （`slam`、`echo` 光看英文猜不出来）；屏幕/气泡的区别决定了该不该省着用 ——
 * 屏幕特效会占满对方一整块屏幕。
 *
 * 顺序跟着角色勾的顺序走，不重排 —— 界面上是按屏幕/气泡分栏点的，
 * 点出来的顺序本身就大致有序。
 */
function effectListText(keys) {
  return keys
    .map((key) => {
      const label = EFFECT_LABELS[key];
      if (!label) return "";
      return `${key} ${label}（${SCREEN_EFFECT_KEYS.includes(key) ? "屏幕" : "气泡"}）`;
    })
    .filter(Boolean)
    .join("、");
}

/**
 * 「消息格式与功能」：一段引言 + 十三个各自带标签的子条目。
 *
 * 子条目全关就只剩引言，引言也空就整个条目不产出。真有子条目要注入时，
 * 在它们前面补一句程序生成的领起话（formatChildLead）—— 那句话以前
 * 写在引言里，但那十七条可以一条都不开，留在引言里会变成没有下文的空话。
 * 领起话要按这一轮真注入了哪几条挑措辞：引用、撤回和特效的标记是写在文字
 * **里**的，和「每个标记单独占一条气泡」直接冲突。
 *
 * **角色那道闸**：ROLE_GATED_CHILDREN 里的子条目（除引用回复之外的每一条）
 * 还要看角色上对应的开关，关着时这一条无论开没开都不注入。理由是这几件事都有
 * 外溢代价（往外发请求要花钱 / 干脆不回消息 / 把你硬盘上的图发出去 /
 * 真的从对方手机上收回消息），该由用哪个角色来决定，而不是由「所有角色共用的
 * 预设」决定。回应和特效那两条压的不是代价是**白名单**（见 preset.js），
 * Instagram 那条压的是**这个角色有没有这个账号**，但走的都是同一道闸。
 * 引用回复什么都不压，所以它是自带的，没有角色开关。
 *
 * 注意这里只管子条目 —— 条目本身关着的话 buildPrompt 压根不会走到这儿，
 * 那种情况下这几条也都不注入（两道闸之外还有这一道，都是「关了就没有」）。
 *
 * **查岗是唯一的特例**：它在角色上是两个开关（电脑腿 / 手机腿），所以不在
 * ROLE_GATED_CHILDREN 里，由下面 spyText 单独处理 —— 两条腿都关就整条跳过，
 * 只开一条腿时还要把另一条腿那几行删掉（见那个函数的注释）。
 */
function formatBlock(entry, fill, role, config) {
  const lines = [];
  const intro = fill(entry?.content ?? "");
  if (intro) lines.push(intro);

  const marks = [];
  const kinds = [];
  for (const child of Array.isArray(entry?.children) ? entry.children : []) {
    if (!child?.enabled) continue;
    const gate = ROLE_GATED_CHILDREN[child.kind];
    if (gate && !role?.[gate]?.enabled) continue;
    const tag = FORMAT_CHILD_TAGS[child.kind];
    let text = fill(child.content ?? "");
    // 图片这条正文里的 {{图生图变量}}：换成角色勾中的参考图清单，
    // 没开图生图或一张都没勾时换成空串（顺手收掉留下的空行）
    if (child.kind === "image") {
      text = text.replace(/\{\{\s*图生图变量\s*\}\}/g, img2imgList(config, role));
      text = text.replace(/\n{3,}/g, "\n\n").trim();
    }
    // 表情包这条正文里的 {{表情包变量}}：换成这个角色能用的标签清单。
    // 一个都不剩时**整条跳过** —— 图片那条换成空串还剩下有用的文生图说明，
    // 表情包这条剩下的是「你必须从【表情包列表】中选择」+ 一个空清单，
    // 那等于告诉模型「有这个功能但没东西可选」，只会诱它自己编一个标签。
    // 用户写的规范里占位符是 {{变量}}，为了和 {{图生图变量}} 对称改成了
    // {{表情包变量}}，两种都认 —— 用户把规范原文粘回编辑框也能用。
    if (child.kind === "sticker") {
      const tags = stickerTagsFor(role);
      if (!tags.length) continue;
      text = text.replace(/\{\{\s*(?:表情包变量|变量)\s*\}\}/g, tags.join("、"));
    }
    // 回应 / 特效这两条也是白名单制，和表情包同一个道理：一个都没勾就**整条跳过**。
    // 这正是用户要的省 token —— 苹果自带的 emoji 几百个，全塞进去每轮都在白烧。
    // 空清单留着比不留更糟：模型会看见「你必须从【可用emoji】里选」后面跟一片空白，
    // 然后自己编一个。
    if (child.kind === "react") {
      const list = Array.isArray(role?.reactSend?.emojis) ? role.reactSend.emojis : [];
      if (!list.length) continue;
      text = text.replace(/\{\{\s*emoji变量\s*\}\}/g, list.join(" "));
    }
    if (child.kind === "effect") {
      const list = Array.isArray(role?.effectSend?.effects) ? role.effectSend.effects : [];
      if (!list.length) continue;
      text = text.replace(/\{\{\s*特效变量\s*\}\}/g, effectListText(list));
    }
    /*
     * 查岗那**四条**都不在 ROLE_GATED_CHILDREN 里 —— 角色上是五个开关加十九个
     * 单项，没有单个 .enabled 可查。哪条腿都没开 → 整条跳过（trimSpyPrompt 返回
     * 空串）；开了几样 → 关掉那几样的行删掉，别教模型写一个注定被拒的标签。
     *
     * `kind` 要传进去：四条各自只讲自己那一段（屏幕 / 查看 / 控制 / 网易云），
     * 裁剪和末尾补充那句也只能按自己管的腿判。不传的话 spyMusic 那条会跟着
     * 屏幕的开关走，补出一句和它正文无关的话（见 spy.js:KIND_LEGS）。
     *
     * 预设歌单要一路传进去：`[操控手机:预设歌单 睡前]` 那一项的清单是用户在
     * 全局配置里填的，写不死在正文里（见 spy.js:featureList）。
     */
    if (SPY_CHILD_KINDS.includes(child.kind)) {
      text = trimSpyPrompt(text, spyLegs(role), {
        playlists: config?.spyApi?.playlists,
        kind: child.kind,
      });
      if (!text) continue;
    }
    if (!tag || !text) continue;
    marks.push(`<${tag}>${text}</${tag}>`);
    kinds.push(child.kind);
  }
  // 领起的那句话按这轮真注入了哪几条来挑：引用/撤回是写在文字里的，
  // 和「每个标记单独占一条气泡」直接冲突（见 preset.js:formatChildLead）
  if (marks.length) lines.push(formatChildLead(kinds), ...marks);

  return wrap("消息格式与功能", lines.join("\n"));
}

/**
 * 记忆库那四份文本，各压一道角色开关（role.memories），关着的给空串。
 *
 * 从 memoryBlock 里抽出来**只是为了共用**：Instagram 那一轮（igprompt.js）
 * 也要注入记忆，但它按用户指定的顺序自己拼，不走预设里那条记忆条目的正文。
 * 抽之前两边就得各写一遍下面这套开关 + 失败降级，早晚会走岔。
 *
 * **这个函数是 buildPrompt 里唯一打网络的地方**（`{{回忆起来的记忆}}` 要算
 * 一次向量）。它在每轮消息的关键路径上，所以检索那一路整个包在 try 里：
 * 打不通、超时、没配向量模型，都退化成「只注入近 N 天记忆」记一条 warn 继续走。
 * 让这轮回复因为一次检索失败发不出去，比少注入几条旧记忆糟得多。
 *
 * @param {object} role 当前角色
 * @param {object} config 完整配置
 * @param {{role:string, content:string}[]} sent 这一轮发给模型的上文，
 *        用最后一条 user 消息当检索的查询词
 * @returns {Promise<{recentText:string, recalledText:string, memoText:string, diaryText:string}>}
 */
export async function memoryParts(role, config, sent) {
  const key = memoryKeyFor(role);
  const gates = role?.memories ?? {};
  const settings = config?.memories ?? {};

  let recentText = "";
  let recalledText = "";
  let memoText = "";
  let diaryText = "";

  if (gates.memory?.enabled) {
    const all = readMemories(key);
    const now = Date.now();

    // 第一路：近 N 天，纯按日期捞，不走向量 —— 向量没配也有这一路
    const inject = settings.memory?.recentInject ?? {};
    const recent = inject.enabled ? filterRecent(all, inject.days ?? 3, now) : [];
    recentText = formatRecentLines(recent);

    // 第二路：语义检索。整段包在 try 里，失败就只剩上面那一路
    try {
      const recalled = await recallMemories(all, recent, role, config, sent, now);
      recalledText = formatMemoryLines(recalled);
    } catch (e) {
      logWarn("记忆库", `语义检索失败，这轮只注入近期记忆：${e.message}`);
    }
  }

  if (gates.memo?.enabled) memoText = readMemo(key);

  if (gates.diary?.enabled) {
    // 角色自己的「注入近 N 天日记」，默认 3 天；0 = 生成但不回注
    const days = gates.diary.injectDays ?? 3;
    diaryText = readRecentDiaries(key, days)
      .map((d) => `【${d.date}】\n${d.text.trim()}`)
      .join("\n\n");
  }

  return { recentText, recalledText, memoText, diaryText };
}

/**
 * 「记忆库」条目：把四个变量换成真内容。
 *
 * 四个都空时整条条目不产出 —— 一段只剩空标签的文字每轮都在白占 token。
 *
 * 和 formatBlock 里的 `{{图生图变量}}` 一个路子：不走 applyVars，
 * 只在这一条条目里 replace。理由见 preset.js:DEFAULT_MEMORY_ENTRY。
 *
 * @param {object} entry 记忆库条目（正文里有四个变量）
 * @param {object} role 当前角色
 * @param {object} config 完整配置
 * @param {{role:string, content:string}[]} sent 这一轮发给模型的上文
 */
async function memoryBlock(entry, role, config, sent) {
  const { recentText, recalledText, memoText, diaryText } = await memoryParts(role, config, sent);

  if (!recentText && !recalledText && !memoText && !diaryText) return "";

  // 四个变量各自的正则和值。先删空的那几段，再统一替换
  const vars = [
    [/\{\{\s*近N天记忆\s*\}\}/gi, recentText],
    [/\{\{\s*回忆起来的记忆\s*\}\}/gi, recalledText],
    [/\{\{\s*备忘录\s*\}\}/g, memoText],
    [/\{\{\s*近N天日记\s*\}\}/gi, diaryText],
  ];

  let text = String(entry?.content ?? "");
  text = dropEmptyBlocks(text, vars);
  for (const [re, value] of vars) text = text.replace(re, value);

  // 用户自己写的空标签（正文里压根没有变量的那种）也整对去掉
  text = text.replace(/<([^>\s/]+)>\s*<\/\1>/g, "");
  text = text.replace(/\n{3,}/g, "\n\n").trim();

  return wrap("记忆库", text);
}

/**
 * 值为空的变量，连**外面那对 XML 标签一起删**（标签之间的说明文字也一起没）。
 *
 * 以前这里是替换完之后去掉整对空标签（`<近期记忆>\n\n</近期记忆>`），只认
 * 开闭标签**紧挨着**的情况。默认正文改成用户给的格式之后这条不够用了：
 * `<过往回忆>` 里除了变量还有两句提示词，一条记忆都没检索到时那对标签里
 * 会剩下「以下是你脑海中回想起的过往记忆：」和「请在接下来的对话中，把这些
 * 记忆当作你已经历过的事实…」—— 中间什么都没有。模型被要求自然融入一批
 * 不存在的记忆，只能自己编，正好撞上「绝对禁止虚构互动记录」那条。
 *
 * 所以判断挪到替换**之前**：这一段里的变量是空的，整段就不要了。
 * 变量非空的段一个字不动，用户在标签里写的说明照旧留着。
 */
function dropEmptyBlocks(text, vars) {
  const empty = vars.filter(([, value]) => !value).map(([re]) => re);
  if (!empty.length) return text;

  // 非贪婪匹配到最近的同名闭标签；用 search 而不是 test，
  // 因为那几个正则带 g 标志，test 会带着 lastIndex 走
  return text.replace(/<([^>\s/]+)>([\s\S]*?)<\/\1>/g, (whole, _tag, body) =>
    empty.some((re) => body.search(re) !== -1) ? "" : whole
  );
}

/**
 * 语义检索那一路：算查询向量 → 逐条比余弦 → 混合打分 → 按预算挑几条。
 *
 * 拆出来是因为它整个包在调用方的 try 里，而这里面有五处可以「直接返回空」
 * 的前置检查（没开检索、没配向量模型、没有存了向量的记忆、抽不出查询词），
 * 混在 memoryBlock 里会让那边的主干读不出来。
 *
 * 只比**存了向量的**那些记忆。没存向量的（生成时向量接口正好挂了，或者
 * 用户手改过正文）不参与语义比对，但它们仍然走近 N 天那一路 —— 所以
 * 「向量算失败过」不等于「这条记忆丢了」。
 */
async function recallMemories(all, recent, role, config, sent, now) {
  const cfg = config?.memories?.memory ?? {};
  const ref = cfg.embedModel;
  if (!ref?.provider || !ref?.modelId) return [];

  // 拿最后一条 user 消息当查询词 —— 检索要回答的是「和对方刚说的这句话有关的」
  const lastUser = [...(sent ?? [])].reverse().find((m) => m.role === "user");
  const query = truncate(lastUser?.content ?? "", cfg.maxInputChars ?? 4000);
  if (!query) return [];

  const withVec = all.filter((m) => Array.isArray(m.embedding) && m.embedding.length);
  if (!withVec.length) return [];

  const endpoint = resolveEndpoint(config, ref);
  if (!endpoint) throw new Error("向量模型引用失效了（服务商或模型被删/被关）");

  const qv = await embedText(endpoint, query);
  const scored = withVec.map((m) => ({
    ...m,
    score: semanticScore(cosineDistance(qv, m.embedding)),
  }));

  const ranked = rankCandidates(scored, query, {
    threshold: cfg.threshold ?? 0.35,
    timeDecay: cfg.timeDecay !== false,
    decay: cfg.decay ?? 0.01,
    now,
  });

  // 近 N 天那一路已经注入过的先剔掉，再按 top-K 和字符预算挑 ——
  // 顺序不能反，否则名额会被已经注入过的那几条占掉
  return selectForInjection(dedupeAgainst(ranked, recent), {
    topK: cfg.topK ?? 5,
    maxChars: cfg.maxInjectChars ?? 6000,
    now,
  });
}

/**
 * 把 depth 类世界书条目插进上文。
 *
 * depth = 1 表示「紧贴最后一条上文之前」，也就是对方刚发的那句话前面；
 * depth 比上文条数还大时插到最前面。
 *
 * 这些条目**不包标签** —— 它们是散在 <Chat_History> 内部的独立消息，
 * 各自包一层反而把多轮结构切碎了。
 *
 * 导出是给 igprompt.js 用的：Instagram 那一轮也要注入上文，depth 条目
 * 在那一轮凭空消失会很难查。
 */
export function weaveDepths(hist, depths) {
  // 上文原样带过去，不动内容也不参与合并（raw: true，见 mergeAdjacent）
  const out = hist.map((m) => ({ role: m.role, content: m.content, raw: true }));
  if (!depths?.size) return out;

  // 从深的往浅的插，这样先插入的不会挪动后面那些的目标下标
  const sorted = [...depths.values()].sort((a, b) => b.depth - a.depth);
  for (const item of sorted) {
    if (!item.content.trim()) continue;
    const at = Math.max(0, out.length - item.depth);
    out.splice(at, 0, { role: item.role, content: item.content });
  }
  return out;
}

/**
 * 相邻的同 role 提示词条目合并成一条。
 *
 * 多个 system 条目分散在各处时不至于给上游发一串碎 system。合并用空行分隔，
 * 各自的 XML 标签仍然把边界划得清清楚楚。
 *
 * 另外两条不能碰的规则：
 *
 * 1. **上文消息（raw）不参与合并。** 历史里是会出现连续两条 user 的 ——
 *    主副 API 都挂掉那轮的 user 消息会留在历史里（imessage.js 的 catch），
 *    下一轮再 push 一条就连上了。合并会改变行为。
 * 2. **上文消息的内容一个字符都不改**，不 trim —— 存档里带尾随换行的
 *    消息得原样发出去。
 *
 * 顺带一个想要的效果：<Chat_History> 开标记是非 raw 的 system，会和它前面
 * 那条 system 合并掉（省一条消息）；闭标记前面是 raw 的历史消息，合不了，
 * 单独成一条。正好是「上文被夹在中间」的形状。
 */
export function mergeAdjacent(messages) {
  const out = [];
  for (const msg of messages) {
    const text = String(msg.content ?? "");
    if (!text.trim()) continue; // 空条目不占一条消息
    const content = msg.raw ? text : text.trim();
    const last = out[out.length - 1];
    if (last && !last.raw && !msg.raw && last.role === msg.role) {
      last.content += `\n\n${content}`;
    } else {
      out.push({ role: msg.role, content, raw: Boolean(msg.raw) });
    }
  }
  // raw 只是组装时的内部标记，别发给上游
  return out.map(({ role, content }) => ({ role, content }));
}

/**
 * 过滤发给模型的上文。
 *
 * 存档和内存历史里存的是模型原文（含 <thinking>），勾了 toHistory 的规则
 * 到这里才跑。两条喂给模型的路径（热的内存历史、冷启动从存档回填的那份）
 * 都经过这一个点，不会出现「热的滤了冷的没滤」。
 *
 * 正则只过 assistant —— 对方发来的话在 imessage.js 落盘前就跑过 userInput 了。
 * 过滤后变成空的那条整条丢掉，不给模型发一条空 assistant 消息。
 *
 * **变量替换两种 role 都做**：用户消息开头的环境前缀里带字面
 * {{user}} / {{char}}（env.js 刻意留的 —— 存档存字面量，角色改名后
 * 旧存档不失效），到这里才换成真名。所以即使一条正则都没有也得走一遍。
 * 副作用是对方自己打的 {{char}} 也会被替换，这个可以接受。
 *
 * 导出是给 igprompt.js 用的：Instagram 那一轮也要发上文，滤这一步漏了
 * 就等于把思维链原样喂回去。
 */
export function filterHistory(hist, rules, vars) {
  const out = [];
  for (const m of hist) {
    const content = applyVars(m.content, vars);
    if (m.role !== "assistant" || !rules?.length) {
      if (content) out.push({ role: m.role, content });
      continue;
    }
    const { text } = applyRules(content, rules, {
      target: "aiOutput",
      field: "toHistory",
      vars,
    });
    if (text.trim()) out.push({ role: m.role, content: text });
  }
  return out;
}

/**
 * 天气段并进最后一条 user 消息开头那对方括号里。
 *
 * 天气**不进存档**（env.js 文件头讲了为什么），所以它只能在这里、在拼提示词
 * 的这一刻掺进去。存档里是 `[时间段]对方原话`，模型该看到
 * `[时间段 | 天气段]对方原话` —— 和天气进存档那一版形状完全一致，
 * 只是这一份不落盘，也就不会在后面每一轮里被重发。
 *
 * 找的是**最后一条 user**而不是数组末尾：正则可能把中间某条 assistant
 * 整条滤掉，末尾不一定就是 user。一条 user 都没有（纯 assistant 的历史）
 * 就什么都不做 —— 天气宁可这轮不出，也不该凭空造一条消息。
 *
 * 形状不对（时间感知关着、或用户在「上下文」面板里手改过这条）时退回
 * 自己开一对方括号加在最前面：宁可多一对括号，也不能把用户的原话切坏。
 */
function injectWeather(hist, weather) {
  if (!weather) return hist;
  const at = hist.map((m) => m.role).lastIndexOf("user");
  if (at < 0) return hist;

  const content = hist[at].content;
  const close = content.startsWith("[") ? content.indexOf("]") : -1;
  const merged =
    close > 0
      ? `${content.slice(0, close)} | ${weather}${content.slice(close)}`
      : `[${weather}]${content}`;

  const out = [...hist];
  out[at] = { ...hist[at], content: merged };
  return out;
}

/**
 * 拼这一轮要发给模型的东西。
 *
 * 调用前当轮的用户消息已经 push 进 history，这里不再重复追加。
 *
 * **是 async 的**：记忆库那条条目要拿这一轮的话去打向量接口做语义检索
 * （memory.js），那是一次网络往返。除了记忆库，别的条目都是纯拼字符串。
 *
 * 拼提示词在每轮消息的关键路径上，所以记忆库那一段的失败**绝不能让这轮
 * 回复发不出去** —— 检索打不通就退化成只注入近 N 天的记忆，记一条 warn
 * 继续走，见 memoryBlock。
 *
 * @param {object} config 完整配置
 * @param {object} role 当前角色
 * @param {object|null} user 生效的用户人设，null = 不注入用户信息
 * @param {{role: string, content: string}[]} history 这条会话的上文（未裁剪、未过滤）
 * @param {string} [weatherNote] 这一刻的天气段（env.js 的 buildEnv().weather）。
 *        只并进最后一条 user 消息，**不写回 history** —— 它不该进存档
 * @param {{mode?: "online"|"offline"}} [opts] `mode` 决定用哪一批预设、哪份世界书书单，
 *        以及要不要拼「消息格式与功能」。默认 `online`，也就是 iMessage 那条链
 * @returns {{
 *   messages: {role: string, content: string}[],
 *   params: object,
 *   preset: object,
 *   history: object[],
 *   worldInfo: {hitNames: string[], bookCount: number},
 * }} history 是裁剪后的**原文**数组（不含天气），调用方应该写回内存历史
 */
/**
 * 「线上聊天记录」条目（线下预设专属）：把 {{线上聊天记录}} 换成真实记录。
 *
 * 用户要的：线下模式里注入线上那批聊天，标注那是聊天记录、而现在双方已经见面了。
 *
 * **在哪找这份存档**：线上存档是按「角色名 + 线路号」命名的（sessions.js:
 * sessionIdFor），而线下这条链没有 runner、拿不到线路号，算不出那个 id。
 * 所以反过来查：拿 listSessions() 里同 roleId 的聊天会话，按更新时间取最新那条
 * —— 一个角色通常只挂在一条号码上，真有第二条时，最近聊过的就是该读的那条。
 *
 * 两处刻意的不作为：
 *  1. 一条线上会话都没有（新角色、从没聊过）→ 整条不产出，**不注入空标签**。
 *  2. 那批消息里模型自己说的部分，sessions.js:appendTurn 落盘时已经剥掉思维链，
 *     这里直接读，不再过一遍正则 —— 那是「发给对方」的历史，用户读到的就是它。
 *
 * 变量不走 applyVars（那是「一个词换一个词」），和 {{图生图变量}} 一个办法。
 * 纯读盘、同步，构建提示词时不打网络。
 */
function onlineHistoryBlock(entry, role, user, vars) {
  const roleId = String(role?.id ?? "");
  if (!roleId) return "";

  let session = null;
  try {
    // listSessions 已按 updatedAt 倒序，第一条命中的就是最近聊过的那条
    session = listSessions().find(
      (s) => s.roleId === roleId && (s.kind ?? "chat") === "chat" && s.count > 0
    );
  } catch (e) {
    logWarn("提示词", `读线上会话列表失败，这轮不注入聊天记录：${e?.message ?? e}`);
    return "";
  }
  if (!session) return "";

  const lines = formatHistoryLines(
    recentMessages(session.id, role?.maxContext ?? 20),
    role?.name,
    user?.name
  );
  if (!lines) return "";

  const text = applyVars(entry?.content ?? "", vars).replace(
    /\{\{\s*线上聊天记录\s*\}\}/gi,
    lines
  );
  return wrap("线上聊天记录", text);
}

/**
 * 把一批消息排成聊天记录的样子。
 *
 * 说话人标签直接用角色名和用户名（跟上下文面板里看到的一个样子），**不是**
 * {{char}}/{{user}} —— 名字在这块拼完才被塞进条目正文，而正文的 fill 早跑完了，
 * 留下的 {{char}} 会原样发给模型。sessions.js 里只有 user / assistant 两种 role，
 * 对得上这里的两个人。
 *
 * **不套 <Chat_History>** —— 那对标签是当轮上下文的标记，专用一份预设的「上下文」
 * 条目；套在这里会让模型分不清哪批是刚聊的、哪批是往事。
 *
 * 反向裁：从最新的一条往回装，碰到字数上限就停。**不裁半条** —— 半截话比
 * 少几条更容易被当成真的没说完。
 */
function formatHistoryLines(messages, charName, userName, maxChars = 6000) {
  const list = Array.isArray(messages) ? messages : [];
  const char = String(charName ?? "").trim() || "char";
  const user = String(userName ?? "").trim() || "user";
  const kept = [];
  let used = 0;

  for (let i = list.length - 1; i >= 0; i--) {
    const who = list[i]?.role === "assistant" ? char : user;
    const body = String(list[i]?.content ?? "").trim();
    if (!body) continue;
    const line = `${who}：${body}`;
    if (used + line.length > maxChars && kept.length) break;
    used += line.length;
    kept.unshift(line);
  }

  return kept.length ? kept.join("\n\n") : "";
}

export async function buildPrompt(config, role, user, history, weatherNote = "", opts = {}) {
  const offline = opts?.mode === "offline";
  const preset = resolvePreset(config, role, offline ? "offline" : "online");
  const hist = trimHistory(history, role);

  const vars = {
    char: role?.name ?? "",
    user: user?.name ?? "",
    sep: config?.chat?.separator ?? "",
  };
  const fill = (text) => applyVars(text, vars).trim();

  // 发给模型的那份上文：思维链之类的在这里滤掉，hist 本身留原文。
  // 天气紧接着掺进去 —— 它是这一份的一部分，不是 hist 的一部分。
  // 天气段里也有字面 {{user}} / {{char}}（env.js 刻意留的），它没经过
  // filterHistory 那一遍 applyVars，所以在这里单独替换一次
  const sent = injectWeather(
    filterHistory(hist, preset.regex, { char: vars.char, user: vars.user }),
    applyVars(weatherNote, { char: vars.char, user: vars.user })
  );

  /*
   * {{lastUserMessage}}：用户在上文里说的最后一句，补在 vars 上（fill 闭包读的是
   * 同一个对象，补在这里对后面每一条都生效）。取的是 sent 而不是 hist —— 正则滤掉的
   * 部分模型本来就看不见，复述一遍等于把它捅回去。
   *
   * 没有（第一轮、或者主动消息那种轮到模型先开口的场合）就是空串，引用它的条目
   * 整条不产出（mergeAdjacent 会把空内容跳过）。
   */
  vars.lastusermessage = [...sent].reverse().find((m) => m.role === "user")?.content ?? "";

  // 世界书：只有 world 条目开着才扫。
  // 关掉 = 整个步骤跳过（含 depth 条目）—— 一句话能说清的规则比
  // 「关了一半还生效」好调试。
  // 用滤过的那份扫描：模型看不到的内容不该触发关键词。反过来，天气是模型
  // **看得到**的，所以它也该能触发关键词 —— 这就是 injectWeather 排在
  // activate 之前的原因。
  const worldEntry = preset.entries.find((e) => e.kind === "world");
  let world = { before: "", after: "", depths: new Map(), hitNames: [] };
  let books = [];
  if (worldEntry?.enabled) {
    /*
     * 线下走**另一份书单**：`role.offline.worldBookRefs`（用户要的「可在线下预设内
     * 单独配置角色线下世界书」）。
     *
     * 手法是传一个换掉 refs 的浅拷贝，而不是给 worldBooksFor 加参数 ——
     * 那个函数在前端 labels.js 里有一份镜像，加参数就得两边一起改，
     * 而这里换的只是它读的那一个字段。global 的书照旧对两种玩法都生效。
     */
    const forBooks = offline ? { ...role, worldBookRefs: role?.offline?.worldBookRefs ?? [] } : role;
    books = worldBooksFor(config, forBooks);
    if (books.length) world = activate(books, sent);
  }

  const parts = [];
  for (const entry of preset.entries) {
    if (!entry.enabled) continue;
    switch (entry.kind) {
      case "char":
        // 人设原文直接注入。角色名要出现在提示词里就在正文里写 {{char}}
        parts.push({ role: "system", content: wrap("Character", fill(role?.description)) });
        break;
      case "user":
        parts.push({ role: "system", content: wrap("User", fill(user?.description)) });
        break;
      case "world":
        // before 和 after 本来就相邻、本来就会被合并，这里提前合成一段，
        // 好套上同一对标签
        parts.push({
          role: "system",
          content: wrap("World_Info", [world.before, world.after].filter(Boolean).join("\n")),
        });
        break;
      case "format":
        /*
         * 线下**无条件跳过**这一条 —— 不看 enabled。
         *
         * 用户钉死的：「线下模式开启后会自动关闭掉当前角色线上所有功能
         * （包括主动消息与消息格式与功能等内容），保持真实性」。而线下预设
         * 十有八九是从某份线上预设复制来的，会连这一整条一起带过来、还开着。
         * 靠一个开关挡不住 —— 用户改不到他不知道要改的地方。
         *
         * 里面那十一条讲的全是 iMessage 的玩法（发语音、贴表情、撤回、
         * 已读不回、发位置卡片），线下一条都发不出去。注入了的后果不是
         * 「多几句没用的话」，而是模型会真的输出 `[audio_message:…]` 这种
         * 标记，然后被原样打进剧情正文里。
         */
        if (offline) break;
        parts.push({ role: "system", content: formatBlock(entry, fill, role, config) });
        break;
      case "context": {
        const woven = weaveDepths(sent, world.depths);
        // 上文是空的时候两条标记贴在一起没有意义，整条跳过
        if (!woven.length) break;
        parts.push({ role: "system", content: HISTORY_OPEN });
        parts.push(...woven);
        parts.push({ role: "system", content: HISTORY_CLOSE });
        break;
      }
      case "memory":
        parts.push({
          role: "system",
          content: await memoryBlock(entry, role, config, sent),
        });
        break;
      case "onlineHistory":
        /*
         * 线上聊天记录（线下预设专属）。条目的正文是用户自己写的导语 + 一行
         * {{线上聊天记录}}，那行换成真实记录（onlineHistoryBlock）。
         *
         * 正文照旧过一遍 fill —— 用户在导语里写 {{user}} 是很自然的事。
         * 记录本身不 fill：那是模型自己说过的话，里面就该是当时那两个名字。
         *
         * 没有线上存档时整条不产出（onlineHistoryBlock 返回空串，wrap 也吃空）。
         * 线上预设里不会有这个 kind（normalizeEntries 会把它转成 custom）。
         */
        parts.push({
          role: "system",
          content: onlineHistoryBlock(entry, role, user, vars),
        });
        break;
      case "userChoice":
        /*
         * 用户选项（线下预设专属）。默认关，关着就整条不进提示词、也不生成选项。
         *
         * 位置由用户排 —— 它在 entries 里的顺序就是注入顺序，和别的条目一样。
         * 默认排在最后（defaultEntries），也就是紧贴着模型要生成的位置，
         * 「另起一段给四条选项」这种格式要求放在这儿最不容易被前面几千字冲淡。
         *
         * 线上预设里不会有这个 kind（normalizeEntries 会把它转成 custom），
         * 所以这里不用再判一次 offline。
         */
        parts.push({ role: "system", content: wrap("User_Choices", fill(entry.content ?? "")) });
        break;
      case "custom":
        // 可移动条目不自动包标签 —— 名字是用户随便起的，未必是合法标签名。
        // 想包自己在正文里写
        parts.push({ role: entry.role ?? "system", content: fill(entry.content ?? "") });
        break;
      default:
        break;
    }
  }

  return {
    messages: mergeAdjacent(parts),
    params: preset.params,
    preset,
    history: hist,
    worldInfo: { hitNames: world.hitNames, bookCount: books.length },
  };
}