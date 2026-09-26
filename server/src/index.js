import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import {
  loadConfig,
  saveConfig,
  getConfigPath,
  getDataDir,
  migrateDataLayout,
  projectLabel,
  extractLegacyPresets,
  readRawConfig,
  resolveEndpoint,
  resolveImageEndpoint,
  resolveUser,
  DEFAULT_VISION_PROMPT,
  DEFAULT_AUDIO_PROMPT,
  DEFAULT_AUDIO_PROMPT_RICH,
  DEFAULT_VIDEO_PROMPT,
} from "./config.js";
import {
  applyBundle,
  buildBundle,
  bundleFileName,
  summarize,
} from "./backup.js";
import {
  ALL_SCOPES,
  collectEntries,
  humanBytes,
  listSnapshots,
  packSnapshot,
  removeSnapshot,
  runBackup,
  runRestore,
  unpackSnapshot,
} from "./cloudbackup.js";
import { driverFor } from "./cloud/index.js";
import {
  syncBridges,
  restartBridges,
  stopAllBridges,
  getStatus,
  forgetHistory,
  igSessionFor,
} from "./imessage.js";
import { getLastPrompt } from "./lastprompt.js";
import {
  BATTERY_PATH,
  DEFAULT_WEBHOOK_PATH,
  handleDataUpload,
  handleShotUpload,
  LOCATION_PATH,
  MAX_IMAGE_BYTES as SHOT_UPLOAD_LIMIT,
  parseDataUpload,
  parseShotUpload,
} from "./spyphone.js";
import { enrollSharedUser, findSharedUser, normalizePhone } from "./photon.js";
import { envPreview } from "./env.js";
import {
  chatWithFallback,
  describeImage,
  embedText,
  listModels,
  testEndpoint,
  transcribeAudio,
  describeVideo,
} from "./llm.js";
import {
  assistantGreeting,
  buildAssistantMessages,
  resolveAssistantEndpoint,
} from "./assistant.js";
import { extractKeywords, truncate } from "./memory.js";
import {
  manualDiary,
  manualMemo,
  manualMemory,
  startDiaryTimer,
} from "./memoryhooks.js";
import {
  appendMemory,
  listDiaries,
  localDate,
  memoryKeyFor,
  readDiary,
  readDiaryLog,
  readDiaryState,
  readMemo,
  readMemories,
  readPending,
  removeDiary,
  removeMemory,
  statsFor,
  updateMemory,
  writeDiary,
  writeDiaryLog,
  writeDiaryFile,
  writeMemo,
  writePendingText,
} from "./memorystore.js";
import {
  KIND,
  embedMissing,
  exportMemoryBank,
  exportPreset,
  exportRegexRules,
  exportWorldBook,
  importMemoryBank,
  importMemoryText,
  importPreset,
  importRegexRules,
  importWorldBook,
  transferFileName,
  vectorGap,
} from "./transfer.js";
import {
  extForMime,
  generateImage,
  listRefFiles,
  MAX_TTS_CHARS,
  mimeForExt,
  pickTtsSource,
  resolveRefFile,
  saveRefFile,
  synthesizeVoice,
  toMp3ForStt,
} from "./media.js";
import {
  createEmojiTag,
  listEmojiFiles,
  listEmojiTags,
  removeEmojiFile,
  resolveEmojiFile,
  resolveEmojiTag,
  saveEmojiFile,
} from "./emoji.js";
import {
  listWallpapers,
  readWallpaperSettings,
  removeWallpaper,
  resolveWallpaper,
  saveWallpaper,
  writeWallpaperSettings,
} from "./wallpaper.js";
import {
  listLogos,
  logoMime,
  removeLogo,
  resolveLogo,
  saveLogo,
} from "./transferlogo.js";
import {
  MAX_HIGHLIGHTS,
  USER_OWNER,
  addPost,
  addStory,
  markActivityRead,
  mediaPathFor,
  readActivity,
  readHighlights,
  readPosts,
  readProfile,
  readSettings,
  readStories,
  removeHighlight,
  removePost,
  removeStory,
  saveMedia,
  saveToHighlight,
  updatePost,
  updateStory,
  writeHighlights,
  writeProfile,
  writeSettings,
} from "./igstore.js";
import { igFeed, igOwners, igProfileView } from "./instagram.js";
import { endOffline, runOfflineTurn, storyForView, summarizeNow } from "./offline.js";
/*
 * 线下存档。`mediaPathFor` / `saveMedia` / `removeStory` 三个名字和上面
 * igstore.js 的撞了，所以一律缀 `offline` —— 撞名不报错，只会让后面某条
 * 路由静悄悄读到另一个子系统的目录去。
 */
import {
  appendSummary as appendOfflineSummary,
  closeOffline,
  currentStory,
  dropLastAssistant,
  listAll as listOffline,
  mediaPathFor as offlineMediaPathFor,
  newStory,
  openOffline,
  readIndex,
  readStory,
  removeStory as removeOfflineStory,
  removeSummary,
  removeTurn,
  renameStory,
  saveMedia as saveOfflineMedia,
  setCurrent,
  updateSummary,
  updateTurn,
} from "./offlinestore.js";
import { IG_PROMPT_KEYS, defaultTemplate } from "./igprompt.js";
import { scheduleComment, schedulePublish, startIgQueue } from "./igrun.js";
import { writeAccount, writeRealSettings, writeUserAccount } from "./igaccounts.js";
import { bindAccount } from "./igapi.js";
import { pollOnce, realOverview, startIgPolling, syncOut } from "./igreal.js";
import { pollXhsReplies, startXhsPolling } from "./xhsrun.js";
import { loginStatus as xhsLoginStatus } from "./xhsapi.js";
import {
  hasToken as hasXhsToken,
  roleState as xhsRoleState,
  saveToken as saveXhsToken,
  sharedFile as xhsSharedFile,
} from "./xhsstore.js";
import { checkUpdate } from "./update.js";
import {
  deleteSession,
  listSessions,
  migrateSessionIds,
  readSession,
  saveLegacyPreset,
  writeSession,
} from "./sessions.js";
import {
  clearLogs,
  getLogs,
  logDebug,
  logError,
  logInfo,
  logWarn,
  subscribe,
} from "./logs.js";
import { canRestart, requestRestart, setShutdown } from "./restart.js";
import { clearCaches, startMaintenance } from "./maintenance.js";
import {
  MIN_PASSWORD,
  authenticate,
  changeCredentials,
  cookieHeader,
  login,
  mustChangeCredentials,
} from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = path.resolve(__dirname, "../../client/dist");

const app = express();
app.use(cors());
// 记忆库整包导入要单独放宽：一条带向量的记忆 1536 个浮点数 ≈ 30KB，
// 几百条就十几兆，12mb 挡不住。必须**挂在全局那个之前** —— body-parser
// 解析完会在 req 上留个记号，后面全局那个看见就跳过，不会解析两遍
app.use("/api/memories/:key/import", express.json({ limit: "64mb" }));
/*
 * 试看视频那条也要单独放宽，同样得**排在全局那个之前**。
 *
 * 真实链路的闸是 20MB（imessage.js:MAX_VIDEO_BYTES），而 base64 会把字节撑成
 * 4/3 —— 20MB 的视频发上来是 27MB 的请求体，全局那个 12mb 会在路由之前就
 * 413 掉。那种 413 是 body-parser 回的，长得和「中转站的网关拒了」一模一样，
 * 用户会以为是自己的中转站不行，白折腾半天。48mb 给的是 27MB 加一倍余量。
 */
app.use("/api/llm/video-test", express.json({ limit: "48mb" }));
/*
 * 查岗手机那条腿的收图口子：iPhone 的快捷指令把截图 POST 到这儿。
 *
 * **必须挂在 express.json() 之前**，而且自己收原始字节 —— 快捷指令发的是
 * multipart/form-data（里面夹着一张 JPEG），json 那个中间件解析不了这种类型，
 * 但它会把流读掉，等轮到这条路由时 body 已经没了。
 *
 * 路径是配置里可改的（默认 /phone/screenshot），所以这里用一个通吃的中间件按
 * 当前配置比对路径，而不是 app.post(固定路径)：改了配置不用重启进程。
 *
 * **这个口子不走控制台那套鉴权** —— 快捷指令带不了登录态，只能用预共享的
 * secret 校验。没配 secret 时 handleShotUpload 一律回 403，见那边的注释。
 */
app.use((req, res, next) => {
  const api = loadConfig()?.spyApi ?? {};
  const want = String(api.webhookPath || DEFAULT_WEBHOOK_PATH);
  if (req.path !== want) {
    /*
     * 路径没对上的 POST 会一路穿到 Express 的兜底 404，谁都不打日志 ——
     * 而快捷指令收到 404 照样显示成功。于是「URL 填错」和「请求根本没到」
     * 在控制台上长得一模一样，没法排查。这里把差一点点的那些喊出来：
     * 只挑带 secret 痕迹或路径形似的，避免把正常的前端 POST 也刷进日志。
     */
    const looksLikeShot =
      /screenshot|phone/i.test(req.path) ||
      req.query?.secret != null ||
      req.headers["x-spy-secret"] != null;
    if (looksLikeShot && (req.method === "POST" || req.method === "PUT")) {
      logWarn(
        "查岗",
        `有个 ${req.method} 打到 ${req.path}，但收图口子在 ${want} —— ` +
          `快捷指令里的 URL 路径对不上，请求会被当成 404 丢掉`
      );
    }
    return next();
  }
  if (req.method !== "POST" && req.method !== "PUT") return next();

  const chunks = [];
  let size = 0;
  let tooBig = false;

  // 请求一进门就记一笔：后面无论是断在半路还是解析出问题，至少知道它到了
  logInfo(
    "查岗",
    `收图口子来了个 ${req.method}（来源 ${req.ip || "未知"}，` +
      `类型 ${req.headers["content-type"] || "未声明"}）`
  );

  req.on("data", (c) => {
    // 边收边量：等 22MB 全进内存了再判断太大就没意义了
    size += c.length;
    if (size > SHOT_UPLOAD_LIMIT) {
      tooBig = true;
      req.destroy();
      return;
    }
    chunks.push(c);
  });

  req.on("end", () => {
    if (tooBig) {
      logWarn("查岗", `上传的图超过 ${Math.round(SHOT_UPLOAD_LIMIT / 1024 / 1024)}MB 上限，已掐断`);
      return res.status(413).type("text/plain").send("too large");
    }
    const body = Buffer.concat(chunks);
    const parsed = parseShotUpload(body, req.headers["content-type"]);
    /*
     * secret 还认查询串和请求头：把图当裸 body 发（Content-Type: image/jpeg）
     * 时表单里没地方放它。三个来源里取第一个非空的。
     */
    const secret =
      parsed.secret ||
      String(req.query?.secret ?? "") ||
      String(req.headers["x-spy-secret"] ?? "");
    /*
     * 解析结果也报一笔。multipart 的字段名错了（比如 image 写成 photo）时，
     * handleShotUpload 只会说「没有图」，看不出到底是没传还是传了没认出来 ——
     * 这里把收到的字节数和有没有认出图一起讲清楚。
     */
    logDebug(
      "查岗",
      `收到 ${Math.round(body.length / 1024)}KB，` +
        `secret ${secret ? "有" : "没有"}，` +
        `图 ${parsed.image?.length ? `${Math.round(parsed.image.length / 1024)}KB` : "没认出来"}`
    );
    const out = handleShotUpload({
      secret,
      image: parsed.image,
      want: String(api.webhookSecret ?? ""),
    });
    res.status(out.status).type("text/plain").send(out.text);
  });

  /*
   * 传到一半断了（手机切后台、Wi-Fi 抖、被 destroy 掉）。原来这里一声不响，
   * 于是「上传中断」在控制台上和「请求根本没来」完全一样 —— 现在有了进门那条
   * 日志，这条能接上去，看得出是断在半路。
   */
  req.on("error", (e) => {
    if (tooBig) return; // 上面主动掐断的，已经报过了
    logWarn("查岗", `收图的连接断在半路（收了 ${Math.round(size / 1024)}KB，${e?.code || e?.message || e}）`);
    if (!res.headersSent) res.status(400).type("text/plain").send("bad request");
  });
});

/*
 * 电量和位置的回传口子。
 *
 * 和上面收图那条**同一个形态、同一个理由**（必须排在 express.json() 之前、
 * 自己收原始字节、走预共享 secret 不走控制台鉴权），区别只有两处：
 *
 *  1. 路径是写死的两条（`/phone/battery` / `/phone/location`），不跟着配置里
 *     那个 webhookPath 走 —— 理由见 spyphone.js 那两个常量的注释。
 *  2. 收的是一段 JSON 而不是一张图，所以闸门按字符数算，小得多。
 *
 * 这两件事在 iPhone 上是两条独立的自动化，回传的 JSON 长得也不一样，但收下来
 * 之后**进的是同一个等待队列**（`deliverShot`）—— 队列里那个条目是谁挂的，
 * 回来的就归谁，不看内容。所以这儿一个中间件管两条路径就够了，只在日志里
 * 分一下名字，好让用户看得出是哪条自动化在动。
 */
app.use((req, res, next) => {
  const label = req.path === BATTERY_PATH ? "电量" : req.path === LOCATION_PATH ? "位置" : "";
  if (!label) return next();
  if (req.method !== "POST" && req.method !== "PUT") return next();

  const api = loadConfig()?.spyApi ?? {};
  const chunks = [];
  let size = 0;
  let tooBig = false;

  logInfo(
    "查岗",
    `收${label}的口子来了个 ${req.method}（来源 ${req.ip || "未知"}，` +
      `类型 ${req.headers["content-type"] || "未声明"}）`
  );

  req.on("data", (c) => {
    /*
     * 这道闸比收图那道紧得多（64KB vs 20MB）：这条路径上正常只会来几百字节的
     * JSON。真来了一个大家伙，八成是快捷指令里 `data` 那一行选成了截图 ——
     * 早掐早省事，而且错得明显比错得隐蔽好排查。
     */
    size += c.length;
    if (size > 64 * 1024) {
      tooBig = true;
      req.destroy();
      return;
    }
    chunks.push(c);
  });

  req.on("end", () => {
    if (tooBig) {
      logWarn(
        "查岗",
        `${label}回传的内容超过 64KB，已掐断 —— ` +
          `快捷指令里 data 那一行是不是选成了截图？那一行应该是【文本】`
      );
      return res.status(413).type("text/plain").send("too large");
    }
    const body = Buffer.concat(chunks);
    const parsed = parseDataUpload(body, req.headers["content-type"]);
    // secret 也认查询串和请求头，和收图那条一样（裸 JSON 时表单里没地方放）
    const secret =
      parsed.secret ||
      String(req.query?.secret ?? "") ||
      String(req.headers["x-spy-secret"] ?? "");

    logDebug(
      "查岗",
      `收到${label} ${body.length} 字节，secret ${secret ? "有" : "没有"}，` +
        `data ${parsed.data ? `${parsed.data.length} 字符` : "没认出来"}`
    );
    const out = handleDataUpload({
      secret,
      data: parsed.data,
      want: String(api.webhookSecret ?? ""),
      label,
    });
    res.status(out.status).type("text/plain").send(out.text);
  });

  req.on("error", (e) => {
    if (tooBig) return;
    logWarn("查岗", `收${label}的连接断在半路（${e?.code || e?.message || e}）`);
    if (!res.headersSent) res.status(400).type("text/plain").send("bad request");
  });
});

/* ================= 登录闸门 ================= */

/**
 * 不需要登录就能打的口子。
 *
 * 只有三条，而且每一条都必须是「没有登录态时也得能用」的：
 *
 *  - `/api/auth/state` 前端一进页面就问「要不要登录、是不是还在用默认密码」，
 *    它自己就是那道门的门牌；
 *  - `/api/auth/login` 门本身；
 *  - `/api/health` 探活。它只回 `{ok, service, port, igPort}`，没有任何用户
 *    数据 —— 而反代和监控脚本没法带 cookie。
 *
 * `/api/auth/change` **不在**这里：改密码要么带着「刚用默认密码登进来」的会话，
 * 要么带着正常会话，两种都是登录态。
 *
 * 收图那个口子（查岗手机）在这道闸**之前**就已经处理掉了，走的是预共享
 * secret —— iPhone 的快捷指令带不了 cookie，见上面那个中间件的注释。
 */
const OPEN_PATHS = new Set(["/api/auth/state", "/api/auth/login", "/api/health"]);

/**
 * 还在用出厂密码时，除了下面这几条都不给动。
 *
 * 用户要的是「登陆后要强制用户更换账号和密码」。光在前端挡一道不算数 ——
 * 那种「强制」绕过一次 `curl` 就没了，而这台服务上摆着全部 API 密钥。
 * 所以后端也认这一条：拿默认密码换来的会话只够改账号密码。
 *
 * `/api/config` 得放进来（GET 那一半）：登录页背后的外壳要靠它渲染，
 * 而 `saveConfig` 那半会被下面的 method 判断挡掉。
 */
const MUST_CHANGE_PATHS = new Set([
  "/api/auth/state",
  "/api/auth/change",
  "/api/auth/logout",
  "/api/health",
]);

app.use((req, res, next) => {
  // 只管 /api/*。静态文件（登录页自己）必须能拿到，否则连门都画不出来
  if (!req.path.startsWith("/api/")) return next();
  if (OPEN_PATHS.has(req.path)) return next();

  const auth = authenticate(req.headers.cookie);
  if (!auth.ok) {
    // 401 是给前端的信号：`api()` 看见它就把界面切回登录页
    return res.status(401).json({ ok: false, error: auth.why, needLogin: true });
  }

  if (auth.mustChange && !MUST_CHANGE_PATHS.has(req.path)) {
    // GET /api/config 例外：外壳要靠它才画得出来。写配置照旧挡着
    if (req.path === "/api/config" && req.method === "GET") return next();
    return res.status(403).json({
      ok: false,
      error: "还在用默认的账号密码，先改一遍再用别的功能。",
      mustChange: true,
    });
  }
  next();
});

/*
 * 登录那三条自己收 JSON。
 *
 * 全局的 `express.json()` 挂在下面几十行处（它得排在完整备份恢复那个收原始
 * 字节的中间件之后），而登录必须能读 body。body-parser 解析完会在 req 上留个
 * 记号，后面全局那个看见就跳过，不会解析两遍 —— 和记忆库整包导入同一个路子。
 *
 * limit 给得很小：这三条收的是两个短字符串，几 KB 都算宽裕。
 */
app.use("/api/auth", express.json({ limit: "16kb" }));

/** 现在这台服务要不要登录、当前是谁、是不是还在用默认密码。 */
app.get("/api/auth/state", (req, res) => {
  const auth = authenticate(req.headers.cookie);
  res.json({
    ok: true,
    loggedIn: auth.ok,
    // 没登录时也告诉它「默认密码还没改过」—— 登录页要照这个提示一句
    // 「第一次进来用 Uranus / Uranus」，不然新用户根本不知道填什么
    mustChange: mustChangeCredentials(),
    username: auth.ok ? auth.user : "",
    minPassword: MIN_PASSWORD,
  });
});

app.post("/api/auth/login", (req, res) => {
  const out = login(req.body?.username, req.body?.password);
  if (!out.ok) {
    // 401 而不是 400：这是「凭据不对」，前端据此留在登录页
    return res.status(401).json(out);
  }
  res.setHeader("Set-Cookie", cookieHeader(out.token));
  res.json({ ok: true, mustChange: out.mustChange, username: out.username });
});

/**
 * 改账号密码。校验（8 位、一个大写）在 auth.js 里，前后端各判一遍 ——
 * 前端那道是为了当场给提示，这道才是真的。
 */
app.post("/api/auth/change", (req, res) => {
  const out = changeCredentials({
    username: req.body?.username,
    password: req.body?.password,
    current: req.body?.current,
  });
  if (!out.ok) return res.status(400).json(out);
  // 改完重签一条：密码哈希进了会话签名，不重签用户自己会当场掉线
  res.setHeader("Set-Cookie", cookieHeader(out.token));
  res.json({ ok: true, username: out.username });
});

app.post("/api/auth/logout", (_req, res) => {
  res.setHeader("Set-Cookie", cookieHeader(""));
  res.json({ ok: true });
});

/**
 * 从**本地的完整备份包**恢复：收一个 .tar.gz，解回 data/。
 *
 * 光有导出没有导入的话，那个 .tar.gz 只能手动解压往 data/ 里拷 —— 完整备份
 * 的意义是「点一下能回去」，所以这条必须有。解包逻辑和从云端拉一份完全共用
 * `unpackSnapshot`（包里有的整体替换，没有的一个字节不动），只是包的来路不同：
 * 那边从云盘下，这边从用户硬盘上传。
 *
 * **必须挂在 express.json() 之前**，理由和上面那个收图口子一样：json 中间件
 * 解析不了 application/gzip，但它会把流读掉，等轮到这条路由时 body 已经没了。
 * 所以这里是 app.use 而不是跟别的备份路由排在一起（那些在下面几十行处）。
 *
 * 收**原始字节**而不是 base64 JSON：包是上百兆的量级，base64 还要再涨三分之一，
 * 而整包进内存等于把它搬两遍 —— 这个进程同时还挂着好几条线路。所以边收边落盘。
 */
const FULL_RESTORE_LIMIT = 2 * 1024 * 1024 * 1024; // 2GB。images 那档最大也就一两百兆，留足余量

app.use("/api/backup/full/restore", async (req, res, next) => {
  if (req.method !== "POST") return next();

  let dir;
  try {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "uranus-restore-"));
  } catch (e) {
    logError("备份", "临时目录建不起来", e);
    return res.status(500).json({ ok: false, error: `临时目录建不起来：${e?.message ?? e}` });
  }
  const file = path.join(dir, "upload.tar.gz");
  const drop = async () => {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
    } catch (e) {
      logWarn("备份", "临时文件没删掉，系统重启后会自己清", e);
    }
  };

  let size = 0;
  let tooBig = false;
  try {
    await new Promise((resolve, reject) => {
      const sink = fs.createWriteStream(file);
      req.on("data", (c) => {
        // 边收边量：等一两百兆全落完了再判断太大就没意义了
        size += c.length;
        if (size > FULL_RESTORE_LIMIT && !tooBig) {
          tooBig = true;
          req.destroy();
        }
      });
      req.on("error", reject);
      sink.on("error", reject);
      sink.on("finish", resolve);
      req.pipe(sink);
    });
  } catch (e) {
    await drop();
    if (tooBig) return res.status(413).json({ ok: false, error: "这个包超过 2GB，太大了" });
    const error = String(e?.message ?? e);
    logWarn("备份", `接收完整备份包时断了：${error}`, e);
    return res.status(400).json({ ok: false, error: `包没收完整：${error}` });
  }

  if (tooBig) {
    await drop();
    return res.status(413).json({ ok: false, error: "这个包超过 2GB，太大了" });
  }
  if (!size) {
    await drop();
    return res.status(400).json({ ok: false, error: "没收到文件内容" });
  }

  let result;
  try {
    result = await unpackSnapshot(file);
  } catch (e) {
    const error = String(e?.message ?? e);
    logWarn("备份", `完整备份恢复失败：${error}`, e);
    await drop();
    return res.status(400).json({ ok: false, error });
  }
  await drop();

  logInfo(
    "备份",
    `已从本地完整备份恢复：${result.applied.join("、")}，共 ${result.files} 个文件`
  );

  /*
   * 磁盘换了，内存里的旧状态必须一起丢掉，收尾再让连接对齐 —— 和
   * /api/cloud/pull 一字不差，那边的注释解释了为什么两步都不能省。
   */
  clearCaches("恢复完整备份后");
  try {
    await syncBridges(loadConfig);
  } catch (e) {
    logError("桥接", "对齐连接失败", e);
  }
  res.json({ ok: true, ...result, config: loadConfig() });
});

// 视觉测试会把 base64 图片发上来，2mb 不够用
app.use(express.json({ limit: "12mb" }));

/**
 * 让浏览器把响应当文件下载。
 *
 * 文件名里会有角色名、预设名，也就是说**大概率是中文**，而 HTTP 头的值
 * 只认 Latin-1 —— 直接塞进 `filename="..."` 会让 Node 抛
 * `ERR_INVALID_CHAR`。所以两个都给：`filename` 放一个 ASCII 兜底名（老浏览器
 * 认它），`filename*` 按 RFC 5987 放 UTF-8 的真名（现代浏览器优先认它）。
 */
function attach(res, name, type = "application/json; charset=utf-8") {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  res.setHeader("Content-Type", type);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
  );
}

// ---- 配置读写 ----
app.get("/api/config", (_req, res) => {
  res.json(loadConfig());
});

app.put("/api/config", async (req, res) => {
  const saved = saveConfig(req.body);
  logInfo("配置", "配置已保存，正在让连接对齐新配置");
  // 只动该动的连接：改了 A 的人设不该把 B 的号码踢下线
  try {
    await syncBridges(loadConfig);
  } catch (e) {
    logError("桥接", "对齐连接失败", e);
  }
  res.json(saved);
});

app.get("/api/config/path", (_req, res) => {
  res.json({ path: getConfigPath(), dataDir: getDataDir() });
});

/** 前端「还原默认」按钮要拿这句默认提示词。 */
app.get("/api/vision/default-prompt", (_req, res) => {
  res.json({ prompt: DEFAULT_VISION_PROMPT });
});

/**
 * 听音的默认提示词有两套，按角色的「识别情绪与环境音」开关挑
 * （见 config.js:resolveRoleEndpoints）。前端两套都要：一套当输入框的
 * placeholder，另一套让用户点开看看打开那个开关会变成什么。
 */
app.get("/api/audio/default-prompt", (_req, res) => {
  res.json({ prompt: DEFAULT_AUDIO_PROMPT, rich: DEFAULT_AUDIO_PROMPT_RICH });
});

/**
 * 看视频的默认提示词。只有一套 —— 听音那边的第二套是「识别情绪与环境音」
 * 开关带来的，视频本来就要求描述动作和先后顺序，没有对应的档位。
 */
app.get("/api/video/default-prompt", (_req, res) => {
  res.json({ prompt: DEFAULT_VIDEO_PROMPT });
});

// ---- 备份导出 / 导入 ----

/**
 * 导出一份备份。
 *
 * `?keys=1` 才带密钥和 Photon 凭据 —— 那样的文件等于一份明文 key 清单，
 * 由用户在界面上显式勾选。日志里只记「带没带」，不记内容。
 */
app.get("/api/backup/export", (req, res) => {
  const includeSecrets = req.query.keys === "1";
  const bundle = buildBundle(loadConfig(), { includeSecrets });
  const name = bundleFileName(includeSecrets);

  if (includeSecrets) {
    logWarn("备份", `导出了含密钥的备份 ${name}，这个文件请勿外发`);
  } else {
    logInfo("备份", `已导出备份 ${name}（不含密钥）`);
  }

  attach(res, name);
  res.send(JSON.stringify(bundle, null, 2));
});

/**
 * 导出**完整备份**到本地：整个 data/ 打成一个 .tar.gz 直接下载。
 *
 * 和上面那条（/api/backup/export）的区别就是「配置」和「全部」：那条只有
 * 一份配置 JSON，聊天记录、记忆库、Instagram、表情包一个字节都没有。用户
 * 想要的「完整备份」是这一条。
 *
 * 复用云备份的打包逻辑，只是不上传、改成回给浏览器 —— 那套已经处理好了
 * 排除 `.tmp` / `.bak`、符号链接、清单，另写一份早晚会走岔。三块范围全勾
 * （见 ALL_SCOPES）：存本地不心疼那 91MB 的图。
 *
 * 密钥仍然默认**不带**，规矩和另外两套一致：`?keys=1` 才带。
 *
 * 包直接 pipe 出去，不读进内存 —— 完整备份是 120MB 的量级，`res.send` 一个
 * Buffer 会把它整个搬进堆里，而这台机器还挂着几条 Photon 线路。
 */
app.get("/api/backup/full", async (req, res) => {
  const includeSecrets = req.query.keys === "1";

  let snap;
  try {
    snap = await packSnapshot(ALL_SCOPES, { includeSecrets });
  } catch (e) {
    const error = String(e?.message ?? e);
    logError("备份", `完整备份打包失败：${error}`, e);
    return res.status(400).json({ ok: false, error });
  }

  if (includeSecrets) {
    logWarn(
      "备份",
      `导出了含密钥的完整备份 ${snap.name}（${humanBytes(snap.bytes)}），这个文件请勿外发`
    );
  } else {
    logInfo(
      "备份",
      `已导出完整备份 ${snap.name}：${snap.entries} 个文件、` +
        `${humanBytes(snap.rawBytes)} 压到 ${humanBytes(snap.bytes)}（不含密钥）`
    );
  }

  attach(res, snap.name, "application/gzip");
  res.setHeader("Content-Length", String(snap.bytes));

  /*
   * 临时文件在 finally 里删，但**必须等流真的走完**。
   *
   * 浏览器中途取消下载（用户点了取消、关了标签页）时 pipe 不会走到 `finish`，
   * 所以 `close` 也要收 —— 那个事件无论正常结束还是中断都会来，不挂它的话
   * 一个 120MB 的临时文件会留在 tmp 里堆着。
   */
  const done = new Promise((resolve) => {
    res.on("close", resolve);
    res.on("finish", resolve);
  });
  try {
    fs.createReadStream(snap.file).pipe(res);
    await done;
  } finally {
    await snap.cleanup();
  }
});

/**
 * 「完整备份大概多大」—— 界面上那行说明用它，不用真打一次包。
 * 和 /api/cloud/estimate 同一个 `collectEntries`，只是范围写死成全勾。
 */
app.get("/api/backup/full/estimate", (req, res) => {
  const includeSecrets = req.query.keys === "1";
  try {
    const { entries, bytes } = collectEntries(ALL_SCOPES, { includeSecrets });
    res.json({ ok: true, files: entries.length, bytes });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e?.message ?? e) });
  }
});

/**
 * 导入一份备份：备份里出现的那几类整体覆盖，没出现的沿用现在的。
 * 收尾和 PUT /api/config 一样 —— 保存完让连接对齐新配置。
 */
app.post("/api/backup/import", async (req, res) => {
  const bundle = req.body?.bundle ?? req.body;
  let saved;
  try {
    saved = saveConfig(applyBundle(bundle, loadConfig()));
  } catch (e) {
    const error = String(e?.message ?? e);
    logWarn("备份", "导入失败", error);
    return res.status(400).json({ ok: false, error });
  }

  const counts = summarize(bundle);
  logInfo(
    "备份",
    `备份已导入：${counts.roles} 个角色、${counts.users} 条用户人设、` +
      `${counts.presets} 份预设、${counts.worldBooks} 本世界书`
  );

  try {
    await syncBridges(loadConfig);
  } catch (e) {
    logError("桥接", "对齐连接失败", e);
  }
  res.json({ ok: true, counts, config: saved });
});

// ---- 云备份 ----

/*
 * 上面那套（/api/backup/*）是「一份配置 JSON，用户手动下载」；这一套是
 * 「整个 data/ 的选定部分打成 tar.gz 传到云上」。前者落在本机、没有异地
 * 副本，后者就是为那件事存在的 —— 理由见 cloudbackup.js 的文件头。
 *
 * 报错一律 400 + 中文：驱动层抛的都是能照着办的话（「桶名没填」「令牌无效
 * 或已过期」），原样送到界面上。
 */

/**
 * check 和 estimate 这两个**只读**的动作，凭据从请求体里取，取不到才用盘上
 * 那份 —— 这样界面上填完能直接点「测试连接」，不用先保存。和
 * /api/tts/test 那几个测试路由一个路子。
 *
 * push / pull / list / delete **不走这条**：真往云上写东西的动作，一律以
 * 用户已经保存的设置为准。
 */
function cloudDraft(req) {
  const fromBody = req.body?.cloudBackup;
  if (fromBody && typeof fromBody === "object") return fromBody;
  return loadConfig().cloudBackup ?? {};
}

/** 探一次连通性。列得出来就算通（列举本身就是清理旧快照要用的权限）。 */
app.post("/api/cloud/check", async (req, res) => {
  const { driver, settings, label } = driverFor(cloudDraft(req));
  try {
    const result = await driver.check(settings);
    // GitHub 那条路会在仓库是公开的时候给一句警告 —— 包不加密，
    // 传公开仓库等于把聊天记录发到网上，这个必须记进日志
    if (result.warning) logWarn("云备份", `${label} ${result.where}：${result.warning}`);
    else logInfo("云备份", `${label} ${result.where} 连接正常，云端已有 ${result.count} 份快照`);
    res.json({ ok: true, ...result, provider: label });
  } catch (e) {
    const error = String(e?.message ?? e);
    logWarn("云备份", `${label}连接测试失败`, error);
    res.status(400).json({ ok: false, error });
  }
});

/**
 * 「这个包大概多大」—— 界面上勾选范围时实时显示，不用真打一次包。
 * `collectEntries` 只 stat 不读内容，91MB 那个量级也就几十毫秒。
 */
app.post("/api/cloud/estimate", (req, res) => {
  const cfg = cloudDraft(req);
  try {
    const { entries, bytes, missing } = collectEntries(cfg.scopes ?? {}, {
      includeSecrets: Boolean(cfg.includeSecrets),
    });
    res.json({ ok: true, files: entries.length, bytes, missing });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e?.message ?? e) });
  }
});

/** 备份一次：打包 → 上传 → 按保留份数清理旧的。手动和定时走同一个函数。 */
app.post("/api/cloud/push", async (_req, res) => {
  try {
    const result = await runBackup(loadConfig().cloudBackup, "控制台");
    res.json({ ok: true, ...result });
  } catch (e) {
    const error = String(e?.message ?? e);
    // 原因写进 message 而不是只挂在 detail 里：日志行默认是折叠的，
    // 只写「备份失败」的话得点开才知道为什么
    logError("云备份", `备份失败：${error}`, e);
    res.status(400).json({ ok: false, error });
  }
});

/** 云端现有的快照，新的在前。 */
app.get("/api/cloud/list", async (_req, res) => {
  try {
    const snapshots = await listSnapshots(loadConfig().cloudBackup);
    res.json({ ok: true, snapshots });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e?.message ?? e) });
  }
});

/**
 * 从云端恢复一份。
 *
 * 恢复是把磁盘上的文件整体换掉，所以之后**必须清一遍缓存**：内存里那份
 * config、各条连接内存里的上下文都还是旧的，不清的话界面上看着恢复了、
 * 实际回消息用的还是老数据。收尾再让连接对齐，和 /api/backup/import 一样。
 */
app.post("/api/cloud/pull", async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ ok: false, error: "没说要恢复哪一份" });

  let result;
  try {
    result = await runRestore(loadConfig().cloudBackup, name);
  } catch (e) {
    const error = String(e?.message ?? e);
    logError("云备份", `恢复失败：${error}`, e);
    return res.status(400).json({ ok: false, error });
  }

  // 磁盘换了，内存里的旧状态必须一起丢掉
  clearCaches("恢复备份后");
  try {
    await syncBridges(loadConfig);
  } catch (e) {
    logError("桥接", "对齐连接失败", e);
  }
  res.json({ ok: true, ...result, config: loadConfig() });
});

/** 删一份云端快照。 */
app.delete("/api/cloud/snapshot", async (req, res) => {
  const name = String(req.body?.name ?? req.query?.name ?? "").trim();
  if (!name) return res.status(400).json({ ok: false, error: "没说要删哪一份" });
  try {
    await removeSnapshot(loadConfig().cloudBackup, name);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e?.message ?? e) });
  }
});

/* ---- 单份预设 / 单本世界书的导出导入 ----
 *
 * 导出用的是 **POST + 请求体里的那一份**，不是 GET 加个 id。
 * 理由是预设和世界书在界面上是「草稿」：用户改完不点保存就不落盘，
 * 后端读磁盘只能读到上次保存的样子，导出来会少掉刚改的东西。
 * 前端把眼前那份发上来，导出的就一定是用户看见的那份。
 *
 * 导入**只解析、不落盘**：返回规范化好的那一份，由前端塞进草稿、等用户点
 * 保存。所以导入不会冲掉没保存的改动，行为和「新建一份预设」一样。
 * 发 id、补默认字段那套规矩全在 normalizePresets / normalizeWorldBooks 里，
 * 放后端做，前端再实现一遍迟早两边对不上。
 */
app.post("/api/preset/export", (req, res) => {
  const bundle = exportPreset(req.body?.preset ?? {});
  const name = transferFileName(KIND.preset, bundle.name);
  logInfo("预设", `导出了预设「${bundle.name}」→ ${name}`);
  attach(res, name);
  res.send(JSON.stringify(bundle, null, 2));
});

app.post("/api/preset/import", (req, res) => {
  const bundle = req.body?.bundle ?? req.body;
  try {
    const preset = importPreset(bundle, loadConfig().presets);
    logInfo("预设", `解析了一份导入的预设「${preset.name}」（等用户保存才落盘）`);
    res.json({ ok: true, preset });
  } catch (e) {
    const error = String(e?.message ?? e);
    logWarn("预设", "导入失败", error);
    res.status(400).json({ ok: false, error });
  }
});

/* ---- 正则规则单独导出导入 ----
 *
 * 比预设那对多一层：规则是**挂在某份预设上**的，导出要带上预设名（文件名和
 * 提示里说得清是哪来的），导入要拿眼前这份预设**现有的规则表**去重 —— 同一份
 * 文件导两次不会变成两份规则，被删掉的那几条倒会补回来。
 *
 * 和预设一样走「POST 发草稿 / 导入只解析不落盘」，所以导出的规则是用户眼前
 * 那一份（含还没保存的改动），导入进来的也只是进草稿、点保存才写盘。
 */
app.post("/api/regex/export", (req, res) => {
  const bundle = exportRegexRules(req.body?.rules, req.body?.presetName);
  const name = transferFileName(KIND.regex, bundle.name);
  logInfo("正则", `导出了 ${bundle.count} 条正则规则${bundle.name ? `（来自「${bundle.name}」）` : ""} → ${name}`);
  attach(res, name);
  res.send(JSON.stringify(bundle, null, 2));
});

app.post("/api/regex/import", (req, res) => {
  const bundle = req.body?.bundle ?? req.body;
  try {
    const out = importRegexRules(bundle, req.body?.rules);
    logInfo(
      "正则",
      `解析了一份导入的正则规则：新增 ${out.added} 条，已有 ${out.skipped} 条跳过（等用户保存才落盘）`
    );
    res.json({ ok: true, ...out });
  } catch (e) {
    const error = String(e?.message ?? e);
    logWarn("正则", "导入失败", error);
    res.status(400).json({ ok: false, error });
  }
});

app.post("/api/world/export", (req, res) => {
  const bundle = exportWorldBook(req.body?.book ?? {});
  const name = transferFileName(KIND.world, bundle.name);
  logInfo("世界书", `导出了世界书「${bundle.name}」→ ${name}`);
  attach(res, name);
  res.send(JSON.stringify(bundle, null, 2));
});

app.post("/api/world/import", (req, res) => {
  const bundle = req.body?.bundle ?? req.body;
  try {
    const book = importWorldBook(bundle, loadConfig().worldBooks);
    logInfo("世界书", `解析了一本导入的世界书「${book.name}」（等用户保存才落盘）`);
    res.json({ ok: true, book });
  } catch (e) {
    const error = String(e?.message ?? e);
    logWarn("世界书", "导入失败", error);
    res.status(400).json({ ok: false, error });
  }
});

// ---- 运行日志 ----

app.get("/api/logs", (req, res) => {
  const since = Number(req.query.since);
  const limit = Number(req.query.limit);
  res.json({
    logs: getLogs({
      since: Number.isFinite(since) ? since : undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
    }),
  });
});

app.delete("/api/logs", (_req, res) => {
  clearLogs();
  res.json({ ok: true });
});

/**
 * 日志实时推送（SSE）。
 * 前端连上后先补发历史，再持续推新的——刷新页面不会丢上下文。
 */
app.get("/api/logs/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // 挂 Nginx 反代时不关掉缓冲，SSE 会被攒着不发
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  const send = (entry) => {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  };

  const since = Number(req.query.since);
  for (const entry of getLogs({ since: Number.isFinite(since) ? since : undefined, limit: 300 })) {
    send(entry);
  }

  const unsubscribe = subscribe(send);
  // 心跳：防止代理把长时间没数据的连接掐掉
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

// ---- iMessage 桥接状态 ----
app.get("/api/status", (_req, res) => {
  // canRestart 不是桥接的事（它说的是这个**进程**能不能重启自己），
  // 所以不塞进 getStatus()，在这儿拼上去。前端靠它决定重启按钮点不点得动
  res.json({ ...getStatus(), canRestart: canRestart() });
});

// 手动重启桥接（不需要先改配置）。带 projectId 就只重启那一条，否则全部
app.post("/api/imessage/restart", async (req, res) => {
  const projectRefId = req.body?.projectId;
  try {
    logInfo(
      "桥接",
      projectRefId
        ? `收到手动重启请求（项目 ${projectRefId}）`
        : "收到手动重启请求（全部）"
    );
    const result = await restartBridges(loadConfig, projectRefId);
    res.json({ ok: true, ...result, ...getStatus() });
  } catch (e) {
    logError("桥接", "重启桥接失败", e);
    res.status(400).json({ ok: false, error: String(e?.message ?? e) });
  }
});

/**
 * 重启**整个服务**（不是桥接）。
 *
 * 和上面那条 `/api/imessage/restart` 是两回事：那条只是把桥接连接停掉再连
 * 一遍，进程还是原来那个。这条是让进程退出、由启动器重新拉起 —— 用在
 * 「代码更新了」「某个模块状态脏了」「内存涨上去了」这类桥接重连解决不了的
 * 情况上。
 *
 * `ok:false` 是**业务失败**（这份服务不是启动器拉起来的，退了就没人开回来），
 * 照旧走 200 —— 不是意外，前端要把这句话原样显示给用户看。
 */
app.post("/api/restart", (_req, res) => {
  const result = requestRestart("控制台按钮");
  res.json(result);
});

/**
 * 清理缓存。清什么、为什么只清这些，见 maintenance.js:clearCaches ——
 * 控制台上这个按钮和「定时清缓存」走的是同一个函数，行为一个字都不差。
 */
app.post("/api/cache/clear", (_req, res) => {
  try {
    res.json({ ok: true, ...clearCaches("控制台") });
  } catch (e) {
    logError("系统", "清理缓存失败", e);
    res.status(500).json({ ok: false, error: String(e?.message ?? e) });
  }
});

/**
 * 查有没有新版本。**只查，不装** —— 为什么不自动更新见 update.js 的文件头。
 *
 * 一律回 200：查不通（GitHub 连不上、被限流、仓库还没发过版）不是这台服务的
 * 故障，原因在 body 的 `error` 里，前端照那句话显示就行。用 4xx/5xx 的话
 * 浏览器控制台会红一片，而这件事压根不影响服务本身。
 *
 * `?force=1` 跳过那一刻钟的缓存，对应界面上「再查一次」。
 */
app.get("/api/update/check", async (req, res) => {
  const force = req.query?.force === "1" || req.query?.force === "true";
  res.json(await checkUpdate({ force }));
});

/**
 * 登记手机号，向 Photon 换一条 iMessage 线路号码。
 *
 * 凭据一律从本地配置里读（不从请求体收），所以 Project Secret 不需要
 * 再从浏览器发一遍——请求体只带「哪个项目」和「哪个手机号」。
 * 成功后把手机号和线路号码写进 data.config.json。
 */
app.post("/api/imessage/enroll", async (req, res) => {
  const config = loadConfig();
  const projects = config.projects ?? [];
  const projectRefId = req.body?.projectId;
  // 不给 projectId 时退到第一个项目，兼容只有一个号码的常见情形
  const project = projectRefId
    ? projects.find((p) => p.id === projectRefId)
    : projects[0];

  if (!project) {
    const error = projectRefId
      ? `找不到项目 ${projectRefId}`
      : "还没有任何项目，先在 iMessage 面板里新建一个";
    logWarn("Photon", "登记失败", error);
    return res.status(400).json({ ok: false, error });
  }

  const phoneNumber = normalizePhone(req.body?.phone ?? project.myPhone);
  const label = projectLabel(config, project.id);

  try {
    logInfo("Photon", `正在为「${label}」登记手机号 ${phoneNumber}`);
    // 先查有没有登记过：重复创建会白占项目的共享用户配额
    const existing = await findSharedUser({
      projectId: project.projectId,
      projectSecret: project.projectSecret,
      phoneNumber,
    });
    const result =
      existing ??
      (await enrollSharedUser({
        projectId: project.projectId,
        projectSecret: project.projectSecret,
        phoneNumber,
      }));

    // 记下来，前端刷新后还能看到自己该发给哪个号
    saveConfig({
      ...config,
      projects: projects.map((p) =>
        p.id === project.id
          ? { ...p, myPhone: phoneNumber, linePhone: result.assignedPhoneNumber }
          : p
      ),
    });
    logInfo(
      "Photon",
      `「${label}」${existing ? "复用已有登记" : "登记成功"}，线路号码 ${result.assignedPhoneNumber}`
    );

    // 凭据没变，但线路刚开通，让这条连接起来
    try {
      await syncBridges(loadConfig);
    } catch (e) {
      logError("桥接", "对齐连接失败", e);
    }

    res.json({
      ok: true,
      projectId: project.id,
      assignedPhoneNumber: result.assignedPhoneNumber,
      userId: result.userId,
      reused: Boolean(existing), // true = 复用已有登记，没有新占配额
      phone: phoneNumber,
    });
  } catch (e) {
    logError("Photon", `「${label}」登记失败`, e);
    res.status(e?.status && e.status >= 400 ? e.status : 400).json({
      ok: false,
      error: String(e?.message ?? e),
      phone: phoneNumber,
      projectId: project.id,
    });
  }
});

// ---- LLM 测试 / 模型列表 ----

/**
 * 三条路由都收「已经解析好的 endpoint」。
 *
 * 前端从草稿里的服务商源直接拼出来发过来，所以不用先保存配置就能测；
 * 服务端这边也就不用再理解 primary/fallback/vision 的区别了。
 */
function bodyEndpoint(req) {
  const ep = req.body?.endpoint ?? {};
  return {
    type: String(ep.type ?? "custom"),
    url: String(ep.url ?? ""),
    key: String(ep.key ?? ""),
    model: String(ep.model ?? ""),
    ...(typeof ep.temperature === "number" ? { temperature: ep.temperature } : {}),
  };
}

/** 测试连接。 */
app.post("/api/llm/test", async (req, res) => {
  const label = String(req.body?.label ?? "API");
  const result = await testEndpoint(bodyEndpoint(req), label);
  res.status(result.ok ? 200 : 400).json(result);
});

/** 拉模型列表，给「获取模型列表」弹窗用。 */
app.post("/api/llm/models", async (req, res) => {
  const label = String(req.body?.label ?? "API");
  const result = await listModels(bodyEndpoint(req), label);
  res.status(result.ok ? 200 : 400).json(result);
});

/**
 * 测试识别图片：前端可以上传一张图，不传就用内置的纯色小图，
 * 后者只验证「这个模型收图不报错」，不保证描述准确。
 */
app.post("/api/llm/vision-test", async (req, res) => {
  // 16×16 纯红 PNG，够小到能塞进源码，也是合法图片
  const FALLBACK_PNG =
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGO4o6ZGEmIY1TCqYfhqAAATqigQ9JeO5gAAAABJRU5ErkJggg==";

  const base64 = req.body?.image?.base64 ?? FALLBACK_PNG;
  const mimeType = req.body?.image?.mimeType ?? "image/png";
  const builtin = !req.body?.image?.base64;

  try {
    const description = await describeImage(bodyEndpoint(req), req.body?.prompt, {
      base64,
      mimeType,
      name: req.body?.image?.name,
    });
    logInfo("视觉", "测试识别成功", description);
    res.json({ ok: true, description, builtin });
  } catch (e) {
    const error = String(e?.message ?? e);
    logWarn("视觉", "测试识别失败", error);
    res.status(400).json({ ok: false, error, builtin });
  }
});

/**
 * 测试识别语音：必须真传一段音频上来 —— 识图那边能用内置纯色图凑合，
 * 声音没有等价物（塞一段假音频进源码既大又测不出什么）。
 *
 * 走的路和真实链路完全一样：先过 ffmpeg 转 16kHz 单声道 mp3，再打
 * Gemini 原生的 generateContent。所以这个按钮顺带验的是 ffmpeg 在不在。
 */
app.post("/api/llm/audio-test", async (req, res) => {
  const base64 = String(req.body?.audio?.base64 ?? "");
  if (!base64) {
    return res.status(400).json({ ok: false, error: "没收到音频，先选一个文件" });
  }
  const name = String(req.body?.audio?.name ?? "");
  const ext = (name.split(".").pop() ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

  try {
    const out = await toMp3ForStt(Buffer.from(base64, "base64"), {
      ext,
      mimeType: String(req.body?.audio?.mimeType ?? ""),
      scope: "听音",
    });
    const text = await transcribeAudio(bodyEndpoint(req), req.body?.prompt, {
      base64: out.buffer.toString("base64"),
      mimeType: out.mimeType,
      name,
    });
    logInfo("听音", "测试识别成功", text);
    res.json({ ok: true, text, seconds: out.duration ?? null, mimeType: out.mimeType });
  } catch (e) {
    const error = String(e?.message ?? e);
    logWarn("听音", "测试识别失败", error);
    res.status(400).json({ ok: false, error });
  }
});

/**
 * 测试看视频。这个按钮比识图、听音那两个都更值得点一次。
 *
 * 理由是**上游吃不吃得下跟中转站强相关，而且失败得很晚**：实测五家里有一家
 * 网关连 12MB 都直接 413（它听语音是好的），52MB 那档五家里两家拒。等到对方
 * 真发来一段视频才发现这家不行，那一轮已经上传了几十秒、还占着 27MB 内存。
 *
 * 不转码、不压缩，原样发 —— 和真实链路一致（imessage.js:readVideo 也不转），
 * 所以这次成了就说明那条路真的能走通。
 *
 * 这条路由**不自己卡体积**：请求体的上限已经由上面那个 48mb 的中间件管着，
 * 而「20MB 以内」是真实链路的闸；试的时候用户想拿一段更大的探探这家的底
 * （比如想知道 30MB 会不会过），没有理由拦。
 */
app.post("/api/llm/video-test", async (req, res) => {
  const base64 = String(req.body?.video?.base64 ?? "");
  if (!base64) {
    return res.status(400).json({ ok: false, error: "没收到视频，先选一个文件" });
  }
  const name = String(req.body?.video?.name ?? "");
  const mimeType = String(req.body?.video?.mimeType ?? "") || "video/mp4";
  // base64 串长 × 3/4 就是原始字节数，够准了（用来在日志和回复里报个体积）
  const bytes = Math.floor((base64.length * 3) / 4);

  const started = Date.now();
  try {
    const text = await describeVideo(bodyEndpoint(req), req.body?.prompt, {
      base64,
      mimeType,
      name,
    });
    const ms = Date.now() - started;
    logInfo("看视频", `测试识别成功（${(bytes / 1024 / 1024).toFixed(1)}MB，${ms}ms）`, text);
    res.json({ ok: true, text, ms, bytes, mimeType });
  } catch (e) {
    const error = String(e?.message ?? e);
    logWarn("看视频", "测试识别失败", error);
    // 把体积和耗时一起回去：413 那类失败里，这两个数就是唯一有用的线索
    res.status(400).json({ ok: false, error, ms: Date.now() - started, bytes });
  }
});

// ---- 语音合成 / 生成图片 ----
/**
 * 试合成一条语音。连接面板上点一下就知道通不通。
 *
 * **密钥只从已保存的配置读**，不收请求体里的 —— 和 /api/env/preview 一个理由：
 * 不让密钥出现在请求日志里。代价是新填的凭据要先点保存才能测，界面上写了。
 *
 * 音频以 base64 回给浏览器，前端拿 <audio> 试听 —— 听一遍比任何「连接成功」
 * 的绿字都可信（音色对不对、语速怎么样，只有耳朵能判）。
 */
app.post("/api/tts/test", async (req, res) => {
  const config = loadConfig();
  const voiceId = String(req.body?.voiceId ?? "");
  const text = String(req.body?.text ?? "").trim() || "你好，这是一条测试语音。";

  const source = pickTtsSource(config.ttsApi);
  if (!source) {
    return res.status(400).json({
      ok: false,
      error: "三家 TTS 都没开，或者凭据没填全（填完记得先保存）。",
    });
  }

  try {
    const out = await synthesizeVoice(config.ttsApi, voiceId, text, "语音");
    logInfo("语音", `测试合成成功（${out.source}）`);
    res.json({
      ok: true,
      source: out.source,
      ms: out.ms,
      mimeType: out.mimeType,
      base64: out.buffer.toString("base64"),
    });
  } catch (e) {
    const error = String(e?.message ?? e);
    logWarn("语音", "测试合成失败", error);
    res.status(400).json({ ok: false, error, source: source.name });
  }
});

/**
 * 试出一张图。生图模型是全局挑的（resolveImageEndpoint），所以不用传模型。
 *
 * 可以带 `ref`（图库里的名字）试图生图那条路 —— 那条走的是
 * /images/edits 加 multipart，和文生图是**两个不同的端点**，
 * 中转站支持前者不代表支持后者，得能单独试。
 */
app.post("/api/image/test", async (req, res) => {
  const config = loadConfig();
  const endpoint = resolveImageEndpoint(config);
  if (!endpoint) {
    return res.status(400).json({
      ok: false,
      error: "没有可用的生图模型。给某个已开启的模型勾上「生图」分类（勾完记得先保存）。",
    });
  }

  const prompt = String(req.body?.prompt ?? "").trim() || "一只坐在窗台上的橘猫，阳光很好";
  const ref = String(req.body?.ref ?? "").trim();
  let refFile = null;
  if (ref) {
    refFile = resolveRefFile(ref);
    if (!refFile) {
      return res.status(400).json({
        ok: false,
        error: `${getDataDir()}/images/ 里找不到「${ref}」对应的图片文件。`,
      });
    }
  }

  try {
    const out = await generateImage(endpoint, { prompt, refFile }, "生图");
    logInfo("生图", `测试出图成功（${endpoint.label}${ref ? `，参考图「${ref}」` : ""}）`);
    res.json({
      ok: true,
      label: endpoint.label,
      ms: out.ms,
      mimeType: out.mimeType,
      base64: out.buffer.toString("base64"),
    });
  } catch (e) {
    const error = String(e?.message ?? e);
    logWarn("生图", "测试出图失败", error);
    res.status(400).json({ ok: false, error, label: endpoint.label });
  }
});

// ---- 参考图图库 ----

/**
 * data/images/ 里**实际**有哪些图片。
 *
 * 前端拿它和配置里的 referenceImages 对一遍，标出「图库里填了这条、
 * 但文件夹里没有这个文件」—— 那种情况下模型会照着清单写 `[小猫]`，
 * 到发图那一步才失败，不如提前显出来。
 */
app.get("/api/images", (_req, res) => {
  res.json({ files: listRefFiles(), dir: path.join(getDataDir(), "images") });
});

/**
 * 读一张参考图，给图库面板做缩略图。
 *
 * 两道安全边界：resolveRefFile 里的 path.basename 挡路径穿越，
 * REF_EXTS 白名单挡「让它读 data.config.json」—— 那个文件不在白名单里，
 * 探不到，返回 404。
 */
app.get("/api/images/:name", (req, res) => {
  const file = resolveRefFile(req.params.name);
  if (!file) return res.status(404).json({ ok: false, error: "找不到这张图" });
  res.setHeader("Content-Type", mimeForExt(path.extname(file)));
  // 文件是用户随手替换的，别让浏览器缓存住旧的那张
  res.setHeader("Cache-Control", "no-cache");
  fs.createReadStream(file).pipe(res);
});

/**
 * 传一张参考图进 data/images/参考图/。
 *
 * 和壁纸那条一样走 base64 JSON，不引 multipart。图在**浏览器里**就压过一遍了
 * （client/src/imagefile.js），到这儿已经是几百 KB 的量级 —— 用户原话是
 * 「提供自动压缩的功能，不要让内存爆满」，压缩放在服务端的话，这台机器还挂着
 * 几条 Photon 线路，几十张图连着解码重编码会把它拖垮。
 *
 * 只落盘，不动 config：图库里那条「名称 + 描述」的记录由前端接着调
 * PUT /api/config 补上（用户可能只想传张图先看看，不一定马上要登记）。
 */
app.post("/api/images/upload", (req, res) => {
  const { name, base64, mimeType } = req.body ?? {};
  if (!base64 || typeof base64 !== "string") {
    return res.status(400).json({ ok: false, error: "没收到图片内容" });
  }
  try {
    const saved = saveRefFile(name, base64, mimeType);
    logInfo("参考图", `已上传 ${saved.file}`);
    res.json({ ok: true, ...saved, files: listRefFiles() });
  } catch (e) {
    logWarn("参考图", "上传失败", e);
    res.json({ ok: false, error: String(e?.message ?? e) });
  }
});

// ---- 表情包 ----

/*
 * 和参考图一样不进 config.json：图片文件在 data/images/emojis/<标签>/ 下面，
 * 标签就是文件夹名 —— 硬盘上有什么标签就注入什么，config 里一条都不存
 * （以前存过一份「勾了哪些」，和角色的黑名单重复，已经整个删掉）。
 * 这几条路由只管硬盘上的文件夹和文件。
 */

/**
 * data/images/emojis/ 下面有哪些标签、各有几张图。
 *
 * 空文件夹也列出来（count 为 0）—— 用户刚建好还没放图时得看得见它，
 * 不然会以为建错地方了。真正拦住「空标签别注入给模型」的是 prompt.js。
 */
app.get("/api/emojis", (_req, res) => {
  res.json({ tags: listEmojiTags(), dir: path.join(getDataDir(), "images", "emojis") });
});

/** 一个标签下面的文件清单（名字 + 字节数），图库要用它铺缩略图。 */
app.get("/api/emojis/:tag", (req, res) => {
  if (!resolveEmojiTag(req.params.tag)) {
    return res.status(404).json({ ok: false, error: "找不到这个表情包标签" });
  }
  res.json({ tag: req.params.tag, files: listEmojiFiles(req.params.tag) });
});

/**
 * 建一个标签（= 在 emojis/ 下面开一个子文件夹）。
 *
 * 全新安装时 emojis/ 是空的，没有这条的话「直接在图库里上传」无处可传，
 * 用户得先去开文件管理器建文件夹 —— 那这个上传功能等于白做。
 * 名字的收口在 emoji.js:createEmojiTag（basename + 剔非法字符 + 限长）。
 */
app.post("/api/emojis", (req, res) => {
  const tag = createEmojiTag(req.body?.tag);
  if (!tag) return res.status(400).json({ ok: false, error: "标签名不能为空" });
  logInfo("表情包", `已建标签 ${tag}`);
  res.json({ ok: true, tag, tags: listEmojiTags() });
});

/**
 * 传一张表情包进某个标签。压缩在浏览器里做，理由同 /api/images/upload。
 *
 * 标签必须已经存在 —— 不替用户凭 URL 里的名字建文件夹：模型/前端手滑传错
 * 标签名时，悄悄建出一个空文件夹比报错更难查。
 */
app.post("/api/emojis/:tag/upload", (req, res) => {
  const { name, base64, mimeType } = req.body ?? {};
  if (!base64 || typeof base64 !== "string") {
    return res.status(400).json({ ok: false, error: "没收到图片内容" });
  }
  try {
    const file = saveEmojiFile(req.params.tag, name, base64, mimeType);
    if (!file) return res.status(404).json({ ok: false, error: "找不到这个表情包标签" });
    logInfo("表情包", `已上传 ${req.params.tag}/${file}`);
    res.json({ ok: true, file, tag: req.params.tag, files: listEmojiFiles(req.params.tag) });
  } catch (e) {
    logWarn("表情包", "上传失败", e);
    res.json({ ok: false, error: String(e?.message ?? e) });
  }
});

/**
 * 读一张表情包，给图库做缩略图。
 *
 * 三道安全边界：标签和文件名各过一次 path.basename（只挡一段的话
 * `/api/emojis/file/开心/..%2F..%2Fdata.config.json` 还是能穿出去），
 * 再加后缀白名单 —— 见 emoji.js:resolveEmojiFile。
 */
app.get("/api/emojis/file/:tag/:file", (req, res) => {
  const full = resolveEmojiFile(req.params.tag, req.params.file);
  if (!full) return res.status(404).json({ ok: false, error: "找不到这张表情包" });
  res.setHeader("Content-Type", mimeForExt(path.extname(full)));
  res.setHeader("Cache-Control", "no-cache");
  fs.createReadStream(full).pipe(res);
});

/**
 * 删一张表情包。删的是**硬盘上的文件**，没有回收站。
 *
 * 这是用户要的「图库里最好可以显示缩略图，方便删减表情包」的那半 ——
 * 对着缩略图挑出不想要的直接删，比开文件管理器一张张对着看快得多。
 * 和参考图那条「只删记录、文件不动」相反：表情包压根没有记录可删，
 * 标签是文件夹长出来的，能删的只有文件本身。
 */
app.delete("/api/emojis/:tag/:file", (req, res) => {
  if (!removeEmojiFile(req.params.tag, req.params.file)) {
    return res.status(404).json({ ok: false, error: "找不到这张表情包" });
  }
  logInfo("表情包", `已删除 ${req.params.tag}/${req.params.file}`);
  res.json({ ok: true, tag: req.params.tag, files: listEmojiFiles(req.params.tag) });
});

// ---- 界面壁纸 ----

/*
 * 壁纸不走 /api/config，是刻意的：保存配置会顺带 syncBridges（见上面那条
 * PUT /api/config），换张壁纸不该把所有 Photon 线路重启一遍。配置那套还是
 * 「草稿 + 点保存」，而壁纸要的是点一下立刻变。所以这几条路由自己管
 * data/wallpapers/，跟 config.json 完全不相干。
 */

/** 有哪些壁纸、当前用哪张、遮罩多浓。前端一进页面就拉这一条。 */
app.get("/api/wallpaper", (_req, res) => {
  res.json({
    files: listWallpapers(),
    ...readWallpaperSettings(),
    dir: path.join(getDataDir(), "wallpapers"),
  });
});

/** 换一张 / 调遮罩。写进去的值会被收口（current 必须真的存在，veil 夹到 0.2~1）。 */
app.put("/api/wallpaper", (req, res) => {
  const saved = writeWallpaperSettings(req.body ?? {});
  res.json({ ok: true, files: listWallpapers(), ...saved });
});

/**
 * 上传一张壁纸。走 base64 JSON，不引 multipart —— express.json 的上限
 * 已经是 12mb，前端那边卡了 8MB，识图测试也是这么传的。
 */
app.post("/api/wallpaper/upload", (req, res) => {
  const { name, base64, mimeType } = req.body ?? {};
  if (!base64 || typeof base64 !== "string") {
    return res.status(400).json({ ok: false, error: "没收到图片内容" });
  }
  try {
    const file = saveWallpaper(name, base64, mimeType);
    logInfo("壁纸", `已上传 ${file}`);
    res.json({ ok: true, file, files: listWallpapers() });
  } catch (e) {
    logWarn("壁纸", "上传失败", e);
    res.json({ ok: false, error: String(e?.message ?? e) });
  }
});

/**
 * 删一张。删的正好是当前那张时，wallpaper.js 会把 current 一并清空。
 *
 * 内置壁纸（assets/wallpapers/）会抛错而不是返回 false —— 它确实在，
 * 只是不给删，和「找不到」是两回事，得让前端把话说清楚。
 */
app.delete("/api/wallpaper/:file", (req, res) => {
  try {
    if (!removeWallpaper(req.params.file)) {
      return res.status(404).json({ ok: false, error: "找不到这张壁纸" });
    }
  } catch (e) {
    return res.json({ ok: false, error: String(e?.message ?? e) });
  }
  res.json({ ok: true, files: listWallpapers(), ...readWallpaperSettings() });
});

/**
 * 读壁纸原图。安全边界在 resolveWallpaper 里：path.basename 挡路径穿越，
 * 后缀白名单挡「让它读 settings.json / data.config.json」。
 */
app.get("/api/wallpaper/file/:file", (req, res) => {
  const file = resolveWallpaper(req.params.file);
  if (!file) return res.status(404).json({ ok: false, error: "找不到这张壁纸" });
  res.setHeader("Content-Type", mimeForExt(path.extname(file)));
  // 同名换图要能立刻看到，别让浏览器缓存住旧的那张
  res.setHeader("Cache-Control", "no-cache");
  fs.createReadStream(file).pipe(res);
});

// ---- 转账卡片的缩略图 ----

/*
 * 和壁纸那几条同一个道理：素材自己管一个目录（data/transfer-logos/），
 * 传一张图不该顺带 syncBridges 把所有 Photon 线路重启一遍。
 *
 * **「用哪张」不在这儿** —— 那是 role.transfer.logo，跟着角色走、随配置保存。
 * 这几条只管「有哪些图可选」。
 */

/** 有哪些 logo。前端打开角色那个转账分区时拉这一条。 */
app.get("/api/transfer-logo", (_req, res) => {
  res.json({ files: listLogos(), dir: path.join(getDataDir(), "transfer-logos") });
});

/** 传一张。和壁纸上传同一个形状：base64 JSON，不引 multipart。 */
app.post("/api/transfer-logo/upload", (req, res) => {
  const { name, base64, mimeType } = req.body ?? {};
  if (!base64 || typeof base64 !== "string") {
    return res.status(400).json({ ok: false, error: "没收到图片内容" });
  }
  try {
    const file = saveLogo(name, base64, mimeType);
    logInfo("转账", `已上传 logo ${file}`);
    res.json({ ok: true, file, files: listLogos() });
  } catch (e) {
    logWarn("转账", "logo 上传失败", e);
    res.json({ ok: false, error: String(e?.message ?? e) });
  }
});

/**
 * 删一张。
 *
 * **不去清哪个角色在用它** —— 配置那边只存文件名，真发的时候读不出来就退化成
 * 不带图的卡片（renderLogo 返回 null）。反过来「删一张图顺手改所有角色的配置」
 * 才是真会咬人的：那会 syncBridges 一次、还可能把用户正在编辑的草稿冲掉。
 *
 * 内置那几个抛错而不是返回 false，照壁纸的口径。
 */
app.delete("/api/transfer-logo/:file", (req, res) => {
  try {
    if (!removeLogo(req.params.file)) {
      return res.status(404).json({ ok: false, error: "找不到这张 logo" });
    }
  } catch (e) {
    return res.json({ ok: false, error: String(e?.message ?? e) });
  }
  res.json({ ok: true, files: listLogos() });
});

/**
 * 读原图，给前端做预览。安全边界都在 resolveLogo 里（path.basename 挡路径穿越、
 * 后缀白名单挡「让它读 data.config.json」）。
 *
 * 发出去的是**原文件**而不是渲染后那张 JPEG：预览要看的是「这个素材长什么样」。
 */
app.get("/api/transfer-logo/file/:file", (req, res) => {
  const file = resolveLogo(req.params.file);
  if (!file) return res.status(404).json({ ok: false, error: "找不到这张 logo" });
  res.setHeader("Content-Type", logoMime(file));
  // 同名换图要能立刻看到
  res.setHeader("Cache-Control", "no-cache");
  fs.createReadStream(file).pipe(res);
});

// ---- Instagram ----

/*
 * 和壁纸那几条一个道理，只是更硬：这边是**高频写入**（点一次赞、来一条评论
 * 都要落盘），走 /api/config 的话每次互动都会 syncBridges 一次，把所有
 * Photon 线路踢下线。所以 IG 自己管 data/instagram/，跟 config.json 不相干。
 *
 * 唯一的交集是**角色开关**（role.instagram）—— 那个确实在配置里，因为它决定
 * 的是「这个角色要不要花钱打模型」，和 webSearch / imageGen 同一类东西。
 */

/** 首页：feed + 快拍条 + 有哪些 owner。前端一进页面拉这一条。 */
app.get("/api/ig/feed", (_req, res) => {
  res.json(igFeed(loadConfig()));
});

/** 一个人的主页：资料 + 九宫格 + 活着/过期的快拍 + 精选。 */
app.get("/api/ig/profile/:owner", (req, res) => {
  res.json(igProfileView(loadConfig(), req.params.owner));
});

/** 改主页资料（八个字段）。谁的主页都能改 —— 角色的从三点菜单进。 */
app.put("/api/ig/profile/:owner", (req, res) => {
  const saved = writeProfile(req.params.owner, req.body ?? {});
  res.json({ ok: true, profile: saved });
});

/**
 * 全局设置：快拍存活时长、默认版式、提示词模板。
 *
 * 回的东西里多带一份 `promptDefaults` —— 八条模板的**代码默认值**。
 * 控制台要把它当占位符显示（「留空 = 用这段」），但这份文案绝不能在前端
 * 再抄一遍：抄了就会和 igprompt.js 分叉，改了后端前端还显示老的。
 * GET 和 PUT 都带，因为前端 save() 是拿响应直接替换整个 settings 的。
 */
function igSettingsPayload() {
  return {
    ...readSettings(),
    promptDefaults: Object.fromEntries(IG_PROMPT_KEYS.map((k) => [k, defaultTemplate(k)])),
  };
}

app.get("/api/ig/settings", (_req, res) => {
  res.json(igSettingsPayload());
});

app.put("/api/ig/settings", (req, res) => {
  writeSettings(req.body ?? {});
  res.json({ ok: true, ...igSettingsPayload() });
});

/**
 * 排队这一步**不能带垮写操作本身**。
 *
 * 帖子已经落盘了、评论已经在页面上了，这时候 pushQueue 要是抛了（盘满、
 * 文件被占），回 500 只会让前端以为没发出去、然后用户再发一遍。所以吞掉、
 * 记日志：代价是这一条没人来互动，不是内容丢了。
 */
function igSchedule(what, run) {
  try {
    const tasks = run() ?? [];
    if (tasks.length) logInfo("Instagram", `${what}：给 ${tasks.length} 个角色排了互动`);
    return tasks;
  } catch (e) {
    logError("Instagram", `${what}：互动没排上（内容已经发出去了）`, e);
    return [];
  }
}

/** 一次写入之后新冒出来的那几条评论 / 快拍回复（按 id 比，顺序不作数）。 */
function igNewEntries(before, after) {
  const had = new Set((before ?? []).map((c) => c?.id));
  return (after ?? []).filter((c) => c?.id && !had.has(c.id));
}

/** 发帖。手动发（用户自己或替角色发）走这条，模型发的走标签解析那条链路。 */
app.post("/api/ig/posts/:owner", (req, res) => {
  const owner = req.params.owner;
  const post = addPost(owner, req.body ?? {});
  logInfo("Instagram", `${owner} 发了一条帖子`);
  // 刷得到这条的角色各掷一次骰子，延后点赞 / 评论 —— 规则全在 igrun.js
  igSchedule(`${owner} 的新帖子`, () =>
    schedulePublish(loadConfig(), owner, post, { isStory: false })
  );
  res.json({ ok: true, post });
});

/** 改帖子：配文、图片增删。 */
app.put("/api/ig/posts/:owner/:id", (req, res) => {
  const post = updatePost(req.params.owner, req.params.id, req.body ?? {});
  if (!post) return res.status(404).json({ ok: false, error: "找不到这条帖子" });
  res.json({ ok: true, post });
});

/** 删帖。图片文件一并清掉（没被别处引用的话），见 igstore:removePost。 */
app.delete("/api/ig/posts/:owner/:id", (req, res) => {
  if (!removePost(req.params.owner, req.params.id)) {
    return res.status(404).json({ ok: false, error: "找不到这条帖子" });
  }
  res.json({ ok: true, posts: readPosts(req.params.owner) });
});

/** 点赞 / 取消赞。用户点角色的帖子时顺手记一条互动。 */
app.post("/api/ig/posts/:owner/:id/like", (req, res) => {
  const { actor = USER_OWNER } = req.body ?? {};
  const list = readPosts(req.params.owner);
  const post = list.find((p) => p.id === req.params.id);
  if (!post) return res.status(404).json({ ok: false, error: "找不到这条帖子" });

  const has = post.likes.includes(actor);
  const likes = has ? post.likes.filter((a) => a !== actor) : [...post.likes, actor];
  const saved = updatePost(req.params.owner, req.params.id, { likes });
  res.json({ ok: true, post: saved, liked: !has });
});

/**
 * 评论。
 *
 * 用户评论角色的帖子之后，那个角色**可能**会回一句 —— 那是 instagram.js 的
 * 业务规则（replyChance），排进队列延后跑，不在这条路由里同步做。这条只负责
 * 把评论落盘。
 */
app.post("/api/ig/posts/:owner/:id/comments", (req, res) => {
  const { actor = USER_OWNER, text = "", replyTo = "" } = req.body ?? {};
  if (!String(text).trim()) {
    return res.status(400).json({ ok: false, error: "评论不能是空的" });
  }
  const list = readPosts(req.params.owner);
  const post = list.find((p) => p.id === req.params.id);
  if (!post) return res.status(404).json({ ok: false, error: "找不到这条帖子" });

  const comments = [...post.comments, { owner: actor, text: String(text), replyTo }];
  const saved = updatePost(req.params.owner, req.params.id, { comments });
  // id 是落盘那一步才发的（igstore:normalizeComment），所以比一下才知道是哪条
  const fresh = igNewEntries(post.comments, saved?.comments)[0];
  if (fresh) {
    igSchedule(`${actor} 的评论`, () =>
      scheduleComment(loadConfig(), req.params.owner, saved, fresh, { isStory: false })
    );
  }
  res.json({ ok: true, post: saved });
});

/** 删一条评论（用户删自己的、或者删角色说得不合适的那句）。 */
app.delete("/api/ig/posts/:owner/:id/comments/:commentId", (req, res) => {
  const list = readPosts(req.params.owner);
  const post = list.find((p) => p.id === req.params.id);
  if (!post) return res.status(404).json({ ok: false, error: "找不到这条帖子" });
  // 删顶层评论时把它下面的回复一并带走，不留孤儿
  const gone = new Set([req.params.commentId]);
  const comments = post.comments.filter((c) => !gone.has(c.id) && !gone.has(c.replyTo));
  const saved = updatePost(req.params.owner, req.params.id, { comments });
  res.json({ ok: true, post: saved });
});

/** 发快拍。 */
app.post("/api/ig/stories/:owner", (req, res) => {
  const owner = req.params.owner;
  const story = addStory(owner, req.body ?? {});
  logInfo("Instagram", `${owner} 发了一条快拍`);
  // 只有**用户**的快拍会惊动角色 —— 角色发的那条 schedulePublish 直接返回空，
  // 理由见那个函数的注释（场景模板里压根没有 charStory）
  igSchedule(`${owner} 的新快拍`, () =>
    schedulePublish(loadConfig(), owner, story, { isStory: true })
  );
  res.json({ ok: true, story });
});

/*
 * 改快拍。
 *
 * 这条路由被两个地方用：编辑器改配文 / 换图，以及**快拍播放器底下那条回复框**
 * （前端是整个 replies 数组覆盖着写回来的，见 ig/app.jsx:onReply）。所以要
 * 比一比新旧，认出后者 —— 用户回了角色的快拍，那个角色该有机会接一句。
 */
app.put("/api/ig/stories/:owner/:id", (req, res) => {
  const before = readStories(req.params.owner).find((s) => s.id === req.params.id);
  const story = updateStory(req.params.owner, req.params.id, req.body ?? {});
  if (!story) return res.status(404).json({ ok: false, error: "找不到这条快拍" });
  for (const fresh of igNewEntries(before?.replies, story.replies)) {
    igSchedule(`${fresh.owner} 回了条快拍`, () =>
      scheduleComment(loadConfig(), req.params.owner, story, fresh, { isStory: true })
    );
  }
  res.json({ ok: true, story });
});

app.delete("/api/ig/stories/:owner/:id", (req, res) => {
  if (!removeStory(req.params.owner, req.params.id)) {
    return res.status(404).json({ ok: false, error: "找不到这条快拍" });
  }
  res.json({ ok: true, stories: readStories(req.params.owner) });
});

/**
 * 把一条快拍存进精选。
 *
 * 手机上从快拍播放器右上角三点「保存到角色主页」进来，自己的从底栏「精选」进来。
 * 满三个之后返回 409 —— 用户得先删一个，界面上照这个提示。
 */
app.post("/api/ig/highlights/:owner", (req, res) => {
  const { storyId = "", highlightId = "", title = "", cover = "" } = req.body ?? {};
  const saved = saveToHighlight(req.params.owner, storyId, { highlightId, title, cover });
  if (!saved) {
    const full = readHighlights(req.params.owner).length >= MAX_HIGHLIGHTS;
    return res.status(full ? 409 : 404).json({
      ok: false,
      error: full ? `精选最多 ${MAX_HIGHLIGHTS} 个，先删一个再存` : "找不到这条快拍",
    });
  }
  res.json({ ok: true, highlight: saved, highlights: readHighlights(req.params.owner) });
});

/** 改精选：换封面、改标题、调里面的快拍。 */
app.put("/api/ig/highlights/:owner", (req, res) => {
  const list = Array.isArray(req.body?.highlights) ? req.body.highlights : [];
  writeHighlights(req.params.owner, list);
  res.json({ ok: true, highlights: readHighlights(req.params.owner) });
});

app.delete("/api/ig/highlights/:owner/:id", (req, res) => {
  if (!removeHighlight(req.params.owner, req.params.id)) {
    return res.status(404).json({ ok: false, error: "找不到这组精选" });
  }
  res.json({ ok: true, highlights: readHighlights(req.params.owner) });
});

/** 互动记录（右上角那个爱心）。只记别人对**用户**的互动。 */
app.get("/api/ig/activity", (_req, res) => {
  const list = readActivity();
  res.json({ items: list, unread: list.filter((a) => !a.read).length });
});

app.post("/api/ig/activity/read", (_req, res) => {
  res.json({ ok: true, items: markActivityRead() });
});

/**
 * 上传一张图（走 base64 JSON，和壁纸那条一样，不引 multipart）。
 * 返回的文件名要塞进帖子/快拍的 images 里。
 */
app.post("/api/ig/media", (req, res) => {
  const { base64, mimeType } = req.body ?? {};
  if (!base64 || typeof base64 !== "string") {
    return res.status(400).json({ ok: false, error: "没收到图片内容" });
  }
  const file = saveMedia(base64, extForMime(mimeType).replace(/^\./, ""));
  if (!file) return res.json({ ok: false, error: "图片没能存下来" });
  res.json({ ok: true, file });
});

/**
 * 读一张 IG 图。安全边界在 mediaPathFor 里：文件名白名单卡死
 * （只允许 `[A-Za-z0-9_.-]`，挡住路径穿越和「让它读 data.config.json」）。
 */
app.get("/api/ig/media/:file", (req, res) => {
  const file = mediaPathFor(req.params.file);
  if (!file || !fs.existsSync(file)) {
    return res.status(404).json({ ok: false, error: "找不到这张图" });
  }
  res.setHeader("Content-Type", mimeForExt(path.extname(file)));
  res.setHeader("Cache-Control", "no-cache");
  fs.createReadStream(file).pipe(res);
});

/* ---- 真 Instagram ---- */

/**
 * 真 IG 的状态总览：每个角色绑了谁、token 还有几天、图床配没配。
 *
 * **响应里没有任何凭据** —— token 和图床的 api_secret 一个字节都不回
 * （见 igreal.js:realOverview）。这条 GET 的响应会进浏览器网络面板、
 * 可能被截图分享，而里面任何一个凭据泄出去都等于把号送人。
 */
app.get("/api/ig/real", (_req, res) => {
  res.json(realOverview(loadConfig()));
});

/**
 * 绑定 / 解绑一个账号。`roleName` 空串 = 你自己的大号。
 *
 * 绑定会**真的打一次 Meta 的接口**（`GET /me`）来验证 —— 验不通就不落盘，
 * 理由见 igapi.js:bindAccount。所以这条路由可能要等几秒，
 * 前端那个按钮得有 loading 态。
 */
app.post("/api/ig/real/bind", async (req, res) => {
  const { roleName = "", token = "" } = req.body ?? {};
  const clean = String(token).trim();
  /*
   * trim 一次再用。空串是有语义的（= 你自己的大号），所以 `"  "` 这种
   * 只有空格的名字必须先塌成空串 —— 不塌的话它会走进 writeAccount，
   * 而那边对空名字返回 null，等于点了「绑定」什么也没发生、也没有报错。
   */
  const name = String(roleName).trim();

  if (!clean) {
    // 空 token = 解绑。不打接口，直接删记录
    if (name) writeAccount(name, { token: "" });
    else writeUserAccount({ token: "" });
    logInfo("Instagram", `${name || "你的大号"} 解绑了真 Instagram`);
    return res.json({ ok: true, ...realOverview(loadConfig()) });
  }

  try {
    await bindAccount(name, clean);
    res.json({ ok: true, ...realOverview(loadConfig()) });
  } catch (e) {
    // 400 而不是 500：token 粘错、过期都是用户能自己修的事
    res.status(400).json({ ok: false, error: String(e?.message ?? e) });
  }
});

/**
 * 真 IG 的全局设置：轮询间隔、勿扰、白名单、是否同步你自己的号、图床凭据。
 *
 * 图床的 key / secret **只在这条 PUT 里进来**，之后再也不出去（GET 只回一个
 * `configured` 布尔）。前端把输入框留空 = 不改那一项，所以这里要把空串滤掉 ——
 * 不滤的话用户改个轮询间隔就会把图床凭据清空。
 */
app.put("/api/ig/real/settings", (req, res) => {
  const body = req.body ?? {};
  const patch = {};
  for (const key of ["intervalHours", "syncUser", "allowFrom", "dnd", "mentionsBroken"]) {
    if (body[key] !== undefined) patch[key] = body[key];
  }
  if (body.imageHost && typeof body.imageHost === "object") {
    const host = {};
    for (const key of ["cloudName", "apiKey", "apiSecret"]) {
      const value = String(body.imageHost[key] ?? "").trim();
      if (value) host[key] = value;
    }
    if (Object.keys(host).length) patch.imageHost = host;
  }
  writeRealSettings(patch);
  res.json({ ok: true, ...realOverview(loadConfig()) });
});

/**
 * 立刻同步一次（界面上那个按钮）。
 *
 * `force` 跳过「到点了吗」和勿扰 —— 用户自己点的，那就是他现在想要。
 * 这一步可能很慢（续期 + 拉帖子 + 拉每个角色的评论 + 补发），所以前端
 * 那个按钮要禁用到返回为止。
 */
app.post("/api/ig/real/poll", async (_req, res) => {
  try {
    const result = await pollOnce(loadConfig(), { force: true });
    res.json({ ok: true, result, ...realOverview(loadConfig()) });
  } catch (e) {
    logError("Instagram", "手动同步真 Instagram 时出错", e);
    res.status(500).json({ ok: false, error: String(e?.message ?? e) });
  }
});

/**
 * 把一条已经在本地的帖子 / 快拍补发到真 IG（面板上那条「同步到真 IG」）。
 *
 * 幂等：已经发过的（`remote.mediaId` 有值）直接返回成功，不会发第二遍。
 */
app.post("/api/ig/real/publish/:owner/:id", async (req, res) => {
  const { owner, id } = req.params;
  const isStory = Boolean(req.body?.isStory);
  const item = isStory
    ? readStories(owner).find((s) => s.id === id)
    : readPosts(owner).find((p) => p.id === id);
  if (!item) return res.status(404).json({ ok: false, error: "找不到这条内容" });

  const result = await syncOut(loadConfig(), owner, item, { isStory });
  // 没发出去也回 200：那不是接口错误，是业务上的「这次没成」，前端要把
  // why 原样显示给用户（「图床还没配」这种话得让他看见）
  res.json({ ok: result.ok, error: result.why ?? "", result });
});

// ---- 小红书（经用户自己跑的 xiaohongshu-mcp）----

/** 前端传来的地址：只认 http(s)，没传就用角色上存的。 */
function xhsBase(raw, role) {
  const s = String(raw ?? "").trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(s)) return s;
  return String(role?.xiaohongshu?.baseUrl || "http://localhost:18060").replace(/\/+$/, "");
}

/**
 * 某个角色的小红书流水：发过的笔记、回过的评论、水位、上次出错。
 * 令牌只回「有没有」，不回本体。
 */
app.get("/api/xhs/:roleId", (req, res) => {
  const role = loadConfig().roles.find((r) => r.id === req.params.roleId);
  if (!role) return res.status(404).json({ ok: false, error: "找不到这个角色" });
  const s = xhsRoleState(role.id);
  res.json({
    ok: true,
    hasToken: hasXhsToken(xhsBase("", role)),
    watermark: s.watermark,
    lastPollAt: s.lastPollAt,
    lastError: s.lastError,
    notes: s.notes.slice(-20).reverse(),
    replies: s.replies.slice(-30).reverse(),
  });
});

/**
 * 查 xiaohongshu-mcp 连不连得上、登的是哪个号。地址可以用还没保存的
 * （body.baseUrl）—— 用户刚敲进去就想试一下。
 */
app.post("/api/xhs/:roleId/check", async (req, res) => {
  const role = loadConfig().roles.find((r) => r.id === req.params.roleId);
  const base = xhsBase(req.body?.baseUrl, role);
  try {
    const st = await xhsLoginStatus(base);
    res.json({ ok: true, baseUrl: base, ...st });
  } catch (e) {
    res.json({ ok: false, baseUrl: base, error: String(e?.message ?? e) });
  }
});

/**
 * 存 / 清 xiaohongshu-mcp 的访问令牌。按地址存在 data/xiaohongshu/secrets.json，
 * **不放在角色对象上** —— 角色会被导出、进云备份。
 */
app.put("/api/xhs/token", (req, res) => {
  const base = xhsBase(req.body?.baseUrl, null);
  saveXhsToken(base, req.body?.token ?? "");
  res.json({ ok: true, baseUrl: base, hasToken: hasXhsToken(base) });
});

/** 手动看一轮评论（不管到没到点、回评论开没开）。可能要一两分钟。 */
app.post("/api/xhs/:roleId/poll", async (req, res) => {
  const config = loadConfig();
  const role = config.roles.find((r) => r.id === req.params.roleId);
  if (!role) return res.status(404).json({ ok: false, error: "找不到这个角色" });
  try {
    const result = await pollXhsReplies(config, role, { force: true, session: igSessionFor(loadConfig) });
    res.json({
      ok: result.ok,
      error: result.ok ? "" : result.reason ?? "",
      reason: result.reason ?? "",
      picked: result.picked ?? 0,
      dropped: result.dropped ?? 0,
      replied: (result.replied ?? []).map((d) => ({ from: d.comment.fromName, comment: d.comment.text, reply: d.text })),
    });
  } catch (e) {
    logError("小红书", `手动看 ${role.name} 的评论时出错`, e);
    res.json({ ok: false, error: String(e?.message ?? e) });
  }
});

// ---- 环境感知预览 ----

/**
 * 这个角色此刻会注入的环境前缀，以及两个城市的解析结果。
 *
 * 界面上的实时预览和城市校验共用这一个接口 —— 直接把「现在会注入什么」
 * 显示出来，比任何说明文字都清楚。
 *
 * 环境字段可以用查询参数覆盖已保存的值：用户刚敲进输入框的城市还没保存，
 * 而预览的全部意义就是看这个城市查出来是什么。没带的参数沿用已保存的。
 *
 * **密钥不走查询参数**，只从已保存的配置读 —— 不让密钥出现在 URL、
 * 浏览器历史和后端访问日志里。代价是新填的密钥要先点保存才能在预览里生效，
 * 界面上写了这一句。
 */
app.get("/api/env/preview", async (req, res) => {
  const config = loadConfig();
  const role = config.roles.find((r) => r.id === req.query.roleId);
  if (!role) return res.status(404).json({ ok: false, error: "角色不存在" });

  const q = req.query;
  const saved = role.env ?? {};
  const savedApi = saved.weather?.api ?? {};
  const bool = (v, dflt) => (v === undefined ? dflt : v === "1" || v === "true");
  const str = (v, dflt) => (v === undefined ? dflt : String(v));
  const env = {
    time: {
      enabled: bool(q.time, saved.time?.enabled !== false),
      mode: str(q.mode, saved.time?.mode ?? "apart") === "same" ? "same" : "apart",
      userCity: str(q.userCity, saved.time?.userCity ?? ""),
      charCity: str(q.charCity, saved.time?.charCity ?? ""),
      workday: bool(q.workday, saved.time?.workday !== false),
    },
    weather: {
      enabled: bool(q.weather, Boolean(saved.weather?.enabled)),
      range: bool(q.range, Boolean(saved.weather?.range)),
      tomorrow: bool(q.tomorrow, saved.weather?.tomorrow !== false),
      api: {
        enabled: bool(q.wapi, Boolean(savedApi.enabled)),
        qweather: {
          enabled: bool(q.qw, Boolean(savedApi.qweather?.enabled)),
          alerts: bool(q.qwAlerts, Boolean(savedApi.qweather?.alerts)),
        },
        weatherapi: {
          enabled: bool(q.wa, Boolean(savedApi.weatherapi?.enabled)),
          alerts: bool(q.waAlerts, Boolean(savedApi.weatherapi?.alerts)),
        },
      },
    },
  };

  try {
    res.json({ ok: true, ...(await envPreview({ ...role, env }, config.weatherApi)) });
  } catch (e) {
    logWarn("环境", "生成预览失败", e);
    res.status(400).json({ ok: false, error: String(e?.message ?? e) });
  }
});

// ---- 对话记录（会话存档）----

/** 全部会话的摘要，「上下文」面板左边那列用。 */
app.get("/api/sessions", (_req, res) => {
  res.json({ sessions: listSessions() });
});

app.get("/api/sessions/:id", (req, res) => {
  res.json(readSession(req.params.id));
});

/**
 * 整份覆盖消息（前端删单条 / 清空会话 / 改一条都走这里）。
 *
 * 写完磁盘**必须**把这条会话的内存历史也丢掉：挂着的 runner 手里攥着自己
 * 那一份，只改磁盘的话下一轮照旧按旧的发给模型 —— 表现就是「明明清空了
 * 上下文，模型还记得我之前发的那几条」。丢掉之后 handleTurn 会从磁盘
 * 重新读最后 maxContext 条，两层重新对齐。
 */
app.put("/api/sessions/:id", (req, res) => {
  const saved = writeSession(req.params.id, req.body?.messages);
  if (!saved) return res.status(400).json({ ok: false, error: "会话 ID 不合法" });
  if (forgetHistory(req.params.id)) {
    logInfo("上下文", `会话 ${req.params.id} 的存档被改过，已丢掉内存里那份，下一轮重新读`);
  }
  res.json(saved);
});

app.delete("/api/sessions/:id", (req, res) => {
  const ok = deleteSession(req.params.id);
  // 同上：存档删了，内存里那份也得跟着走，否则下一轮它又被写回磁盘
  if (forgetHistory(req.params.id)) {
    logInfo("上下文", `会话 ${req.params.id} 已删除，内存里那份也丢掉了`);
  }
  res.json({ ok });
});

/**
 * 最后一次真正发给模型的那份提示词。
 *
 * 只在内存里留一份、每轮覆盖 —— 排查「人设怎么没生效」够用了，
 * 存历史要么吃内存要么写盘，都不值当。服务重启就没了。
 */
app.get("/api/prompt/last", (_req, res) => {
  res.json({ prompt: getLastPrompt() });
});

// ---- 角色记忆库（记忆 / 备忘录 / 日记）----

/**
 * 这些路由的 `:key` 是**角色记忆库的 key**（`memoryKeyFor` 算出来的文件名），
 * 不是角色 id。所以每条都得先过白名单再落到文件上 —— key 是从角色名派生的，
 * 而角色名是用户随便填的，`../` 那一类必须挡住（`/api/env/preview` 立的规矩：
 * 凡是进路径的参数一律白名单，不做黑名单过滤）。
 *
 * 挡法是**反查**：只认「当前配置里真有某个角色算出这个 key」的那些值。
 * 比正则更严，而且顺手把角色对象拿到了 —— 手动生成那几条要用它。
 */
function roleByKey(config, key) {
  const want = String(key ?? "");
  for (const role of config?.roles ?? []) {
    if (memoryKeyFor(role) === want) return role;
  }
  return null;
}

/** 找不到就 404 并返回 null，调用方直接 `if (!ctx) return`。 */
function memoryCtx(req, res) {
  const config = loadConfig();
  const role = roleByKey(config, req.params.key);
  if (!role) {
    res.status(404).json({ ok: false, error: "没有这个角色的记忆库（角色可能已删除或改过名）" });
    return null;
  }
  return { config, role, key: memoryKeyFor(role) };
}

/**
 * 全部角色的记忆库概览，「记忆库」面板左边那列用。
 *
 * key 一起返回：前端后面所有请求都用它，自己按角色名再算一遍容易和后端分叉。
 */
app.get("/api/memories", (_req, res) => {
  const config = loadConfig();
  const roles = (config.roles ?? []).map((role) => {
    const key = memoryKeyFor(role);
    return {
      roleId: role.id,
      roleName: role.name,
      key,
      gates: {
        memory: Boolean(role.memories?.memory?.enabled),
        memo: Boolean(role.memories?.memo?.enabled),
        diary: Boolean(role.memories?.diary?.enabled),
      },
      stats: statsFor(key),
    };
  });
  res.json({ roles });
});

/**
 * 一个角色的记忆库全貌：三样东西 + 待总结的原文 + 上次定时日记的错误。
 *
 * 日记只给**文件清单**不给正文（`listDiaries` 本来就不读正文）——
 * 聊几个月能攒出上百篇，一次全发过去够呛的。正文按需走
 * `/api/memories/:key/diary/:file`。
 *
 * 待总结那两份**给全文**（整份 txt 流水，不只是行数）：界面上那三个
 * 「待总结」卡片要能直接改里面的原文。它顶多几十行，和日记不是一个量级。
 */
app.get("/api/memories/:key", (req, res) => {
  const ctx = memoryCtx(req, res);
  if (!ctx) return;
  const { key } = ctx;

  const pendingMemory = readPending("memory", key);
  const pendingMemo = readPending("memo", key);
  const state = readDiaryState(key);
  const slim = (p) => ({
    text: p.text,
    lines: p.lines,
    rounds: p.rounds,
    fails: p.fails,
    lastError: p.lastError,
    lastTry: p.lastTry,
  });

  res.json({
    ok: true,
    key,
    roleId: ctx.role.id,
    roleName: ctx.role.name,
    memories: readMemories(key).map((m) => ({
      // 向量不发给前端：几千个浮点数，界面上一个都用不上
      ...m,
      embedding: undefined,
      embedded: Array.isArray(m.embedding) && m.embedding.length > 0,
    })),
    memo: readMemo(key),
    diaries: listDiaries(key),
    diaryLog: readDiaryLog(key),
    pending: { memory: slim(pendingMemory), memo: slim(pendingMemo) },
    diaryState: {
      lastDiaryAt: state.lastDiaryAt ?? "",
      lastError: state.lastError ?? "",
      lastErrorAt: state.lastErrorAt ?? "",
    },
    stats: statsFor(key),
  });
});

/**
 * 把一条记忆的向量当场算出来。
 *
 * 没配向量模型 / 引用失效 / 接口失败一律返回 null —— 向量在这条链路里是
 * 「锦上添花」：算不出这条照样存进去、照样走「近 N 天」，不该挡保存。
 */
async function embedOneMemory(config, cfg, content) {
  const ref = cfg?.embedModel;
  if (!ref?.provider || !ref?.modelId) return null;
  const endpoint = resolveEndpoint(config, ref);
  if (!endpoint) return null;
  try {
    return await embedText(endpoint, truncate(content, cfg.maxInputChars ?? 4000));
  } catch {
    return null;
  }
}

/**
 * 「2026-09-09」→ `{date, timestamp}`（当天零点，本地时区）。格式不对或是不
 * 存在的日期（2026-02-31 这类）返回 null —— 调用方就当没传这个字段。
 */
function memoryDay(input) {
  const s = String(input ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(y, m - 1, d);
  if (t.getFullYear() !== y || t.getMonth() !== m - 1 || t.getDate() !== d) return null;
  return { date: s, timestamp: t.getTime() };
}

/**
 * 手改一条记忆 / 加一条 / 删一条。
 *
 * 加和改都收三个可选字段：`date`（YYYY-MM-DD，不传就是今天）、
 * `keywords`（数组，和自动抽的合并去重）、`embed`（默认 true）——
 * 落盘**前后**把这条的向量当场算出来，语义检索立刻就能拿到它。
 * 没配向量模型 / 引用失效 / 接口失败都只是跳过（`embedded: false`，
 * 照旧能被「近 N 天」那路拿到，之后可去「导入 / 导出」补算），不挡保存。
 */
app.post("/api/memories/:key/memory", async (req, res) => {
  const ctx = memoryCtx(req, res);
  if (!ctx) return;
  const content = String(req.body?.content ?? "").trim();
  if (!content) return res.status(400).json({ ok: false, error: "记忆正文不能为空" });

  /*
   * 日期不合格式直接 400，不默默改成今天 —— 和日记那条路由（POST
   * /api/memories/:key/diary）同一个规矩：界面上有日期选择器，能走到这里的
   * 非法值只可能是请求拼错了，替用户改成今天反而把补记的日子悄悄弄丢。
   */
  const rawDate = String(req.body?.date ?? "").trim();
  const day = memoryDay(rawDate);
  if (rawDate && !day) {
    return res.status(400).json({ ok: false, error: "日期格式不对，要 YYYY-MM-DD" });
  }
  const manual = Array.isArray(req.body?.keywords)
    ? req.body.keywords.map((k) => String(k).trim()).filter(Boolean)
    : [];
  const cfg = ctx.config.memories?.memory ?? {};

  const embedding =
    req.body?.embed === false ? null : await embedOneMemory(ctx.config, cfg, content);
  const item = appendMemory(ctx.key, {
    content,
    ...(day ?? {}),
    keywords: [...new Set([...extractKeywords(content), ...manual])],
    embedding,
  });
  logInfo(
    "记忆库",
    `${ctx.key} 手动加了一条记忆（${content.length} 字${day ? `，日期 ${day.date}` : ""}` +
      `${embedding ? "，向量已算" : "，没算向量"}）`
  );
  res.json({
    ok: true,
    item: { ...item, embedding: undefined, embedded: Boolean(embedding) },
  });
});

app.put("/api/memories/:key/memory/:id", async (req, res) => {
  const ctx = memoryCtx(req, res);
  if (!ctx) return;
  const content = String(req.body?.content ?? "").trim();
  if (!content) return res.status(400).json({ ok: false, error: "记忆正文不能为空" });

  // 日期不合格式直接 400，同 POST（注释在那边）
  const rawDate = String(req.body?.date ?? "").trim();
  const day = memoryDay(rawDate);
  if (rawDate && !day) {
    return res.status(400).json({ ok: false, error: "日期格式不对，要 YYYY-MM-DD" });
  }
  const manual = Array.isArray(req.body?.keywords)
    ? req.body.keywords.map((k) => String(k).trim()).filter(Boolean)
    : [];
  const cfg = ctx.config.memories?.memory ?? {};

  const item = updateMemory(ctx.key, req.params.id, {
    content,
    ...(day ?? {}),
    keywords: [...new Set([...extractKeywords(content), ...manual])],
    // 正文改了旧向量就对不上，updateMemory 把它置空了 —— 这里当场补上新的
    embedding: null,
  });
  if (!item) return res.status(404).json({ ok: false, error: "没有这条记忆" });

  // 向量是空的才要补（正文改了被置空，或者本来就没有）；只改日期/关键词时
  // 旧向量还是对的，不重算 —— 白打一次接口
  let finalItem = item;
  if (req.body?.embed !== false && !item.embedding) {
    const embedding = await embedOneMemory(ctx.config, cfg, content);
    // updateMemory 的 patch 只带 embedding 时正文没变，向量会被原样收下。
    // 它返回的是重读磁盘后的新对象，响应要用这份才带得上 embedded: true
    if (embedding) finalItem = updateMemory(ctx.key, req.params.id, { embedding }) ?? item;
  }
  logInfo(
    "记忆库",
    `${ctx.key} 改了一条记忆（${content.length} 字${day ? `，日期 ${day.date}` : ""}` +
      `${finalItem.embedding ? "，向量已算" : "，向量待补"}）`
  );
  res.json({
    ok: true,
    item: { ...finalItem, embedding: undefined, embedded: Boolean(finalItem.embedding) },
  });
});

app.delete("/api/memories/:key/memory/:id", (req, res) => {
  const ctx = memoryCtx(req, res);
  if (!ctx) return;
  const ok = removeMemory(ctx.key, req.params.id);
  if (ok) logInfo("记忆库", `${ctx.key} 删了一条记忆`);
  res.json({ ok });
});

/** 备忘录整份覆盖。`writeMemo` 覆盖前会自己留一份 .bak。 */
app.put("/api/memories/:key/memo", (req, res) => {
  const ctx = memoryCtx(req, res);
  if (!ctx) return;
  const text = String(req.body?.text ?? "");
  writeMemo(ctx.key, text);
  logInfo("记忆库", `${ctx.key} 的备忘录被手改了（${text.trim().length} 字）`);
  res.json({ ok: true, memo: readMemo(ctx.key) });
});

/**
 * 手改待总结的那份流水（记忆 / 备忘录各一份）。
 *
 * 界面上那三个「待总结」卡片写回来的就是这里，三份现在是同一种 txt 流水。
 * `writePendingText` 只覆盖正文，失败计数和退避位置都保留 —— 手改原文和
 * 「程序试到第几次了」是两件事。**`.bak` 一律不动**：那一份留给「上次生成
 * 用的那批」。
 */
app.put("/api/memories/:key/pending/:kind", (req, res) => {
  const ctx = memoryCtx(req, res);
  if (!ctx) return;
  const { kind } = req.params;
  if (kind !== "memory" && kind !== "memo") {
    return res.status(400).json({ ok: false, error: "只有 memory / memo 有待总结缓存" });
  }
  if (typeof req.body?.text !== "string") {
    return res.status(400).json({ ok: false, error: "text 得是个字符串" });
  }

  const after = writePendingText(kind, ctx.key, req.body.text);
  logInfo("记忆库", `${ctx.key} 手改了${kind === "memo" ? "备忘录" : "记忆"}的待总结（现在 ${after.lines} 行）`);
  res.json({ ok: true, pending: after, stats: statsFor(ctx.key) });
});

/**
 * 手改日记流水（`diary_log.txt`）整份覆盖。
 *
 * 日记的「待总结」就是这份流水。改它等于改原始聊天记录，所以界面上要写清 ——
 * 但用户明确要求三样都能改待总结，写歪了的那几行确实该能修。
 * 同样**不动 `.bak`**。
 */
app.put("/api/memories/:key/diarylog", (req, res) => {
  const ctx = memoryCtx(req, res);
  if (!ctx) return;
  const text = String(req.body?.text ?? "");
  writeDiaryLog(ctx.key, text);
  logInfo("记忆库", `${ctx.key} 手改了日记流水（${text.trim().length} 字）`);
  res.json({ ok: true, diaryLog: readDiaryLog(ctx.key), stats: statsFor(ctx.key) });
});

/**
 * 手写一篇日记（不打模型）。
 *
 * 界面上「自己写一篇」按的就是这条。和 `generate/diary` 的区别只在正文哪来的 ——
 * 落盘走的是**同一个** `writeDiary`，所以同一天的第二篇照样是 `-2`，也照样
 * 永远不会被程序自动删。
 *
 * **不动日记流水**（`diary_log.txt`）：流水是「攒着等模型总结的原始对话」，
 * 手写一篇日记和那批对话是两回事。清空流水的只有生成成功那一条路
 * （用户钉死的：没成功生成就不许删 `{{char}}_diary_log.txt`）。
 *
 * 也**不推** `lastDiaryAt`：那个时间戳管的是「定时日记距上次多久了」。
 * 手写一篇不该把下一次自动生成往后推 —— 和 memoryhooks 里手点失败不推
 * 时间戳是同一个道理。
 */
app.post("/api/memories/:key/diary", (req, res) => {
  const ctx = memoryCtx(req, res);
  if (!ctx) return;

  const text = String(req.body?.text ?? "").trim();
  if (!text) return res.status(400).json({ ok: false, error: "日记正文不能为空" });

  // 日期不合格式时 writeDiary 会自己退到今天，但那是**默默改了用户填的东西**：
  // 界面上有日期选择器，能走到这儿的非法值只可能是请求拼错了，直接说清楚
  const date = String(req.body?.date ?? "").trim() || localDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ ok: false, error: "日期得是 YYYY-MM-DD" });
  }

  const file = writeDiary(ctx.key, date, text);
  if (!file) return res.status(400).json({ ok: false, error: "这个角色的记忆库路径不合法" });

  logInfo("记忆库", `${ctx.key} 手写了一篇日记 ${file}（${text.length} 字）`);
  res.json({ ok: true, file, date, stats: statsFor(ctx.key) });
});

/** 一篇成品日记的正文。文件名在 `readDiary` 里过 DIARY_FILE 正则。 */
app.get("/api/memories/:key/diary/:file", (req, res) => {
  const ctx = memoryCtx(req, res);
  if (!ctx) return;
  const text = readDiary(ctx.key, req.params.file);
  if (!text) return res.status(404).json({ ok: false, error: "没有这篇日记" });
  res.json({ ok: true, file: req.params.file, text });
});

/**
 * 手改一篇成品日记。
 *
 * 只能改**已经存在**的那几篇（`writeDiaryFile` 自己挡了不存在的文件名）——
 * 从这条路凭空造一篇会绕开 `writeDiary` 的 `-2` 编号。
 */
app.put("/api/memories/:key/diary/:file", (req, res) => {
  const ctx = memoryCtx(req, res);
  if (!ctx) return;
  const text = String(req.body?.text ?? "");
  if (!writeDiaryFile(ctx.key, req.params.file, text)) {
    return res.status(404).json({ ok: false, error: "没有这篇日记（只能改已经写成的那几篇）" });
  }
  logInfo("记忆库", `${ctx.key} 手改了日记 ${req.params.file}（${text.length} 字）`);
  res.json({ ok: true, file: req.params.file, text });
});

/**
 * 删一篇成品日记。
 *
 * **只有用户在界面上点删除才会走到这** —— 程序自己永远不删日记
 * （用户钉死的：「生成后的日记默认永远都不会清空」）。
 */
app.delete("/api/memories/:key/diary/:file", (req, res) => {
  const ctx = memoryCtx(req, res);
  if (!ctx) return;
  const ok = removeDiary(ctx.key, req.params.file);
  if (ok) logInfo("记忆库", `${ctx.key} 的日记 ${req.params.file} 被用户删了`);
  res.json({ ok });
});

/**
 * 手动生成：`/api/memories/:key/generate/memory|memo|diary`。
 *
 * 和聊天里那两条指令走的是**同一个函数**（memoryhooks 的 manual*），
 * 所以界面上点和发 `/日记` 的行为一模一样 —— 包括「失败绝不删记录」。
 *
 * 会打一次模型，几十秒，所以前端要给它一个长超时。失败**不返 500**：
 * 那是业务上的失败（模型没配、写太短、上游报错），原因要原样显示给用户，
 * 用 200 + `ok: false` 表达，和 /api/tts/test 那种「4xx = 配置不对」区分开。
 */
app.post("/api/memories/:key/generate/:kind", async (req, res) => {
  const ctx = memoryCtx(req, res);
  if (!ctx) return;
  const { kind } = req.params;
  const runners = { memory: manualMemory, memo: manualMemo, diary: manualDiary };
  const run = runners[kind];
  if (!run) return res.status(400).json({ ok: false, error: "只能生成 memory / memo / diary" });

  try {
    const out = await run(ctx.config, ctx.role);
    if (out.log) logInfo("记忆库", out.log);
    res.json({ ...out, ok: Boolean(out.ok), stats: statsFor(ctx.key) });
  } catch (e) {
    // manual* 自己吞了业务错误，走到这儿是真的出了意外
    const error = String(e?.message ?? e);
    logError("记忆库", `手动生成 ${kind} 出意外（待总结的内容都还在）`, e);
    res.status(500).json({ ok: false, error });
  }
});

/* ---- 记忆库的搬家：整包导出 / 整包导入 / 纯文本导入 / 补算向量 ---- */

/**
 * 把一个角色的整个记忆库导成一个文件。
 *
 * `?vectors=1` 才带算好的向量。默认不带的理由见 transfer.js：几百条向量
 * 十几兆，而换机器之后点一下「补算向量」就能重算。
 */
app.get("/api/memories/:key/export", (req, res) => {
  const ctx = memoryCtx(req, res);
  if (!ctx) return;
  const vectors = req.query.vectors === "1";
  const bundle = exportMemoryBank(ctx.key, ctx.role.name, { vectors });
  const name = transferFileName(KIND.memory, ctx.role.name);

  logInfo(
    "记忆库",
    `导出了「${ctx.role.name}」的记忆库 ${name}：${bundle.memories.length} 条记忆、` +
      `${bundle.diaries.length} 篇日记${vectors ? "（带向量）" : "（不带向量）"}`
  );

  attach(res, name);
  // 带向量时不缩进：1536 个数字缩进一下就是 1536 行
  res.send(vectors ? JSON.stringify(bundle) : JSON.stringify(bundle, null, 2));
});

/**
 * 导入整包记忆库：包里有的那几块整体替换，没有的不动。
 *
 * 覆盖之前每一份都先备份（`.bak.json` / `.bak.txt`），导错了能换回来 ——
 * 用户钉死过「每个待总结的文件，都必须在生成之前备份一次」。
 * 成品日记只写进包里有的，本地多出来的一篇都不删。
 *
 * body 上限单独放宽到 64mb（见文件上头 app.use 那行）。
 */
app.post("/api/memories/:key/import", (req, res) => {
  const ctx = memoryCtx(req, res);
  if (!ctx) return;
  const bundle = req.body?.bundle ?? req.body;
  try {
    const out = importMemoryBank(ctx.key, bundle);
    const a = out.applied;
    logInfo(
      "记忆库",
      `「${ctx.role.name}」导入了一份记忆库：${a.memories} 条记忆、${a.diaries} 篇日记` +
        `${a.memo ? "、备忘录" : ""}${a.diaryLog ? "、日记流水" : ""}` +
        `${a.pending.length ? `、待总结（${a.pending.join("/")}）` : ""}（旧的都备份了）`
    );
    res.json({ ok: true, ...out, stats: statsFor(ctx.key), vectors: vectorGap(ctx.key) });
  } catch (e) {
    const error = String(e?.message ?? e);
    logWarn("记忆库", "导入记忆库失败", error);
    res.status(400).json({ ok: false, error });
  }
});

/**
 * 导入一份纯文本记忆（一行一条 `YYYY-MM-DD | 正文`）。
 *
 * 和 `scripts/import-memories.mjs` 走的是同一份实现，所以命令行导和界面上导
 * 结果一模一样：按正文去重（可以反复导）、按日期发时间戳归档、
 * **`embedding` 一律留 null** —— 向量要用户自己点「补算向量」。
 * 用户要的就是这个：「需要向量要自己手动触发一次向量」。
 *
 * 这是**追加**，不是替换：已有的条目一条都不动。
 */
app.post("/api/memories/:key/import-text", (req, res) => {
  const ctx = memoryCtx(req, res);
  if (!ctx) return;
  const text = String(req.body?.text ?? "");
  if (!text.trim()) {
    return res.status(400).json({ ok: false, error: "文件是空的，没东西可导。" });
  }

  const out = importMemoryText(ctx.key, text);
  if (!out.parsed) {
    return res.status(400).json({
      ok: false,
      error: "一条都没解析出来。每行要长这样：2026-09-09 | 今天她来家里吃了饭",
      ...out,
    });
  }

  logInfo(
    "记忆库",
    `「${ctx.role.name}」导入了 ${out.added} 条记忆（${out.from} … ${out.to}）` +
      `${out.duplicates ? `，跳过 ${out.duplicates} 条重复的` : ""}` +
      `${out.skipped.length ? `，${out.skipped.length} 行格式不对没导` : ""}` +
      "，向量还没算"
  );

  res.json({ ok: true, ...out, stats: statsFor(ctx.key), vectors: vectorGap(ctx.key) });
});

/** 还差多少条没向量。界面上那个按钮要不要出现、进度走到哪儿都看它。 */
app.get("/api/memories/:key/vectors", (req, res) => {
  const ctx = memoryCtx(req, res);
  if (!ctx) return;
  res.json({ ok: true, ...vectorGap(ctx.key) });
});

/**
 * 手动补算向量：把 `embedding` 还是 null 的那些算上。
 *
 * **一次只算一批**（默认 40 条）。一条一次网络请求，几百条要几分钟，
 * 一个 HTTP 请求扛不住 —— 剩下多少在 `left` 里，前端看见 `left > 0`
 * 就再叫一次，进度条就是这么走的。
 *
 * 和 /api/embedding/test 一样，**密钥只从存盘的配置里读**，不收请求体里的。
 */
app.post("/api/memories/:key/embed", async (req, res) => {
  const ctx = memoryCtx(req, res);
  if (!ctx) return;

  const cfg = ctx.config.memories?.memory ?? {};
  const ref = cfg.embedModel;
  if (!ref?.provider || !ref?.modelId) {
    return res.status(400).json({
      ok: false,
      error: "还没选向量模型。去「记忆库 → 设置 → 记忆」里选一个（选完记得先保存）。",
    });
  }
  const endpoint = resolveEndpoint(ctx.config, ref);
  if (!endpoint) {
    return res.status(400).json({
      ok: false,
      error: "选的向量模型引用失效了（服务商或模型被删/被关）。",
    });
  }

  const asked = Number(req.body?.limit);
  const limit = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 200) : 40;

  try {
    const out = await embedMissing(ctx.key, endpoint, {
      maxInputChars: cfg.maxInputChars ?? 4000,
      limit,
    });
    if (!out.total) return res.json({ ok: true, ...out, label: endpoint.label });

    if (out.done) {
      logInfo(
        "记忆库",
        `「${ctx.role.name}」补算向量：这批成功 ${out.done} 条` +
          `${out.failed ? `，失败 ${out.failed} 条` : ""}` +
          `${out.left ? `，还剩 ${out.left} 条` : "，全齐了"}`
      );
    }
    if (out.stopped) {
      logWarn("记忆库", `「${ctx.role.name}」补算向量连着 5 条都失败，先停手（算好的都留着）`);
    }
    // 失败也用 200 + ok:true + errors：算成了一部分不能当整件事失败，
    // 已经落盘的那些不该被前端当成没发生
    res.json({ ok: true, ...out, label: endpoint.label });
  } catch (e) {
    const error = String(e?.message ?? e);
    logError("记忆库", "补算向量出意外", e);
    res.status(500).json({ ok: false, error });
  }
});

/**
 * 试一下向量模型通不通。
 *
 * **密钥只从存盘的配置里读**，不收请求体里的 —— 和 /api/tts/test、
 * /api/env/preview 一个理由：不让密钥出现在请求日志里。代价是新填的凭据
 * 要先点保存才能测，界面上写了。
 *
 * 回的是维度和前几个数：维度对不对是唯一有意义的判断（1536 还是 1024
 * 决定了以后换模型要不要重算全部记忆），前几个数只是让人眼确认不是全零。
 */
app.post("/api/embedding/test", async (req, res) => {
  const config = loadConfig();
  const ref = config.memories?.memory?.embedModel;
  if (!ref?.provider || !ref?.modelId) {
    return res.status(400).json({
      ok: false,
      error: "还没选向量模型。去「记忆库 → 设置 → 记忆」里选一个（选完记得先保存）。",
    });
  }
  const endpoint = resolveEndpoint(config, ref);
  if (!endpoint) {
    return res.status(400).json({
      ok: false,
      error: "选的向量模型引用失效了（服务商或模型被删/被关）。",
    });
  }

  const text = String(req.body?.text ?? "").trim() || "今天我们约好周末去湖边的营地露营。";
  try {
    const started = Date.now();
    const vector = await embedText(endpoint, text);
    logInfo("记忆库", `测试向量成功（${endpoint.label}，${vector.length} 维）`);
    res.json({
      ok: true,
      label: endpoint.label,
      ms: Date.now() - started,
      dims: vector.length,
      head: vector.slice(0, 5),
    });
  } catch (e) {
    const error = String(e?.message ?? e);
    logWarn("记忆库", "测试向量失败", error);
    res.status(400).json({ ok: false, error, label: endpoint.label });
  }
});

// ---- 线下模式（网页上的「线下模式」分区）----

/**
 * 这一段的 `:roleKey` 和记忆库那边是**同一个 key**（`memoryKeyFor` 算出来的），
 * 所以照抄那条规矩：一律走 `roleByKey` 反查白名单。key 是角色名派生的，
 * 而角色名是用户随便填的，`../` 那一类必须挡在进文件路径之前。
 *
 * 这些路由**一个都不碰 `config`** —— `PUT /api/config` 会顺带重启所有 iMessage
 * 桥接（见那条路由），而剧情是每说一句话就要落盘的东西。所以线下存档单独一套
 * 文件（`data/offline/`），改剧情不会把正在聊天的号码踢下线。
 */
function offlineCtx(req, res) {
  const config = loadConfig();
  const role = roleByKey(config, req.params.roleKey);
  if (!role) {
    res.status(404).json({ ok: false, error: "没有这个角色（可能已删除或改过名）" });
    return null;
  }
  return { config, role, roleKey: memoryKeyFor(role) };
}

/**
 * 一条剧情的 id 得**真属于这个角色**才认。
 *
 * storyId 是请求体里来的，而剧情文件是按 id 平铺在一个目录里的 —— 不查一遍
 * 归属的话，A 角色的请求能读到 B 角色的剧情。白名单在索引里：只认这个角色
 * 索引里列着的那些。
 */
function ownsStory(roleKey, storyId) {
  return readIndex(roleKey).stories.some((s) => s.id === storyId);
}

/** 请求体里的 storyId，缺省用当前那条。不属于这个角色就返回空串。 */
function storyIdFrom(req, roleKey) {
  const asked = String(req.body?.storyId ?? req.query?.storyId ?? "").trim();
  if (asked) return ownsStory(roleKey, asked) ? asked : "";
  return readIndex(roleKey).currentId;
}

/** 一个角色的完整线下状态。改完剧情统一回这一份，前端不用自己拼。 */
function offlineState(config, role, roleKey) {
  const idx = readIndex(roleKey, role.id);
  const raw = idx.currentId ? readStory(idx.currentId) : null;
  const view = raw ? storyForView(config, role, raw) : null;
  return {
    roleId: role.id,
    roleName: role.name,
    roleKey,
    open: idx.open,
    currentId: idx.currentId,
    stories: idx.stories,
    story: view?.story ?? null,
    // 现在要不要显示那四条选项：角色开关和预设条目两道闸的结果（offline.js 算）
    choices: view?.choices ?? false,
    presetName: view?.presetName ?? "",
    // 超出线下上下文上限、已经被总结顶掉的开头那几轮（offline.js:offlineCut 算）
    folded: view?.folded ?? { count: 0, text: "" },
    avatar: role.offline?.avatar ?? "",
    userAvatar: role.offline?.userAvatar ?? "",
    userName: resolveUser(config, role)?.name ?? "",
    // 朗读「」台词用的音色，直接借线上语音那套，不另存一份
    voiceId: role.voiceSend?.voiceId ?? "",
    autoVoice: Boolean(role.offline?.autoVoice),
  };
}

/**
 * 全部角色一行，侧栏那列用。
 *
 * 只读索引不读正文（`listOffline` 就是干这个的）—— 演久了的剧情几十万字，
 * 画一次侧栏没必要把它们全读进内存。没建过剧情的角色也要出现在列表里，
 * 不然用户找不到地方开第一条。
 */
app.get("/api/offline", (_req, res) => {
  const config = loadConfig();
  const byKey = new Map(listOffline().map((row) => [row.roleKey, row]));
  const roles = (config.roles ?? []).map((role) => {
    const roleKey = memoryKeyFor(role);
    const row = byKey.get(roleKey);
    const stub = row?.stories?.find((s) => s.id === row.currentId) ?? null;
    return {
      roleId: role.id,
      roleName: role.name,
      roleKey,
      // 角色设置里那个总开关。关着的时候侧栏标一句灰字，省得用户对着
      // 一个开不起来的按钮猜为什么
      gate: Boolean(role.offline?.enabled),
      open: Boolean(row?.open),
      storyName: stub?.name ?? "",
      turnCount: stub?.turnCount ?? 0,
      storyCount: row?.stories?.length ?? 0,
    };
  });
  res.json({ roles });
});

/** 一个角色的剧情列表 + 当前那条的全文（含总结）。 */
app.get("/api/offline/:roleKey", (req, res) => {
  const ctx = offlineCtx(req, res);
  if (!ctx) return;
  res.json({ ok: true, ...offlineState(ctx.config, ctx.role, ctx.roleKey) });
});

/** 换一条剧情看/接着演。 */
app.get("/api/offline/:roleKey/story/:storyId", (req, res) => {
  const ctx = offlineCtx(req, res);
  if (!ctx) return;
  const { storyId } = req.params;
  if (!ownsStory(ctx.roleKey, storyId)) {
    return res.status(404).json({ ok: false, error: "这个角色下没有这条剧情" });
  }
  setCurrent(ctx.roleKey, storyId);
  res.json({ ok: true, ...offlineState(ctx.config, ctx.role, ctx.roleKey) });
});

/**
 * 开线下。
 *
 * 角色设置里那个总开关关着就拒绝 —— 和 iMessage 那条 `/开启线下` 同一个判断
 * （`commands.js:cmdOfflineOn`），两边说的话都指向同一个开关。
 *
 * 没有在演的剧情时 `openOffline` 会顺手起一条，所以网页上点一下就能开始演。
 */
app.post("/api/offline/:roleKey/open", (req, res) => {
  const ctx = offlineCtx(req, res);
  if (!ctx) return;
  if (ctx.role.offline?.enabled === false) {
    return res.status(400).json({
      ok: false,
      error: "这个角色的线下模式是关着的。去「角色 → 线下模式」里打开。",
    });
  }
  openOffline(ctx.roleKey, {
    roleId: ctx.role.id,
    presetRef: ctx.role.offline?.presetRef ?? "",
    name: String(req.body?.name ?? ""),
  });
  logInfo("线下模式", `「${ctx.role.name}」开启线下模式（网页）`);
  res.json({ ok: true, ...offlineState(ctx.config, ctx.role, ctx.roleKey) });
});

/**
 * 结束当前线下模式。用户点名的那一步：补一次大总结 → 注入待总结 → 回归线上。
 *
 * `inject: false` = 只结束不写记忆库（用户演废了一段、不想让角色记住）。
 *
 * 总结生成失败**照样结束**并且回 200：`endOffline` 里把 error 一起带出来，
 * 前端显示一句「已结束，但那份大总结没生成出来」。卡在这儿不放人是最糟的
 * 结果 —— 用户会被困在线下模式里，线上功能一直停着。
 */
app.post("/api/offline/:roleKey/close", async (req, res) => {
  const ctx = offlineCtx(req, res);
  if (!ctx) return;
  const inject = req.body?.inject !== false;
  try {
    const out = await endOffline(ctx.config, ctx.role, { inject });
    res.json({
      ok: true,
      injected: out.injected,
      summary: out.summary,
      error: out.error,
      ...offlineState(ctx.config, ctx.role, ctx.roleKey),
    });
  } catch (e) {
    // 走到这儿是真出了意外（endOffline 自己吞业务错误）。硬关一次，
    // 别把人留在线下模式里
    const error = String(e?.message ?? e);
    logError("线下模式", `「${ctx.role.name}」结束线下出意外，已强制关掉`, e);
    closeOffline(ctx.roleKey);
    res.status(500).json({ ok: false, error, ...offlineState(ctx.config, ctx.role, ctx.roleKey) });
  }
});

/** 开启新剧情（当前那条留着，随时切回去看）。 */
app.post("/api/offline/:roleKey/story", (req, res) => {
  const ctx = offlineCtx(req, res);
  if (!ctx) return;
  const story = newStory(ctx.roleKey, {
    roleId: ctx.role.id,
    presetRef: ctx.role.offline?.presetRef ?? "",
    name: String(req.body?.name ?? ""),
  });
  if (!story) return res.status(500).json({ ok: false, error: "新剧情建不出来（文件写失败）" });
  logInfo("线下模式", `「${ctx.role.name}」新起一条剧情「${story.name}」`);
  res.json({ ok: true, ...offlineState(ctx.config, ctx.role, ctx.roleKey) });
});

/** 改剧情名。 */
app.patch("/api/offline/:roleKey/story/:storyId", (req, res) => {
  const ctx = offlineCtx(req, res);
  if (!ctx) return;
  const { storyId } = req.params;
  if (!ownsStory(ctx.roleKey, storyId)) {
    return res.status(404).json({ ok: false, error: "这个角色下没有这条剧情" });
  }
  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ ok: false, error: "剧情名不能是空的" });
  renameStory(ctx.roleKey, storyId, name);
  res.json({ ok: true, ...offlineState(ctx.config, ctx.role, ctx.roleKey) });
});

/** 删一条剧情。正文和索引里那条一起删，删不回来。 */
app.delete("/api/offline/:roleKey/story/:storyId", (req, res) => {
  const ctx = offlineCtx(req, res);
  if (!ctx) return;
  const { storyId } = req.params;
  if (!ownsStory(ctx.roleKey, storyId)) {
    return res.status(404).json({ ok: false, error: "这个角色下没有这条剧情" });
  }
  if (!removeOfflineStory(ctx.roleKey, storyId)) {
    return res.status(500).json({ ok: false, error: "剧情删不掉（文件删失败）" });
  }
  logWarn("线下模式", `「${ctx.role.name}」删掉了一条剧情（${storyId}）`);
  res.json({ ok: true, ...offlineState(ctx.config, ctx.role, ctx.roleKey) });
});

/**
 * 正在生成的那些轮，key = roleKey。
 *
 * 一个角色同一时刻只该有一轮在跑（界面上 busy 的时候发送键是禁着的），所以
 * 一个 key 存一个 controller 就够用。`/abort` 按 roleKey 把它找出来、掐掉
 * 上游那个 fetch。真要是手机和网页同时发，后来那轮会顶掉前一个 —— 按停停的
 * 是最新那轮，那也正是按的人想停的那一轮。
 */
const offlineAborts = new Map();

/** 起一轮：登记 controller，回一个 signal 和「跑完撤掉」的收尾函数。 */
function trackOfflineRun(roleKey) {
  const ctrl = new AbortController();
  offlineAborts.set(roleKey, ctrl);
  return {
    signal: ctrl.signal,
    // 按引用比对：这轮跑完的时候 map 里可能已经换成别人刚放进去的那个了
    done: () => {
      if (offlineAborts.get(roleKey) === ctrl) offlineAborts.delete(roleKey);
    },
  };
}

/**
 * 这一轮要不要**按 SSE 回**。
 *
 * 两个条件都得满足：
 *
 *  1. 客户端自己要（请求体里 `stream: true`）。手机端那一路和老版本的前端
 *     不带这个字段，走的还是原来那条 JSON 路，一个字节都不受影响。
 *  2. 全局开关不是「非流式」（`config.stream.mode`）。`auto` 和 `on` 都按流式
 *     发出去 —— 两者的区别在 llm.js 里（上游没回 SSE 时 auto 当整段收下），
 *     这一层不用分。
 */
function wantsOfflineStream(config, req) {
  return req.body?.stream === true && (config?.stream?.mode ?? "auto") !== "off";
}

/**
 * 把一轮线下生成包成 SSE。
 *
 * 头照抄 `/api/logs/stream`（那条已经在 Nginx 反代后面跑了一年，
 * `X-Accel-Buffering: no` 那行是必需的，不然增量会被攒着一次吐出来）。
 *
 * 四种事件：
 *   `delta`   `{text}`        又来一小块正文
 *   `reset`   `{}`            换线了，把已经显示的清掉重来
 *   `done`    正常那份 JSON    和非流式那条路**完全一样**的响应体
 *   `error`   `{ok:false,…}`  同上，失败那份
 *
 * `done` / `error` 的负载和 JSON 那条路一模一样，是为了让前端两条路只有
 * 「怎么收」的区别，没有「收到什么」的区别 —— 收完都是同一个 handler。
 */
function offlineSse(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  const send = (event, payload) => {
    // 客户端半路关掉标签页时 res 已经不可写了，写进去会抛
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  return {
    onDelta: (text) => send("delta", { text }),
    onRestart: () => send("reset", {}),
    finish: (event, payload) => {
      send(event, payload);
      res.end();
    },
  };
}

/**
 * 演一轮 / 重 roll。两条路只差三个参数，正文完全一样，所以合成一个。
 *
 * 打模型，几十秒，前端要长超时。业务上的失败（没配模型、没在演的剧情、
 * 模型返回空）用 **200 + `ok: false`** 表达并把原话带回去 —— 照
 * `/api/memories/:key/generate/:kind` 的分法，4xx 留给「请求本身不对」。
 * 失败时也回一份 state：用户那句已经落盘了，界面得立刻显示出来，
 * 这样点一下「重 roll」就能重来，不用重打一遍。
 *
 * 用户按「停下」走的是 `/abort`，中止落在这儿的 catch 里 —— 和别的失败一个
 * 形状（`ok:false` + 一句「被你按停了」+ 一份 state）。流式那条路也一样，
 * 只是从 `error` 事件里出去。
 *
 * @param {boolean} reroll 重 roll 那一路
 */
function offlineTurnRoute(reroll) {
  return async (req, res) => {
    const ctx = offlineCtx(req, res);
    if (!ctx) return;
    const storyId = storyIdFrom(req, ctx.roleKey);
    if (!storyId) return res.status(400).json({ ok: false, error: "现在没有在演的剧情" });

    // SSE 的头一旦写出去就只能用事件报错了，所以这个判断要在最前面
    const sse = wantsOfflineStream(ctx.config, req) ? offlineSse(res) : null;
    const run = trackOfflineRun(ctx.roleKey);
    try {
      const out = await runOfflineTurn(ctx.config, ctx.role, resolveUser(ctx.config, ctx.role), {
        ...(reroll
          ? { reroll: true }
          : {
              text: String(req.body?.text ?? ""),
              choiceIndex: Number(req.body?.choiceIndex) || 0,
            }),
        storyId,
        signal: run.signal,
        onDelta: sse?.onDelta,
        onRestart: sse?.onRestart,
      });
      const payload = {
        ok: true,
        usedFallback: out.usedFallback,
        // 重 roll 那一路本来就不回 summary（它不产生新的待总结）
        ...(reroll ? {} : { summary: out.summary }),
        ...offlineState(ctx.config, ctx.role, ctx.roleKey),
      };
      if (sse) sse.finish("done", payload);
      else res.json(payload);
    } catch (e) {
      const error = String(e?.message ?? e);
      // 按停是用户自己的操作，offline.js 那边已经记过一行了，这里不再报警
      if (!e?.aborted) {
        logWarn("线下模式", `「${ctx.role.name}」${reroll ? "重 roll" : "这轮"}没成：${error}`);
      }
      const payload = { ok: false, error, ...offlineState(ctx.config, ctx.role, ctx.roleKey) };
      if (sse) sse.finish("error", payload);
      else res.json(payload);
    } finally {
      run.done();
    }
  };
}

app.post("/api/offline/:roleKey/turn", offlineTurnRoute(false));
app.post("/api/offline/:roleKey/reroll", offlineTurnRoute(true));

/**
 * 按停正在跑的这一轮。
 *
 * 真中止：掐的是上游那个 fetch，不是前端假装放弃等它自己跑完。中止之后
 * `/turn` 那边会回一句「被你按停了」，而**用户那句早就落盘了**，所以点一下
 * 「再来一次」就是按同一份上文重来。
 *
 * 没有在跑的时候回 200 + `ok:false` —— 用户手快点两下不该看见一个 500。
 */
app.post("/api/offline/:roleKey/abort", (req, res) => {
  const ctx = offlineCtx(req, res);
  if (!ctx) return;

  const ctrl = offlineAborts.get(ctx.roleKey);
  if (!ctrl) {
    return res.json({
      ok: false,
      error: "这个角色现在没有在生成",
      ...offlineState(ctx.config, ctx.role, ctx.roleKey),
    });
  }
  ctrl.abort();
  logInfo("线下模式", `「${ctx.role.name}」这轮被按停了`);
  res.json({ ok: true, ...offlineState(ctx.config, ctx.role, ctx.roleKey) });
});

/** 编辑正文 / 切「隐藏回复」。隐藏的那些不进下一轮的上下文。 */
app.patch("/api/offline/:roleKey/turn/:turnId", (req, res) => {
  const ctx = offlineCtx(req, res);
  if (!ctx) return;
  const storyId = storyIdFrom(req, ctx.roleKey);
  if (!storyId) return res.status(404).json({ ok: false, error: "找不到这条剧情" });

  const patch = {};
  if (req.body?.content !== undefined) {
    const content = String(req.body.content);
    // 空正文不给存 —— 存档里一条空轮次在界面上是个点不动的空气泡，
    // 用户想删就该走垃圾桶
    if (!content.trim()) {
      return res.status(400).json({ ok: false, error: "正文不能改成空的（要删就用删除）" });
    }
    patch.content = content;
  }
  if (req.body?.hidden !== undefined) patch.hidden = Boolean(req.body.hidden);
  if (!Object.keys(patch).length) {
    return res.status(400).json({ ok: false, error: "没有要改的内容" });
  }

  if (!updateTurn(ctx.roleKey, storyId, req.params.turnId, patch)) {
    return res.status(404).json({ ok: false, error: "找不到这一轮" });
  }
  res.json({ ok: true, ...offlineState(ctx.config, ctx.role, ctx.roleKey) });
});

app.delete("/api/offline/:roleKey/turn/:turnId", (req, res) => {
  const ctx = offlineCtx(req, res);
  if (!ctx) return;
  const storyId = storyIdFrom(req, ctx.roleKey);
  if (!storyId) return res.status(404).json({ ok: false, error: "找不到这条剧情" });
  if (!removeTurn(ctx.roleKey, storyId, req.params.turnId)) {
    return res.status(404).json({ ok: false, error: "找不到这一轮" });
  }
  res.json({ ok: true, ...offlineState(ctx.config, ctx.role, ctx.roleKey) });
});

/**
 * 手动出一份总结（网页上那两个按钮，和 iMessage 的 `/小总结` `/大总结` 同一条路）。
 *
 * 不看轮数、不看大总结那个开关 —— 用户自己点的就是他自己的判断。
 * 没有可总结的材料时回 `ok: false` 说一句，不当报错。
 */
app.post("/api/offline/:roleKey/summary", async (req, res) => {
  const ctx = offlineCtx(req, res);
  if (!ctx) return;
  const storyId = storyIdFrom(req, ctx.roleKey);
  if (!storyId) return res.status(400).json({ ok: false, error: "现在没有在演的剧情" });
  const kind = req.body?.kind === "big" ? "big" : "small";

  try {
    const made = await summarizeNow(ctx.config, ctx.role, storyId, kind);
    res.json({
      ok: Boolean(made),
      error: made ? "" : `还没有可以做${kind === "big" ? "大" : "小"}总结的内容`,
      summary: made,
      ...offlineState(ctx.config, ctx.role, ctx.roleKey),
    });
  } catch (e) {
    const error = String(e?.message ?? e);
    logWarn("线下模式", `「${ctx.role.name}」手动${kind === "big" ? "大" : "小"}总结没成：${error}`);
    res.json({ ok: false, error, ...offlineState(ctx.config, ctx.role, ctx.roleKey) });
  }
});

/** 自由编辑总结正文。`kind`/`from`/`to` 不给改（那是「概括了哪一段」的事实）。 */
app.patch("/api/offline/:roleKey/summary/:sid", (req, res) => {
  const ctx = offlineCtx(req, res);
  if (!ctx) return;
  const storyId = storyIdFrom(req, ctx.roleKey);
  if (!storyId) return res.status(404).json({ ok: false, error: "找不到这条剧情" });
  const text = String(req.body?.text ?? "");
  if (!text.trim()) {
    return res.status(400).json({ ok: false, error: "总结不能改成空的（要删就用删除）" });
  }
  if (!updateSummary(storyId, req.params.sid, text)) {
    return res.status(404).json({ ok: false, error: "找不到这份总结" });
  }
  res.json({ ok: true, ...offlineState(ctx.config, ctx.role, ctx.roleKey) });
});

app.delete("/api/offline/:roleKey/summary/:sid", (req, res) => {
  const ctx = offlineCtx(req, res);
  if (!ctx) return;
  const storyId = storyIdFrom(req, ctx.roleKey);
  if (!storyId) return res.status(404).json({ ok: false, error: "找不到这条剧情" });
  if (!removeSummary(storyId, req.params.sid)) {
    return res.status(404).json({ ok: false, error: "找不到这份总结" });
  }
  res.json({ ok: true, ...offlineState(ctx.config, ctx.role, ctx.roleKey) });
});

/**
 * 手写一份总结（不打模型）。
 *
 * 用户点名「总结的内容可以在线下模式内看，可以自由编辑」—— 那就该包括
 * 「模型总结得不好，我自己补一段」。`from`/`to` 按当前轮数填满，
 * 界面上显示成「第 1-N 轮」。
 */
app.post("/api/offline/:roleKey/summary/manual", (req, res) => {
  const ctx = offlineCtx(req, res);
  if (!ctx) return;
  const storyId = storyIdFrom(req, ctx.roleKey);
  if (!storyId) return res.status(400).json({ ok: false, error: "现在没有在演的剧情" });
  const text = String(req.body?.text ?? "");
  if (!text.trim()) return res.status(400).json({ ok: false, error: "总结不能是空的" });
  const story = readStory(storyId);
  const saved = appendOfflineSummary(storyId, {
    kind: req.body?.kind === "big" ? "big" : "small",
    text,
    from: 0,
    to: story?.turns?.length ?? 0,
  });
  if (!saved) return res.status(500).json({ ok: false, error: "总结存不下来（文件写失败）" });
  res.json({ ok: true, summary: saved, ...offlineState(ctx.config, ctx.role, ctx.roleKey) });
});

/**
 * 念一句「」里的台词。
 *
 * 音色和服务都是借来的：`role.voiceSend.voiceId` 是线上发语音那套音色，
 * `config.ttsApi` 是全局三家 TTS —— 线下不另存一份配置，改一处两边都变。
 * 注意**不看 `voiceSend.enabled`**：那个开关管的是线上要不要把回复转成语音条，
 * 线下这边是用户手点播放键，跟它没关系。
 *
 * **密钥只从已保存的配置读**，不收请求体里的（和 /api/tts/test 一个理由）。
 * 请求体里只有要念的那句话。
 *
 * 音频 base64 回去，前端 `new Audio("data:…")` 直接放。业务失败一律 200 +
 * `{ok:false}`：一句念不出来不该让前端当成整条请求崩了，气泡旁边标个感叹号就行。
 */
app.post("/api/offline/:roleKey/voice", async (req, res) => {
  const ctx = offlineCtx(req, res);
  if (!ctx) return;
  const text = String(req.body?.text ?? "").trim();
  if (!text) return res.json({ ok: false, error: "没有要念的文字" });
  if (text.length > MAX_TTS_CHARS) {
    return res.json({
      ok: false,
      error: `这句太长了（${text.length} 字，上限 ${MAX_TTS_CHARS} 字）`,
    });
  }

  const voiceId = ctx.role.voiceSend?.voiceId ?? "";
  try {
    const out = await synthesizeVoice(ctx.config.ttsApi, voiceId, text, "线下语音");
    res.json({
      ok: true,
      source: out.source,
      ms: out.ms,
      mimeType: out.mimeType,
      duration: out.duration,
      base64: out.buffer.toString("base64"),
    });
  } catch (e) {
    const error = String(e?.message ?? e);
    logWarn("线下语音", "合成失败", error);
    res.json({ ok: false, error });
  }
});

/**
 * 上传头像（角色的 / 用户的）。走 base64 JSON，和 `/api/ig/media`、壁纸那条一样。
 *
 * 只返回文件名 —— 存到哪个字段（`role.offline.avatar` 还是 `userAvatar`）由
 * 前端连着角色一起 `PUT /api/config` 存。图片本身在 `data/offline/media/`，
 * **不进可分享的备份包**（backup.js 只带配置），换机器后头像退回首字母占位。
 */
app.post("/api/offline/media", (req, res) => {
  const { base64, mimeType } = req.body ?? {};
  if (!base64 || typeof base64 !== "string") {
    return res.status(400).json({ ok: false, error: "没收到图片内容" });
  }
  const file = saveOfflineMedia(base64, extForMime(mimeType).replace(/^\./, ""));
  if (!file) return res.json({ ok: false, error: "图片没能存下来" });
  res.json({ ok: true, file });
});

/**
 * 读一张头像。安全边界在 `offlineMediaPathFor` 里：文件名白名单卡死
 * （只允许 `[A-Za-z0-9_.-]`），挡住路径穿越和「让它读 data.config.json」。
 */
app.get("/api/offline/media/:file", (req, res) => {
  const file = offlineMediaPathFor(req.params.file);
  if (!file || !fs.existsSync(file)) {
    return res.status(404).json({ ok: false, error: "找不到这张图" });
  }
  res.setHeader("Content-Type", mimeForExt(path.extname(file)));
  res.setHeader("Cache-Control", "no-cache");
  fs.createReadStream(file).pipe(res);
});

// ---- Uranus 助手（右下角那个气泡）----

/**
 * 开场白 + 引导问题 + 群号，以及「现在有没有模型能用」。
 *
 * 前端一打开气泡就问这一条：ready 是 false 的话它直接显示「先去连接里配一个
 * 模型」，不给输入框 —— 比让用户打完一段话再收到报错友好。
 */
app.get("/api/assistant/hello", (_req, res) => {
  const config = loadConfig();
  const endpoint = resolveAssistantEndpoint(config, resolveEndpoint);
  res.json({
    ...assistantGreeting(),
    ready: Boolean(endpoint),
    // 界面上标一句「正在用哪个模型」。label 里只有服务商名和模型名，没有密钥
    label: endpoint?.label ?? "",
  });
});

/**
 * 问一句。
 *
 * 历史由**前端**拿着、每次整段发上来 —— 服务端不存任何东西（见 assistant.js
 * 的文件头）。所以 turns 是不可信输入，一律过 sanitizeTurns：只认
 * user / assistant，收 system 等于让页面上任何一段文字都能改写助手的身份。
 *
 * 用的是「主 LLM」：按角色顺序找第一个解析得出来的聊天模型，绑了项目的角色
 * 优先（那些是真在跑的线路）。副 API 沿用同一个角色的那条 —— 助手答疑的时候
 * 挂在主模型上和聊天挂了是同一件事，能顶上就顶。
 *
 * `params: {}`：不带温度、不带惩罚项。预设里那些参数是为角色扮演调的，
 * 拿来答疑只会让它把菜单路径讲得天花乱坠。
 */
app.post("/api/assistant/chat", async (req, res) => {
  const ask = String(req.body?.ask ?? "").trim();
  if (!ask) return res.status(400).json({ ok: false, error: "没收到问题" });

  const config = loadConfig();
  const endpoint = resolveAssistantEndpoint(config, resolveEndpoint);
  if (!endpoint) {
    return res.status(400).json({
      ok: false,
      error:
        "还没有可用的聊天模型，我这会儿答不了。去「连接」里加一个服务商源、填上地址和密钥，再给一个模型勾上「聊天」分类，然后在「角色 → 模型」里选上它。",
    });
  }

  const messages = buildAssistantMessages({ ask, turns: req.body?.turns });
  try {
    const { content, usedFallback } = await chatWithFallback(endpoint, null, messages, {});
    const reply = String(content ?? "").trim();
    if (!reply) {
      logWarn("助手", "这轮回复是空的", endpoint.label);
      return res.status(400).json({ ok: false, error: "模型这轮什么都没说，再问一次试试。" });
    }
    logInfo("助手", `答了一句（${endpoint.label}）`, ask.slice(0, 80));
    res.json({ ok: true, reply, label: endpoint.label, usedFallback });
  } catch (e) {
    const error = String(e?.message ?? e);
    logWarn("助手", "这轮没答上来", error);
    res.status(400).json({ ok: false, error });
  }
});

app.get("/api/health", (_req, res) => {
  // port / igPort 是给前端算「另一个页面在哪」用的：IG 页右上角那些「去控制台
  // 设置」的链接要拼出控制台的地址，而它只知道自己被开在哪个端口上。
  // 这两个常量声明在下面，但这个回调要等有请求才跑，那时早过了 TDZ
  res.json({ ok: true, service: "uranus-imessage", port: PORT, igPort: IG_PORT || null });
});

const PORT = Number(process.env.PORT) || 8787;

/**
 * Instagram 页单独占的端口。
 *
 * 同一个 Express app 挂两个 listen：请求打在哪个端口上，就发哪一份 HTML
 * （`req.socket.localPort`）。**不是**两个服务 —— `/api/*` 那一整套在两个端口
 * 上都在，IG 页才不用跨域去找 8787（跨域了 cookie、相对路径的取图地址全得改）。
 *
 * `URANUS_IG_PORT=off` 关掉这个端口（沙箱就是这么让开 6873 的，
 * 见 scripts/dev-sandbox.mjs）。
 */
const IG_PORT_RAW = (process.env.URANUS_IG_PORT ?? "6873").trim();
const IG_PORT = /^(off|no|0|false)$/i.test(IG_PORT_RAW) ? 0 : Number(IG_PORT_RAW) || 6873;

const CONSOLE_HTML = path.join(CLIENT_DIST, "index.html");
const IG_HTML = path.join(CLIENT_DIST, "instagram.html");

/** 这条请求是打在 IG 那个端口上的吗。 */
function onIgPort(req) {
  return IG_PORT !== 0 && req.socket?.localPort === IG_PORT;
}

/** 这条请求该拿哪一份首页。IG 那份没构建出来就退回控制台，总比 404 强。 */
function entryFor(req) {
  return onIgPort(req) && fs.existsSync(IG_HTML) ? IG_HTML : CONSOLE_HTML;
}

/*
 * 小红书配图的一次性链接：xiaohongshu-mcp 不在这台机器上时，它从这里取图
 * （见 xhsstore.js:shareStaged）。不走登录 —— MCP 带不了登录态，凭的是
 * 32 位随机令牌，发完就作废。不在 /api/ 下，所以鉴权中间件本来就不拦它。
 */
app.get(/^\/xhs-img\/([0-9a-f]{32})(\.[a-z0-9]{1,5})?$/i, (req, res) => {
  const file = xhsSharedFile(req.params[0].toLowerCase());
  if (!file) return res.status(404).end();
  logInfo("小红书", `xiaohongshu-mcp 来取配图了（来源 ${req.ip || "未知"}）`);
  res.sendFile(file);
});

// ---- 生产：serve 前端静态产物 ----
// 这一层必须排在 express.static **前面**：static 看见 "/" 会直接把 index.html
// 发出去，轮不到下面的兜底中间件挑
app.use((req, _res, next) => {
  if (req.method === "GET" && onIgPort(req)) {
    const pathname = req.url.split("?")[0];
    if (pathname === "/" || pathname === "/index.html") {
      req.url = `/instagram.html${req.url.slice(pathname.length)}`;
    }
  }
  next();
});
app.use(express.static(CLIENT_DIST));
app.use((req, res, next) => {
  if (req.method !== "GET") return next();
  const target = entryFor(req);
  if (fs.existsSync(target)) {
    res.sendFile(target);
  } else {
    next();
  }
});

/**
 * 一次性搬运：老版本角色里手写的预设对话。
 *
 * 预设编辑器撤掉了，但用户写过的内容不能凭空消失 —— 存成旁路文件，
 * 「上下文」面板会只读展示，用户看过觉得没用可以自己删。
 * saveLegacyPreset 已存在就跳过，所以重启不会反复写。
 */
function migratePresets() {
  try {
    for (const preset of extractLegacyPresets(readRawConfig())) {
      const id = saveLegacyPreset(preset);
      if (id) {
        logInfo(
          "配置",
          `「${preset.roleName || preset.roleId}」的 ${preset.messages.length} 条旧版预设对话已存为 ${id}，可在「上下文」面板查看`
        );
      }
    }
  } catch (e) {
    logWarn("配置", "搬运旧版预设对话失败（不影响使用）", e);
  }
}

/**
 * 一次性搬运：会话存档的文件名从「角色名 + 对方号码」换成「角色名 + 线路号码」。
 *
 * 必须在 syncBridges **之前**跑完 —— 桥接一起来就可能有消息进来，那时候
 * 按新 ID 读到的是空历史，随后 appendTurn 会照着新 ID 建一份新文件，
 * 老存档就彻底成了没人读的孤儿。
 *
 * 角色 → 线路号的对应靠 projectRef 现算（迁移这一步用不着 runner，
 * 那时候连接还没起）。幂等：搬过一次之后新 ID 反算不回老规则，第二次直接跳过。
 */
function migrateSessionNames() {
  try {
    const config = loadConfig();
    const lineByProject = new Map(
      (config.projects ?? []).map((p) => [p.id, String(p.linePhone ?? "").trim()])
    );
    const lineByRole = new Map(
      (config.roles ?? []).map((r) => [r.id, lineByProject.get(r.projectRef) ?? ""])
    );

    for (const { from, to } of migrateSessionIds(lineByRole, (msg) => logWarn("配置", msg))) {
      logInfo("配置", `会话存档 ${from} 已改名为 ${to}（会话 ID 不再带对方号码）`);
    }
  } catch (e) {
    logWarn("配置", "改会话存档的名字失败（老名字还在，历史没丢）", e);
  }
}

app.listen(PORT, () => {
  console.log(`\n  Uranus iMessage 控制台后端已启动`);
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  → 配置目录: ${getDataDir()}\n`);
  logInfo("系统", `后端已启动，监听 ${PORT} 端口`);

  // 顺序有讲究：migratePresets 靠 readRawConfig 摘老配置里 roles[].context
  // 的旧版预设对话，而 migrateDataLayout 写出的角色文件是规范化过的、
  // context 已经没了。先摘再搬。
  migratePresets();
  migrateDataLayout();
  // 这个要在 syncBridges 之前：桥接一起来就可能有消息进来，见函数上的注释
  migrateSessionNames();

  // 启动 iMessage 桥接（仅在未显式禁用时）
  if (process.env.IMESSAGE_BRIDGE !== "off") {
    syncBridges(loadConfig).catch((e) => {
      logError("桥接", "启动桥接异常", e);
    });
  } else {
    logWarn("系统", "IMESSAGE_BRIDGE=off，这次不启动桥接");
  }

  /*
   * 定时日记的检查（每分钟看一次各角色够不够间隔）。
   *
   * **不传 notify** —— 定时日记是后台行为，写成了往对方的 iMessage 里发一条
   * 「我写了一篇日记」是替角色说话，等于凭空多出一条不是角色本意的消息；
   * 失败的说明更不该在凌晨四点弹给对方。两者都记进日志、失败还会写进
   * `日记/<key>/state.json` 的 lastError，「记忆库」面板里能看到。
   *
   * 放在最后：它 unref 过，不会拦着进程退出，也不依赖桥接起没起。
   */
  startDiaryTimer(loadConfig);

  /*
   * Instagram 的互动队列（每分钟看一眼有没有到点的赞 / 评论）。
   *
   * 和日记定时器同一个路子：unref 过、不依赖桥接起没起。桥没起来的时候
   * 队列照跑 —— IG 上的赞和评论本来就不经过 iMessage，只是那一轮顺带的
   * 短信发不出去（igSessionFor 返回 null 时 runIgTask 会把它丢掉并记日志）。
   *
   * 一个角色都没开 Instagram 时 startIgQueue 里那一 tick 直接返回，
   * 不读盘也不打模型。
   */
  startIgQueue(loadConfig, { session: igSessionFor(loadConfig) });

  /*
   * 真 Instagram 的轮询（续 token / 拉你的帖子 / 拉角色帖子下的新评论）。
   *
   * 同样 unref 过。一个真号都没绑的时候那一 tick 只读一个 JSON 文件就返回 ——
   * 那是绝大多数用户的状态，不该有任何网络动作。
   *
   * 和上面那个队列分开两路定时器，是因为节奏差两个数量级：队列每分钟看一眼
   * （本地的赞和评论要准时），真 IG 默认每 3 小时一次（省 Meta 的额度）。
   */
  startIgPolling(loadConfig);

  /*
   * 小红书的评论轮询。每分钟看一眼哪个角色到点了（到点 = 过了它自己设的
   * 间隔），一个角色都没开「回评论」时那一 tick 直接返回，不碰网络。
   */
  startXhsPolling(loadConfig, { session: igSessionFor(loadConfig) });

  /*
   * 定时维护（定时重启 / 定时清缓存）。
   *
   * 同样 unref 过、不依赖桥接起没起。两个开关默认都是关的，那种情况下这一 tick
   * 只读一份内存里的配置就返回，什么都不做 —— 见 maintenance.js。
   */
  startMaintenance(loadConfig);
});

/*
 * 第二个端口：Instagram。
 *
 * 同一个 app，所以路由、中间件、`/api/*` 全是共用的一份，只有首页那一步按端口
 * 分岔（见上面的 entryFor）。这里**不重跑**迁移、桥接、日记定时器 —— 那些是
 * 「进程起来了」该干的事，不是「又多监听了一个端口」该干的事，跑两遍轻则刷屏
 * 重则把桥接顶掉。
 *
 * 起不来不算致命：6873 被别的程序占了的话，控制台照样得能用，所以这里只记一条
 * 警告。不挂 error 处理器的话 EADDRINUSE 会当成未捕获异常把整个进程带走。
 */
if (IG_PORT) {
  const igServer = app.listen(IG_PORT, () => {
    console.log(`  → Instagram: http://localhost:${IG_PORT}\n`);
    logInfo("系统", `Instagram 页监听 ${IG_PORT} 端口`);
  });
  igServer.on("error", (e) => {
    logWarn(
      "系统",
      `Instagram 端口 ${IG_PORT} 起不来（${e?.code || e?.message || e}），` +
        `这次只有控制台可用。换个端口：URANUS_IG_PORT=6874`
    );
  });
}

/*
 * 进程收到退出信号时把连接收干净，别在 Photon 那边留着挂起的会话。
 *
 * 8 秒兜底是 spectrum-ts 12.10 之后才要的：那以前 SDK 自己也挂了一份 SIGINT /
 * SIGTERM 处理器，收尾超过 3 秒就替我们 process.exit(1)。12.10 把它拿掉了，
 * 现在只剩这一个 —— stopAllBridges 本身不限时，哪条连接关不掉，Ctrl+C 和
 * systemctl stop 就一直卡着不退。SDK 内部关流最多等 5 秒，8 秒留足余量。
 */
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    setTimeout(() => process.exit(1), 8000).unref();
    await stopAllBridges().catch(() => {});
    process.exit(0);
  });
}

// 主动重启（/api/restart 和 `/重启` 指令）走的也是这套收尾。restart.js 不能
// 直接 import imessage.js —— 那边要 import 它（指令那条路），会成循环依赖
setShutdown(() => stopAllBridges().catch(() => {}));