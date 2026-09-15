/**
 * 「最后一次发给模型的完整提示词」这一份快照。
 *
 * 这段代码原来住在 imessage.js 里（`notePrompt` + `lastPrompt`）。搬出来只有
 * 一个原因：**线下模式那条链不能 import imessage.js**（会成环 —— imessage.js
 * 要调线下的生成，线下又要来记提示词），而它和 iMessage 那条链一样需要记这一份
 * ——「上下文」面板底下那个「最后一次发给模型的提示词」是排查「它为什么这么回」
 * 的唯一入口，线下剧情比线上更需要它（预设更长、世界书更多）。
 *
 * 只留一份 —— 覆盖式写入，不按会话攒。看上一次发了什么就够排查提示词问题了，
 * 而按会话留一份的话，挂十几个号码时这些消息数组会一直占着内存
 * （有人部署在 2H2G 的 VPS 上）。
 *
 * 这个文件不 import 任何业务模块，所以谁都可以安全地 import 它。
 */

let lastPrompt = null;

/**
 * 记下这一次组装好的提示词。
 * messages 已经是最终形态（人设 + 变量替换 + 裁剪过的上文），
 * 就是 llm.js 即将 JSON.stringify 发出去的那个数组。
 */
export function notePrompt(meta, messages) {
  lastPrompt = {
    at: new Date().toISOString(),
    ...meta,
    // 拷一份：history 里的对象后面还会被复用，不能让快照跟着变
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    chars: messages.reduce((n, m) => n + (m.content?.length ?? 0), 0),
  };
}

/** 前端「原始提示词」面板读这个。没发过消息时返回 null。 */
export function getLastPrompt() {
  return lastPrompt;
}
