/*
 * 右下角那个气泡 —— Uranus 助手。
 *
 * 为什么它不是又一个分区：侧边栏那一排分区讲的都是「这一栏怎么配」，助手讲的是
 * 「我不知道该去哪一栏」。一个人卡住的时候正停在某个面板上，让他先切走到另一个
 * 分区去提问，等于让他丢掉自己卡住的那个现场。所以它是浮层，钉在右下角，
 * 每个分区上都在 —— 就是那种网页右下角的客服气泡。
 *
 * 它答什么、能不能答，全在服务端（server/src/assistant.js 那本内置世界书 +
 * 那几条铁律）。这个文件只负责三件事：开合、把话发上去、把回话画出来。
 * 对话历史由**这里**拿着，每次整段发上去 —— 服务端不存。关掉气泡就是结束咨询。
 *
 * ⚠ 这是全站唯一一个浮起来的东西。硬规则不许投影，所以它靠 1px 边框 +
 * 实底色和背后的内容分开，不用 shadow。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, MessageCircleQuestion, RefreshCw, X } from "lucide-react";
import { DEFAULT_HELLO, DEFAULT_QQ_GROUP, DOC_URL, MAX_TURNS } from "../assistant-help.js";
import { api } from "../store.jsx";
import { UranusBadge } from "../ui.jsx";

/**
 * 右下角的入口 + 面板。挂在 AppShell 的最外层，不属于任何分区。
 *
 * 开合状态留在这一层（而不是 AppShell）：切分区不该把聊到一半的咨询关掉，
 * 而这个组件在切分区时不会被卸载。
 */
export function AssistantBubble() {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/*
       * 收起时的那颗气泡。z-30 压在移动端抽屉（z-40）和弹窗（z-40）**下面** ——
       * 那两样都是模态的，一个客服气泡不该盖在它们上面抢点击。
       */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="打开 Uranus 助手"
          title="不会配？问问 Uranus ՞˶˃ ᵕ ˂˶՞"
          className="fixed bottom-5 right-5 z-30 flex h-12 w-12 items-center justify-center rounded-full border border-line bg-paper text-ink-soft transition-colors duration-150 hover:bg-sunken hover:text-ink"
        >
          <MessageCircleQuestion size={20} strokeWidth={1.75} />
        </button>
      )}
      {open && <AssistantPanel onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * 一条消息。
 * @typedef {{role: "user"|"assistant", content: string, failed?: boolean}} Turn
 */

function AssistantPanel({ onClose }) {
  const [turns, setTurns] = useState(/** @type {Turn[]} */ ([]));
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // null = 还没问到 /api/assistant/hello
  const [hello, setHello] = useState(null);
  const listRef = useRef(null);
  const inputRef = useRef(null);

  // 开场白、引导问题、群号，以及「现在有没有模型能用」
  useEffect(() => {
    let alive = true;
    api("/api/assistant/hello")
      .then((r) => alive && setHello(r))
      .catch(() => alive && setHello({ ready: true }));
    return () => {
      alive = false;
    };
  }, []);

  // ESC 关掉（和 Modal 一个手感）
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 打开就把焦点放进输入框 —— 用户点这个气泡就是为了打字
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 新消息进来滚到底
  useEffect(() => {
    const box = listRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [turns, busy]);

  const ask = useCallback(
    async (raw) => {
      const text = String(raw ?? "").trim();
      if (!text || busy) return;
      setError("");
      setInput("");
      /*
       * 先把用户那条画上去再发请求 —— 等接口回来才显示的话，网络慢的时候
       * 用户会以为自己那句没发出去，然后再敲一遍。
       *
       * 带上去的历史是**这条之前**的那些（turns），不含正在问的这句：
       * 后端把它单独当 user 消息拼在最后（见 buildAssistantMessages）。
       */
      const history = turns.filter((t) => !t.failed).slice(-MAX_TURNS);
      setTurns((prev) => [...prev, { role: "user", content: text }]);
      setBusy(true);
      try {
        const r = await api("/api/assistant/chat", {
          method: "POST",
          body: { ask: text, turns: history },
        });
        setTurns((prev) => [...prev, { role: "assistant", content: String(r.reply ?? "") }]);
      } catch (e) {
        const msg = String(e?.message ?? e);
        setError(msg);
        /*
         * 失败的那条也进列表，标上 failed —— 不进的话用户看不出是哪一句没答上来。
         * failed 的条目不会被带进下一轮的历史（上面 filter 掉了）：
         * 一句报错混在对话里，模型下一轮会以为那是它自己说过的话。
         */
        setTurns((prev) => [...prev, { role: "assistant", content: msg, failed: true }]);
      } finally {
        setBusy(false);
        inputRef.current?.focus();
      }
    },
    [busy, turns],
  );

  const qq = hello?.qqGroup ?? DEFAULT_QQ_GROUP;
  const doc = hello?.docUrl ?? DOC_URL;
  // ready 只有明确回了 false 才当没配好；还没问到（null）时先按能用画，
  // 免得气泡一打开先闪一下「没有可用模型」
  const blocked = hello?.ready === false;

  return (
    <div className="fixed bottom-5 right-5 z-30 flex max-h-[min(560px,calc(100vh-2.5rem))] w-[min(384px,calc(100vw-2.5rem))] flex-col border border-line bg-paper">
      {/* 头：身份 + 关闭。不写「在线」这类假状态，它就是个查手册的 */}
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <UranusBadge size={24} className="shrink-0" />
          <div className="min-w-0">
            <p className="text-ui text-ink">Uranus ⌯'ᵕ'⌯</p>
            <p className="truncate text-meta text-ink-meta">
              {blocked ? "还没有可用模型" : hello?.label || "教你怎么配"}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {turns.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setTurns([]);
                setError("");
                inputRef.current?.focus();
              }}
              aria-label="重新开始"
              title="重新开始（这段问答就丢掉了）"
              className="p-1 text-ink-faint transition-colors duration-150 hover:text-ink"
            >
              <RefreshCw size={14} />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="收起助手"
            className="p-1 text-ink-faint transition-colors duration-150 hover:text-ink"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* 身：对话。独立滚动 */}
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4" data-scroll>
        {turns.length === 0 && (
          <Opening
            hello={hello?.hello ?? DEFAULT_HELLO}
            suggestions={blocked ? [] : hello?.suggestions ?? []}
            blocked={blocked}
            qq={qq}
            onPick={ask}
          />
        )}

        <div className="grid grid-cols-1 gap-4">
          {turns.map((t, i) => (
            <Bubble key={i} turn={t} />
          ))}
          {busy && <Typing />}
        </div>
      </div>

      {/* 脚：输入。回车发送，Shift+回车换行 */}
      <div className="shrink-0 border-t border-line px-4 py-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            disabled={blocked}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                ask(input);
              }
            }}
            placeholder={blocked ? "先去「连接」里配一个模型" : "问一句，比如「角色为什么不上线」"}
            className="max-h-28 min-h-[38px] w-full resize-none border-0 border-b border-line bg-transparent px-0 py-2 text-ui text-ink outline-none transition-colors duration-150 placeholder:text-ink-meta focus:border-ink disabled:text-ink-meta"
          />
          <button
            type="button"
            onClick={() => ask(input)}
            disabled={busy || blocked || !input.trim()}
            aria-label="发送"
            className="mb-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink text-paper-invert transition-colors duration-150 hover:bg-ink-hover disabled:opacity-30"
          >
            <ArrowUp size={15} />
          </button>
        </div>
        {error && <p className="mt-2 text-meta leading-relaxed text-warn">{error}</p>}
        {/*
         * 群号常驻在最底下。助手自己答不上来的时候也会说这个号，
         * 但那要等它先答一轮 —— 而「这程序压根跑不起来、助手也没模型可用」
         * 恰恰是最需要找人的时候，所以这行不依赖任何一次请求成功。
         */}
        <p className="mt-2 text-meta leading-relaxed text-ink-meta">
          详细图文教程：
          <a
            href={doc}
            target="_blank"
            rel="noreferrer"
            className="link-slide text-ink-faint"
          >
            Niki 写的那份
          </a>
          <br />
          答疑、反馈 BUG、许愿想要的功能：QQ 群{" "}
          <span className="font-mono text-ink-faint">{qq}</span>
        </p>
      </div>
    </div>
  );
}

/** 一条都没聊时的开场：一句话 + 几个点一下就发出去的问题。 */
function Opening({ hello, suggestions, blocked, qq, onPick }) {
  return (
    <div className="mb-4">
      <p className="text-meta leading-relaxed text-ink-soft">{hello}</p>

      {blocked && (
        <p className="mt-3 border-l-2 border-warn pl-3 text-meta leading-relaxed text-warn">
          现在还没有能用的聊天模型，所以我答不了 T^T 去「连接」里加一个服务商源、填上地址和密钥，
          给一个模型勾上「聊天」分类，再到「角色 → 模型」里选上它。
          卡住了就去 QQ 群 {qq} 问一声。
        </p>
      )}

      {suggestions.length > 0 && (
        <div className="mt-4 grid grid-cols-1 gap-2">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onPick(s)}
              className="rounded-item border border-line px-3 py-2 text-left text-meta leading-relaxed text-ink-soft transition-colors duration-150 hover:bg-sunken hover:text-ink"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 一条气泡。
 *
 * 用户那条靠右、深底反白（和「发送 → 预览」里那个 iMessage 模拟一个样式）；
 * 助手那条不画气泡，只是左边一条竖线 + 正文 —— 它经常是一串编号步骤，
 * 套进圆角气泡里会被挤成很窄的一条。
 */
function Bubble({ turn }) {
  if (turn.role === "user") {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-ink px-3.5 py-2 text-ui leading-relaxed text-paper-invert">
          {turn.content}
        </p>
      </div>
    );
  }
  return (
    <p
      className={`whitespace-pre-wrap break-words border-l-2 pl-3 text-ui leading-relaxed ${
        turn.failed ? "border-warn text-warn" : "border-line text-ink-soft"
      }`}
    >
      {turn.content}
    </p>
  );
}

/** 等回话时的三个点。和聊天预览里那个同一个动效。 */
function Typing() {
  return (
    <div className="inline-flex items-center gap-1 border-l-2 border-line pl-3">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-meta"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </div>
  );
}
