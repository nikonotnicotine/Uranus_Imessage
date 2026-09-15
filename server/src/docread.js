/**
 * 读用户发来的文件，把正文抽成一段纯文字。
 *
 * 支持 txt / md / json / docx / pdf 五种（用户定的）。抽出来的文字当成一条普通
 * 消息进合并队列，所以下游 handleTurn 和提示词一个字都不用改 —— 对模型来说
 * 就是「对方发了个文件，内容是这些」。
 *
 * ── 为什么不打模型 ──
 *
 * 识图和听音都要花钱（各自一个 API 调用），这个不用：解压 docx 拿 XML、
 * 解 pdf 的文本流，全是本地计算。所以角色那个开关**默认开**，和识图一致、
 * 和听音（按秒计费，默认关）不同。
 *
 * ── 判断靠后缀不靠 mimeType ──
 *
 * Photon 报什么 mime 不可靠，isAudioAttachment 那边的注释已经吃过一次亏
 * （苹果的 caf 容器可能被报成 audio/x-caf、audio/amr、audio/mp4 里的任意一个）。
 * 文件名后缀是用户自己起的，反而稳定。mimeType 只在没有后缀时兜一下。
 *
 * ── docx / pdf 的依赖是懒加载的 ──
 *
 * `await import()` 而不是文件顶部静态 import：这两个包没装好时（老用户
 * npm install 没跑到）只是这一个文件读不出来、记一条错误日志，不会让整个服务
 * 起不来。txt / md / json 压根不需要任何依赖。
 */

import { logInfo } from "./logs.js";

/**
 * 单个文件最大 10MB。
 *
 * 比图片（8MB）宽一点：真正进提示词的是抽出来的**文字**，还要再被 maxChars
 * 截一刀，所以文件本身大不代表 token 多 —— 一个 10MB 的 pdf 大概率是几百页
 * 扫描图，抽出来可能一个字都没有。这道闸挡的是「解析它会把内存吃光」。
 */
const MAX_DOC_BYTES = 10 * 1024 * 1024;

/** 认这几种后缀。三个纯文本 + 两个要解析的。 */
const PLAIN_EXTS = new Set(["txt", "md", "json"]);
const DOC_EXTS = new Set(["docx", "pdf"]);

/** 从文件名里取小写后缀。取不到返回空串。 */
function extOf(name) {
  const s = String(name ?? "");
  const at = s.lastIndexOf(".");
  if (at < 0 || at === s.length - 1) return "";
  return s.slice(at + 1).toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * 判断一条内容是不是我们能读的文件。
 *
 * 只认 `type === "attachment"`：图片和语音走各自的分类函数（isImageAttachment /
 * isAudioAttachment），在调用处已经先挑走了。
 *
 * 没有后缀时才看 mimeType，只兜三种最没有歧义的 —— 别学 audio 那边用前缀
 * 匹配，`text/` 前缀会把 vcard、日历订阅这些一起收进来。
 */
export function isDocAttachment(content) {
  if (content?.type !== "attachment") return false;
  const ext = extOf(content.name);
  if (PLAIN_EXTS.has(ext) || DOC_EXTS.has(ext)) return true;
  if (ext) return false; // 有后缀但不在白名单里（.zip、.mov…）：不是我们的活

  const mime = String(content.mimeType ?? "").toLowerCase();
  return (
    mime === "text/plain" ||
    mime === "text/markdown" ||
    mime === "application/json" ||
    mime === "application/pdf" ||
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
}

/** 后缀认不出来时，按 mimeType 猜一个。 */
function kindOf(content) {
  const ext = extOf(content?.name);
  if (PLAIN_EXTS.has(ext) || DOC_EXTS.has(ext)) return ext;
  const mime = String(content?.mimeType ?? "").toLowerCase();
  if (mime === "application/pdf") return "pdf";
  if (mime.endsWith("wordprocessingml.document")) return "docx";
  return "txt"; // text/plain、application/json 都按纯文本读
}

/** 收尾：统一换行、压掉大段空行、去掉每行尾巴的空格。 */
function tidy(raw) {
  return String(raw ?? "")
    .replace(/^﻿/, "") // BOM：utf8 解码不会自动去掉，留着会变成正文第一个字符
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 读一个文件，返回正文。
 *
 * @param {object} content SDK 的 attachment content
 * @param {{maxChars?: number, scope?: string}} [opts]
 * @returns {Promise<{name: string, text: string, truncated: boolean}>}
 * @throws 读不出来、格式不支持、超过大小上限都抛 —— 调用方按「这一个文件没读到」
 *         处理，不影响同一批里的图片和语音
 */
export async function readDocument(content, opts = {}) {
  const maxChars = Number(opts.maxChars) > 0 ? Math.floor(opts.maxChars) : 2000;
  const scope = opts.scope ?? "桥接";
  const name = String(content?.name ?? "").trim() || "未命名文件";

  const buf = await content.read();
  if (!buf?.length) throw new Error("附件读出来是空的");
  if (buf.length > MAX_DOC_BYTES) {
    throw new Error(
      `文件 ${(buf.length / 1024 / 1024).toFixed(1)}MB，超过 ${MAX_DOC_BYTES / 1024 / 1024}MB 上限`
    );
  }

  const kind = kindOf(content);
  logInfo(
    scope,
    `收到文件「${name}」：${(buf.length / 1024).toFixed(0)}KB，按 ${kind} 读，` +
      `mimeType=${content.mimeType ?? "（空）"}`
  );

  let raw = "";
  if (kind === "docx") {
    // mammoth 解 docx（其实是个 zip 里的 XML）。extractRawText 只要文字，
    // 不要样式 —— 模型看不见加粗，转 HTML 只是白涨 token
    const mammoth = await import("mammoth");
    const fn = mammoth.default?.extractRawText ?? mammoth.extractRawText;
    const out = await fn({ buffer: buf });
    raw = out?.value ?? "";
  } else if (kind === "pdf") {
    /*
     * pdf-parse 2.x 是重写过的，和网上大部分示例（`pdfParse(buffer)` 一个函数）
     * 不一样：导出的是 `PDFParse` 这个类，`default` 是 undefined，也**没有**
     * `pdf-parse/lib/pdf-parse.js` 这个子路径（exports 只开了 `.` / `./worker`
     * / `./node`，硬点会 ERR_PACKAGE_PATH_NOT_EXPORTED）。
     *
     * 拿 pages 自己拼，不用 out.text —— 后者会在每页之间插一行
     * `-- 1 of 1 --` 的页码分隔，那是给人看的，进提示词只是噪音。
     *
     * destroy() 放 finally：它释放 pdf.js 的 worker，漏一次就常驻一个。
     */
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: buf });
    try {
      const out = await parser.getText();
      raw = Array.isArray(out?.pages)
        ? out.pages.map((p) => p?.text ?? "").join("\n\n")
        : (out?.text ?? "");
    } finally {
      await parser.destroy().catch(() => {});
    }
  } else {
    raw = buf.toString("utf8");
  }

  const text = tidy(raw);
  if (!text) {
    // 扫描版 pdf（整本都是图）、空文档都会走到这儿。说清楚，别让用户
    // 以为是开关没生效
    throw new Error("这个文件里没读到文字（扫描版 PDF 或者空文档？）");
  }

  const truncated = text.length > maxChars;
  return { name, text: truncated ? text.slice(0, maxChars) : text, truncated };
}
