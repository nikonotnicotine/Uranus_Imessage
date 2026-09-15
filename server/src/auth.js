/**
 * 控制台的登录。
 *
 * ── 为什么要有这个 ──
 *
 * 这个程序开着好几个 HTTP 端口，而且很多人是**挂在 VPS 上**跑的 —— 那种环境里
 * `0.0.0.0` 是默认，安全组一开就是全端口对全网。没有登录的话，任何知道 IP 的人
 * 打开 `http://[IP]:8787` 就能看到：所有 API 密钥（界面上是 password 框，但
 * `GET /api/config` 返回的是明文）、Photon 的 projectId/secret、手机号、
 * 全部聊天记录和记忆库，还能直接点「重启服务」。
 *
 * 所以这一层不是「锦上添花的账号系统」，它是**唯一挡在那些东西前面的门**。
 *
 * ── 密码怎么存 ──
 *
 * scrypt + 每人一份随机盐，存的是哈希，明文一个字节都不落盘。用 scrypt 而不是
 * SHA-256：后者算一次是微秒级，一张显卡一秒能试几十亿个，八位密码撑不过一顿饭
 * 的时间。scrypt 是故意设计成又慢又吃内存的（这里 N=16384，一次约 60~100ms），
 * 同样的显卡一秒只能试几千个。
 *
 * 校验用 `timingSafeEqual` 而不是 `===`：字符串比较会在第一个不同的字节上返回，
 * 从耗时能一个字节一个字节地把哈希试出来。
 *
 * 全部走 node:crypto，**没有引入任何依赖** —— bcrypt 那一类要编译原生模块，
 * 在 Windows 上装不上的概率不低，而这个项目的用户大多在 Windows 上双击 bat。
 *
 * ── 会话怎么记 ──
 *
 * 一条 HMAC 签名的 cookie，形如 `<用户名>.<签发时间>.<签名>`，签名密钥是
 * auth.json 里那个随机 secret。**服务端不存会话表**：
 *
 *  - 重启不掉线。这个程序有「重启服务」按钮，还有定时重启，会话表存在内存里的话
 *    每次重启所有人都得重新登录；
 *  - 改密码 / 改用户名会自动让旧 cookie 失效 —— 那两件事都会换掉 secret，
 *    旧签名对不上了。这正好就是「改完密码，别的设备上的登录都该断掉」。
 *
 * 密码忘了的出路：打开 `data/auth.json`，把 `"password"` 那一行的值清成
 * `""`（或者整个文件删掉），重启一次，就又是默认的 Uranus / Uranus 了。
 * 这条路必须留着 —— 自己架的东西没有「找回密码」的邮件可发。
 */

import crypto from "node:crypto";

import { AUTH_PATH, ensureLayout, readJson, writeJson } from "./datadir.js";
import { logInfo, logWarn } from "./logs.js";

const SCOPE = "登录";

/**
 * 出厂的用户名和密码，都是 `Uranus`。
 *
 * 用户原话：「进入后的默认账号密码是 Uranus，登陆后要强制用户更换账号和密码」。
 * 所以这一对**只够走进去一次** —— 拿它登进来的会话，除了「改账号密码」这一件事
 * 什么都干不了（见 index.js 里那道 must-change 闸）。
 */
export const DEFAULT_USER = "Uranus";
export const DEFAULT_PASSWORD = "Uranus";

/** cookie 的名字。 */
export const COOKIE_NAME = "uranus_session";

/**
 * 一条会话签发之后能用多久（天）。
 *
 * 30 天：这是自己家里/自己 VPS 上的后台，不是网银。太短会变成每周都要重新登，
 * 而这个界面很多人是开着一整天的。
 */
const SESSION_DAYS = 30;
const SESSION_TTL = SESSION_DAYS * 24 * 60 * 60 * 1000;

/* ================= 密码规则 ================= */

/** 最短位数。用户定的：不少于 8 位。 */
export const MIN_PASSWORD = 8;

/**
 * 密码合不合规。
 *
 * 用户定的规则只有两条：**不少于 8 位**、**至少一个大写字母**。「其他就没了」——
 * 所以这里不加符号、不加数字、不查字典，多加一条都是替用户改需求。
 *
 * 另外拦一个空格开头/结尾：那种密码复制粘贴时会莫名对不上，而用户会以为是程序坏了。
 *
 * @returns {string} 空串 = 通过；否则是一句能照着改的中文
 */
export function checkPassword(password) {
  const s = String(password ?? "");
  if (!s) return "密码不能是空的。";
  if (s.length < MIN_PASSWORD) return `密码至少要 ${MIN_PASSWORD} 位，现在只有 ${s.length} 位。`;
  if (!/[A-Z]/.test(s)) return "密码里至少要有一个大写字母（A-Z）。";
  if (s !== s.trim()) return "密码的开头或结尾有空格，去掉再试 —— 那种密码粘贴时很容易对不上。";
  return "";
}

/**
 * 用户名合不合规。
 *
 * 只收口不设门槛：去掉首尾空格、限长 32、不许有控制字符（那种名字会把 cookie
 * 和日志弄坏）。允许中文 —— 这是本地后台，没有理由只让人用英文名。
 *
 * 不许有 `.`：会话 cookie 是 `<用户名>.<时间>.<签名>` 这么拼的，名字里带点
 * 会把切分弄乱。
 *
 * @returns {string} 空串 = 通过；否则是一句中文
 */
export function checkUsername(name) {
  const s = String(name ?? "").trim();
  if (!s) return "用户名不能是空的。";
  if (s.length > 32) return "用户名太长了，最多 32 个字。";
  if (/[\x00-\x1f\x7f]/.test(s)) return "用户名里有不可见的控制字符，重新打一遍。";
  if (s.includes(".")) return "用户名里不能有小数点（会话凭据是用它分段的）。";
  return "";
}

/* ================= 落盘 ================= */

/**
 * 读 auth.json。
 *
 * 文件不在、读坏了、被用户手改成空的，一律回落到「还是默认账号」的状态 ——
 * 那正好就是「忘了密码，把 password 清空」要的效果。
 *
 * @returns {{username: string, password: {salt: string, hash: string} | null, secret: string, changedAt: string}}
 */
function read() {
  const raw = readJson(AUTH_PATH, null);
  const stored = raw && typeof raw === "object" ? raw : {};
  const pw = stored.password;
  // 用户手动清空的形态有好几种（"" / null / 删掉整行 / 删掉整个文件），
  // 全部当成「回到默认密码」
  const password =
    pw && typeof pw === "object" && String(pw.salt ?? "") && String(pw.hash ?? "")
      ? { salt: String(pw.salt), hash: String(pw.hash) }
      : null;
  /*
   * 密码被清掉时**用户名也一起回到默认**。
   *
   * 这条不是随手写的：走到这一步的人是「密码忘了」，而他很可能连当初改成什么
   * 用户名都不记得了（那两样是同一个表单里一起改的）。只把密码复位的话，他会
   * 照着文件里的说明填 Uranus / Uranus，然后被挡在外面 —— 而这条路是最后一条
   * 出路，没有找回密码的邮件可发。
   *
   * 代价是自定义用户名跟着丢，但重置完下一步就是重新设一遍账号密码，
   * 那时候他想用哪个名字都能填回去。
   */
  return {
    username: password ? String(stored.username ?? "").trim() || DEFAULT_USER : DEFAULT_USER,
    password,
    secret: String(stored.secret ?? ""),
    changedAt: String(stored.changedAt ?? ""),
  };
}

/**
 * 写 auth.json。
 *
 * 顺手带一段 `_说明` 进文件 —— 忘了密码的人会打开这个文件，那时候他需要的
 * 就是这几句话，而不是去翻文档。JSON 没有注释，只能这么放。
 */
function write(state) {
  ensureLayout();
  writeJson(AUTH_PATH, {
    _说明: [
      "这是控制台的登录凭据。密码存的是 scrypt 哈希，看不出原文，也改不回去。",
      "忘了密码：把下面 password 的值改成 null（或者删掉这整个文件），存盘就生效，",
      "不用重启。账号密码会回到默认的 Uranus / Uranus，登进去之后会让你重新设一遍",
      "（用户名也一起回到 Uranus —— 密码忘了的人往往连改过的用户名也不记得了）。",
      "secret 是会话签名用的随机串，改了它等于把所有设备上的登录都踢下线。",
    ],
    username: state.username,
    password: state.password,
    secret: state.secret,
    changedAt: state.changedAt,
  });
}

/* ================= 密码哈希 ================= */

/**
 * scrypt 的参数。
 *
 * N=16384（cost）、r=8、p=1 是 Node 文档里的默认档，一次约 60~100ms —— 登录时
 * 用户等这一下感觉不到，暴力破解要为每一次尝试都付这个代价。
 * maxmem 得显式抬高：默认 32MB，N=16384 时算下来正好在边界上，某些机器会抛
 * `memory limit exceeded`。
 */
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LEN = 32;

function hashWith(password, salt) {
  return crypto.scryptSync(String(password), Buffer.from(salt, "hex"), KEY_LEN, SCRYPT);
}

/** 算一份「盐 + 哈希」，两个都是 hex。 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: hashWith(password, salt).toString("hex") };
}

/**
 * 密码对不对。
 *
 * `timingSafeEqual` 要求两边等长，所以先比长度 —— 长度不同直接 false，
 * 那不泄露任何信息（哈希长度是固定的，不等长只可能是文件被改坏了）。
 */
function passwordMatches(password, stored) {
  if (!stored) return false;
  let got;
  try {
    got = hashWith(password, stored.salt);
  } catch {
    return false;
  }
  let want;
  try {
    want = Buffer.from(stored.hash, "hex");
  } catch {
    return false;
  }
  if (got.length !== want.length) return false;
  return crypto.timingSafeEqual(got, want);
}

/* ================= 会话 cookie ================= */

/**
 * 签名密钥。
 *
 * 第一次要用的时候才生成并落盘 —— 全新安装、还没设过密码的机器上也得能签出
 * 会话来（默认账号也要能登进去改密码）。
 */
function ensureSecret(state) {
  if (state.secret) return state.secret;
  const secret = crypto.randomBytes(32).toString("hex");
  write({ ...state, secret });
  return secret;
}

/**
 * 会话凭据里那一段签名。
 *
 * 进 HMAC 的除了用户名和签发时间，还有**当前的密码哈希** —— 这样改密码会自动
 * 让所有旧 cookie 失效，不用维护任何黑名单。
 */
function sign(state, user, issued) {
  const material = `${user}.${issued}.${state.password?.hash ?? "初始"}`;
  return crypto.createHmac("sha256", ensureSecret(state)).update(material).digest("hex");
}

/** 签一条会话凭据。 */
function issueToken(state, user) {
  const issued = Date.now();
  return `${user}.${issued}.${sign(state, user, issued)}`;
}

/**
 * 验一条会话凭据。
 *
 * @returns {{ok: true, user: string} | {ok: false, why: string}}
 */
function verifyToken(state, token) {
  const raw = String(token ?? "");
  if (!raw) return { ok: false, why: "没有登录凭据" };
  const at = raw.lastIndexOf(".");
  const mid = raw.lastIndexOf(".", at - 1);
  if (at <= 0 || mid <= 0) return { ok: false, why: "凭据格式不对" };

  const user = raw.slice(0, mid);
  const issued = Number(raw.slice(mid + 1, at));
  const got = raw.slice(at + 1);
  if (!Number.isFinite(issued)) return { ok: false, why: "凭据格式不对" };

  // 用户名换了，旧凭据就不认了
  if (user !== state.username) return { ok: false, why: "账号已经改过了，请重新登录" };
  if (Date.now() - issued > SESSION_TTL) return { ok: false, why: "登录状态过期了，请重新登录" };

  const want = Buffer.from(sign(state, user, issued), "hex");
  let mine;
  try {
    mine = Buffer.from(got, "hex");
  } catch {
    return { ok: false, why: "凭据格式不对" };
  }
  if (mine.length !== want.length || !crypto.timingSafeEqual(mine, want)) {
    // 改过密码的旧凭据也走到这儿 —— 对用户来说这两件事是同一句话
    return { ok: false, why: "登录状态失效了，请重新登录" };
  }
  return { ok: true, user };
}

/* ================= 对外 ================= */

/**
 * 现在是不是还在用出厂密码。
 *
 * `true` 的时候前端只让改账号密码，别的什么都不给做 —— 用户要的
 * 「登陆后要强制用户更换账号和密码」就是这一条。
 */
export function mustChangeCredentials() {
  return read().password === null;
}

/** 当前用户名，界面上要显示。 */
export function currentUsername() {
  return read().username;
}

/**
 * 登录。
 *
 * 账号或密码错了一律回同一句话，不说「是账号不存在还是密码错了」——
 * 那种区分等于告诉扫端口的人「这个用户名是对的，继续试密码」。
 *
 * @returns {{ok: true, token: string, mustChange: boolean, username: string} | {ok: false, error: string}}
 */
export function login(username, password) {
  const state = read();
  const user = String(username ?? "").trim();
  const pass = String(password ?? "");

  const nameOk = user.toLowerCase() === state.username.toLowerCase();
  // 还没设过密码：只认出厂那一对
  const passOk = state.password ? passwordMatches(pass, state.password) : pass === DEFAULT_PASSWORD;

  if (!nameOk || !passOk) {
    logWarn(SCOPE, `登录失败（用户名 ${user || "空"}）`);
    return { ok: false, error: "账号或密码不对。" };
  }

  logInfo(SCOPE, `${state.username} 登录成功`);
  return {
    ok: true,
    token: issueToken(state, state.username),
    mustChange: state.password === null,
    username: state.username,
  };
}

/**
 * 改账号密码。
 *
 * 两件事一起做（用户要的是「强制更换账号和密码」），所以只有一个接口。
 * 改完**重新签一条 cookie**：secret 没换，但密码哈希进了签名，不重签的话
 * 用户自己会被当场踢下线。
 *
 * 还在用出厂密码时不要求 `current` —— 那时候「当前密码」就是 Uranus，
 * 再问一遍是纯粹的麻烦。已经设过密码了就必须验，否则任何人拿到一条别人忘了
 * 退出的会话就能直接改掉密码。
 *
 * @returns {{ok: true, token: string, username: string} | {ok: false, error: string}}
 */
export function changeCredentials({ username, password, current } = {}) {
  const state = read();
  const fresh = state.password === null;

  if (!fresh && !passwordMatches(String(current ?? ""), state.password)) {
    return { ok: false, error: "当前密码不对。" };
  }

  const name = String(username ?? "").trim();
  const nameWhy = checkUsername(name);
  if (nameWhy) return { ok: false, error: nameWhy };

  const pass = String(password ?? "");
  const passWhy = checkPassword(pass);
  if (passWhy) return { ok: false, error: passWhy };

  // 出厂那一对不许留着当正式密码 —— 不然「强制更换」就成了走个形式
  if (name.toLowerCase() === DEFAULT_USER.toLowerCase() && pass === DEFAULT_PASSWORD) {
    return { ok: false, error: "不能还用默认的 Uranus / Uranus，换一个。" };
  }

  const next = {
    username: name,
    password: hashPassword(pass),
    // secret 留着：换了它没有额外的安全收益（密码哈希已经进签名了），
    // 而留着能少一次「所有端口上的页面同时掉线」
    secret: ensureSecret(state),
    changedAt: new Date().toISOString(),
  };
  write(next);
  logInfo(SCOPE, `账号密码已更新（用户名 ${name}）`);
  return { ok: true, token: issueToken(next, name), username: name };
}

/**
 * 认一条 cookie 头。
 *
 * 自己解析 `Cookie:` 而不是装 cookie-parser：要的就是取一个键，
 * 为它多一个依赖不值得。
 *
 * @returns {{ok: true, user: string, mustChange: boolean} | {ok: false, why: string}}
 */
export function authenticate(cookieHeader) {
  const state = read();
  const token = parseCookie(cookieHeader)[COOKIE_NAME] ?? "";
  const out = verifyToken(state, token);
  if (!out.ok) return out;
  return { ok: true, user: out.user, mustChange: state.password === null };
}

/** `Cookie: a=1; b=2` → `{a: "1", b: "2"}`。 */
export function parseCookie(header) {
  const out = {};
  for (const part of String(header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at < 1) continue;
    const key = part.slice(0, at).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(at + 1).trim());
    } catch {
      out[key] = part.slice(at + 1).trim();
    }
  }
  return out;
}

/**
 * 拼一条 Set-Cookie。
 *
 * `HttpOnly`：不让页面里的脚本读到它。`SameSite=Lax`：够挡住跨站带 cookie 的
 * 写请求，又不影响用户从别处点链接进来。
 *
 * **没有 `Secure`** —— 这东西绝大多数情况下是 `http://localhost:8787` 或者
 * `http://[IP]:8787`，加了 Secure 的 cookie 在纯 HTTP 上会被浏览器直接丢掉，
 * 等于谁都登不进来。挂在域名 + HTTPS 后面的用户请在反代那一层加。
 *
 * @param {string} token 空串 = 让浏览器把这条 cookie 删掉（退出登录）
 */
export function cookieHeader(token) {
  const base = `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`;
  if (!token) return `${base}; Max-Age=0`;
  return `${base}; Max-Age=${Math.floor(SESSION_TTL / 1000)}`;
}
