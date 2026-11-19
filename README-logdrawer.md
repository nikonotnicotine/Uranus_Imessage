# Uranus iMessage · 可拖动实时日志抽屉（logdrawer 补丁）

本仓库在官方 Uranus 基础上加了一个 **可拖动的「实时日志」气泡/面板（LiveLogDrawer）**，方便随时盯着链路状态、不用切控制台。

> 本文件只讲这个补丁怎么用 / 怎么移植。官方的完整使用说明见根目录 `README.md`。

---

## 这是什么

在 Uranus 控制台界面里多了一个浮动的实时日志组件：

- **收起时**是屏幕角落（默认右下角）的一个小胶囊，显示连接状态 + 问题条数角标
- **拖动标题栏**就能把它挪到屏幕任意位置，**落点会记住**（存浏览器 `localStorage`），下次打开还在原地
- **展开后**是完整的实时运行日志：级别筛选、搜索、暂停、清空

用途：一眼看出 iMessage 桥接 / 模型调用链路是不是断了，不用每次都去翻控制台。

---

## 怎么拿到这份补丁

### 方式 A：直接用本仓库已集成好的版本（最省事）

这个改动在 fork 的 **`pr/live-log-drawer`** 分支（也打了 tag **`Uranus_Imessage`**）：

```bash
git clone https://github.com/zyeonheenim/Uranus_Imessage.git
cd Uranus_Imessage
git checkout pr/live-log-drawer      # 或：git checkout Uranus_Imessage
```

> ⚠️ **master 分支没有这个补丁**，别下错分支。

### 方式 B：移植到你自己的 Uranus（推荐给用最新版的人）

补丁只涉及 **2 个文件**，可以干净地移植，不会和上游冲突：

1. 把 `client/src/logdrawer.jsx` 这一个文件拷进你的 Uranus `client/src/`
2. 在 `client/src/shell.jsx` 里加两处：
   - 顶部 import 区加一行：`import { LiveLogDrawer } from "./logdrawer.jsx";`
   - 主渲染区（靠近其它浮动组件的地方）加一行：`<LiveLogDrawer />`

---

## ⚠️ 重点：下载后必须 build 一次

本仓库**有意不提交构建产物**（`client/dist/` 和 `node_modules/` 都在 `.gitignore` 里，见仓库根 `.gitignore` 第 14/18/21 行）。

而 Uranus 实际跑的是 `client/dist`，**不是** `client/src`。所以不管是方式 A 还是方式 B，下载下来后都必须：

```bash
npm install      # 拉取 vite / react / lucide-react 等依赖（node_modules 也没入库）
npm run build    # 生成 client/dist
```

然后照常启动 Uranus 即可。**以后只要改了 `client/src` 下的任何文件，都要重新 `npm run build` 才生效**——这是最容易踩的坑（源码改了但没 rebuild，前端不会变）。

---

## 平台说明

纯 Node / npm 流程，**Mac / Windows / Linux 都一样**，只要装了 Node（建议 18+）。MacBook 没有任何特殊之处。

---

## 补丁涉及的文件清单

| 文件 | 作用 |
|------|------|
| `client/src/logdrawer.jsx` | 新增组件：可拖动 + 记忆位置 + 默认右下角的实时日志抽屉 |
| `client/src/shell.jsx`     | 引入并渲染 `<LiveLogDrawer />`（方式 B 需手动加这 2 行） |

---

## 版本提示

- 这个补丁是在某个 Uranus 版本上改的。**如果你用的是比它更新的 Uranus，请用「方式 B 移植」**，不要整支 `git merge`，否则会和上游的大量改动冲突。
- 如果你就是想直接玩整套老版本 + 这个气泡，用「方式 A」整支 checkout 即可，能直接跑。

---

## 常见问题

**Q：我下载后启动 Uranus，没看到这个气泡？**
A：几乎都是没 build。确认 `client/dist/` 已生成（里面有 `assets/main-*.js`），并且浏览器**硬刷新**（Mac：`Cmd+Shift+R`）加载了新前端。

**Q：气泡位置怎么重置？**
A：位置存在浏览器 `localStorage` 里（键名含 `uranus.logdrawer.pos`）。清掉对应 localStorage 或换浏览器/隐身窗口就会回到默认右下角。

**Q：升级 Uranus 上游后补丁没了？**
A：对，`client/src` 会被上游覆盖。升级后按「方式 B」重新移植一次即可。
