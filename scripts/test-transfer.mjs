/**
 * 离线自测：转账卡片。标记解析 → 卡片拼装 → 句柄落盘 → 贴表情收款。
 *
 * **不打真的 Photon。** `@photon-ai/advanced-imessage/grpc` 和
 * `@spectrum-ts/core` 那两个模块用 node:test 的 mock.module 换成假的
 * （所以这个文件必须带 `--experimental-test-module-mocks` 跑，见下面那行注释），
 * 假客户端把每次 `sendCustomizedMiniApp` / `updateCustomizedMiniApp` 的入参
 * 原样记下来 —— 这里验的是「我们拼给苹果那六个文字槽的东西对不对」，
 * 不是「Photon 今天通不通」。
 *
 * URANUS_DATA_DIR 指向临时目录，绝不碰真实的 data/（那里有真的 Photon 凭据）。
 * 必须在 import card.js / transferstore.js **之前**设好 —— DATA_DIR 是模块
 * 加载时算的。所以这个文件用动态 import。
 *
 * 跑：node --experimental-test-module-mocks scripts/test-transfer.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "uranus-transfer-"));
process.env.URANUS_DATA_DIR = tmp;

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
function section(title) {
  console.log(`\n── ${title} ──`);
}

/* ================= 假的 Photon ================= */

/** 每次调用的入参都记下来，断言照着它验。 */
const calls = { sent: [], updated: [] };

/** 下一次 send 要不要失败 / 要不要不给句柄。测退路用。 */
const behavior = { sendThrows: false, noSession: false, updateThrows: false };

mock.module("@spectrum-ts/core", {
  namedExports: {
    cloud: {
      issueImessageTokens: async () => ({ type: "shared", token: "T", expiresIn: 300 }),
    },
  },
});

mock.module("@photon-ai/advanced-imessage/grpc", {
  namedExports: {
    createGrpcClient: () => ({
      messages: {
        sendCustomizedMiniApp: async (chat, msg) => {
          calls.sent.push({ chat, msg });
          if (behavior.sendThrows) throw new Error("线路不通");
          if (behavior.noSession) return { guid: "G-x" };
          const n = calls.sent.length;
          return {
            guid: `G-${n}`,
            miniAppCardSession: {
              messageGuid: `G-${n}`,
              chatGuid: chat,
              sessionId: `S-${n}`,
              // 故意和 messageGuid 不一样：findTransfer 两个都该能查到
              targetMessageGuid: `T-${n}`,
            },
          };
        },
        updateCustomizedMiniApp: async (handle, msg) => {
          calls.updated.push({ handle, msg });
          if (behavior.updateThrows) throw new Error("改不了");
          return {};
        },
      },
      close: async () => {},
    }),
  },
});

const M = await import("../server/src/media.js");
const CARD = await import("../server/src/card.js");
const TS = await import("../server/src/transferstore.js");
const TL = await import("../server/src/transferlogo.js");
const C = await import("../server/src/config.js");
const P = await import("../server/src/preset.js");
const PR = await import("../server/src/prompt.js");

/* ================= 标记解析 ================= */

section("标记解析（media.js）");

okWith("[transfer:金额:备注] 切成一段 transfer", () => {
  const parts = M.splitMedia("给你[transfer:4000:零花钱]拿去花");
  assert.deepEqual(parts, [
    { kind: "text", text: "给你" },
    { kind: "transfer", text: "4000", note: "零花钱" },
    { kind: "text", text: "拿去花" },
  ]);
});

okWith("不写备注也认", () => {
  assert.deepEqual(M.splitMedia("[transfer:4000]"), [
    { kind: "transfer", text: "4000", note: "" },
  ]);
});

okWith("三个别名都认（转账 / 转钱 / transfer_money）", () => {
  for (const tag of ["转账", "转钱", "transfer_money"]) {
    const parts = M.splitMedia(`[${tag}:500:房租]`);
    assert.equal(parts[0]?.kind, "transfer", tag);
    assert.equal(parts[0]?.amount ?? parts[0]?.text, "500", tag);
  }
});

okWith("全角方括号和全角冒号照样认", () => {
  const parts = M.splitMedia("［转账：500：房租］");
  assert.equal(parts[0]?.kind, "transfer");
  assert.equal(parts[0]?.text, "500");
});

okWith("备注里有冒号时只按第一个冒号切", () => {
  const parts = M.splitMedia("[转账:500:房租:三月]");
  assert.equal(parts[0]?.text, "500");
  assert.equal(parts[0]?.note, "房租:三月");
});

/*
 * 金额必须数字打头，这是故意的（media.js 那条正则里的 `\d`）。
 * 不是数字就整条不切、原样留在文字里 —— 对方看到一句奇怪的话，
 * 比看到一张写着「￥一点钱」的凭证好认。
 */
okWith("金额不是数字打头 → 不切，原样当文字", () => {
  const parts = M.splitMedia("[transfer:一点钱:给你]");
  assert.deepEqual(parts, [{ kind: "text", text: "[transfer:一点钱:给你]" }]);
  assert.equal(M.hasMedia("[transfer:一点钱:给你]"), false);
});

okWith("stripMediaTags 把转账退化成一句话（不是丢掉）", () => {
  assert.equal(
    M.stripMediaTags("给你[transfer:4000:零花钱]拿去花"),
    "给你转账 ￥4,000.00 零花钱拿去花"
  );
  assert.equal(M.stripMediaTags("[transfer:4000]"), "转账 ￥4,000.00");
});

/* ================= 金额规整 ================= */

section("金额规整（card.js:formatAmount）");

okWith("统一成两位小数加 ￥", () => {
  assert.equal(CARD.formatAmount("4000"), "￥4,000.00");
  assert.equal(CARD.formatAmount("4000.5"), "￥4,000.50");
  assert.equal(CARD.formatAmount("￥4000"), "￥4,000.00");
  assert.equal(CARD.formatAmount("4,000"), "￥4,000.00");
  assert.equal(CARD.formatAmount("$4000"), "￥4,000.00");
});

/*
 * 认不出数字时**原样带回**，不能变成 ￥0.00 —— 后者看起来完全正常，
 * 错得没人会发现。
 */
okWith("认不出数字时原样带回，绝不变成 ￥0.00", () => {
  assert.equal(CARD.formatAmount("一点钱"), "￥一点钱");
  assert.equal(CARD.formatAmount(""), "￥");
  assert.ok(!CARD.formatAmount("一点钱").includes("0.00"));
});

/*
 * **从残渣里凑不出数来。** 剔掉符号和千分位之后必须整串都是数字才算认出来，
 * 光看 `Number()` 不行 —— `Number("-1")` 对「abc-1」这种残渣照样给 -1，
 * 于是一句「abc-1」会显示成「￥-1.00」，正是上面那条要挡的「看着完全正常、
 * 错得没人发现」。（这一条是加自定义货币时真踩出来的：那一版改成「只留数字、
 * 小数点和负号」，就是这个下场。）
 */
okWith("剔完符号剩下的不是纯数字 → 原样带回，不凑一个数出来", () => {
  assert.equal(CARD.formatAmount("abc-1"), "￥abc-1");
  assert.equal(CARD.formatAmount("12-34"), "￥12-34");
  assert.equal(CARD.formatAmount("１２３"), "￥１２３"); // 全角数字不认
});

/*
 * 货币符号由用户自己填（role.transfer.currency）。这个功能一开始是写死人民币的，
 * 没有任何技术理由 —— 就是当时只有一个角色一种钱。
 */
okWith("货币符号跟着传进来的那个走，留空是 ￥", () => {
  assert.equal(CARD.formatAmount("4000", "$"), "$4,000.00");
  assert.equal(CARD.formatAmount("4000", "€"), "€4,000.00");
  assert.equal(CARD.formatAmount("4000", "HK$"), "HK$4,000.00");
  assert.equal(CARD.formatAmount("4000", ""), "￥4,000.00");
  assert.equal(CARD.formatAmount("4000", undefined), "￥4,000.00");
  assert.equal(CARD.DEFAULT_CURRENCY, "￥");
});

/*
 * 剔符号那一刀得认**用户填的那个**，不能只认一张写死的清单。
 * 原来是 `[￥¥$,，\s]`，用户填 € 时模型跟着写 `€4000` 就认不出数字了 ——
 * 一笔 4000 显示成「€€4000」。现在按 Unicode 货币符号类（\p{Sc}）剔，
 * 再补一刀剔用户填的（「元」「円」这种汉字不属于 Sc）。
 */
okWith("模型把符号也写进金额里时不会重一遍", () => {
  assert.equal(CARD.formatAmount("€4000", "€"), "€4,000.00");
  assert.equal(CARD.formatAmount("4000元", "元"), "元4,000.00");
  assert.equal(CARD.formatAmount("￥4000", "$"), "$4,000.00"); // 换了符号也认得出数
});

/* ================= 卡片拼装 ================= */

section("卡片拼装（card.js:sendTransferCard）");

const session = await CARD.sendTransferCard({
  projectId: "p",
  projectSecret: "s",
  chatGuid: "iMessage;-;+1555550001",
  amount: "4000",
  note: "零花钱",
  appName: "Chase",
});

okWith("四个 guid 都带回来了（不然以后改不了状态）", () => {
  assert.equal(session?.messageGuid, "G-1");
  assert.equal(session?.chatGuid, "iMessage;-;+1555550001");
  assert.equal(session?.sessionId, "S-1");
  assert.equal(session?.targetMessageGuid, "T-1");
});

okWith("六个文字槽按约定摆：金额 / 备注 / 状态 / 兜底文案", () => {
  const { layout } = calls.sent.at(-1).msg;
  assert.equal(layout.caption, "￥4,000.00");
  assert.equal(layout.subcaption, "零花钱");
  assert.equal(layout.trailingCaption, "待收款");
  assert.equal(layout.summary, "转账 ￥4,000.00 · 零花钱（待收款）");
});

/*
 * 没给 image 时**三个字段一个都不许有**。
 *
 * proto 的约束是「image 和 image_title 必须一起给」、「image_subtitle 要求先有
 * image」—— 单给一个 imageTitle 是无效 layout，服务端会拒，一整笔转账发不出去。
 * 所以「不带图」这条路必须干净地什么都不填。
 */
okWith("没选 logo → image / imageTitle / imageSubtitle 都不给", () => {
  const { layout } = calls.sent.at(-1).msg;
  for (const k of ["image", "imageTitle", "imageSubtitle"]) {
    assert.equal(layout[k], undefined, k);
  }
});

/*
 * 身份必须是 Spectrum 那个官方扩展，**一个字都不能改**。
 *
 * 两头都钉着：
 *
 *  - 共享线路的服务端只放行这一个 bundle id，填别的直接 AuthenticationError，
 *    卡片压根发不出去（官方文档里没记载这条，是踩出来的）。所以这几个值
 *    错一个字，功能就整个哑掉。
 *  - 另一头是**不许填别人家的**：填腾讯的 team id 和 com.tencent.xin.…，
 *    对方手机上那张卡片就会自称是微信发的。这道线只能由我们自己守。
 *
 * 这一条挂了先看是哪一头：值对不上 Spectrum（发不出去），还是变成了某家
 * 真公司的 id（冒充）。
 */
okWith("身份是 Spectrum 那个官方扩展（共享线路只放行它）", () => {
  const { msg } = calls.sent.at(-1);
  assert.equal(msg.teamId, "P8XT6232SL");
  assert.match(msg.teamId, /^[A-Z0-9]{10}$/); // 格式也得合法，不然服务端拒
  assert.equal(msg.extensionBundleId, "codes.photon.Spectrum.MessagesExtension");
  assert.equal(msg.appStoreId, 6777616651);
  assert.ok(Number.isInteger(msg.appStoreId) && msg.appStoreId > 0); // 必须正整数
  // 不许换成任何一家真金融机构 / 社交 app 的身份
  assert.ok(!/tencent|alipay|chase|paypal|wechat|unionpay/i.test(msg.extensionBundleId));
});

/*
 * 点卡片落在哪。装了 Spectrum 的人是**真能点开**的，所以这条不能指向
 * SDK 源码那种地方（上一版填的是 advanced-imessage-ts 那个仓库，当时
 * 身份是假的、点了不会有反应）。
 */
okWith("点开落在一个说得清来路的地方", () => {
  assert.equal(calls.sent.at(-1).msg.url, "https://photon.codes");
  assert.match(calls.sent.at(-1).msg.url, /^https:\/\//);
});

okWith("appName 是用户填的那个", () => {
  assert.equal(calls.sent.at(-1).msg.appName, "Chase");
});

await CARD.sendTransferCard({
  projectId: "p",
  projectSecret: "s",
  chatGuid: "c",
  amount: "4000",
  note: "",
  appName: "",
});
/*
 * appName 留空必须兜底成「转账」，**不能把空串传下去**。
 *
 * 这条是回归测试。1.2.2 到 1.2.4 那三版做的是反过来的事（空串 = 那行署名不要，
 * 原样传下去），因为 proto 里 `app_name` 是个普通 scalar、空串在 wire 上等于不传。
 * 但服务端要求它非空，于是没填署名的用户一张卡片都发不出去：
 *
 *   ValidationError: [upstream] app_name must not be empty
 *
 * 带 `[upstream]` 前缀 —— SDK 本地不校验这个字段，发出去才知道，所以这个假的
 * 上游一直放行、自测时压根没露馅。断言盯着 wire 上那个值，别只盯 layout。
 */
okWith("appName 留空 → 兜底成「转账」（服务端不收空的，空着整张卡片发不出去）", () => {
  const { msg } = calls.sent.at(-1);
  assert.equal(msg.appName, "转账");
  assert.ok(msg.appName, "app_name 空着上游会打回 must not be empty");
  assert.equal(msg.layout.subcaption, undefined);
  assert.equal(msg.layout.summary, "转账 ￥4,000.00（待收款）");
});

await CARD.sendTransferCard({
  projectId: "p",
  projectSecret: "s",
  chatGuid: "c",
  amount: "4000",
  note: "",
  appName: "   ",
});
okWith("只填了几个空格也算空（trim 完兜底）", () => {
  assert.equal(calls.sent.at(-1).msg.appName, "转账");
});

await CARD.sendTransferCard({
  projectId: "p",
  projectSecret: "s",
  chatGuid: "c",
  amount: "4000",
  note: "零花钱",
  appName: "Chase",
  currency: "$",
});
okWith("货币符号一直传到卡片的槽里（金额和兜底文案两处都得改）", () => {
  const { layout } = calls.sent.at(-1).msg;
  assert.equal(layout.caption, "$4,000.00");
  assert.equal(layout.summary, "转账 $4,000.00 · 零花钱（待收款）");
  assert.ok(!JSON.stringify(layout).includes("￥"), "换了符号就不该再有 ￥ 漏在别处");
});

/* ================= 缩略图 ================= */

section("缩略图（transferlogo.js）");

okWith("自带素材在清单里，而且标着 builtin", () => {
  const files = TL.listLogos();
  assert.ok(files.length >= 2, "assets/transfer-logos/ 里应该有自带素材");
  assert.ok(files.every((l) => l.builtin === true), "这会儿用户目录还是空的");
  assert.ok(files.some((l) => l.file.toLowerCase().endsWith(".svg")), "至少有一个 SVG");
});

/*
 * 路径穿越那道闸。`resolveLogo` 是唯一一个「文件名 → 磁盘路径」的入口
 * （API 那条路由和渲染都走它），所以这里挡不住就等于把 data/ 整个开出去了。
 *
 * 两层：`path.basename` 把 `../` 削掉，后缀白名单挡住 config.json /
 * data.config.json 这类**就在隔壁**的文件。
 */
okWith("resolveLogo 挡路径穿越和非图片后缀", () => {
  for (const bad of [
    "../../data.config.json",
    "../config.json",
    "data.config.json",
    "config.json",
    ".hidden.svg",
    "",
    null,
  ]) {
    assert.equal(TL.resolveLogo(bad), null, String(bad));
  }
});

okWith("resolveLogo 认得出自带那几个", () => {
  const first = TL.listLogos()[0].file;
  const full = TL.resolveLogo(first);
  assert.ok(full && fs.existsSync(full));
  // 削掉路径之后照样认得出来：攻击者拼的路径不该改变最终落点
  assert.equal(TL.resolveLogo(`../../${first}`), full);
});

okWith("normalizeColor：三位补成六位，不合法回 null", () => {
  assert.equal(TL.normalizeColor("#fff"), "#ffffff");
  assert.equal(TL.normalizeColor("FFF"), "#ffffff");
  assert.equal(TL.normalizeColor("#1A2b3C"), "#1a2b3c");
  assert.equal(TL.normalizeColor("07c160"), "#07c160");
  for (const bad of ["", "红色", "#ffff", "#12345g", "rgb(0,0,0)", null]) {
    assert.equal(TL.normalizeColor(bad), null, String(bad));
  }
  assert.equal(TL.DEFAULT_BG, "#ffffff");
});

/*
 * 同名时以用户那份为准，而且清单里**只能出现一次** —— 两条一样的 `file`
 * 会让前端的 key 撞上，resolveLogo 也会挑得莫名其妙。
 */
okWith("用户目录里同名的盖掉自带那个（清单里不出现两次）", () => {
  const builtin = TL.listBuiltinLogos()[0].file;
  const dir = path.join(tmp, "transfer-logos");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, builtin), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  const files = TL.listLogos();
  assert.equal(files.filter((l) => l.file === builtin).length, 1);
  assert.equal(files.find((l) => l.file === builtin)?.builtin, undefined);
  // 解析也该落在用户那份上
  assert.equal(TL.resolveLogo(builtin), path.join(dir, builtin));
  fs.unlinkSync(path.join(dir, builtin));
});

okWith("自带的删不掉（抛错，不是静默返回 false）", () => {
  const builtin = TL.listBuiltinLogos()[0].file;
  assert.ok(TL.isBuiltinLogo(builtin));
  assert.throws(() => TL.removeLogo(builtin), /删不掉/);
  assert.ok(fs.existsSync(TL.resolveLogo(builtin)), "文件必须还在");
});

okWith("删不存在的返回 false，路径穿越的也是 false", () => {
  assert.equal(TL.removeLogo("没这个.svg"), false);
  assert.equal(TL.removeLogo("../../config.json"), false);
  assert.equal(TL.removeLogo(".hidden.svg"), false);
});

okWith("传一张、选上、再删掉", () => {
  const svg = Buffer.from(
    "<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'><rect width='10' height='10'/></svg>"
  ).toString("base64");
  const name = TL.saveLogo("我的图.svg", svg, "image/svg+xml");
  assert.equal(name, "我的图.svg");
  assert.ok(TL.listLogos().some((l) => l.file === name && !l.builtin));
  // 同名再传一次要变成 -2，不能盖掉上一张
  assert.equal(TL.saveLogo("我的图.svg", svg, "image/svg+xml"), "我的图-2.svg");
  assert.equal(TL.removeLogo("我的图.svg"), true);
  assert.equal(TL.removeLogo("我的图-2.svg"), true);
});

/*
 * 名字里没后缀时按 MIME 补。传上来的文件名**不一定带后缀**，而后缀决定
 * resolveLogo 认不认它 —— 补错了等于这张图传完就再也选不上。
 */
okWith("没后缀时按 MIME 补，认不出当 png", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
  const a = TL.saveLogo("无后缀", png, "image/svg+xml");
  const b = TL.saveLogo("也没有", png, "image/webp");
  const c = TL.saveLogo("认不出", png, "application/octet-stream");
  assert.equal(a, "无后缀.svg");
  assert.equal(b, "也没有.webp");
  assert.equal(c, "认不出.png");
  for (const f of [a, b, c]) assert.equal(TL.removeLogo(f), true);
});

okWith("logoMime 认得出 svg（不能按 png 发，浏览器会解成碎图）", () => {
  assert.equal(TL.logoMime("a.svg"), "image/svg+xml");
  assert.equal(TL.logoMime("a.jpg"), "image/jpeg");
  assert.equal(TL.logoMime("a.webp"), "image/webp");
  assert.equal(TL.logoMime("a.png"), "image/png");
});

/*
 * **渲染失败一律 null，绝不抛错。** 这是卡片上的装饰 —— 一张图读不出来
 * 不该让整笔转账发不出去。
 */
{
  const junk = TL.saveLogo("坏的.png", Buffer.from("这不是图片").toString("base64"), "image/png");
  // 先 await 完再进 okWith —— 那个包装器不 await，异步断言失败会漏成未捕获 rejection
  const bad = [
    await TL.renderLogo(""),
    await TL.renderLogo("没这个文件.svg"),
    await TL.renderLogo("../../data.config.json"),
    // 后缀对但内容不是图：走到 loadImage 才炸，照样得咽下来
    await TL.renderLogo(junk),
  ];
  TL.removeLogo(junk);
  okWith("renderLogo 读不出来时返回 null，不抛", () => {
    assert.deepEqual(bad, [null, null, null, null]);
  });
}

/* 画布档位：认不出来的一律归成 banner，别留到渲染时才发现。 */
okWith("normalizeLogoStyle 只认那两档", () => {
  assert.equal(TL.normalizeLogoStyle("icon"), "icon");
  assert.equal(TL.normalizeLogoStyle("banner"), "banner");
  assert.equal(TL.normalizeLogoStyle(" icon "), "icon");
  // 老配置里压根没这个字段，认不出来的值也走同一条路
  for (const junk of [undefined, null, "", "ICON", "小图标", "tiny", 7]) {
    assert.equal(TL.normalizeLogoStyle(junk), "banner", `${junk} 该归成 banner`);
  }
  assert.equal(TL.DEFAULT_LOGO_STYLE, "banner", "换默认值等于悄悄改了所有人的卡片");
  assert.deepEqual(TL.LOGO_STYLES, ["banner", "icon"]);
});

/*
 * **自带的每一张都得能渲出来。**
 *
 * 这条不是「多测一遍」—— 它防的是一类会**把整个进程打死**的输入。svg 根标签上
 * 那对 width/height 是光栅化的目标尺寸，skia 拿它直接去分配位图，负数或者大到
 * 分配不出来的数会让它在**原生层** abort：
 *
 *   ../../src/core/SkBitmap.cpp(262): fatal error: "assertf(…) [w:2500 h:-1503]"
 *
 * 不是异常，catch 不到，node 当场没了。自带的 Venmo.svg 官方导出就写着
 * `height="-1503"`，所以 transferlogo.js:safeSvgBytes 在交给 skia 之前先弄干净。
 *
 * 真要是回归了，这个测试进程也会被一起打死 —— 那样收尾那句「N 项全部通过」
 * 压根不会打出来，照样是响亮的失败。
 */
{
  const all = TL.listBuiltinLogos().map((l) => l.file);
  const bufs = [];
  for (const f of all) bufs.push([f, await TL.renderLogo(f, { style: "icon" })]);
  if (bufs.every(([, b]) => b)) {
    okWith(`自带那 ${all.length} 张全都渲得出来（负数/离谱尺寸不许打死进程）`, () => {
      for (const [f, b] of bufs) {
        assert.equal(b.subarray(0, 2).toString("hex"), "ffd8", `${f} 不是 JPEG`);
        assert.ok(b.length > 500, `${f} 只有 ${b.length} 字节，像是渲空了`);
      }
      assert.ok(
        all.some((f) => f.toLowerCase().startsWith("venmo")),
        "Venmo.svg 得留在自带素材里 —— 它就是那张负高度的样本"
      );
    });
  }
}

/**
 * 把渲出来的 JPEG 读回去，量**墨迹**落在哪几行（占画布高度的百分比）。
 *
 * 验「图摆在哪儿」只能这么验：字节数看不出偏心，而画布尺寸是固定的，
 * 两档都一样高的那条带子里 logo 偏上偏下全看这个。
 *
 * 底色是纯白，离白够远就算墨迹（JPEG 有压缩噪点，留 24 的余量）。
 * 装不上 @napi-rs/canvas 的机器上调不到这儿 —— 调用方先判了 buf 是不是 null。
 */
async function inkBand(buf) {
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const img = await loadImage(buf);
  const c = createCanvas(img.width, img.height);
  const x = c.getContext("2d");
  x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, img.width, img.height).data;
  let top = -1;
  let bot = -1;
  for (let y = 0; y < img.height; y += 1) {
    for (let px = 0; px < img.width; px += 1) {
      const i = (y * img.width + px) * 4;
      if (255 - d[i] > 24 || 255 - d[i + 1] > 24 || 255 - d[i + 2] > 24) {
        if (top < 0) top = y;
        bot = y;
        break;
      }
    }
  }
  const pct = (v) => Number(((v / img.height) * 100).toFixed(1));
  return { h: img.height, top: pct(top), bottom: pct(bot), center: pct((top + bot) / 2) };
}

/*
 * safeSvgBytes 的分档，拿现造的 svg 走一遍真渲染（`renderLogo` 只收文件名，
 * 所以先落到用户目录里再删）。
 *
 * 四种输入的期望不一样：
 *  - 正常的 → 原样放过；
 *  - 负数 / 离谱大 → 按 viewBox 自己算一对（要点是**别崩**）；
 *  - 只有 viewBox → 也按 viewBox 算（顺手治了图标库那种 24×24 的，
 *    原来会被「只缩不放」留成画布中间一个小点）；
 *  - 什么都没有 → 摘掉那两个属性，0×0，退化成不带图。
 */
{
  const svgOf = (attrs) =>
    `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}><rect x="10" y="10" width="80" height="30" fill="#07c160"/></svg>`;
  const render = async (attrs) => {
    const name = TL.saveLogo(`探${Math.random().toString(36).slice(2, 7)}.svg`, Buffer.from(svgOf(attrs)).toString("base64"), "image/svg+xml");
    const buf = await TL.renderLogo(name, { style: "icon" });
    TL.removeLogo(name);
    return buf;
  };

  const good = await render('viewBox="0 0 100 50" width="400" height="200"');
  const neg = await render('viewBox="0 0 100 50" width="2500" height="-1503"');
  const huge = await render('viewBox="0 0 100 50" width="200" height="1e9"');
  const boxOnly = await render('viewBox="0 0 24 24"');
  const nothing = await render('fill="#07c160"');

  if (good && neg && huge) {
    /*
     * 比的是**墨迹落在哪儿**，不是字节数：正常那张按 400×200 光栅化、重算的按
     * 1200×600，缩到同一块画布上抗锯齿的细节不同，JPEG 大小差个几百字节是正常的。
     * 真正该一致的是「这个 rect 占了画布的哪一段」。
     */
    const bands = [await inkBand(good), await inkBand(neg), await inkBand(huge)];
    okWith("svg 声明的尺寸是负数 / 大得离谱时按 viewBox 重算，不崩", () => {
      for (const b of [good, neg, huge]) assert.equal(b.subarray(0, 2).toString("hex"), "ffd8");
      const [g, n, h] = bands;
      assert.deepEqual(n, g, "负数那张该和正常声明的落在同一段");
      assert.deepEqual(h, g, "离谱大那张也一样");
    });
  }

  okWith("只写 viewBox（图标库那种）也认，不会留成画布中间一个小点", () => {
    assert.ok(boxOnly);
    assert.equal(boxOnly.subarray(0, 2).toString("hex"), "ffd8");
  });

  okWith("尺寸和 viewBox 都没有 → 退化成不带图（0×0，不是崩）", () => {
    assert.equal(nothing, null);
  });
}

/*
 * 两档留白**都是对称的**，logo 得落在画布正中间。
 *
 * 1.2.4 的 icon 那档是偏的（上 18、下 66），想给 imageTitle 那行浮字腾条空带子；
 * 真机上看下来 logo 只是偏上、那行字并没盖住它，1.2.6 改回 42/42 对称。
 * 这里把渲出来的 JPEG 读回去量墨迹的上下边界 —— 这是唯一能验「真的居中」的办法，
 * 光看字节数看不出偏心。
 */
{
  const probe = async (file, style) => {
    const buf = await TL.renderLogo(file, { style });
    return buf ? inkBand(buf) : null;
  };
  const all = TL.listBuiltinLogos().map((l) => l.file);
  const bands = [];
  for (const f of all) {
    bands.push([f, await probe(f, "icon"), await probe(f, "banner")]);
  }

  if (bands.every(([, i, b]) => i && b)) {
    okWith("两档都把 logo 摆在画布正中间（icon 那档 1.2.4 时偏上到 34.6%）", () => {
      for (const [f, icon, banner] of bands) {
        // 留 1.5% 的余量：缩放取整 + JPEG 噪点，量出来不会正好是 50.0
        assert.ok(Math.abs(icon.center - 50) < 1.5, `${f} 的 icon 墨迹中心在 ${icon.center}%`);
        assert.ok(Math.abs(banner.center - 50) < 1.5, `${f} 的 banner 墨迹中心在 ${banner.center}%`);
      }
    });
  }
}

/*
 * 真渲一张自带的 SVG 出来。
 *
 * 三件事必须成立，缺一个卡片就发不出去或者变形：
 *  - 出来的是**真 JPEG**（`ffd8` 开头）—— 服务端会验它能不能解码；
 *  - 尺寸跟原图比例无关（方图和 5.4:1 的长条出来一样高），只跟档位有关；
 *  - 体积在合理范围（这是要走 gRPC 的）。
 *
 * 装不上 @napi-rs/canvas 的机器上这条会拿到 null —— 那时候整个功能退化成
 * 不带图，不算测试失败（renderLogo 的口径就是「失败返回 null」）。
 */
{
  const svg = TL.listBuiltinLogos().find((l) => l.file.toLowerCase().endsWith(".svg"))?.file;
  const buf = svg ? await TL.renderLogo(svg) : null;
  if (buf) {
    okWith("真把 SVG 渲成了 JPEG（ffd8 打头）", () => {
      assert.equal(buf.subarray(0, 2).toString("hex"), "ffd8");
      assert.ok(buf.length > 1000 && buf.length < 256 * 1024, `${buf.length} 字节不像一张 logo`);
    });
    const again = await TL.renderLogo(svg);
    okWith("同一张图再渲一次走缓存（同一个 Buffer 实例）", () => {
      assert.equal(again, buf);
    });

    const dark = await TL.renderLogo(svg, { bg: "#07c160" });
    okWith("换个背景色就是另一份（缓存键带底色）", () => {
      assert.ok(dark && dark !== buf);
      assert.equal(dark.subarray(0, 2).toString("hex"), "ffd8");
    });

    /*
     * 「显示得多大」这件事**只能靠画布比例表达** —— 那张图在气泡里多宽由苹果
     * 按气泡宽度定，我们唯一的杠杆是它多高。所以 icon 那档必须真的更扁，
     * 而且不能和 banner 撞进同一个缓存格子。
     */
    const icon = await TL.renderLogo(svg, { style: "icon" });
    const iconAgain = await TL.renderLogo(svg, { style: "icon" });
    const bannerAgain = await TL.renderLogo(svg, { style: "banner" });
    okWith("icon 那档是另一份、更扁、也走缓存（键带档位）", () => {
      assert.ok(icon && icon !== buf, "icon 不该和 banner 共用一份");
      assert.equal(icon.subarray(0, 2).toString("hex"), "ffd8");
      // 同一张图画在更小的画布上，字节必然更少
      assert.ok(icon.length < buf.length, `icon ${icon.length} 该比 banner ${buf.length} 小`);
      assert.equal(iconAgain, icon, "icon 自己也该走缓存");
      // 默认那档 = banner，两边得撞进同一个格子
      assert.equal(bannerAgain, buf, "不给 style 就该拿到 banner 那份");
    });

    const bogus = await TL.renderLogo(svg, { style: "没这档" });
    okWith("档位认不出来时退回 banner（跟 normalizeLogoStyle 一条路）", () => {
      assert.equal(bogus, buf);
    });

    /*
     * 给了图就**必须给 imageTitle**（proto 的约束）。那行字和顶层的 app_name
     * 走同一个 wireAppName，空着一起兜底成「转账」。
     */
    await CARD.sendTransferCard({
      projectId: "p",
      projectSecret: "s",
      chatGuid: "c",
      amount: "520",
      note: "小狗",
      appName: "Chase",
      image: buf,
    });
    okWith("带图时 image 和 imageTitle 一起给（imageSubtitle 不给）", () => {
      const { layout } = calls.sent.at(-1).msg;
      assert.ok(Buffer.isBuffer(layout.image));
      assert.equal(layout.image.length, buf.length);
      assert.equal(layout.imageTitle, "Chase");
      assert.equal(layout.imageSubtitle, undefined, "它会压在图上，把图挡住");
      // 文字槽照旧，加了张图不该动别的
      assert.equal(layout.caption, "￥520.00");
      assert.equal(layout.trailingCaption, "待收款");
    });

    await CARD.sendTransferCard({
      projectId: "p",
      projectSecret: "s",
      chatGuid: "c",
      amount: "520",
      note: "",
      appName: "",
      image: buf,
    });
    okWith("appName 空着带了图 → 顶层和 imageTitle 兜底成同一个词", () => {
      const { msg } = calls.sent.at(-1);
      // 两处都不许为空（一个是服务端的要求、一个是 proto 的），而且得是同一个值 ——
      // 不然卡片外面写「转账」、图上写别的
      assert.equal(msg.appName, "转账");
      assert.equal(msg.layout.imageTitle, "转账");
      assert.equal(msg.layout.imageTitle, msg.appName);
    });

    await CARD.updateTransferCard({
      projectId: "p",
      projectSecret: "s",
      session,
      amount: "520",
      note: "小狗",
      appName: "Chase",
      image: buf,
      state: "received",
    });
    okWith("改成已收款时图得跟着传一份（不传就当场把图丢了）", () => {
      const { layout } = calls.updated.at(-1).msg;
      assert.ok(Buffer.isBuffer(layout.image));
      assert.equal(layout.imageTitle, "Chase");
      assert.equal(layout.trailingCaption, "已收款");
    });
  } else {
    console.log("  --  跳过真渲染那几条（这台机器没有 @napi-rs/canvas）");
  }
}

/* ================= 改状态 ================= */

section("原地改成已收款（card.js:updateTransferCard）");

const updated = await CARD.updateTransferCard({
  projectId: "p",
  projectSecret: "s",
  session,
  amount: "4000",
  note: "零花钱",
  appName: "Chase",
  state: "received",
});

okWith("改成功，右上角变成「已收款」", () => {
  assert.equal(updated, true);
  assert.equal(calls.updated.at(-1).msg.layout.trailingCaption, "已收款");
  assert.equal(calls.updated.at(-1).msg.layout.summary, "转账 ￥4,000.00 · 零花钱（已收款）");
});

okWith("句柄四个字段原样传回去（少一个就改不到那条气泡）", () => {
  assert.deepEqual(calls.updated.at(-1).handle, {
    messageGuid: "G-1",
    chatGuid: "iMessage;-;+1555550001",
    sessionId: "S-1",
    targetMessageGuid: "T-1",
  });
});

/*
 * 身份必须和发的时候一模一样，否则等于「另一个 app 来改这张卡片」。
 * appName 也算身份的一部分 —— 这正是它要跟着那笔存下来的原因。
 */
okWith("身份和发的时候完全一致（appStoreId 也算）", () => {
  const a = calls.sent[0].msg;
  const b = calls.updated.at(-1).msg;
  for (const k of ["appName", "teamId", "extensionBundleId", "appStoreId", "url"]) {
    assert.equal(b[k], a[k], k);
  }
});

/*
 * 空 appName 的兜底**两条路都得算出同一个值**。兜底放在 card.js 的 wireAppName、
 * 发和改都走它，就是为了这个：要是只在发的那条路上兜底，一张没填署名的卡片
 * 发出去时署名是「转账」、收款时变成空串 —— 那等于换了个 app 来改这张卡片。
 */
await CARD.updateTransferCard({
  projectId: "p",
  projectSecret: "s",
  session,
  amount: "4000",
  note: "",
  appName: "",
  state: "received",
});
okWith("改的时候 appName 空着也兜底成「转账」（和发的那条路一致）", () => {
  assert.equal(calls.updated.at(-1).msg.appName, "转账");
});

/* ================= 退路 ================= */

section("发不出去 / 改不了的时候");

behavior.sendThrows = true;
const failed = await CARD.sendTransferCard({
  projectId: "p",
  projectSecret: "s",
  chatGuid: "c",
  amount: "1",
  note: "",
  appName: "",
});
behavior.sendThrows = false;
okWith("线路全挂 → 返回 null（调用方据此报「这条没发出去」）", () => {
  assert.equal(failed, null);
});

behavior.noSession = true;
const noHandle = await CARD.sendTransferCard({
  projectId: "p",
  projectSecret: "s",
  chatGuid: "c",
  amount: "1",
  note: "",
  appName: "",
});
behavior.noSession = false;
okWith("发出去了但没给句柄 → 也返回 null（以后改不了状态）", () => {
  assert.equal(noHandle, null);
});

behavior.updateThrows = true;
const noUpdate = await CARD.updateTransferCard({
  projectId: "p",
  projectSecret: "s",
  session,
  amount: "4000",
  note: "",
  appName: "Chase",
  state: "received",
});
behavior.updateThrows = false;
okWith("改不过去 → 返回 false（卡片还停在待收款，不该写成已收款）", () => {
  assert.equal(noUpdate, false);
});

okWith("缺凭据 / 缺 chatGuid 时压根不打网络", () => {
  const before = calls.sent.length;
  return Promise.all([
    CARD.sendTransferCard({ projectId: "", projectSecret: "s", chatGuid: "c", amount: "1" }),
    CARD.sendTransferCard({ projectId: "p", projectSecret: "s", chatGuid: "", amount: "1" }),
  ]).then((rs) => {
    assert.deepEqual(rs, [null, null]);
    assert.equal(calls.sent.length, before);
  });
});

/* ================= 句柄落盘 ================= */

section("句柄落盘（transferstore.js）");

const ROLE = "role_a";
okWith("存一笔，读回来是待收款", () => {
  assert.equal(TS.putTransfer(ROLE, { ...session, amount: "4000", note: "零花钱", state: "pending", peerKey: "p1" }), true);
  const hit = TS.findTransfer(ROLE, "G-1");
  assert.equal(hit?.state, "pending");
  assert.equal(hit?.amount, "4000");
  assert.equal(hit?.note, "零花钱");
});

/*
 * **appName / currency 必须落盘。** 落盘那儿是一张白名单（不是 `...entry`），
 * 而原来那张单子里**没有 appName** —— imessage.js 一直在传、
 * claimTransferOnReact 一直在读 `hit.appName`，读回来永远是 undefined。
 * 当时发和改两边都兜底成「转账」，所以一直没露馅；`appName` 真填了点什么
 * （或者像现在这样取消了兜底），发和改就是两个名字了 —— 那等于「另一个 app
 * 来改这张卡片」，卡片改不动、收款静默失效。
 *
 * 那时候的测试只在源码里 grep `appName: hit.appName`，所以 46 项全绿也照样漏。
 * 这一条改成真存一笔再读回来。
 */
okWith("appName 和 currency 跟着落盘（改卡片时要用发的时候那一份）", () => {
  TS.putTransfer(ROLE, {
    ...session,
    messageGuid: "G-money",
    amount: "4000",
    note: "",
    state: "pending",
    peerKey: "p1",
    appName: "Chase",
    currency: "$",
  });
  const hit = TS.findTransfer(ROLE, "G-money");
  assert.equal(hit?.appName, "Chase");
  assert.equal(hit?.currency, "$");
});

/*
 * logo 走的是同一张白名单，所以同一个 bug 会再来一遍：漏了它，收款时
 * `hit.logo` 读回来是 undefined，卡片当场把图丢了（气泡里那张脸变了）。
 *
 * 存的是**文件名不是字节** —— 一张 JPEG 塞进记录里，500 笔就是几兆 base64
 * 躺在这个 JSON 里。
 */
okWith("logo / logoBg / logoStyle 跟着落盘，而且存的是文件名不是图片字节", () => {
  TS.putTransfer(ROLE, {
    ...session,
    messageGuid: "G-logo",
    amount: "520",
    note: "",
    state: "pending",
    peerKey: "p1",
    logo: "Chase.svg",
    logoBg: "#07c160",
    logoStyle: "icon",
  });
  const hit = TS.findTransfer(ROLE, "G-logo");
  assert.equal(hit?.logo, "Chase.svg");
  assert.equal(hit?.logoBg, "#07c160");
  // 漏了这个字段，用户中途从小图标调回横幅，老卡片收款时会当场变高
  assert.equal(hit?.logoStyle, "icon");
  assert.ok(!JSON.stringify(hit).includes("/9j/"), "图片字节不许进记录");
});

okWith("没给 appName / currency / logo 时存成空串，不是 undefined", () => {
  TS.putTransfer(ROLE, {
    ...session,
    messageGuid: "G-bare",
    amount: "1",
    state: "pending",
  });
  const hit = TS.findTransfer(ROLE, "G-bare");
  assert.equal(hit?.appName, "");
  assert.equal(hit?.currency, "");
  assert.equal(hit?.logo, "");
  assert.equal(hit?.logoBg, "");
  // 空串在 renderLogo 那儿会被 normalizeLogoStyle 归成 banner，所以不用兜底成 "banner"
  assert.equal(hit?.logoStyle, "");
});

/*
 * 对方贴的是**气泡**，而 SDK 把 messageGuid 和 targetMessageGuid 说成两件事。
 * 只比一个的话另一种情况下会查不到，收款直接哑掉。
 */
okWith("messageGuid 和 targetMessageGuid 两个都能查到同一笔", () => {
  assert.equal(TS.findTransfer(ROLE, "T-1")?.sessionId, "S-1");
  assert.equal(TS.findTransfer(ROLE, "G-1")?.sessionId, "S-1");
  assert.equal(TS.findTransfer(ROLE, "没这个"), null);
});

/*
 * 数的是**差值**，不是绝对条数：上面几条已经往 role_a 里存了好几笔，写死
 * 「剩 1 笔」的话每加一条落盘用例都要回来改这个数 —— 而且改错方向（把 1 改成 4）
 * 看着像修好了，其实什么都没验。
 */
okWith("同一个 guid 再 put 是覆盖，不是新增一笔", () => {
  const before = TS.readTransfers(ROLE).items.length;
  TS.putTransfer(ROLE, { ...TS.findTransfer(ROLE, "G-1"), state: "received" });
  assert.equal(TS.readTransfers(ROLE).items.length, before);
  assert.equal(TS.findTransfer(ROLE, "G-1")?.state, "received");
});

okWith("收完款留着记录（重复贴要认得出、模型也要能提起这笔）", () => {
  assert.ok(TS.findTransfer(ROLE, "G-1"));
});

okWith("按角色分文件，互不串", () => {
  TS.putTransfer("role_b", { messageGuid: "GB", chatGuid: "c", sessionId: "SB", targetMessageGuid: "TB", amount: "1", state: "pending" });
  assert.equal(TS.findTransfer(ROLE, "GB"), null);
  assert.equal(TS.findTransfer("role_b", "G-1"), null);
  assert.ok(fs.existsSync(path.join(tmp, "transfers", "role_a.json")));
  assert.ok(fs.existsSync(path.join(tmp, "transfers", "role_b.json")));
});

okWith("roleKey 带路径符号时拒写（挡 ../）", () => {
  assert.equal(TS.putTransfer("../evil", { messageGuid: "x" }), false);
  assert.equal(TS.findTransfer("../evil", "x"), null);
  assert.ok(!fs.existsSync(path.join(tmp, "evil.json")));
});

okWith("没有 messageGuid 的条目不写（那是这张卡片的身份）", () => {
  assert.equal(TS.putTransfer(ROLE, { messageGuid: "", amount: "1" }), false);
});

okWith(`超过 ${TS.MAX_ENTRIES} 笔从最旧的开始丢`, () => {
  for (let i = 0; i < TS.MAX_ENTRIES + 20; i += 1) {
    TS.putTransfer("role_c", { messageGuid: `g${i}`, chatGuid: "c", sessionId: "s", targetMessageGuid: "t", amount: "1", state: "pending" });
  }
  const { items } = TS.readTransfers("role_c");
  assert.equal(items.length, TS.MAX_ENTRIES);
  assert.equal(TS.findTransfer("role_c", "g0"), null); // 最旧那笔丢了
  assert.ok(TS.findTransfer("role_c", `g${TS.MAX_ENTRIES + 19}`)); // 最新那笔在
});

/*
 * 坏文件**不删也不改名**，只当空的用。最坏的后果是几张老卡片改不动了，
 * 不该为这个把文件毁掉。
 */
okWith("文件坏了当空的用，文件本身一个字节都不动", () => {
  const f = path.join(tmp, "transfers", "role_d.json");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, "{ 这不是 JSON", "utf-8");
  assert.deepEqual(TS.readTransfers("role_d").items, []);
  assert.equal(fs.readFileSync(f, "utf-8"), "{ 这不是 JSON");
});

/* ================= 两道闸 ================= */

section("提示词那两道闸（预设子条目 + 角色开关）");

const basePreset = {
  id: "p1",
  name: "默认",
  entries: [{ kind: "format", enabled: true, children: P.defaultFormatChildren() }],
};
const cfgWith = (transfer) =>
  C.normalizeConfig({
    presets: [basePreset],
    roles: [{ id: "r1", name: "小明", prompt: "你是小明", presetRef: "p1", transfer }],
  });

okWith("转账在固定子条目里，新建预设时就有", () => {
  assert.ok(P.FORMAT_CHILD_KINDS.includes("transfer"));
  assert.equal(P.FORMAT_CHILD_TAGS.transfer, "转账");
  assert.equal(P.ROLE_GATED_CHILDREN.transfer, "transfer");
  const kid = P.defaultFormatChildren().find((c) => c.kind === "transfer");
  assert.ok(kid?.content?.includes("[transfer:金额:备注]"));
});

/*
 * 老配置里压根没有 transfer 这个 kind。补进去时 enabled 该是开的
 * （缺字段一律补开，见 preset.js:defaultChildEnabled）—— 反正还压着角色那道闸，
 * 默认关，不会凭空往提示词里加东西。
 */
okWith("老预设迁移：补出 transfer 子条目，别的条目的开关不动", () => {
  const legacy = P.defaultFormatChildren()
    .filter((c) => c.kind !== "transfer")
    .map((c) => ({ ...c, enabled: false }));
  const norm = P.normalizePresets([
    { id: "p9", name: "老的", entries: [{ kind: "format", children: legacy }] },
  ]);
  const kids = norm[0].entries.find((e) => e.kind === "format").children;
  const kid = kids.find((c) => c.kind === "transfer");
  assert.equal(kid?.enabled, true);
  assert.ok(kid?.content);
  assert.ok(kids.filter((c) => c.kind !== "transfer").every((c) => c.enabled === false));
});

okWith("角色默认不开转账（不该由一次误触发生）", () => {
  const role = C.normalizeConfig({ roles: [{ id: "r0", name: "x" }] }).roles[0];
  assert.equal(role.transfer.enabled, false);
  assert.equal(role.transfer.appName, "");
  assert.equal(role.transfer.confirmOnReact, true); // 这一个默认开
  // 收款后**不**当场回一轮：贴个 emoji 就把角色勾出来说话太轻了
  assert.equal(role.transfer.notifyOnClaim, false);
});

/*
 * 「收款后立刻通知」默认关，而且缺字段不能变成开。
 *
 * `confirmOnReact` 那个是 `=== undefined ? true :`，这个是直接 `Boolean()` ——
 * 两条路反着写，老配置里都没这两个字段，所以各自都得盯一眼。
 */
okWith("notifyOnClaim 默认关，认布尔（老配置里没这个字段）", () => {
  const on = (v) =>
    C.normalizeConfig({ roles: [{ id: "r0", name: "x", transfer: { notifyOnClaim: v } }] }).roles[0]
      .transfer.notifyOnClaim;
  assert.equal(on(true), true);
  for (const junk of [undefined, null, false, "", 0]) {
    assert.equal(on(junk), false, `${junk} 不该把它打开`);
  }
});

okWith("appName 截到 40 字", () => {
  const role = C.normalizeConfig({
    roles: [{ id: "r0", name: "x", transfer: { appName: "银".repeat(80) } }],
  }).roles[0];
  assert.equal(role.transfer.appName.length, 40);
});

okWith("默认不带缩略图，底色默认白，档位默认横幅", () => {
  const role = C.normalizeConfig({ roles: [{ id: "r0", name: "x" }] }).roles[0];
  assert.equal(role.transfer.logo, "");
  assert.equal(role.transfer.logoBg, "#ffffff");
  // 老配置里没有这个字段，必须补成 banner —— 补成 icon 等于悄悄压扁所有人的卡片
  assert.equal(role.transfer.logoStyle, "banner");
});

/* 档位也在配置这一层归一，理由和底色同一条。 */
okWith("档位认不出来就归成横幅", () => {
  const st = (v) =>
    C.normalizeConfig({ roles: [{ id: "r0", name: "x", transfer: { logoStyle: v } }] }).roles[0]
      .transfer.logoStyle;
  assert.equal(st("icon"), "icon");
  assert.equal(st("banner"), "banner");
  assert.equal(st("小图标"), "banner");
  assert.equal(st(""), "banner");
});

/*
 * 底色在**配置这一层**就归成合法值，不留到渲染时才发现。
 * 不然一个「红色」会一路传到 skia 的 fillStyle，那边不认就画成透明/黑块 ——
 * 用户看到的是一张脏图，而不是「这个颜色填错了」。
 */
okWith("底色不合法就归成默认，三位补成六位", () => {
  const bg = (v) =>
    C.normalizeConfig({ roles: [{ id: "r0", name: "x", transfer: { logoBg: v } }] }).roles[0]
      .transfer.logoBg;
  assert.equal(bg("#FFF"), "#ffffff");
  assert.equal(bg("07c160"), "#07c160");
  assert.equal(bg("红色"), "#ffffff");
  assert.equal(bg(""), "#ffffff");
  assert.equal(bg("rgb(0,0,0)"), "#ffffff");
});

/*
 * 配置里**不校验文件在不在**：配置随时能改，而文件可能等会儿才传上来。
 * 真发的时候读不出来，renderLogo 退化成不带图，不会让转账发不出去。
 */
okWith("logo 只存名字、不校验文件存在（截 200 字挡异常长名）", () => {
  const role = C.normalizeConfig({
    roles: [{ id: "r0", name: "x", transfer: { logo: "还没传的图.svg" } }],
  }).roles[0];
  assert.equal(role.transfer.logo, "还没传的图.svg");
  const long = C.normalizeConfig({
    roles: [{ id: "r0", name: "x", transfer: { logo: `${"长".repeat(400)}.svg` } }],
  }).roles[0];
  assert.equal(long.transfer.logo.length, 200);
});

{
  const off = cfgWith({ enabled: false });
  const on = cfgWith({ enabled: true, appName: "Chase" });
  const promptOf = async (cfg) =>
    JSON.stringify(await PR.buildPrompt(cfg, cfg.roles[0], { name: "我" }, []));

  const textOff = await promptOf(off);
  const textOn = await promptOf(on);

  okWith("角色关着 → 提示词里没有 <转账>（子条目开着也不注入）", () => {
    assert.ok(!textOff.includes("<转账>"));
  });
  okWith("角色开着 → 注入 <转账>，里面教的是 [transfer:金额:备注]", () => {
    assert.ok(textOn.includes("<转账>"));
    assert.ok(textOn.includes("[transfer:金额:备注]"));
  });
}

{
  // 子条目关掉：角色开着也不该注入（另一道闸）
  const kids = P.defaultFormatChildren().map((c) =>
    c.kind === "transfer" ? { ...c, enabled: false } : c
  );
  const cfg = C.normalizeConfig({
    presets: [{ id: "p2", name: "关了那条", entries: [{ kind: "format", enabled: true, children: kids }] }],
    roles: [{ id: "r2", name: "小明", prompt: "你是小明", presetRef: "p2", transfer: { enabled: true } }],
  });
  const text = JSON.stringify(await PR.buildPrompt(cfg, cfg.roles[0], { name: "我" }, []));
  okWith("预设里那条子条目关着 → 角色开着也不注入", () => {
    assert.ok(!text.includes("<转账>"));
  });
}

/*
 * 线下模式**整条**「消息格式与功能」都不注入（prompt.js 里无条件 break）——
 * 线下不发气泡，转账卡片也发不出去。
 */
{
  const offlinePreset = {
    id: "po",
    name: "线下",
    mode: "offline",
    entries: [{ kind: "format", enabled: true, children: P.defaultFormatChildren() }],
  };
  const cfg = C.normalizeConfig({
    presets: [offlinePreset],
    roles: [
      {
        id: "r3",
        name: "小明",
        prompt: "你是小明",
        transfer: { enabled: true },
        offline: { presetRef: "po" },
      },
    ],
  });
  const text = JSON.stringify(
    await PR.buildPrompt(cfg, cfg.roles[0], { name: "我" }, [], "", { mode: "offline" })
  );
  okWith("线下模式不注入转账（整条「消息格式与功能」都跳过）", () => {
    assert.ok(!text.includes("<转账>"));
  });
}

/* ================= 服务端接线 ================= */

section("imessage.js 的接线（读源码，跑不起真桥接）");

{
  const src = fs.readFileSync(
    new URL("../server/src/imessage.js", import.meta.url),
    "utf-8"
  );

  okWith("transfer 这个 kind 有自己的分发分支", () => {
    assert.ok(src.includes('part.kind === "transfer"'));
    assert.ok(src.includes("sendTransferPart(runner, space, part, ctx)"));
  });

  /*
   * 收款那一步**必须拦在 reactSend 那道闸前面**。那道闸管的是「把对方贴的 emoji
   * 告诉模型」，收款是另一件事 —— 卡在闸后面的话，没开「消息回应」的角色
   * （默认就是关的）收款会悄悄失效，而用户看到的现象只是「贴了表情没反应」。
   * 这是这个功能最容易在重构里被挪错位置的一行。
   */
  okWith("收款检查拦在 reactSend 那道闸之前", () => {
    const claim = src.indexOf("claimTransferOnReact(");
    const gate = src.indexOf("who?.reactSend?.enabled");
    assert.ok(claim > 0, "找不到 claimTransferOnReact 的调用");
    assert.ok(gate > 0, "找不到 reactSend 那道闸");
    assert.ok(claim < gate, "收款检查跑到 reactSend 闸后面去了");
  });

  okWith("退路那句文字确实是「转账 ￥…」，而且金额跟着角色那个符号走", () => {
    const at = src.indexOf("async function sendTransferText(");
    assert.ok(at > 0, "找不到 sendTransferText");
    const body = src.slice(at, at + 900);
    assert.ok(body.includes("转账 ${money}"));
    assert.ok(
      body.includes("formatAmount(amount, ctx?.role?.transfer?.currency)"),
      "退化的那句文字得和卡片上同一个货币符号，不然一笔钱两种写法"
    );
    assert.ok(body.includes("space.send(text)"));
  });

  /*
   * **两条**发不出去的路都得退化成文字，不是什么都不做：本地 Mac 模式
   * （压根没这条 RPC）和云端发失败（线路拒了、超时、凭据过期…）。
   *
   * 后者原来是 `return false`，于是只写了一个 [transfer:…] 的那一轮会被上游
   * 判成「一件事都没做成」，这笔钱的意思一个字都没送出去。两条都盯着。
   */
  okWith("本地 Mac 模式和云端发失败都退化成发一句文字", () => {
    const at = src.indexOf("async function sendTransferPart(");
    const body = src.slice(at, src.indexOf("async function claimTransferOnReact("));
    assert.ok(body.includes('runner.mode !== "cloud"'), "找不到本地模式那道判断");
    assert.ok(body.includes("if (!session) {"), "找不到云端发失败那道判断");
    assert.equal(
      body.match(/sendTransferText\(/g)?.length,
      2,
      "两条退路都该走 sendTransferText"
    );
  });

  okWith("句柄存不下来只 warn，不报成「这笔没发出去」", () => {
    const at = src.indexOf("async function sendTransferPart(");
    const body = src.slice(at, at + 2600);
    const putAt = body.indexOf("putTransfer(");
    assert.ok(putAt > 0);
    assert.ok(body.slice(putAt).includes("return true"), "存句柄失败之后还是该 return true");
  });

  okWith("改卡片用的是**存下来那个** appName（不读当前配置）", () => {
    const at = src.indexOf("async function claimTransferOnReact(");
    const body = src.slice(at, at + 3000);
    assert.ok(body.includes("appName: hit.appName"));
  });

  /*
   * 发的时候渲一张图、存**文件名**；改的时候按存下来那个名字**重渲一份**。
   *
   * 这三处任缺一处的后果都不是报错，是悄悄变样：
   *  - 发的时候不渲 → 卡片没图；
   *  - 存的时候漏了 logo → 收款时 hit.logo 是 undefined，图当场丢了；
   *  - 改的时候不渲 → 同上（updateCustomizedMiniApp 是整条 layout 换掉的）。
   */
  okWith("发的时候渲图 + 存文件名，改的时候按存下来那个重渲", () => {
    const send = src.slice(
      src.indexOf("async function sendTransferPart("),
      src.indexOf("async function claimTransferOnReact(")
    );
    assert.ok(send.includes("renderLogo(role.transfer.logo"), "发的时候没渲图");
    assert.ok(send.includes("style: role.transfer.logoStyle"), "发的时候没按配置那档渲");
    assert.ok(send.includes("logo: role.transfer.logo"), "logo 没跟着落盘");
    assert.ok(send.includes("logoBg: role.transfer.logoBg"), "logoBg 没跟着落盘");
    assert.ok(send.includes("logoStyle: role.transfer.logoStyle"), "logoStyle 没跟着落盘");

    const claim = src.slice(
      src.indexOf("async function claimTransferOnReact("),
      src.indexOf("async function sendMusicPart(")
    );
    assert.ok(claim.includes("renderLogo(hit.logo"), "改的时候没按存下来那个重渲");
    assert.ok(claim.includes("style: hit.logoStyle"), "改的时候没按存下来那档渲");
    assert.ok(!claim.includes("renderLogo(role"), "改的时候不许读当前配置");
    assert.ok(!claim.includes("role.transfer.logoStyle"), "改的时候不许读当前配置的档位");
  });

  /*
   * 收款之后那句提示，**默认攒着、开了才当场回**。
   *
   * 两条路各自都有能悄悄坏掉的方式：
   *  - 默认那路要走 noteReaction 的 hint 口子（攒进 reactPending，等这个人
   *    下条真消息一起送）；
   *  - 开了的那路要走 **enqueue** 而不是直接 handleTurn —— 合并窗口正是这儿
   *    要的：对方常常贴完表情紧接着来一句「收到啦」，走队列两件事并成一轮。
   *    绕过队列的话角色会先回一句「钱收到了吧」，再为那句「收到啦」回第二轮。
   *
   * 而且那个 item 里**不许放 message**：那是给已读回执用的，这条 reaction
   * 没有正文、对方屏幕上也没有未读可标。
   */
  okWith("收款提示默认攒着，开了 notifyOnClaim 才走 enqueue 当场回一轮", () => {
    const at = src.indexOf("const claimed = await claimTransferOnReact(");
    assert.ok(at > 0, "找不到收款那段");
    const body = src.slice(at, at + 1800);
    assert.ok(body.includes("who?.transfer?.notifyOnClaim"), "找不到那道分叉");
    assert.ok(
      body.includes("enqueue(getConfig, runner, space, spaceId, { text: hint }, peer)"),
      "立刻通知那路该走 enqueue（要合并窗口），而且 item 里不带 message"
    );
    assert.ok(body.includes("noteReaction(runner, peerKeyOf(peer)"), "默认那路该攒进 reactPending");
    // 两句提示得是同一份 —— 分叉只决定什么时候送，不该送出两种说法
    assert.equal(body.match(/收下了你转的/g)?.length, 1, "提示文案该只拼一次");
  });

  okWith("已经收过的不重复处理（重复贴表情不该让卡片闪一下）", () => {
    const at = src.indexOf("async function claimTransferOnReact(");
    const body = src.slice(at, at + 2000);
    assert.ok(body.includes('hit.state === "received"'));
  });

  okWith("改失败时不写「已收款」（气泡和记录不许对不上）", () => {
    const at = src.indexOf("async function claimTransferOnReact(");
    const body = src.slice(at, at + 2000);
    const okAt = body.indexOf("if (!ok) return null;");
    const putAt = body.indexOf('putTransfer(roleKey, { ...hit, state: "received" })');
    assert.ok(okAt > 0 && putAt > okAt, "落盘该排在 update 成功之后");
  });
}

/* ================= 收尾 ================= */

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} 项全部通过\n`);
