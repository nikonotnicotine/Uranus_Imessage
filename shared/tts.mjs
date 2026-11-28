/** 前后端共用的 TTS 选路。这里只读配置，不请求上游，也不处理音频。 */
const text = (value) => String(value ?? "").trim();

export const TTS_FORMATS = ["mp3", "wav", "opus"];

/** 只补已知的 OpenAI 路径；自定义前缀请填写完整 speech 端点。 */
export function speechUrl(value) {
  let url;
  try {
    url = new URL(text(value));
  } catch {
    throw new Error("请填写有效的 TTS 服务地址");
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("TTS 地址只支持 HTTP(S)，不能包含用户名、密码、查询参数或锚点");
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  if (!pathname) url.pathname = "/v1/audio/speech";
  else if (pathname.endsWith("/v1")) url.pathname = `${pathname}/audio/speech`;
  else if (pathname.endsWith("/audio/speech")) url.pathname = pathname;
  else throw new Error("自定义路径请填写完整的 /audio/speech 地址");
  return url.href;
}

export function elevenTagsOk(model) {
  const match = /(?:^|[^a-z0-9])v(\d+)/i.exec(text(model));
  return Boolean(match) && Number(match[1]) >= 3;
}

function customProblem(config) {
  try {
    speechUrl(config.url);
  } catch (error) {
    return error.message;
  }
  if (!text(config.key)) return "请填写 API Key";
  if (!text(config.model)) return "请填写模型名称";
  if (!text(config.voice)) return "请填写默认音色";
  if (!TTS_FORMATS.includes(config.format ?? "mp3")) return "不支持的音频格式";
  return "";
}

export function listTtsChannels(api = {}) {
  const builtins = [
    ["minimax", "MiniMax", false, false],
    ["elevenlabs", "ElevenLabs", true, elevenTagsOk(api?.elevenlabs?.model)],
    ["fish", "Fish Audio", true, !/^s1\b/i.test(text(api?.fish?.model))],
    ["sovits", "GPT-SoVITS", false, false],
  ].map(([type, name, opus, keepTags]) => {
    const config = api?.[type] ?? {};
    const reason = !config.enabled ? "渠道未启用"
      : !text(type === "sovits" ? config.url : config.key) ? "凭据未填全" : "";
    return { id: `builtin:${type}`, type, name, config, opus, keepTags, reason };
  });
  const custom = (Array.isArray(api?.customChannels) ? api.customChannels : []).map((config) => ({
    id: `custom:${config.id}`,
    type: "openai",
    name: text(config.name) || "第三方 TTS",
    config,
    opus: config.format === "opus",
    keepTags: false,
    reason: config.enabled ? customProblem(config) : "渠道未启用",
  }));
  return [...builtins, ...custom];
}

/** 显式选择失败绝不回落到别家；旧配置只按原来的四家顺序自动挑选。 */
export function resolveTtsChannel(api, { channelId = "", needOpus = false } = {}) {
  const channels = listTtsChannels(api);
  const selected = text(channelId) || text(api?.defaultChannelId);
  if (selected) {
    const channel = channels.find((item) => item.id === selected);
    if (!channel) return { channel: null, error: "所选 TTS 渠道不存在，请重新选择" };
    if (channel.reason) return { channel: null, error: `${channel.name}：${channel.reason}` };
    if (needOpus && !channel.opus) {
      return { channel: null, error: `${channel.name}：当前环境没有 ffmpeg，发语音条需要 Ogg Opus；请将渠道格式设为 opus（上游需支持）或安装 ffmpeg` };
    }
    return { channel, error: "" };
  }
  const channel = channels.find((item) => item.type !== "openai" && !item.reason && (!needOpus || item.opus));
  return {
    channel: channel ?? null,
    error: channel ? "" : needOpus
      ? "当前环境没有 ffmpeg，发语音条需要支持 Ogg Opus 的 TTS 渠道"
      : "没有可用的语音合成服务，请在「连接 → 语音合成」中配置并选择渠道",
  };
}
