/**
 * 一键启动的实际逻辑。启动器那个 .bat 只是薄薄的一层壳，真正干活的是这里。
 *
 *   node scripts/launch.mjs start   单端口生产模式（唯一的方式）
 *
 * 开发模式（5173 + Vite 热更新）已经删了。现在只有生产这一种形态：8787
 * 出控制台，6873 出 Instagram，两个都由后端 serve 同一份 client/dist。
 * 改前端代码要 `npm run build` 再启动 —— 不过这个脚本自己会检测产物过期
 * （见 needs-build.mjs），过期的会自动先构建一遍。
 *
 * 为什么逻辑不写在 .bat 里：cmd.exe 解析含中文的批处理文件时会串行，
 * 文件一大就把行读错位，跑出 'cho'、'5001' 这种半截命令。所以 .bat
 * 保持纯 ASCII，中文一律由 Node 打印（Node 走 WriteConsoleW，
 * 跟当前代码页无关，不会乱码）。
 *
 * 生产模式下服务跑在一个**守护循环**里（见 supervise）：后端用约定的退出码
 * 退出时就地再拉起一次，「重启整个项目」这个功能就是这么来的。
 *
 * Instagram 是单开的一个端口（6873），由后端自己发 —— 和 8787 共用一份
 * 前端产物，只是 entryFor 按请求打在哪个端口上挑要回哪个 HTML。
 *
 * 环境变量：
 *   PORT=8888             换后端端口（默认 8787）
 *   URANUS_IG_PORT=6874   换 Instagram 端口（off = 不开这个端口）
 *   URANUS_NO_BROWSER=1   不自动开浏览器
 *   URANUS_ASSUME=Y|N     端口被占时不交互，直接按这个答（给测试用）
 *
 * 这个脚本自己会给后端设一个 URANUS_SUPERVISOR=1，告诉它「退出之后有人负责
 * 拉起来」—— 后端据此决定重启请求准不准。别手动设它。
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { checkPort } from "./port-check.mjs";
import { needsBuild } from "./needs-build.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2] === "dev" ? "dev" : "start";
const PORT = process.env.PORT?.trim() || "8787";
/** Instagram 那个端口。off / 0 = 不开，这时下面所有和它相关的步骤都跳过。 */
const IG_PORT_RAW = process.env.URANUS_IG_PORT?.trim() || "6873";
const IG_PORT = /^(off|no|0|false)$/i.test(IG_PORT_RAW) ? "" : IG_PORT_RAW;
const noBrowser = process.env.URANUS_NO_BROWSER === "1";

const say = (s = "") => console.log(s);
const rule = "  " + "-".repeat(44);

/** 问一个 Y/N；读不到输入就当 N（宁可不动别人的进程）。 */
async function askYN(question) {
  const forced = process.env.URANUS_ASSUME?.trim().toUpperCase();
  if (forced === "Y" || forced === "N") {
    say(`${question}${forced}`);
    return forced === "Y";
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

/** 跑一条 npm 命令并等它结束，返回退出码。 */
function npm(args, { detachOutput = false, env } = {}) {
  return new Promise((resolve) => {
    // Windows 下 npm 是 npm.cmd，新版 Node 不许直接 spawn .cmd，得走 shell
    const child = spawn("npm", args, {
      cwd: root,
      stdio: detachOutput ? "ignore" : "inherit",
      shell: true,
      env: env ? { ...process.env, ...env } : process.env,
    });
    child.on("close", (code) => resolve(code ?? 0));
    child.on("error", () => resolve(1));
  });
}

/** 结束占着端口的进程。 */
function killPids(pids) {
  for (const pid of pids) {
    try {
      execFileSync("taskkill", ["/f", "/pid", String(pid)], { stdio: "ignore" });
    } catch {
      /* 已经没了或者杀不动，下面重新探端口时会体现出来 */
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 把一个端口清干净。
 * @returns "ok" 可用 | "mine" 上面就是本项目 | "abort" 用户选择退出
 */
async function ensurePort(port, { allowMine, label = "" }) {
  const r = await checkPort(port);

  if (r.mine && allowMine) return "mine";

  if (r.free) {
    say(`  ${label}端口 ${port} 可用`);
    return "ok";
  }

  if (r.mine) {
    say(`  ${label}[!] 端口 ${port} 上已经跑着本项目了（PID ${r.pids.join(" ")}）`);
  } else {
    say(`  ${label}[!] 端口 ${port} 被别的程序占用：${r.names.join("、")}（PID ${r.pids.join(" ")}）`);
  }

  const yes = await askYN("      结束它再继续？  Y=结束   N=退出   ");
  if (!yes) return "abort";

  killPids(r.pids);
  await sleep(1200);

  const again = await checkPort(port);
  if (!again.free) {
    say(`  [X] 端口 ${port} 还是被占着（PID ${again.pids.join(" ")}），可能需要管理员权限`);
    return "abort";
  }
  say(`  端口 ${port} 已腾出`);
  return "ok";
}

/**
 * 依赖装没装。
 *
 * 判据是「这几个包在不在 node_modules 里」，缺任意一个就重跑一次 npm install
 * （npm 自己会跳过已经装好的，代价只有几秒）。
 *
 * 加新依赖时**必须往这个数组里补一个** —— 只改 package.json 的话，老用户
 * node_modules 里已经有 express 了，双击启动就直接走「依赖已就绪」那一路，
 * 新包永远装不上，跑到用它的那行才炸。
 */
const DEP_SENTINELS = [
  "express", // 后端框架，最早的那个判据
  "mammoth", // 读 docx（读文件功能）
  "pdf-parse", // 读 pdf（读文件功能）
];

async function ensureDeps(stepLabel) {
  if (DEP_SENTINELS.every((p) => fs.existsSync(path.join(root, "node_modules", p)))) {
    say(`  ${stepLabel}依赖已就绪`);
    return true;
  }
  say(`  ${stepLabel}第一次运行，安装依赖，要几分钟，别关窗口...`);
  if ((await npm(["install"])) !== 0) {
    say("");
    say("  [X] npm install 失败，看上面的报错");
    return false;
  }
  return true;
}

/** 后台等服务起来了再开浏览器。 */
function openWhenReady(url, healthUrl) {
  if (noBrowser) return;
  const args = [path.join(root, "scripts/open-when-ready.mjs"), url];
  if (healthUrl) args.push(healthUrl);
  spawn(process.execPath, args, { cwd: root, detached: true, stdio: "ignore" }).unref();
}

// ---------------------------------------------------------------- 生产模式
async function runStart() {
  const url = `http://localhost:${PORT}`;
  const igUrl = IG_PORT ? `http://localhost:${IG_PORT}` : "";

  say();
  say("  ======================================");
  say("    Uranus iMessage");
  say("  ======================================");
  say(`  控制台在 ${PORT}：API 和页面都在这`);
  if (IG_PORT) say(`  Instagram 单独在 ${IG_PORT}：打开就是 IG，同一个后端`);
  say();

  say(`  [1/4] Node.js ${process.version}`);

  if (!(await ensureDeps("[2/4] "))) return 1;

  // 端口：本项目已经在跑就别重复启动，直接把页面打开
  const r = await checkPort(PORT);
  if (r.mine) {
    say("  [3/4] 服务已经在跑了，直接打开页面");
    if (!noBrowser) {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    }
    say();
    say("        要重启的话，先去原来那个窗口按 Ctrl+C");
    await sleep(3000);
    return 0;
  }
  if ((await ensurePort(PORT, { allowMine: false, label: "[3/4] " })) === "abort") return 1;
  // IG 那个端口腾不出来不算致命：后端会记一条警告然后照常跑，只是 6873 上
  // 没有页面。为这个把整个控制台拦下来不值当
  if (IG_PORT && (await ensurePort(IG_PORT, { allowMine: false, label: "      " })) !== "ok") {
    say(`      Instagram 端口 ${IG_PORT} 这次用不了，控制台照常启动`);
  }

  // 前端产物
  const nb = needsBuild();
  if (nb.stale) {
    say(`  [4/4] 前端有改动（${nb.reason}），重新构建...`);
    if ((await npm(["run", "build"])) !== 0) {
      say();
      say("  [X] 构建失败，看上面的报错");
      return 1;
    }
  } else {
    say("  [4/4] 前端产物是最新的");
  }

  say();
  say(rule);
  say(`    控制台     ${url}`);
  if (igUrl) say(`    Instagram  ${igUrl}`);
  say("    停止       在本窗口按 Ctrl+C");
  say(rule);
  say();

  openWhenReady(url);
  const code = await supervise();
  say();
  say("  服务已停止");
  return code;
}

/**
 * 守护循环：服务用约定的退出码退出时，就地再拉起一次。
 *
 * 「重启整个项目」（控制台按钮和 `/重启` 指令）就是这么实现的 —— 后端
 * `process.exit(RESTART_EXIT_CODE)`，这里看到那个码就重来一遍。不在 Node
 * 进程内部做热重载，是因为需要重启的场合恰恰是「有东西卡住了」，同一个进程
 * 里重载的话卡住的东西照样卡着。
 *
 * 循环写在这儿而不是 .bat 里：启动.bat 只跑一次 `node scripts/launch.mjs`
 * 然后 pause，而且它必须保持纯 ASCII（cmd.exe 解析含中文的批处理会串行），
 * 加不了带中文提示的循环。
 *
 * `URANUS_SUPERVISOR=1` 是给后端看的信号：**有人接盘**，退出之后会被拉起来。
 * 没有这个变量的话（用户自己 `npm start`）后端会拒绝重启请求并说明原因 ——
 * 点一下按钮就把服务弄没了比不能重启糟得多。
 *
 * 只认这一个码。真崩溃（1）、Ctrl+C（130/3221225786）都照旧退出，不然一个
 * 起不来的服务会在这里无限重启刷屏。
 */
async function supervise() {
  // ⚠ 和 server/src/restart.js 的 RESTART_EXIT_CODE 是同一个约定，改要一起改
  const RESTART_EXIT_CODE = 75;
  for (;;) {
    const code = await npm(["start"], { env: { URANUS_SUPERVISOR: "1" } });
    if (code !== RESTART_EXIT_CODE) return code;
    say();
    say(rule);
    say("    收到重启请求，正在重新启动服务...");
    say(rule);
    say();
    // 喘一口：上一个进程的端口要等系统真正释放，抢在前面起会撞 EADDRINUSE
    await sleep(1200);
  }
}

process.exitCode = await runStart();