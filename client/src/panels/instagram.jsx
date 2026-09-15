/**
 * Instagram 分区：**所有** IG 的设置和管理都在这儿。
 *
 * IG 那一页（单开的 6873 端口，instagram.html）是拿来「当 IG 用」的 ——
 * 刷首页、点赞、评论、自己发帖发快拍。上帝视角的活儿全在这个面板里：
 * 改谁的主页资料、替角色发帖、改角色的配文、管精选、调快拍时长、改提示词。
 * 用户定的：「所有 IG 的设置都放到 Uranus 里，不在 IG 里设置了」。
 *
 * 所以这一版**没有一丁点 IG 界面**了 —— 不 import ig.css，不用 `.ig-*` 那套
 * 类名。上一版是在控制台里画了个仿真 IG，正是「看着好难受」的那个东西。
 *
 * 侧栏两组（nav.js 里的 `groups`）：
 *   总设置 → 全局 / 提示词 / 真实账号
 *   主页   → 你 + 每个开了 Instagram 的角色
 *
 * 「真实账号」那一页是唯一会往公网发东西的地方：绑 token、配图床、调收信节奏。
 * token 和图床 secret **只往一个方向走** —— PUT 进去，再也不回来（后端
 * igreal.js:realOverview 只回用户名和到期天数）。所以那一页没有「看看我存的是
 * 什么」这种功能，输入框留空一律表示「这项不改」。
 *
 * ⚠ 所有子组件都定义在模块顶层。写进 InstagramPanel 里的话，父组件每渲染
 * 一次 React 就当它是个新类型、把整棵子树卸了重建 —— textarea 每敲一个字
 * 都会丢焦点。
 *
 * ── 这一页不进草稿 ──
 *
 * IG 的数据**不在 config.json 里**（PUT /api/config 会把所有 iMessage 桥重启
 * 一遍，不能为了改个精选封面把人家的号踢下线），所以全局那个 GlobalSaveBar
 * 管不到它，这里也不挂 SaveBar。帖子 / 主页 / 精选这类是点一下就落盘，
 * 两页设置各有自己的「保存」按钮。
 */

import { useEffect, useMemo, useState } from "react";
import {
  CircleAlert,
  ExternalLink,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Undo2,
  Unlink,
} from "lucide-react";

import { roleLabel } from "../labels.js";
import { useSection } from "../section.jsx";
import { useConfig } from "../store.jsx";
import {
  Button,
  Card,
  Eyebrow,
  Field,
  Fold,
  NumberField,
  ResultNote,
  Switch,
  fmtStamp,
  inputCls,
} from "../ui.jsx";
import { avatarUrl, igMediaUrl, timeAgo } from "../ig/parts.jsx";
import { igApi, useIgSettings, useProfile, useRealIg } from "../ig/useIg.js";
import { HighlightEditor, PostEditor, ProfileEditor } from "./igeditors.jsx";

/* ================================================================== */
/* IG 那一页开在哪儿                                                   */
/* ================================================================== */

/**
 * Instagram 页的地址。
 *
 * 后端开了两个端口（见 server/src/index.js），`/api/health` 里的 `igPort`
 * 就是 IG 那个，控制台拿它拼出完整地址。
 *
 * url 是空串 = 端口被关了（URANUS_IG_PORT=off），卡片要照实说。
 */
function useIgPage() {
  const [state, setState] = useState({ url: "", loading: true });

  useEffect(() => {
    if (import.meta.env.DEV) return undefined;
    // StrictMode 下这个 effect 会跑两遍，alive 必须在函数体里重新置 true
    let alive = true;
    fetch("/api/health")
      .then((r) => r.json())
      .then((h) => {
        if (!alive) return;
        const port = h?.igPort;
        const { protocol, hostname } = window.location;
        setState({ url: port ? `${protocol}//${hostname}:${port}/` : "", loading: false });
      })
      .catch(() => {
        if (alive) setState({ url: "", loading: false });
      });
    return () => {
      alive = false;
    };
  }, []);

  return state;
}

/** 「打开 Instagram 页」那个按钮 + 地址。端口关着就说清楚怎么开回来。 */
function IgPageCard() {
  const { url, loading } = useIgPage();

  return (
    <Card
      title="Instagram 页"
      desc="刷首页、点赞、评论、自己发帖发快拍 —— 那些「当 IG 用」的事在那一页做。设置和替角色发东西都在这边。"
      actions={
        url ? (
          <Button variant="outline" onClick={() => window.open(url, "_blank", "noopener")}>
            <ExternalLink size={13} /> 打开
          </Button>
        ) : null
      }
    >
      {loading ? (
        <p className="text-meta text-ink-faint">正在问后端开在哪个端口…</p>
      ) : url ? (
        <p className="text-ui text-ink-soft">
          开在 <span className="font-mono text-ink">{url}</span>
          <span className="mt-1 block text-meta text-ink-faint">
            和控制台是同一个后端、同一份数据，只是换了个端口和一整套界面。
          </span>
        </p>
      ) : (
        <p className="text-ui text-ink-soft">
          这个端口现在是关着的。
          <span className="mt-1 block text-meta text-ink-faint">
            环境变量 <span className="font-mono">URANUS_IG_PORT</span> 设成了 off（或者 0）。
            去掉它就会开回默认的 6873。
          </span>
        </p>
      )}
    </Card>
  );
}

/* ================================================================== */
/* 总设置 · 全局                                                       */
/* ================================================================== */

const VIEW_LABELS = {
  auto: "跟窗口宽度走",
  mobile: "一直按手机版",
  desktop: "一直按电脑版",
};

function GlobalSettings() {
  const { settings, save } = useIgSettings();
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState({ state: "idle", message: "" });

  // 拉回来之后灌一次草稿。保存完 settings 会换新对象、这儿再灌一次，
  // 灌的是刚存进去的那份，值一样，看不出动静
  useEffect(() => {
    if (!settings) return;
    setDraft({
      storyHours: settings.storyHours,
      defaultView: settings.defaultView,
    });
  }, [settings]);

  const submit = async () => {
    setBusy(true);
    setNote({ state: "idle", message: "" });
    try {
      await save({ storyHours: Number(draft.storyHours), defaultView: draft.defaultView });
      setNote({ state: "ok", message: "存好了" });
    } catch (e) {
      setNote({ state: "fail", message: String(e?.message ?? e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <IgPageCard />

      <Card
        title="全局"
        desc="这两项对所有人生效 —— 你和每个开了 Instagram 的角色。"
        actions={
          <Button onClick={submit} disabled={busy || !draft}>
            {busy ? "保存中…" : "保存"}
          </Button>
        }
      >
        {draft ? (
          <div className="grid gap-8">
            <NumberField
              label="快拍存活时长"
              value={draft.storyHours}
              min={0}
              max={720}
              step={1}
              suffix="小时"
              hint="过了这个时长，快拍就从首页那条快拍圈里消失，落到主页的「往期快拍」里 —— 还能收进精选。IG 自己是 24 小时，这里 0 到 720 都行。过期与否是当场算出来的，不是发的时候定死的，所以改了这个数，已经发出去的快拍也跟着变。"
              onChange={(v) => setDraft((d) => ({ ...d, storyHours: v }))}
            />

            <Field
              label="Instagram 页默认版式"
              hint="那一页打开时先按哪套版式画。选「跟窗口宽度走」就是 768px 以下算手机。"
            >
              <select
                className={inputCls}
                value={draft.defaultView ?? "auto"}
                onChange={(e) => setDraft((d) => ({ ...d, defaultView: e.target.value }))}
              >
                {Object.entries(VIEW_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>

            <ResultNote state={note.state} message={note.message} />
          </div>
        ) : (
          <p className="text-meta text-ink-faint">正在读设置…</p>
        )}
      </Card>
    </>
  );
}

/* ================================================================== */
/* 总设置 · 提示词                                                     */
/* ================================================================== */

/**
 * 八条模板的标签和说明。
 *
 * **只有标签和说明，没有正文** —— 正文的唯一出处是服务端
 * （server/src/igprompt.js:DEFAULT_TEMPLATES），经 `/api/ig/settings` 的
 * `promptDefaults` 带过来当 placeholder。在这儿抄一份的话，改了那边忘了改
 * 这边，用户看到的「默认值」就和真正在跑的那份对不上了。
 *
 * 键的**顺序**也不在这儿定，照服务端 promptDefaults 的字面量顺序排
 * （igprompt.js:138 特意说了那个顺序有意义）。这张表只是查标签用的，
 * 查不到的键照样渲染，标签退回键名本身 —— 服务端加了一条也不会白屏。
 */
const PROMPT_META = {
  userPost: {
    group: "scene",
    label: "你发了帖子",
    hint: "角色刷到你新帖子的那一刻。可以用 {{user}} / {{char}}。",
  },
  userStory: { group: "scene", label: "你发了快拍", hint: "角色点开你快拍的那一刻。" },
  userComment: { group: "scene", label: "你留了评论", hint: "你在角色的帖子下面说了话。" },
  charPost: {
    group: "scene",
    label: "别的角色发了帖子",
    hint: "角色之间的互动。这条里可以用 {{对方}}，会换成发帖那个角色的名字。",
  },
  charComment: {
    group: "scene",
    label: "别的角色留了评论",
    hint: "同上，{{对方}} 是留言那位。",
  },
  action: {
    group: "action",
    label: "对着你的时候",
    hint: "三种做法（只留评论 / 只发短信 / 两样都做）就是在这儿教的。[comment:…] 的格式只在这里出现，预设里一个字都没提。",
  },
  peerAction: {
    group: "action",
    label: "对着别的角色的时候",
    hint: "这一轮只能留评论 —— 角色之间的互动不该变成发给你的短信。",
  },
  compose: {
    group: "action",
    label: "自己想发点东西的时候",
    hint: "[post:配文] / [story:配文] / [image:图里有什么] 的格式在这儿教。开了「主动发布帖子 / 快拍」的角色，这段会缀在它主动消息那一轮的提示词末尾。",
  },
};

/** <Instagram> 那一轮，模型收到的段落顺序。和 igprompt.js 顶上那段注释同源。 */
const PROMPT_ORDER = [
  ["<Instagram>", "下面那句场景 + 帖子快照", "最顶上"],
  ["<Character>", "角色人设"],
  ["<User>", "用户人设"],
  ["<World_Info>", "世界书"],
  ["<近期记忆>", "最近几天的"],
  ["<过往回忆>", "向量检索回来的"],
  ["<备忘录>", ""],
  ["<Chat_History>", "当前所有上下文"],
  ["行动指令", "下面那三条之一", "最底下"],
];

function PromptOrder() {
  return (
    <ol className="grid gap-1.5">
      {PROMPT_ORDER.map(([tag, desc, mark]) => (
        <li key={tag} className="flex items-baseline gap-3 text-meta">
          <span className="w-36 shrink-0 font-mono text-ink">{tag}</span>
          <span className="text-ink-faint">{desc}</span>
          {mark ? <span className="text-ink-meta">← {mark}</span> : null}
        </li>
      ))}
    </ol>
  );
}

/** 一条模板。留空 = 用服务端那份内置的，所以「清空」写的是空串而不是默认正文。 */
function PromptField({ label, hint, value, fallback, onChange }) {
  return (
    <Field label={label} hint={hint}>
      <textarea
        className={`${inputCls} min-h-[120px] resize-y font-mono leading-relaxed`}
        value={value ?? ""}
        placeholder={fallback}
        onChange={(e) => onChange(e.target.value)}
      />
      {String(value ?? "").trim() ? (
        <button
          type="button"
          onClick={() => onChange("")}
          className="mt-2 inline-flex items-center gap-1.5 text-meta text-ink-soft transition-colors duration-150 hover:text-ink"
        >
          <Undo2 size={13} /> 清空 —— 留空就用上面灰字那份内置的
        </button>
      ) : null}
    </Field>
  );
}

function PromptSettings() {
  const { settings, save } = useIgSettings();
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState({ state: "idle", message: "" });

  useEffect(() => {
    if (settings) setDraft({ ...(settings.promptTemplates ?? {}) });
  }, [settings]);

  const defaults = settings?.promptDefaults ?? {};
  // 顺序照服务端的来；表里查不到的键归到「行动指令」那一组，不至于漏掉
  const keys = Object.keys(defaults);
  const sceneKeys = keys.filter((k) => PROMPT_META[k]?.group === "scene");
  const actionKeys = keys.filter((k) => PROMPT_META[k]?.group !== "scene");

  const submit = async () => {
    setBusy(true);
    setNote({ state: "idle", message: "" });
    try {
      await save({ promptTemplates: draft });
      setNote({ state: "ok", message: "存好了，下一轮就按新的拼" });
    } catch (e) {
      setNote({ state: "fail", message: String(e?.message ?? e) });
    } finally {
      setBusy(false);
    }
  };

  const field = (key) => (
    <PromptField
      key={key}
      label={PROMPT_META[key]?.label ?? key}
      hint={PROMPT_META[key]?.hint}
      value={draft?.[key]}
      fallback={defaults[key]}
      onChange={(v) => setDraft((d) => ({ ...d, [key]: v }))}
    />
  );

  return (
    <>
      <Card
        title="这一轮是怎么拼的"
        desc="角色去点赞、评论、回评论，用的不是聊天那一轮的提示词。段落顺序是钉死的，不跟预设的条目顺序走 —— 但开关跟预设走：预设里把世界书关了，这一轮也不会有世界书。"
      >
        <PromptOrder />
        <p className="mt-6 text-meta text-ink-faint">
          你能改的是「场景」那句话和最底下的「行动指令」。中间那一摞（人设 / 世界书 / 记忆 /
          上下文）是照预设和记忆设置拼的，不在这一页。
        </p>
      </Card>

      <Card
        title="提示词"
        desc="八条模板。每条留空就用内置的那份（输入框里的灰字就是它）。"
        actions={
          <Button onClick={submit} disabled={busy || !draft}>
            {busy ? "保存中…" : "保存"}
          </Button>
        }
      >
        {draft ? (
          <div className="grid gap-0">
            <Fold
              title="场景"
              desc="压在最顶上那一句，交代「发生了什么」。下面紧跟着的帖子快照是程序生成的，改不了 —— 那是数据不是文案。"
              defaultOpen
              badge={`${sceneKeys.length} 条`}
            >
              <div className="grid gap-8">{sceneKeys.map(field)}</div>
            </Fold>

            <Fold
              title="行动指令"
              desc="压在最底下，交代「该说什么、写成什么格式」。方括号里面不能出现分隔符 —— 这条规矩三份模板里都写着，别删。"
              badge={`${actionKeys.length} 条`}
            >
              <div className="grid gap-8">{actionKeys.map(field)}</div>
            </Fold>

            <div className="pt-6">
              <ResultNote state={note.state} message={note.message} />
            </div>
          </div>
        ) : (
          <p className="text-meta text-ink-faint">正在读设置…</p>
        )}
      </Card>
    </>
  );
}

/* ================================================================== */
/* 总设置 · 真实账号                                                   */
/* ================================================================== */

/**
 * 一条账号：显示状态 + 粘 token 绑定 + 解绑。
 *
 * token 的输入框是**一次性**的 —— 绑完就清空，而且后端从来不把 token 回给
 * 前端（igreal.js:realOverview 只回用户名和到期天数）。所以这里没有「显示
 * 当前 token」这种东西，绑好之后能看到的只有「绑的是 @谁」。
 *
 * 绑定会真的打一次 Meta 的接口验证，可能要几秒（还可能过代理），所以按钮
 * 上写「正在验证…」而不是「保存中…」—— 用户得知道这一下是在联网。
 */
function AccountRow({ acc, label, hint, busy, onBind, onUnbind }) {
  const [token, setToken] = useState("");
  const [note, setNote] = useState({ state: "idle", message: "" });
  const [armed, setArmed] = useState(false);

  const submit = async () => {
    const clean = token.trim();
    if (!clean) return;
    setNote({ state: "idle", message: "" });
    try {
      await onBind(clean);
      // 立刻清空：这串东西等于账号密码，没有留在输入框里的理由
      setToken("");
      setNote({ state: "ok", message: "绑好了" });
    } catch (e) {
      setNote({ state: "fail", message: String(e?.message ?? e) });
    }
  };

  const unbind = async () => {
    setArmed(false);
    setNote({ state: "idle", message: "" });
    try {
      await onUnbind();
      setNote({ state: "ok", message: "已解绑。本地那份主页一点没动。" });
    } catch (e) {
      setNote({ state: "fail", message: String(e?.message ?? e) });
    }
  };

  return (
    <div className="border-b border-line pb-6 last:border-b-0 last:pb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-ui text-ink">{label}</p>
        {acc.bound ? (
          <p className="text-meta text-ink-faint">
            <span className="font-mono text-ink-soft">@{acc.username || "?"}</span>
            {acc.days ? ` · token 还有 ${acc.days} 天` : " · 到期时间未知"}
            {acc.refreshedAt ? ` · 上次续期 ${fmtStamp(acc.refreshedAt)}` : ""}
          </p>
        ) : (
          <p className="text-meta text-ink-meta">没绑</p>
        )}
      </div>

      {hint ? <p className="mt-1 text-meta leading-relaxed text-ink-faint">{hint}</p> : null}

      {acc.bound ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="text-meta text-ink-faint">
            24 小时里发了 <span className="text-ink-soft">{acc.published24h}</span> / 50 条
          </p>
          {armed ? (
            <>
              <Button variant="outline" onClick={unbind} disabled={busy}>
                <Unlink size={13} /> 确认解绑
              </Button>
              <Button variant="ghost" onClick={() => setArmed(false)}>
                算了
              </Button>
            </>
          ) : (
            <Button variant="ghost" onClick={() => setArmed(true)} disabled={busy}>
              <Unlink size={13} /> 解绑
            </Button>
          )}
        </div>
      ) : null}

      {acc.lastError ? (
        <p className="mt-2 flex items-start gap-2 text-meta text-warn">
          <CircleAlert size={13} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{acc.lastError}</span>
        </p>
      ) : null}

      <div className="mt-3 flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <input
            type="password"
            className={inputCls}
            value={token}
            spellCheck={false}
            autoComplete="off"
            placeholder={acc.bound ? "粘一串新的可以换绑" : "粘 Meta 后台生成的长效 token"}
            onChange={(e) => setToken(e.target.value)}
          />
        </div>
        <Button onClick={submit} disabled={busy || !token.trim()}>
          {busy ? "正在验证…" : acc.bound ? "换绑" : "绑定"}
        </Button>
      </div>

      <div className="mt-2">
        <ResultNote state={note.state} message={note.message} />
      </div>
    </div>
  );
}

/** 轮询结果那一行人话。`result` 是 pollOnce 的返回。 */
function pollSummary(result) {
  if (!result) return "同步完了";
  const bits = [];
  if (result.refreshed?.length) bits.push(`续期 ${result.refreshed.length} 个账号`);
  if (result.user?.posts || result.user?.stories) {
    bits.push(`拉回你的 ${result.user.posts} 条帖子 / ${result.user.stories} 条快拍`);
  }
  if (result.comments) bits.push(`新评论 ${result.comments} 条`);
  if (result.retried) bits.push(`补发成功 ${result.retried} 条`);
  return bits.length ? `同步完了：${bits.join("，")}` : "同步完了，这一轮没有新东西";
}

/**
 * 可互动账号的白名单：一行一个「名字 + @用户名」，底下一个加号。
 *
 * 为什么一条要两个字段：真 IG 的用户名是给机器看的（`myigaccount`），
 * 模型看见这种串既费 token 又念不出来。所以用户名只用来**对上是谁**，
 * 名字是**给模型看的**那个 —— 用户的原话是「不带用户名（太长），就显示
 * 小明给 LLM 就可以了」。
 *
 * 名字留空不影响放行，只是模型会看到 `@用户名`。
 *
 * `value` 是 `[{ name, username }]`，原样往上抛 —— 规范化（去 @、转小写、
 * 剔非法字符、按用户名去重）全在后端 igaccounts.js:normalizeSettings 做，
 * 这边不抢那份活儿，免得两处规则慢慢长歪。
 *
 * ── 为什么这里不用 inputCls ──
 *
 * 全站的输入框是「只有一条底线」（ui.jsx:inputCls），那套在**填了内容**的表单里
 * 很干净，但这儿的行是**空着出生**的：点一下加号，出来两个没有内容的框，底线细、
 * placeholder 是灰的，整行看上去就像一句灰色的静态文字 `小明 @myigaccount`
 * —— 用户的原话是「那个 @ 是灰色的啊，哪有两个格子？」。所以这两个框画整框
 * （`border` + `rounded-item`），再各配一个 8px 的小标题：空行也得一眼看出
 * 「这里有两个格子，左边填名字，右边填用户名」。
 */
function AllowList({ value, onChange }) {
  const rows = value ?? [];
  const patch = (i, key, text) =>
    onChange(rows.map((r, at) => (at === i ? { ...r, [key]: text } : r)));

  // 空行要能被认出来是「格子」，所以画整框而不是 inputCls 那条底线
  const boxCls =
    "w-full rounded-item border border-line bg-transparent px-2.5 py-1.5 text-ui text-ink outline-none transition-colors duration-150 placeholder:text-ink-faint focus:border-ink";

  return (
    <Field label="可互动的账号" hint="名字给模型看，用户名用来对上是谁">
      <div className="grid gap-3">
        {rows.length ? (
          rows.map((row, i) => (
            // key 用下标：这些行没有稳定 id，而删除总是整行删、不做重排
            // 窄屏上换行：名字独占一行，用户名和删除按钮下一行 —— 挤在一行的话
            // 用户名框只剩 90px，装不下 30 个字符的 handle
            <div key={i} className="flex flex-wrap items-end gap-2">
              <label className="w-full shrink-0 sm:w-28">
                <span className="mb-1 block text-eyebrow text-ink-faint">名字</span>
                <input
                  className={boxCls}
                  value={row.name}
                  placeholder="小明"
                  aria-label="给模型看的名字"
                  onChange={(e) => patch(i, "name", e.target.value)}
                />
              </label>
              <label className="min-w-0 flex-1">
                <span className="mb-1 block text-eyebrow text-ink-faint">IG 用户名</span>
                <span className="flex items-center gap-1">
                  <span className="shrink-0 text-ui text-ink-meta">@</span>
                  <input
                    className={`${boxCls} font-mono`}
                    value={row.username}
                    spellCheck={false}
                    placeholder="myigaccount"
                    aria-label="IG 用户名"
                    onChange={(e) => patch(i, "username", e.target.value)}
                  />
                </span>
              </label>
              <button
                type="button"
                onClick={() => onChange(rows.filter((_, at) => at !== i))}
                aria-label="从白名单里删掉这个"
                className="shrink-0 rounded-item p-2 text-ink-faint transition-colors duration-150 hover:bg-sunken hover:text-warn"
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))
        ) : (
          <p className="text-meta text-ink-meta">还没加人 —— 现在谁来留言都不会有人回。</p>
        )}
      </div>

      {/* 画成一个虚线框的整行按钮：它是「这张表还能往下长」的那个位置，
          用文字链的话在一堆说明文字里认不出来 */}
      <button
        type="button"
        onClick={() => onChange([...rows, { name: "", username: "" }])}
        className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-item border border-dashed border-line py-2 text-meta text-ink-meta transition-colors duration-150 hover:border-ink hover:text-ink"
      >
        <Plus size={13} /> 加一个
      </button>

      <span className="mt-3 block text-meta leading-relaxed text-ink-faint">
        <strong className="text-ink-soft">空着 = 谁都不理</strong>
        ，评论照样镜像进本地，但角色不会回。这是刻意的默认：角色的小号是公开的，
        任何陌生人都能在下面留言，而「角色自动回复陌生人」既烧钱又可能说出不该说的话。
        <br />
        名字是<strong className="text-ink-soft">给模型看的</strong>
        ：填了小明，角色收到的就是「小明在 Instagram 上给你留了言」，
        而不是那串又长又念不出来的用户名。留空就退回 @用户名。
        <br />
        已经绑进来的角色小号和你的大号
        <strong className="text-ink-soft">永远算数</strong>
        ，不用手填 —— 角色之间互相评论就是靠这条走通的。
      </span>
    </Field>
  );
}

function RealSettings({ onGoto }) {
  const { data, busy, reload, bind, save, poll } = useRealIg();
  const [draft, setDraft] = useState(null);
  const [host, setHost] = useState({ cloudName: "", apiKey: "", apiSecret: "" });
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState({ state: "idle", message: "" });
  const [pollNote, setPollNote] = useState({ state: "idle", message: "" });

  /*
   * 灌草稿。图床那三项**不灌** —— 后端只回一个 configured 布尔，key 和 secret
   * 一个字节都不下来，灌进来只能灌空串，而空串在 PUT 里表示「这项不改」。
   * cloudName 不是秘密（它出现在图片 URL 里），所以那个灌。
   */
  useEffect(() => {
    if (!data?.settings) return;
    const s = data.settings;
    setDraft({
      intervalHours: s.intervalHours,
      dnd: { ...s.dnd },
      // 一条一个 { name, username }。后端读回来的已经是规范形态了
      allowFrom: (s.allowFrom ?? []).map((e) => ({
        name: e?.name ?? "",
        username: e?.username ?? "",
      })),
      syncUser: s.syncUser,
    });
    setHost((h) => ({ ...h, cloudName: s.imageHost?.cloudName ?? "" }));
  }, [data?.settings]);

  const submit = async (patch, okMessage) => {
    setSaving(true);
    setNote({ state: "idle", message: "" });
    try {
      await save(patch);
      setNote({ state: "ok", message: okMessage });
    } catch (e) {
      setNote({ state: "fail", message: String(e?.message ?? e) });
    } finally {
      setSaving(false);
    }
  };

  const saveRhythm = () =>
    submit(
      {
        intervalHours: Number(draft.intervalHours),
        dnd: draft.dnd,
        // 用户名空着的那几行直接丢掉（点了加号又没填完的）。后端还会再规范
        // 一遍（去 @、转小写、剔非法字符、按用户名去重）
        allowFrom: draft.allowFrom
          .filter((e) => e.username.trim())
          .map((e) => ({ name: e.name.trim(), username: e.username.trim() })),
        syncUser: draft.syncUser,
      },
      "存好了"
    );

  const saveHost = () =>
    submit(
      { imageHost: host },
      "图床凭据存好了 —— 留空的那几项没动"
    );

  const runPoll = async () => {
    setPollNote({ state: "idle", message: "正在同步…" });
    try {
      const r = await poll();
      setPollNote({ state: "ok", message: pollSummary(r?.result) });
    } catch (e) {
      setPollNote({ state: "fail", message: String(e?.message ?? e) });
    }
  };

  if (!data || !draft) {
    return (
      <Card title="真实账号">
        <p className="text-meta text-ink-faint">正在读状态…</p>
      </Card>
    );
  }

  const hostOk = data.settings.imageHost?.configured;
  const roles = data.accounts ?? [];
  const boundRoles = roles.filter((r) => r.bound);
  const syncOn = roles.filter((r) => r.syncReal);

  return (
    <>
      <Card
        title="真实账号"
        desc="把角色发的帖子和快拍真的发到一个 Instagram 账号上。本地那套照旧存在 —— 真 IG 只是多一个橱窗，那边挂了、限流了、token 过期了，本地一点都不受影响。"
        actions={
          <Button variant="outline" onClick={reload} disabled={busy}>
            <RefreshCw size={13} /> 刷新状态
          </Button>
        }
      >
        <div className="grid gap-4 text-meta leading-relaxed text-ink-faint">
          <p>
            要三样东西同时齐了才会真的发：
            <span className="text-ink-soft">角色开了 Instagram</span>、
            <span className="text-ink-soft">这个角色打开了「同步到真实 Instagram」</span>、
            <span className="text-ink-soft">它绑了一个真号而且图床配好了</span>
            。缺哪一样都只走本地，不报错。
          </p>
          <p>
            <strong className="text-warn">真发出去的删不掉。</strong>
            Meta 的接口没有删除帖子这个动作，只能拿手机手动删。所以这个开关默认是关的，
            打开之前想清楚。
          </p>
          <p>
            信息流的图必须在 <span className="font-mono text-ink-soft">4:5 ~ 1.91:1</span>{" "}
            之间，超出的会被<strong className="text-ink-soft">居中裁掉</strong>
            （太竖的裁上下，太宽的裁左右）—— 这是 Meta 的硬规矩，不裁就发不出去。
            快拍不裁。每个账号一天最多 50 条。
          </p>
          <p>
            {data.proxy?.configured ? (
              <>
                走代理（读的是 <span className="font-mono text-ink-soft">{data.proxy.from}</span>
                ）。<span className="text-ink-meta">地址不显示在这儿 —— 里面可能带账号密码。</span>
              </>
            ) : (
              <>
                没配代理。国内直连 <span className="font-mono">graph.instagram.com</span>{" "}
                大概率不通，可以设环境变量{" "}
                <span className="font-mono text-ink-soft">URANUS_IG_PROXY</span>。
              </>
            )}
          </p>
        </div>

        <div className="mt-8 grid gap-2 border-t border-line pt-6 text-meta">
          <p className="text-ink-faint">
            现在的状态：{roles.length} 个角色开了 Instagram，其中{" "}
            <span className="text-ink-soft">{syncOn.length}</span> 个打开了同步、
            <span className="text-ink-soft">{boundRoles.length}</span> 个绑了真号；图床
            {hostOk ? "已配好" : "还没配"}。
          </p>
          {data.inDnd ? (
            <p className="text-ink-meta">
              现在在勿扰时段里，不轮询也不发 —— 这段时间攒下的会在结束之后补。
            </p>
          ) : null}
          {data.settings.lastPollAt ? (
            <p className="text-ink-meta">上次同步：{fmtStamp(data.settings.lastPollAt)}</p>
          ) : (
            <p className="text-ink-meta">还没同步过。</p>
          )}
        </div>
      </Card>

      <Card
        title="图床"
        desc="Meta 不收上传的字节，它只收一个公网 HTTPS 地址、自己去下载。所以发布之前得把图临时挂到公网上 —— 用 Cloudinary，发完立刻删掉，暴露窗口通常几秒。"
        actions={
          <Button onClick={saveHost} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </Button>
        }
      >
        <div className="grid gap-8">
          <p className="text-meta leading-relaxed text-ink-faint">
            {hostOk ? (
              <>
                已经配好了。
                <span className="text-ink-meta">
                  key 和 secret 存在本地 data/instagram/accounts.json 里，不会回到这个页面 ——
                  下面两个框留空就是不改。
                </span>
              </>
            ) : (
              <>
                去 cloudinary.com 注册一个免费账号，Dashboard 首页就有这三样。
                <span className="text-ink-meta">
                  免费额度对「一天发几条」这种用量绰绰有余。
                </span>
              </>
            )}
          </p>

          <Field label="Cloud name" hint="出现在图片地址里，不是秘密">
            <input
              className={inputCls}
              value={host.cloudName}
              spellCheck={false}
              autoComplete="off"
              placeholder="例如 dxxxxxxxx"
              onChange={(e) => setHost((h) => ({ ...h, cloudName: e.target.value }))}
            />
          </Field>

          <Field label="API key" hint={hostOk ? "留空 = 不改" : ""}>
            <input
              type="password"
              className={inputCls}
              value={host.apiKey}
              spellCheck={false}
              autoComplete="off"
              placeholder={hostOk ? "已保存" : "一串数字"}
              onChange={(e) => setHost((h) => ({ ...h, apiKey: e.target.value }))}
            />
          </Field>

          <Field label="API secret" hint={hostOk ? "留空 = 不改" : ""}>
            <input
              type="password"
              className={inputCls}
              value={host.apiSecret}
              spellCheck={false}
              autoComplete="off"
              placeholder={hostOk ? "已保存" : "签名用的密钥，只在这台机器上出现"}
              onChange={(e) => setHost((h) => ({ ...h, apiSecret: e.target.value }))}
            />
          </Field>
        </div>
      </Card>

      <Card
        title="绑账号"
        desc="一个角色一个 Instagram 账号。token 去 Meta 开发者后台的 App Dashboard 里点「Generate token」拿，那个点出来就是 60 天长效的 —— 之后程序自己续期，不用再管。"
      >
        <div className="grid gap-6">
          <AccountRow
            acc={data.user}
            label="你的大号"
            hint="只读：拿来把你自己真 IG 上的帖子和快拍镜像进本地，从来不用它发东西。不开下面那个「同步你自己的号」的话，绑了也不会动。"
            busy={busy}
            onBind={(token) => bind("", token)}
            onUnbind={() => bind("", "")}
          />

          {roles.length ? (
            roles.map((r) => (
              <AccountRow
                key={r.roleName}
                acc={r}
                label={r.roleName}
                hint={
                  r.syncReal
                    ? "同步开着 —— 绑好并且图床配好之后，它发的帖子和快拍会真的发出去。"
                    : "同步是关着的。绑了也只走本地，开关在「角色 → 单独配置 → Instagram」。"
                }
                busy={busy}
                onBind={(token) => bind(r.roleName, token)}
                onUnbind={() => bind(r.roleName, "")}
              />
            ))
          ) : (
            <p className="text-meta text-ink-faint">
              一个角色都没开 Instagram。开关在
              <button
                type="button"
                onClick={() => onGoto?.("role")}
                className="mx-1 text-ink underline decoration-line underline-offset-4 transition-colors duration-150 hover:decoration-ink"
              >
                角色 → 单独配置 → Instagram
              </button>
              。
            </p>
          )}
        </div>
      </Card>

      <Card
        title="收信节奏"
        desc="Meta 没有「有人评论了」的推送（那要一个公网入口），所以是我们隔一阵去问一次。这个间隔直接决定「你在真 IG 上留言之后多久有人回」。"
        actions={
          <Button onClick={saveRhythm} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </Button>
        }
      >
        <div className="grid gap-8">
          <NumberField
            label="轮询间隔"
            value={draft.intervalHours}
            min={0}
            max={168}
            step={1}
            suffix="小时"
            hint="0 = 不轮询（只发不收）。默认 3 小时。"
            onChange={(v) => setDraft((d) => ({ ...d, intervalHours: v }))}
          />

          <div className="grid gap-4">
            <label className="flex items-start justify-between gap-4">
              <span className="min-w-0">
                <span className="block text-ui text-ink">勿扰时段</span>
                <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                  这段时间里不轮询、不回评论、也不发帖。为什么轮询也要守勿扰：拉回一条你的
                  新评论会让角色排队回复，
                  <strong className="text-ink-soft">而那一轮可能顺带发一条短信</strong>
                  —— 半夜被 IG 回复吵醒和被主动消息吵醒是同一件事。
                </span>
              </span>
              <Switch
                checked={Boolean(draft.dnd.enabled)}
                onChange={(v) => setDraft((d) => ({ ...d, dnd: { ...d.dnd, enabled: v } }))}
                label="勿扰时段"
              />
            </label>

            {draft.dnd.enabled ? (
              <div className="grid grid-cols-2 gap-4">
                <Field label="从">
                  <input
                    type="time"
                    className={inputCls}
                    value={draft.dnd.start}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, dnd: { ...d.dnd, start: e.target.value } }))
                    }
                  />
                </Field>
                <Field label="到" hint="跨零点算数">
                  <input
                    type="time"
                    className={inputCls}
                    value={draft.dnd.end}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, dnd: { ...d.dnd, end: e.target.value } }))
                    }
                  />
                </Field>
              </div>
            ) : null}
          </div>

          <AllowList
            value={draft.allowFrom}
            onChange={(next) => setDraft((d) => ({ ...d, allowFrom: next }))}
          />

          <label className="flex items-start justify-between gap-4">
            <span className="min-w-0">
              <span className="block text-ui text-ink">同步你自己的号</span>
              <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                把<strong className="text-ink-soft">你</strong>
                真 IG 上的帖子和快拍拉进本地，角色会像刷到一样去点赞、评论、发短信。
                默认关 —— 开了要额外绑一条大号 token，而且等于把你的真实生活内容喂给模型。
                <br />
                只拉不推：你的本地帖子从来不会发到你的真 IG 上。
                <br />
                <strong className="text-ink-soft">想让角色的评论出现在你的真帖子下</strong>
                ：发帖时在配文里 @ 上它绑的那个用户名（比如 @charlie_ig）。被点名的角色
                不会只点个赞，而且它那句评论会用<strong className="text-ink-soft">它自己的号</strong>
                发到你真帖子下面 —— 这是 Meta 唯一许可的路子（被 @ 的人才能在别人帖子下说话）。
                没 @ 的帖子照旧只在本地评论。快拍不支持，Meta 那边就没开。
              </span>
            </span>
            <Switch
              checked={Boolean(draft.syncUser)}
              onChange={(v) => setDraft((d) => ({ ...d, syncUser: v }))}
              label="同步你自己的号"
            />
          </label>

          <ResultNote state={note.state} message={note.message} />
        </div>
      </Card>

      <Card
        title="立刻同步一次"
        desc="不等间隔到点，现在就跑一遍：该续期的续期 → 拉你的新帖子 → 拉每个角色帖子下的新评论 → 把之前发失败的补一发。勿扰时段也照跑（是你自己点的）。"
        actions={
          <Button onClick={runPoll} disabled={busy}>
            {busy ? "同步中…" : "同步"}
          </Button>
        }
      >
        <div className="grid gap-4">
          <p className="text-meta leading-relaxed text-ink-faint">
            这一下可能要十几秒 —— 每个绑了号的角色都要过一遍网络，还可能过代理。
          </p>
          <ResultNote state={pollNote.state} message={pollNote.message} />

          {data.settings.mentionsBroken ? (
            <div className="border-l-2 border-warn pl-3">
              <p className="text-meta leading-relaxed text-warn">
                角色互评那条路走不通，已经停了。
              </p>
              <p className="mt-1 text-meta leading-relaxed text-ink-faint">
                角色在别人帖子下留言要先被帖主 @ 一次（Meta 的 Mentions 接口），而那个接口的
                文档写在老路线下，我们走的是 Instagram Login —— 没明说支持。停掉是因为失败的
                代价不对称：铺路那条「@某人」
                <strong className="text-ink-soft">已经发出去了</strong>
                ，评论区会留下一句没有下文的 @。留一次像作者叫朋友来看，每轮都留就是噪音。
                <br />
                角色互评现在只走本地，本地那边一切照常。
              </p>
              <div className="mt-3">
                <Button
                  variant="outline"
                  onClick={() => submit({ mentionsBroken: false }, "重置了，下次互评会再试一遍")}
                  disabled={saving}
                >
                  <Undo2 size={13} /> 再试一次
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </Card>
    </>
  );
}

/* ================================================================== */
/* 主页 · 某个人                                                       */
/* ================================================================== */

/**
 * 一格缩略图。
 *
 * 图没生成出来就把当初那句描述当文字显示 —— 生图关着的时候就是这样。
 * **不拿配文兜底**：配文在格子底下已经画了一遍，兜上去就成了同一句话上下各一份。
 */
function Thumb({ image }) {
  const file = image?.file ?? "";
  const alt = String(image?.alt ?? "").trim();
  if (file) return <img src={igMediaUrl(file)} alt={alt} className="h-full w-full object-cover" />;
  return (
    <div className="h-full w-full overflow-hidden p-2 text-[11px] leading-snug text-ink-faint">
      {image ? alt || "图没生成出来" : "没有图"}
    </div>
  );
}

/**
 * 帖子 / 快拍的一格：缩略图 + 配文 + 改和删。
 *
 * 删是**两步**的（先亮出确认再删），和图库那边一个路子 —— 这是控制台的做法，
 * window.confirm 只在 IG 那一页用。
 */
function MediaTile({ image, caption, meta, armed, onArm, onDisarm, onDelete, onEdit, real }) {
  return (
    <div>
      <div className="relative aspect-square overflow-hidden border border-line bg-sunken">
        <Thumb image={image} />
        {armed ? (
          <div className="absolute inset-0 flex items-center justify-center gap-1.5 bg-paper/95">
            <button
              type="button"
              onClick={onDelete}
              aria-label="确认删除"
              className="rounded-item bg-warn p-1.5 text-paper-invert"
            >
              <Trash2 size={14} />
            </button>
            <button
              type="button"
              onClick={onDisarm}
              aria-label="算了"
              className="rounded-item border border-line bg-paper p-1.5 text-ink-faint transition-colors duration-150 hover:text-ink"
            >
              <Undo2 size={14} />
            </button>
          </div>
        ) : (
          <div className="absolute right-0.5 top-0.5 flex gap-1">
            {onEdit ? (
              <button
                type="button"
                onClick={onEdit}
                aria-label="编辑"
                className="rounded-item bg-paper/85 p-1 text-ink-faint transition-colors duration-150 hover:bg-paper hover:text-ink"
              >
                <Pencil size={11} />
              </button>
            ) : null}
            <button
              type="button"
              onClick={onArm}
              aria-label="删除"
              className="rounded-item bg-paper/85 p-1 text-ink-faint transition-colors duration-150 hover:bg-paper hover:text-warn"
            >
              <Trash2 size={11} />
            </button>
          </div>
        )}
      </div>
      {caption ? <p className="mt-1.5 line-clamp-2 text-meta text-ink-soft">{caption}</p> : null}
      {meta ? <p className="mt-0.5 text-meta text-ink-faint">{meta}</p> : null}
      {real}
    </div>
  );
}

/**
 * 一格底下那行真 IG 状态。
 *
 * 三态：发过了（给个 permalink）／上次发失败（把原因摆出来 + 重试）／还没发过
 * （一个「同步到真 IG」按钮）。
 *
 * 「已经发出去了」这一态**没有删除按钮** —— Meta 没有删除帖子的接口，画一个
 * 点了没用的按钮比不画更糟。文案里直说要去手机上删。
 */
function RealTile({ owner, item, isStory, onDone }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const remote = item?.remote ?? {};

  const push = async () => {
    setBusy(true);
    setNote("");
    try {
      const r = await igApi.publishReal(owner, item.id, isStory);
      if (r.ok) onDone?.();
      // 失败的原因是后端给的中文（「图床还没配」这种），原样显示
      else setNote(r.error || "没发出去");
    } catch (e) {
      setNote(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  if (remote.mediaId) {
    return (
      <p className="mt-1 text-meta text-good">
        已发到真 IG
        {remote.permalink ? (
          <a
            href={remote.permalink}
            target="_blank"
            rel="noreferrer"
            className="ml-1 text-ink-faint underline decoration-line underline-offset-2 hover:text-ink"
          >
            去看看
          </a>
        ) : null}
      </p>
    );
  }

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={push}
        disabled={busy}
        className="text-meta text-ink-faint underline decoration-line underline-offset-2 transition-colors duration-150 hover:text-ink disabled:opacity-40"
      >
        {busy ? "正在发…" : remote.error ? "再发一次" : "同步到真 IG"}
      </button>
      {note || remote.error ? (
        <p className="mt-0.5 break-words text-meta text-warn">{note || remote.error}</p>
      ) : null}
    </div>
  );
}

/** 九宫格的外壳。空的时候说一句人话。 */
function TileGrid({ children, empty }) {
  const list = Array.isArray(children) ? children.filter(Boolean) : children;
  if (!list || (Array.isArray(list) && !list.length)) {
    return <p className="text-meta text-ink-faint">{empty}</p>;
  }
  return <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">{list}</div>;
}

/** 主页顶上那一条：头像 + 名字 + 账号 + 三个计数。 */
function ProfileHead({ data }) {
  const src = avatarUrl(data.avatar);
  const p = data.profile ?? {};
  const counts = [
    [p.posts || String(data.realPosts ?? 0), "帖子"],
    [p.followers || "0", "粉丝"],
    [p.following || "0", "关注"],
  ];

  return (
    <div className="flex flex-wrap items-center gap-6">
      <div className="h-20 w-20 shrink-0 overflow-hidden rounded-full border border-line bg-sunken">
        {src ? <img src={src} alt="" className="h-full w-full object-cover" /> : null}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-h3 text-ink">
          {data.displayName}
          {p.verified ? <span className="ml-1.5 text-meta text-ink-faint">· 已认证</span> : null}
        </div>
        <div className="mt-0.5 text-meta text-ink-faint">@{data.username}</div>
        <div className="mt-3 flex gap-6">
          {counts.map(([n, label]) => (
            <span key={label} className="text-meta text-ink-soft">
              <b className="text-ink">{n}</b> {label}
            </span>
          ))}
        </div>
        {p.bio ? <p className="mt-3 whitespace-pre-wrap text-ui text-ink-soft">{p.bio}</p> : null}
        {p.link ? <p className="mt-1 text-meta text-ink-faint">{p.link}</p> : null}
      </div>
    </div>
  );
}

/**
 * 某个人的主页：资料、帖子、快拍、精选，全在这一页管。
 *
 * `owner` 是 IG 那边的标识 —— 用户是固定的 "user"，角色是**角色名**
 * （不是 id，见 server/src/instagram.js:igOwners）。
 */
function OwnerPage({ owner, label, isUser }) {
  const { data, loading, error, reload } = useProfile(owner);
  /*
   * 真 IG 的状态：只拿来决定每一格底下要不要画那行「同步到真 IG」。
   *
   * 三样齐了才画（和后端 realGate 同一个条件）：这个角色开了同步、绑了真号、
   * 图床配好了。缺一样就不画 —— 画一个点了必然失败的按钮不如不画。
   * 你自己的主页永远不画：我们没有你大号的写权限，而且替你发东西不合理。
   */
  const { data: real } = useRealIg();
  const realOn = useMemo(() => {
    if (isUser || !real?.settings?.imageHost?.configured) return false;
    const acc = (real.accounts ?? []).find((a) => a.roleName === owner);
    return Boolean(acc?.syncReal && acc?.bound);
  }, [isUser, real, owner]);
  const [editProfile, setEditProfile] = useState(false);
  const [composer, setComposer] = useState(null); // { kind, post }
  const [highlight, setHighlight] = useState(null); // { value } —— value 为 null 就是新建
  const [armed, setArmed] = useState("");
  const [note, setNote] = useState({ state: "idle", message: "" });

  // 换人时把本地那几个状态清干净，不然从 A 的主页跳到 B 会带着 A 的弹层
  useEffect(() => {
    setEditProfile(false);
    setComposer(null);
    setHighlight(null);
    setArmed("");
    setNote({ state: "idle", message: "" });
  }, [owner]);

  const refresh = () => {
    setArmed("");
    setNote({ state: "idle", message: "" });
    reload();
  };

  /** 删东西：成功就刷新，失败把后端那句话摆出来（精选满三个时就是 409）。 */
  const run = async (fn) => {
    try {
      await fn();
      refresh();
    } catch (e) {
      setNote({ state: "fail", message: String(e?.message ?? e) });
    }
  };

  if (loading && !data) return <Card title={label}>正在读…</Card>;
  if (error) {
    return (
      <Card title={label}>
        <ResultNote state="fail" message={error} icon={CircleAlert} />
      </Card>
    );
  }
  if (!data) return null;

  // 「替 Aki 发一条」，但自己的主页上说「替自己发」很别扭 —— 那就是你自己在发
  const addLabel = isUser ? "发一条" : `替 ${label} 发一条`;
  const stories = [...(data.active ?? []), ...(data.expired ?? [])];
  const full = (data.highlights ?? []).length >= (data.maxHighlights ?? 3);

  return (
    <>
      <Card
        title={isUser ? "你的主页" : `${label} 的主页`}
        desc="名字、账号、头像、三个计数、简介、链接 —— 这些只影响 Instagram 页上显示的样子，不改角色本身。"
        actions={
          <Button variant="outline" onClick={() => setEditProfile(true)}>
            <Pencil size={13} /> 编辑主页
          </Button>
        }
      >
        <ProfileHead data={data} />
        <div className="mt-6">
          <ResultNote state={note.state} message={note.message} icon={CircleAlert} />
        </div>
      </Card>

      <Card
        title="帖子"
        desc={
          isUser
            ? "你自己的帖子。在 Instagram 页上发也是一样的，这边多了改配文和换图。"
            : "替它发一条，或者改已经发出去的。发出去的帖子会进它的上下文，模型下一轮就知道自己发过什么。"
        }
        actions={
          <Button variant="outline" onClick={() => setComposer({ kind: "post" })}>
            <Plus size={13} /> {addLabel}
          </Button>
        }
      >
        <TileGrid empty="还没有帖子。">
          {(data.posts ?? []).map((post) => (
            <MediaTile
              key={post.id}
              image={post.images?.[0]}
              caption={post.caption}
              meta={[
                timeAgo(post.createdAt),
                `${(post.likes ?? []).length} 赞`,
                `${(post.comments ?? []).length} 评论`,
                (post.images ?? []).length > 1 ? `${post.images.length} 张` : "",
              ]
                .filter(Boolean)
                .join(" · ")}
              armed={armed === `post:${post.id}`}
              onArm={() => setArmed(`post:${post.id}`)}
              onDisarm={() => setArmed("")}
              onEdit={() => setComposer({ kind: "post", post })}
              onDelete={() => run(() => igApi.deletePost(owner, post.id))}
              real={
                realOn ? (
                  <RealTile owner={owner} item={post} isStory={false} onDone={refresh} />
                ) : null
              }
            />
          ))}
        </TileGrid>
      </Card>

      <Card
        title="快拍"
        desc={`过了 ${data.storyHours} 小时就算过期，从首页的快拍圈里消失、落到下面那一栏。想留住就收进精选。`}
        actions={
          <Button variant="outline" onClick={() => setComposer({ kind: "story" })}>
            <Plus size={13} /> {addLabel}
          </Button>
        }
      >
        <div className="grid gap-8">
          <div>
            <Eyebrow>还在的</Eyebrow>
            <div className="mt-4">
              <TileGrid empty="现在没有活着的快拍。">
                {(data.active ?? []).map((s) => (
                  <MediaTile
                    key={s.id}
                    image={s.image}
                    caption={s.caption}
                    meta={timeAgo(s.createdAt)}
                    armed={armed === `story:${s.id}`}
                    onArm={() => setArmed(`story:${s.id}`)}
                    onDisarm={() => setArmed("")}
                    onEdit={() => setComposer({ kind: "story", post: s })}
                    onDelete={() => run(() => igApi.deleteStory(owner, s.id))}
                    real={
                      realOn ? (
                        <RealTile owner={owner} item={s} isStory onDone={refresh} />
                      ) : null
                    }
                  />
                ))}
              </TileGrid>
            </div>
          </div>

          <div>
            <Eyebrow>已经过期的</Eyebrow>
            <div className="mt-4">
              <TileGrid empty="还没有过期的快拍。">
                {(data.expired ?? []).map((s) => (
                  <MediaTile
                    key={s.id}
                    image={s.image}
                    caption={s.caption}
                    meta={timeAgo(s.createdAt)}
                    armed={armed === `story:${s.id}`}
                    onArm={() => setArmed(`story:${s.id}`)}
                    onDisarm={() => setArmed("")}
                    onEdit={() => setComposer({ kind: "story", post: s })}
                    onDelete={() => run(() => igApi.deleteStory(owner, s.id))}
                    /*
                     * 过期的快拍只显示「发过了」那一态，不给补发按钮 ——
                     * 本地已经过期的东西补发到真 IG 会变成一条崭新的 24 小时快拍，
                     * 那和用户看到的「这条已经过去了」正好相反。
                     */
                    real={
                      realOn && s.remote?.mediaId ? (
                        <RealTile owner={owner} item={s} isStory onDone={refresh} />
                      ) : null
                    }
                  />
                ))}
              </TileGrid>
            </div>
          </div>
        </div>
      </Card>

      <Card
        title="精选快拍"
        desc={`封面和标题由你自己定，不会自动取第一张图。最多 ${data.maxHighlights ?? 3} 组 —— 手机上主页那一排放不下第四个，也不滚动。`}
        actions={
          <Button variant="outline" onClick={() => setHighlight({ value: null })} disabled={full}>
            <Plus size={13} /> {full ? "已经满了" : "新建一组"}
          </Button>
        }
      >
        {(data.highlights ?? []).length ? (
          <div className="flex flex-wrap gap-8">
            {data.highlights.map((h) => (
              <div key={h.id} className="w-24">
                <div className="relative">
                  <div className="h-24 w-24 overflow-hidden rounded-full border border-line bg-sunken">
                    {h.cover ? (
                      <img src={igMediaUrl(h.cover)} alt="" className="h-full w-full object-cover" />
                    ) : null}
                  </div>
                  {armed === `hl:${h.id}` ? (
                    <div className="absolute inset-0 flex items-center justify-center gap-1.5 rounded-full bg-paper/95">
                      <button
                        type="button"
                        onClick={() => run(() => igApi.deleteHighlight(owner, h.id))}
                        aria-label="确认删除"
                        className="rounded-item bg-warn p-1.5 text-paper-invert"
                      >
                        <Trash2 size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setArmed("")}
                        aria-label="算了"
                        className="rounded-item border border-line bg-paper p-1.5 text-ink-faint transition-colors duration-150 hover:text-ink"
                      >
                        <Undo2 size={14} />
                      </button>
                    </div>
                  ) : null}
                </div>
                <div className="mt-2 truncate text-center text-meta text-ink">{h.title}</div>
                <div className="mt-0.5 text-center text-meta text-ink-faint">
                  {(h.stories ?? []).length} 条
                </div>
                <div className="mt-1.5 flex justify-center gap-3">
                  <button
                    type="button"
                    onClick={() => setHighlight({ value: h })}
                    className="text-meta text-ink-soft transition-colors duration-150 hover:text-ink"
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    onClick={() => setArmed(`hl:${h.id}`)}
                    className="text-meta text-ink-faint transition-colors duration-150 hover:text-warn"
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-meta text-ink-faint">
            还没有精选。先发几条快拍，过期之后收进来就不会没了。
          </p>
        )}
      </Card>

      {editProfile ? (
        <ProfileEditor
          owner={owner}
          profile={data.profile ?? {}}
          realPosts={data.realPosts}
          onClose={() => setEditProfile(false)}
          onSaved={refresh}
        />
      ) : null}

      {composer ? (
        <PostEditor
          owner={owner}
          kind={composer.kind}
          post={composer.post ?? null}
          onClose={() => setComposer(null)}
          onSaved={refresh}
        />
      ) : null}

      {highlight ? (
        <HighlightEditor
          owner={owner}
          stories={stories}
          highlight={highlight.value}
          onClose={() => setHighlight(null)}
          onSaved={refresh}
        />
      ) : null}
    </>
  );
}

/* ================================================================== */
/* 没选东西的时候                                                      */
/* ================================================================== */

function Overview({ onGoto, hasRoles }) {
  const { pick } = useSection();

  return (
    <>
      <IgPageCard />

      <Card title="这一页管什么" desc="左边挑一个进去。">
        <div className="grid gap-5">
          <div>
            <button
              type="button"
              onClick={() => pick("settings")}
              className="text-ui text-ink underline decoration-line underline-offset-4 transition-colors duration-150 hover:decoration-ink"
            >
              总设置 · 全局
            </button>
            <p className="mt-1 text-meta text-ink-faint">快拍存活多久、Instagram 页默认按哪套版式画。</p>
          </div>
          <div>
            <button
              type="button"
              onClick={() => pick("prompts")}
              className="text-ui text-ink underline decoration-line underline-offset-4 transition-colors duration-150 hover:decoration-ink"
            >
              总设置 · 提示词
            </button>
            <p className="mt-1 text-meta text-ink-faint">
              角色去评论那一轮怎么拼：八条模板，场景在最顶上，行动指令在最底下。
            </p>
          </div>
          <div>
            <button
              type="button"
              onClick={() => pick("real")}
              className="text-ui text-ink underline decoration-line underline-offset-4 transition-colors duration-150 hover:decoration-ink"
            >
              总设置 · 真实账号
            </button>
            <p className="mt-1 text-meta text-ink-faint">
              把角色发的东西真的发到一个 Instagram 账号上：绑 token、配图床、调收信节奏。
              默认全关，本地那套不受影响。
            </p>
          </div>
          <div>
            <button
              type="button"
              onClick={() => pick("user")}
              className="text-ui text-ink underline decoration-line underline-offset-4 transition-colors duration-150 hover:decoration-ink"
            >
              主页 · 你
            </button>
            <p className="mt-1 text-meta text-ink-faint">
              你自己的资料、帖子、快拍、精选。每个开了 Instagram 的角色也各有一页。
            </p>
          </div>
        </div>

        {hasRoles ? null : (
          <p className="mt-8 text-meta text-ink-faint">
            现在一个角色都没开 Instagram。开关在
            <button
              type="button"
              onClick={() => onGoto?.("role")}
              className="mx-1 text-ink underline decoration-line underline-offset-4 transition-colors duration-150 hover:decoration-ink"
            >
              角色 → 单独配置 → Instagram
            </button>
            ，默认是关的。
          </p>
        )}
      </Card>
    </>
  );
}

/* ================================================================== */

export function InstagramPanel({ onGoto }) {
  const { itemId } = useSection();
  const { config } = useConfig();

  /*
   * 侧栏那一栏给的是角色 **id**，IG 那边认的是角色**名**（igOwners 定的，
   * 因为提示词里出现的、评论列表里显示的都是名字）。这里翻一道。
   */
  const target = useMemo(() => {
    if (itemId === "user") return { owner: "user", label: "你", isUser: true };
    const role = (config.roles ?? []).find((r) => String(r.id) === String(itemId));
    if (!role) return null;
    return { owner: String(role.name ?? "").trim(), label: roleLabel(role), isUser: false };
  }, [itemId, config.roles]);

  if (itemId === "settings") return <GlobalSettings />;
  if (itemId === "prompts") return <PromptSettings />;
  if (itemId === "real") return <RealSettings onGoto={onGoto} />;

  if (target) {
    // 名字是空的：IG 那边拿名字当标识，没名字就没有能寻址的主页
    if (!target.owner) {
      return (
        <Card title="这个角色还没起名字">
          <p className="text-ui text-ink-soft">
            Instagram 那边拿角色名当账号用，名字空着就开不出主页。
            <span className="mt-1 block text-meta text-ink-faint">
              去「角色」那一页给它填个名字，这里就有了。
            </span>
          </p>
        </Card>
      );
    }
    return <OwnerPage owner={target.owner} label={target.label} isUser={target.isUser} />;
  }

  return (
    <Overview
      onGoto={onGoto}
      hasRoles={(config.roles ?? []).some((r) => r.instagram?.enabled)}
    />
  );
}
