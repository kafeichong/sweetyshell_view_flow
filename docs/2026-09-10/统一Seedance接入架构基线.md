# 统一 Seedance 接入架构基线

> 日期：2026-09-10  
> 状态：开发基线，实施前不再回到“服务器集中部署 ComfyUI”方案  
> 适用范围：`/Users/steven/works/20260909video_flow`

## 1. 目标

让每位同事继续使用自己电脑上的 ComfyUI 和本地模型，同时通过公司服务器统一调用已经充值的火山引擎 Seedance，并为后续身份、任务记录、检测、费用、限额和审计保留稳定扩展点。

## 2. 冻结的系统边界

```text
同事电脑：ComfyUI + 本地模型 + Video Flow 客户端节点
                         |
                         | HTTPS + 个人或设备凭证
                         v
公司服务器：Backend + PostgreSQL + Worker + OSS
                         |
                         v
                 火山引擎 Seedance
```

- ComfyUI 是本地创意工作流界面，不是公司密钥的保存位置。
- Server Worker 是唯一允许持有和调用火山、OSS 生产密钥的组件。
- Backend 是身份、权限、任务、素材和执行记录的唯一写入口。
- PostgreSQL 是任务和执行状态的权威数据源。
- OSS 保存输入和输出对象；数据库永久保存 `objectKey`，签名 URL 按需生成。
- 本地模型和 Seedance 是并存能力，本地模型升级不影响统一 Seedance API。
- 第一版只支持 Seedance，但内部任务契约不使用火山专有字段作为领域模型。

## 3. 稳定领域模型

### Task

表示一次用户意图。重复查看、轮询或下载不能创建新的 Task。

关键字段：

- `id`
- `actorId`
- `clientRequestId`
- `capability`
- `workflowName`
- `workflowVersion`
- `workflowHash`
- `requestSnapshot`
- `status`
- `createdAt`
- `completedAt`

`actorId + clientRequestId` 必须唯一，用于阻止客户端超时重试造成重复付费。

### ExecutionAttempt

表示一次真实或潜在付费执行。用户明确“重新生成”时创建新 Attempt，不覆盖历史 Attempt。

关键字段：

- `taskId`
- `attemptNo`
- `mode`
- `provider`
- `model`
- `providerTaskId`
- `status`
- `providerUsage`
- `costStatus`
- `estimatedCostCny`
- `usageCalculatedCostCny`
- `billedCostCny`
- `pricingVersion`
- `failureType`
- `failureCode`
- `failureMessage`
- `submittedAt`
- `startedAt`
- `finishedAt`

### Asset

表示输入或输出媒体。数据库保存对象身份，不保存会过期的签名 URL 作为永久地址。

关键字段：

- `ownerId`
- `taskId`
- `attemptId`
- `role`
- `mediaType`
- `bucket`
- `objectKey`
- `mimeType`
- `sizeBytes`
- `fileHash`
- `inspectionStatus`

### ActorCredential

表示同事或设备的可撤销访问凭证。数据库只保存 token hash，不保存明文 token。

关键字段：

- `actorId`
- `name`
- `tokenHash`
- `status`
- `dailyLimitCny`
- `monthlyLimitCny`
- `lastUsedAt`

## 4. API 兼容规则

- 新客户端只使用 `/api/v1`。
- 现有 `/api/tasks` 在兼容期内保留，不直接删除或修改返回结构。
- 新字段先在数据库和新 API 中增加，再由 Worker 双写；旧字段最后才进入清理候选。
- API 只允许增加可选字段；删除、改名或改变语义必须发布新版本。
- `createdBy` 仅作旧接口兼容展示，新接口的实际身份由凭证解析得到。
- `POST /api/v1/tasks` 必须接受 `Idempotency-Key` 或等价的 `clientRequestId`。
- 所有内部 Worker 更新接口必须使用独立服务凭证，不能和创意人员凭证共用。

## 5. 执行和计费规则

- Provider 返回 `providerTaskId` 后必须先持久化，再开始后续轮询。
- 无法确认 Provider 是否已接受请求时，Attempt 进入 `requires_review`，禁止自动重新提交。
- Worker 领取任务必须使用数据库原子 claim 或租约，禁止多个 Worker 同时执行一个 Attempt。
- `preview` 只做本地或服务端请求校验，不调用付费视频生成接口。
- `production` 才允许创建 Provider 任务。
- `estimated`、`usage_calculated`、`billed`、`unavailable` 是不同费用状态，不得混用。
- 没有 usage 或账单证据时不得把费用写成 `0`。
- 测试默认使用 mock；真实 Seedance 任务必须单独获得付费测试批准。

## 6. 素材规则

- ComfyUI 本地路径不能直接传给 Seedance。
- 客户端先从 Backend 获取短期上传凭证，再直传 OSS。
- Backend 校验 MIME、大小、角色和 object key 前缀。
- Provider 请求使用可访问的 HTTPS URL。
- 输出完成后由 Worker归档到 OSS，并登记 Asset。
- 下载时由 Backend 根据 `objectKey` 生成新的短期签名 URL。

## 7. 部署和安全规则

- 对外只开放 HTTPS Backend。
- Worker 和 PostgreSQL 不直接暴露给同事电脑或公网。
- 火山和 OSS 密钥只通过服务器环境变量或 Secret Manager 注入。
- ComfyUI 节点只保存 Video Flow 的可撤销凭证。
- 日志不得输出 API Key、OSS Secret、完整签名 URL 或明文个人 token。
- 数据库迁移使用 expand-contract：先扩展、再双写、再切读、最后清理。

## 8. 暂缓范围

- 完整管理后台。
- 多 Provider 自动路由。
- Workflow 在线编辑器。
- 公司级 SSO。
- 自动账单拉取与财务结算。
- 复杂审批流。
- 素材语义搜索和智能评分。

这些能力必须建立在 Task、ExecutionAttempt、Asset、ActorCredential 稳定后迭代，不能反向改写基础语义。

## 9. 兼容和回滚原则

- 每个迭代必须能独立部署和独立回滚应用代码。
- 数据库回滚优先停止使用新增结构，不立即删除表或列。
- 每次迁移前备份数据库并记录 migration 名称。
- 新旧 API 至少保留一个完整灰度周期。
- ComfyUI 客户端声明协议版本；服务端拒绝不兼容版本并返回可理解的升级提示。
- 新客户端先给 1 名同事灰度，再扩大到 2 至 3 人，最后才全员使用。

