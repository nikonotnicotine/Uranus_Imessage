import {
  AtSign,
  BookOpen,
  Brain,
  Image as ImageIcon,
  Images,
  Instagram,
  ListTree,
  MessageSquareText,
  MessagesSquare,
  Server,
  Settings2,
  SlidersHorizontal,
  Smartphone,
  Smile,
  Terminal,
  UserRound,
  Users,
} from "lucide-react";
import {
  presetLabel,
  projectLabel,
  providerLabel,
  roleLabel,
  userLabel,
  worldBookLabel,
} from "./labels.js";

/**
 * 十三个分区的定义，外壳的两层侧边栏都从这里读。
 *
 * 60px 导航轨画 `icon` + `label`，260px 面板画 `items(config)` 或 `anchors`。
 * 分成两种是因为「有条目」和「没条目」的分区本质不同：
 *
 *  - `items`：这个分区管着一批东西（角色、预设、会话…），260px 那栏就是它们的
 *    列表，选中哪个由外壳持有 —— 面板自己再存一份 openId 会和侧栏高亮打架。
 *  - `anchors`：发送节奏 / 控制台这类只有一屏表单的分区，没有「条目」可选，
 *    那栏改成章节锚点，点一下滚到主内容区对应的 H2（靠 Card 的 data-anchor 找）。
 *
 * 上下文是第三种情况：它有列表，但列表是 `/api/sessions` 拉的、不在 config 里，
 * 所以这里不给 `items`，由面板通过 `useSection().publish()` 上报（`live: true`）。
 *
 * 图库是第四种：一个分区里并列两组条目（参考图 / 表情包），用 `groups` 给出。
 * 有 `groups` 的分区不看 `items` / `group` / `add` / `empty` —— 那几样改成每组各一份。
 *
 * 字段：
 *  - `desc`    没选条目时显示在 72px 标题下面的一句话（分区概览）
 *  - `group`   260px 面板的分组标签
 *  - `itemIcon` 列表项左边那个 16px 图标
 *  - `add`     useConfig 里那个新增方法的名字，有它才画「+」
 *  - `empty`   一条都没有时那栏显示什么
 *  - `groups`  `(config, live) => [{ key, label, itemIcon?, add?, addLabel?, empty, items }]`
 */
export const NAV = [
  {
    id: "api",
    label: "连接",
    icon: Settings2,
    itemIcon: Server,
    group: "服务商源",
    desc: "一个源填一次地址和密钥，模型加进来之后由各个角色自己挑。换一次密钥，所有用它的角色一起生效。",
    add: "addProvider",
    addLabel: "新增服务商源",
    empty: "还没有服务商源。",
    items: (c) =>
      (c.providers ?? []).map((p) => ({
        id: p.id,
        label: providerLabel(p),
        meta: String((p.models ?? []).length),
      })),
  },
  {
    id: "role",
    label: "角色",
    icon: Users,
    itemIcon: Users,
    group: "角色",
    desc: "AI 演谁。人设、单独配置（模型 / 上下文限制 / 预设 / 世界书）和绑定的号码都在一个角色里。",
    add: "addRole",
    addLabel: "新增角色",
    empty: "还没有角色。",
    items: (c) =>
      (c.roles ?? []).map((r) => ({
        id: r.id,
        label: roleLabel(r),
        meta: String(r.maxContext ?? 20),
      })),
  },
  {
    id: "user",
    label: "用户",
    icon: UserRound,
    itemIcon: UserRound,
    group: "用户人设",
    desc: "和 AI 说话的人是谁。可以建多条，一条全局、其余绑给特定角色；一个角色同时命中多条时，绑定它的那条优先。",
    add: "addUser",
    addLabel: "新增用户人设",
    empty: "还没有用户人设。",
    items: (c) =>
      (c.users ?? []).map((u) => ({
        id: u.id,
        label: userLabel(u),
        meta: u.scope === "global" ? "全局" : String((u.roleRefs ?? []).length),
      })),
  },
  {
    id: "preset",
    label: "预设",
    icon: SlidersHorizontal,
    itemIcon: SlidersHorizontal,
    group: "预设",
    desc: "一份预设 = 提示词怎么拼 + 生成参数怎么给 + 正则怎么改写。每个角色各选一份，没选就用排在第一份的那个。",
    add: "addPreset",
    addLabel: "新增预设",
    empty: "还没有预设。一份都没有时会用内置的默认预设发消息 —— 能跑，但改不了。",
    items: (c) =>
      (c.presets ?? []).map((p) => ({
        id: p.id,
        label: presetLabel(p),
        // 线上的显示「开着几条/共几条」，线下的直接标「线下」—— 260px 那栏塞不下
        // 两样，而「这是哪一边的」比条目数更要紧（选错边等于这份预设压根不生效）
        meta:
          p.mode === "offline"
            ? "线下"
            : `${(p.entries ?? []).filter((e) => e.enabled).length}/${(p.entries ?? []).length}`,
      })),
  },
  {
    id: "world",
    label: "世界书",
    icon: BookOpen,
    itemIcon: BookOpen,
    group: "世界书",
    desc: "一堆设定条目。常驻的每轮都发，其余的靠关键词触发 —— 对方提到了才把那段设定塞进提示词。",
    add: "addWorldBook",
    addLabel: "新增世界书",
    empty: "还没有世界书。",
    items: (c) =>
      (c.worldBooks ?? []).map((b) => ({
        id: b.id,
        label: worldBookLabel(b),
        meta: String((b.entries ?? []).length),
      })),
  },
  {
    id: "gallery",
    label: "图库",
    icon: Images,
    itemIcon: ImageIcon,
    group: "图库",
    desc: "两种图片，都放在数据目录的 images 文件夹里：参考图给图生图当底子（images/参考图/），表情包按情绪分文件夹（images/emojis/），角色能把整张图直接发出去。",
    /*
     * 表情包那一组在 config 里**一个字段都不占** —— 一个标签就是 images/emojis/ 下的
     * 一个文件夹，得后端 readdir 才知道有哪些，所以由 GalleryPanel 通过 publish() 上报。
     * 有图的标签默认全都注入给模型，只被角色自己的黑名单减一遍。
     */
    live: true,
    groups: (c, live) => [
      {
        key: "ref",
        label: "参考图",
        itemIcon: ImageIcon,
        add: "addReferenceImage",
        addLabel: "新增参考图",
        empty: "还没有参考图。",
        items: (c.referenceImages ?? []).map((r) => ({
          id: r.id,
          label: r.name?.trim() || "未命名",
          // 描述是给模型看的，没有它模型不知道什么时候该用这张图
          meta: r.description?.trim() ? "✓" : "—",
        })),
      },
      {
        key: "emoji",
        label: "表情包",
        itemIcon: Smile,
        // 没有「+」：标签是文件夹，建它得先落到硬盘上。面板里那个「新建标签」
        // 是直接打后端接口 mkdir，不走 config，所以不能挂在这个侧栏的 add 上
        empty: "images/emojis/ 里还没有文件夹。去图库面板里建一个，就是一个表情包标签。",
        items: live ?? [],
      },
    ],
  },
  {
    id: "context",
    label: "上下文",
    icon: ListTree,
    itemIcon: MessageSquareText,
    group: "全部会话",
    desc: "和模型的对话记录，按会话存档在本地。会话 ID = 角色名 + 对方号码，角色改名会算出新 ID，等于开一段新会话。",
    // 列表来自 /api/sessions，不在 config 里 —— 由 ContextPanel 上报
    live: true,
    empty: "还没有对话记录。等某个角色收到第一条消息，存档就会出现在这儿。",
  },
  {
    id: "offline",
    label: "对话框",
    icon: MessagesSquare,
    itemIcon: Users,
    group: "角色",
    /*
     * 列表来自 `/api/offline`（开没开、当前剧情、演了多少轮），不在 config 里 ——
     * 剧情正文存在 data/offline/ 下自己那套文件里，走 config 的话每演一轮
     * 都会把所有 iMessage 号码重启一次。所以由 OfflinePanel 上报（`live: true`）。
     */
    live: true,
    desc: "线下剧情：坐下来演一段，不是发短信。开着的时候这个角色的线上功能全部停用（主动消息、消息格式与功能都不生效）。开关和总结节奏在「角色 → 线下模式」，这里是剧情本身。",
    empty: "还没有角色。线下剧情是按角色分的，先去「角色」里建一个。",
  },
  {
    id: "memories",
    label: "记忆库",
    icon: Brain,
    itemIcon: Users,
    group: "角色",
    // 没有 add：记忆库跟着角色走，不能单独新建一份
    desc: "每个角色三样长期记忆：记忆（向量检索）、备忘录（一份不断覆盖的清单）、日记（第一人称、永不清空）。开关在「角色 → 单独配置 → 记忆库」，这里是内容和设置。",
    empty: "还没有角色。记忆库是按角色分的，先去「角色」里建一个。",
    items: (c) =>
      (c.roles ?? []).map((r) => {
        const g = r.memories ?? {};
        const on = [g.memory?.enabled, g.memo?.enabled, g.diary?.enabled].filter(Boolean).length;
        return {
          id: r.id,
          label: roleLabel(r),
          // 三道闸开了几道 —— 全关的角色在这栏里一眼能看出来
          meta: `${on}/3`,
        };
      }),
  },
  {
    id: "instagram",
    label: "Instagram",
    icon: Instagram,
    /*
     * IG **界面**不在这儿 —— 它单开在 6873 端口（instagram.html）。这个分区
     * 管的是设置和上帝视角那一摊：改谁的主页、替角色发帖、管精选、调提示词。
     * 用户定的：「所有 IG 的设置都放到 Uranus 里，不在 IG 里设置了」。
     */
    desc: "角色和你自己的 Instagram。看和玩在单独那个端口的页面上，设置和替角色发东西都在这儿。开关在「角色 → 单独配置 → Instagram」，默认关。",
    groups: (c) => [
      {
        key: "settings",
        label: "总设置",
        itemIcon: SlidersHorizontal,
        empty: "",
        items: [
          { id: "settings", label: "全局" },
          { id: "prompts", label: "提示词" },
          // 真 IG 那一摊：绑账号、图床、轮询节奏、可互动白名单
          { id: "real", label: "真实账号" },
        ],
      },
      {
        key: "owners",
        label: "主页",
        itemIcon: UserRound,
        /*
         * 列的是 owner：你自己永远第一个，后面是**开了 IG 的**角色。
         * 没开的不列 —— 那些角色压根没注册这个 App，列出来只会让人以为
         * 点进去能看到东西。
         */
        empty: "还没有角色开 Instagram。",
        items: [
          { id: "user", label: "你" },
          ...(c.roles ?? [])
            .filter((r) => r.instagram?.enabled)
            .map((r) => ({ id: r.id, label: roleLabel(r) })),
        ],
      },
    ],
  },
  {
    id: "chat",
    label: "发送",
    icon: MessageSquareText,
    desc: "所有角色共用的收发节奏：气泡怎么拆、连发怎么合并、两条之间等多久。还有防相亲 —— 开着的时候系统不出声。",
    anchors: ["发送节奏", "防相亲", "预览"],
  },
  {
    id: "imessage",
    label: "iMessage",
    icon: AtSign,
    itemIcon: Smartphone,
    group: "项目",
    desc: "一个 Photon 项目 = 一条 iMessage 号码。绑定了角色又填齐凭据的会同时在线，各自用自己的人设和记忆回复。",
    add: "addProject",
    addLabel: "新建项目",
    empty: "还没有项目。",
    items: (c) =>
      (c.projects ?? []).map((p) => ({
        id: p.id,
        label: projectLabel(c, p.id),
        // 号码整条塞不进 260px，取后四位 —— 认哪条号码够了
        meta: p.linePhone ? `··${p.linePhone.slice(-4)}` : "—",
      })),
  },
  {
    id: "console",
    label: "控制台",
    icon: Terminal,
    desc: "后端实时日志：收到什么消息、打给哪条 API、图片识别成什么、哪里报错。下面是进控制台用的账号密码、出网代理、服务控制（重启、定时重启、清理缓存、定时清缓存）、把整个数据文件夹导出成一个包的备份 / 恢复，以及把数据打包传到缤纷云或 GitHub 的云备份。",
    anchors: ["运行控制台", "账号", "代理", "服务控制", "备份 / 恢复", "云备份"],
  },
];

/** 按 id 取一个分区。找不到返回第一个，不返回 undefined —— 外壳不该出现空分区。 */
export function sectionById(id) {
  return NAV.find((n) => n.id === id) ?? NAV[0];
}

/**
 * 把一个分区摊成 260px 那栏要画的几组条目。
 *
 * 大多数分区只有一组（就是 `group` + `items`/`live` 那套），图库有两组。
 * 统一成数组之后，外壳只剩一条渲染路径，不用到处判断「这个分区有没有 groups」。
 *
 * `live` 是面板通过 useSection().publish() 上报的那份列表，只有 `live: true`
 * 的分区用得上 —— 图库把它当成表情包那一组的内容。
 */
export function sectionGroups(section, config, live) {
  if (section.groups) return section.groups(config, live);
  return [
    {
      key: section.id,
      label: section.group,
      itemIcon: section.itemIcon,
      add: section.add,
      addLabel: section.addLabel,
      empty: section.empty,
      items: section.live ? live ?? [] : section.items ? section.items(config) : [],
    },
  ];
}