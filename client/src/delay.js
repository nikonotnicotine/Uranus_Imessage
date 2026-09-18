/**
 * 消息延迟计算 —— 与后端待接的 iMessage bridge 共用同一套逻辑。
 *
 * 规则：相邻两条气泡之间的延迟（秒）=
 *   字节数 ×（打字速度 + 随机值[randomMin ~ randomMax]）
 * 结果限制在 [clampMin, clampMax]。
 *
 * 随机值取值为随机下限/上限之间均匀分布。
 */

function randBetween(min, max) {
  return min + Math.random() * (max - min);
}

/**
 * 计算一条消息文本的延迟时长（秒）。
 * @param {string} text
 * @param {object} delayConfig
 */
export function computeDelay(text, delayConfig) {
  const {
    typingSpeed = 0.2,
    randomMin = 0.05,
    randomMax = 0.1,
    clampMin = 0.5,
    clampMax = 8,
  } = delayConfig ?? {};

  const len = (text ?? "").length;
  if (len <= 0) return 0;
  const jitter = randBetween(randomMin, randomMax);
  const raw = len * (typingSpeed + jitter);
  return Math.min(clampMax, Math.max(clampMin, raw));
}

/*
 * 强制分隔的切点：**不需要**模型听话也会切开。
 *
 * 为什么会需要这个东西：有些角色就是不吐 `$`，改用逗号句号，或者用
 * `\n\n\n\n` 当段间隔 —— 于是整段话挤成一条巨型气泡，或者一堆空行
 * 拼出一条「气泡」里全是空白。这不是 bug，是提示词没约束住模型的输出习惯，
 * 而提示词是你自己写的、模型也不总照做。
 *
 * 所以这一刀切在**输出**侧：开着的时候，不管格式多随心，一律按这些字符切。
 *
 * 切成什么：逗号、句号、问号、叹号，中英两套；分号冒号顿号也算；
 * 省略号 `…` / `...`；**任意个**换行；**任意个**空格。
 * 「任意个」靠 `+` 保证 —— 连着四个换行只会切一刀，不会切出三条空气泡。
 *
 * 切成一条条**短句**、而不是「一段话」：这是刻意的。你要的就是
 * 「一条一条气泡蹦出来」这个观感，按段落切反而还是大段文字堆在一起。
 *
 * 英文句点一并切，所以小数（3.14）和缩写（Mr.）会被切断 —— 认了，
 * 这是「强制」二字的代价，不想被切就别开这个开关。
 */
const FORCE_BREAK = /[，,。.、；;：:！!？?…\n\r ]+/;

/** 读开关。认布尔和它的字符串形态 —— 手机上改过配置、或者从 JSON 捞回来的都可能。 */
function isForceSplit(chat) {
  const v = chat?.forceSeparator;
  return v === true || v === "true" || v === 1 || v === "1";
}

/*
 * 方括号里的东西一个字都不许切。
 *
 * `[audio_message:我刚刚到家了，累死了]` 是**一整条**要发出去的语音，里面那个
 * 逗号是台词的一部分。照 FORCE_BREAK 硬切的话它会碎成
 * `我刚下班[audio_message` / `我刚刚到家了` / `累死了]看这个` —— 语音发不出来，
 * 半个标记还当文字发给对方了。图片、卡片、点歌、引用、撤回全是一个道理。
 *
 * 所以切之前先把 `[...]` / `［...］` / `【...】` 整段挖出来，切完再原样填回去。
 * 认这三种括号是因为模型中英输入法混着用，媒体标记那条正则（media.js:MEDIA_TAG）
 * 认的也正是这三种。
 *
 * 只吃**一层**、且里面不再出现开括号 —— 嵌套那种（`[audio_message:[whispers] 喂]`）
 * 交给下游的 MEDIA_TAG 去处理，这里的任务只是「别把它切开」，不是替它解析。
 * 不成对的 `[` 压根不匹配，于是退化成按普通文字切，和没有这一层时一样。
 */
const BRACKET_CHUNK = /[[［【][^[\]［］【】]*[\]］】]/g;

/*
 * 占位符两头的哨兵：U+0000。
 *
 * 挑它是因为 FORCE_BREAK 里没有它，模型也几乎不可能真吐一个 NUL 出来，所以
 * 既不会被当成切点、也不会撞上正文里本来就有的字符。写成 \u0000 而不是把那个
 * 字符直接敲进源码 —— 控制字符在编辑器里是隐形的，看不见的东西没法改。
 */
const MARK = "\u0000";

/** 切之前把方括号段换成占位符。 */
function protectBrackets(text) {
  const kept = [];
  const masked = text.replace(BRACKET_CHUNK, (m) => {
    kept.push(m);
    return `${MARK}${kept.length - 1}${MARK}`;
  });
  return { masked, kept };
}

/** 把占位符还原成原来那段方括号内容。 */
function restoreBrackets(text, kept) {
  if (!kept.length) return text;
  return text.replace(new RegExp(MARK + "(\\d+)" + MARK, "g"), (m, i) => kept[Number(i)] ?? m);
}

/**
 * 将一条消息按分隔符拆成多条气泡，返回每条气泡的文本及相对延迟。
 *
 * 默认只按 `chat.separator`（默认 `$`）切，一字不差地尊重模型给的格式。
 * 开了 `chat.forceSeparator` 则改走上面那套强制切点，`separator` 不再参与 ——
 * 那两个是互斥的两条路，不是叠加。
 *
 * @param {string} message
 * @param {object} chat config
 * @returns {{text:string, delay:number}[]}
 */
export function splitBubbles(message, chat) {
  const delayConfig = chat?.delay ?? {};
  const text = message ?? "";
  return forceSegments(text, chat)
    .map((t) => ({ text: t, delay: computeDelay(t, delayConfig) }));
}

/**
 * 切成一条条气泡文本 —— `splitBubbles` 和「改写历史」共用的那一刀。
 *
 * 抽出来是因为两处必须**一模一样**：发出去的是三条气泡、而历史里记的是两条，
 * 那模型下一轮看到的就是一份和实际发生过的事不符的上文。
 */
function forceSegments(text, chat) {
  if (!isForceSplit(chat)) {
    return (text ?? "")
      .split(chat?.separator ?? "$")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  /* 方括号段先挖走，切完填回去 —— 里面的逗号是台词，不是切点 */
  const { masked, kept } = protectBrackets(text ?? "");
  return masked
    .split(FORCE_BREAK)
    .map((s) => restoreBrackets(s, kept).trim())
    .filter((s) => s.length > 0);
}

/**
 * 把一条回复改写成「用 separator 分隔」的样子，用来存进历史和存档。
 *
 * 为什么要这一步：强制分隔只作用在**发出去**那一刻，历史里存的还是模型的原文
 * （「你好呀，我刚刚订到…」那种一整段）。于是模型下一轮看到的上文全是
 * 「原来我上次是这么写的」—— 它照着学，就更不肯吐 `$` 了。开着开关的时候
 * 界面上一条条蹦得好好的，一关掉立刻退回大段文字，正是这个原因。
 *
 * 所以存之前按同一套切点切一遍，再用 `separator` 拼回去：存档里留下的是
 * `你好呀$我刚刚订到$对了$3$14 是圆周率`，和它**实际发出去的那几条**对得上，
 * 也就顺手把上下文喂成了「我说话是用 $ 分隔的」。关掉开关之后这些上文照旧
 * 是干净的，不会反过来污染。
 *
 * 开关没开就原样返回 —— 那时候模型给的 `$` 本来就是它自己写的，不用动。
 *
 * 注意这**不是**无损的：`3.14` 会变成 `3$14`，和发出去的那两条气泡一致。
 * 历史要的就是「和实际发生过的事一致」，不是「还原模型原文」。
 *
 * @param {string} message 模型这一轮的回复原文
 * @param {object} chat config.chat
 * @returns {string} 用 separator 连起来的那一份；开关没开时原样返回
 */
export function normalizeForHistory(message, chat) {
  const text = message ?? "";
  if (!isForceSplit(chat)) return text;
  const sep = chat?.separator || "$";
  const parts = forceSegments(text, chat);
  return parts.length ? parts.join(sep) : text;
}
