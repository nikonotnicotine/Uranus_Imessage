/**
 * 线下模式那两张头像的上传和取图。
 *
 * 单独一个文件是因为**两处都要用**：角色页的「线下模式」那一栏在这儿挑图，
 * 「对话框」面板在这儿把它画到气泡旁边。放在其中任何一个面板里，另一个就得
 * 反过来 import 一个面板文件 —— 那是要绕成环的开始。
 *
 * 和 `ig/parts.jsx:igMediaUrl` + `panels/igeditors.jsx` 里那段上传是同一套写法，
 * 只是打的是 `/api/offline/media`。压缩规格照 IG 头像：长边 400px 够了，
 * 对话框里画出来才 36px。
 */

import { compressImage } from "./imagefile.js";
import { api } from "./store.jsx";

/** 头像的长边上限。比参考图（1600）小一档 —— 它最大也只画到 40px。 */
export const AVATAR_MAX_SIDE = 400;

/**
 * 一张头像的地址。文件名要 encode —— 后端那头用白名单卡死了
 * （`[A-Za-z0-9_.-]`），但地址里带 `.` 之外的东西照样得转义。
 */
export function offlineMediaUrl(file) {
  const name = String(file ?? "").trim();
  return name ? `/api/offline/media/${encodeURIComponent(name)}` : "";
}

/**
 * 浏览器里压一遍再传，返回落盘后的文件名。
 *
 * 压缩在**前端**做（imagefile.js），和参考图 / IG 那两处一个道理：手机拍的
 * 照片动辄 4000px 好几兆，原样 base64 发上去只是让请求体白白胀大。
 *
 * 存到哪个字段（`role.offline.avatar` 还是 `userAvatar`）由调用方连着角色一起
 * `PUT /api/config` 存 —— 这个函数只管把图片放进 `data/offline/media/`。
 */
export async function uploadOfflineAvatar(file) {
  const { base64, mimeType } = await compressImage(file, { maxSide: AVATAR_MAX_SIDE });
  const r = await api("/api/offline/media", {
    method: "POST",
    body: { base64, mimeType },
  });
  // 写盘失败回的是 200 + {ok:false}（不是 4xx），api() 不会 throw ——
  // 不在这儿拦一下，一张根本没落盘的图会被当成「传好了」存进配置
  if (r?.ok === false || !r?.file) throw new Error(r?.error || "这张图没能存进硬盘");
  return r.file;
}
