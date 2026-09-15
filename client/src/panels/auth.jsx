/**
 * 登录门。整个控制台被它包着 —— 没登录就只画这一页。
 *
 * 三个状态，各一屏：
 *
 *  1. `login`   ——  账号 + 密码
 *  2. `change`  ——  强制改账号密码（拿默认密码登进来之后，或者后端回了 mustChange）
 *  3. `ready`   ——  放行，画真正的界面
 *
 * 为什么不用弹窗：这不是「界面上的一个动作」，是「有没有资格看到这个界面」。
 * 弹窗背后那一层会把全部 API 密钥、手机号、聊天记录都渲染出来 —— 哪怕只是
 * 半透明地露一下，也已经泄了。所以这里是**换页**，登录之前外壳压根不挂载。
 *
 * 「等一下再说」这种出口一个都不给：VPS 上开着全端口的那台机器，跳过登录
 * 等于门开着。用户忘了密码的出路在 data/auth.json 里（见 auth.js 文件头），
 * 不在界面上。
 */

import { useCallback, useEffect, useState } from "react";
import { KeyRound, LogIn, ShieldCheck } from "lucide-react";

import { watchSession } from "../store.jsx";
import { Button, Field, ResultNote, UranusBadge, inputCls } from "../ui.jsx";

/** 和后端 auth.js 的 MIN_PASSWORD 对齐。后端那道才是真的，这道只为当场给提示。 */
const MIN_PASSWORD = 8;

/**
 * 密码合不合规。**和后端 checkPassword 一字不差** —— 两边各判一遍：
 * 这边是为了在用户还在打字的时候就说清楚差什么，那边才是真正的闸。
 *
 * 规则只有两条（不少于 8 位、至少一个大写），别往上加。
 */
function checkPassword(s) {
  const v = String(s ?? "");
  if (!v) return "密码不能是空的。";
  if (v.length < MIN_PASSWORD) return `密码至少要 ${MIN_PASSWORD} 位，现在只有 ${v.length} 位。`;
  if (!/[A-Z]/.test(v)) return "密码里至少要有一个大写字母（A-Z）。";
  if (v !== v.trim()) return "密码的开头或结尾有空格，去掉再试。";
  return "";
}

/** 一行不带 Content-Type 之外的东西的 POST。这个文件不用 store 里的 api()：
 *  那个撞上 401 会去叫 watchSession 的回调，而这里本来就是在处理没登录。 */
async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* 非 JSON（反代挂了之类），下面按状态码说话 */
  }
  if (!res.ok) throw new Error(data?.error || `请求失败 (${res.status})`);
  return data ?? {};
}

/**
 * 登录门。
 *
 * @param {{children: React.ReactNode}} props children 是整个控制台
 */
export function AuthGate({ children }) {
  // probing 是第一帧的状态：还不知道要不要登录，什么都不画。
  // 直接画登录页的话，已经登录的用户每次刷新都会看到它闪一下
  const [stage, setStage] = useState("probing"); // probing | login | change | ready
  const [username, setUsername] = useState("");

  const probe = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/state");
      const data = await res.json();
      setUsername(data?.username ?? "");
      if (!data?.loggedIn) return setStage("login");
      setStage(data?.mustChange ? "change" : "ready");
    } catch {
      // 后端还没起来 / 拉不到。当没登录处理 —— 登录页上那句「后端没起来」
      // 比一个空白页有用
      setStage("login");
    }
  }, []);

  useEffect(() => {
    probe();
  }, [probe]);

  /*
   * 任何一次 api() 撞上 401（或 403 + mustChange）都会走到这儿。
   *
   * 会话是 30 天的，所以这条路平时不常走；真走到了多半是用户在另一台设备上
   * 改了密码，或者手动清了 auth.json。把界面切回门口比让各个面板各自报
   * 「请求失败 (401)」清楚得多。
   */
  useEffect(() => watchSession((kind) => setStage(kind === "change" ? "change" : "login")), []);

  if (stage === "probing") return null;
  if (stage === "ready") return children;

  return (
    <div className="flex h-screen items-center justify-center overflow-y-auto px-6 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <UranusBadge size={36} />
          <div className="min-w-0">
            <p className="font-serif text-h2 text-ink">Uranus iMessage</p>
            <p className="mt-0.5 text-meta text-ink-faint">
              {stage === "login" ? "先登录" : "设一组自己的账号密码"}
            </p>
          </div>
        </div>

        {stage === "login" ? (
          <LoginForm
            onDone={(mustChange) => setStage(mustChange ? "change" : "ready")}
            onName={setUsername}
          />
        ) : (
          <ChangeForm
            username={username}
            onDone={(name) => {
              setUsername(name);
              setStage("ready");
            }}
          />
        )}
      </div>
    </div>
  );
}

/** 账号 + 密码。 */
function LoginForm({ onDone, onName }) {
  const [name, setName] = useState("");
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // 还没改过默认密码的机器上提示一句「用 Uranus / Uranus」——
  // 新用户不知道填什么，而这句话在默认密码已经改掉之后就不该再出现
  const [fresh, setFresh] = useState(false);

  useEffect(() => {
    fetch("/api/auth/state")
      .then((r) => r.json())
      .then((d) => setFresh(Boolean(d?.mustChange)))
      .catch(() => {});
  }, []);

  async function submit(e) {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const out = await post("/api/auth/login", { username: name, password: pass });
      onName?.(out?.username ?? name);
      onDone(Boolean(out?.mustChange));
    } catch (err) {
      setError(String(err?.message ?? err));
      setBusy(false);
    }
  }

  return (
    // form 而不是一堆 div：回车提交是免费拿到的，而这一页最常见的操作就是打完密码按回车
    <form onSubmit={submit} className="grid grid-cols-1 gap-6">
      <Field label="账号">
        <input
          className={inputCls}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="username"
          autoFocus
          placeholder={fresh ? "Uranus" : ""}
        />
      </Field>
      <Field label="密码">
        <input
          type="password"
          className={inputCls}
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          autoComplete="current-password"
          placeholder={fresh ? "Uranus" : ""}
        />
      </Field>

      {error && <ResultNote state="fail" message={error} icon={KeyRound} />}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={busy || !name.trim() || !pass}>
          <LogIn size={14} />
          {busy ? "登录中…" : "登录"}
        </Button>
        {fresh && <span className="text-meta text-ink-meta">第一次进来：Uranus / Uranus</span>}
      </div>

      <p className="max-w-[46ch] text-meta leading-relaxed text-ink-faint">
        密码忘了的话，打开 <span className="text-ink-soft">data/auth.json</span>，
        把 password 那一行的值改成 <span className="text-ink-soft">null</span>，
        存盘就生效（不用重启），账号密码回到默认的 Uranus / Uranus。
      </p>
    </form>
  );
}

/**
 * 强制改账号密码。
 *
 * 用户定的规则：不少于 8 位、至少一个大写字母，「其他就没了」。
 * 所以这页只挡这两条，不额外要求符号或数字。
 */
function ChangeForm({ username, onDone }) {
  const [name, setName] = useState(username || "");
  const [pass, setPass] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // 一边打一边提示差什么，但空的时候不报错（刚进来就一片红字很吓人）
  const rule = pass ? checkPassword(pass) : "";
  const mismatch = again && pass !== again ? "两次输入的密码不一样。" : "";
  const ready = name.trim() && pass && again && !rule && !mismatch;

  async function submit(e) {
    e?.preventDefault();
    if (busy || !ready) return;
    setBusy(true);
    setError("");
    try {
      const out = await post("/api/auth/change", { username: name, password: pass });
      onDone(out?.username ?? name);
    } catch (err) {
      setError(String(err?.message ?? err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid grid-cols-1 gap-6">
      <p className="max-w-[46ch] border-l-2 border-ink pl-3 text-meta leading-relaxed text-ink-soft">
        默认账号密码是公开写在文档里的，谁都知道。这台服务上摆着你全部的 API
        密钥、手机号和聊天记录，所以先换一组只有你知道的。
      </p>

      <Field label="新账号">
        <input
          className={inputCls}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="username"
          autoFocus
          placeholder="随便取，中文也行"
        />
      </Field>
      <Field label="新密码" hint={`至少 ${MIN_PASSWORD} 位，含一个大写字母`}>
        <input
          type="password"
          className={inputCls}
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          autoComplete="new-password"
        />
      </Field>
      <Field label="再打一遍">
        <input
          type="password"
          className={inputCls}
          value={again}
          onChange={(e) => setAgain(e.target.value)}
          autoComplete="new-password"
        />
      </Field>

      {(rule || mismatch || error) && (
        <ResultNote state="fail" message={error || rule || mismatch} icon={KeyRound} />
      )}

      <div>
        <Button type="submit" disabled={busy || !ready}>
          <ShieldCheck size={14} />
          {busy ? "保存中…" : "设好了，进去"}
        </Button>
      </div>

      <p className="max-w-[46ch] text-meta leading-relaxed text-ink-faint">
        存的是哈希，不是密码本身 —— 谁都看不出原文，也找不回来。
        记不住的话现在就写下来；真忘了只能去 data/auth.json 里清掉那一行重来。
      </p>
    </form>
  );
}
