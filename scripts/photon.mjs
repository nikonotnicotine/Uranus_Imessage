#!/usr/bin/env node
/**
 * Photon Spectrum 管理 API 小工具。
 *
 * 用来在拿不到网页 enroll（account_phone_missing）时，直接用项目凭据开通线路。
 * 凭据从环境变量读，不走命令行参数 —— 避免进入 shell 历史。
 *
 *   PHOTON_PROJECT_ID   项目 id
 *   PHOTON_SECRET       项目 secret
 *
 * 用法：
 *   node scripts/photon.mjs lines              列出项目独占线路（Free/Pro 通常为空）
 *   node scripts/photon.mjs users              列出已注册用户
 *   node scripts/photon.mjs enroll +8613800000000    注册自己的号，换取共享线路
 *   node scripts/photon.mjs remove <userId>    删掉某个用户（撤销 enroll）
 */

const BASE = "https://spectrum.photon.codes";

const projectId = (process.env.PHOTON_PROJECT_ID ?? "").trim();
const secret = (process.env.PHOTON_SECRET ?? "").trim();

if (!projectId || !secret) {
  console.error("缺少凭据。请先设置 PHOTON_PROJECT_ID 和 PHOTON_SECRET 两个环境变量。");
  process.exit(2);
}

const auth = "Basic " + Buffer.from(`${projectId}:${secret}`).toString("base64");

/** 发请求并把结果原样打出来（含错误响应体，这才是排查的关键）。 */
async function call(method, path, body) {
  const url = `${BASE}${path}`;
  console.log(`→ ${method} ${url}`);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: auth,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    console.error(`网络请求失败: ${e?.message ?? e}`);
    process.exit(1);
  }

  const raw = await res.text();
  console.log(`← HTTP ${res.status} ${res.statusText}`);
  try {
    console.log(JSON.stringify(JSON.parse(raw), null, 2));
  } catch {
    console.log(raw || "(空响应体)");
  }
  return { ok: res.ok, status: res.status, raw };
}

const [cmd, arg] = process.argv.slice(2);

switch (cmd) {
  case "lines": {
    await call("GET", `/projects/${projectId}/lines/?platform=imessage`);
    break;
  }

  case "users": {
    await call("GET", `/projects/${projectId}/users/`);
    break;
  }

  case "enroll": {
    if (!arg) {
      console.error('缺少手机号。示例: node scripts/photon.mjs enroll +8613800000000');
      process.exit(2);
    }
    if (!/^\+[1-9]\d{6,14}$/.test(arg)) {
      console.error(`手机号格式不对: ${arg}\n必须是 E.164：加号 + 国家码 + 号码，不带空格和横线，例如 +8613800000000`);
      process.exit(2);
    }
    const r = await call("POST", `/projects/${projectId}/users/`, {
      type: "shared",
      phoneNumber: arg,
    });
    if (r.ok) {
      try {
        const line = JSON.parse(r.raw)?.data?.assignedPhoneNumber;
        if (line) {
          console.log(`\n✓ 分配到的线路号码：${line}`);
          console.log(`  从你的 iPhone 发消息给这个号，桥接就能收到。`);
        }
      } catch {
        /* 上面已原样打印，这里只是锦上添花 */
      }
    }
    break;
  }

  case "remove": {
    if (!arg) {
      console.error("缺少 userId。先跑 node scripts/photon.mjs users 拿 id。");
      process.exit(2);
    }
    await call("DELETE", `/projects/${projectId}/users/${arg}`);
    break;
  }

  default:
    console.error(
      [
        "用法：",
        "  node scripts/photon.mjs lines",
        "  node scripts/photon.mjs users",
        "  node scripts/photon.mjs enroll +8613800000000",
        "  node scripts/photon.mjs remove <userId>",
      ].join("\n")
    );
    process.exit(2);
}