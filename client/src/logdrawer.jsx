/*
 * 常驻「运行日志」抽屉。
 *
 * 痛点：线下模式等 API 出字时，页面一片空白干等，分不清是「在慢慢生成」还是
 * 「API 已经断了」，只能切去「控制台」面板看日志。这个抽屉把同一份实时日志流
 * （全局 LogProvider 的 SSE，控制台面板也在用）钉在页面角落，任何分区都能看到，
 * 不用切 tab。
 *
 * 两个状态：
 *  - `open`：展开 / 收成胶囊。收起时只剩一个胶囊，显示连接状态和问题条数角标。
 *  - `pinned`：固定。打开过一次就记到 localStorage，下次进控制台自动展开。
 *
 * 和「控制台」面板的区别：那个是完整版（搜索、复制、清空、账号、服务控制…），
 * 这个是它的「随身缩略」——只取实时日志 + 链路状态，主打「不切页面也能盯着」。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, Pin, PinOff, Radio, Search, Terminal, Trash2, X } from "lucide-react";
import { useLogs } from "./store.jsx";
import { LEVEL_FILTERS, LEVEL_META, LEVEL_ORDER, LogRow } from "./panels/console.jsx";

const DRAWER_OPEN_KEY = "uranus.logdrawer.open.v1";
const DRAWER_PIN_KEY = "uranus.logdrawer.pinned.v1";

/** 读 localStorage 的布尔偏好，读不到按传入的默认值。 */
function readBool(key, fallback) {
  try {
    const v = window.localStorage.getItem(key);
    if (v === null) return fallback;
    return v === "1";
  } catch {
    return fallback;
  }
}

export function LiveLogDrawer() {
  const { logs, connected, paused, setPaused, pendingCount, clear } = useLogs();
  const [open, setOpen] = useState(() => readBool(DRAWER_OPEN_KEY, false));
  const [pinned, setPinned] = useState(() => readBool(DRAWER_PIN_KEY, false));
  const [level, setLevel] = useState("info");
  const [query, setQuery] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const boxRef = useRef(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(DRAWER_OPEN_KEY, open ? "1" : "0");
    } catch {
      /* 隐身模式：这一次照样展开，只是刷新后记不住 */
    }
  }, [open]);
  useEffect(() => {
    try {
      window.localStorage.setItem(DRAWER_PIN_KEY, pinned ? "1" : "0");
    } catch {
      /* 同上 */
    }
  }, [pinned]);

  const minRank = LEVEL_ORDER.indexOf(level);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return logs.filter((e) => {
      if (LEVEL_ORDER.indexOf(e.level) < minRank) return false;
      if (!q) return true;
      return (
        e.message.toLowerCase().includes(q) ||
        e.scope.toLowerCase().includes(q) ||
        (e.detail ?? "").toLowerCase().includes(q)
      );
    });
  }, [logs, minRank, query]);

  // 警告以上条数：收起时当角标，一眼看出「有没有出问题」
  const problemCount = useMemo(
    () =>
      logs.filter((e) => LEVEL_ORDER.indexOf(e.level) >= LEVEL_ORDER.indexOf("warn"))
        .length,
    [logs]
  );

  // 新日志进来贴到底（用户往上翻时不抢滚动条）
  useEffect(() => {
    if (!autoScroll || !open) return;
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [filtered, autoScroll, open]);

  function onScroll() {
    const box = boxRef.current;
    if (!box) return;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    setAutoScroll(atBottom);
  }

  function collapse() {
    setOpen(false);
    // 收起时一并取消固定：固定本意就是「一直展开」，收起说明不想一直展开了
    if (pinned) setPinned(false);
  }
  function togglePin() {
    setPinned((p) => {
      const next = !p;
      if (next) setOpen(true); // 钉上就立刻展开
      return next;
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="展开实时日志"
        className="fixed bottom-4 left-4 z-40 inline-flex items-center gap-2 rounded-full border border-line bg-paper px-3.5 py-2 text-ui shadow-lg transition-colors duration-150 hover:bg-sunken"
      >
        <Radio size={13} className={connected ? "text-good animate-pulse" : "text-warn"} />
        <span className="text-ink">实时日志</span>
        {!connected && <span className="text-eyebrow uppercase text-warn">· 断开</span>}
        {problemCount > 0 && (
          <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-warn px-1.5 text-[11px] font-medium text-white">
            {problemCount}
          </span>
        )}
      </button>
    );
  }

  return (
    <div className="fixed bottom-4 left-4 z-40 flex w-[min(440px,calc(100vw-2rem))] flex-col rounded-2xl border border-line bg-paper shadow-xl">
      {/* 头部：标题 + 链路状态 + 固定/收起 */}
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Terminal size={15} className="shrink-0 text-ink-meta" />
          <span className="truncate text-ui text-ink">运行日志</span>
          <span
            className={`inline-flex shrink-0 items-center gap-1 text-eyebrow uppercase ${
              connected ? "text-good" : "text-warn"
            }`}
          >
            <Radio size={11} className={connected ? "animate-pulse" : ""} />
            {connected ? "实时连接中" : "已断开，重连中…"}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={togglePin}
            aria-label={pinned ? "取消固定" : "固定（每次打开都展开）"}
            title={pinned ? "取消固定（每次打开都展开）" : "固定（每次打开都展开）"}
            className={`flex h-8 w-8 items-center justify-center rounded-item transition-colors duration-150 ${
              pinned ? "text-ink" : "text-ink-faint hover:bg-sunken hover:text-ink"
            }`}
          >
            {pinned ? <Pin size={14} strokeWidth={2} /> : <PinOff size={14} />}
          </button>
          <button
            type="button"
            onClick={collapse}
            aria-label="收起日志"
            title="收起日志"
            className="flex h-8 w-8 items-center justify-center rounded-item text-ink-faint transition-colors duration-150 hover:bg-sunken hover:text-ink"
          >
            <X size={15} />
          </button>
        </div>
      </div>

      {/* 工具条：级别筛选 + 搜索 + 暂停/清空 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <div className="flex items-center gap-0.5">
          {LEVEL_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setLevel(f.id)}
              className={`rounded-item px-2 py-1 text-meta transition-colors duration-150 ${
                level === f.id
                  ? "bg-sunken text-ink"
                  : "text-ink-meta hover:bg-sunken hover:text-ink"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex min-w-[120px] flex-1 items-center gap-1.5 border-b border-line pb-1 focus-within:border-ink">
          <Search size={13} className="shrink-0 text-ink-meta" />
          <input
            className="w-full bg-transparent text-meta text-ink outline-none placeholder:text-ink-meta"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索关键词…"
          />
        </div>
        <button
          type="button"
          onClick={() => setPaused(!paused)}
          className="inline-flex h-7 items-center gap-1 rounded-item px-2 text-meta text-ink-meta transition-colors duration-150 hover:bg-sunken hover:text-ink"
        >
          {paused ? <Play size={13} /> : <Pause size={13} />}
          {paused ? `继续${pendingCount ? `（+${pendingCount}）` : ""}` : "暂停"}
        </button>
        <button
          type="button"
          onClick={clear}
          disabled={!logs.length}
          className="inline-flex h-7 items-center gap-1 rounded-item px-2 text-meta text-ink-meta transition-colors duration-150 hover:bg-sunken hover:text-ink disabled:opacity-40"
        >
          <Trash2 size={13} /> 清空
        </button>
      </div>

      {/* 日志列表 */}
      <div className="relative">
        <div
          ref={boxRef}
          onScroll={onScroll}
          className="h-[300px] overflow-y-auto"
        >
          {filtered.length === 0 ? (
            <div className="flex h-full items-center justify-center px-6">
              <p className="max-w-[40ch] text-center text-meta leading-relaxed text-ink-faint">
                {logs.length === 0
                  ? "还没有日志。给线路号码发条 iMessage，或去「连接」点一下测试。"
                  : "当前筛选条件下没有日志。"}
              </p>
            </div>
          ) : (
            filtered.map((e) => <LogRow key={e.id} entry={e} />)
          )}
        </div>
        {!autoScroll && (
          <button
            type="button"
            onClick={() => {
              setAutoScroll(true);
              const box = boxRef.current;
              if (box) box.scrollTop = box.scrollHeight;
            }}
            className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 rounded-full border border-line bg-paper px-3 py-1.5 text-meta text-ink-soft shadow transition-colors duration-150 hover:bg-sunken hover:text-ink"
          >
            回到最新
          </button>
        )}
      </div>

      <p className="border-t border-line px-3 py-2 text-meta leading-relaxed text-ink-faint">
        后端实时日志。线下模式等生成时盯着这里：链路断了会先变红「已断开」，
        API 报错（超时 / 拒连 / 限流）会实时冒出来 —— 不用切去控制台面板。
      </p>
    </div>
  );
}
