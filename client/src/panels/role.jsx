import { useEffect, useState } from "react";
import {
  CATEGORY_LABELS,
  SPY_GROUP_NAMES,
  SPY_GROUP_OF_FIELD,
  SPY_SWITCHES,
  describeRef,
  modelLabel,
  modelOptions,
  parseRefValue,
  presetBlockReason,
  presetLabel,
  presetsFor,
  projectLabel,
  providerLabel,
  refValue,
  resolvePreset,
  resolveUser,
  roleBlockReason,
  roleLabel,
  SPY_CHILD_OF_FIELD,
  spyFeatureCount,
  spyFeatureOn,
  spyFeaturesInGroup,
  spySwitchesOn,
  userLabel,
  worldBookLabel,
} from "../labels.js";
import { offlineMediaUrl, uploadOfflineAvatar } from "../offlinemedia.js";
import { SaveBar, useSection } from "../section.jsx";
import { api, useConfig } from "../store.jsx";
import { Button, Card, Field, Fold, Modal, NumberField, Switch, inputCls } from "../ui.jsx";
import {
  Brain,
  Check,
  ChevronRight,
  Copy,
  Dices,
  ImagePlus,
  Loader2,
  Trash2,
  Undo2,
  Users,
  X,
} from "lucide-react";

/**
 * 「打开角色这边的开关，顺手把预设那边对应的条目也打开」。
 *
 * 这几个功能都是**两道闸串着**的：预设里那条提示词（告诉模型该怎么写
 * `[搜索:…]`、`[表情:…]` 这类标记）+ 角色这边的开关。两道都开才真的生效。
 * 但用户看到的只有角色这一页 —— 在这儿点开了「联网搜索」，跑去聊天发现
 * 没反应，得自己想到再去预设里翻一遍，这事儿谁也猜不到。所以这里补一手：
 * **开的时候**把预设那条也一起开上。
 *
 * 只在开的时候动，关的时候一律不碰 —— 预设是**多个角色共用**的，
 * A 角色关掉搜索就把预设那条也关了的话，B 角色会跟着一起哑掉。
 * 少开一道闸顶多是没生效，多关一道是把别人的功能弄坏了。
 *
 * 返回 `openGate(kind)`：`kind` 是 FORMAT_CHILD_KINDS 里的
 * voice / sticker / image / search / leaveOnRead / undoSend，或者 "memory"
 * （记忆是「记忆库」那条固定条目，没有子条目这一层）。
 * 引用回复（quote）没有角色开关，不走这儿。
 */
export function usePresetGate(role) {
  const { config, updatePresetEntry, updateFormatChild } = useConfig();
  return (kind) => {
    const preset = resolvePreset(config, role);
    // 一份预设都没有：服务端会用内置的默认预设，那份本来就全开着，没什么可开的
    if (!preset) return;
    const fixed = kind === "memory" ? "memory" : "format";
    const entry = (preset.entries ?? []).find((e) => e.kind === fixed);
    // 用户把整条固定条目删了：那是他自己的选择，别偷偷加回来
    if (!entry) return;
    if (!entry.enabled) updatePresetEntry(preset.id, entry.id, { enabled: true });
    if (fixed !== "format") return;
    const child = (entry.children ?? []).find((c) => c.kind === kind);
    if (child && !child.enabled) updateFormatChild(preset.id, entry.id, kind, { enabled: true });
  };
}

/**
 * 「联网搜索」那一段。
 *
 * 两层东西挤在一块，界面上要分清：
 *
 *  - **开关在角色上**（role.webSearch.enabled）—— 谁能联网由角色决定，
 *    因为搜索会往外发请求、还要多花一轮生成。
 *  - **密钥是全局的**（config.searchApi）—— 和天气密钥同一个理由：
 *    backup.js 把 roles 原样拷进不含密钥的备份，密钥挂在角色上就会漏出去。
 *    所以这里改密钥是在改所有角色共用的那一份，下面写明了。
 *
 * 还有第三层不在这个面板里：提示词那条子条目在「预设 → 消息格式与功能」里，
 * 那条关掉的话这个开关也不起作用。开着的时候下面会提示去哪儿改措辞。
 */
/**
 * Tavily 每条结果能留哪几个字段。
 *
 * key 要和 config.searchApi.tavily.fields 对得上（server/src/config.js:
 * normalizeTavilyFields），顺序按它们在拼出来那一行里的先后：
 * `1. (日期) 标题 —— 摘要`。
 */
const TAVILY_FIELDS = [
  { key: "publishedDate", name: "发布日期", hint: "拼在最前面的 (2026-09-05)，只有新闻类结果才有" },
  { key: "title", name: "标题", hint: "超过 60 字截断" },
  { key: "content", name: "正文摘要", hint: "Tavily 自己抽取过一遍，超过 180 字截断" },
];

function RoleSearchFields({ role, onGoto }) {
  const { config, savedConfig, updateRole, updateSearchApi } = useConfig();
  const openGate = usePresetGate(role);
  const ws = role.webSearch ?? {};
  const keys = config.searchApi ?? {};
  const tavily = keys.tavily ?? {};
  const brave = keys.brave ?? {};
  const savedKeys = savedConfig?.searchApi ?? {};

  // 老配置里没有 fields 这一项 —— 缺省当全开，和后端的兜底一致
  const fields = tavily.fields ?? {};
  const noFields = TAVILY_FIELDS.every((f) => fields[f.key] === false);

  const blank = (v) => !String(v ?? "").trim();
  const unsaved = (v, savedV) => !blank(v) && String(v ?? "") !== String(savedV ?? "");

  // 有密钥又开着的那条才算真的在用，否则走 DuckDuckGo（见 websearch.js:pickSource）
  const usingTavily = Boolean(tavily.enabled) && !blank(tavily.key);
  const usingBrave = !usingTavily && Boolean(brave.enabled) && !blank(brave.key);
  const source = usingTavily ? "Tavily" : usingBrave ? "Brave" : "DuckDuckGo";

  return (
    <div className="grid grid-cols-1 gap-6">
      <label className="flex items-start justify-between gap-4">
        <span className="min-w-0">
          <span className="block text-ui text-ink">联网搜索</span>
          <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
            允许这个角色在需要实时信息、最新资讯、或者自己答不上来的时候，先写
            <code className="mx-1 bg-sunken px-1">[搜索:关键词]</code>
            去查一下，拿到结果再正式回话 —— 那一趟对方看不见，只会收到最终那条回复。
          </span>
        </span>
        <Switch
          checked={Boolean(ws.enabled)}
          onChange={(v) => {
            updateRole(role.id, { webSearch: { ...ws, enabled: v } });
            if (v) openGate("search");
          }}
          label="启用联网搜索"
        />
      </label>

      {ws.enabled && (
        <div className="grid grid-cols-1 gap-6">
          <p className="text-meta leading-relaxed text-ink-faint">
            现在用的是
            <strong className="text-ink-soft">{source}</strong>
            。提示词的措辞在
            <button
              type="button"
              className="mx-1 underline decoration-line underline-offset-2 hover:text-ink"
              onClick={() => onGoto?.("preset")}
            >
              预设 → 消息格式与功能
            </button>
            里改。开这个开关的时候会把那条子条目一并打开；要是回头在预设里又把它关了，这边开着也不起作用。
            <br />
            搜到的东西<strong className="text-ink-soft">只注入一次</strong>
            、不进存档（跟天气一样，免得后面每一轮都重发一遍过期内容）；
            想回看这轮搜到了什么，去
            <button
              type="button"
              className="mx-1 underline decoration-line underline-offset-2 hover:text-ink"
              onClick={() => onGoto?.("console")}
            >
              控制台
            </button>
            看那条「联网搜索注入 N 条结果」，点开就是原文。
          </p>

          {/*
            三个额度。乘起来就是每轮最多往提示词里灌多少字，所以下面给了个估算 ——
            上限（5 × 10 × 4000）那种配法本身就该让人犹豫一下。
            范围要和 server/src/websearch.js 的 LIMITS 对上。
          */}
          <div className="grid grid-cols-1 gap-5 border-t border-line pt-5">
            <div>
              <p className="text-ui text-ink">额度</p>
              <p className="mt-0.5 text-meta leading-relaxed text-ink-faint">
                这三个是拦 token 的。搜索结果是外部文本，不收着的话一轮能灌进去好几千
                token，而且搜索结果里本来就混着广告和不相干的东西，条数越多噪音越多。
                默认 2 次 / 2 条 / 800 字，够用又不太占地方。
              </p>
            </div>

            {/* 和上面「上下文限制」同一套栅格。hint 长短不一，flex 会排得参差 */}
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              <NumberField
                label="最多搜索次数"
                value={ws.maxQueries ?? 2}
                min={1}
                max={5}
                step={1}
                suffix="次"
                hint="一轮里认前 N 个标记"
                onChange={(v) => updateRole(role.id, { webSearch: { ...ws, maxQueries: v } })}
              />
              <NumberField
                label="每次返回条数"
                value={ws.maxResults ?? 2}
                min={1}
                max={10}
                step={1}
                suffix="条"
                hint="每次搜取几条结果"
                onChange={(v) => updateRole(role.id, { webSearch: { ...ws, maxResults: v } })}
              />
              <NumberField
                label="最大字数限制"
                value={ws.maxChars ?? 800}
                min={200}
                max={4000}
                step={100}
                suffix="字"
                hint="拼完按这个数硬切一刀"
                onChange={(v) => updateRole(role.id, { webSearch: { ...ws, maxChars: v } })}
              />
            </div>

            <p className="text-meta leading-relaxed text-ink-faint">
              这样配下来，一轮最多往提示词里加
              <strong className="text-ink-soft">
                {" "}
                {Math.min(
                  Number(ws.maxChars) || 800,
                  (Number(ws.maxQueries) || 2) * (Number(ws.maxResults) || 2) * 245
                )}{" "}
                字
              </strong>
              （中文约等于同样多的 token）。单条标题和摘要另有 60 / 180 字的上限，那两个不给调。
            </p>
          </div>

          <div className="grid grid-cols-1 gap-5 border-t border-line pt-5">
            <div>
              <p className="text-ui text-ink">搜索 API（可选）</p>
              <p className="mt-0.5 text-meta leading-relaxed text-ink-faint">
                什么都不填也能用 —— 默认扒 DuckDuckGo 的免费网页端点，不要密钥、不要注册，
                但它不是官方 API，<strong className="text-ink-soft">随时可能扒不动</strong>
                （扒不动就当这轮没搜到，不会让消息发不出去）。要稳的话填一个密钥。
                <br />
                密钥
                <strong className="text-ink-soft">是全局的，所有角色共用</strong>
                ，不会进备份文件。两个都开着时优先用 Tavily。
              </p>
            </div>

            <label className="flex items-start justify-between gap-4">
              <span className="min-w-0">
                <span className="block text-ui text-ink">Tavily</span>
                <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                  专门给 LLM 用的搜索 API，返回的摘要它自己抽取过一遍，质量比扒网页高。
                </span>
              </span>
              <Switch
                checked={Boolean(tavily.enabled)}
                onChange={(v) => updateSearchApi({ tavily: { ...tavily, enabled: v } })}
                label="启用 Tavily"
              />
            </label>
            {tavily.enabled && (
              <>
                <Field label="API Key">
                  <input
                    type="password"
                    className={`${inputCls} ${blank(tavily.key) ? "border-warn text-warn" : ""}`}
                    value={tavily.key ?? ""}
                    onChange={(e) =>
                      updateSearchApi({ tavily: { ...tavily, key: e.target.value } })
                    }
                    placeholder="填你自己的 API Key"
                  />
                </Field>

                {/*
                  保留字段和相关度只有 Tavily 这条路认 —— 另外两个源的返回里
                  压根没有这些东西，所以整块跟着 tavily.enabled 一起显示/隐藏。
                */}
                <div>
                  <p className="text-ui text-ink">保留字段</p>
                  <p className="mt-0.5 text-meta leading-relaxed text-ink-faint">
                    Tavily 每条结果给的是标题、正文摘要、发布日期和一个相关度分数。
                    勾掉的不会拼进提示词 —— 省 token 就省在这儿。
                    发布日期<strong className="text-ink-soft">只有新闻类结果才带</strong>
                    ，普通网页大多没有，所以它是「有就带、没有就不占位」，不会留个空括号。
                  </p>
                </div>

                <div className="grid grid-cols-1 gap-4">
                  {TAVILY_FIELDS.map((f) => (
                    <label key={f.key} className="flex items-start justify-between gap-4">
                      <span className="min-w-0">
                        <span className="block text-ui text-ink">{f.name}</span>
                        <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                          {f.hint}
                        </span>
                      </span>
                      <Switch
                        checked={fields[f.key] !== false}
                        onChange={(v) =>
                          updateSearchApi({
                            tavily: { ...tavily, fields: { ...fields, [f.key]: v } },
                          })
                        }
                        label={`保留${f.name}`}
                      />
                    </label>
                  ))}
                </div>

                {noFields && (
                  <p className="text-meta leading-relaxed text-warn">
                    三个都关掉了：每条结果都拼不出内容，会被整条丢掉 —— 这么配等于把搜索关了。
                  </p>
                )}

                <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                  <NumberField
                    label="最低相关度"
                    value={tavily.minScore ?? 0.65}
                    min={0}
                    max={1}
                    step={0.05}
                    hint="0 = 不过滤"
                    onChange={(v) => updateSearchApi({ tavily: { ...tavily, minScore: v } })}
                  />
                </div>
                <p className="text-meta leading-relaxed text-ink-faint">
                  Tavily 给每条结果打一个 0~1 的相关度分，低于这个数的直接丢掉，剩下的才拼进提示词。
                  默认 0.65 —— 大致是「跟关键词确实沾边」那条线；调高会更干净但可能一条不剩，
                  调低噪音多、也更费 token。上游没给分的那种条目不算低分，照留。
                  <br />
                  这两项和密钥一样
                  <strong className="text-ink-soft">是全局的、所有角色共用</strong>
                  ，也一样不进备份文件。
                </p>
              </>
            )}

            <label className="flex items-start justify-between gap-4 border-t border-line pt-5">
              <span className="min-w-0">
                <span className="block text-ui text-ink">Brave Search</span>
                <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                  Brave 的官方搜索 API，有免费额度。
                </span>
              </span>
              <Switch
                checked={Boolean(brave.enabled)}
                onChange={(v) => updateSearchApi({ brave: { ...brave, enabled: v } })}
                label="启用 Brave Search"
              />
            </label>
            {brave.enabled && (
              <Field label="API Key">
                <input
                  type="password"
                  className={`${inputCls} ${blank(brave.key) ? "border-warn text-warn" : ""}`}
                  value={brave.key ?? ""}
                  onChange={(e) => updateSearchApi({ brave: { ...brave, key: e.target.value } })}
                  placeholder="填你自己的 API Key"
                />
              </Field>
            )}

            {(unsaved(tavily.key, savedKeys.tavily?.key) ||
              unsaved(brave.key, savedKeys.brave?.key)) && (
              <p className="flex items-start gap-1.5 text-meta leading-relaxed text-warn">
                有密钥还没保存，这会儿发消息还在用旧的（或者退回 DuckDuckGo）。
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 折叠标题右边那个查岗徽标。
 *
 * 别的功能一个开关，`onOff` 显示「开 / 关」就够了；查岗有两个，折叠着的时候
 * 光说「开」看不出开的是哪一头。
 */
function spyBadge(spy) {
  const { on } = spySwitchesOn(spy);
  if (!on.length) return "关";
  /*
   * 五个全开时不逐个列 —— 折叠标题那一行放不下「电脑查岗+手机查岗+查看手机里的
   * 东西+操控手机+让角色放歌」，而且那串字读起来还不如「全开」直观。
   */
  if (on.length === SPY_SWITCHES.length) return "全开";
  return on.join("+");
}

/**
 * 「查岗」那一段。
 *
 * 和联网搜索同一个形态（开关在角色上 + 一条子条目在预设里），但要多交代三件事：
 *
 *  - **它把用户自己的屏幕外传给视觉模型。** 这是这个面板里外溢最狠的开关，
 *    所以文案里明写这一句，不含糊过去 —— 用户得知道自己开的是什么。
 *    两条腿各一个开关，这句话**两边都要有** —— 拆开不是把风险说小了。
 *  - **两条腿是两个开关。** 电脑那头是「GET 一下回一张图」，手机那头要发一封
 *    邮件、把用户手机唤起来、等十几秒，代价和形态压根不一样。所以「只让它看
 *    电脑、别动我手机」得能表达出来（服务端字段见 config.js:normalizeSpy）。
 *  - **识图用的是这个角色的识图模型。** 没开识图模型的话查岗只能抓到图、
 *    看不出内容，界面上要当场提示，而不是让用户发一轮消息才在控制台里发现。
 *
 * 两份回退文案给了输入框：用户明确要求「回退成功时的提示模板、手机和电脑都
 * 失败时的提示模板也都要」。留空 = 用 spy.js 里的默认，placeholder 里摆的就是
 * 默认原文的头一句，好让人看出格式。
 */
function RoleSpyFields({ role, onGoto }) {
  const { updateRole, updateSpyApi, config } = useConfig();
  const openGate = usePresetGate(role);
  const spy = role.spy ?? {};
  const set = (patch) => updateRole(role.id, { spy: { ...spy, ...patch } });

  const pcOn = Boolean(spy.pcEnabled);
  const phoneOn = Boolean(spy.phoneEnabled);
  const viewOn = Boolean(spy.phoneViewEnabled);
  const controlOn = Boolean(spy.phoneControlEnabled);
  const musicOn = Boolean(spy.phoneMusicEnabled);
  // 手机里那三组任一开着，都要那套 SMTP 凭据 —— 和手机屏幕查岗走的是同一条腿
  const needsPhone = phoneOn || viewOn || controlOn || musicOn;
  const anyOn = pcOn || needsPhone;
  /*
   * 打开一条腿时，把预设里**对着它那一条**子条目一并打开 —— 不然开关开了也不注入。
   *
   * 查岗在预设里是四条（屏幕 / 查看 / 控制 / 网易云），所以这儿要按字段找对应
   * 那一条，不能笼统开一条了事：用户点开「让角色放歌」，该开的是 spyMusic，
   * 把四条全开上等于替他同意了另外三摊他没点的事。
   *
   * 只在**开**的时候动，关的时候一律不碰 —— 预设是多个角色共用的（见 usePresetGate）。
   */
  const turnOn = (patch) => {
    set(patch);
    for (const [field, v] of Object.entries(patch)) {
      if (!v) continue;
      const kind = SPY_CHILD_OF_FIELD[field];
      if (kind) openGate(kind);
    }
  };

  /*
   * 手机那头的凭据在全局的 spyApi 上（不是角色上的）—— 它描述的是
   * 「用户那部 iPhone」，所有角色共用一份。
   */
  const smtp = config.spyApi ?? {};
  const blank = (v) => !String(v ?? "").trim();
  // 快捷指令里要拼完整 URL，路径这里就按服务端的规矩补全展示（见 config.js:normalizeWebhookPath）
  const rawPath = String(smtp.webhookPath ?? "").trim() || "/phone/screenshot";
  const displayPath = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;

  // 识图模型没开的话查岗抓到图也看不出内容（见 spy.js:lookAt）
  const noVision = !role.visionModel?.enabled;

  return (
    <div className="grid grid-cols-1 gap-6">
      <p className="text-meta leading-relaxed text-ink-faint">
        允许这个角色去看一眼你此刻的屏幕上是什么，然后照着回话 —— 那一趟对方看不见，
        只会收到最终那条回复。
        <br />
        <strong className="text-ink-soft">
          开这个等于把你屏幕上的东西发给视觉模型
        </strong>
        （截图不落盘、只在这一轮里用完就丢，但它确实经过了模型那头）。
        <br />
        两头是<strong className="text-ink-soft">两个独立开关</strong>
        ：只开一个的话，提示词里另一头那个标签压根不会告诉模型，
        它硬写也不会真的去抓。
      </p>

      <label className="flex items-start justify-between gap-4">
        <span className="min-w-0">
          <span className="block text-ui text-ink">电脑查岗</span>
          <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
            允许这个角色写
            <code className="mx-1 bg-sunken px-1">[查岗实时电脑屏幕]</code>
            ，抓一张你<strong className="text-ink-soft">电脑桌面</strong>
            的截图。走本地截图程序的一个 GET 接口，几百毫秒就回来，
            你那头没有任何动静。
          </span>
        </span>
        <Switch
          checked={pcOn}
          onChange={(v) => turnOn({ pcEnabled: v })}
          label="启用电脑查岗"
        />
      </label>

      <label className="flex items-start justify-between gap-4">
        <span className="min-w-0">
          <span className="block text-ui text-ink">手机查岗</span>
          <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
            允许这个角色写
            <code className="mx-1 bg-sunken px-1">[查岗实时手机屏幕]</code>
            ，抓一张你<strong className="text-ink-soft">iPhone 屏幕</strong>
            的截图。这一头是
            <strong className="text-ink-soft">发一封邮件把你手机唤起来</strong>
            、等它把图传回来，一趟十几秒，而且需要先在 iPhone 上配好快捷指令
            （下面有步骤）。
          </span>
        </span>
        <Switch
          checked={phoneOn}
          onChange={(v) => turnOn({ phoneEnabled: v })}
          label="启用手机查岗"
        />
      </label>

      {/*
        手机**里面**那三组。和上面两个屏幕开关分开摆（中间一条横线），因为
        它们是另一回事：上面是「看一眼他屏幕现在长什么样」，这三个是「替他
        打开某个 App」和「动他的手机」。

        文案从 labels.js:SPY_SWITCHES 读 —— 五个开关的 label 和说明只该有一份，
        badge（spyBadge）和这儿各写一遍迟早会走岔。
      */}
      <div className="grid grid-cols-1 gap-6 border-t border-line pt-6">
        <div>
          <p className="text-ui text-ink">手机里面</p>
          <p className="mt-0.5 text-meta leading-relaxed text-ink-faint">
            上面两个只看一眼屏幕。这三个是让角色
            <strong className="text-ink-soft">替你打开某个 App</strong>
            、或者<strong className="text-ink-soft">直接动你的手机</strong>
            ，走的是和手机查岗同一条邮件链路（所以也要下面那套凭据和快捷指令，
            <strong className="text-ink-soft">而且每一项各要一条自己的快捷指令</strong>
            ）。
          </p>
        </div>

        {SPY_SWITCHES.slice(2).map((s) => {
          const group = SPY_GROUP_OF_FIELD[s.field];
          const on = Boolean(spy[s.field]);
          return (
            <div key={s.field} className="grid grid-cols-1 gap-4">
              <label className="flex items-start justify-between gap-4">
                <span className="min-w-0">
                  <span className="block text-ui text-ink">{s.label}</span>
                  <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                    允许这个角色写
                    <code className="mx-1 bg-sunken px-1">{s.tag}</code>
                    这样的标签。{s.hint}
                  </span>
                </span>
                <Switch
                  checked={on}
                  onChange={(v) => turnOn({ [s.field]: v })}
                  label={`启用${s.label}`}
                />
              </label>

              {/*
                这一组里那几件事各自的开关。只在组开关开着时显示 —— 组关着的时候
                这些开关一个都不起作用（服务端两层都要过，见 spy.js:spyLegs），
                摆出来只会让人以为开了就能用。
              */}
              {on && group && (
                <SpyFeatureToggles group={group} spy={spy} set={set} />
              )}

              {/* 预设歌单紧跟着网易云那一组，中间不夹别的开关 */}
              {s.field === "phoneMusicEnabled" && musicOn && (
                <PlaylistFields playlists={smtp.playlists} updateSpyApi={updateSpyApi} />
              )}
            </div>
          );
        })}
      </div>

      {anyOn && (
        <div className="grid grid-cols-1 gap-6">
          <p className="text-meta leading-relaxed text-ink-faint">
            提示词的措辞在
            <button
              type="button"
              className="mx-1 underline decoration-line underline-offset-2 hover:text-ink"
              onClick={() => onGoto?.("preset")}
            >
              预设 → 消息格式与功能
            </button>
            里改。开这个开关的时候会把那条子条目一并打开；要是回头在预设里又把它关了，这边开着也不起作用。
            <br />
            看到的东西<strong className="text-ink-soft">只注入一次</strong>
            、不进存档（跟天气和搜索一样，免得后面每一轮都重发一遍过期画面）；
            想回看这轮看到了什么，去
            <button
              type="button"
              className="mx-1 underline decoration-line underline-offset-2 hover:text-ink"
              onClick={() => onGoto?.("console")}
            >
              控制台
            </button>
            看那条「查岗内容注入 N 字」，点开就是原文。
          </p>

          {noVision && (
            <p className="text-meta leading-relaxed text-warn">
              这个角色的<strong>识图模型是关的</strong>
              ，查岗能抓到屏幕但看不出内容。去上面「API 与模型」里把识图打开。
            </p>
          )}

          {/*
            两头形态不同（见 server/src/spyphone.js 头注释）：电脑那头是「GET
            一下回一张图」，给个地址就行；手机那头 iPhone 截不了自己的图由人拉，
            是「服务端发触发邮件 → 邮件自动化跑快捷指令 → 截屏 POST 回来」，
            所以给的是发件凭据和校验密钥。这套凭据描述的是「你那部 iPhone」，
            本来就不属于哪个角色，所以挂在全局的 spyApi 上、所有角色共用。

            两块各自只在**那条腿开着**时出现：只开电脑的人不该被要求填 SMTP
            凭据，那一大片输入框摆在那儿只会让人以为不填就用不了。
          */}
          {pcOn && (
          <div className="grid grid-cols-1 gap-5 border-t border-line pt-5">
            <div>
              <p className="text-ui text-ink">电脑那头</p>
              <p className="mt-0.5 text-meta leading-relaxed text-ink-faint">
                「
                <strong className="text-ink-soft">GET 一下回一张图</strong>
                」的接口。没写路径时自动补
                <code className="mx-1 bg-sunken px-1">/screenshot</code>。
                <br />
                用
                <strong className="text-ink-soft"> astrbot_plugin_screen_monitor_exe </strong>
                这个本地程序，在你自己的 Windows 上跑起来就行，默认监听
                <code className="mx-1 bg-sunken px-1">127.0.0.1:6878</code>；
                服务端和你不在同一台机器上时，填那台机器的局域网 IP。
              </p>
            </div>

            <Field label="电脑截图地址" hint="留空 = 不查电脑">
              <input
                className={inputCls}
                value={spy.pcUrl ?? ""}
                onChange={(e) => set({ pcUrl: e.target.value })}
                placeholder="127.0.0.1:6878"
              />
            </Field>
          </div>
          )}

          {needsPhone && (
          <div className="grid grid-cols-1 gap-5 border-t border-line pt-5">
            <div>
              <p className="text-ui text-ink">手机那头</p>
              <p className="mt-0.5 text-meta leading-relaxed text-ink-faint">
                iPhone 没法被「拉」—— App 不能后台监听端口。走的是
                <strong className="text-ink-soft">邮件触发</strong>
                ：服务端发一封带关键字的邮件，你 iPhone 上的邮件自动化收到后跑一个快捷指令，
                截屏再传回来。所以这里填的不是地址，是发件邮箱和校验密钥。
                <br />
                <strong className="text-ink-soft">收件的必须是 iCloud 邮箱</strong>
                （邮件自动化只对 iCloud 邮件的推送即时响应；QQ / Gmail 这类要轮询，慢 5–15 分钟）。
                发件邮箱随意 —— iCloud、QQ、163 都行，
                <strong className="text-ink-soft">自己发给自己最省事</strong>。
                iCloud 的端口必须 587，QQ / 163 一般 465。
                <br />
                这套凭据<strong className="text-ink-soft">是全局的，所有角色共用</strong>
                （它描述的是你那部 iPhone，不是哪个角色），也不进备份文件。
              </p>
            </div>

            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              <Field label="SMTP 服务器" hint="iCloud 是 smtp.mail.me.com；QQ 是 smtp.qq.com">
                <input
                  className={`${inputCls} ${blank(smtp.smtpHost) ? "border-warn text-warn" : ""}`}
                  value={smtp.smtpHost ?? ""}
                  onChange={(e) => updateSpyApi({ smtpHost: e.target.value })}
                  placeholder="smtp.mail.me.com"
                />
              </Field>
              <NumberField
                label="SMTP 端口"
                value={smtp.smtpPort ?? 587}
                min={1}
                max={65535}
                step={1}
                hint="iCloud 必须 587；QQ / 163 一般 465"
                onChange={(v) => updateSpyApi({ smtpPort: v })}
              />
              <Field label="SMTP 账号" hint="完整邮箱地址；也是 iPhone 自动化里「发件人包含」那个条件">
                <input
                  className={`${inputCls} ${blank(smtp.smtpUser) ? "border-warn text-warn" : ""}`}
                  value={smtp.smtpUser ?? ""}
                  onChange={(e) => updateSpyApi({ smtpUser: e.target.value })}
                  placeholder="someone@icloud.com"
                />
              </Field>
              <Field label="SMTP 密码" hint="不是登录密码 —— iCloud 用 App 专用密码，QQ / 163 用授权码">
                <input
                  type="password"
                  className={`${inputCls} ${blank(smtp.smtpPass) ? "border-warn text-warn" : ""}`}
                  value={smtp.smtpPass ?? ""}
                  onChange={(e) => updateSpyApi({ smtpPass: e.target.value })}
                  placeholder="abcd-efgh-ijkl-mnop"
                />
              </Field>
              <Field label="收件的 iCloud 邮箱" hint="必须是 iCloud 邮箱；可以和 SMTP 账号同一个（自发自收）">
                <input
                  className={`${inputCls} ${blank(smtp.mailTo) ? "border-warn text-warn" : ""}`}
                  value={smtp.mailTo ?? ""}
                  onChange={(e) => updateSpyApi({ mailTo: e.target.value })}
                  placeholder="someone@icloud.com"
                />
              </Field>
              <Field label="邮件主题关键字" hint="iPhone 自动化按「主题包含」认这个词，和快捷指令里的条件保持一致">
                <input
                  className={inputCls}
                  value={smtp.subject ?? ""}
                  onChange={(e) => updateSpyApi({ subject: e.target.value })}
                  placeholder="PHONESPY_TRIGGER"
                />
              </Field>
              <Field label="校验密钥" hint="要一字不差填进 iPhone 快捷指令的 secret 字段，所以这里摆成明文">
                <input
                  className={`${inputCls} ${blank(smtp.webhookSecret) ? "border-warn text-warn" : ""}`}
                  value={smtp.webhookSecret ?? ""}
                  onChange={(e) => updateSpyApi({ webhookSecret: e.target.value })}
                  placeholder="openssl rand -hex 24 生成一个"
                />
              </Field>
              <NumberField
                label="等图秒数"
                value={smtp.waitSeconds ?? 90}
                min={20}
                max={180}
                step={1}
                suffix="秒"
                hint="发完邮件最多等多久；超时就当手机没看到，走回退"
                onChange={(v) => updateSpyApi({ waitSeconds: v })}
              />
            </div>

            <Field label="收图路径" hint="一般不用改；改了要同步快捷指令里那个 URL">
              <input
                className={inputCls}
                value={smtp.webhookPath ?? ""}
                onChange={(e) => updateSpyApi({ webhookPath: e.target.value })}
                placeholder="/phone/screenshot"
              />
            </Field>

            <div>
              <p className="text-ui text-ink">iPhone 上要配两样（一次配好，之后全自动）</p>
              <p className="mt-1 text-meta leading-relaxed text-ink-faint">
                ①
                <strong className="text-ink-soft">快捷指令 App</strong>
                新建一个快捷指令：截屏 → 转换图像（JPEG、质量 0.5）→ 获取 URL 内容
                （URL 填
                <code className="mx-1 bg-sunken px-1">http://服务端IP:端口{displayPath}</code>
                ，方法
                <strong className="text-ink-soft">POST</strong>
                、请求体选
                <strong className="text-ink-soft">表单</strong>
                ，加两个字段：
                <code className="mx-1 bg-sunken px-1">secret</code>
                填校验密钥、
                <code className="mx-1 bg-sunken px-1">image</code>
                选「转换后的图像」）。
                <br />
                ② 再建一个
                <strong className="text-ink-soft">个人自动化</strong>
                →「邮件」→ 收到新邮件时，三个条件都设：发件人包含 SMTP 账号、主题包含主题关键字、收件人包含你的
                iCloud 邮箱；动作选刚那个快捷指令，
                <strong className="text-ink-soft">关掉「运行前询问」</strong>
                。
                <br />
                ③ 测试：让角色查岗一次，看邮件几秒内到没到、快捷指令跑没跑。
                需要 iOS 18.4 或更新版本（邮件自动化要求）。
              </p>
            </div>
          </div>
          )}

          {/*
            自动回退和那两份模板**只管屏幕查岗**，所以整块只在屏幕那两个开关
            任一开着时才出现：手机里那三组没有「另一头」可倒（`[查岗手机:支付宝
            账单]` 没看到不能改成「那看看微信吧」，见 imessage.js:phoneRound），
            模板也是另外一套写死的（spy.js:PHONE_* 那几份）。只开「放歌」的人
            看到一栏「两头都没看到时」只会莫名其妙。
          */}
          {(pcOn || phoneOn) && (
          <div className="grid grid-cols-1 gap-5 border-t border-line pt-5">
            {/*
              自动回退**只在两条腿都开着时才有意义** —— 只开一条腿的话它无处可倒
              （服务端也不许倒进关着的腿，见 spy.js:runSpy），摆在这儿是误导。
            */}
            {pcOn && phoneOn && (
              <label className="flex items-start justify-between gap-4">
                <span className="min-w-0">
                  <span className="block text-ui text-ink">一头没看到就看另一头</span>
                  <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                    手机没抓到就自动改抓电脑，电脑没抓到就自动改抓手机。
                    只倒一次、不来回弹 —— 两头都不通的话第二次注定也不通，
                    多试一轮只是让对方多等十几秒。
                    <br />
                    <strong className="text-ink-soft">只在两个开关都开着时才会倒</strong>
                    ：关掉的那条腿不会因为另一头失败就被叫起来。
                  </span>
                </span>
                <Switch
                  checked={spy.autoFallback !== false}
                  onChange={(v) => set({ autoFallback: v })}
                  label="启用自动回退"
                />
              </label>
            )}

            <div>
              <p className="text-ui text-ink">
                {pcOn && phoneOn ? "两份提示模板" : "没看到时的提示模板"}
              </p>
              <p className="mt-0.5 text-meta leading-relaxed text-ink-faint">
                查岗之后拿什么话去问模型第二次。
                <strong className="text-ink-soft">留空 = 用默认那份</strong>
                ，改坏了清空就恢复。可用变量：
                <code className="mx-1 bg-sunken px-1">{"{{device}}"}</code>
                实际看到的设备、
                <code className="mx-1 bg-sunken px-1">{"{{failed}}"}</code>
                没看到的那个、
                <code className="mx-1 bg-sunken px-1">{"{{screen}}"}</code>
                屏幕内容、
                <code className="mx-1 bg-sunken px-1">{"{{error}}"}</code>
                没看到的原因、
                <code className="mx-1 bg-sunken px-1">{"{{user}}"}</code>
                对方的名字。
              </p>
            </div>

            {/*
              「回退成功时」那份只在双腿模式下会被用到 —— 单腿时压根不会倒向
              另一头（spy.js:runSpy），摆一个永远走不到的编辑框只会让人白改。
              「没看到时」那份两种模式都用得上，所以始终在。
            */}
            {pcOn && phoneOn && (
              <Field
                label="回退成功时"
                hint="想看的那头没看到、另一头看到了。这份要把「你看到的是哪个设备」说清楚，不然模型会把手机说成电脑"
              >
                <textarea
                  className={`${inputCls} min-h-[7rem] font-mono text-xs leading-relaxed`}
                  value={spy.fallbackTemplate ?? ""}
                  onChange={(e) => set({ fallbackTemplate: e.target.value })}
                  placeholder={"{{failed}}屏幕这次没看到（{{error}}），但{{device}}屏幕看到了：…"}
                />
              </Field>
            )}

            {/*
              这一栏（bothFailedTemplate）两种情形共用，默认文案按情形自己换：
              单腿 / 回退关着 → 只说看的那一头；双腿都试过了 → 说两头。所以
              placeholder 跟着模式变，别让单开电脑的人以为角色会去提他手机。
            */}
            <Field
              label={pcOn && phoneOn ? "两头都没看到时" : "没看到时"}
              hint={
                pcOn && phoneOn
                  ? "没有屏幕内容可给，所以这份只交代「没看到」这个事实，让模型按人设自己找台词。自动回退关着时也用它，那时候只会提你看的那一头"
                  : "没有屏幕内容可给，所以这份只交代「没看到」这个事实，让模型按人设自己找台词。只开了一条腿，所以默认那份一个字都不会提另一头"
              }
            >
              <textarea
                className={`${inputCls} min-h-[7rem] font-mono text-xs leading-relaxed`}
                value={spy.bothFailedTemplate ?? ""}
                onChange={(e) => set({ bothFailedTemplate: e.target.value })}
                placeholder={
                  pcOn && phoneOn
                    ? "{{user}}的电脑和手机屏幕这次都没看到（{{error}}）。…"
                    : `{{user}}的${pcOn ? "电脑" : "手机"}屏幕这次没看到（{{error}}）。…`
                }
              />
            </Field>
          </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 一组里那几件事各自的开关（查看类九项 / 控制类四项 / 网易云六项）。
 *
 * 摆在组开关底下、缩进一层、外面套个框，说的就是「这是那个开关的细分」而不是
 * 又一批平级开关。清单从 labels.js:SPY_FEATURE_SWITCHES 读，那是服务端
 * spyfeatures.js 的镜像。
 *
 * **全开是默认**（缺键当开，见 labels.js:spyFeatureOn），所以这儿的常态是「用户
 * 来关掉几项」而不是「来挑几项开」。关掉的那一项：提示词里不教（服务端
 * spy.js:trimSpyPrompt 从清单和示例里都删掉），模型硬写也会被挡（phonePool）。
 *
 * 两个批量按钮是必要的：查看类九项，用户想「只留电量」得点八下。
 */
function SpyFeatureToggles({ group, spy, set }) {
  const all = spyFeaturesInGroup(group);
  const { on, total } = spyFeatureCount(spy, group);
  const features = spy.features ?? {};
  const flip = (key, v) => set({ features: { ...features, [key]: v } });
  // 批量：把这一组每一项都写成同一个值。别组的键原样留着
  const allTo = (v) =>
    set({ features: { ...features, ...Object.fromEntries(all.map((f) => [f.key, v])) } });

  return (
    <div className="grid grid-cols-1 gap-3 rounded border border-line p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-ui text-ink">
            {SPY_GROUP_NAMES[group]}这一类能用哪几项
            <span className="ml-2 font-mono text-meta text-ink-faint">
              {on}/{total}
            </span>
          </p>
          <p className="mt-0.5 text-meta leading-relaxed text-ink-faint">
            默认全开。关掉的那几项<strong className="text-ink-soft">不会写进提示词</strong>
            ，角色压根不知道有这回事；它硬写标签也不会生效。
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="ghost" onClick={() => allTo(true)}>
            全开
          </Button>
          <Button variant="ghost" onClick={() => allTo(false)}>
            全关
          </Button>
        </div>
      </div>

      {all.map((f) => (
        <label key={f.key} className="flex items-start justify-between gap-4">
          <span className="min-w-0">
            <span className="block text-ui text-ink">{f.name}</span>
            {f.hint && (
              <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                {f.hint}
              </span>
            )}
          </span>
          <Switch
            checked={spyFeatureOn(spy, f.key)}
            onChange={(v) => flip(f.key, v)}
            label={`启用${f.name}`}
          />
        </label>
      ))}

      {!on && (
        <p className="text-meta leading-relaxed text-ink-faint">
          这一组一项都没开，等于上面那个开关是关着的 ——
          提示词里这一整行都不会出现。
        </p>
      )}
    </div>
  );
}

/**
 * 预设歌单那一栏（`[操控手机:预设歌单 睡前]` 用的）。
 *
 * **为什么要用户自己填**：歌单 ID 是一串数字，没有公开接口能按名字查到用户
 * 自己收藏的歌单（点歌能搜是因为单曲有公开搜索接口）。所以名字给模型认、
 * ID 给快捷指令用，两样都得他填一次。详见 config.js:normalizeSpyPlaylists。
 *
 * 存在全局 spyApi 上而不是角色上：和 SMTP 凭据一样，它描述的是「用户那部手机
 * 里的网易云」，所有角色共用一份。
 *
 * ID 那一栏**接受整条分享链接**（服务端会抠出数字），所以 placeholder 摆的是
 * 链接而不是裸数字 —— 用户手上现成有的就是链接。
 */
function PlaylistFields({ playlists, updateSpyApi }) {
  const list = Array.isArray(playlists) ? playlists : [];
  // 末尾永远留一行空的，不用先点「加一个」再填（和别处那些清单一个路子）
  const rows = [...list, { name: "", id: "" }];
  const write = (rows2) =>
    updateSpyApi({ playlists: rows2.filter((r) => r.name.trim() || String(r.id).trim()) });

  return (
    <div className="grid grid-cols-1 gap-3 rounded border border-line p-4">
      <div>
        <p className="text-ui text-ink">预设歌单</p>
        <p className="mt-0.5 text-meta leading-relaxed text-ink-faint">
          角色只能放<strong className="text-ink-soft">你在这儿填过的歌单</strong>
          （网易云没有公开接口能按名字查到你收藏的歌单，所以得填一次）。
          <strong className="text-ink-soft">名字给角色认</strong>
          ，随便起，说「放睡前那个」也认得出来；
          <strong className="text-ink-soft">链接直接粘</strong>
          进右边那栏就行，会自己抠出 ID。
          <br />
          一个都不填的话「预设歌单」那一项用不了，其余五项（每日推荐、私人漫游、
          红心歌单、播放/暂停、指定歌曲）不受影响。
        </p>
      </div>

      {rows.map((row, i) => (
        <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_2fr_auto]">
          <input
            className={inputCls}
            value={row.name ?? ""}
            onChange={(e) => {
              const next = rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r));
              write(next);
            }}
            placeholder="睡前"
            aria-label="歌单名字"
          />
          <input
            className={inputCls}
            value={row.id ?? ""}
            onChange={(e) => {
              const next = rows.map((r, j) => (j === i ? { ...r, id: e.target.value } : r));
              write(next);
            }}
            placeholder="https://music.163.com/playlist?id=123456789"
            aria-label="歌单链接或 ID"
          />
          {i < list.length ? (
            <Button
              variant="ghost"
              onClick={() => write(rows.filter((_, j) => j !== i))}
              aria-label={`删掉「${row.name || "这个歌单"}」`}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          ) : (
            <span />
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * 「发语音」那一段。三层结构和 RoleSearchFields 一模一样：
 * 开关在角色、密钥全局（config.ttsApi，在「连接」面板里配）、
 * 提示词在「预设 → 消息格式与功能」。
 *
 * 这里只放**音色 ID** —— 它不是密钥，跟着角色文件一起分享出去没问题，
 * 而且本来就是「这个角色用哪个嗓子」，属于角色的一部分。
 */
function RoleVoiceFields({ role, onGoto }) {
  const { config, updateRole } = useConfig();
  const openGate = usePresetGate(role);
  const vs = role.voiceSend ?? {};
  const tts = config.ttsApi ?? {};

  const blank = (v) => !String(v ?? "").trim();
  // 和 server/src/media.js:pickTtsSource 同一个顺序和判据，三处一起改
  // （另一处在 api.jsx:TtsSection，那边是「连接」面板上填密钥的地方）
  const source = !blank(tts.minimax?.key) && tts.minimax?.enabled
    ? "MiniMax"
    : !blank(tts.elevenlabs?.key) && tts.elevenlabs?.enabled
    ? "ElevenLabs"
    : !blank(tts.sovits?.url) && tts.sovits?.enabled
    ? "GPT-SoVITS"
    : "";

  return (
    <div className="grid grid-cols-1 gap-6">
      <label className="flex items-start justify-between gap-4">
        <span className="min-w-0">
          <span className="block text-ui text-ink">发语音</span>
          <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
            允许这个角色在忙着、或者想表达情绪的时候，把一句话写成
            <code className="mx-1 bg-sunken px-1">[audio_message:内容]</code>
            —— 系统会真的合成一条语音发过去，对方收到的是
            <strong className="text-ink-soft">语音条</strong>，不是一段文字。
          </span>
        </span>
        <Switch
          checked={Boolean(vs.enabled)}
          onChange={(v) => {
            updateRole(role.id, { voiceSend: { ...vs, enabled: v } });
            if (v) openGate("voice");
          }}
          label="启用发语音"
        />
      </label>

      {vs.enabled && (
        <div className="grid grid-cols-1 gap-6">
          <p className="text-meta leading-relaxed text-ink-faint">
            {source ? (
              <>
                现在用的是<strong className="text-ink-soft"> {source} </strong>。
              </>
            ) : (
              <strong className="text-warn">
                三家 TTS 一家都没开，这个开关现在不起作用 ——
                模型写的语音标记会退化成普通文字发出去。
              </strong>
            )}
            密钥
            <strong className="text-ink-soft">是全局的，所有角色共用</strong>
            ，在
            <button
              type="button"
              className="mx-1 underline decoration-line underline-offset-2 hover:text-ink"
              onClick={() => onGoto?.("api")}
            >
              连接 → 语音合成
            </button>
            里配。提示词的措辞在
            <button
              type="button"
              className="mx-1 underline decoration-line underline-offset-2 hover:text-ink"
              onClick={() => onGoto?.("preset")}
            >
              预设 → 消息格式与功能
            </button>
            里改。开这个开关的时候会把那条子条目一并打开；要是回头在预设里又把它关了，这边开着也不起作用。
          </p>

          <Field
            label="音色 ID"
            hint={
              source === "GPT-SoVITS"
                ? "SoVITS 这一家填的是参考音频的路径（服务器上的绝对路径）"
                : "留空就用那家的默认音色"
            }
          >
            <input
              className={inputCls}
              value={vs.voiceId ?? ""}
              onChange={(e) =>
                updateRole(role.id, { voiceSend: { ...vs, voiceId: e.target.value } })
              }
              placeholder={
                source === "ElevenLabs"
                  ? "21m00Tcm4TlvDq8ikWAM"
                  : source === "GPT-SoVITS"
                  ? "/path/to/ref.wav"
                  : "male-qn-qingse"
              }
            />
            <p className="mt-2 text-meta leading-relaxed text-ink-faint">
              这个 ID 是<strong className="text-ink-soft">跟着上面那家</strong>走的
              —— 换一家 TTS 就得换一个 ID，MiniMax 的音色 ID 填给 ElevenLabs 是不认的。
            </p>
          </Field>
        </div>
      )}
    </div>
  );
}

/**
 * 「生成图片」那一段：文生图开关 + 图生图开关 + 这个角色能用哪几张参考图。
 *
 * 生图模型是**全局挑的**（后端 resolveImageEndpoint 扫所有服务商，取第一个
 * 开着且勾了「生图」分类的模型），角色这边只有开关 —— 用户的规范里就是这么定的。
 * 所以这里把解析到的那个模型显示出来，没有就直接说去哪儿勾。
 */
function RoleImageFields({ role, onGoto }) {
  const { config, updateRole } = useConfig();
  const openGate = usePresetGate(role);
  const ig = role.imageGen ?? {};
  const refs = ig.refs ?? [];
  const gallery = config.referenceImages ?? [];

  // 和 server/src/config.js:resolveImageEndpoint 同一套挑法，两处一起改
  const picked = (() => {
    for (const p of config.providers ?? []) {
      for (const m of p.models ?? []) {
        if (m.enabled && (m.categories ?? []).includes("image")) {
          return `${providerLabel(p)} · ${modelLabel(m)}`;
        }
      }
    }
    return "";
  })();

  const toggleRef = (name) =>
    updateRole(role.id, {
      imageGen: {
        ...ig,
        refs: refs.includes(name) ? refs.filter((n) => n !== name) : [...refs, name],
      },
    });

  return (
    <div className="grid grid-cols-1 gap-6">
      <label className="flex items-start justify-between gap-4">
        <span className="min-w-0">
          <span className="block text-ui text-ink">生成图片</span>
          <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
            允许这个角色写
            <code className="mx-1 bg-sunken px-1">[image:画面描述]</code>
            —— 系统会真的出一张图发过去。你自己也可以用
            <code className="mx-1 bg-sunken px-1">/image 描述</code>
            直接出图，那条不经过模型、也不进上下文。
          </span>
        </span>
        <Switch
          checked={Boolean(ig.enabled)}
          onChange={(v) => {
            updateRole(role.id, { imageGen: { ...ig, enabled: v } });
            if (v) openGate("image");
          }}
          label="启用生成图片"
        />
      </label>

      {ig.enabled && (
        <div className="grid grid-cols-1 gap-6">
          <p className="text-meta leading-relaxed text-ink-faint">
            {picked ? (
              <>
                现在用的生图模型是<strong className="text-ink-soft"> {picked} </strong>
                （全局一个，所有角色共用）。
              </>
            ) : (
              <strong className="text-warn">
                还没有可用的生图模型，这个开关现在不起作用。去「连接」里给某个开着的模型勾上
                「生图」分类，正面 / 负面提示词也在那儿填。
              </strong>
            )}
            <button
              type="button"
              className="mx-1 underline decoration-line underline-offset-2 hover:text-ink"
              onClick={() => onGoto?.("api")}
            >
              去连接面板
            </button>
            。提示词的措辞在
            <button
              type="button"
              className="mx-1 underline decoration-line underline-offset-2 hover:text-ink"
              onClick={() => onGoto?.("preset")}
            >
              预设 → 消息格式与功能
            </button>
            里改。开这个开关的时候会把那条子条目一并打开；要是回头在预设里又把它关了，这边开着也不起作用。
          </p>

          <label className="flex items-start justify-between gap-4 border-t border-line pt-5">
            <span className="min-w-0">
              <span className="block text-ui text-ink">图生图</span>
              <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                打开后，下面勾中的参考图会以清单的形式写进提示词，模型就能写
                <code className="mx-1 bg-sunken px-1">[image:描述][小猫]</code>
                基于那张图来生成。不勾任何一张的话，清单是空的，等于没开。
              </span>
            </span>
            <Switch
              checked={Boolean(ig.img2img)}
              onChange={(v) => updateRole(role.id, { imageGen: { ...ig, img2img: v } })}
              label="启用图生图"
            />
          </label>

          {ig.img2img && (
            <div className="grid grid-cols-1 gap-4">
              {gallery.length === 0 ? (
                <p className="text-meta leading-relaxed text-warn">
                  图库还是空的。去
                  <button
                    type="button"
                    className="mx-1 underline decoration-line underline-offset-2 hover:text-ink"
                    onClick={() => onGoto?.("gallery")}
                  >
                    图库 → 参考图
                  </button>
                  里新增几条，并把图片文件放进数据目录的 images/参考图 文件夹。
                </p>
              ) : (
                <>
                  <p className="text-meta leading-relaxed text-ink-faint">
                    勾中的会连同描述一起写进提示词 —— 描述是给模型看的，它靠这句话判断
                    什么时候该用哪张图。没勾的模型看不见，也用不了。
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {gallery.map((r) => {
                      const name = r.name?.trim();
                      const on = Boolean(name) && refs.includes(name);
                      return (
                        <button
                          key={r.id}
                          type="button"
                          disabled={!name}
                          onClick={() => name && toggleRef(name)}
                          title={r.description || undefined}
                          className={`rounded-full border px-3 py-1.5 text-meta transition-colors duration-150 ${
                            on
                              ? "border-ink bg-ink text-paper-invert"
                              : "border-line text-ink-soft hover:bg-sunken hover:text-ink"
                          } ${name ? "" : "cursor-not-allowed opacity-50"}`}
                        >
                          {name || "（还没起名）"}
                        </button>
                      );
                    })}
                  </div>
                  {/*
                    图库里改过名字之后，角色这边存的还是旧名字 —— 和世界书被删一样
                    不静默清理，标出来让用户自己点掉，否则模型会照着一个不存在的名字写。
                  */}
                  {refs
                    .filter((n) => !gallery.some((r) => r.name?.trim() === n))
                    .map((n) => (
                      <p key={n} className="text-meta leading-relaxed text-warn">
                        勾着的「{n}」在图库里找不到了（改过名或删掉了）。
                        <button
                          type="button"
                          className="mx-1 underline decoration-line underline-offset-2 hover:text-ink"
                          onClick={() => toggleRef(n)}
                        >
                          取消勾选
                        </button>
                      </p>
                    ))}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 硬盘上**装了图**的表情包标签有哪些。
 *
 * 标签不在 config 里，在 images/emojis/ 下面 —— 一个文件夹就是一个标签，
 * 所以这儿只能问后端。空文件夹要滤掉：注入提示词那边也是按「有图才算」过的
 * （listEmojiTags 只报 count > 0 的），这边不滤的话用户会对着一个根本发不出来
 * 的标签设黑名单。
 *
 * 进来拉一次就够 —— 建标签、传图都在图库那个面板里做，做完切回来自然会重拉。
 */
function useStockedEmojiTags() {
  const [state, setState] = useState({ tags: [], loading: true, error: "" });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await api("/api/emojis");
        const tags = (r.tags ?? []).filter((t) => t.count > 0).map((t) => t.tag);
        if (alive) setState({ tags, loading: false, error: "" });
      } catch (e) {
        // 拉不到别装作「一个标签都没有」：那句话会让用户跑去图库瞎找，
        // 其实是后端没起来
        if (alive) setState({ tags: [], loading: false, error: e.message || "读不到表情包文件夹" });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return state;
}

/**
 * 「发送表情包」那一段：开关 + 随机不重复几次 + 这个角色不许用哪些标签。
 *
 * 和图生图正好相反 —— 那边是白名单（勾了才能用），这边是**黑名单**：硬盘上有图的
 * 标签**默认全都注入**给模型，点掉哪个哪个才禁。因为标签是文件夹长出来的，往
 * images/emojis/ 里新建一个文件夹丢几张图，所有角色立刻就能用，不用挨个角色再勾一遍。
 *
 * 默认是**关**的 —— 一个新角色不会平白开始发表情包。
 */
function RoleStickerFields({ role, onGoto }) {
  const { updateRole } = useConfig();
  const openGate = usePresetGate(role);
  const ss = role.stickerSend ?? {};
  const blacklist = ss.blacklist ?? [];
  // 标签来自硬盘，不来自 config（原因见上面那个 hook）
  const { tags, loading, error } = useStockedEmojiTags();
  const allowed = tags.filter((t) => !blacklist.includes(t));
  // 禁着、但硬盘上现在没有（或者文件夹空了）的：不是错，只是眼下用不上。
  // 列出来免得用户以为这条禁令丢了
  const dormant = blacklist.filter((t) => !tags.includes(t));

  const toggleBan = (tag) =>
    updateRole(role.id, {
      stickerSend: {
        ...ss,
        blacklist: blacklist.includes(tag)
          ? blacklist.filter((t) => t !== tag)
          : [...blacklist, tag],
      },
    });

  return (
    <div className="grid grid-cols-1 gap-6">
      <label className="flex items-start justify-between gap-4">
        <span className="min-w-0">
          <span className="block text-ui text-ink">发送表情包</span>
          <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
            允许这个角色写
            <code className="mx-1 bg-sunken px-1">[send_emoji:紧张]</code>
            —— 系统会从
            <code className="mx-1 bg-sunken px-1">images/emojis/紧张/</code>
            里随机挑一张图发过去。标签清单就是那个文件夹下
            <strong className="text-ink-soft">装了图</strong>
            的子文件夹，
            <strong className="text-ink-soft">模型只认得清单里的词</strong>
            ，编不出来别的。
          </span>
        </span>
        <Switch
          checked={Boolean(ss.enabled)}
          onChange={(v) => {
            updateRole(role.id, { stickerSend: { ...ss, enabled: v } });
            if (v) openGate("sticker");
          }}
          label="启用发送表情包"
        />
      </label>

      {ss.enabled && (
        <div className="grid grid-cols-1 gap-4">
          <p className="text-meta leading-relaxed text-ink-faint">
            表情包本身放在数据目录的
            <code className="mx-1 bg-sunken px-1">images/emojis/</code>
            里，一个文件夹就是一个标签。建标签、传图都在
            <button
              type="button"
              className="mx-1 underline decoration-line underline-offset-2 hover:text-ink"
              onClick={() => onGoto?.("gallery")}
            >
              图库 → 表情包
            </button>
            里做，有图的标签
            <strong className="text-ink-soft">默认全都注入</strong>
            ，不用再勾一遍。提示词的措辞在
            <button
              type="button"
              className="mx-1 underline decoration-line underline-offset-2 hover:text-ink"
              onClick={() => onGoto?.("preset")}
            >
              预设 → 消息格式与功能
            </button>
            里改。开这个开关的时候会把那条子条目一并打开；要是回头在预设里又把它关了，这边开着也不起作用。
          </p>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <NumberField
              label="连着几次不挑到同一张"
              value={ss.noRepeat ?? 5}
              min={1}
              max={50}
              step={1}
              suffix="次"
              hint="刚发过的这几张不会再被抽到"
              onChange={(v) => updateRole(role.id, { stickerSend: { ...ss, noRepeat: v } })}
            />
          </div>
          <p className="text-meta leading-relaxed text-ink-faint">
            每个标签各记各的，互不干扰。文件夹里的图不够这个数时按实际张数让 ——
            比如只有 3 张，那就只避开最近 2 张，不会因为凑不满就一张都发不出来。
            设成 1 就是只避开上一张。
          </p>

          {loading ? (
            <p className="text-meta text-ink-faint">正在读表情包文件夹…</p>
          ) : error ? (
            <p className="text-meta leading-relaxed text-warn">
              读不到表情包文件夹：{error} —— 先看看后端起没起来。
            </p>
          ) : tags.length === 0 ? (
            <p className="text-meta leading-relaxed text-warn">
              <code className="mr-1 bg-sunken px-1">images/emojis/</code>
              下面还没有装了图的文件夹，清单是空的，等于没开 ——
              模型收不到任何可用标签，也就不会发。先去图库里建个标签、传几张图。
            </p>
          ) : (
            <>
              <p className="text-meta leading-relaxed text-ink-faint">
                下面这些是硬盘上有图的标签，
                <strong className="text-ink-soft">默认这个角色全都能用</strong>
                。点掉哪个，哪个就不会写进它的提示词 —— 它根本不知道有这么个标签，
                自然也不会发（{allowed.length}/{tags.length} 个可用）。
              </p>
              <div className="flex flex-wrap gap-2">
                {tags.map((tag) => {
                  const banned = blacklist.includes(tag);
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => toggleBan(tag)}
                      title={banned ? `${tag}：已禁用，点一下恢复` : `${tag}：能用，点一下禁掉`}
                      className={`rounded-full border px-3 py-1.5 text-meta transition-colors duration-150 ${
                        banned
                          ? "border-warn text-warn line-through"
                          : "border-ink bg-ink text-paper-invert"
                      }`}
                    >
                      {tag}
                    </button>
                  );
                })}
              </div>
              {allowed.length === 0 && (
                <p className="text-meta leading-relaxed text-warn">
                  全都禁掉了，这个角色一个标签也拿不到 —— 效果和把上面那个开关关掉一样。
                </p>
              )}
            </>
          )}

          {!loading && !error && dormant.length > 0 && (
            <p className="text-meta leading-relaxed text-ink-faint">
              另外还禁着 {dormant.map((t) => `「${t}」`).join("")}
              —— 这几个标签硬盘上现在没有（或者文件夹是空的），本来就没人用得上；
              哪天把图补回去，这条禁令还是算数的。
              <button
                type="button"
                className="mx-1 underline decoration-line underline-offset-2 hover:text-ink"
                onClick={() =>
                  updateRole(role.id, {
                    stickerSend: { ...ss, blacklist: blacklist.filter((t) => tags.includes(t)) },
                  })
                }
              >
                清掉这几条
              </button>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 「已读不回」那一段。
 *
 * 两个开关是**分开的**，因为这两件事可以各要一个：
 *   - 只想让气泡显示「已读」→ 开回执、不开已读不回
 *   - 不想暴露已读时间，但允许角色不回 → 反过来
 *
 * 回执那条要说清楚它是**会话级、不可逆**的：iMessage 只能整个 chat 标已读，
 * 没法只标某一条。这是隐私相关的行为改变，不能让用户点完才发现。
 */
function RoleLeaveOnReadFields({ role, onGoto }) {
  const { updateRole } = useConfig();
  const openGate = usePresetGate(role);
  const lor = role.leaveOnRead ?? {};

  return (
    <div className="grid grid-cols-1 gap-6">
      <label className="flex items-start justify-between gap-4">
        <span className="min-w-0">
          <span className="block text-ui text-ink">已读回执</span>
          <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
            收到消息、开始想怎么回的时候，把对方的气泡标成
            <strong className="text-ink-soft">「已读」</strong>
            （现在只显示「已送达」）。标的时机在打字指示器
            <strong className="text-ink-soft">之前</strong>
            —— 和真人「读完 → 开始打字 → 发出来」的顺序一致。
            <br />
            <strong className="text-warn">这是会话级的，也没法撤回：</strong>
            iMessage 只能把整个对话标成已读，不能只标某一条，所以这个对话里
            所有还没读的消息都会一起变成已读。本地 Mac 模式不支持，会跳过。
          </span>
        </span>
        <Switch
          checked={Boolean(lor.receipt)}
          onChange={(v) => updateRole(role.id, { leaveOnRead: { ...lor, receipt: v } })}
          label="启用已读回执"
        />
      </label>

      <label className="flex items-start justify-between gap-4">
        <span className="min-w-0">
          <span className="block text-ui text-ink">已读不回</span>
          <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
            允许这个角色在忙着、或者不想搭话的时候写
            <code className="mx-1 bg-sunken px-1">[leave_on_read]</code>
            —— 这一轮
            <strong className="text-ink-soft">什么消息都不会发出去</strong>
            ，对方只看到「已读」。这条路上会
            <strong className="text-ink-soft">无条件</strong>
            发一次已读回执（上面那个开关关着也发），否则就是纯失踪，
            和网络故障看不出区别。
          </span>
        </span>
        <Switch
          checked={Boolean(lor.enabled)}
          onChange={(v) => {
            updateRole(role.id, { leaveOnRead: { ...lor, enabled: v } });
            if (v) openGate("leaveOnRead");
          }}
          label="启用已读不回"
        />
      </label>

      {lor.enabled && (
        <p className="text-meta leading-relaxed text-ink-faint">
          模型要是在指令后面还写了话（
          <code className="mx-1 bg-sunken px-1">[leave_on_read]别烦我</code>
          ），那句话会被
          <strong className="text-ink-soft">丢掉</strong>
          —— 已读不回的意思就是没有回应。上下文里也只记指令本身，不记那句话，
          免得下一轮模型以为自己说过。
          <br />
          提示词的措辞在
          <button
            type="button"
            className="mx-1 underline decoration-line underline-offset-2 hover:text-ink"
            onClick={() => onGoto?.("preset")}
          >
            预设 → 消息格式与功能
          </button>
          里改。开这个开关的时候会把那条子条目一并打开；要是回头在预设里又把它关了，这边开着也不起作用。
        </p>
      )}
    </div>
  );
}

/**
 * 「消息撤回」那一段：角色自己撤回，以及对方撤回时模型看不看得见。
 *
 * 两个方向是分开的开关，互不影响：
 *  - enabled 管**出站** —— 允许模型写 [undosend:N] 把刚发出去的那条收回来；
 *  - seeUser 管**入站** —— 对方撤回时要不要告诉模型，默认关。
 *
 * 入站那半现在还等着 SDK：@spectrum-ts/imessage 压根不往外推「对方撤回了」
 * 这个事件，所以两个数字调了也暂时没东西喂给它们。这事得在界面上说清楚，
 * 不然用户会以为是自己没配对。
 */
function RoleUndoSendFields({ role, onGoto }) {
  const { updateRole } = useConfig();
  const openGate = usePresetGate(role);
  const us = role.undoSend ?? {};
  const patch = (next) => updateRole(role.id, { undoSend: { ...us, ...next } });

  return (
    <div className="grid grid-cols-1 gap-6">
      <label className="flex items-start justify-between gap-4">
        <span className="min-w-0">
          <span className="block text-ui text-ink">消息撤回</span>
          <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
            允许这个角色在说漏嘴之后写
            <code className="mx-1 bg-sunken px-1">[undosend:1]</code>
            —— 标记前面那句话会
            <strong className="text-ink-soft">先真的发出去</strong>
            ，停不到一秒再从对方手机上撤回，对方看到的是
            「一条消息已撤回」。撤完可以接着写掩饰的话。
            <br />
            只能撤自己刚发的，苹果那边的窗口是
            <strong className="text-ink-soft">两分钟</strong>
            ，超时会撤不动（日志里会说一声，消息留着不动）。
            本地 Mac 模式不支持撤回，会跳过。
          </span>
        </span>
        <Switch
          checked={Boolean(us.enabled)}
          onChange={(v) => {
            patch({ enabled: v });
            if (v) openGate("undoSend");
          }}
          label="启用消息撤回"
        />
      </label>

      {us.enabled && (
        <p className="text-meta leading-relaxed text-ink-faint">
          提示词的措辞在
          <button
            type="button"
            className="mx-1 underline decoration-line underline-offset-2 hover:text-ink"
            onClick={() => onGoto?.("preset")}
          >
            预设 → 消息格式与功能
          </button>
          里改。开这个开关的时候会把那条子条目一并打开；要是回头在预设里又把它关了，这边开着也不起作用。
        </p>
      )}

      <label className="flex items-start justify-between gap-4">
        <span className="min-w-0">
          <span className="block text-ui text-ink">撤回消息是否让 LLM 看见</span>
          <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
            管的是<strong className="text-ink-soft">对方</strong>
            撤回的时候。关着（默认）就当没发生过，模型什么都不知道；开了会收到一句
            <code className="mx-1 bg-sunken px-1">[撤回了一条消息]</code>
            ，并按下面的概率决定要不要连原文一起给它看。
            <br />
            <strong className="text-warn">现在还收不到这个事件：</strong>
            Photon 的 SDK 暂时不把「对方撤回了」推给我们，本地 Mac 模式也读不到已撤回的记录。
            这几项是先配好放着的，等 SDK 支持了不用再改一遍。
          </span>
        </span>
        <Switch
          checked={Boolean(us.seeUser)}
          onChange={(v) => patch({ seeUser: v })}
          label="让 LLM 看见对方的撤回"
        />
      </label>

      {us.seeUser && (
        <div className="grid grid-cols-1 gap-3 border-l-2 border-line pl-4">
          <NumberField
            label="N 秒内撤回的消息不会被看到"
            value={us.graceSeconds ?? 3}
            min={0}
            max={600}
            step={1}
            onChange={(v) => patch({ graceSeconds: v })}
            hint="打错字、发错人都是这几秒里撤的，这种既不给模型看，也不触发一轮回复"
            suffix="秒"
          />
          <NumberField
            label="撤回消息被看到触发 LLM 概率"
            value={us.chance ?? 50}
            min={0}
            max={100}
            step={1}
            onChange={(v) => patch({ chance: v })}
            hint="掷中了模型会连撤回前的原文一起看到，没中就只知道「撤了一条」"
            suffix="%"
          />
          <p className="text-meta leading-relaxed text-ink-faint">
            秒数填 <strong className="text-ink-soft">0</strong> = 撤得再快也算数，每条都告诉模型。
            概率填 <strong className="text-ink-soft">0</strong> = 永远只知道「撤了一条」，看不到原文。
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * 「Instagram」那一段：八项，都是用户逐条点过的。
 *
 * 这一栏和「角色主动消息」是同一类东西 —— **没人操作它也会自己打模型**，
 * 所以两道闸分开：`enabled` 决定这个角色在不在 IG 上（关着就完全不参与，
 * 连主页都不建），`autoPublish` 才是「自己发帖」。只开第一道的话它只会
 * 对已经存在的帖子点赞评论，不会自己产内容。
 *
 * 内容本身（帖子、快拍、主页资料）不在配置里 —— 那些写得太频繁，而
 * PUT /api/config 会重启所有 iMessage 桥。它们在 data/instagram/ 下，
 * 走 /api/ig/* 那套接口，见 server/src/igstore.js 文件头。
 */
function RoleInstagramFields({ role, onGoto }) {
  const { config, updateRole } = useConfig();
  const openGate = usePresetGate(role);
  const ig = role.instagram ?? {};
  const win = ig.replyWindow ?? {};
  const peers = ig.peers ?? [];

  // updateRole 是浅合并，每次都得把整个 instagram 摊开重写
  const patch = (part) => updateRole(role.id, { instagram: { ...ig, ...part } });
  const patchWin = (part) => patch({ replyWindow: { ...win, ...part } });

  // 能互动的对象只能是**别的也开了 IG 的角色** —— 没开的那个连主页都没有
  const others = (config.roles ?? []).filter((r) => r.id !== role.id && r.instagram?.enabled);
  const dead = peers.filter((id) => !others.some((r) => r.id === id));

  const togglePeer = (id) =>
    patch({ peers: peers.includes(id) ? peers.filter((x) => x !== id) : [...peers, id] });

  return (
    <div className="grid grid-cols-1 gap-6">
      <label className="flex items-start justify-between gap-4">
        <span className="min-w-0">
          <span className="block text-ui text-ink">启用 Instagram</span>
          <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
            这个角色在「Instagram」面板里
            <strong className="text-ink-soft">有自己的主页</strong>
            ，能给你的帖子点赞、评论，也能被你替它发帖。关着 = 完全不参与，
            侧栏里也不出现。
          </span>
        </span>
        <Switch
          checked={Boolean(ig.enabled)}
          onChange={(v) => {
            patch({ enabled: v });
            if (v) openGate("instagram");
          }}
          label="启用 Instagram"
        />
      </label>

      {ig.enabled && (
        <>
          <label className="flex items-start justify-between gap-4 border-l-2 border-line pl-4">
            <span className="min-w-0">
              <span className="block text-ui text-ink">主动发布帖子 / 快拍</span>
              <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                在
                <strong className="text-ink-soft">主动消息那一轮</strong>
                里顺手决定要不要发一条。跟着上面「角色主动消息」走 ——
                那个关着的话这个也不会动。
                <br />
                关着的时候它照样会点赞和评论，只是
                <strong className="text-ink-soft">不自己产内容</strong>
                ；要替它发就去「Instagram → 主页 → 它 → 替它发一条」。
              </span>
            </span>
            <Switch
              checked={Boolean(ig.autoPublish)}
              onChange={(v) => patch({ autoPublish: v })}
              label="主动发布帖子或快拍"
            />
          </label>

          <div className="grid grid-cols-1 gap-3 border-l-2 border-line pl-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <NumberField
                label="最快多久来互动"
                value={win.minMinutes ?? 30}
                min={1}
                max={10080}
                step={1}
                onChange={(v) => patchWin({ minMinutes: v })}
                suffix="分钟"
              />
              <NumberField
                label="最慢多久来互动"
                value={win.maxMinutes ?? 120}
                min={1}
                max={10080}
                step={1}
                onChange={(v) => patchWin({ maxMinutes: v })}
                suffix="分钟"
              />
            </div>
            <p className="text-meta leading-relaxed text-ink-faint">
              你发一条之后，它
              <strong className="text-ink-soft">不会立刻</strong>
              来点赞评论 —— 在这两个数之间掷一个点，到时候再动。两头填反了不算错，
              保存时按小的当下限。这个等待
              <strong className="text-ink-soft">跨重启有效</strong>
              （排在 data/instagram/queue.json 里），和主动消息那个只在内存里的计时不一样。
            </p>
          </div>

          <div className="grid grid-cols-1 gap-6 border-l-2 border-line pl-4">
            <NumberField
              label="点赞概率"
              value={ig.likeChance ?? 45}
              min={0}
              max={100}
              step={1}
              onChange={(v) => patch({ likeChance: v })}
              hint="到点之后先掷这个决定要不要点赞"
              suffix="%"
            />
            <NumberField
              label="回复你评论的概率"
              value={ig.replyChance ?? 60}
              min={0}
              max={100}
              step={1}
              onChange={(v) => patch({ replyChance: v })}
              hint="你在它帖子下面留言之后，它要不要回你"
              suffix="%"
            />
            <p className="text-meta leading-relaxed text-ink-faint">
              两个都填 <strong className="text-ink-soft">0</strong> = 它有主页、能被你替它发帖，
              但永远不会主动来互动。
            </p>
          </div>

          <Field
            label="可以和哪些角色互动"
            hint="一个都不勾 = 只和你互动，不和别的角色互相点赞评论"
          >
            <div className="grid grid-cols-1 gap-3">
              {others.length === 0 ? (
                <p className="text-meta leading-relaxed text-ink-faint">
                  没有别的角色开着 Instagram。
                  <button
                    type="button"
                    onClick={() => onGoto?.("role")}
                    className="ml-1 text-ink hover:underline"
                  >
                    去另一个角色这一栏打开开关
                  </button>
                </p>
              ) : (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {others.map((r) => {
                    const on = peers.includes(r.id);
                    return (
                      <label
                        key={r.id}
                        className={`flex cursor-pointer items-start gap-2.5 border px-3 py-2.5 transition-colors duration-150 ${
                          on ? "border-ink bg-sunken" : "border-line bg-paper hover:bg-sunken"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => togglePeer(r.id)}
                          className="mt-0.5 shrink-0 accent-ink"
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-ui text-ink">{roleLabel(r)}</span>
                          <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                            {r.instagram?.peers?.includes(role.id)
                              ? "对方也勾了这一边"
                              : "对方没勾这一边"}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
              <p className="text-meta leading-relaxed text-ink-faint">
                这是<strong className="text-ink-soft">单向</strong>的：勾上表示「这个角色会去
                动那个角色的帖子」。想互相动，两边都得勾。
              </p>
              {dead.length > 0 && (
                <p className="text-meta leading-relaxed text-warn">
                  还挂着 {dead.length} 个已经关掉 Instagram 或被删掉的角色，这些勾不起作用。
                </p>
              )}
            </div>
          </Field>

          <div className="grid grid-cols-1 gap-6 border-l-2 border-line pl-4">
            <NumberField
              label="角色之间一条线最多来回几次"
              value={ig.maxChain ?? 2}
              min={0}
              max={10}
              step={1}
              onChange={(v) => patch({ maxChain: v })}
              hint="算的是同一条评论线里的往复次数，首条评论不计。填 0 = 只能留一条评论，不接话"
              suffix="次"
            />
            <p className="text-meta leading-relaxed text-ink-faint">
              这个数按
              <strong className="text-ink-soft">帖主的设置</strong>
              算 —— 在谁的地盘上就守谁的规矩。没有它两个角色会在一条评论线里一直聊下去。
            </p>
          </div>

          <label className="flex items-start justify-between gap-4">
            <span className="min-w-0">
              <span className="block text-ui text-ink">角色之间的互动写进上下文</span>
              <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                别的角色在它帖子下面说了什么，下一轮对话时它
                <strong className="text-ink-soft">知道</strong>
                。这只是让模型看见，
                <strong className="text-ink-soft">不会因此给你发消息</strong>
                。关掉的话它俩在 IG 上的来往对聊天那边完全透明。
              </span>
            </span>
            <Switch
              checked={ig.recordPeer !== false}
              onChange={(v) => patch({ recordPeer: v })}
              label="角色之间的互动写进上下文"
            />
          </label>

          <label className="flex items-start justify-between gap-4">
            <span className="min-w-0">
              <span className="block text-ui text-ink">同步到真实 Instagram</span>
              <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                它发的帖子和快拍会
                <strong className="text-ink-soft">真的发到</strong>
                一个 Instagram 账号上。这里的本地主页
                <strong className="text-ink-soft">照旧存在</strong>
                ，真 IG 只是多一个橱窗 —— 那边挂了、限流了、token 过期了，本地一点都不受影响。
                <br />
                真发出去的帖子
                <strong className="text-warn">删不掉</strong>
                （Meta 没有删除接口），只能去手机上手动删。
                <button
                  type="button"
                  onClick={() => onGoto?.("instagram")}
                  className="ml-1 text-ink hover:underline"
                >
                  去绑账号和配图床
                </button>
              </span>
            </span>
            <Switch
              checked={Boolean(ig.syncReal)}
              onChange={(v) => patch({ syncReal: v })}
              label="同步到真实 Instagram"
            />
          </label>

          <p className="text-meta leading-relaxed text-ink-faint">
            帖子和快拍的内容格式（<code className="text-ink-soft">[post:文案]</code>、
            <code className="text-ink-soft">[story:文案]</code>、
            <code className="text-ink-soft">[image:描述]</code>、
            <code className="text-ink-soft">[comment:内容]</code>
            ）写在预设里，见
            <button
              type="button"
              onClick={() => onGoto?.("preset")}
              className="mx-1 text-ink hover:underline"
            >
              预设 → 消息格式与功能
            </button>
            。
          </p>
        </>
      )}
    </div>
  );
}

/**
 * 「分享链接卡片」那一段：一个开关，外加点歌用哪家曲库。
 *
 * 模型写 `[card:https://…]`，桥接那边发成一张带标题和封面的链接卡片
 * （见服务端 imessage.js:sendCardPart）。发什么链接是模型当场决定的，
 * 没有凭据也没有额度。
 *
 * `[music:歌手-歌名]` 共用这一个开关：对用户来说这俩是同一件事（往对话里丢
 * 一张能点开的卡片）。区别只在网址哪儿来 —— 卡片是模型自己写的，点歌是服务端
 * 现查的（见服务端 music.js）。下拉选的是先查哪家，那家没有会自动落到另一家。
 *
 * 默认关的理由和「发语音」「生图」一样：一开，模型就可能把自己编出来的
 * 网址发到对方手机上。链接卡片点一下就会打开，编错了比说错话难收场。
 *
 * 反过来，**收**卡片（对方分享网易云音乐那种）不在这里 —— 那个是白给的，
 * 见服务端 card.js 的文件头。
 */
function RoleCardSendFields({ role }) {
  const { updateRole } = useConfig();
  const openGate = usePresetGate(role);
  const cs = role.cardSend ?? {};

  return (
    <div className="grid grid-cols-1 gap-6">
      <label className="flex items-start justify-between gap-4">
        <span className="min-w-0">
          <span className="block text-ui text-ink">分享链接卡片</span>
          <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
            模型写
            <code className="mx-1 bg-sunken px-1">[card:https://…]</code>
            或者
            <code className="mx-1 bg-sunken px-1">[music:周杰伦-晴天]</code>
            时发成一张带标题和封面的链接卡片（就像对方手里的网易云音乐那种）。
            发出去的是 iMessage 的链接预览卡片 —— 链接是真的，标题和封面是对方手机自己抓的。
            <br />
            预设里的那条子条目也要开着才会在提示词里教模型怎么写。
          </span>
        </span>
        <Switch
          checked={Boolean(cs.enabled)}
          onChange={(v) => {
            updateRole(role.id, { cardSend: { ...cs, enabled: v } });
            if (v) openGate("card");
          }}
          label="启用分享链接卡片"
        />
      </label>

      <Field
        label="点歌偏好哪家"
        hint="模型只写歌手和歌名，链接由这边现查。两家都会查，这里选的是两边结果一样像的时候听谁的"
      >
        <select
          className={inputCls}
          value={cs.musicSource === "apple" ? "apple" : "netease"}
          onChange={(e) => updateRole(role.id, { cardSend: { ...cs, musicSource: e.target.value } })}
        >
          {/* 和服务端 music.js:MUSIC_SOURCES 对齐，加一家时两处一起改 */}
          <option value="netease">网易云音乐（华语最全，但用的是非官方接口，可能失效）</option>
          <option value="apple">Apple Music（苹果官方接口，补网易云缺的版权，但返回繁体）</option>
        </select>
      </Field>
    </div>
  );
}

/**
 * 分享位置：只有一个开关。
 *
 * **单独一个开关，不跟「分享链接卡片」合并。** 走的确实是同一条发送路径
 * （都是 richlink），但两件事的性质相反：卡片那条提示词写着「网址必须是你
 * 确实知道的真实链接，编不出来就别发」，位置这条恰恰**允许编** —— 角色说自己
 * 在哪儿本来就是虚构的。合成一个开关就等于让用户没法只要其中一个。
 *
 * 默认关：位置是私事，哪怕地名是编的，也该由用户自己点开。
 *
 * 收**用户**的位置共享不在这里，那个是白给的（服务端 card.js 会认出来，
 * 变成一句「{{user}}把自己的位置共享给你了」）。
 */
function RoleLocationSendFields({ role }) {
  const { updateRole } = useConfig();
  const openGate = usePresetGate(role);
  const ls = role.locationSend ?? {};

  return (
    <div className="grid grid-cols-1 gap-6">
      <label className="flex items-start justify-between gap-4">
        <span className="min-w-0">
          <span className="block text-ui text-ink">分享位置</span>
          <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
            模型写
            <code className="mx-1 bg-sunken px-1">[location:南宁万象城:22.8170,108.3665]</code>
            时发一张苹果地图卡片过去，对方点一下直接打开地图。地名可以是编的 ——
            这就是这个功能的用途，让角色能说自己现在在哪儿。
            <br />
            提示词里教的是尽量连坐标一起写：带坐标的卡片上是一张图钉钉在那个点上的真地图缩略图，
            只写地名的话链接照样能点开，但缩略图是一张对不上的通用地图（苹果那边给的兜底图）。
            <br />
            iMessage 没有「原生位置气泡」那种消息类型，所以发出去的是链接卡片，不是苹果自带的地图气泡。
            <br />
            预设里的那条子条目也要开着才会在提示词里教模型怎么写。
          </span>
        </span>
        <Switch
          checked={Boolean(ls.enabled)}
          onChange={(v) => {
            updateRole(role.id, { locationSend: { ...ls, enabled: v } });
            if (v) openGate("location");
          }}
          label="启用分享位置"
        />
      </label>
    </div>
  );
}

/**
 * 转账卡片：开关 + 卡片上那行小字 + 收款要不要靠贴表情。
 *
 * 发出去的是 iMessage 的 miniApp 卡片（苹果那套 `MSMessageTemplateLayout`），
 * 不是生成的图片 —— 金额、备注、「待收款」三行字是真的文字槽，排版是苹果钉死的。
 *
 * 两件事在界面上必须说清楚，因为都反直觉：
 *
 *  - **不是真的钱**。没有任何账户被动过，就是一张给人看的凭证。卡片是骑
 *    Spectrum 那个官方扩展发的（见服务端 card.js:TRANSFER_TEAM_ID），所以对方
 *    点下去可能真的跳去 Spectrum 或者 App Store —— 那跟这笔「钱」没关系。
 *  - **收款是贴表情**。苹果不给第三方在气泡里放按钮，「用户点了卡片」这个动作
 *    也传不回来。所以对方只能长按那张卡片贴一个 emoji（贴什么都算），
 *    我们收到之后把**同一条气泡**原地改成「已收款」。
 *
 * 只有云端模式能发（本地 Mac 模式没有那两条 RPC），那边会退化成发一句文字。
 */
function RoleTransferFields({ role }) {
  const { updateRole } = useConfig();
  const openGate = usePresetGate(role);
  const tr = role.transfer ?? {};

  return (
    <div className="grid grid-cols-1 gap-6">
      <label className="flex items-start justify-between gap-4">
        <span className="min-w-0">
          <span className="block text-ui text-ink">转账卡片</span>
          <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
            模型写
            <code className="mx-1 bg-sunken px-1">[transfer:4000:零花钱]</code>
            时发一张转账卡片过去：左上角是金额、下面是备注、右上角写着「待收款」。
            发的是 iMessage 的卡片气泡，不是生成的图片。
            <br />
            这<b>不是真的钱</b>，没有任何账户被动过，就是一张给人看的凭证。对方点那张
            卡片可能会跳去发它的那个 iMessage 扩展（Spectrum）或者 App Store，
            跟这笔「钱」没关系。
            <br />
            只有云端模式能发。本地 Mac 模式没有这条通道，会退化成发一句
            <code className="mx-1 bg-sunken px-1">转账 ￥4,000.00 零花钱</code>
            的文字。
            <br />
            预设里的那条子条目也要开着才会在提示词里教模型怎么写。
          </span>
        </span>
        <Switch
          checked={Boolean(tr.enabled)}
          onChange={(v) => {
            updateRole(role.id, { transfer: { ...tr, enabled: v } });
            if (v) openGate("transfer");
          }}
          label="启用转账卡片"
        />
      </label>

      <Field
        label="货币符号"
        hint="金额前面那个符号，留空就是 ￥。一般填一个字符（￥ $ € £），「HK$」这种也行。写「金币」「点券」也随你"
      >
        <input
          className={inputCls}
          value={tr.currency ?? ""}
          maxLength={4}
          placeholder="￥"
          onChange={(e) => updateRole(role.id, { transfer: { ...tr, currency: e.target.value } })}
        />
      </Field>

      <Field
        label="卡片上那行小字"
        hint="卡片底部显示的名字，随便填 —— 写「转账」也行，写某家银行的名字也行。留空就不显示那行（装了 Spectrum 的人那儿可能显示成它的名字，那是系统画的，我们管不着）"
      >
        <input
          className={inputCls}
          value={tr.appName ?? ""}
          maxLength={40}
          placeholder="留空就不显示"
          onChange={(e) => updateRole(role.id, { transfer: { ...tr, appName: e.target.value } })}
        />
      </Field>

      <label className="flex items-start justify-between gap-4">
        <span className="min-w-0">
          <span className="block text-ui text-ink">贴个表情就算收款</span>
          <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
            你长按那张卡片贴一个 emoji（贴什么都算），卡片右上角就地从「待收款」变成「已收款」
            —— 变的是<b>同一条气泡</b>，不会新来一条消息。角色那边会收到一句系统提示，
            等你下次说话时一起送进去。
            <br />
            苹果不让第三方在气泡里放按钮，「点了卡片」这个动作也传不回来，所以贴表情是唯一能收款的动作。
            <br />
            关掉的话卡片会一直停在「待收款」。
          </span>
        </span>
        <Switch
          checked={tr.confirmOnReact !== false}
          onChange={(v) => updateRole(role.id, { transfer: { ...tr, confirmOnReact: v } })}
          label="贴表情算收款"
        />
      </label>
    </div>
  );
}

/**
 * 内置的 emoji 面板，按情绪分组。
 *
 * 苹果的 tapback 从 iOS 18 起可以贴**任意** emoji —— 全塞进提示词等于白烧几千
 * token，所以这儿只摆一份挑得动的常用清单，勾中的才进提示词。想用清单外的，
 * 下面还有个手动补充框。
 *
 * 第一组那六个是**原生 tapback**（服务端 SDK 里那张 EMOJI_TO_TAPBACK 表），
 * 任何系统版本的 iPhone 都认；其余走 iOS 18 的任意 emoji 回应，对方系统太旧
 * 可能看不到。所以它们排最前。
 */
const REACT_EMOJI_GROUPS = [
  { name: "原生 Tapback", emojis: ["❤️", "👍", "👎", "😂", "‼️", "❓"] },
  { name: "喜爱", emojis: ["🥰", "😘", "😍", "🤍", "💕", "💗", "💘", "❤️‍🔥", "🫶"] },
  { name: "开心", emojis: ["🤣", "😄", "😆", "😁", "🙂", "😊", "☺️", "😇", "🥹"] },
  { name: "调皮", emojis: ["😜", "😝", "😏", "😈", "🤪", "🤭", "🙃", "😎", "🤓", "🫡"] },
  { name: "惊讶", emojis: ["😮", "😲", "🤯", "😱", "👀", "🤔", "🧐", "😳"] },
  { name: "难过", emojis: ["😢", "😭", "🥺", "😔", "😞", "💔", "😩", "😫", "🥲", "😿"] },
  { name: "生气", emojis: ["😠", "😡", "🤬", "😤", "👿", "🙄", "😑", "😒"] },
  { name: "赞同", emojis: ["👌", "🙏", "💪", "🤝", "✅", "🎉", "🔥", "💯", "✨", "🥳"] },
  { name: "杂项", emojis: ["🍻", "🎂", "🌙", "☀️", "🐱", "🐶", "🎵", "💤", "🫠"] },
];

/** 面板里已经有的所有 emoji，用来判断手动补充的那些该不该单列一行。 */
const REACT_EMOJI_BUILTIN = REACT_EMOJI_GROUPS.flatMap((g) => g.emojis);

/**
 * 「消息回应」那一段：开关 + 这个角色能贴哪些 emoji。
 *
 * 和表情包那边正好相反 —— 那边是黑名单（硬盘上有图的默认全给），这边是
 * **白名单**：勾了才给。理由是 emoji 的全集是苹果定的、有几千个，「默认全给」
 * 根本没法实现；而且清单直接进提示词，勾几个就是几个 token。
 *
 * 一个都不勾 = 这条子条目**整条不注入**（服务端 prompt.js 里直接 continue），
 * 所以「开开关但一个都不勾」是个有用的组合：模型不会贴，但对方贴了什么
 * 照样告诉模型（入站那一路只看这个开关）。下面写明了。
 *
 * 默认关，理由和别的发送类功能一样。
 */
function RoleReactFields({ role, onGoto }) {
  const { updateRole } = useConfig();
  const openGate = usePresetGate(role);
  const rs = role.reactSend ?? {};
  const picked = rs.emojis ?? [];
  const [draft, setDraft] = useState("");
  // 手动补充进来的：面板里没有，单列一行，不然用户添完找不着自己加的那个
  const extra = picked.filter((e) => !REACT_EMOJI_BUILTIN.includes(e));

  const setEmojis = (next) =>
    updateRole(role.id, { reactSend: { ...rs, emojis: [...new Set(next)] } });
  const toggle = (emoji) =>
    setEmojis(picked.includes(emoji) ? picked.filter((e) => e !== emoji) : [...picked, emoji]);

  // 空格、逗号、顿号分隔，一次能粘一串进来
  const addDraft = () => {
    const add = draft.split(/[\s,，、]+/).filter(Boolean);
    if (add.length) setEmojis([...picked, ...add]);
    setDraft("");
  };

  return (
    <div className="grid grid-cols-1 gap-6">
      <label className="flex items-start justify-between gap-4">
        <span className="min-w-0">
          <span className="block text-ui text-ink">消息回应</span>
          <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
            就是长按气泡贴的那种 tapback。模型写
            <code className="mx-1 bg-sunken px-1">[react:😂]</code>
            时给对方最后一条贴上去，
            <code className="mx-1 bg-sunken px-1">[react:❤️:2]</code>
            是倒数第 2 条。
            <strong className="text-ink-soft">对方给它贴了什么也会告诉模型</strong>
            ，在下一条消息前面带一句「{"{{user}}"}给某句话贴上了 😂 的贴纸」。
          </span>
        </span>
        <Switch
          checked={Boolean(rs.enabled)}
          onChange={(v) => {
            updateRole(role.id, { reactSend: { ...rs, enabled: v } });
            if (v) openGate("react");
          }}
          label="启用消息回应"
        />
      </label>

      {rs.enabled && (
        <div className="grid grid-cols-1 gap-4">
          <p className="text-meta leading-relaxed text-ink-faint">
            苹果那边能贴的 emoji 有几千个，全写进提示词纯属烧 token ——
            所以这里是
            <strong className="text-ink-soft">勾了才给</strong>
            ，勾中的那几个会原样列进提示词，模型只认得这几个。
            一个都不勾的话这条子条目
            <strong className="text-ink-soft">整条不注入</strong>
            ，模型不会贴（但对方贴的照样告诉它 —— 想「只看不发」就这么配）。
            提示词的措辞在
            <button
              type="button"
              className="mx-1 underline decoration-line underline-offset-2 hover:text-ink"
              onClick={() => onGoto?.("preset")}
            >
              预设 → 消息格式与功能
            </button>
            里改。
          </p>

          {REACT_EMOJI_GROUPS.map((group) => (
            <div key={group.name} className="grid grid-cols-1 gap-2">
              <p className="text-meta text-ink-faint">
                {group.name}
                {group.name === "原生 Tapback" && (
                  <span className="ml-1">
                    —— 这六个是苹果原生的六种回应，什么版本的 iPhone 都认；
                    下面那些走 iOS 18 起的任意 emoji 回应，对方系统太旧可能看不到
                  </span>
                )}
              </p>
              <div className="flex flex-wrap gap-2">
                {group.emojis.map((emoji) => {
                  const on = picked.includes(emoji);
                  return (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => toggle(emoji)}
                      title={on ? `${emoji}：能用，点一下去掉` : `${emoji}：点一下加进清单`}
                      className={`rounded-full border px-3 py-1.5 text-ui transition-colors duration-150 ${
                        on ? "border-ink bg-ink text-paper-invert" : "border-line text-ink-soft"
                      }`}
                    >
                      {emoji}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          {extra.length > 0 && (
            <div className="grid grid-cols-1 gap-2">
              <p className="text-meta text-ink-faint">自己加的</p>
              <div className="flex flex-wrap gap-2">
                {extra.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => toggle(emoji)}
                    title={`${emoji}：点一下去掉`}
                    className="rounded-full border border-ink bg-ink px-3 py-1.5 text-ui text-paper-invert"
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>
          )}

          <Field
            label="手动补充"
            hint="面板里没有的直接粘进来，空格或逗号隔开，回车加进清单。已经在清单里的不会重复"
          >
            <div className="flex gap-2">
              <input
                className={inputCls}
                value={draft}
                placeholder="🫢 🥴 🤌"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  addDraft();
                }}
              />
              <Button variant="outline" onClick={addDraft} disabled={!draft.trim()}>
                添加
              </Button>
            </div>
          </Field>

          <p className="text-meta leading-relaxed text-ink-faint">
            已经勾了 {picked.length} 个。
            {picked.length > 0 && (
              <button
                type="button"
                className="ml-1 underline decoration-line underline-offset-2 hover:text-ink"
                onClick={() => setEmojis([])}
              >
                全清掉
              </button>
            )}
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * 13 个消息特效，分屏幕和气泡两栏。
 *
 * key 和中文名要和服务端 media.js 的 MESSAGE_EFFECT_IDS / EFFECT_LABELS /
 * SCREEN_EFFECT_KEYS 对齐 —— 前端 import 不到服务端代码，所以两处各留一份，
 * 加特效的时候一起改。界面上写中英对照是因为**提示词里给模型的是英文 key**，
 * 用户在这儿见过一次，去日志里对标记时才对得上。
 */
const EFFECT_GROUPS = [
  {
    name: "屏幕特效",
    hint: "会占满对方一整块屏幕，气氛到了才用",
    items: [
      ["balloons", "气球"],
      ["celebration", "生日"],
      ["confetti", "彩纸"],
      ["echo", "回声"],
      ["fireworks", "烟花"],
      ["heart", "爱心"],
      ["lasers", "镭射"],
      ["sparkles", "闪光"],
      ["spotlight", "聚光灯"],
    ],
  },
  {
    name: "气泡特效",
    hint: "只是那条气泡自己动一下，随意些无妨。「隐形墨水」要对方擦一下才看得见",
    items: [
      ["gentle", "轻轻地"],
      ["loud", "大声"],
      ["slam", "用力"],
      ["invisible", "隐形墨水"],
    ],
  },
];

/**
 * 「消息特效」那一段：开关 + 这个角色能用哪几个特效。
 *
 * 白名单，理由和上面的 emoji 一样（勾了才给、一个不勾就整条不注入）。
 * 这儿只管**发** —— 对方用了什么特效、给哪几个字加了 shake 这类逐词效果，
 * 是白给的，不受这个开关约束（服务端入站那一路自己认，见 imessage.js:effectHintOf）。
 *
 * 模型不能主动用逐词效果（big/small/shake/nod/… 那八个）：那要手搓
 * formatting 数组走裸 gRPC，SDK 没给口子。所以这栏只有屏幕和气泡两类。
 */
function RoleEffectFields({ role, onGoto }) {
  const { updateRole } = useConfig();
  const openGate = usePresetGate(role);
  const es = role.effectSend ?? {};
  const picked = es.effects ?? [];

  const toggle = (key) =>
    updateRole(role.id, {
      effectSend: {
        ...es,
        effects: picked.includes(key) ? picked.filter((k) => k !== key) : [...picked, key],
      },
    });

  return (
    <div className="grid grid-cols-1 gap-6">
      <label className="flex items-start justify-between gap-4">
        <span className="min-w-0">
          <span className="block text-ui text-ink">消息特效</span>
          <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
            模型在一条气泡的开头写
            <code className="mx-1 bg-sunken px-1">[effect:heart]我爱你</code>
            ，那条气泡就带着爱心特效弹到对方屏幕上。
            <br />
            <strong className="text-ink-soft">对方用了什么特效一直都会告诉模型</strong>
            ，不受这个开关管 —— 包括给某几个字加的抖动、点头那类逐词效果。
          </span>
        </span>
        <Switch
          checked={Boolean(es.enabled)}
          onChange={(v) => {
            updateRole(role.id, { effectSend: { ...es, enabled: v } });
            if (v) openGate("effect");
          }}
          label="启用消息特效"
        />
      </label>

      {es.enabled && (
        <div className="grid grid-cols-1 gap-4">
          <p className="text-meta leading-relaxed text-ink-faint">
            和 emoji 那栏一样是
            <strong className="text-ink-soft">勾了才给</strong>
            ，一个都不勾这条子条目就整条不注入。括号里的英文是模型真正要写进标记里的名字。
            提示词的措辞在
            <button
              type="button"
              className="mx-1 underline decoration-line underline-offset-2 hover:text-ink"
              onClick={() => onGoto?.("preset")}
            >
              预设 → 消息格式与功能
            </button>
            里改。
          </p>

          {EFFECT_GROUPS.map((group) => (
            <div key={group.name} className="grid grid-cols-1 gap-2">
              <p className="text-meta text-ink-faint">
                {group.name} —— {group.hint}
              </p>
              <div className="flex flex-wrap gap-2">
                {group.items.map(([key, name]) => {
                  const on = picked.includes(key);
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => toggle(key)}
                      title={on ? `${name}：能用，点一下去掉` : `${name}：点一下加进清单`}
                      className={`rounded-full border px-3 py-1.5 text-meta transition-colors duration-150 ${
                        on ? "border-ink bg-ink text-paper-invert" : "border-line text-ink-soft"
                      }`}
                    >
                      {name}
                      <span className="ml-1.5 font-mono opacity-70">{key}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          <p className="text-meta leading-relaxed text-ink-faint">
            已经勾了 {picked.length}/13 个。本地 Mac 模式发不了特效 ——
            那边会退回纯文本把话照常发出去，日志里留一行提醒。
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * 「聊天背景」那一段：只有一个开关。
 *
 * 对方换了 iMessage 的聊天背景（iOS 26 起单个对话可以单独换壁纸），
 * 角色这边就在他下一次开口时收到一句
 * `[系统提示:{{user}}更改了当前聊天背景]`，跟着他那句话一起进提示词。
 *
 * 界面要交代清楚两件事，不然用户会以为是坏的：
 *  1. 这**不是** Spectrum 推过来的 —— provider 只订阅消息/投票/群聊三种事件流，
 *     chat 事件到不了桥接这边，所以后台会另开一条 Photon 的 gRPC 连接专门订阅
 *     （见服务端 chatbg.js）。开了就意味着这条线路多一个常驻连接。
 *  2. 提示不主动发 —— 对方换完背景不说话的话什么都不会发生，要等他下一句。
 *     主动搭话是「角色主动消息」那栏的事，不该由换壁纸触发。
 */
function RoleChatBackgroundFields({ role }) {
  const { updateRole } = useConfig();
  const bg = role.chatBackground ?? {};

  return (
    <div className="grid grid-cols-1 gap-6">
      <label className="flex items-start justify-between gap-4">
        <span className="min-w-0">
          <span className="block text-ui text-ink">聊天背景变更提示</span>
          <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
            对方给这个对话换了背景（或者把背景清掉）之后，他
            <strong className="text-ink-soft">下一次</strong>
            发消息过来时，前面会多一句
            <code className="mx-1 bg-sunken px-1">{"[系统提示:{{user}}更改了当前聊天背景]"}</code>
            ，模型能接一句「你换背景了？」这种话。
            <br />
            不会因为换背景就主动开口 —— 提示先存着，等他说话时一起送进去，
            超过十分钟没说话就作废。
            <br />
            后台为此会多起一条只订阅「聊天背景」的连接（这条事件不在主连接上），
            所以默认关。只支持云端 Photon 模式。
          </span>
        </span>
        <Switch
          checked={Boolean(bg.enabled)}
          onChange={(v) => updateRole(role.id, { chatBackground: { ...bg, enabled: v } })}
          label="启用聊天背景变更提示"
        />
      </label>
    </div>
  );
}

/**
 * 「记忆库」那一段：三个开关 + 日记的「注入近 N 天」。
 *
 * 和联网搜索 / 发语音同一个路子 —— **闸在角色、设置在别处**：
 *
 *  - 这里只有三个 enabled（会额外打接口、还会在磁盘上攒流水，
 *    该由「用哪个角色」决定，所以默认全关）
 *  - 模型、轮数、四段提示词、日记的定时和字数都在「记忆库 → 设置」里，
 *    全局一份、所有角色共用
 *  - 记忆和日记的**正文**也在那个面板里看和改
 *
 * `injectDays` 是唯一挂在角色上的设置项，因为用户的规范里明写了它是
 * 「开启角色日记后的延伸选项」。0 = 日记照样写，只是不回注给模型。
 */
function RoleMemoryFields({ role, onGoto }) {
  const { updateRole } = useConfig();
  const openGate = usePresetGate(role);
  const mem = role.memories ?? {};
  const memory = mem.memory ?? {};
  const memo = mem.memo ?? {};
  const diary = mem.diary ?? {};

  /**
   * 三块各自浅合并 —— 只传自己那块，别把另两块整份重写回去。
   * 开的时候顺手把「预设 → 记忆库」那条条目也打开（关的时候不碰，理由见 usePresetGate）。
   */
  const patch = (kind, part) => {
    updateRole(role.id, { memories: { ...mem, [kind]: { ...(mem[kind] ?? {}), ...part } } });
    if (part.enabled === true) openGate("memory");
  };

  return (
    <div className="grid grid-cols-1 gap-6">
      {/* 标题由外面那个折叠栏出，这儿只留说明 —— 同一个「记忆库」不写两遍 */}
      <p className="text-meta leading-relaxed text-ink-faint">
        三样长期记忆，各自一道闸，默认全关 ——
        每一样都要多打一次模型（记忆还要额外打一次向量接口），而且会在磁盘上
        攒一份待总结的流水。设置和内容都在
        <button
          type="button"
          className="mx-1 underline decoration-line underline-offset-2 hover:text-ink"
          onClick={() => onGoto?.("memories")}
        >
          记忆库
        </button>
        面板里。
      </p>

      <label className="flex items-start justify-between gap-4">
        <span className="min-w-0">
          <span className="block text-ui text-ink">记忆</span>
          <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
            聊满一定轮数就把这段对话总结成一条长期记忆。下一轮开始，
            <strong className="text-ink-soft">近 N 天的记忆</strong>
            会整段注入，另外还会拿对方这句话去
            <strong className="text-ink-soft">向量检索</strong>
            一遍，把相关的老记忆捞回来 —— 上下文被丢掉的那部分靠这个找回来。
            <br />
            三样里只有它用向量模型（要在「记忆库 → 设置」里选一个标了「向量」分类的）。
            向量打不通时会退化成「只注入近 N 天」，不会挡住这一轮回复。
          </span>
        </span>
        <Switch
          checked={Boolean(memory.enabled)}
          onChange={(v) => patch("memory", { enabled: v })}
          label="启用记忆"
        />
      </label>

      <label className="flex items-start justify-between gap-4">
        <span className="min-w-0">
          <span className="block text-ui text-ink">备忘录</span>
          <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
            一份<strong className="text-ink-soft">不断覆盖</strong>
            的清单：约好的事、答应过的话、还没做完的。每次生成都是整份重写，
            所以它永远只有「现在还有效」的那些条目，不像记忆那样越攒越多。
          </span>
        </span>
        <Switch
          checked={Boolean(memo.enabled)}
          onChange={(v) => patch("memo", { enabled: v })}
          label="启用备忘录"
        />
      </label>

      <label className="flex items-start justify-between gap-4">
        <span className="min-w-0">
          <span className="block text-ui text-ink">日记</span>
          <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
            角色以第一人称写自己的一天。每轮聊完往流水里追加两行
            （时间 + 发送人 + 内容），到点或者你发
            <code className="mx-1 bg-sunken px-1">/日记</code>
            时把这段流水写成一篇。
            <strong className="text-ink-soft">写成的日记永远不会被程序删掉</strong>
            ，只有你在界面上手动删。
          </span>
        </span>
        <Switch
          checked={Boolean(diary.enabled)}
          onChange={(v) => patch("diary", { enabled: v })}
          label="启用日记"
        />
      </label>

      {diary.enabled && (
        <div className="grid grid-cols-1 gap-3 border-l-2 border-line pl-4">
          <NumberField
            label="注入近 N 天的日记"
            value={diary.injectDays ?? 3}
            min={0}
            max={30}
            step={1}
            onChange={(v) => patch("diary", { injectDays: v })}
            hint="聊天时把这几天写成的日记一起发给模型"
            suffix="天"
          />
          <p className="text-meta leading-relaxed text-ink-faint">
            填 0 = 照样写日记，但<strong className="text-ink-soft">不回注</strong>
            给模型（想留着自己看的时候用这个）。这一项是每个角色各自配的，
            其余日记设置在「记忆库 → 设置 → 日记」里，全局共用。
          </p>
        </div>
      )}

      <p className="text-meta leading-relaxed text-ink-faint">
        四个变量（
        <code className="mx-0.5 bg-sunken px-1">{"{{近N天记忆}}"}</code>
        <code className="mx-0.5 bg-sunken px-1">{"{{回忆起来的记忆}}"}</code>
        <code className="mx-0.5 bg-sunken px-1">{"{{备忘录}}"}</code>
        <code className="mx-0.5 bg-sunken px-1">{"{{近N天日记}}"}</code>
        ）由
        <button
          type="button"
          className="mx-1 underline decoration-line underline-offset-2 hover:text-ink"
          onClick={() => onGoto?.("preset")}
        >
          预设 → 记忆库
        </button>
        那条条目负责往提示词里塞。开这三个开关的时候会把那条条目一并打开；
        要是回头在预设里又把它关了，这三个开关也不起作用
        （总结照样跑、内容照样存，只是不发给模型）。
      </p>

      <p className="text-meta leading-relaxed text-ink-faint">
        记忆库是按<strong className="text-ink-soft">角色名</strong>
        分文件夹的，所以<strong className="text-warn">改名等于换一份新的记忆库</strong>
        —— 旧的还在磁盘上，但这个角色读不到了。
      </p>
    </div>
  );
}

/**
 * 提示词那一栏：textarea + 「清空 = 恢复默认」。
 *
 * **必须定义在父组件外面**（和下面 CityField 同一个理由）：定义在里面的话
 * 每次 render 都是一个新的组件类型，React 会把子树卸掉重建，textarea
 * 每敲一个字就失焦。
 *
 * 和 memorysettings.jsx 里那个是同一份东西，但**没有**从那边 import ——
 * 那个文件已经 import 了这边的 ModelSelect，反过来再引一次就成了循环依赖。
 * 十几行的展示组件，抄一份比绕出一个环划算。
 *
 * 「清空并保存 = 恢复默认」不是偷懒：后端 normalizeProactive 里留空就回落到
 * 内置那份，所以清空再保存正好等于恢复默认，前端不用再存一份默认文案
 * （存了就会和后端分叉）。
 */
function PromptField({ label, hint, value, onChange, placeholder }) {
  return (
    <Field label={label} hint={hint}>
      <textarea
        className={`${inputCls} min-h-[120px] resize-y font-mono leading-relaxed`}
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

/**
 * 「提示词协助模式」那一段。
 *
 * 这一栏和这一页其他所有开关都是**反着的**：别的开关是给角色加能力（会发语音、
 * 会发图、会撤回），这一个是把角色整个请下去 —— 对方在 iMessage 里发一句
 * `/提示词协助模式`，接下来说的话由一个提示词工程师接，一句戏都不演。
 *
 * 所以它默认开着，而不像别的新能力那样默认关：
 *
 *  - 它**不会自己动**。没人敲那条指令，这一栏等于不存在，不花一分钱。
 *  - 用得着它的那一刻，恰恰是角色刚崩掉、人最烦躁的时候。这时候还要先跑到
 *    网页上把这一长串折叠栏翻一遍找开关，功能就白做了。
 *
 * 关掉它的正经理由只有一个：这条号码是给别人用的，你不想让对方有办法把
 * 角色掀开、看见底下的人设和世界书。真是这个用途的话，这个开关就是那道门。
 */
function RolePromptAssistFields({ role }) {
  const { updateRole } = useConfig();
  const pa = role.promptAssist ?? {};
  // updateRole 是浅合并，每次都得把整个 promptAssist 摊开重写
  const patch = (part) => updateRole(role.id, { promptAssist: { ...pa, ...part } });

  return (
    <div className="grid grid-cols-1 gap-6">
      <label className="flex items-start justify-between gap-4">
        <span className="min-w-0">
          <span className="block text-ui text-ink">提示词协助模式</span>
          <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
            在聊天窗口里发 <code className="font-mono text-ink-soft">/提示词协助模式</code>
            ，这个角色就<strong className="text-ink-soft">让位</strong>
            ，换一个提示词工程师来和你聊：帮你查它刚才为什么跑偏，问题出在人设、
            世界书还是预设。这期间
            <strong className="text-ink-soft">不会有任何角色扮演</strong>
            ，说的话也
            <strong className="text-ink-soft">不进角色的上下文</strong>
            ，发{" "}
            <code className="font-mono text-ink-soft">/提示词协助模式关闭</code>{" "}
            结束，这期间的对话一并丢掉。
            <br />
            它看得见的是
            <strong className="text-ink-soft">这一刻真正发给角色的那份提示词</strong>
            （预设条目的顺序、世界书这一轮命中了哪几条、人设、上下文），用 XML
            包好当材料发过去 —— 你在「提示词」面板里看到的是什么，它看到的就是什么。
          </span>
        </span>
        <Switch
          checked={pa.enabled !== false}
          onChange={(v) => patch({ enabled: v })}
          label="启用提示词协助模式"
        />
      </label>

      {pa.enabled !== false && (
        <>
          <label className="flex items-start justify-between gap-4">
            <span className="min-w-0">
              <span className="block text-ui text-ink">用独立的 API</span>
              <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                不开就用上面「模型 → 聊天 API」那条，和角色同一个模型。
                开了可以单独挑一个 —— 排查提示词是个讲逻辑的活，和演角色要的
                不是一回事，有人愿意在这里换一个更能讲道理的模型。
                <br />
                挑的那个失效了（服务商删了、模型关了）也不会把协助模式堵死，
                会自动退回角色的聊天 API，只在日志里记一笔。
              </span>
            </span>
            <Switch
              checked={Boolean(pa.useOwnModel)}
              onChange={(v) => patch({ useOwnModel: v })}
              label="用独立的 API"
            />
          </label>

          {pa.useOwnModel && (
            <div className="border-l-2 border-line pl-4">
              <Field
                label="协助模式用哪个模型"
                hint="温度那些一概不带 —— 预设里的参数是为角色扮演调的（偏高求变化），拿来做诊断只会让它发散，这里用上游自己的默认值"
              >
                <ModelSelect
                  category="chat"
                  value={pa.model}
                  onChange={(ref) => patch({ model: { ...(pa.model ?? {}), ...ref } })}
                />
              </Field>
            </div>
          )}

          <PromptField
            label="提示词工程师的身份声明"
            hint="压在那份原始提示词最前面，再在每轮末尾补一遍 —— 中间隔着一整份角色扮演提示词，只在开头说一次容易被它读着读着忘掉"
            value={pa.prompt}
            onChange={(v) => patch({ prompt: v })}
            placeholder="留空 = 用内置的那份"
          />

          <p className="text-meta leading-relaxed text-ink-faint">
            协助模式的回复算<strong className="text-ink-soft">系统发言</strong>，
            所以<strong className="text-warn">防相亲开着的时候它也不会发出来</strong>
            。这是有意的：诊断内容里全是人设和世界书的原文，正是最不该让旁人
            看见的那类东西。要用协助模式，先把防相亲关掉。
          </p>
        </>
      )}
    </div>
  );
}

/** 两种模式各占一张卡。和 user.jsx 的「生效范围」是同一个样式。 */
const PROACTIVE_MODES = [
  {
    value: "random",
    label: "随机等待",
    icon: Dices,
    desc: "在你设的那段时间里掷一个点，到点就开口。不花额外的钱",
  },
  {
    value: "auto",
    label: "自主判断",
    icon: Brain,
    desc: "干等一阵子之后问模型「隔多久再开口合适」，按它给的时间排",
  },
];

/**
 * 「角色主动消息」那一段：隔一阵子没人说话，角色自己找你说话。
 *
 * 这一栏和这个面板里上面那些栏都不一样 —— 别的功能都是**你先发一句、它才动**，
 * 这个是**没人操作也会自己打模型、自己往真实号码发短信**（最底下那栏 Instagram
 * 也有这个性子，它就是挂在这一轮上的）。所以：
 *
 *  - 默认关（和 webSearch / imageGen 一个规矩，但这条更重）
 *  - 默认带勿扰时段（00:00-08:00），半夜被角色叫醒是这功能最容易挨骂的地方
 *  - 界面上把「会自己花钱」写在开关底下，不藏在展开项里
 *
 * 计时是落盘的（`data/proactive.json`）：重启、关机都不清表，号码一连上就
 * 接着上次的点数下去。关机期间已经到点的那些会缓一分钟补发，不会一开机
 * 就炸一串出去。
 */
function RoleProactiveFields({ role }) {
  const { config, updateRole } = useConfig();
  const p = role.proactive ?? {};
  const random = p.random ?? {};
  const auto = p.auto ?? {};
  const focus = p.focus ?? {};
  const lor = role.leaveOnRead ?? {};
  // 那句「已读了但没回」里的 {{user}} 就是这条人设的名字，照原样显示出来
  const who = resolveUser(config, role)?.name?.trim() || "用户";

  // updateRole 是浅合并，每次都得把整个 proactive 摊开重写
  const patch = (part) => updateRole(role.id, { proactive: { ...p, ...part } });
  const patchIn = (kind, part) => patch({ [kind]: { ...(p[kind] ?? {}), ...part } });

  return (
    <div className="grid grid-cols-1 gap-6">
      <label className="flex items-start justify-between gap-4">
        <span className="min-w-0">
          <span className="block text-ui text-ink">主动消息</span>
          <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
            对方不说话的时候，这个角色隔一阵子
            <strong className="text-ink-soft">自己找他说话</strong>
            。这是这一页里唯一
            <strong className="text-warn">没人操作也会自己打模型、自己往真号码发短信</strong>
            的功能，所以默认关着 —— 开之前先把下面的勿扰时段和间隔看一眼。
            <br />
            计时是<strong className="text-ink-soft">存在硬盘上的</strong>
            ，重启、关机都不会清掉，号码一连上就接着上次的点往下数。关机期间
            已经到点的那几条会缓一分钟再补发，不会一开机就炸出去一串。
          </span>
        </span>
        <Switch
          checked={Boolean(p.enabled)}
          onChange={(v) => patch({ enabled: v })}
          label="启用主动消息"
        />
      </label>

      {p.enabled && (
        <>
          <Field label="怎么决定下一条什么时候发">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {PROACTIVE_MODES.map((m) => {
                const on = (p.mode ?? "random") === m.value;
                const Icon = m.icon;
                return (
                  <button
                    key={m.value}
                    type="button"
                    onClick={() => patch({ mode: m.value })}
                    className={`rounded-item border p-3.5 text-left transition-colors duration-150 ${
                      on ? "border-ink bg-sunken" : "border-line hover:bg-sunken"
                    }`}
                  >
                    <span className="flex items-center gap-2 text-ui text-ink">
                      <Icon size={15} className={on ? "text-ink" : "text-ink-faint"} />
                      {m.label}
                    </span>
                    <span className="mt-1 block text-meta leading-snug text-ink-faint">
                      {m.desc}
                    </span>
                  </button>
                );
              })}
            </div>
          </Field>

          {(p.mode ?? "random") === "random" ? (
            <div className="grid grid-cols-1 gap-3 border-l-2 border-line pl-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <NumberField
                  label="最短等待"
                  value={random.minHours ?? 1}
                  min={0.5}
                  max={72}
                  step={0.5}
                  onChange={(v) => patchIn("random", { minHours: v })}
                  suffix="小时"
                />
                <NumberField
                  label="最长等待"
                  value={random.maxHours ?? 3}
                  min={0.5}
                  max={72}
                  step={0.5}
                  onChange={(v) => patchIn("random", { maxHours: v })}
                  suffix="小时"
                />
              </div>
              <p className="text-meta leading-relaxed text-ink-faint">
                每次都在这两个数之间
                <strong className="text-ink-soft">重新掷一个点</strong>
                ，不是固定间隔。发完之后还会额外压
                <strong className="text-ink-soft">十分钟</strong>
                冷却再开始下一轮计时，免得模型连着自言自语。两头填反了不算错，
                保存时会自动按小的当下限。
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-6 border-l-2 border-line pl-4">
              <NumberField
                label="触发判断的最短等待"
                value={auto.minWaitMinutes ?? 60}
                min={1}
                max={1440}
                step={1}
                onChange={(v) => patchIn("auto", { minWaitMinutes: v })}
                hint="对方多少分钟没回话，就去问模型「下一条隔多久发」"
                suffix="分钟"
              />

              <Field
                label="时间判断用哪个模型"
                hint="不选 = 用上面「模型 → 聊天 API」那条。判断只带人设和几条上文，一次的钱可以忽略"
              >
                <ModelSelect
                  category="chat"
                  value={auto.model}
                  onChange={(ref) => patchIn("auto", { model: { ...(auto.model ?? {}), ...ref } })}
                />
              </Field>

              <PromptField
                label="时间判断提示词"
                hint="要模型只回一个数字（单位：小时，可以是小数）。写成一长段也没关系，会剥掉思考过程再从里面抠数字，「30分钟」这种带单位的也认；一个数字都找不到才按 1 小时算"
                value={auto.prompt}
                onChange={(v) => patchIn("auto", { prompt: v })}
                placeholder="留空 = 用内置的那段"
              />

              <p className="text-meta leading-relaxed text-ink-faint">
                这段里的
                <code className="mx-1 bg-sunken px-1">{"{Focus_time_start}"}</code>
                <code className="mr-1 bg-sunken px-1">{"{Focus_time_end}"}</code>
                是<strong className="text-ink-soft">单花括号</strong>
                的，会换成下面那个勿扰时段（勿扰关着就填「无」）。
                <code className="mx-1 bg-sunken px-1">{"{{char}}"}</code>
                <code className="mr-1 bg-sunken px-1">{"{{user}}"}</code>
                这类双花括号变量照常能用。判断这一步只带人设和最近几条上文，
                不拼预设和世界书 —— 那些几千 token，为一个数字不值当。
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 gap-6 border-t border-line pt-6">
            <PromptField
              label="主动消息提示词"
              hint="到点之后以系统身份发给模型的那条话。模型收到它之后写出来的东西就是发给对方的消息"
              value={p.prompt}
              onChange={(v) => patch({ prompt: v })}
              placeholder="留空 = 用内置的那段"
            />

            <p className="text-meta leading-relaxed text-ink-faint">
              这段
              <strong className="text-ink-soft">不进上下文</strong>
              ：模型看到的是完整的提示词，但存进历史和存档的只有
              <code className="mx-1 bg-sunken px-1">[触发了主动消息]</code>
              （前面照例带一个时间戳，和别的消息一致）。提示词写多长都不会在
              之后每一轮里重发一遍，省的就是这个钱。
            </p>

            <NumberField
              label="带多少条上文"
              value={p.contextCount ?? 10}
              min={0}
              max={100}
              step={1}
              onChange={(v) => patch({ contextCount: v })}
              hint="自主判断时给判断模型看几条；填 0 = 一条不带，等于让它凭人设自言自语"
              suffix="条"
            />
          </div>

          <div className="grid grid-cols-1 gap-6 border-t border-line pt-6">
            <label className="flex items-start justify-between gap-4">
              <span className="min-w-0">
                <span className="block text-ui text-ink">勿扰时段</span>
                <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                  这段时间里既不发主动消息、也不去问模型时间，到点之后再接着排。
                  按<strong className="text-ink-soft">系统时间</strong>
                  算（服务器的本地时间，不做时区换算），跨零点也认。
                  <strong className="text-ink-soft">建议开着</strong>
                  ，默认 00:00–08:00。
                </span>
              </span>
              <Switch
                checked={focus.enabled !== false}
                onChange={(v) => patchIn("focus", { enabled: v })}
                label="启用勿扰时段"
              />
            </label>

            {focus.enabled !== false && (
              <div className="grid grid-cols-1 gap-4 border-l-2 border-line pl-4 sm:grid-cols-2">
                <Field label="开始">
                  <input
                    type="time"
                    className={`${inputCls} !w-32`}
                    value={focus.start ?? "00:00"}
                    onChange={(e) => patchIn("focus", { start: e.target.value })}
                  />
                </Field>
                <Field label="结束">
                  <input
                    type="time"
                    className={`${inputCls} !w-32`}
                    value={focus.end ?? "08:00"}
                    onChange={(e) => patchIn("focus", { end: e.target.value })}
                  />
                </Field>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 border-t border-line pt-6">
            {lor.receipt ? (
              <label className="flex items-start justify-between gap-4">
                <span className="min-w-0">
                  <span className="block text-ui text-ink">对方读了没</span>
                  <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                    发出去的主动消息如果
                    <strong className="text-ink-soft">被读了但没回</strong>
                    ，下一条触发的时候会在提示词后面缀一句「{who}
                    已读了你发的信息，但还没回复」，
                    让角色知道自己被晾着了 —— 是继续找话说还是收着点，交给人设决定。
                    关掉的话下一条照发，只是不告诉它这件事。
                  </span>
                </span>
                <Switch
                  checked={p.notifyRead !== false}
                  onChange={(v) => patch({ notifyRead: v })}
                  label="告诉角色「对方读了但没回」"
                />
              </label>
            ) : (
              <>
                <p className="text-ui text-ink">对方读了没</p>
                <p className="text-meta leading-relaxed text-ink-faint">
                  这一项要
                  <strong className="text-warn">先打开「已读与不回 → 已读回执」</strong>
                  ：已读状态是从对方发回来的已读回执里读的，那个开关关着就收不到，
                  也就没法在下一条主动消息里告诉角色「他读了但没回」。
                  <button
                    type="button"
                    className="mx-1 underline decoration-line underline-offset-2 hover:text-ink"
                    onClick={() => updateRole(role.id, { leaveOnRead: { ...lor, receipt: true } })}
                  >
                    顺手打开
                  </button>
                  （只改这个角色，保存后生效）。
                </p>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 模型下拉。只列「已配置的服务商里开着的、且带这个分类的」模型。
 *
 * 引用失效时不静默清空：把当前那个值也放进选项里并标红，
 * 让用户看见「引用的模型已删除」再自己决定改成哪个。
 */
export function ModelSelect({ category, value, onChange }) {
  const { config } = useConfig();
  const groups = modelOptions(config, category);
  const d = describeRef(config, value);
  const stale = !d.ok && !d.empty;

  return (
    <>
      <select
        className={`${inputCls} ${stale ? "border-warn text-warn" : ""}`}
        value={refValue(value)}
        onChange={(e) => onChange(parseRefValue(e.target.value))}
      >
        <option value="">（未选择）</option>
        {stale && <option value={refValue(value)}>⚠ {d.text}</option>}
        {groups.map((g) => (
          <optgroup key={g.provider.id} label={providerLabel(g.provider)}>
            {g.models.map((m) => (
              <option key={m.id} value={`${g.provider.id}::${m.id}`}>
                {modelLabel(m)}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {stale && (
        <p className="mt-2 flex items-start gap-1.5 text-meta leading-relaxed text-warn">
          {d.text}。这条线现在等于没配，重新挑一个。
        </p>
      )}
      {!stale && groups.length === 0 && (
        <p className="mt-2 text-meta leading-relaxed text-ink-faint">
          「连接」面板里还没有标了「{CATEGORY_LABELS[category]}」分类的模型。
        </p>
      )}
    </>
  );
}

/** 「应用到其他角色」：勾目标角色，只复制 API 配置。 */
export function ApplyApiDialog({ role, onClose }) {
  const { config, applyApiToRoles } = useConfig();
  const others = (config.roles ?? []).filter((r) => r.id !== role.id);
  const [picked, setPicked] = useState([]);
  const allOn = others.length > 0 && picked.length === others.length;

  function toggle(id) {
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function apply() {
    if (!picked.length) return;
    applyApiToRoles(role.id, picked);
    onClose();
  }

  return (
    <Modal
      title="应用到其他角色"
      desc={`把「${roleLabel(role)}」的聊天 / 副 / 识图 / 听音 API、读文件和上下文限制复制过去`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button onClick={apply} disabled={!picked.length}>
            <Copy size={14} /> 应用到 {picked.length} 个角色
          </Button>
        </>
      }
    >
      {others.length === 0 ? (
        <p className="py-6 text-center text-ui text-ink-faint">只有这一个角色，没有可应用的对象。</p>
      ) : (
        <>
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-meta leading-relaxed text-ink-faint">
              只覆盖 API 和上下文限制，人设、绑定的项目、对话记录都不动。
            </p>
            <button
              type="button"
              onClick={() => setPicked(allOn ? [] : others.map((r) => r.id))}
              className="shrink-0 text-meta text-ink hover:underline"
            >
              {allOn ? "全不选" : "全选"}
            </button>
          </div>
          <div className="grid grid-cols-1 gap-1.5">
            {others.map((r) => {
              const on = picked.includes(r.id);
              const d = describeRef(config, r.chatModel);
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => toggle(r.id)}
                  className={`flex items-center gap-3 border px-3.5 py-3 text-left transition-colors duration-150 ${
                    on ? "border-ink bg-sunken" : "border-line bg-paper hover:bg-sunken"
                  }`}
                >
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center border ${
                      on ? "border-ink bg-ink text-paper-invert" : "border-line"
                    }`}
                  >
                    {on && <Check size={12} />}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-ui text-ink">{roleLabel(r)}</span>
                    <span
                      className={`mt-0.5 block truncate text-meta ${d.ok ? "text-ink-faint" : "text-warn"}`}
                    >
                      现在用：{d.text}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </Modal>
  );
}

/** 角色卡片。列表态一屏看完：人设首行、号码、在线状态、用的哪个模型。 */
/**
 * 人设文本框下面那行变量说明。
 *
 * 顺带告诉用户「这个角色实际会拼进去哪条用户人设」—— 优先级规则
 * （绑定的 > 全局的）不写出来没人猜得到，配了两条以上更容易迷糊。
 */
export function VarHint({ role, onGoto }) {
  const { config } = useConfig();
  const user = resolveUser(config, role);

  return (
    <div className="border-l-2 border-line py-1.5 pl-3 text-meta leading-relaxed text-ink-soft">
      <p>
        可以用变量：<code className="bg-sunken px-1">{"{{char}}"}</code> ={""}
        {role.name?.trim() || "这个角色的名字（还没填）"}，
        <code className="bg-sunken px-1">{"{{user}}"}</code> = 用户人设的名字。
        留空的变量会替换成「助手」/「用户」，不会把花括号原样发出去。
      </p>
      <p className="mt-1.5">
        {user ? (
          <>
            现在对这个角色生效的用户人设是<span className="text-ink">「{userLabel(user)}」</span>
            {user.scope === "global" ? "（全局那条）" : "（专门绑给它的）"}。
          </>
        ) : (
          "还没有用户人设对这个角色生效，模型只知道自己是谁、不知道对面是谁。"
        )}
        <button
          type="button"
          onClick={() => onGoto?.("user")}
          className="ml-1 text-ink hover:underline"
        >
          去「用户」面板
        </button>
      </p>
    </div>
  );
}

/**
 * 角色「单独配置」里的预设 + 世界书两块。
 *
 * 单独拆出来是因为 RoleDetail 已经很长，而这两块有自己的一堆派生状态
 * （引用有没有失效、哪些书是全局的）。
 */
export function RolePresetFields({ role, onGoto }) {
  const { config, updateRole, toggleRoleWorldBook } = useConfig();
  const presets = config.presets ?? [];
  const books = config.worldBooks ?? [];
  const presetNote = presetBlockReason(config, role);
  // presetRef 指向已删除的预设时下拉里没有对应 option，得把它也放进去标红
  const staleRef = Boolean(role.presetRef) && !presets.some((p) => p.id === role.presetRef);

  const globals = books.filter((b) => b.global);
  const own = books.filter((b) => !b.global);
  const refs = role.worldBookRefs ?? [];
  // 挂着但书已经被删了的引用。不静默清理（和模型引用一个道理），标红让用户自己处理
  const deadRefs = refs.filter((id) => !books.some((b) => b.id === id));

  return (
    <div className="grid grid-cols-1 gap-6">
      {/* 标题由外面那个折叠栏出，这儿只留说明 */}
      <p className="text-meta leading-relaxed text-ink-faint">
        预设决定「提示词怎么拼 + 生成参数怎么给」，温度、Top P
        这些从这里的模型配置搬到预设里去了 —— 它们是生成行为，不是某条连接的属性。
      </p>

      <Field label="使用的预设" hint="每个角色各选一份">
        <select
          className={`${inputCls} ${staleRef ? "border-warn text-warn" : ""}`}
          value={role.presetRef ?? ""}
          onChange={(e) => updateRole(role.id, { presetRef: e.target.value })}
        >
          <option value="">
            {presets.length ? `（默认用第一份：${presetLabel(presets[0])}）` : "（还没有预设）"}
          </option>
          {staleRef && <option value={role.presetRef}>⚠ 引用的预设已删除</option>}
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {presetLabel(p)} · 温度 {p.params?.temperature ?? 0.7}
            </option>
          ))}
        </select>
      </Field>

      <p className="flex flex-wrap items-start gap-x-1.5 gap-y-1 text-meta leading-relaxed text-ink-faint">
        {presetNote ? (
          <span className={staleRef ? "text-warn" : ""}>{presetNote}</span>
        ) : (
          <span>温度、Top P、最大 token、频率惩罚、存在惩罚都在预设里调。</span>
        )}
        <button
          type="button"
          onClick={() => onGoto?.("preset")}
          className="text-ink hover:underline"
        >
          去「预设」面板
        </button>
      </p>

      {/* 世界书 */}
      <div className="grid grid-cols-1 gap-3 border-t border-line pt-6">
        <div>
          <p className="text-ui text-ink">这个角色的世界书</p>
          <p className="mt-0.5 text-meta leading-relaxed text-ink-faint">
            勾上的书会在这个角色对话时参与扫描。全局的书不用勾，对所有角色都生效。
          </p>
        </div>

        {own.length === 0 && globals.length === 0 && (
          <p className="text-meta leading-relaxed text-ink-faint">
            还没有世界书。
            <button
              type="button"
              onClick={() => onGoto?.("world")}
              className="ml-1 text-ink hover:underline"
            >
              去「世界书」面板建一本
            </button>
          </p>
        )}

        {own.length > 0 && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {own.map((b) => {
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
                    onChange={() => toggleRoleWorldBook(role.id, b.id)}
                    className="mt-0.5 shrink-0 accent-ink"
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-ui text-ink">{worldBookLabel(b)}</span>
                    <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                      {(b.entries ?? []).length} 条
                      {b.enabled ? "" : " · 整本被关掉了"}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        )}

        {globals.length > 0 && (
          <p className="text-meta leading-relaxed text-ink-faint">
            另有 {globals.length} 本全局世界书对所有角色生效：
            {globals.map((b) => worldBookLabel(b)).join("、")}。
          </p>
        )}

        {deadRefs.length > 0 && (
          <p className="flex items-start gap-1.5 text-meta leading-relaxed text-warn">
            还挂着 {deadRefs.length} 本已经被删掉的世界书，这些引用不起作用。
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * 一张头像：预览 + 换 + 清。
 *
 * **必须定义在 RoleOfflineFields 外面**，理由和下面 CityField 那段一模一样 ——
 * 定义在里面每次 render 都是一个新组件类型，React 会把子树整个重建。这里虽然
 * 没有输入框，但重建会把 `busy` 状态一起冲掉，上传转圈会闪。
 *
 * 图片存在 `data/offline/media/`，配置里只存文件名。没有图就画首字母 ——
 * 换机器之后备份包里没有图片，退回的就是这个占位（见 config.js:normalizeOffline）。
 */
function AvatarField({ label, hint, file, fallback, onChange }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const url = offlineMediaUrl(file);
  const initial = String(fallback ?? "").trim().slice(0, 1) || "?";

  async function pick(input) {
    const one = input.files?.[0];
    // 同一张图连着选两次也要触发 change，所以先把 value 清掉
    input.value = "";
    if (!one) return;
    setBusy(true);
    setError("");
    try {
      onChange(await uploadOfflineAvatar(one));
    } catch (e) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Field label={label} hint={hint}>
        <div className="mt-1 flex items-center gap-3">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden border border-line bg-sunken">
            {url ? (
              <img src={url} alt="" className="h-full w-full object-cover" />
            ) : (
              <span className="text-ui text-ink-faint">{initial}</span>
            )}
          </span>
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-line px-3.5 py-1.5 text-meta text-ink-soft transition-colors duration-150 hover:bg-ink/[0.08] hover:text-ink">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <ImagePlus size={14} />}
            {file ? "换一张" : "挑一张"}
            <input
              type="file"
              accept="image/*"
              className="hidden"
              disabled={busy}
              onChange={(e) => pick(e.target)}
            />
          </label>
          {file && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onChange("")}
              className="inline-flex items-center gap-1 rounded-full px-2.5 py-1.5 text-meta text-ink-faint transition-colors duration-150 hover:bg-sunken hover:text-warn"
            >
              <X size={13} /> 清掉
            </button>
          )}
        </div>
      </Field>
      {error && (
        <p className="mt-1.5 border-l-2 border-warn py-1.5 pl-3 text-meta leading-relaxed text-warn">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * 「线下模式」那一段：坐下来演一段剧情，不是发短信。
 *
 * 这一栏和上面所有栏的关系是**互斥**，不是叠加 —— 线下一开，这个角色的线上
 * 功能全部停用（主动消息不发、消息格式与功能整条不进提示词、语音表情包撤回
 * 那一摞全不走）。所以界面上第一句话就得说这个，别让人以为是「又多一个能力」。
 *
 * 这里那个 `enabled` 是**允许闸**，不是「现在开着吗」：真正的开关状态在
 * `data/offline/index/<roleKey>.json` 里（每轮都写，不能进配置 —— `PUT /api/config`
 * 会顺带重启所有 iMessage 桥接）。所以这一栏配完还要去「线下模式」分区、或者在
 * iMessage 里发 `/开启线下` 才真的开始演。这层区分写在开关底下。
 *
 * 三个默认值是用户钉死的：小总结 6 轮、大总结默认关、大总结攒 8 个小总结。
 */
export function RoleOfflineFields({ role, onGoto }) {
  const { config, updateRole } = useConfig();
  const off = role.offline ?? {};
  // updateRole 是浅合并，每次都得把整个 offline 摊开重写
  const patch = (part) => updateRole(role.id, { offline: { ...off, ...part } });

  // 线下预设是**另一批**（preset.mode === "offline"），和线上那批不串
  const presets = presetsFor(config, "offline");
  const presetNote = presetBlockReason(config, role, "offline");
  const staleRef = Boolean(off.presetRef) && !presets.some((p) => p.id === off.presetRef);
  const preset = resolvePreset(config, role, "offline");
  // 线下预设里那条 userChoice 条目开着吗 —— 角色这边的开关是第二道闸
  const choiceEntry = (preset?.entries ?? []).find((e) => e.kind === "userChoice");

  const books = config.worldBooks ?? [];
  const globals = books.filter((b) => b.global);
  const own = books.filter((b) => !b.global);
  const refs = off.worldBookRefs ?? [];
  const deadRefs = refs.filter((id) => !books.some((b) => b.id === id));
  const toggleBook = (id) =>
    patch({ worldBookRefs: refs.includes(id) ? refs.filter((x) => x !== id) : [...refs, id] });

  const userName = resolveUser(config, role)?.name?.trim() || "用户";

  return (
    <div className="grid grid-cols-1 gap-6">
      <label className="flex items-start justify-between gap-4">
        <span className="min-w-0">
          <span className="block text-ui text-ink">允许这个角色开线下</span>
          <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
            线下剧情是<strong className="text-ink-soft">坐下来演一段</strong>
            ，不是发短信。开着的时候这个角色的
            <strong className="text-warn">线上功能全部停用</strong>
            ：主动消息不发、「消息格式与功能」整条不进提示词，语音 / 表情包 /
            撤回 / 已读不回 / 回应 / 特效那一摞也全不走 —— 演剧情的时候冒出一个
            <code className="mx-1 font-mono text-ink-soft">[audio_message:…]</code>
            就破了。
            <br />
            这个开关只是<strong className="text-ink-soft">允许</strong>
            ，不等于现在开着。真正开始演要去
            <button
              type="button"
              onClick={() => onGoto?.("offline")}
              className="link-slide mx-1 text-ink"
            >
              「线下模式」分区
            </button>
            点开，或者在 iMessage 里发{" "}
            <code className="font-mono text-ink-soft">/开启线下</code>
            。这一条关着的时候那条指令会回一句提示。
          </span>
        </span>
        <Switch
          checked={Boolean(off.enabled)}
          onChange={(v) => patch({ enabled: v })}
          label="允许这个角色开线下"
        />
      </label>

      {off.enabled && (
        <>
          {/* 线下预设 */}
          <div>
            <Field
              label="线下用哪份预设"
              hint="只列线下那一批 —— 线上预设选不进来，两批不串"
            >
              <select
                className={`${inputCls} ${staleRef ? "border-warn text-warn" : ""}`}
                value={off.presetRef ?? ""}
                onChange={(e) => patch({ presetRef: e.target.value })}
              >
                <option value="">
                  {presets.length
                    ? `（默认用第一份：${presetLabel(presets[0])}）`
                    : "（还没有线下预设）"}
                </option>
                {staleRef && <option value={off.presetRef}>⚠ 引用的线下预设已删除</option>}
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {presetLabel(p)} · 温度 {p.params?.temperature ?? 0.7}
                  </option>
                ))}
              </select>
            </Field>
            <p className="mt-1.5 flex flex-wrap items-start gap-x-1.5 gap-y-1 text-meta leading-relaxed text-ink-faint">
              {presetNote ? (
                <span className={staleRef ? "text-warn" : ""}>{presetNote}</span>
              ) : (
                <span>温度、Top P、最大 token 都在这份预设里调。</span>
              )}
              <button
                type="button"
                onClick={() => onGoto?.("preset")}
                className="text-ink hover:underline"
              >
                去「预设」面板
              </button>
            </p>
          </div>

          {/* 线下世界书。和线上那份是两套引用，global 的书两边都生效 */}
          <div className="grid grid-cols-1 gap-3 border-t border-line pt-6">
            <div>
              <p className="text-ui text-ink">线下额外挂的世界书</p>
              <p className="mt-0.5 text-meta leading-relaxed text-ink-faint">
                和上面「预设与世界书」里勾的那些
                <strong className="text-ink-soft">各算一套</strong>
                ：演剧情时只扫这里勾的 + 所有全局书。线上那批不带过来 ——
                线下要的设定（房间长什么样、桌上有什么）和线上聊天要的往往不是同一批。
              </p>
            </div>

            {own.length === 0 && globals.length === 0 && (
              <p className="text-meta leading-relaxed text-ink-faint">
                还没有世界书。
                <button
                  type="button"
                  onClick={() => onGoto?.("world")}
                  className="ml-1 text-ink hover:underline"
                >
                  去「世界书」面板建一本
                </button>
              </p>
            )}

            {own.length > 0 && (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {own.map((b) => {
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
                        <span className="block truncate text-ui text-ink">{worldBookLabel(b)}</span>
                        <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                          {(b.entries ?? []).length} 条
                          {b.enabled ? "" : " · 整本被关掉了"}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            )}

            {globals.length > 0 && (
              <p className="text-meta leading-relaxed text-ink-faint">
                另有 {globals.length} 本全局世界书线上线下都生效：
                {globals.map((b) => worldBookLabel(b)).join("、")}。
              </p>
            )}

            {deadRefs.length > 0 && (
              <p className="text-meta leading-relaxed text-warn">
                还挂着 {deadRefs.length} 本已经被删掉的世界书，这些引用不起作用。
              </p>
            )}
          </div>

          {/* 线下 API */}
          <div className="grid grid-cols-1 gap-6 border-t border-line pt-6">
            <Field
              label="线下用哪个模型"
              hint="留空 = 用上面「模型 → 聊天 API」那条，和线上同一个"
            >
              <ModelSelect
                category="chat"
                value={off.model}
                onChange={(ref) => patch({ model: { ...(off.model ?? {}), ...ref } })}
              />
            </Field>
            <p className="text-meta leading-relaxed text-ink-faint">
              演剧情和发短信要的不是一回事 —— 一个求长文和描写，一个求短句和口语。
              有人愿意在这儿单独换一个更能写的模型。挑的那个失效了（服务商删了、
              模型关了）也不会把线下堵死，会自动退回角色的聊天 API，只在日志里记一笔。
            </p>
          </div>

          {/* 上下文上限 */}
          <div className="grid grid-cols-1 gap-6 border-t border-line pt-6">
            <div>
              <p className="text-ui text-ink">上下文</p>
              <p className="mt-0.5 text-meta leading-relaxed text-ink-faint">
                线下一轮动辄上千字，演几十轮就能把上下文顶满。超出这个轮数的开头
                那几轮会
                <strong className="text-ink-soft">换成总结</strong>
                （有大总结用大总结，没有就用小总结），页面上收成一行、点开还能看
                原文。和「角色 · 上下文」里那个条数是
                <strong className="text-ink-soft">两套</strong>
                ，线下只认这一个。
              </p>
            </div>

            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              <NumberField
                label="最多带几轮原文"
                value={off.maxContext ?? 6}
                min={0}
                max={500}
                step={1}
                onChange={(v) => patch({ maxContext: v })}
                hint="1 轮 = 你一句 + 角色一句。0 = 不限制，整条剧情全发"
                suffix="轮"
              />
            </div>

            <p className="text-meta leading-relaxed text-ink-faint">
              切点只落在总结的边界上，所以实际带的原文会比这个数多一点（多不过一份
              小总结的跨度）。这样同一段不会既在总结里又在原文里白烧两遍，也不会有
              哪几轮既没进总结又被丢掉。一份总结都还没出的时候这条
              <strong className="text-ink-soft">不生效</strong>
              —— 宁可这一轮超出上限，也不能把还没总结过的剧情扔了。
            </p>
          </div>

          {/* 总结节奏 */}
          <div className="grid grid-cols-1 gap-6 border-t border-line pt-6">
            <div>
              <p className="text-ui text-ink">总结</p>
              <p className="mt-0.5 text-meta leading-relaxed text-ink-faint">
                剧情会演得很长，全塞进上下文迟早爆。攒够几轮就出一份小总结，小总结
                攒够几份再出一份大的。内容在「线下模式」分区里看得到，
                <strong className="text-ink-soft">可以自由改</strong>
                。点「结束当前线下模式」的时候，注进记忆库待总结的
                <strong className="text-ink-soft">只有这些总结</strong>
                ，原始的每一轮不进去。
              </p>
            </div>

            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              <NumberField
                label="小总结：每几轮出一份"
                value={off.smallEvery ?? 6}
                min={1}
                max={200}
                step={1}
                onChange={(v) => patch({ smallEvery: v })}
                hint="1 轮 = 你一句 + 角色一句"
                suffix="轮"
              />
              <Field label="小总结用哪个模型" hint="留空 = 用上面那个线下模型">
                <ModelSelect
                  category="chat"
                  value={off.smallModel}
                  onChange={(ref) => patch({ smallModel: { ...(off.smallModel ?? {}), ...ref } })}
                />
              </Field>
            </div>

            <label className="flex items-start justify-between gap-4">
              <span className="min-w-0">
                <span className="block text-ui text-ink">大总结</span>
                <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                  默认关。开了之后小总结攒够下面那个数就再压一层 ——
                  演上百轮的长剧情才用得上，短剧情开着只是多花一次生成。
                  结束线下的时候会
                  <strong className="text-ink-soft">补一次大总结</strong>
                  ，这一条关着也照补。
                </span>
              </span>
              <Switch
                checked={Boolean(off.bigEnabled)}
                onChange={(v) => patch({ bigEnabled: v })}
                label="启用大总结"
              />
            </label>

            {off.bigEnabled && (
              <div className="grid grid-cols-1 gap-6 border-l-2 border-line pl-4 sm:grid-cols-2">
                <NumberField
                  label="大总结：攒几份小总结出一份"
                  value={off.bigEvery ?? 8}
                  min={1}
                  max={100}
                  step={1}
                  onChange={(v) => patch({ bigEvery: v })}
                  suffix="份"
                />
                <Field label="大总结用哪个模型" hint="留空 = 用上面那个线下模型">
                  <ModelSelect
                    category="chat"
                    value={off.bigModel}
                    onChange={(ref) => patch({ bigModel: { ...(off.bigModel ?? {}), ...ref } })}
                  />
                </Field>
              </div>
            )}
          </div>

          {/* 用户选项 */}
          <div className="grid grid-cols-1 gap-3 border-t border-line pt-6">
            <label className="flex items-start justify-between gap-4">
              <span className="min-w-0">
                <span className="block text-ui text-ink">用户选项</span>
                <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                  每轮正文之后另给四条「我接下来可以怎么做」，
                  <strong className="text-ink-soft">可以复制，也可以直接点着发</strong>
                  。和角色本身的回复是<strong className="text-ink-soft">同一次生成</strong>
                  ，不额外花钱。iMessage 里走线下时这四条会切成四个气泡发出来。
                </span>
              </span>
              <Switch
                checked={Boolean(off.userChoice)}
                onChange={(v) => patch({ userChoice: v })}
                label="启用用户选项"
              />
            </label>

            {/* 两道闸串着：这个开关 + 线下预设里那条「用户选项」条目 */}
            {off.userChoice && preset && !choiceEntry && (
              <p className="border-l-2 border-warn py-1.5 pl-3 text-meta leading-relaxed text-warn">
                「{presetLabel(preset)}」里没有「用户选项」那条条目（可能是被删了），
                这个开关现在不起作用。
                <button
                  type="button"
                  onClick={() => onGoto?.("preset")}
                  className="link-slide ml-1 text-warn"
                >
                  去预设里看看
                </button>
              </p>
            )}
            {off.userChoice && choiceEntry && !choiceEntry.enabled && (
              <p className="border-l-2 border-warn py-1.5 pl-3 text-meta leading-relaxed text-warn">
                「{presetLabel(preset)}」里那条「用户选项」条目是关着的 ——
                两边都开才会生成选项。
                <button
                  type="button"
                  onClick={() => onGoto?.("preset")}
                  className="link-slide ml-1 text-warn"
                >
                  去预设里打开
                </button>
              </p>
            )}
          </div>

          {/* 线下语音 */}
          <div className="grid grid-cols-1 gap-3 border-t border-line pt-6">
            <label className="flex items-start justify-between gap-4">
              <span className="min-w-0">
                <span className="block text-ui text-ink">线下语音自动朗读</span>
                <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                  只有被
                  <code className="mx-1 bg-sunken px-1">「」</code>
                  括起来的台词会念 —— 中文引号（
                  <code className="mx-1 bg-sunken px-1">“”</code>）和别的标点一律不念，
                  所以台词一定要用日语那对括号。开着的时候每轮生成完自动念一遍；
                  关着也不碍事，每条「」右边都有个小播放键，
                  <strong className="text-ink-soft">点一下才生成</strong>，不点不花钱。
                </span>
              </span>
              <Switch
                checked={Boolean(off.autoVoice)}
                onChange={(v) => patch({ autoVoice: v })}
                label="线下语音自动朗读"
              />
            </label>
            <p className="text-meta leading-relaxed text-ink-faint">
              音色用的是这个角色「发语音」里那个
              <strong className="text-ink-soft">音色 ID</strong>
              {role.voiceSend?.voiceId ? (
                <>
                  （现在是{" "}
                  <code className="bg-sunken px-1 font-mono">
                    {role.voiceSend.voiceId}
                  </code>
                  ）
                </>
              ) : (
                <strong className="text-warn">（现在还没填，会用那家的默认音色）</strong>
              )}
              ，密钥同样是全局那份，在
              <button
                type="button"
                onClick={() => onGoto?.("api")}
                className="link-slide mx-1 text-ink"
              >
                连接 → 语音合成
              </button>
              里配。这条开关不看「发语音」开着没有 —— 演剧情时不发
              <code className="mx-1 bg-sunken px-1">[audio_message:…]</code>
              ，念的是剧情里「」那几句。
            </p>
          </div>

          {/* 两张头像 */}
          <div className="grid grid-cols-1 gap-6 border-t border-line pt-6">
            <div>
              <p className="text-ui text-ink">剧情里的头像</p>
              <p className="mt-0.5 text-meta leading-relaxed text-ink-faint">
                角色的气泡在左、你的在右，头像画在各自那一侧。不挑就显示名字的
                首字母。图片存在数据目录的 <span className="font-mono">offline/media/</span> 里，
                <strong className="text-ink-soft">不进备份包</strong> —— 换机器之后
                剧情一条不少，头像退回首字母。
              </p>
            </div>
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              <AvatarField
                label="角色头像"
                hint="靠左那一侧"
                file={off.avatar}
                fallback={roleLabel(role)}
                onChange={(file) => patch({ avatar: file })}
              />
              <AvatarField
                label="你的头像"
                hint="靠右那一侧"
                file={off.userAvatar}
                fallback={userName}
                onChange={(file) => patch({ userAvatar: file })}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 一边的城市输入框 + 解析结果。
 *
 * **必须定义在 RoleEnvFields 外面。** 定义在里面的话每次 render 都是一个
 * 新的函数、也就是一个新的组件类型，React 会把整棵子树卸载重建 —— 敲一个
 * 字触发 render，输入框当场被换成一个新的 DOM 节点，焦点丢了，第二个字
 * 就打不进去。粘贴看着能用是因为那是一次性事件，一下就填完了。
 *
 * @param {object|null} info preview.sides 里这一边的解析结果
 */
export function CityField({ label, hint, value, info, onChange }) {
  // 填了城市但后端没解析出来 → 标红。城市留空不算错
  const dead = Boolean(info?.city) && info?.resolved === null;
  const geo = info?.resolved;
  return (
    <div>
      <Field label={label} hint={hint}>
        <input
          className={`${inputCls} ${dead ? "border-warn text-warn" : ""}`}
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder="例如：南宁 / San Francisco / Tokyo"
        />
      </Field>
      {dead && (
        <p className="mt-1.5 flex items-start gap-1.5 text-meta leading-relaxed text-warn">
          没找到这个城市，这一边会退回服务器本地时区，也不带天气和当地节日。
        </p>
      )}
      {geo && (
        <p className="mt-1.5 text-meta leading-relaxed text-ink-faint">
          识别到 {geo.name} · {geo.tz || "（无时区，用服务器本地）"} · {geo.country || "—"}
        </p>
      )}
      {!geo && !dead && !value?.trim() && (
        <p className="mt-1.5 text-meta leading-relaxed text-ink-faint">
          留空 = 用服务器本地时区，只判周末、不带天气。
        </p>
      )}
    </div>
  );
}

/**
 * 角色「环境感知」那块：时间 + 天气。
 *
 * 单独拆出来的理由和 RolePresetFields 一样 —— RoleDetail 已经很长，
 * 而这块有自己的派生状态（城市解析结果、实时预览）。
 *
 * 预览那两行直接显示「这一刻会注入什么」，比写一段说明文字管用得多。
 * 两行是因为时间和天气**去处不同**：时间进存档，天气只进这一轮。
 */
export function RoleEnvFields({ role }) {
  const { config, savedConfig, updateRole, updateWeatherApi } = useConfig();
  const env = role.env ?? {};
  const time = env.time ?? {};
  const weather = env.weather ?? {};
  // api 这个名字被那个 fetch 帮手占了，所以叫 apiCfg
  const apiCfg = weather.api ?? {};
  const qw = apiCfg.qweather ?? {};
  const wa = apiCfg.weatherapi ?? {};
  // 同城 = 两个人在一个地方，只报一次时间、只查一次天气，charCity 不参与
  const same = time.mode === "same";
  // 密钥是全局的（草稿值），不在 role 里 —— 见 store.jsx 的 updateWeatherApi
  const keys = config.weatherApi ?? {};
  const qwKeys = keys.qweather ?? {};
  const waKeys = keys.weatherapi ?? {};
  /*
   * 「这一格存了没」不能问 preview.keys —— preview 是防抖 600ms 之后才回来的，
   * 而且密钥不进查询参数，保存前后发出去的 URL 一模一样，effect 不会重跑，
   * 于是 preview.keys 永远是旧的、横幅永远挂着。所以直接比草稿和「已落盘」
   * 那两份配置：这是本地同步的判断，点完保存立刻就对。
   */
  const savedKeys = savedConfig?.weatherApi ?? {};
  const blank = (v) => !String(v ?? "").trim();
  const unsaved = (v, savedV) => !blank(v) && String(v ?? "") !== String(savedV ?? "");
  /*
   * 填的这个 API Host 一看就不是域名吗？
   *
   * 实际踩到的坑：把**项目 ID 或 Key** 填进了 Host 那格。那种值没有点，
   * 请求直接 ENOTFOUND，后端静默退回 Open-Meteo，界面上什么都不说 ——
   * 表现就是「我明明配好了和风，还是看不到天气」。
   *
   * 判断和后端 env.js:badQwHost 是同一套（非空 + 去掉 https:// 和末尾斜杠
   * 之后不含点），保守到底：宁可漏报也不误报。这里判草稿值，敲字就能看到。
   */
  const badHost = (v) => {
    const h = String(v ?? "")
      .trim()
      .replace(/^https?:\/\//i, "")
      .replace(/\/+$/, "");
    return Boolean(h) && !h.includes(".");
  };
  const hostWrong = badHost(qwKeys.host);

  // 「查询中…」那行随预览一起删了，所以不再需要 loading 状态
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState("");

  // 嵌套 patch 在调用处浅合并 —— updateRole 本身只做一层
  const patchTime = (p) => updateRole(role.id, { env: { ...env, time: { ...time, ...p } } });
  const patchWeather = (p) =>
    updateRole(role.id, { env: { ...env, weather: { ...weather, ...p } } });
  const patchApi = (p) => patchWeather({ api: { ...apiCfg, ...p } });

  /*
   * 拉一次解析结果。城市和开关一变就重拉（联网查坐标+天气，所以防抖 600ms）。
   *
   * 「现在会注入什么」那两行预览已经删了，但这个请求还得发：城市解析成了哪个
   * 地方、时区缩写是什么、查不到时要标红、节假日数据覆盖到哪年，都从这儿来。
   *
   * 草稿值一起发过去 —— 意义就是「刚敲进去的这个城市查出来是什么」，
   * 要求先保存才能看就没意义了。后端拿这些覆盖已保存的那份。
   *
   * **密钥例外**：不进查询参数（不让它出现在 URL 和访问日志里），后端只从
   * 已保存的配置读。所以新填的密钥要先点保存才会用上。
   */
  useEffect(() => {
    if (time.enabled === false) {
      setPreview(null);
      setError("");
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      const q = new URLSearchParams({
        roleId: role.id,
        time: "1",
        mode: same ? "same" : "apart",
        userCity: time.userCity ?? "",
        charCity: time.charCity ?? "",
        workday: time.workday === false ? "0" : "1",
        weather: weather.enabled ? "1" : "0",
        range: weather.range ? "1" : "0",
        tomorrow: weather.tomorrow === false ? "0" : "1",
        wapi: apiCfg.enabled ? "1" : "0",
        qw: qw.enabled ? "1" : "0",
        qwAlerts: qw.alerts ? "1" : "0",
        wa: wa.enabled ? "1" : "0",
        waAlerts: wa.alerts ? "1" : "0",
      });
      api(`/api/env/preview?${q}`)
        .then((r) => {
          if (!alive) return;
          setPreview(r);
          setError("");
        })
        .catch((e) => alive && setError(e.message));
    }, 600);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [
    role.id,
    time.enabled,
    same,
    time.userCity,
    time.charCity,
    time.workday,
    weather.enabled,
    weather.range,
    weather.tomorrow,
    apiCfg.enabled,
    qw.enabled,
    qw.alerts,
    wa.enabled,
    wa.alerts,
    /*
     * 密钥本身不进 URL，所以这里盯的是**已落盘**的那几个值，不是草稿。
     *
     * 盯草稿是不行的：预览只从已保存的配置读密钥，草稿改了预览结果不会变，
     * 而点保存的那一刻草稿一个字节都没动 —— effect 不重跑，preview.keys
     * 永远停在保存前那一版，「有密钥还没保存」于是永远挂着。盯已落盘的
     * 那份正好相反：敲字不重拉（省一次联网），保存那一刻重拉一次。
     */
    savedKeys.qweather?.host,
    savedKeys.qweather?.key,
    savedKeys.weatherapi?.key,
  ]);

  const overYear = new Date().getFullYear() > (preview?.holidayDataUntil ?? 2026);
  /*
   * 天气要联网按坐标查，没有城市就没有坐标 —— 开关开着也一样查不到。
   * 同城模式只看那一格（charCity 在这个模式下不参与计算），所以判断也得跟着变，
   * 否则同城 + 只填了「所在城市」时会误报一句「两个城市都空着」。
   */
  const noCity = same
    ? !String(time.userCity ?? "").trim()
    : !String(time.userCity ?? "").trim() && !String(time.charCity ?? "").trim();

  return (
    <div className="grid grid-cols-1 gap-6">
      {/* 时间 */}
      <label className="flex items-start justify-between gap-4">
        <span className="min-w-0">
          <span className="block text-ui text-ink">时间感知</span>
          <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
            在对方每条消息开头加一段方括号前缀，告诉模型现在几点、今天什么日子。
            前缀会跟着消息一起进存档，所以每条历史消息都自带它当时的时间戳 ——
            模型能看出「三天前那句是周日中午说的」。下面选同城还是异地。
          </span>
        </span>
        <Switch
          checked={time.enabled !== false}
          onChange={(v) => patchTime({ enabled: v })}
          label="启用时间感知"
        />
      </label>

      {time.enabled !== false && (
        <>
          {/*
            同城 / 异地。两个人在一个地方的话，「发送时间」和「收到时间」是
            同一个时刻，报两遍是纯粹的噪音，还要多花约一半 token。所以这不是
            一个显示偏好，而是决定前缀形状的开关。
          */}
          <Field label="两个人在哪" hint="决定前缀里报几个时间">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {[
                {
                  value: "same",
                  label: "同城模式",
                  desc: "在一个地方，只报一次时间：[时间 : 2026-09-08 03:38:29 | 周二, 工作日]",
                },
                {
                  value: "apart",
                  label: "异地模式",
                  desc: "分处两地，发送 / 收到各报一次、各带时区缩写和当地节日",
                },
              ].map((s) => (
                <button
                  key={s.value}
                  type="button"
                  onClick={() => patchTime({ mode: s.value })}
                  className={`border p-3.5 text-left transition-colors duration-150 ${
                    (s.value === "same") === same
                      ? "border-ink bg-sunken"
                      : "border-line bg-paper hover:bg-sunken"
                  }`}
                >
                  <span className="flex items-center gap-2 text-ui text-ink">
                    <Users
                      size={15}
                      className={(s.value === "same") === same ? "text-ink" : "text-ink-faint"}
                    />
                    {s.label}
                  </span>
                  <span className="mt-1 block break-all text-meta leading-snug text-ink-faint">
                    {s.desc}
                  </span>
                </button>
              ))}
            </div>
          </Field>

          <div className={`grid grid-cols-1 gap-6 ${same ? "" : "sm:grid-cols-2"}`}>
            <CityField
              label={same ? "所在城市" : "对方所在城市"}
              hint={same ? "两个人共用这一个" : "{{user}} 那一边"}
              info={preview?.sides?.user}
              value={time.userCity}
              onChange={(v) => patchTime({ userCity: v })}
            />
            {/*
              同城模式下这一格整个藏起来，不是禁用 —— 留一个填了也不生效的
              输入框，比没有这个框更让人困惑。切回异地时里面的值还在（草稿
              没被清掉），不用重新填。
            */}
            {!same && (
              <CityField
                label="角色所在城市"
                hint="{{char}} 那一边"
                info={preview?.sides?.char}
                value={time.charCity}
                onChange={(v) => patchTime({ charCity: v })}
              />
            )}
          </div>

          <label className="flex items-start justify-between gap-4">
            <span className="min-w-0">
              <span className="block text-ui text-ink">工作日与节假日感知</span>
              <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                按各自所在国判 —— 中国那边过春节的同一天，旧金山那边照常上班。
                中国用法定假期表，能区分放假和调休补班；其他国家用各国的公共假日表。
              </span>
            </span>
            <Switch
              checked={time.workday !== false}
              onChange={(v) => patchTime({ workday: v })}
              label="启用节假日感知"
            />
          </label>

          {time.workday !== false && (
            <p
              className={`text-meta leading-relaxed ${overYear ? "text-warn" : "text-ink-faint"}`}
            >
              中国法定假期数据覆盖到 {preview?.holidayDataUntil ?? 2026} 年底
              {overYear
                ? " —— 已经超出范围了，现在只报工作日/休息日，不会说出节日名（宁可少说也不说错）。升级依赖可以拿到新数据。"
                : "。超出范围后会自动只报工作日/休息日，不会把春节说成工作日。"}
            </p>
          )}

          {/* 天气 */}
          <label className="flex items-start justify-between gap-4 border-t border-line pt-6">
            <span className="min-w-0">
              <span className="block text-ui text-ink">天气感知</span>
              <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                在前缀后面再加{same ? "当地" : "两地"}的天气。要联网查，缓存 2 小时；查不到就只剩时间那部分，
                不会拖慢回复。天气<strong className="text-ink-soft">不进存档</strong> ——
                它只对「现在」有意义，只并进这一轮发给模型的最新那条消息。
              </span>
            </span>
            <Switch
              checked={Boolean(weather.enabled)}
              onChange={(v) => patchWeather({ enabled: v })}
              label="启用天气感知"
            />
          </label>

          {weather.enabled && (
            <>
              {/*
                天气按坐标查，坐标从城市名地理编码来 —— 城市空着的话开关开了
                也永远查不到，而且后端是静默省略的（天气是锦上添花，不该为它
                报错）。所以这里必须明说，否则表现就是「我开了天气，模型说它
                看不到天气」。
              */}
              {noCity && (
                <p className="flex items-start gap-1.5 text-meta leading-relaxed text-warn">
                  {same ? "上面那个城市还空着" : "上面两个城市都还空着"} —— 天气要按城市查坐标，所以这个开关现在
                  <strong>不会生效</strong>，前缀里只有时间。
                  {same ? "把城市填上。" : "至少填一个城市。"}
                </p>
              )}
              <label className="flex items-start justify-between gap-4">
                <span className="min-w-0">
                  <span className="block text-ui text-ink">最高 / 最低温度</span>
                  <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                    当前温度后面加一个今日区间：<code>晴 25.9°C (24.1~32.4°C)</code>。
                    关掉就只有当前温度，明日预报也只报最高温。
                  </span>
                </span>
                <Switch
                  checked={Boolean(weather.range)}
                  onChange={(v) => patchWeather({ range: v })}
                  label="启用温度区间"
                />
              </label>

              <label className="flex items-start justify-between gap-4">
                <span className="min-w-0">
                  <span className="block text-ui text-ink">明日天气预报</span>
                  <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                    多带一段 <code>| 明日预报: 雷阵雨 25.8~32.0°C</code>，
                    模型可以顺着聊「明天要下雨记得带伞」。
                  </span>
                </span>
                <Switch
                  checked={weather.tomorrow !== false}
                  onChange={(v) => patchWeather({ tomorrow: v })}
                  label="启用明日预报"
                />
              </label>

              <label className="flex items-start justify-between gap-4">
                <span className="min-w-0">
                  <span className="block text-ui text-ink">启用天气 API</span>
                  <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                    {apiCfg.enabled
                      ? "按城市所在国自动分派：国家码是 CN 的那边走和风天气，其他走 WeatherAPI。哪边没开或密钥没填齐，那一边就退回 Open-Meteo。"
                      : "关着 = 用 Open-Meteo（免费、无需密钥、无气象灾害预警）。打开后可以换成官方数据源，并拿到灾害预警。"}
                  </span>
                </span>
                <Switch
                  checked={Boolean(apiCfg.enabled)}
                  onChange={(v) => patchApi({ enabled: v })}
                  label="启用天气 API"
                />
              </label>

              {apiCfg.enabled && (
                <div className="grid grid-cols-1 gap-5 border border-line bg-paper px-4 py-4">
                  {/* 国内 */}
                  <label className="flex items-start justify-between gap-4">
                    <span className="min-w-0">
                      <span className="block text-ui text-ink">
                        国内天气 API · 和风天气
                      </span>
                      <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                        用于国家码是 CN 的那一边。免费额度 5 万次/月（天气和预警共用）。
                      </span>
                    </span>
                    <Switch
                      checked={Boolean(qw.enabled)}
                      onChange={(v) => patchApi({ qweather: { ...qw, enabled: v } })}
                      label="启用和风天气"
                    />
                  </label>

                  {qw.enabled && (
                    <div className="grid grid-cols-1 gap-4 border-l-2 border-line pl-4">
                      <div>
                        <Field label="API Host" hint="每个账号一个，不是公共域名">
                          <input
                            className={`${inputCls} ${
                              blank(qwKeys.host) || hostWrong ? "border-warn text-warn" : ""
                            }`}
                            value={qwKeys.host ?? ""}
                            onChange={(e) =>
                              updateWeatherApi({ qweather: { ...qwKeys, host: e.target.value } })
                            }
                            placeholder="h2a9cf3mhs.xy.qweatherapi.com"
                          />
                        </Field>
                        {hostWrong ? (
                          <p className="mt-1.5 flex items-start gap-1.5 text-meta leading-relaxed text-warn">
                            这个值不像域名（一个点都没有）—— 最常见的错就是把
                            <strong>API Key 或项目 ID</strong>填进了这一格。
                            要填的是形如 <code>h2a9cf3mhs.xy.qweatherapi.com</code> 的地址，在
                            console.qweather.com/setting 里复制「API Host」。现在这样和风一边会
                            <strong>整个退回 Open-Meteo</strong>（没有灾害预警）。
                          </p>
                        ) : (
                          <p className="mt-1.5 text-meta leading-relaxed text-ink-faint">
                            在 console.qweather.com/setting 里复制「API Host」。
                            公共域名（api.qweather.com 之类）从 2026 年起陆续停服，填了也没用。
                          </p>
                        )}
                      </div>
                      <Field label="API Key" hint="控制台里创建的凭据">
                        <input
                          className={`${inputCls} ${
                            blank(qwKeys.key) ? "border-warn text-warn" : ""
                          }`}
                          value={qwKeys.key ?? ""}
                          onChange={(e) =>
                            updateWeatherApi({ qweather: { ...qwKeys, key: e.target.value } })
                          }
                          placeholder="填你自己的 API Key"
                        />
                      </Field>
                      <label className="flex items-start justify-between gap-4">
                        <span className="min-w-0">
                          <span className="block text-ui text-ink">
                            气象灾害预警
                          </span>
                          <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                            中国气象局官方发布的极端天气预警，前缀里加一段
                            <code> | ⚠ 暴雨橙色预警</code>。同时挂多条时最多带 2 条。
                          </span>
                        </span>
                        <Switch
                          checked={Boolean(qw.alerts)}
                          onChange={(v) => patchApi({ qweather: { ...qw, alerts: v } })}
                          label="启用国内气象灾害预警"
                        />
                      </label>
                    </div>
                  )}

                  {/* 国外 */}
                  <label className="flex items-start justify-between gap-4 border-t border-line pt-5">
                    <span className="min-w-0">
                      <span className="block text-ui text-ink">
                        国外天气 API · WeatherAPI
                      </span>
                      <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                        用于国家码不是 CN 的那一边。地址内置，只要填密钥。免费额度 10 万次/月。
                      </span>
                    </span>
                    <Switch
                      checked={Boolean(wa.enabled)}
                      onChange={(v) => patchApi({ weatherapi: { ...wa, enabled: v } })}
                      label="启用 WeatherAPI"
                    />
                  </label>

                  {wa.enabled && (
                    <div className="grid grid-cols-1 gap-4 border-l-2 border-line pl-4">
                      <div>
                        <Field label="API Key" hint="weatherapi.com 注册后在后台看">
                          <input
                            className={`${inputCls} ${
                              blank(waKeys.key) ? "border-warn text-warn" : ""
                            }`}
                            value={waKeys.key ?? ""}
                            onChange={(e) =>
                              updateWeatherApi({ weatherapi: { key: e.target.value } })
                            }
                            placeholder="填你自己的 API Key"
                          />
                        </Field>
                        <p className="mt-1.5 text-meta leading-relaxed text-ink-faint">
                          地址是内置的 api.weatherapi.com/v1，不用填。
                        </p>
                      </div>
                      <label className="flex items-start justify-between gap-4">
                        <span className="min-w-0">
                          <span className="block text-ui text-ink">
                            气象灾害预警
                          </span>
                          <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                            当地气象机构发布的预警。<strong className="text-ink-soft">
                            免费版的预警覆盖是 Limited</strong>，很多地区查出来是空的 ——
                            查不到就整段省略，不影响别的部分。
                          </span>
                        </span>
                        <Switch
                          checked={Boolean(wa.alerts)}
                          onChange={(v) => patchApi({ weatherapi: { ...wa, alerts: v } })}
                          label="启用国外气象灾害预警"
                        />
                      </label>
                    </div>
                  )}

                  <p className="flex items-start gap-1.5 border-t border-line pt-5 text-meta leading-relaxed text-ink-faint">
                    这两份密钥是<strong className="text-ink-soft">全局的，所有角色共用</strong>，
                    存在 data/data.config.json 里。密钥不走预览接口的查询参数（不让它出现在 URL
                    和访问日志里），所以<strong className="text-ink-soft">改完要先点保存</strong>，
                    下面的预览才会用上新密钥。
                  </p>

                  {(unsaved(qwKeys.host, savedKeys.qweather?.host) ||
                    unsaved(qwKeys.key, savedKeys.qweather?.key) ||
                    unsaved(waKeys.key, savedKeys.weatherapi?.key)) && (
                    <p className="flex items-start gap-1.5 text-meta leading-relaxed text-warn">
                      有密钥还没保存，下面的预览暂时还在用旧的（或者退回 Open-Meteo）。
                    </p>
                  )}
                </div>
              )}
            </>
          )}

          {/*
            「现在会注入什么」那两行预览删掉了（用户不要）。
            /api/env/preview 那个请求还在发 —— 上面的城市解析结果、时区缩写、
            查不到时的标红，以及节假日数据覆盖到哪年都靠它，不是只为了预览。
          */}
          {error && (
            <p className="flex items-start gap-1.5 text-meta leading-relaxed text-warn">
              {error}
            </p>
          )}

          {/* token 成本 */}
          <p className="flex items-start gap-1.5 text-meta leading-relaxed text-ink-faint">
            算 token：时间那段每条消息都带、而且进存档，约 {same ? 28 : 55}/轮 ×{""}
            {role.maxContext ?? 20} 条上文 ≈ {(role.maxContext ?? 20) * (same ? 28 : 55)} token 的常驻占用
            {same ? "（同城只报一个时间，比异地省一半）" : "（同城模式只报一个时间，能省一半）"}。
            天气那段约 {same ? 30 : 60} token，但<strong className="text-ink-soft">只算一轮</strong> ——
            它不进存档，所以开了天气也就多这么点，不会乘上文条数
            {weather.enabled
              ? `（比进存档那种做法省了约 ${((role.maxContext ?? 20) - 1) * (same ? 30 : 60)} token）`
              : ""}。
          </p>
        </>
      )}
    </div>
  );
}

/** 角色详情：折叠的人设 + 折叠的单独配置 + 绑定项目。 */
export function RoleDetail({ role, onBack, onGoto, bridge }) {
  const { config, updateRole, removeRole, bindProject } = useConfig();
  const [applying, setApplying] = useState(false);
  const patch = (p) => updateRole(role.id, p);

  const projects = config.projects ?? [];
  const bound = projects.find((p) => p.id === role.projectRef) ?? null;
  const blocked = roleBlockReason(config, role);
  // 别人已经占了的项目不给选，避免存盘后被后端置空、看着像没生效
  const takenBy = new Map(
    (config.roles ?? [])
      .filter((r) => r.id !== role.id && r.projectRef)
      .map((r) => [r.projectRef, r])
  );

  // 名字和上下文都在侧栏显示了，这行只报「在线 / 离线 / 拦着」和用哪个模型
  const conn = bound ? bridge?.byProject?.[bound.id] : null;
  const online = conn?.status === "connected";
  const chat = describeRef(config, role.chatModel);

  function drop() {
    removeRole(role.id);
    onBack();
  }

  const fb = role.fallbackModel ?? {};
  const vis = role.visionModel ?? {};
  const aud = role.audioModel ?? {};
  const vid = role.videoModel ?? {};
  const doc = role.fileRead ?? {};

  /*
   * 下面这一堆算的是每个折叠栏标题右边那行小字。
   *
   * 每一栏默认都折着，这排小字就是整个角色的配置概览 —— 不展开也知道哪一栏
   * 开着、配的是什么，要改哪个直接点哪个。没有它的话「找一项设置」就得挨个
   * 点开再折回去，正是之前那一大坨最烦人的地方。
   */
  const onOff = (v) => (v ? "开" : "关");
  const modelBadge = [
    chat.text,
    fb.enabled && "副 API",
    vis.enabled && "识图",
    aud.enabled && "听音",
    vid.enabled && "看视频",
    doc.enabled !== false && "读文件",
  ]
    .filter(Boolean)
    .join(" · ");
  const preset = resolvePreset(config, role);
  const books = config.worldBooks ?? [];
  // 真能发到这个角色身上的书 = 自己勾的（书还在的）+ 所有全局书
  const bookCount =
    (role.worldBookRefs ?? []).filter((id) => books.some((b) => b.id === id)).length +
    books.filter((b) => b.global).length;
  const env = role.env ?? {};
  // 时间是默认开的（!== false），天气是默认关的 —— 判据和 RoleEnvFields 里一致
  const envBadge =
    [env.time?.enabled !== false && "时间", env.weather?.enabled && "天气"]
      .filter(Boolean)
      .join(" · ") || "全关";
  const ss = role.stickerSend ?? {};
  const banned = (ss.blacklist ?? []).length;
  const stickerBadge = ss.enabled ? (banned ? `开 · 禁 ${banned} 个标签` : "开") : "关";
  const lor = role.leaveOnRead ?? {};
  const lorBadge =
    [lor.receipt && "已读回执", lor.enabled && "已读不回"].filter(Boolean).join(" · ") || "关";
  const us = role.undoSend ?? {};
  const undoBadge =
    [us.enabled && "自己撤回", us.seeUser && `看见对方撤回 ${us.chance ?? 50}%`]
      .filter(Boolean)
      .join(" · ") || "关";
  const mem = role.memories ?? {};
  const memOn = [mem.memory?.enabled, mem.memo?.enabled, mem.diary?.enabled].filter(Boolean).length;
  const bgOn = Boolean(role.chatBackground?.enabled);
  // 回应和特效都是白名单：开着但一个都没勾 = 模型其实用不了，得在折起来的时候
  // 就看出来，不然会以为配好了
  const rs = role.reactSend ?? {};
  const reactPicked = (rs.emojis ?? []).length;
  const reactBadge = rs.enabled
    ? reactPicked
      ? `开 · ${reactPicked} 个 emoji`
      : "开 · 没勾（只收不发）"
    : "关";
  const es = role.effectSend ?? {};
  const effectPicked = (es.effects ?? []).length;
  const effectBadge = es.enabled
    ? effectPicked
      ? `开 · ${effectPicked} 个特效`
      : "开 · 没勾"
    : "关";
  const igCfg = role.instagram ?? {};
  const igWin = igCfg.replyWindow ?? {};
  const igPeers = (igCfg.peers ?? []).length;
  // 折起来时最该知道的是「它会不会自己产内容」和「隔多久才来动一下」——
  // 这两件事决定了你发完一条之后会等来什么
  const igBadge = igCfg.enabled
    ? [
        igCfg.autoPublish ? "自己发帖" : "只点赞评论",
        `${igWin.minMinutes ?? 30}-${igWin.maxMinutes ?? 120} 分钟`,
        igPeers ? `联动 ${igPeers} 个角色` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "关";
  const pro = role.proactive ?? {};
  // 开着的时候这行要能一眼看出「多久会自己开口」和「几点到几点不会」——
  // 这一栏和 Instagram 是仅有的两个会在你不看着的时候自己动的，折起来也得说清楚
  const proBadge = pro.enabled
    ? [
        pro.mode === "auto"
          ? "自主判断"
          : `随机 ${pro.random?.minHours ?? 1}-${pro.random?.maxHours ?? 3} 小时`,
        pro.focus?.enabled !== false &&
          `勿扰 ${pro.focus?.start ?? "00:00"}-${pro.focus?.end ?? "08:00"}`,
      ]
        .filter(Boolean)
        .join(" · ")
    : "关";
  // 协助模式默认开，所以徽标要能一眼分出「没动过」和「特地关掉了」
  const pa = role.promptAssist ?? {};
  const assistBadge =
    pa.enabled === false ? "关" : pa.useOwnModel ? "开 · 独立 API" : "开 · 跟随聊天 API";
  /*
   * 线下这行徽标要报的是「允许了吗」和「拿哪份预设演」——「现在开着吗」不在
   * 配置里（在 data/offline/index/ 那份索引里，见 config.js:normalizeOffline），
   * 这一页读不到，所以别在这儿写「开着」，会骗人。
   */
  const off = role.offline ?? {};
  const offPreset = off.enabled ? resolvePreset(config, role, "offline") : null;
  const offBadge = off.enabled
    ? [
        offPreset ? presetLabel(offPreset) : "还没有线下预设",
        `小总结 ${off.smallEvery ?? 6} 轮`,
        off.bigEnabled ? `大总结 ${off.bigEvery ?? 8} 份` : null,
        off.userChoice ? "用户选项" : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "关";

  return (
    <div className="grid grid-cols-1 gap-rhythm-sm lg:gap-rhythm">
      {/* 状态行：一眼看出这个角色现在能不能收消息 */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line pb-4 text-meta">
        <span className="flex items-center gap-2">
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              online ? "bg-good" : blocked ? "bg-warn" : "bg-ink-meta"
            }`}
          />
          <span className={online ? "text-good" : blocked ? "text-warn" : "text-ink-faint"}>
            {online ? "在线" : blocked ? "未上线" : "离线"}
          </span>
        </span>
        <span className="font-mono text-ink-faint">
          {bound?.linePhone || (bound ? "号码还没登记" : "未绑定项目")}
        </span>
        <span className={chat.ok ? "text-ink-faint" : "text-warn"}>聊天：{chat.text}</span>
        <span className="text-ink-faint">上文 {role.maxContext} 条</span>
      </div>

      {/*
        剩下的全拆成一摞折叠栏，一件事一栏。

        以前是「单独配置」一个大折叠里塞十三段，展开就是一屏滚不到头 —— 想改个
        表情包设置得从头翻到尾（用户原话：「我要配置一些东西的时候很难找到相关配置」）。
        现在标题右边写着这一栏眼下什么状态，全折着也能一眼扫完，要改哪个点哪个。

        这层容器**不留 gap**：每个 Fold 自己画上边框，留了间距边框之间会浮出空隙。
      */}
      <div className="grid grid-cols-1">
        {/* 一、角色提示词 */}
        <Fold
          title="角色提示词"
          desc="这个角色是谁 —— 名字和性格设定"
          badge={role.description?.trim() ? `${role.description.trim().length} 字` : "空"}
        >
          <div className="grid grid-cols-1 gap-6">
            <Field label="角色名称" hint="会话 ID 的前缀，也是 {{char}} 的值">
              <input
                className={inputCls}
                value={role.name}
                onChange={(e) => patch({ name: e.target.value })}
                placeholder="例如：小林，一名温柔的咖啡馆主理人"
              />
            </Field>
            <Field
              label="角色内容"
              hint="性格、说话风格、背景知识，支持多行。这段原样注入 <Character> 标签 —— 想让模型知道自己叫什么，正文里写一句 {{char}}"
            >
              <textarea
                className={`${inputCls} min-h-[180px] resize-y leading-relaxed`}
                value={role.description}
                onChange={(e) => patch({ description: e.target.value })}
                placeholder="描述角色的性格、说话风格、背景知识…"
              />
            </Field>
            <VarHint role={role} onGoto={onGoto} />
          </div>
        </Fold>

        {/* 二、模型：聊天 / 副 / 识图 / 听音。四个都只能从「连接」面板已配好的里挑 */}
        <Fold
          title="模型"
          desc="用哪个模型说话、报错了退到哪个、对方发图发语音谁来看谁来听"
          badge={modelBadge}
        >
          <div className="grid grid-cols-1 gap-8">
            {/* 聊天 API */}
            <div className="grid grid-cols-1 gap-6">
              <p className="text-ui text-ink">聊天 API</p>
              <Field label="模型" hint="标了「聊天」分类的才会出现在这里">
                <ModelSelect
                  category="chat"
                  value={role.chatModel}
                  onChange={(ref) => patch({ chatModel: { ...role.chatModel, ...ref } })}
                />
              </Field>
            </div>

            {/* 副 API */}
            <div className="grid grid-cols-1 gap-6 border-t border-line pt-6">
              <label className="flex items-start justify-between gap-4">
                <span className="min-w-0">
                  <span className="block text-ui text-ink">副 API</span>
                  <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                    主 API 报错时自动改用它。以前是全局一份，现在每个角色各配一个。
                  </span>
                </span>
                <Switch
                  checked={Boolean(fb.enabled)}
                  onChange={(v) => patch({ fallbackModel: { ...fb, enabled: v } })}
                  label="启用副 API"
                />
              </label>
              {fb.enabled && (
                <Field label="模型">
                  <ModelSelect
                    category="chat"
                    value={fb}
                    onChange={(ref) => patch({ fallbackModel: { ...fb, ...ref } })}
                  />
                </Field>
              )}
            </div>

            {/* 识图 API */}
            <div className="grid grid-cols-1 gap-6 border-t border-line pt-6">
              <label className="flex items-start justify-between gap-4">
                <span className="min-w-0">
                  <span className="block text-ui text-ink">识图 API</span>
                  <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                    对方发图时先让它看一眼，再把描述交给聊天模型。
                  </span>
                </span>
                <Switch
                  checked={Boolean(vis.enabled)}
                  onChange={(v) => patch({ visionModel: { ...vis, enabled: v } })}
                  label="启用识图"
                />
              </label>
              {vis.enabled && (
                <>
                  <Field label="模型" hint="标了「识图」分类的才会出现在这里；提示词在「连接」面板里按模型配">
                    <ModelSelect
                      category="vision"
                      value={vis}
                      onChange={(ref) => patch({ visionModel: { ...vis, ...ref } })}
                    />
                  </Field>
                  <NumberField
                    label="单轮最多识别"
                    value={vis.maxImages ?? 3}
                    min={1}
                    max={10}
                    step={1}
                    onChange={(v) => patch({ visionModel: { ...vis, maxImages: v } })}
                    hint="一条消息里带多张图时只看前 N 张"
                    suffix="张"
                  />
                </>
              )}
            </div>

            {/* 听音 API */}
            <div className="grid grid-cols-1 gap-6 border-t border-line pt-6">
              <label className="flex items-start justify-between gap-4">
                <span className="min-w-0">
                  <span className="block text-ui text-ink">语音识别 API</span>
                  <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                    对方发语音条时先让它听一遍，再把内容交给聊天模型。
                  </span>
                </span>
                <Switch
                  checked={Boolean(aud.enabled)}
                  onChange={(v) => patch({ audioModel: { ...aud, enabled: v } })}
                  label="启用语音识别"
                />
              </label>
              {aud.enabled && (
                <>
                  <Field
                    label="模型"
                    hint="标了「听音」分类的才会出现在这里。走的是 Gemini 原生接口，只有 Gemini 系的模型听得到"
                  >
                    <ModelSelect
                      category="audio"
                      value={aud}
                      onChange={(ref) => patch({ audioModel: { ...aud, ...ref } })}
                    />
                  </Field>
                  <label className="flex items-start justify-between gap-4">
                    <span className="min-w-0">
                      <span className="block text-ui text-ink">识别情绪与环境音</span>
                      <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                        关着只转写成文字；打开会连语气、背景声、说话人数一起报给聊天模型，
                        更贵也更慢。在「连接」面板给这个模型单独写了提示词的话，这个开关就不起作用了。
                      </span>
                    </span>
                    <Switch
                      checked={Boolean(aud.emotion)}
                      onChange={(v) => patch({ audioModel: { ...aud, emotion: v } })}
                      label="识别情绪与环境音"
                    />
                  </label>
                  <NumberField
                    label="单轮最多识别"
                    value={aud.maxClips ?? 2}
                    min={1}
                    max={10}
                    step={1}
                    onChange={(v) => patch({ audioModel: { ...aud, maxClips: v } })}
                    hint="一轮里连发好几条语音时只听前 N 条"
                    suffix="条"
                  />
                </>
              )}
            </div>

            {/*
              * 看视频 API。挨着听音放，因为走的是**同一条** Gemini 原生接口、
              * 同一个请求形状，只有 mime 不同。
              *
              * 但两个提示写得不一样，因为用户要当心的事不一样：听音那边的坑是
              * 「非 Gemini 的模型听不到」，看视频这边还多一条「中转站可能吃不下」——
              * 实测五家里有一家网关连 12MB 都直接 413，而它听语音是好的。所以这里
              * 的提示里要写清 20MB 那道闸和「先去连接面板试一下」。
              */}
            <div className="grid grid-cols-1 gap-6 border-t border-line pt-6">
              <label className="flex items-start justify-between gap-4">
                <span className="min-w-0">
                  <span className="block text-ui text-ink">视频识别 API</span>
                  <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                    对方发视频时先让它看一遍（画面、动作、里面的说话声），再把描述交给聊天模型。
                  </span>
                </span>
                <Switch
                  checked={Boolean(vid.enabled)}
                  onChange={(v) => patch({ videoModel: { ...vid, enabled: v } })}
                  label="启用视频识别"
                />
              </label>
              {vid.enabled && (
                <>
                  <Field
                    label="模型"
                    hint="标了「看视频」分类的才会出现在这里。和听音同一条 Gemini 原生接口，只有 Gemini 系的模型看得到"
                  >
                    <ModelSelect
                      category="video"
                      value={vid}
                      onChange={(ref) => patch({ videoModel: { ...vid, ...ref } })}
                    />
                  </Field>
                  <NumberField
                    label="单轮最多识别"
                    value={vid.maxClips ?? 1}
                    min={1}
                    max={5}
                    step={1}
                    onChange={(v) => patch({ videoModel: { ...vid, maxClips: v } })}
                    hint="一轮里连发好几段视频时只看前 N 段。一段视频的用量比一条语音大一个量级，上传本身也要几十秒，所以默认只看 1 段"
                    suffix="段"
                  />
                  <p className="text-meta leading-relaxed text-ink-faint">
                    超过 20MB 的视频不会下载，只会告诉角色「对方发了段视频但你看不到」。
                    体积上限卡在这里是因为中转站那层拒不拒跟家数强相关 ——
                    实测有的网关连 12MB 都直接拒。先去「连接」面板用「试一下」传一段看看这家行不行。
                  </p>
                </>
              )}
            </div>

            {/*
              * 读文件。摆在识图 / 听音 / 看视频后面是因为是同一类事（把附件变成
              * 模型看得懂的东西），但它**不打模型**：解压 docx、抽 pdf 的文本流
              * 全是本地计算，不花钱，所以默认开、也没有「模型」那一栏
              */}
            <div className="grid grid-cols-1 gap-6 border-t border-line pt-6">
              <label className="flex items-start justify-between gap-4">
                <span className="min-w-0">
                  <span className="block text-ui text-ink">读文件</span>
                  <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                    对方发来 txt / md / json / docx / pdf 时把正文读出来，当成一段文字交给聊天模型。
                    本地解析，不额外花钱。扫描版 PDF（整页都是图）读不出文字。
                  </span>
                </span>
                <Switch
                  checked={doc.enabled !== false}
                  onChange={(v) => patch({ fileRead: { ...doc, enabled: v } })}
                  label="启用读文件"
                />
              </label>
              {doc.enabled !== false && (
                <NumberField
                  label="单个文件最多读"
                  value={doc.maxChars ?? 2000}
                  min={100}
                  max={20000}
                  step={100}
                  onChange={(v) => patch({ fileRead: { ...doc, maxChars: v } })}
                  hint="超出的部分不进提示词，会在末尾告诉模型「后面还有」。调太大会明显推高每轮的 token"
                  suffix="字"
                />
              )}
            </div>
          </div>
        </Fold>

        {/* 三、上下文 */}
        <Fold
          title="上下文"
          desc="每轮带多少上文"
          badge={`上文 ${role.maxContext} 条`}
        >
          <div className="grid grid-cols-1 gap-6">
            <div>
              <p className="text-ui text-ink">上下文限制</p>
              <p className="mt-0.5 text-meta leading-relaxed text-ink-faint">
                这个角色每轮带多少上文。带得越多 token 越贵，内存里也压着越多 —— 小 VPS
                上尤其要收着点。超过上限就丢掉最旧的几条；完整的对话存档在「上下文」面板里，一条不会少。
              </p>
            </div>
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              <NumberField
                label="上下文条数"
                value={role.maxContext}
                min={1}
                max={100}
                step={1}
                onChange={(v) => patch({ maxContext: v })}
                hint="每次发给模型的上文数"
                suffix="条"
              />
              <NumberField
                label="到达上限后丢弃"
                value={role.dropCount}
                min={1}
                max={role.maxContext}
                step={1}
                onChange={(v) => patch({ dropCount: v })}
                hint="丢弃最旧的 N 条"
                suffix="条"
              />
            </div>
          </div>
        </Fold>

        {/* 四、预设与世界书 */}
        <Fold
          title="预设与世界书"
          desc="提示词怎么拼、温度这些生成参数从哪儿来、带哪几本设定"
          badge={`${preset ? presetLabel(preset) : "还没有预设"}${
            bookCount ? ` · ${bookCount} 本书` : ""
          }`}
        >
          <RolePresetFields role={role} onGoto={onGoto} />
        </Fold>

        {/*
          五、线下模式。紧挨着上面那栏放，因为它里头就是**第二套**预设 + 世界书
          + API：读完上面这栏再看这栏，「两套各算一套」不用解释也明白。

          它和下面那十几栏的关系是互斥不是叠加 —— 线下一开，那些全停。
        */}
        <Fold
          title="线下模式"
          desc="坐下来演一段剧情，不是发短信。开着的时候这个角色的线上功能全部停用"
          badge={offBadge}
        >
          <RoleOfflineFields role={role} onGoto={onGoto} />
        </Fold>

        {/* 六、环境感知：时间 + 天气 */}
        <Fold title="环境感知" desc="每轮告诉模型现在几点、外面什么天气" badge={envBadge}>
          <RoleEnvFields role={role} />
        </Fold>

        {/*
          七 ~ 十六：十个要预设配合的功能，各占一栏。
          这几个开关打开时会顺手把「预设 → 消息格式与功能」里对应的子条目也打开
          （见 usePresetGate），所以这儿不用再嘱咐用户去预设里补一刀。
          最后那一栏 Instagram 也走同一道闸，只是它排在最下面（理由见那儿）。
        */}
        <Fold
          title="联网搜索"
          desc="答不上来的时候先查一下再回话"
          badge={onOff(role.webSearch?.enabled)}
        >
          <RoleSearchFields role={role} onGoto={onGoto} />
        </Fold>

        {/*
          查岗是两个开关，badge 得说清是哪一头 —— 只显示「开」的话，
          用户在折叠状态下分不出自己开的是电脑还是手机。
        */}
        <Fold
          title="查岗"
          desc="看一眼你此刻的电脑或手机屏幕，照着回话"
          badge={spyBadge(role.spy)}
        >
          <RoleSpyFields role={role} onGoto={onGoto} />
        </Fold>

        <Fold
          title="发语音"
          desc="把一句话合成成语音条发过去，对方收到的不是文字"
          badge={onOff(role.voiceSend?.enabled)}
        >
          <RoleVoiceFields role={role} onGoto={onGoto} />
        </Fold>

        <Fold
          title="生成图片"
          desc="现画一张图发过去，可以带参考图（图生图）"
          badge={onOff(role.imageGen?.enabled)}
        >
          <RoleImageFields role={role} onGoto={onGoto} />
        </Fold>

        <Fold
          title="发送表情包"
          desc="从图库的标签里随机挑一张发过去；不给它用哪些标签也在这儿点"
          badge={stickerBadge}
        >
          <RoleStickerFields role={role} onGoto={onGoto} />
        </Fold>

        <Fold
          title="已读与不回"
          desc="把对方的气泡标成已读，以及「只已读、这一轮什么都不发」"
          badge={lorBadge}
        >
          <RoleLeaveOnReadFields role={role} onGoto={onGoto} />
        </Fold>

        <Fold
          title="消息撤回"
          desc="说漏嘴之后把刚发出去的那条收回来；对方撤回时要不要让模型知道也在这儿"
          badge={undoBadge}
        >
          <RoleUndoSendFields role={role} onGoto={onGoto} />
        </Fold>

        <Fold
          title="分享链接卡片"
          desc="写 [card:网址] 或 [music:歌手-歌名] 发一张带标题和封面的卡片，就像对方的网易云音乐那种"
          badge={onOff(role.cardSend?.enabled)}
        >
          <RoleCardSendFields role={role} />
        </Fold>

        <Fold
          title="分享位置"
          desc="写 [location:南宁万象城] 发一张地图卡片，地名可以是编的"
          badge={onOff(role.locationSend?.enabled)}
        >
          <RoleLocationSendFields role={role} />
        </Fold>

        <Fold
          title="转账卡片"
          desc="写 [transfer:4000:零花钱] 发一张带金额的转账卡片，贴个表情就变「已收款」"
          badge={onOff(role.transfer?.enabled)}
        >
          <RoleTransferFields role={role} />
        </Fold>

        <Fold
          title="消息回应"
          desc="长按对方的气泡贴一个 emoji；对方贴了什么也会告诉模型"
          badge={reactBadge}
        >
          <RoleReactFields role={role} onGoto={onGoto} />
        </Fold>

        <Fold
          title="消息特效"
          desc="发气球、爱心、烟花这类全屏特效，或者「用力」「轻轻地」这类气泡特效"
          badge={effectBadge}
        >
          <RoleEffectFields role={role} onGoto={onGoto} />
        </Fold>

        <Fold
          title="聊天背景"
          desc="对方换了 iMessage 聊天背景时，让模型在下一条消息里知道"
          badge={onOff(bgOn)}
        >
          <RoleChatBackgroundFields role={role} />
        </Fold>

        {/* 十七、记忆库：记忆 / 备忘录 / 日记三道闸 */}
        <Fold
          title="记忆库"
          desc="记忆 / 备忘录 / 日记三道闸，攒下来的内容在「记忆库」面板里看"
          badge={`${memOn}/3`}
        >
          <RoleMemoryFields role={role} onGoto={onGoto} />
        </Fold>

        {/*
          十八、提示词协助模式。挨着记忆库放，因为它俩是这一页里唯二「往回看」的
          功能 —— 上面那些栏都在决定角色下一句怎么说，这两栏在处理已经说过的话。
        */}
        <Fold
          title="提示词协助模式"
          desc="在聊天里发一条指令，角色让位，换提示词工程师帮你查它为什么跑偏"
          badge={assistBadge}
        >
          <RolePromptAssistFields role={role} />
        </Fold>

        {/*
          最后两栏：主动消息 和 Instagram。摆在这儿是有意的 —— 它俩和上面那些栏
          最大的区别是「不用人开口它也会动」，前面那些配好了才谈得上让它自己发挥。
          IG 自己发帖挂在主动消息那一轮上，所以它排在主动消息后面：先决定它多久
          醒一次，再决定它醒来时顺不顺手发条帖子。
        */}
        <Fold
          title="角色主动消息"
          desc="没人说话的时候，隔一阵子自己找对方说话"
          badge={proBadge}
        >
          <RoleProactiveFields role={role} />
        </Fold>

        <Fold
          title="Instagram"
          desc="给这个角色一个 Instagram 主页：会发帖发快拍，也会来给你的帖子点赞留言"
          badge={igBadge}
        >
          <RoleInstagramFields role={role} onGoto={onGoto} />
        </Fold>
      </div>

      {/* 保存 + 应用到其他角色。这块不折起来 —— 改完总要按一下，藏进折叠栏里就找不着了 */}
      <div className="grid grid-cols-1 gap-3">
        <SaveBar hint="只影响这个角色，其他角色不动；保存后它绑的号码会自动上线" />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-meta leading-relaxed text-ink-faint">
            配好一个之后，可以把这套 API、上下文限制和用的预设复制给别的角色（世界书不复制）。
          </p>
          <Button variant="outline" onClick={() => setApplying(true)}>
            <Copy size={14} /> 应用到其他角色
          </Button>
        </div>
      </div>

      {/* 三、绑定的号码 */}
      <Card title="绑定的号码" desc="一个 Photon 项目 = 一条 iMessage 号码，凭据在 iMessage 面板里配">
        <div className="grid grid-cols-1 gap-6">
          <Field
            label="绑定的 Photon 项目"
            hint="一个项目 = 一条 iMessage 号码，一个项目只能给一个角色用"
          >
            <select
              className={inputCls}
              value={role.projectRef}
              onChange={(e) => bindProject(role.id, e.target.value)}
            >
              <option value="">（未绑定）</option>
              {projects.map((p) => {
                const taken = takenBy.get(p.id);
                return (
                  <option key={p.id} value={p.id} disabled={Boolean(taken)}>
                    {projectLabel(config, p.id)}
                    {p.linePhone ? ` · ${p.linePhone}` : ""}
                    {taken ? `（已被「${roleLabel(taken)}」占用）` : ""}
                  </option>
                );
              })}
            </select>
          </Field>

          {bound && (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta leading-relaxed text-ink-faint">
              <span>
                号码：
                {bound.linePhone ? (
                  <span className="font-mono text-ink-soft">{bound.linePhone}</span>
                ) : (
                  "还没登记"
                )}
              </span>
              <button
                type="button"
                onClick={() => onGoto?.("imessage")}
                className="inline-flex items-center gap-1 text-ink hover:underline"
              >
                去 iMessage 面板改这个项目 <ChevronRight size={12} />
              </button>
            </p>
          )}

          {blocked && (
            <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-l-2 border-warn py-1.5 pl-3 text-meta leading-relaxed text-warn">
              <span>{blocked}</span>
              <button
                type="button"
                onClick={() => onGoto?.("imessage")}
                className="link-slide text-warn"
              >
                {role.projectRef ? "去 iMessage 面板补上" : "去 iMessage 面板新建项目"}
              </button>
            </p>
          )}

          {/* 删除放在最后：破坏性操作不该和侧栏的「+」挨着 */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <p className="text-meta leading-relaxed text-ink-faint">
              删掉这个角色，它绑的项目会留着（凭据还在），变回未绑定。
            </p>
            <Button variant="ghost" onClick={drop} className="text-warn hover:bg-warn/[0.08]">
              <Trash2 size={14} /> 删除角色
            </Button>
          </div>
        </div>
      </Card>

      {applying && <ApplyApiDialog role={role} onClose={() => setApplying(false)} />}
    </div>
  );
}

export function RolePanel({ onGoto, bridge }) {
  const { config } = useConfig();
  const { itemId, pick } = useSection();
  const roles = config.roles ?? [];
  const open = roles.find((r) => r.id === itemId) ?? null;

  if (!open) {
    return (
      <Card title="角色">
        <p className="max-w-[62ch] text-body text-ink-soft">
          {roles.length
            ? "左边挑一个角色，它的人设、单独配置和绑定的号码都在这儿改。"
            : "左边还没有角色。点列表标题旁的「+」新建一个。"}
        </p>
      </Card>
    );
  }

  return <RoleDetail role={open} onBack={() => pick("")} onGoto={onGoto} bridge={bridge} />;
}
