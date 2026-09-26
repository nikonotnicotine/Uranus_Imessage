/**
 * 出网代理的离线验证。
 *
 * 这一层的坏法**特别难查**，所以验得细一点。代理配错了不会报错、不会崩，只会
 * 让某几个功能安静地超时 —— 而用户看到的是「天气不好用了」「IG 发不出去了」，
 * 压根联想不到是几天前在控制台勾错了一个框。所以这里盯的是那些「不报错但已经
 * 错了」的情形。
 *
 * 分九块：
 *
 *  1. **地址校验**。`socks5://` 必须拦住 —— 机场最爱给这个，而 undici 的
 *     ProxyAgent 压根不支持它。放过去的话所有出网会静默退回直连。
 *  2. **脱敏**。代理串常是 `http://user:pass@host:port`，那就是一组凭据。
 *     日志、界面、接口响应里都不许出现原文。
 *  3. **类别清单**。十类，默认只勾 IG 和联网搜索。这个默认值是用户实测定的
 *     （天气 / 中转站 / Photon / 音乐直连都通，IG 和搜索吃满超时），
 *     改动它要有新的实测依据。这一节还守着每一类的 `wall` ——
 *     它决定报错时该不该提代理。
 *  4. **落盘位置**。地址进 data.config.json（跟密钥一起），勾选留在
 *     config.json。而且**抹空时只抹地址、留勾选** —— 勾选丢了很难查。
 *  5. **优先级**。界面填的 > URANUS_PROXY > HTTPS_PROXY 那几个 > 直连。
 *  6. **proxyFor 的形状**。没配 / 没勾时必须返回 `{}`，因为它的调用点是
 *     无条件 `...(await proxyFor(...))` 展开的。返回 null 会让 fetch 炸。
 *  7. **挂载覆盖面**。每一处出网的 fetch 要么走了 `fetchVia`、要么在注释里
 *     写明为什么不走。漏一处的后果就是「勾了却不生效」。
 *  8. **路由与界面**。
 *  9. **出错时说得出原因**。两件事：错误码要从 `AggregateError` 里挖得出来；
 *     报错文案要**按类别分档** —— 直连实测通的那几类（模型 API、音乐、Photon）
 *     失败时不许提代理。这一节还真跑一遍 `fetchVia`：把代理指到一个死端口，
 *     请求必须靠直连那一刀成功。
 *
 * 全程用临时 URANUS_DATA_DIR，不碰真的 data/，也不联网。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "uranus-proxy-"));
process.env.URANUS_DATA_DIR = TMP;

// 这几个环境变量会被 proxy.js 读进去当兜底。测优先级那一节要自己控制它们，
// 所以先全清干净 —— 开发机上真的设了 HTTPS_PROXY 的话，不清会把结果搅乱
const ENV_VARS = ["URANUS_PROXY", "URANUS_IG_PROXY", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"];
for (const k of ENV_VARS) delete process.env[k];

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

const P = await import("../server/src/proxy.js");
const C = await import("../server/src/config.js");

const src = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf-8");

/* ================= 1. 地址校验 ================= */
{
  console.log("\n1. 地址校验");

  check("http:// 放行", P.checkProxyUrl("http://127.0.0.1:7890"), "");
  check("https:// 放行", P.checkProxyUrl("https://gw.example:8080"), "");
  check("带账号密码的放行", P.checkProxyUrl("http://bob:pw@gw.example:8080"), "");
  check("空串放行（= 直连）", P.checkProxyUrl(""), "");

  /*
   * socks 是这一节的重点。机场客户端默认给的就是 socks5，用户会直接抄过来；
   * 而 undici 的 ProxyAgent 只认 http/https —— 交给它不会抛错，会安静地
   * 全部退回直连，然后用户以为配好了。
   */
  for (const bad of [
    "socks://127.0.0.1:7891",
    "socks4://127.0.0.1:7891",
    "socks5://127.0.0.1:7891",
    "socks5h://127.0.0.1:7891",
    "SOCKS5://127.0.0.1:7891",
  ]) {
    const why = P.checkProxyUrl(bad);
    checkThat(`拦住 ${bad}`, Boolean(why), `实际放过了`);
    checkThat(`  ${bad} 的提示里指了出路`, /http/i.test(why) && /(Clash|v2rayN|混合|HTTP 端口)/.test(why), why);
  }

  checkThat("拦住没有协议的裸地址", Boolean(P.checkProxyUrl("127.0.0.1:7890")));
  checkThat("拦住 ftp:// 这类别的协议", Boolean(P.checkProxyUrl("ftp://gw.example")));
  checkThat("拦住整串乱码", Boolean(P.checkProxyUrl("这不是地址")));
}

/* ================= 2. 脱敏 ================= */
{
  console.log("\n2. 脱敏");

  const masked = P.maskProxy("http://bob:hunter2@gw.example:8080");
  checkThat("账号密码不出现在脱敏结果里", !masked.includes("bob") && !masked.includes("hunter2"), masked);
  checkThat("脱敏结果保留主机和端口（还得能认出是哪个代理）", masked.includes("gw.example:8080"), masked);
  checkThat("脱敏结果说明了「带账号密码」", /账号密码|已隐去/.test(masked), masked);

  check("不带凭据的原样给出", P.maskProxy("http://127.0.0.1:7890"), "http://127.0.0.1:7890");
  check("空串给空串", P.maskProxy(""), "");

  /*
   * 这一条是踩过的坑：`new URL("socks5://a:1").origin` 返回的是字符串 "null"
   * （socks 不是「特殊协议」，URL 规范里 origin 就是 null）。用 origin 拼的话
   * 界面上会显示「代理已配：null」。所以 maskProxy 里是自己拼 protocol + host。
   */
  checkThat("socks 地址脱敏不出现 null", !/null/.test(P.maskProxy("socks5://127.0.0.1:7891")));
  /*
   * 注释里**是**提到 origin（就是在解释为什么不用它），所以先把注释全剥掉再查。
   * 不剥的话这条断言永远失败，而失败的自检等于没有自检。
   */
  const noComments = src("server/src/proxy.js")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  checkThat("maskProxy 没真的用 u.origin", !/\.origin\b/.test(noComments));
}

/* ================= 3. 类别清单 ================= */
{
  console.log("\n3. 类别清单");

  check("十类", P.PROXY_SCOPES.length, 10);
  check(
    "key 和顺序",
    P.SCOPE_KEYS,
    ["ig", "weather", "llm", "search", "tts", "cloud", "update", "music", "link", "photon"]
  );

  const d = P.defaultScopes();
  /*
   * 出厂勾的是 **IG 和联网搜索**，不是 IG 和天气。
   *
   * 2026-09 在用户机器上把每一类逐个实测过一遍（环境变量里的代理全清掉、
   * 真打一次）：三家天气源直连全通（open-meteo 1.1s、和风 250ms、
   * WeatherAPI 725ms），而 DuckDuckGo 和 api.search.brave.com 都是直接吃满
   * 8 秒超时。所以天气那个勾是纯白绕一道，搜索那个才是真需要。
   */
  check("默认只勾 IG 和联网搜索", Object.entries(d).filter(([, v]) => v).map(([k]) => k), ["ig", "search"]);
  checkThat("十类都有默认值（不能有 undefined）", P.SCOPE_KEYS.every((k) => typeof d[k] === "boolean"));

  // 用户实测定的：Photon 直连就通，勾上反而可能连不上
  check("Photon 默认不勾", d.photon, false);
  // 中转站在国内直连本来就通，绕代理更慢、还可能被风控
  check("模型 API 默认不勾", d.llm, false);
  // 三家天气源国内直连全通（实测），出厂勾上等于白绕一道
  check("天气默认不勾", d.weather, false);
  // DuckDuckGo / Brave 实测直连吃满超时，这一类是真要代理
  check("联网搜索默认勾上", d.search, true);

  for (const s of P.PROXY_SCOPES) {
    checkThat(`${s.key} 有中文名`, Boolean(s.label));
    checkThat(`${s.key} 说了打哪些域名`, Boolean(s.domains));
    checkThat(`${s.key} 有一句为什么`, Boolean(s.hint));
    // wall 决定「这一类没走代理又失败」时该不该提代理，见第 9 节
    checkThat(`${s.key} 说明了是不是真被墙（wall）`, typeof s.wall === "boolean");
  }

  /*
   * 国内直连实测通的那几类，`wall` 必须是 false。
   *
   * 这一条就是用户那句抱怨的回归测试：「为什么我这边显示 API 也要开代理啊，
   * 我 API 在 cherry 不开梯子都能直接用」。whyNetwork 靠 wall 决定要不要
   * 提代理，标错了就会理直气壮地把人往错方向带。
   */
  for (const key of ["llm", "music", "photon"]) {
    const s = P.PROXY_SCOPES.find((x) => x.key === key);
    check(`${key} 不算被墙（直连实测通）`, s?.wall, false);
  }
  // 反过来：这几类实测直连不通，报错时该提一句去勾代理
  for (const key of ["ig", "search"]) {
    const s = P.PROXY_SCOPES.find((x) => x.key === key);
    check(`${key} 算被墙`, s?.wall, true);
  }

  const status = P.proxyStatus();
  check("给界面的清单也是十条", status.catalog.length, 10);
  checkThat(
    "给界面的清单不含地址原文字段",
    status.catalog.every((c) => !("url" in c)),
  );
}

/* ================= 4. 落盘位置 ================= */
{
  console.log("\n4. 落盘位置");

  const cfg = C.loadConfig();
  C.saveConfig({
    ...cfg,
    proxy: { url: "http://127.0.0.1:7890", scopes: { ig: true, weather: true, llm: false, music: true } },
  });

  const main = fs.readFileSync(path.join(TMP, "config.json"), "utf-8");
  const sec = fs.readFileSync(path.join(TMP, "data.config.json"), "utf-8");

  // 地址可能带账号密码，所以和 API 密钥同等对待：只进密钥文件
  checkThat("地址不落进 config.json", !main.includes("7890"), "地址漏进了非密钥文件");
  checkThat("地址落进 data.config.json", sec.includes("7890"));

  /*
   * 勾选**要**留在 config.json 里。抹空时只抹地址 —— 勾选丢了的后果很难查：
   * 用户勾了天气走代理，重启后勾没了、天气又开始超时，而界面上看不出哪里变了。
   */
  const mainJson = JSON.parse(main);
  check("勾选留在 config.json", mainJson.proxy?.scopes?.ig, true);
  check("config.json 里地址是空的", mainJson.proxy?.url, "");
  check("勾选也在 data.config.json 里（恢复时用）", JSON.parse(sec).proxyKeys?.scopes?.music, true);

  // 读回来要合成一份完整的
  const back = C.loadConfig();
  check("读回来地址对", back.proxy.url, "http://127.0.0.1:7890");
  check("读回来勾选对", back.proxy.scopes.music, true);

  /*
   * 不带密钥的搬家包恢复到新机器时，密钥文件里没有 proxyKeys —— 那时候
   * **勾选要留下来**（用户特意配的），只是地址没了。所以 mergeSecrets 是
   * 逐字段合并，不是整块替换。
   */
  const cfgSrc = src("server/src/config.js");
  checkThat(
    "mergeSecrets 是合并不是整块替换",
    /merged\.proxy = \{[\s\S]{0,200}\.\.\.\(main\.proxy/.test(cfgSrc),
  );
  checkThat("抹空时留着 scopes", /proxy: \{ url: "", scopes: normalized\.proxy\.scopes \}/.test(cfgSrc));

  // 生效判定
  check("usesProxy ig", P.usesProxy("ig"), true);
  check("usesProxy photon（没勾）", P.usesProxy("photon"), false);
  check("usesProxy 不认识的类别", P.usesProxy("没这个"), false);

  // 清空地址 = 全部改回直连，勾选不动
  C.saveConfig({ ...C.loadConfig(), proxy: { url: "", scopes: { ig: true } } });
  check("地址清空后 ig 也不走代理", P.usesProxy("ig"), false);
  check("地址清空后 status.enabled 是 false", P.proxyStatus().enabled, false);
}

/* ============ 4b. 读设置不该顺手把 data/ 建出来 ============ */
{
  console.log("\n4b. 读设置不建目录");

  /*
   * 这条防的是「读一次代理设置 = 一次完整的配置初始化」。
   *
   * 代理是**出网前**要问的东西，而查更新（update.js）也要挂代理 —— 它以前是个
   * 无依赖的小模块，只拿 GitHub 的公开接口。有一版 readProxyConfig 改成了
   * `loadConfig()`，于是每查一次更新就把整个 data/ 目录树建出来、还顺手把两份
   * 内置预设种进去。自检 test-update 里「查完不该多出任何文件」那条当场变红，
   * 但那已经是很靠后的一环了 —— 所以在这儿也钉一条。
   *
   * 上面那一节的收尾刚把地址清空、勾选清空，所以此刻 TMP 里就那两个文件。
   */
  const existed = new Set(fs.readdirSync(TMP));
  P.proxySettings();
  P.proxyStatus();
  await P.proxyFor("ig");
  const after = fs.readdirSync(TMP).filter((n) => !existed.has(n));
  check("问一遍代理设置，数据目录里不多出任何东西", after, []);
}

/* ================= 5. 优先级 ================= */
{
  console.log("\n5. 优先级");

  C.saveConfig({ ...C.loadConfig(), proxy: { url: "", scopes: {} } });
  check("什么都没有时是直连", P.proxySettings().url, "");
  check("什么都没有时 from 是空的", P.proxySettings().from, "");

  process.env.HTTPS_PROXY = "http://env-https:1";
  check("退到 HTTPS_PROXY", P.proxySettings().url, "http://env-https:1");
  check("说清读的是哪个变量", P.proxySettings().from, "HTTPS_PROXY");

  process.env.URANUS_PROXY = "http://env-uranus:2";
  check("URANUS_PROXY 比 HTTPS_PROXY 优先", P.proxySettings().url, "http://env-uranus:2");

  // 界面上填的最优先 —— 那是用户刚刚做的动作，不该被环境变量盖掉
  C.saveConfig({ ...C.loadConfig(), proxy: { url: "http://from-ui:3", scopes: { ig: true } } });
  check("控制台填的最优先", P.proxySettings().url, "http://from-ui:3");
  check("from 说是控制台", P.proxySettings().from, "控制台");

  // 环境变量兜底时，勾选表还是配置里那份（环境变量只给地址）
  checkThat("环境变量兜底时勾选照旧补齐", P.SCOPE_KEYS.every((k) => typeof P.proxySettings().scopes[k] === "boolean"));

  for (const k of ENV_VARS) delete process.env[k];
}

/* ================= 6. proxyFor 的形状 ================= */
{
  console.log("\n6. proxyFor 的形状");

  C.saveConfig({ ...C.loadConfig(), proxy: { url: "", scopes: { ig: true } } });

  /*
   * 所有调用点都是无条件展开的：
   *   await fetch(url, { ...init, ...(await proxyFor("ig")) })
   * 所以没配代理时必须返回 `{}` —— 返回 null / undefined 会让展开炸掉，
   * 而那是在真的发消息那条路上炸。
   */
  check("没配代理时返回空对象", await P.proxyFor("ig"), {});
  checkThat("空对象展开安全", Object.keys({ ...(await P.proxyFor("ig")) }).length === 0);

  C.saveConfig({ ...C.loadConfig(), proxy: { url: "http://127.0.0.1:7890", scopes: { ig: true, photon: false } } });
  check("没勾的类别也返回空对象", await P.proxyFor("photon"), {});
  const got = await P.proxyFor("ig");
  checkThat("勾了的类别给出 dispatcher", Boolean(got.dispatcher), JSON.stringify(Object.keys(got)));
  checkThat("字段名是 dispatcher（undici 认这个）", Object.keys(got).join() === "dispatcher");

  // agent 按地址缓存：同一个地址反复取不该每次新建
  const again = await P.proxyFor("ig");
  checkThat("同一地址复用同一个 agent", got.dispatcher === again.dispatcher);

  /*
   * **冷启动时并发取**：实机翻过车的就是这条。
   *
   * agentFor 里有个 `await import("undici")`，中间是一段空窗。原来缓存的是
   * 「建好的 agent」，于是先到的那个请求刚记下地址就让出了线程，紧跟着的请求
   * 看到地址对得上、拿到的却是还没填上的 null —— 那一半请求**悄悄直连出去了**，
   * 不报错、日志里也看不出来。实测 music.js 两家并发查的时候，苹果那一路
   * 就是这么漏出去的。
   *
   * 而并发出网到处都是：music.js 两家一起查、env.js 几个天气源一起打、
   * IG 一轮好几个请求。所以这里必须从冷的状态一次要八个，一个都不许漏。
   */
  C.saveConfig({ ...C.loadConfig(), proxy: { url: "http://127.0.0.1:7891", scopes: { ig: true } } });
  const burst = await Promise.all(Array.from({ length: 8 }, () => P.proxyFor("ig")));
  check("冷启动并发 8 个，每个都拿到 dispatcher", burst.filter((g) => g.dispatcher).length, 8);
  check("八个拿到的是同一个 agent", new Set(burst.map((g) => g.dispatcher)).size, 1);

  C.saveConfig({ ...C.loadConfig(), proxy: { url: "", scopes: {} } });
}

/* ================= 7. 挂载覆盖面 ================= */
{
  console.log("\n7. 挂载覆盖面");

  /*
   * 每一处出网的 fetch 都得有交代。这一节是为了防「加了新功能忘了挂代理」——
   * 那种漏法用户报上来只会是「勾了却没用」，从日志里看不出来。
   *
   * 每条给出：文件、这个文件里期望的 `fetchVia` 次数、以及不挂的那几处为什么。
   *
   * 数的是 `fetchVia` 而不是 `proxyFor`：业务代码一律走前者（它在代理自己
   * 坏掉时会脱开代理补一刀直连），裸用 `proxyFor` 少的正是那一刀。
   */
  const expect = [
    ["server/src/ignet.js", 1], // igFetch，Meta 的 Graph API 全走它
    ["server/src/env.js", 1], // fetchJson，天气和地名查询的唯一出网口
    ["server/src/llm.js", 2], // requestJson（整段拿）+ requestStream（边收边喂）
    ["server/src/update.js", 1], // 查 GitHub 的 latest release
    ["server/src/photon.js", 2], // 查已登记的用户 + 登记
    ["server/src/websearch.js", 3], // DuckDuckGo / Tavily / Brave
    ["server/src/music.js", 2], // iTunes / 网易云
    ["server/src/igimage.js", 2], // Cloudinary 上传 + 删除
    ["server/src/igreal.js", 1], // 把远端图片拉回本地
    ["server/src/cloud/net.js", 1], // 两家云的所有请求都从这一个 call() 出去
    /*
     * TTS ×2（SoVITS 是本机，那处故意用裸 fetch）+ 生图 ×2。
     *
     * 生图原来是 3 处（文生图、图生图、取图片链接）。前两处现在合成了一处 ——
     * 两条路发的是同一份字段，只是载体不同（JSON / multipart），摊平成一个 body
     * 之后就只剩 `init` 里一个三元分支了。合并本身是为了「上游嫌弃某个字段就剥掉
     * 重发」那件事：字段只构造一次，剥的时候不用两条路各改一遍。
     */
    ["server/src/media.js", 4],
    /*
     * linkmeta.js 的九处：抓网页的 GET + 跟重定向的 HEAD ×2 + B 站 API +
     * 抖音（收 cookie 那趟 + 带 ttwid 重抓那趟）+ 小红书 + 把图拉回本地 +
     * 把视频拉回本地。都是 link 类。
     */
    ["server/src/linkmeta.js", 9],
  ];

  for (const [file, n] of expect) {
    const text = src(file);
    const calls = (text.match(/await fetchVia\(/g) ?? []).length;
    checkThat(`${file} 挂了 ${n} 处`, calls === n, `实际 ${calls} 处`);
    /*
     * 顺手守一条：业务文件里不许再出现裸的 `...(await proxyFor(`。
     *
     * 那个写法本身不报错、还照样走代理，所以一旦有人照着老代码复制一处，
     * 唯一的症状是「代理没开时这个功能失败，别的功能都好」—— 没人查得出来。
     */
    checkThat(
      `${file} 没有裸用 proxyFor（少了直连那一刀）`,
      !/\.\.\.\(await proxyFor\(/.test(text),
    );
  }

  // 刻意不挂的两处，各自要在注释里写明为什么 —— 不然下一个人会以为是漏了
  checkThat(
    "SoVITS 那处写明了为什么不走代理（本机地址）",
    /刻意不走代理/.test(src("server/src/media.js")),
  );
  checkThat(
    "查岗截图那处写明了为什么不走代理（局域网）",
    /不走代理/.test(src("server/src/spy.js")) && /局域网/.test(src("server/src/spy.js")),
  );
  checkThat("查岗没有对应的类别（清单里不该有它）", !P.SCOPE_KEYS.includes("spy"));

  /*
   * 全仓扫一遍：除了下面这张白名单，不该再有别的 `await fetch(` 没挂代理。
   * 白名单里每一条都是上面已经交代过的。
   */
  const KNOWN = new Set([
    "server/src/proxy.js", // 它自己（testProxy 打测试地址，那次是显式建 agent）
    "server/src/spy.js", // 局域网截图，见上
  ]);
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".js")) files.push(full);
    }
  })(path.join(ROOT, "server/src"));

  const missing = [];
  for (const full of files) {
    const rel = path.relative(ROOT, full).replace(/\\/g, "/");
    if (KNOWN.has(rel)) continue;
    const text = fs.readFileSync(full, "utf-8");
    const bare = (text.match(/await fetch\(/g) ?? []).length;
    const calls = (text.match(/await fetchVia\(/g) ?? []).length;
    if (!bare && !calls) continue;
    // media.js 有一处（SoVITS）故意不挂，所以是「至少挂了一处」而不是相等
    if (calls === 0) missing.push(`${rel}（${bare} 处 fetch，0 处代理）`);
  }
  checkThat("没有哪个文件出网却完全没挂代理", missing.length === 0, missing.join("；"));
}

/* ================= 8. 路由与界面 ================= */
{
  console.log("\n8. 路由与界面");

  const idx = src("server/src/index.js");
  checkThat("有 GET /api/proxy", /app\.get\("\/api\/proxy"/.test(idx));
  checkThat("有 PUT /api/proxy", /app\.put\("\/api\/proxy"/.test(idx));
  checkThat("有 POST /api/proxy/test", /app\.post\("\/api\/proxy\/test"/.test(idx));

  /*
   * 存代理**不能**走 PUT /api/config —— 那条存完会 syncBridges() 把所有
   * iMessage 桥接重连一遍。为了勾一个「天气走代理」把正在聊的号踢下线，
   * 代价太离谱。所以这三条路由里不该出现 syncBridges。
   */
  const putBlock = idx.slice(idx.indexOf('app.put("/api/proxy"'), idx.indexOf('app.put("/api/proxy"') + 1400);
  checkThat("存代理不会重启桥接", !/syncBridges/.test(putBlock));
  checkThat("存之前过一遍地址校验", /checkProxyUrl/.test(putBlock));
  checkThat("勾选只认清单里那几个 key", /SCOPE_KEYS/.test(putBlock));

  // 免登录清单不该被这三条路由撬开
  checkThat(
    "代理接口在登录门后面",
    !/OPEN_PATHS[\s\S]{0,200}\/api\/proxy/.test(idx),
  );

  const ui = src("client/src/panels/proxy.jsx");
  checkThat("界面照 catalog 渲染（不硬编码十类）", /catalog\.map/.test(ui));
  checkThat("界面说了当场生效", /当场生效/.test(ui));
  checkThat("界面提了 socks 用不了", /socks/.test(ui));
  checkThat("界面给了 Clash / v2rayN 的默认端口", /7890/.test(ui) && /10809/.test(ui));
  checkThat("界面不回显地址原文（只用 masked）", /status\.masked/.test(ui) && !/status\.url/.test(ui));

  checkThat("侧栏锚点里有「代理」", /"代理"/.test(src("client/src/nav.js")));
  checkThat("外壳挂上了 ProxyPanel", /<ProxyPanel \/>/.test(src("client/src/shell.jsx")));
}

/* ================= 9. 出错时说得出原因 ================= */
{
  console.log("\n9. 出错时说得出原因");

  /*
   * 用户的原话：「反馈给我一直 fetch failed，这个是什么问题，就是 fetch failed
   * 也不是什么错误，反馈给我我还要去搜」。
   *
   * `fetch failed` 是 undici 对**一切**网络问题的统称，真正的原因埋在
   * `e.cause` 里，而 IPv6 / IPv4 都不通时（Happy Eyeballs，Node 20 起默认开）
   * 更是埋在 `e.errors[]` 的每一条里面。只挖一层的模块统统会掉到「原样吐
   * e.message」那个兜底上，于是日志里只剩这一句。
   *
   * 这一节盯两件事：
   *
   *  1. **深挖**。netCodes 要能从 AggregateError 里把码捞出来。
   *  2. **口子统一**。每个出网模块的报错都要走 whyNetwork（或者自己的中文
   *     翻译 + netCode 挖码），而且 scope 要和它 proxyFor 用的 key 一致 ——
   *     传错 key 的话它会理直气壮地指错方向（「这一类没走代理」其实走了）。
   */

  /** 造一个 undici 在双栈域名连不上时真会抛的那种错。 */
  const aggregateFetchError = () => {
    const v6 = new Error("connect ECONNREFUSED ::1:443");
    v6.code = "ECONNREFUSED";
    const v4 = new Error("connect ECONNREFUSED 127.0.0.1:443");
    v4.code = "ECONNREFUSED";
    const agg = new AggregateError([v6, v4], "");
    const outer = new TypeError("fetch failed");
    outer.cause = agg;
    return outer;
  };

  check("AggregateError 里的码捞得出来", P.netCode(aggregateFetchError()), "ECONNREFUSED");
  checkThat(
    "只挖一层的写法确实读不到（这就是原来的坏法）",
    aggregateFetchError().cause?.code === undefined,
  );

  // 外层带个笼统的 UND_ERR_CONNECT_TIMEOUT、里层才是真原因时，要报里层那个
  {
    const inner = new Error("connect ECONNREFUSED 127.0.0.1:7890");
    inner.code = "ECONNREFUSED";
    const outer = new TypeError("fetch failed");
    outer.code = "UND_ERR_CONNECT_TIMEOUT";
    outer.cause = inner;
    check("笼统的码要让位给具体的", P.netCode(outer), "ECONNREFUSED");
  }

  checkThat(
    "whyNetwork 不会把 fetch failed 原样吐出来",
    !/fetch failed/.test(P.whyNetwork(aggregateFetchError(), "llm", 60000)),
    P.whyNetwork(aggregateFetchError(), "llm", 60000),
  );

  /*
   * 每一句都要带上错误码。中文解释给人看，码是唯一能拿去搜、能贴到群里对上号
   * 的东西 —— 用户报「连接被拒绝」我们还得再问一轮「码是什么」。
   */
  for (const [what, err] of [
    ["ECONNREFUSED", aggregateFetchError()],
    ["ENOTFOUND", Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("x"), { code: "ENOTFOUND" }) })],
    ["UND_ERR_SOCKET", Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("x"), { code: "UND_ERR_SOCKET" }) })],
  ]) {
    const said = P.whyNetwork(err, "llm", 60000);
    checkThat(`${what} 那句里带着码`, said.includes(what), said);
  }

  /*
   * 直连时的 ECONNREFUSED **不该**让人去勾代理：被拒绝的意思是「那个端口上
   * 没有服务」，多半是接口地址写错了。被墙的表现是超时或者被重置。
   */
  {
    const said = P.whyNetwork(aggregateFetchError(), "llm", 60000);
    checkThat("直连被拒绝时不瞎指代理", !/勾上/.test(said), said);
    checkThat("直连被拒绝时指向地址和端口", /端口/.test(said), said);
  }

  /*
   * 超时和连不上那两档该提代理 —— **但只对真被墙的那几类**。
   *
   * 这两条原来传的是 `"llm"`，于是模型 API 连不上时那句话让人去开代理 ——
   * 而中转站在国内直连本来就通。用户的原话：「为什么我这边显示 API 也要开
   * 代理啊，我 API 在 cherry 不开梯子都能直接用，你逗我笑呢？」。
   * 现在按 `PROXY_SCOPES` 的 `wall` 分档，所以这里也要分两组测。
   */
  {
    const timeout = () => Object.assign(new Error("Connect Timeout Error"), { name: "TimeoutError" });
    const socket = () =>
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("x"), { code: "UND_ERR_SOCKET" }),
      });

    // 被墙的类（这里用 ig，出厂就勾着；把它的勾去掉才测得到「没走代理」那半句）
    C.saveConfig({ ...C.loadConfig(), proxy: { url: "", scopes: { ig: false } } });
    checkThat("被墙的类超时那句提了代理", /代理/.test(P.whyNetwork(timeout(), "ig", 60000)));
    checkThat("被墙的类连不上那句提了代理", /代理/.test(P.whyNetwork(socket(), "ig", 60000)));

    /*
     * 直连实测通的类**不许提代理**。这两条就是那句抱怨的回归测试：
     * 提了代理，用户会去装 / 开一个压根不需要的梯子，而真正的原因
     * （机器出不了网、接口地址填错）被这句话盖住了。
     */
    for (const [what, make] of [["超时", timeout], ["连不上", socket]]) {
      const said = P.whyNetwork(make(), "llm", 60000);
      checkThat(`直连就通的类${what}那句不提代理`, !/代理/.test(said), said);
      checkThat(`直连就通的类${what}那句指向出网和地址`, /出网|地址/.test(said), said);
    }
    C.saveConfig({ ...C.loadConfig(), proxy: { url: "", scopes: {} } });
  }

  /* ---- fetchVia：代理挂了就直连补一刀 ---- */
  {
    checkThat("proxy.js 导出了 fetchVia", typeof P.fetchVia === "function");

    const pjs = src("server/src/proxy.js");
    /*
     * init 必须是**函数**。传对象的话第二发会复用第一发那个
     * `AbortSignal.timeout()` —— 那个 signal 已经在计时、甚至已经 abort 了，
     * 于是「直连补一刀」表面上做了、实际上一定立刻失败。
     */
    checkThat(
      "fetchVia 的 init 是每次重造的（不然 AbortSignal 已经烧掉了）",
      /init\(\)/.test(pjs) && /必须是函数/.test(pjs),
    );
    // 回退那一发不许再带 dispatcher —— 代理就是刚坏掉的那个东西
    checkThat("回退那一发不带 dispatcher", /刻意不带 dispatcher/.test(pjs));
    // 超时刻意不在回退判据里：已经白等一整轮了，再等一轮只会更慢
    checkThat("超时不触发回退（写明了为什么）", /超时刻意不在其中/.test(pjs));
    // 只做单向：反过来「直连失败就偷偷试代理」会悄悄换掉出口 IP
    checkThat("只做单向回退（写明了为什么不做反向）", /刻意不做/.test(pjs));

    // 抛的是**走代理**那次的错，直连那次的结果只缀一条线索
    const e = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("x"), { code: "ECONNRESET" }),
      directRetryCode: "ENOTFOUND",
    });
    C.saveConfig({ ...C.loadConfig(), proxy: { url: "http://127.0.0.1:7890", scopes: { ig: true } } });
    const said = P.whyNetwork(e, "ig", 60000);
    checkThat("试过直连的话报错里会说一句", /脱开代理直连也不行/.test(said), said);
    checkThat("那句里带着直连那次的码", /ENOTFOUND/.test(said), said);
    C.saveConfig({ ...C.loadConfig(), proxy: { url: "", scopes: {} } });
  }

  /* ---- 真跑一遍：代理是死的，请求照样该成 ---- */
  {
    /*
     * 上面那几条都是读源码和读文案，这一条**真发请求**。
     *
     * 起一个本机 http 服务当「目标站点」，把代理指到 127.0.0.1:1（那个端口上
     * 永远没有服务，必然 ECONNREFUSED）—— 也就是用户那台机器上 Clash 没启动
     * 时的样子。整件事的承诺是「代理挂了就直连」，所以这个请求必须**成功**。
     *
     * 不联网：两头都在本机。
     */
    const http = await import("node:http");
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("直连过来的");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;

    try {
      // 代理是死的
      C.saveConfig({
        ...C.loadConfig(),
        proxy: { url: "http://127.0.0.1:1", scopes: { ig: true } },
      });
      let told = "";
      const res = await P.fetchVia(
        "ig",
        `http://127.0.0.1:${port}/`,
        () => ({ signal: AbortSignal.timeout(5000) }),
        (why) => {
          told = why;
        },
      );
      check("代理挂了也能拿到响应", res.status, 200);
      check("拿回来的是目标站点的正文", await res.text(), "直连过来的");
      checkThat("回退时说了一声（进日志）", /直连/.test(told), told);
      checkThat("那句话里带着代理挂掉的码", /ECONNREFUSED/.test(told), told);

      /*
       * 反过来：没勾这一类时**一次普通请求**，不许有任何额外动作 ——
       * 连 onRetry 都不该被叫到（叫了就说明它先走了一趟代理）。
       */
      let quiet = true;
      const plain = await P.fetchVia(
        "photon",
        `http://127.0.0.1:${port}/`,
        () => ({ signal: AbortSignal.timeout(5000) }),
        () => {
          quiet = false;
        },
      );
      check("没勾的类别照常直连", plain.status, 200);
      checkThat("没勾的类别压根不碰代理", quiet);
      await plain.body?.cancel().catch(() => {});
    } finally {
      await new Promise((r) => server.close(r));
      C.saveConfig({ ...C.loadConfig(), proxy: { url: "", scopes: {} } });
    }
  }

  /*
   * 每个出网模块：报错走的 scope 必须是它 proxyFor 用的那个 key。
   *
   * 写成一张表而不是逐个 checkThat，是因为漏的那一处正是没人想到的那一处 ——
   * 加新功能时照着这张表走一遍比凭记忆可靠。
   */
  const REPORTERS = [
    ["server/src/llm.js", ["llm"]],
    // media.js 走的是自己那层 whyFetch(e, scope, timeout)，scope 在调用点传
    ["server/src/media.js", ["tts", "llm"], /whyFetch\([^)]*"SCOPE"/],
    ["server/src/music.js", ["music"]],
    ["server/src/websearch.js", ["search"]],
    ["server/src/photon.js", ["photon"]],
    ["server/src/igimage.js", ["ig"]],
    ["server/src/ignet.js", ["ig"]],
    ["server/src/linkmeta.js", ["link"]],
    ["server/src/env.js", ["weather"]],
  ];
  for (const [file, scopes, via] of REPORTERS) {
    const text = src(file);
    // 报错的入口：多数文件直接调 whyNetwork，media.js 隔了自己那层 whyFetch
    const fn = via ? "whyFetch" : "whyNetwork";
    checkThat(`${file} 的报错走 whyNetwork`, /whyNetwork\(/.test(text));
    for (const scope of scopes) {
      checkThat(
        `${file} 报错用的是 "${scope}"（和它挂代理的 key 一致）`,
        new RegExp(`${fn}\\([^)]*"${scope}"`).test(text),
      );
    }
    // 传了清单外的 key 等于指错方向，而且不会报错，只会安静地说反话
    const used = [...text.matchAll(new RegExp(`${fn}\\([^)]*?"([a-z]+)"`, "g"))].map((m) => m[1]);
    const bogus = used.filter((s) => !P.SCOPE_KEYS.includes(s));
    checkThat(`${file} 没用清单外的类别名`, bogus.length === 0, bogus.join("、"));
  }

  // 这两个自己有更贴合场景的中文（「过一会儿再点一次，或者直接打开仓库页面看」），
  // 但**挖码**必须借 netCode —— 原来只挖一层，连不上 GitHub 时括号里是空的
  checkThat("update.js 借 netCode 挖码", /netCode\(/.test(src("server/src/update.js")));
  checkThat("cloud/net.js 借 netCode 挖码", /netCode\(/.test(src("server/src/cloud/net.js")));
  checkThat(
    "cloud/net.js 不再自己走 errors[]（挑错分支会读不到码）",
    !/function causeOf\(/.test(src("server/src/cloud/net.js")),
  );

  // 重试判据也得深挖：读不到码就当「不值得重试」，一次抖动会变成整轮失败
  for (const file of ["server/src/llm.js", "server/src/media.js"]) {
    checkThat(`${file} 的重试判据用 netCodes`, /netCodes\(/.test(src(file)));
  }
}

fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
