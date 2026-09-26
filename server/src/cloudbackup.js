/**
 * 完整备份包的**打包和解包**。云备份和「导出完整备份到本地」用的是同一种包，
 * 所以这两条路共用这个文件（名字是历史遗留 —— 当初只有云那一条）。
 *
 * 这个文件不碰网络 —— 网络在 cloud/s3.js 和 cloud/github.js 里，两家的差异
 * 挡在那一层，这边只认「一个 .tar.gz 文件」。
 *
 * 包共用带来一个实际好处：云端拉下来的那份能用界面上「从备份恢复」手动选，
 * 本地导出的那份也能手动传上云盘再从云端列表里恢复。所以报错文案里不说
 * 「云备份快照」，说「备份包」 —— 用户手上那个包很可能是本地导的。
 *
 * 同样的道理，日志的 scope 分两种：两条路共用的那几段（挑文件、打包、解包、
 * 留 .bak）打「备份」，只有云那条会走到的（上传、下载、清理旧快照、删快照）
 * 才打「云备份」。本地导出时日志里冒出一行「[云备份]」会让人以为它偷偷联网了。
 *
 * 和另外两套导出的分工：
 *   backup.js   整份**配置**一份 JSON，用户手动下载（换机器、留快照）
 *   transfer.js 单件递出去（一份预设、一本世界书、一个角色的记忆库）
 *   这个文件    整个 data/ 的选定部分打成 tar.gz，**传到云上或者下载到本地**
 *
 * backup.js 那套只有配置，硬盘挂了、data/ 误删了，聊出来的聊天记录和记忆库
 * 就没了 —— 重建不了。这个文件是为那件事存在的，两个出口：
 *
 *   传到云上   runBackup / runRestore，异地副本，要先配 S3 或 GitHub
 *   下载到本地 packSnapshot + ALL_SCOPES（见 index.js 的 /api/backup/full），
 *              不用配任何东西，浏览器直接存盘。想要「完整备份」的人多半
 *              先要这个，云那套是给「异地 + 定时」的。
 *
 * ── 三块范围 ──
 *
 * 按 data/ 下的实际目录切成三块，界面上分别勾（见 SCOPES）：
 *   config  配置（角色、人设、预设、世界书、壁纸设置）  ~50KB
 *   chats   聊天与记忆（存档、记忆库、Instagram）        ~31MB
 *   images  表情包与参考图                              ~91MB
 *
 * images 默认**不勾**：它比另外两块加起来大两倍，而且是用户自己往里放的图
 * （丢了能再放一遍），不像记忆库那样是聊出来的、独一无二的东西。
 *
 * ── 密钥 ──
 *
 * `data.config.json` 里是明文的 API key、Photon 凭据、天气/搜索/TTS 凭据，
 * 外加云备份自己的凭据。默认**整个文件不进包**，由用户显式勾选才带 ——
 * 和 backup.js 一样的规矩。
 *
 * 不勾的时候恢复端读不到这个文件，`config.js:mergeSecrets` 就会保留本地
 * 现有的凭据，正好是想要的行为：拿一份不含密钥的快照恢复，不会把本机的
 * key 冲掉。
 *
 * ── 不进包的东西 ──
 *
 *  - `*.bak` / `*.bak.json`：`memorystore.js:backupPathFor` 造的那些。
 *    它们是「上一次生成用的输入」，恢复时没意义，白占体积。
 *  - `*.tmp`：原子写的中间文件（`writeAtomic`），撞上正在写的那一刻会进包。
 *  - `assets/`：随代码发的内置素材，压根不在 data/ 里。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";

import { driverFor, describeTarget } from "./cloud/index.js";
import { DATA_DIR, ensureLayout } from "./datadir.js";
import { logDebug, logInfo, logWarn } from "./logs.js";
import { backupPathFor } from "./memorystore.js";

/**
 * 三块范围，值是 data/ 下的**相对路径**（文件或目录都行）。
 *
 * 顺序有意义：界面上按这个顺序排，体积从小到大。
 *
 * `wallpapers/settings.json` 单独列而不是整个 `wallpapers/` —— 那个目录里
 * 还有用户上传的壁纸图片，属于「图片」不属于「配置」，而 settings.json 里
 * 只有「用哪张、遮罩多浓」，几十个字节。壁纸图片一张都不进包（内置的两张
 * 在 assets/ 里跟着代码走，自己传的丢了再传一遍就是）。
 */
export const SCOPES = {
  config: {
    label: "配置",
    paths: [
      "config.json",
      "characters",
      "user",
      "presets",
      "worlds",
      "wallpapers/settings.json",
    ],
  },
  chats: {
    label: "聊天与记忆",
    // 小红书只带 state.json（水位 + 流水）：secrets.json 是令牌，不能跟着
    // 「聊天与记忆」上网；media/ 是发完就删的暂存图
    paths: ["sessions", "memories", "instagram", "xiaohongshu/state.json"],
  },
  images: {
    label: "表情包与参考图",
    paths: ["images"],
  },
};

/** 勾了密钥才带的那一个文件。 */
const SECRET_REL = "data.config.json";

/**
 * 三块全勾。
 *
 * 「导出完整备份到本地」用它 —— 那个动作的语义就是「把 data/ 整个带走」，
 * 没有勾选界面，所以这里写死。images 在云备份里默认不勾（91MB，传网上心疼），
 * 但存本地没这个顾虑，全带。
 */
export const ALL_SCOPES = Object.fromEntries(Object.keys(SCOPES).map((k) => [k, true]));

/** 包里那份清单的文件名。解包时靠它知道这个包带了哪几块。 */
const MANIFEST = "uranus-backup.json";

const APP = "uranus-imessage";
const KIND = "cloudsnapshot";
const VERSION = 1;

/** 快照文件名的样子：`uranus-data-20260913-1830.tar.gz`。 */
const NAME_RE = /^uranus-data-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\.tar\.gz$/;

/* ================= 名字 ================= */

/**
 * 快照文件名。和 backup.js:bundleFileName 同一个时间戳格式（到分钟）——
 * 用户在云端控制台里看到的两种备份文件名该是一个调子。
 */
export function snapshotName(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}`;
  return `uranus-data-${stamp}.tar.gz`;
}

/**
 * 文件名 → 那一刻的 Date，认不出来返回 null。
 *
 * 列表排序和保留策略都靠这个，**不靠云端返回的修改时间**：GitHub 那条路
 * 拿到的是 release 的创建时间，S3 那条是对象的 LastModified，两家的语义
 * 和精度都不一样。名字是我们自己起的，最可靠。
 *
 * 到分钟就够了：同一分钟内点两次「立即备份」会撞名，那种情况下第二次
 * 覆盖第一次是合理的（用户显然是觉得刚才那次没成）。
 */
export function parseSnapshotName(name) {
  const m = NAME_RE.exec(String(name ?? "").trim());
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  const at = new Date(y, mo - 1, d, h, mi, 0, 0);
  // 20261398-9999 这种数字合法但日期不存在的，Date 会自己滚到下个月，
  // 滚过头的一律不认 —— 那不是我们生成的名字
  if (at.getMonth() !== mo - 1 || at.getDate() !== d) return null;
  return at;
}

/**
 * 按保留份数算出**该删哪些**（返回名字数组，最老的在前）。
 *
 * 只对认得出时间的名字排序；认不出的一律留着不动 —— 桶里/仓库里可能有
 * 别人放的东西，云备份不该去删自己不认识的文件。
 *
 * @param {string[]} names 云端现有的快照名
 * @param {number} keep 保留最近几份（至少 1）
 */
export function planPrune(names, keep) {
  const limit = Math.max(1, Math.floor(Number(keep) || 1));
  const dated = [];
  for (const name of names ?? []) {
    const at = parseSnapshotName(name);
    if (at) dated.push({ name, at: at.getTime() });
  }
  // 新的在前，切掉前 limit 份，剩下的就是要删的
  dated.sort((a, b) => b.at - a.at);
  return dated.slice(limit).map((d) => d.name).reverse();
}

/* ================= 选中的文件 ================= */

/** 这几种一律不进包，理由见文件头。 */
function skipped(name) {
  return (
    name.endsWith(".tmp") ||
    name.endsWith(".bak") ||
    /\.bak\.[^.]+$/.test(name) // 记忆库那批 `<角色>.bak.json`
  );
}

/**
 * 把勾选的范围摊成一串 data/ 下的相对路径（只含**真实存在**的）。
 *
 * 目录会走进去逐个文件列出来，不是只给目录名 —— tar-fs 的 `entries` 要的是
 * 具体条目，而且这样才能在打包**之前**就知道有多少个文件、多大，界面上
 * 「这个包大概多大」不用等传完才知道。
 *
 * @param {{config?: boolean, chats?: boolean, images?: boolean}} scopes
 * @param {{includeSecrets?: boolean}} opts
 * @returns {{entries: string[], bytes: number, missing: string[]}}
 */
export function collectEntries(scopes, { includeSecrets = false } = {}) {
  const picked = [];
  for (const [key, scope] of Object.entries(SCOPES)) {
    if (scopes?.[key]) picked.push(...scope.paths);
  }
  if (includeSecrets) picked.push(SECRET_REL);

  const entries = [];
  const missing = [];
  let bytes = 0;

  const walk = (rel) => {
    const full = path.join(DATA_DIR, rel);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      return false; // 不存在
    }
    if (st.isDirectory()) {
      let names;
      try {
        names = fs.readdirSync(full);
      } catch (e) {
        logWarn("备份", `${rel} 读不出来，这个目录跳过`, e);
        return true;
      }
      // 空目录也算「存在」，只是没东西可打包
      for (const name of names) {
        if (skipped(name)) continue;
        walk(path.posix.join(rel, name));
      }
      return true;
    }
    if (st.isFile()) {
      if (skipped(path.basename(rel))) return true;
      entries.push(rel);
      bytes += st.size;
      return true;
    }
    return true; // 符号链接之类的，算存在但不打包
  };

  for (const rel of picked) {
    if (!walk(rel)) missing.push(rel);
  }
  return { entries, bytes, missing };
}

/* ================= 打包 ================= */

/** 临时目录，照 media.js 那个写法。调用方负责 finally 里删掉。 */
async function tmpDir() {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), "uranus-cloud-"));
}

/** 删掉整个临时目录，失败只告警 —— 系统重启时 tmp 自己会清。 */
async function dropTmp(dir) {
  if (!dir) return;
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
  } catch (e) {
    logWarn("备份", "临时文件没删掉，重启后系统会自己清", e);
  }
}

/**
 * 把选中的范围打成一个 .tar.gz，落在临时目录里。
 *
 * 返回的 `file` 用完**必须** `cleanup()` —— 91MB 的包留在 tmp 里堆着不像话。
 * 调用方的形状是：
 *
 *     const snap = await packSnapshot(scopes, opts);
 *     try { ...上传 snap.file... } finally { await snap.cleanup(); }
 *
 * 压缩级别取 6（zlib 默认）而不是 9：这里最大的两块是 JPEG/PNG（表情包）和
 * 已经很密的 JSON，9 换来的体积差不到 1%，但 CPU 时间翻倍 —— 服务还要同时
 * 回消息，不值得。
 *
 * @param {object} scopes 三块的勾选状态
 * @param {{includeSecrets?: boolean}} opts
 */
export async function packSnapshot(scopes, { includeSecrets = false } = {}) {
  ensureLayout();
  const { entries, bytes, missing } = collectEntries(scopes, { includeSecrets });
  if (!entries.length) {
    throw new Error("选中的范围里一个文件都没有，没什么可备份的");
  }
  logDebug("备份", `选中 ${entries.length} 个文件、${humanBytes(bytes)}`);
  /*
   * 勾了但盘上没有的路径以前是**完全静默**跳过的 —— 勾了「聊天与记忆」而
   * `instagram/` 压根不存在（没用过那个功能）的时候，包里少一块，日志里
   * 一个字都没有。不是错误，但用户该知道。
   */
  if (missing.length) {
    logDebug("备份", `这几块勾了但盘上没有，跳过：${missing.join("、")}`);
  }
  /*
   * 文件数**先存下来**：tar-fs 把传进去的 entries 当队列用，边打边
   * `queue.shift()`（node_modules/tar-fs/index.js:21 的 statAll），而且是直接
   * 拿我们这个数组用、不复制。打完之后 `entries.length` 就是 0 了。
   * 下面传副本进去，这个数组留给自己。
   */
  const fileCount = entries.length;

  const dir = await tmpDir();
  const name = snapshotName();
  const file = path.join(dir, name);

  try {
    // tar-fs 是传递依赖里就有的（server/package.json 里也显式声明了）。
    // 动态 import 是为了让这个模块能被离线测试直接 import 而不必装依赖 ——
    // 纯函数那几个（snapshotName / planPrune / collectEntries）不需要它。
    const { default: tar } = await import("tar-fs");

    const manifest = {
      app: APP,
      kind: KIND,
      version: VERSION,
      exportedAt: new Date().toISOString(),
      includesSecrets: Boolean(includeSecrets),
      scopes: Object.fromEntries(
        Object.keys(SCOPES).map((k) => [k, Boolean(scopes?.[k])])
      ),
      files: fileCount,
      rawBytes: bytes,
    };
    /*
     * 清单不落盘，直接当一个额外条目塞进包里。
     *
     * tar-fs 只打**一个根目录**下的东西，而清单不该写进 data/（那会脏了
     * 用户的目录，还得记着删）。所以走 `finalize: false` + `finish` 钩子：
     * tar 把 data/ 里选中的那些打完之后不收尾，我们手动 `pack.entry()`
     * 追加清单，再自己 finalize。
     */
    const pack = tar.pack(DATA_DIR, {
      entries: entries.slice(), // 副本：见上面 fileCount 那段
      // dereference: 符号链接按它指向的内容打包。用户可能把 images/ 指到
      // 别的盘上，那种情况下打包链接本身等于什么都没备份
      dereference: true,
      finalize: false,
      finish(p) {
        const text = JSON.stringify(manifest, null, 2);
        p.entry({ name: MANIFEST, size: Buffer.byteLength(text) }, text);
        p.finalize();
      },
    });

    await pipeline(
      pack,
      zlib.createGzip({ level: 6 }),
      fs.createWriteStream(file)
    );

    const packed = (await fs.promises.stat(file)).size;
    return {
      file,
      name,
      bytes: packed,
      rawBytes: bytes,
      entries: fileCount,
      missing,
      manifest,
      cleanup: () => dropTmp(dir),
    };
  } catch (e) {
    await dropTmp(dir);
    throw e;
  }
}

/* ================= 解包 ================= */

/**
 * 一个 .tar.gz → 摊回 data/。
 *
 * 语义和现有的两套导入对齐（backup.js、transfer.js）：**包里有的那几块
 * 整体替换，包里没有的一个字节都不动**。所以拿一份只勾了「配置」的快照
 * 恢复，聊天记录和记忆库全都留着。
 *
 * 「整体替换」是按**范围**算的，不是按文件：包里带了 config 这一块，那么
 * `characters/` 就整个换成包里那批 —— 本地多出来的角色会没掉。这是恢复
 * 该有的语义（合并会留下重名条目，而且角色的预设/世界书引用会指到不确定
 * 的地方，backup.js 的注释里写过同一件事）。
 *
 * 两条例外：
 *  - 覆盖 `config.json` / `data.config.json` 之前留一份 `.bak`（和记忆库
 *    「覆盖之前先备份」同一条规矩，用的也是同一个 `backupPathFor`）
 *  - `wallpapers/` 只换 settings.json，用户上传的壁纸图片不动 —— 包里
 *    压根没带它们，整个目录清掉等于把图删了
 *
 * 先解到临时目录再搬，不直接往 data/ 里解：包传到一半断了、或者 gzip 是
 * 坏的，直接解会把 data/ 留在一个半新半旧的状态上。
 *
 * @param {string} tarPath 本地的 .tar.gz
 * @returns {{manifest: object, applied: string[], files: number}}
 */
export async function unpackSnapshot(tarPath) {
  ensureLayout();
  const dir = await tmpDir();
  const staged = path.join(dir, "staged");

  try {
    const { default: tar } = await import("tar-fs");
    await fs.promises.mkdir(staged, { recursive: true });
    await pipeline(
      fs.createReadStream(tarPath),
      zlib.createGunzip(),
      /*
       * 解到 staged 而不是直接进 data/，理由见上面那段。
       *
       * 路径穿越（`../../etc/passwd` 这种）不用自己防：tar-fs 的 extract
       * 对每个条目都算 `path.join(cwd, path.join('/', header.name))`，
       * 那个 `path.join('/', ...)` 会把开头的 `..` 吃掉，条目落不出 cwd；
       * 硬链接和符号链接另外走 `inCwd` 校验。这里再写一遍反而会让人以为
       * 少了它就不安全。
       *
       * 真正在意的是**链接**：一个包里如果有指向 data/ 外面的符号链接，
       * 解出来是链接本身（tar-fs 不跟着写），但接下来 `restorePath` 的
       * `cpSync` 会把它照搬进 data/，之后程序读写那个路径就写到外面去了。
       * 打包时 `dereference: true` 让我们自己造的包里压根没有链接条目，
       * 这里再把漏网的挡掉。
       */
      tar.extract(staged, {
        ignore: (_name, header) =>
          header?.type === "symlink" || header?.type === "link",
      })
    );

    const manifest = readManifest(staged);
    const applied = [];
    let files = 0;

    for (const [key, scope] of Object.entries(SCOPES)) {
      if (!manifest.scopes?.[key]) continue;
      for (const rel of scope.paths) {
        files += restorePath(staged, rel);
      }
      applied.push(scope.label);
    }

    if (manifest.includesSecrets) {
      files += restorePath(staged, SECRET_REL);
      applied.push("密钥");
    }

    return { manifest, applied, files };
  } finally {
    await dropTmp(dir);
  }
}

/**
 * 读包里那份清单。
 *
 * 没有清单的包**不认**：那意味着这不是这个程序造的快照，猜着解只会把
 * data/ 弄成一团。老版本的包一定有（VERSION 从 1 开始就写了它）。
 */
function readManifest(staged) {
  const file = path.join(staged, MANIFEST);
  if (!fs.existsSync(file)) {
    throw new Error("这个包里没有 uranus-backup.json，不是本程序的备份包");
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    throw new Error("包里的 uranus-backup.json 读不出来，文件可能传坏了");
  }
  if (raw?.app !== APP || raw?.kind !== KIND) {
    throw new Error("这不是 Uranus iMessage 的备份包");
  }
  if (Number(raw.version) > VERSION) {
    throw new Error(
      `这个包是更新版本（v${raw.version}）的程序打出来的，当前版本读不了，先升级程序`
    );
  }
  if (!raw.scopes || typeof raw.scopes !== "object") {
    throw new Error("包里的清单缺了 scopes，文件不完整");
  }
  return raw;
}

/**
 * 把 staged 里的一条路径搬到 data/ 对应位置，返回搬了几个文件。
 *
 * 目录是**整体替换**：先删掉 data/ 里那个目录再拷过来。所以本地多出来的
 * 条目会没掉 —— 见 unpackSnapshot 那段注释。
 *
 * 包里没有这一条时什么都不做（返回 0）。比如老快照里没有
 * `wallpapers/settings.json`，那本地那份就该留着。
 */
function restorePath(staged, rel) {
  const from = path.join(staged, rel);
  const to = path.join(DATA_DIR, rel);
  if (!fs.existsSync(from)) return 0;

  const st = fs.statSync(from);
  fs.mkdirSync(path.dirname(to), { recursive: true });

  if (st.isDirectory()) {
    // 整体替换：`.bak` 不在包里，删掉重来会把它们一起清掉，所以先数一下
    // 现有的 .bak 留在原地 —— 记忆库的备份是用户的安全网，不能被恢复吃掉
    const keep = stashBaks(to);
    fs.rmSync(to, { recursive: true, force: true });
    copyTree(from, to);
    restoreBaks(to, keep);
    return countFiles(to);
  }

  // 单个文件：config.json / data.config.json / wallpapers/settings.json。
  // 覆盖前留一份 .bak，和记忆库同一条规矩、同一个函数
  if (fs.existsSync(to)) {
    try {
      fs.copyFileSync(to, backupPathFor(to));
    } catch (e) {
      logWarn("备份", `${rel} 的 .bak 没留成，继续恢复`, e);
    }
  }
  fs.copyFileSync(from, to);
  return 1;
}

/**
 * 递归拷一个目录。只用 `mkdirSync` + `copyFileSync` 两个原语。
 *
 * **不用 `fs.cpSync(..., { recursive: true })`** —— 那个在这台机器上
 * （Node v22 / Windows）对目录直接抛 `EIO: Access is denied`，不管目标
 * 存不存在。探过了：`mkdirSync` 和单文件的 `copyFileSync` 都好好的，坏的
 * 只有 `cpSync` 内部那条 `cpSyncCopyDir` 的路。恢复是「点一下就整块替换」
 * 的动作，不能赌某个 Node 版本的目录拷贝能不能用。
 *
 * 软链接跳过：解包时 `tar.extract` 已经把 symlink/hardlink 条目滤掉了，
 * 这里再挡一道 —— 拷贝时跟着链接走会把 data/ 外面的东西拉进来。
 */
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) copyTree(src, dst);
    else if (e.isFile()) fs.copyFileSync(src, dst);
  }
}

/**
 * 把一个目录里的 `.bak` 全读进内存，等目录重建完再写回去。
 *
 * 记忆库的 `.bak` 是「上一次总结用的输入」，用户翻回去看过去发生了什么全靠
 * 它。恢复是「整体替换」，不这么捞一把的话它们会跟着 `rmSync` 一起没掉 ——
 * 而它们压根不在包里（打包时被 `skipped` 排掉了），删了就真没了。
 *
 * 读进内存而不是搬到临时目录：`.bak` 都是文本（JSON、记忆流水），几十 KB
 * 到几 MB，data/memories 整个也才 30M，其中 .bak 只占一小部分。
 */
function stashBaks(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const walk = (cur) => {
    let names;
    try {
      names = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (skipped(e.name) && !e.name.endsWith(".tmp")) {
        try {
          out.push({ rel: path.relative(dir, full), data: fs.readFileSync(full) });
        } catch {
          /* 读不出来就算了，本来也是个备份 */
        }
      }
    }
  };
  walk(dir);
  return out;
}

/** 把 stashBaks 捞出来的写回去。已经存在的不覆盖（包里带了同名的更该留）。 */
function restoreBaks(dir, stash) {
  for (const { rel, data } of stash) {
    const to = path.join(dir, rel);
    if (fs.existsSync(to)) continue;
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, data);
    } catch {
      /* 写不回去不该让整个恢复失败 */
    }
  }
}

/** 数一个目录里有多少文件（递归）。回执上那个「恢复了几个文件」用。 */
function countFiles(dir) {
  let n = 0;
  const walk = (cur) => {
    let names;
    try {
      names = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names) {
      if (e.isDirectory()) walk(path.join(cur, e.name));
      else n += 1;
    }
  };
  walk(dir);
  return n;
}

/* ================= 说人话 ================= */

/** 体积。日志和界面都用这个，两边的说法要一致。 */
export function humanBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)}KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)}MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

/** 勾了哪几块，写进日志和回执。 */
export function scopeLabels(scopes, includeSecrets = false) {
  const out = [];
  for (const [key, scope] of Object.entries(SCOPES)) {
    if (scopes?.[key]) out.push(scope.label);
  }
  if (includeSecrets) out.push("密钥");
  return out;
}

/** 清单里记的那份「包了什么」，恢复前的确认框用。 */
export function describeManifest(manifest) {
  return {
    exportedAt: String(manifest?.exportedAt ?? ""),
    includesSecrets: Boolean(manifest?.includesSecrets),
    scopes: scopeLabels(manifest?.scopes, manifest?.includesSecrets),
    files: Number(manifest?.files) || 0,
    rawBytes: Number(manifest?.rawBytes) || 0,
  };
}

/* ================= 整条流程 ================= */

/**
 * 备份一次：打包 → 上传 → 按保留份数清理旧的。
 *
 * 手动点按钮和定时器走的是**这同一个函数** —— 和 maintenance.js 里
 * `clearCaches` 那条注释同一个理由：复制一份出来早晚会走岔，用户看到的
 * 日志和实际清掉的东西都该和手点没有区别。
 *
 * 清理排在上传**之后**：反过来的话上传失败时旧快照已经删了，用户手里
 * 一份都不剩。而且只有上传成功才说明「新的这份是好的」。
 *
 * 清理失败**不算整件事失败**：包已经在云上了，备份的目的达成了，最多是
 * 云端多留几份旧的。这一点和 clearCaches 里删野图那步同一个处理。
 *
 * @param {object} cloudBackup 配置里那一整块
 * @param {string} why 记进日志的来路（「控制台」/「定时」）
 */
export async function runBackup(cloudBackup, why = "控制台") {
  const { label, driver, settings } = driverFor(cloudBackup);
  const scopes = cloudBackup?.scopes ?? {};
  const includeSecrets = Boolean(cloudBackup?.includeSecrets);

  /*
   * 下面这一串 logDebug 是「后台到底在干什么」的主线。
   *
   * 一条也不打凭据：`describeTarget` 本来就是为「能给人看的目标」存在的
   * （见 cloud/index.js），`scopeLabels` 出来的是「配置、聊天与记忆」这种
   * 中文标签。HTTP 请求那一层的 debug 在 cloud/net.js 里，不用在这儿重复。
   */
  logDebug(
    "云备份",
    `${why}开始：目标 ${describeTarget(cloudBackup)}，范围 ` +
      `${scopeLabels(scopes, includeSecrets).join("、") || "（一块都没勾）"}`
  );

  // 凭据不全就别费劲打包了 —— 91MB 打完才发现桶名没填很蠢
  driver.normalize(settings);

  const t0 = Date.now();
  const snap = await packSnapshot(scopes, { includeSecrets });
  try {
    logDebug("云备份", `打包用了 ${Date.now() - t0}ms，临时文件 ${snap.file}`);
    logPacked(snap, why);

    const t1 = Date.now();
    await driver.put(settings, snap.name, snap.file, snap.bytes);
    logDebug("云备份", `上传用了 ${Date.now() - t1}ms`);

    const where = describeTarget(cloudBackup);
    if (includeSecrets) {
      logWarn(
        "云备份",
        `${why}已上传 ${snap.name}（${humanBytes(snap.bytes)}）到 ${where}，` +
          "**这份包里有明文密钥**，确认那个位置只有你能访问"
      );
    } else {
      logInfo("云备份", `${why}已上传 ${snap.name}（${humanBytes(snap.bytes)}）到 ${where}`);
    }

    const pruned = await pruneOld(cloudBackup, driver, settings);
    return {
      name: snap.name,
      bytes: snap.bytes,
      rawBytes: snap.rawBytes,
      entries: snap.entries,
      scopes: scopeLabels(scopes, includeSecrets),
      provider: label,
      pruned,
    };
  } finally {
    await snap.cleanup();
  }
}

/** 按 `keep` 删掉最老的那几份。失败只告警，理由见 runBackup。 */
async function pruneOld(cloudBackup, driver, settings) {
  const keep = Number(cloudBackup?.keep) || 7;
  const pruned = [];
  try {
    const existing = await driver.list(settings);
    const plan = planPrune(existing.map((s) => s.name), keep);
    /*
     * 这一条 debug 是为了让「它到底判断了什么」看得见。原来只有真删了东西
     * 才 logInfo 一句 —— 云端攒了十份、`keep` 是 7、结果一份没删的时候，
     * 用户压根看不出这一步跑过没有。
     */
    logDebug(
      "云备份",
      `清理判断：云端 ${existing.length} 份、保留最近 ${keep} 份，` +
        `该删 ${plan.length ? plan.join("、") : "0 份"}`
    );
    for (const name of plan) {
      await driver.del(settings, name);
      pruned.push(name);
    }
    if (pruned.length) {
      logInfo("云备份", `按「保留最近 ${keep} 份」清掉了旧快照：${pruned.join("、")}`);
    }
  } catch (e) {
    logWarn("云备份", "清理旧快照时出错（新的那份已经传上去了）", e);
  }
  return pruned;
}

/**
 * 从云端恢复一份：下载 → 解包 → 摊回 data/。
 *
 * 收尾的 `syncBridges` 不在这儿做 —— 那是 index.js 的事（这个文件不该
 * import imessage.js，会把打包逻辑和桥接绑在一起）。
 */
export async function runRestore(cloudBackup, name) {
  const { driver, settings } = driverFor(cloudBackup);
  driver.normalize(settings);

  const dir = await tmpDir();
  try {
    const file = path.join(dir, "snapshot.tar.gz");
    const bytes = await driver.get(settings, name, file);
    logInfo("云备份", `已下载 ${name}（${humanBytes(bytes)}），开始恢复`);

    const result = await unpackSnapshot(file);
    logInfo(
      "云备份",
      `已从 ${name} 恢复：${result.applied.join("、")}，共 ${result.files} 个文件。` +
        "被覆盖的 config.json 在同目录留了一份 .bak"
    );
    return { ...result, name, bytes };
  } finally {
    await dropTmp(dir);
  }
}

/** 云端现有的快照，带上从文件名解出来的时间。界面上那个列表用。 */
export async function listSnapshots(cloudBackup) {
  const { driver, settings } = driverFor(cloudBackup);
  driver.normalize(settings);
  const items = await driver.list(settings);
  return items
    .map((s) => ({ ...s, at: parseSnapshotName(s.name)?.getTime() ?? 0 }))
    .sort((a, b) => b.at - a.at); // 新的在前
}

/** 删一份。界面上每行那个「删除」。 */
export async function removeSnapshot(cloudBackup, name) {
  const { driver, settings } = driverFor(cloudBackup);
  driver.normalize(settings);
  await driver.del(settings, name);
  logInfo("云备份", `已删除云端快照 ${name}`);
}

/** 打包完记一条日志。手动和定时走同一句，两边的说法不该有出入。 */
export function logPacked(snap, why) {
  logInfo(
    "云备份",
    `${why}打好包 ${snap.name}：${snap.entries} 个文件、` +
      `${humanBytes(snap.rawBytes)} 压到 ${humanBytes(snap.bytes)}`
  );
}
