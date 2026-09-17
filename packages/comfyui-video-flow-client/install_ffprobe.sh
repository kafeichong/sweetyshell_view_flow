#!/usr/bin/env bash
# 把 ffprobe 装到 `~/.video-flow/`。**优先用随包带来的那份**，没有才去下载。
#
# 为什么要有这个：本地素材检查要 ffprobe（读视频/音频的时长、帧率、编码），它随 ffmpeg 一起发。
# 装了 Homebrew 的机器一条 `brew install ffmpeg` 就够；但同事那台**连 Homebrew 都没有**，让他开
# 终端敲命令更不现实。所以包里直接带两份（arm64 / amd64），安装时按芯片挑一份装上，**不下载**。
#
# 装到 `~/.video-flow/ffprobe` 而不是别处：客户端会去那儿找，**不用配环境变量**——Comfy Desktop
# 从 GUI 启动，改了 .zshrc 里的 PATH 也传不进来。另外下载/拷贝来的二进制会被 macOS 打上隔离标记，
# 不摘掉会被系统拒绝运行（"无法验证开发者"），所以装完要 `xattr -d`。
#
# 用法: ./install_ffprobe.sh        # 装到 $HOME/.video-flow/ffprobe
#       VIDEO_FLOW_FORCE=1 ./install_ffprobe.sh   # 已存在也重装
# 退出码 0 = 可用（含"本来就有"）；非 0 = 失败，原因打到 stderr。
set -uo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="$HOME/.video-flow"
DEST="$DEST_DIR/ffprobe"
BUNDLE_DIR="$SOURCE_DIR/ffprobe"

is_usable() { test -x "$1" && "$1" -version >/dev/null 2>&1; }

if test "${VIDEO_FLOW_FORCE:-}" != "1" && is_usable "$DEST"; then
  echo "ffprobe 已就绪: $DEST"
  exit 0
fi

# 用 uname -m 而不是 sysctl：后者在 Rosetta 下会把 arm64 机器谎报成 x86_64。
case "$(uname -m)" in
  arm64)  ARCH="arm64" ;;
  x86_64) ARCH="amd64" ;;
  *) echo "error: 认不出的芯片架构：$(uname -m)" >&2; exit 1 ;;
esac

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
ZIP=""

BUNDLED="$BUNDLE_DIR/ffprobe-macos-$ARCH.zip"
if test -f "$BUNDLED"; then
  echo "用随包带来的 ffprobe（$(uname -m)）…"
  ZIP="$BUNDLED"
else
  # 包里没带（或带了别的架构）才下载。不加 --max-time：慢网络下容易误杀。
  echo "包里没带对应架构的 ffprobe，改为下载（二十多 MB，慢的话请等）…"
  URL="https://ffmpeg.martin-riedl.de/redirect/latest/macos/$ARCH/release/ffprobe.zip"
  if ! curl -fL --progress-bar -o "$WORK/ffprobe.zip" "$URL"; then
    echo "error: 下载失败，或包内缺少 ffprobe-macos-$ARCH.zip" >&2
    exit 1
  fi
  ZIP="$WORK/ffprobe.zip"
fi

if ! unzip -oq "$ZIP" -d "$WORK"; then
  echo "error: 解压失败: $ZIP" >&2
  exit 1
fi
BIN="$(find "$WORK" -type f -name ffprobe | head -1)"
if test -z "$BIN"; then
  echo "error: 压缩包里没有 ffprobe: $ZIP" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"
chmod 700 "$DEST_DIR"
cp "$BIN" "$DEST"
chmod +x "$DEST"
# 不摘隔离标记的话，系统会在运行时拦下来。
xattr -d com.apple.quarantine "$DEST" 2>/dev/null || true

if is_usable "$DEST"; then
  echo "ffprobe 已装好: $DEST"
  "$DEST" -version 2>/dev/null | head -1 | sed 's/^/  /'
  exit 0
fi
echo "error: 装上了但跑不起来: $DEST" >&2
exit 1
