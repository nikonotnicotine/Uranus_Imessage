/**
 * 从 client/public/欢迎页.png 生成 favicon 和界面用的徽标。
 *
 * 不引第三方图像库：源图是 8-bit RGBA、非隔行的 PNG，用 zlib 手工解一下就够了。
 *
 * **用整张图，不裁不抠**（源图 999x999，本来就是正方形，直接等比缩）。
 * 上一版裁了中间那颗球再切圆，结果是错的：那颗球是接近纯黑的实心球
 * （中心像素 38,38,38），单独拿出来缩小之后就是一个黑圆点，什么都看不出来
 * —— 界面里那个徽标看着就是一团黑。整幅构图（球 + 竖环 + 左右声波 +
 * 底部 URANUS 字样）留着，缩小后至少还有明暗层次和轮廓。
 *
 * 源图是**满幅不透明白底**（四角都是 255,255,255,255，零个半透明像素），
 * 所以生成物也都是白底不透明的，不做透明处理 —— 整张图的白就是它的一部分，
 * 挖掉白底只会剩一堆悬空的线条。代价：深色标签栏上会是一个白方块。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, "../client/public");
const SRC = path.join(PUB, "欢迎页.png");

/* ---------------- 解码 ---------------- */

function readChunks(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("不是 PNG");
  const out = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.slice(off + 4, off + 8).toString("latin1");
    out.push({ type, data: buf.slice(off + 8, off + 8 + len) });
    off += 12 + len;
    if (type === "IEND") break;
  }
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** 只处理 bitDepth=8 / colorType=6（RGBA）/ interlace=0 —— 够用就行。 */
function decodePng(buf) {
  const chunks = readChunks(buf);
  const ihdr = chunks.find((c) => c.type === "IHDR").data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  const interlace = ihdr[12];
  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error(`只支持 8-bit RGBA 非隔行，实际 depth=${bitDepth} color=${colorType} interlace=${interlace}`);
  }

  const idat = Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data));
  const raw = zlib.inflateSync(idat);

  const bpp = 4;
  const stride = width * bpp;
  const px = Buffer.alloc(height * stride);

  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.slice(pos, pos + stride);
    pos += stride;
    const cur = px.slice(y * stride, (y + 1) * stride);
    const prev = y > 0 ? px.slice((y - 1) * stride, y * stride) : null;

    for (let x = 0; x < stride; x++) {
      const rawByte = line[x];
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let val;
      switch (filter) {
        case 0: val = rawByte; break;
        case 1: val = rawByte + a; break;
        case 2: val = rawByte + b; break;
        case 3: val = rawByte + ((a + b) >> 1); break;
        case 4: val = rawByte + paeth(a, b, c); break;
        default: throw new Error(`未知 filter ${filter} 于第 ${y} 行`);
      }
      cur[x] = val & 0xff;
    }
  }

  return { width, height, data: px };
}

/* ---------------- 合成 ---------------- */

function blank(size, rgba = [0, 0, 0, 0]) {
  const data = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = rgba[0];
    data[i * 4 + 1] = rgba[1];
    data[i * 4 + 2] = rgba[2];
    data[i * 4 + 3] = rgba[3];
  }
  return { width: size, height: size, data };
}

/**
 * 非正方形的源图先补白成正方形（居中），不然等比缩会变形。
 * 现在这张源图本来就是 999x999，这个分支平时走不到 —— 换图时的保险。
 */
function padSquare(img, fill = [255, 255, 255, 255]) {
  const { width: w, height: h } = img;
  if (w === h) return img;
  const size = Math.max(w, h);
  const out = blank(size, fill);
  const ox = Math.floor((size - w) / 2);
  const oy = Math.floor((size - h) / 2);
  for (let y = 0; y < h; y++) {
    img.data.copy(out.data, ((y + oy) * size + ox) * 4, y * w * 4, (y + 1) * w * 4);
  }
  console.log(`源图不是正方形（${w}x${h}），已居中补白到 ${size}x${size}`);
  return out;
}

/** 把不透明的图压到白底上（源图已经不透明，这里只是兜底）。 */
function flattenOnWhite(img) {
  const { width: w, height: h, data } = img;
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    const a = data[o + 3] / 255;
    out[o] = Math.round(data[o] * a + 255 * (1 - a));
    out[o + 1] = Math.round(data[o + 1] * a + 255 * (1 - a));
    out[o + 2] = Math.round(data[o + 2] * a + 255 * (1 - a));
    out[o + 3] = 255;
  }
  return { width: w, height: h, data: out };
}

/* ---------------- 缩放 ---------------- */

/**
 * 盒式滤波降采样。缩小图标时比最近邻干净得多，而且不用引依赖。
 * alpha 预乘后再平均，否则透明边缘会把黑边糊进来。
 */
function resize(img, size) {
  const { width: sw, height: sh, data: src } = img;
  const dst = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    const y0 = Math.floor((y * sh) / size);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / size));
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor((x * sw) / size);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / size));

      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * sw + xx) * 4;
          const av = src[i + 3] / 255;
          r += src[i] * av;
          g += src[i + 1] * av;
          b += src[i + 2] * av;
          a += src[i + 3];
          n++;
        }
      }
      const o = (y * size + x) * 4;
      const am = a / n; // 平均 alpha（0..255）
      if (am < 0.5) {
        dst[o] = dst[o + 1] = dst[o + 2] = dst[o + 3] = 0;
      } else {
        const k = am / 255;
        dst[o] = Math.round(r / n / k);
        dst[o + 1] = Math.round(g / n / k);
        dst[o + 2] = Math.round(b / n / k);
        dst[o + 3] = Math.round(am);
      }
    }
  }
  return { width: size, height: size, data: dst };
}

/* ---------------- 编码 ---------------- */

function crc32(buf) {
  let c;
  const table = crc32.table ?? (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(img) {
  const { width, height, data } = img;
  const stride = width * 4;
  // filter 0（None）逐行前缀；图标很小，压缩率差异可以忽略
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bitDepth
  ihdr[9] = 6;   // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** ICO 里每张都塞 PNG（Vista 以后通用，现代浏览器全支持）。 */
function encodeIco(images) {
  const pngs = images.map(encodePng);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(images.length, 4);

  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach((img, i) => {
    const o = i * 16;
    dir[o] = img.width >= 256 ? 0 : img.width;   // 256 记作 0
    dir[o + 1] = img.height >= 256 ? 0 : img.height;
    dir[o + 2] = 0; // 调色板
    dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4);   // 色彩平面
    dir.writeUInt16LE(32, o + 6);  // 位深
    dir.writeUInt32LE(pngs[i].length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += pngs[i].length;
  });

  return Buffer.concat([header, dir, ...pngs]);
}

/* ---------------- 跑 ---------------- */

const src = decodePng(fs.readFileSync(SRC));
console.log(`源图 ${src.width}x${src.height}`);

// 整张图，不裁不抠。只做两件事：非方图补白成方（换图时的保险）+ 压到白底
const master = flattenOnWhite(padSquare(src));
console.log(`用整张图 ${master.width}x${master.height}（不裁切）`);

const icoSizes = [16, 32, 48, 64, 128, 256];
const icoPath = path.join(PUB, "favicon.ico");
fs.writeFileSync(icoPath, encodeIco(icoSizes.map((s) => resize(master, s))));
console.log(`favicon.ico  ${icoSizes.join("/")}  ${fs.statSync(icoPath).size} B`);

for (const [name, size] of [
  ["favicon-32.png", 32],
  ["favicon-192.png", 192],
  ["favicon-512.png", 512],
  // 界面里那个徽标（UranusBadge）用这张：最大显示 120px，256 够两倍屏
  ["uranus-mark.png", 256],
  // iOS 会自己套圆角矩形。源图四周本来就留了白边，直接缩满幅就行，
  // 不用再 inset 留白（那样白边会叠两层、构图反而更小）
  ["apple-touch-icon.png", 180],
]) {
  const buf = encodePng(resize(master, size));
  fs.writeFileSync(path.join(PUB, name), buf);
  console.log(`${name}  ${size}x${size}  ${buf.length} B`);
}