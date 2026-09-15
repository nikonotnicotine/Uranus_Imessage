/*
 * 界面壁纸：右上角那个入口，以及它点开的弹窗。
 *
 * 壁纸不走配置那一套（草稿 + 点保存），因为保存配置会顺带重启所有 iMessage
 * 桥接 —— 换张壁纸把线路踢下线显然不合理。所以这里直接打 /api/wallpaper，
 * 改一下就立刻落盘、立刻生效。
 *
 * 图铺在 body 上、上面压一层白遮罩，两者都由 index.css 里的
 * --wallpaper-image / --wallpaper-veil 驱动；这个文件只负责把值写上去。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Image as ImageIcon, Trash2, Upload } from "lucide-react";
import { Button, Modal, Slider } from "../ui.jsx";

/** 遮罩最低 0.2，和后端 wallpaper.js 的 VEIL_MIN 对齐。再淡下去正文就糊了。 */
const VEIL_MIN = 0.2;

/** 单张壁纸的体积上限，和识图测试传图那边一个数。 */
const MAX_BYTES = 8 * 1024 * 1024;

const fileUrl = (file) => `/api/wallpaper/file/${encodeURIComponent(file)}`;

/**
 * 壁纸的全部状态。整个应用只该调一次（在 AppShell 里），
 * 调两次会有两份状态互相覆盖 CSS 变量。
 */
export function useWallpaper() {
  const [files, setFiles] = useState([]);
  const [current, setCurrent] = useState("");
  // 初值给 1 = 全白遮罩。设置还没拉回来之前先当没有壁纸，避免闪一下图
  const [veil, setVeil] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const timer = useRef(null);

  /** 把状态映到 <html> 的两个 CSS 变量上，index.css 那边接住。 */
  useEffect(() => {
    const root = document.documentElement;
    if (current) {
      root.style.setProperty("--wallpaper-image", `url("${fileUrl(current)}")`);
      root.style.setProperty("--wallpaper-veil", String(veil));
    } else {
      // 没选壁纸就把变量摘掉，回落到 index.css 里的 none / 1
      root.style.removeProperty("--wallpaper-image");
      root.style.removeProperty("--wallpaper-veil");
    }
  }, [current, veil]);

  const absorb = useCallback((data) => {
    setFiles(data.files ?? []);
    setCurrent(data.current ?? "");
    if (Number.isFinite(Number(data.veil))) setVeil(Number(data.veil));
  }, []);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/wallpaper");
      if (!res.ok) throw new Error(`请求失败 (${res.status})`);
      absorb(await res.json());
      setError("");
    } catch (e) {
      // 拉不到就当没有壁纸 —— 界面照常是白底，不该因为这个打不开
      setError(String(e?.message ?? e));
    }
  }, [absorb]);

  useEffect(() => {
    reload();
  }, [reload]);

  /** 落盘设置。current 传 null 表示不动它，只改遮罩。 */
  const put = useCallback(
    async (next) => {
      try {
        const res = await fetch("/api/wallpaper", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(next),
        });
        if (!res.ok) throw new Error(`保存失败 (${res.status})`);
        absorb(await res.json());
        setError("");
      } catch (e) {
        setError(String(e?.message ?? e));
      }
    },
    [absorb],
  );

  const choose = useCallback(
    (file) => {
      setCurrent(file); // 先改本地，界面立刻换掉，不等网络
      put({ current: file, veil });
    },
    [put, veil],
  );

  /**
   * 拖滑块时每一帧都发一次 PUT 显然不行，所以本地先改（预览是即时的），
   * 停手 400ms 再落盘。
   */
  const changeVeil = useCallback(
    (value) => {
      setVeil(value);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => put({ current, veil: value }), 400);
    },
    [put, current],
  );

  useEffect(() => () => timer.current && clearTimeout(timer.current), []);

  const upload = useCallback(
    async ({ name, base64, mimeType }) => {
      setBusy(true);
      try {
        const res = await fetch("/api/wallpaper/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, base64, mimeType }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data?.error ?? `上传失败 (${res.status})`);
        setFiles(data.files ?? []);
        setError("");
        // 传完直接用上，不然还要再点一下才看得见
        setCurrent(data.file);
        await put({ current: data.file, veil });
      } catch (e) {
        setError(String(e?.message ?? e));
      } finally {
        setBusy(false);
      }
    },
    [put, veil],
  );

  const remove = useCallback(async (file) => {
    try {
      // 读图是 /api/wallpaper/file/:file，删是 /api/wallpaper/:file —— 别写混了
      const res = await fetch(`/api/wallpaper/${encodeURIComponent(file)}`, { method: "DELETE" });
      if (res.status === 404) throw new Error("找不到这张壁纸");
      if (!res.ok) throw new Error(`删除失败 (${res.status})`);
      const data = await res.json();
      // 内置壁纸删不掉，后端回 200 + ok:false 说明原因
      if (data?.ok === false) throw new Error(data.error ?? "删不掉这张壁纸");
      absorb(data);
      setError("");
    } catch (e) {
      setError(String(e?.message ?? e));
    }
  }, [absorb]);

  return { files, current, veil, busy, error, choose, changeVeil, upload, remove, reload };
}

/** 右上角的入口。小屏只留图标，标题那行本来就挤。 */
export function WallpaperButton({ wallpaper }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" className="shrink-0" onClick={() => setOpen(true)}>
        <ImageIcon size={14} />
        <span className="max-sm:hidden">壁纸</span>
      </Button>
      {open && <WallpaperModal wallpaper={wallpaper} onClose={() => setOpen(false)} />}
    </>
  );
}

function WallpaperModal({ wallpaper, onClose }) {
  const { files, current, veil, busy, error, choose, changeVeil, upload, remove } = wallpaper;
  const fileRef = useRef(null);
  const [pickErr, setPickErr] = useState("");
  // 删除是不可逆的，先问一句。存的是待删的文件名
  const [confirming, setConfirming] = useState("");

  /** 选中本地图片 → 转 base64 → 传上去。和识图测试那边一个写法。 */
  function onPickFile(e) {
    const file = e.target.files?.[0];
    e.target.value = ""; // 允许重复选同一个文件
    if (!file) return;
    setPickErr("");
    if (!file.type.startsWith("image/")) {
      setPickErr("这不是图片文件");
      return;
    }
    if (file.size > MAX_BYTES) {
      setPickErr(`图片 ${(file.size / 1024 / 1024).toFixed(1)}MB，超过 8MB 上限`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      // data:image/png;base64,xxxx → 只要后面那截
      const base64 = String(reader.result ?? "").split(",")[1];
      if (!base64) {
        setPickErr("读不出这张图的内容");
        return;
      }
      upload({ name: file.name, base64, mimeType: file.type });
    };
    reader.onerror = () => setPickErr("读取文件失败");
    reader.readAsDataURL(file);
  }

  const msg = pickErr || error;
  // 当前这张是不是内置的 —— 决定下面那块「删掉当前这张」画不画
  const currentBuiltin = Boolean(files.find((w) => w.file === current)?.builtin);

  return (
    <Modal
      title="界面壁纸"
      desc="铺在整个后台界面的最底层，上面压一层白色遮罩。改完立刻生效，不用点保存。"
      onClose={onClose}
      footer={
        <>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={onPickFile}
          />
          <Button variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}>
            <Upload size={14} />
            {busy ? "上传中…" : "上传图片…"}
          </Button>
          <Button onClick={onClose}>完成</Button>
        </>
      }
    >
      {msg && <p className="mb-4 border-l-2 border-warn pl-3 text-meta text-warn">{msg}</p>}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {/* 第一格是「不用壁纸」，回到原本的纯白 */}
        <button
          type="button"
          onClick={() => choose("")}
          className={`flex aspect-[4/3] items-center justify-center border text-meta transition-colors duration-150 ${
            current ? "border-line text-ink-faint hover:text-ink" : "border-ink text-ink"
          }`}
        >
          不用壁纸
        </button>

        {files.map((w) => (
          <button
            key={w.file}
            type="button"
            onClick={() => choose(w.file)}
            title={w.builtin ? `${w.file}（内置壁纸，删不掉）` : w.file}
            className={`relative aspect-[4/3] overflow-hidden border transition-colors duration-150 ${
              current === w.file ? "border-ink" : "border-line hover:border-ink"
            }`}
          >
            <img src={fileUrl(w.file)} alt={w.file} className="h-full w-full object-cover" />
            {w.builtin && (
              <span className="absolute left-0 top-0 bg-paper/85 px-1.5 py-0.5 text-meta text-ink-faint">
                内置
              </span>
            )}
            <span className="absolute inset-x-0 bottom-0 truncate bg-paper/85 px-1.5 py-1 text-left text-meta text-ink">
              {w.file}
            </span>
          </button>
        ))}
      </div>

      {files.length === 0 && (
        <p className="mt-3 text-meta leading-relaxed text-ink-meta">
          还没有壁纸。点下面的「上传图片…」传一张，或者直接把图片放进 data/wallpapers/。
        </p>
      )}

      <div className="mt-6 border-t border-line pt-5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-ui text-ink">遮罩浓度</span>
          <span className="text-meta tabular-nums text-ink-faint">{Math.round(veil * 100)}%</span>
        </div>
        <p className="mt-1 text-meta leading-relaxed text-ink-meta">
          往右拧更白、正文更清楚；往左拧壁纸更明显。100% 就是完全看不见壁纸的纯白。
        </p>
        <div className="mt-3">
          <Slider
            value={veil}
            min={VEIL_MIN}
            max={1}
            step={0.01}
            onChange={changeVeil}
          />
        </div>
      </div>

      {/* 内置壁纸不给删（它在 assets/ 里，删了得重新拉代码才回得来），所以这块整个不画 */}
      {current && !currentBuiltin && (
        <div className="mt-6 border-t border-line pt-5">
          {confirming === current ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-meta text-warn">删掉 {current}？文件会从硬盘上消失。</span>
              <Button
                variant="outline"
                onClick={() => {
                  remove(current);
                  setConfirming("");
                }}
              >
                确认删除
              </Button>
              <Button variant="ghost" onClick={() => setConfirming("")}>
                算了
              </Button>
            </div>
          ) : (
            <Button variant="ghost" onClick={() => setConfirming(current)}>
              <Trash2 size={14} />
              删掉当前这张
            </Button>
          )}
        </div>
      )}
    </Modal>
  );
}
