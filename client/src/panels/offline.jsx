/*
 * 「线下模式」分区：线下剧情。
 *
 * 这一页和「上下文」是同一个范式（拉后端列表 → publish 到侧栏 → itemId 驱动详情），
 * 但它是**能写的**：这里发的每一句都会真去打模型，落进 data/offline/。
 *
 * 三件事在别处，这一页只是用它们的结果：
 *  - 开关、总结节奏、预设、世界书、API、两张头像 —— 在「角色 → 线下模式」
 *  - 提示词怎么拼、那条「用户选项」条目 —— 在线下那批预设里
 *  - 剧情正文和总结 —— 在 data/offline/，走 /api/offline/*（不碰 config，
 *    所以改剧情不会像 `PUT /api/config` 那样把所有 iMessage 号码踢下线）
 *
 * ── 每个接口都回一整份 state ──
 *
 * 发一句、改一条、隐藏一条、删一条、出一份总结，后端都回完整的
 * `offlineState`（开没开、剧情列表、当前剧情全文、要不要显示选项…）。所以这里
 * 只有一个 `state`，不拼增量 —— 剧情这种「一处改动牵动轮数、总结覆盖范围、
 * 侧栏摘要」的东西，前端各存一份迟早对不上。
 *
 * ── 失败了也要把 state 收下 ──
 *
 * 生成失败时后端回的是 200 + `ok:false` + state。用户那句话**已经落盘了**，
 * 界面上必须立刻看见它，这样点一下「重 roll」就能重来，不用重打一遍。
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  CircleAlert,
  CirclePlay,
  CircleStop,
  Copy,
  Eye,
  EyeOff,
  FileText,
  Loader2,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Send,
  Square,
  Trash2,
} from "lucide-react";

import { roleLabel } from "../labels.js";
import { HTML_TAG, dropStray, splitRich } from "../offlinehtml.js";
import { offlineMediaUrl } from "../offlinemedia.js";
import { useSection } from "../section.jsx";
import { api, apiStream, useConfig } from "../store.jsx";
import { Button, Card, Field, Modal, fmtStamp, inputCls } from "../ui.jsx";

import { LastPromptBody, useLastPrompt } from "./context.jsx";

/** 一轮正文的上限，和 server/src/offlinestore.js:MAX_TURN_CHARS 对齐。 */
const MAX_TURN_CHARS = 20000;

/**
 * 一进来先画多少轮，以及每次往上看再补多少轮。
 *
 * 剧情是从上往下读的，真正在看的永远是末尾那几轮。但一条 HTML 回复就是一个
 * iframe，几百轮一起挂着页面会明显发涩 —— 所以先画最近这些。
 *
 * 早先这里是「一次性展开」：上面挂一个按钮，点了才把更早的全铺出来。问题是
 * 划到顶之后**什么都看不见** —— 那批更早的轮次根本不在 DOM 里，按钮又只有
 * 豆大一个，一下划过去就以为「聊天记录没了」。现在改成往上滚就自动补：
 * 滚到接近顶端时按 TURN_CHUNK 一轮一轮往回加载，滚到哪看到哪。
 */
const SHOW_TURNS = 20;
const TURN_CHUNK = 20;

/** 离顶还有这么多像素就开始往回补 —— 别等真贴到顶，那样一定会先看见一截空白。 */
const NEAR_TOP_PX = 600;

/**
 * 「还算贴着底」的容差。超过这个距离就认为用户是自己翻上去看旧内容的，
 * 流进来的字不再把视口往下拽。
 *
 * 120px 大约是三四行正文：留这么宽是因为字是一个 token 一个 token 到的，
 * 钉底之后内容还会继续长高，判定跑在长高之后 —— 容差太小的话「明明贴着底」
 * 会被当成「已经翻上去了」，钉底当场失效。
 */
const STICK_PX = 120;

/**
 * 手一碰（滑动 / 滚轮）之后，这么久之内不自动钉底。
 *
 * 光靠上面那个距离阈值不够：划了 80px 还没够 STICK_PX，下一个 token 就把画面
 * 按回去了 —— 手机上就是「划一下被弹回来一下」，用户报的那个「输出的时候
 * 上滑不了」。所以只要手真的在动，这段时间里钉底整个让开。
 *
 * 700ms 是为了盖住**惯性滑动**：手指离开屏幕之后页面还在自己滑，那会儿把它
 * 按回底部和在手指底下按回去一样难受。惯性停下来时最后一次 scroll 会重算
 * 那道闸，所以这个窗口过期之后该不该跟着滚已经是对的了。
 */
const TOUCH_HOLD_MS = 700;

/**
 * 渲染块的高度保险丝 —— **不是**版式上的上限。
 *
 * 框子报多高就画多高，正则渲染出来的东西要像页面自己的一部分那样铺开，不该
 * 套在一个会滚的小框里：widget 自己的圆角、玻璃底、留白就是它的设计，外面
 * 再夹一道边框和滚动条，看着就成了「网页里嵌了个网页」。以前压到 1600 的
 * 后果是状态栏和选项这种几千像素高的块**天天在滚**，用户得先展开才看得全。
 *
 * 留这个数只为挡病态值：万一撞上「body 高度跟着 viewport 走」的写法，两边
 * 能互相顶着往上长。SIZE_SCRIPT 那边有 40 次上报封顶兜着，这里再加一道，
 * 正常内容永远碰不到。
 */
const MAX_H = 20000;

/**
 * 框子里那个播放键的四张脸。
 *
 * 框子是 srcdoc 起的独立文档，lucide 那套 React 组件进不去，所以照
 * lucide 的 24×24 viewBox 把 path 抄进来，外面和里面才是同一个图标。
 * 对应 `CirclePlay` / `LoaderCircle` / `CircleStop` / `CircleAlert`。
 */
const VOICE_ICONS = {
  idle: '<circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/>',
  loading: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
  playing: '<circle cx="12" cy="12" r="10"/><rect x="9" y="9" width="6" height="6" rx="1"/>',
  error:
    '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
};

/**
 * 状态栏那个 iframe 里找「」台词、给每句挂一个播放键的那段脚本。
 *
 * 为什么要塞进 iframe：框子是**跨源**的（`sandbox="allow-scripts"` 不带
 * `allow-same-origin`），外面拿不到里面的 DOM，所以状态栏里的台词**必须是
 * 框子自己找、自己挂按钮**。
 *
 * 文本节点用 TreeWalker 走一遍，**跳过 script/style**，按文档顺序拼成一条
 * "哪一段是台词" 的列表；只给不在标签里的「」挂按钮，`<style>` 里写着
 * 「」也不会把按钮糊到样式表上。
 *
 * ── 框子只管按钮，不管声音 ──
 *
 * 合成要凭据、播放要 blob: 地址，这两样跨源框子都碰不到（opaque origin
 * 读不了父页面 `createObjectURL` 出来的地址）。所以它只做三件事：
 *
 *  1. 挂好按钮之后把每句台词 post 出去（`offline-voice-ready`）
 *  2. 点一下就 post 一条 `offline-voice`，带下标，不带别的
 *  3. 收到父窗口的 `offline-voice-state` 就换图标
 *
 * 父窗口那边**一个字都不读框子内部** —— 跨源 window 只放行 `postMessage`
 * 这类白名单属性，读别的会直接抛 SecurityError（`?.` 拦不住，因为
 * `contentWindow` 本身不是 null）。以前那份代码就是这么卡在「合成中」的。
 */
const VOICE_SCRIPT = `(function(){
  var TOKEN = window.__OFFLINE_VOICE_TOKEN__;
  var ICONS = ${JSON.stringify(VOICE_ICONS)};
  var TIPS = { idle: "念这一句", loading: "合成中…", playing: "在念了 —— 点一下停", error: "没念出来，点一下重来" };
  var re = /「([^「」]+)」/g;
  var targets = [];
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: function(n){
      var p = n.parentNode;
      if (p && (p.nodeName === "SCRIPT" || p.nodeName === "STYLE")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  for (var n = walker.nextNode(); n; n = walker.nextNode()) {
    re.lastIndex = 0;
    var m;
    while ((m = re.exec(n.nodeValue))) {
      var s = m[1].trim();
      if (s) targets.push({ node: n, index: m.index, len: m[0].length, text: s });
    }
  }

  var buttons = [];
  var texts = [];

  function paint(btn, state, message){
    var key = ICONS[state] ? state : "idle";
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"' +
      (key === "loading" ? ' class="offv-spin"' : '') + '>' + ICONS[key] + '</svg>';
    btn.style.color = key === "error" ? "#b45309" : key === "playing" ? "#15803d" : "#71717a";
    btn.title = message || TIPS[key];
    btn.setAttribute("aria-label", TIPS[key]);
  }

  /* 从后往前改，前面的下标才不会被拆出来的新节点顶掉 */
  targets.reverse().forEach(function(t, i) {
    var node = t.node;
    /*
     * splitText(n) 留下的是**前半截**，返回的是后半截。所以切两刀之后
     * seg 才是「…」那一段，node 是它前面的字、第二刀返回的是它后面的字 ——
     * 三段都得留着，只把 seg 换成去了括号的台词。
     */
    var seg = node.splitText(t.index);
    seg.splitText(t.len);
    seg.nodeValue = t.text;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.style.cssText = "display:inline-flex;align-items:center;justify-content:center;vertical-align:-3px;margin:0 2px;padding:0;border:0;background:transparent;line-height:0;cursor:pointer";
    seg.parentNode.insertBefore(btn, seg.nextSibling);
    var idx = targets.length - 1 - i;
    buttons[idx] = btn;
    texts[idx] = t.text;
    paint(btn, "idle");
    btn.addEventListener("click", function(){
      window.parent.postMessage({ kind: "offline-voice", token: TOKEN, index: idx }, "*");
    });
  });

  window.addEventListener("message", function(e){
    if (e.source !== window.parent) return;
    var d = e.data;
    if (!d || typeof d !== "object" || d.token !== TOKEN) return;
    if (d.kind !== "offline-voice-state") return;
    var btn = buttons[d.index];
    if (btn) paint(btn, d.state, d.message);
  });

  /* 键挂完了。台词一起带出去，外面就不用再问框子要 */
  window.parent.postMessage({ kind: "offline-voice-ready", token: TOKEN, texts: texts }, "*");
})();`;

/**
 * 框子把自己多高报出来。
 *
 * 跨源的是**父窗口读框子**，框子读自己的 DOM 一直是允许的 —— 所以高度不用靠
 * 外面猜，量完 `postMessage` 出去就行。
 *
 * 量的是 `body.scrollHeight` 而不是 `documentElement` 的：后者至少和 iframe
 * 一样高（viewport 撑着），内容比框子矮时量出来永远等于当前高度，框子就再也
 * 收不回去了。`html,body{margin:0}` 是我们那份骨架保证的；widget 自带的文档
 * 有 padding 也算在 body 里，一样对。
 *
 * 图片、字体加载完尺寸还会变，所以 load + ResizeObserver + 两个补发都留着。
 * 上报次数封顶：万一撞上「body 高度跟着 viewport 变」的写法，别刷成死循环。
 */
const SIZE_SCRIPT = `(function(){
  var TOKEN = window.__OFFLINE_VOICE_TOKEN__;
  var last = -1, left = 40;
  function tell(){
    if (left-- <= 0 || !document.body) return;
    var h = document.body.scrollHeight;
    if (Math.abs(h - last) < 2) return;
    last = h;
    window.parent.postMessage({ kind: "offline-size", token: TOKEN, height: h }, "*");
  }
  tell();
  window.addEventListener("load", tell);
  if (window.ResizeObserver) new ResizeObserver(tell).observe(document.body);
  setTimeout(tell, 120); setTimeout(tell, 600); setTimeout(tell, 2000);
})();`;

/**
 * 给框子垫一份**不抛的** localStorage / sessionStorage。
 *
 * 沙箱框子没有 `allow-same-origin`，于是**光是读 `window.localStorage` 这个
 * 属性**就当场抛 `SecurityError`（不是 getItem 抛，是取属性就抛）。而酒馆那边
 * 的 widget 拿 localStorage 当主题总线是常规写法 —— 「喵喵选择器」开头就是
 * `applyTheme()`，里面裸调 `localStorage.getItem('mortal_theme_color')`，
 * 没人接。一抛，整段 `<script>` 就地终止，**后面渲染选项的代码再也跑不到**：
 * 外壳（`<details>` 和「剧情分支」那行字）是静态 HTML 所以照样画出来，
 * 里面一个选项都没有。看着就像「框子出来了但没字」。
 *
 * 这里在 widget 自己的脚本之前先用 `Object.defineProperty` 把这两个属性盖成
 * 一份内存实现。为什么不是 try/catch 兜 —— 兜不了，那是**别人写的** widget，
 * 我们不改它一个字节（预设是拿来互相分享的，改了下次导入又是原样）。
 *
 * 存的东西**活不过这个框子**：每次重挂就是一份新的空存储。这正合适 ——
 * widget 想记的是「用户选的主题色」这类偏好，拿不到就走它自己的默认值；
 * 而真让它写进本页面的 localStorage 反倒是污染，几十个框子抢同一个键。
 */
const STORAGE_SHIM = `(function(){
  function make(){
    var m = Object.create(null);
    var api = {
      getItem: function(k){ k = String(k); return k in m ? m[k] : null; },
      setItem: function(k, v){ m[String(k)] = String(v); },
      removeItem: function(k){ delete m[String(k)]; },
      clear: function(){ m = Object.create(null); },
      key: function(i){ var ks = Object.keys(m); return i >= 0 && i < ks.length ? ks[i] : null; }
    };
    Object.defineProperty(api, "length", { get: function(){ return Object.keys(m).length; } });
    return api;
  }
  ["localStorage", "sessionStorage"].forEach(function(name){
    /* 读一下就知道这个框子拦不拦；不拦（将来真开了 same-origin）就别多事 */
    try { void window[name]; return; } catch (e) {}
    try {
      Object.defineProperty(window, name, { value: make(), configurable: true });
    } catch (e) {}
  });
})();`;

/**
 * 框子里要挂的脚本（存储替身 + 播放键 + 报高度），带上认人用的 token。
 *
 * `STORAGE_SHIM` 必须排在最前面，而且这份 hooks 得插在 widget 自己的
 * `<script>` **之前** —— 它要垫的就是那些脚本。
 */
function hooks(token) {
  return `<script>window.__OFFLINE_VOICE_TOKEN__=${JSON.stringify(
    token
  )};${STORAGE_SHIM}${VOICE_SCRIPT}${SIZE_SCRIPT}</script>`;
}

/**
 * 包一份能塞进 srcdoc 的完整文档 —— 给「HTML 片段」用的骨架。
 *
 * 字色写死成和页面同一档，不继承外面的 CSS —— iframe 是另一个文档，
 * tailwind 那套变量进不去。转圈那个 keyframes 同理，得在这儿自带一份。
 *
 * `white-space` 用的是**默认的 normal**：散文已经在 splitRich 那儿分出去、
 * 回到页面上用 React 渲染了，进到这儿的只剩标签群。以前为了散文留着
 * `pre-wrap`，代价是标签之间的换行缩进全照原样显示出来。
 *
 * 带了状态栏里的「」播放键那段脚本。自动朗读**不在这儿决定** —— 框子只管
 * 挂键，要不要替用户按一遍由父窗口收到 `ready` 之后说了算。
 */
function htmlDoc(inner, token = "") {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:transparent}
body{color:#18181b;font:14px/1.7 ui-sans-serif,system-ui,"Segoe UI","Microsoft YaHei",sans-serif;word-break:break-word}
table{border-collapse:collapse}
th,td{border:1px solid #e4e4e7;padding:4px 8px}
img{max-width:100%}
a{color:#18181b}
@keyframes offv-spin{to{transform:rotate(360deg)}}
.offv-spin{animation:offv-spin 1s linear infinite}
</style></head><body>${inner}${hooks(token)}</body></html>`;
}

/**
 * 一整份 widget 网页 → srcdoc。
 *
 * **它自己的 `<head>`、`<style>`、`body` 样式一个字都不改** —— 那是人家的设计，
 * 我们只往末尾补两段脚本和转圈用的 keyframes。以前把这种文档和别的内容一起
 * 塞进我们的骨架里，它的 `body{display:flex}` 就把同一个框子里的题头和散文
 * 全挤成了并排细条。
 */
function docWithHooks(doc, token = "") {
  const extra = `<style>@keyframes offv-spin{to{transform:rotate(360deg)}}.offv-spin{animation:offv-spin 1s linear infinite}</style>${hooks(
    token
  )}`;
  const at = doc.toLowerCase().lastIndexOf("</body>");
  const tail = at === -1 ? doc + extra : doc.slice(0, at) + extra + doc.slice(at);
  return withShim(tail);
}

/**
 * 存储替身插到**文档最前面**。
 *
 * `hooks()` 那一份是挂在 `</body>` 前的 —— 播放键要等 DOM 齐了才好挂、高度也
 * 得等内容画完才好量，所以它必须靠后。可存储替身要垫的正是 widget 自己那些
 * `<script>`，插晚了就白垫：脚本早在它之前跑完（并且已经抛完了）。
 *
 * 插在 `<head>` 后面第一个位置。没有 `<head>` 就退到 `<html>` 之后，
 * 连 `<html>` 都没有（不该发生，进这儿的都是完整文档）就直接顶在最前面 ——
 * 顶在 doctype 前会让文档掉进 quirks mode，所以那种情况宁可不插。
 */
function withShim(doc) {
  const shim = `<script>${STORAGE_SHIM}</script>`;
  const head = doc.match(/<head\b[^>]*>/i);
  if (head) return doc.slice(0, head.index + head[0].length) + shim + doc.slice(head.index + head[0].length);
  const html = doc.match(/<html\b[^>]*>/i);
  if (html) return doc.slice(0, html.index + html[0].length) + shim + doc.slice(html.index + html[0].length);
  return doc;
}

/**
 * 正则渲染出来的 HTML。
 *
 * **`sandbox="allow-scripts"`，但没有 `allow-same-origin`** —— 一份预设、一本
 * 世界书是可以互相分享、从别人那儿导入的，而这个页面上挂着 API 密钥和 Photon
 * 凭据。不开 `allow-same-origin`，框子就还是**跨源**的：拿不到父页面的 DOM、
 * localStorage、也读不到那份 config，`postMessage` 是它唯一能往外说话的口子。
 * 两个都开才叫漏（那样脚本能直接摸到父页面），只开脚本是不漏的。
 *
 * 里面跑的就是 `VOICE_SCRIPT` 那一段 —— 状态栏里的「」得靠它自己找、自己挂
 * 播放键（外面跨文档看不见里面的 DOM）。它能做的只有「说一句我要这句」，
 * 合成和凭据都在父窗口这边。
 *
 * 高度由框子自己量出来报过来（`SIZE_SCRIPT`）—— 跨源拦的是父窗口读框子，
 * 框子读自己一直是允许的。报多少画多少，不裁、不加边框，让它看着就是页面的
 * 一部分（`MAX_H` 只是挡病态值的保险丝）。
 */
function HtmlBlock({ html, doc: docHtml, roleKey, turnId, auto, onVoiceError }) {
  // 框子报过来的内容高度，0 = 还没报（用下面那个初始值兜着）
  const [size, setSize] = useState(0);
  const box = useRef(null);
  // 每条状态栏一个随机 token：页面上可能同时挂着好几个框子，认人用
  const token = useMemo(
    () => `v${turnId}-${Math.random().toString(36).slice(2, 8)}`,
    [turnId]
  );
  // srcDoc 只在挂载时读一次（下面 useMemo 空依赖）—— 重建会把里面的滚动位置
  // 和已经合成的音频一起丢掉
  const doc = useMemo(
    () => (docHtml ? docWithHooks(docHtml, token) : htmlDoc(html, token)),
    []
  );

  const busyRef = useRef(new Set());
  const urlsRef = useRef([]);
  // 音频建在**父窗口**：跨源框子读不了这边 createObjectURL 出来的 blob: 地址
  const audiosRef = useRef(new Map());
  // 框子 ready 时一起带出来的台词表，省得再去问它（问也问不到）
  const textsRef = useRef([]);

  /**
   * 往框子里说话的唯一出口。
   *
   * `postMessage` 是跨源 window 白名单里的属性，读它是允许的；读别的
   * （比如以前那句 `contentWindow.__offlineVoice`）会当场抛 SecurityError。
   * 目标 origin 只能写 `"*"` —— opaque origin 指不出来 —— 所以消息里除了
   * token 和播放状态什么都不带。
   */
  const post = useCallback(
    (msg) => {
      box.current?.contentWindow?.postMessage({ ...msg, token }, "*");
    },
    [token]
  );

  const paint = useCallback(
    (index, state, message) => post({ kind: "offline-voice-state", index, state, message }),
    [post]
  );

  /** 播一句，顺手把「浏览器不让响」这种拒绝也变成看得见的状态。 */
  const start = useCallback(
    (audio, index) => {
      const p = audio.play();
      if (p && typeof p.catch === "function") {
        p.catch(() => paint(index, "error", "浏览器没让它响 —— 在页面上点一下再试"));
      }
    },
    [paint]
  );

  /**
   * 框子里点了播放键。
   *
   * 已经合成过就是播/停；没有就合成一句，手点的直接出声，自动朗读那一路
   * （`play: false`）合成完停在空闲图标上等人点 —— 和 `VoiceLine` 一个规矩。
   */
  const call = useCallback(
    async (index, { play = true } = {}) => {
      const text = textsRef.current[index];
      if (!text) return;

      const had = audiosRef.current.get(index);
      if (had) {
        if (had.paused) start(had, index);
        else had.pause();
        return;
      }
      if (busyRef.current.has(index)) return;
      busyRef.current.add(index);
      paint(index, "loading");
      try {
        const r = await api(`/api/offline/${encodeURIComponent(roleKey)}/voice`, {
          method: "POST",
          body: { text },
        });
        if (!r?.ok || !r.base64) throw new Error(r?.error || "没合成出来");
        const bin = atob(r.base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
        const url = URL.createObjectURL(
          new Blob([bytes], { type: r.mimeType || "audio/mpeg" })
        );
        urlsRef.current.push(url);
        const audio = new Audio(url);
        audio.onplay = () => paint(index, "playing");
        audio.onpause = () => paint(index, "idle");
        audio.onended = () => paint(index, "idle");
        audio.onerror = () => paint(index, "error", "这份音频播不了，点一下重来");
        audiosRef.current.set(index, audio);
        if (play) start(audio, index);
        else paint(index, "idle");
      } catch (e) {
        const msg = String(e?.message ?? e);
        // 框子里那个键变红，外加页面顶上那条黄字 —— 以前这两样都没有，
        // 错误只是变成一个没人接的 rejected promise
        paint(index, "error", msg);
        onVoiceError?.(msg);
      } finally {
        busyRef.current.delete(index);
      }
    },
    [roleKey, onVoiceError, paint, start]
  );

  /* 这一条不在了：停掉还在响的，blob 一起收掉 */
  useEffect(
    () => () => {
      audiosRef.current.forEach((a) => a.pause());
      audiosRef.current.clear();
      urlsRef.current.forEach((u) => URL.revokeObjectURL(u));
      urlsRef.current = [];
    },
    []
  );

  /*
   * 自动朗读。台词表是框子 ready 时带出来的，所以没收到 ready 之前
   * `textsRef` 是空的 —— `pullAll` 会直接返回、**不置位**，等 ready 到了
   * 再补一次。`auto` 是懒亮的（上一轮还在演的时候 false，演完变 true），
   * 所以两个方向都得接上：ready 可能早于 auto，也可能晚于它。
   */
  const pulledRef = useRef(false);
  const pullAll = useCallback(() => {
    if (pulledRef.current || !textsRef.current.length) return;
    pulledRef.current = true;
    textsRef.current.forEach((_, i) => call(i, { play: false }));
  }, [call]);

  useEffect(() => {
    function onMessage(e) {
      const d = e.data;
      if (!d || typeof d !== "object" || d.token !== token) return;
      if (box.current && e.source !== box.current.contentWindow) return;
      if (d.kind === "offline-voice-ready") {
        textsRef.current = Array.isArray(d.texts) ? d.texts : [];
        if (auto) pullAll();
      }
      if (d.kind === "offline-size") setSize(Number(d.height) || 0);
      if (d.kind === "offline-voice") call(d.index);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [token, call, auto, pullAll]);

  /* ready 早于「auto 亮起来」的那一路：进来补按一次 */
  useEffect(() => {
    if (auto) pullAll();
  }, [auto, pullAll]);

  /*
   * 报过来的高度加 2px：差一个像素的舍入就够让框子里冒出一条滚动条。
   * 还没报到就先给 240 —— 和以前那个写死的值一样，免得刚挂上时跳一下。
   */
  const height = size ? Math.min(Math.max(size + 2, 48), MAX_H) : 240;

  return (
    // 没有边框、没有底色：widget 自带的卡片样式就是它该有的样子，外面再包一层
    // 就成了框里套框。iframe 默认 display:inline，底下会多出一条基线缝，block 掉
    <iframe
      ref={box}
      // 只放行脚本：状态栏里的「」得自己挂播放键。**同源访问仍然被拦着** ——
      // 框子里碰不到外面这个页面，也就碰不到挂在它上面的密钥
      sandbox="allow-scripts"
      title="渲染结果"
      srcDoc={doc}
      scrolling="no"
      className="block w-full border-0 bg-transparent"
      style={{ height }}
    />
  );
}

/** 一个头像位：有图画图，没图画首字母。 */
function Avatar({ file, name }) {
  const url = offlineMediaUrl(file);
  const initial = String(name ?? "").trim().slice(0, 1) || "?";
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden border border-line bg-sunken">
      {url ? (
        <img src={url} alt="" className="h-full w-full object-cover" />
      ) : (
        <span className="text-meta text-ink-faint">{initial}</span>
      )}
    </span>
  );
}

/**
 * 要念的台词用**「」**（日语那对括号）圈起来，别的引号一律不念。
 *
 * 为什么不用中文引号：写对话的时候 “…” 到处都是 —— 引别人的话、引书名、
 * 强调一个词，模型也爱用。挑「」当标记，是因为中文台词里几乎不会自然出现它，
 * 一旦出现就一定是「这句要念」。
 *
 * 配对的括号里允许换行（一段台词可以跨行），但**不许嵌套** ——
 * 「甲「乙」丙」按最外层切，里面那对当普通文字。展开时用一个
 * 非贪婪的捕获组就够用了，不用手写状态机。
 */
const VOICE_SEGMENT = /「([^「」]+)」/g;

/**
 * 把一段正文切成「念的」和「不念的」两种片段。
 *
 * @returns {{spoken: boolean, text: string}[]} 按出现顺序排好，空片段已经滤掉
 */
function splitVoiceSegments(text) {
  const out = [];
  const src = String(text ?? "");
  let last = 0;
  VOICE_SEGMENT.lastIndex = 0;
  for (let m = VOICE_SEGMENT.exec(src); m; m = VOICE_SEGMENT.exec(src)) {
    if (m.index > last) out.push({ spoken: false, text: src.slice(last, m.index) });
    const line = m[1].trim();
    // 空的「」不当台词，原样留着，免得凭空少一对括号
    if (line) out.push({ spoken: true, text: line });
    else out.push({ spoken: false, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ spoken: false, text: src.slice(last) });
  return out;
}

/**
 * 一句「」台词 + 右边那个小播放键。
 *
 * **点一下才合成** —— 不点就不打 TTS，也就不花钱。合成一次之后缓存在
 * `urlRef` 上，再点直接播，不重复请求。
 *
 * 自动朗读走的是同一个 `fetchOnce`，但**合成完不自动出声**：图标停在空闲
 * 那个 ⊳ 上等人点。演剧情时界面自己出声多半不是用户想要的，
 * 「自动朗读」在用户那儿指的是「别让我一个个点」，不是「替我放声音」。
 *
 * base64 转 blob 而不是直接塞 `data:` URL：一句话的音频几十上百 KB，
 * 塞进 src 会让这串 base64 一直挂在 DOM 上。
 */
function VoiceLine({ roleKey, text, auto, onError }) {
  const [status, setStatus] = useState("idle"); // idle | loading | ready | error
  const [playing, setPlaying] = useState(false);
  const [note, setNote] = useState("");
  const urlRef = useRef("");
  const audioRef = useRef(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      audioRef.current?.pause();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = "";
    };
  }, []);

  /** 合成一次并记住。已经有音频就直接返回 true。 */
  const fetchOnce = useCallback(async () => {
    if (urlRef.current) return true;
    setStatus("loading");
    setNote("");
    try {
      const r = await api(`/api/offline/${encodeURIComponent(roleKey)}/voice`, {
        method: "POST",
        body: { text },
      });
      if (!aliveRef.current) return false;
      if (!r?.ok || !r.base64) throw new Error(r?.error || "没合成出来");
      const bin = atob(r.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      urlRef.current = URL.createObjectURL(
        new Blob([bytes], { type: r.mimeType || "audio/mpeg" })
      );
      setStatus("ready");
      return true;
    } catch (e) {
      if (aliveRef.current) {
        setStatus("error");
        setNote(String(e?.message ?? e));
      }
      onError?.(String(e?.message ?? e));
      return false;
    }
  }, [roleKey, text, onError]);

  /* 自动朗读：开了就在这一轮生成完之后合成一句，但不自动出声 */
  useEffect(() => {
    if (auto) fetchOnce();
  }, [auto, fetchOnce]);

  async function play() {
    if (status === "loading") return;
    if (audioRef.current) {
      if (playing) {
        audioRef.current.pause();
        return;
      }
      audioRef.current.play();
      return;
    }
    if (!(await fetchOnce())) return;
    if (!aliveRef.current) return;
    const audio = new Audio(urlRef.current);
    audio.onplay = () => setPlaying(true);
    audio.onpause = () => setPlaying(false);
    audio.onended = () => setPlaying(false);
    // 合成出来的音频坏了（后端回了个空文件之类）也把状态说清楚
    audio.onerror = () => {
      setPlaying(false);
      setStatus("error");
      setNote("这份音频播不了，再点一次重合成。");
    };
    audioRef.current = audio;
    audio.play();
  }

  /*
   * 一个纯图标的小圆键：空闲 ⊳、合成中转圈、在念 ⊡、出错 ⊗。
   *
   * 不带文字 —— 台词本来就在句子中间，多一个「播放/合成中/重播」的标签会
   * 把一段话戳断。状态和错误原文都进 `title` / `aria-label`，鼠标停一下
   * 就能看见；真出错了页面顶上还会有一条黄字。
   */
  const tip = playing
    ? "在念了 —— 点一下停"
    : status === "loading"
      ? "合成中…"
      : status === "error"
        ? note || "没念出来，点一下重来"
        : `${status === "ready" ? "再念一次" : "念这一句"}：${text}`;

  return (
    <span className="inline-flex max-w-full items-baseline gap-1 align-baseline">
      <span className="border-b border-line text-ink">{text}</span>
      <button
        type="button"
        onClick={play}
        title={tip}
        aria-label={tip}
        className={`inline-flex shrink-0 translate-y-[3px] items-center rounded-item transition-colors duration-150 ${
          status === "error"
            ? "text-warn"
            : playing
              ? "text-good"
              : "text-ink-faint hover:text-ink"
        }`}
      >
        {status === "loading" ? (
          <Loader2 size={16} className="animate-spin" />
        ) : playing ? (
          <CircleStop size={16} />
        ) : status === "error" ? (
          <CircleAlert size={16} />
        ) : (
          <CirclePlay size={16} />
        )}
      </button>
    </span>
  );
}

/** 正文里每一句「」都配一个小播放键，其余的照原样显示。 */
function VoiceText({ roleKey, turnId, text, auto, onError }) {
  const parts = useMemo(() => splitVoiceSegments(text), [text]);
  return (
    <>
      {parts.map((p, i) =>
        p.spoken ? (
          <VoiceLine
            key={`${turnId}-${i}`}
            roleKey={roleKey}
            text={p.text}
            auto={auto}
            onError={onError}
          />
        ) : (
          <span key={`${turnId}-${i}`}>{p.text}</span>
        )
      )}
    </>
  );
}

/**
 * 一条气泡。
 *
 * 角色靠左、用户靠右（用户点名的）。三个点里是那三件事：编辑 / 隐藏 / 删除。
 *
 * 显示的是 `display` —— 存档里那份（`content`）过的是「改上下文」那一路正则，
 * 这份是「发出去的」那一路现算的。所以改一条渲染规则，整段剧情立刻跟着变。
 * 但点进编辑框改的是 `content`（原文），和「上下文」面板一个规矩。
 *
 * ── 为什么要 memo ──
 *
 * 一条 HTML 回复就是一个 iframe，几十轮就是几十个框子。外面随便动一下
 * （编辑框里敲一个字）都让整列重走一遍 diff，页面会明显发涩。所以这里
 * 用 `memo` 挡一层，外面那些回调全部 `useCallback` 定住、把 `turn.id`
 * 留给这边自己带上 —— 内联箭头函数每次渲染都是新引用，memo 会当场失效。
 */
const Bubble = memo(function Bubble({
  turn,
  mine,
  name,
  avatar,
  busy,
  menuOpen,
  onMenu,
  editing,
  draft,
  onDraft,
  onCommit,
  onCancel,
  onEdit,
  onHide,
  onDrop,
  roleKey,
  auto,
  onVoiceError,
}) {
  /*
   * 角色那侧先把没人接手的自造标记收掉（见 `offlinehtml.js:dropStray`）——
   * 在这儿收而不是只在 splitRich 里收，是因为一条**纯散文**回复里混着
   * `<snow>…</snow>` 时 `HTML_TAG` 认不出 HTML，`blocks` 是 null，
   * 走的是下面那条不切块的老路，光靠 splitRich 兜不住。
   *
   * 你自己打的字不动：那是人写的，尖括号里是什么由你说了算。
   */
  const text = useMemo(() => {
    const raw = turn.display ?? turn.content ?? "";
    return mine ? raw : dropStray(raw).trim();
  }, [mine, turn.display, turn.content]);
  const isHtml = !mine && HTML_TAG.test(text);
  // 台词的播放键只在**角色**那侧挂 —— 你自己打的那条，念它没有意义
  const spoken = !mine;
  /*
   * 带 HTML 的那条才切块（见 offlinehtml.js）：每份完整 widget 单独一个框子、
   * 散文回到页面上走 React。不带 HTML 的走下面那条老路，一个字都没变。
   */
  const blocks = useMemo(() => (isHtml ? splitRich(text) : null), [isHtml, text]);

  return (
    <div className={`flex items-start gap-3 ${mine ? "flex-row-reverse" : ""}`}>
      <Avatar file={avatar} name={name} />

      <div className={`min-w-0 max-w-[min(52rem,88%)] flex-1 ${mine ? "items-end" : ""}`}>
        <div
          className={`flex flex-wrap items-baseline gap-x-2 gap-y-0.5 ${
            mine ? "justify-end" : ""
          }`}
        >
          <span className="text-eyebrow uppercase text-ink-faint">{name}</span>
          {turn.ts && <span className="text-meta text-ink-meta">{fmtStamp(turn.ts)}</span>}
          {turn.hidden && (
            <span className="text-meta text-warn">已隐藏 · 不进下一轮的上下文</span>
          )}
        </div>

        {editing ? (
          <div className="mt-1.5 grid grid-cols-1 gap-2">
            <textarea
              autoFocus
              className={`${inputCls} min-h-[140px] resize-y leading-relaxed`}
              value={draft}
              onChange={(e) => onDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") onCancel();
                // Ctrl/⌘+Enter 保存：正文里要能敲回车换行，所以不能用裸 Enter
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onCommit(turn.id);
              }}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => onCommit(turn.id)} disabled={busy}>
                <Check size={14} /> 保存这条
              </Button>
              <Button variant="ghost" onClick={onCancel} disabled={busy}>
                取消
              </Button>
              <span className="text-meta text-ink-meta">
                {draft.length} 字 · Esc 取消，Ctrl/⌘+Enter 保存 · 改的是模型的原文
              </span>
            </div>
          </div>
        ) : (
          <div
            className={`mt-1.5 border px-3.5 py-3 ${
              /*
               * 不带 widget 的那条按字数量宽（`w-fit`）。以前这儿是撑满整行的，
               * 一句「好」也横着穿过去、停在对面头像底下。
               *
               * 带 widget 的仍旧撑满：里面那些 iframe 是 `w-full`，宽度反过来
               * 靠外面这层给，外面一收缩它就塌回 300px（替换元素的默认宽）。
               *
               * 自己那侧再收一道（`max-w-[34rem]`）—— 你打的字是「说了一句话」，
               * 不该和角色那边整段正文一样宽；`ml-auto` 把它推回右边。
               */
              blocks ? "" : `w-fit ${mine ? "ml-auto max-w-[34rem]" : ""}`
            } ${
              turn.hidden ? "border-dashed border-line opacity-55" : "border-line"
            } ${mine ? "bg-sunken" : "bg-paper"}`}
          >
            {blocks ? (
              <div className="grid grid-cols-1 gap-2.5">
                {blocks.map((b, i) =>
                  b.kind === "text" ? (
                    <p
                      key={i}
                      className="whitespace-pre-wrap break-words text-ui leading-relaxed text-ink-soft"
                    >
                      {spoken ? (
                        <VoiceText
                          roleKey={roleKey}
                          turnId={`${turn.id}#${i}`}
                          text={b.text}
                          auto={auto}
                          onError={onVoiceError}
                        />
                      ) : (
                        b.text
                      )}
                    </p>
                  ) : (
                    <HtmlBlock
                      key={i}
                      html={b.kind === "html" ? b.text : undefined}
                      doc={b.kind === "doc" ? b.text : undefined}
                      roleKey={roleKey}
                      turnId={`${turn.id}#${i}`}
                      auto={spoken && auto}
                      onVoiceError={onVoiceError}
                    />
                  )
                )}
              </div>
            ) : spoken ? (
              <p className="whitespace-pre-wrap break-words text-ui leading-relaxed text-ink-soft">
                <VoiceText
                  roleKey={roleKey}
                  turnId={turn.id}
                  text={text}
                  auto={auto}
                  onError={onVoiceError}
                />
              </p>
            ) : (
              <p className="whitespace-pre-wrap break-words text-ui leading-relaxed text-ink-soft">
                {text}
              </p>
            )}
          </div>
        )}
      </div>

      {/* 三个点。菜单开着谁由外面拿着 —— 两条同时展开会挡住彼此 */}
      {!editing && (
        <div className="relative shrink-0">
          <button
            type="button"
            disabled={busy}
            onClick={() => onMenu(menuOpen ? "" : turn.id)}
            aria-label="这条能做什么"
            aria-expanded={menuOpen}
            className="rounded-item p-1.5 text-ink-faint transition-colors duration-150 hover:bg-sunken hover:text-ink"
          >
            <MoreHorizontal size={16} />
          </button>
          {menuOpen && (
            <div
              className={`absolute top-8 z-20 w-36 border border-line bg-paper py-1 ${
                mine ? "left-0" : "right-0"
              }`}
            >
              <button
                type="button"
                onClick={() => onEdit(turn.id, turn.content ?? "")}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-meta text-ink-soft transition-colors duration-150 hover:bg-sunken hover:text-ink"
              >
                <Pencil size={13} /> 编辑回复
              </button>
              <button
                type="button"
                onClick={() => onHide(turn.id, Boolean(turn.hidden))}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-meta text-ink-soft transition-colors duration-150 hover:bg-sunken hover:text-ink"
              >
                {turn.hidden ? <Eye size={13} /> : <EyeOff size={13} />}
                {turn.hidden ? "取消隐藏" : "隐藏回复"}
              </button>
              <button
                type="button"
                onClick={() => onDrop(turn.id)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-meta text-ink-soft transition-colors duration-150 hover:bg-sunken hover:text-warn"
              >
                <Trash2 size={13} /> 删除回复
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

/** 最后一轮下面那四条选项：可复制，也可以直接发。 */
function ChoiceRow({ options, busy, onSend }) {
  const [copied, setCopied] = useState(-1);

  async function copy(text, i) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(i);
      setTimeout(() => setCopied(-1), 1600);
    } catch {
      /* 剪贴板不可用就算了，用户还能自己选中 */
    }
  }

  return (
    <div className="grid grid-cols-1 gap-2 border-l-2 border-line py-1 pl-3">
      <p className="text-eyebrow uppercase text-ink-faint">我接下来可以</p>
      {options.map((o, i) => (
        <div key={`${i}-${o.slice(0, 8)}`} className="flex items-start gap-2">
          <span className="mt-1.5 shrink-0 text-meta text-ink-meta">{i + 1}</span>
          <p className="min-w-0 flex-1 whitespace-pre-wrap break-words py-1 text-ui leading-relaxed text-ink-soft">
            {o}
          </p>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => copy(o, i)}
              className="inline-flex items-center gap-1 rounded-item px-1.5 py-1 text-meta text-ink-faint transition-colors duration-150 hover:bg-sunken hover:text-ink"
            >
              {copied === i ? <Check size={13} /> : <Copy size={13} />}
              {copied === i ? "复制了" : "复制"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onSend(i + 1)}
              className="inline-flex items-center gap-1 rounded-item px-1.5 py-1 text-meta text-ink-soft transition-colors duration-150 hover:bg-sunken hover:text-ink"
            >
              <Send size={13} /> 就这么做
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/** 一份总结：正文可以直接改，也可以删。 */
function SummaryRow({ summary, busy, onSave, onDrop }) {
  const [draft, setDraft] = useState(summary.text ?? "");
  const [editing, setEditing] = useState(false);

  // 换了一份总结（或者后端改过正文）就把草稿重置。key 用 summary.id，
  // 所以这个 effect 只在同一条被外面改掉时才跑
  useEffect(() => {
    setDraft(summary.text ?? "");
    setEditing(false);
  }, [summary.text]);

  const span =
    summary.to > summary.from ? `第 ${summary.from + 1}-${summary.to} 轮` : "手写";

  return (
    <div className="grid grid-cols-1 gap-2 border border-line bg-paper px-3.5 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-eyebrow uppercase text-ink-faint">
          {summary.kind === "big" ? "大总结" : "小总结"} · {span}
        </span>
        <span className="text-meta text-ink-meta">{summary.ts ? fmtStamp(summary.ts) : ""}</span>
      </div>

      {editing ? (
        <>
          <textarea
            autoFocus
            className={`${inputCls} min-h-[120px] resize-y leading-relaxed`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setDraft(summary.text ?? "");
                setEditing(false);
              }
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSave(draft);
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => onSave(draft)} disabled={busy}>
              <Check size={14} /> 保存
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setDraft(summary.text ?? "");
                setEditing(false);
              }}
              disabled={busy}
            >
              取消
            </Button>
            <span className="text-meta text-ink-meta">
              {draft.length} 字 · Esc 取消，Ctrl/⌘+Enter 保存
            </span>
          </div>
        </>
      ) : (
        <>
          <p className="whitespace-pre-wrap break-words text-ui leading-relaxed text-ink-soft">
            {summary.text}
          </p>
          <div className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              disabled={busy}
              onClick={() => setEditing(true)}
              className="inline-flex items-center gap-1 rounded-item px-1.5 py-1 text-meta text-ink-faint transition-colors duration-150 hover:bg-sunken hover:text-ink"
            >
              <Pencil size={13} /> 改这份
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onDrop}
              className="inline-flex items-center gap-1 rounded-item px-1.5 py-1 text-meta text-ink-faint transition-colors duration-150 hover:bg-sunken hover:text-warn"
            >
              <Trash2 size={13} /> 删掉
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 「结束当前线下模式」的确认框。
 *
 * 这一步是用户点名的那件事：补一次大总结 → 把这条剧情的小/大总结注进记忆库的
 * 待总结 → 回归线上。所以要在按下去之前把这三件事说清楚，尤其是
 * 「注进去的只有总结，原始的每一轮不进去」。
 */
function CloseDialog({ roleName, busy, inject, onInject, onClose, onConfirm }) {
  return (
    <Modal
      title="结束当前线下模式"
      desc={`「${roleName}」演完这一段，回到线上`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            先不结束
          </Button>
          <Button onClick={onConfirm} disabled={busy}>
            {busy ? <RefreshCw size={14} className="animate-spin" /> : <Square size={14} />}
            {busy ? "正在收尾…" : "结束线下"}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4">
        <ol className="grid grid-cols-1 gap-2 border-l-2 border-line py-1.5 pl-3 text-meta leading-relaxed text-ink-soft">
          <li>1. 先补一次大总结（把还没被总结覆盖的那几轮收进去）</li>
          <li>2. 把这条剧情的小/大总结写进记忆库的「待总结」</li>
          <li>3. 关掉线下 —— 主动消息、消息格式与功能那一摞恢复正常</li>
        </ol>

        <label className="flex items-start justify-between gap-4">
          <span className="min-w-0">
            <span className="block text-ui text-ink">写进记忆库</span>
            <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
              进去的<strong className="text-ink-soft">只有总结</strong>
              ，原始的每一轮不进去。演废了一段、不想让角色记住的话，
              把这个关掉再结束。
            </span>
          </span>
          <input
            type="checkbox"
            checked={inject}
            onChange={(e) => onInject(e.target.checked)}
            className="mt-1 shrink-0 accent-ink"
          />
        </label>

        <p className="text-meta leading-relaxed text-ink-faint">
          剧情本身<strong className="text-ink-soft">不会删</strong>
          ，还留在左边的列表里，随时点回来看。想接着演就再开一次线下。
        </p>
      </div>
    </Modal>
  );
}

/** 新剧情 / 改名共用的一个小输入框弹窗。 */
function NameDialog({ title, desc, label, value, onValue, busy, onClose, onConfirm }) {
  return (
    <Modal
      title={title}
      desc={desc}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button onClick={onConfirm} disabled={busy}>
            <Check size={14} /> 确定
          </Button>
        </>
      }
    >
      <Field label={label} hint="留空就用「剧情 N」">
        <input
          autoFocus
          className={inputCls}
          value={value}
          onChange={(e) => onValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onConfirm();
          }}
          placeholder="例如：雨夜的便利店"
        />
      </Field>
    </Modal>
  );
}

/**
 * 总结弹窗。
 *
 * 以前这一摊摊在主页面底下一个 `Fold` 里。演的时候它不是重点，但结束线下
 * 之前一定会来看一眼 —— 那是个「偶尔打开一次」的东西，不该常年占着首屏。
 */
function SummaryDialog({
  summaries,
  busy,
  smallEvery,
  manual,
  onManual,
  onGoto,
  onSummarize,
  onSave,
  onDrop,
  onAdd,
  onClose,
}) {
  return (
    <Modal
      title="总结"
      desc="每几轮攒一份，结束线下时只有这些会写进记忆库"
      maxWidth="max-w-2xl"
      onClose={onClose}
    >
      <div className="grid grid-cols-1 gap-4">
        <p className="text-meta leading-relaxed text-ink-faint">
          节奏在
          <button
            type="button"
            onClick={() => onGoto?.("role")}
            className="link-slide mx-1 text-ink"
          >
            角色 → 线下模式
          </button>
          里调（小总结默认 6 轮，大总结默认关）。这两个按钮是
          <strong className="text-ink-soft">手动来一份</strong>
          ，不看轮数 —— 和手机上发 <code className="font-mono">/小总结</code>{" "}
          <code className="font-mono">/大总结</code> 是同一条路。
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => onSummarize("small")} disabled={busy}>
            出一份小总结
          </Button>
          <Button variant="outline" onClick={() => onSummarize("big")} disabled={busy}>
            出一份大总结
          </Button>
        </div>

        {summaries.length === 0 && (
          <p className="text-meta leading-relaxed text-ink-faint">
            还没有总结。演够 {smallEvery} 轮会自己出一份，也可以现在就手动来一份。
          </p>
        )}

        <div className="grid grid-cols-1 gap-3">
          {summaries.map((s) => (
            <SummaryRow
              key={s.id}
              summary={s}
              busy={busy}
              onSave={(text) => onSave(s.id, text)}
              onDrop={() => onDrop(s.id)}
            />
          ))}
        </div>

        {/* 模型总结得不好的时候自己补一段 */}
        <Field label="自己写一份" hint="不打模型，直接存。和上面那些一样会跟着写进记忆库">
          <textarea
            className={`${inputCls} min-h-[90px] resize-y leading-relaxed`}
            value={manual}
            disabled={busy}
            placeholder="这一段里最该记住的是什么"
            onChange={(e) => onManual(e.target.value)}
          />
        </Field>
        <div>
          <Button onClick={onAdd} disabled={busy || !manual.trim()}>
            <Plus size={14} /> 存这份
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * 最后一次拼好的提示词。
 *
 * 正文整个是「上下文」面板那份（`LastPromptBody`），这边只多一层壳 ——
 * 后端那个槽是**全局一份**，线上线下共用，所以得先说清楚看到的可能是别处
 * 刚发的那一条。认线下的办法：「角色」那栏缀着「（线下）」。
 */
function PromptDialog({ onClose }) {
  const state = useLastPrompt();
  return (
    <Modal
      title="最后一次发给模型的提示词"
      desc="变量替换、人设拼接、上下文截断之后，真正打出去的那份"
      maxWidth="max-w-3xl"
      onClose={onClose}
    >
      <div className="grid grid-cols-1 gap-4">
        <p className="border-l-2 border-line py-1.5 pl-3 text-meta leading-relaxed text-ink-faint">
          这个槽<strong className="text-ink-soft">全局只有一份</strong>
          ，线上线下共用 —— 刚在 iMessage 那边发过消息的话，这里看到的就是那一条。
          看下面「角色」那栏带不带「（线下）」就知道是哪一路。
        </p>
        <LastPromptBody
          {...state}
          empty="还没有记录 —— 关掉这个框演一轮，回来刷新就能看到。"
        />
      </div>
    </Modal>
  );
}

export function OfflinePanel({ onGoto }) {
  const { config } = useConfig();
  // 列表在外壳那 260px 里画（`live: true` 分区），这里只负责拉数据和上报
  const { itemId, publish } = useSection();

  const [rows, setRows] = useState(null); // null = 还在读
  const [listError, setListError] = useState("");
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  // 「停下」按下去之后到那轮真收尾之间的那一小段，按键自己先灰掉
  const [stopping, setStopping] = useState(false);
  /*
   * 正在流进来的那半截正文（`null` = 这会儿没在流）。
   *
   * 只是**给眼睛看的临时字符串**，不进 `state.story.turns` —— 落盘那份由后端
   * 那条 `done` 事件带回来的完整 state 说了算。所以下面渲染它的时候不跑
   * `toUser` 那套正则、不切 HTML widget：半截标签渲不出东西，半条正则规则
   * 匹配出来的更是乱的。收完一眨眼就被正式那条顶掉。
   */
  const [streaming, setStreaming] = useState(null);
  /*
   * 刚发出去、还没等到后端回话的那句自己的话（`null` = 没有）。
   *
   * 和 `streaming` 是一对：那条是角色正在写的，这条是**你刚说的**。
   * 后端是「先把你那句落盘，再去打模型」（server/src/offline.js），落盘到
   * 模型写完之间有几十秒，而这一页只认后端回的整份 state —— 不先在本地画一条，
   * 那几十秒里屏幕上就没有你刚打的字，像是没发出去。
   *
   * 只画给眼睛看，不进 `state.story.turns`。渲染条件是 `busy && pending`：
   * 正式 state 落地和 `busy` 归位是同一次 render（都在 `run` 的同一段同步代码里），
   * 所以不会出现「正式那条和这条同时在屏幕上」的重影。
   *
   * 显示的是**你打的原文**，落盘那份过了 userInput 正则 —— 两者可能差几个字，
   * 正式 state 一到就被顶掉，不值得为这个在前端再跑一遍正则。
   */
  const [pending, setPending] = useState(null);

  const [input, setInput] = useState("");
  const [menuKey, setMenuKey] = useState("");
  const [editKey, setEditKey] = useState("");
  const [draft, setDraft] = useState("");
  // 编辑框里的内容再存一份在 ref 里：`commitEdit` 要读它，但不能因此把 `draft`
  // 写进依赖 —— 那样敲一个字就换一个新回调，下面每条 Bubble 的 memo 全废
  const draftRef = useRef("");

  const [closing, setClosing] = useState(false);
  const [inject, setInject] = useState(true);
  const [naming, setNaming] = useState(""); // "" | "new" | "rename"
  const [nameDraft, setNameDraft] = useState("");
  const [manual, setManual] = useState("");
  const [showSummary, setShowSummary] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  // 往上补了多少轮（只算「更早的那批」，不含 SHOW_TURNS 那份基数）
  const [loadedMore, setLoadedMore] = useState(0);
  /*
   * 「往上补一批」和「补完把滚动位置钉回去」之间传的两样东西。
   *
   * `anchor` 一直指着当前画出来的第一条（由下面那个 callback ref 写）。
   * `nearTop` 只在「这次重渲染是往上补触发的」时才是 {box, mark}，别的原因
   * （换剧情、发了一句、刷新）都是 null —— 那时候不该动滚动位置。
   */
  const nearTop = useRef(null);
  const anchor = useRef(null);

  const bottom = useRef(null);
  // 列表最上面那个空哨兵：滚到它就说明该往回补了
  const topSentinel = useRef(null);
  /*
   * 「现在还该不该跟着往下滚」。
   *
   * 生成期间每来一个 token 都要把视口贴回底部，否则写到第三段就滚出屏幕了。
   * 但**用户自己往上翻的时候不能拽他回来** —— 那就是「输出的时候卡死不能上滑」：
   * 手指往上划一点，下一个 token 立刻把画面按回底部，看着就像页面死了。
   *
   * 存在 ref 里而不是 state：它一秒钟要改好几次（每个 token 一次判定），
   * 用 state 等于每个 token 多一次整页重渲染，而它本身不影响任何一处渲染。
   */
  const stick = useRef(true);
  /*
   * 最后一次「手真的在动」是什么时候（滑动、手指还按着、滚轮）。
   *
   * 上面那道闸是按**距离**判的，而距离要划够 STICK_PX 才翻 —— 划了 80px 的时候
   * 闸还开着，下一个 token 就把画面按回去了。所以再加一条按**时间**的：
   * 手刚碰过，这一会儿谁都别动滚动位置。两条是或的关系，任一条成立就让开。
   */
  const touchedAt = useRef(0);

  const refreshRows = useCallback(async () => {
    try {
      const r = await api("/api/offline");
      setRows(r.roles ?? []);
      setListError("");
    } catch (e) {
      setRows([]);
      setListError(String(e?.message ?? e));
    }
  }, []);

  useEffect(() => {
    refreshRows();
  }, [refreshRows]);

  /*
   * 侧栏那列的内容。角色**一个都不漏**（包括没建过剧情的）—— 少了谁，
   * 用户就找不到地方开第一条。
   */
  const listItems = useMemo(
    () =>
      (rows ?? []).map((r) => ({
        id: r.roleKey,
        label: r.roleName || "未命名角色",
        meta: r.open ? String(r.turnCount) : r.gate ? "—" : "关",
        title: [
          r.roleName || "未命名角色",
          r.gate ? (r.open ? "线下开着" : "线下没开") : "角色那边没允许线下",
          r.storyName ? `${r.storyName} · ${r.turnCount} 轮` : "还没有剧情",
          r.storyCount ? `共 ${r.storyCount} 条剧情` : "",
        ]
          .filter(Boolean)
          .join(" · "),
      })),
    [rows]
  );

  useEffect(() => {
    publish(listItems);
  }, [publish, listItems]);

  /* 跟着 itemId 拉详情（选中态由外壳持有，不在这儿存一份） */
  useEffect(() => {
    let alive = true;
    setState(null);
    setError("");
    setNote("");
    setEditKey("");
    setMenuKey("");
    setInput("");
    setLoadedMore(0);
    setShowSummary(false);
    setShowPrompt(false);
    // 上一个角色那轮要是还在流，半截正文和那条乐观气泡都不能跟着换到这个角色底下
    setStreaming(null);
    setPending(null);
    if (!itemId) return undefined;
    (async () => {
      try {
        const r = await api(`/api/offline/${encodeURIComponent(itemId)}`);
        if (alive) setState(r);
      } catch (e) {
        if (alive) setError(String(e?.message ?? e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [itemId]);

  const row = useMemo(
    () => (rows ?? []).find((r) => r.roleKey === itemId) ?? null,
    [rows, itemId]
  );
  const role = useMemo(
    () => (config.roles ?? []).find((r) => r.id === state?.roleId) ?? null,
    [config.roles, state]
  );

  const story = state?.story ?? null;
  // 布尔而不是 `story` 本身：那份对象每次 setState 都是新引用，拿它当依赖的话
  // 底下那个滚动监听每收一份 state 就要摘一次挂一次
  const hasStory = Boolean(story);
  const turns = story?.turns ?? [];
  const roleName = state?.roleName?.trim() || (role ? roleLabel(role) : "未命名角色");
  const userName = state?.userName?.trim() || "你";
  // 末尾那条助手轮次：只有它能重 roll，也只有它下面挂选项
  const lastAssistant = useMemo(() => {
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      if (turns[i].role === "assistant") return turns[i];
    }
    return null;
  }, [turns]);
  const lastTurn = turns.length ? turns[turns.length - 1] : null;
  /*
   * 「你说了一句，角色还没回」—— 生成失败、被你按停、或者你手动删掉了末尾那条
   * 回复之后，存档就是这个样子。
   *
   * 你那句**已经落盘了**（server/src/offline.js 是先存你这句、再去打模型），
   * 所以这种局面不用重打一遍：`/reroll` 删掉末尾 0 条回复，按同一份上文再生成。
   * 下面那个「再来一次」就挂在这上面。
   */
  const awaiting = lastTurn?.role === "user";

  /**
   * 重新拉一份 state，当「刚那次到底成没成」的判据。
   *
   * 只在**没收到后端回话**时用（流断在半路、请求抛异常）。那种时候屏幕上这份是
   * 旧的，而「你那句落没落盘」只有后端知道 —— 而这件事决定了接下来是该重新生成
   * 还是该把字还回输入框。
   *
   * 回的形状对齐 `/turn` 失败时那份（`ok:false` + 整份 state），调用方两条路共用
   * 一套判断。拉不动（还是断网）就回 `null`：调用方会当「什么都没发生」处理，
   * 也就是把字还回去 —— 宁可多还一次，也别让你重打一遍。
   */
  const resync = useCallback(
    async (when) => {
      if (!when || !itemId) return null;
      try {
        const fresh = await api(`/api/offline/${encodeURIComponent(itemId)}`);
        if (!fresh?.roleKey) return null;
        setState(fresh);
        return { ok: false, ...fresh };
      } catch {
        return null;
      }
    },
    [itemId]
  );

  /**
   * 所有写操作的唯一入口。
   *
   * 后端每次都回一整份 state，所以这里统一收下 —— 包括 `ok:false` 那次
   * （用户那句话已经落盘了，界面得先显示出来，才谈得上「重 roll」）。
   *
   * ── 会生成的那两条走 SSE ──
   *
   * `/turn` 和 `/reroll` 是唯一两条要等模型写字的路。全局开关不是「非流式」时
   * 给它们加 `stream: true`，改走 `apiStream` 边收边显示。**收尾完全一样**：
   * 后端那条 `done` 事件的负载和 JSON 那条路一个字节都不差，所以下面这几行
   * （收 state、判 `ok:false`、`refreshRows`）两条路共用。
   *
   * 改一条、隐藏、删除这些不打模型，照旧走 `api()`。
   *
   * `options.said` 是**你这一轮打的那句原文**，只给这里自己用（不往请求体里带）：
   * 有它就先在屏幕上画一条你的气泡，别让你盯着几十秒的空白等模型。
   */
  const run = useCallback(
    async (path, options = {}) => {
      if (!itemId) return null;
      const { said = null, ...rest } = options;
      const url = `/api/offline/${encodeURIComponent(itemId)}${path}`;
      // 会打模型的那两条。除了「要不要走 SSE」，「要不要重新贴底」也看它
      const generating = rest.method === "POST" && (path === "/turn" || path === "/reroll");
      // 严格等 off 才关掉：认不出的值（老配置、手改坏的）当默认的「跟随模型」
      const wantStream = (config.stream?.mode ?? "auto") !== "off" && generating;

      setBusy(true);
      setError("");
      setNote("");
      if (said) setPending(said);
      if (wantStream) setStreaming("");
      /*
       * 自己动手添的内容要看得见：把「跟着往下滚」重新打开（翻旧剧情会关掉它）。
       *
       * 时间戳也一并清掉 —— 手机上按「发送」那一下本身就是个 touchstart，
       * 而按钮在同一个滚动容器里，不清的话开头 700ms 会白白让开。
       * 刚按下发送的人显然是想看结果的。
       */
      if (generating) {
        stick.current = true;
        touchedAt.current = 0;
      }
      try {
        let r = null;
        if (wantStream) {
          await apiStream(url, {
            body: { ...(rest.body ?? {}), stream: true },
            onEvent: (name, payload) => {
              if (name === "delta") setStreaming((s) => (s ?? "") + (payload?.text ?? ""));
              // 换副 API 了：主 API 吐的那半截作废，它会从头再说一遍
              else if (name === "reset") setStreaming("");
              else if (name === "done" || name === "error") r = payload;
            },
          });
        } else {
          r = await api(url, rest);
        }
        if (r?.roleKey) setState(r);
        if (r?.ok === false) setError(r.error || "这一步没成");
        // 流走完了却一条 done/error 都没收到：管子中途断了（网关超时、断网）。
        // 正式 state 没来，不能默默把那半截留在屏幕上当结果
        if (wantStream && !r) {
          setError("生成中断了 —— 连接断在半路");
          r = await resync(generating);
        }
        refreshRows();
        return r;
      } catch (e) {
        setError(String(e?.message ?? e));
        /*
         * 抛到这儿的有两种，而它们对「你那句话在哪」的含义正好相反：
         * 请求根本没出去（断网、后端没起来）—— 那句只在输入框里；
         * 出去了但读流读断了 —— 后端早把它落盘了。**从这个异常本身分不出是哪种**，
         * 所以去问一次后端。拉回来的那份就是判据：`send()` 靠它决定要不要
         * 把字还回输入框，不然就会出现「存档里有一句，输入框里还有一句」。
         */
        return await resync(generating);
      } finally {
        /*
         * 三个一起归位。`setState(r)` 在上面同一段同步代码里跑过了，React 把这一批
         * 合成一次渲染 —— 所以正式那条气泡出现和这条乐观气泡消失是同一帧，
         * 中间不会闪一下重影。
         */
        setStreaming(null);
        setPending(null);
        setBusy(false);
        setStopping(false);
      }
    },
    [itemId, refreshRows, resync, config.stream?.mode]
  );

  /**
   * 按停正在跑的这一轮。
   *
   * **不走 `run()`** —— 那个会 `setBusy(true)` 再在 `finally` 里放回来，而此刻
   * 真正在跑的是那次 `/turn`，两边的 busy 会打架（按停之后界面反而卡在「生成中」）。
   * 这儿只负责把「停」的请求发出去：界面状态由那次 `/turn` 自己收尾 ——
   * 它会带着「被你按停了」和一整份 state 回来。
   */
  const stopNow = useCallback(async () => {
    if (!itemId) return;
    setStopping(true);
    try {
      const r = await api(`/api/offline/${encodeURIComponent(itemId)}/abort`, { method: "POST" });
      // 已经跑完了才点到（手快点两下的第二下）：说一句就好，不当错误
      if (r?.ok === false) {
        setStopping(false);
        setNote(r.error || "没停下来");
      }
    } catch (e) {
      setStopping(false);
      setNote(`停不下来：${String(e?.message ?? e)}`);
    }
  }, [itemId]);

  /** 当前剧情的 id，每个写操作都显式带上 —— 免得后端那份 currentId 和这边不同步。 */
  const sid = state?.currentId ?? "";
  const q = sid ? `?storyId=${encodeURIComponent(sid)}` : "";

  /*
   * 只画最近这些，更早的那批靠往上滚一批一批补出来。
   *
   * 这里是**计算**而不是 state：`shown` 的条数完全由 `turns.length` 和
   * `loadedMore` 决定，多存一份只会多一个对不上的机会。
   * 封顶在 `turns.length` 上，所以「补到底了」不需要另开一个标志位。
   *
   * 位置必须在下面那几个 effect **之前** —— `skipped` 是 `const`，它在
   * 副作用里被读到时还没初始化的话，整个面板会白屏（TDZ，不是 undefined）。
   */
  const skipped = Math.max(0, turns.length - SHOW_TURNS - loadedMore);
  const shown = skipped ? turns.slice(skipped) : turns;

  /* 换了一条剧情就收回去，别把上一条补出来的几十轮带过来 */
  useEffect(() => {
    setLoadedMore(0);
    anchor.current = null;
    // 新开一条剧情从底部看起，上一条翻到一半的状态不带过来
    stick.current = true;
    // 切剧情那一下点击也算「手碰过」，不清的话新剧情开头不会滚到底
    touchedAt.current = 0;
  }, [sid]);

  /*
   * 新一轮落地之后滚到底。剧情是从上往下读的，不像 iMessage 那种倒序。
   *
   * 这里也要看那两道闸，原因和流式那边一样、而且更容易被忽略：生成期间翻上去
   * 看旧剧情，最后正式 state 落地时 `turns.length` 变了，这个 effect 会把人
   * 一把拽回底部 —— 前面拦住了每个 token，却在最后一下破功。
   *
   * 刚进一条剧情那次（length 0 → N）不受影响：换 sid 时两道闸都是重置过的。
   */
  useEffect(() => {
    if (!turns.length) return;
    if (Date.now() - touchedAt.current < TOUCH_HOLD_MS) return;
    if (stick.current) bottom.current?.scrollIntoView({ block: "nearest" });
  }, [turns.length]);

  /*
   * 流进来的字把那条临时气泡撑长，得跟着往下滚 —— 不然生成到第三段就滚出屏幕了。
   *
   * 关键是那道 `stick.current` 闸：只在「用户本来就贴着底」时才动滚动位置。
   *
   * 以前这儿是裸一句 `scrollIntoView({ block: "nearest" })`，指望「翻上去之后
   * bottom 不在视口里、浏览器就不会动」。这个指望是错的：`nearest` 的语义是
   * **把目标滚进视口**，目标在下方视口外时它照样会滚 —— 于是每个 token 都把
   * 画面按回底部，手指划上去一下就被弹回来，就是用户说的「卡死不能上滑」。
   *
   * 闸由下面那个 scroll 监听翻：往上离底超过 STICK_PX 就关，自己滑回底部就开，
   * 和聊天软件一个手感。
   */
  useEffect(() => {
    if (!streaming && !pending) return;
    // 手刚碰过就整个让开 —— 哪怕只划了一点、距离上还算「贴着底」
    if (Date.now() - touchedAt.current < TOUCH_HOLD_MS) return;
    if (stick.current) bottom.current?.scrollIntoView({ block: "nearest" });
  }, [streaming, pending]);

  /*
   * 听滚动，维护上面那道闸。
   *
   * 滚动容器是壳子那个 `<main>`（shell.jsx 的 `[data-scroll]`），和往上补历史
   * 那个 effect 找的是同一个 —— 这一页自己不滚。
   *
   * 挂载条件是 `story`（不是 `streaming`）：用户完全可以在生成开始**之前**就
   * 先翻上去看旧内容，那时候这个监听必须已经在听了，不然那次上翻不算数。
   *
   * 判定放在 scroll 事件里，靠的是浏览器的一条保证：程序改 `scrollTop`
   * （`scrollIntoView`）也会发 scroll。所以钉底自己那一下也会走进来重算一次，
   * 算出来还是「贴着底」—— 闸保持开着，不会自己把自己关掉。
   */
  useEffect(() => {
    if (!hasStory) return undefined;
    const box = bottom.current?.closest("[data-scroll]");
    if (!box) return undefined;
    const onScroll = () => {
      const gap = box.scrollHeight - box.scrollTop - box.clientHeight;
      stick.current = gap <= STICK_PX;
    };
    /*
     * 「手真的在动」只认这三个事件，**不认 scroll**。
     *
     * scroll 是分不出人和程序的 —— 上面钉底那一下自己也会发一个。拿 scroll 记
     * 时间戳的话，第一次钉底就把自己锁在让开状态里，再也不跟着滚了。
     * touchstart / touchmove / wheel 只有人能发出来，所以用它们。
     *
     * touchstart 也记：手指按住不动也是「我在看这儿」，这时候不该把画面抽走。
     * 惯性滑动阶段没有 touchmove，靠 TOUCH_HOLD_MS 这个窗口盖过去。
     */
    const onTouch = () => {
      touchedAt.current = Date.now();
    };
    box.addEventListener("scroll", onScroll, { passive: true });
    box.addEventListener("touchstart", onTouch, { passive: true });
    box.addEventListener("touchmove", onTouch, { passive: true });
    box.addEventListener("wheel", onTouch, { passive: true });
    return () => {
      box.removeEventListener("scroll", onScroll);
      box.removeEventListener("touchstart", onTouch);
      box.removeEventListener("touchmove", onTouch);
      box.removeEventListener("wheel", onTouch);
    };
  }, [hasStory]);

  /*
   * 往上滚到头就再补一批更早的。
   *
   * 听的是 `<main>` 的 scroll —— 这一页自己不滚，整页都挂在壳子那个
   * `[data-scroll]` 容器上（shell.jsx），所以从哨兵往上找到它。
   * 用 scroll 而不是 IntersectionObserver：IO 在后台标签页里根本不回调，
   * 而 scroll 只要用户真的在滚就一定到。
   *
   * 补进去的轮次是插在列表**开头**的，浏览器会把剩下的内容整体往下推 ——
   * 用户正盯着的那一条会突然跳走。所以动手之前先量下「那一条离容器顶多远」，
   * 补完用 useLayoutEffect 把这个距离还原（绘制之前改，看不见跳动）。
   *
   * `skipped <= 0` 就整个不挂 —— 补到底之后这套自动停摆，不用另开标志位。
   */
  useEffect(() => {
    if (skipped <= 0) return undefined;
    const box = topSentinel.current?.closest("[data-scroll]");
    if (!box) return undefined;
    const onScroll = () => {
      if (box.scrollTop > NEAR_TOP_PX) return;
      const mark = anchor.current;
      /*
       * 记的是「这一条离容器顶多远」，不是它的绝对位置 —— 补完要还原的是这个
       * 距离。只把它推回容器顶的话，画面会整段跳掉这段距离（实测 552px）。
       */
      nearTop.current = mark
        ? { box, mark, offset: mark.getBoundingClientRect().top - box.getBoundingClientRect().top }
        : null;
      setLoadedMore((n) => n + TURN_CHUNK);
    };
    /*
     * 只听真事件，不在挂上的那一刻主动判一次 —— 那样会依赖上面「滚到底」那个
     * effect 先跑完，顺序一变就会在刚进页面时连锁补满 90 轮。
     *
     * 「补完还在顶上」这一种也不用自己管：还原滚动位置本身会再发一次 scroll，
     * 于是还差就继续补，够了就停。补到底时 `skipped` 归零，这个 effect 直接
     * 不挂，所以连不上死循环。
     */
    box.addEventListener("scroll", onScroll, { passive: true });
    return () => box.removeEventListener("scroll", onScroll);
  }, [skipped]);

  /*
   * 补完把锚点钉回去。
   *
   * 锚点取的是**补之前**的 `shown[0]`：补完之后它往后挪了 TURN_CHUNK 位，
   * 按同一个下标取就是另一条了 —— 所以位置在 `setLoadedMore` 之前就量好
   * （就是上面那个 onScroll 里干的事），这里只负责把差值加回 scrollTop。
   *
   * null 表示「这次不是往上补触发的」（换剧情、刷新、发了一句），那就别动
   * 滚动位置，交给上面滚到底那个 effect。
   */
  useLayoutEffect(() => {
    const at = nearTop.current;
    nearTop.current = null;
    if (!at) return;
    /* 让那一条回到补之前的位置：现在的距离 − 补之前的距离，就是要补的滚动量 */
    const now = at.mark.getBoundingClientRect().top - at.box.getBoundingClientRect().top;
    at.box.scrollTop += now - at.offset;
  }, [loadedMore]);

  /*
   * 自动朗读的开关和失败提示。
   *
   * `auto` 只在**末尾那条角色回复**上是 true，不是每条都念：翻旧剧情、
   * 切角色、改一条渲染规则都会让整个列表重渲染，要是条条都自动合成，
   * 一进页面就是十几条请求。用户说的「生成完文字后立马生成语音」本来就是
   * 指刚演出来的那一轮。
   *
   * `voiceError` 用 useCallback 定住 —— 它一路传到 `VoiceLine` 的 `fetchOnce`
   * 依赖里，每次渲染换个新函数的话那个 effect 会跟着重跑，自动合成就会
   * 一遍遍打接口（缓存住的那次会挡住，但没必要冒这个险）。
   */
  const autoVoice = Boolean(state?.autoVoice);
  const turnAuto = autoVoice && !busy;
  const voiceError = useCallback((m) => {
    setNote(`语音没合成出来：${m}`);
  }, []);

  /**
   * 发你这一轮。
   *
   * 输入框先清空、`said` 让它立刻以气泡的形式出现在剧情末尾 —— 不然接下来
   * 几十秒屏幕上没有你刚打的字，像是没发出去。
   *
   * **一句话都没落盘的那种失败要把字还回来。** 判据是「后端那份存档里，末尾
   * 现在是不是你这句」：
   *  - 是：它已经在存档里了，界面上看得见 —— 这时候再往输入框里塞一份，就成了
   *    同一句话出现两遍，一不小心发出去就是重复的一轮。该按的是「再来一次」。
   *  - 不是（请求根本没出去、后端在落盘之前就报错了）：那句字只存在于这个输入框
   *    里，清掉它等于让你重打一遍。所以还回去。
   *
   * 判的是**存档**而不是「有没有报错」：模型报错和写盘失败都是 `ok:false`，
   * 但前者你那句在、后者不在，光看错误分不出来。
   */
  async function send() {
    const text = input.trim();
    if (!text) return;
    setInput("");
    const r = await run("/turn", { method: "POST", body: { text, storyId: sid }, said: text });
    if (r?.ok) return;
    const saved = r?.story?.turns ?? [];
    const tail = saved.length ? saved[saved.length - 1] : null;
    if (tail?.role !== "user") setInput((cur) => cur || text);
  }

  async function pickChoice(index) {
    // 选项那一路不回填：正文是从上一轮的 options 上取的，本来就还在屏幕上
    await run("/turn", {
      method: "POST",
      body: { choiceIndex: index, storyId: sid },
      said: lastAssistant?.options?.[index - 1] ?? "",
    });
  }

  /** 重新生成末尾那条回复。你那句留在存档里，按同一份上文再来一次。 */
  const reroll = useCallback(
    () => run("/reroll", { method: "POST", body: { storyId: sid } }),
    [run, sid]
  );

  /*
   * 气泡上那几个回调。
   *
   * 全部 `useCallback` 定住、`turn.id` 由气泡自己带回来 —— 写成内联箭头函数
   * 的话每次渲染都是新引用，`Bubble` 外面那层 `memo` 会当场失效，敲一个字
   * 就要把几十个 iframe 一起重走一遍。
   */
  const startEdit = useCallback((turnId, content) => {
    setMenuKey("");
    draftRef.current = content ?? "";
    setDraft(content ?? "");
    setEditKey(turnId);
  }, []);

  const cancelEdit = useCallback(() => setEditKey(""), []);

  const changeDraft = useCallback((v) => {
    draftRef.current = v;
    setDraft(v);
  }, []);

  const commitEdit = useCallback(
    async (turnId) => {
      const text = draftRef.current.trim();
      if (!text) {
        setError("正文不能改成空的 —— 要删就用三个点里的「删除回复」。");
        return;
      }
      setEditKey("");
      const r = await run(`/turn/${encodeURIComponent(turnId)}`, {
        method: "PATCH",
        body: { content: text, storyId: sid },
      });
      if (r?.ok) setNote("改好了。");
    },
    [run, sid]
  );

  const toggleHide = useCallback(
    (turnId, hidden) => {
      setMenuKey("");
      run(`/turn/${encodeURIComponent(turnId)}`, {
        method: "PATCH",
        body: { hidden: !hidden, storyId: sid },
      });
    },
    [run, sid]
  );

  const dropTurn = useCallback(
    (turnId) => {
      setMenuKey("");
      run(`/turn/${encodeURIComponent(turnId)}${q}`, { method: "DELETE" });
    },
    [run, q]
  );

  async function endOffline() {
    const r = await run("/close", { method: "POST", body: { inject } });
    setClosing(false);
    if (!r) return;
    if (r.error) {
      setError(`线下已经关掉了，但收尾没全做完：${r.error}`);
      return;
    }
    setNote(
      inject
        ? `线下结束了。${r.injected ?? 0} 份总结已经写进记忆库的待总结 —— 下次生成记忆时角色就会记住这一段。`
        : "线下结束了。这一段没有写进记忆库。"
    );
  }

  async function newStory() {
    const name = nameDraft.trim();
    setNaming("");
    setNameDraft("");
    const r = await run("/story", { method: "POST", body: { name } });
    if (r?.ok) setNote("新剧情开好了，上一条还在左边的列表里。");
  }

  async function renameStory() {
    const name = nameDraft.trim();
    if (!name) return;
    setNaming("");
    setNameDraft("");
    await run(`/story/${encodeURIComponent(sid)}`, { method: "PATCH", body: { name } });
  }

  async function summarize(kind) {
    const r = await run("/summary", { method: "POST", body: { kind, storyId: sid } });
    if (r?.ok) setNote(`${kind === "big" ? "大" : "小"}总结出来了。`);
  }

  async function addManual() {
    const text = manual.trim();
    if (!text) return;
    setManual("");
    const r = await run("/summary/manual", {
      method: "POST",
      body: { text, kind: "small", storyId: sid },
    });
    if (r?.ok) setNote("手写的那份存好了。");
  }

  const gateOff = row ? !row.gate : false;
  const summaries = story?.summaries ?? [];

  return (
    <div className="grid grid-cols-1 gap-rhythm-sm lg:gap-rhythm">
      <Card
        title="线下模式"
        actions={
          <Button variant="outline" onClick={refreshRows}>
            <RefreshCw size={14} /> 刷新
          </Button>
        }
      >
        {listError && (
          <p className="border-l-2 border-warn py-1.5 pl-3 text-meta leading-relaxed text-warn">
            读不到角色列表：{listError}
          </p>
        )}

        <div className="mt-4">
          {rows === null && <p className="text-eyebrow uppercase text-ink-meta">读取中</p>}

          {rows !== null && !itemId && (
            <p className="max-w-[62ch] text-body text-ink-soft">
              {listItems.length
                ? "左边挑一个角色，这里就是和他的那段剧情。"
                : "还没有角色。线下剧情是按角色分的，先去「角色」里建一个。"}
            </p>
          )}

          {itemId && !state && !error && (
            <p className="text-eyebrow uppercase text-ink-meta">读取中</p>
          )}

          {state && (
            <>
              {/* 顶部：开没开 + 当前剧情 + 那几个按钮 */}
              <div className="mb-5 grid grid-cols-1 gap-2.5 border-b border-line pb-4">
                <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
                  {/* 状态挪到名字下面一行、字再小一档 —— 顶上少占一截，剧情就多一截 */}
                  <div className="min-w-0">
                    <p className="font-serif text-h3 leading-tight text-ink">{roleName}</p>
                    <p
                      className={`mt-0.5 pl-0.5 text-meta ${
                        state.open ? "text-good" : "text-ink-meta"
                      }`}
                    >
                      {state.open ? "线下开着" : "线下没开"}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {state.open ? (
                      <Button variant="outline" onClick={() => setClosing(true)} disabled={busy}>
                        <Square size={14} /> 结束当前线下模式
                      </Button>
                    ) : (
                      <Button
                        onClick={() => run("/open", { method: "POST", body: {} })}
                        disabled={busy || gateOff}
                      >
                        <Play size={14} /> {story ? "接着演" : "开始演"}
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      onClick={() => {
                        setNameDraft("");
                        setNaming("new");
                      }}
                      disabled={busy}
                    >
                      <Plus size={14} /> 开启新剧情
                    </Button>
                    {story && (
                      <Button variant="ghost" onClick={() => setShowSummary(true)}>
                        <ScrollText size={14} /> 总结
                        {summaries.length ? ` · ${summaries.length} 份` : ""}
                      </Button>
                    )}
                    <Button variant="ghost" onClick={() => setShowPrompt(true)}>
                      <FileText size={14} /> 提示词
                    </Button>
                  </div>
                </div>

                {gateOff && (
                  <p className="border-l-2 border-warn py-1.5 pl-3 text-meta leading-relaxed text-warn">
                    这个角色的线下模式是关着的，开不起来。
                    <button
                      type="button"
                      onClick={() => onGoto?.("role")}
                      className="link-slide ml-1 text-warn"
                    >
                      去「角色 → 线下模式」里打开
                    </button>
                  </p>
                )}

                {/* 剧情切换 + 改名 + 删 —— 挑哪条演，一行就够 */}
                {(state.stories ?? []).length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      className={`${inputCls} min-w-0 flex-1 sm:max-w-md`}
                      value={sid}
                      disabled={busy}
                      aria-label="在演/在看哪一条剧情"
                      title="切过去就接着那条演"
                      onChange={(e) =>
                        run(`/story/${encodeURIComponent(e.target.value)}`, { method: "GET" })
                      }
                    >
                      {(state.stories ?? []).map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} · {s.turnCount} 轮
                          {s.endedAt ? " · 已结束" : ""}
                        </option>
                      ))}
                    </select>
                    <Button
                      variant="ghost"
                      disabled={busy || !sid}
                      onClick={() => {
                        setNameDraft(story?.name ?? "");
                        setNaming("rename");
                      }}
                    >
                      <Pencil size={14} /> 改名
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={busy || !sid}
                      onClick={() =>
                        run(`/story/${encodeURIComponent(sid)}`, { method: "DELETE" })
                      }
                      className="text-warn hover:bg-warn/[0.08]"
                    >
                      <Trash2 size={14} /> 删掉这条剧情
                    </Button>
                  </div>
                )}
              </div>

              {error && (
                <p className="mb-6 whitespace-pre-wrap border-l-2 border-warn py-1.5 pl-3 text-meta leading-relaxed text-warn">
                  {error}
                  {/*
                    * 「你那句还在，角色没回上」—— 原地给一条路回去。
                    *
                    * 判的是**存档现在长什么样**（末尾是不是你那句），不是错误文案里
                    * 有没有「按停」。这两件事在这儿是一回事：按停、模型报错、
                    * 连接断在半路，落到存档上都是同一个形状 —— 你那句在，回复没有。
                    * 以前只认「按停」那一种，于是模型报错之后屏幕上就没有出路了，
                    * 只能把自己那句重打一遍。
                    */}
                  {awaiting && state.open && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={reroll}
                      className="link-slide ml-1 text-warn"
                    >
                      再来一次
                    </button>
                  )}
                </p>
              )}
              {note && (
                <p className="mb-6 border-l-2 border-good py-1.5 pl-3 text-meta leading-relaxed text-good">
                  {note}
                  {note.includes("记忆库") && (
                    <button
                      type="button"
                      onClick={() => onGoto?.("memories")}
                      className="link-slide ml-1 text-good"
                    >
                      去记忆库看看
                    </button>
                  )}
                </p>
              )}

              {/* 剧情本身 */}
              {!story ? (
                <p className="text-body text-ink-soft">
                  还没有剧情。点上面的「开始演」，会顺手起一条。
                </p>
              ) : (
                <div className="grid grid-cols-1 gap-6">
                  {/*
                    * 顶上的哨兵 + 提示。
                    *
                    * 哨兵是那个空 div，滚到它就自动补一批。提示那行是给人看的 ——
                    * 划到顶看见「上面还有 N 轮」比看见一片空白强得多，而且没有
                    * IntersectionObserver（或者它被关掉了）的时候，按钮还能手点。
                    */}
                  {skipped > 0 && (
                    <div>
                      <div ref={topSentinel} aria-hidden="true" />
                      <Button variant="ghost" onClick={() => setLoadedMore((n) => n + TURN_CHUNK)}>
                        <MoreHorizontal size={14} /> 上面还有 {skipped} 轮 —— 继续往上滚
                      </Button>
                    </div>
                  )}

                  {shown.map((t, i) => (
                    <div
                      key={t.id}
                      /* 补更早那批之前，把这一条的位置记下来当锚点 */
                      ref={i === 0 ? (el) => { if (el) anchor.current = el; } : undefined}
                      className="grid grid-cols-1 gap-3"
                    >
                      <Bubble
                        turn={t}
                        mine={t.role === "user"}
                        name={t.role === "user" ? userName : roleName}
                        avatar={t.role === "user" ? state.userAvatar : state.avatar}
                        busy={busy}
                        menuOpen={menuKey === t.id}
                        onMenu={setMenuKey}
                        editing={editKey === t.id}
                        draft={editKey === t.id ? draft : ""}
                        onDraft={changeDraft}
                        onCommit={commitEdit}
                        onCancel={cancelEdit}
                        onEdit={startEdit}
                        onHide={toggleHide}
                        onDrop={dropTurn}
                        roleKey={itemId}
                        auto={turnAuto && lastAssistant?.id === t.id}
                        onVoiceError={voiceError}
                      />

                      {/*
                        * 末尾那条助手回复才给重 roll 和选项。
                        *
                        * 判的是 `lastTurn`（整条剧情的最后一轮）而不是 `lastAssistant`
                        * （最后一条**助手**轮次）—— 生成失败之后末尾是你那句，
                        * 最后一条助手轮次成了上一轮：那一轮的四条选项早就被你的
                        * 下一句接掉了，重 roll 也不是在重 roll 它。
                        */}
                      {lastTurn?.id === t.id && t.role === "assistant" && (
                        <div className="grid grid-cols-1 gap-3 pl-12">
                          {state.choices && (t.options ?? []).length > 0 && (
                            <ChoiceRow options={t.options} busy={busy} onSend={pickChoice} />
                          )}
                          <div>
                            <Button variant="outline" disabled={busy || !state.open} onClick={reroll}>
                              <RotateCcw size={14} /> 重 roll 这次回复
                            </Button>
                          </div>
                        </div>
                      )}

                      {/*
                        * 你说了一句、角色没回上（按停 / 模型报错 / 连接断了）。
                        *
                        * 出口挂在**你那条气泡底下**，不是只放在页面顶上那条红字里：
                        * 演久了的剧情，顶上那行早就滚出屏幕了；而且刷新一次错误提示
                        * 就没了，存档还是这个样子 —— 出路得跟着存档在。
                        *
                        * 生成中不显示：那会儿正在写的就是这一轮，`streaming` 那条
                        * 临时气泡紧跟在下面。
                        */}
                      {awaiting && lastTurn?.id === t.id && !busy && state.open && (
                        <div className="flex flex-wrap items-center gap-3 pl-12">
                          <Button variant="outline" onClick={reroll}>
                            <RotateCcw size={14} /> 再来一次
                          </Button>
                          <span className="text-meta text-ink-meta">
                            这句已经存下来了 —— 不用重打，按同一份上文再生成一次
                          </span>
                        </div>
                      )}
                    </div>
                  ))}

                  {/*
                    * 你刚发出去、后端还没回话的那句。
                    *
                    * 为什么非要有这条：后端是「先把你那句落盘，再去打模型」，而这一页
                    * 只认后端回的那份完整 state —— 中间几十秒屏幕上没有你刚打的字，
                    * 输入框又清空了，看着就像这句话没发出去。
                    *
                    * 和下面那条流式气泡同一个路子：不走 `Bubble`（没有 turn.id，
                    * 编辑/删除都无从谈起），只借外形。`flex-row-reverse` + `ml-auto`
                    * 是你那侧的版式，和 `Bubble` 里 `mine` 那几条对齐。
                    */}
                  {busy && pending && (
                    <div className="flex flex-row-reverse items-start gap-3">
                      <Avatar file={state.userAvatar} name={userName} />
                      <div className="min-w-0 max-w-[min(52rem,88%)] flex-1">
                        <div className="flex flex-wrap items-baseline justify-end gap-x-2 gap-y-0.5">
                          <span className="text-eyebrow uppercase text-ink-faint">{userName}</span>
                          <span className="text-meta text-ink-meta">发出去了</span>
                        </div>
                        <div className="mt-1.5 ml-auto w-fit max-w-[34rem] border border-line bg-sunken px-3.5 py-3">
                          <p className="whitespace-pre-wrap break-words text-ui leading-relaxed text-ink-soft">
                            {pending}
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  {/*
                    * 正在流进来的那半截。
                    *
                    * 刻意**不走 `Bubble`**：那个组件要 `turn.id` 才能挂编辑/隐藏/删除
                    * 的菜单，而这条还没落盘、没有 id，也不该能编辑。这里只借它的
                    * 外形（头像 + 名字 + 同一个框），正文是纯文本 `whitespace-pre-wrap`
                    * —— 半截 HTML 和半条正则渲出来的东西比不渲更难看。
                    */}
                  {streaming !== null && (
                    <div className="flex items-start gap-3">
                      <Avatar file={state.avatar} name={roleName} />
                      <div className="min-w-0 max-w-[min(52rem,88%)] flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                          <span className="text-eyebrow uppercase text-ink-faint">{roleName}</span>
                          <span className="text-meta text-ink-meta">正在写…</span>
                        </div>
                        <div className="mt-1.5 w-fit border border-line bg-sunken px-3.5 py-3">
                          <p className="whitespace-pre-wrap text-body leading-relaxed text-ink-soft">
                            {streaming}
                            <span className="ml-0.5 animate-pulse text-ink-faint">▍</span>
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  <div ref={bottom} />

                  {/* 写一句 */}
                  <div className="grid grid-cols-1 gap-2 border-t border-line pt-5">
                    <textarea
                      className={`${inputCls} min-h-[100px] resize-y leading-relaxed`}
                      value={input}
                      maxLength={MAX_TURN_CHARS}
                      disabled={busy || !state.open}
                      placeholder={
                        state.open
                          ? "写你这一轮做什么、说什么。Ctrl/⌘+Enter 发送"
                          : "线下没开着 —— 先点上面那个按钮"
                      }
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
                      }}
                    />
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <span className="text-meta text-ink-meta">
                        {input.length} 字 · Ctrl/⌘+Enter 发送 · 一轮最多 {MAX_TURN_CHARS} 字
                      </span>
                      <div className="flex items-center gap-2">
                        {/* 正在生成才有的「停下」—— 点选项生成也走同一个 busy */}
                        {busy && (
                          <Button variant="outline" onClick={stopNow} disabled={stopping}>
                            <Square size={14} /> {stopping ? "正在停…" : "停下"}
                          </Button>
                        )}
                        <Button onClick={send} disabled={busy || !state.open || !input.trim()}>
                          {busy ? (
                            <RefreshCw size={14} className="animate-spin" />
                          ) : (
                            <Send size={14} />
                          )}
                          {busy ? "生成中…" : "发送"}
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </Card>

      {showSummary && state && story && (
        <SummaryDialog
          summaries={summaries}
          busy={busy}
          smallEvery={role?.offline?.smallEvery ?? 6}
          manual={manual}
          onManual={setManual}
          onGoto={onGoto}
          onSummarize={summarize}
          onSave={(id, text) =>
            run(`/summary/${encodeURIComponent(id)}`, {
              method: "PATCH",
              body: { text, storyId: sid },
            })
          }
          onDrop={(id) => run(`/summary/${encodeURIComponent(id)}${q}`, { method: "DELETE" })}
          onAdd={addManual}
          onClose={() => setShowSummary(false)}
        />
      )}

      {showPrompt && <PromptDialog onClose={() => setShowPrompt(false)} />}

      {closing && state && (
        <CloseDialog
          roleName={roleName}
          busy={busy}
          inject={inject}
          onInject={setInject}
          onClose={() => setClosing(false)}
          onConfirm={endOffline}
        />
      )}

      {naming && (
        <NameDialog
          title={naming === "new" ? "开启新剧情" : "改剧情名"}
          desc={
            naming === "new"
              ? "当前这条留着，随时从上面的下拉里切回来"
              : "只改名字，正文和总结都不动"
          }
          label="剧情名"
          value={nameDraft}
          onValue={setNameDraft}
          busy={busy}
          onClose={() => setNaming("")}
          onConfirm={naming === "new" ? newStory : renameStory}
        />
      )}
    </div>
  );
}
