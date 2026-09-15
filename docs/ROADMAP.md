# Video Flow Preview / Production 职责重整实施计划（权威）

> 更新日期：2026-09-15。产品尚未正式上线，本轮允许替换错误设计，不为未发布的错误接口、节点或状态枚举维持长期兼容。
> 执行方式：使用 superpowers:executing-plans，按 R0–R8 分阶段实现与复核；本文件按项目规则替代技能默认计划目录。计划复选框初始均未完成，实现与测试结果只写入 PROJECT_STATUS。
> 本次为评审归档与计划制定，不代表已执行重构。提交、推送、部署和真实付费验收分别记录。

**目标：** 八类工作流都具备同一画布的无上传 Preview 与正式 Provider Production，费用依据一致，已有任务可独立恢复，各工作流以完整链路验收。
**架构：** 保留 ComfyUI → Backend / PostgreSQL → Worker → Ark / OSS。统一请求合同、预检报告与报价；预检记录独立于正式 Task，Production 节点使用稳定执行槽，正式执行只消费匹配当前内容的有效快照；原任务查询和交付恢复独立于新任务准入。
**技术栈：** 现有 NestJS / TypeScript / Prisma / PostgreSQL，Python Worker，ComfyUI Python / JavaScript，Jest / pytest / 隔离 Fake Provider。
**需求依据：** [职责界定](./2026-09-15/Preview与Production职责界定.md)、[统一需求规范 v2](./requirements/2026-09-15/workflow-preview-production-spec-v2.md)。
**缺口依据：** [2026-09-15 评审快照 F01–F15](./2026-09-15/Preview与Production代码符合性评审.md)。当前事实和证据见 [PROJECT_STATUS](./PROJECT_STATUS.md)。

## 1. 重整原则与范围

### 1.1 保留、替换和不扩大范围

| 处理 | 内容 |
| --- | --- |
| 保留并回归 | 身份鉴权、Actor 所有权、原子预算事务、Task / Attempt / Asset、真实对象哈希、不确定提交日志、Provider ID 恢复、usage 待核查、生成/交付分离 |
| 替换 | 新旧 Preview 两套行为、预检伪装为 Task、固定生成规格兼容回退、开发/启用/验收混用一个状态、正式编译和测试走不同入口、先预检才能恢复旧任务 |
| 收敛 | 共用素材检查、请求构建、报价服务和实际 Worker 编译器；按合同生成所有模板并统一校验 |
| 不新增 | 第二套生成平台、通用工作流引擎、第二套资金台账、大型后台、自动重提付费生成、未鉴权测试执行路径 |

“尚未正式上线”允许进行接口和节点的破坏性调整；不能据此推断没有已有试验任务、资产或费用记录。保护真实数据和用户已有工作区改动，不清库、不改写历史 Provider ID、不重建已有付费任务。

旧协议明确拒绝并提示更新客户端，不在新提交路径中追加固定金额、默认素材、默认模型或绕过预检的兼容分支。已有 Task 的授权查询、下载与核查保留；历史资金证据的解释可保留独立的只读兼容逻辑。

### 1.2 所有阶段共同约束

- 同一画布只显示 Preview / Production 两种模式，新画布默认 Preview；用户切换 Production 后保持该模式，不自动回退，不新增一次性确认系统。
- Preview 只发送参数、元信息和内容哈希；不上传文件、缩略图、Base64 或让服务器拉取素材的 URL。
- Preview 必须经过鉴权与服务器规则检查。无生产权限、暂停、额度不足分别作为准入阻止原因，不能冒充请求格式错误。
- 所有新增正式任务继续检查生产权限、工作流启用、匹配当前内容的有效预检、稳定执行槽、真实素材与预算；模式选择不能替代服务端准入，状态重整不能扩展未鉴权执行路径。
- 预占是内部预算依据，不承诺 Provider 最终账单绝不超过预占。真实用量、usage 推算与账单确认分别记录。
- Preview 金额未知时允许报告；新建 Production 必须获得有依据的预占值，不能回退到假定固定金额。
- 4–30 秒是适用普通生成工作流的目标范围。编辑/延长/自适应规格按官方合同，不把普通时长规则硬套到特殊模式。
- 支持范围、计费像素/FPS、优惠有效期、输入视频最低用量均先核对官方资料。无法取证时记录准确缺项，不伪造默认值。
- 原任务恢复只要求有效身份、任务访问权限和原任务上下文；不重新要求生产白名单、额度、未过期预检或当下价格。凭证失效时仍需重新鉴权，不能匿名取片。
- 同一执行槽的当前视频尚未在客户端完成下载、校验并返回本地路径时，不得新增付费任务；未知提交优先查原任务/证据，交付失败恢复原产物。完成本地交付后的下一次 Queue 才表示顺序生成下一版。
- 测试不得携带真实 Provider 凭证；实际生成验收逐项记录授权范围、估算、任务关联 ID、产物和费用证据。

## 2. 目标职责与合同

以下是待实现合同。接口路径尽量沿用，但旧的冲突语义直接移除；名称和字段在 R0 定稿后由各阶段共同消费。

### 2.1 模块责任

| 单元 | 输入 / 输出 | 明确不承担 |
| --- | --- | --- |
| 本地素材检查 | 实际文件 → 带稳定 slotId 的类型、尺寸、时长、编码、SHA-256 描述 | 上传、生产准入、最终价格 |
| 工作流合同 | workflowKey + model → 官方支持范围、素材组合、参数和 Provider 映射 | 账号权限、余额、历史验收结论 |
| Preview 服务 | 请求 + 当前身份 → 规范化生效请求、逐项检查、报价、当时准入结果、预检记录 | 创建 Task、Attempt 或预算预占 |
| 报价服务 | 已解析规格 + 已检查媒体描述 + 适用价格版本 → 可解释报价及预占依据 | Provider 调用、客户端自报价格 |
| Production 服务 | 有效预检 + executionSlotId + 实际 Asset → 冻结执行快照、Task、预算预占或恢复当前 Task | 猜测素材、改写用户参数、固定金额兜底、同槽并行生成 |
| Worker 编译器 | 冻结快照 + 已解析资源 URL → 经复验的唯一正式 payload | 从提示词猜工作流或读取前端任意 Provider 字段 |
| 任务恢复/交付 | 已有 taskId / 回执 / providerTaskId → 原任务查询、归档与下载 | 新任务报价、重新预检、重复生成 |
| 费用结算 | 原始 usage + 冻结定价快照 → 推算费用或待核查 | 将估算值或刊例价冒充最终官方账单 |

### 2.2 统一请求、预检与报价

在 `packages/backend/src/tasks/workflow-contract.ts` 定义并导出下列待实现类型；媒体角色联合类型覆盖现有五种角色。

```ts
export type MediaRole = 'reference_image' | 'first_frame' | 'last_frame'
  | 'reference_video' | 'reference_audio';
export type MediaDescriptor = {
  slotId: string; role: MediaRole; sha256: string; mimeType: string;
  sizeBytes: number;
  metadata: {
    kind: 'image' | 'video' | 'audio'; width?: number; height?: number;
    durationSeconds?: number; frameRate?: number;
    videoCodec?: string; audioCodec?: string;
  };
};
export type WorkflowIntent = {
  contractVersion: 2; workflowKey: string;
  prompt: { positive: string };
  generation: {
    duration: number; ratio: string; resolution: string;
    generateAudio: boolean; watermark: boolean;
  };
  media: MediaDescriptor[];
};
export type CheckItem = {
  code: string; path: string; status: 'passed' | 'failed' | 'unverified';
  message: string;
};
export type Quote = {
  status: 'estimated' | 'bounded' | 'unavailable'; currency: 'CNY';
  estimatedCny: string | null; reserveCny: string | null;
  pricingVersion: string | null; quoteDigest: string;
  expiresAt: string; basis: Record<string, unknown>; missing: string[];
};
export type PreflightReport = {
  preflightId: string; expiresAt: string;
  requestCheck: { status: 'passed' | 'failed' | 'incomplete'; items: CheckItem[] };
  productionAdmission: { canSubmit: boolean; blockers: CheckItem[] };
  effectiveRequest: WorkflowIntent;
  model: string; workflowVersion: string; contractDigest: string;
  intentDigest: string; quote: Quote;
  willUploadMedia: false; willCallProvider: false;
};
export type ProductionSubmission = {
  preflightId: string;
  executionSlotId: string;
  media: { slotId: string; assetId: string }[];
};
```

模型由服务器工作流配置解析；客户端不提交任意模型、价格或 Provider 字段。有效请求结构之外的字段返回结构化错误；无法形成 effectiveRequest 的畸形请求用 400 返回字段错误，不生成假报告。

- `POST /api/v1/tasks/preflight`：接收 WorkflowIntent，调用统一校验和报价，返回 PreflightReport。
- `GET /api/v1/tasks/preflight/:id/check`：使用同一服务复验记录及当下新任务准入，返回明确的请求有效性、报价有效性和阻止原因，不再只返回模糊 valid。
- `POST /api/v1/tasks`：只承担正式新任务创建；旧 `mode=preview` 请求返回可识别的升级错误，不再创建第二类 Preview Task。
- `GET /api/v1/tasks/:id` 和现有结果下载接口：只读取授权范围内的已有任务，不参与新的生成准入。

新增 `PreflightRecord` 表：id、actorId、createdAt、expiresAt、contractVersion、workflowVersion、contractDigest、intentDigest、quoteDigest、effectiveRequest、report、quoteSnapshot。记录不可被 Worker 领取；不外键创建 Attempt 或预占。

正式请求使用 `preflightId + executionSlotId + media[{slotId, assetId}]` 和幂等键。服务端从预检记录重建执行计划，不再同时信任第二份客户端 Prompt、生成规格、摘要、价格或 Provider 字段。Production 是用户持久选择的界面模式，不是一次性确认实体，也不构成服务端授权。

规则摘要覆盖真实工作流合同内容；报价摘要覆盖解析后的计费输入、单价、最低用量规则、折扣/账户适用条件和生效期。改变会影响执行或金额的内容时旧预检不能创建新 Task；Production 模式下先自动 Preview 并停止，用户再次 Queue 才正式生成。

### 2.3 工作流状态的拆分

- `capability: confirmed | unconfirmed | unsupported`：官方模型合同证据。
- `implementation: incomplete | ready`：端到端代码与合同准备程度。
- `enabled: boolean` 与停用原因：运行准入策略；继续受 Actor 白名单、系统暂停和额度约束。
- 真实验收另存验证记录，包含 workflow/model/参数组合/软件版本/证据；不以一个 production_verified 值代表整个模型和所有规格。

受控首次验收通过同一 Production 服务执行，不能绕过预检、素材验证与预算；不以“必须已经成功生成”作为第一次允许执行的逻辑前提。普通使用和受控验收的允许范围在服务端明确配置，客户端不可自行授予。

### 2.4 单一合同与单一执行路径

新增 `contracts/seedance-workflows.v2.json` 作为可执行能力、角色和参数规则的唯一源，包含合同版本、模型键及证据引用；Backend/Worker 各自读取构建时打包的同一内容。客户端从鉴权目录获取允许选项，用本地规则做提示，最终服务器裁决。

`scripts/sync_workflow_contracts.mjs` 负责将源文件复制到各包资源目录并支持 `--check`；生成资源不手工维护。CI 校验内容摘要一致，容器与客户端安装流程测试确保实际资源存在。

只保留 `providers/seedance_execution_policy.py:compile_seedance_payload` 为 Seedance 正式编译入口；迁移另一编译器中有价值的校验和测试后移除重复规则，不修改无关 MiniMax 功能。

## 3. 分阶段顺序

```text
R0 合同与替换边界
→ R1 统一规则、独立预检记录和报告
→ R2 素材检查与实际内容识别
→ R3 唯一报价与结算依据
→ R4 正式提交、执行槽与执行快照
→ R5 客户端入口、顺序生成与原任务恢复
→ R6 八类工作流逐个贯通
→ R7 跨包回归、清理和交付打包
→ R8 受控真实验收与发布
```

| 阶段 | 核心交付 | 发现覆盖 | 独立出口 |
| --- | --- | --- | --- |
| R0 | 定稿合同、官方证据、旧设计去留清单 | F01、F08、F09、F11、F12 | 每个规则有来源；消费方职责唯一 |
| R1 | 独立 PreflightRecord、统一报告、双结果 | F02、F03、F04、F09、F11 | 不写正式任务或预算，未授权生产也能预检 |
| R2 | 共用图/视频/音频检查，实际格式复验 | F04、F10、F13 | 错类型拒绝，同名文件变化必重检 |
| R3 | 统一报价、预占依据、冻结价格 | F05、F06、F07、F08 | 所有阶段同口径，未知不兜底 |
| R4 | 从预检快照按执行槽正式创建、唯一 Worker 编译 | F07、F09、F11、F12 | 最终请求与有效内容/报价一致，同槽无重复 Task |
| R5 | 共用节点链、持久 Production、回执与按槽恢复 | F01、F03、F10、F14 | 旧任务不被过期预检/新额度卡住，交付后才允许下一版 |
| R6 | 八工作流完整纵向链路和模板 | F05、F10、F11、F12、F15 | 每项有真实 Worker + Fake Provider 合同 |
| R7 | 全量回归、故障矩阵、旧代码移除 | F01–F15 | 包装可安装、旧错误路径不再存在 |
| R8 | 正式接口、实际成片与费用证据 | 全部完成定义 | 每项标明验收覆盖范围，无伪造通过 |

R0–R7 可在不创建真实付费任务的条件下推进。某模型字段暂未取证时记录具体阻碍，继续完成其余独立工作；不把整个工作流永久简化为 Preview。

## 4. 逐阶段实施清单

### R0：定稿合同与替换清单

**文件：** v1.1 完整原文归档，历史路径保留兼容入口；新增当日 v2 规范、官方证据快照和旧设计替换清单并更新索引。更新官方 fixture；新增 `contracts/seedance-workflows.v2.json`。参考既有 `docs/arkdocs/` 与官方原文，不能只复用旧结论。

**输入/输出：** 职责文档和评审 F01–F15 → 第2节类型定稿、官方规则清单和逐文件保留/替换/移除映射。

- [x] 对八工作流逐项核对真实模型 ID、角色/数量/总时长、输出时长与比例、像素/FPS、自适应、音频和容器格式；记录来源、位置与适用版本。
- [x] 核对价格、折扣生效区间、账户价格来源、输入视频最低 Token、completion_tokens 含义，明确估算与最终账单差别。
- [x] 定稿独立预检记录与新任务合同；把四维状态拆分和原任务恢复边界写进新版规范。
- [x] 列明旧节点、旧 Preview endpoint 语义、固定规格配置、重复编译器和相关测试的替换目标；盘点调用者、已有 Task/回执，仅保护数据读取与恢复所需兼容。
- [x] 验收：F01–F15 均映射到一个明确的新责任单元；新增模型字段都有官方证据或明确阻碍；不写虚构 Provider 参数。

### R1：统一规则与独立预检报告

**新增：** `packages/backend/src/tasks/workflow-contract.ts`、`workflow-catalog.service.ts`、`preflight.service.ts`、`preflight.service.spec.ts`，`scripts/sync_workflow_contracts.mjs`；两包合同资源目录。
**修改：** `workflow-registry.ts`、`src/v1/tasks/workflow-preflight.ts`、`v1-tasks.controller.ts`、相关 module、`prisma/schema.prisma`。
**迁移：** 新增独立 Prisma migration 建 PreflightRecord；既有 Preview Task 只保留历史查询，不自动转成新版本有效凭证。不重写已执行 migration。

**接口：** `PreflightService.preview(actorId, intent): Promise<PreflightReport>`、`PreflightService.check(actorId, preflightId): Promise<PreflightReport>` 共用规则解析。报价先允许 unavailable，R3 接入真实算法，不填固定数值。

- [x] 在 `preflight.service.spec.ts` 先覆盖：无生产权限/系统暂停/额度不足仍返回请求检查结果及明确 blockers；鉴权失败仍拒绝。
- [x] 实现唯一 effectiveRequest，角色与 metadata.kind/MIME 交叉校验，错误带具体 path，工作流规则摘要和版本写入记录。
- [x] 用事务测试验证 Preview 只创建 PreflightRecord，Task/Attempt/Reservation 数量不变；Worker 无法领取记录。
- [x] 目录返回同一版本的角色、参数选项、能力/实现/启用及原因；旧 preview task 创建语义明确拒绝。
- [x] 在隔离数据库验证全新安装与有历史 Task 的增量迁移；回滚暂停新提交，保留新表和历史记录，不破坏已发生任务。
- [x] 验收：结构、权限报告与无副作用合同通过，生成资源摘要一致。

示例目标断言：
```ts
expect(report.requestCheck.status).toBe('passed');
expect(report.productionAdmission.canSubmit).toBe(false);
expect(report.productionAdmission.blockers.map(x => x.code))
  .toContain('PRODUCTION_NOT_ALLOWED');
expect(report.willUploadMedia).toBe(false);
expect(report.willCallProvider).toBe(false);
```

运行：Backend `npx jest preflight.service workflow-preflight workflow-registry --runInBand`；仓库根 `node scripts/sync_workflow_contracts.mjs --check`（脚本实现后）。

### R2：本地与服务端素材识别

**新增：** `packages/comfyui-video-flow-client/media_inspection.py`、`tests/test_media_inspection.py`。
**修改：** 客户端 `preflight_nodes.py`、`install.sh`、`requirements.txt`；Backend `assets/media-inspector.service.ts`、`media-policy.ts`、`src/v1/assets/v1-assets.controller.ts` 与对应 spec。

**接口：** 客户端 `inspect_media(path, role, slot_id)` 返回本地读取句柄和 MediaDescriptor；上传前再次读取并核对同一内容。服务端 `MediaInspectorService.inspect` 从实际格式/解码信息识别，expectedMime 只作为一致性约束。

- [x] 先覆盖真实 PNG/JPEG/WebP、MP4/MOV、WAV/MP3、损坏文件、扩展名/MIME伪装、角色错配、边界与总时长；不只注入可信 metadata。
- [x] 共用本地检查器，首帧、首尾帧、多参考全部检测同名文件内容变化；检测依赖缺失必须明确报错。
- [x] 服务器按容器/编码识别真实媒体类型；保留实际流式哈希和归属校验；支持合法复用已有 Asset。
- [x] 客户端与服务端对元信息格式和精度采用统一规范，避免视频浮点时长/帧率序列化差异导致合法素材无法匹配预检；哈希仍精确匹配。
- [x] 验收：视频伪装图片不能上传完成或正式提交；合法图/音/视频检查前后一致；Preview 全程无素材出站。R2 时正式新建入口仍关闭；R4 开放时必须追加 `slotId → verified Asset` 的正式提交合同，Worker 只消费冻结快照，不复制媒体识别规则。

运行：Backend `npx jest media-inspector media-policy v1-assets --runInBand`；客户端 `.venv/bin/python -m pytest tests/test_media_inspection.py tests/test_preflight_nodes.py -q`。

### R3：统一报价、预占与冻结定价

**新增：** `packages/backend/src/tasks/task-quote.service.ts`、`task-quote.service.spec.ts`、`pricing-catalog.ts`。
**修改：** `task-cost.ts`、`task-cost.spec.ts`、`preflight.service.ts`、`production-spec.ts`、`task-budget.service.ts`、`executions/executions.service.ts`、`.env.example`。

**接口：** `TaskQuoteService.quote(effectiveRequest, model, now): Quote`；`interpretUsage(usage, executionPlan)` 从冻结的 pricingSnapshot 解释新任务。旧 pricingVersion 解释仅用于已有历史任务。

- [x] 将 F05–F08 固化为回归：2秒/30秒输入、多个视频、不同分辨率/比例、adaptive、编辑-1、最低用量、折扣跨期、账户价、未知模型及未知报价。
- [x] 用已取证的输出尺寸/FPS映射和输入视频真实时长计算；特殊时长无法确定时使用已取证上界形成 bounded 报价，无依据则 unavailable。
- [x] 报价 basis 保存实际计算因子、最低用量、单价与适用条件，金额采用 Decimal；不硬编码“有视频就30秒”，不保留 reserveCny 固定回退。
- [x] 将历史 `Task.cost` 与 `ExecutionAttempt` 三个浮点金额列迁移为 `Decimal(18,6)`；空库和模拟历史库均验证迁移，有限旧值按数据库实际值保留，非有限值 fail-closed 要求人工处理。
- [x] Preview / check 共用 Quote；`TaskQuoteService` 是 R4 submit 必须消费的唯一入口。报价过期、规则变化或实际素材不匹配时要求刷新预检，不静默更价；Production 模式下本次 Queue 只 Preview 并停止。当前 submit 仍关闭，不能据此称已贯通 Production。
- [x] 定义并验证完整 pricingSnapshot 及 completion_tokens 解释；未知 usage 保留核查，价格配置更新不改变冻结单价。R4 创建 executionPlan 时必须原样固化该快照。
- [x] 新 v2 路径不依赖旧固定 duration/ratio/resolution/reserveCny；声音/水印等生效参数进入统一请求，模型和价格选择由服务器控制。旧配置只保留历史任务/旧测试迁移，R7 再移除被替代执行分支。
- [x] 验收：Preview/check 的有效 quoteDigest 与 reserveCny 一致；R4 尚待证明 executionPlan 原样消费。无法估算不会显示2元/0元；估算、预占、usage推算与账单状态明确分开。

目标不变量：
```ts
expect(checkReport.quote.quoteDigest).toBe(previewReport.quote.quoteDigest);
expect(executionPlan.reserveCny).toBe(previewReport.quote.reserveCny);
expect(unknownQuote.reserveCny).toBeNull();
expect(unknownQuote.status).toBe('unavailable');
```

运行：Backend `npx jest task-quote task-cost task-budget executions --runInBand`。

### R4：正式提交、执行槽与唯一 Worker 编译器

**新增：** `packages/backend/src/tasks/production-submission.service.ts`、`production-submission.service.spec.ts`。
**修改：** `src/v1/tasks/v1-tasks.controller.ts`、`dto/create-task.dto.ts`、`task-budget.service.ts`；Worker `models.py`、`executor.py`、`providers/seedance_execution_policy.py`、相关 tests。
**移除目标：** 将 `providers/seedance_compiler.py` 的有效规则/测试迁入唯一入口后移除重复入口；先确认所有调用方，不波及其他 Provider。

**接口：** `ProductionSubmissionService.submit(actorId: string, idempotencyKey: string, request: ProductionSubmission)` 从 PreflightRecord 构建执行快照。Task 新增 `executionSlotId`、`slotSequence`、`preflightId`、三个摘要、`clientRequestId`、`clientDeliveryStatus` 和 `clientDeliveredAt`；不新增 ExecutionSlot 表。Worker `compile_seedance_payload(params)` 校验快照合同摘要、model/workflow、角色和所有规格后构建正式请求。

- [x] 覆盖缺少执行槽、预检过期、跨账号、摘要变化、未知价格、实际 Asset 不符的拒绝；合法请求一次 Task、一次预占，同键同请求返回原任务。
- [x] 在事务或等效串行化边界内按 `actorId + executionSlotId` 检查当前 Task；同槽并发提交返回同一 Task，只有上一 Task 已完成本地交付或已确认无结果终止时才创建下一序号。
- [x] 增加有鉴权和 Task 所有权检查的 client delivery 确认接口；只有产物已就绪的 Task 可以确认，重复确认幂等，不接受客户端用该接口改变 Provider、归档或费用状态。
- [x] 上传前检查和最终事务复验都调用统一服务；昂贵对象检查后再次验证预检与报价有效期，事务里检查最新权限/暂停/额度。
- [x] 收敛 Controller 为接口适配；正式请求中的素材按 slotId 绑定预检项，不按不可信顺序猜测，不接受客户端价格或任意 Provider 字段。
- [x] Worker实际编译入口覆盖模型对应边界4/30和非法3/31；编辑/延长按各自合同；编译失败在调用 Provider 前结束并如实处理未发生调用的预算状态。
- [x] 将完整目录 `catalogDigest` 与冻结执行规则 `contractDigest` 分离；准入、实现、验收和价格状态变化不使已创建 Task 失效，真实执行规则变化仍会改变摘要。
- [x] 移除 Backend/Worker 生产源码中的 ready-workflow 测试环境变量；服务测试使用测试专用 Catalog fixture，真实 Nest 合同只在测试 bootstrap 中替换依赖。
- [x] Worker 对已创建 Task 只验证冻结执行摘要、模型、工作流能力和参数，不以当前 `implementation/admission` 或最新目录 revision 阻断执行；全局暂停仍阻止 pending Task 新增付费提交，submitted/running/archiving 继续恢复。
- [ ] 首次改变执行规则前，把旧 `contractDigest` 对应的 Worker 合同资源纳入版本注册并保留到旧 Task 排空；当前尚未上线且没有旧 v2 正式 Task，本轮只建立摘要分层和保留门禁。
- [x] 保留已有 providerTaskId 优先恢复、响应不确定停查、应急日志与回写证据；不因旧任务缺新合同版本重新生成。
- [x] 验收：Fake Provider 观察的 payload 与冻结有效请求一致；拒绝场景 Provider create=0。

运行：Backend `npx jest production-submission v1-tasks task-budget --runInBand`；Worker `venv/bin/python -m pytest tests/test_seedance_execution_policy.py tests/test_job_params.py tests/test_provider_submission_recovery.py -q`。

### R5：统一客户端入口、顺序生成与原任务恢复

**新增：** `packages/comfyui-video-flow-client/execution_slot.py`、`submission_state.py`、`tests/test_execution_slot.py`、`tests/test_submission_state.py`。
**修改：** `preflight_nodes.py`、`nodes.py`、`client.py`、`receipts.py`、`web/preflight_report.js`、安装脚本和模板。
**移除目标：** 旧上传式 Preview、旧无预检 Production、固定规格 OneClick 及重复模板不再注册/交付；保留 Config、授权查询和下载能力。旧图提示重新导入，不能悄悄变成另一种付费行为。

**接口：** 共用状态流 `resolve_slot → recover_current → preview_if_required → submit_next → wait → download_and_finish_round`。Backend 按 actor 与槽返回权威当前 Task；客户端回执只缓存槽、Task、本地交付状态和本地路径。当前 Task 未完成本地交付时先恢复；槽空闲且当前内容缺少有效预检时，本次 Queue 只 Preview 并停止；再次 Queue 才上传和提交。

- [x] 覆盖已有taskId且预检过期/额度不足/生产暂停时仍可查询取片；凭证失效或任务越权仍拒绝；Provider create增量为0。
- [x] Production 节点首次创建稳定 `executionSlotId`，修改内容不改变槽，复制节点生成新槽；同一槽不支持并行生成。
- [x] 本地回执保存执行槽、原请求、幂等键、任务标识、本地交付状态、路径和文件摘要，查询身份仍按账号隔离；回执丢失或更换客户端后可从 Backend 按槽恢复。
- [x] Production 模式保持不变；当前内容无有效预检时第一次 Queue 只 Preview 并停止。有效预检可用于多个顺序 Task，不新增一次性确认状态。
- [x] Provider 成功但归档、签名 URL、下载、本地校验或 client delivery 确认失败时继续原 Task；客户端下载校验后先持久化回执，再确认交付并返回本地路径，下一次 Queue 创建新 Task 并独立计费。
- [x] 报告展示唯一 effectiveRequest、逐项错误、实际文件未上传状态、报价依据和canSubmit/blockers；失败清除旧绿色提示。
- [x] 统一执行入口先处理已有任务，再要求新预检；同时交付凭taskId查询/取片的恢复模板。
- [x] 自动化验收：所有仍注册的 Preview 节点均无上传；同槽在本地交付前最多一个 Task；暂停不阻断已有任务恢复；交付后的下一次 Queue 能顺序创建下一版。实际 ComfyUI 导入、状态渲染和 Queue Prompt 仍属于发布前操作验收，不由单测替代。

运行：客户端 `.venv/bin/python -m pytest -q`；报告前端状态定向测试为 `.venv/bin/python -m pytest tests/test_preflight_report_web.py -q`。

### R6：八类工作流逐项贯通

**修改：** 合同清单、共用客户端/Backend/Worker模块、`packages/worker/tests/fixtures/seedance_2_5_official_modes.json`、`tests/test_seedance_execution_policy.py`、`tests/test_mvp_live_contract.py`。
**新增：** `packages/comfyui-video-flow-client/tests/test_workflow_templates.py`，编辑/延长/音频参考及恢复模板；现有5份新模板按同一构建规则重整。

**输入/输出：** R0–R5 共用合同与执行链 → 每个工作流完整 Preview、正式 payload、预算与交付合同。不得为每种工作流再复制一套报价或提交逻辑。

| 顺序 | workflowKey | 特有验收 |
| --- | --- | --- |
| 1 | seedance.reference-image-to-video.v1 | 单参考图；4/30秒、标准比例/分辨率覆盖 |
| 2 | seedance.text-to-video.v1 | 无媒体、不假造Asset；修复文本模板连线；正式编译和提交 |
| 3 | seedance.first-frame-to-video.v1 | first_frame角色；自适应解析、计费和同名文件刷新 |
| 4 | seedance.first-last-frame-to-video.v1 | 两帧角色顺序、尺寸组合、自适应计费 |
| 5 | seedance.omni-reference.v1 | 图片/视频/音频可链式组合；覆盖30图、10视频、10音频、总数50、各类总时长及最低Token |
| 6 | seedance.video-edit.v1 | 编辑语义、特殊时长、容器格式、实际输入成本 |
| 7 | seedance.video-extend.v1 | 延长方向/时长语义、输出规格与成本上界 |
| 8 | seedance.audio-reference-to-video.v1 | 纯音频/允许组合的官方合同、音频检查和正式编译 |

逐项完成记录（每项都执行下方流程，不能因共用模块通过就批量勾选）：

- [x] R6.1 参考图片。已在真实 Comfy Desktop 中完成本地 WebP 的零上传 Preview、再次 Queue 的 Production、Fake OSS 实际内容复验、Fake Provider 单次 `reference_image` create、归档、客户端落盘与实际播放；真实 Ark 出片仍归 R8。补测：用 `scripts/comfyui_acceptance_evidence.py` 在每次 Queue 前后采集计数器快照，**隔离证明** Preview 对 Task / Attempt / 预算预占 / Asset / Provider create 的增量全为 0（`PreflightRecord` 恰好 +1，是报告与 Production 的凭据），并在同一执行槽中已交付的序号 1 之上实际创建了序号 2。
- [x] R6.2 文本生视频。已在真实 Comfy Desktop 中完成默认 Preview、再次 Queue 的 Production、Fake Provider 单次 create、Fake OSS 归档、客户端落盘与实际播放；真实 Ark 出片仍归 R8。
- [x] R6.3 首帧。已在真实 Comfy Desktop 中完成本机 WebP 的零上传 Preview、再次 Queue 的 Production、Fake OSS 实际内容复验、Fake Provider 单次 `first_frame` create、归档、客户端落盘与实际播放；请求保持 `ratio=adaptive`，真实 Ark 出片仍归 R8。
- [x] R6.4 首尾帧。真实 ComfyUI 导入并 Queue：Preview 用两张内容与哈希均不同的图片（`003bottle-rotate.webp` 769×1163 与 `bottle-press.webp` 710×1065）生成 `first_frame`/`last_frame` 两个角色，Q1 隔离证明零增量。Production 的 Provider payload 保持两个**不同 URL**、同样的角色顺序，预占 7.607670 结算 0.070000，产物落盘且 `ffprobe` 可解析。真实 Ark 出片仍归 R8。
- [x] R6.5 多模态参考。此前因输入视频最低 Token 未取证而只能 fail-closed；取得并验证规则后（见 PROJECT_STATUS）真实 ComfyUI 的图片+视频+音频链已跑通：Preview `canSubmit=true`、报价 `estimated 15.392202`（`billedTokens=max(366481, 194400)`），Production 的 payload 为 `image_url/reference_image + video_url/reference_video + audio_url/reference_audio`，预占 15.392202 结算 0.042000，交付 ready 且落盘可播放。
- [x] R6.6 视频编辑。真实 ComfyUI 导入并 Queue：Preview 完整保留 `duration=-1 / adaptive / mov`，输出时长由唯一参考视频解析为 11.966667 秒，报价 `estimated 21.712362`。Production 的 Provider payload 保持 `-1/adaptive/mov`，**归档为 `result.mov` 且 Asset 登记 `video/quicktime`**（不再一律写成 MP4），预占 21.712362 结算 0.042000，交付 ready。
- [x] R6.7 视频延长。真实 ComfyUI 导入并 Queue：三段内容、哈希均不同且总时长 27.008334 秒（≤30）的参考视频按链顺序绑定到 `reference-video-1/2/3`，Preview 报价 `estimated 34.481202`。Production 冻结 `duration=11 / adaptive / mov / omni_reference_task_type=extend`，payload 含三段 `video_url`，归档 MOV 并登记 `video/quicktime`，交付 ready。
- [x] R6.8 音频参考。真实 ComfyUI 导入并 Queue：两段不同音频（5 秒与 7 秒，总 12 秒）链式输入，Preview 报价 `estimated 7.560000` 且 `minimumTokens` 为 null（无输入视频时最低用量规则不适用，`billedTokens` 等于公式值 108000）。Production 冻结 `omni_reference_task_type=reference`，payload 含两段 `audio_url/reference_audio`，预占 7.560000 结算 0.070000，交付 ready 且可在 ComfyUI 播放。

每一行依次执行：

- [ ] 以本行官方fixture定义合法与非法请求，先在真实编译/执行调用路径复现失败。
- [ ] 完成本地输入 → Preview → Production Queue → Asset → Task/预占 → Worker → Fake Provider → 交付/usage全链；若有外部能力缺项，记录具体字段/证据，继续其他工作流。
- [ ] 每份模板双向校验 inputs/outputs/global links、类型、默认模式和输出节点可达性；实际导入后运行 Preview。
- [ ] 按实际产物格式保存正确扩展名/MIME，支持该工作流要求的MOV等格式，不把所有结果仅重命名为MP4。
- [ ] 验收：逐行记录隔离合同证据；真实模型效果与正式出片留到R8，不能用状态枚举替代实现。

运行：客户端 `.venv/bin/python -m pytest tests/test_workflow_templates.py -q`；Worker `venv/bin/python -m pytest tests/test_seedance_execution_policy.py -q`；仓库根运行第5节隔离合同。逐工作流开发期间可显式设置 `VIDEO_FLOW_SKIP_LEGACY_CONTRACT_SUITES=1`、`VIDEO_FLOW_LIVE_PYTEST_TARGET=<单项节点>` 和 `VIDEO_FLOW_LIVE_MIN_TESTS=1` 运行新纵向合同；默认值不得跳过旧完整套件，R7 必须恢复完整绿色。

### R7：全链回归、安装清理与旧路径退出

**修改：** `scripts/run_mvp_contract.sh`、`scripts/tests/fake_provider.py`、`.github/workflows/ci.yml`、两端Docker构建文件、客户端 `install.sh` / `tests/test_delivery_scripts.py`、各包README和runbooks。
**接口：** 隔离合同必须进入真实Controller/Guard、数据库、Worker实际编译器和Fake Provider；按意图记录create计数。

- [x] 将F01–F15全部纳入持久用例；测试名称和断言对应职责，不再为旧错误行为保绿。
- [x] 实现并运行第5节故障矩阵；Preview对Task/Attempt/Reservation/素材上传/Provider调用的增量全部为0。
- [x] 全新安装和升级已有测试库两条迁移测试通过；历史Task/Provider ID/产物/预算可查询并可恢复，未执行迁移不能伪报通过。
- [x] 打包合同资源、所有模板和素材探测依赖；清理本插件旧注册/旧文件时先备份，只操作经确认属于本插件的文件。
- [x] 对旧接口/配置/节点/编译器进行引用搜索，删除已被替代的执行分支与维护错误语义的测试；使用Git/归档保留历史，不运行两套新提交合同。
- [x] 三包完整回归、隔离跨包和实际ComfyUI假服务验证通过；更新runbook中的协议升级与恢复说明。真实 ComfyUI 操作验收当前覆盖文生视频、参考图和首帧，其余 5 类由 R6 逐项完成。
- [x] 验收：F01–F15各有关闭证据；外部依赖skip与未执行的验收明确列出，不能计为已完成。

当前操作验收进度：`scripts/comfyui_acceptance_env.py` 的 loopback-only 持久环境已完成**全部 8 类工作流**的真实 ComfyUI Queue，其中 R6.1、R6.4、R6.5、R6.6、R6.7、R6.8 六项另有 `scripts/comfyui_acceptance_evidence.py` 的每次 Queue 前后计数器快照断言（Preview 零增量、Production 恰好一次）。文生视频与首帧两项的 Preview 零增量尚未以同样方式隔离复现。测试固定夹只能证明链路可播放，不能替代 R8 的 Ark 真实时长、画质、费用和创意验收；源合同仍保持八类 `implementation=incomplete / admission.enabled=false`。

### R8：受控正式验收与发布

**修改：** `scripts/seedance_production_acceptance.py`、相关测试、`docs/runbooks/deploy-and-rollback.md`、`creative-user-guide.md`；证据只更新PROJECT_STATUS。
**前提：** R7具备交付证据；正式环境和付费任务在明确的账号、素材、规格与金额范围内执行。本轮规划不自动创建这些任务。

- [x] 先备齐只读查询/按槽恢复/下一版创建/预算校验/证据导出的验收脚本，默认查询已有任务，不默认新建。`scripts/seedance_production_acceptance.py` 提供 `query` / `slot` / `budget` / `verify` / `evidence` 五个只读子命令与一个会付费的 `next`；判定要求产物真的下载并 `ffprobe` 解码通过，且扩展名/MIME 与冻结的 `outputFormat` 一致，不看单一状态字段。`next` 需同时具备 `--confirm-spend`、操作者自备的稳定幂等键和素材 slot 绑定，槽内还有未交付任务时拒绝执行。用法见 `docs/runbooks/deploy-and-rollback.md` §6.3。
- [ ] 配套升级Backend、Worker、客户端和合同版本；记录数据库备份、迁移、健康、鉴权和资源打包情况。
- [ ] 按R6八行逐项执行正式接口验收：真实taskId/attemptId/providerTaskId、冻结参数、原始usage、费用状态、产物、媒体探测和实际播放。
- [ ] 对适用4–30秒的工作流，4秒和30秒边界有自动化证据；真实验收明确记录实际测试时长、比例和分辨率，不能把一次5秒样片宣称为全规格已验证。
- [ ] 验证原任务重取、交付失败恢复和Provider ID持久化后的Worker恢复，不以重新生成掩盖失败。
- [ ] 记录每个工作流的验收覆盖与缺口，逐项完成；官方不支持的明确组合记录证据并收敛产品范围，不能编造支持。
- [ ] 完成下述运行准备，再按确定范围正式开放。失败时暂停新生成，保留已发生任务与费用证据。

## 5. 故障矩阵与验证命令

| 场景 | 必须断言 |
| --- | --- |
| 默认导入/Preview/权限不足/暂停/额度不足 | 不上传、不建正式Task/Attempt/预占、不调用生成Provider；报告区分请求与准入 |
| 内容变化、同名文件覆盖、跨账号、错误角色/真实类型 | 旧预检不授权新内容，实际文件校验不能被声明值绕过 |
| Production 内容无有效预检 | 第一次 Queue 只 Preview 并停止；第二次 Queue 才可上传、建 Task 和预占 |
| 报价过期、价格跨期、输入视频/最低用量、未知规格 | 三阶段口径一致；未知无固定兜底；变化后先重新 Preview |
| 同一执行槽并发 Queue、两个槽抢最后预算 | 同槽返回同一 Task/预占；不同槽余额竞争不超额 |
| 当前 Task 在途时内容变化或本地回执丢失 | 按 actor+slot 恢复原 Task，不提交新内容，不增加 Provider create |
| Provider受理后响应丢失、缺ID、ID回写失败 | 不自动二次create；保存原任务或待核查证据 |
| Worker在已保存Provider ID后重启 | 恢复同一ID，create总数不增加 |
| usage缺失/非法/冲突 | 不报0元，不按估算结算，保留核查；不覆盖既有资金事实 |
| Provider成功、下载/OSS/Asset/回写失败 | 费用证据保留，交付不假报ready；恢复原产物 |
| 本地校验成功但 client delivery 确认失败 | 本地回执已持久化，槽仍锁定；重试确认并返回同一文件，不新建 Task |
| 节点成功返回本地路径后的下一次 Queue | 同槽创建下一序号 Task，独立预占计费；仍有效的同内容预检可复用 |
| 预检过期/系统暂停/额度不足后的取片 | 有效身份和所有权通过后仅查询原任务，不要求新生成准入 |
| 客户端退出、签名过期、自定义output、旧回执恢复 | 原意图/原taskId、重新签发取片、文件可播放 |
| 八种模板/所有注册节点 | 双向连线正确、默认Preview、无旧上传式Preview |
| 规则版本/资源打包不一致 | 新提交明确拒绝升级不匹配；既有任务恢复仍按原快照处理 |

每阶段先运行针对本阶段的测试。阶段交付和提交前执行三包必需回归；有执行链或资金变更时必须跑隔离跨包合同。

```bash
# packages/backend
npm run build
npx jest --runInBand
node test/preflight-http.smoke.cjs

# packages/worker
venv/bin/python -m pytest -q

# packages/comfyui-video-flow-client
.venv/bin/python -m pytest -q

# 仓库根
node scripts/sync_workflow_contracts.mjs --check
VIDEO_FLOW_CONTRACT_DB_PORT=55433 VIDEO_FLOW_CONTRACT_PROVIDER_PORT=19092 bash scripts/run_mvp_contract.sh
git diff --check
```

新脚本在相应阶段实现后运行。首次先审查合同脚本的隔离配置；禁止因网络或数据库不可用把应执行用例改成skip。客户端使用自己的依赖环境。

## 6. 运行准备、回退与完成记录

旧计划中仍必要的运行事项保留：

- [x] 核实持久journal、日志轮换与容器重建后证据可恢复；不删除未归档产物或未结案资金记录。`scripts/run_container_evidence_recovery.sh` 用真实 worker 镜像跨**不同容器**（每次 `docker run` 都是新容器）写入再读回：命名卷里的审计事件、submission journal 与产物均可恢复且内容一致；`AuditLog.rotate()` 只清理过期的 `events-*.jsonl`，`submissions.jsonl` 与 `SUBMISSIONS_BLOCKED` 保留。E12 的跨包用例（已解除 skip 并实跑通过）同时证明 Worker 重启后恢复**不会**产生第二次 Provider create。**未在本机核实**：`json-file` 日志驱动配置了 `max-size=10m / max-file=3`，但 Docker Desktop 的日志落在虚拟机内部，实际轮转是否发生无法在宿主机观察；该项留待真实宿主核实。
- [x] 验证隔离数据库备份恢复。`scripts/run_db_backup_restore.sh` 将源库 `pg_dump` 后恢复到全新隔离库，逐表比对**行数与内容指纹**（金额按 `::text` 精确比对以捕捉 Decimal 精度变化，jsonb 取 `md5`，并含 `_prisma_migrations`）；已用"只改一个任务的 `cost` 加 1e-6"的负向实验确认该指纹能抓住单纯比对行数会漏掉的差异。
- [ ] 监测巡检与备份自身失效、整机不可用（需要真实宿主、告警渠道与持续运行时间，本机无法验证）。
- [ ] 告警责任人与渠道具备真实接收回执；覆盖requires_review、费用未知、交付失败、磁盘压力和进程失活。
- [x] 暂停只停止新生成；已有Provider任务查询和归档继续。两个方向都有跨包用例：`test_pausing_the_gate_blocks_new_admission_only` 断言暂停下正式提交返回 **503**（与额度类的 429 可区分）、Provider create 不变，且 Preview 仍走独立预检入口；新增的 `test_pausing_the_gate_does_not_strand_an_in_flight_provider_task` 让 Provider 先停在"已受理未完成"制造真实在途窗口，暂停闸门后再让它完成，断言 Worker 仍把在途任务轮询并归档到 `delivery ready`，且**不产生第二次 Provider create**——否则故障期间一暂停，已付费的在途任务就拿不回产物了。
- [ ] 应用回滚不是撤销 Provider 任务（部署语义，需要一次真实回滚演练，本机无可验证替身）。
- [ ] 破坏性协议切换采用配套升级；保留上一可用客户端/镜像与数据库备份，不通过回退到绕过预检/预算的版本恢复新提交。

每阶段记录：变更文件、移除的旧设计、测试命令/退出码、合同与实际验收范围、遗留项；发布状态分别记录为本地、提交、推送、部署、真实验收。不为提前存在的测试绿勾选本轮任务。

**最终完成线：** 所有纳入范围且官方支持的工作流均具备两种模式及对应证据；不允许用“仅Preview”“只有模板”“编译函数单测通过”代替Production完成。

## 7. 历史计划与任务映射

原计划保存在 [重整前ROADMAP快照](./archive/2026-09-15-roadmap-before-responsibility-reset.md)；原Preview目录扩展计划保存在 [扩展计划快照](./archive/2026-09-15-seedance-workflow-expansion-superseded.md)。两份均已被本计划取代，不继续维护其复选框。

| 原任务 | 本轮对应位置 |
| --- | --- |
| T00、T11 测试与交付包 | R7 |
| T01 固定规格/输入 | R0、R1、R2、R4；废止固定规格作为产品范围 |
| T02、T05 预算与结算 | 保留基础，R3/R4复核 |
| T03、T04、T06 恢复与交付 | 保留基础，R4/R5/R7复核 |
| T07、T08 回执/模板 | R5、R6 |
| T09、T10 日志/监控 | 第6节；不因职责重整丢弃 |
| T12 发布验收 | R8 |
| W1、W2、W3、W4、W5、W6 | 分别由R0、R2、R1/R4、R4/R6、R5/R6、R8接续 |

<a id="10-seedance-25-工作流目录扩展计划2026-09-14"></a>
<a id="W3registry-与-generation-policy"></a>
旧文档的上述锚点保留供追溯，指向历史计划映射，不代表沿用旧状态或固定规格规则。

## 8. 修订记录

- 2026-09-15：根据职责讨论与F01–F15评审替换旧路线图。允许在正式上线前替换错误设计；从固定参考图/Preview扩展目标调整为八工作流完整开发。实施计划仍仅在本文件维护，分析与评审按日期归档。
