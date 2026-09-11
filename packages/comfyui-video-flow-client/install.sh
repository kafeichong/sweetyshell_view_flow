#!/usr/bin/env bash
set -euo pipefail

COMFYUI_ROOT="${1:?用法: ./install.sh /path/to/ComfyUI [actor-token-file]}"
TOKEN_SOURCE="${2:-}"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_BIN="$COMFYUI_ROOT/.venv/bin/python"
CUSTOM_NODES_DIR="$COMFYUI_ROOT/custom_nodes"
TARGET_DIR="$CUSTOM_NODES_DIR/video_flow_client"
TEMP_DIR="$CUSTOM_NODES_DIR/.video_flow_client.new.$$"

test -x "$PYTHON_BIN" || { echo "error: ComfyUI Python 不存在: $PYTHON_BIN" >&2; exit 1; }
test -d "$CUSTOM_NODES_DIR" || { echo "error: custom_nodes 不存在: $CUSTOM_NODES_DIR" >&2; exit 1; }

cleanup() {
  if test -d "$TEMP_DIR"; then
    rm -rf -- "$TEMP_DIR"
  fi
}
trap cleanup EXIT

mkdir "$TEMP_DIR"
for file in __init__.py client.py config.py nodes.py requirements.txt README.md; do
  cp "$SOURCE_DIR/$file" "$TEMP_DIR/$file"
done
if test -d "$SOURCE_DIR/workflows"; then
  cp -R "$SOURCE_DIR/workflows" "$TEMP_DIR/workflows"
fi

"$PYTHON_BIN" -m pip install -r "$TEMP_DIR/requirements.txt"

if test -e "$TARGET_DIR" || test -L "$TARGET_DIR"; then
  BACKUP_DIR="$CUSTOM_NODES_DIR/video_flow_client.backup.$(date +%Y%m%d%H%M%S)"
  mv "$TARGET_DIR" "$BACKUP_DIR"
  echo "原节点已备份到: $BACKUP_DIR"
fi
mv "$TEMP_DIR" "$TARGET_DIR"

if test -n "$TOKEN_SOURCE"; then
  test -s "$TOKEN_SOURCE" || { echo "error: token 文件不存在或为空" >&2; exit 1; }
  mkdir -p "$HOME/.video-flow"
  chmod 700 "$HOME/.video-flow"
  install -m 600 "$TOKEN_SOURCE" "$HOME/.video-flow/token"
fi

echo "Video Flow 客户端已安装到: $TARGET_DIR"
echo "请重启 ComfyUI，并在节点库中搜索 Video Flow。"
