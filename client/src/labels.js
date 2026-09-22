/**
 * 角色 / 项目的显示规则。
 *
 * 服务端 server/src/config.js 里有一份同样规则的实现（日志用）。
 * 这边不能 import 服务端代码，所以两处各留一份 —— 改规则时记得一起改。
 */

/** 绑定了这个项目的角色（没有就返回 null）。 */
export function roleForProject(config, projectRefId) {
  return (config?.roles ?? []).find((r) => r.projectRef === projectRefId) ?? null;
}

/** 角色在界面上的名字：没起名就叫「未命名角色」。 */
export function roleLabel(role) {
  return role?.name?.trim() || "未命名角色";
}

/**
 * 把 `{{char}}` / `{{user}}` / `{{sep}}` 换成真名，**只为了显示**。
 *
 * 存档里存的是字面量（角色改名后旧存档不失效），真正的替换在服务端
 * `prompt.js` 拼提示词那一刻做。但「上下文」面板是给人看的 —— 那里显示
 * `{{user}}发送当地时间` 只会让人以为变量没生效，所以显示时也替换一遍。
 *
 * 服务端 `server/src/config.js:applyVars` 是同一套规则（含空值的兜底名），
 * 改的时候两处一起改：面板上显示的名字和模型收到的名字对不上，比不替换更糟。
 * **只动显示，不动数据** —— 编辑框里、写回磁盘的都还是字面量。
 */
export function applyVars(text, vars) {
  if (!text) return "";
  return String(text).replace(/\{\{\s*(char|user|sep)\s*\}\}/gi, (_m, name) => {
    const key = name.toLowerCase();
    const value = String(vars?.[key] ?? "").trim();
    if (key === "sep") return value;
    return value || (key === "char" ? "助手" : "用户");
  });
}

/**
 * 项目的显示名。
 * 绑了角色就显示角色名（也就是 {{char}}），没绑就按「未绑定项目里的第几个」
 * 叫 Project1、Project2…
 */
export function projectLabel(config, projectRefId) {
  const role = roleForProject(config, projectRefId);
  if (role) return roleLabel(role);

  const roles = config?.roles ?? [];
  const unbound = (config?.projects ?? []).filter(
    (p) => !roles.some((r) => r.projectRef === p.id)
  );
  const index = unbound.findIndex((p) => p.id === projectRefId);
  return `Project${index < 0 ? 1 : index + 1}`;
}

/** 凭据齐不齐 —— 不齐就连不上，桥接会跳过它。 */
export function projectReady(project) {
  if (!project) return false;
  if (project.mode === "local") return true; // 本地模式不需要凭据
  return Boolean(project.projectId?.trim() && project.projectSecret?.trim());
}

/* ================= 用户人设 ================= */

/** 用户人设的显示名：没起名就叫「未命名用户」。 */
export function userLabel(user) {
  return user?.name?.trim() || "未命名用户";
}

/**
 * 这个角色该用哪条用户人设。
 * 优先级：绑定了这个角色的 > 全局的；同类取排在前面那条（= 界面上的顺序）。
 *
 * 服务端 server/src/config.js:resolveUser 是同一套规则，改的时候两处一起改 ——
 * 界面上说「对这个角色生效的是 X」，真发出去的却是 Y，那比没有这个提示更糟。
 */
export function resolveUser(config, role) {
  const users = (config?.users ?? []).filter((u) => u.enabled);
  if (!users.length || !role) return null;
  return (
    users.find((u) => u.scope === "roles" && (u.roleRefs ?? []).includes(role.id)) ??
    users.find((u) => u.scope === "global") ??
    null
  );
}

/** 生效范围说成人话，给用户卡片显示。 */
export function userScopeText(config, user) {
  if (user?.scope !== "roles") return "全局生效";
  const names = (user.roleRefs ?? [])
    .map((id) => (config?.roles ?? []).find((r) => r.id === id))
    .filter(Boolean)
    .map(roleLabel);
  if (!names.length) return "指定角色（还没勾选）";
  return names.length <= 2 ? `只对 ${names.join("、")}` : `只对 ${names.length} 个角色`;
}

/**
 * 这条用户人设为什么没生效（生效就返回 null）。
 * 只讲能自查的两种：整条被关了、选了「指定角色」但一个都没勾。
 */
export function userBlockReason(config, user) {
  if (!user?.enabled) return "这条人设被关掉了，不会发给模型";
  if (user.scope === "roles" && !(user.roleRefs ?? []).length) {
    return "选了「指定角色」但还没勾任何角色，等于没生效";
  }
  // 全局的那条可能被某个绑了角色的顶掉，这是设计上的优先级，不算问题
  return null;
}

/* ================= 服务商源 / 模型 ================= */

/** 服务商源的显示名：没起名就退回它的 ID。 */
export function providerLabel(provider) {
  return provider?.name?.trim() || provider?.id || "未命名服务商";
}

/** 模型的显示名：有别名用别名，否则用上游模型名。 */
export function modelLabel(entry) {
  return entry?.alias?.trim() || entry?.model || "";
}

/**
 * 分类的中文名。勾了「生图」的模型会被全局挑去出图（角色那边只有开关）。
 *
 * 「向量」是记忆库的语义检索用的（打 /embeddings 而不是 /chat/completions），
 * 在「记忆库 → 设置」里显式选一个，不像生图那样自动挑第一个。
 *
 * 「听音」打的是 Gemini 原生的 generateContent（中转站不透传 OpenAI 那个
 * input_audio 字段），所以只有 Gemini 系的模型挂这个分类才有意义。
 *
 * 「看视频」走的是和听音**完全同一条**原生路径、同一个请求形状，只有 mime
 * 不一样。仍然分成两类是因为「听得到声音」和「吃得下几十 MB 的视频」是两件
 * 事：实测五家中转站里有一家网关连 12MB 的视频都直接 413，而它听语音是好的。
 */
export const CATEGORY_LABELS = {
  chat: "聊天",
  vision: "识图",
  image: "生图",
  embedding: "向量",
  audio: "听音",
  video: "看视频",
};

export const MODEL_CATEGORIES = ["chat", "vision", "image", "embedding", "audio", "video"];

/**
 * 出图比例的档位。`server/src/config.js:IMAGE_RATIOS` 的镜像，加档位两处一起改。
 *
 * 这边只要 key 和显示名 —— 像素值是服务端发请求时才用的，界面上不提它：
 * 用户要挑的是「横的还是竖的」，`1024x576` 这种串对他没有意义，而且真正发出去
 * 的字段还得看上游认哪个（见服务端那张表的注释）。
 */
export const IMAGE_RATIOS = [
  { key: "", label: "不指定（用模型自己的默认尺寸）" },
  { key: "1:1", label: "正方形 1:1" },
  { key: "3:4", label: "竖图 3:4" },
  { key: "4:3", label: "横图 4:3" },
  { key: "9:16", label: "竖屏 9:16" },
  { key: "16:9", label: "宽屏 16:9" },
];

/** 顺着 {provider, modelId} 找到那条模型（找不到返回 null）。 */
export function findModel(config, ref) {
  if (!ref?.provider || !ref?.modelId) return null;
  const provider = (config?.providers ?? []).find((p) => p.id === ref.provider);
  if (!provider) return null;
  return provider.models.find((m) => m.id === ref.modelId) ?? null;
}

/**
 * 把一个模型引用说成人话，顺带告诉调用方它是不是还有效。
 *
 * 引用失效（服务商被删 / 模型被删 / 模型被关掉）时不静默清空 ——
 * 返回 ok:false 让界面标红，改成哪个由用户决定。
 */
export function describeRef(config, ref) {
  if (!ref?.provider || !ref?.modelId) {
    return { ok: false, empty: true, text: "未选择" };
  }
  const provider = (config?.providers ?? []).find((p) => p.id === ref.provider);
  if (!provider) return { ok: false, empty: false, text: "引用的服务商已删除" };
  const entry = provider.models.find((m) => m.id === ref.modelId);
  if (!entry) return { ok: false, empty: false, text: "引用的模型已删除" };
  if (!entry.enabled) {
    return {
      ok: false,
      empty: false,
      text: `${providerLabel(provider)} · ${modelLabel(entry)}（已关闭）`,
    };
  }
  return {
    ok: true,
    empty: false,
    text: `${providerLabel(provider)} · ${modelLabel(entry)}`,
  };
}

/**
 * 某个分类下所有可选的模型，按服务商分组，给下拉用。
 * 只列开着的：关掉的模型不该出现在角色的选项里。
 */
export function modelOptions(config, category) {
  return (config?.providers ?? [])
    .map((p) => ({
      provider: p,
      models: (p.models ?? []).filter(
        (m) => m.enabled && (m.categories ?? []).includes(category)
      ),
    }))
    .filter((g) => g.models.length);
}

/** <select> 的 value 用这个拼，选中时再拆开。 */
export const refValue = (ref) =>
  ref?.provider && ref?.modelId ? `${ref.provider}::${ref.modelId}` : "";

export function parseRefValue(value) {
  const [provider = "", modelId = ""] = String(value ?? "").split("::");
  return { provider, modelId };
}

/** 这个角色能不能上线，不能的话原因是什么（给界面提示用）。 */
export function roleBlockReason(config, role) {
  if (!role?.projectRef) return "还没绑定项目，这个角色不会上线";
  const project = (config?.projects ?? []).find((p) => p.id === role.projectRef);
  if (!project) return "绑定的项目不存在了，请重新绑定";
  if (!projectReady(project)) return "绑定的项目还缺 Project ID / Secret";
  if (project.mode === "cloud" && !project.linePhone?.trim()) {
    return "还没登记手机号，拿到线路号码后才能收发消息";
  }
  return null;
}

/* ================= 预设 ================= */

/** 预设的显示名：没起名就叫「未命名预设」。 */
export function presetLabel(preset) {
  return preset?.name?.trim() || "未命名预设";
}

/**
 * 一份预设是线上的还是线下的。缺字段算线上（老配置原样升级）。
 * 和 server/src/preset.js:PRESET_MODES 对齐。
 */
export const PRESET_MODES = ["online", "offline"];

export const PRESET_MODE_LABELS = {
  online: "线上",
  offline: "线下",
};

/** 一份预设的 mode，容错版（缺字段、写错了都算线上）。 */
export function presetMode(preset) {
  return preset?.mode === "offline" ? "offline" : "online";
}

/** 某一类玩法的预设。和 server/src/preset.js:presetsFor 对齐。 */
export function presetsFor(config, mode = "online") {
  const want = PRESET_MODES.includes(mode) ? mode : "online";
  return (config?.presets ?? []).filter((p) => presetMode(p) === want);
}

/**
 * 这个角色该用哪份预设。
 *
 * 引用失效（预设被删了）时回落到同一类里的第一份；这一类一份都没有时返回
 * null —— 服务端这时会兜底用内置的默认预设（server/src/preset.js:resolvePreset），
 * 但界面上没有可指的对象，所以返回 null 让调用方显示提示。
 *
 * `mode` 决定在哪一批里挑，以及看角色上的哪个引用（`role.presetRef` /
 * `role.offline.presetRef`）。**两批不串** —— 线下挑不到线下预设时不会退回某份
 * 线上预设，那样会把「消息格式与功能」整套带进线下。
 *
 * 服务端 server/src/preset.js:resolvePreset 是同一套规则，改的时候两处一起改。
 */
export function resolvePreset(config, role, mode = "online") {
  const want = PRESET_MODES.includes(mode) ? mode : "online";
  const presets = presetsFor(config, want);
  if (!presets.length) return null;
  const ref = want === "offline" ? role?.offline?.presetRef : role?.presetRef;
  return presets.find((p) => p.id === ref) ?? presets[0];
}

/**
 * 角色的预设引用有没有问题（没问题返回 null）。
 *
 * `mode` 和 `resolvePreset` 一致 —— 线下那一栏要说的是「线下预设」的事，
 * 不能拿线上那批的数量来判断。
 */
export function presetBlockReason(config, role, mode = "online") {
  const want = PRESET_MODES.includes(mode) ? mode : "online";
  const presets = presetsFor(config, want);
  const what = want === "offline" ? "线下预设" : "预设";
  const ref = want === "offline" ? role?.offline?.presetRef : role?.presetRef;
  if (!presets.length) {
    return want === "offline"
      ? "一份线下预设都没有，演剧情时会用内置的默认线下预设"
      : "一份预设都没有，发消息时会用内置的默认预设";
  }
  if (!ref) {
    return `没选${what}，会用第一份「${presetLabel(presets[0])}」`;
  }
  if (!presets.some((p) => p.id === ref)) {
    return `原来选的${what}已被删除，现在会用第一份「${presetLabel(presets[0])}」`;
  }
  return null;
}

/** 固定条目的中文名。和 server/src/preset.js:FIXED_KINDS + OFFLINE_ONLY_KINDS 一一对应。 */
export const ENTRY_KIND_LABELS = {
  char: "Char的人设",
  user: "用户的人设",
  world: "世界书",
  format: "消息格式与功能",
  context: "上下文",
  memory: "记忆库",
  onlineHistory: "线上聊天记录",
  userChoice: "用户选项",
};

/** 固定条目下面那行说明：这一条到底往提示词里塞什么。 */
export const ENTRY_KIND_HINTS = {
  char: "角色提示词，原样注入 <Character>",
  user: "对这个角色生效的那条用户人设，注入 <User>",
  world: "这一轮命中的世界书条目，注入 <World_Info>",
  format:
    "怎么分气泡，以及语音 / 表情包 / 图片 / 链接卡片 / 分享位置 / 转账 / 联网搜索 / 已读不回 / 引用回复 / 消息撤回 / 消息回应 / 消息特效 / Instagram / 查岗那四条 十七个子条目",
  context: "这条会话的上文，夹在 <Chat_History> 之间（条数受角色的「上下文限制」约束）",
  memory:
    "四个变量：{{近N天记忆}}、{{回忆起来的记忆}}、{{备忘录}}、{{近N天日记}}，各自包在 XML 标签里。哪个都受角色那三个开关约束，全关就整条不产出",
  onlineHistory:
    "只有线下预设有这一条。在这个号码上跟该角色聊过的线上消息，换成 {{线上聊天记录}} 那个变量注入 <线上聊天记录>。一条线上记录都没有时整条不产出",
  userChoice:
    "只有线下预设有这一条。要模型在正文之后另给四条「我接下来可以怎么做」，注入 <User_Choices>。还得角色那边的「用户选项」开着才生效",
};

/** 「消息格式与功能」的十七个子条目。和 server/src/preset.js:FORMAT_CHILD_KINDS 对齐。 */
export const FORMAT_CHILD_KINDS = [
  "voice",
  "sticker",
  "image",
  "card",
  "location",
  "transfer",
  "search",
  "leaveOnRead",
  "quote",
  "undoSend",
  "react",
  "effect",
  "instagram",
  // 查岗占四条，对着角色面板上那四摊开关（屏幕 / 查看 / 控制 / 网易云）
  "spyScreen",
  "spyView",
  "spyControl",
  "spyMusic",
];

export const FORMAT_CHILD_LABELS = {
  voice: "语音",
  sticker: "表情包",
  image: "图片",
  card: "链接卡片",
  location: "分享位置",
  search: "联网搜索",
  leaveOnRead: "已读不回",
  quote: "引用回复",
  undoSend: "消息撤回",
  react: "消息回应",
  effect: "消息特效",
  instagram: "Instagram",
  spyScreen: "查岗 · 看屏幕",
  spyView: "查岗 · 看手机",
  spyControl: "查岗 · 动手机",
  spyMusic: "查岗 · 放歌",
};

/**
 * 子条目在提示词里用的标签名。和 server/src/preset.js:FORMAT_CHILD_TAGS 对齐。
 *
 * voice / sticker / image 是英文标签（`<audio_message>` / `<send_emoji>` /
 * `<Generate_Image>`）—— 那几条正文里的示例和格式说明都围着这些名字写，
 * 改了就对不上。
 */
export const FORMAT_CHILD_TAGS = {
  voice: "audio_message",
  sticker: "send_emoji",
  image: "Generate_Image",
  card: "share_card",
  location: "share_location",
  search: "联网搜索",
  leaveOnRead: "leave_on_read",
  quote: "引用回复",
  undoSend: "消息撤回",
  react: "tapback",
  effect: "message_effect",
  instagram: "instagram",
  // 四条各用自己的标签，理由见 server/src/preset.js:FORMAT_CHILD_TAGS
  spyScreen: "看屏幕",
  spyView: "查看手机",
  spyControl: "操控手机",
  spyMusic: "放歌",
};

/**
 * 发送链路还没接的子条目：开了也只是让模型输出标记，标记会被当普通文字
 * 原样发给对方。界面上要标出来，见 panels/preset.jsx。
 *
 * 现在**一条都没有** —— 十七条的链路全接上了。
 * 留着这个数组是因为以后还可能先写提示词、后接链路。
 */
export const FORMAT_CHILD_UNWIRED = [];

/**
 * 还要看角色那个开关才生效的子条目。
 * 和 server/src/preset.js:ROLE_GATED_CHILDREN 对齐，值是角色上的字段名。
 *
 * **quote 故意不在这里**：引用回复是自带的，没有角色开关。
 *
 * **查岗那四条在这里、但服务端那张表里没有**：查岗在角色上是五个组开关
 * （`spy.pcEnabled` / `spy.phoneEnabled` 看屏幕，另外三个管手机里那些事，
 * 见 SPY_SWITCHES）外加十九件事各自一个（SPY_FEATURE_SWITCHES），没有单个
 * `.enabled` 可查，所以服务端由 prompt.js 走 trimSpyPrompt 单独判。前端这张表
 * 只用来判「这一条要不要显示『还得去角色那儿开』的提示」（preset.jsx），
 * 查岗当然要显示，所以留着。
 *
 * 四条的值都写成 `spy`，指的是角色上那个字段块，别拿它当布尔字段名用 ——
 * 四条各自对应块里哪几个开关见 SPY_CHILD_SWITCHES。
 */
export const ROLE_GATED_CHILDREN = {
  search: "webSearch",
  voice: "voiceSend",
  image: "imageGen",
  leaveOnRead: "leaveOnRead",
  sticker: "stickerSend",
  undoSend: "undoSend",
  card: "cardSend",
  location: "locationSend",
  transfer: "transfer",
  react: "reactSend",
  effect: "effectSend",
  instagram: "instagram",
  spyScreen: "spy",
  spyView: "spy",
  spyControl: "spy",
  spyMusic: "spy",
};

/**
 * 查岗那四条子条目各自对着角色面板上哪几个开关。
 *
 * 面板上那句提示要说得准：`spyMusic` 那条该说「去角色那儿打开『放歌』」，
 * 而不是笼统一句「打开查岗」—— 用户开的是五个里的哪一个，这话得对得上。
 * 服务端那份是 spy.js:KIND_LEGS（同一件事的另一半，那边管裁剪）。
 */
export const SPY_CHILD_SWITCHES = {
  spyScreen: ["pcEnabled", "phoneEnabled"],
  spyView: ["phoneViewEnabled"],
  spyControl: ["phoneControlEnabled"],
  spyMusic: ["phoneMusicEnabled"],
};

/**
 * 反过来：角色上那个开关字段 → 该跟着打开的子条目。
 *
 * 用在 role.jsx:turnOn —— 用户在角色面板上打开一条腿，预设里对着它那一条也要
 * 跟着开。从 SPY_CHILD_SWITCHES 现算，别再手写一份：两份反过来的表早晚走岔。
 */
export const SPY_CHILD_OF_FIELD = Object.fromEntries(
  Object.entries(SPY_CHILD_SWITCHES).flatMap(([kind, fields]) =>
    fields.map((field) => [field, kind])
  )
);

/**
 * 查岗那一栏的五个开关：面板上叫什么、下面那行说明写什么。
 *
 * 五个而不是一个，是因为**代价和形态各不一样**，一个总开关说不清用户在同意
 * 什么（服务端字段见 server/src/config.js:normalizeSpy）：
 *
 *   pcEnabled            拉一张电脑截图。用户那头没有任何动静
 *   phoneEnabled         发邮件把 iPhone 唤起来截屏，一趟十几秒
 *   phoneViewEnabled     替用户打开微信 / 支付宝 / 淘宝再截图 —— 比桌面截图私密得多
 *   phoneControlEnabled  真的改变手机状态：设闹钟、把屏幕锁掉
 *   phoneMusicEnabled    放歌。要先去 163 搜一次，而且锁屏状态下也生效
 *
 * `field` 是角色 `spy` 块里那个布尔字段名，面板直接拿它读写（role.jsx）。
 * `tag` 是这个开关放开的标签，摆在说明里给用户看 —— 这几个功能全靠标签驱动，
 * 用户看到标签长什么样才知道自己开的是什么。
 *
 * 顺序就是面板上的顺序：先屏幕、再手机里面，和服务端那张功能表
 * （server/src/spyfeatures.js:FEATURES，查看在前）一个走向。
 */
export const SPY_SWITCHES = [
  {
    field: "pcEnabled",
    label: "电脑查岗",
    tag: "[查岗实时电脑屏幕]",
    hint: "抓一张电脑桌面的截图。走本地截图程序的一个 GET 接口，几百毫秒就回来，你那头没有任何动静。",
  },
  {
    field: "phoneEnabled",
    label: "手机查岗",
    tag: "[查岗实时手机屏幕]",
    hint: "抓一张 iPhone 当前屏幕的截图。这一头是发一封邮件把你手机唤起来、等它把图传回来，一趟十几秒，而且要先在 iPhone 上配好快捷指令。",
  },
  {
    field: "phoneViewEnabled",
    label: "查看手机里的东西",
    tag: "[查岗手机:支付宝账单]",
    hint: "让角色替你打开某个 App 看一眼：微信、支付宝账单、B站历史、抖音私信和主页、淘宝订单和购物车，另外还能问电量和位置。看到的东西比一张桌面截图私密得多 —— 这是这几个开关里外溢最狠的一个。",
  },
  {
    field: "phoneControlEnabled",
    label: "操控手机",
    tag: "[操控手机:锁屏]",
    hint: "让角色真的动你的手机：设闹钟、开关已有的闹钟、锁屏。做完只回一句「已经照做了」，不截图。",
  },
  {
    field: "phoneMusicEnabled",
    label: "让角色放歌",
    tag: "[操控手机:放歌 晴天]",
    hint: "网易云那六件事：每日推荐、私人漫游、红心歌单、播放/暂停、指定歌曲、预设歌单。点歌要先去网易云搜一次；播放/暂停和锁屏一样，锁着屏也生效。",
  },
];

/**
 * 手机里那十九件事，**一件一个开关**：`server/src/spyfeatures.js:FEATURES` 的镜像。
 *
 * 上面那三个手机开关（查看 / 操控 / 网易云）是**组**开关，这张表是组里每一件事
 * 自己那一个。真正可用 = 组开着 **且** 这一项开着（服务端 spy.js:spyLegs）。
 *
 * 为什么要拆到这一层：同一组里各项的外溢程度差得也很远。查看类里「电量」只回
 * 一个数字，「微信」是把聊天列表整屏念出来；控制类里「设置闹钟」是帮忙，
 * 「关闭闹钟」能把用户定好的起床闹钟关掉。一个组开关说不清用户同意了哪几件。
 *
 * 为什么在前端再写一份：这是个纯前端的开关清单，服务端没有「列一下有哪些功能」
 * 的接口，为一张十九行的常量表加一条路由不值得。存的是 **key**，和服务端那张表
 * 对齐 —— 显示名以后改了字，存名字的配置就全对不上了。
 *
 * **服务端那张表加/删/改一项时，这儿要一起改。** 少列一项的后果是用户在界面上
 * 关不掉那一项（服务端「缺键当开」，所以它一直是开着的）；多列一项的后果是他
 * 关掉一个不存在的功能，服务端归一化时把那个键丢掉（config.js:normalizeSpyFeatures）。
 *
 * `hint` 只在需要说明代价或限制时才写 —— 「微信」这种一看就懂的不用废话。
 */
export const SPY_FEATURE_SWITCHES = [
  { key: "wechat", name: "微信", group: "view" },
  { key: "alipay", name: "支付宝账单", group: "view" },
  { key: "bilibili", name: "B站历史", group: "view" },
  { key: "douyinMsg", name: "抖音私信", group: "view" },
  { key: "douyinProfile", name: "抖音个人主页", group: "view" },
  { key: "taobaoOrder", name: "淘宝订单", group: "view" },
  { key: "taobaoCart", name: "淘宝购物车", group: "view" },
  {
    key: "battery",
    name: "电量",
    group: "view",
    hint: "不截图、不走识图模型 —— 快捷指令直接回一个数字，所以这一项不花识图的钱。",
  },
  {
    key: "location",
    name: "位置",
    group: "view",
    hint: "回的是经纬度和地名，同样不走识图模型。",
  },
  { key: "alarmSet", name: "设置闹钟", group: "control", hint: "新建一个闹钟，要给时间。" },
  {
    key: "alarmOn",
    name: "开启闹钟",
    group: "control",
    hint: "只能开你手机上已经有的那个闹钟，不能新建。",
  },
  {
    key: "alarmOff",
    name: "关闭闹钟",
    group: "control",
    hint: "能把你已经定好的闹钟关掉 —— 这一项关着比较稳。",
  },
  { key: "lock", name: "锁屏", group: "control", hint: "直接把你手机屏幕锁掉。" },
  { key: "musicDaily", name: "每日推荐", group: "music" },
  { key: "musicFm", name: "私人漫游", group: "music" },
  { key: "musicFavorite", name: "红心歌单", group: "music" },
  {
    key: "musicPlayPause",
    name: "播放暂停",
    group: "music",
    hint: "系统级的媒体控制，对任何音乐 App 都有效，而且锁着屏也生效。",
  },
  {
    key: "musicSong",
    name: "放歌",
    group: "music",
    hint: "角色报个歌名，服务端先去网易云搜一次拿到歌曲 ID 再放 —— 多一次外部请求。",
  },
  {
    key: "musicPlaylist",
    name: "预设歌单",
    group: "music",
    hint: "只能放你在下面「预设歌单」里填过的那几个，一个都没填时这一项用不了。",
  },
];

/** 三个手机组各自的中文名。和 server/src/spyfeatures.js:GROUP_NAMES 对齐。 */
export const SPY_GROUP_NAMES = { view: "查看", control: "控制", music: "网易云" };

/**
 * 组开关的字段名 → 那一组的 key。哪个组开着就显示哪一组的单项开关。
 *
 * 屏幕那两个开关（pcEnabled / phoneEnabled）**不在这儿** —— 它们底下没有单项，
 * 就是一个「看不看屏幕」而已。
 */
export const SPY_GROUP_OF_FIELD = {
  phoneViewEnabled: "view",
  phoneControlEnabled: "control",
  phoneMusicEnabled: "music",
};

/**
 * 某一组里的单项。面板按组分块渲染（role.jsx:SpyFeatureToggles）。
 */
export function spyFeaturesInGroup(group) {
  return SPY_FEATURE_SWITCHES.filter((f) => f.group === group);
}

/**
 * 这一项开没开。**缺键当开**，和服务端 config.js:normalizeSpyFeatures 同一条
 * 规矩 —— 老配置里压根没有 `features` 这个字段，那些角色的组开关早就打开过了，
 * 升级之后静默关掉几项的话，用户看到的现象是「角色突然不会看我支付宝了」。
 */
export function spyFeatureOn(spy, key) {
  const v = spy?.features?.[key];
  return v === undefined ? true : Boolean(v);
}

/**
 * 这一组里开着几项 / 一共几项。折叠标题上那个「3/9」用它。
 */
export function spyFeatureCount(spy, group) {
  const all = spyFeaturesInGroup(group);
  return { on: all.filter((f) => spyFeatureOn(spy, f.key)).length, total: all.length };
}

/** 角色上那五个查岗开关的字段名。判「有没有开着的」用它。 */
export const SPY_SWITCH_FIELDS = SPY_SWITCHES.map((s) => s.field);

/**
 * 这个角色的查岗开着几个、哪几个。
 *
 * 折叠标题那个徽标和「要不要显示下面那些设置」都问这个 —— 五个开关分散在
 * 面板各处，每处自己数一遍迟早会走岔。
 *
 * @returns {{on:string[], any:boolean}} `on` 是开着的那几个的 label
 */
export function spySwitchesOn(spy) {
  const on = SPY_SWITCHES.filter((s) => Boolean(spy?.[s.field])).map((s) => s.label);
  return { on, any: on.length > 0 };
}

/** 可移动条目能选的身份。 */
export const ENTRY_ROLES = ["system", "user", "assistant"];

export const ENTRY_ROLE_LABELS = {
  system: "系统",
  user: "用户",
  assistant: "助手",
};

export const FIXED_KINDS = ["char", "user", "world", "format", "context", "memory"];

/** 线下预设独有的固定条目。和 server/src/preset.js:OFFLINE_ONLY_KINDS 对齐。 */
export const OFFLINE_ONLY_KINDS = ["onlineHistory", "userChoice"];

/**
 * 线下预设固定条目的默认排列。和 server/src/preset.js:OFFLINE_FIXED_KINDS 对齐。
 *
 * 写成一张写死的表而不是「FIXED_KINDS + OFFLINE_ONLY_KINDS」：两个线下专属条目
 * 不在末尾，各自挨着它该挨的那一条（线上记录进「上下文」前面，用户选项排最后）。
 */
export const OFFLINE_FIXED_KINDS = [
  "char",
  "user",
  "world",
  "onlineHistory",
  "context",
  "memory",
  "userChoice",
];

/**
 * 这一类预设的固定条目清单。和 server/src/preset.js:fixedKindsFor 对齐。
 *
 * 返回的数组只用来判断「这个 kind 是不是固定条目」，先后顺序无所谓 —— 真正的
 * 排列由服务端 defaultEntries 决定。
 */
export function fixedKindsFor(mode) {
  return mode === "offline" ? OFFLINE_FIXED_KINDS : FIXED_KINDS;
}

/** 条目的显示名：固定条目用中文名，可移动条目用用户起的名。 */
export function entryLabel(entry) {
  if (entry?.kind && entry.kind !== "custom") {
    return ENTRY_KIND_LABELS[entry.kind] ?? entry.kind;
  }
  return entry?.name?.trim() || "未命名条目";
}

/* ================= 正则 ================= */

/** 两类规则的中文名。和 server/src/regex.js:selectRules 对齐。 */
export const REGEX_ACTION_LABELS = {
  replace: "替换",
  delete: "删除",
};

/**
 * 一条规则的替换词候选表。
 *
 * 界面上是「一个说法一行」，服务端把空行丢掉（preset.js:normalizeRegexRules）。
 * 旧配置只有单个 replace 串，这里统一成数组，只取真的填了的那几个 ——
 * 界面上两种情况共用一块输入框。
 */
export function regexAlternatives(rule) {
  const list = (Array.isArray(rule?.alternatives) ? rule.alternatives : [])
    .map((s) => String(s ?? "").trim())
    .filter(Boolean);
  if (list.length) return list;
  const one = String(rule?.replace ?? "").trim();
  return one ? [one] : [];
}

/** 正则规则的显示名：没起名就拿 find 顶上。 */
export function regexLabel(rule) {
  const name = rule?.name?.trim();
  if (name) return name;
  const find = rule?.find ?? "";
  return find.length > 24 ? `${find.slice(0, 24)}…` : find || "未命名规则";
}

/** 两类规则的显示角标。删除类不显示替换词，所以单独一个函数。 */
export function regexActionText(rule) {
  const action = rule?.action === "delete" ? "delete" : "replace";
  if (action === "delete") return "删除";
  const alts = regexAlternatives(rule);
  if (!alts.length) return "替换成（空）";
  if (alts.length > 1) return `${alts.length} 个说法里挑一个`;
  // 替换词可能是一整段 HTML（酒馆转过来的状态栏规则就是这个块头），角标里
  // 放不下会把整行撑到卡片外面去。截个意思，全文点编辑看。
  const one = alts[0];
  const flat = one.replace(/\s+/g, " ").trim();
  return flat.length > 24 ? `换成「${flat.slice(0, 24)}…」` : `换成「${flat}」`;
}

/** 这条规则作用在哪几路文本，说成人话。 */
export function regexScopeText(rule) {
  const out = [];
  if (rule?.targets?.includes("userInput")) out.push("对方的消息");
  if (rule?.targets?.includes("aiOutput")) {
    const where = [];
    if (rule.toUser) where.push("发出去的");
    if (rule.toHistory) where.push("发给模型的上文");
    out.push(where.length ? `AI 回复（${where.join(" + ")}）` : "AI 回复（哪份都没勾）");
  }
  return out.length ? out.join("、") : "没勾任何作用范围";
}

/** 这条规则为什么不起作用（起作用就返回 null）。 */
export function regexBlockReason(rule) {
  if (!rule?.enabled) return "这条规则被关掉了";
  if (!rule.find?.trim()) return "还没填「查找」，这条不会执行";
  if (!rule.targets?.length) return "没勾作用范围，这条不会执行";
  if (rule.targets.length === 1 && rule.targets[0] === "aiOutput" && !rule.toUser && !rule.toHistory) {
    return "勾了 AI 回复但两份都没选，等于什么都不改";
  }
  try {
    new RegExp(rule.find, rule.flags ?? "");
  } catch (e) {
    return `正则写得不对：${e.message}`;
  }
  return null;
}

/* ================= 世界书 ================= */

/** 世界书的显示名。 */
export function worldBookLabel(book) {
  return book?.name?.trim() || "未命名世界书";
}

/** 世界书条目的显示名：没起名就拿第一个关键词顶上。 */
export function worldEntryLabel(entry) {
  return entry?.name?.trim() || entry?.keys?.[0] || "未命名条目";
}

/**
 * 这个角色这轮会用哪几本世界书：global 的 ∪ 它自己引用的，两边都要 enabled。
 *
 * 服务端 server/src/worldinfo.js:worldBooksFor 是同一套规则，两处一起改。
 */
export function worldBooksFor(config, role) {
  const books = config?.worldBooks ?? [];
  const refs = new Set(role?.worldBookRefs ?? []);
  return books.filter((b) => b?.enabled && (b.global || refs.has(b.id)));
}

/**
 * 谁在用这本书。**三路各存各的字段，一路都不能漏。**
 *
 *  - 线上：`role.worldBookRefs`
 *  - 线下：`role.offline.worldBookRefs` —— 剧情走的是**另一份书单**
 *    （server/src/prompt.js:743 换掉的就是这个字段），线上勾了线下不算数，
 *    反过来也一样
 *  - 日记：`memories.diary.worldBookRefs`，**只在「不跟角色走」时才数**
 *    （`useRoleWorldBooks === false`，见 server/src/memory.js:698）。跟角色走的
 *    时候日记用的就是角色那两路，在这儿再数一遍等于把同一件事算两遍
 *
 * 这个函数存在的理由就是「别只查线上那一路」：以前 worldBookBlockReason 只扫
 * `role.worldBookRefs`，于是一本只挂在线下（或只给日记挑的）书会被一直判成
 * 「还没有角色用它」—— 明明在剧情里生效着。预设那边踩过同一个坑并修掉了
 * （见 panels/preset.jsx:130 的注释），世界书这边当时没跟上。
 *
 * global 的书对谁都生效、压根不用挂，所以调用方只在非 global 时才问它。
 */
export function worldBookUsage(config, bookId) {
  const roles = config?.roles ?? [];
  const has = (refs) => (Array.isArray(refs) ? refs : []).includes(bookId);
  const diary = config?.memories?.diary ?? {};
  return {
    online: roles.filter((r) => has(r?.worldBookRefs)),
    offline: roles.filter((r) => has(r?.offline?.worldBookRefs)),
    diary: diary.useRoleWorldBooks === false && has(diary.worldBookRefs),
  };
}

/** 这本书为什么没生效（生效就返回 null）。 */
export function worldBookBlockReason(config, book) {
  if (!book?.enabled) return "这本世界书被关掉了，谁都不会用它";
  if (!(book.entries ?? []).length) return "还没有任何条目，等于没生效";
  if (!(book.entries ?? []).some((e) => e.enabled)) return "所有条目都被关掉了";
  if (!book.global) {
    // 三路里有任意一路挂着就算生效 —— 只查线上那一路是这条提示以前的老毛病
    const use = worldBookUsage(config, book.id);
    if (!use.online.length && !use.offline.length && !use.diary) {
      return "还没有角色用它（去角色的「单独配置」或「线下模式」里挂上，或打开「全局」）";
    }
  }
  return null;
}

/**
 * 「谁在用它」说成一句话，没人用返回空串。
 *
 * 判断和上面同一个来源，所以不会出现「提示说没人用、这句又列出几个角色」。
 * 分开写线上 / 线下是因为两者是两份独立的书单，用户最需要看清的恰恰是
 * 「我勾的是哪一边」—— 在 VPS 上远程改配置时尤其如此。
 */
export function worldBookUsageText(config, book) {
  if (book?.global) return "全局生效：所有角色都在用它。";
  const use = worldBookUsage(config, book?.id);
  const parts = [];
  if (use.online.length) parts.push(`线上：${use.online.map(roleLabel).join("、")}`);
  if (use.offline.length) parts.push(`线下：${use.offline.map(roleLabel).join("、")}`);
  if (use.diary) parts.push("日记（在记忆库里单独挑的）");
  return parts.length ? `在用它的：${parts.join("；")}。` : "";
}

/** 这个条目为什么不会被触发（会触发就返回 null）。 */
export function worldEntryBlockReason(entry) {
  if (!entry?.enabled) return "这条被关掉了";
  if (!entry.constant && !(entry.keys ?? []).length) {
    return "既不是常驻、又没填关键词，永远不会触发";
  }
  if (!entry.content?.trim()) return "内容是空的，触发了也没东西可插";
  return null;
}

/** 插入位置的中文名。 */
export const POSITION_LABELS = {
  before: "槽位前",
  after: "槽位后",
  depth: "按深度插入上下文",
};

export const POSITIONS = ["before", "after", "depth"];

/** 条目的触发方式，说成人话。 */
export function worldEntryTriggerText(entry) {
  if (entry?.constant) return "常驻";
  const keys = entry?.keys ?? [];
  if (!keys.length) return "没有关键词";
  const head = keys.slice(0, 3).join("、");
  const more = keys.length > 3 ? ` 等 ${keys.length} 个` : "";
  const second = (entry.secondaryKeys ?? []).length ? " + 次要关键词" : "";
  return `${head}${more}${second}`;
}