/**
 * 重启整个服务。
 *
 * 做法是**让进程退出**，由 scripts/launch.mjs 的守护循环重新拉起 ——
 * 不在 Node 里做「热重载」。理由是重启的用处恰恰是「有东西卡住了」：
 * 桥接连接卡在半死状态、某个模块的内部状态脏了、内存涨上去了。热重载还在
 * 同一个进程里，卡住的东西照样卡着，等于没重启。
 *
 * 所以只有**被启动器拉起来**的那份能重启（启动器会设 URANUS_SUPERVISOR=1）。
 * 用户自己 `npm start` 跑的那份退出了就没人管了 —— 那不叫重启，那叫把服务
 * 关掉。这种情况直接拒绝并说清楚，别让人点一下按钮就把服务弄没了。
 *
 * 这个文件只 import logs.js。收尾动作（停桥接）由 index.js 在启动时用
 * setShutdown 注册进来 —— 直接 import imessage.js 的话，imessage.js 反过来
 * 要 import 这边（`/重启` 指令），就成循环依赖了。
 */

import { logError, logInfo, logWarn } from "./logs.js";

/**
 * 约定的退出码：启动器只有看到这个才重新拉起，别的码一律当「正常停止」。
 * 75 是 sysexits.h 里的 EX_TEMPFAIL（「临时故障，请重试」），语义正合适，
 * 也离常见的 0/1/2 足够远，不会和真的崩溃撞上。
 * ⚠ 改这个数字要同时改 scripts/launch.mjs 里的那份。
 */
export const RESTART_EXIT_CODE = 75;

/**
 * 说完再退。
 *
 * HTTP 响应要先写完、iMessage 那条「正在重启」要几百毫秒才真的发出去 ——
 * 立刻 exit 的话用户看到的是连接断开，不知道是自己点的还是崩了。
 */
const EXIT_DELAY = 600;

/** 有没有人接盘。见文件头。 */
export function canRestart() {
  return process.env.URANUS_SUPERVISOR === "1";
}

let shutdown = async () => {};
let pending = false;

/**
 * 注册退出前的收尾（停掉所有桥接）。index.js 启动时调一次。
 * 不在这里直接 import imessage.js，理由见文件头。
 */
export function setShutdown(fn) {
  if (typeof fn === "function") shutdown = fn;
}

/**
 * 该回用户什么话。**纯查询，不排队。**
 *
 * 单独拆出来是为了 iMessage 那条路：那边得先把话发出去、发成功了再真的退，
 * 不然进程在气泡送达之前就没了，对方只看到连接断开。
 *
 * @returns {{ok: boolean, text: string}} ok=false 表示这台机器上压根重启不了
 */
export function restartNotice() {
  if (!canRestart()) {
    return {
      ok: false,
      text:
        "⚠️ 重启不了：这个服务不是用「启动.bat」拉起来的，退出之后没人负责把它开回来。" +
        "请到运行它的那个窗口手动重启。",
    };
  }
  // 连点两下不能退两次 —— 第二次会在收尾跑到一半的时候插进来
  if (pending) return { ok: true, text: "🔄 已经在重启了，稍等几秒。" };
  return { ok: true, text: "🔄 收到，正在重启整个服务，大概十几秒后就能用了。" };
}

/**
 * 请求重启。**立刻返回**一句给用户看的话，真正的退出在几百毫秒后。
 *
 * @param {string} why 谁要求的，只进日志
 * @returns {{ok: boolean, text: string}} 和 restartNotice 同一份说法
 */
export function requestRestart(why) {
  const notice = restartNotice();
  if (!notice.ok || pending) return notice;
  pending = true;

  logWarn("系统", `收到重启请求（${why}），${EXIT_DELAY} 毫秒后退出，由启动器重新拉起`);

  setTimeout(async () => {
    try {
      await shutdown();
    } catch (e) {
      // 收尾失败也要退 —— 卡在这儿的话「重启」就成了「假死」，比收尾不干净糟
      logError("系统", "重启前的收尾出错，照样退出", e);
    }
    logInfo("系统", "进程退出，等启动器把服务开回来");
    process.exit(RESTART_EXIT_CODE);
  }, EXIT_DELAY);

  return notice;
}