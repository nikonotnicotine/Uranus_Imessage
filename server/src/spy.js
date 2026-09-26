/**
 * 查岗：让角色看一眼用户此刻的电脑屏幕或手机屏幕。
 *
 * ── 两条腿，两种形态 ──
 *
 *   [查岗实时电脑屏幕]   **拉**：打用户机器上的截图服务，`GET /screenshot` 拿一张 JPEG
 *   [查岗实时手机屏幕]   **推 + 等**：发一封触发邮件，等 iPhone 把截图 POST 回来
 *
 * 电脑那头是现成的本地 Windows 截图程序（astrbot_plugin_screen_monitor_exe），
 * 默认监听 127.0.0.1:6878，换成别的截图服务也不用改代码 —— 只要求一件事：
 * GET 回一张图。
 *
 * 手机那头**不能这么拉**。iOS 上没有能后台常驻监听端口的东西，唯一能被外部
 * 叫醒的入口是快捷指令的自动化，而它只认「收到邮件」「收到信息」这类事件。
 * 所以手机是三步：发触发邮件 → 邮件自动化跑快捷指令截屏 → 图 POST 回服务端。
 * 那一整套在 spyphone.js 里，这边只管调用和等结果。
 *
 * 走邮件不走 iMessage 是用户定的：角色本来就在 iMessage 上和用户聊天，用同一条
 * 线路发触发消息会让 `PHONESPY_TRIGGER` 出现在两人的对话气泡里。邮件是另一个
 * 信道，不打扰聊天。
 *
 * ── 为什么不做成工具调用 ──
 *
 * 用户明确要求「LLM 可使用标签查岗，不要调用工具」。本项目的模型走的是纯文本
 * 补全，标签是全局唯一的约定（media.js / igtags.js / websearch.js 都是这套），
 * function calling 那条路在这儿反而是异类：中转站不一定支持，而且和现有的
 * `[搜索:…]`、`[image:…]` 两种风格并存会让提示词自相矛盾。
 *
 * ── 和 `[搜索:…]` 是同一个形态 ──
 *
 * 模型第一次回复里写了查岗标签 → 真去抓一张图 → 识图 → 把描述接在后面
 * 再问一次模型 → **对方只收到第二次的回复**。整趟往返在 imessage.js:spyRound
 * 里驱动，那个函数刻意照着 searchRound 写，连「中间这一趟不进 history、
 * 不进存档」这条都一样：屏幕内容是只对这一轮有意义的东西，进了存档就要在
 * 后面每一轮里重发一遍过期画面（和天气、搜索结果同一个道理，见 env.js 文件头）。
 *
 * ── 互相兜底 ──
 *
 * 用户要求「手机查岗失败时自动改查电脑，电脑查岗失败时自动查岗手机」。
 * 所以 `runSpy` 失败后会自动倒向另一头，一共四种结局，各有一份提示模板：
 *
 *   1. 直接成功        → `SPY_OK_TEMPLATE`
 *   2. 回退之后成功    → `role.spy.fallbackTemplate`（提示模型「你想看的那个
 *                        没看到，这是另一个」，免得它张口就说错设备）
 *   3. 只看了一头、没成 → `role.spy.bothFailedTemplate`，默认文案是
 *                        `DEFAULT_ONE_FAILED_TEMPLATE`（回退关着，或者另一条腿
 *                        的开关是关的 —— 那时候一个字都不许提另一头）
 *   4. 两头都失败      → 同一栏，默认文案是 `DEFAULT_BOTH_FAILED_TEMPLATE`
 *
 * 回退**只走一次**，不来回弹：两头都不通时第二次注定也不通，多打一轮只是让
 * 用户在那头多等十几秒。
 *
 * ── 还有两个标签，管的是手机**里面** ──
 *
 * 上面那两个只看一眼屏幕。手机上另有十八件事（spyfeatures.js 那张表），
 * 各带一个参数，所以标签也是带参数的：
 *
 *   [查岗手机:支付宝账单]   查看类。和屏幕查岗同一个形态 —— 抓回来 → 识图/读
 *                           数据 → 接在回复后面再问一次模型（imessage.js:spyRound）
 *   [操控手机:锁屏]         操控类。干完了给模型一句「已经照做了」就收尾，
 *                           **不识图**（锁屏之后截图必然是锁屏画面，见 spyrun.js 头）
 *
 * 认标签、挑 pool、驱动那一趟、拼给模型的话都在这个文件（`phoneTargetIn` /
 * `phonePool` / `runPhone`）；真去发邮件等回传在 spyrun.js。两类各查一份自己的
 * pool：查看类只找 `group === "view"` 的，操控类只找其余的 —— 分开是必须的，
 * 不然模型用查岗标签点歌会被匹配上，然后走一条不该走的路。
 *
 * ── 两层开关，不是一个 ──
 *
 * 第一层是五个**组**开关（`spyLegs`）：电脑屏幕、手机屏幕、查看、操控、网易云。
 * 分这么细是因为**代价和外溢程度差了好几个量级** —— 看一眼桌面截图和替用户
 * 打开支付宝账单不是一回事，后者更不是「把他手机锁掉」那回事。
 *
 * 操控类**横跨两个开关**（闹钟锁屏归 control，网易云归 music），所以
 * `phonePool` 要按开关再滤一道：只开放歌的用户写 `[操控手机:锁屏]` 必须匹配
 * 不上，不然那部手机就真的被锁了，而用户从没同意过这件事。
 *
 * 第二层是那十九件事**各自一个开关**（`role.spy.features`，键名是
 * spyfeatures.js 的 key）。同一组里各项的外溢程度也差得远：查看类里「电量」
 * 只回一个数，「微信」是把聊天列表整屏念出来；控制类里「设置闹钟」是帮忙，
 * 「关闭闹钟」能把用户定好的起床闹钟关掉。所以真正可用 = 组开着 **且** 这项
 * 自己开着，两层都过了才进 `legs.features`。
 *
 * 下游一律只看 `legs.features` 这份清单，不再自己去查 `role.spy` —— 裁提示词
 * （trimSpyPrompt）、挑 pool（phonePool）问的是同一个问题，答案只该有一份。
 */

import { logDebug, logInfo, logWarn } from "./logs.js";
import { describeImage } from "./llm.js";
import { FEATURES, GROUP_NAMES, featureByKey, matchFeature } from "./spyfeatures.js";
import { runByName } from "./spyrun.js";
import {
  cancelShot,
  createShotRequest,
  phoneConfigProblem,
  sendTriggerMail,
  waitForShot,
} from "./spyphone.js";
import { xmlBlockRanges } from "./websearch.js";

/** 抓一张图最多等多久。截图服务是本机/局域网的，慢成这样基本就是没开。 */
const GRAB_TIMEOUT = 15000;

/**
 * 手机那头最多等多久（毫秒）。
 *
 * 比电脑那头宽得多：这段时间里要走完「SMTP 投递 → iCloud 推送 → 邮件自动化
 * 冷启动 → 截屏 → 转 JPEG → 上传」。参考插件的默认值是 90 秒，实测正常
 * 10–30 秒完成。可以在配置里调，钳在 20–180 秒之间。
 */
const PHONE_WAIT_DEFAULT = 90000;

/**
 * 一张截图最多多大（20MB）。
 *
 * 4K 屏的 JPEG 通常两三 MB，留足余量。设上限是因为这头连的可能是用户填错的
 * 地址，返回体不一定是图 —— 没有上限的话一个流式接口能把内存吃光。
 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** 两个屏幕标签。中文写法、全角方括号和全角冒号一律认，理由见 igtags.js 文件头。 */
const PC_TAG = /[[［]\s*查岗(?:实时)?电脑屏幕\s*[\]］]/g;
const PHONE_TAG = /[[［]\s*查岗(?:实时)?手机屏幕\s*[\]］]/g;
/** 两个屏幕标签一起认，用来剥标签和判「这轮要不要看屏幕」。 */
const ANY_TAG = new RegExp(`${PC_TAG.source}|${PHONE_TAG.source}`, "g");

/**
 * 手机里那两个带参数的标签。
 *
 * 冒号后面那串交给 spyrun.js:splitArg 去拆成「功能名 + 参数」—— 这儿不拆，
 * 因为拆法要查功能表（`放歌 稻香 周杰伦` 得按已知功能名啃前缀，见那边）。
 *
 * 认的写法比屏幕那两个宽一档：
 *
 *  - `查岗手机` / `查看手机` / `看手机`：都是「看一眼手机里的某个 App」
 *  - `操控手机` / `控制手机` / `操作手机`：都是「让手机做一件事」
 *
 * **屏幕那两个标签必须优先匹配**：`[查岗实时手机屏幕]` 里 `查岗手机` 不连续
 * （中间夹着「实时」），所以这两套正则本来就不重叠；但 `[查岗手机:手机屏幕]`
 * 这种写法模型是会写的，那一路走 matchFeature 找不到「手机屏幕」这个功能，
 * 会回一句「能用的是：微信、支付宝账单…」—— 比静默失败清楚。
 *
 * 体内长度给到 120：功能名最长「抖音个人主页」六个字，参数那头「稻香 周杰伦」
 * 这种也就十来个字，120 足够宽，又不会把一整段跑飞的正文吞进来当参数。
 *
 * 体内**允许是空的**（`{0,120}`），虽然空标签什么也做不了 —— 认它是为了能剥掉它。
 * 不认的话 `[查岗手机:]` 会原样发到对方手机上，那比静默忽略难看得多。
 * 「空的当没写」这条判断在 phoneTargetIn 里。
 */
const PHONE_VIEW_TAG =
  /[[［]\s*(?:查岗|查看|看)手机\s*[:：]\s*([^\]］]{0,120}?)\s*[\]］]/g;
const PHONE_CONTROL_TAG =
  /[[［]\s*(?:操控|控制|操作)手机\s*[:：]\s*([^\]］]{0,120}?)\s*[\]］]/g;

/** 手机里那两个标签一起认。剥标签用，也用来判「这轮有没有要做手机上的事」。 */
const PHONE_ANY_TAG = new RegExp(
  `${PHONE_VIEW_TAG.source}|${PHONE_CONTROL_TAG.source}`,
  "g"
);

/** 两头各自的中文名。日志、提示模板、给模型的说明都用这两个词。 */
export const DEVICE_NAMES = { pc: "电脑", phone: "手机" };

/** 谁失败了倒向谁。 */
const OTHER = { pc: "phone", phone: "pc" };

/**
 * 这个角色的查岗开关都开成什么样：五个组 + 十九件事各自那一个。
 *
 * 前两个是屏幕（`spy.pcEnabled` / `spy.phoneEnabled`，老配置的单个 `enabled`
 * 由 config.js:normalizeSpy 迁过来），后三个管手机**里面**那十九件事，按
 * spyfeatures.js 的 group 一一对应：
 *
 *   view     `[查岗手机:…]` 那九件（截图七件 + 电量位置两件）
 *   control  `[操控手机:…]` 里闹钟和锁屏那四件
 *   music    `[操控手机:…]` 里网易云那六件
 *
 * 四个地方要问同一个问题 —— 提示词注入哪几行（prompt.js → trimSpyPrompt）、
 * 这轮要不要真去抓（imessage.js 那两趟往返）、能在哪些功能里找（phonePool）、
 * 失败了能不能倒向另一头（runSpy）—— 所以答案只在这儿算一次。
 *
 * **`screens` 和 `any` 不是一回事**，分开是必须的：屏幕那两条腿的互相兜底
 * （runSpy）只在 `screens` 里打转，而「这一整条子条目要不要注入」问的是 `any`。
 * 混成一个的话，只开「放歌」的用户会拿到一整段讲屏幕查岗的提示词。
 *
 * ── `features` / `on` 这两个字段 ──
 *
 * `features` 是**两层都过了**的那几件事（组开着 + 这项自己开着），按表里的
 * 顺序。`on(key)` 是查单项的函数。下游一律用它们，别再自己去翻 `role.spy` ——
 * 「两层都要过」这条规则只该写在一个地方。
 *
 * 一组开着、但组里每一项都被用户关掉，是个合法状态：那一组的 `group` 字段还是
 * true（用户确实同意过这一类），但 `features` 里没有它的项 —— 提示词里那一行
 * 会被裁掉（trimSpyPrompt 按「这组有没有活着的项」判），pool 也是空的。
 * 不把 `view` 直接改成 false，是因为那样会让「用户关了组」和「用户把组里的项
 * 一个个关光了」变成同一件事，界面上就没法把他自己的选择原样显示回去。
 *
 * @returns {{pc:boolean, phone:boolean, view:boolean, control:boolean,
 *            music:boolean, screens:boolean, any:boolean,
 *            features:import("./spyfeatures.js").SpyFeature[],
 *            on:(key:string)=>boolean}}
 */
export function spyLegs(role) {
  const spy = role?.spy ?? {};
  const pc = Boolean(spy.pcEnabled);
  const phone = Boolean(spy.phoneEnabled);
  const view = Boolean(spy.phoneViewEnabled);
  const control = Boolean(spy.phoneControlEnabled);
  const music = Boolean(spy.phoneMusicEnabled);
  const screens = pc || phone;
  const groups = { view, control, music };

  /*
   * 单项开关。**缺键当开** —— 和 config.js:normalizeSpyFeatures 同一条规矩，
   * 在这儿再写一遍是因为这个函数也吃没过归一化的对象（测试、老备份、
   * 手改过的 data.config.json）。少了这一句，那些路径下十九件事会全变成关的。
   */
  const picked = spy.features && typeof spy.features === "object" ? spy.features : {};
  const on = (key) => {
    const f = featureByKey(key);
    if (!f || !groups[f.group]) return false;
    return picked[key] === undefined ? true : Boolean(picked[key]);
  };
  const features = FEATURES.filter((f) => on(f.key));

  return {
    pc,
    phone,
    view,
    control,
    music,
    screens,
    any: screens || view || control || music,
    features,
    on,
  };
}

/** 这一组里还有几件事是活着的（两层都过了）。裁提示词和挑 pool 都问这个。 */
function liveInGroup(legs, group) {
  return (legs?.features ?? []).filter((f) => f.group === group);
}

/** 这一组一共几件事。判「用户一项都没关」用的。 */
function groupSize(group) {
  return FEATURES.filter((f) => f.group === group).length;
}

/** 五条腿的全名单，也是不指定 kind 时的默认。 */
const ALL_LEGS = ["pc", "phone", "view", "control", "music"];

/**
 * 四条查岗子条目各自管哪几条腿（preset.js:FORMAT_CHILD_KINDS 里那四个 kind）。
 *
 * 查岗在预设里是**四条**子条目，不是一条 —— 分法照角色面板和参考插件
 * `_conf_schema.json` 的三段（view_actions / control_actions / netease_music），
 * 屏幕单独一条。每条正文里只有自己那一段，所以裁剪也只该按自己那几条腿判：
 * `spyMusic` 那条正文里压根没有屏幕两行，它要是跟着去看 `on.pc`，
 * 「全开就原样返回」这类判断就会被另一组的开关带跑。
 *
 * 不给 kind 时（老配置里那条合在一起的 `spy`、整合查岗那一路）照旧按
 * 五行一整段处理 —— 拆分是提示词这一层的事，别让别的调用方跟着改。
 */
const KIND_LEGS = {
  spyScreen: ["pc", "phone"],
  spyView: ["view"],
  spyControl: ["control"],
  spyMusic: ["music"],
};

/**
 * 三个手机组各自那一行，靠**变量占位符**认。
 *
 * 屏幕那两行能按标签字面量认（`[查岗实时电脑屏幕]` 是唯一的），手机里那三组
 * 不行：`操控手机` 和 `放歌` 两组共用 `[操控手机:…]` 这一个标签前缀，按标签
 * 认的话删一组会把另一组也删掉。所以每组各给一个占位符，既是「这一行要注入
 * 哪份清单」的锚，也是「这一组关掉时删哪一行」的锚 —— 和 `{{表情包变量}}`
 * 那几个一个路子（prompt.js:formatBlock）。
 */
const GROUP_VARS = {
  view: /\{\{\s*查看项\s*\}\}/,
  control: /\{\{\s*操控项\s*\}\}/,
  music: /\{\{\s*网易云项\s*\}\}/,
};

/**
 * 把一组功能拼成给模型看的清单。要参数的带上参数长什么样。
 *
 * 列的是 `legs.features` 里属于这一组的那几件 —— 用户关掉的单项**不许出现在
 * 清单里**。清单是模型唯一的功能来源，写进去就等于教它写那个标签，而那个标签
 * 一定会被 phonePool 挡掉：白烧一轮生成，换来角色说一句「我试了但没用」。
 */
function featureList(group, legs, { playlists = [] } = {}) {
  return liveInGroup(legs, group)
    .map((f) => {
      if (!f.needsArg) return f.name;
      /*
       * 预设歌单的 argHint 是「用户预设过的那几个」—— 那是句废话，模型看不到
       * 「那几个」是什么。这儿换成真名字，它才点得出来。一个都没配时这条功能
       * 压根用不了（spyrun.js:buildBody 会报「还没预设过任何歌单」），所以直接
       * 说清楚，别让它白写一个标签。
       */
      if (f.key === "musicPlaylist") {
        const names = playlists.map((p) => p.name).filter(Boolean);
        return names.length
          ? `${f.name}（${names.join("、")}）`
          : `${f.name}（用户还没预设过歌单，这一项现在用不了）`;
      }
      return `${f.name}（${f.argHint}）`;
    })
    .join("、");
}

/**
 * 这一行里那几个**写死了功能名**的标签，是不是全都属于已经关掉的组？
 *
 * 「正确示例」下面那几行是写好参数的真标签（`[查岗手机:支付宝账单]`、
 * `[操控手机:锁屏]`），占位符和它们无关，所以按占位符认行那套规则一个都抓不到 ——
 * 结果就是：查看类关着，正文里却还挂着一条 `- [查岗手机:支付宝账单]`，模型照
 * 着抄一遍，白烧一轮生成。
 *
 * 判法是查真表：把标签体拿去 `matchFeature` 认出它是哪一件事，**那一件事关着**
 * 就算这个标签死了（组关着、或者这一项被单独关掉，`legs.on` 一并判了）。
 * 不按字面词判是因为示例里的词用户能改（他把「支付宝账单」换成「微信」，
 * 还是得认出来这是哪一项）。认不出来的词（比如他瞎写一个不存在的功能）不算
 * 死标签 —— 删掉看不懂的行比留着更糟。
 *
 * 按**单项**而不是按组判，是单项开关这一层必须的：默认正文里那条
 * `- [查岗手机:支付宝账单]` 在「查看类开着、但支付宝那一项被关掉」时也是死的，
 * 按组判的话它会留在正文里，模型照着抄一遍然后被 phonePool 挡掉。
 *
 * **一行里的标签要全死才删这一行。** 讲参数怎么写那条规则一行里挂着两个例子
 * （`[操控手机:设置闹钟 07:30]` 和 `[操控手机:放歌 稻香 周杰伦]`），分属
 * control 和 music 两组 —— 只关了一组时那行还得留着，不然另一组就没人教它参数
 * 写在哪儿了。
 */
function deadExample(line, legs) {
  let seen = 0;
  let dead = 0;
  for (const [re, pool] of [
    [PHONE_VIEW_TAG, FEATURES.filter((f) => f.group === "view")],
    [PHONE_CONTROL_TAG, FEATURES.filter((f) => f.group !== "view")],
  ]) {
    // 带 g 的正则的 lastIndex 会跨调用留着，每次现造一个
    const scan = new RegExp(re.source, "g");
    let m = scan.exec(line);
    while (m) {
      const body = (m[1] ?? "").trim();
      // 参数（`放歌 稻香`）按已知功能名啃前缀是 spyrun.js 的事，这儿双向包含够用
      const f = body ? matchFeature(body, pool) : null;
      if (f) {
        seen += 1;
        if (!legs.on(f.key)) dead += 1;
      }
      m = scan.exec(line);
    }
  }
  return seen > 0 && dead === seen;
}

/**
 * 删掉底下一条不剩的小标题（`正确示例:` 后面那几行全被裁掉的情况）。
 *
 * 正文是缩进表示层级的 YAML 样子，小标题（`        正确示例:`）自己不带标签也
 * 不带占位符，所以上面那几条规则一个都抓不到它 —— 示例全死了之后剩下一个
 * `正确示例:` 挂在那儿，模型下面看到的是「规则」那一段，会以为示例被截断了。
 *
 * 判法纯看缩进：一行以 `:` 结尾、后面紧跟的行缩进都不比它深，就是空标题。
 * 不按 `正确示例` 这个词判，因为这段正文用户能改（他把小标题改成「例子」，
 * 空标题还是得删）。
 */
function dropEmptyHeadings(lines) {
  const indent = (s) => s.length - s.trimStart().length;
  return lines.filter((line, i) => {
    if (!/:\s*$/.test(line)) return true;
    const here = indent(line);
    for (let j = i + 1; j < lines.length; j += 1) {
      if (!lines[j].trim()) continue;
      // 下一条有内容的行比它深 = 这个标题底下还有东西
      return indent(lines[j]) > here;
    }
    // 它是最后一行，底下什么都没有
    return false;
  });
}

/**
 * 按这个角色开着哪几样，把提示词正文裁成「只有这几样」。
 *
 * 五组开关（见 spyLegs）对着正文里五行，全开时一个字不动，关掉的那几组要把
 * 对应的行删掉 —— 教模型写一个注定被拒的标签，代价是白烧一轮生成。
 *
 * 四件事：
 *
 *  1. **删掉关着那几组的行。** 屏幕两行按标签字面量认（默认正文里 `看电脑:` /
 *     `看手机:` 和「正确示例」下面那两行各自带着自己的标签，一删就干净），
 *     手机里那三行按变量占位符认（理由见 GROUP_VARS）。按标签/占位符认而不是
 *     按 `看电脑:` 这种小标题认，是因为这段正文用户能改：他把小标题改成别的词，
 *     标签和占位符还是得原样留着（不然功能就废了）。
 *     **一组里所有单项都被关掉时，那一行和这一组关着一样要删** —— 留着就是一行
 *     `能看的有：`后面空无一物的废话。
 *  2. **删掉讲自动回退的那行。** 屏幕没有两条腿都开着时压根不会倒
 *     （runSpy 拦着），留着就是一句和事实相反的话。这一条是**尽力而为**的：
 *     按默认正文里那句「自动改看另一头」的措辞认，用户改写成别的说法就认不
 *     出来了 —— 所以还有第 4 条兜底。
 *  3. **把留下来那几行的占位符换成真清单。** 清单从 spyfeatures.js 现算、
 *     只列这个角色开着的那几项，不写死在正文里 —— 那张表加一条，这儿跟着就有了。
 *  4. **在末尾补一句程序生成的话**，逐字列清这一轮到底哪几个标签能用。
 *     前三步都是删和填，删不干净的靠这一句压住：正文里「按你想知道的挑一头……
 *     该在躺着刷手机就看手机」这类话还在，模型凭它硬编一个没开的标签是有的
 *     （那种情况 imessage.js 那两趟往返会拦下来，但白烧一轮）。补在最后是因为
 *     靠后的指令压得住前面的泛泛之谈。
 *
 * 这一条管的那几条腿全开时原样返回（只换占位符），一个字不多加。
 *
 * @param {string} text 子条目正文（已经填过 {{变量}}）
 * @param {object} legs spyLegs 的结果
 * @param {object} [ctx]
 * @param {{name:string,id:string}[]} [ctx.playlists] 用户预设的歌单，填进清单里
 * @param {string} [ctx.kind] 哪一条查岗子条目（`spyScreen` / `spyView` /
 *        `spyControl` / `spyMusic`，见 KIND_LEGS）。给了就只按那一条管的腿裁、
 *        补充那句也只说那一段的事；不给按五行一整段处理（老配置那条 `spy`）。
 * @returns {string} 裁过的正文；这一条一样都没开时返回空串（调用方据此整条跳过）
 */
export function trimSpyPrompt(text, legs, { playlists = [], kind = "" } = {}) {
  const src = String(text ?? "");
  /*
   * 这一条子条目管哪几条腿。不在名单里的腿一律当关着 —— 于是「那一组的占位符
   * 要不要删」「补充那句要不要提它」全都自动只说自己这一段的事，不用在下面
   * 每一处再判一次 kind。
   */
  const mine = KIND_LEGS[kind] ?? ALL_LEGS;
  const has = (leg) => mine.includes(leg);
  /*
   * 手机那三组这儿问的是「**还有活着的项吗**」，不是「组开关开没开」：一组开着
   * 但里面十九件事被用户一个个关光了，和这组关着对提示词是同一件事。
   */
  const on = {
    pc: has("pc") && Boolean(legs?.pc),
    phone: has("phone") && Boolean(legs?.phone),
    view: has("view") && liveInGroup(legs, "view").length > 0,
    control: has("control") && liveInGroup(legs, "control").length > 0,
    music: has("music") && liveInGroup(legs, "music").length > 0,
  };
  if (!on.pc && !on.phone && !on.view && !on.control && !on.music) return "";

  /*
   * 关着那几组各自的「认行」正则。屏幕用标签，手机里那三组用占位符。
   *
   * 注意 PC_TAG / PHONE_TAG 是带 g 的全局正则，`test` 会带着 lastIndex 走 ——
   * 在这儿按行反复 test 的话会漏判。所以照 source 现造一个不带 g 的。
   */
  const gone = [];
  if (!on.pc) gone.push(new RegExp(PC_TAG.source));
  if (!on.phone) gone.push(new RegExp(PHONE_TAG.source));
  for (const key of ["view", "control", "music"]) {
    if (!on[key]) gone.push(GROUP_VARS[key]);
  }
  // 讲自动回退的那句。只有屏幕两条腿都开着时它才是真话
  if (!(on.pc && on.phone)) gone.push(/自动改看另一头|没看到时会自动/);

  let kept = dropEmptyHeadings(
    src.split("\n").filter((line) => !gone.some((re) => re.test(line)) && !deadExample(line, legs))
  )
    .join("\n")
    .trim();
  if (!kept) return "";

  // 留下来那几组的占位符换成真清单（只含这个角色开着的项）
  for (const group of ["view", "control", "music"]) {
    if (on[group]) kept = kept.replace(GROUP_VARS[group], featureList(group, legs, { playlists }));
  }

  /*
   * 全开：正文本身已经说全了，不用再补。
   *
   * 「全开」只算**这一条管的那几条腿**：`spyMusic` 那条正文里只讲网易云，
   * 用户没开电脑屏幕跟它没有一点关系，跟着别人的开关去补一句「你这一轮能用的
   * 标签只有 [操控手机:…]」纯属废话。
   *
   * 还要连**单项**一起算：组开着、但用户关掉了「关闭闹钟」—— 那时候清单里
   * 已经没有它了，可正文里「按你想知道的挑一头」那类泛泛之谈还在，
   * 补充那句得照样补上去。
   */
  const allOpen = mine.every((leg) =>
    leg === "pc" || leg === "phone"
      ? on[leg]
      : liveInGroup(legs, leg).length === groupSize(leg)
  );
  if (allOpen) return kept;

  /*
   * 补充那句。**逐字列出能用的标签**，别只说「其它的别写」—— 模型对
   * 「可以写 A」的服从度远高于「不要写 B」，正面清单比禁令管得住。
   */
  const live = [];
  if (on.pc) live.push("[查岗实时电脑屏幕]");
  if (on.phone) live.push("[查岗实时手机屏幕]");
  if (on.view) live.push("[查岗手机:…]");
  if (on.control || on.music) live.push("[操控手机:…]");

  const notes = [
    `你这一轮能用的标签只有这些：${live.join("、")}。别的写法一律不生效，写了也白写。`,
  ];

  /*
   * 一组里有几项被单独关掉时，再把那一组**还能用的项**逐字点一遍。
   *
   * 上面那行清单里已经列过一次了（占位符换进去的），这儿是同一份名单的第二遍 ——
   * 刻意重复：正文里那行离标签定义很远（中间隔着一整段规则和示例），而模型抄
   * 标签时看的是最靠后那几句。只列名字不带参数说明，那部分正文里说过了。
   */
  for (const [group, tag] of [
    ["view", "[查岗手机:…]"],
    ["control", "[操控手机:…]"],
    ["music", "[操控手机:…]"],
  ]) {
    if (!on[group]) continue;
    const live2 = liveInGroup(legs, group);
    if (live2.length === FEATURES.filter((f) => f.group === group).length) continue;
    notes.push(
      `${tag} 里${GROUP_NAMES[group]}这一类你只能用这几项：` +
        `${live2.map((f) => f.name).join("、")}，别的项没开、写了也不会发生任何事。`
    );
  }

  // 屏幕只开一条腿：额外点明不会自动改看另一头（正文里那句已经删了，这儿说清）
  if (has("pc") && has("phone") && on.pc !== on.phone) {
    const only = on.pc ? "pc" : "phone";
    notes.push(
      `屏幕你只能看${DEVICE_NAMES[only]}，` +
        `${DEVICE_NAMES[only]}这头没看到时也不会自动改看${DEVICE_NAMES[OTHER[only]]}。`
    );
  }
  /*
   * 「你看不到他的屏幕」这句只在**整段**那一版里说得通：四条拆开之后，
   * 屏幕归 spyScreen 那条管，而屏幕全关时那条整条不注入（上面就返回空串了）。
   * 在 spyView / spyMusic 那几条里说这句话，是替另一条子条目宣布它的开关状态 ——
   * 那条可能正开着，模型会被两段话搞糊涂。
   */
  if (has("pc") && has("phone") && !on.pc && !on.phone) {
    notes.push("你看不到他的屏幕，只能看他手机里那几项具体的东西。");
  }
  return `${kept}\n        补充: "${notes.join("")}"`;
}

/**
 * 识图时给视觉模型的提示词。
 *
 * 和角色自己的识图提示词（那个是用来看**对方发来的图**的）分开：这里要的不是
 * 「描述这张图」，而是「说清楚这个人现在在干什么」—— 查岗真正想知道的是活动，
 * 不是像素。写明「直接描述、不要寒暄」是因为视觉模型很爱先来一句
 * 「这是一张屏幕截图」，那句话进了第二轮提示词纯属噪音。
 */
const SPY_VISION_PROMPT = {
  pc:
    "这是用户此刻的电脑屏幕截图。请直接描述你看到的内容，" +
    "重点说清楚这个人现在大概在做什么：在写代码还是在看视频、" +
    "开着哪些软件、网页或视频的标题是什么、在和谁聊天、在玩什么游戏。" +
    "看得见的文字尽量照实说出来。不要寒暄，不要说「这是一张截图」。",
  phone:
    "这是用户此刻的手机屏幕截图。请直接描述你看到的内容，" +
    "重点说清楚这个人现在大概在做什么：开着哪个 App、" +
    "在刷什么内容、在和谁聊天、屏幕上有什么文字。" +
    "如果是锁屏或桌面，就照实说明并把时间、通知这些细节说出来。" +
    "不要寒暄，不要说「这是一张截图」。",
};

/** 成功那一路给模型的话。`{{device}}` / `{{screen}}` 两个变量。 */
export const SPY_OK_TEMPLATE =
  "<{{device}}屏幕>\n{{screen}}\n</{{device}}屏幕>\n\n" +
  "上面是你刚看到的、{{user}}此刻的{{device}}屏幕内容。现在正式回答对方，" +
  "别再写查岗标签。就当是你自己亲眼看到的，别提「截图」「系统」「工具」这些词，" +
  "也别把上面这段原文抄给对方。";

/** 回退成功那一路。`{{failed}}` 是没看成的那个，`{{device}}` 是实际看到的那个。 */
export const DEFAULT_FALLBACK_TEMPLATE =
  "{{failed}}屏幕这次没看到（{{error}}），但{{device}}屏幕看到了：\n\n" +
  "<{{device}}屏幕>\n{{screen}}\n</{{device}}屏幕>\n\n" +
  "现在正式回答对方，别再写查岗标签。你看到的是{{device}}上的画面，" +
  "别说成{{failed}}。就当是你自己亲眼看到的，别提「截图」「系统」「工具」这些词。";

/**
 * 只看了一头、那一头没看成。
 *
 * 和下面那份「两头都没看到」分开，是因为**只开了一条腿的时候不能提另一头** ——
 * 用户只开电脑查岗，说明他压根不想让角色碰他手机，那句「电脑和手机都没看到」
 * 既是假话，又把一个关着的功能说给了模型听（它会顺着接一句「你手机也没动？」）。
 * 自动回退关着、两条腿都开的情况也走这份：那一轮确实只看了一头。
 *
 * `{{device}}` 是实际看的那头。
 */
export const DEFAULT_ONE_FAILED_TEMPLATE =
  "{{user}}的{{device}}屏幕这次没看到（{{error}}）。" +
  "对方可能不在{{device}}前，或者正忙着、已经睡了。" +
  "现在正式回答对方，别再写查岗标签。**别告诉对方你在查他的屏幕**，" +
  "也别提「截图」「失败」「系统」这些词 —— 就按你的人设正常说话，" +
  "可以顺口问一句在干什么。";

/** 两头都失败。给的是「没看到」这个事实，让模型自己按人设找台词。 */
export const DEFAULT_BOTH_FAILED_TEMPLATE =
  "{{user}}的电脑和手机屏幕这次都没看到（{{error}}）。" +
  "对方可能不在电脑前、手机锁着屏，或者正忙着、已经睡了。" +
  "现在正式回答对方，别再写查岗标签。**别告诉对方你在查他的屏幕**，" +
  "也别提「截图」「失败」「系统」这些词 —— 就按你的人设正常说话，" +
  "可以顺口问一句在干什么。";

/**
 * 看手机里某个 App 时给视觉模型的提示词。
 *
 * 和屏幕那两份分开：屏幕问的是「这个人在干什么」（开着哪些软件、在和谁聊天），
 * 这儿问的是「这一屏上写着什么」—— 用户点名要看支付宝账单，想知道的是金额和
 * 商家，不是「他在用支付宝」。`{{what}}` 换成功能名。
 *
 * 「照实念出来」这句是这份的重点：账单、订单、聊天列表全是密密麻麻的文字，
 * 视觉模型不催的话只会回一句「这是一个账单页面，显示了若干条交易记录」，
 * 那句话进了第二轮提示词等于什么都没看到。
 */
const PHONE_VIEW_PROMPT =
  "这是用户 iPhone 上刚打开的「{{what}}」那一屏的截图。" +
  "请把你看到的内容照实说出来，**具体到文字和数字**：" +
  "有几条、每条分别是什么、金额多少、时间是什么时候、对方是谁。" +
  "看得见的文字尽量原样念出来，别概括成「若干条记录」。" +
  "页面要是没加载出来、需要登录、或者是一片空白，就照实说明。" +
  "不要寒暄，不要说「这是一张截图」。";

/** 看手机里某样东西成功了。`{{what}}` 是看的哪一项，`{{seen}}` 是看到的内容。 */
export const PHONE_VIEW_OK_TEMPLATE =
  "<手机里的{{what}}>\n{{seen}}\n</手机里的{{what}}>\n\n" +
  "上面是你刚在 {{user}} 手机上看到的{{what}}。现在正式回答对方，别再写手机标签。" +
  "就当是你自己亲眼看到的，别提「截图」「系统」「工具」这些词，" +
  "也别把上面这段原文抄给对方 —— 挑你在意的那部分说。";

/**
 * 没看成 / 没做成。
 *
 * `{{why}}` 是 spyrun.js 给的那句失败原因（那边刻意写得很细，见那个文件头）。
 * **原因给模型看但不许它转述**：「手机 90 秒内没回传，可能锁着屏」对用户来说
 * 是句天书，角色照着念一遍只会显得像个报错窗口。给它是为了让它知道该说
 * 「你手机是不是没在身边」还是「你是不是没装那个 App」。
 */
export const PHONE_FAIL_TEMPLATE =
  "你想{{what}}，但这次没成（{{why}}）。" +
  "现在正式回答对方，别再写手机标签。**别告诉对方你在动他的手机**，" +
  "上面那个原因也别原样告诉他 —— 就按你的人设正常说话，" +
  "可以顺口问一句他手机在不在身边、或者干脆聊别的。";

/** 操控做完了。不识图，就这一句（理由见 spyrun.js 文件头「为什么 control 不等回传」）。 */
export const PHONE_DONE_TEMPLATE =
  "{{done}}。现在正式回答对方，别再写操控标签。" +
  "这件事已经在 {{user}} 手机上做好了，按你的人设说一句就行 —— " +
  "别提「指令」「系统」「工具」这些词，也别说「我帮你操作了」这种话。";

/** 把 `{{x}}` 换成值。留着没给值的变量不动，和 igrun.js:markFor 一个路子。 */
function fill(template, vars) {
  let out = String(template ?? "");
  for (const [k, v] of Object.entries(vars)) {
    out = out.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, "g"), String(v ?? ""));
  }
  return out;
}

/** 这段文字里，`re` 在 xml 块之外命中过没有（`<thinking>` 里复述格式不算）。 */
function matchesOutsideXml(text, re) {
  const src = String(text ?? "");
  if (!src) return false;
  const ranges = xmlBlockRanges(src);
  for (const m of src.matchAll(re)) {
    if (!ranges.some(([a, b]) => m.index >= a && m.index < b)) return true;
  }
  return false;
}

/**
 * 这轮模型要查哪一头？两个都写了按**先出现**的算。
 *
 * 只查一头是刻意的：两头都查要打两次识图、等两趟网络，而查岗的用处是
 * 「现在在干什么」—— 一个屏幕就够回答了。而且回退机制已经保证「这一头
 * 不通就看另一头」，模型想全都看到的需求本来就被覆盖了。
 *
 * @returns {"pc"|"phone"|null} 不查岗时返回 null
 */
export function spyTargetIn(text) {
  const src = String(text ?? "");
  if (!src) return null;
  const ranges = xmlBlockRanges(src);
  const outside = (m) => !ranges.some(([a, b]) => m.index >= a && m.index < b);

  let best = null;
  for (const [kind, re] of [
    ["pc", new RegExp(PC_TAG.source, "g")],
    ["phone", new RegExp(PHONE_TAG.source, "g")],
  ]) {
    for (const m of src.matchAll(re)) {
      if (!outside(m)) continue;
      if (best === null || m.index < best.at) best = { kind, at: m.index };
      break;
    }
  }
  return best?.kind ?? null;
}

/** 有没有屏幕查岗标签。 */
export function hasSpyTag(text) {
  return matchesOutsideXml(text, new RegExp(ANY_TAG.source, "g"));
}

/**
 * 这轮模型要在手机里做哪件事？
 *
 * 和 spyTargetIn 同一套规矩，两条也都按**先出现**的算，一轮只做一件：
 * 查看类要走一趟「抓回来 → 识图 → 再问一次模型」，两件事就是两趟等待和两次
 * 识图钱；操控类本来可以并发，但「一轮只做一件」对模型来说是条好记的规则，
 * 两类分着讲反而容易让它把两个标签写在一条回复里。
 *
 * 查看和操控**都写了的时候按先出现的算** —— 这两类的下游形态不一样
 * （一个要识图往返、一个只回一句话），混着做没法收尾成一段话。
 *
 * @returns {{kind:"view"|"control", keyword:string, at:number}|null}
 *          没写手机标签时返回 null。`keyword` 是冒号后面那串原文（含参数），
 *          拆成功能名 + 参数是 spyrun.js:splitArg 的事
 */
export function phoneTargetIn(text) {
  const src = String(text ?? "");
  if (!src) return null;
  const ranges = xmlBlockRanges(src);
  const outside = (m) => !ranges.some(([a, b]) => m.index >= a && m.index < b);

  let best = null;
  for (const [kind, re] of [
    ["view", new RegExp(PHONE_VIEW_TAG.source, "g")],
    ["control", new RegExp(PHONE_CONTROL_TAG.source, "g")],
  ]) {
    for (const m of src.matchAll(re)) {
      if (!outside(m)) continue;
      const keyword = String(m[1] ?? "").trim();
      // 体内是空的（`[查岗手机:]`）：当没写 —— 交给下游只会换回一句
      // 「没有「」这个功能」，那句话对模型毫无信息
      if (!keyword) continue;
      if (best === null || m.index < best.at) best = { kind, keyword, at: m.index };
      break;
    }
  }
  return best ? { kind: best.kind, keyword: best.keyword, at: best.at } : null;
}

/**
 * 有没有一个**做得成**的手机标签。
 *
 * 刻意走 phoneTargetIn 而不是自己 match 一遍正则：那样 `[查岗手机:]` 会让这个
 * 函数回 true、而 phoneTargetIn 回 null，两个答案对不上，调用方按哪个写都有
 * 一条路是错的。空标签照样会被 stripSpyTags 剥掉（那边用的是自己的正则），
 * 所以这儿从严没有代价。
 */
export function hasPhoneTag(text) {
  return phoneTargetIn(text) !== null;
}

/**
 * 某一类该在哪些功能里找，**按这个角色开着哪几样过滤**。
 *
 * 两类首先必须各查自己那份：查看类的 pool 里没有「放歌」，所以模型用
 * `[查岗手机:放歌]` 点歌会被回一句「能用的是：微信、支付宝账单…」，而不是
 * 真去放歌然后没法收尾（放完歌没有图可识，查看类那条路在等一张图）。
 * 反过来操控类里没有「支付宝账单」，`[操控手机:支付宝账单]` 同理被挡住。
 *
 * 再往下按 `legs.features` 滤一道 —— 那份清单是「组开着 + 这项自己开着」两层都
 * 过了的（见 spyLegs）。两层都要在这儿把住：
 *
 *  - 组这一层，因为**操控类横跨两个开关**（闹钟锁屏归 `phoneControlEnabled`，
 *    网易云归 `phoneMusicEnabled`）。只开放歌的用户写 `[操控手机:锁屏]` 必须
 *    匹配不上 —— 不滤的话那部手机就真的被锁了，而用户从没同意过这件事。
 *  - 单项这一层，因为提示词里没教过的标签模型照样会写（它见过别的角色、或者
 *    干脆是猜的）。用户把「关闭闹钟」单独关掉，就是不想让角色关他的起床闹钟，
 *    这道闸是那句话唯一真正生效的地方 —— 提示词只是不教，挡住要靠这儿。
 *
 * 滤成空数组是合法结局（那一类一样都没开）：调用方据此当这轮没写标签。
 *
 * @param {"view"|"control"} kind
 * @param {object} legs spyLegs 的结果
 */
export function phonePool(kind, legs) {
  const live = legs?.features ?? [];
  if (kind === "view") return live.filter((f) => f.group === "view");
  return live.filter((f) => f.group !== "view");
}

/**
 * 去掉查岗标签（四个都去），只留文字。
 *
 * 和 stripSearchTags 一样只在**发给对方**那一路上用 —— 内存历史、落盘存档、
 * 「上下文」面板里都该看得见模型的原文（用户明确要求过「使用功能的时候
 * 不要过滤任何标签」）。
 *
 * 四个标签一起剥而不是分成两个函数：调用点（imessage.js 那两处 `withoutSpy`）
 * 要的是「把这条回复里所有查岗痕迹去掉之后还剩几个字」，分开剥的话每个调用点
 * 都得记着连着调两次，漏一个就会有 `[操控手机:锁屏]` 原样发到对方手机上。
 */
export function stripSpyTags(text) {
  const src = String(text ?? "");
  if (!src) return "";
  const ranges = xmlBlockRanges(src);
  const all = new RegExp(`${ANY_TAG.source}|${PHONE_ANY_TAG.source}`, "g");
  let out = "";
  let cursor = 0;
  for (const m of src.matchAll(all)) {
    if (ranges.some(([a, b]) => m.index >= a && m.index < b)) continue;
    out += src.slice(cursor, m.index);
    cursor = m.index + m[0].length;
  }
  out += src.slice(cursor);
  return out.trim();
}

/**
 * 一头的地址。`base` 用户填的可能是 `127.0.0.1:6878`、
 * `http://127.0.0.1:6878` 或者带路径的完整 URL，都得认。
 *
 * 没写路径时补 `/screenshot` —— 那是截图服务的约定端点。
 */
function urlFor(base) {
  const raw = String(base ?? "").trim();
  if (!raw) return "";
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const u = new URL(withScheme);
    if (u.pathname === "" || u.pathname === "/") u.pathname = "/screenshot";
    return u.toString();
  } catch {
    return "";
  }
}

/**
 * 抓失败时给人看的原因。措辞要能让用户看出下一步该查什么。
 *
 * **得往 cause 里挖。** `fetch` 连不上时抛的是一个 message 只有 `fetch failed`
 * 的 TypeError，真正有用的 `ECONNREFUSED` 埋在 `e.cause.code` 里（undici 的
 * 行为）；超时那条又是 cause 本身带 name。两层都看，而且**挖不出来时不能
 * 回落到 e.message** —— 那样用户看到的就是「fetch failed」，等于没说。
 */
function whyGrab(e) {
  const cause = e?.cause;
  const code = e?.code || cause?.code || "";
  const name = e?.name || cause?.name || "";

  if (name === "AbortError" || name === "TimeoutError" || code === "ABORT_ERR") {
    return `超过 ${Math.round(GRAB_TIMEOUT / 1000)} 秒没响应`;
  }
  if (code === "ECONNREFUSED") return "截图服务没在运行";
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return "网络不通";
  if (code === "ETIMEDOUT") return "连接超时";
  if (code === "ENOTFOUND") return "地址解析不了";
  if (code === "ECONNRESET") return "连接被截图服务掐断了";
  if (code === "CERT_HAS_EXPIRED" || code === "ERR_TLS_CERT_ALTNAME_INVALID") {
    return "证书不对（截图服务一般走 http，别写 https）";
  }

  // 认不出来的：宁可报 code 也别报「fetch failed」，那句话对排障毫无帮助
  const msg = String(e?.message ?? "");
  if (code) return `连不上（${code}）`;
  return msg && msg !== "fetch failed" ? msg : "连不上（地址填错或者服务没开）";
}

/**
 * 电脑那头：拉一张图回来。
 *
 * @returns {Promise<{base64:string, mimeType:string}>}
 * @throws {Error} 抓不到（地址没配、连不上、返回的不是图、图太大）
 */
async function grabPc(base, kind = "pc") {
  const url = urlFor(base);
  if (!url) throw new Error("截图地址没配");

  logDebug("查岗", `正在抓${DEVICE_NAMES[kind]}屏幕：${url}`);

  let resp;
  try {
    resp = await fetch(url, {
      signal: AbortSignal.timeout(GRAB_TIMEOUT),
      // 截图服务不带鉴权，但有些会看 UA 判断是不是浏览器
      headers: { Accept: "image/*,*/*" },
    });
  } catch (e) {
    throw new Error(whyGrab(e));
  }

  if (!resp.ok) throw new Error(`截图服务返回 ${resp.status}`);

  /*
   * Content-Length 先挡一道 —— 有的话就不用把整个响应读进来才发现太大。
   * 没有这个头（chunked）时下面读完再量一次。
   */
  const claimed = Number(resp.headers.get("content-length") ?? 0);
  if (claimed > MAX_IMAGE_BYTES) {
    throw new Error(`截图太大（${Math.round(claimed / 1024 / 1024)}MB）`);
  }

  const buf = Buffer.from(await resp.arrayBuffer());
  if (!buf.length) throw new Error("截图服务返回了空内容");
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new Error(`截图太大（${Math.round(buf.length / 1024 / 1024)}MB）`);
  }

  /*
   * 真的是张图吗。用户把地址填成别的服务时，返回的多半是一段 HTML 或 JSON ——
   * 那玩意儿送进视觉模型只会换回一句「我看不出这是什么」，白烧一次识图钱。
   * 认魔数不认 Content-Type：截图服务的头不一定写对。
   */
  const mimeType = sniffImage(buf);
  if (!mimeType) throw new Error("返回的不是图片（地址可能填错了）");

  logDebug(
    "查岗",
    `${DEVICE_NAMES[kind]}屏幕抓到了，约 ${Math.round(buf.length / 1024)}KB（${mimeType}）`
  );
  return { base64: buf.toString("base64"), mimeType };
}

/**
 * 手机那头：发触发邮件，等 iPhone 把截图 POST 回来。
 *
 * **先挂等待条目再发邮件**。反过来的话，网络快的时候图可能比条目先到，
 * 那张图会因为「没有待处理请求」被丢掉，然后这边一直等到超时。
 *
 * @param {object} api 全局那份 spyApi（SMTP 凭据 + 校验密钥 + 等待时长）
 * @returns {Promise<{base64:string, mimeType:string}>}
 * @throws {Error} 配置不全、邮件发不出去、等超时、回来的不是图
 */
async function grabPhone(api) {
  const problem = phoneConfigProblem(api);
  if (problem) throw new Error(problem);

  const waitMs = clampWait(api?.waitSeconds);
  const id = createShotRequest("手机屏幕");

  try {
    await sendTriggerMail(api);
  } catch (e) {
    // 邮件都没发出去，没必要让条目在队列里占着位等超时
    cancelShot(id);
    throw e;
  }

  logDebug("查岗", `触发邮件发出去了，最多等 ${Math.round(waitMs / 1000)} 秒`);
  const buf = await waitForShot(id, waitMs);

  if (!buf.length) throw new Error("手机传回来的是空内容");
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new Error(`手机截图太大（${Math.round(buf.length / 1024 / 1024)}MB）`);
  }
  const mimeType = sniffImage(buf);
  if (!mimeType) throw new Error("手机传回来的不是图片（检查快捷指令里的转换图像那步）");

  logDebug(
    "查岗",
    `手机屏幕拿到了，约 ${Math.round(buf.length / 1024)}KB（${mimeType}）`
  );
  return { base64: buf.toString("base64"), mimeType };
}

/** 手机等多久，钳在 20–180 秒。填空或填得离谱都用默认的 90 秒。 */
function clampWait(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return PHONE_WAIT_DEFAULT;
  return Math.min(180, Math.max(20, Math.round(n))) * 1000;
}

/** 认图片魔数。和 media.js:sniffImageType 同一套，这里只要这四种。 */
function sniffImage(buf) {
  if (buf.length < 12) return "";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.toString("latin1", 0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") {
    return "image/webp";
  }
  if (buf.toString("latin1", 0, 3) === "GIF") return "image/gif";
  return "";
}

/**
 * 查一头：抓图 + 识图。
 *
 * @returns {Promise<{ok:true, screen:string}|{ok:false, error:string}>}
 *          从不抛错 —— 调用方要靠返回值决定倒不倒向另一头
 */
async function lookAt(kind, { role, eps, spyApi, scope }) {
  const name = DEVICE_NAMES[kind];

  /*
   * 先把「没开识图模型」这一道挡在抓图之前。
   *
   * 顺序有讲究：手机那头抓一次要发一封邮件、把用户手机唤起来截一张屏、等上
   * 十几秒 —— 全都做完了才发现没模型可看，那是白折腾用户一趟。电脑那头顺带
   * 也省一次请求。
   */
  if (!eps?.vision) {
    logWarn(scope, `${name}查岗没做：这个角色没开识图模型，抓回来也看不出内容`);
    return { ok: false, error: "没开识图模型" };
  }

  let image;
  try {
    image =
      kind === "pc" ? await grabPc(role?.spy?.pcUrl, "pc") : await grabPhone(spyApi);
  } catch (e) {
    logWarn(scope, `${name}查岗没抓到屏幕：${e.message}`);
    return { ok: false, error: e.message };
  }

  /*
   * 识图走角色自己选的识图模型（eps.vision，上面已经确认有了）。
   *
   * 复用它而不是另给查岗配一个：那条线本来就是「把图看成文字」，
   * 用户已经在角色里选好了模型，再多一份配置只会出现两边选了不同模型、
   * 用户以为改了其实没生效的情况。
   *
   * 提示词**不复用** eps.visionPrompt —— 那个是用来看对方发来的图的，
   * 查岗要问的是「这个人在干什么」，见 SPY_VISION_PROMPT。
   */
  try {
    const screen = await describeImage(eps.vision, SPY_VISION_PROMPT[kind], {
      ...image,
      name: `${name}屏幕`,
    });
    logInfo(scope, `${name}查岗成功，识图 ${screen.length} 字`, screen);
    return { ok: true, screen };
  } catch (e) {
    logWarn(scope, `${name}查岗抓到了屏幕，但识图失败：${e.message}`);
    return { ok: false, error: `识图失败（${e.message}）` };
  }
}

/**
 * 查岗那一趟：查模型要的那头，不成就倒向另一头。
 *
 * @param {"pc"|"phone"} want 模型想看哪头（spyTargetIn 的结果）
 * @param {object} ctx
 * @param {object} ctx.role   当前角色（要 role.spy 那几个字段）
 * @param {object} ctx.eps    这个角色解析好的几条线（要 eps.vision）
 * @param {object} ctx.spyApi 全局那份 spyApi（手机那条腿的 SMTP 凭据等）
 * @param {string} ctx.userName 对方的名字，填模板里的 `{{user}}`
 * @param {string} ctx.scope  日志作用域
 * @returns {Promise<string>} 接在第一次回复后面、要当 user 消息问回去的那段话
 *
 * 调用方（imessage.js:spyRound）保证 `want` 那条腿的开关是开着的。回退那一步
 * 这儿自己再查一次另一条腿 —— 用户只开了电脑腿的话，「电脑没看到」不该变成
 * 「那就去把他手机唤起来」。
 */
export async function runSpy(want, { role, eps, spyApi, userName, scope }) {
  const spy = role?.spy ?? {};
  const legs = spyLegs(role);
  const first = await lookAt(want, { role, eps, spyApi, scope });

  if (first.ok) {
    return fill(SPY_OK_TEMPLATE, {
      device: DEVICE_NAMES[want],
      screen: first.screen,
      user: userName || "对方",
    });
  }

  /*
   * 倒向另一头。
   *
   * 两种情况不倒，都直接收尾、不白打第二次网络。措辞里的 error 用第一次那个原因。
   *
   *  1. 用户关了自动回退。
   *  2. **另一条腿的开关是关的。** 这道检查比第一条更要紧：用户只开电脑腿
   *     就是在说「别动我手机」，一次抓图失败不该成为把他手机唤起来的理由。
   *
   * 这一路给的是 DEFAULT_ONE_FAILED_TEMPLATE 而不是「两头都没看到」那份 ——
   * 这轮确实只看了一头，说成两头是假话，而且只开一条腿时那句话会把关着的
   * 那条腿说给模型听。用户自己填过模板就照他的（界面上这一栏在单腿模式下
   * 的标题就是「没看到时」）。
   */
  const other = OTHER[want];
  if (!spy.autoFallback || !legs[other]) {
    const why = legs[other] ? "自动回退是关的" : `${DEVICE_NAMES[other]}查岗的开关是关的`;
    logInfo(scope, `${DEVICE_NAMES[want]}查岗没成，${why}，这轮就不看了`);
    return fill(spy.bothFailedTemplate || DEFAULT_ONE_FAILED_TEMPLATE, {
      device: DEVICE_NAMES[want],
      error: first.error,
      user: userName || "对方",
    });
  }

  logInfo(
    scope,
    `${DEVICE_NAMES[want]}查岗没成（${first.error}），自动改查${DEVICE_NAMES[other]}`
  );
  const second = await lookAt(other, { role, eps, spyApi, scope });

  if (second.ok) {
    return fill(spy.fallbackTemplate || DEFAULT_FALLBACK_TEMPLATE, {
      failed: DEVICE_NAMES[want],
      device: DEVICE_NAMES[other],
      screen: second.screen,
      error: first.error,
      user: userName || "对方",
    });
  }

  logWarn(
    scope,
    `两头都没看到 —— ${DEVICE_NAMES[want]}：${first.error}；` +
      `${DEVICE_NAMES[other]}：${second.error}`
  );
  return fill(spy.bothFailedTemplate || DEFAULT_BOTH_FAILED_TEMPLATE, {
    // 同一栏的模板两条路都在用（单腿那路在上面），用户要是在里面写了
    // {{device}}，这儿给它一个说得通的值，别让占位符原样漏进提示词
    device: `${DEVICE_NAMES[want]}和${DEVICE_NAMES[other]}`,
    // 两个原因都给模型，它按人设挑一个说（或者干脆都不说）
    error: `${DEVICE_NAMES[want]}${first.error}，${DEVICE_NAMES[other]}${second.error}`,
    user: userName || "对方",
  });
}

/**
 * 手机里那一趟：做那件事，回一段要当 user 消息问回去的话。
 *
 * 三条收尾，和 spyrun.js 那三种 kind 对齐：
 *
 *   操控成功 → `PHONE_DONE_TEMPLATE`，一句「已经照做了」。**不识图**
 *   查看成功 → 有图的先识图，识完套 `PHONE_VIEW_OK_TEMPLATE`；
 *              电量位置那两件回的是现成的一句话，直接套同一份模板
 *   没成     → `PHONE_FAIL_TEMPLATE`
 *
 * **识图在这儿做，不在 spyrun.js 里做。** 那个文件只认「手机」这一层、不认
 * 角色，而视觉模型是角色的东西（`eps.vision`）—— 它把 Buffer 交出来，怎么变成
 * 文字由这儿定（见那个文件头「为什么 screenshot 这一路不在这儿识图」）。
 *
 * **从不抛错**，和 runSpy 一样：调用方要靠返回值决定下一步，而「没做成」在这个
 * 功能里是很正常的结局（手机锁着、App 没装、用户不在身边）。
 *
 * @param {{kind:"view"|"control", keyword:string}} want phoneTargetIn 的结果
 * @param {object} ctx
 * @param {object} ctx.role   当前角色（要 role.spy 那几个开关）
 * @param {object} ctx.eps    这个角色解析好的几条线（查看类要 eps.vision）
 * @param {object} ctx.spyApi 全局那份（SMTP 凭据 + 校验密钥 + 预设歌单）
 * @param {string} ctx.userName 对方的名字，填模板里的 `{{user}}`
 * @param {string} ctx.scope  日志作用域
 * @returns {Promise<string>} 接在第一次回复后面、要当 user 消息问回去的那段话
 */
export async function runPhone(want, { role, eps, spyApi, userName, scope }) {
  const legs = spyLegs(role);
  const user = userName || "对方";
  const pool = phonePool(want.kind, legs);

  /*
   * 查看类要视觉模型，**这道闸排在发邮件之前**。
   *
   * 和 lookAt 里同一个理由，在这条路上更要紧：查看类是「把用户手机唤起来、
   * 替他打开支付宝、截一张图、传回来」，十几秒加一次打扰，全做完了才发现
   * 没模型可看 —— 那是白折腾用户一趟，而且那张账单截图已经白传了一遍。
   */
  if (want.kind === "view" && !eps?.vision) {
    logWarn(scope, `「${want.keyword}」没看：这个角色没开识图模型，抓回来也看不出内容`);
    return fill(PHONE_FAIL_TEMPLATE, { what: `看他手机里的${want.keyword}`, why: "没开识图模型" });
  }

  const out = await runByName(want.keyword, pool, {
    spyApi,
    playlists: Array.isArray(spyApi?.playlists) ? spyApi.playlists : [],
    scope,
  });

  // 名字对不上（pool 里没有这一条）。runByName 那句话里已经列了能用的是哪些，
  // 直接把它交给模型 —— 比「没成」三个字有用，它下一轮就能改写对
  if (!out.feature) return fill(PHONE_FAIL_TEMPLATE, { what: want.keyword, why: out.text });

  const label = out.label || out.feature.name;
  if (!out.ok) {
    const what = want.kind === "view" ? `看他手机里的${label}` : `让他手机${label}`;
    return fill(PHONE_FAIL_TEMPLATE, { what, why: out.text });
  }

  // 操控类：一句话收尾，不识图
  if (want.kind === "control") {
    return fill(PHONE_DONE_TEMPLATE, { done: out.text, user });
  }

  /*
   * 查看类。两种货：
   *
   *  - 有 image（截图那七件）：识图成文字
   *  - 有 text（电量、位置）：spyrun.js 已经拼成一句话了，直接用
   *
   * 后者刻意不走识图 —— 电量本来就是个数字，截图再让视觉模型去认屏幕上的
   * 「85%」纯属绕路（见 spyfeatures.js:VIEW_JSON）。
   */
  if (!out.image) return fill(PHONE_VIEW_OK_TEMPLATE, { what: label, seen: out.text, user });

  let seen;
  try {
    seen = await describeImage(eps.vision, fill(PHONE_VIEW_PROMPT, { what: label }), {
      base64: out.image.toString("base64"),
      mimeType: out.mimeType,
      name: `手机里的${label}`,
    });
  } catch (e) {
    logWarn(scope, `「${label}」的截图拿到了，但识图失败：${e.message}`);
    return fill(PHONE_FAIL_TEMPLATE, {
      what: `看他手机里的${label}`,
      why: `识图失败（${e.message}）`,
    });
  }

  logInfo(scope, `手机里的${label}看到了，识图 ${seen.length} 字`, seen);
  return fill(PHONE_VIEW_OK_TEMPLATE, { what: label, seen, user });
}
