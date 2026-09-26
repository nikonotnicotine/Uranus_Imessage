/**
 * 合并队列的离线自测 —— 一轮消息什么时候引爆。
 *
 * ── 为什么单独开一套 ──
 *
 * 这一层的坏法是**时序**上的，而时序错了不报错。用户报上来只会是一句
 * 「它怎么回了两遍」或者「图片过了好一会儿才发出去」，而从日志里看每一步
 * 都很正常。这套盯的就是这些「每一步都对、合起来错了」的情形：
 *
 *  1. **每来一条重新倒计时**。对方停手 queueWait 秒才结算，没有别的总上限。
 *  2. **附件还在拆的时候到点了要等**。用户报过的 bug：字在前、图在后，
 *     窗口到点时图还在下载，于是那一轮只带着文字去打模型，图落进了下一轮。
 *     表现是「LLM 先回了文字，图片过了好一会儿才发出去」。
 *  3. **等完要真的引爆**。挂起之后如果没人补那一下，这条会话的窗口就永久
 *     挂起了 —— 后面的消息全进同一个 slot，表现是「这个号从此不说话了」。
 *     这是比原 bug 严重得多的坏法，所以放的每一条路径都单独钉一遍。
 *  4. **挂起期间不许重开窗口**。附件每拆完一件就把这一轮往后推一次的话，
 *     拆附件的时长就被算成了「对方还在打」。
 *  5. **硬引爆要能穿过挂起**。指令 / 协助模式 / 线下模式那三处要的是
 *     「排在前面的那一轮先跑完」，它们不能被附件下载卡住。
 *
 * 不联网、不碰真的 data/：测的是 enqueue 自己的时序，handleTurn 换成假的。
 *
 * 跑：node scripts/test-queue.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "uranus-queue-"));
process.env.URANUS_DATA_DIR = TMP;

const src = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf-8");
const IM_SRC = src("server/src/imessage.js");

let passed = 0;
async function okAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}`);
    console.error(e?.stack || e);
    process.exitCode = 1;
  }
}
function okWith(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}`);
    console.error(e?.stack || e);
    process.exitCode = 1;
  }
}

/*
 * enqueue 是 export 的，但它里面直接调 handleTurn —— 真跑起来会去解析角色、
 * 打模型、写存档。要测的只是「什么时候引爆」，所以按 test-video.mjs 那套办法
 * 把这几个函数从源码里抠出来，在一个喂了假 handleTurn 的作用域里重建。
 *
 * 好处是测的是**真的那段代码**（不是抄一份），改了源码这里就跟着变。
 */
function extractFn(name, kind = "function") {
  const head = `${kind} ${name}(`;
  // `export function enqueue(` 里也含 `function enqueue(`，所以不用特别处理 export
  const at = IM_SRC.indexOf(head);
  assert.ok(at >= 0, `在 imessage.js 里找不到 ${name}`);
  let depth = 0;
  let i = IM_SRC.indexOf("{", at);
  for (; i < IM_SRC.length; i += 1) {
    if (IM_SRC[i] === "{") depth += 1;
    else if (IM_SRC[i] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return IM_SRC.slice(at, i + 1);
}

/** 每次测都要一副干净的：假 runner + 记录下来的引爆。 */
function harness() {
  const logs = [];
  const fired = [];

  const code = `
    return {
      enqueue: ${extractFn("enqueue")},
      flushPending: ${extractFn("flushPending")},
      holdPending: ${extractFn("holdPending")},
      releasePending: ${extractFn("releasePending")},
    };
  `;
  const factory = new Function("logDebug", "scopeOf", "chain", "handleTurn", code);
  const fns = factory(
    (scope, msg) => logs.push({ scope, msg }),
    (_runner, what) => what,
    // 真的 chain 会把这一轮串到会话链上（那是为了和上一轮排队），时序测不到它
    (_runner, _spaceId, fn) => fn(),
    (_getConfig, _runner, _space, spaceId, merged, images, peer, extra) => {
      fired.push({ spaceId, merged, images, peer, ...extra });
    }
  );

  const runner = { pending: new Map(), holds: new Map(), chains: new Map(), stopped: false };
  return { ...fns, runner, logs, fired };
}

/** 合并窗口设成 60ms，测起来快又够稳。 */
const cfg = (waitSec = 0.06) => () => ({ chat: { queueWait: waitSec } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SPACE = { id: "sp" };

/* ================= 1. 每来一条重新倒计时 ================= */
console.log("\n[1. 每来一条重新倒计时]");
{
  await okAsync("两条文本攒成一轮，只引爆一次", async () => {
    const H = harness();
    H.enqueue(cfg(), H.runner, SPACE, "sp", { text: "你好" }, "peer1");
    await sleep(25);
    H.enqueue(cfg(), H.runner, SPACE, "sp", { text: "在吗" }, "peer1");
    await sleep(120);
    assert.equal(H.fired.length, 1);
    assert.equal(H.fired[0].merged, "你好\n在吗");
    assert.equal(H.fired[0].peer, "peer1");
  });

  await okAsync("每来一条重新倒计时（停手 queueWait 才结算）", async () => {
    /*
     * 窗口 150ms，每 100ms 来一条，一共 5 条 —— 每条都落在上一条的窗口里。
     * 以第一条为基准的话 150ms 就结算了；现在要等最后一条之后再过 150ms。
     */
    const H = harness();
    H.enqueue(cfg(0.15), H.runner, SPACE, "sp", { text: "a" });
    for (let i = 0; i < 4; i += 1) {
      await sleep(100);
      H.enqueue(cfg(0.15), H.runner, SPACE, "sp", { text: `b${i}` });
    }
    assert.equal(H.fired.length, 0, "对方还在打就结算了");
    await sleep(90);
    assert.equal(H.fired.length, 0, "离最后一条还不到 150ms 就结算了");
    await sleep(130);
    assert.equal(H.fired.length, 1, "停手 150ms 了还没结算");
    assert.equal(H.fired[0].merged.split("\n").length, 5, "5 条要在同一轮里");
  });

  await okAsync("窗口关了之后来的消息开新一轮（不是并进上一轮）", async () => {
    const H = harness();
    H.enqueue(cfg(), H.runner, SPACE, "sp", { text: "第一轮" });
    await sleep(120);
    H.enqueue(cfg(), H.runner, SPACE, "sp", { text: "第二轮" });
    await sleep(120);
    assert.deepEqual(H.fired.map((f) => f.merged), ["第一轮", "第二轮"]);
  });

  await okAsync("关掉合并（queueWait 0）时立刻发，不进 pending", async () => {
    const H = harness();
    H.enqueue(cfg(0), H.runner, SPACE, "sp", { text: "立刻" });
    assert.equal(H.fired.length, 1);
    assert.equal(H.runner.pending.size, 0, "不该在表里留东西");
  });

  await okAsync("一个字都没打、只发了图，也照样引爆", async () => {
    const H = harness();
    H.enqueue(cfg(), H.runner, SPACE, "sp", { image: { base64: "x" } });
    await sleep(120);
    assert.equal(H.fired.length, 1);
    assert.equal(H.fired[0].merged, "");
    assert.equal(H.fired[0].images.length, 1);
  });

  await okAsync("空消息不引爆（没文本没附件）", async () => {
    const H = harness();
    H.enqueue(cfg(), H.runner, SPACE, "sp", {});
    await sleep(120);
    assert.equal(H.fired.length, 0);
  });
}

/* ================= 2. 拆附件时到点了要等 ================= */
console.log("\n[2. 拆附件时到点了要等]");
{
  await okAsync("用户报的那个 bug：字在前、图在后，只能发一轮", async () => {
    const H = harness();
    // T+0 文字落地，窗口开
    H.enqueue(cfg(), H.runner, SPACE, "sp", { text: "看这张图" });
    // 紧接着开始拆那张图的字节（消息循环里是同步读的，可能要十几秒）
    H.holdPending(H.runner, "sp");

    // 窗口到点 —— 以前这里就把文字单独发走了
    await sleep(120);
    assert.equal(H.fired.length, 0, "附件还在拆，不该引爆");
    assert.ok(H.runner.pending.get("sp"), "slot 要留在表里");
    assert.equal(H.runner.pending.get("sp").due, true, "要记着「已经到点」");

    // 图终于读到了，进同一个 slot，然后放掉
    H.enqueue(cfg(), H.runner, SPACE, "sp", { image: { base64: "img" } });
    H.releasePending(H.runner, "sp");

    assert.equal(H.fired.length, 1, "放掉的那一下就该引爆");
    assert.equal(H.fired[0].merged, "看这张图");
    assert.equal(H.fired[0].images.length, 1, "文字和图要在同一轮里");
    assert.equal(H.runner.pending.size, 0, "引爆完要从表里删掉");
  });

  await okAsync("挂起期间又攒进来的消息不重开窗口", async () => {
    const H = harness();
    H.enqueue(cfg(), H.runner, SPACE, "sp", { text: "一" });
    H.holdPending(H.runner, "sp");
    await sleep(120);

    const slot = H.runner.pending.get("sp");
    assert.equal(slot.due, true);
    H.enqueue(cfg(), H.runner, SPACE, "sp", { text: "二" });
    assert.equal(slot.timer, null, "不该再装一个计时器（那就是 debounce 了）");

    // 再等一个窗口那么久，确认没有别的计时器在后面偷偷引爆
    await sleep(120);
    assert.equal(H.fired.length, 0);

    H.releasePending(H.runner, "sp");
    assert.equal(H.fired.length, 1);
    assert.equal(H.fired[0].merged, "一\n二");
  });

  await okAsync("拆得快、窗口还没到点时，照常按窗口引爆", async () => {
    const H = harness();
    H.enqueue(cfg(), H.runner, SPACE, "sp", { text: "字" });
    H.holdPending(H.runner, "sp");
    await sleep(15);
    H.enqueue(cfg(), H.runner, SPACE, "sp", { image: { base64: "img" } });
    H.releasePending(H.runner, "sp");
    // 还没到点，所以这会儿不该引爆 —— 放掉不等于提前发
    assert.equal(H.fired.length, 0, "放掉不该把窗口提前引爆");
    await sleep(120);
    assert.equal(H.fired.length, 1);
    assert.equal(H.fired[0].images.length, 1);
  });

  await okAsync("一条消息带好几样东西：占几次就要放几次", async () => {
    const H = harness();
    H.enqueue(cfg(), H.runner, SPACE, "sp", { text: "图+语音" });
    H.holdPending(H.runner, "sp");
    H.holdPending(H.runner, "sp");
    await sleep(120);
    assert.equal(H.fired.length, 0);

    H.releasePending(H.runner, "sp");
    assert.equal(H.fired.length, 0, "还剩一个没放，不该引爆");
    H.releasePending(H.runner, "sp");
    assert.equal(H.fired.length, 1, "最后一个放掉才引爆");
    assert.equal(H.runner.holds.has("sp"), false, "放完了不该在 holds 里留 key");
  });

  await okAsync("两条会话互不影响", async () => {
    const H = harness();
    H.enqueue(cfg(), H.runner, SPACE, "a", { text: "A" }, "pa");
    H.enqueue(cfg(), H.runner, { id: "b" }, "b", { text: "B" }, "pb");
    H.holdPending(H.runner, "a"); // 只有 a 在拆附件
    await sleep(120);
    assert.deepEqual(
      H.fired.map((f) => f.spaceId),
      ["b"],
      "b 不该被 a 的附件拖住"
    );
    H.releasePending(H.runner, "a");
    assert.deepEqual(H.fired.map((f) => f.spaceId), ["b", "a"]);
  });
}

/* ================= 3. 放的每一条路 ================= */
console.log("\n[3. 放的每一条路]");
{
  /*
   * 漏放一次，这条会话就永久不说话了 —— 比原 bug 严重得多。所以这一节把
   * 「不该引爆」和「不该崩」的边角都走一遍。
   */
  await okAsync("没占过就放，不崩也不乱引爆", async () => {
    const H = harness();
    H.releasePending(H.runner, "sp"); // 拆到一半崩了、而崩在 holdPending 之前
    assert.equal(H.fired.length, 0);
    H.enqueue(cfg(), H.runner, SPACE, "sp", { text: "后面这条照样要发" });
    await sleep(120);
    assert.equal(H.fired.length, 1);
  });

  await okAsync("多放一次也不会引爆第二遍", async () => {
    const H = harness();
    H.enqueue(cfg(), H.runner, SPACE, "sp", { text: "x" });
    H.holdPending(H.runner, "sp");
    await sleep(120);
    H.releasePending(H.runner, "sp");
    H.releasePending(H.runner, "sp");
    H.releasePending(H.runner, "sp");
    assert.equal(H.fired.length, 1);
  });

  await okAsync("这条会话压根没攒东西时，放掉是空操作", async () => {
    const H = harness();
    H.holdPending(H.runner, "sp");
    H.releasePending(H.runner, "sp");
    assert.equal(H.fired.length, 0);
    assert.equal(H.runner.pending.size, 0);
  });

  await okAsync("放掉之后 holds 表不留垃圾（不然会一直攒 key）", async () => {
    const H = harness();
    for (const id of ["a", "b", "c"]) {
      H.holdPending(H.runner, id);
      H.releasePending(H.runner, id);
    }
    assert.equal(H.runner.holds.size, 0);
  });

  await okAsync("桥接已停：挂起的那一轮放掉时不发出去，视频字节照样撒手", async () => {
    const H = harness();
    const video = { base64: "AAAA", released: 0, release() { this.released += 1; } };
    H.enqueue(cfg(), H.runner, SPACE, "sp", { text: "看这个", video });
    H.holdPending(H.runner, "sp");
    await sleep(120);
    H.runner.stopped = true; // 这期间桥接被换掉了
    H.releasePending(H.runner, "sp");
    assert.equal(H.fired.length, 0, "停了就别发");
    assert.equal(video.released, 1, "字节要放掉，不然这几十 MB 没人管");
  });
}

/* ================= 4. 硬引爆穿过挂起 ================= */
console.log("\n[4. 硬引爆穿过挂起]");
{
  await okAsync("flushPending 不被附件下载卡住", async () => {
    const H = harness();
    H.enqueue(cfg(), H.runner, SPACE, "sp", { text: "前一轮" });
    H.holdPending(H.runner, "sp");
    await sleep(120);
    assert.equal(H.fired.length, 0, "先确认真的挂起了");

    assert.equal(H.flushPending(H.runner, "sp"), true);
    assert.equal(H.fired.length, 1, "硬引爆要穿过去");
    assert.equal(H.fired[0].merged, "前一轮");
  });

  await okAsync("硬引爆之后那个 slot 不会被 releasePending 再发一遍", async () => {
    const H = harness();
    H.enqueue(cfg(), H.runner, SPACE, "sp", { text: "一轮" });
    H.holdPending(H.runner, "sp");
    await sleep(120);
    H.flushPending(H.runner, "sp");
    H.releasePending(H.runner, "sp");
    assert.equal(H.fired.length, 1, "发了两遍就是重复回复");
  });

  await okAsync("没攒东西时 flushPending 返回 false", () => {
    const H = harness();
    assert.equal(H.flushPending(H.runner, "sp"), false);
  });

  await okAsync("已经被硬引爆过的 slot，计时器再响也不会重发", async () => {
    const H = harness();
    H.enqueue(cfg(), H.runner, SPACE, "sp", { text: "一轮" });
    H.flushPending(H.runner, "sp"); // 窗口还没到点就被指令挤掉
    assert.equal(H.fired.length, 1);
    await sleep(120); // 原来那个计时器该被 clearTimeout 掉了
    assert.equal(H.fired.length, 1);
  });

  await okAsync("已经离开 pending 的 slot，到点时不看 holds", async () => {
    /*
     * 这条守的是 fire 里那个 `runner.pending.get(spaceId) !== slot` 判据。
     * queueWait = 0 时 slot 压根没进过表，这时候如果还去看 holds，
     * 挂起就等于把这一轮丢掉 —— 永远没人来放它。
     */
    const H = harness();
    H.holdPending(H.runner, "sp"); // 有附件正在拆
    H.enqueue(cfg(0), H.runner, SPACE, "sp", { text: "关了合并的那种" });
    assert.equal(H.fired.length, 1, "关了合并就该立刻发，不该被挂起吞掉");
  });
}

/* ================= 5. 源码结构 ================= */
console.log("\n[5. 源码结构]");
{
  /*
   * 时序测不到的那两件事，只能盯源码：占和放必须在消息循环的 try / catch
   * 里配对。漏了 catch 那一半，读附件抛异常时这条会话就永久挂起。
   */
  okWith("占窗口在拆附件之前", () => {
    const at = IM_SRC.indexOf("holdPending(runner, spaceId);");
    assert.ok(at > 0, "消息循环里找不到 holdPending 的调用");
    const imagesAt = IM_SRC.indexOf("let imagesSent = 0;");
    assert.ok(at < imagesAt, "要在开始拆图之前就占住");
  });

  okWith("doneUnpacking 声明在 try 外面（catch 里要够得着）", () => {
    const loopAt = IM_SRC.indexOf("for await (const [space, message] of instance.messages)");
    assert.ok(loopAt > 0);
    const head = IM_SRC.slice(loopAt, loopAt + 700);
    const declAt = head.indexOf("let doneUnpacking = null;");
    const tryAt = head.indexOf("try {");
    assert.ok(declAt > 0, "找不到 doneUnpacking 的声明");
    assert.ok(declAt < tryAt, "声明必须在 try 之前，否则 catch 里是 ReferenceError");
  });

  okWith("正常走完和崩了都放", () => {
    const loopAt = IM_SRC.indexOf("for await (const [space, message] of instance.messages)");
    const body = IM_SRC.slice(loopAt);
    const catchAt = body.indexOf('logError(scope, "处理消息出错", err);');
    assert.ok(catchAt > 0, "找不到消息循环的 catch");
    assert.ok(body.slice(0, catchAt).includes("doneUnpacking();"), "正常走完那一路没放");
    assert.ok(body.slice(catchAt).includes("doneUnpacking?.()"), "catch 那一路没放");
  });

  okWith("flushPending 传的是 force", () => {
    assert.match(extractFn("flushPending"), /slot\.fire\(true\)/);
  });

  okWith("attachread 的注释已经改掉「白赚」那句错话", () => {
    const text = src("server/src/attachread.js");
    assert.ok(!/等几秒是白赚的。就算等满/.test(text), "旧的错误前提还在");
    assert.match(text, /holdPending/, "该指向现在的机制");
  });
}

/* ================= 6. 识别并发 ================= */
console.log("\n[6. 识别并发]");
{
  /*
   * 几张图串着识别的话，用户等的是它们的和（每张十几秒）。这几条盯的是
   * 「别又改回 for 里逐个 await」。
   */
  okWith("几张图同时识别", () => {
    const fn = extractFn("describeImages", "async function");
    assert.match(fn, /await Promise\.all\(/);
    assert.ok(!/for \(const \[i, image\] of use\.entries\(\)\)/.test(fn), "又改回串行了");
  });

  okWith("几条语音同时识别", () => {
    const fn = extractFn("describeVoices", "async function");
    assert.match(fn, /await Promise\.all\(/);
  });

  okWith("图 / 语音 / 视频三条线同时跑", () => {
    const at = IM_SRC.indexOf("const [vision, voice, video] = await Promise.all([");
    assert.ok(at > 0, "三条 describe 又串起来了");
  });

  okWith("并发之后顺序还是用户发的那个顺序", () => {
    const fn = extractFn("describeImages", "async function");
    // 下标决定编号和拼接顺序，不靠谁先回来
    assert.match(fn, /use\.map\(async \(image, i\) =>/);
    assert.match(fn, /settled\.map\(\(r\) => r\.part\)/);
    // firstError 要的是排最前面那张的错（上游拿它给用户报原因）
    assert.match(fn, /settled\.find\(\(r\) => r\.err\)/);
  });
}

/* ================= 7. 压图 ================= */
console.log("\n[7. 压图]");
{
  const M = await import("../server/src/media.js");

  await okAsync("小图原样退回，压根不跑 ffmpeg", async () => {
    const buf = Buffer.alloc(1024, 7);
    const got = await M.shrinkForVision(buf, { mimeType: "image/png", scope: "视觉" });
    assert.equal(got.buffer, buf, "应该是同一个 Buffer");
    assert.equal(got.mimeType, "image/png");
  });

  await okAsync("空字节不崩", async () => {
    const got = await M.shrinkForVision(Buffer.alloc(0), { scope: "视觉" });
    assert.equal(got.buffer.length, 0);
    assert.equal(got.mimeType, "image/jpeg", "没给 mimeType 时要有个兜底");
  });

  await okAsync("压不动的（整段乱码）原样退回，不抛错", async () => {
    // 1MB 随机字节：过了体积线，但 ffmpeg 认不出来 —— 必须安静退回
    const buf = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < buf.length; i += 1) buf[i] = i % 251;
    const got = await M.shrinkForVision(buf, { mimeType: "image/png", scope: "视觉" });
    assert.equal(got.buffer.length, buf.length, "该原样退回");
    assert.equal(got.mimeType, "image/png");
  });

  okWith("readImage 的上限判定用原图大小，不因为要压就放宽", () => {
    const fn = extractFn("readImage", "async function");
    const shrinkAt = fn.indexOf("shrinkForVision");
    const capAt = fn.lastIndexOf("超过 ${cap}MB 上限");
    assert.ok(capAt > 0 && capAt < shrinkAt, "上限判定要在压之前");
  });

  okWith("压图永不抛错（调用方没有 try）", () => {
    // 这个函数在 media.js 里，extractFn 只认 imessage.js，所以自己截
    const text = src("server/src/media.js");
    const at = text.indexOf("export async function shrinkForVision(");
    assert.ok(at > 0, "找不到 shrinkForVision");
    const fn = text.slice(at, text.indexOf("\n}\n", at));
    assert.match(fn, /const fallback = \(\) =>/);
    assert.match(fn, /catch \(e\) \{[\s\S]*return fallback\(\);/);
    // 没有 ffmpeg 的机器上也要能降级，不能 throw
    assert.match(fn, /if \(!bin\) \{[\s\S]{0,300}return fallback\(\);/);
  });

  okWith("压完反而更大时用原图", () => {
    const text = src("server/src/media.js");
    const at = text.indexOf("export async function shrinkForVision(");
    const fn = text.slice(at, text.indexOf("\n}\n", at));
    assert.match(fn, /out\.length >= buffer\.length/);
  });
}

/* ================= 8. 打字指示器不许拖累正事 ================= */
console.log("\n[8. 打字指示器不许拖累正事]");
{
  /*
   * 用户报的那句 `fetch failed`，栈底是 `ChatsResource.setTyping` —— 也就是
   * 「让对方看到省略号」这个**装饰**动作挂了，然后整轮消息没回。
   *
   * 根因在 SDK：`space.responding(fn)` 里开指示器那一下没有 catch
   *
   *     responding: async (fn) => {
   *       await space.send(typing("start"));        // ← 这行挂了，fn 压根没跑
   *       try { return await fn(); }
   *       finally { await space.send(typing("stop")).catch(() => {}); }
   *     }
   *
   * 灭指示器那一下人家保护了，开的那一下没有。共享线路抖一下，用户看到的就是
   * 「角色这一轮整个不说话」，日志里只有一句没有信息量的 fetch failed。
   *
   * 所以我们自己那个 respondingWhile 必须守住一条：**指示器是装饰，fn 是正事**。
   * 下面每条都在钉这句话的一个侧面。
   */
  const buildResponding = () => {
    const logs = [];
    const factory = new Function(
      "logDebug",
      `return ${extractFn("respondingWhile", "async function")};`
    );
    return { respondingWhile: factory((scope, msg) => logs.push({ scope, msg })), logs };
  };

  /** 一个假的 space，两个 typing 动作各自能单独设成「会挂」。 */
  const fakeSpace = ({ startFails = false, stopFails = false } = {}) => {
    const calls = [];
    return {
      calls,
      async startTyping() {
        calls.push("start");
        if (startFails) throw new Error("fetch failed");
      },
      async stopTyping() {
        calls.push("stop");
        if (stopFails) throw new Error("fetch failed");
      },
    };
  };

  await okAsync("开指示器挂了，内容照样发出去", async () => {
    const R = buildResponding();
    const space = fakeSpace({ startFails: true });
    let ran = false;
    const got = await R.respondingWhile(space, async () => {
      ran = true;
      return "发出去了";
    });
    assert.equal(ran, true, "这就是用户报的那个 bug：fn 压根没跑");
    assert.equal(got, "发出去了", "返回值要原样传出来");
  });

  await okAsync("灭指示器挂了，也不吃掉已经拿到的结果", async () => {
    const R = buildResponding();
    const got = await R.respondingWhile(fakeSpace({ stopFails: true }), async () => "正文");
    assert.equal(got, "正文");
  });

  await okAsync("两个都挂了还是要把内容发出去", async () => {
    const R = buildResponding();
    const got = await R.respondingWhile(
      fakeSpace({ startFails: true, stopFails: true }),
      async () => "正文"
    );
    assert.equal(got, "正文");
  });

  await okAsync("fn 自己的错照样往外抛（那才是真问题）", async () => {
    const R = buildResponding();
    const space = fakeSpace();
    await assert.rejects(
      () => R.respondingWhile(space, async () => { throw new Error("模型没回"); }),
      /模型没回/
    );
    assert.deepEqual(space.calls, ["start", "stop"], "抛错也要把指示器灭掉");
  });

  await okAsync("正常走完也灭指示器", async () => {
    const R = buildResponding();
    const space = fakeSpace();
    await R.respondingWhile(space, async () => "x");
    assert.deepEqual(space.calls, ["start", "stop"]);
  });

  await okAsync("开不起来只记明细档，不喊 warn", async () => {
    const R = buildResponding();
    await R.respondingWhile(fakeSpace({ startFails: true }), async () => "x");
    assert.equal(R.logs.length, 1, "要留一行，排查「省略号怎么不出来」时得看得见");
    assert.match(R.logs[0].msg, /打字指示器/);
    assert.match(R.logs[0].msg, /fetch failed/, "原始错误要带上");
  });

  await okAsync("不传 runner 也不炸（scopeOf 读 runner.label 会 throw）", async () => {
    const R = buildResponding();
    await R.respondingWhile(fakeSpace({ startFails: true }), async () => "x");
    assert.equal(R.logs[0].scope, "桥接");
  });

  await okAsync("传了 runner 时日志带角色名", async () => {
    const R = buildResponding();
    await R.respondingWhile(fakeSpace({ startFails: true }), async () => "x", { label: "Dante" });
    assert.equal(R.logs[0].scope, "桥接·Dante");
  });

  okWith("源码里不许再有 space.responding( 的调用点", () => {
    /*
     * 漏一处就等于那一路还留着原来的坏法，而这种坏法是间歇性的 ——
     * 只在线路抖的那一秒复现，自测和手点都撞不上。
     */
    const hits = IM_SRC.split("\n")
      .map((line, i) => ({ line, no: i + 1 }))
      // 注释里那句「SDK 的 space.responding(fn)」是有意留的，得放过
      .filter(({ line }) => /\.responding\(/.test(line) && !/^\s*\*/.test(line));
    assert.deepEqual(hits, [], `还有 ${hits.length} 处没换：${hits.map((h) => h.no).join("、")}`);
  });

  okWith("两个 typing 动作各自单独 catch", () => {
    const fn = extractFn("respondingWhile", "async function");
    // 不能是一个 try 罩住两个：那样开的挂了就跳过 fn 了
    assert.match(fn, /try \{\s*await space\.startTyping\(\);\s*\} catch/);
    assert.match(fn, /finally \{\s*try \{\s*await space\.stopTyping\(\);\s*\} catch/);
  });

  okWith("fn 在 try 里、返回值原样 return", () => {
    const fn = extractFn("respondingWhile", "async function");
    assert.match(fn, /return await fn\(\);/);
  });
}

fs.rmSync(TMP, { recursive: true, force: true });

console.log(
  `\n${process.exitCode ? "有失败" : "全部通过"}：${passed} 条\n`
);
