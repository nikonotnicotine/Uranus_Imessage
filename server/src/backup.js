/**
 * 备份的导出 / 导入。
 *
 * 一份备份 = 一个 JSON 文件，里面是全部用户配置（角色、用户人设、预设、
 * 世界书、服务商源和模型注册表、发送节奏）。**不含对话记录** —— 那是聊天
 * 内容不是配置，而且体积会失控；要连聊天一起备份就直接拷整个 data/ 文件夹。
 *
 * 密钥默认**不导出**。带密钥的备份文件等于一份明文的 key 清单，误发出去
 * 代价太大，所以由用户在界面上显式勾选才带。
 *
 * 注意 `KEYS` 里**没有** `weatherApi`（天气 API 的 Host 和 Key）：`roles` 是
 * 原样拷进备份的，所以天气密钥绝不能存在 `role.env` 里 —— 那会让一份
 * 「不含密钥」的备份漏出密钥。它是全局一份、只走 `secrets` 那条路。
 * `searchApi` / `ttsApi` 同理，都不在 `KEYS` 里。
 *
 * `referenceImages` 在 `KEYS` 里，但那只是**清单**（名称 + 描述）——
 * 图片文件本身在 `data/images/`，不进备份包。换台机器恢复配置后，
 * 图库条目会都在、缩略图显示不出来，把那个文件夹一起拷过去就好了。
 *
 * `memories` 同理，进备份的只是**设置**（三个模型引用、轮数、四段提示词、
 * 字数限制那些）。记忆条目、备忘录、日记正文在 `data/memories/`，不进备份包 ——
 * 那是聊出来的内容不是配置，和对话记录一个道理。要一起带走就拷那个文件夹。
 * 角色身上的 `memories` 只有三个开关，跟着 `roles` 原样拷，没有密钥问题。
 */

const APP = "uranus-imessage";
const KIND = "backup";
const VERSION = 1;

/** 备份里认识的配置键。多出来的字段一律忽略。 */
const KEYS = [
  "providers",
  "chat",
  "roles",
  "users",
  "presets",
  "worldBooks",
  "referenceImages",
  "memories",
];

/**
 * 攒一份备份。
 *
 * @param {object} config 规范化过的配置（loadConfig 的结果）
 * @param {{includeSecrets?: boolean}} opts
 */
export function buildBundle(config, { includeSecrets = false } = {}) {
  const bundle = {
    app: APP,
    kind: KIND,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    includesSecrets: Boolean(includeSecrets),
    config: {
      providers: (config?.providers ?? []).map((p) => ({
        ...p,
        // 不带密钥时抹成等长空串 —— 和 data/config.json 里一样的占位规则，
        // 这样导入方能看出「这个源有几把 key 要自己填」
        keys: includeSecrets ? [...p.keys] : p.keys.map(() => ""),
      })),
      chat: config?.chat ?? {},
      roles: config?.roles ?? [],
      users: config?.users ?? [],
      presets: config?.presets ?? [],
      worldBooks: config?.worldBooks ?? [],
      // 只有清单（名称 + 描述），图片文件在 data/images/ 里，不进备份包
      referenceImages: config?.referenceImages ?? [],
      // 只有设置（模型引用 + 轮数 + 提示词）。记忆条目、备忘录、日记正文
      // 在 data/memories/ 里，不进备份包 —— 那是聊出来的内容不是配置
      memories: config?.memories ?? {},
    },
  };

  if (includeSecrets) {
    const providerKeys = {};
    for (const p of config?.providers ?? []) providerKeys[p.id] = [...p.keys];
    bundle.secrets = {
      providerKeys,
      projects: config?.projects ?? [],
      // 天气密钥也在这里而不在 config 里 —— KEYS 里没有 weatherApi，
      // 所以不含密钥的备份里连这一块的结构都不会出现
      weatherKeys: config?.weatherApi ?? {},
      // 搜索和 TTS 的凭据同理
      searchKeys: config?.searchApi ?? {},
      ttsKeys: config?.ttsApi ?? {},
    };
  } else {
    /*
     * 不带凭据，但**保留项目的 id 和 mode**。
     *
     * id 得留着：角色的 projectRef 指向它，清掉的话导入之后每个角色都变
     * 「未绑定」，用户还得一个个重新挑一遍。凭据字段全部清空。
     */
    bundle.config.projects = (config?.projects ?? []).map((p) => ({
      id: p.id,
      mode: p.mode,
      projectId: "",
      projectSecret: "",
      localPath: "",
      myPhone: "",
      linePhone: "",
    }));
  }

  return bundle;
}

/** 各类多少条，导入前的确认弹窗和接口返回都用这个。 */
export function summarize(bundle) {
  const c = bundle?.config ?? {};
  return {
    providers: Array.isArray(c.providers) ? c.providers.length : 0,
    roles: Array.isArray(c.roles) ? c.roles.length : 0,
    users: Array.isArray(c.users) ? c.users.length : 0,
    presets: Array.isArray(c.presets) ? c.presets.length : 0,
    worldBooks: Array.isArray(c.worldBooks) ? c.worldBooks.length : 0,
    referenceImages: Array.isArray(c.referenceImages) ? c.referenceImages.length : 0,
    includesSecrets: Boolean(bundle?.includesSecrets),
  };
}

/**
 * 备份 + 当前配置 → 要落盘的新配置。
 *
 * 语义是**整体替换**：备份里出现的那几类整体覆盖，没出现的沿用现在的。
 * 恢复备份就该是这个语义 —— 「合并」会留下重名条目，而且角色的预设 /
 * 世界书引用会指到不确定的地方。
 *
 * 凭据的处理分两种：
 *   备份含密钥 → key 和 projects 一起替换
 *   备份不含   → 本地现有的 key 按**服务商 id** 盖回去（对不上的留空），
 *                projects 保持本地现状**完全不动**。所以拿一份没有密钥的
 *                备份恢复配置，不会把 Photon 凭据冲掉、也不会被占位的空串盖掉。
 *
 * @throws {Error} 中文原因。调用方直接 400 出去。
 */
export function applyBundle(bundle, current) {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    throw new Error("这个文件的内容不是一份备份");
  }
  if (bundle.app !== APP || bundle.kind !== KIND) {
    throw new Error("这不是 Uranus iMessage 的备份文件");
  }
  if (Number(bundle.version) > VERSION) {
    throw new Error(
      `这份备份是更新版本（v${bundle.version}）的程序导出的，当前版本读不了，先升级程序`
    );
  }
  if (!bundle.config || typeof bundle.config !== "object") {
    throw new Error("备份里没有 config 这一块，文件可能不完整");
  }

  const next = { ...current };

  for (const key of KEYS) {
    const value = bundle.config[key];
    if (value === undefined) continue; // 备份里没这一类 = 不动本地的
    if (key === "chat") {
      if (value && typeof value === "object") next.chat = value;
      continue;
    }
    if (Array.isArray(value)) next[key] = value;
  }

  if (bundle.includesSecrets && bundle.secrets) {
    const keysById = bundle.secrets.providerKeys ?? {};
    next.providers = (next.providers ?? []).map((p) => {
      const keys = keysById[p.id];
      return Array.isArray(keys) ? { ...p, keys } : p;
    });
    if (Array.isArray(bundle.secrets.projects)) next.projects = bundle.secrets.projects;
    const wk = bundle.secrets.weatherKeys;
    if (wk && typeof wk === "object" && !Array.isArray(wk)) next.weatherApi = wk;
    // 搜索和 TTS 的凭据：老备份里没有这两块，缺了就不动本地的
    const sk = bundle.secrets.searchKeys;
    if (sk && typeof sk === "object" && !Array.isArray(sk)) next.searchApi = sk;
    const tk = bundle.secrets.ttsKeys;
    if (tk && typeof tk === "object" && !Array.isArray(tk)) next.ttsApi = tk;
  } else {
    // 本地的 key 按 id 盖回导入的服务商上；备份里那些空串占位丢掉
    const local = new Map((current?.providers ?? []).map((p) => [p.id, p.keys]));
    next.providers = (next.providers ?? []).map((p) => ({
      ...p,
      keys: local.get(p.id) ?? p.keys,
    }));

    /*
     * projects 不走「整体替换」，而是**本地优先、按 id 补齐**：
     *
     *   本地已有这个 id → 原样保留（里面是 Photon 凭据，备份里只有空占位，
     *                     替换过去等于把凭据冲掉）
     *   本地没有这个 id → 把备份里的空壳加进来（只有 id 和 mode）
     *
     * 后一条是必须的：角色的 projectRef 指向项目 id，而 normalizeRoster 会
     * 把指向不存在项目的引用清成「未绑定」。空壳不补的话，拿一份不含密钥的
     * 备份在新机器上恢复，每个角色都得重新挑一遍号码 —— buildBundle 特意
     * 留着项目 id 就是为了避免这个。凭据字段是空的，用户填上就能用。
     */
    const localProjects = current?.projects ?? [];
    const known = new Set(localProjects.map((p) => p.id));
    const shells = (bundle.config.projects ?? []).filter((p) => p?.id && !known.has(p.id));
    next.projects = [...localProjects, ...shells];
  }

  return next;
}

/** 下载时的文件名。 */
export function bundleFileName(includeSecrets, now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}`;
  return `uranus-backup-${stamp}${includeSecrets ? "-with-keys" : ""}.json`;
}