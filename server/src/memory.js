/**
 * 记忆的检索：关键词、向量相似度、混合打分、按预算挑几条注入。
 *
 * 算法整套照搬参考插件 `astrbot_plugin_romantic_memory/retrieval.py`
 * （用户的规范写的是「直接参考它的功能即可」），只把 ChromaDB 换成
 * 「JSON 文件 + 内存余弦」—— 几百上千条记忆，纯 JS 算一遍是毫秒级，
 * 不值得为它引一个向量数据库进来。
 *
 * 前半个文件（打分和挑选）**全是纯函数**：不读盘、不打网络、不看时钟
 * —— `now` 一律由调用方传进来。这么写是为了让最容易算错的这部分能离线跑断言，
 * 不用架一个假的向量接口。后半个文件是三条总结链（记忆 / 备忘录 / 日记），
 * 从 ================= 四、三条总结链 ================= 那一行往下。
 *
 * 打分公式（一个字都没改）：
 *
 *   语义 = 1 / (1 + 余弦距离)          距离 0（一模一样）→ 1.0；距离 1 → 0.5
 *   关键词 = 命中的查询词数 / 查询词总数
 *   base  = 语义 × 0.7 + 关键词 × 0.3
 *   final = base − 老了几天 × 衰减系数
 *
 * **门槛判在 base 上，不判在 final 上** —— 这是参考实现专门写注释强调过的一点：
 * 相关性决定「有没有资格入选」，时间衰减只决定「排在第几」。
 * 判在 final 上的话，一条三个月前的、明明就是在问它的记忆会因为老而被丢掉。
 */

import { applyVars, resolveEndpoint, resolveUser } from "./config.js";
import { buildEnv } from "./env.js";
import { chatCompletion, embedText } from "./llm.js";
import { logInfo, logWarn } from "./logs.js";
import {
  appendMemory,
  commitDiaryLog,
  commitPending,
  diaryLogLine,
  localDate,
  readDiaryLog,
  readMemo,
  readMemories,
  readPending,
  readRecentDiaries,
  writeDiary,
  writeMemo,
} from "./memorystore.js";
/*
 * prompt.js 反过来也 import 这个文件（它要上面那几个纯函数做注入）。
 * 这个环是安全的：两边都只在**函数体里**用对方的东西，而 `wrap` 是函数声明
 * （会被提升，模块体跑之前绑定就在了）。宁可绕这个环也不复制一份 `wrap` ——
 * 三条链的包法必须和注入那边一模一样，抄一份迟早会分叉。
 */
import { wrap } from "./prompt.js";
import { activate, worldBooksFor } from "./worldinfo.js";

/** 语义和关键词的配比。参考实现里写死的 0.7 / 0.3。 */
const SEMANTIC_WEIGHT = 0.7;
const KEYWORD_WEIGHT = 0.3;

const DAY_MS = 86400000;

/**
 * 从一段话里抽出能拿去比对的词。
 *
 * 三类各走各的规则：
 *  - 英文：字母开头，后面跟字母数字下划线连字符，2–32 个字符。
 *    一个字母的词（a、I）全是噪音，不要。
 *  - 数字：整数或小数，用来接住「02月14日」「3天」这类。
 *  - 中文：**按 2-gram 切**。中文没有空格，正经分词要带词库；
 *    2-gram 是「不引依赖」前提下召回率最好的近似 ——
 *    「营地确认」切成 营地/地确/确认，查「确认营地」时 营地 和 确认 都能命中。
 *    两个字及以下的整块保留（「猫」「电影」本来就切不动）。
 *
 * 去重但保留出现顺序（`dict.fromkeys` 的等价物），因为 keywordScore
 * 是按「不同的词命中了几个」算的，同一个词出现两次不该算两分。
 */
export function extractKeywords(text) {
  const terms = [];
  const lower = String(text ?? "").toLowerCase();

  for (const m of lower.matchAll(/[a-z][a-z0-9_-]{1,31}/g)) terms.push(m[0]);
  for (const m of lower.matchAll(/\d+(?:\.\d+)?/g)) terms.push(m[0]);
  for (const m of lower.matchAll(/[一-鿿]+/g)) {
    const block = m[0];
    if (block.length <= 2) {
      terms.push(block);
    } else {
      for (let i = 0; i < block.length - 1; i += 1) terms.push(block.slice(i, i + 2));
    }
  }
  return [...new Set(terms.filter(Boolean))];
}

/**
 * 余弦距离 → 0–1 的语义分。
 *
 * 距离是 `1 − 余弦相似度`（Chroma 的 cosine space 就是这么定义的，
 * 参考实现直接吃它的输出）。取值 0（一模一样）到 2（完全相反）。
 * `1/(1+d)` 把它压成 1.0 → 0.33 的一条平滑曲线，越近分越高。
 * 负数（浮点误差）当 0 处理。
 */
export function semanticScore(distance) {
  const d = Number(distance);
  if (!Number.isFinite(d) || d < 0) return 0;
  return Math.max(0, Math.min(1, 1 / (1 + d)));
}

/**
 * 两个向量的余弦相似度。维度对不上或有一边是零向量就返回 0。
 *
 * 自己算而不是引 `ml-distance` 那类包：就是一个点积加两个模长，
 * 为它多一个依赖不划算（这个项目到目前为止服务端零运行时依赖之外只有 express）。
 */
export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) {
    return 0;
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = Number(a[i]) || 0;
    const y = Number(b[i]) || 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 余弦相似度 → 余弦距离，接上 semanticScore 那一套。 */
export function cosineDistance(a, b) {
  return 1 - cosineSimilarity(a, b);
}

/**
 * 查询词在一条记忆里命中了几成。
 *
 * 正文和这条记忆自己存的关键词一起当草堆 —— 总结出来的正文未必包含原话里的词，
 * 但生成时抽的关键词里往往有。
 *
 * 查询里一个词都抽不出来时返回 0（不是 1）：没有证据就是没有证据，
 * 返回 1 会让所有记忆凭空多拿 0.3 分，把门槛冲垮。
 */
export function keywordScore(terms, content, keywords = "") {
  if (!Array.isArray(terms) || !terms.length) return 0;
  const hay = `${String(content ?? "").toLowerCase()} ${String(keywords ?? "").toLowerCase()}`;
  let hits = 0;
  for (const term of terms) if (hay.includes(term)) hits += 1;
  return hits / terms.length;
}

/**
 * 混合打分 + 过门槛 + 按 final 排序。
 *
 * @param {object[]} candidates 每条要有 `content`，可选 `score`（语义分，
 *        由调用方用向量算好传进来）、`keywords`、`timestamp`
 * @param {string} query 用来检索的那句话（一般是用户最后一条消息）
 * @param {object} opts `{threshold, timeDecay, decay, now}`
 * @returns {object[]} 过了门槛的，按 `finalScore` 从高到低。每条多带五个
 *          分数字段，方便界面上解释「为什么是这几条」
 */
export function rankCandidates(candidates, query, opts = {}) {
  const { threshold = 0.35, timeDecay = true, decay = 0.01, now = Date.now() } = opts;
  const terms = extractKeywords(query);
  const ranked = [];

  for (const item of Array.isArray(candidates) ? candidates : []) {
    if (!item || typeof item !== "object") continue;
    const semantic = Number(item.score) || 0;
    const kw = keywordScore(terms, item.content, keywordsText(item.keywords));
    const base = semantic * SEMANTIC_WEIGHT + kw * KEYWORD_WEIGHT;
    const ts = Number(item.timestamp) || now;
    const ageDays = Math.max(0, (now - ts) / DAY_MS);
    const final = timeDecay ? base - ageDays * decay : base;

    // 门槛判 base 不判 final：老而准的记忆不该只因为旧就被踢出候选。
    // 衰减只体现在下面那行排序上。
    if (base < threshold) continue;
    ranked.push({
      ...item,
      semanticScore: semantic,
      keywordScore: kw,
      baseScore: base,
      ageDays,
      finalScore: final,
    });
  }
  return ranked.sort((a, b) => b.finalScore - a.finalScore);
}

/** 记忆的 keywords 存的是数组，打分时要拼成一段文本。 */
function keywordsText(keywords) {
  if (Array.isArray(keywords)) return keywords.join(" ");
  return String(keywords ?? "");
}

/**
 * 从排好序的候选里挑出真正要注入的那几条。
 *
 * 三道收口，顺序不能换：
 *   1. top-K       —— 先按分数砍，留最相关的几条
 *   2. 天数窗口     —— `keepDays < 0` 表示不限；否则只留这么多天内的
 *   3. 字符预算     —— 一条条加，加不下的**跳过继续看下一条**而不是就此打住
 *      （后面可能有更短的能塞进去，参考实现就是 continue）
 *
 * 最后按时间**倒序**返回：注入的时候新的在前，模型先看到最近发生的事。
 *
 * 预算算的是 `日期 | 正文` 这一行的长度，和 formatMemoryLines 拼出来的一致 ——
 * 不然预算和实际注入的字数对不上。
 */
export function selectForInjection(ranked, opts = {}) {
  const { topK = 5, maxChars = 6000, keepDays = -1, now = Date.now() } = opts;

  let candidates = (Array.isArray(ranked) ? ranked : []).slice(0, Math.max(0, topK));
  if (keepDays >= 0) {
    const cutoff = now - keepDays * DAY_MS;
    candidates = candidates.filter((item) => (Number(item.timestamp) || 0) >= cutoff);
  }

  const selected = [];
  let used = 0;
  for (const item of candidates) {
    const line = `${item.date ?? ""} | ${item.content ?? ""}`.trim();
    const extra = line.length + (selected.length ? 1 : 0); // 换行也占一个
    if (maxChars >= 0 && used + extra > maxChars) continue;
    selected.push(item);
    used += extra;
  }
  return selected.sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0));
}

/**
 * 近 N 天的全部记忆，按时间倒序。**不走向量**，纯按日期捞。
 *
 * 这是和检索并行的第二路（参考实现的双通道）：检索那路回答「和这句话有关的」，
 * 这路回答「最近发生过什么」。后者不需要相关性，也就不需要向量 ——
 * 向量模型没配、打不通的时候，这一路照样能用。
 *
 * `keepDays < 0` = 不限，全给（和参考实现一致）。
 */
export function filterRecent(records, keepDays, now = Date.now()) {
  const list = (Array.isArray(records) ? records : []).filter(
    (r) => r && typeof r === "object"
  );
  const byTime = (a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0);
  if (!(keepDays >= 0)) return [...list].sort(byTime);
  const cutoff = now - keepDays * DAY_MS;
  return list.filter((r) => (Number(r.timestamp) || 0) >= cutoff).sort(byTime);
}

/**
 * 检索回来的那路 → 注入文本，**每条一行** `- 日期 | 正文`。
 *
 * 用在 `{{回忆起来的记忆}}` 上。这一路的几条之间没有时间上的关系
 * （是按相关性挑出来的，日期可能东一条西一条），所以每行都自带日期。
 */
export function formatMemoryLines(memories) {
  return (Array.isArray(memories) ? memories : [])
    .map((item) => ({
      date: String(item?.date ?? "").trim() || "未知日期",
      content: String(item?.content ?? "").trim(),
    }))
    .filter((item) => item.content)
    .map((item) => `- ${item.date} | ${item.content}`)
    .join("\n");
}

/**
 * 近期那路 → 注入文本，同一天的多条**不重复写日期**。
 *
 * 用在 `{{近N天记忆}}` 上。这一路是连续的一段日子，一天聊出五条记忆时
 * 把日期写五遍纯属浪费 token，所以第二条起只留正文：
 *
 *     - 2026-09-09 | 定了周六去露营
 *     说想带那顶新帐篷
 *     2026-09-08 | 加班到十一点
 *
 * 只有第一行带 `- `，后面的日期行不带 —— 这是参考实现
 * `format_recent_memory_prompt` 的原样行为（它的测试断言就钉着这个形状），
 * 看着不齐但换成每行都带会让「同一天」这个分组读不出来。
 */
export function formatRecentLines(memories) {
  const lines = [];
  let prev = null;
  for (const item of Array.isArray(memories) ? memories : []) {
    const date = String(item?.date ?? "").trim() || "未知日期";
    const content = String(item?.content ?? "").trim();
    if (!content) continue;
    if (date !== prev) {
      lines.push(`${lines.length ? "" : "- "}${date} | ${content}`);
      prev = date;
    } else {
      lines.push(content);
    }
  }
  return lines.join("\n");
}

/**
 * 从检索结果里剔掉「近 N 天」那路已经注入过的。
 *
 * 两个变量是分开注入的（`{{近N天记忆}}` 和 `{{回忆起来的记忆}}`），昨天那条
 * 记忆既在近三天里、又可能正好被这句话检索到 —— 不剔就会在提示词里出现两遍，
 * 模型会当成两件独立的事。
 *
 * 剔的是检索那路而不是近期那路：近期那路的日期分组更省 token，而且
 * 「最近发生过什么」缺一条会让时间线断掉。
 */
export function dedupeAgainst(recalled, recent) {
  const seen = new Set(
    (Array.isArray(recent) ? recent : []).map((item) => item?.id).filter(Boolean)
  );
  return (Array.isArray(recalled) ? recalled : []).filter((item) => !seen.has(item?.id));
}

/**
 * 截到指定字数再拿去算向量。
 *
 * 向量接口按 token 收费也按 token 限长，一段超长的待总结文本要么被上游拒了、
 * 要么白花钱。`limit <= 0` 返回空串（照参考实现 `truncate_text`）——
 * 调用方看到空串就知道这次别打接口了。
 */
export function truncate(text, limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return "";
  return String(text ?? "").slice(0, n);
}

/* ================= 四、三条总结链 ================= */

/*
 * 从这里往下是打网络的部分：三条总结链（记忆 / 备忘录 / 日记）。
 *
 * 三条链共同的规矩，一条都不能破：
 *
 * 1. **都不发预设**（用户原话：「以上所有的都不发送预设。」）。
 *    所以这里没有 resolvePreset，也没有 buildPrompt —— 三条链自己拼消息，
 *    顺序由用户的规范钉死（见每个 build*Messages 上面那张表）。
 *    生成参数也不取预设的 params：那份是调「怎么跟人说话」的，
 *    总结要的是稳定输出。
 *
 * 2. **每一段都用 XML 标签包裹**，包法和注入那边共用 prompt.js:wrap。
 *
 * 3. **失败绝不清空**。三个 summarize* 都是「先拿到结果、校验通过，
 *    才调 commit*」。中间任何一步抛错，待总结文件一个字节都不动 ——
 *    调用方接住错误只该调 markFail（只改计数）。
 *
 * 4. 顶部和底部的位置是硬性的：顶部必须是提示词，底部必须是待总结的内容。
 *    中间那几段缺了就整段不出现（wrap 对空正文返回空串），但**顺序不变**。
 */

/**
 * 待总结的流水文本，超长时**取尾巴**。
 *
 * 待总结现在存的就是一份 txt 流水（形状和 diary_log.txt 一样，见
 * memorystore.js 的「待总结缓存」那一节），所以这里不再有「渲染」这一步 ——
 * 读出来什么样就发过去什么样，只在超长时截一下。
 *
 * 取尾不取头：越靠近现在的对话越该被总结进去。被切掉的那部分仍然留在
 * 待总结文件里（这里只是这一次少喂一点），下一次连着一起总结。
 *
 * 截断按**整行**对齐：从中间切开会留下半行残句（`09:45:18 | [Nik`），
 * 模型读到的第一条就是坏的。宁可少喂一行。
 */
export function pendingText(text, maxChars) {
  const full = String(text ?? "").replace(/\r\n/g, "\n").trim();
  const n = Number(maxChars) || 0;
  if (!(n > 0) || full.length <= n) return full;
  const tail = full.slice(-n);
  const cut = tail.indexOf("\n");
  return cut >= 0 ? tail.slice(cut + 1) : tail;
}

/**
 * 三条链共用的几段中间内容：角色人设 / 用户人设 / 世界书。
 *
 * 世界书用**待总结的那段文本**去扫关键词 —— 总结的是这批对话，
 * 该被激活的就是这批对话里提到的设定。扫不出来就是空串，那一段不出现。
 *
 * `activate` 要的是 `{role, content}[]`，这里把整段塞成一条 user 消息喂进去：
 * 世界书只看文本内容，不看是谁说的。
 */
function commonBlocks(config, role, scanText, books) {
  const user = resolveUser(config, role);
  const vars = { char: role?.name ?? "", user: user?.name ?? "", sep: "" };
  const fill = (text) => applyVars(text, vars).trim();

  let world = "";
  if (books.length) {
    const hit = activate(books, [{ role: "user", content: scanText }]);
    // depth 类条目在这里没有「插进第几条上文」可言（压根没有多轮上文），
    // 一并并进这一段 —— 丢掉它们会让常驻设定在总结时凭空消失
    world = [hit.before, ...[...hit.depths.values()].map((d) => d.content), hit.after]
      .filter((s) => s && s.trim())
      .join("\n");
  }

  return {
    vars,
    fill,
    char: wrap("Character", fill(role?.description)),
    user: wrap("User", fill(user?.description)),
    world: wrap("World_Info", world),
  };
}

/** 把几段拼成一整段文本，空段自动消失。 */
function joinBlocks(parts) {
  return parts.filter((s) => s && s.trim()).join("\n\n");
}

/**
 * 三条链的消息数组。**拼好的那一整段走 user，不走 system。**
 *
 * 这里曾经只发一条 `role: "system"`，在 OpenAI 原生接口上没问题，但打到
 * 转 Gemini 的中转站上会 400：
 *
 *     记忆总结（… gemini-3.1-pro） 返回 400：* ***.contents: contents is not specified
 *
 * `contents` 是 Gemini 自己的字段名 —— 中转站把 OpenAI 的 system 消息翻成
 * Gemini 的 `systemInstruction`，翻完 `contents` 就一条不剩，于是它自己先
 * 把请求判死了，模型压根没看到。聊天那条路不会碰上是因为它总带着真的
 * 用户消息（见 prompt.js），只有总结链是「全部内容都在一条 system 里」。
 *
 * 所以这里换成 user：
 *  - 对 OpenAI 兼容接口，system 和 user 的差别对「读一段材料、按格式吐一段
 *    结果」这种任务可以忽略，而顺序、标签、内容一个字都没变；
 *  - 对转 Gemini 的中转站，这一条正好落进 `contents`，请求就成立了。
 *
 * 拼装收在这一个函数里，三条链共用 —— 不然哪天再加一条链，又会有人写成
 * system，同一个 400 再来一遍。
 *
 * 导出出去，是因为「哪天再加一条链」已经发生了：线下模式的小/大总结
 * （offline.js）也是「全部内容都在一段里」这个形状，正是会踩上面那个 400 的
 * 那类请求。它 import 这一个函数，而不是自己再写一遍 `[{role:"system"}]`。
 */
export function summaryMessages(content) {
  return [{ role: "user", content }];
}

/**
 * 总结用的生成参数：不取预设的，固定一份稳一点的。
 * 线下模式的两份总结也用这一份（offline.js）—— 总结要的是稳，
 * 剧情正文才要有变化，两者用的参数本来就不该是同一份。
 */
export const SUMMARY_PARAMS = { temperature: 0.6, topP: 1 };

/**
 * 记忆库这三条链（记忆总结 / 备忘录 / 日记）单独给 10 分钟，不用 llm.js 那个
 * 60 秒的默认值。
 *
 * 三条链有同一组特征，正好是最该放宽的那种：
 *  - **输入很长**：喂进去的是一整段流水，几万字是常态（实测有过 45000 字的
 *    日记流水）。光把请求体传上去、让上游读完就要不少时间。
 *  - **输出也长**：写一篇日记不是回一句话，几百到上千字。
 *  - **thinking 模型很常见**：用户会拿 Claude 的 thinking 档来写日记，
 *    那种模型思考几分钟才吐第一个字是正常的，不是卡住。
 *  - **没人盯着**：定时日记在后台跑，慢一点没人难受；而超时的代价很实在 ——
 *    这一次算白花，流水继续攒着，下次输入更长、更容易再超时，滚雪球。
 *
 * 对照一下另外两档就知道这个数量级是合理的：识图/听音是 180 秒（大请求体），
 * 「测试连接」是 30 秒（用户正盯着按钮）。这三条比识图更长、更没人等。
 *
 * 线下模式的小/大总结也用这一档（offline.js）：输入是几十轮剧情正文，
 * 比记忆流水还长，同样没人盯着。
 */
export const SUMMARY_TIMEOUT = 600000;

/**
 * 被内容安全拦下时换几次说法再试。见 llm.js 的 SAFETY_NUDGES。
 *
 * 只有这四条总结链传这个（三条在这个文件里，线下那条在 offline.js）。正常聊天
 * **刻意不传**：角色在剧情里说「抱歉，我不能这样」是台词，不是拒答。
 *
 * 为什么总结这条路值得重试：喂进去的是几万字的聊天流水，里面有什么内容不由我们
 * 决定，而模型的安全阈值又飘 —— 同一份材料换个说法（「这是客观的第三人称事实
 * 摘要，不要复述敏感细节」）经常就过去了。而失败的代价很实在：这一轮白花，
 * 流水继续攒着，下次输入更长、更容易再被拦，滚雪球。
 *
 * 用尽还不行就是失败 —— llm.js 会抛，这边的 markFail 接住，pending 一个字节
 * 都不清、备忘录一个字都不改。绝不把那句道歉当成合格的总结写进去。
 */
export const SUMMARY_REFUSAL_RETRIES = 3;

/**
 * 解析三条链各自的模型。没配 / 引用失效都抛错 —— 调用方接住记 markFail。
 * 抛的话里带上是哪一条链，用户在日志里一眼能看出该去配哪个。
 */
function chainEndpoint(config, ref, what) {
  if (!ref?.provider || !ref?.modelId) {
    throw new Error(`还没给「${what}」选模型（记忆库 → 设置里选一个）`);
  }
  const endpoint = resolveEndpoint(config, ref);
  if (!endpoint) throw new Error(`「${what}」选的模型引用失效了（服务商或模型被删/被关）`);
  return endpoint;
}

/* ---------------- 记忆 ---------------- */

/**
 * 生成记忆的消息，顺序照用户的规范（从上到下，顶/底不能动）：
 *
 *   生成记忆提示词（顶部必须是这个）
 *   角色人设
 *   用户人设
 *   世界书
 *   待总结记忆的文件（底部必须是这个）
 *
 * 待总结那段用 `<memories>` 包 —— 用户特意点名了这个标签
 * （「注意：记忆需要使用 <memories></memories> 进行包裹」）。
 *
 * 导出出去是给测试用的：三条链最容易出错的就是顺序，而顺序不打网络就能断言。
 */
export function buildMemoryMessages(config, role, log) {
  const cfg = config?.memories?.memory ?? {};
  const text = pendingText(log, cfg.maxInputChars ?? 4000);
  const books = worldBooksFor(config, role);
  const b = commonBlocks(config, role, text, books);

  return summaryMessages(
    joinBlocks([
      wrap("生成记忆提示词", b.fill(cfg.prompt)),
      b.char,
      b.user,
      b.world,
      wrap("memories", text),
    ])
  );
}

/**
 * 攒够的那批对话总结成一条记忆，存下来。
 *
 * 顺手把向量也算了（`只有记忆需要使用向量模型`）—— 但**算不出来不算失败**：
 * 向量没配 / 打不通时照样存正文，`embedding` 留 null，这条记忆只是暂时
 * 进不了语义检索，近 N 天那一路照样拿得到它。为一次向量失败把总结好的
 * 正文扔掉才是真的丢东西。
 *
 * @returns {Promise<{content: string, embedded: boolean}>}
 * @throws {Error} 总结本身失败时抛，调用方**绝不清空** pending
 */
export async function summarizeMemory(config, role, key) {
  const cfg = config?.memories?.memory ?? {};
  const pending = readPending("memory", key);
  if (!pending.text.trim()) throw new Error("没有待总结的对话");

  const endpoint = chainEndpoint(config, cfg.model, "生成记忆");
  const messages = buildMemoryMessages(config, role, pending.text);

  const raw = await chatCompletion(endpoint, messages, {
    label: endpoint.label ? `记忆总结（${endpoint.label}）` : "记忆总结",
    params: SUMMARY_PARAMS,
    timeout: SUMMARY_TIMEOUT,
    retryOnRefusal: SUMMARY_REFUSAL_RETRIES,
  });
  const content = raw.trim();
  if (!content) throw new Error("模型返回了空的总结");

  // 向量单独一层 try：算不出来只是少了语义检索，不该连累已经生成好的正文
  let embedding = null;
  const ref = cfg.embedModel;
  if (ref?.provider && ref?.modelId) {
    try {
      const vecEndpoint = resolveEndpoint(config, ref);
      if (!vecEndpoint) throw new Error("向量模型引用失效了（服务商或模型被删/被关）");
      embedding = await embedText(vecEndpoint, truncate(content, cfg.maxInputChars ?? 4000));
    } catch (e) {
      logWarn("记忆库", `记忆存下来了，但向量没算成（这条暂时不参与语义检索）：${e.message}`);
    }
  }

  appendMemory(key, { content, keywords: extractKeywords(content), embedding });
  // 存成了才清空，而且清空前会先备份 —— 见 memorystore.js:backupThenClear
  commitPending("memory", key);
  logInfo("记忆库", `${key} 新增一条记忆（${content.length} 字）${embedding ? "，带向量" : ""}`);
  return { content, embedded: Boolean(embedding) };
}

/* ---------------- 备忘录 ---------------- */

/**
 * 生成备忘录的消息，顺序照用户的规范：
 *
 *   生成备忘录的提示词（顶部必须是这个）
 *   角色人设
 *   用户人设
 *   世界书
 *   近N天记忆
 *   待总结备忘录的文件（底部必须是这个）
 *
 * 两处硬约束：
 * - **不注入 `<memories>` 原文**。用户钉死了「严禁将 <memories> 的内容也加入到
 *   备忘录里，备忘录不是记忆」，所以近 N 天记忆这一段用的是
 *   `<近N天记忆>` 标签、内容是纯文本行，提示词里也写了一遍。两道都得有 ——
 *   光靠提示词管不住模型。
 * - 提示词里的 `{current_time}` 是单花括号（用户原文），在这里换成当时的系统
 *   时间。不换的话「明天」「三天后」没有基准可算。
 */
export function buildMemoMessages(config, role, key, log, now = new Date()) {
  const cfg = config?.memories?.memo ?? {};
  const memCfg = config?.memories?.memory ?? {};
  const text = pendingText(log, cfg.maxInputChars ?? 4000);
  const books = worldBooksFor(config, role);
  const b = commonBlocks(config, role, text, books);

  // 近 N 天记忆：只给纯文本行，不给 <memories>（见上面第一条硬约束）
  const inject = memCfg.recentInject ?? {};
  const recent = inject.enabled === false
    ? []
    : filterRecent(readMemories(key), inject.days ?? 3, now.getTime());

  const prompt = b.fill(cfg.prompt).replace(/\{current_time\}/g, stamp(now));

  return summaryMessages(
    joinBlocks([
      wrap("生成备忘录提示词", prompt),
      b.char,
      b.user,
      b.world,
      wrap("近N天记忆", formatRecentLines(recent)),
      wrap("现有备忘录", readMemo(key)),
      wrap("待总结备忘录", text),
    ])
  );
}

/**
 * 攒够的那批对话更新成一份新的备忘录。
 *
 * 备忘录是**整份覆盖**的（模型拿到现有那份 + 新对话，吐一份完整的新清单），
 * 覆盖之前 memorystore 会先留一份 `.bak`。
 *
 * @throws {Error} 失败时抛，调用方**绝不清空** pending
 */
export async function summarizeMemo(config, role, key, now = new Date()) {
  const cfg = config?.memories?.memo ?? {};
  const pending = readPending("memo", key);
  if (!pending.text.trim()) throw new Error("没有待总结的对话");

  const endpoint = chainEndpoint(config, cfg.model, "生成备忘录");
  const messages = buildMemoMessages(config, role, key, pending.text, now);

  const raw = await chatCompletion(endpoint, messages, {
    label: endpoint.label ? `备忘录（${endpoint.label}）` : "备忘录",
    params: SUMMARY_PARAMS,
    timeout: SUMMARY_TIMEOUT,
    // 备忘录是**整份覆盖**的，一句道歉能把用户攒了几个月的清单冲干净。
    // 这条是四条链里最不能容忍「把拒答当成结果」的一条
    retryOnRefusal: SUMMARY_REFUSAL_RETRIES,
  });
  const text = raw.trim();
  if (!text) throw new Error("模型返回了空的备忘录");

  writeMemo(key, text);
  commitPending("memo", key);
  logInfo("记忆库", `${key} 备忘录更新了（${text.length} 字）`);
  return { content: text };
}

/* ---------------- 日记 ---------------- */

/** `2026年09月09日 14:09`，备忘录提示词里的 `{current_time}` 用这个格式。 */
function stamp(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}年${p(d.getMonth() + 1)}月${p(d.getDate())}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 流水一行的拼法搬到了 memorystore.js —— 改成 txt 之后**存的时候**就要拼行，
 * 而这个文件 import 了 llm / prompt 一大串，store 反过来引就成环了。
 * 这里原样转出去，老的引用（memoryhooks、测试脚本）照常能用。
 */
export { diaryLogLine };

/**
 * 日记提示词里那两个整段变量。
 *
 * 开关关着时**整行删掉**（连同那一行的换行），不是留个空串 ——
 * 提示词本体是 YAML，留一行空的会在结构里空出一格。
 */
function fillDiaryPrompt(cfg, fill) {
  let text = String(cfg.prompt ?? "");
  const put = (name, on, body) =>
    text.replace(
      new RegExp(`^[ \\t]*\\{\\{\\s*${name}\\s*\\}\\}[ \\t]*\\r?\\n?`, "gm"),
      on && String(body ?? "").trim() ? `${body}\n` : ""
    );
  text = put("writing_style_reference", cfg.styleEnabled, cfg.styleRef);
  text = put("to_do_list", cfg.todoEnabled, cfg.todoPrompt);
  return fill(text);
}

/**
 * 生成日记的消息，顺序照用户的规范：
 *
 *   日记提示词项目（顶部必须是这个）
 *   角色人设
 *   用户人设
 *   世界书
 *   记忆库中的近N天记忆
 *   备忘录
 *   当前天气
 *   {{char}}_diary_log.txt（底部必须是这个）
 *
 * 天气：**什么时候生成就注入什么时候的天气**，所以由调用方在生成前现拿一次
 * （buildEnv 自己吞掉一切错误返回空串）。拿不到就是空串，那一段整个不出现
 * —— 用户的原话是「如果天气报错的话就不注入」。
 *
 * 世界书这条链单独一套：默认跟角色已绑的走，也可以在设置里另选几本
 * （useRoleWorldBooks / worldBookRefs）。
 */
export function buildDiaryMessages(config, role, key, opts = {}) {
  const cfg = config?.memories?.diary ?? {};
  const memCfg = config?.memories?.memory ?? {};
  const now = opts.now ?? new Date();
  const log = String(opts.log ?? readDiaryLog(key));

  // 日记绑的世界书：默认角色那份，否则按 worldBookRefs 另挑
  const books = cfg.useRoleWorldBooks === false
    ? (config?.worldBooks ?? []).filter(
        (b) => b?.enabled && (cfg.worldBookRefs ?? []).includes(b.id)
      )
    : worldBooksFor(config, role);
  const b = commonBlocks(config, role, log, books);

  const inject = memCfg.recentInject ?? {};
  const recent = inject.enabled === false
    ? []
    : filterRecent(readMemories(key), inject.days ?? 3, now.getTime());

  // 生成日记时回看自己近 N 天的日记（默认近 1 天），让文风和昨天接得上
  const self = cfg.selfInject ?? {};
  const past = self.enabled === false
    ? ""
    : readRecentDiaries(key, self.days ?? 1, now)
        .map((d) => `【${d.date}】\n${d.text.trim()}`)
        .join("\n\n");

  // 字数要求写成单独一段，而不是塞进提示词正文 —— 用户可能改过整段提示词，
  // 往里面 replace 会碰坏他写的东西
  const limit = cfg.limit ?? {};
  const words = limit.enabled
    ? `这篇日记的字数要求：不少于 ${limit.min} 字，不超过 ${limit.max} 字。`
    : "";

  return summaryMessages(
    joinBlocks([
      wrap("日记提示词", fillDiaryPrompt(cfg, b.fill)),
      b.char,
      b.user,
      b.world,
      wrap("近N天记忆", formatRecentLines(recent)),
      wrap("备忘录", readMemo(key)),
      wrap("近N天日记", past),
      wrap("当前天气", b.fill(opts.weather ?? "")),
      wrap("字数要求", words),
      wrap(`${role?.name || "char"}_diary_log`, log),
    ])
  );
}

/**
 * 生成一篇日记。
 *
 * 字数不够时的重试（用户的规范第 6 条）：开了 `limit.retry` 才重打，
 * 最多 `retries` 次（默认 3）。**用完还不够就抛错**，把原因原样带出去
 * —— 用户的原话是「达不到三次则确认生成失败，并会告诉用户失败的原因，
 * 且不会删除 {{char}}_diary_log.txt」。所以这里的 throw 是有意的：
 * 抛出去就走不到下面的 commitDiaryLog，流水一个字节都不会少。
 *
 * 上限（`limit.max`）**不重试**：写多了是能用的，重打一次纯粹是再花一次钱。
 *
 * 开了字数下限但**没开重试**时，写短了也照样收下 —— 那种配置下只打一次，
 * 判失败的话这篇日记永远生不出来（每次都短、每次都throw），流水只会越攒越长。
 * 不重试的意思是「别多花钱」，不是「宁可不要」；字数要求那时候只写在提示词里。
 *
 * @param {{now?: Date, weather?: string}} [opts] weather 由调用方现拿
 *        （什么时候生成就注入什么时候的天气），拿不到传空串
 * @returns {Promise<{file: string, text: string, tries: number}>}
 * @throws {Error} 失败时抛，调用方**绝不清空** diary_log.txt
 */
export async function generateDiary(config, role, key, opts = {}) {
  const cfg = config?.memories?.diary ?? {};
  const now = opts.now ?? new Date();
  const log = readDiaryLog(key);
  if (!log.trim()) throw new Error("日记流水是空的，这段时间没有聊天记录");

  const endpoint = chainEndpoint(config, cfg.model, "生成日记");
  const messages = buildDiaryMessages(config, role, key, { ...opts, now, log });
  const label = endpoint.label ? `日记（${endpoint.label}）` : "日记";

  const limit = cfg.limit ?? {};
  const min = limit.enabled ? Math.max(0, limit.min ?? 0) : 0;
  // 开了字数下限且开了重试才多打几次；否则就一次
  const maxTries = min && limit.retry ? Math.max(1, limit.retries ?? 3) : 1;

  let text = "";
  let tries = 0;
  let last = 0;
  for (; tries < maxTries; tries += 1) {
    const raw = await chatCompletion(endpoint, messages, {
      label,
      params: SUMMARY_PARAMS,
      timeout: SUMMARY_TIMEOUT,
      retryOnRefusal: SUMMARY_REFUSAL_RETRIES,
    });
    text = raw.trim();
    if (!text) throw new Error("模型返回了空的日记");
    last = text.length;
    if (text.length >= min) break;
    // 只打一次的那种配置：短就短了，收下（理由见上面的文档注释）
    if (maxTries === 1) break;
    logWarn("记忆库", `日记只有 ${text.length} 字，不够 ${min} 字，第 ${tries + 1} 次重试`);
    text = "";
  }

  if (!text) {
    // 这句会原样发给用户（imessage.js:notifyFailure），所以要说清差多少
    throw new Error(
      `连着 ${maxTries} 次都写不够 ${min} 字（最后一次 ${last} 字），` +
        `这次不算生成成功，日记流水没有删`
    );
  }

  const file = writeDiary(key, localDate(now), text);
  // 写成了才清流水，而且清之前先备份。上面任何一条 throw 都走不到这里
  commitDiaryLog(key);
  logInfo("记忆库", `${key} 生成了一篇日记 ${file}（${text.length} 字，打了 ${tries + 1} 次）`);
  return { file, text, tries: tries + 1 };
}

/**
 * 生成日记要用的天气：**生成那一刻**现查一次。
 *
 * 单独包一层是为了兑现「天气报错就不注入」—— buildEnv 自己已经吞掉了所有
 * 错误返回空串，这里再兜一次，顺便把「角色没开天气」也折成同一个空串。
 */
export async function diaryWeather(config, role) {
  try {
    const { weather } = await buildEnv(role, config?.weatherApi);
    return weather ?? "";
  } catch {
    return "";
  }
}
