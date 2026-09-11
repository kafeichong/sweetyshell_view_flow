# 创意同事一键脚本（Seedance）

> 最后更新：2026-09-11
> 脚本位置：`scripts/seedance_cli_smoke.sh`
> 相关文档：[creative-user-guide.md](./creative-user-guide.md)（手工调用与返回码）、[PROJECT_STATUS.md](../PROJECT_STATUS.md)

---

## 1. 重要：默认不会出片

脚本默认 `MODE=preview`：**只创建一条不可执行的预览记录并打印请求摘要，不产生任何 Provider 调用与费用。**

要真实出片必须同时满足两个条件：

1. 显式设置 `MODE=production`；
2. 该 `ACTOR_ID` 已在服务端 `VIDEO_FLOW_PRODUCTION_ACTORS` 白名单中（否则返回 403）。

```bash
export MODE=production
```

---

## 2. 依赖

- `bash`、`curl`、`python3`

## 3. 最小运行（Preview，零付费）

先按 [creative-user-guide.md](./creative-user-guide.md) 安装个人 token；默认位置为 `~/.video-flow/token`。

```bash
export ACTOR_ID="alice-creative"           # 同事唯一 ID，可选
export PROMPT="A premium product hero video"
export DURATION=5
export PROFILE=seedance

./scripts/seedance_cli_smoke.sh
```

Preview 模式下脚本会打印请求摘要后退出，重点看 `status=preview` 与 `preview.willCallProvider=false`。

## 4. 有参考图的写法

```bash
export IMAGE_URL="https://xxx/your_reference_image.png"
./scripts/seedance_cli_smoke.sh
```

脚本会自动切换为 `IMAGE_TO_VIDEO`，并把 `IMAGE_URL` 放进 `params.image_url`；不设置时使用 `TEXT_TO_VIDEO`。

> 走 ComfyUI 客户端时优先用 `image_asset_id`（见调用手册第 2 节）；`image_url` 需要是 Provider 可访问的 HTTPS 地址。

## 5. 真实出片（会付费）

```bash
export ACTOR_ID="alice-creative"
export PROMPT="A premium product hero video"
export MODE=production
export IDEMPOTENCY_KEY="alice-20260911-001"   # 强烈建议固定，防止重复扣费
./scripts/seedance_cli_smoke.sh
```

脚本会轮询到 `completed` / `failed` / `cancelled` 并打印最终任务 JSON，重点看：

- `id`、`status`
- `videoUrl`（注意：当前是 7 天有效的签名地址，见 PROJECT_STATUS R4）
- `cost` 与费用状态
- `errorMsg`

## 6. 强制幂等（防重复扣费）

固定 `IDEMPOTENCY_KEY` 即可：同一个 `IDEMPOTENCY_KEY + 参数组合` 会返回同一任务，不会提交第二次付费任务。不设置时脚本会按时间戳生成新 key，**每次都是新任务**。

## 7. 安全说明

- 脚本读取 `VIDEO_FLOW_TOKEN`，或 `VIDEO_FLOW_TOKEN_FILE` 指向的文件；未设置时读取 `~/.video-flow/token`。
- `VIDEO_FLOW_ADMIN_TOKEN` 只应由管理员持有，脚本不会读取它。
- 脚本不会打印 token 明文。
- 出片前确认 Worker 在线，否则任务会停留在 `pending`。
