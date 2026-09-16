import { useEffect, useMemo, useRef, useState } from "react";
import { api, useConfig, useLogs } from "../store.jsx";
import { Button, Card, Field, inputCls, Modal, NumberField, ResultNote, Switch } from "../ui.jsx";
import {
  ArrowDownToLine,
  Check,
  ChevronDown,
  Cloud,
  CloudUpload,
  Copy,
  Download,
  Eraser,
  Github,
  KeyRound,
  LogOut,
  Pause,
  Play,
  Plug,
  Power,
  Radio,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";

/*
 * 五个级别。`cls` 是 scope 标签的样式 —— 不用色块，靠字色区分：
 * 细节最淡、信息是正文色、警告以上走状态色（那几个承载真信息）。
 *
 * 这里的 id 必须和后端 server/src/logs.js 的 LEVELS 一字不差 ——
 * 对不上的话那一级的日志会走 `?? LEVEL_META.info` 的兜底，显示成「信息」。
 */
export const LEVEL_META = {
  debug: { label: "细节", cls: "text-ink-meta", dot: "bg-ink-meta" },
  info: { label: "信息", cls: "text-ink", dot: "bg-ink" },
  warn: { label: "警告", cls: "text-warn", dot: "bg-warn" },
  error: { label: "错误", cls: "text-warn", dot: "bg-warn" },
  critical: { label: "严重", cls: "text-warn", dot: "bg-warn" },
};

/** 级别从低到高——过滤器选中某一级就显示它「及以上」。 */
export const LEVEL_ORDER = ["debug", "info", "warn", "error", "critical"];

/**
 * 过滤器直接列出五个级别本身（用户明确要的 DEBUG / INFO / WARNING /
 * ERROR / CRITICAL），选中哪个就是「这一级及以上」。
 *
 * 以前是三个概括性的按钮（全部 / 信息以上 / 只看问题），少了两档，
 * 而且看不出「以上」是从哪儿算起 —— 现在按钮名就是那个起点。
 *
 * 用大写英文而不是中文：这几个词是日志级别的通用叫法，和后端日志里
 * 打出来的 `[error]` 对得上，比「只看问题」这种说法更好对照。
 */
export const LEVEL_FILTERS = [
  { id: "debug", label: "DEBUG" },
  { id: "info", label: "INFO" },
  { id: "warn", label: "WARNING" },
  { id: "error", label: "ERROR" },
  { id: "critical", label: "CRITICAL" },
];

export function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** 一行日志。detail 存在时可以点开看原始内容（错误栈、上游响应…）。 */
export function LogRow({ entry }) {
  const [open, setOpen] = useState(false);
  const meta = LEVEL_META[entry.level] ?? LEVEL_META.info;
  const hasDetail = Boolean(entry.detail);

  return (
    <div
      className={`border-b border-line px-3 py-1.5 last:border-b-0 ${
        entry.level === "error" || entry.level === "critical" ? "bg-warnsoft" : ""
      }`}
    >
      <div className="flex items-start gap-2">
        <span className="mt-[3px] shrink-0 font-mono text-meta tabular-nums text-ink-meta">
          {fmtTime(entry.ts)}
        </span>
        <span
          className={`mt-[2px] shrink-0 text-eyebrow uppercase ${meta.cls}`}
        >
          {entry.scope}
        </span>
        <button
          type="button"
          onClick={() => hasDetail && setOpen((o) => !o)}
          className={`min-w-0 flex-1 text-left text-meta leading-relaxed ${
            LEVEL_ORDER.indexOf(entry.level) >= LEVEL_ORDER.indexOf("warn")
              ? "text-warn"
              : "text-ink-soft"
          } ${hasDetail ? "cursor-pointer hover:text-ink" : "cursor-default"}`}
        >
          <span className="whitespace-pre-wrap break-words">{entry.message}</span>
          {hasDetail && (
            <ChevronDown
              size={12}
              className={`ml-1 inline shrink-0 text-ink-meta transition-transform duration-150 ${open ? "rotate-180" : ""}`}
            />
          )}
        </button>
      </div>
      {open && hasDetail && (
        <pre className="mt-1.5 max-h-64 overflow-auto bg-sunken px-3 py-2 text-meta leading-relaxed text-ink-soft">
          <code>{entry.detail}</code>
        </pre>
      )}
    </div>
  );
}

export function ConsolePanel() {
  const { logs, connected, paused, setPaused, pendingCount, clear } = useLogs();
  const [level, setLevel] = useState("info");
  const [query, setQuery] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const boxRef = useRef(null);

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

  // 各级别条数，让「只看问题」有没有东西一眼可见
  const counts = useMemo(() => {
    const c = Object.fromEntries(LEVEL_ORDER.map((lv) => [lv, 0]));
    for (const e of logs) if (c[e.level] !== undefined) c[e.level] += 1;
    return c;
  }, [logs]);

  /** 有报错、而且现在看不到 debug —— 那一档里才有「每一步发了什么请求」。 */
  const suggestDebug = level !== "debug" && Boolean(counts.error || counts.critical);

  // 新日志进来就贴到底部（用户手动往上翻时不抢滚动条）
  useEffect(() => {
    if (!autoScroll) return;
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [filtered, autoScroll]);

  /** 用户往上滚就自动关掉跟随，滚回底部再打开。 */
  function onScroll() {
    const box = boxRef.current;
    if (!box) return;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    setAutoScroll(atBottom);
  }

  function copyAll() {
    const text = filtered
      .map(
        (e) =>
          `${fmtTime(e.ts)} [${e.level}] [${e.scope}] ${e.message}${e.detail ? `\n ${e.detail.replace(/\n/g, "\n ")}` : ""}`
      )
      .join("\n");
    navigator.clipboard?.writeText(text);
  }

  return (
    <Card
      title="运行控制台"
      desc="后端实时日志：收到什么消息、打给哪条 API、图片识别成什么、哪里报错"
      actions={
        <span
          className={`inline-flex shrink-0 items-center gap-1.5 text-eyebrow uppercase ${
            connected ? "text-good" : "text-warn"
          }`}
        >
          <Radio size={12} className={connected ? "animate-pulse" : ""} />
          {connected ? "实时连接中" : "已断开，正在重连…"}
        </span>
      }
    >
      <div className="grid grid-cols-1 gap-6">
        {/* 工具条 */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-0.5">
            {LEVEL_FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setLevel(f.id)}
                className={`rounded-item px-2.5 py-1 text-meta transition-colors duration-150 ${
                  level === f.id
                    ? "bg-sunken text-ink"
                    : "text-ink-meta hover:bg-sunken hover:text-ink"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div className="flex min-w-[140px] flex-1 items-center gap-1.5 border-b border-line pb-1.5 focus-within:border-ink">
            <Search size={13} className="shrink-0 text-ink-meta" />
            <input
              className="w-full bg-transparent text-meta text-ink outline-none placeholder:text-ink-meta"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索关键词…"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="清空搜索"
                className="shrink-0 text-ink-meta transition-colors duration-150 hover:text-ink"
              >
                <X size={13} />
              </button>
            )}
          </div>

          <Button variant="ghost" onClick={() => setPaused(!paused)}>
            {paused ? <Play size={14} /> : <Pause size={14} />}
            {paused ? `继续${pendingCount ? `（+${pendingCount}）` : ""}` : "暂停"}
          </Button>
          <Button variant="ghost" onClick={copyAll} disabled={!filtered.length}>
            <Copy size={14} /> 复制
          </Button>
          <Button variant="ghost" onClick={clear} disabled={!logs.length}>
            <Trash2 size={14} /> 清空
          </Button>
        </div>

        {/* 统计 */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-meta text-ink-faint">
          <span>
            共 <span className="text-ink">{logs.length}</span> 条
            {filtered.length !== logs.length && `，筛出 ${filtered.length} 条`}
          </span>
          {LEVEL_ORDER.map((lv) =>
            counts[lv] ? (
              <span key={lv} className="inline-flex items-center gap-1.5">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${LEVEL_META[lv].dot}`} />
                {LEVEL_META[lv].label} {counts[lv]}
              </span>
            ) : null
          )}
          {paused && (
            <span className="inline-flex items-center gap-1 text-warn">
              <Pause size={12} /> 已暂停，新日志攒着
            </span>
          )}
        </div>

        {/*
          出错了才提示切 DEBUG。
          默认级别是 INFO（debug 那些「发了什么请求」平时是噪音），但真出问题时
          它们正是要看的东西 —— 而用户不会知道这里还有一档更细的。
          没报错的时候不显示，别让它变成常驻噪音。
        */}
        {suggestDebug && (
          <div className="flex flex-wrap items-center gap-2 border-l-2 border-warn py-1.5 pl-3 text-meta leading-relaxed text-ink-soft">
            <span>有报错。切到 DEBUG 再跑一遍，能看到每一步发了什么请求、花了多久。</span>
            <button
              type="button"
              onClick={() => setLevel("debug")}
              className="text-ink underline decoration-line underline-offset-2 transition-colors duration-150 hover:decoration-ink"
            >
              切到 DEBUG
            </button>
          </div>
        )}

        {/* 日志列表 */}
        <div className="relative">
          <div
            ref={boxRef}
            onScroll={onScroll}
            className="h-[420px] overflow-y-auto border border-line lg:h-[540px]"
          >
            {filtered.length === 0 ? (
              <div className="flex h-full items-center justify-center px-6">
                <p className="max-w-[52ch] text-center text-meta leading-relaxed text-ink-faint">
                  {logs.length === 0
                    ? "还没有日志。给线路号码发条 iMessage，或者去「连接」点一下测试。"
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
              className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 rounded-full border border-line bg-paper px-3 py-1.5 text-meta text-ink-soft transition-colors duration-150 hover:bg-sunken hover:text-ink"
            >
              <ArrowDownToLine size={13} /> 回到最新
            </button>
          )}
        </div>

        <p className="max-w-[62ch] text-meta leading-relaxed text-ink-faint">
          点有小箭头的那行可以展开原始内容（错误栈、上游返回的完整报文）。
          「复制」会把当前筛选出来的日志按纯文本拷走，方便贴给我排查。
        </p>
      </div>
    </Card>
  );
}

/**
 * 服务控制：重启整个服务 + 清理缓存。
 *
 * 和「连接」面板那个「重连」是两回事，这里刻意写清楚了 —— 那个只是把桥接
 * 断开重连，进程还是原来那个；这个是让整个服务退出再由启动器拉起来。
 *
 * 重启按钮在「不是启动器拉起来的」时候是禁用的（canRestart=false）：那种
 * 情况下退出之后没人负责把服务开回来，点一下就等于把它关了。
 */
/**
 * 「定时做这件事」那一对控件：一个开关 + 打开时露出来的间隔。
 *
 * 定时重启、定时清缓存、定时云备份长得一模一样，只有文案和字段名不同，所以抽出来。
 * 保存不用自己管 —— 改了 config 之后外壳底部的 GlobalSaveBar 会自己出来。
 *
 * 间隔是**两个框**（天 + 小时），不是一个大小时数。合并成一个数看着更省地方，
 * 但「每 1 天 6 小时」会显示成「每 30 小时」，下次打开就认不出自己填的是什么了；
 * 而且想填「每 3 天」还得自己心算 72（用户原话：「每 X 天 X 小时」）。
 * 两个字段后端也是分开存的，见 config.js:normalizeInterval。
 */
function MaintenanceFields({ title, desc, value, onChange }) {
  const enabled = Boolean(value?.enabled);
  // 老配置里只有 hours 一个字段（能到 168），拆法照抄后端 normalizeInterval ——
  // 用户打开面板看到的必须是同一个间隔。后端那边每次保存都会把 days 补上，
  // 所以这条分支正常只在「刚升级、还没保存过」的时候走
  const carry = useMemo(() => {
    const total = Number(value?.hours);
    if (!Number.isFinite(total) || total <= 23) return null;
    const need = value?.days === undefined || !Number(value?.days);
    if (!need) return null;
    return { days: Math.floor(total / 24), hours: total % 24 };
  }, [value?.days, value?.hours]);
  const days = carry ? carry.days : Number(value?.days) || 0;
  const hours = carry ? carry.hours : Number(value?.hours) || 0;

  // 两个都是 0 等于每一跳都触发，那是灾难不是意图。开关一打开就补成 1 小时，
  // 和后端 normalizeInterval 的兜底同一个规矩
  const open = (next) => {
    const d = next.days ?? days;
    const h = next.hours ?? hours;
    return { enabled: true, ...(d || h ? { days: d, hours: h } : { days: 0, hours: 1 }) };
  };

  return (
    <div className="grid grid-cols-1 gap-4 border-t border-line pt-4">
      <label className="flex items-start justify-between gap-4">
        <span className="min-w-0">
          <span className="block text-ui text-ink">{title}</span>
          <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">{desc}</span>
        </span>
        <Switch
          checked={enabled}
          onChange={(v) =>
            onChange(v ? open({}) : { enabled: false, days, hours })
          }
          label={title}
        />
      </label>
      {enabled && (
        <>
          <div className="grid grid-cols-2 gap-4">
            <NumberField
              label="每隔（天）"
              value={days}
              min={0}
              max={90}
              step={1}
              suffix="天"
              onChange={(v) => onChange(open({ days: v }))}
            />
            <NumberField
              label="再加（小时）"
              value={hours}
              min={0}
              max={23}
              step={1}
              suffix="小时"
              onChange={(v) => onChange(open({ hours: v }))}
            />
          </div>
          <p className="text-meta leading-relaxed text-ink-faint">
            两个都填 0 按 1 小时算。填「0 天 6 小时」就是每 6 小时一次。
            <br />
            计时<span className="text-ink">不从服务启动算起</span> —— 从上次真跑过的
            时刻接着数。重启服务、关掉再打开，倒计时都接着走；到点那一刻没跑成
            （比如服务正好停着），回来就跑一次，中间的不会补。
          </p>
        </>
      )}
    </div>
  );
}

/**
 * 「账号」那一节：改控制台的登录账号和密码。
 *
 * 登录页上那一次是**强制**的（拿默认密码进来之后必须改），这一节是之后想改
 * 随时能改的地方 —— 所以这里多要一样东西：**当前密码**。不问的话，任何人
 * 摸到一台没锁屏、页面还开着的机器就能直接换掉密码把主人关在门外。
 *
 * 规则和后端 auth.js 的 checkPassword 一字不差：不少于 8 位、至少一个大写。
 * 前端这道只为当场给提示，后端那道才是真的闸。
 */
export function AccountPanel() {
  const [who, setWho] = useState("");
  const [name, setName] = useState("");
  const [current, setCurrent] = useState("");
  const [pass, setPass] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null); // { ok, text }

  useEffect(() => {
    api("/api/auth/state")
      .then((r) => {
        setWho(r?.username ?? "");
        setName(r?.username ?? "");
      })
      .catch(() => {});
  }, []);

  // 和 panels/auth.jsx 的 checkPassword 同一套规则。两处都写是因为那一页在
  // 登录门里、这一页在控制台里，中间没有共用模块可放（ui.jsx 是纯展示）
  const rule = pass ? passwordProblem(pass) : "";
  const mismatch = again && pass !== again ? "两次输入的密码不一样。" : "";
  const ready = name.trim() && current && pass && again && !rule && !mismatch;

  async function submit() {
    if (!ready || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await api("/api/auth/change", {
        method: "POST",
        body: { username: name, password: pass, current },
      });
      setWho(r?.username ?? name);
      setCurrent("");
      setPass("");
      setAgain("");
      setNote({ ok: true, text: `改好了。以后用「${r?.username ?? name}」和新密码登录。` });
    } catch (e) {
      setNote({ ok: false, text: String(e?.message ?? e) });
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } catch {
      /* 退出失败也没关系，下面照样刷新 —— cookie 清没清，刷新之后就知道了 */
    }
    window.location.reload();
  }

  return (
    <Card
      title="账号"
      desc="进控制台要用的账号和密码。改完这台机器上别的浏览器、别的设备都得重新登录。"
      actions={
        <Button variant="outline" onClick={logout}>
          <LogOut size={14} />
          退出登录
        </Button>
      }
    >
      <div className="grid grid-cols-1 gap-6">
        <p className="max-w-[62ch] text-meta leading-relaxed text-ink-faint">
          现在登录的是 <span className="text-ink-soft">{who || "（还没问到）"}</span>。
          密码存的是哈希（scrypt 加盐），
          <span className="text-ink-soft">配置文件里看不到原文</span> —— 这样就算这台机器
          把端口开在公网上，别人拿到 data/ 也读不出密码。
        </p>

        <Field label="当前密码" hint="换密码得先证明你是本人">
          <input
            type="password"
            className={inputCls}
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
          />
        </Field>

        <Field label="账号">
          <input
            className={inputCls}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="username"
          />
        </Field>

        <Field label="新密码" hint="至少 8 位，含一个大写字母">
          <input
            type="password"
            className={inputCls}
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            autoComplete="new-password"
          />
        </Field>

        <Field label="再打一遍">
          <input
            type="password"
            className={inputCls}
            value={again}
            onChange={(e) => setAgain(e.target.value)}
            autoComplete="new-password"
          />
        </Field>

        {(rule || mismatch) && <ResultNote state="fail" message={rule || mismatch} icon={KeyRound} />}
        {note && <ResultNote state={note.ok ? "ok" : "fail"} message={note.text} icon={KeyRound} />}

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={submit} disabled={!ready || busy}>
            <KeyRound size={14} />
            {busy ? "保存中…" : "改好了"}
          </Button>
          <span className="text-meta text-ink-meta">这一节不走「保存配置」，点了当场生效</span>
        </div>

        <p className="max-w-[62ch] text-meta leading-relaxed text-ink-faint">
          忘了密码：打开 <span className="text-ink-soft">data/auth.json</span>，把 password
          那一行的值改成 <span className="text-ink-soft">null</span>，存盘就生效（不用重启），
          账号密码回到默认的 Uranus / Uranus，进去之后会让你重新设一遍。用户名也会一起复位。
        </p>
      </div>
    </Card>
  );
}

/**
 * 密码差在哪。空串 = 没问题。
 *
 * 和后端 auth.js:checkPassword、以及登录页那份**必须一致**。用户定的规则只有
 * 两条（不少于 8 位、至少一个大写），别往上加。
 */
function passwordProblem(s) {
  const v = String(s ?? "");
  if (v.length < 8) return `密码至少要 8 位，现在只有 ${v.length} 位。`;
  if (!/[A-Z]/.test(v)) return "密码里至少要有一个大写字母（A-Z）。";
  if (v !== v.trim()) return "密码的开头或结尾有空格，去掉再试。";
  return "";
}

/**
 * 「检查更新」那一块。
 *
 * ── 为什么是「问一句」而不是「直接更新」──
 *
 * 后端只查不装（见 server/src/update.js 的文件头：自动覆盖会踩到用户改过的
 * 文件，而 data/ 里的聊天记录和记忆库是重建不出来的）。所以查到新版之后这里
 * 做的事就是**在按钮旁边问一句**：把版本号、更新说明摆出来，用户点「去更新」
 * 才打开 Release 页面。
 *
 * 不用弹窗问。弹窗是给「点了就发生」的动作用的（重启、恢复备份），而这里
 * 用户要读一段更新说明再决定 —— 那段东西该待在页面上，不该把界面锁住。
 *
 * 三种结果各画一种：查不到（说原因）、已是最新（一句话）、有新版（问一句）。
 */
function UpdateBlock() {
  const [state, setState] = useState("idle"); // idle | checking | done
  const [info, setInfo] = useState(null);
  // 「有新版」那一问被用户按掉之后就别再挡着 —— 这一次会话里不再问
  const [dismissed, setDismissed] = useState(false);

  async function check(force = false) {
    setState("checking");
    setDismissed(false);
    try {
      const r = await api(`/api/update/check${force ? "?force=1" : ""}`);
      setInfo(r);
    } catch (e) {
      // 后端那条路一律回 200，走到这儿说明连自己的服务都没通
      setInfo({ ok: false, error: String(e?.message ?? e) });
    } finally {
      setState("done");
    }
  }

  const asking = state === "done" && info?.hasUpdate && !dismissed;

  return (
    <div className="grid grid-cols-1 gap-4">
      <p className="text-eyebrow uppercase text-ink-faint">检查更新</p>
      <p className="max-w-[62ch] text-meta leading-relaxed text-ink-faint">
        去仓库看一眼有没有发新版本。只是查，
        <span className="text-ink-soft">不会自己下载、也不会动这台机器上的任何文件</span>{" "}
        —— 查到了会在下面问你要不要更新。
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={() => check(false)} disabled={state === "checking"}>
          <RefreshCw size={14} className={state === "checking" ? "animate-spin" : ""} />
          {state === "checking" ? "查询中…" : "检查更新"}
        </Button>
        {/* 当前版本常驻显示 —— 群里最常见的问题就是「我这个是哪个版本」 */}
        {info?.current && (
          <span className="text-meta text-ink-meta">
            当前版本 <span className="font-mono text-ink-faint">v{info.current}</span>
          </span>
        )}
      </div>

      {/* 有新版：就在按钮旁边问 */}
      {asking && (
        <div className="grid grid-cols-1 gap-3 border-l-2 border-ink pl-3">
          <p className="text-ui leading-relaxed text-ink">
            有新版本 <span className="font-mono">{info.latest}</span>
            {info.current && (
              <span className="text-ink-meta">
                （你现在是 <span className="font-mono">v{info.current}</span>）
              </span>
            )}
            ，要更新吗？
          </p>
          {info.notes && (
            <div className="max-h-52 overflow-y-auto bg-sunken px-3 py-2">
              <p className="whitespace-pre-wrap break-words text-meta leading-relaxed text-ink-soft">
                {info.notes}
              </p>
            </div>
          )}
          {/*
           * 更新要手动做，所以先把「更新会发生什么」说清楚 —— 尤其是
           * data/ 不会被动。这句是用户点下去之前最想知道的事。
           */}
          <p className="max-w-[62ch] text-meta leading-relaxed text-ink-faint">
            更新是手动的：点「去更新」打开发布页，照那页的说明覆盖程序文件，再启动一次。
            <span className="text-ink-soft">你的 data/ 文件夹不用动</span>
            —— 配置、聊天记录、记忆库都在里面。动手之前建议先在下面导一份完整备份。
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => window.open(info.url, "_blank", "noreferrer")}>
              <Download size={14} /> 去更新
            </Button>
            <Button variant="ghost" onClick={() => setDismissed(true)}>
              以后再说
            </Button>
          </div>
        </div>
      )}

      {/* 已是最新 */}
      {state === "done" && info?.ok && !info.hasUpdate && (
        <ResultNote
          state="ok"
          message={`已经是最新版本${info.current ? `（v${info.current}）` : ""}。${
            info.cached ? "这是十五分钟内查过的结果，再点一次会重新查。" : ""
          }`}
          icon={Check}
        />
      )}

      {/* 查不到：说原因，再给一条不依赖这个按钮的出路 */}
      {state === "done" && info && !info.ok && (
        <div className="grid grid-cols-1 gap-2">
          <ResultNote state="fail" message={info.error ?? "查不到最新版本"} icon={X} />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" onClick={() => check(true)}>
              <RefreshCw size={14} /> 再查一次
            </Button>
            {info.repo && (
              <a
                href={info.repo}
                target="_blank"
                rel="noreferrer"
                className="link-slide text-meta text-ink-faint"
              >
                直接打开仓库页面
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function ServicePanel() {
  const { config, updateMaintenance } = useConfig();
  // 老配置里可能压根没有 maintenance 这个字段
  const maintenance = config.maintenance ?? {};
  const [canRestart, setCanRestart] = useState(null); // null = 还没问到
  const [busy, setBusy] = useState(""); // "" | restart | cache
  const [note, setNote] = useState(null); // { ok, text }
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    api("/api/status")
      .then((r) => setCanRestart(Boolean(r.canRestart)))
      .catch(() => setCanRestart(false));
  }, []);

  async function doRestart() {
    setConfirming(false);
    setBusy("restart");
    setNote(null);
    try {
      const r = await api("/api/restart", { method: "POST" });
      // ok:false 是业务失败（这份服务重启不了），后端把原因写在 text 里
      setNote({ ok: Boolean(r.ok), text: r.text ?? "已请求重启" });
    } catch (e) {
      setNote({ ok: false, text: String(e?.message ?? e) });
    } finally {
      setBusy("");
    }
  }

  async function clearCache() {
    setBusy("cache");
    setNote(null);
    try {
      const r = await api("/api/cache/clear", { method: "POST" });
      setNote({ ok: true, text: r.text ?? "已清理" });
    } catch (e) {
      setNote({ ok: false, text: String(e?.message ?? e) });
    } finally {
      setBusy("");
    }
  }

  return (
    <Card
      title="服务控制"
      desc="重启整个服务、清掉算出来的缓存、看看有没有新版本。都不会动 data/ 里的任何数据"
    >
      <div className="grid grid-cols-1 gap-10">
        {/* 重启 */}
        <div className="grid grid-cols-1 gap-4">
          <p className="text-eyebrow uppercase text-ink-faint">重启服务</p>
          <p className="max-w-[62ch] text-meta leading-relaxed text-ink-faint">
            让后端退出、再由启动器拉起来，十几秒后自己恢复。
            和「连接」面板里的「重连」不一样 —— 那个只重连桥接，这个是整个服务重来。
            聊天记录、记忆库、配置都在磁盘上，重启不会丢。
            {canRestart === false && (
              <span className="mt-1 block text-warn">
                这份服务不是用「启动.bat」跑起来的，退出之后没人把它开回来，所以按钮是灰的。
              </span>
            )}
          </p>
          <div>
            <Button
              variant="outline"
              onClick={() => setConfirming(true)}
              disabled={Boolean(busy) || canRestart !== true}
            >
              <Power size={14} /> 重启整个服务
            </Button>
          </div>
          <MaintenanceFields
            title="定时重启"
            desc={
              canRestart === false
                ? "这份服务不是用「启动.bat」跑起来的，定时重启开着也不会生效（退出之后没人把它开回来）。"
                : "隔一阵子自己重启一次，用在长时间挂机后内存涨上去、桥接卡住这类地方。到点那一下所有对话会断几十秒。重启本身不会让计时重来。"
            }
            value={maintenance.restart}
            onChange={(patch) => updateMaintenance("restart", patch)}
          />
        </div>

        {/* 清缓存 */}
        <div className="grid grid-cols-1 gap-4">
          <p className="text-eyebrow uppercase text-ink-faint">清理缓存</p>
          <p className="max-w-[62ch] text-meta leading-relaxed text-ink-faint">
            清掉城市坐标、天气、节假日表、编译好的正则、内存里那份配置，
            以及各条连接内存里的上下文。这些都是能重新算出来的东西，
            下次用到时自动生成 —— 只是当轮消息会慢一两秒。
            用在「天气不刷新」「改了盘上的文件没生效」这类地方。
            <span className="mt-1 block">
              顺带清掉 Instagram 里已经没人引用的图片文件 —— 帖子、快拍、精选封面、
              头像里出现过的一张都不动。那些图在界面上压根找不到入口，但只涨不落。
            </span>
          </p>
          <div>
            <Button variant="outline" onClick={clearCache} disabled={Boolean(busy)}>
              <Eraser size={14} className={busy === "cache" ? "animate-pulse" : ""} />
              {busy === "cache" ? "清理中…" : "清理缓存"}
            </Button>
          </div>
          <MaintenanceFields
            title="定时清缓存"
            desc="隔一阵子自己清一次，和上面那个按钮做的事一模一样。代价只是那一轮消息重查天气、慢一两秒。重启服务不会让计时重来。"
            value={maintenance.cache}
            onChange={(patch) => updateMaintenance("cache", patch)}
          />
        </div>

        {/*
         * 检查更新排在最后。前两块是「这台服务现在的状态」，这一块看的是外面 ——
         * 而且它给出的下一步动作（导一份完整备份再更新）就在下面那张卡里。
         */}
        <UpdateBlock />

        <ResultNote
          state={note ? (note.ok ? "ok" : "fail") : "idle"}
          message={note?.text ?? ""}
          icon={note?.ok ? Check : X}
        />
      </div>

      {confirming && (
        <Modal
          title="重启整个服务？"
          desc="后端会退出再由启动器拉起来，大概十几秒。这期间收到的消息要等服务回来才处理。"
          onClose={() => setConfirming(false)}
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                取消
              </Button>
              <Button onClick={doRestart}>确定重启</Button>
            </div>
          }
        >
          <p className="text-ui leading-relaxed text-ink-soft">
            磁盘上的东西一样都不会动 —— 聊天记录、记忆库、日记、配置都在 data/ 里。
            重启只是把内存里的状态清零、把桥接重新连一遍。
          </p>
        </Modal>
      )}
    </Card>
  );
}

/**
 * 数据导出 / 导入。
 *
 * 主动作是**导出完整备份到本地**：整个 data/ 打成一个 .tar.gz。以前这里只有
 * 一份配置 JSON，用户按「备份」两个字的字面意思去用，结果聊天记录、记忆库、
 * Instagram、表情包一个字节都没备上 —— 那不叫备份。
 *
 * 「只导配置」那条留着，但降成次要的一行：它是**搬家**用的（把角色和预设挪到
 * 另一台机器，不想连着几十兆聊天记录一起搬），不是备份用的。两个动作的措辞
 * 也照这个分：上面说「备份」，下面说「搬家」。
 *
 * 导出默认**不含密钥** —— 带密钥的文件等于一份明文 key 清单，勾选框显式打开。
 * 一个勾选框管两个导出：两条路的规矩本来就一样（后端都是 `?keys=1`），
 * 分成两个只会让人以为它们不一样。
 *
 * 导入按扩展名分流：.tar.gz 走完整恢复，.json 走配置覆盖。两条都是整体替换，
 * 所以都先弹窗把要发生的事摆出来再动手。
 */
export function BackupPanel() {
  const {
    exportBackup,
    importBackup,
    exportFullBackup,
    estimateFullBackup,
    restoreFullBackup,
    dirty,
  } = useConfig();
  const [includeKeys, setIncludeKeys] = useState(false);
  const [busy, setBusy] = useState(""); // "" | full | export | import | restore
  const [note, setNote] = useState(null); // { ok, text }
  const [pending, setPending] = useState(null); // 待确认的导入，见 onPickFile
  const [dataDir, setDataDir] = useState("");
  const [size, setSize] = useState(null); // { files, bytes }，估算出来的完整备份体积
  const fileRef = useRef(null);

  useEffect(() => {
    api("/api/config/path")
      .then((r) => setDataDir(r.dataDir ?? ""))
      .catch(() => {});
  }, []);

  /*
   * 体积跟着密钥勾选走：勾上会多打一个 data.config.json 进去。那个文件才几 KB，
   * 数字上几乎看不出来，但「勾了之后数字没变」会让人怀疑勾选到底生效没有。
   */
  useEffect(() => {
    let dead = false;
    estimateFullBackup(includeKeys)
      .then((r) => {
        if (!dead) setSize({ files: r.files ?? 0, bytes: r.bytes ?? 0 });
      })
      .catch(() => {
        if (!dead) setSize(null);
      });
    return () => {
      dead = true;
    };
  }, [estimateFullBackup, includeKeys]);

  async function runFullExport() {
    setBusy("full");
    setNote(null);
    try {
      const name = await exportFullBackup(includeKeys);
      setNote({ ok: true, text: `已导出完整备份 ${name}` });
    } catch (e) {
      setNote({ ok: false, text: String(e?.message ?? e) });
    } finally {
      setBusy("");
    }
  }

  async function runExport() {
    setBusy("export");
    setNote(null);
    try {
      const name = await exportBackup(includeKeys);
      setNote({ ok: true, text: `已导出 ${name}（只有配置）` });
    } catch (e) {
      setNote({ ok: false, text: String(e?.message ?? e) });
    } finally {
      setBusy("");
    }
  }

  /**
   * 选了文件先在前端认一遍类型，坏文件不用往后端跑一趟。
   *
   * 完整备份包是 gzip 的二进制，前端**不解压**（要引一个解压库进来，为了一句
   * 校验不值当），只按扩展名认，真正的清单校验在后端 `unpackSnapshot` 里 ——
   * 那边认不出来会回一句人话的错误。配置 JSON 照旧当场解析，顺手把条数点出来。
   */
  async function onPickFile(e) {
    const file = e.target.files?.[0];
    e.target.value = ""; // 同一个文件连选两次也要能触发
    if (!file) return;
    setNote(null);

    if (/\.t(ar\.)?gz$/i.test(file.name)) {
      setPending({ kind: "full", file, fileName: file.name, bytes: file.size });
      return;
    }

    try {
      const bundle = JSON.parse(await file.text());
      const c = bundle?.config ?? {};
      setPending({
        kind: "config",
        bundle,
        fileName: file.name,
        counts: {
          providers: c.providers?.length ?? 0,
          roles: c.roles?.length ?? 0,
          users: c.users?.length ?? 0,
          presets: c.presets?.length ?? 0,
          worldBooks: c.worldBooks?.length ?? 0,
          includesSecrets: Boolean(bundle?.includesSecrets),
        },
      });
    } catch {
      setNote({
        ok: false,
        text: "认不出这个文件：完整备份要选 .tar.gz，只导配置的那份要选 .json",
      });
    }
  }

  async function confirmImport() {
    const job = pending;
    setPending(null);
    setNote(null);

    if (job.kind === "full") {
      setBusy("restore");
      try {
        const r = await restoreFullBackup(job.file);
        setNote({
          ok: true,
          text: `已恢复：${(r.applied ?? []).join("、") || "无"}，共 ${r.files ?? 0} 个文件`,
        });
      } catch (e) {
        setNote({ ok: false, text: String(e?.message ?? e) });
      } finally {
        setBusy("");
      }
      return;
    }

    setBusy("import");
    try {
      const r = await importBackup(job.bundle);
      const c = r.counts ?? {};
      setNote({
        ok: true,
        text: `已导入：${c.roles ?? 0} 个角色、${c.users ?? 0} 条用户人设、${c.presets ?? 0} 份预设、${c.worldBooks ?? 0} 本世界书`,
      });
    } catch (e) {
      setNote({ ok: false, text: String(e?.message ?? e) });
    } finally {
      setBusy("");
    }
  }

  const rows =
    pending?.kind === "config"
      ? [
          ["服务商源", pending.counts.providers],
          ["角色", pending.counts.roles],
          ["用户人设", pending.counts.users],
          ["预设", pending.counts.presets],
          ["世界书", pending.counts.worldBooks],
        ]
      : [];

  return (
    <Card
      title="备份 / 恢复"
      desc="把整个数据文件夹打成一个包存到本地，或者用这个包恢复回来"
    >
      <div className="grid grid-cols-1 gap-10">
        {/* 完整备份 */}
        <div className="grid grid-cols-1 gap-4">
          <p className="text-eyebrow uppercase text-ink-faint">完整备份</p>
          <p className="max-w-[62ch] text-meta leading-relaxed text-ink-faint">
            配置、聊天记录、记忆库、Instagram、表情包和参考图
            <span className="text-ink-soft">全都在里面</span>
            ，就是整个数据文件夹的一份快照。恢复的时候包里有的整体换掉，
            包里没有的一个字节不动。
          </p>

          <label className="flex cursor-pointer items-start gap-2.5 text-ui leading-relaxed text-ink-soft">
            <input
              type="checkbox"
              checked={includeKeys}
              onChange={(e) => setIncludeKeys(e.target.checked)}
              className="mt-1 shrink-0 accent-ink"
            />
            <span>
              包含 API 密钥和 Photon 凭据
              <span className="mt-0.5 block text-meta text-ink-faint">
                不勾的话包里这些字段是空的，换机器恢复后自己补上就行
              </span>
            </span>
          </label>

          {includeKeys && (
            <p className="border-l-2 border-warn py-1.5 pl-3 text-meta leading-relaxed text-warn">
              这个文件里是明文的密钥和凭据。别发给别人、别传网盘、别扔进 git。
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={runFullExport} disabled={busy === "full"}>
              {busy === "full" ? (
                <RefreshCw size={14} className="animate-spin" />
              ) : (
                <ArrowDownToLine size={14} />
              )}
              {busy === "full" ? "打包中…" : "导出完整备份到本地"}
            </Button>
            {size && (
              <span className="text-meta text-ink-faint">
                {size.files} 个文件、约 {fmtBytes(size.bytes)}（压缩后更小）
              </span>
            )}
          </div>

          {busy === "full" && (
            <p className="text-meta leading-relaxed text-ink-faint">
              正在打包，图多的话要等一会儿。打完浏览器才会弹下载，这期间别关页面。
            </p>
          )}
        </div>

        {/* 只导配置 */}
        <div className="grid grid-cols-1 gap-4 border-t border-line pt-8">
          <p className="text-eyebrow uppercase text-ink-faint">只导配置（搬家用）</p>
          <p className="max-w-[62ch] text-meta leading-relaxed text-ink-faint">
            一份 JSON，只有角色、用户人设、预设、世界书这些设置，
            <span className="text-ink-soft">不含</span>
            聊天记录和记忆库。想把角色和预设挪到另一台机器、又不想连着几十兆
            聊天一起搬的时候用这个。当备份用不合适 —— 聊出来的东西都不在里面。
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={runExport} disabled={busy === "export"}>
              {busy === "export" ? (
                <RefreshCw size={14} className="animate-spin" />
              ) : (
                <Download size={14} />
              )}
              {busy === "export" ? "导出中…" : "只导出配置 JSON"}
            </Button>
          </div>
        </div>

        {/* 恢复 */}
        <div className="grid grid-cols-1 gap-4 border-t border-line pt-8">
          <p className="text-eyebrow uppercase text-ink-faint">从备份恢复</p>
          <p className="max-w-[62ch] text-meta leading-relaxed text-ink-faint">
            上面两种文件都能选：.tar.gz 是完整备份，.json 是只有配置的那份。
            两种都是<span className="text-ink-soft">整体替换</span>——包里有的那几类会覆盖掉
            现在的，比如包里有 2 个角色，恢复后就只剩这 2 个。选完会先让你确认一遍。
          </p>

          {dirty && (
            <p className="border-l-2 border-warn py-1.5 pl-3 text-meta leading-relaxed text-warn">
              有未保存的改动。先保存或撤销，否则恢复会把它们冲掉。
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".tar.gz,.tgz,application/gzip,application/json,.json"
              className="hidden"
              onChange={onPickFile}
            />
            <Button
              variant="outline"
              onClick={() => fileRef.current?.click()}
              disabled={dirty || busy === "import" || busy === "restore"}
            >
              {busy === "import" || busy === "restore" ? (
                <RefreshCw size={14} className="animate-spin" />
              ) : (
                <Upload size={14} />
              )}
              {busy === "restore" ? "恢复中…" : busy === "import" ? "导入中…" : "选择备份文件…"}
            </Button>
          </div>

          {busy === "restore" && (
            <p className="text-meta leading-relaxed text-ink-faint">
              正在上传并解包，别关页面。恢复完会自动把内存里的旧状态清掉、重连各条线路。
            </p>
          )}
        </div>

        {note && (
          <p
            className={`border-l-2 py-1.5 pl-3 text-meta leading-relaxed ${
              note.ok ? "border-good text-good" : "border-warn text-warn"
            }`}
          >
            {note.text}
          </p>
        )}

        <div className="grid grid-cols-1 gap-2 border-t border-line pt-8">
          <p className="text-eyebrow uppercase text-ink-faint">数据文件夹</p>
          {dataDir && (
            <code className="break-all bg-sunken px-2.5 py-1.5 font-mono text-meta text-ink">
              {dataDir}
            </code>
          )}
          <p className="max-w-[62ch] text-meta leading-relaxed text-ink-faint">
            完整备份就是这个文件夹的打包。角色、世界书、用户人设、预设各占一个子文件夹，
            一个条目一个文件——可以单独拷一个角色或一本世界书给别人。
            想定时往云盘传一份，用下面的「云备份」。
          </p>
        </div>
      </div>

      {pending && (
        <Modal
          title={pending.kind === "full" ? "确认用这个包恢复？" : "确认导入这份配置？"}
          desc={
            pending.kind === "full"
              ? `${pending.fileName}（${fmtBytes(pending.bytes)}）`
              : pending.fileName
          }
          onClose={() => setPending(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setPending(null)}>
                取消
              </Button>
              <Button onClick={confirmImport}>
                <Check size={14} /> 覆盖并恢复
              </Button>
            </>
          }
        >
          {pending.kind === "full" ? (
            <div className="grid grid-cols-1 gap-6">
              <p className="text-ui leading-relaxed text-ink-soft">
                包里有的那几块会<span className="text-ink">整体替换</span>
                现在磁盘上的东西 —— 聊天记录、记忆库、Instagram、表情包都算。
                包里没有的那几块保持不变。
              </p>
              <p className="text-meta leading-relaxed text-ink-faint">
                具体换掉哪几块由包里那份清单说了算，解包时会在日志里列出来。
                被覆盖的 config.json 会在原地留一份 .bak，实在不对可以手动换回去。
              </p>
              <p className="border-l-2 border-warn py-1.5 pl-3 text-meta leading-relaxed text-warn">
                这一步没有撤销。现在的聊天记录如果还想留着，先导一份完整备份出来。
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-6">
              <div className="grid grid-cols-1">
                {rows.map(([label, n]) => (
                  <div
                    key={label}
                    className="flex items-baseline justify-between gap-4 border-b border-line py-2 text-ui text-ink-soft"
                  >
                    <span>{label}</span>
                    <span className="font-mono text-ink">{n}</span>
                  </div>
                ))}
              </div>

              <p className="text-meta leading-relaxed text-ink-faint">
                上面这几类会整体替换掉现在的内容，条数为 0 的表示这一类会被清空。
                聊天记录和记忆库不动 —— 这份文件里没有它们。
              </p>

              {pending.counts.includesSecrets ? (
                <p className="border-l-2 border-warn py-1.5 pl-3 text-meta leading-relaxed text-warn">
                  这份文件带密钥，导入后现在的 API 密钥和 Photon 凭据会被里面的替换掉。
                </p>
              ) : (
                <p className="border-l-2 border-line py-1.5 pl-3 text-meta leading-relaxed text-ink-faint">
                  这份文件不含密钥，现在的 API 密钥和 Photon 凭据保持不变。
                </p>
              )}
            </div>
          )}
        </Modal>
      )}
    </Card>
  );
}

/* ================= 云备份 ================= */

/**
 * 三块备份范围。`id` 必须和后端 cloudbackup.js 的 `SCOPES` 一字不差 ——
 * 勾选按这个 id 直接存进 config，对不上的那一块永远不会被打进包。
 */
const CLOUD_SCOPES = [
  {
    id: "config",
    name: "配置",
    hint: "角色、用户人设、预设、世界书、壁纸设置。几十 KB，几乎不占地方",
  },
  {
    id: "chats",
    name: "聊天与记忆",
    hint: "对话存档、记忆库、Instagram。这是聊出来的东西，丢了重建不了 —— 最该备份的就是它",
  },
  {
    id: "images",
    name: "表情包与参考图",
    hint: "images/ 整个文件夹。通常是最大的一块，慢网上传要很久，默认不带",
  },
];

/** 两家。`id` 同样要和后端 cloud/index.js 里的分发对得上。 */
const CLOUD_PROVIDERS = [
  { id: "s3", name: "缤纷云", icon: Cloud },
  { id: "github", name: "GitHub", icon: Github },
];

/** 和后端 cloudbackup.js:humanBytes 一模一样 —— 两边说的体积不该有出入。 */
function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)}KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)}MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

/** 快照名里那串时间戳 → 「9月13日 18:30」。解不出来（at 是 0）就不显示。 */
function fmtSnapshotTime(at) {
  if (!at) return "";
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 云备份。
 *
 * ── 两拨动作读的不是同一份配置 ──
 *
 * 「测试连接」和体积估算把**草稿**发上去（刚填的那串密钥、刚勾的那几块），
 * 不然「要先点保存才能试一下」就本末倒置了。「立即备份」「刷新列表」
 * 「恢复」「删除」什么都不发，用后端**落盘**的那份 —— 真传上云的东西必须
 * 和本地存着的设置一致，否则云端那份快照对应的配置在本地根本不存在。
 * 所以有未保存改动时后面这几个是禁用的。
 *
 * ── 列表不自动拉 ──
 *
 * 一进控制台就去列云端要一次网络往返，而绝大多数人根本没填凭据，那会在
 * 面板里当场糊一行红字。所以列表是点「刷新」才拉，备份成功后顺手刷一次。
 */
export function CloudBackupPanel() {
  const {
    config,
    dirty,
    updateCloudBackup,
    updateCloudCreds,
    cloudCheck,
    cloudEstimate,
    cloudPush,
    cloudList,
    cloudPull,
    cloudDelete,
  } = useConfig();

  // 老配置里可能压根没有 cloudBackup 这一块
  const cb = config.cloudBackup ?? {};
  const provider = cb.provider === "github" ? "github" : "s3";
  const scopes = cb.scopes ?? {};
  const includeSecrets = Boolean(cb.includeSecrets);
  const creds = cb[provider] ?? {};

  const [busy, setBusy] = useState(""); // "" | check | push | list | pull | delete
  const [note, setNote] = useState(null); // { ok, text }
  const [size, setSize] = useState(null); // { files, bytes } | null
  const [snapshots, setSnapshots] = useState(null); // null = 还没列过
  const [pending, setPending] = useState(null); // { kind: "pull" | "delete", snap }

  const blank = (v) => !String(v ?? "").trim();
  const nothingPicked = !CLOUD_SCOPES.some((s) => scopes[s.id]) && !includeSecrets;

  /*
   * 勾选变了就重估一次体积。防抖 300ms —— 连着拨三个开关不该打三次接口。
   *
   * `scopesKey` 用 JSON 而不是对象本身：每次 updateConfig 都造一个新对象，
   * 直接进依赖数组的话每次渲染都会重跑。
   */
  const scopesKey = JSON.stringify(scopes);
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      cloudEstimate({ scopes: JSON.parse(scopesKey), includeSecrets })
        .then((r) => alive && setSize(r))
        .catch(() => alive && setSize(null));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [scopesKey, includeSecrets, cloudEstimate]);

  /** 六个动作的公共外壳：置忙、清掉上一条回执、失败时把后端那句人话摊出来。 */
  async function run(kind, fn) {
    setBusy(kind);
    setNote(null);
    try {
      return await fn();
    } catch (e) {
      // 后面那句指路：这个面板的报错只有一句结论，而每一步发了什么请求、
      // 哪一步慢、有没有悄悄重试过，都在上面日志区的 DEBUG 一档里
      setNote({
        ok: false,
        text: `${String(e?.message ?? e)}\n想看每一步发生了什么：把上面日志的级别切到 DEBUG，再点一次。`,
      });
      return null;
    } finally {
      setBusy("");
    }
  }

  async function testConnection() {
    const r = await run("check", () => cloudCheck({ ...cb, provider }));
    if (!r) return;
    // 「仓库是公开的」走红字 —— 包不加密，那是真会出事的那条路
    if (r.warning) setNote({ ok: false, text: `${r.provider} ${r.where}：${r.warning}` });
    else setNote({ ok: true, text: `连接正常，${r.where} 里已经有 ${r.count} 份快照` });
  }

  async function pushNow() {
    const r = await run("push", cloudPush);
    if (!r) return;
    const pruned = r.pruned?.length ? `，顺手清掉了 ${r.pruned.length} 份旧的` : "";
    setNote({
      ok: true,
      text: `已上传 ${r.name}（${fmtBytes(r.bytes)}、${r.entries} 个文件）到 ${r.provider}${pruned}`,
    });
    // 刚传完，列表里该多一份 —— 自己刷一次，省得用户再点一下
    try {
      setSnapshots(await cloudList());
    } catch {
      /* 列不出来不影响「传上去了」这件事，别用一行红字盖掉成功的回执 */
    }
  }

  async function refreshList() {
    const list = await run("list", cloudList);
    if (list) setSnapshots(list);
  }

  async function confirmPull() {
    const { snap } = pending;
    setPending(null);
    const r = await run("pull", () => cloudPull(snap.name));
    if (!r) return;
    setNote({
      ok: true,
      text: `已从 ${snap.name} 恢复：${(r.applied ?? []).join("、")}，共 ${r.files} 个文件`,
    });
  }

  async function confirmDelete() {
    const { snap } = pending;
    setPending(null);
    const r = await run("delete", () => cloudDelete(snap.name));
    if (!r) return;
    setSnapshots((list) => (list ?? []).filter((s) => s.name !== snap.name));
    setNote({ ok: true, text: `已删除云端的 ${snap.name}` });
  }

  return (
    <Card
      title="云备份"
      desc="把选中的那几块打成一个压缩包传到云上，保留最近几份。硬盘挂了、文件误删了，从这儿拉回来"
    >
      <div className="grid grid-cols-1 gap-10">
        {/* ---- 传之前先把话说清楚 ---- */}
        <p className="border-l-2 border-warn py-1.5 pl-3 text-meta leading-relaxed text-warn">
          备份包<span className="text-ink">不加密</span>，里面是明文的聊天记录和记忆库。
          所以那个桶必须是<span className="text-ink">私有</span>的、那个仓库必须是{" "}
          <span className="text-ink">private</span> 的 —— 放在公开的位置等于把聊天记录发到网上。
        </p>

        {/* ---- 存哪家 ---- */}
        <div className="grid grid-cols-1 gap-4">
          <p className="text-eyebrow uppercase text-ink-faint">存到哪家</p>

          <div className="flex flex-wrap gap-2">
            {CLOUD_PROVIDERS.map((p) => (
              <Button
                key={p.id}
                variant={provider === p.id ? "primary" : "outline"}
                onClick={() => updateCloudBackup({ provider: p.id })}
              >
                <p.icon size={14} />
                {p.name}
              </Button>
            ))}
          </div>

          {provider === "s3" ? (
            <div className="grid grid-cols-1 gap-4">
              <p className="max-w-[62ch] text-meta leading-relaxed text-ink-faint">
                在缤纷云控制台建一个<span className="text-ink-soft">私有</span>桶，再建一个子账户，
                给它这个桶的对象读写 + 列举权限。注意子账户名
                <span className="text-ink-soft">不能和桶名相同</span>，那样上传会失败。
                填的是 S3 兼容接口，所以 Cloudflare R2、Backblaze B2、自建 MinIO 换个 Endpoint 也能用。
              </p>
              <Field label="Endpoint">
                <input
                  className={inputCls}
                  value={creds.endpoint ?? ""}
                  onChange={(e) => updateCloudCreds("s3", { endpoint: e.target.value })}
                  placeholder="https://s3.bitiful.net"
                />
              </Field>
              <Field label="桶名">
                <input
                  className={`${inputCls} ${blank(creds.bucket) ? "border-warn text-warn" : ""}`}
                  value={creds.bucket ?? ""}
                  onChange={(e) => updateCloudCreds("s3", { bucket: e.target.value })}
                  placeholder="my-backups"
                />
              </Field>
              <Field label="可用区" hint="控制台「Bucket 设置」页面底部那个码">
                <input
                  className={`${inputCls} ${blank(creds.region) ? "border-warn text-warn" : ""}`}
                  value={creds.region ?? ""}
                  onChange={(e) => updateCloudCreds("s3", { region: e.target.value })}
                  placeholder="cn-east-1"
                />
              </Field>
              <Field label="路径前缀" hint="选填，留空就放桶根目录">
                <input
                  className={inputCls}
                  value={creds.prefix ?? ""}
                  onChange={(e) => updateCloudCreds("s3", { prefix: e.target.value })}
                  placeholder="uranus-backups/"
                />
              </Field>
              <Field label="Access Key ID">
                <input
                  className={`${inputCls} ${
                    blank(creds.accessKeyId) ? "border-warn text-warn" : ""
                  }`}
                  value={creds.accessKeyId ?? ""}
                  onChange={(e) => updateCloudCreds("s3", { accessKeyId: e.target.value })}
                />
              </Field>
              <Field label="Secret Access Key">
                <input
                  type="password"
                  className={`${inputCls} ${
                    blank(creds.secretAccessKey) ? "border-warn text-warn" : ""
                  }`}
                  value={creds.secretAccessKey ?? ""}
                  onChange={(e) => updateCloudCreds("s3", { secretAccessKey: e.target.value })}
                />
              </Field>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4">
              <p className="max-w-[62ch] text-meta leading-relaxed text-ink-faint">
                建一个 <span className="text-ink-soft">private</span> 仓库专门放备份。令牌用
                fine-grained 的，只勾这一个仓库的 Contents: write —— 别拿有全部 repo
                权限的经典令牌。一份快照存成一个预发布加一个附件，不会顶掉仓库的正式版本发布。
              </p>
              <Field label="用户名 / 组织名">
                <input
                  className={`${inputCls} ${blank(creds.owner) ? "border-warn text-warn" : ""}`}
                  value={creds.owner ?? ""}
                  onChange={(e) => updateCloudCreds("github", { owner: e.target.value })}
                  placeholder="octocat"
                />
              </Field>
              <Field label="仓库名">
                <input
                  className={`${inputCls} ${blank(creds.repo) ? "border-warn text-warn" : ""}`}
                  value={creds.repo ?? ""}
                  onChange={(e) => updateCloudCreds("github", { repo: e.target.value })}
                  placeholder="my-backups"
                />
              </Field>
              <Field label="访问令牌">
                <input
                  type="password"
                  className={`${inputCls} ${blank(creds.token) ? "border-warn text-warn" : ""}`}
                  value={creds.token ?? ""}
                  onChange={(e) => updateCloudCreds("github", { token: e.target.value })}
                  placeholder="github_pat_..."
                />
              </Field>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" onClick={testConnection} disabled={busy === "check"}>
              <Plug size={14} className={busy === "check" ? "animate-pulse" : ""} />
              {busy === "check" ? "连接中…" : "测试连接"}
            </Button>
            <span className="text-meta text-ink-meta">用眼前这份凭据试，不用先保存</span>
          </div>
        </div>

        {/* ---- 备份哪些 ---- */}
        <div className="grid grid-cols-1 gap-4 border-t border-line pt-8">
          <p className="text-eyebrow uppercase text-ink-faint">备份哪些</p>

          {CLOUD_SCOPES.map((s) => (
            <label key={s.id} className="flex items-start justify-between gap-4">
              <span className="min-w-0">
                <span className="block text-ui text-ink">{s.name}</span>
                <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                  {s.hint}
                </span>
              </span>
              <Switch
                checked={Boolean(scopes[s.id])}
                onChange={(v) => updateCloudBackup({ scopes: { ...scopes, [s.id]: v } })}
                label={s.name}
              />
            </label>
          ))}

          <label className="flex items-start justify-between gap-4 border-t border-line pt-4">
            <span className="min-w-0">
              <span className="block text-ui text-ink">含 API 密钥和 Photon 凭据</span>
              <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                不勾的话恢复时本地这些凭据保持不变，换机器恢复后自己补一遍就行
              </span>
            </span>
            <Switch
              checked={includeSecrets}
              onChange={(v) => updateCloudBackup({ includeSecrets: v })}
              label="含密钥"
            />
          </label>

          {includeSecrets && (
            <p className="border-l-2 border-warn py-1.5 pl-3 text-meta leading-relaxed text-warn">
              包不加密，勾上这个等于把明文密钥传到云上。确认那个桶／仓库只有你自己能访问再勾。
            </p>
          )}

          {nothingPicked ? (
            <p className="border-l-2 border-warn py-1.5 pl-3 text-meta leading-relaxed text-warn">
              一块都没勾，没有可备份的东西。
            </p>
          ) : (
            size && (
              <p className="text-meta leading-relaxed text-ink-faint">
                这样打出来大约 <span className="font-mono text-ink">{fmtBytes(size.bytes)}</span>
                （{size.files} 个文件），压缩之后还会更小
              </p>
            )
          )}
        </div>

        {/* ---- 留几份 + 手动跑一次 ---- */}
        <div className="grid grid-cols-1 gap-4 border-t border-line pt-8">
          <NumberField
            label="云端保留"
            value={Number(cb.keep) || 7}
            min={1}
            max={50}
            step={1}
            suffix="份"
            onChange={(v) => updateCloudBackup({ keep: v })}
            hint="传完新的就把超出的那几份从最老的开始删。1 到 50 份"
          />

          {dirty && (
            <p className="border-l-2 border-warn py-1.5 pl-3 text-meta leading-relaxed text-warn">
              有还没保存的改动。下面这几个动作用的是已保存的设置，先点保存。
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={pushNow} disabled={dirty || nothingPicked || Boolean(busy)}>
              <CloudUpload size={14} />
              {busy === "push" ? "备份中…" : "立即备份"}
            </Button>
            <Button variant="outline" onClick={refreshList} disabled={dirty || Boolean(busy)}>
              <RefreshCw size={14} className={busy === "list" ? "animate-spin" : ""} />
              刷新列表
            </Button>
          </div>

          {note && (
            // whitespace-pre-line：连不上的时候后端那句话是分行写的
            // （毛病一行、怎么办一行），压成一坨就没法读了
            <p
              className={`whitespace-pre-line border-l-2 py-1.5 pl-3 text-meta leading-relaxed ${
                note.ok ? "border-good text-good" : "border-warn text-warn"
              }`}
            >
              {note.text}
            </p>
          )}
        </div>

        {/* ---- 定时 ---- */}
        <div className="border-t border-line pt-4">
          <MaintenanceFields
            title="定时自动备份"
            desc="到点自己打包上传一次，跑在后台。上一轮还在传的话这一轮跳过，不会叠在一起。重启服务不会让计时重来"
            value={cb.auto}
            onChange={(patch) => updateCloudBackup({ auto: { ...(cb.auto ?? {}), ...patch } })}
          />
        </div>

        {/* ---- 云端已有的 ---- */}
        <div className="grid grid-cols-1 gap-4 border-t border-line pt-8">
          <p className="text-eyebrow uppercase text-ink-faint">云端快照</p>

          {snapshots === null ? (
            <p className="text-meta leading-relaxed text-ink-faint">
              点上面那个「刷新列表」看云端现在有哪些备份。
            </p>
          ) : snapshots.length === 0 ? (
            <p className="text-meta leading-relaxed text-ink-faint">
              云端还没有快照，点「立即备份」传第一份。
            </p>
          ) : (
            <div className="grid grid-cols-1">
              {snapshots.map((s) => (
                <div
                  key={s.name}
                  className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 border-b border-line py-3"
                >
                  <div className="min-w-0">
                    <span className="block text-ui text-ink">{fmtSnapshotTime(s.at) || s.name}</span>
                    <span className="mt-0.5 block break-all font-mono text-meta text-ink-faint">
                      {s.name} · {fmtBytes(s.bytes)}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      variant="outline"
                      onClick={() => setPending({ kind: "pull", snap: s })}
                      disabled={dirty || Boolean(busy)}
                    >
                      <RotateCcw size={14} />
                      恢复
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => setPending({ kind: "delete", snap: s })}
                      disabled={dirty || Boolean(busy)}
                    >
                      <Trash2 size={14} />
                      删除
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {pending?.kind === "pull" && (
        <Modal
          title="从云端恢复？"
          desc={`${pending.snap.name}（${fmtBytes(pending.snap.bytes)}）`}
          onClose={() => setPending(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setPending(null)}>
                取消
              </Button>
              <Button onClick={confirmPull}>
                <ArrowDownToLine size={14} /> 覆盖并恢复
              </Button>
            </>
          }
        >
          <div className="grid grid-cols-1 gap-6">
            <p className="text-ui leading-relaxed text-ink-soft">
              这份快照里带着的那几块会<span className="text-ink">整体替换</span>
              掉本地对应的文件夹 —— 比如包里有 2 个角色，恢复完本地就只剩这 2 个，
              现在多出来的会没掉。包里没有的那几块一个字节都不动。
            </p>
            <p className="text-meta leading-relaxed text-ink-faint">
              被覆盖的 config.json 会在同目录留一份 .bak，记忆库里原有的 .bak 也留着。
              恢复完会清一遍缓存并重连各条线路。
            </p>
            <p className="border-l-2 border-warn py-1.5 pl-3 text-meta leading-relaxed text-warn">
              本地现在的对话和记忆会被快照里那份盖掉，这一步撤不回来。
            </p>
          </div>
        </Modal>
      )}

      {pending?.kind === "delete" && (
        <Modal
          title="删掉这份云端快照？"
          desc={`${pending.snap.name}（${fmtBytes(pending.snap.bytes)}）`}
          onClose={() => setPending(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setPending(null)}>
                取消
              </Button>
              <Button onClick={confirmDelete}>
                <Trash2 size={14} /> 删除
              </Button>
            </>
          }
        >
          <p className="text-ui leading-relaxed text-ink-soft">
            只删云端这一份，本地数据一点不动。删了找不回来。
          </p>
        </Modal>
      )}
    </Card>
  );
}
