/**
 * 检查有没有新版本。
 *
 * ── 为什么要有这个 ──
 *
 * 这个程序是「下载一个文件夹自己跑」的形态，不走应用商店、也没有包管理器。
 * 用户装完之后就再也不知道外面有没有更新了 —— 出了修好的 BUG 也照旧踩着。
 * 群里问「我这个是最新的吗」是常见问题。
 *
 * ── 它只查，不装 ──
 *
 * 这个文件**不下载、不解压、不覆盖任何文件**。原因不是懒：
 *
 *  - 自动覆盖会踩到用户改过的东西（不少人手动改过 .bat、加过自己的壁纸），
 *    而这里没有任何「哪些文件是用户的」的判据；
 *  - 更新经常伴随 `npm install`（依赖变了）和一次前端构建，这两步在一个
 *    正在运行的 Node 进程里做，等于给自己换轮胎；
 *  - 最要紧的是 `data/` —— 一次没测好的自动更新能把聊天记录和记忆库弄没，
 *    那是重建不出来的东西。
 *
 * 所以界面上的流程是：查到有新版 → 在按钮旁边问一句「要不要更新」→ 用户点
 * 「去更新」就把 Release 页面打开，剩下的按那页的说明手动做。这也是为什么
 * 返回值里有 `notes` 和 `url`：那两样是用户做决定要看的东西。
 *
 * ── 版本号从哪来 ──
 *
 * 本地版本读根 package.json 的 `version`（发版时改那一处，两个 workspace
 * 的 version 无人读）。远端版本读 GitHub 的 latest release 的 tag。
 *
 * 这个文件不 import config.js —— 检查更新和用户的配置无关（不需要密钥、
 * 不看服务商），拿 GitHub 的公开接口就够了。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { logDebug, logInfo, logWarn } from "./logs.js";
import { netCode, proxyFor, usesProxy } from "./proxy.js";

/**
 * 项目根目录（放着那份 package.json）。
 *
 * 自己算而不是从 datadir.js 拿：那边的 ROOT 没导出，而这里要的只是
 * 「版本号写在哪个文件里」这一件事，为它去改 datadir 的导出面不值得。
 */
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** 仓库地址。检查更新和界面上那几个链接都指这里。 */
export const REPO_URL = "https://github.com/nikonotnicotine/Uranus_Imessage";

/** 作者主页。README 和「关于」里都用它。 */
export const AUTHOR_URL = "https://github.com/nikonotnicotine";

/** 问 GitHub 要「最新的那个 release」。公开仓库不需要 token。 */
const LATEST_API = "https://api.github.com/repos/nikonotnicotine/Uranus_Imessage/releases/latest";

/**
 * 查一次要等多久。
 *
 * 30 秒 —— 用户正盯着那个按钮，和「测试连接」同一个量级。GitHub 在国内经常
 * 是半死不活的状态，等更久也多半等不到，不如早点告诉他「网络不通」。
 */
const TIMEOUT = 30_000;

/**
 * 缓存多久。
 *
 * 检查更新是个「点一下就走」的动作，但用户会连点、会切来切去。GitHub 的
 * 匿名接口按 IP 限 60 次/小时，缓存一刻钟足够挡住手滑，也不至于让刚发的
 * 新版半天看不见。**只缓存成功的结果** —— 失败要让用户再点一次就重试。
 */
const CACHE_TTL = 15 * 60 * 1000;

let cache = null; // { at: number, result: object }

/* ================= 版本号 ================= */

/**
 * 读本地版本。
 *
 * 读不出来时返回空串而不是抛 —— 「不知道自己是哪个版本」不该让检查更新整个
 * 失败，界面上还是可以告诉用户外面最新是多少。
 */
export function localVersion() {
  try {
    const raw = fs.readFileSync(path.join(ROOT_DIR, "package.json"), "utf-8");
    return String(JSON.parse(raw)?.version ?? "").trim();
  } catch (e) {
    logWarn("更新", "读不出本地版本号（package.json）", e);
    return "";
  }
}

/**
 * 把版本号切成数字段。
 *
 * 认 `v` 前缀（GitHub 的 tag 习惯写 `v0.2.0`），认 `0.2.0-beta.1` 这种后缀
 * （`-` 后面的整段丢掉，见 compareVersions 的注释）。段数不齐的补 0，
 * 所以 `0.2` 和 `0.2.0` 相等。
 */
function parts(v) {
  const core = String(v ?? "")
    .trim()
    .replace(/^v/i, "")
    .split(/[-+]/)[0];
  return core.split(".").map((s) => {
    const n = Number.parseInt(s, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

/**
 * 比版本号：a 比 b 新返回正数，旧返回负数，一样返回 0。
 *
 * 预发布后缀（`-beta.1`）一律**当成正式版比**，也就是 `0.2.0-beta.1` 和
 * `0.2.0` 相等。这是故意的：真正的 semver 规则里预发布小于正式版，但这个
 * 项目的 release 不打预发布 tag（云备份倒是会建 prerelease，那是另一回事），
 * 为一个不会出现的情况写一套 semver 排序不值得。真出现了，「相等」的后果只是
 * 不提示更新，比反过来误报安全。
 *
 * @returns {number}
 */
export function compareVersions(a, b) {
  const x = parts(a);
  const y = parts(b);
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/* ================= 远端 ================= */

/**
 * 更新说明截到这么长。
 *
 * Release notes 可以写得很长（带完整 diff 列表的那种）。界面上那块是按钮旁边
 * 的一小段，读者要的是「值不值得现在更」，不是全文 —— 全文点链接过去看。
 */
const MAX_NOTES = 1200;

function clipNotes(text) {
  const s = String(text ?? "").trim();
  if (!s) return "";
  if (s.length <= MAX_NOTES) return s;
  return `${s.slice(0, MAX_NOTES).trimEnd()}\n…（还有更多，点「去看看」读完整说明）`;
}

/**
 * 把 fetch 的失败翻成能照着办的中文。
 *
 * 和 cloud/net.js 的 explainNetwork 同一个思路，但没复用它：那边是绑定了
 * 「云备份」这个 scope 和重试策略的一整套；这边只有一次 GET，而且一次失败
 * 就该告诉用户「网络不通，回头再点」—— 检查更新不是非成功不可的动作，
 * 静默重试三次只会让按钮转得更久。
 *
 * 也没直接用 proxy.js:whyNetwork：那个说的是通用的「连不上目标」，而这里每一句
 * 都要落到「过一会儿再点一次，或者直接打开仓库页面看」这个具体动作上 ——
 * 检查更新失败了用户该干什么，比错误码本身有用。
 *
 * **但错误码是借它挖的**（`netCodes`，不是 `e.cause.code`）。原来只挖一层，
 * 于是 `AggregateError`（国内连 GitHub 最常见的那种：IPv6 和 IPv4 都不通）
 * 一个码都读不到，最后那句兜底连括号里的码都是空的，剩下一句「连不上 GitHub」。
 */
function explain(e) {
  const code = netCode(e) || String(e?.name ?? "").trim();
  if (code === "TimeoutError" || code.includes("TIMEOUT") || code === "ETIMEDOUT") {
    return "连 GitHub 超时了。国内直连 GitHub 经常这样，过一会儿再点一次，或者直接打开仓库页面看。";
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return "解析不了 api.github.com，先看看这台机器的网络和 DNS。";
  }
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET" || code === "EPIPE") {
    return "连接被中途掐断了。过一会儿再点一次，或者直接打开仓库页面看。";
  }
  // 这一类出厂不勾代理，而国内直连 GitHub 时好时坏 —— 所以兜底那句要提一下代理
  const via = usesProxy("update") ? "" : "（这一类没走代理，去控制台的「代理」那节可以勾上）";
  return `连不上 GitHub${code ? `（${code}）` : ""}${via}。过一会儿再点一次，或者直接打开仓库页面看。`;
}

/**
 * 去 GitHub 问一次最新版本。
 *
 * @returns {Promise<{tag: string, name: string, notes: string, url: string, at: string}>}
 */
async function fetchLatest() {
  const res = await fetch(LATEST_API, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      // GitHub 要求带 UA，不带的话直接 403
      "User-Agent": "Uranus-iMessage",
    },
    signal: AbortSignal.timeout(TIMEOUT),
    ...(await proxyFor("update")),
  });

  // 404 是「这个仓库还没发过 release」，不是错误 —— 分开说，
  // 不然用户会以为是自己网络或者地址填错了
  if (res.status === 404) {
    const e = new Error("仓库上还没有发布过版本，所以查不到「最新版」。过一阵子再来看看。");
    e.soft = true;
    throw e;
  }
  if (res.status === 403 || res.status === 429) {
    const e = new Error(
      "GitHub 暂时不让查了（匿名请求每小时有次数上限）。等一小时，或者直接打开仓库页面看。"
    );
    e.soft = true;
    throw e;
  }
  if (!res.ok) {
    // 也标 soft：状态码已经是「查不到的原因」本身了，再经 explain() 一道
    // 会被当成传输层失败、翻成「连不上 GitHub」—— 明明是连上了才拿到的码
    const e = new Error(
      `GitHub 返回 ${res.status}。过一会儿再点一次，或者直接打开仓库页面看。`
    );
    e.soft = true;
    throw e;
  }

  const raw = await res.json();
  return {
    tag: String(raw?.tag_name ?? "").trim(),
    name: String(raw?.name ?? "").trim(),
    notes: clipNotes(raw?.body),
    url: String(raw?.html_url ?? "").trim() || `${REPO_URL}/releases/latest`,
    at: String(raw?.published_at ?? "").trim(),
  };
}

/* ================= 对外 ================= */

/**
 * 检查更新。
 *
 * 返回的 `ok` 只说明「查到了没有」，`hasUpdate` 才是「要不要更新」。
 * 两个分开是因为界面上要显示三种不同的东西：查不到（说原因 + 给仓库链接）、
 * 已是最新（一句话）、有新版（问一句要不要更新 + 更新说明 + 链接）。
 *
 * @param {{force?: boolean}} [opts] force=true 跳过缓存（界面上再点一次时用）
 */
export async function checkUpdate({ force = false } = {}) {
  const current = localVersion();

  if (!force && cache && Date.now() - cache.at < CACHE_TTL) {
    logDebug("更新", "用的是十五分钟内查过的结果（点第二次会重新查）");
    return { ...cache.result, cached: true, current };
  }

  try {
    const latest = await fetchLatest();
    const newer = Boolean(current) && Boolean(latest.tag) && compareVersions(latest.tag, current) > 0;
    const result = {
      ok: true,
      hasUpdate: newer,
      current,
      latest: latest.tag,
      name: latest.name,
      notes: latest.notes,
      url: latest.url,
      publishedAt: latest.at,
      repo: REPO_URL,
    };
    cache = { at: Date.now(), result };
    logInfo(
      "更新",
      newer
        ? `有新版本：${latest.tag}（当前 ${current || "版本号读不出来"}）`
        : `已经是最新的（${current || "版本号读不出来"}）`
    );
    return { ...result, cached: false };
  } catch (e) {
    const text = e?.soft ? String(e.message) : explain(e);
    // soft 的那几种（还没发过版、被限流）不是故障，用 info 记；真连不上才 warn
    if (e?.soft) logInfo("更新", `没查到最新版本：${text}`);
    else logWarn("更新", "检查更新失败", e);
    return { ok: false, hasUpdate: false, current, error: text, repo: REPO_URL };
  }
}

/** 清掉缓存。挂在「清理缓存」那个按钮上（见 maintenance.js）。 */
export function clearUpdateCache() {
  const had = Boolean(cache);
  cache = null;
  return had;
}
