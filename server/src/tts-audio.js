/** 第三方响应的最低结构校验，不替代解码器；拒绝只有文件头或明显截断的音频。 */
export function hasTtsAudio(buffer, format) {
  try {
    if (format === "wav") return hasWaveData(buffer);
    if (format === "opus") return hasOpusPackets(buffer);
    if (format === "mp3") return hasMp3Frames(buffer);
    return false;
  } catch {
    return false; // 包括损坏长度导致的越界读取
  }
}

// RIFF/WAVE：遍历块而非假定固定 44 字节头；未知块和 WORD 对齐的填充均可跳过。
// https://learn.microsoft.com/en-us/windows/win32/xaudio2/resource-interchange-file-format--riff-
function hasWaveData(buf) {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return false;
  const declared = buf.readUInt32LE(4);
  // 管道编码器不能回填长度，常用 0xffffffff 表示直到响应结尾。
  const end = declared === 0xffffffff ? buf.length : declared + 8;
  if (end > buf.length || end < 12) return false;
  let block = 0;
  let dataSize = 0;
  let offset = 12;
  while (offset < end) {
    if (offset + 8 > end) return false;
    const tag = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const start = offset + 8;
    const toEnd = tag === "data" && size === 0xffffffff;
    const length = toEnd ? end - start : size;
    if (start + length > end) return false;
    if (tag === "fmt ") {
      if (length < 16 || !buf.readUInt16LE(start) || !buf.readUInt16LE(start + 2) || !buf.readUInt32LE(start + 4)) return false;
      block = buf.readUInt16LE(start + 12);
      if (!block) return false;
    }
    if (tag === "data") dataSize += length;
    // 未知长度的 data 已读至 EOF，不再额外要求一个对齐字节。
    offset = toEnd ? end : start + length + (length & 1);
  }
  return offset === end && block > 0 && dataSize >= block;
}

// Layer III 帧长按 MPEG 版本、码率和采样率计算；ID3 元数据本身不是音频。
function hasMp3Frames(buf) {
  let offset = 0;
  let frames = 0;
  while (offset < buf.length) {
    if (buf.toString("ascii", offset, offset + 3) === "ID3") {
      if (offset + 10 > buf.length) return false;
      const version = buf[offset + 3];
      const sizeBytes = buf.subarray(offset + 6, offset + 10);
      if (![2, 3, 4].includes(version) || sizeBytes.some((n) => n & 0x80)) return false;
      const size = sizeBytes.reduce((n, b) => n * 128 + b, 0);
      offset += 10 + size + (version === 4 && (buf[offset + 5] & 0x10) ? 10 : 0);
      if (offset > buf.length) return false;
      continue;
    }
    if (frames && buf.length - offset === 128 && buf.toString("ascii", offset, offset + 3) === "TAG") return true;
    if (frames && buf[offset] === 0 && buf.subarray(offset).every((n) => n === 0)) return true;
    if (offset + 4 > buf.length || buf[offset] !== 0xff || (buf[offset + 1] & 0xe0) !== 0xe0) return false;
    const version = (buf[offset + 1] >> 3) & 3;
    const layer = (buf[offset + 1] >> 1) & 3;
    const bitrateIndex = buf[offset + 2] >> 4;
    const rateIndex = (buf[offset + 2] >> 2) & 3;
    if (version === 1 || layer !== 1 || !bitrateIndex || bitrateIndex === 15 || rateIndex === 3) return false;
    const rates = version === 3
      ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
      : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    const sampleRate = [44100, 48000, 32000][rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const length = Math.floor((version === 3 ? 144000 : 72000) * rates[bitrateIndex] / sampleRate) + ((buf[offset + 2] >> 1) & 1);
    if (offset + length > buf.length) return false;
    frames += 1;
    offset += length;
  }
  return frames > 0;
}

// Ogg Opus：完整页和分段表、两个头包之后至少一个完整的非空音频包。
// 不要求 EOS 标记，但不接受最后一页或最后一个包被截断的响应。
// RFC 7845 §3/§5；必须有音频包是此处的 TTS 策略，不是完整编解码正确性证明。
function hasOpusPackets(buf) {
  let offset = 0;
  let serial;
  let sequence;
  let pending = [];
  let packetIndex = 0;
  let preSkip = 0;
  let granule = 0n;
  while (offset < buf.length) {
    if (offset + 27 > buf.length || buf.toString("ascii", offset, offset + 4) !== "OggS" || buf[offset + 4] !== 0) return false;
    const flags = buf[offset + 5];
    const pageSerial = buf.readUInt32LE(offset + 14);
    const pageSequence = buf.readUInt32LE(offset + 18);
    if (serial === undefined) {
      if (!(flags & 2)) return false;
      serial = pageSerial;
    } else if (serial !== pageSerial || pageSequence !== ((sequence + 1) >>> 0)) return false;
    if (Boolean(flags & 1) !== Boolean(pending.length)) return false;
    sequence = pageSequence;
    const count = buf[offset + 26];
    const start = offset + 27;
    let body = start + count;
    if (body > buf.length) return false;
    for (let i = 0; i < count; i += 1) {
      const size = buf[start + i];
      if (body + size > buf.length) return false;
      pending.push(buf.subarray(body, body + size));
      body += size;
      if (size === 255) continue;
      const packet = pending.length === 1 ? pending[0] : Buffer.concat(pending);
      pending = [];
      if (packetIndex === 0) {
        if (packet.length < 19 || packet.toString("ascii", 0, 8) !== "OpusHead" || packet[8] >= 16 || !packet[9]) return false;
        if (packet[18] === 0 ? packet[9] > 2 : packet.length < 21 + packet[9]) return false;
        preSkip = packet.readUInt16LE(10);
      } else if (packetIndex === 1) {
        if (packet.length < 16 || packet.toString("ascii", 0, 8) !== "OpusTags") return false;
        let pos = 12 + packet.readUInt32LE(8);
        if (pos + 4 > packet.length) return false;
        const comments = packet.readUInt32LE(pos);
        pos += 4;
        for (let j = 0; j < comments; j += 1) {
          if (pos + 4 > packet.length) return false;
          pos += 4 + packet.readUInt32LE(pos);
          if (pos > packet.length) return false;
        }
      } else if (!packet.length) return false;
      packetIndex += 1;
    }
    const pageGranule = buf.readBigInt64LE(offset + 6);
    if (pageGranule >= 0n) granule = pageGranule;
    offset = body;
  }
  return pending.length === 0 && packetIndex > 2 && granule > BigInt(preSkip);
}
