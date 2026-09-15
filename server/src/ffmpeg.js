/**
 * ffmpeg 在哪，以及怎么跑它。
 *
 * 这个文件存在的唯一理由：**原来有三处各自找一遍 ffmpeg**（media.js 两处、
 * igimage.js 一处），三份逻辑各写各的，改一处漏一处是迟早的事。现在都来这里拿。
 *
 * ── 三级查找顺序 ──
 *
 *  1. `FFMPEG_BIN`：显式指定的路径。VPS 上自己装了系统 ffmpeg 但不想改 PATH 时用。
 *  2. `ffmpeg-static`：包内那个静态二进制。**Windows 用户走这条** —— 装依赖时
 *     它自己下好了，双击启动就能用，不需要额外装任何东西。
 *  3. PATH 上的 `ffmpeg`：Linux 上 `apt install ffmpeg` 装出来的那个。
 *
 * ── 为什么要有第 3 级 ──
 *
 * `ffmpeg-static` 的 install 脚本要联网下几十 MB 的二进制（而且是 glibc 版，
 * Alpine 上直接装不上）。以前它装不上，整个功能就废了 —— 因为代码只认它导出的
 * 那个路径。加上第 3 级之后，VPS 上 `apt install -y ffmpeg` 就够了，
 * 不用设任何环境变量、不用改 systemd unit。
 *
 * **第 3 级返回的是「ffmpeg」这个光名字**，由操作系统去 PATH 里翻。所以它可能
 * 仍然不存在 —— spawn 会抛 `ENOENT`。这就是 `ffmpegPath()` 要在真的跑一次之前
 * 先探一下的原因：探不到就返回空串，让调用方走原来那套「降级」分支
 * （语音条显示 0 秒、原格式送去识别），而不是扔出一个没人接的异常。
 *
 * 顺带一提，spectrum 自己也是这么干的（@spectrum-ts/core 的 authoring.js：
 * 拿不到 ffmpeg-static 就用 PATH 上的 `ffmpeg`）。
 */

import { spawn, spawnSync } from "node:child_process";

/** 显式指定的优先。设了这个就不用再往下找。 */
const ENV_VAR = "FFMPEG_BIN";

/**
 * 探到的结果缓存。
 *
 * `undefined` = 还没探过，`""` = 探过且没有。模块级缓存是安全的：ffmpeg 在这
 * 个进程活着的时候不会自己装上或卸掉。
 */
let cached;

/**
 * 找一个能用的 ffmpeg 可执行文件。
 *
 * @returns {Promise<string>} 路径；**空串表示这台机器上没有 ffmpeg**，
 *   调用方应当降级而不是报错
 */
export async function ffmpegPath() {
  if (cached !== undefined) return cached;
  cached = await resolve();
  return cached;
}

async function resolve() {
  // 显式指定就是显式指定：设了就照用，不去探它能不能跑、也不往下兜底。
  // 探了反而危险 —— 用户以为在用系统 ffmpeg，实际被我们悄悄换成包里的那个
  const explicit = String(process.env[ENV_VAR] ?? "").trim();
  if (explicit) return explicit;

  // 包内的静态二进制。包不在（用户删了依赖）或者没有对应架构的二进制时，
  // 导出的是 null / 空串 —— 都当成「没有」继续往下找
  try {
    const { default: bundled } = await import("ffmpeg-static");
    if (bundled && isRunnable(bundled)) return bundled;
  } catch {
    /* 包不在就当没这回事 */
  }

  // 最后退到 PATH。`which` 那步不是洁癖：不探的话，没有 ffmpeg 的机器上
  // spawn 会抛 ENOENT，而调用方接的是「退出码非 0」，两条路不一样
  if (isOnPath("ffmpeg")) return "ffmpeg";

  return "";
}

/**
 * 这个路径能不能真的执行。
 *
 * 用 `--version` 而不是只看文件存不存在：包目录里可能躺着一个下载中断留下的
 * 半截文件，`statSync` 看着有、跑起来报 exec format error。
 */
function isRunnable(bin) {
  try {
    const r = spawnSync(bin, ["-version"], { stdio: "ignore", timeout: 5000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * PATH 上有没有这个名字。
 *
 * `where` 是 Windows 的、`which` 是 POSIX 的，两个都试 —— 反正只在第一次
 * 调用时跑一次。
 */
function isOnPath(name) {
  const probe = process.platform === "win32" ? "where" : "which";
  try {
    const r = spawnSync(probe, [name], { stdio: "ignore", timeout: 5000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * 跑一次 ffmpeg，拿到退出码和 stderr。
 *
 * ffmpeg 什么都往 stderr 写（进度、流信息、报错），所以 stdout 直接丢掉。
 * **永不抛错** —— 启动失败也归一成 `code: -1`，调用方只需要看退出码。
 *
 * @param {string} bin ffmpegPath() 给的那个路径
 * @param {string[]} args 参数
 * @returns {Promise<{code: number, stderr: string}>}
 */
export async function runFfmpeg(bin, args) {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let text = "";
    proc.stderr.on("data", (c) => {
      text += String(c);
    });
    // ENOENT（路径压根不存在）走的是 error 而不是 close，这里接住
    proc.on("error", (e) => resolve({ code: -1, stderr: String(e?.message ?? e) }));
    proc.on("close", (c) => resolve({ code: c ?? -1, stderr: text }));
  });
}
