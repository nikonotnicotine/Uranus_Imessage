/**
 * 真 Instagram 的**凭据和设置**：一个角色一条账号记录，外加一份全局的
 * 图床凭据、轮询节奏和可互动白名单。
 *
 * ── 为什么不进 config.json ──
 *
 * 两条理由，任一条都足够：
 *
 * 1. `PUT /api/config` 会顺带 syncBridges，把所有 Photon 线路重启一遍。
 *    token 是**会自己变的东西**（60 天到期，程序自动续期，每次续期写一次盘）
 *    —— 走 config 的话每次续期都会把用户的号踢下线。
 * 2. 角色对象会被 `backup.js:buildBundle` 原样打进**可分享**的备份包。
 *    access token 进了角色就等于进了备份包，一次「把我的角色发你」
 *    就把真 IG 账号的写权限送出去了。
 *
 * 所以这里和 igstore.js 是同一个路子：自己管 `data/instagram/`，
 * 跟 config.json 不相干。`data/` 整个在 .gitignore 里。
 *
 * ── 为什么不进 data.config.json ──
 *
 * 那个文件由 config.js:writeToDisk **整份重写**（providerKeys / projects /
 * weatherKeys / …），每次保存配置都会覆盖一遍。token 续期和保存配置这两件事
 * 谁先谁后是不确定的，挤在同一个文件里迟早互相盖掉。
 *
 * ── 手动粘 token，不做 OAuth ──
 *
 * 用户定的。OAuth 要一个公网 HTTPS 的 redirect URI，那意味着 Cloudflare
 * Tunnel 或者反代 —— 为了一次性的授权动作常驻一个隧道进程不值得。
 * Meta 开发者后台的 App Dashboard 里有「Generate token」按钮，点出来的就是
 * 60 天长效 token，粘进来即可。续期是**纯 GET**（refresh_access_token），
 * 不需要任何公网入口。
 */

import fs from "node:fs";
import path from "node:path";

import { INSTAGRAM_DIR, ensureLayout, readJson } from "./datadir.js";
import { logWarn } from "./logs.js";

const SCOPE = "Instagram";

const ACCOUNTS_PATH = path.join(INSTAGRAM_DIR, "accounts.json");

/** 长效 token 的寿命：60 天。Meta 那边返回的 expires_in 也是这个数。 */
export const TOKEN_DAYS = 60;

/**
 * 提前几天续期。
 *
 * Meta 的规矩是「token 至少存活 24 小时才能续、过期了就不能续」。留 7 天余量
 * 是给「进程好几天没开」兜底 —— 用户周末不开电脑，周一开机时还来得及续。
 * 卡到最后一天才续的话，一次长假就能让 token 彻底失效、必须重新手动粘。
 */
export const REFRESH_BEFORE_DAYS = 7;

/* ================= 默认值 ================= */

/**
 * 轮询节奏 + 勿扰 + 白名单 + 图床，一份全局的。
 *
 * `intervalHours` 默认 3：用户定的「默认每天每隔 3 个小时轮询一次」。
 * 轮询是**为了收到你在真 IG 上的评论**（Meta 没有「新帖子」webhook，评论
 * webhook 又要公网入口），所以它的频率直接决定「你留言之后多久有人回」。
 * 3 小时是省额度和体感之间的折中，用户可以自己调。
 *
 * `dnd` 勿扰时段默认 23:00–09:00，用户定的。跨零点算数（和
 * config.js:normalizeProactive 里那个 focus 一个语义）。为什么轮询也要勿扰：
 * 拉到一条你的新评论 → 角色排队回复 → 那一轮**可能顺带发一条短信**
 * （runIgTask 的 dm 分支）。半夜被角色的 IG 回复吵醒和被主动消息吵醒是
 * 同一件事，该守同一条规矩。
 *
 * `allowFrom` 是**可互动账号白名单**，一条一个 `{ name, username }`（见
 * `normalizeAllowEntry`）。空数组 = 谁都不理，只把评论镜像进本地。这是刻意的
 * 默认：角色的小号是公开的，任何陌生人都能在下面留言，而「角色自动回复陌生人」
 * 既烧钱又可能说出不该说的话。用户的原话是「设置可互动的账户白名单，免得回复
 * 其他人」「陌生人不要让 LLM 回复」。
 *
 * `syncUser` 是「把**你自己**真 IG 上的帖子和快拍镜像进本地」。默认关，
 * 用户定的（「用户的 IG 默认不进行同步」）。开了要额外一条大号 token，
 * 而且会把你的真实生活内容喂给模型 —— 那得是明确的选择，不是默认。
 */
export function defaultSettings() {
  return {
    // 轮询间隔（小时）。0 = 不轮询（等于只发不收）
    intervalHours: 3,
    // 勿扰时段：这段时间里不轮询、不回评论、不发帖
    dnd: { enabled: true, start: "23:00", end: "09:00" },
    // 可互动的 IG 账号：[{ name: "小明", username: "myigaccount" }]。空 = 只镜像不回复
    allowFrom: [],
    // 把你自己真 IG 的帖子 / 快拍镜像进本地（要大号 token）
    syncUser: false,
    // 上一次轮询的时刻（毫秒）。落盘是为了跨重启不重复拉
    lastPollAt: 0,
    /**
     * Mentions 接口试过、不通。
     *
     * 角色互评要靠它（帖主铺一条 @ 当通行证，被 @ 的人才能在别人帖子下说话），
     * 而这个接口的文档写在**老路线**（Facebook 主页）下，我们走的是 Instagram
     * Login —— Meta 没明说新路线支持它。
     *
     * 一旦试失败就把这个置成 true，之后角色互评只走本地。理由是失败的代价不
     * 对称：铺路那条 `@某人` 评论**已经发出去了**，真 IG 的评论区会留下一句
     * 没有下文的 @。留一次可以接受（看起来像作者叫朋友来看），每轮都留就成了
     * 噪音。用户在界面上可以重置这个状态再试。
     */
    mentionsBroken: false,
    // 图床：Cloudinary。发布时把图传上去拿公网 URL，Meta 下载完就删
    imageHost: {
      provider: "cloudinary",
      cloudName: "",
      apiKey: "",
      apiSecret: "",
    },
  };
}

/**
 * 一条账号记录。
 *
 * `roleName` 而不是 roleId：IG 这一整套（igstore 的 owner、提示词里的名字、
 * 文件名）都是拿**角色名**当标识的，见 igstore.js:ownerKeyFor 的注释。
 * 这里跟着用同一个键，才能和本地那份对得上。代价一样：角色改名等于换账号，
 * 得重新绑。
 *
 * `userId` / `username` 是授权之后 `GET /me` 拿回来的，用户不用手填。
 * `expiresAt` 是**算出来的**（拿到 token 那一刻 + expires_in），存绝对时刻
 * 而不是剩余秒数 —— 后者一重启就不准了。
 */
export function defaultAccount(roleName) {
  return {
    roleName: String(roleName ?? ""),
    // 手动粘进来的长效 token
    token: "",
    // GET /me?fields=user_id,username 自动填
    userId: "",
    username: "",
    // token 到期的绝对时刻（毫秒）。0 = 还没探过
    expiresAt: 0,
    // 上一次续期成功的时刻，界面上显示「上次续期」
    refreshedAt: 0,
    // 上一次出错的原因（中文），界面上红字显示。成功一次就清空
    lastError: "",
    // 24 小时发布配额的本地计数器：[时间戳, …]，只留 24 小时内的
    publishedAt: [],
  };
}

/* ================= 读写 ================= */

function normalizeClock(input, fallback) {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(input ?? "").trim());
  if (!m) return fallback;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return fallback;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function num(input, fallback, lo, hi) {
  const n = Number(input);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * IG 用户名规范化。
 *
 * 白名单是用户手填的，会带上 `@`、带空格、带大小写。IG 的用户名规则是
 * 「字母数字下划线句点、不超过 30 字符、大小写不敏感」，所以统一小写、
 * 剔掉不合规的字符 —— 存进去的形态和 API 回来的 `username` 一致，
 * 比对时不用再折腾一遍。
 */
export function normalizeUsername(input) {
  return String(input ?? "")
    .trim()
    .replace(/^@+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9._]/g, "")
    .slice(0, 30);
}

/**
 * 一段文字里 @ 了哪些 IG 用户名（小写、去重、按出现顺序）。
 *
 * ── 这个函数是「用户手动 @ 角色」那条链路的入口 ──
 *
 * Graph API 判断「能不能在这条媒体下发言」只看你是不是媒体的主人，唯一的例外
 * 是**被 @ 过**：被 @ 的人可以打 `POST /{自己的ig-id}/mentions` 进去说一句。
 * 角色互评是我们程序替帖主铺那条 @（igreal.js:peerComment），而用户在自己真 IG
 * 的帖子下**手动**打一句 `@某个角色`，效果完全一样 —— 那就是一张通行证。
 *
 * 所以要有人去认这张通行证，认的就是这里。两个地方会调：
 *   · 帖子的**配文**里（igrun.js:schedulePublish）—— 这条今天就能用
 *   · 帖子的**评论**里（igreal.js:syncUserMentionsIn）—— 要评论读权限
 *
 * ── 尾部的点和下划线要剃掉 ──
 *
 * IG 用户名允许中间带 `.` 和 `_`，但一句话里的 `@charlie。` / `@charlie.` 那个
 * 点大概率是标点不是名字的一部分。不剃的话 `@charlie.` 匹配出 `charlie.`，
 * 和账号里存的 `charlie` 对不上，整条通行证就白瞎了 —— 而用户看着自己明明
 * @ 了却没人应答，只会以为功能坏了。
 *
 * 剃过头的风险（真有人叫 `charlie.`）不存在：IG 不允许用户名以点结尾。
 *
 * ── 邮箱地址不算 ──
 *
 * `me@x.com` 里那个 `@` 不是提及，`x.com` 也不是谁的用户名。判据是 `@` **前面
 * 紧挨着字母数字** —— 真正的提及前面是空白、标点或者行首。不排掉的话配文里
 * 写个联系邮箱就会凭空多出一个「被点名的人」，而它多半谁也对不上，白跑一趟。
 *
 * @param {string} text
 * @returns {string[]} 规范化过的用户名，形态和 `normalizeUsername` 一致
 */
export function mentionedHandles(text) {
  const out = [];
  // (^|[^A-Za-z0-9]) = 行首，或者前面那个字符不是字母数字（排掉邮箱的 xx@）
  for (const m of String(text ?? "").matchAll(/(^|[^A-Za-z0-9])@([A-Za-z0-9._]{1,30})/g)) {
    let handle = m[2].toLowerCase();
    while (handle && /[._]$/.test(handle)) handle = handle.slice(0, -1);
    if (handle && !out.includes(handle)) out.push(handle);
  }
  return out;
}

/**
 * IG 用户名 → 角色名，只收**已经绑好**的角色小号。
 *
 * 用途是把一条 `@某人` 认成「@ 的是本地哪个角色」。没绑号的角色不在里面 ——
 * 它压根没有真 IG 用户名可以被 @。
 */
export function roleHandleMap(data) {
  const out = new Map();
  for (const acc of Object.values(data?.accounts ?? {})) {
    if (acc.username && acc.roleName) out.set(acc.username, acc.roleName);
  }
  return out;
}

/**
 * 白名单的一条：`{ name, username }`。
 *
 * ── 为什么要存个显示名 ──
 *
 * 真 IG 的用户名是给机器看的（`myigaccount`、`someone_else`），模型看见这种
 * 串既费 token 又念不出来，还会在评论里学着叫「@someone_else」。所以白名单里
 * 一条记两样：`username` 用来**对上是谁**（和 Meta 回来的 `username` 一个形态），
 * `name` 是**给模型看的那个名字**（用户的原话：「不带用户名（太长），就显示
 * 小明给 LLM 就可以了」）。落地在 igreal.js:syncCommentsIn —— 那条评论的
 * owner 直接写成 `小明`，模型收到的就是「小明在 Instagram 上给你留了言」。
 *
 * `name` 留空就退回 `@用户名`：显示名是给人看着方便的，不填不该让整条失效。
 *
 * 兼容老形态：这个字段以前是**一串裸用户名**（`["aki"]`）。老文件读回来时
 * 一条字符串就当 `{ name: "", username: 那串 }` —— 用户不用重新填一遍。
 */
export function normalizeAllowEntry(raw) {
  const username = normalizeUsername(typeof raw === "string" ? raw : raw?.username);
  if (!username) return null;
  // 显示名是给模型念的，什么字符都可以（中文、emoji），只卡长度
  const name = String((typeof raw === "string" ? "" : raw?.name) ?? "")
    .trim()
    .slice(0, 40);
  return { name, username };
}

/** 白名单去重：按 username，同一个号填两遍留第一条。 */
function dedupeAllow(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const entry = normalizeAllowEntry(item);
    if (!entry || seen.has(entry.username)) continue;
    seen.add(entry.username);
    out.push(entry);
  }
  return out;
}

/**
 * 这个 IG 用户名在白名单里叫什么（不在里面返回空串）。
 *
 * 只查手填的那份名单，**不查已绑定的角色小号** —— 角色的显示名是角色名本身，
 * 由 igreal.js 那边的 `byHandle` 负责，两个来源不该在这儿混起来。
 */
export function allowLabelFor(username, settings) {
  const name = normalizeUsername(username);
  if (!name) return "";
  const hit = (settings?.allowFrom ?? []).find((e) => e?.username === name);
  return hit?.name ?? "";
}

function normalizeAccount(raw) {
  const def = defaultAccount(raw?.roleName);
  return {
    ...def,
    roleName: String(raw?.roleName ?? "").trim(),
    token: String(raw?.token ?? "").trim(),
    userId: String(raw?.userId ?? "").trim(),
    username: normalizeUsername(raw?.username),
    expiresAt: num(raw?.expiresAt, 0, 0, Number.MAX_SAFE_INTEGER),
    refreshedAt: num(raw?.refreshedAt, 0, 0, Number.MAX_SAFE_INTEGER),
    lastError: String(raw?.lastError ?? ""),
    publishedAt: Array.isArray(raw?.publishedAt)
      ? raw.publishedAt.map(Number).filter((n) => Number.isFinite(n) && n > 0)
      : [],
  };
}

function normalizeSettings(raw) {
  const def = defaultSettings();
  const host = raw?.imageHost ?? {};
  return {
    // 上限 168 小时（一周）：再长就等于不轮询了，那该把它设成 0
    intervalHours: num(raw?.intervalHours, def.intervalHours, 0, 168),
    dnd: {
      enabled: raw?.dnd?.enabled === undefined ? def.dnd.enabled : Boolean(raw.dnd.enabled),
      start: normalizeClock(raw?.dnd?.start, def.dnd.start),
      end: normalizeClock(raw?.dnd?.end, def.dnd.end),
    },
    // 按 username 去重，留**第一条** —— 界面上的顺序就是用户加进去的顺序，
    // 先填的那条是他当时想要的名字（`new Map` 那种写法是后来者覆盖，反了）
    allowFrom: dedupeAllow(raw?.allowFrom),
    syncUser: Boolean(raw?.syncUser),
    lastPollAt: num(raw?.lastPollAt, 0, 0, Number.MAX_SAFE_INTEGER),
    mentionsBroken: Boolean(raw?.mentionsBroken),
    imageHost: {
      provider: "cloudinary",
      cloudName: String(host.cloudName ?? "").trim(),
      apiKey: String(host.apiKey ?? "").trim(),
      apiSecret: String(host.apiSecret ?? "").trim(),
    },
  };
}

/**
 * 读整份 accounts.json。
 *
 * 形状：`{ settings, accounts: { <角色名>: {…} }, user: {…} }`
 *
 * `user` 是**你自己**那条大号记录，和角色那些分开放 —— 它没有 roleName，
 * 而且用途是只读（`GET /me/media`），不发布。
 */
export function readAccounts() {
  ensureLayout();
  const raw = readJson(ACCOUNTS_PATH, null);
  const out = {
    settings: normalizeSettings(raw?.settings),
    accounts: {},
    user: normalizeAccount({ ...(raw?.user ?? {}), roleName: "" }),
  };
  const src = raw?.accounts && typeof raw.accounts === "object" ? raw.accounts : {};
  for (const [key, value] of Object.entries(src)) {
    const acc = normalizeAccount({ ...value, roleName: value?.roleName || key });
    if (acc.roleName) out.accounts[acc.roleName] = acc;
  }
  return out;
}

/**
 * 落盘。先 `.tmp` 再 rename（照抄 igstore.js:writeAtomic）。
 *
 * 这里比别处更需要原子写：token 续期是**读改写**，写一半断电的话文件里既没有
 * 旧 token 也没有新 token，用户必须重新去 Meta 后台生成 —— 而那个按钮点出来的
 * 是全新 token，等于所有角色都要重绑一遍。
 *
 * 文件权限收成 0600（只有当前用户能读）。Windows 上 mode 基本被忽略，
 * 但 VPS 上跑的时候这一行是真的有用，成本只有一次 chmod。
 */
function writeAccounts(data) {
  ensureLayout();
  const tmp = `${ACCOUNTS_PATH}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmp, ACCOUNTS_PATH);
    try {
      fs.chmodSync(ACCOUNTS_PATH, 0o600);
    } catch {
      /* Windows 上不支持，忽略 */
    }
    return true;
  } catch (e) {
    logWarn(SCOPE, "真 Instagram 的账号文件写不进去", e);
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 临时文件删不掉不影响功能 */
    }
    return false;
  }
}

/** 一个角色的账号记录（没绑过就给一份空的默认值，不返回 null）。 */
export function readAccount(roleName) {
  const name = String(roleName ?? "").trim();
  if (!name) return defaultAccount("");
  return readAccounts().accounts[name] ?? defaultAccount(name);
}

/** 你自己那条大号记录。 */
export function readUserAccount() {
  return readAccounts().user;
}

/**
 * 改一个角色的账号记录（浅合并）。
 *
 * `token` 传空串 = **解绑**：整条记录删掉，而不是留一条空 token 的壳。
 * 留着壳的话「这个角色绑没绑」要判两个字段，界面和后端很容易看法不一致。
 */
export function writeAccount(roleName, patch) {
  const name = String(roleName ?? "").trim();
  if (!name) return null;
  const data = readAccounts();
  const cur = data.accounts[name] ?? defaultAccount(name);
  const next = normalizeAccount({ ...cur, ...(patch ?? {}), roleName: name });

  if (!next.token) {
    delete data.accounts[name];
    writeAccounts(data);
    return null;
  }
  data.accounts[name] = next;
  writeAccounts(data);
  return next;
}

/** 改你自己那条大号记录。同样：token 清空 = 解绑。 */
export function writeUserAccount(patch) {
  const data = readAccounts();
  const next = normalizeAccount({ ...data.user, ...(patch ?? {}), roleName: "" });
  data.user = next.token ? next : defaultAccount("");
  writeAccounts(data);
  return data.user;
}

export function readRealSettings() {
  return readAccounts().settings;
}

export function writeRealSettings(patch) {
  const data = readAccounts();
  const merged = { ...data.settings, ...(patch ?? {}) };
  // 两个嵌套对象得手动摊开，不然前端只传 dnd.enabled 会把 start/end 抹掉
  if (patch?.dnd) merged.dnd = { ...data.settings.dnd, ...patch.dnd };
  if (patch?.imageHost) merged.imageHost = { ...data.settings.imageHost, ...patch.imageHost };
  data.settings = normalizeSettings(merged);
  writeAccounts(data);
  return data.settings;
}

/* ================= 判断 ================= */

/** 这条记录能用来打接口没有（有 token、有 user_id、没过期）。 */
export function accountUsable(acc, now = Date.now()) {
  if (!acc?.token || !acc?.userId) return false;
  // expiresAt 是 0 表示还没探过期限 —— 当能用，第一次调用自然会报错
  return !acc.expiresAt || acc.expiresAt > now;
}

/** 该续期了没有（快到期、但还没到期）。 */
export function needsRefresh(acc, now = Date.now()) {
  if (!acc?.token || !acc.expiresAt) return false;
  if (acc.expiresAt <= now) return false; // 已经过期，续不了了，只能重新粘
  return acc.expiresAt - now <= REFRESH_BEFORE_DAYS * 86400_000;
}

/**
 * 现在是勿扰时段吗。
 *
 * 跨零点算数（23:00–09:00 就是），照抄 proactive 那边的语义。用**系统时间**，
 * 不做时区换算 —— 用户填的就是他自己看表的那个时间。
 */
export function inDnd(settings, now = Date.now()) {
  const dnd = settings?.dnd;
  if (!dnd?.enabled) return false;
  const [sh, sm] = String(dnd.start ?? "23:00").split(":").map(Number);
  const [eh, em] = String(dnd.end ?? "09:00").split(":").map(Number);
  const d = new Date(now);
  const cur = d.getHours() * 60 + d.getMinutes();
  const from = sh * 60 + sm;
  const to = eh * 60 + em;
  if (from === to) return false; // 两头一样 = 不勿扰（而不是勿扰一整天）
  return from < to ? cur >= from && cur < to : cur >= from || cur < to;
}

/**
 * 这个 IG 账号在白名单里吗。
 *
 * 空白名单 = **谁都不理**（不是「谁都理」）。这个默认方向很重要：小号是公开的，
 * 默认放行等于让角色去回复任何陌生人。
 *
 * 自己人（已绑定的角色小号、你的大号）**永远算数**，不用手填进白名单 ——
 * 角色互评那条链路正是靠这个走通的。
 */
export function allowedFrom(username, settings, data) {
  const name = normalizeUsername(username);
  if (!name) return false;
  const own = new Set();
  for (const acc of Object.values(data?.accounts ?? {})) {
    if (acc.username) own.add(acc.username);
  }
  if (data?.user?.username) own.add(data.user.username);
  if (own.has(name)) return true;
  return (settings?.allowFrom ?? []).some((e) => e?.username === name);
}

/**
 * 24 小时里已经发了几条。Meta 的限制是每账号 50 条 / 24 小时。
 *
 * 本地数着而不是问接口：Meta 有 `content_publishing_limit` 端点，但那是**又一次**
 * 网络往返，而我们本来就知道自己发过什么。数错的后果只是被 Meta 拒一次，
 * 那条会进重试队列。
 */
export const PUBLISH_LIMIT = 50;

export function publishedInWindow(acc, now = Date.now()) {
  return (acc?.publishedAt ?? []).filter((t) => now - t < 86400_000).length;
}

/** 记一条「发出去了」，顺手把 24 小时以外的清掉。 */
export function notePublished(roleName, now = Date.now()) {
  const acc = readAccount(roleName);
  if (!acc.token) return null;
  const kept = (acc.publishedAt ?? []).filter((t) => now - t < 86400_000);
  return writeAccount(roleName, { publishedAt: [...kept, now] });
}
