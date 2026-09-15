/**
 * 控制台里的 Instagram 编辑弹层：编辑主页、替谁发帖 / 发快拍、改帖子、精选。
 *
 * 和 `../ig/editors.jsx` 是**有意重复的一对**。那边留给 IG 页面自己
 * （右上角 + 号那个发布框），这边给控制台。保存逻辑逐字一样（都打 `igApi`），
 * 不一样的只有样式：那边是 `.ig-*`，这边是控制台的 Modal / Field / Button。
 *
 * 为什么不共用一份、外面套个壳：控制台是灰白 + 衬线 + 1px 描边那一套，
 * IG 是圆角蓝按钮那一套。把 IG 样式的弹层开在控制台里，出来的东西就是
 * 「控制台里嵌了个 IG 截图」—— 这回把 IG 拆出去单开一个端口，治的正是这个毛病。
 * 宁可两份各自干净，也别造一个两头不像的混血组件。
 *
 * ⚠ 所有组件都定义在模块顶层。写进某个父组件里的话，父组件每渲染一次
 * React 就当它是新类型、把整棵子树卸了重建 —— textarea 每敲一个字都会丢焦点。
 */

import { useRef, useState } from "react";
import { CircleAlert, ImagePlus, Loader2, X } from "lucide-react";

import { MAX_INPUT_BYTES, REF_MAX_SIDE, compressImage } from "../imagefile.js";
import { Button, Field, Modal, ResultNote, Switch, inputCls } from "../ui.jsx";
import { igMediaUrl } from "../ig/parts.jsx";
import { igApi } from "../ig/useIg.js";

/** 单行 / 多行文本框。`ui.jsx` 的 Field 只管标签和提示，输入框得自己塞。 */
function TextField({ label, value, onChange, placeholder, hint, area = false }) {
  return (
    <Field label={label} hint={hint}>
      {area ? (
        <textarea
          className={`${inputCls} min-h-[80px] resize-y`}
          value={value ?? ""}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          className={inputCls}
          value={value ?? ""}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

/** 错误条。空字符串就什么都不显示。 */
function Err({ message }) {
  return <ResultNote state={message ? "fail" : "idle"} message={message} icon={CircleAlert} />;
}

/**
 * 挑图的那一块：已选的图 + 一个「加图」格。
 *
 * 上传前先压到 1600px 长边（和参考图一个规格，见 imagefile.js）——
 * 手机拍的照片动辄 4000px，原样存进 data/instagram/media/ 只是浪费磁盘。
 * 压缩在**浏览器里**做：Node 那头攥着几条活的 Photon 线路，让它去解码大图
 * 迟早被系统按内存杀掉。
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
    <Field label="图片" hint={`最多 ${max} 张。上传时会压到长边 ${REF_MAX_SIDE}px。`}>
      <div className="mt-1 grid grid-cols-4 gap-2 sm:grid-cols-5">
        {images.map((im, i) => (
          <div key={`${im.file}-${i}`} className="relative aspect-square border border-line">
            {im.file ? (
              <img src={igMediaUrl(im.file)} alt={im.alt || ""} className="h-full w-full object-cover" />
            ) : (
              /* 只有描述没有文件：模型写了 [image:…] 但生图关着 */
              <div className="h-full w-full overflow-hidden p-1.5 text-[10px] leading-snug text-ink-faint">
                {im.alt}
              </div>
            )}
            <button
              type="button"
              aria-label="移除这张"
              onClick={() => onChange(images.filter((_, j) => j !== i))}
              className="absolute right-0 top-0 border-b border-l border-line bg-paper p-1 text-ink-faint transition-colors duration-150 hover:text-ink"
            >
              <X size={12} />
            </button>
          </div>
        ))}
        {images.length < max && (
          <button
            type="button"
            aria-label="添加图片"
            onClick={() => input.current?.click()}
            className="flex aspect-square items-center justify-center border border-dashed border-line text-ink-faint transition-colors duration-150 hover:border-ink hover:text-ink"
          >
            {busy ? <Loader2 size={18} className="animate-spin" /> : <ImagePlus size={18} />}
          </button>
        )}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => add(e.target.files)}
      />
      <Err message={error} />
    </Field>
  );
}

/**
 * 编辑主页：八个字段（名字、账号、头像、帖子数、粉丝、关注、简介、链接）。
 *
 * 三个计数是**文本框而不是数字框**：IG 上大号显示的是「1,137万」这种，
 * 用户想照抄一个就得能填任意文本。留空 = 显示真实数量。
 */
export function ProfileEditor({ owner, profile, realPosts, onClose, onSaved }) {
  const [draft, setDraft] = useState({ ...profile });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef(null);

  const set = (k) => (v) => setDraft((d) => ({ ...d, [k]: v }));

  const pickAvatar = async (file) => {
    if (!file) return;
    setError("");
    setBusy(true);
    try {
      // 头像 400px 够了，比参考图小一档
      const { base64, mimeType } = await compressImage(file, { maxSide: 400 });
      const saved = await igApi.uploadMedia(base64, mimeType);
      setDraft((d) => ({ ...d, avatar: saved }));
    } catch (e) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await igApi.saveProfile(owner, draft);
      onSaved?.();
      onClose?.();
    } catch (e) {
      setError(String(e?.message ?? e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={owner === "user" ? "编辑我的主页" : `编辑 ${owner} 的主页`}
      desc="这些字段只影响 Instagram 页上显示的样子，不改角色本身。"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? "保存中…" : "保存"}
          </Button>
        </>
      }
    >
      <div className="grid gap-6">
        <Field
          label="头像"
          hint="留空时用这个角色在 iMessage 那边的头像。用户自己没有 iMessage 头像，留空会显示名字首字。"
        >
          <div className="mt-1 flex items-center gap-3">
            <div className="h-16 w-16 shrink-0 overflow-hidden rounded-full border border-line bg-sunken">
              {draft.avatar ? (
                <img src={igMediaUrl(draft.avatar)} alt="" className="h-full w-full object-cover" />
              ) : null}
            </div>
            <Button variant="outline" onClick={() => input.current?.click()}>
              换一张
            </Button>
            {draft.avatar ? (
              <Button variant="ghost" onClick={() => set("avatar")("")}>
                清空
              </Button>
            ) : null}
          </div>
          <input
            ref={input}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => pickAvatar(e.target.files?.[0])}
          />
        </Field>

        <TextField
          label="名字"
          value={draft.name}
          onChange={set("name")}
          placeholder="显示在主页上的名字"
        />
        <TextField
          label="账号"
          value={draft.username}
          onChange={set("username")}
          placeholder="@ 后面那一串"
          hint="留空时用名字。"
        />
        <TextField
          label="帖子数"
          value={draft.posts}
          onChange={set("posts")}
          placeholder={String(realPosts ?? 0)}
          hint={`留空显示真实数量（现在 ${realPosts ?? 0} 条）。`}
        />
        <TextField label="粉丝" value={draft.followers} onChange={set("followers")} placeholder="0" />
        <TextField
          label="关注"
          value={draft.following}
          onChange={set("following")}
          placeholder="0"
          hint="这两个可以随便填，「1,137万」这种也行。"
        />
        <TextField label="简介" value={draft.bio} onChange={set("bio")} area />
        <TextField label="链接" value={draft.link} onChange={set("link")} placeholder="https://" />

        <div className="flex items-center justify-between gap-4 border-t border-line pt-5">
          <div className="min-w-0">
            <div className="text-ui text-ink">显示蓝色认证勾</div>
            <p className="mt-0.5 text-meta text-ink-faint">名字后面那个蓝标。</p>
          </div>
          <Switch
            checked={Boolean(draft.verified)}
            onChange={set("verified")}
            label="显示蓝色认证勾"
          />
        </div>

        <Err message={error} />
      </div>
    </Modal>
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

  // owner 是角色名（用户那条是固定的 "user"），名字多半是拉丁字母，两边留个空格
  const noun = isStory ? "快拍" : "帖子";
  const title = post
    ? `编辑${noun}`
    : owner === "user"
      ? `发一条${noun}`
      : `替 ${owner} 发一条${noun}`;

  return (
    <Modal
      title={title}
      desc={`这条会进角色的上下文，模型下一轮就知道${owner === "user" ? "你" : "它"}发了什么。`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button onClick={save} disabled={busy || (!caption.trim() && !images.length)}>
            {busy ? "发布中…" : post ? "保存" : "发布"}
          </Button>
        </>
      }
    >
      <div className="grid gap-6">
        <ImagePicker images={images} onChange={setImages} max={isStory ? 1 : 10} />
        <TextField
          label="配文"
          value={caption}
          onChange={setCaption}
          area
          placeholder={isStory ? "快拍上的文字（可以不填）" : "写点什么…"}
        />
        <Err message={error} />
      </div>
    </Modal>
  );
}

/**
 * 新建 / 编辑一组精选。
 *
 * 封面和标题**用户自己设**（用户明确要求）—— 不自动取第一张图。
 * 最多三组，满了之后后端返回 409，这里把那句话显示出来。
 */
export function HighlightEditor({ owner, stories = [], highlight = null, onClose, onSaved }) {
  const [title, setTitle] = useState(highlight?.title ?? "精选");
  const [cover, setCover] = useState(highlight?.cover ?? "");
  const [picked, setPicked] = useState(() => new Set(highlight?.storyIds ?? []));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef(null);

  const pickCover = async (file) => {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const { base64, mimeType } = await compressImage(file, { maxSide: 400 });
      setCover(await igApi.uploadMedia(base64, mimeType));
    } catch (e) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  const toggle = (id) => {
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const ids = [...picked];
      /*
       * 一条不挑就不给存 —— 改和新建都一样。
       * 空的一组在主页上是个点不开的圈（IG 那边打开播放器就是一片黑），
       * 真想把它清掉应该走「删除」，不是把里面掏空。
       */
      if (!ids.length) {
        setError("至少挑一条快拍。整组不要了就点外面那个「删除」。");
        setBusy(false);
        return;
      }
      if (highlight) {
        // 改：整组覆盖写回去
        await igApi.editHighlights(owner, [{ ...highlight, title, cover, storyIds: ids }]);
      } else {
        // 新建：先用第一条快拍开一组，再把其余的加进去
        const r = await igApi.saveHighlight(owner, { storyId: ids[0], title, cover });
        for (const id of ids.slice(1)) {
          await igApi.saveHighlight(owner, { storyId: id, highlightId: r.highlight.id });
        }
      }
      onSaved?.();
      onClose?.();
    } catch (e) {
      setError(String(e?.message ?? e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={highlight ? "编辑精选" : "新建精选"}
      desc="精选留的是已经过期的快拍。最多三组 —— 手机上那一排放不下第四个。"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? "保存中…" : "保存"}
          </Button>
        </>
      }
    >
      <div className="grid gap-6">
        <TextField label="标题" value={title} onChange={setTitle} placeholder="精选的名字" />

        <Field label="封面" hint="封面和标题都由你自己定，不会自动取第一张图。">
          <div className="mt-1 flex items-center gap-3">
            <div className="h-16 w-16 shrink-0 overflow-hidden rounded-full border border-line bg-sunken">
              {cover ? (
                <img src={igMediaUrl(cover)} alt="" className="h-full w-full object-cover" />
              ) : null}
            </div>
            <Button variant="outline" onClick={() => input.current?.click()}>
              选一张
            </Button>
            {cover ? (
              <Button variant="ghost" onClick={() => setCover("")}>
                清空
              </Button>
            ) : null}
          </div>
          <input
            ref={input}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => pickCover(e.target.files?.[0])}
          />
        </Field>

        <Field label={`收哪些快拍（已选 ${picked.size} 条）`}>
          {stories.length ? (
            <div className="mt-1 grid grid-cols-4 gap-2 sm:grid-cols-5">
              {stories.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => toggle(s.id)}
                  className={`aspect-square overflow-hidden border transition-colors duration-150 ${
                    picked.has(s.id) ? "border-ink ring-1 ring-ink" : "border-line hover:border-ink-faint"
                  }`}
                >
                  {s.image?.file ? (
                    <img src={igMediaUrl(s.image.file)} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <div className="h-full w-full overflow-hidden p-1.5 text-left text-[10px] leading-snug text-ink-faint">
                      {s.caption || s.image?.alt}
                    </div>
                  )}
                </button>
              ))}
            </div>
          ) : (
            <p className="mt-1 text-meta text-ink-faint">还没有快拍可以收。</p>
          )}
        </Field>

        <Err message={error} />
      </div>
    </Modal>
  );
}
