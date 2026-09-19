import { useCallback, useEffect, useMemo, useState } from "react";
import { projectLabel, projectReady, roleLabel } from "../labels.js";
import { SaveBar, useSection } from "../section.jsx";
import { api, useConfig } from "../store.jsx";
import { Button, Card, CodeBlock, Field, inputCls } from "../ui.jsx";
import {
  AtSign,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Play,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Terminal,
  Trash2,
  X,
} from "lucide-react";

export const MODES = [
  { value: "cloud", label: "云端 (Photon)", desc: "用 VPS 连 Photon 云端，自动铸币换取账号" },
  { value: "local", label: "本地 (Local)", desc: "需 macOS 上跑，直接读本机 Messages" },
];

/** 开通步骤文案。占位符都是示例，别填真号。 */
export const GUIDE_STEPS = [
  {
    title: "创建一个 Photon 项目",
    body: "打开 app.photon.codes，登录后新建一个项目。",
    link: "https://app.photon.codes",
    linkLabel: "app.photon.codes",
  },
  {
    title: "拿 Project ID 和 Project Secret",
    body: "进项目页面的 Configure 一栏，把这两个值复制到下面的输入框里。Secret 只会完整显示一次，记得当场存好。",
  },
  {
    title: "开通 iMessage",
    body: "点 Send your first message，在 provider 列表里选 imessage。",
  },
  {
    title: "给账号绑手机号",
    body: "右上角点自己头像 → Account，绑定手机号。Photon 要先确认你的账号有手机号，才会给项目分配 iMessage 线路。",
  },
  {
    title: "收不到验证码？",
    body: "部分运营商（尤其是国内号码）收不到 Photon 的验证码短信。那就跳过网页这一步，直接用下面的「登记手机号」——走的是 Photon 的管理接口，不需要验证码。",
  },
];

/** 三个系统各自的终端命令。占位符不含任何真实凭据。 */
export const TERMINAL_CMDS = [
  {
    id: "mac",
    label: "macOS",
    hint: "终端 · zsh / bash 都可以",
    code: `PROJECT_ID="你的 Project ID"
PHONE="+8613800138000"
printf "Project Secret: "; read -s SECRET; echo

curl -s -X POST "https://spectrum.photon.codes/projects/$PROJECT_ID/users/" \\
  -u "$PROJECT_ID:$SECRET" \\
  -H "Content-Type: application/json" \\
  -d "{\\"type\\":\\"shared\\",\\"phoneNumber\\":\\"$PHONE\\"}"`,
  },
  {
    id: "linux",
    label: "Linux",
    hint: "bash / sh",
    code: `PROJECT_ID="你的 Project ID"
PHONE="+8613800138000"
printf "Project Secret: "; read -s SECRET; echo

curl -s -X POST "https://spectrum.photon.codes/projects/$PROJECT_ID/users/" \\
  -u "$PROJECT_ID:$SECRET" \\
  -H "Content-Type: application/json" \\
  -d "{\\"type\\":\\"shared\\",\\"phoneNumber\\":\\"$PHONE\\"}"`,
  },
  {
    id: "windows",
    label: "Windows",
    hint: "PowerShell（别用 CMD）",
    code: `$ProjectId = "你的 Project ID"
$Phone = "+8613800138000"
$Secure = Read-Host "Project Secret" -AsSecureString
$Secret = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure))

$Auth = [Convert]::ToBase64String(
  [Text.Encoding]::ASCII.GetBytes("\${ProjectId}:\${Secret}"))
$Body = @{ type = "shared"; phoneNumber = $Phone } | ConvertTo-Json -Compress

$Resp = Invoke-RestMethod -Method Post \`
  -Uri "https://spectrum.photon.codes/projects/$ProjectId/users/" \`
  -Headers @{ Authorization = "Basic $Auth" } \`
  -ContentType "application/json" \`
  -Body $Body

$Resp.data.assignedPhoneNumber`,
  },
];

/** 手机号登记：填自己的号，为某个项目换一条 Photon 线路号码。 */
export function EnrollBox({ project, onDone }) {
  const { save, reload } = useConfig();
  const [phone, setPhone] = useState(project.myPhone ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [reused, setReused] = useState(false);
  const [os, setOs] = useState(() =>
    typeof navigator !== "undefined" && /Mac/i.test(navigator.platform ?? "")
      ? "mac"
      : typeof navigator !== "undefined" && /Win/i.test(navigator.platform ?? "")
      ? "windows"
      : "linux"
  );
  const [showFallback, setShowFallback] = useState(false);

  const line = project.linePhone ?? "";
  const canSubmit = phone.replace(/\D/g, "").length >= 7 && !busy;

  async function enroll() {
    setBusy(true);
    setError(null);
    setReused(false);
    try {
      // 后端是从磁盘上的配置里读凭据的，所以先把草稿落盘
      await save();

      const res = await fetch("/api/imessage/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // 只带「哪个项目」和手机号，Secret 不出浏览器
        body: JSON.stringify({ projectId: project.id, phone }),
      });
      const data = await res.json().catch(() => null);

      if (!res.ok || !data?.ok || !data.assignedPhoneNumber) {
        throw new Error(data?.error ?? `登记失败（HTTP ${res.status}）`);
      }

      // 后端已经把手机号和线路号码写进磁盘了，这里重读一遍即可，
      // 别在本地改草稿——那样会凭空造出一份「未保存的改动」。
      await reload();
      setReused(Boolean(data.reused));
      onDone?.();
    } catch (e) {
      setError(String(e?.message ?? e));
      setShowFallback(true);
    } finally {
      setBusy(false);
    }
  }

  const cmd = TERMINAL_CMDS.find((c) => c.id === os) ?? TERMINAL_CMDS[0];

  return (
    <div className="border border-line bg-paper p-4">
      <p className="flex items-center gap-1.5 text-ui text-ink">
        <Smartphone size={15} className="text-ink" />
        登记手机号，换一条 iMessage 线路
      </p>
      <p className="mt-1 text-meta leading-relaxed text-ink-faint">
        填你自己的手机号（E.164 格式，带国家码）。点一下，这边直接向 Photon
        登记并把分配到的号码取回来——不用收验证码，也不用开终端。
      </p>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input
          className={inputCls}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canSubmit) enroll();
          }}
          placeholder="+8613800138000"
          inputMode="tel"
        />
        <Button onClick={enroll} disabled={!canSubmit} className="sm:w-auto sm:shrink-0">
          {busy ? <RefreshCw size={14} className="animate-spin" /> : <Play size={14} />}
          {busy ? "登记中…" : "获取线路号码"}
        </Button>
      </div>

      {line && (
        <div className="mt-3 border border-good/30 bg-goodsoft px-3.5 py-3">
          <p className="text-meta text-ink-soft">你的 iMessage 线路号码</p>
          <p className="mt-1 flex flex-wrap items-center gap-2">
            <span className="select-all font-mono text-h3 text-ink">{line}</span>
            <button
              type="button"
              onClick={() => navigator.clipboard?.writeText(line)}
              className="rounded-item border border-line p-1 text-ink-faint transition-colors duration-150 hover:text-ink"
              title="复制"
            >
              <Copy size={13} />
            </button>
          </p>
          <p className="mt-2 text-meta leading-relaxed text-ink-soft">
            用 iMessage 给这个号码发条消息，AI 就会回你。这是 Photon
            分配的共享号码，只回复已登记的手机——别人要先用自己的号在这里登记一次。
          </p>
          {reused && (
            <p className="mt-1.5 text-meta text-ink-faint">
              这个号早就登记过了，直接复用原来那条线路，没有新占配额。
            </p>
          )}
        </div>
      )}

      {error && (
        <p className="mt-3 border-l-2 border-warn py-1.5 pl-3 text-meta leading-relaxed text-warn">
          {error}
        </p>
      )}

      {/* 兜底：自己在终端跑 */}
      <button
        type="button"
        onClick={() => setShowFallback((s) => !s)}
        className="mt-3 inline-flex items-center gap-1.5 text-meta text-ink-soft transition-colors duration-150 hover:text-ink"
      >
        <Terminal size={14} />
        这边失败了？自己在终端跑一次
        <ChevronDown size={13} className={showFallback ? "rotate-180 transition-colors duration-150" : "transition-colors duration-150"} />
      </button>

      {showFallback && (
        <div className="mt-3">
          <div className="mb-2 flex items-center gap-1">
            {TERMINAL_CMDS.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setOs(c.id)}
                className={`rounded-item px-3 py-1 text-meta transition-colors duration-150 ${
                  os === c.id ? "bg-ink text-paper-invert" : "text-ink-soft hover:bg-sunken hover:text-ink"
                }`}
              >
                {c.label}
              </button>
            ))}
            <span className="ml-1 text-meta text-ink-faint">{cmd.hint}</span>
          </div>
          <CodeBlock code={cmd.code} />
          <p className="mt-2 text-meta leading-relaxed text-ink-faint">
            把 <code className="bg-sunken px-1">你的 Project ID</code> 和手机号换成自己的，
            Secret 会提示你手动输入、不会留在命令历史里。返回的 JSON 里那个{""}
            <code className="bg-sunken px-1">assignedPhoneNumber</code>{""}
            就是线路号码，填回上面的输入框旁边也行——直接记住它，用 iMessage 发消息给它即可。
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * 手动填线路号码。
 *
 * 上面那个 EnrollBox 是走 Photon 的 enroll 接口自动拿号，但有些人本来就能
 * 直接收到验证码、手里已经有号码了，不需要再登记一次 —— 给他们一个直接填的地方。
 *
 * 存的是同一个字段（project.linePhone），所以两种方式互相覆盖，不会打架。
 */
export function ManualLineBox({ project }) {
  const { updateProject, save, saveState } = useConfig();
  const [draft, setDraft] = useState(project.linePhone ?? "");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");

  const busy = saveState === "saving";
  const trimmed = draft.trim();
  // 和后端 server/src/photon.js 的 PHONE_RE 同一套规则：+ 开头、7~15 位数字
  const valid = /^\+[1-9]\d{6,14}$/.test(trimmed);

  async function commit() {
    if (!valid) {
      setError("号码要是 E.164 格式：+ 开头、带国家码，例 +18005550100");
      return;
    }
    setError("");
    updateProject(project.id, { linePhone: trimmed });
    try {
      // 直接落盘：这个值桥接每轮现读，不保存等于没填
      await save();
    } catch (e) {
      setError(String(e?.message ?? e));
    }
  }

  return (
    <div className="border border-line bg-paper p-4">
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        className="flex w-full items-center gap-1.5 text-left text-ui text-ink"
      >
        <Smartphone size={15} className="text-ink-faint" />
        已经有线路号码了？自己填
        <ChevronDown
          size={14}
          className={`ml-auto text-ink-faint ${open ? "rotate-180 transition-colors duration-150" : "transition-colors duration-150"}`}
        />
      </button>

      {open && (
        <>
          <p className="mt-1 text-meta leading-relaxed text-ink-faint">
            能直接收到验证码、或者以前记下过号码的，不用再走上面的登记 ——
            填在这儿保存就行。填错了随时改。
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input
              className={inputCls}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setError("");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
              }}
              placeholder="+18005550100"
              inputMode="tel"
            />
            <Button
              onClick={commit}
              disabled={busy || !trimmed || trimmed === (project.linePhone ?? "")}
              className="sm:w-auto sm:shrink-0"
            >
              {busy ? <RefreshCw size={14} className="animate-spin" /> : <Check size={15} />}
              {busy ? "保存中…" : "保存号码"}
            </Button>
          </div>
          {error && (
            <p className="mt-2 flex items-start gap-1.5 text-meta leading-relaxed text-warn">
              {error}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/* 状态文案：桥接每条连接的四种状态 */
export const CONN_LABELS = { idle: "空闲", connecting: "连接中", connected: "已连接", error: "启动失败" };

/**
 * 「重连中（第 N 次）」。
 *
 * 后端从这一版起会自己重试挂掉的连接（imessage.js:scheduleRetry），所以
 * `status:"error"` 不再等于「死了等你来点」—— 光显示「启动失败」会让人以为
 * 得自己动手。带上次数，用户一眼能看出它还在爬。
 */
export function connStatusText(conn) {
  const base = CONN_LABELS[conn.status] ?? conn.status;
  if (conn.status !== "error") return base;
  return conn.nextRetryAt ? `${base}，重连中（第 ${conn.retries ?? 1} 次）` : base;
}

/**
 * 轮询 /api/status。角色切换器、角色面板、项目面板都要用，收成一个 hook。
 * 返回按项目 id 索引的表，调用方不用自己找。
 */
export function useBridgeStatus(intervalMs = 3000) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api("/api/status"));
      setError(null);
    } catch (e) {
      // 读不到通常是后端没起来——要说出来，别一直挂着「读取中…」
      setError(String(e?.message ?? e));
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, intervalMs);
    return () => clearInterval(t);
  }, [refresh, intervalMs]);

  const byProject = useMemo(() => {
    const map = {};
    for (const p of status?.projects ?? []) map[p.id] = p;
    return map;
  }, [status]);

  return { byProject, summary: status?.summary ?? null, loaded: Boolean(status), error, refresh };
}

/**
 * 项目卡片（列表态）。一个 Photon 项目 = 一条 iMessage 号码。
 * 一屏看完：显示名、线路号码、在线状态、绑的角色。
 * 项目多了以后一路往下滚很难找，所以列表用网格，凭据那些点进详情看。
 */
/** 项目详情：凭据、登记手机号、这条连接的状态。 */
export function ProjectDetail({ project, conn, statusError, loaded, onRefresh, onBack, onDelete }) {
  const { config, updateProject, dirty, save } = useConfig();
  const [showSecret, setShowSecret] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState(null);

  const label = projectLabel(config, project.id);
  const role = (config.roles ?? []).find((r) => r.projectRef === project.id) ?? null;
  const ready = projectReady(project);

  async function restart() {
    setRestarting(true);
    setRestartError(null);
    try {
      // 有未保存的改动就先落盘，否则重启用的还是旧凭据
      if (dirty) await save();
      await api("/api/imessage/restart", { method: "POST", body: { projectId: project.id } });
    } catch (e) {
      setRestartError(String(e?.message ?? e));
    } finally {
      await onRefresh?.();
      setRestarting(false);
    }
  }

  const connLabel = statusError
    ? "连不上后端"
    : !loaded
    ? "读取中…"
    : conn
    ? connStatusText(conn)
    : role
    ? ready
      ? "未上线"
      : "缺凭据"
    : "未绑定角色";

  return (
    <div className="grid grid-cols-1 gap-rhythm-sm lg:gap-rhythm">
      <Card
        title="项目设置"
        desc={role ? `绑定角色「${roleLabel(role)}」` : "还没绑定角色，这条号码不会上线"}
        actions={
          <Button variant="ghost" onClick={restart} disabled={restarting}>
            <RefreshCw size={14} className={restarting ? "animate-spin" : ""} /> 重连
          </Button>
        }
      >
      <div className="grid grid-cols-1 gap-6">
        {/* 接入方式 */}
        <Field label="接入方式">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                onClick={() => updateProject(project.id, { mode: m.value })}
                className={`border p-3.5 text-left transition-colors duration-150 ${
                  project.mode === m.value
                    ? "border-ink bg-sunken"
                    : "border-line bg-paper hover:bg-sunken"
                }`}
              >
                <span className="flex items-center gap-2 text-ui text-ink">
                  <AtSign size={15} className={project.mode === m.value ? "text-ink" : "text-ink-faint"} />
                  {m.label}
                </span>
                <span className="mt-1 block text-meta leading-snug text-ink-faint">{m.desc}</span>
              </button>
            ))}
          </div>
        </Field>

        {/* 凭据 / 路径 */}
        {project.mode === "cloud" ? (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <Field label="Project ID" hint="Photon 项目 ID">
              <input
                className={inputCls}
                value={project.projectId ?? ""}
                onChange={(e) => updateProject(project.id, { projectId: e.target.value })}
                placeholder="pur_… 或项目 id"
              />
            </Field>
            <Field label="Project Secret">
              <div className="relative">
                <input
                  className={`${inputCls} pr-10`}
                  type={showSecret ? "text" : "password"}
                  value={project.projectSecret ?? ""}
                  onChange={(e) => updateProject(project.id, { projectSecret: e.target.value })}
                  placeholder="photon 项目密钥"
                />
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-item p-1 text-ink-faint hover:text-ink"
                  onClick={() => setShowSecret((s) => !s)}
                >
                  {showSecret ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </Field>
          </div>
        ) : (
          <Field label="本地路径" hint="macOS 上的 Messages 数据库路径（可选）">
            <input
              className={inputCls}
              value={project.localPath ?? ""}
              onChange={(e) => updateProject(project.id, { localPath: e.target.value })}
              placeholder="留空则自动检测"
            />
          </Field>
        )}

        <p className="border-l-2 border-line py-1.5 pl-3 text-meta leading-relaxed text-ink-soft">
          <ShieldCheck size={15} className="mt-0.5 shrink-0 text-good" />
          凭据和手机号仅写入本地 data.config.json（已在 .gitignore 中），不会上传 GitHub。
        </p>

        <SaveBar hint="登记手机号和重连都会先自动保存" />

        {/* 手机号登记 → 线路号码 */}
        {project.mode === "cloud" && <EnrollBox project={project} onDone={onRefresh} />}
        {project.mode === "cloud" && <ManualLineBox project={project} />}

        {/* 这条连接自己的状态 */}
        <div className="border border-line bg-paper p-4">
          <div className="flex items-center justify-between">
            <span className="text-ui text-ink">这条号码的状态</span>
            <span
              className={`inline-flex items-center gap-1.5 text-eyebrow uppercase ${
                conn?.status === "connected"
                  ? "text-good"
                  : conn?.status === "connecting"
                  ? "text-ink"
                  : conn?.status === "error" || statusError
                  ? "text-warn"
                  : "text-ink-faint"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full bg-current ${
                  conn?.status === "connecting" ? "animate-pulse" : ""
                }`}
              />
              {connLabel}
            </span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 text-ui sm:grid-cols-4">
            <div>
              <p className="text-meta text-ink-faint">线路号码</p>
              <p className="mt-0.5 font-mono text-meta text-ink">
                {project.linePhone || "—"}
              </p>
            </div>
            <div>
              <p className="text-meta text-ink-faint">已回复</p>
              <p className="mt-0.5 text-ink">{conn?.messageCount ?? 0} 条</p>
            </div>
            <div>
              {/*
                图、语音、视频挤在同一格里：这排是四列的固定布局，各自单开一格会
                把「开始时间」挤到下一行。是 0 的时候干脆不提。
              */}
              <p className="text-meta text-ink-faint">已识别</p>
              <p className="mt-0.5 text-ink">
                {conn?.imageCount ?? 0} 张图
                {(conn?.audioCount ?? 0) > 0 ? ` · ${conn.audioCount} 条语音` : ""}
                {(conn?.videoCount ?? 0) > 0 ? ` · ${conn.videoCount} 段视频` : ""}
              </p>
            </div>
            <div>
              <p className="text-meta text-ink-faint">开始时间</p>
              <p className="mt-0.5 text-ink">
                {conn?.startedAt ? new Date(conn.startedAt).toLocaleTimeString() : "—"}
              </p>
            </div>
          </div>

          {!role && (
            <p className="mt-4 border-l-2 border-line py-1.5 pl-3 text-meta leading-relaxed text-ink-soft">
              这个项目还没被任何角色绑定，所以不会上线。去「角色」面板绑一个。
            </p>
          )}
          {role && !ready && (
            <p className="mt-4 border-l-2 border-warn py-1.5 pl-3 text-meta leading-relaxed text-warn">
              还缺 Project ID / Secret，填齐并保存后才会上线。
            </p>
          )}
          {/*
            连上了但没号码 —— 状态是真的（凭据通了、流也开着），但没人能发进来。
            这一条专门解释这个看着矛盾的组合：连接条件不看 linePhone，收发消息看。
          */}
          {conn?.status === "connected" && project.mode === "cloud" && !project.linePhone?.trim() && (
            <p className="mt-4 border-l-2 border-warn py-1.5 pl-3 text-meta leading-relaxed text-warn">
              已经连上 Photon 了，但这条项目还没有线路号码 ——
              没有号码就没有人能给它发消息。用上面的「登记手机号」自动拿一条，
              或者展开「已经有线路号码了？自己填」直接填进来。
            </p>
          )}
          {(conn?.error || restartError) && (
            <p className="mt-4 whitespace-pre-wrap break-words border-l-2 border-warn py-1.5 pl-3 text-meta leading-relaxed text-warn">
              {conn?.error || restartError}
            </p>
          )}
          {statusError && (
            <p className="mt-4 whitespace-pre-wrap break-words border-l-2 border-warn py-1.5 pl-3 text-meta leading-relaxed text-warn">
              读不到后端状态：{statusError}
            </p>
          )}
        </div>

        {onDelete && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <p className="text-meta leading-relaxed text-ink-faint">
              删掉这个项目。绑着它的角色会变回未绑定，号码随即下线。
            </p>
            <Button variant="ghost" onClick={onDelete} className="text-warn hover:bg-warn/[0.08]">
              <Trash2 size={14} /> 删除项目
            </Button>
          </div>
        )}
      </div>
      </Card>
    </div>
  );
}

export function ImessagePanel({ bridge }) {
  const { config, removeProject } = useConfig();
  const { byProject, summary, loaded, error, refresh } = bridge;
  const { itemId, pick } = useSection();
  const projects = config.projects ?? [];
  const [showGuide, setShowGuide] = useState(() => !projects.some((p) => p.linePhone));
  const open = projects.find((p) => p.id === itemId) ?? null;

  if (open) {
    return (
      <ProjectDetail
        project={open}
        conn={byProject[open.id] ?? null}
        statusError={error}
        loaded={loaded}
        onRefresh={refresh}
        onBack={() => pick("")}
        onDelete={() => {
          removeProject(open.id);
          pick("");
        }}
      />
    );
  }

  return (
    <div className="grid grid-cols-1 gap-rhythm-sm lg:gap-rhythm">
      <Card title="桥接总览" desc="每个项目一条号码，绑定了角色又填齐凭据的会同时在线">
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
          <div>
            <p className="text-eyebrow uppercase text-ink-faint">项目总数</p>
            <p className="mt-2 font-serif text-h2 text-ink">{projects.length}</p>
          </div>
          <div>
            <p className="text-eyebrow uppercase text-ink-faint">在线号码</p>
            <p className="mt-2 font-serif text-h2 text-ink">
              {error ? "—" : loaded ? (summary?.connected ?? 0) : "…"}
            </p>
          </div>
          <div>
            <p className="text-eyebrow uppercase text-ink-faint">累计回复</p>
            <p className="mt-2 font-serif text-h2 text-ink">{summary?.messageCount ?? 0}</p>
          </div>
          <div>
            <p className="text-eyebrow uppercase text-ink-faint">累计识图</p>
            <p className="mt-2 font-serif text-h2 text-ink">{summary?.imageCount ?? 0}</p>
            {/*
              听音和看视频都不单开一格：四个大数字排成一行正好，第五个会掉到
              下一行。两个都挂在识图这格底下，哪个是 0 就不提哪个
            */}
            {((summary?.audioCount ?? 0) > 0 || (summary?.videoCount ?? 0) > 0) && (
              <p className="mt-1 text-meta text-ink-faint">
                另有{" "}
                {[
                  (summary?.audioCount ?? 0) > 0 && `${summary.audioCount} 条语音`,
                  (summary?.videoCount ?? 0) > 0 && `${summary.videoCount} 段视频`,
                ]
                  .filter(Boolean)
                  .join("、")}
              </p>
            )}
          </div>
        </div>

        {error && (
          <p className="mt-8 whitespace-pre-wrap break-words border-l-2 border-warn py-1.5 pl-3 text-meta leading-relaxed text-warn">
            读不到后端状态：{error}
            {"\n"}后端没起来的话，在项目目录跑 npm start 再看。
          </p>
        )}

        <p className="mt-8 max-w-[62ch] text-body text-ink-soft">
          {projects.length
            ? "左边挑一个项目，改它的凭据和号码。"
            : "左边还没有项目。点列表标题旁的「+」新建一个，把 Photon 的 Project ID / Secret 填进来。"}
        </p>
      </Card>

      {/* 开通引导 */}
      <section className="scroll-mt-8">
        <button
          type="button"
          onClick={() => setShowGuide((s) => !s)}
          aria-expanded={showGuide}
          className="flex w-full items-center justify-between gap-4 border-b border-line pb-4 text-left transition-colors duration-150 hover:text-ink"
        >
          <span className="font-serif text-h2 text-ink">第一次用？先开通 Photon</span>
          <ChevronDown
            size={18}
            className={`shrink-0 text-ink-faint transition-transform duration-150 ${
              showGuide ? "rotate-180" : ""
            }`}
          />
        </button>

        {showGuide && (
          <>
            <ol className="mt-8 grid grid-cols-1 gap-6">
              {GUIDE_STEPS.map((s, i) => (
                <li key={s.title} className="flex gap-4">
                  <span className="shrink-0 pt-0.5 font-mono text-meta text-ink-meta">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <div className="min-w-0 max-w-[62ch]">
                    <p className="text-h3 text-ink">{s.title}</p>
                    <p className="mt-1.5 text-meta leading-relaxed text-ink-faint">{s.body}</p>
                    {s.link && (
                      <a
                        href={s.link}
                        target="_blank"
                        rel="noreferrer"
                        className="link-slide mt-2 inline-flex items-center gap-1 text-meta text-ink"
                      >
                        {s.linkLabel}
                        <ExternalLink size={12} />
                      </a>
                    )}
                  </div>
                </li>
              ))}
            </ol>
            <p className="mt-8 max-w-[62ch] text-meta leading-relaxed text-ink-faint">
              想加第二条号码就在 Photon 里再建一个项目，回来点侧栏的「+」把凭据填进去，
              再去「角色」面板给它绑一个角色。
            </p>
          </>
        )}
      </section>
    </div>
  );
}
