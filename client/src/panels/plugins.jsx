/**
 * 「插件」分区：装了哪些、开关、装新的、卸载，以及插件市场的入口。
 *
 * 后端 server/src/plugins.js，插件落在 data/plugins/。加载那一半在
 * client/src/plugins.jsx。
 *
 * ── 这个面板要让用户看明白的三件事 ──
 *
 *  1. **插件能做的事和控制台自己一样多**。它们和控制台同源、能读页面上的
 *     API 密钥、能替你调任何 /api。装一个插件 ≈ 让一个陌生人在你的服务器上
 *     跑代码。所以这句话写在卡片最上面，不是藏在折叠里。
 *  2. **总开关默认关着**，装了也不会自己跑 —— 装进来和同意让它跑是两件事。
 *  3. **市场只是链接目录**。这个面板不会替用户下载任何东西：点「逛插件市场」
 *     是在新标签页打开 GitHub 上那份目录，用户自己下载 zip，再回来导入。
 *     后端也没有「从 URL 安装」那条路（见 plugins.js 的注释）。
 *
 * ── 开关变动要刷新 ──
 *
 * 不做热插拔是故意的：插件改了 DOM、挂了事件、往 window 上放了东西，
 * 「卸载」没法做干净。所以开关一变就提示刷新，这是唯一诚实的做法。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ExternalLink, Package, RefreshCw, Trash2, Upload } from "lucide-react";

import { PLUGINS_SAFE_MODE } from "../plugins.jsx";
import { Button, Card, ResultNote, Switch } from "../ui.jsx";

/** 插件市场（链接目录）。点一下在新标签页打开，这个面板不替用户下载任何东西。 */
const MARKET_URL = "https://github.com/nikonotnicotine/uranus-plugins";

/** 装插件收的 zip 上限，和后端 plugins.js:MAX_ZIP 对齐。 */
const MAX_ZIP_MB = 8;

async function call(path, options = {}) {
  const res = await fetch(path, { credentials: "same-origin", ...options });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* 后端出错时也是 JSON，解不出来说明连接断了 */
  }
  if (!res.ok) throw new Error(data?.error || `请求失败 (${res.status})`);
  return data;
}

export function PluginsPanel() {
  const [state, setState] = useState(null); // { enabled, plugins: [] }
  const [note, setNote] = useState({ state: "idle", message: "" });
  const [busy, setBusy] = useState(false);
  const [needReload, setNeedReload] = useState(false);
  const [confirmDrop, setConfirmDrop] = useState("");
  const fileRef = useRef(null);

  const refresh = useCallback(
    () =>
      call("/api/plugins")
        .then(setState)
        .catch((e) => setNote({ state: "fail", message: String(e?.message ?? e) })),
    [],
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function toggleAll(enabled) {
    setBusy(true);
    try {
      setState(await call("/api/plugins/enabled", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      }));
      setNeedReload(true);
      setNote({ state: "ok", message: enabled ? "插件总开关已打开" : "插件总开关已关闭" });
    } catch (e) {
      setNote({ state: "fail", message: String(e?.message ?? e) });
    } finally {
      setBusy(false);
    }
  }

  async function toggleOne(id, enabled) {
    setBusy(true);
    try {
      setState(await call(`/api/plugins/${id}/enabled`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      }));
      setNeedReload(true);
      setNote({ state: "idle", message: "" });
    } catch (e) {
      setNote({ state: "fail", message: String(e?.message ?? e) });
    } finally {
      setBusy(false);
    }
  }

  async function install(file) {
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) {
      setNote({ state: "fail", message: "插件是一个 .zip 压缩包，选错文件了" });
      return;
    }
    if (file.size > MAX_ZIP_MB * 1024 * 1024) {
      setNote({ state: "fail", message: `压缩包 ${Math.round(file.size / 1024 / 1024)}MB，超过 ${MAX_ZIP_MB}MB 上限` });
      return;
    }

    setBusy(true);
    setNote({ state: "idle", message: "" });
    try {
      /*
       * 必须先 arrayBuffer()，不能直接把 File 当 body —— 小手机控制台的 /api
       * 请求要过自己的 Service Worker，body 是 File/Blob 时 iOS Safari 递给 SW
       * 的请求读出来是空的，后端收到 0 字节。和恢复完整备份那条踩过的是同一个
       * 坑（见 store.jsx:restoreFullBackup 的注释），所以照同一种写法。
       */
      const bytes = await file.arrayBuffer();
      const out = await call("/api/plugins/install", {
        method: "POST",
        headers: { "Content-Type": "application/zip", "x-plugin-filename": encodeURIComponent(file.name) },
        body: bytes,
      });
      setState({ enabled: out.enabled, plugins: out.plugins });
      setNote({
        state: "ok",
        message: out.replaced
          ? `已更新「${out.name}」到 ${out.version || "新版本"}，原来的开关状态保留着。`
          : `已装上「${out.name}」。它现在还是关着的 —— 在下面打开它，然后刷新页面。`,
      });
      if (out.replaced) setNeedReload(true);
    } catch (e) {
      setNote({ state: "fail", message: String(e?.message ?? e) });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function drop(id) {
    setBusy(true);
    try {
      setState(await call(`/api/plugins/${id}`, { method: "DELETE" }));
      setNeedReload(true);
      setNote({ state: "ok", message: "已卸载，插件的文件夹和它存的数据都删掉了。" });
    } catch (e) {
      setNote({ state: "fail", message: String(e?.message ?? e) });
    } finally {
      setBusy(false);
      setConfirmDrop("");
    }
  }

  const plugins = state?.plugins ?? [];
  const on = Boolean(state?.enabled);

  return (
    <Card
      title="插件"
      desc="插件是别人写的代码，装上之后在控制台里和自带功能一起跑。从插件市场找到想要的，下载 zip 回来在这里导入。"
      actions={
        <Button variant="outline" onClick={() => window.open(MARKET_URL, "_blank", "noopener,noreferrer")}>
          <ExternalLink className="h-3.5 w-3.5" />
          逛插件市场
        </Button>
      }
    >
      <div className="grid grid-cols-1 gap-6">
        {/*
          这段话是整个面板最要紧的东西，所以用 accent 的描边框起来放在最上面，
          不折叠、不缩成一行小字 —— 用户在点「打开」之前必须看见它。
        */}
        <div className="border border-ink/25 p-4">
          <p className="flex items-start gap-2 text-meta leading-relaxed text-ink">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <strong>插件能做的事和控制台自己一样多。</strong>
              它能读写你的聊天记录和角色设定、看到你填的 API 密钥、替你调用任何接口。
              插件市场收录一个插件之前会看一遍代码，但那<strong>不是安全审计</strong>，
              也管不到作者之后又改了什么。只装你信得过的作者写的东西，装之前最好自己翻一眼源码。
            </span>
          </p>
        </div>

        {PLUGINS_SAFE_MODE && (
          <ResultNote
            state="fail"
            message="现在是安全模式（网址带 ?noplugins）：所有插件都没加载。在这里关掉出问题的那个，再去掉 ?noplugins 刷新。"
          />
        )}

        {/* 总开关 */}
        <div className="flex items-start justify-between gap-6 border-b border-line pb-5">
          <div className="max-w-[52ch]">
            <div className="text-ui text-ink">启用插件</div>
            <p className="mt-1 text-meta leading-relaxed text-ink-faint">
              关着的时候一个插件都不会加载，装了也不会跑。
              {plugins.length > 0 && !on && " 下面那些插件的开关要在这个打开之后才有效。"}
            </p>
          </div>
          <div className={busy ? "pointer-events-none opacity-40" : ""}>
            <Switch checked={on} onChange={toggleAll} label="启用插件" />
          </div>
        </div>

        {/* 装新的 */}
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={fileRef}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            onChange={(e) => install(e.target.files?.[0])}
          />
          <Button onClick={() => fileRef.current?.click()} disabled={busy}>
            <Upload className="h-3.5 w-3.5" />
            导入插件 zip
          </Button>
          <span className="text-meta text-ink-faint">从插件市场点进作者的仓库下载，上限 {MAX_ZIP_MB}MB</span>
        </div>

        {note.message && <ResultNote state={note.state} message={note.message} icon={Package} />}

        {needReload && (
          <ResultNote
            state="ok"
            message="开关改好了，刷新一下页面才生效 —— 插件改过的界面没法干净地撤掉，刷新是唯一可靠的办法。"
            icon={RefreshCw}
          />
        )}

        {/* 列表 */}
        {plugins.length === 0 ? (
          <p className="text-meta leading-relaxed text-ink-faint">
            还没有装任何插件。点右上角「逛插件市场」看看有什么，下载 zip 之后回来导入。
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3">
            {plugins.map((p) => (
              <div key={p.id} className="border border-line p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="text-ui text-ink">{p.name}</span>
                      {p.version && <span className="text-meta text-ink-faint">{p.version}</span>}
                      {p.broken && (
                        <span className="border border-ink/30 px-1.5 py-0.5 text-[11px] text-ink">有问题</span>
                      )}
                    </div>
                    {p.description && (
                      <p className="mt-1.5 max-w-[62ch] text-meta leading-relaxed text-ink-faint">{p.description}</p>
                    )}
                    {p.broken && (
                      <p className="mt-1.5 max-w-[62ch] text-meta leading-relaxed text-ink">{p.broken}</p>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-faint">
                      <span className="font-mono">{p.id}</span>
                      {p.author && <span>作者 {p.author}</span>}
                      {p.repo && (
                        <a
                          href={p.repo}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline underline-offset-2 hover:text-ink"
                        >
                          源码
                        </a>
                      )}
                      {p.permissions?.length > 0 && <span>声明的权限：{p.permissions.join("、")}</span>}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    {!p.broken && (
                      <div className={busy ? "pointer-events-none opacity-40" : ""}>
                        <Switch
                          checked={Boolean(p.enabled)}
                          onChange={(v) => toggleOne(p.id, v)}
                          label={`启用 ${p.name}`}
                        />
                      </div>
                    )}
                    {confirmDrop === p.id ? (
                      <div className="flex items-center gap-1.5">
                        <Button variant="outline" onClick={() => drop(p.id)} disabled={busy}>
                          确认卸载
                        </Button>
                        <Button variant="ghost" onClick={() => setConfirmDrop("")} disabled={busy}>
                          取消
                        </Button>
                      </div>
                    ) : (
                      <Button variant="ghost" onClick={() => setConfirmDrop(p.id)} disabled={busy}>
                        <Trash2 className="h-3.5 w-3.5" />
                        卸载
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
