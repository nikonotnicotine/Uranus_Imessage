/*
 * 记忆库的离线验证：文件层 + 检索算法 + 三条总结链 + 注入。
 *
 * 指向临时数据目录（URANUS_DATA_DIR），绝不碰用户真实的 data/ ——
 * 那里面有真的 API key、Photon 凭据和聊天记录。
 * 跑法：node scripts/test-memory.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "uranus-mem-"));
process.env.URANUS_DATA_DIR = TMP;
process.env.IMESSAGE_BRIDGE = "off";

const store = await import("../server/src/memorystore.js");
const { ensureLayout, MEMORY_DIR } = await import("../server/src/datadir.js");

let pass = 0;
let fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}\n      得到 ${JSON.stringify(got)}\n      期望 ${JSON.stringify(want)}`);
  }
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

ensureLayout();

console.log("\n=== 1. 目录布局 ===");
for (const sub of ["记忆", "备忘录", "日记", "待总结/记忆", "待总结/备忘录"]) {
  checkThat(`data/memories/${sub}/ 建出来了`, fs.existsSync(path.join(MEMORY_DIR, sub)));
}
checkThat("README.txt 建出来了", fs.existsSync(path.join(MEMORY_DIR, "README.txt")));

console.log("\n=== 2. memoryKeyFor：文件名安全 ===");
check("英文名直接用", store.memoryKeyFor({ id: "r-1", name: "Alex" }), "Alex");
check("中文名退到 role-<id>", store.memoryKeyFor({ id: "r-1", name: "小樱" }), "role-r-1");
check("空名字退到 role-<id>", store.memoryKeyFor({ id: "r-2", name: "" }), "role-r-2");
check("兜底保留 - 和 _（r-1 ≠ r1）", store.memoryKeyFor({ id: "r1", name: "" }), "role-r1");
checkThat(
  "路径穿越的名字算不出斜杠",
  !/[\\/]/.test(store.memoryKeyFor({ id: "../../etc", name: "../../etc/passwd" }))
);
check("混合名只留字母数字", store.memoryKeyFor({ id: "r-3", name: "Alex 酱 2号" }), "Alex2");

console.log("\n=== 3. 记忆的增删改查 ===");
const K = "Alex";
check("一开始是空的", store.readMemories(K), []);
const m1 = store.appendMemory(K, { content: "第一条", keywords: ["一"], embedding: [1, 0] });
const m2 = store.appendMemory(K, { content: "第二条", keywords: ["二"] });
check("追加了两条", store.readMemories(K).length, 2);
checkThat("没给向量的那条 embedding 是 null", store.readMemories(K)[1].embedding === null);
checkThat("date 是 YYYY-MM-DD", /^\d{4}-\d{2}-\d{2}$/.test(m1.date));
check("空正文不落盘", store.appendMemory(K, { content: "   " }), null);
store.updateMemory(K, m1.id, { content: "改过的第一条" });
check("改正文", store.readMemories(K)[0].content, "改过的第一条");
checkThat(
  "改了正文就把旧向量置空（不然向量对不上正文）",
  store.readMemories(K)[0].embedding === null
);
store.updateMemory(K, m2.id, { embedding: [0, 1] });
check("只补向量不改正文，正文不动", store.readMemories(K)[1].content, "第二条");
check("向量补上了", store.readMemories(K)[1].embedding, [0, 1]);
check("删一条", store.removeMemory(K, m1.id), true);
check("删完剩一条", store.readMemories(K).length, 1);
check("删不存在的返回 false", store.removeMemory(K, "no-such"), false);
checkThat(
  "非法 key 不落盘、也不抛",
  store.writeMemories("../evil", [{ id: "x" }]) === false
);

console.log("\n=== 4. 备忘录 ===");
check("一开始是空串", store.readMemo(K), "");
store.writeMemo(K, "1. 第一版");
check("写进去了", store.readMemo(K), "1. 第一版");
store.writeMemo(K, "1. 第二版");
check("覆盖", store.readMemo(K), "1. 第二版");
check(
  "覆盖前留了 .bak，里面是上一版",
  fs.readFileSync(path.join(MEMORY_DIR, "备忘录", "Alex.bak.md"), "utf-8"),
  "1. 第一版"
);

console.log("\n=== 5. 日记：流水 + 成品 ===");
store.appendDiaryLine(K, "2026-09-04 星期五 22:12:07 | [Alex] 我刚睡醒");
store.appendDiaryLine(K, "2026-09-04 星期五 22:12:30 | [用户] 早啊");
check("流水两行", store.readDiaryLog(K).trim().split(/\r?\n/).length, 2);
check("空行不写", store.appendDiaryLine(K, "   "), false);

check("第一篇叫 2026-09-09.md", store.writeDiary(K, "2026-09-09", "今天很好"), "2026-09-09.md");
check(
  "同一天再生成不覆盖，改叫 -2",
  store.writeDiary(K, "2026-09-09", "又写了一篇"),
  "2026-09-09-2.md"
);
check("列表两篇、新的在前", store.listDiaries(K).map((d) => d.file), [
  "2026-09-09-2.md",
  "2026-09-09.md",
]);
check("读得回来", store.readDiary(K, "2026-09-09.md"), "今天很好");
check("非法文件名读不到东西", store.readDiary(K, "../../config.json"), "");
check("非法文件名删不掉东西", store.removeDiary(K, "../../config.json"), false);

store.writeDiary(K, "2026-09-08", "昨天的");
store.writeDiary(K, "2026-08-01", "上个月的");
const now = new Date("2026-09-09T20:00:00");
check(
  "近 1 天 = 今天 + 昨天（日记通常是夜里生成的，只算今天会永远是空）",
  store.readRecentDiaries(K, 1, now).map((d) => d.file),
  ["2026-09-08.md", "2026-09-09.md", "2026-09-09-2.md"]
);
check("近 0 天什么都不注入", store.readRecentDiaries(K, 0, now), []);
checkThat(
  "近 60 天把上个月那篇也带上",
  store.readRecentDiaries(K, 60, now).some((d) => d.file === "2026-08-01.md")
);
check("正序：老的在前", store.readRecentDiaries(K, 60, now)[0].file, "2026-08-01.md");

console.log("\n=== 6. 待总结流水：记忆和备忘录各存各的 ===");
store.appendPending("memory", K, { user: "在吗", assistant: "在" });
store.appendPending("memo", K, { user: "在吗", assistant: "在" });
store.appendPending("memory", K, { user: "帮我记一下", assistant: "好" });
check("记忆攒了 4 行（2 轮 × 2）", store.readPending("memory", K).lines, 4);
check("记忆轮数是 2", store.readPending("memory", K).rounds, 2);
check("备忘录只有 2 行（互不影响）", store.readPending("memo", K).lines, 2);
check("两边都空的一轮不记", store.appendPending("memory", K, {}).lines, 4);
// 待总结和日记是同一种流水：一行一条「时间 | [发送人] 内容」
checkThat(
  "待总结用的是 diary_log 的行格式",
  store
    .readPending("memory", K)
    .text.split(/\r?\n/)
    .filter((l) => l.trim())
    .every((l) => /^\d{4}-\d{2}-\d{2} 星期. \d{2}:\d{2}:\d{2} \| \[[^\]]+\] /.test(l))
);
checkThat("发送人用的是传进来的真名", /\| \[对方\] 在吗/.test(store.readPending("memory", K).text));

check("2 轮 < 15，不触发", store.shouldSummarize(store.readPending("memory", K), 15), false);
check("2 轮 >= 2，触发", store.shouldSummarize(store.readPending("memory", K), 2), true);

console.log("\n=== 7. 失败不删（用户最强调的一条）===");
const pendFile = path.join(MEMORY_DIR, "待总结", "记忆", "Alex.txt");
const logFile = store.diaryLogPath(K);
const beforePend = fs.readFileSync(pendFile, "utf-8");
const beforeLog = fs.readFileSync(logFile, "utf-8");

store.markFail("memory", K, "接口 500 了");
const afterFail = store.readPending("memory", K);
check("失败了，一行都没少", afterFail.lines, 4);
check("失败计数 +1", afterFail.fails, 1);
check("失败原因记下来了", afterFail.lastError, "接口 500 了");
checkThat(
  "失败时不生成 .bak（备份是「成功时」的事）",
  !fs.existsSync(path.join(MEMORY_DIR, "待总结", "记忆", "Alex.bak.txt"))
);
check("失败时日记流水一个字节没动", fs.readFileSync(logFile, "utf-8"), beforeLog);
check("失败时待总结正文一个字节没动", fs.readFileSync(pendFile, "utf-8"), beforePend);

check(
  "退避：失败之后要再攒满一轮 rounds 才重试",
  store.shouldSummarize(store.readPending("memory", K), 2),
  false
);
store.appendPending("memory", K, { user: "又说了一句", assistant: "嗯" });
store.appendPending("memory", K, { user: "再说一句", assistant: "嗯嗯" });
check("再攒满 2 轮就重试", store.shouldSummarize(store.readPending("memory", K), 2), true);

console.log("\n=== 8. 成功才清空，且清空前先备份 ===");
const pendBeforeCommit = fs.readFileSync(pendFile, "utf-8");
check("提交成功", store.commitPending("memory", K), true);
check(
  ".bak.txt 里是生成前的原文",
  fs.readFileSync(path.join(MEMORY_DIR, "待总结", "记忆", "Alex.bak.txt"), "utf-8"),
  pendBeforeCommit
);
check("原文件清空了", store.readPending("memory", K).lines, 0);
check("轮数也归零", store.readPending("memory", K).rounds, 0);
check("失败计数也归零", store.readPending("memory", K).fails, 0);
check("备忘录那份没被牵连", store.readPending("memo", K).lines, 2);
// 空流水绝不打接口 —— 状态文件被手删/重建时的兜底
checkThat("清空之后就算轮数够也不触发", !store.shouldSummarize(store.readPending("memory", K), 1));

check("日记流水提交成功", store.commitDiaryLog(K), true);
check(
  "日记 .bak.txt 里是生成前的流水",
  fs.readFileSync(path.join(MEMORY_DIR, "日记", "Alex", "diary_log.bak.txt"), "utf-8"),
  beforeLog
);
check("流水清空了", store.readDiaryLog(K), "");
check("成品日记一篇都没少（生成后的日记永远不清空）", store.listDiaries(K).length, 4);

console.log("\n=== 9. 概览 ===");
const st = store.statsFor(K);
check("记忆条数", st.memories, 1);
check("日记篇数", st.diaries, 4);
check("待总结行数：记忆 0 / 备忘录 2", [st.pendingMemory, st.pendingMemo], [0, 2]);
check("待总结字数：记忆清空了", st.pendingMemoryChars, 0);
checkThat("待总结字数：备忘录还有", st.pendingMemoChars > 0);
checkThat("备忘录字数 > 0", st.memoChars > 0);

console.log("\n=== 10. 配置层 ===");
const { normalizeConfig, DEFAULT_CONFIG, MODEL_CATEGORIES } = await import(
  "../server/src/config.js"
);
const prompts = await import("../server/src/memoryprompts.js");

checkThat("向量分类加进 MODEL_CATEGORIES 了", MODEL_CATEGORIES.includes("embedding"));
const cfg = normalizeConfig({});
check("三块设置齐了", Object.keys(cfg.memories), ["memory", "memo", "diary"]);
check("记忆默认 15 轮", cfg.memories.memory.rounds, 15);
check("备忘录默认 15 轮", cfg.memories.memo.rounds, 15);
check("日记字数：默认关、800/3000、重试 3 次", cfg.memories.diary.limit, {
  enabled: false,
  min: 800,
  max: 3000,
  retry: false,
  retries: 3,
});
check("生成日记默认回看近 1 天", cfg.memories.diary.selfInject, { enabled: true, days: 1 });
check("定时日记默认关", cfg.memories.diary.schedule.enabled, false);
check("手动日记默认开", cfg.memories.diary.manual, true);
check("日记默认跟角色已绑的世界书走", cfg.memories.diary.useRoleWorldBooks, true);
check("角色那边只有开关，默认全关、日记注入近 3 天", cfg.roles[0].memories, {
  memory: { enabled: false },
  memo: { enabled: false },
  diary: { enabled: false, injectDays: 3 },
});

checkThat(
  "备忘录提示词里有「严禁将 <memories> 加进备忘录」（用户钉死的）",
  cfg.memories.memo.prompt.includes("严禁将<memories>的内容也加入到备忘录里")
);
checkThat(
  "日记提示词里有「绝对禁止虚构与 {{char}} 的互动记录」（用户钉死的）",
  cfg.memories.diary.prompt.includes("绝对禁止虚构与{{char}}的互动记录")
);
checkThat(
  "日记提示词留着两个变量位",
  cfg.memories.diary.prompt.includes("{{writing_style_reference}}") &&
    cfg.memories.diary.prompt.includes("{{to_do_list}}")
);
checkThat(
  "待办提示词里有「每项后面加一句碎碎念」",
  prompts.DEFAULT_TODO_PROMPT.includes("必须添加一个角色的碎碎念")
);
checkThat(
  "文风提示词里有「夏日波子汽水」",
  prompts.DEFAULT_STYLE_REF.includes("夏日波子汽水")
);

const twice = JSON.stringify(normalizeConfig(normalizeConfig(cfg)));
check("规范化两遍结果一样（幂等）", twice, JSON.stringify(cfg));

const blank = normalizeConfig({ memories: { memory: { prompt: "  " }, diary: { styleRef: "" } } });
check(
  "提示词清空 = 恢复默认（空提示词会让模型乱写）",
  blank.memories.memory.prompt,
  DEFAULT_CONFIG.memories.memory.prompt
);
const wild = normalizeConfig({
  memories: { memory: { rounds: 99999, threshold: 5, topK: -3 } },
  roles: [{ name: "x", memories: { diary: { injectDays: 999 } } }],
});
check(
  "越界的值被夹回区间",
  [
    wild.memories.memory.rounds,
    wild.memories.memory.threshold,
    wild.memories.memory.topK,
    wild.roles[0].memories.diary.injectDays,
  ],
  [200, 1, 1, 30]
);

const { buildBundle } = await import("../server/src/backup.js");
const bundle = buildBundle(cfg, { includeSecrets: false });
checkThat("备份里带上记忆库的**设置**", Boolean(bundle.config.memories?.memory));
const bundleText = JSON.stringify(bundle);
checkThat(
  "备份里没有记忆/备忘录/日记的**正文**（那在 data/memories/，跟对话记录一个道理）",
  // 上面几节往这个临时库里写过这些字样，一个都不该出现在备份包里
  !bundleText.includes("改过的第一条") &&
    !bundleText.includes("1. 第二版") &&
    !bundleText.includes("今天很好") &&
    !bundleText.includes("我刚睡醒")
);

console.log("\n=== 11. 检索算法（纯函数）===");
const mem = await import("../server/src/memory.js");
const DAY = 86400000;
const T = Date.parse("2026-09-09T12:00:00Z");

check("中文按 2-gram 切", mem.extractKeywords("营地确认"), ["营地", "地确", "确认"]);
check("两个字的整块保留", mem.extractKeywords("小猫"), ["小猫"]);
check("英文整词 + 数字 + 单字中文", mem.extractKeywords("Camp 2026 好"), ["camp", "2026", "好"]);
check("单个字母是噪音，不要", mem.extractKeywords("a bb"), ["bb"]);
check("重复的 2-gram 去掉（命中一个词只算一分）", mem.extractKeywords("猫猫猫"), ["猫猫"]);
check("空串抽不出词", mem.extractKeywords(""), []);

check("距离 0（一模一样）→ 满分", mem.semanticScore(0), 1);
check("距离 1 → 0.5", mem.semanticScore(1), 0.5);
check("负距离（浮点误差）当 0 分", mem.semanticScore(-1), 0);
check("算不出距离时给 0 分", mem.semanticScore(NaN), 0);

check("同方向不同长度的向量，余弦 = 1", mem.cosineSimilarity([1, 2, 3], [2, 4, 6]), 1);
check("正交向量余弦 = 0", mem.cosineSimilarity([1, 0], [0, 1]), 0);
check("维度对不上返回 0（不抛）", mem.cosineSimilarity([1, 0], [1, 0, 0]), 0);
check("零向量返回 0（不是 NaN）", mem.cosineSimilarity([0, 0], [1, 0]), 0);
check("正交 → 距离 1", mem.cosineDistance([1, 0], [0, 1]), 1);

check("关键词命中一半", mem.keywordScore(["营地", "确认"], "明天去营地"), 0.5);
check("查询抽不出词时给 0 分（给 1 会把阈值冲垮）", mem.keywordScore([], "任何内容"), 0);
check("这条记忆自己存的关键词也算命中", mem.keywordScore(["猫"], "狗", "猫 宠物"), 1);

/*
 * 「老而准的记忆不被时间衰减踢掉」—— 参考实现专门强调的那条，也是这一层
 * 最容易写错的地方。old 这条语义和关键词都满分（base ≈ 1.0），但一百天没提过，
 * 衰减完 final 掉到 0 —— 已经在阈值 0.35 以下了，却必须还在候选里。
 */
const cands = [
  { id: "old", content: "营地确认好了", score: 1, timestamp: T - 100 * DAY },
  { id: "fresh", content: "营地", score: 0.5, timestamp: T },
  { id: "weak", content: "完全无关", score: 0.1, timestamp: T },
];
const ranked = mem.rankCandidates(cands, "营地确认", {
  threshold: 0.35,
  decay: 0.01,
  timeDecay: true,
  now: T,
});
check("排序按衰减后的分数：新的在前", ranked.map((r) => r.id), ["fresh", "old"]);
const old = ranked.find((r) => r.id === "old");
checkThat("老而准的那条：base 接近满分", old.baseScore > 0.99);
checkThat(
  "它衰减后已经掉到阈值以下，但**还在候选里**（阈值判 base 不判 final）",
  old.finalScore < 0.35
);
check("它老了 100 天", old.ageDays, 100);
checkThat("不相关的那条被阈值挡掉", !ranked.some((r) => r.id === "weak"));

const noDecay = mem.rankCandidates(cands, "营地确认", {
  threshold: 0.35,
  decay: 0.01,
  timeDecay: false,
  now: T,
});
check("关掉时间衰减，老而准的那条排回第一", noDecay.map((r) => r.id), ["old", "fresh"]);
check("候选不是数组时返回空（不抛）", mem.rankCandidates(null, "x"), []);

const budget = [
  { id: "i1", date: "2026-09-09", content: "AAAAA", timestamp: T },
  { id: "i2", date: "2026-09-08", content: "B".repeat(50), timestamp: T - DAY },
  { id: "i3", date: "2026-09-07", content: "CCC", timestamp: T - 2 * DAY },
];
check(
  "字符预算：加不下的那条**跳过**，后面短的还能进来（不是就此打住）",
  mem.selectForInjection(budget, { topK: 10, maxChars: 40, now: T }).map((x) => x.id),
  ["i1", "i3"]
);
check(
  "top-K 砍的是相关性排名（按传进来的顺序），不是时间",
  mem.selectForInjection(
    [
      { id: "b", date: "2026-09-08", content: "乙", timestamp: T - DAY },
      { id: "a", date: "2026-09-09", content: "甲", timestamp: T },
    ],
    { topK: 1, now: T }
  ).map((x) => x.id),
  ["b"]
);
check(
  "挑完按时间倒序给出去（新的先让模型看到）",
  mem.selectForInjection(
    [
      { id: "b", date: "2026-09-08", content: "乙", timestamp: T - DAY },
      { id: "a", date: "2026-09-09", content: "甲", timestamp: T },
    ],
    { topK: 10, now: T }
  ).map((x) => x.id),
  ["a", "b"]
);
check(
  "天数窗口截掉更老的",
  mem.selectForInjection(budget, { topK: 10, keepDays: 1, now: T }).map((x) => x.id),
  ["i1", "i2"]
);
check("keepDays 不填 = 不限天数", mem.selectForInjection(budget, { topK: 10, now: T }).length, 3);
check("topK 0 = 一条都不注入", mem.selectForInjection(budget, { topK: 0, now: T }), []);
check("传 null 返回空（不抛）", mem.selectForInjection(null), []);

const recs = [
  { id: "r2", timestamp: T - 2 * DAY },
  { id: "r10", timestamp: T - 10 * DAY },
  { id: "r0", timestamp: T },
];
check("近 3 天，顺带排成倒序", mem.filterRecent(recs, 3, T).map((r) => r.id), ["r0", "r2"]);
check("负数 = 全给", mem.filterRecent(recs, -1, T).map((r) => r.id), ["r0", "r2", "r10"]);
check("近 0 天 = 只有今天这一刻起", mem.filterRecent(recs, 0, T).map((r) => r.id), ["r0"]);
check("传 null 返回空（不抛）", mem.filterRecent(null, 3, T), []);

check(
  "检索那路：每行都自带日期（几条之间没有时间关系）",
  mem.formatMemoryLines([
    { date: "2026-09-09", content: "甲" },
    { date: "2026-09-09", content: "乙" },
  ]),
  "- 2026-09-09 | 甲\n- 2026-09-09 | 乙"
);
check(
  // 参考实现 tests/test_retrieval.py 里钉着这个形状，只去掉它的【系统提示】前缀
  "近期那路：同一天不重复写日期，只有第一行带 -",
  mem.formatRecentLines([
    { date: "2026-07-27", content: "first" },
    { date: "2026-07-27", content: "second" },
    { date: "2026-07-26", content: "third" },
  ]),
  "- 2026-07-27 | first\nsecond\n2026-07-26 | third"
);
check("空正文不占一行", mem.formatRecentLines([{ date: "2026-09-09", content: "  " }]), "");
check("没日期的退到「未知日期」", mem.formatMemoryLines([{ content: "甲" }]), "- 未知日期 | 甲");
check("传 null 返回空串（不抛）", mem.formatMemoryLines(null), "");

check(
  "近期那路注入过的，检索那路不再重复（不然模型当成两件事）",
  mem.dedupeAgainst([{ id: "a" }, { id: "b" }], [{ id: "a" }]).map((x) => x.id),
  ["b"]
);
check("没重复的原样保留", mem.dedupeAgainst([{ id: "a" }], []).map((x) => x.id), ["a"]);

check("超长文本截断后再去算向量", mem.truncate("abcdef", 3), "abc");
check("限长 0 = 别打接口了", mem.truncate("abc", 0), "");
check("限长为负也返回空串", mem.truncate("abc", -1), "");
check("没超长就原样", mem.truncate("abc", 100), "abc");

console.log("\n=== 12. 注入：四个变量和三道角色闸 ===");
const { buildPrompt } = await import("../server/src/prompt.js");
const { DEFAULT_MEMORY_ENTRY, LEGACY_MEMORY_ENTRY, defaultEntries } = await import(
  "../server/src/preset.js"
);

/*
 * 这一节用的角色叫 Inject（memoryKeyFor 会算出 "Inject"），和前面几节的
 * Alex 分开 —— 那边的记忆和日记是拿来测文件层的，混进来会让断言看不出因果。
 *
 * ⚠️ 两条记忆的时间戳**必须相对 now 算**。这里测的是 filterRecent 的
 * 「近 3 天」窗口（cutoff = now - 3 天），写死一个日期的话，脚本在那个
 * 日期之后跑就会自己滑出窗口 —— 断言不是发现了 bug，而是日历翻页了。
 */
const IK = "Inject";
store.appendMemory(IK, {
  content: "定了周六去营地露营",
  keywords: ["露营", "营地"],
  timestamp: Date.now() - DAY, // 昨天：稳稳在近 3 天里
});
store.appendMemory(IK, {
  content: "去年冬天在北海道看过雪",
  keywords: ["北海道", "雪"],
  timestamp: Date.now() - 300 * DAY, // 约十个月前：稳稳在窗口外
});
store.writeMemo(IK, "1. 周六 09:00 出发\n2. 记得带帐篷");
store.writeDiary(IK, store.localDate(), "今天她答应跟我去露营了，开心。");

function injectConfig(memories = {}) {
  return normalizeConfig({
    presets: [{ id: "ps-1", name: "默认" }],
    roles: [
      {
        id: "r-inj",
        name: IK,
        description: "人设正文",
        presetRef: "ps-1",
        memories,
      },
    ],
  });
}

/** 拼一次提示词，把整份压成一段文本。 */
async function promptText(cfg) {
  const { messages } = await buildPrompt(cfg, cfg.roles[0], null, [
    { role: "user", content: "周六露营的事定了吗" },
  ]);
  return messages.map((m) => m.content).join("\n\n");
}

const allOff = await promptText(injectConfig());
checkThat("三个开关全关 → 整条记忆库不产出", !allOff.includes("<记忆库>"));
checkThat("连空壳标签都没有", !allOff.includes("<近期记忆>"));

const memOn = await promptText(injectConfig({ memory: { enabled: true } }));
checkThat("开了记忆 → 记忆库那段出现了", memOn.includes("<记忆库>"));
checkThat("近 3 天那条注进来了", memOn.includes("定了周六去营地露营"));
checkThat(
  "去年那条不在近 3 天里，也没有向量模型可检索 → 不注入",
  !memOn.includes("北海道")
);
checkThat("备忘录没开 → 那段不出现", !memOn.includes("记得带帐篷"));
checkThat("备忘录的空标签也被收掉", !memOn.includes("<备忘录>"));
checkThat("日记没开 → 那段不出现", !memOn.includes("她答应跟我去露营"));

const memoOn = await promptText(injectConfig({ memo: { enabled: true } }));
checkThat("只开备忘录 → 备忘录进来了", memoOn.includes("记得带帐篷"));
checkThat("记忆没开 → 记忆那段不出现", !memoOn.includes("定了周六去营地露营"));

const diaryOn = await promptText(injectConfig({ diary: { enabled: true, injectDays: 3 } }));
checkThat("只开日记 → 日记进来了", diaryOn.includes("她答应跟我去露营"));
checkThat("日记带上日期抬头", diaryOn.includes(`【${store.localDate()}】`));

const diaryZero = await promptText(injectConfig({ diary: { enabled: true, injectDays: 0 } }));
checkThat(
  "注入近 0 天 = 照常生成但不回注（用户可以这么配）",
  !diaryZero.includes("她答应跟我去露营")
);

const allOn = await promptText(
  injectConfig({
    memory: { enabled: true },
    memo: { enabled: true },
    diary: { enabled: true, injectDays: 3 },
  })
);
checkThat("三个全开 → 三段都在",
  allOn.includes("定了周六去营地露营") &&
    allOn.includes("记得带帐篷") &&
    allOn.includes("她答应跟我去露营")
);
checkThat("外层用 <记忆库> 包着（规范：同样使用 XML 标签包裹）",
  allOn.includes("<记忆库>") && allOn.includes("</记忆库>"));
for (const tag of ["近期记忆", "备忘录", "日记"]) {
  checkThat(`内层 <${tag}> 标签成对`,
    allOn.includes(`<${tag}>`) && allOn.includes(`</${tag}>`));
}
checkThat(
  "没配向量模型 → 回忆那段是空的，整段（含那两句提示词）被收掉",
  !allOn.includes("<过往回忆>") && !allOn.includes("以下是你脑海中回想起的过往记忆")
);
checkThat(
  "「把这些记忆当作已经历过的事实」那句也没留下 —— 没有记忆却要求模型自然融入，只能靠编",
  !allOn.includes("绝对不要生硬地像机器人一样复述记忆")
);
checkThat("四个变量占位符一个都不剩", !/\{\{(近N天记忆|回忆起来的记忆|备忘录|近N天日记)\}\}/.test(allOn));

const entryOff = injectConfig({ memory: { enabled: true } });
entryOff.presets[0].entries.find((e) => e.kind === "memory").enabled = false;
checkThat(
  "预设条目关掉 → 角色开着也不注入",
  !(await promptText(entryOff)).includes("定了周六去营地露营")
);

const entries = defaultEntries();
const memEntry = entries.find((e) => e.kind === "memory");
check("记忆库条目默认开着（闸在角色那三个开关上）", memEntry.enabled, true);
checkThat("默认正文里四个变量都在",
  ["{{近N天记忆}}", "{{回忆起来的记忆}}", "{{备忘录}}", "{{近N天日记}}"]
    .every((v) => DEFAULT_MEMORY_ENTRY.includes(v)));

// 用户钉死的格式：四段标签就位，且**只有过往回忆带提示词**
checkThat("默认正文用的是新标签名",
  ["<近期记忆>", "<过往回忆>", "<备忘录>", "<日记>"]
    .every((t) => DEFAULT_MEMORY_ENTRY.includes(t)));
checkThat("默认正文里没有老标签名",
  !DEFAULT_MEMORY_ENTRY.includes("<回忆起来的记忆>") &&
    !DEFAULT_MEMORY_ENTRY.includes("<我的日记>"));
checkThat("过往回忆那段带着两句提示词",
  DEFAULT_MEMORY_ENTRY.includes("以下是你脑海中回想起的过往记忆：") &&
    DEFAULT_MEMORY_ENTRY.includes("请在接下来的对话中，把这些记忆当作你已经历过的事实"));
checkThat("开头没有引言（用户要求近期记忆/备忘录/日记不带提示词）",
  DEFAULT_MEMORY_ENTRY.startsWith("<近期记忆>"));
for (const [tag, varName] of [["近期记忆", "{{近N天记忆}}"], ["备忘录", "{{备忘录}}"], ["日记", "{{近N天日记}}"]]) {
  // 那一段标签之间除了变量只能有空白 —— 多一个字就是给这一段加提示词了
  const body = DEFAULT_MEMORY_ENTRY.split(`<${tag}>`)[1]?.split(`</${tag}>`)[0] ?? "";
  check(`<${tag}> 里只有变量、没有提示词`, body.trim(), varName);
}

// 老默认值（LEGACY_MEMORY_ENTRY）要能认出来换成新格式
const migrated = normalizeConfig({
  presets: [{
    id: "ps-1", name: "旧",
    entries: [{ id: "e-6", kind: "memory", enabled: true, content: LEGACY_MEMORY_ENTRY }],
  }],
  roles: [{ id: "r-1", name: IK, presetRef: "ps-1" }],
});
check(
  "存着老默认正文的预设（data/presets 里那份就是）自动换成新格式",
  migrated.presets[0].entries.find((e) => e.kind === "memory").content,
  DEFAULT_MEMORY_ENTRY
);

// 用户自己改过的正文一个字都不能动
const custom = "<近期记忆>\n{{近N天记忆}}\n</近期记忆>\n我自己写的";
const kept = normalizeConfig({
  presets: [{
    id: "ps-1", name: "自定义",
    entries: [{ id: "e-6", kind: "memory", enabled: true, content: custom }],
  }],
  roles: [{ id: "r-1", name: IK, presetRef: "ps-1" }],
});
check(
  "用户改过的正文原样留着（不认成老默认值）",
  kept.presets[0].entries.find((e) => e.kind === "memory").content,
  custom
);

// 老配置：memory 那条以前是纯占位、没有 content 字段
const legacy = normalizeConfig({
  presets: [{ id: "ps-1", name: "旧", entries: [{ id: "e-6", kind: "memory", enabled: false }] }],
  roles: [{ id: "r-1", name: IK, presetRef: "ps-1", memories: { memory: { enabled: true } } }],
});
const legacyEntry = legacy.presets[0].entries.find((e) => e.kind === "memory");
check("老配置补上默认正文", legacyEntry.content, DEFAULT_MEMORY_ENTRY);
check("老配置里用户关掉的 enabled 原样留着（不擅自打开）", legacyEntry.enabled, false);

console.log("\n=== 13. 三条总结链（假 fetch）===");
const chains = await import("../server/src/memory.js");

/*
 * 假 fetch。三条链最后都落到 llm.js:chatCompletion（打 /chat/completions）
 * 和 embedText（打 /embeddings），所以在这一层拦最省事 —— 链本身的代码
 * 一行都不用为测试改。
 *
 * reply 可以是字符串，也可以是函数（拿到第几次调用、请求体，自己决定回什么），
 * 后者是给「字数不够就重试」那组用的。
 */
let sentBodies = [];
const realFetch = globalThis.fetch;
function fakeLLM(reply, opts = {}) {
  sentBodies = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    sentBodies.push({ url: String(url), body });
    if (opts.status) {
      return new Response(JSON.stringify({ error: { message: "炸了" } }), {
        status: opts.status,
      });
    }
    if (String(url).endsWith("/embeddings")) {
      return new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }), { status: 200 });
    }
    const text = typeof reply === "function" ? reply(sentBodies.length, body) : reply;
    return new Response(
      JSON.stringify({ choices: [{ message: { content: text } }] }),
      { status: 200 }
    );
  };
}
/** 三条链发出去的那一整条消息（形状见第 17 节：一条 user）。 */
const sentText = (i = 0) => sentBodies[i].body.messages.map((m) => m.content).join("\n");

const CK = "Chain";
function chainConfig(over = {}) {
  return normalizeConfig({
    providers: [
      {
        id: "pv-1",
        name: "测试源",
        url: "https://api.test/v1",
        keys: ["sk-test"],
        models: [
          { id: "md-1", model: "gpt-x", categories: ["chat"] },
          { id: "md-2", model: "embed-x", categories: ["embedding"] },
        ],
      },
    ],
    users: [{ id: "u-1", name: "米洛", description: "用户人设正文", enabled: true, scope: "global" }],
    worldBooks: [
      {
        id: "wb-1",
        name: "设定集",
        enabled: true,
        global: true,
        entries: [{ id: "we-1", enabled: true, keys: ["营地"], content: "营地在湖边" }],
      },
    ],
    presets: [{ id: "ps-1", name: "默认" }],
    roles: [{ id: "r-c", name: CK, description: "角色人设正文", presetRef: "ps-1" }],
    memories: {
      memory: { model: { provider: "pv-1", modelId: "md-1" }, ...(over.memory ?? {}) },
      memo: { model: { provider: "pv-1", modelId: "md-1" }, ...(over.memo ?? {}) },
      diary: { model: { provider: "pv-1", modelId: "md-1" }, ...(over.diary ?? {}) },
    },
  });
}
const chainRole = (cfg) => cfg.roles[0];

store.appendPending("memory", CK, { user: "营地定了吗", assistant: "定了，周六出发", userName: "米洛", charName: CK });
store.appendPending("memo", CK, { user: "营地定了吗", assistant: "定了，周六出发", userName: "米洛", charName: CK });

// ---- 记忆链 ----
{
  const cfg = chainConfig();
  fakeLLM("周六去营地露营已确认。");
  const out = await chains.summarizeMemory(cfg, chainRole(cfg), CK);
  check("记忆：存下了模型给的那段", out.content, "周六去营地露营已确认。");
  check("记忆：落盘了一条", store.readMemories(CK).length, 1);
  checkThat("记忆：抽了关键词出来", store.readMemories(CK)[0].keywords.length > 0);
  check("记忆：成功后待总结被清空", store.readPending("memory", CK).lines, 0);
  check(
    "记忆：清空前留了 .bak（硬约束 2）",
    fs
      .readFileSync(path.join(MEMORY_DIR, "待总结", "记忆", "Chain.bak.txt"), "utf-8")
      .split(/\r?\n/)
      .filter((l) => l.trim()).length,
    2
  );

  const text = sentText(0);
  checkThat("记忆：顶部必须是生成记忆提示词", text.startsWith("<生成记忆提示词>"));
  checkThat("记忆：底部必须是待总结的内容", text.trimEnd().endsWith("</memories>"));
  checkThat(
    "记忆：待总结那段用 <memories> 包（用户点名的标签）",
    text.includes("<memories>") && text.includes("[Chain] 定了，周六出发")
  );
  check(
    "记忆：中间四段顺序 = 人设 → 用户 → 世界书 → 待总结",
    ["<Character>", "<User>", "<World_Info>", "<memories>"].map((t) => text.indexOf(t)),
    ["<Character>", "<User>", "<World_Info>", "<memories>"]
      .map((t) => text.indexOf(t))
      .slice()
      .sort((a, b) => a - b)
  );
  checkThat("记忆：世界书按待总结的内容命中了", text.includes("营地在湖边"));
  checkThat("记忆：不发预设（没有消息格式与功能那段）", !text.includes("<消息格式与功能>"));
  checkThat("记忆：不发预设（没有 Chat_History）", !text.includes("<Chat_History>"));
  check("记忆：只发一条消息", sentBodies[0].body.messages.length, 1);
  checkThat("记忆：没配向量模型时不打 /embeddings", !sentBodies.some((s) => s.url.endsWith("/embeddings")));
  checkThat("记忆：没算向量时 embedding 是 null", store.readMemories(CK)[0].embedding === null);
}

// ---- 记忆链：配了向量模型 ----
{
  const cfg = chainConfig({ memory: { embedModel: { provider: "pv-1", modelId: "md-2" } } });
  store.appendPending("memory", CK, { user: "几点出发", assistant: "九点" });
  fakeLLM("出发时间定在九点。");
  const out = await chains.summarizeMemory(cfg, chainRole(cfg), CK);
  check("记忆：向量算成了", out.embedded, true);
  check("记忆：向量存进这条记录", store.readMemories(CK)[1].embedding, [1, 0, 0]);
  checkThat("记忆：确实打了 /embeddings", sentBodies.some((s) => s.url.endsWith("/embeddings")));
}

// ---- 记忆链：向量挂了不连累正文 ----
{
  const cfg = chainConfig({ memory: { embedModel: { provider: "pv-1", modelId: "md-2" } } });
  store.appendPending("memory", CK, { user: "带帐篷吗", assistant: "带" });
  const before = store.readMemories(CK).length;
  globalThis.fetch = async (url, init) => {
    sentBodies.push({ url: String(url), body: JSON.parse(init.body) });
    if (String(url).endsWith("/embeddings")) throw new TypeError("fetch failed");
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "确认要带帐篷。" } }] }),
      { status: 200 }
    );
  };
  sentBodies = [];
  const out = await chains.summarizeMemory(cfg, chainRole(cfg), CK);
  check("记忆：向量打不通不算失败", out.embedded, false);
  check("记忆：正文照样存下来（不为一次向量失败丢掉总结）", store.readMemories(CK).length, before + 1);
  checkThat("记忆：这条的 embedding 是 null，只是暂时进不了语义检索",
    store.readMemories(CK)[before].embedding === null);
  check("记忆：照样清空了待总结", store.readPending("memory", CK).lines, 0);
}

// ---- 备忘录链 ----
{
  const cfg = chainConfig();
  const NOW = new Date("2026-02-13T14:09:00");
  fakeLLM("1. 周六去营地\n更新时间：2026年02月13日 14:09");
  await chains.summarizeMemo(cfg, chainRole(cfg), CK, NOW);
  checkThat("备忘录：整份覆盖写进去了", store.readMemo(CK).includes("周六去营地"));
  check("备忘录：成功后待总结被清空", store.readPending("memo", CK).lines, 0);

  const text = sentText(0);
  checkThat("备忘录：顶部必须是生成备忘录提示词", text.startsWith("<生成备忘录提示词>"));
  checkThat("备忘录：底部必须是待总结的内容", text.trimEnd().endsWith("</待总结备忘录>"));
  check(
    "备忘录：中间顺序 = 人设 → 用户 → 世界书 → 近N天记忆 → 待总结",
    ["<Character>", "<User>", "<World_Info>", "<近N天记忆>", "<待总结备忘录>"]
      .map((t) => text.indexOf(t))
      .every((v, i, a) => i === 0 || (v > a[i - 1] && v > 0)),
    true
  );
  checkThat(
    "备忘录：**不注入 <memories> 原文**（用户钉死：备忘录不是记忆）",
    // 只能查闭标签：提示词正文里那句硬约束本身就带一个字面的 <memories>，
    // 查开标签会被它误伤。wrap() 出来的块一定是成对的，所以闭标签才是准信
    !text.includes("</memories>")
  );
  checkThat("备忘录：近 N 天记忆是纯文本行，不带 memories 标签",
    text.includes("<近N天记忆>") && text.includes("周六去营地露营已确认"));
  checkThat(
    "备忘录：{current_time} 换成了生成那一刻的系统时间",
    text.includes("2026年02月13日 14:09") && !text.includes("{current_time}")
  );
  checkThat("备忘录：提示词里那句硬约束还在",
    text.includes("严禁将<memories>的内容也加入到备忘录里"));
  checkThat("备忘录：不发预设", !text.includes("<Chat_History>"));
}

// ---- 日记链 ----
// 第一条特意提到「营地」—— 世界书那条的关键词就是它，这样下面那组顺序断言
// 里的 <World_Info> 才真的会出现（顺带证明日记链也扫世界书）
store.appendDiaryLine(CK, chains.diaryLogLine("Chain", "我刚睡醒，营地的事我记着呢", new Date("2026-09-04T22:12:07")));
store.appendDiaryLine(CK, chains.diaryLogLine("米洛", "早\n我已经在学校了", new Date("2026-09-04T22:12:07")));

check(
  "日记流水：格式 = 系统时间 + 发送人 + 内容（用户给的示例）",
  chains.diaryLogLine("Alex", "我刚睡醒", new Date("2026-09-04T22:12:07")),
  "2026-09-04 星期五 22:12:07 | [Alex] 我刚睡醒"
);
check(
  "日记流水：星期用中文（用户的示例是「星期二」不是 Tuesday）",
  chains.diaryLogLine("Alex", "x", new Date("2026-09-08T09:45:18")),
  "2026-09-08 星期二 09:45:18 | [Alex] x"
);
checkThat("日记流水：消息格式标记原样留着（用户要求每条都记）",
  chains.diaryLogLine("阿瑞", "yeah?$what do u want now puppy$[疑问]")
    .endsWith("| [阿瑞] yeah?$what do u want now puppy$[疑问]"));
checkThat("日记流水：引用和转账这些也原样留着",
  chains.diaryLogLine("Alex", '<quoted_message sender="阿瑞">别闹</quoted_message> u can try$【转账】')
    .endsWith('| [Alex] <quoted_message sender="阿瑞">别闹</quoted_message> u can try$【转账】'));
checkThat("日记流水：多行内容压成一行（一轮一行）",
  chains.diaryLogLine("米洛", "早\n我已经在学校了").endsWith("| [米洛] 早 我已经在学校了"));
checkThat("日记流水里不写天气（天气只在生成时注入一次）",
  !store.readDiaryLog(CK).includes("天气"));

{
  const cfg = chainConfig();
  const NOW = new Date("2026-09-09T22:00:00");
  fakeLLM("今天和她聊了营地的事，心里挺高兴。");
  const out = await chains.generateDiary(cfg, chainRole(cfg), CK, {
    now: NOW,
    weather: "晴 24℃",
  });
  check("日记：存成 2026-09-09.md", out.file, "2026-09-09.md");
  check("日记：打了一次就成", out.tries, 1);
  check("日记：成功后流水清空了", store.readDiaryLog(CK), "");
  check(
    "日记：清空前备份了流水（硬约束 2）",
    fs
      .readFileSync(path.join(MEMORY_DIR, "日记", "Chain", "diary_log.bak.txt"), "utf-8")
      .includes("我刚睡醒"),
    true
  );

  const text = sentText(0);
  checkThat("日记：顶部必须是日记提示词", text.startsWith("<日记提示词>"));
  checkThat("日记：底部必须是 diary_log", text.trimEnd().endsWith("</Chain_diary_log>"));
  check(
    "日记：八段顺序照规范（提示词→人设→用户→世界书→近N天记忆→备忘录→天气→流水）",
    ["<日记提示词>", "<Character>", "<User>", "<World_Info>", "<近N天记忆>",
     "<备忘录>", "<当前天气>", "<Chain_diary_log>"]
      .map((t) => text.indexOf(t))
      .every((v, i, a) => v >= 0 && (i === 0 || v > a[i - 1])),
    true
  );
  checkThat("日记：天气注进来了", text.includes("晴 24℃"));
  checkThat("日记：待总结的流水在底部那段里", text.includes("我刚睡醒"));
  checkThat("日记：世界书按流水里的关键词命中了", text.includes("营地在湖边"));
  checkThat("日记：那条硬约束还在提示词里",
    text.includes("绝对禁止虚构与Chain的互动记录"));
  checkThat("日记：文风默认开，整段展开了", text.includes("夏日波子汽水"));
  checkThat("日记：待办默认关，那一行整行删掉（不留空壳）",
    !text.includes("{{to_do_list}}") && !text.includes("To-do list"));
  checkThat("日记：不发预设", !text.includes("<Chat_History>"));
}

// ---- 日记：天气报错就不注入 ----
{
  const cfg = chainConfig();
  store.appendDiaryLine(CK, chains.diaryLogLine("Chain", "又聊了几句"));
  fakeLLM("今天没什么特别的。");
  await chains.generateDiary(cfg, chainRole(cfg), CK, { now: new Date("2026-09-09T23:00:00"), weather: "" });
  checkThat("日记：天气拿不到时那一段整个不出现", !sentText(0).includes("<当前天气>"));
  check("日记：同一天第二篇不覆盖第一篇（生成后的日记永不清空）",
    store.listDiaries(CK).map((d) => d.file), ["2026-09-09-2.md", "2026-09-09.md"]);
  check("日记：角色没开天气时 diaryWeather 返回空串", await chains.diaryWeather(cfg, chainRole(cfg)), "");
}

// ---- 日记：待办开关 ----
{
  const cfg = chainConfig({ diary: { todoEnabled: true, styleEnabled: false } });
  store.appendDiaryLine(CK, chains.diaryLogLine("Chain", "第三次"));
  fakeLLM("正文。");
  await chains.generateDiary(cfg, chainRole(cfg), CK, { now: new Date("2026-09-10T22:00:00") });
  const text = sentText(0);
  checkThat("日记：开了待办 → {{to_do_list}} 展开成整段", text.includes("必须添加一个角色的碎碎念"));
  checkThat("日记：关了文风 → 那一行整行删掉", !text.includes("夏日波子汽水"));
  checkThat("日记：两个变量占位符都不剩",
    !text.includes("{{to_do_list}}") && !text.includes("{{writing_style_reference}}"));
}

console.log("\n=== 14. 失败不删（三条链的专项）===");

/** 跑一次注定失败的生成，返回抛出来的错误。跑之前记下三个文件的字节数。 */
function bytesOf(file) {
  return fs.existsSync(file) ? fs.statSync(file).size : -1;
}
const pendFileC = path.join(MEMORY_DIR, "待总结", "记忆", "Chain.txt");
const memoPendC = path.join(MEMORY_DIR, "待总结", "备忘录", "Chain.txt");
const logFileC = store.diaryLogPath(CK);

// ---- 记忆：接口 500 ----
{
  const cfg = chainConfig();
  store.appendPending("memory", CK, { user: "会失败的一轮", assistant: "嗯" });
  const before = bytesOf(pendFileC);
  const memBefore = store.readMemories(CK).length;
  fakeLLM("", { status: 500 });
  let err = "";
  try {
    await chains.summarizeMemory(cfg, chainRole(cfg), CK);
  } catch (e) {
    err = e.message;
  }
  checkThat("记忆：接口 500 时抛错，错误里带得上原因", err.includes("500"));
  check("记忆：失败后待总结文件字节数一个没变", bytesOf(pendFileC), before);
  check("记忆：失败后正文还在", store.readPending("memory", CK).lines, 2);
  check("记忆：失败后没有凭空多出一条记忆", store.readMemories(CK).length, memBefore);
}

// ---- 记忆：没配模型 ----
{
  const cfg = chainConfig();
  cfg.memories.memory.model = { provider: "", modelId: "" };
  const before = bytesOf(pendFileC);
  let err = "";
  try {
    await chains.summarizeMemory(cfg, chainRole(cfg), CK);
  } catch (e) {
    err = e.message;
  }
  checkThat("记忆：没选模型时说人话", err.includes("还没给「生成记忆」选模型"));
  check("记忆：连接口都没打，文件当然没动", bytesOf(pendFileC), before);
}

// ---- 记忆：模型引用失效 ----
{
  const cfg = chainConfig();
  cfg.memories.memory.model = { provider: "pv-1", modelId: "no-such" };
  let err = "";
  try {
    await chains.summarizeMemory(cfg, chainRole(cfg), CK);
  } catch (e) {
    err = e.message;
  }
  checkThat("记忆：引用失效时说清是引用的问题", err.includes("引用失效"));
  check("记忆：正文还在", store.readPending("memory", CK).lines, 2);
}

// ---- 记忆：模型回了空 ----
{
  const cfg = chainConfig();
  const before = bytesOf(pendFileC);
  fakeLLM("   ");
  let err = "";
  try {
    await chains.summarizeMemory(cfg, chainRole(cfg), CK);
  } catch (e) {
    err = e.message;
  }
  checkThat("记忆：模型回空也算失败", err.includes("空的总结"));
  check("记忆：文件还是没动", bytesOf(pendFileC), before);
}

// ---- 备忘录：失败不覆盖旧的那份 ----
{
  const cfg = chainConfig();
  store.appendPending("memo", CK, { user: "会失败的一轮", assistant: "嗯" });
  const memoBefore = store.readMemo(CK);
  const before = bytesOf(memoPendC);
  fakeLLM("", { status: 503 });
  let err = "";
  try {
    await chains.summarizeMemo(cfg, chainRole(cfg), CK);
  } catch (e) {
    err = e.message;
  }
  checkThat("备忘录：接口挂了会抛错", err.includes("503"));
  check("备忘录：失败后旧的那份一字未动", store.readMemo(CK), memoBefore);
  check("备忘录：失败后待总结文件字节数没变", bytesOf(memoPendC), before);
}

// ---- 日记：字数不够、重试用完 ----
{
  const cfg = chainConfig({
    diary: { limit: { enabled: true, min: 800, max: 3000, retry: true, retries: 3 } },
  });
  store.appendDiaryLine(CK, chains.diaryLogLine("Chain", "写不够字的那一轮"));
  const before = bytesOf(logFileC);
  const diariesBefore = store.listDiaries(CK).length;
  fakeLLM("太短了。");
  let err = "";
  try {
    await chains.generateDiary(cfg, chainRole(cfg), CK, { now: new Date("2026-09-11T22:00:00") });
  } catch (e) {
    err = e.message;
  }
  check("日记：字数不够会重试满 3 次（用户规定的默认值）", sentBodies.length, 3);
  checkThat("日记：三次都不够就报失败，并说清原因（用户要求告诉失败原因）",
    err.includes("3 次") && err.includes("800 字"));
  checkThat("日记：失败原因里点明流水没删", err.includes("日记流水没有删"));
  check("日记：**diary_log.txt 一个字节都没少**（用户最强调的一条）", bytesOf(logFileC), before);
  checkThat("日记：流水内容还在", store.readDiaryLog(CK).includes("写不够字的那一轮"));
  check("日记：没有落下一篇残缺的成品", store.listDiaries(CK).length, diariesBefore);
  checkThat("日记：备份文件也没被这次失败改写（备份是成功时的事）",
    !fs.readFileSync(path.join(MEMORY_DIR, "日记", "Chain", "diary_log.bak.txt"), "utf-8")
      .includes("写不够字的那一轮"));
}

// ---- 日记：重试之后终于够了 ----
{
  const cfg = chainConfig({
    diary: { limit: { enabled: true, min: 50, max: 3000, retry: true, retries: 3 } },
  });
  // 第一次太短、第二次够长 —— 中途成功就不该再打第三次
  fakeLLM((n) => (n === 1 ? "短" : "够长的日记正文。".repeat(20)));
  const out = await chains.generateDiary(cfg, chainRole(cfg), CK, {
    now: new Date("2026-09-11T23:00:00"),
  });
  check("日记：第二次够长就停，不白打第三次", out.tries, 2);
  check("日记：这次成功了，流水才清空", store.readDiaryLog(CK), "");
}

// ---- 日记：没开重试 = 只打一次 ----
{
  const cfg = chainConfig({
    diary: { limit: { enabled: true, min: 800, max: 3000, retry: false, retries: 3 } },
  });
  store.appendDiaryLine(CK, chains.diaryLogLine("Chain", "只打一次"));
  fakeLLM("还是太短。");
  const out = await chains.generateDiary(cfg, chainRole(cfg), CK, {
    now: new Date("2026-09-12T22:00:00"),
  });
  check("日记：没开重试时字数不够也照样收下（只是提示词里写了要求）", out.tries, 1);
  check("日记：只打了一次接口", sentBodies.length, 1);
}

// ---- 日记：流水是空的 ----
{
  const cfg = chainConfig();
  fakeLLM("不该被打出来的正文。"); // 顺手把 sentBodies 清零，好数这一段打了几次
  let err = "";
  try {
    await chains.generateDiary(cfg, chainRole(cfg), CK, { now: new Date() });
  } catch (e) {
    err = e.message;
  }
  checkThat("日记：流水空的时候不打接口，直接说没有聊天记录", err.includes("没有聊天记录"));
  check("日记：一次接口都没打", sentBodies.length, 0);
}

/*
 * ================= 15. 挂点（memoryhooks）=================
 *
 * 前面几节测的是「怎么总结」，这一节测**什么时候总结**：每轮记一笔、
 * 轮数到了才跑、手动那两条不看轮数、以及三道闸关着时一个字都不写。
 *
 * 用一个单独的角色 HK，免得和上面那些节的文件搅在一起。
 */
console.log("\n=== 15. 挂点：记一笔 / 到点触发 / 手动 ===");
const hooks = await import("../server/src/memoryhooks.js");
const HK = "Hook";
function hookConfig(over = {}) {
  const cfg = chainConfig(over);
  cfg.roles = [
    {
      ...cfg.roles[0],
      id: "r-h",
      name: HK,
      memories: {
        memory: { enabled: true },
        memo: { enabled: true },
        diary: { enabled: true, injectDays: 3 },
      },
    },
  ];
  return cfg;
}
const hookRole = (cfg) => cfg.roles[0];
const hkLog = () => store.diaryLogPath(HK);

// ---- recordTurn：三样各记各的 ----
{
  const cfg = hookConfig();
  fakeLLM("不该被打出来的");
  hooks.recordTurn(cfg, hookRole(cfg), { user: "我刚睡醒", assistant: "早，我在学校了" });
  hooks.recordTurn(cfg, hookRole(cfg), { user: "营地的事我记着呢", assistant: "周六见" });

  check("挂点：待总结记忆攒了 4 行（2 轮）", store.readPending("memory", HK).lines, 4);
  check("挂点：待总结备忘录也攒了 4 行（两份各自数，不共用）",
    store.readPending("memo", HK).lines, 4);
  const text = store.readDiaryLog(HK);
  check("挂点：日记流水一轮两行", text.trim().split(/\r?\n/).length, 4);
  checkThat("挂点：流水里用的是真名（对方先、角色后）",
    text.indexOf("| [米洛] 我刚睡醒") >= 0 &&
      text.indexOf("| [米洛] 我刚睡醒") < text.indexOf("| [Hook] 早，我在学校了"));
  checkThat("挂点：流水里不写天气（天气是生成那一刻的瞬时值）", !/天气|℃/.test(text));
  check("挂点：记一笔不打任何接口", sentBodies.length, 0);

  /*
   * 时间戳：一轮两行必须**一模一样**。
   *
   * 以前两行各自 `new Date()`，跨秒的时候同一轮会写出 09:45:18 和 09:45:19，
   * 看着像隔了一秒的两件事。用户给的示例里一轮两行的时间是相同的。
   */
  const lines = text.trim().split(/\r?\n/);
  const stampOf = (s) => s.slice(0, s.indexOf(" | "));
  check("挂点：一轮两行的时间戳相同", stampOf(lines[0]), stampOf(lines[1]));
  checkThat("挂点：两轮之间的时间戳各自独立（不是全局取一次）",
    lines.every((l) => /^\d{4}-\d{2}-\d{2} 星期[日一二三四五六] \d{2}:\d{2}:\d{2} \| /.test(l)));

  // 三份现在是**同一种流水**：待总结那两份和日记流水应当逐字节一致
  check("挂点：待总结记忆和日记流水一模一样（同一个系统时间、同一种行格式）",
    store.readPending("memory", HK).text.trim(), text.trim());
  check("挂点：记忆和备忘录两份待总结也一模一样",
    store.readPending("memo", HK).text.trim(), store.readPending("memory", HK).text.trim());
}

// ---- 待总结流水：每行带上记录时的系统时间，整份原样发给模型 ----
{
  const cfg = hookConfig();
  const RK = "HookStamp";
  const role = { ...hookRole(cfg), id: "r-hs", name: RK };
  fakeLLM("不该被打出来的");

  // 用户给的示例那一轮：气泡分隔、表情标记、引用、转账全在里面
  hooks.recordTurn(cfg, role, {
    at: "2026-09-08T09:45:18",
    user: "Baby Shark Do Do Do Doagain",
    assistant: "are u high on sugar or what$[无语]$swear im gonna bite u through the screen dummy",
  });
  hooks.recordTurn(cfg, role, {
    at: "2026-09-08T10:48:19",
    user: '<quoted_message sender="阿瑞">别闹</quoted_message> that bitch……$【转账】',
    assistant: "jar thanks u for the $10 lol$[得意]",
  });

  const pending = store.readPending("memory", RK);
  const rendered = chains.pendingText(pending.text, 99_999);
  const lines = rendered.split("\n");
  check("待总结：两轮四行", lines.length, 4);
  check(
    "待总结：行首带年月日星期和具体时间（用户给的示例格式）",
    lines[0],
    "2026-09-08 星期二 09:45:18 | [米洛] Baby Shark Do Do Do Doagain"
  );
  check(
    "待总结：同一轮两行时间相同、角色那行在后",
    lines[1],
    "2026-09-08 星期二 09:45:18 | [HookStamp] are u high on sugar or what$[无语]$swear im gonna bite u through the screen dummy"
  );
  check(
    "待总结：引用和转账原样留着",
    lines[2],
    '2026-09-08 星期二 10:48:19 | [米洛] <quoted_message sender="阿瑞">别闹</quoted_message> that bitch……$【转账】'
  );
  checkThat("待总结：不带天气", !/天气|℃/.test(rendered));

  /*
   * 超长时按**整行**截尾，不留半句残句。
   *
   * 截的是尾巴（近的比远的重要），然后把第一行残缺的那半行丢掉 ——
   * 模型读到「u through the screen dummy」这种没头没尾的东西只会误解。
   */
  const cut = chains.pendingText(pending.text, 120);
  checkThat("待总结：超长时只保留尾部", cut.length <= 120);
  checkThat(
    "待总结：截尾按整行对齐，不留半行残句",
    cut.split("\n").every((l) => /^\d{4}-\d{2}-\d{2} 星期. \d{2}:\d{2}:\d{2} \| \[/.test(l))
  );
  check("待总结：不超长时一个字不动", chains.pendingText(pending.text, 99_999), rendered);
  check("待总结：空的就是空串", chains.pendingText("", 100), "");
}

// ---- 环境前缀：记进去之前剥掉 ----
{
  /*
   * 单独一个角色 HookEnv —— 这一组要往待总结里塞好几轮，
   * 用 HK 的话下面「轮数没到（2 < 5）」那几条就被这里的轮数顶过线了。
   */
  const EK = "HookEnv";
  const cfg = hookConfig();
  const role = { ...hookRole(cfg), id: "r-he", name: EK };
  fakeLLM("不该被打出来的");

  const PREFIX =
    "[{{user}}发送当地时间 CST : 2026-09-09 20:58:54 | 周三, 工作日 | " +
    "{{char}}收到当地时间 PDT : 2026-09-09 05:58:54 | 周三, 工作日]";
  hooks.recordTurn(cfg, role, { user: `${PREFIX}wyd`, assistant: "watching the sky" });

  const lastLine = () =>
    store.readPending("memory", EK).text.trim().split(/\r?\n/).slice(-2)[0];
  check("前缀：待总结里只留对方真正打的字", lastLine().endsWith("| [米洛] wyd"), true);
  checkThat("前缀：待总结里不留时区和节假日",
    !/发送当地时间|工作日|CST/.test(store.readPending("memory", EK).text));
  checkThat("前缀：备忘录那份也剥了",
    store.readPending("memo", EK).text.includes("| [米洛] wyd"));

  const line = store.readDiaryLog(EK).trim().split(/\r?\n/)[0];
  checkThat("前缀：日记流水的行首是系统时间",
    /^\d{4}-\d{2}-\d{2} 星期[日一二三四五六] \d{2}:\d{2}:\d{2} \| /.test(line));
  checkThat("前缀：流水正文里也没有那段时间戳", line.endsWith("| [米洛] wyd"));

  // 同城模式那种形状（`[时间 : … | 周二, 工作日]`）也要认
  hooks.recordTurn(cfg, role, {
    user: "[时间 : 2026-09-09 20:58:54 | 周三, 工作日]在干嘛",
    assistant: "看天",
  });
  check("前缀：同城模式那种形状也剥掉", lastLine().endsWith("| [米洛] 在干嘛"), true);

  /*
   * 反过来：对方自己发的方括号**绝不能**被吃掉。
   * 漏剥只是这一轮的总结里多一段噪音，错剥是永久改坏了他的原话。
   */
  hooks.recordTurn(cfg, role, { user: "[备注] 记得带伞", assistant: "好" });
  check("前缀：用户自己打的方括号原样留着",
    lastLine().endsWith("| [米洛] [备注] 记得带伞"), true);

  check("前缀：剥这一步不打任何接口", sentBodies.length, 0);
}

// ---- 三道闸全关：一个字都不写 ----
{
  const cfg = hookConfig();
  const role = {
    ...hookRole(cfg),
    name: "HookOff",
    memories: { memory: { enabled: false }, memo: { enabled: false }, diary: { enabled: false } },
  };
  check("挂点：三闸全关时 recordTurn 返回 null",
    hooks.recordTurn(cfg, role, { user: "a", assistant: "b" }), null);
  checkThat("挂点：关着的角色磁盘上什么都没建",
    !fs.existsSync(path.join(MEMORY_DIR, "待总结", "记忆", "HookOff.txt")) &&
      !fs.existsSync(path.join(MEMORY_DIR, "日记", "HookOff")));
}

// ---- 单开日记：另两样不记 ----
{
  const cfg = hookConfig();
  const role = {
    ...hookRole(cfg),
    name: "HookDiary",
    memories: { memory: { enabled: false }, memo: { enabled: false }, diary: { enabled: true } },
  };
  hooks.recordTurn(cfg, role, { user: "只写流水", assistant: "好" });
  checkThat("挂点：只开日记时流水有内容", store.readDiaryLog("HookDiary").includes("只写流水"));
  check("挂点：只开日记时不攒待总结记忆", store.readPending("memory", "HookDiary").lines, 0);
}

// ---- runSummaries：轮数没到不打接口 ----
{
  const cfg = hookConfig({ memory: { rounds: 5 }, memo: { rounds: 5 } });
  fakeLLM("不该被打出来的");
  await hooks.runSummaries(cfg, hookRole(cfg));
  check("挂点：轮数没到（2 < 5）一次接口都不打", sentBodies.length, 0);
  check("挂点：轮数没到时待总结还在", store.readPending("memory", HK).lines, 4);
}

// ---- runSummaries：轮数到了，两条链各跑一次 ----
{
  const cfg = hookConfig({ memory: { rounds: 2 }, memo: { rounds: 2 } });
  fakeLLM("这是总结出来的内容。");
  await hooks.runSummaries(cfg, hookRole(cfg));
  check("挂点：记忆总结成功后待总结清空", store.readPending("memory", HK).lines, 0);
  check("挂点：备忘录总结成功后待总结清空", store.readPending("memo", HK).lines, 0);
  check("挂点：新增了一条记忆", store.readMemories(HK).length, 1);
  checkThat("挂点：备忘录写进去了", store.readMemo(HK).includes("总结出来的内容"));
  checkThat("挂点：日记流水没被这两条链动过（它按定时/手动来）",
    store.readDiaryLog(HK).includes("我刚睡醒"));
}

// ---- runSummaries 失败：只改计数，正文不动 ----
{
  const cfg = hookConfig({ memory: { rounds: 1 }, memo: { rounds: 1 } });
  hooks.recordTurn(cfg, hookRole(cfg), { user: "会失败的一轮", assistant: "嗯" });
  const logBefore = store.readPending("memory", HK).text;
  const memBefore = store.readMemories(HK).length;
  fakeLLM("", { status: 500 });
  await hooks.runSummaries(cfg, hookRole(cfg));
  /*
   * 这里**不能**断言文件字节数不变 —— markFail 就是要把失败计数写进旁边那个
   * state.json 里。要证的是**正文一个字都没动**：流水原样、没被清空、
   * 也没有凭空多出一条记忆。字节级不变的断言在第 14 节
   * （那边直接调 summarizeMemory，压根不经过 markFail）。
   */
  check("挂点：失败后待总结正文一字未动", store.readPending("memory", HK).text, logBefore);
  check("挂点：失败后没有凭空多出一条记忆", store.readMemories(HK).length, memBefore);
  check("挂点：失败计数 +1", store.readPending("memory", HK).fails, 1);
  checkThat("挂点：失败原因存下来了", /500/.test(store.readPending("memory", HK).lastError));
}

// ---- 连续失败到上限：告诉用户一次，然后计数归零 ----
{
  const cfg = hookConfig({ memory: { rounds: 1, maxFails: 2 }, memo: { rounds: 999 } });
  const said = [];
  const notify = async (t) => {
    said.push(t);
  };
  fakeLLM("", { status: 500 });
  // 上面那次已经失败一次了；再攒够一轮，第二次失败就该到上限
  hooks.recordTurn(cfg, hookRole(cfg), { user: "再来一轮", assistant: "嗯" });
  await hooks.runSummaries(cfg, hookRole(cfg), notify);
  check("挂点：连续失败到上限时只发一条说明", said.length, 1);
  checkThat("挂点：说明里点明「一条都没删」", said[0].includes("一条都没删"));
  check("挂点：说过之后计数归零重新数（否则每次失败都刷一条）",
    store.readPending("memory", HK).fails, 0);
  checkThat("挂点：到上限时待总结的内容仍然全在",
    store.readPending("memory", HK).lines >= 4);
}

// ---- 手动记忆：不看轮数 ----
{
  const cfg = hookConfig({ memory: { rounds: 999 } });
  fakeLLM("手动总结出来的记忆。");
  const before = store.readMemories(HK).length;
  const out = await hooks.manualMemory(cfg, hookRole(cfg));
  checkThat("手动记忆：轮数远没到也照样跑（用户自己敲的指令不该被挡）", out.ok === true);
  check("手动记忆：真的多了一条", store.readMemories(HK).length, before + 1);
  check("手动记忆：跑完待总结清空了", store.readPending("memory", HK).lines, 0);
  checkThat("手动记忆：回话里带上了正文", out.text.includes("手动总结出来的记忆"));
}

// ---- 手动记忆：没有待总结时不打接口 ----
{
  const cfg = hookConfig();
  fakeLLM("不该被打出来的");
  const out = await hooks.manualMemory(cfg, hookRole(cfg));
  checkThat("手动记忆：没东西可总结时 ok=false", out.ok === false);
  check("手动记忆：没东西可总结时一次接口都不打", sentBodies.length, 0);
}

// ---- 手动记忆：角色没开那道闸 ----
{
  const cfg = hookConfig();
  const role = { ...hookRole(cfg), memories: { memory: { enabled: false } } };
  fakeLLM("不该被打出来的");
  const out = await hooks.manualMemory(cfg, role);
  checkThat("手动记忆：角色没开记忆时说清去哪儿开", out.text.includes("单独配置 → 记忆库"));
  check("手动记忆：闸关着时不打接口", sentBodies.length, 0);
}

// ---- 手动日记：成功后清流水、擦掉上次的错误 ----
{
  const cfg = hookConfig({ diary: { manual: true } });
  fakeLLM("这是手动写出来的日记正文。");
  const out = await hooks.manualDiary(cfg, hookRole(cfg));
  checkThat("手动日记：成功", out.ok === true);
  check("手动日记：成品落盘了", store.listDiaries(HK).length, 1);
  check("手动日记：成功之后流水才清空", store.readDiaryLog(HK).trim(), "");
  checkThat("手动日记：流水的 .bak 里躺着生成前那几行",
    fs.readFileSync(store.backupPathFor(hkLog()), "utf-8").includes("我刚睡醒"));
  checkThat("手动日记：成功后记下了时间戳、擦掉了 lastError",
    Boolean(store.readDiaryState(HK).lastDiaryAt) && !store.readDiaryState(HK).lastError);
}

// ---- 手动日记：失败不删流水、不推时间戳 ----
{
  const cfg = hookConfig({ diary: { manual: true } });
  hooks.recordTurn(cfg, hookRole(cfg), { user: "这一轮会失败", assistant: "嗯" });
  const before = bytesOf(hkLog());
  const stampBefore = store.readDiaryState(HK).lastDiaryAt;
  const diariesBefore = store.listDiaries(HK).length;
  fakeLLM("", { status: 500 });
  const out = await hooks.manualDiary(cfg, hookRole(cfg));
  checkThat("手动日记：失败时 ok=false 并带上原因", out.ok === false && out.text.includes("500"));
  check("手动日记：**diary_log.txt 一个字节都没少**", bytesOf(hkLog()), before);
  check("手动日记：没有落下一篇残缺的成品", store.listDiaries(HK).length, diariesBefore);
  checkThat("手动日记：失败原因进了 state（界面上要显示）",
    /500/.test(store.readDiaryState(HK).lastError));
  check("手动日记：手点失败**不推时间戳**（那是定时那条路的节流）",
    store.readDiaryState(HK).lastDiaryAt, stampBefore);
}

// ---- 手动日记：手动开关关着 ----
{
  const cfg = hookConfig({ diary: { manual: false } });
  fakeLLM("不该被打出来的");
  const out = await hooks.manualDiary(cfg, hookRole(cfg));
  checkThat("手动日记：开关关着时说清去哪儿开", out.text.includes("记忆库 → 日记"));
  check("手动日记：开关关着时不打接口", sentBodies.length, 0);
}

globalThis.fetch = realFetch;

console.log("\n=== 16. 手改（界面上那三个编辑器写回来的） ===");
const EK = "Edited";

// ---- 待总结：只覆盖正文，进度和 .bak 都不动 ----
{
  store.appendPending("memory", EK, { user: "第一轮", assistant: "嗯" });
  store.appendPending("memo", EK, { user: "备忘录那份", assistant: "好" });
  // 先成功提交一次，造出一份 .bak（= 上次生成用的那批）
  store.commitPending("memory", EK);
  const bakFile = store.backupPathFor(path.join(MEMORY_DIR, "待总结", "记忆", `${EK}.txt`));
  const bakBefore = fs.readFileSync(bakFile, "utf-8");

  store.appendPending("memory", EK, { user: "新的一轮", assistant: "好" });
  store.appendPending("memory", EK, { user: "再一轮", assistant: "好的" });
  store.markFail("memory", EK, "接口 500 了"); // fails=1、lastTry=2

  const after = store.writePendingText(
    "memory",
    EK,
    "2026-09-09 星期三 08:00:00 | [米洛] 改过的第一行\n" +
      `2026-09-09 星期三 08:00:00 | [${EK}] 嗯\n\n\n`
  );
  check("手改待总结：尾部空行收拾干净，只剩两行", after.lines, 2);
  checkThat("手改待总结：正文真的改了", after.text.includes("改过的第一行"));
  check("手改待总结：失败计数保留（那是程序的进度，不是原文）", after.fails, 1);
  check("手改待总结：失败原因保留", after.lastError, "接口 500 了");
  check("手改待总结：轮数按行数折半重算", after.rounds, 1);
  check("手改待总结：lastTry 夹到现在的轮数", after.lastTry, 1);
  check("手改待总结：真的落盘了", store.readPending("memory", EK).lines, 2);
  checkThat("手改待总结：换行是 CRLF（和追加出来的形状一致）",
    store.readPending("memory", EK).text.endsWith("\r\n"));
  check(
    "手改待总结：**.bak 一个字节没动**（那是上次生成用的那批）",
    fs.readFileSync(bakFile, "utf-8"),
    bakBefore
  );
  check("手改待总结：备忘录那份没被牵连", store.readPending("memo", EK).lines, 2);

  // 夹 lastTry 的意义：不夹的话（lastTry=2 > rounds=1）得多攒一轮才会重试
  store.appendPending("memory", EK, { user: "补一轮", assistant: "嗯" });
  check("手改待总结：之后再自动追加不会多出空行", store.readPending("memory", EK).lines, 4);
  check(
    "手改待总结：夹过之后再攒一轮就能重试",
    store.shouldSummarize(store.readPending("memory", EK), 1),
    true
  );
  check("手改待总结：清空也行", store.writePendingText("memory", EK, "").lines, 0);
  check("手改待总结：非法 key 挡掉", store.writePendingText("memory", "../../etc", "x").lines, 0);
}

// ---- 老的 JSON 缓存：搬进流水，一轮都不丢 ----
{
  /*
   * 换成 txt 之前待总结是 `待总结/记忆/<角色>.json`（一个 turns 数组）。
   * 升级之后那份不能就地作废 —— 用户可能正攒着十几轮没总结。
   *
   * 所以 readPending 第一件事就是迁移：逐轮**追加**进流水（不是覆盖 ——
   * 万一新旧两份同时存在，新的那几行也得留着），然后把老文件改名成
   * `.migrated.json` 留档，**不删**。
   */
  const MK = "Legacy";
  const oldFile = path.join(MEMORY_DIR, "待总结", "记忆", `${MK}.json`);
  fs.mkdirSync(path.dirname(oldFile), { recursive: true });

  // 先往新流水里写一行，验证迁移是追加而不是覆盖
  store.appendPending("memory", MK, { user: "换格式之后聊的", assistant: "嗯", userName: "米洛", charName: MK });
  fs.writeFileSync(
    oldFile,
    JSON.stringify({
      turns: [
        { at: "2026-09-01T10:00:00", user: "老缓存里的一轮", assistant: "好" },
        { at: "2026-09-01T11:00:00", user: "老缓存里的两轮", assistant: "好的" },
      ],
      rounds: 2,
      lastTry: 1,
      fails: 1,
      lastError: "升级前那次失败",
    }),
    "utf-8"
  );

  const migrated = store.readPending("memory", MK);
  check("迁移：老的两轮搬进来了（2 轮 × 2 行 + 原有 2 行）", migrated.lines, 6);
  checkThat("迁移：老数据的正文一个字没丢", migrated.text.includes("老缓存里的两轮"));
  checkThat("迁移：新格式那一行还在（追加，不是覆盖）",
    migrated.text.includes("换格式之后聊的"));
  checkThat("迁移：老数据的时间戳照原样用，不盖上今天",
    migrated.text.includes("2026-09-01 星期二 10:00:00 | [对方] 老缓存里的一轮"));
  check("迁移：轮数累加（原有 1 + 老的 2）", migrated.rounds, 3);
  check("迁移：失败计数和原因搬过来了", [migrated.fails, migrated.lastError],
    [1, "升级前那次失败"]);
  checkThat("迁移：老文件改名留档，**没删**",
    !fs.existsSync(oldFile) &&
      fs.existsSync(path.join(MEMORY_DIR, "待总结", "记忆", `${MK}.migrated.json`)));
  check("迁移：再读一次不会重复搬", store.readPending("memory", MK).lines, 6);
}

// ---- 日记流水：整份覆盖，同样不动 .bak ----
{
  store.appendDiaryLine(EK, "2026-09-08 Tuesday 21:00:00 | [米洛] 上一批的一行");
  store.commitDiaryLog(EK); // 造 .bak
  const bak = store.backupPathFor(store.diaryLogPath(EK));
  const bakBefore = fs.readFileSync(bak, "utf-8");

  store.appendDiaryLine(EK, "2026-09-09 Wednesday 08:00:00 | [米洛] 我刚睡醒");
  store.appendDiaryLine(EK, `2026-09-09 Wednesday 08:00:01 | [${EK}] 早`);
  check(
    "手改流水：写成功",
    store.writeDiaryLog(EK, "2026-09-09 Wednesday 08:00:00 | [米洛] 改过的一行\n\n\n"),
    true
  );
  check("手改流水：尾部空行收拾干净，只剩一行", store.readDiaryLog(EK).trim().split(/\r?\n/).length, 1);
  checkThat("手改流水：换行是 CRLF（和追加出来的形状一致）", store.readDiaryLog(EK).endsWith("\r\n"));
  store.appendDiaryLine(EK, "2026-09-09 Wednesday 09:00:00 | [米洛] 手改之后再追加");
  check("手改流水：之后再自动追加不会多出空行", store.readDiaryLog(EK).trim().split(/\r?\n/).length, 2);
  check("手改流水：**.bak 一个字节没动**", fs.readFileSync(bak, "utf-8"), bakBefore);
  check("手改流水：清空也行", store.writeDiaryLog(EK, ""), true);
  check("手改流水：清空之后是空串", store.readDiaryLog(EK), "");
  check("手改流水：非法 key 挡掉", store.writeDiaryLog("../../etc", "x"), false);
}

// ---- 成品日记：只能改已经写成的那几篇 ----
{
  const file = store.writeDiary(EK, "2026-09-09", "原来的正文");
  check("手改日记：写成功", store.writeDiaryFile(EK, file, "改过的正文"), true);
  check("手改日记：正文真的改了", store.readDiary(EK, file), "改过的正文");
  check(
    "手改日记：不存在的那篇拒掉（这是「改」不是「新建」）",
    store.writeDiaryFile(EK, "2026-01-01.md", "凭空造一篇"),
    false
  );
  checkThat(
    "手改日记：被拒的那篇没落在磁盘上",
    !fs.existsSync(path.join(MEMORY_DIR, "日记", EK, "2026-01-01.md"))
  );
  check("手改日记：不合规的文件名拒掉", store.writeDiaryFile(EK, "../../config.json", "x"), false);
  check("手改日记：非法 key 挡掉", store.writeDiaryFile("../../etc", file, "x"), false);
  check("手改日记：改一篇不会多出一篇", store.listDiaries(EK).length, 1);
}

console.log("\n=== 17. 打给上游的请求形状 & 失败退避 ===");

/*
 * 这一节盯的是一个真出过的线上故障：
 *
 *   记忆总结（… gemini-3.1-pro） 返回 400：* ***.contents: contents is not specified
 *
 * 三条链原来只发一条 `role: "system"`，中转站把它翻成 Gemini 的
 * systemInstruction，翻完 contents 一条不剩，请求自己就不成立了。
 * 所以这里断言的是**发出去的消息里必须有 user**。
 */
{
  const cfg = chainConfig();
  const RK = "Shape";
  store.appendPending("memory", RK, { user: "形状检查", assistant: "嗯" });
  store.appendPending("memo", RK, { user: "形状检查", assistant: "嗯" });

  fakeLLM("一条记忆。");
  await chains.summarizeMemory(cfg, chainRole(cfg), RK);
  const memMsgs = sentBodies[0].body.messages;
  check("请求形状：记忆链只发一条消息", memMsgs.length, 1);
  check("请求形状：记忆链那条是 user（不是 system）", memMsgs[0].role, "user");
  checkThat(
    "请求形状：记忆链没有一条 system —— 否则转 Gemini 的中转站会 400",
    !memMsgs.some((m) => m.role === "system")
  );
  checkThat("请求形状：内容一个字没少（顶部还是提示词）",
    memMsgs[0].content.startsWith("<生成记忆提示词>"));

  fakeLLM("1. 一条备忘");
  await chains.summarizeMemo(cfg, chainRole(cfg), RK);
  check("请求形状：备忘录链那条也是 user", sentBodies[0].body.messages[0].role, "user");

  store.appendDiaryLine(RK, "2026-09-09 Wednesday 08:00:00 | [米洛] 我刚睡醒");
  fakeLLM("今天的日记。");
  await chains.generateDiary(cfg, chainRole(cfg), RK, { weather: "" });
  check("请求形状：日记链那条也是 user", sentBodies[0].body.messages[0].role, "user");
}

/*
 * 手点失败之后自动总结不该跟着哑掉。
 *
 * 之前就是这么丢的：手点一次记忆、失败，markFail 把 lastTry 推到当前轮数，
 * 等自动总结跑起来时 shouldSummarize 算不过线，记忆整个被跳过 ——
 * 用户看到的是「备忘录动了，记忆没总结」。
 */
{
  const BK = "Backoff";
  store.appendPending("memory", BK, { user: "一轮", assistant: "嗯" });
  store.appendPending("memory", BK, { user: "两轮", assistant: "嗯" });
  store.appendPending("memory", BK, { user: "三轮", assistant: "嗯" });

  const auto = store.markFail("memory", BK, "自动那次失败了");
  check("退避：自动失败**推** lastTry（否则每条消息都打一次接口）", auto.lastTry, 3);

  store.markFail("memory", BK, "手点那次失败了", { pushTry: false });
  const manual = store.readPending("memory", BK);
  check("退避：手点失败**不推** lastTry", manual.lastTry, 3);
  check("退避：手点失败照样记计数和原因", manual.fails, 2);

  // 把 lastTry 归到 0 再验一遍「手点不占额度」这件事本身
  store.writePendingText("memory", BK, "");
  store.appendPending("memory", BK, { user: "重新一轮", assistant: "嗯" });
  store.appendPending("memory", BK, { user: "重新两轮", assistant: "嗯" });
  store.appendPending("memory", BK, { user: "重新三轮", assistant: "嗯" });
  store.markFail("memory", BK, "手点又失败", { pushTry: false });
  check(
    "退避：手点失败之后，自动总结照样能触发（这就是那个 bug）",
    store.shouldSummarize(store.readPending("memory", BK), 3),
    true
  );
  check(
    "退避：换成自动失败就得再攒满一轮",
    store.shouldSummarize(store.markFail("memory", BK, "自动失败"), 3),
    false
  );
  checkThat(
    "退避：失败原因留得够长（中转站常把真原因写在很后面）",
    store.markFail("memory", BK, "х".repeat(1800)).lastError.length > 500
  );
}

// ---- 一类失败不影响另一类，且顺序是先记忆后备忘录 ----
{
  const OK2 = "Order";
  const cfg = hookConfig({ memory: { rounds: 1 }, memo: { rounds: 1 } });
  const role = { ...hookRole(cfg), id: "r-ord", name: OK2 };
  hooks.recordTurn(cfg, role, { user: "排序检查", assistant: "嗯" });

  const seen = [];
  fakeLLM((n, body) => {
    // 靠标签认出这是哪条链 —— 两条链的内容顶部各不相同
    const text = body.messages.map((m) => m.content).join("\n");
    seen.push(text.startsWith("<生成记忆提示词>") ? "memory" : "memo");
    return "结果";
  });
  await hooks.runSummaries(cfg, role);
  check("顺序：先记忆、后备忘录（备忘录要注入刚生成的那条记忆）", seen, ["memory", "memo"]);
}

console.log("\n=== 18. 导入脚本的解析器（scripts/import-memories.mjs）===");
/*
 * `parseMemoryFile` 是纯函数、不碰磁盘，所以这里直接喂字符串。
 *
 * import 这个脚本不会跑主流程 —— 它底下拿 `process.argv[1]` 和自己的路径
 * 比过（runDirectly），被 import 时那两个对不上。
 */
const { parseMemoryFile } = await import("../scripts/import-memories.mjs");

{
  // 源文件是**倒序**的（导出时新的在最上面），解析出来必须是正序
  const basic = parseMemoryFile(
    ["<memories>", "2026-09-09 | 第三件事", "2026-09-08 | 第二件事", "2026-02-03 | 第一件事", "</memories>"].join("\n")
  );
  check("解析：倒序的源文件翻成正序（老的在前）", basic.entries.map((e) => e.content), [
    "第一件事",
    "第二件事",
    "第三件事",
  ]);
  check("解析：日期原样带出来", basic.entries.map((e) => e.date), [
    "2026-02-03",
    "2026-09-08",
    "2026-09-09",
  ]);
  check("解析：<memories> 包裹标签不算「漏掉的行」", basic.skipped, []);

  // 同一天好几条时（真文件里最多 11 条），文件内部也是新的在前
  const sameDay = parseMemoryFile("2026-09-09 | 后说的\n2026-09-09 | 先说的");
  check("解析：同一天几条也跟着翻正序", sameDay.entries.map((e) => e.content), [
    "先说的",
    "后说的",
  ]);

  /*
   * 正文**一个字都不许改**。
   *
   * `$` 是气泡分隔、`[无语]` 是表情标记、`【转账】` 是特殊消息 —— 都是原始
   * 记录的一部分。用户钉死过「绝对禁止虚构与{{char}}的互动记录」，那也包括
   * 不许「顺手规整」已有记录。
   */
  const raw = "2026-09-08 | plz do$imagine that[无语]$【转账】$go to bed";
  check(
    "解析：$ / [表情] / 【转账】原样留着",
    parseMemoryFile(raw).entries[0].content,
    "plz do$imagine that[无语]$【转账】$go to bed"
  );
  check(
    "解析：正文里的竖线不当分隔符（只切第一个）",
    parseMemoryFile("2026-09-09 | 他说 a|b 是这样").entries[0].content,
    "他说 a|b 是这样"
  );
  check(
    "解析：日期和竖线两边的空格吃掉，正文首尾也 trim",
    parseMemoryFile("2026-09-09|无空格的写法").entries[0].content,
    "无空格的写法"
  );

  const messy = parseMemoryFile(
    "﻿2026-09-09 | 带 BOM 的第一行\r\n\r\n   \r\n2026-09-08 | 第二行"
  );
  check("解析：BOM 不粘在第一条的日期上", messy.entries.map((e) => e.date), [
    "2026-09-08",
    "2026-09-09",
  ]);
  check("解析：空行和纯空白行直接跳过，不算漏行", messy.skipped, []);

  /*
   * 不合格式的行要**报出来**而不是静默丢掉 —— 少导几条是这个脚本最不该
   * 悄悄发生的事（调用方把 skipped 打在屏幕上）。
   */
  const bad = parseMemoryFile(
    [
      "2026-09-09 | 正常的一条",
      "没有日期的一行",
      "2026-9-9 | 日期少了个零",
      "2026-09-09 |",
      "2026-09-09 | 　",
    ].join("\n")
  );
  check("解析：不合格式的四行都进了 skipped", bad.skipped.length, 4);
  check("解析：正常的那条照样导", bad.entries.map((e) => e.content), ["正常的一条"]);
  checkThat(
    "解析：只有日期没正文的算漏行（不导一条空记忆）",
    bad.skipped.includes("2026-09-09 |")
  );

  check("解析：空字符串不抛，返回空数组", parseMemoryFile("").entries, []);
  check("解析：null 也不抛", parseMemoryFile(null).entries, []);
}

console.log("\n=== 19. 手写一篇日记（POST /api/memories/:key/diary）===");
/*
 * 这一节**真的把后端起一遍**，因为路由体写在 index.js 里、没有单独导出的
 * 处理函数，要验的偏偏是路由自己那几条判断（400 的两种、404、-2 编号）。
 *
 * 几个前提：
 *  - `IMESSAGE_BRIDGE=off` 在文件开头就设了，所以这个进程不连任何真实号码；
 *  - 端口现挑一个空闲的，不能用默认的 8787 —— 用户自己的后端很可能正开着；
 *  - **先把 config.json 写进临时目录**：loadConfig 会顺手跑一次
 *    migrateDataLayout，而 data/config.json 一存在它就立刻返回，
 *    否则它会去项目根找老布局，把用户真实的 config.json 改名搬走。
 */
globalThis.fetch = realFetch; // 上面几节把它换成假的了，这里要打真 HTTP

const MANUAL = "Manual";
// 第 20 节演「搬家」要两个角色：从 Manual 导出、往「搬家」导入。名字是中文，
// memoryKeyFor 会退到 role-<id>，顺带把导出文件名里的中文编码一起验了。
const MOVE_ID = "r-move";
const MOVE = "搬家";
fs.writeFileSync(path.join(TMP, "config.json"), JSON.stringify({ providers: [] }));
fs.mkdirSync(path.join(TMP, "characters"), { recursive: true });
fs.writeFileSync(
  path.join(TMP, "characters", `01-${MANUAL}.json`),
  JSON.stringify({ id: "r-man", name: MANUAL })
);
fs.writeFileSync(
  path.join(TMP, "characters", `02-${MOVE_ID}.json`),
  JSON.stringify({ id: MOVE_ID, name: MOVE })
);

// 手写之前先造出一份日记流水和它的 .bak：手写成功也**不许**动这两个
store.appendDiaryLine(MANUAL, "2026-09-09 星期三 08:00:00 | [米洛] 这几行不该被动");
const manLog = store.diaryLogPath(MANUAL);
fs.copyFileSync(manLog, store.backupPathFor(manLog));
const manLogBefore = fs.readFileSync(manLog, "utf-8");
const manBakBefore = fs.readFileSync(store.backupPathFor(manLog), "utf-8");
const manStateBefore = JSON.stringify(store.readDiaryState(MANUAL));
const diaryDirsBefore = fs.readdirSync(path.join(MEMORY_DIR, "日记")).sort();

{
  const { clearConfigCache } = await import("../server/src/config.js");
  clearConfigCache(); // 刚写进去的角色文件要能被读到

  const net = await import("node:net");
  const port = await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    // 绑 0 让系统挑，拿到号再关掉 —— 之后 express 立刻接上同一个号
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
  process.env.PORT = String(port);
  await import("../server/src/index.js");

  /*
   * `/api/` 现在整片在登录门后面（server/src/auth.js），不带凭据一律 401，
   * 而**光登进去还不够**：还在用默认密码的会话除了改账号密码什么都干不了（403）。
   * 这一节要验的是路由自己那几条判断、不是那道门，所以直接设一组正式凭据，
   * 把签出来的 cookie 挂到下面每个请求上。
   *
   * 落的是临时目录里的 auth.json（URANUS_DATA_DIR 在文件开头就指向 TMP 了），
   * 碰不到用户真的那份。门本身怎么验，见 scripts/test-auth.mjs。
   */
  const auth = await import("../server/src/auth.js");
  const session = auth.changeCredentials({ username: "tester", password: "TestPass1" });
  checkThat("路由：设好凭据、拿到会话（`/api/` 在登录门后面）", session.ok, String(session.error ?? ""));
  const COOKIE = `${auth.COOKIE_NAME}=${encodeURIComponent(session.token ?? "")}`;

  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) {
        up = true;
        break;
      }
    } catch {
      /* 还没监听上，等下一轮 */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  checkThat("路由：后端起来了（起不来下面全没意义）", up);

  const post = async (key, body) => {
    const res = await fetch(`${base}/api/memories/${key}/diary`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: COOKIE },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  const first = await post(MANUAL, { date: "2026-09-09", text: "今天是我自己写的。" });
  check("路由：写成了，文件名是那天的日期", [first.status, first.json?.file], [
    200,
    "2026-09-09.md",
  ]);
  check("路由：正文原样落盘", store.readDiary(MANUAL, "2026-09-09.md"), "今天是我自己写的。");

  // 和生成走的是同一个 writeDiary，所以「同一天不覆盖，改叫 -2」这条也照样成立
  const second = await post(MANUAL, { date: "2026-09-09", text: "同一天又写了一篇。" });
  check("路由：同一天再写一篇 → -2（不覆盖已有的那篇）", second.json?.file, "2026-09-09-2.md");
  check("路由：概览里的篇数跟着涨（界面上那个计数）", second.json?.stats?.diaries, 2);

  const today = store.localDate();
  const noDate = await post(MANUAL, { text: "没填日期。" });
  check("路由：不填日期就用今天", noDate.json?.date, today);
  check("路由：返回的文件名也是今天那篇", noDate.json?.file, `${today}.md`);

  /*
   * 日期不合格式时 writeDiary 自己会退到今天，但那是**默默改掉用户填的东西**。
   * 界面上有日期选择器，能走到这儿的非法值只可能是请求拼错了，直接说清楚。
   */
  const badDate = await post(MANUAL, { date: "2026-9-9", text: "日期少了个零。" });
  check("路由：日期格式不对直接 400（不默默改成今天）", badDate.status, 400);
  checkThat("路由：400 说了原因", /YYYY-MM-DD/.test(badDate.json?.error ?? ""));

  const blank = await post(MANUAL, { date: "2026-09-09", text: "   \n  " });
  check("路由：空正文 400", blank.status, 400);
  check(
    "路由：两次 400 一篇都没落盘",
    store.listDiaries(MANUAL).length,
    3
  );

  const gone = await post("NoSuchRole", { text: "查无此人。" });
  check("路由：没有这个角色 404", gone.status, 404);
  const evil = await post("..%2F..%2Fetc", { text: "穿越。" });
  check("路由：路径穿越的 key 也只是 404", evil.status, 404);
  check(
    "路由：穿越那次没在别处建出目录",
    fs.readdirSync(path.join(MEMORY_DIR, "日记")).sort(),
    diaryDirsBefore
  );

  /*
   * 手写这条路**只写成品**，另外两样一个字节都不动：
   *  - `diary_log.txt` 是待总结的流水，用户钉死过「只有成功生成日记才清空」，
   *    手写不是生成，没消耗掉这批流水；
   *  - `lastDiaryAt` 是定时那条路的节流，手写不该顺手把下一次定时推后。
   */
  check("路由：日记流水一个字节没动", fs.readFileSync(manLog, "utf-8"), manLogBefore);
  check(
    "路由：流水的 .bak 也没动",
    fs.readFileSync(store.backupPathFor(manLog), "utf-8"),
    manBakBefore
  );
  check("路由：lastDiaryAt 没被推", JSON.stringify(store.readDiaryState(MANUAL)), manStateBefore);

  /* ================================================================
   * 20. 记忆库搬家：整包导出 / 整包导入 / 纯文本导入 / 向量缺口
   *
   * 全程走真 HTTP，和界面上点按钮走的是同一条路。演的是「从 Manual 导出、
   * 往「搬家」导入」—— 要两个角色才验得出两条要紧的规矩：包里没有的那几块
   * 一个字节不动、本地多出来的日记一篇不删。自己导给自己看不出区别。
   * ================================================================ */
  console.log("\n=== 20. 记忆库搬家（导出 / 导入 / 纯文本 / 向量）===");

  const { dateStamp } = await import("../server/src/transfer.js");
  const MOVE_KEY = store.memoryKeyFor({ id: MOVE_ID, name: MOVE });
  check("搬家：中文名算不出字母 key，退到 role-<id>", MOVE_KEY, `role-${MOVE_ID}`);

  // 这三条要连文件名（Content-Disposition）一起看，所以不能只拿 json
  const grab = async (res) => {
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 不是 JSON 就只看 status 和 text */
    }
    return { status: res.status, cd: res.headers.get("content-disposition") ?? "", text, json };
  };
  const get = async (p) => grab(await fetch(`${base}${p}`, { headers: { cookie: COOKIE } }));
  const send = async (p, body) =>
    grab(
      await fetch(`${base}${p}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: COOKIE },
        body: JSON.stringify(body),
      })
    );

  // 给 Manual 攒点家当再导：两条记忆（头一条已经算过向量）+ 一份待总结
  store.appendMemory(MANUAL, {
    content: "她今天把猫抱来了。",
    keywords: ["猫"],
    embedding: [0.1, 0.2],
  });
  store.appendMemory(MANUAL, { content: "顺路买了豆浆$没加糖" });
  const manPending = store.writePendingText(
    "memory",
    MANUAL,
    "2026-09-09 星期三 08:05:00 | [米洛] 这行还没总结\r\n"
  ).text;

  const bank = await get(`/api/memories/${MANUAL}/export`);
  check(
    "导出：200，信封是记忆库",
    [bank.status, bank.json?.app, bank.json?.kind, bank.json?.version],
    [200, "uranus-imessage", "memorybank", 1]
  );
  check("导出：角色名和 key 都带着", [bank.json?.role, bank.json?.key], [MANUAL, MANUAL]);
  check("导出：三篇成品日记全在包里", bank.json?.diaries?.length, 3);
  check("导出：日记流水原样带走", bank.json?.diaryLog, manLogBefore);
  check("导出：待总结的流水也带走", bank.json?.pending?.memory, manPending);
  check(
    "导出：默认不带向量（算好的那条也置 null）",
    [bank.json?.includesVectors, bank.json?.memories?.[0]?.embedding],
    [false, null]
  );
  // $ 是气泡分隔符，属于原始记录的一部分 —— 导出这一路一个字都不许改
  check("导出：正文里的 $ 原样", bank.json?.memories?.[1]?.content, "顺路买了豆浆$没加糖");

  const withVec = await get(`/api/memories/${MANUAL}/export?vectors=1`);
  check(
    "导出：?vectors=1 才带算好的向量",
    [withVec.json?.includesVectors, withVec.json?.memories?.[0]?.embedding],
    [true, [0.1, 0.2]]
  );
  // 1536 个数字缩进一下就是 1536 行，带向量那份必须是压扁的
  checkThat(
    "导出：带向量不缩进、不带才缩进",
    !withVec.text.includes("\n") && bank.text.includes("\n")
  );

  const empty = await get(`/api/memories/${MOVE_KEY}/export`);
  check(
    "导出：空记忆库照样能导（0 条不是错）",
    [empty.status, empty.json?.memories?.length],
    [200, 0]
  );
  checkThat(
    "导出：中文名走 RFC 5987 的 filename*",
    empty.cd.includes(`filename*=UTF-8''${encodeURIComponent("uranus-memorybank-搬家-")}`)
  );
  // 老客户端只认 filename=，中文换成 _ 之后仍是个落得下去的名字
  checkThat(
    "导出：filename= 那份退成纯 ASCII",
    /filename="uranus-memorybank-__-\d{8}-\d{4}\.json"/.test(empty.cd)
  );

  check("导出：没有这个角色 404", (await get("/api/memories/NoSuchRole/export")).status, 404);
  check(
    "导出：路径穿越的 key 也只是 404",
    (await get("/api/memories/..%2F..%2Fetc/export")).status,
    404
  );

  // 「搬家」先放点本地的东西：记忆该被顶掉，那篇本地独有的日记该留着
  store.appendMemory(MOVE_KEY, { content: "这条是本地的，整包导入之后该被顶掉。" });
  store.putDiary(MOVE_KEY, "2026-01-01.md", "本地独有的一篇日记。");
  store.appendDiaryLine(MOVE_KEY, "2026-01-01 星期四 09:00:00 | [本地] 本地的流水");

  const imp = await send(`/api/memories/${MOVE_KEY}/import`, { bundle: bank.json });
  check("导入：200", imp.status, 200);
  check("导入：回执逐块报数", imp.json?.applied, {
    memories: 2,
    memo: true,
    diaries: 3,
    diaryLog: true,
    pending: ["memory", "memo"],
  });
  check(
    "导入：记忆整块换成包里的（本地那条被顶掉）",
    store.readMemories(MOVE_KEY).map((m) => m.content),
    ["她今天把猫抱来了。", "顺路买了豆浆$没加糖"]
  );
  // 覆盖之前必须先备份（用户钉死的规矩 2），导错了还能换回来
  checkThat(
    "导入：旧记忆先备份了一份",
    fs
      .readFileSync(store.backupPathFor(store.memoryItemsPath(MOVE_KEY)), "utf-8")
      .includes("该被顶掉")
  );
  check("导入：日记流水换成包里的", store.readDiaryLog(MOVE_KEY), manLogBefore);
  checkThat(
    "导入：旧流水也备份了一份",
    fs
      .readFileSync(store.backupPathFor(store.diaryLogPath(MOVE_KEY)), "utf-8")
      .includes("本地的流水")
  );
  check("导入：待总结跟着搬过来", store.readPending("memory", MOVE_KEY).text, manPending);
  /*
   * 成品日记是唯一「只加不删」的一块：用户钉死过「生成后的日记默认永远都不会
   * 清空」，导入不能变成删日记的后门。同名的覆盖（重导一次还是一篇），
   * 本地多出来的原样留着。
   */
  check(
    "导入：包里的写进去，本地多出来的那篇留着",
    store
      .listDiaries(MOVE_KEY)
      .map((d) => d.file)
      .sort(),
    ["2026-01-01.md", "2026-09-09-2.md", "2026-09-09.md", `${today}.md`].sort()
  );
  check(
    "导入：本地那篇正文没被动",
    store.readDiary(MOVE_KEY, "2026-01-01.md"),
    "本地独有的一篇日记。"
  );
  check("导入：回执里带上向量缺口", imp.json?.vectors, { total: 2, missing: 2, done: 0 });

  const wrongKind = await send(`/api/memories/${MOVE_KEY}/import`, {
    bundle: { app: "uranus-imessage", kind: "worldbook", version: 1, name: "阿瓦隆设定", book: {} },
  });
  check("导入：拿世界书来导记忆库 → 400", wrongKind.status, 400);
  checkThat("导入：400 说清了拿来的是什么", /世界书/.test(wrongKind.json?.error ?? ""));
  const notOurs = await send(`/api/memories/${MOVE_KEY}/import`, {
    bundle: { kind: "memorybank" },
  });
  check("导入：不是本程序导出的 → 400", notOurs.status, 400);
  checkThat("导入：400 点名是别家的文件", /Uranus/.test(notOurs.json?.error ?? ""));
  check("导入：两次 400 一个字节都没落盘", store.readMemories(MOVE_KEY).length, 2);

  /*
   * 纯文本导入。源文件是倒序的（新的在最上面），包裹标签不算「漏掉的行」，
   * 缺竖线的那行要报出来 —— 静悄悄少导几条比整个失败更糟。
   */
  const txt = [
    "<memories>",
    "2026-03-02 | 她把伞忘在我这儿了。",
    "2026-03-01 | 那天下雨$她说不用送",
    "这一行没有竖线，格式不对",
    "2026-03-01 | 同一天还有一条，文件里在下面",
    "</memories>",
  ].join("\n");

  const txtIn = await send(`/api/memories/${MOVE_KEY}/import-text`, { text: txt });
  check(
    "纯文本：解析 3 条、全是新的、总数 5",
    [
      txtIn.status,
      txtIn.json?.parsed,
      txtIn.json?.added,
      txtIn.json?.duplicates,
      txtIn.json?.total,
    ],
    [200, 3, 3, 0, 5]
  );
  check("纯文本：格式不对的那行报出来", txtIn.json?.skipped, ["这一行没有竖线，格式不对"]);
  check(
    "纯文本：日期区间是翻成正序之后的两头",
    [txtIn.json?.from, txtIn.json?.to],
    ["2026-03-01", "2026-03-02"]
  );

  const after = store.readMemories(MOVE_KEY);
  const byText = (t) => after.find((m) => m.content === t) ?? {};
  const same = byText("同一天还有一条，文件里在下面");
  const rain = byText("那天下雨$她说不用送");
  check(
    "纯文本：是追加不是替换（原来那两条还在最前面）",
    after.slice(0, 2).map((m) => m.content),
    ["她今天把猫抱来了。", "顺路买了豆浆$没加糖"]
  );
  check("纯文本：正文里的 $ 一个字没改", rain.content, "那天下雨$她说不用送");
  check("纯文本：按日期归了档", rain.date, "2026-03-01");
  // 取中午是为了离「近 N 天」那条 cutoff 的两边都远，落 00:00 会在跨日时算错天
  check("纯文本：时间戳落在当天中午", new Date(rain.timestamp ?? 0).getHours(), 12);
  check("纯文本：同一天的第一条正好是中午整", same.timestamp, dateStamp("2026-03-01", 0));
  // 同一天几条要有确定的先后，不然次序只能靠 sort 的稳定性兜着
  check("纯文本：同一天第二条晚一分钟", rain.timestamp - same.timestamp, 60_000);
  checkThat("纯文本：id 一眼能认出是导进来的", /^m-imp-20260301-/.test(rain.id ?? ""));
  // 用户要的就是这个：「需要向量要自己手动触发一次向量」
  checkThat("纯文本：向量一律留 null，不自动算", after.slice(2).every((m) => m.embedding === null));

  const again = await send(`/api/memories/${MOVE_KEY}/import-text`, { text: txt });
  check(
    "纯文本：同一份再导一遍全算重复，不会多出条目",
    [again.json?.added, again.json?.duplicates, again.json?.total],
    [0, 3, 5]
  );

  const blankTxt = await send(`/api/memories/${MOVE_KEY}/import-text`, { text: "  \n \n" });
  check("纯文本：空文件 400", blankTxt.status, 400);
  checkThat("纯文本：400 说了是空的", /文件是空的/.test(blankTxt.json?.error ?? ""));
  const noEntry = await send(`/api/memories/${MOVE_KEY}/import-text`, {
    text: "随便写点什么\n又一行",
  });
  check("纯文本：一条都没解析出来 400", noEntry.status, 400);
  checkThat(
    "纯文本：400 里给了正确格式的样子",
    (noEntry.json?.error ?? "").includes("2026-09-09 |")
  );
  check("纯文本：两次 400 一条都没落盘", store.readMemories(MOVE_KEY).length, 5);

  const gap = await get(`/api/memories/${MOVE_KEY}/vectors`);
  check(
    "向量：缺口是现数出来的",
    [gap.status, gap.json?.total, gap.json?.missing, gap.json?.done],
    [200, 5, 5, 0]
  );
  store.updateMemory(MOVE_KEY, same.id, { embedding: [0, 1] });
  const gap2 = await get(`/api/memories/${MOVE_KEY}/vectors`);
  check(
    "向量：补上一条之后缺口跟着少一条",
    [gap2.json?.total, gap2.json?.missing, gap2.json?.done],
    [5, 4, 1]
  );

  /*
   * 只测「还没选向量模型」这条纯本地的分支。补算成功那条路要打真接口，
   * 想 stub 就得换掉 globalThis.fetch —— 可后端和这个测试跑在同一个进程里，
   * 测试自己发的这些 HTTP 请求走的也是同一个 fetch，换了等于自己把自己打断。
   */
  const noModel = await send(`/api/memories/${MOVE_KEY}/embed`, { limit: 5 });
  check("向量：没选向量模型时 400", noModel.status, 400);
  checkThat("向量：400 指了路去哪儿选", /向量模型/.test(noModel.json?.error ?? ""));
  check(
    "向量：400 之后缺口没变",
    (await get(`/api/memories/${MOVE_KEY}/vectors`)).json?.missing,
    4
  );

  /* ================================================================
   * 21. 单份预设 / 单本世界书的导出导入
   *
   * 和记忆库那边不一样：导入**只解析不落盘**，返回规范化好的一份给前端塞进
   * 草稿，用户点保存才写进去。所以每一条都要顺带确认磁盘上没多出文件来。
   * ================================================================ */
  console.log("\n=== 21. 预设 / 世界书的导出导入 ===");

  const lsSafe = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
  const presetsDir = path.join(TMP, "presets");
  const worldsDir = path.join(TMP, "worlds");
  const presetFilesBefore = lsSafe(presetsDir);
  const worldFilesBefore = lsSafe(worldsDir);

  const pExp = await send("/api/preset/export", {
    preset: {
      id: "p-local",
      name: "日常闲聊",
      entries: [
        { id: "e-1", kind: "custom", name: "语气", role: "system", content: "说话别太正经。" },
      ],
    },
  });
  check(
    "预设：导出的信封和名字",
    [pExp.status, pExp.json?.kind, pExp.json?.name],
    [200, "preset", "日常闲聊"]
  );
  // id 是本地的事，收件那台机器自己重新发一个 —— 带过去只会撞上人家的
  checkThat("预设：包里不带 id", Boolean(pExp.json?.preset) && !("id" in pExp.json.preset));
  checkThat(
    "预设：中文名走 RFC 5987 的 filename*",
    pExp.cd.includes(`filename*=UTF-8''${encodeURIComponent("uranus-preset-日常闲聊-")}`)
  );
  checkThat(
    "预设：filename= 那份退成纯 ASCII",
    /filename="uranus-preset-____-\d{8}-\d{4}\.json"/.test(pExp.cd)
  );

  const pIn = await send("/api/preset/import", { bundle: pExp.json });
  check("预设：导回来 200", pIn.status, 200);
  checkThat("预设：发了个新 id", Boolean(pIn.json?.preset?.id) && pIn.json.preset.id !== "p-local");
  checkThat("预设：名字留着（重名才加「（导入）」）", /^日常闲聊/.test(pIn.json?.preset?.name ?? ""));
  // normalizeEntries 会补齐缺的固定条目，所以按条数断言会错，得挑出自定义那条看
  check(
    "预设：自定义条目的正文原样",
    pIn.json?.preset?.entries?.find((e) => e.kind === "custom")?.content,
    "说话别太正经。"
  );
  check("预设：只解析不落盘（presets/ 没多出文件）", lsSafe(presetsDir), presetFilesBefore);

  const wExp = await send("/api/world/export", {
    book: {
      id: "w-local",
      name: "阿瓦隆设定",
      entries: [{ id: "we-1", name: "王都", keys: ["王都"], content: "王都在湖心。" }],
    },
  });
  check(
    "世界书：导出的信封和名字",
    [wExp.status, wExp.json?.kind, wExp.json?.name],
    [200, "worldbook", "阿瓦隆设定"]
  );
  checkThat("世界书：包里不带 id", Boolean(wExp.json?.book) && !("id" in wExp.json.book));

  const wIn = await send("/api/world/import", { bundle: wExp.json });
  check("世界书：导回来 200", wIn.status, 200);
  checkThat("世界书：发了个新 id", Boolean(wIn.json?.book?.id) && wIn.json.book.id !== "w-local");
  check(
    "世界书：条目的正文和关键词原样",
    [wIn.json?.book?.entries?.[0]?.content, wIn.json?.book?.entries?.[0]?.keys],
    ["王都在湖心。", ["王都"]]
  );
  check("世界书：只解析不落盘（worlds/ 没多出文件）", lsSafe(worldsDir), worldFilesBefore);

  // 选错文件是最常见的手滑，两边都要说清「你给的是什么」
  const memAsPreset = await send("/api/preset/import", { bundle: bank.json });
  check("交叉：拿记忆库导预设 → 400", memAsPreset.status, 400);
  checkThat("交叉：400 点名是记忆库", /记忆库/.test(memAsPreset.json?.error ?? ""));
  const presetAsWorld = await send("/api/world/import", { bundle: pExp.json });
  check("交叉：拿预设导世界书 → 400", presetAsWorld.status, 400);
  checkThat("交叉：400 点名是预设", /预设/.test(presetAsWorld.json?.error ?? ""));
}

console.log(`\n${fail ? "✗" : "✓"} ${pass} 项通过，${fail} 项失败`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
