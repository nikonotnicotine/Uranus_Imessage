/**
 * 「群聊消息到底有没有进这条线路」的一次性诊断。
 *
 * 用户在群里发了消息，VPS 控制台什么都没出现，连 DEBUG 也没有。代码层面
 * 我们**没有任何地方过滤群聊**（imessage.js 的消息循环只拦 outbound /
 * 非本 provider / 重复，@spectrum-ts/imessage 的 toMessageItem 也只看
 * isFromMe，buildMessageBase 还会老老实实给群消息打上 space.type="group"）。
 * 所以「收不到」只可能坏在更前面 —— Photon 那头。
 *
 * 实机跑出来的答案是：**共享线路按「登记号 ↔ 线路号」成对路由**。
 * 不带 chatGuid 的调用（listRecent / chats.count）直接被拒：
 *
 *   No instance routed for this request — check that the chatGuid format is
 *   valid (expected "any;-;+1234567890")
 *
 * 带了本项目登记号的单聊 guid 就通；带别的项目的登记号会被拒成
 * `Target not allowed for this project`。也就是说共享档下每条线路只认
 * `any;-;<自己登记的那个号>` 这**一个**会话，群聊的 `any;+;<群标识>`
 * 压根不在它的路由表里 —— 群消息不是被我们丢掉的，是从来没被投递过来。
 *
 * 这个脚本把那次验证固化下来，只读，绕开整条桥：
 *  1. 问管理 API 要这个项目登记了哪些用户（拿到「该配哪个 guid」）；
 *  2. 用登记号的单聊 guid 调 chats.get / listInChat —— 通，证明凭据和线路是好的；
 *  3. 调不带 guid 的 chats.count —— 被拒，证明共享档没有「这条线路的全部会话」这个概念；
 *  4. 开一条消息事件流听一会儿，把收到的每个 chatGuid 标出单聊还是群（`;+;`）。
 *     这一步是留给未来的：哪天 Photon 放开了共享档的群聊，这里就会冒出 ★群★。
 *
 * 只读：只调 chats.get / messages.listInChat / chats.count / subscribeEvents，
 * 不发消息、不改任何东西、不碰运行中的桥。
 *
 *   node scripts/diag-group.mjs [听多少秒，默认 0 不听]
 */

import fs from "node:fs";
import path from "node:path";

import { closeClients, createLineClients } from "../server/src/photongrpc.js";

const WATCH_SEC = Number(process.argv[2]) || 0;
const DATA = path.resolve("data");
const PHOTON_BASE = "https://spectrum.photon.codes";

const cfg = JSON.parse(fs.readFileSync(path.join(DATA, "data.config.json"), "utf8"));
const projects = (cfg.projects ?? []).filter((p) => p.mode === "cloud" && p.projectId && p.projectSecret);
if (!projects.length) {
  console.error("data.config.json 里没有可用的云端项目");
  process.exit(2);
}

/** 群聊的 chatGuid 第三段是 chat 标识而不是地址：`服务;+;标识`（见 chatbg.js 的同一套判断）。 */
const isGroupGuid = (guid) => String(guid ?? "").includes(";+;");

/** 号码只留后 4 位 —— 诊断输出经常要贴给别人看。 */
const mask = (s) => String(s ?? "").replace(/\d(?=\d{4})/g, "*");

/** 正文里的换行会把这一行日志冲垮，截短并压成一行。 */
const clip = (s, n = 40) => {
  const one = String(s ?? "").replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
};

/** 这个项目登记了哪些用户。走管理 REST（和 photon.js 同一个接口，只是这里要全量）。 */
async function enrolledUsers(project) {
  // Basic auth 那串 base64 就是明文凭据，绝不能进输出（见 photon.js 的同一条规矩）
  const auth = Buffer.from(`${project.projectId}:${project.projectSecret}`).toString("base64");
  const res = await fetch(`${PHOTON_BASE}/projects/${project.projectId}/users/`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const users = body?.data?.users ?? body?.data ?? [];
  return (Array.isArray(users) ? users : [])
    .filter((u) => u?.phoneNumber)
    .map((u) => ({ phone: u.phoneNumber, line: u.assignedPhoneNumber ?? "" }));
}

for (const project of projects) {
  console.log(`\n=== 项目 ${project.id}（线路 ${mask(project.linePhone) || "?"}）===`);

  let enrolled = [];
  try {
    enrolled = await enrolledUsers(project);
    console.log(
      `  登记用户 ${enrolled.length} 个：` +
        (enrolled.map((u) => `${mask(u.phone)} → 线路 ${mask(u.line)}`).join(" | ") || "(空)")
    );
  } catch (e) {
    console.log(`  查登记用户失败（${String(e?.message ?? e)}），下面只能用 myPhone 试`);
    if (project.myPhone) enrolled = [{ phone: project.myPhone, line: project.linePhone ?? "" }];
  }

  let opened = [];
  try {
    opened = await createLineClients(project.projectId, project.projectSecret, { timeout: 30_000 });
    for (const { client, address } of opened) {
      console.log(`--- ${address} ---`);

      // 1) 不带 chatGuid 的调用：共享档下预期被拒。这一步是整个诊断的关键证据 ——
      //    「这条线路的全部会话」在共享档里不是一个可寻址的东西，所以也就无从
      //    投递一个我们没配对过的群会话。
      try {
        console.log(`  chats.count()（不带 guid）→ ${await client.chats.count()}`);
      } catch (e) {
        console.log(`  chats.count()（不带 guid）被拒：${String(e?.message ?? e)}`);
      }

      // 2) 逐个登记号试单聊 guid：通 = 凭据和线路都好，问题只在「群不在路由表里」
      for (const u of enrolled) {
        const dm = `any;-;${u.phone}`;
        try {
          const chat = await client.chats.get(dm);
          const who = (chat.participants ?? []).map((x) => mask(x.address)).filter(Boolean);
          console.log(
            `  ✓ ${mask(dm)}  isGroup=${chat.isGroup} service=${chat.service} ` +
              `未读=${chat.unreadCount ?? "?"} 成员=${who.join(",") || "(空)"}`
          );
          const page = await client.messages.listInChat(dm, { pageSize: 5 });
          for (const m of page?.messages ?? []) {
            const c = m?.content ?? {};
            console.log(
              `      [${m.isFromMe ? "发出" : "收到"}] itemType=${m.itemType} ` +
                `附件=${(c.attachments ?? []).length} balloon=${c.balloonBundleId || "无"} ` +
                `正文=${c.text ? `「${clip(c.text)}」` : "(空)"}`
            );
          }
        } catch (e) {
          console.log(`  ✗ ${mask(dm)} → ${String(e?.message ?? e)}`);
        }
      }

      // 3) 听一会儿事件流。默认不听（WATCH_SEC=0）；给个秒数就边听边在群里发，
      //    看有没有 ★群★ 冒出来。哪天 Photon 放开共享档的群聊，这一步会第一时间看见。
      if (WATCH_SEC > 0) {
        console.log(`  订阅 ${WATCH_SEC} 秒 —— 现在去群里发一条`);
        const stream = client.messages.subscribeEvents();
        const timer = setTimeout(() => stream.close?.(), WATCH_SEC * 1000);
        let n = 0;
        try {
          for await (const ev of stream) {
            n += 1;
            const guid = ev?.message?.chatGuids?.[0] ?? ev?.chatGuid ?? "(无)";
            console.log(
              `    [${new Date().toLocaleTimeString("zh-CN")}] ${ev.type} ` +
                `${isGroupGuid(guid) ? "★群★" : "单聊"} guid=${mask(guid)} ` +
                `from=${mask(ev?.message?.sender?.address ?? "-")} ` +
                `itemType=${ev?.message?.itemType ?? "-"} ` +
                `正文=${clip(ev?.message?.content?.text ?? "")}`
            );
          }
        } catch (e) {
          console.log(`    事件流出错：${String(e?.message ?? e)}`);
        } finally {
          clearTimeout(timer);
        }
        if (!n) console.log("    这段时间里一个事件都没来（群消息也没有）");
      }
    }
  } catch (e) {
    console.log(`  开客户端失败：${String(e?.message ?? e)}`);
  } finally {
    await closeClients(opened);
  }
}
