/**
 * 记忆库挂在聊天链路上的那几个钩子。
 *
 * `memory.js` 管「怎么总结」，`memorystore.js` 管「存哪儿」，这个文件管
 * **什么时候触发**：每轮聊完往待总结里记一笔、轮数到了在后台跑一次总结、
 * 手动指令、定时日记。
 *
 * 单独一个文件而不是塞进 imessage.js，理由和当初拆出 prompt.js 一样 ——
 * 那边已经 1500 多行，而这里的逻辑（轮数、并发去重、连续失败的退避和告知）
 * 自己就有分量，混进去谁都读不动。
 *
 * 三条铁律，整个文件围着它们写：
 *
 *  1. **绝不阻塞这一轮回复。** 总结要打一次模型、几十秒起步，对方正在等
 *     消息。所以 `runSummaries` 一律 `void ...catch()` 地在后台跑，
 *     调用方不 await（见 imessage.js 的两个挂点）。
 *  2. **失败绝不删记录。** 这里只调 `markFail`（只改计数），清空是
 *     `memory.js` 里成功之后才做的事。用户的原话：「生成失败的话，
 *     绝对不会删掉记录文件，而是继续加入新的聊天记录内容」。
 *  3. **一个 key + 一类只能有一个在跑。** 消息来得密时轮数会连着两次达标，
 *     不挡的话同一批待总结会被总结两遍、还可能互相覆盖。
 */

import { stripEnvPrefix } from "./env.js";
import { logDebug, logError, logInfo, logWarn } from "./logs.js";
import {
  diaryLogLine,
  diaryWeather,
  generateDiary,
  summarizeMemo,
  summarizeMemory,
} from "./memory.js";
import {
  appendDiaryLine,
  appendPending,
  markFail,
  memoryKeyFor,
  readDiaryLog,
  readDiaryState,
  readPending,
  resetFails,
  shouldSummarize,
  writeDiaryState,
} from "./memorystore.js";

/**
 * 正在跑的总结：`"记忆:小明"` 这样的字符串。
 *
 * 进程内的 Set 就够了 —— 单进程、单实例，而且崩了重启之后待总结文件还在，
 * 下一轮照样会重新触发。写成文件锁反而要处理「上次崩了留下的死锁」。
 */
const running = new Set();

/** 三类在日志和消息里的中文名。 */
const KIND_NAMES = { memory: "记忆", memo: "备忘录", diary: "日记" };

/**
 * 一个角色的三道闸现在开着几道。
 *
 * 闸在**角色**上（`role.memories`），设置在全局（`config.memories`）——
 * 和 webSearch / voiceSend / imageGen 一个路子：会花钱的功能由「用哪个角色」
 * 决定，默认全关。
 */
function gatesOf(role) {
  const g = role?.memories ?? {};
  return {
    memory: Boolean(g.memory?.enabled),
    memo: Boolean(g.memo?.enabled),
    diary: Boolean(g.diary?.enabled),
  };
}

/**
 * 这一轮聊完了，记进记忆库的待总结区。
 *
 * **同步的、很轻**（两次追加写），所以两个挂点都能直接调，不用怕拖慢回复。
 * 真正花钱的那步是 `runSummaries`。
 *
 * 三样东西各存各的：
 *  - 记忆和备忘录各有一份待总结流水（`待总结/记忆/<角色>.txt`、
 *    `待总结/备忘录/<角色>.txt`）。**不共用一份**：两者的轮数可以配不同的值，
 *    共用的话先到的那个一清空，另一个的进度就没了。
 *  - 日记直接往它自己的流水里追加两行。
 *
 * 三份的格式**完全一样**（`系统时间 | [发送人] 内容`，用户钉死的），
 * 时间由下面那个 `now` 统一提供，拼行的 `diaryLogLine` 也是同一个。
 * **都不写天气** —— 天气是生成那一刻才注入的瞬时值。
 *
 * 关着的那一样一个字都不写：没开日记的角色不该在磁盘上攒一个越来越大的流水。
 *
 * **联网搜索回来的资料不会到这儿。** 那段 `<搜索结果>` 只加在 searchRound
 * 里面那个 followUp 副本上（imessage.js:695），调用方传进来的 `assistant`
 * 是模型的回复本身。用户要求「不记录联网搜索返回的内容（这样 token 太大了）」——
 * 这条不用额外过滤，天生就满足；改那边的时候别把 note 拼进 reply 就行。
 *
 * @param {object} config 完整配置
 * @param {object} role 当前角色
 * @param {{user: string, assistant: string, at?: string|Date}} turn 这一轮的原文，
 *   `at` 是这一轮的时间戳（不给就取现在，见下面为什么整轮只取一次）
 * @returns {{key: string, gates: object}|null} null = 三道闸全关，什么都没做
 */
export function recordTurn(config, role, turn) {
  const gates = gatesOf(role);
  if (!gates.memory && !gates.memo && !gates.diary) return null;

  const key = memoryKeyFor(role);
  /*
   * 剥掉环境前缀（`[{{user}}发送当地时间 CST : … | 周三, 工作日 | …]`）。
   *
   * 调用方传进来的是**进存档那一份**原文，开头带着那对方括号 —— 对聊天模型
   * 来说那是有用的时间脉络（见 env.js 文件头），对记忆库却是纯噪音：
   *  - 待总结里存着它，总结出来的记忆会带上一串时区和节假日；
   *  - 日记流水的**行首本来就是系统时间**，再带一遍等于同一个时刻写两种格式。
   * 用户要的只是系统时间 + 发送人 + 内容，所以在入口这一步就剥掉。
   *
   * 剥在这里而不是在两个挂点：`recordTurn` 是记忆库唯一的入口，
   * 放在这儿就不会有第三个挂点忘了剥。
   */
  const user = stripEnvPrefix(turn?.user).trim();
  const assistant = stripEnvPrefix(turn?.assistant).trim();
  if (!user && !assistant) return null;

  /*
   * 这一轮的时间：**整轮只取一次**系统时间，两行、三份文件全都用它。
   *
   * 取的时刻就是这儿 —— 调用方（imessage.js:afterTurn）是在模型把这一轮回复
   * 生成完之后才调的，所以这就是用户要的基准「LLM 回复完成的系统时间」。
   *
   * 不挪到「气泡全部发出去之后」：那边还有打字延迟和分条发送，一轮能拖几十秒，
   * 而且发送失败时这一笔就记不上了 —— 时间要的是「这段对话发生在什么时候」，
   * 不是「最后一个气泡什么时候落地」。
   *
   * 为什么必须共用一个：以前两行各自 `new Date()`，跨秒的时候同一轮会写出
   * 09:45:18 和 09:45:19 两个时间，看着像隔了一秒发生的两件事。用户给的示例里
   * 一轮两行的时间是一模一样的。
   *
   * 调用方给了 `turn.at` 就用它（补记/重放时才有），否则取现在。
   */
  const at = turn?.at ? new Date(turn.at) : new Date();
  const now = Number.isNaN(at.getTime()) ? new Date() : at;

  /*
   * 发送人用**真名**（`[米洛]` / `[小明]`），三份文件一致。
   *
   * 日记提示词里要求角色以第一人称写自己、把对方当具体的人，写成
   * user/assistant 那种角色名模型分不清谁是谁；记忆和备忘录同理。
   */
  const userName = config?.users?.find?.((u) => u.enabled)?.name || "对方";
  const charName = role?.name || "我";

  try {
    // 三份都是同一种流水（`时间 | [发送人] 内容`），只是分开存
    const line = { at: now, userName, charName };
    if (gates.memory) appendPending("memory", key, { ...line, user, assistant });
    if (gates.memo) appendPending("memo", key, { ...line, user, assistant });
    if (gates.diary) {
      // 顺序是对方先、角色后，和实际发生的顺序一致
      if (user) appendDiaryLine(key, diaryLogLine(userName, user, now));
      if (assistant) appendDiaryLine(key, diaryLogLine(charName, assistant, now));
    }
  } catch (e) {
    // 记不进去不该影响这一轮回复 —— 对方已经收到消息了
    logWarn("记忆库", `${key} 这一轮没记进待总结（不影响回复）`, e);
  }

  return { key, gates };
}

/**
 * 先记忆、后备忘录。**这个顺序不能倒**。
 *
 * 备忘录那条链会注入「近 N 天记忆」（见 memory.js:buildMemoMessages）——
 * 先总结记忆，这一批对话产出的那条记忆就能立刻被备忘录看到；倒过来的话
 * 备忘录用的永远是上一批的记忆，等于慢一拍。用户也明确要求过这个顺序。
 */
const SUMMARY_ORDER = ["memory", "memo"];

/**
 * 轮数到了就总结一次。**调用方不要 await**（见文件头铁律 1）。
 *
 * 只管记忆和备忘录 —— 日记不看轮数，它按定时或手动来。
 *
 * 一类失败**不影响另一类**：两者各有各的待总结缓存和模型配置，记忆那条线
 * 的模型挂了不该顺带让备忘录也不总结。所以下面每一类各自 try（`runOne`
 * 内部已经把错误都接住了），循环不会被中断。
 *
 * 连续失败到 `maxFails` 次时发一条消息告诉用户原因，然后**把计数清零重新数**：
 * 不清的话之后每次失败都会再发一条，变成刷屏。用户的要求是「告诉用户失败的
 * 原因」，一次说清就够了。
 *
 * @param {object} config
 * @param {object} role
 * @param {(text: string) => Promise<void>} [notify] 往对方的 iMessage 发一条话
 */
export async function runSummaries(config, role, notify) {
  const gates = gatesOf(role);
  const key = memoryKeyFor(role);

  for (const kind of SUMMARY_ORDER) {
    if (!gates[kind]) continue;
    const cfg = config?.memories?.[kind] ?? {};
    const pending = readPending(kind, key);
    if (!shouldSummarize(pending, cfg.rounds ?? 15)) continue;

    await runOne(kind, config, role, key, notify);
  }
}

/**
 * 跑一次某一类的总结，带并发闸和失败计数。
 *
 * 成功 / 失败两条路都在这里收口，是为了让「失败只 markFail、绝不清空」
 * 这条规矩只有一个落点。
 */
async function runOne(kind, config, role, key, notify) {
  const lock = `${kind}:${key}`;
  if (running.has(lock)) {
    logInfo("记忆库", `${key} 的${KIND_NAMES[kind]}总结已经在跑了，这次跳过`);
    return null;
  }
  running.add(lock);

  const name = KIND_NAMES[kind];
  const started = Date.now();
  /*
   * 开始那行也要有。
   *
   * 这一步是**后台**跑的（afterTurn 里 void 掉的），回复照发，所以它不该、
   * 也确实没有拖慢这一轮。但用户看不到这点 —— 他看到的是回复慢了，然后猜
   * 「是不是后台在总结记忆或者备忘录」。没有开始那行的话，这个猜测既证实
   * 不了也排除不了：总结完成那行要几十秒后才出来，而它出来时前台早就发完了。
   *
   * 写清「不影响这一轮回复」，看到这行的人就不用再怀疑它是不是罪魁祸首。
   */
  logInfo("记忆库", `${key} 开始在后台跑${name}总结（不影响这一轮回复）…`);
  try {
    const out =
      kind === "memory"
        ? await summarizeMemory(config, role, key)
        : await summarizeMemo(config, role, key);
    logInfo("记忆库", `${key} 的${name}总结完成（${Date.now() - started}ms）`);
    return out;
  } catch (e) {
    const why = String(e?.message ?? e);
    // 只改计数，正文一个字节不动 —— 铁律 2
    const after = markFail(kind, key, why);
    const cfg = config?.memories?.[kind] ?? {};
    const maxFails = cfg.maxFails ?? 3;
    logError("记忆库", `${key} 的${name}总结失败（第 ${after.fails} 次，待总结的内容都还在）`, e);

    /*
     * 内容安全那一类**第一次就说**，不攒到 maxFails。
     *
     * 别的失败（模型没配、网络不通、额度没了）攒几次再说是对的：多半是临时的，
     * 下一轮就好了，每次都发一条只是刷屏。内容安全不一样 —— llm.js 那边已经
     * 换了三档说法、三次都被拦下才会走到这儿，它不会自己好转，而且用户**必须
     * 当场知道**：这一轮没有更新，所以现在看到的那份是旧的。
     *
     * 用户的原话：「不要再覆盖备忘录了，而是在控制台和聊天窗口提醒用户被安全
     * 内容拦截了，已重试了三次什么的」。控制台那条是上面的 logError，
     * 这里是聊天窗口那条。
     *
     * `e.blocked` 是 llm.js:blockedIf 盖的标记 —— 到现在才有了第一个读它的人。
     */
    const blocked = Boolean(e?.blocked);
    if ((blocked || after.fails >= maxFails) && notify) {
      // 说清「没丢东西」—— 不然用户看到「失败」第一反应是聊天记录没了
      const head = blocked
        ? `⚠️ ${name}被模型的内容安全拦下了，换了 3 次说法都没过去，这一轮没有生成。\n` +
          `你现在看到的${name}还是上一次那份，一个字都没被覆盖。`
        : `⚠️ ${name}已经连着 ${after.fails} 次没总结成功：${why}`;
      await notify(
        `${head}\n待总结的 ${after.lines} 行聊天记录一条都没删，` +
          `${blocked ? "下一轮会连着新的再试一次" : "配置好之后会接着总结"}。`
      ).catch(() => {});
      // 说过一次就把计数归零重新数，别每次失败都刷一条
      resetFails(kind, key);
    }
    return null;
  } finally {
    running.delete(lock);
  }
}

/**
 * 手动总结一次记忆（`/memory`、`/记忆`，以及界面上那个按钮）。
 *
 * 和自动那条路不同：**不看轮数**，攒了几轮就总结几轮 —— 用户自己敲的指令
 * 不该被「还没攒够 15 轮」挡住。失败照旧不清空，把原因发回去。
 *
 * @returns {Promise<{text: string, ok?: boolean, log?: string}>}
 */
export async function manualMemory(config, role) {
  return manualSummary("memory", config, role);
}

/** 手动生成一次备忘录（界面上那个按钮；没有对应的聊天指令）。 */
export async function manualMemo(config, role) {
  return manualSummary("memo", config, role);
}

async function manualSummary(kind, config, role) {
  const key = memoryKeyFor(role);
  const name = KIND_NAMES[kind];
  if (!gatesOf(role)[kind]) {
    return {
      ok: false,
      text: `⚠️ 这个角色没开「${name}」。去浏览器的「角色 → 单独配置 → 记忆库」里打开。`,
    };
  }

  const pending = readPending(kind, key);
  if (!pending.text.trim()) {
    return { ok: false, text: "现在没有待总结的聊天记录，先聊几句再来。" };
  }

  const lock = `${kind}:${key}`;
  if (running.has(lock)) return { ok: false, text: `${name}正在总结中，稍等一下。` };

  try {
    const out = await runOneDirect(kind, config, role, key);
    // 两条链都返回 { content }：记忆是新增的那一条，备忘录是整份清单。
    // 直接发回去让用户看到结果 —— 「总结成功了」这句话本身没有信息量
    return {
      ok: true,
      text: `✅ 已把攒着的 ${pending.lines} 行聊天总结成${name}：\n${out.content}`,
      log: `手动总结${name}：${key}`,
    };
  } catch (e) {
    const why = String(e?.message ?? e);
    return {
      ok: false,
      text: `⚠️ ${name}没总结成功：${why}\n那 ${pending.lines} 行聊天记录一条都没删。`,
      log: `手动总结${name}失败：${why}`,
    };
  }
}

/**
 * 手动生成一篇日记（`/diary`、`/日记`）。
 *
 * 天气**现查**（「什么时候生成的日记就注入什么时间的天气」），查不到就整段
 * 不注入 —— `diaryWeather` 已经把错误折成空串了。
 */
export async function manualDiary(config, role) {
  const key = memoryKeyFor(role);
  const cfg = config?.memories?.diary ?? {};
  if (!gatesOf(role).diary) {
    return {
      ok: false,
      text: "⚠️ 这个角色没开「日记」。去浏览器的「角色 → 单独配置 → 记忆库」里打开。",
    };
  }
  if (!cfg.manual) {
    return { ok: false, text: "⚠️「手动日记」在设置里是关着的。去「记忆库 → 日记」里打开。" };
  }
  if (!readDiaryLog(key).trim()) {
    return { ok: false, text: "日记流水是空的，这段时间没有聊天记录可写。" };
  }

  const lock = `diary:${key}`;
  if (running.has(lock)) return { ok: false, text: "日记正在写，稍等一下。" };
  running.add(lock);
  try {
    const weather = await diaryWeather(config, role);
    const out = await generateDiary(config, role, key, { weather });
    markDiaryDone(key);
    return {
      ok: true,
      file: out.file,
      text: `✅ 日记写好了（${out.file}，${out.text.length} 字）：\n\n${out.text}`,
      log: `手动生成日记：${key} → ${out.file}`,
    };
  } catch (e) {
    const why = String(e?.message ?? e);
    logError("记忆库", `${key} 手动生成日记失败（流水没删）`, e);
    // 手点失败**不推时间戳**：那是定时那条路的节流，手点不该影响它
    markDiaryError(key, why);
    // 「告诉用户失败的原因，且不会删除 {{char}}_diary_log.txt」
    return {
      ok: false,
      text: `⚠️ 这篇日记没生成成功：${why}`,
      log: `手动生成日记失败：${why}`,
    };
  } finally {
    running.delete(lock);
  }
}

/** 不带失败兜底的单次总结，给手动那条路用（它要把错误原样抛给调用方）。 */
async function runOneDirect(kind, config, role, key) {
  const lock = `${kind}:${key}`;
  running.add(lock);
  try {
    return kind === "memory"
      ? await summarizeMemory(config, role, key)
      : await summarizeMemo(config, role, key);
  } catch (e) {
    /*
     * 记下原因（界面上要显示），但**不推 lastTry** —— 手点失败不该占用自动
     * 总结的退避额度。推了的话自动那条路要再攒满一整轮 rounds 才会重试，
     * 用户会看到「手点失败之后，记忆就再也不自己总结了」。
     */
    markFail(kind, key, String(e?.message ?? e), { pushTry: false });
    throw e;
  } finally {
    running.delete(lock);
  }
}

/* ================= 定时日记 ================= */

/** 定时器多久醒一次。一分钟够了 —— 最小的间隔单位就是分钟。 */
const TICK_MS = 60000;

/** `schedule` 换算成毫秒。三个数全 0 = 没设，返回 0。 */
function scheduleMs(schedule) {
  const d = Math.max(0, Number(schedule?.days) || 0);
  const h = Math.max(0, Number(schedule?.hours) || 0);
  const m = Math.max(0, Number(schedule?.minutes) || 0);
  return ((d * 24 + h) * 60 + m) * 60000;
}

/**
 * 三个小写手，都只动 `日记/<key>/state.json`。分成三个是因为
 * 「时间戳」和「上次的错误」要能各自单独动：
 *
 *  - 成功了：推时间戳 + 把上次的错误擦掉（修好之后界面上那条红字得消失）
 *  - 定时那次没写成：推时间戳（否则每分钟重试一次，配置错了就是每分钟一次
 *    收费请求）**并且**记下原因
 *  - 用户在界面/聊天里手动点的那次没写成：**只记原因，不推时间戳** ——
 *    手点失败不该把「每 12 小时一篇」的下一次往后推
 *
 * 错误存下来是给界面用的：定时日记在后台跑，失败时用户不在现场。
 */
function markDiaryDone(key) {
  saveState(key, { lastDiaryAt: new Date().toISOString(), lastError: "", lastErrorAt: "" });
}

/** 只推时间戳（流水是空的那种「这次不用写」）。 */
function pushDiaryTime(key) {
  saveState(key, { lastDiaryAt: new Date().toISOString() });
}

function markDiaryError(key, why, { pushTime = false } = {}) {
  const now = new Date().toISOString();
  saveState(key, {
    // 留够长度：中转站的 400 常把真正的原因写在很后面，截短了等于让用户猜
    lastError: String(why ?? "").slice(0, 2000),
    lastErrorAt: now,
    ...(pushTime ? { lastDiaryAt: now } : {}),
  });
}

function saveState(key, patch) {
  try {
    writeDiaryState(key, patch);
  } catch (e) {
    logWarn("记忆库", "写日记状态失败（下次定时可能提前一轮）", e);
  }
}

/**
 * 该不该现在给这个角色写日记。
 *
 * 三个条件：开了日记、开了定时、间隔不为 0，然后看距上次够不够久。
 * **没有上次记录时不立刻写**，而是把「现在」当上次记下来 —— 否则用户刚打开
 * 定时开关就会被立刻生成一篇，那不是「每 N 小时一篇」的意思。
 */
function diaryDue(config, role, key, now) {
  const cfg = config?.memories?.diary ?? {};
  if (!gatesOf(role).diary || !cfg.schedule?.enabled) return false;
  const every = scheduleMs(cfg.schedule);
  if (!every) return false;

  const state = readDiaryState(key);
  const last = Date.parse(state?.lastDiaryAt ?? "");
  if (!Number.isFinite(last)) {
    pushDiaryTime(key);
    return false;
  }
  return now - last >= every;
}

/**
 * 起一个定时器，到点给开了「定时日记」的角色各写一篇。
 *
 * **漏掉的那次不补**（plan 里定的）：机器睡了一整天再醒过来，补写十篇日记
 * 既花钱又没意义 —— 那十篇内容全来自同一份流水。
 *
 * 流水是空的就跳过、并且**把时间戳往后推**：不推的话每分钟都会来试一次，
 * 日志里刷一片「流水是空的」。
 *
 * @param {() => object} getConfig 现读配置（用户随时会在界面上改）
 * @param {(role: object, text: string) => Promise<void>} [notify]
 *        写成/失败要不要告诉对方。不传就只写日志
 * @returns {() => void} 停掉定时器
 */
export function startDiaryTimer(getConfig, notify) {
  const timer = setInterval(() => {
    void tickDiaries(getConfig, notify).catch((e) => {
      logError("记忆库", "定时日记这一轮出错", e);
    });
  }, TICK_MS);
  // 定时器不该拦着进程退出 —— Ctrl+C 之后还要等一分钟就太怪了
  timer.unref?.();
  logInfo("记忆库", "定时日记的检查已启动（每分钟看一次）");
  return () => clearInterval(timer);
}

async function tickDiaries(getConfig, notify) {
  const config = getConfig();
  const now = Date.now();

  for (const role of config?.roles ?? []) {
    const key = memoryKeyFor(role);
    if (!diaryDue(config, role, key, now)) continue;

    if (!readDiaryLog(key).trim()) {
      // 时间戳往后推，免得每分钟来一次。这不算失败，所以不碰 lastError
      pushDiaryTime(key);
      logInfo("记忆库", `${key} 到点该写日记了，但流水是空的，跳过这一次`);
      continue;
    }

    const lock = `diary:${key}`;
    if (running.has(lock)) {
      // 以前这里是静默 continue —— 上一篇还在写（生成一篇要几十秒）的时候，
      // 日志上看不出这一跳做过判断，只显得「到点了但什么都没发生」
      logDebug("记忆库", `${key} 上一篇日记还在写，这一跳跳过`);
      continue;
    }
    running.add(lock);
    logDebug("记忆库", `${key} 到点了，开始写定时日记`);
    try {
      const weather = await diaryWeather(config, role);
      const out = await generateDiary(config, role, key, { weather });
      markDiaryDone(key);
      logInfo("记忆库", `${key} 的定时日记写好了：${out.file}（${out.text.length} 字）`);
      if (notify) await notify(role, `📔 我写了一篇日记（${out.file}）。`).catch(() => {});
    } catch (e) {
      const why = String(e?.message ?? e);
      /*
       * 失败也把时间戳推一次。
       *
       * 不推的话每分钟都会重试一次，配置错了就是每分钟一次收费请求。
       * 代价是这一轮的内容要等到下一个间隔才写 —— 但流水**一个字节都没删**，
       * 下次连着一起写，什么都不会丢。
       */
      markDiaryError(key, why, { pushTime: true });
      logError("记忆库", `${key} 的定时日记失败（流水没删，下个间隔再试）`, e);
      if (notify) {
        await notify(role, `⚠️ 这篇定时日记没写成：${why}\n聊天流水一条都没删。`).catch(() => {});
      }
    } finally {
      running.delete(lock);
    }
  }
}