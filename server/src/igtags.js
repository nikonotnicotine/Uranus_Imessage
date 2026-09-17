/**
 * IG 标签解析：从模型的一段输出里认出「发帖 / 发快拍 / 评论」。
 *
 * ── 认哪些标签 ──
 *
 *   [post:文案]        发一条帖子，方括号里的内容**就是配文**
 *   [story:文案]       发一条快拍，同上
 *   [image:画面描述]   要生成的图。帖子和快拍都能带
 *   [comment:评论内容] 评论 / 回复
 *
 * 中文写法一律认（`[帖子:]`/`[快拍:]`/`[图片:]`/`[评论:]`），全角方括号和全角冒号
 * 也认 —— 和 media.js:MEDIA_TAG 同一个理由：用户改过的提示词原文会留着，
 * 模型顺手写中文的情况实测很常见，多认几个不花钱。
 *
 * **没有 `[caption:]`** —— 用户明确废弃了它。配文就在 post/story 体内。
 *
 * ── 三条容易搞错的规则 ──
 *
 * 1. 只有 `[image:]` 没有 post/story → **发快拍，不带文字**。用户定的默认。
 * 2. 方括号**体内**的分隔符（`chat.separator`，默认 `$`）一律换成英文逗号。
 *    括号外的照旧当气泡分隔符 —— 用户原话：「不限格式，只要是 [] 里面的
 *    一律改成英文逗号」。
 * 3. 一条输出里可以同时有 IG 标签和普通文字：`[comment:…]$下次带你去吃`
 *    前半段发 IG、后半段当私聊短信。没有任何 IG 标签 = 纯私聊，压根不进这里。
 *
 * ── 为什么不并进 media.js ──
 *
 * `splitMedia` 的产物是「一条条要发出去的 iMessage 气泡」，而 IG 标签产出的是
 * 「要落到 data/instagram/ 的内容」，两条完全不同的去向。而且 `[image:]` 在两边
 * 都有意义：私聊里是发图，IG 里是配图 —— 同一个标签、不同的归属，混在一个
 * 函数里只会让两边都得判「我现在是哪个场景」。
 */

import { xmlBlockRanges } from "./websearch.js";

/**
 * 一条 IG 标签。
 *
 * post/story 各自最多认到 2000 字（配文可以很长），image 描述同样 2000，
 * comment 300 —— IG 的评论上限本来就短，给模型一个隐含的长度上限也好。
 *
 * 标签名**不分大小写**（`gi`），和 media.js:MEDIA_TAG 一个口径：内置预设里
 * 写的就是大写开头的 `[Image:…]`，两边认的必须是同一套，否则同一条输出在
 * 私聊里能出图、在 IG 那条路上却认不出来。
 */
const POST_PART = "[[［]\\s*(?:post|帖子|发帖)\\s*[:：]\\s*(?<post>[^\\]］]{0,2000}?)\\s*[\\]］]";
const STORY_PART =
  "[[［]\\s*(?:story|快拍|限时动态)\\s*[:：]\\s*(?<story>[^\\]］]{0,2000}?)\\s*[\\]］]";
const IMAGE_PART =
  "[[［]\\s*(?:image|图片|生成图片|生图|画图)\\s*[:：]\\s*(?<image>[^\\]］]{1,2000}?)\\s*[\\]］]";
const COMMENT_PART =
  "[[［]\\s*(?:comment|评论|回复评论)\\s*[:：]\\s*(?<comment>[^\\]］]{1,300}?)\\s*[\\]］]";
// 空的 [post] / [story]：模型偶尔会写成不带冒号的裸标签。当成「发一条空配文的」
const BARE_PART = "[[［]\\s*(?<bare>post|story|帖子|快拍)\\s*[\\]］]";

const IG_TAG = new RegExp(
  [POST_PART, STORY_PART, IMAGE_PART, COMMENT_PART, BARE_PART].join("|"),
  "gi"
);

/**
 * 除了 `[image:]` 之外的 IG 标签。
 *
 * 为什么要单独有这一个：`[image:]` 在**私聊**里也有意义（media.js:MEDIA_TAG，
 * 角色给用户发一张图），两边用的是同一个标签名。要是拿 `hasIgTag` 当「这段
 * 输出该不该走 IG 链路」的判据，那所有开了 IG 的角色发张自拍都会被劫到
 * Instagram 上去 —— 一个已经在用的功能就这么坏了。
 *
 * 所以路由判据用这个：只有明确写了 post / story / comment 才算「这是 IG 的事」。
 * 光一个 `[image:]` 的归属交给 igrun.js:igRouteFor 按角色的生图开关决定。
 */
const IG_PUBLISH_TAG = new RegExp([POST_PART, STORY_PART, COMMENT_PART, BARE_PART].join("|"), "gi");

/** 这段文字里，`re` 在 xml 块之外命中过没有。 */
function matchesOutsideXml(text, re) {
  const src = String(text ?? "");
  if (!src) return false;
  const ranges = xmlBlockRanges(src);
  for (const m of src.matchAll(re)) {
    if (!ranges.some(([a, b]) => m.index >= a && m.index < b)) return true;
  }
  return false;
}

/** 有没有 IG 标签。没有就走原来的纯私聊链路，一个字符都不用改。 */
export function hasIgTag(text) {
  return matchesOutsideXml(text, IG_TAG);
}

/** 有没有**不含歧义**的 IG 标签（post / story / comment，不看 image）。 */
export function hasIgPublishTag(text) {
  return matchesOutsideXml(text, IG_PUBLISH_TAG);
}

/** 有没有 `[image:]`。和上面那个搭着用，判断「只有图、没别的」。 */
export function hasImageTag(text) {
  return matchesOutsideXml(text, new RegExp(IMAGE_PART, "gi"));
}

/**
 * 把分隔符换成英文逗号。
 *
 * 用户的规则是「只要是 [] 里面的一律改成英文逗号」，所以这个函数只在**标签体**
 * 上调用 —— 调用点在 splitIg 里，抠出来的每段内容都过一次。
 *
 * 分隔符可能是正则元字符（`$` 就是），所以要转义。连着好几个分隔符（`$$$`）
 * 收成一个逗号，不然配文里会出现「，，，」。
 */
export function commaSeparators(text, sep) {
  const s = String(sep ?? "").trim();
  const out = String(text ?? "");
  if (!s) return out;
  const esc = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return out
    .replace(new RegExp(`(?:\\s*${esc}\\s*)+`, "g"), "，")
    // 换完可能贴着已有的标点（「好吃，，」），收一下
    .replace(/，{2,}/g, "，")
    .trim();
}

/**
 * 一段模型输出 → { posts, stories, comments, rest }。
 *
 * `rest` 是**去掉所有 IG 标签之后剩下的文字**，原样保留分隔符 —— 它要交给
 * 现有的私聊链路按气泡切开发出去。用户给的第三种输出（评论 + 短信）就靠它。
 *
 * 图片怎么归属：`[image:]` 跟在哪个 post/story 后面就归谁；前面没有任何
 * post/story 的图归到一条**新建的无文字快拍**上（用户定的默认）。一个 post
 * 可以带多张图（IG 支持轮播），连着写几个 `[image:]` 就都归它。
 *
 * @param {string} text 模型的一段输出
 * @param {string} sep  chat.separator，用来把标签体内的分隔符换成逗号
 * @returns {{posts:{caption:string,images:{alt:string}[]}[],
 *            stories:{caption:string,images:{alt:string}[]}[],
 *            comments:string[], rest:string}}
 */
export function splitIg(text, sep) {
  const src = String(text ?? "");
  const posts = [];
  const stories = [];
  const comments = [];
  let rest = "";

  if (!src.trim()) return { posts, stories, comments, rest };

  const ranges = xmlBlockRanges(src);
  const inXml = (at) => ranges.some(([a, b]) => at >= a && at < b);

  /** 最近一个 post/story，`[image:]` 挂到它身上。 */
  let current = null;
  let cursor = 0;

  for (const m of src.matchAll(IG_TAG)) {
    // <thinking> 里复述格式不算数（和 splitMedia 同一条规则）
    if (inXml(m.index)) continue;
    rest += src.slice(cursor, m.index);
    cursor = m.index + m[0].length;

    const g = m.groups ?? {};

    if (g.post !== undefined || g.story !== undefined || g.bare !== undefined) {
      // 标签名认大小写，所以这儿抠出来的可能是 `Story`，判断也得跟着不分大小写
      const isStory =
        g.story !== undefined || (g.bare !== undefined && /story|快拍/i.test(g.bare));
      const body = g.post ?? g.story ?? "";
      current = { caption: commaSeparators(body, sep), images: [] };
      (isStory ? stories : posts).push(current);
      continue;
    }

    if (g.image !== undefined) {
      const alt = commaSeparators(g.image, sep);
      if (!alt) continue;
      if (!current) {
        // 只有图、没有 post/story → 无文字快拍
        current = { caption: "", images: [] };
        stories.push(current);
      }
      current.images.push({ alt });
      continue;
    }

    if (g.comment !== undefined) {
      const t = commaSeparators(g.comment, sep);
      if (t) comments.push(t);
      // 评论**不接受**后面的 [image:] —— IG 的评论发不了图。
      // 置空 current，让紧跟其后的 [image:] 落到一条新快拍上，
      // 而不是莫名其妙塞进上一个帖子
      current = null;
    }
  }

  rest += src.slice(cursor);
  return { posts, stories, comments, rest: rest.trim() };
}

/**
 * 去掉所有 IG 标签，只留文字。
 *
 * 存档和上下文里用 —— 帖子已经落到 data/instagram/ 了，历史里再留一份
 * `[post:…]` 原文只会让模型下一轮跟着复读格式。
 */
export function stripIgTags(text) {
  const src = String(text ?? "");
  if (!src) return "";
  const ranges = xmlBlockRanges(src);
  let out = "";
  let cursor = 0;
  for (const m of src.matchAll(IG_TAG)) {
    if (ranges.some(([a, b]) => m.index >= a && m.index < b)) continue;
    out += src.slice(cursor, m.index);
    cursor = m.index + m[0].length;
  }
  out += src.slice(cursor);
  return out.trim();
}
