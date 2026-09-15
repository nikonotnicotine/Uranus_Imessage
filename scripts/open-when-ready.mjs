/**
 * 等后端起来了再开浏览器，免得开出一个「无法访问」的页面。
 *
 * 用法: node scripts/open-when-ready.mjs <url> [healthUrl] [超时秒数]
 *
 * 探测 /api/health，等到它回 {"ok":true} 再打开页面；
 * 超时就直接打开（服务可能起来了只是 health 没通），不阻塞启动流程。
 */
import { spawn } from "node:child_process";

const url = process.argv[2];
const health = process.argv[3] ?? new URL("/api/health", url).toString();
const timeoutSec = Number(process.argv[4] ?? 45);

if (!url) {
  console.error("用法: node scripts/open-when-ready.mjs <url> [healthUrl] [超时秒数]");
  process.exit(2);
}

function open(target) {
  if (process.platform === "win32") {
    // start 是 cmd 内建命令；第一个空参数是窗口标题占位，不然带引号的 url 会被当标题
    spawn("cmd", ["/c", "start", "", target], { detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", [target], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [target], { detached: true, stdio: "ignore" }).unref();
  }
}

const deadline = Date.now() + timeoutSec * 1000;

while (Date.now() < deadline) {
  try {
    const res = await fetch(health, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const body = await res.json().catch(() => null);
      if (body?.ok) {
        open(url);
        process.exit(0);
      }
    }
  } catch {
    /* 还没起来，接着等 */
  }
  await new Promise((r) => setTimeout(r, 600));
}

// 等超时了也把页面打开，让用户自己看是什么情况
open(url);
process.exit(0);