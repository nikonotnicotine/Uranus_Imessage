/**
 * 提示词变量宏（server/src/promptvars.js）和正则的楼层范围
 * （preset.js:rulesForDepth + prompt.js:filterHistory）。
 *
 * 跑法：node scripts/test-promptvars.mjs（或者 npm test 一起跑）
 *
 * 钉住的是「变量汇编式预设」那套玩法：上百条条目只做 setvar 往变量里塞字、
 * 本身不产出文字，最后由几条 getvar 条目按自己的结构拼出真正的提示词。
 * 这类预设进来之前，setvar 要么被原样发给模型、要么被摊平成声明顺序的
 * 几百段正文，两种都是废的。
 *
 * 楼层那一半钉的是「远处的楼层只留摘要」这类省 token 规则：没有楼层概念时
 * 它们会把最新那条的状态栏也一起删掉，界面上那一栏直接空掉。
 */

import { makeVarScope } from "../server/src/promptvars.js";
import { normalizeRegexRules, rulesForDepth } from "../server/src/preset.js";
import { filterHistory } from "../server/src/prompt.js";

let pass = 0;
let fail = 0;

function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${what}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${what}`);
    console.log(`      想要 ${JSON.stringify(want)}`);
    console.log(`      实际 ${JSON.stringify(got)}`);
  }
}

const VARS = { char: "小明", user: "Ken", sep: "$", lastusermessage: "" };
const scope = () => makeVarScope({ ...VARS });

console.log("变量：set / get 的基本盘");
{
  const s = scope();
  // setvar 条目本身不产出文字 —— 这是整套玩法的地基，产出了的话
  // 几百条声明会原样漏进提示词
  check("setvar 条目不产出文字", s.fill("{{setvar::酒体::醇厚}}"), "");
  check("getvar 读得到前一条存的值", s.fill("{{getvar::酒体}}"), "醇厚");
  check("同一条正文里先 set 后 get", scope().fill("{{setvar::a::甲}}{{getvar::a}}"), "甲");
}

console.log("变量：addvar 累加");
{
  const s = scope();
  s.fill("{{setvar::料::一}}");
  s.fill("{{addvar::料::二}}");
  s.fill("{{addvar::料::三}}");
  check("addvar 往后接", s.fill("{{getvar::料}}"), "一二三");
}

console.log("变量：嵌套与名字替换");
{
  const s = scope();
  // setvar 的正文里嵌着 {{user}}，这是最常见的写法。花括号配对必须数对，
  // 非贪婪正则会在第一个 }} 处把值截断
  s.fill("{{setvar::招呼::你好{{user}}}}");
  check("setvar 正文里的 {{user}} 被替换", s.fill("{{getvar::招呼}}"), "你好Ken");
  const s2 = scope();
  s2.fill("{{setvar::内::里头}}");
  s2.fill("{{setvar::外::外加{{getvar::内}}}}");
  check("变量值里引用别的变量", s2.fill("{{getvar::外}}"), "外加里头");
}

console.log("变量：没定义过 / 自引用");
{
  check("没赋值过的变量当空串", scope().fill("[{{getvar::不存在}}]"), "[]");
  const s = scope();
  // 自己引用自己。不拦的话是个死循环，这里要的是「停下来、别崩」
  s.fill("{{setvar::环::{{getvar::环}}圈}}");
  const got = s.fill("{{getvar::环}}");
  check("自引用不死循环（能返回）", typeof got, "string");
}

console.log("变量：trim");
{
  // setvar 条目在提示词里不产出文字，但正文里的换行会留下空行，
  // 预设作者靠 {{trim}} 收掉 —— 要往回吃已攒的空白，也往前跳过后面的
  check("trim 吃掉两边空白", scope().fill("甲\n\n{{trim}}\n\n乙"), "甲乙");
  check("trim 在条目末尾", scope().fill("{{setvar::x::1}}{{trim}}\n\n"), "");
}

console.log("变量：global 和 local 不串味");
{
  const s = scope();
  s.fill("{{setvar::同名::本地}}");
  s.fill("{{setglobalvar::同名::全局}}");
  check("local 读到 local", s.fill("{{getvar::同名}}"), "本地");
  check("global 读到 global", s.fill("{{getglobalvar::同名}}"), "全局");
}

console.log("变量：一轮一张表");
{
  const a = scope();
  a.fill("{{setvar::只在这轮::有}}");
  // 新开一个 scope 就是新的一轮。读不到上一轮的值 = 不会有脏变量泄过来
  check("另一个 scope 读不到", scope().fill("[{{getvar::只在这轮}}]"), "[]");
}

console.log("变量：char / user / 不认识的宏");
{
  check("char 照旧替换", scope().fill("{{char}}和{{user}}"), "小明和Ken");
  check("charIfNotGroup 等于 char", scope().fill("{{charIfNotGroup}}"), "小明");
  // 这类预设里有不少压根不是宏的占位字，作者就是写给模型看的，吃掉反而丢信息
  check("不认识的宏原样留着", scope().fill("{{主题色}}"), "{{主题色}}");
  check("注释宏丢掉", scope().fill("前{{//作者备注}}后"), "前后");
}

console.log("变量：random / roll 认得出来");
{
  const got = scope().fill("{{random::甲::乙::丙}}");
  check("random 挑中其中一个", ["甲", "乙", "丙"].includes(got), true);
  const n = Number(scope().fill("{{roll::1d6}}"));
  check("roll 1d6 落在 1..6", n >= 1 && n <= 6, true);
  const n2 = Number(scope().fill("{{roll 1d20}}"));
  check("roll 空格写法也认", n2 >= 1 && n2 <= 20, true);
}

console.log("楼层：normalizeRegexRules 的字段");
{
  const [r] = normalizeRegexRules([{ find: "x", minDepth: 3, maxDepth: 5 }]);
  check("minDepth/maxDepth 存下来", [r.minDepth, r.maxDepth], [3, 5]);
  const [d] = normalizeRegexRules([{ find: "x" }]);
  // 缺字段 = 不限楼层，老配置原样升级
  check("缺字段是 null（不限）", [d.minDepth, d.maxDepth], [null, null]);
  const [bad] = normalizeRegexRules([{ find: "x", minDepth: -2, maxDepth: 1.5 }]);
  check("负数和小数当不限", [bad.minDepth, bad.maxDepth], [null, null]);
  const [zero] = normalizeRegexRules([{ find: "x", minDepth: 0 }]);
  check("0 是合法楼层", zero.minDepth, 0);
}

console.log("楼层：rulesForDepth 的筛选");
{
  const rules = normalizeRegexRules([
    { name: "全楼", find: "a" },
    { name: "三楼外", find: "b", minDepth: 3 },
    { name: "最近两楼", find: "c", maxDepth: 2 },
  ]);
  const names = (d) => rulesForDepth(rules, d).map((r) => r.name);
  check("第 1 楼", names(1), ["全楼", "最近两楼"]);
  check("第 2 楼", names(2), ["全楼", "最近两楼"]);
  check("第 3 楼", names(3), ["全楼", "三楼外"]);
  check("第 9 楼", names(9), ["全楼", "三楼外"]);
  // 不分楼层的场合（对方刚发来那一句）一律算「管」，按没有这字段时的行为走
  check("depth 为 null 时全给", names(null), ["全楼", "三楼外", "最近两楼"]);
}

console.log("楼层：filterHistory 按倒数第几条算");
{
  const rules = normalizeRegexRules([
    // 「三楼外只留摘要」：把 <状态栏> 整段剥掉，但只对更早的楼层
    { name: "远处剥状态栏", find: "<状态栏>[\\s\\S]*?</状态栏>", action: "delete", minDepth: 3 },
  ]);
  const hist = [
    { role: "assistant", content: "最早<状态栏>旧</状态栏>" }, // 倒数第 3
    { role: "user", content: "插一句" },
    { role: "assistant", content: "中间<状态栏>中</状态栏>" }, // 倒数第 2
    { role: "assistant", content: "最新<状态栏>新</状态栏>" }, // 倒数第 1
  ];
  const out = filterHistory(hist, rules, VARS);
  check("顺序没被打乱", out.length, 4);
  check("倒数第 3 条的状态栏被剥掉", out[0].content, "最早");
  check("user 那条原样", out[1].content, "插一句");
  check("倒数第 2 条留着", out[2].content, "中间<状态栏>中</状态栏>");
  check("倒数第 1 条留着", out[3].content, "最新<状态栏>新</状态栏>");
}

console.log("楼层：只数 assistant");
{
  const rules = normalizeRegexRules([
    { name: "只动第 1 楼", find: "X", action: "delete", maxDepth: 1 },
  ]);
  // 最新那条 assistant 后面还跟着一条 user（对方又说了一句）。
  // 楼层只数 assistant，所以那条 assistant 仍然是「倒数第 1 楼」
  const hist = [
    { role: "assistant", content: "甲X" },
    { role: "user", content: "乙X" },
  ];
  const out = filterHistory(hist, rules, VARS);
  check("assistant 算第 1 楼、X 被删", out[0].content, "甲");
  check("user 那条不跑 aiOutput 规则", out[1].content, "乙X");
}

console.log("\n" + "=".repeat(48));
console.log(`通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
