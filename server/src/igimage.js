/**
 * 把本地那张图弄成 Meta 肯收的样子，然后临时挂到公网上。
 *
 * ── 为什么必须有这一步 ──
 *
 * Meta 的发布接口不接受上传字节，只接受一个 `image_url` —— **它自己**去下载。
 * 所以本地文件路径没用，`data:` URL 也没用，必须是公网能匿名访问的 HTTPS 地址。
 *
 * 另外它对图片本身有硬要求，不合规直接 400：
 *
 *   格式    只吃 JPEG（PNG / WebP 一律拒）
 *   比例    4:5 ~ 1.91:1（竖到 0.8、横到 1.91）—— **硬性**，超出就发不出去
 *   宽度    320 ~ 1440 px
 *   体积    ≤ 8MB
 *
 * 我们本地生成的图多半是 PNG 正方形，正方形（1:1）在 4:5~1.91:1 里面，
 * 所以通常只需要转格式；但用户自己传的手机截图（9:16 = 0.5625）就一定要裁。
 *
 * ── 为什么用 ffmpeg ──
 *
 * 项目里没有 sharp / jimp，但 `ffmpeg-static` 已经是依赖了（media.js 拿它
 * 转语音条）。ffmpeg 做「转 JPEG + 居中裁到某个比例 + 限宽」一条命令就够，
 * 不新增依赖是这里唯一在意的事 —— 为了发个帖子往 package.json 里塞一个
 * 带原生模块的图像库，装不上的时候整个项目都跑不起来。
 *
 * ── 为什么用图床、而不是 Tunnel ──
 *
 * 用户选的。Tunnel（cloudflared）要常驻一个进程、免费版每次重启换域名，
 * 而这个功能一天可能只发一两条 —— 为它守着一个隧道不划算。
 * Cloudinary 有删除 API，所以能做到**发完即删**：图片在公网上的暴露窗口
 * 是「Meta 下载完那一刻」到「我们发完删掉」，通常几秒。
 *
 * 不用 imgbb：它默认永久公开，删除要另存一个 delete token，容易漏。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ffmpegPath, runFfmpeg } from "./ffmpeg.js";
import { logInfo, logWarn } from "./logs.js";
import { IG_TIMEOUT, maskToken } from "./ignet.js";
import { whyNetwork } from "./net.js";

const SCOPE = "Instagram";

/* ================= Meta 的硬约束 ================= */

/** 信息流图片的比例区间。竖到 4:5、横到 1.91:1，超出直接被拒。 */
export const MIN_RATIO = 4 / 5; // 0.8
export const MAX_RATIO = 1.91;

/** 宽度区间。窄了会被拒，宽了 Meta 自己压（但我们先压好，省上传流量）。 */
export const MIN_WIDTH = 320;
export const MAX_WIDTH = 1440;

/** 体积上限 8MB。JPEG 质量固定 88，1440 宽基本不可能超。 */
export const MAX_BYTES = 8 * 1024 * 1024;

/**
 * 快拍的比例。
 *
 * 9:16 只是**推荐**值，不是硬要求 —— 别的比例照样能发，Meta 会自己裁或加边。
 * 所以快拍这一路我们只转格式、不裁比例：裁了反而丢内容，而用户看到的是
 * 一张被我们裁过、又被 Meta 处理过的图。
 */
export const STORY_RATIO = 9 / 16;

/* ================= ffmpeg ================= */

/* ffmpegPath / runFfmpeg 都在 ./ffmpeg.js —— media.js 也用同一份。 */

/**
 * 从 ffmpeg 的 stderr 里读出宽高。`Stream #0:0: Video: png, rgba, 1024x1024`
 *
 * **只用来读单个输入的尺寸**（`imageSize`）。转码那一路的 stderr 里会同时有
 * 输入和输出两段流信息，靠这个正则挑不出该要哪一个 —— 那边改成直接探输出文件。
 */
function parseSize(stderr) {
  const m = /,\s(\d{2,5})x(\d{2,5})[\s,]/.exec(String(stderr ?? ""));
  if (!m) return null;
  return { width: Number(m[1]), height: Number(m[2]) };
}

/**
 * 读一张图的尺寸。
 *
 * 用 ffmpeg 而不是自己解析文件头：PNG / JPEG / WebP / GIF 的头各不一样，
 * 手写四套解析器只为拿宽高不值得，而 ffmpeg 反正已经要调了。
 */
export async function imageSize(file) {
  const bin = await ffmpegPath();
  if (!bin) return null;
  // 只探信息：没有输出文件，ffmpeg 会以 code 1 退出并把流信息打在 stderr 里
  const { stderr } = await runFfmpeg(bin, ["-hide_banner", "-i", file]);
  return parseSize(stderr);
}

/**
 * 算出裁剪参数：把 `w×h` 收进 `[MIN_RATIO, MAX_RATIO]`。
 *
 * **居中裁**，不加边：加黑边在 IG 上很难看，而且用户没要求过。太竖的图裁掉
 * 上下（保留中间），太宽的裁掉左右。
 *
 * 返回 null = 比例本来就合规，不用裁。
 */
export function cropFor(w, h, minRatio = MIN_RATIO, maxRatio = MAX_RATIO) {
  if (!(w > 0) || !(h > 0)) return null;
  const ratio = w / h;
  if (ratio >= minRatio && ratio <= maxRatio) return null;

  if (ratio < minRatio) {
    // 太竖了：宽度不动，高度收到 w / minRatio
    const targetH = Math.floor(w / minRatio);
    return { w, h: targetH, x: 0, y: Math.floor((h - targetH) / 2) };
  }
  // 太宽了：高度不动，宽度收到 h * maxRatio
  const targetW = Math.floor(h * maxRatio);
  return { w: targetW, h, x: Math.floor((w - targetW) / 2), y: 0 };
}

/**
 * 转成 Meta 肯收的 JPEG。
 *
 * 三件事一条命令：居中裁到合规比例 → 限宽到 1440（不放大）→ 编码成 JPEG。
 *
 * `-q:v 3` 是 JPEG 质量（2 最好、31 最差），3 对应大约 90 分的质量，
 * 1440 宽的图出来通常 300–600KB，离 8MB 上限很远。
 *
 * 宽度不足 320 的**放大**到 320：那是硬性下限，不放大就发不出去，
 * 而放大一张小图总比整条发不出去好。
 *
 * @param {string} file 本地图片路径
 * @param {{isStory?: boolean}} [opts]
 * @returns {Promise<{buffer: Buffer, width: number, height: number, cropped: boolean}>}
 * @throws {Error} 中文原因
 */
export async function toIgJpeg(file, opts = {}) {
  const bin = await ffmpegPath();
  if (!bin) {
    throw new Error("找不到 ffmpeg（ffmpeg-static 没装成、PATH 上也没有），没法把图片转成 Meta 要的 JPEG");
  }

  const size = await imageSize(file);
  if (!size) throw new Error("读不出这张图的尺寸（文件坏了？）");

  // 快拍不裁比例（9:16 只是推荐值），只走格式和宽度那两步
  const crop = opts.isStory ? null : cropFor(size.width, size.height);
  const afterCropW = crop ? crop.w : size.width;

  const filters = [];
  if (crop) filters.push(`crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`);
  if (afterCropW > MAX_WIDTH) filters.push(`scale=${MAX_WIDTH}:-2`);
  else if (afterCropW < MIN_WIDTH) filters.push(`scale=${MIN_WIDTH}:-2`);

  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "uranus-ig-"));
  const out = path.join(dir, "out.jpg");
  try {
    const args = ["-y", "-hide_banner", "-i", file];
    if (filters.length) args.push("-vf", filters.join(","));
    // -frames:v 1 是给 GIF 兜底：动图只取第一帧，不然 ffmpeg 会写出一串图
    args.push("-frames:v", "1", "-q:v", "3", "-pix_fmt", "yuvj420p", out);

    const { code, stderr } = await runFfmpeg(bin, args);
    if (code !== 0) throw new Error(`ffmpeg 转 JPEG 失败（退出码 ${code}）：${clipLine(stderr)}`);

    const buffer = await fs.promises.readFile(out);
    if (!buffer.length) throw new Error("ffmpeg 转出来是空文件");
    if (buffer.length > MAX_BYTES) {
      throw new Error(`转出来 ${Math.round(buffer.length / 1024 / 1024)}MB，超过 Meta 的 8MB 上限`);
    }

    /*
     * 探一次**输出文件**的真实尺寸。
     *
     * 不从上面那次转码的 stderr 里读：那段里输入流和输出流的尺寸都在，正则会
     * 抓到先出现的那个（输入），于是返回的宽高描述的是原图 —— 裁过之后就全错了。
     * 也不自己按 crop / scale 算：`scale=1440:-2` 的高度是 ffmpeg 按偶数对齐后
     * 的结果，算出来会差一两个像素。多跑一次 `-i` 只是几十毫秒，换一个确定的值。
     */
    const finalSize = (await imageSize(out)) ?? {
      width: afterCropW,
      height: crop?.h ?? size.height,
    };
    if (crop) {
      logInfo(
        SCOPE,
        `图片比例 ${(size.width / size.height).toFixed(2)} 超出 Meta 的 4:5~1.91:1，` +
          `居中裁成 ${crop.w}×${crop.h}`
      );
    }
    return {
      buffer,
      width: finalSize.width,
      height: finalSize.height,
      cropped: Boolean(crop),
    };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function clipLine(text) {
  // ffmpeg 的 stderr 很长，末尾那几行才是真正的报错
  const lines = String(text ?? "").trim().split(/\r?\n/).filter(Boolean);
  return lines.slice(-2).join(" ").slice(0, 300);
}

/* ================= Cloudinary ================= */

/**
 * Cloudinary 的签名。
 *
 * 规则：把除 `file` / `api_key` / 签名本身以外的参数按键名排序、拼成
 * `k=v&k=v`，末尾接上 api_secret，取 SHA-1。签名走的是**服务端**上传，
 * 所以 api_secret 只在这台机器上出现，不进任何 URL 的 query。
 */
function signParams(params, apiSecret) {
  const base = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== "")
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return crypto.createHash("sha1").update(`${base}${apiSecret}`).digest("hex");
}

/**
 * 上传重试：最多 3 次，间隔 1.5 秒。
 *
 * 实测传图床本身很稳（10/10），偶尔一次握手超时，重试一次就过。3 次是给
 * 网络刚重连那种连着失败两次的场合留的余量。
 */
const UPLOAD_TRIES = 3;
const UPLOAD_GAP = 1500;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 图床配好了没有（三项都得有）。 */
export function hostReady(imageHost) {
  return Boolean(
    imageHost?.cloudName?.trim() && imageHost?.apiKey?.trim() && imageHost?.apiSecret?.trim()
  );
}

/**
 * 传一张图上 Cloudinary，返回 `{url, publicId}`。
 *
 * `public_id` 里带一个随机段：**别人猜不到这个 URL**。Cloudinary 的资源是
 * 公开可读的（Meta 要能匿名下载，这是必需的），所以唯一的隐私手段就是
 * 「路径不可预测 + 用完就删」。
 *
 * 路径前缀固定 `uranus-ig/`，方便用户在 Cloudinary 后台一眼认出来、
 * 也方便万一漏删了批量清理。
 *
 * @param {Buffer} buffer JPEG 字节
 * @param {object} imageHost accounts.json 里那份 imageHost
 * @returns {Promise<{url: string, publicId: string}>}
 * @throws {Error} 中文原因
 */
export async function uploadToHost(buffer, imageHost) {
  if (!hostReady(imageHost)) {
    throw new Error("图床还没配 —— Instagram 那一页填上 Cloudinary 的 cloud name / API key / secret");
  }
  const cloud = imageHost.cloudName.trim();
  const apiKey = imageHost.apiKey.trim();
  const apiSecret = imageHost.apiSecret.trim();

  const publicId = `uranus-ig/${Date.now().toString(36)}-${crypto.randomBytes(9).toString("hex")}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signParams({ public_id: publicId, timestamp }, apiSecret);

  const form = new FormData();
  form.append("file", new Blob([buffer], { type: "image/jpeg" }), "post.jpg");
  form.append("api_key", apiKey);
  form.append("timestamp", String(timestamp));
  form.append("public_id", publicId);
  form.append("signature", signature);

  const url = `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloud)}/image/upload`;
  /*
   * 连不上就重试几次。
   *
   * 图床本身国内直连就通，但偶尔会撞 `UND_ERR_CONNECT_TIMEOUT` —— 握手那一下没成，重试一次就好。
   * 不重试的代价很大：这一步失败会让前面的生图和转码全白做。
   * 只重试**网络层**异常；HTTP 层的错（签名不对、额度满了）重试没意义，
   * 交给下面的分支去报。
   */
  let res;
  let netErr = null;
  for (let attempt = 1; attempt <= UPLOAD_TRIES; attempt += 1) {
    try {
      res = await fetch(url, { method: "POST", body: form, signal: AbortSignal.timeout(IG_TIMEOUT) });
      netErr = null;
      break;
    } catch (e) {
      netErr = e;
      if (attempt < UPLOAD_TRIES) {
        logWarn(SCOPE, `图床连不上（第 ${attempt} 次），过一下重试`, e);
        await sleep(UPLOAD_GAP);
      }
    }
  }
  // 这句会进日志、也会成为「这条帖子没发出去」的原因。原来是 e.message，
  // 也就是一句 fetch failed
  if (netErr) throw new Error(`图床上传失败：${whyNetwork(netErr, IG_TIMEOUT)}`);

  const raw = await res.text();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`图床返回的不是 JSON：${raw.slice(0, 200)}`);
  }
  if (!res.ok || data?.error) {
    throw new Error(`图床上传失败：${data?.error?.message || `HTTP ${res.status}`}`);
  }
  const secureUrl = String(data.secure_url ?? "").trim();
  if (!secureUrl) throw new Error("图床没返回 secure_url");

  logInfo(SCOPE, `图片已传到图床（${Math.round(buffer.length / 1024)}KB）：${maskToken(secureUrl)}`);
  return { url: secureUrl, publicId: String(data.public_id ?? publicId) };
}

/**
 * 从图床删掉一张图。
 *
 * **永不抛错**：这是收尾动作，帖子已经发出去了。删失败只意味着一张图在
 * Cloudinary 上多留一阵（路径不可预测，实际风险很低），把它变成一个异常
 * 会让调用方以为整条发布失败、然后重发一遍。
 */
export async function deleteFromHost(publicId, imageHost) {
  if (!publicId || !hostReady(imageHost)) return false;
  const cloud = imageHost.cloudName.trim();
  const apiKey = imageHost.apiKey.trim();
  const apiSecret = imageHost.apiSecret.trim();

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signParams({ public_id: publicId, timestamp }, apiSecret);

  const form = new FormData();
  form.append("public_id", publicId);
  form.append("api_key", apiKey);
  form.append("timestamp", String(timestamp));
  form.append("signature", signature);

  try {
    const res = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloud)}/image/destroy`, { method: "POST", body: form, signal: AbortSignal.timeout(IG_TIMEOUT) });
    const data = await res.json().catch(() => null);
    if (data?.result === "ok" || data?.result === "not found") return true;
    logWarn(SCOPE, `图床上那张临时图没删掉（${publicId}）：${data?.result ?? res.status}`);
    return false;
  } catch (e) {
    logWarn(SCOPE, `图床上那张临时图没删掉（${publicId}）`, e);
    return false;
  }
}
