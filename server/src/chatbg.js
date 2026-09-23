/**
 * 盯着「对方换了聊天背景」，好在对方下一句话的时候顺带告诉模型。
 *
 * 苹果 iOS 26 允许给单个对话换壁纸，换完对方那边会看到一条「更改了聊天背景」
 * 的系统提示。这个模块干的就是读到那条提示 —— 但它**不走 Spectrum**。
 *
 * 为什么不走 Spectrum：这个事件确实存在（`chat.backgroundChanged` /
 * `chat.backgroundRemoved`，都带 `isFromMe`），但它属于 Photon 的
 * **chat 事件流**，而 @spectrum-ts/imessage 这个 provider 压根没往外暴露它
 * —— 它既没有 defineEvent，也没有留任何拿到裸客户端的口子。所以这里直接用
 * 底层的 @photon-ai/advanced-imessage/grpc 自己开流（铸 token、开客户端那一层
 * 在 photongrpc.js，和 card.js 共用）。
 *
 * 代价是这条流是**额外**的一条连接（Spectrum 那条照旧跑），而且 SDK 的注释
 * 里有一句「入站事件不再走这个客户端（它们改走 Fusor 了）」—— 如果服务端
 * 真的把 subscribeChatEvents 关了，这里会一直连不上。所以：
 *   - 角色开关默认关，用户自己开；
 *   - 失败只记一条日志然后长退避重连，不打断桥接（桥接那条路本来就不依赖它）；
 *   - 谁也保证不了它一定收得到，收不到就是「这个功能没反应」，不会更糟。
 *
 * 只用在云端模式。本地 Mac 模式读的是本机数据库，没有 Photon 客户端可连。
 */

import { logDebug, logInfo, logWarn } from "./logs.js";
import { CLOUD_URL, SHARED_ADDRESS, createLineClients } from "./photongrpc.js";

/**
 * 断线之后多久重连。
 *
 * 这个流正常时是**常驻**的，断开基本意味着对面不支持或者网络炸了，两种情况
 * 都不该秒重试 —— 秒重试只会在日志里刷屏。所以起步就放到 30 秒，一路涨到
 * 10 分钟封顶。
 */
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;

/**
 * 把 `any;-;+18005550100` / `iMessage;-;a@b.com` 归一成手机号或邮箱。
 *
 * 事件里带的 chatGuid 是这个形状（见 SDK 的 dmChatGuid）。群聊不是一对一，
 * 换背景、投票这些事也只对得上一个人，所以这里只认单聊，认不出就返回空串
 * —— 空串的键配上「一对一」的判断，群聊自然被排除。
 *
 * **按分隔符判单聊/群聊，不靠末段猜。** SDK 自己就是这么分的
 * （`chatTypeFromGuid = (guid) => guid.includes(";+;") ? "group" : "dm"`）。
 * 光看末段会栽在群聊上：`iMessage;+;chat123456` 的末段滤掉非数字剩
 * `123456`，六位，正好够长 —— 于是一个群被当成了某个人的号码，这一屋子人
 * 的投票和背景变更全记到那个不存在的「人」头上去。
 */
export function peerKeyFromChatGuid(guid) {
  const raw = String(guid ?? "");
  if (!raw) return "";
  if (raw.includes(";+;")) return "";
  const at = raw.indexOf(";-;");
  if (at < 0) return "";
  const peer = raw.slice(at + 3).trim();
  if (!peer) return "";
  if (peer.includes("@")) return peer.toLowerCase();
  const digits = peer.replace(/[^\d+]/g, "");
  return digits.length >= 6 ? digits : "";
}

/**
 * 开一条常驻的 chat 事件流，盯着背景变化。
 *
 * @param {object} opts
 * @param {string} opts.projectId
 * @param {string} opts.projectSecret
 * @param {string} opts.label 日志里显示的角色名
 * @param {(ev: {kind: "changed"|"removed", peerKey: string, chatGuid: string}) => void} opts.onChanged
 * @returns {Promise<{stop: () => Promise<void>}>} 立刻返回一个能停的把手（连接在后台慢慢建）
 */
export async function watchChatBackground({ projectId, projectSecret, label, onChanged }) {
  const scope = label ? `聊天背景·${label}` : "聊天背景";

  let stopped = false;
  let attempt = 0;
  let timer = null;
  /** 当前活着的客户端/流，stopRunner 时要一起收掉 */
  let clients = [];
  let streams = [];
  const abort = new AbortController();

  const stop = async () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    abort.abort();
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

    // 长连接：不设一元超时（这条流本来就要一直开着），token 由 photongrpc 那边
    // 用带缓存的回调续上
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

    const seenChats = new Set();

    for (const line of opened) {
      clients.push(line.client);
      openStream(line.client, line, seenChats, scope, onChanged, streams, () => stopped);
    }

    // 连上就先清掉退避计数，下次真断了重新从 30 秒起步。
    // 注意这个 Promise 只在**建连那一步**结束，不等流断 —— 断开由每条流
    // 自己的 scheduleRetry 处理，不是靠这里 reject。
    attempt = 0;
  }

  /* 流本身在后台跑；这个函数只负责把事件喂给 onChanged */
  function openStream(client, line, seenChats, scope, onChanged, streams, isStopped) {
    let stream;
    try {
      stream = client.chats.subscribeEvents();
    } catch (e) {
      logWarn(scope, `订阅聊天事件失败（${line.instanceId}）：${String(e?.message ?? e)}`);
      return;
    }
    streams.push(stream);

    (async () => {
      try {
        for await (const ev of stream) {
          if (isStopped()) return;
          const type = ev?.type;
          if (type !== "chat.backgroundChanged" && type !== "chat.backgroundRemoved") continue;
          // 自己改的（比如以后加了「帮角色换壁纸」）不算「对方换了背景」
          if (ev.isFromMe) continue;

          const chatGuid = String(ev.chatGuid ?? "");
          const peerKey = peerKeyFromChatGuid(chatGuid);
          // 认不出地址的（群聊、格式变了）直接跳过：这个提示只对一个人有意义
          if (!peerKey) {
            logDebug(scope, `忽略一条背景变化（认不出单聊地址）：${chatGuid}`);
            continue;
          }

          const kind = type === "chat.backgroundChanged" ? "changed" : "removed";
          if (!seenChats.has(chatGuid)) {
            seenChats.add(chatGuid);
            // 只说一次「这条流是通的」，之后每条都只在 debug 里记 —— 否则
            // 对方每换一次背景都在控制台刷一行，用户会以为是故障
            logInfo(scope, `已连上，开始盯着聊天背景（${line.instanceId}）`);
          }
          logDebug(scope, `对方${kind === "changed" ? "换了" : "清空了"}聊天背景：${chatGuid}`);
          try {
            onChanged({ kind, peerKey, chatGuid });
          } catch (e) {
            logWarn(scope, `记背景变化时出错：${String(e?.message ?? e)}`);
          }
        }
        // 流正常结束（服务端关了）也当成断线，走同一条重连路
        if (!isStopped()) scheduleRetry("聊天事件流结束了");
      } catch (e) {
        if (isStopped()) return;
        scheduleRetry(`聊天事件流断了（${String(e?.message ?? e)}）`);
      }
    })();
  }

  // 先把连接跑起来的失败路接上；成功的话 attempt 会被清零
  run().catch((e) => scheduleRetry(String(e?.message ?? e)));

  return { stop };
}

/** 只是给外面看一眼默认地址用的（日志里会显示），不参与逻辑。 */
export const CHAT_BG_ENDPOINT = `${CLOUD_URL} → ${SHARED_ADDRESS}`;
