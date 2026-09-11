# ComfyUI Unified Seedance Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不重做现有 Backend、Worker 和已部署 Seedance 链路的前提下，让同事从各自本机 ComfyUI 安全使用公司统一接口，并逐步获得可靠记录、费用和检测能力。

**Architecture:** 本机 ComfyUI 只作为 HTTPS 客户端，服务器 Backend 负责鉴权、幂等、任务和素材入口，Python Worker 继续直接调用火山 Seedance。采用 expand-contract 数据迁移、版本化 API、双写兼容和小范围灰度，每个迭代都能独立上线、验收和回滚。

**Tech Stack:** NestJS、Prisma、PostgreSQL 16、Python 3.13、FastAPI Worker、ComfyUI custom nodes、Volcengine Ark、Aliyun OSS、Docker Compose

**Spec:** `docs/2026-09-10/统一Seedance接入架构基线.md`

## Global Constraints

- 不把火山或 OSS 生产密钥下发到同事电脑。
- 不删除或改变现有 `/api/tasks` 的兼容行为，直到新链路完成灰度。
- 不在自动化测试中创建真实火山付费任务。
- Provider 已返回 ID 时只恢复查询，不自动创建第二个付费任务。
- 数据库使用 expand-contract；新增迁移不直接删除现有字段。
- 新 API 固定使用 `/api/v1`，ComfyUI 客户端发送协议版本。
- 永久保存 OSS `objectKey`，签名 URL 仅按需生成。
- 每个迭代结束后先验收，再决定是否进入下一迭代。

---

## 迭代总览

| 迭代 | 可独立交付结果 | 是否触发真实付费 | 回滚边界 |
|---|---|---:|---|
| 0 | 冻结现状和契约测试 | 否 | 仅测试和文档 |
| 1 | 新数据模型可用，旧流程不变 | 否 | 应用停止读写新表 |
| 2 | Provider 任务可恢复且不会重复领取 | 否 | Worker 回退旧镜像，新表保留 |
| 3 | 鉴权、幂等和素材上传 API | 否 | 关闭 `/api/v1`，旧 API 保留 |
| 4 | ComfyUI 客户端 Preview 联调 | 否 | 卸载客户端节点 |
| 5 | 单人 Production 灰度 | 是，需单独批准 | 禁用凭证或 Production policy |
| 6 | 检测、费用、限额和多人灰度 | 受策略控制 | 关闭策略模块，不回退任务数据 |
| 7 | 管理后台与多 Provider 扩展 | 受策略控制 | 保留 API，回退 UI 或 Provider 配置 |

## Task 0: 建立当前行为的安全网

**Files:**

- Modify: `packages/backend/package.json`
- Create: `packages/backend/src/tasks/tasks.service.spec.ts`
- Create: `packages/backend/src/tasks/tasks.controller.spec.ts`
- Create: `packages/worker/tests/test_mvp_backend_contract.py`
- Create: `docs/2026-09-10/上线检查与回滚记录模板.md`

**Interfaces:**

- Consumes: 现有 `/api/tasks` 和 Worker `update_job_status()` 行为。
- Produces: 旧接口兼容测试、部署前后检查模板、后续重构的回归安全网。

- [ ] **Step 1: 为 Backend 添加现有 NestJS/Jest 测试入口**

在 `package.json` 中增加 `test` 和 `test:watch`，测试环境不得连接生产数据库。

- [ ] **Step 2: 固定旧任务接口契约**

覆盖以下行为：创建任务默认 `pending`、按状态查询、完成时设置 `completedAt`、旧字段名保持不变。

- [ ] **Step 3: 固定 Worker 旧回写契约**

使用 `httpx.MockTransport` 验证当前 Worker 仍能回写 `status/cost/videoUrl/errorMsg`，测试中禁止访问 Ark 和 OSS。

- [ ] **Step 4: 建立上线检查模板**

模板必须记录数据库备份、migration、镜像 tag、容器状态、旧 API smoke test、回滚命令和负责人。

- [ ] **Step 5: 运行本迭代测试**

```bash
cd packages/backend && npm test
cd packages/worker && pytest tests/test_mvp_backend_contract.py -q
```

预期：全部通过，无外部付费请求。

- [ ] **Step 6: 提交独立变更**

```bash
git add packages/backend/package.json packages/backend/src/tasks packages/worker/tests/test_mvp_backend_contract.py docs/2026-09-10/上线检查与回滚记录模板.md
git commit -m "test: lock current video task contracts"
```

**Gate 0:** 未建立旧行为回归测试，不进入数据库演进。

## Task 1: 用 expand-contract 增加稳定领域模型

**Files:**

- Modify: `packages/backend/prisma/schema.prisma`
- Create: `packages/backend/prisma/migrations/<timestamp>_expand_execution_domain/migration.sql`
- Create: `packages/backend/src/executions/executions.module.ts`
- Create: `packages/backend/src/executions/executions.service.ts`
- Create: `packages/backend/src/executions/executions.service.spec.ts`
- Create: `packages/backend/src/assets/assets.module.ts`
- Create: `packages/backend/src/assets/assets.service.ts`
- Modify: `packages/backend/src/app.module.ts`

**Interfaces:**

- Consumes: 现有 `Task.id/status/cost/videoUrl`。
- Produces: `ActorCredential`、扩展后的 `Task`、`ExecutionAttempt`、`Asset`；旧字段全部保留。

- [ ] **Step 1: 编写失败测试定义领域约束**

至少验证：`actorId + clientRequestId` 唯一、`taskId + attemptNo` 唯一、`providerTaskId` 可唯一查询、Asset 永久保存 object key。

- [ ] **Step 2: 扩展 Prisma schema**

新增枚举 `TaskStatus`、`AttemptStatus`、`ExecutionMode`、`CostStatus`；新增三张表并给旧 Task 增加可空的新字段。第一份 migration 不删除 `createdBy/imageUrl/videoUrl/cost`。

- [ ] **Step 3: 增加 ExecutionAttempt 服务**

提供以下内部接口：

```typescript
createAttempt(taskId: string, mode: ExecutionMode): Promise<ExecutionAttempt>
recordProviderSubmission(attemptId: string, providerTaskId: string): Promise<ExecutionAttempt>
recordUsage(attemptId: string, usage: Prisma.JsonValue): Promise<ExecutionAttempt>
markRequiresReview(attemptId: string, code: string, message: string): Promise<ExecutionAttempt>
```

- [ ] **Step 4: 增加 Asset 服务**

提供：

```typescript
registerInput(data: RegisterAssetInput): Promise<Asset>
registerOutput(data: RegisterAssetOutput): Promise<Asset>
findByTask(taskId: string): Promise<Asset[]>
```

- [ ] **Step 5: 验证迁移兼容旧数据**

在非生产数据库导入至少一条旧 Task，执行 migration 后验证旧接口仍能读取该记录。

- [ ] **Step 6: 运行测试和构建**

```bash
cd packages/backend && npm test
cd packages/backend && npm run build
```

- [ ] **Step 7: 提交独立变更**

```bash
git add packages/backend
git commit -m "feat: expand task execution and asset domain"
```

**Gate 1:** 旧 `/api/tasks` 完全兼容；新表已存在但尚未成为生产链路的唯一依赖。

**Rollback 1:** 回退 Backend 镜像并停止写新表；不执行 DROP TABLE，不回滚旧 Task 数据。

## Task 2: 修复 Worker 执行完整性和重复计费风险

**Files:**

- Modify: `packages/backend/src/tasks/tasks.service.ts`
- Modify: `packages/backend/src/tasks/tasks.controller.ts`
- Create: `packages/backend/src/tasks/task-claim.service.ts`
- Create: `packages/backend/src/tasks/task-claim.service.spec.ts`
- Modify: `packages/worker/models.py`
- Modify: `packages/worker/executor.py`
- Modify: `packages/worker/recovery.py`
- Create: `packages/worker/tests/test_provider_submission_recovery.py`
- Create: `packages/worker/tests/test_task_claiming.py`

**Interfaces:**

- Consumes: Task 1 的 `ExecutionAttempt`。
- Produces: 原子 claim、持久化 Provider ID、重启恢复、`requires_review` 状态。

- [ ] **Step 1: 为重复领取写失败测试**

并发调用两次 claim，只允许一个调用得到同一个 Task；另一个返回空结果。

- [ ] **Step 2: 实现原子 claim**

Backend 在事务中将 `pending` Attempt 改为 `claimed` 并写入 `leaseOwner/leaseExpiresAt`，Worker 不再通过普通列表查询直接执行。

- [ ] **Step 3: 为 Provider 提交窗口写失败测试**

模拟 Ark 返回 `providerTaskId` 后 Worker 崩溃，重启后必须只调用查询接口，`create_task()` 调用次数保持为 1。

- [ ] **Step 4: 改造 Worker 状态写入**

`update_job_status()` 拆分为明确动作：claim、record submission、record progress、record usage、complete、fail。Provider ID、usage、pricing version 和失败详情写入 Attempt，不再被 MVP payload 丢弃。

- [ ] **Step 5: 增加不确定提交保护**

网络在请求发送后断开、无法确认 Ark 是否创建任务时，将 Attempt 写成 `requires_review`，不进入自动重试队列。

- [ ] **Step 6: 保留旧字段双写**

任务完成时同时更新新 Asset/Attempt 和旧 `Task.videoUrl/Task.cost`，确保旧调用方仍工作。

- [ ] **Step 7: 运行离线测试**

```bash
cd packages/backend && npm test
cd packages/worker && pytest tests/test_provider_submission_recovery.py tests/test_task_claiming.py -q
```

- [ ] **Step 8: 提交独立变更**

```bash
git add packages/backend packages/worker
git commit -m "fix: make provider execution resumable and idempotent"
```

**Gate 2:** 重启和双 Worker 测试都不能创建第二次 Provider 请求。

**Rollback 2:** 回退 Worker 和 Backend 镜像；保留 Attempt 数据用于排障，旧任务接口继续可用。

## Task 3: 增加版本化鉴权、幂等和素材 API

**Files:**

- Create: `packages/backend/src/auth/auth.module.ts`
- Create: `packages/backend/src/auth/api-credential.guard.ts`
- Create: `packages/backend/src/auth/current-actor.decorator.ts`
- Create: `packages/backend/src/auth/credentials.service.ts`
- Create: `packages/backend/src/auth/api-credential.guard.spec.ts`
- Create: `packages/backend/src/v1/tasks/v1-tasks.controller.ts`
- Create: `packages/backend/src/v1/tasks/dto/create-task.dto.ts`
- Create: `packages/backend/src/v1/assets/v1-assets.controller.ts`
- Create: `packages/backend/src/v1/assets/dto/create-upload-ticket.dto.ts`
- Create: `packages/backend/src/v1/internal/v1-worker.controller.ts`
- Modify: `packages/backend/src/main.ts`
- Modify: `packages/backend/src/app.module.ts`
- Modify: `docker-compose.yml`

**Interfaces:**

- Consumes: ActorCredential、Task、ExecutionAttempt、Asset。
- Produces: `/api/v1/tasks`、`/api/v1/assets/upload-ticket`、`/api/v1/internal/attempts/*`。

- [ ] **Step 1: 为身份边界写失败测试**

验证无凭证为 401、停用凭证为 403、客户端提交的 `createdBy` 不改变服务端 actor、Worker 凭证不能调用管理员接口。

- [ ] **Step 2: 实现哈希凭证鉴权**

凭证只在创建时返回一次明文，数据库保存 SHA-256/HMAC hash；请求上下文输出 `actorId` 和 credential scope。

- [ ] **Step 3: 实现幂等任务创建**

```http
POST /api/v1/tasks
Authorization: Bearer <video-flow-token>
Idempotency-Key: <uuid>
X-Video-Flow-Protocol: 1
```

相同 actor 和 key 返回同一个 Task；请求内容不同但 key 相同返回 409。

- [ ] **Step 4: 实现 OSS 上传票据**

只允许配置的 MIME、大小和 `inputs/{actorId}/...` 前缀；返回短期预签名 PUT URL 和待登记 Asset ID。

- [ ] **Step 5: 实现结果下载 URL 刷新**

`GET /api/v1/assets/:id/download` 根据 object key 动态签名，数据库不更新为临时 URL。

- [ ] **Step 6: 保护 Worker 内部接口**

内部接口使用独立 service token；创意人员 token 不允许更新 Attempt 状态。

- [ ] **Step 7: 收紧容器网络**

移除 Worker 和 PostgreSQL 的公网 host port；Backend 只绑定回环或交给现有 HTTPS 反向代理，不在 ComfyUI 中暴露 `8101/5433`。

- [ ] **Step 8: 运行安全和构建测试**

```bash
cd packages/backend && npm test
cd packages/backend && npm run build
```

- [ ] **Step 9: 提交独立变更**

```bash
git add packages/backend docker-compose.yml
git commit -m "feat: add authenticated video flow v1 api"
```

**Gate 3:** 不持有个人凭证的客户端不能创建、读取或修改任务；旧 `/api/tasks` 仅保留在受限网络兼容期。

## Task 4: 开发 ComfyUI 客户端并只联调 Preview

**Files:**

- Create: `packages/comfyui-video-flow-client/__init__.py`
- Create: `packages/comfyui-video-flow-client/nodes.py`
- Create: `packages/comfyui-video-flow-client/client.py`
- Create: `packages/comfyui-video-flow-client/config.py`
- Create: `packages/comfyui-video-flow-client/requirements.txt`
- Create: `packages/comfyui-video-flow-client/README.md`
- Create: `packages/comfyui-video-flow-client/tests/test_client.py`
- Create: `packages/comfyui-video-flow-client/tests/test_nodes.py`
- Create: `packages/comfyui-video-flow-client/workflows/seedance-image-to-video-v1.comfy.json`

**Interfaces:**

- Consumes: `/api/v1` 协议。
- Produces: `VideoFlowConfig`、`VideoFlowUploadMedia`、`VideoFlowSeedanceGenerate`、`VideoFlowWaitTask`、`VideoFlowLoadResult`。

- [ ] **Step 1: 编写节点离线测试**

验证 token 不出现在节点输出和日志、上传返回 Asset ID、重复 queue 使用同一幂等 key、Preview 不创建 Production Attempt。

- [ ] **Step 2: 实现最小 HTTP client**

```python
class VideoFlowClient:
    def create_upload_ticket(self, *, filename: str, mime_type: str, size_bytes: int) -> dict: ...
    def create_task(self, *, idempotency_key: str, payload: dict) -> dict: ...
    def get_task(self, task_id: str) -> dict: ...
    def get_download_url(self, asset_id: str) -> str: ...
```

- [ ] **Step 3: 实现配置和媒体上传节点**

配置只包含 Backend URL、Video Flow token 和 protocol version；不接受 Ark/OSS Key。

- [ ] **Step 4: 实现生成和等待节点**

默认 `mode=preview`；Production 必须由显式布尔输入控制，节点自动生成并复用 `clientRequestId`。

- [ ] **Step 5: 提供受控 Workflow**

第一份 Workflow 只覆盖单图 Image-to-Video，固定字段语义为 `reference_image`，不同时引入多图、视频参考和多 Provider。

- [ ] **Step 6: 使用 Mock Backend 验证完整节点图**

```bash
cd packages/comfyui-video-flow-client && pytest tests -q
```

预期：Preview 完整返回请求摘要，无 Ark 请求。

- [ ] **Step 7: 提交独立变更**

```bash
git add packages/comfyui-video-flow-client
git commit -m "feat: add comfyui video flow client preview"
```

**Gate 4:** 一台非开发电脑可以安装节点、上传测试图并完成 Preview；电脑中不存在 Ark/OSS 密钥。

**Rollback 4:** 从 `custom_nodes` 移除客户端目录，不影响原有本地模型和 Workflow。

## Task 5: 单用户 Production 灰度

**Files:**

- Modify: `packages/backend/src/v1/tasks/v1-tasks.controller.ts`
- Create: `packages/backend/src/policies/execution-policy.service.ts`
- Create: `packages/backend/src/policies/execution-policy.service.spec.ts`
- Modify: `packages/comfyui-video-flow-client/nodes.py`
- Create: `docs/2026-09-10/ComfyUI客户端安装与使用.md`
- Create: `docs/2026-09-10/Production付费验收记录.md`

**Interfaces:**

- Consumes: Preview 客户端、ExecutionAttempt、actor limit。
- Produces: 受策略控制的单用户 Production。

- [ ] **Step 1: 写执行策略测试**

验证凭证停用、超过日限额、未知模型、缺少显式 Production 确认时拒绝创建付费 Attempt。

- [ ] **Step 2: 实现服务端 Production policy**

默认只对白名单 actor 开启；额度按已提交但未结算的估算费用和已完成 usage 费用共同占用。

- [ ] **Step 3: 在客户端展示请求摘要和费用状态**

Preview 返回模型、时长、比例、输入素材、费用估算或 unavailable；用户显式切换 Production 后才提交。

- [ ] **Step 4: 完成不产生费用的部署检查**

检查 HTTPS、身份归属、上传、幂等、Worker claim、日志脱敏、结果 URL 刷新，不调用 Ark create endpoint。

- [ ] **Step 5: 单独申请一次真实付费验收权限**

记录批准人、模型、预计次数和最高预算。未获得批准时停在此步骤，不用其他真实任务替代验证。

- [ ] **Step 6: 执行一次真实 Image-to-Video**

验证 Task、Attempt、Provider ID、Asset、usage、费用状态和 OSS object key 均可追溯；已有 Provider ID 时只查询。

- [ ] **Step 7: 观察一个工作日再扩大范围**

期间只允许 1 名灰度用户，记录失败、重复提交、签名 URL 和使用体验。

- [ ] **Step 8: 提交文档和策略变更**

```bash
git add packages/backend packages/comfyui-video-flow-client docs/2026-09-10
git commit -m "feat: enable policy controlled seedance production"
```

**Gate 5:** 单次付费生成只有一个 Provider task ID，完整追溯，Worker 重启后不重复收费。

**Rollback 5:** 立即停用灰度 credential 或关闭 Production policy；Preview 和旧服务端链路继续运行。

## Task 6: 增加检测、费用、限额和多人灰度

**Files:**

- Create: `packages/backend/src/usage/usage.module.ts`
- Create: `packages/backend/src/usage/usage.service.ts`
- Create: `packages/backend/src/usage/usage.controller.ts`
- Create: `packages/backend/src/usage/usage.service.spec.ts`
- Create: `packages/backend/src/health/provider-health.service.ts`
- Create: `packages/backend/src/health/provider-health.controller.ts`
- Modify: `packages/worker/providers/seedance_adapter.py`
- Modify: `packages/worker/executor.py`
- Create: `packages/worker/tests/test_failure_audit.py`
- Create: `packages/worker/tests/test_cost_status.py`

**Interfaces:**

- Consumes: Attempt usage、failure、actor limit。
- Produces: 使用汇总、失败检测、健康状态和额度控制。

- [ ] **Step 1: 固定费用语义测试**

覆盖 `estimated/usage_calculated/billed/unavailable`；缺少 usage 时不能返回零，usage 计算值不能显示成账单确认值。

- [ ] **Step 2: 保存 Provider 原始 usage 和定价版本**

只保存必要字段和脱敏响应；价格作为版本化服务器配置，不硬编码成“最终账单”。

- [ ] **Step 3: 增加失败和健康检测**

统计 rate limit、content policy、invalid input、timeout、network 和 unknown；健康接口不通过创建视频任务来探测。

- [ ] **Step 4: 增加按 actor 的额度计算**

提供日/月使用汇总和剩余额度，额度检查必须在创建 Production Attempt 的同一事务边界内完成。

- [ ] **Step 5: 扩大到 2 至 3 名同事灰度**

每人独立 credential；连续观察至少三个工作日，验证归属、限额、并发和下载。

- [ ] **Step 6: 运行测试**

```bash
cd packages/backend && npm test
cd packages/worker && pytest tests/test_failure_audit.py tests/test_cost_status.py -q
```

- [ ] **Step 7: 提交独立变更**

```bash
git add packages/backend packages/worker
git commit -m "feat: add usage limits and execution monitoring"
```

**Gate 6:** 可以回答谁、何时、用哪个 Workflow/模型、提交了几次、成功失败原因、usage 计算费用和剩余额度。

## Task 7: 清理兼容层和准备后续扩展

**Files:**

- Create: `docs/2026-09-10/API-v1兼容矩阵.md`
- Create: `docs/2026-09-10/旧API下线评估.md`
- Modify: `packages/backend/src/tasks/tasks.controller.ts`
- Modify: `packages/worker/executor.py`
- Modify: `README.md`

**Interfaces:**

- Consumes: 完成灰度的 `/api/v1`。
- Produces: 明确的旧接口下线条件；不在本任务中直接删除旧数据库列。

- [ ] **Step 1: 统计旧 API 实际调用**

至少观察一个完整灰度周期，确认旧 ComfyUI、脚本和 Worker 是否仍访问 `/api/tasks`。

- [ ] **Step 2: 发布兼容矩阵**

列出协议版本、最低客户端版本、支持的 API、字段和下线日期；客户端版本不兼容时返回升级提示。

- [ ] **Step 3: 将旧 API 改为只读或受限网络访问**

先停止新调用方接入，再停止旧写入口；不得在同一次发布中删除数据库旧列。

- [ ] **Step 4: 单独评审 contract migration**

只有满足“零旧调用、数据已回填、备份已验证、回滚窗口结束”时，另建计划删除旧字段。本计划不执行删除。

- [ ] **Step 5: 更新主 README**

明确本机 ComfyUI、公司 API、Worker、Ark 和 OSS 的职责，以及 Preview/Production 边界。

- [ ] **Step 6: 提交独立变更**

```bash
git add docs/2026-09-10 packages/backend packages/worker README.md
git commit -m "docs: define v1 compatibility and legacy retirement gates"
```

**Gate 7:** 旧接口即使继续保留也不会阻碍新功能；删除旧结构必须进入新的、单独审批的 contract 计划。

## 每次迭代的统一发布流程

- [ ] 创建数据库备份并记录恢复位置。
- [ ] 记录当前本地 commit、服务器镜像 tag 和 migration。
- [ ] 先部署 additive migration。
- [ ] 再部署兼容新旧结构的 Backend。
- [ ] 最后部署 Worker 或 ComfyUI 客户端。
- [ ] 先执行无付费 smoke test。
- [ ] 仅在明确批准后执行一次真实 Production 验收。
- [ ] 观察日志和数据库状态后决定继续或回滚。
- [ ] 回滚应用时保留新增表和字段，不做破坏性数据库回滚。

## 完成定义

- 同事电脑没有公司 Ark/OSS 密钥。
- 每位同事使用独立、可撤销凭证。
- 相同幂等键不会创建第二次付费 Attempt。
- Worker 重启或扩容不会重复提交 Provider 任务。
- 本地素材可安全上传并登记为 Asset。
- 输出通过 object key 永久追溯，签名 URL 可刷新。
- 费用明确区分估算、usage 计算、账单确认和未知。
- 旧接口和旧字段的清理有独立门槛，不随功能升级被强制删除。
- 新增 Provider、检测或后台功能只扩展稳定领域模型，不要求重做 ComfyUI 客户端和已有任务数据。

