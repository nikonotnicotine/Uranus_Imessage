/**
 * 插件：扫 data/plugins/、校验、把前端入口送给浏览器、装/卸/开关。
 *
 * ── 这是什么 ──
 *
 * 一个插件 = data/plugins/<id>/ 下的一个文件夹，里面必须有 manifest.json。
 * 插件代码**不跑在后端**：这一版只支持前端插件（client.js + style.css），
 * 由浏览器 `import()` 进去。服务端插件（在 Node 进程里跑）这一版不做 ——
 * 那等于把整台机器交出去（data.config.json 里全是明文 key），门槛要另算。
 *
 * 插件从哪来：用户自己从 GitHub 下载 zip，在控制台里导入。市场
 * （github.com/nikonotnicotine/uranus-plugins）只是一份**链接目录** ——
 * 它不托管代码，控制台也不会自动下载任何东西。所以这个文件里没有任何
 * 「从 URL 安装」的路：装插件永远要用户自己拿到 zip、自己点导入。
 *
 * ── 三个安全阀 ──
 *
 * 插件能做的事和控制台自己一样多（同源、能读页面上的 key、能调任何 /api），
 * 所以：
 *
 *  1. **总开关默认关**。装了插件也得用户自己去开那个开关。
 *  2. **`?noplugins` 安全模式**（前端那半，见 client/src/plugins.jsx）：插件把
 *     控制台写崩了，网址后面加一下就能进去关掉它。和 `?nocss` 一个道理 ——
 *     那条路栽过，所以这条一开始就有。
 *  3. **一个插件坏掉不拖垮别的**：manifest 读不出来、id 对不上文件夹名、
 *     入口文件不存在，这些都只让那一个插件 `broken`，照常列出来告诉用户
 *     哪儿不对，其余照常加载。
 *
 * ── 路径安全 ──
 *
 * 插件 id 直接当文件夹名用，所以它必须严格校验（ID_RE）—— 一个 `../` 就能
 * 让安装写到 data/ 外面去。解压时**每一个** entry 的最终路径都要回头确认
 * 还在目标目录里面（见 safeJoin），不能只看 id：zip 里的路径是攻击者写的。
 *
 * ── 落盘 ──
 *
 *   data/plugins/<id>/manifest.json   插件自带的清单
 *   data/plugins/<id>/client.js       前端入口
 *   data/plugins/<id>/storage/        插件唯一允许写的地方（这一版还没开放 API）
 *   data/plugins/installed.json       装了哪些、哪些开着、从哪来的
 *
 * 为什么另存一份 installed.json 而不是只看文件夹：开关状态、安装时间、
 * 来源 zip 的文件名这些不属于插件自己（它不该能改自己的开关）。
 *
 * ── 备份 ──
 *
 * 进云备份的「配置」那一块，但**只带 manifest.json 和 installed.json**，
 * 插件代码一个字节都不进包 —— 一份备份搬到别人机器上恢复，等于在那台机器上
 * 自动落下一批可执行代码。恢复之后用户看到的是「这些插件原来装过」的清单，
 * 自己去市场重新下载。插件自己的 storage/ 归「聊天与记忆」那一块。
 * 见 cloudbackup.js:SCOPES。
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import { PLUGINS_DIR, readJson, writeJson } from "./datadir.js";
import { logError, logInfo } from "./logs.js";

export { PLUGINS_DIR };
const INSTALLED_PATH = path.join(PLUGINS_DIR, "installed.json");

/**
 * 插件 id 的规矩，和市场索引里那条 id 一样（uranus-plugins/schema）。
 *
 * **这个正则是路径安全的第一道闸** —— id 直接当文件夹名用。只允许小写字母、
 * 数字、连字符，就排除了 `..`、`/`、`\`、空字节、Windows 保留名（CON、NUL
 * 那些永远撞不上，因为前面必须是小写字母且不含点）。
 */
const ID_RE = /^[a-z][a-z0-9-]{2,63}$/;

/** 一个插件最多多大（解压后）。前端插件就是几个 js/css，给足 5MB。 */
const MAX_UNPACKED = 5 * 1024 * 1024;
/** 一个插件最多多少个文件。正常插件个位数，1000 是防 zip 炸弹。 */
const MAX_FILES = 1000;
/** 装的时候收的 zip 最多多大。 */
export const MAX_ZIP = 8 * 1024 * 1024;

/** 入口能指向的文件类型。插件是前端代码，不该带二进制。 */
const ENTRY_EXT = { client: [".js", ".mjs"], css: [".css"] };

/** 跟着 zip 一起来的系统垃圾，解压时直接丢。 */
const JUNK = /^(__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$)/i;

// ── installed.json ───────────────────────────────────────────────────

/**
 * 读安装清单。
 *
 * 形状：`{ enabled: boolean, plugins: { <id>: { enabled, installedAt, source, version } } }`
 *
 * `enabled` 是**总开关**，默认 false —— 装了插件也要用户自己开。
 */
export function readInstalled() {
  const raw = readJson(INSTALLED_PATH, {});
  const plugins = {};
  for (const [id, v] of Object.entries(raw?.plugins ?? {})) {
    if (!ID_RE.test(id)) continue; // 手改坏的条目直接当没有
    plugins[id] = {
      enabled: Boolean(v?.enabled),
      installedAt: typeof v?.installedAt === "string" ? v.installedAt : "",
      source: typeof v?.source === "string" ? v.source : "",
      version: typeof v?.version === "string" ? v.version : "",
    };
  }
  return { enabled: Boolean(raw?.enabled), plugins };
}

function writeInstalled(next) {
  fs.mkdirSync(PLUGINS_DIR, { recursive: true });
  writeJson(INSTALLED_PATH, next);
}

// ── 校验 ─────────────────────────────────────────────────────────────

/**
 * 读一个插件文件夹，返回它在界面上长什么样。
 *
 * **永远不抛。** 读不出来、manifest 坏了、入口不见了，都返回一个带 `broken`
 * 的条目 —— 一个坏插件不该让整个列表打不开，而且用户得看见是哪个坏了、
 * 坏在哪儿，否则他只能全删重来。
 *
 * @param {string} id 文件夹名
 */
function readPlugin(id) {
  const dir = path.join(PLUGINS_DIR, id);
  const base = { id, name: id, version: "", author: "", repo: "", description: "", entry: {}, permissions: [] };

  if (!ID_RE.test(id)) {
    return { ...base, broken: "文件夹名不是合法的插件 id（只能是小写字母、数字和连字符）" };
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf-8"));
  } catch (err) {
    return { ...base, broken: `manifest.json 读不出来：${err.code === "ENOENT" ? "文件不存在" : "不是合法的 JSON"}` };
  }

  // manifest 里的 id 必须和文件夹名一致 —— 不一致的话「装了哪个」就说不清了，
  // 市场索引里那条 id 也对不上，控制台没法判断「这个你已经装了」
  if (manifest?.id !== id) {
    return { ...base, broken: `manifest.json 里的 id 是「${manifest?.id ?? "（没写）"}」，和文件夹名「${id}」对不上` };
  }

  const entry = {};
  for (const [key, exts] of Object.entries(ENTRY_EXT)) {
    const rel = manifest?.entry?.[key];
    if (rel == null || rel === "") continue;
    if (typeof rel !== "string") return { ...base, broken: `entry.${key} 不是字符串` };
    // 入口只能指向插件自己文件夹里的文件，不能带路径分隔符往外跑
    if (rel.includes("/") || rel.includes("\\") || rel.includes("..")) {
      return { ...base, broken: `entry.${key}「${rel}」不能带路径，入口文件必须在插件根目录` };
    }
    if (!exts.some((e) => rel.toLowerCase().endsWith(e))) {
      return { ...base, broken: `entry.${key}「${rel}」的后缀不对，应该是 ${exts.join(" 或 ")}` };
    }
    if (!fs.existsSync(path.join(dir, rel))) {
      return { ...base, broken: `entry.${key} 指向的「${rel}」不存在` };
    }
    entry[key] = rel;
  }
  if (!entry.client && !entry.css) {
    return { ...base, broken: "manifest.json 里没有 entry.client 也没有 entry.css，这个插件什么都不会做" };
  }

  return {
    id,
    name: typeof manifest.name === "string" && manifest.name.trim() ? manifest.name.trim().slice(0, 40) : id,
    version: typeof manifest.version === "string" ? manifest.version.slice(0, 32) : "",
    author: typeof manifest.author === "string" ? manifest.author.slice(0, 64) : "",
    repo: typeof manifest.repo === "string" && /^https:\/\//.test(manifest.repo) ? manifest.repo : "",
    description: typeof manifest.description === "string" ? manifest.description.slice(0, 200) : "",
    uranus: typeof manifest.uranus === "string" ? manifest.uranus.slice(0, 32) : "",
    entry,
    // 这一版还没有权限系统，但清单照读照显示 —— 装之前让用户看见插件声称要什么，
    // 和市场那边 PR 模板里作者自己填的那份对照
    permissions: Array.isArray(manifest.permissions)
      ? manifest.permissions.filter((p) => typeof p === "string").slice(0, 20)
      : [],
  };
}

/** 列出装了的插件，带上开关状态。坏掉的也在里面（`broken`）。 */
export function listPlugins() {
  const installed = readInstalled();
  let dirs = [];
  try {
    dirs = fs
      .readdirSync(PLUGINS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return { enabled: installed.enabled, plugins: [] };
  }

  const plugins = dirs.map((id) => {
    const p = readPlugin(id);
    const rec = installed.plugins[id];
    return {
      ...p,
      // 清单里没有这一条（用户手动拷进去的）就当是关着的 —— 往文件夹里拷一个
      // 文件夹不该等于「同意让它跑」
      enabled: Boolean(rec?.enabled) && !p.broken,
      installedAt: rec?.installedAt ?? "",
      source: rec?.source ?? "",
    };
  });

  return { enabled: installed.enabled, plugins };
}

/** 真正会被前端加载的那几个：总开关开着、自己开着、没坏。 */
export function activePlugins() {
  const { enabled, plugins } = listPlugins();
  if (!enabled) return [];
  return plugins.filter((p) => p.enabled && !p.broken);
}

// ── zip 解包 ─────────────────────────────────────────────────────────

/**
 * 把 zip 里的路径拼到目标目录下，并确认拼完还在里面。
 *
 * zip 里的路径是**打包的人写的**，`../../etc/passwd` 这种完全合法。所以不能
 * 信任它，拼完必须回头比一次。这是路径穿越的最后一道闸。
 *
 * @returns {string|null} 安全的话返回绝对路径，不安全返回 null
 */
function safeJoin(root, rel) {
  const clean = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!clean || clean.includes("\0")) return null;
  const abs = path.resolve(root, clean);
  const rooted = path.resolve(root) + path.sep;
  if (abs !== path.resolve(root) && !abs.startsWith(rooted)) return null;
  return abs;
}

/**
 * 拆一个 zip，返回 `[{ name, data }]`。零依赖，用 zlib。
 *
 * 只认「不压缩」（0）和「deflate」（8），和前端那套一样（client/src/unzip.js）——
 * 几乎所有打包工具默认就这两种。加密的包不支持。
 *
 * 文件名按 UTF-8 解。Windows 资源管理器打的包里中文名可能是 GBK，但插件的
 * 文件名应该全是 ASCII（manifest.json / client.js 这种），所以这里不像前端
 * 那样做 GBK 回退 —— 真遇上乱码的文件名，它多半也不是入口文件。
 */
function unzip(buf) {
  if (buf.length < 22) throw new Error("不是 zip，或者文件不完整");
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // 从尾巴往前找「中央目录结束」记录（后面可能跟着最长 64KB 的注释）
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是 zip，或者文件不完整");

  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  if (at === 0xffffffff) throw new Error("zip64 格式（超过 4GB）不支持");
  if (count > MAX_FILES) throw new Error(`压缩包里有 ${count} 个文件，太多了（上限 ${MAX_FILES}）`);

  const files = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (at + 46 > buf.length || view.getUint32(at, true) !== 0x02014b50) throw new Error("压缩包的目录区坏了");
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const packed = view.getUint32(at + 20, true);
    const unpacked = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    // PowerShell 的 Compress-Archive 用反斜杠当分隔符
    const name = new TextDecoder().decode(buf.subarray(at + 46, at + 46 + nameLen)).replace(/\\/g, "/");
    at += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue; // 文件夹本身
    if (JUNK.test(name) || JUNK.test(name.split("/").pop() ?? "")) continue;
    if (flags & 0x1) throw new Error("压缩包加密了，不支持");
    if (method !== 0 && method !== 8) throw new Error(`「${name}」的压缩方式不支持`);

    // 先按目录区声明的大小拦一次 zip 炸弹 —— 不解压就知道该不该拒
    total += unpacked;
    if (total > MAX_UNPACKED) throw new Error(`解压后超过 ${Math.round(MAX_UNPACKED / 1024 / 1024)}MB，太大了`);

    // 本地文件头里的名字和扩展字段长度可能和目录区不一样，得按本地的算数据起点
    if (local + 30 > buf.length) throw new Error("压缩包坏了");
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = buf.subarray(start, start + packed);
    let data;
    try {
      data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    } catch {
      throw new Error(`「${name}」解压失败，压缩包可能坏了`);
    }
    // 真实大小再拦一次 —— 目录区里写的数字是打包的人写的，可以撒谎
    if (data.length > MAX_UNPACKED) throw new Error("解压后太大了");
    files.push({ name, data });
  }
  if (files.length === 0) throw new Error("压缩包是空的");
  return files;
}

/**
 * zip 里常见两种结构：文件直接在根下，或者套了一层文件夹（GitHub 下载的
 * 源码包就是 `repo-main/` 这种）。把共同前缀剥掉，让两种都能装。
 */
function stripRoot(files) {
  if (files.some((f) => !f.name.includes("/"))) return files; // 根下就有文件，不剥
  const first = files[0].name.split("/")[0];
  if (!files.every((f) => f.name.startsWith(`${first}/`))) return files; // 前缀不统一，不剥
  return files.map((f) => ({ ...f, name: f.name.slice(first.length + 1) })).filter((f) => f.name);
}

/**
 * 从一个 zip 装插件。
 *
 * @param {Buffer} buf zip 的内容
 * @param {string} sourceName 用户选的那个文件叫什么（只用来显示）
 * @returns {{id: string, name: string, replaced: boolean, permissions: string[]}}
 * @throws {Error} 带 `.status` 的错误直接回给前端
 */
export function installFromZip(buf, sourceName = "") {
  const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

  if (buf.length > MAX_ZIP) throw bad(`压缩包 ${Math.round(buf.length / 1024 / 1024)}MB，超过 ${MAX_ZIP / 1024 / 1024}MB 上限`);

  let files;
  try {
    files = stripRoot(unzip(buf));
  } catch (err) {
    throw bad(err.message);
  }

  const mf = files.find((f) => f.name === "manifest.json");
  if (!mf) throw bad("压缩包里没有 manifest.json —— 这多半不是 Uranus 插件");

  let manifest;
  try {
    manifest = JSON.parse(mf.data.toString("utf-8"));
  } catch {
    throw bad("manifest.json 不是合法的 JSON");
  }

  const id = manifest?.id;
  if (typeof id !== "string" || !ID_RE.test(id)) {
    throw bad(`manifest.json 里的 id「${id ?? "（没写）"}」不合规：只能是小写字母、数字和连字符，3~64 字`);
  }

  const dir = path.join(PLUGINS_DIR, id);
  const replaced = fs.existsSync(dir);

  // 先解到一个临时目录，全部落完再换过去 —— 中途失败不会留下一个装了一半的插件
  const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
  try {
    for (const f of files) {
      const abs = safeJoin(tmp, f.name);
      if (!abs) throw bad(`压缩包里有一个危险的路径「${f.name}」，已拒绝`);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, f.data);
    }

    // 落完之后按真正的规则校验一遍（入口在不在、后缀对不对）。
    // 这一步在临时目录里做不了（readPlugin 认的是 PLUGINS_DIR 下的 id），
    // 所以先换过去再验，验不过就连同旧的一起回滚
    const backup = replaced ? `${dir}.bak-${Date.now()}` : null;
    if (replaced) fs.renameSync(dir, backup);
    fs.renameSync(tmp, dir);

    const check = readPlugin(id);
    if (check.broken) {
      fs.rmSync(dir, { recursive: true, force: true });
      if (backup) fs.renameSync(backup, dir);
      throw bad(`这个插件装不了：${check.broken}`);
    }
    if (backup) fs.rmSync(backup, { recursive: true, force: true });

    // 装完默认**关着** —— 装进来和同意让它跑是两件事。
    // 覆盖安装（升级）的话保留原来的开关状态，不然每次更新都要重新开一遍
    const installed = readInstalled();
    const was = installed.plugins[id];
    installed.plugins[id] = {
      enabled: replaced ? Boolean(was?.enabled) : false,
      installedAt: new Date().toISOString(),
      source: String(sourceName).slice(0, 120),
      version: check.version,
    };
    writeInstalled(installed);

    logInfo("插件", `${replaced ? "更新" : "装上"}了插件 ${check.name}（${id}@${check.version || "无版本号"}）`);
    return { id, name: check.name, version: check.version, replaced, permissions: check.permissions };
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (err.status) throw err;
    logError("插件", `装插件失败（${id}）`, err);
    throw bad("装插件时出错，日志里有详情", 500);
  }
}

/** 卸载：删文件夹，从清单里去掉。插件自己的 storage/ 一起删（用户要的就是删干净）。 */
export function uninstall(id) {
  if (!ID_RE.test(id)) throw Object.assign(new Error("插件 id 不合规"), { status: 400 });
  const dir = path.join(PLUGINS_DIR, id);
  if (!fs.existsSync(dir)) throw Object.assign(new Error("没装这个插件"), { status: 404 });

  fs.rmSync(dir, { recursive: true, force: true });
  const installed = readInstalled();
  delete installed.plugins[id];
  writeInstalled(installed);
  logInfo("插件", `卸载了插件 ${id}`);
}

// ── 路由 ─────────────────────────────────────────────────────────────

/**
 * 收 zip 的那条路由，**必须单独挂在 `express.json()` 之前**。
 *
 * json 中间件解析不了 application/zip，但它会把流读掉，等轮到这条路由时
 * body 已经没了 —— index.js 里收图和恢复完整备份那两条踩的是同一个坑，
 * 所以这里也拆成两半：这一条早挂，其余的跟着别的面板一起挂（mountPlugins）。
 *
 * 没有「从 URL 安装」那条路，是故意的：市场只是链接目录，下载这一步永远
 * 由用户自己在浏览器里完成。多一条「后端替你下载」就等于多一条可以被
 * 诱导去打任意地址的路。
 */
export function mountPluginInstall(app) {
  app.post("/api/plugins/install", async (req, res) => {
    const chunks = [];
    let size = 0;
    try {
      await new Promise((resolve, reject) => {
        req.on("data", (c) => {
          // 边收边量：8MB 不大，但没必要让人把 100MB 传完了再说「太大了」
          size += c.length;
          if (size > MAX_ZIP) {
            reject(Object.assign(new Error(`压缩包超过 ${MAX_ZIP / 1024 / 1024}MB 上限`), { status: 413 }));
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        req.on("end", resolve);
        req.on("error", reject);
      });
    } catch (err) {
      return res.status(err.status ?? 400).json({ error: err.message });
    }

    if (size === 0) return res.status(400).json({ error: "没收到文件内容" });

    try {
      const out = installFromZip(Buffer.concat(chunks), String(req.get("x-plugin-filename") ?? ""));
      res.json({ ...out, ...listPlugins() });
    } catch (err) {
      res.status(err.status ?? 500).json({ error: err.message });
    }
  });
}

export function mountPlugins(app) {
  /** 列表 + 总开关。界面靠这一个接口画插件分区。 */
  app.get("/api/plugins", (_req, res) => res.json(listPlugins()));

  /**
   * 前端要加载的那几个（总开关开着、自己开着、没坏）。
   *
   * 和 `/api/plugins` 分开是因为这条在**每次打开控制台**时都要拉，而且它
   * 只给能跑的那几个 —— 界面上的管理列表要连坏的一起显示，两种需求不一样。
   */
  app.get("/api/plugins/active", (_req, res) => {
    res.json(
      activePlugins().map((p) => ({
        id: p.id,
        name: p.name,
        version: p.version,
        entry: p.entry,
      })),
    );
  });

  /** 总开关。 */
  app.put("/api/plugins/enabled", (req, res) => {
    const next = readInstalled();
    next.enabled = Boolean(req.body?.enabled);
    writeInstalled(next);
    logInfo("插件", next.enabled ? "插件总开关已打开" : "插件总开关已关闭");
    res.json(listPlugins());
  });

  /** 单个插件的开关。 */
  app.put("/api/plugins/:id/enabled", (req, res) => {
    const { id } = req.params;
    if (!ID_RE.test(id)) return res.status(400).json({ error: "插件 id 不合规" });

    const installed = readInstalled();
    if (!installed.plugins[id] && !fs.existsSync(path.join(PLUGINS_DIR, id))) {
      return res.status(404).json({ error: "没装这个插件" });
    }

    const want = Boolean(req.body?.enabled);
    // 坏掉的插件开不了 —— 开了也加载不起来，不如在这里就说清楚
    if (want) {
      const p = readPlugin(id);
      if (p.broken) return res.status(400).json({ error: `这个插件有问题，开不了：${p.broken}` });
    }

    installed.plugins[id] = { ...(installed.plugins[id] ?? { installedAt: "", source: "", version: "" }), enabled: want };
    writeInstalled(installed);
    res.json(listPlugins());
  });

  /**
   * 装一个插件：见 mountPluginInstall —— 那条必须挂在 express.json() 之前，
   * 所以不在这里。
   */

  /** 卸载。 */
  app.delete("/api/plugins/:id", (req, res) => {
    try {
      uninstall(req.params.id);
      res.json(listPlugins());
    } catch (err) {
      res.status(err.status ?? 500).json({ error: err.message });
    }
  });

  /**
   * 插件自己的文件（前端 `import()` 它）。
   *
   * 只放行 manifest 里登记过的入口 —— 不是把整个文件夹静态服务出去。
   * 插件目录里可能有 README、storage/、作者忘了删的 .env，那些一律不给。
   * 总开关关着或者插件自己关着的时候也不给：关了就该是真的关了。
   */
  app.get("/api/plugins/:id/file/:name", (req, res) => {
    const { id, name } = req.params;
    if (!ID_RE.test(id)) return res.status(400).end();

    const active = activePlugins().find((p) => p.id === id);
    if (!active) return res.status(404).end();
    if (!Object.values(active.entry).includes(name)) return res.status(404).end();

    const abs = safeJoin(path.join(PLUGINS_DIR, id), name);
    if (!abs || !fs.existsSync(abs)) return res.status(404).end();

    res.type(name.toLowerCase().endsWith(".css") ? "text/css" : "text/javascript");
    // 插件装上就不会变（换版本要重新导入），但开关一拨内容就该跟着变，
    // 所以不缓存 —— 这几个文件只有几 KB，省不出什么
    res.set("cache-control", "no-store");
    fs.createReadStream(abs).pipe(res);
  });
}
