/**
 * 控制台登录的离线验证。
 *
 * 这一层和别的功能不一样：它是**唯一挡在全部密钥、手机号、聊天记录前面的门**。
 * 很多人把这个程序挂在 VPS 上，安全组一开就是全端口对全网 —— 门坏了不是
 * 「某个功能不好用」，是任何知道 IP 的人都能把 API key 和聊天记录全拿走。
 * 所以这里验得比别处细，尤其是那几种「看起来能进去」的绕法。
 *
 * 分七块：
 *
 *  1. **密码规则**。用户定的只有两条（不少于 8 位、至少一个大写），既不能松
 *     （7 位、全小写要拦住）也不能自己加码（不许要求符号和数字）。
 *  2. **默认账号只够走进去一次**。出厂是 Uranus / Uranus，登进来必须是
 *     mustChange 状态；把默认那一对原样交上去要被拒。
 *  3. **密码怎么存**。auth.json 里不许出现明文，得是 scrypt 加盐 ——
 *     同一个密码两次哈希必须不同（盐随机），否则拖库了能对着彩虹表反查。
 *  4. **会话凭据**。签名不对、用户名换了、密码换了的旧凭据一律不认。
 *     这几条是「改完密码，别的设备该掉线」的实现方式。
 *  5. **忘记密码的出路**。把 password 清成 null 之后必须回到默认状态 ——
 *     自己架的东西没有找回密码的邮件可发，这条路断了等于数据锁死。
 *  6. **改账号密码**。要验当前密码（不然摸到没锁屏的机器就能改），
 *     用户名要收口，改完要重新签一条凭据（不然用户自己当场掉线）。
 *  7. **闸门覆盖面**。哪些路径不需要登录 —— 这个清单只该有三条，
 *     多一条就是多一个不用登录就能打的口子。
 *
 * 全程用临时 URANUS_DATA_DIR，不碰真的 data/。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "uranus-auth-"));
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

const A = await import("../server/src/auth.js");
const AUTH_FILE = path.join(TMP, "auth.json");

/** 读 auth.json 的原文（要确认里面没有明文密码）。 */
function raw() {
  return fs.existsSync(AUTH_FILE) ? fs.readFileSync(AUTH_FILE, "utf-8") : "";
}
/** 把落盘的状态清回「全新安装」。 */
function reset() {
  fs.rmSync(AUTH_FILE, { force: true });
}
/** 从 Set-Cookie 那种形态里取出 token（模拟浏览器带回来）。 */
function asCookie(token) {
  return `${A.COOKIE_NAME}=${encodeURIComponent(token)}`;
}

console.log("\n=== 1. 密码规则 ===");
{
  const c = A.checkPassword;
  checkThat("空密码不行", Boolean(c("")));
  checkThat("7 位不行", Boolean(c("Abcdefg")), `得到 ${JSON.stringify(c("Abcdefg"))}`);
  checkThat("8 位全小写不行（缺大写）", Boolean(c("abcdefgh")));
  check("8 位带一个大写：通过", c("Abcdefgh"), "");
  check("更长的也通过", c("MyPasswordIsLong123"), "");
  // 前后空格的密码粘贴时会莫名对不上，用户会以为是程序坏了
  checkThat("首尾带空格不行", Boolean(c(" Abcdefgh ")));
  // 用户原话「其他就没了」—— 不许自己加码要求符号或数字
  check("不额外要求数字", c("Abcdefgh"), "");
  check("不额外要求符号", c("Abcdefgh1"), "");
  // 报错必须说清差什么，而不是一句「密码不合规」
  checkThat("位数不够时报错里有位数", /8 位/.test(c("Abc")));
  checkThat("缺大写时报错里提到大写", /大写/.test(c("abcdefgh")));

  const u = A.checkUsername;
  check("普通用户名通过", u("niki"), "");
  check("中文用户名通过（本地后台，没理由只让用英文）", u("小尼"), "");
  checkThat("空用户名不行", Boolean(u("   ")));
  checkThat("超长用户名不行", Boolean(u("x".repeat(33))));
  // 会话凭据是 <用户名>.<时间>.<签名>，名字里带点会把切分弄乱
  checkThat("用户名里不许有小数点", Boolean(u("a.b")));
  checkThat("用户名里不许有控制字符", Boolean(u("ab")));
}

console.log("\n=== 2. 默认账号只够走进去一次 ===");
{
  reset();
  checkThat("全新安装：处于「必须改密码」状态", A.mustChangeCredentials());
  check("全新安装的用户名是 Uranus", A.currentUsername(), "Uranus");

  const bad = A.login("Uranus", "wrong");
  check("默认账号 + 错密码：进不去", bad.ok, false);

  const ok = A.login("Uranus", "Uranus");
  check("默认账号密码能登进去", ok.ok, true);
  check("登进来带着 mustChange 标记", ok.mustChange, true);
  checkThat("发了一条会话凭据", Boolean(ok.token));

  // 用户名大小写不敏感 —— 记不住自己当初打的是 uranus 还是 Uranus 是常事
  check("用户名大小写不敏感", A.login("uranus", "Uranus").ok, true);
  // 但密码必须严格区分大小写
  check("密码区分大小写", A.login("Uranus", "uranus").ok, false);

  // 报错不许区分「账号不存在」和「密码错了」——那等于告诉扫端口的人用户名对了
  const noUser = A.login("不存在的人", "Uranus");
  check("账号错和密码错回同一句话", noUser.error, bad.error);

  // 强制更换的意思是「不能把默认那一对留着当正式密码」。
  // 「Uranus」只有 6 位，所以先撞上的是位数那条规则 —— 两条哪条先说都行，
  // 要紧的是拒绝，而且理由是一句能照着改的中文
  const keep = A.changeCredentials({ username: "Uranus", password: "Uranus" });
  check("不许把默认的 Uranus / Uranus 设成正式密码", keep.ok, false);
  checkThat("拒绝的理由说得明白", /8 位|大写|默认/.test(String(keep.error)), `得到 ${JSON.stringify(keep.error)}`);
  // 名字留着 Uranus、密码换成合规的那种也不该被当成「还是默认」拦下来 ——
  // 用户想继续用 Uranus 当用户名是他的自由
  reset();
  A.login("Uranus", "Uranus");
  check("用户名保持 Uranus、密码换成合规的：允许", A.changeCredentials({
    username: "Uranus",
    password: "MyOwnPass1",
  }).ok, true);
}

console.log("\n=== 3. 密码怎么存 ===");
{
  reset();
  A.login("Uranus", "Uranus");
  const set = A.changeCredentials({ username: "niki", password: "SecretPass1" });
  check("改成自己的账号密码：成功", set.ok, true);

  const text = raw();
  checkThat("落盘了 auth.json", Boolean(text));
  // 这是这个文件最要紧的一条：明文密码一个字节都不许落盘
  checkThat("文件里没有明文密码", !text.includes("SecretPass1"));
  checkThat("存的是盐 + 哈希", text.includes("salt") && text.includes("hash"));
  checkThat("有会话签名用的 secret", text.includes("secret"));
  // 忘了密码的人会打开这个文件，那时候他要的就是这几句话
  checkThat("文件里带着「怎么重置」的说明", /password/.test(text) && /null/.test(text));
  // 实测清成 null 之后当场生效（每次请求都现读这个文件），说明里不能写「要重启」
  checkThat("说明里没说要重启（实际不用）", !/存盘后重启/.test(text));

  // 盐必须每次随机：不随机的话拖了库能对着彩虹表把常见密码全反查出来
  const first = JSON.parse(text).password;
  reset();
  A.login("Uranus", "Uranus");
  A.changeCredentials({ username: "niki", password: "SecretPass1" });
  const second = JSON.parse(raw()).password;
  checkThat("同一个密码两次的盐不同", first.salt !== second.salt);
  checkThat("所以哈希也不同", first.hash !== second.hash);
  checkThat("哈希长度是 32 字节的 hex", second.hash.length === 64);
}

console.log("\n=== 4. 会话凭据 ===");
{
  reset();
  A.login("Uranus", "Uranus");
  const set = A.changeCredentials({ username: "niki", password: "SecretPass1" });
  const token = set.token;

  const good = A.authenticate(asCookie(token));
  check("刚签的凭据认得过", [good.ok, good.user], [true, "niki"]);
  check("已经设过密码了，不再是 mustChange", good.mustChange, false);

  check("没有 cookie：不认", A.authenticate("").ok, false);
  check("cookie 里没这一项：不认", A.authenticate("别的=1").ok, false);
  check("凭据格式不对：不认", A.authenticate(asCookie("乱七八糟")).ok, false);

  // 改一个字符签名就对不上 —— 这是「不能自己伪造一条凭据」
  const tampered = `${token.slice(0, -1)}${token.slice(-1) === "a" ? "b" : "a"}`;
  check("签名被改过：不认", A.authenticate(asCookie(tampered)).ok, false);
  // 换个用户名重签也不行（签名里绑着用户名）
  const swapped = token.replace(/^niki\./, "someone.");
  check("换掉用户名：不认", A.authenticate(asCookie(swapped)).ok, false);

  // 改密码要让别的设备掉线 —— 靠的是「密码哈希进了签名」，不是黑名单
  const again = A.changeCredentials({
    username: "niki",
    password: "AnotherPass2",
    current: "SecretPass1",
  });
  check("再改一次密码：成功", again.ok, true);
  check("改密码之后旧凭据失效（别的设备掉线）", A.authenticate(asCookie(token)).ok, false);
  check("新签的那条还能用", A.authenticate(asCookie(again.token)).ok, true);

  // 改用户名同理
  const renamed = A.changeCredentials({
    username: "niki2",
    password: "AnotherPass2",
    current: "AnotherPass2",
  });
  check("改用户名：成功", renamed.ok, true);
  check("改用户名之后旧凭据失效", A.authenticate(asCookie(again.token)).ok, false);

  // Set-Cookie 的形状：HttpOnly 挡住页面脚本读它，SameSite 挡跨站
  const header = A.cookieHeader(renamed.token);
  checkThat("cookie 带 HttpOnly", header.includes("HttpOnly"));
  checkThat("cookie 带 SameSite", /SameSite=Lax/i.test(header));
  checkThat("cookie 有有效期", /Max-Age=\d+/.test(header));
  // 绝大多数用户是 http://localhost 或 http://[IP]，带 Secure 会让 cookie 被丢掉
  checkThat("cookie 不带 Secure（纯 HTTP 下会被浏览器丢掉）", !/Secure/i.test(header));
  checkThat("退出登录那条把 cookie 清掉", /Max-Age=0/.test(A.cookieHeader("")));
}

console.log("\n=== 5. 忘记密码的出路 ===");
{
  reset();
  A.login("Uranus", "Uranus");
  A.changeCredentials({ username: "niki", password: "SecretPass1" });
  checkThat("设过密码之后不再是 mustChange", !A.mustChangeCredentials());

  // 文件头写明的办法：把 password 那一行改成 null
  const state = JSON.parse(raw());
  fs.writeFileSync(AUTH_FILE, JSON.stringify({ ...state, password: null }, null, 2), "utf-8");
  checkThat("password 清成 null：回到默认状态", A.mustChangeCredentials());
  check("又能用默认账号密码进去了", A.login("Uranus", "Uranus").ok, true);
  check("清空之后用户名也回到 Uranus", A.currentUsername(), "Uranus");
  check("原来的密码不好使了", A.login("niki", "SecretPass1").ok, false);

  // 手改坏了的几种形态都得能兜住，不能让人卡在门外
  for (const [what, body] of [
    ["整个文件删掉", null],
    ["空文件", ""],
    ["坏的 JSON", "{这不是 json"],
    ["空对象", "{}"],
    ["password 是空串", JSON.stringify({ password: "" })],
    ["password 少了 hash", JSON.stringify({ password: { salt: "aa" } })],
  ]) {
    if (body === null) fs.rmSync(AUTH_FILE, { force: true });
    else fs.writeFileSync(AUTH_FILE, body, "utf-8");
    checkThat(`${what}：仍然能用默认账号进去`, A.login("Uranus", "Uranus").ok === true);
  }
}

console.log("\n=== 6. 改账号密码 ===");
{
  reset();
  A.login("Uranus", "Uranus");
  A.changeCredentials({ username: "niki", password: "SecretPass1" });

  // 设过密码之后必须验当前密码 —— 不然摸到一台没锁屏的机器就能把主人关在门外
  const noCurrent = A.changeCredentials({ username: "niki", password: "NewPass123" });
  check("不给当前密码：拒绝", noCurrent.ok, false);
  checkThat("说的是当前密码不对", /当前密码/.test(String(noCurrent.error)));
  check("当前密码错：拒绝", A.changeCredentials({
    username: "niki",
    password: "NewPass123",
    current: "错的",
  }).ok, false);
  check("原来的密码还好使（失败的改动没落盘）", A.login("niki", "SecretPass1").ok, true);

  // 新密码同样要过那两条规则
  for (const [what, pw] of [
    ["太短", "Ab1"],
    ["缺大写", "alllowercase"],
    ["空的", ""],
  ]) {
    check(`新密码${what}：拒绝`, A.changeCredentials({
      username: "niki",
      password: pw,
      current: "SecretPass1",
    }).ok, false);
  }
  // 用户名也要过
  check("用户名带小数点：拒绝", A.changeCredentials({
    username: "a.b",
    password: "GoodPass1",
    current: "SecretPass1",
  }).ok, false);

  // 用户名两头的空格要收掉，不然登录时打不出来那个名字
  const trimmed = A.changeCredentials({
    username: "  niki  ",
    password: "GoodPass1",
    current: "SecretPass1",
  });
  check("用户名首尾空格被收掉", trimmed.username, "niki");
  check("改完发了一条新凭据（不然用户自己当场掉线）", Boolean(trimmed.token), true);
  check("新凭据当场可用", A.authenticate(asCookie(trimmed.token)).ok, true);
  check("新密码能登录", A.login("niki", "GoodPass1").ok, true);
  check("旧密码不能登录了", A.login("niki", "SecretPass1").ok, false);
}

console.log("\n=== 7. 闸门覆盖面 ===");
{
  // 不需要登录就能打的口子只该有三条。多一条就是多一个敞着的门，
  // 所以这里对着 index.js 的源码数 —— 加了新的会在这儿失败
  const src = fs.readFileSync(path.join(ROOT, "server/src/index.js"), "utf-8");
  const open = /const OPEN_PATHS = new Set\(\[([^\]]*)\]\)/.exec(src)?.[1] ?? "";
  const paths = [...open.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  check("免登录的口子就这三条", paths, ["/api/auth/login", "/api/auth/state", "/api/health"]);

  checkThat("闸门确实挂在 /api/ 上", /req\.path\.startsWith\("\/api\/"\)/.test(src));
  checkThat("没登录回 401 + needLogin", /needLogin: true/.test(src) && /status\(401\)/.test(src));
  // 还在用默认密码时只放行改密码那几条 —— 光靠前端挡不算数，curl 一下就绕过去了
  checkThat("后端也拦着 mustChange", /mustChange && !MUST_CHANGE_PATHS/.test(src));
  // 查岗手机的收图口子带不了 cookie，走的是预共享 secret，必须排在闸门之前
  const gate = src.indexOf("const OPEN_PATHS");
  const shot = src.indexOf("handleShotUpload");
  checkThat("收图口子排在闸门之前（快捷指令带不了 cookie）", shot > 0 && shot < gate);

  // 密钥都在这台服务上，所以这道门是「唯一」的那一层 —— 不该有第二处能绕开它
  checkThat("auth.js 不 import config.js（登录和配置无关）", () => {
    const a = fs.readFileSync(path.join(ROOT, "server/src/auth.js"), "utf-8");
    return !/from "\.\/config\.js"/.test(a);
  });
  const authSrc = fs.readFileSync(path.join(ROOT, "server/src/auth.js"), "utf-8");
  checkThat("用的是 scrypt，不是裸 SHA", /scryptSync/.test(authSrc) && !/createHash\("sha256"\)/.test(authSrc));
  checkThat("比哈希用 timingSafeEqual", /timingSafeEqual/.test(authSrc));
  checkThat("没引入额外依赖（bcrypt 那类在 Windows 上常装不上）", /from "node:crypto"/.test(authSrc));

  // auth.json 单独一个文件：改密码不该走 PUT /api/config，那条会重启所有桥接
  const dd = fs.readFileSync(path.join(ROOT, "server/src/datadir.js"), "utf-8");
  checkThat("凭据单独落 auth.json", /AUTH_PATH/.test(dd) && /auth\.json/.test(dd));

  // 前端三处规则必须一致，不然会出现「前端说行、后端说不行」
  for (const file of ["client/src/panels/auth.jsx", "client/src/panels/console.jsx"]) {
    const f = fs.readFileSync(path.join(ROOT, file), "utf-8");
    checkThat(`${file} 里也是 8 位 + 一个大写`, /8 位/.test(f) && /\[A-Z\]/.test(f));
  }
}

fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
