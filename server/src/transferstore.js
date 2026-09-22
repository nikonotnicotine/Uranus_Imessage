/**
 * 转账卡片的会话句柄：一个角色一份，按卡片的 messageGuid 索引。
 *
 * ── 为什么非要落盘 ──
 *
 * 发一张转账卡片，SDK 回一个 `MiniAppCardSession`（messageGuid / chatGuid /
 * sessionId / targetMessageGuid 四个字段）。想把「待收款」原地改成「已收款」，
 * 就得把这四个字段原样传回 `updateCustomizedMiniApp` —— 换句话说**不存下来
 * 这张卡片就永远改不了了**。
 *
 * 纯内存不行：对方可能明天早上才去点收款，中间进程重启过好几次。所以这份
 * 必须上盘。
 *
 * ── 为什么不进 config.json ──
 *
 * 和 IG、壁纸、线下剧情同一条：`PUT /api/config` 会顺带重启所有 iMessage
 * 桥接，而这边是**每笔转账都写**。走 config 等于转一次账把所有线路踢下线。
 *
 * ── 为什么按角色分文件 ──
 *
 * 照 memories/ 和 offline/index/ 的规矩。一个角色一份，单独拷、单独回滚都行，
 * 而且一次读写只碰一个角色的量级（几十条），不会因为别的角色转账多而变慢。
 *
 * ── 为什么留着已收款的记录 ──
 *
 * 收完款**不删**，只把 state 改掉。理由有两条：一是重复贴 emoji 要能认出
 * 「这笔早就收过了」，删了的话第二次贴会被当成一笔陌生卡片、日志里冒一条
 * 找不到的警告；二是模型要能在上下文里说清「你上周转的那 4000」。
 *
 * 但也不能无限攒 —— 见 MAX_ENTRIES，超了从最旧的开始丢。丢掉的只是「还能不能
 * 原地改这张卡片」，气泡本身在对方手机上一个字都不会变。
 */

import fs from "node:fs";
import path from "node:path";

import { TRANSFERS_DIR, ensureLayout } from "./datadir.js";
import { logWarn } from "./logs.js";

const SCOPE = "转账";

/** 文件名白名单。roleKey 来自 memorystore.js:memoryKeyFor（同一个正则）。 */
const SAFE_KEY = /^[A-Za-z0-9_-]+$/;

/**
 * 一个角色最多留几笔。
 *
 * 一笔条目是四个 guid 加几个短字段，撑死 400 字节，500 笔也就 200KB ——
 * 这个上限不是为了省空间，是为了别让文件无限长下去（每笔转账都要整份重写）。
 * 超了从最旧的开始丢，见 putTransfer。
 */
export const MAX_ENTRIES = 500;

/** key 合法才给路径，否则返回 null —— 挡 `../` 那一类。 */
function fileFor(roleKey) {
  if (!SAFE_KEY.test(String(roleKey ?? ""))) return null;
  return path.join(TRANSFERS_DIR, `${roleKey}.json`);
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, "utf-8");
  fs.renameSync(tmp, file);
}

/**
 * 读这个角色的全部转账。
 *
 * 坏文件**不删也不改名**（照 offlinestore.js）：读不出来只 warn 然后当空的用。
 * 最坏的后果是几张老卡片改不动了，不该为这个把文件毁掉。
 *
 * @returns {{version: number, items: object[]}}
 */
export function readTransfers(roleKey) {
  ensureLayout();
  const file = fileFor(roleKey);
  const empty = { version: 1, items: [] };
  if (!file || !fs.existsSync(file)) return empty;

  let text = "";
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (e) {
    logWarn(SCOPE, `${path.basename(file)} 读不出来，这次当空的用`, e);
    return empty;
  }
  if (!text.trim()) return empty;

  try {
    const parsed = JSON.parse(text);
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    return { version: 1, items };
  } catch (e) {
    logWarn(SCOPE, `${path.basename(file)} 解析不了，这次当空的用（文件没动）`, e);
    return empty;
  }
}

/**
 * 记下一笔刚发出去的转账，或者更新已有的那笔。
 *
 * 按 `messageGuid` 去重 —— 那是这张卡片的身份。同一个 guid 再 put 一次就是
 * 覆盖（收款改状态走的就是这条）。
 *
 * @param {string} roleKey
 * @param {object} entry
 * @param {string} entry.messageGuid 卡片那条气泡的 guid，认卡片就靠它
 * @param {string} entry.chatGuid
 * @param {string} entry.sessionId
 * @param {string} entry.targetMessageGuid
 * @param {string} entry.amount 金额那串**原文**（模型写的，可能带小数）
 * @param {string} entry.note 备注
 * @param {"pending"|"received"} entry.state
 * @param {string} entry.peerKey 哪条会话上的，收款时反查用
 * @returns {boolean} 写进去了没有
 */
export function putTransfer(roleKey, entry) {
  const file = fileFor(roleKey);
  const guid = String(entry?.messageGuid ?? "").trim();
  if (!file || !guid) return false;

  const { items } = readTransfers(roleKey);
  const next = items.filter((it) => String(it?.messageGuid ?? "") !== guid);
  next.push({
    messageGuid: guid,
    chatGuid: String(entry.chatGuid ?? ""),
    sessionId: String(entry.sessionId ?? ""),
    targetMessageGuid: String(entry.targetMessageGuid ?? ""),
    amount: String(entry.amount ?? ""),
    note: String(entry.note ?? ""),
    state: entry.state === "received" ? "received" : "pending",
    peerKey: String(entry.peerKey ?? ""),
    at: Number(entry.at) || Date.now(),
  });

  // 超了从最旧的开始丢。丢掉的只是「还能不能原地改」，气泡本身不受影响
  const kept = next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;

  try {
    writeAtomic(file, JSON.stringify({ version: 1, items: kept }, null, 2));
    return true;
  } catch (e) {
    logWarn(SCOPE, `${path.basename(file)} 写不进去，这笔转账之后改不了状态了`, e);
    return false;
  }
}

/**
 * 按卡片气泡的 guid 找那笔转账。找不到返回 null。
 *
 * `messageGuid` 和 `targetMessageGuid` **两个都比**：SDK 把前者说成「送卡片那
 * 一下返回的 guid」、后者说成「以后原地替换的那条气泡的 guid」。第一次发出去
 * 时这俩通常是同一个值，但没有任何地方保证；对方贴 emoji 贴的是**气泡**，
 * 所以只比一个的话另一种情况下会查不到，收款直接哑掉。两个都比不花什么钱。
 */
export function findTransfer(roleKey, messageGuid) {
  const guid = String(messageGuid ?? "").trim();
  if (!guid) return null;
  return (
    readTransfers(roleKey).items.find(
      (it) =>
        String(it?.messageGuid ?? "") === guid || String(it?.targetMessageGuid ?? "") === guid
    ) ?? null
  );
}
