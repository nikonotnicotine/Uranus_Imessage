/**
 * 一键更新：把这份代码换成 GitHub 上最新的版本，再把服务起回来。
 *
 *   node scripts/update.mjs              问一句，然后更新
 *   node scripts/update.mjs --check      只查，什么都不动
 *   node scripts/update.mjs --yes        不问，直接更
 *   node scripts/update.mjs --force      版本号一样也照更（上次没更干净时用）
 *   node scripts/update.mjs --no-start   更完不把服务起回来
 *
 * ── 为什么是一个单独的进程，而不是控制台上的一个按钮 ──
 *
 * server/src/update.js 那边只查不装，理由写在它自己的开头。其中最硬的一条是
 * 「在一个正在运行的 Node 进程里换自己的文件，等于给自己换轮胎」：Windows 上
 * 跑着的 node 握着 server/src 下的文件句柄，覆盖会直接失败；就算覆盖成功了，
 * 已经加载进内存的那份旧模块也不会变。
 *
 * 这个脚本绕开那一整套：它是**另一个进程**，第一件事就是把服务停掉。之后没有
 * 任何文件被谁握着，换文件就只是换文件。不用改 launch.mjs 一行，也不需要
 * 「先暂存、重启后再应用」那种两段式握手。
 *
 * ── 两条路 ──
 *
 * 有 .git（自己 clone 的，VPS 多半是这种）：`git pull --ff-only`。撞上本地
 * 改动它会直接拒绝并停下，一个文件都不动 —— 这正好是我们要的语义。
 *
 * 没有 .git（下 ZIP 装的，大部分 Windows 用户）：下最新 release 的 tar.gz，
 * 按里面的清单覆盖。「哪些文件是我上次写下去的」记在 .update-state.json 里，
 * 靠它认出用户自己改过的东西 —— 改过的就停下来，不覆盖。
 *
 * 两条路都不碰 data/、node_modules/、client/dist/。前两个是 .gitignore 挡掉
 * 的，压根不在 tarball 里；这里再拦一道（见 PROTECTED），是因为「更新把聊天
 * 记录弄没了」这种事只要发生一次就没法挽回。
 *
 * ── 依赖 ──
 *
 * 只有 package.json 里的依赖块真的变了，才跑一次 npm install。判据是更新前后
 * 各算一次指纹再比（见 depFingerprint），而不是 launch.mjs 里那个手写的哨兵
 * 清单 —— 那个清单要靠人记得往里补包，忘一次就是所有人一起炸。node_modules
 * 从头到尾不动，所以常见情况下这一步是零秒。
 *
 * ── 这个文件要能在很旧的 checkout 上跑 ──
 *
 * 更新.bat 发现 scripts/update.mjs 不在就自己下一份，所以它经常是在一个**老
 * 版本的目录**里被执行的。除了 port-check.mjs（v0.7 那会儿就是现在这四个
 * 导出，接口没变过），别 import 项目里的其它东西，也别指望根目录有什么。
 *
 * ── 只管 Windows ──
 *
 * 停服务用 taskkill，重启用 cmd /c start，都是 Windows 专属。Mac 和 VPS 上
 * `git pull && npm install && npm run build` 一行就够，没必要再套一层，所以
 * main() 一进来就按平台挡掉并把那行命令打出来（见那里的注释）。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import readline from "node:readline/promises";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { checkPort, isMine } from "./port-check.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const REPO = "nikonotnicotine/Uranus_Imessage";
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;
/** GitHub 要求带 UA，不带直接 403。 */
const UA = "Uranus-iMessage-Updater";

/** 备份、临时文件、上一版的指纹，都堆在这三个地方（全在 .gitignore 里）。 */
const BACKUP_DIR = ".update-backup";
const TMP_DIR = ".update-tmp";
const STATE_FILE = ".update-state.json";
/** 备份留最近几份。留太多会白占几十兆，留太少出事没得退。 */
const KEEP_BACKUPS = 3;

/**
 * 这些顶层目录**任何情况下都不写、不删、不备份**。
 *
 * 正常情况下它们根本不会出现在 tarball 里（.gitignore 挡着）。这一道是防
 * 「.gitignore 哪天被改错了」「有人手贱 git add -f 了 data/」之类的意外 ——
 * 代价是一个 Set 的查表，换的是聊天记录和密钥不会被一次更新抹掉。
 */
const PROTECTED = new Set([
  ".git",
  "node_modules",
  "data", // 聊天记录、记忆、各家 API key、Photon 凭据
  ".sandbox",
  BACKUP_DIR,
  TMP_DIR,
]);

const argv = new Set(process.argv.slice(2));
const CHECK_ONLY = argv.has("--check");
const ASSUME_YES = argv.has("--yes") || argv.has("-y");
const FORCE = argv.has("--force");
const NO_START = argv.has("--no-start");
const isWin = process.platform === "win32";

const say = (s = "") => console.log(s);
const rule = "  " + "-".repeat(52);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================= 小工具 ================= */

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

function readIfExists(abs) {
  try {
    return fs.readFileSync(abs);
  } catch {
    return null;
  }
}

function readJSON(rel) {
  const buf = readIfExists(path.join(root, rel));
  if (!buf) return null;
  try {
    return JSON.parse(buf.toString("utf-8"));
  } catch {
    return null;
  }
}

/** 问一个 Y/N；读不到输入就当 N（宁可什么都不做）。 */
async function askYN(question) {
  if (ASSUME_YES) {
    say(`${question}Y`);
    return true;
  }
  if (!process.stdin.isTTY && !process.stdin.readable) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = await rl.question(question);
    return a.trim().toUpperCase().startsWith("Y");
  } catch {
    return false;
  } finally {
    rl.close();
  }
}

/** 跑一条命令，输出直接串到本窗口。 */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: root,
      stdio: "inherit",
      // Windows 上 npm/git 可能是 .cmd，新版 Node 不许直接 spawn 它们
      shell: isWin,
      ...opts,
    });
    child.on("close", (code) => resolve(code ?? 0));
    child.on("error", () => resolve(-1));
  });
}

/** 跑一条命令，把 stdout 收回来。失败返回 null（而不是抛）。 */
function capture(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      cwd: root,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 60_000,
    });
  } catch {
    return null;
  }
}

/* ================= 版本 ================= */

/** 本地版本号。读不出来返回空串 —— 不该让「不知道自己几版」把更新整个拦下。 */
function localVersion() {
  return String(readJSON("package.json")?.version ?? "").trim();
}

/** 把版本号切成数字段，`v` 前缀和 `-beta.1` 后缀都认。 */
function parts(v) {
  return String(v ?? "")
    .trim()
    .replace(/^v/i, "")
    .split(/[-+]/)[0]
    .split(".")
    .map((s) => {
      const n = Number.parseInt(s, 10);
      return Number.isFinite(n) ? n : 0;
    });
}

/** a 比 b 新返回正数。和 server/src/update.js 的 compareVersions 同一套规则。 */
function compareVersions(a, b) {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** 把连不上 GitHub 翻成能照着办的中文。 */
function explainNet(e) {
  const code = String(e?.cause?.code ?? e?.code ?? e?.name ?? "").trim();
  if (/TIMEOUT|TimeoutError|ETIMEDOUT/i.test(code)) {
    return "连 GitHub 超时了。国内直连经常这样 —— 挂上代理再试，或者过一会儿再来。";
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(code)) return "解析不了 api.github.com，先看这台机器的网络和 DNS。";
  return `连不上 GitHub${code ? `（${code}）` : ""}。挂上代理再试，或者过一会儿再来。`;
}

async function fetchLatest() {
  const res = await fetch(LATEST_API, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": UA,
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 404) throw new Error("仓库上还没发布过版本，没得更新。");
  if (res.status === 403 || res.status === 429) {
    throw new Error("GitHub 暂时不让查了（匿名请求每小时有上限）。等一小时再试。");
  }
  if (!res.ok) throw new Error(`GitHub 返回 ${res.status}，过一会儿再试。`);
  const raw = await res.json();
  return {
    tag: String(raw?.tag_name ?? "").trim(),
    name: String(raw?.name ?? "").trim(),
    notes: String(raw?.body ?? "").trim(),
    url: String(raw?.html_url ?? "").trim() || `https://github.com/${REPO}/releases/latest`,
  };
}

/* ================= 下载 ================= */

/**
 * 下一个文件回来，拿到 Buffer。
 *
 * 先试 curl：它认 HTTPS_PROXY 和 %USERPROFILE%\.curlrc，国内用户十有八九
 * 已经给它配过代理了，而 Node 的 fetch 两样都不看。curl 不在（很老的
 * Windows）或者它失败了，再拿 fetch 兜一次。
 */
async function download(url) {
  const tmp = path.join(root, TMP_DIR, "download.bin");
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.rmSync(tmp, { force: true });

  const r = spawnSync(
    "curl",
    ["-fsSL", "--retry", "2", "--connect-timeout", "20", "-A", UA, "-o", tmp, url],
    { stdio: "ignore", timeout: 300_000 }
  );
  if (r.status === 0) {
    const buf = readIfExists(tmp);
    if (buf?.length) return buf;
  }

  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/* ================= tar 解析 ================= */

/*
 * 为什么自己解 tar 而不用 tar-fs 或者系统的 tar.exe：
 *
 *  - tar-fs 是 server 的依赖，装在 node_modules 里。而这个脚本可能是在一个
 *    连依赖都还没装好的目录里被执行的（bootstrap 那条路），不能指望它在。
 *  - Windows 自带的 tar.exe 是 bsdtar，在中文 Windows 上按当前代码页（936）
 *    解文件名，而 GitHub 的 tarball 里文件名是 UTF-8 —— 「启动.bat」
 *    「VPS部署教程.md」会解成乱码，解出来一堆谁也认不出的文件。
 *
 * 自己解就这几十行，编码完全在手里，而且零依赖。
 */

/** tar 头里的八进制字段。 */
function octal(buf, off, len) {
  const s = buf.subarray(off, off + len).toString("latin1").replace(/\0/g, " ").trim();
  if (!s) return 0;
  const n = Number.parseInt(s, 8);
  return Number.isFinite(n) ? n : 0;
}

/** 截到第一个 \0，按 UTF-8 解。 */
function cstr(buf) {
  const i = buf.indexOf(0);
  return buf.subarray(0, i < 0 ? buf.length : i).toString("utf-8");
}

/**
 * pax 扩展头里的一个字段。
 *
 * 格式是一条条 `<十进制总长> key=value\n`。长度算的是**字节**不是字符，
 * 所以只能在 Buffer 上切 —— 在 JS 字符串上切遇到中文路径就会错位。
 */
function paxField(body, key) {
  let i = 0;
  while (i < body.length) {
    const sp = body.indexOf(0x20, i);
    if (sp < 0) break;
    const len = Number.parseInt(body.subarray(i, sp).toString("latin1"), 10);
    if (!Number.isFinite(len) || len <= 0 || i + len > body.length) break;
    const rec = body.subarray(sp + 1, i + len - 1).toString("utf-8"); // 砍掉结尾那个 \n
    const eq = rec.indexOf("=");
    if (eq > 0 && rec.slice(0, eq) === key) return rec.slice(eq + 1);
    i += len;
  }
  return "";
}

/** 遍历 tar 里的普通文件，吐 { name, body }。目录和链接一律跳过。 */
function* readTar(buf) {
  let off = 0;
  let longName = ""; // GNU 的 'L' 条目
  let paxPath = ""; // pax 的 'x' 扩展头（GitHub 的 tarball 用这个放长路径）

  while (off + 512 <= buf.length) {
    const head = buf.subarray(off, off + 512);
    if (head.every((b) => b === 0)) break; // 结尾的空块

    const size = octal(head, 124, 12);
    const type = String.fromCharCode(head[156]);
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;

    if (type === "L") {
      longName = cstr(body);
      continue;
    }
    if (type === "x") {
      paxPath = paxField(body, "path");
      continue;
    }
    if (type === "g") continue; // pax 全局头，GitHub 拿它放 commit sha

    const name = paxPath || longName || joinName(head);
    longName = "";
    paxPath = "";

    if (type === "0" || type === "\0") yield { name, body };
  }
}

/** ustar 的 name + prefix 拼回完整路径。 */
function joinName(head) {
  const name = cstr(head.subarray(0, 100));
  const prefix = cstr(head.subarray(345, 500));
  return prefix ? `${prefix}/${name}` : name;
}

/**
 * 把 tarball 拆成 `项目内相对路径 -> 内容`。
 *
 * GitHub 的 tarball 最外面裹了一层 `Uranus_Imessage-0.9.0/`，剥掉。
 * 带 `..` 的、绝对路径的、以及落在 PROTECTED 里的，一律丢掉不要。
 */
function unpack(gz) {
  const tar = zlib.gunzipSync(gz);
  const files = new Map();
  const refused = [];

  for (const { name, body } of readTar(tar)) {
    const rel = name.split("/").slice(1).join("/");
    if (!rel) continue;
    const segs = rel.split("/");
    if (segs.includes("..") || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
      refused.push(rel);
      continue;
    }
    if (PROTECTED.has(segs[0])) {
      refused.push(rel);
      continue;
    }
    files.set(rel, Buffer.from(body));
  }
  return { files, refused };
}

/* ================= 依赖指纹 ================= */

/**
 * 「依赖有没有变」的指纹。
 *
 * 只看三份 package.json 里的依赖块，不看整个文件 —— 发版时根 package.json 的
 * version 每次都变，拿整个文件当判据会次次误判成「依赖变了」，白等一次
 * npm install。key 排序后再算，免得单纯挪了个位置也算变。
 */
function depFingerprint() {
  const h = createHash("sha256");
  for (const f of ["package.json", "server/package.json", "client/package.json"]) {
    const j = readJSON(f) ?? {};
    h.update(f);
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
      const m = j[field] ?? {};
      for (const k of Object.keys(m).sort()) h.update(`${field}:${k}=${m[k]};`);
    }
  }
  return h.digest("hex");
}

/* ================= 停服务 ================= */

const PORT = process.env.PORT?.trim() || "8787";
const IG_PORT_RAW = process.env.URANUS_IG_PORT?.trim() || "6873";
const IG_PORT = /^(off|no|0|false)$/i.test(IG_PORT_RAW) ? "" : IG_PORT_RAW;

/**
 * 把正在跑的服务停掉。
 *
 * 只杀「确认是本项目」的那个进程（/api/health 认得出来），端口上是别人的
 * 就不碰 —— 更新本身不需要这个端口，凭一个端口号去杀陌生进程太莽。
 *
 * 杀的是最里面那个 node（监听端口的那个）。外面那层 launch.mjs 的守护循环
 * 看到不是约定的退出码 75 就会自己退出，所以不会跟我们抢端口；只是它那个黑
 * 窗口会停在「请按任意键继续」，得让用户知道那是正常的。
 *
 * @returns {Promise<boolean>} 有没有真的停掉过东西（决定更新完要不要起回来）
 */
async function stopService() {
  if (!isWin) {
    // Linux 上没有文件占用的问题，换文件不用先停；服务怎么起回来由 systemd 管
    const running = await isMine(PORT);
    if (running) say("  服务正在跑。Linux 上换文件不用先停，更新完再重启就行");
    else say("  服务没在跑");
    return running;
  }

  let stopped = false;
  for (const port of [PORT, IG_PORT].filter(Boolean)) {
    const r = await checkPort(port);
    if (r.free) continue;
    if (!r.mine) {
      say(`  端口 ${port} 上是别的程序（${r.names.join("、")}），没动它`);
      continue;
    }
    say(`  停掉 ${port} 上的服务（PID ${r.pids.join(" ")}）...`);
    for (const pid of r.pids) {
      try {
        execFileSync("taskkill", ["/f", "/pid", String(pid)], { stdio: "ignore" });
      } catch {
        /* 已经没了或者权限不够，下面重新探一次就知道 */
      }
    }
    stopped = true;
  }

  if (stopped) {
    await sleep(1500); // 等系统真正回收端口和文件句柄
    const again = await checkPort(PORT);
    if (!again.free && again.mine) {
      say(`  [X] ${PORT} 上的服务没停下来（PID ${again.pids.join(" ")}）`);
      say("      可能需要用管理员身份再跑一次这个更新");
      return null; // null = 停不掉，调用方据此中止
    }
    say("  服务已停止");
  } else {
    say("  服务没在跑，直接更新");
  }
  return stopped;
}

/* ================= 备份 ================= */

function backupRoot() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return path.join(root, BACKUP_DIR, stamp);
}

/** 只留最近 KEEP_BACKUPS 份，老的删掉。 */
function rotateBackups() {
  const base = path.join(root, BACKUP_DIR);
  let dirs;
  try {
    dirs = fs
      .readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return 0;
  }
  let dropped = 0;
  for (const name of dirs.slice(0, Math.max(0, dirs.length - KEEP_BACKUPS))) {
    fs.rmSync(path.join(base, name), { recursive: true, force: true });
    dropped++;
  }
  return dropped;
}

/* ================= 换代码：git 那条路 ================= */

function hasGit() {
  if (!fs.existsSync(path.join(root, ".git"))) return false;
  return capture("git", ["--version"]) !== null;
}

/**
 * `git pull --ff-only`。
 *
 * 动手之前先自己查一遍工作区干不干净 —— `--ff-only` 本身也会因为本地改动而
 * 失败，但它的报错是英文的一大坨，不如在这儿把改过的文件名列出来讲清楚。
 *
 * @returns {Promise<{ok: boolean, from?: string, reason?: string}>}
 */
async function updateByGit() {
  const dirty = (capture("git", ["status", "--porcelain"]) ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (dirty.length) {
    say("  [X] 这个目录里有你自己改过的东西，更新会覆盖掉它们，所以停下了：");
    say();
    for (const line of dirty.slice(0, 20)) say(`        ${line}`);
    if (dirty.length > 20) say(`        ...还有 ${dirty.length - 20} 个`);
    say();
    say("      要更新的话，先处理掉这些改动（三选一）：");
    say("        想留着     git stash          更新完再 git stash pop");
    say("        想留成一版 git commit -am 自己的改动");
    say("        不要了     git checkout -- .");
    return { ok: false, reason: "本地有未提交的改动" };
  }

  const from = (capture("git", ["rev-parse", "HEAD"]) ?? "").trim().slice(0, 7);

  // 浅克隆（git clone --depth=1）拉不动，先补全历史
  if ((capture("git", ["rev-parse", "--is-shallow-repository"]) ?? "").trim() === "true") {
    say("  这是个浅克隆，先把历史补全（只做这一次）...");
    await run("git", ["fetch", "--unshallow"]);
  }

  say("  git pull --ff-only ...");
  if ((await run("git", ["pull", "--ff-only"])) !== 0) {
    say();
    say("  [X] git pull 没成功，看上面的报错。一个文件都没动。");
    return { ok: false, reason: "git pull 失败" };
  }
  return { ok: true, from };
}

/* ================= 换代码：tarball 那条路 ================= */

function loadState() {
  const j = readJSON(STATE_FILE);
  return j && typeof j.files === "object" ? j : null;
}

/**
 * 下 tarball 覆盖。
 *
 * 认「用户改过的文件」靠的是上次更新留下的指纹（.update-state.json）：磁盘上
 * 的内容和我上次写下去的不一样，那就是用户自己动过的。这种文件只要新版里也
 * 有，就停下来不覆盖 —— 用户说了算，不是更新器说了算。
 *
 * 第一次跑没有这份指纹（新装的更新器），那就没有对照物，查不出来。这一点必须
 * 明说，不能装作查过了；代价由全量备份兜着。
 */
async function updateByTarball(tag) {
  say(`  下载 ${tag} 的源码包...`);
  const gz = await download(`https://codeload.github.com/${REPO}/tar.gz/refs/tags/${tag}`);
  say(`  拿到 ${(gz.length / 1024 / 1024).toFixed(1)} MB，正在拆包...`);

  const { files, refused } = unpack(gz);
  if (!files.size) throw new Error("源码包是空的或者格式不对，没敢往下走。");
  for (const r of refused) say(`  [!] 源码包里有个不该出现的路径，已忽略：${r}`);

  const state = loadState();
  const changed = [];
  const added = [];
  const conflicts = [];

  for (const [rel, body] of files) {
    const abs = path.join(root, rel);
    const disk = readIfExists(abs);
    if (!disk) {
      added.push(rel);
      continue;
    }
    const diskSha = sha(disk);
    if (diskSha === sha(body)) continue; // 一模一样，不用写

    // 上次是我写下去的，现在内容对不上 —— 中间被人改过
    if (state?.files?.[rel] && state.files[rel] !== diskSha) conflicts.push(rel);
    changed.push(rel);
  }

  // 上次写下去、这次新版里没有了、磁盘上还在的 —— 那是上游删掉的文件
  const removed = [];
  for (const rel of Object.keys(state?.files ?? {})) {
    if (files.has(rel)) continue;
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    if (sha(fs.readFileSync(abs)) !== state.files[rel]) continue; // 用户改过，留着
    removed.push(rel);
  }

  if (conflicts.length) {
    say("  [X] 这几个文件你自己改过，新版也要动它们，覆盖了就没了，所以停下了：");
    say();
    for (const rel of conflicts.slice(0, 20)) say(`        ${rel}`);
    if (conflicts.length > 20) say(`        ...还有 ${conflicts.length - 20} 个`);
    say();
    say("      想保留自己的改动：把这些文件复制一份到项目外面留底，");
    say("      然后删掉（或改名），再跑一次更新。");
    return { ok: false, reason: "本地有改过的文件" };
  }

  if (!changed.length && !added.length && !removed.length) {
    say("  文件内容和新版一模一样，没什么要换的");
    return { ok: true, backup: "", touched: 0 };
  }

  say(`  要换 ${changed.length} 个、新增 ${added.length} 个、删掉 ${removed.length} 个`);
  if (!state) {
    say();
    say("  [!] 这是第一次用更新器，没有上一版的指纹做对照，");
    say("      所以查不出你改过哪些文件。旧的全都会先备份下来。");
    say();
  }

  // ── 备份：只备份会被动到的（改 + 删）。新增的文件本来就不存在，没什么好备份
  const dir = backupRoot();
  for (const rel of [...changed, ...removed]) {
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(root, rel), dst);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "这是什么.txt"),
    [
      "这是更新前的旧版文件，自动备份的。",
      "",
      `备份时间：${new Date().toLocaleString("zh-CN")}`,
      `更新前版本：${localVersion() || "读不出来"}`,
      `更新到：${tag}`,
      "",
      "新版要是起不来，把这个文件夹里的东西按原样盖回项目根目录就回到旧版了。",
      "确认没问题之后，整个 .update-backup 文件夹都可以删。",
      "",
      `改动 ${changed.length} 个文件，删除 ${removed.length} 个文件。`,
    ].join("\n"),
    "utf-8"
  );
  say(`  旧版已备份到 ${path.relative(root, dir)}\\`);

  // ── 写入
  for (const rel of [...changed, ...added]) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, files.get(rel));
  }
  for (const rel of removed) fs.rmSync(path.join(root, rel), { force: true });

  // ── 记下这一版的指纹，下次拿它认「用户改过什么」
  const fingerprints = {};
  for (const [rel, body] of files) fingerprints[rel] = sha(body);
  fs.writeFileSync(
    path.join(root, STATE_FILE),
    JSON.stringify({ tag, at: new Date().toISOString(), files: fingerprints }, null, 0),
    "utf-8"
  );

  return {
    ok: true,
    backup: path.relative(root, dir),
    touched: changed.length + added.length + removed.length,
    selfChanged: changed.includes("更新.bat"),
  };
}

/* ================= 主流程 ================= */

async function main() {
  say();
  say("  ============================================");
  say("    Uranus iMessage - 一键更新");
  say("  ============================================");
  say();

  // 跑错地方是最容易犯的错，先把这个挡掉
  if (readJSON("package.json")?.name !== "uranus-imessage") {
    say("  [X] 这里不像是 Uranus 的项目目录（没找到对得上的 package.json）");
    say(`      我看的是：${root}`);
    return 1;
  }

  // 这个更新器只在 Windows 上验过。停服务靠 taskkill、重启靠 cmd /c start，
  // 换到 Mac / Linux 上这两步都会哑火 —— 那边有更简单的正路，直接指过去，
  // 别让人跑出个半截结果。
  if (!isWin) {
    const mac = process.platform === "darwin";
    say("  [X] 这个一键更新只管 Windows。");
    say();
    say(`      你这台是 ${mac ? "Mac" : process.platform}，按下面这条来（一行敲完）：`);
    say();
    if (mac) {
      say("        git pull && npm install && npm run build && npm start");
    } else {
      say("        git pull && npm install && npm run build && sudo systemctl restart uranus");
    }
    say();
    say("      `git pull` 要是报「本地修改会被覆盖」，先 `git status` 看改了哪些，");
    say("      决定留还是丢，别硬来。备份就是拷走 data/ 这一个文件夹。");
    say();
    say(`      详细步骤：docs/${mac ? "Mac" : "VPS"}部署教程.md`);
    return 1;
  }

  /* ---- [1/6] 有没有新版 ---- */
  const current = localVersion();
  say(`  [1/6] 当前版本 ${current || "（读不出来）"}，问问 GitHub 最新是多少...`);
  let latest;
  try {
    latest = await fetchLatest();
  } catch (e) {
    say();
    say(`  [X] ${e?.message?.includes("GitHub") || e?.message?.includes("仓库") ? e.message : explainNet(e)}`);
    return 1;
  }
  say(`        最新版是 ${latest.tag}${latest.name && latest.name !== latest.tag ? `（${latest.name}）` : ""}`);

  const newer = current && latest.tag && compareVersions(latest.tag, current) > 0;
  if (!newer && !FORCE) {
    say();
    say("  已经是最新的了，不用更新。");
    say(`  （想强制重跑一遍：node scripts/update.mjs --force）`);
    return 0;
  }
  if (!newer) say("        版本号没比当前新，但你带了 --force，照更");

  if (latest.notes) {
    say();
    say(rule);
    for (const line of latest.notes.split(/\r?\n/).slice(0, 25)) say(`    ${line}`);
    if (latest.notes.split(/\r?\n/).length > 25) say(`    ...完整说明看 ${latest.url}`);
    say(rule);
  }

  if (CHECK_ONLY) {
    say();
    say("  （--check：只查不动，到此为止）");
    return 0;
  }

  say();
  const go = await askYN(`  更新到 ${latest.tag}？服务会先停一下。  Y=更新   N=退出   `);
  if (!go) {
    say("  没动任何东西。");
    return 2;
  }

  /* ---- [2/6] 停服务 ---- */
  say();
  say("  [2/6] 停掉正在跑的服务");
  const stopped = await stopService();
  if (stopped === null) return 1;

  /* ---- [3/6] 换代码 ---- */
  say();
  const depsBefore = depFingerprint();
  let result;
  if (hasGit()) {
    say("  [3/6] 这是个 git 仓库，走 git pull");
    result = await updateByGit();
  } else {
    say("  [3/6] 没有 .git，下源码包替换");
    try {
      result = await updateByTarball(latest.tag);
    } catch (e) {
      say();
      say(`  [X] ${e?.message ?? e}`);
      say("      一个文件都没动（下载和拆包都失败在写盘之前）。");
      return 1;
    }
  }
  if (!result.ok) {
    say();
    say(`  更新中止：${result.reason}。代码没变，服务也可以照常起回来。`);
    return 2;
  }

  /* ---- [4/6] 依赖 ---- */
  say();
  const depsAfter = depFingerprint();
  const noModules = !fs.existsSync(path.join(root, "node_modules"));
  if (depsBefore === depsAfter && !noModules) {
    say("  [4/6] 依赖没变，跳过安装（node_modules 一直没动过）");
  } else {
    say(`  [4/6] ${noModules ? "还没装过依赖" : "依赖变了"}，跑一次 npm install，要等几分钟...`);
    if ((await run("npm", ["install"])) !== 0) {
      say();
      say("  [X] npm install 失败，看上面的报错。代码已经是新版了，");
      say("      网络好的时候在这个目录下手动跑一次 npm install 就行。");
      return 1;
    }
  }

  /* ---- [5/6] 收尾 ---- */
  say();
  const dropped = rotateBackups();
  fs.rmSync(path.join(root, TMP_DIR), { recursive: true, force: true });
  say(`  [5/6] 清理临时文件${dropped ? `，顺手删了 ${dropped} 份旧备份（只留最近 ${KEEP_BACKUPS} 份）` : ""}`);

  /* ---- [6/6] 起回来 ---- */
  say();
  say(rule);
  say(`    更新完成：${current || "?"}  ->  ${latest.tag}`);
  if (result.from) say(`    退回旧版：git reset --hard ${result.from}`);
  else if (result.backup) say(`    旧版备份：${result.backup}\\`);
  say(rule);
  say();

  if (result.selfChanged) {
    say("  [!] 「更新.bat」这次自己也换了版本。这个窗口接下来可能会蹦一行");
    say("      看不懂的报错 —— 那是 cmd 在读被换掉的文件，不影响任何东西，");
    say("      关掉就行，下次双击用的就是新的了。");
    say();
  }

  if (!isWin) {
    say("  前端产物要重新构建（dist 不在仓库里），然后重启服务：");
    say("      npm run build && sudo systemctl restart uranus");
    return 0;
  }

  if (NO_START || !stopped) {
    say(`  ${stopped ? "（--no-start）" : "更新前服务本来就没在跑。"}双击「启动.bat」就是新版了。`);
    say("  第一次启动会自动重新构建前端，比平时慢一两分钟，属正常。");
    return 0;
  }

  say("  正在把服务起回来（会开一个新窗口，前端要重新构建，慢一两分钟）...");
  say("  原来那个黑窗口如果还停在「请按任意键继续」，关掉就行。");
  // start 的第一个参数是新窗口的标题。所有参数都是纯 ASCII，项目路径靠 cwd
  // 传给 CreateProcessW，不经过 cmd 的命令行解析 —— 路径里有中文也不会出事
  spawn("cmd", ["/c", "start", "Uranus iMessage", "cmd", "/k", "node", "scripts\\launch.mjs", "start"], {
    cwd: root,
    detached: true,
    stdio: "ignore",
  }).unref();
  await sleep(2000);
  return 0;
}

/**
 * 双击进来的时候，窗口不能跑完就消失 —— 报错和「更新到哪一版了」得让人看见。
 *
 * 这个「按回车」不写在 更新.bat 里，是因为那个文件自己可能在这次更新里被换掉：
 * 它把 node 和 exit 放在同一行，cmd 一次解析完就再也不读那个文件了，所以
 * node 后面不能再有任何一行。等键盘只好挪进来。
 */
async function pauseIfAsked() {
  if (process.env.URANUS_UPDATE_PAUSE !== "1") return;
  if (!process.stdin.isTTY) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    await rl.question("  按回车关掉这个窗口... ");
  } catch {
    /* 读不到就直接退，不值得为它卡住 */
  } finally {
    rl.close();
  }
}

process.exitCode = await main();
await pauseIfAsked();
