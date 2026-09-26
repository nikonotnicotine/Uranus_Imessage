/**
 * Instagram 的文件层：一个 owner 一个文件、原子写、读的时候算过期。
 *
 * 这个文件**只管「东西长什么样、存哪儿」**，不懂业务规则 —— 谁该评论谁、
 * 隔多久评论、提示词怎么拼，都在 instagram.js 里。分开是因为文件层要被
 * 三个地方用（HTTP 接口、互动队列、标签解析），混在一起会绕成环。
 *
 * ── owner 是什么 ──
 *
 * 一个 owner 就是「一个 IG 账号」，两种取值：
 *   "user"     用户自己
 *   角色名      每个角色一个（用名字不用 id，理由见 ownerKeyFor）
 *
 * ── 为什么不进 config.json ──
 *
 * `PUT /api/config` 会顺带重启所有 iMessage 桥接（见 index.js）。IG 是高频
 * 写入 —— 点一次赞、来一条评论都要落盘，走 config 等于每次互动把所有线路
 * 踢下线一次。壁纸当初单独开目录也是这个原因，这边更严重。
 *
 * ── 快拍过期是「读的时候算」 ──
 *
 * 不挂定时器：进程重启不会丢，用户改了存活时长立刻对所有已有快拍生效，
 * 而且没有「定时器到点了但进程正好没开」这种洞。代价是每次读都要过一遍
 * 时间比较 —— 快拍数量最多几十条，可以忽略。
 */

import fs from "node:fs";
import path from "node:path";

import {
  IG_HIGHLIGHTS_DIR,
  IG_MEDIA_DIR,
  IG_POSTS_DIR,
  IG_PROFILES_DIR,
  IG_STORIES_DIR,
  INSTAGRAM_DIR,
  ensureLayout,
} from "./datadir.js";
import { logWarn } from "./logs.js";

const SCOPE = "Instagram";

/** 用户自己那个 owner 的固定值。角色用角色名，不会撞上这个（角色名不会是 "user"…除非有人真起了这名字，见 ownerKeyFor 的兜底）。 */
export const USER_OWNER = "user";

/**
 * 快拍默认活多久（小时）。用户规范里写的 24 小时。
 * 存在 settings.json 里，可改 —— 0 表示永不过期（调试时有用）。
 */
export const DEFAULT_STORY_HOURS = 24;

/** 精选快拍最多几个。用户明确要求「最多三个」，手机版还不给滑。 */
export const MAX_HIGHLIGHTS = 3;

/**
 * 一条评论线程里角色之间最多来回几条。默认 2，用户给的示例正好是 2。
 * 这个值的**语义**见 instagram.js:threadReplyCount —— 首评不计。
 */
export const DEFAULT_MAX_CHAIN = 2;

/* ================= 文件名 ================= */

/**
 * owner → 文件名能用的一段。
 *
 * 角色名是用户随便填的（中文、emoji、斜杠都可能），不能直接当文件名。
 * 规则和 sessions.js:sessionIdFor 一个思路：能留的字符留着，剩下的整串
 * 编码成十六进制。中文名会整串走编码那一路 —— 文件名不好看，但唯一、
 * 不会撞、也不会变成路径穿越。
 *
 * **不能用角色 id**：IG 的 owner 要出现在提示词里（「阿瑞 评论了…」），
 * 而且用户可能想直接翻 data/instagram/posts/ 看谁的帖子。角色改名等于
 * 换一个 owner，帖子会「搬家」到新名字下 —— 和会话存档改名后开新会话
 * 是同一个已知取舍，界面上会说明。
 */
export function ownerKeyFor(owner) {
  const raw = String(owner ?? "").trim();
  if (!raw) return "";
  if (raw === USER_OWNER) return USER_OWNER;
  // 纯 ASCII 且不含路径字符的直接用，看着舒服
  if (/^[A-Za-z0-9 _-]+$/.test(raw) && raw !== USER_OWNER) {
    return raw.replace(/ +/g, "_");
  }
  return `c_${Buffer.from(raw, "utf-8").toString("hex").slice(0, 40)}`;
}

function fileIn(dir, owner) {
  const key = ownerKeyFor(owner);
  return key ? path.join(dir, `${key}.json`) : null;
}

/** 媒体文件名白名单。这个值会进 URL，必须卡死。 */
const SAFE_MEDIA = /^[A-Za-z0-9_.-]+$/;

export function mediaPathFor(file) {
  const name = String(file ?? "");
  if (!name || !SAFE_MEDIA.test(name) || name.includes("..")) return null;
  return path.join(IG_MEDIA_DIR, name);
}

/* ================= 底层读写 ================= */

/** 先 .tmp 再 rename：中途出事不会毁掉原文件（照抄 memorystore 的写法）。 */
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, "utf-8");
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  if (!file || !fs.existsSync(file)) return fallback;
  let text = "";
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (e) {
    logWarn(SCOPE, `${path.basename(file)} 读不出来，这次当空的用`, e);
    return fallback;
  }
  if (!text.trim()) return fallback;
  try {
    return JSON.parse(text);
  } catch (e) {
    // 不删也不改名：这是用户攒出来的内容，读不出来也得留着让他自己看
    logWarn(SCOPE, `${path.basename(file)} 不是合法 JSON，这次当空的用`, e);
    return fallback;
  }
}

function writeJson(file, value) {
  if (!file) return false;
  try {
    writeAtomic(file, JSON.stringify(value, null, 2));
    return true;
  } catch (e) {
    logWarn(SCOPE, `${path.basename(file)} 写不进去`, e);
    return false;
  }
}

let seq = 0;
/** 短 id。和 memorystore:newId 同一个写法。 */
export function newId(prefix) {
  seq = (seq + 1) % 100000;
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}`;
}

/* ================= 全局设置 ================= */

const SETTINGS_PATH = path.join(INSTAGRAM_DIR, "settings.json");

/**
 * 全局设置。提示词模板放在这儿而不是每个角色一份 —— 和记忆库那几段
 * 提示词一个规矩：一处改，所有角色共用。
 *
 * `promptTemplates` 留空字符串 = 用代码里的默认值（见 igprompt.js）。
 * 存空串而不是存默认文案，是为了让「改了默认值」能自动同步到没自定义的用户身上。
 *
 * 十个键分两类：前五个是**场景**（这一轮是因为什么被叫起来的），`action` /
 * `peerAction` 是压在最底下那句**行动指令**，`compose` 是主动发帖那一轮的，
 * `browse` / `browseAction` 是「定时刷 IG」那一轮的场景和行动指令。
 * 行动指令分两条是因为对人和对角色的输出形态不一样：对着 {{user}} 的帖子
 * 可以「评论 + 私聊」，对着别的角色只能留评论 —— 角色间互动按用户定的规矩
 * 不触发 iMessage 回复。
 */
export function defaultSettings() {
  return {
    storyHours: DEFAULT_STORY_HOURS,
    // 界面默认按哪个版式画。"auto" = 跟窗口宽度走
    defaultView: "auto",
    promptTemplates: {
      userPost: "",
      userStory: "",
      userComment: "",
      charPost: "",
      charComment: "",
      action: "",
      peerAction: "",
      compose: "",
      browse: "",
      browseAction: "",
    },
  };
}

export function readSettings() {
  ensureLayout();
  const raw = readJson(SETTINGS_PATH, null);
  const def = defaultSettings();
  if (!raw || typeof raw !== "object") return def;
  const hours = Number(raw.storyHours);
  return {
    storyHours: Number.isFinite(hours) && hours >= 0 && hours <= 720 ? hours : def.storyHours,
    defaultView: ["auto", "mobile", "desktop"].includes(raw.defaultView)
      ? raw.defaultView
      : def.defaultView,
    promptTemplates: {
      ...def.promptTemplates,
      ...(raw.promptTemplates && typeof raw.promptTemplates === "object"
        ? raw.promptTemplates
        : {}),
    },
  };
}

export function writeSettings(patch) {
  ensureLayout();
  const next = { ...readSettings(), ...(patch ?? {}) };
  if (patch?.promptTemplates) {
    next.promptTemplates = { ...readSettings().promptTemplates, ...patch.promptTemplates };
  }
  writeJson(SETTINGS_PATH, next);
  return next;
}

/* ================= 主页资料 ================= */

/**
 * 一份主页资料。
 *
 * 三个计数（posts / followers / following）存的是**字符串**，空串 = 显示真实
 * 数量。存字符串是刻意的：IG 上大号显示的是「1,137万」这种，用户想照抄一个
 * 就得能填任意文本；真要数字的场合（真实帖子数）由前端自己数。
 */
export function defaultProfile(owner) {
  const name = owner === USER_OWNER ? "" : String(owner ?? "");
  return {
    owner: String(owner ?? ""),
    // 显示名（IG 上头像下面那行粗体）
    name,
    // @账号。留空时前端拿 name 兜底
    username: "",
    avatar: "",
    bio: "",
    link: "",
    posts: "",
    followers: "",
    following: "",
    // 蓝勾
    verified: false,
  };
}

export function readProfile(owner) {
  ensureLayout();
  const raw = readJson(fileIn(IG_PROFILES_DIR, owner), null);
  const def = defaultProfile(owner);
  if (!raw || typeof raw !== "object") return def;
  const str = (v, d = "") => (typeof v === "string" ? v : d);
  return {
    ...def,
    name: str(raw.name, def.name),
    username: str(raw.username),
    avatar: str(raw.avatar),
    bio: str(raw.bio),
    link: str(raw.link),
    posts: str(raw.posts),
    followers: str(raw.followers),
    following: str(raw.following),
    verified: Boolean(raw.verified),
  };
}

export function writeProfile(owner, patch) {
  ensureLayout();
  const next = { ...readProfile(owner), ...(patch ?? {}), owner: String(owner ?? "") };
  writeJson(fileIn(IG_PROFILES_DIR, owner), next);
  return next;
}

/* ================= 帖子 ================= */

/**
 * 一条帖子长这样：
 * {
 *   id, owner, caption,
 *   images: [{ file, alt }],     file 是 media/ 下的文件名；alt 是生图用的描述
 *   createdAt: ISO,
 *   likes: ["user", "阿瑞"],  谁点了赞（owner 值）
 *   comments: [{ id, owner, text, at, replyTo, likes: [] }],
 *   visionNote: ""               识图结果，见下
 * }
 *
 * `visionNote` 是**识图缓存**：用户发的帖子带真图片时，第一个要评论的角色
 * 先过一次识图，结果写回这里，后面所有角色直接读 —— 五个角色各识一次是
 * 白花四次钱。帖子超过存活期（24 小时）之后这个字段会被清掉（见
 * `pruneVisionNotes`）：那之后没人会再评论它了，留着只是占地方。
 *
 * `comments` 是**平铺**的，靠 `replyTo` 指向父评论 id 表达层级 —— IG 的评论
 * 只有两层（评论 + 回复），平铺比嵌套好改（删一条不用重整树）。
 *
 * `remote` 是**真 Instagram 上那一份的坐标**（见 `normalizeRemote`）。本地这条
 * 永远是主本，`remote` 只是「它在真 IG 上也有一份」的注记 —— 没绑真号的用户
 * 这个字段一直是空的，读不到它的代码路径照样跑。
 */
export function readPosts(owner) {
  ensureLayout();
  const list = readJson(fileIn(IG_POSTS_DIR, owner), []);
  if (!Array.isArray(list)) return [];
  return list.filter((p) => p && typeof p === "object").map(normalizePost);
}

/**
 * 真 Instagram 上那一份的坐标。
 *
 * 全空（`mediaId` 是空串）= 这条只在本地存在，绝大多数情况都是这样。
 *
 *   mediaId    Meta 那边的 media id / comment id。**回写它是幂等的关键** ——
 *              有了它就知道「这条已经发过了」，重跑不会发第二遍
 *   permalink  真帖子的网址，本地面板上可以点开看
 *   at         同步成功的时刻（ISO），界面上显示「已同步」
 *   error      上一次同步失败的原因（中文）。成功一次就清空
 *
 * 为什么不单独存一份映射表：那就要维护两份东西的一致性（删了帖子要记得去删
 * 映射），而这个字段跟着帖子走，帖子没了它自然也没了。
 */
function normalizeRemote(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    mediaId: String(r.mediaId ?? ""),
    permalink: String(r.permalink ?? ""),
    at: String(r.at ?? ""),
    error: String(r.error ?? ""),
  };
}

function normalizePost(raw) {
  const images = Array.isArray(raw.images)
    ? raw.images
        .map((im) =>
          typeof im === "string"
            ? { file: im, alt: "" }
            : { file: String(im?.file ?? ""), alt: String(im?.alt ?? "") }
        )
        .filter((im) => im.file || im.alt)
    : [];
  return {
    id: String(raw.id ?? newId("p")),
    owner: String(raw.owner ?? ""),
    caption: String(raw.caption ?? ""),
    images,
    createdAt: String(raw.createdAt ?? new Date().toISOString()),
    likes: Array.isArray(raw.likes) ? raw.likes.map(String) : [],
    comments: Array.isArray(raw.comments)
      ? raw.comments.filter((c) => c && typeof c === "object").map(normalizeComment)
      : [],
    visionNote: String(raw.visionNote ?? ""),
    remote: normalizeRemote(raw.remote),
  };
}

function normalizeComment(raw) {
  return {
    id: String(raw.id ?? newId("cm")),
    owner: String(raw.owner ?? ""),
    text: String(raw.text ?? ""),
    at: String(raw.at ?? new Date().toISOString()),
    // 空 = 顶层评论；有值 = 回复那条评论
    replyTo: String(raw.replyTo ?? ""),
    likes: Array.isArray(raw.likes) ? raw.likes.map(String) : [],
    remote: normalizeRemote(raw.remote),
  };
}

export function writePosts(owner, list) {
  ensureLayout();
  return writeJson(fileIn(IG_POSTS_DIR, owner), Array.isArray(list) ? list : []);
}

/** 新帖排在最前面 —— feed 和九宫格都是新的在上。 */
export function addPost(owner, input) {
  const list = readPosts(owner);
  const post = normalizePost({
    ...input,
    id: newId("p"),
    owner,
    createdAt: input?.createdAt || new Date().toISOString(),
  });
  list.unshift(post);
  writePosts(owner, list);
  return post;
}

export function updatePost(owner, id, patch) {
  const list = readPosts(owner);
  const i = list.findIndex((p) => p.id === id);
  if (i < 0) return null;
  list[i] = normalizePost({ ...list[i], ...(patch ?? {}), id, owner });
  writePosts(owner, list);
  return list[i];
}

/**
 * 删一条帖子。**顺带删掉它引用的图片文件** —— 不删的话 media/ 会无限长。
 * 图片被别的帖子共用时不删（用户可能把同一张图发了两次）。
 */
export function removePost(owner, id) {
  const list = readPosts(owner);
  const post = list.find((p) => p.id === id);
  if (!post) return false;
  writePosts(
    owner,
    list.filter((p) => p.id !== id)
  );
  dropUnusedMedia(post.images.map((im) => im.file));
  return true;
}

/* ================= 快拍 ================= */

/**
 * 一条快拍：
 * { id, owner, caption, image: { file, alt }, createdAt, viewers: [], likes: [] }
 *
 * 没有 `expiresAt` 字段 —— 过期是**算出来的**（createdAt + settings.storyHours）。
 * 存死一个时刻的话，用户把存活时长从 24 小时改成 48 小时，已有的快拍不会跟着变。
 *
 * `visionNote` 和帖子那边是同一个东西（识图缓存），理由也一样：几个角色都要
 * 看同一张图，识一次够了。igprompt.js:snapshot 读的是 `item.visionNote`，
 * 帖子和快拍走的是同一行代码。
 */
export function readStories(owner) {
  ensureLayout();
  const list = readJson(fileIn(IG_STORIES_DIR, owner), []);
  if (!Array.isArray(list)) return [];
  return list.filter((s) => s && typeof s === "object").map(normalizeStory);
}

function normalizeStory(raw) {
  const im = raw.image;
  return {
    id: String(raw.id ?? newId("s")),
    owner: String(raw.owner ?? ""),
    caption: String(raw.caption ?? ""),
    image:
      typeof im === "string"
        ? { file: im, alt: "" }
        : { file: String(im?.file ?? ""), alt: String(im?.alt ?? "") },
    createdAt: String(raw.createdAt ?? new Date().toISOString()),
    likes: Array.isArray(raw.likes) ? raw.likes.map(String) : [],
    // 收到的回复（快拍底部那些气泡）
    replies: Array.isArray(raw.replies)
      ? raw.replies.filter((r) => r && typeof r === "object").map(normalizeComment)
      : [],
    visionNote: String(raw.visionNote ?? ""),
    remote: normalizeRemote(raw.remote),
  };
}

export function writeStories(owner, list) {
  ensureLayout();
  return writeJson(fileIn(IG_STORIES_DIR, owner), Array.isArray(list) ? list : []);
}

export function addStory(owner, input) {
  const list = readStories(owner);
  const story = normalizeStory({
    ...input,
    id: newId("s"),
    owner,
    createdAt: input?.createdAt || new Date().toISOString(),
  });
  // 快拍按时间正序播（先发的先看），所以追加在后面
  list.push(story);
  writeStories(owner, list);
  return story;
}

export function updateStory(owner, id, patch) {
  const list = readStories(owner);
  const i = list.findIndex((s) => s.id === id);
  if (i < 0) return null;
  list[i] = normalizeStory({ ...list[i], ...(patch ?? {}), id, owner });
  writeStories(owner, list);
  return list[i];
}

export function removeStory(owner, id) {
  const list = readStories(owner);
  const story = list.find((s) => s.id === id);
  if (!story) return false;
  writeStories(
    owner,
    list.filter((s) => s.id !== id)
  );
  // 存进精选的快拍不能把图删了 —— 精选里还要显示
  if (!highlightUsesFile(owner, story.image.file)) dropUnusedMedia([story.image.file]);
  return true;
}

/**
 * 这条快拍过期了没有。
 *
 * `hours = 0` 表示永不过期。这个判断是所有「快拍还在不在」的唯一出处 ——
 * feed、主页、播放器全走它，不会出现两处规则不一致。
 */
export function storyExpired(story, hours, now = Date.now()) {
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0) return false;
  const at = Date.parse(story?.createdAt ?? "");
  if (!Number.isFinite(at)) return false;
  return now - at >= h * 3600_000;
}

/** 还活着的快拍（按时间正序）。 */
export function activeStories(owner, hours, now = Date.now()) {
  return readStories(owner)
    .filter((s) => !storyExpired(s, hours, now))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/** 已经过期的（用户自己的去主页找、角色的点头像看）。新的在前。 */
export function expiredStories(owner, hours, now = Date.now()) {
  return readStories(owner)
    .filter((s) => storyExpired(s, hours, now))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/* ================= 精选快拍 ================= */

/**
 * 一组精选：{ id, owner, title, cover, storyIds: [] }
 *
 * `cover` 是 media/ 下的文件名（用户自己挑，不自动取第一张 —— 用户明确说
 * 「让用户自己设置图片和文字」）。最多 MAX_HIGHLIGHTS 组。
 */
export function readHighlights(owner) {
  ensureLayout();
  const list = readJson(fileIn(IG_HIGHLIGHTS_DIR, owner), []);
  if (!Array.isArray(list)) return [];
  return list
    .filter((h) => h && typeof h === "object")
    .map((h) => ({
      id: String(h.id ?? newId("h")),
      owner: String(h.owner ?? owner ?? ""),
      title: String(h.title ?? ""),
      cover: String(h.cover ?? ""),
      storyIds: Array.isArray(h.storyIds) ? h.storyIds.map(String) : [],
    }))
    .slice(0, MAX_HIGHLIGHTS);
}

export function writeHighlights(owner, list) {
  ensureLayout();
  return writeJson(
    fileIn(IG_HIGHLIGHTS_DIR, owner),
    (Array.isArray(list) ? list : []).slice(0, MAX_HIGHLIGHTS)
  );
}

/**
 * 把一条快拍存进精选。
 *
 * 没给 `highlightId` 就新建一组（满了返回 null，由调用方提示用户先删一个）；
 * 给了就往那组里加。同一条快拍重复存不会加两次。
 */
export function saveToHighlight(owner, storyId, { highlightId = "", title = "", cover = "" } = {}) {
  const list = readHighlights(owner);
  const story = readStories(owner).find((s) => s.id === storyId);
  if (!story) return null;

  if (highlightId) {
    const h = list.find((x) => x.id === highlightId);
    if (!h) return null;
    if (!h.storyIds.includes(storyId)) h.storyIds.push(storyId);
    if (title) h.title = title;
    if (cover) h.cover = cover;
    writeHighlights(owner, list);
    return h;
  }

  if (list.length >= MAX_HIGHLIGHTS) return null;
  const fresh = {
    id: newId("h"),
    owner: String(owner ?? ""),
    title: title || "精选",
    // 没指定封面就用这条快拍自己的图 —— 用户可以在编辑里换
    cover: cover || story.image.file,
    storyIds: [storyId],
  };
  list.push(fresh);
  writeHighlights(owner, list);
  return fresh;
}

export function removeHighlight(owner, id) {
  const list = readHighlights(owner);
  if (!list.some((h) => h.id === id)) return false;
  writeHighlights(
    owner,
    list.filter((h) => h.id !== id)
  );
  return true;
}

/** 某个文件是不是被精选用着（封面或里面的快拍）。删图前问一句。 */
function highlightUsesFile(owner, file) {
  if (!file) return false;
  const list = readHighlights(owner);
  if (list.some((h) => h.cover === file)) return true;
  const stories = readStories(owner);
  const ids = new Set(list.flatMap((h) => h.storyIds));
  return stories.some((s) => ids.has(s.id) && s.image.file === file);
}

/* ================= 互动记录（右上角那个爱心） ================= */

const ACTIVITY_PATH = path.join(INSTAGRAM_DIR, "activity.json");
/** 互动流最多留多少条。翻到几千条没人看，只会让读写变慢。 */
const ACTIVITY_MAX = 500;

/**
 * 一条互动：
 * { id, kind: "like" | "comment" | "reply" | "storyLike" | "storyReply",
 *   actor, target: { owner, postId?, storyId?, commentId? }, text, at, read }
 *
 * 只记**别人对用户**的互动 —— 那个爱心页面是「我的帖子的互动」。角色之间
 * 互相评论不进这里（那个进上下文和待总结，见 instagram.js）。
 */
export function readActivity() {
  ensureLayout();
  const list = readJson(ACTIVITY_PATH, []);
  return Array.isArray(list) ? list.filter((a) => a && typeof a === "object") : [];
}

export function addActivity(entry) {
  const list = readActivity();
  const item = {
    id: newId("a"),
    kind: String(entry?.kind ?? "like"),
    actor: String(entry?.actor ?? ""),
    target: entry?.target && typeof entry.target === "object" ? entry.target : {},
    text: String(entry?.text ?? ""),
    at: String(entry?.at ?? new Date().toISOString()),
    read: false,
  };
  list.unshift(item);
  writeJson(ACTIVITY_PATH, list.slice(0, ACTIVITY_MAX));
  return item;
}

export function markActivityRead() {
  const list = readActivity().map((a) => ({ ...a, read: true }));
  writeJson(ACTIVITY_PATH, list);
  return list;
}

/* ================= 互动队列 ================= */

const QUEUE_PATH = path.join(INSTAGRAM_DIR, "queue.json");

/**
 * 排着的互动任务：
 * { id, at: 毫秒时间戳, roleId, kind, postOwner, postId, storyId, commentId, chain, since }
 *
 * `kind: "browse"` 是「定时刷 IG」那一轮（igrun.js:runBrowse），每个角色队列里
 * 常驻一条，跑完自己排下一条。`since` 只有它用：上一次刷是几点，用来标
 * 「这条是新的」、以及一点新动静都没有时不打模型。
 *
 * **落盘**而不是只放内存里（主动消息那套是纯内存的）：等待窗口是 30–120 分钟，
 * 大概率跨一次重启。静默丢掉的话用户发了帖等半天没人理，还查不出原因。
 *
 * `chain` 是这条线程已经来回了几次（角色间互动的 N 上限用它数，见
 * instagram.js:threadReplyCount）。
 */
export function readQueue() {
  ensureLayout();
  const list = readJson(QUEUE_PATH, []);
  if (!Array.isArray(list)) return [];
  return list
    .filter((t) => t && typeof t === "object")
    .map((t) => ({
      id: String(t.id ?? newId("q")),
      at: Number(t.at) || 0,
      roleId: String(t.roleId ?? ""),
      kind: String(t.kind ?? ""),
      postOwner: String(t.postOwner ?? ""),
      postId: String(t.postId ?? ""),
      storyId: String(t.storyId ?? ""),
      commentId: String(t.commentId ?? ""),
      chain: Number(t.chain) || 0,
      since: Number(t.since) || 0,
    }));
}

export function writeQueue(list) {
  ensureLayout();
  return writeJson(QUEUE_PATH, Array.isArray(list) ? list : []);
}

export function pushQueue(task) {
  const list = readQueue();
  const item = { ...task, id: newId("q"), at: Number(task?.at) || Date.now() };
  list.push(item);
  writeQueue(list);
  return item;
}

export function dropQueue(id) {
  const list = readQueue();
  const next = list.filter((t) => t.id !== id);
  if (next.length === list.length) return false;
  writeQueue(next);
  return true;
}

/** 到点了的任务（按时间正序，先排的先跑）。 */
export function dueTasks(now = Date.now()) {
  return readQueue()
    .filter((t) => t.at <= now)
    .sort((a, b) => a.at - b.at);
}

/* ================= 媒体文件 ================= */

/**
 * 存一张图，返回文件名。
 *
 * 文件名是随机 id + 后缀 —— 用户不该去翻这个目录（和 images/ 那边刻意让人
 * 按名字摆文件正好相反），所以不用管好不好认。
 */
export function saveMedia(base64, ext = "png") {
  ensureLayout();
  const safeExt = /^[A-Za-z0-9]{1,5}$/.test(String(ext)) ? String(ext).toLowerCase() : "png";
  const file = `${newId("ig")}.${safeExt}`;
  try {
    fs.writeFileSync(path.join(IG_MEDIA_DIR, file), Buffer.from(String(base64 ?? ""), "base64"));
    return file;
  } catch (e) {
    logWarn(SCOPE, "图片没能存下来", e);
    return "";
  }
}

/**
 * 现在还有人引用的图片文件名。
 *
 * 全量扫一遍所有 owner 的帖子、快拍、精选和**资料卡** —— 帖子数量级是几百，
 * 一次 readdir 加几次 JSON.parse，只在删东西和清理时才跑，不值得为它维护
 * 引用计数。
 *
 * **profiles 那一份不能漏**：头像走的是同一个 media/ 目录（前端上传头像打的
 * 是 `POST /api/ig/media`），漏掉的话删一条帖子就可能把某个角色的头像顺手
 * 删了，界面上直接变成裂图。
 */
function usedMediaFiles() {
  const used = new Set();
  const add = (f) => {
    const name = String(f ?? "").trim();
    if (name) used.add(name);
  };

  for (const dir of [IG_POSTS_DIR, IG_STORIES_DIR, IG_HIGHLIGHTS_DIR]) {
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
    } catch {
      continue;
    }
    for (const n of names) {
      const list = readJson(path.join(dir, n), []);
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (!item || typeof item !== "object") continue;
        add(item.cover);
        if (item.image) add(item.image?.file ?? item.image);
        for (const im of Array.isArray(item.images) ? item.images : []) {
          add(im?.file ?? im);
        }
      }
    }
  }

  // 资料卡里的头像。这里存的是一个对象、不是数组，所以单独一段
  let profileNames = [];
  try {
    profileNames = fs.readdirSync(IG_PROFILES_DIR).filter((n) => n.endsWith(".json"));
  } catch {
    profileNames = [];
  }
  for (const n of profileNames) {
    const p = readJson(path.join(IG_PROFILES_DIR, n), null);
    if (p && typeof p === "object") add(p.avatar);
  }

  return used;
}

/** 删掉没人再引用的图片文件（给的那几个里挑）。 */
function dropUnusedMedia(files) {
  const want = (files ?? []).filter(Boolean);
  if (!want.length) return;

  const used = usedMediaFiles();
  for (const f of want) {
    if (used.has(f)) continue;
    const p = mediaPathFor(f);
    if (!p) continue;
    try {
      fs.rmSync(p, { force: true });
    } catch (e) {
      logWarn(SCOPE, `${f} 删不掉（不影响功能）`, e);
    }
  }
}

/**
 * 把 media/ 里没人引用的图片全删了，返回删掉几个、腾出多少字节。
 *
 * ── 为什么需要这个、而不是只靠删帖时顺手删 ──
 *
 * `dropUnusedMedia` 只在删帖 / 删快拍那一刻跑，所以有几条路会漏下垃圾：
 *
 *   · 模型出了图，但那条内容配文和描述都空 → 不落盘（igrun.js:351），图留下了
 *   · 真 IG 拉回来的图下好了，但那条帖子后来没能落盘
 *   · 用户在编辑器里换掉一张图（旧文件从 images 里消失，但没走删帖那条路）
 *   · 历史遗留：这个功能上线前攒下的
 *
 * 单个文件几十 KB，一天几条内容的话涨得很慢，但它**只涨不落** —— 所以给
 * 控制台的「清理缓存」挂一条。
 *
 * ── 为什么放在这里而不是 index.js ──
 *
 * 「哪些文件算在用」的规则（帖子 / 快拍 / 精选封面 / 头像）只有这个文件知道，
 * 规则漏一处就会误删用户的图。让路由层去拼这套规则，早晚会和这里走散。
 *
 * 只删 media/ 目录下的**文件**，认不出扩展名的也删 —— 那个目录里除了我们
 * 自己写进去的图片不该有别的东西。子目录一律不碰（没有子目录，但万一）。
 */
export function pruneOrphanMedia() {
  ensureLayout();
  const out = { removed: 0, bytes: 0, kept: 0 };

  let names = [];
  try {
    names = fs.readdirSync(IG_MEDIA_DIR);
  } catch {
    return out;
  }
  if (!names.length) return out;

  const used = usedMediaFiles();
  for (const name of names) {
    if (used.has(name)) {
      out.kept += 1;
      continue;
    }
    const p = mediaPathFor(name);
    // mediaPathFor 会挡住奇怪的文件名（路径穿越那一类），挡下来的不动它
    if (!p) continue;
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) continue;
      fs.rmSync(p, { force: true });
      out.removed += 1;
      out.bytes += st.size;
    } catch (e) {
      logWarn(SCOPE, `${name} 删不掉（不影响功能）`, e);
    }
  }
  return out;
}

/* ================= 维护 ================= */

/**
 * 清掉过期内容的识图缓存。
 *
 * 帖子超过快拍存活期（默认 24 小时）之后不会再有人评论它，`visionNote`
 * 留着只是占地方 —— 用户明确要求过「超过 24 小时这个识图结果就可以删了」。
 * 每次跑队列时顺手调一次，不单独挂定时器。
 *
 * 快拍一起清：过期的快拍还留在文件里（用户能在自己主页翻到），但同样不会
 * 再有人对着它说话了。
 */
export function pruneVisionNotes(owners, hours, now = Date.now()) {
  const h = Number(hours) > 0 ? Number(hours) : DEFAULT_STORY_HOURS;
  const stale = (iso) => {
    const at = Date.parse(iso);
    return Number.isFinite(at) && now - at >= h * 3600_000;
  };
  for (const owner of owners ?? []) {
    const list = readPosts(owner);
    let dirty = false;
    for (const p of list) {
      if (!p.visionNote) continue;
      if (stale(p.createdAt)) {
        p.visionNote = "";
        dirty = true;
      }
    }
    if (dirty) writePosts(owner, list);

    const stories = readStories(owner);
    let sdirty = false;
    for (const s of stories) {
      if (!s.visionNote) continue;
      if (stale(s.createdAt)) {
        s.visionNote = "";
        sdirty = true;
      }
    }
    if (sdirty) writeStories(owner, stories);
  }
}
