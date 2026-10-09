/**
 * 共感娃娃：**手机塞在玩偶里，抱一下，角色那边收到一句系统提示。**
 *
 * 这个文件是「怎么知道被抱了」那一半：连手机上 phyphox 的远程接口、把加速度流
 * 喂进一个状态机、认出一次完整的拥抱（抱起来 → 抱着 → 放下），算出**抱了多久**
 * 和**抱得多紧**。真正的**发**（找会话、排队、触发一轮）留在 imessage.js，
 * 和 proactive.js / friendloc.js 一个待遇 —— 那边长着 runner 和 chain，
 * 搬过来两个模块就得互相 import。
 *
 * 所以这个文件是纯的：只 import logs，不认识 runner，也不碰 config 的结构。
 *
 * ── 为什么是 phyphox，不是网页读传感器 ──
 *
 * 浏览器那条路走不通：`DeviceMotionEvent` 要求**安全上下文**，手机浏览器开
 * `http://192.168.x.x:8787` 拿不到加速度权限（iOS 上连 requestPermission 都
 * 不给调），得先把控制台套上 HTTPS 或者挂隧道 —— 为一个抱娃娃的功能让每个用户
 * 去折腾证书，不现实。
 *
 * phyphox（RWTH Aachen 那个传感器实验 App）反过来：**手机是服务端**。打开
 * 「允许远程访问」之后手机自己起一个 HTTP 服务，电脑这边去读，没有任何权限
 * 关卡。而且它顺手解决了采样：加速度以几十上百 Hz 进 buffer，我们按时间轴
 * 增量取，不会漏掉「抱起来那一下」的尖峰。
 *
 * ── 两种接法：拉 和 推 ──
 *
 * 上面说的那条是**拉**（`pull`）：服务端定时去读手机。它要求服务端摸得到
 * 手机所在的网 —— 自己电脑上跑的时候这是天经地义的，**挂在 VPS 上就不成立了**
 * （VPS 在机房，手机在家里的路由器后面），Cloudflare Worker 更不可能。
 *
 * 所以还有一条**推**（`push`）：phyphox 的「网络连接」能让实验自己定时
 * `POST` 一包 JSON 出来（`service="http/post"`，见 buildDollExperiment）。
 * 手机主动往外连，于是服务端在哪都行 —— 公网 VPS、Worker、甚至家里电脑
 * 挂个内网穿透。代价是得让用户在手机上装一个**我们生成的实验文件**
 * （官方的 Acceleration without g 里没有网络连接块，那东西只能写在实验里）。
 *
 * 两条路**共用同一个状态机**：`feedDollSamples` 吃的就是「一把带时间戳的
 * 样本」，拉回来的和推过来的长得一模一样。所以推送模式没有第二套判定逻辑，
 * 阈值、冷却、那句话的拼法全都照旧。
 *
 * ── 那个远程接口的几个要紧事实 ──
 *
 *  - 端口：**Android 默认 8080，iOS 默认 80**，被占了会往后找（8081…）并在
 *    App 上显示实际地址。所以地址必须让用户自己填，不能写死端口；
 *  - **没有任何鉴权**，谁能连上就能读、还能 start/stop。这也是为什么这功能
 *    默认关着、而且文档里得说清「别在公共 WiFi 上开」；
 *  - `/get?名字` 回那个 buffer 的**最后一个值**；`/get?名字=阈值%7C参照` 回
 *    「参照 buffer 第一次超过阈值之后的所有值」。拿时间轴当参照就是标准的
 *    增量拉取（竖线必须 `%7C`，URLSearchParams 会自己编）；
 *  - 回的 `status.session` 一变 = 用户在手机上换了实验，缓存的名字和状态全作废；
 *    `status.measuring` 为假 = 实验停着，这时候的数据是旧的；
 *  - **服务器是单线程而且慢**，官方自己的网页界面在两次请求之间留 10ms。
 *    所以这边一次请求把要的 buffer 全带上，绝不并发打。
 *
 * ── 为什么时长不能只看「加速度还在动」 ──
 *
 * 抱着不动的时候线性加速度几乎是 0（只剩呼吸和体动那点零点几 m/s²），和放在
 * 桌上的区别很小。所以状态机里「还抱着」的判据是一个**低得多的**活跃阈值，
 * 而且允许配一个「遮挡」buffer（接近传感器或光线传感器）：塞在玩偶里被抱住时
 * 它是被捂着的，一松手就亮/变远。填了那个的时长准得多，没填也能跑。
 */

import { logDebug, logInfo, logWarn } from "./logs.js";

/** 探一次（/config、/meta、cmd=start）给多久。手机慢，给宽一点。 */
const PROBE_TIMEOUT = 8_000;

/**
 * 轮询一次给多久。
 *
 * **必须明显短于轮询间隔**，不然上一次还没回来下一次就排上了 —— 而 phyphox
 * 那个服务器是单线程的，排起来会越积越慢。400ms 的间隔配 3 秒超时：真卡住
 * 这一跳就当没拿到，下一跳重来。
 */
const POLL_TIMEOUT = 3_000;

/** 轮询间隔的上下限（毫秒）。 */
export const POLL_MIN_MS = 200;
export const POLL_MAX_MS = 3_000;

/** 一次 /get 最多认多少个样本。手机采样率高 + 网络卡了一会儿，可能一口气回几千个。 */
const MAX_SAMPLES = 4_000;

/**
 * 「实验没在跑」时隔多久才再试一次 `cmd=start`。
 *
 * 不每跳都试：start 可能被拒（phyphox 文档里的例子是实验要的蓝牙设备没连上），
 * 那种情况下每 400ms 打一次纯属给那个单线程服务器添堵。
 */
const RESTART_EVERY_MS = 30_000;

/**
 * 连着这么多包「整包都是旧数据」，才认定手机那边是真的重来过。
 *
 * 3 包：推模式默认两秒一包，也就是忍六秒的乱序 —— 够盖住「服务端回得慢、
 * 几包挤在一起到」那种情况，又不至于在用户真的清空之后傻等太久。
 * 详见 feedDollSamples 里那段「时间轴往回走了，是哪一种」。
 */
const STALE_BATCHES_MAX = 3;

/** 连续算「抱着」多久就提醒一句阈值可能太低。见 feedDollSamples。 */
const LONG_HOLD_WARN_MS = 30_000;

/* ================= 地址 ================= */

/**
 * 用户填的那串东西 → 一个能用的 URL。
 *
 * 填法随意（`192.168.1.23:8080`、`http://192.168.1.23:8080`、带个斜杠），
 * 照 spy.js:urlFor 的规矩补 `http://`。
 *
 * **端口不补默认值**：Android 是 8080、iOS 是 80，猜错了用户只会看到「连不上」
 * 而不知道为什么。没写端口就按 URL 的规矩走（即 80），和 iOS 正好对上；
 * 安卓用户必须自己写上 8080，面板那边的提示里说了。
 *
 * 一律 http —— phyphox 只说 http。写了 https 直接留着，让它连不上并在
 * whyDoll 里给出「别写 https」那句。
 */
export function dollUrl(host, path = "/", query = null) {
  const raw = String(host ?? "").trim();
  if (!raw) return "";
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const u = new URL(withScheme);
    u.pathname = path;
    u.search = "";
    if (query) {
      /*
       * 用 URLSearchParams 而不是自己拼：阈值那种写法是 `名字=数字|参照`，
       * 那根竖线**必须**是 %7C（phyphox 文档明写），手拼很容易漏。
       * 值为 null 的参数要写成**裸键**（`?acc`，意思是「只要最后一个值」），
       * URLSearchParams 对空字符串正好给出 `acc=`，phyphox 两种都认空值。
       */
      const sp = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (!k) continue;
        sp.append(k, v == null ? "" : String(v));
      }
      u.search = sp.toString();
    }
    return u.toString();
  } catch {
    return "";
  }
}

/**
 * 连不上时给人看的原因。
 *
 * 照 spy.js:whyGrab 的路子**往 cause 里挖** —— fetch 连不上时抛的是一个
 * message 只有 `fetch failed` 的 TypeError，有用的 code 埋在 `e.cause.code`。
 * 挖不出来也不能回落到那句话，那对排障毫无帮助。
 */
export function whyDoll(e, timeoutMs = PROBE_TIMEOUT) {
  const cause = e?.cause;
  const code = e?.code || cause?.code || "";
  const name = e?.name || cause?.name || "";

  if (name === "AbortError" || name === "TimeoutError" || code === "ABORT_ERR") {
    return `超过 ${Math.round(timeoutMs / 1000)} 秒没响应（手机息屏了？phyphox 得在前台开着）`;
  }
  if (code === "ECONNREFUSED") return "手机上的 phyphox 没开远程访问，或者端口不对（安卓一般是 8080，iPhone 是 80）";
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return "网络不通（手机和这台电脑得在同一个 WiFi 下）";
  if (code === "ETIMEDOUT") return "连接超时（手机息屏或者不在同一个网里）";
  if (code === "ENOTFOUND") return "地址解析不了";
  if (code === "ECONNRESET") return "连接被手机掐断了";
  if (code === "CERT_HAS_EXPIRED" || code === "ERR_TLS_CERT_ALTNAME_INVALID" || /ssl|tls/i.test(code)) {
    return "证书不对（phyphox 只说 http，别写 https）";
  }
  const msg = String(e?.message ?? "");
  if (code) return `连不上（${code}）`;
  return msg && msg !== "fetch failed" ? msg : "连不上（地址填错，或者 phyphox 的远程访问没开）";
}

/** 带超时地 GET 一个 JSON 回来。phyphox 的错误体是 `{error: "人话"}`。 */
async function getJson(url, timeoutMs) {
  let resp;
  try {
    resp = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: "application/json,*/*" },
    });
  } catch (e) {
    throw new Error(whyDoll(e, timeoutMs));
  }
  /*
   * iOS 那边**裸 `/get` 会回 401**（它要求必须指定 buffer 名），安卓则是回一个
   * 空 buffer。我们从来不发裸 /get，所以真收到 401 更可能是地址填成了别的服务。
   */
  if (!resp.ok) throw new Error(`phyphox 返回 ${resp.status}${resp.status === 401 ? "（这个地址像是别的服务，不是 phyphox）" : ""}`);
  let data;
  try {
    data = await resp.json();
  } catch {
    throw new Error("返回的不是 JSON（这个地址多半不是 phyphox 的远程访问）");
  }
  // phyphox 有几个端点出错时照样回 200，错误放在 {error:"…"} 里
  if (data && typeof data === "object" && typeof data.error === "string" && data.error) {
    throw new Error(data.error);
  }
  return data;
}

/* ================= 读手机 ================= */

/**
 * 手机上现在跑的是哪个实验、有哪些 buffer 能读。
 *
 * 给面板的「测试连接」用：把 export 里那几组**作者认为值得留下的**列举出来，
 * 用户照着填 buffer 名就行。`/config` 里的 `buffers` 虽然全，但里面大半是分析
 * 中间量（算一轮就被清掉或重写），照着填只会得到一串看不懂的数 ——
 * phyphox 文档自己也建议客户端从 export 那几组入手。
 *
 * `/config` 是 phyphox 1.1.6 才有的。老版本会 404，这里照原样把那句错误抛上去。
 *
 * @returns {Promise<{title:string, buffers:Array<{name:string,size:number}>,
 *   sensors:string[], exports:Array<{set:string, sources:Array<{label:string,buffer:string}>}>}>}
 */
export async function fetchDollConfig(host) {
  const url = dollUrl(host, "/config");
  if (!url) throw new Error("手机地址没填");
  const data = await getJson(url, PROBE_TIMEOUT);
  const buffers = Array.isArray(data?.buffers)
    ? data.buffers
        .map((b) => ({ name: String(b?.name ?? ""), size: Number(b?.size ?? 0) }))
        .filter((b) => b.name)
    : [];
  const exports = Array.isArray(data?.export)
    ? data.export.map((e) => ({
        set: String(e?.set ?? ""),
        sources: Array.isArray(e?.sources)
          ? e.sources
              .map((s) => ({ label: String(s?.label ?? ""), buffer: String(s?.buffer ?? "") }))
              .filter((s) => s.buffer)
          : [],
      }))
    : [];
  // inputs 里的 source 就是传感器名（accelerometer / linear_acceleration / proximity / light…）
  const sensors = Array.isArray(data?.inputs)
    ? [...new Set(data.inputs.map((i) => String(i?.source ?? "")).filter(Boolean))]
    : [];
  return {
    // localTitle 是手机当前语言下的名字，用户在 App 上看到的就是这个
    title: String(data?.localTitle || data?.title || ""),
    buffers,
    sensors,
    exports,
  };
}

/**
 * 从 `/config` 猜该用哪两个 buffer。
 *
 * 只是给面板填个默认值省得用户对着一串名字发愣，猜错了他自己改。规则很土：
 * export 里挑一组名字带 acceleration/加速度 的，组里找带 `t`/`time` 的当时间轴、
 * 带 `absolute`/`magnitude` 的当幅值；找不到幅值就退而求其次用 x 分量
 * （单轴也能用，只是「力度」会偏小）。
 *
 * @returns {{magnitude:string, time:string, cover:string}} 猜不出来的给空串
 */
export function guessDollBuffers(config) {
  const out = { magnitude: "", time: "", cover: "" };
  const all = [];
  for (const set of config?.exports ?? []) {
    for (const s of set.sources ?? []) all.push({ set: set.set, label: s.label, buffer: s.buffer });
  }
  const pool = all.length
    ? all
    : (config?.buffers ?? []).map((b) => ({ set: "", label: b.name, buffer: b.name }));
  const hit = (re) => pool.find((p) => re.test(p.buffer) || re.test(p.label));

  out.magnitude =
    hit(/absolute|magnitude|^acc$|总|幅值/i)?.buffer ||
    hit(/^acc_?x$|accelerationx/i)?.buffer ||
    "";
  out.time = hit(/^acc_?time$|^t$|^time$|时间/i)?.buffer || hit(/time/i)?.buffer || "";
  out.cover = hit(/prox|illum|light|lux|照度|接近/i)?.buffer || "";
  return out;
}

/**
 * 拉一把新样本。
 *
 * `since` 是上一次拿到的最后一个时间值（实验时间，秒）。给了就按时间轴增量取，
 * 没给就只取**最后一个值**并把它的时间当起点 —— 不能开机就把整个 buffer 的
 * 历史读进来，那会让「刚才的两百次晃动」一股脑儿变成一次超长拥抱。
 *
 * 遮挡 buffer 单独按「最后一个值」取，不跟时间轴配对：接近/光线传感器是事件
 * 驱动的，几秒才出一个样本，按索引配对只会得到一串空。
 *
 * @returns {Promise<{session:string, measuring:boolean, samples:Array<{t:number,a:number}>,
 *   cover:number|null, last:number|null}>}
 */
export async function fetchDollSamples(host, { magnitude, time, cover = "", since = null } = {}) {
  const mag = String(magnitude ?? "").trim();
  const tb = String(time ?? "").trim();
  const cb = String(cover ?? "").trim();
  if (!mag || !tb) throw new Error("幅值或时间轴的 buffer 名没填");

  const query = {};
  if (since == null) {
    // 头一次：两个都只要最后一个值（裸键）
    query[mag] = null;
    query[tb] = null;
  } else {
    // 增量：幅值按时间轴做参照，时间轴按自己
    query[mag] = `${since}|${tb}`;
    query[tb] = since;
  }
  if (cb && cb !== mag && cb !== tb) query[cb] = null;

  const url = dollUrl(host, "/get", query);
  if (!url) throw new Error("手机地址没填");
  const data = await getJson(url, POLL_TIMEOUT);

  const status = data?.status ?? {};
  const bufOf = (name) => {
    const b = data?.buffer?.[name]?.buffer;
    return Array.isArray(b) ? b : [];
  };
  const mags = bufOf(mag);
  const times = bufOf(tb);

  /*
   * 按索引配对，取两边都有的那一段。
   *
   * phyphox 把 NaN 和 ±∞ 一律写成 `null`（文档管这叫 lossy），而且**不删**那些
   * 位置，就为了让多个 buffer 按索引对得上。所以这里只跳过 null，不重排。
   */
  const n = Math.min(mags.length, times.length);
  const samples = [];
  const from = n > MAX_SAMPLES ? n - MAX_SAMPLES : 0;
  for (let i = from; i < n; i++) {
    const t = times[i];
    const a = mags[i];
    if (typeof t !== "number" || typeof a !== "number") continue;
    if (!Number.isFinite(t) || !Number.isFinite(a)) continue;
    samples.push({ t, a: Math.abs(a) });
  }
  if (n > MAX_SAMPLES) {
    logDebug("共感娃娃", `这一跳回了 ${n} 个样本，只认最后 ${MAX_SAMPLES} 个`);
  }

  const coverVals = cb ? bufOf(cb) : [];
  const coverLast = coverVals.length ? coverVals[coverVals.length - 1] : null;

  return {
    session: String(status?.session ?? ""),
    measuring: Boolean(status?.measuring),
    samples,
    cover: typeof coverLast === "number" && Number.isFinite(coverLast) ? coverLast : null,
    last: samples.length ? samples[samples.length - 1].t : null,
  };
}

/**
 * 让手机那边开始测量。
 *
 * 用在「实验停着」的时候：用户把 phyphox 开着但没按播放，或者他自己点了停。
 * 回的 `{result:false}` 表示**被拒**（文档的例子是实验要的蓝牙设备没连上），
 * 不是出错 —— 所以这里只回布尔，由调用方决定要不要吭声。
 */
export async function startDollMeasuring(host) {
  const url = dollUrl(host, "/control", { cmd: "start" });
  if (!url) return false;
  try {
    const data = await getJson(url, PROBE_TIMEOUT);
    return Boolean(data?.result);
  } catch (e) {
    logDebug("共感娃娃", `让手机开始测量没成：${e?.message ?? e}`);
    return false;
  }
}

/**
 * 校准：连着读几秒，报这几秒里的峰值和均值。
 *
 * 面板上那个按钮背后就是它。为什么需要：那两个阈值（多大算「抱起来」、多小算
 * 「放下了」）跟手机型号、玩偶厚度、放的姿势都有关，纸上定不出来。用法是测
 * 两次 —— 玩偶放着不动测一次看**均值**（噪声底），抱着测一次看**峰值**，
 * 然后把「抱起来」填在两者之间。
 *
 * 第一跳只为了定起点：不然会把 buffer 里的历史全读回来，算出一个和这几秒
 * 毫无关系的峰值。
 *
 * 串行读、一跳一跳来：phyphox 那个服务器是单线程的（见文件头）。
 *
 * @returns {Promise<{seconds:number, samples:number, peak:number, avg:number,
 *   cover:{min:number,max:number}|null}>}
 * @throws {Error} 连不上、实验停着、一个样本都没读到（buffer 名多半不对）
 */
export async function calibrateDoll(host, { magnitude, time, cover = "", seconds = 6, intervalMs = 400 } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const first = await fetchDollSamples(host, { magnitude, time, cover });
  if (!first.measuring) throw new Error("手机上的实验停着，先在 phyphox 里点一下播放");

  let since = first.last;
  let peak = 0;
  let sum = 0;
  let count = 0;
  let coverMin = null;
  let coverMax = null;
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    await sleep(intervalMs);
    const page = await fetchDollSamples(host, { magnitude, time, cover, since });
    if (page.last != null) since = page.last;
    for (const s of page.samples) {
      if (s.a > peak) peak = s.a;
      sum += s.a;
      count += 1;
    }
    if (page.cover != null) {
      coverMin = coverMin == null ? page.cover : Math.min(coverMin, page.cover);
      coverMax = coverMax == null ? page.cover : Math.max(coverMax, page.cover);
    }
  }
  /*
   * 一个样本都没有 ≠ 连不上。最常见的是 buffer 名写对了、但那个 buffer 在
   * 这个实验里是空的（`/config` 里列着的大半是分析中间量）。这句话得把
   * 「名字可能不对」说出来，不然用户只会对着一个 0 发愣。
   */
  if (!count) throw new Error("这几秒一个样本都没读到：buffer 名可能不对，或者那个 buffer 在实验里是空的");

  return {
    seconds,
    samples: count,
    peak: Number(peak.toFixed(3)),
    avg: Number((sum / count).toFixed(4)),
    cover: coverMin == null ? null : { min: coverMin, max: coverMax },
  };
}

/* ================= 推送模式：手机自己 POST 过来 ================= */

/**
 * 推送那条路上，手机往哪个路径打。
 *
 * 写死不跟着配置走，理由和 spyphone.js 的 `/phone/battery` 一样：这个地址要
 * **抄进手机上的实验文件**里，少一个能填错的地方就少一处「怎么就是不响」。
 */
export const DOLL_PUSH_PATH = "/doll/hug";

/**
 * 解析手机 POST 过来的那包 JSON。
 *
 * phyphox 的 `http/post` 把每个 `<send id="…">` 变成 JSON 的一个键，buffer
 * **一律是数组**（哪怕只有一个值）。我们生成的实验文件里固定发三样：
 *
 *   {"acc": [0.1, 5.2, …], "t": [12.30, 12.35, …], "cover": [0]}
 *
 * `acc` 用的是传感器的 `abs` 分量（phyphox 自己算好的 √(x²+y²+z²)），所以
 * 这边不用再算一遍，也就不会和拉模式算出两种不一样的幅值。
 *
 * **宽进**：键名除了 `acc`/`t` 也认 `a`/`time`/`acc_time`，因为用户完全可能
 * 自己改实验文件。认不出来就报错，由调用方回 400 —— 静默吞掉的话，用户会
 * 对着一个「一直没反应」查上半天。
 *
 * @returns {{samples: Array<{t:number,a:number}>, cover: number|null}}
 * @throws {Error} 不是对象、找不到两个数组、长度对不上
 */
export function parseDollPush(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("收到的不是一个 JSON 对象");
  }
  const pick = (...names) => {
    for (const n of names) {
      const v = body[n];
      if (Array.isArray(v)) return v;
      // datatype="number" 的话是个裸数字，也认
      if (typeof v === "number" && Number.isFinite(v)) return [v];
    }
    return null;
  };
  const mags = pick("acc", "a", "magnitude", "abs");
  const times = pick("t", "time", "acc_time");
  if (!mags || !times) {
    throw new Error("这包数据里找不到 acc / t 两个数组（实验文件里的 send id 是不是改过？）");
  }

  const n = Math.min(mags.length, times.length);
  const from = n > MAX_SAMPLES ? n - MAX_SAMPLES : 0;
  const samples = [];
  for (let i = from; i < n; i++) {
    const t = times[i];
    const a = mags[i];
    // phyphox 把 NaN / ±∞ 写成 null，照例跳过那一对（见 fetchDollSamples）
    if (typeof t !== "number" || typeof a !== "number") continue;
    if (!Number.isFinite(t) || !Number.isFinite(a)) continue;
    samples.push({ t, a: Math.abs(a) });
  }

  const coverArr = pick("cover", "prox", "light");
  const coverLast = coverArr?.length ? coverArr[coverArr.length - 1] : null;
  return {
    samples,
    cover: typeof coverLast === "number" && Number.isFinite(coverLast) ? coverLast : null,
  };
}

/** 生成的实验文件里，隐私政策指向哪儿。phyphox 要求这个属性必须有。 */
const PRIVACY_URL = "https://github.com/nikonotnicotine/Uranus_Imessage";

/** XML 文本转义。地址里带 `&`（查询串）不转的话整个文件就废了。 */
const xmlEscape = (s) =>
  String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/**
 * 生成一个给手机装的 `.phyphox` 实验文件。
 *
 * ── 为什么非得我们生成 ──
 *
 * 「往外 POST」这件事只能写在**实验文件**里（`<network>` 块），phyphox 自带的
 * 那些实验都没有。而官方的网页编辑器**不支持网络连接**，只能手写 XML ——
 * 让用户自己照着 wiki 手搓一份、还要把地址和密钥填对，那是劝退。所以这边按
 * 他填的配置直接吐一个现成的，他点一下装到手机上就完事。
 *
 * ── 为什么密钥在查询串里 ──
 *
 * `<connection>` 不支持自定义请求头，能带出去的只有 URL。所以密钥只能写成
 * `?secret=…`。这也意味着**这个文件本身就是凭据**，生成时会提醒别外传。
 *
 * ── 几个定死的选择 ──
 *
 *  - `abs` 分量：phyphox 自己算 √(x²+y²+z²)，省得两条路算法不一致；
 *  - `keep="false"`：发完就清空 buffer，不然每次都把老样本重发一遍；
 *  - `conversion="none"`：我们回什么它都不解析。不设的话 phyphox 会试着把
 *    响应解析成数据写回 buffer，解析不了就在手机上弹「Could not parse JSON」；
 *  - 容量 = 采样率 × 间隔 × 3：网络抖一下、间隔漂一点都还装得下，不至于丢样本。
 *
 * @param {object} o
 * @param {string} o.url 手机要 POST 到的完整地址（含 ?secret=…）
 * @param {number} o.rate 采样率 Hz
 * @param {number} o.interval 多少秒推一次
 * @param {boolean} o.cover 要不要顺带采接近传感器
 * @returns {string} 一份完整的 .phyphox（XML）
 */
export function buildDollExperiment({ url, rate = 20, interval = 2, cover = false } = {}) {
  const hz = Math.min(Math.max(Number(rate) || 20, 1), 100);
  const sec = Math.min(Math.max(Number(interval) || 2, 1), 60);
  const size = Math.max(60, Math.ceil(hz * sec * 3));
  const addr = xmlEscape(url);

  const coverContainer = cover ? `\n    <container size="${size}">cover</container>` : "";
  const coverSend = cover ? `\n      <send id="cover" type="buffer" keep="false">cover</send>` : "";
  /*
   * 接近传感器用 `ignoreUnavailable`：不是每部手机都有（平板常常没有），
   * 没有的话整个实验就打不开了 —— 为一个可选信号搭上主功能不值得。
   */
  const coverSensor = cover
    ? `\n    <sensor type="proximity" rate="2" ignoreUnavailable="true">
      <output component="x">cover</output>
    </sensor>`
    : "";
  const coverView = cover
    ? `\n      <value label="遮挡（厘米，越小越说明被捂着）" size="1" precision="1">
        <input>cover</input>
      </value>`
    : "";

  return `<phyphox version="1.9" locale="zh">
  <title>共感娃娃</title>
  <category>Uranus</category>
  <icon>抱</icon>
  <description>把这部手机塞进玩偶里，抱一下，角色那边就会知道。

这个实验每 ${sec} 秒把这段时间的加速度推给你自己的 Uranus 后端，由它判断「抱起来 → 抱着 → 放下」。
数据只发往你自己填的那个地址，不经过任何第三方。

要点：phyphox 得开在前台（切后台会被系统暂停）；按下面的播放键开始。</description>
  <data-containers>
    <container size="${size}">acc</container>
    <container size="${size}">acc_time</container>${coverContainer}
  </data-containers>
  <network>
    <connection address="${addr}" autoConnect="true" service="http/post" interval="${sec}" privacy="${PRIVACY_URL}" conversion="none">
      <send id="acc" type="buffer" keep="false">acc</send>
      <send id="t" type="buffer" keep="false">acc_time</send>${coverSend}
    </connection>
  </network>
  <input>
    <sensor type="linear_acceleration" rate="${hz}">
      <output component="abs">acc</output>
      <output component="t">acc_time</output>
    </sensor>${coverSensor}
  </input>
  <views>
    <view label="共感娃娃">
      <value label="这一刻的加速度" size="2" precision="2" unit="m/s²">
        <input>acc</input>
      </value>${coverView}
      <graph label="抱一下看看波形" labelX="t (s)" labelY="a (m/s²)">
        <input axis="x">acc_time</input>
        <input axis="y">acc</input>
      </graph>
    </view>
  </views>
</phyphox>
`;
}

/* ================= 两步校准：替用户把阈值算出来 ================= */

/**
 * 一段读数的概况。校准两步各出一份。
 *
 * 除了峰值和均值，还要 p90 / p95：放着不动的那一段里偶尔会有一两个跳点
 * （有人从桌边走过、手机自己震了一下），只看峰值会把「还抱着」的线抬得太高。
 *
 * @param {number[]} values
 * @returns {{count:number, peak:number, avg:number, p90:number, p95:number}}
 */
export function summarizeCalib(values) {
  const v = (values ?? []).filter((x) => typeof x === "number" && Number.isFinite(x)).map(Math.abs);
  if (!v.length) return { count: 0, peak: 0, avg: 0, p90: 0, p95: 0 };
  const sorted = [...v].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const round = (x) => Number(x.toFixed(3));
  return {
    count: v.length,
    peak: round(sorted[sorted.length - 1]),
    avg: round(v.reduce((a, b) => a + b, 0) / v.length),
    p90: round(at(0.9)),
    p95: round(at(0.95)),
  };
}

/**
 * 从「放着不动」和「抱着」两段读数，算出那几个阈值。
 *
 * ── 为什么要有这个 ──
 *
 * 那几个数（多大算抱起来、多小算放下）跟手机型号、玩偶多厚、手机塞在哪儿都
 * 有关，纸上定不出来。以前让用户自己看峰值、均值去填 —— 实机上的回答是
 * 「我不懂物理也不懂这些数字是什么意思」，这完全合理。所以让他只做两件事
 * （放着、抱着），数字这边算。
 *
 * ── 怎么算 ──
 *
 *  - 「放着」的上沿取 max(p95, 峰值×0.6)：既不被一两个跳点拉高，也不至于
 *    把真实存在的晃动当没有；
 *  - **抱起来**：放在「放着的上沿」和「抱着的峰值」之间，靠下一点（40% 处）。
 *    靠下是因为真抱的时候不一定每次都像校准那次那么用力；
 *  - **还抱着**：放着的上沿再高一截，但不超过「抱起来」的一半 —— 不然
 *    「还抱着」和「抱起来」挤在一起，抱着稍微松一点就被判成放下；
 *  - **轻轻 / 用力**：按这次抱着的峰值往两边分；
 *  - **最短时长**降到 0.8 秒：校准过的阈值已经够挡住桌子的晃动了，
 *    不需要再靠「动够 1.5 秒」来防误触 —— 那道闸实机上把真抱也挡掉了
 *    （抱着不动时手机几乎不晃，算出来的时长就很短）。
 *
 * 两段分不开（抱着的峰值没比放着的上沿高多少）时照样给一组数，但 `ok`
 * 为假并说明原因 —— 多半是手机没塞紧、或者抱得太轻，校准这一步没测出区别。
 *
 * @returns {{ok:boolean, note:string, start:number, hold:number, soft:number,
 *            firm:number, minHoldMs:number}}
 */
export function suggestThresholds(still, hug) {
  const r2 = (x) => Number(Math.max(0.01, x).toFixed(2));
  const stillTop = Math.max(still?.p95 ?? 0, (still?.peak ?? 0) * 0.6, 0.02);
  const hugPeak = hug?.peak ?? 0;

  const gap = hugPeak - stillTop;
  const ok = hugPeak > stillTop * 1.5 && gap > 0.3;

  const start = ok ? stillTop + gap * 0.4 : Math.max(stillTop * 1.2, hugPeak * 0.7);
  /*
   * 「还抱着」必须压过放着时的**峰值**，不能只压过 p95。
   *
   * 判「放下了」要连续安静好几秒（默认 4 秒，20Hz 下是 80 个样本）。线要是
   * 只比 p95 高一点，放着的时候每 20 个样本里就有一个越线，80 个里几乎必然
   * 撞上一个 —— 于是永远等不到「安静够久」，正是实机上「一直卡着不结算」
   * 那个症状。所以取峰值再高两成；封顶在「抱起来」的一半，免得一个跳点
   * 把它顶得太高。
   */
  const hold = Math.min(Math.max((still?.peak ?? 0) * 1.2, stillTop * 1.5, 0.05), start * 0.5);
  const soft = start + Math.max(hugPeak - start, 0) * 0.5;
  const firm = Math.max(hugPeak * 1.3, soft + 0.5);

  return {
    ok,
    note: ok
      ? ""
      : `「放着」和「抱着」差别不大（放着最高 ${stillTop.toFixed(2)}，抱着最高 ${hugPeak.toFixed(2)}），` +
        "可能是手机没塞紧、或者这次抱得太轻。先照这组数试试，不灵的话把手机塞紧一点、抱的时候用点力，再校准一次",
    start: r2(start),
    hold: r2(hold),
    soft: r2(soft),
    firm: r2(firm),
    minHoldMs: 800,
  };
}

/* ================= 认出一次拥抱 ================= */

/**
 * 判定用的那几个数。单位：阈值是 m/s²（线性加速度），时间是毫秒。
 *
 * 默认值是按「手机塞在玩偶里、人把玩偶抱起来」估的：
 *
 *  - `start` 2.0 —— 抱起来那一下是个明显的尖峰，随手碰到桌子一般到不了 2；
 *  - `hold` 0.25 —— 抱着不动时只剩呼吸和体动那点动静（静止在桌上的噪声
 *    一般在 0.1 以下）。这个数是最容易要调的：太低会被桌子的振动骗着一直
 *    「抱着」，太高会把安安静静抱着当成已经放下；
 *  - `quietMs` 4000 —— 放下之后安静 4 秒算结束。短了会把「抱着换个姿势」
 *    切成两次拥抱；
 *  - `minHoldMs` 1500 —— 不到 1.5 秒的当碰了一下，不算抱。这是**防误触的
 *    主力**：搬玩偶、它从沙发上滑下来，都是一下一下的；
 *  - `maxHoldMs` 10 分钟 —— 封顶。手机装在包里走路会一路都是活跃样本，
 *    不封顶就永远结算不了。
 */
export const DOLL_DEFAULTS = {
  start: 2.0,
  hold: 0.25,
  quietMs: 4_000,
  minHoldMs: 1_500,
  maxHoldMs: 10 * 60_000,
  // 峰值低于 soft = 轻轻，soft~firm = 普通，firm 以上 = 用力（m/s²）
  soft: 4.0,
  firm: 10.0,
  // 遮挡 buffer 的值低于这个数算「被捂着」。接近传感器近是 0，光线传感器暗也是接近 0，
  // 两种都是「低于」，所以一个方向就够。
  coverBelow: 5.0,
};

/** 一个新的空状态。每条连接一份，存在 runner 上。 */
export function createDollState() {
  return {
    /** 手机上那个实验的 session。变了说明用户换了实验，状态全作废 */
    session: "",
    /** 上一次拿到的最后一个时间值（实验时间，秒）。null = 还没对上过 */
    since: null,
    /** 正在抱着吗 */
    holding: false,
    /** 这次拥抱从哪个时间点算起（实验时间，秒） */
    startT: 0,
    /** 最后一次「还有动静」的时间点（实验时间，秒） */
    activeT: 0,
    /** 这次拥抱里的峰值幅值 */
    peak: 0,
    /** 攒了几个活跃样本。太少的不算（防单点毛刺） */
    activeHits: 0,
    /** 上次试着让手机开始测量是什么时候 */
    lastStartTry: 0,
    /**
     * 连着几包都「整包都是旧数据」了。
     *
     * 推模式下这是**乱序**和**真的重来**唯一的区别：乱序只会坑一两包（下一包
     * 就又对上了），而用户在手机上清了空、或者换了份实验文件，那是**从此以后
     * 每一包**都比上次那个时间早。连着几包都旧 → 才是真的重来。
     */
    staleBatches: 0,
    /** 这一次拥抱里「抱得太久了」那句提醒说过没有（一次拥抱只说一次） */
    longWarned: false,
  };
}

/** 状态机重置（换实验、实验停了、时间轴倒退）。保留 lastStartTry，那是对手机的节流。 */
function resetDoll(state, session = "") {
  const tries = state.lastStartTry;
  Object.assign(state, createDollState(), { session, lastStartTry: tries });
}

/**
 * 把一把样本喂进状态机，吐出**这一把里结算完的拥抱**。
 *
 * 为什么是「喂一把」而不是「喂一个」：远程接口是拉的，一次拿回几十上百个样本，
 * 而判定全靠样本之间的**时间差**（安静了多久）—— 按把处理才拿得到那个差。
 *
 * 遮挡信号（`cover`）只影响「还抱着吗」这一问：被捂着的时候即使加速度已经
 * 低到阈值以下，也当成还抱着。它是**每跳一个值**（取最后一个），所以整把样本
 * 共用同一个判断，够了 —— 接近传感器本来也就几秒一个样本。
 *
 * @param {object} state createDollState() 的那个对象，原地改
 * @param {{session:string, measuring:boolean, samples:Array<{t:number,a:number}>, cover:number|null}} page
 * @param {object} opts DOLL_DEFAULTS 那几个数（调用方从配置里取好）
 * @returns {Array<{durationMs:number, peak:number}>} 这一把里结束的拥抱，通常是 0 或 1 个
 */
export function feedDollSamples(state, page, opts = DOLL_DEFAULTS) {
  const o = { ...DOLL_DEFAULTS, ...opts };
  const out = [];

  // 用户在手机上换了实验：缓存的 buffer 名可能已经不存在了，全部作废
  if (page.session && page.session !== state.session) {
    if (state.session) logInfo("共感娃娃", "手机上换了实验，重新开始认");
    resetDoll(state, page.session);
  }
  // 实验停着：这会儿 buffer 里是上一次测量的旧数据，不能当成刚发生的
  if (!page.measuring) {
    if (state.holding) logDebug("共感娃娃", "测量停了，这次没抱完的不算");
    resetDoll(state, state.session);
    return out;
  }

  let samples = page.samples ?? [];
  if (!samples.length) return out;

  /*
   * ── 时间轴往回走了，是哪一种？ ──
   *
   * 拉模式下只有一种可能：用户在手机上按了「清空」，实验时间归零。
   *
   * 推模式下还有第二种，而且常见得多：**同一批数据重来一遍，或者几包乱了序**。
   * 手机每隔两秒推一包，网络抖一下、或者服务端回得慢，几包就会挤在一起到，
   * 到达顺序还不一定是发出顺序。这时候要是当成「归零」，正在进行的那次拥抱
   * 会被整个丢掉 —— 实机日志里一秒钟刷四条「实验时间归零了」、抱了两次只认出
   * 一次，就是这么来的。
   *
   * 分辨方法：**真的重来是不可逆的**。用户清了空、或者换了份实验文件之后，
   * 从此每一包都比上次那个时间早；而乱序只坑一两包，下一包就又接上了。
   * 所以这里不急着推倒，先只把「已经见过的」滤掉；连着好几包整包都是旧的，
   * 才认定是真的重来。
   *
   * 另外给一条快车道：时间轴回到了 0 附近而之前已经跑了一会儿，那不可能是
   * 乱序（乱序顶多差几秒），直接认定重来，省得白等三包。
   */
  if (state.since != null) {
    const last = samples[samples.length - 1].t;
    const restarted = samples[0].t < 1 && state.since > 5;

    if (restarted || state.staleBatches >= STALE_BATCHES_MAX) {
      logInfo("共感娃娃", "手机那边的实验重新开始了（清空过或换了实验文件），重新开始认");
      resetDoll(state, state.session);
    } else if (last + 1e-9 < state.since) {
      // 整包都是旧的：多半是乱序或者重发。先放过，看下一包能不能接上
      state.staleBatches += 1;
      logDebug(
        "共感娃娃",
        `这一包整包都比上次早（${last.toFixed(2)} < ${state.since.toFixed(2)}），当成乱序跳过` +
          `（连着 ${state.staleBatches} 包了，到 ${STALE_BATCHES_MAX} 包就认定是重来）`
      );
      return out;
    } else if (samples[0].t + 1e-9 < state.since) {
      // 部分重叠：把已经见过的那截切掉，剩下的照常喂
      const fresh = samples.filter((s) => s.t > state.since);
      logDebug("共感娃娃", `这一包和上次重叠了 ${samples.length - fresh.length} 个样本，去掉重复的`);
      samples = fresh;
      state.staleBatches = 0;
    } else {
      state.staleBatches = 0;
    }
  }
  if (!samples.length) return out;

  const covered = page.cover != null && page.cover < o.coverBelow;

  for (const s of samples) {
    const active = s.a >= o.hold || covered;

    if (!state.holding) {
      // 还没开始：等一个够大的尖峰
      if (s.a >= o.start) {
        state.holding = true;
        state.startT = s.t;
        state.activeT = s.t;
        state.peak = s.a;
        state.activeHits = 1;
        state.longWarned = false;
        /*
         * 抱起来的那一刻就吭一声。以前要等**放下、结算完**才有第一条日志，
         * 于是「抱着的时候控制台一片安静」和「压根没收到数据」长得一模一样 ——
         * 实机上就这么被问过好几次「抱了没反应」。
         */
        logInfo("共感娃娃", `有动静了（晃动 ${s.a.toFixed(2)}），看看是不是一次拥抱…`);
      }
      state.since = s.t;
      continue;
    }

    if (s.a > state.peak) state.peak = s.a;
    if (active) {
      state.activeT = s.t;
      state.activeHits++;
    }
    state.since = s.t;

    const heldMs = (state.activeT - state.startT) * 1000;
    const quietMs = (s.t - state.activeT) * 1000;

    /*
     * 抱了半分钟还没结算，十有八九不是真抱了这么久，而是「还抱着」那个阈值
     * 比手机放着不动时的噪声还低 —— 于是放下了也一直算「还抱着」，要等十分钟
     * 封顶才结算，用户这期间看到的就是「抱完没反应」。说一次，把当下的数摆出来。
     */
    if (!state.longWarned && heldMs >= LONG_HOLD_WARN_MS) {
      state.longWarned = true;
      logWarn(
        "共感娃娃",
        `已经连续算「抱着」${Math.round(heldMs / 1000)} 秒了。要是其实早放下了，说明「还抱着算几」` +
          `（现在是 ${o.hold}）比手机放着不动时的晃动还低，放下了也一直结束不了 —— ` +
          `把它调高一点（这会儿读数大概在 ${s.a.toFixed(2)} 上下）`
      );
    }

    // 封顶：一直有动静（装在包里走路那种），到点先结算一次
    if (heldMs >= o.maxHoldMs) {
      out.push({ durationMs: Math.round(heldMs), peak: state.peak });
      resetDoll(state, state.session);
      state.since = s.t;
      continue;
    }

    // 安静够久了 = 放下了，结算
    if (quietMs >= o.quietMs) {
      /*
       * 太短的不算。两道闸：**抱着的时长**不到 minHoldMs，或者活跃样本少到
       * 可能只是一个毛刺（高采样率下一次真实的拥抱会有成百上千个活跃样本，
       * 这里只要求 3 个，纯粹是挡单点跳变）。
       */
      const hug = settleHold(state, o);
      if (hug) out.push(hug);
      state.since = s.t;
    }
  }

  // 整把都没进过状态机（比如一直在 idle）也要推进 since，不然下一跳会重复拿
  const lastT = samples[samples.length - 1].t;
  if (state.since == null || lastT > state.since) state.since = lastT;
  return out;
}

/**
 * 结算一次「抱着」：够格就返回那次拥抱，不够格就用人话说一声。两种都把状态清掉。
 *
 * 两处会走到这儿：样本里看到「安静够久了」（feedDollSamples），以及推送模式下
 * **手机不再发数据了**（flushSilentHold）。逻辑必须是同一份，不然两条路判出来
 * 的结果会不一样。
 *
 * @returns {{durationMs:number, peak:number} | null}
 */
function settleHold(state, o) {
  const heldMs = (state.activeT - state.startT) * 1000;
  let hug = null;
  /*
   * 太短的不算。两道闸：**抱着的时长**不到 minHoldMs，或者活跃样本少到
   * 可能只是一个毛刺（高采样率下一次真实的拥抱会有成百上千个活跃样本，
   * 这里只要求 3 个，纯粹是挡单点跳变）。
   */
  if (heldMs >= o.minHoldMs && state.activeHits >= 3) {
    hug = { durationMs: Math.round(heldMs), peak: state.peak };
  } else {
    /*
     * **用人话说，而且是 logInfo。** 以前这里是 debug 级别、一串术语：
     * 用户只看到一行「抱起来了」，之后再也没下文，以为是卡住了 ——
     * 其实那一下早就结束了，只是被判成「碰了一下」。实机上就这么卡过。
     */
    const sec = (heldMs / 1000).toFixed(1);
    const need = (o.minHoldMs / 1000).toFixed(1);
    logInfo(
      "共感娃娃",
      `刚才那一下不算抱：只持续了 ${sec} 秒（要 ${need} 秒以上才算），多半是拿起放下或者碰了一下。` +
        `要是你确实抱了却被这样判掉，去控制台「共感娃娃」里做一下两步校准`
    );
  }
  const keep = state.since;
  resetDoll(state, state.session);
  state.since = keep;
  return hug;
}

/**
 * 推送模式下，手机**不再发数据**了，但状态还停在「抱着」—— 就地结算。
 *
 * 判「放下了」靠的是**收到**几秒安静的样本。可用户抱完顺手点了 phyphox 的
 * 停止键、或者切了后台，后面就一包都不来了，于是那次拥抱永远等不到结算。
 * 实机上就是「抱完点右上角的停止，也还是没有反应」。
 *
 * 所以按墙上的钟算：最后一包是 `silentMs` 之前到的、而且还在「抱着」，
 * 就当是放下了。结算规则和平常完全一样（settleHold）。
 *
 * @param {number} lastPushAt 最后一包到达的时刻（Date.now() 口径）
 * @param {number} silentMs 多久没收到算「手机不发了」
 * @returns {{durationMs:number, peak:number} | null}
 */
export function flushSilentHold(state, opts, lastPushAt, silentMs, now = Date.now()) {
  if (!state.holding || !lastPushAt) return null;
  if (now - lastPushAt < silentMs) return null;
  const o = { ...DOLL_DEFAULTS, ...opts };
  logInfo("共感娃娃", "手机那边停了（不再发数据），把刚才那次当成已经放下来结算");
  return settleHold(state, o);
}

/**
 * 这一跳该不该再劝手机开始测量。
 *
 * 节流到 RESTART_EVERY_MS 一次，理由见那个常量的注释。
 */
export function shouldTryStart(state, now = Date.now()) {
  if (now - (state.lastStartTry || 0) < RESTART_EVERY_MS) return false;
  state.lastStartTry = now;
  return true;
}

/* ================= 说成人话 ================= */

/** 抱了多久 → 「3 秒」「1 分 20 秒」。给模型看的，所以不要小数点。 */
export function hugDuration(ms) {
  const sec = Math.max(1, Math.round(ms / 1000));
  if (sec < 60) return `${sec} 秒`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m} 分 ${s} 秒` : `${m} 分钟`;
}

/** 峰值 → 「轻轻地」「」「用力地」。普通那一档刻意给空串，见 renderHugLine。 */
export function hugStrength(peak, opts = DOLL_DEFAULTS) {
  const o = { ...DOLL_DEFAULTS, ...opts };
  if (peak < o.soft) return "轻轻";
  if (peak < o.firm) return "";
  return "用力";
}

/** 默认那句话。用户原话，一个字没动。 */
export const HUG_TEMPLATE_DEFAULT = "[系统提示:{{user}}抱了一下共感娃娃，你感受到了]";

/** 带时长和力度的那句，面板上「恢复默认」给的就是这个。 */
export const HUG_TEMPLATE_RICH =
  "[系统提示:{{user}}{{力度}}抱了一下共感娃娃，你感受到了，抱了{{时长}}{{次数}}]";

/**
 * 把模板拼成最终那句系统提示。
 *
 * 支持的占位符：
 *
 *  - `{{时长}}` → 「8 秒」
 *  - `{{力度}}` → 「轻轻」「用力」，普通力度是**空串**（「抱了一下」比
 *    「普通地抱了一下」像人话）
 *  - `{{次数}}` → 冷却期内攒下来的那几次，只有 ≥1 时才有内容
 *
 * `{{user}}` **留字面量**不替换 —— 由 prompt.js:applyVars 在拼提示词时才换，
 * 和 takeReactHints、takeBgHint 一个规矩。
 *
 * 模板里没写某个占位符就是不要那个信息（用户把文案改回只有一句话的那种）。
 */
export function renderHugLine(template, { durationMs = 0, peak = 0, times = 0, opts = DOLL_DEFAULTS } = {}) {
  const raw = String(template ?? "").trim() || HUG_TEMPLATE_RICH;
  const extra = times > 0 ? `，这之前还抱过 ${times} 次` : "";
  const line = raw
    .replaceAll("{{时长}}", hugDuration(durationMs))
    .replaceAll("{{力度}}", hugStrength(peak, opts))
    .replaceAll("{{次数}}", extra);
  /*
   * 力度那一档是空串，模板里又常写成「{{力度}}抱了一下」，拼完会留下
   * 「 抱了一下」这种多余空格 —— 收一下。中文句子里本来也不该有空格，
   * 但数字和单位之间的要留（「8 秒」），所以只挤连续空格、不全删。
   */
  return line.replace(/[ \t]{2,}/g, " ").replace(/([，。、：])\s+/g, "$1");
}
