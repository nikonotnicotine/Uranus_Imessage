/**
 * 后台界面的壁纸：文件落盘 + 一份「用哪张、遮罩多浓」的设置。
 *
 * 为什么不进 config.json：保存配置会顺带 syncBridges（见 index.js 的
 * PUT /api/config），换张壁纸把所有 Photon 线路重启一遍显然不合理。
 * 而且配置是「草稿 + 点保存」的模型，壁纸要的是点一下立刻变。
 * 所以这里自己管一个 data/wallpapers/，即时生效，也不进备份包
 * （backup.js 只打包配置，图片本来也不该塞进去）。
 *
 * 图片有两个来源，合成一份清单：
 *
 *   assets/wallpapers/   随代码发的内置壁纸。只读 —— 界面上删不掉，
 *                        用户也不该删（删了得重新拉代码才回得来）。
 *   data/wallpapers/     用户自己传的。可增可删。
 *
 * 后缀白名单和 MIME 表直接复用 media.js 的 —— 参考图认哪几种，壁纸就认哪几种，
 * 没必要在两个文件里各维护一张表。
 */

import fs from "node:fs";
import path from "node:path";

import { BUILTIN_WALLPAPER_DIR, WALLPAPER_DIR, ensureLayout } from "./datadir.js";
import { REF_EXTS, safeUploadName } from "./media.js";

/** 遮罩不透明度的默认值。0.82 是「看得清正文，也看得见壁纸」的折中。 */
export const DEFAULT_VEIL = 0.82;

/**
 * 全新安装时用哪张、遮罩多浓 —— 没有 settings.json 才走这里。
 *
 * 两张内置壁纸都接近纯白（一张纸质拼贴、一张浅灰蓝渐变），按 DEFAULT_VEIL 那个
 * 0.82 压下去等于什么都看不见，所以这里单给一个 0.2：新用户一进来就该看见壁纸，
 * 而这两张本来就淡到不影响正文。用户自己传的图深浅未知，那条路照旧用 0.82。
 */
const FRESH_DEFAULT = { current: "壁纸2.jpg", veil: 0.2 };

/**
 * 遮罩最低只能调到 0.2。
 *
 * 全站是纯白底 + #d8d8d8 的 1px 线，遮罩再淡下去正文和分隔线就糊在壁纸里了 ——
 * 与其让用户把界面调到读不了，不如在这儿兜住。
 */
const VEIL_MIN = 0.2;

const SETTINGS_PATH = path.join(WALLPAPER_DIR, "settings.json");

/** 一个文件夹里合法的壁纸文件。读不了就当空的 —— 壁纸坏了不该让后台打不开。 */
function scanDir(dir) {
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    if (!REF_EXTS.includes(path.extname(f).toLowerCase())) continue;
    let size = 0;
    try {
      size = fs.statSync(path.join(dir, f)).size;
    } catch {
      continue; // 刚被删掉之类，跳过就好
    }
    out.push({ file: f, size });
  }
  out.sort((a, b) => a.file.localeCompare(b.file));
  return out;
}

/** assets/wallpapers/ 里那几张。 */
export function listBuiltinWallpapers() {
  return scanDir(BUILTIN_WALLPAPER_DIR).map((w) => ({ ...w, builtin: true }));
}

/** 这个名字是内置壁纸吗。删除那条路要用它挡一下。 */
export function isBuiltinWallpaper(file) {
  const base = path.basename(String(file ?? "").trim());
  if (!base) return false;
  return listBuiltinWallpapers().some((w) => w.file === base);
}

/**
 * 界面上能选的全部壁纸：内置的排前面，用户自己传的排后面。
 *
 * 用户传了个和内置**同名**的文件时以用户的为准（内置那条从清单里去掉）——
 * 一个名字对应一张图，清单里出现两个一样的 file 会让前端的 key 撞上，
 * resolveWallpaper 也会挑得莫名其妙。新上传的名字由 safeWallpaperName 兜住，
 * 撞不上；这里防的是老用户手动往文件夹里丢的重名文件。
 *
 * settings.json 也在 data/wallpapers/ 里，靠后缀白名单自然被滤掉。
 */
export function listWallpapers() {
  const mine = scanDir(WALLPAPER_DIR);
  const taken = new Set(mine.map((w) => w.file));
  return [...listBuiltinWallpapers().filter((w) => !taken.has(w.file)), ...mine];
}

/**
 * 文件名 → 那个文件的绝对路径。找不到返回 null。
 *
 * 先找 data/wallpapers/，再回落到内置的 —— 和 listWallpapers 的「同名以用户的
 * 为准」保持一致。
 *
 * 安全边界和 media.js 的 resolveRefFile 一样：`path.basename` 挡路径穿越
 * （`../../data.config.json` 到这儿只剩 `data.config.json`），点开头的挡掉，
 * 后缀必须在白名单里 —— 所以 settings.json、data.config.json 都读不到。
 */
export function resolveWallpaper(file) {
  const base = path.basename(String(file ?? "").trim());
  if (!base || base.startsWith(".")) return null;
  if (!REF_EXTS.includes(path.extname(base).toLowerCase())) return null;
  for (const dir of [WALLPAPER_DIR, BUILTIN_WALLPAPER_DIR]) {
    const full = path.join(dir, base);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

/**
 * 上传上来的文件名 → 能安全落盘的文件名。规矩在 media.js 的 safeUploadName 里，
 * 这里只补上壁纸自己那条：**内置壁纸的名字也算重名** —— 传一张「壁纸2.jpg」
 * 上来应该变成「壁纸2-2.jpg」，而不是把内置那张挤下去（内置的删不掉，
 * 一旦重名，listWallpapers 会把内置那条藏起来，看着就像内置壁纸没了）。
 */
export function safeWallpaperName(raw, mimeType) {
  const builtin = new Set(listBuiltinWallpapers().map((w) => w.file));
  return safeUploadName({
    raw,
    mimeType,
    fallback: "壁纸",
    taken: (name) => builtin.has(name) || fs.existsSync(path.join(WALLPAPER_DIR, name)),
  });
}

/** 写一张壁纸到 data/wallpapers/，返回最终落盘的文件名。 */
export function saveWallpaper(rawName, base64, mimeType) {
  ensureLayout();
  const name = safeWallpaperName(rawName, mimeType);
  fs.writeFileSync(path.join(WALLPAPER_DIR, name), Buffer.from(String(base64 ?? ""), "base64"));
  return name;
}

/**
 * 删一张壁纸。删的正好是当前那张时，把设置里的 current 一并清空 ——
 * 否则界面会去请求一个已经不存在的文件，白底上什么都没有还不知道为什么。
 *
 * 内置壁纸**抛错**而不是返回 false：它确实存在，只是不给删，
 * 和「找不到这张壁纸」是两回事，前端该说清楚是哪一种。
 */
export function removeWallpaper(file) {
  const base = path.basename(String(file ?? "").trim());
  if (base && isBuiltinWallpaper(base) && !fs.existsSync(path.join(WALLPAPER_DIR, base))) {
    throw new Error("这是内置壁纸，删不了");
  }
  const full = resolveWallpaper(file);
  if (!full) return false;
  fs.rmSync(full, { force: true });
  const settings = readWallpaperSettings();
  if (settings.current === path.basename(full)) {
    writeWallpaperSettings({ ...settings, current: "" });
  }
  return true;
}

/** current 夹到「清单里真有这张」，veil 夹到 [0.2, 1]。 */
function clampSettings(raw) {
  const veil = Number(raw?.veil);
  const current = path.basename(String(raw?.current ?? "").trim());
  const exists = current && listWallpapers().some((w) => w.file === current);
  return {
    current: exists ? current : "",
    veil: Number.isFinite(veil) ? Math.min(1, Math.max(VEIL_MIN, veil)) : DEFAULT_VEIL,
  };
}

/**
 * 读设置。
 *
 * 没有 settings.json（全新安装，或者用户把它删了）时给内置默认值 ——
 * 新用户一进后台就是壁纸2，不用先去设置里选一次。
 *
 * 文件**存在**就完全照它来，哪怕 current 是空字符串 —— 那是用户主动点了
 * 「不用壁纸」，不能被默认值顶回去。current 还会跟实际文件对一遍：
 * 文件被用户手动删掉时，这里当它没设过。
 */
export function readWallpaperSettings() {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
  } catch {
    /* 没有这个文件、或者内容被改坏了，都走内置默认值 */
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    const fresh = clampSettings(FRESH_DEFAULT);
    // assets/ 被删了之类，内置那张也不在了 —— 退回纯白底，别硬指一个不存在的文件
    return fresh.current ? fresh : { current: "", veil: DEFAULT_VEIL };
  }
  return clampSettings(raw);
}

/** 写设置。current 必须真的在清单里（内置的也算），veil 夹到 [0.2, 1]。 */
export function writeWallpaperSettings(next) {
  ensureLayout();
  const value = clampSettings(next);
  const tmp = `${SETTINGS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
  fs.renameSync(tmp, SETTINGS_PATH);
  return value;
}
