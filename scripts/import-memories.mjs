/*
 * 把导出的 `<角色>的记忆.txt` 导进记忆库。
 *
 * 一次性的搬运工具，不是服务的一部分 —— 手里已经有一份别处攒的记忆
 * （`<memories>` 包着、一行一条 `YYYY-MM-DD | 正文`），想让它变成
 * `data/memories/记忆/<角色>.json` 里的条目。
 *
 * 和别的 scripts/test-*.mjs 相反，**这个脚本故意指向真实的 data/**：
 * 它的活儿就是往用户的记忆库里写东西。所以有三条自保规则：
 *
 *  1. 动之前先把 `记忆/<角色>.json` 备份成 `<角色>.bak.json`（和记忆库
 *     自己的备份规则同一个函数），导错了能整份换回来；
 *  2. **按正文去重**：已经在库里的那条不会再进一遍，所以整个脚本可以
 *     反复跑，跑第二遍不会多出条目来；
 *  3. **先把正文全部落盘，再单独跑一遍向量**。向量要打网络，几百条要打
 *     几分钟，中途断网/掐掉的话正文已经在库里了 —— 再跑一次只补 null 的
 *     那些，不会重来。
 *
 * 用法：
 *   node scripts/import-memories.mjs                      扫项目根的 *的记忆.txt
 *   node scripts/import-memories.mjs 阿瑞的记忆.txt      指定文件（角色名从文件名里取）
 *   node scripts/import-memories.mjs a.txt --role 阿瑞  角色名和文件名对不上时显式指定
 *   node scripts/import-memories.mjs --no-vec              只导正文，不算向量
 *   node scripts/import-memories.mjs --dry-run             只解析、只报数，一个字节都不写
 *
 * 为什么默认要算向量：记忆是整个项目里唯一用向量的东西（用户定的
 * 「只有记忆需要使用向量模型」）。没有向量的记忆只能走「近 N 天」那一路，
 * 半年前的那几百条这辈子都不会被检索到 —— 导进来却检索不到，等于没导。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildImportRecords, embedMissing, parseMemoryFile, vectorGap } from "../server/src/transfer.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

/** 文件名 `阿瑞的记忆.txt` → 角色名 `阿瑞`。 */
const NAME_FROM_FILE = /^(.+?)(?:的记忆|_memories|-memories)?\.txt$/i;

/*
 * 解析、去重、发 id、算时间戳、补向量的实现都在 server/src/transfer.js。
 * 界面上的「导入记忆」走的是同一份代码 —— 命令行导和界面上导，结果必须
 * 一模一样，不能有两套各自漂移的实现。
 *
 * 这里把 `parseMemoryFile` 转口出去：scripts/test-memory.mjs 第 18 节
 * 从这个文件 import 它。
 */
export { parseMemoryFile };

/** 命令行参数：`--flag` 和 `--key 值` 都认，剩下的当文件名。 */
function parseArgs(argv) {
  const files = [];
  const opts = { vec: true, dryRun: false, role: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--no-vec") opts.vec = false;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--role") opts.role = String(argv[++i] ?? "");
    else if (a.startsWith("--")) throw new Error(`不认识的参数 ${a}`);
    else files.push(a);
  }
  return { files, opts };
}

/** 没指定文件时：扫项目根，把 `*的记忆.txt` 都算上。 */
function discover() {
  return fs
    .readdirSync(ROOT)
    .filter((f) => /的记忆\.txt$/.test(f))
    .sort()
    .map((f) => path.join(ROOT, f));
}

/**
 * 按角色名找配置里的角色。
 *
 * 找不到就报错退出，**不**凭空造一个记忆库：`memoryKeyFor` 是从角色名派生的，
 * 名字对不上意味着写出去的那份文件谁也读不到（见 memorystore.js 的注释：
 * 角色改名 = 换一份新的记忆库）。
 */
function findRole(config, name) {
  const want = String(name ?? "").trim().toLowerCase();
  const hit = (config.roles ?? []).find((r) => String(r.name ?? "").trim().toLowerCase() === want);
  if (hit) return hit;
  const names = (config.roles ?? []).map((r) => r.name).join("、") || "（一个都没有）";
  throw new Error(`配置里没有叫「${name}」的角色。现有角色：${names}`);
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const { files, opts } = parseArgs(process.argv.slice(2));
  const list = files.length ? files.map((f) => path.resolve(ROOT, f)) : discover();

  if (!list.length) {
    console.log("项目根下没找到 *的记忆.txt。要么把文件放过来，要么直接把路径当参数传进来。");
    return 0;
  }
  if (opts.role && list.length > 1) {
    throw new Error("--role 只能配一个文件用（多个文件各自的角色从文件名里取）");
  }

  // 真正要读配置了才 import。transfer.js 那条链其实已经把 config.js 拉进来了，
  // 所以这不是什么隔离手段 —— 只是别在「参数都没解析对」的时候就去 loadConfig
  const { loadConfig } = await import("../server/src/config.js");
  const store = await import("../server/src/memorystore.js");

  const config = loadConfig();
  let bad = 0;

  for (const file of list) {
    if (!fs.existsSync(file)) {
      console.log(`\n✗ ${path.basename(file)}：文件不存在`);
      bad += 1;
      continue;
    }
    const nameFromFile = NAME_FROM_FILE.exec(path.basename(file))?.[1] ?? "";
    try {
      await importOne(file, opts.role || nameFromFile, { config, store, opts });
    } catch (e) {
      console.log(`\n✗ ${path.basename(file)}：${e?.message ?? e}`);
      bad += 1;
    }
  }
  return bad ? 1 : 0;
}

async function importOne(file, roleName, { config, store, opts }) {
  const role = findRole(config, roleName);
  const key = store.memoryKeyFor(role);

  console.log(`\n=== ${path.basename(file)} → 角色「${role.name}」（记忆库 ${key}）===`);

  const { entries, skipped } = parseMemoryFile(fs.readFileSync(file, "utf-8"));
  console.log(`  解析出 ${entries.length} 条（${entries[0]?.date} … ${entries.at(-1)?.date}）`);
  if (skipped.length) {
    // 报出来而不是静默跳过：少导几条是这个脚本最不该悄悄发生的事
    console.log(`  ⚠️ 有 ${skipped.length} 行不符合「日期 | 正文」的格式，没导：`);
    for (const s of skipped.slice(0, 5)) console.log(`     ${s.slice(0, 80)}`);
    if (skipped.length > 5) console.log(`     …还有 ${skipped.length - 5} 行`);
  }
  if (!entries.length) return;

  const existing = store.readMemories(key);
  console.log(`  库里现有 ${existing.length} 条`);
  const { fresh, duplicates } = buildImportRecords(entries, existing);

  console.log(`  要导 ${fresh.length} 条${duplicates ? `，跳过 ${duplicates} 条已经在库里的` : ""}`);
  if (opts.dryRun) {
    console.log("  --dry-run：到此为止，什么都没写");
    return;
  }
  if (!fresh.length && !opts.vec) return;

  if (fresh.length) {
    backup(store, key);
    // 已有的排前面：它们的 timestamp 未必比导入的这批老，但数组顺序表达的是
    // 「什么时候进的库」，界面上按 timestamp 排序显示，不看数组顺序
    store.writeMemories(key, [...existing, ...fresh]);
    console.log(`  ✅ 正文已落盘，现在共 ${existing.length + fresh.length} 条`);
  }

  if (opts.vec) await runVectors(key, config);
  else console.log("  --no-vec：没算向量（这些条目暂时只能走「近 N 天」那一路）");
}

/** 动之前留一份整份备份。备不成就整个不导 —— 这一步不允许「先试试看」。 */
function backup(store, key) {
  const file = store.memoryItemsPath(key);
  if (!file || !fs.existsSync(file)) return;
  const to = store.backupPathFor(file);
  fs.copyFileSync(file, to);
  console.log(`  已备份 → ${path.basename(to)}`);
}

/**
 * 补向量：实现在 transfer.js 的 `embedMissing`（界面上的「补算向量」按钮
 * 走的是同一个函数），这里只负责把模型解析出来、把进度打到终端。
 *
 * `limit: 0` = 不分批，一口气算完。界面那边要分批是因为一个 HTTP 请求
 * 扛不住几分钟，命令行没这个顾虑。
 */
async function runVectors(key, config) {
  const cfg = config?.memories?.memory ?? {};
  const ref = cfg.embedModel;
  if (!ref?.provider || !ref?.modelId) {
    console.log("  ⚠️ 还没配向量模型（记忆库 → 设置），跳过向量。补的办法：配好之后再跑一次");
    return;
  }

  const { resolveEndpoint } = await import("../server/src/config.js");
  const endpoint = resolveEndpoint(config, ref);
  if (!endpoint) {
    console.log("  ⚠️ 向量模型引用失效了（服务商或模型被删/被关），跳过向量");
    return;
  }

  const gap = vectorGap(key);
  if (!gap.missing) {
    console.log("  向量都齐了，不用补");
    return;
  }
  console.log(`  开始算向量：${gap.missing} 条（${endpoint.label}），一条一次请求，慢慢来…`);

  const r = await embedMissing(key, endpoint, {
    maxInputChars: cfg.maxInputChars ?? 4000,
    limit: 0,
    onProgress: ({ done, total }) => console.log(`    …已算 ${done}/${total}`),
  });

  for (const e of r.errors) console.log(`    ✗ ${e}`);
  if (r.stopped) {
    console.log("    连着 5 条都失败，先停手（剩下的留 null，配好之后再跑一次就接着补）");
  }
  console.log(
    `  ✅ 向量：成功 ${r.done} 条${r.failed ? `，失败 ${r.failed} 条` : ""}` +
      `${r.left ? `，还有 ${r.left} 条没向量（下次再跑会接着补）` : "，全部齐了"}`
  );
}

/* 被 import 时（离线测试拿 parseMemoryFile）不跑主流程。 */
const runDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (runDirectly) {
  try {
    process.exit(await main());
  } catch (e) {
    console.error(`\n✗ ${e?.message ?? e}`);
    process.exit(1);
  }
}