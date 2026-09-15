/**
 * Instagram 的业务层：把配置里的角色和 igstore 里的内容拼成前端要的形状。
 *
 * 分工：
 *   igstore.js   文件长什么样、存哪儿（不懂角色、不懂配置）
 *   igtags.js    模型输出里怎么认出 IG 标签
 *   这个文件      谁是 owner、feed 怎么排、头像从哪来、互动规则
 *   igprompt.js  评论用的提示词怎么拼（下一层）
 *
 * ── 谁能出现在 IG 上 ──
 *
 * 用户永远在。角色要 `role.instagram.enabled`（默认关）—— 没开的角色压根不
 * 出现在 feed 和快拍条里，就像它没注册这个 App。这样用户可以只给两三个角色
 * 开 IG，剩下的还是纯私聊。
 */

import {
  DEFAULT_STORY_HOURS,
  MAX_HIGHLIGHTS,
  USER_OWNER,
  activeStories,
  expiredStories,
  readHighlights,
  readPosts,
  readProfile,
  readSettings,
  readStories,
} from "./igstore.js";

/**
 * 现在有哪些 owner。
 *
 * 返回的顺序有意义：用户永远第一个（快拍条里「你的快拍」在最左边），
 * 角色按配置里的顺序 —— 和侧边栏的角色顺序一致，用户找起来不用重新适应。
 */
export function igOwners(config) {
  const roles = (config?.roles ?? []).filter((r) => r?.instagram?.enabled);
  return [
    { owner: USER_OWNER, roleId: "", label: "你", isUser: true },
    ...roles.map((r) => ({
      owner: String(r.name ?? ""),
      roleId: String(r.id ?? ""),
      label: String(r.name ?? ""),
      isUser: false,
    })),
  ];
}

/**
 * 角色的头像。
 *
 * IG 主页可以单独设头像（`profile.avatar`，media/ 下的文件名），没设就退回
 * 角色在 iMessage 里那张 —— 大多数人不会想给同一个角色维护两张头像，
 * 但想分开的时候能分开。
 */
function avatarFor(owner, role, profile) {
  if (profile.avatar) return { kind: "ig", value: profile.avatar };
  if (role?.avatar) return { kind: "role", value: String(role.avatar) };
  return { kind: "none", value: "" };
}

/** owner → 那个角色（用户返回 null）。名字对不上就是 null。 */
export function roleFor(config, owner) {
  if (!owner || owner === USER_OWNER) return null;
  return (config?.roles ?? []).find((r) => String(r?.name ?? "") === String(owner)) ?? null;
}

/**
 * 一个 owner 的「头部信息」：主页资料 + 头像 + 真实计数。
 *
 * 三个计数（帖子/粉丝/关注）用户可以自己填任意文本（IG 上是「1,137万」这种），
 * 填了就照他填的显示；没填就显示真实数量 —— 帖子数能数出来，粉丝和关注数
 * 数不出来（没有真的社交图），所以留空时是 0，让用户自己填个好看的。
 */
function headerFor(config, owner) {
  const role = roleFor(config, owner);
  const profile = readProfile(owner);
  const posts = readPosts(owner);
  return {
    owner,
    roleId: role ? String(role.id ?? "") : "",
    isUser: owner === USER_OWNER,
    profile,
    avatar: avatarFor(owner, role, profile),
    // 前端优先显示 profile 里的自定义值，这两个是兜底的真实数
    realPosts: posts.length,
    // 名字兜底链：IG 显示名 → 角色名 → owner
    displayName: profile.name || (role ? String(role.name ?? "") : "") || owner,
    username: profile.username || profile.name || owner,
  };
}

/**
 * 首页 feed。
 *
 * 用户和所有开了 IG 的角色的帖子混在一起，**按时间倒序** —— IG 早年是纯时序，
 * 现在是算法流，但这里没有「算法」可言（就那么几条），时序是唯一讲得通的排法。
 *
 * 快拍单独一条：feed 顶上那一行头像圈，只放**还没过期**的。
 */
export function igFeed(config) {
  const settings = readSettings();
  const hours = settings.storyHours ?? DEFAULT_STORY_HOURS;
  const owners = igOwners(config);
  const now = Date.now();

  const heads = new Map();
  for (const o of owners) heads.set(o.owner, headerFor(config, o.owner));

  const posts = [];
  for (const o of owners) {
    for (const p of readPosts(o.owner)) {
      posts.push({ ...p, head: heads.get(o.owner) });
    }
  }
  posts.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  // 快拍条：有活着的快拍的 owner 才出现。用户那个例外 —— 一条都没有也要显示
  // 「你的快拍 +」，那是发快拍的入口
  const rings = [];
  for (const o of owners) {
    const live = activeStories(o.owner, hours, now);
    if (!live.length && !o.isUser) continue;
    rings.push({
      ...heads.get(o.owner),
      stories: live,
      // 全看过了的圈是灰的（IG 的规则），这里先都算没看过 —— 用户点开就标
      seen: false,
    });
  }

  return { posts, rings, storyHours: hours, owners };
}

/**
 * 一个人的主页。
 *
 * `expired` 是**过期的快拍**：用户自己的在自己主页找、角色的点头像进来看
 * —— 用户明确要的这条（「用户的在自己主页找到，角色的点头像看」）。
 */
export function igProfileView(config, owner) {
  const settings = readSettings();
  const hours = settings.storyHours ?? DEFAULT_STORY_HOURS;
  const now = Date.now();
  const highlights = readHighlights(owner);
  const all = readStories(owner);
  const byId = new Map(all.map((s) => [s.id, s]));

  return {
    ...headerFor(config, owner),
    // 和 feed 一样按时间倒序。存的时候是 unshift，正常发帖本来就是新的在前，
    // 但排一遍才保证九宫格和 feed 说的是同一件事（改过 createdAt 的帖子、
    // 导进来的旧数据都可能是乱的）
    posts: [...readPosts(owner)].sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)
    ),
    active: activeStories(owner, hours, now),
    expired: expiredStories(owner, hours, now),
    // 精选里的快拍**不受过期影响** —— 存进精选就是为了长期留着
    highlights: highlights.map((h) => ({
      ...h,
      stories: h.storyIds.map((id) => byId.get(id)).filter(Boolean),
    })),
    maxHighlights: MAX_HIGHLIGHTS,
    storyHours: hours,
  };
}

/**
 * 一条评论线程里，角色之间已经来回了几条。
 *
 * **首评不计。** A 评论了帖子（第 0 条）、B 回 A（第 1 条）、A 再回 B（第 2 条），
 * maxChain=2 时到这里停 —— 这正好是用户给的那个例子（「结束，不会再触发，
 * 以免变成永动机」）。
 *
 * 「一条线程」= 一条顶层评论及其所有回复，按 `replyTo` 串起来。**按线程算不按
 * 帖子算**：同一条帖子下面 A-B 聊一串、C-D 再聊一串，两串各有自己的额度，
 * 不会因为别人先聊满了就把后面的堵死。
 *
 * 用**帖主**的 maxChain：那是「这个人的帖子下面能有多热闹」，由帖主定比由
 * 每个参与者各自定要一致 —— 后者会出现 A 觉得能回、B 觉得不能回的拉锯。
 *
 * @param {object} post 帖子对象
 * @param {string} rootId 顶层评论的 id
 * @returns {number} 那条线程里**角色之间**的回复条数（用户参与的不算）
 */
export function threadReplyCount(post, rootId) {
  const comments = post?.comments ?? [];
  const root = comments.find((c) => c.id === rootId);
  if (!root) return 0;

  // 线程里除首评之外的评论，且发出者不是用户 —— 用户回自己的帖子不该消耗
  // 角色间的额度（那是用户在跟角色聊，不是角色在自娱自乐）
  const inThread = new Set([rootId]);
  // 平铺结构，扫两遍就能把两层都收进来（IG 的评论只有两层）
  for (const c of comments) {
    if (c.replyTo && inThread.has(c.replyTo)) inThread.add(c.id);
  }
  for (const c of comments) {
    if (c.replyTo && inThread.has(c.replyTo)) inThread.add(c.id);
  }

  return comments.filter(
    (c) => inThread.has(c.id) && c.id !== rootId && c.owner !== USER_OWNER
  ).length;
}

/**
 * 这条线程还能不能再让角色回一句。
 *
 * @param {object} post 帖子（用帖主的 maxChain）
 * @param {string} rootId 顶层评论 id
 * @param {number} maxChain 帖主的上限
 */
export function canChain(post, rootId, maxChain) {
  const max = Number(maxChain);
  if (!Number.isFinite(max) || max <= 0) return false;
  return threadReplyCount(post, rootId) < max;
}

/**
 * 一个角色允许和哪些**别的角色**互动。
 *
 * 看的是**动作发起方自己**那份名单（用户确认过这条）：A 想回 B 的评论，
 * 查的是 A 的 peers 里有没有 B。不做双向校验 —— 那等于要两边都勾上，
 * 而用户的表述是「可以互动的角色（可多选，不选则不互动）」，单向。
 */
export function peerAllowed(config, actorRole, targetOwner) {
  if (!actorRole?.instagram?.enabled) return false;
  const peers = actorRole.instagram.peers ?? [];
  if (!peers.length) return false;
  const target = roleFor(config, targetOwner);
  if (!target) return false;
  // peers 里存的是角色 id
  return peers.includes(String(target.id ?? ""));
}
