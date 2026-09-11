# ComfyUI Video Flow Client

这是 Video Flow 的 ComfyUI 客户端节点包。节点只访问公司的 Backend，不保存或接收火山 Ark、OSS 密钥。

推荐使用随包安装脚本（第二个参数是管理员单独提供的 actor token 文件）：

```bash
./install.sh /path/to/ComfyUI /path/to/actor-token
```

脚本会把已有 `video_flow_client` 备份到 `<ComfyUI>/.video-flow-backups/`（避免旧版本被当作节点重复加载）、复制节点、使用 ComfyUI 自己的 Python 安装依赖，并把 token 保存到 `~/.video-flow/token`（权限 `600`）。完成后重启 ComfyUI。

公司生产环境使用以下 Backend URL；本地开发未设置时仍默认为 `http://localhost:3100`：

```bash
export VIDEO_FLOW_BACKEND_URL=https://ai.sweetyshell.com
export VIDEO_FLOW_PROTOCOL_VERSION=1
```

配置 Backend URL 和协议版本后，客户端按以下优先级读取 actor token：

1. ComfyUI 进程环境变量 `VIDEO_FLOW_TOKEN`。
2. `VIDEO_FLOW_TOKEN_FILE` 指向的普通文件。
3. 默认文件 `~/.video-flow/token`。

ComfyUI Desktop 不方便注入进程环境变量时，可以把 token 单独写入默认文件，并限制为当前用户可读：

```bash
mkdir -p ~/.video-flow
chmod 700 ~/.video-flow
chmod 600 ~/.video-flow/token
```

如需使用其他位置，设置 `VIDEO_FLOW_TOKEN_FILE=/absolute/path/to/token`。不要把 token 文件放进 custom node 目录、Workflow JSON 或版本控制。

客户端默认只提交 `mode=preview`。Production 必须由调用方显式指定 `mode=production`，并且 actor 必须在服务端 `VIDEO_FLOW_PRODUCTION_ACTORS` 白名单中；Preview 与 Production 使用不同的模式作用域幂等键，避免 Preview 后正式提交因请求体变化返回 `409`。

安装后可使用以下节点：

- `Video Flow Config`
- `Seedance Preview`
- `Seedance Production`
- `Wait Video Flow Task`
- `Load Video Flow Result`

`Seedance Production` 会产生真实费用，目前 Production 白名单保持为空；额度门禁上线并完成单人授权后才可使用。`Load Video Flow Result` 向 Backend 获取短期下载地址，并把视频流式写入 `<ComfyUI>/output/video-flow/`。

服务端未配置真实 OSS 签名器时，上传票据接口会返回 `503`，这是预期的安全失败。
