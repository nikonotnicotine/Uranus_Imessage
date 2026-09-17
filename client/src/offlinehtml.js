/**
 * 线下剧情里「一条回复」怎么切成块。
 *
 * 用正则渲染状态栏的预设（「神本无相」那类）一条回复里往往塞着好几样东西：
 * 一段 `<style>` + `<div>` 的题头片段、一整份带 `<!doctype html>` 的 widget
 * 网页、再一整份另一个 widget、中间夹着模型写的散文。
 *
 * 以前这些是**整坨**塞进同一个 iframe 的同一个 `<body>`，后果是 widget 自带的
 * `body{display:flex;flex-direction:row}` 和 `font-family` 作用到了所有内容，
 * 题头和散文被挤成并排细条；散文也跟着进了框子，读不出选中、也没法用外面
 * 那套排版。所以这儿先把一条回复切开，让每份完整文档单独一个框子、散文回到
 * 页面上用 React 渲染。
 *
 * splitDocs 是纯字符串的（Node 里能直接 import 验），splitRich 要 DOM。
 */

/**
 * 这段文字里有没有真的 HTML。
 *
 * 用**标签白名单**而不是「见到尖括号就算」：模型的正文里出现
 * `<thinking>`、`<选项>` 这类自造标记太常见了，那些不该把整段话塞进 iframe。
 * 反过来，用户写正则渲染状态栏时用的就是下面这些标签。
 */
export const HTML_TAG =
  /<(?:div|span|table|tr|td|th|thead|tbody|p|ul|ol|li|h[1-6]|section|article|style|img|br|hr|b|i|u|strong|em|code|pre|blockquote|progress|meter|details|summary|font|center|dl|dt|dd)\b[^>]*>/i;

/**
 * 界面上不该出现的**纯控制标记**。
 *
 * 存档改存模型原文之后冒出来的问题（1.0.3）。这类预设里常有一条
 * 「不对 AI 发送多余内容」的 `toHistory` 删除规则，一口气认好几种标签；以前
 * 落盘存的就是过完 `toHistory` 的文本，于是这些标签在**界面上也**跟着消失了
 * —— 靠的是副作用，不是有人真的决定要这么显示。现在存原文，`toUser` 那一路
 * 没有对应渲染规则的就原样露出来。
 *
 * 这里是一张**短黑名单**，不是「白名单之外全收」。差别很要紧：模型吐出
 * `<Chronicle>` 这种标签时，它里面是**正文**（小说题头的章节名），只是碰巧
 * 这份预设没开渲染规则 —— 那用户该看到原始标记，才知道去开哪条规则；收走
 * 等于内容凭空少了一段。所以只收那些**里面的东西本身就不是给人读的**：
 *
 *  - `<snow>` / `<Drama>`：给渲染器用的舞台指示，没规则接手时是噪音。
 *  - `[[伏笔]]…[[/]]`：作者给 AI 的埋线标注，本来就不打算显示。
 *
 * 拿不准的一律不收 —— 少收一个的代价是界面上多一行标记，多收一个的代价是
 * 用户的正文没了。
 */
const STRAY = /<(snow|Drama)\b[^>]*>[\s\S]*?<\/\1\s*>|\[\[[^\]\n]+\]\][\s\S]*?\[\[\/\]\]/gi;

/** 纯控制标记整段收走。其余一个字不动。 */
export function dropStray(text) {
  return String(text ?? "").replace(STRAY, "");
}

/**
 * 「一整份网页」的两种写法：``` ```html 围栏 ``` 里的，和裸的
 * `<!doctype html>…</html>`。围栏是预设作者的习惯（在 SillyTavern 里靠它触发
 * 渲染），到了这儿围栏标记本身不该当正文显示出来。
 */
const DOC_RE =
  /```html\b[^\n]*\r?\n?([\s\S]*?)(?:\r?\n?```|$)|(<!doctype\s+html\b[\s\S]*?<\/html\s*>)/gi;

/** 围栏里的东西是不是一整份文档（不是的话当普通 HTML 片段处理）。 */
const LOOKS_LIKE_DOC = /<!doctype\s+html\b|<html[\s>]/i;

/**
 * 先按「文档边界」切一刀。
 *
 * 必须在 DOM 解析**之前**做：`<template>.innerHTML` 会吃掉 doctype、把
 * `<html>`/`<head>`/`<body>` 三个标签剥掉，完整文档进去就散了。
 *
 * @returns {{kind: "doc"|"raw", text: string}[]} doc 是一整份网页，raw 是其余原文
 */
export function splitDocs(text) {
  const src = String(text ?? "");
  const out = [];
  const push = (kind, s) => {
    if (kind === "doc" || s.trim()) out.push({ kind, text: s });
  };

  let at = 0;
  for (const m of src.matchAll(DOC_RE)) {
    const body = m[1] ?? m[2] ?? "";
    // 围栏里不是整份文档（只是一段 div）→ 当普通片段，连围栏一起丢给 raw
    const isDoc = m[2] !== undefined || LOOKS_LIKE_DOC.test(body);
    push("raw", src.slice(at, m.index));
    if (isDoc) push("doc", body);
    else push("raw", body);
    at = m.index + m[0].length;
  }
  push("raw", src.slice(at));
  return out;
}

/**
 * 把一段没有完整文档的原文按顶层节点分成「HTML 块」和「文字块」。
 *
 * 用 `<template>` 解析：这个上下文不会像 `innerHTML` 到 body 那样把
 * `<style>`/`<meta>` 挪进 head，顶层节点的顺序就是原文顺序。
 * 连续的元素节点攒成一块（一份状态栏的 `<style>` 和 `<div>` 得待在一个框子里），
 * 顶层的非空白文本节点单独成块 —— 那就是模型写的散文。
 */
function splitNodes(chunk, out) {
  const tpl = document.createElement("template");
  tpl.innerHTML = chunk;
  if (!tpl.content.childNodes.length) {
    // 解析不出东西（比如孤立的 <td>，那在任何上下文里都会被剥掉）→ 原样交出去
    out.push({ kind: "html", text: chunk });
    return;
  }

  let buf = "";
  let gap = ""; // 元素之间的空白，跟着下一个元素走，标签间距才不丢
  const flush = () => {
    if (buf.trim()) out.push({ kind: "html", text: buf });
    buf = "";
    gap = "";
  };

  for (const node of tpl.content.childNodes) {
    if (node.nodeType === 3) {
      const v = node.nodeValue ?? "";
      if (!v.trim()) {
        gap += v;
        continue;
      }
      flush();
      // 首尾的换行不要：块和块之间的间距由外面的 gap 管
      out.push({ kind: "text", text: v.trim() });
      continue;
    }
    buf += gap + (node.nodeType === 8 ? `<!--${node.nodeValue}-->` : node.outerHTML);
    gap = "";
  }
  flush();
}

/**
 * 一条回复 → 块列表。
 *
 * `doc` 用块自带的那份文档当 srcdoc（连它自己的 `<head>` 一起），
 * `html` 包进我们那份 srcdoc 骨架，`text` 回到页面上走 React。
 *
 * 最后一步把散文块里的纯控制标记收掉（见 `dropStray`），收空了的块整个不要
 * —— 留个空气泡比留个标记更莫名其妙。调用方多半已经收过一遍了
 * （`offline.jsx` 在算 `text` 时就收），这儿再收一道是为了别的调用方。
 *
 * @returns {{kind: "doc"|"html"|"text", text: string}[]}
 */
export function splitRich(text) {
  const out = [];
  for (const part of splitDocs(text)) {
    if (part.kind === "doc") out.push({ kind: "doc", text: part.text });
    else splitNodes(part.text, out);
  }
  return out
    .map((b) => (b.kind === "text" ? { ...b, text: dropStray(b.text).trim() } : b))
    .filter((b) => b.kind !== "text" || b.text);
}
