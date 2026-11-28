import { speechUrl, TTS_FORMATS } from "../../shared/tts.mjs";
import { hasTtsAudio } from "./tts-audio.js";

const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const MIME = { mp3: "audio/mpeg", wav: "audio/wav", opus: "audio/ogg" };

async function readAudio(response, signal) {
  if (Number(response.headers.get("content-length")) > MAX_AUDIO_BYTES) {
    await response.body?.cancel();
    throw new Error("音频超过 20 MB 上限");
  }
  if (!response.body) throw new Error("上游返回了空音频");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_AUDIO_BYTES) throw new Error("音频超过 20 MB 上限");
      chunks.push(Buffer.from(value));
    }
    if (!size) throw new Error("上游返回了空音频");
    return Buffer.concat(chunks, size);
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** 单次合成，不重试计费请求。错误不包含上游原文、地址、密钥或待朗读文本。 */
export async function ttsOpenAi(config, text, voiceId, { timeout = 30000, signal: callerSignal } = {}) {
  const url = speechUrl(config.url);
  const format = config.format ?? "mp3";
  if (!TTS_FORMATS.includes(format)) throw new Error("不支持的音频格式");
  const voice = String(voiceId || config.voice || "").trim();
  if (!String(config.key ?? "").trim() || !String(config.model ?? "").trim() || !voice) {
    throw new Error("第三方 TTS 的密钥、模型和音色必须填全");
  }
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, AbortSignal.timeout(timeout)])
    : AbortSignal.timeout(timeout);
  const body = { model: config.model, input: text, voice, response_format: format };
  if (config.speed !== undefined && config.speed !== null && config.speed !== "") {
    const speed = Number(config.speed);
    if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) throw new Error("语速必须在 0.25 到 4 之间");
    body.speed = speed;
  }
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal,
    });
  } catch {
    throw new Error(signal.aborted ? "语音请求超时或已取消" : "无法连接 TTS 服务，请检查地址、网络和服务端重定向设置");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const hint = { 401: "密钥无效", 403: "无权使用此模型或渠道", 429: "请求过于频繁或额度不足" }[response.status] || "请检查渠道服务状态和参数";
    throw new Error(`TTS 返回 HTTP ${response.status}：${hint}`);
  }
  const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (type && !type.startsWith("audio/") && type !== "application/octet-stream" && type !== "application/ogg") {
    await response.body?.cancel().catch(() => {});
    throw new Error("上游没有返回音频，请确认这是 OpenAI 兼容的语音接口");
  }
  let buffer;
  try {
    buffer = await readAudio(response, signal);
  } catch (error) {
    if (signal.aborted) throw new Error("读取音频超时或已取消");
    if (["音频超过 20 MB 上限", "上游返回了空音频"].includes(error.message)) throw error;
    throw new Error("读取音频失败，请检查 TTS 服务连接");
  }
  if (!hasTtsAudio(buffer, format)) throw new Error(`上游返回的 ${format} 音频无效、为空或已截断，请检查渠道支持的格式`);
  return { buffer, mimeType: MIME[format], ext: format === "opus" ? "ogg" : format };
}
