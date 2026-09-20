/**
 * 看视频那条链路的离线自测。
 *
 * 这一层最容易坏在**看不见的地方**，所以测的重点和别的套件不太一样：
 *
 * 一段视频进内存就是几十 MB（base64 把字节撑成 4/3，20MB 的视频是 27MB 的
 * 字符串），而它要跨过整条链路 —— 先在合并队列里等 queueWait 秒，再跟着
 * handleTurn 走完一整轮，而真正用到它的只有其中一步。漏掉一处 release 的
 * 后果是「聊了一晚上内存慢慢涨」：不报错、日志里看不出来、重启就好了，
 * 于是压根查不到。所以下面把**每一条退出路径**都单独钉一遍。
 *
 * 分七块：
 *
 *  1. **分类**。视频附件在 SDK 里没有专门的 type，只能靠 mimeType 前缀认。
 *     认不出来的后果是静默丢弃（老版本就是这个毛病）。
 *  2. **体积闸**。20MB。重点是 SDK 报了 size 的时候**一个字节都不下载**。
 *  3. **release 的每一条路**。七处：识别成功、识别失败、功能没开、超出
 *     单轮上限、队列被抛弃、桥接已停、以及 release 自己要能重复调。
 *  4. **配置**。分类清单、默认关、上限默认 1、提示词的取用顺序。
 *  5. **请求形状**。打的是 Gemini 原生 generateContent、inline_data 在
 *     提示词前面、mime 跟着附件走。
 *  6. **错误归因**。413 这类要能说清是上游拒的，而且**不能重试**。
 *  7. **挂载与镜像**。几张需要一起改的表别漏了视频。
 *
 * 不联网：打模型那几条把 globalThis.fetch 换成假函数，跑完换回去。
 * 全程用临时 URANUS_DATA_DIR，不碰真的 data/。
 *
 * 跑：node scripts/test-video.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "uranus-video-"));
process.env.URANUS_DATA_DIR = TMP;

const C = await import("../server/src/config.js");
const L = await import("../server/src/llm.js");

const src = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf-8");

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ok  ${name}`);
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
async function okReject(name, promise, msgPart) {
  await promise.then(
    () => {
      console.error(`FAIL  ${name}（不该成功）`);
      process.exitCode = 1;
    },
    (e) => {
      const msg = String(e?.message ?? e);
      if (msg.includes(msgPart)) {
        passed += 1;
        console.log(`  ok  ${name}`);
      } else {
        console.error(`FAIL  ${name}（错误信息不含「${msgPart}」）：${msg}`);
        process.exitCode = 1;
      }
    }
  );
}

/*
 * imessage.js 里那几个函数没有 export（readVideo / describeVideos /
 * isVideoAttachment 都是模块内部的），而它们正是要测的东西。
 *
 * 不为了测试去改 export：那等于把内部结构当成对外接口，以后重构会被测试绑住。
 * 改成按源码把函数抠出来、在一个喂了假依赖的作用域里重建 —— 这样测的是
 * **真的那段代码**（不是抄一份），而依赖（日志、readBytes）可以换成假的。
 */
const IM_SRC = src("server/src/imessage.js");

function extractFn(name, kind = "async function") {
  const head = `${kind} ${name}(`;
  const at = IM_SRC.indexOf(head);
  assert.ok(at >= 0, `在 imessage.js 里找不到 ${name}`);
  // 从函数名往前找到它上面那段块注释的开头（有的话），保证抠出来的是完整一段
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

/** 造一个作用域，把抠出来的函数放进去跑。日志全收进一个数组好断言。 */
async function buildHarness() {
  const logs = [];
  const log = (kind) => (scope, msg, detail) => logs.push({ kind, scope, msg, detail });

  // readBytes 由测试喂：正常返回 Buffer，也能让它抛（模拟下载失败）
  let readBytesImpl = async () => Buffer.alloc(0);

  const code = `
    return {
      isVideoAttachment: ${extractFn("isVideoAttachment", "function")},
      readVideo: ${extractFn("readVideo")},
      describeVideos: ${extractFn("describeVideos")},
    };
  `;
  /*
   * MAX_VIDEO_BYTES 从源码里读出来，不在测试里另写一个 20 —— 那样改了常量
   * 测试还会绿，而这个数正是要盯的东西之一。
   */
  const capLine = IM_SRC.match(/const MAX_VIDEO_BYTES = ([^;]+);/);
  assert.ok(capLine, "找不到 MAX_VIDEO_BYTES 的定义");

  const factory = new Function(
    "MAX_VIDEO_BYTES",
    "readBytes",
    "logInfo",
    "logWarn",
    "logError",
    "scopeOf",
    "secsSince",
    "describeVideo",
    code
  );

  const fns = factory(
    // eslint-disable-next-line no-new-func
    new Function(`return ${capLine[1]}`)(),
    (...a) => readBytesImpl(...a),
    log("info"),
    log("warn"),
    log("error"),
    (_runner, what) => what,
    // 用源码里那个真的，不写个 stub —— 日志里的耗时数字也是要盯的东西
    // eslint-disable-next-line no-new-func
    new Function(`${extractFn("secsSince", "function")}; return secsSince;`)(),
    (...a) => describeVideoImpl(...a)
  );

  let describeVideoImpl = async () => "默认描述";

  return {
    ...fns,
    logs,
    setReadBytes: (fn) => {
      readBytesImpl = fn;
    },
    setDescribe: (fn) => {
      describeVideoImpl = fn;
    },
    cap: new Function(`return ${capLine[1]}`)(),
  };
}

const H = await buildHarness();

/** 造一个假的视频对象，带 release 和一个「放没放」的标记。 */
function fakeVideo(name = "v.mp4", bytes = 1024) {
  const item = {
    base64: "A".repeat(Math.ceil((bytes * 4) / 3)),
    mimeType: "video/mp4",
    name,
    released: 0,
  };
  item.release = () => {
    item.base64 = "";
    item.released += 1;
  };
  return item;
}

const runner = () => ({ videoCount: 0 });

/* ================= 1. 分类 ================= */
console.log("\n[1. 分类]");
{
  /*
   * SDK 的 content 里**没有** type:"video" 这个东西（音频有专门的 voice，
   * 视频没有），所以视频就是个普通 attachment，只能靠 mimeType 前缀认。
   * 认不出来的后果不是报错，是静默跳过 —— 老版本卡片就是这么丢的。
   */
  okWith("认得出 video/* 的附件", () => {
    assert.equal(
      H.isVideoAttachment({ type: "attachment", mimeType: "video/mp4" }),
      true
    );
    assert.equal(
      H.isVideoAttachment({ type: "attachment", mimeType: "video/quicktime" }),
      true
    );
  });

  okWith("认得出 iPhone 实拍的那几种 mime", () => {
    for (const m of ["video/quicktime", "video/mp4", "video/3gpp", "video/x-m4v"]) {
      assert.equal(H.isVideoAttachment({ type: "attachment", mimeType: m }), true, m);
    }
  });

  okWith("图片、音频、文档都不算视频", () => {
    for (const m of ["image/png", "audio/mpeg", "application/pdf", "text/plain"]) {
      assert.equal(H.isVideoAttachment({ type: "attachment", mimeType: m }), false, m);
    }
  });

  okWith("type 不是 attachment 的不算（哪怕 mime 像）", () => {
    assert.equal(H.isVideoAttachment({ type: "voice", mimeType: "video/mp4" }), false);
    assert.equal(H.isVideoAttachment({ type: "text", mimeType: "video/mp4" }), false);
  });

  okWith("mimeType 缺失 / 不是字符串时不炸也不误判", () => {
    assert.equal(H.isVideoAttachment({ type: "attachment" }), false);
    assert.equal(H.isVideoAttachment({ type: "attachment", mimeType: null }), false);
    assert.equal(H.isVideoAttachment({ type: "attachment", mimeType: 42 }), false);
    assert.equal(H.isVideoAttachment(null), false);
    assert.equal(H.isVideoAttachment(undefined), false);
  });

  /*
   * 「videotape」这种以 video 开头但不是 video/ 的 mime 不该算 —— 用的是
   * `startsWith("video/")` 而不是 `startsWith("video")`，这条钉住那个斜杠。
   */
  okWith("video 开头但没斜杠的 mime 不算", () => {
    assert.equal(
      H.isVideoAttachment({ type: "attachment", mimeType: "videotape/x" }),
      false
    );
  });
}

/* ================= 2. 体积闸 ================= */
console.log("\n[2. 体积闸]");
{
  okWith("上限就是 20MB", () => {
    assert.equal(H.cap, 20 * 1024 * 1024);
  });

  /*
   * 这一条是这一节的重点：SDK 报了 size 且超限时，**read 压根不能被调用**。
   * 不然那 20MB 白下载一趟（几十秒 + 流量），只为了发现它太大。
   */
  await okAsync("SDK 报的 size 超限时一个字节都不下载", async () => {
    let downloaded = false;
    H.setReadBytes(async () => {
      downloaded = true;
      return Buffer.alloc(10);
    });
    await H.readVideo(
      { type: "attachment", mimeType: "video/mp4", name: "big.mp4", size: 50 * 1024 * 1024 },
      "看视频"
    ).then(
      () => assert.fail("超限却没拦住"),
      (e) => {
        assert.match(String(e.message), /超过 20MB 上限/);
        assert.match(String(e.message), /没有下载/);
      }
    );
    assert.equal(downloaded, false, "超限了却还是下载了");
  });

  await okAsync("没有 size 字段时读完再量，同样拦住", async () => {
    H.setReadBytes(async () => Buffer.alloc(21 * 1024 * 1024));
    await H.readVideo({ type: "attachment", mimeType: "video/mp4" }, "看视频").then(
      () => assert.fail("超限却没拦住"),
      (e) => {
        assert.match(String(e.message), /超过 20MB 上限/);
        // 这条是读完才发现的，所以**不该**说「没有下载」
        assert.ok(!String(e.message).includes("没有下载"));
      }
    );
  });

  await okAsync("正好等于上限的放过（闸是「超过」不是「达到」）", async () => {
    H.setReadBytes(async () => Buffer.alloc(20 * 1024 * 1024));
    const v = await H.readVideo(
      { type: "attachment", mimeType: "video/mp4", size: 20 * 1024 * 1024 },
      "看视频"
    );
    assert.ok(v.base64.length > 0);
  });

  await okReject(
    "读出来是空的要报错（别把空串送去打模型）",
    (async () => {
      H.setReadBytes(async () => Buffer.alloc(0));
      return H.readVideo({ type: "attachment", mimeType: "video/mp4" }, "看视频");
    })(),
    "空的"
  );

  await okAsync("base64 比原始字节大三分之一（内存估算的依据）", async () => {
    H.setReadBytes(async () => Buffer.alloc(3 * 1024 * 1024));
    const v = await H.readVideo({ type: "attachment", mimeType: "video/mp4" }, "看视频");
    const ratio = v.base64.length / (3 * 1024 * 1024);
    assert.ok(ratio > 1.32 && ratio < 1.34, `实际 ${ratio}`);
  });

  await okAsync("mimeType 和文件名照原样带上（打模型要用 mime）", async () => {
    H.setReadBytes(async () => Buffer.alloc(100));
    const v = await H.readVideo(
      { type: "attachment", mimeType: "video/quicktime", name: " trip.mov " },
      "看视频"
    );
    assert.equal(v.mimeType, "video/quicktime");
    assert.equal(v.name, "trip.mov", "文件名要 trim");
  });
}

/* ================= 3. release 的每一条路 ================= */
console.log("\n[3. release 的每一条路]");
{
  /*
   * 这一节是整个套件存在的理由。
   *
   * 用户的要求是「识别完或者报错了就别留本地了，直接删掉，不要让内存爆满」。
   * 下面把能退出的每一条路各钉一条 —— 少任何一条都是一个慢慢涨内存的洞。
   */

  await okAsync("readVideo 给出的对象带 release，调用后 base64 变空", async () => {
    H.setReadBytes(async () => Buffer.alloc(4096));
    const v = await H.readVideo({ type: "attachment", mimeType: "video/mp4" }, "看视频");
    assert.ok(v.base64.length > 0);
    assert.equal(typeof v.release, "function");
    v.release();
    assert.equal(v.base64, "");
  });

  await okAsync("release 重复调不炸（好几条路上都会调到它）", async () => {
    H.setReadBytes(async () => Buffer.alloc(4096));
    const v = await H.readVideo({ type: "attachment", mimeType: "video/mp4" }, "看视频");
    v.release();
    v.release();
    v.release();
    assert.equal(v.base64, "");
  });

  await okAsync("识别成功后放掉", async () => {
    H.setDescribe(async () => "一只猫走过去了");
    const v = fakeVideo();
    const r = runner();
    const out = await H.describeVideos({ url: "u", key: "k", model: "m" }, "p", 1, r, [v]);
    assert.equal(v.released, 1, "识别成功却没放");
    assert.equal(v.base64, "");
    assert.match(out.text, /一只猫走过去了/);
    assert.equal(r.videoCount, 1);
  });

  await okAsync("识别失败也放掉（finally，不是只在成功分支）", async () => {
    H.setDescribe(async () => {
      throw new Error("上游 413");
    });
    const v = fakeVideo();
    const r = runner();
    const out = await H.describeVideos({ url: "u", key: "k", model: "m" }, "p", 1, r, [v]);
    assert.equal(v.released, 1, "报错却没放 —— 这正是用户特意提的那一条");
    assert.equal(v.base64, "");
    assert.equal(out.failed, 1);
    assert.equal(r.videoCount, 0, "失败不该记数");
  });

  /*
   * 「功能没开」这条现在是**兜底**，不是正常路径。
   *
   * 入站那一步已经先看开关了（imessage.js 里 videoOn 那段）：关着就压根不
   * 下载，直接把「你看不到内容」那句话塞进队列 —— 一段 15MB 的视频同步下载
   * 会把整条线路的消息循环堵几十秒，而换回来的只是这句写死的文案。
   *
   * 所以正常情况下带着字节走到这儿的 videos 是空的。这条仍然要测：`/重roll`
   * 之类的路径、以及下次有人把入站那道闸挪走时，这里是最后一道防线 ——
   * 漏了它就是「关着这个功能反而攒内存」，不报错、看不见、重启就好。
   */
  await okAsync("角色没开「看视频」时也放掉（兜底）", async () => {
    const v = fakeVideo();
    const out = await H.describeVideos(null, "p", 1, runner(), [v]);
    assert.equal(v.released, 1, "没开这个功能反而漏了字节");
    assert.equal(v.base64, "");
    assert.match(out.text, /你看不到内容/);
    assert.equal(out.total, 1);
    assert.equal(out.failed, 0, "没开不算「识别失败」");
  });

  await okAsync("超出单轮上限的那几段立刻放掉", async () => {
    H.setDescribe(async () => "看到了");
    const vs = [fakeVideo("a.mp4"), fakeVideo("b.mp4"), fakeVideo("c.mp4")];
    const out = await H.describeVideos({ url: "u", key: "k", model: "m" }, "p", 1, runner(), vs);
    assert.deepEqual(
      vs.map((v) => v.released),
      [1, 1, 1],
      "超限的那两段没放"
    );
    assert.ok(vs.every((v) => v.base64 === ""));
    assert.equal(out.total, 1, "只该识别 1 段");
    assert.match(out.text, /另有 2 段视频未识别/);
  });

  await okAsync("一段成功一段失败，两段都放掉", async () => {
    let n = 0;
    H.setDescribe(async () => {
      n += 1;
      if (n === 1) throw new Error("第一段炸了");
      return "第二段看到了";
    });
    const vs = [fakeVideo("a.mp4"), fakeVideo("b.mp4")];
    const out = await H.describeVideos({ url: "u", key: "k", model: "m" }, "p", 5, runner(), vs);
    assert.deepEqual(vs.map((v) => v.released), [1, 1]);
    assert.equal(out.total, 2);
    assert.equal(out.failed, 1);
    assert.ok(out.firstError, "要留住第一个错误，好发回给对方");
  });

  okWith("停桥接时把队列里攒的放掉（stopRunner）", () => {
    const stop = IM_SRC.slice(IM_SRC.indexOf("async function stopRunner"));
    const head = stop.slice(0, stop.indexOf("runner.pending.clear()"));
    assert.match(head, /for \(const v of slot\.videos \?\? \[\]\) v\.release\?\.\(\)/);
  });

  okWith("桥接已停、定时器却先响了那条路也放掉（fire 里的早退）", () => {
    const fire = IM_SRC.slice(IM_SRC.indexOf("const fire = () =>"));
    const early = fire.slice(0, fire.indexOf("const merged"));
    assert.match(early, /runner\.stopped/);
    assert.match(early, /v\.release\?\.\(\)/);
    // videos 必须在这个早退**之前**就取出来，不然它压根够不着
    assert.ok(
      early.indexOf("slot.videos") < early.indexOf("runner.stopped"),
      "videos 取得比早退晚，那个 release 是空转"
    );
  });

  okWith("handleTurn 的两处早退也放掉（没绑角色 / 聊天模型没配好）", () => {
    const turn = IM_SRC.slice(IM_SRC.indexOf("async function handleTurn"));
    const body = turn.slice(0, turn.indexOf("describeVideos("));
    assert.match(body, /const dropVideos = \(\) =>/);
    // 两处 return 各自调了一次（定义写的是箭头函数，不带 `()`，所以不会被数进来）
    const calls = (body.match(/dropVideos\(\)/g) ?? []).length;
    assert.ok(calls >= 2, `只调了 ${calls} 次，早退有两处`);
    assert.match(body, /if \(!role\)[\s\S]{0,80}dropVideos\(\)/);
    assert.match(body, /if \(!eps\.chat\)[\s\S]{0,80}dropVideos\(\)/);
  });

  okWith("识别完那一步之后，这一轮手上只剩描述文字", () => {
    // describeVideos 内部的 finally 是正常归宿，调用处的注释要说清这件事
    const at = IM_SRC.indexOf("const video = await describeVideos(");
    assert.ok(at > 0);
    const around = IM_SRC.slice(at - 300, at);
    assert.match(around, /识别完|放掉|撒手/);
  });
}

/* ================= 4. 配置 ================= */
console.log("\n[4. 配置]");
{
  okWith("video 进了分类清单，而且排在 audio 后面", () => {
    assert.ok(C.MODEL_CATEGORIES.includes("video"));
    assert.ok(
      C.MODEL_CATEGORIES.indexOf("video") > C.MODEL_CATEGORIES.indexOf("audio"),
      "顺序会决定界面上角标的排列"
    );
  });

  okWith("没和 audio 合成一类（两件事：听得到 ≠ 吃得下）", () => {
    assert.ok(C.MODEL_CATEGORIES.includes("audio"));
    assert.notEqual(C.MODEL_CATEGORIES.indexOf("video"), C.MODEL_CATEGORIES.indexOf("audio"));
  });

  okWith("前端那张分类表也有（两处镜像，改一处漏一处就对不上）", () => {
    const labels = src("client/src/labels.js");
    assert.match(labels, /video: "看视频"/);
    assert.match(labels, /"embedding", "audio", "video"\]/);
  });

  okWith("指令面板那张表也有（config.js 的注释说了三处要一起改）", () => {
    assert.match(src("server/src/commands.js"), /video: "看视频"/);
  });

  const cfg = C.normalizeConfig({
    providers: [
      {
        id: "p1",
        url: "https://relay.invalid/v1",
        keys: ["k"],
        models: [
          { id: "m1", model: "gemini-2.5-flash", enabled: true, categories: ["video"] },
          {
            id: "m2",
            model: "gemini-2.5-pro",
            enabled: true,
            categories: ["video"],
            videoPrompt: "  只说画面里有几个人  ",
          },
        ],
      },
    ],
    roles: [{ id: "r1", name: "小柚" }],
  });

  okWith("新角色默认**不开**看视频", () => {
    assert.equal(cfg.roles[0].videoModel.enabled, false);
  });

  okWith("单轮上限默认 1（听音是 2 —— 一段视频贵一个量级）", () => {
    assert.equal(cfg.roles[0].videoModel.maxClips, 1);
  });

  okWith("上限钳在 1~5（听音那个是 1~10）", () => {
    const c = C.normalizeConfig({
      roles: [{ id: "r1", videoModel: { enabled: true, maxClips: 99 } }],
    });
    assert.equal(c.roles[0].videoModel.maxClips, 5);
    const c2 = C.normalizeConfig({
      roles: [{ id: "r1", videoModel: { enabled: true, maxClips: 0 } }],
    });
    assert.equal(c2.roles[0].videoModel.maxClips, 1);
  });

  /*
   * 落盘时**保留原样**（含首尾空格），trim 是在 resolveRoleEndpoints 里做的 ——
   * 和 visionPrompt / audioPrompt 一个规矩。用户在输入框里敲的空格不该被
   * 悄悄改掉，但送去打模型之前要收干净。
   */
  okWith("videoPrompt 存在模型条目上，原样落盘", () => {
    assert.equal(cfg.providers[0].models[1].videoPrompt, "  只说画面里有几个人  ");
    assert.equal(cfg.providers[0].models[0].videoPrompt, "");
  });

  okWith("只填了空格的提示词等于没填（resolve 那一步 trim 掉）", () => {
    const c = C.normalizeConfig({
      providers: [
        {
          id: "p1",
          url: "https://relay.invalid/v1",
          keys: ["k"],
          models: [
            { id: "m1", model: "g", enabled: true, categories: ["video"], videoPrompt: "   " },
          ],
        },
      ],
      roles: [{ id: "r1", videoModel: { enabled: true, provider: "p1", modelId: "m1" } }],
    });
    const eps = C.resolveRoleEndpoints(c, c.roles[0]);
    assert.equal(eps.videoPrompt, C.DEFAULT_VIDEO_PROMPT);
  });

  okWith("没开时 resolveRoleEndpoints 给 null（调用方靠这个判开没开）", () => {
    const eps = C.resolveRoleEndpoints(cfg, cfg.roles[0]);
    assert.equal(eps.video, null);
  });

  okWith("开了之后解析出 endpoint，提示词回落到内置那句", () => {
    const c = C.normalizeConfig({
      ...cfg,
      roles: [{ ...cfg.roles[0], videoModel: { enabled: true, provider: "p1", modelId: "m1" } }],
    });
    const eps = C.resolveRoleEndpoints(c, c.roles[0]);
    assert.ok(eps.video);
    assert.equal(eps.video.model, "gemini-2.5-flash");
    assert.equal(eps.videoPrompt, C.DEFAULT_VIDEO_PROMPT);
    assert.equal(eps.maxVideos, 1);
  });

  okWith("模型条目上写了提示词就用它（优先于内置）", () => {
    const c = C.normalizeConfig({
      ...cfg,
      roles: [{ ...cfg.roles[0], videoModel: { enabled: true, provider: "p1", modelId: "m2" } }],
    });
    const eps = C.resolveRoleEndpoints(c, c.roles[0]);
    assert.equal(eps.videoPrompt, "只说画面里有几个人");
  });

  okWith("默认提示词要求描述动作和先后顺序（不然只会描述第一帧）", () => {
    assert.match(C.DEFAULT_VIDEO_PROMPT, /发生了什么|动作|先后/);
  });

  okWith("默认提示词禁止凭空推测", () => {
    assert.match(C.DEFAULT_VIDEO_PROMPT, /禁止|不要|看不清/);
  });

  okWith("引用的模型被关掉之后就当没开", () => {
    const c = C.normalizeConfig({
      providers: [
        {
          id: "p1",
          baseUrl: "https://relay.invalid/v1",
          keys: ["k"],
          models: [{ id: "m1", model: "g", enabled: false, categories: ["video"] }],
        },
      ],
      roles: [{ id: "r1", videoModel: { enabled: true, provider: "p1", modelId: "m1" } }],
    });
    const eps = C.resolveRoleEndpoints(c, c.roles[0]);
    assert.ok(!eps.video?.model, "模型关了却还解析出可用的 endpoint");
  });

  okWith("前端新建角色的默认值和后端一致", () => {
    const store = src("client/src/store.jsx");
    assert.match(store, /videoModel: \{ enabled: false[^}]*maxClips: 1 \}/);
  });

  okWith("「应用到其他角色」会带上 videoModel，并且有兜底", () => {
    const store = src("client/src/store.jsx");
    const at = store.indexOf("videoModel: structuredClone(");
    assert.ok(at > 0, "复制配置时漏了 videoModel");
    // 老配置里可能没这个字段，structuredClone(undefined) 会把目标抹掉
    assert.match(store.slice(at, at + 200), /\?\?/);
  });
}

/* ================= 5. 请求形状 ================= */
console.log("\n[5. 请求形状]");
{
  const ep = { url: "https://relay.invalid/v1", key: "sk-x", model: "gemini-2.5-flash", label: "中转" };
  const realFetch = globalThis.fetch;

  /** 拦一次请求，把 url / headers / body 记下来，回一段固定的成功响应。 */
  function stub(reply) {
    const seen = {};
    globalThis.fetch = async (url, init) => {
      seen.url = String(url);
      seen.headers = init?.headers ?? {};
      seen.body = JSON.parse(init?.body ?? "{}");
      const r = reply ?? {
        candidates: [{ content: { parts: [{ text: "画面里有一只猫" }] } }],
      };
      return new Response(JSON.stringify(r), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    return seen;
  }

  try {
    await okAsync("打的是 Gemini 原生的 generateContent", async () => {
      const seen = stub();
      await L.describeVideo(ep, "描述一下", { base64: "QUJD", mimeType: "video/mp4" });
      assert.match(seen.url, /\/v1beta\/models\/gemini-2\.5-flash:generateContent$/);
    });

    await okAsync("inline_data 在提示词**前面**", async () => {
      const seen = stub();
      await L.describeVideo(ep, "描述一下", { base64: "QUJD", mimeType: "video/mp4" });
      const parts = seen.body.contents[0].parts;
      assert.ok(parts[0].inline_data, "第一个 part 不是 inline_data");
      assert.equal(parts[1].text, "描述一下");
    });

    await okAsync("mime 跟着附件走", async () => {
      const seen = stub();
      await L.describeVideo(ep, "p", { base64: "QUJD", mimeType: "video/quicktime" });
      assert.equal(seen.body.contents[0].parts[0].inline_data.mime_type, "video/quicktime");
    });

    await okAsync("附件没报 mime 时兜底成 video/mp4（不是音频那个兜底）", async () => {
      const seen = stub();
      await L.describeVideo(ep, "p", { base64: "QUJD", mimeType: "" });
      assert.equal(seen.body.contents[0].parts[0].inline_data.mime_type, "video/mp4");
    });

    await okAsync("提示词留空就用内置那句", async () => {
      const seen = stub();
      await L.describeVideo(ep, "  ", { base64: "QUJD", mimeType: "video/mp4" });
      assert.equal(seen.body.contents[0].parts[1].text, C.DEFAULT_VIDEO_PROMPT);
    });

    await okAsync("非官方地址用 Bearer（中转站认这个）", async () => {
      const seen = stub();
      await L.describeVideo(ep, "p", { base64: "QUJD", mimeType: "video/mp4" });
      assert.equal(seen.headers.Authorization, "Bearer sk-x");
      assert.ok(!seen.headers["x-goog-api-key"]);
    });

    await okAsync("官方 Google 地址用 x-goog-api-key", async () => {
      const seen = stub();
      await L.describeVideo(
        { ...ep, url: "https://generativelanguage.googleapis.com/v1beta" },
        "p",
        { base64: "QUJD", mimeType: "video/mp4" }
      );
      assert.equal(seen.headers["x-goog-api-key"], "sk-x");
      assert.ok(!seen.headers.Authorization);
    });

    await okAsync("和听音**共用**同一个请求形状（只有 mime 和默认提示词不同）", async () => {
      const a = stub();
      await L.transcribeAudio(ep, "听", { base64: "QUJD", mimeType: "audio/mpeg" });
      const shapeA = Object.keys(a.body.contents[0].parts[0]);
      const b = stub();
      await L.describeVideo(ep, "看", { base64: "QUJD", mimeType: "video/mp4" });
      const shapeB = Object.keys(b.body.contents[0].parts[0]);
      assert.deepEqual(shapeA, shapeB);
      assert.equal(a.url, b.url, "同一个端点");
    });

    /* ---- 错误归因 ---- */
    console.log("\n[6. 错误归因]");

    await okReject(
      "空视频不打模型，直接报配置问题",
      L.describeVideo(ep, "p", { base64: "", mimeType: "video/mp4" }),
      "空视频"
    );

    await okReject(
      "没填地址就报没填地址",
      L.describeVideo({ ...ep, url: "" }, "p", { base64: "QUJD" }),
      "没填接口地址"
    );

    await okReject(
      "没填模型名就报没填模型名",
      L.describeVideo({ ...ep, model: "" }, "p", { base64: "QUJD" }),
      "没填模型名"
    );

    await okAsync("413 不重试（那是网关拒的，重试只是白等）", async () => {
      let calls = 0;
      globalThis.fetch = async () => {
        calls += 1;
        return new Response("<html>413 Request Entity Too Large</html>", { status: 413 });
      };
      await L.describeVideo(ep, "p", { base64: "QUJD", mimeType: "video/mp4" }).then(
        () => assert.fail("413 却成功了"),
        () => {}
      );
      assert.equal(calls, 1, `重试了 ${calls - 1} 次，413 是确定性拒绝`);
    });

    // 用 400 而不是 500：500 会真的退避重试三轮（0.8 + 2.5 + 15 秒），
    // 一条断言不值得让整个套件多跑十八秒
    await okAsync("报错里带上「看视频」，一眼看出是哪条线", async () => {
      globalThis.fetch = async () => new Response("nope", { status: 400 });
      await L.describeVideo(ep, "p", { base64: "QUJD", mimeType: "video/mp4" }).then(
        () => assert.fail("不该成功"),
        (e) => assert.match(String(e.message), /看视频/)
      );
    });

    await okAsync("HTTP 200 里夹的 error 也要报出来", async () => {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ error: { message: "quota exceeded" } }), { status: 200 });
      await L.describeVideo(ep, "p", { base64: "QUJD", mimeType: "video/mp4" }).then(
        () => assert.fail("不该成功"),
        (e) => assert.match(String(e.message), /quota exceeded/)
      );
    });

    await okAsync("空回复要带上 finishReason", async () => {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ candidates: [{ finishReason: "SAFETY", content: {} }] }), {
          status: 200,
        });
      await L.describeVideo(ep, "p", { base64: "QUJD", mimeType: "video/mp4" }).then(
        () => assert.fail("不该成功"),
        (e) => assert.match(String(e.message), /SAFETY/)
      );
    });
  } finally {
    globalThis.fetch = realFetch;
  }
}

/* ================= 7. 挂载与镜像 ================= */
console.log("\n[7. 挂载与镜像]");
{
  okWith("入站会把视频附件挑出来（不再静默丢掉）", () => {
    assert.match(IM_SRC, /const videoParts = parts\.filter\(isVideoAttachment\)/);
  });

  okWith("读失败时给模型一句「你看不到」，而不是当没收到", () => {
    const at = IM_SRC.indexOf("读取视频附件失败");
    assert.ok(at > 0);
    const after = IM_SRC.slice(at, at + 700);
    assert.match(after, /你看不到里面的内容/);
    assert.match(after, /别猜/);
  });

  okWith("那句提示里**不提 20MB**（那是实现细节，对方照着改不了）", () => {
    const at = IM_SRC.indexOf("{{user}}发来一段视频");
    assert.ok(at > 0);
    const line = IM_SRC.slice(at, at + 300);
    assert.ok(!line.includes("20MB"), "把内部阈值写进了发给模型的话里");
    assert.match(line, /太大|剪短/);
  });

  okWith("视频算进「这一轮要不要打模型」", () => {
    // 只发了一段视频、一个字都没打的那轮，靠这个判断才会走下去
    const at = IM_SRC.indexOf("const gotSomething = Boolean(");
    assert.ok(at > 0, "找不到 gotSomething 那个判断");
    assert.match(IM_SRC.slice(at, at + 220), /videosSent/);
  });

  /*
   * 关着「看视频」就**一个字节都不下载**。
   *
   * 这条钉的是用户报的「发视频像卡死了一样」：下载是在消息循环里同步等的，
   * 一段 15MB 要几十秒，这期间整条线路的消息全堵在 SDK 缓冲里不动 —— 而
   * 关着这个功能时，那几十秒换回来的只是一句写死的降级文案。
   *
   * 按「readVideo 那个循环在开关之后、而且遍历的是 videoOn 决定的集合」来判，
   * 不按行号：这段代码以后还会动，但「先判开关再下载」这个顺序不能倒过来。
   */
  okWith("关着「看视频」时压根不下载（不然要卡几十秒）", () => {
    const gate = IM_SRC.indexOf("const videoOn =");
    const read = IM_SRC.indexOf("await readVideo(part, scope)");
    assert.ok(gate > 0, "入站那段没有先判开关 —— 关着也会整段下载");
    assert.ok(read > gate, "下载排在开关判断之前，等于闸没生效");
    // 关着那条路要自己把降级文案塞进队列，否则模型什么都不知道
    const after = IM_SRC.slice(gate, read);
    assert.match(after, /没启用视频识别/, "关着时没告诉模型「有视频但看不到」");
    assert.match(after, /不下载/, "日志里要说清是「没下载」，这是排查时最想知道的事");
    // 遍历的必须是开关筛过的集合，不能还是原始的 videoParts
    assert.match(IM_SRC, /for \(const part of videoOn \? videoParts : \[\]\)/);
  });

  /*
   * 下载期间控制台不能一片空白。
   *
   * 以前 readBytes 只在**重试时**才出声，一次顺利的 15MB 下载从头到尾一个字
   * 都没有 —— 用户看到的是「日志停住，长时间静默，然后突然蹦出一行」，和真
   * 卡死分不出来，也没法判断是在下载、在打模型、还是挂了。
   */
  okWith("下载附件前后各打一行日志（静默就等于看不出卡在哪）", () => {
    const src_ = src("server/src/attachread.js");
    assert.match(src_, /开始下载/, "下载开始时一声不响");
    assert.match(src_, /下载完了/, "下载结束时一声不响");
    // 大附件才喊，小的走 debug —— 否则每张表情包都刷一行
    assert.match(src_, /LOUD_BYTES/, "没有分级，小附件会把日志刷满");
  });

  okWith("黑框窗口那份日志带时间（拷出来要看得出时序）", () => {
    const src_ = src("server/src/logs.js");
    // 网页控制台本来就有时间，stdout 这份以前只有 [来源] 内容
    assert.match(src_, /function stamp\(\)/, "stdout 那行没有时间戳");
    assert.match(src_, /\$\{stamp\(\)\} \[\$\{entry\.scope\}\]/, "时间戳没接到输出行上");
  });

  okWith("三路全失败时那句话是按路数拼的，不是嵌套三目", () => {
    const at = IM_SRC.indexOf("const lanes = [");
    assert.ok(at > 0, "还是老的嵌套三目 —— 三路要六种组合，漏一种就答非所问");
    const table = IM_SRC.slice(at, at + 600);
    assert.match(table, /段视频/);
    assert.match(table, /这段视频没能看清/);
  });

  okWith("状态接口报 videoCount（界面上要显示）", () => {
    assert.match(IM_SRC, /videoCount: runner\.videoCount/);
    assert.match(IM_SRC, /videoCount: projects\.reduce/);
  });

  okWith("界面把 videoCount 显示出来了", () => {
    const ui = src("client/src/panels/imessage.jsx");
    assert.match(ui, /conn\.videoCount/);
    assert.match(ui, /summary\.videoCount/);
  });

  okWith("角色面板有看视频那一块", () => {
    const ui = src("client/src/panels/role.jsx");
    assert.match(ui, /category="video"/);
    assert.match(ui, /videoModel/);
    // 20MB 那道闸得在界面上说清楚，不然用户不知道为什么有的视频没反应
    assert.match(ui, /20MB/);
  });

  okWith("连接面板能填视频提示词、也能传一段试试", () => {
    const ui = src("client/src/panels/api.jsx");
    assert.match(ui, /videoPrompt/);
    assert.match(ui, /video-test/);
    assert.match(ui, /accept="video\/\*"/);
  });

  okWith("试看视频那条路由的请求体上限单独放宽了", () => {
    const idx = src("server/src/index.js");
    // 20MB 撑成 base64 是 27MB，全局那个 12mb 会在路由之前就拒掉
    assert.match(idx, /app\.use\("\/api\/llm\/video-test", express\.json\(\{ limit: "48mb" \}\)\)/);
    // 而且必须排在全局那个之前
    assert.ok(
      idx.indexOf('"/api/llm/video-test", express.json') <
        idx.indexOf('app.use(express.json({ limit: "12mb" }))'),
      "挂晚了，全局那个会先把 body 读掉"
    );
  });

  okWith("有取默认提示词的路由（界面上「还原默认」要用）", () => {
    assert.match(src("server/src/index.js"), /app\.get\("\/api\/video\/default-prompt"/);
  });

  okWith("超时跟着识图走，没有被缩短", () => {
    const llm = src("server/src/llm.js");
    const at = llm.indexOf("async function inlineMedia");
    const body = llm.slice(at, llm.indexOf("export async function transcribeAudio"));
    assert.match(body, /timeout: VISION_TIMEOUT/);
  });
}

fs.rmSync(TMP, { recursive: true, force: true });

console.log(
  `\n${process.exitCode ? "有失败" : `${passed} 项全部通过`}\n`
);
