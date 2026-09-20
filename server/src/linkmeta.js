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
 *  3. **少数站的专门处理**：og 拿不到才用。目前三家 —— B 站（网页被风控挡着，
 *     要走它自己的 API）、抖音和小红书（页面都是纯客户端渲染的壳子，内容在
 *     一个 `window.xxx = {…}` 里）。这一层要**尽量小** —— 能进第 2 层的别写进来。
 *
 *     抖音和小红书这两家还**连图片一起带出去**，由调用方下载、走识图那条路
 *     真的喂给视觉模型 —— 那种图文作品的信息全在图里，光有配文等于没读到。
 *
 * ── 任何一步失败都安静退化 ──
 *
 * 抓不到就把链接原样留在正文里，也就是**退回这个文件存在之前的行为**。需要
 * 登录的（公众号、领英）、被风控挡的、压根没填 og 的老网站都会走到这儿。
 * 口径和 websearch.js 一致（那个文件里写着「任何解析失败都返回空数组，不
 * 抛错」）—— 收消息这条路上宁可少一句提示，绝不能让整轮消息失败。
 */

import { logDebug, logWarn } from "./logs.js";
import { sniffImageType } from "./media.js";
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

/**
 * 下载一张图最多等多久。
 *
 * 比 FETCH_TIMEOUT_MS 宽一点：那个是读几十 KB 的 `<head>`，这个是几百 KB 的
 * 图片字节（抖音实测 300~550KB 一张）。但也不能太宽 —— 对方还在那头等回复，
 * 而这些图只是「顺手多看一眼」，不值得为它把一轮拖到十几秒。
 */
/**
 * 链接里的视频最长下多久的。超过这个数只拿封面。
 *
 * 90 秒这条线是三件事顶出来的：
 *
 *  1. **内存。** 视频要整段进内存再转 base64（4/3 倍），几条会话同时来是要乘的。
 *     一条 90 秒的抖音视频实测 10MB 出头，撑成 base64 是 14MB —— 还在
 *     imessage.js:MAX_VIDEO_BYTES 那个 20MB 闸以内，而那个闸本来就是按
 *     「2G 内存的小机器也扛得住」定的。
 *  2. **对方要等多久。** 一段 2MB 的视频 Gemini 认了 17.8 秒（实机日志）。
 *     越长越久，而这段时间对方那头是完全静默的。
 *  3. **超时。** 下载走 VIDEO_TIMEOUT_MS，长视频在慢网络上本来就下不完。
 *
 * 超了不是失败：退回封面那一张图，并在正文里说清为什么（见 douyinDetail）。
 * 常见的抖音短视频都在这条线以内，真正被挡掉的是那种几分钟的长片。
 */
const MAX_VIDEO_MS = 90 * 1000;

/** 视频比图片大得多，给它单独一个更宽的超时。 */
const VIDEO_TIMEOUT_MS = 30000;

/**
 * 链接里的视频最大下多少字节。
 *
 * 和 imessage.js:MAX_VIDEO_BYTES（对方直接发的视频，20MB）**特意定成一样**：
 * 同一个视频模型、同一条识别路径，没有理由因为来源不同就给不同的额度。
 * 时长闸已经在页面数据上先挡了一道，这个是兜底 —— 人家的码率我们说不准。
 */
const MAX_VIDEO_BYTES = 20 * 1024 * 1024;

const IMAGE_TIMEOUT_MS = 10000;

/**
 * 一张图最多多大。
 *
 * 超过就不要了：base64 会把字节撑成 4/3，几 MB 的图进请求体会顶到中转站的
 * 上限（media.js 文件头记着同一条教训）。抖音那种 300~550KB 的离这儿很远。
 */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

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

/**
 * 带图片的缓存条目能放多久。
 *
 * 图片直链上挂着签名和 `x-expires`（抖音实测约两天），过期之后拿出来是死链。
 * 设成 30 分钟：同一条链接在一段对话里被反复提到的窗口基本都在这之内，而
 * 离得远的那次重抓一遍也不心疼（一条抖音是两个来回，不是什么大开销）。
 */
const IMAGE_URL_TTL_MS = 30 * 60 * 1000;

/** 存进缓存，顺手把最早那条挤掉（Map 记插入顺序，第一个就是最老的）。 */
function remember(key, value) {
  // 存进去的时刻记一笔，上面那道保质期要用。null（解不开）不用记
  cache.set(key, value ? { ...value, at: Date.now() } : value);
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
 * 装成 iPhone 上的 Safari。
 *
 * 有些站**只对手机浏览器给内容**，对桌面 UA 另一套待遇：
 *
 *   抖音     桌面 UA → 2.4KB 空壳；手机 UA → 完整 SSR 数据
 *   小红书   桌面 UA → 直接踢到 /login；手机 UA → 120KB 带笔记内容
 *
 * 这两家的分享链接本来就是手机 App 生成、给手机点开的，人家按 UA 分流很合理。
 *
 * **不拿它当默认**：绝大多数站对桌面 UA 的响应更全（桌面版页面信息密度更高），
 * 而且冒充手机会让某些站返回精简版、反而少了 og 标签。所以只有下面 MOBILE_UA_HOSTS
 * 里那几家用它。
 */
const MOBILE_HEADERS = {
  ...BROWSER_HEADERS,
  "User-Agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 " +
    "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
};

/**
 * 这些域名要用手机 UA，**从跟重定向那一步就开始**。
 *
 * 为什么不能等到第 3 层再换：落点是在跟重定向时定下的。小红书的短链用桌面 UA
 * 跟下去会落在 `/login`，第 3 层拿到的就是个登录页，再换 UA 也来不及
 * （实机日志：`小红书没解开 /login：没有 noteData`）。
 *
 * 短链域名也要列进来 —— `xhslink.cn` 那一跳就得用手机 UA。
 */
const MOBILE_UA_HOSTS = [
  "douyin.com",
  "iesdouyin.com",
  "xiaohongshu.com",
  "xhslink.cn",
  "xhslink.com",
];

/** 这条地址该用哪套请求头。 */
function headersFor(u) {
  const host = String(u?.hostname ?? "").toLowerCase();
  const mobile = MOBILE_UA_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  return mobile ? MOBILE_HEADERS : BROWSER_HEADERS;
}

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
/**
 * 用 GET 探一次这条地址最终跳到哪，只看落点、不要正文。
 *
 * 给 followRedirects 兜「只对 GET 跳转」的短链服务用（见那边的注释）。
 * 让 fetch 自己跟随（`redirect: "follow"`），因为起点已经过了 isFetchable，
 * 而中途每一跳都重新判的代价在这条兜底路径上不值得 —— 落点回去之后照样要过闸。
 *
 * 正文**立刻取消**：只要 `res.url`（最终地址），几十 KB 的页面下一步会重新抓。
 *
 * @returns {Promise<URL|null>} 最终地址；探不动或落点不可抓时返回 null
 */
async function followViaGet(url, scope) {
  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: headersFor(url),
      ...(await proxyFor("link")),
    });
    // 只要落点，正文不读 —— 掐掉连接，别让它挂着传几十 KB 回来
    await res.body?.cancel().catch(() => {});
    if (!res.ok || !res.url) return null;

    const next = new URL(res.url);
    if (next.toString() === url.toString()) return null; // 压根没跳
    if (!isFetchable(next)) {
      logWarn(scope, `链接跳到了不该抓的地址（${next.hostname}），停在这儿`);
      return null;
    }
    logDebug(scope, `HEAD 不认这条短链，用 GET 跟到了 ${next.hostname}`);
    return next;
  } catch {
    return null;
  }
}

async function followRedirects(url, scope) {
  let current = url;
  for (let i = 0; i < MAX_REDIRECTS; i += 1) {
    let res;
    try {
      res = await fetch(current.toString(), {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: headersFor(current),
        ...(await proxyFor("link")),
      });
    } catch {
      // HEAD 打不通不代表这条链接是死的（有些站压根不认 HEAD）。
      // 交给下一步的 GET 去试，别在这儿判死
      return current;
    }

    /*
     * 不是 3xx 就停 —— 但**有些短链服务只对 GET 跳转**。
     *
     * 小红书的 `xhslink.cn` 实测对 HEAD 返回 404、对 GET 正常 302。碰上这种，
     * 上面那句 HEAD 的结果毫无参考价值：停在短链上，第 3 层按域名分派自然
     * 就认不出这是小红书（`specialFor` 匹配的是 `xiaohongshu.com`）。
     *
     * 所以 4xx/5xx 时再用 GET 追一次。只在第一跳这么补：短链服务的第一跳
     * 才是会挑方法的那一跳，往后都是正常页面地址，不值得每跳都试两遍。
     */
    if (res.status >= 400 && i === 0) {
      const viaGet = await followViaGet(current, scope);
      if (viaGet) {
        current = viaGet;
        continue;
      }
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
    headers: headersFor(url),
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
 * 往第 3 层加东西之前先确认第 2 层真的不行 —— 每加一条就是一份要跟着人家
 * 改版的维护负担。
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

/**
 * 抖音：分享页是个纯客户端渲染的壳子，正文藏在 `_ROUTER_DATA` 里，
 * 而那份数据**只在带 cookie 时才填**。
 *
 * ── 为什么非得这么绕 ──
 *
 * 实测过四种取法，只有最后一种拿得到东西：
 *
 *   桌面 UA                  → 2.4KB 空壳，og 一个没有、数据也没有
 *   手机 UA，不带 cookie     → 33KB，有 `_ROUTER_DATA` 但 `videoInfoRes` 是 null
 *   手机 UA + ttwid cookie   → 139KB，`videoInfoRes.item_list[0]` 全量数据
 *   官方 `/aweme/v1/web/aweme/detail/`
 *                            → 403「Blocked by ArgusSecurityPlugin Uifid Not Found」
 *
 * 那个官方接口要 a_bogus 签名（一段混淆过的 JS 算出来的），实现它等于把人家的
 * 风控算法抄一份进来 —— 改版就废，而且法律上也不体面。分享页这条只是「装成
 * 手机浏览器看一眼公开页面」，稳定得多。
 *
 * ── ttwid 是分享页自己发的 ──
 *
 * 这点值得记一笔，因为直觉上会去 `douyin.com` 主站要 cookie（我第一版就是那么
 * 写的，拿不到）。实际下发 ttwid 的是 `.iesdouyin.com`，也就是**分享页自己**，
 * 在第一次访问时通过 `Set-Cookie` 给。所以要请求两趟同一个地址：第一趟纯粹
 * 为了收 cookie，第二趟带上它才拿到填好的数据。
 *
 * 两趟的代价是一条抖音链接要等两个来回。可以接受 —— 这条路只在 og 全空
 * （也就是确定是抖音）时才走，普通链接一趟都不多花。
 *
 * 图文作品和视频作品走的是同一个结构，区别只在图片放哪儿：
 * `item.images[]` 是图文的每一张，视频则只有 `item.video.cover` 一张封面。
 */
async function douyinDetail(u, scope) {
  // 抖音对桌面 UA 只给 2.4KB 空壳，见 MOBILE_HEADERS
  const headers = MOBILE_HEADERS;

  /*
   * 地址要先正规化回**分享页**。
   *
   * 抖音会把 `iesdouyin.com/share/note/<id>` 带到 `www.douyin.com/note/<id>` ——
   * 那是主站的播放页，结构完全不同，压根没有 `_ROUTER_DATA`。实机日志就是
   * 「页面里没有 _ROUTER_DATA」。
   *
   * 所以这里不用传进来的地址，只从里面抠出那串**作品 ID**，自己拼回分享页。
   * 顺带把 25 个跟踪参数全甩了（`share_sign`、`ug_share_id` 那些），只留
   * `from_ssr=1`。作品 ID 在两种地址里都是路径最后那段数字。
   */
  const id = /(\d{8,})/.exec(u.pathname)?.[1];
  if (!id) {
    logDebug(scope, `抖音链接里找不到作品 ID：${u.pathname}`);
    return null;
  }
  /*
   * 前缀统一用 `note`，不按作品类型分。
   *
   * 实测同一个 ID 用 `share/note/` 和 `share/video/` 请求，返回的 SSR 结构
   * 一模一样、`item_list` 都解得出来（前者 102KB、后者 68KB，差在页面自己的
   * 渲染代码，数据部分是同一份）。所以不用先判是图文还是视频 —— 那得先请求
   * 一次才知道，多一个来回。
   */
  const target = `https://www.iesdouyin.com/share/note/${id}/?from_ssr=1`;

  try {
    // 第一趟：收 cookie。正文这趟基本是空壳，不解析
    const first = await fetch(target, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers,
      ...(await proxyFor("link")),
    });
    if (!first.ok) throw new Error(`HTTP ${first.status}`);

    const ttwid = (first.headers.getSetCookie?.() ?? [])
      .map((c) => /ttwid=([^;]+)/.exec(c)?.[1])
      .find(Boolean);
    // 第一趟的正文要读掉，不然连接挂着不放
    const firstHtml = await first.text();

    /*
     * 拿不到 cookie 也把第一趟的正文试着解一遍。
     *
     * 人家哪天改成不用 cookie 就给数据了，这里自然就走通了；解不出来也只是
     * 白解一次正则，比直接 return null 多一分机会。
     */
    let html = firstHtml;
    if (ttwid) {
      const second = await fetch(first.url, {
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { ...headers, Cookie: `ttwid=${ttwid}` },
        ...(await proxyFor("link")),
      });
      if (!second.ok) throw new Error(`第二趟 HTTP ${second.status}`);
      html = await second.text();
    }

    const raw = /_ROUTER_DATA\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/.exec(html)?.[1];
    if (!raw) throw new Error("页面里没有 _ROUTER_DATA");
    const data = JSON.parse(raw);

    /*
     * key 随作品类型变（图文是 `note_(id)/page`、视频是 `video_(id)/page`），
     * 所以按「含 /page」找而不是写死名字 —— 人家再加一种作品类型也不用改这儿。
     */
    const page = Object.entries(data?.loaderData ?? {}).find(([k]) => k.includes("/page"))?.[1];
    const item = page?.videoInfoRes?.item_list?.[0];
    if (!item) throw new Error("没有 item_list（cookie 没生效？）");

    // 配文就是抖音的「标题」—— 它没有单独的标题字段
    const descRaw = clean(item.desc ?? "", MAX_TITLE + MAX_DESC);
    const author = clean(item.author?.nickname ?? "", 30);
    if (!descRaw && !author) throw new Error("配文和作者都是空的");

    /*
     * 配文可能很长（带一串话题标签），切成「标题 + 简介」两截：
     * 第一个句读之前当标题，余下的当简介。切不出来就整段当标题。
     */
    const cut = /[。！？\n]/.exec(descRaw)?.index ?? -1;
    let title = cut > 6 ? descRaw.slice(0, cut + 1) : descRaw;
    if (title.length > MAX_TITLE) title = `${title.slice(0, MAX_TITLE)}…`;
    const rest = cut > 6 ? descRaw.slice(cut + 1).trim() : "";

    const parts = [];
    if (rest) parts.push(rest);
    const song = songOf(item.music);
    if (song) parts.push(`配乐：${song}`);
    let desc = parts.join("。");
    if (desc.length > MAX_DESC) desc = `${desc.slice(0, MAX_DESC)}…`;

    /*
     * 图片直链。图文作品是 `images[]` 每张一条，视频作品退到封面那一张 ——
     * 一段视频我们不下载（那是 media.js 那条路的事），但封面至少让模型看见
     * 画面里有什么。
     */
    const isPhoto = Array.isArray(item.images) && item.images.length;

    /*
     * 视频作品：连视频直链一起带出去，让调用方真的下载、喂给视频模型。
     *
     * 封面只是一帧静止画面 —— 「你好要喝点什嘛」那条里镜头在动、有人说话，
     * 光看封面等于没看。`video.play_addr.url_list[0]` 实测直连就能下
     * （200、真 mp4、1.38MB / 424ms，跳到 `v9-chc.douyinvod.com`），
     * 不用签名、不用第三方解析服务。
     *
     * 那个地址里的 `playwm` 是 **watermark**：画面角上带抖音 logo 和号码。
     * 无水印版要另拼 CDN 地址，是会跟着人家改版失效的灰色路子，而水印对模型
     * 理解内容毫无影响 —— 用稳的这条。
     *
     * **时长闸在这里判，不在下载那头**：`video.duration` 页面数据里就有，
     * 所以超长的视频一个字节都不下载。理由见 MAX_VIDEO_MS。
     */
    let video = null;
    let videoSkip = "";
    if (!isPhoto) {
      const url = pickMediaUrl(item.video?.play_addr?.url_list);
      const ms = Number(item.video?.duration ?? 0);
      if (!url) {
        videoSkip = "没能取到画面";
      } else if (ms > MAX_VIDEO_MS) {
        videoSkip = `有 ${Math.round(ms / 1000)} 秒，超过了能看的长度`;
      } else {
        video = { url, durationMs: ms };
      }
      if (videoSkip) logDebug(scope, `抖音视频不下载：${videoSkip}`);
    }

    /*
     * 图文作品的每一张图。视频作品这里是空的 —— 它的封面走下面 `cover`。
     */
    const urls = isPhoto ? item.images.map((im) => pickImageUrl(im?.url_list)) : [];

    /*
     * 视频作品的封面单独放 `cover`，**不混进 `images`**。
     *
     * 因为它是「二选一」而不是「都要」：视频真下下来了，封面就不该再进识图那条
     * 路 —— 那是视频第一帧，视频模型自己看得到，单独再塞一张静止图等于为同一
     * 帧画面多打一次模型、还占掉对方的 maxImages 额度。
     *
     * 但选哪个这里定不了：得看**角色开没开视频识别**，而那是调用方才知道的事
     * （配置随时在变，这个函数拿不到 runner）。所以两样都给，调用方挑。
     */
    const cover = isPhoto ? "" : pickImageUrl(item.video?.cover?.url_list);

    return {
      siteName: "抖音",
      title: author ? `${title}（作者：${author}）` : title,
      desc,
      images: urls.filter(Boolean),
      ...(cover ? { cover } : {}),
      ...(video ? { video } : {}),
      ...(videoSkip ? { videoSkip } : {}),
    };
  } catch (e) {
    logDebug(scope, `抖音没解开 ${u.pathname}：${String(e?.message ?? e)}`);
    return null;
  }
}

/**
 * 小红书：和抖音同一个病 —— 页面是客户端渲染的，内容藏在 `__INITIAL_STATE__`。
 *
 * 比抖音省事的地方是**不用 cookie**，一趟就拿得到（实测 120KB）。但 UA 照样
 * 挑 —— 桌面 UA 会被重定向到 `/login`（35KB 登录页，什么都没有），手机 UA 才
 * 给内容。而且这个重定向发生在**跟链那一步**，所以手机 UA 得从第 1 层就用上
 * （`MOBILE_UA_HOSTS`），不是在这儿换就来得及的。
 *
 * 麻烦的地方在那份 JSON 本身：
 *
 *  1. **里面有裸的 `undefined` 字面量**，直接 `JSON.parse` 一定炸
 *     （`Unexpected token u`）。它是 Vue 把服务端状态直接序列化出来的产物，
 *     不是标准 JSON。替成 `null` 再解。
 *  2. 作者字段是 `nickName`（**驼峰 N 大写**），不是别处常见的 `nickname`。
 *     写错了不报错，只是作者永远是空的 —— 我第一版就踩了。
 *
 * 笔记的正文在 `desc` 而不是 `title`（实测 `title` 是空串），话题标签写成
 * `#GPT[话题]#` 这种形式夹在正文里，读得懂，就原样留着。
 */
async function xhsDetail(u, scope) {
  try {
    const res = await fetch(u.toString(), {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: MOBILE_HEADERS,
      ...(await proxyFor("link")),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    const raw = /__INITIAL_STATE__\s*=\s*(\{[\s\S]*?)<\/script>/.exec(html)?.[1];
    if (!raw) throw new Error("页面里没有 __INITIAL_STATE__");

    let data;
    const body = raw.trim().replace(/;\s*$/, "");
    try {
      data = JSON.parse(body);
    } catch {
      // 见上面第 1 条：裸 undefined 替成 null 再试
      data = JSON.parse(body.replace(/\bundefined\b/g, "null"));
    }

    const note = data?.noteData?.data?.noteData;
    if (!note) throw new Error("没有 noteData（页面结构变了？）");

    // 正文在 desc；title 实测是空串，但人家哪天填了就优先用
    const titleRaw = clean(note.title ?? "", MAX_TITLE);
    const descRaw = clean(note.desc ?? "", MAX_TITLE + MAX_DESC);
    if (!titleRaw && !descRaw) throw new Error("标题和正文都是空的");

    const author = clean(note.user?.nickName ?? note.user?.nickname ?? "", 30);

    /*
     * 没有独立标题时，正文切成「标题 + 简介」两截 —— 和抖音那边同一个做法
     * （切不出来就整段当标题）。有标题的话正文整段当简介。
     */
    let title = titleRaw;
    let rest = descRaw;
    if (!title) {
      const cut = /[。！？\n]/.exec(descRaw)?.index ?? -1;
      title = cut > 6 ? descRaw.slice(0, cut + 1) : descRaw;
      if (title.length > MAX_TITLE) title = `${title.slice(0, MAX_TITLE)}…`;
      rest = cut > 6 ? descRaw.slice(cut + 1).trim() : "";
    }

    let desc = rest;
    if (desc.length > MAX_DESC) desc = `${desc.slice(0, MAX_DESC)}…`;

    /*
     * 图片直链。`imageList[].url` 是 H5 版（1080 宽），够识图用了 ——
     * `infoList` 里还有其他尺寸，但没必要为了更大的图多花上传时间。
     */
    const urls = Array.isArray(note.imageList)
      ? note.imageList.map((im) => (typeof im?.url === "string" ? im.url : ""))
      : [];

    return {
      siteName: "小红书",
      title: author ? `${title}（作者：${author}）` : title,
      desc,
      images: urls.filter(Boolean),
    };
  } catch (e) {
    logDebug(scope, `小红书没解开 ${u.pathname}：${String(e?.message ?? e)}`);
    return null;
  }
}

/** `url_list` 里挑一条能用的。几条是同一张图的不同 CDN，取第一条就行。 */
function pickImageUrl(list) {
  if (!Array.isArray(list)) return "";
  const hit = list.find((x) => typeof x === "string" && /^https?:\/\//i.test(x));
  return hit ?? "";
}

/** 同上，给视频直链用。分开写只为让调用处读起来知道取的是什么。 */
function pickMediaUrl(list) {
  return pickImageUrl(list);
}

/**
 * 从 `item.music` 里洗出「歌名 - 歌手」。
 *
 * 抖音原声的 title 实测是这种啰嗦写法：
 *
 *   @左边创作的原声一左边（原声中的歌曲：It's Only Rain-Euge Groove）
 *
 * 真正有用的是括号里那截。抠出来当歌名（它自己就带着 `歌名-歌手` 的形状）；
 * 抠不到说明是正常的歌曲条目，那时 title 本身就是歌名，配上 author 当歌手。
 */
function songOf(music) {
  const raw = clean(music?.title ?? "", 60);
  if (!raw) return "";

  const inner = /原声中的歌曲[:：]\s*([^）)]+)/.exec(raw)?.[1]?.trim();
  if (inner) return clean(inner, 50);

  const author = clean(music?.author ?? "", 30);
  // 作者名已经在 title 里出现过就别重复（`@某人创作的原声` 这种）
  return author && !raw.includes(author) ? `${raw} - ${author}` : raw;
}

/** 第 3 层的分派表。键是域名后缀，值是拿 `(URL, scope)` 的函数。 */
const SPECIAL = [
  { suffix: "bilibili.com", run: biliDetail },
  // 短链 `v.douyin.com` 已经在第 1 层跟到了这两个域名之一
  { suffix: "douyin.com", run: douyinDetail },
  { suffix: "iesdouyin.com", run: douyinDetail },
  // 短链 `xhslink.cn` 同理，第 1 层跟完就是 xiaohongshu.com
  { suffix: "xiaohongshu.com", run: xhsDetail },
];

function specialFor(u) {
  const host = u.hostname.toLowerCase();
  const hit = SPECIAL.find((s) => host === s.suffix || host.endsWith(`.${s.suffix}`));
  return hit?.run ?? null;
}

/**
 * 这份 og 是不是整站共用的那句套话，跟这条链接指向什么毫无关系。
 *
 * **只给 SPECIAL 表里的站用**（调用处说了为什么），所以判据可以很直接：
 * 那几家专门处理失败时的 og 长什么样是**实测过的**，不用猜。
 *
 * 抖音风控拦下来时给的是：
 *
 *   title: 在抖音记录美好生活20260920
 *   desc : 于20260920发布在抖音，已经收获了0个喜欢，来抖音，记录美好生活！
 *
 * 两条判据，满足一条就算套话：
 *
 *  1. **标题里出现了域名主段**（`douyin`、`xiaohongshu`、`bilibili`）**又不含
 *     别的实质内容**。这里的「实质内容」看的是掐掉站名和日期数字之后还剩几个字。
 *  2. 标题和这个站的**招牌口号**对得上。口号写在下面那张表里 —— 表只覆盖
 *     SPECIAL 那几家，不需要普适。
 */
function isPlaceholderMeta(info, u) {
  const title = String(info?.title ?? "");
  if (!title) return true;

  // SPECIAL 那几家的招牌口号，实测撞上的就这几句
  const slogans = [/在抖音记录美好生活/, /记录美好生活/, /你的生活兴趣社区/, /^小红书$/, /^抖音$/];
  if (slogans.some((re) => re.test(title))) return true;

  /*
   * 掐掉站名（域名主段的中英两种写法）和纯数字（那种 og 会把当天日期塞进
   * 标题，`在抖音记录美好生活20260920`），看还剩多少字。
   */
  const host = u.hostname.toLowerCase();
  const brand = /douyin/.test(host)
    ? /抖音|douyin/gi
    : /xiaohongshu|xhs/.test(host)
      ? /小红书|xiaohongshu/gi
      : /bilibili/.test(host)
        ? /哔哩哔哩|bilibili|b站/gi
        : null;
  if (!brand) return false;

  const left = title.replace(brand, "").replace(/\d+/g, "").replace(/[\s\-|_–—·、，,。:：!！]/g, "");
  return left.length <= 4;
}

/* ================= 对外 ================= */

/**
 * 解一条链接。返回 `{siteName, title, desc, images?}`，解不开返回 null。
 *
 * 顺序：跟重定向 → 有专门处理就先走它 → 否则（或者它失败了）退到 og。
 * 缓存的键是**真实网址**而不是原始短链，所以同一首歌的不同短链只会抓一次。
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
    /*
     * 带图片的条目有**保质期**：图片直链上挂着 `x-expires` 和签名（抖音实测
     * 约两天），缓存久了拿出来就是一串死链，白下载一轮再降级。过期就当没命中，
     * 重抓一次拿新直链。
     *
     * 不带图片的条目（绝大多数链接）照旧永久缓存，行为和以前一样 ——
     * 一条网页的标题不会因为放了半小时就不对了。
     */
    const stale = hit?.images?.length && Date.now() - (hit.at ?? 0) > IMAGE_URL_TTL_MS;
    if (!stale) {
      logDebug(scope, `「${key}」用的是缓存里的结果${hit ? `：${hit.title}` : "（上次就没解开）"}`);
      return hit;
    }
    logDebug(scope, `「${key}」缓存里的图片直链可能过期了，重抓一次`);
  }

  /*
   * 第 3 层（有专门处理的那几家）**先走**，og 退成兜底。
   *
   * 本来是反过来的：og 更通用、也不会跟着人家改版失效，所以让它优先。但对
   * SPECIAL 表里这几家，og 不是「可能有用」而是**确定没用**，先跑它有两个害处：
   *
   *  1. **白花一个来回。** 抖音空壳、小红书登录墙，og 一个都读不到，注定要退到
   *     第 3 层，那一趟纯属浪费。
   *  2. **更糟的是它会拿垃圾结果挡住第 3 层。** 小红书手机 UA 下的页面 og 全空
   *     但 `<title>` 是「小红书」三个字，parseMeta 认它是成功，于是输出
   *     `[这条链接是：小红书]` —— 笔记正文和图片全丢了。
   *
   *     这里试过在 parseMeta 里加启发式判「这标题只是个站名」，放弃了：那种
   *     形状五花八门（单段、两段带分隔符、带标语），而写得够宽就会误伤正常
   *     标题 —— 「巴塞罗那 - 维基百科，自由的百科全书」正好也是「短内容名 +
   *     长站名」，条目名短的维基页会被当成首页扔掉。换序不需要任何猜测。
   *
   * 既然这几家是**手工挑进 SPECIAL 表**的，就该信这份名单：这家我们有专门的解法，
   * 不用先去试通用的那条。第 3 层失败了照样退回 og（人家哪天把 og 补上了，或者
   * 改版让专门处理失效了，这条兜底还在）—— 但要先过下面那道「这句话有内容吗」。
   */
  let info = null;
  const special = specialFor(final);
  if (special) info = await special(final, scope);

  if (!info) {
    try {
      const html = await fetchHead(final, scope);
      const og = parseMeta(html);
      /*
       * 专门处理失败后退回 og 时，**og 的结果要再挑一次**。
       *
       * 抖音的第 3 层不是稳定成功 —— 实测 5 次里有 1 次被风控挡掉（日志
       * `没有 item_list（cookie 没生效？）`）。那时候它的 og 给的是：
       *
       *   在抖音记录美好生活20260920。于20260920发布在抖音，已经收获了0个喜欢
       *
       * 这比不解开更糟：模型会以为自己读懂了这条链接，然后基于「收获了 0 个
       * 喜欢」这种毫无关系的话去回复。宁可让它看见一条没解开的裸链接 ——
       * 那时候它至少知道自己不知道。
       *
       * 只对 SPECIAL 表里的站这么挑。别的站 og 给什么就是什么，那是它们唯一
       * 的信息来源，再挑就真的什么都不剩了。
       */
      info = special && og && isPlaceholderMeta(og, final) ? null : og;
      if (special && og && !info) {
        logDebug(scope, `${final.hostname} 的 og 只是套话（${og.title}），当没解开`);
      }
    } catch (e) {
      logDebug(scope, `抓 ${final.hostname} 失败：${String(e?.message ?? e)}`);
    }
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
 * ── 为什么还要吐图片和视频 ──
 *
 * 光补一句「这条链接是：抖音 - 某某的图文作品」，模型知道有图但看不见内容。
 * 抖音那种图文作品的**全部信息都在图里**，配文往往只是一句感慨。所以解出图片
 * 直链的站（抖音、小红书）把直链一并带出去，由调用方下载、走识图那条路
 * （imessage.js:describeImages）真的喂给视觉模型。
 *
 * 抖音的**视频作品**同理：封面只是一帧静止画面，镜头在动、有人说话都看不到。
 * 够短的视频（见 MAX_VIDEO_MS）连视频直链一起带出去，走 describeVideos。
 *
 * 这个函数自己**不下载**：它是收消息路径上的一环，下载几百 KB 图片、几 MB
 * 视频该由调用方决定要不要做、什么时候做。
 *
 * @param {string} text 对方那条消息的正文
 * @param {string} [scope] 日志前缀
 * @returns {Promise<{text:string, images:string[], videos:Array<{url:string,durationMs:number}>, covers:string[]}>}
 *   `text` 是补过说明的正文（没有可解的链接就是原文）；
 *   `images` 是解出来的图片直链；`videos` 是够短、值得下载的视频直链；
 *   `covers` 是视频作品的封面 —— **和 `videos` 二选一**，视频没下（角色没开
 *   视频识别、或者下失败了）时才用它，理由见 douyinDetail 里那段注释
 */
export async function renderLinks(text, scope = "链接") {
  const raw = String(text ?? "");
  if (!raw || !/https?:\/\//i.test(raw)) return { text: raw, images: [], videos: [], covers: [] };

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
  if (!targets.length) return { text: raw, images: [], videos: [], covers: [] };

  const settled = await Promise.allSettled(targets.map((t) => resolveOne(t, scope)));

  // 解开了的攒成一张表，下面按原文顺序替换
  const notes = new Map();
  const images = [];
  const videos = [];
  const covers = [];
  for (let i = 0; i < targets.length; i += 1) {
    const r = settled[i];
    if (r.status !== "fulfilled" || !r.value) continue;
    const { siteName, title, desc, videoSkip } = r.value;
    // 标题里已经带着站名时别再前置一遍（GitHub 的 og:title 就是
    // 「GitHub - nodejs/node: …」，加上去会变成「GitHub - GitHub - …」）
    const dup = siteName && title.toLowerCase().includes(siteName.toLowerCase());
    const head = siteName && !dup ? `${siteName} - ${title}` : title;
    /*
     * videoSkip 就地拼在这条链接的说明里，不往外传 —— 它是「哪一条链接」的事实，
     * 攒成数组就对不上号了（一条消息里可以有好几个链接）。
     *
     * 和调用方那句「只能看到封面」不重叠：这里是压根没往下走（太长/没直链），
     * 那边是走了但没成（角色没开视频识别、或者下载失败），两种情况互斥。
     */
    const skip = videoSkip ? `（${videoSkip}，只有一张封面）` : "";
    notes.set(targets[i], `[这条链接是：${head}${desc ? `。${desc}` : ""}${skip}]`);
    // 多条链接各自带图时按原文顺序攒在一起，上限交给调用方（见那边的注释）
    if (r.value.images?.length) images.push(...r.value.images);
    if (r.value.video) videos.push(r.value.video);
    if (r.value.cover) covers.push(r.value.cover);
  }
  if (!notes.size) return { text: raw, images: [], videos: [], covers: [] };

  const out = raw.replace(URL_RE, (url) => {
    const trimmed = url.replace(TAIL_PUNCT, "");
    const note = notes.get(trimmed);
    if (!note) return url;
    // 末尾的句读留在补充说明后面，读起来才顺
    return `${trimmed} ${note}${url.slice(trimmed.length)}`;
  });
  return { text: out, images, videos, covers };
}

/**
 * 下这张图该带什么 Referer。
 *
 * 各家 CDN 的防盗链规则不一样，而且**带错了比不带更糟**：
 *
 *   抖音 `*.douyinpic.com`   不带 Referer 会被拒，带 CDN 自己的域名就行
 *   小红书 `*.xhscdn.com`    带 CDN 自己的域名 **403**；不带、或者带
 *                            `www.xiaohongshu.com` 都给 200（实测同一条直链，
 *                            Referer × 协议五种组合全试过）
 *
 * 所以不能一律 `${u.origin}/`。已知要带站点域名的列在下面，其余照旧带同源
 * （抖音靠这条），认不出的 CDN 保持原来的行为。
 *
 * @returns {{Referer: string}} 直接摊进 headers
 */
function refererFor(u) {
  const host = u.hostname.toLowerCase();
  if (host.endsWith("xhscdn.com")) return { Referer: "https://www.xiaohongshu.com/" };
  return { Referer: `${u.origin}/` };
}

/**
 * 把 renderLinks 吐出来的图片直链下载成能喂给视觉模型的形状。
 *
 * 产出的 `{base64, mimeType, name}` 和附件那条路（imessage.js:readImageAttachment）
 * 一模一样，所以下游 describeImages / describeImage 不用为这条路加任何分支。
 *
 * ── 失败是常态，不是异常 ──
 *
 * 这些直链上挂着签名和过期时间，下不下来取决于人家的 CDN 心情。所以**逐张**
 * 各自 try：一张下崩了另外三张照样喂进去，全崩了就返回空数组，由调用方在正文
 * 里补一句「图片没能识别成功」—— 配文和配乐那部分跟图片无关，照样补得上。
 *
 * @param {string[]} urls renderLinks 返回的 images
 * @param {string} [scope] 日志前缀
 * @returns {Promise<Array<{base64:string, mimeType:string, name:string}>>}
 */
export async function fetchLinkImages(urls, scope = "链接") {
  const list = Array.isArray(urls) ? urls.filter(Boolean) : [];
  if (!list.length) return [];

  const got = await Promise.all(
    list.map(async (url, i) => {
      let u;
      try {
        u = new URL(url);
      } catch {
        return null;
      }
      // 直链同样是外部输入，下载前过一遍那道闸（理由见 isFetchable）
      if (!isFetchable(u)) return null;

      try {
        const res = await fetch(u.toString(), {
          redirect: "follow",
          signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
          headers: {
            ...BROWSER_HEADERS,
            Accept: "image/webp,image/jpeg,image/png,*/*;q=0.8",
            ...refererFor(u),
          },
          ...(await proxyFor("link")),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const ctype = String(res.headers.get("content-type") ?? "").toLowerCase();
        // 签名过期时人家返回的是一段 XML 错误页而不是 404，靠这个先挡一道
        if (ctype && !ctype.startsWith("image/")) {
          throw new Error(`不是图片（${ctype.split(";")[0]}）`);
        }

        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_IMAGE_BYTES) {
          throw new Error(`图片太大（${Math.round(buf.length / 1024)}KB）`);
        }
        if (buf.length < 64) throw new Error("图片是空的");

        /*
         * 类型按**字节**认，不信 Content-Type —— 这正是 media.js:sniffImageType
         * 存在的理由（那边的注释：「中转站给的 Content-Type 经常是
         * application/octet-stream」）。嗅不出来说明拿到的压根不是图片
         * （签名过期时抖音返回的是一段 XML），直接判失败：硬按 jpeg 塞给
         * 视觉模型只会换来一个看不懂的报错，还白花一次调用。
         */
        const kind = sniffImageType(buf);
        if (!kind) throw new Error("字节看起来不是图片");

        logDebug(
          scope,
          `取到链接里的图${i + 1}：${Math.round(buf.length / 1024)}KB ${kind.mimeType}`
        );
        return {
          base64: buf.toString("base64"),
          mimeType: kind.mimeType,
          name: `链接图片${i + 1}${kind.ext}`,
        };
      } catch (e) {
        logDebug(scope, `链接里的图${i + 1}没取到：${String(e?.message ?? e)}`);
        return null;
      }
    })
  );

  return got.filter(Boolean);
}

/**
 * 把 renderLinks 吐出来的视频直链下载成能喂给视频模型的形状。
 *
 * 产出的 `{base64, mimeType, name, release}` 和对方直接发视频那条路
 * （imessage.js:readVideo）一模一样，所以 describeVideos 不用为这条路加分支。
 *
 * ── 那个 release() 不是可选的 ──
 *
 * 一段视频的 base64 是几 MB 到十几 MB，而它只在「上传给模型」那一下有用。
 * readVideo 的注释把这件事说透了：不撒手的话这些字节会一直挂在会话的处理链上，
 * 几条会话同时来就是要乘的。describeVideos 里的 finally 会调它 —— 这里必须
 * 把这个方法也带上，否则那个 finally 对着链接来的视频就是空转。
 *
 * ── 为什么不转码 ──
 *
 * 抖音给的本来就是 mp4（实测 `ftyp` 魔数、`video/mp4`），视频模型直接收。
 * 上 ffmpeg 压一遍要几十秒 CPU，在 2 核小机器上是实打实的卡顿，换来的只是
 * 省一点上传流量 —— 不值。时长闸（MAX_VIDEO_MS）已经把大文件挡在外面了。
 *
 * @param {Array<{url:string, durationMs:number}>} videos renderLinks 返回的 videos
 * @param {string} [scope] 日志前缀
 * @returns {Promise<Array<{base64:string, mimeType:string, name:string, release:Function}>>}
 */
export async function fetchLinkVideos(videos, scope = "链接") {
  const list = Array.isArray(videos) ? videos.filter((v) => v?.url) : [];
  if (!list.length) return [];

  const got = await Promise.all(
    list.map(async (item, i) => {
      let u;
      try {
        u = new URL(item.url);
      } catch {
        return null;
      }
      // 直链同样是外部输入，下载前过一遍那道闸（理由见 isFetchable）
      if (!isFetchable(u)) return null;

      try {
        const res = await fetch(u.toString(), {
          redirect: "follow",
          signal: AbortSignal.timeout(VIDEO_TIMEOUT_MS),
          headers: {
            ...MOBILE_HEADERS,
            Accept: "video/mp4,video/*;q=0.9,*/*;q=0.8",
            // 抖音的视频 CDN 认这个（和图片那条一样）
            Referer: "https://www.douyin.com/",
          },
          ...(await proxyFor("link")),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        /*
         * Content-Length 先挡一道：超限的视频**一个字节都不用下**。
         *
         * 和 readVideo 里先看 SDK 报的 `size` 是同一个套路。拿不到（chunked）
         * 才退回「读完再量」，那时候字节已经进内存了，但下面立刻没有引用。
         */
        const claimed = Number(res.headers.get("content-length") ?? 0);
        if (claimed > MAX_VIDEO_BYTES) {
          throw new Error(`视频 ${(claimed / 1024 / 1024).toFixed(1)}MB，超过上限（没有下载）`);
        }

        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_VIDEO_BYTES) {
          throw new Error(`视频 ${(buf.length / 1024 / 1024).toFixed(1)}MB，超过上限`);
        }
        if (buf.length < 1024) throw new Error("视频是空的");

        /*
         * 按**字节**认是不是 mp4，不信 Content-Type。
         *
         * mp4 的魔数在第 4 字节起的 `ftyp`（前 4 个字节是 box 长度）。抖音风控
         * 拦下来时返回的是一小段 HTML 或 XML，这一步能判出来 —— 硬塞给视频
         * 模型只会换一个看不懂的报错，还白花一次调用（同 fetchLinkImages 那段）。
         */
        if (buf.subarray(4, 8).toString("latin1") !== "ftyp") {
          throw new Error("字节看起来不是 mp4");
        }

        const mb = (buf.length / 1024 / 1024).toFixed(2);
        logDebug(
          scope,
          `取到链接里的视频${i + 1}：${mb}MB，${Math.round((item.durationMs ?? 0) / 1000)} 秒`
        );

        const out = {
          base64: buf.toString("base64"),
          mimeType: "video/mp4",
          name: `链接视频${i + 1}.mp4`,
        };
        // 识别完就撒手（理由见上面那段注释和 readVideo）
        out.release = () => {
          out.base64 = "";
        };
        return out;
      } catch (e) {
        logDebug(scope, `链接里的视频${i + 1}没取到：${String(e?.message ?? e)}`);
        return null;
      }
    })
  );

  return got.filter(Boolean);
}
