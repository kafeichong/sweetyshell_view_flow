# ComfyUI Video Flow Client

这是 Video Flow 的 Preview 客户端节点包。节点只访问公司的 Backend，不保存或接收火山 Ark、OSS 密钥。

安装：将目录复制到 ComfyUI 的 `custom_nodes/`，在该目录安装 `requirements.txt`，重启 ComfyUI。

配置：在 `VideoFlowConfig` 中填写 Backend URL、Video Flow token 和协议版本。第一版只支持 `Seedance Preview` 单图/文本请求，Production 不由客户端直接提交。

服务端未配置真实 OSS 签名器时，上传票据接口会返回 `503`，这是预期的安全失败。
