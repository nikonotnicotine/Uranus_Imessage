/**
 * IG 里反复用到的小件：头像、圆环、按钮、时间、弹层。
 *
 * 全都只吐 `.ig-*` 类名（样式在 ig.css），不用 Tailwind 工具类 ——
 * 那样一来这几个组件就和控制台的设计令牌彻底断开，改 `--ink` 不会漏到 IG，
 * 改 `--ig-line` 也不会漏回控制台。
 */

import { useEffect } from "react";
import { BadgeCheck, Plus, X } from "lucide-react";

/** IG 图片的取图地址。文件名是 media/ 下的那个。 */
export function igMediaUrl(file) {
  return file ? `/api/ig/media/${encodeURIComponent(file)}` : "";
}

/**
 * 角色头像的取图地址。
 *
 * 两种来源：IG 主页自己设的（在 media/ 里），或者角色在 iMessage 那边的头像
 * （data URL 或外链，配置里存的原样）。`avatar.kind` 区分。
 */
export function avatarUrl(avatar) {
  if (!avatar?.value) return "";
  return avatar.kind === "ig" ? igMediaUrl(avatar.value) : avatar.value;
}

/**
 * 头像。没有图就显示名字首字 —— 比 IG 那个灰色小人剪影信息量大。
 *
 * @param {number} size 直径（px）。通过 CSS 变量传，因为 fallback 的字号要跟着它算
 */
export function Avatar({ avatar, name = "", size = 32, className = "", onClick }) {
  const url = avatarUrl(avatar);
  const style = { "--size": `${size}px` };
  const first = String(name || "?").trim().slice(0, 1);
  const cls = `ig-av ${className}`.trim();

  if (!url) {
    return (
      <div
        className={`${cls} ig-av-fallback`}
        style={style}
        onClick={onClick}
        role={onClick ? "button" : undefined}
        aria-label={onClick ? `${name} 的主页` : undefined}
      >
        {first}
      </div>
    );
  }
  return (
    <img
      className={cls}
      style={style}
      src={url}
      alt={name}
      onClick={onClick}
      role={onClick ? "button" : undefined}
    />
  );
}

/**
 * 带渐变圆环的头像（有快拍时）。
 *
 * `has=false` 时不套圆环直接吐头像 —— 套一个透明圆环会让尺寸差 4px，
 * 一排头像就对不齐了。
 */
export function RingAvatar({ avatar, name, size = 56, has = true, seen = false, onClick }) {
  if (!has) return <Avatar avatar={avatar} name={name} size={size} onClick={onClick} />;
  return (
    <span className="ig-ring" data-seen={seen ? "true" : "false"} onClick={onClick}>
      <Avatar avatar={avatar} name={name} size={size} />
    </span>
  );
}

/** 蓝勾。 */
export function Verified({ on }) {
  if (!on) return null;
  return <BadgeCheck className="ig-check" size={12} fill="currentColor" stroke="#fff" />;
}

/**
 * 「3 分钟前」这种。
 *
 * IG 的规则：1 分钟内是「刚刚」，然后分钟 → 小时 → 天 → 周，超过一周显示日期。
 * 快拍那边要的是「8小时」这种不带「前」的，所以给个 `bare`。
 */
export function timeAgo(iso, bare = false) {
  const at = Date.parse(iso ?? "");
  if (!Number.isFinite(at)) return "";
  const sec = Math.max(0, Math.floor((Date.now() - at) / 1000));
  const suffix = bare ? "" : "前";
  if (sec < 60) return bare ? "刚刚" : "刚刚";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分钟${suffix}`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}小时${suffix}`;
  const day = Math.floor(hour / 24);
  if (day < 7) return `${day}天${suffix}`;
  const week = Math.floor(day / 7);
  if (day < 30) return `${week}周${suffix}`;
  // 超过一个月显示日期（IG 是「9月12日」这种）
  const d = new Date(at);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 「1,234」这种千分位。计数里用。 */
export function fmtCount(n) {
  return String(Number(n) || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * 帖子/快拍的图片区。
 *
 * 三种情况：
 *  - 有真图 → 显示图
 *  - 只有描述（生图关着，或者还没生成）→ 显示**文字图**：描述当画面写在框里。
 *    用户明确要的这条，不然帖子就是个空框。
 *  - 一张都没有 → 不画这个区（纯文字帖子）
 */
export function Media({ images = [], index = 0 }) {
  const im = images[index];
  if (!im) return null;
  const url = igMediaUrl(im.file);
  if (!url) {
    return (
      <div className="ig-post-text-img" title="这张图还没生成，显示的是画面描述">
        {im.alt || "（没有画面描述）"}
      </div>
    );
  }
  return <img src={url} alt={im.alt || ""} />;
}

/** 轮播圆点。 */
export function Dots({ count, index }) {
  if (count < 2) return null;
  return (
    <div className="ig-dots">
      {Array.from({ length: count }, (_, i) => (
        <i key={i} data-on={i === index ? "true" : "false"} />
      ))}
    </div>
  );
}

/**
 * 弹层。
 *
 * Esc 关掉、点背板关掉 —— 和控制台的弹层一个交互，但样式走 `.ig-modal`。
 * 内容整块传进来，这个组件只管壳和关闭逻辑。
 *
 * `flush` 是给「整块内容自带边距」的情况用的（比如九宫格点进来的那条帖子，
 * 塞的是一整个 <Post>，它自己就是贴边的卡片）—— 这时候 body 那 16px 内边距
 * 会在帖子外面围一圈白边，看着像贴歪了。
 */
export function Modal({ title, onClose, children, foot, flush = false }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="ig-modal"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div className="ig-modal-box">
        <div className="ig-modal-head">
          <span>{title}</span>
          <button type="button" onClick={onClose} aria-label="关闭">
            <X size={20} />
          </button>
        </div>
        <div className="ig-modal-body" data-flush={flush ? "true" : "false"}>
          {children}
        </div>
        {foot ? <div className="ig-modal-foot">{foot}</div> : null}
      </div>
    </div>
  );
}

/**
 * 三点菜单（IG 那种居中一列按钮）。
 *
 * `items` 里每项 `{ label, onClick, danger }`。破坏性的标红 ——
 * 「删除帖子」和「编辑主页」长一样的话早晚点错。
 */
export function Sheet({ items = [], onClose }) {
  return (
    <div
      className="ig-modal"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div className="ig-sheet">
        {items.map((it) => (
          <button
            key={it.label}
            type="button"
            data-danger={it.danger ? "true" : "false"}
            onClick={() => {
              onClose?.();
              it.onClick?.();
            }}
          >
            {it.label}
          </button>
        ))}
        <button type="button" onClick={onClose}>
          取消
        </button>
      </div>
    </div>
  );
}

/** 一个带标签的输入框。编辑主页那八个字段全用它。 */
export function Field({ label, hint, value, onChange, area = false, ...rest }) {
  const Tag = area ? "textarea" : "input";
  return (
    <label className="ig-field">
      <span>{label}</span>
      <Tag
        value={value ?? ""}
        onChange={(e) => onChange?.(e.target.value)}
        rows={area ? 3 : undefined}
        {...rest}
      />
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

/** 空状态。IG 的空主页就是一个大标题加一句说明。 */
export function Empty({ title, children }) {
  return (
    <div className="ig-empty">
      <b>{title}</b>
      {children}
    </div>
  );
}

/** 「+ 新建」那个空心圈（精选那一排最后一个）。 */
export function NewCircle({ size = 77, label = "新建", onClick }) {
  return (
    <button type="button" className="ig-highlight" onClick={onClick}>
      <span
        className="ig-av ig-highlight-new ig-highlight-cover"
        style={{ "--size": `${size}px` }}
      >
        <Plus size={28} strokeWidth={1.5} />
      </span>
      <span className="ig-highlight-title">{label}</span>
    </button>
  );
}
