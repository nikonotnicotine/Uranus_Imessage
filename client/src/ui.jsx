/*
 * 全站复用控件。样式规范集中在这里，面板只管拼装。
 *
 * 改这个文件等于同时改十个面板，所以别往里加只有一处用到的东西。
 */

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ROLE_LABELS } from "./store.jsx";
import { Check, ChevronDown, ChevronUp, Copy, GripVertical, ShieldCheck, X } from "lucide-react";

/**
 * 唯一的入场动画：opacity + 8px translateY，350ms，只跑一次。
 *
 * 阈值 30%，`once` 之后就把 observer 断开 —— 回滚不重播。
 * 真正的动画在 index.css 的 .reveal 里，这里只负责加类名，
 * 这样 prefers-reduced-motion 那条媒体查询能一次盖住全部
 * （内联 style 的优先级会盖过媒体查询，所以不能写在这儿）。
 */
export function Reveal({ children, delay = 0, as: Tag = "div", className = "" }) {
  const ref = useRef(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || shown) return;
    // 没有 IntersectionObserver 就直接显示，不能让内容卡在 opacity: 0
    if (typeof IntersectionObserver !== "function") {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { threshold: 0.3 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shown]);

  return (
    <Tag
      ref={ref}
      className={`reveal ${shown ? "reveal-in" : ""} ${className}`}
      style={delay ? { "--reveal-delay": `${delay}ms` } : undefined}
    >
      {children}
    </Tag>
  );
}

/**
 * 星球图标。
 *
 * uranus-mark.png 由 `node scripts/make-favicon.mjs` 从 public/欢迎页.png 等比缩来，
 * 是**整张图**（球 + 竖环 + 左右声波 + 底部 URANUS 字样），方形、白底不透明。
 *
 * 不切圆：内切圆会削掉底部字样的两端和左右声波的尖。方形也不用衬托 ——
 * 页面底色就是纯白（--paper: 255 255 255），白底方图在上面看不出边。
 * 换句话说这个徽标只能待在白底上，挪到深色区域会露出一个白方块。
 */
export function UranusBadge({ size = 120, className = "" }) {
  return (
    <img
      src="/uranus-mark.png"
      alt="Uranus"
      draggable={false}
      width={size}
      height={size}
      className={`select-none ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

/** 表单标签：12px 大写眉标。字距 0.08em 让它在小字号下不糊成一团。 */
export function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="mb-2 flex flex-wrap items-baseline gap-x-2 text-eyebrow uppercase text-ink-faint">
        {label}
        {hint && <span className="normal-case tracking-normal text-ink-meta">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

/*
 * 输入框只有一条底边框，不是四边框。
 *
 * 四边框会在密集表单里画出一堆小盒子，和「表面靠 1px 线分隔」的原则打架；
 * 一条底线既标出可输入区域，又让整列表单在视觉上对齐成一叠横线。
 * 聚焦时底线转 #18181b —— 不用 ring，ring 是一圈发光的软阴影。
 */
export const inputCls =
  "w-full border-0 border-b border-line bg-transparent px-0 py-2 text-ui text-ink outline-none transition-colors duration-150 placeholder:text-ink-meta focus:border-ink";

/**
 * 一节内容。
 *
 * 以前是一张带边框和投影的卡，现在只是「一个 H2 + 内容」——
 * 节与节之间靠 83px 的垂直节奏分开，不靠盒子。
 *
 * `title` 顺带当章节锚点（`data-anchor`）：发送节奏 / 控制台这类没有条目的
 * 分区，260px 那栏列的就是这些标题，点一下滚到这儿。所以 nav.js 里
 * `anchors` 写的字符串必须和这里的 title 一字不差。
 */
export function Card({ title, desc, children, actions, accent }) {
  return (
    <section data-anchor={typeof title === "string" ? title : undefined} className="scroll-mt-8">
      {(title || actions) && (
        <div className="mb-8 flex items-start justify-between gap-6 border-b border-line pb-4">
          <div className="min-w-0 max-w-[62ch]">
            <h2 className="font-serif text-h2 text-ink">{title}</h2>
            {desc && <p className="mt-2 text-meta leading-relaxed text-ink-faint">{desc}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * 按钮。
 *
 * primary：#18181b 底 / #fafafa 字 / padding 8px 24px / 14px-500，直角。
 * outline（次要）：1px 描边 / 全圆角 / padding 6px 14px / 12px-400 ——
 * 规范里那条「次按钮」就是这个形状，胶囊形正好和方的主按钮区分开。
 * ghost：无边框的次要动作（撤销、关闭这类）。
 *
 * 没有投影、没有 active:scale —— 硬规则不许投影，位移属于「漂浮元素」。
 */
export function Button({ children, onClick, variant = "primary", disabled, type = "button", className = "" }) {
  /*
   * 桌面按高度按规范给（主 8/24、次 6/14），移动端补到 44px ——
   * 断点规则要求触摸目标 ≥44px，但桌面上 44px 的次要按钮会显得很笨重，
   * 所以用 min-h 在小屏单独抬，不动 padding（padding 变了字就不居中了）。
   */
  const base =
    "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap transition-colors duration-150 disabled:opacity-40 max-md:min-h-11";
  const styles = {
    // 主按钮是全站唯一保留 500 的地方：中文回落 YaHei 会显示成 400，
    // 但拉丁字（数字、英文标签）拿到 Inter 的真 500 —— 这正是换掉 Hedvig 的理由
    primary: "bg-ink px-6 py-2 text-ui font-medium text-paper-invert hover:bg-ink-hover",
    outline:
      "rounded-full border border-line bg-transparent px-3.5 py-1.5 text-meta text-ink-soft hover:bg-ink/[0.08] hover:text-ink",
    ghost: "rounded-full px-3.5 py-1.5 text-meta text-ink-soft hover:bg-ink/[0.08] hover:text-ink",
  };
  return (
    <button type={type} className={`${base} ${styles[variant]} ${className}`} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

export function Slider({ value, min, max, step, onChange }) {
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}

/** 消息身份标签。三种身份只靠字色和一条左边线区分，不用色块。 */
export function RoleBadge({ role }) {
  const styles = {
    system: "border-ink text-ink",
    assistant: "border-good text-good",
    user: "border-line text-ink-faint",
  };
  return (
    <span
      className={`inline-flex items-center border-l-2 pl-1.5 text-meta uppercase tracking-eyebrow ${
        styles[role] ?? styles.user
      }`}
    >
      {ROLE_LABELS[role] ?? role}
    </span>
  );
}

/* 深色模式已删除，ModeToggle 一并移除 —— 色板只定义了浅色一套。 */

/**
 * 一节内容里的小标题（H3 那一档）。
 * 眉标形状：12px 大写、字距 0.08em、下面一条 1px 线。
 */
export function Eyebrow({ children, className = "" }) {
  return (
    <p className={`text-eyebrow uppercase text-ink-faint ${className}`}>{children}</p>
  );
}

/**
 * 260px 面板的分组标签。内边距 16px 8px 8px 8px —— 上面留得比下面多，
 * 让它贴住自己那一组，而不是浮在两组中间。
 */
export function GroupLabel({ children, action }) {
  return (
    <div className="flex items-center justify-between gap-2 pb-2 pl-2 pr-1 pt-4">
      <span className="min-w-0 truncate text-meta text-ink-faint">{children}</span>
      {action}
    </div>
  );
}

/**
 * 260px 面板里的一行。
 *
 * 32px 高、6px 圆角、左右 8px；左边 16px 图标、中间 14px 单行截断、
 * 右边 12px 灰色数字元数据。悬停和激活都是 #f4f4f5 的底 ——
 * 没有边框、没有位移，所以一列几十行扫下来不会抖。
 *
 * 密度豁免只对侧边栏成立（硬规则里写明的），所以这里可以又密又带图标。
 */
export function ListItem({ icon: Icon, label, meta, active, onClick, title }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title ?? label}
      aria-current={active ? "true" : undefined}
      className={`flex h-8 w-full items-center gap-2 rounded-item px-2 text-left transition-colors duration-150 ${
        active ? "bg-sunken text-ink" : "text-ink hover:bg-sunken"
      }`}
    >
      {Icon && <Icon size={16} className="shrink-0 text-ink-faint" />}
      <span className="min-w-0 flex-1 truncate text-ui">{label}</span>
      {meta && <span className="shrink-0 text-meta text-ink-meta">{meta}</span>}
    </button>
  );
}

/**
 * 测试结果 / 错误提示条。
 *
 * 左边一条 2px 竖线代替以前的整块底色 —— 状态色留着（它承载真信息），
 * 但不再刷一大片浅底，那种色块在纯白页面上会变成装饰。
 */
export function ResultNote({ state, message, icon: Icon = ShieldCheck }) {
  if (state === "idle") return null;
  return (
    <div
      className={`flex items-start gap-2 border-l-2 py-1.5 pl-3 text-meta ${
        state === "ok"
          ? "border-good text-good"
          : state === "fail"
          ? "border-warn text-warn"
          : "border-line text-ink-soft"
      }`}
    >
      <Icon size={14} className="mt-0.5 shrink-0" />
      <span className="min-w-0 whitespace-pre-wrap break-words">{message}</span>
    </div>
  );
}

/**
 * 小开关。方形轨道 + 方形滑块 —— 全站只有两档圆角（列表项 6px、次按钮胶囊形），
 * 圆头开关会凭空多出第三种形状。开 = 实心 #18181b，关 = 1px 描边。
 */
export function Switch({ checked, onChange, label }) {
  /*
   * 视觉上是 32×16 的方块，但断点规则要求触摸目标 ≥44px。
   * 用一个透明的 ::before 把命中区在移动端撑到 44×44 ——
   * 绝对定位不占布局，开关本身的尺寸和对齐一点不变。
   */
  const touchTarget =
    "max-md:before:absolute max-md:before:left-1/2 max-md:before:top-1/2 max-md:before:h-11 max-md:before:w-11 max-md:before:-translate-x-1/2 max-md:before:-translate-y-1/2 max-md:before:content-['']";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-4 w-8 shrink-0 border transition-colors duration-150 ${touchTarget} ${
        checked ? "border-ink bg-ink" : "border-line bg-transparent hover:border-ink-faint"
      }`}
    >
      <span
        className={`absolute top-[2px] h-[10px] w-[10px] transition-colors duration-150 ${
          checked ? "left-[18px] bg-paper-invert" : "left-[2px] bg-ink-faint"
        }`}
      />
    </button>
  );
}

/**
 * 居中弹窗的壳：ESC 关、点遮罩关。
 *
 * `maxWidth` 是给快速配置向导开的口子 —— 它一屏要摊开 Photon 那五步引导加
 * 终端命令，576px（max-w-xl）里横向滚不动。默认值不变，别处一个字都不用改。
 */
export function Modal({ title, desc, onClose, children, footer, maxWidth = "max-w-xl" }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      /*
       * 只压暗，不做背景模糊。
       *
       * 这里原来挂着 backdrop-blur-sm，但它罩的是整页 —— 而 body 底下铺着
       * background-attachment: fixed 的壁纸和一层 fixed 的白遮罩。全屏毛玻璃
       * 会让合成器在每一次重绘时把底下这些重新模糊一遍，弹窗里每敲一个字、
       * 每翻一个开关都要走一趟，输入明显发涩。压暗一层的观感差别很小，
       * 但省掉的是每帧一次全屏模糊。
       */
      className="fixed inset-0 z-40 flex items-end justify-center bg-ink/25 sm:items-center sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`flex max-h-[86vh] w-full ${maxWidth} flex-col overflow-hidden border border-line bg-paper`}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-4">
          <div className="min-w-0">
            <h3 className="font-serif text-h3 text-ink">{title}</h3>
            {desc && <p className="mt-1 text-meta leading-relaxed text-ink-faint">{desc}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="shrink-0 p-1 text-ink-faint transition-colors duration-150 hover:text-ink"
          >
            <X size={18} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-3 border-t border-line px-6 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/** 默认折叠的区块。展开才能输入 —— 详情页不想一上来就堆满输入框。 */
export function Fold({ title, desc, defaultOpen = false, children, badge }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-t border-line">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-4 py-4 text-left transition-colors duration-150 hover:text-ink"
      >
        <span className="min-w-0">
          <span className="flex flex-wrap items-baseline gap-2">
            <span className="font-serif text-h3 text-ink">{title}</span>
            {badge && (
              <span className="text-eyebrow uppercase text-ink-meta">{badge}</span>
            )}
          </span>
          {desc && <span className="mt-1 block text-meta leading-relaxed text-ink-faint">{desc}</span>}
        </span>
        <ChevronDown
          size={16}
          className={`shrink-0 text-ink-faint transition-transform duration-150 ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && <div className="pb-8">{children}</div>}
    </section>
  );
}

/**
 * 一行可拖动的条目壳。
 *
 * 没上拖拽库（package.json 里只有 react + lucide），用原生 HTML5 拖放实现。
 * 同时每行给 ↑/↓ 按钮 —— 触屏和键盘用户拖不了，得有第二条路。
 *
 * `draggable` 只挂在左边那个握把上，**不挂整行** —— 挂整行的话在条目里
 * 按住不放想选文字会直接进入拖拽，一个字也选不中。整行仍然是放置目标。
 */
export const DragHandleCtx = createContext(null);

export function DragRow({ index, id, onReorder, children, className = "" }) {
  const [over, setOver] = useState(false);

  const handle = useMemo(
    () => ({
      draggable: true,
      onDragStart: (e) => {
        e.dataTransfer.setData("text/plain", id);
        e.dataTransfer.effectAllowed = "move";
      },
    }),
    [id]
  );

  return (
    <DragHandleCtx.Provider value={handle}>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const dragged = e.dataTransfer.getData("text/plain");
          if (dragged && dragged !== id) onReorder(dragged, index);
        }}
        className={`${className} ${over ? "border-ink" : ""}`}
      >
        {children}
      </div>
    </DragHandleCtx.Provider>
  );
}

/** DragRow 里唯一能拖的那一小块。放在行首，视觉上就是个握把。 */
export function DragHandle({ className = "" }) {
  const handle = useContext(DragHandleCtx);
  return (
    <span
      {...handle}
      aria-hidden
      className={`cursor-grab active:cursor-grabbing ${className}`}
    >
      <GripVertical size={15} />
    </span>
  );
}

/** ↑↓ 一对小按钮。第一行的 ↑ 和最后一行的 ↓ 禁用。 */
export function MoveButtons({ onUp, onDown, first, last }) {
  const cls =
    "rounded-item p-1 text-ink-faint transition-colors duration-150 hover:bg-sunken hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent";
  return (
    <div className="flex shrink-0 flex-col">
      <button type="button" onClick={onUp} disabled={first} aria-label="上移" className={cls}>
        <ChevronUp size={14} />
      </button>
      <button type="button" onClick={onDown} disabled={last} aria-label="下移" className={cls}>
        <ChevronDown size={14} />
      </button>
    </div>
  );
}

/** 时间戳 → 「今天 14:03」这种。 */
export function fmtStamp(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return sameDay ? `今天 ${hm}` : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

export function NumberField({ label, value, min, max, step, onChange, hint, suffix }) {
  return (
    <Field label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className={`${inputCls} !w-24`}
        />
        {suffix && <span className="text-meta text-ink-faint">{suffix}</span>}
      </div>
    </Field>
  );
}

/** 带复制按钮的代码块。 */
export function CodeBlock({ code }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* 剪贴板不可用就算了，用户还能手动选中 */
    }
  }

  return (
    <div className="relative">
      <pre className="overflow-x-auto border border-line bg-paper px-3.5 py-3 pr-12 text-meta leading-relaxed text-ink-soft">
        <code>{code}</code>
      </pre>
      <button
        type="button"
        onClick={copy}
        title="复制"
        className="absolute right-2 top-2 rounded-item border border-line p-1.5 text-ink-faint transition-colors duration-150 hover:text-ink"
      >
        {copied ? <Check size={14} className="text-good" /> : <Copy size={14} />}
      </button>
    </div>
  );
}
