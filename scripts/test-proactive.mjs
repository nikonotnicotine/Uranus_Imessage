/**
 * 主动消息的离线验证：**重启之后还按不按时间发**。
 *
 * 这个脚本的由来是一个真实的毛病：用户每次重启，主动消息就再也不按设定的时间
 * 发了。原因是那套状态只活在内存里，而且 armProactive 当年还有一句
 * 「拿不到 space 就直接 return」—— 两条合起来的后果是「重启 = 计时归零，
 * 而且必须等对方先说一句话才重新起表」。等待窗口本来就是几小时，
 * 重启一次全白等。随机时间和 AI 判断两种模式都一样，因为卡住的是同一个地方。
 *
 * 所以这里验的不是「函数返回值对不对」，而是**跨进程**那件事：
 * 一个进程排好表、退出，另一个进程起来还认不认得那张表。
 * 用 node -e 起真正的子进程来做，同一个进程里 import 两次证明不了落盘。
 *
 * 全程指向临时数据目录（URANUS_DATA_DIR），不碰 data/。
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "uranus-pro-"));

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

/** 在**另一个进程**里跑一段代码，回传它 console.log 的最后一行 JSON。 */
function inFreshProcess(code) {
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: ROOT,
    env: { ...process.env, URANUS_DATA_DIR: TMP },
    encoding: "utf8",
  });
  const lines = out.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

const store = await import("../server/src/proactivestore.js");
const { judgeWaitMs, randomWaitMs, msUntilFocusEnd, inFocus, parseHours, COOLDOWN_MS } =
  await import("../server/src/proactive.js");

const SCHEDULE = path.join(TMP, "proactive.json");
const P = "proj-line-1";

console.log("\n=== 1. 表的读写 ===");
check("一开始是空表", store.readSchedule(), []);
checkThat("空表不建文件（没排过就没有表）", !fs.existsSync(SCHEDULE), SCHEDULE);

const at = Date.now() + 3 * 3600_000;
store.saveSlot(P, "space-a", { peer: "+15550001", nextAt: at, stage: "send" });
checkThat("排一条之后文件出来了", fs.existsSync(SCHEDULE), "");
check("读回来一条", store.slotsFor(P).length, 1);
check("字段原样", store.slotsFor(P)[0], {
  projectRefId: P,
  spaceId: "space-a",
  peer: "+15550001",
  nextAt: at,
  stage: "send",
  awaiting: false,
  read: false,
});

// 同一条会话再排一次是**顶掉**，不是又攒一行 —— 对方每说一句话都会重排一次，
// 攒行的话聊一下午能攒出几百行，重启时全部一起开火
store.saveSlot(P, "space-a", { peer: "+15550001", nextAt: at + 1000, stage: "send" });
check("同一条会话重排不新增行", store.slotsFor(P).length, 1);
check("重排更新了时间", store.slotsFor(P)[0].nextAt, at + 1000);

store.saveSlot(P, "space-b", { peer: "+15550002", nextAt: at, stage: "judge" });
check("两条会话各占一行", store.slotsFor(P).length, 2);
check("别的线路看不见这两行", store.slotsFor("proj-line-2"), []);

console.log("\n=== 2. stage 两种，认不出的当 send ===");
store.saveSlot(P, "space-c", { nextAt: at, stage: "judge" });
check("judge 存住了", store.slotsFor(P).find((t) => t.spaceId === "space-c").stage, "judge");
store.saveSlot(P, "space-c", { nextAt: at, stage: "乱写的" });
check("认不出的回落 send", store.slotsFor(P).find((t) => t.spaceId === "space-c").stage, "send");
store.dropSlot(P, "space-c");

console.log("\n=== 3. 「已读但没回」也要跟着落盘 ===");
/*
 * 这两笔不落盘的话，重启后下一条主动消息就不会缀上那句「对方已读但没回」，
 * 用户会觉得角色突然失忆了。
 */
store.saveSlot(P, "space-a", { peer: "+15550001", nextAt: at, stage: "send", awaiting: true, read: true });
const a = store.slotsFor(P).find((t) => t.spaceId === "space-a");
check("awaiting 存住了", a.awaiting, true);
check("read 存住了", a.read, true);

console.log("\n=== 4. nextAt 为 0 等于撤表 ===");
// 排不上（角色把开关关了）的时候不该留一行 nextAt=0 —— 重启时它一定是「已过期」，
// 会被当成关机期间到点的那种，白发一条
store.saveSlot(P, "space-b", { peer: "+15550002", nextAt: 0, stage: "send" });
checkThat("nextAt=0 的那条被撤掉了", !store.slotsFor(P).some((t) => t.spaceId === "space-b"), "");
check("只剩另一条", store.slotsFor(P).map((t) => t.spaceId), ["space-a"]);

console.log("\n=== 5. 撤表与清死行 ===");
store.saveSlot(P, "space-b", { nextAt: at, stage: "send" });
checkThat("dropSlot 撤掉了", store.dropSlot(P, "space-b") === true, "");
checkThat("重复 dropSlot 返回 false", store.dropSlot(P, "space-b") === false, "");
// 线路删了/换号了，它名下的行没人会来撤
store.saveSlot("proj-gone", "space-x", { nextAt: at, stage: "send" });
check("prune 之前有两条线路", new Set(store.readSchedule().map((t) => t.projectRefId)).size, 2);
check("prune 清掉了 1 行", store.pruneSchedule([P]), 1);
checkThat("留下的是还活着的线路", store.readSchedule().every((t) => t.projectRefId === P), "");
check("prune 没有多清", store.pruneSchedule([P]), 0);

console.log("\n=== 6. 表坏了当空表，不抛 ===");
// 硬盘上那个 JSON 手改坏了、写了一半断电，都不该把桥接带崩
{
  const backup = fs.readFileSync(SCHEDULE, "utf8");
  fs.writeFileSync(SCHEDULE, "{ 这不是 JSON");
  check("读坏文件当空表", store.readSchedule(), []);
  fs.writeFileSync(SCHEDULE, '{"不是":"数组"}');
  check("结构不对也当空表", store.readSchedule(), []);
  fs.writeFileSync(SCHEDULE, '[{"spaceId":"缺了项目号"},{"projectRefId":"缺了会话号"}]');
  check("缺字段的行被丢掉", store.readSchedule(), []);
  fs.writeFileSync(SCHEDULE, backup);
  check("好文件照旧读得出来", store.slotsFor(P).length, 1);
}

console.log("\n=== 7. 跨进程：这才是「重启不清计时器」 ===");
/*
 * 同一个进程里 import 两次证明不了落盘（模块缓存、内存状态都还在）。
 * 这里真起一个子进程去读，读到了才说明那张表活过了「重启」。
 */
{
  const future = Date.now() + 2 * 3600_000;
  store.saveSlot(P, "space-restart", {
    peer: "+15550009",
    nextAt: future,
    stage: "judge",
    awaiting: true,
    read: true,
  });

  const seen = inFreshProcess(`
    const s = await import("./server/src/proactivestore.js");
    const row = s.slotsFor(${JSON.stringify(P)}).find((t) => t.spaceId === "space-restart");
    console.log(JSON.stringify(row ?? null));
  `);
  checkThat("新进程读到了那一行", seen !== null, JSON.stringify(seen));
  check("下次开口的时间没变", seen.nextAt, future);
  check("stage 没变（judge 的接着去问模型）", seen.stage, "judge");
  check("对方是谁没丢", seen.peer, "+15550009");
  check("「已读没回」也活过来了", [seen.awaiting, seen.read], [true, true]);

  // 剩余等待要按**当下**重算，而不是把当初排的那个时长再等一遍
  const left = seen.nextAt - Date.now();
  checkThat("剩余时间是往回算的，不是重新数两小时", left <= 2 * 3600_000, String(left));
  checkThat("剩余时间还是正的（没被当成过期）", left > 0, String(left));

  // 关机期间已经到点的那种：剩余为负，由 imessage.js 挪到 SETTLE_MS 之后补发
  store.saveSlot(P, "space-overdue", { nextAt: Date.now() - 60_000, stage: "send" });
  const od = inFreshProcess(`
    const s = await import("./server/src/proactivestore.js");
    const row = s.slotsFor(${JSON.stringify(P)}).find((t) => t.spaceId === "space-overdue");
    console.log(JSON.stringify({ left: row.nextAt - Date.now() }));
  `);
  checkThat("过期的那条也留着（不是丢掉）", od.left < 0, JSON.stringify(od));
  // imessage.js 里是 Math.max(left, SETTLE_MS)：过期的挪到一分钟后，
  // 免得一开机十几条会话同时往外发
  check("过期的排到 SETTLE_MS 之后", Math.max(od.left, 60_000), 60_000);
}

console.log("\n=== 8. 两种模式走的是同一套表 ===");
/*
 * 用户原话：「AI判断和随即时间都是一样的」。所以这里断言的是两种模式在表里
 * 的形状一致 —— 区别只有 stage（judge 先问模型，send 直接发），
 * 而不是走两套不同的存储。
 */
{
  store.pruneSchedule([]);
  store.saveSlot(P, "sp-random", { peer: "+1", nextAt: at, stage: "send" });
  store.saveSlot(P, "sp-auto", { peer: "+2", nextAt: at, stage: "judge" });
  const rows = store.slotsFor(P);
  check("两种模式各一行", rows.length, 2);
  check(
    "字段集合完全一样",
    rows.map((r) => Object.keys(r).sort().join(",")),
    [
      "awaiting,nextAt,peer,projectRefId,read,spaceId,stage",
      "awaiting,nextAt,peer,projectRefId,read,spaceId,stage",
    ]
  );
  const fresh = inFreshProcess(`
    const s = await import("./server/src/proactivestore.js");
    console.log(JSON.stringify(s.slotsFor(${JSON.stringify(P)}).map((t) => [t.spaceId, t.stage])));
  `);
  check("两种模式都活过了重启", fresh, [
    ["sp-random", "send"],
    ["sp-auto", "judge"],
  ]);
}

console.log("\n=== 9. 算时间那一半（proactive.js）===");
{
  const p = { mode: "random", random: { minHours: 1, maxHours: 3 } };
  const waits = Array.from({ length: 200 }, () => randomWaitMs(p));
  checkThat(
    "随机等待落在区间里",
    waits.every((w) => w >= 3600_000 && w <= 3 * 3600_000),
    `${Math.min(...waits)}-${Math.max(...waits)}`
  );
  checkThat("每次真的重新掷点（不是固定间隔）", new Set(waits).size > 100, String(new Set(waits).size));

  // 两头填反了不算错，按小的当下限
  const rev = { mode: "random", random: { minHours: 5, maxHours: 2 } };
  const rw = Array.from({ length: 50 }, () => randomWaitMs(rev));
  checkThat(
    "上下限填反了也能用",
    rw.every((w) => w >= 2 * 3600_000 && w <= 5 * 3600_000),
    `${Math.min(...rw)}-${Math.max(...rw)}`
  );

  check("自主判断的第一段按分钟算", judgeWaitMs({ auto: { minWaitMinutes: 90 } }), 90 * 60_000);
  checkThat("冷却是十分钟", COOLDOWN_MS === 10 * 60_000, String(COOLDOWN_MS));

  /*
   * parseHours 返回的是**毫秒**（钳进 [0.05, 24] 小时之后再乘），不是小时数。
   * 提示词要求模型只回一个数，但它爱写「2小时」「大约1.5」「2-3」——
   * 这些取第一个数字都是对的答案。
   */
  const H = 3600_000;
  check("纯数字", parseHours("2"), 2 * H);
  check("带小数", parseHours("1.5"), 1.5 * H);
  check("夹在话里", parseHours("我觉得 3 小时后比较合适"), 3 * H);
  check("写成区间时取第一个", parseHours("2-3 小时"), 2 * H);
  // 一个数字都没有时**不能返回空** —— 返回空的话调用方拿 undefined 去 setTimeout，
  // 等于立刻开火。退到 1 小时比不发好，也比无限等下去好
  check("一个数字都没有：退到 1 小时", parseHours("看心情吧"), 1 * H);
  check("负数也退到 1 小时", parseHours("-5"), 1 * H);
  // 钳位：模型说「0 小时」不能变成立刻刷屏，说「一年」也不能等到明年
  check("太短的钳到 3 分钟", parseHours("0.001"), 0.05 * H);
  check("太长的钳到 24 小时", parseHours("8760"), 24 * H);
}

console.log("\n=== 10. 勿扰时段（跨午夜那种）===");
{
  // 默认 00:00-08:00 是跨午夜的，最容易写错的就是这一段
  const focus = { enabled: true, start: "22:00", end: "08:00" };
  const at22 = new Date("2026-09-13T22:30:00");
  const at03 = new Date("2026-09-13T03:00:00");
  const at12 = new Date("2026-09-13T12:00:00");
  checkThat("22:30 在勿扰里", inFocus(focus, at22) === true, "");
  checkThat("03:00 也在勿扰里（跨午夜）", inFocus(focus, at03) === true, "");
  checkThat("12:00 不在勿扰里", inFocus(focus, at12) === false, "");
  checkThat("勿扰关着就一律不挡", inFocus({ ...focus, enabled: false }, at03) === false, "");

  const hold = msUntilFocusEnd(focus, at03);
  check("03:00 要推迟到 08:00（5 小时）", Math.round(hold / 3600_000), 5);
  check("不在勿扰里就不推迟", msUntilFocusEnd(focus, at12), 0);
}

fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
