/*
 * 图库：两半，共用一个分区。
 *
 * 上半是**参考图** —— 图生图的那份清单。一条记录 = 名称 + 描述，名称一个词兼三个
 * 身份，改名的代价比看上去大，界面上要说清楚：
 *   1. images/参考图 文件夹里的文件名（不带后缀）
 *   2. 模型写在 [image:…][小猫] 后面那个方括号里的词
 *   3. 角色 imageGen.refs 里存的值（改名之后那边的引用会失效，角色面板会标出来）
 * 图片可以直接在这儿传（浏览器里压完再传，为什么见 imagefile.js），也可以照旧自己
 * 丢进文件夹。所以这半的核心是「配置里填的这条，文件夹里到底有没有对应的文件」。
 *
 * 下半是**表情包** —— 角色能整张发出去的图。这半在 config 里**一个字段都不占**：
 * 一个标签就是 images/emojis/ 下的一个文件夹，建标签、传图、删图全是直接改硬盘，
 * 立刻生效、不用点保存。硬盘上有图的标签默认全都注入给模型，只被角色自己的黑名单
 * 减一遍（黑名单只在「角色 → 单独配置 → 发送表情包」里设，这儿不重复摆一份）。
 * 所以这半的核心是缩略图 + 上传 + 删文件，删的是**硬盘上的文件，没有回收站**。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { SaveBar, useSection } from "../section.jsx";
import { api, useConfig } from "../store.jsx";
import { Button, Card, Field, inputCls } from "../ui.jsx";
import { EMOJI_MAX_SIDE, REF_MAX_SIDE, compressImage } from "../imagefile.js";
import { Plus, RefreshCw, Trash2, Upload, X } from "lucide-react";

/**
 * 侧栏里表情包条目的 id 前缀。
 *
 * 参考图那些是 `r-xxxx`（uid 生成的），表情包用 `emoji:标签` —— 两组条目
 * 挤在同一个 itemId 里，得能一眼分开。标签本身不可能以这个前缀开头：
 * 冒号在 normalizeEmojiTag 里就被剃掉了，文件夹名也带不了它。
 */
const EMOJI_PREFIX = "emoji:";

/** 一次先铺这么多张缩略图，多的点「显示全部」再出来。 */
const THUMB_PAGE = 120;

/**
 * images 文件夹里实际有哪些图片。
 *
 * 每次进面板拉一次就够了 —— 用户往文件夹里放图是在浏览器外面做的，
 * 放完回来点「重新扫描」。轮询没意义，只会白打请求。
 */
function useRefFiles() {
  const [state, setState] = useState({ files: [], dir: "", loading: true });

  const reload = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const r = await api("/api/images");
      setState({ files: r.files ?? [], dir: r.dir ?? "", loading: false });
    } catch {
      // 拉不到就当文件夹是空的：那样每条都会显示「找不到文件」，
      // 比假装一切正常好 —— 至少用户会去看后端起没起来
      setState({ files: [], dir: "", loading: false });
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { ...state, reload };
}

/**
 * emojis 文件夹下有哪些标签，各有几张图。
 *
 * 和上面那个一样是「进来拉一次 + 手动重扫」。区别是这份还要喂给 260px 那栏
 * （nav.js 里图库的第二组是 `live` 的），所以拉失败时要把错留下 ——
 * 侧栏空掉的时候用户得知道是后端没起来，还是文件夹真是空的。
 */
function useEmojiTags() {
  const [state, setState] = useState({ tags: [], dir: "", loading: true, error: "" });

  const reload = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const r = await api("/api/emojis");
      setState({ tags: r.tags ?? [], dir: r.dir ?? "", loading: false, error: "" });
    } catch (e) {
      setState({ tags: [], dir: "", loading: false, error: e.message || "读不到表情包文件夹" });
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { ...state, reload };
}

/**
 * 「上传图片…」按钮：选文件 → 在浏览器里压 → 一张张 POST 上去。
 *
 * 压缩的规矩全在 imagefile.js 里（为什么不放后端也写在那儿）。这个组件只管两件事：
 *
 *   - **一张一张来。** 并发解码会把标签页的内存顶起来，同时几十个请求也会把
 *     后端那点写盘 IO 挤爆 —— 那个进程还挂着几条真在收发消息的线路。
 *   - **坏一张不停整批。** 二十张里有一张压不动，剩下十九张照传，最后把出问题
 *     的那几张连原因一起列出来，而不是弹一句「上传失败」就完了。
 *
 * @param {number} maxSide 长边压到多少（参考图 1600、表情包 720）
 * @param {(img) => Promise<any>} upload 单张怎么传，返回值会攒起来交给 onDone
 * @param {(results) => any} onDone 至少成了一张才调，用来重扫文件夹
 */
function UploadButton({ maxSide, upload, onDone, hint }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [at, setAt] = useState({ done: 0, total: 0 });
  const [done, setDone] = useState(0);
  const [errors, setErrors] = useState([]);

  async function pick(e) {
    const files = [...(e.target.files ?? [])];
    // 立刻清空：不清的话连传两次同一个文件不会触发 change，用户会以为按钮坏了
    e.target.value = "";
    if (!files.length) return;

    setBusy(true);
    setErrors([]);
    setDone(0);
    setAt({ done: 0, total: files.length });

    const results = [];
    const bad = [];
    for (const file of files) {
      try {
        const img = await compressImage(file, { maxSide });
        const r = await upload(img);
        // 上传那两条路由写盘失败时回的是 200 + {ok:false}（不是 4xx），
        // api() 不会 throw —— 不在这儿拦一下，一张根本没落盘的图会被算成「成功」
        if (r?.ok === false) throw new Error(r.error || `「${file.name}」没能写进硬盘`);
        results.push(r);
      } catch (err) {
        bad.push(err?.message || `「${file.name}」传不上去`);
      }
      setAt((s) => ({ ...s, done: s.done + 1 }));
    }

    setDone(results.length);
    setErrors(bad);
    setBusy(false);
    if (results.length) await onDone?.(results);
  }

  return (
    <div className="grid grid-cols-1 gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={pick}
        />
        <Button variant="outline" disabled={busy} onClick={() => inputRef.current?.click()}>
          <Upload size={14} />
          {busy ? `上传中… ${at.done}/${at.total}` : "上传图片…"}
        </Button>
        <p className="text-meta text-ink-faint">
          {busy ? "压缩和上传都在这一步，别关页面" : done > 0 ? `刚传了 ${done} 张` : hint}
        </p>
      </div>
      {errors.map((msg) => (
        <p key={msg} className="text-meta leading-relaxed text-warn">
          {msg}
        </p>
      ))}
    </div>
  );
}

export function GalleryPanel({ onGoto }) {
  const { config, addReferenceImage, updateReferenceImage } = useConfig();
  const { itemId, pick, publish } = useSection();
  const refs = config.referenceImages ?? [];
  const refFiles = useRefFiles();
  const emojis = useEmojiTags();

  /*
   * 260px 那栏「表情包」那一组的内容由这儿上报 —— 标签是硬盘上的文件夹，
   * 外壳自己没法从 config 里算出来（见 nav.js 图库那条的 `live: true`）。
   */
  useEffect(() => {
    publish(
      emojis.tags.map((t) => ({
        id: `${EMOJI_PREFIX}${t.tag}`,
        label: t.tag,
        // 后面跟的是这个文件夹里有几张图；空文件夹不会注入给模型，标一下
        meta: t.count ? String(t.count) : "空",
        title: `${t.tag} · ${t.count} 张`,
      }))
    );
  }, [emojis.tags, publish]);

  /**
   * 参考图传完之后，自动补一条同名记录。
   *
   * 光有文件没用 —— 模型是照着「名称 + 描述」那份清单写 `[小猫]` 的，没记录
   * 就等于没这张图。所以传完直接把记录建好（名称 = 文件名去掉后缀），用户只要
   * 补一句描述再保存。已经有同名记录的不重复建。
   */
  const onRefUploaded = useCallback(
    (names) => {
      const have = new Set(
        (config.referenceImages ?? []).map((r) => r.name?.trim()).filter(Boolean)
      );
      for (const name of names) {
        if (!name || have.has(name)) continue;
        have.add(name);
        updateReferenceImage(addReferenceImage(), { name });
      }
    },
    [config.referenceImages, addReferenceImage, updateReferenceImage]
  );

  // 表情包详情
  if (itemId.startsWith(EMOJI_PREFIX)) {
    const tag = itemId.slice(EMOJI_PREFIX.length);
    return (
      <EmojiDetail
        tag={tag}
        dir={emojis.dir}
        // 文件夹被删了、但侧栏还停在这一条上（itemId 是外壳记着的）
        gone={!emojis.loading && !emojis.tags.some((t) => t.tag === tag)}
        onReloadTags={emojis.reload}
        onBack={() => pick("")}
        onGoto={onGoto}
      />
    );
  }

  // 参考图详情
  const open = refs.find((r) => r.id === itemId) ?? null;
  if (open) {
    return (
      <RefDetail
        entry={open}
        dir={refFiles.dir}
        files={refFiles.files}
        loading={refFiles.loading}
        onReload={refFiles.reload}
        onBack={() => pick("")}
        onGoto={onGoto}
      />
    );
  }

  // 什么都没选：两半各给一张卡
  return (
    <div className="grid grid-cols-1 gap-rhythm-sm lg:gap-rhythm">
      <Card title="参考图" desc="图生图用的底子，全局一份，各个角色自己挑能用哪几张">
        <div className="grid max-w-[62ch] grid-cols-1 gap-4">
          <p className="text-body text-ink-soft">
            {refs.length
              ? "左栏「参考图」里挑一条，改它的名称和描述。"
              : "还没有参考图。下面直接传几张，或者点左栏「参考图」标题旁的「+」手动建一条。"}
          </p>
          <HowTo
            dir={refFiles.dir}
            files={refFiles.files}
            loading={refFiles.loading}
            onReload={refFiles.reload}
            onUploaded={onRefUploaded}
          />
          <p className="border-l-2 border-line py-1.5 pl-3 text-meta leading-relaxed text-ink-faint">
            填完这里还没完 —— 参考图对某个角色生效，要去那个角色的「单独配置 → 生成图片」
            里打开「图生图」并勾上它。没勾的角色看不见这张图。
          </p>
        </div>
      </Card>

      <EmojiOverview emojis={emojis} onGoto={onGoto} onPick={pick} />

      <SaveBar hint="参考图的名称和描述保存后才会进提示词（图片文件已经落盘了，不用保存）" />
    </div>
  );
}

/**
 * 「图片放哪儿 / 怎么传」那段说明。空状态和详情页都要用，抽出来。
 *
 * `onUploaded` 只有总览那边传 —— 传完顺手建一条同名记录是「新增」，
 * 在某一条的详情页里干这个太意外了（用户是进来改这一条的）。
 */
function HowTo({ dir, files, loading, onReload, onUploaded }) {
  // 后端给的是 <数据目录>/images，参考图收在它下面的「参考图」子文件夹里。
  // 分隔符跟着那串路径走，Windows 上别拼出个 F:\…\images/参考图
  const sep = dir.includes("\\") ? "\\" : "/";
  const refDir = dir ? `${dir}${sep}参考图` : "<数据目录>/images/参考图";

  return (
    <div className="grid grid-cols-1 gap-3">
      <p className="text-meta leading-relaxed text-ink-faint">
        直接在下面传图最省事（可以一次选多张，
        <strong className="text-ink-soft">会自动压到长边 {REF_MAX_SIDE}</strong>
        再上传，GIF 原样传）
        {onUploaded ? "，传完自动建好同名记录，你补一句描述就行" : ""}
        。也可以自己把图片丢进
        <code className="mx-1 break-all bg-sunken px-1">{refDir}</code>
        （直接丢在
        <code className="mx-1 break-all bg-sunken px-1">{dir || "images"}</code>
        下面也认，那是老位置），再在这里填一条同名的记录 —— 名称
        <strong className="text-ink-soft">不带后缀</strong>
        （文件叫 <code className="mx-1 bg-sunken px-1">小猫.jpg</code>，这里就填
        <code className="mx-1 bg-sunken px-1">小猫</code>）。
        认 png / jpg / jpeg / webp / gif 五种。
      </p>
      <UploadButton
        maxSide={REF_MAX_SIDE}
        upload={(img) => api("/api/images/upload", { method: "POST", body: img })}
        onDone={async (results) => {
          await onReload();
          onUploaded?.(results.map((r) => r?.name).filter(Boolean));
        }}
        hint="可以一次选多张"
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" onClick={onReload} disabled={loading}>
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          {loading ? "扫描中…" : "重新扫描文件夹"}
        </Button>
        <p className="text-meta text-ink-faint">
          {loading ? "…" : `文件夹里现在有 ${files.length} 张图`}
        </p>
      </div>
    </div>
  );
}

function RefDetail({ entry, dir, files, loading, onReload, onBack, onGoto }) {
  const { config, updateReferenceImage, removeReferenceImage } = useConfig();
  const name = entry.name?.trim() ?? "";

  // 文件夹里有没有同名的图。名字为空时不算「找不到」—— 那是还没填完，不是错
  const hit = name ? files.find((f) => f.name === name) : null;
  const missing = Boolean(name) && !loading && !hit;

  // 图库里重名会让模型写的 [小猫] 指不清是哪一张
  const dup =
    Boolean(name) &&
    (config.referenceImages ?? []).some((r) => r.id !== entry.id && r.name?.trim() === name);

  // 哪些角色勾了它 —— 改名之前该知道会影响谁
  const usedBy = (config.roles ?? []).filter((r) =>
    (r.imageGen?.refs ?? []).includes(name)
  );

  function drop() {
    removeReferenceImage(entry.id);
    onBack();
  }

  return (
    <div className="grid grid-cols-1 gap-rhythm-sm lg:gap-rhythm">
      <Card title="这张参考图" desc="名称对上文件名，描述写给模型看">
        <div className="grid grid-cols-1 gap-6">
          <Field
            label="名称"
            hint="= 文件名（不带后缀），也是模型写在方括号里的那个词"
          >
            <input
              className={`${inputCls} ${missing || dup ? "border-warn text-warn" : ""}`}
              value={entry.name ?? ""}
              onChange={(e) => updateReferenceImage(entry.id, { name: e.target.value })}
              placeholder="小猫"
            />
            {missing && (
              <p className="mt-2 text-meta leading-relaxed text-warn">
                <code className="bg-sunken px-1">{dir || "images 文件夹"}</code> 里没有叫「
                {name}」的图片。模型还是会照着清单写
                <code className="mx-1 bg-sunken px-1">[{name}]</code>
                ，到出图那一步才失败 —— 要么把文件放进去，要么把名称改成已有的那个。
              </p>
            )}
            {dup && (
              <p className="mt-2 text-meta leading-relaxed text-warn">
                图库里已经有一条也叫「{name}」了。模型写这个名字时指不清是哪一张。
              </p>
            )}
            {!missing && !dup && hit && (
              <p className="mt-2 text-meta leading-relaxed text-ink-faint">
                对上了 <code className="bg-sunken px-1">{hit.file}</code>。
              </p>
            )}
          </Field>

          {hit && (
            <div>
              <p className="text-ui text-ink">预览</p>
              <img
                /*
                 * 带上 name 当 key 就够了 —— 用户换掉同名文件之后这个 URL 不变，
                 * 所以后端那条路由发的是 Cache-Control: no-cache，让浏览器每次回源。
                 */
                src={`/api/images/${encodeURIComponent(hit.name)}`}
                alt={name}
                className="mt-2 max-h-[260px] w-auto rounded-item border border-line object-contain"
              />
            </div>
          )}

          <Field
            label="描述"
            hint="写给模型看的，它靠这句话判断什么时候该用这张图"
          >
            <textarea
              className={`${inputCls} min-h-[80px] resize-y leading-relaxed`}
              value={entry.description ?? ""}
              onChange={(e) =>
                updateReferenceImage(entry.id, { description: e.target.value })
              }
              placeholder="这是你养的一只小猫"
            />
            <p className="mt-2 text-meta leading-relaxed text-ink-faint">
              这条会原样进提示词，长这样：
              <code className="mx-1 bg-sunken px-1">
                - [{name || "小猫"}]：{entry.description?.trim() || "这是你养的一只小猫"}
              </code>
              。写清楚「这张图是什么」就够了，不用写画风要求 —— 那是生图提示词的事。
            </p>
          </Field>

          <div className="border-t border-line pt-5">
            <HowTo dir={dir} files={files} loading={loading} onReload={onReload} />
          </div>
        </div>
      </Card>

      <Card title="谁在用它" desc="角色要打开「图生图」并勾上这张，才看得见它">
        <div className="grid max-w-[62ch] grid-cols-1 gap-4">
          {usedBy.length ? (
            <p className="text-body text-ink-soft">
              {usedBy.map((r) => r.name?.trim() || "未命名角色").join("、")} 勾了这张。
              改名字的话它们那边的引用会失效（角色面板上会标出来，需要重新勾一次）。
            </p>
          ) : (
            <p className="text-body text-ink-soft">
              还没有角色勾它，所以它现在不会出现在任何提示词里。
              去某个角色的「单独配置 → 生成图片 → 图生图」里勾上。
            </p>
          )}
          <div>
            <Button variant="outline" onClick={() => onGoto?.("role")}>
              去角色面板
            </Button>
          </div>
        </div>
      </Card>

      <Card title="删除" desc="只删这条记录，images 文件夹里的图片文件不动">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-[52ch] text-meta leading-relaxed text-ink-faint">
            图片文件要不要留由你自己决定 —— 控制台删不了你电脑上的文件。
            角色那边勾着的引用也会留着并标红，不静默清理。
          </p>
          <Button variant="ghost" onClick={drop} className="text-warn hover:bg-warn/[0.08]">
            <Trash2 size={14} /> 删除这条
          </Button>
        </div>
      </Card>

      <SaveBar hint="名称和描述保存后才会进提示词" />
    </div>
  );
}

/* ---------- 表情包 ---------- */

/**
 * 表情包总览：文件夹在哪、有哪些标签、怎么新建一个。
 *
 * 这张卡**不碰 config** —— 建标签是直接在硬盘上 mkdir，立刻生效。
 * 以前这儿还有一排勾选框（「哪些标签允许注入给模型」），和角色黑名单
 * 是同一件事说两遍，用户原话「就留下黑名单吧」，整块删了：现在
 * 硬盘上有图的标签默认全都注入，谁不许用去那个角色的黑名单里点。
 */
function EmojiOverview({ emojis, onGoto, onPick }) {
  const { tags, dir, loading, error, reload } = emojis;
  const [newTag, setNewTag] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  // 有图的才算数：空文件夹注入了也没用，服务端 stickerTagsFor 会滤掉
  const stocked = tags.filter((t) => t.count > 0);
  const total = tags.reduce((n, t) => n + t.count, 0);

  async function create() {
    const name = newTag.trim();
    if (!name || creating) return;
    setCreating(true);
    setCreateError("");
    try {
      const r = await api("/api/emojis", { method: "POST", body: { tag: name } });
      setNewTag("");
      await reload();
      // 建完直接进去，那儿才有上传按钮 —— 空标签留在总览上没有意义
      onPick?.(`${EMOJI_PREFIX}${r.tag}`);
    } catch (e) {
      setCreateError(e.message || "建不了这个标签");
    } finally {
      setCreating(false);
    }
  }

  return (
    <Card title="表情包" desc="按情绪分文件夹，角色可以整张发出去">
      <div className="grid grid-cols-1 gap-6">
        <div className="grid max-w-[62ch] grid-cols-1 gap-3">
          <p className="text-meta leading-relaxed text-ink-faint">
            表情包按情绪分文件夹放在
            <code className="mx-1 break-all bg-sunken px-1">{dir || "<数据目录>/images/emojis"}</code>
            ，
            <strong className="text-ink-soft">文件夹名就是标签</strong>
            （建一个叫「紧张」的文件夹，标签就是「紧张」）。模型写
            <code className="mx-1 bg-sunken px-1">[send_emoji:紧张]</code>
            的时候，系统从那个文件夹里
            <strong className="text-ink-soft">随机挑一张</strong>
            发出去。认 png / jpg / jpeg / webp / gif 五种。
          </p>
          <p className="text-meta leading-relaxed text-ink-faint">
            标签在这儿建、图在标签里传，都是直接改硬盘，
            <strong className="text-ink-soft">立刻生效，不用点保存</strong>
            。自己去文件夹里建、往里丢图也一样认，回来点「重新扫描」就出来了。
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="ghost" onClick={reload} disabled={loading}>
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
              {loading ? "扫描中…" : "重新扫描文件夹"}
            </Button>
            <p className="text-meta text-ink-faint">
              {loading ? "…" : `${tags.length} 个标签 · 共 ${total} 张图`}
            </p>
          </div>
          {error && <p className="text-meta leading-relaxed text-warn">{error}</p>}
        </div>

        <div className="grid max-w-[62ch] grid-cols-1 gap-3 border-t border-line pt-6">
          <p className="text-ui text-ink">新建标签</p>
          <div className="flex flex-wrap items-center gap-3">
            <input
              className={`${inputCls} max-w-[220px]`}
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => {
                // 输入框里回车就建，不用去够那个按钮
                if (e.key === "Enter") {
                  e.preventDefault();
                  create();
                }
              }}
              placeholder="紧张"
              aria-label="新标签的名字"
            />
            <Button variant="outline" onClick={create} disabled={creating || !newTag.trim()}>
              <Plus size={14} />
              {creating ? "建着…" : "建一个"}
            </Button>
          </div>
          <p className="text-meta leading-relaxed text-ink-faint">
            会在 emojis 下面建一个同名文件夹，然后直接进去传图。名字里的
            <code className="mx-1 bg-sunken px-1">\ / : * ? " &lt; &gt; |</code>
            这些字符文件夹带不了，会被剃掉。
          </p>
          {createError && <p className="text-meta leading-relaxed text-warn">{createError}</p>}
        </div>

        {tags.length > 0 && (
          <div className="grid grid-cols-1 gap-4 border-t border-line pt-6">
            <p className="text-ui text-ink">现在有这些标签</p>
            <p className="max-w-[62ch] text-meta leading-relaxed text-ink-faint">
              有图的标签会拼成一串写进提示词的
              <strong className="text-ink-soft">【表情包列表】</strong>
              —— 模型只认得清单里的这些词。
              <strong className="text-ink-soft">默认全都给</strong>
              ，要挡住某个角色去下面说的黑名单里点。空文件夹（标了「空」的那些）不进清单。
              点一个进去看缩略图、传图、删图。
            </p>
            <div className="flex flex-wrap gap-2">
              {tags.map((t) => {
                const empty = t.count === 0;
                return (
                  <button
                    key={t.tag}
                    type="button"
                    onClick={() => onPick?.(`${EMOJI_PREFIX}${t.tag}`)}
                    title={
                      empty
                        ? `${t.tag}：文件夹是空的，点进去传几张`
                        : `${t.tag} · ${t.count} 张`
                    }
                    className={`rounded-full border px-3 py-1.5 text-meta transition-colors duration-150 hover:bg-sunken hover:text-ink ${
                      empty ? "border-line border-dashed text-ink-faint" : "border-line text-ink-soft"
                    }`}
                  >
                    {t.tag}
                    <span className="ml-1.5 text-ink-faint">{empty ? "空" : t.count}</span>
                  </button>
                );
              })}
            </div>
            {stocked.length === 0 && (
              <p className="text-meta leading-relaxed text-warn">
                所有标签的文件夹都是空的，现在谁也发不出表情包 —— 点一个进去传几张图。
              </p>
            )}
          </div>
        )}

        <div className="grid max-w-[62ch] grid-cols-1 gap-3 border-t border-line pt-6">
          <p className="text-ui text-ink">发出去之前还有三道闸</p>
          <p className="text-meta leading-relaxed text-ink-faint">
            一、角色那道：去
            <button
              type="button"
              className="mx-1 underline decoration-line underline-offset-2 hover:text-ink"
              onClick={() => onGoto?.("role")}
            >
              角色 → 单独配置 → 发送表情包
            </button>
            打开（<strong className="text-ink-soft">默认是关的</strong>），没开的角色一个标签都拿不到。
            <br />
            二、黑名单那道：也在那儿，或者点进某个标签的详情页 —— 点掉的角色收不到这个标签。
            <br />
            三、预设那道：
            <button
              type="button"
              className="mx-1 underline decoration-line underline-offset-2 hover:text-ink"
              onClick={() => onGoto?.("preset")}
            >
              预设 → 消息格式与功能 → 表情包
            </button>
            这条子条目关了的话，提示词里压根没有那段说明，模型也不会写标记。
          </p>
        </div>
      </div>
    </Card>
  );
}

/**
 * 一个标签的详情：缩略图墙 + 上传 + 删图。
 *
 * 文件清单单独拉（`/api/emojis/:tag`），不跟总览那份一起拉 —— 三十几个文件夹
 * 八百多张图，一次全拿回来纯属浪费，点进哪个拿哪个。
 *
 * 这一页**不碰 config**：传图和删图都是直接改硬盘，立刻生效，没有「保存」这一步。
 * 哪个角色不许用哪个标签（黑名单）只在「角色 → 单独配置 → 发送表情包」里设 ——
 * 同一件事摆两处，改完总有一处对不上，不如只留跟着角色走的那份。
 */
function EmojiDetail({ tag, dir, gone, onReloadTags, onBack, onGoto }) {
  const { config } = useConfig();

  const [state, setState] = useState({ files: [], loading: true, error: "" });
  // 删除是两步：先点垃圾桶「上膛」，再点确认。硬盘上的文件删了没有回收站，
  // 一不小心划过去点掉一张就找不回来了
  const [armed, setArmed] = useState("");
  const [showAll, setShowAll] = useState(false);

  const reload = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const r = await api(`/api/emojis/${encodeURIComponent(tag)}`);
      setState({ files: r.files ?? [], loading: false, error: "" });
    } catch (e) {
      setState({ files: [], loading: false, error: e.message || "读不到这个文件夹" });
    }
  }, [tag]);

  useEffect(() => {
    setArmed("");
    setShowAll(false);
    reload();
  }, [reload]);

  async function drop(file) {
    try {
      const r = await api(
        `/api/emojis/${encodeURIComponent(tag)}/${encodeURIComponent(file)}`,
        { method: "DELETE" }
      );
      setState({ files: r.files ?? [], loading: false, error: "" });
      setArmed("");
      // 侧栏那个张数是总览那份数据算的，删完得让它重数一遍
      onReloadTags?.();
    } catch (e) {
      setState((s) => ({ ...s, error: e.message || "没删掉" }));
    }
  }

  const { files, loading, error } = state;
  const shown = showAll ? files : files.slice(0, THUMB_PAGE);
  // 开了「发送表情包」的角色 —— 只拿来算下面那句「连着几次不挑到同一张」
  const senders = (config.roles ?? []).filter((r) => r.stickerSend?.enabled);

  /*
   * 「连着几次不会挑到同一张」是**每个角色自己设的**（role.stickerSend.noRepeat），
   * 这一页是全局的，编不出一个数来。所以：只有一个角色开了就报它的，
   * 几个角色设得不一样就报个范围，一个都没开就报默认值。
   */
  const noRepeats = [...new Set(senders.map((r) => r.stickerSend?.noRepeat ?? 5))].sort(
    (a, b) => a - b
  );
  const noRepeatText = !noRepeats.length
    ? "默认连着 5 次不会挑到同一张"
    : noRepeats.length === 1
      ? `连着 ${noRepeats[0]} 次不会挑到同一张`
      : `连着 ${noRepeats[0]}~${noRepeats[noRepeats.length - 1]} 次不会挑到同一张（各个角色设得不一样）`;

  return (
    <div className="grid grid-cols-1 gap-rhythm-sm lg:gap-rhythm">
      <Card
        title="这个标签"
        desc="标签 = 文件夹名，也是模型写在 [send_emoji:…] 里的那个词"
        actions={
          <Button variant="ghost" onClick={reload} disabled={loading}>
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            {loading ? "读取中…" : "重新读取"}
          </Button>
        }
      >
        <div className="grid grid-cols-1 gap-6">
          {gone && (
            <p className="border-l-2 border-warn py-1.5 pl-3 text-meta leading-relaxed text-warn">
              <code className="bg-sunken px-1">{dir || "emojis 文件夹"}</code> 里已经没有「{tag}
              」这个文件夹了（改过名或删掉了）。
              <button
                type="button"
                className="mx-1 underline decoration-line underline-offset-2 hover:text-ink"
                onClick={onBack}
              >
                回图库
              </button>
            </p>
          )}

          <p className="max-w-[62ch] border-l-2 border-line py-1.5 pl-3 text-meta leading-relaxed text-ink-faint">
            这个文件夹在
            <code className="mx-1 break-all bg-sunken px-1">
              {dir ? `${dir}${dir.includes("\\") ? "\\" : "/"}${tag}` : `emojis/${tag}`}
            </code>
            ，现在
            {loading ? " 正在数… " : ` 有 ${files.length} 张图 `}
            —— 模型写
            <code className="mx-1 bg-sunken px-1">[send_emoji:{tag}]</code>
            的时候从里面随机挑一张，
            <strong className="text-ink-soft">{noRepeatText}</strong>
            （这个次数在
            <button
              type="button"
              className="mx-1 underline decoration-line underline-offset-2 hover:text-ink"
              onClick={() => onGoto?.("role")}
            >
              角色 → 单独配置 → 发送表情包
            </button>
            里改）。只要文件夹里有图，这个标签
            <strong className="text-ink-soft">默认对所有角色都开</strong>
            ，要挡住谁就去那个角色的「发送表情包」里把它点掉。
          </p>
          {error && <p className="text-meta leading-relaxed text-warn">{error}</p>}
        </div>
      </Card>

      <Card
        title="这个文件夹里的图"
        desc="传进来的会自动压缩；挑不想要的直接删 —— 删的是硬盘上的文件，没有回收站"
      >
        <div className="grid grid-cols-1 gap-4">
          <UploadButton
            maxSide={EMOJI_MAX_SIDE}
            upload={(img) =>
              api(`/api/emojis/${encodeURIComponent(tag)}/upload`, { method: "POST", body: img })
            }
            onDone={async () => {
              await reload();
              // 侧栏和总览那个张数是另一份数据算的，传完得让它重数一遍
              onReloadTags?.();
            }}
            hint={`可以一次选多张，会自动压到长边 ${EMOJI_MAX_SIDE}（GIF 原样传）`}
          />
          {loading && <p className="text-meta text-ink-faint">读取中…</p>}
          {!loading && files.length === 0 && (
            <p className="text-body text-ink-soft">
              这个文件夹是空的。上面传几张，或者自己往文件夹里丢完回来点「重新读取」。
              空文件夹不会进提示词里的【表情包列表】。
            </p>
          )}
          {shown.length > 0 && (
            <>
              <p className="text-meta text-ink-faint">
                删图是两步：点右上角的垃圾桶，再点一次红的确认。鼠标停在图上能看文件名和大小。
              </p>
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10">
                {shown.map((f) => (
                  <div
                    key={f.file}
                    className="relative aspect-square overflow-hidden rounded-item border border-line bg-sunken"
                  >
                    <img
                      src={`/api/emojis/file/${encodeURIComponent(tag)}/${encodeURIComponent(
                        f.file
                      )}`}
                      alt={f.file}
                      title={`${f.file} · ${Math.max(1, Math.round((f.size ?? 0) / 1024))} KB`}
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                    {armed === f.file ? (
                      // 格子小，这儿放不下「删掉这张？删除 取消」那几个字，只留两个图标
                      <div className="absolute inset-0 flex items-center justify-center gap-1.5 bg-paper/95">
                        <button
                          type="button"
                          onClick={() => drop(f.file)}
                          aria-label={`确认删除 ${f.file}`}
                          title={`确认删除 ${f.file}`}
                          className="rounded-item bg-warn p-1.5 text-paper-invert"
                        >
                          <Trash2 size={14} />
                        </button>
                        <button
                          type="button"
                          onClick={() => setArmed("")}
                          aria-label="取消删除"
                          title="取消"
                          className="rounded-item border border-line bg-paper p-1.5 text-ink-faint transition-colors duration-150 hover:text-ink"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setArmed(f.file)}
                        aria-label={`删除 ${f.file}`}
                        title={`删除 ${f.file}`}
                        className="absolute right-0.5 top-0.5 rounded-item bg-paper/85 p-1 text-ink-faint transition-colors duration-150 hover:bg-paper hover:text-warn"
                      >
                        <Trash2 size={11} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
          {!showAll && files.length > THUMB_PAGE && (
            <div>
              <Button variant="outline" onClick={() => setShowAll(true)}>
                显示全部 {files.length} 张
              </Button>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
