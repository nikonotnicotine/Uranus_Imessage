/**
 * IG 页面自己的发布弹层：右上角 + 号点出来的那个，发帖 / 发快拍两用。
 *
 * 这里**只剩自己发东西这一件事**。编辑主页、替角色发、改角色的帖子、管精选，
 * 全搬去控制台了（见 ../panels/igeditors.jsx）—— 用户要的是「IG 页就是 IG，
 * 设置都在 Uranus 那边」。那边的保存逻辑和这里逐字一样，只是换了一套样式。
 *
 * 这个弹层是**功能性界面**，不是 IG 的仿真部分 —— 但它开在 IG 里，所以走
 * `.ig-modal` 那套朴素样式，而不是控制台的衬线大标题。
 */

import { useRef, useState } from "react";
import { ImagePlus, Loader2, X } from "lucide-react";

import { MAX_INPUT_BYTES, REF_MAX_SIDE, compressImage } from "../imagefile.js";
import { Field, Modal, igMediaUrl } from "./parts.jsx";
import { igApi } from "./useIg.js";

/**
 * 挑图的那一块：已选的图 + 一个「加图」格。
 *
 * 上传前先压到 1600px 长边（和参考图一个规格，见 imagefile.js）——
 * 手机拍的照片动辄 4000px，原样存进 data/instagram/media/ 只是浪费磁盘。
 */
function ImagePicker({ images, onChange, max = 10 }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef(null);

  const add = async (files) => {
    setError("");
    setBusy(true);
    try {
      const next = [...images];
      for (const file of Array.from(files ?? []).slice(0, max - images.length)) {
        if (file.size > MAX_INPUT_BYTES) {
          setError(`${file.name} 太大了（超过 20MB）`);
          continue;
        }
        const { base64, mimeType } = await compressImage(file, { maxSide: REF_MAX_SIDE });
        const saved = await igApi.uploadMedia(base64, mimeType);
        next.push({ file: saved, alt: "" });
      }
      onChange(next);
    } catch (e) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
      // 同一张图连着选两次也要触发 change
      if (input.current) input.current.value = "";
    }
  };

  return (
    <div className="ig-field">
      <span>图片</span>
      <div className="ig-picks">
        {images.map((im, i) => (
          <div className="ig-pick" key={`${im.file}-${i}`}>
            {im.file ? (
              <img src={igMediaUrl(im.file)} alt={im.alt || ""} />
            ) : (
              /* 只有描述没有文件：这是模型写的 [image:…] 还没生成图的状态 */
              <div className="ig-cell-text">{im.alt}</div>
            )}
            <button
              type="button"
              className="ig-pick-del"
              aria-label="移除这张"
              onClick={() => onChange(images.filter((_, j) => j !== i))}
            >
              <X size={14} />
            </button>
          </div>
        ))}
        {images.length < max ? (
          <button
            type="button"
            className="ig-pick"
            onClick={() => input.current?.click()}
            aria-label="添加图片"
            style={{ display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            {busy ? <Loader2 size={22} className="ig-spin" /> : <ImagePlus size={22} />}
          </button>
        ) : null}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => add(e.target.files)}
      />
      {error ? <small style={{ color: "var(--ig-red)" }}>{error}</small> : null}
      <small>最多 {max} 张。上传时会压到长边 {REF_MAX_SIDE}px。</small>
    </div>
  );
}

/**
 * 发帖 / 发快拍 / 改帖子，一个弹层三用。
 *
 * `kind` 是 "post" 还是 "story"；`post` 传了就是改，没传就是发新的。
 * 快拍只有一张图 —— IG 的快拍就是一张，多图是多条快拍。
 */
export function PostEditor({ owner, kind = "post", post = null, onClose, onSaved }) {
  const isStory = kind === "story";
  const [caption, setCaption] = useState(post?.caption ?? "");
  const [images, setImages] = useState(() => {
    if (post?.images) return post.images;
    if (post?.image?.file || post?.image?.alt) return [post.image];
    return [];
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      if (isStory) {
        const body = { caption, image: images[0] ?? { file: "", alt: "" } };
        if (post) await igApi.editStory(owner, post.id, body);
        else await igApi.saveStory(owner, body);
      } else {
        const body = { caption, images };
        if (post) await igApi.editPost(owner, post.id, body);
        else await igApi.savePost(owner, body);
      }
      onSaved?.();
      onClose?.();
    } catch (e) {
      setError(String(e?.message ?? e));
      setBusy(false);
    }
  };

  const title = post
    ? isStory
      ? "编辑快拍"
      : "编辑帖子"
    : isStory
      ? `替 ${owner === "user" ? "自己" : owner} 发一条快拍`
      : `替 ${owner === "user" ? "自己" : owner} 发一条帖子`;

  return (
    <Modal
      title={title}
      onClose={onClose}
      foot={
        <>
          <button type="button" className="ig-btn ig-btn-soft" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="ig-btn"
            onClick={save}
            disabled={busy || (!caption.trim() && !images.length)}
          >
            {busy ? "发布中…" : post ? "保存" : "发布"}
          </button>
        </>
      }
    >
      <ImagePicker images={images} onChange={setImages} max={isStory ? 1 : 10} />
      <Field
        label="配文"
        value={caption}
        onChange={setCaption}
        area
        placeholder={isStory ? "快拍上的文字（可以不填）" : "写点什么…"}
      />
      <small style={{ color: "var(--ig-text-soft)" }}>
        这条会进角色的上下文，模型下一轮就知道{owner === "user" ? "你" : "它"}发了什么。
      </small>
      {error ? <small style={{ color: "var(--ig-red)" }}>{error}</small> : null}
    </Modal>
  );
}
