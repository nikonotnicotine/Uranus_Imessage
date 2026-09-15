import { useEffect, useRef, useState } from "react";
import { commandCollision, DEFAULT_PRIVACY_TRIGGER } from "../commands-help.js";
import { splitBubbles } from "../delay.js";
import { SaveBar } from "../section.jsx";
import { useConfig } from "../store.jsx";
import { Button, Card, Field, NumberField, ResultNote, Slider, Switch, inputCls } from "../ui.jsx";
import { AlertTriangle, EyeOff, Play, RotateCcw } from "lucide-react";

export function ChatPanel() {
  const { config, updateChat, updateDelay } = useConfig();
  const d = config.chat.delay;

  return (
    <Card title="发送节奏" desc="所有角色共用的收发节奏：气泡怎么拆、连发怎么合并">
      <div className="grid grid-cols-1 gap-10">
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <Field label="气泡分隔符" hint="按此符号拆成多条气泡">
            <input
              className={`${inputCls} !w-24 text-center`}
              value={config.chat.separator}
              onChange={(e) => updateChat({ separator: e.target.value })}
              maxLength={3}
            />
          </Field>
          <NumberField
            label="合并等待"
            value={config.chat.queueWait}
            min={1}
            max={60}
            step={1}
            onChange={(v) => updateChat({ queueWait: v })}
            hint="合并用户连发消息"
            suffix="秒"
          />
        </div>

        {/* 消息延迟 */}
        <div>
          <div className="mb-6 border-b border-line pb-3">
            <h3 className="font-serif text-h3 text-ink">消息延迟</h3>
            <p className="mt-1 max-w-[62ch] text-meta leading-relaxed text-ink-faint">
              模拟真人打字，相邻气泡之间按字数计算间隔
            </p>
          </div>
          <div className="grid grid-cols-1 gap-6">
            <Field label="打字速度" hint="每字基础耗时">
              <div className="flex items-center gap-3">
                <Slider min={0.05} max={1} step={0.05} value={d.typingSpeed} onChange={(v) => updateDelay({ typingSpeed: v })} />
                <span className="w-12 text-right font-mono text-meta text-ink">{d.typingSpeed.toFixed(2)}</span>
              </div>
            </Field>
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              <Field label="随机下限">
                <div className="flex items-center gap-3">
                  <Slider min={0} max={1} step={0.01} value={d.randomMin} onChange={(v) => updateDelay({ randomMin: v })} />
                  <span className="w-10 text-right font-mono text-meta text-ink">{d.randomMin.toFixed(2)}</span>
                </div>
              </Field>
              <Field label="随机上限">
                <div className="flex items-center gap-3">
                  <Slider min={0} max={1} step={0.01} value={d.randomMax} onChange={(v) => updateDelay({ randomMax: v })} />
                  <span className="w-10 text-right font-mono text-meta text-ink">{d.randomMax.toFixed(2)}</span>
                </div>
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
              <NumberField label="延迟下限" value={d.clampMin} min={0.1} max={60} step={0.1} onChange={(v) => updateDelay({ clampMin: v })} suffix="秒" />
              <NumberField label="延迟上限" value={d.clampMax} min={1} max={120} step={0.1} onChange={(v) => updateDelay({ clampMax: v })} suffix="秒" />
              <div className="flex items-end pb-2 sm:col-span-2">
                <p className="text-meta leading-relaxed text-ink-faint">
                  字数 ×（打字速度 + 随机值），夹在 [{d.clampMin.toFixed(1)} ~ {d.clampMax.toFixed(1)}] 秒
                </p>
              </div>
            </div>
          </div>
        </div>

        <SaveBar hint="这些是全局设置，对所有角色生效" />
      </div>
    </Card>
  );
}

/**
 * 防相亲。
 *
 * 开着的时候，这个 App 自己发的话一条都不进聊天 —— 指令的确认、报错、
 * 记忆和日记总结那些带 ⚠️ ✅ 的系统发言。**角色自己的回复照发**，
 * 不然开着就没法聊天了。挡的是「别人瞟一眼手机，正好撞见一条
 * 『✅ 已切换到 gpt-4o』」这种场面。
 *
 * 暗号在手机上和这儿都能翻开关，所以网页上摊开的这份草稿随时可能过时，
 * 下面那行提示说的就是这件事。
 */
export function PrivacyPanel() {
  const { config, updatePrivacy } = useConfig();
  const p = config.privacy ?? {};
  const on = Boolean(p.enabled);
  const raw = String(p.trigger ?? "");
  // 空的按默认值算 —— 后端 normalizePrivacy 也会兜同一道，这里只是先把话说到前面
  const trigger = raw.trim() || DEFAULT_PRIVACY_TRIGGER;
  const bare = trigger.startsWith("/") ? trigger.slice(1) : trigger;
  const clash = commandCollision(trigger);

  return (
    <Card
      title="防相亲"
      desc="开着的时候，系统发言一条都不发进聊天：指令的确认、报错、记忆和日记的总结。角色自己的回复照常发。"
    >
      <div className="grid grid-cols-1 gap-8">
        <div className="flex items-start justify-between gap-6 border-b border-line pb-6">
          <div className="min-w-0 max-w-[62ch]">
            <p className="flex items-center gap-2 text-ui text-ink">
              <EyeOff size={14} className="shrink-0 text-ink-faint" />
              屏蔽所有系统发言
            </p>
            <p className="mt-1 text-meta leading-relaxed text-ink-faint">
              {on
                ? "现在是开着的。指令照常生效，只是不再回一句确认 —— 屏幕上什么都不会冒出来。"
                : "现在是关着的。指令确认和报错会正常发进聊天。"}
            </p>
          </div>
          <Switch checked={on} onChange={(v) => updatePrivacy({ enabled: v })} label="防相亲" />
        </div>

        <Field label="暗号" hint="发这个词翻开关">
          <input
            className={inputCls}
            value={raw}
            onChange={(e) => updatePrivacy({ trigger: e.target.value })}
            placeholder={DEFAULT_PRIVACY_TRIGGER}
            maxLength={40}
          />
        </Field>

        <div className="grid grid-cols-1 gap-3">
          <p className="max-w-[62ch] text-meta leading-relaxed text-ink-soft">
            在 iMessage 里发
            <code className="mx-1 font-mono text-ink">{trigger}</code>
            {bare !== trigger && (
              <>
                或者
                <code className="mx-1 font-mono text-ink">{bare}</code>
              </>
            )}
            就翻一次开关 —— 这是全站唯一一条不要求带
            <code className="mx-1 font-mono text-ink">/</code>
            的指令，为的是它看上去更像一句普通的话。整条消息必须只有这个词，混在句子里不算。
          </p>
          <p className="max-w-[62ch] text-meta leading-relaxed text-ink-faint">
            开的那一下是静悄悄的：一条「✅ 防相亲已开启」本身就是最露馅的消息。
            关的时候会回一句确认，好让你知道它真的关了。
          </p>
          {!raw.trim() && (
            <ResultNote
              state="note"
              message={`暗号留空会按默认的 ${DEFAULT_PRIVACY_TRIGGER} 算 —— 空串会和每一条空消息都对上，不能真的留空。`}
            />
          )}
          {clash && (
            <ResultNote
              state="fail"
              icon={AlertTriangle}
              message={`这个暗号和指令 /${clash} 撞了。撞车时真指令赢，所以这条暗号永远不会触发 —— 换一个词。`}
            />
          )}
        </div>

        {/*
          * 手机那头也能翻这个开关，网页上这份草稿是进页面那一刻拉的。
          * 点保存会把整份草稿写回去，于是「刚在手机上开的防相亲被网页关掉」
          * 是真的会发生的事。这不是新问题（/provider、/model 一样），
          * 但这一条关掉的后果最尴尬，所以单独说一句。
          */}
        <p className="max-w-[62ch] border-l-2 border-line py-1.5 pl-3 text-meta leading-relaxed text-ink-faint">
          这个开关在手机上也能翻。要是刚在 iMessage 里开过，网页先刷新一下再保存
          —— 否则这一页的旧状态会把它盖回去。
        </p>
      </div>
    </Card>
  );
}

export const DEFAULT_DEMO_TEXT =
  "你好呀$我刚刚订到喜欢的那家店$周末有空一起去吗";

export function ChatPreview() {
  const { config } = useConfig();
  const [input, setInput] = useState(DEFAULT_DEMO_TEXT);
  const [running, setRunning] = useState(false);
  const [bubbles, setBubbles] = useState([]);
  const [speed, setSpeed] = useState(1);
  const timersRef = useRef([]);

  function clearTimers() {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  }

  function run() {
    clearTimers();
    const b = splitBubbles(input, config.chat);
    setRunning(true);
    setBubbles([]);
    let t = 0;
    b.forEach((item, i) => {
      t += item.delay;
      timersRef.current.push(
        setTimeout(() => {
          setBubbles((prev) => [...prev, item]);
          if (i === b.length - 1) setRunning(false);
        }, (t * 1000) / speed)
      );
    });
  }

  function reset() {
    clearTimers();
    setBubbles([]);
    setRunning(false);
  }

  useEffect(() => () => clearTimers(), []);

  return (
    <Card
      title="预览"
      desc="按当前节奏把一段文字拆成气泡，逐条放出来 —— 分隔符怎么切、两条之间等多久，看这里"
      actions={
        <div className="flex shrink-0 items-center gap-2">
          {/* 倍速：三档都在这一行，选中那档底色 #f4f4f5 */}
          <div className="flex items-center gap-0.5">
            {[1, 2, 4].map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSpeed(s)}
                className={`rounded-item px-2 py-1 text-meta transition-colors duration-150 ${
                  speed === s ? "bg-sunken text-ink" : "text-ink-meta hover:bg-sunken hover:text-ink"
                }`}
              >
                {s}x
              </button>
            ))}
          </div>
          <Button variant="outline" onClick={run} disabled={running || !input.trim()}>
            <Play size={14} /> 播放
          </Button>
          <Button variant="ghost" onClick={reset} disabled={!bubbles.length}>
            <RotateCcw size={14} />
          </Button>
        </div>
      }
    >
      <textarea
        className={`${inputCls} mb-8 min-h-[56px] resize-none`}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder={`用 ${config.chat.separator || "$"} 分隔多条消息…`}
      />

      {/*
       * 全站唯一保留圆角气泡的地方：它在模拟真实的 iMessage 会话，
       * 方角反而看不出模拟的是什么。气泡底色用 #18181b（不是 iOS 蓝）。
       */}
      <div className="min-h-[220px] border border-line bg-sunken p-6">
        {bubbles.length === 0 && (
          <p className="text-meta text-ink-faint">点「播放」看消息如何逐条发出。</p>
        )}
        <div className="flex flex-col items-end gap-2">
          {bubbles.map((b, i) => (
            <div key={i} className="max-w-[80%]">
              <div className="rounded-2xl rounded-br-md bg-ink px-3.5 py-2 text-ui leading-relaxed text-paper-invert">
                {b.text}
              </div>
              <p className="mt-1 text-right text-meta text-ink-faint">
                {i === 0 ? "首条" : `+${b.delay.toFixed(2)}s`}
              </p>
            </div>
          ))}
          {running && (
            <div className="mr-1 inline-flex items-center gap-1 rounded-2xl rounded-br-md bg-ink px-3.5 py-2">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="h-1.5 w-1.5 animate-bounce rounded-full bg-paper-invert/70"
                  style={{ animationDelay: `${i * 0.15}s` }}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
