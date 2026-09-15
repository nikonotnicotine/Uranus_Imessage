/*
 * 上传前在**浏览器里**把图压一压，再把 base64 发给后端。
 *
 * 为什么不放到后端压：那个 Node 进程同时挂着几条 Photon 线路，真在收发消息。
 * 一次拖进来几十张几 MB 的原图，光解码重编码的峰值内存就能把它顶垮，
 * 连带整条线路一起卡住（用户原话：「不要让内存爆满」）。浏览器这边压完再传，
 * 后端那两条上传路由只做一件事：把 base64 解出来写成文件。
 *
 * 几条规矩，都是踩过的坑：
 *
 *   - **GIF 原样传。** 画到 canvas 上再编码只会拿到第一帧，动图就死了。
 *     所以 GIF 不压 —— 太大的直接报错，让用户自己换一张。
 *   - **jpeg 还编成 jpeg，其余一律编成 webp。** 同画质下 webp 最小，而且带
 *     透明通道，png 的透明底不会变黑。jpeg 不转是因为转过去省不了多少，
 *     还多一次有损重编码。
 *   - **压完反而更大就用原文件。** 本来就是压好的小图（表情包大多是），
 *     再编一遍只会掉画质又涨体积。
 *   - **一张一张来，绝不并发。** 并发解码 N 张 = 同时占 N 张位图的内存，
 *     那就等于把「内存爆满」从后端搬到了前端。调用方按顺序 await 就行。
 */

/** 单张原图的上限。再大的多半是误选了 RAW / 截屏原图，压之前就该拦。 */
export const MAX_INPUT_BYTES = 20 * 1024 * 1024;

/**
 * 压完之后允许上传的上限。
 *
 * 后端 express.json 的 limit 是 12MB，base64 会把体积撑大 1/3，
 * 6MB 的图编成 base64 差不多 8MB，留着余量给 JSON 那层外壳。
 */
export const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;

/** 参考图是拿去喂生图模型的底子，长边留大一点。 */
export const REF_MAX_SIDE = 1600;

/** 表情包是聊天气泡里的一张小图，720 已经够清楚，再大纯属浪费。 */
export const EMOJI_MAX_SIDE = 720;

/** 编码失败时按这个顺序退：先缩边长再降画质，四次还压不下去就报错。 */
const MAX_ATTEMPTS = 4;

const EXT_FOR_TYPE = {
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/png": ".png",
  "image/gif": ".gif",
};

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`;

/**
 * 换掉文件名的后缀，让它和真正的编码对上。
 *
 * 不换的话「猫.png」里装的是 webp —— 浏览器靠嗅探还能显示，但后端
 * mimeForExt 会按后缀报成 image/png，发到 iMessage 那头就是一张类型说谎的图。
 */
function renameExt(name, type) {
  const stem = String(name ?? "")
    .replace(/\.[^.]+$/, "")
    .trim();
  return `${stem || "图片"}${EXT_FOR_TYPE[type] ?? ".png"}`;
}

/** Blob → 纯 base64（去掉前面 `data:image/png;base64,` 那截）。 */
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = String(reader.result ?? "").split(",")[1];
      if (base64) resolve(base64);
      else reject(new Error("读不出这张图的内容"));
    };
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.readAsDataURL(blob);
  });
}

/**
 * canvas.toBlob 的 Promise 版。
 *
 * 浏览器不认这个 type 的时候，规范规定它**静默回落成 png** —— 所以调用方
 * 得看 blob.type 而不是自己传进去的那个，否则名字和内容会对不上。
 */
function encode(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("这张图编码失败"))), type, quality);
  });
}

/**
 * 一张图 → 可以直接 POST 上去的 `{name, base64, mimeType, bytes, kept}`。
 *
 * `kept` 为 true 表示用的是原文件（GIF、解不开的格式、或者压完更大的那种）。
 * 压不下去、格式不对、体积超限都是**抛错**，调用方接住之后逐张报给用户 ——
 * 一批里坏了一张不该把整批都停掉。
 *
 * @param {File} file 用户在 <input type=file> 里选的那个
 * @param {{maxSide?: number, quality?: number}} opts 长边上限和起始画质
 */
export async function compressImage(file, { maxSide = REF_MAX_SIDE, quality = 0.82 } = {}) {
  const label = file?.name ? `「${file.name}」` : "这个文件";
  if (!file || !String(file.type ?? "").startsWith("image/")) {
    throw new Error(`${label}不是图片`);
  }
  if (file.size > MAX_INPUT_BYTES) {
    throw new Error(`${label}有 ${mb(file.size)}，超过 ${mb(MAX_INPUT_BYTES)} 上限`);
  }

  /** 原样传：给 GIF 和解不开的格式用。 */
  const asIs = async (why) => {
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new Error(`${label}${why}，${mb(file.size)} 传不上去（上限 ${mb(MAX_UPLOAD_BYTES)}）`);
    }
    return {
      name: file.name,
      mimeType: file.type,
      base64: await blobToBase64(file),
      bytes: file.size,
      kept: true,
    };
  };

  // 动图不能重编码，压了就只剩第一帧
  if (file.type === "image/gif") return asIs("是 GIF，压了就没动画了");

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // 浏览器解不开（冷门格式、文件坏了）：原样交给后端，让用户自己看结果
    return asIs("这个浏览器解不开");
  }

  // jpeg 保持 jpeg，其余（png/webp/bmp…）统一编成 webp
  const want = file.type === "image/jpeg" ? "image/jpeg" : "image/webp";

  try {
    let side = maxSide;
    let q = quality;
    let blob = null;

    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));

      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      // jpeg 没有透明通道：不先铺一层白底，透明的地方会变成黑块
      if (want === "image/jpeg") {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, w, h);
      }
      ctx.drawImage(bitmap, 0, 0, w, h);
      blob = await encode(canvas, want, q);
      // 尺寸清零，别让这张位图一直挂在 GC 够不着的地方
      canvas.width = 0;
      canvas.height = 0;

      if (blob.size <= MAX_UPLOAD_BYTES) break;
      side = Math.round(side * 0.75);
      q = Math.max(0.5, q - 0.12);
    }

    if (!blob || blob.size > MAX_UPLOAD_BYTES) {
      throw new Error(
        `${label}压到最小还有 ${mb(blob?.size ?? file.size)}，传不上去（上限 ${mb(MAX_UPLOAD_BYTES)}）`
      );
    }
    // 压完更大：说明本来就是压好的小图，用原文件反而更划算
    if (blob.size >= file.size && file.size <= MAX_UPLOAD_BYTES) {
      return asIs("本来就够小");
    }

    // 看 blob.type：浏览器不认 webp 的话它已经悄悄回落成 png 了
    const type = blob.type || want;
    return {
      name: renameExt(file.name, type),
      mimeType: type,
      base64: await blobToBase64(blob),
      bytes: blob.size,
      kept: false,
    };
  } finally {
    // 位图占的是解码后的原始像素（4 字节 × 宽 × 高），一张 4000×3000 就是 48MB，
    // 不显式放掉的话连传几十张能把标签页拖垮
    bitmap.close?.();
  }
}
