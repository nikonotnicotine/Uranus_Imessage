/**
 * 小红书这边落盘的东西，全在 data/xiaohongshu/ 下：
 *
 *   state.json    每个角色一份：评论水位线、发过的笔记、回过的评论
 *   secrets.json  xiaohongshu-mcp 的访问令牌（按地址存）。**不进云备份**
 *   media/        发笔记前生成的配图（见 stageDir 的注释：真正交给 MCP 的
 *                 不一定是这个目录）
 *
 * 发出去的笔记本体在小红书上，我们只留一份流水 —— xiaohongshu-mcp 发完不回
 * 笔记 id，这份流水也就只是给界面看、给日志查的，不参与任何逻辑。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { XHS_DIR, XHS_MEDIA_DIR, readJson, writeJson } from "./datadir.js";

const STATE_FILE = path.join(XHS_DIR, "state.json");
const SECRETS_FILE = path.join(XHS_DIR, "secrets.json");

/** 流水各留多少条。只是给人看的，不用多。 */
const KEEP_NOTES = 50;
const KEEP_REPLIES = 200;
/** 回过的评论 id 记多少个用来去重。水位线已经挡掉了绝大多数，这只是兜底。 */
const KEEP_SEEN = 500;

function readState() {
  const s = readJson(STATE_FILE, {});
  return s && typeof s === "object" && !Array.isArray(s) ? s : {};
}

/** 某个角色的那一份。没有就给个空壳，不落盘。 */
export function roleState(roleId) {
  const all = readState();
  const s = all[String(roleId ?? "")] ?? {};
  return {
    // 评论水位线（毫秒）。0 = 还没看过 —— 第一次轮询只立水位不回，见 xhsrun.js
    watermark: Number(s.watermark) || 0,
    notes: Array.isArray(s.notes) ? s.notes : [],
    replies: Array.isArray(s.replies) ? s.replies : [],
    seen: Array.isArray(s.seen) ? s.seen : [],
    lastPollAt: Number(s.lastPollAt) || 0,
    lastError: String(s.lastError ?? ""),
  };
}

/** 改某个角色的那一份。fn 拿到当前值、返回新值。 */
export function updateRoleState(roleId, fn) {
  const id = String(roleId ?? "");
  if (!id) return null;
  const all = readState();
  const next = fn(roleState(id));
  next.notes = next.notes.slice(-KEEP_NOTES);
  next.replies = next.replies.slice(-KEEP_REPLIES);
  next.seen = next.seen.slice(-KEEP_SEEN);
  all[id] = next;
  writeJson(STATE_FILE, all);
  return next;
}

export function recordNote(roleId, note) {
  return updateRoleState(roleId, (s) => ({
    ...s,
    notes: [...s.notes, { ...note, at: new Date().toISOString() }],
  }));
}

/* ================= 令牌 ================= */

/**
 * xiaohongshu-mcp 的访问令牌。优先环境变量（XHS_MCP_TOKEN，所有地址共用），
 * 其次 secrets.json 里按地址存的那个。没配就是空串 —— MCP 本身默认不要令牌。
 */
export function tokenFor(baseUrl) {
  const env = String(process.env.XHS_MCP_TOKEN ?? "").trim();
  if (env) return env;
  const s = readJson(SECRETS_FILE, {});
  return String(s?.tokens?.[String(baseUrl ?? "")] ?? "").trim();
}

export function hasToken(baseUrl) {
  return Boolean(tokenFor(baseUrl));
}

/** 存 / 清某个地址的令牌。传空串 = 清掉。 */
export function saveToken(baseUrl, token) {
  const key = String(baseUrl ?? "").trim();
  if (!key) return;
  const s = readJson(SECRETS_FILE, {});
  const tokens = { ...(s?.tokens ?? {}) };
  const t = String(token ?? "").trim();
  if (t) tokens[key] = t;
  else delete tokens[key];
  writeJson(SECRETS_FILE, { ...s, tokens });
}

/* ================= 配图暂存 ================= */

const ASCII_ONLY = /^[\x20-\x7e]*$/;

/**
 * 配图落到哪个目录再交给 MCP。
 *
 * xiaohongshu-mcp 的上传是 Chrome 的文件选择框，**路径里带中文会传不上去**
 * （上游 README 里写着的坑）。而用户的数据目录常在「小手机」这种中文路径下，
 * 所以 data/xiaohongshu/media 只在全 ASCII 时才直接用；不然换到一个肯定是
 * 纯英文的地方：Windows 的公共目录，其他系统的临时目录。
 *
 * 临时目录也可能带中文（Windows 用户名是中文时 %TEMP% 就是），所以挨个试，
 * 都不行就还是用数据目录，让 MCP 那边报错 —— 至少日志里看得见为什么。
 */
export function stageDir() {
  const candidates = [XHS_MEDIA_DIR];
  if (process.platform === "win32") {
    const pub = process.env.PUBLIC || "C:\\Users\\Public";
    candidates.push(path.join(pub, "uranus-xhs"));
  }
  candidates.push(path.join(os.tmpdir(), "uranus-xhs"));
  const dir = candidates.find((d) => ASCII_ONLY.test(d)) ?? XHS_MEDIA_DIR;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 写一张图，返回绝对路径。文件名全 ASCII。 */
export function stageImage(buffer, ext = "png") {
  const dir = stageDir();
  const name = `xhs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${String(ext).replace(/^\./, "") || "png"}`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, buffer);
  return file;
}

/* ================= MCP 不在本机：借它一个限时链接取图 ================= */

/**
 * Uranus 跑在 VPS、xiaohongshu-mcp 跑在自己电脑上（中间走 Tailscale 之类）时，
 * 暂存图的路径在 MCP 那头是不存在的。好在它的 images 也收 http 链接、自己去下，
 * 所以给每张图发一个随机令牌，挂在 /xhs-img/<令牌> 下让它来取。
 *
 * 只存在内存里：进程重启就全失效，本来也只该活一次发布那么久。15 分钟是给
 * 慢网络留的余量；发完（unstage）立刻作废，不等到点。
 */
const SHARE_TTL = 15 * 60 * 1000;
const shares = new Map(); // 令牌 -> { file, until }

/** 给一张暂存图发令牌，返回令牌（32 位十六进制，猜不到）。 */
export function shareStaged(file) {
  const now = Date.now();
  for (const [k, v] of shares) if (v.until < now) shares.delete(k);
  const token = crypto.randomBytes(16).toString("hex");
  shares.set(token, { file, until: now + SHARE_TTL });
  return token;
}

/** 令牌换文件路径。过期、作废、文件没了都回空串。 */
export function sharedFile(token) {
  const s = shares.get(String(token ?? ""));
  if (!s) return "";
  if (s.until < Date.now()) {
    shares.delete(token);
    return "";
  }
  return fs.existsSync(s.file) ? s.file : "";
}

/** 发完删掉，借出去的链接一并作废。删不掉无所谓 —— 临时目录系统会收。 */
export function unstage(files) {
  const gone = new Set(files ?? []);
  for (const [k, v] of shares) if (gone.has(v.file)) shares.delete(k);
  for (const f of files ?? []) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* 不要紧 */
    }
  }
}
