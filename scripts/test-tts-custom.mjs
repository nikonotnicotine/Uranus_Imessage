/** 第三方 TTS 离线回归：不使用真实密钥，不访问付费接口。 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { speechUrl, listTtsChannels, resolveTtsChannel } from "../shared/tts.mjs";
import { ttsOpenAi } from "../server/src/tts-openai.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "uranus-tts-custom-"));
process.env.URANUS_DATA_DIR = TMP;
process.env.IMESSAGE_BRIDGE = "off";
const realFetch = globalThis.fetch;
const channel = { id: "relay", name: "我的中转", enabled: true, url: "https://relay.example/v1", key: "TEST-KEY-ONLY", model: "custom-tts", voice: "my-voice", format: "wav", speed: null };
let checks = 0;
function ok(name) { checks += 1; console.log(`  ✓ ${name}`); }
function wav() {
  const buffer = Buffer.alloc(44 + 1600);
  buffer.write("RIFF"); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(1600, 40);
  return buffer;
}
const audio = wav();
let mockServer;
try {
  for (const [input, expected] of [
    ["https://relay.example", "https://relay.example/v1/audio/speech"],
    ["https://relay.example/v1/", "https://relay.example/v1/audio/speech"],
    ["https://relay.example/proxy/v1", "https://relay.example/proxy/v1/audio/speech"],
    ["http://127.0.0.1:9999/custom/audio/speech/", "http://127.0.0.1:9999/custom/audio/speech"],
  ]) assert.equal(speechUrl(input), expected);
  for (const input of ["not a url", "file:///tmp/a", "https://u:p@relay.example", "https://relay.example?key=x", "https://relay.example#x", "https://relay.example/custom"]) assert.throws(() => speechUrl(input));
  ok("端点拼接和危险/歧义地址校验");

  const api = { minimax: { enabled: true, key: "old" }, customChannels: [channel] };
  assert.equal(resolveTtsChannel(api).channel.type, "minimax");
  assert.equal(resolveTtsChannel({ ...api, defaultChannelId: "custom:relay" }).channel.type, "openai");
  assert.equal(resolveTtsChannel({ ...api, defaultChannelId: "custom:relay" }, { channelId: "builtin:minimax" }).channel.type, "minimax");
  for (const changed of [[], [{ ...channel, enabled: false }], [{ ...channel, key: "" }]]) {
    const result = resolveTtsChannel({ ...api, customChannels: changed, defaultChannelId: "custom:relay" });
    assert.equal(result.channel, null); assert.ok(result.error);
  }
  assert.equal(resolveTtsChannel({ ...api, defaultChannelId: "custom:relay" }, { needOpus: true }).channel, null);
  assert.equal(resolveTtsChannel({ customChannels: [{ ...channel, format: "opus" }], defaultChannelId: "custom:relay" }, { needOpus: true }).channel.opus, true);
  assert.equal(listTtsChannels(api).length, 5);
  ok("默认保旧、全局/角色覆盖、失效不换源、Opus能力判断");

  let requests = 0;
  globalThis.fetch = async (url, init) => {
    requests += 1;
    assert.equal(url, "https://relay.example/v1/audio/speech");
    assert.equal(init.method, "POST"); assert.equal(init.redirect, "error");
    assert.equal(init.headers.Authorization, "Bearer TEST-KEY-ONLY");
    assert.deepEqual(JSON.parse(init.body), { model: "custom-tts", input: "测试文本", voice: "override", response_format: "wav" });
    return new Response(audio, { headers: { "content-type": "application/octet-stream" } });
  };
  const result = await ttsOpenAi(channel, "测试文本", "override");
  assert.deepEqual(result.buffer, audio); assert.equal(result.mimeType, "audio/wav"); assert.equal(requests, 1);
  ok("自定义模型和角色音色、Bearer请求、二进制音频响应");

  for (const status of [401, 403, 429, 500, 502]) {
    requests = 0;
    globalThis.fetch = async () => { requests += 1; return new Response("SECRET-KEY and private text", { status }); };
    await assert.rejects(() => ttsOpenAi(channel, "private text", ""), (error) => error.message.includes(String(status)) && !error.message.includes("SECRET") && !error.message.includes("private"));
    assert.equal(requests, 1);
  }
  ok("HTTP错误安全提示、不回显上游秘密、不自动重试");

  for (const [body, headers] of [
    [JSON.stringify({ error: "bad" }), { "content-type": "application/json" }],
    ["<html>error</html>", { "content-type": "text/html" }],
    ["{\"error\":\"fake audio\"}", { "content-type": "audio/wav" }],
    [new Uint8Array(), { "content-type": "audio/wav" }],
    [audio, { "content-length": String(21 * 1024 * 1024) }],
  ]) {
    globalThis.fetch = async () => new Response(body, { headers });
    await assert.rejects(() => ttsOpenAi(channel, "x", ""));
  }
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(21 * 1024 * 1024)); controller.close(); } }));
  await assert.rejects(() => ttsOpenAi(channel, "x", ""), /20 MB/);
  ok("空音频、伪成功、格式不符、超大响应均拒绝");

  globalThis.fetch = async () => new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "audio/wav" } });
  // AbortSignal.timeout 的计时器不维持 Node 进程；这条测试保留一个短暂句柄。
  const alive = setInterval(() => {}, 100);
  try { await assert.rejects(() => ttsOpenAi(channel, "x", "", { timeout: 20 }), /超时/); }
  finally { clearInterval(alive); }
  globalThis.fetch = realFetch;
  ok("超时覆盖响应体读取，不只覆盖响应头");

  let captured;
  mockServer = http.createServer((req, res) => {
    if (req.url === "/redirect/audio/speech") { res.writeHead(302, { Location: "/v1/audio/speech" }); res.end(); return; }
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => { captured = JSON.parse(body); res.writeHead(200, { "content-type": "audio/wav" }); res.end(audio); });
  });
  await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
  const root = `http://127.0.0.1:${mockServer.address().port}`;
  await ttsOpenAi({ ...channel, url: root, speed: 1.2 }, "local", "");
  assert.equal(captured.voice, channel.voice); assert.equal(captured.speed, 1.2);
  await assert.rejects(() => ttsOpenAi({ ...channel, url: `${root}/redirect/audio/speech` }, "x", ""), /重定向/);
  ok("真实本机HTTP请求成功，重定向拒绝");

  const { normalizeConfig, saveConfig, loadConfig } = await import("../server/src/config.js");
  const { buildBundle, applyBundle } = await import("../server/src/backup.js");
  const { CONFIG_PATH, SECRET_PATH, CHARACTERS_DIR } = await import("../server/src/datadir.js");
  const { pickTtsSource, synthesizeVoice } = await import("../server/src/media.js");
  const { callVoice } = await import("../server/src/callturn.js");
  const { ffmpegPath } = await import("../server/src/ffmpeg.js");
  const { spawnSync } = await import("node:child_process");
  const { oggOpusToCaf } = await import("../server/src/caf.js");
  const ffmpeg = await ffmpegPath();
  if (ffmpeg) {
    const encoded = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "wav", "-i", "pipe:0", "-c:a", "libopus", "-f", "ogg", "pipe:1"], { input: audio });
    assert.equal(encoded.status, 0);
    globalThis.fetch = async () => new Response(encoded.stdout, { headers: { "content-type": "audio/ogg" } });
    const opus = await ttsOpenAi({ ...channel, format: "opus" }, "x", "");
    const caf = oggOpusToCaf(opus.buffer, { padMs: 600 });
    assert.ok(caf?.buffer.length); assert.ok(caf.duration > 0);
    globalThis.fetch = realFetch;
    ok("真实 Ogg Opus 响应可由已有逻辑封装 CAF 语音条");
  }
  const config = normalizeConfig({ ttsApi: { ...api, defaultChannelId: "custom:relay" }, roles: [{ id: "r-tts", name: "测试角色", voiceSend: { enabled: true, channelId: "custom:relay", voiceId: "role-voice", key: "MUST-DROP" } }] });
  assert.equal(config.roles[0].voiceSend.channelId, "custom:relay");
  assert.equal(config.roles[0].voiceSend.key, undefined);
  assert.equal(normalizeConfig({}).ttsApi.customChannels.length, 0);
  const duplicates = normalizeConfig({ ttsApi: { customChannels: [channel, channel] } }).ttsApi.customChannels;
  assert.notEqual(duplicates[0].id, duplicates[1].id);
  saveConfig(config);
  const reloaded = loadConfig();
  assert.deepEqual(reloaded.ttsApi.customChannels, config.ttsApi.customChannels);
  const main = fs.readFileSync(CONFIG_PATH, "utf8");
  const secret = fs.readFileSync(SECRET_PATH, "utf8");
  assert.ok(!main.includes(channel.key) && !main.includes(channel.url));
  assert.ok(secret.includes(channel.key));
  for (const file of fs.readdirSync(CHARACTERS_DIR).filter((name) => name.endsWith(".json"))) {
    const stored = fs.readFileSync(path.join(CHARACTERS_DIR, file), "utf8");
    assert.ok(!stored.includes(channel.key) && !stored.includes(channel.url));
  }
  const publicBundle = JSON.stringify(buildBundle(config));
  assert.ok(!publicBundle.includes(channel.key) && !publicBundle.includes(channel.url));
  assert.equal(buildBundle(config, { includeSecrets: true }).secrets.ttsKeys.customChannels[0].key, channel.key);
  assert.deepEqual(normalizeConfig(applyBundle(buildBundle(config, { includeSecrets: true }), normalizeConfig({}))).ttsApi, config.ttsApi);
  assert.deepEqual(normalizeConfig(applyBundle(buildBundle(config), config)).ttsApi, config.ttsApi);
  assert.equal(callVoice(config, config.roles[0]).channelId, "custom:relay");
  assert.equal(callVoice(config, config.roles[0]).keepTone, false);
  ok("配置往返、稳定引用、密钥隔离、无密钥备份、通话选路");

  requests = 0;
  globalThis.fetch = async (_url, init) => {
    requests += 1;
    assert.equal(JSON.parse(init.body).voice, "role-voice");
    return new Response(audio, { headers: { "content-type": "audio/wav" } });
  };
  const out = await synthesizeVoice(config.ttsApi, "role-voice", "你好", "测试", { channelId: "custom:relay" });
  assert.equal(out.source, channel.name); assert.ok(out.buffer.length); assert.equal(requests, 1);
  assert.equal(pickTtsSource(config.ttsApi).retry, false);
  globalThis.fetch = async () => { requests += 1; throw new TypeError("TEST-KEY-ONLY"); };
  requests = 0;
  await assert.rejects(() => synthesizeVoice(config.ttsApi, "", "private", "测试"), (error) => !error.message.includes(channel.key));
  assert.equal(requests, 1);
  ok("原生合成入口和转码复用，新渠道网络失败不重复计费");
  console.log(`\n第三方 TTS 全部通过：${checks} 组`);
} finally {
  globalThis.fetch = realFetch;
  if (mockServer) await new Promise((resolve) => { mockServer.closeAllConnections(); mockServer.close(resolve); });
  fs.rmSync(TMP, { recursive: true, force: true });
}
