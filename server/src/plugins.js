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
import { makeNet } from "./cloud/net.js";
import { logError, logInfo, logWarn } from "./logs.js";

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

/**
 * 插件配置（manifest.json 里的 `config` 段）的限额。
 *
 * 那段声明是**作者写的**，和插件代码一样当不可信输入处理 —— 一份声明了
 * 五千个配置项、或者标题有十万字的 manifest 不该能把设置界面撑爆。
 */
const CFG = {
  /** 最多多少项。真实插件个位数，30 是给「配置很多」的那种留的余量 */
  maxItems: 30,
  /** key 的样子：字母开头，字母数字下划线，最长 32 */
  keyRe: /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/,
  /** select 最多多少个选项 */
  maxOptions: 50,
  /** 标题 / 说明 / 选项 label 的长度上限 */
  maxTitle: 40,
  maxDesc: 200,
  maxLabel: 40,
  /** string / secret 的值默认最长多少。作者能用 maxLength 往下调，不能往上超 */
  maxValue: 2000,
};

/** 配置项支持的五种类型。**不打算再加**（见文件头那段注释）。 */
const CFG_TYPES = new Set(["string", "secret", "number", "boolean", "select"]);

/** secret 项回给前端时的占位。用户没改的话原样发回来，后端认出它=「没改」。 */
const SECRET_MASK = "••••••••";

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
 * 解析 manifest 里那段 `config` 声明。
 *
 * 作者只声明「我要哪些配置项」，表单由 Uranus 渲染（见 client/src/panels/plugins.jsx）——
 * 作者不写界面代码，也就拿不到往设置页里塞任意 DOM 的机会。他能说的只有
 * 「我要一个字符串输入框」。
 *
 * 五种类型就够了，不打算再加（`CFG_TYPES`）：一旦支持嵌套对象和数组，表单渲染
 * 的复杂度和校验的攻击面都会涨一个量级，而插件真正要的 99% 是这五种的平铺。
 *
 * **永远不抛**：声明坏了返回 `{ error }`，让这个插件进 broken ——
 * 和 entry 指向的文件不存在一个待遇，不会影响别的插件。
 *
 * @returns {{items: object[]} | {error: string}}
 */
function parseConfigSchema(raw) {
  if (raw == null) return { items: [] }; // 没声明配置，正常
  if (!Array.isArray(raw)) return { error: "manifest.json 里的 config 必须是数组" };
  if (raw.length > CFG.maxItems) return { error: `config 里有 ${raw.length} 项，上限 ${CFG.maxItems} 项` };

  const items = [];
  const seen = new Set();

  for (const [i, r] of raw.entries()) {
    const at = `config[${i}]`;
    if (!r || typeof r !== "object" || Array.isArray(r)) return { error: `${at} 必须是对象` };

    const key = r.key;
    if (typeof key !== "string" || !CFG.keyRe.test(key)) {
      return { error: `${at} 的 key「${key ?? "（没写）"}」不合规：字母开头，只能有字母、数字和下划线，最长 32 字` };
    }
    if (seen.has(key)) return { error: `${at} 的 key「${key}」和前面的重复了` };
    seen.add(key);

    const type = r.type ?? "string";
    if (!CFG_TYPES.has(type)) {
      return { error: `${at}（${key}）的 type「${type}」不认识，只能是 ${[...CFG_TYPES].join(" / ")}` };
    }

    const item = {
      key,
      type,
      title: typeof r.title === "string" && r.title.trim() ? r.title.trim().slice(0, CFG.maxTitle) : key,
      desc: typeof r.desc === "string" ? r.desc.slice(0, CFG.maxDesc) : "",
      required: Boolean(r.required),
    };

    if (type === "select") {
      if (!Array.isArray(r.options) || r.options.length === 0) {
        return { error: `${at}（${key}）是 select，但没给 options` };
      }
      if (r.options.length > CFG.maxOptions) {
        return { error: `${at}（${key}）的 options 有 ${r.options.length} 个，上限 ${CFG.maxOptions} 个` };
      }
      const opts = [];
      const seenVal = new Set();
      for (const o of r.options) {
        // 允许 "值" 或 { value, label } 两种写法 —— 只有值没有显示名的场合很常见
        const value = typeof o === "string" ? o : o?.value;
        if (typeof value !== "string" || !value || value.length > 64) {
          return { error: `${at}（${key}）的 options 里有一项的 value 不合规` };
        }
        if (seenVal.has(value)) return { error: `${at}（${key}）的 options 里 value「${value}」重复了` };
        seenVal.add(value);
        const label = typeof o === "string" ? o : o?.label;
        opts.push({ value, label: typeof label === "string" && label.trim() ? label.trim().slice(0, CFG.maxLabel) : value });
      }
      item.options = opts;
      item.default = typeof r.default === "string" && seenVal.has(r.default) ? r.default : opts[0].value;
    } else if (type === "number") {
      const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
      item.min = num(r.min);
      item.max = num(r.max);
      if (item.min != null && item.max != null && item.min > item.max) {
        return { error: `${at}（${key}）的 min 比 max 还大` };
      }
      const d = num(r.default);
      item.default = d ?? item.min ?? 0;
      if (item.max != null && item.default > item.max) item.default = item.max;
    } else if (type === "boolean") {
      item.default = Boolean(r.default);
    } else {
      // string / secret
      const ml = typeof r.maxLength === "number" && Number.isFinite(r.maxLength) ? Math.floor(r.maxLength) : CFG.maxValue;
      // 作者给的上限只能比全局的小 —— 不然一个插件就能声明「我这项能存 10MB」
      item.maxLength = Math.max(1, Math.min(ml, CFG.maxValue));
      // secret 不给默认值：一个「默认密钥」没有任何意义，而且会在界面上显示成已填
      item.default = type === "secret" ? "" : typeof r.default === "string" ? r.default.slice(0, item.maxLength) : "";
    }

    items.push(item);
  }

  return { items };
}

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

  // 配置项的声明坏了，和 entry 指向的文件不存在一个待遇：这个插件 broken，别的照常
  const schema = parseConfigSchema(manifest.config);
  if (schema.error) return { ...base, broken: schema.error };

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
    configSchema: schema.items,
  };
}

/* ---------- 插件配置的值 ---------- */

/**
 * 一个插件的配置值落在哪。
 *
 * **不放 `storage/` 里面** —— `storage/` 是插件自己写的地方，而这份是
 * 「用户填、插件只读」。混在一起插件就能改自己的配置了：把 required 的项清空、
 * 或者偷偷改掉用户设的阈值。分开存，插件对它没有写权限。
 */
const configPathFor = (id) => path.join(PLUGINS_DIR, id, "config.json");

/** 读某个插件存着的配置值（原始值，含 secret 的明文）。 */
function readConfigValues(id) {
  const raw = readJson(configPathFor(id), {});
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

/**
 * 按 schema 把存着的值补齐成「插件实际会拿到的那份」：没填过的项给 default。
 *
 * @param {object[]} schema parseConfigSchema 的结果
 * @param {object} stored readConfigValues 的结果
 * @param {{mask?: boolean}} opts mask=true 时把 secret 抹成占位（要发给浏览器时用）
 */
function resolveConfig(schema, stored, { mask = false } = {}) {
  const out = {};
  for (const item of schema) {
    const has = Object.prototype.hasOwnProperty.call(stored, item.key);
    const v = has ? stored[item.key] : item.default;
    if (item.type === "secret") {
      // 抹成占位而不是省略：界面要能区分「填过」和「没填过」
      out[item.key] = mask ? (typeof v === "string" && v ? SECRET_MASK : "") : v ?? "";
    } else {
      out[item.key] = v;
    }
  }
  return out;
}

/**
 * 校验浏览器发来的那份值，返回能落盘的。
 *
 * 这是这一块的安全核心 —— `values` 是前端发来的，而前端是可以被插件自己
 * 用 fetch 调的（插件和控制台同源）。所以不能信 schema 之外的任何东西。
 *
 * @returns {{values: object} | {error: string}}
 */
function validateConfigValues(schema, incoming, stored) {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    return { error: "values 必须是对象" };
  }
  const out = {};

  for (const item of schema) {
    const { key, type } = item;
    // 没提到的项保留原值 —— 前端只发改动的那几项也能正常工作
    if (!Object.prototype.hasOwnProperty.call(incoming, key)) {
      if (Object.prototype.hasOwnProperty.call(stored, key)) out[key] = stored[key];
      continue;
    }
    const v = incoming[key];

    if (type === "boolean") {
      if (typeof v !== "boolean") return { error: `「${item.title}」要的是开关（true / false）` };
      out[key] = v;
    } else if (type === "number") {
      if (typeof v !== "number" || !Number.isFinite(v)) return { error: `「${item.title}」要的是数字` };
      if (item.min != null && v < item.min) return { error: `「${item.title}」不能小于 ${item.min}` };
      if (item.max != null && v > item.max) return { error: `「${item.title}」不能大于 ${item.max}` };
      out[key] = v;
    } else if (type === "select") {
      if (typeof v !== "string" || !item.options.some((o) => o.value === v)) {
        return { error: `「${item.title}」的值不在可选项里` };
      }
      out[key] = v;
    } else if (type === "secret") {
      if (typeof v !== "string") return { error: `「${item.title}」要的是文本` };
      // 原样发回来的占位 = 用户没动这一项，保留原值。
      // 少了这一条，用户改个别的项就会把密钥冲成一串圆点
      if (v === SECRET_MASK) {
        if (Object.prototype.hasOwnProperty.call(stored, key)) out[key] = stored[key];
      } else {
        if (v.length > item.maxLength) return { error: `「${item.title}」太长了（上限 ${item.maxLength} 字）` };
        out[key] = v;
      }
    } else {
      if (typeof v !== "string") return { error: `「${item.title}」要的是文本` };
      if (v.length > item.maxLength) return { error: `「${item.title}」太长了（上限 ${item.maxLength} 字）` };
      out[key] = v;
    }
  }

  // schema 里没有的 key 直接丢，不报错 —— 插件升级删掉了某一项的话，
  // 浏览器里那份旧表单发上来不该让保存失败
  return { values: out };
}

/**
 * 插件实际拿到的配置（加载时传进 ctx.config）。给 /api/plugins/active 用。
 */
function configFor(id, schema) {
  if (!schema?.length) return undefined;
  return resolveConfig(schema, readConfigValues(id));
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

/*
 * ── 插件市场（一份链接目录）──
 *
 * 市场就是 GitHub 上那个仓库里的两份 JSON。控制台把它们渲染成卡片，点一下
 * **在新标签页打开作者的仓库** —— 下载 zip 这一步永远由用户自己在浏览器里做。
 *
 * 为什么由后端代拉而不是浏览器直接 fetch：
 *
 *  1. raw.githubusercontent.com 在国内很多网络下连不上，而后端那台机器多半
 *     已经为了调模型 API 配好了出网（VPS 在墙外、或者本机挂着代理）。浏览器
 *     直连会让相当一部分用户看到一个空列表，还以为是市场里没东西。
 *  2. 拉到的内容要缓存 —— 每次打开插件分区都去打一次 GitHub 既慢又没必要。
 *  3. 浏览器直连会把用户的 IP 暴露给 GitHub。虽然只是拉一份公开 JSON，
 *     但「打开控制台的某个分区」不该顺带产生一次对第三方的请求。
 *
 * 缓存写在内存里不落盘：这份目录是**别人仓库里的内容**，不是用户的数据，
 * 落到 data/ 里既要进备份又要考虑过期，不值当。进程重启重新拉一次就是。
 */

/**
 * 市场索引的地址。
 *
 * `URANUS_PLUGIN_MARKET` 能换成别的目录（给自建市场源用，也给开发时指向本地
 * 文件用）。给的是**目录**的地址，两份 JSON 的文件名固定 —— 这样换源的人只要
 * 保证自己那份目录的格式和 schema 一致就行，不用配两个地址。
 */
const MARKET_BASE = (process.env.URANUS_PLUGIN_MARKET ?? "https://raw.githubusercontent.com/nikonotnicotine/uranus-plugins/main").replace(/\/+$/, "");
const MARKET_INDEX = `${MARKET_BASE}/plugins.json`;
const MARKET_DELISTED = `${MARKET_BASE}/delisted.json`;

/** 缓存多久。目录变动不频繁，10 分钟够了；用户点「刷新」能强制重拉。 */
const MARKET_TTL = 10 * 60 * 1000;

/** 一份索引最多多大。几百个插件也就几十 KB，2MB 是防对面被人塞了个大文件。 */
const MARKET_MAX_BYTES = 2 * 1024 * 1024;

const net = makeNet({ who: "插件市场", scope: "插件", hint: "拉取插件市场的目录" });

/** @type {{at: number, data: object} | null} */
let marketCache = null;

/**
 * 把远端那份条目收干净再交给前端。
 *
 * **这是从别人仓库里拉来的数据，当成不可信的输入处理**：每个字段都限类型、
 * 限长度，链接只放行 https 的 github.com 地址 —— 一条被改坏（或者被人往
 * 仓库里塞了奇怪东西）的条目不该能在控制台里渲染出一个 `javascript:` 链接，
 * 或者用一段超长的描述把布局撑爆。
 */
function cleanEntry(e) {
  if (!e || typeof e !== "object") return null;
  const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
  const ghUrl = (v) =>
    typeof v === "string" && /^https:\/\/github\.com\/[A-Za-z0-9._\-/]{1,120}$/.test(v) ? v : "";

  const id = str(e.id, 64);
  if (!ID_RE.test(id)) return null; // id 不合规的条目直接丢，它和本地装的对不上
  const repo = ghUrl(e.repo);
  if (!repo) return null; // 没有仓库地址的条目没有意义 —— 市场就是个跳转目录

  return {
    id,
    title: str(e.title, 40) || id,
    desc: str(e.desc, 200),
    author: ghUrl(e.author),
    repo,
    license: str(e.license, 32),
    tags: Array.isArray(e.tags) ? e.tags.filter((t) => typeof t === "string").slice(0, 5).map((t) => t.slice(0, 12)) : [],
    lockedVersion: str(e.lockedVersion, 64),
    reviewedAt: str(e.reviewedAt, 10),
    addedAt: str(e.addedAt, 10),
  };
}

function cleanDelisted(e) {
  if (!e || typeof e !== "object") return null;
  const id = typeof e.id === "string" ? e.id.slice(0, 64) : "";
  if (!ID_RE.test(id)) return null;
  return {
    id,
    title: typeof e.title === "string" ? e.title.slice(0, 40) : id,
    delistedAt: typeof e.delistedAt === "string" ? e.delistedAt.slice(0, 10) : "",
    reason: typeof e.reason === "string" ? e.reason.slice(0, 24) : "other",
    note: typeof e.note === "string" ? e.note.slice(0, 200) : "",
  };
}

async function fetchJson(url, what) {
  const res = await net.fetch(url, { headers: { accept: "application/json" } }, what);
  if (!res.ok) throw new Error(`${what}失败：GitHub 返回 ${res.status}`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MARKET_MAX_BYTES) throw new Error(`${what}失败：文件太大（${len} 字节）`);
  const text = await res.text();
  if (text.length > MARKET_MAX_BYTES) throw new Error(`${what}失败：文件太大`);
  return JSON.parse(text);
}

/**
 * 拉市场目录（带缓存）。
 *
 * 下架名单拉不到**不算失败** —— 在售目录才是主体。但这时候要让前端知道
 * 「这次没对过下架名单」，否则一个已下架的插件会被显示成正常的。
 */
async function loadMarket({ force = false } = {}) {
  if (!force && marketCache && Date.now() - marketCache.at < MARKET_TTL) {
    return { ...marketCache.data, cached: true };
  }

  const index = await fetchJson(MARKET_INDEX, "拉取插件目录");
  const plugins = Array.isArray(index?.plugins) ? index.plugins.map(cleanEntry).filter(Boolean) : [];

  let delisted = [];
  let delistedOk = true;
  try {
    const d = await fetchJson(MARKET_DELISTED, "拉取下架名单");
    delisted = Array.isArray(d?.plugins) ? d.plugins.map(cleanDelisted).filter(Boolean) : [];
  } catch (err) {
    delistedOk = false;
    logWarn("插件", "下架名单拉不到，这次不对照（在售目录照常显示）", err);
  }

  const data = {
    plugins,
    delisted,
    delistedOk,
    updatedAt: typeof index?.updatedAt === "string" ? index.updatedAt.slice(0, 10) : "",
    fetchedAt: new Date().toISOString(),
  };
  marketCache = { at: Date.now(), data };
  logInfo(
    "插件",
    `插件市场目录已更新：${plugins.length} 个在售${delistedOk ? `，${delisted.length} 个已下架` : "（下架名单没拉到）"}`,
  );
  return { ...data, cached: false };
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
   * 插件市场的目录（后端代拉 + 缓存，见 loadMarket 上面那段）。
   *
   * `?refresh=1` 强制重拉 —— 用户刚上架了自己的插件，不该等十分钟。
   *
   * 拉不到的时候回 502 而不是空列表：空列表看起来像「市场里没有插件」，
   * 而真相是「没连上 GitHub」，这两件事用户要做的处置完全不同。
   */
  app.get("/api/plugins/market", async (req, res) => {
    try {
      const market = await loadMarket({ force: req.query.refresh === "1" });
      // 顺带把本地装了什么一起给，省得前端再打一次接口、还要自己对
      const local = listPlugins();
      res.json({
        ...market,
        installed: Object.fromEntries(local.plugins.map((p) => [p.id, { version: p.version, enabled: p.enabled }])),
      });
    } catch (err) {
      res.status(502).json({ error: String(err?.message ?? err) });
    }
  });

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
        // 只说「这个插件有没有配置」，**值不在这里**。要值的话前端按 id 逐个去
        // 拉 /api/plugins/:id/config/runtime —— 理由见那条路由的注释
        hasConfig: (p.configSchema?.length ?? 0) > 0,
      })),
    );
  });

  /**
   * 某个插件运行时拿到的配置（ctx.config），**含 secret 的明文**。
   *
   * 明文到浏览器这件事躲不掉：插件跑在浏览器里，它要拿这个 key 去调自己那家
   * API。所以问题不是「要不要给」，而是「一次给多少」。
   *
   * 本来是跟在 /api/plugins/active 的列表里一起发的，那样一次请求就把**所有**
   * 插件的密钥打包送到页面上 —— 列表被日志打一下、被截个图，全泄。改成按 id
   * 单独拉之后，加载谁才取谁那份。
   *
   * ⚠️ **这不是插件之间的隔离。** 插件和控制台同源，插件 B 完全可以自己
   * fetch 这条路由去拿插件 A 的密钥，后端分不出调用方是谁（请求都带着用户
   * 同一个会话 cookie）。真要隔离得把插件塞进 iframe 或 Worker，那样它就改
   * 不了控制台界面了 —— 而那是插件的主要用途。所以这里只是把暴露面从「一个
   * 集合」缩小到「一次一个」，没有变成一道墙。别把它当成墙。
   *
   * 这也是为什么设置界面在 secret 项旁边写着「只装你信得过的作者」，以及
   * 插件分区最上面那段警告不折叠。
   */
  app.get("/api/plugins/:id/config/runtime", (req, res) => {
    const { id } = req.params;
    if (!ID_RE.test(id)) return res.status(400).end();

    // 只给**正在生效**的插件（总开关开着、它自己开着、没坏）—— 关掉的插件
    // 不该还能被谁顺手把配置读出来
    const active = activePlugins().find((p) => p.id === id);
    if (!active) return res.status(404).end();

    const cfg = configFor(id, active.configSchema);
    if (!cfg) return res.status(404).end();
    res.set("cache-control", "no-store");
    res.json(cfg);
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

  /**
   * 某个插件的配置：schema（作者声明的）+ 当前值。
   *
   * secret 类型的值抹成占位再发 —— 浏览器里不该出现插件密钥的明文，
   * 控制台的网络面板、截图、录屏都会把它带出去。
   */
  app.get("/api/plugins/:id/config", (req, res) => {
    const { id } = req.params;
    if (!ID_RE.test(id)) return res.status(400).json({ error: "插件 id 不合规" });

    const p = listPlugins().plugins.find((x) => x.id === id);
    if (!p) return res.status(404).json({ error: "没装这个插件" });
    if (p.broken) return res.status(400).json({ error: `这个插件有问题：${p.broken}` });

    const schema = p.configSchema ?? [];
    res.json({ schema, values: resolveConfig(schema, readConfigValues(id), { mask: true }) });
  });

  /** 保存配置。校验见 validateConfigValues —— body 是浏览器发来的，一个字段都不能信。 */
  app.put("/api/plugins/:id/config", (req, res) => {
    const { id } = req.params;
    if (!ID_RE.test(id)) return res.status(400).json({ error: "插件 id 不合规" });

    const p = listPlugins().plugins.find((x) => x.id === id);
    if (!p) return res.status(404).json({ error: "没装这个插件" });
    if (p.broken) return res.status(400).json({ error: `这个插件有问题：${p.broken}` });

    const schema = p.configSchema ?? [];
    if (schema.length === 0) return res.status(400).json({ error: "这个插件没有可配置的项" });

    const stored = readConfigValues(id);
    const out = validateConfigValues(schema, req.body?.values, stored);
    if (out.error) return res.status(400).json({ error: out.error });

    writeJson(configPathFor(id), out.values);
    logInfo("插件", `${p.name}（${id}）的配置已保存`);
    // 回的是抹过的那份，前端直接拿去更新界面
    res.json({ schema, values: resolveConfig(schema, out.values, { mask: true }) });
  });

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
