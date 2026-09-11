# 创意同事调用手册（Seedance）

> 最后更新：2026-09-11
> 适用接口：`https://ai.sweetyshell.com/api/v1`
> 事实依据：[PROJECT_STATUS.md](../PROJECT_STATUS.md)。接口若与本文不符，以代码为准并更新本文。

---

## 0. 两条硬规则（先读）

1. **默认是 Preview。** 不显式传 `"mode": "production"` 的请求不会生成视频，只会返回一份请求摘要（`willCallProvider: false`）。这是防止误触付费的安全默认值。
2. **Production 需要白名单授权。** 即使传了 `mode=production`，如果该 actor 不在服务端 `VIDEO_FLOW_PRODUCTION_ACTORS` 里，也会返回 **403**。需要出片时请联系管理员开通。

---

## 1. 前置：拿到个人凭证

每位同事单独持有一枚可撤销的 actor token，不要共用、不要外泄。

管理员签发：

```bash
export VIDEO_FLOW_ADMIN_TOKEN='<管理员 token>'
./scripts/video_flow_credential.sh issue creator-alice Alice /secure/path/alice-token
```

脚本只显示 actor ID 和 token 文件路径，不把明文 token 打到终端。服务端只存 token 哈希；token 丢失后需撤销旧 actor 并使用新 actor ID 重新签发。

后续所有请求都带：

```
Authorization: Bearer <ACTOR_TOKEN>
```

脚本不会打印明文 token，输出文件权限为 `600`。通过安全渠道把该文件交给对应同事后，在同事电脑运行：

```bash
./install.sh /path/to/ComfyUI /path/to/alice-token
```

需要立即停用时由管理员运行：

```bash
export VIDEO_FLOW_ADMIN_TOKEN='<管理员 token>'
./scripts/video_flow_credential.sh revoke creator-alice
```

ComfyUI 客户端读取环境变量 `VIDEO_FLOW_TOKEN`，或 `~/.video-flow/token` 文件（权限 `600`）；不要把 token 写进 Workflow JSON。

---

## 2. 上传参考图（图生视频才需要）

支持 `image/png`、`image/jpeg`、`image/webp`，单文件 ≤ 20 MB。

### 2.1 申请上传票据

```bash
curl -sS -X POST 'https://ai.sweetyshell.com/api/v1/assets/upload-ticket' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <ACTOR_TOKEN>' \
  -d '{
    "filename": "product.png",
    "mimeType": "image/png",
    "sizeBytes": 524288,
    "sha256": "<可选：文件的 sha256 十六进制>"
  }'
```

返回字段：

| 字段 | 用途 |
| --- | --- |
| `assetId` | 后续创建任务时作为 `params.image_asset_id` |
| `objectKey` | 对象身份（数据库永久保存的就是它） |
| `uploadUrl` | 直传地址，有效期 900 秒 |
| `uploadHeaders` | PUT 时必须原样带上的请求头 |
| `expiresIn` | 有效期秒数 |
| `alreadyUploaded` | 为 `true` 时表示同内容已存在，**无需再上传**，直接用 `assetId` |

> 带上 `sha256` 可以让相同内容的图片复用同一条 Asset，使 `assetId` 稳定 —— 这是"同 prompt + 同图"重复提交能真正幂等的前提。

### 2.2 直传到 OSS

```bash
curl -sS -X PUT '<uploadUrl>' \
  -H 'Content-Type: image/png' \
  -H 'Content-Length: 524288' \
  --data-binary '@product.png'
```

### 2.3 确认上传完成

```bash
curl -sS -X POST 'https://ai.sweetyshell.com/api/v1/assets/<assetId>/complete' \
  -H 'Authorization: Bearer <ACTOR_TOKEN>'
```

服务端会用 OSS HEAD 校验实际大小、MIME 与 sha256，不一致会返回 400。

---

## 3. 创建任务

必须带 `Idempotency-Key`（缺失返回 409）。相同 actor + 相同 key + 相同请求体只会创建一条任务；相同 key 但请求体不同返回 409。

### 3.1 文生视频

```bash
curl -sS -X POST 'https://ai.sweetyshell.com/api/v1/tasks' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <ACTOR_TOKEN>' \
  -H 'Idempotency-Key: alice-20260911-001' \
  -d '{
    "capability": "TEXT_TO_VIDEO",
    "profile": "seedance",
    "mode": "preview",
    "params": {
      "prompt": "A premium product hero shot, smooth camera move, clean studio",
      "duration": 5
    }
  }'
```

### 3.2 图生视频

把 `capability` 改为 `IMAGE_TO_VIDEO`，并在 `params` 里带上 `image_asset_id`（推荐，来自第 2 步的 `assetId`）：

```json
{
  "capability": "IMAGE_TO_VIDEO",
  "profile": "seedance",
  "mode": "preview",
  "params": {
    "prompt": "Use this product image, slow push-in, clean studio lighting",
    "duration": 5,
    "image_asset_id": "<assetId>"
  }
}
```

> `params.image_url` 仍然兼容，但需要是一个 Provider 能访问的 HTTPS 地址。**优先用 `image_asset_id`**，本地文件路径永远不能直接传给 Seedance。

### 3.3 请求校验规则

| 字段 | 规则 |
| --- | --- |
| `capability` | 只能是 `TEXT_TO_VIDEO` 或 `IMAGE_TO_VIDEO` |
| `profile` | 必须以 `seedance` 开头（如 `seedance`、`seedance-main`） |
| `params.prompt` | 必填，≤ 4000 字符 |
| `params` 整体 | 序列化后 ≤ 64 KB |
| `IMAGE_TO_VIDEO` | 必须有 `image_asset_id` 或 `image_url` |
| `mode` | 缺省 `preview`；`production` 需白名单 |

### 3.4 Preview 响应长这样

```json
{
  "id": "...",
  "status": "preview",
  "taskStatus": null,
  "preview": {
    "mode": "preview",
    "provider": "seedance",
    "model": null,
    "duration": 5,
    "estimatedCostCny": null,
    "costStatus": "unavailable",
    "willCallProvider": false
  }
}
```

看到 `willCallProvider: false` 就说明**没有产生任何费用**。

---

## 4. 查询任务

```bash
curl -sS 'https://ai.sweetyshell.com/api/v1/tasks/<TASK_ID>' \
  -H 'Authorization: Bearer <ACTOR_TOKEN>'
```

- 只能查自己创建的任务；别人的任务返回 404。
- 状态流转：`pending` → `running`（或 `submitted`）→ `completed` / `failed`。
- 失败时看 `errorMsg`，以及执行账本里的 `failureType` / `failureCode`。

> 想用脚本一次跑完"建凭证 → 建任务 → 轮询"，见 [creative-one-click-script.md](./creative-one-click-script.md)。

---

## 5. 取得成片

```bash
curl -sS 'https://ai.sweetyshell.com/api/v1/assets/tasks/<TASK_ID>/result' \
  -H 'Authorization: Bearer <ACTOR_TOKEN>'
```

返回 Task 对应输出 Asset 的 `objectKey`、`downloadUrl` 等信息；**每次调用都生成新的短期签名地址**。ComfyUI 中可直接使用 `Load Video Flow Result`，它会把文件流式写入 `<ComfyUI>/output/video-flow/`。

### 当前限制（务必知悉）

- Task 的 `videoUrl` 字段现在保存永久 `objectKey`，不是可直接访问的 URL；不要把它粘贴到浏览器下载。
- 只能获取自己 Task 的输出；其他 actor 的 Task 仍会返回 404。
- `downloadUrl` 是短期地址；过期后重新调用结果接口即可，OSS 文件不会因此删除。

---

## 6. 常见返回码

| 返回码 | 含义 | 处理 |
| --- | --- | --- |
| 400 | 请求校验失败（capability / profile / params / 上传元数据不符） | 按报错文案修参数 |
| 401 | 没带 `Authorization` | 补 Bearer token |
| 403 | 凭证无效或已撤销；或 Production 未授权 | 找管理员确认凭证状态 / 白名单 |
| 404 | 任务或 Asset 不属于当前 actor，或不存在 | 检查 ID 与归属 |
| 409 | 缺 `Idempotency-Key`；或同 key 请求体不同 | 固定 key 与参数，或换新 key |
| 429 | 超出额度（Phase 1 上线后） | 找管理员提额 |
| 503 | 服务端 OSS 未配置 | 联系管理员，不要重试 |

---

## 7. 安全约束

- 不要把 token 写进 Workflow JSON、截图、文档或聊天记录。
- 不要使用管理员临时测试 token（如 `local-admin-test-token`）。
- **不要调用旧的 `/api/tasks` 接口**：它只为受 Guard 保护的历史管理 / Worker 操作保留；创意客户端统一使用 `/api/v1`。
- 需要出片时先确认 Worker 在线，否则任务会停留在 `pending`。
