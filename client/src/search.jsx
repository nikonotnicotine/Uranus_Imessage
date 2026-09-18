/*
 * 顶部搜索栏：一个框，把侧边栏那一排分区和它们下面的条目都能搜出来。
 *
 * ── 索引从哪来 ──
 *
 * 全部来自 nav.js，不另存一份。分区本身的 label / desc、每个分区
 * `sectionGroups(section, config)` 摊出来的条目 label、以及 anchors（发送 /
 * 控制台那两个只有一屏表单的分区，列的是章节标题）。
 *
 * `live: true` 的那几组（上下文的会话列表、图库的表情包）条目是面板自己拉接口
 * 上报的，外壳这一层拿不到，所以**只索引分区本身**。搜「上下文」能跳过去，
 * 搜某一条会话的号码搜不到 —— 那份列表在分区里面，进去就能看见。
 *
 * ── 为什么是子串匹配 ──
 *
 * 分区就十几个，条目加起来通常几十条，全在内存里。模糊匹配（打错一个字也能
 * 命中）在这个量级上带来的只有误命中：搜「角色」不该冒出「预设」。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Search as SearchIcon, X } from "lucide-react";
import { NAV, sectionGroups } from "./nav.js";

/** 最多显示这么多条。再多就该缩小关键词了，列一屏滚不动的东西没用。 */
const MAX_HITS = 12;

/**
 * 把 NAV 摊成一张平表。
 *
 * 每一条：{ key, sectionId, itemId, anchor, label, sub }
 *  - 分区自己：itemId 和 anchor 都空，点了就切过去
 *  - 条目：带 itemId，点了切过去并选中那一条
 *  - 章节锚点：带 anchor，点了切过去并滚到那一节
 */
function buildIndex(config) {
  const out = [];
  for (const section of NAV) {
    out.push({
      key: `s:${section.id}`,
      sectionId: section.id,
      itemId: "",
      anchor: "",
      label: section.label,
      sub: "分区",
      // desc 参与匹配但不显示 —— 搜「气泡」能找到「发送」，而那个词在 desc 里
      text: `${section.label} ${section.desc ?? ""}`,
    });

    for (const a of section.anchors ?? []) {
      out.push({
        key: `a:${section.id}:${a}`,
        sectionId: section.id,
        itemId: "",
        anchor: a,
        label: a,
        sub: section.label,
        text: a,
      });
    }

    /*
     * 条目。live 传 undefined —— 那几组的内容外壳拿不到（见文件头），
     * sectionGroups 会给回空数组，正是我们要的。
     */
    for (const g of sectionGroups(section, config, undefined)) {
      for (const it of g.items) {
        out.push({
          key: `i:${section.id}:${it.id}`,
          sectionId: section.id,
          itemId: it.id,
          anchor: "",
          label: it.label,
          sub: `${section.label} · ${g.label ?? ""}`.replace(/ · $/, ""),
          text: it.label,
        });
      }
    }
  }
  return out;
}

/**
 * 顶部搜索栏。
 *
 * @param {object} props
 * @param {object} props.config 当前配置，条目列表从它摊出来
 * @param {(sectionId: string, itemId: string, anchor: string) => void} props.onJump
 */
export function GlobalSearch({ config, onJump }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const boxRef = useRef(null);
  const inputRef = useRef(null);

  const index = useMemo(() => buildIndex(config), [config]);

  const hits = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    const scored = [];
    for (const row of index) {
      const label = row.label.toLowerCase();
      const at = label.indexOf(needle);
      if (at >= 0) {
        // 名字开头命中的排前面，其次是名字里命中的
        scored.push({ row, rank: at === 0 ? 0 : 1, at });
      } else if (row.text.toLowerCase().includes(needle)) {
        // 只在 desc 里命中的垫底
        scored.push({ row, rank: 2, at: 0 });
      }
    }
    scored.sort((a, b) => a.rank - b.rank || a.at - b.at);
    return scored.slice(0, MAX_HITS).map((s) => s.row);
  }, [index, q]);

  // 关键词一变，光标回到第一条 —— 否则回车会跳到上一批结果里的位置
  useEffect(() => setCursor(0), [q]);

  /*
   * 全局快捷键：`/` 或 Ctrl/Cmd+K 聚焦。
   *
   * `/` 那一路必须先看焦点在哪 —— 用户正在某个输入框里打字时，那个斜杠
   * 是他要输入的内容（人设里全是 `/`），不是快捷键。
   */
  useEffect(() => {
    const onKey = (e) => {
      const el = document.activeElement;
      const typing =
        el instanceof HTMLElement &&
        (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
        return;
      }
      if (e.key === "/" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // 点到外面就收起来
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (!boxRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function jump(row) {
    if (!row) return;
    onJump?.(row.sectionId, row.itemId, row.anchor);
    setOpen(false);
    setQ("");
    inputRef.current?.blur();
  }

  function onKeyDown(e) {
    if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (!hits.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => (c + 1) % hits.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => (c - 1 + hits.length) % hits.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      jump(hits[cursor]);
    }
  }

  const showList = open && Boolean(q.trim());

  return (
    <div ref={boxRef} className="relative">
      {/*
       * 宽度写死在这一行上（不是写在 input 上），这样即使框里没字，
       * 它也是一个看得见的、有下划线的框 —— 而不是一个孤零零的放大镜。
       */}
      <div className="flex w-28 items-center gap-2 border-b border-line focus-within:border-ink sm:w-40 lg:w-52">
        <SearchIcon size={14} className="shrink-0 text-ink-faint" />
        <input
          ref={inputRef}
          type="search"
          value={q}
          placeholder="搜索…"
          aria-label="搜索分区和条目"
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          /*
           * 一直摊开，窄屏也摊开。
           *
           * 原来这儿是 `w-0` + `focus:w-40`：不聚焦就缩成零宽，为的是别把标题
           * 挤到换行。代价是手机上整个搜索栏看起来只是标题旁边的一个小图标，
           * 没有框、没有「搜索…」这三个字，根本认不出来是能点的 —— 一个找不到
           * 的搜索栏等于没有。宁可标题在极窄的屏上折一行。
           *
           * `min-w-0`：右边那个清空按钮冒出来时，flex 默认不肯把 input 压到
           * 内容宽度以下，不写这句框会被顶出去。
           */
          className="w-full min-w-0 bg-transparent py-2 text-ui text-ink outline-none placeholder:text-ink-meta [&::-webkit-search-cancel-button]:hidden"
        />
        {q && (
          <button
            type="button"
            onClick={() => {
              setQ("");
              inputRef.current?.focus();
            }}
            aria-label="清空搜索"
            className="shrink-0 text-ink-meta transition-colors duration-150 hover:text-ink"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {showList && (
        <div className="absolute right-0 top-full z-30 mt-1 max-h-[60vh] w-[min(20rem,80vw)] overflow-y-auto border border-line bg-paper py-1 shadow-sm" data-scroll>
          {hits.length === 0 && (
            <p className="px-3 py-3 text-meta leading-relaxed text-ink-meta">
              没找到「{q.trim()}」。会话记录和表情包标签要进对应分区里搜。
            </p>
          )}
          {hits.map((row, i) => (
            <button
              key={row.key}
              type="button"
              // 鼠标划过时把光标带过去，免得键盘和鼠标各高亮一条
              onMouseEnter={() => setCursor(i)}
              onClick={() => jump(row)}
              className={`flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left transition-colors duration-150 ${
                i === cursor ? "bg-sunken" : "hover:bg-sunken"
              }`}
            >
              <span className="min-w-0 truncate text-ui text-ink">{row.label}</span>
              <span className="shrink-0 text-meta text-ink-faint">{row.sub}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
