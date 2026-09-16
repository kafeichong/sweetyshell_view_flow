#!/usr/bin/env bash
# 一键把 ffprobe 装到 `~/.video-flow/` —— 给**没有 Homebrew** 的机器用。
#
# 正常情况用不着它：`install.sh` 已经会把**随包带来的**那份装好。这个脚本是补救入口——
# 比如客户端装完之后才发现缺 ffprobe，或者包里的那份没装上。
#
# 实际逻辑在 install_ffprobe.sh（与安装器共用一份，避免两边行为不一致）。
# 双击即可运行。装完**重启 ComfyUI**。
set -uo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NONINTERACTIVE="${VIDEO_FLOW_NONINTERACTIVE:-}"

notify() {
  test "$NONINTERACTIVE" = "1" && return 0
  osascript -e "display dialog \"$1\" buttons {\"完成\"} default button \"完成\"" >/dev/null 2>&1 || true
}

printf 'Video Flow —— 安装 ffprobe\n'
printf '================================\n\n'

if "$SOURCE_DIR/install_ffprobe.sh"; then
  printf '\n请**完全退出并重新启动 ComfyUI**，然后视频/音频素材检查就能用了。\n'
  notify "ffprobe 安装完成。请完全退出并重新启动 ComfyUI。"
else
  printf '\n没能装好。请双击同目录的「诊断.command」，把输出发给管理员。\n'
  notify "ffprobe 没能装好，请双击「诊断.command」把输出发给管理员。"
  exit 1
fi
