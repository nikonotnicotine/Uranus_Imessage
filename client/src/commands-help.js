/**
 * 快捷指令一览 —— 右上角那张表的数据。
 *
 * **这是 server/src/commands.js 里 buildHelp() 那张表的镜像。**
 * 改了那边记得改这边：两张表说的不一样，用户会信错一张，然后对着一条
 * 根本不存在的指令怀疑自己手机坏了。
 *
 * 为什么不直接把后端那张纯文本发过来渲染：那份是给 iMessage 看的
 * （等宽对齐、一行一句），塞进网页只能当 `<pre>` 用，搜不了、排不了版、
 * 也没法把用法和说明分成两列。这里要的是结构化的几行，不是一坨字。
 *
 * `cmd` 是主写法，`alt` 是别的写法（别名、简写、带参数的形式），
 * `desc` 是一句人话。`group` 决定在表里分到哪一段。
 */

/**
 * 暗号的兜底写法，只在配置还没从后端拉回来的那一瞬间派得上用场。
 * 正主是 server/src/config.js 里的 DEFAULT_PRIVACY_TRIGGER，改那边记得改这边。
 */
export const DEFAULT_PRIVACY_TRIGGER = "/防相亲";

/** 表格分段。顺序就是画出来的顺序。 */
export const COMMAND_GROUPS = [
  { key: "context", label: "上下文" },
  { key: "model", label: "模型" },
  { key: "make", label: "生成" },
  { key: "offline", label: "线下模式" },
  { key: "system", label: "系统" },
];

export const COMMAND_ROWS = [
  {
    group: "context",
    cmd: "/clear 1",
    alt: ["/clear1", "/clear[1]"],
    desc: "清除最近 1 轮对话。不带数字按 1 轮算。",
  },
  {
    group: "context",
    cmd: "/del",
    alt: [],
    desc: "清空当前对话的全部上下文。",
  },
  {
    group: "model",
    cmd: "/provider",
    alt: [],
    desc: "列出所有服务商源，标出当前用的那个。",
  },
  {
    group: "model",
    cmd: "/provider1",
    alt: [],
    desc: "切到第 1 个服务商源。模型从它已开启的 LLM 里随机挑一个。",
  },
  {
    group: "model",
    cmd: "/model",
    alt: [],
    desc: "列出当前服务商下的模型，标出当前用的那个。",
  },
  {
    group: "model",
    cmd: "/model1",
    alt: [],
    desc: "切到第 1 个模型。",
  },
  {
    group: "make",
    cmd: "/image 描述",
    alt: ["/image 小猫 描述", "/image[小猫] 描述"],
    desc: "直接出一张图，不经过 AI、也不进上下文。带参考图名字就是图生图；名字里有空格用方括号框住。",
  },
  {
    group: "make",
    cmd: "/memory",
    alt: ["/记忆"],
    desc: "立刻把攒着的聊天记录总结成一条记忆。",
  },
  {
    group: "make",
    cmd: "/diary",
    alt: ["/日记"],
    desc: "立刻写一篇日记。",
  },
  {
    group: "make",
    cmd: "/重roll",
    alt: ["/reroll"],
    desc: "对刚才那条回复不满意，重新生成一次。",
  },
  {
    group: "make",
    cmd: "/立即触发评论",
    alt: ["/igtick"],
    desc: "Instagram 排着的赞和评论不用再等，全部立刻跑完。",
  },
  {
    group: "system",
    cmd: "/提示词协助模式",
    alt: ["/promptmode"],
    desc: "角色让位，换一个提示词工程师帮你排查人设/世界书/预设。这期间不会有任何角色扮演，说的话也不进角色的上下文。",
  },
  {
    group: "system",
    cmd: "/提示词协助模式关闭",
    alt: ["/promptmodeoff"],
    desc: "结束协助，这期间的对话一并丢掉，回到正常聊天。",
  },
  {
    group: "offline",
    cmd: "/开启线下",
    alt: ["/offlineon"],
    desc: "开始演一段线下剧情。开着的时候这个角色的线上功能全部停用（主动消息、消息格式与功能都不生效）。演的是和「对话框」分区同一段剧情，手机上开的头能在网页里接着演。",
  },
  {
    group: "offline",
    cmd: "/小总结",
    alt: ["/sumsmall"],
    desc: "立刻把还没总结过的那几轮剧情概括成一份小总结，不用等轮数攒够。",
  },
  {
    group: "offline",
    cmd: "/大总结",
    alt: ["/sumbig"],
    desc: "立刻把攒着的几份小总结合并成一份大总结。",
  },
  {
    group: "offline",
    cmd: "/关闭线下",
    alt: ["/offlineoff"],
    desc: "结束这段剧情：补一次大总结，把小/大总结写进这个角色的待总结（记忆库），然后回归线上功能。",
  },
  {
    group: "system",
    cmd: "/重启",
    alt: ["/restart"],
    desc: "重启整个服务。",
  },
  {
    /*
     * 这一行的 cmd 是**用户自己设的暗号**，不是写死的字符串 ——
     * 表里其余几条都是常量，只有它要从配置里现读（见 commands.jsx）。
     */
    group: "system",
    key: "privacy",
    cmd: null,
    alt: [],
    desc: "开关防相亲。开着的时候系统发言一条都不发出来（指令确认、报错、记忆和日记的总结）。这个词带不带 / 都认。",
  },
  {
    group: "system",
    cmd: "/help",
    alt: [],
    desc: "在 iMessage 里把这张表发一遍。",
  },
];

/**
 * 后端认得的全部命令词 —— server/src/commands.js 里 COMMANDS + COMMAND_ALIASES
 * 那两张表拼起来。只给下面那个撞车检查用。
 */
const COMMAND_WORDS = new Set([
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
  "日记",
  "记忆",
  "重roll",
  "重启",
  "立即触发评论",
  "提示词协助模式",
  "提示词协助模式关闭",
  "开启线下",
  "关闭线下",
  "小总结",
  "大总结",
]);

/**
 * 暗号会不会被真指令吃掉；撞上了返回那个命令词，没撞返回空串。
 *
 * 后端 tryCommand 是**先**认真指令、认不出来才比对暗号的，所以撞车时真指令赢。
 * 也就是说暗号设成 `del` 的后果不是「/del 从此变成一个开关」，而是这条暗号
 * 再也不会触发 —— 一个静悄悄不生效的防相亲比任何报错都糟，所以在网页上
 * 提前说一声。（顺带一提，那个优先级是有意的：一个手滑就把上下文清空的
 * 暗号，代价比认不出暗号大得多。）
 *
 * 判断比后端宽松，宁可多提醒一次：把可能的数字参数削掉再查表。
 */
export function commandCollision(trigger) {
  let s = String(trigger ?? "").trim().toLowerCase();
  // 中文输入法打出来的是全角斜杠，后端 normalize 会换成半角，这里一并认
  if (s.startsWith("/") || s.startsWith("／")) s = s.slice(1);
  // `/clear1`、`/clear 1`、`/clear[1]` 和 `/clear` 是同一条指令
  const word = s.trim().replace(/[\s[(（]*\d+[\])）]*$/, "").trim();
  // /image 后面跟的是自由文本，整段都算参数，所以只看第一个词
  if (word.split(/\s+/)[0] === "image") return "image";
  return COMMAND_WORDS.has(word) ? word : "";
}
