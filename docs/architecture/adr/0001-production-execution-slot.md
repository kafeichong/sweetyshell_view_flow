# ADR-0001：Production 执行槽与顺序生成

- 状态：已接受
- 决策日期：2026-09-15
- 适用范围：ComfyUI Production 节点、Backend 正式提交、Task/Attempt、客户端恢复与交付
- 需求依据：[工作流 Preview 与 Production 统一需求规范 v2](../../requirements/2026-09-15/workflow-preview-production-spec-v2.md)
- 实现状态：[PROJECT_STATUS](../../PROJECT_STATUS.md)

## 1. 背景

ComfyUI 会把节点 widget 写入画布。用户把模式从 Preview 改为 Production 后，保存、重开或重复 Queue 时仍可能保持 Production，因此“默认 Preview”和持久化确认 Boolean 只能形成操作提示，不能可靠防止重复付费。

系统真正需要阻止的是同一画布节点在上一条视频尚未交付给用户时，由连续点击、等待超时、客户端重启、内容修改或提交响应丢失创建第二条 Provider 任务。同时，视频生成具有随机性；上一条视频已交付后，用户使用相同内容再次 Queue 生成另一版是正常操作，不应被迫重新 Preview。

## 2. 决策

### 2.1 Production 模式保持持久

- `mode=production` 不在任务完成后自动改回 Preview。
- 不增加一次性 Production 授权实体。
- 不使用持久化 Boolean 充当一次付费提交的唯一授权。
- Production 模式表示画布希望执行正式链路；是否新建 Task 仍由有效预检、执行槽状态、服务端准入和幂等规则共同决定。

### 2.2 一个 Production 节点对应一个执行槽

每个 Production 节点持有稳定、不含敏感信息的 `executionSlotId`。执行槽在 actor 范围内生效：

```text
actorId + executionSlotId
```

- 修改 Prompt、素材、参数、节点位置或连线不改变执行槽。
- 保存并重开同一节点时执行槽不变。
- 复制 Production 节点时形成新的执行槽。
- 一个执行槽同一时间只允许一条尚未完成本地交付的 Production Task。
- 需要并行生成时使用另一 Production 节点或另一执行槽；本期不在一个槽内并行。

### 2.3 Task、Attempt 与 PreflightRecord 的语义

- `PreflightRecord` 是内容、参数、合同和报价的检查快照。只要内容与摘要未变且记录仍有效，它可以支持同一槽中的多次顺序生成。
- `Task` 表示用户要求生成的一条视频。上一条完成后再次 Queue 会创建新的 Task，并独立绑定快照、预算、Provider 执行和产物。
- `ExecutionAttempt` 表示同一 Task 的 Provider 执行、恢复或受控技术重试，不表示用户主动再生成一个版本。

Task 目标关系至少包括：

```text
executionSlotId
slotSequence
preflightId
contractDigest
intentDigest
quoteDigest
clientRequestId
clientDeliveryStatus
clientDeliveredAt
```

本期不新增独立 `ExecutionSlot` 表。Backend 通过 Task 上的槽字段与索引查询当前 actor 的最近 Task。

### 2.4 一轮完成以本地交付为边界

以下步骤全部成功后，客户端才把当前轮次标记为已返回：

```text
Provider 成功
→ Worker 归档 OSS
→ Backend delivery.status = ready
→ 客户端下载
→ 客户端校验文件
→ 客户端先持久化本地回执，再向 Backend 确认 client delivery
→ 节点返回 local_video_path
```

Provider 成功、Asset 已登记或签名 URL 已生成，都不能单独证明用户已经在当前 ComfyUI 中取得视频。

Backend 以经过鉴权的 client delivery 确认为释放槽的持久证据。客户端必须先写入包含 Task、本地路径和文件校验结果的回执，再发送确认；确认失败时仍将该 Task 视为待恢复。这样即使确认后进程在节点返回前退出，下一次 Queue 也能先从本地回执返回原文件，而不是直接创建下一条 Task。

在本地视频成功返回前，重复 Queue 只恢复原 Task。成功返回并确认后，执行槽允许下一次 Queue 创建下一条 Task。

### 2.5 Production 下按需自动 Preview

当槽已空闲但当前内容没有有效 PreflightRecord 时：

1. 本次 Queue 只创建或刷新 Preview；
2. 返回检查、报价和 Production blockers；
3. 不上传、不创建 Task、不预占预算、不调用 Provider；
4. Production 模式保持不变；
5. 内容未再变化且预检有效时，下一次 Queue 才允许正式提交。

相同内容、合同和报价的有效预检可直接复用，不要求每生成一条视频都重新 Preview。

### 2.6 Backend 为槽内 Task 的权威来源

- Backend 决定一个 actor 的执行槽当前是否存在未结束或待恢复 Task。
- 客户端回执只缓存 `executionSlotId`、`taskId`、本地交付状态、校验后的本地路径和文件摘要。
- 回执丢失、换电脑或重装后，客户端先凭执行槽向 Backend 找回最近 Task。
- 找到未完成 Task 时继续等待；找到已交付但本机未记录成功返回的 Task 时先重新下载；不得直接新建。
- Backend 在正式创建事务中按 `actorId + executionSlotId` 串行化并复查，两个并发 Queue 最多创建一条新 Task。

## 3. 状态与失败处理

以下状态继续占用执行槽，并恢复原 Task：

- `pending`、`queued`、`submitted`、`running`；
- Provider create 结果不确定；
- 已有 `providerTaskId` 但暂时无法查询；
- `requires_review`；
- Provider 已成功但正在归档；
- `delivery_failed`；
- 下载地址过期、客户端下载失败或本地文件校验失败；
- 客户端等待超时。

只有系统能够确认原任务绝不会再产生可交付结果时才释放执行槽：

- Provider 明确终态失败且确认无产物；
- Provider 明确取消成功且确认无产物；
- Provider 尚未接受请求且提交已被明确终止。

限流或网络错误若能确认 Provider 尚未接受，可以在原 Task 内受控重试。已有 Provider ID 或接受状态不确定时禁止再次 create。权限、预算或 Preview 阶段拒绝发生在 Task 创建前，不形成槽内在途 Task。

## 4. Production Queue 决策顺序

```text
Production Queue
  → Backend 按 actorId + executionSlotId 查询最近 Task
  → 存在未结束或待恢复 Task：恢复原 Task
  → 不存在：检查当前内容是否有有效 PreflightRecord
  → 无有效预检：本次只自动 Preview 并停止
  → 有有效预检：复查权限、暂停、额度、报价和实际素材
  → 事务内锁定执行槽、创建 Task、冻结快照并预占预算
  → Worker 执行与恢复
  → OSS 交付
  → 客户端下载、校验、持久化本地回执并确认交付
  → 节点返回本地路径
  → 当前轮次结束；下一次 Queue 可创建下一条 Task
```

## 5. 被否决的方案

### 每次生成后自动切回 Preview

前端状态可能保存失败、响应丢失或与服务端不同步，不能可靠防重。可作为将来体验优化，但不能替代槽和幂等。

### 每次生成都强制重新 Preview

相同内容重复生成是正常创作行为；合同和报价未变时重复检查只增加操作负担。

### 一次性确认授权实体

能够提供更强确认，但当前目标只是防止无意重复提交，新增授权生命周期和消费状态超出最小需要。

### 只依赖本机回执

回执丢失、换电脑和 POST 响应丢失时无法确认服务器是否已有 Task，可能导致重复付费。

### 按 `intentDigest` 识别在途任务

用户在任务进行中修改内容会改变摘要并绕过保护。执行槽必须与内容摘要分离。

## 6. 影响与取舍

正面影响：

- Production 可以保持符合创作习惯的持久模式；
- 连续 Queue、超时、重启、内容修改和回执丢失不会隐式并行付费；
- 相同内容可以在上一条交付后自然生成下一版；
- Preview、Task、Attempt 和交付职责更清楚。

主要限制：

- 同一执行槽不能并行生成多个视频；
- 内容变化后若上一条仍在运行，必须先恢复旧 Task；
- 内容或报价变化、预检过期时需要额外一次 Queue 完成无付费 Preview；
- Backend 需要持久化槽字段，并在创建任务时增加并发复查。

## 7. 验收标准

1. 同一槽连续或并发 Queue 最多创建一条在途 Task和一次预算预占。
2. 任务进行中修改 Prompt、素材或参数不会创建第二条 Task。
3. 客户端回执丢失后能通过 Backend 找回槽内 Task。
4. Provider create 响应丢失、已有 Provider ID 和 `requires_review` 均不会触发第二次 create。
5. Provider 成功但 OSS 或客户端下载失败时只恢复交付。
6. 本地文件成功下载、校验、持久化回执并确认交付后，节点返回本地路径；下一次 Queue 能创建新的 Task。
7. 有效预检可被多个顺序 Task 复用。
8. 内容、规则或报价变化以及预检过期时，本次 Queue 只自动 Preview，下一次才生成。
9. 明确无产物的终态失败释放槽；不确定或可恢复状态不释放。
10. 复制 Production 节点形成独立执行槽。

## 8. 实施边界

本 ADR 只记录已接受设计，不代表当前代码已经实现。数据迁移、API、客户端状态机和测试按 [ROADMAP](../../ROADMAP.md) 分阶段实施；完成证据只写入 [PROJECT_STATUS](../../PROJECT_STATUS.md)。
