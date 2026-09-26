/**
 * Instagram 独立页。
 *
 * 这一页跑在自己的端口（6873）上，`/api/*` 和控制台同源转发到同一个后端，
 * 所以数据层（useIg.js）一个字都不用改。
 *
 * ── 这一页有什么、没什么 ──
 *
 * 有的是**一个真 IG 用户对自己账号做的那些事**：刷首页、看主页、看快拍、
 * 点赞、评论、回快拍、自己发帖发快拍、删自己的东西。
 *
 * 没有的是**上帝视角的那些**：改别人的主页资料、替角色发帖、改角色的配文、
 * 管精选封面、调快拍时长、改提示词。那些全挪到 Uranus 控制台的 Instagram
 * 分区里了 —— 用户定的「所有 IG 的设置都放到 Uranus 里，不在 IG 里设置」。
 *
 * 所以这一页里凡是「设置」的入口（电脑版左栏最底下那个「更多」、手机版自己
 * 主页右上角那个齿轮）都是**跳到控制台**，不是就地弹一个编辑框。真 IG 那两个
 * 位置本来也是「设置和隐私」，位置对得上。
 *
 * ── 版式 ──
 *
 * 手机版和电脑版是同一批组件，靠根节点的 `.ig-mobile` / `.ig-desktop` 切。
 * 默认跟窗口宽度走；想钉死成某一版就去控制台改 `defaultView` —— 页面上那个
 * 手动切换的按钮跟着「不在 IG 里设置」一起挪走了。
 */

import { useEffect, useMemo, useState } from "react";
import {
  Compass,
  Heart,
  Home,
  Instagram as IgIcon,
  Menu,
  MessageCircle,
  PlusSquare,
  Search,
  User,
} from "lucide-react";

import Post from "./Post.jsx";
import Profile from "./Profile.jsx";
import Story from "./Story.jsx";
import { Avatar, Empty, Modal, RingAvatar, Sheet, timeAgo } from "./parts.jsx";
import { PostEditor } from "./editors.jsx";
import { igApi, useActivity, useFeed, useIgSettings, useProfile } from "./useIg.js";

/** 手机版的分界。768px 以下当手机。 */
const MOBILE_MAX = 768;

/**
 * 当前该用哪套版式。
 *
 * `pref` 来自控制台里存的 `settings.defaultView`（"auto" / "mobile" / "desktop"）。
 * auto 时跟窗口宽度走，而且要**跟着变** —— 拖窗口大小是最容易发现布局问题的操作。
 */
function useView(pref) {
  const [wide, setWide] = useState(() => window.innerWidth >= MOBILE_MAX);
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${MOBILE_MAX}px)`);
    const on = () => setWide(mq.matches);
    // 先对一次：初值是 render 时读的，到这儿之间窗口可能已经变过
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  if (pref === "mobile") return "mobile";
  if (pref === "desktop") return "desktop";
  return wide ? "desktop" : "mobile";
}

/**
 * 控制台开在哪儿。
 *
 * 前端是后端自己 serve 的，控制台就在后端那个端口上（默认 8787，但 PORT
 * 能改，所以从 /api/health 问一句而不是写死）。
 */
function useConsoleUrl() {
  const [port, setPort] = useState("");

  useEffect(() => {
    let alive = true;
    // 直接 fetch 而不是用 store.jsx 那个 api()：只为一句 health 把整个控制台的
    // store 拖进这个包不值当
    fetch("/api/health")
      .then((r) => r.json())
      .then((h) => {
        if (alive && h?.port) setPort(String(h.port));
      })
      .catch(() => {
        /* 问不到就先空着，下面回落成 8787 */
      });
    return () => {
      alive = false;
    };
  }, []);

  return `${window.location.protocol}//${window.location.hostname}:${port || "8787"}`;
}

/** 左边那条图标栏的一项。 */
function RailItem({ icon: Icon, label, active, stub, href, onClick }) {
  const common = {
    className: "ig-rail-item",
    "data-active": active ? "true" : "false",
    "data-stub": stub ? "true" : "false",
  };
  const inner = (
    <>
      <Icon size={24} strokeWidth={active ? 2.4 : 1.8} />
      <span className="ig-rail-label">{label}</span>
    </>
  );

  // 「更多」是跳出去的外链，得是 <a> 才能新开标签页
  if (href) {
    return (
      <a {...common} href={href} target="_blank" rel="noreferrer" aria-label={label}>
        {inner}
      </a>
    );
  }
  return (
    <button
      type="button"
      {...common}
      onClick={stub ? undefined : onClick}
      disabled={stub}
      aria-label={stub ? `${label}（暂不可用）` : label}
    >
      {inner}
    </button>
  );
}

/** 互动记录那一页（右上角爱心点进来）。 */
function Activity({ items, onClose }) {
  const label = {
    like: "赞了你的帖子",
    comment: "评论了你的帖子",
    reply: "回复了你的评论",
    storyLike: "赞了你的快拍",
    storyReply: "回复了你的快拍",
    commentLike: "赞了你的评论",
  };
  return (
    <div>
      <div className="ig-topbar">
        <button type="button" className="ig-icon-btn" onClick={onClose} aria-label="返回">
          <Home size={22} />
        </button>
        <span style={{ fontWeight: 600 }}>动态</span>
        <span style={{ width: 40 }} />
      </div>
      {items.length ? (
        <div style={{ padding: "8px 0" }}>
          {items.map((a) => (
            <div
              key={a.id}
              style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px" }}
            >
              <Avatar name={a.actor} size={44} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <b>{a.actor}</b> {label[a.kind] ?? "有了新互动"}
                {a.text ? `：${a.text}` : ""}
                <div style={{ color: "var(--ig-text-soft)", fontSize: 12, marginTop: 2 }}>
                  {timeAgo(a.at)}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Empty title="还没有互动">
          角色赞了或者评论了你的帖子之后会出现在这里。它们各自按自己的概率和时间窗口来，
          不是马上。
        </Empty>
      )}
    </div>
  );
}

export default function IgApp() {
  const { settings } = useIgSettings();
  const view = useView(settings?.defaultView ?? "auto");
  const desktop = view === "desktop";
  const consoleUrl = useConsoleUrl();

  // 当前在看哪一页："feed" / "profile" / "activity"
  const [page, setPage] = useState("feed");
  const [who, setWho] = useState("user");
  const [railOpen, setRailOpen] = useState(false);

  // 播放器：{ owner, head, list, start }
  const [player, setPlayer] = useState(null);
  // 弹层
  const [composer, setComposer] = useState(null);
  const [openPost, setOpenPost] = useState(null);
  const [postMenu, setPostMenu] = useState(null);

  const feed = useFeed();
  const profile = useProfile(page === "profile" ? who : "");
  const activity = useActivity();

  const openProfile = (owner) => {
    setWho(owner);
    setPage("profile");
  };

  /** 一次刷新：feed 和当前主页都拉一遍（改了帖子两处都得变）。 */
  const refresh = () => {
    feed.reload();
    profile.reload();
    activity.reload();
  };

  const openStory = (ownerOrRing, startIndex = 0, which = "active") => {
    // 从 feed 的快拍条进来：整个 ring 对象
    if (typeof ownerOrRing === "object") {
      setPlayer({
        owner: ownerOrRing.owner,
        head: ownerOrRing,
        list: ownerOrRing.stories ?? [],
        start: 0,
      });
      return;
    }
    // 从主页进来：用 profile 里的 active / expired
    const list = which === "expired" ? profile.data?.expired : profile.data?.active;
    if (!list?.length) return;
    setPlayer({ owner: ownerOrRing, head: profile.data, list, start: startIndex });
  };

  /** 帖子的动作。owner 从帖子上取 —— feed 里混着好几个人的帖子。 */
  const postActions = (post) => ({
    onLike: async () => {
      await igApi.likePost(post.owner, post.id);
      refresh();
    },
    onComment: async (text) => {
      await igApi.comment(post.owner, post.id, { actor: "user", text });
      refresh();
    },
    onDeleteComment: async (commentId) => {
      await igApi.deleteComment(post.owner, post.id, commentId);
      refresh();
    },
    onOpenProfile: openProfile,
    onMenu: () => setPostMenu(post),
  });

  /*
   * 三点菜单里有什么，看这条帖子是不是自己的。
   *
   * 真 IG 就是这个规矩：自己的帖子能删，别人的帖子只能举报/取消关注。
   * 删别人（角色）的帖子属于内容管理，在控制台那边。
   */
  const postMenuItems = (post) => {
    const items = [{ label: "去发布者主页", onClick: () => openProfile(post.owner) }];
    if (post.owner === "user") {
      items.push({
        label: "删除这条帖子",
        danger: true,
        onClick: async () => {
          // 删帖子没有回收站，问一句
          if (!window.confirm("删掉这条帖子？评论和点赞会一起没了。")) return;
          await igApi.deletePost(post.owner, post.id);
          setOpenPost(null);
          refresh();
        },
      });
    }
    return items;
  };

  /* ── feed ── */
  const feedBody = (
    <>
      {/* 快拍条。用户那个永远在最左边，一条都没有也显示（那是发快拍的入口） */}
      {feed.rings.length ? (
        <div className="ig-rings">
          {feed.rings.map((ring) => (
            <div className="ig-rings-item" key={ring.owner}>
              <span style={{ position: "relative" }}>
                <RingAvatar
                  avatar={ring.avatar}
                  name={ring.displayName}
                  size={desktop ? 56 : 64}
                  has={Boolean(ring.stories?.length)}
                  seen={ring.seen}
                  onClick={() =>
                    ring.stories?.length
                      ? openStory(ring)
                      : ring.isUser
                        ? setComposer({ owner: "user", kind: "story" })
                        : openProfile(ring.owner)
                  }
                />
                {ring.isUser && !ring.stories?.length ? (
                  <button
                    type="button"
                    className="ig-rings-add"
                    onClick={() => setComposer({ owner: "user", kind: "story" })}
                    aria-label="发一条快拍"
                  >
                    +
                  </button>
                ) : null}
              </span>
              <span className="ig-rings-name">{ring.isUser ? "你的快拍" : ring.displayName}</span>
            </div>
          ))}
        </div>
      ) : null}

      {feed.loading ? (
        <Empty title="正在加载…" />
      ) : feed.error ? (
        <Empty title="拉不到数据">{feed.error}</Empty>
      ) : feed.posts.length ? (
        feed.posts.map((post) => (
          <Post key={post.id} post={post} view={view} {...postActions(post)} />
        ))
      ) : (
        <Empty title="还没有帖子">
          {/* owners 里第一条永远是你自己，所以「有角色开了 IG」= 至少两条 */}
          {feed.owners.length > 1 ? (
            <>
              点左上角的 <b style={{ display: "inline" }}>+</b> 自己发一条，
              或者等开了 Instagram 的角色在主动消息轮次里自己发。
            </>
          ) : (
            <>
              还没有角色开 Instagram。去
              <a
                href={consoleUrl}
                target="_blank"
                rel="noreferrer"
                style={{ color: "var(--ig-blue)", fontWeight: 600, margin: "0 4px" }}
              >
                Uranus 控制台 → 角色 → 单独配置 → Instagram
              </a>
              打开开关。
            </>
          )}
        </Empty>
      )}
    </>
  );

  /* ── 当前主体 ── */
  const body =
    page === "activity" ? (
      <Activity items={activity.items} onClose={() => setPage("feed")} />
    ) : page === "profile" ? (
      profile.loading ? (
        <Empty title="正在加载…" />
      ) : (
        <Profile
          /* 换人时重新挂载：主页里的分区标签是本地的，跟着人走才对 */
          key={who}
          data={profile.data}
          view={view}
          settingsUrl={consoleUrl}
          onBack={() => setPage("feed")}
          onOpenStory={(i, which) => openStory(who, i, which)}
          /* 主页接口回来的帖子身上没有 head（feed 那条才拼），弹层里要显示头像和
             账号名，所以在这儿补上 —— profile.data 本身就是 headerFor() 的那几个字段 */
          onOpenPost={(p) => setOpenPost({ ...p, owner: p.owner ?? who, head: profile.data })}
          onNewPost={() => setComposer({ owner: "user", kind: "post" })}
          onOpenHighlight={(h) =>
            setPlayer({ owner: who, head: profile.data, list: h.stories ?? [], start: 0 })
          }
        />
      )
    ) : (
      feedBody
    );

  return (
    <div className={`ig ${desktop ? "ig-desktop" : "ig-mobile"}`}>
      {desktop ? (
        <>
          {/* 左边那条 72px 图标栏，鼠标进去展开成 244px 带文字 */}
          <nav
            className="ig-rail"
            data-open={railOpen ? "true" : "false"}
            onMouseEnter={() => setRailOpen(true)}
            onMouseLeave={() => setRailOpen(false)}
          >
            <div className="ig-rail-logo">{railOpen ? "Instagram" : <IgIcon size={24} />}</div>
            <RailItem
              icon={Home}
              label="首页"
              active={page === "feed"}
              onClick={() => setPage("feed")}
            />
            <RailItem icon={Search} label="搜索" stub />
            <RailItem icon={Compass} label="探索" stub />
            <RailItem icon={MessageCircle} label="消息" stub />
            <RailItem
              icon={Heart}
              label="通知"
              active={page === "activity"}
              onClick={() => {
                setPage("activity");
                activity.markRead();
              }}
            />
            <RailItem
              icon={PlusSquare}
              label="创建"
              onClick={() => setComposer({ owner: "user", kind: "post" })}
            />
            <RailItem
              icon={User}
              label="我"
              active={page === "profile" && who === "user"}
              onClick={() => openProfile("user")}
            />
            <span style={{ flex: 1 }} />
            {/* 真 IG 这个位置就是「更多 → 设置」。这里的设置在控制台，所以直接跳过去 */}
            <RailItem icon={Menu} label="更多（去控制台设置）" href={consoleUrl} />
          </nav>

          <div className="ig-main">
            <div className="ig-col">{body}</div>

            {/* 右栏：当前账号 + 有哪些角色在 IG 上 */}
            {page === "feed" ? (
              <aside className="ig-aside">
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
                  <Avatar
                    avatar={feed.rings.find((r) => r.isUser)?.avatar}
                    name="你"
                    size={44}
                    onClick={() => openProfile("user")}
                  />
                  <b style={{ flex: 1 }}>{feed.rings.find((r) => r.isUser)?.username || "你"}</b>
                </div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    color: "var(--ig-text-soft)",
                    fontWeight: 600,
                    marginBottom: 12,
                  }}
                >
                  <span>在 Instagram 上的角色</span>
                </div>
                {feed.owners
                  .filter((o) => !o.isUser)
                  .map((o) => (
                    <div
                      key={o.owner}
                      style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0" }}
                    >
                      <Avatar
                        avatar={feed.rings.find((r) => r.owner === o.owner)?.avatar}
                        name={o.label}
                        size={32}
                        onClick={() => openProfile(o.owner)}
                      />
                      <b style={{ flex: 1, minWidth: 0 }}>{o.label}</b>
                      <button
                        type="button"
                        onClick={() => openProfile(o.owner)}
                        style={{ color: "var(--ig-blue)", fontWeight: 600 }}
                      >
                        查看
                      </button>
                    </div>
                  ))}
                {feed.owners.length < 2 ? (
                  <div style={{ color: "var(--ig-text-soft)", fontSize: 13 }}>
                    一个都没开。开关在控制台的「角色 → 单独配置 → Instagram」。
                  </div>
                ) : null}
              </aside>
            ) : null}
          </div>
        </>
      ) : (
        <>
          {/* 手机版顶栏。主页那一页自带顶栏，这里就不重复画 */}
          {page === "feed" ? (
            <div className="ig-topbar">
              <button
                type="button"
                className="ig-icon-btn"
                onClick={() => setComposer({ owner: "user", kind: "post" })}
                aria-label="发布"
              >
                <PlusSquare size={24} />
              </button>
              <span className="ig-wordmark">Instagram</span>
              <button
                type="button"
                className="ig-icon-btn"
                onClick={() => {
                  setPage("activity");
                  activity.markRead();
                }}
                aria-label="动态"
                style={{ position: "relative" }}
              >
                <Heart size={24} />
                {activity.unread ? <span className="ig-dot">{activity.unread}</span> : null}
              </button>
            </div>
          ) : null}

          {body}

          {/* 底栏：悬浮胶囊（新版 IG）。首页和「我」能点，其余是占位 */}
          <nav className="ig-tabbar">
            <button
              type="button"
              className="ig-tab"
              data-active={page === "feed" ? "true" : "false"}
              onClick={() => setPage("feed")}
              aria-label="首页"
            >
              <Home size={24} fill={page === "feed" ? "currentColor" : "none"} />
            </button>
            <button type="button" className="ig-tab" data-stub="true" aria-label="Reels（暂不可用）">
              <Compass size={24} />
            </button>
            <button type="button" className="ig-tab" data-stub="true" aria-label="消息（暂不可用）">
              <MessageCircle size={24} />
            </button>
            <button type="button" className="ig-tab" data-stub="true" aria-label="搜索（暂不可用）">
              <Search size={24} />
            </button>
            <button
              type="button"
              className="ig-tab"
              data-active={page === "profile" && who === "user" ? "true" : "false"}
              onClick={() => openProfile("user")}
              aria-label="我"
            >
              <User size={24} />
            </button>
          </nav>
        </>
      )}

      {/* ── 覆盖层 ── */}

      {player ? (
        <Story
          owner={player.owner}
          head={player.head}
          stories={player.list}
          start={player.start}
          view={view}
          isSelf={player.owner === "user"}
          onClose={() => setPlayer(null)}
          onNext={() => setPlayer(null)}
          onSaveHighlight={async (storyId) => {
            try {
              await igApi.saveHighlight("user", { storyId });
              refresh();
              setPlayer(null);
            } catch (e) {
              // 满三个时后端回 409，错误信息里写了「先删一个」
              window.alert(String(e?.message ?? e));
            }
          }}
          onDelete={async (storyId) => {
            await igApi.deleteStory(player.owner, storyId);
            refresh();
            setPlayer(null);
          }}
          onReply={async (storyId, text) => {
            const story = player.list.find((s) => s.id === storyId);
            await igApi.editStory(player.owner, storyId, {
              replies: [...(story?.replies ?? []), { owner: "user", text }],
            });
            refresh();
          }}
        />
      ) : null}

      {composer ? (
        <PostEditor
          owner={composer.owner}
          kind={composer.kind}
          onClose={() => setComposer(null)}
          onSaved={refresh}
        />
      ) : null}

      {/* 九宫格点进来的单条帖子。网页版 IG 就是弹一层，不是跳页 */}
      {openPost ? (
        <Modal title="帖子" flush onClose={() => setOpenPost(null)}>
          <Post
            post={openPost}
            view={view}
            {...postActions(openPost)}
            onOpenProfile={(owner) => {
              setOpenPost(null);
              openProfile(owner);
            }}
          />
        </Modal>
      ) : null}

      {postMenu ? (
        <Sheet onClose={() => setPostMenu(null)} items={postMenuItems(postMenu)} />
      ) : null}
    </div>
  );
}
