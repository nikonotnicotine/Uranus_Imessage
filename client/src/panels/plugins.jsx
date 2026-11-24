/**
 * 「插件」分区：上面是插件市场（一份社区目录），下面是装好的插件和开关。
 *
 * 后端 server/src/plugins.js，插件落在 data/plugins/。加载那一半在
 * client/src/plugins.jsx。
 *
 * ── 这个分区要让用户看明白的三件事 ──
 *
 *  1. **插件能做的事和控制台自己一样多**。它们和控制台同源、能读页面上的
 *     API 密钥、能替你调任何 /api。装一个插件 ≈ 让一个陌生人在你的服务器上
 *     跑代码。所以这句话写在最上面，不折叠、不缩成小字。
 *  2. **总开关默认关着**，装了也不会自己跑 —— 装进来和同意让它跑是两件事。
 *  3. **市场只是链接目录**。这个面板不替用户下载任何东西：点一个插件是在新
 *     标签页打开作者的 GitHub，用户自己下载 zip，再回来导入。后端也没有
 *     「从 URL 安装」那条路（见 plugins.js 的注释）。
 *
 * ── 已下架的插件 ──
 *
 * 市场那份目录带一张下架名单。装了名单上的插件，这里会亮红色警告 ——
 * `reason` 是 security 的弹得更重。审核总会漏，召回不能漏，所以这块的
 * 优先级比市场列表本身还高：它排在最上面，而且在市场拉不到时也照常显示。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Blocks,
  Check,
  ExternalLink,
  Package,
  RefreshCw,
  ShieldAlert,
  Trash2,
  Upload,
} from "lucide-react";

import { PLUGINS_SAFE_MODE } from "../plugins.jsx";
import { Button, Card, ResultNote, Switch } from "../ui.jsx";

/** 插件市场那个仓库。点「去仓库看看」开这个。 */
const MARKET_REPO = "https://github.com/nikonotnicotine/uranus-plugins";

/** 装插件收的 zip 上限，和后端 plugins.js:MAX_ZIP 对齐。 */
const MAX_ZIP_MB = 8;

/** 下架原因 → 给用户看的话。security 那档单独标红，别的只是「不维护了」。 */
const DELIST_REASON = {
  security: "有安全问题",
  "paid-content": "含付费内容",
  license: "协议问题",
  "author-request": "作者主动下架",
  "repo-gone": "仓库已删除",
  broken: "已经不能用了",
  other: "已下架",
};

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

const openRepo = (url) => window.open(url, "_blank", "noopener,noreferrer");

export function PluginsPanel() {
  const [state, setState] = useState(null); // { enabled, plugins: [] }
  const [market, setMarket] = useState(null); // { plugins, delisted, delistedOk, updatedAt }
  const [marketError, setMarketError] = useState("");
  const [marketBusy, setMarketBusy] = useState(false);
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

  const loadMarket = useCallback(async (force = false) => {
    setMarketBusy(true);
    setMarketError("");
    try {
      setMarket(await call(`/api/plugins/market${force ? "?refresh=1" : ""}`));
    } catch (e) {
      setMarketError(String(e?.message ?? e));
    } finally {
      setMarketBusy(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    loadMarket();
  }, [refresh, loadMarket]);

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

  const installed = state?.plugins ?? [];
  const on = Boolean(state?.enabled);

  /* 装了的插件里，哪些上了下架名单 —— 这是整个分区最要紧的一块，排最前面。 */
  const delistedMap = new Map((market?.delisted ?? []).map((d) => [d.id, d]));
  const flagged = installed.map((p) => delistedMap.get(p.id)).filter(Boolean);

  return (
    <>
      {/* ── 已下架警告：排在所有东西前面，市场拉不到时也照常显示 ── */}
      {flagged.length > 0 && (
        <section className="mb-10 border-2 border-warn p-4">
          <p className="flex items-start gap-2 text-ui text-warn">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>你装了 {flagged.length} 个已经从插件市场下架的插件</span>
          </p>
          <div className="mt-3 grid grid-cols-1 gap-2">
            {flagged.map((d) => (
              <div key={d.id} className="text-meta leading-relaxed text-ink">
                <span className="text-ink">{d.title}</span>
                <span className="ml-2 text-ink-faint">{DELIST_REASON[d.reason] ?? "已下架"}</span>
                {d.delistedAt && <span className="ml-2 text-ink-faint">{d.delistedAt}</span>}
                {d.note && <p className="mt-0.5 text-ink-soft">{d.note}</p>}
                {d.reason === "security" && (
                  <p className="mt-0.5 text-warn">建议立刻关掉或卸载它，并换掉这台机器上的 API 密钥。</p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── 插件市场 ── */}
      <Card
        title="插件市场"
        desc="一份社区插件的目录。点一个插件到作者的 GitHub 仓库下载 zip，回来在下面导入 —— 控制台不会替你下载任何东西。"
        actions={
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" onClick={() => loadMarket(true)} disabled={marketBusy}>
              <RefreshCw className={`h-3.5 w-3.5 ${marketBusy ? "animate-spin" : ""}`} />
              刷新
            </Button>
            <Button variant="outline" onClick={() => openRepo(MARKET_REPO)}>
              <ExternalLink className="h-3.5 w-3.5" />
              去仓库看看
            </Button>
          </div>
        }
      >
        <div className="grid grid-cols-1 gap-6">
          {/*
            这段话是整个分区最要紧的东西，所以用描边框起来放在市场列表之前，
            不折叠、不缩成一行小字 —— 用户在点进某个插件之前必须看见它。
          */}
          <div className="border border-ink/25 p-4">
            <p className="flex items-start gap-2 text-meta leading-relaxed text-ink">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                <strong>插件能做的事和控制台自己一样多。</strong>
                它能读写你的聊天记录和角色设定、看到你填的 API 密钥、替你调用任何接口。
                收录一个插件之前会看一遍代码，但那<strong>不是安全审计</strong>，
                也管不到作者之后又改了什么。只装你信得过的作者写的东西，装之前最好自己翻一眼源码。
              </span>
            </p>
          </div>

          {marketError ? (
            <div className="grid grid-cols-1 gap-2">
              <ResultNote state="fail" message={`连不上插件市场：${marketError}`} />
              <p className="max-w-[62ch] text-meta leading-relaxed text-ink-faint">
                目录放在 GitHub 上，国内网络多半连不上。这不影响装插件 —— 点「去仓库看看」
                用你自己的办法打开，下载 zip 回来导入就行。
              </p>
            </div>
          ) : !market ? (
            <p className="text-meta text-ink-faint">正在拉目录…</p>
          ) : market.plugins.length === 0 ? (
            <p className="max-w-[62ch] text-meta leading-relaxed text-ink-faint">
              市场里还一个插件都没有。想第一个上架的话，点「去仓库看看」，README 里写了怎么提交。
            </p>
          ) : (
            <>
              {!market.delistedOk && (
                <ResultNote
                  state="fail"
                  message="下架名单这次没拉到，所以不能确认下面这些插件是不是都还在售。"
                />
              )}
              <div className="grid grid-cols-1 gap-3">
                {market.plugins.map((m) => {
                  const mine = market.installed?.[m.id];
                  const gone = delistedMap.get(m.id);
                  return (
                    <div key={m.id} className="border border-line p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-baseline gap-2">
                            <span className="text-ui text-ink">{m.title}</span>
                            {m.lockedVersion && <span className="text-meta text-ink-faint">{m.lockedVersion}</span>}
                            {mine && (
                              <span className="inline-flex items-center gap-1 border border-line px-1.5 py-0.5 text-[11px] text-ink-soft">
                                <Check className="h-3 w-3" />
                                已安装
                              </span>
                            )}
                            {gone && (
                              <span className="border border-warn px-1.5 py-0.5 text-[11px] text-warn">
                                {DELIST_REASON[gone.reason] ?? "已下架"}
                              </span>
                            )}
                          </div>
                          {m.desc && (
                            <p className="mt-1.5 max-w-[62ch] text-meta leading-relaxed text-ink-faint">{m.desc}</p>
                          )}
                          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-faint">
                            {m.license && <span>{m.license}</span>}
                            {m.tags?.length > 0 && <span>{m.tags.join(" · ")}</span>}
                            {m.reviewedAt && <span>审核于 {m.reviewedAt}</span>}
                            {m.lockedVersion && <span>已锁定版本</span>}
                          </div>
                        </div>
                        <Button variant="outline" onClick={() => openRepo(m.repo)} className="shrink-0">
                          <ExternalLink className="h-3.5 w-3.5" />
                          去下载
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="text-[11px] text-ink-faint">
                共 {market.plugins.length} 个插件
                {market.updatedAt ? ` · 目录更新于 ${market.updatedAt}` : ""}
                {market.cached ? " · 读的是缓存，点「刷新」重拉" : ""}
              </p>
            </>
          )}
        </div>
      </Card>

      {/* ── 已装的插件 ── */}
      <Card
        title="已装的插件"
        desc="从市场下载回来的 zip 在这里导入。装进来之后默认是关着的，要自己打开。"
      >
        <div className="grid grid-cols-1 gap-6">
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
                {installed.length > 0 && !on && " 下面那些插件的开关要在这个打开之后才有效。"}
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
            <span className="text-meta text-ink-faint">上限 {MAX_ZIP_MB}MB</span>
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
          {installed.length === 0 ? (
            <p className="flex items-start gap-2 text-meta leading-relaxed text-ink-faint">
              <Blocks className="mt-0.5 h-4 w-4 shrink-0" />
              还没有装任何插件。在上面的插件市场里挑一个，下载 zip 之后回来导入。
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-3">
              {installed.map((p) => {
                const gone = delistedMap.get(p.id);
                return (
                  <div key={p.id} className={`border p-4 ${gone ? "border-warn" : "border-line"}`}>
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-baseline gap-2">
                          <span className="text-ui text-ink">{p.name}</span>
                          {p.version && <span className="text-meta text-ink-faint">{p.version}</span>}
                          {p.broken && (
                            <span className="border border-ink/30 px-1.5 py-0.5 text-[11px] text-ink">有问题</span>
                          )}
                          {gone && (
                            <span className="border border-warn px-1.5 py-0.5 text-[11px] text-warn">
                              {DELIST_REASON[gone.reason] ?? "已下架"}
                            </span>
                          )}
                        </div>
                        {p.description && (
                          <p className="mt-1.5 max-w-[62ch] text-meta leading-relaxed text-ink-faint">{p.description}</p>
                        )}
                        {p.broken && <p className="mt-1.5 max-w-[62ch] text-meta leading-relaxed text-ink">{p.broken}</p>}
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
                );
              })}
            </div>
          )}
        </div>
      </Card>
    </>
  );
}
