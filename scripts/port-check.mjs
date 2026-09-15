/**
 * 查一个端口上有没有人，以及是不是本项目自己。
 *
 * 可以当模块用（launch.mjs 就是这么用的），也可以直接命令行跑：
 *   node scripts/port-check.mjs 8787
 * 会打印 KEY=VALUE 四行，方便别的脚本消费。
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** 端口上跑的是不是本项目。 */
export async function isMine(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return false;
    const body = await res.json().catch(() => null);
    return body?.service === "uranus-imessage";
  } catch {
    return false;
  }
}

/** 监听该端口的 PID 集合（netstat 会把 IPv4/IPv6 各列一行，这里去重）。 */
export function listeningPids(port) {
  let out = "";
  try {
    out = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
  } catch {
    return [];
  }

  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    const cols = line.trim().split(/\s+/);
    const local = cols[1] ?? "";
    // 只认端口号完全相等的，别让 :8787 匹配到 :87870
    if (local.slice(local.lastIndexOf(":") + 1) !== String(port)) continue;
    const pid = cols[cols.length - 1];
    if (pid && pid !== "0") pids.add(pid);
  }
  return [...pids];
}

/** PID → 进程名。 */
export function nameOf(pid) {
  try {
    const out = execFileSync("tasklist", ["/fi", `PID eq ${pid}`, "/nh", "/fo", "csv"], {
      encoding: "utf8",
    });
    return out.split('","')[0]?.replace(/^"/, "").trim() || `PID ${pid}`;
  } catch {
    return `PID ${pid}`;
  }
}

/** 一次问清楚：空闲吗？是自己人吗？占用者是谁？ */
export async function checkPort(port) {
  const mine = await isMine(port);
  const pids = listeningPids(port);
  return { mine, free: pids.length === 0, pids, names: pids.map(nameOf) };
}

// 直接被 node 跑起来时才输出，被 import 时保持安静
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.argv[2] ?? 8787);
  const r = await checkPort(port);
  console.log(`MINE=${r.mine ? 1 : 0}`);
  console.log(`FREE=${r.free ? 1 : 0}`);
  console.log(`PIDS=${r.pids.join(",")}`);
  console.log(`NAMES=${r.names.join(",")}`);
}