import { listTtsChannels, speechUrl, TTS_FORMATS } from "../../../shared/tts.mjs";
import { Button, Field, Switch, inputCls } from "../ui.jsx";

export function TtsChannelSelect({ tts, value, onChange, label, emptyLabel }) {
  const channels = listTtsChannels(tts);
  const missing = value && !channels.some((channel) => channel.id === value);
  return (
    <Field label={label}>
      <select className={inputCls} value={value || ""} onChange={(event) => onChange(event.target.value)}>
        <option value="">{emptyLabel}</option>
        {missing && <option value={value}>渠道不存在，请重新选择</option>}
        {channels.map((channel) => (
          <option key={channel.id} value={channel.id}>
            {channel.name}{channel.reason ? `（${channel.reason}）` : ""}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function CustomTtsChannels({ tts, roles = [], updateTtsApi }) {
  const channels = tts.customChannels ?? [];
  const update = (id, patch) => updateTtsApi({ customChannels: channels.map((item) => item.id === id ? { ...item, ...patch } : item) });
  function add() {
    updateTtsApi({ customChannels: [...channels, {
      id: `tts-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, name: "第三方 TTS", enabled: false,
      url: "", key: "", model: "", voice: "", format: "mp3", speed: null,
    }] });
  }
  function remove(channel) {
    const ref = `custom:${channel.id}`;
    const count = roles.filter((role) => role.voiceSend?.channelId === ref).length;
    const use = [tts.defaultChannelId === ref ? "全局默认" : "", count ? `${count} 个角色` : ""].filter(Boolean).join("、");
    if (!window.confirm(`删除「${channel.name || "第三方 TTS"}」？${use ? `目前被${use}使用。删除后这些选择会显示失效，不会自动换到别家。` : "保存后生效。"}`)) return;
    updateTtsApi({ customChannels: channels.filter((item) => item.id !== channel.id) });
  }
  return (
    <section className="grid min-w-0 grid-cols-1 gap-5 border-t border-line pt-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-ui text-ink">第三方 TTS（OpenAI 兼容）</h3>
          <p className="mt-1 text-meta text-ink-faint">添加自己的中转站，保存后选择为全局默认或指定给角色。新增渠道默认关闭。</p>
        </div>
        <Button variant="outline" onClick={add}>添加 TTS 渠道</Button>
      </div>
      {!channels.length && <p className="text-meta text-ink-faint">还没有第三方渠道；原有服务不受影响。</p>}
      {channels.map((channel) => {
        let endpoint = "";
        let problem = "";
        if (channel.url) {
          try { endpoint = speechUrl(channel.url); } catch (error) { problem = error.message; }
        }
        return (
          <div key={channel.id} className="grid min-w-0 grid-cols-1 gap-4 rounded-lg border border-line p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Switch label={`启用 ${channel.name || "第三方 TTS"}`} checked={Boolean(channel.enabled)} onChange={(enabled) => update(channel.id, { enabled })} />
              <Button variant="outline" onClick={() => remove(channel)}>删除渠道</Button>
            </div>
            <Field label="渠道名称"><input className={inputCls} value={channel.name} onChange={(e) => update(channel.id, { name: e.target.value })} /></Field>
            <Field label="服务地址" hint="支持根地址、以 /v1 结尾的 Base URL，或完整 /audio/speech 地址。自定义前缀请填完整端点。">
              <input className={inputCls} value={channel.url} placeholder="https://your-relay.example/v1" onChange={(e) => update(channel.id, { url: e.target.value })} />
              {endpoint && <p className="mt-2 break-all text-meta text-ink-faint">实际请求：{endpoint}</p>}
              {problem && <p className="mt-2 text-meta text-warn">{problem}</p>}
              {endpoint.startsWith("http:") && <p className="mt-2 text-meta text-warn">HTTP 会明文传输密钥和文本，仅用于可信本机/内网；公网请用 HTTPS。</p>}
            </Field>
            <Field label="API Key" hint="只保存在本机密钥配置，不进无密钥配置备份。含密钥备份和完整数据备份应妥善保管。">
              <input type="password" autoComplete="off" className={inputCls} value={channel.key} onChange={(e) => update(channel.id, { key: e.target.value })} />
            </Field>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label="模型名称" hint="填写你的渠道支持的模型，不限官方名称。"><input className={inputCls} value={channel.model} placeholder="渠道提供的 TTS 模型 ID" onChange={(e) => update(channel.id, { model: e.target.value })} /></Field>
              <Field label="默认音色" hint="角色音色留空时使用这里的值。"><input className={inputCls} value={channel.voice} placeholder="渠道提供的 voice，如 alloy" onChange={(e) => update(channel.id, { voice: e.target.value })} /></Field>
              <Field label="音频格式" hint="无 ffmpeg 时发送语音条需要 opus，上游必须返回 Ogg Opus。">
                <select className={inputCls} value={channel.format || "mp3"} onChange={(e) => update(channel.id, { format: e.target.value })}>{TTS_FORMATS.map((format) => <option key={format} value={format}>{format}</option>)}</select>
              </Field>
              <Field label="语速（可留空）" hint="0.25–4，1 为原速；留空不发送 speed，使用渠道默认。"><input type="number" min="0.25" max="4" step="0.05" className={inputCls} value={channel.speed ?? ""} onChange={(e) => update(channel.id, { speed: e.target.value })} /></Field>
            </div>
          </div>
        );
      })}
    </section>
  );
}
