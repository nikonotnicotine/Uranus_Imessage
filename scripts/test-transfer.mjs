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
 * 缩略图三个字段一个都不许有：image 要一张真 JPEG 字节（服务端会验），
 * 而 imageTitle / imageSubtitle 按 proto 的约束必须跟着 image 一起给。
 * 这一版不带图，都不给最省事。
 */
okWith("不带缩略图（image / imageTitle / imageSubtitle 都不给）", () => {
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

okWith("appName 是用户填的那个，留空兜底成「转账」", async () => {
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
okWith("没填 appName → 「转账」；没备注 → 不给 subcaption", () => {
  const { msg } = calls.sent.at(-1);
  assert.equal(msg.appName, "转账");
  assert.equal(msg.layout.subcaption, undefined);
  assert.equal(msg.layout.summary, "转账 ￥4,000.00（待收款）");
});

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
 * 对方贴的是**气泡**，而 SDK 把 messageGuid 和 targetMessageGuid 说成两件事。
 * 只比一个的话另一种情况下会查不到，收款直接哑掉。
 */
okWith("messageGuid 和 targetMessageGuid 两个都能查到同一笔", () => {
  assert.equal(TS.findTransfer(ROLE, "T-1")?.sessionId, "S-1");
  assert.equal(TS.findTransfer(ROLE, "G-1")?.sessionId, "S-1");
  assert.equal(TS.findTransfer(ROLE, "没这个"), null);
});

okWith("同一个 guid 再 put 是覆盖，不是新增一笔", () => {
  TS.putTransfer(ROLE, { ...TS.findTransfer(ROLE, "G-1"), state: "received" });
  assert.equal(TS.readTransfers(ROLE).items.length, 1);
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
});

okWith("appName 截到 40 字", () => {
  const role = C.normalizeConfig({
    roles: [{ id: "r0", name: "x", transfer: { appName: "银".repeat(80) } }],
  }).roles[0];
  assert.equal(role.transfer.appName.length, 40);
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

  okWith("退路那句文字确实是「转账 ￥…」，不是空话", () => {
    const at = src.indexOf("async function sendTransferText(");
    assert.ok(at > 0, "找不到 sendTransferText");
    const body = src.slice(at, at + 700);
    assert.ok(body.includes("转账 ${formatAmount(amount)}"));
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
    const body = src.slice(at, at + 2000);
    assert.ok(body.includes("appName: hit.appName"));
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
