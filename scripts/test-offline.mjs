/*
 * 线下模式的离线验证。
 *
 * 指向临时数据目录（URANUS_DATA_DIR），绝不碰用户真实的 data/ ——
 * 那里面有真的 API key、Photon 凭据、聊天记录，以及攒出来的剧情。
 * 跑法：node scripts/test-offline.mjs
 *
 * 全程不打网络：验的是**开关、落盘和提示词怎么拼**，不验模型答得好不好。
 * 所以 runOfflineTurn / maybeSummarize 这两条要打接口的路，只验它们的
 * 触发条件和纯函数部分（`splitChoices`、`uncovered*` 的计数），
 * 生成本身留给沙箱里手点。
 *
 * 最要紧的三条在第 3、6、7 节：
 *  - 线下的提示词里「消息格式与功能」**一定不出现**（哪怕预设里它开着）
 *  - 结束线下只往待总结写小/大总结，不写原始轮次，且行首是 `[线下剧情]`
 *  - 剧情文件读不出来的时候只 warn，绝不删、绝不改名
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "uranus-offline-"));
process.env.URANUS_DATA_DIR = TMP;
process.env.IMESSAGE_BRIDGE = "off";

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
    return;
  }
  fail += 1;
  console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`);
}

/*
 * 造一份最小配置。
 *
 * 角色 / 用户人设 / 预设 / 世界书**一个文件一条**，分别放在 characters、user、
 * presets、worlds 四个文件夹里（`config.js:COLLECTIONS`）—— 那四个文件夹一旦
 * 存在，里面的内容就会盖掉 config.json 里同名的数组。写在 config.json 里
 * 会被读成空表，然后所有断言都对着一份空配置跑。
 */
/** 写一条集合成员，同时把原文留下来 —— 第 11 节要拿它比字节。 */
const write = (dir, file, obj) => {
  fs.mkdirSync(path.join(TMP, dir), { recursive: true });
  const raw = JSON.stringify(obj);
  fs.writeFileSync(path.join(TMP, dir, file), raw);
  return raw;
};

const CONFIG_RAW = JSON.stringify({
  providers: [
    {
      id: "prov-a",
      name: "甲源",
      url: "https://a.example.com/v1",
      keys: [""],
      models: [{ id: "m1", model: "gpt-4o", enabled: true, categories: ["chat"] }],
    },
  ],
});
fs.writeFileSync(path.join(TMP, "config.json"), CONFIG_RAW);

/*
 * 人设正文那一栏叫 `description`，不叫 persona —— 角色和用户人设都是
 * （`config.js:normalizeRole` / `normalizeUser`，`prompt.js:648` 读的就是它）。
 * 写错名字的话 normalize 会把它丢掉，人设那两段变成空的，而「线下不带 format」
 * 那类断言照样绿 —— 空提示词里什么都搜不到。
 */
write("user", "01-阿元.json", { id: "u-1", name: "阿元", scope: "global", description: "我是阿元。" });

write("worlds", "01-全局书.json", {
  id: "wb-global",
  name: "全局书",
  global: true,
  entries: [{ id: "e1", name: "常驻", constant: true, enabled: true, content: "天上有两个月亮。" }],
});
write("worlds", "02-线上专用书.json", {
  id: "wb-online",
  name: "线上专用书",
  entries: [{ id: "e2", name: "常驻", constant: true, enabled: true, content: "线上专用设定。" }],
});
write("worlds", "03-线下专用书.json", {
  id: "wb-offline",
  name: "线下专用书",
  entries: [{ id: "e3", name: "常驻", constant: true, enabled: true, content: "线下专用设定。" }],
});

// 线上那份：format 开着（默认就是开的），用来验线下**一定不带它**
write("presets", "01-线上预设.json", { id: "ps-online", name: "线上预设" });
write("presets", "02-线下预设.json", {
  id: "ps-offline",
  name: "线下预设",
  mode: "offline",
  // format 故意写成开着 —— 线下必须无条件跳过它，不能靠这个开关
  entries: [
    { kind: "char", enabled: true },
    { kind: "user", enabled: true },
    { kind: "world", enabled: true },
    { kind: "format", enabled: true },
    { kind: "context", enabled: true },
    { kind: "memory", enabled: false },
    { kind: "userChoice", enabled: false },
  ],
});

const ROLE_RAW = write("characters", "01-Jack.json", {
  id: "role-1",
  name: "Jack",
  description: "你是 Jack。",
  chatModel: { provider: "prov-a", modelId: "m1" },
  maxContext: 20,
  presetRef: "ps-online",
  worldBookRefs: ["wb-online"],
  offline: {
    enabled: true,
    presetRef: "ps-offline",
    worldBookRefs: ["wb-offline"],
    smallEvery: 6,
    bigEnabled: false,
    bigEvery: 8,
    userChoice: false,
  },
});

const P = await import("../server/src/preset.js");
const S = await import("../server/src/offlinestore.js");
const O = await import("../server/src/offline.js");
const C = await import("../server/src/commands.js");
const { loadConfig } = await import("../server/src/config.js");
const { buildPrompt } = await import("../server/src/prompt.js");
const { memoryKeyFor } = await import("../server/src/memorystore.js");

const config = loadConfig();
const role = config.roles[0];
const user = config.users[0];
const KEY = memoryKeyFor(role);

console.log("\n=== 1. 预设分两批（mode） ===");
{
  // 缺字段的老预设一律算线上 —— 升级现有配置不能让所有预设突然变线下
  check("缺 mode 算线上", P.normalizePreset({ name: "老的" }, "p1").mode, "online");
  check("认 offline", P.normalizePreset({ name: "x", mode: "offline" }, "p2").mode, "offline");
  // 乱填的值不能穿过去，否则 presetsFor 两批都筛不到它，等于凭空消失
  check("乱填的算线上", P.normalizePreset({ name: "x", mode: "上线" }, "p3").mode, "online");
  check("空字符串算线上", P.normalizePreset({ name: "x", mode: "" }, "p4").mode, "online");

  const kinds = (p) => p.entries.filter((e) => e.kind !== "custom").map((e) => e.kind);
  // 线上预设里出现 userChoice 要被当成 custom 处理掉，不能留在固定条目里
  const online = P.normalizePreset(
    { name: "线上", entries: [{ kind: "userChoice", enabled: true, content: "x" }] },
    "p5"
  );
  checkThat("线上预设不认 userChoice", !kinds(online).includes("userChoice"), kinds(online).join(","));
  check("线上的固定条目还是六个", kinds(online), P.FIXED_KINDS);

  // 线下预设缺了 userChoice 要补上，而且默认关（用户点名的默认值）
  const off = P.normalizePreset({ name: "线下", mode: "offline", entries: [] }, "p6");
  check("线下的固定条目七个", kinds(off), P.OFFLINE_FIXED_KINDS);
  const choice = off.entries.find((e) => e.kind === "userChoice");
  check("补出来的用户选项默认关", choice.enabled, false);
  checkThat("补出来的用户选项带正文", choice.content.trim().length > 20, choice.content);
  // 线下的 format 默认也关 —— 线下压根不用它，默认开着只会让人以为它在起作用
  check("线下的 format 默认关", off.entries.find((e) => e.kind === "format").enabled, false);
  // 用户改过的正文不能被补齐逻辑冲掉
  const kept = P.normalizePreset(
    { name: "线下", mode: "offline", entries: [{ kind: "userChoice", enabled: true, content: "我自己写的" }] },
    "p7"
  ).entries.find((e) => e.kind === "userChoice");
  check("用户写的选项正文留着", kept.content, "我自己写的");
  check("用户开着的选项条目留着", kept.enabled, true);
}

console.log("\n=== 2. resolvePreset 只在同一批里挑 ===");
{
  check("线上挑线上那份", P.resolvePreset(config, role, "online").id, "ps-online");
  check("线下挑线下那份", P.resolvePreset(config, role, "offline").id, "ps-offline");
  // 默认参数不能变 —— 所有老调用点都没传 mode
  check("不传 mode 等于线上", P.resolvePreset(config, role).id, "ps-online");

  // 一份线下预设都没有时要兜底，不能返回 null（那会让整条链崩在解引用上）
  const bare = { ...config, presets: [{ id: "ps-online", name: "线上预设", mode: "online" }] };
  const fb = P.resolvePreset(bare, role, "offline");
  check("没有线下预设就兜底", fb.mode, "offline");
  checkThat("兜底那份带用户选项条目", fb.entries.some((e) => e.kind === "userChoice"), "");
  check("兜底那份的用户选项也是关的", fb.entries.find((e) => e.kind === "userChoice").enabled, false);
  // 引用指向线上那份 id 时不能串批
  const cross = { ...role, offline: { ...role.offline, presetRef: "ps-online" } };
  check("引用串到线上也不认", P.resolvePreset(config, cross, "offline").id, "ps-offline");

  // 前端那份镜像必须同意（labels.js:resolvePreset）—— 两边分叉的话界面显示的
  // 预设名和真正发出去的那份不是一个
  const labels = fs.readFileSync(path.join(ROOT, "client/src/labels.js"), "utf8");
  checkThat("前端镜像也按 mode 筛", /presetsFor\(config, want\)|PRESET_MODES/.test(labels), "");
  checkThat("前端也有 OFFLINE_ONLY_KINDS", /OFFLINE_ONLY_KINDS/.test(labels), "");
}

console.log("\n=== 3. 线下的提示词 ===");
{
  const online = await buildPrompt(config, role, user, []);
  const offline = await buildPrompt(config, role, user, [], "", { mode: "offline" });
  const textOf = (b) => b.messages.map((m) => m.content).join("\n");

  check("线下用的是线下预设", offline.preset.id, "ps-offline");
  check("线上还是线上预设", online.preset.id, "ps-online");

  /*
   * 这一条是整个文件最要紧的断言。用户点名「线下模式开启后会自动关闭掉
   * 消息格式与功能」，而上面那份线下预设里 format 是**开着**的 ——
   * 靠开关挡不住，必须是代码里无条件跳过。
   */
  const off = textOf(offline);
  checkThat("线下不带「消息格式与功能」", !/消息格式与功能/.test(off), off.slice(0, 400));
  checkThat("线下不带气泡分隔说明", !/audio_message|separator/.test(off), "");
  checkThat("线上带着「消息格式与功能」", /消息格式与功能/.test(textOf(online)), "");

  // 世界书走 role.offline.worldBookRefs：global 的照旧生效，线上那本不进来
  checkThat("线下带上了线下专用书", /线下专用设定/.test(off), "");
  checkThat("线下不带线上专用书", !/线上专用设定/.test(off), "");
  checkThat("线下也带 global 那本", /两个月亮/.test(off), "");
  const on = textOf(online);
  checkThat("线上带上了线上专用书", /线上专用设定/.test(on), "");
  checkThat("线上不带线下专用书", !/线下专用设定/.test(on), "");

  // 人设和用户人设两边都要有 —— 跳的只该是 format 那一条
  checkThat("线下带角色人设", /你是 Jack/.test(off), "");
  checkThat("线下带用户人设", /我是阿元/.test(off), "");

  // 用户选项：关着的时候一个字都不该出现
  checkThat("选项条目关着就不出现", !/用户选项|接下来/.test(off), "");

  const openChoice = {
    ...config,
    presets: config.presets.map((p) =>
      p.id === "ps-offline"
        ? { ...p, entries: p.entries.map((e) => (e.kind === "userChoice" ? { ...e, enabled: true } : e)) }
        : p
    ),
  };
  const withChoice = await buildPrompt(openChoice, role, user, [], "", { mode: "offline" });
  const wc = textOf(withChoice);
  checkThat("选项条目开着就出现", /选项/.test(wc), wc.slice(-400));
  // 位置要在最后：模型最容易照做的是最后一条指令
  const last = withChoice.messages[withChoice.messages.length - 1].content;
  checkThat("选项那段拼在末尾", /选项/.test(last), last.slice(0, 200));
  checkThat("开了选项也照样不带 format", !/消息格式与功能/.test(wc), "");

  // 上文照旧进去（context 条目开着）
  const hist = await buildPrompt(config, role, user, [
    { role: "user", content: "我推开门。" },
    { role: "assistant", content: "屋里没人。" },
  ], "", { mode: "offline" });
  const ht = textOf(hist);
  checkThat("上文进了提示词", /我推开门/.test(ht) && /屋里没人/.test(ht), "");
}

console.log("\n=== 4. splitChoices ===");
{
  // 标记包着的那种（预设里教模型这么写）
  const a = O.splitChoices("他抬起头看你。\n<选项>\n1. 走过去\n2. 转身离开\n3. 假装没看见\n4. 开口叫他\n</选项>");
  check("标记式摘到四条", a.options.length, 4);
  check("标记式第一条", a.options[0], "走过去");
  check("标记式第四条", a.options[3], "开口叫他");
  checkThat("正文里不留标记", !/选项|1\./.test(a.body), a.body);
  check("正文留住了", a.body, "他抬起头看你。");

  // 编号式（模型经常不听话，不写标记直接列）
  const b = O.splitChoices("雨还在下。\n\n1. 撑伞出门\n2. 再等一会\n3. 打个电话");
  check("编号式摘到三条", b.options.length, 3);
  check("编号式正文", b.body, "雨还在下。");
  check("编号式第一条", b.options[0], "撑伞出门");

  // 短横线式
  const c = O.splitChoices("她笑了。\n\n- 回她一个笑\n- 什么都不说");
  check("短横线摘到两条", c.options.length, 2);
  check("短横线正文", c.body, "她笑了。");

  // 没有选项：整段都是正文，不能吞掉任何一个字
  const d = O.splitChoices("他什么也没说，只是把伞递了过来。");
  check("没选项时 options 空", d.options, []);
  check("没选项时正文完整", d.body, "他什么也没说，只是把伞递了过来。");

  // 只有一条的不算选项块 —— 正文最后一行以「-」开头太常见
  const e = O.splitChoices("桌上摆着三样东西。\n\n- 一把钥匙");
  check("只有一条不算选项", e.options, []);
  checkThat("那一行留在正文里", /一把钥匙/.test(e.body), e.body);

  // 不能把整段回复都当成选项（正文空了等于这轮白跑）
  const f = O.splitChoices("1. 往左\n2. 往右");
  check("整段都是编号时不当选项", f.options, []);
  checkThat("整段编号留在正文", /往左/.test(f.body), f.body);

  // 超过四条只留四条（用户点名固定四条）
  const g = O.splitChoices("走廊很长。\n\n1. 一\n2. 二\n3. 三\n4. 四\n5. 五");
  check("最多四条", g.options.length, S.CHOICE_COUNT);

  // 空输入不能炸
  check("空字符串", O.splitChoices("").options, []);
  check("undefined", O.splitChoices(undefined).body, "");
}

console.log("\n=== 5. 存档层（offlinestore） ===");
{
  check("一开始是关的", S.isOfflineOn(KEY), false);
  check("没开的时候没有当前剧情", S.currentStory(KEY), null);

  // 开线下：没有在演的剧情就顺手起一条，网页上点一下就能开始演
  S.openOffline(KEY, { roleId: role.id, presetRef: "ps-offline" });
  check("开了", S.isOfflineOn(KEY), true);
  const st = S.currentStory(KEY);
  checkThat("顺手起了一条剧情", Boolean(st), "");
  check("剧情记着 roleId", st.roleId, role.id);
  check("剧情记着预设", st.presetRef, "ps-offline");
  checkThat("剧情有名字", st.name.trim().length > 0, st.name);

  // 关闭 = 只把 open 落成 false，剧情**不许删**
  S.closeOffline(KEY);
  check("关了", S.isOfflineOn(KEY), false);
  checkThat("关了之后剧情还在", Boolean(S.readStory(st.id)), "");
  check("关了之后 currentId 还指着它", S.readIndex(KEY).currentId, st.id);

  S.openOffline(KEY, { roleId: role.id, presetRef: "ps-offline" });
  check("再开一次不新起剧情", S.currentStory(KEY).id, st.id);

  // 增
  const t1 = S.appendTurn(KEY, { role: "user", content: "我推开门。" });
  const t2 = S.appendTurn(KEY, { role: "assistant", content: "屋里没人。", options: ["走进去", "退出来"] });
  check("两轮都进去了", S.readStory(st.id).turns.length, 2);
  check("用户那轮的角色", t1.role, "user");
  check("助手那轮带选项", t2.options.length, 2);
  checkThat("每轮有时间戳", Boolean(t1.ts) && Boolean(t2.ts), "");
  // 侧栏靠索引里这个冗余字段显示轮数，不该等到读正文才知道
  check("索引里的轮数跟上了", S.readIndex(KEY).stories.find((s) => s.id === st.id).turnCount, 2);

  // 改
  checkThat("改正文成了", Boolean(S.updateTurn(KEY, st.id, t1.id, { content: "我踹开门。" })), "");
  check("正文改掉了", S.readStory(st.id).turns[0].content, "我踹开门。");
  checkThat("切隐藏成了", Boolean(S.updateTurn(KEY, st.id, t1.id, { hidden: true })), "");
  check("隐藏标记落盘了", S.readStory(st.id).turns[0].hidden, true);
  check("隐藏不动正文", S.readStory(st.id).turns[0].content, "我踹开门。");
  S.updateTurn(KEY, st.id, t1.id, { hidden: false });
  check("能取消隐藏", S.readStory(st.id).turns[0].hidden, false);

  /*
   * 不存在的 id 必须返回假值。返回真的话路由里那句 404 是死代码，
   * 界面会显示「改好了」而硬盘上什么都没变。
   */
  check("改不存在的轮次返回 null", S.updateTurn(KEY, st.id, "t-nope", { content: "x" }), null);
  check("删不存在的轮次返回 null", S.removeTurn(KEY, st.id, "t-nope"), null);
  check("改不存在的总结返回 null", S.updateSummary(st.id, "s-nope", "x"), null);
  check("删不存在的总结返回 null", S.removeSummary(st.id, "s-nope"), null);
  check("读不存在的剧情返回 null", S.readStory("st-nope"), null);

  /*
   * 重 roll 用的：砍末尾**连着的**助手轮次，用户那句留着。
   *
   * 返回的是砍掉的**条数**，不是被砍的那条 —— 因为末尾可能连着好几条助手
   * 轮次（手动加过、或者以后一轮存成多条），得一次全砍掉，不然重 roll 出来
   * 的新回复会跟在旧回复后面。`offline.js:336` 那句日志打的就是这个数。
   */
  const t2b = S.appendTurn(KEY, { role: "assistant", content: "多出来的一条。" });
  check("末尾连着两条助手", S.readStory(st.id).turns.length, 3);
  check("砍掉的条数", S.dropLastAssistant(KEY, st.id), 2);
  check("只剩用户那条", S.readStory(st.id).turns.length, 1);
  check("剩下那条是用户的", S.readStory(st.id).turns[0].role, "user");
  checkThat(
    "两条助手轮次都没了",
    !S.readStory(st.id).turns.some((t) => t.id === t2.id || t.id === t2b.id),
    "",
  );
  // 末尾不是助手轮次时不能乱砍 —— 一条都没砍就是 0
  check("末尾不是助手就不砍", S.dropLastAssistant(KEY, st.id), 0);
  check("确实没少", S.readStory(st.id).turns.length, 1);

  // 删
  const t3 = S.appendTurn(KEY, { role: "assistant", content: "要删的。" });
  checkThat("删成了", Boolean(S.removeTurn(KEY, st.id, t3.id)), "");
  check("删掉了", S.readStory(st.id).turns.length, 1);

  // 正文超长要截断，不能让一条把文件撑爆
  const huge = S.appendTurn(KEY, { role: "user", content: "字".repeat(S.MAX_TURN_CHARS + 500) });
  check("超长正文被截到上限", huge.content.length, S.MAX_TURN_CHARS);
  S.removeTurn(KEY, st.id, huge.id);

  // 多条剧情：新起一条不动老那条
  const st2 = S.newStory(KEY, { roleId: role.id, presetRef: "ps-offline", name: "第二段" });
  check("当前切到新那条", S.readIndex(KEY).currentId, st2.id);
  check("新剧情用了给的名字", st2.name, "第二段");
  check("索引里两条", S.readIndex(KEY).stories.length, 2);
  check("老那条一轮没少", S.readStory(st.id).turns.length, 1);
  checkThat("能切回去", Boolean(S.setCurrent(KEY, st.id)), "");
  check("切回来了", S.readIndex(KEY).currentId, st.id);

  // 改名只动名字
  S.renameStory(KEY, st.id, "雨夜的便利店");
  check("正文里的名字改了", S.readStory(st.id).name, "雨夜的便利店");
  check("索引里的名字也改了", S.readIndex(KEY).stories.find((s) => s.id === st.id).name, "雨夜的便利店");
  check("改名不动轮次", S.readStory(st.id).turns.length, 1);

  // listAll 给侧栏用：只读索引
  const all = S.listAll();
  checkThat("listAll 报到了这个角色", all.some((r) => r.roleKey === KEY), JSON.stringify(all));

  // 删剧情：正文和索引一起走
  checkThat("删剧情成了", Boolean(S.removeStory(KEY, st2.id)), "");
  check("索引里只剩一条", S.readIndex(KEY).stories.length, 1);
  check("正文文件也没了", S.readStory(st2.id), null);

  /*
   * 头像文件名白名单：挡路径穿越和「让它读 data.config.json」。
   * 不给过时返回 null（不是空串）—— 路由里靠 `if (!file) return 400` 挡住，
   * 两个假值都拦得住，但断言得照实写，写成 "" 会一直红着。
   */
  check("穿越路径不给过", S.mediaPathFor("../../data.config.json"), null);
  check("带斜杠不给过", S.mediaPathFor("a/b.png"), null);
  check("带反斜杠不给过", S.mediaPathFor("a\\b.png"), null);
  check("空文件名不给过", S.mediaPathFor(""), null);
  check("undefined 不给过", S.mediaPathFor(undefined), null);
  checkThat("正常文件名给过", S.mediaPathFor("av-1.png").endsWith("av-1.png"), "");
}

console.log("\n=== 6. 损坏的剧情文件只 warn，不删不改名 ===");
{
  /*
   * 用户原话（写在 memorystore.js 头上、offlinestore.js 沿用）：生成失败绝不删记录。
   * 剧情同理 —— 这是他一轮一轮攒出来的东西，读不出来也得留在原地让他自己救。
   */
  const idx = S.readIndex(KEY);
  const bad = path.join(TMP, "offline", "stories", `${idx.currentId}.json`);
  const good = fs.readFileSync(bad, "utf8");
  fs.writeFileSync(bad, "{ 这不是 JSON");

  check("读不出来返回 null", S.readStory(idx.currentId), null);
  checkThat("文件还在原地", fs.existsSync(bad), "");
  check("内容一个字节都没动", fs.readFileSync(bad, "utf8"), "{ 这不是 JSON");
  const strays = fs
    .readdirSync(path.join(TMP, "offline", "stories"))
    .filter((f) => !f.endsWith(".json"));
  check("没有被改名成 .bad / .broken 之类", strays, []);

  fs.writeFileSync(bad, good);
  checkThat("修回去就能读了", Boolean(S.readStory(idx.currentId)), "");
}

console.log("\n=== 7. 总结与结束线下 ===");
{
  const idx = S.readIndex(KEY);
  const storyId = idx.currentId;

  // 手写总结（网页上那个「自己写一份」，不打模型）
  const s1 = S.appendSummary(storyId, { kind: "small", text: "他们在便利店碰上了。", from: 0, to: 2 });
  checkThat("总结存下来了", Boolean(s1), "");
  check("总结的类型", s1.kind, "small");
  check("剧情里挂着一份", S.readStory(storyId).summaries.length, 1);
  checkThat("能自由编辑", Boolean(S.updateSummary(storyId, s1.id, "改过的总结。")), "");
  check("改掉了", S.readStory(storyId).summaries[0].text, "改过的总结。");
  // kind/from/to 是「概括了哪一段」的事实，编辑不该动它
  check("编辑不动 kind", S.readStory(storyId).summaries[0].kind, "small");
  check("编辑不动 from", S.readStory(storyId).summaries[0].from, 0);
  const s2 = S.appendSummary(storyId, { kind: "big", text: "整段的大总结。", from: 0, to: 2 });
  check("两份了", S.readStory(storyId).summaries.length, 2);

  /*
   * 结束线下。这一步不打网络也能验大部分：没配到能用的 endpoint 时
   * makeSummary 会抛，endOffline 把它吞成 error 并**照样结束** ——
   * 卡在这儿不放人是最糟的结果。已经有的那两份总结照旧注入。
   */
  const out = await O.endOffline(config, role, { inject: true });
  check("结束了", out.ok, true);
  check("线下关掉了", S.isOfflineOn(KEY), false);
  check("注入了两份", out.injected, 2);
  checkThat("剧情盖上了结束时间", Boolean(S.readStory(storyId).endedAt), "");
  checkThat("剧情本身没被删", Boolean(S.readStory(storyId)), "");
  check("索引里那条也还在", S.readIndex(KEY).stories.length, 1);

  // 待总结那个文件：只该有总结，不该有原始轮次
  const pending = path.join(TMP, "memories", "待总结", "记忆", `${KEY}.txt`);
  checkThat("待总结文件出来了", fs.existsSync(pending), pending);
  const txt = fs.readFileSync(pending, "utf8");
  checkThat("行首是 [线下剧情]", /\| \[线下剧情\]/.test(txt), txt.slice(0, 200));
  checkThat("写进了小总结", /改过的总结/.test(txt), "");
  checkThat("写进了大总结", /整段的大总结/.test(txt), "");
  // 用户点名的：只注入小/大总结的内容
  checkThat("没写原始轮次", !/我踹开门/.test(txt), txt.slice(0, 400));
  checkThat("没写角色名当发送人", !/\| \[Jack\]/.test(txt), "");

  // 再结束一次不该把同一份总结写第二遍（用户完全可能关了又开、再关一次）
  const before = fs.readFileSync(pending, "utf8");
  S.openOffline(KEY, { roleId: role.id, presetRef: "ps-offline" });
  const again = await O.endOffline(config, role, { inject: true });
  check("第二次没有重复注入", again.injected, 0);
  check("待总结文件没变", fs.readFileSync(pending, "utf8"), before);

  // inject: false = 结束但不写记忆库（演废了一段不想让角色记住）
  S.openOffline(KEY, { roleId: role.id, presetRef: "ps-offline" });
  const sid2 = S.readIndex(KEY).currentId;
  S.appendSummary(sid2, { kind: "small", text: "这段不想让他记住。", from: 0, to: 1 });
  const noInject = await O.endOffline(config, role, { inject: false });
  check("不注入时 injected 是 0", noInject.injected, 0);
  checkThat("那句话没进待总结", !/不想让他记住/.test(fs.readFileSync(pending, "utf8")), "");
  check("照样关掉了", S.isOfflineOn(KEY), false);

  // 没有在演的剧情时结束也不能炸
  const idxNow = S.readIndex(KEY);
  S.writeIndex(KEY, { ...idxNow, open: true, currentId: "" });
  const empty = await O.endOffline(config, role, { inject: true });
  check("没有剧情也能结束", empty.ok, true);
  check("也关掉了", S.isOfflineOn(KEY), false);
  S.writeIndex(KEY, idxNow);
  void s2;

  /*
   * **开关要在收尾之前就按掉**（用户报的那个 bug）。
   *
   * 收尾要打两次模型（补一份小总结 + 出一份大总结），超时 10 分钟、被拒还重试
   * 三次。开关要是放在最后按，这几分钟里聊天框那道闸、主动消息、`/api/offline`
   * 全都还当线下开着 —— 而用户已经点过「结束线下」了，中间发的话全进剧情。
   *
   * 验法：**不 await**，趁 endOffline 还在里头打模型的时候就去问一次索引。
   * 单独起一条剧情，免得动到上面那几条对「重复注入」的断言。
   */
  const lateSid = S.newStory(KEY, { roleId: role.id, presetRef: "ps-offline", name: "关得够快吗" }).id;
  S.appendTurn(KEY, { role: "user", content: "最后一句。" });
  S.openOffline(KEY, { roleId: role.id, presetRef: "ps-offline" });
  check("先确认开着", S.isOfflineOn(KEY), true);
  const closing = O.endOffline(config, role, { inject: false });
  check("收尾还没跑完，开关就已经是关的", S.isOfflineOn(KEY), false);
  await closing;
  check("收尾跑完还是关的", S.isOfflineOn(KEY), false);

  /*
   * 关掉之后不许再生成。
   *
   * `closeOffline` 故意留着 `currentId`（关了再开要接着演同一条），所以
   * runOfflineTurn 光判「有没有在演的剧情」是不够的 —— iMessage 那头排在
   * `chain` 里的那几轮会绕过入口那道闸，照样按线下预设生成、照样发四条选项。
   *
   * 这里不打网络也能验：这道闸在挑 endpoint 之前，抛的是它自己那句。
   */
  let closedErr = null;
  try {
    await O.runOfflineTurn(config, role, user, { text: "关了之后还能演吗", storyId: lateSid });
  } catch (e) {
    closedErr = e;
  }
  checkThat("关掉之后这一轮直接被挡下", Boolean(closedErr?.offlineClosed), String(closedErr?.message ?? closedErr));
  // 挡下就不该落盘 —— 落了的话用户下次开线下会看到一句没人接的话
  checkThat(
    "那句话没进剧情",
    !S.readStory(lateSid).turns.some((t) => t.content.includes("关了之后还能演吗")),
    ""
  );
}

console.log("\n=== 8. 总结的触发点 ===");
{
  // 不打网络，所以只验「够没够」这个判断：轮数没到时 maybeSummarize
  // 一次接口都不该打（打了会抛，这里就报错了）
  S.openOffline(KEY, { roleId: role.id, presetRef: "ps-offline" });
  const sid = S.newStory(KEY, { roleId: role.id, presetRef: "ps-offline", name: "数轮数" }).id;
  for (let i = 0; i < 5; i += 1) {
    S.appendTurn(KEY, { role: "user", content: `第 ${i + 1} 句。` });
    S.appendTurn(KEY, { role: "assistant", content: `回第 ${i + 1} 句。` });
  }
  check("先攒了五轮", S.readStory(sid).turns.filter((t) => t.role === "assistant").length, 5);
  const five = await O.maybeSummarize(config, role, sid);
  check("五轮还不出总结", five, null);
  check("确实一份都没有", S.readStory(sid).summaries.length, 0);

  // 第六轮到点：这次会真去打接口，没配到 key 会抛 —— 抛出来就说明判断生效了
  S.appendTurn(KEY, { role: "user", content: "第 6 句。" });
  S.appendTurn(KEY, { role: "assistant", content: "回第 6 句。" });
  let threw = "";
  try {
    await O.maybeSummarize(config, role, sid);
  } catch (e) {
    threw = String(e?.message ?? e);
  }
  checkThat("第六轮试着出小总结了", threw.length > 0, "（没有抛，说明它没去生成）");
  checkThat("抛的是配置/网络的错", !/undefined|not a function|Cannot read/.test(threw), threw);

  // 阈值可调
  const slow = { ...role, offline: { ...role.offline, smallEvery: 200 } };
  check("阈值调大就不出", await O.maybeSummarize(config, slow, sid), null);

  // 大总结那个开关默认关，关着的时候不看小总结攒了多少
  for (let i = 0; i < 9; i += 1) {
    S.appendSummary(sid, { kind: "small", text: `第 ${i + 1} 份小总结。`, from: 0, to: 1 });
  }
  const noBig = { ...role, offline: { ...role.offline, smallEvery: 200, bigEnabled: false } };
  check("大总结关着就不出", await O.maybeSummarize(config, noBig, sid), null);
  check("小总结没被动过", S.readStory(sid).summaries.length, 9);

  // 开了之后攒够八份就该去出一份（同样以「抛了」为准）
  const bigOn = { ...role, offline: { ...role.offline, smallEvery: 200, bigEnabled: true, bigEvery: 8 } };
  let threwBig = "";
  try {
    await O.maybeSummarize(config, bigOn, sid);
  } catch (e) {
    threwBig = String(e?.message ?? e);
  }
  checkThat("攒够八份试着出大总结了", threwBig.length > 0, "（没有抛，说明它没去生成）");

  const bigLater = { ...role, offline: { ...role.offline, smallEvery: 200, bigEnabled: true, bigEvery: 50 } };
  check("阈值调大就不出大总结", await O.maybeSummarize(config, bigLater, sid), null);

  S.closeOffline(KEY);
}

console.log("\n=== 9. storyForView：显示那份和存档那份分开 ===");
{
  const withRegex = {
    ...config,
    presets: config.presets.map((p) =>
      p.id === "ps-offline"
        ? {
            ...p,
            regex: [
              {
                id: "r1",
                name: "渲染状态栏",
                enabled: true,
                find: "\\[状态\\]",
                flags: "g",
                replace: "<div class='bar'>状态</div>",
                targets: ["aiOutput"],
                toUser: true,
                toHistory: false,
              },
            ],
          }
        : p
    ),
  };
  const story = {
    id: "st-view",
    roleId: role.id,
    name: "看一眼",
    presetRef: "ps-offline",
    turns: [
      { id: "a", role: "user", content: "[状态] 我说话。", options: [], hidden: false, ts: "" },
      { id: "b", role: "assistant", content: "[状态] 他回答。", options: [], hidden: false, ts: "" },
    ],
    summaries: [],
  };
  const view = O.storyForView(withRegex, role, story);

  // 助手那侧：display 过了 toUser，content 还是存档那份
  check("助手的 display 渲染了", view.story.turns[1].display, "<div class='bar'>状态</div> 他回答。");
  check("助手的 content 没动", view.story.turns[1].content, "[状态] 他回答。");
  // 用户那侧：aiOutput 规则跟他打的字没关系
  check("用户那侧不套 aiOutput 规则", view.story.turns[0].display, "[状态] 我说话。");
  check("presetName 报出来了", view.presetName, "线下预设");

  // choices 是两道闸的结果，前端直接用，不自己再推一遍
  check("两道闸都关：false", view.choices, false);
  const roleOn = { ...role, offline: { ...role.offline, userChoice: true } };
  check("只开角色那道：还是 false", O.storyForView(withRegex, roleOn, story).choices, false);
  const bothOn = {
    ...withRegex,
    presets: withRegex.presets.map((p) =>
      p.id === "ps-offline"
        ? { ...p, entries: p.entries.map((e) => (e.kind === "userChoice" ? { ...e, enabled: true } : e)) }
        : p
    ),
  };
  check("只开预设那道：还是 false", O.storyForView(bothOn, role, story).choices, false);
  check("两道都开：true", O.storyForView(bothOn, roleOn, story).choices, true);
}

console.log("\n=== 9b. 线下自己那份上下文上限 ===");
{
  /*
   * 造一条剧情：N 轮，每轮「用户一句 + 角色一句」，所以第 k 轮占下标
   * 2k 和 2k+1。总结的 from/to 是**轮次下标**（含头不含尾），所以「盖住前 3 轮」
   * 就是 {from: 0, to: 6}。
   */
  const mkStory = (rounds, summaries = []) => ({
    id: "st-cut",
    roleId: role.id,
    name: "长剧情",
    presetRef: "ps-offline",
    turns: Array.from({ length: rounds * 2 }, (_, i) => ({
      id: `t${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: i % 2 === 0 ? `我第 ${Math.floor(i / 2) + 1} 句` : `他第 ${Math.floor(i / 2) + 1} 句`,
      options: [],
      hidden: false,
      ts: "",
    })),
    summaries: summaries.map((s, i) => ({ id: `s${i}`, ts: `2026-01-0${i + 1}`, ...s })),
  });
  const withLimit = (n) => ({ ...role, offline: { ...role.offline, maxContext: n } });
  const small = (from, to, text) => ({ kind: "small", from, to, text });
  const big = (from, to, text) => ({ kind: "big", from, to, text });

  // 没到上限 → 一轮都不折
  check("没超上限：不折", O.offlineCut(mkStory(4, [small(0, 6, "前三轮")]), withLimit(6)).at, 0);

  /*
   * 这一条是整节最要紧的：一份总结都没出的时候**绝不折**。
   * 折了就等于把还没被总结过的剧情直接扔掉，剧情凭空消失。
   */
  check("超了但没总结：不折", O.offlineCut(mkStory(20, []), withLimit(6)).at, 0);

  /*
   * 14 轮、上限 6，总结盖到第 6 轮（轮次下标 12）→ 切在那儿，留 8 轮原文。
   *
   * 这里刻意用 14 而不是 10：10 轮的话切了只剩 4 轮原文，比上限还少，按
   * 「至少留够 limit 轮」的规则就**不该折**（下面 s10 那条验的正是这个）。
   */
  const s14 = mkStory(14, [small(0, 12, "前六轮发生了")]);
  const cut14 = O.offlineCut(s14, withLimit(6));
  check("切在总结边界上", cut14.at, 12);
  check("顶上那段是总结正文", cut14.text, "前六轮发生了");

  // 切了会让原文少于上限 → 宁可这一轮多发，也不折
  const s10 = mkStory(10, [small(0, 12, "前六轮发生了")]);
  check("折了会低于上限：不折", O.offlineCut(s10, withLimit(6)).at, 0);

  /*
   * 切点只落在边界上：总结只盖到第 2 轮，上限 6、实际有 10 轮 ——
   * 最多能切到第 4 轮，但边界只有第 2 轮，就切第 2 轮。
   * 于是发出去的原文是 8 轮（比上限多），这是刻意的：宁可多发，
   * 也不让哪几轮既没进总结又被丢掉。
   */
  const s10b = mkStory(10, [small(0, 4, "前两轮")]);
  check("边界比上限保守：切在边界", O.offlineCut(s10b, withLimit(6)).at, 4);

  // 总结伸过了「至少要留的那截」→ 不能用它，退回不折
  const s8 = mkStory(8, [small(0, 14, "盖到第七轮")]);
  check("总结伸太远：不折", O.offlineCut(s8, withLimit(6)).at, 0);

  // 0 = 不限制（老行为）
  check("0 就是不限制", O.offlineCut(s10, withLimit(0)).at, 0);

  /*
   * 「有小总结用小总结有大总结用大总结」：同一段两边都盖到时用大的（更省），
   * 大的没盖到的那截拿小的补。
   */
  const both = mkStory(14, [
    small(0, 4, "小一"),
    small(4, 8, "小二"),
    big(0, 8, "大的盖了前四轮"),
    small(8, 12, "小三"),
  ]);
  const cutBoth = O.offlineCut(both, withLimit(6));
  check("大小都有：切到最远那份", cutBoth.at, 12);
  check("大的优先，剩下的用小的", cutBoth.text, "大的盖了前四轮\n\n小三");
  checkThat("被大的盖住的小总结不重复进去", !cutBoth.text.includes("小一"), cutBoth.text);

  // 中间断了一截（用户手删过总结）→ 停在断口，后半段照旧发原文
  const gap = mkStory(20, [small(0, 4, "小一"), small(8, 12, "小三")]);
  const cutGap = O.offlineCut(gap, withLimit(6));
  check("总结中间断了：停在断口", cutGap.at, 4);
  check("断口之后那份不进来", cutGap.text, "小一");

  // 空正文的总结不算边界 —— 拿它当切点等于那几轮什么都没留下
  const blank = mkStory(10, [small(0, 12, "   ")]);
  check("空总结不算边界", O.offlineCut(blank, withLimit(6)).at, 0);

  // 隐藏的轮次不参与计数：它本来就不进上下文，算上它等于偷偷把上限调小
  const hidden = mkStory(10, [small(0, 12, "前六轮")]);
  for (const t of hidden.turns.slice(12)) t.hidden = true;
  check("隐藏的不算进上限", O.offlineCut(hidden, withLimit(6)).at, 0);

  // storyForView 把切点报给前端，条数和轮数两个都在
  const view = O.storyForView(config, withLimit(6), s14);
  check("view 报了折叠条数", view.folded.count, 12);
  check("view 报了折叠轮数", view.folded.rounds, 6);
  check("view 带了总结正文", view.folded.text, "前六轮发生了");
  check("没折的时候是 0", O.storyForView(config, withLimit(0), s14).folded.count, 0);

  /*
   * 真正发给模型的那份：折掉的那几轮不在，顶上多一条 <剧情前情>。
   * 这条要走 buildPrompt —— historyOf 是私有的，从提示词正文里验才算数。
   */
  const textOf = (b) => b.messages.map((m) => m.content).join("\n");
  S.setCurrent(KEY, "");
  const built = await buildPrompt(
    config,
    withLimit(6),
    user,
    // 直接模拟 historyOf 的产物：前六轮换成总结
    [
      { role: "system", content: "<剧情前情>\n前六轮发生了\n</剧情前情>" },
      ...s14.turns.slice(12).map((t) => ({ role: t.role, content: t.content })),
    ],
    "",
    { mode: "offline" }
  );
  const bt = textOf(built);
  checkThat("提示词里有剧情前情", /<剧情前情>/.test(bt), bt.slice(0, 200));
  checkThat("折掉那几轮的原文不在", !/我第 1 句/.test(bt), "");
  checkThat("留下那几轮的原文在", /我第 7 句/.test(bt) && /他第 14 句/.test(bt), "");

  /*
   * 线上那对 maxContext / dropCount 不能再砍线下这份。
   * 它砍的是数组头几条，第一个被砍掉的正好是 <剧情前情> —— 那样剧情既没原文
   * 也没总结，是这次改动里最容易悄悄回归的一处。
   */
  const tight = { ...withLimit(6), maxContext: 2, dropCount: 1 };
  const kept = await buildPrompt(
    config,
    tight,
    user,
    [
      { role: "system", content: "<剧情前情>\n前六轮发生了\n</剧情前情>" },
      ...s14.turns.slice(12).map((t) => ({ role: t.role, content: t.content })),
    ],
    "",
    { mode: "offline" }
  );
  const kt = textOf(kept);
  checkThat("线上上限砍不动线下", /<剧情前情>/.test(kt) && /我第 7 句/.test(kt), kt.slice(0, 300));
  // 反过来，线上那条链照旧受它管 —— 这是老行为，不能被顺手改掉
  const on = await buildPrompt(
    config,
    tight,
    user,
    [
      { role: "user", content: "最旧那条" },
      { role: "assistant", content: "中间那条" },
      { role: "user", content: "最新那条" },
    ]
  );
  const ot = textOf(on);
  checkThat("线上还是被 maxContext 管着", !/最旧那条/.test(ot) && /最新那条/.test(ot), ot.slice(0, 300));

  /*
   * 配置层。角色文件里压根没写这个字段（见 ROLE_RAW），所以这一条同时验了
   * 「老配置升级上来是默认 6 轮」—— 不是 undefined、也不是 0。
   */
  check("老配置回落到 6 轮", role.offline.maxContext, 6);
  // 0 要放得过去（用户明确要「不限制」），垃圾值和负数不能把它当成上限 1
  check("0 放得过去", O.offlineCut(s10, withLimit(0)).at, 0);
  check("负数当不限制处理", O.offlineCut(s10, withLimit(-5)).at, 0);
  check("垃圾值当不限制处理", O.offlineCut(s10, withLimit("六")).at, 0);
}

console.log("\n=== 10. 四条快捷指令 ===");
{
  const ctx = { config, role, projectRefId: "proj-1", spaceId: "sp-1" };
  const marker = (text) => C.tryCommand(text, ctx)?.offline ?? null;

  check("/开启线下", marker("/开启线下"), { action: "on" });
  check("/关闭线下", marker("/关闭线下"), { action: "off" });
  check("/小总结", marker("/小总结"), { action: "sumsmall" });
  check("/大总结", marker("/大总结"), { action: "sumbig" });
  check("英文名 offlineon", marker("/offlineon"), { action: "on" });
  check("英文名 offlineoff", marker("/offlineoff"), { action: "off" });
  check("英文名 sumsmall", marker("/sumsmall"), { action: "sumsmall" });
  check("英文名 sumbig", marker("/sumbig"), { action: "sumbig" });

  // 中文输入法打出来的全角斜杠也得认
  check("全角斜杠", marker("／开启线下"), { action: "on" });
  check("iOS 自动大写", marker("/OfflineOn"), { action: "on" });
  checkThat("前后空格不影响", marker("  /关闭线下  ") !== null, "");

  /*
   * 四个都是**独立的词**，不共用前缀。踩过的坑写在 commands.js 里：
   * 「短词 + 参数」的写法会掉进空白分支把参数丢掉。所以这里反过来验
   * 一条不该被另一条吃掉。
   */
  check("开启不会被关闭吃掉", marker("/开启线下").action, "on");
  check("关闭不会被开启吃掉", marker("/关闭线下").action, "off");
  check("小总结不会被大总结吃掉", marker("/小总结").action, "sumsmall");

  // 后面跟着话的不算指令 —— 那是正常聊天（`/del 顺便说一下` 那条规矩）
  check("后面跟着话就不是指令", C.tryCommand("/开启线下 然后我们去便利店", ctx), null);
  check("打错的不是指令", C.tryCommand("/开启线下线", ctx), null);
  check("不相干的斜杠不是指令", C.tryCommand("/Users/me/a.jpg", ctx), null);

  // 角色那边的总开关关着时，/开启线下 要拒绝并说清去哪儿开
  const gated = { ...ctx, role: { ...role, offline: { ...role.offline, enabled: false } } };
  const refused = C.tryCommand("/开启线下", gated);
  check("总开关关着就没有 marker", refused?.offline ?? null, null);
  // 要回的那句话在 `text` 上（`tryCommand` 全文统一的字段名，不是 reply）
  checkThat("拒绝时有话说", (refused?.text ?? "").length > 0, JSON.stringify(refused));
  checkThat("拒绝时指了路", /线下模式/.test(refused?.text ?? ""), refused?.text ?? "");
  checkThat("拒绝时说了去哪开", /角色设置/.test(refused?.text ?? ""), refused?.text ?? "");

  /*
   * `/关闭线下` 必须排在**角色检查之前**（照 `/提示词协助模式关闭`）：
   * 角色解绑之后还得能把人从线下模式里捞出来，否则线上功能永远回不来。
   */
  const noRole = { config, role: null, projectRefId: "proj-1", spaceId: "sp-1" };
  check("没绑角色也能关线下", C.tryCommand("/关闭线下", noRole)?.offline ?? null, { action: "off" });
  // 开线下要角色（没角色演谁），小/大总结也要
  check("没绑角色开不了线下", C.tryCommand("/开启线下", noRole)?.offline ?? null, null);

  /*
   * 指令表两边的镜像：`/help` 那张表 ↔ client/src/commands-help.js。
   *
   * `buildHelp` 没导出（它只给 tryCommand 用），所以照 test-commands.mjs
   * 的做法走一遍 `/help` 把正文拿出来。
   */
  const help = C.tryCommand("/help", ctx)?.text ?? "";
  checkThat("/help 出得来", help.length > 0, "");
  for (const word of ["开启线下", "关闭线下", "小总结", "大总结"]) {
    checkThat(`/help 里有 /${word}`, help.includes(word), "");
  }
  const front = fs.readFileSync(path.join(ROOT, "client/src/commands-help.js"), "utf8");
  for (const word of ["开启线下", "关闭线下", "小总结", "大总结"]) {
    checkThat(`前端指令表里有 /${word}`, front.includes(word), "");
  }
  for (const word of ["offlineon", "offlineoff", "sumsmall", "sumbig"]) {
    checkThat(`前端词表里有 ${word}`, front.includes(word), "");
  }
}

console.log("\n=== 11. 只写自己那几个目录 ===");
{
  /*
   * 剧情走的是 data/offline/，**不经过配置**。碰了 config 就等于每演一轮
   * 重启一次所有 iMessage 桥接（`PUT /api/config` 的副作用，理由写在
   * datadir.js 头上）—— 所以这一节盯的是「配置那几个文件一个字节都没动」。
   *
   * 比的是**原文**而不是解析出来的对象：normalize 之后的形状本来就和写进去的
   * 不一样，比对象会一直红；比字节能抓住真正的问题（有人顺手 writeConfig 了）。
   */
  check("config.json 没被动过", fs.readFileSync(path.join(TMP, "config.json"), "utf8"), CONFIG_RAW);
  check(
    "角色文件没被动过",
    fs.readFileSync(path.join(TMP, "characters", "01-Jack.json"), "utf8"),
    ROLE_RAW,
  );
  checkThat(
    "没往 data.config.json 里写东西（密钥住在那儿）",
    !fs.existsSync(path.join(TMP, "data.config.json")),
    "",
  );

  /*
   * 目录清单不逐字比 —— `ensureLayout()` 一次 mkdir-p 一长串固定目录，
   * 钉死清单等于每加一个无关目录都要回来改这一行。要验的是两件事：
   * offline 那三个子目录在，且待总结确实被写到了 memories 底下。
   */
  const inner = fs.readdirSync(path.join(TMP, "offline")).sort();
  check("offline 下三个目录", inner, ["index", "media", "stories"]);
  checkThat("剧情正文落在 stories 底下", fs.readdirSync(path.join(TMP, "offline", "stories")).length > 0, "");
  checkThat("索引落在 index 底下", fs.readdirSync(path.join(TMP, "offline", "index")).length > 0, "");
  const pendingDir = path.join(TMP, "memories", "待总结", "记忆");
  checkThat("总结进的是 memories 那棵树", fs.existsSync(pendingDir), pendingDir);
}

console.log("\n=== 12. 线上聊天记录（线下预设独有） ===");
{
  /*
   * 线下这一侧**没有 linePhone**（offline.js / buildPrompt 拿不到 runner），
   * 算不出线上那个 sessionIdFor，所以注入靠反查 listSessions()。这一节验的就是
   * 那条反查链走得通：写一份线上存档 → 线下拼提示词 → 记录出现在 <线上聊天记录> 里。
   */
  const ss = await import("../server/src/sessions.js");
  const sid = ss.sessionIdFor(role.name, role.id, "+18005550100");
  ss.appendTurn(sid, { roleId: role.id, roleName: role.name, peer: "+8613800000000" }, [
    { role: "user", content: "在吗" },
    { role: "assistant", content: "<thinking>推演</thinking>在的" },
    { role: "user", content: "今天见面吧" },
    { role: "assistant", content: "好啊，几点" },
  ]);
  // 写入时只剥「已有的」助手消息 —— 最新那条留完整原文。再追加一轮，
  // 让带 <thinking> 的那条变成旧的，才能验到剥思维链这一步
  ss.appendTurn(sid, {}, [
    { role: "user", content: "先这样" },
    { role: "assistant", content: "嗯" },
  ]);

  const built = await buildPrompt(config, role, user, [], "", { mode: "offline" });
  const t = built.messages.map((m) => m.content).join("\n");

  checkThat("记录进了线下提示词", /<线上聊天记录>/.test(t), "");
  checkThat("带上了存档正文", /今天见面吧/.test(t), "");
  // 说话人标签必须是真名 —— 这段是拼完条目正文之后才塞进去的，
  // 里面写 {{char}} 会原样发给模型（正文的 fill 早跑完了）
  checkThat("说话人用真名", /Jack：/.test(t) && /阿元：/.test(t), "");
  checkThat("说话人里没有没替换掉的变量", !/\{\{(char|user)\}\}/.test(t), "");
  checkThat("导语在（已经见过面了）", /已经见过面/.test(t), "");
  // 存档里旧助手消息的思维链在写入时就被剥掉了，最新那条保留原文
  checkThat("旧消息的思维链没跟着进来", !/推演/.test(t), "");
  // <Chat_History> 是当轮上下文的标记，往事不能用它
  checkThat("不套 Chat_History", !/<Chat_History>/.test(t), "");

  // 没有线上存档时整条不产出 —— 连空标签都不留
  const none = await buildPrompt(config, { ...role, id: "role-没聊过" }, user, [], "", { mode: "offline" });
  const nt = none.messages.map((m) => m.content).join("\n");
  checkThat("没存档时不出现标签", !/<线上聊天记录>/.test(nt), "");
  checkThat("没存档时不漏占位符", !/\{\{线上聊天记录\}\}/.test(nt), "");
}

// 收尾：临时目录删掉
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
