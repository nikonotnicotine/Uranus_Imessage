import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  CATEGORY_LABELS,
  IMAGE_RATIOS,
  MODEL_CATEGORIES,
  PROVIDER_TYPES,
  modelLabel,
  providerLabel,
  providerTypeOf,
  roleLabel,
  urlForType,
} from "../labels.js";
import { SaveBar, useSection } from "../section.jsx";
import { api, useConfig } from "../store.jsx";
import { Button, Card, Field, Fold, Modal, ResultNote, Switch, inputCls } from "../ui.jsx";
import { ParamSlider } from "./preset.jsx";
import {
  Brain,
  Check,
  Clapperboard,
  Download,
  Eye,
  EyeOff,
  Image as ImageIcon,
  Mic,
  Pencil,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  Undo2,
  Upload,
  X,
  Zap,
} from "lucide-react";

/**
 * API 类型的一排按钮。换类型时地址只在「没动过」的情况下跟着换（见 labels.js:urlForType）。
 */
export function ProviderTypeButtons({ value, onChange }) {
  return (
    <div className="flex flex-wrap gap-2">
      {PROVIDER_TYPES.map((t) => (
        <Button
          key={t.id}
          variant={value === t.id ? "primary" : "outline"}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </Button>
      ))}
    </div>
  );
}

/**
 * 侧栏「新增服务商源」先问一句是哪种，再建。
 *
 * 挂到 body 上：它是从侧栏里弹的，移动端那栏是个带 transform 的抽屉，
 * fixed 定位在 transform 容器里会相对抽屉而不是视口，桌面端那栏收起时又是 hidden。
 */
export function NewProviderModal({ onChoose, onClose }) {
  return createPortal(
    <Modal
      title="新增服务商源"
      desc="选接口类型。中转站、反代一律选「自定义」；建好以后也能在设置里改。"
      onClose={onClose}
    >
      <div className="grid grid-cols-1 gap-2">
        {PROVIDER_TYPES.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onChoose(t.id)}
            className="rounded-item border border-line px-4 py-3 text-left transition-colors duration-150 hover:bg-sunken"
          >
            <span className="block text-ui text-ink">{t.label}</span>
            <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">{t.desc}</span>
          </button>
        ))}
      </div>
    </Modal>,
    document.body
  );
}

/** 密钥输入框：带小眼睛切换明文。 */
export function SecretInput({ value, onChange, placeholder }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input
        className={`${inputCls} pr-10`}
        type={show ? "text" : "password"}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      <button
        type="button"
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-item p-1 text-ink-faint hover:text-ink"
        onClick={() => setShow((s) => !s)}
      >
        {show ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  );
}

/**
 * 用某个服务商源拼一个能直接发出去的 endpoint（测试 / 拉模型用）。
 * 多把 key 时取第一把非空的 —— 真跑的时候后端会轮换，这里只是试一下通不通。
 */
export function endpointOf(provider, model = "", temperature) {
  return {
    type: providerTypeOf(provider).id,
    url: provider?.url ?? "",
    key: (provider?.keys ?? []).find((k) => k?.trim()) ?? "",
    model,
    ...(typeof temperature === "number" ? { temperature } : {}),
  };
}

/**
 * 「获取模型列表」弹窗：拉上游的 /models，每行一个 ＋ 加进配置。
 * 已经加过的显示 ✓，不重复加。
 */
export function ModelListDialog({ provider, onClose }) {
  const { addModels } = useConfig();
  const [state, setState] = useState("loading"); // loading | ok | fail
  const [error, setError] = useState("");
  const [models, setModels] = useState([]);
  const [query, setQuery] = useState("");

  // 弹窗开着的时候用户可能一直在点 ＋，provider 每次都是新对象；
  // 拉取用的地址和密钥固定在打开那一刻，免得每加一个模型就重拉一次
  const shot = useRef({ id: provider.id, endpoint: endpointOf(provider), label: providerLabel(provider) }).current;

  const load = useCallback(async () => {
    setState("loading");
    setError("");
    try {
      const r = await api("/api/llm/models", {
        method: "POST",
        body: { label: shot.label, endpoint: shot.endpoint },
      });
      setModels(r.models ?? []);
      setState("ok");
    } catch (e) {
      setError(String(e?.message ?? e));
      setState("fail");
    }
  }, [shot]);

  useEffect(() => {
    load();
  }, [load]);

  const added = useMemo(
    () => new Set((provider.models ?? []).map((m) => m.model)),
    [provider.models]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? models.filter((m) => m.toLowerCase().includes(q)) : models;
  }, [models, query]);

  const pending = filtered.filter((m) => !added.has(m));

  return (
    <Modal
      title={`${shot.label} 的模型`}
      desc={state === "ok" ? `上游返回 ${models.length} 个，点 ＋ 加进配置` : "正在向这条线路要模型列表…"}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={load} disabled={state === "loading"}>
            <RefreshCw size={14} className={state === "loading" ? "animate-spin" : ""} /> 重新拉取
          </Button>
          <Button
            variant="outline"
            onClick={() => addModels(shot.id, pending)}
            disabled={!pending.length}
          >
            <Plus size={14} /> 加入这 {pending.length} 个
          </Button>
          <Button onClick={onClose}>
            <Check size={15} /> 完成
          </Button>
        </>
      }
    >
      <div className="mb-3 flex items-center gap-2 border border-line bg-paper px-3 py-2">
        <Search size={14} className="shrink-0 text-ink-faint" />
        <input
          autoFocus
          className="w-full bg-transparent text-ui text-ink outline-none placeholder:text-ink-faint"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索模型或 ID"
        />
      </div>

      {state === "loading" && (
        <p className="py-8 text-center text-ui text-ink-faint">拉取中…</p>
      )}

      {state === "fail" && (
        <p className="border-l-2 border-warn py-1.5 pl-3 text-meta leading-relaxed text-warn">
          {error}
          {"\n"}这条线路可能没开 /models 接口，用「自定义模型」手填模型名照样能用。
        </p>
      )}

      {state === "ok" && filtered.length === 0 && (
        <p className="py-8 text-center text-ui text-ink-faint">
          {models.length === 0 ? "这条线路没返回任何模型" : "没有匹配的模型"}
        </p>
      )}

      <div className="grid grid-cols-1 gap-1.5">
        {filtered.map((name) => {
          const has = added.has(name);
          return (
            <div
              key={name}
              className="flex items-center justify-between gap-3 border border-line bg-paper px-3 py-2"
            >
              <span className="min-w-0 break-all font-mono text-meta text-ink-soft">{name}</span>
              <button
                type="button"
                disabled={has}
                onClick={() => addModels(shot.id, [name])}
                aria-label={has ? `${name} 已加入` : `加入 ${name}`}
                className={`shrink-0 rounded-item border p-1.5 transition-colors duration-150 ${
                  has
                    ? "border-transparent text-good"
                    : "border-line text-ink-faint hover:border-ink hover:text-ink"
                }`}
              >
                {has ? <Check size={15} /> : <Plus size={15} />}
              </button>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

/** 手填一个模型名（中转站没开 /models 时用）。 */
export function CustomModelDialog({ provider, onClose }) {
  const { addModels } = useConfig();
  const [name, setName] = useState("");
  const exists = (provider.models ?? []).some((m) => m.model === name.trim());
  const canAdd = Boolean(name.trim()) && !exists;

  function add() {
    if (!canAdd) return;
    addModels(provider.id, [name.trim()]);
    onClose();
  }

  return (
    <Modal
      title="自定义模型"
      desc="填上游真实的模型名，大小写要和文档一致"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button onClick={add} disabled={!canAdd}>
            <Plus size={15} /> 加进配置
          </Button>
        </>
      }
    >
      <Field label="模型名" hint={exists ? "这个模型已经在配置里了" : undefined}>
        <input
          autoFocus
          className={inputCls}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
          placeholder="例如：gpt-4o-mini"
        />
      </Field>
    </Modal>
  );
}

/**
 * 已配置的模型：一行一个。
 * 开关管「在不在配置里生效」，分类管「能出现在角色的哪个下拉里」——
 * 所以开着的模型不一定用于聊天，也可以只拿来识图。
 */
export function ModelRow({ provider, entry, defaultPrompt, defaultAudio, defaultVideo }) {
  const { updateModel, removeModel, toggleModelCategory } = useConfig();
  const [open, setOpen] = useState(false);
  const [testState, setTestState] = useState("idle");
  const [testMsg, setTestMsg] = useState("");
  // 测试出图的结果，直接显示在这一行下面 —— 出图这件事只有看到图才算通
  const [imageData, setImageData] = useState(null);
  const fileRef = useRef(null);
  // 听音测试的文件框。和上面那个分开：accept 不一样，共用一个会让
  // 选图的弹窗里也列出音频文件
  const audioRef = useRef(null);
  // 看视频测试的文件框。同理，accept 是 video/*
  const videoRef = useRef(null);

  const cats = entry.categories ?? [];
  const patch = (p) => updateModel(provider.id, entry.id, p);

  async function runTest() {
    setTestState("loading");
    setTestMsg("正在连…");
    try {
      const r = await api("/api/llm/test", {
        method: "POST",
        body: {
          label: `${providerLabel(provider)} · ${modelLabel(entry)}`,
          endpoint: endpointOf(provider, entry.model),
        },
      });
      setTestState("ok");
      setTestMsg(`${r.reply || "连接正常"}${r.ms ? `（${r.ms}ms）` : ""}`);
    } catch (e) {
      setTestState("fail");
      setTestMsg(String(e?.message ?? e));
    }
  }

  async function runVisionTest(image) {
    setTestState("loading");
    setTestMsg(image ? `正在识别「${image.name}」…` : "正在用内置测试图识别…");
    try {
      const r = await api("/api/llm/vision-test", {
        method: "POST",
        body: {
          endpoint: endpointOf(provider, entry.model),
          prompt: entry.visionPrompt || undefined,
          image,
        },
      });
      setTestState("ok");
      setTestMsg(
        r.builtin
          ? `能收图（内置测试图，红色纯色块）。模型说：${r.description}`
          : `识别结果：${r.description}`
      );
    } catch (e) {
      setTestState("fail");
      setTestMsg(String(e?.message ?? e));
    }
  }

  /**
   * 试听一段音频。
   *
   * 没有「内置测试音」这一说 —— 识图那边能拿一张纯红小图凑合，声音没有
   * 等价物，所以必须真选一个文件。后端会先过 ffmpeg 转码再送出去，走的是
   * 和真实语音条一模一样的路。
   */
  async function runAudioTest(audio) {
    setTestState("loading");
    setTestMsg(`正在识别「${audio.name}」…`);
    try {
      const r = await api("/api/llm/audio-test", {
        method: "POST",
        body: {
          endpoint: endpointOf(provider, entry.model),
          prompt: entry.audioPrompt || undefined,
          audio,
        },
      });
      setTestState("ok");
      setTestMsg(`识别结果${r.seconds ? `（${r.seconds.toFixed(1)} 秒）` : ""}：${r.text}`);
    } catch (e) {
      setTestState("fail");
      setTestMsg(String(e?.message ?? e));
    }
  }

  /**
   * 试看一段视频。这个按钮比另外两个更值得点一次。
   *
   * 理由是**上游吃不吃得下跟中转站强相关**：实测五家里有一家网关连 12MB 都
   * 直接 413（而它听语音是好的）。等到对方真发来视频才发现这家不行，那一轮
   * 已经白等了几十秒。
   *
   * 成功和失败都把体积和耗时显示出来 —— 「19MB / 69 秒」这种数才是用户判断
   * 「这家能不能用」的依据，光一句「成功」看不出它慢到什么程度。
   */
  async function runVideoTest(video) {
    const mb = (video.base64.length * 3) / 4 / 1024 / 1024;
    setTestState("loading");
    setTestMsg(`正在识别「${video.name}」（${mb.toFixed(1)}MB，可能要一分多钟）…`);
    try {
      const r = await api("/api/llm/video-test", {
        method: "POST",
        body: {
          endpoint: endpointOf(provider, entry.model),
          prompt: entry.videoPrompt || undefined,
          video,
        },
      });
      setTestState("ok");
      setTestMsg(
        `识别结果（${(r.bytes / 1024 / 1024).toFixed(1)}MB，${(r.ms / 1000).toFixed(1)} 秒）：${r.text}`
      );
    } catch (e) {
      setTestState("fail");
      setTestMsg(`${String(e?.message ?? e)}（传的是 ${mb.toFixed(1)}MB）`);
    }
  }

  /**
   * 试出一张图。
   *
   * 和上面两个测试不一样：**这个必须先保存**。生图模型是全局挑的
   * （后端 resolveImageEndpoint 扫的是已保存的配置），所以刚勾上「生图」
   * 分类、还没点保存的话，后端根本看不到这个模型。提示里写了这句话。
   */
  async function runImageTest() {
    setTestState("loading");
    setTestMsg("正在出图，通常要十几秒…");
    setImageData(null);
    try {
      const r = await api("/api/image/test", { method: "POST", body: {} });
      setTestState("ok");
      setTestMsg(`${r.label} 出图成功（${r.ms}ms）`);
      setImageData({ base64: r.base64, mimeType: r.mimeType });
    } catch (e) {
      setTestState("fail");
      setTestMsg(String(e?.message ?? e));
    }
  }

  /**
   * 试一次向量。
   *
   * 和「测试出图」一样**必须先保存**，而且理由更强一点：向量模型不是全局
   * 自动挑的，而是在「记忆库 → 设置 → 记忆」里显式选的那一个
   * （后端 `/api/embedding/test` 只读已存盘的 `memories.memory.embedModel`，
   * 不收请求体里的凭据 —— 不让密钥进请求日志）。所以这个按钮测的是
   * **那个选中的模型**，不一定是这一行；提示里写清楚了。
   *
   * 回的是维度：1536 还是 1024 决定了以后换模型要不要重算全部记忆，
   * 这是唯一有意义的判断。
   */
  async function runEmbeddingTest() {
    setTestState("loading");
    setTestMsg("正在打向量接口…");
    try {
      const r = await api("/api/embedding/test", { method: "POST", body: {} });
      setTestState("ok");
      setTestMsg(
        `${r.label} 通了（${r.ms}ms，${r.dims} 维）。前几个数：` +
          `${(r.head ?? []).map((n) => Number(n).toFixed(4)).join(", ")}`
      );
    } catch (e) {
      setTestState("fail");
      setTestMsg(String(e?.message ?? e));
    }
  }

  /** 选中本地图片 → 转 base64 → 发去识别。 */
  function onPickFile(e) {
    const file = e.target.files?.[0];
    e.target.value = ""; // 允许重复选同一个文件
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setTestState("fail");
      setTestMsg("这不是图片文件");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setTestState("fail");
      setTestMsg(`图片 ${(file.size / 1024 / 1024).toFixed(1)}MB，超过 8MB 上限`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      // data:image/png;base64,xxxx → 只要后面那截
      const base64 = String(reader.result ?? "").split(",")[1];
      if (!base64) {
        setTestState("fail");
        setTestMsg("读不出这张图的内容");
        return;
      }
      runVisionTest({ base64, mimeType: file.type, name: file.name });
    };
    reader.onerror = () => {
      setTestState("fail");
      setTestMsg("读取文件失败");
    };
    reader.readAsDataURL(file);
  }

  /**
   * 选中本地音频 → 转 base64 → 发去识别。
   *
   * 8MB 的上限和识图那边一样，卡的是 express.json 那个 12mb（base64 会
   * 撑大三分之一）。不校验后缀：什么格式都先交给 ffmpeg，它认不出来再说。
   */
  function onPickAudio(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      setTestState("fail");
      setTestMsg(`音频 ${(file.size / 1024 / 1024).toFixed(1)}MB，超过 8MB 上限`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = String(reader.result ?? "").split(",")[1];
      if (!base64) {
        setTestState("fail");
        setTestMsg("读不出这个文件的内容");
        return;
      }
      runAudioTest({ base64, mimeType: file.type, name: file.name });
    };
    reader.onerror = () => {
      setTestState("fail");
      setTestMsg("读取文件失败");
    };
    reader.readAsDataURL(file);
  }

  /**
   * 选中本地视频 → 转 base64 → 发去识别。
   *
   * 这儿的上限**故意比真实链路的 20MB 宽**（32MB）：试的时候用户想拿一段更大的
   * 探探这家中转站的底（「30MB 会不会过」是个合理的问题），没有理由拦。后端那条
   * 路由的请求体上限是 48mb，32MB 的视频撑成 base64 是 43MB，刚好在里面。
   *
   * 不校验后缀，只看 MIME 前缀 —— .mov / .mkv / .webm 都直接交给上游，它认不出
   * 来再说；先在本地拦一遍反而会拦掉某些其实能用的格式。
   */
  function onPickVideo(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 32 * 1024 * 1024) {
      setTestState("fail");
      setTestMsg(
        `视频 ${(file.size / 1024 / 1024).toFixed(1)}MB，测试最多传 32MB` +
          `（真实聊天里的上限是 20MB）`
      );
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = String(reader.result ?? "").split(",")[1];
      if (!base64) {
        setTestState("fail");
        setTestMsg("读不出这个文件的内容");
        return;
      }
      runVideoTest({ base64, mimeType: file.type, name: file.name });
    };
    reader.onerror = () => {
      setTestState("fail");
      setTestMsg("读取文件失败");
    };
    reader.readAsDataURL(file);
  }

  return (
    <div className={`border bg-paper ${entry.enabled ? "border-line" : "border-line/60"}`}>
      <div className="flex items-center gap-3 px-3.5 py-3">
        <div className={`min-w-0 flex-1 ${entry.enabled ? "" : "opacity-50"}`}>
          <p className="flex flex-wrap items-center gap-1.5">
            {entry.pinned && <Pin size={12} className="shrink-0 text-ink" />}
            <span className="break-all text-ui text-ink">{modelLabel(entry)}</span>
            {cats.map((c) => (
              <span
                key={c}
                className="rounded-item bg-sunken px-1.5 py-0.5 text-meta text-ink"
              >
                {CATEGORY_LABELS[c]}
              </span>
            ))}
          </p>
          <p className="mt-0.5 break-all font-mono text-meta text-ink-faint">
            {providerLabel(provider)} / {entry.model}
          </p>
        </div>

        <Switch
          checked={Boolean(entry.enabled)}
          onChange={(v) => patch({ enabled: v })}
          label={`启用 ${modelLabel(entry)}`}
        />
        <button
          type="button"
          onClick={() => patch({ pinned: !entry.pinned })}
          aria-label="置顶"
          className={`shrink-0 rounded-item p-1.5 transition-colors duration-150 hover:bg-sunken ${
            entry.pinned ? "text-ink" : "text-ink-faint hover:text-ink"
          }`}
        >
          <Pin size={15} />
        </button>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-label="模型设置"
          aria-expanded={open}
          className={`shrink-0 rounded-item p-1.5 transition-colors duration-150 hover:bg-sunken ${
            open ? "text-ink" : "text-ink-faint hover:text-ink"
          }`}
        >
          <Settings size={15} />
        </button>
        <button
          type="button"
          onClick={() => removeModel(provider.id, entry.id)}
          aria-label="删除模型"
          className="shrink-0 rounded-item p-1.5 text-ink-faint transition-colors duration-150 hover:bg-sunken hover:text-warn"
        >
          <Trash2 size={15} />
        </button>
      </div>

      {open && (
        <div className="grid grid-cols-1 gap-5 border-t border-line px-3.5 py-4">
          <Field label="别名" hint="留空就显示上游模型名">
            <input
              className={inputCls}
              value={entry.alias ?? ""}
              onChange={(e) => patch({ alias: e.target.value })}
              placeholder={entry.model}
            />
          </Field>

          <Field label="分类" hint="决定它出现在角色的哪个下拉里，可多选">
            <div className="flex flex-wrap gap-2">
              {MODEL_CATEGORIES.map((c) => {
                const on = cats.includes(c);
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => toggleModelCategory(provider.id, entry.id, c)}
                    className={`rounded-full border px-3 py-1.5 text-meta transition-colors duration-150 ${
                      on
                        ? "border-ink bg-ink text-paper-invert"
                        : "border-line text-ink-soft hover:bg-sunken hover:text-ink"
                    }`}
                  >
                    {CATEGORY_LABELS[c]}
                  </button>
                );
              })}
            </div>
          </Field>

          {cats.includes("vision") && (
            <Field label="识图提示词" hint="留空就用后端那句默认的">
              <textarea
                className={`${inputCls} min-h-[90px] resize-y leading-relaxed`}
                value={entry.visionPrompt ?? ""}
                onChange={(e) => patch({ visionPrompt: e.target.value })}
                placeholder={defaultPrompt || "例如：用中文描述画面主体、场景和可见文字…"}
              />
              {defaultPrompt && entry.visionPrompt && (
                <button
                  type="button"
                  onClick={() => patch({ visionPrompt: "" })}
                  className="mt-2 inline-flex items-center gap-1.5 text-meta text-ink-soft transition-colors duration-150 hover:text-ink"
                >
                  <Undo2 size={13} /> 清空，回到默认提示词
                </button>
              )}
            </Field>
          )}

          {cats.includes("audio") && (
            <Field
              label="语音识别提示词"
              hint="留空就按角色的「识别情绪与环境音」开关，在后端两套默认提示词里挑一套"
            >
              <textarea
                className={`${inputCls} min-h-[90px] resize-y leading-relaxed`}
                value={entry.audioPrompt ?? ""}
                onChange={(e) => patch({ audioPrompt: e.target.value })}
                placeholder={
                  defaultAudio?.simple || "例如：把语音逐字转写成中文，听不清就说听不清…"
                }
              />
              {entry.audioPrompt ? (
                <button
                  type="button"
                  onClick={() => patch({ audioPrompt: "" })}
                  className="mt-2 inline-flex items-center gap-1.5 text-meta text-ink-soft transition-colors duration-150 hover:text-ink"
                >
                  <Undo2 size={13} /> 清空，回到默认提示词
                </button>
              ) : (
                /*
                 * 想自己改一版又不想从零写的话，把「情绪版」那段填进来当底稿。
                 * 只在空的时候给，免得一按就把用户写了一半的东西盖掉。
                 */
                defaultAudio?.rich && (
                  <button
                    type="button"
                    onClick={() => patch({ audioPrompt: defaultAudio.rich })}
                    className="mt-2 inline-flex items-center gap-1.5 text-meta text-ink-soft transition-colors duration-150 hover:text-ink"
                  >
                    <Undo2 size={13} /> 用「情绪识别版」当底稿改
                  </button>
                )
              )}
              <p className="mt-2 text-meta leading-relaxed text-ink-faint">
                这条线走的是 Gemini 原生的 generateContent，不是 /chat/completions
                —— 中转站不透传 OpenAI 那个 input_audio 字段，所以只有 Gemini
                系的模型挂这个分类才听得到声音。
              </p>
            </Field>
          )}

          {cats.includes("video") && (
            <Field label="视频识别提示词" hint="留空就用后端那句默认的">
              <textarea
                className={`${inputCls} min-h-[90px] resize-y leading-relaxed`}
                value={entry.videoPrompt ?? ""}
                onChange={(e) => patch({ videoPrompt: e.target.value })}
                placeholder={
                  defaultVideo || "例如：描述画面里有什么、发生了什么、出现过的文字…"
                }
              />
              {entry.videoPrompt && (
                <button
                  type="button"
                  onClick={() => patch({ videoPrompt: "" })}
                  className="mt-2 inline-flex items-center gap-1.5 text-meta text-ink-soft transition-colors duration-150 hover:text-ink"
                >
                  <Undo2 size={13} /> 清空，回到默认提示词
                </button>
              )}
              {/*
                * 这段说的是「能不能用」而不是「怎么写」。看视频这条路有两道坎，
                * 而第二道（中转站的体积闸）只有传一次才知道，所以必须在这儿指出来
                */}
              <p className="mt-2 text-meta leading-relaxed text-ink-faint">
                和听音同一条 Gemini 原生接口，所以同样只有 Gemini 系的模型看得到。
                另外体积这关跟中转站强相关：实测有的网关连 12MB 都直接拒，
                而它听语音是好的。右下角「传视频试试」传一段就知道这家行不行。
                真实聊天里超过 20MB 的视频不会下载。
              </p>
            </Field>
          )}

          {cats.includes("image") && (
            <>
              <Field
                label="生图正面提示词"
                hint="拼在画面描述前面，通常放风格词。留空就只发模型自己写的那段"
              >
                <textarea
                  className={`${inputCls} min-h-[70px] resize-y leading-relaxed`}
                  value={entry.imagePrompt ?? ""}
                  onChange={(e) => patch({ imagePrompt: e.target.value })}
                  placeholder="例如：masterpiece, best quality, 写实风格…"
                />
              </Field>
              <Field
                label="生图负面提示词"
                hint="走 negative_prompt 字段。中转站普遍认，不认的会忽略掉"
              >
                <textarea
                  className={`${inputCls} min-h-[70px] resize-y leading-relaxed`}
                  value={entry.negativePrompt ?? ""}
                  onChange={(e) => patch({ negativePrompt: e.target.value })}
                  placeholder="例如：lowres, bad anatomy, watermark…"
                />
              </Field>
              <Field
                label="出图比例"
                hint="size 和 aspect_ratio 两个字段一起发（各家认的不是同一个）。默认「不指定」就一个字都不传，和以前一样让模型用自己的默认尺寸"
              >
                <select
                  className={inputCls}
                  value={entry.imageRatio ?? ""}
                  onChange={(e) => patch({ imageRatio: e.target.value })}
                >
                  {/* 和服务端 config.js:IMAGE_RATIOS 对齐，加档位两处一起改 */}
                  {IMAGE_RATIOS.map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <p className="text-meta leading-relaxed text-ink-faint">
                  选了之后要是这个模型报「不支持这个尺寸」，退回「不指定」就行。
                </p>
              </Field>
              {imageData && (
                <img
                  src={`data:${imageData.mimeType};base64,${imageData.base64}`}
                  alt="测试出图结果"
                  className="max-h-[260px] w-auto rounded-item border border-line object-contain"
                />
              )}
            </>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-meta leading-relaxed text-ink-faint">
              测试会真发一次请求，不用先保存。
              {cats.includes("audio") &&
                "听音没有「空跑」的按钮 —— 识图能拿一张内置纯色图凑合，声音没有等价物，得自己传一段。"}
              {cats.includes("video") &&
                "看视频同理，得自己传一段；这一条尤其值得试，中转站吃不吃得下差别很大。"}
              {cats.includes("image") && "「测试出图」除外 —— 生图模型是全局挑的，要先保存。"}
              {cats.includes("embedding") &&
                "「测试向量」除外 —— 它测的是「记忆库 → 设置」里选中的那个向量模型，要先保存。"}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {cats.includes("vision") && (
                <>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={onPickFile}
                  />
                  <Button
                    variant="ghost"
                    onClick={() => fileRef.current?.click()}
                    disabled={testState === "loading"}
                  >
                    <Upload size={14} /> 传图试试
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => runVisionTest(null)}
                    disabled={testState === "loading"}
                  >
                    <ImageIcon size={14} /> 测试识图
                  </Button>
                </>
              )}
              {cats.includes("audio") && (
                <>
                  <input
                    ref={audioRef}
                    type="file"
                    accept="audio/*"
                    className="hidden"
                    onChange={onPickAudio}
                  />
                  <Button
                    variant="outline"
                    onClick={() => audioRef.current?.click()}
                    disabled={testState === "loading"}
                  >
                    <Mic size={14} /> 传语音试试
                  </Button>
                </>
              )}
              {cats.includes("video") && (
                <>
                  <input
                    ref={videoRef}
                    type="file"
                    accept="video/*"
                    className="hidden"
                    onChange={onPickVideo}
                  />
                  <Button
                    variant="outline"
                    onClick={() => videoRef.current?.click()}
                    disabled={testState === "loading"}
                  >
                    <Clapperboard size={14} /> 传视频试试
                  </Button>
                </>
              )}
              {cats.includes("image") && (
                <Button
                  variant="outline"
                  onClick={runImageTest}
                  disabled={testState === "loading"}
                >
                  <ImageIcon size={14} /> 测试出图
                </Button>
              )}
              {cats.includes("embedding") && (
                <Button
                  variant="outline"
                  onClick={runEmbeddingTest}
                  disabled={testState === "loading"}
                >
                  <Brain size={14} /> 测试向量
                </Button>
              )}
              <Button variant="outline" onClick={runTest} disabled={testState === "loading"}>
                {testState === "loading" ? (
                  <RefreshCw size={14} className="animate-spin" />
                ) : (
                  <Zap size={14} />
                )}
                {testState === "loading" ? "测试中…" : "测试连接"}
              </Button>
            </div>
          </div>

          <ResultNote state={testState} message={testMsg} />
        </div>
      )}
    </div>
  );
}

/** 右下「模型」区：计数 + 搜索 + 获取列表 / 自定义 + 已配置的模型。 */
export function ModelSection({ provider, defaultPrompt, defaultAudio, defaultVideo }) {
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState(null); // null | "list" | "custom"

  const models = provider.models ?? [];
  const enabledCount = models.filter((m) => m.enabled).length;

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? models.filter(
          (m) =>
            m.model.toLowerCase().includes(q) ||
            (m.alias ?? "").toLowerCase().includes(q)
        )
      : models;
    // 置顶的排前面，其余保持用户加进来的顺序
    return [...list].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
  }, [models, query]);

  return (
    <Card title="模型" desc={`可用模型 ${enabledCount} / ${models.length}`}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={() => setDialog("list")}
            disabled={!provider.url?.trim()}
          >
            <Download size={14} /> 获取模型列表
          </Button>
          <Button variant="ghost" onClick={() => setDialog("custom")}>
            <Pencil size={14} /> 自定义模型
          </Button>
        </div>
      }
    >
      {!provider.url?.trim() && (
        <p className="mb-6 border-l-2 border-line py-1.5 pl-3 text-meta leading-relaxed text-ink-soft">
          先把上面的 API Base URL 填了，才能拉模型列表。
        </p>
      )}

      {models.length > 0 && (
        <div className="mb-4 flex items-center gap-2 border-b border-line pb-2">
          <Search size={14} className="shrink-0 text-ink-faint" />
          <input
            className="w-full bg-transparent text-ui text-ink outline-none placeholder:text-ink-meta"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索模型或 ID"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="清空搜索"
              className="shrink-0 text-ink-faint transition-colors duration-150 hover:text-ink"
            >
              <X size={14} />
            </button>
          )}
        </div>
      )}

      <div className="grid grid-cols-1">
        {models.length === 0 && (
          <p className="max-w-[62ch] text-body leading-relaxed text-ink-soft">
            还没有模型。点「获取模型列表」从这条线路拉，或者「自定义模型」手填一个。
          </p>
        )}
        {models.length > 0 && shown.length === 0 && (
          <p className="py-4 text-ui text-ink-faint">没有匹配的模型</p>
        )}
        {shown.map((m) => (
          <ModelRow
            key={m.id}
            provider={provider}
            entry={m}
            defaultPrompt={defaultPrompt}
            defaultAudio={defaultAudio}
            defaultVideo={defaultVideo}
          />
        ))}
      </div>

      {dialog === "list" && (
        <ModelListDialog provider={provider} onClose={() => setDialog(null)} />
      )}
      {dialog === "custom" && (
        <CustomModelDialog provider={provider} onClose={() => setDialog(null)} />
      )}
    </Card>
  );
}

/** 右上「设置」区：ID / 显示名 / 密钥（可多把）/ Base URL。 */
export function ProviderSettings({ provider }) {
  const { config, updateProvider, addProviderKey, updateProviderKey, removeProviderKey } =
    useConfig();
  const keys = provider.keys ?? [""];
  const typeMeta = providerTypeOf(provider);

  // 引用了这个源的角色 —— 改 ID 会让它们的引用失效，先说清楚
  const users = (config.roles ?? []).filter((r) =>
    [r.chatModel, r.fallbackModel, r.visionModel, r.audioModel, r.videoModel].some(
      (ref) => ref?.provider === provider.id
    )
  );

  return (
    <Card title="服务商源" desc="地址和密钥填一次，下面的模型都走这条线路">
      <div className="grid grid-cols-1 gap-6">
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <Field label="ID" hint="这个源的唯一标识">
            <input
              className={inputCls}
              value={provider.id}
              onChange={(e) => updateProvider(provider.id, { id: e.target.value })}
              placeholder="gg"
            />
          </Field>
          <Field label="显示名" hint="可留空，留空就显示 ID">
            <input
              className={inputCls}
              value={provider.name ?? ""}
              onChange={(e) => updateProvider(provider.id, { name: e.target.value })}
              placeholder={provider.id}
            />
          </Field>
        </div>

        {users.length > 0 && (
          <p className="border-l-2 border-line py-1.5 pl-3 text-meta leading-relaxed text-ink-soft">
            {users.map((r) => roleLabel(r)).join("、")} 正在用这个源。改 ID
            等于换一个源，它们会提示「引用的服务商已删除」，需要重新挑一次模型。
          </p>
        )}

        <Field label="API 类型" hint={typeMeta.desc}>
          <ProviderTypeButtons
            value={typeMeta.id}
            onChange={(type) =>
              updateProvider(provider.id, { type, url: urlForType(provider.url, type) })
            }
          />
        </Field>

        <Field label="API Base URL" hint={typeMeta.urlHint}>
          <input
            className={inputCls}
            value={provider.url ?? ""}
            onChange={(e) => updateProvider(provider.id, { url: e.target.value })}
            placeholder={typeMeta.placeholder}
          />
        </Field>

        <Field label="API Key" hint={keys.length > 1 ? `${keys.length} 把，轮着用` : "本地保存"}>
          <div className="grid grid-cols-1 gap-2">
            {keys.map((k, i) => (
              <div key={i} className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <SecretInput
                    value={k}
                    onChange={(v) => updateProviderKey(provider.id, i, v)}
                    placeholder={typeMeta.keyPlaceholder}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => removeProviderKey(provider.id, i)}
                  aria-label="删除这把密钥"
                  className="shrink-0 rounded-item p-2 text-ink-faint transition-colors duration-150 hover:bg-sunken hover:text-warn"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => addProviderKey(provider.id)}
            className="link-slide mt-3 inline-flex items-center gap-1.5 text-meta text-ink"
          >
            <Plus size={13} /> 添加更多
          </button>
          <p className="mt-3 text-meta leading-relaxed text-ink-faint">
            填多把密钥会轮着用，分摊中转站的每分钟限流。
          </p>
        </Field>
      </div>
    </Card>
  );
}

/**
 * 「语音合成（TTS）」那张卡。
 *
 * 放在「连接」面板而不是角色面板，理由是四家 × 各自好几个字段实在太长 ——
 * 角色那边只有开关和音色 ID（见 role.jsx:RoleVoiceFields，它链到这里来）。
 * 密钥和搜索、天气一样**全局一份**：backup.js 把 roles 原样拷进不含密钥的备份，
 * 挂在角色上会从那儿漏出去。
 *
 * 默认折叠 —— 它是全局配置，不该在选中某个服务商源的时候喧宾夺主。
 */
export function TtsSection() {
  const { config, savedConfig, updateTtsApi } = useConfig();
  const tts = config.ttsApi ?? {};
  const mm = tts.minimax ?? {};
  const el = tts.elevenlabs ?? {};
  const fa = tts.fish ?? {};
  const sv = tts.sovits ?? {};

  const [testState, setTestState] = useState("idle");
  const [testMsg, setTestMsg] = useState("");
  // 合成结果直接挂个 <audio> 试听 —— 音色对不对、语速怎么样，只有耳朵能判
  const [audioData, setAudioData] = useState(null);
  // 试听用哪个音色。留空 = 让那家自己用默认音色
  const [voiceId, setVoiceId] = useState("");

  const blank = (v) => !String(v ?? "").trim();

  // 和 server/src/media.js:pickTtsSource 同一个顺序和判据，三处一起改
  // （另一处在 role.jsx:RoleVoiceFields，那边只是显示当前生效的是哪家）
  const source = !blank(mm.key) && mm.enabled
    ? "MiniMax"
    : !blank(el.key) && el.enabled
    ? "ElevenLabs"
    : !blank(fa.key) && fa.enabled
    ? "Fish Audio"
    : !blank(sv.url) && sv.enabled
    ? "GPT-SoVITS"
    : "";

  const saved = savedConfig?.ttsApi ?? {};
  const dirty =
    String(mm.key ?? "") !== String(saved.minimax?.key ?? "") ||
    String(mm.groupId ?? "") !== String(saved.minimax?.groupId ?? "") ||
    String(el.key ?? "") !== String(saved.elevenlabs?.key ?? "") ||
    String(fa.key ?? "") !== String(saved.fish?.key ?? "") ||
    String(sv.url ?? "") !== String(saved.sovits?.url ?? "");

  /**
   * 试合成一条。
   *
   * **必须先保存** —— 后端那条路由不收请求体里的凭据（不让密钥进请求日志），
   * 一律从已保存的配置读。所以刚填完还没点保存的话，测的是旧的那份。
   */
  async function runTtsTest() {
    setTestState("loading");
    setTestMsg("正在合成…");
    setAudioData(null);
    try {
      const r = await api("/api/tts/test", { method: "POST", body: { voiceId } });
      setTestState("ok");
      setTestMsg(`${r.source} 合成成功（${r.ms}ms）。听一下音色对不对。`);
      setAudioData({ base64: r.base64, mimeType: r.mimeType });
    } catch (e) {
      setTestState("fail");
      setTestMsg(String(e?.message ?? e));
    }
  }

  return (
    <Card title="语音合成（TTS）" desc="角色发语音条用的。全局一份，所有角色共用">
      <Fold
        title="四家 TTS"
        badge={source || "未启用"}
        desc={
          source
            ? `现在用的是 ${source}。密钥只写入本地 data.config.json，不进备份文件。`
            : "一家都没开。角色那边的「发语音」开关现在不起作用 —— 模型写的语音标记会退化成普通文字发出去。"
        }
      >
        <div className="grid grid-cols-1 gap-6">
          <p className="max-w-[62ch] text-meta leading-relaxed text-ink-faint">
            几家都开着时按
            <strong className="text-ink-soft"> MiniMax → ElevenLabs → Fish Audio → GPT-SoVITS </strong>
            挑第一个凭据填齐的。角色那边只填
            <strong className="text-ink-soft">音色 ID</strong>
            （不是密钥，跟着角色文件分享出去也没关系），提示词的措辞在「预设 →
            消息格式与功能」里改。
            <br />
            iMessage 的语音条只吃 m4a，而这几家出的是 mp3 / wav —— 转码走项目自带的
            ffmpeg-static，<strong className="text-ink-soft">你不用自己装 ffmpeg</strong>。
          </p>

          {/* ---------- MiniMax ---------- */}
          <label className="flex items-start justify-between gap-4 border-t border-line pt-5">
            <span className="min-w-0">
              <span className="block text-ui text-ink">MiniMax</span>
              <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                中文音色多，也支持克隆音色。音色 ID 填
                <code className="mx-1 bg-sunken px-1">male-qn-qingse</code>
                这类音色名，或者你自己克隆出来的那个 ID。
              </span>
            </span>
            <Switch
              checked={Boolean(mm.enabled)}
              onChange={(v) => updateTtsApi({ minimax: { ...mm, enabled: v } })}
              label="启用 MiniMax"
            />
          </label>
          {mm.enabled && (
            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              <Field label="API Key">
                <SecretInput
                  value={mm.key}
                  onChange={(v) => updateTtsApi({ minimax: { ...mm, key: v } })}
                  placeholder="填你自己的 API Key"
                />
              </Field>
              <Field label="GroupId" hint="少了它直接 401 —— 它走查询参数，不在请求头里">
                <input
                  className={`${inputCls} ${blank(mm.groupId) ? "border-warn text-warn" : ""}`}
                  value={mm.groupId ?? ""}
                  onChange={(e) => updateTtsApi({ minimax: { ...mm, groupId: e.target.value } })}
                  placeholder="控制台里那串数字"
                />
              </Field>
              <Field label="模型">
                <input
                  className={inputCls}
                  value={mm.model ?? ""}
                  onChange={(e) => updateTtsApi({ minimax: { ...mm, model: e.target.value } })}
                  placeholder="speech-02-hd"
                />
              </Field>
              <ParamSlider
                label="语速"
                hint="1 是原速，往下调更慢、往上调更快。范围 0.5–2。"
                min={0.5}
                max={2}
                step={0.05}
                value={mm.speed ?? 1}
                onChange={(v) => updateTtsApi({ minimax: { ...mm, speed: v } })}
              />
              {/*
                * 国内号和海外号是两套互不通用的域名，密钥也不通用。
                * 填错站了上游报的是鉴权失败，不会说「你填错站了」——
                * 所以这里是二选一，域名由 media.js:MINIMAX_HOSTS 拼。
                */}
              <Field
                label="账号所在地区"
                hint={
                  mm.host
                    ? `你配了自建地址 ${mm.host}，以它为准，这两个选项不起作用`
                    : "两边的账号和密钥不通用。选错了会报鉴权失败"
                }
              >
                <div className="flex gap-2">
                  {[
                    { id: "domestic", label: "国内", host: "api.minimaxi.com" },
                    { id: "global", label: "国外", host: "api.minimax.io" },
                  ].map((r) => {
                    const on = (mm.region ?? "domestic") === r.id;
                    return (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => updateTtsApi({ minimax: { ...mm, region: r.id } })}
                        className={`flex-1 border px-3 py-2 text-left transition-colors duration-150 ${
                          on
                            ? "border-ink bg-sunken text-ink"
                            : "border-line text-ink-faint hover:text-ink"
                        }`}
                      >
                        <span className="block text-ui">{r.label}</span>
                        <span className="mt-0.5 block font-mono text-eyebrow text-ink-meta">
                          {r.host}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </Field>
            </div>
          )}

          {/* ---------- ElevenLabs ---------- */}
          <label className="flex items-start justify-between gap-4 border-t border-line pt-5">
            <span className="min-w-0">
              <span className="block text-ui text-ink">ElevenLabs</span>
              <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                英文最自然，多语种模型也能说中文。音色 ID 填它的 voice_id（
                <code className="mx-1 bg-sunken px-1">21m00Tcm4TlvDq8ikWAM</code>
                这样的一串）。
              </span>
            </span>
            <Switch
              checked={Boolean(el.enabled)}
              onChange={(v) => updateTtsApi({ elevenlabs: { ...el, enabled: v } })}
              label="启用 ElevenLabs"
            />
          </label>
          {el.enabled && (
            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              <Field label="API Key">
                <SecretInput
                  value={el.key}
                  onChange={(v) => updateTtsApi({ elevenlabs: { ...el, key: v } })}
                  placeholder="填你自己的 API Key"
                />
              </Field>
              <Field label="模型">
                <input
                  className={inputCls}
                  value={el.model ?? ""}
                  onChange={(e) => updateTtsApi({ elevenlabs: { ...el, model: e.target.value } })}
                  placeholder="eleven_multilingual_v2"
                />
              </Field>
              {/* 这三个是 ElevenLabs 自己的 voice_settings，原样发过去 */}
              <ParamSlider
                label="Stability"
                hint="声音稳不稳。调低更活、更像人，也更容易飘；调高更平、更稳。默认 0.5。"
                min={0}
                max={1}
                step={0.05}
                value={el.stability ?? 0.5}
                onChange={(v) => updateTtsApi({ elevenlabs: { ...el, stability: v } })}
              />
              <ParamSlider
                label="Similarity boost"
                hint="像不像原音色。调高更贴原音，但太高会把底噪一起放大。默认 0.75。"
                min={0}
                max={1}
                step={0.05}
                value={el.similarityBoost ?? 0.75}
                onChange={(v) => updateTtsApi({ elevenlabs: { ...el, similarityBoost: v } })}
              />
              <ParamSlider
                label="Style（风格夸张度）"
                hint="情绪起伏。调高语气更夸张、更有戏，也更容易念错字和跑偏，合成还会变慢。0 = 关，这时候压根不发这个参数；eleven_v3 不认它。默认 0。"
                min={0}
                max={1}
                step={0.05}
                value={el.style ?? 0}
                onChange={(v) => updateTtsApi({ elevenlabs: { ...el, style: v } })}
              />
            </div>
          )}

          {/* ---------- Fish Audio ---------- */}
          <label className="flex items-start justify-between gap-4 border-t border-line pt-5">
            <span className="min-w-0">
              <span className="block text-ui text-ink">Fish Audio</span>
              <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                中英日都自然，社区音色多，也能克隆。音色 ID 填音色页地址里那串 32 位的
                reference_id。S2 系模型认
                <code className="mx-1 bg-sunken px-1">[whisper]</code>
                这类方括号语气标签，会原样交给它念。
              </span>
            </span>
            <Switch
              checked={Boolean(fa.enabled)}
              onChange={(v) => updateTtsApi({ fish: { ...fa, enabled: v } })}
              label="启用 Fish Audio"
            />
          </label>
          {fa.enabled && (
            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              <Field label="API Key">
                <SecretInput
                  value={fa.key}
                  onChange={(v) => updateTtsApi({ fish: { ...fa, key: v } })}
                  placeholder="填你自己的 API Key"
                />
              </Field>
              <Field label="模型" hint="留空用官方默认（目前是 s2.1-pro）。可填 s1 / s2-pro / s2.1-pro">
                <input
                  className={inputCls}
                  value={fa.model ?? ""}
                  onChange={(e) => updateTtsApi({ fish: { ...fa, model: e.target.value } })}
                  placeholder="s2.1-pro"
                />
              </Field>
              <Field label="兜底音色 ID" hint="角色没填音色 ID 时用这个。两处都空就用 Fish 的默认音色">
                <input
                  className={inputCls}
                  value={fa.referenceId ?? ""}
                  onChange={(e) => updateTtsApi({ fish: { ...fa, referenceId: e.target.value } })}
                  placeholder="reference_id"
                />
              </Field>
              <ParamSlider
                label="语速"
                hint="1 是原速，往下调更慢、往上调更快。范围 0.5–2。"
                min={0.5}
                max={2}
                step={0.05}
                value={fa.speed ?? 1}
                onChange={(v) => updateTtsApi({ fish: { ...fa, speed: v } })}
              />
            </div>
          )}

          {/* ---------- GPT-SoVITS ---------- */}
          <label className="flex items-start justify-between gap-4 border-t border-line pt-5">
            <span className="min-w-0">
              <span className="block text-ui text-ink">GPT-SoVITS</span>
              <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                自己部署的那个（api_v2.py），不要密钥、不花钱，但要有一台跑着它的机器。
                角色的「音色 ID」在这家填的是
                <strong className="text-ink-soft">参考音频的路径</strong>。
              </span>
            </span>
            <Switch
              checked={Boolean(sv.enabled)}
              onChange={(v) => updateTtsApi({ sovits: { ...sv, enabled: v } })}
              label="启用 GPT-SoVITS"
            />
          </label>
          {sv.enabled && (
            <div className="grid grid-cols-1 gap-5">
              <Field label="接口地址" hint="api_v2.py 起在哪儿，末尾有没有斜杠都行">
                <input
                  className={`${inputCls} ${blank(sv.url) ? "border-warn text-warn" : ""}`}
                  value={sv.url ?? ""}
                  onChange={(e) => updateTtsApi({ sovits: { ...sv, url: e.target.value } })}
                  placeholder="http://127.0.0.1:9880"
                />
              </Field>
              <Field
                label="兜底参考音频路径"
                hint="角色没填音色 ID 时用这个。这家每次请求都要参考音频，一个都没有就合成不了"
              >
                <input
                  className={inputCls}
                  value={sv.refAudioPath ?? ""}
                  onChange={(e) => updateTtsApi({ sovits: { ...sv, refAudioPath: e.target.value } })}
                  placeholder="/path/to/ref.wav"
                />
              </Field>
              <Field label="参考音频里说的那句话" hint="填参考音频的原文，它靠这个对齐音色">
                <input
                  className={inputCls}
                  value={sv.promptText ?? ""}
                  onChange={(e) => updateTtsApi({ sovits: { ...sv, promptText: e.target.value } })}
                  placeholder="参考音频里念的内容"
                />
              </Field>
              <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                <Field label="参考音频的语言" hint="zh / en / ja …">
                  <input
                    className={inputCls}
                    value={sv.promptLang ?? ""}
                    onChange={(e) => updateTtsApi({ sovits: { ...sv, promptLang: e.target.value } })}
                    placeholder="zh"
                  />
                </Field>
                <Field label="要合成的语言" hint="zh / en / ja …">
                  <input
                    className={inputCls}
                    value={sv.textLang ?? ""}
                    onChange={(e) => updateTtsApi({ sovits: { ...sv, textLang: e.target.value } })}
                    placeholder="zh"
                  />
                </Field>
              </div>
            </div>
          )}

          {/* ---------- 试听 ---------- */}
          <div className="grid grid-cols-1 gap-4 border-t border-line pt-5">
            <Field
              label="试听用的音色 ID（可留空）"
              hint="留空就用那家的默认音色。这里填什么不影响角色的配置，只影响这一次试听"
            >
              <input
                className={inputCls}
                value={voiceId}
                onChange={(e) => setVoiceId(e.target.value)}
                placeholder={
                  source === "GPT-SoVITS"
                    ? "/path/to/ref.wav"
                    : source === "ElevenLabs"
                    ? "21m00Tcm4TlvDq8ikWAM"
                    : source === "Fish Audio"
                    ? "reference_id"
                    : "male-qn-qingse"
                }
              />
            </Field>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="max-w-[52ch] text-meta leading-relaxed text-ink-faint">
                {dirty ? (
                  <strong className="text-warn">
                    有凭据还没保存 —— 测试读的是已保存的那份，先点保存再测。
                  </strong>
                ) : (
                  "测试会真发一次请求（按字数计费，这句话很短）。合成出来直接在下面试听。"
                )}
              </p>
              <Button variant="outline" onClick={runTtsTest} disabled={testState === "loading" || !source}>
                {testState === "loading" ? (
                  <RefreshCw size={14} className="animate-spin" />
                ) : (
                  <Zap size={14} />
                )}
                {testState === "loading" ? "合成中…" : "测试合成"}
              </Button>
            </div>

            <ResultNote state={testState} message={testMsg} />

            {audioData && (
              /* eslint-disable-next-line jsx-a11y/media-has-caption */
              <audio
                controls
                className="w-full max-w-[420px]"
                src={`data:${audioData.mimeType};base64,${audioData.base64}`}
              />
            )}
          </div>
        </div>
      </Fold>
    </Card>
  );
}

/**
 * 「输出方式」那张卡 —— 线下模式是边生成边看还是整段等完。
 *
 * 和 TTS 一样放在「连接」面板、**全局一份**：能不能流取决于你到上游那一段
 * 管子（中转站、自建反代、公司网关），换个角色不会变。
 *
 * 只管**线下模式**。iMessage 那条路要等模型把整段写完才知道拆成几条气泡、
 * 每条隔多久发，中间那半截没地方放。
 */
export function StreamSection() {
  const { config, updateStream } = useConfig();
  const mode = config.stream?.mode ?? "auto";

  const modes = [
    {
      id: "auto",
      label: "跟随模型",
      hint: "按流式发。上游要是不给流（假流式的反代、不支持的中转），自动当整段收下",
    },
    { id: "on", label: "流式", hint: "强制流式。上游不支持会自己退回整段，不会报错" },
    { id: "off", label: "非流式", hint: "等模型写完再整段显示，和以前一样" },
  ];

  return (
    <Card title="输出方式" desc="线下模式要不要边生成边看。全局一份，所有角色共用">
      <div className="grid grid-cols-1 gap-4">
        <Field label="线下模式的输出" hint="不影响 iMessage —— 那边要等整段写完才知道拆几条气泡">
          <div className="flex flex-col gap-2 sm:flex-row">
            {modes.map((m) => {
              const on = mode === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => updateStream({ mode: m.id })}
                  className={`flex-1 border px-3 py-2 text-left transition-colors duration-150 ${
                    on
                      ? "border-ink bg-sunken text-ink"
                      : "border-line text-ink-faint hover:text-ink"
                  }`}
                >
                  <span className="block text-ui">{m.label}</span>
                  <span className="mt-0.5 block text-eyebrow leading-relaxed text-ink-meta">
                    {m.hint}
                  </span>
                </button>
              );
            })}
          </div>
        </Field>
        <p className="max-w-[62ch] text-meta leading-relaxed text-ink-faint">
          流式只改「什么时候看到字」。存档、正则、摘选项、记忆库那些一个字都不变 ——
          落盘存的永远是模型的原文。生成中途按「停下」在任何一档都是当场断。
        </p>
      </div>
    </Card>
  );
}

export function ProviderPanel() {
  const { config } = useConfig();
  const providers = config.providers ?? [];
  const { itemId } = useSection();
  const defaultPrompt = useDefaultVisionPrompt();
  const defaultAudio = useDefaultAudioPrompt();
  const defaultVideo = useDefaultVideoPrompt();

  /*
   * 这个面板的 ID 是可编辑的（`ProviderSettings` 里那个输入框），
   * 改完之后侧栏记着的 itemId 就指不到人了 —— 所以退到第一个，
   * 不能像其他面板那样直接显示空状态。
   */
  const provider = providers.find((p) => p.id === itemId) ?? providers[0] ?? null;

  /*
   * TTS 和输出方式这两张卡在两条路上都要出现：它们是全局配置，不挂在任何一个
   * 服务商源底下，一个源都还没建的时候也该能填（自建的 GPT-SoVITS 根本不需要
   * 服务商源）。
   */
  if (!provider) {
    return (
      <>
        <Card title="服务商源">
          <p className="max-w-[62ch] text-body text-ink-soft">
            左边还没有服务商源。点列表标题旁的「+」新建一个，把它的地址和密钥填进来。
          </p>
        </Card>
        <TtsSection />
        <StreamSection />
        <SaveBar hint="所有源的密钥都只写入本地 data.config.json" />
      </>
    );
  }

  return (
    <>
      <ProviderSettings provider={provider} />
      <ModelSection
        provider={provider}
        defaultPrompt={defaultPrompt}
        defaultAudio={defaultAudio}
        defaultVideo={defaultVideo}
      />
      <TtsSection />
      <StreamSection />
      <SaveBar hint="所有源的密钥都只写入本地 data.config.json" />
    </>
  );
}

/** 默认识图提示词。放后端那份，免得前后端各写一句对不上。 */
export function useDefaultVisionPrompt() {
  const [prompt, setPrompt] = useState("");
  useEffect(() => {
    api("/api/vision/default-prompt")
      .then((r) => setPrompt(r.prompt ?? ""))
      .catch(() => {});
  }, []);
  return prompt;
}

/**
 * 默认听音提示词，两套。和上面那个一样只是把后端那份取过来 ——
 * simple 是关掉「识别情绪与环境音」时用的（只转写），rich 是打开时用的
 * （六项结构化输出）。
 */
export function useDefaultAudioPrompt() {
  const [prompts, setPrompts] = useState({ simple: "", rich: "" });
  useEffect(() => {
    api("/api/audio/default-prompt")
      .then((r) => setPrompts({ simple: r.prompt ?? "", rich: r.rich ?? "" }))
      .catch(() => {});
  }, []);
  return prompts;
}

/**
 * 默认看视频提示词。只有一套 —— 听音那边的第二套是「识别情绪与环境音」开关
 * 带来的，视频本来就要求描述动作和先后顺序，没有对应的档位。
 */
export function useDefaultVideoPrompt() {
  const [prompt, setPrompt] = useState("");
  useEffect(() => {
    api("/api/video/default-prompt")
      .then((r) => setPrompt(r.prompt ?? ""))
      .catch(() => {});
  }, []);
  return prompt;
}
