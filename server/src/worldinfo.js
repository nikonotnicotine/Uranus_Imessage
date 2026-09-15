/**
 * 世界书（SillyTavern 里的 World Info / Lorebook）。
 *
 * 一本书 = 一堆条目。每条要么「常驻」（每轮都注入），要么靠关键词触发 ——
 * 对方提到「王都」，才把王都那段设定塞进提示词。这样一份庞大的设定集不用
 * 整本发给模型，只发这轮用得上的那几条。
 *
 * 生效范围：global 的书对所有角色生效，其余的靠 role.worldBookRefs 指定。
 *
 * 刻意不做 token 预算上限 —— 用户明确说不要。控制体量靠 scanDepth 和
 * maxRecursion，以及自己少写点常驻条目。
 */

import { clampInt, pickId, str } from "./normalize.js";

/** 条目能插在哪。 */
export const POSITIONS = ["before", "after", "depth"];

/** depth 插入时这条消息的身份。 */
const DEPTH_ROLES = ["system", "user", "assistant"];

function normalizeKeys(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const key = str(raw).trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function normalizeEntry(raw, id) {
  const position = POSITIONS.includes(raw?.position) ? raw.position : "before";
  return {
    id,
    name: str(raw?.name),
    enabled: raw?.enabled === undefined ? true : Boolean(raw.enabled),
    constant: Boolean(raw?.constant),
    keys: normalizeKeys(raw?.keys),
    secondaryKeys: normalizeKeys(raw?.secondaryKeys),
    caseSensitive: Boolean(raw?.caseSensitive),
    matchWholeWords: Boolean(raw?.matchWholeWords),
    position,
    // 倒数第几条之前。1 = 紧贴最后一条上文（也就是对方刚发的那句）之前
    depth: clampInt(raw?.depth, 4, 1, 200),
    depthRole: DEPTH_ROLES.includes(raw?.depthRole) ? raw.depthRole : "system",
    // 同一位置内的排序，小的在前。负数也允许，方便把某条永远顶到最前
    order: clampInt(raw?.order, 100, -1000, 1000),
    excludeRecursion: Boolean(raw?.excludeRecursion),
    content: str(raw?.content),
  };
}

export function normalizeWorldBook(input, id) {
  const used = new Set();
  return {
    id,
    name: str(input?.name),
    enabled: input?.enabled === undefined ? true : Boolean(input.enabled),
    global: Boolean(input?.global),
    // 扫最近几条消息。0 = 只扫对方刚发的那一条也没意义，所以下限给 1
    scanDepth: clampInt(input?.scanDepth, 4, 1, 100),
    recursive: input?.recursive === undefined ? true : Boolean(input.recursive),
    // 递归层数上限，防「A 触发 B、B 又触发 A」这类死循环
    maxRecursion: clampInt(input?.maxRecursion, 3, 1, 10),
    entries: (Array.isArray(input?.entries) ? input.entries : []).map((e, i) =>
      normalizeEntry(e, pickId(e?.id, used, "we", i))
    ),
  };
}

export function normalizeWorldBooks(list) {
  const used = new Set();
  return (Array.isArray(list) ? list : []).map((b, i) =>
    normalizeWorldBook(b, pickId(b?.id, used, "wb", i))
  );
}

/** 世界书在界面和日志里的显示名。 */
export function worldBookLabel(book) {
  return book?.name?.trim() || "未命名世界书";
}

export function worldEntryLabel(entry) {
  return entry?.name?.trim() || entry?.keys?.[0] || "未命名条目";
}

/**
 * 这个角色这轮要用哪几本书：global 的 ∪ 它自己引用的，两边都要 enabled。
 *
 * 引用了已删除的书不清理、也不报错（和模型引用失效一个道理），界面上标红。
 *
 * 前端 client/src/labels.js 有一份同样规则的实现（那边不能 import 服务端代码），
 * 改规则时两处一起改。
 */
export function worldBooksFor(config, role) {
  const books = config?.worldBooks ?? [];
  const refs = new Set(Array.isArray(role?.worldBookRefs) ? role.worldBookRefs : []);
  return books.filter((b) => b?.enabled && (b.global || refs.has(b.id)));
}

/**
 * 关键词是不是出现在扫描文本里。
 *
 * matchWholeWords 只对纯 ASCII 关键词有意义 —— 中文没有词边界，\b 在
 * 「王都」两侧根本不成立，硬套上去会一条都匹配不到。所以关键词里含非 ASCII
 * 时直接退回子串匹配。
 */
function hits(haystack, key, { caseSensitive, matchWholeWords }) {
  const text = caseSensitive ? haystack : haystack.toLowerCase();
  const needle = caseSensitive ? key : key.toLowerCase();
  if (!needle) return false;

  if (matchWholeWords && /^[\x20-\x7e]+$/.test(needle)) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    try {
      return new RegExp(`\\b${escaped}\\b`, caseSensitive ? "" : "i").test(haystack);
    } catch {
      return text.includes(needle); // 理论上到不了，兜一下
    }
  }
  return text.includes(needle);
}

/** 这条条目在给定文本里是否被触发。constant 的不看文本，直接算命中。 */
function triggered(entry, haystack) {
  if (entry.constant) return true;
  if (!entry.keys.length) return false; // 既不常驻又没关键词 = 永远不触发

  const opts = {
    caseSensitive: entry.caseSensitive,
    matchWholeWords: entry.matchWholeWords,
  };
  if (!entry.keys.some((k) => hits(haystack, k, opts))) return false;
  // 次要关键词非空时是「且」：主关键词命中，还得再命中这里的任一个
  if (entry.secondaryKeys.length) {
    return entry.secondaryKeys.some((k) => hits(haystack, k, opts));
  }
  return true;
}

/**
 * 扫描 + 递归，算出这轮要注入的内容。
 *
 * @param {object[]} books worldBooksFor 的结果
 * @param {{role: string, content: string}[]} history 裁剪后的上文（含对方刚发的那条）
 * @returns {{
 *   before: string,
 *   after: string,
 *   depths: Map<string, {depth: number, role: string, content: string}>,
 *   hitNames: string[],
 * }} depths 的 key 是 `${depth}:${role}`，同一个深度+身份的条目合并成一条消息
 */
export function activate(books, history) {
  const list = Array.isArray(books) ? books : [];
  const hist = Array.isArray(history) ? history : [];

  /** @type {{entry: object, book: object}[]} */
  const chosen = [];
  const taken = new Set(); // 已命中的条目，key = `${bookId}/${entryId}`

  for (const book of list) {
    const pool = book.entries.filter((e) => e.enabled);
    if (!pool.length) continue;

    // 每本书按自己的深度取最近几条消息拼成扫描文本
    const scanned = hist.slice(-book.scanDepth).map((m) => m?.content ?? "");
    let haystack = scanned.join("\n");

    // 第一轮：拿真实对话扫
    let fresh = [];
    for (const entry of pool) {
      if (!triggered(entry, haystack)) continue;
      taken.add(`${book.id}/${entry.id}`);
      chosen.push({ entry, book });
      fresh.push(entry);
    }

    // 递归：把新命中条目的内容也当成可扫描的文本，看看会不会再触发别的条目
    let round = 0;
    while (book.recursive && fresh.length && round < book.maxRecursion) {
      round += 1;
      // 只有参与递归的条目的内容才追加进扫描文本
      const added = fresh.filter((e) => !e.excludeRecursion).map((e) => e.content);
      if (!added.length) break;
      haystack += `\n${added.join("\n")}`;

      fresh = [];
      for (const entry of pool) {
        if (taken.has(`${book.id}/${entry.id}`)) continue;
        // excludeRecursion 的条目不接受「被别人的内容触发」，只认真实对话
        if (entry.excludeRecursion) continue;
        if (!triggered(entry, haystack)) continue;
        taken.add(`${book.id}/${entry.id}`);
        chosen.push({ entry, book });
        fresh.push(entry);
      }
    }
  }

  // 同一位置内按 order 升序；order 相同时保持命中顺序（sort 是稳定的）
  const sorted = chosen
    .map((c, i) => ({ ...c, i }))
    .sort((a, b) => a.entry.order - b.entry.order || a.i - b.i);

  const before = [];
  const after = [];
  /** @type {Map<string, {depth: number, role: string, content: string[]}>} */
  const bucket = new Map();

  for (const { entry } of sorted) {
    if (!entry.content.trim()) continue; // 空内容的条目命中了也没东西可插
    if (entry.position === "after") {
      after.push(entry.content);
    } else if (entry.position === "depth") {
      const key = `${entry.depth}:${entry.depthRole}`;
      if (!bucket.has(key)) {
        bucket.set(key, { depth: entry.depth, role: entry.depthRole, content: [] });
      }
      bucket.get(key).content.push(entry.content);
    } else {
      before.push(entry.content);
    }
  }

  const depths = new Map();
  for (const [key, v] of bucket) {
    depths.set(key, { depth: v.depth, role: v.role, content: v.content.join("\n") });
  }

  return {
    before: before.join("\n"),
    after: after.join("\n"),
    depths,
    hitNames: sorted.map(({ entry }) => worldEntryLabel(entry)),
  };
}