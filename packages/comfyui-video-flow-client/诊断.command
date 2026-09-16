#!/usr/bin/env bash
# 一键收集本机的 ComfyUI / Video Flow 安装信息，用于排查"安装器找不到目录"之类的问题。
#
# 双击即可运行，然后把窗口里的内容复制给管理员。
# **不会打印任何凭证内容**：只说明凭证文件在不在。
set -uo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIND_ROOT="$SOURCE_DIR/find_comfyui_root.sh"

section() { printf '\n===== %s =====\n' "$1"; }

section "基本信息"
printf 'macOS: %s\n' "$(sw_vers -productVersion 2>/dev/null || echo 未知)"
printf '用户: %s\n' "$(whoami)"
printf 'HOME: %s\n' "$HOME"
printf '客户端版本: %s\n' "$(sed -n 's/^CLIENT_VERSION = "\(.*\)"/\1/p' "$SOURCE_DIR/__init__.py" 2>/dev/null || echo 读不到)"

section "Comfy Desktop 的安装记录"
manifest="$HOME/Library/Application Support/Comfy Desktop/installations.json"
if test -f "$manifest"; then
  printf '记录文件: %s\n' "$manifest"
  # 末尾没换行时 read 会返回非零，最后一行会被跳过，所以要 `|| test -n`。
  while IFS= read -r install_path || test -n "$install_path"; do
    test -n "$install_path" || continue
    printf '\ninstallPath: %s\n' "$install_path"
    for candidate in "$install_path" "$install_path/ComfyUI"; do
      if test -d "$candidate"; then
        printf '  %s → 存在\n' "$candidate"
        printf '     custom_nodes: %s\n' "$(test -d "$candidate/custom_nodes" && echo 有 || echo 没有)"
        printf '     .venv/bin/python: %s\n' "$(test -x "$candidate/.venv/bin/python" && echo 有 || echo 没有)"
        printf '     video_flow_client: %s\n' "$(test -d "$candidate/custom_nodes/video_flow_client" && echo 已安装 || echo 未安装)"
      else
        printf '  %s → 不存在\n' "$candidate"
      fi
    done
  done < <(sed -n 's/.*"installPath": *"\([^"]*\)".*/\1/p' "$manifest")
else
  printf '没有找到安装记录（可能不是 Comfy Desktop，或还没启动过）\n'
fi

section "常见位置"
for candidate in "$HOME/ComfyUI" "$HOME/Documents/ComfyUI" "/Volumes/lvmac/ai/ComfyUI/ComfyUI"; do
  printf '  %s → %s\n' "$candidate" "$(test -d "$candidate" && echo 存在 || echo 不存在)"
done

section "自动探测结果"
if detected="$("$FIND_ROOT" 2>/dev/null)"; then
  printf '找到 ComfyUI 根目录: %s\n' "$detected"
  printf '  custom_nodes 里的 Video Flow 客户端: %s\n' \
    "$(test -d "$detected/custom_nodes/video_flow_client" && echo 已安装 || echo 未安装)"
else
  printf '没有自动找到——安装时请在弹窗里手动选择"里面有 custom_nodes 文件夹"的那个目录。\n'
fi

section "ffprobe（视频/音频检查要用）"
if command -v ffprobe >/dev/null 2>&1; then
  printf 'PATH 里: %s\n' "$(command -v ffprobe)"
else
  printf 'PATH 里没有（客户端会去 /opt/homebrew/bin、/usr/local/bin、/opt/local/bin、/usr/bin 再找一遍）\n'
fi
for candidate in /opt/homebrew/bin/ffprobe /usr/local/bin/ffprobe /opt/local/bin/ffprobe /usr/bin/ffprobe; do
  test -x "$candidate" && printf '  存在: %s\n' "$candidate"
done

section "凭证（只报有无，不打印内容）"
if test -s "$HOME/.video-flow/token"; then
  printf '~/.video-flow/token 存在（权限 %s）\n' "$(stat -f '%Lp' "$HOME/.video-flow/token" 2>/dev/null || echo 未知)"
else
  printf '~/.video-flow/token 不存在\n'
fi

printf '\n把以上内容复制给管理员即可。\n'
