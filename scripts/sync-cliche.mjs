/**
 * 把服务端的八股文规则同步成客户端那份副本。
 *
 *   node scripts/sync-cliche.mjs          改完 cliche.js 之后跑这个
 *   node scripts/sync-cliche.mjs --check  只检查同不同步，不写（CI / 提交前用）
 *
 * ── 为什么要有这个脚本 ──
 *
 * 那 25 条规则得在两个地方各有一份：
 *
 *  - server/src/cliche.js —— **真正干活的那份**。聊天时消息发出去之前，
 *    规则由服务端的 regex.js 跑。preset.js:defaultRegexRules("offline") 用它。
 *  - client/src/clicherules.js —— 浏览器里那份。用户点「新建线下预设」的那一
 *    瞬间，草稿还在浏览器内存里、还没跟服务端说过话，但 25 条规则必须当场
 *    摆进界面让人看见（用户原话：「不然我都不知道我要怎么开关」）。
 *
 * 客户端没法 import 服务端那个文件 —— 那边是 Node 模块，同目录的邻居用着
 * node:fs 这类浏览器没有的东西。所以只能抄一份。这是仓库里的既定做法，
 * client/src/labels.js 开头写的是同一件事。
 *
 * 抄一份的代价是会分叉，而且是**静默地**分叉：改了服务端忘了改客户端，
 * 没有任何报错，只是新建预设时看到的规则和聊天时真正跑的规则对不上。
 * 写这个脚本的时候两份已经差了一个字符（一个 `，` 被写成了 `,`）。
 *
 * ── 它怎么做的 ──
 *
 * 纯文本搬运：截取 cliche.js 里 `export function clicheRules() {` 到文件末尾
 * 那一段，套上客户端的文件头写出去。**不解析、不执行、不 import** ——
 * 不 import 是因为那样只能拿到规则的「值」，再序列化回来，注释（比如
 * 「rx-r-16 必须在 rx-r-17 之前」）和排版全没了；而那条注释正是这批规则里
 * 最要紧的一句话。搬文本则一字不差。
 *
 * 代价写在生成文件的抬头里：**client/src/clicherules.js 别手改**，改了下次
 * 跑这个脚本会被覆盖。要改规则就改 server/src/cliche.js，然后跑一下。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "server", "src", "cliche.js");
const OUT = path.join(ROOT, "client", "src", "clicherules.js");

/** 从哪一行开始搬。改 cliche.js 的函数名时这里要跟着改。 */
const MARKER = "export function clicheRules() {";

/**
 * 客户端那份的抬头。
 *
 * 第一句就写「自动生成」是给将来的人看的 —— 包括下一个我。有人打开
 * clicherules.js 想加一条规则时，第一眼就该知道改错地方了。
 */
const HEADER = `/**
 * 八股文正则规则 —— 客户端副本。
 *
 * ⚠️ 这个文件是**自动生成的，别手改** —— 改了下次同步会被覆盖。
 *
 *   要改规则：改 server/src/cliche.js，然后跑 \`npm run sync:cliche\`
 *
 * 为什么要有这份副本：浏览器 import 不了服务端模块，而用户点「新建线下
 * 预设」的那一瞬间，草稿还在浏览器内存里、还没跟服务端说过话，25 条规则
 * 却必须当场摆进界面让人看见。保存之后就以服务端那份为准了 ——
 * 这份只撑「新建到保存」这一小段。
 *
 * 生成脚本：scripts/sync-cliche.mjs
 */

`;

function build() {
  const src = fs.readFileSync(SRC, "utf-8");
  let at = src.indexOf(MARKER);
  if (at === -1) {
    // 函数被改名或者被拆了。宁可停下来报错，也不要生成一份空的 ——
    // 那会让「新建线下预设」静默地一条规则都没有
    throw new Error(
      `在 ${path.relative(ROOT, SRC)} 里找不到 \`${MARKER}\`。\n` +
        `函数改名了？那把这个脚本里的 MARKER 一起改掉。`
    );
  }
  /*
   * 往回退到函数头上那段 JSDoc（如果有）——「每条规则有哪些字段」那张表
   * 对客户端这边一样有用，丢掉它等于让副本比原件少一半信息。
   *
   * 认的是「紧挨着函数的那个 /** 块」：中间只隔空白才算，隔了别的代码就不算
   * 它的注释。找不到就从函数本身开始搬，不报错。
   */
  const docEnd = src.lastIndexOf("*/", at);
  if (docEnd !== -1 && !src.slice(docEnd + 2, at).trim()) {
    const docStart = src.lastIndexOf("/**", docEnd);
    if (docStart !== -1) at = docStart;
  }
  // 顺手校验一下搬过来的东西是不是完整的：手写 ID 从 rx-d-1 排到 rx-r-17，
  // 少一条就是截取出错了
  const body = src.slice(at);
  const ids = [...body.matchAll(/^\s+id: "(rx-[dr]-\d+)"/gm)].map((m) => m[1]);
  if (ids.length < 25) {
    throw new Error(`只搬到 ${ids.length} 条规则，预期 25 条。截取范围出问题了。`);
  }
  return { text: HEADER + body, count: ids.length };
}

const { text, count } = build();
const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf-8") : "";
const same = current === text;
const rel = path.relative(ROOT, OUT).replace(/\\/g, "/");

if (process.argv.includes("--check")) {
  if (same) {
    console.log(`✓ ${rel} 是最新的（${count} 条规则）`);
    process.exit(0);
  }
  console.error(`✗ ${rel} 和 server/src/cliche.js 对不上。跑一下 \`npm run sync:cliche\``);
  process.exit(1);
}

if (same) {
  console.log(`✓ ${rel} 本来就是最新的，没改动（${count} 条规则）`);
} else {
  fs.writeFileSync(OUT, text);
  console.log(`✓ 写好了 ${rel}（${count} 条规则）`);
}
