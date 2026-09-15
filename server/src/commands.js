import {
  DEFAULT_PRIVACY_TRIGGER,
  loadConfig,
  modelLabel,
  providerLabel,
  resolveImageEndpoint,
  saveConfig,
} from "./config.js";
import { pickRefFromText, resolveRefFile } from "./media.js";
import { restartNotice } from "./restart.js";
import { readSession, writeSession } from "./sessions.js";

/**
 * iMessage 里的快捷指令。
 *
 * 对方在聊天里发 `/clear 1`、`/provider2` 这种消息时，**不打模型**、
 * 直接改配置或存档，然后回一条确认。省 token 是要点：切模型本来要用户
 * 跑回浏览器点几下，现在一条消息搞定，而这条消息本身不该再花一次生成。
 *
 * **只有认识的那几条算指令**（COMMANDS 里的），它们不进合并队列、
 * 不发给模型、不写进上下文存档。其余 `/` 开头的消息一律当普通聊天 ——
 * 网址、路径（`/Users/me/a.jpg`）、顺手打的 `/ 明天见` 都得原样送到模型
 * 那儿。为省几个 token 把这些劫走，代价是用户发个链接却收到一句
 * 「不认识这条指令」，那比白花一次生成更糟。
 *
 * 记不住写法就发 `/help`，它自己也是一条指令。
 *
 * 唯一不以 `/` 打头的是**防相亲的暗号**（默认 `/防相亲`，用户可以改成任意词、
 * 带不带斜杠都认）。它是这条规则的一个有意的例外，见 isPrivacyToggle。
 *
 * 这个文件只管「怎么解析」和「怎么执行」，一条消息要不要当指令、执行结果
 * 怎么发回去，都在 imessage.js 那边（见 tryCommand 的调用处）。
 * 拆出来的理由是解析部分是纯函数，出问题能单独试。
 *
 * 故意**不 import imessage.js**（也不 import memoryhooks.js / igrun.js，那两条链
 * 会绕回 imessage.js）—— 那边要 import 这边，反过来就是循环依赖。需要丢内存历史时
 * 由调用方把 forgetHistory 当参数传进来；`/image`、`/memory`、`/diary`、
 * `/重roll`、`/重启`、`/立即触发评论`、`/提示词协助模式`、线下那四条
 * （`/开启线下`、`/小总结`、`/大总结`、`/关闭线下`）这几条只在这里做检查，
 * 真正的动作由调用方按返回值去做 —— offline.js 那条链要 buildPrompt，
 * 从这里 import 会把依赖绕回去。
 */

/** 认识的指令。不在这张表里的 `/xxx` 一律当普通聊天，见 parseCommand。 */
const COMMANDS = new Set([
  "clear",
  "del",
  "provider",
  "model",
  "help",
  "image",
  "memory",
  "diary",
  "reroll",
  "restart",
  "igtick",
  "promptmode",
  "promptmodeoff",
  "offlineon",
  "offlineoff",
  "sumsmall",
  "sumbig",
]);

/**
 * 中文指令的别名：`/日记` → `/diary`。
 *
 * 用户明确要求 `/diary` 和 `/日记` 都能用。**没有**去放宽 parseCommand 里那个
 * `[A-Za-z]+`：中文字符进了命令词字符类，`/明天见`、`/在吗` 这种普通消息就会
 * 开始被当指令看，破坏文件头「`/` 开头不等于指令」那条保证 —— 用户发一句
 * `/走了` 却收到「不认识这条指令」，比多写一张表糟得多。
 *
 * 所以中文写法在 normalize 这一步就换成对应的英文命令词，后面的解析一个字
 * 都不用改。只认这张表里的几个词，别的中文照旧是聊天。
 *
 * `重roll` 是中英混着的（用户就这么要的），所以别名那条正则的捕获放宽到了
 * 「中文开头 + 可选的英文尾巴」。放宽的是**候选词怎么切**，不是「什么算指令」——
 * 真正的闸门始终是这张表：切出来的词不在表里就原样留着，交给下面那条严格的
 * `[A-Za-z]+` 去判，而它认不了中文，于是 `/明天见` 照旧返回 null。
 *
 * `提示词协助模式` 和 `提示词协助模式关闭` 两条**共用前缀**，能分对是因为那条
 * 正则对中文是贪婪的：`/提示词协助模式关闭` 一次捕完整个长词，先命中长的那条。
 * 反过来写成「短词 + 参数」（`/提示词协助模式 关闭`）会掉进 `(?=$|[\s[(:=])`
 * 的空白分支，把 `关闭` 当成参数扔掉，等于关不掉 —— 所以这里必须是两个独立的词。
 *
 * 线下那四条（`开启线下` / `关闭线下` / `小总结` / `大总结`）是用户逐字定的写法，
 * 正好**四个独立的词、不共用前缀**，连上面那条贪婪规则都不用依赖。
 */
const COMMAND_ALIASES = {
  日记: "diary",
  记忆: "memory",
  重roll: "reroll",
  重启: "restart",
  立即触发评论: "igtick",
  提示词协助模式: "promptmode",
  提示词协助模式关闭: "promptmodeoff",
  开启线下: "offlineon",
  关闭线下: "offlineoff",
  小总结: "sumsmall",
  大总结: "sumbig",
};

/**
 * 带自由文本参数的指令。
 *
 * 上面那条严格的正则钉死了行尾、只收数字，`/image 一只小狗` 解析不出来。
 * 这几条单独走一条路：命令词后面剩下的**整段**都是参数。
 *
 * 这不违反「`/` 开头不等于指令」那条规则 —— 命令词仍然要**恰好**是表里的
 * 那几个，`/images/logo.png` 这种路径的第一段是 `images` 不是 `image`，
 * 照样当聊天发给模型。
 */
const FREE_TEXT_COMMANDS = new Set(["image"]);

/**
 * 手机键盘打出来的字符先归一化。
 *
 * 中文输入法下斜杠是全角的 `／`，方括号是 `［］`，数字也可能是全角 `１`；
 * iOS 还会自动把首字母大写成 `/Clear`。这些都是用户正常打字的结果，
 * 不该因此认不出指令 —— 一条认不出的指令会被当成聊天发给模型，
 * 既花了 token 又没做事，比报错更糟。
 */
function normalize(raw) {
  let s = String(raw ?? "").trim();
  // 全角标点 → 半角
  s = s.replace(/[／［］（）：＝　]/g, (ch) => {
    const map = { "／": "/", "［": "[", "］": "]", "（": "(", "）": ")", "：": ":", "＝": "=", "　": " " };
    return map[ch] ?? ch;
  });
  // 全角数字 → 半角（０的码位是 0xFF10）
  s = s.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));

  /*
   * 中文命令词换成英文（`/日记` → `/diary`）。见 COMMAND_ALIASES 的注释。
   *
   * 只在**开头**换，而且换完后面必须是空白或者到头了 —— `/日记本` 不是指令，
   * `/日记` 和 `/日记 昨天的` 是。这条和下面那两个正则的边界规则一致。
   *
   * 捕获是「中文 + 可选的英文尾巴」，为的是 `/重roll` 这种混写。多切出来的
   * 候选词不在表里就什么都不做，所以放宽这里不会多认任何一条指令。
   */
  const alias = /^\/\s*([一-龥]+[A-Za-z]*)(?=$|[\s[(:=])/.exec(s);
  if (alias) {
    // 英文尾巴按小写查表：iOS 会把 `/重roll` 自动大写成 `/重Roll`
    const hit = COMMAND_ALIASES[alias[1].toLowerCase()];
    if (hit) s = `/${hit}${s.slice(alias[0].length)}`;
  }
  return s;
}

/**
 * 一条消息解析成指令。**不是指令就返回 null**，调用方照常交给模型。
 *
 * 三种写法都吃（用户明确要的）加上几种顺手的：
 *   /clear 1   /clear1   /clear[1]   /clear(1)   /clear:1   /clear=1
 *
 * **只认 COMMANDS 里那几个词**，`/` 开头不等于指令：
 * 网址（`/r/xxx`、粘贴时被截断的链接）、路径（`/Users/me/photo.jpg`）、
 * 顺手打的 `/ 明天见` 都得原样送到模型那儿。把这些劫走当指令，
 * 用户会莫名收到一句「不认识这条指令」，而他只是想发个链接。
 *
 * 后面跟着别的话也不算（`/del 顺便说一下`）—— 正则钉死了行尾，
 * 那种消息整体是聊天，不是指令。**例外是 FREE_TEXT_COMMANDS 里那几条**
 * （现在只有 `/image`），它们后面本来就该跟一段话，见下面那条正则。
 *
 * @returns {{name: string, num: number|null, args: string}|null}
 *          args 是自由文本参数（只有 FREE_TEXT_COMMANDS 那几条会非空）
 */
export function parseCommand(raw) {
  const s = normalize(raw);
  if (!s.startsWith("/")) return null;

  /*
   * 自由文本那条先试。
   *
   * `\b` 不管用 —— 中文不是单词字符，`/image一只狗` 里 `image` 和 `一` 之间
   * 没有边界。所以显式要求命令词后面是**空白、方括号或者到头了**：
   * `/imagex` 不是指令，`/image` / `/image 狗` / `/image[小猫] 狗` 是。
   */
  const free = /^\/\s*([A-Za-z]+)(?=$|[\s[])\s*([\s\S]*)$/.exec(s);
  if (free) {
    const name = free[1].toLowerCase();
    if (FREE_TEXT_COMMANDS.has(name)) {
      return { name, num: null, args: free[2].trim() };
    }
  }

  const m = /^\/\s*([A-Za-z]+)\s*(?:[:=[(]\s*)?(\d+)?\s*[\])]?\s*$/.exec(s);
  if (!m) return null;

  const name = m[1].toLowerCase();
  if (!COMMANDS.has(name)) return null;

  return { name, num: m[2] === undefined ? null : Number(m[2]), args: "" };
}

/* ---------------- 防相亲 ---------------- */

/** 暗号比对前先把开头的 `/` 摘了 —— 带不带斜杠都算数。 */
function bareWord(s) {
  const t = String(s ?? "").trim();
  return (t.startsWith("/") ? t.slice(1) : t).trim().toLowerCase();
}

/** 当前生效的暗号。配置里空着就用默认的（normalizePrivacy 也兜了一道）。 */
export function privacyTrigger() {
  return String(loadConfig().privacy?.trigger ?? "").trim() || DEFAULT_PRIVACY_TRIGGER;
}

/** 防相亲现在开着没有。imessage.js 每次要发系统消息之前都问一下。 */
export function privacyOn() {
  return Boolean(loadConfig().privacy?.enabled);
}

/**
 * 这条消息是不是防相亲的暗号。
 *
 * 和 parseCommand 不一样，**不要求以 `/` 开头** —— 用户要的就是「发出指定词
 * 即可」。一个不带斜杠的暗号本身也更不起眼：别人瞄到一眼，看见的是一句
 * 莫名其妙的话，而不是一条一眼就是在操作什么东西的指令。
 *
 * 代价是这个词被整条吃掉、发不给模型了，所以必须**整条消息完全等于**暗号，
 * 前后多一个字都不算。用户自己挑的词，撞车的责任在他，网页端那边会提醒。
 *
 * 两边都过一遍 normalize：用户在手机上打出来的可能是全角的 `／fxq`，
 * 而网页端存进去的是半角。大小写也忽略 —— iOS 会把 `fxq` 自动大写成 `Fxq`。
 */
export function isPrivacyToggle(raw, trigger) {
  const want = bareWord(normalize(trigger));
  if (!want) return false;
  return bareWord(normalize(raw)) === want;
}

/**
 * 这条消息该不该被当指令劫下来（不进合并队列、不发给模型）。
 *
 * imessage.js 拦消息看的是这个，不是 parseCommand —— 暗号可以不带 `/`，
 * parseCommand 按设计认不出它。两个拦截点（收消息那儿和 handleCommand 开头）
 * 用同一个函数，不会走岔。
 */
export function isCommandMessage(raw) {
  if (parseCommand(raw)) return true;
  return isPrivacyToggle(raw, privacyTrigger());
}

/**
 * 暗号 —— 开/关防相亲。
 *
 * **开的那一下故意不给提示**。不是忘了：一条「✅ 防相亲已开启」本身就是
 * 一条系统发言，而且是最露馅的那种 —— 这个功能存在的全部意义就是别让人
 * 看见这类消息。这里不用特殊处理，顺序自己解决了问题：saveConfig 在返回
 * 之前就把 enabled 写成了 true，等调用方去发这句确认时，那道新的系统消息
 * 闸门已经关上了，这句话自己被自己拦下。关的时候 enabled 已经是 false，
 * 「已关闭」照常发出去 —— 用户这时需要知道它真的关了。
 */
function cmdPrivacy(config) {
  const on = !config.privacy?.enabled;
  saveConfig({
    ...config,
    privacy: { ...(config.privacy ?? {}), enabled: on },
  });
  return {
    text: on ? "✅ 防相亲已开启。" : "✅ 防相亲已关闭，系统消息恢复正常。",
    log: `快捷指令：防相亲${on ? "开" : "关"}了`,
  };
}

/**
 * 从尾巴上摘掉 n 轮对话。
 *
 * 「一轮」按**用户消息**数：从末尾往前走，走过 n 条 user 消息就停。
 * 不写成「砍掉 2n 条」是因为历史不保证严格一问一答 —— 上游报错那轮只写进
 * 一条 user 消息（handleTurn 里 LLM 抛异常时那条已经在历史里了），
 * 按固定条数砍会错位，把上一轮的回复劈成两半留在里面。
 */
function trimRounds(messages, rounds) {
  let i = messages.length;
  let cut = 0;
  while (i > 0 && cut < rounds) {
    i -= 1;
    if (messages[i]?.role === "user") cut += 1;
  }
  return { kept: messages.slice(0, i), removed: messages.length - i, rounds: cut };
}

/** 这个服务商下面能用来聊天的模型（开着 + 挂了 chat 分类）。 */
function chatModelsOf(provider) {
  return (provider?.models ?? []).filter(
    (m) => m.enabled && (m.categories ?? []).includes("chat")
  );
}

/** 非 chat 的模型在列表里标一下，免得选了个只会识图的当聊天模型还不知道。 */
function categoryTag(entry) {
  const cats = entry?.categories ?? [];
  if (cats.includes("chat")) return "";
  // MODEL_CATEGORIES 的中文名，client/src/labels.js:CATEGORY_LABELS 有一份镜像
  const names = { vision: "识图", audio: "听音", image: "生图", embedding: "向量" };
  const tag = cats.map((c) => names[c] ?? c).join("/");
  return tag ? `（仅${tag}）` : "（未分类）";
}

/** 把角色的 chatModel 写回配置并落盘，返回新配置。 */
function saveChatModel(config, roleId, ref) {
  return saveConfig({
    ...config,
    roles: (config.roles ?? []).map((r) =>
      r.id === roleId ? { ...r, chatModel: { ...ref } } : r
    ),
  });
}

/**
 * 这个码位在等宽字体里占两格吗（CJK / 假名 / 谚文 / 全角标点）。
 *
 * 写成码位区间而不是正则里的字面量，是因为那几个区间的端点里有隐形字符
 * （比如谚文的填充符 U+115F）—— 源码里肉眼看不见，被哪个编辑器顺手清掉
 * 就变成一条语法错误的正则，而且 diff 上什么都看不出来。
 */
function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // 谚文字母
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK 部首、标点、假名、汉字、彝文
    (cp >= 0xac00 && cp <= 0xd7a3) || // 谚文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容汉字
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK 兼容形式
    (cp >= 0xff00 && cp <= 0xff60) || // 全角 ASCII
    (cp >= 0xffe0 && cp <= 0xffe6) // 全角货币符号
  );
}

/**
 * 指令表里那一列的对齐。
 *
 * 不能用 padEnd —— 它按**字符数**补，而中文在等宽字体里占两格，
 * `/重启` 和 `/del` 都是 3 个字符，画出来却差 2 格。暗号是用户自己起的名字，
 * 中英混着的可能性很大，所以这一列得按视觉宽度补。
 */
function padCmd(s, width = 11) {
  let w = 0;
  for (const ch of s) w += isWide(ch.codePointAt(0)) ? 2 : 1;
  return s + " ".repeat(Math.max(1, width - w));
}

/**
 * `/help` 回的那张表。
 *
 * 指令是「发一条消息就生效」的隐藏功能，没有界面能点、也没有提示 ——
 * 记不住写法的时候得有个地方问。所以它自己也是一条指令。
 *
 * 做成函数是因为防相亲那条要显示**用户当前设的暗号**，写死没用。
 *
 * 网页端右上角那张表是这张的镜像（client/src/commands-help.js）。
 * 改了这边记得改那边 —— 两张表说的不一样，用户会信错一张。
 */
function buildHelp(trigger) {
  const t = String(trigger ?? "").trim() || DEFAULT_PRIVACY_TRIGGER;
  const bare = t.startsWith("/") ? t.slice(1) : t;
  return [
    "可用的快捷指令（都不消耗 token）：",
    "",
    "/clear 1   清除最近 1 轮对话",
    "           也可写 /clear1 或 /clear[1]；不带数字按 1 轮",
    "/del       清空当前对话的全部上下文",
    "/provider  查看所有服务商，标出当前那个",
    "/provider1 切到第 1 个服务商（模型从它已开启的 LLM 里随机挑）",
    "/model     查看当前服务商的模型，标出当前那个",
    "/model1    切到第 1 个模型",
    "/image 描述        直接生成一张图（不经过 AI，也不进上下文）",
    "/image 小猫 描述   基于图库里那张参考图生成；名字带空格就写 /image[小猫] 描述",
    "/memory    立刻把攒着的聊天记录总结成一条记忆（也可写 /记忆）",
    "/diary     立刻写一篇日记（也可写 /日记）",
    "/重roll    对刚才那条回复不满意时，重新生成一次（也可写 /reroll）",
    "/重启      重启整个服务（也可写 /restart）",
    "/立即触发评论  Instagram 排着的赞和评论不用再等，全部立刻跑完",
    "/提示词协助模式      角色让位，换提示词工程师帮你排查人设/世界书/预设",
    "           这期间说的话不进角色的上下文，也不会有任何角色扮演",
    "/提示词协助模式关闭  结束协助，这期间的对话一并丢掉，回到正常聊天",
    "/开启线下  开始演一段线下剧情。开着的时候这个角色的线上功能全部停用",
    "           （主动消息、消息格式与功能都不生效）；网页端「对话框」里是同一段",
    "/小总结    立刻把还没总结过的那几轮剧情概括成一份",
    "/大总结    立刻把攒着的几份小总结合并成一份",
    "/关闭线下  结束这段剧情：补一次大总结，把总结写进待总结，回归线上功能",
    `${padCmd(t)}开关防相亲：开着时所有系统发言（指令确认、报错、总结）都不发出来`,
    `           也可以不带 /，直接发「${bare}」；这个词在网页端「发送」里能改`,
    "/help      看这张表",
    "",
    "只有上面这几条会被当指令。其余 `/` 开头的消息（网址、路径…）照常发给 AI。",
  ].join("\n");
}

/* ---------------- 各条指令 ---------------- */

function cmdClear({ num, sessionId, forget }) {
  // 不带数字就按 1 轮 —— 「清除最近的对话」最常见的意思就是撤掉刚才那一次
  const rounds = num && num > 0 ? num : 1;
  const session = readSession(sessionId);
  if (!session.messages.length) {
    return { text: "这段对话本来就是空的，没什么可清的。" };
  }

  const { kept, removed, rounds: done } = trimRounds(session.messages, rounds);
  writeSession(sessionId, kept);
  // 存档改了，挂着的连接手里还攥着一份内存历史 —— 不丢掉的话下一轮照旧
  // 把清掉的内容发给模型（imessage.js 的 forgetHistory 注释里有这段坑）
  forget(sessionId);

  const short = done < rounds ? `（只有 ${done} 轮可清）` : "";
  return {
    text: `✅ 已清除最近 ${done} 轮对话${short}，共 ${removed} 条消息，还剩 ${kept.length} 条。`,
    log: `清除了会话 ${sessionId} 最近 ${done} 轮（${removed} 条），剩 ${kept.length} 条`,
  };
}

function cmdDel({ sessionId, forget }) {
  const session = readSession(sessionId);
  const had = session.messages.length;
  if (!had) return { text: "这段对话本来就是空的，没什么可清的。" };

  // 清空而不是删文件：把 roleName / peer 这些留着，「上下文」面板里这条
  // 还在，只是没消息了。删掉文件的话整条会话从列表上消失，不是「清空」的意思
  writeSession(sessionId, []);
  forget(sessionId);

  return {
    text: `✅ 已清空当前对话的全部上下文（原有 ${had} 条消息）。`,
    log: `清空了会话 ${sessionId} 的全部上下文（${had} 条）`,
  };
}

function cmdProvider({ num, config, role }) {
  const providers = config.providers ?? [];
  if (!providers.length) {
    return { text: "⚠️ 还没有配置任何服务商源，先去浏览器里的「连接」面板加一个。" };
  }

  const curProvider = role?.chatModel?.provider ?? "";

  // 不带数字：列出来给对方挑
  if (num === null) {
    const lines = providers.map((p, i) => {
      const n = chatModelsOf(p).length;
      const mark = p.id === curProvider ? "  ←当前" : "";
      return `${i + 1}. ${providerLabel(p)}（${n} 个可用模型）${mark}`;
    });
    return {
      text: [`服务商共 ${providers.length} 个：`, ...lines, "", "回复 /provider1 切到第 1 个。"].join("\n"),
    };
  }

  const provider = providers[num - 1];
  if (!provider) {
    return { text: `⚠️ 没有第 ${num} 个服务商，一共只有 ${providers.length} 个。发 /provider 看列表。` };
  }

  // 「模型使用已开启的 LLM（随机选一个）」—— 用户要的就是随机
  const pool = chatModelsOf(provider);
  if (!pool.length) {
    return {
      text:
        `⚠️「${providerLabel(provider)}」下面没有可用的聊天模型` +
        `（要既开启、又挂着「聊天」分类），没有切换。`,
    };
  }
  const picked = pool[Math.floor(Math.random() * pool.length)];

  saveChatModel(config, role.id, { provider: provider.id, modelId: picked.id });

  const how = pool.length > 1 ? `（从 ${pool.length} 个已开启的 LLM 里随机选的）` : "";
  return {
    text: `✅ 已切换到「${providerLabel(provider)}」\n模型：${modelLabel(picked)}${how}`,
    log: `角色「${role.name}」的聊天模型切到 ${providerLabel(provider)} · ${modelLabel(picked)}`,
  };
}

function cmdModel({ num, config, role }) {
  const providers = config.providers ?? [];
  const provider = providers.find((p) => p.id === role?.chatModel?.provider);
  if (!provider) {
    return { text: "⚠️ 当前还没选定服务商（或原来那个已被删除）。先发 /provider 挑一个。" };
  }

  // 只列开着的：关掉的模型 resolveEndpoint 一律返回 null，列出来也切不过去，
  // 白让人试一次。关掉的数量单独说一句，免得对方以为编号漏了
  const usable = (provider.models ?? []).filter((m) => m.enabled);
  const offCount = (provider.models ?? []).length - usable.length;
  if (!usable.length) {
    return { text: `⚠️「${providerLabel(provider)}」下面没有开启的模型。` };
  }

  const curModel = role?.chatModel?.modelId ?? "";

  if (num === null) {
    const lines = usable.map((m, i) => {
      const mark = m.id === curModel ? "  ←当前" : "";
      return `${i + 1}. ${modelLabel(m)}${categoryTag(m)}${mark}`;
    });
    // 关掉的那句只在真有的时候插进去；空行是有意留的，不能跟着一起过滤掉
    if (offCount) lines.push(`（另有 ${offCount} 个已关闭的模型没列出）`);
    return {
      text: [
        `「${providerLabel(provider)}」的模型共 ${usable.length} 个：`,
        ...lines,
        "",
        "回复 /model1 切到第 1 个。",
      ].join("\n"),
    };
  }

  const entry = usable[num - 1];
  if (!entry) {
    return { text: `⚠️ 没有第 ${num} 个模型，一共只有 ${usable.length} 个。发 /model 看列表。` };
  }

  saveChatModel(config, role.id, { provider: provider.id, modelId: entry.id });

  // 选了个不带 chat 分类的：照切（用户明确指定了编号），但要说清楚
  const warn = (entry.categories ?? []).includes("chat")
    ? ""
    : "\n⚠️ 这个模型没挂「聊天」分类，回复可能出错。";
  return {
    text: `✅ 已切换到模型「${modelLabel(entry)}」（${providerLabel(provider)}）${warn}`,
    log: `角色「${role.name}」的聊天模型切到 ${providerLabel(provider)} · ${modelLabel(entry)}`,
  };
}

/**
 * `/image 一只小狗` —— 不打模型，直接出一张图。
 *
 * 这个函数**只做检查和解析**，真正的生成和发送在 imessage.js 那边
 * （这个文件不能 import 它，会循环依赖）。所以返回值里带一个 `image` 字段，
 * 调用方看到它就去出图；没有 `image` 只有 `text` 的就是没通过检查，
 * 把原因发回去。
 *
 * 三道闸里只查**角色那道**（imageGen.enabled）。子条目和预设条目那两道管的是
 * 「要不要告诉模型有这个功能」，而这条指令压根不经过模型 —— 用户自己敲的
 * 指令不该被提示词开关拦住。
 */
function cmdImage({ args, config, role }) {
  if (!role?.imageGen?.enabled) {
    return {
      text: "⚠️ 这个角色没开「生成图片」。去浏览器的「角色 → 单独配置 → 生成图片」里打开。",
    };
  }
  if (!resolveImageEndpoint(config)) {
    return {
      text:
        "⚠️ 还没有可用的生图模型。去「连接」面板给某个模型勾上「生图」分类" +
        "（那个模型也要是开启状态）。",
    };
  }

  // 图生图关着时不摘参考图名，整段都是描述 —— 否则「小猫 在睡觉」会被
  // 悄悄砍成「在睡觉」，用户看不出图为什么不对
  const gen = role.imageGen;
  const names = gen.img2img ? gen.refs ?? [] : [];
  const { ref, prompt } = pickRefFromText(args, names);

  if (!prompt) {
    return {
      text: [
        "⚠️ /image 后面要写画面描述，例如：",
        "/image 一只趴在窗台上晒太阳的橘猫",
        ...(names.length
          ? [`/image ${names[0]} 让它躺在地上（基于图库里的「${names[0]}」生成）`]
          : []),
      ].join("\n"),
    };
  }

  // 图库里有这条、文件却不在 data/images/ 里：说清楚，别默默按文生图出图
  if (ref && !resolveRefFile(ref)) {
    return {
      text: `⚠️ 图库里有「${ref}」，但 data/images/ 文件夹里找不到对应的图片文件。`,
    };
  }

  return {
    // text 留空 —— 出图本身就是回复，再发一句「正在生成」是多余的一条消息
    image: { prompt, ref },
    log: `快捷指令出图：${prompt}${ref ? `（参考图「${ref}」）` : ""}`,
  };
}

/**
 * `/memory`、`/记忆` —— 立刻把攒着的聊天记录总结成一条记忆。
 * `/diary`、`/日记` —— 立刻写一篇日记。
 *
 * 和 `cmdImage` 同一个路子：这个函数**只做检查**，真正的总结在 imessage.js
 * 那边（这个文件不能 import memoryhooks.js，那条链会绕回 imessage.js）。
 * 所以返回值里带一个 `memory` 字段说明要跑哪一类，调用方看到它就去跑。
 *
 * 只查**角色那道闸**（`role.memories.*.enabled`），和 `/image` 一致：
 * 预设条目那道管的是「要不要告诉模型这些记忆」，而指令压根不经过模型。
 * 具体的开关检查在 memoryhooks 那边做（它才拿得到 config.memories），
 * 这里只挡「压根没开」这一种，好让提示语说得具体。
 */
function cmdMemory({ role }) {
  if (!role?.memories?.memory?.enabled) {
    return {
      text: "⚠️ 这个角色没开「记忆」。去浏览器的「角色 → 单独配置 → 记忆库」里打开。",
    };
  }
  // text 留空 —— 总结要打一次模型，几十秒，结果由调用方发回来
  return { memory: { kind: "memory" }, log: "快捷指令：手动总结记忆" };
}

function cmdDiary({ role }) {
  if (!role?.memories?.diary?.enabled) {
    return {
      text: "⚠️ 这个角色没开「日记」。去浏览器的「角色 → 单独配置 → 记忆库」里打开。",
    };
  }
  return { memory: { kind: "diary" }, log: "快捷指令：手动生成日记" };
}

/**
 * `/重roll`、`/reroll` —— 刚才那条回复不满意（掉格式、跑偏、答非所问），
 * 拿同样的上文重新生成一次。
 *
 * 这里**只把存档退回到上一轮之前**，重新生成由调用方做（这个文件不能 import
 * imessage.js）。所以返回值里带 `reroll`，里面是要重发的那条 user 消息原文。
 *
 * 退回的做法是从尾巴上摘掉一整轮（和 `/clear 1` 同一个 trimRounds），把摘下来
 * 的那条 user 消息交回去重发 —— 而不是「只删 assistant 那条」。差别在存档的
 * 一致性上：只删回复的话，重新生成成功后 appendTurn 会把 user 消息**再写一遍**，
 * 存档里就有两条一模一样的提问；轮数还会因此多算一轮，记忆库那边跟着错位。
 *
 * 摘下来的 user 消息**原样**发回去重跑，不去掉那个 `[…时间…]` 前缀 ——
 * 它本来就是当时那一轮的一部分，重生成的是「同一轮」，时间戳该保持是原来那个。
 * 调用方据此走一条不再加前缀的路（见 imessage.js 的 rerollTurn）。
 */
function cmdReroll({ sessionId, forget }) {
  const session = readSession(sessionId);
  const messages = session.messages ?? [];

  // 只有 user 没有 assistant，说明上一轮压根没回上来（模型报错那种）。
  // 那也照样能重 roll —— 用户要的就是「再试一次」
  const { kept, removed } = trimRounds(messages, 1);
  const dropped = messages.slice(kept.length);
  const lastUser = dropped.find((m) => m.role === "user");

  if (!lastUser?.content) {
    return { text: "这段对话里还没有可以重新生成的内容。" };
  }

  writeSession(sessionId, kept);
  // 和 /clear 一样：存档改了，内存历史也得丢，否则下一轮照旧把删掉的发出去
  forget(sessionId);

  return {
    // text 留空 —— 重新生成本身就是回复，再发一句「正在重新生成」是多余的一条
    reroll: { userText: lastUser.content },
    log: `重新生成会话 ${sessionId} 的最后一轮（退回了 ${removed} 条消息）`,
  };
}

/**
 * `/重启`、`/restart` —— 重启整个服务。
 *
 * 和别的指令一样只做检查：能不能重启（是不是启动器拉起来的）问 restart.js，
 * 真正的「发完话再退」由调用方做 —— 进程要是在气泡送达之前就没了，对方看到的
 * 只是连接断开，不知道是自己点的还是崩了。
 */
function cmdRestart() {
  const notice = restartNotice();
  if (!notice.ok) return { text: notice.text };
  return { restart: true, text: notice.text, log: "快捷指令：重启整个服务" };
}

/**
 * `/立即触发评论`、`/igtick` —— Instagram 排着的赞和评论别等了，现在全跑掉。
 *
 * 队列里的任务各自排在 30–120 分钟之后（igrun.js 里那个等待窗口），为的是别让
 * 五个角色在同一秒齐刷刷冒出来。但用户自己想看效果的时候等不了那么久。
 *
 * 和 `/image`、`/memory` 一个路子：这里只返回一个 marker，真正的执行在
 * imessage.js 那边（这个文件不能 import igrun.js —— 那条链会绕回 imessage.js）。
 *
 * 什么都不检查。队列空着时调用方会回一句「现在没有排着的」，这比在这儿再查一遍
 * 「有没有角色开着 IG」更准 —— 队列里躺着的是之前排下的，和现在谁开着没关系。
 */
function cmdIgTick() {
  return { igtick: true, log: "快捷指令：立刻跑完 Instagram 互动队列" };
}

/**
 * `/提示词协助模式` —— 角色让位，换提示词工程师。
 *
 * 回的那句话是**用户逐字指定**的（「触发完成后系统回复"已开启提示词协助模式，
 * 请您说明情况，我会协助您。"」），别顺手改措辞。
 *
 * 这里只做一件检查：角色有没有关掉这个功能。真正的开关状态在
 * promptmode.js 那张表里，按「线路 + 会话」存 —— 而这个文件拿不到那两个 id
 * （它不认识 runner），所以照 `/立即触发评论` 的路子只返回 marker，
 * 开表、拼提示词、发消息都在 imessage.js 那边。
 *
 * 已经开着的时候也照样返回 marker：判重要看表，调用方开表时自然知道，
 * 那时候再换一句话回。在这儿猜会猜错。
 */
function cmdPromptMode({ role }) {
  if (role?.promptAssist?.enabled === false) {
    return { text: "⚠️ 这个角色的提示词协助模式是关着的，去网页端的角色设置里打开。" };
  }
  return {
    promptMode: "on",
    text: "已开启提示词协助模式，请您说明情况，我会协助您。",
    log: "快捷指令：开启提示词协助模式",
  };
}

/**
 * `/提示词协助模式关闭` —— 结束协助，这期间的上下文一并丢掉。
 *
 * **不查角色那个开关**：功能被关掉之前开着的协助模式得能关掉，不然用户在
 * 网页端一关开关，那条会话就永远卡在协助模式里出不来了。
 */
function cmdPromptModeOff() {
  return {
    promptMode: "off",
    text: "已关闭提示词协助模式，这期间的对话不会留下。",
    log: "快捷指令：关闭提示词协助模式",
  };
}

/* ---------------- 线下模式 ---------------- */

/**
 * `/开启线下` —— 从聊短信切成坐下来演剧情。
 *
 * 照 `/提示词协助模式` 的路子：这里只查角色那道闸，开表、起剧情、发确认都在
 * imessage.js 那边（这个文件不能 import offline.js —— 那条链要 buildPrompt，
 * 而拦消息的判断得在 imessage.js 里做）。
 *
 * **和协助模式互斥**也在调用方判：那张表按「线路 + 会话」存，这个文件拿不到
 * 那两个 id。两条并行链同时开着会抢同一条消息。
 *
 * 已经开着的时候照样返回 marker，理由和协助模式一样：判重要看存档
 * （`data/offline/index/<roleKey>.json` 的 `open`），调用方那时候自然知道。
 */
function cmdOfflineOn({ role }) {
  if (role?.offline?.enabled === false) {
    return { text: "⚠️ 这个角色的线下模式是关着的，去网页端的角色设置 →「线下模式」里打开。" };
  }
  return { offline: { action: "on" }, log: "快捷指令：开启线下模式" };
}

/**
 * `/关闭线下` —— 结束这段剧情，回归线上功能。
 *
 * **不查角色那个开关**，也排在角色检查前面 —— 和 `/提示词协助模式关闭` 同一个
 * 理由：用户在网页端把线下模式关掉、或者把角色解绑之后，那条会话不能永远
 * 卡在线下模式里出不来。角色捞不到时调用方按会话去关。
 *
 * 补大总结和写待总结都在调用方（offline.js:endOffline）。
 */
function cmdOfflineOff() {
  return { offline: { action: "off" }, log: "快捷指令：关闭线下模式" };
}

/** `/小总结`、`/大总结` —— 手动出一份，不看轮数够不够。 */
function cmdSummary(kind) {
  return {
    offline: { action: kind === "big" ? "sumbig" : "sumsmall" },
    log: `快捷指令：线下${kind === "big" ? "大" : "小"}总结`,
  };
}

/* ---------------- 入口 ---------------- */

/**
 * 试着把一条消息当指令处理掉。
 *
 * **只有 COMMANDS 里那几条、外加防相亲的暗号算指令**，认不出的返回 null
 * 交给模型 —— 调用方拦消息看的是 isCommandMessage，和这里判断的是同一套
 * （parseCommand 优先、暗号其次），不会走岔。
 *
 * @param {string} text 对方发来的原文（还没进合并队列）
 * @param {{role: object, sessionId: string, forget: (id: string) => void}} ctx
 *   role 是这条线当前绑定的角色；forget 用来丢内存历史（传 imessage.js 的
 *   forgetHistory，避免这个文件反向 import 造成循环依赖）
 * @returns {{text?: string, log?: string, image?: {prompt: string, ref: string},
 *            memory?: {kind: string}, reroll?: {userText: string},
 *            restart?: boolean, igtick?: boolean, promptMode?: "on"|"off",
 *            offline?: {action: "on"|"off"|"sumsmall"|"sumbig"}}|null}
 *   null = 这不是指令（包括认不出的 `/xxx`），照常交给模型。
 *   带 `image` 的要由调用方去出图并发送；带 `memory` 的要由调用方去跑总结；
 *   带 `reroll` 的要由调用方拿那条 userText 重新生成一次；带 `igtick` 的要由
 *   调用方去把 IG 互动队列跑完；带 `promptMode` 的要由调用方去开/关那张表
 *   （promptmode.js，按「线路 + 会话」存，这个文件拿不到那两个 id）；
 *   带 `offline` 的要由调用方去开/关线下、或者出一份总结（offline.js，
 *   那条链要 buildPrompt，不能从这里调）；
 *   带 `restart` 的要由调用方**先把 text 发出去、再**让进程退出
 *   （这个文件不能 import imessage.js / memoryhooks.js / igrun.js / offline.js）
 */
export function tryCommand(text, ctx) {
  const cmd = parseCommand(text);

  // 现读一份配置：两条指令之间可能隔了几分钟，
  // 用户说不定刚在浏览器里改过东西
  const config = loadConfig();

  /*
   * 认不出来的一律当普通聊天，别劫走 —— 网址和路径也是 `/` 开头的。
   *
   * 只有防相亲的暗号是例外：它允许不带 `/`，parseCommand 按设计认不出。
   * 放在这儿（真指令解析失败之后）也就定下了撞车时谁赢：**真指令赢**。
   * 用户要是把暗号设成了 `del`，那条暗号从此不会触发，而不是把 `/del`
   * 变成一个开关 —— 一个不小心把上下文清光的暗号，代价比认不出暗号大得多。
   */
  if (!cmd) {
    if (isPrivacyToggle(text, config.privacy?.trigger)) return cmdPrivacy(config);
    return null;
  }

  if (cmd.name === "help") return { text: buildHelp(config.privacy?.trigger) };

  const role = ctx.role;

  // 重启和角色无关（重的是整个服务），所以和 /help 一样排在角色检查前面 ——
  // 恰恰是「这条号码没绑角色」这种配置弄拧了的时候最需要重启一下
  if (cmd.name === "restart") return cmdRestart();

  // 同理：跑的是整条队列（所有角色的），和当前这条号码绑没绑角色无关
  if (cmd.name === "igtick") return cmdIgTick();

  // 关协助模式也排在角色检查前面：协助模式是按会话存的，跟角色绑没绑无关。
  // 万一开着协助模式的时候用户把角色解绑了，这条还得能把人捞出来
  if (cmd.name === "promptmodeoff") return cmdPromptModeOff();

  // 关线下同理（照 promptmodeoff）：线下开着的时候用户去网页端解绑了角色，
  // 这条还得能把他从线下模式里放出来
  if (cmd.name === "offlineoff") return cmdOfflineOff();

  // 剩下几条都要角色：切模型是往角色上写的，而 /clear、/del、/重roll 要的
  // 会话 ID 本身就是「角色名 + 线路号码」拼出来的（sessions.js 的 sessionIdFor），
  // 没角色就没有会话可清；/memory、/diary 的记忆库也是按角色分的。
  // /help 和 /restart 在上面就返回了，没角色也能用。
  if (!role) {
    return { text: "⚠️ 这条号码还没绑定角色，快捷指令用不了。" };
  }

  const args = { ...cmd, config, role, sessionId: ctx.sessionId, forget: ctx.forget };
  switch (cmd.name) {
    case "clear":
      return cmdClear(args);
    case "del":
      return cmdDel(args);
    case "provider":
      return cmdProvider(args);
    case "model":
      return cmdModel(args);
    case "image":
      return cmdImage(args);
    case "memory":
      return cmdMemory(args);
    case "diary":
      return cmdDiary(args);
    case "reroll":
      return cmdReroll(args);
    case "promptmode":
      return cmdPromptMode(args);
    case "offlineon":
      return cmdOfflineOn(args);
    case "sumsmall":
      return cmdSummary("small");
    case "sumbig":
      return cmdSummary("big");
    default:
      return { text: buildHelp(config.privacy?.trigger) };
  }
}