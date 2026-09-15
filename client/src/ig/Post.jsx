/**
 * feed 里的一条帖子。手机版和电脑版是同一个组件 —— 差别全在 CSS
 * （`.ig-mobile` / `.ig-desktop` 下的规则），和 IG 自己的做法一样。
 */

import { useState } from "react";
import {
  Bookmark,
  ChevronLeft,
  ChevronRight,
  Heart,
  MessageCircle,
  MoreHorizontal,
  Send,
  Smile,
} from "lucide-react";

import { Avatar, Dots, Media, Verified, fmtCount, timeAgo } from "./parts.jsx";

/**
 * 「xxx 和其他 N 人赞了」。
 *
 * IG 的写法是「<某个具体的人> 和其他 N 人赞了」，只有一个人时就是「1 次赞」。
 * 这里挑第一个非用户的点赞者当那个具体的人 —— 用户自己点的赞写成
 * 「你和其他…」也对，但先显示角色更像那回事。
 */
function likeLine(likes) {
  const list = likes ?? [];
  if (!list.length) return "";
  if (list.length === 1) return `${list[0] === "user" ? "你" : list[0]} 赞了`;
  const first = list.find((a) => a !== "user") ?? list[0];
  const who = first === "user" ? "你" : first;
  return `${who} 和其他 ${fmtCount(list.length - 1)} 人赞了`;
}

/**
 * 一条评论。
 *
 * `replyTo` 有值的往里缩一层 —— IG 的评论只有两层，不做无限嵌套。
 */
function Comment({ comment, onDelete, canDelete }) {
  const who = comment.owner === "user" ? "你" : comment.owner;
  return (
    <div className="ig-comment" data-reply={comment.replyTo ? "true" : "false"}>
      <div className="ig-comment-body">
        <span className="ig-comment-name">{who}</span>
        {comment.text}
        <div className="ig-comment-meta">
          <span>{timeAgo(comment.at)}</span>
          {canDelete ? (
            <button type="button" onClick={() => onDelete?.(comment.id)}>
              删除
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default function Post({
  post,
  view,
  onLike,
  onComment,
  onDeleteComment,
  onOpenProfile,
  onMenu,
}) {
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  // feed 里默认只显示两条评论，点一下展开全部（IG 的做法）
  const [allComments, setAllComments] = useState(false);

  const head = post.head ?? {};
  const images = post.images ?? [];
  const comments = post.comments ?? [];
  const liked = (post.likes ?? []).includes("user");
  const desktop = view === "desktop";

  // 顶层评论在前、回复紧跟其后 —— 平铺数据在这儿排成显示顺序
  const ordered = [];
  for (const c of comments.filter((c) => !c.replyTo)) {
    ordered.push(c);
    for (const r of comments.filter((x) => x.replyTo === c.id)) ordered.push(r);
  }
  const shown = allComments ? ordered : ordered.slice(0, 2);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    onComment?.(text);
  };

  return (
    <article className="ig-post">
      <header className="ig-post-head">
        <Avatar
          avatar={head.avatar}
          name={head.displayName}
          size={desktop ? 32 : 32}
          onClick={() => onOpenProfile?.(post.owner)}
        />
        <div className="ig-post-name">
          <button type="button" onClick={() => onOpenProfile?.(post.owner)}>
            {head.username || post.owner}
          </button>
          <Verified on={head.profile?.verified} />
          <span className="ig-post-time">{timeAgo(post.createdAt)}</span>
        </div>
        <span style={{ flex: 1 }} />
        <button type="button" className="ig-icon-btn" onClick={onMenu} aria-label="更多">
          <MoreHorizontal size={20} />
        </button>
      </header>

      {images.length ? (
        <div className="ig-post-media">
          <Media images={images} index={index} />
          <Dots count={images.length} index={index} />
          {/* 轮播箭头只在电脑版给 —— 手机上是横滑，滑动手势比小箭头好按 */}
          {desktop && images.length > 1 ? (
            <>
              {index > 0 ? (
                <button
                  type="button"
                  className="ig-carousel-nav"
                  data-side="left"
                  onClick={() => setIndex((i) => i - 1)}
                  aria-label="上一张"
                >
                  <ChevronLeft size={18} />
                </button>
              ) : null}
              {index < images.length - 1 ? (
                <button
                  type="button"
                  className="ig-carousel-nav"
                  data-side="right"
                  onClick={() => setIndex((i) => i + 1)}
                  aria-label="下一张"
                >
                  <ChevronRight size={18} />
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      <div className="ig-actions">
        <button
          type="button"
          className="ig-icon-btn"
          data-active={liked ? "true" : "false"}
          onClick={onLike}
          aria-label={liked ? "取消赞" : "赞"}
        >
          <Heart size={24} fill={liked ? "currentColor" : "none"} />
        </button>
        <button
          type="button"
          className="ig-icon-btn"
          onClick={() => setAllComments(true)}
          aria-label="评论"
        >
          <MessageCircle size={24} />
        </button>
        {/* 转发和收藏是占位 —— 没有真的社交图可以转发，也没有收藏夹要存 */}
        <button type="button" className="ig-icon-btn" aria-label="转发（暂不可用）" disabled>
          <Send size={22} />
        </button>
        <span className="ig-actions-spacer" />
        <button type="button" className="ig-icon-btn" aria-label="收藏（暂不可用）" disabled>
          <Bookmark size={22} />
        </button>
      </div>

      <div className="ig-post-body">
        {post.likes?.length ? <div className="ig-likes">{likeLine(post.likes)}</div> : null}

        {post.caption ? (
          <div className="ig-caption" data-open={open ? "true" : "false"}>
            <span className="ig-caption-name">{head.username || post.owner}</span>
            {post.caption}
          </div>
        ) : null}
        {/* 「更多」只在配文可能被截断时出现。两行的判断交给 CSS，这里按字数粗筛 */}
        {post.caption && post.caption.length > 60 && !open ? (
          <button type="button" className="ig-more" onClick={() => setOpen(true)}>
            更多
          </button>
        ) : null}

        {ordered.length > 2 && !allComments ? (
          <button type="button" className="ig-more" onClick={() => setAllComments(true)}>
            查看全部 {ordered.length} 条评论
          </button>
        ) : null}

        {shown.length ? (
          <div className="ig-comments">
            {shown.map((c) => (
              <Comment
                key={c.id}
                comment={c}
                canDelete
                onDelete={(id) => onDeleteComment?.(id)}
              />
            ))}
          </div>
        ) : null}

        <div className="ig-meta">{timeAgo(post.createdAt)}</div>
      </div>

      <div className="ig-compose">
        <Smile size={22} color="var(--ig-text-soft)" />
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
          }}
          placeholder="添加评论…"
          aria-label="添加评论"
        />
        <button
          type="button"
          className="ig-compose-send"
          onClick={send}
          disabled={!draft.trim()}
        >
          发布
        </button>
      </div>
    </article>
  );
}
