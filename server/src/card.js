/**
 * 卡片：认出对方分享过来的那种「一整块」的消息，以及把模型写的 [card:链接]
 * 发成一张真的链接卡片。
 *
 * ## 进来的那一半（不花钱、不用开关、默认就在）
 *
 * iMessage 里有两种东西会长成一张卡片：
 *
 *  1. **富链接**：直接发一条网址，iMessage 自己抓标题和封面图。
 *     这种消息的正文**就是那条网址**，Spectrum 照常当文字给我们，模型本来
 *     就看得到 —— 这个文件对它只做一件事：正文里要是有苹果地图的链接，
 *     换成 `[location:地名:坐标]`（见 renderMapsLinks，理由在那儿）。
 *  2. **app 扩展卡片**：网易云音乐、Apple Music、美团那种，从第三方 app 的
 *     iMessage 扩展里发出来的。它**没有正文、也没有附件**，全部内容都压在
 *     一个私有 payload 里。Spectrum 遇到这种消息会退化成
 *     `asCustom({imessage_type:"unsupported-message"})`，而 imessage.js 那边
 *     「既不是文本也不是图片就跳过」—— 也就是说**对方发了，模型完全不知道**。
 *
 * 这个文件补的就是第 2 种。两级信息，能拿到哪级用哪级：
 *
 *  - **白嫖那级**：`balloonBundleId` 和 `nativeText` 是 Spectrum 平铺在消息上的
 *    元数据（buildMessageBase 里 `...toMessageMetadata(message)`），读它们不花
 *    任何代价、也不用联网。前者形如
 *    `com.apple.messages.MSMessageExtensionBalloonPlugin:TEAMID:com.netease.cloudmusic.xxx`，
 *    从里面能刨出是哪个 app。够写出「{{user}} 分享了一张网易云音乐的卡片」。
 *  - **多问一句那级**：卡片上真正的歌名/歌手在 `MiniAppContent.layout` 里，
 *    而 Spectrum 把整个 miniApp 字段丢了。底层 gRPC 的 `messages.get(guid)` 能把
 *    原始消息捞回来，里面有。这一步要**联网**，所以是 best-effort：超时短、
 *    失败就退回上一级，绝不拖住收消息那条主路。
 *
 * 为什么这一半不做成开关：它修的是「消息被静默丢掉」这个洞，不是新增一个会
 * 花钱/会外发的能力。给它加开关等于让用户去打开「请正常收消息」。
 *
 * ## 出去的那一半（要过三道闸）
 *
 * 模型写 `[card:https://…]`，这里只管把标记认出来（在 media.js），真发在
 * imessage.js:sendCardPart —— 走 spectrum-ts 的 `richlink(url)`，云端会翻译成
 * 「发这条文字 + 开链接预览」，在对方手机上就是一张卡片。
 *
 * **发不出「网易云音乐」那种带 app 图标和自定义排版的卡片。** 那种要用
 * `customizedMiniApp`，参数里得填真实的 Apple `teamId` + 扩展 `bundleId` ——
 * 填网易的就是冒充人家 app 的身份。所以这边只发链接卡片：链接是真的，
 * 预览图和标题是对方手机自己抓的，谁也没被冒充。
 */

import { logDebug, logWarn } from "./logs.js";
import { closeClients, createLineClients } from "./photongrpc.js";

/** 问一次原始消息最多等多久。收消息那条路在等它，不能久。 */
const DETAIL_TIMEOUT_MS = 6000;

/**
 * 发 / 改一张转账卡片最多等多久。
 *
 * 比读详情那条宽一倍：这是一次真的发送（要落到对方手机上），而读详情只是
 * 查一句本地数据。但也不能太宽 —— 用户正等着这条气泡出现在对话里。
 */
const SEND_TIMEOUT_MS = 12_000;

/** app 扩展卡片的 balloonBundleId 前缀，后面跟 `:TEAMID:扩展bundleId`。 */
const EXT_PREFIX = "com.apple.messages.MSMessageExtensionBalloonPlugin";

/**
 * 苹果自家那些「不是 app 卡片」的气泡。
 *
 * 它们和第三方卡片走同一个字段，但既不该说成「分享了一张卡片」，也没有
 * miniApp 可问。列在这里是为了**认出来单独说**——这些消息现在同样是被
 * 静默丢掉的，顺手一起捞回来，一行字的事。
 */
const APPLE_BALLOONS = {
  "com.apple.messages.URLBalloonProvider": "", // 富链接：正文就是网址，不用管
  "com.apple.Handwriting.HandwritingProvider": "一条手写消息",
  "com.apple.DigitalTouchBalloonProvider": "一条 Digital Touch",
  "com.apple.messages.MSMessageExtensionBalloonPlugin:0000000000:com.apple.PassbookUIService.PeerPaymentMessagesExtension":
    "一条 Apple Cash",
};

/**
 * 认得出来的几个 app，用来把 bundleId 换成人话。
 *
 * 认不出来的**不猜**：直接用卡片自报的 appName，再没有就说「一张卡片」。
 * 猜错 app 名比不说更糟 —— 模型会顺着错的名字往下编。
 *
 * 位置共享不在这张表里，它有自己一条路（LOCATION_SHARE_PREFIXES）——
 * 套进这张表的话会说成「分享了一张位置共享的卡片」，不是人话。
 */
const KNOWN_APPS = {
  "com.netease.cloudmusic": "网易云音乐",
  "com.tencent.qqmusic": "QQ音乐",
  "com.apple.music": "Apple Music",
  "com.spotify.client": "Spotify",
  "com.google.ios.youtube": "YouTube",
  "com.ss.iphone.ugc.aweme": "抖音",
  "com.zhiliaoapp.musically": "TikTok",
  "com.xingin.discover": "小红书",
  "com.tencent.xin": "微信",
  "com.taobao.taobao": "淘宝",
  "com.meituan.imeituan": "美团",
  "com.sankuai.meituan": "美团",
  "com.dianping.dpscope": "大众点评",
  "com.jingdong.app.mall": "京东",
  "com.bilibili.mobile": "哔哩哔哩",
  "tv.danmaku.bili": "哔哩哔哩",
  "com.burbn.instagram": "Instagram",
};

/**
 * 用户共享位置那条消息的 bundleId 前缀。
 *
 * iMessage 里点「共享我的位置」发来的是一个气泡消息，走的和第三方卡片同一个
 * 字段。不单独认的话模型只会看到「发来了一张卡片」这种废话 —— 而「对方把
 * 位置共享给你了」是句要紧的话，值得单独说一句。
 *
 * **这几个 id 我没有实物验过**，所以按前缀匹配、多列几个候选。cardHintFor
 * 末尾那句 logDebug 会把真 id 打出来：用户共享一次位置、看一眼日志就能把它
 * 填准。宁可漏认（退化成现在的「一张卡片」）也不误认成别的 app。
 *
 * 「发送当前位置」/ 长按放一个大头针（一次性的那种）不走这条路 —— 那是一条
 * maps.apple.com 的富链接，正文就是网址，由 renderMapsLinks 换成
 * `[location:…]` 交给模型。
 */
const LOCATION_SHARE_PREFIXES = [
  "com.apple.findmy",
  "com.apple.mobileme.fmf1",
  "com.apple.mobileme.fmf",
  "com.apple.friendfinder",
];

/** 这个 bundleId 是不是位置共享。前缀匹配，理由见上面。 */
function isLocationShare(bundleId) {
  const id = String(bundleId ?? "").toLowerCase();
  if (!id) return false;
  return LOCATION_SHARE_PREFIXES.some((p) => id === p || id.startsWith(`${p}.`));
}

/**
 * 从 balloonBundleId 里刨出这是什么气泡。
 *
 * @returns {null | {kind: "apple"|"url"|"extension", appName: string, bundleId: string}}
 *   null = 根本不是气泡消息（普通文字/图片都走这条）
 */
export function parseBalloon(balloonBundleId) {
  const raw = String(balloonBundleId ?? "").trim();
  if (!raw) return null;

  // 苹果自家的先认全串（Apple Cash 那条也是扩展前缀开头，得排在前面）
  if (Object.hasOwn(APPLE_BALLOONS, raw)) {
    const label = APPLE_BALLOONS[raw];
    if (raw === "com.apple.messages.URLBalloonProvider") {
      return { kind: "url", appName: "", bundleId: raw };
    }
    return { kind: "apple", appName: label, bundleId: raw };
  }

  if (!raw.startsWith(EXT_PREFIX)) {
    // 认不出的苹果自带气泡（投票、Apple Pay 的新形态…）：当成一条说不清的卡片
    return raw.startsWith("com.apple.")
      ? { kind: "apple", appName: "", bundleId: raw }
      : { kind: "extension", appName: "", bundleId: raw };
  }

  // `前缀:TEAMID:扩展bundleId`，扩展 bundleId 里还可能自带冒号，所以只切前两刀
  const rest = raw.slice(EXT_PREFIX.length).replace(/^:/, "");
  const bundleId = rest.includes(":") ? rest.slice(rest.indexOf(":") + 1) : rest;
  return { kind: "extension", appName: appNameFor(bundleId), bundleId };
}

/**
 * bundleId → app 名。
 *
 * 扩展的 bundleId 一般是「主 app 的 id + 一截后缀」（网易云那个是
 * `com.netease.cloudmusic.iMessageExtension`），所以用前缀匹配而不是全等。
 */
function appNameFor(bundleId) {
  const id = String(bundleId ?? "").toLowerCase();
  if (!id) return "";
  for (const [key, name] of Object.entries(KNOWN_APPS)) {
    if (id === key || id.startsWith(`${key}.`)) return name;
  }
  return "";
}

/**
 * 把 miniApp 的排版字段拼成一句能读的话。
 *
 * 苹果那套模板有七个槽（caption / subcaption / trailingCaption / …），各家填法
 * 不一样：音乐类一般是 caption=歌名、subcaption=歌手，有的只填 imageTitle。
 * 所以按「最可能是标题」的顺序挑前两个非空的，拼成「歌名 · 歌手」。
 */
function layoutSummary(layout) {
  const order = [
    layout?.caption,
    layout?.imageTitle,
    layout?.subcaption,
    layout?.imageSubtitle,
    layout?.trailingCaption,
    layout?.summary,
  ];
  const seen = new Set();
  const picked = [];
  for (const raw of order) {
    const t = String(raw ?? "").trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    picked.push(t.length > 60 ? `${t.slice(0, 60)}…` : t);
    if (picked.length === 2) break;
  }
  return picked.join(" · ");
}

/**
 * 去底层 gRPC 把这条消息的原始内容捞回来，读里面的 miniApp。
 *
 * **best-effort**：超时 6 秒、失败只记 debug。拿不到就用上一级的信息，
 * 模型至少知道「对方发了张网易云音乐的卡片」，只是不知道是哪首歌。
 *
 * 卡片不常见，所以这里是**用完就关**：临时开一个客户端问一句就收掉，
 * 不像 chatbg.js 那样留着长连接。token 走的是同一份缓存，不会多铸。
 *
 * @returns {Promise<null | {appName: string, title: string, url: string}>}
 */
async function fetchCardDetail({ projectId, projectSecret, messageGuid, scope }) {
  let opened = [];
  try {
    opened = await createLineClients(projectId, projectSecret, { timeout: DETAIL_TIMEOUT_MS });
    // 专线模式下有多条线路，消息只在其中一条上；挨个问，第一条问到就收工
    for (const { client, instanceId } of opened) {
      try {
        const native = await client.messages.get(messageGuid);
        const mini = native?.content?.miniApp;
        if (!mini) continue;
        return {
          appName: String(mini.appName ?? "").trim(),
          title: layoutSummary(mini.layout),
          url: String(mini.url ?? "").trim(),
        };
      } catch (e) {
        logDebug(scope, `线路 ${instanceId} 上没读到这条消息：${String(e?.message ?? e)}`);
      }
    }
    return null;
  } catch (e) {
    logDebug(scope, `读卡片详情失败：${String(e?.message ?? e)}`);
    return null;
  } finally {
    await closeClients(opened);
  }
}

/**
 * 对方发来的这条消息如果是张卡片，给模型写一句提示。
 *
 * 提示里的 `{{user}}` 是**字面量**，和背景变更、撤回那几条一样 —— 存进历史的
 * 是原样的 `{{user}}`，注入提示词时才由 prompt.js:applyVars 换成真名。
 *
 * 返回空串 = 这条不用管（普通消息，或者富链接那种正文已经是网址的）。
 *
 * @param {object} message Spectrum 的消息对象（元数据是平铺在上面的）
 * @param {object} [opts]
 * @param {string} [opts.projectId] 给了才会去问详情；本地 Mac 模式不要给
 * @param {string} [opts.projectSecret]
 * @param {string} [opts.label] 日志里显示的角色名
 * @returns {Promise<string>}
 */
export async function cardHintFor(message, { projectId, projectSecret, label } = {}) {
  const info = parseBalloon(message?.balloonBundleId);
  if (!info) return "";
  const scope = label ? `卡片·${label}` : "卡片";

  // 富链接：正文就是那条网址，模型已经看见了，再加一句只会重复
  // （地图链接那种「看得见但读不懂」的，由 renderMapsLinks 在正文上改，不在这儿）
  if (info.kind === "url") return "";

  /*
   * 位置共享排在最前面：它可能落成 kind:"apple"（bundleId 直接是
   * com.apple.findmy…，appName 空 → 下面那行会返回空串、整条消息静默丢掉），
   * 也可能落成 kind:"extension"（走扩展前缀那条）。两种都得拦住，所以在
   * 分支之前先判一次。
   */
  if (isLocationShare(info.bundleId)) {
    const hint = "[系统提示:{{user}}把自己的位置共享给你了]";
    logDebug(scope, `认出位置共享（${info.bundleId}）→ ${hint}`);
    return hint;
  }

  if (info.kind === "apple") {
    return info.appName ? `[系统提示:{{user}}发来了${info.appName}]` : "";
  }

  // app 扩展卡片。先把不花钱的那级攒出来
  let appName = info.appName;
  let title = "";
  let url = "";

  if (projectId && projectSecret && message?.id) {
    const detail = await fetchCardDetail({
      projectId,
      projectSecret,
      messageGuid: String(message.id),
      scope,
    });
    if (detail) {
      // 卡片自报的名字优先级低于我们认识的中文名（它经常是英文或者内部代号）
      if (!appName && detail.appName) appName = detail.appName;
      title = detail.title;
      url = detail.url;
    }
  }

  // nativeText 兜底：有些扩展会同时塞一段文字进正文
  if (!title) {
    const native = String(message?.nativeText ?? "").trim();
    if (native) title = native.length > 60 ? `${native.slice(0, 60)}…` : native;
  }

  const who = appName ? `一张${appName}的卡片` : "一张卡片";
  const what = title ? `：${title}` : "";
  const link = url && !title ? `：${url}` : "";
  const hint = `[系统提示:{{user}}分享了${who}${what}${link}]`;
  logDebug(scope, `认出一张卡片（${info.bundleId}）→ ${hint}`);
  return hint;
}

/* ================= 转账卡片（发出去的那一半） ================= */

/**
 * 转账卡片的身份三件套。
 *
 * ── 为什么是假值，而且写死在这儿 ──
 *
 * `sendCustomizedMiniApp` 要 `teamId` + `extensionBundleId`，服务端**只验格式、
 * 不验归属** —— 填腾讯的 team id 和 `com.tencent.xin.…`，对方手机上那张卡片
 * 就会自称是微信发的。那是冒充一家公司的身份，这个文件从一开始就拒绝这么做
 * （见文件头「出去的那一半」）。
 *
 * 所以这儿用一对明显不属于任何人的值：team id 全 A（格式合法：10 位大写
 * 字母数字），bundle id 在我们自己的命名空间下。后果是对方手机上没有对应的
 * 扩展 —— **点卡片不会有任何反应**，这恰好是我们想要的：它是一张给人看的
 * 凭证，不该点开跳去任何地方。
 *
 * 用户能自己填的只有 `appName`（卡片上那行小字，见 role.transfer.appName）——
 * 那是纯展示字符串，写「转账」还是写某家银行的名字由用户决定，代码不替他选。
 */
const TRANSFER_TEAM_ID = "AAAAAAAAAA";
const TRANSFER_BUNDLE_ID = "codes.uranus.transfer";

/**
 * 点卡片时交给扩展的网址。
 *
 * 必填（proto 里是 `string url = 5`，不是 optional），但对方装不了我们那个
 * 不存在的扩展，所以这条网址**永远不会被打开**。指向项目主页而不是随便编一个
 * —— 万一哪天真被谁点开了，看到的也该是个说得清来路的地方。
 */
const TRANSFER_URL = "https://github.com/photon-hq/advanced-imessage-ts";

/** 卡片右上角那行状态字。两种状态，别的没有（过期退回没做）。 */
const TRANSFER_STATE_LABEL = {
  pending: "待收款",
  received: "已收款",
};

/**
 * 金额那串**原文**规整成卡片上显示的样子。
 *
 * 模型写的可能是 `4000`、`4000.5`、`￥4000`、`4,000`。统一成两位小数加一个
 * 人民币符号 —— 一笔转账写着「￥4000」和「￥4000.00」，后者才像凭证。
 *
 * 认不出数字时**原样带回**（只补个 ￥）：宁可显示一串怪东西，也不要把一笔
 * 转账显示成 ￥0.00 —— 后者看起来完全正常，错得没人发现。
 *
 * @returns {string} 比如「￥4,000.00」
 */
export function formatAmount(raw) {
  const text = String(raw ?? "").trim();
  // 去掉货币符号和千分位逗号再认数字
  const cleaned = text.replace(/[￥¥$,，\s]/g, "");
  const n = Number(cleaned);
  if (!Number.isFinite(n) || cleaned === "") {
    return text.startsWith("￥") ? text : `￥${text}`;
  }
  return `￥${n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * 一笔转账拼成 `MiniAppLayout`。
 *
 * 六个文字槽是苹果 `MSMessageTemplateLayout` 钉死的位置，我们只决定往哪个槽
 * 里放什么（排版权拿不到，见文件头）：
 *
 *   caption            ￥4,000.00     左上、加粗，最显眼 —— 金额
 *   subcaption         零花钱          金额下面 —— 备注
 *   trailingCaption    待收款          右上 —— 状态
 *   summary            转账 ￥4,000.00  渲染不出卡片的地方（通知、旧系统）显示这个
 *
 * `image` / `imageTitle` / `imageSubtitle` 三个**不填**：缩略图要一张真的
 * JPEG 字节（服务端会验），而这个功能眼下不带图。proto 那边的约束是
 * 「image 和 imageTitle 必须一起给」，都不给最省事也最安全。
 *
 * 备注可以是空的 —— 服务端只要求「caption/subcaption/trailingCaption/
 * trailingSubcaption/image 至少有一个非空」，金额和状态都在，够了。
 */
function transferLayout({ amount, note, state }) {
  const money = formatAmount(amount);
  const label = TRANSFER_STATE_LABEL[state] ?? TRANSFER_STATE_LABEL.pending;
  const memo = String(note ?? "").trim();
  return {
    caption: money,
    ...(memo ? { subcaption: memo } : {}),
    trailingCaption: label,
    summary: `转账 ${money}${memo ? ` · ${memo}` : ""}（${label}）`,
  };
}

/**
 * 发一张转账卡片。
 *
 * 走底层 gRPC 的 `sendCustomizedMiniApp` —— Spectrum 没把这条 RPC 包出来
 * （`space.send()` 认的那几种 content 里没有 miniApp），所以这儿和
 * `fetchCardDetail` 一样临时开一个客户端，用完就关。
 *
 * **只有云端模式能发**：本地 Mac 模式没有 Photon 可问，调用方负责挡
 * （`runner.mode === "cloud"`）。
 *
 * 专线模式下一个项目可能挂着多条线路，而这条消息只能从**发这个角色的那条**
 * 发出去。所以挨个试，第一条成功就收工 —— 和 `fetchCardDetail` 同一个路子。
 *
 * @param {object} opts
 * @param {string} opts.projectId
 * @param {string} opts.projectSecret
 * @param {string} opts.chatGuid 会话的 chat GUID（就是 imessage.js 里的 spaceId）
 * @param {string} opts.amount 金额原文
 * @param {string} opts.note 备注，可以是空串
 * @param {string} opts.appName 卡片上那行小字，用户自己填的
 * @param {string} [opts.scope] 日志前缀
 * @returns {Promise<null | {messageGuid: string, chatGuid: string,
 *   sessionId: string, targetMessageGuid: string}>}
 *   发出去了就返回那四个 guid（存下来才能改状态，见 transferstore.js）；
 *   一条线路都没成功返回 null
 */
export async function sendTransferCard({
  projectId,
  projectSecret,
  chatGuid,
  amount,
  note,
  appName,
  scope = "转账",
}) {
  if (!projectId || !projectSecret || !chatGuid) return null;

  let opened = [];
  try {
    opened = await createLineClients(projectId, projectSecret, { timeout: SEND_TIMEOUT_MS });
    const message = {
      appName: String(appName ?? "").trim() || "转账",
      extensionBundleId: TRANSFER_BUNDLE_ID,
      teamId: TRANSFER_TEAM_ID,
      url: TRANSFER_URL,
      layout: transferLayout({ amount, note, state: "pending" }),
    };

    let lastError = null;
    for (const { client, instanceId } of opened) {
      try {
        const result = await client.messages.sendCustomizedMiniApp(chatGuid, message);
        const session = result?.miniAppCardSession;
        if (!session?.sessionId) {
          // 发出去了但没给句柄：卡片在对方手机上，只是以后改不了状态。
          // 当成功报，别让用户以为这笔没发出去
          logWarn(scope, "卡片发出去了，但没拿到会话句柄，这笔以后改不了「已收款」");
          return null;
        }
        logDebug(scope, `发了一张转账卡片（线路 ${instanceId}）：${formatAmount(amount)}`);
        return {
          messageGuid: String(session.messageGuid ?? result?.guid ?? ""),
          chatGuid: String(session.chatGuid ?? chatGuid),
          sessionId: String(session.sessionId),
          targetMessageGuid: String(session.targetMessageGuid ?? ""),
        };
      } catch (e) {
        lastError = e;
        logDebug(scope, `线路 ${instanceId} 发不出这张卡片：${String(e?.message ?? e)}`);
      }
    }
    if (lastError) logWarn(scope, "转账卡片没能发出去", lastError);
    return null;
  } catch (e) {
    logWarn(scope, "转账卡片没能发出去（开不了客户端）", e);
    return null;
  } finally {
    await closeClients(opened);
  }
}

/**
 * 把一张已经发出去的转账卡片原地改成另一个状态。
 *
 * 走 `updateCustomizedMiniApp` —— 对方看到的是**同一条气泡内容变了**，
 * 不是新来一条消息。这是整个功能里最像真转账的一步。
 *
 * 身份三件套必须和发的时候**一模一样**（teamId / bundleId / appName / url）：
 * 换了的话等于「另一个 app 来改这张卡片」。所以 appName 也从存下来的那笔里
 * 取，不从当前配置读 —— 用户中途把 appName 改了，老卡片还得能收款。
 *
 * @param {object} opts
 * @param {string} opts.projectId
 * @param {string} opts.projectSecret
 * @param {object} opts.session 存下来的那四个 guid（transferstore.js 的条目）
 * @param {string} opts.amount
 * @param {string} opts.note
 * @param {string} opts.appName
 * @param {"pending"|"received"} opts.state 要改成哪个状态
 * @param {string} [opts.scope]
 * @returns {Promise<boolean>} 改成功了没有
 */
export async function updateTransferCard({
  projectId,
  projectSecret,
  session,
  amount,
  note,
  appName,
  state,
  scope = "转账",
}) {
  if (!projectId || !projectSecret || !session?.sessionId) return false;

  let opened = [];
  try {
    opened = await createLineClients(projectId, projectSecret, { timeout: SEND_TIMEOUT_MS });
    const handle = {
      messageGuid: String(session.messageGuid ?? ""),
      chatGuid: String(session.chatGuid ?? ""),
      sessionId: String(session.sessionId),
      targetMessageGuid: String(session.targetMessageGuid ?? ""),
    };
    const message = {
      appName: String(appName ?? "").trim() || "转账",
      extensionBundleId: TRANSFER_BUNDLE_ID,
      teamId: TRANSFER_TEAM_ID,
      url: TRANSFER_URL,
      layout: transferLayout({ amount, note, state }),
    };

    for (const { client, instanceId } of opened) {
      try {
        await client.messages.updateCustomizedMiniApp(handle, message);
        logDebug(
          scope,
          `把一张转账卡片改成了「${TRANSFER_STATE_LABEL[state] ?? state}」（线路 ${instanceId}）`
        );
        return true;
      } catch (e) {
        logDebug(scope, `线路 ${instanceId} 改不了这张卡片：${String(e?.message ?? e)}`);
      }
    }
    logWarn(scope, "转账卡片的状态没改过去（气泡还停在原来那个状态）");
    return false;
  } catch (e) {
    logWarn(scope, "转账卡片的状态没改过去（开不了客户端）", e);
    return false;
  } finally {
    await closeClients(opened);
  }
}

/**
 * 模型写的 `[card:xxx]` 里那个 xxx 能不能当链接发。
 *
 * 只认 http/https：卡片本质上是「发一条网址让对方手机去抓预览」，别的协议
 * （`music://`、`weixin://`）发过去就是一行没人认识的字。认不出来的在
 * media.js 那边压根不会切成 card 段，这里是发之前再确认一次。
 */
export function isCardUrl(text) {
  const raw = String(text ?? "").trim();
  if (!raw || /\s/.test(raw)) return false;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * iPhone 自己分享大头针时带的那个 span（可视范围，单位是度）。
 *
 * 抄的是用户实物分享过来那条链接里的值。它对卡片缩略图**没有影响**（实测
 * 带不带、写多少，og:image 那张图的 spn 都被服务端夹成 0.008983），留着纯粹
 * 是为了让我们发出去的链接和真 iPhone 发的长得一模一样。
 */
const PIN_SPAN = "0.028033,0.037066";

/** 「纬度,经度」→ {lat, lon}；不合法（写反、超范围、根本不是数）返回 null。 */
function parseLatLon(ll) {
  const m = /^(-?\d{1,3}(?:\.\d+)?)\s*[,，]\s*(-?\d{1,3}(?:\.\d+)?)$/.exec(String(ll ?? "").trim());
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  // 纬度 ±90、经度 ±180：超了就是写反了或者编错了
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/**
 * 一个地名（可选加一对坐标）拼成苹果地图的网址。
 *
 * 这是「分享位置」那条路的全部服务端逻辑：模型只写地名（**允许编** —— 角色说
 * 自己在哪儿本来就是虚构的），网址在这儿现拼，然后照 `[card:…]` 那条路
 * 用 richlink 发出去，对方点一下直接开地图。
 *
 * 和 music.js 是同一个模式：模型写自然语言，网址由服务端负责。别让模型自己
 * 编网址 —— 参数拼错了对方点开是一片空白，而它没法自己验。
 *
 * ── 两种形态，按有没有坐标分 ──
 *
 *   有坐标  `/place?coordinate=22.817,108.3665&name=南宁万象城&span=…`
 *   没坐标  `/?q=南宁万象城`
 *
 * 上面那条**就是 iPhone 自己分享大头针时发出来的格式**（用户把实物链接贴过来
 * 对过了）。原来这儿拼的是 `/?ll=…&q=…`，卡片效果实测和它一模一样，但既然
 * 苹果自己用的是前者，就跟苹果一致 —— 我们发出去的和对方发过来的长一个样，
 * 顺手也让下面 parseMapsUrl 认自己发的链接时走同一条路。
 *
 * **为什么没坐标时不用 `/place?name=`**：实测 `/place?name=南宁万象城`（不带
 * coordinate）的 og:title 是「Minami」、缩略图 center 在 `35.43,139.62`——
 * 它去日本找了个同名的地方，而且一点也看不出错。`?q=` 那条至少标题是对的
 * （只多个 🔎 前缀）、点开能正确搜到，缩略图不准而已。宁可缩略图不准，
 * 也不能把人送到错的地方去。
 *
 * 所以提示词里写的是「尽量把坐标写上」（见 preset.js 的 location 那条正文），
 * 而坐标写错（写反、超范围）时这儿退回 `?q=`，不整条丢掉。
 *
 * @param {string} name 地名，会被 URL 自己编码（中文必须编码，手拼字符串会漏）
 * @param {string} [ll] 「纬度,经度」，可选
 * @returns {string} 拼好的网址；name 是空的返回空串
 */
export function mapsUrlFor(name, ll = "") {
  const q = String(name ?? "").trim();
  if (!q) return "";

  const co = parseLatLon(ll);
  if (!co) {
    const u = new URL("https://maps.apple.com/");
    u.searchParams.set("q", q);
    return u.toString();
  }

  const u = new URL("https://maps.apple.com/place");
  u.searchParams.set("coordinate", `${co.lat},${co.lon}`);
  u.searchParams.set("name", q);
  u.searchParams.set("span", PIN_SPAN);
  /*
   * URLSearchParams 会把逗号编成 %2C，苹果自己发的是裸逗号。两种服务端都认
   * （验过），但既然是对着人家的格式抄，就抄全 —— 逗号在 query 里本来就是
   * 合法字符。只还原逗号，地名那段的编码一个字不动。
   */
  return u.toString().replace(/%2C/g, ",");
}

/** 认得出来的苹果地图域名。`maps.apple` 是苹果 2024 起用的短域名。 */
const MAPS_HOSTS = new Set(["maps.apple.com", "maps.apple", "beta.maps.apple.com"]);

/**
 * 一条苹果地图网址 → `{name, ll}`，不是地图链接返回 null。
 *
 * 认这几种参数（苹果自己在不同版本里都用过，分享大头针是第一种）：
 *
 *   `/place?coordinate=22.807,108.411&name=已放置的大头针&span=…`
 *   `/?ll=22.807,108.411&q=名字`
 *   `/?q=名字` / `/?address=…` / `/place?address=…&name=…`
 *   `/?daddr=…`（导航到某地）
 *
 * 名字和坐标能拿到哪个算哪个：只有坐标没名字的，名字给空串，由调用方决定
 * 怎么显示。
 */
export function parseMapsUrl(url) {
  let u;
  try {
    u = new URL(String(url ?? "").trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!MAPS_HOSTS.has(u.hostname.toLowerCase())) return null;

  const p = u.searchParams;
  const co = parseLatLon(p.get("coordinate") ?? p.get("ll") ?? p.get("sll") ?? "");
  const name = String(
    p.get("name") ?? p.get("q") ?? p.get("address") ?? p.get("daddr") ?? ""
  ).trim();

  // 两样都没有：是地图域名，但看不出指向哪儿（比如就一个 maps.apple.com）
  if (!co && !name) return null;
  return { name, ll: co ? `${co.lat},${co.lon}` : "" };
}

/**
 * 把一段**对方发来的**文字里的苹果地图链接换成 `[location:…]`。
 *
 * 为什么要换：用户在 iMessage 里长按地图放一个大头针分享过来，落到我们这儿
 * 是一条富链接 —— 正文**就是那条网址**（`cardHintFor` 对富链接一律返回空串，
 * 因为模型本来就看得见正文）。可那条网址长这样：
 *
 *   https://maps.apple.com/place?coordinate=22.807250,108.411844&name=%E5%B7%B2%E6%94%BE…
 *
 * 地名整段是 percent 编码的，模型看到的是一串十六进制，既读不出这是个位置，
 * 也读不出在哪儿。换成 `[location:已放置的大头针:22.807250,108.411844]` 之后
 * 它一眼就懂 —— 而且这正是它自己发位置时用的写法，不用另外教。
 *
 * 只换链接本身，前后的话原样留着（「你看我在这儿 <链接> 过来吧」）。
 *
 * @param {string} text 对方那条消息的正文
 * @returns {string} 换过的正文；没有地图链接就原样返回
 */
export function renderMapsLinks(text) {
  const raw = String(text ?? "");
  if (!raw || !/maps\.apple/i.test(raw)) return raw;

  // 网址的结尾：空白、中文全角标点、或者成对括号的右半边
  return raw.replace(/https?:\/\/[^\s<>「」【】()（）]+/gi, (url) => {
    // 末尾的句读不算网址的一部分（「…&span=0.02。」这种）
    const trimmed = url.replace(/[.,;:!?。，；：！？]+$/, "");
    const hit = parseMapsUrl(trimmed);
    if (!hit) return url;
    const tail = url.slice(trimmed.length);
    const name = hit.name || "一个地点";
    return `[location:${name}${hit.ll ? `:${hit.ll}` : ""}]${tail}`;
  });
}
