# ComfyUI Video Flow Client

这是 Video Flow 的 ComfyUI 客户端节点包。节点只访问公司的 Backend，不保存或接收火山 Ark、OSS 密钥。

推荐使用随包安装脚本（第二个参数是管理员单独提供的 actor token 文件）：

```bash
./install.sh /path/to/ComfyUI /path/to/actor-token
```

脚本会把已有 `video_flow_client` 备份到 `<ComfyUI>/.video-flow-backups/`（避免旧版本被当作节点重复加载）、复制节点、使用 ComfyUI 自己的 Python 安装依赖，并把 token 保存到 `~/.video-flow/token`（权限 `600`）。完成后重启 ComfyUI。

公司生产环境使用以下 Backend URL；本地开发未设置时仍默认为 `http://localhost:3100`。不要把 `127.0.0.1:19091` 填到这里，它只属于同机 Fake Provider 合同测试：

```bash
export VIDEO_FLOW_BACKEND_URL=https://ai.sweetyshell.com
export VIDEO_FLOW_PROTOCOL_VERSION=1
# 可选：提交回执目录，默认 ~/.video-flow/receipts
export VIDEO_FLOW_RECEIPT_DIR=~/.video-flow/receipts
# 可选：服务端批准的生成规格版本，参与稳定幂等键。
# 规格升级（换模型/时长上限等）时同步更新，同一份输入才会被当作新的生成意图。
export VIDEO_FLOW_SPEC_VERSION=
```

客户端电脑不保存 Ark/OSS 密钥。Production 出片还必须先上传并完成校验参考图，再使用服务端返回的 `assetId`；不能把本地路径或任意 Provider URL 作为 Production 输入。

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

Production 节点的 `generation_version` 默认是 `1`。相同版本会复用同一份本地提交回执和幂等键；只有明确把版本改为 `2` 等新值，才表示主动生成新一版。POST 超时后保留原回执，重试不会自动升级版本。

回执保存在 `VIDEO_FLOW_RECEIPT_DIR` 下按「后端地址 + 凭证」派生的哈希命名空间目录（目录 `700`、文件 `600`），不写入原始 token。换账号或换后端不会读到、也不会误用上一个人的 `taskId`。

重试的语义是"沿用第一次形成的意图"：一旦某个意图落盘，后续重跑使用回执里记录的原幂等键与完整请求体，即使客户端升级后重建出的 metadata 不同也照样复用，避免同一 key 不同请求被服务端判 `409`。回执写入失败时不会发出付费请求；若任务已创建但回执补写失败，会直接抛出带 `taskId` 的错误，不要重新提交。

安装后可使用以下节点：

- `Video Flow Config`
- `Seedance Preview`
- `Seedance Production`
- `Wait Video Flow Task`
- `Load Video Flow Result`

`Seedance Production` 会产生真实费用，目前 Production 白名单保持为空；额度门禁上线并完成单人授权后才可使用。

## 一次完整提交

`Config → Production → Wait → LoadResult`。`Wait` 阻塞到任务可交付为止（`delivery.status=ready`）并**只输出 `taskId`**；把它的输出接到 `LoadResult` 的 `task_id` 输入即可，不要手工粘贴 task JSON——JSON 不是 taskId，会让下载请求打到错误地址。

- 查询失败会自动重查：`429`/`5xx`/网络抖动只重复查询同一个任务，不会重建；`401/403` 立即停止并提示检查 `VIDEO_FLOW_TOKEN`。
- 终态错误都带 `taskId`：`REQUIRES_REVIEW`（需人工核查）、`PROVIDER_FAILED`（Provider 明确失败）、`DELIVERY_FAILED`（生成成功但归档失败）、`WAIT_TIMEOUT`（等超时，任务仍在服务端跟踪，请稍后重查而不是重新提交）。
- 费用未知但产物已就绪时仍然允许下载，`LoadResult` 的 `cost_status` 输出会显示"费用待核实"。费用与交付状态是两件事，不互相阻塞。
- 产物落在 ComfyUI 自己的输出目录下 `video-flow/`（跟随 `folder_paths` 配置，自定义输出路径也一致）。下载先写随机临时文件，校验非空且与声明大小一致后原子发布；重新下载失败时上一份成功的文件保持不变。

`Wait` / `LoadResult` 带 `IS_CHANGED`，重跑工作流会重新查询状态与重新取片，而不是复用 ComfyUI 缓存。`Production` 即使被再次调度也只沿用同一份回执意图，不会因为重跑产生第二次付费生成。

`examples/` 下有两份可直接导入的最小模板（API 格式）：

- `seedance-production.json`：完整链路 `Config → LoadImage → Production → Wait → LoadResult`。
- `seedance-resume.json`：只等待并下载一个已有 `taskId`（把任务 id 填进 `Wait` 节点即可），不包含任何提交节点。

服务端未配置真实 OSS 签名器时，上传票据接口会返回 `503`，这是预期的安全失败。
