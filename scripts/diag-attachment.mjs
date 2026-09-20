/**
 * 「表情包发出去变成文件」的一次性诊断。
 *
 * **只读**：把线路上最近的消息拉出来，看每个附件在 chat.db 里的
 * `uti` / `mime_type` / `file_name` / `transfer_state`。Apple 那头决定一个附件
 * 是图片气泡还是灰色文件图标，靠的就是那个 `uti` —— 拿到它就知道是哪一步歪的。
 *
 * 不发消息、不上传、不改任何东西。
 *
 *   node scripts/diag-attachment.mjs [条数]
 */

import fs from "node:fs";
import path from "node:path";

import { closeClients, createLineClients } from "../server/src/photongrpc.js";

const LIMIT = Number(process.argv[2]) || 200;
const DATA = path.resolve("data");

const cfg = JSON.parse(fs.readFileSync(path.join(DATA, "data.config.json"), "utf8"));
const projects = (cfg.projects ?? []).filter((p) => p.mode === "cloud" && p.projectId && p.projectSecret);
if (!projects.length) {
  console.error("data.config.json 里没有可用的云端项目");
  process.exit(2);
}

for (const project of projects) {
  console.log(`\n=== 项目 ${project.id}（线路 ${project.linePhone ?? "?"}）===`);
  let opened = [];
  try {
    opened = await createLineClients(project.projectId, project.projectSecret, { timeout: 30_000 });
    for (const { client, address } of opened) {
      console.log(`--- ${address} ---`);
      let page;
      try {
        page = await client.messages.listRecent({ limit: LIMIT });
      } catch (e) {
        console.log(`  listRecent 失败：${String(e?.message ?? e)}`);
        continue;
      }
      const msgs = page?.messages ?? [];
      console.log(`  拉到 ${msgs.length} 条消息`);
      let n = 0;
      for (const m of msgs) {
        const atts = m?.content?.attachments ?? m?.attachments ?? [];
        for (const a of atts) {
          n += 1;
          console.log(
            `  [${m.isFromMe ?? m.isOutgoing ? "发出" : "收到"}] ` +
              `name=${a.fileName}  mime=${a.mimeType || "(空)"}  uti=${a.uti || "(空)"}  ` +
              `bytes=${a.totalBytes}  state=${a.transferState}  sticker=${a.isSticker}`
          );
        }
      }
      if (!n) console.log("  这批消息里没有附件");
    }
  } catch (e) {
    console.log(`  开客户端失败：${String(e?.message ?? e)}`);
  } finally {
    await closeClients(opened);
  }
}
