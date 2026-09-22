# VPS 部署教程

把 Uranus iMessage 装到云服务器上，24 小时在线，手机随时能连。

本文按 Ubuntu 22.04 / 24.04 写。Debian 12 命令基本一样。

---

## 目录

1. [第一次连上服务器](#1-第一次连上服务器)
2. [装服务：19 条命令](#2-装服务19-条命令)
3. [第一次打开控制台](#3-第一次打开控制台)
4. [日常维护](#4-日常维护)
5. [出问题了怎么办](#5-出问题了怎么办)
6. [附：所有命令速查](#6-附所有命令速查)

---

## 1. 第一次连上服务器

### 1.1 你需要三样东西

在云厂商控制台的「实例详情」里找：

- **公网 IP**（像 `47.98.xxx.xxx` 这样一串数字）
- **用户名**（一般是 `root`）
- **密码**（买的时候设的，或者厂商生成的）

### 1.2 在自己电脑上开终端

- **Windows**：按 `Win` 键 → 输入「终端」→ 打开 **Windows 终端** 或 **PowerShell**
- **Mac**：`Cmd + 空格` → 输入「终端」→ 回车

### 1.3 连上去

```bash
ssh root@你的服务器IP
```

第一次连会问 `Are you sure you want to continue connecting (yes/no)?`，输入 `yes` 回车。

然后提示 `password:`，**输密码**。

> ⚠️ **输密码时屏幕上什么都不显示**——没有星号、没有圆点、光标也不动。这是 Linux 的正常行为，不是卡住了。盲打完按回车。

连上后提示符变成这样（`iZbp...` 那串是你的主机名，每人不同）：

```
root@iZbp10nyrxjepyj8cq6iwvZ:~#
```

### 1.4 ssh 连不上怎么办

用云控制台自带的网页终端：

- **阿里云**：控制台 → 实例 → 远程连接 → **Workbench**
- **腾讯云**：控制台 → 实例 → 登录 → **标准登录方式**
- **Vultr / DigitalOcean / 搬瓦工**：控制台里找 **Console** 或 **Web Terminal**

网页终端和 SSH 效果完全一样。

> ⚠️ **别用 VNC**——那个粘贴不了长命令，中文还会乱码。本教程有整段多行的命令，粘进去必然坏。

---

## 2. 装服务：19 条命令

### 第 1 步：开 swap

拿 2G 硬盘当内存的备胎。**这条必须先做**，否则装依赖时系统会杀进程。

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile && echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

验证：

```bash
free -h
```

`Swap:` 那行应该是 `2.0Gi`，不是 `0B`。

---

### 第 2 步：更新系统

```bash
sudo apt update && sudo apt upgrade -y
```

中途弹出紫色的框（问要不要保留旧配置），**一路回车**选默认。

> **卡在下载不动？** 是软件源或 DNS 的问题，看 [第 5 步](#第-5-步检查网络境内外分叉) 和 [5.1](#51-什么都下不下来)。

---

### 第 3 步：装基础工具

```bash
sudo apt install -y curl wget nano unzip git
```

---

### 第 4 步：开 BBR

```bash
echo "net.core.default_qdisc=fq" | sudo tee /etc/sysctl.d/99-bbr.conf && echo "net.ipv4.tcp_congestion_control=bbr" | sudo tee -a /etc/sysctl.d/99-bbr.conf && sudo sysctl --system
```

验证：

```bash
sysctl net.ipv4.tcp_congestion_control
```

应该看到 `net.ipv4.tcp_congestion_control = bbr`。

---

### 第 5 步：检查网络（境内外分叉）

这是**唯一需要你自己判断环境**的地方。先跑：

```bash
nslookup github.com
```

**出了 IP 地址**（类似 `Address: 20.205.243.166`）→ **直接跳到第 6 步。**

**报 `Could not resolve` 或 `timed out`** → 按下面处理。境内机器大概率卡在这。

#### 境内机器的 DNS 修法

先看现在配的是什么：

```bash
resolvectl status
```

找 `Link 2 (eth0)` 那一段，看 `DNS Servers:` 是什么。多半是 `100.100.2.136` 这类云厂商内网 DNS，而它不通了（VPC 配置变了，或者你装了 Tailscale 之后 MagicDNS 跟它打架）。

换成国内公共 DNS：

```bash
sudo resolvectl dns eth0 223.5.5.5 223.6.6.6 119.29.29.29 && sudo resolvectl flush-caches
```

再验证：

```bash
nslookup github.com
```

**出 IP 就通了。**

然后让它永久生效（不做的话重启就丢）：

```bash
sudo tee /etc/netplan/99-dns.yaml > /dev/null <<'EOF'
network:
  version: 2
  ethernets:
    eth0:
      dhcp4-overrides:
        use-dns: false
      nameservers:
        addresses: [223.5.5.5, 223.6.6.6, 119.29.29.29]
EOF
sudo chmod 600 /etc/netplan/99-dns.yaml && sudo netplan apply
```

> ⚠️ **网卡名不一定是 `eth0`**。`resolvectl status` 里 `Link 2 (eth0)` 括号里那个才是真的，也可能是 `ens3`、`enp1s0`。**两处都要换成你的**：上面 `resolvectl dns` 的第一个参数，和 netplan 文件里的 `eth0:`。
>
> **如果 `netplan apply` 之后 SSH 断了**：用云控制台的网页终端（[1.4](#14-ssh-连不上怎么办)）进去，`sudo rm /etc/netplan/99-dns.yaml && sudo netplan apply` 就恢复了。

> ⚠️ **别用 `1.1.1.1` 或 `8.8.8.8`**。Cloudflare 和 Google 的 DNS 在国内时通时不通，用了会把「稳定坏」变成「时好时坏」，排查难度翻倍。境内就用 `223.5.5.5`、`119.29.29.29`。

**关于 Tailscale 的 MagicDNS**：装完 Tailscale 后 `resolvectl status` 会多出一段 `tailscale0`，DNS 是 `100.100.100.100`。**不用管它**，它只管 `*.ts.net` 那类域名，普通域名还是走你设的公共 DNS，两边不打架。

#### 最后再测一下实际下载

境内外都要跑：

```bash
curl -sI https://github.com | head -1
```

应该看到 `HTTP/2 200` 之类。**连不上不要紧**——只要 DNS 能解析，第 8 步的镜像方案能绕过去。

---

### 第 6 步：装 nvm

nvm 是 Node 版本管理器。用它装 Node 比系统源方便——Ubuntu 24.04 自带源里的 Node 是 18，**这个项目要 20 以上**。

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
```
刷新环境变量并让nvm生效
```bash
source ~/.bashrc
```

#### 卡住或报错的话（境内机器常见）

`raw.githubusercontent.com` 在国内时通时不通。换 Gitee 镜像：

```bash
curl -o- https://gitee.com/RubyMetric/nvm-cn/raw/main/install.sh | bash
```

**Gitee 也慢的话**，绕开 nvm，直接从 Node 官网下二进制包：

```bash
cd /tmp && curl -LO https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz
```

下载完解开并建软链：

```bash
sudo tar -xJf /tmp/node-v22.14.0-linux-x64.tar.xz -C /opt && sudo ln -sf /opt/node-v22.14.0-linux-x64/bin/node /usr/local/bin/node && sudo ln -sf /opt/node-v22.14.0-linux-x64/bin/npm /usr/local/bin/npm && sudo ln -sf /opt/node-v22.14.0-linux-x64/bin/npx /usr/local/bin/npx
```

验证：

```bash
node -v && npm -v
```

出 `v22.14.0` 就成了，**然后直接跳到第 8 步**（第 7 步是给 nvm 路线用的）。

（`nodejs.org` 也不通的话，把它换成 `mirrors.tuna.tsinghua.edu.cn/nodejs-release`，路径不变。）

#### nvm 路线的收尾

重新加载终端配置：

```bash
source ~/.bashrc
```

验证：

```bash
nvm --version
```

出个像 `0.40.1` 的版本号。

---

### 第 7 步：装 Node 22（nvm 路线）

```bash
nvm install 22 && nvm alias default 22
```

验证：

```bash
node -v && npm -v
```

**应该看到 `v22.x.x`**。如果看到 `v18`，说明前面哪步错了，重跑这条命令。

---

### 第 8 步：把代码拉下来

```bash
sudo mkdir -p /opt && cd /opt && sudo git clone https://github.com/nikonotnicotine/Uranus_Imessage.git imessage && sudo chown -R $USER:$USER /opt/imessage && cd /opt/imessage
```

验证拉对了：

```bash
ls
```

应该看到 `server`、`client`、`assets`、`scripts`、`README.md`。

#### 卡住不动的话（境内机器）

**能连上只是慢**，用浅克隆：

```bash
cd /opt && sudo rm -rf imessage && sudo git clone --depth 1 https://github.com/nikonotnicotine/Uranus_Imessage.git imessage && sudo chown -R $USER:$USER /opt/imessage && cd /opt/imessage
```

> ⚠️ 浅克隆的仓库不能直接 `git pull`。以后更新前先补全历史：`cd /opt/imessage && git fetch --unshallow`。

**完全连不上**，换个加速前缀重试（下面几个换着来）：

```bash
cd /opt && sudo rm -rf imessage && sudo git clone https://ghproxy.net/https://github.com/nikonotnicotine/Uranus_Imessage.git imessage && sudo chown -R $USER:$USER /opt/imessage && cd /opt/imessage
```

可用的前缀：`https://ghproxy.net/`、`https://gh-proxy.com/`、`https://mirror.ghproxy.com/`，拼在 `https://github.com/...` 前面就行。

**你本机有梯子的话**，在**自己电脑**的终端里直接传上去（不是在服务器里敲）：

```bash
scp -r ./Uranus_Imessage root@你的服务器IP:/opt/imessage
```

传完回服务器改归属：`sudo chown -R $USER:$USER /opt/imessage`。

---

### 第 9 步：装依赖

```bash
npm install
```

**这一步要 2~5 分钟**，是在下几百个包，**不是卡死了**。

判断它还在跑：另开一个终端连上服务器敲 `free -h`，看内存或 swap 在动。

结尾应该看到类似 `added 400+ packages in 2m`。

#### 慢得离谱的话（境内机器）

```bash
npm config set registry https://registry.npmmirror.com
```

再重装：

```bash
rm -rf node_modules package-lock.json && npm install
```

> 💡 `npm config set` 是全局的，会影响这台机器上所有 Node 项目。只想给这一次用：`npm install --registry=https://registry.npmmirror.com`。

#### 出现 `Killed` 字样

说明 swap 没开成功，回第 1 步重做。还不行就降并发：

```bash
npm install --maxsockets 1
```

---

### 第 10 步：构建前端

```bash
npm run build
```

应该看到 `✓ built in 10s`。

---

### 第 11 步：手动试跑一次

```bash
npm start
```

**应该看到**：

```
  → http://localhost:8787
  → Instagram: http://localhost:6873
```

看到就成功了。**按 `Ctrl + C` 停掉**，接下来交给 systemd 管。

---

### 第 12 步：找 node 的真实路径

```bash
which node
```

应该看到类似 `/root/.nvm/versions/node/v22.14.0/bin/node`。

**复制下来，下一步要填。**

> 第 6 步走的是「直接下二进制包」那条路的话，这里会显示 **`/usr/local/bin/node`**，一样填它。

---

### 第 13 步：配开机自启

**把下面 `ExecStart` 那行的路径换成第 12 步查到的**：

```bash
sudo tee /etc/systemd/system/uranus.service > /dev/null <<EOF
[Unit]
Description=Uranus iMessage
After=network.target

[Service]
WorkingDirectory=/opt/imessage
ExecStart=$(which node) server/src/index.js
Restart=always
Environment=PORT=8787
Environment=URANUS_SUPERVISOR=1

[Install]
WantedBy=multi-user.target
EOF
```

看不懂可以跳，这里逐行解释一下：

| 行 | 意思 |
|---|---|
| `WorkingDirectory` | 在哪个目录里运行 |
| `ExecStart` | 启动命令。**直接指 node 本体，不绕 npm 那层壳** |
| `Restart=always` | 不管怎么退出的都自动重来 |
| `Environment=PORT=8787` | 服务端口 |
| `Environment=URANUS_SUPERVISOR=1` | 告诉程序「退出了有人负责拉起来」，控制台的「重启服务」按钮靠这个才肯干活 |

---

### 第 14 步：启动服务

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now uranus
```

等几秒看状态：

```bash
sleep 3 && systemctl status uranus --no-pager
```

**应该看到** `Active: active (running)`。

看到 `failed` 就看日志：

```bash
journalctl -u uranus -n 50 --no-pager
```

---

### 第 15 步：验证服务

```bash
curl -sI http://127.0.0.1:8787 | head -3
```

应该看到 `HTTP/1.1 200 OK`。

到这里服务已经在跑、并且开机自启了。**最后解决「怎么从外面访问」。**

---

### 第 16 步：装 Tailscale

Tailscale 是组网工具。装完之后你的手机和电脑就像和服务器在同一个局域网里，**不用在云控制台开任何端口**。

先看是不是已经装过：

```bash
tailscale version
```

有版本号就跳过，直接走第 17 步。没有就装：

```bash
curl -fsSL https://tailscale.com/install.sh | sh
```

#### 下载卡住的话（境内机器）

用官方 apt 源装。先查版本代号：

```bash
lsb_release -cs
```

输出 `jammy` 是 22.04，`noble` 是 24.04。**把下面两处 `noble` 换成你查到的**：

```bash
curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg | sudo tee /usr/share/keyrings/tailscale-archive-keyring.gpg >/dev/null && curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list | sudo tee /etc/apt/sources.list.d/tailscale.list && sudo apt update && sudo apt install -y tailscale
```

---

### 第 17 步：登录 Tailscale

```bash
sudo tailscale up
```

会吐一个 `https://login.tailscale.com/a/xxxxxxxxxxxx` 的网址。**复制到浏览器打开登录**（Google、GitHub、微软账号都行）。登完回终端，命令会自己结束。

> 💡 国内打开这个登录页偶尔很慢，**挂个梯子登一次就行**——凭证存在本地，之后不用再登。

---

### 第 18 步：拿到服务器的 Tailscale IP

```bash
tailscale ip -4
```

应该看到类似 `100.184.76.5`。**记下来，以后就用它访问。**

---

### 第 19 步：在自己电脑和手机上装 Tailscale

去 [tailscale.com/download](https://tailscale.com/download) 下载，手机在应用商店搜 **Tailscale**。**用同一个账号登录。**

然后在浏览器打开（IP 换成第 18 步查到的）：

```
http://100.184.76.5:8787
```

看到登录页就成了。

---

## 3. 第一次打开控制台

### 3.1 登录并改密码

默认账号密码都是 `Uranus`。

> ⚠️ **这个密码是公开写在文档里的**，服务一旦暴露在公网任何人都能登进来。这就是本教程坚持用 Tailscale、不开公网端口的原因。

进去之后会**强迫你改密码**（跳不过去），要求**至少 8 位，至少一个大写字母**。不改的话除了改密码什么操作都做不了。

### 3.2 填配置

按这个顺序：

1. **连接** → 填模型 API 地址和密钥，把要用的模型加进清单
2. **iMessage** → 一个项目 = 一条号码，填 Photon 的凭据
3. **角色** → 建角色，选人设、选模型、绑号码
4. **用户** → 填你自己是谁（提示词里的 `{{user}}`）

### 3.3 代理怎么填

去**控制台 · 代理**。改完当场生效，不用重启。

**默认已经勾好了 Instagram 和联网搜索**——这两类在国内直连吃满超时。

几条要紧的：

- **天气、Photon（iMessage 桥接）、音乐实测直连都通，不用勾。** 套上代理反而可能因为落地 IP 变了被风控
- **模型 API** 打的是你自己买的中转站，多半直连通。套上反而慢
- **勾了也不怕代理没开**：勾上的类别在代理连不上时会自动脱开代理直连再试一次。反过来不会——没勾的类别绝不会偷偷走代理
- 只能填 `http://` 或 `https://`，**`socks5://` 用不了**。Clash、v2rayN 那类客户端一般同时开着一个 http 端口（默认 7890 / 10809），用那个
- 面板旁边有「测试连通」和「测一下直连」两个按钮。**两个都点**：都通说明这个源不需要代理（把勾取消）；都不通说明服务器出网有问题，跟代理无关
- 地址可能带账号密码，所以和 API 密钥一起存在 `data/data.config.json` 里，界面只回显脱敏后的样子。也可以用环境变量 `URANUS_PROXY` 替代（见 [4.5](#45-改配置)）

**境外机器**：Instagram 和联网搜索多半直连就通，进去后把默认勾的两个取消掉，点「测一下直连」验一下。

---

## 4. 日常维护

### 4.1 访问地址

两个端口：

| 端口 | 是什么 |
|---|---|
| **8787** | 控制台，所有配置都在这 |
| **6873** | Instagram 页面（角色的主页） |

访问方式都是 `http://100.x.x.x:端口号`。手机上装好 Tailscale 登录同一账号，浏览器直接打开就行；iOS 可以在 Safari 里「添加到主屏幕」当 App 用。

**6873 起不来**的话控制台还能正常用，只是 Instagram 页没了。换个端口：

```bash
sudo systemctl edit uranus
```

在编辑器里加：

```ini
[Service]
Environment=URANUS_IG_PORT=6874
```

保存退出后 `sudo systemctl restart uranus`。

### 4.2 常用命令

看状态：

```bash
systemctl status uranus --no-pager
```

重启：

```bash
sudo systemctl restart uranus
```

停止 / 启动：

```bash
sudo systemctl stop uranus
```

```bash
sudo systemctl start uranus
```

看实时日志（`Ctrl + C` 退出）：

```bash
journalctl -u uranus -f
```

看最近 100 行日志：

```bash
journalctl -u uranus -n 100 --no-pager
```

看磁盘和内存：

```bash
df -h / && free -h && du -sh /opt/imessage/data
```

### 4.3 更新到新版本

```bash
cd /opt/imessage && git pull && npm install && npm run build && sudo systemctl restart uranus
```

> ⚠️ `git pull` 报「本地修改会被覆盖」说明你改过仓库里的文件。先 `git status` 看改了哪些，决定保留还是丢弃，**别硬来**。

> 💡 仓库里那个 `更新.bat` / `scripts/update.mjs` 是给 Windows 用的（停服务靠 `taskkill`，重启靠 `cmd`），在这里跑会直接告诉你用上面这行。VPS 上本来就是 git + systemd，没必要多套一层。

### 4.4 备份

**所有数据都在 `/opt/imessage/data/` 这一个文件夹里**，备份就是拷走它：

```bash
tar czf ~/uranus-backup-$(date +%Y%m%d).tar.gz -C /opt/imessage data
```

恢复（先停服务）：

```bash
sudo systemctl stop uranus && tar xzf ~/uranus-backup-20260915.tar.gz -C /opt/imessage && sudo systemctl start uranus
```

> 💡 控制台里也有「备份 / 恢复」和「云备份」，图形界面操作，不用敲命令。

### 4.5 改配置

**改环境变量**（比如代理、端口）：

```bash
sudo systemctl edit uranus
```

加一行 `Environment=变量名=值`，保存后 `sudo systemctl restart uranus`。

### 4.6 系统安全更新

```bash
sudo apt install -y unattended-upgrades && sudo dpkg-reconfigure --priority=low unattended-upgrades
```

弹框问「是否自动下载并安装安全更新」时选 **Yes**。

### 4.7 提示要重启时

登录看到 `*** System restart required ***` 是内核更新过了，不急，方便的时候：

```bash
sudo reboot
```

重启后等一分钟连回去（Tailscale 会自己重连），确认服务起来了：

```bash
systemctl status uranus --no-pager
```

### 4.8 关于 1Panel

**用不上，建议不装。**

1Panel 是管站点和容器的面板，适合「跑好几个网站、好几个容器」的场景。你的需求是「一条服务 + 一个端口」，systemd 就够了，而且：

- 它自己会常驻一个进程占内存，2G 机器上这个开销不值得
- 它会拉一个 Docker 进来。**真正吃内存的是你之后在面板里点的应用**——手滑点了 MySQL + OpenResty，2G 机器直接废
- 你的服务已经归 systemd 管了，跟 1Panel 是两套并行系统，不会互相接管

**已经装了也不冲突**，只是白占内存，想删按 1Panel 官方文档卸载。想要图形界面看日志不如直接 `journalctl -u uranus -f`。

---

## 5. 出问题了怎么办

### 5.1 什么都下不下来

`apt`、`curl`、`git` 全部报 `Could not resolve`。**这是 DNS 坏了**，回 [第 5 步](#第-5-步检查网络境内外分叉)。

先分清是 DNS 还是真断网：

```bash
ping -c 2 223.5.5.5
```

- **能通** → 网络没问题，就是 DNS 的锅
- **不通** → 出网真有问题，可能是欠费停机、安全组拦了、VPC 配置不对。命令行解决不了，去云控制台看

### 5.2 服务起不来

```bash
journalctl -u uranus -n 100 --no-pager
```

| 日志里出现 | 原因 | 怎么办 |
|---|---|---|
| `Cannot find module` | 依赖没装完，或 node 路径填错 | 回第 9 步、第 12 步 |
| `EADDRINUSE` | 8787 被别的进程占了 | 见 [5.3](#53-端口被占用) |
| `EACCES` | 权限问题 | `ls -ld /opt/imessage` 检查归属 |
| `EADDRNOTAVAIL` | 端口配置有问题 | 检查 unit 文件里的 `Environment=PORT=` |

### 5.3 端口被占用

```bash
sudo ss -tlnp | grep 8787
```

看是谁占着。是你之前手动 `npm start` 忘了关的话：

```bash
sudo pkill -f "server/src/index.js"
```

然后 `sudo systemctl restart uranus`。

### 5.4 npm install 被杀

出现 `Killed` 或 `signal SIGKILL`，说明内存不够。

```bash
free -h
```

`Swap:` 那行是 `0B` 的话，回[第 1 步](#第-1-步开-swap)重做。swap 正常还是被杀就 `npm install --maxsockets 1`。

### 5.5 忘了控制台密码

```bash
nano /opt/imessage/data/auth.json
```

找到 `"password"` 那行，把值改成 `null`（**只改这一行**）：

```json
"password": null,
```

`Ctrl + O` 保存，`Ctrl + X` 退出。刷新控制台页面，密码就变回默认的 `Uranus` 了，进去后重新设一个。

### 5.6 磁盘满了

```bash
df -h / && du -sh /opt/imessage/data
```

- **data 目录太大**：角色的图片、语音、聊天记录都在里面，控制台「上下文」里删掉不需要的旧会话
- **日志太大**：`sudo journalctl --vacuum-size=200M`
- **apt 缓存**：`sudo apt clean`

### 5.7 还是搞不定

把这三条的输出发到 QQ 群 `1125033956`：

```bash
systemctl status uranus --no-pager
```

```bash
journalctl -u uranus -n 50 --no-pager
```

```bash
node -v && lsb_release -a && free -h && df -h /
```

另外说一下**你在哪个机房、用的哪家厂商**，这两条对判断问题很有用。

**发之前把里面的 IP、密钥、手机号打码。**

---

## 6. 附：所有命令速查

按顺序复制，就是完整流程。

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile && echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

```bash
sudo apt update && sudo apt upgrade -y
```

```bash
sudo apt install -y curl wget nano unzip git
```

```bash
echo "net.core.default_qdisc=fq" | sudo tee /etc/sysctl.d/99-bbr.conf && echo "net.ipv4.tcp_congestion_control=bbr" | sudo tee -a /etc/sysctl.d/99-bbr.conf && sudo sysctl --system
```

```bash
nslookup github.com
```

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
```

```bash
source ~/.bashrc
```

```bash
nvm install 22 && nvm alias default 22
```

```bash
sudo mkdir -p /opt && cd /opt && sudo git clone https://github.com/nikonotnicotine/Uranus_Imessage.git imessage && sudo chown -R $USER:$USER /opt/imessage && cd /opt/imessage
```

```bash
npm install
```

```bash
npm run build
```

```bash
npm start
```

```bash
which node
```

```bash
sudo tee /etc/systemd/system/uranus.service > /dev/null <<'EOF'
[Unit]
Description=Uranus iMessage
After=network.target

[Service]
WorkingDirectory=/opt/imessage
ExecStart=把这里换成 which node 的输出
Restart=always
Environment=PORT=8787
Environment=URANUS_SUPERVISOR=1

[Install]
WantedBy=multi-user.target
EOF
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now uranus
```

```bash
curl -fsSL https://tailscale.com/install.sh | sh
```

```bash
sudo tailscale up
```

```bash
tailscale ip -4
```

---

**最后一句**：这个项目的全部数据都在 `/opt/imessage/data/`。
只要这个文件夹在，换服务器、重装系统都能原地复活——拷过去就行。
