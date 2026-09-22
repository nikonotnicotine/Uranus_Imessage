/**
 * 出网代理：一个地址 + 一张「哪些类别走它」的勾选表。
 *
 * ── 为什么不做成一个总开关 ──
 *
 * 因为「哪些域名需要代理」这件事在每台机器上都不一样，而且**猜错的代价不对称**。
 * 实测（用户在国内家宽上测的）：
 *
 *   · Photon（iMessage 桥接）——  直连就通，**不用代理**
 *   · Meta 的 graph.instagram.com —— 直连不通，必须代理
 *   · open-meteo / 和风 / WeatherAPI —— 要代理
 *
 * 而「模型 API」那一类打的是**用户自己填的中转站地址**，那些地址在国内直连
 * 本来就通。给它套上代理多半更慢，还可能因为代理落地 IP 和平时不一样被中转站
 * 风控 —— 那会变成「配了代理之后聊天反而不能用了」，用户很难联想到是代理干的。
 *
 * 所以：**一处一个开关，默认只勾上确定需要的那两类**（IG 和天气）。
 * 没勾的直连，和没有这个功能之前的行为一模一样。
 *
 * ── 地址从哪来 ──
 *
 * 按优先级：
 *
 *  1. 控制台里填的（`data.config.json` 的 `proxyKeys.url`）—— 改完当场生效，不用重启
 *  2. `URANUS_PROXY` —— 这个项目自己的环境变量
 *  3. `HTTPS_PROXY` / `https_proxy` / `ALL_PROXY` / `all_proxy` —— 通用约定，
 *     用户多半已经设过了
 *  4. 都没有 → 直连
 *
 * 环境变量留着当兜底是有意的：Docker 和 systemd 那种场合，用环境变量注入比
 * 进界面点一遍顺手；而界面里填的优先级更高，因为那是用户**刚刚**做的动作。
 *
 * ── 为什么用 undici 的 ProxyAgent ──
 *
 * Node 的全局 fetch 就是 undici，`fetch(url, { dispatcher })` 能**只给这一个
 * 请求**挂代理。相比设 `globalThis[Symbol.for("undici.globalDispatcher.1")]`
 * 那种全局做法，这里能做到「按类别分别决定」，也不会波及别人的代码。
 *
 * undici 是 open-graph-scraper 的传递依赖（已经在 node_modules 里，7.x），
 * **不新增顶层依赖** —— 这个项目的用户大多在 Windows 上双击 bat，能不装就不装。
 *
 * 注意 `socks5://` 这类地址 ProxyAgent 是**不支持**的（它只认 http/https 代理）。
 * 填了 socks 会在挂 agent 的时候抛，被下面 catch 住退回直连并记一条警告 ——
 * 界面上那个「测试连通」会把这件事说清楚。
 */

import { CONFIG_PATH, LEGACY_CONFIG_PATH, SECRET_PATH, readJson } from "./datadir.js";
import { logInfo, logWarn } from "./logs.js";

const SCOPE = "代理";

/* ================= 类别 ================= */

/**
 * 能单独决定走不走代理的几类出网。
 *
 * `key` 进配置，`label` 和 `hint` 直接显示在界面上，`domains` 是给用户看的
 * 「这一类到底打哪些域名」—— 不写清楚的话没人知道该勾哪个。
 *
 * `default` 是出厂勾选状态。只有 IG 和天气是 `true`：那两类是用户实测直连不通的，
 * 其余默认直连（详见文件头那段「猜错的代价不对称」）。
 */
export const PROXY_SCOPES = [
  {
    key: "ig",
    label: "Instagram",
    domains: "graph.instagram.com、graph.facebook.com",
    hint: "Meta 的接口，国内直连不通",
    default: true,
  },
  {
    key: "weather",
    label: "天气",
    domains: "open-meteo.com、qweatherapi.com、weatherapi.com",
    hint: "三家天气源和地名查询",
    default: true,
  },
  {
    key: "llm",
    label: "模型 API",
    domains: "你在「连接」里填的那些地址",
    hint: "中转站在国内多半直连就通，套代理反而慢，还可能被风控",
    default: false,
  },
  {
    key: "search",
    label: "联网搜索",
    domains: "api.tavily.com、api.search.brave.com、duckduckgo.com",
    hint: "DuckDuckGo 直连不通",
    default: false,
  },
  {
    key: "tts",
    label: "语音合成",
    domains: "api.minimax.chat、api.elevenlabs.io",
    hint: "ElevenLabs 直连不通",
    default: false,
  },
  {
    key: "cloud",
    label: "云备份",
    domains: "对象存储和 api.github.com",
    hint: "缤纷云直连通，GitHub 时好时坏",
    default: false,
  },
  {
    key: "update",
    label: "检查更新",
    domains: "api.github.com",
    hint: "拉仓库的 Release 列表",
    default: false,
  },
  {
    key: "music",
    label: "音乐搜索",
    domains: "itunes.apple.com、music.163.com",
    hint: "分享歌曲时查曲目信息",
    default: false,
  },
  {
    key: "link",
    label: "链接预览",
    domains: "对方发来的链接指向哪儿就是哪儿",
    hint: "国内站直连更快，YouTube / Instagram 这类要走代理才读得到标题",
    default: false,
  },
  {
    key: "photon",
    label: "Photon",
    domains: "iMessage 桥接的管理接口",
    hint: "实测直连就通，一般不用勾",
    default: false,
  },
];

/** 所有合法的类别 key。 */
export const SCOPE_KEYS = PROXY_SCOPES.map((s) => s.key);

/** 出厂的勾选表。 */
export function defaultScopes() {
  return Object.fromEntries(PROXY_SCOPES.map((s) => [s.key, s.default]));
}

/* ================= 地址 ================= */

/**
 * 认的环境变量，按优先级。
 *
 * `URANUS_PROXY` 排在最前，给「只想让这个项目走代理、别的照旧」的场合。
 * `URANUS_IG_PROXY` 留着是为了**兼容旧版**：这个功能之前只有 IG 一处代理，
 * 用的就是那个名字，直接不认会让老用户升级之后 IG 悄悄断掉。
 */
const PROXY_VARS = [
  "URANUS_PROXY",
  "URANUS_IG_PROXY",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
];

/**
 * 环境变量里的代理地址，以及它来自哪个变量。
 *
 * 把变量名一起返回是为了界面上能显示「读的是 HTTPS_PROXY」—— 用户设了好几个
 * 的时候，光说「走代理」不够，他要知道到底用的哪一个。
 */
export function envProxy() {
  for (const key of PROXY_VARS) {
    const value = String(process.env[key] ?? "").trim();
    if (value) return { url: value, from: key };
  }
  return { url: "", from: "" };
}

/**
 * 代理地址里的账号密码抹掉，只留「协议 + 主机 + 端口」。
 *
 * 企业代理和机场的地址很多是 `http://user:pass@host:port` 这种形态，而这个串
 * 会进日志文件 —— 用户发日志求助、截图贴群，密码就跟着出去了。抹掉之后
 * 「走的是哪个代理」这个信息还在（主机和端口都留着），够定位问题了。
 *
 * 解析不了（用户填了个不合规的串）就整个换成 `***`：宁可日志里少一条线索，
 * 也不要把一个可能带凭据的串原样写出去。
 */
export function maskProxy(url) {
  const raw = String(url ?? "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    /*
     * 自己拼 `protocol//host`，**不用 `u.origin`** —— `origin` 对
     * socks5: / socks: 这类「非特殊协议」返回的是字符串 `"null"`，
     * 而 socks5 代理在这儿很常见（机场基本都给这个）。
     * `host` 自带端口，不用另外接 `port`。
     */
    if (!u.host) return "***";
    const base = `${u.protocol}//${u.host}`;
    return u.username || u.password ? `${base}（带账号密码，已隐去）` : base;
  } catch {
    return "***";
  }
}

/**
 * 地址填得对不对。
 *
 * 只拦「肯定不能用」的形态，不联网、不解析域名 —— 那是「测试连通」干的事。
 *
 * 特别点出 `socks5://`：机场给的地址基本都是这个，而 ProxyAgent 不支持它。
 * 不说清楚的话用户会填进去、保存成功、然后所有请求都莫名直连。
 *
 * @returns {string} 空串 = 通过；否则是一句能照着改的中文
 */
export function checkProxyUrl(url) {
  const raw = String(url ?? "").trim();
  if (!raw) return "";
  let u;
  try {
    u = new URL(raw);
  } catch {
    return "地址看不懂，要形如 http://127.0.0.1:7890。";
  }
  const scheme = u.protocol.replace(":", "").toLowerCase();
  if (scheme === "socks" || scheme === "socks4" || scheme === "socks5" || scheme === "socks5h") {
    return `暂时不支持 ${scheme}:// 这种代理，只能用 http:// 或 https://。（Clash、v2rayN 那类客户端一般同时开着一个 http 端口，用那个）`;
  }
  if (scheme !== "http" && scheme !== "https") {
    return `不认识 ${scheme}:// 这种代理，要 http:// 或 https://。`;
  }
  if (!u.hostname) return "地址里没有主机名。";
  if (!u.port && !/^https?:$/.test(u.protocol)) return "地址里没有端口。";
  return "";
}

/* ================= 当前设置 ================= */

/**
 * 现在生效的代理设置。
 *
 * 配置是**每次现读**的（`loadConfig` 自己带缓存），所以在控制台里改完当场生效，
 * 不用重启 —— 这个项目有「重启服务」按钮，但为了改个代理去点它太重了。
 *
 * @returns {{url: string, from: string, scopes: Record<string, boolean>, enabled: boolean}}
 */
export function proxySettings() {
  let cfg = null;
  try {
    cfg = readProxyConfig();
  } catch {
    /* 配置读不出来（第一次启动、文件坏了）就只看环境变量 */
  }

  const own = String(cfg?.url ?? "").trim();
  const env = envProxy();
  // 界面里填的优先：那是用户刚刚做的动作
  const url = own || env.url;
  const from = own ? "控制台" : env.from;

  const scopes = { ...defaultScopes() };
  for (const key of SCOPE_KEYS) {
    if (typeof cfg?.scopes?.[key] === "boolean") scopes[key] = cfg.scopes[key];
  }

  return { url, from, scopes, enabled: Boolean(url) };
}

/**
 * 配置里那一小块。
 *
 * **依赖方向是单向的**：这个文件 import config.js，config.js 不 import 这里。
 * 反过来（让 config.js 来取 `defaultScopes()` 当默认值）会成一个循环，
 * 而 `PROXY_SCOPES` 是模块顶层的 `const` —— 循环 import 下按加载顺序会撞上
 * TDZ，报一句很难查的 "Cannot access before initialization"。
 *
 * 所以归一化那一头（config.js 的 `normalizeConfig`）不认得类别清单，
 * 它只做「保留布尔、别的丢掉」；**默认值是在这边补的**（见 `proxySettings`）。
 * 代价是 config.json 里可能存不全九个 key，无所谓 —— 读的时候一律以这边为准。
 *
 * ── 为什么不直接 `loadConfig()` ──
 *
 * 这里是**绕过 config.js 直接读那两个文件**的，原因不是省事：
 *
 *  - `loadConfig()` 会顺带 `ensureLayout()`。而查更新（update.js）也要挂代理，
 *    它以前不 import 配置层，是「拿 GitHub 公开接口就够」那种无依赖的小模块。
 *    换成 loadConfig 之后，光是查一次更新就会把整个 data/ 目录树建出来、还把
 *    两份内置预设种进去 —— 自检里「查完不该多出任何文件」那条当场就红了。
 *  - 代理是**出网前**要问的东西，而配置初始化有好几层（迁移、归一化、集合
 *    读盘）。为了知道「这类要不要走代理」把那一整套拖起来，方向和时机都不对。
 *
 * 代价是这里要自己认老布局的路径（迁移之前，设置还在项目根那两个文件里）。
 * 从 `data.config.json` 里那份优先 —— 地址只住那儿，`config.json` 里那份
 * 顶多是个空占位。
 */
function readProxyConfig() {
  // 地址可能带 user:pass@，只住密钥文件；勾选两边都可能有（见 config.js 的 mergeSecrets）
  const secret = readJson(SECRET_PATH, null)?.proxyKeys ?? readJson(LEGACY_SECRET_PATH, null)?.proxyKeys ?? null;
  const main = readJson(CONFIG_PATH, null)?.proxy ?? readJson(LEGACY_CONFIG_PATH, null)?.proxy ?? null;
  if (!secret) return main;
  return { url: secret.url ?? main?.url ?? "", scopes: { ...(main?.scopes ?? {}), ...(secret.scopes ?? {}) } };
}

/** 某一类要不要走代理。 */
export function usesProxy(scope) {
  const { url, scopes } = proxySettings();
  return Boolean(url) && Boolean(scopes[scope]);
}

/* ================= dispatcher ================= */

/**
 * ProxyAgent 只建一次、缓存住。
 *
 * 每个请求新建一个的话，每次都要重新握手、重新起连接池。缓存住能让同一批请求
 * 复用连接 —— 聊天那种一轮好几个请求的场合差别明显。
 *
 * 地址变了（用户在界面上改了）就重建：缓存的键就是地址本身。
 *
 * undici 挂不上（装不了、或者地址是 socks）就退回直连，只记一条警告 ——
 * 有人的机器本来就能直连，不该因为代理配错了整个功能不可用。
 *
 * ## 缓存的是 Promise，不是建好的 agent
 *
 * 这一点是**必须的**，不是讲究。`await import("undici")` 中间有一段空窗，
 * 而并发出网到处都是（music.js 两家一起查、env.js 几个天气源一起打、IG 一轮
 * 好几个请求）。缓存建好的 agent 的话时序是这样：
 *
 *   请求 A：记下「这个地址正在建」→ await import（让出线程）
 *   请求 B：看到地址对得上 → 拿到还是 null 的 agent → **悄悄直连出去了**
 *
 * 没有任何报错，只是那一半请求没走代理 —— 用户看到的是「勾了却时好时坏」，
 * 而这种间歇性的坏法几乎不可能从日志里查出来。缓存 Promise 之后，B 会
 * 等在 A 那一次创建上，两个拿到同一个 agent。
 */
let cached = { url: "", pending: null };

function agentFor(url) {
  if (!url) return Promise.resolve(null);
  if (cached.url === url) return cached.pending;

  const pending = (async () => {
    try {
      const { ProxyAgent } = await import("undici");
      const agent = new ProxyAgent(url);
      // 地址过一道脱敏：代理串里常带 user:pass@，而这行会进日志文件
      logInfo(SCOPE, `代理已就绪：${maskProxy(url)}`);
      return agent;
    } catch (e) {
      logWarn(SCOPE, `代理 ${maskProxy(url)} 挂不上，这次直连`, e);
      return null;
    }
  })();

  cached = { url, pending };
  return pending;
}

/**
 * 拿某一类的 dispatcher，直接铺进 `fetch` 的 init。
 *
 * 用法是**展开**，没配代理时展开的是空对象、行为和以前一模一样：
 *
 * ```js
 * await fetch(url, { ...init, ...(await proxyFor("weather")) });
 * ```
 *
 * 返回 `{}` 而不是 `null`，就是为了让调用点能无条件展开、不用写 if。
 *
 * @param {string} scope PROXY_SCOPES 里的 key
 * @returns {Promise<{dispatcher?: object}>}
 */
export async function proxyFor(scope) {
  const { url, scopes } = proxySettings();
  if (!url || !scopes[scope]) return {};
  const agent = await agentFor(url);
  return agent ? { dispatcher: agent } : {};
}

/**
 * 把一个网络异常里埋着的错误码全挖出来，最像「真正原因」的那个排在最前。
 *
 * 真实原因有时埋得比 `e.cause` 更深。Happy Eyeballs（Node 20 起默认开）在
 * IPv6 和 IPv4 都连不上时会抛一个 `AggregateError`，`code` 挂在外层、
 * **里面每一条才带具体原因**；代理隧道里出的 TLS/HTTP 错也会再包一层。
 * 只读 `e.cause.code` 的话这些全都读不到，于是掉进 whyNetwork 最后那个兜底、
 * 把 undici 的 `fetch failed` 原样吐出去。
 *
 * `UND_ERR_CONNECT_TIMEOUT` 排在后面：它是 undici 对「连不上」的统称，
 * 底下那条具体的（ECONNREFUSED 之类）才是要说给人听的。
 *
 * @returns {string[]} 从最具体到最笼统。一个都没有时是空数组
 */
export function netCodes(e) {
  const codes = [];
  const seen = new Set();
  const walk = (err, depth = 0) => {
    if (!err || depth > 4 || seen.has(err)) return;
    seen.add(err);
    const c = String(err?.code ?? "").trim();
    if (c) codes.push(c);
    for (const sub of err?.errors ?? []) walk(sub, depth + 1);
    walk(err?.cause, depth + 1);
  };
  walk(e?.cause);
  walk(e);
  const first = codes.find((c) => c !== "UND_ERR_CONNECT_TIMEOUT");
  return first ? [first, ...codes.filter((c) => c !== first)] : codes;
}

/**
 * 最像「真正原因」的那个错误码，没有就是空串。
 *
 * 调用方拿它做**判断**（env.js 靠它认「这是代理自己坏了，值得脱开代理再试
 * 一次」）；要说给人听的话用下面的 whyNetwork。
 */
export function netCode(e) {
  return netCodes(e)[0] ?? "";
}

/**
 * 网络层出错时说人话，带上「是不是代理的问题」。
 *
 * `fetch failed` 是 undici 对一切网络问题的统称，原样抛给用户等于什么都没说。
 * 这里把最常见的几种拆开，每种都直接指向要改的东西 —— 而且会区分
 * 「走着代理出的错」和「直连出的错」，那两种要改的地方完全不同。
 *
 * @param {unknown} e 抓到的异常
 * @param {string} scope 哪一类的请求（决定提示里说不说代理）
 * @param {number} [timeoutMs] 超时值，说给用户听
 */
export function whyNetwork(e, scope, timeoutMs) {
  const name = String(e?.name ?? "");
  const msg = String(e?.message ?? e);
  const viaProxy = usesProxy(scope);
  const via = viaProxy ? `代理 ${maskProxy(proxySettings().url)}` : "";

  const codes = netCodes(e);
  const code = codes[0] ?? "";

  /*
   * 错误码**每一句都要带上**。
   *
   * 这句话会进日志、会进界面、有几处还会原样发到用户的 iMessage 里
   * （imessage.js:notifyFailure）。中文解释是给看的人省事的，而那个码是
   * 唯一能拿去搜、能贴到群里对上号的东西 —— 用户报上来一句「连接被拒绝」，
   * 我们还得再问一轮「日志里那个码是什么」。
   *
   * 原来只有 UND_ERR_ 那一档带码，别的档没带。llm.js 以前自己那套是每句都带
   * 的（`（代码 ECONNREFUSED）`），改成转发到这里时不能把这个丢掉。
   */
  const tag = code ? `（${code}）` : "";

  if (name === "TimeoutError" || code === "UND_ERR_HEADERS_TIMEOUT" || /timeout/i.test(msg)) {
    const secs = timeoutMs ? `（${Math.round(timeoutMs / 1000)} 秒）` : "";
    return viaProxy
      ? `请求超时${secs} —— ${via} 可能不通`
      : `请求超时${secs} —— 这一类没走代理，被墙的话去控制台的「代理」那节勾上`;
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return viaProxy
      ? `域名解析不了${tag} —— 检查 ${via}`
      : `域名解析不了${tag} —— 地址是不是打错了？也可能是这台机器的 DNS 不通，或者要走代理`;
  }
  if (code === "ECONNREFUSED") {
    /*
     * 直连时的 ECONNREFUSED 和走代理时是**两件事**，提示不能共用一句：
     * 走代理是「代理没开 / 端口填错」，直连是「对方那个端口上没有服务」——
     * 后者多半是接口地址写错了（少了端口、多了路径、http 写成了 https）。
     * 让它去勾代理是误导，被墙的表现是超时或者被重置，不是被拒绝。
     */
    return viaProxy
      ? `${via} 拒绝连接${tag}（代理没开？端口错？）`
      : `对方拒绝连接${tag} —— 那个端口上没有服务，接口地址和端口填对了吗？`;
  }
  if (code === "ECONNRESET") {
    return viaProxy
      ? `连接被重置${tag} —— ${via} 不稳定？`
      : `连接被重置${tag} —— 这一类没走代理，可能被墙了`;
  }
  if (code === "CERT_HAS_EXPIRED" || code.startsWith("ERR_TLS") || /certificate/i.test(msg)) {
    return viaProxy
      ? `证书校验失败${tag} —— ${via} 在中间做了 TLS 拦截？`
      : `证书校验失败${tag} —— 中间有东西在拦（企业网关、杀毒软件的 HTTPS 扫描）`;
  }
  if (/^UND_ERR_|^ECONN|^EPIPE$|^ETIMEDOUT$/.test(code)) {
    const hint = viaProxy
      ? `${via} 那边连不上`
      : "这一类没走代理，目标在国内连不上的话去控制台的「代理」那节勾上并填地址";
    return `连不上目标${tag} —— ${hint}`;
  }

  // 兜底也得带点信息：`fetch failed` 这一句等于什么都没说，而这几种错误
  // 恰恰是最常见的几种，多带一两个词能省掉一轮排查
  if (/fetch failed|socket|other side closed/i.test(msg)) {
    return viaProxy
      ? `连接失败${tag} —— 检查 ${via} 是不是还开着`
      : `连接失败${tag} —— 目标在国内连不上，去控制台「代理」那节勾上并填地址`;
  }
  return codes.length ? `${msg}（${codes.join("、")}）` : msg;
}

/* ================= 测试连通 ================= */

/** 测试连通的超时。比业务请求短：用户在界面上等着看结果。 */
const TEST_TIMEOUT = 8000;

/**
 * 测一个代理地址通不通。界面上那个「测试连通」按钮就打这个。
 *
 * 打的是 `https://www.gstatic.com/generate_204` —— 挑它的理由：
 * 响应体是空的（204，省流量）、全球都有节点、而且**它本身在国内直连也通**。
 * 最后这条是关键：如果连它都不通，那基本可以断定是代理本身有问题，
 * 而不是「目标网站被墙」。
 *
 * 不用给定的地址去打 Meta 或 Google：那两个直连不通，测出来的失败没法区分
 * 「代理坏了」和「代理好的但目标本来就要梯子」。
 *
 * 三种传法都有用，`undefined` 和 `""` **刻意不同义**：
 *
 *  - `testProxy("http://…")` 测这个地址 —— 界面上存之前的试探
 *  - `testProxy()` 测**现在生效的**那个 —— 存完之后再确认一下
 *  - `testProxy("")` 测**直连** —— 用来分清「代理坏了」和「这台机器压根出不了网」
 *
 * @param {string} [url] 代理地址；空串 = 测直连；不传 = 测当前生效的
 * @returns {Promise<{ok: boolean, ms: number, detail: string}>}
 */
export async function testProxy(url) {
  const raw = url === undefined ? proxySettings().url : String(url).trim();
  const why = checkProxyUrl(raw);
  if (why) return { ok: false, ms: 0, detail: why };

  let init = {};
  if (raw) {
    try {
      const { ProxyAgent } = await import("undici");
      init = { dispatcher: new ProxyAgent(raw) };
    } catch (e) {
      return { ok: false, ms: 0, detail: `代理挂不上：${String(e?.message ?? e)}` };
    }
  }

  const began = Date.now();
  try {
    const res = await fetch("https://www.gstatic.com/generate_204", {
      ...init,
      signal: AbortSignal.timeout(TEST_TIMEOUT),
    });
    const ms = Date.now() - began;
    // 204 是期望值，但只要有响应就说明这条路是通的（有些代理会插一个 200 页面）
    if (res.status === 204 || res.ok) {
      return {
        ok: true,
        ms,
        detail: raw ? `通了，${ms} 毫秒（走 ${maskProxy(raw)}）` : `直连就通，${ms} 毫秒`,
      };
    }
    return { ok: false, ms, detail: `代理有响应但状态码是 ${res.status} —— 可能要账号密码？` };
  } catch (e) {
    const ms = Date.now() - began;
    const code = String(e?.cause?.code ?? e?.code ?? "");
    const name = String(e?.name ?? "");
    if (name === "TimeoutError" || /timeout/i.test(String(e?.message ?? ""))) {
      return {
        ok: false,
        ms,
        detail: raw
          ? `${Math.round(TEST_TIMEOUT / 1000)} 秒没连上 —— 地址和端口对吗？代理开着吗？`
          : `${Math.round(TEST_TIMEOUT / 1000)} 秒没连上 —— 直连不通，得配代理`,
      };
    }
    if (code === "ECONNREFUSED") {
      return { ok: false, ms, detail: "拒绝连接 —— 代理没在这个端口上听（Clash 默认 7890，v2rayN 默认 10809）" };
    }
    if (code === "ENOTFOUND") {
      return { ok: false, ms, detail: "这个主机名解析不了 —— 地址打错了？" };
    }
    return { ok: false, ms, detail: String(e?.message ?? e) };
  }
}

/**
 * 给界面的现状摘要。
 *
 * 地址**脱敏之后**才回给前端 —— 这个响应会进浏览器的网络面板，而代理串里
 * 常带账号密码。前端只需要知道「配了、长什么样、读的哪一处」。
 */
export function proxyStatus() {
  const { url, from, scopes, enabled } = proxySettings();
  return {
    enabled,
    masked: maskProxy(url),
    from,
    scopes,
    // 界面要照着这个渲染勾选框，顺带把「这一类打哪些域名」一起带过去
    catalog: PROXY_SCOPES.map(({ key, label, domains, hint }) => ({ key, label, domains, hint })),
  };
}
