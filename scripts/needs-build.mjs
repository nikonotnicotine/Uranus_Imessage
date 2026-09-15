/**
 * 判断前端产物要不要重新构建。
 *
 * 可以当模块用，也可以直接命令行跑：
 *   node scripts/needs-build.mjs
 *   exit 0 = dist 是最新的，直接用
 *   exit 1 = dist 不存在或比源码旧，需要 npm run build
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 改这些东西就得重新构建
const INPUTS = [
  "client/src",
  "client/index.html",
  "client/instagram.html",
  "client/public",
  "client/vite.config.js",
  "client/tailwind.config.js",
  "client/postcss.config.js",
  "client/package.json",
];

/**
 * @returns {{stale: boolean, reason: string}}
 */
export function needsBuild() {
  const marker = path.join(root, "client/dist/index.html");
  if (!fs.existsSync(marker)) return { stale: true, reason: "dist 不存在" };

  // IG 是第二个入口，老的 dist 里没有它。少了这一份，6873 上发出去的会是
  // 控制台首页（entryFor 的退路），看着像端口没生效
  if (!fs.existsSync(path.join(root, "client/dist/instagram.html"))) {
    return { stale: true, reason: "dist 里没有 instagram.html" };
  }

  const builtAt = fs.statSync(marker).mtimeMs;

  /** 找出第一个比 dist 新的文件；没有就返回 null。 */
  function findNewer(target) {
    const abs = path.join(root, target);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      return null; // 可选输入（比如没有 public/）
    }

    if (st.isFile()) {
      return st.mtimeMs > builtAt ? target : null;
    }

    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const hit = findNewer(path.join(target, entry.name));
      if (hit) return hit;
    }
    return null;
  }

  const stale = INPUTS.map(findNewer).find(Boolean);
  return stale
    ? { stale: true, reason: `${stale} 比 dist 新` }
    : { stale: false, reason: "dist 是最新的" };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const r = needsBuild();
  console.log(r.reason);
  process.exit(r.stale ? 1 : 0);
}