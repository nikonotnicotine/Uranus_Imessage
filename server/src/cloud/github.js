/**
 * GitHub Release 当云备份的落点：一份快照 = 一个 release + 挂在它下面的
 * 一个 asset。
 *
 * ── 为什么是 Release 而不是仓库文件 ──
 *
 * Contents API（往仓库里提交文件）要把内容 base64 编码塞进 JSON body，
 * 91MB 的包会膨胀到 120MB+，而且每次备份都在 git 历史里留一个几十 MB 的
 * blob —— 仓库会越来越大，而且**没法真正删掉**（历史里还在）。
 *
 * Release asset 是走对象存储的，raw 二进制直传，单文件上限 2GiB（实践中
 * 按 2GB 算更安全，有人在正好 2GiB 上踩到过 500），删掉就真的没了。
 *
 * ── 需要的权限 ──
 *
 * fine-grained token，只给那一个仓库的 **Contents: write**。经典 token 的
 * `repo` scope 也行但范围大得多，界面上推荐前者。
 *
 * ── 几个 API 细节 ──
 *
 *  - 上传走 `uploads.github.com`，**不是** `api.github.com`
 *  - 同名 asset 已存在会返回 422，得先删掉旧的
 *  - 下载 asset 要 `Accept: application/octet-stream`，而且要能跟 302
 *  - 删 release **不会**删掉它的 tag，得另外删一次 ref，不然仓库里会攒下
 *    一堆孤零零的 tag
 */

import fs from "node:fs";

import { makeNet, apiTimeout } from "./net.js";

const API = "https://api.github.com";
const UPLOADS = "https://uploads.github.com";

/** tag 前缀。列表靠它筛出「这是云备份」，别的 release 一个都不碰。 */
const TAG_PREFIX = "uranus-backup-";

const ACCEPT = "application/vnd.github+json";
const API_VERSION = "2022-11-28";

/* ================= 配置校验 ================= */

/** 和 s3.js 的 normalize 一个职责：缺了就抛中文，后面的动作不用再判。 */
export function normalize(raw) {
  const str = (v) => String(v ?? "").trim();
  const cfg = {
    owner: str(raw?.owner),
    repo: str(raw?.repo),
    token: str(raw?.token),
  };
  if (!cfg.owner) throw new Error("用户名/组织名（owner）没填");
  if (!cfg.repo) throw new Error("仓库名没填");
  if (!cfg.token) throw new Error("访问令牌（token）没填");

  // 常见手滑：把整个仓库地址粘进 owner，或者往 repo 里粘 `owner/repo`
  if (cfg.owner.includes("/") || cfg.owner.includes(":")) {
    throw new Error(`owner 里只填用户名或组织名，不要带斜杠 —— 现在填的是「${cfg.owner}」`);
  }
  if (cfg.repo.includes("/")) {
    const guess = cfg.repo.split("/").pop();
    throw new Error(`仓库名里不要带斜杠，只填仓库那一截（大概是「${guess}」）`);
  }
  return cfg;
}

function headers(cfg, extra = {}) {
  return {
    Accept: ACCEPT,
    Authorization: `Bearer ${cfg.token}`,
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": "uranus-imessage",
    ...extra,
  };
}

/* ================= 报错说人话 ================= */

/**
 * GitHub 的错误 body 是 JSON，`message` 那句是英文。翻成能照着办的中文。
 *
 * 401 和 404 在这儿是**同一件事的两种表现**：token 没权限访问私有仓库时
 * GitHub 故意返回 404（不泄露仓库是否存在），所以 404 的提示里两种可能
 * 都要提。
 */
function explain(status, body, cfg, what) {
  let msg = "";
  let errors = [];
  try {
    const parsed = JSON.parse(body ?? "");
    msg = parsed?.message ?? "";
    if (Array.isArray(parsed?.errors)) errors = parsed.errors;
  } catch {
    msg = String(body ?? "").slice(0, 200);
  }

  if (status === 401) {
    return "令牌无效或已过期，到 GitHub 的 Developer settings 里重新生成一个";
  }
  if (status === 403) {
    if (/rate limit/i.test(msg)) return "GitHub 的调用频率上限到了，过一会儿再试";
    return `没有权限。令牌需要这个仓库的 Contents: write 权限${msg ? `（GitHub 说：${msg}）` : ""}`;
  }
  if (status === 404) {
    return (
      `找不到仓库 ${cfg.owner}/${cfg.repo}。要么名字拼错了，` +
      "要么这个令牌没有它的访问权限（私有仓库权限不够时 GitHub 也返回 404）"
    );
  }
  if (status === 422) {
    // `Validation Failed` 这句话本身没有信息量，真正的原因在 errors[] 里
    return `GitHub 拒绝了这次${what}${msg ? `：${msg}` : ""}${detailLines(errors)}`;
  }
  return `GitHub 返回 ${status}${msg ? `：${msg}` : ""}${detailLines(errors)}`;
}

/** GitHub 那些机器词，翻成人话。认不出来的原样留着（总比丢了好）。 */
const ERROR_CODE = {
  missing: "指向的东西不存在",
  missing_field: "这个字段没填",
  invalid: "这个值不对",
  already_exists: "已经有一个同名的了",
  unprocessable: "服务端处理不了这个值",
};

/**
 * 把 422 的 `errors[]` 摊成几行中文。
 *
 * GitHub 的形状是 `{message, errors: [{resource, field, code, message}]}`，
 * `code` 是机器词，`custom` 那种会额外带一句 `message`。举个真的：
 *
 *     {"resource":"Release","code":"invalid","field":"target_commitish"}
 *
 * 摊出来是 `· target_commitish 这个值不对`。少了这一步，用户看到的就只有
 * 「Validation Failed」，压根不知道该改哪儿 —— 这正是这次要修的毛病。
 */
function detailLines(errors) {
  const lines = [];
  for (const e of errors ?? []) {
    const field = String(e?.field ?? "").trim();
    const code = String(e?.code ?? "").trim();
    const own = String(e?.message ?? "").trim();
    const why = own || ERROR_CODE[code] || code;
    if (!field && !why) continue;
    lines.push(`  · ${field ? `${field} ` : ""}${why}${own && code ? `（${code}）` : ""}`);
  }
  return lines.length ? `\n${lines.join("\n")}` : "";
}

/* ================= 请求 ================= */

/**
 * 网络层（重试 + 把 `TypeError: fetch failed` 翻成中文）在 net.js 里，
 * 两家云共用。这里只补一句 GitHub 特有的话。
 */
const { fetch: netFetch } = makeNet({
  who: "GitHub",
  hint:
    "GitHub 的连接在有些网络下本来就是断断续续的 —— 刚才「测试连接」过了、" +
    "一分钟后备份却连不上，多半就是这个。要是老这样，改用缤纷云那条路更省事。" +
    "\n另外 Node 不认系统代理：就算你开着代理软件，这里的请求也是直连出去的。",
});

/**
 * HTTP 状态码挂在 Error 上，调用方靠它分支。
 *
 * 别去 match 报错文本 —— 那句话是给人看的，改一个字就把判断改坏了。
 */
function httpFail(status, text, cfg, what) {
  const err = new Error(explain(status, text, cfg, what));
  err.status = status;
  return err;
}

/** 读一点响应体出来给报错用，读不出来也不能让报错本身挂掉。 */
async function bodyText(res) {
  try {
    return await res.text();
  } catch {
    return ""; // 读不出来就用状态码说话
  }
}

/** 发一个 API 请求，非 2xx 就抛中文。 */
async function call(cfg, path, { method = "GET", body, what = "请求" } = {}) {
  const res = await netFetch(
    `${API}${path}`,
    {
      method,
      headers: headers(cfg, body ? { "Content-Type": "application/json" } : {}),
      body: body ? JSON.stringify(body) : undefined,
      signal: apiTimeout(),
    },
    what
  );
  if (!res.ok) throw httpFail(res.status, await bodyText(res), cfg, what);
  if (res.status === 204) return null;
  return res.json();
}

/* ================= 四个动作 ================= */

/** 快照文件名 → tag 名。 */
function tagFor(name) {
  return `${TAG_PREFIX}${String(name).replace(/\.tar\.gz$/, "")}`;
}

/**
 * 传一份快照上去：建 release → 上传 asset。
 *
 * `prerelease: true` 是有意的 —— 不然每次备份都会把仓库的「Latest release」
 * 顶掉，那个位置是给真正的版本发布用的。
 *
 * 同名 tag 已经存在（同一分钟内点了两次）就复用那个 release，并把里面的
 * 同名 asset 先删掉 —— GitHub 对重名 asset 返回 422。
 */
export async function put(raw, name, file, bytes) {
  const cfg = normalize(raw);
  const tag = tagFor(name);

  let release = await findRelease(cfg, tag);
  if (!release) {
    try {
      release = await call(cfg, `/repos/${cfg.owner}/${cfg.repo}/releases`, {
        method: "POST",
        what: "创建 release",
        body: {
          tag_name: tag,
          name: `数据备份 ${name.replace(/^uranus-data-|\.tar\.gz$/g, "")}`,
          body: "Uranus iMessage 的自动数据备份。这个 release 由程序管理，别手动改。",
          prerelease: true,
        },
      });
    } catch (e) {
      /*
       * 422 最常见的原因是**空仓库**：建 release 会顺手打一个 tag，tag 必须
       * 指向一个 commit，而刚建好还没提交过的仓库里没有任何 commit 可指。
       * GitHub 只回一句 `Validation Failed`，人是猜不到的 —— 所以这里探一次，
       * 把它说明白。
       *
       * 探不出来就**原样往上抛**（带 errors[] 的那句）：这个判断可能是错的，
       * 那种情况下用户至少还能看到 GitHub 自己的说法，不会被我们的猜测带偏。
       *
       * 只查、不写。程序没有理由往用户的仓库里塞一个 commit —— 那是他自己
       * 的仓库，提交这件事该他点。
       */
      if (e?.status === 422 && (await isRepoEmpty(cfg))) {
        throw new Error(
          `仓库 ${cfg.owner}/${cfg.repo} 里还没有任何提交，GitHub 不能在空仓库上建 release` +
            "（release 必须挂在一个 commit 上）。" +
            "\n去仓库页面点「Add a README」提交一次，然后回来再点「立即备份」。"
        );
      }
      throw e;
    }
  } else {
    // 复用旧 release：同名 asset 得先清掉
    for (const a of release.assets ?? []) {
      if (a?.name === name) await dropAsset(cfg, a.id);
    }
  }

  const res = await netFetch(
    `${UPLOADS}/repos/${cfg.owner}/${cfg.repo}/releases/${release.id}/assets` +
      `?name=${encodeURIComponent(name)}`,
    // 函数形式：每次重试都得重新开一个读流
    () => ({
      method: "POST",
      headers: headers(cfg, {
        "Content-Type": "application/gzip",
        "Content-Length": String(bytes),
      }),
      body: fs.createReadStream(file),
      duplex: "half",
    }),
    "上传"
  );
  if (!res.ok) throw httpFail(res.status, await bodyText(res), cfg, "上传");
  return { key: tag, bytes };
}

/**
 * 这个仓库是不是一个 commit 都没有？
 *
 * GitHub 对空仓库的 commits 接口返回 **409 Git Repository is empty** ——
 * 这是官方给的明确信号，比去猜默认分支存不存在可靠。
 *
 * 直接用 netFetch 而不走 `call()`：后者非 2xx 就抛，而这里 409 恰恰是想要的
 * 答案。任何异常都返回 false —— 这是个**诊断**动作，它自己失败不该盖掉正在
 * 报的那个真错误。
 */
async function isRepoEmpty(cfg) {
  try {
    const res = await netFetch(
      `${API}/repos/${cfg.owner}/${cfg.repo}/commits?per_page=1`,
      { headers: headers(cfg), signal: apiTimeout() },
      "查询提交记录"
    );
    if (res.status === 409) return true;
    if (!res.ok) return false;
    const items = await res.json();
    return Array.isArray(items) && items.length === 0;
  } catch {
    return false;
  }
}

/** 按 tag 找 release，没有返回 null。 */
async function findRelease(cfg, tag) {
  const res = await netFetch(
    `${API}/repos/${cfg.owner}/${cfg.repo}/releases/tags/${encodeURIComponent(tag)}`,
    { headers: headers(cfg), signal: apiTimeout() },
    "查询 release"
  );
  if (res.status === 404) return null;
  if (!res.ok) throw httpFail(res.status, await bodyText(res), cfg, "查询 release");
  return res.json();
}

async function dropAsset(cfg, assetId) {
  await call(cfg, `/repos/${cfg.owner}/${cfg.repo}/releases/assets/${assetId}`, {
    method: "DELETE",
    what: "删除旧文件",
  });
}

/**
 * 列出所有快照。
 *
 * 只认 tag 以 `uranus-backup-` 开头的 release —— 仓库里可能有真正的版本
 * 发布，云备份不该把它们列出来，更不该在清理旧快照时删掉。
 *
 * 一个 release 里理论上可能有多个 asset（手动传过东西），只取名字对得上
 * 快照命名规则的那个。
 */
export async function list(raw) {
  const cfg = normalize(raw);
  const out = [];

  for (let page = 1; page <= 10; page++) {
    const items = await call(
      cfg,
      `/repos/${cfg.owner}/${cfg.repo}/releases?per_page=100&page=${page}`,
      { what: "列出备份" }
    );
    if (!Array.isArray(items) || !items.length) break;

    for (const r of items) {
      if (!String(r?.tag_name ?? "").startsWith(TAG_PREFIX)) continue;
      for (const a of r.assets ?? []) {
        if (!/^uranus-data-.*\.tar\.gz$/.test(a?.name ?? "")) continue;
        out.push({ name: a.name, key: r.tag_name, bytes: Number(a.size) || 0, assetId: a.id });
      }
    }
    if (items.length < 100) break;
  }
  return out;
}

/**
 * 下载一份快照到本地。
 *
 * 两步：先按 tag 找到 asset 的 id，再用 `Accept: application/octet-stream`
 * 取内容。GitHub 会 302 到对象存储上，`fetch` 默认跟重定向，但**跳转之后
 * Authorization 头不该继续带着**（那是发给 GitHub 的凭据，不该发给 S3，
 * 而且带着反而会让签名冲突报 400）。所以用 `redirect: "manual"` 自己跳。
 */
export async function get(raw, name, toFile) {
  const cfg = normalize(raw);
  const found = (await list(raw)).find((s) => s.name === name);
  if (!found) throw new Error(`云端没有找到 ${name}`);

  const url = `${API}/repos/${cfg.owner}/${cfg.repo}/releases/assets/${found.assetId}`;
  let res = await netFetch(
    url,
    { headers: headers(cfg, { Accept: "application/octet-stream" }), redirect: "manual" },
    "下载"
  );

  if (res.status >= 300 && res.status < 400) {
    const to = res.headers.get("location");
    if (!to) throw new Error("GitHub 返回了重定向但没给地址");
    // 不带任何自定义头：目标是对象存储，签名在 URL 的 query 里
    res = await netFetch(to, {}, "下载");
  }
  if (!res.ok) {
    throw new Error(explain(res.status, "", cfg, "下载"));
  }
  if (!res.body) throw new Error("GitHub 没有返回文件内容");

  const { pipeline } = await import("node:stream/promises");
  const { Readable } = await import("node:stream");
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(toFile));
  return (await fs.promises.stat(toFile)).size;
}

/**
 * 删一份快照：删 release，再删它的 tag。
 *
 * 两步都做是因为删 release 不会动 tag —— 只删前者的话仓库的 tag 列表里会
 * 攒下一堆指向空处的 `uranus-backup-*`。删 tag 失败不算失败（快照本体已经
 * 没了），只是会留一个孤儿 tag。
 */
export async function del(raw, name) {
  const cfg = normalize(raw);
  const tag = tagFor(name);
  const release = await findRelease(cfg, tag);
  if (!release) return; // 已经没了

  await call(cfg, `/repos/${cfg.owner}/${cfg.repo}/releases/${release.id}`, {
    method: "DELETE",
    what: "删除备份",
  });
  try {
    await call(cfg, `/repos/${cfg.owner}/${cfg.repo}/git/refs/tags/${encodeURIComponent(tag)}`, {
      method: "DELETE",
      what: "删除 tag",
    });
  } catch {
    /* tag 删不掉只留个孤儿，快照本体已经删了，不该让整件事算失败 */
  }
}

/**
 * 探一次连通性。
 *
 * 先读一次仓库本身 —— 那一步能把「名字拼错」「令牌没权限」「仓库是公开的」
 * 三件事分别说清楚。**公开仓库要警告**：包是不加密的，放公开仓库等于把
 * 聊天记录和记忆库发到网上。
 *
 * 空仓库也在这儿说。「测试连接」的意义是「现在点备份能不能成」，而空仓库
 * 这个坑照旧会让备份挂掉 —— 让人在这一步就知道，比打完 91MB 的包再撞墙好。
 * 它排在公开仓库后面：那条是会出事的，这条只是待办。
 */
export async function check(raw) {
  const cfg = normalize(raw);
  const repo = await call(cfg, `/repos/${cfg.owner}/${cfg.repo}`, { what: "查询仓库" });
  const items = await list(raw);

  let warning = "";
  if (!repo?.private) {
    warning =
      "这个仓库是**公开**的。备份包不加密，传上去等于把聊天记录和记忆库发到网上 —— 改成 private，或者换缤纷云。";
  } else if (await isRepoEmpty(cfg)) {
    warning =
      "这个仓库里还没有任何提交，现在点「立即备份」会失败" +
      "（GitHub 不能在空仓库上建 release）。" +
      "\n去仓库页面点「Add a README」提交一次就好。";
  }

  return {
    ok: true,
    where: `${cfg.owner}/${cfg.repo}`,
    count: items.length,
    // index.js 拿这个决定要不要 logWarn，前端拿它显示红字
    warning,
  };
}

/**
 * 只给离线测试用的口子（scripts/test-cloudbackup.mjs 第 14 节）。
 *
 * 照 s3.js:__signForTest 的路子：`explain` 是「错了也不报错、只是话说得不对」
 * 的那类代码 —— 422 的 `errors[]` 摊错了没人会发现，用户只会又一次看到
 * 一句没用的报错。这种东西必须能被测到。
 */
export function __explainForTest(status, body, cfg, what) {
  return explain(status, body, cfg, what);
}

/** 界面上显示「往哪儿传」。令牌一个字都不带。 */
export function describe(raw) {
  const owner = String(raw?.owner ?? "").trim();
  const repo = String(raw?.repo ?? "").trim();
  return owner && repo ? `${owner}/${repo}` : "";
}
