/**
 * 线路预检的离线自测 —— 「发过去没反应、控制台一行都没有」那一类。
 *
 * ── 为什么单独开一套 ──
 *
 * 这两道闸盯的是**共享线路的白名单**，而白名单拒绝在入站方向的表现是**彻底
 * 的沉默**：消息在 Photon 那头就被丢了，不进 `instance.messages`，我们这边
 * 一条日志都不会有，桥接却一直显示「已连接，等消息中」，重启也没用。实机上
 * 为这个来回查了好几轮，唯一的线索是出站那边位置推送回的
 * `Target not allowed for this project`。
 *
 * 所以这套测的全是「该不该喊」，而且两个方向都要钉死：
 *
 *  1. **该喊的要喊**：线路不归自己、登记失效、凭据被轮换、聊天对象没登记。
 *  2. **不该喊的绝不能喊**。这头更要紧 —— 开机时网络还没通就喊一句
 *     「你的线路失效了」，比不喊更糟，机主会去改一个本来就对的号。所以
 *     网络错、格式差异（空格/横线/括号）、名单压根没查到，统统只能闭嘴。
 *
 * 不联网、不碰真的 data/：Photon 那一头换成假的 fetch。
 *
 * 跑：node scripts/test-lineguard.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "uranus-lineguard-"));
process.env.URANUS_DATA_DIR = TMP;

const IM_SRC = fs.readFileSync(path.join(ROOT, "server/src/imessage.js"), "utf-8");

let passed = 0;
let failed = 0;
async function ok(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`FAIL  ${name}`);
    console.error(e?.stack || e);
    process.exitCode = 1;
  }
}

/* ================= 把真函数抠出来（同 test-queue.mjs 的办法） ================= */

function extractFn(name) {
  const at = IM_SRC.indexOf(`function ${name}(`);
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

/**
 * 在一个喂了假依赖的作用域里重建 checkPeersRegistered。
 *
 * `peerKeyOf` 用的是**真的那份**（格式归一的规则就是这次要测的东西之一），
 * `locPeersOf` 换成假的 —— 它背后是会话存档，那是另一套的事。
 */
function buildPeerGuard(peers) {
  const errors = [];
  const src = `
    ${extractFn("peerKeyOf")}
    ${extractFn("checkPeersRegistered")}
    return { checkPeersRegistered, peerKeyOf };
  `;
  const make = new Function(
    "currentRole",
    "scopeOf",
    "locPeersOf",
    "logError",
    src
  );
  const api = make(
    () => ({ id: "r1" }),
    () => "投递·测试",
    () => new Set(peers),
    (_scope, message, detail) => errors.push({ message, detail })
  );
  return { ...api, errors };
}

const runner = { stopped: false };
const getConfig = () => ({});

/* ================= 聊天对象的白名单 ================= */

await ok("对方没登记 → 报错，而且把两边的号都列出来", () => {
  const g = buildPeerGuard(["+8613900000001"]);
  g.checkPeersRegistered(getConfig, runner, [
    { phoneNumber: "+8613800138000", assignedPhoneNumber: "+14155901577" },
  ]);
  assert.equal(g.errors.length, 1);
  assert.match(g.errors[0].message, /\+8613900000001/);
  assert.match(g.errors[0].message, /不在这个项目的登记名单里/);
  // 名单也要给出来，不然机主不知道该让谁去发
  assert.match(g.errors[0].detail, /\+8613800138000/);
  // 两条修法都要在
  assert.match(g.errors[0].detail, /Apple ID 邮箱/);
  assert.match(g.errors[0].detail, /开通线路/);
});

await ok("提示里「两个号发错了」要排在「Apple ID 邮箱」前面", () => {
  /*
   * 这条钉的是**顺序**，不是有没有。实机上第一版把邮箱写成了头号原因，
   * 而那个人根本没用邮箱 —— 她手里有两个 +86，iMessage 挑了没登记的那个。
   * 这种人对着「检查号码对不对」只会看到一串正常的号，怎么查都查不出来。
   * 所以双卡/两个号那句必须在前面，邮箱退成附注。
   */
  const g = buildPeerGuard(["+8613900000001"]);
  g.checkPeersRegistered(getConfig, runner, [
    { phoneNumber: "+8613800138000", assignedPhoneNumber: "+14155901577" },
  ]);
  const d = g.errors[0].detail;
  assert.match(d, /双卡|两个号/);
  assert.ok(
    d.search(/双卡|两个号/) < d.indexOf("Apple ID 邮箱"),
    "「两个号发错了」必须排在「Apple ID 邮箱」前面"
  );
  // 旧对话可能还钉在旧地址上，这句不能丢
  assert.match(d, /新开一个对话/);
});

await ok("对方就是登记的那个号 → 闭嘴", () => {
  const g = buildPeerGuard(["+8613800138000"]);
  g.checkPeersRegistered(getConfig, runner, [
    { phoneNumber: "+8613800138000", assignedPhoneNumber: "+14155901577" },
  ]);
  assert.equal(g.errors.length, 0);
});

await ok("号码格式不一样但是同一个号 → 闭嘴（误报比不报更糟）", () => {
  for (const stored of ["+86 138 0013 8000", "+86-138-0013-8000", "+86 (138) 0013 8000"]) {
    const g = buildPeerGuard([stored]);
    g.checkPeersRegistered(getConfig, runner, [
      { phoneNumber: "+8613800138000", assignedPhoneNumber: "+14155901577" },
    ]);
    assert.equal(g.errors.length, 0, `${stored} 被误报了`);
  }
});

await ok("邮箱大小写不同 → 闭嘴", () => {
  const g = buildPeerGuard(["Me@Example.COM"]);
  g.checkPeersRegistered(getConfig, runner, [
    { phoneNumber: "me@example.com", assignedPhoneNumber: "+14155901577" },
  ]);
  assert.equal(g.errors.length, 0);
});

await ok("名单没查成（null）→ 闭嘴", () => {
  const g = buildPeerGuard(["+8613900000001"]);
  g.checkPeersRegistered(getConfig, runner, null);
  assert.equal(g.errors.length, 0);
});

await ok("名单是空的 → 闭嘴（那是另一条路该说的话，别把人带偏）", () => {
  const g = buildPeerGuard(["+8613900000001"]);
  g.checkPeersRegistered(getConfig, runner, []);
  assert.equal(g.errors.length, 0);
});

await ok("还没人说过话（没有聊天对象）→ 闭嘴", () => {
  const g = buildPeerGuard([]);
  g.checkPeersRegistered(getConfig, runner, [
    { phoneNumber: "+8613800138000", assignedPhoneNumber: "+14155901577" },
  ]);
  assert.equal(g.errors.length, 0);
});

await ok("桥接已经停了 → 闭嘴", () => {
  const g = buildPeerGuard(["+8613900000001"]);
  g.checkPeersRegistered(getConfig, { stopped: true }, [
    { phoneNumber: "+8613800138000", assignedPhoneNumber: "+14155901577" },
  ]);
  assert.equal(g.errors.length, 0);
});

/* ================= 线路归属 ================= */

/** 把 photon.js 的 fetch 换掉，跑真的 checkLineOwnership。 */
async function withFakePhoton(reply, fn) {
  const { checkLineOwnership } = await import("../server/src/photon.js");
  const real = globalThis.fetch;
  globalThis.fetch = async () => reply();
  try {
    return await fn(checkLineOwnership);
  } finally {
    globalThis.fetch = real;
  }
}

const jsonReply = (status, body) => () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const USERS = { data: { users: [{ phoneNumber: "+8613800138000", assignedPhoneNumber: "+14155901577" }] } };

await ok("线路归自己 → 把名单交给下一道闸", async () => {
  await withFakePhoton(jsonReply(200, USERS), async (check) => {
    const users = await check({
      projectId: "p", projectSecret: "s", label: "投递·测试",
      myPhone: "+8613800138000", linePhone: "+14155901577",
    });
    assert.equal(users?.length, 1);
  });
});

await ok("线路被换了 → 也要把名单交下去（对方那道闸还得查）", async () => {
  await withFakePhoton(jsonReply(200, USERS), async (check) => {
    const users = await check({
      projectId: "p", projectSecret: "s", label: "投递·测试",
      myPhone: "+8613800138000", linePhone: "+14155901578",
    });
    assert.equal(users?.length, 1);
  });
});

await ok("凭据被拒（401）→ 给 null，别拿假名单去冤枉对方", async () => {
  await withFakePhoton(jsonReply(401, {}), async (check) => {
    const users = await check({
      projectId: "p", projectSecret: "s", label: "投递·测试",
      myPhone: "+8613800138000", linePhone: "+14155901577",
    });
    assert.equal(users, null);
  });
});

await ok("网络不通 → 给 null，不报警", async () => {
  const { checkLineOwnership } = await import("../server/src/photon.js");
  const real = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  };
  try {
    const users = await checkLineOwnership({
      projectId: "p", projectSecret: "s", label: "投递·测试",
      myPhone: "+8613800138000", linePhone: "+14155901577",
    });
    assert.equal(users, null);
  } finally {
    globalThis.fetch = real;
  }
});

await ok("没填线路号码 → 一次网都不出", async () => {
  const { checkLineOwnership } = await import("../server/src/photon.js");
  let called = false;
  const real = globalThis.fetch;
  globalThis.fetch = async () => {
    called = true;
    return jsonReply(200, USERS)();
  };
  try {
    const users = await checkLineOwnership({
      projectId: "p", projectSecret: "s", label: "投递·测试", myPhone: "", linePhone: "",
    });
    assert.equal(users, null);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = real;
  }
});



/* ================= 两个角色的项目打架 ================= */

function buildConflictGuard() {
  const errors = [];
  const make = new Function("logError", extractFn("warnProjectConflicts") + "return warnProjectConflicts;");
  return { warn: make((_s, m, d) => errors.push({ message: m, detail: d })), errors };
}

await ok("两个角色共用一个 Photon 项目 → 报错", () => {
  const g = buildConflictGuard();
  g.warn([
    { id: "a", mode: "cloud", projectId: "6c5279b5aaaa", myPhone: "+8613800138001" },
    { id: "b", mode: "cloud", projectId: "6c5279b5aaaa", myPhone: "+8613800138002" },
  ]);
  assert.equal(g.errors.length, 1);
  assert.match(g.errors[0].message, /共用同一个 Photon 项目/);
  assert.match(g.errors[0].detail, /一个角色一个 Photon 项目/);
});

// 「同一个号登记在两个项目 → 报错」那条在 1.16.2 删了（用户说那不算报错），
// 所以这里反过来钉：**同一个号不该再被喊**，免得哪天又被加回来
await ok("同一个号登记在两个项目 → 不喊（1.16.2 起不再当成错）", () => {
  const g = buildConflictGuard();
  g.warn([
    { id: "a", mode: "cloud", projectId: "aaaa", myPhone: "+8613800138000" },
    { id: "b", mode: "cloud", projectId: "bbbb", myPhone: "+8613800138000" },
  ]);
  assert.equal(g.errors.length, 0);
});

await ok("两个角色各自独立 → 一个字都不说", () => {
  const g = buildConflictGuard();
  g.warn([
    { id: "a", mode: "cloud", projectId: "aaaa", myPhone: "+8613800138001" },
    { id: "b", mode: "cloud", projectId: "bbbb", myPhone: "+8613800138002" },
  ]);
  assert.equal(g.errors.length, 0);
});

await ok("myPhone 都是空的 → 不能把「空」当成同一个号", () => {
  const g = buildConflictGuard();
  g.warn([
    { id: "a", mode: "cloud", projectId: "aaaa", myPhone: "" },
    { id: "b", mode: "cloud", projectId: "bbbb", myPhone: "" },
  ]);
  assert.equal(g.errors.length, 0);
});

await ok("本地 Mac 模式不参与比较（它没有项目凭据这回事）", () => {
  const g = buildConflictGuard();
  g.warn([
    { id: "a", mode: "local", projectId: "", myPhone: "+8613800138000" },
    { id: "b", mode: "local", projectId: "", myPhone: "+8613800138000" },
  ]);
  assert.equal(g.errors.length, 0);
});


fs.rmSync(TMP, { recursive: true, force: true });
/*
 * **最后一行必须把失败数也说出来。**
 *
 * 这里曾经只打「N 项通过」。于是删掉一处被测函数之后，6 个用例全部 FAIL、
 * 退出码也确实是 1，可最后一行还是一句平静的「19 项通过」—— 只看结尾
 * （`node … | tail -2`，排查时的常规动作）完全看不出出事了。
 */
console.log(`
${failed === 0 ? "全部通过" : "有失败"}：${passed} 通过 / ${failed} 失败`);
