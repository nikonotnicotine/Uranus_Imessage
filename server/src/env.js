/**
 * 环境感知：「现在几点、今天什么日子、外面什么天气」。
 *
 * 产出**两段**，因为这两样东西的时效性完全不同：
 *
 *   time    进存档。方括号前缀加在每条用户消息开头，于是每条历史消息都
 *           自带它当时的时间戳 —— 模型能看出「三天前那句是周日中午说的」。
 *           时间脉络成了上下文的一部分。
 *   weather **不进存档**，只并进这一轮发给模型的最新一条 user 消息。
 *           天气是只对「现在」有意义的瞬时值：三天前那条消息里的天气对
 *           模型毫无用处，进了存档却要在每一轮里重发一遍。maxContext = 20
 *           时那是 20 份过期天气、约 900 token 白花。
 *
 * 合起来的形状（两段都开时，模型看到的）：
 *
 *   [{{user}}发送当地时间 CST : 2026-09-08 00:38:07 | 周二, 工作日 |
 *    {{char}}收到当地时间 PDT : 2026-09-07 09:38:07 | 周一, 工作日 |
 *    {{user}}当地天气: 南宁 晴 26.1°C (24.1~32.4°C) | 明日预报: 雷阵雨 25.8~32.0°C | ⚠ 暴雨橙色预警 ;
 *    {{char}}当地天气: 旧金山 晴 18.1°C (14.2~21.0°C) | 明日预报: 阴 18.1~31.4°C]你好
 *
 * （实际是一行，这里为了看得清才折行。）存档里只有前两段。
 * 拼接由 prompt.js 的 injectWeather 做 —— 它把天气段并进那对方括号里。
 *
 * 里面留的是字面 {{user}} / {{char}} —— 存档里存字面量，角色改名后
 * 旧存档不会跟着失效，替换是 prompt.js 拼提示词时才做的事。
 *
 * 时间部分是纯本地计算，永不失败；天气要联网，所以整块包了短超时，
 * 拿不到就只出时间部分。绝不因为天气查不到而拖慢或挡住一条回复。
 *
 * 天气有三个数据源，按城市所在国自动分派（见 pickSource）：Open-Meteo
 * （默认，免费无密钥，无预警）、和风天气（国内，官方灾害预警）、
 * WeatherAPI（国外）。后两个要用户自填密钥，任何一环没配齐或请求失败
 * 都退回 Open-Meteo —— 天气是锦上添花，有总比没有好。
 *
 * 「有总比没有好」这条贯彻到底：同一坐标两小时内不重查（WEATHER_TTL），
 * 三家都打不通时拿上一次查到的顶上（staleWeather，最多 24 小时），
 * 那份缓存还落盘（重启也不丢），代理自己坏掉时脱开代理直连再试一次
 * （fetchJson）。全落空了才是「这一轮不带天气」。
 */

import chineseDaysPkg from "chinese-days";
import Holidays from "date-holidays";

import { WEATHER_CACHE_PATH, readJson, writeJson } from "./datadir.js";
import { logDebug, logWarn } from "./logs.js";
import { fetchVia, whyNetwork } from "./proxy.js";

/**
 * chinese-days 的 ESM 默认导出套了两层：顶层既有各个函数、又有一个
 * default 键指回自己。挑有 getDayDetail 的那层用。
 */
const CD =
  typeof chineseDaysPkg?.getDayDetail === "function"
    ? chineseDaysPkg
    : chineseDaysPkg?.default;

/**
 * chinese-days 的法定假日数据实测覆盖 2019–2026（2027 起 getHolidaysInRange
 * 返回空数组）。超出范围它**不报错**，而是把 2027-01-01 说成
 * `{work: true, name: "Friday"}` —— 元旦当成普通工作日。
 *
 * 所以要自己判范围：超了就只报工作日/休息日，绝不说出「元旦是工作日」
 * 这种错话。前端也拿这个常量提示用户。
 */
export const HOLIDAY_DATA_FROM = 2019;
export const HOLIDAY_DATA_UNTIL = 2026;

/**
 * 天气的超时。查不到就没有天气，不值得让用户多等。
 *
 * 地理编码给得更宽：它一辈子只查一次（结果永久缓存），而且**后面所有东西
 * 都依赖它** —— 它超时的话时区会退回服务器本地时区，两地时间就全错了。
 * 天气反过来，是纯锦上添花，卡住就算了。
 */
const GEO_TIMEOUT = 8000;
const WEATHER_TIMEOUT = 5000;

/**
 * 地理编码**网络失败**之后，多久之内不再重试（毫秒）。
 *
 * 以前这里是「网络失败一律不缓存，下一轮还该再试」。想法没错，代价却算漏了：
 * 开机时 DNS 没通、或者 geocoding-api.open-meteo.com 被墙了一阵，这个域名
 * 会**每一轮都超时一次**，而 resolveSides 是 `Promise.all` 两个城市一起查、
 * 又卡在 handleTurn 的正前方 —— 用户那头的表现就是「每条消息都要多等 8 秒」，
 * 而且这 8 秒买回来的还是「没有天气、时区退回服务器本地」。
 *
 * 所以失败也记一条，但**只记 10 分钟**，和「城市根本不存在」那个永久 null
 * 分开：短到网络一恢复很快就会再试，长到不会每轮都赔进去一次超时。
 */
const GEO_FAIL_TTL = 10 * 60 * 1000;
/**
 * 天气缓存时长。两小时内同一个城市不再打网络。
 *
 * 半小时太密了：真人一小时里聊几十条消息很正常，而天气半小时也变不了。
 * 代价是**灾害预警最坏情况会晚两小时**才出现在前缀里 —— 这是一个陪聊
 * 场景，不是防灾系统，用一个 TTL 管到底比给预警单开一套缓存值当。
 */
export const WEATHER_TTL = 2 * 60 * 60 * 1000;

/**
 * 查不到天气时，往回退多久还算能用（毫秒）。
 *
 * 以前查失败就 `return null`，这一轮**彻底没有天气** —— 哪怕缓存里正躺着
 * 一小时前刚查到的那份。用户的原话：「报错了不要不带天气啊，带上次查到的
 * 天气不就可以了吗」。确实，两小时前的天气比没有天气有用得多。
 *
 * 上限定在 24 小时：再往前就是拿昨天的天气冒充今天，那还不如没有 ——
 * 模型会一本正经地跟着演「今天好热」，而外面正在下雨。
 */
const WEATHER_STALE_MAX = 24 * 60 * 60 * 1000;
/**
 * 天气查失败后多久之内不再打网络（毫秒）。和 GEO_FAIL_TTL 一个道理：
 * 代理坏掉的时候，每轮消息都去赔一次 5 秒超时，用户那头就是每条都慢 5 秒，
 * 而买回来的还是同一份旧数据。10 分钟够网络恢复后很快再试。
 */
const WEATHER_FAIL_TTL = 10 * 60 * 1000;

/**
 * 时区缩写。
 *
 * Intl 的 timeZoneName: "short" 对美洲时区给的是 PDT / EST 这种正经缩写，
 * 但对亚洲给的是 GMT+8（实测 Asia/Shanghai）—— 用户要的是 CST。
 * 所以常用的亚洲时区列一张表，表里没有的就退回 Intl 给的值。
 */
const TZ_ABBR = {
  "Asia/Shanghai": "CST",
  "Asia/Chongqing": "CST",
  "Asia/Chungking": "CST",
  "Asia/Harbin": "CST",
  "Asia/Macau": "CST",
  "Asia/Macao": "CST",
  "Asia/Taipei": "CST",
  PRC: "CST",
  ROC: "CST",
  "Asia/Urumqi": "XJT",
  "Asia/Kashgar": "XJT",
  "Asia/Tokyo": "JST",
  "Asia/Seoul": "KST",
  "Asia/Pyongyang": "KST",
  "Asia/Hong_Kong": "HKT",
  "Asia/Singapore": "SGT",
  "Asia/Kuala_Lumpur": "MYT",
  "Asia/Jakarta": "WIB",
  "Asia/Bangkok": "ICT",
  "Asia/Ho_Chi_Minh": "ICT",
  "Asia/Manila": "PHT",
  "Asia/Kolkata": "IST",
  "Asia/Calcutta": "IST",
  "Asia/Dhaka": "BST",
  "Asia/Karachi": "PKT",
  "Asia/Dubai": "GST",
  "Asia/Tehran": "IRST",
};

/**
 * 城市留空时用服务器本地时区，而**中文版 Windows 上它不是 Asia/Shanghai**。
 *
 * 实测这台机器 `Intl.DateTimeFormat().resolvedOptions().timeZone` 给的是
 * `Etc/GMT-8`（Windows 的「(UTC+08:00) 北京」映射过来就是这个），上面那张
 * 表按 IANA 城市名索引，压根匹配不到，于是前缀里出现 `GMT+8`。
 *
 * 单纯往表里加 `Etc/GMT-8: CST` 是错的：`Etc/GMT-8` 只是「固定偏移 +8」，
 * 可能是北京也可能是新加坡，猜一个具体缩写等于编造信息。所以这里只把
 * 那串没信息量的 `GMT+8` 归一化成 **UTC+8** —— 一眼能看懂是什么，
 * 也不假装知道是哪个国家。真想看到 CST 就把城市填上（填了就走 geocode
 * 返回的真 IANA 时区，直接命中上面那张表）。
 */
function normalizeAbbr(v) {
  const s = String(v ?? "").trim();
  // GMT+8 / GMT-3:30 / UTC+8 → UTC+8 / UTC-3:30
  const m = /^(?:GMT|UTC)([+-]\d{1,2}(?::\d{2})?)$/.exec(s);
  return m ? `UTC${m[1]}` : s;
}

/** WMO 天气代码 → 中文。Open-Meteo 用的就是这套编码。 */
const WMO = {
  0: "晴",
  1: "晴间多云",
  2: "多云",
  3: "阴",
  45: "雾",
  48: "雾凇",
  51: "毛毛雨",
  53: "小雨",
  55: "中雨",
  56: "冻雨",
  57: "冻雨",
  61: "小雨",
  63: "中雨",
  65: "大雨",
  66: "冻雨",
  67: "冻雨",
  71: "小雪",
  73: "中雪",
  75: "大雪",
  77: "米雪",
  80: "阵雨",
  81: "阵雨",
  82: "暴雨",
  85: "阵雪",
  86: "阵雪",
  95: "雷阵雨",
  96: "雷阵雨伴冰雹",
  99: "雷暴伴冰雹",
};

/**
 * 和风天气预警的颜色码 → 中文。
 *
 * 官方返回的是 `color.code`（小写英文），而中国的预警信号习惯上就是按颜色
 * 叫的（「暴雨橙色预警」），所以拼成中文才是这边的人一眼能懂的说法。
 * 表里没有的颜色就只报类型名，不硬凑。
 */
const ALERT_COLOR = {
  white: "白色",
  blue: "蓝色",
  green: "绿色",
  yellow: "黄色",
  orange: "橙色",
  red: "红色",
  black: "黑色",
};

/**
 * 一条前缀里最多带几条预警。
 *
 * 台风天一个市同时挂五六条预警是常事（暴雨+大风+雷电+…），全列进去
 * 会让这段瞬间比对方说的话还长。按官方返回顺序取前两条。
 */
const MAX_ALERTS = 2;

/* ================= 缓存 ================= */

/**
 * 城市名 → {lat, lon, tz, country, name}。**永久缓存**：城市的坐标不会变。
 * 查不到的城市也记一条 null，免得每轮消息都去重试一个拼错的名字。
 */
const geoCache = new Map();
/**
 * 城市名 → 上次网络失败的时刻。见 GEO_FAIL_TTL —— 和 geoCache 分开两张表，
 * 是因为两件事的语义完全不同：那边是「查过了，结论是这个（可能是 null）」，
 * 这边是「没查成，暂时别再问了」。混在一张表里就分不出「城市不存在」和
 * 「网断了」，而前者该永久记住、后者十分钟后就该重试。
 */
const geoFailCache = new Map();
/**
 * 缓存键 → {at, data}。两小时过期（WEATHER_TTL）。
 *
 * 键里带**数据源和预警开关**（见 weatherAt）—— 只按坐标缓存的话，用户刚
 * 把预警打开，两小时内还是拿的没有预警的那份旧数据，看着像开关没生效。
 *
 * 过期之后**不立刻扔**：查不到新的时候还要拿它顶上（staleWeather），
 * 一直留到 WEATHER_STALE_MAX。启动时从盘上读回来，见 loadWeatherCache。
 */
const weatherCache = new Map(loadWeatherCache());
/**
 * 坐标 → 上次天气查失败的时刻。见 WEATHER_FAIL_TTL。
 *
 * 和 geoFailCache 同一个路子，也和 weatherCache 分开：那边是「查到了什么」，
 * 这边是「刚才没查成，十分钟内别再赔一次超时了」。按**坐标**而不是完整缓存键
 * 记 —— 代理坏掉的时候三个数据源一个都打不通，没必要一家一家再试一遍。
 */
const weatherFailCache = new Map();
/** date-holidays 的实例按国家码复用 —— 每次 new 都要载一遍该国规则。 */
const holidaysCache = new Map();

/**
 * 天气缓存落盘的节流（毫秒）。
 *
 * 查一次天气管两小时，本来就写不了几次；攒一下是为了「两个城市几乎同时查完」
 * 那种，别为了差几毫秒的两次更新写两遍盘。
 */
const WEATHER_SAVE_DELAY = 5000;
let weatherSaveTimer = null;

/** 启动时把盘上那份读回来。坏了、过期了的都丢掉，返回给 Map 构造函数的数组。 */
function loadWeatherCache() {
  const raw = readJson(WEATHER_CACHE_PATH, null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const now = Date.now();
  const out = [];
  for (const [key, v] of Object.entries(raw)) {
    const at = Number(v?.at);
    if (!Number.isFinite(at) || at > now || now - at >= WEATHER_STALE_MAX) continue;
    if (!v?.data || typeof v.data !== "object") continue;
    out.push([key, { at, data: v.data }]);
  }
  return out;
}

/**
 * 把内存里这份天气缓存写到盘上（节流）。
 *
 * 写盘的理由只有一个：查不到的时候拿上一次查到的顶上。纯内存的话，代理坏着的
 * 时候重启一次进程，连「上一次」都没有了 —— 而代理坏掉和重启进程恰恰经常
 * 同时发生（用户看见报错，第一反应就是重启）。
 *
 * 写不进去只 warn：这份缓存丢了最多让下一轮多打一次网络。
 */
function saveWeatherCacheSoon() {
  if (weatherSaveTimer) return;
  weatherSaveTimer = setTimeout(() => {
    weatherSaveTimer = null;
    const now = Date.now();
    const out = {};
    for (const [key, v] of weatherCache) {
      if (now - v.at < WEATHER_STALE_MAX) out[key] = v;
    }
    try {
      writeJson(WEATHER_CACHE_PATH, out);
    } catch (e) {
      logWarn("环境", "天气缓存写不进硬盘（不影响这一轮，只是重启后要重查）", e);
    }
  }, WEATHER_SAVE_DELAY);
  // 不能让这个定时器把进程钉住：它只是个锦上添花的写盘
  weatherSaveTimer.unref?.();
}

/** 「23 分钟」「3.5 小时」。只给日志看。 */
function ageText(at) {
  const mins = Math.max(0, Math.round((Date.now() - at) / 60_000));
  return mins < 60 ? `${mins} 分钟` : `${(mins / 60).toFixed(1)} 小时`;
}

/**
 * 这个坐标上还能用的**最新一份**旧数据。没有就是 null。
 *
 * 不挑数据源：和风查不通的时候，上一次退回 Open-Meteo 存下的那份照样能用 ——
 * 少一条灾害预警，总比这一轮压根没有天气强。超过 WEATHER_STALE_MAX 的不要，
 * 拿昨天的天气冒充今天还不如没有。
 */
function staleWeather(at) {
  const suffix = `:${at}`;
  let best = null;
  for (const [key, v] of weatherCache) {
    if (!key.endsWith(suffix)) continue;
    if (Date.now() - v.at >= WEATHER_STALE_MAX) continue;
    if (!best || v.at > best.at) best = v;
  }
  return best;
}

/**
 * 把这几张表全清掉。控制台的「清理缓存」按钮用。
 *
 * 用处是「查出来的东西不对，想让它重查一次」：城市解析成了别的地方、
 * 天气停在两小时前那份、换了 key 之后还在用旧结果。清掉之后下一轮消息
 * 会重新查一遍，只是慢那么一两秒 —— 这几张表里没有任何**数据**，
 * 全都是能重新查出来的东西，所以清它是安全的。
 *
 * @returns {{geo:number, geoFail:number, weather:number, weatherFail:number, holidays:number}} 各清了几条
 */
export function clearEnvCache() {
  const counts = {
    geo: geoCache.size,
    geoFail: geoFailCache.size,
    weather: weatherCache.size,
    weatherFail: weatherFailCache.size,
    holidays: holidaysCache.size,
  };
  geoCache.clear();
  geoFailCache.clear();
  weatherCache.clear();
  weatherFailCache.clear();
  holidaysCache.clear();

  // 盘上那份也一起清 —— 只清内存的话重启一次刚清掉的天气又回来了，
  // 而「清理缓存」这个按钮要的就是「忘掉查过的东西，重查一遍」
  if (weatherSaveTimer) {
    clearTimeout(weatherSaveTimer);
    weatherSaveTimer = null;
  }
  try {
    writeJson(WEATHER_CACHE_PATH, {});
  } catch (e) {
    logWarn("环境", "天气缓存文件清不掉（内存里那份已经清了）", e);
  }
  return counts;
}

/* ================= 时间 ================= */

/** 这个时区此刻的缩写，例如 CST / PDT。 */
function tzAbbr(tz, at) {
  if (TZ_ABBR[tz]) return TZ_ABBR[tz];
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "short",
    }).formatToParts(at);
    return normalizeAbbr(parts.find((p) => p.type === "timeZoneName")?.value ?? "");
  } catch {
    return "";
  }
}

/**
 * 某时区的 YYYY-MM-DD HH:mm:ss。
 *
 * 全程走 formatToParts，不做字符串解析也不手算偏移 —— DST 和跨日
 * 交给 ICU。hour12: false 在午夜会给 "24"，这里补正成 "00"。
 */
function tzParts(tz, at) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const hour = p.hour === "24" ? "00" : p.hour;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${hour}:${p.minute}:${p.second}`,
    year: Number(p.year),
  };
}

/** 「周二」。Intl 的 zh-CN 给「星期二」，用户要的是短的。 */
function tzWeekday(tz, at) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: tz,
    weekday: "long",
  }).formatToParts(at);
  const value = parts.find((p) => p.type === "weekday")?.value ?? "";
  return value.replace("星期", "周");
}

/** 星期几（0 = 周日），用来判周末。 */
function tzDayOfWeek(tz, at) {
  const short = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
  }).formatToParts(at).find((p) => p.type === "weekday")?.value;
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(short);
}

/** 时区字符串能不能用 —— 拼错的名字会让 formatToParts 抛异常。 */
function validTz(tz) {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/* ================= 节假日 ================= */

/**
 * 中国：法定假期名 / 调休补班 / 休息日 / 工作日 四态。
 *
 * chinese-days 的 getDayDetail 返回 {work, name}，name 是
 * `"Spring Festival,春节,4"` 这种三段式（法定假日相关的日子）或者
 * 光秃秃的 `"Tuesday"`（普通日子）。所以「有中文名」才说明是节日相关，
 * 再看 work 区分「放假」还是「调休补班」。
 */
function cnDayTag(date, dow) {
  const detail = CD?.getDayDetail?.(date);
  const name = String(detail?.name ?? "");
  const cn = name.includes(",") ? name.split(",")[1] : "";

  if (cn) return detail.work ? `${cn}调休补班` : cn;
  // 节日无关的日子：getDayDetail 的 work 已经算过周末了
  if (detail && typeof detail.work === "boolean") {
    return detail.work ? "工作日" : "休息日";
  }
  return dow === 0 || dow === 6 ? "休息日" : "工作日";
}

/** 其他国家：date-holidays 命中就报节日名，否则按周末/工作日。 */
function intlDayTag(country, at, dow) {
  try {
    let hd = holidaysCache.get(country);
    if (hd === undefined) {
      hd = new Holidays(country);
      holidaysCache.set(country, hd);
    }
    const hit = hd?.isHoliday?.(at);
    // 只认法定假日：observance / optional 那些不影响上不上班
    const pub = Array.isArray(hit) ? hit.find((h) => h.type === "public") : null;
    if (pub?.name) return String(pub.name);
  } catch (e) {
    logDebug("环境", `${country} 的节日判断失败，按周末规则处理`, e);
  }
  return dow === 0 || dow === 6 ? "休息日" : "工作日";
}

/**
 * 这一天对这个国家是什么日子。
 *
 * 按**各自所在国**判 —— 中国的节假日表不能套到旧金山头上。
 * 国家码超出数据覆盖范围时只报工作日/休息日，不编节日名。
 */
function dayTag(country, date, year, at, dow) {
  const weekendOnly = dow === 0 || dow === 6 ? "休息日" : "工作日";
  if (!country) return weekendOnly;

  if (country === "CN") {
    if (year < HOLIDAY_DATA_FROM || year > HOLIDAY_DATA_UNTIL) return weekendOnly;
    return cnDayTag(date, dow);
  }
  return intlDayTag(country, at, dow);
}

/* ================= 天气 ================= */

/**
 * 天气和地名查询的唯一出网口。
 *
 * 三家天气源（open-meteo / 和风 / WeatherAPI）和 geocoding 都走这儿，所以代理
 * 只要在这一处挂：`weather` 那一类**出厂就是勾上的**（用户实测这几个域名
 * 直连不通）。想改去控制台的「代理」那节。
 *
 * 出错时用 `whyNetwork` 翻译一遍再抛 —— 这个错误串会进日志，而
 * 「请求超时」和「代理拒绝连接」要改的地方完全不同。
 */
async function fetchJson(url, timeout, headers) {
  /*
   * 代理自己坏掉时脱开代理直连再试一次 —— 那一整套现在在 `fetchVia` 里，
   * 所有类别共用（原来只有天气这一处有，是这个项目里第一个撞上它的场景：
   * 用户报的 `连接被重置 —— 代理 http://127.0.0.1:7892 不稳定？`）。
   *
   * `init` 必须是函数：里面的 `AbortSignal.timeout()` 第一发用掉之后已经在
   * 计时，重试那发要拿个新的。
   */
  const init = () => ({
    signal: AbortSignal.timeout(timeout),
    ...(headers ? { headers } : {}),
  });

  let res;
  try {
    res = await fetchVia("weather", url, init, (why) => logDebug("环境", `查天气${why}`));
  } catch (e) {
    throw new Error(whyNetwork(e, "weather", timeout));
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * 内置坐标表：常见城市不打网络也能解析。
 *
 * 加这张表的直接原因是「解析城市「南宁」失败 TimeoutError」——
 * geocoding-api.open-meteo.com 在国内并不总是通的，而它一超时会连累三件事：
 * 没有天气、时区退回服务器本地（两地时间全错）、**国家码拿不到**。
 * 最后那条最要命：`pickSource` 是靠 `country === "CN"` 才走和风天气的，
 * 于是一个配好了和风密钥的国内用户，会因为一个国外的地理编码接口连不上，
 * 而彻底用不上那个本来连得通的国内数据源。
 *
 * 收的是**不会有歧义的那些**：中国的直辖市 / 省会 / 主要城市，加上常被填的
 * 国外大城市。表里没有的照旧走网络 —— 这张表是快路径，不是白名单。
 *
 * 格式：[名字, 纬度, 经度, 时区, 国家码, ...别名]
 */
const CN_TZ = "Asia/Shanghai";
const BUILTIN_CITIES = [
  ["北京", 39.9042, 116.4074, CN_TZ, "CN", "beijing", "peking"],
  ["上海", 31.2304, 121.4737, CN_TZ, "CN", "shanghai"],
  ["天津", 39.3434, 117.3616, CN_TZ, "CN", "tianjin"],
  ["重庆", 29.563, 106.5516, CN_TZ, "CN", "chongqing"],
  ["广州", 23.1291, 113.2644, CN_TZ, "CN", "guangzhou", "canton"],
  ["深圳", 22.5431, 114.0579, CN_TZ, "CN", "shenzhen"],
  ["南宁", 22.817, 108.3665, CN_TZ, "CN", "nanning"],
  ["桂林", 25.2736, 110.29, CN_TZ, "CN", "guilin"],
  ["柳州", 24.3255, 109.4155, CN_TZ, "CN", "liuzhou"],
  ["成都", 30.5728, 104.0668, CN_TZ, "CN", "chengdu"],
  ["杭州", 30.2741, 120.1551, CN_TZ, "CN", "hangzhou"],
  ["武汉", 30.5928, 114.3055, CN_TZ, "CN", "wuhan"],
  ["西安", 34.3416, 108.9398, CN_TZ, "CN", "xian", "xi'an"],
  ["南京", 32.0603, 118.7969, CN_TZ, "CN", "nanjing"],
  ["长沙", 28.2282, 112.9388, CN_TZ, "CN", "changsha"],
  ["郑州", 34.7466, 113.6254, CN_TZ, "CN", "zhengzhou"],
  ["济南", 36.6512, 117.1201, CN_TZ, "CN", "jinan"],
  ["青岛", 36.0671, 120.3826, CN_TZ, "CN", "qingdao"],
  ["沈阳", 41.8057, 123.4315, CN_TZ, "CN", "shenyang"],
  ["大连", 38.914, 121.6147, CN_TZ, "CN", "dalian"],
  ["哈尔滨", 45.8038, 126.5349, CN_TZ, "CN", "harbin"],
  ["长春", 43.8171, 125.3235, CN_TZ, "CN", "changchun"],
  ["石家庄", 38.0428, 114.5149, CN_TZ, "CN", "shijiazhuang"],
  ["太原", 37.8706, 112.5489, CN_TZ, "CN", "taiyuan"],
  ["呼和浩特", 40.8414, 111.7519, CN_TZ, "CN", "hohhot"],
  ["合肥", 31.8206, 117.2272, CN_TZ, "CN", "hefei"],
  ["福州", 26.0745, 119.2965, CN_TZ, "CN", "fuzhou"],
  ["厦门", 24.4798, 118.0894, CN_TZ, "CN", "xiamen"],
  ["南昌", 28.682, 115.8579, CN_TZ, "CN", "nanchang"],
  ["昆明", 25.0389, 102.7183, CN_TZ, "CN", "kunming"],
  ["贵阳", 26.647, 106.6302, CN_TZ, "CN", "guiyang"],
  ["兰州", 36.0611, 103.8343, CN_TZ, "CN", "lanzhou"],
  ["西宁", 36.6171, 101.7782, CN_TZ, "CN", "xining"],
  ["银川", 38.4872, 106.2309, CN_TZ, "CN", "yinchuan"],
  ["乌鲁木齐", 43.8256, 87.6168, "Asia/Urumqi", "CN", "urumqi"],
  ["拉萨", 29.652, 91.1721, CN_TZ, "CN", "lhasa"],
  ["海口", 20.0444, 110.1999, CN_TZ, "CN", "haikou"],
  ["三亚", 18.2528, 109.5119, CN_TZ, "CN", "sanya"],
  ["苏州", 31.2989, 120.5853, CN_TZ, "CN", "suzhou"],
  ["无锡", 31.4912, 120.3119, CN_TZ, "CN", "wuxi"],
  ["宁波", 29.8683, 121.544, CN_TZ, "CN", "ningbo"],
  ["温州", 27.9938, 120.6994, CN_TZ, "CN", "wenzhou"],
  ["东莞", 23.0207, 113.7518, CN_TZ, "CN", "dongguan"],
  ["佛山", 23.0219, 113.1214, CN_TZ, "CN", "foshan"],
  ["珠海", 22.2707, 113.5767, CN_TZ, "CN", "zhuhai"],
  ["香港", 22.3193, 114.1694, "Asia/Hong_Kong", "HK", "hong kong", "hongkong"],
  ["澳门", 22.1987, 113.5439, "Asia/Macau", "MO", "macau", "macao"],
  ["台北", 25.033, 121.5654, "Asia/Taipei", "TW", "taipei"],
  ["东京", 35.6762, 139.6503, "Asia/Tokyo", "JP", "tokyo"],
  ["大阪", 34.6937, 135.5023, "Asia/Tokyo", "JP", "osaka"],
  ["首尔", 37.5665, 126.978, "Asia/Seoul", "KR", "seoul"],
  ["新加坡", 1.3521, 103.8198, "Asia/Singapore", "SG", "singapore"],
  ["曼谷", 13.7563, 100.5018, "Asia/Bangkok", "TH", "bangkok"],
  ["迪拜", 25.2048, 55.2708, "Asia/Dubai", "AE", "dubai"],
  ["纽约", 40.7128, -74.006, "America/New_York", "US", "new york", "nyc"],
  ["洛杉矶", 34.0522, -118.2437, "America/Los_Angeles", "US", "los angeles", "la"],
  ["旧金山", 37.7749, -122.4194, "America/Los_Angeles", "US", "san francisco", "sf"],
  ["西雅图", 47.6062, -122.3321, "America/Los_Angeles", "US", "seattle"],
  ["芝加哥", 41.8781, -87.6298, "America/Chicago", "US", "chicago"],
  ["温哥华", 49.2827, -123.1207, "America/Vancouver", "CA", "vancouver"],
  ["多伦多", 43.6532, -79.3832, "America/Toronto", "CA", "toronto"],
  ["伦敦", 51.5074, -0.1278, "Europe/London", "GB", "london"],
  ["巴黎", 48.8566, 2.3522, "Europe/Paris", "FR", "paris"],
  ["柏林", 52.52, 13.405, "Europe/Berlin", "DE", "berlin"],
  ["莫斯科", 55.7558, 37.6173, "Europe/Moscow", "RU", "moscow"],
  ["悉尼", -33.8688, 151.2093, "Australia/Sydney", "AU", "sydney"],
  ["墨尔本", -37.8136, 144.9631, "Australia/Melbourne", "AU", "melbourne"],
];

/** 上面那张表摊平成「小写名字 → geo」，别名指向同一个对象。 */
const BUILTIN_GEO = new Map();
for (const [name, lat, lon, tz, country, ...aliases] of BUILTIN_CITIES) {
  const geo = { lat, lon, tz, country, name };
  for (const alias of [name, ...aliases]) BUILTIN_GEO.set(alias.toLowerCase(), geo);
}

/**
 * 城市名 → 坐标 / 时区 / 国家码。
 *
 * 用户只填城市名，时区和国家都从这里自动带出 —— 少两个要填的字段，
 * 也不会出现「城市在上海、时区填了纽约」这种自相矛盾的配置。
 *
 * 四层，依次兜底：
 *  1. `geoCache`：查过了就直接用（含「这个城市不存在」的那条 null）。
 *  2. `BUILTIN_GEO`：常见城市直接给坐标，一次网络都不打。
 *  3. `geoFailCache`：刚刚才网络失败过，10 分钟内不再赔一次超时（见 GEO_FAIL_TTL）。
 *  4. 真去打 geocoding-api.open-meteo.com。
 *
 * @returns {Promise<object|null>} 查不到返回 null（并缓存这个 null）
 */
async function geocode(city) {
  const key = city.trim().toLowerCase();
  if (!key) return null;
  if (geoCache.has(key)) return geoCache.get(key);

  const builtin = BUILTIN_GEO.get(key);
  if (builtin) {
    geoCache.set(key, builtin);
    logDebug("环境", `城市「${city}」用内置坐标（不打地理编码接口）`);
    return builtin;
  }

  // 刚失败过就直接放弃这一轮：再试一次只是白等 GEO_TIMEOUT 那 8 秒，
  // 而对方正在等回复。日志压到 debug —— 真正的原因上一次已经 warn 过了
  const failedAt = geoFailCache.get(key);
  if (failedAt && Date.now() - failedAt < GEO_FAIL_TTL) {
    logDebug("环境", `城市「${city}」刚解析失败过，这一轮先不重试（免得每条消息都多等几秒）`);
    return null;
  }

  let out = null;
  try {
    const url =
      "https://geocoding-api.open-meteo.com/v1/search" +
      `?name=${encodeURIComponent(city.trim())}&count=1&language=zh&format=json`;
    const data = await fetchJson(url, GEO_TIMEOUT);
    const hit = data?.results?.[0];
    if (hit?.latitude != null && hit?.longitude != null) {
      out = {
        lat: hit.latitude,
        lon: hit.longitude,
        tz: validTz(hit.timezone) ? hit.timezone : "",
        country: String(hit.country_code ?? "").toUpperCase(),
        name: String(hit.name ?? city.trim()),
      };
    } else {
      logWarn("环境", `没找到城市「${city}」，这一边不带天气和国家节日`);
    }
  } catch (e) {
    /*
     * 网络失败：结论不缓存（城市多半是对的，是网出了问题），但**失败这件事
     * 缓存 10 分钟** —— 不记的话这个域名一被墙，每一轮消息都要先赔 8 秒。
     */
    geoFailCache.set(key, Date.now());
    logWarn(
      "环境",
      `解析城市「${city}」失败，${Math.round(GEO_FAIL_TTL / 60000)} 分钟内不再重试` +
        "（这一边没有天气，时间按服务器本地时区算）",
      e
    );
    return null;
  }

  // 查成了就把失败记录抹掉，免得下一次改城市名时还压着一条过期的退避
  geoFailCache.delete(key);
  geoCache.set(key, out);
  return out;
}

/**
 * 三个 fetcher 统一返回这个中间结构，格式化的事交给 weatherSegment ——
 * 换数据源不该牵动前缀的形状，反过来也一样。
 *
 * @typedef {{
 *   text: string, temp: number|null, max: number|null, min: number|null,
 *   tmr: {text: string, max: number|null, min: number|null}|null,
 *   alerts: string[],
 * }} WeatherData
 */

/** 数字化一下：拿不到就 null，不让 NaN 混进格式化环节。 */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Open-Meteo：默认源，免费、不需要密钥、没有灾害预警。
 *
 * daily 的 [0] 是今天、[1] 是明天（forecast_days=2 + timezone=auto，
 * 所以「今天」是按当地时区算的，不会在跨日的时候错位）。
 */
async function fetchOpenMeteo(geo) {
  const url =
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${geo.lat}&longitude=${geo.lon}` +
    "&current=temperature_2m,weather_code" +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min" +
    "&forecast_days=2&timezone=auto";
  const d = await fetchJson(url, WEATHER_TIMEOUT);

  const temp = num(d?.current?.temperature_2m);
  if (temp == null) throw new Error("响应里没有当前温度");

  const daily = d?.daily ?? {};
  const tmrMax = num(daily.temperature_2m_max?.[1]);
  const tmrMin = num(daily.temperature_2m_min?.[1]);

  return {
    text: WMO[d?.current?.weather_code] ?? "未知",
    temp,
    max: num(daily.temperature_2m_max?.[0]),
    min: num(daily.temperature_2m_min?.[0]),
    tmr:
      tmrMax == null && tmrMin == null
        ? null
        : { text: WMO[daily.weather_code?.[1]] ?? "未知", max: tmrMax, min: tmrMin },
    alerts: [],
  };
}

/**
 * 和风天气的专属 API Host 归一化成裸主机名。
 *
 * 用户是从控制台复制过来的，很可能带着 `https://` 或末尾斜杠。与其在界面上
 * 写一句「不要带协议头」，不如这里收拾干净 —— 少一个能填错的地方。
 */
function qwHost(host) {
  return String(host ?? "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
}

/**
 * 填的这个 API Host 一看就不是域名吗？
 *
 * 和风的 Host 形如 `h2a9cf3mhs.xy.qweatherapi.com` —— 一定带点。实际踩到的
 * 坑是用户把**项目 ID 或 Key** 填进了 Host 那格：那种值没有点，请求直接
 * ENOTFOUND，然后静默退回 Open-Meteo，界面上什么都不说，表现就是
 * 「我明明配好了和风，还是看不到天气」。
 *
 * 只做最保守的判断（非空 + 不含点），不去猜更复杂的规则 —— 宁可漏报也不
 * 误报。填空不算错（那是「还没配」，另有提示）。
 */
function badQwHost(host) {
  const h = qwHost(host);
  return Boolean(h) && !h.includes(".");
}

/**
 * 和风天气 v1。
 *
 * 为什么是 v1 而不是那个到处都能搜到的 v7：`/v7/warning/now` 官方公告
 * **2026-10-01 停服**，现在接 v7 等于上线三周就坏。v1 的坐标写在路径里
 * （纬度在前）、鉴权走 X-QW-Api-Key 请求头、host 是账号专属的。
 *
 * ⚠ v1 的响应字段名文档里没能确认到字面量（只知道从 v7 的 `now.temp`
 * 字符串改成了 `temperature` 这类嵌套对象），所以每个值都试几个候选路径，
 * 全都拿不到就当这次查询失败 —— 上层会退回 Open-Meteo。真实响应确认过
 * 之后可以把候选收窄，但留着也不亏：多一层容错，官方微调字段时不会炸。
 */
async function fetchQWeather(geo, { host, key, alerts }) {
  const base = `https://${qwHost(host)}`;
  const at = `${geo.lat.toFixed(2)}/${geo.lon.toFixed(2)}`;
  const headers = { "X-QW-Api-Key": String(key).trim() };
  // 官方要求客户端能解 gzip。undici 默认就会带 accept-encoding 并自动解压，
  // 这里不用手动设 —— 显式写反而要自己处理解压
  const get = (path) => fetchJson(`${base}${path}`, WEATHER_TIMEOUT, headers);

  /** 嵌套结构里挑第一个拿得到的数 —— 见上面那条 ⚠。 */
  const pick = (obj, ...paths) => {
    for (const p of paths) {
      const v = p.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
      const n = num(typeof v === "object" && v !== null ? v.value : v);
      if (n != null) return n;
    }
    return null;
  };
  const pickText = (obj, ...paths) => {
    for (const p of paths) {
      const v = p.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
      const s = typeof v === "object" && v !== null ? v.text ?? v.name : v;
      if (typeof s === "string" && s.trim()) return s.trim();
    }
    return "";
  };

  const [cur, daily, alertRes] = await Promise.all([
    get(`/weather/v1/current/${at}`),
    get(`/weather/v1/daily/${at}?days=2`),
    alerts ? get(`/weatheralert/v1/current/${at}`).catch(() => null) : null,
  ]);

  const temp = pick(cur, "temperature", "now.temp", "current.temperature");
  if (temp == null) throw new Error("响应里没有当前温度");

  const days = daily?.days ?? daily?.daily ?? [];
  const dayAt = (i) => (Array.isArray(days) ? days[i] : null) ?? {};
  const maxOf = (d) => pick(d, "temperatureMax", "tempMax", "temperature.max");
  const minOf = (d) => pick(d, "temperatureMin", "tempMin", "temperature.min");
  const textOf = (d) =>
    pickText(d, "daytimeForecast.condition", "condition", "textDay", "daytime.condition");

  const tmr = dayAt(1);
  const tmrMax = maxOf(tmr);
  const tmrMin = minOf(tmr);

  /*
   * 预警：只报类型 + 等级（「暴雨橙色预警」），不带发布单位也不带正文。
   * 正文常有两三百字，而这段每轮都注入 —— 模型需要知道的是「外面在下大雨，
   * 别让角色说出去散步」，不是防御指引。
   */
  const list = alertRes?.alerts ?? alertRes?.warning ?? [];
  const warned = (Array.isArray(list) ? list : [])
    .map((a) => {
      const type = pickText(a, "eventType", "typeName", "eventType.name");
      if (!type) return "";
      const color = ALERT_COLOR[String(a?.color?.code ?? a?.severityColor ?? "").toLowerCase()];
      return color ? `${type}${color}预警` : `${type}预警`;
    })
    .filter(Boolean);

  return {
    text: pickText(cur, "condition", "now.text", "current.condition") || "未知",
    temp,
    max: maxOf(dayAt(0)),
    min: minOf(dayAt(0)),
    tmr:
      tmrMax == null && tmrMin == null
        ? null
        : { text: textOf(tmr) || "未知", max: tmrMax, min: tmrMin },
    alerts: [...new Set(warned)].slice(0, MAX_ALERTS),
  };
}

/**
 * WeatherAPI.com。地址是固定的，用户只要填一把 key。
 *
 * 一个请求就同时拿到实况、两天的 max/min 和预警数组，所以国外这边比和风
 * 省两次请求。免费版每月 10 万次，但**预警是 "Limited"** —— 开着也可能
 * 查回来是空的，那不是 bug。
 */
async function fetchWeatherApi(geo, { key, alerts }) {
  const url =
    "https://api.weatherapi.com/v1/forecast.json" +
    `?key=${encodeURIComponent(String(key).trim())}` +
    `&q=${geo.lat.toFixed(2)},${geo.lon.toFixed(2)}` +
    `&days=2&aqi=no&lang=zh&alerts=${alerts ? "yes" : "no"}`;
  const d = await fetchJson(url, WEATHER_TIMEOUT);

  const temp = num(d?.current?.temp_c);
  if (temp == null) throw new Error("响应里没有当前温度");

  const days = d?.forecast?.forecastday ?? [];
  const dayOf = (i) => days[i]?.day ?? {};
  const tmr = dayOf(1);
  const tmrMax = num(tmr.maxtemp_c);
  const tmrMin = num(tmr.mintemp_c);

  // event 本身就含类型和等级（"Flood Warning"），不用再拼颜色
  const warned = (d?.alerts?.alert ?? [])
    .map((a) => String(a?.event ?? "").trim())
    .filter(Boolean);

  return {
    text: String(d?.current?.condition?.text ?? "").trim() || "未知",
    temp,
    max: num(dayOf(0).maxtemp_c),
    min: num(dayOf(0).mintemp_c),
    tmr:
      tmrMax == null && tmrMin == null
        ? null
        : {
            text: String(tmr.condition?.text ?? "").trim() || "未知",
            max: tmrMax,
            min: tmrMin,
          },
    alerts: [...new Set(warned)].slice(0, MAX_ALERTS),
  };
}

/**
 * 这一边用哪个数据源。
 *
 * 按**城市所在国**分派 —— 国家码是 geocode 顺手带回来的，用户不用再选一次
 * 「这个城市算国内还是国外」。没开 API、开关关着、密钥没填齐，一律
 * Open-Meteo：这三种情况都不是错误，用户可能就是不想配密钥。
 *
 * @returns {{source: "openmeteo"|"qweather"|"weatherapi", alerts: boolean, opts: object}}
 */
function pickSource(geo, weather, keys) {
  const plain = { source: "openmeteo", alerts: false, opts: {} };
  const api = weather?.api;
  if (!api?.enabled) return plain;

  if (geo.country === "CN") {
    if (!api.qweather?.enabled) return plain;
    const host = qwHost(keys?.qweather?.host);
    const key = String(keys?.qweather?.key ?? "").trim();
    if (!host || !key) {
      logWarn(
        "环境",
        `和风天气开着但${!host ? "没填 API Host" : "没填密钥"}，${geo.name} 这边退回 Open-Meteo（没有灾害预警）`
      );
      return plain;
    }
    // 形状就不对的话连请求都不用发：域名解析必然失败，白等一次超时。
    // 说清楚该填什么 —— 这一格最常见的错就是把 Key 或项目 ID 填进来
    if (badQwHost(host)) {
      logWarn(
        "环境",
        `和风天气的 API Host 不像域名（应该形如 xxx.qweatherapi.com，在 console.qweather.com/setting 复制），` +
          `${geo.name} 这边退回 Open-Meteo（没有灾害预警）`
      );
      return plain;
    }
    return {
      source: "qweather",
      alerts: Boolean(api.qweather.alerts),
      opts: { host, key, alerts: Boolean(api.qweather.alerts) },
    };
  }

  if (!api.weatherapi?.enabled) return plain;
  const key = String(keys?.weatherapi?.key ?? "").trim();
  if (!key) {
    logWarn("环境", `WeatherAPI 开着但没填密钥，${geo.name} 这边退回 Open-Meteo`);
    return plain;
  }
  return {
    source: "weatherapi",
    alerts: Boolean(api.weatherapi.alerts),
    opts: { key, alerts: Boolean(api.weatherapi.alerts) },
  };
}

/**
 * 当前天气 + 明日预报 + 灾害预警。彻底没辙时才返回 null。
 *
 * 三层退路，一层比一层旧：
 *
 *  1. 选定的源。失败就**再试一次 Open-Meteo** —— 密钥过期、额度用光、官方改了
 *     字段名，这些都不该让这一轮彻底没有天气。
 *  2. 两边都不通时，拿**上次查到的**顶上（staleWeather，最多 24 小时前）。
 *     用户的原话：「报错了不要不带天气啊，带上次查到的天气不就可以了吗」。
 *     确实 —— 天气本来就两小时才刷一次，网断的那阵子用一小时前那份，
 *     比让角色突然不知道外面什么天气强得多。
 *  3. 连旧的都没有，才是 null。
 *
 * 退回来的旧数据在提示词里**不做任何标注**：那一行会被用户的正则状态栏原样
 * 渲出来，多一句「（旧）」就是脸上多一块补丁。只在控制台说清用的是多久前那份。
 *
 * @returns {Promise<WeatherData|null>}
 */
async function weatherAt(geo, weather, keys) {
  const { source, alerts, opts } = pickSource(geo, weather, keys);
  const at = `${geo.lat.toFixed(3)},${geo.lon.toFixed(3)}`;
  const key = `${source}:${alerts ? 1 : 0}:${at}`;
  const hit = weatherCache.get(key);
  if (hit && Date.now() - hit.at < WEATHER_TTL) return hit.data;

  /*
   * 刚失败过：这十分钟里连试都不试，直接吃旧的。
   *
   * 代理坏掉的时候每一轮都去打一遍，等于每条消息都赔一次 5 秒超时（两个城市
   * 是 Promise.all，所以是并排赔），而买回来的还是同一份旧数据。
   */
  const failedAt = weatherFailCache.get(at);
  if (failedAt && Date.now() - failedAt < WEATHER_FAIL_TTL) {
    const stale = staleWeather(at);
    if (stale) {
      logDebug(
        "环境",
        `${geo.name} 的天气刚查失败过，${Math.round(WEATHER_FAIL_TTL / 60000)} 分钟内先用 ${ageText(stale.at)}前那份`
      );
      return stale.data;
    }
    return null;
  }

  const run = () => {
    if (source === "qweather") return fetchQWeather(geo, opts);
    if (source === "weatherapi") return fetchWeatherApi(geo, opts);
    return fetchOpenMeteo(geo);
  };

  /** 查到了：记下来、解掉失败冷却、顺手排一次写盘。 */
  const keep = (cacheKey, data) => {
    weatherCache.set(cacheKey, { at: Date.now(), data });
    weatherFailCache.delete(at);
    saveWeatherCacheSoon();
    return data;
  };

  /** 全都不通：进冷却，能退回旧数据就退，退不了才是 null。 */
  const giveUp = (e, what) => {
    weatherFailCache.set(at, Date.now());
    const stale = staleWeather(at);
    if (stale) {
      logWarn("环境", `${what}，用的是 ${ageText(stale.at)}前查到的那份`, e);
      return stale.data;
    }
    logWarn("环境", `${what}，这一轮不带天气`, e);
    return null;
  };

  let data = null;
  try {
    data = await run();
  } catch (e) {
    if (source === "openmeteo") return giveUp(e, `查 ${geo.name} 的天气失败`);
    logWarn("环境", `${source} 查 ${geo.name} 失败，退回 Open-Meteo`, e);
    try {
      data = await fetchOpenMeteo(geo);
    } catch (e2) {
      return giveUp(e2, `Open-Meteo 也没查到 ${geo.name}`);
    }
    // 存在退回后的键上：下一轮别再白等一次超时的官方 API
    return keep(`openmeteo:0:${at}`, data);
  }

  return keep(key, data);
}

/* ================= 对外 ================= */

/** 角色配置里那两个城市，解析成坐标 + 时区 + 国家。 */
async function resolveSides(env) {
  const userCity = String(env?.time?.userCity ?? "").trim();
  const charCity = String(env?.time?.charCity ?? "").trim();
  const [user, char] = await Promise.all([geocode(userCity), geocode(charCity)]);
  return { user, char };
}

/** 一边的时间段：`{{user}}发送当地时间 CST : … | 周二, 工作日` */
function timeSegment(label, who, geo, at, workday) {
  const tz = geo?.tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { date, time, year } = tzParts(tz, at);
  const dow = tzDayOfWeek(tz, at);
  const tag = workday ? dayTag(geo?.country ?? "", date, year, at, dow) : "";
  const head = `${who}${label} ${tzAbbr(tz, at)} : ${date} ${time}`;
  return tag ? `${head} | ${tzWeekday(tz, at)}, ${tag}` : `${head} | ${tzWeekday(tz, at)}`;
}

/**
 * 同城模式的时间段：`时间 : 2026-09-08 03:38:29 | 周二, 工作日`
 *
 * 两个人在同一个地方，就没有「发送时间 / 收到时间」这个区别 —— 报两遍
 * 同一个时刻是纯粹的噪音，还要多花约一半的 token。所以只报一次，也不带
 * 时区缩写：同城的前提下「这是谁的当地时间」不再有歧义。
 *
 * 城市取「所在城市」那一个（异地模式下的 userCity），charCity 在这个模式
 * 下不参与计算。
 */
function timeSegmentSame(geo, at, workday) {
  const tz = geo?.tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { date, time, year } = tzParts(tz, at);
  const dow = tzDayOfWeek(tz, at);
  const tag = workday ? dayTag(geo?.country ?? "", date, year, at, dow) : "";
  const head = `时间 : ${date} ${time}`;
  return tag ? `${head} | ${tzWeekday(tz, at)}, ${tag}` : `${head} | ${tzWeekday(tz, at)}`;
}

/** 一位小数的温度，拿不到就空串。 */
function deg(v) {
  return v == null ? "" : `${Number(v).toFixed(1)}°C`;
}

/**
 * 一边的天气段。
 *
 * 全开时：`{{user}}当地天气: 南宁 晴 25.9°C (24.1~32.4°C) | 明日预报: 雷阵雨 25.8~32.0°C | ⚠ 暴雨橙色预警`
 *
 * 三个开关各砍掉一段。`range` 关掉时明日只留最高温 —— 那正好是加这些
 * 开关之前的行为，所以老用户升级后看到的形状不变。
 */
function weatherSegment(who, geo, w, weather) {
  if (!geo || !w) return "";
  const range = Boolean(weather?.range);

  // who 为空 = 同城模式，两个人在一个地方，没必要说是谁那边的天气
  let head = `${who ? `${who}当地天气` : "天气"}: ${geo.name} ${w.text} ${deg(w.temp)}`;
  if (range && w.min != null && w.max != null) {
    head += ` (${Number(w.min).toFixed(1)}~${Number(w.max).toFixed(1)}°C)`;
  }

  const out = [head];

  if (weather?.tomorrow !== false && w.tmr) {
    const t = w.tmr;
    const temp =
      range && t.min != null && t.max != null
        ? `${Number(t.min).toFixed(1)}~${Number(t.max).toFixed(1)}°C`
        : deg(t.max ?? t.min);
    if (temp) out.push(`明日预报: ${t.text} ${temp}`);
  }

  if (w.alerts?.length) out.push(`⚠ ${w.alerts.join("、")}`);

  return out.join(" | ");
}

/**
 * 拼这一轮的环境信息，时间和天气**分开返回**。
 *
 * 分开是这个模块存在的核心理由（见文件头）：时间进存档、天气不进。
 * 调用方负责把 time 拼在用户原话前面存下来，把 weather 只并进发给模型的
 * 那一份（prompt.js 的 injectWeather）。
 *
 * 时间部分是纯本地计算，只要 time.enabled 开着就一定有。天气要联网，
 * 拿不到就是空串 —— 这一轮没天气而已，不阻塞、不抛异常。
 *
 * 返回的字符串里 {{user}} / {{char}} 是字面量，替换在 prompt.js 里做。
 *
 * @param {object} role 角色（读 role.env）
 * @param {object} [keys] 全局天气密钥（config.weatherApi），不传等于没配
 * @param {Date} [now] 注入时刻，测试用
 * @returns {Promise<{time: string, weather: string}>} time 带方括号，weather 不带
 */
export async function buildEnv(role, keys, now = new Date()) {
  const env = role?.env;
  if (!env?.time?.enabled) return { time: "", weather: "" };

  try {
    const same = env.time.mode === "same";
    const sides = await resolveSides(env);
    const workday = env.time.workday !== false;

    // 同城模式只认一个地方（userCity 那个输入框），两边共用它
    const time = same
      ? `[${timeSegmentSame(sides.user, now, workday)}]`
      : "[" +
        [
          timeSegment("发送当地时间", "{{user}}", sides.user, now, workday),
          timeSegment("收到当地时间", "{{char}}", sides.char, now, workday),
        ].join(" | ") +
        "]";

    const weather = env.weather?.enabled
      ? await buildWeather(sides, env.weather, keys, same)
      : "";
    return { time, weather };
  } catch (e) {
    // 环境信息是锦上添花，绝不能因为它发不出回复
    logWarn("环境", "拼环境信息失败，这一轮不带", e);
    return { time: "", weather: "" };
  }
}

/**
 * 把 `buildEnv` 加在用户原话前面的那对方括号**剥掉**，只留他真正打的字。
 *
 * 为什么要有这个函数：那段前缀是给**聊天模型**看的（每条历史消息自带当时的
 * 时间脉络，见文件头）。可记忆库要的是「他说了什么」——
 * 待总结里存着 `[{{user}}发送当地时间 CST : … | 周三, 工作日 | …]wyd` 这种东西时，
 * 模型总结出来的记忆会带上一串没意义的时区和节假日；日记流水更糟，
 * 它自己**行首已经有系统时间**了，前缀等于把同一个时刻用两种格式写两遍。
 *
 * 剥得很保守 —— 必须同时满足三条才动手：
 *  1. 方括号在**最开头**（前缀只会加在开头）；
 *  2. 括号里有一个 `YYYY-MM-DD HH:MM:SS` 时间戳；
 *  3. 括号里出现 env 自己那几个字眼之一。
 *
 * 三条都卡死是因为对方完全可以自己发一条 `[备注] 记得带伞`：
 * 只按「开头的方括号」剥的话，他的原话就被我们吃掉一截了。宁可漏剥，
 * 不可错剥 —— 漏剥只是这一轮的总结里多一段噪音，错剥是永久改坏了记录。
 *
 * 天气那个字眼也列进去了：天气本来不进存档（只并进发给模型的那一份），
 * 但「上下文」面板允许手改，手改过的那条真有可能带着天气段传下来。
 */
const ENV_PREFIX =
  /^\[(?=[^\]]*\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2})(?=[^\]]*(?:发送当地时间|收到当地时间|当地天气|时间\s*:))[^\]]*\]\s*/;

export function stripEnvPrefix(text) {
  return String(text ?? "").replace(ENV_PREFIX, "");
}

/**
 * 两边的天气段，用分号隔开（和时间段的竖线区分开）。都拿不到就返回空串。
 *
 * 同城模式只查一次、只报一段 —— 同一个城市查两遍是白费一次请求，
 * 报两遍是白费 token。
 */
async function buildWeather(sides, weather, keys, same = false) {
  if (same) {
    const w = sides.user ? await weatherAt(sides.user, weather, keys) : null;
    return weatherSegment("", sides.user, w, weather);
  }

  const [wu, wc] = await Promise.all([
    sides.user ? weatherAt(sides.user, weather, keys) : null,
    sides.char ? weatherAt(sides.char, weather, keys) : null,
  ]);
  return [
    weatherSegment("{{user}}", sides.user, wu, weather),
    weatherSegment("{{char}}", sides.char, wc, weather),
  ]
    .filter(Boolean)
    .join(" ; ");
}

/**
 * 给前端预览用：两段分别回传 + 合起来的完整形状 + 两个城市的解析结果。
 *
 * 三样都要：界面上「发给模型的」和「进存档的」是两行显示的，这一版最需要
 * 让用户看清的就是这个区别。城市解析结果单独回传，好把查不到的城市标红，
 * 也能显示「识别到：南宁 / Asia/Shanghai / CN」。
 *
 * 密钥**只报有没有填**（`keys`），绝不回传内容。
 */
export async function envPreview(role, keys) {
  const env = role?.env;
  const same = env?.time?.mode === "same";
  const userCity = String(env?.time?.userCity ?? "").trim();
  const charCity = String(env?.time?.charCity ?? "").trim();
  const [user, char] = await Promise.all([geocode(userCity), geocode(charCity)]);

  const { time, weather } = await buildEnv(role, keys);

  return {
    time,
    weather,
    // 合起来就是模型看到的样子，拼法和 prompt.js 的 injectWeather 一致
    prefix: weather ? (time ? `${time.slice(0, -1)} | ${weather}]` : `[${weather}]`) : time,
    holidayDataUntil: HOLIDAY_DATA_UNTIL,
    keys: {
      qweather: {
        host: Boolean(qwHost(keys?.qweather?.host)),
        key: Boolean(String(keys?.qweather?.key ?? "").trim()),
        // 填了但一看就不是域名（没有点）—— 多半是把 Key 或项目 ID 填进来了。
        // 不报内容，只报「形状不对」，前端据此标红
        hostLooksWrong: badQwHost(keys?.qweather?.host),
      },
      weatherapi: { key: Boolean(String(keys?.weatherapi?.key ?? "").trim()) },
    },
    sides: {
      user: { city: userCity, resolved: user },
      // 同城模式下 charCity 不参与计算，回传 null 免得界面上标红一个不用的框
      char: same ? { city: "", resolved: null } : { city: charCity, resolved: char },
    },
  };
}