/*
 * 开发用的沙箱后端：**不碰用户真实的 data/，也不连 iMessage 桥**。
 *
 * 为什么要单独有这么一个：Instagram 这套东西要在浏览器里一眼一眼看
 * （九宫格、管理态、快拍、精选），可 `npm start` 起的是真后端 ——
 * 它会读真的 data/（里面有真 API key、Photon 凭据、聊天记录），还会把
 * 阿瑞 和 米洛 那两条真号码接上线。为了看一眼界面就把人家的号上线，
 * 而且随手点一下「保存」就写进真配置，这不合适。
 *
 * 所以这里：
 *   URANUS_DATA_DIR → .sandbox/     （假数据，删了重跑就有）
 *   IMESSAGE_BRIDGE=off             （不连号）
 *   端口 8788 / 5174                 （真应用是 8787 / 5173）
 *
 * 跑法：npm run dev:sandbox         然后开 http://localhost:5174
 *      （预览面板里就是 .claude/launch.json 的 "sandbox" 那条）
 *
 * 端口故意错开：真应用开着的时候这个也能跑，不用为了看一眼界面把人家
 * 正连着号的后端停掉。Vite 那边的 /api 代理跟着 URANUS_API 走（见
 * client/vite.config.js），没设就还是指向 8787 的真后端。
 * 网页端口读 PORT（预览面板会设它），后端端口读 SANDBOX_API_PORT ——
 * 反过来的话预览面板一设 PORT，后端就会把网页那个端口先占了。
 *
 * Vite 是这个脚本自己 spawn 的，不走 concurrently —— 那两个环境变量得
 * 传给 Vite，而 `FOO=bar npm run …` 这种写法在 Windows 的 cmd 里不成立。
 *
 * 第一次跑会往 .sandbox/ 里塞一套假数据：两个开了 Instagram 的角色、
 * 几条帖子和快拍、一个精选、两条互动记录。**只在空目录时塞** —— 你在
 * 界面上改的东西留得住，想推倒重来就把 .sandbox/ 删掉。
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SANDBOX = path.join(ROOT, ".sandbox");
// PORT 归界面用 —— 预览面板按 launch.json 里的端口设这个变量，它等的是网页
const WEB_PORT = process.env.PORT || "5174";
const API_PORT = process.env.SANDBOX_API_PORT || "8788";

process.env.URANUS_DATA_DIR = SANDBOX;
process.env.IMESSAGE_BRIDGE = "off";
process.env.PORT = API_PORT;
// IG 那个端口也得让开：真应用正占着 6873，沙箱后端再去 listen 一次就撞上了。
// 沙箱里看 IG 页走 Vite 的 http://localhost:5174/instagram.html —— 那是现编的，
// 比 dist 里的新
process.env.URANUS_IG_PORT = "off";

/* ------------------------------------------------------------------ */
/* 造图：一张横向渐变的 PNG。                                          */
/*                                                                     */
/* 不用真照片是有意的 —— 沙箱得自带全部内容，不能指望谁的硬盘上有图。   */
/* 渐变比纯色有用：object-fit: cover 裁没裁对、删除按钮压在浅色那半边   */
/* 还看不看得见，纯色看不出来。                                        */
/* ------------------------------------------------------------------ */
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) : crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** node 18 没有 zlib.crc32，自己算一遍。 */
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function gradientPng(w, h, from, to) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let p = 0;
  for (let y = 0; y < h; y += 1) {
    raw[p] = 0; // 每行开头的 filter 字节
    p += 1;
    for (let x = 0; x < w; x += 1) {
      const t = (x / (w - 1) + y / (h - 1)) / 2;
      raw[p] = Math.round(from[0] + (to[0] - from[0]) * t);
      raw[p + 1] = Math.round(from[1] + (to[1] - from[1]) * t);
      raw[p + 2] = Math.round(from[2] + (to[2] - from[2]) * t);
      p += 3;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 每通道 8 位
  ihdr[9] = 2; // 真彩色，不带 alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ */
/* 假数据                                                              */
/* ------------------------------------------------------------------ */

const ROLE_A = "r-sandbox-aki";
const ROLE_B = "r-sandbox-ren";

/** 一个角色文件。只填沙箱里看得见的字段，其余让服务端补默认值。 */
function character(id, name, description, instagram) {
  return {
    id,
    name,
    description,
    projectRef: "",
    maxContext: 15,
    dropCount: 0,
    worldBookRefs: [],
    instagram,
    proactive: { enabled: false },
  };
}

function seed() {
  fs.mkdirSync(path.join(SANDBOX, "characters"), { recursive: true });

  fs.writeFileSync(
    path.join(SANDBOX, "config.json"),
    JSON.stringify({ providers: [], chat: { separator: "$" } }, null, 2)
  );

  fs.writeFileSync(
    path.join(SANDBOX, "characters", "01-Aki.json"),
    JSON.stringify(
      character(ROLE_A, "Aki", "沙箱角色，用来看 Instagram 界面。", {
        enabled: true,
        autoPublish: true,
        replyWindow: { minMinutes: 30, maxMinutes: 120 },
        likeChance: 45,
        replyChance: 60,
        peers: [ROLE_B],
        maxChain: 2,
        recordPeer: true,
      }),
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(SANDBOX, "characters", "02-Ren.json"),
    JSON.stringify(
      character(ROLE_B, "Ren", "沙箱角色之二，用来试角色之间的互动。", {
        enabled: true,
        autoPublish: false,
        replyWindow: { minMinutes: 30, maxMinutes: 120 },
        likeChance: 45,
        replyChance: 60,
        peers: [],
        maxChain: 2,
        recordPeer: true,
      }),
      null,
      2
    )
  );
}

/** 往 IG 那几个目录里塞内容。要等 ensureLayout 建完目录才能调。 */
async function seedInstagram() {
  const store = await import("../server/src/igstore.js");

  const palettes = [
    [[236, 72, 153], [59, 130, 246]],
    [[250, 204, 21], [239, 68, 68]],
    [[34, 197, 94], [14, 165, 233]],
    [[168, 85, 247], [251, 146, 60]],
    [[15, 23, 42], [148, 163, 184]],
    [[244, 244, 245], [161, 161, 170]], // 浅的这张专门用来看删除按钮压不压得住
  ];
  const files = palettes.map(([a, b]) =>
    store.saveMedia(gradientPng(640, 640, a, b).toString("base64"), "png")
  );

  const hour = 3600 * 1000;
  const now = Date.now();

  // profile 里显示名那个字段叫 name（不是 displayName）；三个计数存的是字符串
  store.writeProfile("user", {
    name: "你",
    username: "you_sandbox",
    bio: "沙箱里的自己。编辑主页那八个字段就是改这儿。",
    link: "https://example.com",
    posts: "128",
    followers: "3,402",
    following: "271",
  });
  store.writeProfile("Aki", {
    name: "Aki",
    username: "aki.jpg",
    bio: "沙箱角色。发帖和改帖子都在控制台的 Instagram 分区。",
    verified: true,
    followers: "1.2万",
    following: "301",
  });
  store.writeProfile("Ren", { name: "Ren", username: "ren_0", bio: "沙箱角色之二。" });

  // Aki 的帖子：一张图 / 多张图 / 纯文字 / 只有描述没生成图，四种都摆出来
  store.addPost("Aki", {
    caption: "今天的海。",
    images: [{ file: files[0], alt: "傍晚的海面" }],
    createdAt: new Date(now - 2 * hour).toISOString(),
    likes: ["user"],
    // 评论的时间字段叫 at，不是 createdAt
    comments: [
      { id: "c1", owner: "user", text: "这张好看", at: new Date(now - hour).toISOString() },
      {
        id: "c2",
        owner: "Aki",
        text: "谢谢！",
        replyTo: "c1",
        at: new Date(now - 30 * 60 * 1000).toISOString(),
      },
    ],
  });
  store.addPost("Aki", {
    caption: "一组。",
    images: [
      { file: files[1], alt: "黄昏" },
      { file: files[2], alt: "早上" },
      { file: files[3], alt: "夜里" },
    ],
    createdAt: new Date(now - 26 * hour).toISOString(),
  });
  store.addPost("Aki", {
    caption: "没有图的一条，就想说句话。",
    images: [],
    createdAt: new Date(now - 50 * hour).toISOString(),
  });
  store.addPost("Aki", {
    caption: "生图关着的时候长这样。",
    images: [{ file: "", alt: "一只猫趴在窗台上，外面在下雨，玻璃上全是水痕" }],
    createdAt: new Date(now - 72 * hour).toISOString(),
  });
  store.addPost("Ren", {
    caption: "浅色的图，用来看删除按钮。",
    images: [{ file: files[5], alt: "浅灰渐变" }],
    createdAt: new Date(now - 5 * hour).toISOString(),
  });
  const mine = store.addPost("user", {
    caption: "自己发的一条。",
    images: [{ file: files[4], alt: "深色渐变" }],
    createdAt: new Date(now - 8 * hour).toISOString(),
    likes: ["Aki", "Ren"],
  });

  // 快拍：活的 + 过期的各来几条，好试「往期快拍」那一栏
  store.addStory("Aki", {
    caption: "在路上",
    image: { file: files[2], alt: "路上" },
    createdAt: new Date(now - 3 * hour).toISOString(),
  });
  const old = store.addStory("Aki", {
    caption: "",
    image: { file: files[3], alt: "夜里" },
    createdAt: new Date(now - 40 * hour).toISOString(),
  });
  store.addStory("user", {
    caption: "自己的快拍",
    image: { file: files[1], alt: "黄昏" },
    createdAt: new Date(now - hour).toISOString(),
  });

  // 精选：先放一个（里面装那条已经过期的快拍 —— 精选的用处就是留住过期的），
  // 剩下两个格子空着，好试「最多三个」和那个 + 号
  store.writeHighlights("Aki", [
    { id: store.newId("h"), owner: "Aki", title: "海", cover: files[0], storyIds: [old.id] },
  ]);

  // 右上角那个爱心页面：只记别人对**用户**帖子的互动
  store.addActivity({
    kind: "like",
    actor: "Aki",
    target: { owner: "user", postId: mine.id },
    text: "赞了你的帖子",
    at: new Date(now - 20 * 60 * 1000).toISOString(),
  });
  store.addActivity({
    kind: "comment",
    actor: "Ren",
    target: { owner: "user", postId: mine.id },
    text: "这张不错",
    at: new Date(now - 90 * 60 * 1000).toISOString(),
  });
}

/* ------------------------------------------------------------------ */

const fresh = !fs.existsSync(path.join(SANDBOX, "characters"));
if (fresh) {
  console.log(`[沙箱] 第一次跑，正在造假数据 → ${SANDBOX}`);
  seed();
}

const { ensureLayout } = await import("../server/src/datadir.js");
ensureLayout();
if (fresh) await seedInstagram();

console.log(`[沙箱] 数据目录 ${SANDBOX}（不是真的 data/），iMessage 桥已关`);
await import("../server/src/index.js");

/* Vite。环境变量得由这边传进去，所以自己 spawn 而不是交给 concurrently。 */
const web = spawn(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["--workspace", "client", "run", "dev", "--", "--port", WEB_PORT, "--strictPort"],
  {
    cwd: ROOT,
    stdio: "inherit",
    // Windows 上 npm 是个 .cmd，Node 20 之后不给 shell 就 spawn EINVAL
    shell: process.platform === "win32",
    env: { ...process.env, PORT: WEB_PORT, URANUS_API: `http://localhost:${API_PORT}` },
  }
);

console.log(`[沙箱] 界面 http://localhost:${WEB_PORT}  ←→  后端 :${API_PORT}`);
console.log(`[沙箱] Instagram 页 http://localhost:${WEB_PORT}/instagram.html`);

// Vite 挂了就别让后端自己在那儿空转，不然下次起会撞端口
web.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    web.kill();
    process.exit(0);
  });
}
