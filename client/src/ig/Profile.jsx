/**
 * 一个人的主页：资料 + 精选 + 九宫格。
 *
 * 手机版和电脑版差别不小（手机是小头像加三个并排计数、电脑是 150px 头像
 * 加一整行信息），但都是**同一批 DOM**，靠 `.ig-mobile` / `.ig-desktop`
 * 下的 CSS 切 —— 两套 JSX 意味着改一处要记得改两遍。
 *
 * 这里只有「看」和「自己发」：改资料、替角色发帖、删角色的帖子、管精选，
 * 全在 Uranus 控制台那边。所以「编辑主页」和手机版右上角那个齿轮都是**跳过去**
 * （`settingsUrl`），角色主页右上角原先那个三点菜单整个没了 —— 它底下两条
 * （编辑角色帖子 / 编辑角色主页）都是控制台的活。
 */

import { useState } from "react";
import {
  Bell,
  Bookmark,
  Clock,
  Grid3x3,
  Heart,
  Link as LinkIcon,
  MessageCircle,
  Play,
  Plus,
  Settings,
  Tag,
} from "lucide-react";

import { Avatar, Empty, Verified, fmtCount, igMediaUrl } from "./parts.jsx";

/** 九宫格里的一格。点一下打开那条帖子。 */
function Cell({ post, onClick }) {
  const first = (post.images ?? [])[0];
  const url = igMediaUrl(first?.file);
  return (
    <div className="ig-cell">
      <button type="button" className="ig-cell-open" onClick={onClick} aria-label="打开这条帖子">
        {url ? (
          <img src={url} alt={first?.alt || ""} />
        ) : (
          /* 没图的帖子显示配文片段 —— 空白格子看不出是什么 */
          <div className="ig-cell-text">{post.caption || first?.alt || "（空帖子）"}</div>
        )}
        <div className="ig-cell-hover">
          <span>
            <Heart size={18} fill="currentColor" /> {(post.likes ?? []).length}
          </span>
          <span>
            <MessageCircle size={18} fill="currentColor" /> {(post.comments ?? []).length}
          </span>
        </div>
      </button>
      {(post.images ?? []).length > 1 ? (
        <span className="ig-cell-badge">
          <Bookmark size={16} fill="currentColor" />
        </span>
      ) : null}
    </div>
  );
}

/**
 * 三个计数。
 *
 * 用户填过就照他填的显示（IG 上是「1,137万」这种），没填就显示真实数量 ——
 * 帖子数能数出来，粉丝和关注数数不出来（没有真的社交图），留空就是 0。
 */
function Counts({ profile, realPosts }) {
  const items = [
    { key: "posts", label: "帖子", value: profile.posts || fmtCount(realPosts) },
    { key: "followers", label: "粉丝", value: profile.followers || "0" },
    { key: "following", label: "关注", value: profile.following || "0" },
  ];
  return (
    <div className="ig-counts">
      {items.map((it) => (
        <div className="ig-count" key={it.key}>
          <b>{it.value}</b>
          <span>{it.label}</span>
        </div>
      ))}
    </div>
  );
}

export default function Profile({
  data,
  view,
  settingsUrl,
  onOpenStory,
  onOpenPost,
  onOpenHighlight,
  onNewPost,
  onBack,
}) {
  const [tab, setTab] = useState("posts");
  const desktop = view === "desktop";

  if (!data) return null;
  const { profile, avatar, displayName, username, realPosts, isUser } = data;
  const posts = data.posts ?? [];
  const highlights = data.highlights ?? [];
  const expired = data.expired ?? [];
  const active = data.active ?? [];

  /* 资料那一块（名字、简介、链接）—— 两个版式共用 */
  const info = (
    <>
      <div className="ig-profile-name">{displayName}</div>
      {profile.bio ? <div className="ig-bio">{profile.bio}</div> : null}
      {profile.link ? (
        <a className="ig-link" href={profile.link} target="_blank" rel="noreferrer">
          <LinkIcon size={12} />
          {profile.link.replace(/^https?:\/\//, "")}
        </a>
      ) : null}
    </>
  );

  /* 按钮那一行：自己的是「编辑主页 / 发布」，角色的是「已关注 / 发消息」 */
  const buttons = isUser ? (
    <div className="ig-profile-btns">
      {/* 资料在控制台改，这里只是个入口。真 IG 点这个是进编辑页，也是离开 feed */}
      <a
        className="ig-btn ig-btn-soft"
        href={settingsUrl}
        target="_blank"
        rel="noreferrer"
        title="资料在 Uranus 控制台的 Instagram 分区里改"
      >
        编辑主页
      </a>
      <button type="button" className="ig-btn ig-btn-soft" onClick={onNewPost}>
        <Plus size={16} />
        发布
      </button>
    </div>
  ) : (
    <div className="ig-profile-btns">
      {/* 关注 / 发消息是占位：这里没有真的社交图，私聊在 iMessage 那边 */}
      <button type="button" className="ig-btn ig-btn-soft" disabled>
        已关注
      </button>
      <button type="button" className="ig-btn ig-btn-soft" disabled>
        发消息
      </button>
    </div>
  );

  return (
    <div className="ig-profile">
      {/* 手机版顶栏：返回 + 账号名 + 铃铛/设置 */}
      {!desktop ? (
        <div className="ig-topbar">
          {!isUser && onBack ? (
            <button type="button" className="ig-icon-btn" onClick={onBack} aria-label="返回">
              <Grid3x3 size={20} style={{ transform: "rotate(45deg)" }} />
            </button>
          ) : (
            <span style={{ width: 40 }} />
          )}
          {/* 账号名靠左贴着返回键（IG 上看别人主页就是这样，不是居中）。
              flex:1 把剩下的宽度全占了，右边那组就被顶到最右；minWidth:0 +
              内层的截断是为了长名字别去挤两边按钮的触控区 */}
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <span
              style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {username}
            </span>
            <Verified on={profile.verified} />
          </span>
          <span style={{ display: "flex" }}>
            {isUser ? (
              /* 真 IG 这个齿轮就是「设置和隐私」。这一页的设置全在控制台，跳过去 */
              <a
                className="ig-icon-btn"
                href={settingsUrl}
                target="_blank"
                rel="noreferrer"
                aria-label="设置（在 Uranus 控制台里）"
              >
                <Settings size={22} />
              </a>
            ) : (
              <button type="button" className="ig-icon-btn" disabled aria-label="通知">
                <Bell size={22} />
              </button>
            )}
          </span>
        </div>
      ) : null}

      <div className="ig-profile-head">
        {desktop ? (
          <>
            {/* 有活着的快拍时头像带渐变圈，点一下播 */}
            <Avatar
              avatar={avatar}
              name={displayName}
              size={150}
              className="ig-profile-av"
              onClick={active.length ? () => onOpenStory?.(0) : undefined}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 20,
                  marginBottom: 20,
                  flexWrap: "wrap",
                }}
              >
                <span style={{ fontSize: 20, display: "flex", alignItems: "center", gap: 6 }}>
                  {username}
                  <Verified on={profile.verified} />
                </span>
                {buttons}
              </div>
              <Counts profile={profile} realPosts={realPosts} />
              <div style={{ marginTop: 16 }}>{info}</div>
            </div>
          </>
        ) : (
          <>
            <div className="ig-profile-top">
              <Avatar
                avatar={avatar}
                name={displayName}
                className="ig-profile-av"
                size={86}
                onClick={active.length ? () => onOpenStory?.(0) : undefined}
              />
              <Counts profile={profile} realPosts={realPosts} />
            </div>
            <div style={{ marginTop: 12 }}>{info}</div>
          </>
        )}
      </div>

      {!desktop ? buttons : null}

      {/* 精选：最多三个，**手机上不可滑动**（CSS 里没给 overflow-x）。
          新建和改封面在控制台，这里只有点开看 */}
      {highlights.length ? (
        <div className="ig-highlights">
          {highlights.map((h) => (
            <button
              key={h.id}
              type="button"
              className="ig-highlight"
              onClick={() => onOpenHighlight?.(h)}
            >
              <Avatar
                avatar={{ kind: "ig", value: h.cover }}
                name={h.title}
                size={desktop ? 77 : 64}
                className="ig-highlight-cover"
              />
              <span className="ig-highlight-title">{h.title}</span>
            </button>
          ))}
        </div>
      ) : null}

      {/* 分区标签。「往期快拍」是这个功能特有的 —— 用户要的「过期快拍在自己
          主页 / 点头像看」就落在这一栏 */}
      <div className="ig-tabs">
        <button
          type="button"
          className="ig-tab-item"
          data-active={tab === "posts" ? "true" : "false"}
          onClick={() => setTab("posts")}
        >
          <Grid3x3 size={12} />
          帖子
        </button>
        <button
          type="button"
          className="ig-tab-item"
          data-active={tab === "expired" ? "true" : "false"}
          onClick={() => setTab("expired")}
        >
          <Clock size={12} />
          往期快拍
        </button>
        {/* Reels 和标签是占位 —— 没有视频，也没有互相标记 */}
        <button type="button" className="ig-tab-item" disabled>
          <Play size={12} />
          REELS
        </button>
        <button type="button" className="ig-tab-item" disabled>
          <Tag size={12} />
          标签
        </button>
      </div>

      {tab === "posts" ? (
        posts.length ? (
          <div className="ig-grid">
            {posts.map((p) => (
              <Cell key={p.id} post={p} onClick={() => onOpenPost?.(p)} />
            ))}
          </div>
        ) : (
          <Empty title="还没有帖子">
            {isUser
              ? "点上面的「发布」发第一条。"
              : "这个角色还没发过帖子。它开了 Instagram 之后会在主动消息轮次里自己发；想现在就替它发一条，去 Uranus 控制台的 Instagram 分区。"}
          </Empty>
        )
      ) : expired.length ? (
        <div className="ig-grid">
          {expired.map((s, i) => (
            <button
              key={s.id}
              type="button"
              className="ig-cell"
              onClick={() => onOpenStory?.(i, "expired")}
            >
              {igMediaUrl(s.image?.file) ? (
                <img src={igMediaUrl(s.image.file)} alt={s.image?.alt || ""} />
              ) : (
                <div className="ig-cell-text">{s.caption || s.image?.alt || "（空快拍）"}</div>
              )}
            </button>
          ))}
        </div>
      ) : (
        <Empty title="没有往期快拍">
          快拍发出 {data.storyHours ?? 24} 小时后会从首页收起来，然后出现在这里。
        </Empty>
      )}
    </div>
  );
}
