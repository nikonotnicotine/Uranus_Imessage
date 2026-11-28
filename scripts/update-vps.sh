#!/usr/bin/env bash
#
# VPS 上一键更新：拉代码 → 装依赖 → 构建前端 → 重启。
#
# 用法（在 /opt/imessage 下，用 root 跑）：
#   sudo bash scripts/update-vps.sh
#
# ── 为什么不是一行 git pull && npm install && npm run build ──
#
# 那一行在真实的 VPS 上会连着踩三个坑，每一个的报错都不说人话：
#
#  1. **属主不是 root**。仓库是普通用户（比如 admin）的，root 跑一次
#     `npm install` 就会留下一堆 root 的文件，下次那个用户再更新就
#     「Permission denied」—— 而服务是用那个用户跑的，之后数据写不进去。
#  2. **Node 是 nvm 装的**，不在 /usr/bin 下。`sudo -u admin npm` 会报
#     「npm: command not found」，但 root 自己跑 npm 又是好的，很迷惑。
#  3. **systemd 服务名**每台机器可能不一样。
#
# 这个脚本把三件事都自己查出来，不用记。
set -euo pipefail

cd "$(dirname "$0")/.."
REPO="$(pwd)"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
die() { printf '\n\033[31m%s\033[0m\n\n' "$1" >&2; exit 1; }

# ── 1. 这个仓库是谁的 ────────────────────────────────────────
OWNER="$(stat -c '%U' "$REPO")"
say "仓库属主：$OWNER"

# root 跑的话全程 sudo -u 切过去；本来就是那个用户在跑就直接跑
if [ "$(id -un)" = "$OWNER" ]; then
  as_owner() { "$@"; }
elif [ "$(id -u)" -eq 0 ]; then
  as_owner() { sudo -u "$OWNER" env PATH="$PATH" "$@"; }
else
  die "这个仓库是 $OWNER 的，用 sudo 跑一下：sudo bash scripts/update-vps.sh"
fi

# ── 2. Node 在哪 ─────────────────────────────────────────────
#
# 先问 systemd：服务里写的那个路径一定是对的（它正在用）。
# 问不到再退回 PATH 上的。
UNIT="$(systemctl list-units --type=service --no-legend 2>/dev/null \
  | awk '/uranus/ {print $1; exit}')"

NODE_BIN=""
if [ -n "$UNIT" ]; then
  EXEC="$(systemctl show "$UNIT" -p ExecStart --value 2>/dev/null || true)"
  # ExecStart 里形如 { path=/home/x/.nvm/.../node ; argv[]=... }
  CAND="$(printf '%s' "$EXEC" | grep -oE '/[^ ;]*/bin/node' | head -1 || true)"
  [ -x "$CAND" ] && NODE_BIN="$(dirname "$CAND")"
fi
[ -z "$NODE_BIN" ] && command -v node >/dev/null && NODE_BIN="$(dirname "$(command -v node)")"
[ -z "$NODE_BIN" ] && die "找不到 node。装一个，或者先 nvm use。"

export PATH="$NODE_BIN:$PATH"
say "Node：$(node -v)（$NODE_BIN）"

# ── 3. 本地有没有改动 ────────────────────────────────────────
#
# `package-lock.json` 要单独处理：npm install 几乎每次都会动它（不同 npm 版本
# 写出来的格式有细微差别），而那不是用户改的，是上一次更新自己留下的。
# 为它拦住用户的话，这个脚本第二次跑就没法用了。
#
# 别的文件照拦 —— 那才可能是用户自己改的东西，不该替他决定丢还是留。
LOCK_DIRTY=0
if ! as_owner git -C "$REPO" diff --quiet -- package-lock.json 2>/dev/null; then
  LOCK_DIRTY=1
fi

OTHER="$(as_owner git -C "$REPO" status --porcelain -- . ':(exclude)package-lock.json' 2>/dev/null \
  | grep -v '^??' || true)"
if [ -n "$OTHER" ]; then
  printf '\n%s\n' "$OTHER"
  die "本地有没提交的改动（上面这些），git pull 会失败。
先想清楚是要留还是要丢：
  留 → git -C $REPO stash        （更新完 git stash pop 拿回来）
  丢 → git -C $REPO checkout -- <文件>"
fi

if [ "$LOCK_DIRTY" = 1 ]; then
  say "package-lock.json 被上次 npm install 动过了，丢掉重来"
  as_owner git -C "$REPO" checkout -- package-lock.json
fi

# ── 4. 拉 ────────────────────────────────────────────────────
say "拉代码"
BEFORE="$(as_owner git -C "$REPO" rev-parse HEAD)"
as_owner git -C "$REPO" pull --ff-only
AFTER="$(as_owner git -C "$REPO" rev-parse HEAD)"

# 代码没变也可能需要构建。
#
# 实测踩过：手动 git pull 拉了新代码但没跑构建，于是 client/dist 还是旧的 ——
# 界面上看不到新功能，而这个脚本一句「已经是最新的了」就退出，把人卡在那儿。
#
# 所以判据不是「代码变了吗」，而是**构建产物比源码旧吗**。
NEED_BUILD=0
if [ "$BEFORE" != "$AFTER" ]; then
  NEED_BUILD=1
else
  DIST="$REPO/client/dist/index.html"
  if [ ! -f "$DIST" ]; then
    NEED_BUILD=1
    say "前端还没构建过"
  else
    # 源码里有谁比构建产物新
    NEWER="$(find "$REPO/client/src" "$REPO/client/index.html" "$REPO/shared" -newer "$DIST" -print -quit 2>/dev/null || true)"
    if [ -n "$NEWER" ]; then
      NEED_BUILD=1
      say "前端源码比构建产物新（上次只拉了代码、没构建？）"
    fi
  fi
fi

if [ "$NEED_BUILD" = 0 ]; then
  say "已经是最新的了，而且前端也构建过，什么都不用做"
  exit 0
fi

# ── 5. 装依赖 + 构建 ─────────────────────────────────────────
say "装依赖"
as_owner npm --prefix "$REPO" install

say "构建前端"
as_owner npm --prefix "$REPO" run build

# ── 6. 重启 ──────────────────────────────────────────────────
if [ -n "$UNIT" ]; then
  say "重启 $UNIT"
  if [ "$(id -u)" -eq 0 ]; then systemctl restart "$UNIT"; else sudo systemctl restart "$UNIT"; fi
  sleep 2
  systemctl is-active --quiet "$UNIT" && say "起来了" || die "没起来，看日志：journalctl -u $UNIT -n 50"

  # 节点是独立的服务，装了才重启
  if systemctl list-unit-files 2>/dev/null | grep -q '^uranus-facetime\.service'; then
    say "重启通话节点"
    if [ "$(id -u)" -eq 0 ]; then systemctl restart uranus-facetime; else sudo systemctl restart uranus-facetime; fi
  fi
else
  say "没找到 systemd 服务，记得自己重启一下"
fi

say "更新完成：$(as_owner git -C "$REPO" log --oneline -1)"
