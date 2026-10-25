/**
 * 提示词变量宏：`{{setvar}}` / `{{getvar}}` / `{{trim}}` / `{{random}}` / `{{roll}}`。
 *
 * ── 为什么要有这一层 ──
 *
 * `config.js:applyVars` 是「一个词换一个词」：认 char / user / sep /
 * lastUserMessage 四个，一条条目一条条目地各自替换，**条目之间不共享任何状态**。
 * 那套够用了很久，因为大多数预设就是把人设和规则直接写在条目正文里。
 *
 * 但有一类预设是**变量汇编**式的：上百条条目只负责 `{{setvar::名::正文}}`
 * 往变量里塞字（这些条目本身在提示词里不产出任何文字），最后由少数几条
 * `{{getvar::名}}` 条目把它们按自己的结构拼成真正发出去的提示词。这种预设进
 * Uranus 之前只有两条路，而两条都不对：
 *
 *  - 原样留着 → 模型读到的是几百个字面的 `{{setvar::酒体::…}}`，提示词废掉；
 *  - 转换时把 setvar 剥壳内联、getvar 删掉 → 吐出来的是**声明顺序**的几百段
 *    正文，而真正定义结构的那几条汇总条目被删了，等于把预设的骨架拆了。
 *
 * 所以变量得在**拼提示词的时候**真正求值。
 *
 * ── 生存期：每轮重算，不落盘 ──
 *
 * 一次 `buildPrompt` 开一张空表，按条目顺序跑完就丢。变量不跨轮、不进存档。
 *
 * 这是用户定的，也和这类预设的写法对得上：它们的 `setvar` 全写在预设条目里，
 * 每轮拼提示词时本来就会重新执行一遍，存不存盘结果一样。而不落盘省掉了一整类
 * 麻烦 —— 不用改存档结构、不用写迁移、不会出现「上一轮的脏变量泄到这一轮」，
 * 也不会让用户删了某条条目之后还被一个看不见的旧值拿着。
 *
 * `setglobalvar` / `getglobalvar` 照这个规矩也只活一轮：在 ST 里它们的区别是
 * 「跨聊天」而不是「跨条目」，而这儿压根不存盘，分两张表只是为了别让两个同名
 * 的变量互相串味。
 *
 * ── 为什么不直接塞进 applyVars ──
 *
 * 那个函数是无状态的纯函数，项目里有十几处在调（人设、正则的 find 和 replace、
 * 天气段、卡片、主动消息…）。变量求值是**有状态、有顺序**的，混进去的话任何
 * 一处调用都会莫名其妙地改到共享状态；而且正则那边 `expandFind` 还要求结果可
 * 预测、可缓存。所以单开一层：谁需要变量，谁自己开一个 scope。
 */

import { applyVars } from "./config.js";
import { logWarn } from "./logs.js";

/** 一轮里最多认多少个变量。防的是手滑写出来的死循环把内存吃光。 */
const MAX_VARS = 500;

/** 单个变量值的长度上限。同上，纯粹是兜底。 */
const MAX_VALUE = 200 * 1024;

/** `{{getvar}}` 的展开深度上限：变量值里又引用别的变量时，防自引用死循环。 */
const MAX_DEPTH = 10;

/**
 * 把一段文本里的 `{{宏}}` 按花括号配对切出来。
 *
 * 不能用正则 —— `setvar` 的正文里嵌着 `{{user}}`，非贪婪会在第一个 `}}` 处截断，
 * 贪婪会一直吃到最后一个。必须数括号。
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

/** `1d20` / `2d6` → 摇一次。认不出来的原样返回。 */
function roll(spec) {
  const m = /(\d*)\s*d\s*(\d+)/i.exec(String(spec ?? ""));
  if (!m) return String(spec ?? "");
  // 骰子个数和面数都卡一刀：`{{roll 99999d99999}}` 不该把这一轮卡死
  const times = Math.min(Math.max(Number(m[1] || 1), 1), 100);
  const faces = Math.min(Math.max(Number(m[2]), 1), 1e9);
  let sum = 0;
  for (let i = 0; i < times; i += 1) sum += 1 + Math.floor(Math.random() * faces);
  return String(sum);
}

/**
 * 开一张变量表。
 *
 * 返回的 `fill` 就是原来那个 `fill`（applyVars + trim）的替代品，区别是它**记得**
 * 前面的条目往表里塞过什么。按条目顺序调用，变量才对得上 —— 这跟 ST 那边
 * 「prompt_order 从上往下执行」是同一个语义。
 *
 * @param {{char?: string, user?: string, sep?: string, lastusermessage?: string}} vars
 *        applyVars 那四个名字替换用的值。注意这是**引用**：`buildPrompt` 里
 *        `lastusermessage` 是后补上的，共用同一个对象才能让后面的条目看到。
 */
export function makeVarScope(vars) {
  /** `setvar` / `addvar` 的表。 */
  const local = new Map();
  /** `setglobalvar` 的表。只活一轮，见文件头。 */
  const global = new Map();
  /** 每种警告只报一次，不然一条正文里引用二十个不存在的变量就是二十行日志。 */
  const warned = new Set();

  function warnOnce(key, msg) {
    if (warned.has(key)) return;
    warned.add(key);
    logWarn("提示词变量", msg);
  }

  function store(table, name, value, { append = false } = {}) {
    if (!name) return;
    if (!table.has(name) && table.size >= MAX_VARS) {
      warnOnce(`满:${name}`, `变量超过 ${MAX_VARS} 个，后面的不再记（第一个是「${name}」）`);
      return;
    }
    const prev = append ? String(table.get(name) ?? "") : "";
    const next = prev + value;
    if (next.length > MAX_VALUE) {
      warnOnce(`长:${name}`, `变量「${name}」超过 ${MAX_VALUE} 字符，截断`);
      table.set(name, next.slice(0, MAX_VALUE));
      return;
    }
    table.set(name, next);
  }

  function read(table, name, depth) {
    if (!table.has(name)) {
      // 没定义过**不是**错：预设里常有「这一条开着才有值」的写法，关掉那条
      // 之后引用它的地方就该是空的。报一声是为了让用户能查「我的某一段怎么没了」
      warnOnce(`缺:${name}`, `正文引用了变量「${name}」，但它没有被赋值过，当空串`);
      return "";
    }
    // 变量值里还可能引用别的变量，再求一次值
    return evaluate(String(table.get(name) ?? ""), depth + 1);
  }

  /**
   * 求值主体。左往右单趟扫，碰到宏就地处理 —— 顺序很重要：同一条正文里
   * 先 `setvar` 后 `getvar` 是合法写法，必须按出现顺序算。
   *
   * @param {string} raw
   * @param {number} depth 展开层数，防自引用死循环
   */
  function evaluate(raw, depth = 0) {
    const text = String(raw ?? "");
    if (!text.includes("{{")) return text;
    if (depth > MAX_DEPTH) {
      warnOnce("深", `变量展开超过 ${MAX_DEPTH} 层，可能是变量自己引用了自己，停在这里`);
      return text;
    }

    let out = "";
    let i = 0;
    while (i < text.length) {
      if (text[i] !== "{" || text[i + 1] !== "{") {
        out += text[i];
        i += 1;
        continue;
      }
      const end = matchMacroEnd(text, i);
      if (end < 0) {
        // 没配对的半个宏。原样留着 —— 用户正文里本来就可能有单独的 `{{`
        out += text.slice(i);
        break;
      }
      const inner = text.slice(i + 2, end - 2);
      const head = inner.trim();
      i = end;

      // {{//注释}}：丢掉。ST 里这是作者给自己写的备注，不该发给模型
      if (head.startsWith("//")) continue;

      // {{trim}}：把它两边的空白吃掉。
      // setvar 条目在提示词里不产出文字，但正文里那些换行会留下空行，
      // 预设作者靠这个宏收掉 —— 所以要往回吃已经攒好的空白，再往前跳过后面的
      if (/^trim$/i.test(head)) {
        out = out.replace(/\s+$/, "");
        while (i < text.length && /\s/.test(text[i])) i += 1;
        continue;
      }

      // {{setvar::名::正文}} / {{addvar::名::正文}}：塞进表里，**本身不产出文字**。
      // 第二对冒号偶尔被作者漏写、直接换行接正文（在 ST 里那其实是条坏规则），
      // 所以换行也认作分隔 —— 认不出来的话整条正文会被当成变量名
      const sv = /^(set|add)(global)?var::([^:\n]*?)(?:::|\n)([\s\S]*)$/i.exec(head);
      if (sv) {
        const [, how, isGlobal, name, body] = sv;
        store(isGlobal ? global : local, name.trim(), evaluate(body, depth + 1), {
          append: how.toLowerCase() === "add",
        });
        continue;
      }

      // {{getvar::名}} / {{getglobalvar::名}}
      const gv = /^get(global)?var::([\s\S]*)$/i.exec(head);
      if (gv) {
        out += read(gv[1] ? global : local, gv[2].trim(), depth);
        continue;
      }

      // {{random::甲::乙::丙}}：每轮挑一个。
      // 这里是**每轮都重挑**（不像转换脚本那样定死），所以预设作者要的那种
      // 「每轮换个花样」的效果是真的成立的
      if (/^random::/i.test(head)) {
        const picks = head.slice("random::".length).split("::");
        out += evaluate(picks[Math.floor(Math.random() * picks.length)] ?? "", depth + 1);
        continue;
      }

      // {{roll 1d20}} / {{roll::1d100}}
      if (/^roll[\s:]/i.test(head)) {
        out += roll(head.replace(/^roll[\s:]+/i, ""));
        continue;
      }

      /*
       * char / user / sep / lastUserMessage 交给 applyVars —— 兜底词
       * （VAR_FALLBACK）和「哪几个不兜底」那套规矩只该有一份实现。
       *
       * charIfNotGroup 在 ST 里是「群聊时留空、单聊时给角色名」。Uranus 的线下
       * 剧情和短信都是一对一的，没有群聊这回事，所以等于 char。
       */
      if (/^charifnotgroup$/i.test(head)) {
        out += applyVars("{{char}}", vars);
        continue;
      }
      if (/^(char|user|sep|lastUserMessage)$/i.test(head)) {
        out += applyVars(`{{${head}}}`, vars);
        continue;
      }

      // 剩下的不认识。**原样留着** —— 这类预设里有不少 `{{主题色}}` 这种
      // 压根不是宏的占位字，作者就是写给模型看的，吃掉反而丢信息
      out += `{{${inner}}}`;
    }
    return out;
  }

  return {
    /** 条目正文的填充：变量求值 + 名字替换 + 去掉首尾空白。 */
    fill: (text) => evaluate(text).trim(),
    /** 不 trim 的版本，拼在别的文字中间时用。 */
    expand: (text) => evaluate(text),
    /** 调试用：这一轮攒出来的变量名。 */
    names: () => [...local.keys()],
  };
}
