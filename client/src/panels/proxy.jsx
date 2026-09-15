/**
 * 出网代理那一节。
 *
 * 一个地址 + 一排勾选框：勾上的那几类走代理，没勾的直连。为什么不是一个总
 * 开关，见 server/src/proxy.js 的文件头（一句话：Photon 直连就通，套上代理
 * 反而连不上，而那种坏法用户很难联想到是代理造成的）。
 *
 * **这一节不走「保存配置」那个总按钮**，自己有一个「保存」。原因是
 * `PUT /api/config` 存完会把所有 iMessage 桥接重连一遍 —— 为了勾一个
 * 「天气走代理」把正在聊的号踢下线，代价太离谱。后端那三条路由
 * （`GET/PUT /api/proxy`、`POST /api/proxy/test`）就是为这事单开的。
 *
 * 界面上刻意不显示地址原文，只显示后端脱敏过的那份：机场和企业代理的串常是
 * `http://user:pass@host:port`，那就是一组凭据。输入框里是空的、placeholder
 * 显示当前生效的脱敏地址 —— 想改就整条重打，不提供「读回来编辑」。
 */

import { useCallback, useEffect, useState } from "react";
import { Check, Globe, RefreshCw, Save, X } from "lucide-react";

import { api } from "../store.jsx";
import { Button, Card, Field, ResultNote, Switch, inputCls } from "../ui.jsx";

/** 后端 proxy.js:PROXY_VARS 里那几个环境变量名，用来把 `from` 说成人话。 */
const FROM_LABELS = {
  控制台: "这个页面填的",
};

function fromNote(from) {
  if (!from) return "";
  if (FROM_LABELS[from]) return FROM_LABELS[from];
  // 环境变量那几种：把变量名原样给出来，用户才知道该去哪儿改
  return `环境变量 ${from}`;
}

export function ProxyPanel() {
  const [status, setStatus] = useState(null);
  const [url, setUrl] = useState("");
  const [scopes, setScopes] = useState({});
  const [dirty, setDirty] = useState(false);
  // 「清掉地址」按下之后的待存状态。单独一个标记而不是把 url 设成空串：
  // 空串本来就是「没改地址」的意思，两者必须分开，不然清不掉
  const [cleared, setCleared] = useState(false);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState(null); // { ok, text }

  const load = useCallback(async () => {
    try {
      const r = await api("/api/proxy");
      setStatus(r);
      setScopes(r?.scopes ?? {});
      setDirty(false);
    } catch (e) {
      setNote({ ok: false, text: String(e?.message ?? e) });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function toggle(key, on) {
    setScopes((s) => ({ ...s, [key]: on }));
    setDirty(true);
  }

  async function save() {
    if (busy) return;
    setBusy("save");
    setNote(null);
    try {
      /*
       * 输入框空着 = 不改地址，把脱敏之前的那个留着。
       *
       * 这里没法「原样回传当前地址」—— 前端手上只有脱敏版，回传等于把真地址
       * 改成 `http://gw:8080（带账号密码，已隐去）`。所以空着时压根不带 url
       * 字段，后端就照旧读它自己存的那个。
       */
      const body = { scopes };
      const typed = url.trim();
      if (typed || cleared) body.url = typed;
      const r = await api("/api/proxy", { method: "PUT", body });
      setStatus(r);
      setScopes(r?.scopes ?? {});
      setUrl("");
      setCleared(false);
      setDirty(false);
      setNote({
        ok: true,
        text: r?.enabled
          ? `存好了，当场生效（不用重启）。走代理的：${labelsOf(r).join("、") || "一类都没勾"}。`
          : "存好了，全部改回直连。",
      });
    } catch (e) {
      setNote({ ok: false, text: String(e?.message ?? e) });
    } finally {
      setBusy("");
    }
  }

  async function test() {
    if (busy) return;
    setBusy("test");
    setNote(null);
    try {
      const typed = url.trim();
      // 输入框里有字就测那个（存之前的试探），空着就测现在生效的
      const r = await api("/api/proxy/test", {
        method: "POST",
        body: typed ? { url: typed } : {},
      });
      setNote({ ok: Boolean(r?.ok), text: r?.detail ?? (r?.ok ? "通了" : "没通") });
    } catch (e) {
      setNote({ ok: false, text: String(e?.message ?? e) });
    } finally {
      setBusy("");
    }
  }

  async function testDirect() {
    if (busy) return;
    setBusy("direct");
    setNote(null);
    try {
      // 空串 = 测直连。用来分清「代理坏了」和「这台机器压根出不了网」
      const r = await api("/api/proxy/test", { method: "POST", body: { url: "" } });
      setNote({
        ok: Boolean(r?.ok),
        text: r?.ok
          ? `直连就能出网（${r.ms} 毫秒）—— 这台机器不一定需要代理。`
          : `直连出不了网：${r?.detail ?? "没通"}`,
      });
    } catch (e) {
      setNote({ ok: false, text: String(e?.message ?? e) });
    } finally {
      setBusy("");
    }
  }

  const catalog = status?.catalog ?? [];
  const on = catalog.filter((c) => scopes[c.key]).length;

  return (
    <Card
      title="代理"
      desc="给出网请求挂一个 HTTP 代理。一个地址，下面按用途分开勾 —— 因为有些接口国内直连就通，套上代理反而更慢、甚至连不上。"
      actions={
        <Button variant="outline" onClick={load} disabled={Boolean(busy)}>
          <RefreshCw size={14} />
          重新读取
        </Button>
      }
    >
      <div className="grid grid-cols-1 gap-6">
        <p className="max-w-[62ch] text-meta leading-relaxed text-ink-faint">
          现在的状态：
          {status?.enabled ? (
            <>
              <span className="text-ink-soft"> 已配 </span>
              <span className="font-mono text-ink-faint">{status.masked}</span>
              {status.from && <span className="text-ink-meta">（{fromNote(status.from)}）</span>}
              ，{on} 类走代理。
            </>
          ) : (
            <span className="text-ink-soft"> 没配，全部直连。</span>
          )}
        </p>

        <Field
          label="代理地址"
          hint="http:// 或 https://，不支持 socks5"
        >
          <input
            className={inputCls}
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setDirty(true);
              if (e.target.value.trim()) setCleared(false);
            }}
            placeholder={
              status?.enabled ? `现在是 ${status.masked}，要改就整条重打` : "http://127.0.0.1:7890"
            }
            spellCheck={false}
            autoComplete="off"
          />
        </Field>

        <p className="max-w-[62ch] text-meta leading-relaxed text-ink-faint">
          常见的填法：Clash 是 <span className="font-mono text-ink-soft">http://127.0.0.1:7890</span>
          ，v2rayN 是 <span className="font-mono text-ink-soft">http://127.0.0.1:10809</span>。
          机场给的 <span className="font-mono">socks5://</span> 这里用不了 —— 去客户端的设置里找
          「HTTP 端口」或「混合端口」，填那个。要账号密码的写成{" "}
          <span className="font-mono text-ink-soft">http://用户名:密码@地址:端口</span>。
        </p>

        {status?.enabled && !url.trim() && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setCleared(true);
                setDirty(true);
              }}
              disabled={cleared}
            >
              <X size={14} />
              {cleared ? "存了之后就全改回直连" : "清掉地址（全部改回直连）"}
            </Button>
            {cleared && (
              <Button variant="ghost" onClick={() => setCleared(false)}>
                算了，不清
              </Button>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 border-t border-line pt-6">
          <p className="text-eyebrow uppercase text-ink-faint">哪些走代理</p>
          <p className="max-w-[62ch] text-meta leading-relaxed text-ink-faint">
            出厂只勾了 Instagram 和天气 —— 那两类国内直连不通。其余默认不勾：
            <span className="text-ink-soft">模型 API 尤其别乱勾</span>
            ，国内的中转站直连本来就通，绕一趟代理只会更慢，还可能因为出口 IP
            对不上被服务商风控。
          </p>

          <div className="grid grid-cols-1 gap-0">
            {catalog.map((c) => (
              <label
                key={c.key}
                className="flex cursor-pointer items-start justify-between gap-6 border-b border-line py-3 last:border-b-0"
              >
                <span className="min-w-0">
                  <span className="block text-ui text-ink">{c.label}</span>
                  <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                    {c.hint}
                    {c.domains && (
                      <span className="text-ink-meta">
                        {" · "}
                        {c.domains}
                      </span>
                    )}
                  </span>
                </span>
                <span className="pt-1">
                  <Switch
                    checked={Boolean(scopes[c.key])}
                    onChange={(v) => toggle(c.key, v)}
                    label={`${c.label} 走代理`}
                  />
                </span>
              </label>
            ))}
          </div>
        </div>

        {note && (
          <ResultNote
            state={note.ok ? "ok" : "fail"}
            message={note.text}
            icon={note.ok ? Check : X}
          />
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={save} disabled={Boolean(busy) || !dirty}>
            <Save size={14} />
            {busy === "save" ? "保存中…" : "保存"}
          </Button>
          <Button variant="outline" onClick={test} disabled={Boolean(busy) || (!url.trim() && !status?.enabled)}>
            <Globe size={14} className={busy === "test" ? "animate-spin" : ""} />
            {busy === "test" ? "测试中…" : "测试连通"}
          </Button>
          <Button variant="ghost" onClick={testDirect} disabled={Boolean(busy)}>
            {busy === "direct" ? "测试中…" : "测一下直连"}
          </Button>
          <span className="text-meta text-ink-meta">这一节不走「保存配置」，存了当场生效</span>
        </div>

        <p className="max-w-[62ch] text-meta leading-relaxed text-ink-faint">
          「测试连通」打的是一个全球都有节点、而且直连也通得了的地址 —— 所以它失败
          就能断定问题在代理本身，不是「目标网站被墙」。地址存在{" "}
          <span className="text-ink-soft">data/data.config.json</span>
          （和 API 密钥同一份，因为它可能带账号密码），勾选存在{" "}
          <span className="text-ink-soft">data/config.json</span>。
          也可以不填这里，改用环境变量 <span className="font-mono">URANUS_PROXY</span> —— 这个
          页面填的优先。
        </p>
      </div>
    </Card>
  );
}

/** 走代理的那几类的名字，拼进保存成功那句话里。 */
function labelsOf(status) {
  return (status?.catalog ?? []).filter((c) => status?.scopes?.[c.key]).map((c) => c.label);
}
