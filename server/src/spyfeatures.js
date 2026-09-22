/**
 * 手机那部 iPhone 上能做的十八件事：一张表，外加按名字找条目的规则。
 *
 * ── 为什么是一张表 ──
 *
 * 这十八件事的链路**完全一样**：发一封主题带关键字的邮件 → iPhone 的邮件自动化
 * 被触发 → 跑一条快捷指令 → 要么把图/数据 POST 回来，要么就地干完（锁屏、放歌）。
 * 区别只在三处：主题词、要不要等回传、回传的是图还是 JSON。所以做成数据而不是
 * 十八个函数 —— 加一件事只要在这张表里加一行，`spyrun.js` 那边一个字都不用改。
 *
 * 参考插件（data/astrbot_plugin_phone_spy）是十八个 `@llm_tool`，一个函数一件事。
 * 那套在这儿走不通也不该走：用户明确要求「不要工具，很耗 token」，而且本项目的
 * 模型走纯文本补全，全靠标签（media.js / igtags.js / websearch.js 都是这套）。
 *
 * ── 三种 kind，三条不同的下游 ──
 *
 *   screenshot  发邮件 → 等一张图回来 → 识图成文字。要视觉模型。
 *   json        发邮件 → 等一段 JSON 回来 → 按字段拼成一句话。不要视觉模型。
 *   control     发邮件就完事。不等回传，也没什么可等的 —— 锁屏、放歌这些
 *               干完了手机上就有反应，用户自己看得见。
 *
 * screenshot 和 json 合起来是「查看类」，走 `[查岗手机:…]`；control 是「操控类」，
 * 走 `[操控手机:…]`。两个标签分开是因为它们的**形态**不一样：查看要走一趟
 * 「抓回来 → 识图 → 再问一次模型」的往返（和 `[搜索:…]` 同一个形态），操控
 * 只要一句「已经照做了」就够，不值得为它白烧一次生成。
 *
 * ── body：有些事要往邮件正文里塞参数 ──
 *
 * 快捷指令那边「从输入中获取文本」拿到的就是邮件正文。闹钟要知道几点、放歌要
 * 知道放哪首，都从这儿传。`needsArg` 标着「用户必须给个参数」，`buildBody` 把
 * 那个参数变成正文该有的样子（闹钟是 `07:30`，放歌是 `orpheus://song/…`）。
 *
 * 不需要参数的（锁屏、每日推荐）正文留空，`spyphone.js:sendTriggerMail` 会填一句
 * 占位的话 —— 有些 SMTP 把空正文当垃圾邮件。
 *
 * ── 主题词为什么还是 ASTRBOT_* ──
 *
 * 用户明确要求保持原样（「主题还是一样有那个 ASTRBOT，因为我懒得改了」）。
 * 他 iPhone 上那十几条自动化已经按这些词建好了，改主题等于让他全部重配一遍。
 *
 * 唯一要当心的是 iOS 的主题条件是**包含**匹配，所以主题词之间不能有前缀关系 ——
 * 参考插件踩过这个坑：`ASTRBOT_MUSIC_PLAY` 同时是 `ASTRBOT_MUSIC_PLAYPAUSE` 的
 * 前缀，两条自动化互相误触发，后来把「播放指定歌曲」改成了 `ASTRBOT_MUSIC_SONG`。
 * 这张表沿用他改过之后的那一套，底下 `subjectPrefixClash` 会在启动时验一遍。
 */

import { logWarn } from "./logs.js";

/**
 * 一件事。
 *
 * @typedef {object} SpyFeature
 * @property {string} key      内部键名，配置里存的就是这个（改显示名不会让老配置失效）
 * @property {string} name     显示名，也是用户和模型写在标签里的那个词
 * @property {string} subject  触发邮件的主题
 * @property {"screenshot"|"json"|"control"} kind 上面讲的三条下游
 * @property {string[]} aliases 别名。模型和用户都不会每次都写全名
 * @property {boolean} needsArg 要不要参数（闹钟的时间、歌名）
 * @property {string} argHint  参数长什么样，写进提示词里给模型看
 * @property {string} group    归哪一类，只用来在界面上分组和裁提示词
 */

/** 查看类里要截图的那七件事。主题词和参考插件的说明书逐字对齐。 */
const VIEW_SHOTS = [
  {
    key: "wechat",
    name: "微信",
    subject: "ASTRBOT_WECHAT",
    aliases: ["微信聊天", "wechat", "微信消息"],
  },
  {
    key: "alipay",
    name: "支付宝账单",
    subject: "ASTRBOT_ALIPAY",
    aliases: ["支付宝", "账单", "alipay", "花了多少钱"],
  },
  {
    key: "bilibili",
    name: "B站历史",
    subject: "ASTRBOT_BILIBILI",
    aliases: ["b站", "哔哩哔哩", "b站观看历史", "观看历史", "bilibili"],
  },
  {
    key: "douyinMsg",
    name: "抖音私信",
    subject: "ASTRBOT_DOUYIN_MSG",
    aliases: ["抖音消息", "抖音私聊", "抖音聊天"],
  },
  {
    key: "douyinProfile",
    name: "抖音个人主页",
    subject: "ASTRBOT_DOUYIN_PROFILE",
    aliases: ["抖音主页", "抖音资料", "抖音个人页"],
  },
  {
    key: "taobaoOrder",
    name: "淘宝订单",
    subject: "ASTRBOT_TAOBAO_ORDER",
    aliases: ["淘宝", "订单", "快递", "我的订单"],
  },
  {
    key: "taobaoCart",
    name: "淘宝购物车",
    subject: "ASTRBOT_TAOBAO_CART",
    aliases: ["购物车", "淘宝车"],
  },
];

/**
 * 查看类里回传 JSON 的两件事。
 *
 * 这两个**不截图、不识图** —— 电量和位置本来就是结构化的数字，截一张图再让
 * 视觉模型去认屏幕上的「85%」纯属绕路，还要多花一次识图钱。快捷指令那边用
 * 「文本」动作拼一个 JSON 直接 POST 回来（路径见 `spyphone.js` 那两个常量）。
 */
const VIEW_JSON = [
  {
    key: "battery",
    name: "电量",
    subject: "ASTRBOT_BATTERY",
    aliases: ["电池", "剩余电量", "battery", "还有多少电"],
  },
  {
    key: "location",
    name: "位置",
    subject: "ASTRBOT_LOCATION",
    aliases: ["定位", "地理位置", "在哪", "location", "gps", "在哪儿"],
  },
];

/**
 * 操控类。
 *
 * 三个闹钟操作都要时间参数，而且**开 / 关只能作用于已经存在的闹钟** ——
 * 快捷指令的「开关闹钟」动作就是这个语义，新建得用「创建闹钟」。这件事写进
 * argHint 里让模型知道，不然它会拿「开启闹钟」去建一个不存在的闹钟，用户那头
 * 什么都不会发生。
 */
const CONTROLS = [
  {
    key: "alarmSet",
    name: "设置闹钟",
    subject: "ASTRBOT_ALARM",
    aliases: ["定闹钟", "加闹钟", "新建闹钟", "叫我起床"],
    needsArg: true,
    argHint: "24 小时制的 HH:MM，例如 07:30",
  },
  {
    key: "alarmOn",
    name: "开启闹钟",
    subject: "ASTRBOT_ON_ALARM",
    aliases: ["打开闹钟", "启用闹钟"],
    needsArg: true,
    argHint: "24 小时制的 HH:MM；只能开已经存在的闹钟，新建要用「设置闹钟」",
  },
  {
    key: "alarmOff",
    name: "关闭闹钟",
    subject: "ASTRBOT_OFF_ALARM",
    aliases: ["取消闹钟", "关掉闹钟", "停用闹钟"],
    needsArg: true,
    argHint: "24 小时制的 HH:MM；只能关已经存在的闹钟",
  },
  {
    key: "lock",
    name: "锁屏",
    subject: "ASTRBOT_LOCK",
    aliases: ["锁定屏幕", "锁手机", "关屏幕", "睡觉吧"],
  },
];

/**
 * 网易云那六件事。也是操控类 —— 它们改变用户手机的状态（开始放歌），
 * 不是「看一眼」。
 *
 * 「播放指定歌曲」和「预设歌单」要往正文里塞一个 `orpheus://` scheme，那是
 * 网易云的 URL scheme，快捷指令拿它去「打开 URL」。歌曲 ID 得先去 163 的
 * 搜索接口查（见 `spymusic.js`），歌单 ID 是用户自己在配置里填的。
 *
 * 「播放/暂停」是系统级的媒体控制，对任何音乐 App 都有效，而且**锁屏状态下
 * 也能用** —— 和锁屏一样是这批里唯二不需要解锁手机的。
 */
const MUSIC = [
  {
    key: "musicDaily",
    name: "每日推荐",
    subject: "ASTRBOT_MUSIC_DAILY",
    aliases: ["日推", "每日歌曲推荐", "推荐歌单"],
  },
  {
    key: "musicFm",
    name: "私人漫游",
    subject: "ASTRBOT_MUSIC_FM",
    aliases: ["私人fm", "漫游", "私人电台"],
  },
  {
    key: "musicFavorite",
    name: "红心歌单",
    subject: "ASTRBOT_MUSIC_FAVORITE",
    aliases: ["我喜欢的音乐", "收藏的歌", "喜欢的歌"],
  },
  {
    key: "musicPlayPause",
    name: "播放暂停",
    subject: "ASTRBOT_MUSIC_PLAYPAUSE",
    aliases: ["暂停", "继续放", "播放", "暂停音乐", "播放/暂停"],
  },
  {
    key: "musicSong",
    name: "放歌",
    subject: "ASTRBOT_MUSIC_SONG",
    aliases: ["播放歌曲", "放首歌", "听歌", "点歌"],
    needsArg: true,
    argHint: "歌名，可以带歌手，例如「晴天」或「稻香 周杰伦」",
  },
  {
    key: "musicPlaylist",
    name: "预设歌单",
    subject: "ASTRBOT_MUSIC_LIST",
    aliases: ["歌单", "放歌单"],
    needsArg: true,
    argHint: "用户预设过的歌单名字，只能是他配置里有的那几个",
  },
];

/** 三类各自的中文名。日志、界面分组、裁提示词都用这几个词。 */
export const GROUP_NAMES = {
  view: "查看",
  control: "控制",
  music: "网易云",
};

/**
 * 整张表。顺序就是界面上和提示词里的顺序 —— 查看在前，因为那是查岗的主业。
 *
 * 每条都补齐默认字段，好让下游不用一遍遍写 `?? false`。
 */
export const FEATURES = [
  ...VIEW_SHOTS.map((f) => ({ ...f, kind: "screenshot", group: "view" })),
  ...VIEW_JSON.map((f) => ({ ...f, kind: "json", group: "view" })),
  ...CONTROLS.map((f) => ({ ...f, kind: "control", group: "control" })),
  ...MUSIC.map((f) => ({ ...f, kind: "control", group: "music" })),
].map((f) => ({
  aliases: [],
  needsArg: false,
  argHint: "",
  ...f,
}));

/** key → 条目。按键名找是最常用的一路（配置里存的是 key）。 */
const BY_KEY = new Map(FEATURES.map((f) => [f.key, f]));

/** 按 key 取一条。取不到返回 undefined —— 老配置里可能有已经删掉的 key。 */
export function featureByKey(key) {
  return BY_KEY.get(String(key ?? ""));
}

/** 某一类的全部条目。 */
export function featuresInGroup(group) {
  return FEATURES.filter((f) => f.group === group);
}

/** 查看类（screenshot + json）。走 `[查岗手机:…]` 的那些。 */
export function viewFeatures() {
  return FEATURES.filter((f) => f.group === "view");
}

/** 操控类（control + music）。走 `[操控手机:…]` 的那些。 */
export function controlFeatures() {
  return FEATURES.filter((f) => f.group !== "view");
}

/**
 * 归一化：去掉所有空白、转小写、全角标点换成半角。
 *
 * 模型写标签时的随意程度超出想象 —— `[查岗手机: 支付宝账单]`、`[查岗手机:B站历史]`、
 * `[查岗手机:ｂ站]` 都见过。全角那一步是因为中文输入法下 `B` 很容易打成 `Ｂ`。
 */
function norm(text) {
  return String(text ?? "")
    .replace(/\s+/g, "")
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toLowerCase();
}

/**
 * 按名字找一条：完全匹配 → 忽略大小写 → 双向包含。
 *
 * 这套规则照搬参考插件的 `match_feature`，连「双向」这一条都一样 —— 用户说
 * 「支付宝」要能匹配到「支付宝账单」（关键词是名字的一部分），说「看看我的
 * 淘宝购物车里有什么」也要能匹配到「淘宝购物车」（名字是关键词的一部分）。
 *
 * **双向包含排在最后**，因为它最容易误伤：「抖音」同时是「抖音私信」和
 * 「抖音个人主页」的一部分，谁在表里靠前就归谁。这个顺序是刻意的 —— 宁可
 * 猜一个具体的，也别因为有歧义就什么都不做（模型只会原样再写一遍）。
 *
 * @param {string} keyword 标签里写的那个词
 * @param {SpyFeature[]} pool 只在这些条目里找。默认全表，`[查岗手机:…]` 那边
 *        只传查看类 —— 不然模型用查岗标签点歌会被匹配上，然后走一条不该走的路。
 * @returns {SpyFeature|null}
 */
export function matchFeature(keyword, pool = FEATURES) {
  const key = norm(keyword);
  if (!key) return null;

  for (const f of pool) {
    if ([f.name, ...f.aliases].some((n) => norm(n) === key)) return f;
  }
  for (const f of pool) {
    for (const n of [f.name, ...f.aliases]) {
      const nn = norm(n);
      if (nn && (key.includes(nn) || nn.includes(key))) return f;
    }
  }
  return null;
}

/**
 * 配置里填的那一串功能名 → 条目列表，保持用户写的顺序。
 *
 * 整合查岗的「要查哪几项」用这个解析。认换行、顿号、中英文逗号和分号 ——
 * 界面上那是个多行输入框，但用户一行里用顿号写好几个是很自然的事。
 *
 * 认不出来的和重复的都跳过并记一条 warn：静默丢掉的话，用户会以为填了就生效，
 * 然后在查岗结果里找不到那一项还不知道为什么。
 *
 * @param {string|string[]} raw
 * @param {SpyFeature[]} pool 在哪些条目里找。整合查岗只查「查看类」
 * @returns {SpyFeature[]}
 */
export function parseFeatureList(raw, pool = viewFeatures()) {
  const lines = Array.isArray(raw) ? raw : String(raw ?? "").split(/\r?\n/);
  const out = [];
  const seen = new Set();

  for (const line of lines) {
    for (const token of String(line).split(/[、，,;；]+/)) {
      const word = token.trim();
      if (!word) continue;
      const f = matchFeature(word, pool);
      if (!f) {
        logWarn(
          "查岗",
          `整合查岗里「${word}」不是能查的项目，已跳过。可填：` +
            pool.map((x) => x.name).join("、")
        );
        continue;
      }
      if (seen.has(f.key)) {
        logWarn("查岗", `整合查岗里「${f.name}」填了两次，只算一次`);
        continue;
      }
      seen.add(f.key);
      out.push(f);
    }
  }
  return out;
}

/**
 * 有没有哪两个主题词互为前缀。
 *
 * iOS 邮件自动化的主题条件是**包含**匹配，所以 `ASTRBOT_MUSIC_PLAY` 这种词会把
 * `ASTRBOT_MUSIC_PLAYPAUSE` 的自动化也触发一遍（参考插件踩过，见文件头）。
 * 这张表现在是干净的，但以后加条目的人未必想到这一层 —— 所以留一个自检，
 * 启动时调一次，脏了就喊出来。
 *
 * 顺手也查主题词重复：两件事共用一个主题，用户那部手机会同时跑两条自动化。
 *
 * @returns {string[]} 问题描述，干净时是空数组
 */
export function subjectProblems() {
  const problems = [];
  const all = FEATURES.map((f) => ({ name: f.name, subject: f.subject }));

  for (let i = 0; i < all.length; i += 1) {
    for (let j = 0; j < all.length; j += 1) {
      if (i === j) continue;
      const a = all[i];
      const b = all[j];
      if (a.subject === b.subject) {
        // 重复只报一次（i < j 那一遍）
        if (i < j) problems.push(`「${a.name}」和「${b.name}」共用主题 ${a.subject}`);
        continue;
      }
      if (b.subject.startsWith(a.subject)) {
        problems.push(
          `「${a.name}」的主题 ${a.subject} 是「${b.name}」的 ${b.subject} 的前缀 —— ` +
            `iOS 按「包含」匹配，会互相误触发`
        );
      }
    }
  }
  return problems;
}
