#!/usr/bin/env bash
# 找出本机的 ComfyUI 根目录（判定标准：里面同时有 custom_nodes/ 和 .venv/bin/python）。
#
# 命中就打印路径并退出 0；找不到退出 1。安装器用它自动定位，排查时也可以直接跑它看结果。
#
# 覆盖顺序：
#   1. VIDEO_FLOW_COMFYUI_ROOT（显式指定，无效就失败，不悄悄换别的）
#   2. VIDEO_FLOW_COMFYUI_CANDIDATES（冒号分隔，默认是下面三个常见位置；测试用这个隔离）
#   3. Comfy Desktop 的 installations.json —— 它记的是 installPath，真正的根是它的
#      子目录 ComfyUI/（同事那台就是这种装法，只看常见位置永远找不到）
set -euo pipefail

is_comfyui_root() {
  test -x "$1/.venv/bin/python" && test -d "$1/custom_nodes"
}

if test -n "${VIDEO_FLOW_COMFYUI_ROOT:-}"; then
  if is_comfyui_root "$VIDEO_FLOW_COMFYUI_ROOT"; then
    printf '%s\n' "$VIDEO_FLOW_COMFYUI_ROOT"
    exit 0
  fi
  exit 1
fi

DEFAULT_CANDIDATES="$HOME/ComfyUI:$HOME/Documents/ComfyUI:/Volumes/lvmac/ai/ComfyUI/ComfyUI"
IFS=':' read -r -a candidates <<< "${VIDEO_FLOW_COMFYUI_CANDIDATES:-$DEFAULT_CANDIDATES}"
for candidate in "${candidates[@]}"; do
  test -n "$candidate" || continue
  if is_comfyui_root "$candidate"; then
    printf '%s\n' "$candidate"
    exit 0
  fi
done

manifest="$HOME/Library/Application Support/Comfy Desktop/installations.json"
if test -f "$manifest"; then
  # `|| test -n` 是必需的：文件末尾没有换行时 read 返回非零，最后一行会被整个跳过。
  while IFS= read -r install_path || test -n "$install_path"; do
    test -n "$install_path" || continue
    for candidate in "$install_path" "$install_path/ComfyUI"; do
      if is_comfyui_root "$candidate"; then
        printf '%s\n' "$candidate"
        exit 0
      fi
    done
  done < <(sed -n 's/.*"installPath": *"\([^"]*\)".*/\1/p' "$manifest")
fi

exit 1
