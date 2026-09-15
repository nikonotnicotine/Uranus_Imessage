/**
 * 「快速配置」引导向导。
 *
 * 新用户第一次进来会自动弹出，Uranus 用问答的方式把一整套配置带着走一遍 ——
 * 服务商源、Photon 线路、角色、人设、上下文、时间、天气、功能开关、发送节奏。
 *
 * 三条硬规矩：
 *  1. 随时能关。关掉之后右上角的「快速配置」按钮永远能点回来，从上次那步继续。
 *  2. 每一步都能回上一步，也能跳过 —— 跳过只是不配，不会写坏已有的值。
 *  3. 全程只改本地草稿，最后一步才 save()。中途关掉不落盘，草稿留在内存里，
 *     用户自己去面板改也不会跟向导打架。
 *
 * 「弹过没有」记在 localStorage 而不是 config：它是这台机器上这个浏览器的
 * 一次性状态，不该跟着 data.config.json 走（备份、云同步都会带上它，
 * 换台机器恢复配置反而不弹了，那就失去意义了）。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bell,
  Brain,
  Check,
  CheckCircle2,
  Clock,
  CloudSun,
  Compass,
  ExternalLink,
  Lock,
  MessageSquareText,
  PartyPopper,
  Rocket,
  Search,
  ShieldCheck,
  SkipForward,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  UserRound,
  Users,
  Wand2,
} from "lucide-react";

import { DEFAULT_QQ_GROUP, DOC_URL } from "../assistant-help.js";
import { useConfig } from "../store.jsx";
import {
  Button,
  CodeBlock,
  Field,
  GroupLabel,
  Modal,
  NumberField,
  Slider,
  Switch,
  UranusBadge,
  inputCls,
} from "../ui.jsx";
import { SecretInput } from "./api.jsx";
import { EnrollBox, GUIDE_STEPS, ManualLineBox, TERMINAL_CMDS } from "./imessage.jsx";
import { ModelSelect, usePresetGate } from "./role.jsx";

/** localStorage 的键。带版本号：以后向导大改可以换个键重新弹一次。 */
const SEEN_KEY = "uranus.setup.seen.v1";

function markSeen() {
  try {
    window.localStorage.setItem(SEEN_KEY, "1");
  } catch {
    // 隐身模式 / 禁了存储：那就每次都弹，比崩掉好
  }
}

function hasSeen() {
  try {
    return window.localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return true; // 读不到就当看过，别在无法记状态的环境里反复骚扰
  }
}

/**
 * 这份配置「像是新用户的」吗？
 *
 * 只看两件事：有没有配过服务商源、有没有角色填了名字。种子预设是我们随包给的，
 * 不算用户配的，所以不看 presets。
 */
function looksFresh(config) {
  if (!config) return false;
  const hasProvider = (config.providers ?? []).some((p) => (p.url ?? "").trim());
  const hasRole = (config.roles ?? []).some((r) => (r.name ?? "").trim());
  return !hasProvider && !hasRole;
}

/* ---------- 版面小件 ---------- */

/** Uranus 说的话。头像 + 一段话，向导里每一步都以这个开头。 */
function Says({ children, size = 52 }) {
  return (
    <div className="flex items-start gap-4">
      <div className="shrink-0">
        <UranusBadge size={size} />
      </div>
      <div className="min-w-0 flex-1 space-y-3 text-body leading-relaxed text-ink">{children}</div>
    </div>
  );
}

/** 灰底提示条。用在「这一步为什么存在」「这一步跳过会怎样」这类补充说明上。 */
function Note({ children, icon: Icon = null }) {
  return (
    <p className="flex items-start gap-2 border-l-2 border-line py-1.5 pl-3 text-meta leading-relaxed text-ink-soft">
      {Icon && <Icon size={15} className="mt-0.5 shrink-0 text-ink-faint" />}
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/**
 * 一道二选一。向导里所有「你希望…吗」都长这样 ——
 * 比 Switch 更适合问答语气，选完还能看出自己选了哪个。
 */
function Choice({ options, value, onPick }) {
  return (
    <div className="grid grid-cols-1 gap-2">
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onPick(o.value)}
            className={`flex items-start gap-3 rounded-item border p-4 text-left transition-colors duration-150 ${
              active
                ? "border-ink bg-sunken"
                : "border-line bg-paper hover:border-ink-faint hover:bg-sunken"
            }`}
          >
            <span
              className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border ${
                active ? "border-ink bg-ink text-paper" : "border-line"
              }`}
            >
              {active && <Check size={11} strokeWidth={3} />}
            </span>
            <span className="min-w-0">
              <span className="block text-ui text-ink">{o.label}</span>
              {o.desc && (
                <span className="mt-1 block text-meta leading-relaxed text-ink-faint">{o.desc}</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** 一排开关。功能开关那几步用它，一屏能过完十几个。 */
function SwitchRow({ label, desc, checked, onChange }) {
  return (
    <label className="flex items-start justify-between gap-4 py-1">
      <span className="min-w-0">
        <span className="block text-ui text-ink">{label}</span>
        {desc && <span className="mt-1 block text-meta leading-relaxed text-ink-faint">{desc}</span>}
      </span>
      <Switch checked={checked} onChange={onChange} label={label} />
    </label>
  );
}

/* ---------- 各步的内容 ---------- */

function StepWelcome() {
  return (
    <div className="space-y-6">
      <Says size={96}>
        <p>你好，我是 Uranus ՞˶˃ ᵕ ˂˶՞</p>
        <p>
          这个小手机要跑起来，需要配几样东西：一条能发 iMessage 的线路、一个会说话的模型、
          还有一个你想聊的角色。听着有点多，但我会一步步问你，你只要回答就好 ⌯'ᵕ'⌯
        </p>
        <p>每一步都能回退，也能跳过 —— 现在不想配的，以后从右上角点回来接着弄。</p>
      </Says>

      <div className="rounded-item border border-good/30 bg-goodsoft p-4">
        <p className="flex items-start gap-2 text-ui leading-relaxed text-ink">
          <Lock size={16} className="mt-0.5 shrink-0 text-good" />
          <span className="min-w-0">
            <strong className="font-medium">所有配置都不会上传，只会保留在本地。</strong>
            <span className="mt-1.5 block text-meta leading-relaxed text-ink-soft">
              密钥、手机号、角色设定全部写进你自己电脑上的 data.config.json，
              这个文件已经在 .gitignore 里，不会进 GitHub，也不会发给我们。
            </span>
          </span>
        </p>
      </div>

      {/* 想看图的先给链接 —— 有些人跟着截图走比跟着问答走顺 */}
      <Note icon={ExternalLink}>
        想要更详细的图文教程，看{" "}
        <a href={DOC_URL} target="_blank" rel="noreferrer" className="link-slide text-ink">
          Niki 写的那份
        </a>
        ，有图、有分步演示。
      </Note>
    </div>
  );
}

function StepLevel({ level, setLevel }) {
  return (
    <div className="space-y-6">
      <Says>
        <p>先问一个问题，好决定后面要不要啰嗦 ₍ᐢ.ˬ.ᐢ₎</p>
        <p className="text-ui text-ink-soft">你对这类工具熟吗？</p>
      </Says>
      <Choice
        value={level}
        onPick={setLevel}
        options={[
          {
            value: "guided",
            label: "A · 我需要引导配置",
            desc: "会以问答的形式帮你把所有设置配好，推荐酒馆 / 小手机用户",
          },
          {
            value: "skip",
            label: "B · 无需配置，直接进入",
            desc: "自己去各个面板配。右上角随时能把我叫回来",
          },
        ]}
      />
    </div>
  );
}

function StepPhoton({ project, onEnrolled }) {
  const { updateProject } = useConfig();
  const [os, setOs] = useState(() =>
    typeof navigator !== "undefined" && /Mac/i.test(navigator.platform ?? "")
      ? "mac"
      : typeof navigator !== "undefined" && /Win/i.test(navigator.platform ?? "")
      ? "windows"
      : "linux"
  );
  const cmd = TERMINAL_CMDS.find((c) => c.id === os) ?? TERMINAL_CMDS[0];
  const ready = (project?.projectId ?? "").trim() && (project?.projectSecret ?? "").trim();

  return (
    <div className="space-y-6">
      <Says>
        <p>
          第一件事是 Photon。它替你连上 iMessage —— 你的角色发出去的消息，
          走的就是 Photon 给的那条线路。
        </p>
        <p className="text-ui text-ink-soft">
          跟着下面五步走一遍，把两个值填进来就行 ദ്ദി˶&gt;ᴗo)✧
        </p>
      </Says>

      <div className="space-y-3">
        {GUIDE_STEPS.map((s, i) => (
          <div key={s.title} className="flex items-start gap-3">
            <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-line text-meta text-ink-faint">
              {i + 1}
            </span>
            <div className="min-w-0">
              <p className="text-ui text-ink">{s.title}</p>
              <p className="mt-1 text-meta leading-relaxed text-ink-soft">{s.body}</p>
              {s.link && (
                <a
                  href={s.link}
                  target="_blank"
                  rel="noreferrer"
                  className="link-slide mt-1.5 inline-flex items-center gap-1.5 text-meta text-ink"
                >
                  {s.linkLabel ?? s.link} <ExternalLink size={12} />
                </a>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 border-t border-line pt-6">
        <Field label="Project ID" hint="Photon 项目 ID">
          <input
            className={inputCls}
            value={project?.projectId ?? ""}
            onChange={(e) => updateProject(project.id, { projectId: e.target.value })}
            placeholder="pur_… 或项目 id"
          />
        </Field>
        <Field label="Project Secret" hint="只会完整显示一次，当场存好">
          <SecretInput
            value={project?.projectSecret ?? ""}
            onChange={(v) => updateProject(project.id, { projectSecret: v })}
            placeholder="photon 项目密钥"
          />
        </Field>
      </div>

      {ready ? (
        <div className="border-t border-line pt-6">
          <GroupLabel>登记手机号，拿到你的线路号码</GroupLabel>
          <p className="mb-4 mt-2 text-meta leading-relaxed text-ink-soft">
            填你自己的手机号（带国家码）。Photon 会分配一个线路号码给这个项目 ——
            以后你就在 iMessage 里跟那个号码聊天。
          </p>
          <EnrollBox project={project} onDone={onEnrolled} />

          <details className="mt-6">
            <summary className="cursor-pointer text-meta text-ink-soft hover:text-ink">
              上面那步失败了？用终端手动登记
            </summary>
            <div className="mt-4 space-y-4">
              <div className="flex items-center gap-2">
                {TERMINAL_CMDS.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setOs(c.id)}
                    className={`rounded-item border px-3 py-1.5 text-meta transition-colors duration-150 ${
                      os === c.id
                        ? "border-ink bg-sunken text-ink"
                        : "border-line text-ink-faint hover:text-ink"
                    }`}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
              <p className="text-meta leading-relaxed text-ink-faint">{cmd.hint}</p>
              <CodeBlock code={cmd.code} />
              <p className="text-meta leading-relaxed text-ink-soft">
                跑完会打印一个号码，把它填到下面。
              </p>
              <ManualLineBox project={project} />
            </div>
          </details>
        </div>
      ) : (
        <Note icon={ShieldCheck}>
          两个值都填好之后，这里会出现「登记手机号」—— 那一步会把号码存进本地配置，
          凭据不会离开这台电脑。
        </Note>
      )}
    </div>
  );
}

function StepProvider({ provider }) {
  const { updateProvider, updateProviderKey, addModels, config } = useConfig();
  const [names, setNames] = useState("");
  const models = provider?.models ?? [];

  const add = () => {
    const list = names
      .split(/[\n,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!list.length) return;
    addModels(provider.id, list, ["chat"]);
    setNames("");
  };

  return (
    <div className="space-y-6">
      <Says>
        <p>接下来是模型 —— 你的角色靠它想事情、说话。</p>
        <p className="text-ui text-ink-soft">
          填一个 OpenAI 兼容的接口地址和密钥就行。中转站、官方、自己搭的都可以。
        </p>
      </Says>

      <div className="grid grid-cols-1 gap-6">
        <Field label="显示名" hint="随便起，只是给你自己看的">
          <input
            className={inputCls}
            value={provider?.name ?? ""}
            onChange={(e) => updateProvider(provider.id, { name: e.target.value })}
            placeholder="例如：我的中转站"
          />
        </Field>
        <Field label="API Base URL" hint="OpenAI 兼容，填到 /v1">
          <input
            className={inputCls}
            value={provider?.url ?? ""}
            onChange={(e) => updateProvider(provider.id, { url: e.target.value })}
            placeholder="https://api.openai.com/v1"
          />
        </Field>
        <Field label="API Key" hint="只写进本地配置文件">
          <SecretInput
            value={(provider?.keys ?? [""])[0] ?? ""}
            onChange={(v) => updateProviderKey(provider.id, 0, v)}
            placeholder="sk-…"
          />
        </Field>
      </div>

      <div className="border-t border-line pt-6">
        <GroupLabel>有哪些模型可以用</GroupLabel>
        <p className="mb-4 mt-2 text-meta leading-relaxed text-ink-soft">
          填模型名，一行一个（或者用逗号隔开）。加进来的会自动标成「聊天」分类，
          下一步选角色模型时就能挑到。
        </p>
        <textarea
          className={`${inputCls} min-h-[90px] resize-y font-mono leading-relaxed`}
          value={names}
          onChange={(e) => setNames(e.target.value)}
          placeholder={"gemini-2.5-pro\nclaude-sonnet-4-5\ngpt-4o"}
        />
        <div className="mt-3 flex items-center gap-3">
          <Button variant="outline" onClick={add} disabled={!names.trim()}>
            <Wand2 size={14} /> 加进来
          </Button>
          {models.length > 0 && (
            <span className="text-meta text-ink-faint">已有 {models.length} 个模型</span>
          )}
        </div>
        {models.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {models.map((m) => (
              <span
                key={m.id}
                className="rounded-item border border-line px-2.5 py-1 font-mono text-meta text-ink-soft"
              >
                {m.model}
              </span>
            ))}
          </div>
        )}
        <Note>
          不确定接口支持哪些模型名？先随便填一个能用的，之后在「连接」面板里有
          「拉取模型列表」可以自动列出来。
        </Note>
      </div>
    </div>
  );
}

function StepRole({ role }) {
  const { updateRole } = useConfig();
  const patch = (p) => updateRole(role.id, p);

  return (
    <div className="space-y-6">
      <Says>
        <p>现在来造你的角色 ♡ &gt;𖥦&lt;</p>
        <p className="text-ui text-ink-soft">
          名字、用哪个模型、以及最重要的 —— 它是个什么样的人。
        </p>
      </Says>

      <div className="grid grid-cols-1 gap-6">
        <Field label="角色名称" hint="也是提示词里 {{char}} 的值">
          <input
            className={inputCls}
            value={role?.name ?? ""}
            onChange={(e) => patch({ name: e.target.value })}
            placeholder="例如：小林"
          />
        </Field>
        <Field label="模型" hint="上一步加进来的「聊天」模型会出现在这里">
          <ModelSelect
            category="chat"
            value={role?.chatModel}
            onChange={(ref) => patch({ chatModel: { ...(role?.chatModel ?? {}), ...ref } })}
          />
        </Field>
        <Field
          label="角色提示词"
          hint="性格、说话风格、背景。这段会原样注入 <Character> 标签"
        >
          <textarea
            className={`${inputCls} min-h-[200px] resize-y leading-relaxed`}
            value={role?.description ?? ""}
            onChange={(e) => patch({ description: e.target.value })}
            placeholder="描述角色的性格、说话风格、背景知识…"
          />
        </Field>
      </div>

      <Note icon={Sparkles}>
        写不出来也没关系，先填个名字往下走。之后在「角色」面板里慢慢改，
        那边还有变量提示告诉你能用哪些占位符。
      </Note>
    </div>
  );
}

function StepUser({ user }) {
  const { updateUser } = useConfig();

  return (
    <div className="space-y-6">
      <Says>
        <p>那你呢 ⌯&gt;𖥦&lt;⌯</p>
        <p className="text-ui text-ink-soft">
          告诉角色你是谁 —— 它会知道该怎么称呼你、你们是什么关系。
        </p>
      </Says>

      <div className="grid grid-cols-1 gap-6">
        <Field label="你的名字" hint="提示词里 {{user}} 的值">
          <input
            className={inputCls}
            value={user?.name ?? ""}
            onChange={(e) => updateUser(user.id, { name: e.target.value })}
            placeholder="例如：阿秋"
          />
        </Field>
        <Field label="你的人设" hint="可留空。写了的话角色会知道你的身份、习惯、你们怎么认识的">
          <textarea
            className={`${inputCls} min-h-[140px] resize-y leading-relaxed`}
            value={user?.description ?? ""}
            onChange={(e) => updateUser(user.id, { description: e.target.value })}
            placeholder="例如：大学生，住上海，作息很乱，和{{char}}是网上认识的…"
          />
        </Field>
      </div>

      <Note icon={Users}>这条人设默认对所有角色生效。以后想按角色分开，去「我」面板改生效范围。</Note>
    </div>
  );
}

function StepContext({ role }) {
  const { updateRole } = useConfig();
  const patch = (p) => updateRole(role.id, p);
  const max = role?.maxContext ?? 20;

  return (
    <div className="space-y-6">
      <Says>
        <p>你希望 {role?.name?.trim() || "{{char}}"} 能记住多少条上文？</p>
        <p className="text-ui text-ink-soft">
          带得多，它对之前聊的事记得清；带得少，每次请求便宜也快一些。20 条是个稳妥的起点。
        </p>
      </Says>

      <div className="grid grid-cols-1 gap-6">
        <NumberField
          label="上下文条数"
          value={max}
          min={1}
          max={100}
          step={1}
          onChange={(v) => patch({ maxContext: v })}
          hint="每次发给模型的上文数"
          suffix="条"
        />
        <NumberField
          label="到达上限后丢弃"
          value={role?.dropCount ?? 1}
          min={1}
          max={max}
          step={1}
          onChange={(v) => patch({ dropCount: v })}
          hint="丢弃最旧的 N 条"
          suffix="条"
        />
        <Field label="说什么语言" hint="留空就是中文">
          <input
            className={inputCls}
            value={role?.language ?? ""}
            onChange={(e) => patch({ language: e.target.value })}
            placeholder="中文"
          />
        </Field>
      </div>

      <Note icon={Brain}>
        聊得久了上文会被丢掉，这是正常的。想让它长期记住一些事，
        后面还有「记忆库」那一步。
      </Note>
    </div>
  );
}

function StepTime({ role }) {
  const { updateRole } = useConfig();
  const env = role?.env ?? {};
  const time = env.time ?? {};
  const patchTime = (p) => updateRole(role.id, { env: { ...env, time: { ...time, ...p } } });
  const on = time.enabled !== false;
  const mode = time.mode === "apart" ? "apart" : "same";

  return (
    <div className="space-y-6">
      <Says>
        <p>你希望 {role?.name?.trim() || "{{char}}"} 知道现在几点吗？</p>
        <p className="text-ui text-ink-soft">
          知道的话，它就不会在你凌晨三点发消息时说「早上好」，也能自己判断该不该在上班时间回你。
        </p>
      </Says>

      <Choice
        value={on ? "yes" : "no"}
        onPick={(v) => patchTime({ enabled: v === "yes" })}
        options={[
          { value: "yes", label: "希望它知道时间", desc: "每轮会告诉它当前日期、时间、星期" },
          { value: "no", label: "不用", desc: "它对时间没有概念" },
        ]}
      />

      {on && (
        <div className="space-y-6 border-t border-line pt-6">
          <p className="text-ui text-ink">那你们在同一个地方吗？</p>
          <Choice
            value={mode}
            onPick={(v) => patchTime({ mode: v })}
            options={[
              { value: "same", label: "在同一个城市", desc: "共用一个时间，填一个城市就行" },
              {
                value: "apart",
                label: "异地",
                desc: "各自算各自的当地时间 —— 它会知道「你那边现在是深夜」",
              },
            ]}
          />

          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            <Field label="你所在的城市" hint="中英文都认，用来算时区">
              <input
                className={inputCls}
                value={time.userCity ?? ""}
                onChange={(e) => patchTime({ userCity: e.target.value })}
                placeholder="例如：上海"
              />
            </Field>
            {mode === "apart" && (
              <Field label={`${role?.name?.trim() || "角色"}所在的城市`} hint="它的当地时间按这个算">
                <input
                  className={inputCls}
                  value={time.charCity ?? ""}
                  onChange={(e) => patchTime({ charCity: e.target.value })}
                  placeholder="例如：东京"
                />
              </Field>
            )}
          </div>

          <SwitchRow
            label="告诉它今天是工作日还是休息日"
            desc="它就知道该不该问你「今天上班吗」"
            checked={time.workday !== false}
            onChange={(v) => patchTime({ workday: v })}
          />
        </div>
      )}
    </div>
  );
}

function StepWeather({ role }) {
  const { config, savedConfig, updateRole, updateWeatherApi } = useConfig();
  const env = role?.env ?? {};
  const weather = env.weather ?? {};
  const apiCfg = weather.api ?? {};
  const qw = apiCfg.qweather ?? {};
  const wa = apiCfg.weatherapi ?? {};
  const keys = config?.weatherApi ?? {};
  const qwKeys = keys.qweather ?? {};
  const waKeys = keys.weatherapi ?? {};

  const patchWeather = (p) =>
    updateRole(role.id, { env: { ...env, weather: { ...weather, ...p } } });
  const patchApi = (p) => patchWeather({ api: { ...apiCfg, ...p } });

  const on = Boolean(weather.enabled);
  const city = (env.time ?? {}).userCity ?? "";

  return (
    <div className="space-y-6">
      <Says>
        <p>要让它知道你那边的天气吗？</p>
        <p className="text-ui text-ink-soft">
          下雨了它会问你带伞没有，降温了会让你多穿点 —— 这类小事会让对话真实很多。
        </p>
      </Says>

      <Choice
        value={on ? "yes" : "no"}
        onPick={(v) => patchWeather({ enabled: v === "yes" })}
        options={[
          { value: "yes", label: "希望它知道天气", desc: "每轮附上当前天气和明日预报" },
          { value: "no", label: "不用", desc: "跳过这一步" },
        ]}
      />

      {on && !city.trim() && (
        <Note icon={Compass}>
          上一步的城市还空着。天气要按城市查坐标，所以这个开关现在
          <strong className="font-medium">不会生效</strong> —— 回上一步填个城市。
        </Note>
      )}

      {on && (
        <div className="space-y-6 border-t border-line pt-6">
          <SwitchRow
            label="带上最高 / 最低温度"
            desc="多约十几个字符"
            checked={Boolean(weather.range)}
            onChange={(v) => patchWeather({ range: v })}
          />
          <SwitchRow
            label="带上明天的天气"
            desc="它可以提前跟你说「明天要下雨」"
            checked={weather.tomorrow !== false}
            onChange={(v) => patchWeather({ tomorrow: v })}
          />

          <div className="border-t border-line pt-6">
            <SwitchRow
              label="用专业天气 API"
              desc="关着就用 Open-Meteo：免费、不用密钥，但没有灾害预警"
              checked={Boolean(apiCfg.enabled)}
              onChange={(v) => patchApi({ enabled: v })}
            />

            {apiCfg.enabled && (
              <div className="mt-6 space-y-6">
                <div className="space-y-4 rounded-item border border-line p-4">
                  <SwitchRow
                    label="和风天气"
                    desc="国内数据细，有预警。console.qweather.com 免费注册"
                    checked={Boolean(qw.enabled)}
                    onChange={(v) => patchApi({ qweather: { ...qw, enabled: v } })}
                  />
                  {qw.enabled && (
                    <>
                      <Field label="API Host" hint="控制台「设置」里复制「API Host」">
                        <input
                          className={inputCls}
                          value={qwKeys.host ?? ""}
                          onChange={(e) =>
                            updateWeatherApi({ qweather: { ...qwKeys, host: e.target.value } })
                          }
                          placeholder="h2a9cf3mhs.xy.qweatherapi.com"
                        />
                      </Field>
                      <Field label="API Key">
                        <SecretInput
                          value={qwKeys.key ?? ""}
                          onChange={(v) => updateWeatherApi({ qweather: { ...qwKeys, key: v } })}
                          placeholder="和风天气 key"
                        />
                      </Field>
                      <SwitchRow
                        label="灾害预警"
                        desc="台风、暴雨这类会单独告诉它"
                        checked={Boolean(qw.alerts)}
                        onChange={(v) => patchApi({ qweather: { ...qw, alerts: v } })}
                      />
                    </>
                  )}
                </div>

                <div className="space-y-4 rounded-item border border-line p-4">
                  <SwitchRow
                    label="WeatherAPI"
                    desc="海外城市更准。weatherapi.com 免费额度够用"
                    checked={Boolean(wa.enabled)}
                    onChange={(v) => patchApi({ weatherapi: { ...wa, enabled: v } })}
                  />
                  {wa.enabled && (
                    <>
                      <Field label="API Key">
                        <SecretInput
                          value={waKeys.key ?? ""}
                          onChange={(v) => updateWeatherApi({ weatherapi: { ...waKeys, key: v } })}
                          placeholder="weatherapi.com key"
                        />
                      </Field>
                      <SwitchRow
                        label="灾害预警"
                        checked={Boolean(wa.alerts)}
                        onChange={(v) => patchApi({ weatherapi: { ...wa, alerts: v } })}
                      />
                    </>
                  )}
                </div>

                <Note icon={Lock}>
                  天气密钥是全局的，所有角色共用一份，而且只从已保存的配置里读 ——
                  向导最后一步会帮你存好。
                </Note>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 功能开关那一步。
 *
 * 每个开关背后是两道闸：角色自己的开关，加上预设里「消息格式与功能」的子条目。
 * 所以开的时候必须同时 openGate(kind)，不然角色这边开了、预设那边没注入，
 * 模型压根不知道自己能干这事。
 *
 * reactSend / effectSend 还有个坑：清单为空时后端整条跳过（prompt.js:254），
 * 所以开的时候要顺手塞一批默认值进去。
 */
function StepFeatures({ role, defaults }) {
  const { updateRole } = useConfig();
  const openGate = usePresetGate(role);

  const patch = (key, p) => updateRole(role.id, { [key]: { ...(role?.[key] ?? {}), ...p } });

  /** 开的时候连预设的闸一起开；关的时候只关角色这边（预设是多角色共用的）。 */
  const toggle = (key, kind, on, extra = {}) => {
    patch(key, { enabled: on, ...(on ? extra : {}) });
    if (on && kind) openGate(kind);
  };

  const vs = role?.voiceSend ?? {};
  const ss = role?.stickerSend ?? {};
  const ig = role?.imageGen ?? {};
  const cs = role?.cardSend ?? {};
  const ls = role?.locationSend ?? {};
  const ws = role?.webSearch ?? {};
  const lor = role?.leaveOnRead ?? {};
  const us = role?.undoSend ?? {};
  const rs = role?.reactSend ?? {};
  const es = role?.effectSend ?? {};

  return (
    <div className="space-y-6">
      <Says>
        <p>下面这些是它能做的事，不只是发文字 ₍^ &gt;ヮ&lt;^₎ .ᐟ.ᐟ</p>
        <p className="text-ui text-ink-soft">
          我按「先开着不会出错」的顺序排好了，你扫一眼，不想要的关掉就行。
        </p>
      </Says>

      <div className="space-y-1">
        <GroupLabel>不用额外配置的</GroupLabel>
        <div className="mt-3 space-y-4">
          <SwitchRow
            label="发表情包"
            desc="从你放进「图库」的表情里挑一张发出来"
            checked={Boolean(ss.enabled)}
            onChange={(v) => toggle("stickerSend", "sticker", v)}
          />
          <SwitchRow
            label="消息回应"
            desc="给你的消息点爱心、点赞那种 Tapback"
            checked={Boolean(rs.enabled)}
            onChange={(v) =>
              toggle("reactSend", "react", v, {
                // 空清单等于没开：后端会整条跳过，模型看不见可选项
                emojis: (rs.emojis ?? []).length ? rs.emojis : defaults.reactEmojis,
              })
            }
          />
          <SwitchRow
            label="消息特效"
            desc="气球、烟花、隐形墨水那些"
            checked={Boolean(es.enabled)}
            onChange={(v) =>
              toggle("effectSend", "effect", v, {
                effects: (es.effects ?? []).length ? es.effects : defaults.effects,
              })
            }
          />
          <SwitchRow
            label="分享位置"
            desc="它可以告诉你自己在哪"
            checked={Boolean(ls.enabled)}
            onChange={(v) => toggle("locationSend", "location", v)}
          />
          <SwitchRow
            label="分享链接卡片"
            desc="发歌、发网页会带预览卡"
            checked={Boolean(cs.enabled)}
            onChange={(v) => toggle("cardSend", "card", v)}
          />
        </div>
      </div>

      <div className="space-y-1 border-t border-line pt-6">
        <GroupLabel>让它更像真人</GroupLabel>
        <div className="mt-3 space-y-4">
          <SwitchRow
            label="已读不回"
            desc="忙的时候它会先不回你，过一会儿再说"
            checked={Boolean(lor.enabled)}
            onChange={(v) => toggle("leaveOnRead", "leaveOnRead", v)}
          />
          <SwitchRow
            label="撤回消息"
            desc="说错话了自己撤回，像真人手滑那样"
            checked={Boolean(us.enabled)}
            onChange={(v) => toggle("undoSend", "undoSend", v)}
          />
        </div>
      </div>

      <div className="space-y-1 border-t border-line pt-6">
        <GroupLabel>要额外配置才能用</GroupLabel>
        <div className="mt-3 space-y-4">
          <SwitchRow
            label="发语音"
            desc="需要在「连接」面板配 TTS（MiniMax / ElevenLabs / GPT-SoVITS）"
            checked={Boolean(vs.enabled)}
            onChange={(v) => toggle("voiceSend", "voice", v)}
          />
          <SwitchRow
            label="生成图片"
            desc="需要一个标了「画图」分类的模型"
            checked={Boolean(ig.enabled)}
            onChange={(v) => toggle("imageGen", "image", v)}
          />
          <SwitchRow
            label="联网搜索"
            desc="需要 Tavily 或 Brave 的密钥"
            checked={Boolean(ws.enabled)}
            onChange={(v) => toggle("webSearch", "search", v)}
          />
        </div>
        <Note icon={Search}>
          这三个开着但没配好也不会报错 —— 只是模型用不出来。之后去「连接」面板补上就行。
        </Note>
      </div>
    </div>
  );
}

function StepMemory({ role }) {
  const { updateRole } = useConfig();
  const openGate = usePresetGate(role);
  const mem = role?.memories ?? {};

  const patch = (p) => updateRole(role.id, { memories: { ...mem, ...p } });
  const memory = mem.memory ?? {};
  const memo = mem.memo ?? {};
  const diary = mem.diary ?? {};

  return (
    <div className="space-y-6">
      <Says>
        <p>上文会被丢掉，但有些事它应该一直记着。</p>
        <p className="text-ui text-ink-soft">
          记忆库会在后台把聊过的事总结下来存好，下次自动带上。
        </p>
      </Says>

      <div className="space-y-4">
        <SwitchRow
          label="长期记忆"
          desc="自动总结聊过的重要事情，下次对话带上"
          checked={Boolean(memory.enabled)}
          onChange={(v) => {
            patch({ memory: { ...memory, enabled: v } });
            if (v) openGate("memory");
          }}
        />
        <SwitchRow
          label="备忘"
          desc="它会自己记下约好的事、你提过的偏好"
          checked={Boolean(memo.enabled)}
          onChange={(v) => patch({ memo: { ...memo, enabled: v } })}
        />
        <SwitchRow
          label="日记"
          desc="每天写一篇，它自己的视角"
          checked={Boolean(diary.enabled)}
          onChange={(v) => patch({ diary: { ...diary, enabled: v } })}
        />
        {diary.enabled && (
          <NumberField
            label="带上最近几天的日记"
            value={diary.injectDays ?? 3}
            min={0}
            max={30}
            step={1}
            onChange={(v) => patch({ diary: { ...diary, injectDays: v } })}
            hint="0 = 只写不带"
            suffix="天"
          />
        )}
      </div>

      <Note icon={Brain}>
        记忆库的总结用的是角色自己的聊天模型，会多花一点额度。
        提示词可以在「记忆」面板里改。
      </Note>
    </div>
  );
}

function StepProactive({ role }) {
  const { updateRole } = useConfig();
  const p = role?.proactive ?? {};
  const random = p.random ?? {};
  const focus = p.focus ?? {};
  const patch = (x) => updateRole(role.id, { proactive: { ...p, ...x } });

  return (
    <div className="space-y-6">
      <Says>
        <p>要让它主动找你吗？</p>
        <p className="text-ui text-ink-soft">
          开着的话，它会在你没说话的时候自己发消息过来 —— 想你了、有事了、随便聊聊。
        </p>
      </Says>

      <Choice
        value={p.enabled ? "yes" : "no"}
        onPick={(v) => patch({ enabled: v === "yes" })}
        options={[
          { value: "yes", label: "希望它主动找我", desc: "隔一段时间自己发消息" },
          { value: "no", label: "不用，我找它就好" },
        ]}
      />

      {p.enabled && (
        <div className="space-y-6 border-t border-line pt-6">
          <Choice
            value={p.mode === "auto" ? "auto" : "random"}
            onPick={(v) => patch({ mode: v })}
            options={[
              { value: "random", label: "按时间随机", desc: "在你设的时间区间里随机挑一个点" },
              {
                value: "auto",
                label: "让它自己决定",
                desc: "每轮结束时问模型「要不要过一会儿再说点什么」",
              },
            ]}
          />

          {p.mode !== "auto" && (
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              <NumberField
                label="最短间隔"
                value={random.minHours ?? 2}
                min={0}
                max={72}
                step={1}
                onChange={(v) => patch({ random: { ...random, minHours: v } })}
                suffix="小时"
              />
              <NumberField
                label="最长间隔"
                value={random.maxHours ?? 8}
                min={0}
                max={72}
                step={1}
                onChange={(v) => patch({ random: { ...random, maxHours: v } })}
                suffix="小时"
              />
            </div>
          )}

          <SwitchRow
            label="夜里别打扰"
            desc={`${focus.start ?? "00:00"} 到 ${focus.end ?? "08:00"} 之间不主动发`}
            checked={focus.enabled !== false}
            onChange={(v) => patch({ focus: { ...focus, enabled: v } })}
          />
          {focus.enabled !== false && (
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              <Field label="从">
                <input
                  type="time"
                  className={inputCls}
                  value={focus.start ?? "00:00"}
                  onChange={(e) => patch({ focus: { ...focus, start: e.target.value } })}
                />
              </Field>
              <Field label="到">
                <input
                  type="time"
                  className={inputCls}
                  value={focus.end ?? "08:00"}
                  onChange={(e) => patch({ focus: { ...focus, end: e.target.value } })}
                />
              </Field>
            </div>
          )}

          <Note icon={Bell}>
            主动消息要程序一直开着才会发。关掉小手机的时候它不会攒着，
            下次开机也不会补发。
          </Note>
        </div>
      )}
    </div>
  );
}

function StepPace() {
  const { config, updateChat, updateDelay } = useConfig();
  const chat = config?.chat ?? {};
  const delay = chat.delay ?? {};

  return (
    <div className="space-y-6">
      <Says>
        <p>最后一件小事：它打字有多快。</p>
        <p className="text-ui text-ink-soft">
          真人不会在半秒里甩出三段话。这里让它按字数停一停，读着更自然。
        </p>
      </Says>

      <div className="space-y-6">
        <Field
          label="打字速度"
          hint={`每个字停 ${delay.typingSpeed ?? 0.2} 秒 —— 越小越快`}
        >
          <Slider
            value={delay.typingSpeed ?? 0.2}
            min={0}
            max={0.6}
            step={0.05}
            onChange={(v) => updateDelay({ typingSpeed: v })}
          />
        </Field>

        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <NumberField
            label="最少停"
            value={delay.clampMin ?? 0.5}
            min={0}
            max={10}
            step={0.5}
            onChange={(v) => updateDelay({ clampMin: v })}
            suffix="秒"
          />
          <NumberField
            label="最多停"
            value={delay.clampMax ?? 8}
            min={1}
            max={60}
            step={1}
            onChange={(v) => updateDelay({ clampMax: v })}
            suffix="秒"
          />
        </div>

        <NumberField
          label="连着说话时，等你多久"
          value={chat.queueWait ?? 8}
          min={0}
          max={60}
          step={1}
          onChange={(v) => updateChat({ queueWait: v })}
          hint="你还在打字的时候它先不回，等这么久没新消息才开始想"
          suffix="秒"
        />

        <Field label="分段符号" hint="模型用这个把一段话切成好几条气泡发出来">
          <input
            className={`${inputCls} font-mono`}
            value={chat.separator ?? "$"}
            onChange={(e) => updateChat({ separator: e.target.value })}
            placeholder="$"
          />
        </Field>
      </div>

      <Note icon={SlidersHorizontal}>这些是全局的，所有角色共用。之后在「对话」面板里能改。</Note>
    </div>
  );
}

function StepDone({ role, project, saveState, saveError, onSave, onFinish }) {
  const saved = saveState === "saved";
  const saving = saveState === "saving";

  const checks = [
    { ok: Boolean((project?.projectId ?? "").trim()), text: "Photon 项目凭据" },
    { ok: Boolean((project?.linePhone ?? "").trim()), text: "iMessage 线路号码" },
    { ok: Boolean((role?.name ?? "").trim()), text: "角色名字" },
    { ok: Boolean(role?.chatModel?.modelId), text: "聊天模型" },
    { ok: Boolean((role?.description ?? "").trim()), text: "角色提示词" },
  ];
  const missing = checks.filter((c) => !c.ok);

  return (
    <div className="space-y-6">
      <Says size={96}>
        <p>配完了 ٩(ˊᗜˋ*)و ♡</p>
        <p>
          剩下的都能边用边调 —— 每个面板都有说明，不确定的地方点右下角那个泡泡问我 ᗜ ᴗ ᗜ
        </p>
      </Says>

      <div className="space-y-2">
        {checks.map((c) => (
          <p
            key={c.text}
            className={`flex items-center gap-2 text-ui ${c.ok ? "text-ink" : "text-ink-faint"}`}
          >
            {c.ok ? (
              <CheckCircle2 size={16} className="shrink-0 text-good" />
            ) : (
              <span className="size-4 shrink-0 rounded-full border border-line" />
            )}
            {c.text}
          </p>
        ))}
      </div>

      {missing.length > 0 && (
        <Note icon={Compass}>
          还有 {missing.length} 项空着（{missing.map((m) => m.text).join("、")}）。
          现在保存也没问题，缺的那几样补上之前，这个角色暂时不会上线。
        </Note>
      )}

      {saveError && (
        <p className="rounded-item border border-warn/40 bg-warnsoft p-3 text-meta leading-relaxed text-warn">
          {String(saveError)}
        </p>
      )}

      {saved ? (
        <>
          <div className="rounded-item border border-good/30 bg-goodsoft p-4">
            <p className="flex items-start gap-2 text-ui leading-relaxed text-ink">
              <PartyPopper size={16} className="mt-0.5 shrink-0 text-good" />
              <span className="min-w-0">
                已经存到本地了。桥接正在重启 ——
                过几秒去「iMessage」面板看一眼状态，显示「已连接」就可以发消息试试 ദ്ദി˶&gt;ᴗo)✧
              </span>
            </p>
          </div>
          <Note icon={ExternalLink}>
            卡住了有两个地方能找人：
            <a href={DOC_URL} target="_blank" rel="noreferrer" className="link-slide text-ink">
              Niki 写的图文教程
            </a>
            ，或者 QQ 群 <span className="font-mono">{DEFAULT_QQ_GROUP}</span>{" "}
            —— 答疑、反馈 BUG、许愿想要的功能都在那儿。
          </Note>
        </>
      ) : (
        <Note icon={Lock}>
          点下面的「保存并开始」才会写进磁盘。写的是你电脑上的
          data.config.json，不会上传任何地方。
        </Note>
      )}

      <div className="flex items-center gap-3">
        {saved ? (
          <Button onClick={onFinish}>
            <Rocket size={14} /> 开始使用
          </Button>
        ) : (
          <Button onClick={onSave} disabled={saving}>
            {saving ? "保存中…" : "保存并开始"}
            {!saving && <ArrowRight size={14} />}
          </Button>
        )}
      </div>
    </div>
  );
}

/* ---------- 向导本体 ---------- */

/**
 * 右上角的入口按钮。形状和「指令」「壁纸」两个按钮一致。
 * 点开就从上次停下的那步继续 —— 步号记在 SetupWizard 里。
 */
export function SetupButton({ onOpen }) {
  return (
    <Button variant="outline" className="shrink-0" onClick={onOpen}>
      <Wand2 size={14} />
      <span className="max-sm:hidden">快速配置</span>
    </Button>
  );
}

/**
 * 向导弹窗。open / onClose 由 shell 拿着 —— 右上角按钮和「首次自动弹」
 * 都要能开它，状态放在共同的父层最省事。
 */
export function SetupWizard({ open, onClose }) {
  const {
    config,
    dirty,
    save,
    saveState,
    saveError,
    addProvider,
    addProject,
    addRole,
    addUser,
    bindProject,
    updateRole,
  } = useConfig();

  const [step, setStep] = useState(0);
  const [level, setLevel] = useState(null);
  // 向导自己建出来的那几条记录的 id。建一次就够，重开不要再建
  const [ids, setIds] = useState({ provider: "", project: "", role: "", user: "" });
  const seeded = useRef(false);

  /**
   * 第一次进 A 路径时，把要用的空白记录建出来。
   *
   * 放在 effect 里而不是点「下一步」的时候 —— StrictMode 下 effect 会跑两遍，
   * 所以用 ref 挡住第二次；点击回调倒是不会重入，但那样得在四个 setState
   * 之间同步拿 id，反而更绕。
   */
  useEffect(() => {
    if (level !== "guided" || seeded.current) return;
    seeded.current = true;

    // 已经有内容的话就接着用，别再造一份空的出来
    const provider =
      (config?.providers ?? []).find((p) => (p.url ?? "").trim()) ??
      (config?.providers ?? [])[0];
    const project = (config?.projects ?? [])[0];
    const role = (config?.roles ?? [])[0];
    const user = (config?.users ?? [])[0];

    const providerId = provider?.id ?? addProvider();
    const projectId = project?.id ?? addProject();
    const roleId = role?.id ?? addRole();
    const userId = user?.id ?? addUser();

    setIds({ provider: providerId, project: projectId, role: roleId, user: userId });

    // 新建的角色没绑项目 —— 绑上，不然它发不出去
    if (!role?.projectRef) bindProject(roleId, projectId);
  }, [level, config, addProvider, addProject, addRole, addUser, bindProject]);

  const provider = useMemo(
    () => (config?.providers ?? []).find((p) => p.id === ids.provider),
    [config, ids.provider]
  );
  const project = useMemo(
    () => (config?.projects ?? []).find((p) => p.id === ids.project),
    [config, ids.project]
  );
  const role = useMemo(
    () => (config?.roles ?? []).find((r) => r.id === ids.role),
    [config, ids.role]
  );
  const user = useMemo(
    () => (config?.users ?? []).find((u) => u.id === ids.user),
    [config, ids.user]
  );

  /**
   * reactSend / effectSend 开的时候要塞的默认清单。
   * 抄的是 role.jsx 里那两组内置值的常用子集 —— 全塞进去提示词太长。
   */
  const defaults = useMemo(
    () => ({
      reactEmojis: ["❤️", "👍", "👎", "😂", "‼️", "❓"],
      effects: ["balloons", "confetti", "fireworks", "heart", "sparkles", "gentle", "loud", "slam"],
    }),
    []
  );

  const steps = useMemo(() => {
    const head = [
      { key: "welcome", title: "开始之前", icon: Sparkles, node: <StepWelcome /> },
      {
        key: "level",
        title: "熟练度",
        icon: Compass,
        node: <StepLevel level={level} setLevel={setLevel} />,
        // 没选之前不让往下走 —— 后面走哪条路全看这一步
        gate: !level,
      },
    ];
    if (level !== "guided") return head;

    return [
      ...head,
      {
        key: "photon",
        title: "开通 Photon",
        icon: Smartphone,
        node: project ? <StepPhoton project={project} onEnrolled={() => setStep((s) => s)} /> : null,
      },
      {
        key: "provider",
        title: "模型接口",
        icon: MessageSquareText,
        node: provider ? <StepProvider provider={provider} /> : null,
      },
      { key: "role", title: "角色", icon: UserRound, node: role ? <StepRole role={role} /> : null },
      { key: "user", title: "你自己", icon: Users, node: user ? <StepUser user={user} /> : null },
      {
        key: "context",
        title: "上下文",
        icon: Brain,
        node: role ? <StepContext role={role} /> : null,
      },
      { key: "time", title: "时间", icon: Clock, node: role ? <StepTime role={role} /> : null },
      {
        key: "weather",
        title: "天气",
        icon: CloudSun,
        node: role ? <StepWeather role={role} /> : null,
      },
      {
        key: "features",
        title: "功能",
        icon: Wand2,
        node: role ? <StepFeatures role={role} defaults={defaults} /> : null,
      },
      {
        key: "memory",
        title: "记忆",
        icon: Brain,
        node: role ? <StepMemory role={role} /> : null,
      },
      {
        key: "proactive",
        title: "主动消息",
        icon: Bell,
        node: role ? <StepProactive role={role} /> : null,
      },
      { key: "pace", title: "发送节奏", icon: SlidersHorizontal, node: <StepPace /> },
      {
        key: "done",
        title: "完成",
        icon: PartyPopper,
        node: (
          <StepDone
            role={role}
            project={project}
            saveState={saveState}
            saveError={saveError}
            onSave={save}
            onFinish={onClose}
          />
        ),
      },
    ];
  }, [
    level,
    project,
    provider,
    role,
    user,
    defaults,
    saveState,
    saveError,
    save,
    onClose,
  ]);

  const idx = Math.min(step, steps.length - 1);
  const current = steps[idx];
  /*
   * 「这是最后一步吗」不能只看下标 —— 选了 B 的时候 steps 只剩两条，
   * 熟练度那步就成了末步，主按钮会整个消失，B 就变成一条死路。
   * 只有真正的收尾步（done）才算末步；level 那步永远有出口。
   */
  const last = current.key === "done";

  if (!open || !current) return null;

  const next = () => {
    // B 路径：选了「无需配置」，「下一步」就是直接进去
    if (current.key === "level" && level === "skip") {
      onClose();
      return;
    }
    setStep((s) => Math.min(s + 1, steps.length - 1));
  };

  /**
   * 关掉向导时把填的东西存下来。
   *
   * 原来只有最后一步那个「保存并开始」会落盘 —— 中途关掉（点 ✕、按 Esc、
   * 点弹窗外面），前面配的全都只在内存里，用户以为配完了其实一个字没存。
   * 现在改成：只要草稿是脏的，关的时候就存一遍。
   *
   * 存不上也照样关：报错会留在底部那条全局保存条上，用户在那儿能重试，
   * 把人锁在弹窗里解决不了任何问题。
   */
  const closeAndSave = () => {
    onClose();
    if (dirty) save().catch(() => {});
  };

  return (
    <Modal
      title="快速配置"
      desc={`第 ${idx + 1} / ${steps.length} 步 · ${current.title}`}
      onClose={closeAndSave}
      maxWidth="max-w-2xl"
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {idx > 0 && (
              <Button variant="ghost" onClick={() => setStep((s) => Math.max(0, s - 1))}>
                <ArrowLeft size={14} /> 上一步
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/*
              「关掉也会存」得说出来。不写这一句的话，弹窗中途关掉看着就像
              白配了一场 —— 用户不会知道草稿还在。
            */}
            {!last && dirty && (
              <span className="mr-1 hidden text-meta text-ink-faint sm:inline">
                填的都记着了，关掉也会存
              </span>
            )}
            {!last && idx > 1 && (
              <Button variant="ghost" onClick={next}>
                <SkipForward size={14} /> 跳过这步
              </Button>
            )}
            {!last && (
              <Button onClick={next} disabled={current.gate}>
                {current.key === "level" && level === "skip" ? "直接进入" : "下一步"}
                <ArrowRight size={14} />
              </Button>
            )}
          </div>
        </div>
      }
    >
      <div className="space-y-6 p-6">
        {/* 进度条。只有一格一格填满，不显示百分比 —— 步数会随分支变 */}
        <div className="flex items-center gap-1">
          {steps.map((s, i) => (
            <span
              key={s.key}
              className={`h-0.5 flex-1 transition-colors duration-300 ${
                i <= idx ? "bg-ink" : "bg-line"
              }`}
            />
          ))}
        </div>
        {current.node}
      </div>
    </Modal>
  );
}

/**
 * 「要不要自动弹」的判断，抽出来给 shell 用。
 *
 * 只在两个条件同时成立时返回 true：这台机器没弹过、配置看着像全新的。
 * 判断只做一次（用 ref 记住），之后哪怕用户把角色删空了也不会突然弹出来。
 */
export function useAutoOpenSetup(config) {
  const [should, setShould] = useState(false);
  const decided = useRef(false);

  useEffect(() => {
    if (decided.current || !config) return;
    decided.current = true;
    if (!hasSeen() && looksFresh(config)) setShould(true);
    markSeen(); // 弹不弹都记一笔：不能每次刷新都来一遍
  }, [config]);

  return [should, () => setShould(false)];
}
