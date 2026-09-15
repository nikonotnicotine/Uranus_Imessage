/**
 * 「检查更新」的离线验证。
 *
 * 这条路的正确性有三块，都能不联网验：
 *
 *  1. **版本号比大小**。它决定要不要在界面上问用户「要更新吗」，比错了就是
 *     误报（明明最新却天天催）或漏报（有新版一直不说）。`v` 前缀、段数不齐、
 *     预发布后缀、两位数版本号（`0.10.0` vs `0.9.0`）都是真会踩到的形状。
 *  2. **失败要说人话**。GitHub 在国内经常连不上，403 限流也常见。这几种情况
 *     必须各回一句能照着办的中文，而不是把 `TypeError: fetch failed` 摔给用户。
 *  3. **只查不装**。这个模块不许碰磁盘 —— 自动覆盖用户的文件是明确不做的事
 *     （见 update.js 文件头），所以这里确认它跑完之后数据目录里一个文件都没多。
 *
 * 网络请求全部靠替换 `globalThis.fetch` 假造，不打真的 GitHub：
 * 真去打的话这个脚本会在限流那一小时里无故失败，而且慢。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "uranus-upd-"));
process.env.URANUS_DATA_DIR = TMP;

let pass = 0;
let fail = 0;
function check(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    pass += 1;
    console.log(`  ✓ ${name}`);
    return;
  }
  fail += 1;
  console.log(`  ✗ ${name}\n      得到 ${JSON.stringify(got)}\n      期望 ${JSON.stringify(want)}`);
}
function checkThat(name, cond, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? `  ${detail}` : ""}`);
  }
}

const U = await import("../server/src/update.js");

/** 造一个假的 fetch 响应。 */
function reply(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** 把 globalThis.fetch 换成一个固定回答，返回收到的请求供断言。 */
function stub(answer) {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    if (typeof answer === "function") return answer(url, init);
    return answer;
  };
  return seen;
}

const RELEASE = {
  tag_name: "v0.9.0",
  name: "0.9.0 —— 测试用",
  body: "修了几个东西。",
  html_url: "https://github.com/nikonotnicotine/Uranus_Imessage/releases/tag/v0.9.0",
  published_at: "2026-09-15T00:00:00Z",
};

console.log("\n=== 1. 版本号比大小 ===");
{
  const c = U.compareVersions;
  check("v 前缀不影响", c("v0.2.0", "0.2.0"), 0);
  check("0.2.0 比 0.1.0 新", c("0.2.0", "0.1.0"), 1);
  check("0.1.0 比 0.2.0 旧", c("0.1.0", "0.2.0"), -1);
  check("段数不齐补 0：0.2 == 0.2.0", c("0.2", "0.2.0"), 0);
  check("主版本压过次版本", c("1.0.0", "0.99.99"), 1);
  // 按位数比会把 0.9 判成比 0.10 新 —— 这是版本比较最经典的错法
  check("0.10.0 比 0.9.0 新（不是按字符串比）", c("v0.10.0", "v0.9.0"), 1);
  // 预发布后缀当正式版比。真出现了，「相等」= 不提示，比误报安全
  check("预发布后缀忽略", c("0.2.0-beta.1", "0.2.0"), 0);
  check("读不出来的版本号当 0", c("说不清", "0.0.0"), 0);
}

console.log("\n=== 2. 本地版本号 ===");
{
  const v = U.localVersion();
  checkThat("从根 package.json 读到了版本号", /^\d+\.\d+\.\d+/.test(v), `得到 ${JSON.stringify(v)}`);
}

console.log("\n=== 3. 有新版 ===");
{
  U.clearUpdateCache();
  const seen = stub(reply(200, RELEASE));
  const r = await U.checkUpdate({ force: true });
  check("ok", r.ok, true);
  // 本地是 0.1.x，远端造的是 0.9.0
  check("认出有新版", r.hasUpdate, true);
  check("远端版本号原样带上（界面上要显示）", r.latest, "v0.9.0");
  check("更新说明带上", r.notes, "修了几个东西。");
  check("链接指向那个 release", r.url, RELEASE.html_url);
  checkThat("带上了当前版本，界面能写「你现在是 vX」", Boolean(r.current));
  checkThat("请求打的是 releases/latest", seen[0]?.url.endsWith("/releases/latest"));
  // 不带 UA 的话 GitHub 直接 403，这条踩过
  checkThat("请求带了 User-Agent", Boolean(seen[0]?.init?.headers?.["User-Agent"]));
  checkThat("请求带了超时", Boolean(seen[0]?.init?.signal));
}

console.log("\n=== 4. 已是最新 / 比本地还旧 ===");
{
  U.clearUpdateCache();
  stub(reply(200, { ...RELEASE, tag_name: `v${U.localVersion()}` }));
  const same = await U.checkUpdate({ force: true });
  check("和本地同版本：不提示更新", [same.ok, same.hasUpdate], [true, false]);

  U.clearUpdateCache();
  stub(reply(200, { ...RELEASE, tag_name: "v0.0.1" }));
  const older = await U.checkUpdate({ force: true });
  check("远端比本地旧：也不提示", [older.ok, older.hasUpdate], [true, false]);
}

console.log("\n=== 5. 缓存 ===");
{
  U.clearUpdateCache();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return reply(200, RELEASE);
  };
  await U.checkUpdate();
  const second = await U.checkUpdate();
  check("十五分钟内第二次不再打网络", calls, 1);
  check("第二次标了 cached，界面据此说「再点一次会重新查」", second.cached, true);
  const forced = await U.checkUpdate({ force: true });
  check("force 跳过缓存", calls, 2);
  check("force 拿到的不算 cached", forced.cached, false);
  // 「清理缓存」那个按钮要能把这份也清掉，不然刚发的版本要等一刻钟才看得见
  check("clearUpdateCache 报告清掉了一份", U.clearUpdateCache(), true);
  check("再清一次就没有了", U.clearUpdateCache(), false);
}

console.log("\n=== 6. 失败要说人话 ===");
{
  const cases = [
    [404, "还没有发布过版本"],
    [403, "次数上限"],
    [429, "次数上限"],
    [500, "500"],
  ];
  for (const [status, want] of cases) {
    U.clearUpdateCache();
    stub(reply(status, { message: "nope" }));
    const r = await U.checkUpdate({ force: true });
    checkThat(
      `HTTP ${status}：ok=false 且原因里有「${want}」`,
      r.ok === false && String(r.error).includes(want),
      `得到 ${JSON.stringify(r.error)}`
    );
    checkThat(`HTTP ${status}：仍然带上仓库地址（还有一条出路）`, Boolean(r.repo));
    checkThat(`HTTP ${status}：报错里没有英文异常名`, !/TypeError|Error:/.test(String(r.error)));
  }

  // 传输层的三种失败：报错必须能照着办，不能只有「fetch failed」
  const net = [
    ["TimeoutError", "超时"],
    ["ENOTFOUND", "DNS"],
    ["ECONNRESET", "掐断"],
  ];
  for (const [code, want] of net) {
    U.clearUpdateCache();
    globalThis.fetch = async () => {
      const e = new TypeError("fetch failed");
      e.cause = Object.assign(new Error("boom"), { code });
      if (code === "TimeoutError") e.name = "TimeoutError";
      throw e;
    };
    const r = await U.checkUpdate({ force: true });
    checkThat(
      `${code}：原因里有「${want}」`,
      r.ok === false && String(r.error).includes(want),
      `得到 ${JSON.stringify(r.error)}`
    );
  }

  // 失败不该被缓存 —— 网络回来之后再点一次就该重试
  U.clearUpdateCache();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("x"), { code: "ECONNRESET" }),
    });
  };
  await U.checkUpdate();
  await U.checkUpdate();
  check("失败不进缓存，再点一次会真的重试", calls, 2);
}

console.log("\n=== 7. 更新说明太长要截断 ===");
{
  U.clearUpdateCache();
  stub(reply(200, { ...RELEASE, body: "很长的一段。".repeat(500) }));
  const r = await U.checkUpdate({ force: true });
  checkThat("截到 1300 字以内", r.notes.length < 1300, `得到 ${r.notes.length} 字`);
  checkThat("末尾说明了还有更多", r.notes.includes("还有更多"));
}

console.log("\n=== 8. 只查不装 ===");
{
  // 这个模块明确不下载、不解压、不覆盖任何文件（见 update.js 文件头）。
  // 跑完之后数据目录里一个文件都不该多出来
  U.clearUpdateCache();
  stub(reply(200, RELEASE));
  await U.checkUpdate({ force: true });
  const left = fs.existsSync(TMP) ? fs.readdirSync(TMP) : [];
  check("数据目录里什么都没多出来", left, []);
}

console.log("\n=== 9. 仓库地址和作者 ===");
{
  check("仓库地址", U.REPO_URL, "https://github.com/nikonotnicotine/Uranus_Imessage");
  check("作者主页", U.AUTHOR_URL, "https://github.com/nikonotnicotine");
  // 文档里那几处链接必须和代码里的同一个，改一边忘另一边就会指错
  for (const file of ["README.md", "LICENSE", "CHANGELOG.md"]) {
    const p = path.join(ROOT, file);
    checkThat(`${file} 存在`, fs.existsSync(p));
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, "utf-8");
    checkThat(`${file} 里有仓库地址`, text.includes(U.REPO_URL));
    checkThat(`${file} 里有 QQ 群号`, text.includes("1125033956"));
  }
  const license = fs.readFileSync(path.join(ROOT, "LICENSE"), "utf-8");
  for (const must of ["成年人", "商业平台", "学习与参考", "违法"]) {
    checkThat(`LICENSE 里写明了「${must}」`, license.includes(must));
  }
}

fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
