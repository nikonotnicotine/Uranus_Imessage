import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { SESSIONS_DIR } from "./datadir.js";

/**
 * 单个会话文件最多留多少条。
 *
 * 这是「存档」的上限，不是发给模型的条数（那个是角色的上下文限制）。
 * 设个上限纯粹是防止单个文件无限长 —— 聊上几年之后读写会变慢。
 */
const MAX_STORED = 2000;

/** 文件名白名单。id 是从角色名派生的，而角色名是用户随便填的。 */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/**
 * 存档里只有**最新**那条助手消息留思维链，旧的落盘时剥掉。
 *
 * 翻十轮就是十份推演，又长又没人看。这里剥的是「已经在存档里的」，
 * 新追加的那条留完整原文，所以效果是「只有最新一条有」。
 *
 * 用的是模块内置的模式，**不复用用户的正则规则** —— 用户规则的 toHistory
 * 语义是「过滤发给模型的那份」，和「修剪存档」是两回事，混用会让两个开关
 * 互相干扰。哨兵单独列一条：EcoT 的正文里 </thinking> 之后还跟一个
 * 裸 [finire]，剥掉思维链会把它留在原地。
 */
const THINK_PATTERNS = [
  /<(thinking|think)>[\s\S]*?<\/\1>\s*/gi,
  /\[(incipere|finire)\]\s*/gi,
];

function stripThinking(text) {
  let out = String(text ?? "");
  for (const re of THINK_PATTERNS) out = out.replace(re, "");
  return out.trimStart();
}

/** 地址 → 文件名能用的一段：邮箱取 @ 前那截，手机号取数字。 */
function addrTail(raw) {
  const s = String(raw ?? "");
  return s.includes("@")
    ? s.split("@")[0].replace(/[^A-Za-z0-9]/g, "")
    : s.replace(/\D/g, "");
}

/**
 * 没有线路号可用时的退路：对方地址的短哈希。
 *
 * **不能退回明文号码** —— 那正是这次改动要消掉的东西。哈希保住了
 * 「不同的人各自一份存档」，同时 ID 里不出现任何可读的号码。
 * 8 位十六进制（32 bit）对「一个人同时聊几十个号」这种量级够用了。
 */
function peerHash(peer) {
  const key = String(peer ?? "").trim().toLowerCase();
  if (!key) return "";
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

/**
 * 会话 ID = 角色名 + **自己这条 Photon 线路的号码**，例如 阿瑞18005550100。
 *
 * 尾巴用的是**线路号**（AI 那一头的号），不是对方号码。用户的原话是
 * 「避免到时候别人有问题发截图给我的时候把他手机号给爆出来了」—— 会话 ID
 * 会出现在「上下文」面板的列表、日志的每一行、以及 `data/sessions/` 的文件名上，
 * 截图求助时最容易连带曝出去。线路号是公开的（就是让人发消息的那个号），
 * 曝了没关系。
 *
 * 换成线路号带来一个语义变化：**同一个角色对多个对方地址会塌成同一份存档**。
 * 现在的用法是一个角色绑一个项目、一条线路对一个人，所以实际影响是零；
 * 真要一条线路服务多个人，得把这里改成「线路号 + peerHash」那种组合。
 *
 * 线路号还没登记（云端刚建的项目）或本地 Mac 模式（压根没有线路号）时退到
 * `peerHash` —— 见它上面的注释，退的是哈希不是明文号码。
 *
 * 角色改名后会算出新 ID，相当于开一个新会话 —— 这条没变，界面上有说明。
 *
 * @param {string} roleName 角色名，可能是中文、可能是空的
 * @param {string} roleId 角色名派生不出字母数字时的兜底
 * @param {string} linePhone Photon 分配的线路号码（project.linePhone）
 * @param {string} [peer] 对方地址。只在没有线路号时用，而且只用它的哈希
 */
export function sessionIdFor(roleName, roleId, linePhone, peer = "") {
  // 中文名在这一步会被剔干净，所以要有 roleId 兜底
  const name = String(roleName ?? "").replace(/[^A-Za-z0-9]/g, "");
  const line = addrTail(linePhone);
  const tail = line || peerHash(peer);

  // 兜底用 roleId 时保留 - 和 _（文件名白名单里本来就允许），
  // 否则 r-1 和 r1 会算出同一个 ID，两个角色的存档串到一起
  const head = name || `role-${String(roleId ?? "").replace(/[^A-Za-z0-9_-]/g, "") || "x"}`;
  const id = `${head}${tail || "unknown"}`;
  // 再兜一层：万一上面的规则漏了什么，也不能让它变成路径
  return SAFE_ID.test(id) ? id : `session-${Buffer.from(id).toString("hex").slice(0, 24)}`;
}

function fileFor(id) {
  if (!SAFE_ID.test(String(id ?? ""))) return null;
  return path.join(SESSIONS_DIR, `${id}.json`);
}

function ensureDir() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

function emptySession(id) {
  return {
    id,
    roleId: "",
    roleName: "",
    peer: "",
    createdAt: "",
    updatedAt: "",
    messages: [],
  };
}

/** 读一份会话存档。不存在或读坏了都返回一个空的（不抛）。 */
export function readSession(id) {
  const file = fileFor(id);
  if (!file || !fs.existsSync(file)) return emptySession(id);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return {
      ...emptySession(id),
      ...parsed,
      id,
      messages: Array.isArray(parsed?.messages) ? parsed.messages : [],
    };
  } catch {
    return emptySession(id);
  }
}

function writeFile(session) {
  const file = fileFor(session.id);
  if (!file) return false;
  ensureDir();
  fs.writeFileSync(file, JSON.stringify(session, null, 2), "utf-8");
  return true;
}

/**
 * 取会话里最后 n 条，用来回填内存里的历史。
 *
 * 常驻内存只放这几条 —— 磁盘上存了 2000 条也不影响内存占用，
 * 小 VPS 上跑很多号码时这点很重要。
 */
export function recentMessages(id, n) {
  const limit = Math.max(0, Number(n) || 0);
  if (!limit) return [];
  return readSession(id)
    .messages.slice(-limit)
    .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content ?? "") }));
}

/**
 * 往存档里追加一轮对话（用户说的 + 助手回的）。
 *
 * @param {string} id 会话 ID
 * @param {{roleId?: string, roleName?: string, peer?: string}} meta 首次创建时记下来
 * @param {Array<{role: string, content: string}>} turn 这一轮的消息
 * @param {(msg: string) => void} [onTrim] 触发截断时的通知（不静默丢东西）
 */
export function appendTurn(id, meta, turn, onTrim) {
  const list = Array.isArray(turn) ? turn.filter((m) => m?.content) : [];
  if (!list.length) return null;

  const now = new Date().toISOString();
  const session = readSession(id);
  session.roleId = meta?.roleId ?? session.roleId;
  session.roleName = meta?.roleName ?? session.roleName;
  session.peer = meta?.peer ?? session.peer;
  session.createdAt = session.createdAt || now;
  session.updatedAt = now;

  let seq = session.messages.length;

  // 追加新的之前，把已有助手消息的思维链剥掉 —— 只有最新那条留完整原文
  for (const m of session.messages) {
    if (m.role !== "assistant") continue;
    const lean = stripThinking(m.content);
    if (lean !== m.content) m.content = lean;
  }

  for (const m of list) {
    session.messages.push({
      id: `s-${seq++}-${Math.random().toString(36).slice(2, 7)}`,
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content),
      ts: now,
    });
  }

  if (session.messages.length > MAX_STORED) {
    const dropped = session.messages.length - MAX_STORED;
    session.messages = session.messages.slice(dropped);
    onTrim?.(`会话 ${id} 的存档超过 ${MAX_STORED} 条，已丢掉最旧的 ${dropped} 条`);
  }

  writeFile(session);
  return session;
}

/** 整份覆盖某个会话的消息（前端删条 / 清空用）。 */
export function writeSession(id, messages) {
  const session = readSession(id);
  session.messages = (Array.isArray(messages) ? messages : []).map((m, i) => ({
    id: String(m?.id ?? `s-${i}`),
    role: m?.role === "assistant" ? "assistant" : "user",
    content: String(m?.content ?? ""),
    ts: String(m?.ts ?? ""),
  }));
  session.updatedAt = new Date().toISOString();
  return writeFile(session) ? session : null;
}

export function deleteSession(id) {
  const file = fileFor(id);
  if (!file || !fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

/** 所有会话的摘要，按最后更新时间倒序。前端左边那列用这个。 */
export function listSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs
    .readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const s = readSession(f.slice(0, -5));
      const last = s.messages[s.messages.length - 1];
      return {
        id: s.id,
        roleId: s.roleId,
        roleName: s.roleName,
        peer: s.peer,
        kind: s.kind ?? "chat",
        count: s.messages.length,
        updatedAt: s.updatedAt,
        preview: last ? String(last.content).slice(0, 60) : "",
      };
    })
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

/** 老规则的 ID：角色名 + **对方**号码。只有迁移那一步用得到，用来认出老文件。 */
function legacyIdFor(roleName, roleId, peer) {
  const name = String(roleName ?? "").replace(/[^A-Za-z0-9]/g, "");
  const head = name || `role-${String(roleId ?? "").replace(/[^A-Za-z0-9_-]/g, "") || "x"}`;
  const id = `${head}${addrTail(peer) || "unknown"}`;
  return SAFE_ID.test(id) ? id : `session-${Buffer.from(id).toString("hex").slice(0, 24)}`;
}

/**
 * 一次性迁移：老存档的文件名从「角色名 + 对方号码」换成「角色名 + 线路号码」。
 *
 * 不搬的话后果是**静默丢历史** —— 新 ID 算出来是一份空存档，模型看不到之前
 * 聊过的任何东西，而磁盘上那份老文件还在，谁都不读。所以这一步要在桥接
 * 起来之前跑完（见 index.js 的调用顺序）。
 *
 * 三道闸，都是为了「宁可不搬，也不搬错」：
 *  1. 旁路文件（kind = legacy-preset）不动，它本来就没有号码尾巴；
 *  2. 只搬**确实由老规则生成**的文件（拿文件里自己记的 roleName/peer 反算一遍
 *     对得上才算）—— 对不上的说明是别的来路，乱改会把两份存档并到一起；
 *  3. 目标文件已经存在就只记一条日志、两份都留着。这种情况只可能是上一次
 *     迁移写完新文件之后崩在删旧文件那一步，两份都留下总比合并出错好。
 *
 * 头部（角色名那截）**用文件里记的名字，不是配置里当前的名字**：角色改名
 * 本来就等于换一份新存档，这一步只负责把尾巴换掉，不顺手把改名前的老存档
 * 也拽到新名下。
 *
 * @param {Map<string, string>} lineByRoleId 角色 id → 它绑的那条线路号码
 * @param {(msg: string) => void} [onLog] 日志出口（这个模块不认识 logs.js）
 * @returns {Array<{from: string, to: string}>} 实际搬了哪些
 */
export function migrateSessionIds(lineByRoleId, onLog = () => {}) {
  if (!fs.existsSync(SESSIONS_DIR)) return [];

  const moved = [];
  for (const f of fs.readdirSync(SESSIONS_DIR)) {
    if (!f.endsWith(".json")) continue;
    const id = f.slice(0, -5);
    const session = readSession(id);

    if ((session.kind ?? "chat") !== "chat") continue;
    if (!session.peer) continue; // 没记对方号码：ID 里也就没有号码可消
    if (id !== legacyIdFor(session.roleName, session.roleId, session.peer)) continue;

    // 这个角色现在没有线路号（本地 Mac 模式，或云端项目还没登记）：留在原地。
    // 退成 peerHash 也算达到了「ID 里没有明文号码」，但那是个不可读的哈希，
    // 而这些老文件的用户是认得住自己那个 ID 的 —— 等真有了线路号再搬更稳
    const line = lineByRoleId?.get?.(session.roleId) ?? "";
    if (!line) continue;

    const next = sessionIdFor(session.roleName, session.roleId, line, session.peer);
    if (next === id) continue;

    const from = fileFor(id);
    const to = fileFor(next);
    if (!from || !to) continue;
    if (fs.existsSync(to)) {
      onLog(`会话存档 ${id} 想搬成 ${next}，但那个名字已经有文件了，两份都留着没动`);
      continue;
    }

    try {
      // 先写新的再删旧的，而不是 renameSync：文件里那个 id 字段也要跟着改，
      // 顺序反了的话中途出错会留下一个 id 和文件名不一致的存档
      fs.writeFileSync(to, JSON.stringify({ ...session, id: next }, null, 2), "utf-8");
      fs.unlinkSync(from);
      moved.push({ from: id, to: next });
    } catch (e) {
      onLog(`会话存档 ${id} 搬成 ${next} 失败（原文件没动）：${String(e?.message ?? e)}`);
    }
  }
  return moved;
}

/**
 * 一次性迁移：把老版本角色里手写的预设对话另存一份。
 *
 * 预设编辑器撤掉了，但用户写过的东西不能凭空蒸发。这时候还不知道对方号码、
 * 算不出正式的会话 ID，所以落到一个旁路文件里，只在「上下文」面板里只读展示，
 * 不参与发给模型的历史。已经存在就不覆盖（幂等，重启不会反复写）。
 */
export function saveLegacyPreset({ roleId, roleName, messages }) {
  const id = `legacy-${String(roleId).replace(/[^A-Za-z0-9_-]/g, "") || "x"}`;
  const file = fileFor(id);
  if (!file || fs.existsSync(file)) return null;
  const now = new Date().toISOString();
  writeFile({
    id,
    kind: "legacy-preset",
    roleId,
    roleName,
    peer: "",
    createdAt: now,
    updatedAt: now,
    messages: messages.map((m, i) => ({
      id: String(m.id ?? `s-${i}`),
      role: m.role,
      content: m.content,
      ts: now,
    })),
  });
  return id;
}

export function getSessionsDir() {
  return SESSIONS_DIR;
}