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

  /*
   * 只比五个组开关那几个字段。`features` / `on` 另有一批断言（见下面「单项开关」
   * 那一段）—— 整个对象 deepEqual 的话，往 spyLegs 里加一个字段就会把这儿
   * 弄挂，而这几行想说的只是「五个组开关认得对」。
   */
  const off = { pc: false, phone: false, view: false, control: false, music: false };
  const groupsOf = (legs) => ({
    pc: legs.pc,
    phone: legs.phone,
    view: legs.view,
    control: legs.control,
    music: legs.music,
    screens: legs.screens,
    any: legs.any,
  });
  assert.deepEqual(groupsOf(S.spyLegs({ spy: { pcEnabled: true, phoneEnabled: false } })), {
    ...off,
    pc: true,
    screens: true,
    any: true,
  });
  assert.deepEqual(groupsOf(S.spyLegs({ spy: {} })), { ...off, screens: false, any: false });
  assert.deepEqual(groupsOf(S.spyLegs(undefined)), { ...off, screens: false, any: false });
  ok("spyLegs 五个开关齐全，角色为空也不炸");

  /*
   * `screens` 和 `any` 不是一回事：只开手机里那三组的时候屏幕那两条腿是关的
   * （runSpy 那套互相兜底压根不该启动），但整条子条目要注入。
   */
  const musicOnly = S.spyLegs({ spy: { phoneMusicEnabled: true } });
  assert.equal(musicOnly.screens, false);
  assert.equal(musicOnly.any, true);
  ok("只开放歌：screens 是 false（屏幕不兜底），any 是 true（子条目要注入）");

  // 三个新开关都默认 false，而且不继承老的 enabled
  const fromLegacy = C.normalizeConfig({
    roles: [{ id: "r-1", spy: { enabled: true } }],
  }).roles[0].spy;
  assert.equal(fromLegacy.pcEnabled, true);
  assert.equal(fromLegacy.phoneViewEnabled, false);
  assert.equal(fromLegacy.phoneControlEnabled, false);
  assert.equal(fromLegacy.phoneMusicEnabled, false);
  ok("老的 enabled 只迁成屏幕两条腿，手机里那三组一律不继承");
}

console.log("\n[pool：按开关滤，不许越权]");
{
  const legs = (patch) => S.spyLegs({ spy: patch });

  assert.equal(S.phonePool("view", legs({ phoneViewEnabled: true })).length, 9);
  assert.equal(S.phonePool("view", legs({})).length, 0);
  ok("查看类：开着给九条，关着给空");

  /*
   * 操控类横跨两个开关。只开放歌时**锁屏必须匹配不上** —— 不滤的话
   * controlFeatures() 里有锁屏，用户那部手机就真的被锁了。
   */
  const musicOnly = S.phonePool("control", legs({ phoneMusicEnabled: true }));
  assert.equal(musicOnly.length, 6);
  assert.ok(!musicOnly.some((f) => f.key === "lock"), "只开放歌时锁屏不许在 pool 里");
  assert.ok(musicOnly.every((f) => f.group === "music"));
  ok("只开放歌：pool 里只有网易云那六件，锁屏进不来");

  const ctrlOnly = S.phonePool("control", legs({ phoneControlEnabled: true }));
  assert.equal(ctrlOnly.length, 4);
  assert.ok(!ctrlOnly.some((f) => f.group === "music"), "只开操控时网易云不许在 pool 里");
  ok("只开操控：pool 里只有闹钟锁屏那四件，网易云进不来");

  assert.equal(
    S.phonePool("control", legs({ phoneControlEnabled: true, phoneMusicEnabled: true })).length,
    10
  );
  assert.equal(S.phonePool("control", legs({})).length, 0);
  ok("两个都开给十条，都关给空");
}

console.log("\n[标签：手机那两个]");
{
  assert.deepEqual(S.phoneTargetIn("[查岗手机:支付宝账单]"), {
    kind: "view",
    keyword: "支付宝账单",
    at: 0,
  });
  assert.equal(S.phoneTargetIn("［操控手机：锁屏］")?.kind, "control");
  ok("全角方括号和全角冒号都认");

  // 屏幕那两个标签不许被这两条正则吃掉（查岗手机 中间夹着「实时」）
  assert.equal(S.phoneTargetIn("[查岗实时手机屏幕]"), null);
  assert.equal(S.spyTargetIn("[查岗手机:支付宝账单]"), null);
  ok("屏幕标签和手机标签互不串台");

  assert.equal(S.phoneTargetIn("<thinking>要不要[操控手机:锁屏]</thinking>"), null);
  ok("thinking 块里复述格式不算");

  // 空体：认得出来所以剥得掉，但不当成「写了」
  assert.equal(S.phoneTargetIn("[查岗手机:]"), null);
  assert.equal(S.hasPhoneTag("[查岗手机:]"), false);
  assert.equal(S.stripSpyTags("在的[查岗手机:]"), "在的");
  ok("空标签：不当成写了，但照样剥干净");

  // 两个都写了按先出现的算
  assert.equal(S.phoneTargetIn("[操控手机:锁屏]然后[查岗手机:微信]")?.kind, "control");
  assert.equal(S.phoneTargetIn("[查岗手机:微信]然后[操控手机:锁屏]")?.kind, "view");
  ok("查看和操控都写了：按先出现的算");

  // 参数原样带出来，拆是 splitArg 的事
  assert.equal(S.phoneTargetIn("[操控手机:放歌 稻香 周杰伦]")?.keyword, "放歌 稻香 周杰伦");
  ok("参数里的空格不丢");

  // 四个标签一起剥
  const messy = "在的[查岗实时电脑屏幕][查岗手机:微信][操控手机:锁屏]好";
  assert.equal(S.stripSpyTags(messy), "在的好");
  ok("stripSpyTags 四个标签一起剥");
}

console.log("\n[提示词：五个开关各自决定注入什么]");
{
  /*
   * 查岗在预设里是**四条**子条目，各带自己的标签（preset.js:FORMAT_CHILD_TAGS）。
   * 底下判「这一段有没有注入」一律用这四个，别找已经不存在的 `<查岗>`。
   */
  const SCREEN = "<看屏幕>";
  const VIEW = "<查看手机>";
  const CONTROL = "<操控手机>";
  const MUSIC = "<放歌>";
  const noSpy = (s) => ![SCREEN, VIEW, CONTROL, MUSIC].some((t) => s.includes(t));

  const bothOff = setup();
  const s0 = await formatSection(bothOff.config, bothOff.role);
  assert.ok(noSpy(s0), s0);
  ok("五个都关：四条查岗全不注入（模型压根不知道有这功能）");

  const all = {
    pcEnabled: true,
    phoneEnabled: true,
    phoneViewEnabled: true,
    phoneControlEnabled: true,
    phoneMusicEnabled: true,
  };
  const both = setup({ spy: all });
  const s1 = await formatSection(both.config, both.role);
  // 全开时四条都该在，各带自己的标签
  for (const t of [SCREEN, VIEW, CONTROL, MUSIC]) {
    assert.ok(s1.includes(t), `全开时 ${t} 这一条该注入：\n` + s1);
  }
  assert.ok(s1.includes("[查岗实时电脑屏幕]"), s1);
  assert.ok(s1.includes("[查岗实时手机屏幕]"), s1);
  assert.ok(s1.includes("自动改看另一头"), s1);
  // 三个占位符都该被换成真清单，一个都不许漏出去
  for (const v of ["{{查看项}}", "{{操控项}}", "{{网易云项}}"]) {
    assert.ok(!s1.includes(v), `占位符 ${v} 漏进提示词了：\n` + s1);
  }
  assert.ok(s1.includes("支付宝账单"), "查看清单该有支付宝账单：\n" + s1);
  assert.ok(s1.includes("锁屏"), "操控清单该有锁屏：\n" + s1);
  assert.ok(s1.includes("每日推荐"), "网易云清单该有每日推荐：\n" + s1);
  // 全开时不补那句「你这一轮能用的标签只有」
  assert.ok(!s1.includes("你这一轮能用的标签"), "全开时不该补那句：\n" + s1);
  ok("五个全开：五行都教、三个清单都填上、不补多余的话");

  const pcOnly = setup({ spy: { pcEnabled: true } });
  const s2 = await formatSection(pcOnly.config, pcOnly.role);
  assert.ok(s2.includes(SCREEN), s2);
  // 手机那三条整条都不该注入（不只是行被删）
  for (const t of [VIEW, CONTROL, MUSIC]) {
    assert.ok(!s2.includes(t), `只开电脑腿时 ${t} 那一条该整条跳过：\n` + s2);
  }
  assert.ok(s2.includes("[查岗实时电脑屏幕]"), s2);
  assert.ok(!s2.includes("[查岗实时手机屏幕]"), "手机标签必须一个字都不剩：\n" + s2);
  assert.ok(!s2.includes("自动改看另一头"), "单腿时不该说会自动改看另一头：\n" + s2);
  assert.ok(!s2.includes("[查岗手机:"), "查看类关着，那一行必须删掉：\n" + s2);
  assert.ok(!s2.includes("[操控手机:"), "操控和放歌都关着，那两行必须删掉：\n" + s2);
  assert.ok(s2.includes("屏幕你只能看电脑"), s2);
  ok("只开电脑腿：另外四行全删、补一句「只能看电脑」");

  const phoneOnly = setup({ spy: { phoneEnabled: true } });
  const s3 = await formatSection(phoneOnly.config, phoneOnly.role);
  assert.ok(s3.includes("[查岗实时手机屏幕]"), s3);
  assert.ok(!s3.includes("[查岗实时电脑屏幕]"), "电脑标签必须一个字都不剩：\n" + s3);
  assert.ok(s3.includes("屏幕你只能看手机"), s3);
  ok("只开手机腿：电脑标签全删、补一句「只能看手机」");

  /*
   * 只开放歌 —— 最容易出错的一种：`操控手机` 和 `放歌` 两行共用
   * `[操控手机:…]` 这一个标签前缀，按标签认行的话会把两行一起删掉。
   */
  const musicOnly = setup({ spy: { phoneMusicEnabled: true } });
  const s5 = await formatSection(musicOnly.config, musicOnly.role);
  assert.ok(s5.includes(MUSIC), s5);
  assert.ok(s5.includes("每日推荐"), "网易云那条必须注入：\n" + s5);
  assert.ok(!s5.includes(CONTROL), "操控那条必须整条跳过（锁屏没开）：\n" + s5);
  assert.ok(!s5.includes("锁屏"), "操控那条一个字都不该剩：\n" + s5);
  assert.ok(!s5.includes("[查岗实时"), "屏幕那两行必须删掉：\n" + s5);
  /*
   * 「你看不到他的屏幕」这句归屏幕那条管，而屏幕全关时那条整条不注入 ——
   * 所以只开放歌时**谁都不该说这句话**。放歌那条替屏幕宣布状态是错的：
   * 用户可能同时开着电脑腿，那句话就成了假的。
   */
  assert.ok(
    !s5.includes("你看不到他的屏幕"),
    "放歌那条不该替屏幕那条宣布开关状态：\n" + s5
  );
  ok("只开放歌：操控那条整条跳过、网易云那条留着（共用同一个标签前缀也分得开）");

  // 反过来：只开操控，网易云那条要整条跳过
  const ctrlOnly = setup({ spy: { phoneControlEnabled: true } });
  const s6 = await formatSection(ctrlOnly.config, ctrlOnly.role);
  assert.ok(s6.includes(CONTROL), s6);
  assert.ok(s6.includes("锁屏"), "操控那条必须注入：\n" + s6);
  assert.ok(!s6.includes(MUSIC), "网易云那条必须整条跳过：\n" + s6);
  assert.ok(!s6.includes("每日推荐"), "网易云那条一个字都不该剩：\n" + s6);
  ok("只开操控：网易云那条整条跳过、操控那条留着");

  /*
   * 预设里的子条目开关是**第二道闸**，四条各管自己那一摊：关掉「放歌」那条，
   * 另外三条该照旧注入 —— 以前合成一条时关一下就全哑了，拆开之后不该再那样。
   */
  const childOff = setup({ spy: all });
  const fmt = childOff.preset.entries.find((e) => e.kind === "format");
  fmt.children.find((c) => c.kind === "spyMusic").enabled = false;
  const s4 = await formatSection(childOff.config, childOff.role);
  assert.ok(!s4.includes(MUSIC), "关掉的那条不该注入：\n" + s4);
  assert.ok(!s4.includes("每日推荐"), "关掉的那条一个字都不该剩：\n" + s4);
  for (const t of [SCREEN, VIEW, CONTROL]) {
    assert.ok(s4.includes(t), `只关了放歌那条，${t} 该照旧注入：\n` + s4);
  }
  ok("预设里的子条目开关按条各管一摊：关掉放歌那条，另外三条照旧注入");

  // 四条全关：角色开关全开也一条都不注入
  const allChildOff = setup({ spy: all });
  const fmt2 = allChildOff.preset.entries.find((e) => e.kind === "format");
  for (const k of ["spyScreen", "spyView", "spyControl", "spyMusic"]) {
    fmt2.children.find((c) => c.kind === k).enabled = false;
  }
  const s4b = await formatSection(allChildOff.config, allChildOff.role);
  assert.ok(noSpy(s4b), s4b);
  ok("四条子条目全关：角色开关全开也一条都不注入（两道闸都在）");

  // 预设歌单：配了就把名字列给模型，没配就明说这一项用不了
  const withList = setup({ spy: { phoneMusicEnabled: true } });
  withList.config.spyApi = { playlists: [{ name: "睡前", id: "123" }] };
  const s7 = await formatSection(withList.config, withList.role);
  assert.ok(s7.includes("睡前"), "配了的歌单名字该列给模型：\n" + s7);
  assert.ok(s7.includes("还没预设过歌单") === false, s7);
  const noList = setup({ spy: { phoneMusicEnabled: true } });
  noList.config.spyApi = { playlists: [] };
  const s8 = await formatSection(noList.config, noList.role);
  assert.ok(s8.includes("还没预设过歌单"), "一个都没配时该明说用不了：\n" + s8);
  ok("预设歌单：配了列名字，没配就明说这一项用不了");

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

  /*
   * legs 要用 spyLegs 现造，别手搓一个 `{pc:true,…}` —— 它还带着 `features`
   * （十九件事里活着的那些）和 `on()`，手搓的对象里那两样是空的，
   * trimSpyPrompt 会以为用户把所有单项都关了。
   */
  const allLegs = S.spyLegs({
    spy: {
      pcEnabled: true,
      phoneEnabled: true,
      phoneViewEnabled: true,
      phoneControlEnabled: true,
      phoneMusicEnabled: true,
    },
  });
  const untouched = "五个全开的时候一个字都不动";
  assert.equal(S.trimSpyPrompt(untouched, allLegs), untouched);
  ok("trimSpyPrompt 五个全开时原样返回");

  // 少一个就得补那句 —— 全开才是「一个字不动」的唯一条件
  const screensOnly = S.trimSpyPrompt(
    untouched,
    S.spyLegs({ spy: { pcEnabled: true, phoneEnabled: true } })
  );
  assert.ok(screensOnly.includes("补充"), screensOnly);
  assert.ok(screensOnly.includes("只能看他手机里") === false, screensOnly);
  ok("只开屏幕两条腿：正文原样留着，末尾补一句能用的标签");

  /*
   * 给了 kind 就只按那一条管的腿判。`spyScreen` 那条正文里压根没有手机那三行，
   * 所以手机三组关着对它来说不是「少开了几样」—— 它该原样返回，
   * 而不是补一句「你这一轮能用的标签只有屏幕那两个」。
   */
  const screenKind = S.trimSpyPrompt(
    untouched,
    S.spyLegs({ spy: { pcEnabled: true, phoneEnabled: true } }),
    { kind: "spyScreen" }
  );
  assert.equal(screenKind, untouched);
  ok("带 kind=spyScreen：手机那三组关着也原样返回（那条正文本来就不讲手机）");

  // 反过来：放歌那条不该因为屏幕没开就补话
  const musicKind = S.trimSpyPrompt(
    "放歌那条的正文",
    S.spyLegs({ spy: { phoneMusicEnabled: true } }),
    { kind: "spyMusic" }
  );
  assert.equal(musicKind, "放歌那条的正文");
  ok("带 kind=spyMusic：屏幕没开也原样返回，不替屏幕那条说话");

  // 单项被关掉时，那一条才补话 —— 而且只说自己那一组
  const someOff = S.spyLegs({
    spy: { phoneMusicEnabled: true, features: { musicFm: false } },
  });
  const musicTrimmed = S.trimSpyPrompt("放歌那条的正文", someOff, { kind: "spyMusic" });
  assert.ok(musicTrimmed.includes("补充"), musicTrimmed);
  assert.ok(!musicTrimmed.includes("私人漫游"), "关掉的那项不该出现：\n" + musicTrimmed);
  assert.ok(musicTrimmed.includes("每日推荐"), "留着的那项该列出来：\n" + musicTrimmed);
  ok("带 kind=spyMusic 且关了一项：补一句只讲网易云这一组能用哪几项");
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

console.log("\n[runPhone：四种结局，一律不抛错]");
{
  /*
   * runPhone 里真去做事的那一步是 spyrun.js:runByName（发邮件 + 等回传），
   * 这儿不碰它 —— 只测 runPhone 自己那几道判断：没开识图、名字对不上、
   * 越权（开关关着 pool 是空的）。这三条都在发邮件**之前**就返回了，
   * 所以不需要假 SMTP。
   */
  const allOn = {
    pcEnabled: true,
    phoneEnabled: true,
    phoneViewEnabled: true,
    phoneControlEnabled: true,
    phoneMusicEnabled: true,
  };
  const vision = { vision: { provider: "p-1", modelId: "vm", baseUrl: "x", key: "k" } };

  // 查看类没开识图模型：抓图之前就退出（别白唤醒用户手机一趟）
  const noVision = setup({ spy: allOn });
  const n1 = await S.runPhone(
    { kind: "view", keyword: "支付宝账单" },
    { role: noVision.role, eps: {}, spyApi: noVision.config.spyApi, userName: "小明", scope: "测试" }
  );
  assert.ok(n1.includes("没开识图模型"), n1);
  assert.ok(n1.includes("别告诉对方你在动他的手机"), "该走失败模板：\n" + n1);
  ok("查看类没开识图模型：不发邮件，直接给模型一句原因");

  // 名字对不上：把「能用的是……」原样交给模型，它下一轮就能改对
  const bad = setup({ spy: allOn });
  const n2 = await S.runPhone(
    { kind: "view", keyword: "手机屏幕" },
    { role: bad.role, eps: vision, spyApi: bad.config.spyApi, userName: "小明", scope: "测试" }
  );
  assert.ok(n2.includes("没有「手机屏幕」这个功能"), n2);
  assert.ok(n2.includes("支付宝账单"), "该把能用的那几项列给模型：\n" + n2);
  ok("名字对不上：把「能用的是…」透给模型，不是干巴巴一句没成");

  /*
   * 越权那一条 —— 这套里最要紧的判断：只开了放歌的用户，写 [操控手机:锁屏]
   * 必须匹配不上。匹配上了那部手机就真被锁了，而用户从没同意过这件事。
   */
  const musicOnly = setup({ spy: { phoneMusicEnabled: true } });
  const n3 = await S.runPhone(
    { kind: "control", keyword: "锁屏" },
    {
      role: musicOnly.role,
      eps: vision,
      spyApi: musicOnly.config.spyApi,
      userName: "小明",
      scope: "测试",
    }
  );
  assert.ok(n3.includes("没有「锁屏」这个功能"), "只开放歌时锁屏必须匹配不上：\n" + n3);
  assert.ok(!n3.includes("已经"), "不许走成功模板：\n" + n3);
  ok("只开放歌：[操控手机:锁屏] 匹配不上（没同意过的事一件都做不了）");

  // 三个手机开关全关：pool 空的，什么名字都匹配不上
  const phoneOff = setup({ spy: { pcEnabled: true, phoneEnabled: true } });
  const n4 = await S.runPhone(
    { kind: "view", keyword: "支付宝账单" },
    {
      role: phoneOff.role,
      eps: vision,
      spyApi: phoneOff.config.spyApi,
      userName: "小明",
      scope: "测试",
    }
  );
  assert.ok(n4.includes("没有「支付宝账单」这个功能"), n4);
  ok("查看开关关着：pool 是空的，屏幕开关开着也碰不到手机里的东西");

  ok("runPhone 从不抛错（上面四条都返回了给模型的话）");
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

console.log("\n[迁移：老配置里合在一起的那条 spy → 四条]");
{
  /** 归一化一份只有 `spy` 那条子条目的老预设，取回四条查岗子条目。 */
  const migrate = (child) => {
    const out = C.normalizeConfig({
      presets: [
        {
          id: "p-1",
          name: "老预设",
          entries: [{ id: "e-1", kind: "format", enabled: true, children: [child] }],
        },
      ],
    });
    const kids = out.presets[0].entries.find((e) => e.kind === "format").children;
    return Object.fromEntries(
      P.SPY_CHILD_KINDS.map((k) => [k, kids.find((c) => c.kind === k)])
    );
  };

  // 正文没改过（拆分前那一版五行的）→ 四条全给新默认值
  const clean = migrate({ kind: "spy", enabled: true, content: P.LEGACY_SPY_ONE_CHILD });
  for (const k of P.SPY_CHILD_KINDS) {
    assert.ok(clean[k], `${k} 该被建出来`);
    assert.equal(clean[k].enabled, true, `${k} 该继承老的 enabled`);
    assert.equal(clean[k].content, P.DEFAULT_FORMAT_CHILDREN[k], `${k} 该拿新默认正文`);
  }
  ok("老的 spy 正文没改过：拆成四条、全给新默认值");

  // 更老那一版（只有屏幕两行的）也要认
  const older = migrate({ kind: "spy", enabled: true, content: P.LEGACY_SPY_CHILD });
  assert.equal(older.spyScreen.content, P.DEFAULT_FORMAT_CHILDREN.spyScreen);
  ok("更老那版（只有屏幕两行）也认成没改过");

  /*
   * 用户改过的正文**不许丢** —— 这是整个迁移最要紧的一条：`spy` 已经不在
   * FORMAT_CHILD_KINDS 里，不接这一手的话他改过的字会被当未知 kind 静静扔掉。
   */
  const mine = "      查岗:\n        我自己改的一段话";
  const edited = migrate({ kind: "spy", enabled: true, content: mine });
  assert.equal(edited.spyScreen.content, mine, "改过的原文该整段留在屏幕那条里");
  for (const k of ["spyView", "spyControl", "spyMusic"]) {
    assert.equal(edited[k].content, P.DEFAULT_FORMAT_CHILDREN[k], `${k} 该拿新默认正文`);
    assert.ok(!edited[k].content.includes("我自己改的"), `${k} 不该跟着复制一份原文`);
  }
  ok("用户改过的正文：整段留在屏幕那条，另外三条给默认值（不重复注入四遍）");

  // 关着的查岗不该因为拆分自己开回来
  const wasOff = migrate({ kind: "spy", enabled: false, content: P.LEGACY_SPY_ONE_CHILD });
  for (const k of P.SPY_CHILD_KINDS) {
    assert.equal(wasOff[k].enabled, false, `${k} 该继承老的 enabled:false`);
  }
  ok("老配置里查岗是关着的：四条都跟着关（拆分不许替用户同意）");

  // 已经是新结构的配置原样不动
  const already = C.normalizeConfig({
    presets: [
      {
        id: "p-1",
        name: "新预设",
        entries: [
          {
            id: "e-1",
            kind: "format",
            enabled: true,
            children: [
              { kind: "spyMusic", enabled: false, content: "我改的放歌" },
              { kind: "spy", enabled: true, content: P.LEGACY_SPY_ONE_CHILD },
            ],
          },
        ],
      },
    ],
  });
  const kids2 = already.presets[0].entries.find((e) => e.kind === "format").children;
  const music2 = kids2.find((c) => c.kind === "spyMusic");
  assert.equal(music2.content, "我改的放歌", "新结构里的正文不许被老的 spy 冲掉");
  assert.equal(music2.enabled, false, "新结构里的开关也不许被冲掉");
  ok("已经是新结构的配置：手改出来的老 spy 冲不掉它");
}

console.log("\n[单项开关：组开着但某几项被关掉]");
{
  // 关掉一项：pool 里不许有它 —— 提示词只是不教，真正挡住靠这道闸
  const legs = S.spyLegs({
    spy: { phoneControlEnabled: true, features: { alarmOff: false } },
  });
  const pool = S.phonePool("control", legs);
  assert.ok(!pool.some((f) => f.key === "alarmOff"), "关掉的项不许留在 pool 里");
  assert.ok(pool.some((f) => f.key === "lock"), "没关的项该留着");
  ok("单项关掉：phonePool 挡住它（模型硬写也不生效）");

  // 缺 features 字段的老配置：十九件事全当开着
  const legacy = S.spyLegs({ spy: { phoneControlEnabled: true } });
  assert.equal(S.phonePool("control", legacy).length, 4, "缺键当开，控制类四项都在");
  ok("老配置没有 features 字段：十九件事全当开着（缺键当开）");

  // 一组里全关光：那一条整条不注入
  const allOff = S.spyLegs({
    spy: {
      phoneControlEnabled: true,
      features: { alarmSet: false, alarmOn: false, alarmOff: false, lock: false },
    },
  });
  assert.equal(S.phonePool("control", allOff).length, 0);
  assert.equal(S.trimSpyPrompt("操控那条正文", allOff, { kind: "spyControl" }), "");
  /*
   * 但组开关本身还是 true —— 「用户关了组」和「用户把组里的项一个个关光了」
   * 不是同一件事，界面要把他自己的选择原样显示回去（见 spy.js:spyLegs）。
   */
  assert.equal(allOff.control, true, "组开关不该被单项状态改写");
  ok("一组里全关光：那一条不注入，但组开关本身还是 true（界面要显示回去）");
}

console.log(`\n${passed} 项全部通过\n`);
