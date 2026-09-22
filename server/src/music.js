/**
 * 点歌：把模型写的 `[music:歌手-歌名]` 换成一条真实存在的歌曲链接。
 *
 * ## 为什么不直接让模型写 `[card:网址]`
 *
 * 链接卡片那条路（card.js / imessage.js:sendCardPart）要求模型自己把网址写全，
 * 而模型**记不住歌曲 ID**。它会写出 `https://music.163.com/song?id=1234567`
 * 这种看着像样、点开是 404 的东西 —— 所以默认提示词里才有那句「网址必须是你
 * 确实知道的真实链接，编不出来就别发」。这一条实质上把「分享一首歌」这个最常
 * 用的场景堵死了。
 *
 * `[music:…]` 绕开的就是这个：模型只写它真的知道的东西（歌手 + 歌名），
 * 网址由这边现查。查不到就不发 —— 宁可少发一张卡片，也不发一条死链接。
 *
 * ## 查哪儿
 *
 * 两家**同时**查，谁给出的结果更像就用谁的：
 *
 *  - **网易云音乐**：`music.163.com/api/search/get/web` 是**非官方**接口
 *    （网页版自己在用的那个），随时可能变或者被挡。华语曲库最全、简体直接
 *    能搜，歌曲页带正经的 og:title / og:image，iMessage 抓得到封面。出来的是
 *    普通链接卡片，不是网易云那种带 app 图标的品牌卡片 —— 那种要
 *    `customizedMiniApp` 填人家真实的 teamId，等于冒充，见 card.js 文件头。
 *  - **Apple Music**：走 iTunes Search API，苹果官方、不要 key、不要签名，
 *    返回里的 `trackViewUrl` 发到 iPhone 上会被渲染成音乐卡片。它补的是网易云
 *    缺的那块：周杰伦这类版权被拉走的，网易云只剩翻唱，苹果有原版。
 *
 * 角色面板上那个「点歌偏好哪家」只是**同分时谁说了算**，不是谁先谁后 ——
 * 两家反正都要查，串行等两轮还更慢。
 *
 * Apple 这边踩过两个坑，都写死在 searchApple 里了，别再改回去：
 *
 *  1. **`country=CN` 搜什么都返回 0 条** —— 苹果的中国区 iTunes Store 压根
 *     不卖单曲，这个接口在 CN 区是空的。改用 `TW`：华语曲库齐，英文歌也在。
 *  2. TW 区返回的是**繁体**（搜「五月天 倔强」回的是「倔強」）。苹果自己的
 *     搜索能跨简繁匹配，下面打分那关却是纯字符串比对，繁简一差就判不出来。
 *     Node 折不了简繁（ICU 的 collator 在任何 locale、任何 sensitivity 下都
 *     认为「周杰倫」≠「周杰伦」，试过了）。**歌手名**的简繁由 affinity 按共用
 *     字数兜住了（见它的注释），**歌名**没兜 —— 两个字的中文歌名太容易撞，
 *     放宽了就会发错歌。结果就是「周杰伦-晴天」「稻香」这种简繁同形的歌名能从
 *     苹果那边拿到原版，「周杰伦-告白气球」（氣/气）拿不到，宁可不发。
 *
 * ## 发出去之前还会挑一遍
 *
 * 搜索接口对着一串中文永远会**返回点什么**，哪怕八竿子打不着。所以这里按
 * 「歌名命中 +2、歌手命中 +1、看着像翻唱 -1」打个分：模型写了「歌手-歌名」
 * 两段就要满分，只写一段就只看歌名。模型写错字、写了首不存在的歌、或者那首歌
 * 两家都只有翻唱时，宁可返回 null 让这条标记退化成一句普通文字，也不要发一首
 * 别人唱的过去 —— 对方是真会点开的。
 *
 * 「歌手也得对上」这条有个例外通道，因为**曲库里挂的名字不一定是模型写的那个**
 * （Apple 现在把 The Weeknd 的歌手名写成本名 Abel Tesfaye，艺名、改名、乐队的
 * 英文名都是这类），条件和它保护不住的边界写在 pickBest 的注释里。
 */

import { logDebug, logWarn } from "./logs.js";
import { netCodes, proxyFor, whyNetwork } from "./proxy.js";

/** 一次搜索最多等多久。发消息那条路在等它，不能久。 */
const SEARCH_TIMEOUT_MS = 6000;

/** 一次取几条候选。多取几条是为了给打分留挑选余地。 */
const SEARCH_LIMIT = 8;

/** 缓存上限。同一首歌来回聊很常见，但也不能无限涨。 */
const CACHE_MAX = 200;

/** 认得的音乐源，第一个是默认。角色面板上的下拉和这个顺序一致。 */
export const MUSIC_SOURCES = ["netease", "apple"];

export const MUSIC_SOURCE_LABELS = {
  netease: "网易云音乐",
  apple: "Apple Music",
};

/**
 * 搜索结果缓存：`源::规范化过的查询` → 命中的那条（或 null）。
 *
 * **失败也缓存**。模型编了一首不存在的歌，往往会在同一段对话里反复提；
 * 每次都去打一遍接口纯属白等 6 秒。
 */
const cache = new Map();

/**
 * 比对用的规范化：大小写、空格、各种标点全抹掉。
 *
 * 「告白气球」和「告白气球 (Live)」、「Faded」和「faded」要算同一首；
 * 标点差异（`·` `’` 全角括号）在两边曲库里到处都是，留着只会误判。
 */
function norm(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[\s　]+/g, "")
    .replace(/[·・'’‘"“”()（）[\]【】{}<>《》,，.。!！?？:：;；、\-—–~～/\\|_*#@&+]/g, "");
}

/**
 * 把 `歌手-歌名` 拆成两段。
 *
 * 只按**第一个**分隔符切：「周杰伦-告白气球 - Live」要拆成
 * 「周杰伦」+「告白气球 - Live」，而不是切三段。没有分隔符就整串当一段，
 * 当歌名还是当歌手都无所谓 —— 搜索时两段本来就是拼回去一起丢给接口的，
 * 分开只影响打分时谁算命中歌名。
 */
export function parseMusicQuery(text) {
  const raw = String(text ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (!raw) return { raw: "", terms: [] };

  const hit = /^(.{1,80}?)\s*[-–—－_|/]\s*(.{1,80})$/.exec(raw);
  if (hit) {
    const terms = [hit[1].trim(), hit[2].trim()].filter(Boolean);
    if (terms.length === 2) return { raw, terms };
  }
  return { raw, terms: [raw] };
}

/**
 * 两串字在不在一起：相等，或者长的那串包着短的那串。
 *
 * 包含关系两边都要算：曲库里的歌名常带 `(Live)` `- 电影主题曲` 这种后缀，
 * 模型写的又常是简称。但**两个字以下不玩包含**，不然「我」能命中一堆。
 *
 * 这里是**严格**比对，不做模糊。想过按「共用几个字」放宽来兜简繁，但中文歌名
 * 两个字的太多了 —— 「晴天」和「晴空」、「红豆」和「红日」共用一半的字，
 * 一放宽就会发错歌。宁可漏，不可错。
 */
function like(a, b) {
  if (!a || !b) return false;
  return a === b || (b.length >= 2 && a.includes(b)) || (a.length >= 2 && b.includes(a));
}

/**
 * 翻唱 / 伴奏 / 纯音乐这类版本的标记。
 *
 * 网易云搜「周杰伦 晴天」，八条全是这种（他的原版 2021 年版权被拉走了）：
 * `RyaVocal - 晴天 (原唱 周杰伦)`、`纪钧瀚 - 晴天 (钢琴版)`……歌名是对的，
 * 唱的人不是。只在**歌手没对上**的时候扣分，用户自己点名要翻唱版的那种
 * （歌手对上了）不受影响。
 *
 * 刻意不收 Live：现场版一般还是原唱本人唱的，那是正经版本。
 */
const COVER_RE = /原唱|翻唱|伴奏|纯音乐|口琴|八音盒|铃声|钢琴|吉他|女声|男声|童声|cover|instrumental|karaoke/i;

/**
 * 候选的歌手和查询里的歌手有多沾边，0~1。
 *
 * 存在的唯一理由是简繁：Apple 的台湾区回的是「周杰倫」，模型写的是
 * 「周杰伦」，上面那关严格比对判不出来。按共用的字数一比，「周杰倫」对
 * 「周杰伦」是 0.67，路人翻唱歌手是 0。
 *
 * 敢在歌手上用模糊、不敢在歌名上用，是因为歌手名普遍长一点、区分度够
 * （「王菲」和「王力宏」只共用一个字，0.5，够不着门槛），而中文歌名两个字的
 * 太多了 —— 「晴天」和「晴空」也是 0.5，一放宽就会发错歌。
 */
function affinity(terms, artist) {
  const b = new Set(norm(artist));
  if (!b.size) return 0;

  let best = 0;
  for (const term of terms) {
    const a = new Set(norm(term));
    if (!a.size) continue;
    let shared = 0;
    for (const ch of a) if (b.has(ch)) shared += 1;
    best = Math.max(best, shared / Math.min(a.size, b.size));
  }
  return best;
}

/** 有没有汉字。简繁那套补救只对中文名开，拉丁字母名字太短、打乱了也像。 */
const CJK_RE = /[㐀-鿿豈-﫿]/;

/** 沾到多少才当成「同一个歌手的简繁两种写法」。 */
const AFFINITY_HIT = 0.6;

/**
 * 这条候选的歌手，是不是查询里写的那个人。
 *
 * 严格比对不上时用 affinity 补救一次 —— 只补中文名，为的是「周杰倫」对得上
 * 「周杰伦」。不然苹果台湾区回的华语歌全军覆没。
 */
function artistHit(terms, artist, aff) {
  const nArtist = norm(artist);
  if (terms.some((t) => like(nArtist, norm(t)))) return true;
  return aff >= AFFINITY_HIT && CJK_RE.test(String(artist ?? "")) && terms.some((t) => CJK_RE.test(t));
}

/**
 * 这条候选和查询有多像：`{score, aff}`，score 满分 3 分。
 *
 * 歌名对上算 2 分、歌手对上算 1 分，**各自最多算一次**。「各自最多算一次」
 * 这条是被翻唱版坑出来的：`RyaVocal - 晴天 (原唱 周杰伦)` 的歌名字段里
 * **同时**含着「晴天」和「周杰伦」，按 term 逐个累加它能拿 4 分，把只有 3 分的
 * 原唱顶掉。
 *
 * 歌手那 1 分还有条兜底通道，`trustRank0` 控制，见 pickBest 里那段注释。
 */
function evaluate(terms, item, rank, trustRank0) {
  const nTitle = norm(item.title);
  const aff = affinity(terms, item.artist);

  // 歌名「一字不差」和「包得住」要分开：兜底那条只认前者
  const exactTitle = Boolean(nTitle) && terms.some((t) => nTitle === norm(t));

  let score = 0;
  if (exactTitle || terms.some((t) => like(nTitle, norm(t)))) score += 2;

  if (artistHit(terms, item.artist, aff)) score += 1;
  else if (COVER_RE.test(String(item.title ?? ""))) score -= 1;
  else if (trustRank0 && exactTitle && rank === 0) score += 1;

  return { score, aff };
}

/**
 * fetch 挂了的时候说人话，别把一整坨 stack 甩进日志。
 *
 * 网络层的失败转给 proxy.js:whyNetwork —— 原来这里直接 `e.message`，而 undici
 * 的 message 就是那句没信息量的 `fetch failed`，日志里只剩「网易云搜「x」没成功
 * （fetch failed）」，用户拿着这句话只能去搜引擎。whyNetwork 会把真正的错误码
 * 挖出来（`AggregateError` 的 `errors[]` 也一起挖），还会说清这一类有没有挂代理。
 *
 * scope 传 `"music"`，和上面两个 `proxyFor("music")` 是同一个开关。
 *
 * 非网络的错还是原样带出来：网易云的限流码（405「操作频繁」）和 `HTTP 4xx`
 * 是我们自己抛的普通 Error，那些话本身就是原因，套一层反而糊。
 */
function why(e) {
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return `超过 ${SEARCH_TIMEOUT_MS} 毫秒没回应`;
  if (netCodes(e).length || /fetch failed/i.test(String(e?.message ?? ""))) {
    return whyNetwork(e, "music", SEARCH_TIMEOUT_MS);
  }
  return e?.message ? String(e.message) : String(e);
}

/**
 * Apple Music：iTunes Search API。
 *
 * `country` 决定翻的是哪个区的曲库。**不要改成 CN** —— 中国区 iTunes Store
 * 不卖单曲，这个接口在 CN 区对任何查询都返回 0 条（「周杰伦 晴天」「Adele
 * Hello」都试过）。`TW` 是华语的正确 storefront，英文歌也一样搜得到；代价是
 * 返回繁体，见文件头第 2 条。
 */
async function searchApple(term) {
  const qs = new URLSearchParams({
    term,
    media: "music",
    entity: "song",
    limit: String(SEARCH_LIMIT),
    country: "TW",
  });
  const res = await fetch(`https://itunes.apple.com/search?${qs}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    ...(await proxyFor("music")),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  // 苹果这个接口回的 content-type 是 text/javascript，但内容确实是 JSON
  const data = JSON.parse(await res.text());
  return (Array.isArray(data?.results) ? data.results : [])
    .map((r) => ({
      url: String(r?.trackViewUrl ?? "").trim(),
      title: String(r?.trackName ?? "").trim(),
      artist: String(r?.artistName ?? "").trim(),
    }))
    .filter((c) => c.url && c.title);
}

/**
 * 网易云音乐：网页版自己在用的那个搜索接口。
 *
 * **非官方**，没有任何兼容性承诺。要带 Referer，不然直接被挡。
 */
async function searchNetease(term) {
  const res = await fetch("https://music.163.com/api/search/get/web", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: "https://music.163.com/",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      s: term,
      type: "1", // 1 = 单曲
      offset: "0",
      total: "true",
      limit: String(SEARCH_LIMIT),
    }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    ...(await proxyFor("music")),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data = JSON.parse(await res.text());

  // 限流和出错也是 HTTP 200，藏在 body 的 code 里（比如 405「操作频繁，请稍候
  // 再试」）。不看这个的话，出错会被当成「这首歌不存在」——最糟的是还会被
  // 缓存下来，这首歌接下来整段对话都查不到了。
  if (data?.code !== undefined && data.code !== 200) {
    throw new Error(`${data.code} ${data.msg || data.message || ""}`.trim());
  }

  return (Array.isArray(data?.result?.songs) ? data.result.songs : [])
    .filter((s) => s?.id)
    .map((s) => ({
      url: `https://music.163.com/song?id=${s.id}`,
      title: String(s?.name ?? "").trim(),
      artist: (Array.isArray(s?.artists) ? s.artists : [])
        .map((a) => String(a?.name ?? "").trim())
        .filter(Boolean)
        .join("/"),
    }))
    .filter((c) => c.title);
}

const SOURCES = {
  netease: { label: MUSIC_SOURCE_LABELS.netease, search: searchNetease },
  apple: { label: MUSIC_SOURCE_LABELS.apple, search: searchApple },
};

/** 存进缓存，顺手把最早那条挤掉（Map 记插入顺序，第一个就是最老的）。 */
function remember(key, value) {
  cache.set(key, value);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/**
 * 从一家的搜索结果里挑最像的一条，挑不出够格的返回 null。
 *
 * `need` 是及格线：模型写了「歌手-歌名」两段就要满分 3 分（歌手也得对上），
 * 只写了一段就 2 分（那段就是歌名）。**两段时卡满分**是必要的 ——
 * 「周杰伦-告白气球」在网易云能搜到一条挂着别人名字的《告白气球》，歌名分毫
 * 不差，但那根本不是他唱的；发过去对方点开就知道不对。这种宁可不发。
 *
 * ## 歌手对不上时的那条兜底通道（trustRank0）
 *
 * 「歌手也得对上」有个躲不开的漏洞：**曲库里挂的名字不一定是模型写的那个**。
 * 实机翻车的就是这条 —— `[music:The Weeknd-Die For You]`，Apple 回的八条全是
 * 这首歌没错，但 artistName 现在写的是他的本名 `Abel Tesfaye`。严格比对当然
 * 对不上，affinity 那条补救又只对中文名开，于是整首歌被判死。艺名、改名、
 * 乐队的英文名（五月天 / Mayday）都是同一类问题，穷举不完。
 *
 * 所以补一条：**歌名一字不差 + 它是接口自己排的第一条 ⇒ 歌手那 1 分照给**。
 * 依据是搜索接口比这边懂得多，艺名、别名、简繁它自己就能对上，它把这条排到
 * 第一说明它认为这就是你要的。而模型编出来的歌名连「一字不差」都过不了 ——
 * 曲库会回一堆近似的，标题不会正好等于那串瞎写的字。
 *
 * 这条通道有三道闸，都是为了别把「宁可不发」这条原则放掉：
 *
 *  - **只在模型写了歌手的时候才开**。它补的就是「写了歌手但名字对不上」这一种
 *    情况；只写了歌名的查询本来就只要 2 分，补这 1 分只会搅乱两家之间的胜负。
 *  - **只在这一家结果里谁都不是那个歌手的时候才开**（`trustRank0`）。要是有
 *    别的候选歌手对上了，说明这家确实收着这位歌手的歌，那就该用那条，不能让
 *    排在前面的翻唱靠排名把原唱顶掉。
 *  - **带翻唱标记的不走这条**（evaluate 里 else-if 的顺序）：`晴天 (原唱
 *    周杰伦)` 这种歌名本身就在自首。
 *
 * 挡不住的边界写在这儿：某首歌**原唱两家都没有**、而排第一的翻唱标题又正好
 * 一字不差、还不带翻唱字样 —— 这种会发出去。宁可漏也不错的尺度在这里松了
 * 一格，换的是艺名这类正常歌能发得出去。实测「周杰伦-告白气球」不受影响：
 * 网易云排第一的是 `Montagem - 告白气球（正式版）`，标题不是一字不差；真正
 * 一字不差的那条翻唱排在第 7 位，够不着这条通道。
 *
 * 排序是「分数高的赢，同分看歌手沾边程度，再同就按接口自己的排名」——
 * 接口的排名本身是有信息量的（它们自己就能跨简繁匹配），实在分不出时听它的。
 */
function pickBest(terms, list, need) {
  const trustRank0 =
    terms.length >= 2 && !list.some((item) => artistHit(terms, item.artist, affinity(terms, item.artist)));

  let best = null;
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    const { score, aff } = evaluate(terms, item, i, trustRank0);
    if (score < need) continue;

    const cand = { ...item, score, aff, rank: i };
    if (!best || cand.score > best.score || (cand.score === best.score && cand.aff > best.aff)) {
      best = cand;
    }
  }
  return best;
}

/**
 * 查一首歌，返回 `{url, title, artist, source}`；查不到 / 对不上返回 null。
 *
 * **两家一起查**，不是先查一家不行再查另一家。一来快（并发下来就是慢的那家
 * 的耗时，比串行等两轮短），二来有些歌两家都搜得到、但只有一家是原唱，
 * 得摆在一起才比得出来 —— 比如「周杰伦-晴天」，网易云只有翻唱，Apple 有原版。
 *
 * @param {string} query  `[music:…]` 方括号里那串，一般是「歌手-歌名」
 * @param {{source?: string, scope?: string}} [opts] `source` 是偏好哪家，
 *   只在两家给出的结果一样像的时候用来定胜负；`scope` 只用来给日志加前缀。
 */
export async function resolveMusic(query, opts = {}) {
  const scope = opts.scope || "点歌";
  const primary = MUSIC_SOURCES.includes(opts.source) ? opts.source : MUSIC_SOURCES[0];

  const { raw, terms } = parseMusicQuery(query);
  if (!terms.length) return null;

  const key = `${primary}::${norm(raw)}`;
  if (cache.has(key)) {
    const cached = cache.get(key);
    logDebug(scope, `「${raw}」用的是缓存里的结果${cached ? `：${cached.url}` : "（上次就没搜到）"}`);
    return cached;
  }

  // 搜索时把分隔符还原成空格整串丢过去：写「歌手-歌名」还是「歌名-歌手」都能命中
  const term = terms.join(" ");
  const order = primary === "apple" ? ["apple", "netease"] : ["netease", "apple"];

  const settled = await Promise.allSettled(order.map((name) => SOURCES[name].search(term)));
  const need = terms.length >= 2 ? 3 : 2;

  let found = null;
  let failed = false;
  for (let i = 0; i < order.length; i += 1) {
    const name = order[i];
    const src = SOURCES[name];
    const r = settled[i];

    if (r.status === "rejected") {
      failed = true;
      logWarn(scope, `${src.label}搜「${raw}」没成功（${why(r.reason)}）`);
      continue;
    }

    const best = pickBest(terms, r.value, need);
    if (!best) {
      logDebug(
        scope,
        r.value.length
          ? `${src.label}搜「${raw}」回了 ${r.value.length} 条，但没有一条对得上`
          : `${src.label}那边没有「${raw}」`,
      );
      continue;
    }
    logDebug(scope, `${src.label}那边最像的是 ${best.artist} - ${best.title}（${best.score} 分）`);

    // order[0] 是偏好的那家，所以同分同沾边时先到的赢
    if (!found || best.score > found.score || (best.score === found.score && best.aff > found.aff)) {
      found = { ...best, source: name };
    }
  }

  if (found) {
    logDebug(scope, `「${raw}」→ ${SOURCES[found.source].label}：${found.artist} - ${found.title}（${found.url}）`);
    found = { url: found.url, title: found.title, artist: found.artist, source: found.source };
  }

  // 空结果只在**两家都正常回话了、就是没对上**的时候才记进缓存。有一家是超时
  // 或者被限流（网易云一密就回 405「操作频繁」）时不记 —— 不然那一瞬间的抖动
  // 会变成「这首歌不存在」，跟着这条缓存一直生效到重启，同一首歌再点也不重试。
  if (found || !failed) remember(key, found);
  return found;
}
