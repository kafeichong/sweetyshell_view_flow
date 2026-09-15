# 工作流 Preview v2 接口手册

> 更新日期：2026-09-15。需求依据：[统一规范 v2](../requirements/2026-09-15/workflow-preview-production-spec-v2.md)。当前实现和是否部署只看 [PROJECT_STATUS](../PROJECT_STATUS.md)。旧参考图手册已归档为 [v1 历史快照](../archive/2026-09-15-product-preflight-v1-runbook.md)。

## 当前阶段边界

R1–R4 本地开发分支已把 Preview 改为独立 `PreflightRecord`，加入客户端本地媒体识别、服务端实际对象复验、实际参数报价、正式快照消费和执行槽。这一中间阶段尚未部署：

- Preview 不上传素材、不创建 Task/Attempt/预算预占，不调用 Provider；
- Preview 不因 Production 白名单、暂停或额度不足而失去请求检查报告，这些原因在 `productionAdmission.blockers` 中分别展示；
- `POST /api/v1/tasks` 的旧 `mode=preview` 已退休；
- 新 Production 服务端接口已接入，但 8 类工作流仍是 `implementation=incomplete / admission=false`；客户端稳定槽和交付回执尚待 R5，因此当前仍不对用户开放；
- 已有 Task 的授权查询接口保持独立。

## 本地媒体检查与上传复验

- PNG、JPEG、WebP 由客户端使用 Pillow 读取实际图片内容；MP4、MOV、WAV、MP3 使用 `ffprobe` 读取容器和流，不按文件扩展名猜测。
- 描述包含稳定 `slotId`、实际 SHA-256、检测到的 MIME、字节数和规范化元信息；时长与 FPS 统一保留最多 6 位小数。
- Preview 请求只取 `descriptor`，本机路径和文件字节不会进入 HTTP payload。
- 正式上传前客户端重新读取同一路径并比较完整描述；同名文件内容改变返回 `MEDIA_CONTENT_CHANGED`。
- 上传完成时 Backend 通过签名下载地址重新运行 `ffprobe`，声明 MIME 只做一致性约束；实际内容不匹配、Inspector 缺失或解码失败都不能标记完成。
- 通过实际内容复验的输入 Asset 标记为 `verified`。历史 `uploaded` Asset 可以复用对象，但必须先补做复验；不会重新 PUT 覆盖原对象。
- 图片/视频尺寸和比例、视频像素/FPS/编码/单段时长、音频单段时长，以及视频和音频各自 30 秒总时长均由服务器 Preview 规则复核。

客户端视频/音频检查依赖系统 `ffprobe`；缺失时明确返回 `FFPROBE_NOT_AVAILABLE`。R4 正式提交只能使用 `slotId → verified Asset` 映射；Backend 还会复验实际对象内容，Worker 不再重复猜测媒体类型。

## 工作流目录

```http
GET /api/v1/tasks/workflows
Authorization: Bearer <个人 Token>
```

返回 `contractVersion`、`contractRevision`、`contractDigest`、服务端选择的模型，以及 8 类工作流的角色、参数和四维状态：capability、implementation、admission、validation。

## 创建 Preview

```http
POST /api/v1/tasks/preflight
Authorization: Bearer <个人 Token>
Content-Type: application/json
```

文生视频请求示例：

```json
{
  "contractVersion": 2,
  "workflowKey": "seedance.text-to-video.v1",
  "prompt": { "positive": "雨后的街道，镜头缓慢推进" },
  "generation": {
    "duration": 4,
    "ratio": "16:9",
    "resolution": "720p",
    "generateAudio": true,
    "watermark": false,
    "outputFormat": "mp4"
  },
  "media": []
}
```

素材工作流的 `media[]` 只发送本地检查得到的描述，不发送文件、Base64、缩略图、素材 URL 或本机绝对路径：

```json
{
  "slotId": "reference-1",
  "role": "reference_image",
  "sha256": "64位实际内容哈希",
  "mimeType": "image/png",
  "sizeBytes": 123456,
  "metadata": { "kind": "image", "width": 1280, "height": 720 }
}
```

成功响应包含：

- `requestCheck.status/items`：请求本身是否满足合同；
- `productionAdmission.canSubmit/blockers`：当前是否具备新任务提交条件；
- `effectiveRequest`：唯一生效请求；
- `contractDigest`、`intentDigest`；
- Quote：无输入视频且规格可确定时按实际 duration、官方像素、24 FPS 和适用价格计算；`adaptive` 无法锁定时返回 bounded；含输入视频在最低 Token 明细未取得前返回 unavailable；
- `willUploadMedia=false`、`willCallProvider=false`。

字段结构畸形或包含客户端自填 `model`、价格、Provider 字段时返回结构化 400：

```json
{
  "code": "WORKFLOW_FIELDS_INVALID",
  "path": "model",
  "message": "WORKFLOW_FIELDS_INVALID"
}
```

## 复验 Preview

```http
GET /api/v1/tasks/preflight/<preflightId>/check
Authorization: Bearer <个人 Token>
```

复验保存的 effectiveRequest、合同摘要和报价，并重新计算当前价格及 Production blockers。记录或报价过期后返回 `requestCheck.status=incomplete`；促销/账户价变化返回 `PREFLIGHT_QUOTE_CHANGED`，不会静默更价、删除历史记录或创建 Task。

## R3 报价边界

- 公式：`(输入视频总时长 + 输出时长) × 官方输出宽 × 官方输出高 × 24 / 1024`，金额为 Token × 元/百万 Token，使用 Decimal 向上保留 6 位小数。
- 公开刊例：无输入视频 480p/720p 为 70 元/百万 Token、1080p 为 77；含输入视频分别为 42/46，但最低 Token 表缺失时不能形成正式预占。
- 公开促销不会自动应用。只有 `VIDEO_FLOW_SEEDANCE_25_CONFIRMED_PROMOTION_IDS` 明确确认当前账户适用时才使用，并把报价有效期截断到活动结束时间。
- 已确认账户/订单价通过 `VIDEO_FLOW_SEEDANCE_25_ACCOUNT_PRICING_JSON` 提供完整价格、来源和有效期；缺少任一分辨率或格式错误时 fail-closed。
- `estimated` 是公式估算，`bounded` 是有依据的预占上界，`usage_calculated` 是按冻结价格解释 Provider usage；三者都不是 Provider 最终账单确认。
- R4 已从 PreflightRecord 原样消费 `quoteDigest`、`reserveCny` 和 `basis.pricingSnapshot`；客户端不得提交单价或金额。

## 旧入口响应

向 `POST /api/v1/tasks` 提交 `mode=preview` 返回 400：

```json
{
  "code": "PREVIEW_TASK_CREATION_RETIRED",
  "path": "mode",
  "message": "Use POST /api/v1/tasks/preflight for Preview"
}
```

正式请求形状如下；除 `mode` 外的字段严格限定为 `preflightId`、`executionSlotId` 和素材绑定，Prompt、规格、摘要、价格与 Provider 字段均从预检记录恢复：

```json
{
  "mode": "production",
  "preflightId": "<uuid>",
  "executionSlotId": "<stable-client-slot-id>",
  "media": [
    { "slotId": "reference-1", "assetId": "<verified-asset-uuid>" }
  ]
}
```

同槽恢复与客户端交付接口：

```http
GET /api/v1/tasks/slots/:slotId/current
POST /api/v1/tasks/:taskId/client-delivery
Authorization: Bearer <个人 Token>
```

当前只有 `seedance.text-to-video.v1` 开放（`implementation=ready` 且 `admission.enabled=true`，依据 [R8 授权清单 §8](./r8-production-acceptance-scope.md)），因此对它的 Preview **不会**返回 `WORKFLOW_*` 系列 blocker，只剩账号白名单、金额与全局闸门；其余七类仍是 `implementation=incomplete / admission=false`，`WORKFLOW_NOT_READY` 与 `WORKFLOW_NOT_ENABLED` 两个 blocker 都会返回。生产源码没有“测试环境打开工作流”的配置；R4 服务测试通过测试专用 Catalog fixture 或依赖替换构造 ready workflow，真实 Nest 合同仅在 `test/contract-backend.cjs` 中替换 Provider。当前 ComfyUI 客户端仍是旧一次性确认协议，必须完成 R5 后才能提交上述请求。

## Migration 与回滚

部署迁移：

```bash
cd packages/backend
npm run prisma:generate
npx prisma migrate deploy
```

R1 migration 新增 `preflight_records`；R4 migration 为 Task 增加执行槽、序号、预检/摘要和客户端交付字段及索引；随后 `20260915170000_decimal_execution_costs` 将 Task/Attempt 的四个历史浮点金额列转换为 `Decimal(18,6)`。转换前若发现 `NaN/Infinity` 会直接失败，需先人工核查；有限值按数据库已经保存的实际值保留并规范到 6 位。回滚时先暂停新任务提交并回滚应用版本；保留新增表/列和已写记录，不执行反向改回浮点，不执行 DROP，不改写历史 Task。恢复前向升级时重复执行 `prisma migrate deploy`。

隔离验证：

```bash
VIDEO_FLOW_MIGRATION_ONLY=1 \
VIDEO_FLOW_CONTRACT_DB_PORT=55435 \
VIDEO_FLOW_CONTRACT_PROVIDER_PORT=19093 \
bash scripts/run_mvp_contract.sh

cd packages/backend
npm run build
npx jest workflow-catalog.service preflight.service v1-tasks.controller --runInBand
```

真实 HTTP/数据库合同由 `test/preflight-v2.contract-spec.ts`、`test/preflight.contract-spec.ts` 和 `test/preflight-http.smoke.cjs` 覆盖；测试环境禁止真实 Provider 凭证。`scripts/run_mvp_contract.sh` 已只运行 v2 Preview/Production 合同：源合同保持 fail-closed，测试 Backend 通过依赖替身临时开放指定工作流。旧 Preview Task、`confirmLiveSubmission` 和 `VIDEO_FLOW_PRODUCTION_SPEC_JSON` 已退出，不得恢复为新提交路径。
