/**
 * 规范化用的小工具。
 *
 * 这几个原本长在 config.js 里，预设（preset.js）和世界书（worldinfo.js）
 * 也要用同一套规则，抽出来共用 —— 让它们反过来 import config.js 会绕成
 * 循环依赖（config.js 本来就要 import 它们）。
 *
 * 规则一个字都没改，尤其是 pickId：normalizeConfig 的幂等性靠它。
 */

/** 非字符串一律回落，避免 undefined 漏进配置文件。 */
export const str = (value, fallback = "") =>
  typeof value === "string" ? value : fallback;

/** 数字取整并夹在区间内。解析不出数字就用 fallback。 */
export function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * 小数版的 clampInt，给温度、Top P 这类参数用。
 * 同样是「解析不出来就回落」，只是不取整。
 */
export function clampNum(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 取一个不重复的 id。
 * 有就用原来的（保住前端的 React key 和各处的引用），
 * 没有才按位置生成——不用时间戳，这样 normalize 两遍结果一致。
 */
export function pickId(raw, used, prefix, index) {
  let id = str(raw).trim() || `${prefix}-${index + 1}`;
  let n = 2;
  while (used.has(id)) id = `${prefix}-${index + 1}-${n++}`;
  used.add(id);
  return id;
}