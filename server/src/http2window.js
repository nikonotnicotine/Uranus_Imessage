/**
 * 把 HTTP/2 的接收窗口调大 —— 收附件慢得不像话的真正原因。
 *
 * ── 症状 ──
 *
 * 用户的 VPS 是 100M 宽带，而收一张 3.5MB 的图要几分钟。实机日志里稳定是
 * 13～18KB/s，慢到 attachread.js 那边的 60 秒停顿超时被反复触发、下到一半
 * 的字节被一次次扔掉重来。
 *
 * ── 量出来的根因 ──
 *
 * 同一条线路、同一分钟内测（scripts/diag-attach-speed.mjs）：
 *
 *     一元调用往返（RTT）  中位 267ms
 *     上行 4MB            1807ms = 2267KB/s     ← 链路本身没问题
 *     下行 3.1MB 附件      28781ms = 127KB/s     ← 慢 18 倍
 *
 * 下行那条流的形状是关键：**每块 256KB，块与块之间固定停 ~2.1 秒**。RTT 只有
 * 0.27 秒，所以这既不是带宽不够，也不是单纯的往返延迟 —— 是 HTTP/2 流控窗口。
 *
 * 吞吐的上限是「窗口 ÷ RTT」。@grpc/grpc-js 不传 `grpc-node.flow_control_window`
 * 时，窗口取 `http2.getDefaultSettings().initialWindowSize`，也就是 **65535 字节**
 * （见 @grpc/grpc-js/build/src/transport.js 里拼 sessionOptions.settings 那段）。
 * 65535 ÷ 0.267s ≈ 245KB/s，和实测的 127KB/s 同一量级 —— 对得上。服务端每推
 * 256KB 就得停下来等客户端的 WINDOW_UPDATE，一块要等好几个往返，于是就有了
 * 那个 2.1 秒的固定停顿。
 *
 * 把窗口抬到 8MB 之后，同一个附件、同一条线路：
 *
 *     默认 64KB   28781ms / 28743ms   127KB/s
 *     8MB         2724ms  /  2835ms   4570KB/s / 4719KB/s
 *
 * 快了 27～36 倍。这不是上游的问题，是我们自己一个 channel option 都没传。
 *
 * ── 为什么补在 http2.connect 上，而不是传 channelOptions ──
 *
 * `createGrpcClient` 接受 `channelOptions`，但收消息那条主链路压根不经过我们：
 * `@spectrum-ts/imessage` 在它自己的 `createCloudClients` 里硬编码调
 * `createGrpcClient({address, autoIdempotency, retry, tls, token})`，没有把
 * channelOptions 透出来。而它是用 ESM `import` 拿到 createGrpcClient 的 ——
 * ESM 的导入绑定是只读的实时绑定，从外面替换不掉。
 *
 * 剩下两条路：改 node_modules（仓库里有 patch-imessage-kit-schema.mjs 那种
 * 先例），或者补在更底下的 `http2.connect` 上。选后者，因为**小手机是给别人
 * 部署的** —— node_modules 补丁一次 `npm install` 就没了，而这个补丁跟着源码走。
 *
 * 必须同时抬两级窗口，少一个都没用：
 *   - `settings.initialWindowSize`：**流**级窗口，在 connect 时随 SETTINGS 发出去；
 *   - `session.setLocalWindowSize()`：**连接**级窗口，得等 remoteSettings 之后再调。
 *
 * grpc-js 自己只在显式传了 `grpc-node.flow_control_window` 时才去碰连接级那个
 * （transport.js 里 `if (connWin && connWin > defaultWin)`），所以光改
 * `getDefaultSettings` 的返回值是不够的 —— 流级抬上去了，连接级还卡在 64KB。
 *
 * ── 8MB 是怎么定的 ──
 *
 * 窗口要盖住带宽时延积（BDP）才不成为瓶颈：100Mbps × 0.3s ≈ 3.75MB。取 8MB
 * 留一倍余量，也够应付 RTT 更差的线路。再往上没有意义 —— 窗口大到超过 BDP
 * 之后，瓶颈就回到带宽本身了（实测 4.5MB/s 已经撞上上行那条 2.3MB/s 量级的
 * 链路能力，说明窗口已经不是限制）。
 *
 * 代价是每条连接最多多占这么多接收缓冲。进程里的 gRPC 连接是按线路算的
 * （个位数），而且只有真在传大附件时才会用满。
 *
 * ── 作用范围 ──
 *
 * 补的是整个进程的 `http2.connect`，所以这个进程里**所有** HTTP/2 客户端连接
 * 都会用大窗口。这里只有 gRPC 在用 HTTP/2（fetch 走的是 undici 自己的栈，
 * 不经过 node:http2），所以影响面就是那几条 Photon 连接。
 *
 * ── 小手机（Cloudflare Worker）上直接跳过 ──
 *
 * Workers 的 `nodejs_compat` 里没有 `node:http2`，顶层 `import` 它会让整个
 * Worker 在加载阶段就起不来。而小手机那边压根用不着这个补丁：它的 gRPC 走
 * grpc-web（见 worker/src/shims/nice-grpc.js），底下是 fetch 不是 node:http2，
 * 收消息更是走 webhook。所以认出 Worker 就直接返回，import 也放在那道判断
 * **之后**动态做，再套一层 try —— 真在哪个运行时上没有这个模块，也只是
 * 「没加速」，不会把进程带崩。
 *
 * 幂等：装过了就不再装（认 `__uranusWindowPatched` 标记）。必须在任何 gRPC
 * 客户端建立之前调用 —— 已经连上的连接不会被追溯修改。
 */

import { logDebug } from "./logs.js";

/**
 * 窗口大小（字节）。见文件头「8MB 是怎么定的」。
 *
 * 留一个环境变量口子：线路质量差异很大（RTT 1 秒的话 BDP 就要 12MB），
 * 而这个数调起来不需要改代码。给 0 或负数就当没设，走默认。
 */
const WINDOW_BYTES = (() => {
  const raw = Number(process.env.URANUS_HTTP2_WINDOW_BYTES ?? 0);
  return Number.isFinite(raw) && raw > 0 ? raw : 8 * 1024 * 1024;
})();

/** 装过没有。模块级变量不够 —— 热重载会重新执行模块体，标记得挂在 http2 上。 */
const FLAG = "__uranusWindowPatched";

/**
 * 装上补丁。在建任何 gRPC 客户端之前调用（index.js 开头）。
 *
 * 异步是因为 `node:http2` 得动态 import —— 小手机那边没有这个模块，顶层
 * import 会让 Worker 起不来（见文件头）。调用方不必 await：没 await 的话
 * 补丁晚几个微任务装上，而 gRPC 连接要到桥接启动时才建，来得及。
 *
 * @returns {Promise<boolean>} 这次真的装了就 true；已经装过、或这个运行时
 *   没有 node:http2 就 false
 */
export async function patchHttp2Window() {
  if (process.env.URANUS_WORKER === "1") return false;

  let http2;
  try {
    http2 = (await import("node:http2")).default;
  } catch {
    return false; // 没有 node:http2 的运行时：不加速，但也别炸
  }
  if (!http2?.connect || http2[FLAG]) return false;

  const original = http2.connect.bind(http2);
  http2.connect = function connectWithBigWindow(authority, options, listener) {
    /*
     * 流级窗口：跟着 connect 的 SETTINGS 帧发出去。取 max 是为了不把调用方
     * 自己设的更大的值改小 —— 真有人显式设了，那多半比我们更清楚。
     */
    const opts = { ...(options ?? {}) };
    opts.settings = {
      ...(opts.settings ?? {}),
      initialWindowSize: Math.max(WINDOW_BYTES, Number(opts.settings?.initialWindowSize ?? 0)),
    };

    const session = original(authority, opts, listener);

    /*
     * 连接级窗口：得等对端的 SETTINGS 到了才能调，所以挂在 remoteSettings 上。
     * 失败了只记一笔不抛 —— 窗口没抬成是「慢」，抛错是「连不上」，后者严重得多。
     */
    session.once("remoteSettings", () => {
      try {
        session.setLocalWindowSize(WINDOW_BYTES);
      } catch (e) {
        logDebug("http2", `连接级窗口没抬成（${String(e?.message ?? e)}），这条连接会慢一些`);
      }
    });
    return session;
  };

  http2[FLAG] = true;
  logDebug("http2", `接收窗口调到 ${(WINDOW_BYTES / 1024 / 1024).toFixed(0)}MB（默认 64KB）`);
  return true;
}
