import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * 两个入口：控制台（index.html）和 Instagram（instagram.html）。
 *
 * Vite 默认只认 index.html，多一个 HTML 就得在 rollupOptions.input 里点名，
 * 否则 build 出来的 dist 里根本没有 instagram.html。两个入口共享同一套
 * node_modules chunk，多出来的体积只有 IG 自己那部分。
 *
 * 这个文件平时只跑 `vite build` —— 正式用法是 `npm run build` 出 dist/，
 * 然后 8787（控制台）和 6873（IG）都由后端 serve 那份产物。项目**没有**
 * 面向使用者的热更新开发模式。
 *
 * 唯一还会起 server 的地方是 scripts/dev-sandbox.mjs（我自己在浏览器里
 * 一眼一眼看界面用的沙箱）。它 spawn 的 `vite` 就走这份配置，所以下面那个
 * server.proxy 是留给它的 —— 没有它，沙箱页面上的 /api 会打到 8787 的真
 * 后端上，点一下「保存」就写进了真配置。
 */
export default defineConfig({
  plugins: [react()],
  server: {
    // 沙箱自己传 --port，这里只是没传时（比如手滑直接跑 vite）的落点。
    // 不写 5173 了：那个号是过去开发模式的，留着容易让人以为还有热更新
    port: Number(process.env.PORT) || 5174,
    proxy: {
      // 沙箱把后端起在 8788，靠 URANUS_API 让 Vite 指过去
      "/api": {
        target: process.env.URANUS_API || "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        main: path.resolve(here, "index.html"),
        instagram: path.resolve(here, "instagram.html"),
      },
    },
  },
});
