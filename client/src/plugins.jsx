/**
 * 插件的前端加载器（后端 server/src/plugins.js，插件在 data/plugins/）。
 *
 * ── 怎么加载 ──
 *
 * 外壳挂一次 `usePlugins()`，它拉 `/api/plugins/active`（只给总开关开着、
 * 自己也开着、没坏的那几个），然后对每一个：
 *
 *   - `entry.css` → 插一个 <link>，和 customcss.jsx 的注入一个路数；
 *   - `entry.client` → 动态 `import()` 进来，调它导出的默认函数一次。
 *
 * ── 安全模式 ──
 *
 * 网址后面加 `?noplugins`，这一次什么插件都不加载。
 *
 * **这条路是必须的**，不是锦上添花：插件和控制台同源、能改 DOM、能往
 * `window` 上挂东西 —— 一个写崩的插件可以让整个控制台白屏，而「关掉那个
 * 插件」的开关也在控制台里。没有这条路的话用户只剩下「手动删 data/plugins/
 * 下的文件夹」这一个出路，而那要能 SSH 上去。
 *
 * 自定义 CSS 那边栽过同样的坑，所以有 `?nocss`（见 customcss.jsx）。
 * 两个可以一起加：`?nocss&noplugins`。
 *
 * ── 一个坏插件不拖垮别的 ──
 *
 * 每个插件的 import 和调用都单独 try/catch。一个插件抛错只记一条控制台警告，
 * 其余照常加载 —— 不然装了五个插件，其中一个作者打错一个字，另外四个和整个
 * 控制台一起没了。
 *
 * ── 为什么不做沙箱 ──
 *
 * 说清楚免得有误会：这里**没有沙箱**。插件在控制台的同一个 realm 里跑，能读
 * 页面上的任何东西、能用用户的会话调任何 `/api`。iframe + postMessage 那套能
 * 隔开，但插件就干不了「改控制台界面」这件它主要该干的事了。
 *
 * 所以安全靠的是前面那几道：市场审核、总开关默认关、装之前把插件声明的权限
 * 列给用户看、以及用户自己只装信得过的作者。这些都是社会性的办法，不是技术
 * 保证 —— 市场 README 顶部那段免责声明是认真的。
 */

import { useEffect } from "react";

/** 网址带 `?noplugins`：这一次什么插件都不加载。 */
export const PLUGINS_SAFE_MODE =
  typeof location !== "undefined" && new URLSearchParams(location.search).has("noplugins");

const LINK_PREFIX = "uranus-plugin-css-";

/** 已经加载过的插件 id —— 开发时热更新会让 effect 跑第二遍，别重复调插件。 */
const loaded = new Set();

function injectCss(id, href) {
  const elId = `${LINK_PREFIX}${id}`;
  if (document.getElementById(elId)) return;
  const link = document.createElement("link");
  link.id = elId;
  link.rel = "stylesheet";
  link.href = href;
  // 放在 head 最后：排在 Tailwind 那份后面，同样的选择器写一遍就能盖过去
  document.head.appendChild(link);
}

/** 把某个插件的样式表撤掉（关掉插件、或者卸载之后）。 */
function dropCss(id) {
  document.getElementById(`${LINK_PREFIX}${id}`)?.remove();
}

/**
 * 加载一个插件。**永远不抛** —— 调用方在循环里跑，一个坏的不该中断其余的。
 */
async function load(p) {
  if (loaded.has(p.id)) return;
  loaded.add(p.id);

  if (p.entry?.css) injectCss(p.id, `/api/plugins/${p.id}/file/${p.entry.css}`);
  if (!p.entry?.client) return;

  /*
   * 配置是按 id 单独拉的，不跟在 /api/plugins/active 的列表里 —— 那样一次
   * 请求就会把所有插件的密钥打包送到页面上。只有声明过配置的插件才拉
   * （hasConfig），没声明的省掉这次请求。
   *
   * 拉不到就当没有：配置拿不到不该让插件整个加载不了，插件自己会用默认值兜底。
   */
  let config;
  if (p.hasConfig) {
    try {
      const res = await fetch(`/api/plugins/${p.id}/config/runtime`, { credentials: "same-origin" });
      if (res.ok) config = await res.json();
    } catch {
      /* 拿不到就 undefined，插件按默认值跑 */
    }
  }

  try {
    // Vite 看见带变量的 import() 不会去打包它，正是要的 —— 这个 URL 是运行时
    // 才知道的，插件也不在构建产物里
    const mod = await import(/* @vite-ignore */ `/api/plugins/${p.id}/file/${p.entry.client}`);
    const fn = mod?.default;
    if (typeof fn !== "function") {
      console.warn(`[插件] ${p.name}（${p.id}）没有导出默认函数，没东西可跑`);
      return;
    }
    /*
     * 传给插件的 ctx。以后往里加字段是兼容的，插件按需解构。
     *
     * `config` 是用户在控制台里填的那份（manifest.json 的 config 段声明了有
     * 哪些项，后端按 schema 补齐了默认值）。没声明配置的插件这里是 undefined，
     * 让插件代码能用 `ctx.config ?? {}` 区分「没有配置这回事」和「有配置但
     * 都是默认值」。
     *
     * 是**加载时的快照**，不是响应式的 —— 用户改了配置要刷新页面才生效。
     * 这是有意的，和开关一样的道理：插件已经按旧配置画了界面、挂了事件，
     * 「把旧配置的影响撤干净再按新配置重来」没法做可靠。
     */
    fn({ id: p.id, name: p.name, version: p.version, config });
  } catch (err) {
    // 插件自己的错不该看起来像控制台的错，所以前缀写清楚是哪个插件
    console.warn(`[插件] ${p.name}（${p.id}）加载失败：`, err);
  }
}

/**
 * 外壳挂一次：登录后拉一遍该加载的插件，逐个加载。
 *
 * 开关变动之后要刷新页面才生效 —— 不做热插拔是故意的：插件改了 DOM、
 * 挂了事件监听、往 window 上放了东西，「卸载」根本没法做干净。刷新一次
 * 是唯一诚实的做法，面板上也这么写着。
 */
export function usePlugins() {
  useEffect(() => {
    if (PLUGINS_SAFE_MODE) {
      console.info("[插件] 安全模式（网址带 ?noplugins）：这一次没有加载任何插件。");
      return;
    }
    let alive = true;
    fetch("/api/plugins/active", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => {
        if (!alive || !Array.isArray(list)) return;
        for (const p of list) load(p);
      })
      .catch(() => {
        /* 拉不到就是没有插件，不打扰 */
      });
    return () => {
      alive = false;
    };
  }, []);
}

export { dropCss };
