/**
 * 手机那十八件事的执行层：发触发邮件，该等回传的等回传。
 *
 * ── 一条链路，三种收尾 ──
 *
 * 三种 kind 的前半截完全一样（`spyphone.js:sendTriggerMail` 发一封主题带关键字的
 * 邮件，iPhone 的邮件自动化收到就跑对应那条快捷指令），区别只在后半截：
 *
 *   screenshot  等一张图 → 交给调用方去识图（这个文件不识图，见下面那段）
 *   json        等一段 JSON → 按功能拼成一句人话
 *   control     不等 —— 邮件发出去就算完事
 *
 * ── 为什么 screenshot 这一路不在这儿识图 ──
 *
 * 识图要视觉模型，而视觉模型是**角色**的东西（`eps.vision`）。这个文件只认
 * 「手机」这一层，不认角色 —— 把角色塞进来的话，整合查岗那边攒一堆图最后
 * 一次性识图的路子就没法走了（它要的是「先把图都拿回来，再一起识」）。
 * 所以这儿只负责把 Buffer 交出去，怎么变成文字由上面决定。
 *
 * ── 为什么 control 不等回传 ──
 *
 * 参考插件那边有个「操控后自动截图」的开关，锁屏、放歌之后再截一张图确认。
 * 这儿不做，两个理由：
 *
 *  1. **锁屏之后截图必然是锁屏画面**，确认不了任何事。
 *  2. 放歌之后那张图要走一趟识图（十几秒 + 一次识图钱）才能告诉模型
 *     「在放晴天」—— 可是那句话我们本来就知道，是我们自己让它放的。
 *
 * 所以 control 直接回一句「已经照做了」，模型拿着这句话说人话就行。
 *
 * ── 失败信息为什么写得这么细 ──
 *
 * 这些话最后会进提示词给模型看，也会进控制台给用户看。「失败了」三个字对
 * 两边都没用：模型不知道该怎么跟用户说，用户不知道该去查什么。所以每一条
 * 都说清是哪一步断的（邮件没发出去 / 手机没响应 / 回传的东西读不懂）。
 */

import { logDebug, logInfo, logWarn } from "./logs.js";
import { resolveMusic } from "./music.js";
import { featureByKey, matchFeature } from "./spyfeatures.js";
import {
  cancelShot,
  createShotRequest,
  phoneConfigProblem,
  sendTriggerMail,
  waitForShot,
} from "./spyphone.js";

/** 一张图 / 一段 JSON 最多多大。和 spy.js 那道闸一致，理由见那边。 */
const MAX_BYTES = 20 * 1024 * 1024;

/**
 * 等回传最多等多久（毫秒）。
 *
 * 和单个查岗共用配置里那个 `waitSeconds`（默认 90 秒）：这段时间要走完
 * 「SMTP 投递 → iCloud 推送 → 邮件自动化冷启动 → 打开 App → 等它加载完
 * → 截屏 → 转 JPEG → 上传」。App 那几件事比纯截屏慢不少，所以宁可宽一点。
 */
const WAIT_DEFAULT = 90000;

/** 钳在 20–180 秒。和 spy.js:clampWait 同一套，理由见那边。 */
function clampWait(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return WAIT_DEFAULT;
  return Math.min(180, Math.max(20, Math.round(n))) * 1000;
}

/** 认图片魔数。和 spy.js:sniffImage 同一套。 */
function sniffImage(buf) {
  if (buf.length < 12) return "";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.toString("latin1", 0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") {
    return "image/webp";
  }
  if (buf.toString("latin1", 0, 3) === "GIF") return "image/gif";
  return "";
}

/* ======================= 参数 → 邮件正文 ======================= */

/** 闹钟时间：认 `7:30`、`07:30`、`7点30`、`19:05`，统一成 `HH:MM`。 */
function parseClock(arg) {
  const raw = String(arg ?? "").trim();
  // 先试标准写法，再试「7点30分」「7点」这种中文写法
  let m = /^(\d{1,2})\s*[:：.]\s*(\d{1,2})$/.exec(raw);
  if (!m) m = /^(\d{1,2})\s*点\s*(?:(\d{1,2})\s*分?)?$/.exec(raw);
  if (!m) return "";

  const h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return "";
  if (h < 0 || h > 23 || min < 0 || min > 59) return "";
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/**
 * 预设歌单：按名字在用户配置的那张表里找。
 *
 * 匹配规则和 `spyfeatures.js:matchFeature` 一致（完全 → 忽略大小写 → 双向包含），
 * 所以歌单叫「睡前」时说「睡」也认得。
 *
 * @param {string} name 模型写的歌单名
 * @param {{name:string, id:string}[]} presets 用户配置里那几个
 * @returns {{name:string, id:string}|null}
 */
function matchPlaylist(name, presets) {
  const key = String(name ?? "").replace(/\s+/g, "").toLowerCase();
  if (!key || !presets.length) return null;

  const norm = (s) => String(s ?? "").replace(/\s+/g, "").toLowerCase();
  for (const p of presets) if (norm(p.name) === key) return p;
  for (const p of presets) {
    const n = norm(p.name);
    if (n && (key.includes(n) || n.includes(key))) return p;
  }
  return null;
}

/**
 * 把功能 + 参数变成「邮件正文该写什么」。
 *
 * 不需要参数的返回空串（`sendTriggerMail` 会填一句占位的话）。参数不对时抛错 ——
 * 抛出来的话最后会变成给模型看的失败原因，比发一封正文是垃圾的邮件强：那样
 * 手机那头会真的跑一遍快捷指令，然后设一个时间不对的闹钟。
 *
 * @param {object} feature 功能表里那一条
 * @param {string} arg 标签里冒号后面那串
 * @param {object} ctx `{ playlists, scope }`
 * @returns {Promise<{body:string, label:string}>} label 是给人看的「做了什么」
 * @throws {Error} 参数不对、歌没搜到、歌单没预设过
 */
async function buildBody(feature, arg, { playlists = [], scope = "查岗" } = {}) {
  if (!feature.needsArg) return { body: "", label: feature.name };

  const raw = String(arg ?? "").trim();
  if (!raw) throw new Error(`${feature.name}要给一个参数（${feature.argHint}）`);

  // ---- 三个闹钟：正文就是 HH:MM ----
  if (feature.key === "alarmSet" || feature.key === "alarmOn" || feature.key === "alarmOff") {
    const clock = parseClock(raw);
    if (!clock) throw new Error(`「${raw}」不像一个时间，要写成 07:30 这样`);
    return { body: clock, label: `${feature.name} ${clock}` };
  }

  // ---- 放歌：先去网易云搜一个歌曲 ID，拼成 orpheus:// ----
  if (feature.key === "musicSong") {
    /*
     * 复用 music.js:resolveMusic —— 项目里本来就有一套搜歌（分享歌曲那个功能
     * 在用），它两家一起搜还打分挑最像的，比参考插件「取搜索结果第一条」准。
     *
     * 但**必须要网易云那一路的结果**：要拼的是 `orpheus://song/<id>`，那是
     * 网易云自己的 scheme，Apple Music 的 ID 塞进去打不开。所以指定 source，
     * 拿回来再验一遍是不是 163 的链接 —— resolveMusic 在网易云搜不到、
     * Apple 搜到了的时候会回 Apple 那条。
     */
    let hit;
    try {
      hit = await resolveMusic(raw, { source: "netease", scope });
    } catch (e) {
      throw new Error(`搜「${raw}」的时候网络出错了（${e.message}）`);
    }
    if (!hit) throw new Error(`网易云上没搜到「${raw}」，换个说法试试`);

    const id = /[?&]id=(\d+)/.exec(String(hit.url ?? ""))?.[1];
    if (!id) {
      // 搜到了但是 Apple 那条：网易云没有这首歌
      throw new Error(`网易云上没搜到「${raw}」（别处有，但那个放不了）`);
    }
    const shown = [hit.artist, hit.title].filter(Boolean).join(" - ") || raw;
    return { body: `orpheus://song/${id}/?autoplay=1`, label: `播放《${shown}》` };
  }

  // ---- 预设歌单：ID 是用户自己填的 ----
  if (feature.key === "musicPlaylist") {
    if (!playlists.length) {
      throw new Error("用户还没预设过任何歌单（要先去设置里填「预设歌单」那一栏）");
    }
    const hit = matchPlaylist(raw, playlists);
    if (!hit) {
      throw new Error(
        `没有叫「${raw}」的歌单。预设过的是：${playlists.map((p) => p.name).join("、")}`
      );
    }
    return { body: `orpheus://playlist/${hit.id}/?autoplay=1`, label: `播放歌单「${hit.name}」` };
  }

  // 表里加了 needsArg 但这儿忘了写怎么处理 —— 宁可报出来也别静默发一封空邮件
  throw new Error(`${feature.name}还没接上参数处理`);
}

/* ======================= JSON 回传 → 一句话 ======================= */

/**
 * 电量 / 位置回传的 JSON，拼成一句给模型看的话。
 *
 * 字段名做了兼容：参考插件的说明书教用户在快捷指令里拼 `{"level": 85}`，
 * 但那一步是手打的，写成 `battery` 的人肯定有。位置同理（`address` /
 * `longitude` / `latitude`）。
 *
 * **电量那个小数陷阱**：快捷指令的「获取电池电量」在某些 iOS 版本上回的是
 * `0.85` 而不是 `85`（参考插件的说明书里专门提醒用户插一个「×100」的动作）。
 * 这儿自己认出来 —— 0 到 1 之间的值当成小数换算，省得用户去改快捷指令。
 * 刚好 1% 电的那种极端情况会被误当成 100%，但那比「85 显示成 0.85%」常见得多。
 */
function readJson(feature, buf) {
  let data;
  try {
    data = JSON.parse(buf.toString("utf8"));
  } catch {
    // 回传的不是 JSON —— 快捷指令里那个「文本」动作的内容写错了
    const head = buf.toString("utf8").slice(0, 60).replace(/\s+/g, " ").trim();
    throw new Error(`手机传回来的不是数据${head ? `（开头是「${head}」）` : ""}`);
  }
  if (!data || typeof data !== "object") throw new Error("手机传回来的数据是空的");

  if (feature.key === "battery") {
    const raw = data.level ?? data.battery ?? data.percent;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error("回传的数据里没有电量");
    // 0–1 之间当成小数（见上面那段）
    const pct = n > 0 && n <= 1 ? Math.round(n * 100) : Math.round(n);
    return `手机电量 ${pct}%`;
  }

  if (feature.key === "location") {
    const addr = String(data.address ?? data.name ?? "").trim();
    const lon = data.longitude ?? data.lon ?? data.lng;
    const lat = data.latitude ?? data.lat;
    const coords =
      lon != null && lat != null && String(lon).trim() && String(lat).trim()
        ? `经度 ${lon}，纬度 ${lat}`
        : "";
    if (!addr && !coords) throw new Error("回传的数据里没有位置");
    if (!addr) return `手机现在的位置：${coords}`;
    return `手机现在的位置：${addr}${coords ? `（${coords}）` : ""}`;
  }

  // 表里以后加了新的 json 条目但这儿没写 —— 原样丢给模型，比报错强
  return JSON.stringify(data);
}

/* ============================ 执行 ============================ */

/**
 * 做一件事。
 *
 * **从不抛错** —— 调用方（单个标签那一路、整合查岗那一路）都要靠返回值决定
 * 下一步，而且「没做成」在这个功能里是很正常的结局（手机锁着、App 没装、
 * 用户不在身边），不该当异常处理。
 *
 * @param {object} feature 功能表里那一条
 * @param {string} arg 标签里冒号后面那串参数，没有就空串
 * @param {object} ctx
 * @param {object} ctx.spyApi 全局那份（SMTP 凭据 + 校验密钥 + 等待时长）
 * @param {{name:string,id:string}[]} [ctx.playlists] 用户预设的歌单
 * @param {string} [ctx.scope] 日志作用域
 * @returns {Promise<{ok:boolean, text:string, image:Buffer|null, mimeType:string, label:string}>}
 *   - `ok:false` 时 `text` 是失败原因
 *   - screenshot 成功时 `text` 是空串、`image` 有货（识图交给调用方）
 *   - json / control 成功时 `text` 是现成的一句话
 */
export async function runFeature(feature, arg = "", ctx = {}) {
  const { spyApi, playlists = [], scope = "查岗" } = ctx;
  const fail = (text) => ({ ok: false, text, image: null, mimeType: "", label: feature.name });

  // 配置不全：一个字都别发，直接说缺什么
  const problem = phoneConfigProblem(spyApi);
  if (problem) {
    logWarn(scope, `「${feature.name}」没做：${problem}`);
    return fail(problem);
  }

  // 参数 → 正文。搜歌那一步也在这儿（可能打网络、可能搜不到）
  let body = "";
  let label = feature.name;
  try {
    const built = await buildBody(feature, arg, { playlists, scope });
    body = built.body;
    label = built.label;
  } catch (e) {
    logWarn(scope, `「${feature.name}」没做：${e.message}`);
    return fail(e.message);
  }

  /*
   * control 这一路：发完就完事，不挂等待条目。
   *
   * 顺序和下面那一路刻意相反 —— 那边必须**先挂条目再发邮件**（不然网络快的
   * 时候图会比条目先到、被当成没人要的丢掉），这边压根没有条目可挂。
   */
  if (feature.kind === "control") {
    try {
      await sendTriggerMail(spyApi, { subject: feature.subject, body });
    } catch (e) {
      logWarn(scope, `「${label}」的触发邮件发不出去：${e.message}`);
      return fail(`指令发不出去（${e.message}）`);
    }
    logInfo(scope, `已让手机${label}`);
    return { ok: true, text: `已经让手机${label}了`, image: null, mimeType: "", label };
  }

  // ---- screenshot / json：先挂条目，再发邮件，然后等 ----
  const waitMs = clampWait(spyApi?.waitSeconds);
  let id;
  try {
    id = createShotRequest(feature.name);
  } catch (e) {
    // 排队的太多了（MAX_PENDING）。多半是配置有问题、每次都超时攒下来的
    logWarn(scope, `「${feature.name}」没排上队：${e.message}`);
    return fail(e.message);
  }

  try {
    await sendTriggerMail(spyApi, { subject: feature.subject, body });
  } catch (e) {
    cancelShot(id);
    logWarn(scope, `「${feature.name}」的触发邮件发不出去：${e.message}`);
    return fail(`指令发不出去（${e.message}）`);
  }

  logDebug(scope, `「${feature.name}」的触发邮件发出去了，最多等 ${Math.round(waitMs / 1000)} 秒`);

  let buf;
  try {
    buf = await waitForShot(id, waitMs);
  } catch (e) {
    logWarn(scope, `「${feature.name}」没等到回传：${e.message}`);
    return fail(
      `没看到（${Math.round(waitMs / 1000)} 秒内手机没回传，可能锁着屏、没网，` +
        `或者这个功能的快捷指令还没配）`
    );
  }

  if (!buf.length) return fail("手机传回来的是空的");
  if (buf.length > MAX_BYTES) {
    return fail(`手机传回来的东西太大了（${Math.round(buf.length / 1024 / 1024)}MB）`);
  }

  // ---- JSON 那一路：就地读成一句话 ----
  if (feature.kind === "json") {
    try {
      const text = readJson(feature, buf);
      logInfo(scope, `「${feature.name}」拿到了：${text}`);
      return { ok: true, text, image: null, mimeType: "", label };
    } catch (e) {
      logWarn(scope, `「${feature.name}」的回传读不懂：${e.message}`);
      return fail(e.message);
    }
  }

  // ---- 截图那一路：验个魔数就交出去，识图不在这儿做 ----
  const mimeType = sniffImage(buf);
  if (!mimeType) {
    return fail("手机传回来的不是图片（检查快捷指令里 image 那一行是不是选成了【文本】）");
  }
  logInfo(scope, `「${feature.name}」的截图到了，约 ${Math.round(buf.length / 1024)}KB`);
  return { ok: true, text: "", image: buf, mimeType, label };
}

/**
 * 按名字做一件事。标签那两条路进来的入口。
 *
 * @param {string} keyword 标签里冒号后面那串（可能带参数）
 * @param {object[]} pool 只在这些条目里找（查看类 / 操控类）
 * @param {object} ctx 同 runFeature
 * @returns {Promise<{feature:object|null, ok:boolean, text:string, image:Buffer|null, mimeType:string, label:string}>}
 *   名字对不上时 `feature` 是 null、`text` 是给模型看的解释
 */
export async function runByName(keyword, pool, ctx = {}) {
  const { feature, arg } = splitArg(keyword, pool);
  if (!feature) {
    const names = pool.map((f) => f.name).join("、");
    const text = `没有「${String(keyword ?? "").trim()}」这个功能。能用的是：${names}`;
    logWarn(ctx.scope || "查岗", text);
    return { feature: null, ok: false, text, image: null, mimeType: "", label: "" };
  }
  const out = await runFeature(feature, arg, ctx);
  return { feature, ...out };
}

/**
 * 把「功能名 + 参数」拆开。
 *
 * 标签里写的是一整串（`放歌 晴天`、`设置闹钟 7:30`、`支付宝账单`），中间没有
 * 固定的分隔符 —— 模型爱用空格，也见过用冒号和顿号的。
 *
 * 做法是**按已知的功能名去啃前缀**：拿每条的名字和别名去比，能对上就把剩下的
 * 当参数。这比「按第一个空格切」可靠得多 —— 功能名本身可能带空格（「播放/暂停」
 * 用户会写成「播放 暂停」），参数更是几乎一定带空格（「稻香 周杰伦」）。
 *
 * 啃不出前缀时整串交给 matchFeature 兜一次（不带参数的功能走这条）。
 *
 * @returns {{feature:object|null, arg:string}}
 */
export function splitArg(keyword, pool) {
  const raw = String(keyword ?? "").trim();
  if (!raw) return { feature: null, arg: "" };

  /*
   * 先试整串。不带参数的功能（锁屏、每日推荐）走这条，而且能让 matchFeature
   * 的双向包含规则发挥作用 —— 「看看我的支付宝账单」整串能匹配上。
   *
   * 排在啃前缀之前是刻意的：整串能对上就说明用户没给参数，这时候去啃前缀
   * 只会把「播放暂停」啃成「播放」+ 参数「暂停」。
   */
  const whole = matchFeature(raw, pool);
  if (whole && !whole.needsArg) return { feature: whole, arg: "" };

  /*
   * 啃前缀。**按名字长度从长到短试** —— 「设置闹钟」和「闹钟」都在别名里的话，
   * 先试长的才不会把「设置闹钟 7:30」啃成「闹钟」+ 参数「设置闹钟 7:30」。
   */
  const cands = [];
  for (const f of pool) {
    for (const n of [f.name, ...f.aliases]) cands.push({ f, n: String(n) });
  }
  cands.sort((a, b) => b.n.length - a.n.length);

  const flat = (s) => String(s).replace(/\s+/g, "").toLowerCase();
  const flatRaw = flat(raw);
  for (const { f, n } of cands) {
    const flatName = flat(n);
    if (!flatName || !flatRaw.startsWith(flatName)) continue;

    /*
     * 参数要从**原串**里切，不能从压平的那串里切 —— 压平之后「稻香 周杰伦」
     * 变成「稻香周杰伦」，切出来的参数就没了空格，搜歌那边会当成一个词去搜。
     *
     * 所以在原串上按「跳过 flatName 那么多个非空白字符」的办法数位置。
     */
    let seen = 0;
    let cut = 0;
    for (; cut < raw.length && seen < flatName.length; cut += 1) {
      if (!/\s/.test(raw[cut])) seen += 1;
    }
    const arg = raw.slice(cut).replace(/^[\s:：、,，]+/, "").trim();
    if (arg || !f.needsArg) return { feature: f, arg };
  }

  // 啃不出来：整串兜一次（可能匹配上一个要参数的功能，但参数没给 ——
  // 那种情况 buildBody 会报「要给一个参数」，比这儿静默失败清楚）
  return { feature: whole ?? matchFeature(raw, pool), arg: "" };
}

/** 按 key 做一件事。整合查岗那边按配置里存的 key 遍历。 */
export async function runByKey(key, ctx = {}) {
  const feature = featureByKey(key);
  if (!feature) return { feature: null, ok: false, text: `没有 ${key} 这个功能`, image: null, mimeType: "", label: "" };
  return { feature, ...(await runFeature(feature, "", ctx)) };
}
