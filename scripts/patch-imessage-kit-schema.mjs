/**
 * 让本地 Mac 模式能在 macOS 26 以下的系统上跑起来。
 *
 * 背景：`@photon-ai/imessage-kit@3.0.0` 的数据库层只有一套查询（源文件就叫
 * `src/infra/db/macos26.ts`），`MessagesDatabaseReader` 的构造函数里写死
 * `this.queries = macos26Queries`，没有 schema 探测也没有降级分支。
 * 它 SELECT 的列里有一批是 macOS 26 的 chat.db 才加的，在 Sequoia（15.x）、
 * Sonoma（14.x）上那些列不存在，SQLite 直接报：
 *
 *   DatabaseError: Failed to query messages: Query failed: no such column: message.ck_chat_id
 *
 * 这个报错的位置很靠后 —— better-sqlite3 装好了、chat.db 也打开了，
 * 要等真去读消息才炸，所以控制台一路都是正常的，只有角色上线时变「未上线」。
 *
 * 改法：把这些新列换成 `NULL AS <原别名>`。之所以安全，是因为 mapper 那边
 * 读它们全走宽容的 helper —— `flag()` 遇 null 返回 false，`optionalNumber()`
 * / `optionalDate()` / `optionalNonEmptyString()` 遇 null 返回 null；
 * 严格的 `requireNumber` / `requireNonEmptyString` / `requireDate` 只管
 * id、guid、date、service 这几个老列，一个都不在替换名单里。
 *
 * 代价：这些列对应的功能在低版本上本来就没有（预定发送、Off-Grid、
 * 重要提醒、共享活动状态、联系人密钥验证、贴纸 alt 文本）。撤回走
 * `date_retracted`，换成 NULL 之后 kit 里 `detectTahoeRetract` 那条
 * 兜底分支还在，不影响 15.x 本来的行为。
 *
 * 幂等：认得出补过就跳过。原文件备份成 *.bak-<时间戳>。
 * 重装依赖（npm install / npm ci）会冲掉补丁，重跑一次即可。
 *
 * 用法：
 *   node scripts/patch-imessage-kit-schema.mjs          打补丁
 *   node scripts/patch-imessage-kit-schema.mjs --revert  从备份还原
 */
import fs from "node:fs";
import path from "node:path";

/** ESM 和 CJS 两份产物都要补 —— 谁被 require 到取决于加载方式。 */
const TARGETS = [
  "node_modules/@photon-ai/imessage-kit/dist/index.js",
  "node_modules/@photon-ai/imessage-kit/dist/index.cjs",
];

/**
 * macOS 26 才有的列。
 *
 * 判断依据是这些列在 kit 的 MESSAGE_FIELDS / ATTACHMENT_FIELDS 里，而
 * Sequoia 的 chat.db 查不到。`ck_chat_id` 是她那台机器实际报出来的第一个，
 * 其余是同批新增、照样会接着报 —— 一次全换掉，省得一个一个撞。
 *
 * 形状分两种：
 *   "message.foo"            → 替换成 NULL AS foo
 *   "message.foo as bar"     → 替换成 NULL AS bar（保留原别名）
 */
const NEW_COLUMNS = [
  // 她那台机器报出来的那个。CloudKit 的会话关联 ID
  "message.ck_chat_id as ck_chat_id",
  // 撤回 / 恢复（15.x 上撤回靠 detectTahoeRetract 兜底，不受影响）
  "message.date_retracted",
  "message.date_recovered",
  // 联系人密钥验证（iMessage Contact Key Verification 的 DB 落地）
  "message.is_kt_verified",
  // 静默送达、紧急 SOS 之外的「重要提醒」
  "message.was_delivered_quietly",
  "message.is_critical",
  // 卫星 / Off-Grid 收发
  "message.sent_or_received_off_grid",
  // 共享活动（Share via Messages 的状态与方向）
  "message.share_status",
  "message.share_direction",
  // 预定发送（Send Later）
  "message.schedule_type",
  "message.schedule_state",
  // tapback 用的 emoji 本体
  "message.associated_message_emoji",
  // 贴纸 / emoji 图片的无障碍描述
  "attachment.emoji_image_short_description",
  // 儿童安全敏感内容标记
  "attachment.is_commsafety_sensitive",
];

/** 补过的标记。放在文件头，`--revert` 之外也靠它判幂等。 */
const MARK = "/* uranus: macos-pre26 schema patch */";

/** 把 "message.foo as bar" / "message.foo" 变成 `NULL AS <别名>`。 */
function nullField(spec) {
  const m = /^([\w.]+?)(?:\s+as\s+(\w+))?$/i.exec(spec.trim());
  if (!m) throw new Error(`列名形状不认识，没敢动：${spec}`);
  const alias = m[2] ?? m[1].split(".").pop();
  return `NULL AS ${alias}`;
}

function patchOne(file) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    return { file, skipped: `文件不在（依赖没装？）` };
  }

  const src = fs.readFileSync(abs, "utf8");
  if (src.includes(MARK)) {
    return { file, skipped: "已经补过了" };
  }

  let out = src;
  const hit = [];
  const miss = [];

  for (const spec of NEW_COLUMNS) {
    // dist 里是字符串字面量，形如 "message.ck_chat_id as ck_chat_id"
    const needle = `"${spec}"`;
    if (!out.includes(needle)) {
      miss.push(spec);
      continue;
    }
    out = out.split(needle).join(`"${nullField(spec)}"`);
    hit.push(spec);
  }

  if (hit.length === 0) {
    return { file, skipped: `一个列都没匹配上（版本变了？）`, miss };
  }

  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "");
  const bak = `${abs}.bak-${stamp}`;
  fs.writeFileSync(bak, src);
  fs.writeFileSync(abs, `${MARK}\n${out}`);

  return { file, hit, miss, bak: path.basename(bak) };
}

function revertOne(file) {
  const abs = path.resolve(file);
  const dir = path.dirname(abs);
  const base = path.basename(abs);
  if (!fs.existsSync(dir)) return { file, skipped: "目录不在" };

  const baks = fs
    .readdirSync(dir)
    .filter((n) => n.startsWith(`${base}.bak-`))
    .sort();
  if (baks.length === 0) return { file, skipped: "没有备份" };

  // 最早那份才是没被补过的原文 —— 反复补反复还原时后面的备份可能已经带补丁
  const oldest = baks[0];
  fs.writeFileSync(abs, fs.readFileSync(path.join(dir, oldest)));
  return { file, restored: oldest };
}

const revert = process.argv.includes("--revert");
const results = TARGETS.map(revert ? revertOne : patchOne);

console.log(revert ? "还原 imessage-kit\n" : "给 imessage-kit 打低版本 macOS 补丁\n");

let changed = 0;
for (const r of results) {
  if (r.skipped) {
    console.log(`  - ${r.file}\n      跳过：${r.skipped}`);
    if (r.miss?.length) console.log(`      没找到的列：${r.miss.join(", ")}`);
    continue;
  }
  changed += 1;
  if (r.restored) {
    console.log(`  ✓ ${r.file}\n      从 ${r.restored} 还原`);
  } else {
    console.log(`  ✓ ${r.file}\n      换掉 ${r.hit.length} 个列，备份在 ${r.bak}`);
    if (r.miss.length) console.log(`      本来就没有的列：${r.miss.join(", ")}`);
  }
}

if (changed === 0) {
  console.log("\n没有任何改动。");
} else if (revert) {
  console.log("\n还原好了。重启服务生效。");
} else {
  console.log("\n补好了。重启服务（npm start）再看角色是不是「在线」。");
  console.log("注意：重装依赖会冲掉补丁，npm install 之后要再跑一次。");
}
