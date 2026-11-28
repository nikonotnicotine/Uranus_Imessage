# 第三方 TTS 渠道

用户可以添加自己的 OpenAI 兼容语音服务，并用于角色的 iMessage 语音、线下朗读和通话。该能力属于原生前后端扩展，不是只在浏览器试听的插件；部署时需要一起更新后端并重新构建前端。

## 配置与使用

1. 在「连接 → 语音合成（TTS）→ TTS 渠道」点击「添加 TTS 渠道」。
2. 填名称、服务地址、API Key、模型和默认音色，再启用渠道。模型和音色按服务商文档填写，不限 OpenAI 官方名称。
3. 地址支持根域名、以 `/v1` 结尾的地址，或完整的 `/audio/speech` 端点。界面显示最终请求地址；自定义前缀请填完整端点。推荐 HTTPS，HTTP 会明文传输密钥和朗读文本。
4. 保存后选择试听渠道，点击「测试合成」。每次测试会真实调用服务，可能产生费用。
5. 选择全局默认，或在角色的语音设置中指定渠道。角色音色留空使用渠道默认值；角色渠道选择不依赖 iMessage「发语音」开关，线下和通话也会使用它。

新增渠道默认关闭。全局选择「自动（原有四家）」时保持 MiniMax → ElevenLabs → Fish Audio → GPT-SoVITS 的原有顺序，不会自动选中新添加的第三方渠道。角色空引用跟随全局。明确选择的渠道缺失、停用或配置不全时会报错，不会改用别家的声音或额度；删除渠道也不会偷偷清除已有引用。

## 支持范围

- POST JSON、Bearer 鉴权，字段为 `model`、`input`、`voice`、`response_format`，以及明确设置的 `speed`（0.25–4）。
- 直接返回二进制 mp3、wav 或 Ogg Opus；不支持 JSON 音频链接、SSE、Realtime、异步任务及其他专有协议。
- 有 ffmpeg 时复用现有 M4A 转码、时长与前导静音逻辑。无 ffmpeg 的原生语音条必须选择 `opus` 且上游实际返回 Ogg Opus，由现有逻辑封装为 CAF。
- 不自动探测端点或重试第三方计费请求；不跟随重定向。30 秒超时覆盖响应体读取，音频上限 20 MiB；拒绝空音频、JSON/HTML 及格式不符响应。

## 数据和接口

- `ttsApi.customChannels[]`：`id/name/enabled/url/key/model/voice/format/speed`。
- `ttsApi.defaultChannelId`、`voiceSend.channelId`：引用 `builtin:<type>` 或 `custom:<id>`。
- `shared/tts.mjs`：前后端共用的地址和选路规则。
- `server/src/tts-openai.js`：单次 HTTP 请求、响应读取和格式检查。
- `media.js:synthesizeVoice`：文本清理和现有音频处理；iMessage、线下、通话传入角色引用。
- `/api/tts/test`：接收渠道 ID、音色覆盖和文本，仅从已保存配置读取地址与密钥。

整块 `ttsApi` 沿用 `ttsKeys` 密钥文件存储，不进入普通配置或无密钥配置备份；角色文件只保存渠道引用和音色等偏好。完整数据备份以及显式含密钥备份仍然包含秘密，应妥善保管。现有已登录管理接口可以读取密钥，已启用的同源前端插件也不构成秘密隔离边界；本改动不重新设计这些权限。

## 验证与边界

离线测试：`node scripts/test-tts-custom.mjs`，使用临时数据目录和模拟服务，不使用真实密钥。媒体和通话回归分别为 `scripts/test-media.mjs`、`scripts/test-callhear.mjs`，全量运行 `npm test`。

功能均已实现；以下区分已有证据和仍待验证的环节。`backfilled` 保留继承行为此前缺少专项证据的历史，不代表真实服务已验收。

| ID | 用户结果 / 依据 | 运行证据与边界 | 覆盖 / 历史 |
|---|---|---|---|
| TTS-01 | 配置渠道；复用原有保存流程 | 沙箱添加、编辑、保存和停用拒绝；浏览器确认删除取消/确认、保留失效引用并清除旧试听 | covered / none |
| TTS-02 | 全局与角色选路；保留旧默认、显式失败不换源 | 选路断言、线下实际模拟请求和通话选路断言；真实 iMessage/通话未联调 | partial / backfilled |
| TTS-03 | 自定义模型与音色；官方 speech 和原有音频契约 | 本机 HTTP、M4A、浏览器播放及真实 Ogg Opus→CAF 样本；用户中转站未验证 | partial / none |
| TTS-04 | 凭据保存与备份；复用 secret split | 保存重载、角色文件、无密钥备份、含密钥恢复和保留本机密钥的恢复断言 | covered / backfilled |
| TTS-05 | 失败有界、避免重复计费；保留原有文字回退 | HTTP/响应体/超时/大小/重定向/不重试断言；完全无 ffmpeg 宿主及真实投递失败未端到端模拟 | partial / backfilled |
| TTS-06 | 保存后试听和移动操作；复用 audio 播放 | 浏览器保存门禁、试听、角色覆盖和 390px 表单布局；延迟响应验证请求锁定、改音色后旧结果不显示 | covered / backfilled |

2026-11-28 在上游 `3092e03`（v1.23.5）基线上验证：TTS 11 组、媒体 268 项、通话听音 97 项、构建新鲜度测试及生产构建通过；全量 35/36 个文件通过。Instagram 的 11 个失败在未修改的同一上游提交也复现（521 通过、11 失败）。构建仍有大于 500 kB 的分块警告。本轮还验证同名第三方渠道不会获得内置 SSML/口音行为，以及共享模块变化能触发前端重建。模拟服务成功不代表真实中转站、iMessage 投递或通话已验证。

## 实现方式的依据

核对的[官方插件指南](https://github.com/nikonotnicotine/uranus-plugins/blob/12e7b032124d223f779e47159c532c6e981a81f3/WRITING-PLUGINS.md)和[宿主加载器](https://github.com/nikonotnicotine/Uranus_Imessage/blob/3092e03a11bd2f354d640d9ea4eda76e010ca813/server/src/plugins.js)仅支持前端入口，没有后端 TTS 提供商注册机制，因此采用原生扩展。请求协议参照 [OpenAI speech 接口](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create)，但不限制用户的模型和音色名称。
