try:
    from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
except ImportError:  # Support direct loading by pytest and ComfyUI.
    from nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

WEB_DIRECTORY = "./web"

# 交付版本。安装脚本会把它打印出来（`sed` 解析这一行，改动格式要同步改 install.sh /
# install_creative.command），用于回答"同事装的是哪一版"。**改变客户端行为时递增。**
CLIENT_VERSION = "2026-09-16.2"
