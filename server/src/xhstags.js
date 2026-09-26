/**
 * 小红书标签解析。
 *
 * ── 认哪些标签 ──
 *
 *   [小红书:标题|正文]   发一篇笔记。`|` 前是标题、后是正文；没写 `|` 就整段当正文，
 *                        标题从正文里截（见 titleFrom）
 *   [image:画面描述]     紧跟在笔记后面的图都归这篇笔记（小红书一篇最多 18 张，
 *                        我们只认前 9 张 —— 每张都要打一次生图）
 *   [回复:编号:内容]     回评论。**只在回评论那一轮解析**，私聊里写了也不认
 *
 * 英文写法 `[xhs:…]` 一样认，全角方括号和冒号也认 —— 和 igtags.js 同一个理由：
 * 模型顺手写中文 / 全角的情况实测很常见。
 *
 * 回评论**故意不认 `[reply:…]`**：那是引用回复的标签（preset.js 里 quote 那条），
 * 模型在聊天里天天写。借用它的话，回评论那一轮里模型很容易写成引用回复的
 * `[reply:原文]` 形状，两边都对不上。英文只认 `[xhs_reply:编号:内容]`。
 *
 * ── 为什么不用 MCP 的工具调用 ──
 *
 * xiaohongshu-mcp 本身是个 MCP 服务，但我们**不把它的工具注入给模型**：
 * 十几个工具的 schema 每轮都要塞进请求，一个角色一天被叫起来几十次，那就是
 * 几十份白花的 token。模型只写标签，后端认出来再去调 xiaohongshu-mcp 的
 * HTTP 接口（xhsapi.js）—— 和 IG 那套 `[post:]` 一个路子。
 *
 * ── 和 IG 的 [image:] 怎么分 ──
 *
 * 这里只把**跟在 `[小红书:]` 后面**的 `[image:]` 吃掉，别的一律原样留在 `rest`
 * 里，交给后面的 IG 链路 / 私聊发图照旧处理。所以同一轮既发小红书又发 IG
 * 快拍也不会串：`[小红书:…][image:A] [story:…][image:B]` —— A 归小红书，
 * B 留给 igtags.js。
 */

import { commaSeparators } from "./igtags.js";
import { xmlBlockRanges } from "./websearch.js";

/** 一篇笔记最多认几张图。每张都是一次生图调用。 */
export const MAX_IMAGES = 9;

/** 小红书标题上限：20 个「字」，一个中文算 1、两个英文字母算 1（见 titleLength）。 */
export const TITLE_MAX = 20;

/** 正文上限。小红书是 1000 字，留点余量给话题标签。 */
export const BODY_MAX = 900;

const XHS_PART =
  "[[［]\\s*(?:xhs|xiaohongshu|小红书|红书|发小红书)\\s*[:：]\\s*(?<xhs>[^\\]］]{1,2000}?)\\s*[\\]］]";
const IMAGE_PART =
  "[[［]\\s*(?:image|图片|生成图片|生图|画图)\\s*[:：]\\s*(?<image>[^\\]］]{1,2000}?)\\s*[\\]］]";
/** 两个标签之间只许隔空白 —— 隔了文字的 [image:] 就不算这篇笔记的配图了。 */
const GAP = /^\s*$/;

const XHS_TAG = new RegExp(XHS_PART, "gi");
const XHS_OR_IMAGE = new RegExp([XHS_PART, IMAGE_PART].join("|"), "gi");

const REPLY_TAG =
  /[[［]\s*(?:xhs_?reply|回复评论|回复)\s*[:：]?\s*#?(?<no>\d{1,3})\s*[:：]\s*(?<text>[^\]］]{1,500}?)\s*[\]］]/gi;

/** 这段文字在 xml 块之外写没写 `[小红书:]`。 */
export function hasXhsTag(text) {
  const src = String(text ?? "");
  if (!src) return false;
  const ranges = xmlBlockRanges(src);
  for (const m of src.matchAll(XHS_TAG)) {
    if (!ranges.some(([a, b]) => m.index >= a && m.index < b)) return true;
  }
  return false;
}

/**
 * 小红书的标题长度：非 ASCII 算 2、ASCII 算 1，再除以 2 向上取整。
 * 抄的 xiaohongshu-mcp 的 pkg/xhsutil/title.go —— 超了它会直接拒掉整篇。
 */
export function titleLength(s) {
  let bytes = 0;
  for (const ch of String(s ?? "")) {
    // title.go 按 UTF-16 码元数，emoji 这类代理对算两个非 ASCII
    const units = ch.length;
    bytes += ch.codePointAt(0) > 127 ? 2 * units : 1;
  }
  return Math.ceil(bytes / 2);
}

/** 截到 TITLE_MAX 以内。 */
export function clipTitle(s, max = TITLE_MAX) {
  let out = "";
  for (const ch of String(s ?? "").trim()) {
    if (titleLength(out + ch) > max) break;
    out += ch;
  }
  return out.trim();
}

/**
 * 没写 `|` 的时候从正文里取标题：第一句（到第一个句末标点或换行为止），
 * 超长就截。第一句只有一两个字（「啊啊啊！」）也照用 —— 小红书的标题本来就
 * 常是这种。
 */
export function titleFrom(body) {
  const first = String(body ?? "")
    .trim()
    .split(/[\n。！？!?～~]/)[0]
    .trim();
  return clipTitle(first || body);
}

/**
 * 正文里的 `#话题` 抠出来单独给 xiaohongshu-mcp（它会在编辑器里敲 `#` 选联想，
 * 那样发出去才是能点的话题；留在正文里只是一串普通文字）。
 *
 * 只认 `#` 后面紧跟的一段不含空白和标点的字，`#` 后面是空格的不算。
 */
export function takeTopics(body) {
  const topics = [];
  const rest = String(body ?? "")
    .replace(/[#＃]([^\s#＃,，。！？!?、;；:：]{1,20})(?:\[话题\])?[#＃]?/g, (_, t) => {
      if (!topics.includes(t)) topics.push(t);
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return { body: rest, topics: topics.slice(0, 10) };
}

/**
 * 一段模型输出 → { notes, rest }。
 *
 * `rest` 是去掉 `[小红书:]` 和归它的那几个 `[image:]` 之后剩下的文字，分隔符
 * 原样保留，接着交给 IG / 私聊那条路。
 *
 * @returns {{notes:{title:string, body:string, topics:string[], images:{alt:string}[]}[], rest:string}}
 */
export function splitXhs(text, sep) {
  const src = String(text ?? "");
  const notes = [];
  if (!src.trim()) return { notes, rest: "" };

  const ranges = xmlBlockRanges(src);
  const inXml = (at) => ranges.some(([a, b]) => at >= a && at < b);

  let rest = "";
  let cursor = 0;
  /** 最近一篇笔记，以及它的结尾位置 —— 紧挨着它的 [image:] 才归它。 */
  let current = null;
  let currentEnd = -1;

  for (const m of src.matchAll(XHS_OR_IMAGE)) {
    if (inXml(m.index)) continue;
    const g = m.groups ?? {};

    if (g.xhs !== undefined) {
      rest += src.slice(cursor, m.index);
      cursor = m.index + m[0].length;

      const raw = String(g.xhs);
      const bar = raw.search(/[|｜]/);
      const titleRaw = bar >= 0 ? raw.slice(0, bar) : "";
      const bodyRaw = bar >= 0 ? raw.slice(bar + 1) : raw;
      const { body, topics } = takeTopics(commaSeparators(bodyRaw, sep));
      const title = clipTitle(commaSeparators(titleRaw, sep)) || titleFrom(body);
      current = { title, body: body.slice(0, BODY_MAX), topics, images: [] };
      notes.push(current);
      currentEnd = cursor;
      continue;
    }

    // [image:]：只有紧挨着一篇笔记（中间只有空白）的才吃掉
    if (current && GAP.test(src.slice(currentEnd, m.index))) {
      rest += src.slice(cursor, m.index);
      cursor = m.index + m[0].length;
      const alt = commaSeparators(g.image, sep);
      if (alt && current.images.length < MAX_IMAGES) current.images.push({ alt });
      currentEnd = cursor;
      continue;
    }
    // 不归小红书的图：原样留在 rest 里，current 断开
    current = null;
  }

  rest += src.slice(cursor);
  // 标题正文都空的是模型空转
  return { notes: notes.filter((n) => n.title || n.body), rest: rest.trim() };
}

/**
 * 回评论那一轮的输出 → [{no, text}]。
 *
 * 编号是我们在提示词里给每条评论标的（1 起），模型只要写编号，不用抄评论 id。
 * 同一个编号写了两次只认第一次 —— 一条评论回两遍在小红书上很怪。
 */
export function parseReplies(text, sep) {
  const src = String(text ?? "");
  const ranges = xmlBlockRanges(src);
  const out = [];
  const seen = new Set();
  for (const m of src.matchAll(REPLY_TAG)) {
    if (ranges.some(([a, b]) => m.index >= a && m.index < b)) continue;
    const no = Number(m.groups.no);
    const t = commaSeparators(m.groups.text, sep);
    if (!t || seen.has(no)) continue;
    seen.add(no);
    out.push({ no, text: t });
  }
  return out;
}

/** 去掉 `[小红书:]` 标签（存档和上下文用）。 */
export function stripXhsTags(text) {
  return splitXhs(text, "").rest;
}
