/**
 * 离线自测：iMessage 投票（认出来 → 投一票 → 自己发起）+ 手写 / Digital Touch 看内容。
 *
 * **不打真的 Photon。** `@photon-ai/advanced-imessage/grpc` 和 `@spectrum-ts/core`
 * 用 node:test 的 mock.module 换成假的（所以这个文件必须带
 * `--experimental-test-module-mocks` 跑），假客户端把每次 `polls.get` / `polls.vote` /
 * `messages.getEmbeddedMedia` 的入参原样记下来，投票事件流由测试自己往里塞 ——
 * 这里验的是「我们这一层认没认对」，不是「Photon 今天通不通」。
 *
 * URANUS_DATA_DIR 指向临时目录，绝不碰真实的 data/（那里有真的 Photon 凭据）。
 * 必须在 import pollstore.js **之前**设好 —— DATA_DIR 是模块加载时算的。
 * 所以这个文件用动态 import。
 *
 * 跑：node --experimental-test-module-mocks scripts/test-poll.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "uranus-poll-"));
process.env.URANUS_DATA_DIR = tmp;

let passed = 0;
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
function section(title) {
  console.log(`\n── ${title} ──`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等某个条件成立，最多等 ms 毫秒 —— 订阅是在后台建的，不能靠固定睡眠。 */
async function waitFor(what, fn, ms = 1500) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return;
    await sleep(10);
  }
  throw new Error(`等不到：${what}`);
}

/* ================= 假的 Photon ================= */

/** 一条能从外面往里塞事件的假流（真的那条是 gRPC 的 server stream）。 */
function makeStream() {
  const queue = [];
  let waiting = null;
  let done = false;
  const stream = {
    closed: false,
    push(ev) {
      if (waiting) {
        const r = waiting;
        waiting = null;
        r({ value: ev, done: false });
      } else queue.push(ev);
    },
    end() {
      done = true;
      if (waiting) {
        const r = waiting;
        waiting = null;
        r({ value: undefined, done: true });
      }
    },
    async close() {
      stream.closed = true;
      stream.end();
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
          if (done) return Promise.resolve({ value: undefined, done: true });
          return new Promise((r) => {
            waiting = r;
          });
        },
      };
    },
  };
  return stream;
}

const photon = {
  streams: [],
  closedClients: 0,
  getCalls: [],
  /** 下一次 polls.get 还什么（null = 当拿不到） */
  getResult: null,
  getThrows: false,
  voteCalls: [],
  voteThrows: false,
  /** getEmbeddedMedia 还什么 */
  embedded: null,
  embeddedThrows: false,
  /** createGrpcClient 收到的 opts，验超时有没有传下去 */
  clientOpts: [],
};

mock.module("@spectrum-ts/core", {
  namedExports: {
    cloud: {
      issueImessageTokens: async () => ({ type: "shared", token: "T", expiresIn: 300 }),
    },
  },
});

mock.module("@photon-ai/advanced-imessage/grpc", {
  namedExports: {
    createGrpcClient: (opts) => {
      photon.clientOpts.push(opts);
      return {
        polls: {
          subscribeEvents: () => {
            const s = makeStream();
            photon.streams.push(s);
            return s;
          },
          get: async (guid) => {
            photon.getCalls.push(guid);
            if (photon.getThrows) throw new Error("读不到这个投票");
            return photon.getResult;
          },
          vote: async (guid, optionIdentifier) => {
            photon.voteCalls.push({ guid, optionIdentifier });
            if (photon.voteThrows) throw new Error("这条线路投不了");
            return {};
          },
        },
        messages: {
          getEmbeddedMedia: async (chatGuid, messageGuid) => {
            if (photon.embeddedThrows) throw new Error("取不到");
            photon.embedded = { ...(photon.embedded ?? {}), asked: { chatGuid, messageGuid } };
            return photon.embedded?.reply ?? null;
          },
        },
        close: async () => {
          photon.closedClients += 1;
        },
      };
    },
  },
});

const M = await import("../server/src/media.js");
const POLL = await import("../server/src/poll.js");
const PS = await import("../server/src/pollstore.js");
const CARD = await import("../server/src/card.js");
const C = await import("../server/src/config.js");
const P = await import("../server/src/preset.js");
const PR = await import("../server/src/prompt.js");

const CHAT = "iMessage;-;+18005550100";

/* ================= 1. 标记解析 ================= */

section("标记解析（media.js）");

okWith("[vote:A] 切成一段 vote", () => {
  assert.deepEqual(M.splitMedia("我要吃这个[vote:B]"), [
    { kind: "text", text: "我要吃这个" },
    { kind: "vote", text: "B" },
  ]);
});

okWith("投票的几个别名都认，大小写不分", () => {
  for (const tag of ["vote", "Vote", "poll_vote", "投票", "投"]) {
    assert.deepEqual(
      M.splitMedia(`[${tag}:A]`),
      [{ kind: "vote", text: "A" }],
      `[${tag}:A] 没认出来`
    );
  }
});

/*
 * `poll_vote` 那条必须排在 `poll` 前面。顺序反了的话 `[poll_vote:A]` 会被
 * 「发起投票」那条吃掉，切出来是一个**标题叫 `_vote:A` 的投票** —— 于是角色
 * 想投一票，结果给对方发了个新投票。这一条盯的就是那个顺序。
 */
okWith("[poll_vote:A] 是投票，不是「标题叫 _vote:A 的发起投票」", () => {
  assert.deepEqual(M.splitMedia("[poll_vote:A]"), [{ kind: "vote", text: "A" }]);
});

okWith("[vote:选项原文] 也切出来（翻成 id 的活儿在 matchOption）", () => {
  assert.deepEqual(M.splitMedia("[vote:麻辣烫]"), [{ kind: "vote", text: "麻辣烫" }]);
});

okWith("[poll:注释|选项…] 切成一段 poll，竖线分段", () => {
  assert.deepEqual(M.splitMedia("[poll:今晚吃什么|麻辣烫|炸鸡|海底捞]"), [
    { kind: "poll", text: "今晚吃什么", options: ["麻辣烫", "炸鸡", "海底捞"] },
  ]);
});

okWith("全角竖线也认（中文输入法顺手打出来的就是它）", () => {
  assert.deepEqual(M.splitMedia("[poll:今晚吃什么｜麻辣烫｜炸鸡]"), [
    { kind: "poll", text: "今晚吃什么", options: ["麻辣烫", "炸鸡"] },
  ]);
});

okWith("选项里的空格掐掉，空段丢掉", () => {
  assert.deepEqual(M.splitMedia("[poll: 今晚吃什么 | 麻辣烫 ||  炸鸡 ]"), [
    { kind: "poll", text: "今晚吃什么", options: ["麻辣烫", "炸鸡"] },
  ]);
});

/*
 * 选项不足两个的**不在这儿丢** —— 下游 sendPollPart 会把它退化成一句文字。
 * 在解析这层丢掉的话那句话就彻底没了（模型写的「今晚吃什么」一个字都不会到
 * 对方手上）。
 */
okWith("只写了标题、或者只有一个选项，照样产出这一段（留给下游退化）", () => {
  assert.deepEqual(M.splitMedia("[poll:今晚吃什么]"), [
    { kind: "poll", text: "今晚吃什么", options: [] },
  ]);
  assert.deepEqual(M.splitMedia("[poll:今晚吃什么|麻辣烫]"), [
    { kind: "poll", text: "今晚吃什么", options: ["麻辣烫"] },
  ]);
});

okWith("发起投票的几个别名都认", () => {
  for (const tag of ["poll", "Poll", "create_poll", "发起投票", "投票发起"]) {
    assert.deepEqual(
      M.splitMedia(`[${tag}:去哪|A|B]`),
      [{ kind: "poll", text: "去哪", options: ["A", "B"] }],
      `[${tag}:…] 没认出来`
    );
  }
});

/*
 * **光秃秃的 `[A]` 故意不认**（用户原话里那个写法）。`[A]`、`[B]` 在正常文本
 * 里出现的概率不低 —— 模型写清单、复述选项表时很爱用 —— 而这套标记体系全是
 * `[标签:内容]`。认了的话一句「选项是[A]麻辣烫」就会真投出一票去。
 */
okWith("光秃秃的 [A] 不当投票（会误伤正常文本）", () => {
  assert.deepEqual(M.splitMedia("选项是[A]麻辣烫"), [
    { kind: "text", text: "选项是[A]麻辣烫" },
  ]);
  assert.equal(M.hasMedia("[A]"), false);
});

okWith("XML 标签块里的投票标记不算数（模型在 <thinking> 里复述格式）", () => {
  assert.deepEqual(M.splitMedia("<thinking>格式是 [vote:A] 和 [poll:x|a|b]</thinking>"), [
    { kind: "text", text: "<thinking>格式是 [vote:A] 和 [poll:x|a|b]</thinking>" },
  ]);
});

okWith("[vote:…] 退化时直接丢掉（一个光秃秃的「A」发过去没人看得懂）", () => {
  assert.equal(M.stripMediaTags("我选这个[vote:B]"), "我选这个");
  assert.equal(M.stripMediaTags("[vote:B]"), "");
});

/*
 * 发起投票退化成一句人话，照转账那条规矩 —— 气泡发不出去（本地 Mac 模式、
 * 开关关着、选项不够两个）的时候，这件事的意思还是得说出去，对方照样能回
 * 一句「炸鸡」。
 */
okWith("[poll:…] 退化成「标题：选项 / 选项」", () => {
  assert.equal(
    M.stripMediaTags("[poll:今晚吃什么|麻辣烫|炸鸡|海底捞]"),
    "今晚吃什么：麻辣烫 / 炸鸡 / 海底捞"
  );
  // 一个选项都没有就只剩标题，那本来就是句完整的话
  assert.equal(M.stripMediaTags("[poll:今晚吃什么]"), "今晚吃什么");
});

okWith("投票标记不影响别的标记（transfer / image 照旧）", () => {
  assert.deepEqual(M.splitMedia("[transfer:4000:零花钱][vote:A]"), [
    { kind: "transfer", text: "4000", note: "零花钱" },
    { kind: "vote", text: "A" },
  ]);
  assert.deepEqual(M.splitMedia("[image:一只猫]"), [
    { kind: "image", text: "一只猫", ref: "" },
  ]);
});

/* ================= 2. 字母 ↔ optionIdentifier ================= */

section("字母 ↔ 选项（poll.js）");

const OPTS = [
  { text: "麻辣烫", optionIdentifier: "o-1" },
  { text: "炸鸡", optionIdentifier: "o-2" },
  { text: "海底捞", optionIdentifier: "o-3" },
];

okWith("letterFor：0→A、25→Z，再往后用序号", () => {
  assert.equal(POLL.letterFor(0), "A");
  assert.equal(POLL.letterFor(2), "C");
  assert.equal(POLL.letterFor(25), "Z");
  assert.equal(POLL.letterFor(26), "27");
  // 越界不给空标签（苹果最多 10 个选项，这条线其实碰不到）
  assert.equal(POLL.letterFor(-1), "");
  assert.equal(POLL.letterFor("x"), "");
  assert.equal(POLL.letterFor(1.5), "");
});

okWith("renderOptions 拼成【A麻辣烫】【B炸鸡】【C海底捞】", () => {
  assert.equal(POLL.renderOptions(OPTS), "【A麻辣烫】【B炸鸡】【C海底捞】");
  assert.equal(POLL.renderOptions([]), "");
  assert.equal(POLL.renderOptions(null), "");
});

okWith("字母按下标取，大小写都认", () => {
  assert.equal(POLL.matchOption(OPTS, "A").optionIdentifier, "o-1");
  assert.equal(POLL.matchOption(OPTS, "b").optionIdentifier, "o-2");
  assert.equal(POLL.matchOption(OPTS, " C ").optionIdentifier, "o-3");
  // 只有三个选项，D 对不上 —— 不许回落到第一个
  assert.equal(POLL.matchOption(OPTS, "D"), null);
});

okWith("序号也认（1 = 第一个）", () => {
  assert.equal(POLL.matchOption(OPTS, "1").optionIdentifier, "o-1");
  assert.equal(POLL.matchOption(OPTS, "3").optionIdentifier, "o-3");
  assert.equal(POLL.matchOption(OPTS, "0"), null);
  assert.equal(POLL.matchOption(OPTS, "9"), null);
});

okWith("选项原文认（模型很爱直接写内容），先全等再包含", () => {
  assert.equal(POLL.matchOption(OPTS, "炸鸡").optionIdentifier, "o-2");
  assert.equal(POLL.matchOption(OPTS, "海底").optionIdentifier, "o-3");
  // 反方向：模型写全了「B炸鸡」这种带字母前缀的
  assert.equal(POLL.matchOption(OPTS, "B炸鸡").optionIdentifier, "o-2");
});

/*
 * 「A套餐」这种**以字母开头的选项**是这套匹配最容易出错的地方：单字母那条
 * 正则只认 `^[A-Za-z]$`，所以 `[vote:A套餐]` 走的是原文那条路（匹配到第二个），
 * 而光写 `[vote:A]` 才按下标取第一个。两种都验一下。
 */
okWith("选项本身以字母开头时，字母和原文各走各的路", () => {
  const tricky = [
    { text: "先别点", optionIdentifier: "t-1" },
    { text: "A套餐", optionIdentifier: "t-2" },
  ];
  assert.equal(POLL.matchOption(tricky, "A").optionIdentifier, "t-1"); // 下标 0
  assert.equal(POLL.matchOption(tricky, "A套餐").optionIdentifier, "t-2"); // 原文
});

okWith("认不出就返回 null（不瞎投一个）", () => {
  assert.equal(POLL.matchOption(OPTS, "披萨"), null);
  assert.equal(POLL.matchOption(OPTS, ""), null);
  assert.equal(POLL.matchOption([], "A"), null);
  assert.equal(POLL.matchOption(null, "A"), null);
  assert.equal(POLL.matchOption(OPTS, null), null);
});

/*
 * **选项后加的情形**（用户特别强调的那件事）：对方给投票加了第四个选项，
 * optionAdded 带回来的是**全量**选项表，所以 D 必须能对上新加的那个 ——
 * 而 A/B/C 的落点一个都不许变（不然角色刚看到的那句提示就对不上了）。
 */
okWith("选项后加：D 对上新选项，A/B/C 原地不动", () => {
  const more = [...OPTS, { text: "披萨", optionIdentifier: "o-4" }];
  assert.equal(POLL.renderOptions(more), "【A麻辣烫】【B炸鸡】【C海底捞】【D披萨】");
  assert.equal(POLL.matchOption(more, "D").optionIdentifier, "o-4");
  assert.equal(POLL.matchOption(more, "A").optionIdentifier, "o-1");
  assert.equal(POLL.matchOption(more, "B").optionIdentifier, "o-2");
  assert.equal(POLL.matchOption(more, "C").optionIdentifier, "o-3");
});

/* ================= 3. 事件流（含回源那条分支） ================= */

section("投票事件流（poll.js:watchPolls）");

/** 起一条订阅，把收到的事件攒起来。 */
async function watcherHarness() {
  photon.streams.length = 0;
  photon.getCalls.length = 0;
  const events = [];
  const w = await POLL.watchPolls({
    projectId: "p",
    projectSecret: "s",
    label: "小明",
    onEvent: (ev) => events.push(ev),
  });
  await waitFor("订阅建起来", () => photon.streams.length > 0);
  return { w, events, stream: photon.streams[0] };
}

/** 一条 poll.changed 事件的骨架。 */
const pollEv = (delta, over = {}) => ({
  type: "poll.changed",
  chatGuid: CHAT,
  pollMessageGuid: "P-1",
  isFromMe: false,
  delta,
  ...over,
});

await okAsync("created：标题和全部选项一起吐出来，chatGuid 归一成 peerKey", async () => {
  const H = await watcherHarness();
  H.stream.push(pollEv({ type: "created", title: "今晚吃什么", options: OPTS }));
  await waitFor("收到 created", () => H.events.length > 0);
  assert.equal(H.events[0].kind, "created");
  assert.equal(H.events[0].title, "今晚吃什么");
  assert.equal(H.events[0].peerKey, "+18005550100");
  assert.equal(H.events[0].pollMessageGuid, "P-1");
  assert.deepEqual(H.events[0].options, OPTS);
  // 说得清就不回源，省一次 RPC
  assert.equal(photon.getCalls.length, 0);
  await H.w.stop();
});

/*
 * **这就是用户那条 ZodError 的落点。** Photon 的 created delta 里 title 经常是
 * 空串（标题跑到那条独立的文本消息上去了），Spectrum 拿它去 asPoll 就炸
 * （path:["title"] expected string to have >=1 characters），于是连缓存都没建成。
 * 我们不 parse，直接回源问 polls.get 要权威的那份。
 */
await okAsync("title 是空串 → 回源 polls.get 补齐（ZodError 那条路）", async () => {
  const H = await watcherHarness();
  photon.getResult = { title: "今晚吃什么", options: OPTS };
  H.stream.push(pollEv({ type: "created", title: "", options: OPTS }));
  await waitFor("收到 created", () => H.events.length > 0);
  assert.deepEqual(photon.getCalls, ["P-1"]);
  assert.equal(H.events[0].title, "今晚吃什么");
  assert.deepEqual(H.events[0].options, OPTS);
  await H.w.stop();
});

await okAsync("选项少于两个 → 也回源（delta 说不清）", async () => {
  const H = await watcherHarness();
  photon.getResult = { title: "今晚吃什么", options: OPTS };
  H.stream.push(pollEv({ type: "created", title: "今晚吃什么", options: [OPTS[0]] }));
  await waitFor("收到 created", () => H.events.length > 0);
  assert.deepEqual(photon.getCalls, ["P-1"]);
  assert.equal(H.events[0].options.length, 3);
  await H.w.stop();
});

/*
 * 回源也读不出来的时候：**有几个选项就报几个**，别把整条事件吞掉。
 * 一个选项都没有才跳过 —— 那种提示说不出「选项有哪几个」，给了也没用。
 */
await okAsync("回源失败：还有选项就照样报，一个都没有才跳过", async () => {
  const H = await watcherHarness();
  photon.getThrows = true;
  H.stream.push(pollEv({ type: "created", title: "今晚吃什么", options: [OPTS[0]] }));
  await waitFor("收到 created", () => H.events.length > 0);
  assert.equal(H.events[0].options.length, 1);

  H.stream.push(pollEv({ type: "created", title: "", options: [] }, { pollMessageGuid: "P-2" }));
  await sleep(120);
  assert.equal(H.events.length, 1, "一个选项都没有的那条该被跳过");
  photon.getThrows = false;
  await H.w.stop();
});

/*
 * optionAdded 的 delta 带的是**全量**选项表，不是增量 —— 这就是用户那句
 * 「选项不止三个、有时候还会加，要全部识别好」成立的依据。
 */
await okAsync("optionAdded：带回全量选项（不是只有新加那个）", async () => {
  const H = await watcherHarness();
  const four = [...OPTS, { text: "披萨", optionIdentifier: "o-4" }];
  H.stream.push(pollEv({ type: "optionAdded", title: "今晚吃什么", options: four }));
  await waitFor("收到 optionAdded", () => H.events.length > 0);
  assert.equal(H.events[0].kind, "optionAdded");
  assert.equal(H.events[0].options.length, 4);
  assert.equal(
    POLL.renderOptions(H.events[0].options),
    "【A麻辣烫】【B炸鸡】【C海底捞】【D披萨】"
  );
  await H.w.stop();
});

await okAsync("voted / unvoted：只带 optionIdentifier，不回源", async () => {
  const H = await watcherHarness();
  H.stream.push(pollEv({ type: "voted", optionIdentifier: "o-2" }));
  H.stream.push(pollEv({ type: "unvoted", optionIdentifier: "o-2" }));
  await waitFor("两条都到", () => H.events.length === 2);
  assert.equal(H.events[0].kind, "voted");
  assert.equal(H.events[0].optionIdentifier, "o-2");
  assert.equal(H.events[1].kind, "unvoted");
  // 这两种压根不回源（选项文字从落盘那份查）
  assert.equal(photon.getCalls.length, 0);
  await H.w.stop();
});

/*
 * **自己干的不算。** 角色发起投票、或者角色自己投一票，都会从这条流回来一个
 * 事件 —— 不挡的话模型会收到「{{user}}向你发起了一个投票」，而那是它自己刚发的。
 */
await okAsync("isFromMe 的事件全部丢掉（角色自己发的投票 / 自己投的票）", async () => {
  const H = await watcherHarness();
  H.stream.push(pollEv({ type: "created", title: "x", options: OPTS }, { isFromMe: true }));
  H.stream.push(pollEv({ type: "voted", optionIdentifier: "o-1" }, { isFromMe: true }));
  await sleep(120);
  assert.equal(H.events.length, 0);
  await H.w.stop();
});

await okAsync("群聊 / 认不出地址的跳过（这套按「对面是谁」组织）", async () => {
  const H = await watcherHarness();
  for (const guid of ["iMessage;+;chat123456", "", "x;y"]) {
    H.stream.push(pollEv({ type: "created", title: "x", options: OPTS }, { chatGuid: guid }));
  }
  await sleep(120);
  assert.equal(H.events.length, 0);
  await H.w.stop();
});

await okAsync("没有 pollMessageGuid 的跳过（那是这个投票的身份）", async () => {
  const H = await watcherHarness();
  H.stream.push(pollEv({ type: "created", title: "x", options: OPTS }, { pollMessageGuid: "" }));
  await sleep(120);
  assert.equal(H.events.length, 0);
  await H.w.stop();
});

await okAsync("别的事件类型和别的 delta 一律不管", async () => {
  const H = await watcherHarness();
  H.stream.push({ type: "message.new", chatGuid: CHAT });
  H.stream.push(pollEv({ type: "closed" }));
  H.stream.push(pollEv(undefined));
  await sleep(120);
  assert.equal(H.events.length, 0);
  await H.w.stop();
});

/*
 * 没有 optionIdentifier 的选项要**滤掉**：投票只能按 id 投，没有 id 的那条
 * 留在表里会把字母顺序顶歪（模型写 B，投出去的是 C）。
 */
await okAsync("没有 optionIdentifier 的选项滤掉（免得把字母顺序顶歪）", async () => {
  const H = await watcherHarness();
  H.stream.push(
    pollEv({
      type: "created",
      title: "今晚吃什么",
      options: [{ text: "还没生成 id" }, ...OPTS],
    })
  );
  await waitFor("收到 created", () => H.events.length > 0);
  assert.deepEqual(H.events[0].options, OPTS);
  await H.w.stop();
});

await okAsync("stop() 把流和客户端都关掉", async () => {
  const before = photon.closedClients;
  const H = await watcherHarness();
  await H.w.stop();
  assert.equal(H.stream.closed, true, "流没关");
  assert.ok(photon.closedClients > before, "gRPC 客户端没关（channel 会一直挂着）");
});

/* ================= 4. 投一票 ================= */

section("投一票（poll.js:castVote）");

await okAsync("投出去的是 pollMessageGuid + optionIdentifier", async () => {
  photon.voteCalls.length = 0;
  const ok = await POLL.castVote({
    projectId: "p",
    projectSecret: "s",
    pollMessageGuid: "P-1",
    optionIdentifier: "o-2",
  });
  assert.equal(ok, true);
  assert.deepEqual(photon.voteCalls, [{ guid: "P-1", optionIdentifier: "o-2" }]);
});

/*
 * 四个入参缺一个就**压根不开客户端**。最要紧的是 optionIdentifier 空串那条：
 * 角色自己刚发起的投票存的就是空 id（space.send 还不回来），不挡的话会拿空串
 * 去投一票，Photon 那边的行为没定义。
 */
await okAsync("入参缺一个就不开客户端（尤其是空的 optionIdentifier）", async () => {
  photon.voteCalls.length = 0;
  const base = {
    projectId: "p",
    projectSecret: "s",
    pollMessageGuid: "P-1",
    optionIdentifier: "o-1",
  };
  for (const key of ["projectId", "projectSecret", "pollMessageGuid", "optionIdentifier"]) {
    assert.equal(await POLL.castVote({ ...base, [key]: "" }), false, `${key} 空的时候不该投`);
  }
  assert.equal(photon.voteCalls.length, 0);
});

await okAsync("线路投不上去就返回 false（不抛，也不重试）", async () => {
  photon.voteCalls.length = 0;
  photon.voteThrows = true;
  const ok = await POLL.castVote({
    projectId: "p",
    projectSecret: "s",
    pollMessageGuid: "P-1",
    optionIdentifier: "o-1",
  });
  assert.equal(ok, false);
  // 试过一次就收手 —— 重试可能变成投两次
  assert.equal(photon.voteCalls.length, 1);
  photon.voteThrows = false;
});

await okAsync("投票用完就关客户端（不留连接）", async () => {
  const before = photon.closedClients;
  await POLL.castVote({
    projectId: "p",
    projectSecret: "s",
    pollMessageGuid: "P-1",
    optionIdentifier: "o-1",
  });
  assert.ok(photon.closedClients > before);
});

/* 写操作的超时要比读详情宽（照 card.js 的 12 秒），而且必须真传下去。 */
await okAsync("投票带超时（长连接那条不带，这条必须带）", async () => {
  photon.clientOpts.length = 0;
  await POLL.castVote({
    projectId: "p",
    projectSecret: "s",
    pollMessageGuid: "P-1",
    optionIdentifier: "o-1",
  });
  assert.ok(photon.clientOpts[0]?.timeout > 0, "投票那条没设一元超时");
});

/* ================= 5. 落盘（pollstore.js） ================= */

section("落盘（pollstore.js）");

okWith("putPoll → findPoll 拿回同一份，字母顺序原样保住", () => {
  assert.equal(PS.putPoll("role1", {
    pollMessageGuid: "P-1",
    chatGuid: CHAT,
    peerKey: "+18005550100",
    title: "今晚吃什么",
    options: OPTS,
  }), true);
  const hit = PS.findPoll("role1", "P-1");
  assert.equal(hit.title, "今晚吃什么");
  assert.deepEqual(
    hit.options.map((o) => o.optionIdentifier),
    ["o-1", "o-2", "o-3"]
  );
  assert.equal(hit.mine, false);
  assert.ok(hit.at > 0);
});

/*
 * 加了选项就**整份覆盖**选项数组，不 merge —— 字母是按下标算的，merge
 * 出来的顺序一歪，模型写的 B 就投到别的选项上去了。
 */
okWith("同一个 guid 再 put 一次是覆盖（选项整份换掉，不 merge）", () => {
  PS.putPoll("role1", {
    pollMessageGuid: "P-1",
    chatGuid: CHAT,
    peerKey: "+18005550100",
    title: "今晚吃什么",
    options: [...OPTS, { text: "披萨", optionIdentifier: "o-4" }],
  });
  const items = PS.readPolls("role1").items.filter((it) => it.pollMessageGuid === "P-1");
  assert.equal(items.length, 1, "同一个 guid 存出两条来了");
  assert.equal(items[0].options.length, 4);
});

/*
 * `mine` 要**继承**。optionAdded / voted 那些事件压根不知道这个投票是谁发起的，
 * 不继承的话会把 true 洗成 false，「{{user}}在你发起的投票里投了…」那句就没了。
 */
okWith("mine 一旦为真就继承下去（后续事件不带这个信息）", () => {
  PS.putPoll("role1", { pollMessageGuid: "P-9", chatGuid: CHAT, title: "我发的", options: OPTS, mine: true });
  assert.equal(PS.findPoll("role1", "P-9").mine, true);
  // 不带 mine 的更新（optionAdded 就是这样）
  PS.putPoll("role1", { pollMessageGuid: "P-9", chatGuid: CHAT, title: "我发的", options: OPTS });
  assert.equal(PS.findPoll("role1", "P-9").mine, true, "mine 被洗掉了");
});

okWith("落盘的字段是白名单（调用方手上的大对象漏不进磁盘）", () => {
  PS.putPoll("role1", {
    pollMessageGuid: "P-8",
    chatGuid: CHAT,
    title: "x",
    options: OPTS,
    secret: "不该上盘的东西",
    space: { huge: true },
  });
  const hit = PS.findPoll("role1", "P-8");
  assert.equal(hit.secret, undefined);
  assert.equal(hit.space, undefined);
  assert.deepEqual(Object.keys(hit).sort(), [
    "at", "chatGuid", "mine", "options", "peerKey", "pollMessageGuid", "title",
  ]);
});

okWith("findLatestPoll 取这条会话最近活动的那个（数组末尾）", () => {
  const other = "iMessage;-;+18005550199";
  PS.putPoll("role2", { pollMessageGuid: "A", chatGuid: CHAT, title: "老的", options: OPTS });
  PS.putPoll("role2", { pollMessageGuid: "B", chatGuid: other, title: "别人的", options: OPTS });
  PS.putPoll("role2", { pollMessageGuid: "C", chatGuid: CHAT, title: "新的", options: OPTS });
  assert.equal(PS.findLatestPoll("role2", CHAT).pollMessageGuid, "C");
  assert.equal(PS.findLatestPoll("role2", other).pollMessageGuid, "B");
  assert.equal(PS.findLatestPoll("role2", "iMessage;-;+18005550000"), null);
  assert.equal(PS.findLatestPoll("role2", ""), null);
});

/*
 * 更新会**挪到队尾**，所以「最近活动」认的是活动顺序而不是创建顺序：给老投票
 * 加一个选项之后，角色写的 [vote:B] 就该投到那个老投票上。
 */
okWith("更新过的投票挪到队尾（给老投票加选项之后它就是最近的那个）", () => {
  PS.putPoll("role2", { pollMessageGuid: "A", chatGuid: CHAT, title: "老的加了个选项", options: OPTS });
  assert.equal(PS.findLatestPoll("role2", CHAT).pollMessageGuid, "A");
});

okWith(`超过 MAX_ENTRIES（${PS.MAX_ENTRIES}）从最旧的丢`, () => {
  for (let i = 0; i < PS.MAX_ENTRIES + 20; i += 1) {
    PS.putPoll("role3", { pollMessageGuid: `p${i}`, chatGuid: CHAT, title: "t", options: OPTS });
  }
  const { items } = PS.readPolls("role3");
  assert.equal(items.length, PS.MAX_ENTRIES);
  assert.equal(items[0].pollMessageGuid, "p20", "丢的不是最旧的那批");
  assert.equal(items.at(-1).pollMessageGuid, `p${PS.MAX_ENTRIES + 19}`);
  // 丢掉的那些查不到了，剩下的照样能查
  assert.equal(PS.findPoll("role3", "p0"), null);
  assert.ok(PS.findPoll("role3", "p20"));
});

okWith("guid 是空的就不写（那是这个投票的身份）", () => {
  assert.equal(PS.putPoll("role1", { pollMessageGuid: "", chatGuid: CHAT, options: OPTS }), false);
  assert.equal(PS.putPoll("role1", {}), false);
});

/*
 * roleKey 直接当文件名用，所以必须挡住 `../` 那一类 —— 不挡的话一个角色名
 * 就能往仓库外面写文件。
 */
okWith("roleKey 不合法一律拒写（../evil 那种）", () => {
  for (const bad of ["../evil", "a/b", "a.b", "", "  ", "汉字"]) {
    assert.equal(PS.putPoll(bad, { pollMessageGuid: "X", chatGuid: CHAT, options: OPTS }), false, `${bad} 居然写进去了`);
    assert.deepEqual(PS.readPolls(bad).items, []);
    assert.equal(PS.findPoll(bad, "X"), null);
  }
  assert.equal(fs.existsSync(path.join(tmp, "polls", "..", "evil.json")), false);
});

/*
 * 坏文件**不删不改名**：读不出来就当空的用，字节一个都不动。删掉的代价是几个
 * 老投票投不了；毁掉用户文件的代价没法挽回。
 */
okWith("文件坏了当空的用，而且字节一个不动", () => {
  const file = path.join(tmp, "polls", "role4.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ 这不是 json", "utf-8");
  assert.deepEqual(PS.readPolls("role4").items, []);
  assert.equal(PS.findPoll("role4", "P-1"), null);
  assert.equal(fs.readFileSync(file, "utf-8"), "{ 这不是 json", "坏文件被动过了");
});

okWith("items 不是数组、空文件、没这个文件都当空的用", () => {
  const file = path.join(tmp, "polls", "role5.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, items: { nope: 1 } }), "utf-8");
  assert.deepEqual(PS.readPolls("role5").items, []);
  fs.writeFileSync(file, "   ", "utf-8");
  assert.deepEqual(PS.readPolls("role5").items, []);
  assert.deepEqual(PS.readPolls("role-never-written").items, []);
});

okWith("一个角色一份，互不串", () => {
  assert.ok(PS.findPoll("role1", "P-1"));
  assert.equal(PS.findPoll("role2", "P-1"), null);
});

okWith("写的是原子的（不留 .tmp）", () => {
  const left = fs.readdirSync(path.join(tmp, "polls")).filter((f) => f.endsWith(".tmp"));
  assert.deepEqual(left, []);
});

/* ================= 6. 手写 / Digital Touch ================= */

section("手写 / Digital Touch（card.js）");

okWith("认得出手写和 Digital Touch 这两个 bundleId", () => {
  assert.equal(
    CARD.embeddedKindOf("com.apple.Handwriting.HandwritingProvider"),
    "handwriting"
  );
  assert.equal(
    CARD.embeddedKindOf("com.apple.DigitalTouchBalloonProvider"),
    "digitalTouch"
  );
});

/*
 * **全等匹配，不做前缀。** 前缀匹配会把别人家恰好同前缀的扩展当成手写消息，
 * 然后拿「逐字读出上面写的内容」那句提示词去问一张根本不是手写的图。
 */
okWith("别的气泡一个都不误判（Apple Cash、富链接、第三方卡片、空）", () => {
  for (const id of [
    "com.apple.messages.URLBalloonProvider",
    "com.apple.messages.MSMessageExtensionBalloonPlugin:0000000000:com.apple.PassbookUIService.PeerPaymentMessagesExtension",
    "com.apple.messages.MSMessageExtensionBalloonPlugin:XXXX:com.netease.cloudmusic.iMessageExtension",
    // 同前缀但不是那两个 —— 前缀匹配就会在这儿栽
    "com.apple.Handwriting.HandwritingProvider.evil",
    "com.apple.DigitalTouchBalloonProvider2",
    "",
    null,
    undefined,
  ]) {
    assert.equal(CARD.embeddedKindOf(id), "", `${id} 被误判了`);
  }
});

await okAsync("取字节：入参缺一个就不打 RPC", async () => {
  const base = { projectId: "p", projectSecret: "s", chatGuid: CHAT, messageGuid: "M-1" };
  photon.embedded = null;
  for (const key of ["projectId", "projectSecret", "chatGuid", "messageGuid"]) {
    assert.equal(await CARD.fetchEmbeddedMedia({ ...base, [key]: "" }), null);
  }
  assert.equal(photon.embedded, null, "居然打了 RPC");
});

await okAsync("取字节：Uint8Array 转成 Buffer，mimeType 带回来", async () => {
  photon.embedded = {
    reply: { data: new Uint8Array([1, 2, 3, 4]), mimeType: "image/png" },
  };
  const got = await CARD.fetchEmbeddedMedia({
    projectId: "p",
    projectSecret: "s",
    chatGuid: CHAT,
    messageGuid: "M-1",
  });
  assert.ok(Buffer.isBuffer(got.buffer));
  assert.deepEqual([...got.buffer], [1, 2, 3, 4]);
  assert.equal(got.mimeType, "image/png");
  // 问的是这条会话上的这条消息
  assert.deepEqual(photon.embedded.asked, { chatGuid: CHAT, messageGuid: "M-1" });
});

await okAsync("取字节：取不到 / 空字节 / 抛错都返回 null（不是错，上面那句提示兜着）", async () => {
  const ask = () =>
    CARD.fetchEmbeddedMedia({
      projectId: "p",
      projectSecret: "s",
      chatGuid: CHAT,
      messageGuid: "M-1",
    });
  photon.embedded = { reply: null };
  assert.equal(await ask(), null);
  photon.embedded = { reply: { data: new Uint8Array([]), mimeType: "image/png" } };
  assert.equal(await ask(), null);
  photon.embeddedThrows = true;
  assert.equal(await ask(), null);
  photon.embeddedThrows = false;
});

await okAsync("取字节：用完就关客户端", async () => {
  photon.embedded = { reply: { data: new Uint8Array([1]), mimeType: "image/png" } };
  const before = photon.closedClients;
  await CARD.fetchEmbeddedMedia({
    projectId: "p",
    projectSecret: "s",
    chatGuid: CHAT,
    messageGuid: "M-1",
  });
  assert.ok(photon.closedClients > before);
});

/*
 * **专用提示词是这一摊的关键。** 通用那句「描述这张图片」拿去看手写消息，模型
 * 会答「一张白底的蓝色手写字迹」，而不是把那句话**读出来**。
 */
okWith("手写那句提示词是「读出内容」，不是「描述图片」", () => {
  const hw = C.DEFAULT_HANDWRITING_PROMPT;
  assert.ok(hw.includes("手写"));
  assert.ok(/读出|逐字/.test(hw), "没让它读出内容");
  assert.ok(!hw.includes("描述这张图片"));
});

okWith("Digital Touch 那句提示词问的是「哪一种 + 什么颜色」", () => {
  const dt = C.DEFAULT_DIGITAL_TOUCH_PROMPT;
  // 心跳/火球/亲吻/心碎那几种得列出来，不列模型答不出专有名词
  assert.ok(/心跳/.test(dt) && /火球/.test(dt) && /亲吻/.test(dt) && /心碎/.test(dt));
  assert.ok(/颜色/.test(dt));
});

okWith("两个开关都归一成 {enabled:boolean}，默认关", () => {
  const role = C.normalizeConfig({ roles: [{ id: "r0", name: "x" }] }).roles[0];
  assert.deepEqual(role.poll, { enabled: false });
  assert.deepEqual(role.handwriting, { enabled: false });
  const on = C.normalizeConfig({
    roles: [{ id: "r0", name: "x", poll: { enabled: 1 }, handwriting: { enabled: "yes" } }],
  }).roles[0];
  assert.equal(on.poll.enabled, true);
  assert.equal(on.handwriting.enabled, true);
  // 乱填的一律当关着
  for (const v of [null, undefined, 0, "", "false", []]) {
    const r = C.normalizeConfig({ roles: [{ id: "r0", name: "x", poll: { enabled: v } }] }).roles[0];
    assert.equal(r.poll.enabled, Boolean(v), `poll.enabled=${JSON.stringify(v)} 归一错了`);
  }
});

/* ================= 7. 两道闸 ================= */

section("提示词那两道闸（预设子条目 + 角色开关）");

const basePreset = {
  id: "p1",
  name: "默认",
  entries: [{ kind: "format", enabled: true, children: P.defaultFormatChildren() }],
};

okWith("投票在固定子条目里，新建预设时就有", () => {
  assert.ok(P.FORMAT_CHILD_KINDS.includes("poll"));
  assert.equal(P.FORMAT_CHILD_TAGS.poll, "投票");
  assert.equal(P.ROLE_GATED_CHILDREN.poll, "poll");
  const kid = P.defaultFormatChildren().find((c) => c.kind === "poll");
  assert.ok(kid?.content?.includes("[vote:A]"));
  assert.ok(kid.content.includes("[poll:"));
  // 一人一票这件事必须写在文案里 —— 接口层面做不到多选
  assert.ok(/一次只能投一个/.test(kid.content));
});

/*
 * 老配置里压根没有 poll 这个 kind。补进去时 enabled 该是开的（缺字段一律补开，
 * 见 preset.js:defaultChildEnabled）—— 反正还压着角色那道闸，默认关。
 */
okWith("老预设迁移：补出 poll 子条目，别的条目的开关不动", () => {
  const legacy = P.defaultFormatChildren()
    .filter((c) => c.kind !== "poll")
    .map((c) => ({ ...c, enabled: false }));
  const norm = P.normalizePresets([
    { id: "p9", name: "老的", entries: [{ kind: "format", children: legacy }] },
  ]);
  const kids = norm[0].entries.find((e) => e.kind === "format").children;
  assert.equal(kids.find((c) => c.kind === "poll")?.enabled, true);
  assert.ok(kids.filter((c) => c.kind !== "poll").every((c) => c.enabled === false));
});

{
  const cfgWith = (poll) =>
    C.normalizeConfig({
      presets: [basePreset],
      roles: [{ id: "r1", name: "小明", prompt: "你是小明", presetRef: "p1", poll }],
    });
  /*
   * 只看 `messages` —— 那才是真送进模型的那份。buildPrompt 还会把整份 preset
   * 原样回传（给界面和排查用），里面当然带着 poll 子条目的原文，拿整个返回值
   * 去 includes 的话这两道闸永远测不出来。
   */
  const promptOf = async (cfg) =>
    JSON.stringify((await PR.buildPrompt(cfg, cfg.roles[0], { name: "我" }, [])).messages);

  const textOff = await promptOf(cfgWith({ enabled: false }));
  const textOn = await promptOf(cfgWith({ enabled: true }));

  okWith("角色关着 → 提示词里没有 <投票>（子条目开着也不注入）", () => {
    assert.ok(!textOff.includes("<投票>"));
    assert.ok(!textOff.includes("[vote:"));
  });
  okWith("角色开着 → 注入 <投票>，教的是 [vote:A] 和 [poll:注释|选项…]", () => {
    assert.ok(textOn.includes("<投票>"));
    assert.ok(textOn.includes("[vote:A]"));
    assert.ok(textOn.includes("[poll:"));
  });
}

{
  // 子条目关掉：角色开着也不该注入（另一道闸）
  const kids = P.defaultFormatChildren().map((c) =>
    c.kind === "poll" ? { ...c, enabled: false } : c
  );
  const cfg = C.normalizeConfig({
    presets: [
      { id: "p2", name: "关了那条", entries: [{ kind: "format", enabled: true, children: kids }] },
    ],
    roles: [{ id: "r2", name: "小明", prompt: "你是小明", presetRef: "p2", poll: { enabled: true } }],
  });
  const text = JSON.stringify(
    (await PR.buildPrompt(cfg, cfg.roles[0], { name: "我" }, [])).messages
  );
  okWith("预设里那条子条目关着 → 角色开着也不注入", () => {
    assert.ok(!text.includes("<投票>"));
    assert.ok(!text.includes("[vote:"));
  });
}

/* 线下模式整条「消息格式与功能」都不注入 —— 线下不发气泡，投票也发不出去。 */
{
  const cfg = C.normalizeConfig({
    presets: [
      {
        id: "po",
        name: "线下",
        mode: "offline",
        entries: [{ kind: "format", enabled: true, children: P.defaultFormatChildren() }],
      },
    ],
    roles: [
      {
        id: "r3",
        name: "小明",
        prompt: "你是小明",
        poll: { enabled: true },
        offline: { presetRef: "po" },
      },
    ],
  });
  const text = JSON.stringify(
    (await PR.buildPrompt(cfg, cfg.roles[0], { name: "我" }, [], "", { mode: "offline" })).messages
  );
  okWith("线下模式不注入投票（整条「消息格式与功能」都跳过）", () => {
    assert.ok(!text.includes("<投票>"));
    assert.ok(!text.includes("[vote:"));
  });
}

/* ================= 8. 服务端接线（读源码） ================= */

section("imessage.js 的接线（读源码，跑不起真桥接）");

{
  const src = fs.readFileSync(new URL("../server/src/imessage.js", import.meta.url), "utf-8");
  const at = (needle) => {
    const i = src.indexOf(needle);
    assert.ok(i > 0, `找不到：${needle}`);
    return i;
  };

  okWith("vote / poll 两个 kind 各有自己的分发分支", () => {
    assert.ok(src.includes('part.kind === "vote"'));
    assert.ok(src.includes('part.kind === "poll"'));
    assert.ok(src.includes("sendPollPart(runner, space, part, ctx)"));
    assert.ok(src.includes('vote: "投票"'));
    assert.ok(src.includes('poll: "发起投票"'));
  });

  /*
   * 投票**不新起消息**（它改的是一条已有气泡），所以和 react / undo 同一档：
   * 不打 typing、不计 sent，只计 acted。计了 sent 的话「一轮至少发一条」那套
   * 统计会把它当成一条新消息，日志和「什么都没发出去」的判断全歪。
   */
  okWith("投票走 react/undo 那一档：只算 acted，不算 sent", () => {
    /*
     * 只截**这个 if 块**（到它的 continue 为止）。截固定字数会越过 continue
     * 吃到下面那一档媒体分支 —— 那边本来就有 startTyping 和 sent += 1，于是
     * 这三条断言全都在验错误的代码。
     */
    const branch = at('part.kind === "vote"');
    const end = src.indexOf("continue;", branch);
    assert.ok(end > branch, "vote 那个分支没有 continue？");
    const body = src.slice(branch, end);
    assert.ok(/acted \+= 1/.test(body), "没算 acted");
    assert.ok(!/sent \+= 1/.test(body), "投票不该算 sent（它不新起消息）");
    assert.ok(!/typing/i.test(body), "投票不该打 typing");
  });

  /*
   * runVotePart 的签名里**没有 space**：投票走的是裸 gRPC（Spectrum 没有这个口），
   * 拿到 space 也没用。有 space 反而容易让人以为能 space.send 出去。
   */
  okWith("runVotePart 不收 space（投票走裸 gRPC，不经 Spectrum）", () => {
    assert.ok(src.includes("async function runVotePart(runner, part, ctx)"));
  });

  okWith("发起投票算 sent 也算 acted（它是一条新消息）", () => {
    const branch = at('part.kind === "poll"');
    const body = src.slice(branch, branch + 300);
    assert.ok(/sent \+= 1/.test(body));
    assert.ok(/acted \+= 1/.test(body));
  });

  okWith("发起投票：选项不够两个、本地模式都退化成一句文字", () => {
    const body = src.slice(at("async function sendPollPart("), at("async function sendPollText("));
    assert.ok(body.includes("options.length < 2"), "找不到选项不够那道判断");
    assert.ok(body.includes('runner.mode !== "cloud"'), "找不到本地模式那道判断");
    assert.ok(body.match(/sendPollText\(/g)?.length >= 2, "两条退路都该走 sendPollText");
    assert.ok(body.includes("MAX_POLL_OPTIONS"), "超十个选项没截断");
    assert.ok(body.includes("MAX_POLL_TITLE"), "标题没截长度");
  });

  /*
   * **先落盘，再说话。** 字母 → optionIdentifier 那张表是角色之后投票的唯一凭据，
   * 而「说话」要打模型、可能几十秒，中间进程完全可能被重启。顺序反了就会出现
   * 「模型收到了投票、也回了 [vote:B]，但没人知道 B 是哪个 id」。
   */
  okWith("handlePollEvent 里 putPoll 排在 enqueue 之前", () => {
    const body = src.slice(at("async function handlePollEvent("), at("function pollHintFor("));
    const put = body.indexOf("putPoll(");
    const enq = body.indexOf("enqueue(");
    assert.ok(put > 0 && enq > 0);
    assert.ok(put < enq, "落盘跑到说话后面去了");
    // 压标题的登记也要在说话之前 —— 那条文本可能已经在队列里躺着了
    const note = body.indexOf("notePollTitle(");
    assert.ok(note > 0 && note < enq, "压标题的登记跑到 enqueue 后面去了");
  });

  /*
   * 发起投票时标题会作为一条**独立的普通文本消息**进来，压重必须拦在
   * noteInbound 之前 —— noteInbound 之后那条文本已经记进上下文了，再跳过也
   * 只是不回它，模型照样看两遍标题。
   */
  okWith("压标题拦在 noteInbound 之前", () => {
    /*
     * 比的必须是**调用点**。写成 `at("noteInbound(")` 会撞上函数定义那一行
     * （定义在文件前半部分），于是这条永远绿 —— 比的是两个 function 的位置，
     * 和入站循环里的先后一点关系都没有。所以连着实参一起匹配。
     */
    const echo = at("isPollTitleEcho(runner, spaceId");
    const note = at("noteInbound(runner, spaceId, message, userText");
    assert.ok(echo < note, "压标题跑到 noteInbound 后面去了");
  });

  okWith("桥接停的时候把投票那条长连接收掉（不然 gRPC 一直挂着）", () => {
    const body = src.slice(at("function stopRunner("), at("function stopRunner(") + 3000);
    assert.ok(body.includes("runner.pollWatcher"), "stopRunner 没收 pollWatcher");
    assert.ok(body.includes("runner.pollTitles?.clear()"), "压标题那张表没清");
    assert.ok(src.includes("pollWatcher: null"), "createRunner 没初始化 pollWatcher");
  });

  okWith("本地 Mac 模式：开关开着也只 warn 一句，不起订阅", () => {
    const body = src.slice(at("function startPollWatcher("), at("async function spaceForChat("));
    assert.ok(body.includes('runner.mode !== "cloud"'));
    assert.ok(body.includes("logWarn"));
    assert.ok(body.includes("runner.stopped"), "订阅建好时没判 stopped（会留野订阅）");
  });

  /*
   * 事件走 enqueue 而不是直接 handleTurn：用户**投票**时 iMessage 压根不再发
   * 文本消息，攒着等下一条消息就等于永远等不到 —— 角色问了「今晚吃什么」
   * 就该听见回答。
   */
  okWith("投票事件走 enqueue（不是攒着等下一条消息）", () => {
    const body = src.slice(at("async function handlePollEvent("), at("function pollHintFor("));
    assert.ok(body.includes("enqueue(getConfig, runner, space, chatGuid, { text: hint }, peer)"));
  });

  okWith("注入的那句话和用户钉的样板一致", () => {
    const body = src.slice(at("function pollHintFor("), at("function pollHintFor(") + 1800);
    assert.ok(body.includes("向你发起了一个投票，注释是"));
    assert.ok(body.includes("renderOptions(options)"), "选项没按字母表渲");
    assert.ok(body.includes("[vote:A]"));
    assert.ok(body.includes("一次只能投一个选项"));
    assert.ok(body.includes("你也可以不投票，直接回复文字即可"));
  });

  okWith("手写 / DT：三道闸齐全，不是图片就保留原来那句提示", () => {
    const body = src.slice(at("const embedKind = embeddedKindOf("), at("const embedKind = embeddedKindOf(") + 3200);
    assert.ok(body.includes("who?.handwriting?.enabled"), "找不到角色开关");
    assert.ok(body.includes('runner.mode !== "cloud"'), "找不到云端那道闸");
    assert.ok(body.includes(".vision"), "没判角色有没有配识图端点");
    assert.ok(body.includes('mime.startsWith("image/")'), "没判是不是图片");
    assert.ok(body.includes("MAX_IMAGE_BYTES"), "没判体积");
    assert.ok(body.includes("shrinkForVision"), "没压图");
    assert.ok(body.includes("DEFAULT_HANDWRITING_PROMPT"));
    assert.ok(body.includes("DEFAULT_DIGITAL_TOUCH_PROMPT"));
  });

  okWith("describeImages 认 image.prompt / image.label（专用提示词靠这两行）", () => {
    const body = src.slice(at("function describeImages("), at("function describeImages(") + 2000);
    assert.ok(body.includes("image?.prompt || prompt"), "没让 image.prompt 覆盖角色那句");
    assert.ok(body.includes("image?.label ||"), "没让 image.label 覆盖「图片N」");
  });
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} 项全部通过\n`);
