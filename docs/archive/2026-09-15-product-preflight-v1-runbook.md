# 产品参考图：Preview 与正式确认接口手册（v1 历史快照）

需求依据：[统一规范 v2](../requirements/2026-09-15/workflow-preview-production-spec-v2.md)。当前实现、是否部署与验证结果以 [PROJECT_STATUS](../PROJECT_STATUS.md) 为准。本手册仍描述旧参考图预检接口，R1/R5 必须随接口和客户端替换同步改写；本手册不表示正式服务器已升级，部署排期见 [ROADMAP](../ROADMAP.md)。

## 模板与使用

模板：`packages/comfyui-video-flow-client/workflows/seedance-product-preflight-v1.comfy.json`。

成片落盘后，将 `VideoFlowPolicyDownload` 的 `local_video_path` 连接到独立的 `VideoFlowPolicyPreview` 节点，可在 ComfyUI 结果区直接播放本地视频。该节点按 ComfyUI 0.35.x 兼容格式输出 MP4；Preview 模式没有视频时，该节点只显示提示，不会报错。

在配套 Backend 与插件版本完成发布后，使用同一画布：连接配置 → 运行方式 → 产品图本地检查 → 成片要求 → 请求预检 → 正式提交 → 等待 → 下载保存。

1. 配置个人凭证，选择静态 PNG/JPEG/WebP 产品图与提示词；正式参考图模板支持 4–30 秒、标准画幅和 480p/720p/1080p。
2. 保持 `mode=preview`、`confirm_live_submission=false`，执行并查看请求预检报告。此阶段不上传文件，不生成视频。
3. 报告通过后，选择 `production` 并明确确认；服务器重新验证预检记录与当前准入，再上传或复用素材、正式提交。
4. 修改内容或预检超过 30 分钟需重新 Preview；报告展示服务器确定的模型、音频、水印、价格版本和预占金额，预占金额不是最终账单。
5. 已提交任务的等待、恢复和下载应沿用原 taskId；同一内容与生成版本重复提交复用本地回执。预检过期影响新提交，已有任务可用恢复下载入口取片。

## 接口合同

所有接口要求 `Authorization: Bearer <个人 Token>`。凭证不得写入工作流 JSON。

### POST /api/v1/tasks/preflight

仅接受产品参考图的参数和素材描述，不接受 assetId、URL、文件内容、Base64 或未知字段。

请求示意（哈希和大小必须由实际本地文件计算，不可照抄占位值）：

```json
{
  "workflowKey": "seedance.reference-image-to-video.v1",
  "prompt": {"positive": "产品置于干净摄影棚中，镜头缓慢推进"},
  "generation": {"duration": 5, "ratio": "16:9", "resolution": "720p"},
  "media": [{
    "sha256": "<本地文件的64位小写SHA-256>",
    "role": "reference_image",
    "mimeType": "image/png",
    "sizeBytes": 12345,
    "metadata": {"kind": "image", "width": 500, "height": 500}
  }]
}
```

成功 HTTP 201：`preflightId`、`expiresAt`、`status=preview`、`willCallProvider=false`、`willUploadMedia=false`、规范化 `intent`、`effectiveSpec`、`checks`。保存不可执行的 Preview Task，不写 Attempt 或预算预占。素材元信息校验基于客户端声明；实际文件检查明确为 `pending_upload`。

错误：无凭证 401；无效凭证/非生产白名单账号 403；参数、媒体描述、生产暂停或必要服务缺失 400/503。`disabled`/`preview_only` 工作流允许进入 Preview 以查看合同和能力状态，但正式 Production 仍由服务端拒绝。每日或月度金额不足时 Preview 仍返回 201，并在 `checks.budget=warning`、`checks.budgetWarning` 中提示，不创建预算预占；正式 Production 提交仍严格返回额度错误。HTTP 错误中的 message 指明错误原因，客户端不得保留旧的通过状态。

### GET /api/v1/tasks/preflight/:id/check

在正式上传前检查属于当前 actor 的预检记录、30 分钟有效期、版本/生产规格、白名单、暂停及当时额度。成功 HTTP 200 返回 `valid=true`、`preflightId` 和 `willCallProvider=false`；该结果不预占额度，不替代正式提交时复验。

### POST /api/v1/tasks

正式请求保留 `workflowKey`、`prompt`、`generation`，素材使用上传后返回的 `media[].assetId` 和角色；必须增加 `preflightId` 与 `confirmLiveSubmission=true`，并显式传 `mode=production` 和 `Idempotency-Key` 请求头。

服务端匹配资产哈希、元信息、参数及预检快照，再读取实际 OSS 对象计算 SHA-256；不能用 OSS 自定义哈希声明代替实际字节校验。匹配后才进入预算准入与任务创建。失败时不得创建新的付费任务。

常见 HTTP 400：`PREFLIGHT_CONFIRMATION_REQUIRED`、`PREFLIGHT_REQUIRED`、`PREFLIGHT_EXPIRED`、`PREFLIGHT_CONTENT_CHANGED`、`PREFLIGHT_ACTUAL_CONTENT_MISMATCH`。正式预算错误仍沿用既有 429/503 语义。

## 兼容与发布约束

- 旧 Preview Task 不包含新预检快照，不能充当 `preflightId`。
- 旧正式请求缺预检字段会被拒绝，不能单独部署服务端而让创意人员继续使用旧提交入口。
- 新节点内部 ID 使用 Video Flow 命名空间，避免覆盖旧 Ark 插件；界面沿用原分步操作方式。
- 安装脚本须包含 `preflight_nodes.py` 和 `web/preflight_report.js`。实际 ComfyUI 导入和报告展示必须在目标实例验收后才可称可用。

## 本地无付费验证

```bash
cd packages/backend
npm run build
npx jest --runInBand
node test/preflight-http.smoke.cjs
```

HTTP smoke 仅监听本机临时端口，使用真实 Nest 路由/Guard与内存存储、额度和 OSS 替身，不连接真实 Provider；不能代替数据库、Worker、OSS 和创意终端整链验收。

客户端：`cd packages/comfyui-video-flow-client && .venv/bin/python -m pytest -q`。Worker：`cd packages/worker && venv/bin/python -m pytest -q`。
