/**
 * 「100M 宽带，下一张几 MB 的图为什么要几分钟」的一次性诊断。
 *
 * **只读，不发消息、不改任何东西**：
 *
 *  1. 量一元调用的往返（RTT 参照物）；
 *  2. 上传一份随机字节量**上行**速度 —— 上传出来的附件不挂在任何消息上，
 *     对面看不到，服务端那边它永远停在 `transferState: pending`；
 *  3. 从 `events.catchUp(0)` 回放的历史事件里捞真实的入站附件 guid
 *     （查询类接口 listRecent / listInChat / chats.count 在共享线路上都报
 *     "No instance routed"，catchUp 是唯一能只读拿到 guid 的口子）；
 *  4. 把那个附件下回来，记每一块的大小和到达间隔。
 *
 * 要回答的是「13KB/s 这个数是谁造成的」，几种形态分得很开：
 *
 *   - 上行快、下行慢 → 不是带宽、不是链路，是下行这条路自己的毛病
 *   - 块大、每隔一段长间隔才来一批 → HTTP/2 流控窗口（吞吐 ≈ 窗口/RTT）
 *   - 块小、间隔稳定在一个 RTT 上下 → 每块都在等一次往返
 *   - 块大小和间隔都稳、乘起来正好是观测速度 → 服务端在限速
 *
 *   node scripts/diag-attach-speed.mjs [上行测试用多少 MB，默认 4]
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { patchHttp2Window } from "../server/src/http2window.js";
import { closeClients, createLineClients } from "../server/src/photongrpc.js";

// 和正式运行时一致
await patchHttp2Window();

const MB = Number(process.argv[2]) || 4;
const DATA = path.resolve("data");

const cfg = JSON.parse(fs.readFileSync(path.join(DATA, "data.config.json"), "utf8"));
const project = (cfg.projects ?? []).find((p) => p.mode === "cloud" && p.projectId && p.projectSecret);
if (!project) {
  console.error("data.config.json 里没有可用的云端项目");
  process.exit(2);
}

const ms = (n) => `${Number(n).toFixed(0)}ms`;
const kb = (n) => `${(n / 1024).toFixed(1)}KB`;
const pct = (a, p) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
};
const sum = (a) => a.reduce((x, y) => x + y, 0);

let opened = [];
try {
  let t = Date.now();
  opened = await createLineClients(project.projectId, project.projectSecret, { timeout: 60_000 });
  console.log(`开客户端（含铸 token）：${ms(Date.now() - t)}`);
  const { client, address } = opened[0];
  console.log(`线路 ${address}\n`);

  // 一元往返。调用被服务端拒了也没关系 —— 要量的是一来一回要多久
  const rtts = [];
  for (let i = 0; i < 5; i += 1) {
    const t0 = Date.now();
    try {
      await client.chats.count();
    } catch {
      /* 共享线路上这个调用会被拒，但往返已经走完 */
    }
    rtts.push(Date.now() - t0);
  }
  console.log(`一元往返（5 次）：${rtts.map(ms).join("  ")}  中位 ${ms(pct(rtts, 0.5))}`);

  // ── 上行 ──
  const payload = crypto.randomBytes(MB * 1024 * 1024);
  t = Date.now();
  const up = await client.attachments.upload({ data: payload, fileName: `speedtest-${Date.now()}.bin` });
  const upMs = Date.now() - t;
  console.log(
    `\n上行：${MB}MB 用了 ${ms(upMs)} = ${(payload.length / 1024 / (upMs / 1000)).toFixed(0)}KB/s` +
      `（guid ${String(up?.attachment?.guid ?? "").slice(0, 16)}…，没挂消息，对面看不到）`
  );

  // ── 找一个真实的入站附件 ──
  console.log("\n从历史事件里找真实附件…");
  const cands = [];
  const scan = client.events.catchUp(0);
  let seen = 0;
  try {
    for await (const ev of scan) {
      seen += 1;
      const s = JSON.stringify(ev);
      for (const m of s.matchAll(/"guid":"(spc-att-[0-9a-f-]+)"/g)) {
        if (!cands.includes(m[1])) cands.push(m[1]);
      }
      if (cands.length >= 12 || seen > 4000) break;
    }
  } catch {
    /* 流自己结束了 */
  }
  await scan.close().catch(() => {});
  console.log(`  扫了 ${seen} 个事件，拿到 ${cands.length} 个候选`);

  // 挑第一个下得动、且够大的（太小的量不出速度）
  let picked = null;
  for (const guid of cands) {
    try {
      const info = await client.attachments.get(guid);
      const bytes = Number(info?.totalBytes ?? 0);
      console.log(`  ${guid.slice(0, 20)}…  ${kb(bytes)}  ${info?.mimeType || "(无 mime)"}  ${info?.transferState}`);
      // 挑 1～4MB 的：太小量不出速度，太大的在慢线路上要等很久
      if (bytes > 1024 * 1024 && bytes < 4 * 1024 * 1024 && !picked) picked = { guid, bytes, name: info?.fileName };
    } catch (e) {
      console.log(`  ${guid.slice(0, 20)}…  取不到：${String(e?.message ?? e).slice(0, 50)}`);
    }
  }
  if (!picked) {
    console.log("\n没有能下载的大附件，下行量不了");
    process.exit(0);
  }

  // ── 下行 ──
  console.log(`\n下行：${picked.name ?? "?"}  ${kb(picked.bytes)}`);
  const frames = client.attachments.downloadStream(picked.guid);
  const start = Date.now();
  let firstByteAt = 0;
  let got = 0;
  let prev = 0;
  const marks = [];
  // 慢线路上别闷着：每 5 秒报一次进度，90 秒还没下完就停
  let lastReport = start;
  const giveUp = setTimeout(() => frames.close().catch(() => {}), 90_000);
  for await (const frame of frames) {
    if (frame.type !== "primaryChunk") continue;
    const now = Date.now();
    if (!firstByteAt) {
      firstByteAt = now;
      prev = now;
    }
    marks.push({ at: now - start, gap: now - prev, size: frame.data.length });
    prev = now;
    got += frame.data.length;
    if (now - lastReport >= 5000) {
      lastReport = now;
      console.log(`  +${ms(now - start)} 已下 ${kb(got)}`);
    }
  }
  clearTimeout(giveUp);
  await frames.close().catch(() => {});

  const total = Date.now() - start;
  const transferSecs = Math.max(0.001, (Date.now() - firstByteAt) / 1000);
  console.log(`  第一个字节：${ms(firstByteAt - start)}`);
  console.log(`  下完：${kb(got)}，总 ${ms(total)}，传输段 ${(got / 1024 / transferSecs).toFixed(0)}KB/s`);

  const sizes = marks.map((m) => m.size);
  const gaps = marks.slice(1).map((m) => m.gap);
  console.log(`  块数：${marks.length}`);
  if (sizes.length) {
    console.log(
      `  块大小：中位 ${kb(pct(sizes, 0.5))}  最小 ${kb(Math.min(...sizes))}  最大 ${kb(Math.max(...sizes))}`
    );
  }
  if (gaps.length) {
    console.log(
      `  块间隔：中位 ${ms(pct(gaps, 0.5))}  p90 ${ms(pct(gaps, 0.9))}  最大 ${ms(Math.max(...gaps))}`
    );
    const stalls = gaps.filter((g) => g >= 500);
    console.log(
      `  间隔 ≥500ms：${stalls.length} 次，合计 ${ms(sum(stalls))}（占总时长 ${((sum(stalls) / total) * 100).toFixed(0)}%）`
    );
    console.log("\n  前 10 块：");
    for (const m of marks.slice(0, 10)) console.log(`    +${ms(m.at)}  ${kb(m.size)}  （距上块 ${ms(m.gap)}）`);
  }
} catch (e) {
  console.log(`出错：${String(e?.stack ?? e)}`);
} finally {
  await closeClients(opened);
}
process.exit(0);
