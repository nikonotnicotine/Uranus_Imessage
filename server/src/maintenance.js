/**
 * 定时维护：隔一阵子自己重启一次 / 清一次缓存。
 *
 * 控制台上「重启服务」和「清理缓存」这两个按钮本来就有，这个文件只是让它们
 * 能按小时自己跑一遍 —— 用户不用记着每天回来点一下。两个开关都默认关，
 * 见 config.js 的 DEFAULT_CONFIG.maintenance。
 *
 * ── 清缓存的逻辑为什么在这儿而不在 index.js ──
 *
 * 原来那段代码长在 `/api/cache/clear` 的路由里。定时那一路要的是**一模一样**
 * 的行为（用户看到的日志、清掉的东西都该和手点没有区别），复制一份出来早晚会
 * 走岔。所以搬到这里当一个普通函数，路由改成调它，逻辑只留一份。
 *
 * ── 边界 ──
 *
 * 只 import 叶子模块。定时重启走 restart.js:requestRestart —— 那边判断这份
 * 服务是不是启动器拉起来的（不是的话退了就没人开回来），拒绝时我们**只警告
 * 一次**，别每小时刷一条同样的话。
 *
 * 定时云备份走 cloudbackup.js:runBackup，和「控制台那个按钮」同一个函数 ——
 * 同上，两份实现早晚走岔。那个模块自己也只 import 叶子（datadir / logs /
 * memorystore / cloud/*），没把这里拖进循环依赖。
 */

import { runBackup } from "./cloudbackup.js";
import { clearConfigCache } from "./config.js";
import { clearEnvCache } from "./env.js";
import { forgetHistory } from "./imessage.js";
import { pruneOrphanMedia } from "./igstore.js";
import { logDebug, logError, logInfo, logWarn } from "./logs.js";
import { clearRegexCache } from "./regex.js";
import { requestRestart } from "./restart.js";
import { clearUpdateCache } from "./update.js";

/**
 * 清一遍缓存。手点的按钮和定时器走的是这同一个函数。
 *
 * 清的都是「能重新算出来的东西」，用户看得见的数据一个字节都不碰：
 *  - 环境：城市坐标、天气、节假日表（下一轮消息重查，慢一两秒）
 *  - 正则：编译好的 RegExp（规则本身在配置里）
 *  - 配置：内存里那份 config（下次读盘）
 *  - 上下文：各条连接内存里的历史（handleTurn 会从存档重新读回来）
 *  - 检查更新：上次问 GitHub 拿到的那份结果（默认缓存一刻钟）
 *  - Instagram 的野图：`data/instagram/media/` 里**已经没人引用**的图片文件
 *
 * 最后那条是唯一动到磁盘的，所以判据卡得很死：帖子、快拍、精选封面、
 * 头像里出现过的文件名一律留着（igstore.js:pruneOrphanMedia）。删掉的那些
 * 界面上压根找不到入口 —— 模型出了图但那条内容没落盘、用户换过图之后的
 * 旧文件，这一类。它们只涨不落，不清的话 media/ 会一直长。
 *
 * **不清日志** —— 日志有单独的「清空」按钮，一个按钮做两件事会让人误删。
 *
 * @param {string} [why] 记进日志的来路（「控制台」/「定时」）
 * @returns {{text: string, env: object, history: number, media: object}}
 */
export function clearCaches(why = "控制台") {
  const env = clearEnvCache();
  clearRegexCache();
  clearConfigCache();
  const update = clearUpdateCache();
  const history = forgetHistory();
  // 删文件那一步不能让整条清理挂掉 —— 前面几样已经清完了，
  // 而这一步失败最多是几个野文件多留一阵
  let media = { removed: 0, bytes: 0, kept: 0 };
  try {
    media = pruneOrphanMedia();
  } catch (e) {
    logError("系统", "清 Instagram 野图时出错（别的已经清好了）", e);
  }

  const parts = [
    `环境 ${env.geo + env.geoFail + env.weather + env.holidays} 条`,
    "正则编译结果",
    "配置",
    `${history} 条会话的内存上下文`,
  ];
  // 只在真有那份缓存时才提一句 —— 没查过更新的时候写「更新检查结果」是句废话
  if (update) parts.push("检查更新的结果");
  if (media.removed) {
    parts.push(`Instagram 没人引用的图 ${media.removed} 张（${Math.round(media.bytes / 1024)}KB）`);
  }
  const text = `已清理：${parts.join("、")}。这些都会在下次用到时重新生成。`;
  logInfo("系统", `${why}清理缓存：${parts.join("、")}`);
  return { text, env, history, media };
}

/* ================= 定时器 ================= */

/** 多久看一眼。和 IG 队列、日记那两个定时器同一个节奏。 */
const TICK_MS = 60000;

/**
 * 上一次动手的时刻。
 *
 * 进程起来时都设成**启动时刻**而不是 0：不然服务一开机就立刻重启一次
 * （`now - 0` 永远大于任何间隔），成了开机自杀。
 *
 * 开关关着的那一路也顺手把锚点推到现在 —— 关了半天再打开，不该立刻就触发。
 */
let lastRestartAt = Date.now();
let lastCacheAt = Date.now();
let lastBackupAt = Date.now();

/** 「重启不了」只警告一次的标记，见文件头。 */
let warnedNoRestart = false;

/**
 * 云备份**正在传**的标记。
 *
 * 另外两件事（清缓存、重启）都是同步的、几十毫秒完事，这件不是：一个 91MB
 * 的包在慢网上可能传几分钟，超过下一次到点的间隔。两个上传叠在一起会往
 * 云端塞两份、还会各自跑一遍「清理旧快照」，把保留份数算乱。
 *
 * 所以这里挡住重入。挡掉的那次**不推锚点** —— 推了的话正在传的这次一结束，
 * 下一次就得再等满一个间隔；不推的话下一跳（一分钟后）就会重试。
 */
let pushing = false;

/** 到点了没。 */
function due(last, hours, now) {
  return now - last >= hours * 3600e3;
}

/* ---- 「这一跳什么都没到点」怎么说 ---- */

/**
 * 上一次报过闲状态的时刻，和报的间隔。
 *
 * 这个定时器**每分钟**跳一次，而绝大多数跳都是「什么都还没到点」。每跳记一条
 * 就是一天 1440 条，会把日志环整个冲干净（RING_MAX 才 2000）—— 用户想查的
 * 那件事早被挤掉了。所以闲状态最多半小时说一次；真发生了什么（触发了、被
 * `pushing` 挡了）不受这个限制，那种一定记。
 */
let lastIdleLogAt = 0;
const IDLE_LOG_MS = 30 * 60e3;

/** 「还差多久」，说给人听。 */
function untilText(last, hours, now) {
  const left = hours * 3600e3 - (now - last);
  if (left <= 0) return "马上";
  const mins = Math.round(left / 60e3);
  return mins < 60 ? `还差 ${mins} 分钟` : `还差 ${(mins / 60).toFixed(1)} 小时`;
}

/** 三件事各自的状态，拼成一行。启动那条 info 和闲状态那条 debug 共用。 */
function statusLine(config, now) {
  const m = config.maintenance ?? {};
  const cb = config.cloudBackup ?? {};
  const one = (name, on, hours, last) =>
    `${name} ${on ? `每 ${hours} 小时（${untilText(last, hours, now)}）` : "关"}`;
  return [
    one("云备份", cb.auto?.enabled, cb.auto?.hours, lastBackupAt),
    one("清缓存", m.cache?.enabled, m.cache?.hours, lastCacheAt),
    one("重启", m.restart?.enabled, m.restart?.hours, lastRestartAt),
  ].join(" · ");
}

/**
 * 起定时器。形状照抄 igrun.js:startIgQueue —— unref 掉，让它不要拖着进程
 * 不退出；返回一个停止函数。
 *
 * 每跳现读一份配置（用户随时在改），不缓存。
 *
 * @param {() => object} getConfig
 */
export function startMaintenance(getConfig) {
  const tick = () => {
    const config = getConfig?.();
    if (!config) return;
    const m = config.maintenance ?? {};
    const now = Date.now();
    // 这一跳有没有真做事。没有的话下面按半小时节流报一次闲状态
    let acted = false;

    // 清缓存排在重启前面：真要两件事同时到点，先清完再重启才有意义
    if (m.cache?.enabled) {
      if (due(lastCacheAt, m.cache.hours, now)) {
        lastCacheAt = now;
        acted = true;
        logDebug("系统", `定时清缓存到点了（每 ${m.cache.hours} 小时）`);
        try {
          clearCaches(`定时（每 ${m.cache.hours} 小时）`);
        } catch (e) {
          logError("系统", `定时清缓存出错：${String(e?.message ?? e)}`, e);
        }
      }
    } else {
      lastCacheAt = now;
    }

    /*
     * 云备份排在清缓存后面、重启前面。
     *
     * 在重启前面是必须的：真要两件事同时到点，重启会把进程干掉 —— 那时候
     * 备份传到一半就断了。先把包传完再重启。
     *
     * 和另外两件事不一样的地方是它 **async**，而 tick 是同步的。不 await：
     * 拿不到结果没关系（成败都记在日志里），而 await 会让这一跳一直挂着，
     * 后面重启那一段就轮不上。重入靠 `pushing` 挡。
     */
    const cb = config.cloudBackup ?? {};
    if (cb.auto?.enabled) {
      if (due(lastBackupAt, cb.auto.hours, now)) {
        acted = true;
        if (pushing) {
          // 上一次还在传。不推锚点，下一跳（一分钟后）再看
          logWarn("云备份", "上一次自动备份还在传，这一次跳过");
        } else {
          lastBackupAt = now;
          pushing = true;
          logDebug("云备份", `定时备份到点了（每 ${cb.auto.hours} 小时）`);
          runBackup(cb, `定时（每 ${cb.auto.hours} 小时）`)
            .catch((e) => {
              // 不重试：下次到点自然会再来一遍。网断了、密钥过期了，
              // 这一分钟内重试也不会好
              logError("云备份", `定时备份失败：${String(e?.message ?? e)}`, e);
            })
            .finally(() => {
              pushing = false;
            });
        }
      }
    } else {
      lastBackupAt = now;
    }

    if (m.restart?.enabled) {
      if (due(lastRestartAt, m.restart.hours, now)) {
        lastRestartAt = now;
        acted = true;
        logDebug("系统", `定时重启到点了（每 ${m.restart.hours} 小时）`);
        const result = requestRestart(`定时重启（每 ${m.restart.hours} 小时）`);
        // 不是启动器拉起来的：退了就没人开回来，restart.js 会拒。
        // 每小时刷一条同样的警告没意义，只说一次
        if (!result.ok && !warnedNoRestart) {
          warnedNoRestart = true;
          logWarn(
            "系统",
            "定时重启开着，但这份服务不是用「启动.bat」拉起来的，重启请求被拒（这条只提醒一次）"
          );
        }
      }
    } else {
      lastRestartAt = now;
    }

    // 什么都没到点：半小时说一次「还差多久」，理由见 lastIdleLogAt
    if (!acted && now - lastIdleLogAt >= IDLE_LOG_MS) {
      lastIdleLogAt = now;
      logDebug("系统", `定时维护在看着：${statusLine(config, now)}`);
    }
  };

  const timer = setInterval(() => {
    try {
      tick();
    } catch (e) {
      logError("系统", `定时维护这一轮出错：${String(e?.message ?? e)}`, e);
    }
  }, TICK_MS);
  timer.unref?.();

  /*
   * 启动时把三个开关摊出来（info，不是 debug）。
   *
   * 用户勾了「每 6 小时自动备份」之后最想确认的就是「它到底生效了没」，
   * 而这件事以前完全看不出来 —— 定时器起来时一声不吭，第一次真触发可能要
   * 等六小时。这一条让人立刻知道自己勾的东西被读到了。
   */
  const config = getConfig?.();
  if (config) logInfo("系统", `定时维护已启动：${statusLine(config, Date.now())}`);

  return () => clearInterval(timer);
}
