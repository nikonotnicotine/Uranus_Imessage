/**
 * 共感娃娃**推送模式**的整条链，对着真的服务器跑一遍。
 *
 * 和 `test-doll.mjs` 的分工：那边测的是纯函数（状态机、解析、文案），
 * 这边测的是**接起来之后还通不通** —— 起一个真的 `server/src/index.js`，
 * 下载一份真的实验文件，照着那份文件里写的地址和密钥，用一台假手机把
 * phyphox 会发的那种 JSON 一包一包推过去，然后看服务端认不认。
 *
 * 为什么值得单独写一个：这个功能实机上连着踩了几次坑，而每一次都**不在**
 * 纯函数那一层 —— 总开关在界面上点不到、推送口吊着等模型导致乱序、
 * 实验文件里的密钥过期。这些都只有把真东西接起来才看得见。
 *
 * ── 这里验不到的那一段 ──
 *
 * 「认出拥抱之后发给角色」要有一条活着的 iMessage 连接（runner），
 * 本地起不来。所以这个脚本到「服务端认出了几次拥抱」为止 —— 响应里的
 * `hugs` 就是证据。再往后（排队、拼提示词、调模型）由 test-doll.mjs
 * 和 test-proactive.mjs 那边各自盯着。
 *
 * URANUS_DATA_DIR 指向临时目录，绝不碰真实的 data/。
 *
 * 跑：node scripts/test-doll-e2e.mjs
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "uranus-doll-e2e-"));
const PORT = 18900 + Math.floor(Math.random() * 90);
const SECRET = "e2e-secret-9f3a";

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = `http://127.0.0.1:${PORT}`;

/* ================= 先把配置摆好，再起服务 ================= */

process.env.URANUS_DATA_DIR = TMP;
const { saveConfig, normalizeConfig } = await import("../server/src/config.js");
saveConfig(
  normalizeConfig({
    dollApi: {
      enabled: true,
      mode: "push",
      pushUrl: base,
      pushSecret: SECRET,
      pushRate: 20,
      pushInterval: 2,
      // 判定阈值用默认的，但把「安静多久算放下」压短，免得测试干等四秒
      quietMs: 600,
      minHoldMs: 500,
    },
    roles: [{ id: "role-1", name: "小柚", hug: { enabled: true } }],
  })
);

console.log(`\n起一个真的后端（端口 ${PORT}，数据目录 ${TMP}）…`);
const server = spawn(process.execPath, [path.join(ROOT, "server/src/index.js")], {
  env: { ...process.env, URANUS_DATA_DIR: TMP, PORT: String(PORT), URANUS_IG_PORT: "off" },
  stdio: ["ignore", "pipe", "pipe"],
});
const serverLog = [];
server.stdout.on("data", (d) => serverLog.push(String(d)));
server.stderr.on("data", (d) => serverLog.push(String(d)));

/** 等后端起来。起不来就别往下跑了，否则后面全是看不懂的连接失败。 */
async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(500);
  }
  return false;
}
if (!(await waitUp())) {
  console.error("后端没起来，日志：\n" + serverLog.join(""));
  server.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
}

/** 控制台那套登录：默认密码进去，再改一次（出厂密码只够改密码）。 */
let cookie = "";
async function login() {
  const r1 = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "Uranus", password: "Uranus" }),
  });
  cookie = (r1.headers.get("set-cookie") ?? "").split(";")[0];
  const r2 = await fetch(`${base}/api/auth/change`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ username: "tester", password: "PwForE2E9981" }),
  });
  const c2 = (r2.headers.get("set-cookie") ?? "").split(";")[0];
  if (c2) cookie = c2;
}
await login();

/* ================= 1. 实验文件：真的下一份下来 ================= */

console.log("\n=== 1. 下载实验文件，照它说的去连 ===");
const expResp = await fetch(`${base}/api/doll/experiment`, { headers: { Cookie: cookie } });
check("下载得到（200）", expResp.status, 200);
const xml = await expResp.text();

/*
 * **从文件里把地址抠出来，而不是自己拼。** 这一条正是实机踩过的坑：手机上
 * 那份文件里的地址和密钥是下载那一刻写死的，和当前配置对不上就一点反应
 * 都没有。所以这里要测的就是「照着文件里写的去打，通不通」。
 */
const addr = /address="([^"]+)"/.exec(xml)?.[1]?.replaceAll("&amp;", "&") ?? "";
checkThat("文件里有 address", Boolean(addr), xml.slice(0, 200));
checkThat("地址指向我们填的那台后端", addr.startsWith(base), addr);
checkThat("地址里带着密钥", addr.includes(SECRET), addr);
check("推送路径是写死的那条", new URL(addr).pathname, "/doll/hug");

// 采样率和间隔也该跟着配置走（这两样也是写死在文件里的）
checkThat("采样率进了文件", xml.includes('rate="20"'), "");
checkThat("推送间隔进了文件", xml.includes('interval="2"'), "");

/* ================= 2. 一台假手机，照 phyphox 的格式推 ================= */

console.log("\n=== 2. 假手机按 phyphox 的格式推数据 ===");

/**
 * 推一包。
 *
 * 形状完全照 phyphox 的 `http/post`：每个 `<send id>` 一个键，buffer 一律是
 * 数组。我们生成的文件里发的就是 `acc` 和 `t` 这两样。
 */
async function push(samples) {
  const r = await fetch(addr, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ acc: samples.map((s) => s.a), t: samples.map((s) => s.t) }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

/** 造一段样本：20Hz，从 t0 开始。 */
const seg = (t0, vals) => vals.map((a, i) => ({ t: +(t0 + i * 0.05).toFixed(3), a }));
const quiet = (n) => Array.from({ length: n }, () => 0.03);
const held = (n) => Array.from({ length: n }, () => 0.6);

let r = await push(seg(0, quiet(40)));
check("第一包就收下了（200）", r.status, 200);
check("静止的时候认不出拥抱", r.body?.hugs, 0);
/*
 * listeners 是 0：本地没有活着的 iMessage 连接，所以没有角色在听。
 * 这不影响上面那一串 —— 服务端照样会把数据喂进状态机、照样会数拥抱。
 */
checkThat("本地没有活连接，所以没人在听（符合预期）", r.body?.listeners === 0, JSON.stringify(r.body));

/* ================= 3. 抱一下，看认不认得出来 ================= */

console.log("\n=== 3. 抱一下 ===");
// 抱起来那一下（尖峰）+ 抱着一会儿
r = await push(seg(2, [5.0, ...held(40)]));
check("抱着的时候还不结算", r.body?.hugs, 0);
// 放下：安静超过 quietMs（这份配置压到了 600ms）
r = await push(seg(4.1, quiet(40)));
check("放下之后结算出一次拥抱", r.body?.hugs, 1);

/* ================= 4. 推送口不许吊着等 ================= */

console.log("\n=== 4. 推送口得立刻回 ===");
/*
 * 这是 1.16.3 修的那个毛病：以前收到数据会 await 整个递送（一整轮模型调用，
 * 十几秒），于是 phyphox 超时报「網路連線中斷」，堆积的包还会乱序涌进来。
 * 手机是每两秒推一包的，所以响应必须远快于那个间隔。
 */
const t0 = Date.now();
for (let i = 0; i < 5; i++) await push(seg(10 + i, quiet(40)));
const perPush = (Date.now() - t0) / 5;
checkThat(`每包平均 ${Math.round(perPush)}ms，远短于推送间隔`, perPush < 500, `${perPush}ms`);

/* ================= 5. 乱序不该被当成「手机上清空了」 ================= */

console.log("\n=== 5. 乱序的包不该打断正在进行的拥抱 ===");
await push(seg(20, [5.0, ...held(40)])); // 抱起来，正抱着
await push(seg(18, held(10))); // 一包迟到的旧数据插进来
r = await push(seg(22.1, quiet(40))); // 放下
check("乱序插了一包，那次拥抱照样认得出来", r.body?.hugs, 1);
checkThat(
  "日志里没有把它当成「实验重新开始了」",
  !serverLog.join("").includes("实验重新开始了"),
  serverLog.join("").split("\n").filter((l) => l.includes("共感娃娃")).slice(-3).join("\n")
);

/* ================= 6. 几种「打进来但被挡下」 ================= */

console.log("\n=== 6. 旧密钥要被挡，而且控制台说得出是密钥的事 ===");

// 密钥过期 —— 实机上就是这个：改了配置但手机上那份文件是旧的
const bad = await fetch(`${base}/doll/hug?secret=OLD-ONE`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ acc: [1], t: [99] }),
});
check("旧密钥被挡（403）", bad.status, 403);
await sleep(100);
checkThat("控制台点明是密钥的事", serverLog.join("").includes("密钥不对"), "");

/* ================= 7. 控制台得「有反应」 ================= */

console.log("\n=== 7. 推到了就得在控制台看得见 ===");
/*
 * 实机上被问了好几次「抱完控制台什么反应都没有」。以前成功的推送一个字都
 * 不打，「推到了还没认出拥抱」和「根本没推到」长得一模一样。
 */
const logText = () => serverLog.join("");
checkThat("第一包到的时候报了「手机连上来了」", logText().includes("手机连上来了"), "");
checkThat("有动静那一刻就报了，不用等放下", logText().includes("有动静了"), "");

/* ================= 8. 拿手机浏览器直接打开推送地址 ================= */

console.log("\n=== 8. 用浏览器打开推送地址，能看出通不通 ===");
let g = await fetch(addr);
check("密钥对：200", g.status, 200);
checkThat("页面上说「通了」", (await g.text()).includes("通了"), "");
g = await fetch(`${base}/doll/hug?secret=OLD-ONE`);
check("密钥不对：403", g.status, 403);
checkThat("页面上点明是实验文件旧了", (await g.text()).includes("重新下载"), "");

/* ================= 9. 两步校准（推送模式） ================= */

console.log("\n=== 9. 两步校准：截住推过来的数据，替用户算阈值 ===");
/*
 * 实机上用户说「我不懂物理也不懂这些数字是什么意思」。校准是让他只做两件事
 * （放着、抱着），数字由后端算。这里验整条：开窗 → 推 → 到点收尾 → 给建议。
 */
const calib = async (kind, pushes) => {
  const r = await fetch(`${base}/api/doll/calib`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ kind, seconds: 3 }),
  });
  check(`开始校准「${kind}」`, r.status, 200);
  for (const p of pushes) await push(p);
  await sleep(3200);
  return (await fetch(`${base}/api/doll/calib`, { headers: { Cookie: cookie } })).json();
};
let tc = 200;
const next = (vals) => {
  const out = seg(tc, vals);
  tc += vals.length * 0.05 + 0.05;
  return out;
};
// 第一包会被丢掉（装的是开窗之前那两秒），所以这里故意让第一包很大：混进来的话「放着」就不准了
let c = await calib("still", [next([9, 9, 9]), next(quiet(40)), next(quiet(40))]);
check("「放着」读完", c.active, null);
checkThat("开窗后第一包被丢掉了（不然峰值会是 9）", c.still?.peak < 1, JSON.stringify(c.still));
check("还没做第二步，不给建议", c.suggestion, null);

c = await calib("hug", [next(quiet(10)), next([3.4, ...held(30)]), next([2.7, ...held(30)])]);
checkThat("「抱着」读到了峰值", c.hug?.peak >= 3.4, JSON.stringify(c.hug));
checkThat("两步做完给出建议", Boolean(c.suggestion), "");
checkThat("建议的「抱起来」落在放着和抱着之间", c.suggestion.start > c.still.peak && c.suggestion.start < c.hug.peak, JSON.stringify(c.suggestion));

/* ================= 10. 抱得久一点，状态不能被后台抹掉 ================= */

console.log("\n=== 10. 一次持续好几秒的拥抱，中途状态不能被清掉 ===");
/*
 * 实机 bug：后台那条给「后端去读手机」用的循环每秒~5 秒跑一次，在推送模式下
 * 会把共用的状态整个清掉。于是一抱就被抹，日志里只有一串「有动静了」、
 * 永远等不到结算。以前的测试没抓到，是因为推送几包挨得太近（不到 1 秒），
 * 那条循环还没来得及跑。这里按真实节奏推：每秒一包、跨好几秒。
 */
let t10 = 300;
const tick = async (vals) => {
  const r2 = await push(seg(t10, vals));
  t10 += vals.length * 0.05;
  await sleep(1000);
  return r2;
};
await tick(quiet(20));
await tick([4.0, ...held(19)]);
for (let i = 0; i < 6; i++) await tick(held(20)); // 抱着 6 秒，真实时间也过了 6 秒
r = await tick(quiet(20)); // 放下（quietMs 压到了 600ms，一包就够）
check("抱了好几秒，放下之后照样结算出一次", r.body?.hugs, 1);

/* ================= 11. 抱完就点了停止（手机不再发数据） ================= */

console.log("\n=== 11. 抱完点了停止，后面一包都不来了，也得结算 ===");
/*
 * 实机原话：「抱完点右上角的停止，也还是没有反应」。判「放下了」要收到几秒
 * 安静的数据，手机停了就永远收不到。现在按墙上的钟算：手机好几秒不发了、
 * 状态还停在「抱着」，就当放下了来结算。
 */
const before = logText().length;
await push(seg(t10, [4.0, ...held(39)])); // 抱起来、抱着，然后——
// 什么都不再推（相当于点了停止）。silentMs = max(600, 2000) + 2×2000 = 6 秒
await sleep(8000);
const after = logText().slice(before);
checkThat("报了「手机那边停了，当成已经放下」", after.includes("手机那边停了"), after.slice(-300));
checkThat(
  "而且确实结算出了一次拥抱（本地没人听，所以是「认出 1 次…没有角色在听」）",
  after.includes("认出 1 次拥抱"),
  after.slice(-300)
);

/* ================= 12. 拉模式也能两步校准 ================= */

console.log("\n=== 12. 「后端去读手机」模式下的两步校准 ===");
/*
 * 用户问：「为什么本地部署的共感娃娃没有校准模式？」—— 拉模式以前只有单步、
 * 让人自己看峰值均值去填。现在两种模式共用一套两步校准，拉模式下由后端自己
 * 去读手机。这里起一台假 phyphox（会按真实时间往 buffer 里攒样本），把配置切到
 * 拉模式指向它，走真接口校准一遍。
 */
{
  const http = await import("node:http");
  let level = 0.03;
  const t0p = Date.now();
  const buf = [];
  const tickP = setInterval(() => buf.push({ t: (Date.now() - t0p) / 1000, a: level }), 50);
  const phone = http.createServer((q, s) => {
    const u = new URL(q.url, "http://x");
    s.setHeader("Content-Type", "application/json");
    const since = u.searchParams.get("acc_time");
    const rows = since ? buf.filter((x) => x.t > Number(since)) : buf.slice(-1);
    s.end(
      JSON.stringify({
        buffer: { acc: { buffer: rows.map((x) => x.a) }, acc_time: { buffer: rows.map((x) => x.t) } },
        status: { session: "p", measuring: true, timedRun: false, countDown: 0 },
      })
    );
  });
  await new Promise((r) => phone.listen(0, "127.0.0.1", r));
  const phoneHost = `127.0.0.1:${phone.address().port}`;

  // 配置切到拉模式
  const cfg = await (await fetch(`${base}/api/config`, { headers: { Cookie: cookie } })).json();
  const conf = cfg.config ?? cfg;
  conf.dollApi = { ...conf.dollApi, enabled: true, mode: "pull", host: phoneHost, magnitude: "acc", time: "acc_time" };
  const put = await fetch(`${base}/api/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(conf),
  });
  check("切到拉模式", put.status, 200);

  const calibPull = async (kind) => {
    const r2 = await fetch(`${base}/api/doll/calib`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ kind, seconds: 3 }),
    });
    check(`拉模式开始校准「${kind}」`, r2.status, 200);
    await sleep(4000);
    return (await fetch(`${base}/api/doll/calib`, { headers: { Cookie: cookie } })).json();
  };

  level = 0.03;
  let cp = await calibPull("still");
  checkThat("拉模式「放着」读到了数", cp.still?.count > 10, JSON.stringify(cp.still));
  checkThat("读完不再显示「正在读」", cp.active === null, JSON.stringify(cp.active));

  level = 3.5;
  cp = await calibPull("hug");
  checkThat("拉模式「抱着」读到了峰值", cp.hug?.peak >= 3.5, JSON.stringify(cp.hug));
  checkThat("两步做完给出建议", Boolean(cp.suggestion?.start), JSON.stringify(cp.suggestion));

  // 手机连不上时，结果里要带着原因，而不是一个干巴巴的 0
  phone.close();
  clearInterval(tickP);
  cp = await calibPull("still");
  checkThat("读不成时把原因带回来", Boolean(cp.still?.error), JSON.stringify(cp.still));
}

/* ================= 收尾 ================= */

server.kill();
await sleep(300);
fs.rmSync(TMP, { recursive: true, force: true });

if (fail) {
  console.log("\n--- 后端日志（最后 40 行）---");
  console.log(serverLog.join("").split("\n").slice(-40).join("\n"));
}
console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
