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
 * 上游 enqueue 本来还要攒 queueWait 秒（日志里那句「6s 后把这期间的一起发」）
 * 才把这批东西发给模型，所以等几秒是白赚的。就算等满（见 RETRY_MS），代价也
 * 只是这一轮回得晚一点 —— 而丢图的代价是角色答得像什么都没收到。
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
 * @returns {Promise<Buffer>}
 * @throws 最后一次的错误。不可重试的当场抛，不等。
 */
export async function readBytes(content, scope, what) {
  const claimed = Number(content?.size ?? 0);
  const mb = (n) => (n / 1024 / 1024).toFixed(1);
  // 够大才值得喊一声。小附件每条都报会把日志刷满，而它们本来也不卡
  const loud = claimed >= LOUD_BYTES;
  if (loud) {
    logInfo(scope, `开始下载${what}（${mb(claimed)}MB），这期间这条线路的消息要排队等`);
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
        `读${what}附件断在半路，${(wait / 1000).toFixed(1)}s 后第 ${i} 次重试`,
        last
      );
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    try {
      const buf = await content.read();
      const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
      // 开始那行没喊的话，这行也不喊 —— 孤零零一句「下载完了」没有参照物
      if (loud) logInfo(scope, `${what}下载完了：${mb(buf.length)}MB，花了 ${secs}s`);
      else logDebug(scope, `${what}下载完了：${mb(buf.length)}MB，花了 ${secs}s`);
      return buf;
    } catch (e) {
      last = e;
      if (!isTransientRead(e)) throw e;
    }
  }
  throw last;
}
