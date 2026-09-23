/**
 * 见过的投票：一个角色一份，按 pollMessageGuid 索引。
 *
 * ── 为什么非要落盘 ──
 *
 * 投票只能按 `optionIdentifier` 投（一串服务端生成的 id），而模型只会写
 * `[vote:B]`。把「第几个选项 → 哪个 id」这张表丢了，这个投票就永远投不了了。
 *
 * 纯内存不行：对方早上发起投票、角色可能晚上才想起来投，中间进程重启过好几次。
 * 所以这份必须上盘 —— 和转账句柄一模一样的处境（见 transferstore.js 的文件头）。
 *
 * ── 为什么不进 config.json ──
 *
 * 和转账、IG、线下剧情同一条：`PUT /api/config` 会顺带重启所有 iMessage 桥接，
 * 而这边是**每个投票事件都写**（发起、加选项、投票、撤票各一次）。
 *
 * ── 为什么留着投完的记录 ──
 *
 * 投完**不删**。对方随时可能给这个投票再加一个选项（`optionAdded` 会带着全部
 * 选项回来），也随时可能改票；而模型要能在上下文里说清「你昨天那个投票我选了
 * 炸鸡」。删了的话这些都对不回来。
 *
 * 但也不能无限攒 —— 见 MAX_ENTRIES，超了从最旧的开始丢。丢掉的只是「这个老
 * 投票还能不能投」，气泡本身在对方手机上一个字都不会变。
 */

import fs from "node:fs";
import path from "node:path";

import { POLLS_DIR, ensureLayout } from "./datadir.js";
import { logWarn } from "./logs.js";

const SCOPE = "投票";

/** 文件名白名单。roleKey 来自 memorystore.js:memoryKeyFor（同一个正则）。 */
const SAFE_KEY = /^[A-Za-z0-9_-]+$/;

/**
 * 一个角色最多留几个投票。
 *
 * 一条记录是一个 guid 加十个选项，撑死 1KB，200 个也就 200KB —— 这个上限不是
 * 为了省空间，是为了别让文件无限长下去（每个事件都要整份重写）。
 */
export const MAX_ENTRIES = 200;

/** key 合法才给路径，否则返回 null —— 挡 `../` 那一类。 */
function fileFor(roleKey) {
  if (!SAFE_KEY.test(String(roleKey ?? ""))) return null;
  return path.join(POLLS_DIR, `${roleKey}.json`);
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, "utf-8");
  fs.renameSync(tmp, file);
}

/**
 * 读这个角色见过的全部投票。
 *
 * 坏文件**不删也不改名**（照 transferstore.js / offlinestore.js）：读不出来只
 * warn 然后当空的用。最坏的后果是几个老投票投不了了，不该为这个把文件毁掉。
 *
 * @returns {{version: number, items: object[]}}
 */
export function readPolls(roleKey) {
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
 * 记下一个投票，或者更新已有的那个（加了选项、改了标题都走这条）。
 *
 * 按 `pollMessageGuid` 去重 —— 那是这个投票的身份。同一个 guid 再 put 一次就是
 * 覆盖，并且**挪到队尾**（最近活动的排最后，findLatestPoll 取的就是这个顺序）。
 *
 * @param {string} roleKey
 * @param {object} entry
 * @param {string} entry.pollMessageGuid 投票那条气泡的 guid，投票就靠它
 * @param {string} entry.chatGuid 哪条会话上的（= imessage.js 的 spaceId）
 * @param {string} entry.peerKey 对面是谁，归一过的手机号/邮箱
 * @param {string} entry.title 投票的标题（注释）
 * @param {{text: string, optionIdentifier: string}[]} entry.options
 *   **顺序就是字母顺序**（A/B/C…）。模型写的字母按下标翻成 id 全靠这个顺序，
 *   所以更新时要原样覆盖整个数组，别去 merge
 * @param {boolean} [entry.mine] 这个投票是角色自己发起的
 * @returns {boolean} 写进去了没有
 */
export function putPoll(roleKey, entry) {
  const file = fileFor(roleKey);
  const guid = String(entry?.pollMessageGuid ?? "").trim();
  if (!file || !guid) return false;

  const { items } = readPolls(roleKey);
  const prev = items.find((it) => String(it?.pollMessageGuid ?? "") === guid);
  const next = items.filter((it) => String(it?.pollMessageGuid ?? "") !== guid);

  /*
   * 白名单（不是 `...entry`）：落盘的字段一个个列出来，免得调用方手上那个大
   * 对象里的东西顺手漏进磁盘。往这个功能加展示字段时记得回来加一行 ——
   * 漏了的话读回来永远是 undefined（transferstore 的 appName 就踩过这个坑）。
   */
  next.push({
    pollMessageGuid: guid,
    chatGuid: String(entry.chatGuid ?? prev?.chatGuid ?? ""),
    peerKey: String(entry.peerKey ?? prev?.peerKey ?? ""),
    title: String(entry.title ?? prev?.title ?? ""),
    options: (entry.options ?? prev?.options ?? []).map((o) => ({
      text: String(o?.text ?? ""),
      optionIdentifier: String(o?.optionIdentifier ?? ""),
    })),
    // 一旦是自己发起的就永远是 —— 后续 optionAdded 不带这个信息，
    // 不继承的话会把 mine 洗掉，「用户在你发起的投票里投了X」那句就丢了
    mine: Boolean(entry.mine ?? prev?.mine),
    at: Number(entry.at) || Date.now(),
  });

  // 超了从最旧的开始丢。丢掉的只是「这个老投票还能不能投」
  const kept = next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;

  try {
    writeAtomic(file, JSON.stringify({ version: 1, items: kept }, null, 2));
    return true;
  } catch (e) {
    logWarn(SCOPE, `${path.basename(file)} 写不进去，这个投票之后投不了了`, e);
    return false;
  }
}

/** 按投票气泡的 guid 找。找不到返回 null。 */
export function findPoll(roleKey, pollMessageGuid) {
  const guid = String(pollMessageGuid ?? "").trim();
  if (!guid) return null;
  return (
    readPolls(roleKey).items.find((it) => String(it?.pollMessageGuid ?? "") === guid) ?? null
  );
}

/**
 * 这条会话上最近活动的那个投票。找不到返回 null。
 *
 * 模型写 `[vote:B]` 时不会说是哪个投票（提示词里也没让它说），所以只能按
 * 「最近的那个」来 —— 而这正好是对的：那句提示就是刚刚随着某个投票事件送进去的。
 *
 * 取的是**数组末尾**而不是比 `at`：putPoll 每次更新都会挪到队尾，所以顺序本身
 * 就是活动顺序。比 at 的话遇上两个事件同一毫秒就不稳了。
 */
export function findLatestPoll(roleKey, chatGuid) {
  const chat = String(chatGuid ?? "").trim();
  if (!chat) return null;
  const { items } = readPolls(roleKey);
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (String(items[i]?.chatGuid ?? "") === chat) return items[i];
  }
  return null;
}
