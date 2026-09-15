/**
 * Instagram 独立页的入口。
 *
 * 和控制台（main.jsx）是两个 Vite 入口、两个端口：控制台 8787，这一页 6873。
 * 分开的理由写在 instagram.html 的注释里。
 *
 * 为什么这里也 import 控制台那份 index.css：
 * ig.css 是**孤岛但不是自足的** —— 它文件头就写着「要脱掉 Tailwind base 那层
 * 预设」，也就是说它是叠在 Tailwind 的 preflight 上写的（`box-sizing: border-box`、
 * body 去掉默认 margin、`html/body/#root { height: 100% }` 这几条都在那边）。
 * 不引进来的话 IG 的尺寸会整体对不上，得再抄一份 preflight，两边迟早跑偏。
 * 代价是多打包一份没用上的 Tailwind 工具类，gzip 之后十几 KB，认了。
 * body 的底色和字色会被 `.ig` 自己那套盖掉，控制台的壁纸变量这一页没人写、回落 none。
 */
import React from "react";
import ReactDOM from "react-dom/client";

import { AuthGate } from "../panels/auth.jsx";
import IgApp from "./app.jsx";
import "../index.css";
import "./ig.css";

/*
 * 这一页也在登录门后面。
 *
 * cookie 是按**主机**存的、不含端口，所以在控制台（8787）登录过之后这一页
 * 直接就是登录态，不用再登一次；反过来先打开这一页也一样。
 *
 * 为什么这一页也要门：它渲染的是角色和用户的帖子、快拍、评论 —— 那和聊天记录
 * 是同一类东西。而且 `/api/ig/*` 本来就在后端那道闸后面，不套门的话这一页
 * 只会卡在「拉不到数据：没有登录凭据」，用户还得自己猜该去哪。
 *
 * 门用的是控制台那套样式（Tailwind + index.css 的变量），不在 `.ig` 作用域里，
 * 所以 ig.css 那层重置碰不到它。
 */
ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AuthGate>
      <IgApp />
    </AuthGate>
  </React.StrictMode>,
);
