/**
 * Photon iMessage 的**裸 gRPC 底座**：铸 token、按线路开客户端。
 *
 * 为什么要有这一层：@spectrum-ts/imessage 这个 provider 把底层客户端包死了，
 * 既没有拿到裸客户端的口子，也没把 chat 事件流、`messages.get` 这些能力往外暴露。
 * 凡是 Spectrum 没给的东西（现在是「对方换了聊天背景」和「读一条消息的原始内容」），
 * 都得自己连一次 @photon-ai/advanced-imessage/grpc —— 那就都从这里拿客户端，
 * 免得每个功能各写一份铸币逻辑、各存一份 token。
 *
 * **和 photon.js 不是一回事。** 那个文件是 Photon 的**管理 REST API**
 * （建号、共享线路 enroll），走 HTTPS + 管理密钥；这里走 gRPC + 项目密钥，
 * 是真正收发消息那条链路。名字撞了纯属巧合，别把两边的地址混着用。
 *
 * 只用在云端模式。本地 Mac 模式读的是本机数据库，没有 Photon 可连。
 */

/** Spectrum 云端的地址；和 @spectrum-ts/imessage 里的默认值对齐。 */
export const CLOUD_URL = process.env.SPECTRUM_CLOUD_URL ?? "https://spectrum.photon.codes";

/** 共享线路的 gRPC 地址（专线是 `${instanceId}.imsg.photon.codes:443`）。 */
export const SHARED_ADDRESS =
  process.env.SPECTRUM_IMESSAGE_ADDRESS ?? "imessage.spectrum.photon.codes:443";

/** token 快过期了就提前换新的，别等它真过期。 */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

/**
 * 铸好的 token 缓存：`项目id|密钥` -> {lines, expiresAt}。
 *
 * 为什么要缓存：gRPC 客户端的 `token` 是个**回调**，长连接每次重连都会问一次，
 * 而铸币本身是一次 HTTPS 请求 —— 原来那个写法是每问一次就回源铸一次。
 * 一个正常起来的连接可能几天才问一次，那无所谓；但订阅起不来时（比如对面
 * 不支持 chat 事件流）会退避重连，每次重连都要铸一次新币，白白打接口。
 *
 * 缓存按项目分（同一个号码的多个用途共用一份 —— 盯背景那条长连接和读卡片那种
 * 用完就关的短连接会命中同一条），过期前 TOKEN_REFRESH_MARGIN_MS 就提前作废。
 */
const tokenCache = new Map();

/**
 * 铸一次 Photon token，返回能用来开 gRPC 客户端的线路表。
 *
 * 这里的形状抄的是 @spectrum-ts/imessage 的 createCloudClients —— 它内部做的
 * 也是这一件事，只是没把客户端给我们。两种 token：
 *  - `shared`：整个项目一条共享线路，所有 gRPC 都连同一个地址；
 *  - `dedicated`：一条线路一个 instanceId，各自连 `${instanceId}.imsg.photon.codes:443`。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force] 跳过缓存强制重铸（token 被服务端提前作废时用）
 * @returns {Promise<{lines: {address: string, instanceId: string, token: string}[], expiresAt: number}>}
 */
export async function mintLines(projectId, projectSecret, { force = false } = {}) {
  const key = `${projectId}|${projectSecret}`;
  const cached = tokenCache.get(key);
  if (!force && cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
    return cached;
  }

  const { cloud } = await import("@spectrum-ts/core");
  const data = await cloud.issueImessageTokens(projectId, projectSecret);
  const expiresAt = Date.now() + (Number(data?.expiresIn) || 300) * 1000;

  let lines;
  if (data?.type === "dedicated") {
    lines = Object.entries(data.auth ?? {}).map(([instanceId, token]) => ({
      address: `${instanceId}.imsg.photon.codes:443`,
      instanceId,
      token,
    }));
  } else {
    lines = [{ address: SHARED_ADDRESS, instanceId: "shared", token: data?.token ?? "" }];
  }

  const fresh = { lines, expiresAt };
  tokenCache.set(key, fresh);
  return fresh;
}

/**
 * 给这个项目的每条线路各开一个 gRPC 客户端。
 *
 * token 传的是**函数**而不是字符串：长连接在重连时会重新问一次，只有函数形式
 * 才能拿到新铸的那个。函数里走缓存，没过期就直接给现成的。
 *
 * 调用方负责关 —— 长连接自己留着（chatbg.js），用一次就走的记得 closeClients。
 *
 * @param {object} [opts]
 * @param {number} [opts.timeout] 一元调用的超时（毫秒）。流式调用不受这个管
 * @returns {Promise<{address: string, instanceId: string, client: object}[]>}
 */
export async function createLineClients(projectId, projectSecret, { timeout } = {}) {
  const { createGrpcClient } = await import("@photon-ai/advanced-imessage/grpc");
  const { lines } = await mintLines(projectId, projectSecret);
  if (!lines.length) throw new Error("这个项目没有可用的 iMessage 线路");

  return lines.map((line) => ({
    address: line.address,
    instanceId: line.instanceId,
    client: createGrpcClient({
      address: line.address,
      tls: true,
      // 流式 RPC 本来就不会被自动重试，这里开 retry 只是为了那些一元调用
      retry: true,
      ...(timeout ? { timeout } : {}),
      token: async () => {
        const { lines: fresh } = await mintLines(projectId, projectSecret);
        const hit = fresh.find((l) => l.address === line.address);
        return hit?.token ?? line.token;
      },
    }),
  }));
}

/** 挨个关掉客户端，谁抛错都不管 —— 收尾失败不该盖住正事的结果。 */
export async function closeClients(list) {
  for (const item of list ?? []) {
    try {
      await (item?.client ?? item)?.close?.();
    } catch {
      /* ignore */
    }
  }
}
