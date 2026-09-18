try:
    from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
except ImportError:  # Support direct loading by pytest and ComfyUI.
    from nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

# API 代理（消费/任务历史面板背后那几条路由）依赖 ComfyUI 自己的 `server` 模块与 aiohttp，
# 出了 ComfyUI 必然导不进来（pytest、打包检查都是）。**它失败时不能把整个扩展带崩**：
# `__init__.py` 一抛异常，ComfyUI 会连节点一起丢掉，用户界面上什么都看不到、也看不到原因。
# 所以这里降级成"面板不可用"，节点照常注册，并把原因留在 API_PROXY_ERROR 里。
#
# 兜的**不只是 ImportError**：`api_proxy` 在导入期就取 `server.PromptServer.instance.routes`，
# 而那个 instance 只有在**跑起来的** ComfyUI 里才存在。装了 aiohttp、但没在跑 ComfyUI 的环境
# （用 ComfyUI 自己的 venv 跑脚本或安装自检）抛的是 AttributeError——2026-09-18 实测踩到：
# 只兜 ImportError 的话它会穿透 `__init__.py`，整个节点包一起消失。两者都属于"这个环境不具备"，
# 不是代码错，所以一起兜。
def _load_api_proxy():
    """把 API 代理导进来，成功返回 None、失败返回原因字符串（**不抛**）。"""
    try:
        from . import api_proxy  # noqa: F401
        return None
    except ImportError:
        pass  # 被 pytest 之类当成顶层模块加载时相对导入不成立，退回绝对导入再试一次
    except AttributeError as exc:
        # 相对导入成立、但 api_proxy 自己崩了：没有跑起来的 ComfyUI。**不能在这里重试绝对
        # 导入**——它会再崩一次，而且可能导进别的同名模块。
        return str(exc)
    try:
        import api_proxy  # noqa: F401
        return None
    except (ImportError, AttributeError) as exc:
        return str(exc)


API_PROXY_ERROR = _load_api_proxy()
if API_PROXY_ERROR:
    print(f"[video-flow] API 代理未加载，消费/任务历史面板不可用：{API_PROXY_ERROR}")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

WEB_DIRECTORY = "./web"

# 交付版本。安装脚本会把它打印出来（`sed` 解析这一行，改动格式要同步改 install.sh /
# install_creative.command），用于回答"同事装的是哪一版"。**改变客户端行为时递增。**
CLIENT_VERSION = "2026-09-18.1"
