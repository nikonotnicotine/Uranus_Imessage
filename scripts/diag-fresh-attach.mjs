/**
 * 「刚发来的图」和「早就在 Photon 上的图」下载速度一样吗 —— 一次性诊断。
 *
 * **只读**：盯着线路的历史事件，等一张新附件出现，立刻下载并记录每块的节奏，
 * 下完再下一遍做对照。不回消息、不改任何东西。
 *
 * 区分两种情况：
 *   - 第一遍慢、第二遍快 → Photon 是边从 Apple 取边推，慢在回源，和我们怎么收无关
 *   - 两遍都快           → 我们这边没问题，问题在跑桥接的那台机器（代码没更新 / 网络）
 *   - 两遍都慢           → 这台机器到 Photon 的下行有问题
 *
 *   node scripts/diag-fresh-attach.mjs [最多等几分钟，默认 10]
 */

import fs from "node:fs";
import path from "node:path";

import { patchHttp2Window } from "../server/src/http2window.js";
import { mintLines } from "../server/src/photongrpc.js";

await patchHttp2Window();
const { createGrpcClient } = await import("@photon-ai/advanced-imessage/grpc");

const WAIT_MIN = Number(process.argv[2]) || 10;
const cfg = JSON.parse(fs.readFileSync(path.resolve("data/data.config.json"), "utf8"));
const project = (cfg.projects ?? []).find((p) => p.mode === "cloud" && p.projectId && p.projectSecret);
const { lines } = await mintLines(project.projectId, project.projectSecret);
const L = lines[0];
const client = createGrpcClient({ address: L.address, tls: true, retry: true, token: async () => L.token });

const stamp = () => new Date().toTimeString().slice(0, 8);

async function scanGuids() {
  const out = [];
  const scan = client.events.catchUp(0);
  const stop = setTimeout(() => scan.close().catch(() => {}), 60_000);
  try {
    for await (const ev of scan) {
      for (const m of JSON.stringify(ev).matchAll(/"guid":"(spc-att-[0-9a-f-]+)"/g)) {
        if (!out.includes(m[1])) out.push(m[1]);
      }
    }
  } catch {
    /* 流结束 */
  }
  clearTimeout(stop);
  await scan.close().catch(() => {});
  return out;
}

async function download(guid, label) {
  const t0 = Date.now();
  let got = 0;
  let first = 0;
  let prev = 0;
  const gaps = [];
  let lastReport = t0;
  try {
    const fr = client.attachments.downloadStream(guid);
    for await (const f of fr) {
      if (f.type !== "primaryChunk") continue;
      const now = Date.now();
      if (!first) {
        first = now - t0;
        prev = now;
      } else {
        gaps.push(now - prev);
        prev = now;
      }
      got += f.data.length;
      if (now - lastReport > 5000) {
        lastReport = now;
        console.log(`  ${stamp()} ${label} 进度 ${(got / 1024).toFixed(0)}KB`);
      }
    }
    await fr.close();
  } catch (e) {
    console.log(`  ${label} 中途出错（下到 ${(got / 1024).toFixed(0)}KB，${Date.now() - t0}ms）：${String(e?.message ?? e).slice(0, 80)}`);
    return;
  }
  const tot = Date.now() - t0;
  const sorted = [...gaps].sort((a, b) => a - b);
  const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  console.log(
    `>>> ${label}：${(got / 1024).toFixed(0)}KB  首字节 ${first}ms  总 ${tot}ms  ` +
      `传输段 ${(got / 1024 / Math.max(0.001, (tot - first) / 1000)).toFixed(0)}KB/s  ` +
      `块数 ${gaps.length + 1}  块间隔中位 ${med}ms`
  );
}

console.log(`${stamp()} 线路 ${project.linePhone}，先记下现有附件…`);
const known = new Set(await scanGuids());
console.log(`${stamp()} 现有 ${known.size} 个。现在可以给 ${project.linePhone} 发图了，最多等 ${WAIT_MIN} 分钟`);

const deadline = Date.now() + WAIT_MIN * 60_000;
let target = null;
while (!target && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3000));
  for (const g of await scanGuids()) {
    if (known.has(g)) continue;
    known.add(g);
    try {
      const info = await client.attachments.get(g);
      console.log(`${stamp()} 新附件：${info.fileName}  ${(Number(info.totalBytes) / 1024).toFixed(0)}KB  ${info.transferState}`);
      if (Number(info.totalBytes) > 300 * 1024) target = g;
    } catch (e) {
      console.log(`${stamp()} 新附件 ${g.slice(0, 20)}… 取信息失败：${String(e?.message ?? e).slice(0, 60)}`);
    }
  }
}

if (!target) {
  console.log("没等到新的大附件");
  process.exit(0);
}
await download(target, "第一遍（刚发来的）");
await download(target, "第二遍（Photon 上已经有了）");
await client.close?.();
process.exit(0);
