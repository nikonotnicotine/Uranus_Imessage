/**
 * 读附件字节，断流了自己重试。
 *
 * ── 为什么单独一个文件 ──
 *
 * 图片（imessage.js:readImage）、语音（同文件 readAudio）、文件
 * （docread.js:readDocument）三条路都要调 `content.read()`，也都会踩同一个坑。
 * 放 imessage.js 里的话 docread.js 没法用 —— imessage.js 本来就 import
 * docread.js，反过来 import 会绕成循环依赖。
 *
 * ── 这个坑是什么 ──
 *
 * `content.read()` 看着像本地取数，其实要往 Photon 发一条 gRPC 流把字节拉回来
 * （云端回源下载）。那条流和订阅消息的那条一样会断。实机日志：
 *
 *     [桥接·Dante] 读取图片附件失败
 *       ConnectionError: Connection dropped ... downloadPrimaryAttachment
 *     [桥接·Dante] 攒消息中：1 条文本 / 0 张图 / 0 条语音，6s 后把这期间的一起发
 *     [spectrum.stream] INFO stream recovered
 *
 * 图**悄悄丢了**：调用方按「这一张没读到」处理，那轮只把文本发给模型，于是角色
 * 答得像没看见图。而紧跟着那行 `stream recovered` 说明连接几秒内就自己回来了 ——
 * 也就是说重试一次这张图本来读得到。
 *
 * ── 断的不只是附件 ──
 *
 * 同一份日志里 `imessage.messages:shared` 和 `imessage.polls:shared` 两条订阅流
 * 也在同时断。所以这不是「这张图有问题」，是底下那条 gRPC 连接抖了一下、挂在
 * 上面的流全断，那张图只是恰好在那一秒正在传 —— 换任何一张图、任何格式，
 * 结果都一样。共享线路上这种抖动躲不掉，我们能做的只有别在第一次断时就放弃。
 *
 * ── 为什么在这儿同步等 ──
 *
 * 丢图的代价是角色答得像什么都没收到；等满（见 RETRY_MS）的代价只是这一轮
 * 回得晚一点。所以宁可等。
 *
 * **但这几秒不是白赚的。** 曾经这段注释写的是「上游 enqueue 本来还要攒
 * queueWait 秒，所以等几秒是白赚的」—— 那是错的。合并窗口由**先到的那条
 * 消息**打开、倒计时只在**下一条消息进来时**才重置（见 imessage.js:enqueue），
 * 所以对方先打字、紧接着发图时，窗口早就在倒计时了，这里每等一秒都在啃那几秒。真被啃穿的表现是
 * 「角色先回了文字、图过了好一会儿才被识别」—— 用户报过这个。
 *
 * 现在上游会等：拆附件期间合并窗口被 holdPending 占住，到点了也先挂起，
 * 最后一件附件落地时才引爆（见 imessage.js 里 holdPending / releasePending
 * 那两个函数）。也就是说这里等多久都不会再把一轮拆成两轮 —— 代价回到了
 * 单纯的「这一轮晚几秒」。
 *
 * **图片例外：最多等 IMAGE_PATIENCE_MS**（imessage.js）。一张 6.4MB 的截图
 * 实机下了 321 秒，那 5 分多钟里合并窗口一直被占着、后面的字也排着，用户
 * 等了快十分钟才收到回复。所以图片等不到就先带着「图还在加载」那句话发一轮，
 * 图下完了再单独补一轮 —— 这里照样下到底，只是不再拖着整条线路。
 */

import { logDebug, logInfo, logWarn } from "./logs.js";

/**
 * 重试间隔（毫秒），按已经试过几次往后取。总共最多读 5 次、累计等 17.8 秒。
 *
 * ── 为什么等这么久 ──
 *
 * 上面那条实机日志里，polls 那条流已经到 `attempt 3, delay_ms: 2000`。SDK 是
 * 500ms 起跳往上翻的，翻到第三跳意味着这次中断前面已经失败过两轮 —— 也就是
 * 这类中断**不都是一两秒就好**。只等两三秒就收手的话，照样丢图。
 *
 * 丢一张图的代价比晚回二十秒大得多：角色会答得像对方什么都没发（用户报的
 * 「识图出 bug」就是这个观感）。而晚回在这个场景里几乎不算代价 —— 本来就有
 * 按字数算的打字停顿（delay.js），一条图文消息隔二十秒才回，看着比秒回更像人。
 *
 * ── 上限从哪来 ──
 *
 * 17.8 秒之后就不是抖动了，是连接真的断了（凭据被吊销、Photon 挂了）。那种
 * 情况该由桥接层的重连去管（imessage.js:RETRY_DELAYS，5 秒起跳到 5 分钟封顶），
 * 在这儿无限等只会把这一轮永远卡住 —— 后面的消息还排在同一条处理链上（chain）。
 */
const RETRY_MS = [800, 2000, 5000, 10_000];

/**
 * 多大才值得在控制台喊一声「开始下载」（字节）。
 *
 * 2MB：一张手机照片 1～3MB、一条语音几百 KB，那些下载起来一两秒，喊了只是
 * 噪音；视频 15MB 起步，那种是真要等几十秒的。取在这儿的意思是「人能感觉到
 * 的等待才报」。SDK 报不出 `size` 时按 debug 走，不猜。
 */
const LOUD_BYTES = 2 * 1024 * 1024;

/**
 * 这个错误是不是「连接断了，等一下可能就好了」。
 *
 * **不能看错误自己带的 `retryable`。** 上面那条实机日志里，ConnectionError 的
 * `retryable: false`、`grpcCode: 14`（UNAVAILABLE，gRPC 语义里恰恰是「重试吧」）,
 * 两个字段是反着的。SDK 那个布尔说的是「这一层还要不要自动重试」，
 * 不是「这件事重试有没有意义」。所以按错误类型名和文案认。
 *
 * 认不出来的当**不可**重试：附件压根不存在、没权限、超大小上限这些重试一万次
 * 还是同样的结果，只会让这一轮白等几秒。
 */
export function isTransientRead(err) {
  const name = String(err?.constructor?.name ?? err?.name ?? "");
  if (name === "ConnectionError" || name === "TimeoutError") return true;
  const text = `${err?.message ?? ""} ${err?.cause?.message ?? ""}`;
  return /Connection dropped|UNAVAILABLE|DEADLINE_EXCEEDED|socket hang up|ECONNRESET|ETIMEDOUT|EPIPE/i.test(
    text
  );
}

/**
 * `content.read()` 加重试。
 *
 * 不做空字节和大小检查 —— 那两样各条路的阈值不一样（图 8MB、语音 20MB、
 * 文件 10MB），留给调用方。这里只负责「把字节拿回来」这一件事。
 *
 * ── 下载开始和结束各打一行 ──
 *
 * 以前这里只在**重试时**才出声，第一次尝试一声不响。一次顺利的 15MB 下载
 * 从头到尾控制台一个字都没有，而这几十秒消息循环是堵着的（调用方在
 * `await` 这个函数）—— 用户看到的就是「最后一条日志停在上一轮，然后长时间
 * 静默，然后突然蹦出一行『收到视频：15.1MB』」，和卡死一模一样，也没法
 * 判断到底是在下载、在打模型、还是真挂了。
 *
 * 开始那行按体积分级：SDK 报得出 `size` 且超过 LOUD_BYTES 才用 info
 * （那种才是人能感觉到的等待），小的走 debug 免得把每张表情包都刷成一行。
 * 结束那行只在开始那行喊过时才打 —— 单独一行「下载完了」没有参照物。
 *
 * @param {object} content SDK 的 attachment / voice content
 * @param {string} scope 日志前缀，例如「桥接·Dante」
 * @param {string} what 日志里的东西名：「图片」/「语音」/「文件」
 * @param {{firstByteMs?: number, stallMs?: number}} [limits] 卡住多久算死（默认
 *   FIRST_BYTE_MS / STALL_MS）。只有自测会传：真等 60 秒的测试没人跑
 * @returns {Promise<Buffer>}
 * @throws 最后一次的错误。不可重试的当场抛，不等。
 */
export async function readBytes(content, scope, what, limits = {}) {
  const claimed = Number(content?.size ?? 0);
  const mb = (n) => (n / 1024 / 1024).toFixed(1);
  // 够大才值得喊一声。小附件每条都报会把日志刷满，而它们本来也不卡
  const loud = claimed >= LOUD_BYTES;
  if (loud) {
    logInfo(scope, `开始下载${what}（${mb(claimed)}MB）`);
  } else {
    logDebug(scope, `开始下载${what}${claimed ? `（${mb(claimed)}MB）` : ""}`);
  }

  const startedAt = Date.now();
  let last = null;
  for (let i = 0; i <= RETRY_MS.length; i += 1) {
    if (i) {
      const wait = RETRY_MS[i - 1];
      logWarn(
        scope,
        `读${what}附件${last instanceof TimeoutError ? "卡住了" : "断在半路"}，${(wait / 1000).toFixed(1)}s 后第 ${i} 次重试`,
        last
      );
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    try {
      const { buf, firstMs } = await fetchOnce(content, { scope, what, claimed, loud, ...limits });
      const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
      // 第一个字节等了多久：分得清「服务端半天不吐」和「吐得慢」（见 fetchOnce）
      const first = firstMs >= FIRST_BYTE_NOTE_MS ? `，其中等第一个字节 ${(firstMs / 1000).toFixed(1)}s` : "";
      // 开始那行没喊的话，这行也不喊 —— 孤零零一句「下载完了」没有参照物
      if (loud) logInfo(scope, `${what}下载完了：${mb(buf.length)}MB，花了 ${secs}s${first}`);
      else logDebug(scope, `${what}下载完了：${mb(buf.length)}MB，花了 ${secs}s${first}`);
      return buf;
    } catch (e) {
      last = e;
      if (!isTransientRead(e)) throw e;
    }
  }
  throw last;
}

/**
 * 卡住多久算「这条流死了」（毫秒）。
 *
 * ── 为什么要有这个 ──
 *
 * 实机日志：一张 6.4MB 的截图，`content.read()` 一声不响地读了 321 秒，
 * 一次重试都没触发 —— 流没断，只是半天不来字节。RETRY_MS 只管「断了」，
 * 管不到「没断但不动」，于是那 5 分多钟里只能干等，连是卡在哪儿都看不出来。
 *
 * 两个数分开：第一个字节之前服务端可能还在把附件从 Apple 那边取回来，
 * 给得宽一些；一旦开始吐了，中途 60 秒一个字节都不来就是真卡了，
 * 掐掉重开一条比接着等更有希望。掐掉抛的是 TimeoutError，走上面的重试。
 */
const FIRST_BYTE_MS = 180_000;
const STALL_MS = 60_000;

/** 下载中途多久报一次进度（毫秒）。只有 loud 的才报。 */
const PROGRESS_MS = 15_000;

/** 第一个字节等超过这么久才值得在「下载完了」那行里提一句。 */
const FIRST_BYTE_NOTE_MS = 3000;

/** 流卡住了。名字要叫 TimeoutError —— isTransientRead 靠它认出「可以重试」。 */
class TimeoutError extends Error {
  name = "TimeoutError";
}

/**
 * 读一次。SDK 给了 `stream()` 就一块块地读，没给（测试里的假附件、老版本 SDK）
 * 就退回 `read()`。
 *
 * 两者拉的是同一条 gRPC 下载流（@spectrum-ts/imessage 的
 * downloadPrimaryAttachment / downloadPrimaryAttachmentStream），区别只在
 * `read()` 攒满了才交出来 —— 中间是快是慢、卡没卡住，外面一点都看不见。
 * 自己一块块读就能：
 *
 *  - 报进度（多少 MB、多少 KB/s），日志里不再是一整段静默；
 *  - 记下第一个字节等了多久：几分钟之后才开始、一开始就飞快 = 服务端那头
 *    在等附件就绪；从头到尾都慢 = 传输慢。上次那 321 秒就是分不清这两种；
 *  - 卡住了能掐（FIRST_BYTE_MS / STALL_MS）。
 *
 * @returns {Promise<{buf: Buffer, firstMs: number}>}
 */
async function fetchOnce(
  content,
  { scope, what, claimed, loud, firstByteMs = FIRST_BYTE_MS, stallMs = STALL_MS }
) {
  if (typeof content?.stream !== "function") return { buf: await content.read(), firstMs: 0 };

  const mb = (n) => (n / 1024 / 1024).toFixed(1);
  const t0 = Date.now();
  const reader = (await content.stream()).getReader();
  const chunks = [];
  let got = 0;
  let firstMs = 0;
  let lastReport = t0;

  try {
    for (;;) {
      const limit = got ? stallMs : firstByteMs;
      let timer = null;
      const r = await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new TimeoutError(
                  got
                    ? `${what}下到 ${mb(got)}MB 之后 ${limit / 1000}s 没来新字节`
                    : `等了 ${limit / 1000}s，${what}一个字节都没来`
                )
              ),
            limit
          );
        }),
      ]).finally(() => clearTimeout(timer));
      if (r.done) break;

      const piece = Buffer.from(r.value);
      if (!got) firstMs = Date.now() - t0;
      chunks.push(piece);
      got += piece.length;

      const now = Date.now();
      if (loud && now - lastReport >= PROGRESS_MS) {
        lastReport = now;
        const rate = got / 1024 / Math.max(0.001, (now - t0 - firstMs) / 1000);
        logInfo(
          scope,
          `${what}还在下：${mb(got)}${claimed ? `/${mb(claimed)}` : ""}MB，` +
            `约 ${rate.toFixed(0)}KB/s（第一个字节等了 ${(firstMs / 1000).toFixed(1)}s）`
        );
      }
    }
  } catch (e) {
    // 掐掉底下那条 gRPC 流（SDK 的 cancel 里会 abort），别让它在后台接着传
    reader.cancel().catch(() => {});
    throw e;
  }
  return { buf: Buffer.concat(chunks), firstMs };
}

/**
 * 等一个 promise 最多 `ms` 毫秒。
 *
 * 等到了：`{done: true, value}`；没等到：`{done: false}`，**原来那个 promise
 * 不取消**，接着在后台跑 —— 调用方拿着它自己决定之后怎么收（见 imessage.js
 * 读图那段：先带着「图还在加载」这句话把这一轮发出去，图下完了再单独补一轮）。
 * 等的这段时间里它失败了就照常抛出来。
 */
export async function settleWithin(promise, ms) {
  let timer = null;
  const late = Symbol("late");
  try {
    const v = await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(late), ms);
      }),
    ]);
    return v === late ? { done: false } : { done: true, value: v };
  } finally {
    clearTimeout(timer);
  }
}
