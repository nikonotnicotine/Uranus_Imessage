/**
 * 离线自测：共感娃娃（doll.js）——「手机塞在玩偶里，抱一下角色就知道」。
 *
 * 测的三摊东西：
 *
 *  1. **地址和解析**（dollUrl / fetchDollSamples）。phyphox 的增量拉取靠
 *     `名字=阈值|参照` 那种查询串，而那根竖线**必须**是 %7C —— 拼错了的后果
 *     不是报错，是每次都从头拿一遍整个 buffer，于是「刚才的两百次晃动」会
 *     变成一次超长拥抱。这类错静默得很，所以要把查询串逐字对一遍。
 *     `fetch` 换成假的，**不打真手机**；
 *
 *  2. **状态机**（feedDollSamples）。这是整个功能的脑子：什么算抱起来、
 *     什么算还抱着、什么算放下、什么算碰了一下不算抱。全是纯函数，所以这里
 *     能把样本流一个个造出来喂进去，连手机都不用；
 *
 *  3. **配置规整**（normalizeDollApi / normalizeHug / saveConfig）。重点是
 *     手机那个内网地址**不许落进能分享出去的那份配置** —— 和 sovits 的地址
 *     一个道理，它整块只住密钥文件里。
 *
 * URANUS_DATA_DIR 指向临时目录，绝不碰真实的 data/。必须在 import 之前设好，
 * 所以下面全走动态 import。
 *
 * 跑：node scripts/test-doll.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "uranus-doll-"));
process.env.URANUS_DATA_DIR = TMP;

let pass = 0;
let fail = 0;
function check(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    pass += 1;
    console.log(`  ✓ ${name}`);
    return;
  }
  fail += 1;
  console.log(`  ✗ ${name}\n      得到 ${JSON.stringify(got)}\n      期望 ${JSON.stringify(want)}`);
}
function checkThat(name, cond, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? `  ${detail}` : ""}`);
  }
}

const {
  DOLL_DEFAULTS,
  DOLL_PUSH_PATH,
  HUG_TEMPLATE_RICH,
  buildDollExperiment,
  calibrateDoll,
  createDollState,
  dollUrl,
  feedDollSamples,
  fetchDollConfig,
  fetchDollSamples,
  guessDollBuffers,
  hugDuration,
  hugStrength,
  parseDollPush,
  renderHugLine,
  shouldTryStart,
  startDollMeasuring,
  suggestThresholds,
  summarizeCalib,
} = await import("../server/src/doll.js");

/* ================= 1. 地址 ================= */

console.log("\n地址怎么拼");
{
  check("只填 IP 和端口就补上 http", dollUrl("192.168.1.23:8080", "/config"), "http://192.168.1.23:8080/config");
  check("自己写了 http 就不动", dollUrl("http://10.0.0.5:8080", "/config"), "http://10.0.0.5:8080/config");
  check("地址没填回空串", dollUrl("", "/get"), "");
  check("填一串鬼画符也回空串，不抛", dollUrl("::::", "/get"), "");
  // iPhone 上 phyphox 默认就是 80，所以不写端口必须按 80 走（不能自作主张补 8080）
  check("不写端口 = 80（iPhone 的默认）", dollUrl("192.168.1.9", "/config"), "http://192.168.1.9/config");
  // 用户粘进来时很容易带上末尾的路径或斜杠，统统按我们要的那条路径覆盖掉
  check("地址里带的路径被覆盖掉", dollUrl("192.168.1.23:8080/", "/control"), "http://192.168.1.23:8080/control");

  /*
   * 这一条是整个文件里最要紧的断言之一：竖线必须是 %7C。
   * phyphox 文档明写了这件事，而拼错不会报错、只会静默退化成「每次全量」。
   */
  const u = dollUrl("1.2.3.4:8080", "/get", { acc: "12.5|acc_time", acc_time: 12.5 });
  checkThat("阈值里的竖线编码成 %7C", u.includes("acc=12.5%7Cacc_time"), u);
  checkThat("时间轴自己的阈值照原样带上", u.includes("acc_time=12.5"), u);

  // 裸键（只要最后一个值）写成 `名字=`，phyphox 两种都认空值
  const u2 = dollUrl("1.2.3.4:8080", "/get", { acc: null, acc_time: null, prox: null });
  checkThat("第一次拉：三个都是空值", /acc=&acc_time=&prox=/.test(u2), u2);
}

/* ================= 2. 拉样本（假 fetch） ================= */

console.log("\n拉样本怎么解析");

/** 装一个假的 fetch：记下被请求的 URL，回事先摆好的 JSON。 */
function fakeFetch(payload, { status = 200, body = null } = {}) {
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => (body === null ? payload : JSON.parse(body)),
    };
  };
  return seen;
}
const realFetch = globalThis.fetch;

{
  const page = {
    buffer: {
      acc: { size: 0, updateMode: "partial", buffer: [0.1, 2.5, 0.3] },
      acc_time: { size: 0, updateMode: "partial", buffer: [1.0, 1.01, 1.02] },
      prox: { size: 0, updateMode: "single", buffer: [0] },
    },
    status: { session: "s1", measuring: true, timedRun: false, countDown: 0 },
  };
  const seen = fakeFetch(page);
  const got = await fetchDollSamples("1.2.3.4:8080", {
    magnitude: "acc",
    time: "acc_time",
    cover: "prox",
    since: 0.99,
  });
  checkThat("增量拉取用时间轴当参照", seen[0].includes("acc=0.99%7Cacc_time"), seen[0]);
  checkThat("遮挡 buffer 只取最后一个值（裸键）", /prox=(&|$)/.test(seen[0]), seen[0]);
  check("样本按索引配对", got.samples, [
    { t: 1.0, a: 0.1 },
    { t: 1.01, a: 2.5 },
    { t: 1.02, a: 0.3 },
  ]);
  check("session 透出来", got.session, "s1");
  check("measuring 透出来", got.measuring, true);
  check("遮挡值取最后一个", got.cover, 0);
  check("last 是最后一个时间值（下一跳的 since）", got.last, 1.02);
}

{
  /*
   * phyphox 把 NaN 和 ±∞ 一律写成 null，而且**不删那个位置** —— 就为了让
   * 多个 buffer 按索引对得上。所以这里只能跳过那一对，绝不能重排或者补位。
   */
  const seen = fakeFetch({
    buffer: {
      acc: { buffer: [0.2, null, 3.1] },
      acc_time: { buffer: [2.0, 2.01, 2.02] },
    },
    status: { session: "s1", measuring: true },
  });
  const got = await fetchDollSamples("1.2.3.4:8080", { magnitude: "acc", time: "acc_time", since: 1.9 });
  check("null（NaN/∞）那一对跳过，别的不挪位", got.samples, [
    { t: 2.0, a: 0.2 },
    { t: 2.02, a: 3.1 },
  ]);
  checkThat("没配遮挡 buffer 时不往查询串里塞", !seen[0].includes("prox"), seen[0]);
}

{
  // 两个 buffer 长度不齐（iOS 那边偶尔多吐几个样本）：按短的那个截
  fakeFetch({
    buffer: { acc: { buffer: [1, 2, 3, 4] }, acc_time: { buffer: [5.0, 5.01] } },
    status: { session: "s1", measuring: true },
  });
  const got = await fetchDollSamples("1.2.3.4:8080", { magnitude: "acc", time: "acc_time", since: 4.9 });
  check("两边长度不齐时按短的截", got.samples.length, 2);
}

{
  // 幅值取绝对值：用户可能填了单轴 buffer（accX），那玩意儿是有正负的
  fakeFetch({
    buffer: { accX: { buffer: [-3.5] }, t: { buffer: [1.5] } },
    status: { session: "s1", measuring: true },
  });
  const got = await fetchDollSamples("1.2.3.4:8080", { magnitude: "accX", time: "t" });
  check("单轴的负值按绝对值算", got.samples, [{ t: 1.5, a: 3.5 }]);
}

{
  // 第一次拉（没有 since）：两个都只要最后一个值，不能把整个 buffer 读回来
  const seen = fakeFetch({
    buffer: { acc: { buffer: [0.4] }, acc_time: { buffer: [88.5] } },
    status: { session: "s1", measuring: true },
  });
  const got = await fetchDollSamples("1.2.3.4:8080", { magnitude: "acc", time: "acc_time", since: null });
  checkThat("第一次拉不带 full，也不带阈值", !seen[0].includes("full") && !seen[0].includes("%7C"), seen[0]);
  check("第一次拉只拿到一个样本，当起点", got.last, 88.5);
}

console.log("\n连不上的时候说人话");
{
  globalThis.fetch = async () => {
    const e = new TypeError("fetch failed");
    e.cause = { code: "ECONNREFUSED" };
    throw e;
  };
  let why = "";
  try {
    await fetchDollSamples("1.2.3.4:8080", { magnitude: "acc", time: "acc_time" });
  } catch (e) {
    why = String(e.message);
  }
  // 不许把「fetch failed」原样端给用户，那句话对排障毫无帮助
  checkThat("连接被拒 → 说到点子上（远程访问没开 / 端口不对）", /远程访问|端口/.test(why), why);
  checkThat("不许出现 fetch failed", !why.includes("fetch failed"), why);

  globalThis.fetch = async () => {
    const e = new Error("timed out");
    e.name = "TimeoutError";
    throw e;
  };
  try {
    await fetchDollSamples("1.2.3.4:8080", { magnitude: "acc", time: "acc_time" });
  } catch (e) {
    why = String(e.message);
  }
  checkThat("超时 → 提一句 phyphox 得在前台开着", /前台|息屏/.test(why), why);

  // phyphox 有几个端点出错时照样回 200，错误放在 {error:"…"} 里
  fakeFetch({ error: "buffer not found" });
  try {
    await fetchDollSamples("1.2.3.4:8080", { magnitude: "nope", time: "acc_time" });
    why = "（没抛）";
  } catch (e) {
    why = String(e.message);
  }
  check("200 里夹着 error 也算失败", why, "buffer not found");

  // 地址填成了别的服务：iOS 的 phyphox 对裸 /get 回 401，这儿要把话说明白
  fakeFetch({}, { status: 401 });
  try {
    await fetchDollSamples("1.2.3.4:8080", { magnitude: "acc", time: "acc_time" });
    why = "（没抛）";
  } catch (e) {
    why = String(e.message);
  }
  checkThat("401 提示「这地址像是别的服务」", why.includes("别的服务"), why);

  check("幅值/时间轴没填直接拦住", await (async () => {
    try {
      await fetchDollSamples("1.2.3.4:8080", { magnitude: "", time: "" });
      return "（没抛）";
    } catch (e) {
      return String(e.message);
    }
  })(), "幅值或时间轴的 buffer 名没填");
}

console.log("\n读手机上跑的是哪个实验");
{
  fakeFetch({
    crc32: "abc",
    title: "Acceleration without g",
    localTitle: "无重力加速度",
    category: "Mechanics",
    localCategory: "力学",
    buffers: [{ name: "acc", size: 0 }, { name: "accX", size: 0 }, { name: "acc_time", size: 0 }, { name: "tmp1", size: 10 }],
    inputs: [{ source: "linear_acceleration", outputs: [{ x: "accX" }] }],
    export: [
      {
        set: "Acceleration",
        sources: [
          { label: "Time (s)", buffer: "acc_time" },
          { label: "Absolute (m/s^2)", buffer: "acc" },
        ],
      },
    ],
  });
  const cfg = await fetchDollConfig("1.2.3.4:8080");
  check("实验名取当前语言那个", cfg.title, "无重力加速度");
  check("传感器列出来（给面板提示用）", cfg.sensors, ["linear_acceleration"]);
  check("export 那几组整理出来", cfg.exports[0].sources.length, 2);

  // 猜 buffer 名只是给面板填个默认值，猜错了用户自己改 —— 但常见实验得猜对
  const guess = guessDollBuffers(cfg);
  check("猜出幅值 buffer", guess.magnitude, "acc");
  check("猜出时间轴 buffer", guess.time, "acc_time");
  check("这个实验里没有遮挡传感器，猜空", guess.cover, "");

  const guess2 = guessDollBuffers({
    exports: [{ set: "Proximity", sources: [{ label: "Distance (cm)", buffer: "prox" }, { label: "Time (s)", buffer: "prox_time" }] }],
  });
  check("有接近传感器时猜成遮挡 buffer", guess2.cover, "prox");
}

console.log("\n替用户按一下「开始」");
{
  const seen = fakeFetch({ result: true });
  check("start 成功", await startDollMeasuring("1.2.3.4:8080"), true);
  checkThat("打的是 /control?cmd=start", seen[0].includes("/control?cmd=start"), seen[0]);
  // phyphox 文档：result:false 是「被拒」（比如实验要的蓝牙设备没连上），不是出错
  fakeFetch({ result: false });
  check("被拒就是 false，不抛", await startDollMeasuring("1.2.3.4:8080"), false);
  globalThis.fetch = async () => {
    throw new Error("boom");
  };
  check("连不上也只回 false（这条路不该把心跳搞崩）", await startDollMeasuring("1.2.3.4:8080"), false);
}
globalThis.fetch = realFetch;

/* ================= 3. 状态机 ================= */

console.log("\n什么算一次拥抱");

/**
 * 造一段样本流。
 *
 * @param t0 起始的实验时间（秒）
 * @param dt 采样间隔（秒）
 * @param vals 幅值序列
 */
function flow(t0, dt, vals) {
  return vals.map((a, i) => ({ t: +(t0 + i * dt).toFixed(4), a }));
}
/** 一段「安静」：n 个几乎为零的样本。静止在桌上的噪声大概就是这个量级。 */
const quiet = (n) => Array.from({ length: n }, () => 0.03);
/** 一段「抱着」：n 个刚过活跃阈值的样本（呼吸、体动） */
const held = (n) => Array.from({ length: n }, () => 0.5);

const 跑一遍 = (state, samples, extra = {}, opts = DOLL_DEFAULTS) =>
  feedDollSamples(state, { session: "s1", measuring: true, samples, cover: null, ...extra }, opts);

{
  // 一次像样的拥抱：抱起来那一下 5.0，然后抱着 3 秒，然后放下安静 5 秒
  const st = createDollState();
  // 50Hz：0.02 秒一个样本
  let out = 跑一遍(st, flow(0, 0.02, [...quiet(50), 5.0, ...held(150)]));
  check("抱着的时候还不结算", out.length, 0);
  checkThat("状态是「抱着」", st.holding);

  out = 跑一遍(st, flow(4.02, 0.02, quiet(300))); // 安静 6 秒
  check("放下之后结算一次", out.length, 1);
  // 抱起来那一下在 t=1.0，最后一个活跃样本在 1.0+150*0.02=4.0 → 3 秒
  checkThat("时长约 3 秒", Math.abs(out[0].durationMs - 3000) < 100, `${out[0].durationMs}ms`);
  check("峰值是抱起来那一下", out[0].peak, 5.0);
  checkThat("结算完回到空闲", !st.holding);
}

{
  // 碰了一下：一个尖峰之后立刻安静 —— 搬玩偶、它从沙发上滑下来，都是这样
  const st = createDollState();
  const out = 跑一遍(st, flow(0, 0.02, [...quiet(20), 6.0, ...quiet(300)]));
  check("碰一下不算抱（时长不够 minHoldMs）", out.length, 0);
  checkThat("也不留在「抱着」状态里", !st.holding);
}

{
  // 毛刺：单个样本跳到很高，下一个就回零。活跃样本不够 3 个，不算
  const st = createDollState();
  const out = 跑一遍(st, flow(0, 0.5, [0.02, 9.9, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02]));
  check("单点毛刺不算抱", out.length, 0);
}

{
  // 没到「抱起来」那个阈值的持续晃动（桌子在震）：不该开始
  const st = createDollState();
  const out = 跑一遍(st, flow(0, 0.02, Array.from({ length: 400 }, () => 1.0)));
  check("够不到 start 阈值的晃动不算抱起来", out.length, 0);
  checkThat("状态仍然是空闲", !st.holding);
}

{
  // 抱着换个姿势：中间安静 2 秒（短于 quietMs 的 4 秒）→ 还是一次拥抱，不该切成两次
  const st = createDollState();
  let out = 跑一遍(st, flow(0, 0.02, [4.0, ...held(100), ...quiet(100), ...held(100)]));
  check("中间安静 2 秒不切断", out.length, 0);
  out = 跑一遍(st, flow(6.02, 0.02, quiet(300)));
  check("最后放下才算完", out.length, 1);
  checkThat("时长把中间那段算进去（约 6 秒）", Math.abs(out[0].durationMs - 6000) < 200, `${out[0].durationMs}ms`);
}

{
  /*
   * 遮挡 buffer 的作用：抱着不动的时候线性加速度几乎是 0，光看加速度会以为
   * 放下了。接近传感器被捂着（0 < coverBelow）时就当「还抱着」。
   */
  const st = createDollState();
  let out = 跑一遍(st, flow(0, 0.02, [4.0, ...held(50)]), { cover: 0 });
  checkThat("抱起来了", st.holding);
  // 安静 10 秒，但一直被捂着
  out = 跑一遍(st, flow(1.02, 0.02, quiet(500)), { cover: 0 });
  check("被捂着的时候，安静也不算放下", out.length, 0);
  // 一松手，接近传感器读数跳远
  out = 跑一遍(st, flow(11.02, 0.02, quiet(300)), { cover: 100 });
  check("松手之后结算", out.length, 1);
  checkThat("时长把「抱着不动」那 10 秒算进去", out[0].durationMs > 10_000, `${out[0].durationMs}ms`);
}

{
  // 封顶：一直有动静（手机装在包里走路）。不封顶就永远结算不了
  const st = createDollState();
  const 很多 = flow(0, 0.1, [5.0, ...held(7_000)]); // 700 秒 > maxHoldMs 的 600 秒
  const out = 跑一遍(st, 很多);
  check("超过封顶先结算一次", out.length, 1);
  checkThat("结算出来的时长就是封顶那么长", out[0].durationMs >= DOLL_DEFAULTS.maxHoldMs, `${out[0].durationMs}ms`);
}

console.log("\n两步校准：替用户算阈值");
{
  check("空读数", summarizeCalib([]).count, 0);
  const sum = summarizeCalib([0.1, 0.2, 0.3, -0.4, null, NaN]);
  check("负数按绝对值、非数跳过", sum.count, 4);
  check("峰值", sum.peak, 0.4);

  /*
   * 用实机日志里那位用户的读数：放在桌上的晃动很小，抱起来那一下在
   * 2~3.4 之间（日志里一串「抱起来了（这一下 2.02 / 2.34 / 3.38）」），
   * 抱住之后手机几乎不动 —— 默认阈值下全被判成「不算抱」。
   */
  const still = summarizeCalib(Array.from({ length: 160 }, (_, i) => (i % 40 === 0 ? 0.09 : 0.03)));
  const hug = summarizeCalib([3.38, 2.3, 2.72, ...Array.from({ length: 100 }, () => 0.6)]);
  const s = suggestThresholds(still, hug);
  check("分得开 → ok", s.ok, true);
  checkThat("「抱起来」在放着的峰值之上", s.start > still.peak, JSON.stringify(s));
  checkThat("「抱起来」在抱着的峰值之下（不然真抱也够不着）", s.start < hug.peak, JSON.stringify(s));
  // 判「放下了」要连续安静好几秒：线要是低于放着时的峰值，永远等不到安静够久
  checkThat("「还抱着」压过放着时的峰值", s.hold > still.peak, JSON.stringify(s));
  checkThat("「还抱着」不超过「抱起来」的一半", s.hold <= s.start * 0.5 + 1e-9, JSON.stringify(s));
  checkThat("轻轻 < 用力", s.soft < s.firm, JSON.stringify(s));
  check("最短时长降到 0.8 秒", s.minHoldMs, 800);

  // 用校准出来的数，喂一次「抱住之后不太动」的拥抱 —— 实机上正是这种被判掉了
  const st = createDollState();
  const opts = { ...DOLL_DEFAULTS, ...s };
  跑一遍(st, flow(0, 0.05, [...quiet(20), 3.38, ...Array.from({ length: 20 }, () => 0.6)]), {}, opts);
  const out = 跑一遍(st, flow(2.1, 0.05, quiet(100)), {}, opts);
  check("用校准过的阈值，同样那一抱认出来了", out.length, 1);

  // 两段分不开：照样给数，但 ok=false 并说明
  const bad = suggestThresholds(summarizeCalib([0.5, 0.6]), summarizeCalib([0.7]));
  check("分不开 → ok=false", bad.ok, false);
  checkThat("并且说明了原因", bad.note.includes("差别不大"), bad.note);
}

console.log("\n「还抱着」阈值比噪声低时要提醒");
{
  /*
   * 手机放着不动的晃动高过「还抱着」那个阈值，放下了也一直结束不了，要等十分钟
   * 封顶 —— 用户看到的就是「抱完没反应」。抱了半分钟还没结算就提醒一次。
   */
  const st = createDollState();
  跑一遍(st, flow(0, 0.1, [5.0, ...held(200)])); // 20 秒
  check("20 秒时还没提醒", st.longWarned, false);
  跑一遍(st, flow(20.1, 0.1, held(150))); // 再 15 秒，过了 30 秒
  check("过了 30 秒提醒一次", st.longWarned, true);
  checkThat("仍然算抱着（只是提醒，不擅自结算）", st.holding);
}

console.log("\n手机那头变了的时候");
{
  // 用户在手机上换了实验：buffer 名可能已经不存在了，状态全作废
  const st = createDollState();
  跑一遍(st, flow(0, 0.02, [4.0, ...held(100)]));
  checkThat("先抱着", st.holding);
  const out = feedDollSamples(st, { session: "换了", measuring: true, samples: flow(0, 0.02, quiet(10)), cover: null }, DOLL_DEFAULTS);
  check("换实验之后那次不结算（直接作废）", out.length, 0);
  check("session 跟着换", st.session, "换了");
  checkThat("不再是抱着", !st.holding);
}

{
  // 实验停了：buffer 里是上一次测量的旧数据，不能当成刚发生的
  const st = createDollState();
  跑一遍(st, flow(0, 0.02, [4.0, ...held(100)]));
  const out = feedDollSamples(st, { session: "s1", measuring: false, samples: flow(0, 0.02, quiet(10)), cover: null }, DOLL_DEFAULTS);
  check("测量停了就不认了", out.length, 0);
  check("since 也清掉（下次从最后一个值重新对起点）", st.since, null);
}

{
  // 用户在手机上按了「清空」：实验时间归零。按老的 since 增量取会一个都拿不到
  const st = createDollState();
  跑一遍(st, flow(100, 0.02, [4.0, ...held(100)]));
  checkThat("先抱着", st.holding);
  const out = 跑一遍(st, flow(0, 0.02, quiet(10))); // 时间倒退到 0 附近 = 真的重来
  check("时间归零之后推倒重来，不凭空结算一次", out.length, 0);
  checkThat("不再是抱着", !st.holding);
}

console.log("\n推模式下乱序和重发不能当成「重来」");
{
  /*
   * 这一节钉的是一个实机踩到的坑：推模式下服务端回得慢（递送拥抱 = 一整轮
   * 模型调用，十几秒），手机每两秒推一包，于是几包挤在一起到、顺序还乱了。
   * 以前只要时间往回走一点就当「用户清空了实验」，把正在进行的拥抱整个丢掉
   * —— 日志里一秒刷四条「实验时间归零了」，抱两次只认出一次。
   */
  const st = createDollState();
  // 抱起来，正抱着
  跑一遍(st, flow(10, 0.02, [5.0, ...held(100)]));
  checkThat("先抱着", st.holding);
  const sinceBefore = st.since;

  // 一包迟到的旧数据插进来（整包都比上次早）
  const out = 跑一遍(st, flow(8, 0.02, held(20)));
  check("乱序的旧包不结算", out.length, 0);
  checkThat("**不该**把它当成重来，还抱着", st.holding);
  check("since 不被旧包拉回去", st.since, sinceBefore);
  check("记了一次「整包都旧」", st.staleBatches, 1);

  // 下一包正常接上 → 计数清零，拥抱继续
  跑一遍(st, flow(12.05, 0.02, held(50)));
  checkThat("正常包接上之后还抱着", st.holding);
  check("「整包都旧」的计数清零", st.staleBatches, 0);

  // 放下，照样结算得出来（这才是乱序容忍的意义：那次拥抱没被丢）
  const done = 跑一遍(st, flow(13.1, 0.02, quiet(300)));
  check("乱序插了一包也不影响最后结算", done.length, 1);
  checkThat("时长按最后一个活跃样本算", done[0].durationMs >= 2_000, `${done[0].durationMs}ms`);
}

{
  // 部分重叠（重发了一截）：去掉见过的，剩下的照常喂，别整包丢
  const st = createDollState();
  跑一遍(st, flow(0, 0.02, quiet(50)));
  const since = st.since;
  /*
   * 从 since 之前一点开始重发，后面接上新数据。
   *
   * 尖峰要落在 since **之后**：去重是严格的 `t > since`，正好压在边界上的
   * 那个样本会被当成「见过了」切掉 —— 这里 0.88 + 20×0.02 = 1.28 > 0.98，
   * 稳稳在新的那一段里。
   */
  const out = 跑一遍(st, flow(since - 0.1, 0.02, [...quiet(20), 5.0, ...held(100)]));
  check("重叠的包不结算（还抱着）", out.length, 0);
  checkThat("里面那段新数据照样认出了抱起来", st.holding);
  checkThat("since 往前推了", st.since > since);
}

{
  // 真的重来（但时间不是从 0 开始，快车道判据不命中）：连着几包都旧才认
  const st = createDollState();
  跑一遍(st, flow(100, 0.02, [5.0, ...held(100)]));
  checkThat("先抱着", st.holding);
  // 连着三包都是旧的
  跑一遍(st, flow(50, 0.02, quiet(10)));
  跑一遍(st, flow(50.5, 0.02, quiet(10)));
  check("前两包只是记账，不推倒", st.holding, true);
  check("记到 2 了", st.staleBatches, 2);
  跑一遍(st, flow(51, 0.02, quiet(10)));
  check("第三包记到 3", st.staleBatches, 3);
  // 第四包时达到阈值 → 认定重来
  跑一遍(st, flow(51.5, 0.02, quiet(10)));
  checkThat("连着旧够多包之后认定是重来，状态推倒", !st.holding);
  check("计数跟着清零", st.staleBatches, 0);
}

{
  // 空的一跳（网络抖了一下，什么都没拿到）：状态别被动到
  const st = createDollState();
  跑一遍(st, flow(0, 0.02, [4.0, ...held(100)]));
  const before = { ...st };
  const out = 跑一遍(st, []);
  check("空样本不结算", out.length, 0);
  check("空样本不动状态", st.holding, before.holding);
  check("空样本不动 since", st.since, before.since);
}

{
  // since 要一直往前推：哪怕整把样本都在空闲状态下划过，也不能原地踏步，
  // 不然下一跳会把同一批样本再拿一遍
  const st = createDollState();
  跑一遍(st, flow(10, 0.02, quiet(50)));
  checkThat("空闲状态下 since 也跟着推到最后一个样本", Math.abs(st.since - (10 + 49 * 0.02)) < 1e-6, String(st.since));
}

console.log("\n劝手机开始测量要节流");
{
  const st = createDollState();
  check("第一次该试", shouldTryStart(st, 1_000_000), true);
  check("紧接着不该再试", shouldTryStart(st, 1_000_000 + 5_000), false);
  check("过了 30 秒可以再试", shouldTryStart(st, 1_000_000 + 31_000), true);
}

/* ================= 4. 那句系统提示 ================= */

console.log("\n那句话怎么拼");
{
  check("时长：不到一分钟说秒", hugDuration(8_400), "8 秒");
  check("时长：整分钟不带零秒", hugDuration(120_000), "2 分钟");
  check("时长：带零头", hugDuration(80_000), "1 分 20 秒");
  check("时长：最少一秒（不说 0 秒）", hugDuration(200), "1 秒");

  check("力度：轻", hugStrength(2), "轻轻");
  // 普通那一档刻意给空串 —— 「抱了一下」比「普通地抱了一下」像人话
  check("力度：普通是空串", hugStrength(6), "");
  check("力度：用力", hugStrength(20), "用力");

  const line = renderHugLine(HUG_TEMPLATE_RICH, { durationMs: 8_000, peak: 20, times: 0 });
  check(
    "带时长和力度的默认文案",
    line,
    "[系统提示:{{user}}用力抱了一下共感娃娃，你感受到了，抱了8 秒]"
  );
  // {{user}} 必须留字面量：由 prompt.js:applyVars 在拼提示词时才替换
  checkThat("{{user}} 留着不替换", line.includes("{{user}}"));

  // 普通力度那一档是空串，模板里又写着「{{力度}}抱了一下」，拼完不许留下多余空格
  const 普通 = renderHugLine(HUG_TEMPLATE_RICH, { durationMs: 3_000, peak: 6, times: 0 });
  checkThat("力度是空串时不留多余空格", !/\s抱了一下/.test(普通) && !普通.includes("  "), 普通);

  const 攒了 = renderHugLine(HUG_TEMPLATE_RICH, { durationMs: 3_000, peak: 6, times: 4 });
  checkThat("冷却期里攒的次数带上", 攒了.includes("这之前还抱过 4 次"), 攒了);
  checkThat("没攒就不提次数", !renderHugLine(HUG_TEMPLATE_RICH, { times: 0 }).includes("这之前"), "");

  // 用户把文案改成只有一句话：没写的占位符就是不要那个信息
  check(
    "文案里不写占位符就只有那一句",
    renderHugLine("[系统提示:{{user}}抱了一下共感娃娃，你感受到了]", { durationMs: 9_000, peak: 20, times: 3 }),
    "[系统提示:{{user}}抱了一下共感娃娃，你感受到了]"
  );
  // 空文案回落到默认，别发一句空的出去
  checkThat("文案留空时回落到默认那句", renderHugLine("", { durationMs: 1_000 }).includes("共感娃娃"));
}

/* ================= 4.5 推送模式：手机自己 POST 过来 ================= */

console.log("\n推过来的那包数据怎么解析");
{
  // phyphox 的 http/post：每个 send id 一个键，buffer 一律是数组
  const got = parseDollPush({ acc: [0.1, 5.2, 0.3], t: [1.0, 1.05, 1.1] });
  check("按索引配对", got.samples, [
    { t: 1.0, a: 0.1 },
    { t: 1.05, a: 5.2 },
    { t: 1.1, a: 0.3 },
  ]);
  check("没有遮挡就是 null", got.cover, null);

  check("遮挡取最后一个值", parseDollPush({ acc: [1], t: [1], cover: [5, 0] }).cover, 0);
  // 用户可能自己改实验文件，键名宽进
  check("认 a / time 这种写法", parseDollPush({ a: [2], time: [9] }).samples, [{ t: 9, a: 2 }]);
  // datatype="number" 的话是个裸数字
  check("裸数字也认", parseDollPush({ acc: 3.5, t: 7 }).samples, [{ t: 7, a: 3.5 }]);
  // null = NaN/±∞，跳过那一对但不挪位
  check("null 那一对跳过", parseDollPush({ acc: [1, null, 3], t: [1, 2, 3] }).samples, [
    { t: 1, a: 1 },
    { t: 3, a: 3 },
  ]);
  check("两边长度不齐按短的截", parseDollPush({ acc: [1, 2, 3], t: [1] }).samples.length, 1);
  check("负值取绝对值", parseDollPush({ acc: [-4], t: [1] }).samples, [{ t: 1, a: 4 }]);

  const 报错 = (body) => {
    try {
      parseDollPush(body);
      return "（没抛）";
    } catch (e) {
      return String(e.message);
    }
  };
  checkThat("键名对不上时点明是 send id 的问题", /send id/.test(报错({ foo: [1] })), 报错({ foo: [1] }));
  check("不是对象就直说", 报错("哈"), "收到的不是一个 JSON 对象");
  check("数组也不行", 报错([1, 2]), "收到的不是一个 JSON 对象");
}

console.log("\n生成给手机装的实验文件");
{
  const xml = buildDollExperiment({
    url: "https://chat.example.com/doll/hug?secret=abc123",
    rate: 20,
    interval: 2,
  });

  /*
   * 这份文件是**给另一个程序吃的**，格式错一个字符手机上就打不开，而那时
   * 用户完全不知道错在哪。所以这里逐条钉住 phyphox 要求的那几样。
   */
  checkThat("根元素带 version 和 locale", /^<phyphox version="[\d.]+" locale="\w+">/.test(xml.trim()), xml.slice(0, 60));
  checkThat("有 privacy（phyphox 要求必须有）", /privacy="https?:\/\/[^"]+"/.test(xml));
  checkThat("走的是 http/post", xml.includes('service="http/post"'));
  checkThat("地址原样进去了", xml.includes("https://chat.example.com/doll/hug?secret=abc123".replace("&", "&amp;")));
  checkThat("发完就清空 buffer（不然每次重发老样本）", /keep="false"/.test(xml));
  checkThat("不解析响应（不然手机上会弹 Could not parse JSON）", xml.includes('conversion="none"'));
  checkThat("用传感器自带的 abs 分量", xml.includes('component="abs"'));
  checkThat("用的是去掉重力的那个传感器", xml.includes('type="linear_acceleration"'));
  checkThat("采样率进去了", xml.includes('rate="20"'));
  checkThat("推送间隔进去了", xml.includes('interval="2"'));

  /*
   * 容量得装得下 采样率 × 间隔，而且要有富余 —— 网络抖一下这包没发出去，
   * 下一个周期要装两倍的量，容量不够的话最老的那些就被挤掉了。
   */
  const size = Number(/<container size="(\d+)">acc<\/container>/.exec(xml)?.[1]);
  checkThat("容量比「一个周期的样本数」宽裕", size >= 20 * 2 * 2, String(size));

  // 地址里的 & 必须转义，否则整个 XML 废掉（查询串里有 & 是常事）
  const 带与号 = buildDollExperiment({ url: "http://1.2.3.4:8787/doll/hug?secret=a&b=c" });
  checkThat("地址里的 & 转义成 &amp;", 带与号.includes("secret=a&amp;b=c"), 带与号.match(/address="[^"]*"/)?.[0]);
  checkThat("转义之后不留裸 &", !/address="[^"]*&(?!amp;|lt;|gt;|quot;)/.test(带与号));

  // 没要遮挡时不该冒出 proximity 的块
  checkThat("默认不采接近传感器", !带与号.includes("proximity"));
  const 带遮挡 = buildDollExperiment({ url: "http://x/y", cover: true });
  checkThat("要了就有 proximity", 带遮挡.includes('type="proximity"'));
  checkThat("接近传感器要 ignoreUnavailable（没有的机器也得能打开）", 带遮挡.includes('ignoreUnavailable="true"'));
  checkThat("遮挡也跟着发出去", /<send id="cover"/.test(带遮挡));

  // 真的是一份能解析的 XML —— 标签配对、属性引号闭合
  const { XMLParser, XMLValidator } = await import("fast-xml-parser").catch(() => ({}));
  if (XMLValidator) {
    check("是合法 XML", XMLValidator.validate(xml), true);
    const doc = new XMLParser({ ignoreAttributes: false }).parse(xml);
    check("解析出来根节点是 phyphox", Object.keys(doc).includes("phyphox"), true);
  } else {
    /*
     * 这个项目没装 XML 解析库，那就退而求其次自己数一遍标签配对 ——
     * 「生成的 XML 是歪的」是这段代码最可能出的错，不能一点都不验。
     */
    const opens = [...xml.matchAll(/<([a-zA-Z-]+)(\s[^>]*?)?(\/?)>/g)].filter((m) => m[3] !== "/").map((m) => m[1]);
    const closes = [...xml.matchAll(/<\/([a-zA-Z-]+)>/g)].map((m) => m[1]);
    const 栈 = [];
    let 配对 = true;
    for (const m of xml.matchAll(/<(\/?)([a-zA-Z-]+)(\s[^>]*?)?(\/?)>/g)) {
      const [, 闭, 名, , 自闭] = m;
      if (自闭 === "/") continue;
      if (闭) {
        if (栈.pop() !== 名) 配对 = false;
      } else 栈.push(名);
    }
    checkThat("标签全部配对", 配对 && 栈.length === 0, `还剩 ${栈.join(" > ")}`);
    check("开合标签数量一致", opens.length, closes.length);
    checkThat("属性引号成双", (xml.match(/"/g) ?? []).length % 2 === 0);
  }
}

/* ================= 5. 对着一台假 phyphox 跑真 HTTP ================= */

/*
 * 上面那些用的是假 fetch —— 查询串拼得对不对看得很清楚，但**真的 fetch 会不会
 * 这么发**它证明不了。这一节起一台假 phyphox（node:http），让 doll.js 用真
 * fetch 打过去：URLSearchParams 到底编成了什么、服务端解出来的 query 长什么样、
 * 超时和 ECONNREFUSED 的真实形态，都在这儿过一遍。
 */
console.log("\n对着一台假 phyphox 跑真 HTTP");
{
  const http = await import("node:http");

  /*
   * 一台会「动」的假手机。
   *
   * **样本得按真实时间往 buffer 里攒**，不能在 /get 的时候拿当前的幅值函数
   * 回填一段历史 —— 那样「抱起来那一下尖峰」会被后来的值抹掉，和真的 phyphox
   * 行为也不一样（它是传感器来一个就存一个）。这里 50Hz 攒着，/get 按时间切片，
   * 和真机一个形状。
   */
  let 幅值 = () => 0.03;
  let measuring = true;
  const t0 = Date.now();
  const 问过的 = [];
  const 样本表 = [];
  const 采样 = setInterval(() => {
    const t = (Date.now() - t0) / 1000;
    样本表.push({ t: +t.toFixed(4), a: 幅值(t) });
  }, 20);
  采样.unref?.();

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    问过的.push({ path: u.pathname, query: Object.fromEntries(u.searchParams) });
    res.setHeader("Content-Type", "application/json");

    if (u.pathname === "/config") {
      res.end(
        JSON.stringify({
          crc32: "deadbeef",
          title: "Acceleration without g",
          localTitle: "Acceleration without g",
          category: "Mechanics",
          localCategory: "Mechanics",
          buffers: [{ name: "acc", size: 0 }, { name: "acc_time", size: 0 }],
          inputs: [{ source: "linear_acceleration", outputs: [{ x: "accX" }] }],
          export: [
            {
              set: "Acceleration",
              sources: [
                { label: "Time (s)", buffer: "acc_time" },
                { label: "Absolute (m/s^2)", buffer: "acc" },
              ],
            },
          ],
        })
      );
      return;
    }
    if (u.pathname === "/control") {
      if (u.searchParams.get("cmd") === "start") measuring = true;
      res.end(JSON.stringify({ result: true }));
      return;
    }
    if (u.pathname === "/get") {
      const since = u.searchParams.get("acc_time");
      /*
       * 空值（裸键）= 只要最后一个值；有数 = 从那之后的所有值。
       * 真的 phyphox 还会把阈值抬一个 ULP 免得重发已经给过的那个，这里用
       * 严格大于，效果一样。
       */
      const 样本 = since ? 样本表.filter((s) => s.t > Number(since)) : 样本表.slice(-1);
      res.end(
        JSON.stringify({
          buffer: {
            acc: { size: 0, updateMode: since ? "partial" : "single", buffer: 样本.map((s) => s.a) },
            acc_time: { size: 0, updateMode: since ? "partial" : "single", buffer: 样本.map((s) => s.t) },
          },
          status: { session: "fake-1", measuring, timedRun: false, countDown: 0 },
        })
      );
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "no such endpoint" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const host = `127.0.0.1:${server.address().port}`;

  const cfg = await fetchDollConfig(host);
  check("真 HTTP：读到实验名", cfg.title, "Acceleration without g");
  check("真 HTTP：猜出幅值 buffer", guessDollBuffers(cfg).magnitude, "acc");

  // 第一跳：裸键，服务端那边收到的应该是空字符串
  const 第一跳 = await fetchDollSamples(host, { magnitude: "acc", time: "acc_time" });
  check("真 HTTP：第一跳服务端收到空值", 问过的.at(-1).query.acc, "");
  checkThat("真 HTTP：第一跳拿到了起点", 第一跳.last != null, String(第一跳.last));

  /*
   * 第二跳带阈值。这是**最要紧的一条**：URLSearchParams 把竖线编成 %7C，
   * 服务端解出来必须还是那根竖线（`12.5|acc_time`）。编错了 phyphox 会
   * 当成解析不了而回 400，或者更糟 —— 当成另一个 buffer 名静默返回全量。
   */
  // 等够几个采样周期，不然两次请求挨得比假手机那个 20ms 的采样还快，自然没有新样本
  await new Promise((r) => setTimeout(r, 120));
  const 第二跳 = await fetchDollSamples(host, {
    magnitude: "acc",
    time: "acc_time",
    since: 第一跳.last,
  });
  check("真 HTTP：阈值那根竖线原样到了服务端", 问过的.at(-1).query.acc, `${第一跳.last}|acc_time`);
  checkThat("真 HTTP：增量拿到新样本", 第二跳.samples.length > 0, String(第二跳.samples.length));
  checkThat("真 HTTP：新样本都在起点之后", 第二跳.samples.every((s) => s.t > 第一跳.last));

  // 实验停着 → cmd=start 真的发得出去，而且假手机那边真的开了
  measuring = false;
  const 停着 = await fetchDollSamples(host, { magnitude: "acc", time: "acc_time", since: 第二跳.last });
  check("真 HTTP：读到「实验停着」", 停着.measuring, false);
  check("真 HTTP：start 发得出去", await startDollMeasuring(host), true);
  const 开了 = await fetchDollSamples(host, { magnitude: "acc", time: "acc_time", since: 停着.last });
  check("真 HTTP：按完之后在测量了", 开了.measuring, true);

  /*
   * 整条链：假手机做出一次真的拥抱（幅值脚本切到「抱着」），状态机应该认出来。
   * 这是这个文件里唯一一条**从 HTTP 到结算**都走真路径的断言。
   */
  const st = createDollState();
  幅值 = () => 0.03;
  await new Promise((r) => setTimeout(r, 250));
  // 先对起点
  let page = await fetchDollSamples(host, { magnitude: "acc", time: "acc_time" });
  st.since = page.last;
  st.session = page.session;
  // 抱起来：一下尖峰，然后持续有动静
  幅值 = () => 5.0;
  await new Promise((r) => setTimeout(r, 120));
  幅值 = () => 0.6;
  await new Promise((r) => setTimeout(r, 1_600));
  page = await fetchDollSamples(host, { magnitude: "acc", time: "acc_time", since: st.since });
  let 结算 = feedDollSamples(st, page, DOLL_DEFAULTS);
  check("真 HTTP：抱着的时候还不结算", 结算.length, 0);
  checkThat("真 HTTP：状态机认出抱起来了", st.holding);
  // 放下：安静超过 quietMs（默认 4 秒）—— 把 quietMs 调小好让测试别等那么久
  const 快一点 = { ...DOLL_DEFAULTS, quietMs: 600 };
  幅值 = () => 0.02;
  await new Promise((r) => setTimeout(r, 900));
  page = await fetchDollSamples(host, { magnitude: "acc", time: "acc_time", since: st.since });
  结算 = feedDollSamples(st, page, 快一点);
  check("真 HTTP：放下之后结算一次", 结算.length, 1);
  checkThat("真 HTTP：时长不少于抱着那段", 结算[0].durationMs >= 1_500, `${结算[0].durationMs}ms`);
  checkThat("真 HTTP：峰值是抱起来那一下", 结算[0].peak >= 5.0, String(结算[0].peak));

  // 校准：对着真 HTTP 跑一遍（2 秒，拿得到峰值和均值）
  幅值 = (t) => (Math.floor(t * 10) % 10 === 0 ? 7.5 : 0.1);
  const 校准 = await calibrateDoll(host, { magnitude: "acc", time: "acc_time", seconds: 2, intervalMs: 200 });
  checkThat("真 HTTP：校准读到样本", 校准.samples > 0, String(校准.samples));
  checkThat("真 HTTP：校准报出峰值", 校准.peak >= 7.5, String(校准.peak));
  checkThat("真 HTTP：校准的均值远低于峰值", 校准.avg < 校准.peak, `${校准.avg} vs ${校准.peak}`);

  // 实验停着时校准要说人话，而不是报一个 0
  measuring = false;
  let 校准错 = "";
  try {
    await calibrateDoll(host, { magnitude: "acc", time: "acc_time", seconds: 2, intervalMs: 200 });
  } catch (e) {
    校准错 = String(e.message);
  }
  checkThat("真 HTTP：实验停着时校准提示去点播放", /点一下播放/.test(校准错), 校准错);
  measuring = true;

  // buffer 名写错：phyphox 会静默跳过不存在的 buffer，于是一个样本都没有
  let 没样本 = "";
  try {
    await calibrateDoll(host, { magnitude: "写错了", time: "acc_time", seconds: 2, intervalMs: 200 });
  } catch (e) {
    没样本 = String(e.message);
  }
  checkThat("真 HTTP：buffer 名写错时点明「名字可能不对」", /名可能不对/.test(没样本), 没样本);

  clearInterval(采样);
  await new Promise((r) => server.close(r));

  /*
   * 服务关掉之后：真实的连不上。
   *
   * **刚 close 掉的端口给的不一定是 ECONNREFUSED** —— 还没排空的连接会拿到
   * ECONNRESET（「连接被手机掐断了」）。两句话都是对的，所以这里只断言
   * 「说的是人话」：既不能是 fetch failed，也不能是一串裸错误码。
   */
  let 断了 = "";
  try {
    await fetchDollConfig(host);
  } catch (e) {
    断了 = String(e.message);
  }
  checkThat("真 HTTP：连不上时说的是人话", /远程访问|端口|连不上|掐断|网络不通|超时/.test(断了), 断了);
  checkThat("真 HTTP：不许端出 fetch failed", !断了.includes("fetch failed"), 断了);

  /*
   * 再来一个**从来没人监听过**的端口：这才是稳定的 ECONNREFUSED，也是用户
   * 最常撞上的那一种（phyphox 没开远程访问，或者端口写错了）。那句话得把
   * 「去开远程访问」「安卓 8080 / iPhone 80」说出来，不然用户只会盯着 WiFi 查。
   */
  let 没开 = "";
  try {
    // 先开一个再立刻关，拿一个确定没人占的端口号
    const 探 = http.createServer();
    await new Promise((r) => 探.listen(0, "127.0.0.1", r));
    const 空端口 = 探.address().port;
    await new Promise((r) => 探.close(r));
    await fetchDollConfig(`127.0.0.1:${空端口}`);
  } catch (e) {
    没开 = String(e.message);
  }
  checkThat("真 HTTP：没人监听时点明「远程访问没开 / 端口不对」", /远程访问|端口/.test(没开), 没开);
}

/* ================= 6. 配置 ================= */

console.log("\n配置规整");
const { normalizeConfig, saveConfig, loadConfig } = await import("../server/src/config.js");
const { CONFIG_PATH, SECRET_PATH } = await import("../server/src/datadir.js");

{
  const c = normalizeConfig({ dollApi: { host: " 192.168.1.23:8080 ", intervalMs: 5, soft: 30, firm: 2 } });
  check("地址两头的空格掐掉", c.dollApi.host, "192.168.1.23:8080");
  check("轮询间隔钳到下限", c.dollApi.intervalMs, 200);
  // 填反了的话 hugStrength 里 peak<soft 会先命中，所有拥抱都变「轻轻」
  checkThat("「用力」那档不许低于「轻轻」那档", c.dollApi.firm >= c.dollApi.soft, JSON.stringify(c.dollApi));
  check("老配置里没有 autoStart 时按开着算", normalizeConfig({ dollApi: {} }).dollApi.autoStart, true);
  check("明确关掉就是关", normalizeConfig({ dollApi: { autoStart: false } }).dollApi.autoStart, false);
  check("buffer 名留空时回落到默认（Acceleration without g）", normalizeConfig({ dollApi: {} }).dollApi.magnitude, "acc");
  // 0 = 不设下限，这条路要留着（有人就想要碰一下也算）
  check("minHoldMs 可以是 0", normalizeConfig({ dollApi: { minHoldMs: 0 } }).dollApi.minHoldMs, 0);
  check("阈值填成字符串也归一成数", typeof normalizeConfig({ dollApi: { start: "3.5" } }).dollApi.start, "number");
}

{
  const role = normalizeConfig({ roles: [{ name: "小柚", hug: { enabled: true, cooldownMinutes: 999999 } }] }).roles[0];
  check("角色上的开关", role.hug.enabled, true);
  check("冷却钳到一天", role.hug.cooldownMinutes, 24 * 60);
  check("冷却可以是 0（抱几下响几下）", normalizeConfig({ roles: [{ name: "x", hug: { cooldownMinutes: 0 } }] }).roles[0].hug.cooldownMinutes, 0);
  check("没配过的角色默认是关的", normalizeConfig({ roles: [{ name: "x" }] }).roles[0].hug.enabled, false);
  check("文案默认是带时长力度那句", normalizeConfig({ roles: [{ name: "x" }] }).roles[0].hug.template, HUG_TEMPLATE_RICH);
}

console.log("\n手机的内网地址不许外流");
{
  /*
   * 和 sovits 的地址、spyApi 那一摊一个道理：`host` 是用户家里的内网地址，
   * 不该进那份「能分享出去」的 config.json。整块只住密钥文件里。
   */
  saveConfig(normalizeConfig({ dollApi: { enabled: true, host: "192.168.1.23:8080", hold: 0.4 } }));
  const 明面 = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const 密钥 = JSON.parse(fs.readFileSync(SECRET_PATH, "utf8"));
  /*
   * 落在 config.json 里的是「结构留着、值抹空」那一份，不是整块没有 ——
   * 和 spyApi / weatherApi 一个待遇，前端就不用到处判 undefined（见 saveConfig
   * 里那段注释）。所以这里要盯的是**值**：地址空、开关假。
   */
  check("config.json 里地址被抹空", 明面.dollApi.host, "");
  check("config.json 里开关也不是真的", 明面.dollApi.enabled, false);
  checkThat("config.json 里结构还在（前端不用判 undefined）", typeof 明面.dollApi === "object" && 明面.dollApi !== null);
  checkThat("config.json 里一个字都搜不到那个地址", !JSON.stringify(明面).includes("192.168.1.23"));
  check("密钥文件里存着", 密钥.dollKeys.host, "192.168.1.23:8080");
  // 开关和阈值也在这块里，所以得整块读回来（漏了的话重启就被空结构盖成关）
  const 读回来 = loadConfig();
  check("重新读出来还是开着的", 读回来.dollApi.enabled, true);
  check("阈值也读回来了", 读回来.dollApi.hold, 0.4);
  check("地址也读回来了", 读回来.dollApi.host, "192.168.1.23:8080");
}

fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
