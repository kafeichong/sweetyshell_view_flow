#!/usr/bin/env bash
# 一键把 ffprobe 装到 `~/.video-flow/` —— 给**没有 Homebrew** 的机器用。
#
# 为什么需要：本地素材检查要 ffprobe（读视频/音频的时长、帧率、编码），它随 ffmpeg 一起发。装了
# Homebrew 的机器一条 `brew install ffmpeg` 就够了；没有 Homebrew 的，双击本脚本即可：
#
#   1. 按芯片架构（Apple Silicon → arm64 / Intel → amd64）挑对应的包下载；
#   2. 放进 `~/.video-flow/ffprobe`（客户端会去那儿找，**不用配环境变量**——
#      Comfy Desktop 从 GUI 启动，改了 .zshrc 里的 PATH 也传不进来）；
#   3. 去掉 macOS 给下载文件打的隔离标记，否则系统会拒绝运行（"无法验证开发者"）。
#
# 双击即可运行。装完**重启 ComfyUI**。
set -uo pipefail

DEST_DIR="$HOME/.video-flow"
DEST="$DEST_DIR/ffprobe"
NONINTERACTIVE="${VIDEO_FLOW_NONINTERACTIVE:-}"

say() { printf '%s\n' "$*"; }
notify() {
  test "$NONINTERACTIVE" = "1" && return 0
  osascript -e "display dialog \"$1\" buttons {\"完成\"} default button \"完成\"" >/dev/null 2>&1 || true
}

say "Video Flow —— 安装 ffprobe"
say "================================"

if test -x "$DEST" && "$DEST" -version >/dev/null 2>&1; then
  say "已经装好了，不用再来一次：$DEST"
  "$DEST" -version 2>/dev/null | head -1 | sed 's/^/  /'
  notify "ffprobe 已经就绪，无需重新安装。"
  exit 0
fi

# 按芯片架构选包。用 uname -m 而不是 sysctl：后者在 Rosetta 下会谎报成 x86_64。
MACHINE="$(uname -m)"
case "$MACHINE" in
  arm64)  ARCH="arm64" ;;
  x86_64) ARCH="amd64" ;;
  *) say "error: 认不出的芯片架构：$MACHINE"; notify "认不出这台机器的芯片架构，请把终端窗口内容发给管理员。"; exit 1 ;;
esac
say "芯片：${MACHINE}（下载 macos/${ARCH} 版）"

URL="https://ffmpeg.martin-riedl.de/redirect/latest/macos/$ARCH/release/ffprobe.zip"
WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT

say ""
say "正在下载（二十多 MB，网络慢的话请多等一会儿）…"
if ! curl -fL --progress-bar --max-time 900 -o "$WORK/ffprobe.zip" "$URL"; then
  say ""
  say "error: 下载失败。请检查网络后重试，或让管理员直接把 ffprobe 发给你。"
  notify "下载失败。请检查网络后重试，或联系管理员。"
  exit 1
fi

say ""
say "解压…"
if ! unzip -oq "$WORK/ffprobe.zip" -d "$WORK"; then
  say "error: 解压失败"; notify "解压失败，请把终端窗口内容发给管理员。"; exit 1
fi

# 压缩包里可能带一层目录，别写死路径。
BIN="$(find "$WORK" -type f -name ffprobe | head -1)"
if test -z "$BIN"; then
  say "error: 压缩包里没有 ffprobe"; notify "压缩包里没找到 ffprobe，请把终端窗口内容发给管理员。"; exit 1
fi

mkdir -p "$DEST_DIR"
chmod 700 "$DEST_DIR"
cp "$BIN" "$DEST"
chmod +x "$DEST"
# 不摘隔离标记的话，系统会在运行时拦下来（"无法验证开发者"）。
xattr -d com.apple.quarantine "$DEST" 2>/dev/null || true

say ""
say "验证…"
if "$DEST" -version >/dev/null 2>&1; then
  say "✅ 装好了：$DEST"
  "$DEST" -version 2>/dev/null | head -1 | sed 's/^/  /'
  say ""
  say "请**完全退出并重新启动 ComfyUI**，然后视频/音频素材检查就能用了。"
  notify "ffprobe 安装完成。请完全退出并重新启动 ComfyUI。"
else
  say "⚠️  文件放好了但跑不起来。请双击同目录的「诊断.command」，把输出发给管理员。"
  notify "ffprobe 装上了但无法运行，请双击「诊断.command」把输出发给管理员。"
  exit 1
fi
