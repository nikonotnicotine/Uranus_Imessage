import { useMemo, useState } from "react";
import {
  ENTRY_KIND_HINTS,
  ENTRY_ROLES,
  ENTRY_ROLE_LABELS,
  FORMAT_CHILD_KINDS,
  FORMAT_CHILD_LABELS,
  FORMAT_CHILD_TAGS,
  FORMAT_CHILD_UNWIRED,
  PRESET_MODES,
  PRESET_MODE_LABELS,
  ROLE_GATED_CHILDREN,
  entryLabel,
  presetMode,
  regexActionText,
  regexAlternatives,
  regexBlockReason,
  regexLabel,
  regexScopeText,
  resolvePreset,
  roleLabel,
} from "../labels.js";
import { SaveBar, useSection } from "../section.jsx";
import { useConfig, regexActionOf, sortRegexRules } from "../store.jsx";
import { TransferCard } from "./transfer.jsx";
import {
  Button,
  Card,
  DragHandle,
  DragRow,
  Field,
  Fold,
  MoveButtons,
  NumberField,
  Slider,
  Switch,
  inputCls,
} from "../ui.jsx";
import { Pencil, Plus, Trash2 } from "lucide-react";

/**
 * 压着角色开关的那几条，各自在角色面板上叫什么、为什么要压这道闸。
 *
 * 每条的开关名和理由都不一样，一句话套不下来（原来那句写死了「联网搜索」，
 * 语音和图片接上链路之后就对不上了）。key 和 labels.js:ROLE_GATED_CHILDREN 一致。
 */
const GATED_CHILD_HINTS = {
  search: { switch: "联网搜索", why: "搜索会往外发请求、还要多花一轮生成" },
  voice: { switch: "发语音", why: "合成语音要打 TTS 的接口，按字数计费" },
  image: { switch: "生成图片", why: "出图要打生图模型，一张一张地花钱" },
  leaveOnRead: { switch: "已读不回", why: "开了之后角色可能干脆不回你消息" },
  sticker: { switch: "发送表情包", why: "发出去的是你自己电脑上的图" },
  card: { switch: "分享链接卡片", why: "卡片点一下就会打开，网址编错了收不回来（点歌也走这个开关）" },
  location: { switch: "分享位置", why: "会告诉对方自己在哪儿 —— 哪怕地名是编的，也是一条私事" },
  undoSend: { switch: "消息撤回", why: "撤回会真的从对方手机上收回消息" },
  react: { switch: "贴 Tapback", why: "贴上去的表情对方立刻能看到，收不回来" },
  effect: { switch: "文字效果", why: "全屏特效会在对方整个屏幕上放动画" },
  instagram: { switch: "启用 Instagram", why: "发出去的帖子和快拍是公开的，而且没开的角色压根没有这个账号" },
  // 查岗那儿是**两个**开关（电脑腿 / 手机腿），只开一条的话提示词里另一条腿的
  // 标签会被裁掉（见 server/src/spy.js:trimSpyPrompt），所以这里写成两个都提
  spy: {
    switch: "电脑查岗 / 手机查岗",
    why: "会把你自己屏幕上的东西抓下来打给视觉模型 —— 两条腿各一个开关，只开一条时另一条的标签不会注入",
  },
};

/** 参数滑块 + 右边一个数字，两边同步。 */
export function ParamSlider({ label, hint, value, min, max, step, onChange, digits = 2 }) {
  return (
    <Field label={label} hint={hint}>
      <div className="flex items-center gap-3">
        <Slider min={min} max={max} step={step} value={value} onChange={onChange} />
        <span className="w-12 shrink-0 text-right font-mono text-ui text-ink-soft">
          {Number(value).toFixed(digits)}
        </span>
      </div>
    </Field>
  );
}

/** 预设面板：卡片列表 → 详情。 */
export function PresetPanel({ onGoto }) {
  const { config } = useConfig();
  const { itemId, pick } = useSection();
  const presets = config.presets ?? [];
  const open = presets.find((p) => p.id === itemId) ?? null;

  if (!open) {
    return (
      <Card title="预设">
        {presets.length ? (
          <div className="grid max-w-[62ch] grid-cols-1 gap-4">
            <p className="text-body text-ink-soft">
              左边挑一份预设，改提示词顺序、生成参数和正则。
            </p>
            <p className="text-meta leading-relaxed text-ink-faint">
              没给角色选预设时，用排在第一份的那个。去「角色 → 单独配置」里挑。
            </p>
            <p className="text-meta leading-relaxed text-ink-faint">
              每份预设分线上和线下两种，在它的「基本信息」里切。线上给 iMessage
              聊天用，线下给「对话框」里演剧情用 —— 角色两边各选一份，两批不串。
            </p>
          </div>
        ) : (
          <div className="grid max-w-[62ch] grid-cols-1 gap-4">
            <p className="text-body text-ink-soft">
              还没有预设。一份都没有时会用内置的默认预设发消息 —— 能跑，但改不了。
            </p>
            <p className="text-meta leading-relaxed text-ink-faint">
              点列表标题旁的「+」新建一份，就能调温度、排提示词顺序、加正则了。
            </p>
          </div>
        )}
      </Card>
    );
  }

  return <PresetDetail preset={open} onBack={() => pick("")} onGoto={onGoto} />;
}

export function PresetDetail({ preset, onBack, onGoto }) {
  const { config, updatePreset, updatePresetParams, removePreset, exportPreset, importPreset } =
    useConfig();
  const { pick } = useSection();
  const p = preset.params ?? {};
  const mode = presetMode(preset);
  const offline = mode === "offline";
  /*
   * 「谁在用它」得按这份预设自己的 mode 去问：线下预设看的是
   * `role.offline.presetRef`，拿线上那一路去查会永远显示「还没有角色用它」。
   */
  const users = (config.roles ?? []).filter(
    (r) => resolvePreset(config, r, mode)?.id === preset.id
  );

  function drop() {
    removePreset(preset.id);
    onBack();
  }

  return (
    <div className="grid grid-cols-1 gap-rhythm-sm lg:gap-rhythm">
      <Card title="基本信息" desc="名字只影响界面和日志显示；线上还是线下决定它能被谁选">
        <div className="grid grid-cols-1 gap-6">
          <Field label="预设名称">
            <input
              className={inputCls}
              value={preset.name}
              onChange={(e) => updatePreset(preset.id, { name: e.target.value })}
              placeholder="例如：日常闲聊、剧情模式"
            />
          </Field>

          {/*
           * 线上 / 线下。两批预设不串 —— 角色在「单独配置」里只能选线上那批，
           * 在「线下模式」里只能选线下那批。切过来之后条目列表会跟着变
           * （线下多一条「用户选项」，切回线上时那条降成自定义条目留着）。
           */}
          <Field
            label="用在哪种玩法"
            hint="线上 = iMessage 上发消息；线下 = 「对话框」里演剧情。同一份预设只能属于一边"
          >
            <div className="flex flex-wrap gap-2">
              {PRESET_MODES.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => updatePreset(preset.id, { mode: m })}
                  className={`rounded-item border px-3 py-1.5 text-ui transition-colors duration-150 ${
                    mode === m
                      ? "border-ink bg-ink text-paper"
                      : "border-line text-ink-soft hover:bg-sunken hover:text-ink"
                  }`}
                >
                  {PRESET_MODE_LABELS[m]}预设
                </button>
              ))}
            </div>
          </Field>
          {offline && (
            <p className="border-l-2 border-line py-1.5 pl-3 text-meta leading-relaxed text-ink-faint">
              线下预设里的<span className="text-ink-soft">「消息格式与功能」整条不生效</span>
              （拼提示词时会无条件跳过）—— 线下不发气泡，也没有语音 / 表情包 / 撤回那一套，
              这就是「线下模式自动关闭消息格式与功能」的落点。世界书走的是角色
              「线下模式」里单独选的那几本，加上全局常开的那些。
            </p>
          )}

          <p className="text-meta leading-relaxed text-ink-faint">
            {users.length ? (
              <>
                在用的角色：{users.map(roleLabel).join("、")}。
                <button
                  type="button"
                  onClick={() => onGoto?.("role")}
                  className="link-slide ml-1 text-ink"
                >
                  去「角色」面板
                </button>
              </>
            ) : (
              <>
                还没有角色用它。
                <button
                  type="button"
                  onClick={() => onGoto?.("role")}
                  className="link-slide ml-1 text-ink"
                >
                  {offline ? "去「角色 → 线下模式」里挑" : "去「角色 → 单独配置」里挑"}
                </button>
              </>
            )}
          </p>
        </div>
      </Card>

      <Fold
        title="生成参数"
        desc="发给模型的 temperature / top_p / max_tokens / penalty。主 API 和副 API 共用同一份"
        badge={`温度 ${p.temperature ?? 0.7}`}
      >
        <div className="grid grid-cols-1 gap-6">
          <ParamSlider
            label="温度"
            hint="越高越发散，越低越稳。以前在角色的模型配置里"
            value={p.temperature ?? 0.7}
            min={0}
            max={2}
            step={0.05}
            onChange={(v) => updatePresetParams(preset.id, { temperature: v })}
          />
          <ParamSlider
            label="Top P"
            hint="核采样。一般只调温度和它其中一个"
            value={p.topP ?? 1}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => updatePresetParams(preset.id, { topP: v })}
          />
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            <ParamSlider
              label="频率惩罚"
              hint="压制重复用词"
              value={p.frequencyPenalty ?? 0}
              min={-2}
              max={2}
              step={0.1}
              onChange={(v) => updatePresetParams(preset.id, { frequencyPenalty: v })}
            />
            <ParamSlider
              label="存在惩罚"
              hint="鼓励换新话题"
              value={p.presencePenalty ?? 0}
              min={-2}
              max={2}
              step={0.1}
              onChange={(v) => updatePresetParams(preset.id, { presencePenalty: v })}
            />
          </div>
          <NumberField
            label="最大 token"
            value={p.maxTokens ?? 0}
            min={0}
            max={200000}
            step={64}
            onChange={(v) => updatePresetParams(preset.id, { maxTokens: v })}
            hint="0 = 不发这个字段，交给上游默认"
            suffix="token"
          />
          <p className="text-meta leading-relaxed text-ink-faint">
            这几项按「填了才发」的规则打给上游 —— 有些中转站对 top_p / penalty
            挑食，没动过的字段不会出现在请求里。
          </p>
        </div>
      </Fold>

      <PresetEntriesFold preset={preset} onGoto={onGoto} />
      <PresetRegexFold preset={preset} onGoto={onGoto} />

      {/* 导进来的是新的一份，导完直接切过去 —— 好改名、好看一眼对不对 */}
      <TransferCard
        what="这份预设"
        onExport={() => exportPreset(preset)}
        onImport={importPreset}
        onDone={(made) => pick(made.id)}
      />

      <Card title="删除这份预设" desc="指向它的角色会退回用第一份预设，不会自动改配置">
        <div className="grid grid-cols-1 gap-3">
          <SaveBar hint="只影响这份预设" />
          <div className="flex justify-end">
            <Button variant="ghost" onClick={drop} className="text-warn hover:bg-warn/[0.08]">
              <Trash2 size={14} /> 删除预设
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

/** 条目列表：顺序就是拼提示词的顺序。 */
export function PresetEntriesFold({ preset, onGoto }) {
  const {
    addPresetEntry,
    movePresetEntry,
    reorderPresetEntry,
    updatePresetEntry,
    removePresetEntry,
  } = useConfig();
  const entries = preset.entries ?? [];
  const [editId, setEditId] = useState("");

  return (
    <Fold
      title="条目"
      desc="从上到下就是提示词的拼装顺序。固定条目的内容由程序填，能开关、能挪位置"
      badge={`${entries.filter((e) => e.enabled).length}/${entries.length} 开着`}
    >
      <div className="grid grid-cols-1 gap-4">
        <div className="grid grid-cols-1 gap-2">
          {entries.map((e, i) => (
            <DragRow
              key={e.id}
              id={e.id}
              index={i}
              onReorder={(id, to) => reorderPresetEntry(preset.id, id, to)}
              className="border border-line bg-paper transition-colors duration-150"
            >
              <div className="flex items-start gap-2 px-3 py-2.5">
                <DragHandle className="mt-1 shrink-0 text-ink-faint" />
                <MoveButtons
                  first={i === 0}
                  last={i === entries.length - 1}
                  onUp={() => movePresetEntry(preset.id, e.id, -1)}
                  onDown={() => movePresetEntry(preset.id, e.id, 1)}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span
                      className={`text-ui ${
                        e.enabled ? "text-ink" : "text-ink-faint line-through"
                      }`}
                    >
                      {entryLabel(e)}
                    </span>
                    {e.kind === "custom" ? (
                      <span className="rounded-item bg-sunken px-1.5 py-0.5 text-meta text-ink">
                        {ENTRY_ROLE_LABELS[e.role] ?? e.role} · 自定义
                      </span>
                    ) : (
                      <span className="rounded-item bg-sunken px-1.5 py-0.5 text-meta text-ink-faint">
                        固定
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-meta leading-relaxed text-ink-faint">
                    {e.kind === "custom"
                      ? (e.content?.trim()
                          ? `${e.content.trim().slice(0, 60)}${e.content.trim().length > 60 ? "…" : ""}`
                          : "内容是空的，这条不会占一条消息")
                      : ENTRY_KIND_HINTS[e.kind] ?? ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {(e.kind === "custom" ||
                    e.kind === "format" ||
                    e.kind === "onlineHistory" ||
                    e.kind === "userChoice") && (
                    <button
                      type="button"
                      onClick={() => setEditId(editId === e.id ? "" : e.id)}
                      aria-label="编辑内容"
                      className="rounded-item p-1.5 text-ink-faint transition-colors duration-150 hover:bg-sunken hover:text-ink"
                    >
                      <Pencil size={14} />
                    </button>
                  )}
                  {e.kind === "custom" && (
                    <button
                      type="button"
                      onClick={() => {
                        if (editId === e.id) setEditId("");
                        removePresetEntry(preset.id, e.id);
                      }}
                      aria-label="删除条目"
                      className="rounded-item p-1.5 text-ink-faint transition-colors duration-150 hover:bg-warn/[0.08] hover:text-warn"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                  <Switch
                    checked={Boolean(e.enabled)}
                    onChange={(v) => updatePresetEntry(preset.id, e.id, { enabled: v })}
                    label={`启用「${entryLabel(e)}」`}
                  />
                </div>
              </div>

              {editId === e.id && (
                <div className="border-t border-line px-3 py-3">
                  <PresetEntryEditor preset={preset} entry={e} onGoto={onGoto} />
                </div>
              )}
            </DragRow>
          ))}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-meta leading-relaxed text-ink-faint">
            拖动或用 ↑↓ 调顺序。相邻的同身份条目发出去时会合并成一条消息。
          </p>
          <Button variant="outline" onClick={() => setEditId(addPresetEntry(preset.id))}>
            <Plus size={15} /> 新增条目
          </Button>
        </div>

        <div className="grid grid-cols-1 gap-1.5 border-l-2 border-line py-1.5 pl-3 text-meta leading-relaxed text-ink-faint">
          <p>
            <span className="text-ink-soft">每类内容都包在 XML 标签里</span>
            ：人设 <code className="bg-sunken px-1">&lt;Character&gt;</code>、
            用户人设 <code className="bg-sunken px-1">&lt;User&gt;</code>、
            世界书 <code className="bg-sunken px-1">&lt;World_Info&gt;</code>、
            上文夹在 <code className="bg-sunken px-1">&lt;Chat_History&gt;</code> 之间。
            标签名是定死的，可移动条目不自动包 —— 想包自己在正文里写。
          </p>
          <p>
            <span className="text-ink-soft">人设是原样注入的</span>
            ，不再自动加「你是「谁」。」那句。想让模型知道自己叫什么，就在角色人设正文里写
            <code className="mx-1 bg-sunken px-1">{"{{char}}"}</code>。
          </p>
          <p>
            <span className="text-ink-soft">记忆模块</span>
            现在只是个占位 —— 开着也不会往提示词里塞任何内容，等后面接上记忆库才有用。
          </p>
          <p>
            <span className="text-ink-soft">世界书</span>
            这条关掉 = 整个世界书步骤跳过，连「按深度插入」的条目也不会注入。
          </p>
          <p>
            <span className="text-ink-soft">上下文</span>
            条目决定聊天记录插在哪儿，条数受角色的「上下文限制」约束。
          </p>
        </div>

        <SaveBar hint="只影响这份预设" />
      </div>
    </Fold>
  );
}

/** 展开某个条目后的编辑区（只有 custom 和 format 有内容可改）。 */
export function PresetEntryEditor({ preset, entry, onGoto }) {
  const { config, updatePresetEntry, updateFormatChild } = useConfig();
  const sep = config.chat?.separator ?? "";

  if (entry.kind === "format") {
    const children = entry.children ?? [];
    return (
      <div className="grid grid-cols-1 gap-4">
        <Field
          label="引言"
          hint={`整段包在 <消息格式与功能> 里；{{sep}} 会替换成气泡分隔符（现在是 ${sep || "（空）"}）`}
        >
          <textarea
            className={`${inputCls} min-h-[110px] resize-y font-mono text-meta leading-relaxed`}
            value={entry.content ?? ""}
            onChange={(e) => updatePresetEntry(preset.id, entry.id, { content: e.target.value })}
          />
        </Field>

        <div className="grid grid-cols-1 gap-2">
          {FORMAT_CHILD_KINDS.map((kind) => {
            const child = children.find((c) => c.kind === kind) ?? { kind, enabled: false, content: "" };
            const unwired = FORMAT_CHILD_UNWIRED.includes(kind);
            const gated = Boolean(ROLE_GATED_CHILDREN[kind]);
            // 单独取出来判空：这张表和 ROLE_GATED_CHILDREN 是两份手写的表，
            // 加子条目时漏掉一边，下面那句 `.switch` 会直接 TypeError ——
            // 整个预设面板白屏。少一句说明文字不是事，白屏是事
            const gateHint = GATED_CHILD_HINTS[kind];
            return (
              <div key={kind} className="border border-line bg-paper px-3 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span
                      className={`text-ui ${
                        child.enabled ? "text-ink" : "text-ink-faint line-through"
                      }`}
                    >
                      {FORMAT_CHILD_LABELS[kind]}
                    </span>
                    <code className="ml-2 bg-sunken px-1.5 py-0.5 font-mono text-meta text-ink-faint">
                      &lt;{FORMAT_CHILD_TAGS[kind]}&gt;
                    </code>
                    {unwired && (
                      <span className="ml-2 bg-warnsoft px-1.5 py-0.5 text-meta text-warn">
                        链路未接
                      </span>
                    )}
                    {gated && (
                      <span className="ml-2 bg-sunken px-1.5 py-0.5 text-meta text-ink-soft">
                        还要角色开关
                      </span>
                    )}
                  </div>
                  <Switch
                    checked={Boolean(child.enabled)}
                    onChange={(v) => updateFormatChild(preset.id, entry.id, kind, { enabled: v })}
                    label={`启用「${FORMAT_CHILD_LABELS[kind]}」`}
                  />
                </div>
                {gated && child.enabled && (
                  <p className="mt-1.5 text-meta leading-relaxed text-ink-faint">
                    {gateHint ? (
                      <>
                        这一条还要在「角色 → 单独配置」里给那个角色单独打开「
                        {gateHint.switch}」才会注入 —— {gateHint.why}
                        ，所以由角色说了算，不是所有角色共用。
                      </>
                    ) : (
                      <>这一条还要在「角色 → 单独配置」里给那个角色单独打开对应的开关才会注入。</>
                    )}
                  </p>
                )}
                {child.enabled && (
                  <textarea
                    className={`${inputCls} mt-2 min-h-[60px] resize-y font-mono text-meta leading-relaxed`}
                    value={child.content ?? ""}
                    onChange={(e) =>
                      updateFormatChild(preset.id, entry.id, kind, { content: e.target.value })
                    }
                  />
                )}
              </div>
            );
          })}
        </div>

        <p className="border-l-2 border-line py-1.5 pl-3 text-meta leading-relaxed text-ink-faint">
          <span>
            这十一条都是
            <strong className="text-ink-soft">真能用的</strong>
            ，除引用回复之外都还压着角色那道开关：要在「角色 → 单独配置」里给那个角色
            单独打开才生效。语音 / 图片 / 联网搜索会往外发请求、要花钱，已读不回会让角色
            干脆不回你消息，表情包发出去的是你自己电脑上的图，撤回和回应会真的动到对方
            手机上的消息，Instagram 发出去的帖子是公开的 —— 所以都由「用哪个角色」说了算，
            不是所有角色共用。
            <br />
            表情包那条正文里的
            <code className="mx-1 bg-sunken px-1">{"{{表情包变量}}"}</code>
            会被换成这个角色能用的标签清单（
            <code className="mr-1 bg-sunken px-1">images/emojis/</code>
            下装了图的文件夹，再被角色的黑名单减一遍）。
            一个标签都不剩时，这一条<strong className="text-ink-soft">整条不注入</strong>
            —— 模型不会看到一个空的可用标签。
            <br />
            语音 / 表情包 / 图片的正文格式都变过（
            <code className="mx-1 bg-sunken px-1">[语音]…</code>
            <code className="mr-1 bg-sunken px-1">[表情:…]</code>
            <code className="mr-1 bg-sunken px-1">[生图:…]</code>
            改成了
            <code className="mx-1 bg-sunken px-1">[audio_message:…]</code>
            <code className="mr-1 bg-sunken px-1">[send_emoji:…]</code>
            <code className="mr-1 bg-sunken px-1">[image:…]</code>
            ），你没改过的会自动换成新的，改过的原样留着 —— 老格式解析器那边也仍然认。
          </span>
        </p>
      </div>
    );
  }

  /*
   * 用户选项。正文可改（要不要用 <选项> 标记、给几条、什么口气都是用户的事），
   * 但摘选项的那一步认两种写法：`<选项>…</选项>`，以及结尾连续的编号行
   * （offline.js:splitChoices）。所以把标记那句删掉也还能用，下面写明这一点。
   */
  if (entry.kind === "userChoice") {
    return (
      <div className="grid grid-cols-1 gap-4">
        <Field
          label="正文"
          hint="整段包在 <User_Choices> 里，拼在上下文之后。{{user}} / {{char}} 会替换成名字"
        >
          <textarea
            className={`${inputCls} min-h-[180px] resize-y font-mono text-meta leading-relaxed`}
            value={entry.content ?? ""}
            onChange={(e) => updatePresetEntry(preset.id, entry.id, { content: e.target.value })}
          />
        </Field>
        <p className="border-l-2 border-line py-1.5 pl-3 text-meta leading-relaxed text-ink-faint">
          这一条<span className="text-ink-soft">还要角色那边的「用户选项」开关</span>
          也开着才生效（在「角色 → 线下模式」里，默认关）。
          <br />
          摘选项认两种写法：
          <code className="mx-1 bg-sunken px-1">&lt;选项&gt;…&lt;/选项&gt;</code>
          包起来的那一段，或者整段回复<span className="text-ink-soft">结尾</span>
          连续的几行编号 / 短横线。所以正文里那句标记要求删掉也还能摘出来。
          最多取四条，一条都没摘到时就当这轮没有选项 —— 剧情正文照样发出来。
        </p>
      </div>
    );
  }

  if (entry.kind !== "custom") return null;

  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="条目名称" hint="只影响界面显示">
          <input
            className={inputCls}
            value={entry.name ?? ""}
            onChange={(e) => updatePresetEntry(preset.id, entry.id, { name: e.target.value })}
            placeholder="例如：写作要求"
          />
        </Field>
        <Field label="身份" hint="这条以谁的口气发给模型">
          <select
            className={inputCls}
            value={entry.role ?? "system"}
            onChange={(e) => updatePresetEntry(preset.id, entry.id, { role: e.target.value })}
          >
            {ENTRY_ROLES.map((r) => (
              <option key={r} value={r}>
                {ENTRY_ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field
        label="内容"
        hint="支持 {{char}} / {{user}} / {{sep}}"
      >
        <textarea
          className={`${inputCls} min-h-[140px] resize-y leading-relaxed`}
          value={entry.content ?? ""}
          onChange={(e) => updatePresetEntry(preset.id, entry.id, { content: e.target.value })}
          placeholder="写给模型的额外指令…"
        />
      </Field>
    </div>
  );
}

/** 试跑用的默认样本：正好是最想过滤掉的那种回复。 */
export const REGEX_SAMPLE = "好的<thinking>我该怎么回答</thinking>今天天气不错";

/**
 * 拿一条规则跑一遍测试文本。
 *
 * 语法错就把 new RegExp 的报错原样返回 —— 不用保存再去真机试，
 * 在这儿就能看出括号少了一个。
 */
export function tryRegex(rule, text) {
  if (!rule?.find) return { ok: true, out: text, untouched: true };
  let re;
  try {
    re = new RegExp(rule.find, rule.flags ?? "");
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
  try {
    /*
     * 和服务端 regex.js:replacementFor 一个规矩：
     *  - 删除类一律换成空串，不看替换词
     *  - 替换类有多个候选时，每处匹配随机挑一个
     *
     * 试跑**只挑一次**：真跑起来每一处匹配各挑各的，而这里要的是「这条规则长
     * 什么样」。每次改一个字就重跑一遍、每次都换一个说法，反而看不清效果。
     */
    let out;
    if (rule.action === "delete") {
      out = text.replace(re, "");
    } else {
      const alts = regexAlternatives(rule);
      if (alts.length > 1) {
        const pick = alts[Math.floor(Math.random() * alts.length)];
        out = text.replace(re, () => pick);
      } else {
        out = text.replace(re, rule.replace ?? "");
      }
    }
    return { ok: true, out, untouched: out === text };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/**
 * 两类规则的展示顺序 —— 和服务端 regex.js:selectRules 的执行顺序一致
 * （先删后改）。**写死**，和用户拖成的顺序无关。
 */
const REGEX_GROUPS = [
  {
    action: "delete",
    title: "删除",
    hint: "匹配到的词整个不要了。先跑这一组，再跑「替换」",
  },
  {
    action: "replace",
    title: "替换",
    hint: "换个说法。候选词填多个时，每一处匹配各随机挑一个",
  },
];

export function PresetRegexFold({ preset }) {
  const {
    addRegexRule,
    moveRegexRule,
    reorderRegexRule,
    updateRegexRule,
    removeRegexRule,
    exportRegexRules,
    importRegexRules,
  } = useConfig();
  const rules = preset.regex ?? [];
  const [editId, setEditId] = useState("");
  // 界面上的顺序永远是「先删除、后替换」，和真正执行的一致
  const ordered = sortRegexRules(rules);
  const groupOf = (r) => (regexActionOf(r) === "delete" ? "delete" : "replace");
  const at = (r) => ordered.findIndex((x) => x.id === r.id);

  const renderRule = (r) => {
    const i = at(r);
    const blocked = regexBlockReason(r);
    return (
      <DragRow
        key={r.id}
        id={r.id}
        index={i}
        onReorder={(id, to) => reorderRegexRule(preset.id, id, to)}
        className="border border-line bg-paper transition-colors duration-150"
      >
        <div className="flex items-start gap-2 px-3 py-2.5">
          <DragHandle className="mt-1 shrink-0 text-ink-faint" />
          <MoveButtons
            first={i === 0}
            last={i === ordered.length - 1}
            onUp={() => moveRegexRule(preset.id, r.id, -1)}
            onDown={() => moveRegexRule(preset.id, r.id, 1)}
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span
                className={`truncate text-ui ${
                  r.enabled ? "text-ink" : "text-ink-faint line-through"
                }`}
              >
                {regexLabel(r)}
              </span>
              <span className="shrink-0 rounded-item bg-sunken px-1.5 py-0.5 text-meta text-ink-faint">
                {regexActionText(r)}
              </span>
            </div>
            <p className="mt-0.5 truncate font-mono text-meta text-ink-faint">
              {r.find || "（还没填查找）"}
            </p>
            <p className="mt-0.5 text-meta leading-relaxed text-ink-faint">
              {regexScopeText(r)}
            </p>
            {blocked && r.enabled && (
              <p className="mt-1 flex items-start gap-1.5 text-meta leading-relaxed text-warn">
                {blocked}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => setEditId(editId === r.id ? "" : r.id)}
              aria-label="编辑规则"
              className="rounded-item p-1.5 text-ink-faint transition-colors duration-150 hover:bg-sunken hover:text-ink"
            >
              <Pencil size={14} />
            </button>
            <button
              type="button"
              onClick={() => {
                if (editId === r.id) setEditId("");
                removeRegexRule(preset.id, r.id);
              }}
              aria-label="删除规则"
              className="rounded-item p-1.5 text-ink-faint transition-colors duration-150 hover:bg-warn/[0.08] hover:text-warn"
            >
              <Trash2 size={14} />
            </button>
            <Switch
              checked={Boolean(r.enabled)}
              onChange={(v) => updateRegexRule(preset.id, r.id, { enabled: v })}
              label={`启用「${regexLabel(r)}」`}
            />
          </div>
        </div>

        {editId === r.id && (
          <div className="border-t border-line px-3 py-3">
            <PresetRegexEditor preset={preset} rule={r} />
          </div>
        )}
      </DragRow>
    );
  };

  return (
    <Fold
      title="正则"
      desc="两件事：删掉不想要的词，或者把它换个说法。作用在对方发来的消息和模型的回复上"
      badge={`${rules.filter((r) => r.enabled).length}/${rules.length} 开着`}
    >
      <div className="grid grid-cols-1 gap-4">
        {rules.length === 0 && (
          <p className="py-4 text-center text-ui text-ink-faint">
            {presetMode(preset) === "offline"
              ? // 新建的线下预设自带那套八股文规则（store.jsx:blankPreset），
                // 走到这儿说明用户把它们全删了
                "这份预设没有正则规则。线下预设默认那套「八股文」规则已经被删光了，点下面的「导入规则」可以再拉回来。"
              : "这份预设没有正则规则，模型吐什么就发什么。"}
          </p>
        )}

        {/*
         * 两组分开渲染，每组各自计数。执行顺序**永远是先删除、后替换** ——
         * 两类常常盯着同一个词（「极其」既在删除表也在替换表），先替换的话
         * 删除那条就再也碰不到原文了。
         */}
        {REGEX_GROUPS.map((g) => {
          const items = ordered.filter((r) => groupOf(r) === g.action);
          return (
            <div key={g.action} className="grid grid-cols-1 gap-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-ui text-ink-soft">
                  {g.title}
                  <span className="ml-2 text-meta text-ink-faint">
                    {items.filter((r) => r.enabled).length}/{items.length} 开着
                  </span>
                </p>
                <p className="text-meta leading-relaxed text-ink-faint">{g.hint}</p>
              </div>
              {items.length ? (
                <div className="grid grid-cols-1 gap-2">{items.map(renderRule)}</div>
              ) : (
                <p className="border-l-2 border-line py-1.5 pl-3 text-meta leading-relaxed text-ink-faint">
                  这一组还没有规则。
                </p>
              )}
            </div>
          );
        })}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-meta leading-relaxed text-ink-faint">
            两组之间
            <strong className="text-ink-soft">先删除、后替换</strong>
            ，拖动只在同一组里生效；同一组里从上到下依次执行，前一条的结果交给后一条。
          </p>
          <Button variant="outline" onClick={() => setEditId(addRegexRule(preset.id))}>
            <Plus size={15} /> 新增规则
          </Button>
        </div>

        <div className="grid grid-cols-1 gap-2 border-l-2 border-line py-1.5 pl-3 text-meta leading-relaxed text-ink-faint">
          <p>
            勾了「改上下文」
            <strong className="text-ink-soft">不会动存档</strong>
            —— 落盘的一直是模型的原文，「上下文」面板里
            <code className="mx-1 bg-sunken px-1 font-mono">&lt;thinking&gt;</code>
            这类内容照样看得见（你得知道模型当时怎么理解剧情）。这条规则只在拼提示词、
            要发给模型的那一刻才跑，模型看到的那份里没有。
          </p>
        </div>

        <div className="grid grid-cols-1 gap-2 border-l-2 border-warn py-1.5 pl-3 text-meta leading-relaxed text-warn">
          <p className="flex items-start gap-1.5">
            <span>
              正则是<strong>同步</strong>执行的：跑的时候整个
              Node 进程停在那儿，挂着的所有号码一起卡，而且中途
              <strong>掐不断</strong>
              （服务端只做了长度门槛和耗时告警）。要躲开的是
              <strong>嵌套量词</strong>
              这种形状 ——
              <code className="mx-1 bg-warnsoft px-1 font-mono">(a+)+</code>
              <code className="mr-1 bg-warnsoft px-1 font-mono">(\s*)*</code>
              <code className="mr-1 bg-warnsoft px-1 font-mono">(.*)*</code>
              <code className="mr-1 bg-warnsoft px-1 font-mono">(\w+\s?)+</code>
              —— 量词套量词时匹配失败会疯狂回溯，几十个字符就能跑上好几分钟。
              写复杂规则前先在下面试跑。
            </span>
          </p>
        </div>

        {/*
         * 规则也能单独导出去 —— 这是当初提的需求里明写的一条：默认线下预设
         * 自带那套八股文规则，用户想要就得能导出来、再贴到自己的其他预设里。
         * 所以放在正则折叠**里面**，导出的是这一份预设的正则表。
         */}
        <div className="border-t border-line pt-4">
          <TransferCard
            what="这套正则规则"
            title="导出 / 导入这些正则规则"
            desc="把这一份预设的正则表存成文件带走，或者把别处的规则补进来"
            busyText="导出的是这份预设现在的正则表（含还没保存的改动）。导入是往这份预设里补规则 —— 已经有的（同一套规则再导一次）会自动跳过，之前删掉的会补回来。"
            onExport={() => exportRegexRules(rules, preset.name)}
            onImport={(bundle) => importRegexRules(preset.id, bundle)}
          />
        </div>

        <SaveBar hint="只影响这份预设" />
      </div>
    </Fold>
  );
}

/** 一条正则规则的编辑区，带实时试跑。 */
export function PresetRegexEditor({ preset, rule }) {
  const { updateRegexRule, toggleRegexTarget } = useConfig();
  const [sample, setSample] = useState(REGEX_SAMPLE);
  const patch = (p) => updateRegexRule(preset.id, rule.id, p);
  const deleting = regexActionOf(rule) === "delete";
  const alts = regexAlternatives(rule).join("\n");
  const result = useMemo(
    () => tryRegex(rule, sample),
    [rule.find, rule.flags, rule.replace, rule.alternatives, rule.action, sample]
  );
  const targets = rule.targets ?? [];

  /**
   * 替换词的候选表，界面上是「一个说法一行」。
   *
   * 只留非空行，另外**顺手把老式的单个替换词搬进 alternatives** ——
   * 用户在一个只有单串的旧规则上敲回车时，那一个词不该丢。搬完 replace 就清空了，
   * 从此以 alternatives 为准（服务端两条路都认，见 regex.js:replacementFor）。
   */
  const writeAlts = (text) => {
    const list = text
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    patch({ alternatives: list, replace: "" });
  };

  return (
    <div className="grid grid-cols-1 gap-4">
      <Field label="规则名称" hint="只影响界面显示">
        <input
          className={inputCls}
          value={rule.name ?? ""}
          onChange={(e) => patch({ name: e.target.value })}
          placeholder="例如：去掉思维链"
        />
      </Field>

      <div className="grid grid-cols-1 gap-2">
        <p className="text-ui text-ink-soft">这条规则做什么</p>
        <div className="flex flex-wrap gap-2">
          {[
            { action: "replace", label: "替换成别的说法" },
            { action: "delete", label: "整个删掉" },
          ].map((opt) => {
            const on = (rule.action === "delete" ? "delete" : "replace") === opt.action;
            return (
              <button
                key={opt.action}
                type="button"
                onClick={() => patch({ action: opt.action })}
                className={`rounded-item border px-2.5 py-1.5 text-meta transition-colors duration-150 ${
                  on
                    ? "border-ink bg-sunken text-ink"
                    : "border-line bg-paper text-ink-faint hover:text-ink"
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        <p className="text-meta leading-relaxed text-ink-faint">
          {deleting
            ? "匹配到的地方直接挖掉。这一组永远排在「替换」前面先跑。"
            : "匹配到的地方换成下面的候选词之一。"}
        </p>
      </div>

      <Field label="查找" hint="JavaScript 正则，不用写两边的斜杠">
        <input
          className={`${inputCls} font-mono text-meta ${
            result.ok ? "" : "border-warn text-warn"
          }`}
          value={rule.find ?? ""}
          onChange={(e) => patch({ find: e.target.value })}
          placeholder="<(thinking|think)>[\s\S]*?</\1>"
          spellCheck={false}
        />
      </Field>

      {deleting ? (
        <Field label="标志" hint="g 全局 · i 忽略大小写">
          <input
            className={`${inputCls} font-mono text-meta sm:max-w-[140px]`}
            value={rule.flags ?? ""}
            onChange={(e) => patch({ flags: e.target.value })}
            placeholder="g"
            spellCheck={false}
          />
        </Field>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_140px]">
          <Field
            label="替换词"
            hint="一个说法一行，每处匹配随机挑一个。写多个是为了别把同一个词反复换成同一个说法；只写一行时支持 $1 反向引用和 {{char}} / {{user}}"
          >
            <textarea
              className={`${inputCls} min-h-[84px] resize-y font-mono text-meta leading-relaxed`}
              value={alts}
              onChange={(e) => writeAlts(e.target.value)}
              placeholder={"分外\n格外\n相当"}
              spellCheck={false}
            />
          </Field>
          <Field label="标志" hint="g 全局 · i 忽略大小写">
            <input
              className={`${inputCls} font-mono text-meta`}
              value={rule.flags ?? ""}
              onChange={(e) => patch({ flags: e.target.value })}
              placeholder="gi"
              spellCheck={false}
            />
          </Field>
        </div>
      )}

      <div className="grid grid-cols-1 gap-2">
        <p className="text-ui text-ink-soft">作用范围</p>
        <label className="flex cursor-pointer items-start gap-2.5 text-meta leading-relaxed text-ink-soft">
          <input
            type="checkbox"
            checked={targets.includes("userInput")}
            onChange={() => toggleRegexTarget(preset.id, rule.id, "userInput")}
            className="mt-0.5 shrink-0 accent-ink"
          />
          <span>
            对方发来的消息
            <span className="block text-meta text-ink-faint">
              只改对方真正打的字，不动我们自己拼的图片描述那段
            </span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2.5 text-meta leading-relaxed text-ink-soft">
          <input
            type="checkbox"
            checked={targets.includes("aiOutput")}
            onChange={() => toggleRegexTarget(preset.id, rule.id, "aiOutput")}
            className="mt-0.5 shrink-0 accent-ink"
          />
          <span>AI 的回复</span>
        </label>

        {targets.includes("aiOutput") && (
          <div className="ml-6 grid grid-cols-1 gap-2 border border-line bg-paper px-3 py-2.5">
            <label className="flex cursor-pointer items-start gap-2.5 text-meta leading-relaxed text-ink-soft">
              <input
                type="checkbox"
                checked={Boolean(rule.toUser)}
                onChange={(e) => patch({ toUser: e.target.checked })}
                className="mt-0.5 shrink-0 accent-ink"
              />
              <span>
                改发出去的内容
                <span className="block text-meta text-ink-faint">
                  对方在 iMessage 里收到的
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2.5 text-meta leading-relaxed text-ink-soft">
              <input
                type="checkbox"
                checked={Boolean(rule.toHistory)}
                onChange={(e) => patch({ toHistory: e.target.checked })}
                className="mt-0.5 shrink-0 accent-ink"
              />
              <span>
                改上下文
                <span className="block text-meta text-ink-faint">
                  只改发给模型的那份，存档里留原文
                </span>
              </span>
            </label>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-2 border-t border-line pt-4">
        <Field label="试跑" hint="改上面任何一项，下面的结果立刻跟着变；多条候选词时这里只挑一次，真跑是每处各挑各的">
          <textarea
            className={`${inputCls} min-h-[64px] resize-y font-mono text-meta leading-relaxed`}
            value={sample}
            onChange={(e) => setSample(e.target.value)}
            spellCheck={false}
          />
        </Field>
        {result.ok ? (
          <div
            className={`px-3.5 py-2.5 text-meta leading-relaxed ${
              result.untouched ? "bg-paper text-ink-faint" : "bg-goodsoft text-good"
            }`}
          >
            <p className="mb-1 text-meta">
              {result.untouched ? "没有改动" : "改写后"}
            </p>
            <p className="whitespace-pre-wrap break-words font-mono">
              {result.out || "（结果是空的 —— 这时不会发空气泡，会给对方回一条失败提示）"}
            </p>
          </div>
        ) : (
          <p className="border-l-2 border-warn py-1.5 pl-3 text-meta leading-relaxed text-warn">
            正则写得不对：{result.error}。服务端会跳过这条规则并记一条警告，
            不会因此丢掉整轮对话。
          </p>
        )}
      </div>
    </div>
  );
}
