/**
 * 查岗手机那条腿：**推一下，然后等它自己把图送回来**。
 *
 * ── 为什么和电脑那头形态不同 ──
 *
 * 电脑那头是 `GET /screenshot` 一拉就有（spy.js:grab），因为用户机器上跑着一个
 * 常驻的截图程序在监听端口。iPhone 上没有这种东西 —— App 不能后台常驻监听端口，
 * 越狱之外没有任何办法让服务端「拉」到一张 iOS 截图。iOS 上唯一能被外部叫醒的
 * 自动化入口是**快捷指令的自动化**，而它只认「收到邮件」「收到信息」这类事件。
 *
 * 所以手机这条腿是三步走：
 *
 *   1. 服务端发一封主题带关键字的邮件 → iCloud 推给 iPhone（几秒）
 *   2. iPhone 的邮件自动化被触发 → 跑快捷指令 → 截屏 → POST 回服务端
 *   3. 服务端这边一直等着那个 POST（`waitForShot`）
 *
 * ── 为什么走邮件不走 iMessage ──
 *
 * 快捷指令的「信息」自动化也能触发（条件能设发件人 + 内容包含，也能免确认
 * 立即运行）。但本项目的角色**本来就在 iMessage 上和用户聊天** —— 用同一条线路
 * 发触发消息，那条 `PHONESPY_TRIGGER` 会实实在在出现在两人的对话气泡里。
 * 用户看到这个决定用邮件：邮件是另一个信道，不打扰聊天。
 *
 * ── 为什么收码路由不走面板那套鉴权 ──
 *
 * 快捷指令的「获取 URL 内容」带不了控制台的登录态，所以这个口子只能用一个
 * 预共享的 `secret` 校验（配置里那串随机字符）。**没有 secret 就整条腿关掉** ——
 * 不能默认放一个谁都能 POST 图进来的口。
 *
 * ── 收件为什么要 FIFO 队列 ──
 *
 * 图回来时没法带上「我是哪一次请求的」（快捷指令那点表达力做不到把请求 id
 * 传下去再带回来）。所以按「最早还在等的那个」认领。并发查岗很少见，但两个角色
 * 同时查、或者用户手点了一次测试，都会出现两张图排队，认领错了不影响正确性
 * （两张都是同一部手机同一时刻的屏幕），只影响谁先拿到。
 *
 * 真正需要防的是**迟到件**：上一次超时了、图十几秒后才慢慢到，如果这时新的
 * 一次请求正在等，那张过期的图就会被误领成新的。所以超时会留一张「迟到条」
 * （`LateGuard`），在它的有效期内、且当前请求刚发出去还不到 `LATE_MIN_TRIP` 秒时，
 * 到达的第一张图直接丢掉。这一段的思路照着参考插件 core/pending.py 来。
 */

import nodemailer from "nodemailer";

import { logDebug, logInfo, logWarn } from "./logs.js";

/** 触发邮件的主题关键字。iPhone 那边的邮件自动化按「主题包含」认这个词。 */
export const TRIGGER_SUBJECT = "PHONESPY_TRIGGER";

/** 触发邮件的正文。内容不重要，但不能为空 —— 有些 SMTP 会把空正文当垃圾邮件。 */
const TRIGGER_BODY = "Screenshot request triggered.";

/** 收图路由的默认路径。改这个要和 iPhone 快捷指令里的 URL 一起改。 */
export const DEFAULT_WEBHOOK_PATH = "/phone/screenshot";

/**
 * 电量和位置的回传路径。
 *
 * 这两件事**不截图** —— 快捷指令那边用「文本」动作拼一个 JSON 直接 POST 回来
 * （`{"level": 85}` / `{"address": "…", "longitude": …, "latitude": …}`），
 * 所以不能走收图那个口子（那边会验图片魔数，一段 JSON 过不了）。
 *
 * 两个各自一条路径而不是共用一条带参数的，是因为**快捷指令里填的是死 URL**：
 * 用户在那个小小的输入框里手打一遍地址已经够烦了，再让他拼查询串只会多一处
 * 填错的地方。路径写死也就少一处要对照的东西。
 *
 * 这两条**不跟着配置里那个 webhookPath 走**（那个只管收图）。理由是它们的
 * 前缀本来就该和收图口子一致，而用户改 webhookPath 的场景是「和别的服务撞了」，
 * 撞的是那一条具体路径，不是整个 /phone 前缀。
 */
export const BATTERY_PATH = "/phone/battery";
export const LOCATION_PATH = "/phone/location";

/** 发信最多等多久。SMTP 握手 + 投递，正常两三秒。 */
const SMTP_TIMEOUT = 15000;

/**
 * 同时最多几个请求在等图。
 *
 * 设上限是因为每个等待条目都占着一个 Promise 和一份定时器；没有上限的话，
 * 一个填错地址、每次都超时的配置会让条目越积越多。8 个够用到离谱 ——
 * 正常情况下同一时刻最多一个。
 */
const MAX_PENDING = 8;

/**
 * 从发邮件到图回来，最快也得这么多秒。
 *
 * 邮件推送 + 快捷指令冷启动 + 截屏 + 转 JPEG + 上传，比这更快到达的图不可能是
 * 当前这次的。用来判断一张图到底是「新请求的」还是「上一次的迟到件」。
 */
const LATE_MIN_TRIP = 8;

/** 一张图最大多少字节。和 spy.js 的上限一致，理由见那边。 */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * 一段回传 JSON 最多多少字符。
 *
 * 电量是 `{"level":85}`，位置是一个地址加两个浮点数 —— 几十到几百字符。
 * 8000 给的是离谱的余量：真到这个量级，多半是快捷指令里 `data` 那一行选错了
 * （把截图当文本传过来）。拦在进队列之前，免得一个填错的自动化把等待位占掉。
 */
const MAX_DATA_CHARS = 8000;

/* ============================ 待领队列 ============================ */

/** 还在等图的请求。key 是 req id，插入顺序即到达顺序（Map 保序）。 */
const pending = new Map();

/** 已超时、但图可能还在路上的那些请求留下的条子。 */
let lateGuards = [];

let seqCounter = 0;

/**
 * 开一个等待条目。
 *
 * 和 `waitForShot` 分开是刻意的：**必须先挂上条目再发邮件**。反过来的话，
 * 网络快的时候图可能比 `create` 先到，那张图会因为「没有待处理请求」被丢掉。
 *
 * @returns {string} req id，交给 waitForShot / cancelShot
 * @throws {Error} 排队的太多了
 */
export function createShotRequest(label = "") {
  if (pending.size >= MAX_PENDING) {
    throw new Error(`同时等图的请求太多了（${MAX_PENDING} 个），这次先不查`);
  }
  const seq = ++seqCounter;
  const id = `shot-${seq}`;
  pending.set(id, { id, seq, label, at: Date.now(), resolve: null, data: null });
  logDebug("查岗", `手机等图条目已建：${id}${label ? `（${label}）` : ""}`);
  return id;
}

/**
 * 等那张图回来。
 *
 * @param {string} id createShotRequest 的返回值
 * @param {number} timeoutMs 等多久
 * @returns {Promise<Buffer>}
 * @throws {Error} 超时（条目会被清掉，并按需留一张迟到条）
 */
export function waitForShot(id, timeoutMs) {
  const req = pending.get(id);
  if (!req) return Promise.reject(new Error("等图条目不见了"));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      /*
       * 留一张迟到条：这次的图可能还在路上。有效期就用这次的超时时长 ——
       * 比这还晚到的图，用户早就不在等了，让它被下一次误领反而更糟。
       */
      lateGuards.push({ seq: req.seq, label: req.label, expireAt: Date.now() + timeoutMs });
      logWarn(
        "查岗",
        `手机截图等了 ${Math.round(timeoutMs / 1000)} 秒没回来（${id}）。` +
          `接下来 ${Math.round(timeoutMs / 1000)} 秒内若有图赶到，会当成它的迟到件丢掉`
      );
      reject(new Error(`等了 ${Math.round(timeoutMs / 1000)} 秒手机没把截图传回来`));
    }, timeoutMs);

    req.resolve = (buf) => {
      clearTimeout(timer);
      pending.delete(id);
      resolve(buf);
    };
  });
}

/** 不等了（发邮件就失败时用，免得条目留在队列里白占位）。 */
export function cancelShot(id) {
  pending.delete(id);
}

/** 过期的迟到条清掉。 */
function dropExpiredGuards() {
  const now = Date.now();
  lateGuards = lateGuards.filter((g) => g.expireAt > now);
}

/**
 * 刚到这张图是不是「上一次超时请求的迟到件」？
 *
 * 是 → 消费掉那张迟到条并返回 true（图丢掉）。
 *
 * 判断条件是「它不可能属于当前正在等的那个请求」：当前没人在等，或者当前那个
 * 请求刚发出去还不到 `LATE_MIN_TRIP` 秒（邮件 + 快捷指令 + 上传不可能这么快）。
 * 反过来，当前请求已经等了足够久时，这张图更像是它的 —— 那就把迟到条作废、
 * 图正常认领，免得迟到条一直挂着把后面每一次都误伤。
 */
function isLateArrival() {
  dropExpiredGuards();
  if (!lateGuards.length) return false;

  const oldest = [...pending.values()].sort((a, b) => a.at - b.at)[0];
  if (oldest && Date.now() - oldest.at >= LATE_MIN_TRIP * 1000) {
    const dropped = lateGuards.shift();
    logInfo(
      "查岗",
      `第 ${dropped.seq} 号请求的迟到件一直没来，迟到条作废，这张图判给还在等的那个`
    );
    return false;
  }

  const guard = lateGuards.shift();
  logWarn("查岗", `丢掉一张迟到的手机截图（属于已超时的第 ${guard.seq} 号请求）`);
  return true;
}

/**
 * 图到了。给最早还在等的那个。
 *
 * @returns {"ok"|"late"|"idle"} idle = 没人在等（图丢掉，但对快捷指令回 200）
 */
export function deliverShot(buf) {
  if (isLateArrival()) return "late";

  const oldest = [...pending.values()].sort((a, b) => a.at - b.at)[0];
  if (!oldest?.resolve) {
    logInfo("查岗", "收到手机截图，但这会儿没人在等（可能是超时之后才到的）");
    return "idle";
  }
  logInfo("查岗", `手机截图到了，约 ${Math.round(buf.length / 1024)}KB，交给 ${oldest.id}`);
  oldest.resolve(buf);
  return "ok";
}

/** 进程收尾 / 配置改动时清干净。 */
export function clearShotQueue() {
  pending.clear();
  lateGuards = [];
}

/* ============================ 发触发邮件 ============================ */

/**
 * 这套配置齐不齐（不齐就没法发触发邮件）。
 *
 * 缺哪样直接说哪样 —— 这几个字段填错一个就整条腿不通，而失败信息最后会进
 * 「两头都失败」那份模板给模型看，写得含糊用户没法自查。
 *
 * @returns {string} 齐了返回 ""，不齐返回缺什么
 */
export function phoneConfigProblem(api) {
  if (!api?.smtpHost?.trim()) return "没填 SMTP 服务器地址";
  if (!api?.smtpUser?.trim()) return "没填 SMTP 账号";
  if (!api?.smtpPass?.trim()) return "没填 SMTP 密码（iCloud 要用 App 专用密码）";
  if (!api?.mailTo?.trim()) return "没填收件的 iCloud 邮箱";
  if (!api?.webhookSecret?.trim()) return "没填校验密钥，收图的口子不会开";
  return "";
}

/**
 * 发一封触发邮件。
 *
 * 端口决定加密方式：465 直接 SSL，其余（通常 587）走 STARTTLS。
 * 这是 SMTP 的惯例，iCloud、QQ、163 都是这套。
 *
 * ── 主题和正文为什么能覆盖 ──
 *
 * 一开始只有「看一眼当前屏幕」这一件事，主题是配置里那个固定的
 * `PHONESPY_TRIGGER`。现在手机上有十八件事（见 spyfeatures.js），每件事在
 * iPhone 上是**各自一条**邮件自动化，靠主题词区分（iOS 的邮件自动化只能按
 * 「发件人 + 主题包含」触发）。所以主题得能按功能给。
 *
 * 正文是**传参数**用的：快捷指令那边「从输入中获取文本」拿到的就是邮件正文，
 * 闹钟几点、放哪首歌都从这儿过去（见 spyrun.js:buildBody）。
 *
 * 两个都不给时回落到原来的行为（配置里的主题 + 那句占位正文），所以单个查岗
 * 那条路一个字都不用改。
 *
 * @param {object} api 全局那份 spyApi
 * @param {{subject?:string, body?:string}} [opts] 覆盖主题 / 正文
 * @throws {Error} 发不出去（认证失败、连不上、超时）
 */
export async function sendTriggerMail(api, opts = {}) {
  const port = Number(api?.smtpPort) || 587;
  const secure = port === 465;

  const transporter = nodemailer.createTransport({
    host: String(api.smtpHost).trim(),
    port,
    secure,
    auth: { user: String(api.smtpUser).trim(), pass: String(api.smtpPass) },
    connectionTimeout: SMTP_TIMEOUT,
    greetingTimeout: SMTP_TIMEOUT,
    socketTimeout: SMTP_TIMEOUT,
  });

  const subject =
    String(opts?.subject ?? "").trim() || String(api?.subject ?? "").trim() || TRIGGER_SUBJECT;
  /*
   * 正文空着时填那句占位的话 —— 有些 SMTP 把空正文当垃圾邮件。给了参数的
   * 功能（闹钟、放歌）正文就是那个参数本身，快捷指令那边靠它干活。
   */
  const text = String(opts?.body ?? "").trim() || TRIGGER_BODY;

  try {
    await transporter.sendMail({
      from: String(api.smtpUser).trim(),
      to: String(api.mailTo).trim(),
      subject,
      text,
    });
    logInfo("查岗", `触发邮件已发给 ${api.mailTo}（主题 ${subject}）`);
  } catch (e) {
    throw new Error(whySmtp(e));
  } finally {
    // 连接池留着没意义：查岗是偶发的，下次多半隔了很久
    transporter.close();
  }
}

/**
 * 发信失败的原因，说成用户能照着排查的话。
 *
 * nodemailer 会把 SMTP 的响应码放在 `e.responseCode`、把 socket 层的错误码放在
 * `e.code`。两层都看 —— 光报 `e.message` 的话，认证失败那条是一长串英文加
 * 服务商的帮助链接，中间才夹着关键的 535。
 */
function whySmtp(e) {
  const code = e?.code || "";
  const resp = Number(e?.responseCode) || 0;

  if (resp === 535 || resp === 534 || code === "EAUTH") {
    return "SMTP 账号或密码不对（iCloud / QQ 邮箱要用 App 专用密码，不是登录密码）";
  }
  if (resp === 550 || resp === 553) return "收件地址被拒了，检查那个 iCloud 邮箱";
  if (code === "ECONNREFUSED") return "SMTP 服务器拒绝连接，检查地址和端口";
  if (code === "ETIMEDOUT" || code === "ESOCKET" || code === "ECONNECTION") {
    return "连不上 SMTP 服务器（地址、端口或者网络的问题）";
  }
  if (code === "EDNS" || code === "ENOTFOUND") return "SMTP 地址解析不了";
  if (code === "EENVELOPE") return "发件或收件地址格式不对";

  const msg = String(e?.message ?? "").split("\n")[0];
  return msg ? `发触发邮件失败（${msg}）` : "发触发邮件失败";
}

/* ============================ 收图 ============================ */

/**
 * 从快捷指令的 POST 里把图抠出来。
 *
 * 快捷指令那边「请求体 → 表单」发的是 `multipart/form-data`，Express 的
 * `express.json()` 不认这种。项目里没有 multer 之类的依赖，而这里只需要
 * 从一个结构极简的 multipart 里取两个字段，所以手写一个 —— 引一个上传中间件
 * 进来，还得考虑它和现有那套 `express.json` 的先后顺序，代价更大。
 *
 * 顺带认两种更简单的形态（有人会照着自己的习惯改快捷指令）：
 * `application/json` 带 base64、以及 `image/*` 直接把图当请求体。
 *
 * @param {Buffer} body 原始请求体
 * @param {string} contentType
 * @returns {{secret:string, image:Buffer|null}}
 */
export function parseShotUpload(body, contentType) {
  const ct = String(contentType ?? "");

  // ---- multipart/form-data（快捷指令的「表单」）----
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
  if (/multipart\/form-data/i.test(ct) && boundary) {
    const parts = parseMultipart(body, (boundary[1] || boundary[2]).trim(), ["secret", "image"]);
    return {
      secret: parts.secret ? parts.secret.toString("utf8").trim() : "",
      image: parts.image ?? null,
    };
  }

  // ---- application/json：{ secret, image: "<base64>" } ----
  if (/application\/json/i.test(ct)) {
    try {
      const obj = JSON.parse(body.toString("utf8"));
      const b64 = String(obj?.image ?? "");
      return {
        secret: String(obj?.secret ?? ""),
        image: b64 ? Buffer.from(b64, "base64") : null,
      };
    } catch {
      return { secret: "", image: null };
    }
  }

  // ---- 直接把图当请求体：secret 只能走查询串或请求头 ----
  if (/^image\//i.test(ct)) return { secret: "", image: body };

  return { secret: "", image: null };
}

/**
 * 手写的 multipart 解析，取指定的那几个字段。
 *
 * 按 `--boundary` 切段，每段用 CRLF CRLF 分头和体，从 `Content-Disposition`
 * 里读 name。**体必须按字节切**（不能 toString 再 split）—— JPEG 里任何字节
 * 组合都可能出现，转成字符串再切会把二进制搞坏。
 *
 * @param {Buffer} body
 * @param {string} boundary
 * @param {string[]} fields 要取哪几个字段
 * @returns {Record<string, Buffer>} 字段名 → 原始字节。没出现的字段不在里面
 */
function parseMultipart(body, boundary, fields) {
  const want = new Set(fields);
  const out = {};
  const sep = Buffer.from(`--${boundary}`);
  const headEnd = Buffer.from("\r\n\r\n");

  let pos = body.indexOf(sep);
  if (pos < 0) return out;
  pos += sep.length;

  while (pos < body.length) {
    // 段尾就是下一个 boundary；找不到说明这段不完整，停
    const next = body.indexOf(sep, pos);
    if (next < 0) break;

    const part = body.slice(pos, next);
    pos = next + sep.length;

    const hEnd = part.indexOf(headEnd);
    if (hEnd < 0) continue;

    const header = part.slice(0, hEnd).toString("latin1");
    // 体的末尾有一个 CRLF 是 boundary 的前缀，不属于内容
    let value = part.slice(hEnd + headEnd.length);
    if (value.length >= 2 && value[value.length - 2] === 0x0d && value[value.length - 1] === 0x0a) {
      value = value.slice(0, value.length - 2);
    }

    const name = /name="([^"]*)"/i.exec(header)?.[1] ?? "";
    if (want.has(name)) out[name] = value;
  }
  return out;
}

/**
 * 收图路由的处理逻辑，和 Express 解耦（方便直接测）。
 *
 * @returns {{status:number, text:string}} 直接回给快捷指令的东西
 */
export function handleShotUpload({ secret, image, want }) {
  if (!want) {
    logWarn("查岗", "有人往收图口子 POST，但配置里没设校验密钥，已拒绝");
    return { status: 403, text: "forbidden" };
  }
  if (secret !== want) {
    logWarn("查岗", "收到密钥不对的手机截图请求，已拒绝");
    return { status: 403, text: "forbidden" };
  }
  if (!image?.length) {
    logWarn("查岗", "收到的手机截图请求里没有图");
    return { status: 400, text: "missing image" };
  }
  if (image.length > MAX_IMAGE_BYTES) {
    logWarn("查岗", `手机截图太大（${Math.round(image.length / 1024 / 1024)}MB），已拒绝`);
    return { status: 413, text: "image too large" };
  }

  /*
   * 没人在等也回 200。回 4xx 的话快捷指令会显示一个失败通知，
   * 而这种情况（超时之后图才到）不是用户操作错了，弹通知只会让人以为配坏了。
   */
  deliverShot(image);
  return { status: 200, text: "ok" };
}

/**
 * 从 POST 里把那段 JSON 抠出来（电量 / 位置走这条）。
 *
 * 快捷指令那边是「请求体 → 表单」，两行都是**文本**：`secret` 和 `data`，
 * `data` 的值是上一步「文本」动作拼出来的那个 JSON 串。所以和收图那个口子
 * 复用同一个 multipart 解析，只是取的字段名不同。
 *
 * 顺带认 `application/json`（直接把 JSON 当请求体发）和
 * `application/x-www-form-urlencoded` —— 有人会照自己的习惯改快捷指令。
 *
 * @param {Buffer} body
 * @param {string} contentType
 * @returns {{secret:string, data:string}}
 */
export function parseDataUpload(body, contentType) {
  const ct = String(contentType ?? "");

  // ---- multipart/form-data（快捷指令的「表单」）----
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
  if (/multipart\/form-data/i.test(ct) && boundary) {
    const parts = parseMultipart(body, (boundary[1] || boundary[2]).trim(), ["secret", "data"]);
    return {
      secret: String(parts.secret ?? ""),
      data: parts.data ? parts.data.toString("utf8").trim() : "",
    };
  }

  // ---- urlencoded：secret=xxx&data=%7B...%7D ----
  if (/application\/x-www-form-urlencoded/i.test(ct)) {
    const q = new URLSearchParams(body.toString("utf8"));
    return { secret: String(q.get("secret") ?? ""), data: String(q.get("data") ?? "").trim() };
  }

  /*
   * ---- 直接把 JSON 当请求体 ----
   *
   * 两种形态都认：`{"secret":"x","data":"{...}"}`（包了一层）和
   * `{"level":85}`（就是数据本身，secret 只能走查询串或请求头）。
   * 靠有没有 data 字段区分。
   */
  const text = body.toString("utf8").trim();
  if (/application\/json/i.test(ct) || text.startsWith("{")) {
    try {
      const obj = JSON.parse(text);
      if (obj && typeof obj === "object" && obj.data !== undefined) {
        const inner = obj.data;
        return {
          secret: String(obj.secret ?? ""),
          // data 可能是串，也可能已经是对象（快捷指令有时会帮着解一层）
          data: typeof inner === "string" ? inner.trim() : JSON.stringify(inner),
        };
      }
      // 没有 data 字段：整个请求体就是数据
      return { secret: String(obj?.secret ?? ""), data: text };
    } catch {
      return { secret: "", data: "" };
    }
  }

  return { secret: "", data: "" };
}

/**
 * 收 JSON 的路由逻辑。和 `handleShotUpload` 一模一样的校验顺序，只是把
 * 「有没有图」换成「有没有数据」。
 *
 * @returns {{status:number, text:string}}
 */
export function handleDataUpload({ secret, data, want, label = "数据" }) {
  if (!want) {
    logWarn("查岗", `有人往收${label}的口子 POST，但配置里没设校验密钥，已拒绝`);
    return { status: 403, text: "forbidden" };
  }
  if (secret !== want) {
    logWarn("查岗", `收到密钥不对的${label}回传，已拒绝`);
    return { status: 403, text: "forbidden" };
  }
  if (!data) {
    logWarn("查岗", `收到的${label}回传里没有 data 字段`);
    return { status: 400, text: "missing data" };
  }
  if (data.length > MAX_DATA_CHARS) {
    // 一段电量或位置的 JSON 不可能上万字符。这么大多半是快捷指令里那个
    // 字段选错了（比如把截图选成了 data），拦下来免得进队列占位
    logWarn("查岗", `${label}回传的内容太长了（${data.length} 字符），已拒绝`);
    return { status: 413, text: "data too large" };
  }

  // 没人在等也回 200，理由同 handleShotUpload
  deliverShot(Buffer.from(data, "utf8"));
  return { status: 200, text: "ok" };
}
