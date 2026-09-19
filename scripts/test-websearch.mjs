/**
 * 离线自测：联网搜索的三道闸 + 标记解析 + 三个额度 + 截断。
 *
 * 不发真的网络请求 —— 「拼装和截断」那一段临时把 globalThis.fetch 换成一个
 * 返回真实形状 DuckDuckGo 页面的假函数（跑完在 finally 里换回去）。所以
 * Tavily / Brave 那两条路这里只测结构和优先级，没打过真实端点。
 *
 * 跑：node scripts/test-websearch.mjs
 */

import assert from "node:assert/strict";

import { normalizeConfig } from "../server/src/config.js";
import {
  DEFAULT_FORMAT_INTRO,
  FORMAT_CHILD_KINDS,
  FORMAT_CHILD_LEAD,
  LEGACY_FORMAT_INTRO,
  LEGACY_FORMAT_PROMPT,
  defaultFormatChildren,
  formatChildLead,
  makeDefaultPreset,
} from "../server/src/preset.js";
import { buildPrompt } from "../server/src/prompt.js";
import { applyRules } from "../server/src/regex.js";
import {
  LIMITS,
  MAX_QUERIES,
  parseSearchQueries,
  runSearch,
  stripSearchTags,
  stripXmlBlocks,
} from "../server/src/websearch.js";
import { chatCompletion } from "../server/src/llm.js";

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ok  ${name}`);
}

/** 拼一份最小可用配置：一个角色、一份默认预设。 */
function setup(roleOverrides = {}, presetTweak = null) {
  const preset = makeDefaultPreset({ id: "ps-1" });
  if (presetTweak) presetTweak(preset);
  const config = {
    presets: [preset],
    roles: [{ id: "r-1", name: "小柚", description: "人设正文", presetRef: "ps-1", ...roleOverrides }],
  };
  return { config, role: config.roles[0], preset };
}

/** 拼出来的提示词里那段 <消息格式与功能>，没有就返回空串。 */
async function formatSection(config, role) {
  const { messages } = await buildPrompt(config, role, null, [{ role: "user", content: "在吗" }]);
  const all = messages.map((m) => m.content).join("\n\n");
  const at = all.indexOf("<消息格式与功能>");
  if (at < 0) return "";
  return all.slice(at, all.indexOf("</消息格式与功能>") + "</消息格式与功能>".length);
}

console.log("\n[标记解析]");
{
  assert.deepEqual(parseSearchQueries("[搜索:苹果 2026 发布会]"), ["苹果 2026 发布会"]);
  ok("认得半角冒号");

  assert.deepEqual(parseSearchQueries("［搜索：上海 天气］"), ["上海 天气"]);
  ok("认得全角冒号和全角方括号");

  assert.deepEqual(parseSearchQueries("[搜索:a][搜索:A][搜索:b]"), ["a", "b"]);
  ok("按大小写不敏感去重");

  const many = parseSearchQueries("[搜索:1][搜索:2][搜索:3][搜索:4][搜索:5]");
  assert.equal(many.length, MAX_QUERIES);
  ok(`一轮最多 ${MAX_QUERIES} 条`);

  assert.deepEqual(parseSearchQueries("今天天气不错"), []);
  ok("没有标记时返回空数组");

  assert.deepEqual(parseSearchQueries("[搜索:  ]"), []);
  ok("空关键词不算一条");

  const long = parseSearchQueries(`[搜索:${"字".repeat(200)}]`)[0];
  assert.ok(long.length <= 81 && long.endsWith("…"), long.length);
  ok("过长的关键词被截断");

  assert.equal(stripSearchTags("[搜索:天气]"), "");
  assert.equal(stripSearchTags("我查一下[搜索:天气]"), "我查一下");
  ok("stripSearchTags 只剩别的字");
}

console.log("\n[标签里的标记不算数]");
{
  /*
   * 线上踩的：模型在 <thinking> 里复述格式 ——「触发联网搜索的格式是
   * [搜索:关键词]」—— 后端真的去搜了「关键词」这三个字，白打一次上游。
   * 规则统一成：XML 标签包着的内容是模型说给自己听的，不触发任何功能。
   */
  const real = [
    "<thinking>",
    "触发联网搜索的格式是 [搜索:关键词]，单独占一个气泡。",
    "对方在南宁，我在旧金山，就搜旧金山天气吧。",
    "</thinking>",
    "[finire]",
    "[搜索:旧金山天气]",
  ].join("\n");

  assert.deepEqual(parseSearchQueries(real), ["旧金山天气"]);
  ok("思维链里复述的 [搜索:关键词] 不触发（只认标签外面那个）");

  assert.deepEqual(parseSearchQueries("<thinking>要不要[搜索:天气]呢</thinking>"), []);
  ok("整条回复只有标签里有标记 → 一次都不搜");

  // 自定义标签名（预设里用中文标签的很常见）
  assert.deepEqual(parseSearchQueries("<推演>[搜索:甲]</推演>[搜索:乙]"), ["乙"]);
  ok("认自定义标签名，含中文");

  // 带属性的开标签
  assert.deepEqual(parseSearchQueries('<thinking type="x">[搜索:甲]</thinking>'), []);
  ok("开标签带属性也认得出");

  // 闭合标签名不同 → 不成对，不当块处理（别把正文吃掉）
  assert.deepEqual(parseSearchQueries("<a>[搜索:甲]</b>"), ["甲"]);
  ok("标签不成对时不吃正文");

  // 没闭合的 <thinking>：和 sessions.js 一个口径，不动它
  assert.deepEqual(parseSearchQueries("<thinking>[搜索:甲]"), ["甲"]);
  ok("开着没闭合的标签不处理（那种情况本来就没正文可发）");

  // 数学比较不是标签
  assert.equal(stripXmlBlocks("a < 3 和 b > 5"), "a < 3 和 b > 5");
  ok("`a < 3` 这种不会被当成标签");

  // stripSearchTags 不受影响：它管的是「发出去那份」，标签内外都要收掉
  assert.equal(stripSearchTags("<thinking>[搜索:甲]</thinking>x"), "<thinking></thinking>x");
  ok("stripSearchTags 照旧收掉所有标记（含标签里的）");
}

console.log("\n[扒 DuckDuckGo 的那段正则]");
{
  /*
   * 回归测试。真实页面里 class 上挂着好几个名字：
   *   <div class="links_main links_deep result__body">
   * 以前拿 `class="result__body"` 精确匹配，于是 HTTP 200、页面里有 10 条结果、
   * 却一条都扒不出来。这里用真实形状的片段守住。
   */
  const sample = `
    <div class="result results_links web-result">
      <div class="links_main links_deep result__body">
        <h2 class="result__title">
          <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=x">标题一 &amp; 副标题</a>
        </h2>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x"><b>2025</b>年的摘要&quot;引号&quot;</a>
      </div>
    </div>
    <div class="result results_links web-result">
      <div class="links_main links_deep result__body">
        <h2 class="result__title"><a class="result__a" href="#">标题二</a></h2>
        <a class="result__snippet" href="#">摘要二</a>
      </div>
    </div>`;

  const blocks = sample.split(/class="[^"]*\bresult__body\b/).slice(1);
  assert.equal(blocks.length, 2);
  ok("class 上挂着别的名字时照样切得开");

  const titleRe = /class="[^"]*\bresult__a\b[^"]*"[^>]*>([\s\S]*?)<\/a>/;
  const snipRe = /class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/;
  assert.ok(titleRe.exec(blocks[0])[1].includes("标题一"));
  assert.ok(snipRe.exec(blocks[0])[1].includes("年的摘要"));
  ok("标题和摘要都取得到");

  // result__title 里嵌着 result__a，别把外层那个当标题
  assert.ok(!titleRe.exec(blocks[0])[1].includes("<"));
  ok("标题里不含残留标签");
}

console.log("\n[角色那道闸]");
{
  const off = setup();
  const offText = await formatSection(off.config, off.role);
  assert.ok(!offText.includes("联网搜索"), offText);
  ok("角色没开 → 不注入联网搜索");

  // 子条目本身默认就是开的，闸门必须是角色那边说了算
  const child = off.preset.entries.find((e) => e.kind === "format").children
    .find((c) => c.kind === "search");
  assert.equal(child.enabled, true);
  ok("（此时预设里那个子条目确实是开着的）");

  const on = setup({ webSearch: { enabled: true } });
  const onText = await formatSection(on.config, on.role);
  assert.ok(onText.includes("<联网搜索>"), onText);
  assert.ok(onText.includes("[搜索:关键词]"), onText);
  ok("角色开了 → 注入联网搜索");

  // 条目自己关掉：整条跳过，角色开着也没有
  const entryOff = setup({ webSearch: { enabled: true } }, (p) => {
    p.entries.find((e) => e.kind === "format").enabled = false;
  });
  assert.equal(await formatSection(entryOff.config, entryOff.role), "");
  ok("条目关掉 → 角色开着也不注入");

  // 子条目自己关掉：同样没有
  const childOff = setup({ webSearch: { enabled: true } }, (p) => {
    p.entries.find((e) => e.kind === "format").children
      .find((c) => c.kind === "search").enabled = false;
  });
  assert.ok(!(await formatSection(childOff.config, childOff.role)).includes("联网搜索"));
  ok("子条目关掉 → 角色开着也不注入");
}

console.log("\n[语音和图片压着同一道闸]");
{
  /*
   * 这两条的子条目默认是**开着**的（defaultChildEnabled），和联网搜索一样 ——
   * 挡在前面的是角色那道闸。所以「新建一个角色什么都不开 → 提示词里一个字
   * 都不多」这件事，全靠 ROLE_GATED_CHILDREN 那张表；这一节就是守它的。
   */
  const off = setup();
  const offText = await formatSection(off.config, off.role);
  assert.ok(!offText.includes("audio_message"), offText);
  assert.ok(!offText.includes("Generate_Image"), offText);
  ok("角色没开 → 语音和生图都不注入（尽管子条目默认是开的）");

  const children = off.preset.entries.find((e) => e.kind === "format").children;
  assert.equal(children.find((c) => c.kind === "voice").enabled, true);
  assert.equal(children.find((c) => c.kind === "image").enabled, true);
  ok("（此时预设里这两个子条目确实是开着的）");

  const voiceOn = setup({ voiceSend: { enabled: true } });
  const voiceText = await formatSection(voiceOn.config, voiceOn.role);
  assert.ok(voiceText.includes("<audio_message>"), voiceText);
  assert.ok(voiceText.includes("[audio_message:语音内容]"), voiceText);
  assert.ok(!voiceText.includes("Generate_Image"), voiceText);
  ok("只开语音 → 只注入语音那条");

  const imgOn = setup({ imageGen: { enabled: true } });
  const imgText = await formatSection(imgOn.config, imgOn.role);
  assert.ok(imgText.includes("<Generate_Image>"), imgText);
  assert.ok(imgText.includes("[image:"), imgText);
  assert.ok(!imgText.includes("audio_message"), imgText);
  ok("只开生图 → 只注入生图那条");

  // 三道闸里另外两道对这两条同样有效
  const entryOff = setup({ voiceSend: { enabled: true }, imageGen: { enabled: true } }, (p) => {
    p.entries.find((e) => e.kind === "format").enabled = false;
  });
  assert.equal(await formatSection(entryOff.config, entryOff.role), "");
  ok("条目关掉 → 角色开着也不注入");

  const childOff2 = setup({ voiceSend: { enabled: true }, imageGen: { enabled: true } }, (p) => {
    for (const c of p.entries.find((e) => e.kind === "format").children) {
      if (c.kind === "voice" || c.kind === "image") c.enabled = false;
    }
  });
  const childOffText = await formatSection(childOff2.config, childOff2.role);
  assert.ok(!childOffText.includes("audio_message"), childOffText);
  assert.ok(!childOffText.includes("Generate_Image"), childOffText);
  ok("子条目关掉 → 角色开着也不注入");
}

console.log("\n[{{图生图变量}}]");
{
  // 图生图关着：变量展开成空串，不留下占位符也不留下空行
  const noI2i = setup({ imageGen: { enabled: true, img2img: false } });
  const noI2iText = await formatSection(noI2i.config, noI2i.role);
  assert.ok(!noI2iText.includes("{{图生图变量}}"), noI2iText);
  assert.ok(!noI2iText.includes("图生图变量说明"), noI2iText);
  assert.ok(!/\n{3,}/.test(noI2iText), JSON.stringify(noI2iText));
  ok("没开图生图 → {{图生图变量}} 收成空，不留空行");

  // 开了图生图 + 勾了图库里真实存在的条目 → 展开成清单
  const withRefs = setup({ imageGen: { enabled: true, img2img: true, refs: ["小猫"] } });
  withRefs.config.referenceImages = [
    { id: "ri-1", name: "小猫", description: "这是你养的一只小猫" },
    { id: "ri-2", name: "自拍", description: "一张你的自拍" },
  ];
  const refText = await formatSection(withRefs.config, withRefs.role);
  assert.ok(refText.includes("- [小猫]：这是你养的一只小猫"), refText);
  assert.ok(refText.includes("[image:一只胖胖的橘猫"), refText);
  assert.ok(refText.includes("][小猫]"), refText);
  ok("勾中的参考图展开成清单 + 格式示例");

  // 没勾的那张不能出现在清单里 —— 模型会照着写，写了也用不了
  assert.ok(!refText.includes("自拍"), refText);
  ok("没勾的图库条目不进清单");

  // 勾了名字但图库里已经没有这条（改过名 / 删过）→ 当成没开，不给半张清单
  const stale = setup({ imageGen: { enabled: true, img2img: true, refs: ["不存在"] } });
  stale.config.referenceImages = [{ id: "ri-1", name: "小猫", description: "喵" }];
  const staleText = await formatSection(stale.config, stale.role);
  assert.ok(!staleText.includes("图生图变量说明"), staleText);
  assert.ok(staleText.includes("<Generate_Image>"), staleText);
  ok("勾的条目在图库里对不上 → 只剩文生图那段");
}

console.log("\n[引言和领起的话]");
{
  /*
   * 领起的那句话有三版（preset.js:formatChildLead），按这轮真注入了哪几条挑：
   * 全是「单独占一条气泡」的、全是「写在文字里」的（引用/撤回/特效）、两种并存。
   *
   * ⚠️ **引用回复不压角色那道闸**（它是自带的），所以光 setup() 什么都不开
   * 也会注入它一条 —— 要一条都不剩得把子条目自己关掉。
   */
  const none = setup({}, (p) => {
    for (const c of p.entries.find((e) => e.kind === "format").children) c.enabled = false;
  });
  const noneText = await formatSection(none.config, none.role);
  assert.ok(noneText.includes("像真人发消息那样说话"), noneText);
  assert.ok(!noneText.includes("下面这些标记"), noneText);
  ok("一条子条目都不注入时，没有那句没下文的领起话");

  const inlineOnly = setup();
  const inlineText = await formatSection(inlineOnly.config, inlineOnly.role);
  assert.ok(inlineText.includes("<引用回复>"), inlineText);
  assert.ok(inlineText.includes(formatChildLead(["quote"])), inlineText);
  assert.ok(!inlineText.includes(FORMAT_CHILD_LEAD), inlineText);
  ok("只剩写在文字里的标记 → 领起话说「不要单独占气泡」");

  const on = setup({ webSearch: { enabled: true } });
  const onText = await formatSection(on.config, on.role);
  const mixedLead = formatChildLead(["search", "quote"]);
  assert.ok(onText.includes(mixedLead), onText);
  assert.ok(onText.indexOf(mixedLead) < onText.indexOf("<联网搜索>"));
  ok("两种标记并存 → 领起话点名哪几个写在文字里，并补在它们前面");

  // 只剩单独占气泡的那种 → 回到最早那一句
  const blockOnly = setup({ webSearch: { enabled: true } }, (p) => {
    p.entries.find((e) => e.kind === "format").children
      .find((c) => c.kind === "quote").enabled = false;
  });
  const blockText = await formatSection(blockOnly.config, blockOnly.role);
  assert.ok(blockText.includes(FORMAT_CHILD_LEAD), blockText);
  assert.ok(blockText.indexOf(FORMAT_CHILD_LEAD) < blockText.indexOf("<联网搜索>"));
  ok("只剩单独占气泡的标记 → 领起话回到「单独占一条气泡」那一版");

  // 用户把引言清空：只剩标记，不该冒出个空壳
  const noIntro = setup({ webSearch: { enabled: true } }, (p) => {
    p.entries.find((e) => e.kind === "format").content = "";
  });
  const noIntroText = await formatSection(noIntro.config, noIntro.role);
  assert.ok(noIntroText.startsWith("<消息格式与功能>"), noIntroText);
  assert.ok(noIntroText.includes("<联网搜索>"), noIntroText);
  ok("引言清空后照样注入标记");
}

console.log("\n[回应和特效：白名单空着就整条不注入]");
{
  /*
   * 这两条和表情包一样是白名单制：开关开着但一个都没勾 = **整条跳过**
   * （prompt.js:formatBlock）。这正是用户要的省 token —— 苹果自带的 emoji
   * 几百个，全塞进去每轮都在白烧；留个空清单更糟，模型会看见
   * 「你必须从【可用emoji】里选」后面跟一片空白，然后自己编一个。
   */
  const off = setup();
  const offText = await formatSection(off.config, off.role);
  assert.ok(!offText.includes("<tapback>"), offText);
  assert.ok(!offText.includes("<message_effect>"), offText);
  ok("角色没开 → 回应和特效都不注入");

  const emptyList = setup({
    reactSend: { enabled: true, emojis: [] },
    effectSend: { enabled: true, effects: [] },
  });
  const emptyText = await formatSection(emptyList.config, emptyList.role);
  assert.ok(!emptyText.includes("<tapback>"), emptyText);
  assert.ok(!emptyText.includes("<message_effect>"), emptyText);
  ok("开关开着但一个都没勾 → 照样整条不注入（省 token）");

  const picked = setup({
    reactSend: { enabled: true, emojis: ["😂", "❤️", "🥺"] },
    effectSend: { enabled: true, effects: ["heart", "loud"] },
  });
  const pickedText = await formatSection(picked.config, picked.role);
  assert.ok(pickedText.includes("<tapback>"), pickedText);
  assert.ok(pickedText.includes("可用emoji: 😂 ❤️ 🥺"), pickedText);
  assert.ok(!pickedText.includes("{{emoji变量}}"), pickedText);
  ok("勾了几个 emoji → {{emoji变量}} 换成那几个");

  // 特效清单是三段式：英文 key（模型要写的）+ 中文名 + 屏幕/气泡（该不该省着用）
  assert.ok(pickedText.includes("<message_effect>"), pickedText);
  assert.ok(pickedText.includes("可用特效: heart 爱心（屏幕）、loud 大声（气泡）"), pickedText);
  assert.ok(!pickedText.includes("{{特效变量}}"), pickedText);
  ok("勾了几个特效 → 展开成「key 中文名（屏幕/气泡）」的清单");

  // 特效的标记是贴在气泡开头的，领起的话要把它一起点名
  assert.ok(pickedText.includes("[effect:名字]"), pickedText);
  ok("领起的话点名 [effect:名字] 写在文字里，不单独占气泡");

  // 子条目自己关掉：勾满了也不注入（第三道闸）
  const childOff = setup(
    {
      reactSend: { enabled: true, emojis: ["😂"] },
      effectSend: { enabled: true, effects: ["heart"] },
    },
    (p) => {
      for (const c of p.entries.find((e) => e.kind === "format").children) {
        if (c.kind === "react" || c.kind === "effect") c.enabled = false;
      }
    }
  );
  const childOffText = await formatSection(childOff.config, childOff.role);
  assert.ok(!childOffText.includes("<tapback>"), childOffText);
  assert.ok(!childOffText.includes("<message_effect>"), childOffText);
  ok("子条目关掉 → 角色开着、也勾了，照样不注入");
}

console.log("\n[默认值和迁移]");
{
  const fresh = defaultFormatChildren();
  assert.deepEqual(
    fresh.map((c) => [c.kind, c.enabled]),
    FORMAT_CHILD_KINDS.map((k) => [k, true])
  );
  ok(`新建预设：${FORMAT_CHILD_KINDS.length} 条子条目默认全开（各自还压着角色那道闸）`);

  // 老配置一：拆子条目之前那一整段，没改过
  const legacy = normalizeConfig({
    presets: [{ id: "ps-1", entries: [{ kind: "format", content: LEGACY_FORMAT_PROMPT }] }],
  });
  const migrated = legacy.presets[0].entries.find((e) => e.kind === "format");
  assert.equal(migrated.content, DEFAULT_FORMAT_INTRO);
  assert.deepEqual(
    migrated.children.map((c) => [c.kind, c.enabled]),
    FORMAT_CHILD_KINDS.map((k) => [k, true])
  );
  ok("老配置（整段没改过）→ 换成新结构，子条目全开");

  // 老配置二：三行版引言，那句领起的话还在正文里
  const threeLine = normalizeConfig({
    presets: [{
      id: "ps-1",
      entries: [{ kind: "format", content: LEGACY_FORMAT_INTRO, children: defaultFormatChildren() }],
    }],
  });
  const trimmed = threeLine.presets[0].entries.find((e) => e.kind === "format");
  assert.equal(trimmed.content, DEFAULT_FORMAT_INTRO);
  assert.ok(!trimmed.content.includes(FORMAT_CHILD_LEAD));
  ok("老配置（三行引言）→ 收掉重复的那句领起话");

  // 用户改过正文：原样留着，子条目按默认值补齐
  const custom = normalizeConfig({
    presets: [{ id: "ps-1", entries: [{ kind: "format", content: "我自己写的" }] }],
  });
  const kept = custom.presets[0].entries.find((e) => e.kind === "format");
  assert.equal(kept.content, "我自己写的");
  assert.deepEqual(
    kept.children.map((c) => [c.kind, c.enabled]),
    FORMAT_CHILD_KINDS.map((k) => [k, true])
  );
  ok("用户改过正文 → 原文留着，子条目按默认值补齐");

  // 用户之前把这三条各自关掉过：不能被「补默认值」冲掉
  const explicit = normalizeConfig({
    presets: [{
      id: "ps-1",
      entries: [{
        kind: "format",
        content: DEFAULT_FORMAT_INTRO,
        children: [{ kind: "search", enabled: false, content: "x" }],
      }],
    }],
  });
  const respected = explicit.presets[0].entries.find((e) => e.kind === "format");
  assert.equal(respected.children.find((c) => c.kind === "search").enabled, false);
  ok("用户显式关掉的开关不被默认值冲掉");

  // format 条目本身现在默认开着
  const bare = normalizeConfig({ presets: [{ id: "ps-1", entries: [] }] });
  const rebuilt = bare.presets[0].entries.find((e) => e.kind === "format");
  assert.equal(rebuilt.enabled, true);
  ok("format 条目默认开着（否则角色开关点了没反应）");

  // 老配置里关掉的那个 enabled 要原样留着
  const wasOff = normalizeConfig({
    presets: [{ id: "ps-1", entries: [{ kind: "format", enabled: false }] }],
  });
  assert.equal(wasOff.presets[0].entries.find((e) => e.kind === "format").enabled, false);
  ok("老配置里关掉的条目不被默认值掰开");
}

console.log("\n[角色和密钥]");
{
  const cfg = normalizeConfig({ roles: [{ id: "r-1", name: "x" }] });
  assert.deepEqual(cfg.roles[0].webSearch, {
    enabled: false,
    maxQueries: 2,
    maxResults: 2,
    maxChars: 800,
  });
  ok("角色的 webSearch 默认关，额度 2 / 2 / 800");

  const truthy = normalizeConfig({ roles: [{ id: "r-1", webSearch: { enabled: "yes" } }] });
  assert.equal(truthy.roles[0].webSearch.enabled, true);
  ok("webSearch.enabled 归一成布尔");

  assert.deepEqual(normalizeConfig({}).searchApi, {
    tavily: {
      enabled: false,
      key: "",
      fields: { publishedDate: true, title: true, content: true },
      minScore: 0.65,
    },
    brave: { enabled: false, key: "" },
  });
  ok("searchApi 默认结构（Tavily 三个字段全留、相关度下限 0.65）");

  const keys = normalizeConfig({
    searchApi: { tavily: { enabled: true, key: "  k1  " }, brave: { key: "k2" } },
  }).searchApi;
  assert.equal(keys.tavily.key, "k1");
  assert.equal(keys.tavily.enabled, true);
  assert.equal(keys.brave.enabled, false);
  ok("密钥去空格、enabled 各自独立");

  // 老配置里压根没有 fields —— 补默认值，不能变成 undefined
  assert.deepEqual(keys.tavily.fields, { publishedDate: true, title: true, content: true });
  assert.equal(keys.tavily.minScore, 0.65);
  ok("老配置（只有密钥）→ 字段和下限补默认值");

  const picked = normalizeConfig({
    searchApi: { tavily: { fields: { publishedDate: false, content: 0 }, minScore: "0.8" } },
  }).searchApi.tavily;
  assert.deepEqual(picked.fields, { publishedDate: false, title: true, content: false });
  assert.equal(picked.minScore, 0.8);
  ok("显式关掉的字段不被默认值冲掉，字符串数字也认");

  const wild = normalizeConfig({
    searchApi: { tavily: { minScore: 9 } },
  }).searchApi.tavily.minScore;
  assert.equal(wild, 1);
  assert.equal(normalizeConfig({ searchApi: { tavily: { minScore: -1 } } }).searchApi.tavily.minScore, 0);
  ok("相关度下限夹在 0~1");

  // 密钥不能挂在角色上（backup.js 会把 roles 原样拷进备份）
  const leaky = normalizeConfig({
    roles: [{ id: "r-1", webSearch: { enabled: true, key: "sk-secret", tavily: "x" } }],
  });
  assert.deepEqual(Object.keys(leaky.roles[0].webSearch), [
    "enabled",
    "maxQueries",
    "maxResults",
    "maxChars",
  ]);
  ok("角色的 webSearch 只留开关和额度，塞进来的密钥被丢掉");
}

console.log("\n[三个额度]");
{
  const ws = (input) =>
    normalizeConfig({ roles: [{ id: "r-1", webSearch: input }] }).roles[0].webSearch;

  assert.deepEqual(ws({ maxQueries: 4, maxResults: 7, maxChars: 2500 }), {
    enabled: false,
    maxQueries: 4,
    maxResults: 7,
    maxChars: 2500,
  });
  ok("范围内的值原样留着");

  const high = ws({ maxQueries: 99, maxResults: 99, maxChars: 99999 });
  assert.deepEqual([high.maxQueries, high.maxResults, high.maxChars], [5, 10, 4000]);
  ok("超上限夹到上限（5 / 10 / 4000）");

  const low = ws({ maxQueries: 0, maxResults: -3, maxChars: 1 });
  assert.deepEqual([low.maxQueries, low.maxResults, low.maxChars], [1, 1, 200]);
  ok("低于下限夹到下限（1 / 1 / 200）");

  // 老配置里只有 enabled，三个额度得补上默认值而不是 undefined
  const legacyRole = ws({ enabled: true });
  assert.deepEqual(
    [legacyRole.maxQueries, legacyRole.maxResults, legacyRole.maxChars],
    [2, 2, 800]
  );
  ok("老配置（只有 enabled）→ 额度补默认值");

  // 前端输入框里填的是字符串
  const str = ws({ maxQueries: "3", maxResults: "5", maxChars: "1000" });
  assert.deepEqual([str.maxQueries, str.maxResults, str.maxChars], [3, 5, 1000]);
  ok("字符串数字也认");

  // 搜几次这道闸在解析标记时就用上了
  const five = "[搜索:1][搜索:2][搜索:3][搜索:4][搜索:5]";
  assert.equal(parseSearchQueries(five, 1).length, 1);
  assert.equal(parseSearchQueries(five, 4).length, 4);
  ok("parseSearchQueries 认角色配的次数");

  // 传进来的次数本身也要收口 —— 别指望调用方
  assert.equal(parseSearchQueries(five, 99).length, LIMITS.queries.max);
  assert.equal(parseSearchQueries(five, 0).length, LIMITS.queries.min);
  assert.equal(parseSearchQueries(five, undefined).length, LIMITS.queries.def);
  ok("次数超范围/缺省时按 LIMITS 收口");
}

console.log("\n[拼装和截断]");
{
  /*
   * runSearch 只从 config.searchApi 挑数据源，没有注入点能换掉 fetch，
   * 所以这里用一个假的全局 fetch 顶上 —— 返回真实形状的 DuckDuckGo 页面。
   * 测的是「每次几条」和「总字数」这两道闸真的生效。
   */
  const realFetch = globalThis.fetch;
  const block = (i) => `
    <div class="links_main links_deep result__body">
      <h2 class="result__title"><a class="result__a" href="#">标题${i}</a></h2>
      <a class="result__snippet" href="#">${"摘要内容".repeat(30)}${i}</a>
    </div>`;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => Array.from({ length: 10 }, (_, i) => block(i + 1)).join(""),
  });

  try {
    const two = await runSearch(["甲", "乙"], {}, "测试", {
      maxQueries: 2,
      maxResults: 2,
      maxChars: 4000,
    });
    assert.equal(two.hits, 4);
    assert.equal(two.cut, false);
    ok("2 次 × 2 条 = 4 条，没超字数就不截断");

    const one = await runSearch(["甲", "乙"], {}, "测试", {
      maxQueries: 1,
      maxResults: 3,
      maxChars: 4000,
    });
    assert.equal(one.hits, 3);
    assert.ok(one.text.includes("【甲】") && !one.text.includes("【乙】"), one.text);
    ok("次数封顶：第二个关键词压根不搜");

    const tight = await runSearch(["甲", "乙"], {}, "测试", {
      maxQueries: 2,
      maxResults: 2,
      maxChars: 200,
    });
    assert.equal(tight.cut, true);
    assert.ok(tight.text.endsWith("…（结果过长，已截断）"), tight.text);
    // 200 字 + 那句尾巴，不该无限长
    assert.ok(tight.text.length < 220, tight.text.length);
    ok("超字数按 maxChars 硬切，并标记 cut");

    // 单条摘要另有 180 字上限（这个不给调）
    assert.ok(!tight.text.includes("摘要内容".repeat(50)));
    ok("单条摘要仍按 180 字截断");

    // 缺 limits 时走默认值 2 / 2 / 800
    const def = await runSearch(["甲", "乙", "丙"], {}, "测试");
    assert.equal(def.hits, 4);
    assert.ok(def.text.length <= 800 + 12, def.text.length);
    ok("不传 limits 时按 2 / 2 / 800 兜底");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("\n[Tavily 的保留字段和相关度]");
{
  /*
   * 同样拿假 fetch 顶上，这次返回 Tavily 的 JSON 形状。三条结果各自负责一种情况：
   * 高分带日期、低分（该被下限卡掉）、上游连 score 和 published_date 都没给。
   */
  const realFetch = globalThis.fetch;
  const results = [
    {
      title: "标题甲",
      content: "摘要甲",
      score: 0.91,
      published_date: "Tue, 05 Sep 2026 00:00:00 GMT",
    },
    {
      title: "标题乙",
      content: "摘要乙",
      score: 0.4,
      published_date: "Wed, 06 Sep 2026 00:00:00 GMT",
    },
    { title: "标题丙", content: "摘要丙" },
  ];
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ results }) });

  // 过 normalizeConfig 而不是手写 searchApi —— 顺手验一遍规范化那头和这头对得上
  const run = (tavily) =>
    runSearch(
      ["甲"],
      normalizeConfig({ searchApi: { tavily: { enabled: true, key: "k", ...tavily } } })
        .searchApi,
      "测试",
      { maxQueries: 1, maxResults: 3, maxChars: 4000 }
    );

  try {
    const def = await run({});
    assert.equal(def.source, "Tavily");
    assert.ok(def.text.includes("1. (2026-09-05) 标题甲 —— 摘要甲"), def.text);
    ok("默认：日期 + 标题 + 摘要，日期统一成 YYYY-MM-DD");

    assert.equal(def.hits, 2);
    assert.ok(!def.text.includes("标题乙"), def.text);
    ok("相关度低于 0.65 的那条被丢掉");

    // 丙上游没给 score（不算低分，留着）也没给日期（不留空括号），序号跟着往前挪
    assert.ok(def.text.includes("2. 标题丙 —— 摘要丙"), def.text);
    ok("没给分的不算低分，没给日期的不占位");

    const all = await run({ minScore: 0 });
    assert.equal(all.hits, 3);
    ok("下限设成 0 = 不过滤");

    const strict = await run({ minScore: 0.95 });
    assert.equal(strict.hits, 1);
    assert.ok(strict.text.includes("标题丙") && !strict.text.includes("标题甲"), strict.text);
    ok("下限调到 0.95：只剩上游没给分的那条");

    const noDate = await run({ fields: { publishedDate: false } });
    assert.ok(!noDate.text.includes("2026-09-05"), noDate.text);
    assert.ok(noDate.text.includes("1. 标题甲 —— 摘要甲"), noDate.text);
    ok("取消勾日期：行里不带日期");

    const onlyDate = await run({ fields: { title: false, content: false } });
    assert.equal(onlyDate.hits, 1);
    assert.ok(onlyDate.text.includes("1. (2026-09-05)"), onlyDate.text);
    assert.ok(!onlyDate.text.includes("标题甲"), onlyDate.text);
    ok("只勾日期：没日期的那条整条跳过（不留光秃秃一个编号）");

    const none = await run({ fields: { publishedDate: false, title: false, content: false } });
    assert.equal(none.hits, 0);
    assert.ok(none.text.includes("没有搜到结果"), none.text);
    ok("三个字段全关：每条都是空的，等于把搜索关了（日志里会警告一句）");

    // 不经 normalizeConfig 的裸配置（老 data.config.json 直读）也得走默认那套
    const raw = await runSearch(["甲"], { tavily: { enabled: true, key: "k" } }, "测试", {
      maxQueries: 1,
      maxResults: 3,
      maxChars: 4000,
    });
    assert.equal(raw.hits, 2);
    assert.ok(raw.text.includes("(2026-09-05)"), raw.text);
    ok("裸配置（没有 fields/minScore）按 websearch.js 里的兜底常量走");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("\n[标记不过滤，只在发出去那一路上收掉]");
{
  /*
   * 用户明确要求「使用功能的时候不要过滤任何标签」。
   *
   * imessage.js 里现在的顺序是：先跑用户的 toUser 正则，再 stripSearchTags，
   * 而且**只作用在发给对方那份**上 —— reply 本身不动，所以内存历史、落盘存档、
   * 「上下文」面板里看到的都是模型原文（含 [搜索:…] 和 <thinking>）。
   * 这里把那两步照原样重演一遍，守住顺序和「原文不动」这两点。
   */
  // 和内置的「去掉思维链」同一份形状（targets 少了会被 selectRules 滤掉）
  const rules = [
    {
      id: "rx-1",
      name: "去掉思维链",
      enabled: true,
      find: "<(thinking|think)>[\\s\\S]*?</\\1>",
      flags: "gi",
      replace: "",
      targets: ["aiOutput"],
      toUser: true,
      toHistory: true,
    },
  ];
  const reply = "<thinking>推演</thinking>[搜索:伊朗 局势]查到了，最近挺乱的";

  const afterRules = applyRules(reply, rules, { target: "aiOutput", field: "toUser" }).text;
  const forUser = stripSearchTags(afterRules);

  assert.equal(forUser, "查到了，最近挺乱的");
  ok("发给对方的那份：思维链和搜索标记都没了");

  // 存档那一路：原文一个字不动
  assert.ok(reply.includes("[搜索:伊朗 局势]"));
  assert.ok(reply.includes("<thinking>"));
  ok("reply 原文不动（存档和「上下文」面板看得见）");

  // 只写了标记什么都没说 → 收完是空的，调用方走 notifyFailure
  assert.equal(stripSearchTags("[搜索:天气]"), "");
  ok("只有标记时收完为空（这轮不发气泡，会说明原因）");

  // 用户的正则关掉时，标记照样收得掉（两步互不依赖）
  const noRules = stripSearchTags(
    applyRules(reply, [], { target: "aiOutput", field: "toUser" }).text
  );
  assert.ok(!noRules.includes("[搜索:"), noRules);
  assert.ok(noRules.includes("<thinking>"), noRules);
  ok("没有正则规则时，标记仍然收掉、思维链留着（那是正则的活）");
}

console.log("\n[find 里的 {{char}} / {{user}} 也要展开]");
{
  /*
   * 这一段守的是一个真出过的 bug：applyRules 早先只把 vars 喂给 replace，
   * find 原样拿去 new RegExp。于是 `^{{char}}衣着：(.*)$` 这条规则永远匹配不上
   * 模型吐出来的「沈亦衣着：」，而且**一声不响** —— 不报错、不打日志，
   * applied 里也不会出现它，只有那几行原样漏在界面上。线下预设状态栏七行里
   * 有四行就是这么漏的。
   */
  const 行规则 = (label) => ({
    id: `rx-${label}`,
    name: `状态行 ${label}`,
    enabled: true,
    find: `^${label}：\\s*(.*)$`,
    flags: "gm",
    replace: `<row>${label}=$1</row>`,
    targets: ["aiOutput"],
    toUser: true,
    toHistory: false,
  });
  const 原文 = "沈亦衣着：风衣\n你姿势：坐着";
  const vars = { char: "沈亦", user: "你", sep: "\n" };
  const r = applyRules(原文, [行规则("{{char}}衣着"), 行规则("{{user}}姿势")], {
    target: "aiOutput",
    field: "toUser",
    vars,
  });
  assert.equal(r.text, "<row>沈亦衣着=风衣</row>\n<row>你姿势=坐着</row>");
  assert.equal(r.applied.length, 2, `两条都该命中，实际 ${r.applied.join("、")}`);
  ok("find 里的占位符按 vars 展开后再编译，规则真的命中");

  // 名字为空时走 VAR_FALLBACK，和 applyVars 保持一致 —— 模型读到的就是「助手衣着：」
  const 空 = applyRules("助手衣着：风衣", [行规则("{{char}}衣着")], {
    target: "aiOutput",
    field: "toUser",
    vars: { char: "", user: "", sep: "" },
  });
  assert.equal(空.text, "<row>助手衣着=风衣</row>");
  ok("角色名为空时 find 走兜底词，跟 applyVars 一个口径");

  // 名字里带正则元字符不许改变语义：`A.C` 只匹配 `A.C`
  const 元 = applyRules("A.C衣着：风衣\nABC衣着：外套", [行规则("{{char}}衣着")], {
    target: "aiOutput",
    field: "toUser",
    vars: { char: "A.C", user: "你", sep: "" },
  });
  assert.ok(元.text.includes("<row>A.C衣着=风衣</row>"), 元.text);
  assert.ok(元.text.includes("ABC衣着：外套"), "带点的名字把 ABC 那行也吃了，说明没转义");
  ok("名字里的正则元字符被转义，不会误伤别的行");

  // 同一条规则换个角色不许命中上一个角色的缓存
  const 甲 = applyRules("甲衣着：风衣", [行规则("{{char}}衣着")], {
    target: "aiOutput",
    field: "toUser",
    vars: { char: "甲", user: "你", sep: "" },
  });
  const 乙 = applyRules("乙衣着：外套", [行规则("{{char}}衣着")], {
    target: "aiOutput",
    field: "toUser",
    vars: { char: "乙", user: "你", sep: "" },
  });
  assert.equal(甲.text, "<row>甲衣着=风衣</row>");
  assert.equal(乙.text, "<row>乙衣着=外套</row>", "编译缓存把甲的正则给了乙");
  ok("编译缓存按展开后的正则分桶，换角色不串味");
}

console.log("\n[Gemini 3.7 / 3.8 的两条硬规矩]");
{
  /*
   * 假 fetch 拦在 /chat/completions 上，看真正发出去的 body 长什么样 ——
   * 这两条规矩全在 llm.js 的组包那一步，不到上游就能验。
   */
  const real = globalThis.fetch;
  let sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: "好" } }] }), {
      status: 200,
    });
  };

  const ep = (model) => ({ url: "https://api.test/v1", key: "sk-test", model });
  const PARAMS = { temperature: 0.9, topP: 0.8, frequencyPenalty: 0.3, presencePenalty: 0.2 };
  const call = async (model, messages, params = PARAMS) => {
    sent = [];
    await chatCompletion(ep(model), messages, { params, retries: 0 });
    return sent[0].body;
  };

  const 预填 = [
    { role: "system", content: "人设" },
    { role: "user", content: "在吗" },
    { role: "assistant", content: "[incipere]" },
  ];

  try {
    // 3.8：尾部的预填要挪走，并进最后那条 user
    const b38 = await call("逆[Ag1-次-0.02￥]gemini-3.8-flash-high", 预填);
    assert.equal(b38.messages.at(-1).role, "user", JSON.stringify(b38.messages));
    assert.equal(b38.messages.length, 2);
    assert.ok(b38.messages.at(-1).content.includes("在吗"), b38.messages.at(-1).content);
    assert.ok(b38.messages.at(-1).content.includes("[incipere]"), b38.messages.at(-1).content);
    ok("3.8：assistant 尾巴并进最后那条 user，正文不丢");

    // 生成参数一个都不许发
    for (const k of ["temperature", "top_p", "frequency_penalty", "presence_penalty", "top_k"]) {
      assert.equal(k in b38, false, `${k} 还发出去了：${JSON.stringify(b38)}`);
    }
    ok("3.8：温度 / Top P / 两个惩罚项一个都不发");

    // 3.7 同样待遇（连字符、点、下划线三种写法都要认出来）
    for (const name of ["gemini-3.7-pro", "gemini_3.7", "google/gemini-3-7-flash"]) {
      const b = await call(name, 预填);
      assert.equal(b.messages.at(-1).role, "user", name);
      assert.equal("temperature" in b, false, name);
    }
    ok("3.7 的几种写法都认出来了");

    // 上一条不是 user 时另起一条，不许发出两条连着的 user
    const b另起 = await call("gemini-3.8-flash", [
      { role: "user", content: "在吗" },
      { role: "system", content: "补充说明" },
      { role: "assistant", content: "[incipere]" },
    ]);
    assert.deepEqual(
      b另起.messages.map((m) => m.role),
      ["user", "system", "user"]
    );
    ok("前一条不是 user 时预填另起一条 user");

    // 连着几条 assistant 一起收
    const b多条 = await call("gemini-3.8-flash", [
      { role: "user", content: "在吗" },
      { role: "assistant", content: "甲" },
      { role: "assistant", content: "乙" },
    ]);
    assert.equal(b多条.messages.length, 1);
    assert.ok(b多条.messages[0].content.includes("甲"), b多条.messages[0].content);
    assert.ok(b多条.messages[0].content.includes("乙"), b多条.messages[0].content);
    ok("尾部连着几条 assistant 一起挪走");

    // 空预填：整条去掉，不留一条空 user
    const b空 = await call("gemini-3.8-flash", [
      { role: "user", content: "在吗" },
      { role: "assistant", content: "   " },
    ]);
    assert.deepEqual(
      b空.messages.map((m) => m.role),
      ["user"]
    );
    assert.equal(b空.messages[0].content, "在吗");
    ok("空预填整条去掉，不留空 user");

    // 本来就以 user 结尾的不动它
    const 正常 = [
      { role: "system", content: "人设" },
      { role: "user", content: "在吗" },
    ];
    const b正常 = await call("gemini-3.8-flash", 正常);
    assert.deepEqual(b正常.messages, 正常);
    ok("本来就以 user 结尾的数组一个字不改");

    /*
     * 3.1 / 2.5 和别家的模型不受这两条约束 —— 预填在它们身上是正常功能，
     * 预设里那条「卡思维链（预填）」就是给它们写的，绝不能顺手也给挪了。
     */
    for (const name of ["gemini-3.1-pro", "gemini-2.5-flash", "gpt-4o", "claude-opus-4"]) {
      const b = await call(name, 预填);
      assert.equal(b.messages.at(-1).role, "assistant", `${name} 的预填被挪走了`);
      assert.equal(b.temperature, 0.9, name);
      assert.equal(b.top_p, 0.8, name);
      assert.equal(b.frequency_penalty, 0.3, name);
      assert.equal(b.presence_penalty, 0.2, name);
    }
    ok("3.1 / 2.5 / 别家模型：预填留着，生成参数照发");

    // 名字里带 3.78 / 3.70 这种不能被误认成 3.7
    for (const name of ["gemini-3.78-pro", "gemini-3.80"]) {
      const b = await call(name, 预填);
      assert.equal(b.messages.at(-1).role, "assistant", `${name} 被误认成 3.7/3.8`);
    }
    ok("3.78 / 3.80 这类名字不被误认");

    /*
     * 末尾挂着 system 的 assistant 尾巴也要挪走。
     *
     * 上游判的不是「数组以 assistant 结尾」，是「**contents** 以 model turn
     * 结尾」—— system 被提走当 systemInstruction，压根不在 contents 里。所以
     * `[…, assistant, system]` 在我们这边看着好好的，到上游那边最后一个 turn
     * 正是 assistant，照样 400。
     *
     * 这是 IG 那一轮的形状：行动指令挂在最底下当 system，上文从存档恢复、
     * 最后一轮往往是角色说的话。只看字面末尾的话，每条互动任务都必然吃一个
     * 400、出队即丢。
     */
    const b尾system = await call("gemini-3.8-flash", [
      { role: "system", content: "人设" },
      { role: "user", content: "在干嘛" },
      { role: "assistant", content: "刚下班" },
      { role: "system", content: "现在轮到你了" },
    ]);
    assert.deepEqual(
      b尾system.messages.map((m) => m.role),
      ["system", "user", "system"],
      JSON.stringify(b尾system.messages)
    );
    assert.equal(
      b尾system.messages.filter((m) => m.role !== "system").at(-1).role,
      "user",
      JSON.stringify(b尾system.messages)
    );
    // 挪走的正文并进了那条 user，末尾那条 system 原样留着
    assert.ok(b尾system.messages[1].content.includes("刚下班"), b尾system.messages[1].content);
    assert.equal(b尾system.messages.at(-1).content, "现在轮到你了");
    ok("末尾挂 system 时也跳过去找 assistant 尾巴，system 本身留着");

    // 跳过 system 之后真的以 user 结尾，一个字不动
    const 尾system正常 = [
      { role: "user", content: "在干嘛" },
      { role: "system", content: "现在轮到你了" },
    ];
    const b尾system正常 = await call("gemini-3.8-flash", 尾system正常);
    assert.deepEqual(b尾system正常.messages, 尾system正常);
    ok("跳过 system 后以 user 结尾的数组一个字不改");
  } finally {
    globalThis.fetch = real;
  }
}

console.log(`\n${passed} 项全部通过\n`);