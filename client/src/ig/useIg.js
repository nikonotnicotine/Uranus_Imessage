/**
 * IG 的数据层：拉 feed / 主页，以及所有写操作。
 *
 * ── 为什么不走 useConfig ──
 *
 * 控制台那套是「改草稿 → 点保存 → PUT /api/config」，而 `PUT /api/config` 会
 * syncBridges，把所有 Photon 线路重启一遍。IG 是**点一下就落盘**（点赞、评论、
 * 发帖），走那条路等于每次互动踢线路。所以这里自己管 `/api/ig/*`，和 config
 * 完全不相干 —— 唯一的交集是角色开关（role.instagram），那个还是走配置。
 *
 * 每个写操作后面都跟一次 `reload()`：IG 的数据是服务端算出来的（feed 要混排、
 * 快拍要算过期），本地拼一份等于把那些规则抄第二遍，抄错了就和服务端不一致。
 * 数据量就那么点，多一次 GET 换掉一整类 bug。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../store.jsx";

/**
 * 「这个组件还在不在」——请求回来以后拿它挡掉卸载后的 setState。
 *
 * 挂载时必须**重新置 true**：StrictMode 下开发模式会把 effect 跑成
 * 挂载 → 清理 → 再挂载，只在清理里写 false 的话，第二次挂载就是个
 * 永远关着的闸门，两次请求都 200 回来了也没人收，界面卡在「正在加载…」。
 */
function useAlive() {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return alive;
}

/**
 * 首页 feed + 快拍条。
 *
 * `owners` 是「谁在 IG 上」（用户 + 开了 IG 的角色），主页那边也要用，
 * 所以一起从这条接口回来，省一次请求。
 */
export function useFeed() {
  const [data, setData] = useState({ posts: [], rings: [], owners: [], storyHours: 24 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const alive = useAlive();

  const reload = useCallback(async () => {
    try {
      const next = await api("/api/ig/feed");
      if (alive.current) {
        setData(next);
        setError("");
      }
    } catch (e) {
      if (alive.current) setError(String(e?.message ?? e));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { ...data, loading, error, reload };
}

/** 一个人的主页。owner 变了就重新拉。 */
export function useProfile(owner) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const alive = useAlive();

  const reload = useCallback(async () => {
    if (!owner) return;
    try {
      const next = await api(`/api/ig/profile/${encodeURIComponent(owner)}`);
      if (alive.current) {
        setData(next);
        setError("");
      }
    } catch (e) {
      if (alive.current) setError(String(e?.message ?? e));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [owner]);

  useEffect(() => {
    setLoading(true);
    reload();
  }, [reload]);

  return { data, loading, error, reload };
}

/** 互动记录（右上角那个爱心）。 */
export function useActivity() {
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);

  const reload = useCallback(async () => {
    try {
      const next = await api("/api/ig/activity");
      setItems(next.items ?? []);
      setUnread(next.unread ?? 0);
    } catch {
      /* 互动记录拉不到不该挡住整个页面 */
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const markRead = useCallback(async () => {
    try {
      const next = await api("/api/ig/activity/read", { method: "POST" });
      setItems(next.items ?? []);
      setUnread(0);
    } catch {
      /* 同上 */
    }
  }, []);

  return { items, unread, reload, markRead };
}

/** 全局设置（快拍时长、默认版式、提示词模板）。 */
export function useIgSettings() {
  const [settings, setSettings] = useState(null);

  const reload = useCallback(async () => {
    try {
      setSettings(await api("/api/ig/settings"));
    } catch {
      /* 用默认值继续 */
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const save = useCallback(async (patch) => {
    const next = await api("/api/ig/settings", { method: "PUT", body: patch });
    setSettings(next);
    return next;
  }, []);

  return { settings, save, reload };
}

/**
 * 真 Instagram 的状态：每个角色绑了谁、token 还剩几天、图床配没配。
 *
 * 返回的东西里**没有任何凭据** —— 后端只回用户名和「配好了没有」，token 和
 * 图床 secret 一个字节都不下来（igreal.js:realOverview）。所以这份状态可以
 * 随便放进 React state，不用担心它跟着别的东西被打进日志或截图。
 */
export function useRealIg() {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setData(await api("/api/ig/real"));
    } catch {
      /* 拉不到就当没绑，界面上照样能填 */
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  /** 绑定 / 解绑（token 传空串 = 解绑）。会真打一次 Meta 的接口，可能要几秒。 */
  const bind = useCallback(async (roleName, token) => {
    setBusy(true);
    try {
      const next = await api("/api/ig/real/bind", {
        method: "POST",
        body: { roleName, token },
      });
      setData(next);
      return next;
    } finally {
      setBusy(false);
    }
  }, []);

  const save = useCallback(async (patch) => {
    const next = await api("/api/ig/real/settings", { method: "PUT", body: patch });
    setData(next);
    return next;
  }, []);

  /** 立刻同步一次。续期 + 拉帖子 + 拉每个角色的评论，慢，按钮要禁用到回来。 */
  const poll = useCallback(async () => {
    setBusy(true);
    try {
      const next = await api("/api/ig/real/poll", { method: "POST" });
      setData(next);
      return next;
    } finally {
      setBusy(false);
    }
  }, []);

  return { data, busy, reload, bind, save, poll };
}

/* ================= 写操作 ================= */

const enc = encodeURIComponent;

export const igApi = {
  /** 上传一张图，返回 media/ 下的文件名。 */
  async uploadMedia(base64, mimeType) {
    const r = await api("/api/ig/media", { method: "POST", body: { base64, mimeType } });
    if (!r.ok) throw new Error(r.error || "图片没能存下来");
    return r.file;
  },

  savePost(owner, body) {
    return api(`/api/ig/posts/${enc(owner)}`, { method: "POST", body });
  },
  editPost(owner, id, body) {
    return api(`/api/ig/posts/${enc(owner)}/${enc(id)}`, { method: "PUT", body });
  },
  deletePost(owner, id) {
    return api(`/api/ig/posts/${enc(owner)}/${enc(id)}`, { method: "DELETE" });
  },
  likePost(owner, id, actor = "user") {
    return api(`/api/ig/posts/${enc(owner)}/${enc(id)}/like`, {
      method: "POST",
      body: { actor },
    });
  },
  comment(owner, id, body) {
    return api(`/api/ig/posts/${enc(owner)}/${enc(id)}/comments`, { method: "POST", body });
  },
  deleteComment(owner, id, commentId) {
    return api(`/api/ig/posts/${enc(owner)}/${enc(id)}/comments/${enc(commentId)}`, {
      method: "DELETE",
    });
  },

  saveStory(owner, body) {
    return api(`/api/ig/stories/${enc(owner)}`, { method: "POST", body });
  },
  editStory(owner, id, body) {
    return api(`/api/ig/stories/${enc(owner)}/${enc(id)}`, { method: "PUT", body });
  },
  deleteStory(owner, id) {
    return api(`/api/ig/stories/${enc(owner)}/${enc(id)}`, { method: "DELETE" });
  },

  /** 存进精选。满三个时后端返回 409，错误信息里写了「先删一个」。 */
  saveHighlight(owner, body) {
    return api(`/api/ig/highlights/${enc(owner)}`, { method: "POST", body });
  },
  editHighlights(owner, highlights) {
    return api(`/api/ig/highlights/${enc(owner)}`, { method: "PUT", body: { highlights } });
  },
  deleteHighlight(owner, id) {
    return api(`/api/ig/highlights/${enc(owner)}/${enc(id)}`, { method: "DELETE" });
  },

  saveProfile(owner, body) {
    return api(`/api/ig/profile/${enc(owner)}`, { method: "PUT", body });
  },

  /**
   * 把一条已经在本地的帖子 / 快拍补发到真 IG。
   *
   * 幂等 —— 已经发过的直接返回成功，不会在真 IG 上出现两条。返回
   * `{ok, error}`：`ok` 为假时 `error` 是一句中文原因（「图床还没配」这种），
   * 要原样显示给用户。
   */
  publishReal(owner, id, isStory = false) {
    return api(`/api/ig/real/publish/${enc(owner)}/${enc(id)}`, {
      method: "POST",
      body: { isStory },
    });
  },
};
