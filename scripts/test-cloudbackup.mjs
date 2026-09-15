/*
 * 云备份的离线验证：打包 / 解包 / 保留策略 / SigV4 签名。
 *
 * 指向临时数据目录（URANUS_DATA_DIR），绝不碰用户真实的 data/ ——
 * 那里面有真的 API key、Photon 凭据和聊天记录。**一个网络请求都不发**：
 * 两个驱动里要网络的部分不在这儿测（那要真凭据），测的是它们旁边那些
 * 错了也不会报错、只会静默 403 的东西 —— 签名和配置校验。
 *
 * 跑法：node scripts/test-cloudbackup.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "uranus-cloud-test-"));
process.env.URANUS_DATA_DIR = TMP;
process.env.IMESSAGE_BRIDGE = "off";

const cb = await import("../server/src/cloudbackup.js");
const s3 = await import("../server/src/cloud/s3.js");
const gh = await import("../server/src/cloud/github.js");
const { driverFor, describeTarget } = await import("../server/src/cloud/index.js");
const { ensureLayout, DATA_DIR } = await import("../server/src/datadir.js");

let pass = 0;
let fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}\n      得到 ${JSON.stringify(got)}\n      期望 ${JSON.stringify(want)}`);
  }
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
/** 期望抛错，并且错误里提到某个词。 */
async function throws(name, fn, word) {
  try {
    await fn();
    fail += 1;
    console.log(`  ✗ ${name}  应该抛错但没抛`);
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (!word || msg.includes(word)) {
      pass += 1;
      console.log(`  ✓ ${name}`);
    } else {
      fail += 1;
      console.log(`  ✗ ${name}\n      错误里没有「${word}」：${msg}`);
    }
  }
}

const w = (rel, text) => {
  const full = path.join(DATA_DIR, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text, "utf-8");
};
const r = (rel) => {
  try {
    return fs.readFileSync(path.join(DATA_DIR, rel), "utf-8");
  } catch {
    return null;
  }
};

ensureLayout();

console.log("\n=== 1. 快照名字 ===");
check(
  "按时间生成",
  cb.snapshotName(new Date(2026, 8, 13, 18, 30)),
  "uranus-data-20260913-1830.tar.gz"
);
check(
  "个位数补零",
  cb.snapshotName(new Date(2026, 0, 5, 9, 7)),
  "uranus-data-20260105-0907.tar.gz"
);
check(
  "解回来是同一刻",
  cb.parseSnapshotName("uranus-data-20260913-1830.tar.gz")?.getTime(),
  new Date(2026, 8, 13, 18, 30).getTime()
);
check("别人的文件不认", cb.parseSnapshotName("我的照片.tar.gz"), null);
check("少了后缀不认", cb.parseSnapshotName("uranus-data-20260913-1830"), null);
// 数字合法但日期不存在的，Date 会滚到下个月 —— 那不是我们生成的名字
check("2 月 31 日这种不认", cb.parseSnapshotName("uranus-data-20260231-1200.tar.gz"), null);
check("13 月不认", cb.parseSnapshotName("uranus-data-20261301-1200.tar.gz"), null);

console.log("\n=== 2. 保留策略 ===");
const names = [
  "uranus-data-20260910-1200.tar.gz", // 最老
  "uranus-data-20260913-1830.tar.gz", // 最新
  "uranus-data-20260911-1200.tar.gz",
  "uranus-data-20260912-1200.tar.gz",
];
check("留 2 份 → 删掉最老的两份（最老在前）", cb.planPrune(names, 2), [
  "uranus-data-20260910-1200.tar.gz",
  "uranus-data-20260911-1200.tar.gz",
]);
check("留的份数比现有多 → 不删", cb.planPrune(names, 10), []);
check("留 1 份 → 只剩最新", cb.planPrune(names, 1), [
  "uranus-data-20260910-1200.tar.gz",
  "uranus-data-20260911-1200.tar.gz",
  "uranus-data-20260912-1200.tar.gz",
]);
check("keep 是 0 / 负数也至少留 1 份", cb.planPrune(names, 0).length, 3);
// 桶里可能有别人放的东西，云备份不该删自己不认识的文件
check(
  "认不出名字的一个都不删",
  cb.planPrune(["我的照片.zip", "note.txt", "uranus-data-20260913-1830.tar.gz"], 1),
  []
);
check("空列表不炸", cb.planPrune([], 3), []);
check("undefined 不炸", cb.planPrune(undefined, 3), []);

console.log("\n=== 3. 选中哪些文件 ===");
w("config.json", '{"a":1}');
w("data.config.json", '{"secret":"KEY"}');
w("characters/01-小明.json", '{"name":"小明"}');
w("presets/01-p.json", "{}");
w("sessions/小明.json", "[]");
w("memories/记忆/小明.json", "[]");
w("memories/记忆/小明.bak.json", "[旧的]"); // .bak 不该进包
w("memories/记忆/小明.json.tmp", "半个"); // .tmp 也不该
w("images/emojis/开心/a.jpg", "JPEGDATA");
w("wallpapers/settings.json", '{"pick":""}');
w("wallpapers/我的壁纸.jpg", "IMG"); // 壁纸图片不进包

const onlyConfig = cb.collectEntries({ config: true });
checkThat("只勾配置：带上 config.json", onlyConfig.entries.includes("config.json"));
checkThat("只勾配置：带上角色", onlyConfig.entries.includes("characters/01-小明.json"));
checkThat(
  "只勾配置：带上壁纸设置",
  onlyConfig.entries.includes("wallpapers/settings.json")
);
checkThat(
  "只勾配置：**不带**壁纸图片",
  !onlyConfig.entries.some((e) => e.includes("我的壁纸"))
);
checkThat("只勾配置：不带聊天", !onlyConfig.entries.some((e) => e.startsWith("sessions/")));
checkThat("只勾配置：不带图片", !onlyConfig.entries.some((e) => e.startsWith("images/")));
checkThat(
  "默认不带密钥文件",
  !onlyConfig.entries.includes("data.config.json"),
  onlyConfig.entries.join(",")
);
checkThat(
  "勾了才带密钥文件",
  cb.collectEntries({ config: true }, { includeSecrets: true }).entries.includes("data.config.json")
);

const chats = cb.collectEntries({ chats: true });
checkThat("聊天那块：带上存档", chats.entries.includes("sessions/小明.json"));
checkThat("聊天那块：带上记忆", chats.entries.includes("memories/记忆/小明.json"));
checkThat(
  "聊天那块：**不带** .bak",
  !chats.entries.some((e) => e.includes(".bak")),
  chats.entries.join(",")
);
checkThat("聊天那块：**不带** .tmp", !chats.entries.some((e) => e.endsWith(".tmp")));

checkThat(
  "三块全勾 = 三块各自加起来",
  cb.collectEntries({ config: true, chats: true, images: true }).entries.length ===
    new Set([
      ...cb.collectEntries({ config: true }).entries,
      ...cb.collectEntries({ chats: true }).entries,
      ...cb.collectEntries({ images: true }).entries,
    ]).size
);
check("一块都不勾 = 一个文件都没有", cb.collectEntries({}).entries.length, 0);
// 体积得是**字节**不是文件数 —— 那一块里除了 a.jpg 还有 ensureLayout 写的 README.txt
{
  const got = cb.collectEntries({ images: true });
  const want = got.entries.reduce((n, e) => n + fs.statSync(path.join(DATA_DIR, e)).size, 0);
  check("体积是真的字节数", got.bytes, want);
  checkThat("体积不是文件数", got.bytes > got.entries.length, `${got.bytes}`);
}

console.log("\n=== 4. 打包 → 解包 ===");
{
  const snap = await cb.packSnapshot({ config: true, chats: true }, { includeSecrets: false });
  try {
    checkThat("打出来的文件在盘上", fs.existsSync(snap.file));
    checkThat("有体积", snap.bytes > 0);
    checkThat("名字合规", cb.parseSnapshotName(snap.name) !== null);
    check("清单里记着勾了哪几块", snap.manifest.scopes, {
      config: true,
      chats: true,
      images: false,
    });
    check("清单里记着没带密钥", snap.manifest.includesSecrets, false);

    /*
     * 回归：tar-fs 把传给它的 entries 数组**当队列用**，边打边 shift 空。
     * 早先这里返回的是打包之后读的 `entries.length`，于是日志上永远是
     * 「0 个文件、29.8MB 压到 8.2MB」。见 cloudbackup.js 里 fileCount 那段。
     */
    const picked = cb.collectEntries({ config: true, chats: true });
    checkThat("确实挑到了文件", picked.entries.length > 0);
    check("回执里的文件数对得上", snap.entries, picked.entries.length);
    check("清单里的文件数也对得上", snap.manifest.files, picked.entries.length);

    // 改掉磁盘上的东西，再解包，验证「整体替换」
    w("config.json", '{"a":999}');
    w("characters/01-小明.json", '{"name":"改过了"}');
    w("characters/02-新加的.json", "{}"); // 包里没有 → 整体替换后该没掉
    w("images/emojis/开心/a.jpg", "改过的图"); // 包里没这块 → 该一个字节都不动

    const out = await cb.unpackSnapshot(snap.file);
    check("恢复了配置和聊天两块", out.applied, ["配置", "聊天与记忆"]);
    check("config.json 被换回去", r("config.json"), '{"a":1}');
    check("角色被换回去", r("characters/01-小明.json"), '{"name":"小明"}');
    checkThat(
      "包里没有的角色被清掉（整体替换）",
      r("characters/02-新加的.json") === null
    );
    check("没勾的那块一个字节都不动", r("images/emojis/开心/a.jpg"), "改过的图");
    check("被覆盖的 config.json 留了 .bak", r("config.bak.json"), '{"a":999}');
    // .bak 是用户的安全网，压根不在包里，不能被「整体替换」吃掉
    check("目录里原有的 .bak 还在", r("memories/记忆/小明.bak.json"), "[旧的]");
  } finally {
    await snap.cleanup();
  }
  checkThat("cleanup 之后临时文件没了", !fs.existsSync(snap.file));
}

console.log("\n=== 5. 不带密钥的包不会冲掉本地凭据 ===");
{
  // 这是「换机器恢复」最要紧的一条：拿一份不含密钥的快照恢复，
  // 本机的 API key / Photon 凭据必须原样留着
  w("data.config.json", '{"secret":"本机的真KEY"}');
  const snap = await cb.packSnapshot({ config: true }, { includeSecrets: false });
  try {
    w("data.config.json", '{"secret":"恢复前又改过"}');
    const out = await cb.unpackSnapshot(snap.file);
    checkThat("回执里没有「密钥」这一项", !out.applied.includes("密钥"));
    check("本地密钥文件一个字节都没动", r("data.config.json"), '{"secret":"恢复前又改过"}');
  } finally {
    await snap.cleanup();
  }
}

console.log("\n=== 6. 带密钥的包会覆盖 ===");
{
  w("data.config.json", '{"secret":"包里这份"}');
  const snap = await cb.packSnapshot({ config: true }, { includeSecrets: true });
  try {
    w("data.config.json", '{"secret":"本地这份"}');
    const out = await cb.unpackSnapshot(snap.file);
    checkThat("回执里有「密钥」", out.applied.includes("密钥"));
    check("密钥文件被换成包里那份", r("data.config.json"), '{"secret":"包里这份"}');
    check("覆盖前留了 .bak", r("data.config.bak.json"), '{"secret":"本地这份"}');
  } finally {
    await snap.cleanup();
  }
}

console.log("\n=== 7. 坏包不该把 data/ 弄坏 ===");
{
  const bad = path.join(TMP, "bad.tar.gz");
  fs.writeFileSync(bad, "这不是 gzip");
  await throws("不是 gzip → 抛错", () => cb.unpackSnapshot(bad));

  // 是合法 gzip 但没有清单：不是这个程序造的包，不该猜着解
  const zlib = await import("node:zlib");
  const noManifest = path.join(TMP, "nomanifest.tar.gz");
  fs.writeFileSync(noManifest, zlib.gzipSync(Buffer.alloc(1024))); // 空 tar
  await throws(
    "没有清单 → 抛错并点名",
    () => cb.unpackSnapshot(noManifest),
    "uranus-backup.json"
  );

  check("出错之后 config.json 还是好的", r("config.json"), '{"a":1}');
}

console.log("\n=== 8. 一块都不勾 ===");
await throws(
  "没什么可备份的时候说人话",
  () => cb.packSnapshot({}, {}),
  "一个文件都没有"
);

console.log("\n=== 8b. 完整备份：ALL_SCOPES 三块全勾 ===");
{
  /*
   * 「导出完整备份到本地」这个动作没有勾选界面，全靠 ALL_SCOPES 写死三块全勾。
   * 那要是哪天 SCOPES 里加了第四块、而 ALL_SCOPES 是手写的字面量，新那块就会
   * 静默地不进包 —— 用户拿着一个自称「完整」的包，回头发现少了东西。所以这里
   * 拿 SCOPES 的键反查一遍，而不是照抄一份 {config:true, chats:true, images:true}。
   */
  const keys = Object.keys(cb.SCOPES);
  checkThat("三块都在", keys.length >= 3, JSON.stringify(keys));
  check(
    "SCOPES 里每一块都被勾上了",
    keys.filter((k) => cb.ALL_SCOPES[k] !== true),
    []
  );
  check(
    "没勾多余的键",
    Object.keys(cb.ALL_SCOPES).filter((k) => !keys.includes(k)),
    []
  );

  // images 是云备份默认不勾的那块（91MB 传网上心疼），但存本地必须带上
  checkThat("images 也在里面", cb.ALL_SCOPES.images === true);

  // 完整备份挑到的文件数 = 三块各自挑到的并集
  const all = cb.collectEntries(cb.ALL_SCOPES);
  const union = new Set(keys.flatMap((k) => cb.collectEntries({ [k]: true }).entries));
  check("挑到的文件是三块的并集", all.entries.length, union.size);
  checkThat("比只挑配置那块多", all.entries.length > cb.collectEntries({ config: true }).entries.length);
}

console.log("\n=== 8c. 完整备份：打包 → 解包一整圈 ===");
{
  /*
   * 后端 /api/backup/full 和 /api/backup/full/restore 走的就是这一圈
   * （packSnapshot(ALL_SCOPES) → 下载 → 上传 → unpackSnapshot），路由那层
   * 只是收发字节。这里验证中间那段：三块都进了包，解出来三块都换掉。
   */
  w("config.json", '{"a":"备份时的配置"}');
  w("characters/01-小明.json", '{"name":"备份时的小明"}');
  w("images/emojis/开心/a.jpg", "备份时的图");

  const snap = await cb.packSnapshot(cb.ALL_SCOPES, { includeSecrets: false });
  try {
    check("清单里三块全勾", snap.manifest.scopes, {
      config: true,
      chats: true,
      images: true, // 云备份默认不勾这块，完整备份必须勾
    });
    checkThat("包里有文件", snap.entries > 0, `${snap.entries}`);
    checkThat("名字合规", cb.parseSnapshotName(snap.name) !== null, snap.name);

    // 三块全改一遍，再解包，三块都得换回去 —— 特别是 images
    w("config.json", '{"a":"恢复前改过"}');
    w("characters/01-小明.json", '{"name":"恢复前改过"}');
    w("images/emojis/开心/a.jpg", "恢复前改过的图");

    const out = await cb.unpackSnapshot(snap.file);
    check("三块都恢复了", out.applied, ["配置", "聊天与记忆", "表情包与参考图"]);
    check("配置换回去了", r("config.json"), '{"a":"备份时的配置"}');
    check("角色换回去了", r("characters/01-小明.json"), '{"name":"备份时的小明"}');
    // 这条是完整备份和只导配置最要紧的区别：图必须也回来
    check("图也换回去了", r("images/emojis/开心/a.jpg"), "备份时的图");
  } finally {
    await snap.cleanup();
  }
  checkThat("cleanup 之后临时包没了", !fs.existsSync(snap.file));
}

console.log("\n=== 8d. 完整备份的密钥规矩和另外两套一致 ===");
{
  // ?keys=1 才带。不带的时候本机凭据必须原样留着（换机器恢复最要紧的一条）
  w("data.config.json", '{"secret":"本机真KEY"}');
  const plain = await cb.packSnapshot(cb.ALL_SCOPES, { includeSecrets: false });
  try {
    check("不勾 → 清单说没带", plain.manifest.includesSecrets, false);
    checkThat(
      "不勾 → 包里挑的文件不含密钥文件",
      !cb.collectEntries(cb.ALL_SCOPES, { includeSecrets: false }).entries.some((e) =>
        e.endsWith("data.config.json")
      )
    );
    w("data.config.json", '{"secret":"恢复前又改过"}');
    const out = await cb.unpackSnapshot(plain.file);
    checkThat("恢复时不碰密钥", !out.applied.includes("密钥"));
    check("本机密钥一个字节没动", r("data.config.json"), '{"secret":"恢复前又改过"}');
  } finally {
    await plain.cleanup();
  }

  const withKeys = await cb.packSnapshot(cb.ALL_SCOPES, { includeSecrets: true });
  try {
    check("勾了 → 清单说带了", withKeys.manifest.includesSecrets, true);
    checkThat(
      "勾了 → 密钥文件在挑中的文件里",
      cb
        .collectEntries(cb.ALL_SCOPES, { includeSecrets: true })
        .entries.some((e) => e.endsWith("data.config.json"))
    );
  } finally {
    await withKeys.cleanup();
  }
}

console.log("\n=== 9. SigV4 签名（AWS 官方示例）===");
{
  /*
   * AWS 文档里「GET Object」那个完整签名示例，参数是写死的，能端到端对：
   *
   *   GET /test.txt   Host: examplebucket.s3.amazonaws.com
   *   Range: bytes=0-9
   *   x-amz-date: 20130524T000000Z
   *
   * 文档给出这次请求的 canonical request 的 sha256 是下面那一串。我们只
   * 借这一串来**反推**期望的签名 —— canonical request 差一个字节，哈希就
   * 变，下面这个签名就对不上。签名算错了云端只会静默 403，手写的东西必须
   * 能被测到，否则出问题时分不清是密钥抄错了还是代码算错了。
   */
  const crypto = await import("node:crypto");
  const hmac = (k, d) => crypto.createHmac("sha256", k).update(d).digest();
  const SK = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const CANONICAL_SHA = "7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972";

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    "20130524T000000Z",
    "20130524/us-east-1/s3/aws4_request",
    CANONICAL_SHA,
  ].join("\n");
  let key = hmac("AWS4" + SK, "20130524");
  for (const part of ["us-east-1", "s3", "aws4_request"]) key = hmac(key, part);
  const want = hmac(key, stringToSign).toString("hex");

  const signed = s3.__signForTest({
    cfg: {
      endpoint: "https://s3.amazonaws.com",
      bucket: "examplebucket", // 没有点 → virtual-hosted，拼出文档里那个 host
      region: "us-east-1",
      prefix: "",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: SK,
    },
    method: "GET",
    key: "test.txt",
    headers: { range: "bytes=0-9" },
    payloadHash: EMPTY_SHA,
    now: new Date(Date.UTC(2013, 4, 24, 0, 0, 0)),
  });
  const got = /Signature=([0-9a-f]{64})$/.exec(signed.headers.Authorization)?.[1];
  check("算出来的签名和 AWS 文档的示例一致", got, want);
  check("host 拼成文档里那个", signed.headers.host, "examplebucket.s3.amazonaws.com");
  check(
    "Credential 那一段",
    /Credential=([^,]+),/.exec(signed.headers.Authorization)?.[1],
    "AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request"
  );
  check(
    "SignedHeaders 按名排了序",
    /SignedHeaders=([^,]+),/.exec(signed.headers.Authorization)?.[1],
    "host;range;x-amz-content-sha256;x-amz-date"
  );
  checkThat("带上了 x-amz-date", signed.headers["x-amz-date"] === "20130524T000000Z");
  checkThat(
    "流式 body 走 UNSIGNED-PAYLOAD",
    s3.__signForTest({
      cfg: {
        endpoint: "https://s3.bitiful.net",
        bucket: "b",
        region: "cn-east-1",
        prefix: "",
        accessKeyId: "AK",
        secretAccessKey: "SK",
      },
      method: "PUT",
      key: "x.tar.gz",
    }).headers["x-amz-content-sha256"] === "UNSIGNED-PAYLOAD"
  );

  // 同样的输入必须每次算出同一个签名（时间固定住的前提下）
  const twice = () =>
    s3.__signForTest({
      cfg: {
        endpoint: "https://s3.bitiful.net",
        bucket: "mybucket",
        region: "cn-east-1",
        prefix: "uranus-backups/",
        accessKeyId: "AK",
        secretAccessKey: "SK",
      },
      method: "PUT",
      key: "uranus-backups/uranus-data-20260913-1830.tar.gz",
      now: new Date(Date.UTC(2026, 8, 13, 10, 30, 0)),
    }).headers.Authorization;
  check("同样的输入算出同样的签名", twice(), twice());

  // 中文文件名和括号：编码错了签名就对不上
  const cn = s3.__signForTest({
    cfg: {
      endpoint: "https://s3.bitiful.net",
      bucket: "b",
      region: "cn-east-1",
      prefix: "",
      accessKeyId: "AK",
      secretAccessKey: "SK",
    },
    method: "PUT",
    key: "表情包/开心(1).jpg",
    now: new Date(Date.UTC(2026, 8, 13, 10, 30, 0)),
  });
  checkThat("中文 key 编成 %XX", cn.url.includes("%E8%A1%A8%E6%83%85%E5%8C%85"), cn.url);
  checkThat("括号也编（S3 的规范要求）", cn.url.includes("%28") && cn.url.includes("%29"), cn.url);
  checkThat("路径里的斜杠不编", cn.url.includes("/%E5%BC%80%E5%BF%83"), cn.url);

  // 桶名带点 → 撞通配证书，只能走 path-style，桶名要进签名的 canonical URI
  const dotted = s3.__signForTest({
    cfg: {
      endpoint: "https://s3.bitiful.net",
      bucket: "my.bucket",
      region: "cn-east-1",
      prefix: "",
      accessKeyId: "AK",
      secretAccessKey: "SK",
    },
    method: "GET",
    key: "a.tar.gz",
  });
  check("桶名带点走 path-style", dotted.url, "https://s3.bitiful.net/my.bucket/a.tar.gz");
  check("path-style 下 host 不带桶名", dotted.headers.host, "s3.bitiful.net");
  const plain = s3.__signForTest({
    cfg: {
      endpoint: "https://s3.bitiful.net",
      bucket: "mybucket",
      region: "cn-east-1",
      prefix: "",
      accessKeyId: "AK",
      secretAccessKey: "SK",
    },
    method: "GET",
    key: "a.tar.gz",
  });
  check("普通桶名走 virtual-hosted", plain.headers.host, "mybucket.s3.bitiful.net");
}

console.log("\n=== 10. 凭据没填齐时说人话 ===");
{
  const s = (o) => () => s3.normalize(o);
  await throws("桶名没填", s({ region: "cn-east-1", accessKeyId: "a", secretAccessKey: "b" }), "桶名");
  await throws("region 没填", s({ bucket: "b", accessKeyId: "a", secretAccessKey: "b" }), "可用区");
  await throws("AK 没填", s({ bucket: "b", region: "r", secretAccessKey: "b" }), "Access Key ID");
  await throws("SK 没填", s({ bucket: "b", region: "r", accessKeyId: "a" }), "Secret");
  await throws(
    "endpoint 不是 https",
    s({ bucket: "b", region: "r", accessKeyId: "a", secretAccessKey: "b", endpoint: "http://x.com" }),
    "https"
  );
  await throws(
    "endpoint 不是地址",
    s({ bucket: "b", region: "r", accessKeyId: "a", secretAccessKey: "b", endpoint: "s3.bitiful.net" }),
    "合法的地址"
  );
  check(
    "prefix 自动补结尾斜杠",
    s3.normalize({ bucket: "b", region: "r", accessKeyId: "a", secretAccessKey: "b", prefix: "snaps" })
      .prefix,
    "snaps/"
  );
  check(
    "prefix 去掉开头斜杠",
    s3.normalize({ bucket: "b", region: "r", accessKeyId: "a", secretAccessKey: "b", prefix: "/snaps/" })
      .prefix,
    "snaps/"
  );

  const g = (o) => () => gh.normalize(o);
  await throws("owner 没填", g({ repo: "r", token: "t" }), "owner");
  await throws("仓库名没填", g({ owner: "o", token: "t" }), "仓库名");
  await throws("令牌没填", g({ owner: "o", repo: "r" }), "令牌");
  // 最常见的两种手滑
  await throws("往 owner 里粘了整个地址", g({ owner: "github.com/me", repo: "r", token: "t" }), "斜杠");
  await throws("往 repo 里粘了 owner/repo", g({ owner: "me", repo: "me/backup", token: "t" }), "backup");
}

console.log("\n=== 11. 两家的分发 ===");
check("默认是缤纷云", driverFor({}).id, "s3");
check("认得出 github", driverFor({ provider: "github" }).id, "github");
check("认不出的退回缤纷云", driverFor({ provider: "阿里云" }).id, "s3");
check(
  "取的是那一家自己那块配置",
  driverFor({ provider: "github", github: { owner: "me", repo: "b" } }).settings.owner,
  "me"
);
check(
  "「往哪儿传」这句话",
  describeTarget({ provider: "github", github: { owner: "me", repo: "backup" } }),
  "GitHub me/backup"
);
check(
  "缤纷云那句",
  describeTarget({ provider: "s3", s3: { bucket: "mybucket", prefix: "snaps/" } }),
  "缤纷云 mybucket/snaps/"
);
// 凭据一个字都不能出现在这句话里
checkThat(
  "描述里不带令牌",
  !describeTarget({ provider: "github", github: { owner: "o", repo: "r", token: "ghp_secret" } })
    .includes("ghp_secret")
);
checkThat(
  "描述里不带密钥",
  !describeTarget({ provider: "s3", s3: { bucket: "b", secretAccessKey: "SEKRIT" } }).includes(
    "SEKRIT"
  )
);

console.log("\n=== 12. 体积怎么说 ===");
check("字节", cb.humanBytes(512), "512B");
check("KB", cb.humanBytes(2048), "2KB");
check("MB", cb.humanBytes(31 * 1024 * 1024), "31.0MB");
check("GB", cb.humanBytes(2 * 1024 * 1024 * 1024), "2.00GB");
check("0 也说得出来", cb.humanBytes(0), "0B");
check("undefined 不炸", cb.humanBytes(undefined), "0B");
check(
  "勾了哪几块",
  cb.scopeLabels({ config: true, chats: true, images: false }, true),
  ["配置", "聊天与记忆", "密钥"]
);

console.log("\n=== 13. 连不上的时候说人话 ===");
{
  /*
   * 传输层失败（不是 HTTP 状态码）时 fetch 抛的是一句光秃秃的
   * `TypeError: fetch failed`，真正的原因埋在 e.cause 里。net.js 的活儿
   * 就是把它翻出来 —— 这一节验证翻译和重试策略，不联网。
   *
   * 127.0.0.1:49999 上没人监听，必定 ECONNREFUSED，而且是**本机**的，
   * 不依赖任何外部网络；ECONNREFUSED 不在重试名单里，所以立刻返回。
   * （别用 1 端口 —— fetch 的规范里那是禁用端口，压根不会去连。）
   */
  const { makeNet } = await import("../server/src/cloud/net.js");
  const net = makeNet({ who: "某某云", hint: "这句是这家特有的提示。" });

  const t0 = Date.now();
  let msg = "";
  try {
    await net.fetch("http://127.0.0.1:49999/", {}, "测试连接");
  } catch (e) {
    msg = e.message;
  }
  const took = Date.now() - t0;

  checkThat("报错是中文，不是 fetch failed", msg.includes("连不上某某云"));
  checkThat("说清楚是哪一步", msg.includes("测试连接"));
  checkThat("说清楚是什么毛病", msg.includes("拒绝了连接"), msg);
  checkThat("带上这家特有的提示", msg.includes("这句是这家特有的提示。"));
  checkThat("不该重试的错误不重试（没有等两秒）", took < 2000, `花了 ${took}ms`);
  checkThat("只试了一次就别吹「重试 3 次」", !msg.includes("重试"), msg);

  // 重试时 body 得是新的流：init 传函数，每次调用都该拿到新对象
  let made = 0;
  try {
    await net.fetch(
      "http://127.0.0.1:49999/",
      () => ({ method: "POST", body: `第${++made}次` }),
      "上传"
    );
  } catch {
    /* 意料之中 */
  }
  check("init 是函数时每次试都重新造一遍", made, 1); // ECONNREFUSED 只试一次

  /*
   * 各种错误码翻得对不对 —— 直接喂错误对象，不发请求。
   *
   * AggregateError 那条是真会踩到的：域名同时有 A 和 AAAA 记录时 undici
   * 挨个试，全失败就包成一个 AggregateError，**它自己没有 code**。
   * api.github.com 正是双栈的。
   */
  const { explainNetwork } = await import("../server/src/cloud/net.js");
  const say = (cause, url = "https://api.github.com/x") =>
    explainNetwork(Object.assign(new TypeError("fetch failed"), { cause }), {
      who: "某某云",
      what: "查询",
      url,
      tried: 3,
    });

  checkThat(
    "AggregateError 里的真错误挖得出来",
    say(Object.assign(new AggregateError([Object.assign(new Error("x"), { code: "ECONNRESET" })]), {})).includes("掐断"),
    say(new AggregateError([Object.assign(new Error("x"), { code: "ECONNRESET" })]))
  );
  checkThat("超时", say({ code: "UND_ERR_CONNECT_TIMEOUT" }).includes("超时"));
  checkThat(
    "DNS 挂了会把域名报出来",
    say({ code: "ENOTFOUND" }).includes("api.github.com")
  );
  checkThat("证书被拦", say({ code: "CERT_HAS_EXPIRED" }).includes("证书"));
  checkThat("认不出的错误码也要原样报出来", say({ code: "E_离谱" }).includes("E_离谱"));
  checkThat("重试过就该说重试了几次", say({ code: "ECONNRESET" }).includes("重试 3 次"));

  /*
   * 重试真的发生了吗：起一个只管把连接掐掉的服务器（ECONNRESET），
   * 数它被连了几次。这是唯一能证明「第一次失败会再来一次」的办法。
   */
  const http = await import("node:http");
  const srv = http.createServer(() => {});
  srv.on("connection", (s) => s.destroy());
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  const port = srv.address().port;

  let hits = 0;
  srv.on("connection", () => hits++);
  const t1 = Date.now();
  let resetMsg = "";
  try {
    await net.fetch(`http://127.0.0.1:${port}/`, {}, "上传");
  } catch (e) {
    resetMsg = e.message;
  }
  const waited = Date.now() - t1;
  srv.close();

  check("被掐断会重试满 3 次", hits, 3);
  checkThat("退避真的等了（500 + 1500）", waited >= 1900, `只花了 ${waited}ms`);
  checkThat("最后抛的还是中文", resetMsg.includes("连不上某某云（上传）"), resetMsg);
}

console.log("\n=== 14. 报错说得清「哪个文件、什么毛病」===");
{
  /*
   * 这一节测的是**报错本身好不好用**，不是功能对不对。
   *
   * 起因：用户拿到的报错是
   *   Error: GitHub 拒绝了这次创建 release：Validation Failed
   *     at call (file:///F:/qq/%E5%B0%8F%E6%89%8B%E6%9C%BA/imessage/server/src/cloud/github.js:145:11)
   * —— 「Validation Failed」没说是什么毛病，那串百分号编码没说是哪个文件。
   */

  // ---- 422 的 errors[] 要摊开 ----
  const cfg = { owner: "me", repo: "backup" };
  const v422 = gh.__explainForTest(
    422,
    JSON.stringify({
      message: "Validation Failed",
      errors: [
        { resource: "Release", code: "invalid", field: "target_commitish" },
        { resource: "Release", code: "custom", field: "tag_name", message: "已经存在" },
      ],
    }),
    cfg,
    "创建 release"
  );
  checkThat("422 还是先说哪一步", v422.includes("创建 release"), v422);
  checkThat("把出问题的字段名说出来", v422.includes("target_commitish"), v422);
  checkThat("机器词翻成中文", v422.includes("这个值不对"), v422);
  checkThat("GitHub 自己那句话也留着", v422.includes("已经存在"), v422);
  checkThat("每条一行，不挤成一坨", v422.split("\n").length >= 3, JSON.stringify(v422));

  // errors[] 缺席 / 形状不对时不能炸，也不能凭空多出几行
  checkThat(
    "没有 errors[] 时照旧",
    gh.__explainForTest(422, JSON.stringify({ message: "X" }), cfg, "上传") ===
      "GitHub 拒绝了这次上传：X"
  );
  checkThat(
    "body 不是 JSON 也不炸",
    gh.__explainForTest(422, "<html>502</html>", cfg, "上传").includes("拒绝了这次上传")
  );
  checkThat("errors 是空数组时不多加行", !gh.__explainForTest(422, JSON.stringify({ message: "X", errors: [] }), cfg, "上传").includes("\n"));
  // 令牌绝不能出现在报错里
  checkThat(
    "报错里不带令牌",
    !gh
      .__explainForTest(404, "{}", { owner: "o", repo: "r", token: "ghp_secret" }, "查询")
      .includes("ghp_secret")
  );

  // ---- 栈里得看得出是哪个文件 ----
  const { log, getLogs } = await import("../server/src/logs.js");
  /** 记一条，把整理过的 detail 取回来。 */
  const detailOf = (thing) => {
    const entry = log("debug", "测试", "看一眼 detail", thing);
    return getLogs({ since: entry.id - 1 })[0]?.detail ?? "";
  };

  const real =
    "Error: GitHub 拒绝了这次创建 release：Validation Failed\n" +
    "    at call (file:///F:/qq/%E5%B0%8F%E6%89%8B%E6%9C%BA/imessage/server/src/cloud/github.js:145:11)\n" +
    "    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)\n" +
    "    at async Module.put (file:///F:/qq/%E5%B0%8F%E6%89%8B%E6%9C%BA/imessage/server/src/cloud/github.js:173:15)";
  const tidy = detailOf(real);
  checkThat("百分号编码解开了（能看出是「小手机」那个目录）", !tidy.includes("%E5%B0%8F"), tidy);
  checkThat("file:/// 前缀去掉了", !tidy.includes("file:///"), tidy);
  checkThat("路径压成相对的", tidy.includes("server/src/cloud/github.js:145"), tidy);
  checkThat("列号去掉了", !tidy.includes("github.js:145:11"), tidy);
  checkThat("node 内部帧扔掉了", !tidy.includes("processTicksAndRejections"), tidy);
  checkThat("自己的帧一条都没少", tidy.includes("github.js:173"), tidy);
  checkThat("扔了几帧要说出来", tidy.includes("1 帧框架内部"), tidy);
  checkThat("消息那一行原样留着", tidy.startsWith("Error: GitHub 拒绝了这次创建 release"), tidy);

  // 畸形的百分号序列：decodeURIComponent 会抛，不能让整条日志跟着消失
  const bad = detailOf("at x (file:///F:/qq/%E0%A4%A/imessage/server/src/x.js:1:1)");
  checkThat("畸形编码不抛，原样留着", bad.includes("x.js:1"), bad);

  // 全是内部帧时留一条 —— 一帧不留就不知道是从哪儿抛的了
  const allInternal = detailOf(
    "TypeError: bad\n    at node:internal/a.js:1:1\n    at node:internal/b.js:2:2"
  );
  checkThat("全是内部帧时至少留一条", allInternal.includes("node:internal/a.js"), allInternal);

  // 真的 Error 对象（日常就是这么传的）
  const fromError = detailOf(new Error("真的错误对象"));
  checkThat("Error 对象也走同一套整理", !fromError.includes("file:///"), fromError);

  // 超长的还是要截断（上游偶尔回几十 KB 的 HTML 错误页）
  checkThat("超长照旧截断", detailOf("x".repeat(9000)).includes("已截断"));
  // 帧数上限
  const many = detailOf(
    "Error: x\n" +
      Array.from({ length: 20 }, (_, i) => `    at f${i} (file:///a/b/c.js:${i}:1)`).join("\n")
  );
  checkThat("帧数有上限", many.split("\n").filter((l) => l.includes(" at ")).length <= 6, many);
  // 超上限扔掉的是**自己的**帧，不能说成「都是框架内部」—— 那是假话
  checkThat("超上限扔掉的不冒充框架帧", !many.includes("框架内部"), many);
  checkThat("超上限也说得出扔了几帧", many.includes("另有 14 帧"), many);

  // ---- net.js 那两条 debug 不能漏凭据 ----
  const { subscribe } = await import("../server/src/logs.js");
  const { makeNet } = await import("../server/src/cloud/net.js");
  const seen = [];
  const off = subscribe((e) => seen.push(e));
  try {
    // 签名整个在 query 里（缤纷云那条路就是这样），一个字都不该进日志
    await makeNet({ who: "某某云", scope: "云备份" })
      .fetch(
        "http://127.0.0.1:49999/x.tar.gz?X-Amz-Credential=AKIA_SECRET&X-Amz-Signature=deadbeef",
        {},
        "上传"
      )
      .catch(() => {});
  } finally {
    off();
  }
  const debugs = seen.filter((e) => e.level === "debug");
  checkThat("请求前有一条「发出去了」", debugs.some((e) => e.message.startsWith("→")), JSON.stringify(debugs.map((e) => e.message)));
  checkThat("失败有一条「怎么失败的」", debugs.some((e) => e.message.startsWith("×")));
  checkThat("说得出是哪一步", debugs.some((e) => e.message.includes("上传")));
  checkThat("路径打出来了", debugs.some((e) => e.message.includes("/x.tar.gz")));
  const all = debugs.map((e) => `${e.message}${e.detail ?? ""}`).join("\n");
  checkThat("日志里没有 Access Key", !all.includes("AKIA_SECRET"), all);
  checkThat("日志里没有签名", !all.includes("deadbeef"), all);
  checkThat("query 整段换成了省略号", all.includes("?…"), all);
}

console.log(`\n${fail ? "✗" : "✓"} ${pass} 项通过，${fail} 项失败`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
