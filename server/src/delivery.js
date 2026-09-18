/**
 * 「发出去了，但对方没收到」这件事的检测。
 *
 * 为什么需要单独一个模块：Spectrum 的 `space.send()` 在**消息进了 Apple 的队列**
 * 那一刻就 resolve 了，它不等投递回执。所以整条链路上所有的成功判断其实都只到
 * 「我们交出去了」为止 —— 号码压根没注册 iMessage、或者用户在界面上把号码填错了
 * 一位，send() 照样成功返回，控制台照样一行绿的「回复发完」。
 *
 * 结果是最难查的那一类故障：token 扣了、模型回了、日志全是正常的，对面一个字
 * 没收到。用户能看到的只有「它不理我」，机主在控制台里翻不出任何异常。
 *
 * 真相藏在两个地方，两个都得去问底层 gRPC（Spectrum 那层不转发）：
 *
 *  1. 消息本身的投递状态。`messages.get(guid)` 回来的记录上有
 *     `isDelivered` / `sendErrorCode` / `dateDelivered` —— 这是 Apple 给的回执，
 *     等几秒就会落下来。`sendErrorCode` 非 0 是明确失败；等够了还
 *     `isDelivered === false` 是「发出去了没人接」。
 *  2. 这个地址到底能不能走 iMessage。`addresses.isIMessageAvailable(addr)` 是
 *     实时探活，`addresses.get(addr).services` 告诉你它支持哪几种传输。
 *     这一步用来**区分两种原因**：号码是对的但没开 iMessage（那得让对方开，
 *     或者改走 SMS），还是这个号码压根不存在（填错了）。
 *
 * 用完就关，和 card.js 一个路子 —— 不留常驻连接。为了不让每轮对话都开一次
 * 客户端，同一条线路上的待查消息先攒在一起（CHECK_DELAY_MS），一次开一个客户端
 * 全查完。地址探活另有一层缓存（PROBE_TTL_MS），而且只在**真出问题的时候**才探，
 * 正常聊天一次都不会打。
 *
 * 全程 best-effort：这里所有的失败都只落日志，绝不往上抛。投递检测自己挂了
 * 不该影响聊天 —— 它是个诊断工具，不是链路的一环。
 */

import { logDebug, logError, logInfo, logWarn } from "./logs.js";
import { closeClients, createLineClients } from "./photongrpc.js";

/**
 * 发完等多久再去问投递状态。
 *
 * iMessage 的投递回执一般 1～3 秒就回来了，给到 15 秒是为了兜住网络慢和对方
 * 手机离线刚上线的情况。太短会把「还在路上」误报成「没送到」—— 那种误报比
 * 不报更糟，机主会去查一个不存在的问题。
 */
const CHECK_DELAY_MS = 15_000;

/** 一元调用的超时。查不到就算了，不值得为它等很久。 */
const RPC_TIMEOUT_MS = 8_000;

/** 一次最多查多少条。攒太多说明对话很密，那就分批查，别把一次调用撑爆。 */
const MAX_BATCH = 40;

/** 地址探活的缓存时长。号码开没开 iMessage 不会一分钟一变。 */
const PROBE_TTL_MS = 10 * 60 * 1000;

/** 同一个地址、同一种问题，多久之内不重复报。 */
const REPORT_COOLDOWN_MS = 10 * 60 * 1000;

/** `address -> { at, imessage, services, error }` */
const probeCache = new Map();

/** `projectId|address|kind -> 上次报的时刻`，控制刷屏 */
const reported = new Map();

/**
 * 每条线路一个待查队列。
 * `projectId -> { timer, items: [{ guid, peer, at }], projectSecret, label }`
 */
const queues = new Map();

/** 这次该不该报（同一个地址同一种问题在冷却期内只报一次）。 */
function shouldReport(projectId, address, kind) {
  const key = `${projectId}|${address}|${kind}`;
  const last = reported.get(key) ?? 0;
  if (Date.now() - last < REPORT_COOLDOWN_MS) return false;
  reported.set(key, Date.now());
  return true;
}

/**
 * 这个地址能不能走 iMessage。
 *
 * 只在检测到投递问题时才调 —— 它是用来**解释**问题的，不是用来预防的。
 * 拿不到就返回 `{ ok: false }`，调用方据此少说一句话，不编。
 *
 * @returns {Promise<{ok: boolean, imessage?: boolean, services?: string[]}>}
 */
async function probeAddress(projectId, projectSecret, address, scope) {
  const cached = probeCache.get(address);
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.value;

  let opened = [];
  try {
    opened = await createLineClients(projectId, projectSecret, { timeout: RPC_TIMEOUT_MS });
    for (const { client } of opened) {
      try {
        const imessage = await client.addresses.isIMessageAvailable(address);
        let services = [];
        try {
          const info = await client.addresses.get(address);
          services = (info?.services ?? []).map((s) => String(s));
        } catch {
          /* services 拿不到不影响主结论 */
        }
        const value = { ok: true, imessage: Boolean(imessage), services };
        probeCache.set(address, { at: Date.now(), value });
        return value;
      } catch (e) {
        logDebug(scope, `探活 ${address} 在这条线路上没成功：${String(e?.message ?? e)}`);
      }
    }
    return { ok: false };
  } catch (e) {
    logDebug(scope, `探活 ${address} 失败：${String(e?.message ?? e)}`);
    return { ok: false };
  } finally {
    await closeClients(opened);
  }
}

/**
 * 没送到的时候，把「为什么」和「该动哪儿」写清楚。
 *
 * 这条日志是这整个模块存在的理由，所以写得比别处长 —— 它要替机主完成
 * 「收不到 → 是哪一环 → 去改什么」这段推理。措辞按 `services` 分三种情况，
 * 因为解决办法完全不同：对方没开 iMessage 是让对方去开，号码不存在是自己
 * 去界面上改，探不出来就只能给个排查顺序。
 */
function explainUndelivered({ peer, probe }) {
  if (!probe?.ok) {
    return (
      `对方（${peer}）没有回投递回执。这条消息 Apple 收下了，但没送到对面 —— ` +
      `token 已经花掉了，对方什么都没收到。\n` +
      `按这个顺序查：① 这个号码是不是填错了（少一位、多一位、漏了国家码）；` +
      `② 这个号码有没有开 iMessage（对方用的是安卓、或者在设置里关掉了 iMessage）；` +
      `③ 对方手机是不是长时间离线。`
    );
  }

  if (!probe.imessage) {
    const hasSms = (probe.services ?? []).some((s) => /sms|rcs/i.test(s));
    return (
      `对方（${peer}）这个地址**不能走 iMessage**，所以这条消息送不到。\n` +
      (hasSms
        ? `这个号码本身是通的，但它只支持短信/RCS —— 对方多半在用安卓，或者把 iPhone 上的 ` +
          `iMessage 关掉了。Photon 这条线路只发 iMessage，发不了普通短信，所以换个能走 ` +
          `iMessage 的号码才行。`
        : `而且也查不到它支持别的传输方式，这个号码很可能压根不存在 —— 去「iMessage → 项目」` +
          `里核对一下号码有没有填错（国家码、位数）。`)
    );
  }

  // 地址是通的、iMessage 也开着，却没有回执 —— 这一类多半是对方离线
  return (
    `对方（${peer}）的 iMessage 是通的，但这条消息还没有投递回执。` +
    `常见原因是对方手机离线/关机，等上线后 Apple 会自己补投。` +
    `如果这个号码一直收不到，再回去核对号码有没有填错。`
  );
}

/**
 * 把攒下的这批消息的投递状态查一遍。
 *
 * 一条都没查到不算异常：专线模式下消息只落在其中一条线路上，而 `messages.get`
 * 在别的线路上会抛 NotFound。真正值得说的是「查到了，而且状态是没送到」。
 */
async function flush(projectId) {
  const q = queues.get(projectId);
  if (!q) return;
  queues.delete(projectId);

  const batch = q.items.slice(0, MAX_BATCH);
  if (!batch.length) return;
  const scope = q.label;

  let opened = [];
  try {
    opened = await createLineClients(projectId, q.projectSecret, { timeout: RPC_TIMEOUT_MS });
    if (!opened.length) return;

    // 同一个对面只报一次：一轮回复是好几条气泡，全没送到的话没必要报七遍
    const bad = new Map(); // peer -> { guid, code }
    let checked = 0;

    for (const item of batch) {
      let native = null;
      for (const { client } of opened) {
        try {
          native = await client.messages.get(item.guid);
          if (native) break;
        } catch {
          /* 这条线路上没有这条消息，换下一条 */
        }
      }
      if (!native) continue;
      checked += 1;

      const code = Number(native.sendErrorCode ?? 0);
      const delivered = Boolean(native.isDelivered) || Boolean(native.dateDelivered);
      if (delivered && !code) continue;
      if (!bad.has(item.peer)) bad.set(item.peer, { guid: item.guid, code });
    }

    if (!checked) {
      logDebug(scope, `这批 ${batch.length} 条消息在 gRPC 上都没查到，投递状态未知`);
      return;
    }

    if (!bad.size) {
      logDebug(scope, `投递检查：${checked} 条都已送达`);
      return;
    }

    for (const [peer, info] of bad) {
      if (!shouldReport(projectId, peer, info.code ? `err${info.code}` : "undelivered")) {
        logDebug(scope, `对方（${peer}）投递仍然有问题，冷却期内不重复报`);
        continue;
      }

      if (info.code) {
        /*
         * Apple 明确给了错误码 —— 这是最硬的证据，直接报，不用探活。
         * 码本身不翻译：Apple 没有公开这张表，硬编一份猜的映射比原样给出码
         * 更容易把人带偏。给了码机主能拿去搜。
         */
        logError(
          scope,
          `消息没能送到对方（${peer}），Apple 回了错误码 ${info.code}`,
          `这一轮的 token 已经花掉了，但对方没有收到。` +
            `错误码 ${info.code} 是 Apple 给的，常见于号码不支持 iMessage 或地址无效 —— ` +
            `先核对「iMessage → 项目」里的号码，再确认对方那台设备开着 iMessage。\n` +
            `消息 guid：${info.guid}`
        );
        continue;
      }

      const probe = await probeAddress(projectId, q.projectSecret, peer, scope);
      logError(
        scope,
        `消息发出去了，但对方（${peer}）没收到`,
        explainUndelivered({ peer, probe })
      );
    }
  } catch (e) {
    logDebug(scope, `投递检查没跑完：${String(e?.message ?? e)}`);
  } finally {
    await closeClients(opened);
  }
}

/**
 * 记一条刚发出去的消息，等一会儿去查它到没到。
 *
 * 只认云端模式（本地 Mac provider 没有铸币那套流程，开不了 gRPC 客户端），
 * 缺 guid 或缺凭据的直接忽略 —— 这一路上任何一步都不该抛错。
 *
 * @param {object} opts
 * @param {string} opts.projectId
 * @param {string} opts.projectSecret
 * @param {string} opts.label 日志 scope
 * @param {string} opts.guid `space.send()` 还回来那条消息的 id
 * @param {string} opts.peer 对面的号码，报错和探活都要它
 */
export function watchDelivery({ projectId, projectSecret, label, guid, peer }) {
  if (!projectId || !projectSecret || !guid || !peer) return;

  let q = queues.get(projectId);
  if (!q) {
    q = { items: [], projectSecret, label, timer: null };
    queues.set(projectId, q);
    q.timer = setTimeout(() => {
      // flush 自己把队列摘掉，这里不 await —— 定时器不该抱着一个长 Promise
      void flush(projectId);
    }, CHECK_DELAY_MS);
    // 这个定时器不该拦着进程退出
    q.timer.unref?.();
  }
  // label 用最新的：同一条线路换了角色名，日志前缀跟着变
  q.label = label;
  q.items.push({ guid, peer, at: Date.now() });
}

/**
 * 连上之后探一次**自己这条线路的号码**有没有在 iMessage 上注册。
 *
 * 这是「连上了但收不到消息」里最隐蔽的一种：Photon 把号码分配给你了、gRPC 也
 * 连得上、控制台一行「已连接，等消息中」—— 但这个号码没有注册成 iMessage。
 * 于是对方从 iPhone 发过去的是**绿色的普通短信**，压根不进这条 iMessage 线路，
 * 我们这边一条消息都收不到。两边都以为自己没问题。
 *
 * 光看连接状态是看不出来的，所以在这儿主动问一句，把它变成控制台里的一行字。
 *
 * 只在探明「没注册」时报警。探不出来（网络、权限、接口变了）一律只记 debug ——
 * 连接刚起来就报一条「可能有问题」，只会让人以为连接没成。
 *
 * @param {object} opts
 * @param {string} opts.linePhone 这条线路自己的号码（项目里的 linePhone）
 */
export async function checkLineRegistered({ projectId, projectSecret, label, linePhone }) {
  if (!projectId || !projectSecret || !linePhone) return;
  try {
    const probe = await probeAddress(projectId, projectSecret, linePhone, label);
    if (!probe.ok) {
      logDebug(label, `没能确认线路号码 ${linePhone} 的 iMessage 状态，跳过这次预检`);
      return;
    }
    if (probe.imessage) {
      logInfo(label, `预检：线路号码 ${linePhone} 已注册 iMessage`);
      return;
    }
    const services = (probe.services ?? []).join("/") || "查不到";
    logError(
      label,
      `线路号码 ${linePhone} 没有注册 iMessage —— 对方发过来的消息到不了这条线路`,
      `这个号码支持的传输方式：${services}。\n` +
        `连接本身是好的，但这个号码没在 iMessage 上激活，所以对方从 iPhone 发出去的是` +
        `绿色的普通短信，走的是运营商网络、不经过这条线路，我们这边收不到。\n` +
        `去 Photon 的项目里确认这条号码的 iMessage 激活状态；另外让对方确认一下，` +
        `他那边和你聊天的气泡是蓝色（iMessage）还是绿色（短信）—— 绿色就是这个问题。`
    );
  } catch (e) {
    logDebug(label, `预检线路号码 ${linePhone} 出错：${String(e?.message ?? e)}`);
  }
}
