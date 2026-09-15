/**
 * 消息延迟计算 —— 与前端 client/src/delay.js 保持同一套逻辑。
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

/**
 * 将一条消息按分隔符拆成多条气泡，返回每条气泡的文本及相对延迟。
 * @param {string} message
 * @param {object} chat config
 * @returns {{text:string, delay:number}[]}
 */
export function splitBubbles(message, chat) {
  const separator = chat?.separator ?? "$";
  const delayConfig = chat?.delay ?? {};
  const segments = (message ?? "").split(separator);
  return segments
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((text) => ({ text, delay: computeDelay(text, delayConfig) }));
}

/** 供 bridge 使用：等待指定秒数 */
export function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}
