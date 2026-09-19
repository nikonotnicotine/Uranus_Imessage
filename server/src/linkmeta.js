/**
 * 对方发来一条链接，把它解开成一句人话。
 *
 * ── 这个文件补的洞 ──
 *
 * iMessage 里发一条网址，手机上渲染成一张带标题和封面的卡片，人一眼就看懂了。
 * 可这条消息在 Spectrum 里**正文就是那串网址本身** —— SDK 的注释写得很明白：
 * 「a URL received from a platform arrives as plain text, never as `richlink`」，
 * 预览是对方手机自己抓的，元数据一个字都不会传到我们这儿。
 *
 * card.js:cardHintFor 对富链接一律返回空串，理由是「正文就是网址，模型本来就
 * 看得见」—— 这话对普通链接成立，对**短链**完全不成立。实机日志：
 *
 *     收到一轮消息：“https://163cn.tv/bgIOj7V8 看”
 *     模型回复：163在这边打不开…$是什么song？
 *
 * 模型确实看见了那串字符，但那串字符里没有任何信息。更糟的是 b23.tv 那条 ——
 * 模型自己写了 `[搜索:https://b23.tv/KRCChOl]` 想补救，Tavily 对一条短链当然
 * 搜不出东西，白花一次搜索加一次生成，最后还是只能说「是什么搞笑的吗」。
 *
 * 这和 card.js:renderMapsLinks 是**同一类问题**：链接「看得见但读不懂」。那边
 * 已经立下了规矩 —— 在正文上把链接换成模型能读的写法。这个文件只是把同一条
 * 规矩从苹果地图推广到所有链接。
 *
 * ── 为什么不用为每个 app 写一套 ──
 *
 * 靠 Open Graph（`og:title` / `og:description` / `og:site_name`）。这是社交平台
 * 通用的预览协议，**iMessage 自己抓卡片靠的就是它** —— 也就是说「在手机上能
 * 渲染成一张好看卡片的链接」和「我们能读出标题的链接」基本是同一个集合。
 *
 * 实测过四个毫不相干的站，全都给出可用的元数据：
 *
 *   网易云   og:title=Everyday  og:music:artist=Ariana Grande/Future
 *   YouTube  og:title=Rick Astley - Never Gonna Give You Up (Official Video)
 *   GitHub   og:title=GitHub - nodejs/node: Node.js JavaScript runtime
 *   维基     og:title=Ariana Grande - Wikipedia
 *
 * 所以这里**不做内容分类**：不判断这是音乐、视频还是新闻，只把标题和简介
 * 原样交给模型。模型从「Rick Astley - Never Gonna Give You Up」自己就能看出
 * 这是首歌，比我们替它归类可靠 —— 而且分类错了它会顺着错的往下编（这条教训
 * 写在 card.js:KNOWN_APPS 的注释里：「猜错 app 名比不说更糟」）。
 *
 * ── 三层，从通用到特殊 ──
 *
 *  1. **短链跟随**：`163cn.tv`、`b23.tv` 那种，只是一次 302。跟到底拿真实
 *     网址，再交给第 2 层。一段代码覆盖所有短链服务。
 *  2. **og 抓取**：绝大多数链接到这儿就解完了。
 *  3. **少数站的专门处理**：og 拿不到才用。目前只有 B 站一家（网页被风控挡着，
 *     要走它自己的 API）。这一层要**尽量小** —— 能进第 2 层的别写进来。
 *
 * ── 任何一步失败都安静退化 ──
 *
 * 抓不到就把链接原样留在正文里，也就是**退回这个文件存在之前的行为**。需要
 * 登录的（公众号、领英）、被风控挡的、压根没填 og 的老网站都会走到这儿。
 * 口径和 websearch.js 一致（那个文件里写着「任何解析失败都返回空数组，不
 * 抛错」）—— 收消息这条路上宁可少一句提示，绝不能让整轮消息失败。
 */

import { logDebug, logWarn } from "./logs.js";
import { proxyFor } from "./proxy.js";

/**
 * 抓一条链接最多等多久。
 *
 * 比 websearch 的 12 秒短得多，因为这**不是模型主动要的**信息：搜索是模型
 * 写了 `[搜索:…]` 在等结果，晚几秒也得等；这边只是顺手把链接解开，解不开
 * 照样能回消息。对方在那头看着打字指示器，不值得为一条可选的提示多等。
 */
const FETCH_TIMEOUT_MS = 6000;

/** 一条消息里最多解几条链接。发一串链接过来时别把这轮拖死。 */
const MAX_LINKS = 3;

/**
 * 最多读多少字节。
 *
 * og 标签都在 `<head>` 里，几十 KB 足够。设这道闸是因为有些站首页几 MB，
 * 整个读完纯属浪费 —— 而且我们只要开头那截。
 */
const MAX_HTML_BYTES = 256 * 1024;

/** 短链最多跟几跳。`163cn.tv` 一跳、b23.tv 两跳，留点余量但别无限跟。 */
const MAX_REDIRECTS = 5;

/** 标题和简介各自截到多少字。进的是每轮提示词，得收着。 */
const MAX_TITLE = 70;
const MAX_DESC = 120;

/** 缓存上限。同一条链接来回聊很常见（引用、追问），但也不能无限涨。 */
const CACHE_MAX = 200;

/**
 * 解析结果缓存：真实网址 → `{siteName, title, desc}` 或 null。
 *
 * **失败也缓存**，和 music.js 的缓存同一个理由：一条解不开的链接（要登录的、
 * 被风控挡的）在同一段对话里往往会被反复提到，每次都去白等 6 秒没有意义。
 */
const cache = new Map();

/** 存进缓存，顺手把最早那条挤掉（Map 记插入顺序，第一个就是最老的）。 */
function remember(key, value) {
  cache.set(key, value);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/**
 * 装成一个真浏览器。
 *
 * 不带 UA 的话很多站直接返回空页面或者验证码页（websearch.js 的 DuckDuckGo
 * 那条也踩过）。`Accept-Language` 带上中文：网易云、B 站这些会按它决定返回
 * 简体还是繁体。
 */
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

/**
 * 从一段文字里挑出 http/https 链接。
 *
 * 结尾的判据抄 card.js:renderMapsLinks（那边已经验过）：空白、中文全角标点、
 * 成对括号的右半边都算网址结束。末尾的句读也不算网址的一部分 ——
 * 「看这个 https://xxx.com/abc。」里那个句号不能带进 URL。
 */
const URL_RE = /https?:\/\/[^\s<>「」【】()（）]+/gi;

/** 末尾那些不该算进网址的标点。 */
const TAIL_PUNCT = /[.,;:!?。，；：！？、]+$/;

/**
 * 苹果地图的链接**不在这里处理**。
 *
 * 它有自己一条更好的路（card.js:renderMapsLinks → `[location:地名:坐标]`）——
 * 那个写法和模型自己发位置时用的是同一套，两边对得上。抓 og 只会得到一句
 * 「Apple 地图」，信息更少。所以这儿认出来就跳过，交给那边。
 */
function isHandledElsewhere(u) {
  const host = u.hostname.toLowerCase();
  return host === "maps.apple.com" || host === "maps.apple" || host === "beta.maps.apple.com";
}

/**
 * 这个地址能不能抓。
 *
 * 挡掉内网和本机 —— 对方发来的链接是**外部输入**，照着它发请求等于让别人
 * 指挥我们的服务器去访问任意地址（SSRF）。公网域名放过，明显的私有地址一律
 * 拒绝：`localhost`、`127.x`、`10.x`、`192.168.x`、`172.16~31.x`、`169.254.x`、
 * 以及 IPv6 的回环和内网段。
 *
 * 这道闸只挡**字面量**是私有地址的，挡不住「域名解析到内网」那种 ——
 * 真要防那个得在 socket 层面判，代价太大。当前这个用途（读几十 KB HTML 里的
 * og 标签、结果只当一句提示）里，字面量这层够用：我们既不把响应体原样回给
 * 用户，也不按响应内容做任何决策。
 */
function isFetchable(u) {
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (host === "::1" || host === "0.0.0.0") return false;
  // IPv6 的内网段：fc00::/7（唯一本地）、fe80::/10（链路本地）
  if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return false;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 10 || a === 0) return false;
    if (a === 192 && b === 168) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 169 && b === 254) return false; // 云环境的元数据端点就在这段
  }
  return true;
}

/**
 * 跟着重定向走到底，返回最终地址。
 *
 * 用 `redirect: "manual"` 自己跳而不是让 fetch 自动跟，为的是**每一跳都要
 * 重新过 isFetchable**：一条公网短链完全可以 302 到 `127.0.0.1`，自动跟随
 * 就直接把上面那道闸绕过去了。
 *
 * 这一步只发 HEAD。短链服务对 HEAD 和 GET 的回应是一样的（验过 163cn.tv 和
 * b23.tv），而 HEAD 不用把网页正文传回来 —— 快得多。
 *
 * 认不出重定向、或者对方不支持 HEAD 时，原样返回传进来的那个地址：下一步
 * 的 GET 会自己再跟一遍（那时候用 fetch 的自动跟随，因为已经确认过起点）。
 */
async function followRedirects(url, scope) {
  let current = url;
  for (let i = 0; i < MAX_REDIRECTS; i += 1) {
    let res;
    try {
      res = await fetch(current.toString(), {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: BROWSER_HEADERS,
        ...(await proxyFor("link")),
      });
    } catch {
      // HEAD 打不通不代表这条链接是死的（有些站压根不认 HEAD）。
      // 交给下一步的 GET 去试，别在这儿判死
      return current;
    }

    if (res.status < 300 || res.status >= 400) return current;

    const loc = res.headers.get("location");
    if (!loc) return current;

    let next;
    try {
      // 相对地址（B 站第二跳给的就是 `/video/BVxxx/?…`）要按当前地址解
      next = new URL(loc, current);
    } catch {
      return current;
    }
    // 每一跳都重新判：公网短链 302 到内网是真实的攻击面
    if (!isFetchable(next)) {
      logWarn(scope, `链接跳到了不该抓的地址（${next.hostname}），停在这儿`);
      return null;
    }
    current = next;
  }
  logDebug(scope, `重定向超过 ${MAX_REDIRECTS} 跳，不再跟`);
  return current;
}

/**
 * 读一个网页的开头若干字节。
 *
 * 流式读、够了就掐断（`reader.cancel()`）：og 标签都在 `<head>` 里，为了几个
 * meta 把一个几 MB 的首页整篇拉回来没有意义。
 */
async function fetchHead(url, scope) {
  const res = await fetch(url.toString(), {
    // 起点已经过了 isFetchable，这一步让 fetch 自己跟剩下的跳
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: BROWSER_HEADERS,
    ...(await proxyFor("link")),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  // 图片、视频、PDF 这些没有 og 可读，别把字节拉回来白费流量
  const ctype = String(res.headers.get("content-type") ?? "").toLowerCase();
  if (ctype && !/text\/html|application\/xhtml|text\/plain/.test(ctype)) {
    throw new Error(`不是网页（${ctype.split(";")[0]}）`);
  }

  if (!res.body) return await res.text();

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      if (total >= MAX_HTML_BYTES) {
        logDebug(scope, `读到 ${Math.round(total / 1024)}KB 就够了，掐断`);
        break;
      }
    }
  } finally {
    // 已经 break 出来时要主动取消，不然连接挂着不放
    await reader.cancel().catch(() => {});
  }
  // 截断可能正好切在一个多字节字符中间，TextDecoder 会把残字节变成 �，
  // 落到标题末尾最多难看一点，不值得为此多读一轮
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
}

/**
 * HTML 实体反转义。
 *
 * 和 websearch.js:unescapeHtml 是同一件事，但**故意不复用** —— 那个函数没导出，
 * 而为了这个去改它的可见性，等于在两个互不相干的功能之间架一条依赖。这里只
 * 需要 og 标签里可能出现的那几个，表比那边短。
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
  middot: "·",
};

function unescapeHtml(s) {
  // 一趟扫完，不链式 replace —— 链式的话 amp 那步会把前面解出来的字面量
  // 再解一次（`&amp;lt;` 本该留成 `&lt;`，却会变成 `<`）
  return String(s ?? "").replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : Number(body.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    const hit = ENTITIES[body.toLowerCase()];
    return hit === undefined ? whole : hit;
  });
}

/** 收拾一段抓来的文字：反转义、压空白、截断。 */
function clean(raw, max) {
  const s = unescapeHtml(raw).replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * 标题尾巴上那截站名去掉。
 *
 * 实测抓回来的标题长这样：
 *
 *   Everyday - 单曲 - 网易云音乐
 *   【Minecraft】…… _哔哩哔哩_bilibili
 *   GitHub - nodejs/node: Node.js JavaScript runtime
 *   Ariana Grande - Wikipedia
 *
 * 而下面拼提示的时候前面还要加一次 `siteName`，于是模型看到的是
 * 「GitHub - GitHub - nodejs/node…」、「网易云音乐 - Everyday - 单曲 - 网易云
 * 音乐」—— 同一个站名念两遍，纯浪费 token 还难读。
 *
 * 按分隔符切成几段，掐掉**首尾**那些只是站名的段（`_哔哩哔哩_bilibili` 是两段，
 * 所以要循环）。中间的段一个都不动 —— 「GitHub - nodejs/node」里的 nodejs
 * 和站名无关，切错了信息就丢了。
 *
 * 全部段都是站名时（`og:title` 就等于站名的首页）返回空串，让调用方退到
 * `<title>` 或者判为解不开。
 */
function stripSiteSuffix(title, siteName) {
  const site = String(siteName ?? "").trim().toLowerCase();
  if (!title) return "";

  // 站名本身也可能是两种写法（「哔哩哔哩」和「bilibili」），都当成要掐的
  const junk = new Set(["单曲", "视频", "网易云音乐", "bilibili", "哔哩哔哩", "youtube"]);
  if (site) junk.add(site);

  const parts = title.split(/\s*[-|_–—·]\s*|\s+[|｜]\s+/).filter((p) => p.trim());
  if (parts.length < 2) return title;

  let lo = 0;
  let hi = parts.length - 1;
  const isJunk = (p) => junk.has(p.trim().toLowerCase());
  while (hi > lo && isJunk(parts[hi])) hi -= 1;
  while (lo < hi && isJunk(parts[lo])) lo += 1;

  const kept = parts.slice(lo, hi + 1);
  if (!kept.length) return "";
  // 原来用什么分隔的就还原成什么？不必 —— 统一成 " - " 反而整齐，
  // 而且只有掐掉了东西才重拼，没掐就原样返回（保住标题里原本的标点）
  return kept.length === parts.length ? title : kept.join(" - ");
}

/**
 * 这段简介是不是 SEO 关键词堆出来的。
 *
 * 网易云的 `og:description` 实测是：
 *
 *   歌曲名《Everyday》，由 Ariana Grande、Future 演唱，收录于《Dangerous
 *   Woman》专辑中，《Everyday》下载，《Everyday》在线试听，更多Everyday相关
 *   歌曲推荐，尽在网易云音乐
 *
 * 前半句有用、后半截全是关键词。这种堆砌有个很稳的特征：**同一个词反复出现**
 * （这里「Everyday」出现四次）。所以按「最长重复片段占比」判，而不是维护一张
 * 「下载/在线试听/尽在」的词表 —— 那种表永远补不全，而且各家的说法不一样。
 *
 * 判出来是关键词堆砌时，只留第一个句读之前那一段（那句通常是真正的简介）。
 */
function trimSeoTail(desc, title) {
  const s = String(desc ?? "").trim();
  if (s.length < 30) return s;

  // 标题里的主词在简介里出现三次以上 = 在堆关键词
  const head = String(title ?? "").split(/[-（(]/)[0].trim();
  if (head.length < 2) return s;
  const hits = s.split(head).length - 1;
  if (hits < 3) return s;

  /*
   * 留「关键词开始重复之前」的那一段，不是「第一个句读之前」。
   *
   * 后者切出来是半截残句 —— 网易云那条会变成「歌曲名《Everyday》」，比不给
   * 简介更糟（模型会以为简介就这么点内容）。改成扫到主词第三次出现的位置，
   * 再退回到那之前最后一个句读上。
   */
  let at = -1;
  for (let i = 0; i < 2; i += 1) at = s.indexOf(head, at + 1);
  const third = s.indexOf(head, at + 1);
  if (third < 0) return s;

  /*
   * 从第三次出现的位置往前找句读。
   *
   * 起点要往前让几个字符 —— 主词常常被书名号/引号裹着（`《Everyday》下载`），
   * `third` 指的是 `Everyday` 而不是 `《`，直接在它身上往前搜会停在
   * 「《」之前那个逗号的**后面**，于是「，《Everyday》下载」整段留了下来。
   * 退 3 个字符足够跨过任何一种开引号。
   */
  const from = Math.max(0, third - 3);
  const cut = Math.max(
    s.lastIndexOf("，", from),
    s.lastIndexOf("。", from),
    s.lastIndexOf(",", from),
    s.lastIndexOf("；", from)
  );
  // 切完太短（连一句完整的话都没有）就整段不要 —— 半截简介没有价值
  return cut > 12 ? s.slice(0, cut) : "";
}

/**
 * 简介后面那串统计数字掐掉。
 *
 * B 站的 `og:description` 是个固定模板，真简介只占开头一小截：
 *
 *   我搞了场大逃杀，但偷偷告诉你——我能变成任何生物。目标？活到最后。
 *   视频播放量 2516、弹幕量 8、点赞数 31、投硬币枚数 3、收藏人数 27、
 *   转发人数 1, 视频作者 xxx, 作者简介 …，相关视频：极略三国，李白，…
 *
 * MAX_DESC 是 120 字，上面那一串能吃掉一半 —— 模型读到「弹幕量 8」不会因此
 * 多懂一点这条视频是什么。
 *
 * 和 trimSeoTail 是两种不同的噪声，所以分两个函数：那边是**同一个词反复出现**
 * （网易云堆关键词），这边是**「词 + 数字」连着列举**。后者的判据可以做成通用的，
 * 不必写「视频播放量」这种站点专属的词 —— 三对以上连排的「中文词 + 数字」在
 * 人写的简介里基本不出现，而各家短视频站的统计尾巴都是这个形状。
 *
 * 要三对才算（`{2,}` 加上尾巴那一对）。两对容易误伤 ——「上映 2024、评分 8.5」
 * 这种真有可能是正文的一部分。
 */
const STATS_TAIL =
  /(?:[一-龥]{2,6}\s*\d[\d,.万亿]*\s*[、,，]\s*){2,}[一-龥]{2,6}\s*\d/;

function trimStatsTail(desc) {
  const s = String(desc ?? "").trim();
  const at = STATS_TAIL.exec(s)?.index;
  if (at === undefined) return s;
  // 统计之前那截才是真简介。末尾挂着的分隔符（B 站那条是 `, `）一起修掉
  const head = s.slice(0, at).replace(/[\s,，、。;；]+$/, "");
  // 切完只剩一两个字（那视频本来就没填简介，og 里是个 `-` 占位）就整段不要
  return head.length >= 4 ? head : "";
}

/**
 * 从 HTML 里挑一个 meta 的 content。
 *
 * 属性顺序两种都认（`property` 在前或 `content` 在前）—— 真实页面里两种都
 * 见得到，只写一种的话会漏。`name=` 和 `property=` 也都认：og 规范说用
 * `property`，但不少站写的是 `name`。
 */
function metaContent(html, key) {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${k}["'][^>]*content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${k}["']`, "i"),
  ];
  for (const re of patterns) {
    const hit = re.exec(html)?.[1];
    if (hit && hit.trim()) return hit;
  }
  return "";
}

/**
 * 从一段 HTML 里抽出 `{siteName, title, desc}`。
 *
 * og 拿不到标题时退到 `<title>`：老网站、内部系统常常只有这个。两样都没有
 * 就返回 null，让调用方按「解不开」处理。
 *
 * **音乐类的歌手和专辑单独拼一下**。这不是内容分类 —— `og:music:artist` 是
 * og 协议自己的标准字段，读它和读 `og:title` 没有本质区别。加这一句是因为
 * 网易云的 `og:title` 只有歌名（`Everyday`），歌手在 `og:music:artist` 里
 * （`Ariana Grande/Future`），不拼的话模型只知道歌名不知道是谁唱的。
 */
function parseMeta(html) {
  const siteName = clean(metaContent(html, "og:site_name"), 20);
  let title = clean(metaContent(html, "og:title"), MAX_TITLE);

  if (!title) {
    const raw = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html)?.[1];
    title = clean(raw ?? "", MAX_TITLE);
  }
  // 站名在下面单独说，标题里那截重复的掐掉
  title = stripSiteSuffix(title, siteName);
  if (!title) return null;

  /*
   * 简介：先按原文裁掉 SEO 尾巴，**再**截长度。
   *
   * 顺序反过来不行 —— MAX_DESC 会先把关键词堆砌的后半截切掉，trimSeoTail
   * 就数不到「主词出现三次」，于是原样留下一个「…《Everyday》下载」的残尾。
   */
  const rawDesc = clean(
    metaContent(html, "og:description") || metaContent(html, "description"),
    // 先按一个宽得多的上限收一下，纯粹是别让 trimSeoTail 对着几十 KB 干活
    MAX_DESC * 8
  );
  // 两种尾巴都在截长度**之前**掐：截完就数不到特征了（见 trimSeoTail 那段注释）
  const desc0 = trimStatsTail(trimSeoTail(rawDesc, title));
  let desc = desc0.length > MAX_DESC ? `${desc0.slice(0, MAX_DESC)}…` : desc0;

  // og:music:* 是 og 协议的标准字段，不是我们在猜这条链接是什么
  const artist = clean(metaContent(html, "og:music:artist"), 40);
  if (artist && !title.includes(artist)) {
    const album = clean(metaContent(html, "og:music:album"), 30);
    // 歌手和专辑接在标题后面，比塞进 desc 显眼 —— 这是这条链接最要紧的信息
    title = `${title} - ${artist}${album ? `（${album}）` : ""}`;
    /*
     * 拼完之后 desc 往往就是纯重复了：网易云那句「歌曲名《Everyday》，由
     * Ariana Grande、Future 演唱，收录于《Dangerous Woman》专辑中」和标题
     * 一字不差地说了同一件事。歌手名对得上就丢掉。
     *
     * 逐个歌手判（`Ariana Grande/Future` 是斜杠分隔的多人），只要有一个在
     * desc 里出现就算重复 —— 网易云的 desc 用顿号连接，和 og 字段的斜杠
     * 对不上，整串比对永远判不出来。
     */
    if (desc && artist.split(/[/、,，&]/).some((a) => a.trim() && desc.includes(a.trim()))) {
      desc = "";
    }
  }

  // 简介只是标题换个说法时（很多站的 og:description 就是标题重复一遍）不要
  if (desc && (desc === title || title.includes(desc) || desc.includes(title))) desc = "";
  return { siteName, title, desc };
}

/* ================= 第 3 层：少数站的专门处理 ================= */

/**
 * B 站：网页被风控挡着，走它自己的 API。
 *
 * 实测 `curl https://www.bilibili.com/video/BVxxx/` 返回的是「出错啦」那个
 * 验证码页（HTTP 200，但正文是错误页），og 一个都读不到。它的 web API 不要
 * 密钥、不要签名，返回 JSON 里有标题和简介。
 *
 * **这个 API 也可能被挡**（要 cookie 的情况是存在的，我在开发机上就撞到过）。
 * 所以和其他所有路径一样：拿不到就返回 null 退化，不抛错。
 *
 * 这是第 3 层目前唯一一条。往这儿加东西之前先确认第 2 层真的不行 ——
 * 每加一条就是一份要跟着人家改版的维护负担。
 */
async function biliDetail(u, scope) {
  // `/video/BV1yYbC66ErT/` 或 `/video/av123456`
  const m = /\/video\/((?:BV[0-9A-Za-z]+)|(?:av\d+))/i.exec(u.pathname);
  if (!m) return null;

  const id = m[1];
  const qs = /^av/i.test(id) ? `aid=${id.slice(2)}` : `bvid=${id}`;
  try {
    const res = await fetch(`https://api.bilibili.com/x/web-interface/view?${qs}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { ...BROWSER_HEADERS, Accept: "application/json", Referer: "https://www.bilibili.com/" },
      ...(await proxyFor("link")),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // 它的失败是夹在 HTTP 200 里的，靠 code 判（-404 视频不存在、-352 风控）
    if (data?.code !== 0) throw new Error(`code ${data?.code} ${data?.message ?? ""}`.trim());

    const title = clean(data?.data?.title ?? "", MAX_TITLE);
    if (!title) return null;
    const owner = clean(data?.data?.owner?.name ?? "", 30);
    return {
      siteName: "哔哩哔哩",
      title: owner ? `${title}（UP：${owner}）` : title,
      desc: clean(data?.data?.desc ?? "", MAX_DESC),
    };
  } catch (e) {
    logDebug(scope, `B 站 API 没问到 ${id}：${String(e?.message ?? e)}`);
    return null;
  }
}

/** 第 3 层的分派表。键是域名后缀，值是拿 `(URL, scope)` 的函数。 */
const SPECIAL = [{ suffix: "bilibili.com", run: biliDetail }];

function specialFor(u) {
  const host = u.hostname.toLowerCase();
  const hit = SPECIAL.find((s) => host === s.suffix || host.endsWith(`.${s.suffix}`));
  return hit?.run ?? null;
}

/* ================= 对外 ================= */

/**
 * 解一条链接。返回 `{siteName, title, desc}`，解不开返回 null。
 *
 * 三层依次来：跟重定向 → og 抓取 → 特例兜底。缓存的键是**真实网址**而不是
 * 原始短链，所以同一首歌的不同短链只会抓一次。
 */
async function resolveOne(raw, scope) {
  let start;
  try {
    start = new URL(raw);
  } catch {
    return null;
  }
  if (!isFetchable(start)) return null;

  // 第 1 层：短链跟到底
  const final = await followRedirects(start, scope);
  if (!final) return null;

  const key = final.toString();
  if (cache.has(key)) {
    const hit = cache.get(key);
    logDebug(scope, `「${key}」用的是缓存里的结果${hit ? `：${hit.title}` : "（上次就没解开）"}`);
    return hit;
  }

  // 第 2 层：og。抓不到再走第 3 层
  let info = null;
  try {
    const html = await fetchHead(final, scope);
    info = parseMeta(html);
  } catch (e) {
    logDebug(scope, `抓 ${final.hostname} 失败：${String(e?.message ?? e)}`);
  }

  // 第 3 层：特例。og 成功时不走 —— 它更通用，而且不会跟着人家改版失效
  if (!info) {
    const special = specialFor(final);
    if (special) info = await special(final, scope);
  }

  remember(key, info);
  if (info) {
    logDebug(scope, `${final.hostname} → ${info.siteName ? `${info.siteName}：` : ""}${info.title}`);
  }
  return info;
}

/**
 * 把一段**对方发来的**文字里的链接解开，在后面补一句说明。
 *
 * 为什么是「补一句」而不是「换掉」：网址本身还有用 —— 模型可能要在回复里
 * 提到它，而且原文该长什么样就长什么样（和 renderMapsLinks 不同，那边是因为
 * 百分号编码的地名对模型完全不可读，换掉才对）。所以链接照留，后面跟一个
 * 方括号补充：
 *
 *   https://163cn.tv/bgIOj7V8 [这条链接是：网易云音乐 - Everyday - Ariana Grande…]
 *
 * 苹果地图的链接跳过（交给 renderMapsLinks），解不开的也跳过（原样留着，
 * 就是这个文件存在之前的行为）。
 *
 * 并发解所有链接：一条消息里三条链接串行要等三轮超时，并发只等最慢那条。
 *
 * @param {string} text 对方那条消息的正文
 * @param {string} [scope] 日志前缀
 * @returns {Promise<string>} 补过说明的正文；没有可解的链接就原样返回
 */
export async function renderLinks(text, scope = "链接") {
  const raw = String(text ?? "");
  if (!raw || !/https?:\/\//i.test(raw)) return raw;

  // 先挑出要解的，去重（同一条链接发两遍只抓一次）
  const targets = [];
  const seen = new Set();
  for (const m of raw.matchAll(URL_RE)) {
    const trimmed = m[0].replace(TAIL_PUNCT, "");
    if (!trimmed || seen.has(trimmed)) continue;
    let u;
    try {
      u = new URL(trimmed);
    } catch {
      continue;
    }
    if (isHandledElsewhere(u) || !isFetchable(u)) continue;
    seen.add(trimmed);
    targets.push(trimmed);
    if (targets.length >= MAX_LINKS) break;
  }
  if (!targets.length) return raw;

  const settled = await Promise.allSettled(targets.map((t) => resolveOne(t, scope)));

  // 解开了的攒成一张表，下面按原文顺序替换
  const notes = new Map();
  for (let i = 0; i < targets.length; i += 1) {
    const r = settled[i];
    if (r.status !== "fulfilled" || !r.value) continue;
    const { siteName, title, desc } = r.value;
    // 标题里已经带着站名时别再前置一遍（GitHub 的 og:title 就是
    // 「GitHub - nodejs/node: …」，加上去会变成「GitHub - GitHub - …」）
    const dup = siteName && title.toLowerCase().includes(siteName.toLowerCase());
    const head = siteName && !dup ? `${siteName} - ${title}` : title;
    notes.set(targets[i], `[这条链接是：${head}${desc ? `。${desc}` : ""}]`);
  }
  if (!notes.size) return raw;

  return raw.replace(URL_RE, (url) => {
    const trimmed = url.replace(TAIL_PUNCT, "");
    const note = notes.get(trimmed);
    if (!note) return url;
    // 末尾的句读留在补充说明后面，读起来才顺
    return `${trimmed} ${note}${url.slice(trimmed.length)}`;
  });
}
