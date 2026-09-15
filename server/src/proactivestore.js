/**
 * 主动消息的「表」落盘。
 *
 * ── 为什么要落盘 ──
 *
 * 以前这套状态**只在内存里**：`runner.proactive` 由 createRunner 现造，
 * stopRunner 一律清掉。副作用是——
 *   - 重启/关机 = 所有计时器归零；
 *   - 而且 armProactive 只认「从入站消息上拿到的 space」，没有 space 直接
 *     return，所以重启后必须等对方**先说一句**才重新起表。
 * 合起来就是用户看到的那个毛病：一重启，主动消息就再也不按时间发了 ——
 * 等待窗口本来就是几小时，重启一次全白等。随机时间和 AI 判断两种模式
 * 都一样，因为卡住的是同一个地方。
 *
 * 所以这里把「下次几点开口」记到硬盘上，跟 igstore.js 的互动队列一个路子：
 * 等待窗口远长于一次重启的间隔，纯内存必然丢。
 *
 * ── 存了什么、没存什么 ──
 *
 * 存的是**能在重启后重算出来的最小一组**：哪条线路、哪个会话、对方是谁、
 * 下次几点、这一跳是问模型还是真发、有没有在等回信。
 *
 * 不存 space 对象本身（它挂着 SDK 的客户端，序列化不了也不该序列化）——
 * spaceId 就是 iMessage 的 chat GUID，重启后拿它跟 SDK 要一个新的就行，
 * 见 imessage.js 的 rehydrateProactive。
 *
 * 不存 timer（显然），也不存角色 id：角色是按线路查的，查配置就有，存下来
 * 反而会和改绑后的实际情况对不上。
 *
 * ── 写的频率 ──
 *
 * 起表、撤表、发完一条、对方已读，就这几处，一次间隔几小时，整文件重写
 * 完全够用，不需要像 sessions 那样分文件。
 */

import path from "node:path";

import { DATA_DIR, ensureLayout, readJson, writeJson } from "./datadir.js";
import { logWarn } from "./logs.js";

const SCOPE = "主动消息";

const SCHEDULE_PATH = path.join(DATA_DIR, "proactive.json");

/** 一跳只有这两种：问模型「下次隔多久」，或者真的开口。 */
const STAGES = new Set(["judge", "send"]);

function str(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function normalizeEntry(raw) {
  const projectRefId = str(raw?.projectRefId).trim();
  const spaceId = str(raw?.spaceId).trim();
  if (!projectRefId || !spaceId) return null;
  const stage = str(raw?.stage);
  return {
    projectRefId,
    spaceId,
    peer: str(raw?.peer),
    nextAt: Number(raw?.nextAt) || 0,
    stage: STAGES.has(stage) ? stage : "send",
    awaiting: raw?.awaiting === true,
    read: raw?.read === true,
  };
}

/** 读整张表。文件不在、读坏了、结构不对，一律当空表（不抛）。 */
export function readSchedule() {
  ensureLayout();
  const list = readJson(SCHEDULE_PATH, []);
  if (!Array.isArray(list)) return [];
  return list.map(normalizeEntry).filter(Boolean);
}

/** 写整张表。写不进去只记一条 warn —— 主动消息发不出去不该把这一轮聊天带崩。 */
export function writeSchedule(list) {
  try {
    ensureLayout();
    writeJson(SCHEDULE_PATH, Array.isArray(list) ? list.map(normalizeEntry).filter(Boolean) : []);
    return true;
  } catch (e) {
    logWarn(SCOPE, "主动消息的表存不下来，重启后这条会话要等对方先说话", e);
    return false;
  }
}

/** 这条线路上排着的所有会话。 */
export function slotsFor(projectRefId) {
  const id = str(projectRefId).trim();
  if (!id) return [];
  return readSchedule().filter((t) => t.projectRefId === id);
}

/**
 * 记下（或更新）一条会话的表。
 *
 * slot 就是 imessage.js 里那个内存槽，这里只挑能落盘的字段。
 * nextAt 为空说明这条根本没排上（比如角色把主动消息关了），直接当撤表处理。
 */
export function saveSlot(projectRefId, spaceId, slot) {
  const entry = normalizeEntry({
    projectRefId,
    spaceId,
    peer: slot?.peer,
    nextAt: slot?.nextAt,
    stage: slot?.stage,
    awaiting: slot?.awaiting,
    read: slot?.read,
  });
  if (!entry) return false;
  if (!entry.nextAt) return dropSlot(projectRefId, spaceId);

  const list = readSchedule();
  const at = list.findIndex(
    (t) => t.projectRefId === entry.projectRefId && t.spaceId === entry.spaceId
  );
  if (at >= 0) list[at] = entry;
  else list.push(entry);
  return writeSchedule(list);
}

/** 撤掉一条会话的表（角色关了主动消息、会话删了…）。 */
export function dropSlot(projectRefId, spaceId) {
  const id = str(projectRefId).trim();
  const sid = str(spaceId).trim();
  if (!id || !sid) return false;
  const list = readSchedule();
  const next = list.filter((t) => !(t.projectRefId === id && t.spaceId === sid));
  if (next.length === list.length) return false;
  return writeSchedule(next);
}

/**
 * 清掉已经不存在的线路留下的行。
 *
 * 线路删了/换号了，它名下的表就是死行 —— 没人会再来撤它，留着只会越攒越多。
 * syncBridges 每次同步完调一次，把还活着的线路 id 传进来。
 */
export function pruneSchedule(keepIds) {
  const keep = new Set(Array.from(keepIds ?? [], (id) => str(id).trim()).filter(Boolean));
  const list = readSchedule();
  const next = list.filter((t) => keep.has(t.projectRefId));
  if (next.length === list.length) return 0;
  writeSchedule(next);
  return list.length - next.length;
}
