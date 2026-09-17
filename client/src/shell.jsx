/*
 * 外壳：60px 导航轨 + 260px 条目面板 + 主内容区，以及顶部错误条。
 *
 * 手机上（<768px）三层全变：导航轨和条目面板都收起来，各自从顶栏的按钮点开成
 * 覆盖层，主内容区独占整个宽度。桌面端一个像素都没动 —— 所有变化都在 `md:`
 * 断点以下，`md:` 以上的类名和原来逐字一致。
 *
 * 为什么不是「只把 260px 那栏收起来」：那栏本来就已经收着了（`hidden md:block`），
 * 375px 的屏上真正被吃掉的是**别的三样** —— 常驻的 60px 导航轨、被压成 0 宽
 * 竖排的标题（flex 里 `min-w-0` 撞上右边 `shrink-0` 的按钮组）、以及左右各
 * 24px 的内容区留白。少了任何一样，剩下的还是挤。
 */

import { useCallback, useEffect, useMemo, useRef, useState, Fragment } from "react";
import { NAV, sectionById, sectionGroups } from "./nav.js";
import { ProviderPanel } from "./panels/api.jsx";
import { AssistantBubble } from "./panels/assistant.jsx";
import { ChatPanel, ChatPreview, PrivacyPanel } from "./panels/chat.jsx";
import { CommandsButton } from "./panels/commands.jsx";
import {
  AccountPanel,
  BackupPanel,
  CloudBackupPanel,
  ConsolePanel,
  ServicePanel,
} from "./panels/console.jsx";
import { ContextPanel } from "./panels/context.jsx";
import { GalleryPanel } from "./panels/gallery.jsx";
import { ImessagePanel, useBridgeStatus } from "./panels/imessage.jsx";
import { InstagramPanel } from "./panels/instagram.jsx";
import { MemoriesPanel } from "./panels/memories.jsx";
import { OfflinePanel } from "./panels/offline.jsx";
import { PresetPanel } from "./panels/preset.jsx";
import { ProxyPanel } from "./panels/proxy.jsx";
import { RolePanel } from "./panels/role.jsx";
import { SetupButton, SetupWizard, useAutoOpenSetup } from "./panels/setup.jsx";
import { GlobalSearch } from "./search.jsx";
import { UserPanel } from "./panels/user.jsx";
import { WallpaperButton, useWallpaper } from "./panels/wallpaper.jsx";
import { WorldPanel } from "./panels/world.jsx";
import { GlobalSaveBar, SaveHintCtx, SectionCtx } from "./section.jsx";
import { useConfig, useLogs } from "./store.jsx";
import { GroupLabel, ListItem, Modal, Reveal, UranusBadge, fmtStamp } from "./ui.jsx";

/**
 * 搜索栏跳到某个章节时，最多等这么多帧让那一节渲染出来（60fps 下约半秒）。
 * 只有换分区那一下用得上；同一个分区里点侧栏锚点是当场就找得着的。
 */
const ANCHOR_TRIES = 30;
import { List, Menu, Plus, X } from "lucide-react";

/**
 * 60px 导航轨里的一格。
 *
 * 只有 20px 图标，没有底色（硬规则：导航轨「仅 20px 纯色 SVG 图标」）——
 * 激活态靠字色从 #787878 转到 #18181b 加左边一条 2px 竖线表示，
 * 不刷色块。文字标签放 title 和 aria-label 里，鼠标停一下就能看到。
 */
export function RailButton({ icon: Icon, label, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={`relative flex h-11 w-full items-center justify-center transition-colors duration-150 ${
        active ? "text-ink" : "text-ink-faint hover:text-ink"
      }`}
    >
      {active && <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 bg-ink" />}
      <Icon size={20} strokeWidth={1.75} />
    </button>
  );
}

/**
 * 顶部错误条只报这么新的错误（毫秒）。
 *
 * 刷新页面时 SSE 会补发最近 300 条历史，所以必须有个新鲜度门槛 ——
 * 否则一条早上留下的错误会在每次刷新后重新弹到屏幕顶上。
 * 5 分钟：够你从别的面板切回来还能看见，又不至于隔天还挂着。
 */
export const ERROR_BANNER_MAX_AGE = 5 * 60 * 1000;

/**
 * 顶部的全局错误条。
 *
 * 出了事不该只有控制台知道 —— 后端所有 logError 都会走日志流过来，
 * 这里挑最后一条显示，附「去控制台」看详情。关掉之后要等新的错误才会再弹，
 * 所以记的是「关到了第几条」而不是一个布尔量。
 *
 * 只报 ERROR_BANNER_MAX_AGE 以内的：SSE 在刷新页面时会补发历史日志，
 * 不判新鲜度的话旧错误每次刷新都会重新弹一遍。
 */
export function ErrorBanner({ onGoto }) {
  const { logs } = useLogs();
  const [dismissedId, setDismissedId] = useState(0);
  // 靠这个定时器让条子自己过期。日志流安静下来时 logs 不再变，
  // 只盯 logs 的话一条几十分钟前的错误会一直挂在屏幕顶上
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 20000);
    return () => clearInterval(timer);
  }, []);

  const last = useMemo(() => {
    for (let i = logs.length - 1; i >= 0; i -= 1) {
      const entry = logs[i];
      if (entry?.level !== "error") continue;
      /*
       * 刷新页面时 SSE 会把最近 300 条历史补发一遍（见 index.js 的
       * /api/logs/stream），所以这里必须自己判断新鲜度 —— 否则半小时前
       * 那条、甚至早就删掉的项目留下的那条，会在每次刷新后重新弹出来。
       * 过期的错误留在控制台里就够了，头上这条只报「刚刚发生的事」。
       */
      const age = now - Date.parse(entry.ts);
      if (Number.isFinite(age) && age > ERROR_BANNER_MAX_AGE) return null;
      return entry;
    }
    return null;
  }, [logs, now]);

  if (!last || (last.id ?? 0) <= dismissedId) return null;

  return (
    <div className="flex items-start gap-3 border-l-2 border-warn py-2 pl-3">
      <div className="min-w-0 flex-1">
        <p className="text-ui leading-snug text-warn">
          {last.scope ? `${last.scope} · ` : ""}
          {last.message}
        </p>
        <p className="mt-0.5 text-meta text-ink-faint">
          {fmtStamp(last.ts)}
          {last.detail ? ` · ${String(last.detail).split("\n")[0].slice(0, 120)}` : ""}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => onGoto?.("console")}
          className="link-slide text-meta text-warn"
        >
          去控制台
        </button>
        <button
          type="button"
          onClick={() => setDismissedId(last.id ?? 0)}
          aria-label="关掉这条提示"
          className="shrink-0 text-ink-meta transition-colors duration-150 hover:text-ink"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

/**
 * 260px 条目面板的内容。桌面端常驻，移动端从导航轨点开后覆盖上来。
 *
 * 两条渲染路径：章节锚点（发送节奏 / 控制台这种只有一屏表单的分区），
 * 和条目列表。列表统一走 nav.js:sectionGroups 摊出来的分组数组 ——
 * 大多数分区只有一组，图库有两组（参考图 / 表情包）。
 */
export function SectionList({ section, groups, itemId, onPick, onAnchor }) {
  const store = useConfig();

  // 章节锚点：没有条目可选的分区（发送节奏 / 控制台）
  if (section.anchors) {
    return (
      <>
        <GroupLabel>本页章节</GroupLabel>
        <div className="grid grid-cols-1 gap-2 px-2 pb-4">
          {section.anchors.map((a) => (
            <ListItem key={a} label={a} onClick={() => onAnchor(a)} />
          ))}
        </div>
      </>
    );
  }

  return (
    <>
      {groups.map((g) => {
        // 新增按钮直接从 store 上按名字取方法 —— nav.js 是纯数据，不该 import store
        const add = g.add ? store[g.add] : null;
        const Icon = g.itemIcon;
        return (
          <Fragment key={g.key}>
            <GroupLabel
              action={
                add ? (
                  <button
                    type="button"
                    onClick={() => onPick(add())}
                    aria-label={g.addLabel ?? "新增"}
                    title={g.addLabel ?? "新增"}
                    className="shrink-0 rounded-item p-1 text-ink-faint transition-colors duration-150 hover:bg-sunken hover:text-ink"
                  >
                    <Plus size={14} />
                  </button>
                ) : null
              }
            >
              {g.label}
              {g.items.length ? ` · ${g.items.length}` : ""}
            </GroupLabel>

            <div className="grid grid-cols-1 gap-2 px-2 pb-4">
              {g.items.length === 0 && (
                <p className="px-2 py-3 text-meta leading-relaxed text-ink-meta">{g.empty}</p>
              )}
              {g.items.map((it) => (
                <ListItem
                  key={it.id}
                  icon={Icon}
                  label={it.label}
                  meta={it.meta}
                  title={it.title ?? it.label}
                  active={it.id === itemId}
                  onClick={() => onPick(it.id)}
                />
              ))}
            </div>
          </Fragment>
        );
      })}
    </>
  );
}

export function AppShell() {
  const { config, loadError } = useConfig();
  const [tab, setTab] = useState("role");
  // 每个分区各记一个选中条目 —— 切走再切回来应该还停在原处
  const [picked, setPicked] = useState({});
  // 上下文分区的列表是 /api/sessions 拉的，由面板上报
  const [live, setLive] = useState([]);
  // 各面板注册的保存提示，显示在全局保存条上
  const [hint, setHint] = useState("");
  // 移动端：260px 那栏平时收着，从顶栏的「列表」键点开
  const [drawer, setDrawer] = useState(false);
  // 移动端：60px 导航轨也收着，从顶栏的汉堡键点开（桌面端常驻，这个值用不上）
  const [rail, setRail] = useState(false);
  // 只轮询一次，角色面板 / iMessage 面板共用这一份
  const bridge = useBridgeStatus();
  // 壁纸只该有一份状态 —— 这个 hook 会往 <html> 上写 CSS 变量，调两次会互相盖
  const wallpaper = useWallpaper();
  const mainRef = useRef(null);

  const section = sectionById(tab);

  // 两个抽屉开着时按 ESC 关掉（和 Modal 一个手感）
  useEffect(() => {
    if (!drawer && !rail) return;
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      setDrawer(false);
      setRail(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawer, rail]);

  const goto = useCallback((id) => {
    setTab(id);
    setDrawer(false);
    setRail(false);
    /*
     * 上报的列表清空：现在有两个分区会 publish（上下文 / 图库），
     * 不清的话切过去的那一瞬间，260px 那栏画的是上一个分区留下的条目。
     * 新面板自己拉完数据会立刻再 publish 一次。
     */
    setLive([]);
    // 换分区时主内容区回到顶部，否则新分区一进来就停在半空
    if (mainRef.current) mainRef.current.scrollTop = 0;
  }, []);

  const pick = useCallback(
    (id) => {
      setPicked((p) => ({ ...p, [tab]: id ?? "" }));
      setDrawer(false);
      setRail(false);
      if (mainRef.current) mainRef.current.scrollTop = 0;
    },
    [tab],
  );

  /**
   * 章节锚点：滚到主内容区里 title 对得上的那个 Card。
   * @returns {boolean} 那一节在不在（不在就是还没渲染出来，gotoItem 要靠它重试）
   */
  const anchorTo = useCallback((name) => {
    const box = mainRef.current;
    const el = box?.querySelector(`[data-anchor="${CSS.escape(name)}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
    setDrawer(false);
    setRail(false);
    return Boolean(el);
  }, []);

  /**
   * 一步跳到「某个分区的某一条」，搜索栏用的。
   *
   * **不能复用上面那个 `pick`** —— 它闭包里绑的是当前的 `tab`
   * （`setPicked((p) => ({ ...p, [tab]: id }))`），而这里 setTab 之后同一轮里
   * `tab` 还是旧值，选中态会写到上一个分区的键上：搜一个角色名，结果是「预设」
   * 那一栏里某条被选中了。所以显式按 sectionId 写。
   *
   * anchor 要等新分区渲染完才滚得到。**一个 requestAnimationFrame 不够** ——
   * 换分区换的是另一棵组件树，React 提交、面板挂载、Reveal 的入场各占掉一帧，
   * 下一帧去 querySelector 还是空的（实测：搜「服务控制」跳过去，那一节确实
   * 在页面上，但 main 的 scrollTop 还是 0，因为滚的那一刻它还没挂上来）。
   * 所以隔帧重试到找着为止，最多 ANCHOR_TRIES 帧（半秒左右）就收手 ——
   * 收手的后果只是停在分区顶部，不会出错。
   */
  const gotoItem = useCallback(
    (sectionId, itemId, anchor) => {
      goto(sectionId);
      if (itemId) setPicked((p) => ({ ...p, [sectionId]: itemId }));
      if (!anchor) return;
      let left = ANCHOR_TRIES;
      const tick = () => {
        if (anchorTo(anchor)) return;
        if (--left > 0) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    [goto, anchorTo],
  );

  /*
   * 三条通道都收进一个 memo 里下发。
   *
   * publish 是给上下文面板的：它的列表来自 /api/sessions，外壳没法自己取。
   * 侧栏的选中态一律由外壳持有，面板只收 itemId —— 面板自己再存一份
   * openId 会和侧栏高亮打架。
   */
  const itemId = picked[tab] ?? "";
  const sectionValue = useMemo(
    () => ({ itemId, pick, publish: setLive, anchorTo }),
    [itemId, pick, anchorTo],
  );
  const saveHintValue = useMemo(() => ({ setHint }), []);

  /*
   * 快速配置向导。
   *
   * 开合状态放在这一层：右上角的按钮和「首次自动弹」都要能开它。
   * useAutoOpenSetup 只在配置看着是全新的、而且这台机器没弹过的时候才说要弹
   * —— 它得在下面两个早退分支之前调用，hook 的顺序不能随分支变。
   */
  const [setupOpen, setSetupOpen] = useState(false);
  const [autoOpen, clearAuto] = useAutoOpenSetup(config);
  useEffect(() => {
    if (autoOpen) setSetupOpen(true);
  }, [autoOpen]);

  if (loadError) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-sm border-l-2 border-warn pl-4 text-left">
          <p className="font-serif text-h2 text-ink">无法加载配置</p>
          <p className="mt-2 text-ui text-warn">{loadError}</p>
          <p className="mt-3 text-meta text-ink-faint">请确认后端已启动（双击 启动.bat，或 npm start）。</p>
        </div>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-eyebrow uppercase text-ink-meta">读取配置</p>
      </div>
    );
  }

  // 上下文 / 图库的列表由面板上报，其余分区直接从 config 取
  const groups = sectionGroups(section, config, live);
  // 侧栏选中的是哪一条：得跨组找（图库里参考图和表情包各是一组）
  const current =
    groups
      .flatMap((g) => g.items.map((it) => ({ ...it, groupLabel: g.label })))
      .find((it) => it.id === itemId) ?? null;

  const listPanel = (
    <SectionList
      section={section}
      groups={groups}
      itemId={itemId}
      onPick={pick}
      onAnchor={anchorTo}
    />
  );

  /*
   * 桌面端那条 60px 导航轨的内容：只有 20px 图标，认不出来就 hover 出 title。
   *
   * 手机上那份**没有复用它**，是另一套带文字的按钮（见下面 `rail &&` 那段）。
   * 本来想共用，但共用不了：手机上没有 hover，十三个纯图标方块认不出是什么，
   * 必须带标签；而桌面端那条硬规则是「仅 20px 纯色 SVG 图标」（见 RailButton）。
   * 两种形态差的不是几个类名，是要不要有文字。
   */
  const railInner = (
    <>
      <div className="flex w-full flex-col items-center gap-1">
        {NAV.map((n) => (
          <RailButton
            key={n.id}
            icon={n.icon}
            label={n.label}
            active={tab === n.id}
            onClick={() => goto(n.id)}
          />
        ))}
      </div>
      <UranusBadge size={32} />
    </>
  );

  return (
    <SectionCtx.Provider value={sectionValue}>
      <SaveHintCtx.Provider value={saveHintValue}>
        {/* 100vh + overflow hidden：整页不滚，只有 260px 那栏和主内容区各自滚 */}
        <div className="flex h-screen overflow-hidden">
          {/*
            一层：60px 导航轨。上下 flex 分布，底部一个圆形头像。
            手机上收起来（`hidden md:flex`），从顶栏的汉堡键点开成覆盖层。
          */}
          <nav className="hidden w-[60px] shrink-0 flex-col items-center justify-between border-r border-line py-4 md:flex">
            {railInner}
          </nav>

          {/* 二层：260px 条目面板。独立滚动，右边一条 1px 实线 */}
          <aside className="hidden w-[260px] shrink-0 overflow-y-auto border-r border-line md:block">
            {listPanel}
          </aside>

          {/* 三层：主内容区。独立滚动，底部贴一条全局保存条 */}
          <div className="flex min-w-0 flex-1 flex-col">
            {/*
              手机专属顶栏。桌面端 `md:hidden` 整条不存在 —— 那边导航轨和条目栏
              都常驻，没有可点开的东西。
              `shrink-0`：它是 flex 列里的固定一行，不给的话内容一多就被压扁。
            */}
            <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-2 md:hidden">
              <button
                type="button"
                onClick={() => setRail(true)}
                aria-label="打开分区"
                title="打开分区"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-item text-ink-faint transition-colors duration-150 hover:bg-sunken hover:text-ink"
              >
                <Menu size={20} strokeWidth={1.75} />
              </button>
              {/*
                当前位置。`truncate` + `min-w-0`：角色名长的时候截断，
                而不是把右边那个键挤出屏幕。
              */}
              <span className="min-w-0 flex-1 truncate text-ui text-ink">
                {current ? current.label : section.label}
              </span>
              {/* 章节锚点分区（发送节奏 / 控制台）也有列表可看，所以不按分区隐藏 */}
              <button
                type="button"
                onClick={() => setDrawer(true)}
                aria-label={`${section.label}的列表`}
                title={`${section.label}的列表`}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-item text-ink-faint transition-colors duration-150 hover:bg-sunken hover:text-ink"
              >
                <List size={20} strokeWidth={1.75} />
              </button>
            </div>

            {/* 手机上左右留白收到 16px：375px 的屏上 24px×2 是实打实的一行字 */}
            <main ref={mainRef} className="min-h-0 flex-1 overflow-y-auto px-4 md:px-6 lg:px-10">
              <div className="mx-auto max-w-content py-rhythm-sm lg:py-rhythm">
                {/* 分区标题：72px（移动端 40px），整页只有这一处这么大 */}
                <header className="mb-rhythm-sm lg:mb-rhythm">
                  {/*
                    手机上改成上下两行（`flex-col`）。原来横排时标题挂着 `min-w-0`、
                    右边按钮组挂着 `shrink-0`，375px 的屏上标题被压到 **0 宽**，
                    「角色」两个字只能靠 CJK 逐字换行竖着排下来。
                    DOM 顺序照旧是「标题 → 按钮组」，竖排时正好是标题在上。
                  */}
                  <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                    {/* min-w-0：标题长的时候让它自己折行，别把右上角那两个挤出去 */}
                    <Reveal
                      as="h1"
                      className="min-w-0 font-serif text-display-sm text-ink lg:text-display"
                    >
                      {current ? current.label : section.label}
                    </Reveal>
                    {/*
                      * 搜索、指令表和壁纸都是全局的东西、不属于任何分区，
                      * 所以一起挂在标题这一行的右上角
                      */}
                    <div className="flex shrink-0 items-center gap-2 sm:mt-2">
                      <GlobalSearch config={config} onJump={gotoItem} />
                      <SetupButton onOpen={() => setSetupOpen(true)} />
                      <CommandsButton onGoto={gotoItem} />
                      <WallpaperButton wallpaper={wallpaper} />
                    </div>
                  </div>
                  <Reveal delay={80} className="mt-6 max-w-[62ch] text-body text-ink-soft">
                    {current
                      ? `${current.groupLabel ?? section.group} · ${section.label}`
                      : section.desc}
                  </Reveal>
                  <div className="mt-6">
                    <ErrorBanner onGoto={goto} />
                  </div>
                </header>

                <div className="grid grid-cols-1 gap-rhythm-sm lg:gap-rhythm">
                  {tab === "api" && <ProviderPanel />}
                  {tab === "role" && <RolePanel onGoto={goto} bridge={bridge} />}
                  {tab === "user" && <UserPanel onGoto={goto} />}
                  {tab === "preset" && <PresetPanel onGoto={goto} />}
                  {tab === "world" && <WorldPanel onGoto={goto} />}
                  {tab === "gallery" && <GalleryPanel onGoto={goto} />}
                  {tab === "context" && <ContextPanel onGoto={goto} />}
                  {tab === "offline" && <OfflinePanel onGoto={goto} />}
                  {tab === "memories" && <MemoriesPanel onGoto={goto} />}
                  {tab === "instagram" && <InstagramPanel onGoto={goto} />}
                  {tab === "chat" && (
                    <>
                      <ChatPanel />
                      <PrivacyPanel />
                      <ChatPreview />
                    </>
                  )}
                  {tab === "imessage" && <ImessagePanel bridge={bridge} />}
                  {tab === "console" && (
                    <>
                      <ConsolePanel />
                      {/* 账号排在服务控制之前：改密码是「这台服务谁能进」，
                          比重启和备份更靠前，而且新用户装完最先该来这儿看一眼 */}
                      <AccountPanel />
                      {/* 代理紧跟账号：这两节都是「这台服务怎么跟外面打交道」，
                          而且新装的人配完连接之后，第二个会卡住的地方就是出网 */}
                      <ProxyPanel />
                      <ServicePanel />
                      <BackupPanel />
                      <CloudBackupPanel />
                    </>
                  )}
                </div>
              </div>
            </main>

            <GlobalSaveBar hint={hint} />
          </div>
        </div>

        {/*
          移动端：60px 导航轨改成覆盖层滑出。
          z-50 压在条目抽屉（z-40）之上 —— 两个都开着时该看到的是「换分区」这一层。
        */}
        {rail && (
          <div
            className="fixed inset-0 z-50 bg-ink/20 md:hidden"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setRail(false);
            }}
          >
            <div className="flex h-full w-[240px] max-w-[80vw] flex-col overflow-y-auto border-r border-line bg-paper">
              <div className="flex items-center justify-between gap-2 border-b border-line px-2 py-3">
                <span className="pl-2 text-eyebrow uppercase text-ink-faint">分区</span>
                <button
                  type="button"
                  onClick={() => setRail(false)}
                  aria-label="关闭分区"
                  className="flex h-11 w-11 items-center justify-center text-ink-faint transition-colors duration-150 hover:text-ink"
                >
                  <X size={18} />
                </button>
              </div>
              {/*
                手机上这一层**带文字**，不像桌面端那条只有 20px 图标。
                导航轨靠 hover 出 title 才知道每格是什么，手机上没有 hover ——
                十三个只有图标的方块认不出来。
              */}
              <div className="grid grid-cols-1 gap-1 px-2 py-2">
                {NAV.map((n) => {
                  const Icon = n.icon;
                  const active = tab === n.id;
                  return (
                    <button
                      key={n.id}
                      type="button"
                      onClick={() => {
                        goto(n.id);
                        setDrawer(true);
                      }}
                      aria-current={active ? "page" : undefined}
                      className={`flex h-11 items-center gap-3 rounded-item px-2 text-left text-ui transition-colors duration-150 ${
                        active
                          ? "bg-sunken text-ink"
                          : "text-ink-soft hover:bg-sunken hover:text-ink"
                      }`}
                    >
                      <Icon size={18} strokeWidth={1.75} className="shrink-0" />
                      <span className="min-w-0 truncate">{n.label}</span>
                    </button>
                  );
                })}
              </div>
              <div className="mt-auto flex justify-center border-t border-line py-4">
                <UranusBadge size={32} />
              </div>
            </div>
          </div>
        )}

        {/* 移动端：260px 那栏改成覆盖层滑出 */}
        {drawer && (
          <div
            className="fixed inset-0 z-40 bg-ink/20 md:hidden"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setDrawer(false);
            }}
          >
            <div className="flex h-full w-[280px] max-w-[85vw] flex-col overflow-y-auto border-r border-line bg-paper">
              <div className="flex items-center justify-between gap-2 border-b border-line px-2 py-3">
                <span className="pl-2 text-eyebrow uppercase text-ink-faint">{section.label}</span>
                <button
                  type="button"
                  onClick={() => setDrawer(false)}
                  aria-label="关闭列表"
                  className="flex h-11 w-11 items-center justify-center text-ink-faint transition-colors duration-150 hover:text-ink"
                >
                  <X size={18} />
                </button>
              </div>
              {listPanel}
            </div>
          </div>
        )}

        {/*
          右下角的客服气泡。挂在这一层、在分区的 switch 外面 —— 它在每个分区上
          都得在，而用户求助的时候恰恰不该被要求先切走到别处去提问。
        */}
        <AssistantBubble />

        {/* 快速配置向导。关掉时顺手把「该自动弹」的标记清掉，免得下次 render 又开 */}
        <SetupWizard
          open={setupOpen}
          onClose={() => {
            setSetupOpen(false);
            clearAuto();
          }}
        />
      </SaveHintCtx.Provider>
    </SectionCtx.Provider>
  );
}
