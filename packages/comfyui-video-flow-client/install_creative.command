#!/usr/bin/env bash
# macOS 创意同事一键安装入口。
#
# 双击即可运行：选择 ComfyUI 目录后，在系统隐藏输入框中粘贴个人 token。
# token 只短暂写入权限 600 的临时文件，再由 install.sh 安全放入
# ~/.video-flow/token；不进入 Workflow、终端输出或进程参数。
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMFYUI_ROOT="${VIDEO_FLOW_COMFYUI_ROOT:-}"
TOKEN_SOURCE="${VIDEO_FLOW_TOKEN_FILE:-}"
TEMP_TOKEN=""

cleanup() {
  if test -n "$TEMP_TOKEN"; then
    rm -f -- "$TEMP_TOKEN"
  fi
}
trap cleanup EXIT

is_comfyui_root() {
  test -x "$1/.venv/bin/python" && test -d "$1/custom_nodes"
}

choose_comfyui_root() {
  local candidate
  for candidate in "$HOME/ComfyUI" "$HOME/Documents/ComfyUI" "/Volumes/lvmac/ai/ComfyUI/ComfyUI"; do
    if is_comfyui_root "$candidate"; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  osascript -e 'POSIX path of (choose folder with prompt "请选择 ComfyUI 根目录")'
}

if test -z "$COMFYUI_ROOT"; then
  if test "${VIDEO_FLOW_NONINTERACTIVE:-}" = "1"; then
    echo "error: noninteractive mode requires VIDEO_FLOW_COMFYUI_ROOT" >&2
    exit 2
  fi
  command -v osascript >/dev/null || {
    echo "error: 此安装器仅支持 macOS 图形界面；请设置 VIDEO_FLOW_COMFYUI_ROOT" >&2
    exit 2
  }
  COMFYUI_ROOT="$(choose_comfyui_root)"
fi

COMFYUI_ROOT="${COMFYUI_ROOT%/}"
if ! is_comfyui_root "$COMFYUI_ROOT"; then
  echo "error: 不是有效的 ComfyUI 目录（需要 .venv/bin/python 和 custom_nodes）：$COMFYUI_ROOT" >&2
  exit 2
fi

if test -z "$TOKEN_SOURCE"; then
  if test "${VIDEO_FLOW_NONINTERACTIVE:-}" = "1"; then
    echo "error: noninteractive mode requires VIDEO_FLOW_TOKEN_FILE" >&2
    exit 2
  fi
  TOKEN="$(osascript -e 'text returned of (display dialog "粘贴 Video Flow 个人凭证。该凭证只保存到本机安全目录，不会写入工作流。" default answer "" with hidden answer buttons {"取消", "继续"} default button "继续")')"
  if test -z "$TOKEN"; then
    echo "error: token 不能为空" >&2
    exit 2
  fi
  umask 077
  TEMP_TOKEN="$(mktemp "${TMPDIR:-/tmp}/video-flow-token.XXXXXX")"
  printf '%s\n' "$TOKEN" > "$TEMP_TOKEN"
  unset TOKEN
  TOKEN_SOURCE="$TEMP_TOKEN"
fi

if ! test -s "$TOKEN_SOURCE"; then
  echo "error: token 文件不存在或为空" >&2
  exit 2
fi

"$SOURCE_DIR/install.sh" "$COMFYUI_ROOT" "$TOKEN_SOURCE"

if test "${VIDEO_FLOW_NONINTERACTIVE:-}" != "1"; then
  osascript -e 'display dialog "Video Flow 已安装完成。请完全退出并重新启动 ComfyUI，然后搜索 Video Flow 并导入图生视频模板。" buttons {"完成"} default button "完成"'
fi
