/*
 * 记忆库的全局设置：三个模型、轮数、四段提示词、日记的定时和字数。
 *
 * 单独一个文件而不是和 memories.jsx 放一起：那边是**内容**（记忆条目、
 * 备忘录正文、日记日历），改一下就直接落盘；这边是**配置**，走配置草稿、
 * 要点底下那条「保存」。两种东西的数据流完全不同，混在一个 2000 行的文件里
 * 谁都读不动 —— 服务端也是这么拆的（memorystore / memoryprompts / memoryhooks）。
 *
 * 全局一份、所有角色共用。角色那边只有三个开关（「角色 → 单独配置 → 记忆库」）。
 */

import { worldBookLabel } from "../labels.js";
import { useConfig } from "../store.jsx";
// 四个模型选择器复用角色面板那个 —— 它已经处理好了「引用的模型被删掉了」
// （标红提示）和「一个模型都没配」这两种状态，重写一遍只会分叉
import { ModelSelect } from "./role.jsx";
import { Field, Fold, NumberField, Switch, inputCls } from "../ui.jsx";
import { Undo2 } from "lucide-react";

/**
 * 提示词那一栏。
 *
 * **必须定义在外面**（和 role.jsx:CityField 同一个理由）：定义在父组件里的话
 * 每次 render 都是一个新的组件类型，React 会把整棵子树卸掉重建，
 * textarea 每敲一个字就失焦。
 *
 * 「清空并保存 = 恢复默认」不是偷懒：后端 normalizeMemories 里留空就回落到
 * 内置那份，所以清空再保存正好等于恢复默认，前端不用再存一份默认文案
 * （存了就会和后端分叉）。
 */
function PromptField({ label, hint, value, onChange, placeholder, rows = "min-h-[180px]" }) {
  return (
    <Field label={label} hint={hint}>
      <textarea
        className={`${inputCls} ${rows} resize-y font-mono leading-relaxed`}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      {String(value ?? "").trim() && (
        <button
          type="button"
          onClick={() => onChange("")}
          className="mt-2 inline-flex items-center gap-1.5 text-meta text-ink-soft transition-colors duration-150 hover:text-ink"
        >
          <Undo2 size={13} /> 清空 —— 保存后会自动填回内置的默认提示词
        </button>
      )}
    </Field>
  );
}

/** 三块设置。外面那张卡和返回按钮由 memories.jsx 画。 */
export function MemoriesSettings({ onGoto }) {
  return (
    <div className="grid grid-cols-1">
      <MemorySettings onGoto={onGoto} />
      <MemoSettings />
      <DiarySettings onGoto={onGoto} />
    </div>
  );
}

function MemorySettings({ onGoto }) {
  const { config, updateMemories } = useConfig();
  const cfg = config.memories?.memory ?? {};
  const patch = (p) => updateMemories({ memory: p });
  const recent = cfg.recentInject ?? {};

  return (
    <Fold title="记忆" desc="总结模型 + 向量模型 + 检索参数。三样里只有它用向量" defaultOpen>
      <div className="grid grid-cols-1 gap-6">
        <Field label="总结用的模型" hint="标了「聊天」分类的模型里挑一个">
          <ModelSelect category="chat" value={cfg.model} onChange={(v) => patch({ model: v })} />
        </Field>

        <div>
          <Field label="向量模型" hint="标了「向量」分类的模型里挑一个">
            <ModelSelect
              category="embedding"
              value={cfg.embedModel}
              onChange={(v) => patch({ embedModel: v })}
            />
          </Field>
          <p className="mt-1.5 text-meta leading-relaxed text-ink-faint">
            没选或者打不通时，记忆会退化成
            <strong className="text-ink-soft">只注入近 N 天的那一路</strong>
            ，不会挡住这一轮回复。选完记得先保存，再去
            <button
              type="button"
              className="mx-1 underline decoration-line underline-offset-2 hover:text-ink"
              onClick={() => onGoto?.("api")}
            >
              连接
            </button>
            面板点那个模型的「测试向量」——
            它测的是这里选中的这一个，回的维度决定了以后换模型要不要重算全部记忆。
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <NumberField
            label="攒够几轮总结一次"
            value={cfg.rounds ?? 15}
            min={1}
            max={200}
            step={1}
            onChange={(v) => patch({ rounds: v })}
            hint="一问一答算一轮"
            suffix="轮"
          />
          <NumberField
            label="连续失败几次报一声"
            value={cfg.maxFails ?? 3}
            min={1}
            max={20}
            step={1}
            onChange={(v) => patch({ maxFails: v })}
            hint="不是「几次就放弃」，待总结永远不删"
            suffix="次"
          />
        </div>

        <PromptField
          label="生成记忆的提示词"
          hint="拼在最上面，底下依次是角色人设、用户人设、世界书、待总结的聊天记录"
          value={cfg.prompt}
          onChange={(v) => patch({ prompt: v })}
          placeholder="清空并保存会回到内置的那一份"
          rows="min-h-[120px]"
        />

        <div className="grid grid-cols-1 gap-6 border-t border-line pt-6">
          <div>
            <p className="text-ui text-ink">检索</p>
            <p className="mt-0.5 text-meta leading-relaxed text-ink-faint">
              每轮拿对方最后那句话去检索一遍，把相关的老记忆捞回来。
              打分是<span className="font-mono">语义 × 0.7 + 关键词 × 0.3</span>，
              再按天数扣分 ——
              <strong className="text-ink-soft">门槛判在扣分之前</strong>
              ，老而准的记忆不该只因为旧就被踢掉，时间只影响排序。
            </p>
          </div>

          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            <NumberField
              label="最多取几条"
              value={cfg.topK ?? 5}
              min={1}
              max={50}
              step={1}
              onChange={(v) => patch({ topK: v })}
              suffix="条"
            />
            <NumberField
              label="入选门槛"
              value={cfg.threshold ?? 0.35}
              min={0}
              max={1}
              step={0.05}
              onChange={(v) => patch({ threshold: v })}
              hint="0～1，调高就更严"
            />
          </div>

          <label className="flex items-start justify-between gap-4">
            <span className="min-w-0">
              <span className="block text-ui text-ink">时间衰减</span>
              <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                同样相关的两条里，新的排前面。关掉就纯按相关度排。
              </span>
            </span>
            <Switch
              checked={cfg.timeDecay !== false}
              onChange={(v) => patch({ timeDecay: v })}
              label="启用时间衰减"
            />
          </label>

          {cfg.timeDecay !== false && (
            <div className="border-l-2 border-line pl-4">
              <NumberField
                label="每老一天扣多少分"
                value={cfg.decay ?? 0.01}
                min={0}
                max={1}
                step={0.005}
                onChange={(v) => patch({ decay: v })}
                hint="只改排序，不改入选资格"
              />
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 gap-6 border-t border-line pt-6">
          <label className="flex items-start justify-between gap-4">
            <span className="min-w-0">
              <span className="block text-ui text-ink">注入近 N 天的记忆</span>
              <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                检索之外的第二路：按日期直接捞，<strong className="text-ink-soft">不用向量</strong>。
                这一路和检索那一路会去重，同一条不会注入两遍。
              </span>
            </span>
            <Switch
              checked={recent.enabled !== false}
              onChange={(v) => patch({ recentInject: { ...recent, enabled: v } })}
              label="启用近 N 天记忆"
            />
          </label>

          {recent.enabled !== false && (
            <div className="border-l-2 border-line pl-4">
              <NumberField
                label="近几天"
                value={recent.days ?? 3}
                min={0}
                max={30}
                step={1}
                onChange={(v) => patch({ recentInject: { ...recent, days: v } })}
                hint="填 0 = 开着但不注入，等于临时关"
                suffix="天"
              />
            </div>
          )}

          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            <NumberField
              label="注入的字数上限"
              value={cfg.maxInjectChars ?? 6000}
              min={500}
              max={60000}
              step={500}
              onChange={(v) => patch({ maxInjectChars: v })}
              hint="两路记忆合起来算"
              suffix="字"
            />
            <NumberField
              label="一次总结最多喂多少字"
              value={cfg.maxInputChars ?? 4000}
              min={500}
              max={60000}
              step={500}
              onChange={(v) => patch({ maxInputChars: v })}
              hint="超了取最后那截，存的那份仍然是全的"
              suffix="字"
            />
          </div>
        </div>
      </div>
    </Fold>
  );
}

function MemoSettings() {
  const { config, updateMemories } = useConfig();
  const cfg = config.memories?.memo ?? {};
  const patch = (p) => updateMemories({ memo: p });

  return (
    <Fold title="备忘录" desc="总结模型 + 轮数 + 提示词。不用向量">
      <div className="grid grid-cols-1 gap-6">
        <Field label="生成用的模型" hint="标了「聊天」分类的模型里挑一个">
          <ModelSelect category="chat" value={cfg.model} onChange={(v) => patch({ model: v })} />
        </Field>

        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <NumberField
            label="攒够几轮生成一次"
            value={cfg.rounds ?? 15}
            min={1}
            max={200}
            step={1}
            onChange={(v) => patch({ rounds: v })}
            hint="和记忆各数各自的轮数"
            suffix="轮"
          />
          <NumberField
            label="连续失败几次报一声"
            value={cfg.maxFails ?? 3}
            min={1}
            max={20}
            step={1}
            onChange={(v) => patch({ maxFails: v })}
            suffix="次"
          />
        </div>

        <NumberField
          label="一次最多喂多少字"
          value={cfg.maxInputChars ?? 4000}
          min={500}
          max={60000}
          step={500}
          onChange={(v) => patch({ maxInputChars: v })}
          hint="超了取最后那截，存的那份仍然是全的"
          suffix="字"
        />

        <PromptField
          label="生成备忘录的提示词"
          hint="顶上是这段，底下依次是角色人设、用户人设、世界书、近 N 天记忆、现有的备忘录"
          value={cfg.prompt}
          onChange={(v) => patch({ prompt: v })}
          placeholder="清空并保存会回到内置的那一份"
        />

        <p className="text-meta leading-relaxed text-ink-faint">
          {/* 尖括号得包成字符串：JSX 里裸写会被当成一个标签 */}
          提示词里那句「严禁将 {"<memories>"} 的内容也加入到备忘录里」不是唯一的防线 ——
          链路那边<strong className="text-ink-soft">也不注入记忆原文</strong>
          （只给近 N 天记忆的纯文本）。两道都在，因为光靠提示词管不住模型。
        </p>
      </div>
    </Fold>
  );
}

function DiarySettings({ onGoto }) {
  const { config, updateMemories } = useConfig();
  const cfg = config.memories?.diary ?? {};
  const patch = (p) => updateMemories({ diary: p });
  const schedule = cfg.schedule ?? {};
  const limit = cfg.limit ?? {};
  const self = cfg.selfInject ?? {};
  const books = config.worldBooks ?? [];
  const refs = cfg.worldBookRefs ?? [];

  const zeroInterval =
    Boolean(schedule.enabled) && !schedule.days && !schedule.hours && !schedule.minutes;

  const toggleBook = (id) =>
    patch({
      worldBookRefs: refs.includes(id) ? refs.filter((x) => x !== id) : [...refs, id],
    });

  return (
    <Fold title="日记" desc="写作模型 + 记录模式 + 文风 / 待办 / 字数 / 世界书 / 提示词">
      <div className="grid grid-cols-1 gap-6">
        <Field label="写日记用的模型" hint="标了「聊天」分类的模型里挑一个">
          <ModelSelect category="chat" value={cfg.model} onChange={(v) => patch({ model: v })} />
        </Field>

        {/* 1. 记录模式 */}
        <div className="grid grid-cols-1 gap-6 border-t border-line pt-6">
          <div>
            <p className="text-ui text-ink">记录模式</p>
            <p className="mt-0.5 text-meta leading-relaxed text-ink-faint">
              定时和手动是两条独立的路，可以只要一条，也可以都开。
            </p>
          </div>

          <label className="flex items-start justify-between gap-4">
            <span className="min-w-0">
              <span className="block text-ui text-ink">定时日记</span>
              <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                每隔一段时间自动写一篇。
                <strong className="text-ink-soft">漏掉的那次不补</strong>
                —— 机器睡了一整天再醒过来，补写十篇既花钱又没意义（内容全来自同一份流水）。
              </span>
            </span>
            <Switch
              checked={Boolean(schedule.enabled)}
              onChange={(v) => patch({ schedule: { ...schedule, enabled: v } })}
              label="启用定时日记"
            />
          </label>

          {schedule.enabled && (
            <div className="grid grid-cols-1 gap-4 border-l-2 border-line pl-4">
              <div className="grid grid-cols-3 gap-4">
                <NumberField
                  label="天"
                  value={schedule.days ?? 0}
                  min={0}
                  max={30}
                  step={1}
                  onChange={(v) => patch({ schedule: { ...schedule, days: v } })}
                />
                <NumberField
                  label="小时"
                  value={schedule.hours ?? 0}
                  min={0}
                  max={23}
                  step={1}
                  onChange={(v) => patch({ schedule: { ...schedule, hours: v } })}
                />
                <NumberField
                  label="分钟"
                  value={schedule.minutes ?? 0}
                  min={0}
                  max={59}
                  step={1}
                  onChange={(v) => patch({ schedule: { ...schedule, minutes: v } })}
                />
              </div>
              {zeroInterval ? (
                <p className="text-meta leading-relaxed text-warn">
                  三个数都是 0 = 等于没开（否则就是每分钟写一篇）。至少填一个。
                </p>
              ) : (
                <p className="text-meta leading-relaxed text-ink-faint">
                  三个数加起来就是间隔。刚打开开关时
                  <strong className="text-ink-soft">不会立刻写</strong>
                  ，而是从现在开始数；流水是空的那次直接跳过。
                </p>
              )}
            </div>
          )}

          <label className="flex items-start justify-between gap-4">
            <span className="min-w-0">
              <span className="block text-ui text-ink">手动日记</span>
              <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                在 iMessage 里发
                <code className="mx-1 bg-sunken px-1">/diary</code>或
                <code className="mx-1 bg-sunken px-1">/日记</code>
                立刻写一篇。日记页那个「立刻写一篇」按钮也归这条管 —— 关掉两边都不能用。
              </span>
            </span>
            <Switch
              checked={cfg.manual !== false}
              onChange={(v) => patch({ manual: v })}
              label="启用手动日记"
            />
          </label>
        </div>

        {/* 2. 生成时回看自己近 N 天的日记 */}
        <div className="grid grid-cols-1 gap-6 border-t border-line pt-6">
          <label className="flex items-start justify-between gap-4">
            <span className="min-w-0">
              <span className="block text-ui text-ink">写的时候回看近 N 天的日记</span>
              <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                让这一篇接得上前几天 —— 昨天说要买的东西、上一篇的待办，
                今天能有个交代。和角色那边「注入近 N 天日记」不是一回事：
                那个是<strong className="text-ink-soft">聊天时</strong>发给模型的。
              </span>
            </span>
            <Switch
              checked={self.enabled !== false}
              onChange={(v) => patch({ selfInject: { ...self, enabled: v } })}
              label="启用回看近 N 天日记"
            />
          </label>

          {self.enabled !== false && (
            <div className="border-l-2 border-line pl-4">
              <NumberField
                label="近几天"
                value={self.days ?? 1}
                min={0}
                max={30}
                step={1}
                onChange={(v) => patch({ selfInject: { ...self, days: v } })}
                suffix="天"
              />
            </div>
          )}
        </div>

        {/* 3. 文风 */}
        <div className="grid grid-cols-1 gap-6 border-t border-line pt-6">
          <label className="flex items-start justify-between gap-4">
            <span className="min-w-0">
              <span className="block text-ui text-ink">日记文风提示词</span>
              <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                展开到日记提示词里
                <code className="mx-1 bg-sunken px-1">{"{{writing_style_reference}}"}</code>
                那个位置。关掉的话<strong className="text-ink-soft">整行删掉</strong>
                ，不是留个空串。
              </span>
            </span>
            <Switch
              checked={cfg.styleEnabled !== false}
              onChange={(v) => patch({ styleEnabled: v })}
              label="启用日记文风提示词"
            />
          </label>

          {cfg.styleEnabled !== false && (
            <div className="border-l-2 border-line pl-4">
              <PromptField
                label="文风正文"
                hint="第一行的 YAML 块头和那层缩进别删 —— 整段是当作一个字段插进去的"
                value={cfg.styleRef}
                onChange={(v) => patch({ styleRef: v })}
                placeholder="清空并保存会回到内置的那一份"
              />
            </div>
          )}
        </div>

        {/* 4 + 5. 待办事项 */}
        <div className="grid grid-cols-1 gap-6 border-t border-line pt-6">
          <label className="flex items-start justify-between gap-4">
            <span className="min-w-0">
              <span className="block text-ui text-ink">结尾附一份待办事项</span>
              <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                日记正文后面加一条分割线，下面是角色自己的 To-do list（带碎碎念）。
                展开到
                <code className="mx-1 bg-sunken px-1">{"{{to_do_list}}"}</code>
                那个位置，关掉时整行删掉。
              </span>
            </span>
            <Switch
              checked={Boolean(cfg.todoEnabled)}
              onChange={(v) => patch({ todoEnabled: v })}
              label="启用待办事项"
            />
          </label>

          {cfg.todoEnabled && (
            <div className="border-l-2 border-line pl-4">
              <PromptField
                label="待办事项提示词"
                hint="内置那份要求列生活琐事、每条后面跟一句碎碎念，还会检查前一天完成了哪些"
                value={cfg.todoPrompt}
                onChange={(v) => patch({ todoPrompt: v })}
                placeholder="清空并保存会回到内置的那一份"
              />
            </div>
          )}
        </div>

        {/* 6. 字数 */}
        <div className="grid grid-cols-1 gap-6 border-t border-line pt-6">
          <label className="flex items-start justify-between gap-4">
            <span className="min-w-0">
              <span className="block text-ui text-ink">日记字数规定</span>
              <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                把字数要求写进提示词，并在拿到结果后真的数一遍。默认关。
              </span>
            </span>
            <Switch
              checked={Boolean(limit.enabled)}
              onChange={(v) => patch({ limit: { ...limit, enabled: v } })}
              label="启用日记字数规定"
            />
          </label>

          {limit.enabled && (
            <div className="grid grid-cols-1 gap-4 border-l-2 border-line pl-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <NumberField
                  label="最少"
                  value={limit.min ?? 800}
                  min={0}
                  max={100000}
                  step={100}
                  onChange={(v) => patch({ limit: { ...limit, min: v } })}
                  suffix="字"
                />
                <NumberField
                  label="最多"
                  value={limit.max ?? 3000}
                  min={0}
                  max={100000}
                  step={100}
                  onChange={(v) => patch({ limit: { ...limit, max: v } })}
                  suffix="字"
                />
              </div>

              <label className="flex items-start justify-between gap-4">
                <span className="min-w-0">
                  <span className="block text-ui text-ink">字数不够就重打</span>
                  <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                    单独一个开关，因为重打是
                    <strong className="text-ink-soft">要多花钱的</strong>
                    ，不该跟着字数提示一起被打开。
                  </span>
                </span>
                <Switch
                  checked={Boolean(limit.retry)}
                  onChange={(v) => patch({ limit: { ...limit, retry: v } })}
                  label="启用字数不够重打"
                />
              </label>

              {limit.retry && (
                <div className="border-l-2 border-line pl-4">
                  <NumberField
                    label="重试次数"
                    value={limit.retries ?? 3}
                    min={1}
                    max={10}
                    step={1}
                    onChange={(v) => patch({ limit: { ...limit, retries: v } })}
                    hint="用完还不够就报失败，流水一个字节都不删"
                    suffix="次"
                  />
                </div>
              )}
            </div>
          )}

          <NumberField
            label="连续失败几次报一声"
            value={cfg.maxFails ?? 3}
            min={1}
            max={20}
            step={1}
            onChange={(v) => patch({ maxFails: v })}
            hint="不是「几次就放弃」，流水永远不删"
            suffix="次"
          />
        </div>

        {/* 7. 世界书 */}
        <div className="grid grid-cols-1 gap-6 border-t border-line pt-6">
          <label className="flex items-start justify-between gap-4">
            <span className="min-w-0">
              <span className="block text-ui text-ink">世界书跟着角色走</span>
              <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                默认用这个角色在「角色 → 单独配置」里勾的那几本（外加全局的）。
                关掉就在下面另选 —— 想让日记只看到一小部分设定时用。
              </span>
            </span>
            <Switch
              checked={cfg.useRoleWorldBooks !== false}
              onChange={(v) => patch({ useRoleWorldBooks: v })}
              label="日记的世界书跟着角色走"
            />
          </label>

          {cfg.useRoleWorldBooks === false && (
            <div className="grid grid-cols-1 gap-3 border-l-2 border-line pl-4">
              {books.length === 0 && (
                <p className="text-meta leading-relaxed text-ink-faint">
                  还没有世界书。
                  <button
                    type="button"
                    className="ml-1 underline decoration-line underline-offset-2 hover:text-ink"
                    onClick={() => onGoto?.("world")}
                  >
                    去「世界书」面板建一本
                  </button>
                </p>
              )}
              {books.length > 0 && (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {books.map((b) => {
                    const on = refs.includes(b.id);
                    return (
                      <label
                        key={b.id}
                        className={`flex cursor-pointer items-start gap-2.5 border px-3 py-2.5 transition-colors duration-150 ${
                          on ? "border-ink bg-sunken" : "border-line bg-paper hover:bg-sunken"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => toggleBook(b.id)}
                          className="mt-0.5 shrink-0 accent-ink"
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-ui text-ink">
                            {worldBookLabel(b)}
                          </span>
                          <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                            {(b.entries ?? []).length} 条
                            {b.global ? " · 全局" : ""}
                            {b.enabled ? "" : " · 整本被关掉了"}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
              {refs.filter((id) => !books.some((b) => b.id === id)).length > 0 && (
                <p className="text-meta leading-relaxed text-warn">
                  还挂着 {refs.filter((id) => !books.some((b) => b.id === id)).length}{" "}
                  本已经被删掉的世界书，这些引用不起作用。
                </p>
              )}
            </div>
          )}
        </div>

        {/* 8. 日记提示词 */}
        <div className="grid grid-cols-1 gap-6 border-t border-line pt-6">
          <PromptField
            label="日记提示词"
            hint="顶上是这段，底下依次是角色人设、用户人设、世界书、近 N 天记忆、备忘录、当前天气、日记流水"
            value={cfg.prompt}
            onChange={(v) => patch({ prompt: v })}
            placeholder="清空并保存会回到内置的那一份"
            rows="min-h-[260px]"
          />
          <p className="text-meta leading-relaxed text-ink-faint">
            三样总结都<strong className="text-ink-soft">不发预设</strong>
            ，只发各自这条链 —— 预设是「怎么跟人说话」，总结是一份数据加工任务，
            两者混在一起模型会开始扮演角色而不是干活。天气是生成那一刻现查的，
            查不到就整段不注入。
          </p>
        </div>
      </div>
    </Fold>
  );
}