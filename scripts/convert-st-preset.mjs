/**
 * 把 SillyTavern 的预设（prompts + prompt_order + extensions.regex_scripts）
 * 转成 Uranus 能直接导入的单件预设文件。
 *
 * 两边的结构差别：
 *
 *  - ST 的条目分两类：`marker: true` 的占位条（人设、世界书、聊天记录这些由
 *    程序填内容）和带正文的普通条。Uranus 也有同一批占位条，但是**固定 kind**，
 *    一种只能有一条（server/src/preset.js:FIXED_KINDS），所以 ST 那边
 *    charDescription + charPersonality 两条要并成一条 `char`。
 *  - 开关在 ST 里存在 prompt_order 上（同一条 prompt 在不同角色下可以开关不同），
 *    Uranus 直接存在条目上，所以按 prompt_order[0] 那一份取。
 *  - **宏一律原样搬**。setvar / getvar / addvar / trim / random / roll /
 *    charIfNotGroup 现在由 server/src/promptvars.js 在拼提示词时真正求值，
 *    所以这里什么都不用改写 —— 以前要把 setvar 剥壳内联、getvar 删掉，那是在
 *    没有变量支持时的权宜之计，结果是把「变量汇编」式预设的骨架拆了：
 *    几百条声明按声明顺序摊平吐出来，而真正定义结构的那几条汇总条目被删。
 *    唯一还丢的是 `{{//注释}}`（作者给自己写的备注，不该发给模型）。
 *  - ST 的正则在 extensions.regex_scripts 里，字段名和作用面都不一样：
 *      placement 1=用户输入 2=AI 输出   → targets
 *      promptOnly=只改发给模型的那份     → toHistory
 *      markdownOnly=只改显示出来的那份   → toUser
 *      findRegex 可能是 `/pat/flags` 也可能是裸正则 → 拆成 find + flags
 *
 * 用法：
 *   node scripts/convert-st-preset.mjs <ST预设.json> [输出.json] [--mode offline|online|call]
 */
import fs from "node:fs";
import path from "node:path";

/* ================= 参数 ================= */

const argv = process.argv.slice(2);
const flags = new Map();
const positional = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith("--")) flags.set(argv[i].slice(2), argv[i + 1]), (i += 1);
  else positional.push(argv[i]);
}
const SRC = positional[0];
if (!SRC) {
  console.error("用法：node scripts/convert-st-preset.mjs <ST预设.json> [输出.json] [--mode offline]");
  process.exit(1);
}
const MODE = ["online", "offline", "call"].includes(flags.get("mode"))
  ? flags.get("mode")
  : "offline";

/* ================= 宏 ================= */

/**
 * 把一段文本里的 `{{宏}}` 按花括号配对切出来 —— 不能用正则，因为 setvar 的
 * 正文里嵌着 {{user}}，非贪婪会截断、贪婪会吃过头。
 *
 * @param {string} text
 * @param {number} from `{{` 的下标
 * @returns {number} 配对的 `}}` 之后的下标；没配上返回 -1
 */
function matchMacroEnd(text, from) {
  let depth = 0;
  for (let i = from; i < text.length - 1; i += 1) {
    if (text[i] === "{" && text[i + 1] === "{") {
      depth += 1;
      i += 1;
    } else if (text[i] === "}" && text[i + 1] === "}") {
      depth -= 1;
      i += 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

const stats = { comment: 0, native: new Map(), unknown: new Map() };

/** Uranus 的 promptvars.js 认得的宏，原样搬过去就能用。 */
const NATIVE = /^(set|add)(global)?var::|^get(global)?var::|^random::|^roll[\s:]|^(trim|char|user|sep|lastUserMessage|charIfNotGroup)$/i;

/**
 * 宏改写。现在只做一件事：丢掉 `{{//注释}}`，其余原样留着。
 * 还是得数括号走一遍 —— 注释宏的正文里可能嵌着别的宏。
 *
 * @param {string} raw
 * @returns {string}
 */
function rewriteMacros(raw) {
  const text = String(raw ?? "");
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "{" && text[i + 1] === "{") {
      const end = matchMacroEnd(text, i);
      if (end < 0) {
        out += text.slice(i); // 没配对的半个宏，原样留着
        break;
      }
      const inner = text.slice(i + 2, end - 2);
      const head = inner.trim();
      i = end;

      // {{//注释}}：作者给自己写的备注，不该发给模型
      if (head.startsWith("//")) {
        stats.comment += 1;
        continue;
      }

      const key = head.split(/[:：\s]/)[0].slice(0, 20);
      if (NATIVE.test(head)) {
        stats.native.set(key, (stats.native.get(key) ?? 0) + 1);
      } else {
        // 不认识的。原样留着 —— 这类预设里有不少压根不是宏的占位字
        // （{{主题色}} 这种），作者就是写给模型看的，吃掉反而丢信息
        stats.unknown.set(key, (stats.unknown.get(key) ?? 0) + 1);
      }
      out += `{{${inner}}}`;
      continue;
    }
    out += text[i];
    i += 1;
  }
  return out;
}

/* ================= 条目 ================= */

/**
 * ST 的 marker 条 → Uranus 的固定 kind。
 *
 * 一对多并成一条：char 那条在 Uranus 里是「角色人设」整块，ST 把它拆成
 * description / personality / scenario 三条。user 同理。
 *
 * 没有对应物的（例句、群聊提示）映成 null = 丢掉：它们在 ST 里也是空壳，
 * 正文由程序填，搬过来只会是一条空条目。
 */
const MARKER_KIND = {
  charDescription: "char",
  charPersonality: "char",
  scenario: "char",
  personaDescription: "user",
  worldInfoBefore: "world",
  worldInfoAfter: "world",
  chatHistory: "context",
  dialogueExamples: null,
  groupNudge: null,
};

const src = JSON.parse(fs.readFileSync(SRC, "utf8"));
if (!Array.isArray(src.prompts) || !Array.isArray(src.prompt_order)) {
  throw new Error("这不像 SillyTavern 的预设：没有 prompts / prompt_order");
}

const byId = new Map(src.prompts.map((p) => [p.identifier, p]));
const order = src.prompt_order[0]?.order ?? [];

const entries = [];
const seenFixed = new Set();
const dropped = [];
let n = 0;

for (const o of order) {
  const p = byId.get(o.identifier);
  if (!p) continue;
  const enabled = Boolean(o.enabled);

  if (p.marker) {
    const kind = MARKER_KIND[p.identifier];
    if (kind === undefined) {
      dropped.push(`${p.name}（不认识的占位条）`);
      continue;
    }
    if (kind === null) {
      dropped.push(`${p.name}（Uranus 里没有对应的占位条）`);
      continue;
    }
    if (seenFixed.has(kind)) continue; // 固定条目一种只能有一条，取排在最前的位置
    seenFixed.add(kind);
    // 固定条目**一律开着**：它们注入的是人设 / 世界书 / 上文本身，
    // 关掉等于模型不知道自己是谁、也看不到聊天记录
    entries.push({ id: `e-${++n}`, kind, enabled: true });
    continue;
  }

  const content = rewriteMacros(p.content ?? "").trim();
  if (!content) {
    dropped.push(`${p.name}（正文是空的）`);
    continue;
  }
  entries.push({
    id: `e-${++n}`,
    kind: "custom",
    enabled, // ST 那边关着的照样搬过来、也照样关着
    name: String(p.name ?? "").trim(),
    role: p.role === "user" || p.role === "assistant" ? p.role : "system",
    content,
  });
}

/*
 * 收尾一条：把用户最后那句话原样再说一遍，钉在整份提示词的最末尾。
 *
 * Uranus 的上文由 `context` 条目注入，位置在中间，后面还压着几十条系统指令 ——
 * 不补这一条的话，模型看到的最后一句话是某条格式要求而不是用户说的话。
 * role 走 user，和前面那堆 system 合并不了，天然独占一条。
 */
entries.push({
  id: `e-${++n}`,
  kind: "custom",
  enabled: true,
  name: "📮用户最后一句|必开",
  role: "user",
  content: "{{lastUserMessage}}",
});

/* ================= 正则 ================= */

/** 楼层号：非负整数，别的（null / 空 / 负数）一律算不限。和 preset.js 同一套规矩。 */
function depthOf(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** `/pat/gmi` → {find, flags}；裸正则 → flags 给 g。 */
function splitRegex(raw) {
  const text = String(raw ?? "");
  const m = /^\/([\s\S]*)\/([dgimsuvy]*)$/.exec(text);
  if (!m) return { find: text, flags: "g" };
  // flags 去重、只留合法的（和 server/src/preset.js:normalizeRegexRules 同一套）
  const flags = [...new Set(m[2].split(""))].filter((f) => "dgimsuvy".includes(f)).join("");
  return { find: m[1], flags: flags.includes("g") ? flags : `${flags}g` };
}

const regex = [];
let rn = 0;
const regexNotes = [];

for (const r of src.extensions?.regex_scripts ?? []) {
  const { find, flags } = splitRegex(r.findRegex);
  if (!find) continue;

  // placement：1 = 用户输入，2 = AI 输出。别的值（3 斜杠命令、5 世界书）Uranus 没有
  const places = Array.isArray(r.placement) ? r.placement : [];
  const targets = [];
  if (places.includes(1)) targets.push("userInput");
  if (places.includes(2)) targets.push("aiOutput");
  if (!targets.length) {
    regexNotes.push(`${r.scriptName}：作用面是 Uranus 没有的（placement ${places.join(",")}），跳过`);
    continue;
  }

  /*
   * ST 的两个「只改哪一份」开关对上 Uranus 的 toUser / toHistory：
   *   promptOnly   只改发给模型的那份 → toHistory
   *   markdownOnly 只改显示出来的那份 → toUser
   * 两个都没勾 = 两份都改。两个都勾在 ST 里是矛盾配置，当成两份都改。
   */
  const both = Boolean(r.promptOnly) === Boolean(r.markdownOnly);
  const toHistory = both || Boolean(r.promptOnly);
  const toUser = both || Boolean(r.markdownOnly);

  regex.push({
    id: `rx-${++rn}`,
    name: String(r.scriptName ?? "").trim(),
    enabled: !r.disabled, // ST 那边关着的照样搬过来、也照样关着
    find,
    flags,
    action: String(r.replaceString ?? "") === "" ? "delete" : "replace",
    replace: String(r.replaceString ?? ""),
    alternatives: [],
    targets,
    toUser,
    toHistory,
    // 楼层范围，Uranus 侧由 preset.js:rulesForDepth 执行。
    // ST 的 null 就是「不限」，和这边同一个含义，直接搬
    minDepth: depthOf(r.minDepth),
    maxDepth: depthOf(r.maxDepth),
  });

  if (Array.isArray(r.trimStrings) && r.trimStrings.length) {
    regexNotes.push(`${r.scriptName}：ST 那边还配了 trimStrings，Uranus 没有这个字段，没搬`);
  }
}

/* ================= 参数 ================= */

const num = (v, d, lo, hi) => {
  const x = Number(v);
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d;
};

const params = {
  temperature: num(src.temperature, 0.7, 0, 2),
  topP: num(src.top_p, 1, 0, 1),
  maxTokens: Math.round(num(src.openai_max_tokens, 0, 0, 200000)),
  frequencyPenalty: num(src.frequency_penalty, 0, -2, 2),
  presencePenalty: num(src.presence_penalty, 0, -2, 2),
};

/* ================= 信封 ================= */

const srcName = path.basename(SRC).replace(/\.json$/i, "");
const bundle = {
  app: "uranus-imessage",
  kind: "preset",
  version: 1,
  exportedAt: new Date().toISOString(),
  name: srcName,
  preset: { name: srcName, mode: MODE, params, entries, regex },
};

const OUT = positional[1] ?? `uranus-preset-${srcName}.json`;
fs.writeFileSync(OUT, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

/* ================= 报告 ================= */

const on = entries.filter((e) => e.enabled).length;
console.log(`条目 ${entries.length} 条（开着 ${on} 条），固定条目 ${[...seenFixed].join(" / ")}`);
console.log(`正则 ${regex.length} 条（开着 ${regex.filter((r) => r.enabled).length} 条）`);
console.log(`参数 温度 ${params.temperature} / top_p ${params.topP} / 上限 ${params.maxTokens}`);
const depthRules = regex.filter((r) => r.minDepth !== null || r.maxDepth !== null);
if (depthRules.length) {
  console.log(`带楼层范围的正则 ${depthRules.length} 条（Uranus 侧按倒数第几楼执行）`);
}
console.log(`注释宏删 ${stats.comment} 个`);
if (stats.native.size) {
  console.log(
    `Uranus 认得、原样搬过去的宏：` +
      [...stats.native]
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `{{${k}}}×${v}`)
        .join("、")
  );
}
if (stats.unknown.size) {
  console.log(
    `不认识、原样留着当占位字发给模型的：` +
      [...stats.unknown].map(([k, v]) => `{{${k}}}×${v}`).join("、")
  );
}
if (dropped.length) {
  console.log(`丢掉 ${dropped.length} 条：`);
  for (const d of dropped) console.log(`  - ${d}`);
}
for (const note of regexNotes) console.log(`  ! ${note}`);
console.log(`→ ${OUT}`);
