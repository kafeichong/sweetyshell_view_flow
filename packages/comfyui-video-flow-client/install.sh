#!/usr/bin/env bash
set -euo pipefail

COMFYUI_ROOT="${1:?用法: ./install.sh /path/to/ComfyUI [actor-token-file]}"
TOKEN_SOURCE="${2:-}"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_BIN="$COMFYUI_ROOT/.venv/bin/python"
if test ! -x "$PYTHON_BIN" && test -x "$COMFYUI_ROOT/.venv/bin/python3"; then
  PYTHON_BIN="$COMFYUI_ROOT/.venv/bin/python3"
fi
CUSTOM_NODES_DIR="$COMFYUI_ROOT/custom_nodes"
TARGET_DIR="$CUSTOM_NODES_DIR/video_flow_client"
TEMP_DIR="$CUSTOM_NODES_DIR/.video_flow_client.new.$$"
BACKUP_ROOT="$COMFYUI_ROOT/.video-flow-backups"

test -x "$PYTHON_BIN" || { echo "error: ComfyUI Python 不存在: $PYTHON_BIN" >&2; exit 1; }
test -d "$CUSTOM_NODES_DIR" || { echo "error: custom_nodes 不存在: $CUSTOM_NODES_DIR" >&2; exit 1; }

# 交付物必须来自干净副本。从带未提交/未跟踪文件的开发目录安装，会把没做完的东西一起拷进
# 别人的 ComfyUI——踩过一次：并行开发中的界面文件就这样被装进了本机 ComfyUI。
# 用 git archive 导出的副本没有 .git，这条自动跳过。
if command -v git >/dev/null 2>&1 && git -C "$SOURCE_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  dirty="$(git -C "$SOURCE_DIR" status --porcelain -- . 2>/dev/null || true)"
  if test -n "$dirty"; then
    echo "⚠️  警告：这个客户端目录里有未提交/未跟踪的文件，它们会一起被安装到 ComfyUI：" >&2
    printf '%s\n' "$dirty" | sed 's/^/      /' >&2
    echo "      交付给他人请改用 git archive 导出的干净副本（见 README「交付」一节）。" >&2
  fi
fi

cleanup() {
  if test -d "$TEMP_DIR"; then
    rm -rf -- "$TEMP_DIR"
  fi
}
trap cleanup EXIT

mkdir "$TEMP_DIR"
# 逐个文件列出而不是目录整体拷贝：多带一个本地调试文件进同事环境，
# 比漏更新一个模块更难排查。新增模块时必须同步这份清单。
for file in __init__.py client.py config.py execution_slot.py media_inspection.py nodes.py preflight_nodes.py receipts.py requirements.txt submission_state.py README.md; do
  cp "$SOURCE_DIR/$file" "$TEMP_DIR/$file"
done
# 资源目录：工作流模板、可直接导入的示例、前端展示脚本。
for directory in workflows examples web; do
  if test -d "$SOURCE_DIR/$directory"; then
    cp -R "$SOURCE_DIR/$directory" "$TEMP_DIR/$directory"
  fi
done

"$PYTHON_BIN" -m pip install -r "$TEMP_DIR/requirements.txt"

if test -e "$TARGET_DIR" || test -L "$TARGET_DIR"; then
  mkdir -p "$BACKUP_ROOT"
  BACKUP_DIR="$BACKUP_ROOT/video_flow_client.$(date +%Y%m%d%H%M%S)"
  mv "$TARGET_DIR" "$BACKUP_DIR"
  echo "原节点已备份到: $BACKUP_DIR"
fi
mv "$TEMP_DIR" "$TARGET_DIR"

if test -n "$TOKEN_SOURCE"; then
  test -s "$TOKEN_SOURCE" || { echo "error: token 文件不存在或为空" >&2; exit 1; }
  mkdir -p "$HOME/.video-flow"
  chmod 700 "$HOME/.video-flow"
  TOKEN_DEST="$HOME/.video-flow/token"
  # 安装器再次运行时，源凭证可能已经是目标文件本身。install 会把这种
  # 自复制当成错误；保留原文件并重申权限即可。
  if test -e "$TOKEN_DEST" && test "$TOKEN_SOURCE" -ef "$TOKEN_DEST"; then
    chmod 600 "$TOKEN_DEST"
  else
    install -m 600 "$TOKEN_SOURCE" "$TOKEN_DEST"
  fi
fi

CLIENT_VERSION="$(sed -n 's/^CLIENT_VERSION = "\(.*\)"/\1/p' "$SOURCE_DIR/__init__.py" | head -1)"
echo "Video Flow 客户端已安装到: $TARGET_DIR"
echo "版本: ${CLIENT_VERSION:-未知}（排查问题时请提供这一版号）"
echo "请重启 ComfyUI，并在节点库中搜索 Video Flow。"
