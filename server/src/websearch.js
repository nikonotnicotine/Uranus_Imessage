/**
 * 联网搜索。
 *
 * 模型在回复里写 `[搜索:关键词]`，这里把它拦下来真的去搜一次，把结果塞回
 * 提示词，再问一次模型 —— 对方只会收到第二次的回复，看不见中间这一趟。
 *
 * **注入必须省。** 搜索结果是外部文本，不收着的话一轮能灌进去好几千 token，
 * 而且每一轮都还在上下文里躺着。所以从四个方向砍：
 *   1. 搜几次：一轮里最多认几个 [搜索:…]（角色可调，默认 2）
 *   2. 条数：每次搜最多要几条（角色可调，默认 2）
 *   3. 每条长度：标题 MAX_TITLE 字、摘要 MAX_SNIPPET 字，超了截断加「…」
 *   4. 总量：拼完再按总字数硬切一刀（角色可调，默认 800），兜底
 * 都是**字符数**不是 token 数 —— 本地没有 tokenizer，中文按 1 字≈1 token
 * 估，英文会高估（对我们有利，宁可少给）。
 * 前三道乘起来就是上限：2 × 2 × 240 ≈ 960 字，第四道再压到 800。
 *
 * **搜索结果不进存档。** 和天气一个道理（见 env.js 文件头）：它是只对这一轮
 * 有意义的瞬时值，进存档就要在后面每一轮里重发一遍过期内容。存档里留的是
 * 模型最终那条回复，不含 <搜索结果>，也不含它自己写的 [搜索:…]。
 *
 * **数据源。** 默认 DuckDuckGo 的 HTML 端点：免费、不要密钥、不要注册。
 * 它不是官方 API，返回的是网页，得自己扒 —— 所以扒不动的时候要**安静地
 * 退化**（返回空结果、让模型照常回答），不能让整轮对话失败。
 * 想要稳定的话在「连接」面板里填 Tavily 或 Brave 的密钥，有密钥就走密钥那条。
 * Tavily 那条还能挑保留哪几个字段、卡一个相关度下限，见 searchTavily。
 *
 * 密钥全局一份，存 data.config.json，和 weatherApi 同一个理由
 * （backup.js 的 buildBundle 会把 roles 原样拷进备份，密钥不能挂在角色上）。
 */

import { logDebug, logInfo, logWarn } from "./logs.js";
import { whyNetwork } from "./net.js";

/** 搜一次最多等多久。用户在 iMessage 那头干等着，不能太长。 */
const SEARCH_TIMEOUT = 12000;

/**
 * 三个额度的默认值和上下限。
 *
 * 用户能在「角色 → 单独配置 → 联网搜索」里调这三个（role.webSearch），
 * 所以下面那些 MAX_* 只是**兜底**：角色上没配、或者配了个离谱的值时用它们。
 *
 * 上限不是拍脑袋定的 —— 三个乘起来就是每轮往提示词里灌多少字。
 * 顶格 5 次 × 10 条 × 4000 字这种配法本身就该让人犹豫一下，界面上写了估算。
 *
 * 必须声明在下面那几个 const 之前 —— const 不提升，反过来写模块一加载就炸。
 */
export const LIMITS = {
  queries: { def: 2, min: 1, max: 5 },
  results: { def: 2, min: 1, max: 10 },
  chars: { def: 800, min: 200, max: 4000 },
};

/** 一轮里最多搜几次的兜底值 —— 模型一口气写五个 [搜索:…] 时只认前这么多个。 */
export const MAX_QUERIES = LIMITS.queries.def;

/** 每条标题 / 摘要的字数上限。这两个不给调 —— 单条太长时截断的位置。 */
const MAX_TITLE = 60;
const MAX_SNIPPET = 180;

/** 日期那一小截。认得出的会被格式化成 YYYY-MM-DD，认不出的原样截到这个长度。 */
const MAX_DATE = 20;

/**
 * Tavily 默认保留哪几个字段。
 *
 * 和 LIMITS 一样是**兜底**：config.js:normalizeTavilyFields 已经规范过一遍，
 * 这里再兜一次是因为 runSearch 也可能被直接调（离线脚本、以后别的入口）。
 */
const TAVILY_FIELDS = { publishedDate: true, title: true, content: true };

/** Tavily 相关度的默认下限。低于这个分的结果直接扔掉，0 = 不过滤。 */
const TAVILY_MIN_SCORE = 0.65;

/** 关键词本身也要收着，防止模型把整段话塞进去当查询词。 */
const MAX_QUERY_LEN = 80;

/**
 * 认出模型写的搜索标记。
 *
 * 全角冒号和方括号都认（iOS 输入法很容易打出全角），关键词里不允许出现
 * 右方括号 —— 否则 `[搜索:a]b]` 会把 `a]b` 整个吞进去。
 */
const SEARCH_TAG = /[[［]\s*搜索\s*[:：]\s*([^\]］]{1,200})\s*[\]］]/g;

/**
 * 成对的 XML 标签块：`<thinking>…</thinking>`、预设里自定义的 `<推演>…</推演>` 之类。
 *
 * 标签名首字符限定成字母或汉字，所以 `我 <3 你` 这种不会被当成标签。
 * 反向引用 `\1` 保证闭合标签同名，嵌套时只认最外层那一对。
 */
const XML_BLOCK = /<([A-Za-z一-鿿][^\s>/]*)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/g;

/**
 * 扒掉 XML 标签块，只留标签外面的正文。
 *
 * **为什么要有这一步。** 思维链里模型经常复述格式本身 —— 实测它在
 * `<thinking>` 里写「触发联网搜索的格式是 [搜索:关键词]」，然后后端真的去搜了
 * 「关键词」这三个字，白白打一次上游、还往提示词里灌了三条没用的结果。
 *
 * 规则统一成：**标签里的字是模型说给自己听的，不算数**。只有标签外面写的
 * 标记才当成真的要执行。这条对整个「消息格式与功能」都成立，眼下只有搜索
 * 这一条的链路接上了，语音 / 表情包 / 图片以后接的时候也走这里。
 *
 * 只处理成对标签 —— 和 sessions.js:THINK_PATTERNS 一个口径。开着没闭合的
 * `<thinking>` 不动它，那种情况下整条回复本来就没正文可发。
 */
export function stripXmlBlocks(text) {
  return String(text ?? "").replace(XML_BLOCK, "");
}

/**
 * 同一件事的另一种问法：这些 XML 标签块在原文里各占哪一段。
 *
 * 搜索只要关键词，扒干净了直接跑正则就行；语音和图片不一样 —— media.js 要把
 * 一条回复**按位置**切成「文字 / 语音 / 图片」几段，扒掉标签块会让后面所有
 * 下标都对不上。所以那边改成「照原文扫，落在这些区间里的标记不算数」。
 *
 * 规则和 stripXmlBlocks 完全一致（同一个 XML_BLOCK），只在这一处定义。
 *
 * @returns {[number, number][]} 每段的 [起, 止)，按出现顺序、互不重叠
 */
export function xmlBlockRanges(text) {
  const src = String(text ?? "");
  const out = [];
  // matchAll 会自己复制一份正则，不会动 XML_BLOCK 的 lastIndex
  for (const m of src.matchAll(XML_BLOCK)) out.push([m.index, m.index + m[0].length]);
  return out;
}

/** 截断到 n 个字符，截了就加省略号。 */
function clip(text, n) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * 把一个额度收进合法范围。
 *
 * 配置那边（config.js:normalizeWebSearch）已经收过一遍了，这里再收一次是
 * 因为这三个函数也可能被直接调（离线脚本、以后的别的入口），不想指望调用方。
 */
function clampLimit(v, { def, min, max }) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/**
 * 从模型的回复里挖出搜索请求。
 *
 * 只看**标签外面**的正文（见 stripXmlBlocks）—— 思维链里复述格式写出来的
 * `[搜索:关键词]` 不算数。
 *
 * @param {string} text 模型的回复
 * @param {number} [max] 最多认几个，默认 MAX_QUERIES（角色上能调）
 * @returns {string[]} 去重后的关键词
 */
export function parseSearchQueries(text, max = MAX_QUERIES) {
  const cap = clampLimit(max, LIMITS.queries);
  const out = [];
  const seen = new Set();
  for (const m of stripXmlBlocks(text).matchAll(SEARCH_TAG)) {
    const q = clip(m[1], MAX_QUERY_LEN);
    const key = q.toLowerCase();
    if (!q || seen.has(key)) continue;
    seen.add(key);
    out.push(q);
    if (out.length >= cap) break;
  }
  return out;
}

/** 回复里还剩没剩别的字（除了搜索标记之外）。 */
export function stripSearchTags(text) {
  return String(text ?? "").replace(SEARCH_TAG, "").trim();
}

/* ================= 数据源 ================= */

/**
 * HTML 实体反转义。
 *
 * DuckDuckGo 的 HTML 端点返回的是网页，标题和摘要里带实体。只认下面这些
 * 命名实体 + 数字实体，够用；漏掉几个冷门的最多是显示上难看一点，
 * 不值得为此引一个解析库。
 *
 * 键里不含 & —— 正则那边用 \x26 匹配，省得源码里到处是转义。
 */
const ENTITIES = {
  quot: '"',
  apos: "'",
  nbsp: " ",
  lt: "<",
  gt: ">",
  amp: "&",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

function unescapeHtml(s) {
  // 一趟扫完，不是链式 replace —— 链式的话 amp 那步会把前面解出来的
  // 字面量再解一次（&amp;lt; 本该留成 &lt;，却会变成 <）
  return String(s ?? "").replace(/\x26(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : Number(body.slice(1));
      // 认不出的码位原样留着，别塞个 � 进去
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    const hit = ENTITIES[body.toLowerCase()];
    return hit === undefined ? whole : hit;
  });
}

/** 扒掉标签，留纯文本。 */
function stripTags(html) {
  return unescapeHtml(String(html ?? "").replace(/<[^>]*>/g, ""));
}

/**
 * DuckDuckGo 的 HTML 端点（无密钥、无注册）。
 *
 * 这不是官方 API，是给无脚本浏览器用的降级页面 —— 它随时可能改版或者
 * 给我们返回验证码页。所以这里**任何解析失败都返回空数组**，不抛错：
 * 搜不到就让模型照常回答，比整轮对话崩掉强。
 */
async function searchDuckDuckGo(query, limit) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(SEARCH_TIMEOUT),
    headers: {
      // 不带 UA 的话对方直接返回空页面
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  const out = [];
  /*
   * 结果块的形状（class 上还挂着别的名字，顺序也不保证）：
   *   <div class="links_main links_deep result__body">
   *     <a class="result__a" href="…">标题</a>
   *     <a class="result__snippet" href="…">摘要</a>
   *
   * 所以三处都按「class 属性里**含有**这个词」来找，不能拿
   * `class="result__body"` 去精确匹配 —— 那个字符串在真实页面里压根不出现
   * （踩过：HTTP 200、页面里明明有 10 条结果，却一条都扒不出来）。
   */
  const blocks = html.split(/class="[^"]*\bresult__body\b/).slice(1);
  for (const block of blocks) {
    const title = /class="[^"]*\bresult__a\b[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(block)?.[1];
    const snippet = /class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(block)?.[1];
    const t = stripTags(title);
    if (!t) continue;
    out.push({ title: t, snippet: stripTags(snippet) });
    if (out.length >= limit) break;
  }
  return { items: out };
}

/** 把相关度下限收进 0~1。认不出的数（老配置里压根没有）回落到默认值。 */
function clampScore(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return TAVILY_MIN_SCORE;
  return Math.min(1, Math.max(0, n));
}

/**
 * Tavily 给的 published_date 收拾成一小截。
 *
 * 它给的是 RFC 1123（`Tue, 05 Sep 2026 00:00:00 GMT` 那种），认得出就统一
 * 成 `YYYY-MM-DD` —— 短、好读、模型也不会误解。认不出的原样截一截照抄，
 * 与其猜错不如把原文给它。
 */
function fmtDate(v) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : clip(s, MAX_DATE);
}

/**
 * Tavily：给 LLM 用的搜索 API，直接返回摘要好的正文。要密钥。
 *
 * 这条路比扒 HTML 稳，摘要质量也高（它自己做过一遍抽取）。每条结果它给的是
 * `{title, url, content, score, published_date}`，我们按用户勾的字段挑
 * （config.searchApi.tavily.fields），再按相关度卡一刀。
 *
 * **published_date 不是每条都有。** 那是新闻类结果才带的字段，普通网页大多
 * 没有 —— 勾上也只是「有就带、没有就不占位」，不会留个空括号。想让每条都有
 * 日期得把 topic 换成 news，那等于把搜索范围锁死在新闻上，代价比收益大，不做。
 *
 * **相关度过滤是在我们这边做的**，不是请求参数：Tavily 没有 min_score，
 * 只在每条结果上给一个 0~1 的 score。所以「要几条」还是 max_results 说了算，
 * 过滤完可能一条不剩 —— 那时候和「没搜到」一样处理，日志里会写明是被卡掉的，
 * 不然看到「拿到 0 条」只会以为是网络问题。
 *
 * @param {object} [opts] `{fields, minScore}`，缺了用上面那两个兜底常量
 * @returns {Promise<{items: object[], dropped: number}>} dropped = 被相关度卡掉几条
 */
async function searchTavily(query, key, limit, opts = {}) {
  const fields = { ...TAVILY_FIELDS, ...(opts.fields ?? {}) };
  const minScore = clampScore(opts.minScore);

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    signal: AbortSignal.timeout(SEARCH_TIMEOUT),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      query,
      max_results: limit,
      // 让它自己压一遍长度，我们这边还会再截一刀
      search_depth: "basic",
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  const all = (Array.isArray(data?.results) ? data.results : []).slice(0, limit);
  // 没给分的条目不算「低于下限」—— 宁可留着，不能因为对方少给一个字段就全砍光
  const kept = all.filter((r) => {
    const score = Number(r?.score);
    return !(minScore > 0 && Number.isFinite(score) && score < minScore);
  });

  const items = kept
    .map((r) => ({
      title: fields.title ? String(r?.title ?? "") : "",
      snippet: fields.content ? String(r?.content ?? "") : "",
      date: fields.publishedDate ? fmtDate(r?.published_date) : "",
    }))
    // 勾的那几个字段这条一个都没有：留下来就是一行编号，白占地方
    .filter((r) => r.title || r.snippet || r.date);

  return { items, dropped: all.length - kept.length };
}

/** Brave Search API。要密钥。 */
async function searchBrave(query, key, limit) {
  const url =
    "https://api.search.brave.com/res/v1/web/search" +
    `?q=${encodeURIComponent(query)}&count=${limit}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(SEARCH_TIMEOUT),
    headers: { Accept: "application/json", "X-Subscription-Token": key },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const items = (Array.isArray(data?.web?.results) ? data.web.results : [])
    .slice(0, limit)
    .map((r) => ({ title: String(r?.title ?? ""), snippet: stripTags(r?.description) }))
    .filter((r) => r.title || r.snippet);
  return { items };
}

/**
 * 挑一条数据源。有密钥优先用密钥那条，都没有就用 DuckDuckGo。
 *
 * `warn` 是配得能用、但配法本身有问题时的一句提醒（现在只有 Tavily 那条会给）——
 * 不拦着不报错，只在日志里说一声，不然结果莫名其妙全空、没人知道为什么。
 *
 * @returns {{name: string, run: (q: string, n: number) => Promise<{items: object[], dropped?: number}>, warn?: string}}
 */
function pickSource(api) {
  const tavily = String(api?.tavily?.key ?? "").trim();
  if (api?.tavily?.enabled && tavily) {
    const fields = { ...TAVILY_FIELDS, ...(api.tavily.fields ?? {}) };
    const opts = { fields, minScore: api.tavily.minScore };
    return {
      name: "Tavily",
      run: (q, n) => searchTavily(q, tavily, n, opts),
      warn:
        fields.title || fields.content || fields.publishedDate
          ? undefined
          : "Tavily 的保留字段一个都没勾，搜到的每一条都会被丢掉（等于把搜索关了）",
    };
  }
  const brave = String(api?.brave?.key ?? "").trim();
  if (api?.brave?.enabled && brave) {
    return { name: "Brave", run: (q, n) => searchBrave(q, brave, n) };
  }
  return { name: "DuckDuckGo", run: searchDuckDuckGo };
}

/* ================= 对外 ================= */

/**
 * 搜一批关键词，拼成一段能直接注入提示词的文本。
 *
 * **不抛错**：某一条搜失败就跳过它并记一条日志，全都失败就返回空串 ——
 * 调用方拿到空串时让模型照常回答（提示词里会说明这次没搜到），
 * 而不是让对方收到一句「这条消息没回上来」。
 *
 * @param {string[]} queries 关键词，调用方已经用 parseSearchQueries 收过口
 * @param {object} api config.searchApi
 * @param {string} scope 日志作用域
 * @param {object} [limits] 角色上那三个额度（role.webSearch），缺了就用 LIMITS 的默认值
 * @returns {Promise<{text: string, hits: number, source: string, cut: boolean}>}
 *          text 是拼好的正文（不含外层标签），空串 = 什么都没搜到；
 *          cut = 有没有因为超字数被切过（日志里要说明，不然看不出结果为什么断在半句）
 */
export async function runSearch(queries, api, scope = "搜索", limits = {}) {
  const maxQueries = clampLimit(limits.maxQueries, LIMITS.queries);
  const perQuery = clampLimit(limits.maxResults, LIMITS.results);
  const maxChars = clampLimit(limits.maxChars, LIMITS.chars);

  const list = (Array.isArray(queries) ? queries : []).slice(0, maxQueries);
  if (!list.length) return { text: "", hits: 0, source: "", cut: false };

  const source = pickSource(api);
  if (source.warn) logWarn(scope, source.warn);
  const sections = [];
  let hits = 0;

  for (const query of list) {
    const startedAt = Date.now();
    let results = [];
    let dropped = 0;
    try {
      const got = await source.run(query, perQuery);
      results = got?.items ?? [];
      dropped = got?.dropped ?? 0;
    } catch (e) {
      /*
       * 搜不到不是致命错误：模型照常回答，只是没有实时信息。
       *
       * 但**原因要说清**。原来这行只把 e 交给 logWarn，标题里一个字的原因都
       * 没有 —— 明细档里是一句 `fetch failed` 加一坨栈。DuckDuckGo 国内直连不通，
       * 要么在系统层面开全局代理（Clash 的 TUN 模式），要么换 Tavily / Brave。
       */
      logWarn(scope, `搜「${query}」失败（${source.name}）：${whyNetwork(e, SEARCH_TIMEOUT)}，这条跳过`, e);
      continue;
    }
    const ms = Date.now() - startedAt;
    // 被相关度卡掉的要单独说一句，不然「拿到 0 条」看着像网络问题
    const cutNote = dropped ? `，${dropped} 条低于相关度下限被丢掉` : "";

    if (!results.length) {
      logInfo(scope, `搜「${query}」没有结果（${source.name}，${ms}ms${cutNote}）`);
      sections.push(`【${query}】没有搜到结果。`);
      continue;
    }

    hits += results.length;
    logInfo(scope, `搜「${query}」拿到 ${results.length} 条（${source.name}，${ms}ms${cutNote}）`);

    const lines = results
      .slice(0, perQuery)
      .map((r, i) => {
        const title = clip(r.title, MAX_TITLE);
        const snippet = clip(r.snippet, MAX_SNIPPET);
        // 日期只有 Tavily 那条路给，而且不是每条都有 —— 没有就不占位
        const head = r.date ? `(${r.date}) ${title}`.trim() : title;
        // 不放 URL：模型用不上，还平白多几十 token
        const body = [head, snippet].filter(Boolean).join(" —— ");
        return body ? `${i + 1}. ${body}` : "";
      })
      .filter(Boolean);
    sections.push(`【${query}】\n${lines.join("\n")}`);
  }

  if (!sections.length) return { text: "", hits: 0, source: source.name, cut: false };

  // 兜底：拼完再按总字数硬切一刀
  let text = sections.join("\n");
  let cut = false;
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}…（结果过长，已截断）`;
    cut = true;
    logDebug(scope, `搜索结果超过 ${maxChars} 字，已截断`);
  }

  return { text, hits, source: source.name, cut };
}