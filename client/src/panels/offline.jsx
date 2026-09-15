/*
 * 「对话框」分区：线下剧情。
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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  Loader2,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Square,
  Trash2,
} from "lucide-react";

import { roleLabel } from "../labels.js";
import { offlineMediaUrl } from "../offlinemedia.js";
import { useSection } from "../section.jsx";
import { api, useConfig } from "../store.jsx";
import { Button, Card, Field, Fold, Modal, fmtStamp, inputCls } from "../ui.jsx";

/** 一轮正文的上限，和 server/src/offlinestore.js:MAX_TURN_CHARS 对齐。 */
const MAX_TURN_CHARS = 20000;

/**
 * 这段文字里有没有真的 HTML。
 *
 * 用**标签白名单**而不是「见到尖括号就算」：模型的正文里出现
 * `<thinking>`、`<选项>` 这类自造标记太常见了，那些不该把整段话塞进 iframe。
 * 反过来，用户写正则渲染状态栏时用的就是下面这些标签。
 */
const HTML_TAG =
  /<(?:div|span|table|tr|td|th|thead|tbody|p|ul|ol|li|h[1-6]|section|article|style|img|br|hr|b|i|u|strong|em|code|pre|blockquote|progress|meter|details|summary|font|center|dl|dt|dd)\b[^>]*>/i;

/**
 * 状态栏那个 iframe 里找「」台词、给每句挂一个播放键的那段脚本。
 *
 * 为什么要塞进 iframe：`sandbox=""` 把框子里的脚本也禁掉了，外面拿不到
 * 里面的 DOM（跨文档，同源策略照样拦），所以状态栏里的台词**必须是框子自己
 * 找、自己挂按钮**。它不能合成语音（没有凭据、也不该有），点了就
 * `postMessage` 出来，由父窗口去打 `/voice`。
 *
 * 文本节点用 TreeWalker 走一遍，**跳过 script/style**，按文档顺序拼成一条
 * "哪一段是台词" 的列表；只给不在标签里的「」挂按钮，`<style>` 里写着
 * 「」也不会把按钮糊到样式表上。
 *
 * 框子**不自己播**（`<audio>` 建在这边只会多一层变量），它只负责：
 * 挂按钮 → 点一下 postMessage 出去 → 外面合成完了再 `clickOne` 回来。
 * 外面合成完那份音频塞在 `__cache` 里，所以「回来」的时候不用把 base64
 * 再传进框子一遍。
 */
const VOICE_SCRIPT = `(function(){
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
  /* 从后往前改，前面的下标才不会被拆出来的新节点顶掉 */
  targets.reverse().forEach(function(t, i) {
    var node = t.node;
    var after = node.splitText(t.index);
    var mid = after.splitText(t.len);
    mid.nodeValue = t.text;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "播放";
    btn.style.cssText = "font:inherit;font-size:12px;margin:0 2px;padding:0 4px;border:1px solid #e4e4e7;background:transparent;color:#71717a;cursor:pointer;vertical-align:baseline";
    mid.parentNode.insertBefore(btn, mid.nextSibling);
    var idx = targets.length - 1 - i;
    buttons[idx] = btn;
    texts[idx] = t.text;
    btn.addEventListener("click", function(){ ask(idx); });
  });

  var cache = {};
  var asking = {};
  function ask(idx){
    if (cache[idx]) { toggle(idx); return; }
    if (asking[idx]) return;
    asking[idx] = true;
    buttons[idx].textContent = "合成中";
    window.parent.postMessage({ kind: "offline-voice", token: window.__OFFLINE_VOICE_TOKEN__, index: idx, text: texts[idx] }, "*");
  }
  function toggle(idx){
    var a = cache[idx];
    if (!a.paused) { a.pause(); return; }
    a.play();
  }
  function put(idx, url){
    delete asking[idx];
    var a = new Audio(url);
    cache[idx] = a;
    a.onplay = function(){ buttons[idx].textContent = "暂停"; };
    a.onpause = function(){ buttons[idx].textContent = "播放"; };
    a.onended = function(){ buttons[idx].textContent = "重播"; };
    a.onerror = function(){ buttons[idx].textContent = "坏了"; };
    buttons[idx].textContent = "播放";
  }
  window.__offlineVoice = {
    /* 有几句台词 —— 外面拿这个数去决定要不要自动合成 */
    count: function(){ return buttons.length; },
    texts: function(){ return texts; },
    put: put,
    /* 外面替用户按一下某个播放键（自动朗读走的就是这条路） */
    pull: ask,
    fail: function(idx){ delete asking[idx]; buttons[idx].textContent = "重试"; },
    ready: function(){ window.parent.postMessage({ kind: "offline-voice-ready", token: window.__OFFLINE_VOICE_TOKEN__, count: buttons.length }, "*"); }
  };
  if (window.__OFFLINE_AUTO_VOICE__) for (var i = 0; i < buttons.length; i++) ask(i);
  window.__offlineVoice.ready();
})();`;

/**
 * 包一份能塞进 srcdoc 的完整文档。
 *
 * `white-space: pre-wrap` 是给**正文**留的：一条回复往往是「一段 HTML 状态栏 +
 * 一大段散文」，散文里的换行不能丢。代价是 HTML 标签之间的换行和缩进也会照原样
 * 显示出来 —— 想让状态栏紧凑，就在正则里把标签写成一行。
 *
 * 字色写死成和页面同一档，不继承外面的 CSS —— iframe 是另一个文档，
 * tailwind 那套变量进不去。
 *
 * 带了状态栏里的「」播放键那段脚本。`auto` 由外面传进来 —— 自动朗读开着，
 * 脚本自己把每一个播放键按一遍（只合成、不出声，按钮停在「播放」上等人点）。
 */
function htmlDoc(inner, auto = false, token = "") {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:transparent}
body{color:#18181b;font:14px/1.7 ui-sans-serif,system-ui,"Segoe UI","Microsoft YaHei",sans-serif;white-space:pre-wrap;word-break:break-word}
table{border-collapse:collapse}
th,td{border:1px solid #e4e4e7;padding:4px 8px;white-space:normal}
img{max-width:100%}
a{color:#18181b}
</style></head><body>${inner}<script>window.__OFFLINE_AUTO_VOICE__=${
    auto ? "true" : "false"
  };window.__OFFLINE_VOICE_TOKEN__=${JSON.stringify(token)};${VOICE_SCRIPT}</script></body></html>`;
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
 * 高度得手动给：跨源量不到自己多高。所以给两档（紧凑 / 展开）让用户自己切，
 * 里面照常能滚。
 */
function HtmlBlock({ html, roleKey, turnId, auto, onVoiceError }) {
  const [tall, setTall] = useState(false);
  const box = useRef(null);
  // 每条状态栏一个随机 token：页面上可能同时挂着好几个框子，认人用
  const token = useMemo(
    () => `v${turnId}-${Math.random().toString(36).slice(2, 8)}`,
    [turnId]
  );
  // srcDoc 只在挂载时读一次（下面 useMemo 空依赖），所以 auto 变了不重建框子 ——
  // 重建会把里面的滚动位置和已经合成的音频一起丢掉。自动朗读的那一下靠
  // 下面那个 effect 进去按按钮补上
  const doc = useMemo(() => htmlDoc(html, auto, token), []);

  /**
   * 框子里点了播放键：合成一句，把 blob 地址递回去。
   *
   * 音频缓存在**框子里**（那份 `cache`），这边管的是「有没有在合成」——
   * 同一条被连点两下不会打两次接口。
   */
  const busyRef = useRef(new Set());
  const urlRef = useRef([]);

  const call = useCallback(
    async (index, text) => {
      const voice = box.current?.contentWindow?.__offlineVoice;
      if (!voice || busyRef.current.has(index)) return;
      busyRef.current.add(index);
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
        urlRef.current.push(url);
        voice.put(index, url);
      } catch (e) {
        voice.fail?.(index);
        onVoiceError?.(String(e?.message ?? e));
      } finally {
        busyRef.current.delete(index);
      }
    },
    [roleKey, onVoiceError]
  );

  /* 框子换了（改一条渲染规则、切剧情）就把上一个的 blob 收掉 */
  useEffect(
    () => () => {
      urlRef.current.forEach((u) => URL.revokeObjectURL(u));
      urlRef.current = [];
    },
    [doc]
  );

  /*
   * 自动朗读。里面那句台词全部挂好播放键之后会回一条 `offline-voice-ready`，
   * 这里收到才去替用户按一遍 —— 比定个时延靠谱（框子的 srcdoc 什么时候跑完
   * 没有保证）。
   *
   * `auto` 是懒亮的（上一轮还在演的时候 false，演完变 true），而框子的 srcdoc
   * 只在挂载时读一次，所以「亮起来了」这件事得外面自己接上 —— `ready` 可能
   * 早于它到（那就在 effect 里补按一次），也可能晚于它（那时在 ready 分支里按）。
   * `pulledRef` 保证只按一遍：别的一轮重渲染不会再合成一次。
   */
  const pulledRef = useRef(false);

  /**
   * 把框子里每一句都合成一遍（等于用户自己点，只是不替他出声）。
   *
   * 拿不到框子里的 `__offlineVoice` 就**不记这次数**：脚本还没跑完的时候
   * 按下去是空按，记下来的话后面那条 `ready` 就再也补不上了。真按到过才
   * 置位，所以最坏情况是被重复触发一次（合成有缓存，第二次不花钱）。
   */
  const pullAll = useCallback(() => {
    const voice = box.current?.contentWindow?.__offlineVoice;
    if (!voice || pulledRef.current) return;
    pulledRef.current = true;
    const n = voice.count();
    for (let i = 0; i < n; i += 1) voice.pull(i);
  }, []);

  useEffect(() => {
    function onMessage(e) {
      const d = e.data;
      if (!d || typeof d !== "object" || d.token !== token) return;
      if (box.current && e.source !== box.current.contentWindow) return;
      if (d.kind === "offline-voice") call(d.index, d.text);
      // 键挂完了。自动朗读开着的话，现在就是该合成的点
      if (d.kind === "offline-voice-ready" && auto) pullAll();
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [token, call, auto, pullAll]);

  /* ready 早于 effect 到达的那一路：进来补按一次 */
  useEffect(() => {
    if (auto) pullAll();
  }, [auto, pullAll]);

  return (
    <div className="grid grid-cols-1 gap-1.5">
      <iframe
        ref={box}
        // 只放行脚本：状态栏里的「」得自己挂播放键。**同源访问仍然被拦着** ——
        // 框子里碰不到外面这个页面，也就碰不到挂在它上面的密钥
        sandbox="allow-scripts"
        title="渲染结果"
        srcDoc={doc}
        className="w-full border border-line bg-paper"
        style={{ height: tall ? 560 : 240 }}
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          onClick={() => setTall((t) => !t)}
          className="text-meta text-ink-faint transition-colors duration-150 hover:text-ink"
        >
          {tall ? "收起这块" : "放高一点"}
        </button>
        <span className="text-meta text-ink-meta">
          框子里量不到自己多高，内容多的时候里面能滚 · 状态栏里的「」边上有播放键
        </span>
      </div>
    </div>
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
 * 自动朗读走的是同一个 `fetchOnce`，但**合成完不自动出声**：播放键从
 * 「播放」变「重播」等人点。演剧情时界面自己出声多半不是用户想要的，
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

  const label = playing ? "暂停" : status === "loading" ? "合成中" : status === "ready" ? "重播" : "播放";

  return (
    <span className="inline-flex max-w-full items-baseline gap-1 align-baseline">
      <span className="border-b border-line text-ink">{text}</span>
      <button
        type="button"
        onClick={play}
        title={note || `念这一句：${text}`}
        aria-label={`${label}：${text}`}
        className={`inline-flex shrink-0 translate-y-[1px] items-center gap-0.5 rounded-item px-1 py-0.5 text-meta transition-colors duration-150 hover:bg-sunken ${
          status === "error" ? "text-warn" : playing ? "text-good" : "text-ink-faint hover:text-ink"
        }`}
      >
        {status === "loading" ? (
          <Loader2 size={12} className="animate-spin" />
        ) : playing ? (
          <Square size={12} />
        ) : (
          <Play size={12} />
        )}
        {label}
      </button>
      {status === "error" && note && (
        <span className="text-meta leading-relaxed text-warn">{note}</span>
      )}
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
 */
function Bubble({
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
  const text = turn.display ?? turn.content ?? "";
  const isHtml = !mine && HTML_TAG.test(text);
  // 台词的播放键只在**角色**那侧挂 —— 你自己打的那条，念它没有意义
  const spoken = !mine;

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
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onCommit();
              }}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={onCommit} disabled={busy}>
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
              turn.hidden ? "border-dashed border-line opacity-55" : "border-line"
            } ${mine ? "bg-sunken" : "bg-paper"}`}
          >
            {isHtml ? (
              <HtmlBlock
                html={text}
                roleKey={roleKey}
                turnId={turn.id}
                auto={spoken && auto}
                onVoiceError={onVoiceError}
              />
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
                onClick={onEdit}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-meta text-ink-soft transition-colors duration-150 hover:bg-sunken hover:text-ink"
              >
                <Pencil size={13} /> 编辑回复
              </button>
              <button
                type="button"
                onClick={onHide}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-meta text-ink-soft transition-colors duration-150 hover:bg-sunken hover:text-ink"
              >
                {turn.hidden ? <Eye size={13} /> : <EyeOff size={13} />}
                {turn.hidden ? "取消隐藏" : "隐藏回复"}
              </button>
              <button
                type="button"
                onClick={onDrop}
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
}

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

  const [input, setInput] = useState("");
  const [menuKey, setMenuKey] = useState("");
  const [editKey, setEditKey] = useState("");
  const [draft, setDraft] = useState("");

  const [closing, setClosing] = useState(false);
  const [inject, setInject] = useState(true);
  const [naming, setNaming] = useState(""); // "" | "new" | "rename"
  const [nameDraft, setNameDraft] = useState("");
  const [manual, setManual] = useState("");

  const bottom = useRef(null);

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

  /**
   * 所有写操作的唯一入口。
   *
   * 后端每次都回一整份 state，所以这里统一收下 —— 包括 `ok:false` 那次
   * （用户那句话已经落盘了，界面得先显示出来，才谈得上「重 roll」）。
   */
  const run = useCallback(
    async (path, options = {}) => {
      if (!itemId) return null;
      setBusy(true);
      setError("");
      setNote("");
      try {
        const r = await api(`/api/offline/${encodeURIComponent(itemId)}${path}`, options);
        if (r?.roleKey) setState(r);
        if (r?.ok === false) setError(r.error || "这一步没成");
        refreshRows();
        return r;
      } catch (e) {
        setError(String(e?.message ?? e));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [itemId, refreshRows]
  );

  /** 当前剧情的 id，每个写操作都显式带上 —— 免得后端那份 currentId 和这边不同步。 */
  const sid = state?.currentId ?? "";
  const q = sid ? `?storyId=${encodeURIComponent(sid)}` : "";

  // 新一轮落地之后滚到底。剧情是从上往下读的，不像 iMessage 那种倒序
  useEffect(() => {
    if (turns.length) bottom.current?.scrollIntoView({ block: "nearest" });
  }, [turns.length]);

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

  async function send() {
    const text = input.trim();
    if (!text) return;
    setInput("");
    await run("/turn", { method: "POST", body: { text, storyId: sid } });
  }

  async function pickChoice(index) {
    await run("/turn", { method: "POST", body: { choiceIndex: index, storyId: sid } });
  }

  async function commitEdit(turnId) {
    const text = draft.trim();
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
  }

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
    if (r?.ok) setNote(`${kind === "big" ? "大" : "小"}总结出来了，在下面「总结」里。`);
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
        title="对话框"
        desc="线下剧情：坐下来演一段，不是发短信。开着的时候这个角色的线上功能全部停用"
        actions={
          <Button variant="outline" onClick={refreshRows}>
            <RefreshCw size={14} /> 刷新
          </Button>
        }
      >
        <div className="grid grid-cols-1 gap-1.5 border-l-2 border-line py-1.5 pl-3 text-meta leading-relaxed text-ink-soft">
          <p>
            开关、总结节奏、线下预设 / 世界书 / API、两张头像都在
            <button
              type="button"
              onClick={() => onGoto?.("role")}
              className="link-slide mx-1 text-ink"
            >
              角色 → 线下模式
            </button>
            里配，这一页是剧情本身。
          </p>
          <p>
            手机上发 <code className="font-mono">/开启线下</code>
            <code className="mx-1 font-mono">/小总结</code>
            <code className="mr-1 font-mono">/大总结</code>
            <code className="font-mono">/关闭线下</code>
            走的是同一份存档 —— 在 iMessage 里演到一半，回这儿接着演。
          </p>
        </div>

        {listError && (
          <p className="mt-6 border-l-2 border-warn py-1.5 pl-3 text-meta leading-relaxed text-warn">
            读不到角色列表：{listError}
          </p>
        )}

        <div className="mt-8">
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
              <div className="mb-8 grid grid-cols-1 gap-4 border-b border-line pb-6">
                <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <span className="font-serif text-h3 text-ink">{roleName}</span>
                      <span
                        className={`text-eyebrow uppercase ${
                          state.open ? "text-good" : "text-ink-meta"
                        }`}
                      >
                        {state.open ? "线下开着" : "线下没开"}
                      </span>
                    </p>
                    <p className="mt-1 text-meta text-ink-faint">
                      {story ? `${story.name} · ${turns.length} 轮` : "还没有剧情"}
                      {state.presetName ? ` · 预设「${state.presetName}」` : ""}
                      {summaries.length ? ` · ${summaries.length} 份总结` : ""}
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

                {/* 剧情切换 + 改名 + 删 */}
                {(state.stories ?? []).length > 0 && (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
                    <Field label="在演/在看哪一条" hint="切过去就接着那条演">
                      <select
                        className={inputCls}
                        value={sid}
                        disabled={busy}
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
                    </Field>
                    <div className="flex flex-wrap items-end gap-2">
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
                  </div>
                )}
              </div>

              {error && (
                <p className="mb-6 whitespace-pre-wrap border-l-2 border-warn py-1.5 pl-3 text-meta leading-relaxed text-warn">
                  {error}
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
                  {turns.length === 0 && (
                    <p className="text-body text-ink-soft">
                      这条剧情还是空的 —— 在下面写第一句，可以是动作也可以是对白。
                    </p>
                  )}

                  {turns.map((t) => (
                    <div key={t.id} className="grid grid-cols-1 gap-3">
                      <Bubble
                        turn={t}
                        mine={t.role === "user"}
                        name={t.role === "user" ? userName : roleName}
                        avatar={t.role === "user" ? state.userAvatar : state.avatar}
                        busy={busy}
                        menuOpen={menuKey === t.id}
                        onMenu={setMenuKey}
                        editing={editKey === t.id}
                        draft={draft}
                        onDraft={setDraft}
                        onCommit={() => commitEdit(t.id)}
                        onCancel={() => setEditKey("")}
                        onEdit={() => {
                          setMenuKey("");
                          setDraft(t.content ?? "");
                          setEditKey(t.id);
                        }}
                        onHide={() => {
                          setMenuKey("");
                          run(`/turn/${encodeURIComponent(t.id)}`, {
                            method: "PATCH",
                            body: { hidden: !t.hidden, storyId: sid },
                          });
                        }}
                        onDrop={() => {
                          setMenuKey("");
                          run(`/turn/${encodeURIComponent(t.id)}${q}`, { method: "DELETE" });
                        }}
                        roleKey={itemId}
                        auto={turnAuto && lastAssistant?.id === t.id}
                        onVoiceError={voiceError}
                      />

                      {/* 末尾那条助手回复才给重 roll 和选项 */}
                      {lastAssistant?.id === t.id && (
                        <div className="grid grid-cols-1 gap-3 pl-12">
                          {state.choices && (t.options ?? []).length > 0 && (
                            <ChoiceRow options={t.options} busy={busy} onSend={pickChoice} />
                          )}
                          <div>
                            <Button
                              variant="outline"
                              disabled={busy || !state.open}
                              onClick={() => run("/reroll", { method: "POST", body: { storyId: sid } })}
                            >
                              <RotateCcw size={14} /> 重 roll 这次回复
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}

                  <div ref={bottom} />

                  {/* 写一句 */}
                  <div className="grid grid-cols-1 gap-2 border-t border-line pt-6">
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
              )}
            </>
          )}
        </div>
      </Card>

      {/* 总结。折起来是因为演到一半的时候它不是重点，但结束前一定会来看一眼 */}
      {state && story && (
        <Fold
          title="总结"
          desc="每几轮攒一份，结束线下时只有这些会写进记忆库"
          badge={summaries.length ? `${summaries.length} 份` : "还没有"}
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
              <Button variant="outline" onClick={() => summarize("small")} disabled={busy}>
                出一份小总结
              </Button>
              <Button variant="outline" onClick={() => summarize("big")} disabled={busy}>
                出一份大总结
              </Button>
            </div>

            {summaries.length === 0 && (
              <p className="text-meta leading-relaxed text-ink-faint">
                还没有总结。演够 {role?.offline?.smallEvery ?? 6} 轮会自己出一份，
                也可以现在就手动来一份。
              </p>
            )}

            <div className="grid grid-cols-1 gap-3">
              {summaries.map((s) => (
                <SummaryRow
                  key={s.id}
                  summary={s}
                  busy={busy}
                  onSave={(text) =>
                    run(`/summary/${encodeURIComponent(s.id)}`, {
                      method: "PATCH",
                      body: { text, storyId: sid },
                    })
                  }
                  onDrop={() =>
                    run(`/summary/${encodeURIComponent(s.id)}${q}`, { method: "DELETE" })
                  }
                />
              ))}
            </div>

            {/* 模型总结得不好的时候自己补一段 */}
            <Field
              label="自己写一份"
              hint="不打模型，直接存。和上面那些一样会跟着写进记忆库"
            >
              <textarea
                className={`${inputCls} min-h-[90px] resize-y leading-relaxed`}
                value={manual}
                disabled={busy}
                placeholder="这一段里最该记住的是什么"
                onChange={(e) => setManual(e.target.value)}
              />
            </Field>
            <div>
              <Button onClick={addManual} disabled={busy || !manual.trim()}>
                <Plus size={14} /> 存这份
              </Button>
            </div>
          </div>
        </Fold>
      )}

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
