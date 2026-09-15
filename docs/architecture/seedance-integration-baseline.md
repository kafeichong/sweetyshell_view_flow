# 统一 Seedance 接入架构基线

> 日期：2026-09-10（最后整理 2026-09-15）
> 状态：**现行架构基线**，冻结边界不退回到"服务器集中部署 ComfyUI"方案
> 适用范围：`/Users/steven/works/20260909video_flow`
>
> 相关文档：[PROJECT_STATUS.md](../PROJECT_STATUS.md)（现状与风险）、[ROADMAP.md](../ROADMAP.md)（计划与门禁）、[ADR-0001](./adr/0001-production-execution-slot.md)（Production 执行槽与重复生成）。
> 本文描述架构约定与规则，不描述实现进度；实现进度以 PROJECT_STATUS 为准。

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

表示一次请求输出的视频。同一 Production 节点顺序“再生成一版”会创建新的 Task；重复查看、轮询、恢复或下载当前版本不能创建新的 Task。

关键字段：

- `id`
- `actorId`
- `executionSlotId`
- `slotSequence`
- `clientRequestId`
- `preflightId`
- `contractDigest`
- `intentDigest`
- `quoteDigest`
- `clientDeliveryStatus`
- `clientDeliveredAt`
- `capability`
- `workflowName`
- `workflowVersion`
- `workflowHash`
- `requestSnapshot`
- `status`
- `createdAt`
- `completedAt`

`actorId + clientRequestId` 必须唯一，用于阻止同一次创建请求因超时重试造成重复付费。Backend 还必须在事务或等效串行化边界内保证同一 `actorId + executionSlotId` 最多只有一个尚未完成本地交付的 Task。

### Production execution slot

每个 ComfyUI Production 节点持有稳定的 `executionSlotId`：修改 Prompt、素材或生成参数不改变槽，复制节点生成新槽。执行槽不单独建立领域表，以 Task 上的槽标识和序号形成权威历史。

同一槽不支持并行生成。当前 Task 在 Provider、归档、交付或客户端下载阶段尚未完成时，重复 Queue 只恢复该 Task；客户端下载校验后先持久化本地回执，再向 Backend 确认 client delivery，最后由节点返回本地路径。下一次 Queue 才创建下一 Task。Backend 以 Task 的 client delivery 状态作为槽权威依据，客户端回执只是按 actor 隔离的恢复缓存。

详细状态、释放条件和失败语义见 [ADR-0001](./adr/0001-production-execution-slot.md)。

### PreflightRecord

表示不可执行的 Preview 快照，保存 actor、有效期、规范化请求、合同摘要、意图摘要、报价摘要、报告和报价快照。它不属于 Task 状态机，不可被 Worker 领取，也不产生 Attempt 或预算预占。

只要内容、合同和报价仍匹配且记录有效，同一预检可用于同一内容的多个顺序 Task；每个 Task 仍单独进行当时准入、预占和计费。

### ExecutionAttempt

表示同一 Task 内的一次执行、恢复或受控技术重试。用户明确“再生成一版”创建新 Task，不用新 Attempt 表示新的视频版本。

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
- `POST /api/v1/tasks` 必须接收 `preflightId`、`executionSlotId` 和 `slotId → assetId` 映射；不接受第二份可与预检冲突的创作参数。
- Backend 创建 Task 时按 `actorId + executionSlotId` 串行化；槽被未完成本地交付的 Task 占用时返回原 Task，而不是创建新任务。
- 按槽恢复已有 Task 与新任务准入分离；恢复不要求原预检仍有效或当前仍有新建任务额度。
- 所有内部 Worker 更新接口必须使用独立服务凭证，不能和创意人员凭证共用。

## 5. 执行和计费规则

- Provider 返回 `providerTaskId` 后必须先持久化，再开始后续轮询。
- 无法确认 Provider 是否已接受请求时，Attempt 进入 `requires_review`，禁止自动重新提交。
- Worker 领取任务必须使用数据库原子 claim 或租约，禁止多个 Worker 同时执行一个 Attempt。
- `preview` 只做本地或服务端请求校验，不调用付费视频生成接口。
- `production` 才允许创建 Provider 任务。
- 新画布默认 Preview；用户切换到 Production 后模式保持不变。当前内容没有有效预检时，本次 Queue 只执行 Preview 并停止，下一次 Queue 才可正式生成。
- Production 模式不是服务端授权凭证；每次新建 Task 仍检查有效预检、权限、工作流启用、报价和额度。
- 当前 Task 只有在 Provider 成功、OSS 归档、Backend 交付就绪、客户端下载校验完成且节点返回本地路径后，才允许同槽创建下一 Task。
- Provider 是否受理不确定、已有 Provider ID、归档或下载失败时恢复同一 Task；只有能确认不会产生结果的终态才释放槽。
- `estimated`、`usage_calculated`、`billed`、`unavailable` 是不同费用状态，不得混用。
- 没有 usage 或账单证据时不得把费用写成 `0`。
- 测试默认使用 mock；真实 Seedance 任务必须单独获得付费测试批准。

## 6. 素材规则

- ComfyUI 本地路径不能直接传给 Seedance。
- Preview 只在本地读取实际文件、计算元信息与 SHA-256，并将描述发送给 Backend，不上传素材。
- Production 具备匹配当前内容的有效预检且通过当时准入后，客户端才从 Backend 获取短期上传凭证并直传 OSS。
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
