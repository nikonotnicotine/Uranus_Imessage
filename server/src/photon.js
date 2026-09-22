/**
 * Photon Spectrum 管理 API 封装。
 *
 * 目前只用到「创建共享用户」这一个接口：把用户自己的手机号登记到项目里，
 * Photon 会从共享号码池分配一条 iMessage 线路，返回 assignedPhoneNumber。
 *
 * 走这条 API 的好处是不需要网页端那套「先给账号绑手机 → 收短信验证码」的流程，
 * 部分地区/运营商收不到 Photon 的验证码，网页流程会卡在 account_phone_missing。
 */

import { logDebug, logWarn } from "./logs.js";
import { fetchVia, whyNetwork } from "./proxy.js";

const PHOTON_BASE = "https://spectrum.photon.codes";

/**
 * 日志里**绝不能出现** Basic auth 那串 base64 —— 它就是
 * `projectId:projectSecret` 换了个编码，等于明文凭据。
 *
 * projectId 本身不是秘密（它在 URL 里），但也只打前 8 位就够定位是哪个项目了。
 */
const shortId = (id) => String(id ?? "").slice(0, 8);

/** E.164：加号 + 国家码起始的 7~15 位数字。 */
export const PHONE_RE = /^\+[1-9]\d{6,14}$/;

/**
 * 把用户输入的手机号规范成 E.164。
 * 允许输入里带空格、横线、括号，缺 + 号时补上。
 */
export function normalizePhone(raw) {
  const digits = String(raw ?? "").replace(/\D/g, "");
  return digits ? `+${digits}` : "";
}

/**
 * 查项目里已登记的用户，找出手机号匹配的那条。
 * 用来避免重复登记——每次创建都会占用项目的共享用户配额。
 *
 * @returns {Promise<{assignedPhoneNumber: string, userId: string} | null>}
 *          查不到、或接口失败时返回 null（调用方继续走创建流程）
 */
export async function findSharedUser({ projectId, projectSecret, phoneNumber }) {
  if (!projectId || !projectSecret || !PHONE_RE.test(phoneNumber)) return null;

  const auth = Buffer.from(`${projectId}:${projectSecret}`).toString("base64");
  try {
    logDebug("Photon", `查已登记的用户（项目 ${shortId(projectId)}…）`);
    // Photon 实测直连就通，所以这一类出厂不勾代理（勾了也认，见 proxy.js）
    const res = await fetchVia(
      "photon",
      `${PHOTON_BASE}/projects/${projectId}/users/`,
      () => ({ headers: { Authorization: `Basic ${auth}` } }),
      (why) => logDebug("Photon", `查已登记的用户${why}`)
    );
    /*
     * 下面这几个 return null 以前是**完全静默**的，于是「凭据错了」「网络
     * 不通」和「这个号确实没登记过」三件完全不同的事在调用方看来一模一样，
     * 排查时无从下手。返回值不改（调用方靠 null 走创建流程），但话要说出来。
     */
    if (!res.ok) {
      logWarn("Photon", `查已登记的用户失败（HTTP ${res.status}），当作没查过继续`);
      return null;
    }
    const body = await res.json();
    // 实测响应形如 { succeed, data: { users: [...], total } }
    const users = body?.data?.users ?? body?.data ?? [];
    if (!Array.isArray(users)) {
      logWarn("Photon", "查已登记的用户：返回里没有用户列表，接口可能有变动");
      return null;
    }

    const hit = users.find(
      (u) => u?.phoneNumber === phoneNumber && u?.assignedPhoneNumber
    );
    logDebug(
      "Photon",
      `项目里有 ${users.length} 个用户，${hit ? `这个号已登记，线路 ${hit.assignedPhoneNumber}` : "没有这个号，走创建流程"}`
    );
    return hit
      ? { assignedPhoneNumber: hit.assignedPhoneNumber, userId: hit.id ?? "" }
      : null;
  } catch (e) {
    logWarn("Photon", `查已登记的用户时连不上，当作没查过继续：${whyNetwork(e, "photon")}`, e);
    return null; // 查不到就当没查过，交给创建流程
  }
}

/**
 * 在项目里登记一个共享用户，拿到分配的 iMessage 线路号码。
 *
 * @param {{projectId: string, projectSecret: string, phoneNumber: string}} args
 * @returns {Promise<{assignedPhoneNumber: string, userId: string, raw: object}>}
 * @throws {Error} 带 .status（HTTP 状态码，网络层失败时为 0）
 */
export async function enrollSharedUser({ projectId, projectSecret, phoneNumber }) {
  if (!projectId || !projectSecret) {
    throw fail("缺少 Project ID 或 Project Secret", 0);
  }
  if (!PHONE_RE.test(phoneNumber)) {
    throw fail("手机号格式不对，需要 E.164 格式（例如 +8613800138000）", 0);
  }

  const auth = Buffer.from(`${projectId}:${projectSecret}`).toString("base64");
  let res;
  try {
    logDebug("Photon", `登记共享用户 ${phoneNumber}（项目 ${shortId(projectId)}…）`);
    res = await fetchVia(
      "photon",
      `${PHOTON_BASE}/projects/${projectId}/users/`,
      () => ({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${auth}`,
        },
        body: JSON.stringify({ type: "shared", phoneNumber }),
      }),
      (why) => logDebug("Photon", `登记共享用户${why}`)
    );
    logDebug("Photon", `登记共享用户：HTTP ${res.status}`);
  } catch (e) {
    /*
     * 这句话会出现在「开通线路」那个按钮下面，是用户唯一能看到的原因。
     * 原来是 `e.message`，也就是一句 `fetch failed` —— 而这一类出厂**不勾**
     * 代理（Photon 实测直连就通），所以真正的原因多半是「这台机器出不了网」
     * 或者「勾错了代理」，whyNetwork 正好会把这两种分开说。
     */
    throw fail(`连不上 Photon：${whyNetwork(e, "photon")}`, 0);
  }

  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* 非 JSON，下面按状态码报错 */
  }

  if (!res.ok) {
    const detail =
      body?.message ??
      body?.error ??
      (text ? text.slice(0, 200) : `HTTP ${res.status}`);
    throw fail(describe(res.status, detail), res.status);
  }

  const data = body?.data ?? body;
  const assigned = data?.assignedPhoneNumber;
  if (!assigned) {
    throw fail("Photon 返回里没有 assignedPhoneNumber，可能接口有变动", res.status);
  }

  logDebug("Photon", `登记成功，分到线路 ${assigned}`);
  return {
    assignedPhoneNumber: assigned,
    userId: data?.id ?? "",
    raw: data,
  };
}

function fail(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** 把常见状态码翻译成能照着做的中文提示。 */
function describe(status, detail) {
  if (status === 401 || status === 403) {
    return `凭据被拒绝（${status}）：检查 Project ID / Project Secret 是否配对、有没有多余空格。`;
  }
  if (status === 404) {
    return `找不到这个项目（404）：Project ID 可能写错了。`;
  }
  if (status === 409) {
    return `这个手机号已经登记过了（409）。如果之前登记成功，直接用当时拿到的线路号码即可。`;
  }
  if (status === 422 || status === 400) {
    return `请求被拒绝（${status}）：${detail}`;
  }
  if (status === 429) {
    return `请求太频繁（429），稍等再试。`;
  }
  return `Photon 返回 ${status}：${detail}`;
}
