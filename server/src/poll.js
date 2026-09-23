/**
 * 盯着 iMessage 的**投票**（iOS 26 那个「发起投票」气泡）。
 *
 * ── 为什么不走 Spectrum ──
 *
 * @spectrum-ts/imessage 确实订阅了 poll 流，但它只把**投票/撤票**这两种变化
 * 转成消息，`created` 和 `optionAdded` 一律扔掉：
 *
 *   const toPollDeltaMessages = async (client, pollCache, event, phone) => {
 *     if (isVotedPollEvent(event))   return toPollOptionMessage(…);
 *     if (isUnvotedPollEvent(event)) return toPollOptionMessage(…);
 *     return [];                    // ← created / optionAdded 走这里
 *   };
 *
 * 也就是说「对方发起了一个投票，选项有哪几个」这件事**从设计上就拿不到**。
 * 用户看到的「只显示了标题、没有选项」就是这个 —— 那行标题是作为一条**普通
 * 文本消息**单独进来的，和投票气泡没有关系。
 *
 * 顺带还修掉一个 ZodError。Spectrum 自己缓存 poll 时走 `asPoll`，而它的 schema
 * 要求 `title` 非空：
 *
 *   [spectrum.imessage.poll] ERROR failed to cache poll
 *     path: ["title"], message: "Too small: expected string to have >=1 characters"
 *
 * Photon 送来的 `created` delta 里 title 常常**是空串**（标题跑到那条文本消息
 * 上去了），于是 SDK 连缓存都没建成，后面的投票事件也对不回选项。这边不依赖
 * 它那份缓存：delta 里的 title 不可信就回源 `polls.get` 拿权威的那份。
 *
 * ── 代价和取舍 ──
 *
 * 和 chatbg.js 一样是**额外一条**常驻 gRPC 连接（Spectrum 那条照旧跑），所以
 * 角色开关默认关、只认云端模式。起不来只记日志 + 长退避重连，不打断桥接。
 *
 * created / optionAdded 的 delta 都带**完整**选项表（不是增量），所以「选项
 * 随时能加、要全部认出来」是成立的 —— 加完一个选项会重新给一遍全部选项。
 */

import { peerKeyFromChatGuid } from "./chatbg.js";
import { logDebug, logInfo, logWarn } from "./logs.js";
import { closeClients, createLineClients } from "./photongrpc.js";

/**
 * 断线之后多久重连。数值和理由同 chatbg.js：常驻流断开基本是对面不支持或者
 * 网络炸了，秒重试只会刷屏。
 */
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;

/**
 * 回源问一次投票详情最多等多久。
 *
 * 和 card.js 的 DETAIL_TIMEOUT_MS 对齐。**必须自己套超时**：这个客户端是给
 * 长连接开的，createLineClients 没传 timeout（流式调用本来就不该有），所以
 * 这一发一元调用要是卡住就永远卡着，把整条流的 for-await 堵死。
 */
const DETAIL_TIMEOUT_MS = 6000;

/**
 * 投一票最多等多久。
 *
 * 比读详情宽（照 card.js:SEND_TIMEOUT_MS 的 12 秒）：这是个**写**操作，
 * 服务端要真去改那条气泡。超时就当没投上，不重试 —— 重试可能变成投两次。
 */
const VOTE_TIMEOUT_MS = 12_000;

/** 把 SDK 的 PollOption 收敛成我们只关心的两个字段。 */
function toOptions(list) {
  return (list ?? [])
    .map((o) => ({
      text: String(o?.text ?? "").trim(),
      optionIdentifier: String(o?.optionIdentifier ?? ""),
    }))
    .filter((o) => o.optionIdentifier);
}

/**
 * 回源拿这个投票的权威状态。拿不到返回 null。
 *
 * 只在 delta 自己说不清的时候调（title 空、或者选项少于两个）—— 那种 delta
 * 就是用户那条 ZodError 的来源。
 */
async function fetchPoll(client, pollMessageGuid, scope) {
  /*
   * 这个定时器要**清掉**，不能靠它自己烧完。
   *
   * Promise.race 里赢的那一边不会取消输的那一边：`polls.get` 200ms 就回来了，
   * 这个 6 秒的 timer 照样躺在事件循环里。一次无所谓，但发起投票时每条 created
   * 都可能回源一次，于是进程退出前总要多挂几秒（unref 管的是「别钉住进程」，
   * 不是「别留着」）。两条都加上：unref 兜住退出，clearTimeout 兜住常驻。
   */
  let timer = null;
  try {
    const poll = await Promise.race([
      client.polls.get(pollMessageGuid),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`等了 ${DETAIL_TIMEOUT_MS}ms 没回`)),
          DETAIL_TIMEOUT_MS
        );
        timer.unref?.();
      }),
    ]);
    return {
      title: String(poll?.title ?? "").trim(),
      options: toOptions(poll?.options),
    };
  } catch (e) {
    logDebug(scope, `回源读投票详情失败（${pollMessageGuid}）：${String(e?.message ?? e)}`);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 开一条常驻的 poll 事件流。
 *
 * @param {object} opts
 * @param {string} opts.projectId
 * @param {string} opts.projectSecret
 * @param {string} opts.label 日志里显示的角色名
 * @param {(ev: {
 *   kind: "created"|"optionAdded"|"voted"|"unvoted",
 *   peerKey: string, chatGuid: string, pollMessageGuid: string,
 *   title: string, options: {text: string, optionIdentifier: string}[],
 *   optionIdentifier: string,
 * }) => void} opts.onEvent
 * @returns {Promise<{stop: () => Promise<void>}>} 立刻返回一个能停的把手（连接在后台慢慢建）
 */
export async function watchPolls({ projectId, projectSecret, label, onEvent }) {
  const scope = label ? `投票·${label}` : "投票";

  let stopped = false;
  let attempt = 0;
  let timer = null;
  let clients = [];
  let streams = [];

  const stop = async () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    // 关流是关流，关客户端是关客户端 —— 只关流的话 gRPC channel 还挂着
    for (const s of streams) {
      try {
        await s.close?.();
      } catch {
        /* ignore */
      }
    }
    streams = [];
    for (const c of clients) {
      try {
        await c.close?.();
      } catch {
        /* ignore */
      }
    }
    clients = [];
  };

  const scheduleRetry = (why) => {
    if (stopped) return;
    attempt += 1;
    const wait = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
    logWarn(scope, `${why}，${Math.round(wait / 1000)} 秒后重连（第 ${attempt} 次）`);
    timer = setTimeout(() => {
      timer = null;
      run().catch((e) => scheduleRetry(String(e?.message ?? e)));
    }, wait);
    // 别让这个定时器把进程钉住（服务停的时候 Node 要能退出去）
    timer.unref?.();
  };

  async function run() {
    if (stopped) return;

    // 长连接：不设一元超时（这条流要一直开着），token 由 photongrpc 那边带缓存续上
    const opened = await createLineClients(projectId, projectSecret);

    if (stopped) {
      for (const { client } of opened) {
        try {
          await client.close?.();
        } catch {
          /* ignore */
        }
      }
      return;
    }

    const seenLines = new Set();

    for (const line of opened) {
      clients.push(line.client);
      openStream(line, seenLines);
    }

    // 连上就清掉退避计数。这个 Promise 只在**建连那一步**结束，不等流断 ——
    // 断开由每条流自己的 scheduleRetry 处理
    attempt = 0;
  }

  function openStream(line, seenLines) {
    const { client, instanceId } = line;
    let stream;
    try {
      stream = client.polls.subscribeEvents();
    } catch (e) {
      logWarn(scope, `订阅投票事件失败（${instanceId}）：${String(e?.message ?? e)}`);
      return;
    }
    streams.push(stream);

    (async () => {
      try {
        for await (const ev of stream) {
          if (stopped) return;
          if (ev?.type !== "poll.changed") continue;

          /*
           * 自己干的不算。
           *
           * 角色发起一个投票、或者角色自己投一票，都会从这条流回来一个事件 ——
           * 不挡的话模型会收到「{{user}}发起了一个投票」，而那是它自己刚发的。
           */
          if (ev.isFromMe) continue;

          const delta = ev.delta;
          const kind = delta?.type;
          if (
            kind !== "created" &&
            kind !== "optionAdded" &&
            kind !== "voted" &&
            kind !== "unvoted"
          ) {
            continue;
          }

          const chatGuid = String(ev.chatGuid ?? "");
          const peerKey = peerKeyFromChatGuid(chatGuid);
          // 群聊/认不出地址的跳过：这套提示和落盘都是按「对面是谁」组织的
          if (!peerKey) {
            logDebug(scope, `忽略一条投票变化（认不出单聊地址）：${chatGuid}`);
            continue;
          }

          const pollMessageGuid = String(ev.pollMessageGuid ?? "");
          if (!pollMessageGuid) {
            logDebug(scope, "忽略一条投票变化（没有 pollMessageGuid）");
            continue;
          }

          if (!seenLines.has(instanceId)) {
            seenLines.add(instanceId);
            // 只说一次「这条流是通的」—— 否则每次投票都在控制台刷一行
            logInfo(scope, `已连上，开始盯着投票（${instanceId}）`);
          }

          let title = String(delta.title ?? "").trim();
          let options = toOptions(delta.options);

          /*
           * 标题/选项说不清就回源。
           *
           * 这就是用户那条 ZodError 的落点：Photon 的 created delta 里 title
           * 经常是空串，Spectrum 拿它去 parse 就炸了。我们不 parse，直接问
           * `polls.get` 要权威的那份。
           */
          if (kind === "created" || kind === "optionAdded") {
            if (!title || options.length < 2) {
              const fresh = await fetchPoll(client, pollMessageGuid, scope);
              if (fresh) {
                title = fresh.title || title;
                options = fresh.options.length ? fresh.options : options;
              }
            }
            if (!options.length) {
              logDebug(scope, `忽略一条投票变化（一个选项都没读到）：${pollMessageGuid}`);
              continue;
            }
          } else {
            /*
             * voted / unvoted 的 delta 里**只有** optionIdentifier，没有选项表 ——
             * 所以这里也回源一次，把那张「id → 文字」的表带上。
             *
             * 这不是可选的优化：角色自己发起的投票，落盘那份 optionIdentifier
             * 全是空串（`space.send` 只还回来一个 Message，见 imessage.js 的
             * sendPollPart），唯一能补上 id 的时机就是这儿。不补的话对方在角色
             * 发起的投票里投了什么，角色永远只知道「投了一票」。
             *
             * 代价是每个投票事件多一发 RPC（6 秒超时兜着）。拿不到就算了 ——
             * 「他投了一票」这件事本身照样报，所以不 continue。
             */
            const fresh = await fetchPoll(client, pollMessageGuid, scope);
            if (fresh) {
              title = title || fresh.title;
              if (fresh.options.length) options = fresh.options;
            }
          }

          logDebug(
            scope,
            `收到投票事件 ${kind}（${pollMessageGuid}）：` +
              (options.length ? `${options.length} 个选项` : String(delta.optionIdentifier ?? ""))
          );

          try {
            onEvent({
              kind,
              peerKey,
              chatGuid,
              pollMessageGuid,
              title,
              options,
              optionIdentifier: String(delta.optionIdentifier ?? ""),
            });
          } catch (e) {
            logWarn(scope, `处理投票事件时出错：${String(e?.message ?? e)}`);
          }
        }
        // 流正常结束（服务端关了）也当断线，走同一条重连路
        if (!stopped) scheduleRetry("投票事件流结束了");
      } catch (e) {
        if (stopped) return;
        scheduleRetry(`投票事件流断了（${String(e?.message ?? e)}）`);
      }
    })();
  }

  // 先把连接跑起来的失败路接上；成功的话 attempt 会被清零
  run().catch((e) => scheduleRetry(String(e?.message ?? e)));

  return { stop };
}

/* ================= 投票 / 发起投票 ================= */

/**
 * 在一个已有的投票里投一票。
 *
 * 和 card.js 的 `sendTransferCard` 同一个路子：Spectrum 的 `space.send()` 没有
 * 「给某个投票投一票」这种 content，所以临时开一个裸 gRPC 客户端、用完就关
 * （token 走 photongrpc 那份缓存，不会多铸）。专线模式下一个项目挂着多条线路，
 * 而这个投票只在其中一条上，挨个试、第一条成功就收工。
 *
 * **改票也走这一条**：Photon 的 `vote` 文档原话是 "casts or changes the local
 * account's vote" —— 一个账号一票，投第二个选项等于把第一票挪过去。
 *
 * @param {object} opts
 * @param {string} opts.projectId
 * @param {string} opts.projectSecret
 * @param {string} opts.pollMessageGuid 投票那条气泡的 guid
 * @param {string} opts.optionIdentifier 要投哪个选项（服务端生成的 id）
 * @param {string} [opts.scope] 日志前缀
 * @returns {Promise<boolean>} 投上了没有
 */
export async function castVote({
  projectId,
  projectSecret,
  pollMessageGuid,
  optionIdentifier,
  scope = "投票",
}) {
  if (!projectId || !projectSecret || !pollMessageGuid || !optionIdentifier) return false;

  let opened = [];
  try {
    opened = await createLineClients(projectId, projectSecret, { timeout: VOTE_TIMEOUT_MS });
    let lastError = null;
    for (const { client, instanceId } of opened) {
      try {
        await client.polls.vote(pollMessageGuid, optionIdentifier);
        logDebug(scope, `投票成功（线路 ${instanceId}）：${pollMessageGuid}`);
        return true;
      } catch (e) {
        lastError = e;
        logDebug(scope, `线路 ${instanceId} 上投不了这一票：${String(e?.message ?? e)}`);
      }
    }
    if (lastError) logWarn(scope, "这一票没投上去", lastError);
    return false;
  } catch (e) {
    logWarn(scope, "这一票没投上去（开不了客户端）", e);
    return false;
  } finally {
    await closeClients(opened);
  }
}

/* ================= 字母 ↔ 选项 ================= */

/**
 * 第 n 个选项显示成哪个字母。0→A、1→B…25→Z，再往后用序号（27、28…）。
 *
 * 苹果的投票实际最多 10 个选项（Spectrum 那边的 schema 也是 2–10），所以
 * 26 这条线永远碰不到；写在这儿只是为了越界时不返回一个空标签。
 */
export function letterFor(index) {
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0) return "";
  return i < 26 ? String.fromCharCode(65 + i) : String(i + 1);
}

/** 把选项表拼成 `【A麻辣烫】【B炸鸡】【C海底捞】`。 */
export function renderOptions(options) {
  return (options ?? []).map((o, i) => `【${letterFor(i)}${o.text}】`).join("");
}

/**
 * 模型写的 `[vote:X]` 里那个 X 指的是哪个选项。找不到返回 null。
 *
 * 三种写法都认，按「越具体越先」的顺序：
 *  1. 单个字母 `A` / `a` —— 提示词里教的就是这个
 *  2. 序号 `1` / `2`
 *  3. 选项原文 `麻辣烫` —— 模型很爱直接写内容，先全等再包含（照
 *     imessage.js:resolveReplyTarget 的老规矩）
 */
export function matchOption(options, raw) {
  const list = options ?? [];
  const want = String(raw ?? "").trim();
  if (!list.length || !want) return null;

  // 字母。单个 a–z 才算，免得把一个叫「A套餐」的选项当成字母 A
  if (/^[A-Za-z]$/.test(want)) {
    const idx = want.toUpperCase().charCodeAt(0) - 65;
    if (idx >= 0 && idx < list.length) return list[idx];
  }

  // 序号
  if (/^\d{1,2}$/.test(want)) {
    const idx = Number(want) - 1;
    if (idx >= 0 && idx < list.length) return list[idx];
  }

  const lower = want.toLowerCase();
  const exact = list.find((o) => o.text.toLowerCase() === lower);
  if (exact) return exact;
  const loose = list.find((o) => o.text && o.text.toLowerCase().includes(lower));
  if (loose) return loose;
  // 反方向也试一次：模型可能写全了「A麻辣烫」这种带字母前缀的
  return list.find((o) => o.text && lower.includes(o.text.toLowerCase())) ?? null;
}
