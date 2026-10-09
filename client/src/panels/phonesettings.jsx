import { useEffect, useRef, useState } from "react";
import {
  AppWindow,
  BellRing,
  BookOpenText,
  Check,
  ChevronRight,
  Cpu,
  Layers,
  Loader2,
  Minus,
  Palette,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload,
  Wallpaper,
} from "lucide-react";
import { modelLabel, modelOptions, parseRefValue, providerLabel, refValue } from "../labels.js";
import { useConfig } from "../store.jsx";
import { AppIcon, Avatar, BackGlass, Card27, Scroll, TopBar, WALLPAPERS } from "./phoneos.jsx";

/**
 * 手机里的「设置」App —— 查手机的所有设置都在这儿（用户要的：别把查手机那一页弄乱，
 * 手机和电脑上都好用）。照 iOS 27 的设置画：大圆角分组、彩色小方块图标、点进去是二级页。
 *
 * 两类东西存的地方不一样，但在这儿都是**改了就生效**：
 *  - 这个角色的开关、全局的查手机设置在 config 里 —— 改完防抖 0.8 秒自动保存（PUT /api/config）
 *  - 世界书勾选、壁纸、图标在 data/phone/ 里 —— 直接打接口
 */

const LAYOUT_NAMES = { generic: "通用卡片", shop: "购物", feed: "社交动态", forum: "论坛", novel: "小说" };
const SKIN_ROWS = [
  ["shop", "购物"],
  ["delivery", "外卖"],
  ["video", "视频"],
];

/** 图片压一下再传：壁纸最长边 1290 的 JPEG，图标 256 的正方形 PNG。 */
function compress(file, kind) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      const g = c.getContext("2d");
      if (kind === "icon") {
        const s = Math.min(img.width, img.height);
        c.width = c.height = 256;
        g.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 256, 256);
        resolve(c.toDataURL("image/png"));
      } else {
        const k = Math.min(1, 1290 / Math.max(img.width, img.height));
        c.width = Math.round(img.width * k);
        c.height = Math.round(img.height * k);
        g.drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL("image/jpeg", 0.85));
      }
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => reject(new Error("这张图读不出来"));
    img.src = URL.createObjectURL(file);
  });
}

/* ---------------- iOS 设置的零件 ---------------- */

function Tile({ icon: I, color }) {
  return (
    <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[8px]" style={{ background: color }}>
      <I size={18} className="text-white" strokeWidth={2.2} />
    </span>
  );
}

function SetRow({ icon, color, label, value, onClick, last, danger, right, children }) {
  return (
    <div onClick={onClick} className={`relative flex min-h-[52px] items-center gap-3 px-4 py-2.5 ${onClick ? "cursor-pointer active:bg-black/[0.06]" : ""}`}>
      {icon && <Tile icon={icon} color={color} />}
      <div className="min-w-0 flex-1">
        <p className={`text-[17px] ${danger ? "text-[#ff3b30]" : "text-black"}`}>{label}</p>
        {children}
      </div>
      {value != null && <span className="max-w-[150px] truncate text-[17px] text-[#8e8e93]">{value}</span>}
      {right}
      {onClick && !right && <ChevronRight size={18} className="shrink-0 text-[#c7c7cc]" />}
      {!last && <span className="absolute bottom-0 right-0 h-px bg-[#c6c6c8]/60" style={{ left: icon ? 58 : 16 }} />}
    </div>
  );
}

function Toggle({ on, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!on);
      }}
      className={`relative h-[31px] w-[51px] shrink-0 rounded-full transition-colors ${on ? "bg-[#34c759]" : "bg-[#e9e9eb]"}`}
    >
      <span className={`absolute top-[2px] h-[27px] w-[27px] rounded-full bg-white shadow-[0_2px_4px_rgba(0,0,0,.2)] transition-all ${on ? "left-[22px]" : "left-[2px]"}`} />
    </button>
  );
}

/**
 * `edit`：数字本身也能点进去直接敲。
 *
 * 量程跨好几个数量级的那种（「每轮最多带」最大 99999 字）光靠加减按钮没法用 ——
 * 一步 50 字，从默认值点到头要两千下。草稿存在本地 state 里，敲的中途不往上报，
 * 失焦/回车才 clamp 提交：不然打「1200」会在输入到「1」的那一刻被 min 顶成 50。
 */
function Stepper({ value, min, max, step = 1, onChange, suffix, edit = false }) {
  const set = (v) => onChange(Math.min(max, Math.max(min, v)));
  const [draft, setDraft] = useState(null);
  const commit = () => {
    const n = Number(String(draft ?? "").replace(/[^\d]/g, ""));
    setDraft(null);
    if (draft !== null && Number.isFinite(n) && n > 0) set(n);
  };
  return (
    <span className="flex items-center gap-2">
      {edit ? (
        <span className="text-right text-[17px] text-[#8e8e93]">
          <input
            className="w-[72px] bg-transparent text-right outline-none"
            inputMode="numeric"
            value={draft ?? String(value)}
            onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, "").slice(0, 6))}
            onFocus={(e) => e.target.select()}
            onBlur={commit}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            aria-label="直接输入"
          />
          {suffix}
        </span>
      ) : (
        <span className="min-w-[56px] text-right text-[17px] text-[#8e8e93]">
          {value}
          {suffix}
        </span>
      )}
      <span className="flex h-[32px] overflow-hidden rounded-[9px] bg-[#767680]/[0.12]">
        <button type="button" onClick={() => set(value - step)} className="flex w-[46px] items-center justify-center border-r border-[#c6c6c8]/60" aria-label="减">
          <Minus size={18} />
        </button>
        <button type="button" onClick={() => set(value + step)} className="flex w-[46px] items-center justify-center" aria-label="加">
          <Plus size={18} />
        </button>
      </span>
    </span>
  );
}

function Section({ title, foot, children }) {
  return (
    <div className="mb-6">
      {title && <p className="px-8 pb-1.5 text-[14px] uppercase text-[#6d6d72]">{title}</p>}
      <Card27>{children}</Card27>
      {foot && <p className="px-8 pt-1.5 text-[13px] leading-snug text-[#6d6d72]">{foot}</p>}
    </div>
  );
}

function Page({ title, onBack, children }) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-[#f2f2f7]">
      <TopBar left={<BackGlass onClick={onBack} />} title={title} />
      <Scroll pad={50} className="pt-2">
        {children}
      </Scroll>
    </div>
  );
}

/** 一个 iOS 风格的选择行：看着是一行，实际是一个透明的原生 <select> 盖在上面。 */
function SelectRow({ label, value, display, options, onChange, last }) {
  return (
    <div className="relative flex min-h-[52px] items-center gap-3 px-4">
      <p className="flex-1 text-[17px] text-black">{label}</p>
      <span className="max-w-[190px] truncate text-[17px] text-[#8e8e93]">{display}</span>
      <ChevronRight size={18} className="shrink-0 text-[#c7c7cc]" />
      <select className="absolute inset-0 cursor-pointer opacity-0" value={value} onChange={(e) => onChange(e.target.value)}>
        {options}
      </select>
      {!last && <span className="absolute bottom-0 left-4 right-0 h-px bg-[#c6c6c8]/60" />}
    </div>
  );
}

/* ---------------- 主体 ---------------- */

export function SettingsApp({ close, role, data, apps, running, onGenerate, onBooks, onAsset, wallpaper, setWallpaper }) {
  const { config, updateConfig, updateRole, save, saveState } = useConfig();
  const [page, setPage] = useState("main");
  const [confirmReset, setConfirmReset] = useState(false);
  const [err, setErr] = useState("");
  const fileRef = useRef(null);
  const pending = useRef(null); // 等着传的那张图要给谁：{kind, appId?}

  // 改 config 之后防抖自动保存
  const timer = useRef(null);
  const autosave = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => save().catch(() => {}), 800);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    if (!confirmReset) return undefined;
    const t = setTimeout(() => setConfirmReset(false), 4000);
    return () => clearTimeout(t);
  }, [confirmReset]);

  const s = config.phone ?? {};
  const p = role.phone ?? {};
  const patchPhone = (patch) => {
    updateConfig((c) => ({ ...c, phone: { ...(c.phone ?? {}), ...patch } }));
    autosave();
  };
  const patchRole = (patch) => {
    updateRole(role.id, { phone: { ...p, ...patch } });
    autosave();
  };
  const batch = s.batchApps ?? ["contacts", "call", "shop", "delivery"];
  const custom = s.customApps ?? [];
  const genApps = apps.filter((a) => a.id !== "settings");
  const skins = data.skins ?? {};
  const generating = running.length > 0;
  const total = Object.values(data.apps ?? {}).reduce((n, l) => n + (l?.length ?? 0), 0);

  const pickImage = (target) => {
    pending.current = target;
    setErr("");
    fileRef.current?.click();
  };
  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !pending.current) return;
    try {
      const dataUrl = await compress(file, pending.current.kind);
      await onAsset({ ...pending.current, dataUrl });
    } catch (x) {
      setErr(String(x?.message ?? x));
    }
  };

  const fileInput = <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFile} />;
  const errNote = err && <p className="px-8 pb-4 text-[14px] text-[#ff3b30]">{err}</p>;
  const back = () => setPage("main");

  if (page === "batch") {
    return (
      <Page title="一次生成" onBack={back}>
        <Section foot="勾上的 App 在一次请求里一起生成（人设和聊天只发一遍，比一个个刷省）。/查手机 指令也用这一组。">
          {genApps.map((a, i) => (
            <SetRow key={a.id} label={a.name} last={i === genApps.length - 1} right={<Toggle on={batch.includes(a.id)} onChange={(v) => patchPhone({ batchApps: v ? [...batch, a.id] : batch.filter((x) => x !== a.id) })} label={a.name} />} />
          ))}
        </Section>
      </Page>
    );
  }

  if (page === "books") {
    const books = data.bookIds ?? [];
    return (
      <Page title="世界书" onBack={back}>
        <Section foot="只列这个角色关联的那几本（挂在角色上的 + 全局的）。勾哪几本，生成时带哪几本。">
          {!data.books.length && <SetRow label="这个角色没有关联任何世界书" last />}
          {data.books.map((b, i) => (
            <SetRow
              key={b.id}
              label={b.name || "未命名世界书"}
              value={b.global ? "全局" : null}
              last={i === data.books.length - 1}
              right={<Toggle on={books.includes(b.id)} onChange={(v) => onBooks(v ? [...books, b.id] : books.filter((x) => x !== b.id))} label={b.name} />}
            />
          ))}
        </Section>
      </Page>
    );
  }

  if (page === "sync") {
    return (
      <Page title="同步与指令" onBack={back}>
        <Section foot="之后聊天时把最近一次查手机压成几行摘要告诉角色。只进当轮请求、不进存档，每轮固定多下面这么多字（数字能直接点进去敲），过了时效就不再带。">
          <SetRow label="同步到私聊" right={<Toggle on={Boolean(p.injectChat)} onChange={(v) => patchRole({ injectChat: v })} label="同步到私聊" />} last={!p.injectChat} />
          {p.injectChat && (
            <>
              <SetRow label="每轮最多带" right={<Stepper edit value={p.injectChars ?? 3000} min={50} max={99999} step={50} suffix="字" onChange={(v) => patchRole({ injectChars: v })} />} />
              <SetRow label="生成后多久内带" last right={<Stepper value={p.injectHours ?? 24} min={1} max={720} step={1} suffix="时" onChange={(v) => patchRole({ injectHours: v })} />} />
            </>
          )}
        </Section>
        <Section foot={p.toDiary && !role.memories?.diary?.enabled ? "这个角色的日记没开，这条暂时不起作用（在「角色 → 单独配置 → 记忆库」里开）。" : "每次生成完往日记流水里记一行，角色写日记时能顺带写到手机里的事。"}>
          <SetRow label="同步到日记待总结" last right={<Toggle on={Boolean(p.toDiary)} onChange={(v) => patchRole({ toDiary: v })} label="同步到日记" />} />
        </Section>
        <Section foot="在 iMessage 里发 /查手机，按「一次生成」那一组接着翻一次，结果回你一条消息（不进上下文）。">
          <SetRow label="允许 /查手机 指令" last right={<Toggle on={Boolean(p.command)} onChange={(v) => patchRole({ command: v })} label="查手机指令" />} />
        </Section>
      </Page>
    );
  }

  if (page === "wallpaper") {
    return (
      <Page title="墙纸" onBack={back}>
        {fileInput}
        {errNote}
        <Section title="自己的图" foot="只给这个角色的手机用。图会压到最长边 1290 像素再存。">
          <SetRow label="选择图片…" onClick={() => pickImage({ kind: "wallpaper" })} right={<Upload size={19} className="text-[#007aff]" />} last={!data.wallpaperImage} />
          {data.wallpaperImage && <SetRow label="移除自己的图" danger last onClick={() => onAsset({ kind: "wallpaper", dataUrl: "" })} right={<Trash2 size={18} className="text-[#ff3b30]" />} />}
        </Section>
        <Section title="预设" foot={data.wallpaperImage ? "现在用的是自己的图；移除之后才会用预设。" : "预设只存在这个浏览器里。"}>
          <div className="grid grid-cols-4 gap-3 p-4">
            {Object.entries(WALLPAPERS).map(([id, w]) => (
              <button key={id} type="button" onClick={() => setWallpaper(id)} className="flex flex-col items-center gap-1.5">
                <span className={`relative block aspect-[9/19.5] w-full rounded-[12px] ${wallpaper === id && !data.wallpaperImage ? "ring-[3px] ring-[#007aff] ring-offset-2" : ""}`} style={{ background: w.css }} />
                <span className="text-[13px] text-black">{w.name}</span>
              </button>
            ))}
          </div>
        </Section>
      </Page>
    );
  }

  if (page === "skins") {
    const opts = data.skinOptions ?? {};
    return (
      <Page title="App 样式" onBack={back}>
        {SKIN_ROWS.map(([k, label]) => (
          <Section key={k} title={label} foot={k === "video" ? "桌面上的名字和 App 里的界面跟着换；生成时也会告诉模型是哪个平台。" : null}>
            {Object.entries(opts[k] ?? {}).map(([id, name], i, arr) => (
              <SetRow
                key={id}
                label={name}
                last={i === arr.length - 1}
                onClick={() => patchPhone({ skins: { ...(s.skins ?? {}), [k]: id } })}
                right={skins[k] === id ? <Check size={20} className="text-[#007aff]" strokeWidth={2.6} /> : <span />}
              />
            ))}
          </Section>
        ))}
      </Page>
    );
  }

  if (page === "icons") {
    return (
      <Page title="App 图标" onBack={back}>
        {fileInput}
        {errNote}
        <Section foot="可以换成自己存的图标（比如真 App 的图标截图），会裁成正方形、压到 256 像素。所有角色的手机共用。">
          {genApps
            .filter((a) => a.id !== "incognito")
            .concat(apps.filter((a) => a.id === "settings"))
            .map((a, i, arr) => (
              <div key={a.id} className="relative flex min-h-[64px] items-center gap-3 px-4 py-2">
                <AppIcon app={a} size={44} label={false} image={data.icons?.[a.id]} skin={skins[a.id]} />
                <span className="flex-1 text-[17px] text-black">{a.name}</span>
                {data.icons?.[a.id] && (
                  <button type="button" onClick={() => onAsset({ kind: "icon", appId: a.id, dataUrl: "" })} className="text-[15px] text-[#ff3b30]">
                    还原
                  </button>
                )}
                <button type="button" onClick={() => pickImage({ kind: "icon", appId: a.id })} className="text-[15px] text-[#007aff]">
                  更换
                </button>
                {i < arr.length - 1 && <span className="absolute bottom-0 left-[72px] right-0 h-px bg-[#c6c6c8]/60" />}
              </div>
            ))}
        </Section>
      </Page>
    );
  }

  if (page === "gen") {
    const groups = modelOptions(config, "chat");
    const cur = refValue(s.model);
    const curLabel = (() => {
      if (!cur) return "角色自己的";
      for (const g of groups) for (const m of g.models) if (`${g.provider.id}::${m.id}` === cur) return modelLabel(m);
      return "已失效";
    })();
    return (
      <Page title="生成" onBack={back}>
        <Section foot="不选 = 用这个角色自己的聊天模型（失败会退到它的副 API）。">
          <SelectRow
            label="模型"
            value={cur}
            display={curLabel}
            last
            onChange={(v) => patchPhone({ model: parseRefValue(v) })}
            options={
              <>
                <option value="">角色自己的</option>
                {groups.map((g) => (
                  <optgroup key={g.provider.id} label={providerLabel(g.provider)}>
                    {g.models.map((m) => (
                      <option key={m.id} value={`${g.provider.id}::${m.id}`}>
                        {modelLabel(m)}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </>
            }
          />
        </Section>
        <Section>
          <SetRow label="超时" right={<Stepper value={s.timeout ?? 180} min={30} max={1800} step={30} suffix="秒" onChange={(v) => patchPhone({ timeout: v })} />} />
          <SetRow label="每个 App 生成" right={<Stepper value={s.count ?? 4} min={1} max={10} suffix="条" onChange={(v) => patchPhone({ count: v })} />} />
          <SetRow label="带最近聊天" last right={<Stepper value={s.contextCount ?? 20} min={0} max={100} step={5} suffix="条" onChange={(v) => patchPhone({ contextCount: v })} />} />
        </Section>
      </Page>
    );
  }

  if (page.startsWith("custom:")) {
    const a = custom.find((x) => x.id === page.slice(7));
    if (!a) {
      return (
        <Page title="自定义 App" onBack={() => setPage("custom")}>
          <Section>
            <SetRow label="这个 App 已经删掉了" last />
          </Section>
        </Page>
      );
    }
    const patchApp = (patch) => patchPhone({ customApps: custom.map((x) => (x.id === a.id ? { ...x, ...patch } : x)) });
    const input = "w-full bg-transparent text-right text-[17px] text-[#8e8e93] outline-none";
    return (
      <Page title={a.name || "自定义 App"} onBack={() => setPage("custom")}>
        <div className="mb-5 flex justify-center">
          <AppIcon app={{ ...a, custom: true }} size={76} label={false} image={data.icons?.[a.id]} />
        </div>
        <Section>
          <SetRow label="名字" right={<input className={input} value={a.name} maxLength={20} onChange={(e) => patchApp({ name: e.target.value })} />} />
          <SetRow label="图标" right={<input className={`${input} !w-16`} value={a.icon} maxLength={4} onChange={(e) => patchApp({ icon: e.target.value })} />} />
          <SetRow label="颜色" last right={<input type="color" className="h-8 w-12 cursor-pointer rounded border-0 bg-transparent" value={a.color} onChange={(e) => patchApp({ color: e.target.value })} />} />
        </Section>
        <Section title="它是干什么的" foot="模型照这句话生成内容，可以写 {{char}} / {{user}}。">
          <textarea
            className="block min-h-[110px] w-full resize-none bg-transparent px-4 py-3 text-[17px] leading-snug text-black outline-none placeholder:text-[#c7c7cc]"
            value={a.prompt}
            onChange={(e) => patchApp({ prompt: e.target.value })}
            placeholder="比如：记账 App，记着 TA 每一笔偷偷给 {{user}} 买礼物的钱"
          />
        </Section>
        <Section>
          <SelectRow
            label="排版"
            value={a.layout}
            display={LAYOUT_NAMES[a.layout] ?? "通用卡片"}
            last
            onChange={(v) => patchApp({ layout: v })}
            options={Object.entries(LAYOUT_NAMES).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          />
        </Section>
        <Section>
          <SetRow
            label="删除这个 App"
            danger
            last
            onClick={() => {
              patchPhone({ customApps: custom.filter((x) => x.id !== a.id), batchApps: batch.filter((x) => x !== a.id) });
              setPage("custom");
            }}
            right={<span />}
          />
        </Section>
      </Page>
    );
  }

  if (page === "custom") {
    return (
      <Page title="自定义 App" onBack={back}>
        <Section foot="起个名字、写一句它是干什么的，模型就照着生成。所有角色的手机里都会有。">
          {custom.map((a) => (
            <div key={a.id} onClick={() => setPage(`custom:${a.id}`)} className="relative flex min-h-[60px] cursor-pointer items-center gap-3 px-4 py-2 active:bg-black/[0.06]">
              <AppIcon app={{ ...a, custom: true }} size={40} label={false} image={data.icons?.[a.id]} />
              <span className="flex-1 text-[17px] text-black">{a.name}</span>
              <span className="text-[15px] text-[#8e8e93]">{LAYOUT_NAMES[a.layout]}</span>
              <ChevronRight size={18} className="text-[#c7c7cc]" />
              <span className="absolute bottom-0 left-[68px] right-0 h-px bg-[#c6c6c8]/60" />
            </div>
          ))}
          <SetRow
            label="新增 App"
            last
            onClick={() => {
              const id = `c-${Date.now().toString(36)}`;
              patchPhone({ customApps: [...custom, { id, name: "新 App", icon: "📱", color: "#8e8e93", prompt: "", layout: "generic" }] });
              setPage(`custom:${id}`);
            }}
            right={<Plus size={20} className="text-[#007aff]" />}
          />
        </Section>
      </Page>
    );
  }

  // ---- 主页 ----
  const syncOn = [p.injectChat, p.toDiary, p.command].filter(Boolean).length;
  const batchNames = genApps.filter((a) => batch.includes(a.id)).map((a) => a.name);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-[#f2f2f7]">
      <TopBar left={<BackGlass onClick={close} />} title="设置" />
      <Scroll pad={50} className="pt-2">
        <Section>
          <div className="flex items-center gap-3.5 px-4 py-3">
            <Avatar name={role.name} size={62} initials />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[21px] font-semibold text-black">{role.name}</p>
              <p className="text-[14px] text-[#8e8e93]">{total ? `手机里有 ${total} 条内容` : "这台手机还是空的"}</p>
            </div>
          </div>
        </Section>

        <Section title="翻一翻" foot={batchNames.length ? `一次生成：${batchNames.join("、")}` : "还没选一次生成哪些 App"}>
          <SetRow
            icon={generating ? Loader2 : Sparkles}
            color="#007aff"
            label={generating ? `生成中…（${Math.round((Date.now() - (running[0]?.startedAt ?? Date.now())) / 1000)} 秒）` : total ? "继续生成" : "一键生成"}
            onClick={generating || !batch.length ? undefined : () => onGenerate(null, "append")}
            right={<span />}
          >
            {!generating && <p className="text-[13px] text-[#8e8e93]">{total ? "在原来的手机上接着加，不重复" : "按下面勾的那几个 App 一起来"}</p>}
          </SetRow>
          <SetRow
            icon={RefreshCw}
            color="#ff3b30"
            label={confirmReset ? "再点一次确认" : "重置并重新生成"}
            danger={confirmReset}
            last
            onClick={
              generating || !batch.length
                ? undefined
                : () => {
                    if (!confirmReset) return setConfirmReset(true);
                    setConfirmReset(false);
                    onGenerate(null, "reset");
                  }
            }
            right={<span />}
          >
            <p className="text-[13px] text-[#8e8e93]">整台手机清空换新，生成成功才清</p>
          </SetRow>
        </Section>
        {(data.jobs ?? [])
          .filter((j) => j.status === "error")
          .slice(0, 1)
          .map((j) => (
            <p key={j.id} className="-mt-3 px-8 pb-5 text-[13px] leading-snug text-[#ff3b30]">
              「{j.title}」没生成出来：{j.error}
            </p>
          ))}

        <Section title="内容">
          <SetRow icon={Layers} color="#5856d6" label="一次生成" value={`${batch.length} 个`} onClick={() => setPage("batch")} />
          <SetRow icon={BookOpenText} color="#ff9500" label="世界书" value={(data.bookIds ?? []).length ? `${data.bookIds.length} 本` : "不带"} onClick={() => setPage("books")} />
          <SetRow icon={Cpu} color="#8e8e93" label="生成" value={`${s.count ?? 4} 条 · ${s.timeout ?? 180} 秒`} onClick={() => setPage("gen")} last />
        </Section>

        <Section title="这个角色">
          <SetRow icon={BellRing} color="#34c759" label="同步与指令" value={syncOn ? `开 ${syncOn} 项` : "关"} onClick={() => setPage("sync")} last />
        </Section>

        <Section title="外观">
          <SetRow icon={Wallpaper} color="#32ade6" label="墙纸" value={data.wallpaperImage ? "自己的图" : WALLPAPERS[wallpaper]?.name} onClick={() => setPage("wallpaper")} />
          <SetRow icon={Palette} color="#ff2d55" label="App 样式" value={SKIN_ROWS.map(([k]) => data.skinOptions?.[k]?.[skins[k]]).filter(Boolean).join(" · ")} onClick={() => setPage("skins")} />
          <SetRow icon={AppWindow} color="#007aff" label="App 图标" onClick={() => setPage("icons")} />
          <SetRow icon={Plus} color="#af52de" label="自定义 App" value={custom.length ? `${custom.length} 个` : null} onClick={() => setPage("custom")} last />
        </Section>

        <p className="px-8 text-center text-[12px] leading-snug text-[#8e8e93]">
          {saveState === "saving" ? "正在保存…" : saveState === "error" ? "保存失败了，去页面底部看看" : "改了就会自动保存"}
        </p>
      </Scroll>
    </div>
  );
}
