/*
 * 角色记忆库：记忆 / 备忘录 / 日记。
 *
 * 界面分两层：
 *
 *  - **首页**（选中一个角色之后）：三个大按钮 + 右上角一个齿轮。
 *    三样东西各自的内容量、开没开，在按钮上一眼看完。
 *  - **模块页**：点进去直接就是「已经总结好的内容」（记忆列表 / 备忘录正文 /
 *    日记日历），另有一个「待总结」按钮 —— 待总结的原文也能改。
 *    齿轮进的是全局设置（另一个文件：memorysettings.jsx）。
 *
 * 为什么不用折叠面板堆在一页上（上一版的做法）：三样东西各自都有列表、
 * 编辑器和一份待总结，叠在一页里最要紧的「记忆到底有哪些」被压在最下面，
 * 得滚半屏才看得到。
 *
 * 两种数据，界面上必须让人分得清：
 *
 *  - **内容**（记忆条目、备忘录正文、日记、待总结）在磁盘上的 data/memories/ 里，
 *    走 /api/memories 那几条路由，**不进配置草稿** —— 改一条记忆是立刻落盘的，
 *    和底下那条全局「保存」按钮无关。
 *  - **设置**（三个模型、轮数、四段提示词…）在 config.memories 里，全局一份、
 *    所有角色共用，改完要点「保存」。所以 SaveBar 只挂在齿轮那一页。
 *
 * 三道闸在**角色**上（「角色 → 单独配置 → 记忆库」），不在这儿 ——
 * 和 webSearch / voiceSend / imageGen 一个路子：会花钱的功能由「用哪个角色」
 * 决定。所以每一页上面都会提示当前这个角色开没开。
 *
 * 记忆库是按**角色名**分文件夹的（后端 memoryKeyFor），所以 key 一律**从后端拿**，
 * 前端不自己按角色名算 —— 算法分叉的话就会读到别人的记忆，或者读到空的。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SaveBar, useSection } from "../section.jsx";
import { api, apiDownload, useConfig } from "../store.jsx";
import { MemoriesSettings } from "./memorysettings.jsx";
import {
  Button,
  Card,
  Field,
  Modal,
  ResultNote,
  Switch,
  fmtStamp,
  inputCls,
} from "../ui.jsx";
import {
  ArrowLeft,
  Brain,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  Inbox,
  NotebookPen,
  Pencil,
  Plus,
  RefreshCw,
  Settings,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";

/** 三样东西的元数据。按钮、标题、提示语都从这里取，免得各处写法分叉。 */
const MODULES = [
  {
    id: "memory",
    name: "记忆",
    icon: Brain,
    desc: "聊满一定轮数就总结一条长期记忆。聊天时近 N 天的整段注入，另外拿对方这句话去向量检索一遍",
  },
  {
    id: "memo",
    name: "备忘录",
    icon: NotebookPen,
    desc: "约好的事、答应过的话、还没做完的。每次生成都是整份重写，只留「现在还有效」的那些",
  },
  {
    id: "diary",
    name: "日记",
    icon: CalendarDays,
    desc: "角色以第一人称写自己的一天。写成的日记程序永远不删，只有你在这儿手动删",
  },
];

export function MemoriesPanel({ onGoto }) {
  const { config } = useConfig();
  // 左边那列是 nav.js 从 config.roles 生成的，选中态由外壳持有
  const { itemId } = useSection();

  const [overview, setOverview] = useState(null); // null = 还在读
  const [overviewError, setOverviewError] = useState("");
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState("");
  // "" = 首页三个按钮；"memory"/"memo"/"diary" = 模块页；
  // "transfer" = 导入导出；"settings" = 齿轮
  const [view, setView] = useState("");

  const loadOverview = useCallback(async () => {
    try {
      const r = await api("/api/memories");
      setOverview(r.roles ?? []);
      setOverviewError("");
    } catch (e) {
      setOverview([]);
      setOverviewError(String(e?.message ?? e));
    }
  }, []);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  /*
   * key 是后端按**存盘的**角色名算出来的。所以刚改了名字还没保存时，
   * 这里拿到的还是旧 key —— 这是对的：磁盘上的文件夹此刻确实还是旧名字。
   */
  const entry = useMemo(
    () => (overview ?? []).find((r) => r.roleId === itemId) ?? null,
    [overview, itemId]
  );
  const key = entry?.key ?? "";

  const loadDetail = useCallback(async () => {
    if (!key) {
      setDetail(null);
      return;
    }
    try {
      const r = await api(`/api/memories/${encodeURIComponent(key)}`);
      setDetail(r);
      setDetailError("");
    } catch (e) {
      setDetail(null);
      setDetailError(String(e?.message ?? e));
    }
  }, [key]);

  useEffect(() => {
    setDetail(null);
    setDetailError("");
    loadDetail();
  }, [loadDetail]);

  /*
   * 换角色就回到首页。停在「日记」页不动的话，看到的是另一个人的日记，
   * 而标题在左边那栏里 —— 很容易以为还在看上一个角色。
   * 设置页是全局的，不跟着角色变，所以它留着。
   */
  useEffect(() => {
    setView((v) => (v === "settings" ? v : ""));
  }, [itemId]);

  /** 内容改过之后重新拉一遍：详情和概览里的计数都要跟着走。 */
  const reload = useCallback(async () => {
    await Promise.all([loadDetail(), loadOverview()]);
  }, [loadDetail, loadOverview]);

  const role = (config.roles ?? []).find((r) => r.id === itemId) ?? null;
  const gates = entry?.gates ?? {};
  const stats = detail?.stats ?? entry?.stats ?? {};

  /* ---------- 齿轮：全局设置 ---------- */
  if (view === "settings") {
    return (
      <div className="grid grid-cols-1 gap-rhythm-sm lg:gap-rhythm">
        <Card
          title="记忆库设置"
          desc="三个模型、轮数、提示词、日记的定时和字数。全局一份，所有角色共用（角色那边只有三个开关）"
          actions={
            <Button variant="outline" onClick={() => setView("")}>
              <ArrowLeft size={14} /> 返回
            </Button>
          }
        >
          <MemoriesSettings onGoto={onGoto} />
        </Card>
        <SaveBar hint="记忆库的设置是全局的，所有角色共用" />
      </div>
    );
  }

  /* ---------- 导入导出：整包搬家 + 纯文本记忆 + 补算向量 ---------- */
  if (view === "transfer" && entry && detail) {
    return (
      <Card
        title={`${entry.roleName || "未命名角色"} · 导入 / 导出`}
        desc="整份记忆库存成一个文件带走，或者把别处攒的记忆导进来。向量要自己点一次"
        actions={
          <Button variant="outline" onClick={() => setView("")}>
            <ArrowLeft size={14} /> 返回
          </Button>
        }
      >
        <MemoryTransferPage
          memKey={key}
          roleName={entry.roleName}
          detail={detail}
          reload={reload}
          onSettings={() => setView("settings")}
        />
      </Card>
    );
  }

  /* ---------- 模块页 ---------- */
  const mod = MODULES.find((m) => m.id === view);
  if (mod && entry && detail) {
    const Page = { memory: MemoryPage, memo: MemoPage, diary: DiaryPage }[mod.id];
    return (
      <Card
        title={`${entry.roleName || "未命名角色"} · ${mod.name}`}
        desc={mod.desc}
        actions={
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="outline" onClick={reload}>
              <RefreshCw size={14} /> 刷新
            </Button>
            <Button variant="outline" onClick={() => setView("")}>
              <ArrowLeft size={14} /> 返回
            </Button>
          </div>
        }
      >
        <Page
          memKey={key}
          detail={detail}
          gate={Boolean(gates[mod.id])}
          role={role}
          reload={reload}
          onGoto={onGoto}
          onTransfer={() => setView("transfer")}
        />
      </Card>
    );
  }

  /* ---------- 首页：三个大按钮 + 齿轮 ---------- */
  return (
    <Card
      title="记忆库"
      desc="每个角色三样长期记忆：记忆（向量检索）、备忘录（一份不断覆盖的清单）、日记（第一人称、永不清空）"
      actions={
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" onClick={() => setView("transfer")} disabled={!detail}>
            <Download size={14} /> 导入 / 导出
          </Button>
          <Button variant="outline" onClick={reload} disabled={!key}>
            <RefreshCw size={14} /> 刷新
          </Button>
          <button
            type="button"
            onClick={() => setView("settings")}
            aria-label="记忆库设置"
            title="记忆库设置（全局）"
            className="shrink-0 rounded-item p-2 text-ink-faint transition-colors duration-150 hover:bg-sunken hover:text-ink"
          >
            <Settings size={17} />
          </button>
        </div>
      }
    >
      {overviewError && (
        <p className="mb-6 border-l-2 border-warn py-1.5 pl-3 text-meta leading-relaxed text-warn">
          读不到记忆库列表：{overviewError}
        </p>
      )}

      {overview === null && <p className="text-eyebrow uppercase text-ink-meta">读取中</p>}

      {overview !== null && !itemId && (
        <p className="max-w-[62ch] text-body text-ink-soft">
          {overview.length
            ? "左边挑一个角色，这里显示它的记忆、备忘录和日记。"
            : "还没有角色。记忆库是按角色分的，先去「角色」面板建一个。"}
        </p>
      )}

      {itemId && !entry && overview !== null && (
        <p className="max-w-[62ch] text-body text-ink-soft">
          这个角色还没有记忆库记录 —— 可能是刚新建、名字改过还没保存。
          先点底下的「保存」，再回来刷新。
        </p>
      )}

      {detailError && (
        <p className="border-l-2 border-warn py-1.5 pl-3 text-meta leading-relaxed text-warn">
          {detailError}
        </p>
      )}

      {entry && (
        <div className="grid grid-cols-1 gap-8">
          <div>
            <p className="text-ui text-ink">{entry.roleName || "未命名角色"}</p>
            <p className="mt-1 break-all font-mono text-meta text-ink-faint">
              memories/…/{entry.key}
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {MODULES.map((m) => (
              <ModuleButton
                key={m.id}
                module={m}
                on={Boolean(gates[m.id])}
                lines={moduleLines(m.id, stats)}
                onClick={() => setView(m.id)}
                disabled={!detail}
              />
            ))}
          </div>

          <div className="grid grid-cols-1 gap-1.5 border-l-2 border-line py-1.5 pl-3 text-meta leading-relaxed text-ink-soft">
            <p>
              三样东西的开关在
              <button
                type="button"
                onClick={() => onGoto?.("role")}
                className="link-slide mx-1 text-ink"
              >
                角色 → 单独配置 → 记忆库
              </button>
              里，默认全关。关着的那一样不会自动生成、也不会注入给模型，
              但已经存下来的内容还在，点进去照样能看和改。
            </p>
            <p>
              文件在数据目录的 memories 文件夹里，按<span className="text-ink-soft">角色名</span>
              分开存 —— 角色改名会算出新的一份，旧的还在磁盘上但读不到了。
            </p>
          </div>
        </div>
      )}
    </Card>
  );
}

/** 首页那三个按钮上的两行小字。 */
function moduleLines(id, stats) {
  if (id === "memory") {
    return [`${stats.memories ?? 0} 条记忆`, `${stats.pendingMemory ?? 0} 行待总结`];
  }
  if (id === "memo") {
    return [`${stats.memoChars ?? 0} 字`, `${stats.pendingMemo ?? 0} 行待总结`];
  }
  return [
    `${stats.diaries ?? 0} 篇日记`,
    stats.lastDiary ? `最近一篇 ${stats.lastDiary}` : `${stats.diaryLogChars ?? 0} 字流水`,
  ];
}

/**
 * 首页那个大按钮。
 *
 * 整块可点（不是一张卡里再放个小按钮）—— 它就是个入口，没有别的动作。
 * 悬停只换底色不位移：三块并排的东西一抖，眼睛会跟着跑。
 */
function ModuleButton({ module, on, lines, onClick, disabled }) {
  const Icon = module.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="group flex flex-col items-start gap-3 border border-line bg-paper px-4 py-4 text-left transition-colors duration-150 hover:bg-sunken disabled:opacity-40 disabled:hover:bg-paper"
    >
      <span className="flex w-full items-center justify-between gap-2">
        <Icon size={18} className="shrink-0 text-ink-faint transition-colors duration-150 group-hover:text-ink" />
        <ChevronRight size={15} className="shrink-0 text-ink-meta" />
      </span>
      <span className="min-w-0">
        <span className="flex flex-wrap items-baseline gap-2">
          <span className="font-serif text-h3 text-ink">{module.name}</span>
          {!on && <span className="text-eyebrow uppercase text-ink-meta">已关</span>}
        </span>
        <span className="mt-1.5 block text-meta leading-relaxed text-ink-faint">
          {lines[0]}
          <br />
          {lines[1]}
        </span>
      </span>
    </button>
  );
}

/* ================= 各页共用 ================= */

/**
 * 「立刻生成一次」的公共逻辑。
 *
 * 后端对**业务失败**用的是 200 + `ok: false`（模型没配、写太短、上游报错），
 * 原因在 `text` 里，要原样显示 —— 那句话是用户唯一能看到的失败原因，
 * 而且它已经带了「一条聊天记录都没删」这种关键信息，不能自己另编一句。
 * 真正的 4xx/5xx 才走 catch。
 */
function useGenerate(memKey, reload) {
  const [state, setState] = useState("idle");
  const [msg, setMsg] = useState("");

  const run = useCallback(
    async (kind, hint) => {
      setState("loading");
      setMsg(hint);
      try {
        const r = await api(`/api/memories/${encodeURIComponent(memKey)}/generate/${kind}`, {
          method: "POST",
        });
        setState(r.ok ? "ok" : "fail");
        setMsg(r.text || r.error || (r.ok ? "生成成功" : "没有成功，原因不明"));
      } catch (e) {
        setState("fail");
        setMsg(String(e?.message ?? e));
      }
      // 成功失败都刷一遍：失败时待总结的行数也可能变了（新聊的那几轮）
      await reload();
    },
    [memKey, reload]
  );

  return { state, msg, run, busy: state === "loading" };
}

/** 角色那道闸关着时的提示。三页共用一句措辞。 */
function GateNote({ on, name, onGoto }) {
  if (on) return null;
  return (
    <p className="border-l-2 border-line py-1.5 pl-3 text-meta leading-relaxed text-ink-soft">
      这个角色的「{name}」是关着的 —— 聊天时不会自动生成、也不会注入给模型。
      已经存下来的内容还在，下面照样能看和改。
      <button
        type="button"
        className="mx-1 underline decoration-line underline-offset-2 hover:text-ink"
        onClick={() => onGoto?.("role")}
      >
        去角色那边打开
      </button>
    </p>
  );
}

/**
 * 上一次失败的原因。定时那条路在后台跑，失败时用户不在现场，所以要留一条。
 *
 * 原因**原样全显**、不截断 —— 中转站常把真正的原因写在很后面，截一半等于
 * 让用户对着半截话猜。代价是可能很长，所以单独一块：能选中复制、长串不换行
 * 的报文也强制折行、超高了自己滚，不把整页顶下去。
 */
function FailNote({ fails, lastError, at }) {
  if (!lastError) return null;
  return (
    <div className="border-l-2 border-warn py-1.5 pl-3 text-meta leading-relaxed text-warn">
      <p>
        上次没成功{fails ? `（连着 ${fails} 次）` : ""}
        {at ? ` · ${fmtStamp(at)}` : ""}：
      </p>
      <p className="my-1 max-h-40 select-all overflow-y-auto whitespace-pre-wrap break-all font-mono">
        {lastError}
      </p>
      <p>
        待总结的内容<strong>一条都没删</strong>，配置好之后会接着总结。
      </p>
    </div>
  );
}

/**
 * 模块页顶部那一条：左边一句状态，右边「立刻生成」和「待总结」两个按钮。
 *
 * `extra` 是留给某一页自己多出来的那个按钮（现在只有日记的「自己写一篇」）。
 * 排在最左边：它是「不打模型」的那一类，和右边两个花钱的分开站。
 */
function PageBar({ note, gen, genKind, genHint, genLabel, genBusyLabel, pendingLabel, onPending, busy, extra }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="min-w-0 max-w-[62ch] text-meta leading-relaxed text-ink-faint">{note}</p>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {extra}
        <Button variant="outline" onClick={onPending} disabled={busy}>
          <Inbox size={14} /> {pendingLabel}
        </Button>
        <Button
          variant="outline"
          onClick={() => gen.run(genKind, genHint)}
          disabled={gen.busy || busy}
        >
          {gen.busy ? <RefreshCw size={14} className="animate-spin" /> : <Sparkles size={14} />}
          {gen.busy ? genBusyLabel : genLabel}
        </Button>
      </div>
    </div>
  );
}

/** 一行红字。三页都用它显示请求层的错误（4xx/5xx，不是业务失败）。 */
function ErrorLine({ text }) {
  if (!text) return null;
  return (
    <p className="border-l-2 border-warn py-1.5 pl-3 text-meta leading-relaxed text-warn">{text}</p>
  );
}

/**
 * 「待总结」的编辑页（记忆和备忘录共用）。
 *
 * 待总结现在就是一份流水 txt，和日记那份一模一样的格式（用户的要求：
 * 「待总结的记忆和备忘录都用 diary_log.txt 的这个记录形式」），所以这里和
 * `DiaryLogEditor` 一样是一个等宽大文本框 —— 总结时整份原样发过去，
 * 界面上看到的就是模型将要读到的。
 *
 * 保存只覆盖正文 —— 失败计数和退避位置由后端保留（改原文和
 * 「程序试到第几次了」是两件事）。
 */
function PendingLogEditor({ memKey, kind, name, log, onBack, reload }) {
  const [text, setText] = useState(log);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setText(log);
    setSaved(false);
  }, [log]);

  const dirty = text !== log;
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).length;

  async function save() {
    setBusy(true);
    setError("");
    try {
      await api(`/api/memories/${encodeURIComponent(memKey)}/pending/${kind}`, {
        method: "PUT",
        body: { text },
      });
      setSaved(true);
      await reload();
    } catch (e) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
        <div className="min-w-0">
          <p className="font-serif text-h3 text-ink">待总结的流水</p>
          <p className="mt-1 max-w-[62ch] text-meta leading-relaxed text-ink-faint">
            每轮聊完追加两行：时间 + 发送人 + 内容。下一次生成{name}就拿这整份去总结。
            改坏了的、不想让它进{name}的，在这儿改掉或删行。
          </p>
        </div>
        <Button variant="outline" onClick={onBack} disabled={busy}>
          <ArrowLeft size={14} /> 回到{name}
        </Button>
      </div>

      <ErrorLine text={error} />

      <Field label={`流水正文（${lines} 行）`} hint="一行一条，格式是「时间 | [发送人] 内容」">
        <textarea
          className={`${inputCls} min-h-[420px] resize-y font-mono leading-relaxed`}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setSaved(false);
          }}
          placeholder={`流水是空的 —— 开着「${name}」聊几句就会攒起来。`}
        />
      </Field>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 max-w-[62ch] text-meta leading-relaxed text-ink-faint">
          {dirty
            ? `改了还没写盘，现在 ${lines} 行。`
            : saved
            ? "已经写盘了。失败计数没动 —— 那是程序的进度，和原文是两件事。"
            : "删行 = 那几句不进总结。改完点右边写盘，和底下那条全局「保存」无关。"}
          <br />
          <strong className="text-ink-soft">只有总结成功之后才会清空</strong>
          ，清之前留一份 .bak；失败的话一个字节都不删，下次连着一起总结。
        </p>
        <Button onClick={save} disabled={busy || !dirty}>
          {busy ? <RefreshCw size={14} className="animate-spin" /> : <Check size={14} />}
          {busy ? "写入中…" : "写入磁盘"}
        </Button>
      </div>
    </div>
  );
}

/* ================= 一、记忆 ================= */

/** 每页多少条。默认 25 —— 和参考实现（romantic_memory 的面板）一致。 */
const PAGE_SIZES = [10, 25, 50, 0];

/**
 * 记忆页：一条一条的长期事件，按日期分组，可以手改、手删、手加。
 *
 * 手改和手加的那条**没有向量**（后端把它置空了）：为一次手动编辑单独打一次
 * 向量接口不值当，而且这条照旧能被「近 N 天」那一路拿到 —— 只是暂时进不了
 * 向量检索。界面上把这件事标出来（「未向量化」），否则用户会以为改坏了。
 */
function MemoryPage({ memKey, detail, gate, reload, onGoto, onTransfer }) {
  const gen = useGenerate(memKey, reload);
  const [pendingView, setPendingView] = useState(false);
  const [query, setQuery] = useState("");
  const [perPage, setPerPage] = useState(25);
  const [page, setPage] = useState(1);
  const [picked, setPicked] = useState([]);
  const [editId, setEditId] = useState("");
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const list = detail.memories ?? [];
  const pending = detail.pending?.memory ?? {};
  const pendingLog = pending.text ?? "";
  const pendingLines = pending.lines ?? 0;
  // 接口回来的每条都带 embedded 布尔（省掉几千个浮点数），缺口就地数一下，
  // 不用再为这个数字单独跑一趟接口 —— 跟着 reload() 一起新。
  const noVec = list.filter((m) => !m.embedded).length;

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? list.filter(
          (m) =>
            m.content.toLowerCase().includes(q) ||
            (m.keywords ?? []).some((k) => String(k).toLowerCase().includes(q))
        )
      : list;
    // 新的排前面 —— 找「刚才那条」比找三个月前那条常见得多
    return [...filtered].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  }, [list, query]);

  const pages = perPage ? Math.max(1, Math.ceil(shown.length / perPage)) : 1;
  // 过滤或改页大小之后当前页可能已经不存在了，夹一下再切片
  const current = Math.min(page, pages);
  const slice = perPage ? shown.slice((current - 1) * perPage, current * perPage) : shown;

  async function call(path, options) {
    setBusy(true);
    setError("");
    try {
      await api(path, options);
      await reload();
      return true;
    } catch (e) {
      setError(String(e?.message ?? e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function commitEdit(id) {
    const content = draft.trim();
    if (!content) {
      setError("记忆正文不能为空 —— 想删掉这条请用右边的垃圾桶。");
      return;
    }
    const ok = await call(
      `/api/memories/${encodeURIComponent(memKey)}/memory/${encodeURIComponent(id)}`,
      { method: "PUT", body: { content } }
    );
    if (ok) {
      setEditId("");
      setDraft("");
    }
  }

  async function addOne() {
    const content = adding.trim();
    if (!content) return;
    const ok = await call(`/api/memories/${encodeURIComponent(memKey)}/memory`, {
      method: "POST",
      body: { content },
    });
    if (ok) setAdding("");
  }

  /** 删勾选的那几条。一条一个请求 —— 后端没有批量删的路由，几条而已。 */
  async function dropPicked() {
    setBusy(true);
    setError("");
    try {
      for (const id of picked) {
        await api(
          `/api/memories/${encodeURIComponent(memKey)}/memory/${encodeURIComponent(id)}`,
          { method: "DELETE" }
        );
      }
      setPicked([]);
      await reload();
    } catch (e) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  if (pendingView) {
    return (
      <PendingLogEditor
        memKey={memKey}
        kind="memory"
        name="记忆"
        log={pendingLog}
        onBack={() => setPendingView(false)}
        reload={reload}
      />
    );
  }

  const allPickedOnPage = slice.length > 0 && slice.every((m) => picked.includes(m.id));

  return (
    <div className="grid grid-cols-1 gap-6">
      <GateNote on={gate} name="记忆" onGoto={onGoto} />
      <FailNote fails={pending.fails} lastError={pending.lastError} />

      <PageBar
        note={
          <>
            一共 <strong className="text-ink-soft">{list.length}</strong> 条记忆，
            另有 <strong className="text-ink-soft">{pendingLines}</strong> 行聊天还没总结。
            手动总结<strong className="text-ink-soft">不看轮数</strong>，攒了多少就总结多少。
          </>
        }
        gen={gen}
        genKind="memory"
        genHint="正在总结，要打一次模型，几十秒…"
        genLabel="立刻总结一次"
        genBusyLabel="总结中…"
        pendingLabel={`待总结（${pendingLines} 行）`}
        onPending={() => setPendingView(true)}
        busy={busy}
      />

      <ResultNote state={gen.state} message={gen.msg} icon={Brain} />
      <ErrorLine text={error} />

      {noVec > 0 && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 border-l-2 border-line py-1.5 pl-3 text-meta leading-relaxed text-ink-soft">
          <span>
            有 <strong className="text-ink">{noVec}</strong> 条还没算向量 ——
            「近 N 天」那一路照样拿得到它们，但进不了语义检索。
          </span>
          <button type="button" className="link-slide text-ink" onClick={onTransfer}>
            去补算一次
          </button>
        </p>
      )}

      {list.length > 0 && (
        <div className="grid grid-cols-1 gap-4 border-t border-line pt-6 sm:grid-cols-[1fr_auto] sm:items-end">
          <Field label="搜一条" hint="按正文或关键词过滤">
            <input
              className={inputCls}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
              placeholder="例如：露营"
            />
          </Field>
          <Field label="每页">
            <select
              className={inputCls}
              value={perPage}
              onChange={(e) => {
                setPerPage(Number(e.target.value));
                setPage(1);
              }}
            >
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n || "全部"}
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}

      {list.length === 0 && (
        <p className="text-body text-ink-soft">
          还没有记忆。开着「记忆」聊满设置里那个轮数就会出现第一条，也可以在下面手加一条。
        </p>
      )}

      {slice.length > 0 && (
        <div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-2">
            <label className="flex items-center gap-2 text-meta text-ink-faint">
              <input
                type="checkbox"
                checked={allPickedOnPage}
                onChange={() =>
                  setPicked((p) =>
                    allPickedOnPage
                      ? p.filter((id) => !slice.some((m) => m.id === id))
                      : [...new Set([...p, ...slice.map((m) => m.id)])]
                  )
                }
                className="accent-ink"
              />
              本页全选
            </label>
            {picked.length > 0 && (
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-meta text-ink-faint">勾了 {picked.length} 条</span>
                <Button variant="ghost" onClick={() => setPicked([])} disabled={busy}>
                  取消勾选
                </Button>
                <Button variant="outline" onClick={dropPicked} disabled={busy}>
                  <Trash2 size={14} /> 删掉勾选的
                </Button>
              </div>
            )}
          </div>

          {slice.map((m, i) => (
            <MemoryRow
              key={m.id}
              item={m}
              /* 日期变了才画一行日期 —— 同一天的好几条不用重复标 */
              showDate={i === 0 || slice[i - 1].date !== m.date}
              picked={picked.includes(m.id)}
              onPick={() =>
                setPicked((p) => (p.includes(m.id) ? p.filter((x) => x !== m.id) : [...p, m.id]))
              }
              editing={editId === m.id}
              draft={draft}
              setDraft={setDraft}
              busy={busy}
              onEdit={() => {
                setEditId(m.id);
                setDraft(m.content);
              }}
              onCancel={() => setEditId("")}
              onCommit={() => commitEdit(m.id)}
              onDrop={() =>
                call(
                  `/api/memories/${encodeURIComponent(memKey)}/memory/${encodeURIComponent(m.id)}`,
                  { method: "DELETE" }
                )
              }
            />
          ))}

          {pages > 1 && (
            <div className="flex items-center justify-between gap-3 pt-4">
              <Button
                variant="outline"
                onClick={() => setPage(current - 1)}
                disabled={current <= 1}
              >
                <ChevronLeft size={14} /> 上一页
              </Button>
              <span className="text-meta text-ink-faint">
                第 {current} / {pages} 页 · 共 {shown.length} 条
              </span>
              <Button
                variant="outline"
                onClick={() => setPage(current + 1)}
                disabled={current >= pages}
              >
                下一页 <ChevronRight size={14} />
              </Button>
            </div>
          )}
        </div>
      )}

      {query.trim() && shown.length === 0 && (
        <p className="text-meta text-ink-faint">没有匹配的记忆。</p>
      )}

      <div className="grid grid-cols-1 gap-2 border-t border-line pt-6">
        <Field label="手加一条" hint="写成客观的一句话，和模型总结出来的那种一致">
          <textarea
            className={`${inputCls} min-h-[70px] resize-y leading-relaxed`}
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            placeholder="例如：两人约好周末去湖边的营地露营。"
          />
        </Field>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-meta leading-relaxed text-ink-faint">
            手加的这条没有向量（不为一次手动编辑单独打一次向量接口），
            但「近 N 天记忆」那一路照样能拿到它。
          </p>
          <Button onClick={addOne} disabled={busy || !adding.trim()}>
            <Plus size={14} /> 加一条
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * 记忆列表里的一行。
 *
 * 单独一个组件是因为它有六个状态（勾选、编辑中、未向量化、有没有关键词…），
 * 内联在 map 里的话那段 JSX 会有一百多行，改一处得先数括号。
 */
function MemoryRow({
  item,
  showDate,
  picked,
  onPick,
  editing,
  draft,
  setDraft,
  busy,
  onEdit,
  onCancel,
  onCommit,
  onDrop,
}) {
  return (
    <>
      {showDate && (
        <p className="pb-1 pt-4 text-eyebrow uppercase text-ink-meta">{item.date}</p>
      )}
      <div className="flex items-start gap-3 border-b border-line py-3">
        <input
          type="checkbox"
          checked={picked}
          onChange={onPick}
          aria-label="勾选这条记忆"
          className="mt-1 shrink-0 accent-ink"
        />
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="grid grid-cols-1 gap-2">
              <textarea
                autoFocus
                className={`${inputCls} min-h-[90px] resize-y leading-relaxed`}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") onCancel();
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onCommit();
                }}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={onCommit} disabled={busy}>
                  <Check size={14} /> 保存这条
                </Button>
                <Button variant="ghost" onClick={onCancel} disabled={busy}>
                  取消
                </Button>
                <span className="text-meta text-ink-meta">
                  {draft.length} 字 · 改完向量会置空，下次检索前自动重算
                </span>
              </div>
            </div>
          ) : (
            <>
              <p className="whitespace-pre-wrap break-words text-ui leading-relaxed text-ink-soft">
                {item.content}
              </p>
              <p className="mt-1 flex flex-wrap items-center gap-x-2 text-meta text-ink-meta">
                <span>{item.content.length} 字</span>
                {!item.embedded && <span className="text-warn">未向量化</span>}
                {(item.keywords ?? []).length > 0 && (
                  <span className="min-w-0 truncate">
                    关键词：{(item.keywords ?? []).slice(0, 8).join("、")}
                  </span>
                )}
              </p>
            </>
          )}
        </div>
        {!editing && (
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              disabled={busy}
              onClick={onEdit}
              className="flex items-center gap-1 rounded-item px-1.5 py-1 text-meta text-ink-faint transition-colors duration-150 hover:bg-sunken hover:text-ink"
            >
              <Pencil size={14} /> 编辑
            </button>
            <button
              type="button"
              disabled={busy}
              aria-label="删掉这条记忆"
              onClick={onDrop}
              className="rounded-item p-1.5 text-ink-faint transition-colors duration-150 hover:bg-sunken hover:text-warn"
            >
              <Trash2 size={14} />
            </button>
          </div>
        )}
      </div>
    </>
  );
}

/* ================= 二、备忘录 ================= */

/**
 * 备忘录页：进来直接就是总结好的正文，能改。
 *
 * 界面上是一个大 textarea + 一个「写入磁盘」——「整份覆盖」正是它的语义，
 * 不该做成条目增删（模型每次生成也是整份重写的）。后端 writeMemo 覆盖前
 * 自己留了一份 .bak，所以手改改坏了还能从磁盘上找回来。
 */
function MemoPage({ memKey, detail, gate, reload, onGoto }) {
  const gen = useGenerate(memKey, reload);
  const [pendingView, setPendingView] = useState(false);
  const [text, setText] = useState(detail.memo ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const remote = detail.memo ?? "";
  /*
   * 只在**后端那份变了**的时候跟上去（手动生成成功、切了角色）。
   * 依赖写的是 remote 而不是整个 detail —— 点一下「刷新」拿到同样的正文时
   * 这个 effect 不会跑，正在编辑的草稿不会被自己的刷新冲掉。
   */
  useEffect(() => {
    setText(remote);
    setSaved(false);
  }, [remote]);

  const pending = detail.pending?.memo ?? {};
  const pendingLog = pending.text ?? "";
  const pendingLines = pending.lines ?? 0;
  const dirty = text !== remote;

  async function save() {
    setBusy(true);
    setError("");
    try {
      await api(`/api/memories/${encodeURIComponent(memKey)}/memo`, {
        method: "PUT",
        body: { text },
      });
      setSaved(true);
      await reload();
    } catch (e) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  if (pendingView) {
    return (
      <PendingLogEditor
        memKey={memKey}
        kind="memo"
        name="备忘录"
        log={pendingLog}
        onBack={() => setPendingView(false)}
        reload={reload}
      />
    );
  }

  return (
    <div className="grid grid-cols-1 gap-6">
      <GateNote on={gate} name="备忘录" onGoto={onGoto} />
      <FailNote fails={pending.fails} lastError={pending.lastError} />

      <PageBar
        note={
          <>
            现在这份 <strong className="text-ink-soft">{remote.trim().length}</strong> 字，
            另有 <strong className="text-ink-soft">{pendingLines}</strong> 行聊天还没总结。
            生成时会把「近 N 天记忆」一起发给模型当参考，但
            <strong className="text-ink-soft">不会</strong>把记忆原文并进备忘录里 ——
            备忘录不是记忆。
          </>
        }
        gen={gen}
        genKind="memo"
        genHint="正在生成，要打一次模型…"
        genLabel="立刻生成一次"
        genBusyLabel="生成中…"
        pendingLabel={`待总结（${pendingLines} 行）`}
        onPending={() => setPendingView(true)}
        busy={busy}
      />

      <ResultNote state={gen.state} message={gen.msg} icon={NotebookPen} />
      <ErrorLine text={error} />

      <div className="border-t border-line pt-6">
        <Field label="已经总结好的备忘录" hint="手改也行，整份覆盖">
          <textarea
            className={`${inputCls} min-h-[340px] resize-y font-mono leading-relaxed`}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setSaved(false);
            }}
            placeholder="还是空的。开着「备忘录」聊满设置里那个轮数就会生成第一份，也可以点右上角「立刻生成一次」。"
          />
        </Field>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 max-w-[62ch] text-meta leading-relaxed text-ink-faint">
          {dirty
            ? `改了 ${text.length} 字还没写盘 —— 这一栏和底下那条全局「保存」无关。`
            : saved
            ? "已经写盘了。覆盖前的那一份留了 .bak，在同一个文件夹里。"
            : "这一栏改完点右边写盘，和底下那条全局「保存」无关。"}
        </p>
        <Button onClick={save} disabled={busy || !dirty}>
          {busy ? <RefreshCw size={14} className="animate-spin" /> : <Check size={14} />}
          {busy ? "写入中…" : "写入磁盘"}
        </Button>
      </div>
    </div>
  );
}

/* ================= 三、日记 ================= */

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

/*
 * 「这天没有日记」时给出去的空数组，模块级常量。
 * 每次渲染现造一个 `[]` 的话引用每次都不同，下面那个按 `files` 取正文的
 * effect 会每渲染一次就跑一遍。
 */
const NO_FILES = [];

/** `2026-09-09` → `{y, m, d}`。用字符串比日期对象省事，也不会掉进时区。 */
function parseDay(s) {
  const [y, m, d] = String(s ?? "").split("-").map(Number);
  return { y, m, d };
}

const pad = (n) => String(n).padStart(2, "0");
const dayKey = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

/** 今天，`YYYY-MM-DD`。取本地日期（后端的 localDate 也是本地的，两边对得上）。 */
function todayKey() {
  const n = new Date();
  return dayKey(n.getFullYear(), n.getMonth() + 1, n.getDate());
}

/**
 * 日记页：一个月历。
 *
 * 有日记的那天是实心方块（多篇的角上标条数），点一下下面就展开那天的正文，
 * 能改也能删。**日历比一列文件名好懂**：日记本来就是按天写的，
 * 空了几天、哪天写了两篇，看一眼月历就知道。
 *
 * 两件事界面上要分清：
 *  - **流水**（diary_log.txt）是每轮聊完追加的「时间 + 发送人 + 内容」，
 *    生成成功之后才清空（清之前留一份 .bak）。里面**没有天气** ——
 *    天气是生成那一刻现查的瞬时值。它就是日记的「待总结」。
 *  - **成品**是一篇篇 markdown，程序永远不删，只有在这儿手动点删除才会掉。
 */
function DiaryPage({ memKey, detail, gate, role, reload, onGoto }) {
  const gen = useGenerate(memKey, reload);
  const [pendingView, setPendingView] = useState(false);
  const [writing, setWriting] = useState(false); // 手写一篇的那个表单开着没有
  const [picked, setPicked] = useState(""); // 选中的那天 `YYYY-MM-DD`
  const [month, setMonth] = useState(null); // {y, m}，null = 还没定，取最近一篇那个月
  const [error, setError] = useState("");

  const diaries = detail.diaries ?? [];
  const log = detail.diaryLog ?? "";
  const state = detail.diaryState ?? {};
  const injectDays = role?.memories?.diary?.injectDays ?? 3;

  /** `YYYY-MM-DD` → 那天的几篇。日历的方块和下面的正文都从这儿取。 */
  const byDay = useMemo(() => {
    const map = new Map();
    for (const d of diaries) {
      if (!map.has(d.date)) map.set(d.date, []);
      map.get(d.date).push(d);
    }
    // 同一天里按 seq 正序：第 1 篇在上面，读起来是写作顺序
    for (const arr of map.values()) arr.sort((a, b) => a.seq - b.seq);
    return map;
  }, [diaries]);

  /*
   * 默认停在**最近一篇日记**那个月，不是当月：隔了一阵子没聊的话，
   * 当月是全空的，用户得自己往前翻几下才看得到东西。
   */
  const view = useMemo(() => {
    if (month) return month;
    const latest = diaries[0]?.date;
    const t = latest ? parseDay(latest) : null;
    const now = new Date();
    return t ? { y: t.y, m: t.m } : { y: now.getFullYear(), m: now.getMonth() + 1 };
  }, [month, diaries]);

  /*
   * 换角色时 detail 会换掉，选中的那天可能在新角色这儿不存在。
   * 依赖写 byDay：它变了才检查一次。
   */
  useEffect(() => {
    setPicked((p) => (p && byDay.has(p) ? p : ""));
  }, [byDay]);

  /*
   * 翻月份。**必须用函数式更新**：连点几下箭头时 React 会把这几次合到一帧里，
   * 直接读 `view` 的话每一下都是从同一个旧月份算的 —— 点九下只走一个月。
   * `?? view` 是给「还没手动翻过」那一次用的（此前 month 是 null）。
   */
  function step(delta) {
    setMonth((cur) => {
      const from = cur ?? view;
      const m = from.m + delta;
      // 跨年：先按 1..12 归一化，年份用 floor 除法跟着走（往前翻也对）
      return { y: from.y + Math.floor((m - 1) / 12), m: ((m - 1) % 12 + 12) % 12 + 1 };
    });
  }

  if (pendingView) {
    return (
      <DiaryLogEditor
        memKey={memKey}
        log={log}
        onBack={() => setPendingView(false)}
        reload={reload}
      />
    );
  }

  if (writing) {
    return (
      <DiaryComposer
        memKey={memKey}
        roleName={role?.name ?? ""}
        /* 默认填选中的那天，没选就是今天 —— 从日历上点进来的最常见意图是「补这天的」 */
        day={picked || todayKey()}
        onBack={() => setWriting(false)}
        onDone={(date) => {
          setWriting(false);
          // 写完直接跳到那天：新写的那篇立刻展开，不用自己再翻月份找
          const t = parseDay(date);
          setMonth({ y: t.y, m: t.m });
          setPicked(date);
        }}
        reload={reload}
      />
    );
  }

  return (
    <div className="grid grid-cols-1 gap-6">
      <GateNote on={gate} name="日记" onGoto={onGoto} />
      <FailNote lastError={state.lastError} at={state.lastErrorAt} />

      <PageBar
        note={
          <>
            一共 <strong className="text-ink-soft">{diaries.length}</strong> 篇，
            流水攒了 <strong className="text-ink-soft">{log.trim().length}</strong> 字。
            {state.lastDiaryAt ? `上次写于 ${fmtStamp(state.lastDiaryAt)}。` : ""}
            聊天时会把近 {injectDays} 天的日记注入给模型（这个天数是每个角色各自配的）。
          </>
        }
        gen={gen}
        genKind="diary"
        genHint="正在写，一篇两千字要打一次模型，几十秒…"
        genLabel="立刻写一篇"
        genBusyLabel="写作中…"
        pendingLabel={`待总结的流水（${log.trim().length} 字）`}
        onPending={() => setPendingView(true)}
        busy={false}
        extra={
          <Button variant="outline" onClick={() => setWriting(true)}>
            <Plus size={14} /> 自己写一篇
          </Button>
        }
      />

      <ResultNote state={gen.state} message={gen.msg} icon={NotebookPen} />
      <ErrorLine text={error} />

      <div className="border-t border-line pt-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => step(-1)}
            aria-label="上一个月"
            className="rounded-item p-1.5 text-ink-faint transition-colors duration-150 hover:bg-sunken hover:text-ink"
          >
            <ChevronLeft size={16} />
          </button>
          <p className="font-serif text-h3 text-ink">
            {view.y} 年 {view.m} 月
          </p>
          <button
            type="button"
            onClick={() => step(1)}
            aria-label="下一个月"
            className="rounded-item p-1.5 text-ink-faint transition-colors duration-150 hover:bg-sunken hover:text-ink"
          >
            <ChevronRight size={16} />
          </button>
        </div>

        <MonthGrid view={view} byDay={byDay} picked={picked} onPick={setPicked} />

        {diaries.length === 0 && (
          <p className="mt-6 text-body text-ink-soft">
            还没有写成的日记。流水里有内容之后，到点（定时）或者发
            <code className="mx-1 bg-sunken px-1">/日记</code>就会写一篇，也可以点上面的
            「自己写一篇」自己填。
          </p>
        )}
      </div>

      {picked && (
        <DayDiaries
          memKey={memKey}
          day={picked}
          files={byDay.get(picked) ?? NO_FILES}
          onClose={() => setPicked("")}
          reload={reload}
          onError={setError}
        />
      )}
    </div>
  );
}

/**
 * 一个月的方块。周一开头（getDay() 是周日 0，所以往前挪 6 再取模）。
 *
 * 没日记的那天也画出来但不可点 —— 空着的格子比「只列有日记的那几天」
 * 更能说明「这段时间没写」。
 */
function MonthGrid({ view, byDay, picked, onPick }) {
  const first = new Date(view.y, view.m - 1, 1);
  const lead = (first.getDay() + 6) % 7;
  const days = new Date(view.y, view.m, 0).getDate();
  const today = dayKey(new Date().getFullYear(), new Date().getMonth() + 1, new Date().getDate());

  const cells = [];
  for (let i = 0; i < lead; i += 1) cells.push(null);
  for (let d = 1; d <= days; d += 1) cells.push(d);

  return (
    <div>
      <div className="grid grid-cols-7 gap-1.5">
        {WEEKDAYS.map((w) => (
          <div key={w} className="pb-1 text-center text-eyebrow uppercase text-ink-meta">
            {w}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1.5">
        {cells.map((d, i) => {
          if (!d) return <div key={`x-${i}`} />;
          const key = dayKey(view.y, view.m, d);
          const list = byDay.get(key) ?? [];
          const has = list.length > 0;
          const on = picked === key;
          return (
            <button
              key={key}
              type="button"
              disabled={!has}
              onClick={() => onPick(on ? "" : key)}
              title={has ? `${key} · ${list.length} 篇` : key}
              className={`relative flex aspect-square min-h-11 flex-col items-center justify-center border transition-colors duration-150 ${
                on
                  ? "border-ink bg-ink text-paper-invert"
                  : has
                  ? "border-ink bg-sunken text-ink hover:bg-ink/[0.08]"
                  : "border-line text-ink-meta"
              } ${key === today && !on ? "font-medium" : ""}`}
            >
              <span className="text-ui">{d}</span>
              {list.length > 1 && (
                <span className="text-meta leading-none">{list.length} 篇</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 选中那天的日记：正文直接展开，能改能删。
 *
 * **不做成弹窗**：日记是长文，弹窗里改到一半按下 ESC 就全丢了。
 * 展开在日历下面，改动一直在，走开也不会没。
 */
function DayDiaries({ memKey, day, files, onClose, reload, onError }) {
  const [open, setOpen] = useState(files[0]?.file ?? "");
  const [text, setText] = useState("");
  const [remote, setRemote] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirming, setConfirming] = useState("");

  // 换了天/换了篇就重新拉正文。列表接口不给正文（几百篇一次发完太重）
  useEffect(() => {
    setOpen(files[0]?.file ?? "");
  }, [day, files]);

  useEffect(() => {
    if (!open) {
      setText("");
      setRemote("");
      return;
    }
    let alive = true;
    setBusy(true);
    api(`/api/memories/${encodeURIComponent(memKey)}/diary/${encodeURIComponent(open)}`)
      .then((r) => {
        if (!alive) return;
        setText(r.text ?? "");
        setRemote(r.text ?? "");
        setSaved(false);
      })
      .catch((e) => alive && onError(String(e?.message ?? e)))
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, [memKey, open, onError]);

  const dirty = text !== remote;

  async function save() {
    setBusy(true);
    try {
      await api(`/api/memories/${encodeURIComponent(memKey)}/diary/${encodeURIComponent(open)}`, {
        method: "PUT",
        body: { text },
      });
      setRemote(text);
      setSaved(true);
      await reload();
    } catch (e) {
      onError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function drop() {
    setBusy(true);
    try {
      await api(`/api/memories/${encodeURIComponent(memKey)}/diary/${encodeURIComponent(open)}`, {
        method: "DELETE",
      });
      setConfirming("");
      onClose();
      await reload();
    } catch (e) {
      onError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-line pt-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-serif text-h3 text-ink">{day}</p>
          <p className="mt-1 text-meta text-ink-faint">
            {files.length > 1 ? `这天写了 ${files.length} 篇` : "这天的日记"} ·{" "}
            <span className="font-mono">{open}</span>
          </p>
        </div>
        <Button variant="ghost" onClick={onClose}>
          <X size={14} /> 收起
        </Button>
      </div>

      {files.length > 1 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {files.map((f) => (
            <button
              key={f.file}
              type="button"
              onClick={() => setOpen(f.file)}
              className={`rounded-full border px-3.5 py-1.5 text-meta transition-colors duration-150 ${
                open === f.file
                  ? "border-ink bg-ink text-paper-invert"
                  : "border-line text-ink-soft hover:bg-sunken"
              }`}
            >
              第 {f.seq} 篇
            </button>
          ))}
        </div>
      )}

      <div className="mt-4">
        <Field label="日记正文" hint="改完记得写盘">
          <textarea
            className={`${inputCls} min-h-[420px] resize-y leading-loose`}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setSaved(false);
            }}
            placeholder={busy ? "读取中…" : ""}
          />
        </Field>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 max-w-[62ch] text-meta leading-relaxed text-ink-faint">
          {dirty
            ? `改了 ${text.length} 字还没写盘。`
            : saved
            ? "已经写盘了。"
            : `${text.length} 字。程序永远不会自动删日记，只有在这儿手动删才会掉。`}
        </p>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => setConfirming(open)} disabled={busy || !open}>
            <Trash2 size={14} /> 删掉这篇
          </Button>
          <Button onClick={save} disabled={busy || !dirty}>
            {busy ? <RefreshCw size={14} className="animate-spin" /> : <Check size={14} />}
            {busy ? "写入中…" : "写入磁盘"}
          </Button>
        </div>
      </div>

      {confirming && (
        <Modal
          title="删掉这篇日记？"
          desc={`${confirming} · 删了就没了，磁盘上不留备份`}
          onClose={() => setConfirming("")}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirming("")} disabled={busy}>
                取消
              </Button>
              <Button onClick={drop} disabled={busy}>
                <Trash2 size={14} /> 删掉
              </Button>
            </>
          }
        >
          <p className="text-body leading-relaxed text-ink-soft">
            日记是角色攒下来的东西，程序自己永远不删 —— 定时和手动生成都只往里加。
            这一篇删掉之后没有回收站。
          </p>
        </Modal>
      )}
    </div>
  );
}

/**
 * 自己写一篇日记。
 *
 * 用户要的「增加日记的选项」：不打模型、不看流水，日期加正文自己填。
 *
 * 为什么单独一页而不是弹窗：和 `DayDiaries` 一个理由 —— 日记是长文，
 * 弹窗里写到一半按下 ESC 就全丢了。
 *
 * 落盘走的是后端的 `writeDiary`，和模型生成的那条路**同一个函数**，
 * 所以：同一天已经有一篇时这篇自动叫 `-2`（不覆盖），并且和生成的那些
 * 一样进「近 N 天日记」注入给模型、一样永远不会被程序自动删。
 *
 * 两件事**不做**（页面上也写着）：不动待总结的流水（那是攒着等总结的原始
 * 对话，和手写一篇没关系），也不推「上次写于」那个时间戳（它管的是定时
 * 日记的间隔，手写一篇不该把下一次自动生成往后推）。
 */
function DiaryComposer({ memKey, roleName, day, onBack, onDone, reload }) {
  const [date, setDate] = useState(day);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const who = roleName || "这个角色";
  const okDate = /^\d{4}-\d{2}-\d{2}$/.test(date);

  async function save() {
    setBusy(true);
    setError("");
    try {
      const r = await api(`/api/memories/${encodeURIComponent(memKey)}/diary`, {
        method: "POST",
        body: { date, text },
      });
      await reload();
      onDone(r.date ?? date);
    } catch (e) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-serif text-h3 text-ink">自己写一篇</p>
          <p className="mt-1 text-meta text-ink-faint">
            以 {who} 的身份写。不打模型、不消耗额度
          </p>
        </div>
        <Button variant="ghost" onClick={onBack} disabled={busy}>
          <ArrowLeft size={14} /> 返回日历
        </Button>
      </div>

      <ErrorLine text={error} />

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-[200px_1fr] sm:items-end">
        <Field label="哪一天" hint="YYYY-MM-DD">
          <input
            className={inputCls}
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
        <p className="text-meta leading-relaxed text-ink-faint">
          这一天已经有日记的话，这篇会另存成第 2 篇（不覆盖原来那篇）。
          日期可以是过去的 —— 补一篇很久以前的也行。
        </p>
      </div>

      <div className="mt-4">
        <Field label="日记正文" hint="第一人称，和模型写出来的那种一致">
          <textarea
            className={`${inputCls} min-h-[420px] resize-y leading-loose`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="今天她答应跟我去露营了。"
          />
        </Field>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 max-w-[62ch] text-meta leading-relaxed text-ink-faint">
          {text.length} 字。写进去之后和生成的那些一样：会随「近 N 天日记」注入给模型，
          程序永远不会自动删。待总结的流水一个字都不会动。
        </p>
        <Button onClick={save} disabled={busy || !text.trim() || !okDate}>
          {busy ? <RefreshCw size={14} className="animate-spin" /> : <Check size={14} />}
          {busy ? "写入中…" : "写入磁盘"}
        </Button>
      </div>
    </div>
  );
}

/**
 * 日记的「待总结」：流水（diary_log.txt）。
 *
 * 能改 —— 用户明确要求三样都能改待总结。但要写清它是**聊天原文的流水账**，
 * 改它等于改历史；一行的格式是「时间 | [发送人] 内容」，别改坏。
 */
function DiaryLogEditor({ memKey, log, onBack, reload }) {
  const [text, setText] = useState(log);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setText(log);
    setSaved(false);
  }, [log]);

  const dirty = text !== log;
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).length;

  async function save() {
    setBusy(true);
    setError("");
    try {
      await api(`/api/memories/${encodeURIComponent(memKey)}/diarylog`, {
        method: "PUT",
        body: { text },
      });
      setSaved(true);
      await reload();
    } catch (e) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
        <div className="min-w-0">
          <p className="font-serif text-h3 text-ink">待总结的流水</p>
          <p className="mt-1 max-w-[62ch] text-meta leading-relaxed text-ink-faint">
            每轮聊完追加两行：时间 + 发送人 + 内容。下一篇日记就是拿这些写的。
            <strong className="text-ink-soft">这里不写天气</strong>
            —— 天气是生成那一刻现查的。
          </p>
        </div>
        <Button variant="outline" onClick={onBack} disabled={busy}>
          <ArrowLeft size={14} /> 回到日记
        </Button>
      </div>

      <ErrorLine text={error} />

      <Field label={`流水正文（${lines} 行）`} hint="一行一条，格式是「时间 | [发送人] 内容」">
        <textarea
          className={`${inputCls} min-h-[420px] resize-y font-mono leading-relaxed`}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setSaved(false);
          }}
          placeholder="流水是空的 —— 开着「日记」聊几句就会有内容。"
        />
      </Field>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 max-w-[62ch] text-meta leading-relaxed text-ink-faint">
          {dirty
            ? `改了还没写盘，现在 ${lines} 行。`
            : saved
            ? "已经写盘了。上次生成用的那份留在 .bak 里，手改不会动它。"
            : "它是聊天原文的流水账，改它等于改历史 —— 一般只用来修错行或删掉不想写进日记的那几句。"}
          <br />
          <strong className="text-ink-soft">只有写成一篇日记之后才会清空</strong>
          ，清之前留一份 .bak；写失败的话一个字节都不删，下次连着一起写。
        </p>
        <Button onClick={save} disabled={busy || !dirty}>
          {busy ? <RefreshCw size={14} className="animate-spin" /> : <Check size={14} />}
          {busy ? "写入中…" : "写入磁盘"}
        </Button>
      </div>
    </div>
  );
}

/* ================= 导入 / 导出 ================= */

/** 这一页的提示条。四个块各有各的一条，互不覆盖。 */
function TransferNote({ note }) {
  if (!note) return null;
  return (
    <p
      className={`border-l-2 py-1.5 pl-3 text-meta leading-relaxed ${
        note.ok ? "border-good text-good" : "border-warn text-warn"
      }`}
    >
      {note.text}
    </p>
  );
}

/** 小标题，和控制台那边的分区标题一个样子。 */
function TransferHead({ title, children }) {
  return (
    <div className="grid grid-cols-1 gap-1">
      <p className="text-eyebrow uppercase text-ink-faint">{title}</p>
      <p className="max-w-[68ch] text-meta leading-relaxed text-ink-faint">{children}</p>
    </div>
  );
}

const lineCount = (t) => String(t ?? "").split(/\r?\n/).filter((s) => s.trim()).length;

/**
 * 确认框里那张表：包里有哪几块、导进去会把本地的哪几块顶掉。
 *
 * 这些数字是**前端自己数出来的预览**（服务端的 summarizeMemoryBundle 不暴露给
 * 前端），只用来给人看一眼；导完之后报的数以响应里的 applied 为准。
 */
function bankRows(bundle, stats) {
  const keep = "包里没有，本地的不动";
  const mem = Array.isArray(bundle?.memories) ? bundle.memories : null;
  const withVec = mem
    ? mem.filter((m) => Array.isArray(m?.embedding) && m.embedding.length).length
    : 0;

  return [
    ["记忆条目", mem ? `${mem.length} 条 → 顶掉现在的 ${stats.memories ?? 0} 条` : keep],
    ["其中带向量的", mem ? `${withVec} 条` : "—"],
    [
      "备忘录",
      typeof bundle?.memo === "string" ? `${bundle.memo.trim().length} 字 → 整份替换` : keep,
    ],
    [
      "日记",
      Array.isArray(bundle?.diaries)
        ? `${bundle.diaries.length} 篇 → 同名的覆盖，本地多出来的留着`
        : keep,
    ],
    [
      "日记流水",
      typeof bundle?.diaryLog === "string" ? `${lineCount(bundle.diaryLog)} 行 → 整份替换` : keep,
    ],
    [
      "待总结（记忆）",
      typeof bundle?.pending?.memory === "string"
        ? `${lineCount(bundle.pending.memory)} 行 → 整份替换`
        : keep,
    ],
    [
      "待总结（备忘录）",
      typeof bundle?.pending?.memo === "string"
        ? `${lineCount(bundle.pending.memo)} 行 → 整份替换`
        : keep,
    ],
  ];
}

/**
 * 「导入 / 导出」这一页：整包搬家、纯文本记忆、补算向量三件事挤在一起。
 *
 * 为什么不拆成三张卡片散在各模块页里 —— 这三件事是**同一件事的三个环节**：
 * 从别处导一份记忆进来 → 它们没有向量 → 点一次补算。放一块儿才看得出先后。
 * 记忆页那边只留一行「有 N 条还没算向量 → 去补算一次」跳过来。
 *
 * 和预设 / 世界书那张 TransferCard 的关键差别：那边导入只进草稿，点保存才落盘，
 * 后悔了点撤销就完事；**这里每个动作都是直接写磁盘的**（记忆库本来就没有草稿态）。
 * 所以整包导入前面挡了一个确认框，把「哪几块会被顶掉」一条条列出来，
 * 而且旧的每一份都先备份成 .bak —— 用户钉死过「每个待总结的文件，都必须在生成
 * 之前备份一次」，导入这条路同样照办。
 */
function MemoryTransferPage({ memKey, roleName, detail, reload, onSettings }) {
  const bankRef = useRef(null);
  const textRef = useRef(null);
  const stopRef = useRef(false);

  const [withVectors, setWithVectors] = useState(false);
  const [busy, setBusy] = useState(""); // "" | export | import | text | embed
  const [stopping, setStopping] = useState(false);
  const [exportNote, setExportNote] = useState(null);
  const [bankNote, setBankNote] = useState(null);
  const [textNote, setTextNote] = useState(null);
  const [vecNote, setVecNote] = useState(null);
  const [progress, setProgress] = useState(null); // { done, failed, left }
  const [pending, setPending] = useState(null); // { bundle, fileName }

  // 离开这一页就把补算的循环停掉。不然用户走开再回来会起第二个循环，
  // 两个循环同时往同一份 items.json 写盘。每批都落盘，停了下次点一下接着补。
  useEffect(
    () => () => {
      stopRef.current = true;
    },
    []
  );

  const stats = detail.stats ?? {};
  const list = detail.memories ?? [];
  // 列表接口回来的每条都带 embedded 布尔，缺口就地数，不用单独跑一趟
  const noVec = list.filter((m) => !m.embedded).length;
  const anyBusy = Boolean(busy);

  /* ---- 导出整包 ---- */
  async function runExport() {
    setBusy("export");
    setExportNote(null);
    try {
      const name = await apiDownload(
        `/api/memories/${encodeURIComponent(memKey)}/export${withVectors ? "?vectors=1" : ""}`,
        {},
        "uranus-memorybank.json"
      );
      setExportNote({ ok: true, text: `已导出 ${name}` });
    } catch (e) {
      setExportNote({ ok: false, text: String(e?.message ?? e) });
    } finally {
      setBusy("");
    }
  }

  /* ---- 导入整包：先解析、再确认、最后才发 ---- */
  async function pickBank(e) {
    const file = e.target.files?.[0];
    e.target.value = ""; // 同一个文件连选两次也要能触发
    if (!file) return;

    setBankNote(null);
    let bundle;
    try {
      bundle = JSON.parse(await file.text());
    } catch {
      setBankNote({ ok: false, text: "这个文件不是合法的 JSON，选错文件了？" });
      return;
    }
    // 只挡最容易犯的那一种错（拿预设文件来导记忆库）。是不是本程序导的、
    // 版本号高不高，交给服务端的 openBundle 去报，省得两边文案打架。
    if (bundle?.kind && bundle.kind !== "memorybank") {
      setBankNote({
        ok: false,
        text: `这个文件里的 kind 是 ${bundle.kind}，不是记忆库（memorybank）。选错文件了？`,
      });
      return;
    }
    setPending({ bundle, fileName: file.name });
  }

  async function confirmBank() {
    const bundle = pending?.bundle;
    setPending(null);
    setBusy("import");
    setBankNote(null);
    try {
      const r = await api(`/api/memories/${encodeURIComponent(memKey)}/import`, {
        method: "POST",
        body: { bundle },
      });
      const a = r.applied ?? {};
      const parts = [];
      if (a.memories) parts.push(`${a.memories} 条记忆`);
      if (a.memo) parts.push("备忘录");
      if (a.diaries) parts.push(`${a.diaries} 篇日记`);
      if (a.diaryLog) parts.push("日记流水");
      if (a.pending?.length) parts.push(`待总结（${a.pending.join(" / ")}）`);
      const gap = r.vectors?.missing ?? 0;
      setBankNote({
        ok: true,
        text:
          `导好了：${parts.length ? parts.join("、") : "这个包里没有可导的内容"}。` +
          "被顶掉的那几份都留了 .bak。" +
          (gap ? `还有 ${gap} 条没向量 —— 往下翻，点一次「补算向量」。` : ""),
      });
    } catch (e) {
      setBankNote({ ok: false, text: String(e?.message ?? e) });
    } finally {
      setBusy("");
      try {
        await reload();
      } catch {
        /* 刷新失败不该把上面的结果盖掉 */
      }
    }
  }

  /* ---- 导入纯文本记忆 ---- */
  async function pickText(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setBusy("text");
    setTextNote(null);
    try {
      const r = await api(`/api/memories/${encodeURIComponent(memKey)}/import-text`, {
        method: "POST",
        body: { text: await file.text() },
      });
      const tail = [];
      if (r.duplicates) tail.push(`跳过 ${r.duplicates} 条库里已经有的`);
      if (r.skipped?.length) tail.push(`${r.skipped.length} 行格式不对没导`);
      setTextNote({
        ok: true,
        text:
          `导进来 ${r.added} 条${r.from ? `（${r.from} … ${r.to}）` : ""}，` +
          `现在一共 ${r.total} 条${tail.length ? `。${tail.join("，")}。` : "。"}` +
          (r.added ? "这批还没有向量 —— 要走语义检索的话，往下点一次「补算向量」。" : ""),
      });
    } catch (e) {
      setTextNote({ ok: false, text: String(e?.message ?? e) });
    } finally {
      setBusy("");
      try {
        await reload();
      } catch {
        /* 同上 */
      }
    }
  }

  /* ---- 补算向量：一批 40 条，循环叫到没剩下的为止 ---- */
  async function runEmbed() {
    stopRef.current = false;
    setStopping(false);
    setBusy("embed");
    setVecNote(null);
    setProgress({ done: 0, failed: 0, left: noVec });

    let done = 0;
    let failed = 0;
    let label = "";
    const errors = [];
    const why = () => (errors.length ? `原因：${errors.join("；")}` : "");

    try {
      for (;;) {
        const r = await api(`/api/memories/${encodeURIComponent(memKey)}/embed`, {
          method: "POST",
          body: { limit: 40 },
        });
        done += r.done ?? 0;
        failed += r.failed ?? 0;
        label = r.label || label;
        for (const msg of r.errors ?? []) if (errors.length < 3) errors.push(msg);
        setProgress({ done, failed, left: r.left ?? 0 });

        // 服务端连着 5 条失败就自己停了（额度用完 / 密钥失效 / 服务挂了都长这样）
        if (r.stopped) {
          setVecNote({
            ok: false,
            text:
              `连着好几条都失败，先停手了。已经算好的 ${done} 条都落盘了，` +
              `修好之后再点一次接着补。${why()}`,
          });
          break;
        }
        if (!r.left) {
          setVecNote({
            ok: true,
            text:
              `算完了：这次补上 ${done} 条` +
              `${failed ? `，${failed} 条没算成（留着空，下次再点接着补）` : ""}` +
              `${label ? `，用的是 ${label}` : ""}。`,
          });
          break;
        }
        if (stopRef.current) {
          setVecNote({
            ok: true,
            text: `停下了。算好的 ${done} 条已经落盘，还剩 ${r.left} 条 —— 下次点一下接着补。`,
          });
          break;
        }
        // 这一批一条都没成，再来一批也是一样的结果，别把接口打穿
        if (!r.done) {
          setVecNote({ ok: false, text: `这一批一条都没算成，停了。${why()}` });
          break;
        }
      }
    } catch (e) {
      setVecNote({ ok: false, text: String(e?.message ?? e) });
    } finally {
      setBusy("");
      setStopping(false);
      setProgress(null);
      try {
        await reload();
      } catch {
        /* 同上 */
      }
    }
  }

  return (
    <div className="grid grid-cols-1 gap-8">
      <p className="max-w-[68ch] text-meta leading-relaxed text-ink-faint">
        现在「{roleName || "未命名角色"}」库里：
        <strong className="text-ink-soft">{stats.memories ?? 0}</strong> 条记忆
        {noVec ? (
          <>
            （其中 <strong className="text-warn">{noVec}</strong> 条没向量）
          </>
        ) : (
          "（都有向量）"
        )}
        、<strong className="text-ink-soft">{stats.diaries ?? 0}</strong> 篇日记、备忘录{" "}
        <strong className="text-ink-soft">{stats.memoChars ?? 0}</strong> 字。
        <br />
        记忆库是<strong className="text-ink-soft">按角色名存的</strong>
        —— 角色改了名就等于换了一份空的记忆库，这时候正好用这里把旧的搬过来。
      </p>

      {/* ---------- A. 导出整包 ---------- */}
      <section className="grid grid-cols-1 gap-4 border-t border-line pt-8">
        <TransferHead title="导出整份记忆库">
          记忆条目、备忘录、所有日记、日记流水、两份待总结，一个 JSON 全带走。换电脑、备份、
          或者角色改名之后搬家都用它。
        </TransferHead>

        <label className="flex items-start justify-between gap-4">
          <span className="min-w-0">
            <span className="block text-ui text-ink">连向量一起导</span>
            <span className="mt-0.5 block max-w-[62ch] text-meta leading-relaxed text-ink-faint">
              关着的话文件小很多（向量是每条一千多个小数），导到别处点一次「补算向量」就能重算
              —— 代价是重新花一遍模型的钱。开着适合原样搬家，代价是文件可能有几十兆。
            </span>
          </span>
          <Switch checked={withVectors} onChange={setWithVectors} label="导出时带上向量" />
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={runExport} disabled={anyBusy}>
            {busy === "export" ? (
              <RefreshCw size={14} className="animate-spin" />
            ) : (
              <Download size={14} />
            )}
            {busy === "export" ? "导出中…" : "导出"}
          </Button>
        </div>
        <TransferNote note={exportNote} />
      </section>

      {/* ---------- B. 导入整包 ---------- */}
      <section className="grid grid-cols-1 gap-4 border-t border-line pt-8">
        <TransferHead title="导入整份记忆库">
          包里<strong className="text-ink-soft">有的那几块整体替换</strong>
          ，没有的一个字节都不动。旧的每一份都先存成 .bak；日记是
          <strong className="text-ink-soft">同名的才覆盖</strong>
          ，本地多出来的一篇都不删（生成后的日记永远不清空）。
        </TransferHead>

        <input
          ref={bankRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={pickBank}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => bankRef.current?.click()} disabled={anyBusy}>
            {busy === "import" ? (
              <RefreshCw size={14} className="animate-spin" />
            ) : (
              <Upload size={14} />
            )}
            {busy === "import" ? "导入中…" : "选择记忆库文件…"}
          </Button>
          <span className="text-meta text-ink-faint">选完会先让你确认一次</span>
        </div>
        <TransferNote note={bankNote} />
      </section>

      {/* ---------- C. 纯文本记忆 ---------- */}
      <section className="grid grid-cols-1 gap-4 border-t border-line pt-8">
        <TransferHead title="导入纯文本记忆">
          一行一条，长这样：<code className="font-mono text-ink-soft">2026-09-09 | 正文</code>
          。外面套着 <code className="font-mono text-ink-soft">&lt;memories&gt;</code> 标签也认。
          按日期<strong className="text-ink-soft">自动归档到时间线上</strong>；正文
          <strong className="text-ink-soft">一个字都不会改</strong>
          ；库里已经有的同一条不会再进一遍，所以同一个文件反复导也不会重。文件要存成 UTF-8。
        </TransferHead>

        <p className="max-w-[68ch] border-l-2 border-line py-1.5 pl-3 text-meta leading-relaxed text-ink-faint">
          这条路是<strong className="text-ink-soft">追加</strong>
          ，不是替换 —— 现有的记忆一条都不动。导进来的
          <strong className="text-ink-soft">都没有向量</strong>，要不要算、什么时候算，你说了算。
        </p>

        <input
          ref={textRef}
          type="file"
          accept="text/plain,.txt,.md"
          className="hidden"
          onChange={pickText}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => textRef.current?.click()} disabled={anyBusy}>
            {busy === "text" ? (
              <RefreshCw size={14} className="animate-spin" />
            ) : (
              <Upload size={14} />
            )}
            {busy === "text" ? "导入中…" : "选择 txt 文件…"}
          </Button>
        </div>
        <TransferNote note={textNote} />
      </section>

      {/* ---------- D. 补算向量 ---------- */}
      <section className="grid grid-cols-1 gap-4 border-t border-line pt-8">
        <TransferHead title="补算向量">
          把没有向量的那些补上。没向量的条目照样能被「近 N 天」那一路拿到，只是进不了语义检索
          —— 聊到很久以前那件事时翻不出来。一条一次模型请求，几百条要跑几分钟；中途能停，
          算好的每 20 条落一次盘，不会白算。
        </TransferHead>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={runEmbed} disabled={anyBusy || noVec === 0}>
            {busy === "embed" ? (
              <RefreshCw size={14} className="animate-spin" />
            ) : (
              <Sparkles size={14} />
            )}
            {busy === "embed" ? "算着…" : noVec ? `补算这 ${noVec} 条` : "全都有向量了"}
          </Button>

          {busy === "embed" && (
            <Button
              variant="ghost"
              onClick={() => {
                stopRef.current = true;
                setStopping(true);
              }}
              disabled={stopping}
            >
              <X size={14} /> {stopping ? "这一批跑完就停…" : "停下"}
            </Button>
          )}

          {progress && (
            <span className="font-mono text-meta text-ink-soft">
              已算 {progress.done} 条{progress.failed ? ` · 失败 ${progress.failed}` : ""} · 还剩{" "}
              {progress.left}
            </span>
          )}
        </div>

        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta leading-relaxed text-ink-faint">
          <span>
            用的是「设置 → 记忆」里选的那个向量模型 —— 换了模型的话老向量和新的不可比，得全部重算。
          </span>
          <button type="button" className="link-slide text-ink" onClick={onSettings}>
            去设置看看
          </button>
        </p>
        <TransferNote note={vecNote} />
      </section>

      {pending && (
        <Modal
          title="确认导入这份记忆库？"
          desc={pending.fileName}
          onClose={() => setPending(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setPending(null)}>
                取消
              </Button>
              <Button onClick={confirmBank}>
                <Check size={14} /> 导入
              </Button>
            </>
          }
        >
          <div className="grid grid-cols-1 gap-6">
            <div className="grid grid-cols-1">
              {bankRows(pending.bundle, stats).map(([label, what]) => (
                <div
                  key={label}
                  className="flex items-baseline justify-between gap-4 border-b border-line py-2 text-ui text-ink-soft"
                >
                  <span className="shrink-0">{label}</span>
                  <span className="text-right text-meta text-ink">{what}</span>
                </div>
              ))}
            </div>
            <p className="max-w-[62ch] text-meta leading-relaxed text-ink-faint">
              导的是「{roleName || "未命名角色"}」这一个角色的记忆库，别的角色一点都不受影响。
              被顶掉的每一份都会先存成 .bak，导错了还能换回来。
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}