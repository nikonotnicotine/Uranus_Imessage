/**
 * 离线自测：查岗的两个开关 + 标签解析 + 提示词裁剪 + 回退边界 + 手机腿那条链路。
 *
 * 不发真的网络请求 —— 电脑腿那几条把 globalThis.fetch 换成假函数（跑完在
 * finally 里换回去），手机腿只测队列和 multipart 解析本身，不发邮件。
 *
 * URANUS_DATA_DIR 必须在 import config.js **之前**指向临时目录 ——
 * DATA_DIR 是模块加载时算的，晚了就改不动了。所以这个文件用的是动态 import，
 * 和别的套件那种顶层 import 不一样。
 *
 * 跑：node scripts/test-spy.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "uranus-spy-"));
process.env.URANUS_DATA_DIR = tmp;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const M = await import("../server/src/spyphone.js");
const C = await import("../server/src/config.js");
const S = await import("../server/src/spy.js");
const P = await import("../server/src/preset.js");
const PR = await import("../server/src/prompt.js");

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
async function okReject(name, promise, msgPart) {
  await promise.then(
    () => {
      console.error(`FAIL  ${name}（不该成功）`);
      process.exitCode = 1;
    },
    (e) => {
      try {
        assert.ok(String(e?.message).includes(msgPart));
        passed += 1;
        console.log(`  ok  ${name}`);
      } catch {
        console.error(`FAIL  ${name}（错误信息不含「${msgPart}」）：${e?.message}`);
        process.exitCode = 1;
      }
    }
  );
}

/** 拼一份最小可用配置：一个角色、一份默认预设。和 test-websearch.mjs 同一套。 */
function setup(roleOverrides = {}) {
  const preset = P.makeDefaultPreset({ id: "ps-1" });
  const config = C.normalizeConfig({
    presets: [preset],
    roles: [
      {
        id: "r-1",
        name: "小柚",
        description: "人设正文",
        presetRef: "ps-1",
        // 查岗要识图模型，不然 lookAt 在抓图之前就退出
        visionModel: { enabled: true, provider: "p-1", modelId: "vm" },
        ...roleOverrides,
      },
    ],
    providers: [{ id: "p-1", name: "P", baseUrl: "https://example.invalid/v1", keys: ["k"] }],
  });
  // 返回**规范化之后**那份预设 —— 改传进去的那个原始对象是没用的，
  // normalizeConfig 拷了一份，buildPrompt 读的是拷贝
  return { config, role: config.roles[0], preset: config.presets[0] };
}

/** 拼出来的提示词里那段 <消息格式与功能>，没有就返回空串。 */
async function formatSection(config, role) {
  const { messages } = await PR.buildPrompt(config, role, null, [
    { role: "user", content: "在吗" },
  ]);
  const all = messages.map((m) => m.content).join("\n\n");
  const at = all.indexOf("<消息格式与功能>");
  if (at < 0) return "";
  return all.slice(at, all.indexOf("</消息格式与功能>") + "</消息格式与功能>".length);
}

console.log("\n[标签解析]");
{
  assert.equal(S.spyTargetIn("[查岗实时电脑屏幕]"), "pc");
  assert.equal(S.spyTargetIn("[查岗实时手机屏幕]"), "phone");
  ok("两个标签各自认得出来");

  assert.equal(S.spyTargetIn("［查岗电脑屏幕］"), "pc");
  assert.equal(S.spyTargetIn("[查岗手机屏幕]"), "phone");
  ok("全角方括号和省掉「实时」的写法也认");

  assert.equal(S.spyTargetIn("先写手机[查岗实时手机屏幕]再写电脑[查岗实时电脑屏幕]"), "phone");
  assert.equal(S.spyTargetIn("先写电脑[查岗实时电脑屏幕]再写手机[查岗实时手机屏幕]"), "pc");
  ok("一条回复里两个都写时，**位置在前**的那个赢");

  assert.equal(S.spyTargetIn("<thinking>要不要[查岗实时电脑屏幕]呢</thinking>"), null);
  ok("XML 块里的标签不算（那是思维链，不是真要查）");

  assert.equal(S.spyTargetIn("今天天气不错"), null);
  assert.equal(S.spyTargetIn(""), null);
  ok("没标签时返回 null");

  assert.equal(S.hasSpyTag("[查岗实时电脑屏幕]"), true);
  assert.equal(S.hasSpyTag("什么都没有"), false);
  ok("hasSpyTag 认两个标签");

  assert.equal(S.stripSpyTags("在的[查岗实时电脑屏幕]"), "在的");
  assert.equal(S.stripSpyTags("[查岗实时手机屏幕]"), "");
  ok("stripSpyTags 只剥标签、留文字");
}

console.log("\n[两个开关：normalizeSpy 的默认值和老配置迁移]");
{
  const fresh = C.normalizeConfig({ roles: [{ id: "r-1" }] }).roles[0].spy;
  assert.equal(fresh.pcEnabled, false);
  assert.equal(fresh.phoneEnabled, false);
  ok("新角色两条腿都默认关（它会外传屏幕，必须用户自己点开）");

  assert.equal(fresh.pcUrl, "127.0.0.1:6878");
  assert.equal(fresh.autoFallback, true);
  ok("pcUrl 有默认值、autoFallback 默认开");

  assert.equal(fresh.enabled, undefined);
  ok("规范化之后不再有单个 enabled 字段（免得有两个真开关）");

  // 老配置：enabled: true 当年就表示两条腿一起开
  const migrated = C.normalizeConfig({ roles: [{ id: "r-1", spy: { enabled: true } }] }).roles[0]
    .spy;
  assert.equal(migrated.pcEnabled, true);
  assert.equal(migrated.phoneEnabled, true);
  ok("老配置 enabled:true 迁成两条腿都开");

  const offBoth = C.normalizeConfig({ roles: [{ id: "r-1", spy: { enabled: false } }] }).roles[0]
    .spy;
  assert.equal(offBoth.pcEnabled, false);
  assert.equal(offBoth.phoneEnabled, false);
  ok("老配置 enabled:false 迁成两条腿都关");

  /*
   * 新字段在就以新字段为准 —— 不然用户刚在界面上关掉的那条腿，会被存量的
   * 老 enabled 字段又打开。
   */
  const mixed = C.normalizeConfig({
    roles: [{ id: "r-1", spy: { enabled: true, phoneEnabled: false } }],
  }).roles[0].spy;
  assert.equal(mixed.pcEnabled, true, "pcEnabled 缺失 → 回落到老的 enabled");
  assert.equal(mixed.phoneEnabled, false, "phoneEnabled 明确给了 false → 不许被老字段翻回来");
  ok("新老字段混着时，明确给出的新字段赢");

  const onlyPc = C.normalizeConfig({
    roles: [{ id: "r-1", spy: { pcEnabled: true } }],
  }).roles[0].spy;
  assert.equal(onlyPc.pcEnabled, true);
  assert.equal(onlyPc.phoneEnabled, false);
  ok("只开电脑腿存得住");

  // 已废除的字段不许留在规范化结果里
  const legacyUrl = C.normalizeConfig({
    roles: [{ id: "r-1", spy: { phoneUrl: "1.2.3.4:1", pcEnabled: true } }],
  }).roles[0].spy;
  assert.equal(legacyUrl.phoneUrl, undefined);
  ok("老的 phoneUrl 字段被丢掉（手机腿走邮件，没有地址）");

  assert.deepEqual(S.spyLegs({ spy: { pcEnabled: true, phoneEnabled: false } }), {
    pc: true,
    phone: false,
    any: true,
  });
  assert.deepEqual(S.spyLegs({ spy: {} }), { pc: false, phone: false, any: false });
  assert.deepEqual(S.spyLegs(undefined), { pc: false, phone: false, any: false });
  ok("spyLegs 三态齐全，角色为空也不炸");
}

console.log("\n[提示词：两条腿各自决定注入什么]");
{
  const bothOff = setup();
  const s0 = await formatSection(bothOff.config, bothOff.role);
  assert.ok(!s0.includes("<查岗>"), s0);
  ok("两条腿都关：整条查岗不注入（模型压根不知道有这功能）");

  const both = setup({ spy: { pcEnabled: true, phoneEnabled: true } });
  const s1 = await formatSection(both.config, both.role);
  assert.ok(s1.includes("<查岗>"), s1);
  assert.ok(s1.includes("[查岗实时电脑屏幕]"), s1);
  assert.ok(s1.includes("[查岗实时手机屏幕]"), s1);
  assert.ok(s1.includes("自动改看另一头"), s1);
  ok("两条腿都开：两个标签都教，回退那句话留着");

  const pcOnly = setup({ spy: { pcEnabled: true, phoneEnabled: false } });
  const s2 = await formatSection(pcOnly.config, pcOnly.role);
  assert.ok(s2.includes("<查岗>"), s2);
  assert.ok(s2.includes("[查岗实时电脑屏幕]"), s2);
  assert.ok(!s2.includes("[查岗实时手机屏幕]"), "手机标签必须一个字都不剩：\n" + s2);
  assert.ok(!s2.includes("自动改看另一头"), "单腿时不该说会自动改看另一头：\n" + s2);
  assert.ok(s2.includes("你现在只能看电脑屏幕"), s2);
  ok("只开电脑腿：手机标签全删、补一句「只能看电脑」");

  const phoneOnly = setup({ spy: { pcEnabled: false, phoneEnabled: true } });
  const s3 = await formatSection(phoneOnly.config, phoneOnly.role);
  assert.ok(s3.includes("[查岗实时手机屏幕]"), s3);
  assert.ok(!s3.includes("[查岗实时电脑屏幕]"), "电脑标签必须一个字都不剩：\n" + s3);
  assert.ok(s3.includes("你现在只能看手机屏幕"), s3);
  ok("只开手机腿：电脑标签全删、补一句「只能看手机」");

  // 预设里那条子条目关着时，开关开着也不注入（两道闸都在）
  const childOff = setup({ spy: { pcEnabled: true, phoneEnabled: true } });
  const fmt = childOff.preset.entries.find((e) => e.kind === "format");
  fmt.children.find((c) => c.kind === "spy").enabled = false;
  const s4 = await formatSection(childOff.config, childOff.role);
  assert.ok(!s4.includes("<查岗>"), s4);
  ok("预设里那条子条目关着：开关开着也不注入");

  // trimSpyPrompt 直接测：用户改过正文时按标签认行，不认小标题
  const custom = [
    "      查岗:",
    '        瞅一眼他电脑: "[查岗实时电脑屏幕]"',
    '        瞅一眼他手机: "[查岗实时手机屏幕]"',
    "        规则:",
    "          - 随便写点什么",
  ].join("\n");
  const trimmed = S.trimSpyPrompt(custom, { pc: true, phone: false });
  assert.ok(trimmed.includes("瞅一眼他电脑"), trimmed);
  assert.ok(!trimmed.includes("瞅一眼他手机"), trimmed);
  assert.ok(trimmed.includes("随便写点什么"), "标签之外的行一个都不许删：\n" + trimmed);
  ok("trimSpyPrompt 按标签认行，用户自己改的小标题照样裁得对");

  assert.equal(S.trimSpyPrompt("随便什么", { pc: false, phone: false }), "");
  ok("trimSpyPrompt 两条腿都关时返回空串（调用方据此整条跳过）");

  const untouched = "两头都开的时候一个字都不动";
  assert.equal(S.trimSpyPrompt(untouched, { pc: true, phone: true }), untouched);
  ok("trimSpyPrompt 两条腿都开时原样返回");
}

console.log("\n[回退：不许倒进关着的那条腿]");
{
  /*
   * 电脑腿抓图会打 fetch，手机腿会发邮件。这里把 fetch 换成「一律失败」，
   * 于是「有没有去碰手机腿」可以用「有没有试图发邮件」来判 —— 手机腿
   * 没配 SMTP，真走到那儿会返回「没配」那种 error，措辞里带「手机」。
   */
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("连不上");
  };
  try {
    // 只开电脑腿 + 自动回退开着：电脑失败也不许去碰手机
    const pcOnly = setup({ spy: { pcEnabled: true, phoneEnabled: false, autoFallback: true } });
    const note1 = await S.runSpy("pc", {
      role: pcOnly.role,
      eps: { vision: { provider: "p-1", modelId: "vm", baseUrl: "x", key: "k" } },
      spyApi: pcOnly.config.spyApi,
      userName: "小明",
      scope: "测试",
    });
    assert.ok(!note1.includes("手机"), "只开电脑腿时，措辞里不该出现手机：\n" + note1);
    ok("只开电脑腿：电脑没看到也不倒向手机");

    // 两条腿都开、回退开着：措辞里两头的原因都要有
    const both = setup({ spy: { pcEnabled: true, phoneEnabled: true, autoFallback: true } });
    const note2 = await S.runSpy("pc", {
      role: both.role,
      eps: { vision: { provider: "p-1", modelId: "vm", baseUrl: "x", key: "k" } },
      spyApi: both.config.spyApi,
      userName: "小明",
      scope: "测试",
    });
    assert.ok(note2.includes("电脑"), note2);
    assert.ok(note2.includes("手机"), "两条腿都开时该去试手机、措辞里要提到它：\n" + note2);
    ok("两条腿都开：电脑没看到会去试手机，两个原因都给模型");

    // 两条腿都开但回退关着：只说第一头
    const noFb = setup({ spy: { pcEnabled: true, phoneEnabled: true, autoFallback: false } });
    const note3 = await S.runSpy("pc", {
      role: noFb.role,
      eps: { vision: { provider: "p-1", modelId: "vm", baseUrl: "x", key: "k" } },
      spyApi: noFb.config.spyApi,
      userName: "小明",
      scope: "测试",
    });
    assert.ok(!note3.includes("手机"), "回退关着时不该去碰手机：\n" + note3);
    ok("回退关着：不倒向另一头");

    // 没开识图模型时，抓图之前就退出（省一趟网络和一次手机唤醒）
    const noVision = setup({ spy: { pcEnabled: true, phoneEnabled: false } });
    const note4 = await S.runSpy("pc", {
      role: noVision.role,
      eps: {},
      spyApi: noVision.config.spyApi,
      userName: "小明",
      scope: "测试",
    });
    assert.ok(note4.includes("识图模型"), note4);
    ok("没开识图模型：不抓图，直接说原因");

    // runSpy 从不抛错 —— 上面四条都返回了字符串，这条就是那个保证
    ok("runSpy 从不抛错（四种失败路径都返回了给模型的话）");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("\n[手机腿：multipart 解析]");
{
  // 快捷指令「表单」的形态：multipart/form-data，secret + image
  const buildMultipart = (boundary, fields) => {
    const parts = [];
    for (const [name, value] of Object.entries(fields)) {
      parts.push(
        Buffer.concat([
          Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"`),
          value instanceof Buffer
            ? Buffer.concat([
                Buffer.from(`; filename="shot.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
                value,
                Buffer.from("\r\n"),
              ])
            : Buffer.from(`\r\n\r\n${value}\r\n`),
        ])
      );
    }
    return Buffer.concat([...parts, Buffer.from(`--${boundary}--\r\n`)]);
  };

  // 一个真 JPEG 的头尾 + 中间夹着容易误伤的字节序列（边界样、CRLF）
  const fakeJpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from([0x2d, 0x2d, 0x61, 0x62, 0x0d, 0x0a, 0x2d, 0x2d]),
    Buffer.alloc(64, 0x00),
    Buffer.from([0xff, 0xd9]),
  ]);
  const B = "ShortcutsBoundary123";

  okWith("multipart：secret + image 都能抠出来", () => {
    const out = M.parseShotUpload(
      buildMultipart(B, { secret: "abc123", image: fakeJpeg }),
      `multipart/form-data; boundary=${B}`
    );
    assert.equal(out.secret, "abc123");
    assert.ok(out.image instanceof Buffer);
    assert.ok(out.image.equals(fakeJpeg), "图字节必须一字不差");
  });

  okWith("multipart：字段顺序反过来也不影响", () => {
    const out = M.parseShotUpload(
      buildMultipart(B, { image: fakeJpeg, secret: "xyz" }),
      `multipart/form-data; boundary=${B}`
    );
    assert.equal(out.secret, "xyz");
    assert.ok(out.image.equals(fakeJpeg));
  });

  okWith("multipart：带引号的 boundary 也认", () => {
    const out = M.parseShotUpload(
      buildMultipart(B, { secret: "s", image: fakeJpeg }),
      `multipart/form-data; boundary="${B}"`
    );
    assert.ok(out.image.equals(fakeJpeg));
  });

  okWith("json：base64 形态", () => {
    const body = Buffer.from(
      JSON.stringify({ secret: "k1", image: fakeJpeg.toString("base64") })
    );
    const out = M.parseShotUpload(body, "application/json");
    assert.equal(out.secret, "k1");
    assert.ok(out.image.equals(fakeJpeg));
  });

  okWith("裸图：image/* 直接当请求体", () => {
    const out = M.parseShotUpload(fakeJpeg, "image/jpeg");
    assert.ok(out.image.equals(fakeJpeg));
    assert.equal(out.secret, "");
  });

  okWith("未知 Content-Type：不炸，返回空", () => {
    const out = M.parseShotUpload(Buffer.from("hello"), "text/plain");
    assert.equal(out.image, null);
  });

  console.log("\n[手机腿：收图口子的四道拦]");

  okWith("没设密钥：一律 403（不能默认开一个谁都能 POST 的路由）", () => {
    assert.equal(
      M.handleShotUpload({ secret: "anything", image: fakeJpeg, want: "" }).status,
      403
    );
  });

  okWith("密钥不对：403", () => {
    assert.equal(
      M.handleShotUpload({ secret: "wrong", image: fakeJpeg, want: "right" }).status,
      403
    );
  });

  okWith("没图：400", () => {
    assert.equal(M.handleShotUpload({ secret: "right", image: null, want: "right" }).status, 400);
  });

  okWith("图太大：413", () => {
    const big = Buffer.alloc(21 * 1024 * 1024);
    assert.equal(M.handleShotUpload({ secret: "right", image: big, want: "right" }).status, 413);
  });

  console.log("\n[手机腿：队列与迟到守卫]");

  // 每组用独立模块实例，免得模块级状态互相污染
  const freshMod = () => import(`../server/src/spyphone.js?v=${Math.random()}`);

  const G1 = await freshMod();
  {
    const id = G1.createShotRequest("测试");
    const waitP = G1.waitForShot(id, 30_000);
    assert.equal(G1.deliverShot(fakeJpeg), "ok");
    assert.ok((await waitP).equals(fakeJpeg));
    ok("队列：先挂条目再送图，认领成功");
  }

  const G2 = await freshMod();
  okWith("队列：没人在等 → idle，不炸", () => {
    assert.equal(G2.deliverShot(fakeJpeg), "idle");
  });

  const G3 = await freshMod();
  await okReject(
    "队列：超时会拒绝，错误信息带秒数",
    (async () => {
      const id = G3.createShotRequest("测试");
      await G3.waitForShot(id, 80); // 80ms，好等
    })(),
    "秒手机没把截图传回来"
  );

  const G4 = await freshMod();
  {
    /*
     * 请求 A 超时（100ms）→ 留迟到条（有效期也是 100ms）；130ms 时送图 →
     * 条还活着、新的请求 B 刚开（远在 LATE_MIN_TRIP 的 8 秒内）→ 图应被丢。
     */
    const idA = G4.createShotRequest("A");
    G4.waitForShot(idA, 100).catch(() => {});
    await sleep(130);
    const idB = G4.createShotRequest("B");
    const waitB = G4.waitForShot(idB, 30_000);
    await sleep(10);
    assert.equal(G4.deliverShot(fakeJpeg), "late", "这张是 A 的迟到件，应该丢掉");
    // 再送一张 —— 迟到条已消费，这张应判给 B
    assert.equal(G4.deliverShot(fakeJpeg), "ok");
    await waitB;
    ok("迟到守卫：超时后的迟到图被丢、不影响下一次");
  }

  const G5 = await freshMod();
  okWith("队列：cancelShot 后条目不悬挂", () => {
    const id = G5.createShotRequest("x");
    G5.cancelShot(id);
    assert.equal(G5.deliverShot(fakeJpeg), "idle");
  });

  const G6 = await freshMod();
  okWith("队列：排满了拒绝新的", () => {
    for (let i = 0; i < 8; i += 1) G6.createShotRequest(`#${i}`);
    assert.throws(() => G6.createShotRequest("超了"), /太多/);
  });
}

console.log("\n[全局 spyApi：默认值与钳制]");
{
  const a = C.normalizeConfig({}).spyApi;
  assert.equal(a.smtpPort, 587);
  assert.equal(a.waitSeconds, 90);
  assert.equal(a.subject, "PHONESPY_TRIGGER");
  assert.equal(a.webhookPath, "/phone/screenshot");
  ok("老配置没有这个块也不炸，默认值齐全");

  const b = C.normalizeConfig({
    spyApi: { smtpPort: 999999, waitSeconds: 5, webhookPath: "phone/x/" },
  }).spyApi;
  assert.ok(b.smtpPort <= 65535);
  assert.ok(b.waitSeconds >= 20 && b.waitSeconds <= 180);
  assert.equal(b.webhookPath, "/phone/x");
  ok("端口 / 秒数钳制，路径补斜杠去尾巴");
}

console.log("\n[落盘：spyApi 整块进密钥文件]");
{
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "config.json"),
    JSON.stringify({ roles: [{ name: "甲" }], spyApi: { smtpHost: "" } })
  );
  fs.writeFileSync(
    path.join(tmp, "data.config.json"),
    JSON.stringify({ spyKeys: { smtpHost: "smtp.qq.com", smtpPass: "pp", webhookSecret: "ss" } })
  );

  const cfg = C.loadConfig();
  assert.equal(cfg.spyApi.smtpHost, "smtp.qq.com", "密钥文件里的块要整块读回来");
  assert.equal(cfg.spyApi.smtpPass, "pp");
  assert.equal(cfg.spyApi.webhookSecret, "ss");
  assert.equal(cfg.spyApi.smtpPort, 587, "合并后照样走规范化补默认");
  ok("loadConfig：data.config.json 的 spyKeys 会并回来");

  /*
   * 角色得在这儿显式给一份 —— 上面写 config.json 时内联的那个 `roles` 读不回来：
   * loadConfig 会先 ensureLayout 建出 characters/ 文件夹，而 readRawFromDisk
   * 里文件夹一存在就以文件夹为准（真实布局下角色从不写在 config.json 里，
   * saveConfig 第 2452 行会把它删掉）。
   */
  C.saveConfig({
    ...cfg,
    roles: [{ name: "甲", spy: { enabled: true } }],
    spyApi: { ...cfg.spyApi, smtpPass: "newpass" },
  });

  const mainOnDisk = JSON.parse(fs.readFileSync(path.join(tmp, "config.json"), "utf8"));
  assert.ok(!mainOnDisk.spyApi.smtpPass, "主配置里不许有 smtpPass");
  assert.equal(mainOnDisk.spyApi.smtpHost, "", "主配置里整块抹空");

  const secretOnDisk = JSON.parse(fs.readFileSync(path.join(tmp, "data.config.json"), "utf8"));
  assert.equal(secretOnDisk.spyKeys.smtpPass, "newpass", "密钥文件里要有 spyKeys");
  assert.equal(secretOnDisk.spyKeys.smtpHost, "smtp.qq.com");
  ok("saveConfig：spyApi 进密钥文件、主配置抹空");

  // 两个开关是角色字段、不是密钥 —— 照常留在可分享的那份里
  const charDir = path.join(tmp, "characters");
  const roleFile = fs.readdirSync(charDir).find((f) => f.endsWith(".json"));
  assert.ok(roleFile, `characters/ 里该有角色文件，实际：${fs.readdirSync(charDir).join()}`);
  const roleOnDisk = JSON.parse(fs.readFileSync(path.join(charDir, roleFile), "utf8"));
  assert.equal(roleOnDisk.spy.pcEnabled, true, "老的 enabled:true 迁过来后要落盘成两条腿");
  assert.equal(roleOnDisk.spy.phoneEnabled, true);
  assert.equal(roleOnDisk.spy.enabled, undefined, "废掉的 enabled 不许再写盘");
  ok("两个开关落在角色文件里，老的 enabled 不再写盘");
}

console.log(`\n${passed} 项全部通过\n`);
