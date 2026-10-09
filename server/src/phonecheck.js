/**
 * 查手机：翻一翻**角色自己**手机里的东西 —— 通讯录、聊天、通话、购物、外卖、
 * 浏览记录、钱包、今天的活动轨迹、收藏夹，加上用户自己定义的 App。
 *
 * 玩法参考 SullyOS（手抓糯米机，NMJ 作）的「查手机」App，代码和提示词是按
 * Uranus 的结构重写的。和 Uranus 原有的「查岗」不是一回事：查岗看的是**用户**
 * 的真屏幕（spy.js），这里是让模型按人设**虚构**角色自己的手机内容。
 *
 * ── 生成 ──
 *
 *  - 单个 App 刷新：只生成那一个 App 的几条
 *  - 一键生成：一次请求生成好几个 App（哪几个由用户在设置里勾，config.phone.batchApps）
 *    —— 人设、世界书、聊天记录只发一遍，比一个个刷省得多
 *  - 输入：角色人设、用户人设、勾选的世界书（这个角色关联的那几本）、最近几条聊天、
 *    通讯录里已有的人（让前后对得上）、现在几点
 *  - 模型：默认用这个角色的聊天模型（失败退副 API），也可以在设置里单独选一个
 *
 * ── 去哪儿 ──
 *
 *  - 存在 data/phone/<角色 id>.json（不进 config，理由同小剧场）
 *  - 角色开了「同步到私聊」：之后的聊天里每轮注入一小段摘要（字数和时效都有上限，
 *    见 phoneNote），让角色知道自己手机里有这些、别聊着聊着 OOC
 *  - 角色开了「同步到日记待总结」：生成完往日记流水里记一行，写日记时能顺带提到
 *
 * 和 theater.js 一样，生成是后台任务（POST 只返回任务 id，前端轮询）。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { applyVars, resolveEndpoint, resolveRoleEndpoints, resolveUser } from "./config.js";
import { DATA_DIR, readJson, writeJson } from "./datadir.js";
import { stripEnvPrefix } from "./env.js";
import { chatCompletion } from "./llm.js";
import { logError, logInfo, logWarn } from "./logs.js";
import {
  appendDiaryLine,
  diaryLogLine,
  memoryKeyFor,
  readMemo,
  readMemories,
  readRecentDiaries,
} from "./memorystore.js";
import { splitBubbles } from "./delay.js";
import { resolvePreset } from "./preset.js";
import { applyRules } from "./regex.js";
import { listSessions, recentMessages } from "./sessions.js";
import { stripSearchTags, stripXmlBlocks } from "./websearch.js";
import { activate, worldBooksFor } from "./worldinfo.js";

const PHONE_DIR = path.join(DATA_DIR, "phone");
const SCOPE = "查手机";

/** 每个 App 最多留多少条（新的排前面），多了从尾巴上丢。 */
const KEEP_PER_APP = 40;

/**
 * 一次调模型最多生成几个 App，多了拆成几轮（runGenerate 里分组）。
 *
 * 一个 App 四条中文记录就一千多 token，而大多数家默认的输出上限只有
 * 四千到八千（apitype.js:ANTHROPIC_DEFAULT_MAX_TOKENS）—— 一键生成勾了
 * 十一个 App 的时候，回答写到一半就被掐断，整批 JSON 解析不了，界面上
 * 只剩一句「模型回的不是 JSON」。拆开之后每一轮都稳稳在上限里面。
 */
const APPS_PER_CALL = 4;

/**
 * 内置 App。`spec` 是告诉模型这个 App 每条记录长什么样 —— title / detail / value / time
 * 四个字段各自装什么。界面按 id 选样式（client/src/panels/phone.jsx）。
 */
export const BUILTIN_APPS = [
  {
    id: "contacts",
    name: "通讯录",
    spec:
      "通讯录里的联系人（角色自己的社交圈，不是用户的）。title=联系人姓名；value=机主给 TA 的备注名或关系（如 学长、前任、中间人）；detail=机主视角的一句备注。",
  },
  {
    id: "chat",
    name: "信息",
    spec:
      "角色和自己的联系人之间的聊天片段（不是和用户的）。title=联系人姓名；value=对方身份；time=最后一条的时间；" +
      "detail=3～6 句来回的对话，每句一行，机主说的以「我:」开头，对方说的以「对方:」开头。",
  },
  {
    id: "call",
    name: "电话",
    spec: "最近的通话记录。title=联系人；value=呼入 / 呼出 / 未接 加时长（如「呼出 12分钟」「未接」）；time=通话时间；detail=这通电话大概聊了什么（一句话）。",
  },
  {
    id: "shop",
    name: "购物",
    spec: "最近的网购订单。title=商品名；value=价格（如 ¥129.00）；detail=规格和物流状态；time=下单时间。",
  },
  {
    id: "delivery",
    name: "外卖",
    spec: "最近的外卖订单。title=店名；value=实付金额（如 ¥38.50）；detail=点了什么、备注；time=下单时间。",
  },
  {
    id: "browser",
    name: "浏览器",
    spec: "最近的搜索和浏览记录。title=搜索的关键词或网页标题；value=「搜索」或网站名；detail=看到 / 想知道什么（一句话）；time=时间。",
  },
  {
    id: "wallet",
    name: "钱包",
    spec: "钱包的收支流水。title=交易对象或用途；value=金额，支出写成「-¥38.00」、收入写成「+¥500.00」；detail=一句说明；time=时间。",
  },
  {
    id: "track",
    name: "活动轨迹",
    spec: "角色**今天**的活动轨迹，按时间先后排。title=「从哪儿 → 到哪儿」；value=时间段（如 08:10–08:45）；detail=交通方式和在那儿做了什么。",
  },
  {
    // id 还叫 favorites（老数据接得上），界面上是「文件」App，存的是最私密的那些
    id: "favorites",
    name: "文件",
    spec:
      "「文件」App 里藏着的私密文件：角色的碎碎念、没发出去的话、对 {{user}} 的心事和幻想（可以很露骨，包括性幻想和春梦，按人设来）、偷偷存的截图说明、录音备忘。" +
      "title=文件名（带扩展名，如「关于你.txt」「那天晚上.m4a」「截图_0412.png」）；value=所在文件夹（如 私密、备忘、相册导出）；detail=文件内容或这个文件是什么（文本文件就写正文，可以长一些）；time=修改时间。",
  },
  {
    id: "video",
    name: "视频",
    spec:
      "短视频 App 的观看历史。title=视频文案 / 标题；value=作者（如 @某某）；detail=视频讲了什么、角色为什么看、看完的反应（一两句）；time=观看时间。" +
      "要贴合人设，可以有点上头或者不想被人看到的内容。",
  },
  {
    id: "incognito",
    name: "无痕浏览",
    spec:
      "Safari 无痕模式里搜过、看过、以为不会留下记录的东西 —— 见不得人的那种：和 {{user}} 有关的性幻想、姿势和玩法、羞于启齿的疑问、偷偷查的东西（可以很露骨，按人设来）。" +
      "title=搜索词或网页标题；value=「搜索」或网站名；detail=当时在想什么（一句话）；time=时间。",
  },
];

/**
 * 购物 / 外卖 / 视频三个 App 的样式（手机「设置」里选，所有角色共用）。选哪个，桌面上的名字、
 * App 里的界面和告诉模型的平台就跟着换。
 */
export const SKINS = {
  shop: { taobao: "淘宝", amazon: "Amazon" },
  delivery: { meituan: "美团", doordash: "DoorDash" },
  video: { tiktok: "TikTok", douyin: "抖音", youtube: "YouTube" },
};
const DEFAULT_SKINS = { shop: "taobao", delivery: "meituan", video: "tiktok" };

const LAYOUT_SPECS = {
  generic: "title=标题；detail=内容；value=可选的数值或状态。",
  shop: "购物风格：title=商品名；detail=规格或状态；value=价格（如 ¥129.00）。",
  feed: "社交动态：title=发布者或心情；detail=正文；value=点赞数。",
  forum: "论坛：title=帖子标题；detail=正文；value=板块（如 #日常）。",
  novel: "小说：title=章节标题；detail=这一章的正文片段（150 字左右）；value=字数（如 1.2万字）。",
};
export const LAYOUTS = Object.keys(LAYOUT_SPECS);

/** 默认的一键生成范围（用户可以在设置里改）。 */
export const DEFAULT_BATCH = ["contacts", "call", "shop", "delivery"];

const newId = () => crypto.randomBytes(6).toString("hex");

/* ================= 配置规范化（config.js 用） ================= */

/** 自定义 App：全局一份，所有角色都有。 */
function normalizeCustomApps(input) {
  if (!Array.isArray(input)) return [];
  const used = new Set(BUILTIN_APPS.map((a) => a.id));
  return input
    .filter((a) => a && typeof a === "object" && String(a.name ?? "").trim())
    .map((a) => {
      let id = /^c-[a-z0-9]{4,20}$/.test(a.id) ? a.id : `c-${newId()}`;
      while (used.has(id)) id = `c-${newId()}`;
      used.add(id);
      return {
        id,
        name: String(a.name).trim().slice(0, 20),
        icon: String(a.icon ?? "").trim().slice(0, 4) || "📱",
        color: /^#[0-9a-f]{6}$/i.test(a.color) ? a.color : "#8e8e93",
        prompt: String(a.prompt ?? "").trim(),
        layout: LAYOUTS.includes(a.layout) ? a.layout : "generic",
      };
    });
}

const clamp = (v, def, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
};
const ref = (r) => ({ provider: String(r?.provider ?? ""), modelId: String(r?.modelId ?? "") });

/** 全局的查手机设置。 */
export function normalizePhoneSettings(input) {
  const customApps = normalizeCustomApps(input?.customApps);
  const known = new Set([...BUILTIN_APPS.map((a) => a.id), ...customApps.map((a) => a.id)]);
  const batch = Array.isArray(input?.batchApps) ? input.batchApps.filter((id) => known.has(id)) : DEFAULT_BATCH;
  return {
    // 空 = 用角色自己的聊天模型
    model: ref(input?.model),
    timeout: clamp(input?.timeout, 180, 30, 1800),
    // 每个 App 一次生成几条
    count: clamp(input?.count, 4, 1, 10),
    // 生成时带最近几条聊天（0 = 不带）
    contextCount: clamp(input?.contextCount, 20, 0, 100),
    batchApps: [...new Set(batch)],
    customApps,
    // 购物 / 外卖 / 视频用哪套样式（见 SKINS）
    skins: Object.fromEntries(
      Object.entries(DEFAULT_SKINS).map(([k, def]) => [k, SKINS[k][input?.skins?.[k]] ? input.skins[k] : def])
    ),
  };
}

/** 角色上的查手机开关。全默认关。 */
export function normalizeRolePhone(input) {
  return {
    // 同步到私聊：之后每轮注入一小段摘要
    injectChat: Boolean(input?.injectChat),
    injectChars: clamp(input?.injectChars, 3000, 50, 99999),
    // 生成后多久之内注入（小时）。过了就不再注入，token 也就不再花了
    injectHours: clamp(input?.injectHours, 24, 1, 720),
    // 同步到日记待总结
    toDiary: Boolean(input?.toDiary),
    // 允许在 iMessage 里发 /查手机
    command: Boolean(input?.command),
  };
}

/* ================= 存储 ================= */

const SAFE_ROLE_ID = /^[A-Za-z0-9_-]{1,80}$/;

function statePath(roleId) {
  if (!SAFE_ROLE_ID.test(String(roleId))) throw new Error("角色 id 不对");
  return path.join(PHONE_DIR, `${roleId}.json`);
}

function loadState(roleId) {
  const raw = readJson(statePath(roleId), null);
  return {
    // appId → [{id, title, detail, value, time, at, real?}]
    apps: raw?.apps && typeof raw.apps === "object" ? raw.apps : {},
    // appId → 上次生成的时间戳
    updatedAt: raw?.updatedAt && typeof raw.updatedAt === "object" ? raw.updatedAt : {},
    walletBalance: String(raw?.walletBalance ?? ""),
    bookIds: Array.isArray(raw?.bookIds) ? raw.bookIds : [],
    // 最近一次生成：注入私聊用的就是这一批
    last: raw?.last && typeof raw.last === "object" ? raw.last : null,
  };
}

function saveState(roleId, state) {
  writeJson(statePath(roleId), state);
}

/* ================= 拼请求 ================= */

/** 内置 App 加上样式：购物 / 外卖 / 视频的名字换成选的那个平台，告诉模型的说明里也点明平台。 */
function builtinApps(config) {
  const skins = config.phone?.skins ?? DEFAULT_SKINS;
  return BUILTIN_APPS.map((a) => {
    const label = SKINS[a.id]?.[skins[a.id]];
    return label ? { ...a, name: label, spec: `这是「${label}」。${a.spec}` } : a;
  });
}

function appsOf(config) {
  const custom = (config.phone?.customApps ?? []).map((a) => ({
    id: a.id,
    name: a.name,
    custom: true,
    spec: `自定义 App「${a.name}」。这个 App 是干什么的：${a.prompt || "（没写，按名字猜）"}。${LAYOUT_SPECS[a.layout] ?? LAYOUT_SPECS.generic}`,
  }));
  return [...builtinApps(config), ...custom];
}

function nowText() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const wd = "日一二三四五六"[d.getDay()];
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 星期${wd} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function recentChat(config, role, user) {
  const n = config.phone?.contextCount ?? 20;
  if (!n) return "";
  const s = listSessions().find((x) => x.roleId === role.id && x.kind !== "legacy-preset");
  if (!s) return "";
  return recentMessages(s.id, n)
    .map((m) => `${m.role === "user" ? user?.name || "用户" : role.name}: ${stripEnvPrefix(m.content).trim()}`)
    .filter((l) => !l.endsWith(": "))
    .join("\n");
}

/**
 * 一次请求的全部消息。`apps` 是这次要生成的那几个 App。
 * 返回格式统一成一个 JSON 对象：键是 App id，值是记录数组 —— 单个 App 刷新也一样，
 * 解析只有一条路。
 */
/** 同一天（本地时间）。活动轨迹「接着往下写」只在同一天里接。 */
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

/**
 * 继续生成时给模型看的「手机里已经有的」：每个 App 最近几条的标题。
 * 只给标题和一点点值，不给正文 —— 够它别写重复、接得上，又不至于把提示词撑大。
 */
function existingNote(apps, state) {
  const lines = [];
  for (const a of apps) {
    let list = state.apps[a.id] ?? [];
    if (a.id === "track") list = list.filter((x) => sameDay(x.at, Date.now()));
    if (!list.length) continue;
    const shown = list.slice(0, a.id === "track" ? 12 : 8).map((x) => x.title + (x.value ? `（${x.value}）` : ""));
    lines.push(`- ${a.id}（${a.name}）：${shown.join("；")}`);
  }
  return lines.join("\n");
}

const DAY_MS = 86400000;

/**
 * 记忆库那三样，各自跟着这个角色的开关走：
 *  - 记忆：只取「记忆库 → 设置 → 注入近 N 天的记忆」那个 N 天里的（不做语义检索）
 *  - 备忘录：整份
 *  - 日记：这个角色设的「注入近 N 天日记」
 * 手机里的东西得和角色记得的事对得上，不然一翻手机就 OOC。
 */
function memoryBlock(config, role) {
  const gates = role?.memories ?? {};
  const key = memoryKeyFor(role);
  const parts = [];
  try {
    if (gates.memory?.enabled) {
      const inject = config.memories?.memory?.recentInject ?? {};
      const days = inject.enabled === false ? 0 : inject.days ?? 3;
      const cutoff = Date.now() - days * DAY_MS;
      const lines = readMemories(key)
        .filter((m) => m?.content && (Number(m.timestamp) || 0) >= cutoff)
        .sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0))
        .map((m) => `- ${m.date || "未知日期"} | ${String(m.content).trim()}`);
      if (days > 0 && lines.length) parts.push(`<近${days}天的记忆>\n${lines.join("\n")}\n</近${days}天的记忆>`);
    }
    if (gates.memo?.enabled) {
      const memo = String(readMemo(key) ?? "").trim();
      if (memo) parts.push(`<备忘录>\n${memo}\n</备忘录>`);
    }
    if (gates.diary?.enabled) {
      const days = gates.diary.injectDays ?? 3;
      const text = days > 0 ? readRecentDiaries(key, days).map((d) => `【${d.date}】\n${d.text.trim()}`).join("\n\n") : "";
      if (text) parts.push(`<近${days}天的日记>\n${text}\n</近${days}天的日记>`);
    }
  } catch (e) {
    logWarn(SCOPE, "记忆库没读全，这次查手机少带了一部分", String(e?.message ?? e));
  }
  return parts.join("\n\n");
}

/**
 * @param {"append"|"reset"} mode append = 在原来的手机上接着加（模型能看到已有的条目）；
 *        reset = 当这台手机是全新的，不给它看旧内容
 */
function buildMessages(config, role, apps, bookIds, mode = "append") {
  const user = resolveUser(config, role);
  const vars = { char: role.name ?? "", user: user?.name ?? "" };
  const fill = (t) => applyVars(String(t ?? ""), vars).trim();
  const count = config.phone?.count ?? 4;
  const chat = recentChat(config, role, user);

  // 世界书：只从这个角色关联的那几本里挑勾上的
  const books = worldBooksFor(config, role).filter((b) => bookIds.includes(b.id));
  let world = "";
  if (books.length) {
    const hit = activate(books, [
      { role: "system", content: fill(role.description) },
      { role: "user", content: chat },
    ]);
    world = [hit.before, ...[...hit.depths.values()].map((d) => d.content), hit.after]
      .map(fill)
      .filter(Boolean)
      .join("\n\n");
  }

  const memory = memoryBlock(config, role);

  // 其他角色：通讯录里出现了就算「真实存在的人」
  const others = (config.roles ?? [])
    .filter((r) => r.id !== role.id && r.name)
    .map((r) => `- ${r.name}：${fill(r.description).replace(/\s+/g, " ").slice(0, 80) || "（没有人设）"}`);
  const state = loadState(role.id);
  const fresh = mode === "reset";
  const known = fresh ? [] : (state.apps.contacts ?? []).slice(0, 15).map((c) => `${c.title}（${c.value || "—"}）`);
  const existing = fresh ? "" : existingNote(apps, state);

  /*
   * 置顶那一段说清楚这是什么任务。**不走预设** —— 预设是给聊天回复用的（气泡、思维链、
   * 正则那一套），套到这里只会让模型输出聊天格式而不是 JSON。
   */
  const userName = vars.user || "用户";
  const system = [
    `你是一个「查手机」内容生成助手。${userName}正在偷偷翻看角色「${vars.char}」的手机，` +
      `你要以 ${vars.char} 本人的视角，生成 TA 手机里各个 App 的真实内容。` +
      "内容必须严格贴合下面的角色人设、世界设定、记忆、备忘录、日记和最近的聊天，不能 OOC；" +
      "只输出要求的 JSON，不写解释、不写聊天回复。",
    `<${vars.char}的人设>\n${fill(role.description) || "（没有写人设）"}\n</${vars.char}的人设>`,
    user?.description ? `<${userName}的人设>\n${fill(user.description)}\n</${userName}的人设>` : "",
    world ? `<世界设定>\n${world}\n</世界设定>` : "",
    fill(memory),
  ]
    .filter(Boolean)
    .join("\n\n");

  const task = [
    `现在是 ${nowText()}。`,
    chat ? `<你和${vars.user || "用户"}最近的聊天（背景参考）>\n${chat}\n</你和${vars.user || "用户"}最近的聊天>` : "",
    others.length ? `<其他真实存在的人（可以出现在你的通讯录里，关系要贴合他们的设定，不认识就别硬塞）>\n${others.join("\n")}\n</其他真实存在的人>` : "",
    known.length ? `你通讯录里已经有这些人，前后要对得上：${known.join("、")}` : "",
    existing
      ? `<手机里已经有的（这次是接着往下加新的，别重复这些；时间往后走，情节能接上就接上，活动轨迹从最后一站接着走）>\n${existing}\n</手机里已经有的>`
      : "",
    [
      "视角：这些全是**你自己**的生活和社交，用你的第一人称视角写；",
      `${vars.user || "用户"}正在翻看你的手机，TA 不是你通讯录里的路人（要提到 TA 就用你平时对 TA 的称呼）。`,
      "内容要贴合人设、最近发生的事和现在的时间，细节具体，别写成千篇一律的模板。",
    ].join(""),
    `这次要生成下面这些 App，每个 ${count} 条左右（活动轨迹按今天实际走过的地方来，不够就少写）：`,
    apps.map((a) => `- ${a.id}（${a.name}）：${fill(a.spec)}`).join("\n"),
    [
      "只输出一个 JSON 对象，不要解释、不要代码块以外的文字。",
      `键是上面的 App id，值是记录数组，每条 {"title": "…", "detail": "…", "value": "…", "time": "…"}，四个字段都是字符串。`,
      apps.some((a) => a.id === "wallet") ? `另外加一个键 "walletBalance"，值是钱包余额（如 "¥3,281.40"）。` : "",
    ].join(""),
  ]
    .filter(Boolean)
    .join("\n\n");

  return [
    { role: "system", content: system },
    { role: "user", content: task },
  ];
}

/**
 * 把**被截断**的 JSON 补成能解析的：砍到最后一个完整的值，再按括号栈补上收尾。
 *
 * 回答写到一半被 max_tokens 掐掉是常事（见 runGenerate 的分批注释）。掐掉的
 * 那一条记录没救，但前面几十条是好的 —— 与其整批报错，不如把完整的那部分留下。
 *
 * 做法：从头扫一遍，记住「每次一个值收尾时」的位置和当时的括号栈；扫完如果
 * 栈没空（说明确实断了），就回到最后那个位置、把栈倒着闭上。
 */
function closeTruncated(s) {
  const stack = [];
  let inStr = false;
  let esc = false;
  let cut = -1; // 最后一个完整值的结束位置（不含）
  let cutStack = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') {
        inStr = false;
        cut = i + 1;
        cutStack = stack.join("");
      }
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") {
      stack.pop();
      cut = i + 1;
      cutStack = stack.join("");
    }
    // 逗号和冒号后面跟的是下一个值的开头，不算收尾点，略过
  }
  if (!stack.length || cut <= 0) return null; // 没断，或者一个完整值都没有
  // 砍点落在键名那个字符串上（`"wallet": ` 写了一半）的时候，连那个键一起去掉
  let head = s.slice(0, cut).replace(/,\s*$/, "");
  if (/"\s*$/.test(head) && /[{,]\s*"[^"]*"\s*$/.test(head)) head = head.replace(/[,]?\s*"[^"]*"\s*$/, "");
  head = head.replace(/[,:]\s*$/, "");
  return head + [...cutStack].reverse().join("");
}

/** 从模型回复里抠出 JSON 对象：剥代码块、取第一个 { 到最后一个 }，再把尾逗号去掉。 */
export function extractJson(text) {
  let t = String(text ?? "").replace(/<(think|thinking)>[\s\S]*?<\/\1>/gi, "");
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  // 回答被截断的时候收尾那个 ``` 不会有，上面那条匹配不上 —— 单独把开头那行剥掉
  if (fence) t = fence[1];
  else t = t.replace(/^[\s\S]*?```(?:json)?[ \t]*\r?\n/i, "");
  const a = t.indexOf("{");
  if (a === -1) return null;
  const b = t.lastIndexOf("}");
  const body = b > a ? t.slice(a, b + 1) : "";
  const rest = t.slice(a);
  for (const candidate of [body, body.replace(/,\s*([}\]])/g, "$1"), closeTruncated(rest)]) {
    if (!candidate) continue;
    try {
      const v = JSON.parse(candidate);
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
    } catch {
      /* 下一个 */
    }
  }
  return null;
}

const asText = (v) =>
  typeof v === "string" ? v.trim() : v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);

/** 角色自己的模型（失败退副 API），或者设置里单独选的那个。 */
async function callModel(config, role, messages) {
  const timeout = (config.phone?.timeout ?? 180) * 1000;
  const custom = config.phone?.model?.provider ? resolveEndpoint(config, config.phone.model) : null;
  const eps = custom ? { chat: custom, fallback: null } : resolveRoleEndpoints(config, role);
  if (!eps.chat) throw new Error("这个角色没配聊天模型，查手机也就没法用（或者在「查手机 → 设置」里单独选一个）");
  try {
    return await chatCompletion(eps.chat, messages, { label: `查手机（${eps.chat.label}）`, timeout });
  } catch (e) {
    if (!eps.fallback) throw e;
    logWarn(SCOPE, "主 API 没成，换副 API 再试一次", String(e?.message ?? e));
    return await chatCompletion(eps.fallback, messages, { label: `查手机（${eps.fallback.label}）`, timeout });
  }
}

/* ================= 摘要（私聊注入 / 日记） ================= */

function itemLine(appName, it, detailChars) {
  const d = it.detail.replace(/\s+/g, " ");
  const tail = detailChars && d ? `：${d.length > detailChars ? `${d.slice(0, detailChars)}…` : d}` : "";
  return `${appName}｜${it.title}${it.value ? `（${it.value}）` : ""}${tail}`;
}

/** 一批生成结果压成几行字。超过 maxChars 就停。 */
function summarize(config, batch, maxChars, detailChars) {
  const names = Object.fromEntries(appsOf(config).map((a) => [a.id, a.name]));
  const lines = [];
  let used = 0;
  for (const [appId, items] of Object.entries(batch ?? {})) {
    for (const it of items) {
      const line = itemLine(names[appId] ?? appId, it, detailChars);
      if (used + line.length + 1 > maxChars) return lines.join("\n");
      lines.push(line);
      used += line.length + 1;
    }
  }
  return lines.join("\n");
}

/**
 * 「同步到私聊」那一段：最近一次查手机的摘要。
 *
 * **只在这一轮请求里注入、不进存档**（和天气同一个道理），所以 token 花费是
 * 「每轮固定多这几百字」，不会越攒越多：
 *  - 字数上限 injectChars（默认 3000，中文约 3000 token；最大 99999，那就是
 *    「整台手机都带上」的意思了，token 花费自己心里有数）
 *  - 时效 injectHours（默认 24 小时）：生成超过这个时间就不再注入，花费归零
 * 长期的记忆交给日记那条路（toDiary）。
 *
 * @returns {string} 空串 = 这轮不注入
 */
export function phoneNote(config, role) {
  const p = role?.phone;
  if (!p?.injectChat || !role?.id || !SAFE_ROLE_ID.test(role.id)) return "";
  let state;
  try {
    state = loadState(role.id);
  } catch {
    return "";
  }
  if (!state.last?.at || Date.now() - state.last.at > p.injectHours * 3600_000) return "";
  /*
   * 每条正文截多长跟着总字数走：总共只给 300 字的时候每条 24 字正好能多塞几条，
   * 但给到几千字还只截 24 字就白瞎 —— 条数早列完了，省下的字数没人用。
   */
  const detail = Math.min(120, Math.max(24, Math.round(p.injectChars / 40)));
  const body = summarize(config, state.last.items, p.injectChars, detail);
  if (!body) return "";
  return (
    `<Phone>\n这是你自己手机里最近的东西（只是让你知道自己的近况，别主动念出来，被问到时对得上就行）：\n${body}\n</Phone>`
  );
}

/** 插在开头那一串 system 之后。 */
export function injectPhoneNote(messages, note) {
  if (!note) return messages;
  const at = messages.findIndex((m) => m.role !== "system");
  const i = at === -1 ? messages.length : at;
  return [...messages.slice(0, i), { role: "system", content: note }, ...messages.slice(i)];
}

/* ================= 生成 ================= */

/**
 * 真去生成一批，落盘，按开关同步日记。返回这一批（appId → 记录）。
 * 后台任务和 /查手机 指令都走这里。
 */
export async function runGenerate(config, role, appIds, opts = {}) {
  const all = appsOf(config);
  const apps = all.filter((a) => appIds.includes(a.id));
  if (!apps.length) throw new Error("没选要生成哪些 App");
  const state = loadState(role.id);
  const bookIds = Array.isArray(opts.bookIds) ? opts.bookIds : state.bookIds;
  const reset = opts.mode === "reset";

  logInfo(SCOPE, `${reset ? "重置并重新生成" : "开始翻"} ${role.name} 的手机：${apps.map((a) => a.name).join("、")}`);

  const otherNames = new Set((config.roles ?? []).filter((r) => r.id !== role.id).map((r) => r.name?.trim()).filter(Boolean));
  const batch = {};
  const groups = [];
  for (let i = 0; i < apps.length; i += APPS_PER_CALL) groups.push(apps.slice(i, i + APPS_PER_CALL));
  let cleared = false;
  let firstError = null;

  for (const group of groups) {
    // reset 只对第一组成立：清过之后，后面几组要看得见前面刚生成的，才接得上
    const fresh = reset && !cleared;
    let json;
    try {
      const reply = await callModel(config, role, buildMessages(config, role, group, bookIds, fresh ? "reset" : "append"));
      json = extractJson(reply);
      if (!json) throw new Error(`模型回的不是 JSON，没法解析：${String(reply).slice(0, 120)}`);
    } catch (e) {
      // 一组没成不拖累别组：记下来接着跑，全军覆没才往外抛（见循环后面）
      firstError ??= e;
      if (groups.length > 1) logWarn(SCOPE, `这一组没生成出来：${group.map((a) => a.name).join("、")}`, String(e?.message ?? e));
      continue;
    }

    /*
     * 重置：整台手机换成这一批 —— 但要等**生成成功之后**才清。前面任何一步抛错
     * （模型没回、回的不是 JSON），旧内容都还在，不会落得一台空手机。
     */
    if (fresh) {
      state.apps = {};
      state.updatedAt = {};
      state.walletBalance = "";
      cleared = true;
    }

    const now = Date.now();
    const got = {};
    for (const app of group) {
      const raw = Array.isArray(json[app.id]) ? json[app.id] : [];
      const items = raw
        // 四个字段全空的丢掉：回答被截断时补出来的最后那半条就长这样
        .filter((x) => x && typeof x === "object" && [x.title, x.detail, x.value, x.time].some((v) => asText(v)))
        .map((x) => ({
          id: newId(),
          title: asText(x.title) || "（无标题）",
          detail: asText(x.detail),
          value: asText(x.value),
          time: asText(x.time),
          at: now,
          ...(app.id === "contacts" || app.id === "chat" ? { real: otherNames.has(asText(x.title).replace(/[（(].*?[）)]/g, "").trim()) } : {}),
        }));
      if (!items.length) continue;
      got[app.id] = items;
      batch[app.id] = items;
      if (app.id === "track") {
        // 活动轨迹按时间先后排、只算今天：今天已经有的就接在后面，跨天了就整个换掉
        const today = (state.apps.track ?? []).filter((x) => sameDay(x.at, now));
        state.apps.track = [...today, ...items].slice(-KEEP_PER_APP);
      } else {
        // 其余的新的排前面，旧的往后挤
        state.apps[app.id] = [...items, ...(state.apps[app.id] ?? [])].slice(0, KEEP_PER_APP);
      }
      state.updatedAt[app.id] = now;
    }
    if (json.walletBalance) state.walletBalance = asText(json.walletBalance);
    if (!Object.keys(got).length) {
      firstError ??= new Error("模型回了 JSON，但里面一条能用的记录都没有");
      continue;
    }

    /*
     * 每组落一次盘：下一组的 buildMessages 自己 loadState()，读的是盘上的 ——
     * 不存就看不见刚生成的那几个 App，会重复写同样的情节。顺带，中途断了
     * 已经生成的那几组也保住了。
     */
    state.bookIds = bookIds;
    state.last = { at: now, items: batch };
    saveState(role.id, state);
  }

  // 一条都没落下来才算失败：reset 时 state 还没清过，旧文件完好
  if (!Object.keys(batch).length) throw firstError ?? new Error("模型回了 JSON，但里面一条能用的记录都没有");

  const total = Object.values(batch).reduce((n, l) => n + l.length, 0);
  logInfo(SCOPE, `${role.name} 的手机生成好了：${total} 条`, summarize(config, batch, 4000, 60));

  // 日记待总结：写日记时能顺带提到手机里的事
  if (role.phone?.toDiary && role.memories?.diary?.enabled) {
    try {
      const text = summarize(config, batch, 1500, 60).replace(/\n/g, "；");
      appendDiaryLine(memoryKeyFor(role), diaryLogLine(`${role.name}的手机`, text));
    } catch (e) {
      logWarn(SCOPE, "没记进日记待总结（不影响查手机本身）", e);
    }
  }
  return batch;
}

/** 给 /查手机 指令回的那条消息。 */
export function batchText(config, batch) {
  return summarize(config, batch, 1500, 40);
}

/* ================= 后台任务 + 路由 ================= */

const jobs = new Map();

function startJob(roleId, title, run) {
  const job = { id: newId(), roleId, title, status: "running", startedAt: Date.now(), error: "" };
  jobs.set(job.id, job);
  while (jobs.size > 30) jobs.delete(jobs.keys().next().value);
  run().then(
    () => {
      job.status = "done";
    },
    (e) => {
      job.status = "error";
      job.error = String(e?.message ?? e);
      logError(SCOPE, `「${title}」没生成出来`, job.error);
    }
  );
  return job;
}

function roleOr404(config, id) {
  const role = (config.roles ?? []).find((r) => r.id === id);
  if (!role) throw new Error("没有这个角色（可能删了）");
  return role;
}

/**
 * 「信息」App 里和用户的那个对话：直接取真实存档的最近五轮（一轮 = 用户的一条
 * 加上角色的回复），不打模型。环境前缀剥掉，只给界面看。
 */
const USER_ROUNDS = 5;
function userThread(config, role) {
  const s = listSessions().find((x) => x.roleId === role.id && x.kind !== "legacy-preset");
  if (!s) return [];
  const msgs = recentMessages(s.id, 200);
  let i = msgs.length;
  let seen = 0;
  while (i > 0) {
    i -= 1;
    if (msgs[i].role === "user" && ++seen >= USER_ROUNDS) break;
  }
  /*
   * 角色那边的回复要和对方手机上看到的一样：先跑预设里「发给对方」那条正则（思维链之类
   * 在这儿被删掉），再剥掉还剩的 XML 块和搜索标记，最后按气泡分隔符拆成一条条气泡 ——
   * 不然一条回复里的分隔符（默认是 $）会原样显示出来。
   */
  const rules = resolvePreset(config, role).regex;
  const vars = { char: role?.name ?? "", user: resolveUser(config, role)?.name ?? "" };
  const out = [];
  for (const m of msgs.slice(seen ? i : msgs.length)) {
    const raw = stripEnvPrefix(m.content);
    if (m.role === "user") {
      for (const line of raw.split(/\n+/)) if (line.trim()) out.push({ from: "user", text: line.trim() });
      continue;
    }
    const shown = stripSearchTags(
      stripXmlBlocks(applyRules(raw, rules, { target: "aiOutput", field: "toUser", vars }).text)
    );
    for (const b of splitBubbles(shown, config.chat)) out.push({ from: "me", text: b.text });
  }
  return out;
}

function publicState(config, roleId) {
  const role = roleOr404(config, roleId);
  const s = loadState(roleId);
  const user = resolveUser(config, role);
  return {
    userName: user?.name || "",
    userThread: userThread(config, role),
    apps: s.apps,
    updatedAt: s.updatedAt,
    walletBalance: s.walletBalance,
    bookIds: s.bookIds,
    lastAt: s.last?.at ?? 0,
    books: worldBooksFor(config, role).map((b) => ({ id: b.id, name: b.name, global: b.global })),
    jobs: [...jobs.values()].filter((j) => j.roleId === roleId).reverse(),
    builtin: builtinApps(config).map(({ id, name }) => ({ id, name })),
    // 生成的聊天也按这个拆气泡（模型写的 detail 里可能也带分隔符）
    separator: config.chat?.separator ?? "$",
    skins: config.phone?.skins ?? DEFAULT_SKINS,
    skinOptions: SKINS,
    // 这个角色的自定义壁纸 + 全局的自定义图标（data URL）
    wallpaperImage: loadAssets().wallpapers[roleId] ?? "",
    icons: loadAssets().icons,
  };
}

/* ================= 自定义壁纸 / 图标 ================= */

/*
 * 存成 data URL 放在一个 JSON 里，跟着 state 一起回给前端：小手机的控制台和后端不同源，
 * <img src> 带不上鉴权头，单开一个取图接口在那边用不了。图片前端已经压过
 * （壁纸 ≤1290px 的 JPEG，图标 256px），所以不会太大。
 */
const ASSETS_PATH = path.join(PHONE_DIR, "_assets.json");
const MAX_ASSET = 3 * 1024 * 1024;

function loadAssets() {
  const raw = readJson(ASSETS_PATH, null);
  return {
    wallpapers: raw?.wallpapers && typeof raw.wallpapers === "object" ? raw.wallpapers : {},
    icons: raw?.icons && typeof raw.icons === "object" ? raw.icons : {},
  };
}

function setAsset(kind, key, dataUrl) {
  const a = loadAssets();
  const bucket = kind === "icon" ? a.icons : a.wallpapers;
  if (!dataUrl) delete bucket[key];
  else {
    if (!/^data:image\/(png|jpeg|webp|gif);base64,/.test(dataUrl)) throw new Error("只收 PNG / JPEG / WebP / GIF 图片");
    if (dataUrl.length > MAX_ASSET) throw new Error("图片太大了（压完还超过 3MB）");
    bucket[key] = dataUrl;
  }
  writeJson(ASSETS_PATH, a);
}

export function mountPhone(app, loadConfig) {
  const wrap = (fn) => async (req, res) => {
    try {
      const config = loadConfig();
      const out = await fn(req, config);
      res.json({ ok: true, ...(out ?? {}), state: publicState(config, req.params.roleId) });
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e?.message ?? e) });
    }
  };

  app.get("/api/phone/:roleId", wrap(() => null));

  // 壁纸是这个角色的；图标所有角色共用。dataUrl 传空 = 恢复默认
  app.post(
    "/api/phone/:roleId/assets",
    wrap((req, config) => {
      roleOr404(config, req.params.roleId);
      const kind = req.body?.kind === "icon" ? "icon" : "wallpaper";
      const key = kind === "icon" ? String(req.body?.appId ?? "") : req.params.roleId;
      if (kind === "icon" && !appsOf(config).some((a) => a.id === key)) throw new Error("没有这个 App");
      setAsset(kind, key, String(req.body?.dataUrl ?? ""));
    })
  );

  // body: { apps: [...ids], bookIds: [...] }。apps 不传 = 一键生成那一组
  app.post(
    "/api/phone/:roleId/generate",
    wrap((req, config) => {
      const role = roleOr404(config, req.params.roleId);
      const ids = Array.isArray(req.body?.apps) && req.body.apps.length ? req.body.apps : config.phone?.batchApps ?? DEFAULT_BATCH;
      const bookIds = Array.isArray(req.body?.bookIds) ? req.body.bookIds : undefined;
      // mode: "append"（默认，在原来的手机上接着加）| "reset"（整台手机换成新的一批）
      const mode = req.body?.mode === "reset" ? "reset" : "append";
      const title =
        ids.length > 1
          ? `${mode === "reset" ? "重置并重新生成" : "继续生成"}（${ids.length} 个 App）`
          : appsOf(config).find((a) => a.id === ids[0])?.name ?? ids[0];
      return { job: startJob(role.id, title, () => runGenerate(config, role, ids, { bookIds, mode })) };
    })
  );

  app.post(
    "/api/phone/:roleId/books",
    wrap((req, config) => {
      roleOr404(config, req.params.roleId);
      const s = loadState(req.params.roleId);
      s.bookIds = Array.isArray(req.body?.bookIds) ? req.body.bookIds.map(String) : [];
      saveState(req.params.roleId, s);
    })
  );

  // 删一条（itemId）或者清空一个 App（不带 itemId）
  app.delete(
    "/api/phone/:roleId/apps/:appId",
    wrap((req, config) => {
      roleOr404(config, req.params.roleId);
      const s = loadState(req.params.roleId);
      const itemId = String(req.query.item ?? "");
      if (itemId) s.apps[req.params.appId] = (s.apps[req.params.appId] ?? []).filter((x) => x.id !== itemId);
      else delete s.apps[req.params.appId];
      saveState(req.params.roleId, s);
    })
  );
}

export { PHONE_DIR };
