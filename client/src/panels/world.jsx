import { useState } from "react";
import {
  ENTRY_ROLES,
  ENTRY_ROLE_LABELS,
  POSITIONS,
  POSITION_LABELS,
  worldBookBlockReason,
  worldBookUsageText,
  worldEntryBlockReason,
  worldEntryLabel,
  worldEntryTriggerText,
} from "../labels.js";
import { SaveBar, useSection } from "../section.jsx";
import { useConfig } from "../store.jsx";
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
  Switch,
  inputCls,
} from "../ui.jsx";
import { Pencil, Plus, Trash2 } from "lucide-react";

export function WorldPanel({ onGoto }) {
  const { config } = useConfig();
  const { itemId, pick } = useSection();
  const books = config.worldBooks ?? [];
  const open = books.find((b) => b.id === itemId) ?? null;

  if (!open) {
    return (
      <Card title="世界书">
        {books.length ? (
          <div className="grid max-w-[62ch] grid-cols-1 gap-4">
            <p className="text-body text-ink-soft">左边挑一本，改它的条目和触发关键词。</p>
            <p className="border-l-2 border-line py-1.5 pl-3 text-meta leading-relaxed text-ink-faint">
              刻意没做 token 预算上限 —— 控制体量靠「扫描深度」、递归层数，以及少写常驻条目。
            </p>
          </div>
        ) : (
          <div className="grid max-w-[62ch] grid-cols-1 gap-4">
            <p className="text-body text-ink-soft">
              还没有世界书。不建也能用 —— 预设里的「世界书」条目会注入空内容，等于没有。
            </p>
            <p className="text-meta leading-relaxed text-ink-faint">
              适合放地名、人物关系、专有名词这类「提到才需要」的设定。
            </p>
          </div>
        )}
      </Card>
    );
  }

  return <WorldBookDetail book={open} onBack={() => pick("")} onGoto={onGoto} />;
}

export function WorldBookDetail({ book, onBack, onGoto }) {
  const {
    config,
    updateWorldBook,
    removeWorldBook,
    addWorldEntry,
    exportWorldBook,
    importWorldBook,
  } = useConfig();
  const { pick } = useSection();
  const [editId, setEditId] = useState("");
  const entries = book.entries ?? [];
  const blocked = worldBookBlockReason(config, book);
  // 生效时把「谁在用它」摊开写。线上和线下是两份独立的书单，不写清楚的话
  // 用户只能看到「生效了」，看不出自己勾的到底是哪一边
  const usage = blocked ? "" : worldBookUsageText(config, book);

  function drop() {
    removeWorldBook(book.id);
    onBack();
  }

  return (
    <div className="grid grid-cols-1 gap-rhythm-sm lg:gap-rhythm">
      <Card title="这本书的设置" desc="扫描深度和递归层数是控制体量的两个旋钮">
        <div className="grid grid-cols-1 gap-6">
          <Field label="世界书名称">
            <input
              className={inputCls}
              value={book.name}
              onChange={(e) => updateWorldBook(book.id, { name: e.target.value })}
              placeholder="例如：阿瓦隆设定"
            />
          </Field>

          <label className="flex items-start justify-between gap-4">
            <span className="min-w-0">
              <span className="block text-ui text-ink">启用这本书</span>
              <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                关掉之后谁都不会用它，条目全都不触发。
              </span>
            </span>
            <Switch
              checked={Boolean(book.enabled)}
              onChange={(v) => updateWorldBook(book.id, { enabled: v })}
              label="启用这本世界书"
            />
          </label>

          <label className="flex items-start justify-between gap-4 border-t border-line pt-6">
            <span className="min-w-0">
              <span className="block text-ui text-ink">全局</span>
              <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                打开 = 所有角色都用这本书，不用再去每个角色那里勾。
              </span>
            </span>
            <Switch
              checked={Boolean(book.global)}
              onChange={(v) => updateWorldBook(book.id, { global: v })}
              label="全局生效"
            />
          </label>

          <div className="grid grid-cols-1 gap-6 border-t border-line pt-6 sm:grid-cols-2">
            <NumberField
              label="扫描深度"
              value={book.scanDepth ?? 4}
              min={1}
              max={100}
              step={1}
              onChange={(v) => updateWorldBook(book.id, { scanDepth: v })}
              hint="拿最近几条消息去匹配关键词"
              suffix="条"
            />
            <NumberField
              label="递归层数"
              value={book.maxRecursion ?? 3}
              min={1}
              max={10}
              step={1}
              onChange={(v) => updateWorldBook(book.id, { maxRecursion: v })}
              hint="防「A 触发 B、B 又触发 A」转不停"
              suffix="层"
            />
          </div>

          <label className="flex items-start justify-between gap-4">
            <span className="min-w-0">
              <span className="block text-ui text-ink">递归扫描</span>
              <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                命中条目的内容也拿去继续匹配 —— 提到「王都」带出王都那条，
                王都的介绍里提到「国王」，就能把国王那条也带出来。
              </span>
            </span>
            <Switch
              checked={Boolean(book.recursive)}
              onChange={(v) => updateWorldBook(book.id, { recursive: v })}
              label="递归扫描"
            />
          </label>

          {blocked && (
            <p className="border-l-2 border-warn py-1.5 pl-3 text-meta leading-relaxed text-warn">
              <span>{blocked}</span>
              {!book.global && (
                <button
                  type="button"
                  onClick={() => onGoto?.("role")}
                  className="underline"
                >
                  去「角色」面板
                </button>
              )}
            </p>
          )}

          {usage && (
            <p className="border-l-2 border-line py-1.5 pl-3 text-meta leading-relaxed text-ink-faint">
              {usage}
            </p>
          )}

          <SaveBar hint="只影响这本世界书" />
        </div>
      </Card>

      <Fold
        title="条目"
        desc="常驻的每轮都注入，其余的命中关键词才注入"
        badge={`${entries.filter((e) => e.enabled).length}/${entries.length} 开着`}
        defaultOpen
      >
        <div className="grid grid-cols-1 gap-4">
          {entries.length === 0 && (
            <p className="py-4 text-center text-ui text-ink-faint">
              这本书还是空的，点下面「新增条目」。
            </p>
          )}

          <div className="grid grid-cols-1 gap-2">
            {entries.map((e, i) => (
              <WorldEntryRow
                key={e.id}
                book={book}
                entry={e}
                index={i}
                total={entries.length}
                open={editId === e.id}
                onToggleOpen={() => setEditId(editId === e.id ? "" : e.id)}
                onClosed={() => setEditId("")}
              />
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-meta leading-relaxed text-ink-faint">
              这里的上下顺序只是给你看的 —— 真正的注入顺序看每条自己的「顺序」数字。
            </p>
            <Button variant="outline" onClick={() => setEditId(addWorldEntry(book.id))}>
              <Plus size={15} /> 新增条目
            </Button>
          </div>

          <SaveBar hint="只影响这本世界书" />
        </div>
      </Fold>

      {/* 导进来的是新的一本，导完直接切过去 —— 好改名、好看一眼对不对 */}
      <TransferCard
        what="这本世界书"
        onExport={() => exportWorldBook(book)}
        onImport={importWorldBook}
        onDone={(made) => pick(made.id)}
      />

      <Card title="删除这本世界书" desc="挂着它的角色引用不会自动清理，会在角色页标红">
        <div className="flex justify-end">
          <Button variant="ghost" onClick={drop} className="text-warn hover:bg-warn/[0.08]">
            <Trash2 size={14} /> 删除世界书
          </Button>
        </div>
      </Card>
    </div>
  );
}

export function WorldEntryRow({ book, entry, index, total, open, onToggleOpen, onClosed }) {
  const { moveWorldEntry, reorderWorldEntry, updateWorldEntry, removeWorldEntry } = useConfig();
  const blocked = worldEntryBlockReason(entry);

  return (
    <DragRow
      id={entry.id}
      index={index}
      onReorder={(id, to) => reorderWorldEntry(book.id, id, to)}
      className="border border-line bg-paper transition-colors duration-150"
    >
      <div className="flex items-start gap-2 px-3 py-2.5">
        <DragHandle className="mt-1 shrink-0 text-ink-faint" />
        <MoveButtons
          first={index === 0}
          last={index === total - 1}
          onUp={() => moveWorldEntry(book.id, entry.id, -1)}
          onDown={() => moveWorldEntry(book.id, entry.id, 1)}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span
              className={`text-ui ${
                entry.enabled ? "text-ink" : "text-ink-faint line-through"
              }`}
            >
              {worldEntryLabel(entry)}
            </span>
            {entry.constant && (
              <span className="rounded-item bg-sunken px-1.5 py-0.5 text-meta text-ink">
                常驻
              </span>
            )}
          </div>
          <p className="mt-0.5 text-meta leading-relaxed text-ink-faint">
            {worldEntryTriggerText(entry)} · {POSITION_LABELS[entry.position] ?? entry.position}
            {entry.position === "depth" ? `（倒数第 ${entry.depth} 条前）` : ""} · 顺序 {entry.order}
          </p>
          {blocked && (
            <p className="mt-1 flex items-start gap-1.5 text-meta leading-relaxed text-warn">
              {blocked}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onToggleOpen}
            aria-label="编辑条目"
            className="rounded-item p-1.5 text-ink-faint transition-colors duration-150 hover:bg-sunken hover:text-ink"
          >
            <Pencil size={14} />
          </button>
          <button
            type="button"
            onClick={() => {
              if (open) onClosed();
              removeWorldEntry(book.id, entry.id);
            }}
            aria-label="删除条目"
            className="rounded-item p-1.5 text-ink-faint transition-colors duration-150 hover:bg-warn/[0.08] hover:text-warn"
          >
            <Trash2 size={14} />
          </button>
          <Switch
            checked={Boolean(entry.enabled)}
            onChange={(v) => updateWorldEntry(book.id, entry.id, { enabled: v })}
            label={`启用「${worldEntryLabel(entry)}」`}
          />
        </div>
      </div>

      {open && (
        <div className="border-t border-line px-3 py-3">
          <WorldEntryEditor book={book} entry={entry} />
        </div>
      )}
    </DragRow>
  );
}

export function WorldEntryEditor({ book, entry }) {
  const { updateWorldEntry, setWorldEntryKeys } = useConfig();
  const patch = (p) => updateWorldEntry(book.id, entry.id, p);
  const keysText = (entry.keys ?? []).join("、");
  const secondText = (entry.secondaryKeys ?? []).join("、");
  // 纯 ASCII 的关键词才谈得上「整词匹配」，中文没有词边界
  const asciiOnly =
    (entry.keys ?? []).length > 0 && (entry.keys ?? []).every((k) => /^[\x20-\x7e]+$/.test(k));

  return (
    <div className="grid grid-cols-1 gap-4">
      <Field label="条目名称" hint="留空就拿第一个关键词当名字">
        <input
          className={inputCls}
          value={entry.name ?? ""}
          onChange={(e) => patch({ name: e.target.value })}
          placeholder="例如：王都"
        />
      </Field>

      <label className="flex items-start justify-between gap-4">
        <span className="min-w-0">
          <span className="block text-ui text-ink">常驻</span>
          <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
            打开 = 不看关键词，每轮都注入。常驻条目多了每轮都在烧 token。
          </span>
        </span>
        <Switch
          checked={Boolean(entry.constant)}
          onChange={(v) => patch({ constant: v })}
          label="常驻"
        />
      </label>

      {!entry.constant && (
        <>
          <Field label="关键词" hint="顿号、逗号或换行分隔，命中任一个就触发">
            <input
              className={inputCls}
              value={keysText}
              onChange={(e) => setWorldEntryKeys(book.id, entry.id, "keys", e.target.value)}
              placeholder="王都、阿瓦隆"
            />
          </Field>
          <Field
            label="次要关键词"
            hint="填了就要求「主关键词命中 且 这里也命中一个」，留空表示不加这个条件"
          >
            <input
              className={inputCls}
              value={secondText}
              onChange={(e) =>
                setWorldEntryKeys(book.id, entry.id, "secondaryKeys", e.target.value)
              }
              placeholder="（留空）"
            />
          </Field>
          <div className="grid grid-cols-1 gap-2">
            <label className="flex cursor-pointer items-start gap-2.5 text-meta leading-relaxed text-ink-soft">
              <input
                type="checkbox"
                checked={Boolean(entry.caseSensitive)}
                onChange={(e) => patch({ caseSensitive: e.target.checked })}
                className="mt-0.5 shrink-0 accent-ink"
              />
              <span>区分大小写</span>
            </label>
            <label className="flex cursor-pointer items-start gap-2.5 text-meta leading-relaxed text-ink-soft">
              <input
                type="checkbox"
                checked={Boolean(entry.matchWholeWords)}
                onChange={(e) => patch({ matchWholeWords: e.target.checked })}
                className="mt-0.5 shrink-0 accent-ink"
              />
              <span>
                整词匹配
                <span className="block text-meta text-ink-faint">
                  {asciiOnly
                    ? "避免 cat 命中 category 这种"
                    : "中文没有词边界，对中文关键词这项不起作用"}
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2.5 text-meta leading-relaxed text-ink-soft">
              <input
                type="checkbox"
                checked={Boolean(entry.excludeRecursion)}
                onChange={(e) => patch({ excludeRecursion: e.target.checked })}
                className="mt-0.5 shrink-0 accent-ink"
              />
              <span>
                不参与递归
                <span className="block text-meta text-ink-faint">
                  这条不会被别的条目的内容触发，它的内容也不拿去触发别人
                </span>
              </span>
            </label>
          </div>
        </>
      )}

      <div className="grid grid-cols-1 gap-4 border-t border-line pt-4 sm:grid-cols-2">
        <Field label="插入位置" hint="相对预设里的「世界书」条目">
          <select
            className={inputCls}
            value={entry.position ?? "before"}
            onChange={(e) => patch({ position: e.target.value })}
          >
            {POSITIONS.map((pos) => (
              <option key={pos} value={pos}>
                {POSITION_LABELS[pos]}
              </option>
            ))}
          </select>
        </Field>
        <NumberField
          label="顺序"
          value={entry.order ?? 100}
          min={-1000}
          max={1000}
          step={10}
          onChange={(v) => patch({ order: v })}
          hint="同一个位置里小的排在前面"
        />
      </div>

      {entry.position === "depth" && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <NumberField
            label="深度"
            value={entry.depth ?? 4}
            min={1}
            max={200}
            step={1}
            onChange={(v) => patch({ depth: v })}
            hint="插到倒数第 N 条上文之前（1 = 紧贴对方刚发的那句）"
            suffix="条"
          />
          <Field label="身份" hint="这条插进上下文时以谁的口气出现">
            <select
              className={inputCls}
              value={entry.depthRole ?? "system"}
              onChange={(e) => patch({ depthRole: e.target.value })}
            >
              {ENTRY_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ENTRY_ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}

      <Field label="内容" hint="触发时插进提示词的文字。支持 {{char}} / {{user}}">
        <textarea
          className={`${inputCls} min-h-[140px] resize-y leading-relaxed`}
          value={entry.content ?? ""}
          onChange={(e) => patch({ content: e.target.value })}
          placeholder="这条设定的具体内容…"
        />
      </Field>
    </div>
  );
}
