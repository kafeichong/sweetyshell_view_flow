try:
    from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
except ImportError:  # Support direct loading by pytest and ComfyUI.
    from nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

# API 代理（消费/任务历史面板背后那几条路由）依赖 ComfyUI 自己的 `server` 模块与 aiohttp，
# 出了 ComfyUI 必然导不进来（pytest、打包检查都是）。**它失败时不能把整个扩展带崩**：
# `__init__.py` 一抛异常，ComfyUI 会连节点一起丢掉，用户界面上什么都看不到、也看不到原因。
# 所以这里降级成"面板不可用"，节点照常注册，并把原因留在 API_PROXY_ERROR 里。
API_PROXY_ERROR = None
try:
    from . import api_proxy  # noqa: F401
except ImportError:  # Support direct loading by pytest and ComfyUI.
    try:
        import api_proxy  # noqa: F401
    except ImportError as exc:
        API_PROXY_ERROR = str(exc)
        print(f"[video-flow] API 代理未加载，消费/任务历史面板不可用：{exc}")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

WEB_DIRECTORY = "./web"

# 交付版本。安装脚本会把它打印出来（`sed` 解析这一行，改动格式要同步改 install.sh /
# install_creative.command），用于回答"同事装的是哪一版"。**改变客户端行为时递增。**
CLIENT_VERSION = "2026-09-16.19"
