/**
 * 网络层出错时的两件事：把埋着的错误码挖出来、把它说成人话。
 *
 * 以前这两件事住在 proxy.js 里，和「哪一类走代理」绑在一起。代理整块删掉之后
 * （用户的原话：「我自己下 clash 开全局都比这个过代理要快」），所有出网都是
 * 直连，这里只剩和代理无关的那一半。
 *
 * 要翻墙的话在系统层面解决：Clash 这类客户端开 TUN（虚拟网卡）模式。
 * 注意 Node 的 fetch **不认系统代理**，只开「系统代理」那个开关是不够的。
 */

/**
 * 把一个网络异常里埋着的错误码全挖出来，最像「真正原因」的那个排在最前。
 *
 * 真实原因有时埋得比 `e.cause` 更深。Happy Eyeballs（Node 20 起默认开）在
 * IPv6 和 IPv4 都连不上时会抛一个 `AggregateError`，`code` 挂在外层、
 * **里面每一条才带具体原因**。只读 `e.cause.code` 的话这些全都读不到，
 * 于是掉进 whyNetwork 最后那个兜底、把 undici 的 `fetch failed` 原样吐出去。
 *
 * `UND_ERR_CONNECT_TIMEOUT` 排在后面：它是 undici 对「连不上」的统称，
 * 底下那条具体的（ECONNREFUSED 之类）才是要说给人听的。
 *
 * @returns {string[]} 从最具体到最笼统。一个都没有时是空数组
 */
export function netCodes(e) {
  const codes = [];
  const seen = new Set();
  const walk = (err, depth = 0) => {
    if (!err || depth > 4 || seen.has(err)) return;
    seen.add(err);
    const c = String(err?.code ?? "").trim();
    if (c) codes.push(c);
    for (const sub of err?.errors ?? []) walk(sub, depth + 1);
    walk(err?.cause, depth + 1);
  };
  walk(e?.cause);
  walk(e);
  const first = codes.find((c) => c !== "UND_ERR_CONNECT_TIMEOUT");
  return first ? [first, ...codes.filter((c) => c !== first)] : codes;
}

/** 最像「真正原因」的那个错误码，没有就是空串。拿来做判断；说给人听用 whyNetwork。 */
export function netCode(e) {
  return netCodes(e)[0] ?? "";
}

/**
 * 网络层出错时说人话。
 *
 * `fetch failed` 是 undici 对一切网络问题的统称，原样抛给用户等于什么都没说。
 * 这里把最常见的几种拆开，每种都直接指向要改的东西。
 *
 * 错误码**每一句都要带上**：这句话会进日志、进界面，有几处还会原样发到用户的
 * iMessage 里（imessage.js:notifyFailure）。中文解释是给人省事的，而那个码是
 * 唯一能拿去搜、能贴到群里对上号的东西。
 *
 * @param {unknown} e 抓到的异常
 * @param {number} [timeoutMs] 超时值，说给用户听
 */
export function whyNetwork(e, timeoutMs) {
  const name = String(e?.name ?? "");
  const msg = String(e?.message ?? e);
  const codes = netCodes(e);
  const code = codes[0] ?? "";
  const tag = code ? `（${code}）` : "";

  if (name === "TimeoutError" || code === "UND_ERR_HEADERS_TIMEOUT" || /timeout/i.test(msg)) {
    const secs = timeoutMs ? `（${Math.round(timeoutMs / 1000)} 秒）` : "";
    return `请求超时${secs} —— 这台机器到对方的网络不通，或者对方太慢`;
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return `域名解析不了${tag} —— 地址是不是打错了？也可能是这台机器的 DNS 不通`;
  }
  if (code === "ECONNREFUSED") {
    // 被墙的表现是超时或者被重置，不是被拒绝 —— 这一种多半是地址 / 端口写错了
    return `对方拒绝连接${tag} —— 那个端口上没有服务，接口地址和端口填对了吗？`;
  }
  if (code === "ECONNRESET") {
    return `连接被重置${tag} —— 对方中途断了连接（也可能是被墙了）`;
  }
  if (code === "CERT_HAS_EXPIRED" || code.startsWith("ERR_TLS") || /certificate/i.test(msg)) {
    return `证书校验失败${tag} —— 中间有东西在拦（企业网关、杀毒软件的 HTTPS 扫描）`;
  }
  if (/^UND_ERR_|^ECONN|^EPIPE$|^ETIMEDOUT$/.test(code)) {
    return `连不上目标${tag} —— 先看这台机器能不能出网、地址填对没有`;
  }
  if (/fetch failed|socket|other side closed/i.test(msg)) {
    return `连接失败${tag} —— 先看这台机器能不能出网、地址填对没有`;
  }
  return codes.length ? `${msg}（${codes.join("、")}）` : msg;
}
