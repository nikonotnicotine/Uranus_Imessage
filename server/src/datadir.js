/**
 * data/ 目录：所有本地数据的落盘位置和文件级读写。
 *
 * 布局：
 *   data/config.json        非密钥的全局项（providers + chat）
 *   data/data.config.json   密钥/凭据（providerKeys + projects），gitignore 掉
 *   data/characters/        角色，一个角色一个文件（含它的单独配置）
 *   data/worlds/            世界书，一本一个文件
 *   data/user/              用户人设
 *   data/presets/           预设
 *   data/memories/          记忆库：记忆 / 备忘录 / 日记，按角色分文件
 *   data/images/            图生图的参考图（用户自己往里放图片）
 *   data/images/emojis/     表情包，一个情绪一个子文件夹
 *   data/sessions/          对话存档
 *   data/wallpapers/        后台界面的壁纸，外加一份 settings.json
 *   data/transfer-logos/    转账卡片上那张缩略图的素材
 *
 * 另有一个 assets/ 在**项目根**（不在 data/ 里）：随代码发的内置素材，只读。
 *
 * 一类一个文件夹、一个条目一个文件，是为了让备份可以拆着来：单独拷一个角色、
 * 一本世界书给别人，或者只回滚预设。整个 data/ 就是唯一的备份单元。
 *
 * 这个文件**不能 import config.js** —— config.js 要 import 它，反过来引就成
 * 循环依赖了。所以这里只管「文件长什么样」，不懂配置的语义。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { logError, logInfo, logWarn } from "./logs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

/**
 * 随代码一起发的内置素材：两张默认壁纸，外加开箱那两份预设。
 *
 * 和 data/ 分得很干净：data/ 是用户自己的东西，整个删掉重来也没关系；
 * assets/ 是仓库的一部分，只读 —— 不进备份包、界面上删不掉、URANUS_DATA_DIR
 * 也不影响它（换数据目录换的是用户数据，不是程序自带的图）。
 */
export const ASSETS_DIR = path.join(ROOT, "assets");
export const BUILTIN_WALLPAPER_DIR = path.join(ASSETS_DIR, "wallpapers");

/**
 * 内置的转账卡片 logo。和内置壁纸同一个待遇：只读、界面上删不掉、
 * 不进备份包、`URANUS_DATA_DIR` 也不影响它。
 */
export const BUILTIN_TRANSFER_LOGO_DIR = path.join(ASSETS_DIR, "transfer-logos");

/**
 * 开箱预设的**种子**（线上一份、线下一份）。
 *
 * 放在 assets/ 而不是写成 preset.js 里的字面量：这两份加起来 116KB 提示词，
 * 硬编进去会让那个文件涨三倍，而且以后调一句话就得改代码。放成 JSON 之后
 * 「改默认提示词」= 改这两个文件，`defaultEntries()` 那套六条固定条目
 * 照旧当兜底（种子文件被删了也还能跑）。
 *
 * 只在 data/presets/ **第一次被建出来**时拷进去，见 seedPresets。
 */
export const BUILTIN_PRESET_DIR = path.join(ASSETS_DIR, "presets");

/**
 * 数据目录。环境变量能覆盖 —— 离线测试要指向临时目录，VPS 上也可能想把
 * 数据放到和代码分开的盘上。
 */
export const DATA_DIR = process.env.URANUS_DATA_DIR
  ? path.resolve(process.env.URANUS_DATA_DIR)
  : path.join(ROOT, "data");

export const CONFIG_PATH = path.join(DATA_DIR, "config.json");
export const SECRET_PATH = path.join(DATA_DIR, "data.config.json");

/**
 * 控制台的登录凭据：用户名、密码哈希、会话签名密钥。
 *
 * **单独一个文件**，两个都不进（不进 config.json、也不进 data.config.json）：
 *
 *  - config.json 那份每次保存配置都会**整份重写**，而且 `PUT /api/config` 会
 *    顺带重启所有 iMessage 桥接 —— 改密码不该把线路踢下线（和壁纸、
 *    Instagram 那两条同一个理由）；
 *  - data.config.json 同样是 `saveConfig` 整份重写出来的，密码哈希混进去
 *    就得跟着配置的 normalize / 拆分走一遍，而它和配置语义毫无关系；
 *  - 最要紧的是**用户要能自己打开它**：密码忘了的唯一出路是把 password 那行
 *    清成空串（见 auth.js）。那件事必须简单到能在记事本里做完，不能让人在
 *    一份几百行的配置里翻。
 */
export const AUTH_PATH = path.join(DATA_DIR, "auth.json");

/**
 * 定时维护的**进度**：上次真重启 / 清真缓存 / 真备份各是什么时候。
 *
 * 单独一个文件，理由是它**必须活过进程本身** —— 重启一次就把计时重置的话，
 * 「每 3 天备份一次」在每天重启的服务上永远不会触发（用户原话：「每次重启
 * 又重新计时了」）。所以它不能待在内存里，而 config.json 又不行：那份每次
 * 保存设置都整份重写、而且会顺带重启所有桥接，往里塞一个每分钟都可能变的
 * 时间戳等于让「改设置」和「记进度」互相踩。
 *
 * 也不进 data.config.json：那是密钥文件，和这个语义毫无关系。
 */
export const MAINTENANCE_PATH = path.join(DATA_DIR, "maintenance.json");
/**
 * 最近查到的天气，按「数据源:预警开关:坐标」存。见 env.js。
 *
 * 落盘的理由只有一个：查不到的时候拿上一次查到的顶上。纯内存的话，
 * 网络不通的时候重启一次进程，连「上一次」都没有了。丢了也不要紧 ——
 * 删掉这个文件最多让下一轮多打一次网络。
 */
export const WEATHER_CACHE_PATH = path.join(DATA_DIR, "weather-cache.json");
export const CHARACTERS_DIR = path.join(DATA_DIR, "characters");
export const WORLDS_DIR = path.join(DATA_DIR, "worlds");
export const USER_DIR = path.join(DATA_DIR, "user");
export const PRESETS_DIR = path.join(DATA_DIR, "presets");
export const IMAGES_DIR = path.join(DATA_DIR, "images");
export const SESSIONS_DIR = path.join(DATA_DIR, "sessions");

/**
 * 表情包：一个情绪一个子文件夹（emojis/开心/、emojis/紧张/…），
 * 里面随便丢几张图，模型写 [send_emoji:开心] 时从那个文件夹里随机抽一张发出去。
 *
 * 文件夹名就是标签名，所以中文没问题 —— 它不进 URL 也不进文件名白名单，
 * 只在「图库 → 表情包」里被勾成可用标签之后才会出现在提示词里。
 */
export const EMOJI_DIR = path.join(IMAGES_DIR, "emojis");

/**
 * 参考图也可以收进这个子文件夹，免得和 emojis/ 挤在一层。
 * 直接扁平放在 images/ 下的照样认 —— 老用户的图不用搬。
 */
export const REF_IMAGES_DIR = path.join(IMAGES_DIR, "参考图");

/**
 * 界面壁纸：用户上传的图片，外加一份 settings.json 记「用哪张、遮罩多浓」。
 *
 * 独立成一个文件夹而不是塞进 config.json —— 保存配置会顺带重启所有 iMessage
 * 桥接（index.js 的 PUT /api/config），换张壁纸不该把线路踢下线。
 */
export const WALLPAPER_DIR = path.join(DATA_DIR, "wallpapers");

/**
 * Instagram：帖子、快拍、主页资料、互动记录、排着的评论任务，外加图片文件。
 *
 * **不进 config.json**，理由和壁纸那条一模一样、而且更硬：`PUT /api/config`
 * 会顺带重启所有 iMessage 桥接，而这边是**高频写入** —— 点一次赞、来一条评论
 * 都要落盘，走 config 的话每次互动都会把所有线路踢下线一次。
 *
 * 一个 owner（`user` 或角色名）一个文件，和 memories/ 按角色分文件同一个路子：
 * 单独拷一个角色的 IG 数据给别人，或者只回滚某个角色的帖子。
 */
export const INSTAGRAM_DIR = path.join(DATA_DIR, "instagram");
export const IG_PROFILES_DIR = path.join(INSTAGRAM_DIR, "profiles");
export const IG_POSTS_DIR = path.join(INSTAGRAM_DIR, "posts");
export const IG_STORIES_DIR = path.join(INSTAGRAM_DIR, "stories");
export const IG_HIGHLIGHTS_DIR = path.join(INSTAGRAM_DIR, "highlights");

/**
 * 帖子和快拍的图片。
 *
 * 不和 images/ 混在一起：那边是**用户自己往里放**的参考图和表情包（README 教人
 * 怎么摆文件名），这边是程序生成或上传的，文件名是随机 id，用户不该去翻。
 */
export const IG_MEDIA_DIR = path.join(INSTAGRAM_DIR, "media");

/**
 * 线下模式（线下剧情）。一个角色一份索引 + 一条剧情一个文件 + 头像。
 *
 * **不进 config.json**，理由和 IG 那条同一条：`PUT /api/config` 会顺带重启
 * 所有 iMessage 桥接，而剧情是**每一轮都写** —— 发一句、改一条、重 roll 一次
 * 都要落盘，走 config 等于每说一句话把所有线路踢下线一次。
 *
 * 分两层的原因：索引里只有「开没开、有哪几条剧情」这种一行字的东西，
 * 每轮都要读；正文按剧情分文件，演一轮只重写当前这一条，归档的老剧情
 * 不跟着抖 —— 一条演久了的剧情能有几百轮，全塞一个文件里每轮都得整份重写。
 */
export const OFFLINE_DIR = path.join(DATA_DIR, "offline");
export const OFFLINE_INDEX_DIR = path.join(OFFLINE_DIR, "index");
export const OFFLINE_STORIES_DIR = path.join(OFFLINE_DIR, "stories");

/**
 * 线下模式的头像（角色一张、用户一张）。
 *
 * 和 IG 的 media/ 分开：那边是帖子和快拍的图，删帖会去扫「哪些文件还在用」
 * （igstore.js:pruneOrphanMedia）。混在一起的话，那把扫帚会把线下头像
 * 当成孤儿图删掉 —— 它不认识剧情文件里的引用。
 */
export const OFFLINE_MEDIA_DIR = path.join(OFFLINE_DIR, "media");

/**
 * 转账卡片的会话句柄，一个角色一份。
 *
 * 存的是 `MiniAppCardSession` 那四个 guid —— 没有它们就没法把一张已经发出去的
 * 卡片从「待收款」原地改成「已收款」（见 transferstore.js 的文件头）。
 *
 * **不进 config.json**，和 IG、线下剧情同一条理由：`PUT /api/config` 会顺带
 * 重启所有 iMessage 桥接，而这边是每笔转账都写。
 */
export const TRANSFERS_DIR = path.join(DATA_DIR, "transfers");

/**
 * 转账卡片上那张缩略图的素材（品牌 logo 之类）。
 *
 * 和壁纸一样分两处：`assets/transfer-logos/` 是随代码发的内置素材（只读，
 * 界面上删不掉），这个是用户自己放的。**不进 config.json** —— 存的是图片
 * 字节，而配置是「草稿 + 点保存」的模型，图要的是放进去立刻能选。
 *
 * 用哪个 logo 是**角色配置**（role.transfer.logo），因为那决定这个角色的卡片
 * 长什么样；文件本身在这儿，两边靠文件名对上（见 transferlogo.js）。
 */
export const TRANSFER_LOGO_DIR = path.join(DATA_DIR, "transfer-logos");

/**
 * 见过的投票，一个角色一份。
 *
 * 存的是「字母 → optionIdentifier」那张映射（见 pollstore.js 的文件头）——
 * 没有它，模型写 `[vote:B]` 就没法翻成真正要投的那个选项 id。
 *
 * **不进 config.json**，和转账同一条理由：`PUT /api/config` 会重启所有桥接，
 * 而这边是每个投票事件都写。
 */
export const POLLS_DIR = path.join(DATA_DIR, "polls");

/**
 * 记忆库。三样东西各一个子文件夹，都按角色分文件。
 *
 * 子文件夹用中文名，是为了让用户翻 data/ 的时候一眼知道哪个是哪个 ——
 * 这几个目录名不进 URL、不进文件名白名单，只是本地路径，中文没问题。
 */
export const MEMORY_DIR = path.join(DATA_DIR, "memories");
export const MEMORY_ITEMS_DIR = path.join(MEMORY_DIR, "记忆");
export const MEMO_DIR = path.join(MEMORY_DIR, "备忘录");
export const DIARY_DIR = path.join(MEMORY_DIR, "日记");
export const PENDING_DIR = path.join(MEMORY_DIR, "待总结");
export const PENDING_MEMORY_DIR = path.join(PENDING_DIR, "记忆");
export const PENDING_MEMO_DIR = path.join(PENDING_DIR, "备忘录");

/** 迁移前的老位置：只有一个「功能还没做」的 README。 */
const LEGACY_MEMORY_DIR = path.join(DATA_DIR, "memory");

/** 迁移前的老位置。migrateLegacyLayout 和 readRawFromDisk 用。 */
export const LEGACY_CONFIG_PATH = path.join(ROOT, "config.json");
export const LEGACY_SECRET_PATH = path.join(ROOT, "data.config.json");

/** 老位置的三条路径。离线测试传临时目录进来，免得碰到真数据。 */
function legacyPaths(root = ROOT) {
  return {
    config: path.join(root, "config.json"),
    secret: path.join(root, "data.config.json"),
    sessions: path.join(root, "sessions"),
  };
}

/** 新布局还没建起来、老的 config.json 还在根目录躺着。 */
export function hasLegacyConfig() {
  return !fs.existsSync(CONFIG_PATH) && fs.existsSync(LEGACY_CONFIG_PATH);
}

const MEMORY_README = [
  "这个文件夹是「记忆库」的内容，按角色分文件。",
  "",
  "  记忆/    <角色>.json      长期记忆，一条一个对象（带向量，别手改）",
  "  备忘录/  <角色>.md        一份待办 / 状态清单，每次生成覆盖",
  "  日记/    <角色>/          成品日记（YYYY-MM-DD.md，永远不会自动删）",
  "           <角色>/diary_log.txt      待总结的对话流水",
  "  待总结/记忆/<角色>.txt    记忆的待总结流水",
  "  待总结/备忘录/<角色>.txt  备忘录的待总结流水",
  "",
  "三份待总结是**同一种格式**，一行一条：",
  "  2026-09-08 星期二 09:45:18 | [小明] 在吗",
  "总结时整份原样发给模型，所以直接用记事本改这几个 txt 就行。",
  "旁边的 <角色>.state.json 只放失败计数和轮数，删了不影响内容。",
  "",
  "*.bak / *.bak.txt 是生成前自动留的备份，下一次成功生成时才会被覆盖。",
  "总结失败时这些文件一个字节都不会动 —— 内容只会继续往后追加，不会丢。",
  "",
  ".md 和 .txt 可以直接用记事本改；.json 建议在网页的「记忆库」分区里改。",
  "",
].join("\r\n");

/**
 * 改成 txt 流水之前的那一版说明。
 *
 * README 只在「不存在」时才写，所以老用户手里躺着的还是描述 JSON 缓存的那份。
 * 内容**和这个字面量一模一样**时才换成新的 —— 用户自己改过的说明不能动。
 */
const LEGACY_MEMORY_README = [
  "这个文件夹是「记忆库」的内容，按角色分文件。",
  "",
  "  记忆/    <角色>.json      长期记忆，一条一个对象（带向量，别手改）",
  "  备忘录/  <角色>.md        一份待办 / 状态清单，每次生成覆盖",
  "  日记/    <角色>/          成品日记（YYYY-MM-DD.md，永远不会自动删）",
  "           <角色>/diary_log.txt      待总结的对话流水",
  "  待总结/记忆/<角色>.json   记忆的待总结缓存",
  "  待总结/备忘录/<角色>.json 备忘录的待总结缓存",
  "",
  "*.bak / *.bak.txt 是生成前自动留的备份，下一次成功生成时才会被覆盖。",
  "总结失败时这些文件一个字节都不会动 —— 内容只会继续往后追加，不会丢。",
  "",
  ".md 和 .txt 可以直接用记事本改；.json 建议在网页的「记忆库」分区里改。",
  "",
].join("\r\n");

const IMAGES_README = [
  "这个文件夹放两样东西：「图生图」的参考图，和「表情包」。",
  "",
  "── 参考图 ──",
  "  1. 把图片直接拖进这个文件夹，或者放进 参考图\\ 子文件夹",
  "     （.png / .jpg / .jpeg / .webp / .gif，两处都认）",
  "  2. 在网页的「图库 → 参考图」里新增一条，名称填**文件名，不带后缀**",
  "     —— 比如文件叫 小猫.jpg，名称就填「小猫」",
  "  3. 描述写清楚这张图是什么（例如「这是你养的一只小猫」），",
  "     模型是照着这句描述决定什么时候用它的",
  "  4. 在角色的「单独配置 → 生成图片」里打开图生图，勾上要给它用的那几张",
  "",
  "  模型想基于某张图生成时会写成 [image:画面描述][小猫]。",
  "",
  "── 表情包 ──",
  "  1. 在 emojis\\ 下面按情绪建文件夹，名字就是标签名：",
  "       emojis\\开心\\   emojis\\紧张\\   emojis\\早安\\  …",
  "  2. 每个文件夹里丢几张图，文件名随便取（同样是那五种后缀）",
  "  3. 在网页的「图库 → 表情包」里把要用的标签勾成「可用」",
  "     —— 没勾的标签不会写进提示词，模型压根不知道有这个表情包",
  "  4. 在角色的「单独配置 → 发送表情包」里打开开关（默认是关的），",
  "     需要的话再给这个角色拉几个标签进黑名单",
  "",
  "  模型想发表情包时会写成 [send_emoji:开心]，",
  "  系统从 emojis\\开心\\ 里随机抽一张发出去。",
  "",
].join("\r\n");

/**
 * 加表情包之前的那一版说明。
 *
 * 和 MEMORY_README 一个套路：README 只在「不存在」时才写，所以老用户手里躺着的
 * 还是只讲参考图的那份。内容**和这个字面量一模一样**时才换成新的 ——
 * 用户自己改过的说明不能动。
 */
const LEGACY_IMAGES_README = [
  "这个文件夹放「图生图」的参考图。",
  "",
  "用法：",
  "  1. 把图片直接拖进这个文件夹（.png / .jpg / .jpeg / .webp / .gif）",
  "  2. 在网页的「参考图」分区里新增一条，名称填**文件名，不带后缀**",
  "     —— 比如文件叫 小猫.jpg，名称就填「小猫」",
  "  3. 描述写清楚这张图是什么（例如「这是你养的一只小猫」），",
  "     模型是照着这句描述决定什么时候用它的",
  "  4. 在角色的「单独配置 → 生成图片」里打开图生图，勾上要给它用的那几张",
  "",
  "模型想基于某张图生成时会写成 [image:画面描述][小猫]。",
  "",
].join("\r\n");

/** 建齐目录结构。每次读写前都调，成本只有几个 stat。 */
export function ensureLayout() {
  // 建目录**之前**问一次：预设文件夹在不在。在的就是老用户（哪怕是空的 ——
  // 用户把预设全删了也算他的选择），种子一个字节都不该往里塞
  const freshPresets = !fs.existsSync(PRESETS_DIR);

  for (const dir of [
    DATA_DIR,
    CHARACTERS_DIR,
    WORLDS_DIR,
    USER_DIR,
    PRESETS_DIR,
    MEMORY_DIR,
    MEMORY_ITEMS_DIR,
    MEMO_DIR,
    DIARY_DIR,
    PENDING_DIR,
    PENDING_MEMORY_DIR,
    PENDING_MEMO_DIR,
    IMAGES_DIR,
    EMOJI_DIR,
    REF_IMAGES_DIR,
    SESSIONS_DIR,
    WALLPAPER_DIR,
    INSTAGRAM_DIR,
    IG_PROFILES_DIR,
    IG_POSTS_DIR,
    IG_STORIES_DIR,
    IG_HIGHLIGHTS_DIR,
    IG_MEDIA_DIR,
    OFFLINE_DIR,
    OFFLINE_INDEX_DIR,
    OFFLINE_STORIES_DIR,
    OFFLINE_MEDIA_DIR,
    TRANSFERS_DIR,
    TRANSFER_LOGO_DIR,
    POLLS_DIR,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (freshPresets) seedPresets();
  // 空文件夹进不了压缩包也进不了 git，两个说明文件顺便占个位
  const readme = path.join(MEMORY_DIR, "README.txt");
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, MEMORY_README, "utf-8");
  } else {
    // 上一版原封不动地躺着就换成新的（待总结已经改成 txt 了）；
    // 用户改过一个字就当他有自己的用途，不碰
    try {
      if (fs.readFileSync(readme, "utf-8") === LEGACY_MEMORY_README) {
        fs.writeFileSync(readme, MEMORY_README, "utf-8");
      }
    } catch {
      /* 读不出来就算了，说明文件不影响功能 */
    }
  }
  const imagesReadme = path.join(IMAGES_DIR, "README.txt");
  if (!fs.existsSync(imagesReadme)) {
    fs.writeFileSync(imagesReadme, IMAGES_README, "utf-8");
  } else {
    try {
      if (fs.readFileSync(imagesReadme, "utf-8") === LEGACY_IMAGES_README) {
        fs.writeFileSync(imagesReadme, IMAGES_README, "utf-8");
      }
    } catch {
      /* 同上 */
    }
  }
  dropLegacyMemoryDir();
}

/**
 * 把 assets/presets/ 里那两份种子拷进刚建出来的 data/presets/。
 *
 * **只在 data/presets/ 压根不存在时调**（见 ensureLayout 顶上那个 freshPresets）。
 * 「文件夹已经在了」一律当老用户处理，包括它是空的 —— 用户把预设全删光是他的
 * 选择，下次启动又给他变回来两份才是 bug。这和 normalizeConfig 里
 * 「presets 是空数组就不迁移」是同一条规矩。
 *
 * 失败只 warn 不抛：没有种子照样能跑，`resolvePreset` 会回落到
 * `makeDefaultPreset()` 那份内置兜底，只是提示词简陋些。为这个让整个程序
 * 起不来不值得。
 *
 * 拷的是原始字节，不做解析和规范化 —— 第一次 loadConfig 会连带
 * readCollection + normalizePresets 走一遍，坏文件在那边就地隔离成 .json.bad。
 */
function seedPresets() {
  let names;
  try {
    names = fs
      .readdirSync(BUILTIN_PRESET_DIR)
      .filter((n) => n.toLowerCase().endsWith(".json"));
  } catch {
    return; // assets/presets/ 不在（精简安装之类），当没这回事
  }
  if (!names.length) return;

  let copied = 0;
  for (const name of names) {
    try {
      // 不覆盖：目录是刚建的，理论上撞不上，但并发起两个进程时就说不定了
      fs.copyFileSync(
        path.join(BUILTIN_PRESET_DIR, name),
        path.join(PRESETS_DIR, name),
        fs.constants.COPYFILE_EXCL
      );
      copied += 1;
    } catch (e) {
      if (e?.code !== "EEXIST") logWarn("配置", `内置预设 ${name} 拷不过去`, e);
    }
  }
  if (copied) logInfo("配置", `首次启动，已放入 ${copied} 份内置预设`);
}

/**
 * 老的 `data/memory/` 收尾。
 *
 * 那个版本里它是纯占位，只有一个 README。所以：只剩 README（或者空的）就删掉，
 * **里面有别的东西就原样留着**并记一条 warn —— 用户可能自己往里放过东西，
 * 一个占位目录的清理不值得冒删数据的风险。
 */
function dropLegacyMemoryDir() {
  if (!fs.existsSync(LEGACY_MEMORY_DIR)) return;
  let names;
  try {
    names = fs.readdirSync(LEGACY_MEMORY_DIR);
  } catch {
    return;
  }
  const leftover = names.filter((n) => n.toLowerCase() !== "readme.txt");
  if (leftover.length) {
    logWarn(
      "配置",
      `记忆库已经改用 data/memories/，老的 data/memory/ 里还有 ${leftover.length} 个文件，` +
        "没敢动。确认用不上就自行删掉"
    );
    return;
  }
  try {
    for (const name of names) fs.unlinkSync(path.join(LEGACY_MEMORY_DIR, name));
    fs.rmdirSync(LEGACY_MEMORY_DIR);
    logInfo("配置", "记忆库启用，空的占位目录 data/memory/ 已清理");
  } catch (e) {
    logWarn("配置", "老的占位目录 data/memory/ 删不掉，留着也不影响", e);
  }
}

/** 读一个 JSON 文件。不存在或读坏了都返回 fallback（不抛）。 */
export function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf-8");
}

/**
 * 名字 → 文件名里能用的那一截。
 *
 * Windows 的非法字符、控制字符全剔掉；结尾的点和空格也去掉（Windows 会把
 * 「a.」存成「a」，再按名字找就找不着了）。截到 40 个字符 —— 人设描述可以很长，
 * 但名字不该把路径顶到 260 字符的上限附近。
 */
function safeName(name, fallback) {
  const clean = String(name ?? "")
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 40)
    .trim();
  return clean || fallback;
}

/**
 * 一个条目的文件名：`NN-名字.json`。
 *
 * 序号打头是为了让文件夹里的顺序就是界面上的顺序 —— 预设的条目顺序、
 * 用户人设的优先级都是靠数组顺序表达的，文件名不带序号就丢了这个信息。
 * 也顺便让 Windows 的保留名（CON、NUL、PRN…）撞不上：前面永远有 `NN-`。
 */
export function fileNameFor(index, name, fallback) {
  return `${String(index + 1).padStart(2, "0")}-${safeName(name, fallback)}.json`;
}

/** 文件名前缀的数字，用来排序。没有数字前缀的返回 Infinity（排最后）。 */
function orderOf(fileName) {
  const m = /^(\d+)-/.exec(fileName);
  return m ? Number(m[1]) : Infinity;
}

/**
 * 读一个文件夹里的全部条目。
 *
 * 返回 null 表示「这个文件夹压根不存在」，和「存在但是空的」（返回 []）
 * 是两件事 —— normalizeConfig 靠这个区别决定要不要跑老配置的迁移分支
 * （没有 presets 字段 = 老配置该迁移；空数组 = 用户把预设全删了，不该
 * 凭空变出来一份）。
 *
 * 解析失败的文件**改名**成 `<原名>.json.bad` 而不是静默跳过：跳过的话
 * 紧接着的一次保存会被 writeCollection 的清扫删掉，等于悄悄丢用户数据。
 * 改完名文件还在、日志里点了名，而且文件夹里不再有解析不了的 *.json，
 * 清扫就安全了。
 */
export function readCollection(dir) {
  if (!fs.existsSync(dir)) return null;

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".json"))
    .sort((a, b) => orderOf(a) - orderOf(b) || a.localeCompare(b));

  const out = [];
  for (const file of files) {
    const full = path.join(dir, file);
    try {
      const parsed = JSON.parse(fs.readFileSync(full, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        out.push(parsed);
      } else {
        quarantine(full, "内容不是一个对象");
      }
    } catch (e) {
      quarantine(full, String(e?.message ?? e));
    }
  }
  return out;
}

/** 把读不了的文件挪到一边，不参与配置也不会被清扫删掉。 */
function quarantine(full, why) {
  const target = `${full}.bad`;
  try {
    fs.renameSync(full, target);
    logError(
      "配置",
      `${path.basename(full)} 读不出来，已改名成 ${path.basename(target)} 保留原文`,
      why
    );
  } catch (e) {
    logError("配置", `${path.basename(full)} 读不出来，改名也失败了`, e);
  }
}

/**
 * 整个文件夹同步成 items。
 *
 * 写完之后**清扫**：这次没写过的 *.json 全删。改名、调序、删条目都靠这一步
 * 收尾 —— 不清扫的话「张三」改成「李四」会留下两个文件，下次读回来变成两个角色。
 * `.json.bad` 不在清扫范围内（后缀不是 .json）。
 */
export function writeCollection(dir, items, fallbackName) {
  fs.mkdirSync(dir, { recursive: true });

  const written = new Set();
  for (const [i, item] of (Array.isArray(items) ? items : []).entries()) {
    let file = fileNameFor(i, item?.name, fallbackName);
    // 同一个序号只会出现一次，所以重名只可能是名字被 safeName 削成一样了
    while (written.has(file.toLowerCase())) file = file.replace(/\.json$/, "_.json");
    written.add(file.toLowerCase());
    writeJson(path.join(dir, file), item);
  }

  for (const file of fs.readdirSync(dir)) {
    if (!file.toLowerCase().endsWith(".json")) continue;
    if (written.has(file.toLowerCase())) continue;
    try {
      fs.unlinkSync(path.join(dir, file));
    } catch (e) {
      logWarn("配置", `删不掉过期的 ${file}`, e);
    }
  }
}

/* ================= 一次性迁移：根目录 → data/ ================= */

/** 老布局还在、新布局还没建起来。 */
function needsMigration(legacy) {
  if (fs.existsSync(CONFIG_PATH)) return false;
  return fs.existsSync(legacy.config) || fs.existsSync(legacy.sessions);
}

/** 目录整体搬家。跨盘时 rename 会失败（EXDEV），退化成逐文件复制。 */
function moveDir(from, to) {
  if (!fs.existsSync(from)) return 0;
  fs.mkdirSync(path.dirname(to), { recursive: true });

  const count = fs.readdirSync(from).length;
  if (!fs.existsSync(to)) {
    try {
      fs.renameSync(from, to);
      return count;
    } catch {
      /* 跨设备或目标非空，走下面的逐文件 */
    }
  }

  fs.mkdirSync(to, { recursive: true });
  let moved = 0;
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name);
    const dst = path.join(to, name);
    if (!fs.statSync(src).isFile()) continue;
    // 已经搬过的不覆盖：新位置的内容更新
    if (!fs.existsSync(dst)) {
      fs.copyFileSync(src, dst);
      moved += 1;
    }
    fs.unlinkSync(src);
  }
  try {
    fs.rmdirSync(from);
  } catch {
    /* 里面还有子目录之类，留着就留着 */
  }
  return moved;
}

/**
 * 把老布局（项目根的 config.json + data.config.json + sessions/）搬进 data/。
 *
 * 只在 data/config.json 还不存在时做一次。老的那两个文件**改名**成
 * `.pre-data.bak`（*.bak 已在 .gitignore 里）而不是删掉 —— 迁移错了能手工还原。
 *
 * @param {(raw: object) => object} normalize 规范化函数。这个模块不懂配置语义，
 *        由 config.js 把 mergeSecrets + normalizeConfig 传进来。
 * @param {(config: object) => void} write 按新布局写盘，同样由 config.js 提供。
 * @param {string} [root] 老文件所在目录。默认项目根，离线测试传临时目录。
 * @returns {boolean} 这次真的迁了没有
 */
export function migrateLegacyLayout(normalize, write, root = ROOT) {
  const legacy = legacyPaths(root);
  if (!needsMigration(legacy)) return false;
  ensureLayout();

  const hadConfig = fs.existsSync(legacy.config);
  if (hadConfig) {
    const main = readJson(legacy.config, null);
    const secret = readJson(legacy.secret, {});
    const config = normalize(main, secret);
    write(config);
    logInfo(
      "配置",
      `配置已迁移到 data/：${config.roles?.length ?? 0} 个角色、` +
        `${config.users?.length ?? 0} 条用户人设、${config.presets?.length ?? 0} 份预设、` +
        `${config.worldBooks?.length ?? 0} 本世界书`
    );
  }

  const moved = moveDir(legacy.sessions, SESSIONS_DIR);
  if (moved) logInfo("配置", `${moved} 份对话存档已搬到 data/sessions/`);

  for (const file of [legacy.config, legacy.secret]) {
    if (!fs.existsSync(file)) continue;
    const target = `${file}.pre-data.bak`;
    try {
      fs.renameSync(file, target);
      logInfo("配置", `${path.basename(file)} 已改名成 ${path.basename(target)} 备着，可以自行删除`);
    } catch (e) {
      logWarn("配置", `${path.basename(file)} 改名失败，新配置已经在 data/ 里了`, e);
    }
  }
  return hadConfig;
}