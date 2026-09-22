# Mac 部署教程

在 macOS 上跑 Uranus iMessage。

Mac 比别的平台**多一条路**：可以让项目**直接读你本机的 Messages**，不用买 Photon 线路。
所以第一件事是选模式，选错了后面全白搭。

---

## 目录

1. [先选模式：本地还是云端](#1-先选模式本地还是云端)
2. [装 Node.js](#2-装-nodejs)
3. [把项目跑起来](#3-把项目跑起来)
4. [本地模式：开权限](#4-本地模式开权限)
5. [第一次打开控制台](#5-第一次打开控制台)
6. [做一个双击就能启动的文件](#6-做一个双击就能启动的文件)
7. [常见问题](#7-常见问题)
8. [进阶用法](#8-进阶用法)

---

## 1. 先选模式：本地还是云端

控制台的 **iMessage** 那一栏有个模式选择，两个选项：

| | **本地 (Local)** | **云端 (Photon)** |
|---|---|---|
| 要不要买线路 | **不用** | 要 |
| 用哪个号码发消息 | **你自己的 Apple ID** | Photon 给的独立号码 |
| 只能在 Mac 上跑 | 是 | 否（Windows / VPS 都行） |
| 功能完整度 | **少几样**，见下表 | 全 |
| 要开系统权限 | **要**（完全磁盘访问） | 不用 |

### 本地模式的两个代价

**第一个：角色用你自己的号码发消息。**

它是靠 AppleScript 驱动你本机的 Messages.app 发出去的，所以对方收到的消息**显示的是你自己的 iMessage 账号**。也就是说：

- 你和角色的对话，是「你自己给别人发消息」——不能自己跟自己聊
- 你的 Messages.app 会被占着，角色发的消息你自己也能在里面看到
- 想要「角色是一个独立的人、有自己的号码」，得用云端模式

**第二个：有几样功能用不了。** 本机 Messages 的接口能力有限：

| 功能 | 本地模式 |
|---|---|
| 发文字、拆气泡、打字延迟 | ✅ 正常 |
| 发图片、发语音条 | ✅ 正常 |
| 收图片识图、收语音转写 | ✅ 正常 |
| 记忆、日记、备忘录 | ✅ 正常 |
| Instagram、线下模式、主动消息 | ✅ 正常 |
| **撤回消息** | ❌ 跳过，日志记一条提醒 |
| **贴 emoji 回应（tapback）** | ❌ 跳过 |
| **引用某条回复** | ❌ 跳过 |
| **气球烟花特效** | ❌ 发不了 |
| **链接卡片** | ⚠️ 退化成直接发那条网址 |
| **已读回执**（发出和收到都算） | ❌ 收不到、也发不出 |
| **聊天背景变更** | ❌ 读不到，那个开关不起作用 |

**这些都是自动跳过的**，不会报错也不会卡住服务，只在日志里留一句 warn。

### 那我该选哪个

- **只想快点试起来、不想花钱买线路** → 本地模式
- **想让角色是一个独立的人、功能要全** → 云端模式（Mac 上一样能跑）
- **想 24 小时在线、不占自己电脑** → 云端模式 + [VPS 部署](VPS部署教程.md)

> 💡 **两个模式可以并存。** 一个「项目」= 一条连接，你可以建两个项目、各用一个模式，各绑不同的角色。

**下面第 2、3 步两个模式都要做。第 4 步只有本地模式要做。**

---

## 2. 装 Node.js

要 **20 或更新**。两条路，选一个。

### 路一：官网安装包（推荐，简单）

去 [nodejs.org](https://nodejs.org/) 下 **LTS 版本**，下到的是 `.pkg` 文件，双击一路继续。

它会自己认 Apple 芯片还是 Intel，不用你选。

### 路二：Homebrew

已经装了 Homebrew 的话：

```bash
brew install node
```

### 验证

打开**终端**（`Command + 空格` → 输入「终端」→ 回车），敲：

```bash
node -v
```

出现 `v22.14.0` 这样的版本号就成了（数字不一定一样，**20 以上就行**）。

**报 `command not found: node`**：装完没生效。**关掉终端窗口重新开一个**再试。还不行就重启电脑。

---

## 3. 把项目跑起来

### 3.1 下载项目

**方法一：git（推荐）**

macOS 自带 git。在终端里敲：

```bash
cd ~ && git clone https://github.com/nikonotnicotine/Uranus_Imessage.git && cd Uranus_Imessage
```

第一次跑 `git` 可能弹一个框问要不要装「命令行开发者工具」，**点安装**，装完再敲一次上面那条。

**方法二：下 ZIP**

打开 [github.com/nikonotnicotine/Uranus_Imessage](https://github.com/nikonotnicotine/Uranus_Imessage)，点绿色的 **Code** → **Download ZIP**，下完双击解压。

然后在终端里 `cd` 进去——**最省事的办法**：敲 `cd ` （注意后面有个空格），然后把解压出来的文件夹**从 Finder 拖到终端窗口里**，路径会自动填好，回车。

> ⚠️ **别放在 iCloud 同步的目录里**（桌面和文档默认可能在同步）。iCloud 会把不常用的文件抽成占位符，`node_modules` 里几万个文件被抽走之后服务就起不来了。
>
> 放 `~/Uranus_Imessage` 这种家目录下的位置最稳。

### 3.2 装依赖

```bash
npm install
```

**要 2~5 分钟**，在下几百个包。**别关窗口。**

结尾看到类似 `added 400+ packages in 2m` 就成了。

**报 `ETIMEDOUT` 或者卡住不动**（国内网络常见）：

```bash
npm config set registry https://registry.npmmirror.com
```

然后重跑 `npm install`。

### 3.3 构建前端

```bash
npm run build
```

看到 `✓ built in 10s` 就成了。

### 3.4 启动

```bash
npm start
```

**应该看到**：

```
  → http://localhost:8787
  → Instagram: http://localhost:6873
```

浏览器打开 **http://localhost:8787**，看到登录页就成了。

> **这个终端窗口不能关**，关掉服务就停。想停服务在窗口里按 `Control + C`。
>
> 每次要用都得重来一遍 `npm start`。嫌麻烦的话看 [第 6 章](#6-做一个双击就能启动的文件)。

**本地模式的话，先别急着配角色**——往下走第 4 步开权限，不开的话读不到消息。

---

## 4. 本地模式：开权限

**只有本地模式要做这一步。云端模式跳过，直接去 [第 5 章](#5-第一次打开控制台)。**

本地模式要读 `~/Library/Messages/chat.db`，那是 macOS 保护的文件，**必须手动授权**。

### 4.1 给终端开「完全磁盘访问权限」

1. 打开 **系统设置**（左上角 苹果菜单 → 系统设置）
2. 左边找 **隐私与安全性**
3. 往下滚，点 **完全磁盘访问权限**
4. 点 **`+`** 号（可能要先点右下角的锁、输密码）
5. 在弹出的文件选择框里按 `Command + Shift + G`，输入 `/Applications/Utilities`，回车
6. 选 **终端.app**，点打开
7. 确认它右边的开关是**打开**状态

> ⚠️ **加的是你用来跑 `npm start` 的那个程序**。用终端跑就加终端；用 iTerm2 跑就加 iTerm2；用 VS Code 里的终端跑就加 VS Code。**加错了不生效。**

### 4.2 重启终端

**这一步不能省。** 权限只在程序启动时读一次，已经开着的终端窗口拿不到新权限。

**完全退出终端**（`Command + Q`，不是关窗口），重新打开，然后重新进目录启动：

```bash
cd ~/Uranus_Imessage && npm start
```

### 4.3 确认 Messages.app 正常

本地模式是驱动 Messages.app 发消息的，所以：

- **Messages.app 要登录着你的 Apple ID**。打开「信息」应用，看能不能正常收发
- **Messages.app 不用一直开着**（AppleScript 会自己唤起它），但登录状态得是好的
- **iMessage 得是启用的**：信息 → 设置 → iMessage，确认已登录

### 4.4 第一次发消息会弹权限框

角色第一次发消息时，系统会弹一个框：

```
"终端" 想要控制 "信息"
```

**点「好」/「允许」。** 点了「不允许」的话消息发不出去，要去**系统设置 → 隐私与安全性 → 自动化**里把「信息」那一项勾回来。

---

## 5. 第一次打开控制台

### 5.1 登录并改密码

默认账号密码都是 `Uranus`。

进去会**强迫你改密码**（跳不过去），要求**至少 8 位，至少一个大写字母**。不改的话除了改密码什么都做不了。

### 5.2 填配置

1. **连接** → 填模型 API 地址和密钥，把要用的模型加进清单，勾上「聊天」分类
2. **iMessage** → **在这里选模式**：
   - **本地 (Local)** → 下面只有一个「本地路径」输入框，**留空就行**（自动检测 `~/Library/Messages/chat.db`）。用了非默认路径才需要填
   - **云端 (Photon)** → 填 Project ID 和 Project Secret，然后登记手机号拿线路号码
3. **角色** → 起名字、写人设、选聊天模型、绑上刚才那个项目
4. **用户** → 填你自己是谁（提示词里的 `{{user}}`）

角色详情页最上面写「在线」就可以去手机上发消息了。

**本地模式写着「未上线」**，八成是权限没开对，看 [7.1](#71-本地模式连不上读不到消息)。

### 5.3 在国内要配代理

去**控制台 · 代理**。改完当场生效，不用重启。

**默认已经勾好了 Instagram 和联网搜索**——这两类在国内直连吃满超时，保持原样。

- **本地模式压根不用连 Photon**，那条不用管
- **天气、音乐实测直连都通**，不用勾；**云端模式的 Photon 也直连就通**
- **模型 API** 多半直连通，套上代理反而慢
- **勾了也不怕代理没开**：勾上的类别在代理连不上时会自动脱开代理直连再试一次。反过来不会——没勾的类别绝不会偷偷走代理
- 只能填 `http://` 或 `https://`，**`socks5://` 用不了**。Clash、v2rayN 那类客户端一般同时开着一个 http 端口（默认 **7890** / **10809**），用那个
- 面板旁边有「测试连通」和「测一下直连」，**两个都点**：都通说明这个源不需要代理（把勾取消）；都不通说明你电脑出网本身有问题

> 💡 本机跑的话代理填 `http://127.0.0.1:7890` 就行，不用像 VPS 那样另外找代理。

---

## 6. 做一个双击就能启动的文件

Windows 有 `启动.bat`，**Mac 上没有对应的文件**，得自己做一个。

在项目目录里跑这一条，它会给你生成一个：

```bash
cat > 启动.command <<'EOF'
#!/bin/bash
cd "$(dirname "$0")"
npm run build && npm start
EOF
chmod +x 启动.command
```

**以后在 Finder 里双击 `启动.command`** 就会开一个终端窗口跑起来。

> ⚠️ **本地模式用这个文件的话**，[4.1](#41-给终端开完全磁盘访问权限) 里加的权限得是**终端.app**——双击 `.command` 是终端打开的。

**第一次双击可能被拦**（提示「无法打开，因为无法验证开发者」）：右键点它 → **打开** → 再点**打开**。之后就正常了。

### 想要控制台上的「重启服务」按钮能用

控制台里那个「重启服务」按钮（和聊天里的 `/重启` 指令）需要一个**守护进程**接盘——服务退出之后有人负责把它拉起来。`npm start` 自己没有这个，所以按钮会拒绝并说明原因。

想让它能用，把上面那个文件的最后一行换成：

```bash
cat > 启动.command <<'EOF'
#!/bin/bash
cd "$(dirname "$0")"
node scripts/launch.mjs start
EOF
chmod +x 启动.command
```

`launch.mjs` 自带守护循环，会检查依赖、检查前端产物是否过期并自动重新构建，还会等服务起来了自动开浏览器。

> ⚠️ **有一个已知的小问题**：`launch.mjs` 里查端口占用那段是按 Windows 写的（用 `netstat -ano`），在 macOS 上探不出来，所以它会**一直认为端口是空的**。真被占用的话会走到启动那一步才报 `EADDRINUSE`。
>
> 手动查端口用这条：
>
> ```bash
> lsof -i :8787
> ```

---

## 7. 常见问题

### 7.1 本地模式连不上、读不到消息

**按这个顺序查，九成是第 1 条或第 2 条。**

**1. 权限加的是不是跑服务的那个程序**

系统设置 → 隐私与安全性 → 完全磁盘访问权限，确认列表里有**你用来跑 `npm start` 的程序**（终端 / iTerm2 / VS Code），并且开关是打开的。

**2. 加完权限重启过没有**

权限只在程序启动时读一次。`Command + Q` **完全退出**那个程序（不是关窗口），重新打开再跑。

**3. 直接验证能不能读到**

```bash
ls -l ~/Library/Messages/chat.db
```

**能列出文件**说明权限对了。**报 `Operation not permitted`** 就是权限没生效，回第 1、2 条。

**4. Messages.app 登录着吗**

打开「信息」应用，确认能正常收发消息、iMessage 是启用的。

**5. 看服务日志**

服务那个终端窗口里会打印。本地模式启动时会写「正在启动（本地 Mac）…」，连上了写「已连接，等消息中」。

### 7.2 角色发不出消息（本地模式）

**先看是不是自动化权限**：系统设置 → 隐私与安全性 → **自动化**，找到你的终端程序，确认下面「信息」那一项是勾上的。

第一次发消息时弹的那个「想要控制'信息'」的框，点了「不允许」就会这样。

**勾了还是发不出**：手动在「信息」应用里给那个号码发一条，看能不能发出去。发不出就是 iMessage 本身的问题，跟这个项目无关。

### 7.3 装依赖时报 node-gyp / Xcode 相关的错

报错里带 `node-gyp`、`gyp ERR!`、`xcode-select`、`no such file or directory: ... clang`。

**原因**：某个依赖没有你这个 Node 版本的预编译包，退回去现场编译，而编译要 Xcode 命令行工具。

**装一下就行**：

```bash
xcode-select --install
```

弹框点安装，装完（几分钟）重跑：

```bash
npm install
```

> 💡 这一步一般碰不到。真碰到了，另一个更省事的办法是**把 Node 换成 LTS 版本**（用了太新的 Node 时预编译包还没跟上）。

### 7.4 报 `EACCES` / 权限不足

**别用 `sudo npm install`**——那会把文件归属搞乱，后面更麻烦。

正确的做法是确认项目目录归你自己：

```bash
ls -ld ~/Uranus_Imessage
```

不是你的话改回来（把路径换成你实际的）：

```bash
sudo chown -R $(whoami) ~/Uranus_Imessage
```

### 7.5 端口被占用

报 `EADDRINUSE`。先看是谁占着：

```bash
lsof -i :8787
```

**是你之前跑的那份没关干净**：

```bash
pkill -f "server/src/index.js"
```

**是别的程序**，那就换个端口跑：

```bash
PORT=8888 npm start
```

### 7.6 浏览器打不开页面

服务那个窗口打印了地址就说明起来了，手动打开：

```
http://localhost:8787
```

**还是打不开**，确认服务真在跑：

```bash
curl -sI http://127.0.0.1:8787 | head -1
```

回 `HTTP/1.1 200 OK` 就是服务好的，问题在浏览器（换一个浏览器，或者关掉浏览器的代理插件试试）。

### 7.7 合盖 / 睡眠之后角色不回消息了

Mac 睡了服务也跟着停。**两个办法**：

**办法一：让它别睡**（临时，关掉终端就失效）

另开一个终端窗口敲：

```bash
caffeinate -dimsu
```

这个窗口开着期间 Mac 不会睡。按 `Control + C` 结束。

**更省事的写法**是直接把服务包在里面跑：

```bash
caffeinate -dimsu npm start
```

服务停了防睡眠也跟着结束，不用记得去关。

**办法二：改系统设置**（永久）

系统设置 → **锁定屏幕**，把「关闭显示器后…进入睡眠」设成**永不**。

> ⚠️ **合上盖子还是会睡**，macOS 没有官方开关能改这个（除了接着电源和外接显示器）。笔记本要 24 小时在线的话，[VPS](VPS部署教程.md) 才是对的路。

### 7.8 忘了控制台密码

用文本编辑打开项目目录下的 `data/auth.json`，找到 `"password"` 那行，把值改成 `null`（**只改这一行**）：

```json
"password": null,
```

存盘。**刷新控制台页面**就生效（不用重启服务），密码回到默认的 `Uranus`。

命令行改也行：

```bash
open -e ~/Uranus_Imessage/data/auth.json
```

### 7.9 语音条发不出去

项目自带一份 ffmpeg，正常不用管。真出问题的话装一个系统的：

```bash
brew install ffmpeg
```

项目会自己去 PATH 上找，不用改任何配置。

### 7.10 还是搞不定

把这些一起发到 QQ 群 `1125033956`：

1. **服务窗口里的完整报错**（从第一行红字往下全截）
2. 环境信息：

```bash
node -v && sw_vers && uname -m
```

3. 你用的是**本地模式还是云端模式**
4. 本地模式的话，加上这条的输出：

```bash
ls -l ~/Library/Messages/chat.db
```

**发之前把里面的密钥、手机号打码。**

---

## 8. 进阶用法

### 8.1 更新到新版本

**git 装的**：

```bash
cd ~/Uranus_Imessage && git pull && npm install && npm run build && npm start
```

**ZIP 装的**：重新下一份解压到新文件夹，然后把**旧文件夹里的 `data` 整个拷进新的**。

> ⚠️ **`data` 就是你的全部数据**——配置、密钥、聊天记录、角色、图片、记忆都在里面。换版本、搬电脑，只要这一个文件夹跟着走。

> 💡 仓库里那个 `更新.bat` / `scripts/update.mjs` 是给 Windows 用的（停服务靠 `taskkill`，重启靠 `cmd`），在 Mac 上跑会直接告诉你用上面那行命令。

### 8.2 让它后台常驻（launchd）

**先说清楚**：Mac 睡眠或关机它照样会停。真要 24 小时在线，[VPS](VPS部署教程.md) 才对。

要做的话用 `launchd`。先查 node 的完整路径：

```bash
which node
```

然后生成配置（**把两处路径换成你自己的**）：

```bash
cat > ~/Library/LaunchAgents/com.uranus.imessage.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.uranus.imessage</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>server/src/index.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/你的用户名/Uranus_Imessage</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/uranus.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/uranus.err</string>
</dict>
</plist>
EOF
```

加载它：

```bash
launchctl load ~/Library/LaunchAgents/com.uranus.imessage.plist
```

看日志：

```bash
tail -f /tmp/uranus.log
```

停掉：

```bash
launchctl unload ~/Library/LaunchAgents/com.uranus.imessage.plist
```

> ⚠️ **本地模式配 launchd 会碰到权限麻烦**：launchd 起的进程不继承终端的完全磁盘访问权限，得单独给 `node` 那个二进制授权，比较绕。本地模式建议就用 [第 6 章](#6-做一个双击就能启动的文件) 那个双击启动的办法。

### 8.3 改端口

临时：

```bash
PORT=8888 npm start
```

写进那个 `.command` 文件的话，在 `npm start` 前面加一行 `export PORT=8888`。

**可用的环境变量**：

| 变量 | 作用 |
|---|---|
| `PORT` | 控制台端口，默认 `8787` |
| `URANUS_IG_PORT` | Instagram 端口，默认 `6873`。设成 `off` 就不开这个端口 |
| `URANUS_NO_BROWSER=1` | 启动后不自动开浏览器（只对 `launch.mjs` 那条路有效） |
| `URANUS_DATA_DIR` | 把数据目录挪到别处 |
| `URANUS_PROXY` | 出网代理，和控制台里填的等价 |
| `FFMPEG_BIN` | 指定 ffmpeg 路径 |

### 8.4 把数据放到别的盘

数据默认在项目目录下的 `data/`。挪到别处（比如外置硬盘）：

```bash
URANUS_DATA_DIR=/Volumes/MyDisk/UranusData npm start
```

**第一次启动它会自己把目录建出来。** 已经有数据的话先把原来的 `data` 整个拷到新位置。

> 💡 项目自带的素材（默认壁纸、开箱预设）在 `assets/` 里，那是只读的、跟代码走，**不受这个变量影响**。

### 8.5 手机上访问 Mac 跑的服务

同一个 Wi-Fi 下，手机浏览器打开 `http://你Mac的局域网IP:8787`。

**查 IP**：

```bash
ipconfig getifaddr en0
```

（`en0` 是 Wi-Fi。用网线的话试 `en1`；或者去 系统设置 → 网络 里看）

**打不开**的话是防火墙拦了。系统设置 → **网络** → **防火墙** → **选项**，把 node 加进允许列表，或者干脆把防火墙关掉试一下确认是不是这个原因。

> ⚠️ **别为了外网访问去路由器上做端口映射。** 那等于把你的 API 密钥和全部聊天记录挂到公网，而默认密码是公开写在文档里的。要在外面访问就装个 [Tailscale](https://tailscale.com/download)，手机和 Mac 登同一个账号，用它给的 `100.x.x.x` 地址访问——不用开任何端口。

---

**最后一句**：所有数据都在项目目录的 `data/` 文件夹里。
只要这个文件夹在，换电脑、重装系统都能原地复活——拷过去就行。

---

⬅️ [Windows 部署](Windows部署教程.md) ｜ ➡️ [VPS 部署](VPS部署教程.md)（想 24 小时在线看这个）
