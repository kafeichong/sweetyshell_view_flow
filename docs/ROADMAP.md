# Video Flow 快速 MVP 路线图（权威）

> 最后更新：2026-09-11。本轮为分析后的建议规划，不授权部署、开放白名单或付费生成。
> 实施时必须使用 superpowers:executing-plans 分批执行与复核；本文件按项目规则替代技能默认计划目录。所有复选框初始为未完成，不授权自动部署或付费。
> 现状与证据只见 [PROJECT_STATUS.md](./PROJECT_STATUS.md)，尤其第 0 节与风险登记册。

**目标：** 一位创意人员在自己的 ComfyUI 中，使用公司授权素材，独立完成一次真实生成，得到可播放的视频；遇到故障能凭 taskId 查清阶段、费用状态并继续处理。
**架构：** 保留 ComfyUI 客户端 → Backend / PostgreSQL → 单 Worker → Ark / OSS。数据库保存执行与资金事实，持久日志补充过程；不为 MVP 建完整运营后台。
**技术栈：** 现有 NestJS / Prisma / PostgreSQL、Python Worker、ComfyUI 客户端。
**Spec / 需求依据：** 本文第 1–4 节的 MVP 范围与不变量，以及 [PROJECT_STATUS.md](./PROJECT_STATUS.md) 的缺口证据。创意人员真实出片是最低交付线；不把 Preview、模拟调用或本地单测当作交付。

## 1. 范围与取舍

建议第一版只覆盖：

- 1 位具名创意人员、1 个独立可撤销凭证；验证稳定后再扩到 2–3 人。
- 1 个审核过的商品图片 + Prompt → 1 段视频；一个经当前模型核实的固定生成规格。建议从 5 秒、一个比例开始；分辨率、音频等必须显式固定并记录，不能由客户端自由覆盖。
- 同一份工作流完成上传、提交、等待、下载；另交付“凭 taskId 继续查询/取片”的工作流。
- 同参数“再生成一版”是明确的新付费意图；网络重试、继续等待、重复下载沿用原任务，不产生新意图。
- 正常出片无需研发操作；异常允许管理员介入，但用户能看见 taskId、失败阶段和下一步。
- 视频保存到用户实际 ComfyUI output，并明确显示文件位置、可用播放器打开。原生画布视频播放器不是首版硬门槛。

不作为首版门槛：多 Provider、多 Worker、批量生成、全量本地 ComfyUI 节点审计、独立设备管理表、TaskEvent 平台、Grafana、大型管理后台、自动账单同步、自动重新生成、三条付费样片的数量指标。

这意味着首版是**小范围、有运营支持的真实工具**，不是无人值守的全面生产平台。模板范围外的自由实验暂不开放。

## 2. 能承诺什么，不能承诺什么

| 类别 | MVP 对外口径 | 验证或替代方式 |
| --- | --- | --- |
| 我们可以实现并验收 | 身份鉴权、输入归属、固定规格、任务幂等、额度准入、状态查询、归档下载、关联记录 | 自动测试 + 真实接口契约 + 同事实际出片 |
| 依赖 Provider 真实返回 | 是否受理、任务 ID、运行/成功/失败、输出视频、usage（若返回） | 保存真实响应中的必要字段；没有就标缺失，不填 0 或编造成功 |
| 提交前只能作预算依据 | 预计费用、预计等待时间 | 记录估算算法/价格版本/规格；明确不是最终账单、不是完成时间承诺 |
| 不能凭当前证据保证 | 精确进度百分比、提交前精确最终账单、所有状态可免费取消、跨网络边界的绝对 exactly-once | 不把这些作为首版依赖；不确定提交停在 requires_review，人工核实后再处理 |
| 必须看成片 | 产品一致性、动作、画质、创意是否满意 | 技术验收检查文件真实可播；创意人员另判断可用/需再创作 |

外部能力核实依据见 [PROJECT_STATUS.md 的外部能力边界](./PROJECT_STATUS.md#外部能力与本地实现不能混为一谈)。官方 SDK 有某字段不等于当前账号/模型已验收；当前 adapter 没接入也不等于平台做不到。

**额度口径：** 预占预算 + 固定规格 + 次数/并发上限可以限制风险，但不能伪装成 Provider 最终扣费的绝对硬上限。若当前规格无法得到可信预算依据，不开放自助 Production；先补报价依据或由 Steven 明确批准单次人工试验范围。

## 3. 最小记录与追溯

“没有独立业务表”可以接受，“发生过但找不到任何证据”不可接受。关键执行/资金状态不能只放日志。

| 数据 | MVP 保存位置 | 最低要求 |
| --- | --- | --- |
| 谁发起、生成意图、请求内容 | Task + requestSnapshot | actorId、clientRequestId、输入 assetId/hash、Prompt、规格与归一化参数；同一意图快照稳定 |
| 哪次调用、实际用了什么 | ExecutionAttempt | attemptId、Provider、有效 model、providerTaskId、提交/终态时间、失败原因 |
| 费用与额度 | Attempt + 最小额度预占记录 | estimate、原始 usage、usage 推算、账单确认分开；预占与结算幂等；未知费用保留未知状态 |
| 输出在哪里 | Asset | taskId/attemptId/ownerId、永久 objectKey、类型、大小；可补 hash 作完整性校验，不保存过期下载链接作为身份 |
| 从哪个客户端/模板来 | 请求元数据 + 本地回执 | 客户端版本、模板版本/hash、自报设备别名；不采集硬件指纹，也不声称是可信设备认证 |
| 中间发生过什么 | 服务器持久化结构化日志 | UTC 时间、taskId/attemptId/providerTaskId、阶段、错误码、请求关联 ID；状态回写失败也留证据 |
| 用户拿到什么 | 本地 task 回执文件 | taskId、模板/客户端版本、生成意图、最终路径、文件大小/hash、下载时间；不含凭证 |
| 人工做过什么 | 受限 incident 记录，按 taskId 检索 | 操作人、时间、原因、查询证据、动作与结果；未知扣费核实后才允许结算/释放预算 |

模板 hash 只证明已提交模板的版本，不证明用户所有本地节点均被记录。UI 之外修改的内容只有进入请求快照才在追溯范围内。工作站自报信息不能替代 actor 身份。

日志不输出 token、完整签名 URL、明文凭证或完整 Prompt。Prompt/素材只在有权限的任务记录中查。Provider 返回 ID 后若数据库短暂不可写，先将 ID 与 taskId/attemptId 写入持久化应急记录并停止新提交；人工修复不能把日志自动当作资金真相。

建议日志保留 14 天且不随容器重建丢失，空间上限与轮换量需按实际流量验证；事故记录至少保留到对应账期核实结束。数据库每日备份、首轮验证可恢复到隔离库；保留策略属于试点配置，不在这里承诺长期数据永久保留。

## 4. 必须守住的执行边界

1. 所有进入可执行 pending 的入口都经过同一生产准入：有效凭证/可信调用身份 → 合法 actor → 生产白名单 → 素材归属与规格 → 原子额度预占。旧 Admin/Worker 路径不能绕开 actor 与额度要求；不扩展旧接口用途。
2. 同一 actor + 生成意图只创建一个 Task、只占一次额度。并发重复请求返回同一任务；请求体变化返回冲突，不能悄悄复用。
3. 提交前持久化 Attempt 标记；已有 providerTaskId 只查询原任务。请求超时、5xx 或响应缺 ID 等无法证明未受理时进入 requires_review，不自动再提交。
4. Provider 成功后，先保存终态/usage，再进行可重试的下载归档。上传或下载失败不能抹掉已发生的费用。
5. Task 的“交付完成”必须意味着输出 Asset 已登记、对象可取；Provider 成功但交付失败要可识别。原任务修复归档不再次调用 create。
6. MVP 单 Worker、全局最多 1 个在执行的 Provider 任务；还要限制待执行队列与每人的生成次数。费用未知/超预占时阻止进一步提交，待核实后解除。
7. 白名单关闭/凭证撤销停止新任务准入；不要停止已有 Provider 任务的查询与归档。客户端超时/退出不表示 Provider 被取消。
8. 人工审核只用于首批公司商品素材与明确用途，并留下审核人/时间/结论；“上传完成”不是审核通过。自动审核可后移，责任与使用范围不能后移。

## 5. 详细开发任务

> 本节是 M1–M5 的执行清单；前文第 1–4 节是需求与不变量，不再另建第二份计划。文件路径均相对仓库根；新增文件明确标注“新增”。这里的接口、测试代码和命令是待实现合同，不是当前可调用能力。
> 开发授权与生产操作分开：编写测试/代码不代表允许部署、改生产数据库、发凭证、开放白名单或付费。生产行为只在 T12 获得相应确认后进行。

### 5.1 任务总表与依赖

| 编号 | 任务 / 主要负责模块 | 依赖 | 工作量参考 | 独立交付物 |
| --- | --- | --- | --- | --- |
| T00 | 测试隔离与验收基线 / 三包 | 无 | 2h | 不会触达生产的跨包测试入口 |
| T01 | 固定规格、输入权限和请求快照 / Backend、Worker | T00 | 3h | 被允许的请求与有效参数合同 |
| T02 | 额度预占与管理配置 / Backend、DB | T01 | 5h | 原子准入、幂等预占及迁移 |
| T03 | 领取边界与恢复合同 / Backend、Worker | T02 | 3h | 已有 ID 可接续，无预算任务不可执行 |
| T04 | 不确定提交与应急留痕 / Worker | T03 | 4h | 不盲目重提、ID 回写失败有证据 |
| T05 | Provider 终态、usage 与预算结算 / Backend、Worker | T02、T04 | 4h | 生成费用不依赖下载成功 |
| T06 | 可恢复归档与结果查询 / Backend、Worker | T05 | 4h | 不假报完成，原任务可修复 |
| T07 | 生成意图与本地回执 / Client | T01、T02 | 3h | 重试与“再生成一版”明确区分 |
| T08 | 等待、下载与工作流模板 / Client | T06、T07 | 4h | 真实 ComfyUI 可执行的完整图与恢复图 |
| T09 | 持久日志与 taskId 查询 / 服务端、脚本 | T04–T06 | 3h | 一条任务的完整排障证据 |
| T10 | 心跳、巡检与告警 / 运维、Worker | T09 | 3h | 异常有人收到，监控本身可检查 |
| T11 | 跨包故障回归与交付打包 / 三包 | T03–T10 | 4h | 三包回归、故障矩阵、无密钥交付包 |
| T12 | 部署与真实创意验收 / 运维、创意人员 | T11、生产操作确认 | 2h + 等待 | 可播放视频及交付/恢复证据 |

合计参考约 44 小时，约 6 个每天有效投入 8 小时的工程工作日，是上一轮 4–6 天估算的上沿，不承诺日历日期。若每天只能投入 6 小时，应按约 7–8 天排；Provider 等待和人员协调另计。不能通过省略 T11/T12 来兑现更短排期。

建议执行批次：A=T00–T02；B=T03–T06；C=T07–T08；D=T09–T11；E=T12。T07 可在 Backend 合同稳定后提前开发，但本规划不自动授权多代理或并行修改共享文件。

每个编码任务按以下顺序勾选：写本任务失败用例 → 运行并确认失败原因 → 最小实现 → 目标测试通过 → 同步 runbook/.env → 审查差异并按任务单独提交。全量三包测试按仓库要求在提交前运行；提交/推送仍按当次授权执行，不使用 `git add -A`。

### 5.2 共用合同（下游任务不得自行换字段）

**状态语义：**

| 阶段 | Task.status / taskStatus | Attempt.status | 新增 Task.deliveryStatus |
| --- | --- | --- | --- |
| 已准入、等待领取 | pending / pending | 尚未创建 | not_started |
| 已领取、准备提交 | submitted / in_progress | pending | not_started |
| 已写提交标记、结果尚不明确 | submitted / in_progress | submitted | not_started |
| Provider 执行中 | running / in_progress | running | not_started |
| Provider 成功，归档中 | archiving / in_progress | completed | archiving |
| Provider 成功，归档失败 | failed / failed | completed | failed |
| 输出可交付 | completed / completed | completed | ready |
| 提交不确定 | requires_review / requires_review | requires_review | not_started |
| Provider 确认失败 | failed / failed | failed | not_started |

不新增完整事件平台；Task 新增 `executionPlan Json?` 和 `deliveryStatus String?`。历史记录可空，不能在 migration 中根据旧 completed 状态批量推断 ready。Attempt.completed 的新合同是“Provider 已成功”，不能由旧记录直接推断终态证据齐全。

**请求与实际执行：** `requestSnapshot` 保持客户端提交内容，供同一 Idempotency-Key 比较；`executionPlan` 保存服务端批准的 model、duration、ratio、resolution、generate_audio、watermark、specVersion、pricingVersion 与预算依据。重放先找已存在任务，不用当前配置重写旧任务；Worker 只消费旧任务固化的 executionPlan，不从任意 params 覆盖模型/计费规格。

**金额：** 新预占表使用 Decimal(18,6)，API 以十进制字符串传递。旧 Task.cost / Attempt 浮点金额只作兼容展示，不能再作为准入汇总依据。原始 usage 仍在 Attempt 保存；Backend 使用固化价格规则核算精确的预算结算值。未知值用 null + 状态，不用 0。

**用户查询响应：** 现有 `GET /api/v1/tasks/:id` 保留兼容字段，增加：
`execution: {attemptId, provider, model, providerTaskId, status}`、
`delivery: {status, assetId, errorCode}`、
`costSummary: {status, estimatedCny, usageCalculatedCny, billedCny, pricingVersion}`。
金额为 string|null，对象内容限本人 Task，不返回服务密钥、原始错误中的签名 URL。例子里的 Task ID / 金额仅是测试数据。

**错误合同：** 未认证 401；未开放/无输入权限 403；本人任务不存在或读取他人 Task 404；非法规格 400；同 key 不同请求 409；预算/次数/队列拒绝 429；预算配置不可用或系统暂停 503。结果查询对本人未完成任务返回 409 + `RESULT_NOT_READY`，归档失败返回 409 + `DELIVERY_FAILED`；不存在/越权仍 404。

**恢复：** `GET /api/tasks/recover` 保持 Worker Guard，展平 providerTaskId / attemptId / attemptStatus / attemptModel / providerUsage / pricingVersion / executionPlan / deliveryStatus。正常恢复不创建新 Provider 任务；归档失败通过受控的人工恢复动作重新进入 archiving，不回 pending。

**地址归属：** 创意人员电脑上的 ComfyUI 客户端只访问公司 Backend HTTPS；公司服务器上的 Worker 访问 Ark HTTPS。`http://127.0.0.1:19091/api/v3` 仅用于 Fake Provider 与测试进程在同一台主机的合同测试；Docker 内的 Worker 访问另一个 Fake Provider 容器时必须使用 `http://fake-provider:19091/api/v3`，不能使用容器自身的 loopback。

### T00：建立不会误付费的测试入口

**修改：** `packages/backend/jest.config.js`、`packages/backend/package.json`、`.github/workflows/ci.yml`。
**新增：** `scripts/compose.contract.yml`、`scripts/run_mvp_contract.sh`、`scripts/tests/fake_provider.py`、`packages/backend/test/jest-contract.json`、`packages/backend/test/contract-harness.ts`、`scripts/tests/conftest.py`（固定脚本导入目录及隔离测试配置）。
**依赖输出：** `npm run test:contract` 在独立 PostgreSQL 上运行真实 Nest HTTP；测试 harness 导出 `createContractHarness()`，返回 appUrl、prisma、actorToken、workerToken、adminToken、close()。测试数据仅通过隔离 DB fixture 建立，不开放 fixture HTTP 写入口。

- [x] Harness 在启动前校验 `VIDEO_FLOW_TEST_MODE=1`，数据库名必须为 `video_flow_contract`，地址必须为测试 Compose 的 postgres 或 loopback；不读取生产 .env，不打印连接串。
- [x] 假 Provider 只绑定测试网络，提供 create/get、调用计数及测试故障开关；每个测试指定临时目录/测试库，禁止共享生产 token/桶。
- [x] 跨包脚本以固定测试项目名启动隔离栈，生成一次性假凭证，Backend/Worker 使用测试服务地址；不挂载真实凭证。失败保留脱敏日志；清理只针对该测试项目。
- [x] 新合同测试不得 mock Nest Guard/Prisma；保留单元测试与合同测试两个独立入口。
- [x] 测试环境使用 Provider URL 显式注入，生产默认固定 Ark 地址；非生产地址只允许 test mode，并拒绝同时存在真实 Provider 密钥。
- [x] 验证缺隔离标记、错误数据库名、非测试 Provider 地址都在创建任务前退出。

代表性测试（新增 `packages/backend/test/isolation.contract-spec.ts`；`assertContractDatabase` 由 harness 导出）：

```ts
import { assertContractDatabase } from './contract-harness';
test('refuses a non-contract database before connecting', () => {
  expect(() => assertContractDatabase('postgresql://test:test@127.0.0.1/video_flow'))
    .toThrow('CONTRACT_DATABASE_REQUIRED');
});
```

运行：Backend 包内 `npm run test:contract -- --runInBand`；仓库根 `bash scripts/run_mvp_contract.sh`。预期先因入口未实现失败，完成后隔离检查通过、外部真实 Provider 调用为 0。建议提交：`test: add isolated production contract harness`。

### T01：固化生成规格、素材权限与执行快照

**修改：** `packages/backend/src/v1/tasks/preview-plan.ts`、`v1-tasks.controller.ts`、`dto/create-task.dto.ts`（后两者同目录）、`packages/backend/src/tasks/tasks.service.ts`、`packages/backend/src/assets/assets.service.ts`、`packages/backend/src/tasks/tasks.module.ts`、`packages/backend/src/v1/tasks/v1-tasks.module.ts`（按注入位置导入 AssetsModule）；Worker `models.py`、`providers/seedance_adapter.py`；`.env.example`、`docker-compose.yml`。
**新增：** `packages/backend/src/tasks/production-spec.ts`、`production-spec.spec.ts`；schema 中新增 executionPlan / deliveryStatus，migration `packages/backend/prisma/migrations/202609110001_mvp_execution_plan/migration.sql`。
**接口：** `normalizeProductionParams(params, spec)` 返回只含批准字段的生成参数；`findOwnedUploadedInput(assetId, actorId)` 返回 role=input、所属 actor 且上传校验完成的 Asset，否则 null。Worker `Job.get_params()` 以 executionPlan 的计费字段覆盖客户端输入，素材 URL 只由服务端资产签名产生。

- [x] 定义 `ProductionSpec` 的必填字段：version、model、duration、ratio、resolution、generate_audio、watermark、pricingVersion、预算金额/计算依据。真实值由上线确认；测试使用明确标为假的规格。
- [x] 从 `VIDEO_FLOW_PRODUCTION_SPEC_JSON` 解析配置；配置不完整仅关闭 Production，Preview/查询不受影响。拒绝非白名单字段及与批准规格不一致的 model/duration 等，不能静默忽略高成本参数。
- [x] 先按 actor+key 查重并比对原始请求，再为新意图执行规格/素材校验。新任务保存原请求、批准 executionPlan、输入 assetId/hash 与稳定客户端元数据。
- [x] Worker 适配器补 resolution 转发；不能因 Worker 当前默认模型变更而改变旧任务。旧 pending 没有批准执行快照时不能直接进入付费路径。
- [x] migration 仅加可空字段，不篡改历史任务；生成 Prisma client 并做隔离库升级/旧数据读取测试。
- [x] 修复现有空库 migration 顺序缺口：不得修改已经在生产登记的 migration 内容或名称；先查询生产 `_prisma_migrations`，再通过向前兼容的基线/初始化方案，使全新空库 `prisma migrate deploy` 可成功，并保留现有库无重复建表的升级路径。该项未通过前，T00 合同库只允许 `prisma db push`，不能宣称 migration 链已验证。
- [x] 新增 `packages/backend/test/production-input.contract-spec.ts`，覆盖本人输入成功、他人 Asset 403、output Asset 拒绝、未完成上传拒绝、自由 URL/多媒体/越界时长拒绝、请求重放不重写 executionPlan。

代表性用例（`production-spec.spec.ts`，spec 是测试专用 fixture，不是有效云模型配置）：

```ts
import { normalizeProductionParams } from './production-spec';

const spec = { version: 'test-v1', model: 'test-model', duration: 5,
  ratio: '16:9', resolution: 'test-resolution', generate_audio: false,
  watermark: true, pricingVersion: 'test-price', reserveCny: '2.000000' };
test('rejects duration outside the fixed spec', () => {
  expect(() => normalizeProductionParams({ prompt: 'product', image_asset_id: 'a',
    duration: 60 }, spec)).toThrow('PRODUCTION_SPEC_MISMATCH');
});
```

运行：Backend `npx jest production-spec --runInBand`、`npm run test:contract -- production-input --runInBand`；Worker `venv/bin/python -m pytest tests/test_job_params.py -q`。建议提交：`feat: enforce owned input and frozen production spec`。

### T02：额度预占、原子准入与最小额度配置

**修改：** Backend `prisma/schema.prisma`、`src/tasks/tasks.service.ts`、`tasks.module.ts`、`src/auth/credentials.service.ts`、`src/v1/admin/v1-credentials.controller.ts`；`scripts/video_flow_credential.sh`、`.env.example`。
**新增：** `packages/backend/src/tasks/task-budget.service.ts`、`task-budget.service.spec.ts`、`packages/backend/test/budget.contract-spec.ts`；migration `packages/backend/prisma/migrations/202609110002_task_budget/migration.sql`。
**接口：** Task 一对一 `TaskBudgetReservation`，含 taskId（唯一 FK）、actorId、reservedCny、settledCny?、state（reserved/settled/review/released）、dayKey、monthKey、pricingVersion、createdAt/updatedAt。金额 Decimal(18,6)，按 actor+dayKey/monthKey 建索引。
`TaskBudgetService.reserveInTransaction(tx, taskId, actorId, executionPlan)` 仅在创建事务调用；`settleInTransaction(tx, taskId, amountCny)` / `holdForReviewInTransaction(tx, taskId)` / `releaseInTransaction(tx, taskId, reason)` 由 T05 的费用合同驱动。

- [x] 定义统一预算时区 Asia/Shanghai；占用 = 当前周期已结算金额 + 全部尚未结算预占（含跨周期在途/review）。未知金额不能因跨日/月恢复为可花额度。
- [x] 准入事务按固定顺序取得全局准入锁、actor 锁，再检查 active credential、白名单、日/月金额、日次数、全局 pending 数；Task 与预占一并提交。PostgreSQL 参数化事务 advisory lock，不在 SQL 拼接 actorId。
- [x] 并发相同 key 只预占一次；同 key 重放不得先因新额度不足而拒绝已有任务。新 key 的并发预算检查必须串行化，不用“先查再单独插入”。
- [x] TasksModule 注册/导出 TaskBudgetService，使用方显式导入；避免复制创建不共享状态的服务实例。
- [x] 增加 Admin Guard 保护的 `PATCH /api/v1/admin/credentials/:actorId/limits`，只更新日/月限额；配置非负、有限数值，空值代表不开生产，不输出 token。次数/队列上限从 `VIDEO_FLOW_DAILY_TASK_LIMIT`、`VIDEO_FLOW_MAX_PENDING_TASKS` 读取。
- [x] 预算权威计算将限额转为 Decimal 比较；新增结算值不用二进制浮点累计。migration 同时创建 T10 定义的 ProductionGate 单例，默认 paused=true；测试 fixture 显式启用，生产启用留到 T12。旧浮点费用只兼容展示，不参与剩余额度。
- [x] 测试同 key 并发、不同 key 抢最后一份额度、事务失败无残留占用、空限额拒绝、跨月预占、重复结算不重复扣减；migration 回滚以关闭 Production + 保留新增表为先，不删除资金记录。

**完成状态（2026-09-12）：** 以上检查项均已实现并通过 `npx jest task-budget --runInBand`（22 个用例）与 `npm run test:contract -- budget --runInBand`（含并发抢额度、每日任务数上限、Asia/Shanghai 时区键、跨月预占计入准入等场景）验证。修复了一个真实并发缺陷：准入事务此前使用 Serializable 隔离级别，与 advisory lock 组合会导致后置事务用旧快照做预算检查，在 COMMIT 时抛出未捕获的 `serialization_failure` 而返回 500（应为 429）；现已改为默认 ReadCommitted，由 advisory lock 单独负责串行化。同时修复了 `PATCH .../limits` 返回体泄漏 `tokenHash` 字段的问题（改为显式 `select` 白名单字段）。

精确预算函数（在 service 文件导出，测试传字符串）：

```ts
import { Prisma } from '@prisma/client';

export function fitsBudget(limit: string, used: string, reserve: string): boolean {
  return new Prisma.Decimal(used).add(reserve).lte(new Prisma.Decimal(limit));
}
test('does not admit beyond the last available micro-unit', () => {
  expect(fitsBudget('10.000000', '9.000001', '1.000000')).toBe(false);
});
```

隔离合同测试用例必须通过两个并发真实 HTTP 请求核对 Task/预占行数，不能只测上面算式。运行：Backend `npx jest task-budget --runInBand`、`npm run test:contract -- budget --runInBand`。建议提交：`feat: reserve production budget atomically`。

### T03：收紧领取入口并修复恢复响应

**修改：** `packages/backend/src/tasks/tasks.controller.ts`、`tasks.service.ts`、`task-claim.service.ts` 及对应 spec；`packages/worker/models.py`、`executor.py`、`recovery.py`、`tests/test_provider_submission_recovery.py`。
**新增：** `packages/backend/test/claim-recovery.contract-spec.ts`。
**接口：** 保持 claim/recover 路由和 Worker Guard；恢复响应使用第 5.2 节字段。生产 claim 不接受调用方通过 mode 改变 Task 的批准执行类型。

- [x] 将旧 `POST /api/tasks` 收紧为鉴权后返回 410 `USE_V1_TASKS`，保留旧查询/Worker 接口；同步旧调用脚本和 runbook。无 actor/预占的历史 pending 不执行，列出需管理员处理的任务，不批量删除。
- [x] claim 在全局事务锁内检查 ProductionGate（T02 创建）的暂停状态与 active Provider 槽位、任务的执行快照/预占与 actor 当前授权；全局最多 1 个在途生成。Worker 每轮最多领取 1 个，不先 claim 一批再内存串行。
- [x] 新 pending 的准入或授权不满足时不调用 Provider；仅当确定没有提交标记/Provider ID，才允许取消并释放预占。已提交任务即使 actor 被撤销也继续恢复归档。
- [x] recover 展平 Attempt 字段并返回 archiving 阶段；运行中有 ID 接续查询，submitted 无 ID 转 requires_review。租约超时不是再次 create 的许可。
- [x] 补 Task/Attempt 关联验证：任何 Worker 回写必须确认 attempt.taskId 与路径 Task 一致；拒绝把终态/已提交 Task 任意重置 pending。修复不带 attemptId 的 taskStatus 更新遗漏。
- [x] 合同测试从真实 Backend recover 响应构造 Worker Job，不手写一份不同的 fixture 替代整个合同。

**完成状态（2026-09-12）：** 以上检查项均已实现。后端 `npx jest task-claim tasks.service legacy-tasks-auth v1-tasks task-budget --runInBand`（56 个用例）、`npm run test:contract -- --runInBand`（4 个 spec 共 28 个用例，含新增 claim-recovery 合同：真实 claim → recover → PATCH providerTaskId → 按 models.py 字段合同解析 Job）与 Worker `venv/bin/python -m pytest tests/ -q`（92 通过 / 26 跳过）全部通过。修复了两处交接遗留问题：(1) tasks.service.spec 的 `@nestjs/common` mock 缺少 `ConflictException`/`BadRequestException`，导致新增拒绝路径的单测报 `ConflictException is not a constructor`；(2) Worker 531b70a 的「submitted 无 ID 拒绝重提」分支未检查执行快照，短路了带快照任务经 journal 保护的受控重提（T04 合同测试 3 个失败）——该分支的意图由既有的 `MISSING_EXECUTION_PLAN` 路径完整覆盖（无快照 legacy 任务转 requires_review 且 Provider create 次数为 0），故删除该分支。deploy.sh 的旧创建接口提示已同步指向 v1。archiving 阶段的 recover 覆盖随 T05/T08 引入 TaskStatus 枚举值与归档工作流后生效，展平字段合同（第 5.2 节）已就位。

映射实现核心与代表性测试：

```ts
// attachAttempt 返回对象增加；其余已有字段保留。
providerTaskId: attempt?.providerTaskId ?? null,
providerUsage: attempt?.providerUsage ?? null,
pricingVersion: attempt?.pricingVersion ?? null,
```

```python
def test_provider_id_survives_backend_payload():
    from models import Job
    payload = {"id": "task-1", "status": "running", "createdBy": "actor-1",
               "prompt": "product", "createdAt": "2026-09-11T00:00:00Z",
               "attemptId": "attempt-1", "providerTaskId": "provider-1"}
    assert Job(**payload).providerTaskId == "provider-1"
```

运行：Backend `npx jest task-claim tasks.service legacy-tasks-auth --runInBand`、`npm run test:contract -- claim-recovery --runInBand`；Worker `venv/bin/python -m pytest tests/test_provider_submission_recovery.py -q`。出口还要验证：有 Admin token 的旧 create 返回 410；所有缺预算 pending 的 Provider create 次数为 0。建议提交：`fix: enforce claim admission and restore provider identity`。

### T04：提交不确定时停止重提，并保住应急证据

**修改：** `packages/worker/providers/seedance_adapter.py`、`executor.py`、`config.py`、`tests/test_provider_submission_recovery.py`；`.env.example`、`docker-compose.yml`。
**新增：** `packages/worker/submission_journal.py`、`tests/test_submission_journal.py`。
**接口：** `is_submission_uncertain(status_code: int | None, has_task_id: bool) -> bool`；`SubmissionJournal(directory: Path).append(event: dict) -> None` 同步追加、flush/fsync。目录配置 `VIDEO_FLOW_AUDIT_DIR` 绑定服务器受限持久目录；Worker 配置字段名显式映射该环境变量。

- [x] Provider create 前先提交 Attempt.submitted 标记并确认成功；标记失败不调用 Provider。
- [x] 网络异常、HTTP 5xx、2xx 无 ID/响应无法解析均进入不确定分支；明确拒绝类响应保持拒绝原因，不默认任何失败都可自动重提。
- [x] 获得 Provider ID 后立即写 taskId/attemptId/providerTaskId/UTC/stage 到 journal，再回写 DB；journal 不放完整响应 URL/Prompt/token。
- [x] DB 回写失败或 journal 不可写时停止新 claim/create，保留现有任务查询能力；重启时发现未完成应急项仍保持暂停，不能只靠内存集合。
- [x] 原已知 ID 与待核实意图人工处理前核对 Provider，禁止凭同 Prompt/大致时间推断唯一任务；不能匹配就维持 requires_review。
- [x] 测试提交响应丢失、500、无 ID、DB 回写失败、journal 满/不可写、进程重启后仍停新提交。

**完成状态（2026-09-12）：** 以上检查项均已实现。新增 `submission_journal.py` 承载 journal 与阻断标记：`append` 同步写入并 flush/fsync，文件 0600、目录 0700；落盘字段走白名单（at/stage/taskId/attemptId/providerTaskId/reason），prompt、完整响应、token、签名 URL 结构性地写不进去；`unresolved_submissions()` 给出"已提交 Provider 但从未确认落库"的记录供人工核对。`is_submission_uncertain(status_code, has_task_id)` 只在 4xx 判定为明确拒绝，其余（无状态码、5xx、2xx 无 ID、响应不可解析）一律不可判定；adapter 按此路由，异常消息不再回显响应体。executor 新增启动对账 `_reconcile_submission_journal()`：磁盘上存在未确认提交时继续保持暂停（内存状态重启即丢，不作为判据），恢复/查询已有任务的能力不受影响；提交确认落库后补写 db_confirmed，使证据在重启对账时闭环。审计目录由 `VIDEO_FLOW_AUDIT_DIR` 指定（compose 挂载持久卷 `/app/audit`），未配置时退回 output_dir。测试：`venv/bin/python -m pytest tests/ -q`（123 通过 / 26 跳过），含新增 `tests/test_submission_journal.py`（13 个用例）与 adapter 参数化用例、重启对账用例。顺带修复测试隔离缺陷：`test_mvp_backend_contract` 与 recovery 用例原共用 `/tmp/video-worker-output`，持久 journal 会让上一次运行的残留改变本次启动行为，现每次使用独立临时目录。

最小代表性测试（同文件导出/导入该函数，不替代异步集成用例）：

```python
import pytest
from providers.seedance_adapter import is_submission_uncertain

@pytest.mark.parametrize("code,has_id", [(None, False), (500, False), (200, False)])
def test_uncertain_submission_is_not_retryable(code, has_id):
    assert is_submission_uncertain(code, has_id) is True
```

journal 记录示例：

```json
{"stage":"provider_accepted","taskId":"task-1","attemptId":"attempt-1","providerTaskId":"provider-1","at":"2026-09-11T00:00:00Z"}
```

运行：Worker `venv/bin/python -m pytest tests/test_submission_journal.py tests/test_provider_submission_recovery.py -q`。出口：故障后重启，原意图 create 计数不增加，应急 ID 可恢复。建议提交：`fix: quarantine uncertain submissions with durable evidence`。

### T05：先保存 Provider 终态与 usage，再结算预算

**修改：** Backend `src/v1/internal/v1-worker.controller.ts`、`src/tasks/tasks.service.ts`、`task-budget.service.ts`、`src/executions/executions.service.ts`；Worker `executor.py`、`recovery.py`、`providers/seedance_adapter.py`、`tests/test_cost_audit.py`；相关模块装配。
**新增：** `packages/backend/src/tasks/task-cost.ts`、`task-cost.spec.ts`、`packages/backend/test/provider-outcome.contract-spec.ts`、`packages/backend/src/v1/admin/v1-task-operations.controller.ts` 及对应 spec；在 `packages/backend/src/v1/admin/v1-admin.module.ts` 导入 TasksModule 并注册控制器。
**接口：** `PATCH /api/v1/internal/attempts/:attemptId/outcome`，Worker Guard。body：
`{providerTaskId, status: "succeeded"|"failed"|"cancelled", usage: object|null, errorCode?: string}`。
Backend 从 Attempt 找 Task，以固化 executionPlan 解释 usage，并在一个事务中更新 Attempt、Task 阶段及预占；不信任请求体传入任意单价/结算金额。

- [x] 合法 usage 按已核实计费规则计算；缺字段、负数、非整数、NaN、模型/价格不匹配标 unavailable/review，不套错误公式。
- [x] 成功 outcome 原子写 Attempt.completed、providerUsage、pricingVersion、预算 settled；Task 进入 archiving。重复完全相同 outcome 幂等，不重复计费；冲突终态/usage 进入核查，不覆盖既有依据。
- [x] usage 缺失时保留预占/review，但仍允许归档已生成视频；预算未知阻止后续新提交，不能用归档成功掩盖未知费用。
- [x] Provider 失败若是否收费无证据，同样保留 review；只在明确未提交或人工核实有凭据时释放，不能由 HTTP failed 推断免费。
- [x] 日后账单核实通过 Admin 受控动作更新 billed 值并记录操作者/依据；MVP 不实现自动账单抓取。新增 `PATCH /api/v1/admin/tasks/:taskId/budget-review`，body 为 decision（settle/release）、amountCny（settle 必填）、evidenceRef、operator；operator 为管理操作声明，不能冒称 token 已识别具体员工。
- [x] Worker 必须确认 outcome 写入成功后才进入归档；失败先留 journal，再按原 ID 查询补记。暂停期间不得丢弃 Provider 返回的必要 usage 证据。
- [x] 验证“生成已花钱但 OSS 故障”“没有 usage 仍可拿视频”“同终态回写两次”“跨 Task 的 Attempt 被拒”。

**完成状态（2026-09-12）：** 以上检查项均已实现。Backend 新增 `src/tasks/task-cost.ts`：`tokenCostCny` 用 Decimal 向上取整到 6 位（样例 `tokenCostCny(123456, '1.25') === '0.154320'` 已断言），`interpretUsage` 只认已登记 pricingVersion + 模型匹配的规则，缺字段/负数/小数/NaN/未知价格版本/模型不匹配一律 unavailable（`MISSING_USAGE`/`MISSING_TOTAL_TOKENS`/`INVALID_TOTAL_TOKENS`/`MISSING_PRICING_VERSION`/`UNKNOWN_PRICING_VERSION`/`MODEL_PRICING_MISMATCH`），不套错误公式。新增 `PATCH /api/v1/internal/attempts/:attemptId/outcome`（Worker Guard）：从 Attempt 找 Task、用固化 executionPlan 解释 usage，单事务写 Attempt 终态 + providerUsage + pricingVersion + 预占 settled（有证据）或 review（无证据）+ Task 阶段（成功→archiving/archiving，失败→failed/failed/not_started）；请求体只接受原始事实，金额一律由 Backend 核算。重复完全相同 outcome 幂等返回且不重复计费；冲突终态/usage 转 review 且不覆盖既有 usage 与已结算金额；跨 attempt 的 providerTaskId 被 409 拒绝（`PROVIDER_TASK_MISMATCH`/`PROVIDER_TASK_OWNED_BY_ANOTHER_ATTEMPT`）。新增 `PATCH /api/v1/admin/tasks/:taskId/budget-review`（Admin Guard）+ migration `20260912000000_budget_review_audit`：settle 需正数金额并写 Attempt.billedCostCny/costStatus=billed，release 明确禁止带金额，两者都记录 operator/evidenceRef/reviewedAt，响应以 `operatorIsDeclaredClaim: true` 标明 operator 是管理员声明而非 token 识别的身份。Worker 侧：`ProviderTaskFailedError` 携带完整终态（失败任务也可能计费，usage 不再被丢弃）、`recovery.build_provider_outcome` 只构造原始事实载荷、executor 在归档前先写 journal（净化后的 usage 证据）再上报 outcome，上报失败则暂停新提交且不交付产物，等下一轮按原 providerTaskId 查回补记；没有 executionPlan 的旧任务保持兼容回写路径。顺带修复 schema 中 Task 的 executionPlan/deliveryStatus 重复定义——它使 `prisma generate` 完全无法执行（构建用的客户端一直是旧产物），删除重复块后已可正常生成。测试：后端单测 147 通过（含 task-cost 24、executions 新增 12、task-operations 7），Worker 137 通过 / 26 跳过，合同套件 5 specs / 38 tests 通过（新增 provider-outcome，覆盖同终态回写两次、冲突 usage 保留原证据、无 usage 仍进 archiving、失败有/无证据分别 settle/review、跨 attempt 拒绝、budget-review 审计与校验）。

精度函数与测试合同（仅适用于经核实为按 tokens 计费的规格，测试价格不是线上价格）：

```ts
import { Prisma } from '@prisma/client';

export function tokenCostCny(tokens: number, ratePerMillion: string): string {
  if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error('INVALID_USAGE');
  return new Prisma.Decimal(tokens).mul(ratePerMillion).div(1_000_000)
    .toDecimalPlaces(6, Prisma.Decimal.ROUND_UP).toFixed(6);
}
test('uses decimal arithmetic for the budget ledger', () => {
  expect(tokenCostCny(123456, '1.25')).toBe('0.154320');
});
```

运行：Backend `npx jest task-cost task-budget executions --runInBand`、`npm run test:contract -- provider-outcome --runInBand`；Worker `venv/bin/python -m pytest tests/test_cost_audit.py tests/test_mvp_backend_contract.py -q`。建议提交：`feat: persist provider usage before artifact delivery`。

### T06：归档幂等、结果状态与原任务修复

**修改：** Backend `src/assets/assets.service.ts`、`src/v1/assets/v1-assets.controller.ts`、`src/v1/internal/v1-worker.controller.ts`、`src/tasks/tasks.service.ts`、`src/v1/tasks/v1-tasks.controller.ts`；Worker `executor.py`、`models.py`、`recovery.py`。
**修改管理入口：** T05 新增的 `packages/backend/src/v1/admin/v1-task-operations.controller.ts` 及对应 spec；保留已有模块注册。新增 Worker `artifact_delivery.py`、`tests/test_artifact_delivery.py`，Backend `test/artifact-delivery.contract-spec.ts`。
**接口：** `artifact_object_key(task_id, attempt_id) -> str` 固定为 `videos/{taskId}/{attemptId}/result.mp4`。
`POST /api/v1/admin/tasks/:taskId/resume-delivery`，Admin Guard，body={reason,operator,evidenceRef}；仅恢复原 Provider 成功任务的归档，不创建新 Attempt/Provider Task。

- [x] 将生成与归档分支分离，恢复 archiving 时直接使用已知 Provider ID 查回下载地址，不经过 create。Provider URL 过期则查询原任务；无法恢复就明确失败，不生成替代品。
- [x] 文件存在、非空并上传后 HEAD 校验通过才登记输出；Asset.owner 继承 Task，并检查 Attempt 属于 Task。
- [x] Asset 登记用 taskId+attemptId 事务锁 + 同 objectKey 查重返回既有行，所有输出登记共用此入口；不靠秒级文件名。输出 hash 可先由本地回执记录，避免误触输入内容寻址唯一约束。
- [x] Asset 成功后才原子写 Task.deliveryStatus=ready 与 completed；任何失败写 deliveryStatus=failed、阶段错误及 taskId。Attempt 的 Provider 成功与费用保留不变。
- [x] 返回第 5.2 节任务摘要/结果错误合同；用户可区分“还在生成”“归档失败”“需核查”。下载链接按需签发，不存为永久产物标识。
- [x] 人工恢复与 Worker 自动恢复不能并发执行同一归档：通过状态 CAS/归档租约限制。MVP 不开放用户任意重置状态接口。
- [x] 验证无 URL、空文件、上传失败、Asset 500、最后回写失败、重复登记、签名过期、越权取片；恢复后仅一条输出记录且 Provider create 增量为 0。

**完成状态（2026-09-13）：** 以上检查项均已实现，过程中修掉一个会重复扣费的缺陷：`findRecoverable` 原先只返回 submitted/running，archiving 任务不在恢复集合里，Worker 从 `/api/tasks/recover` 拿到 archiving 任务后会落进 create 分支再提交一个付费任务。现在恢复集合纳入 archiving，`should_resume_job` 同步允许该状态，executor 在提交分支之前先判归档分支（用已知 providerTaskId 查回产物，不经过 create）；归档任务不再套用生成超时；没有 providerTaskId 的归档请求直接写 `NO_PROVIDER_TASK_ID_FOR_ARCHIVING` 明确失败，不做替代品。Worker 新增 `artifact_delivery.py`：`artifact_object_key(taskId, attemptId) = videos/{taskId}/{attemptId}/result.mp4` 稳定键取代秒级时间戳命名，`validate_artifact_file`（存在/非空）与 `verify_uploaded_object`（上传后 HEAD 且大小一致）把关；`deliver_artifact` 按下载→本地校验→上传→HEAD 校验→登记→确认交付的顺序推进，任何一步失败都写 `deliveryStatus=failed` + 阶段错误，不把归档失败伪装成还在生成。Backend：`AssetsService.registerOutputOnce` 作为唯一输出登记入口，owner 从 Task 继承、校验 Attempt 属于 Task、taskId+attemptId 事务 advisory lock 串行化「查重+插入」、同 objectKey 返回既有行；新增 `PATCH /api/v1/internal/attempts/:attemptId/delivery`（ready 必须先有已登记产物，CAS 从 archiving 转 ready/failed，重复相同结果幂等）；`GET /api/v1/tasks/:id` 增加 execution/delivery/costSummary 三段（金额一律十进制字符串）；结果接口按 5.2 节区分 `RESULT_NOT_READY`/`DELIVERY_FAILED`/`RESULT_REQUIRES_REVIEW`，越权与不存在同样 404；`POST /api/v1/admin/tasks/:taskId/resume-delivery` 只对「Provider 已成功且交付失败」的任务做 CAS 回 archiving，不创建 Attempt/Provider 任务，并记录 reason/operator/evidenceRef（operator 标注为声明值）。另修两处既有缺陷：`Asset.sizeBytes` 是 BigInt 列而 Worker 传 JSON number，登记必然 500（此前无测试覆盖）；advisory lock 参数需显式 `::int`，否则 Prisma 按 bigint 传参会报 42883。测试：后端 170 通过，Worker 152 通过 / 26 跳过，合同套件 6 specs / 48 tests 通过（新增 artifact-delivery，覆盖无产物不得交付、分阶段失败、重复登记单行、人工恢复后 Provider create 增量为 0、越权取片）。

代表性测试：

```python
def test_artifact_key_is_stable_and_task_scoped():
    from artifact_delivery import artifact_object_key
    assert artifact_object_key("task-1", "attempt-1") == "videos/task-1/attempt-1/result.mp4"
    assert artifact_object_key("task-2", "attempt-1") != artifact_object_key("task-1", "attempt-1")
```

运行：Backend `npx jest assets.service v1-assets.controller v1-worker.controller v1-task-operations --runInBand`、`npm run test:contract -- artifact-delivery --runInBand`；Worker `venv/bin/python -m pytest tests/test_artifact_delivery.py tests/test_mvp_backend_contract.py -q`。建议提交：`fix: make artifact delivery resumable and truthful`。

### T07：显式生成版本与提交回执

**修改：** `packages/comfyui-video-flow-client/client.py`、`nodes.py`、`config.py`、`tests/test_client.py`、`tests/test_nodes.py`。
**新增：** `packages/comfyui-video-flow-client/receipts.py`、`tests/test_receipts.py`。
**接口：** Production 增加 `generation_version` 正整数，默认 1；稳定 key 纳入该值、specVersion、Prompt、图片 hash 与生成规格，仍按 preview/production 分作用域。`ReceiptStore(root: Path).save(intent_key, payload)` / `load(intent_key)` 使用原子临时文件替换。

- [x] “同参数、同版本”重复执行沿用同 key；用户主动增加版本号才表示再生成一版。保留旧 stable_idempotency_key 的可选参数兼容，但新模板显式带版本。
- [x] 上传完成后、发 POST 前保存意图/key/完整稳定请求；拿到 Task 后补 taskId。不将每次执行时间戳、临时签名 URL 混入幂等请求。
- [x] 回执按后端地址及凭证的不可逆命名空间隔离，避免换账号误用旧 taskId；不写原 token，目录 700/文件 600。
- [x] POST 超时后重新执行使用回执中的原 body/key；服务端已创建时找回原 Task，未创建时创建一次。不得自动提升 generation_version。
- [x] 回执无法写入时在创建付费任务前报错；已创建后的补写失败明确显示 taskId，不误报“未提交”。
- [x] 版本、设备别名等只在第一次形成意图时固化；后续重试重用原快照，不能因软件升级改 metadata 导致同 key 409。

**完成状态（2026-09-13）：** 以上检查项均已实现。`ReceiptStore` 增加由「后端地址 + 凭证」派生的不可逆命名空间（`credential_namespace`，目录 700/文件 600，磁盘只出现摘要不含原 token），换账号或换后端不会读到也不会误用上一个人的 taskId；`VideoFlowClient.receipt_store()` 供节点构造带命名空间的存储。重试语义改为"沿用第一次形成的意图"：回执已存在时用其中的原 idempotencyKey 与原请求体重发，不再用调用方新建的 payload（软件升级后多出的 metadata 字段不会把同一个 key 变成"同 key 不同请求"），也不会自动提升 generation_version；新增 `_post_task` 作为唯一发送入口，`create_task` 与带回执的创建共用它。回执写不进去时在发 POST 之前就报错；任务已创建但回执补写失败时抛 `ReceiptUpdateError`，消息与属性都带 taskId，明确提示不要重新提交。稳定键纳入规格版本：`VideoFlowConfig.spec_version`（`VIDEO_FLOW_SPEC_VERSION`）参与 `stable_idempotency_key`，生产节点显式传 `generation_version` 与 `spec_version`；README 同步说明。测试：`packages/comfyui-video-flow-client/.venv/bin/python -m pytest tests/test_client.py tests/test_receipts.py tests/test_nodes.py -q` 通过（含"服务端已创建但响应丢失后重跑沿用原 key/原 body""回执写入失败不发付费请求""已创建后补写失败带 taskId""换凭证读到空回执"）。

代表性用例（在 `test_client.py`）：

```python
from client import VideoFlowClient

def test_explicit_version_distinguishes_new_generation():
    kwargs = {"profile": "seedance", "duration": 5, "ratio": "16:9",
              "spec_version": "test-v1"}
    a = VideoFlowClient.stable_idempotency_key("product", b"png", generation_version=1, **kwargs)
    b = VideoFlowClient.stable_idempotency_key("product", b"png", generation_version=2, **kwargs)
    assert a != b
    assert a == VideoFlowClient.stable_idempotency_key("product", b"png", generation_version=1, **kwargs)
```

运行：Client 自己环境 `.venv/bin/python -m pytest tests/test_client.py tests/test_receipts.py tests/test_nodes.py -q`。出口包含“服务端已创建但响应丢失”用例：第二次执行同 Task，预算行数不增加。建议提交：`feat: persist generation intent and client receipts`。

### T08：真正等待、正确输出和两份可用工作流

**修改：** Client `nodes.py`、`client.py`、`__init__.py`、`tests/test_nodes.py`、`tests/test_client.py`。
**新增：** Client `examples/seedance-production.json`、`examples/seedance-resume.json`、`web/js/video_flow_status.js`；只提供最小状态/文件路径展示，不建设完整前端。
**接口：** `VideoFlowClient.wait_for_task(task_id, *, timeout_seconds=1200, poll_seconds=5) -> dict`。成功条件是 delivery.status=ready；终态错误抛含 taskId/code 的异常；超时抛 `TaskWaitTimeout(task_id)`。Wait 输出 taskId，LoadResult 接收该输出，不把 task_json 当作 taskId。

- [x] Wait 以 monotonic 时钟控制总时限，查询失败有限退避；401/403 停止并提示凭证，429/5xx/网络错误只重查、不重建；超时仍保留回执。
- [x] requires_review、Provider failed、delivery failed 都给不同提示和 taskId；费用未知但输出 ready 时允许下载并显示“费用待核实”。
- [x] Wait/LoadResult 的 ComfyUI 缓存策略允许用户重新查询；Production 即使再次被调度也只能沿用 T07 原意图。测试运行时缓存，不能只直接调用 Python 方法。
- [x] 通过 `folder_paths.get_output_directory()` 获取实际 output；测试替换运行时模块，不再 monkeypatch 整个 default_output_dir 掩盖目录逻辑。
- [x] 下载前取新签名 URL，写随机临时 .part；验证实际字节数非零、与声明 size（若有）一致再原子发布，保留已成功的原文件。失败清理的仅是本次临时文件。
- [ ] 节点 UI 显示 taskId、阶段、最终路径；简单展示扩展经实际 ComfyUI 验证。结果回执补大小/hash，不包含下载签名 URL。
- [ ] 用真实 ComfyUI 导出两份模板：完整图 `Config → Production → Wait → LoadResult`，恢复图 `Config + taskId → Wait → LoadResult`。两者地址为公司 HTTPS，凭证仅从本地配置读取。
- [ ] 在自定义 output 路径及重启后的主实例测试导入/执行/重新取片；先接 T00 假服务，真实 Provider 留到 T12。

**完成状态（2026-09-13，代码部分）：** 具备代码的检查项均已实现。`client.wait_for_task(task_id, *, timeout_seconds=1200, poll_seconds=5)` 用 `time.monotonic()` 控总时限；429/5xx/网络错误按指数退避（上限 60s）只重查同一任务、绝不重建；401/403 立即抛 `TaskCredentialsRejected` 提示检查 `VIDEO_FLOW_TOKEN`；404 抛 `TaskNotFound` 且不重试。成功条件严格是 `delivery.status == ready`——Provider succeeded 但归档失败时抛 `TaskDeliveryFailed`（带 `errorCode`），不把生成成功当成可交付。终态错误按类型分开：`REQUIRES_REVIEW`/`PROVIDER_FAILED`/`DELIVERY_FAILED`/`WAIT_TIMEOUT`/`TASK_NOT_FOUND`/`CREDENTIALS_REJECTED`，全部带 `task_id` 与 `code`。费用未知（`costSummary.status` 非 usage_calculated/billed）不阻塞下载，`cost_note()` 明确显示“费用待核实”。节点侧：`Wait` 阻塞到就绪并**只输出 taskId**（不再是 task_json），`LoadResult` 接收该 taskId，输出本地路径与 `cost_status`；三个节点都有 `IS_CHANGED`（进程内单调 nonce，纯 `time.time_ns()` 会在同一时钟刻度上相等而让缓存失效）允许重新查询，Production 再次被调度仍只沿用回执原意图。产物目录改由 `folder_paths.get_output_directory()` 决定（自定义输出路径的安装不会写错地方），测试改为替换 `folder_paths` 运行时模块。下载改写随机 `.part`，校验非零且与声明 `sizeBytes` 一致后原子发布，失败只清理本次临时文件并保留上一份成功文件；返回回执含 `sizeBytes`/`sha256`/`objectKey`，**不含**会过期的下载签名 URL。新增 `examples/seedance-production.json`、`examples/seedance-resume.json`（API 格式，含结构测试）与 `web/js/video_flow_status.js`（最小状态展示，带 `try/catch` 降级）。测试：`.venv/bin/python -m pytest tests/test_client.py tests/test_nodes.py -q` 共 56 通过，含 pending→running→archiving→ready 全程同一 taskId、超时只发 GET 不创建、archiving→failed 给 `DELIVERY_FAILED`。

**尚未完成（需真实 ComfyUI 环境，本机无法验证）：** 节点 UI 的阶段展示扩展尚未在真实 ComfyUI 中验证；两份模板目前是 API 格式而非真实 ComfyUI 导出的 UI 格式；尚未在自定义 output 路径与重启后的主实例上做导入/执行/重新取片验证（先接 T00 假服务，真实 Provider 留到 T12）。

最小目录实现及回归：

```python
def default_output_dir() -> Path:
    import folder_paths
    return Path(folder_paths.get_output_directory()) / "video-flow"

def test_runtime_output_override(monkeypatch, tmp_path):
    import sys
    from types import SimpleNamespace
    monkeypatch.setitem(sys.modules, "folder_paths",
                        SimpleNamespace(get_output_directory=lambda: str(tmp_path)))
    assert nodes.default_output_dir() == tmp_path / "video-flow"
```

额外状态序列用例必须覆盖 pending → running → archiving → ready，只返回同 taskId；running → timeout 无 create；archiving → failed 给 DELIVERY_FAILED。运行：Client `.venv/bin/python -m pytest tests/test_nodes.py tests/test_client.py -q`，然后实际 ComfyUI 执行两份模板。建议提交：`feat: complete ComfyUI wait and download workflow`。

### T09：持久日志、脱敏与一条 taskId 查询

**修改：** `packages/worker/executor.py`、`submission_journal.py`、`docker-compose.yml`、`.env.example`；Backend `src/v1/admin/v1-task-operations.controller.ts`。
**新增：** `packages/worker/audit_log.py`、`tests/test_audit_log.py`；`packages/backend/src/tasks/task-report.service.ts`、对应 spec；`scripts/video_flow_task_report.py`、`scripts/tests/test_task_report.py`。
**接口：** Admin Guard 的 `GET /api/v1/admin/tasks/:taskId/report` 汇总 Task/Attempt/Asset/预算/最后错误/事件关联键。CLI `--task-id ID --base-url URL` 使用 `VIDEO_FLOW_ADMIN_TOKEN_FILE`；默认不打印完整 Prompt/素材签名，只提供有权限的查询线索。报表只读，不隐式修复。

- [x] 统一事件字段 at、level、event、taskId、attemptId、providerTaskId、stage、code、requestId；脱敏工作在写日志前进行，不依赖日志采集器兜底。
- [x] 服务端目录建议 `/data/video-flow/audit`，root/服务用户受限权限；Backend 和 Worker 子目录分开，覆盖准入拒绝、预占/结算、生成提交、归档失败与人工处置。本条是部署目标，不在开发时写生产目录。
- [x] 把现有完整 URL/异常响应打印替换为脱敏事件；HTTP status、Provider request ID、错误分类可以保留，URL query、Authorization、Prompt 不入普通日志。
- [x] task_report 返回记录关联，不把“没有事件表”写成“没有记录”；对应日志不可读或被轮换时明确 evidence_missing。
- [x] 人工恢复、额度核实留下 operator 声明、时间、reason/evidenceRef、前后状态；管理员共享 token 不假装能自动识别个人。
- [x] 在测试容器重建后仍能按 taskId 查旧日志；按保留期轮换，未结案 journal 不随普通日志删除。

**完成状态（2026-09-13）：** 以上检查项均已实现。Worker 新增 `audit_log.py`：`sanitize_event` 递归处理任意结构——敏感键（按词切分匹配 token/authorization/prompt/signature 等，`idempotencyKey` 这类无害字段不会被误伤）整字段替换为 `[redacted]`，URL 的 query、fragment 与 userinfo 一律剥掉（独立出现或嵌在错误消息里都处理），脱敏在写盘前完成、不依赖下游采集器。`AuditLog` 按天写 `events-YYYY-MM-DD.jsonl`（目录 700/文件 600，同步 flush+fsync），`emit` 的字段固定为 at/level/event/taskId/attemptId/providerTaskId/stage/code/requestId，标准输出同样脱敏（容器日志也是泄漏面）。`read`/`evidence_status`/`rotate` 分别支持按 taskId 查询、说明证据可用性、按保留期轮换；轮换**只删 events-*.jsonl**，`submissions.jsonl` 与 `SUBMISSIONS_BLOCKED` 属于未结案任务的应急证据不受保留期影响。executor 的 17 处打印（完整 Provider 结果 URL、OSS 签名 URL、各类异常响应、认领/恢复失败等）改为 `_audit_event` 事件，保留 HTTP 状态、Provider 任务 ID 与错误分类；新增交付成功事件记 objectKey（不是会过期的下载地址）。Backend 新增 `src/audit/audit-log.service.ts`（后端侧脱敏写入器，与 Worker 同一套规则）与 `src/tasks/task-report.service.ts` + `GET /api/v1/admin/tasks/:taskId/report`（Admin Guard，**只读**）：汇总 task/attempts/assets/budget/lastError/correlation，并在 `evidence.sources` 里逐条说明证据来源与可用性——数据库记录数、worker-audit 的 available/reason（`audit_dir_not_configured`/`evidence_missing`/`audit_dir_not_readable`）与匹配事件数，绝不把"没有事件表"写成"没有记录"。人工处置留痕：`resume-delivery` 与 `budget-review` 都写审计事件（operator 声明、reason、evidenceRef、before/after、`operatorIsDeclaredClaim: true`），不假装共享 token 能识别具体个人。compose 与 `.env.example` 拆成 `VIDEO_FLOW_AUDIT_DIR`（各自子目录）与 `VIDEO_FLOW_WORKER_AUDIT_DIR`（Backend 读 Worker 事件），共用同一个持久卷。新增 `scripts/video_flow_task_report.py`：凭证只从 `VIDEO_FLOW_ADMIN_TOKEN_FILE` 读取，默认只打印摘要（脱敏后再输出），证据缺口写 stderr，只读不修复。

**说明（超出 ROADMAP 列出的文件）：** 为满足"人工处置留痕"与"Backend 和 Worker 子目录分开"，新增了 ROADMAP 未列出的 `src/audit/audit-log.service.ts` 与 `src/audit/audit.module.ts`。测试：Worker 165 通过 / 26 跳过（含 `tests/test_audit_log.py` 12 个用例与"签名 URL 不进审计"的端到端断言），Backend 179 通过（含 task-report 7 个、v1-task-operations 12 个），脚本 8 通过，合同套件 6 specs / 48 tests 通过。

脱敏函数合同：`sanitize_event(event: dict) -> dict` 从 audit_log 导出；全字段递归移除 token/authorization/prompt，并对 URL 去 query。

```python
import json
from audit_log import sanitize_event

def test_sensitive_material_does_not_reach_logs():
    event = sanitize_event({"taskId": "t1", "Authorization": "Bearer secret",
                            "prompt": "private", "url": "https://oss.test/a?Signature=secret"})
    output = json.dumps(event)
    assert "secret" not in output
    assert "private" not in output
    assert "t1" in output
```

运行：Worker `venv/bin/python -m pytest tests/test_audit_log.py tests/test_submission_journal.py -q`；Backend `npx jest task-report v1-task-operations --runInBand`；Worker Python 从仓库根 `packages/worker/venv/bin/python -m pytest scripts/tests/test_task_report.py -q`。建议提交：`feat: add durable task audit and read-only reports`。

### T10：有效心跳、最小巡检及通知闭环

**修改：** `packages/worker/main.py`、`executor.py`、`config.py`；Backend `src/v1/admin/v1-task-operations.controller.ts`、`task-budget.service.ts`；`docker-compose.yml`、`.env.example`、`docs/runbooks/deploy-and-rollback.md`。
**新增：** `packages/worker/health_state.py`、`tests/test_health_state.py`；`scripts/video_flow_monitor.py`、`scripts/tests/test_monitor.py`。
**接口：** Worker /health 为进程存活；新增仅内部可达的 /ready，返回 loopAlive、backendLastOkAt、providerPollLastOkAt、activeTaskId、admissionPaused，不暴露 token/敏感配置。Backend Admin `GET /api/v1/admin/operations/health` 返回 DB 状态、队列年龄、review/交付失败数量、全局暂停原因。

- [x] 心跳与实际执行进展分开：后台执行 task 已结束/异常则 ready=false，不能独立每秒更新时间伪装执行正常；长任务正常轮询视为存活。
- [x] 引入最小持久 ProductionGate（T02 migration 一并创建）：id=production、paused、reason、updatedAt；默认暂停。Admin `PATCH /api/v1/admin/operations/production-gate` 控制开关，暂停只拦新准入/未提交领取，不阻断原任务查询归档。
- [x] 监控脚本只自动暂停，不自动解除暂停；解除须管理员核实原因并留审计。每分钟读取内部健康与受控统计，按第 6 节阈值告警；磁盘严重不足或费用不确定时暂停。监控凭证从文件读取，网络面不增加公开可执行接口。
- [x] 同一问题首次通知、持续问题去重、恢复通知；回执记录 taskId/告警类型/时间/通知结果。通知失败明确非零退出并保留待通知记录。
- [x] 配置 `VIDEO_FLOW_ALERT_WEBHOOK_FILE`，实际渠道由 Steven 指定；未配置只可 dry-run，不允许据此签收真实告警。开关更新与通知操作记录审计。
- [ ] 宿主计划任务检查巡检/备份回执是否超时；另用已有外部可用性渠道检查整机失联。没有外部接收渠道时不把“整机失联可告警”勾成完成。
- [ ] 测试正常长生成不误判、主循环崩溃、DB 不通、review、磁盘阈值、通知失败、恢复通知；上线时触发一条无付费测试告警并由责任人确认收到。

**完成状态（2026-09-13，代码部分）：** 具备代码的检查项均已实现。Worker 新增 `health_state.py`：主循环存活（崩溃/取消即 false）、循环推进（停滞超窗即不健康）、活跃任务的 Provider 轮询（停滞即不健康，**循环空转不能掩盖执行卡住**）三者分开记录，长任务只要轮询正常推进就视为存活；`mark_backend_error` 的原文在快照里先脱敏（顺带修掉 `strip_url_secrets` 只处理"整串是 URL"的缺陷，嵌在错误消息里的 URL 现在也会去 query）。`main.py` 的 `/health` 只返回进程存活且不再回报配置，新增内部 `/ready` 返回 ready/loopAlive/backendLastOkAt/providerPollLastOkAt/activeTaskId/admissionPaused 等字段（不含 token 或配置）；executor 在循环、任务开始/结束（finally 保证清理）、Backend 调用、Provider 轮询四处打点。Backend 新增 `src/v1/admin/v1-operations.controller.ts`：`GET /api/v1/admin/operations/health`（库状态、队列数量与最老 pending 年龄、requires_review/交付失败/费用待核实数量、全局暂停原因；库不通时仍返回结构，便于区分"服务挂了"与"库连不上"）与 `PATCH /api/v1/admin/operations/production-gate`（暂停只需 reason；**解除必须带 reason/operator/evidenceRef** 并写审计事件，before/after 一并留痕）。新增 `scripts/video_flow_monitor.py`：`evaluate_checks(snapshot)` 为纯函数，按第 6 节阈值输出 code/severity/action/taskId；`GENERATION_STALLED` 只标记关注并要求查询原任务（不宣告免费失败、不自动再生成），费用不确定与磁盘 ≥90% 直接 `pause_admission`；只自动暂停、**从不自动解除**；首次/持续/恢复三类通知 + 回执（含 taskId 与送达结果），通知失败非零退出并把待通知记录写入状态文件供下一轮重试；webhook 未配置时只 dry-run 且明确提示不能据此签收。凭证与渠道 URL 都从文件读取，巡检脚本不新增任何公网可执行接口。`.env.example` 与 runbook 同步（含 `/ready` 只允许内部访问、宿主巡检与整机失联的边界）。测试：Worker 182 通过 / 26 跳过（health_state 10 个、readiness 4 个），Backend 185 通过（v1-operations 6 个），脚本 21 通过（monitor 12 个，覆盖长生成不误判、主循环崩溃、DB 不通、review、磁盘阈值、通知失败、恢复通知、只暂停不解除）。

**尚未完成（需部署环境与外部渠道）：** 宿主计划任务检查巡检/备份回执超时、以及用外部可用性渠道验证"整机失联可告警"这两项依赖实际宿主与通知渠道，未在开发环境勾选；上线时"触发一条无付费测试告警并由责任人确认收到"同样待部署后执行。

纯检查函数合同：`evaluate_checks(snapshot: dict) -> list[dict]` 由 monitor 导出，不负责写状态或发送请求；每项返回 code/taskId/severity/action。

```python
from video_flow_monitor import evaluate_checks

def test_review_task_is_actionable_without_metrics_platform():
    alerts = evaluate_checks({"requiresReviewTaskIds": ["task-1"]})
    assert any(a["code"] == "REQUIRES_REVIEW" and a["taskId"] == "task-1" for a in alerts)
```

运行：Worker `venv/bin/python -m pytest tests/test_health_state.py -q`；仓库根 `packages/worker/venv/bin/python -m pytest scripts/tests/test_monitor.py -q`。建议提交：`feat: monitor worker progress and production admission`。

### T11：跨包故障回归、安装包与交付手册

**修改：** `scripts/run_mvp_contract.sh`、`scripts/tests/fake_provider.py`、`.github/workflows/ci.yml`；`packages/comfyui-video-flow-client/install.sh`、`tests/test_delivery_scripts.py`、`README.md`；`docs/runbooks/creative-user-guide.md`、`docs/runbooks/deploy-and-rollback.md`。
**新增：** `packages/worker/tests/test_mvp_live_contract.py`、`scripts/tests/test_acceptance_cli.py`；隔离测试用的本地可解码短视频 fixture（由测试生成，不上传生产素材）。
**接口：** 跨包测试复用 T00 服务，不 mock 掉真实 Backend/DB/Worker 序列；fake Provider 记录每个测试关联 key 的 create 次数。installer 复制 receipts.py、examples、web 等新资源，不能只更新旧文件白名单。

- [ ] 将下方矩阵逐项实现为跨包自动用例，provider_count、Task/Attempt/Asset/预算、日志都必须断言；测试异常不能被预期 skip 吞掉。E03/E05/E08/E10/E11 已实跑，E04/E12 仍需外部/专属 fixture。

**跨包用例（2026-09-13 已通过）：**
已完成且已验证的部分：Fake Provider 按提示词统计 `createCountsByKey`（跨包用例据此断言"同一意图只创建一次"）；新增 `packages/worker/tests/test_mvp_live_contract.py`（真实 Worker 代码 + 真实 Backend/DB + Fake Provider，覆盖"预览不创建 Provider 任务"与"重跑不产生第二次 create"），默认由 pytest marker 排除、缺环境直接失败而不是 skip；`scripts/run_mvp_contract.sh` 增加独立 Backend 实例与素材/凭证/准入准备，并把该段放在 `VIDEO_FLOW_RUN_LIVE_CONTRACT=1` 开关之后（默认关闭，避免未通过的用例把整套合同染色成绿）。装载器 `install.sh` 已补 `receipts.py`、`examples/`、`web/`，并有安装测试断言这些资源确实送达且备份仍在 `custom_nodes` 之外；两份手册已补"ComfyUI 出片路径与 generation_version 的付费含义""超时恢复/费用未知/报障 taskId"与"管理员查询/恢复/暂停/迁移备份回滚"。

**排查结论（值得记住）：** 失败根因是**适配器在密钥为空时仍拼出 `Authorization: Bearer `**（尾部空值构成非法头），httpx 直接拒绝，于是每次提交都被误判成"结果不确定"——真实原因"没配密钥"被完全掩盖。合同环境按规约不允许配置 Provider 密钥，所以这个缺陷只在跨包链路里暴露。已修：空密钥不再发送该头（真需要鉴权的 Provider 会返回 401，那是明确拒绝），并补了三条单测。顺带补齐：Fake Provider 现在真的提供一份**本地生成、ffprobe 可解码**的短视频 fixture（`scripts/tests/fixtures/contract-clip.mp4`，2KB/64×64/H.264），供归档链路真实下载；其地址可通过 `VIDEO_FLOW_FAKE_PROVIDER_PUBLIC_URL` 切换，为 Docker 场景的 `http://fake-provider:19091` 寻址留好接口。

**完整交付链路也已跨包验证（2026-09-13）：** Fake Provider 增加对象存储替身（PUT/HEAD/GET 兜底路由；oss2 会丢弃 endpoint 的路径部分，所以必须放最后兜底），Worker 侧新增 `OSS_CNAME` 开关把请求直接打到替代 endpoint（生产保持 False）。跨包用例现在断言的是**真的交付成功**：下载短视频 → 上传 → HEAD 校验 → 登记 Asset → `delivery.status=ready`，并同时断言 Provider create 恰好一次、重跑沿用原 providerTaskId。E06 的核心不变量与 E07 的"交付不假报 ready"由此有了端到端覆盖。

**Worker 重启恢复已真实验证（2026-09-13）：** 新增跨包用例用**真正退出/启动的独立 Worker 进程**验证 E06：先让 Fake Provider 停在 `running`，轮询接口等到 `providerTaskId` 落库（这就是确定的中断触发点，不靠 sleep 猜时机），随即 `SIGKILL` 第一个进程；再把 Provider 切到 `succeeded` 并启动第二个进程——它凭已落库的 ID 恢复轮询并交付就绪，Provider create 总数仍为 1、`providerTaskId` 未变。为此给 Fake Provider 加了 `GET /__test__/task-status` 开关。

**Docker 服务名寻址已显式验证（2026-09-13）：** 新增 `scripts/run_docker_provider_addressing.sh`：在合同 compose 里起容器化的 Fake Provider，用**容器内的真实适配器**打 `http://fake-provider:19091/api/v3` 创建任务并回读统计。这条验证抓到一个真实缺陷——Fake Provider 原先只监听 `127.0.0.1`（容器内的 loopback），同网络的其它容器能解析服务名却连不上；现在监听地址可配（`VIDEO_FLOW_FAKE_PROVIDER_HOST`），容器里绑 `0.0.0.0`，宿主机仍绑回环。该检查已加入 CI 的合同 job。

**准入边界也已跨包验证（2026-09-13）：** 新增 E02/E13 用例——没带凭证 401、凭证无效 403、非法规格 400、全局暂停 503，四种拒绝之后 Fake Provider 的 create 计数必须一动不动（返回码本身证明不了"没花钱"）；并验证暂停只拦新准入、已有路径仍可用，恢复暂停走带 reason/operator/evidenceRef 的受控接口。过程中确认了两个既有约定：凭证守卫是"没带 401 / 无效 403"，以及**空凭证时不能拼出 `Bearer `**（httpx 会本地拒绝，那样测到的就不是服务端行为）。

**2026-09-14 更新：** E03（同意图并发）、E05（提交响应缺 ID）、E08（usage 缺失）、E10（自定义输出目录与重启不重复 create）、E11（跨 owner 读取与 Worker 私有接口拒绝）已做成跨包合同并实跑通过。E04 仍需要独立的生产白名单 Actor、专属输入 Asset 和精确额度 fixture；E12 仍需要真实容器重建及外部告警通道，不能以本地替身宣称完成。
- [x] Worker restart 用真正退出/启动测试进程验证；用读取数据库持久化 providerTaskId 作为中断触发点，不依赖固定 sleep 猜时机。
- [x] 安装测试覆盖新增 Python 模块与前端资源、两个模板、备份位于 custom_nodes 之外；不改同事其他自定义节点。
- [x] CI 分开显示单元、合同、预期外部 workflow skip；跨包合同不得使用真实 Provider 凭证，漏跑应失败而不是跳过。
- [x] Worker 与 Fake Provider 都运行在 Docker 时，显式验证 `http://fake-provider:19091/api/v3` 的服务名寻址；仅宿主机合同脚本使用 `http://127.0.0.1:19091/api/v3`。

**说明：** CI 已按层拆成 5 个 job（backend-unit / backend-contract / worker-unit / scripts-unit / comfyui-client），合同层单独成 job 并包含跨包用例；worker 与客户端 job 使用 `-rs` 列出每条 skip 的原因，当前唯一一类"预期外部 skip"是 `test_workflow_contracts.py` 的 3 条——缺"已复核的 ComfyUI 工作流导出"（等真实 ComfyUI 导出补齐后自动转成实跑，属 T08/T12 遗留）。合同脚本与 CI 都加了硬闸门：`VOLCENGINE_ACCESS_KEY` 非空直接失败，跨包用例未收集到 2 条也直接失败。安装测试新增断言：同事其他自定义节点不被触碰。
- [x] 两份手册写明正常使用、generation_version 的付费含义、超时恢复、费用未知、报障 taskId、管理员查询/恢复/暂停、迁移备份回滚。
- [ ] 三包测试、构建、隔离合同和实际 ComfyUI 假服务工作流都通过后才交给 T12；此时只写“待真实验收”。

| 编号 | 注入条件 | 必须断言 |
| --- | --- | --- |
| E01 | Preview | 无 Attempt、无预算预占、Provider create=0 |
| E02 | 有凭证但非白名单/非法输入/超额 | 对应 403/400/429，Provider create=0 |
| E03 | 同意图并发两次 | 一条 Task、一份预占、最多一次 Provider create |
| E04 | 两个新意图抢最后预算 | 仅一个成功准入，另一个拒绝 |
| E05 | Provider 已受理，客户端/提交响应丢失 | 不自动再次 create；可回收原 Task 或 requires_review |
| E06 | Provider ID 落库后 Worker 重启 | 原 ID 恢复并出片，create 总数仍为 1 |
| E07 | Provider 已成功，OSS/Asset/最终回写失败 | usage 与预算事实不丢，交付不假报 ready；原任务修复后 create 总数仍为 1 |
| E08 | 无 usage 或 usage 无效 | 费用 unavailable/review，不写 0；可归档视频但新准入受限 |
| E09 | 同事退出/Wait 超时后重新取片 | 原 taskId，create 增量 0，文件实际可播 |
| E10 | 自定义 output / 下载中断 / 签名过期 | 正确目录；无损保留已有文件；原任务重新签发取片 |
| E11 | 越权 Task/Asset / 错配 Attempt | 拒绝，不泄露视频/任务内容、不篡改其他记录 |
| E12 | 容器重建/日志轮换/告警通道失败 | 关键 journal 仍在；证据缺失可识别；通知失败不报已送达 |
| E13 | 全局暂停/凭证撤销 | 拒绝新准入，已提交原任务仍完成查询归档 |

命令（分别从对应包目录执行，客户端不借用 Worker venv）：

```bash
# packages/backend
npm run build
npx jest --runInBand
npm run test:contract -- --runInBand

# packages/worker
venv/bin/python -m pytest -q

# packages/comfyui-video-flow-client
.venv/bin/python -m pytest -q

# 仓库根
bash scripts/run_mvp_contract.sh
git diff --check
```

客户端 .venv 缺失时按 requirements.txt 单独创建，不能为了“测试绿”删除 SOCKS 用例。媒体 fixture 应经 ffprobe/解码检查；它只能验证文件流程，不能证明真实模型能力。建议提交：`test: cover MVP failure paths and package creative workflows`。

### T12：发布前检查与真实交付签收

**修改：** `scripts/seedance_production_acceptance.py`、`scripts/tests/test_acceptance_cli.py`、相关 runbook；真实验证结果只更新 `docs/PROJECT_STATUS.md`。
**依赖：** T11 全部通过；Steven 明确部署、试点 actor、规格、预算、告警责任人及本次新增付费任务范围。没有这些确认，可以完成脚本开发与本地测试，但不能勾选真实生成验收。
**接口：** 验收脚本默认只查询指定 taskId；新建需显式 create 标志、固定 intentId、actor token 文件及人工确认。取消自动时间戳意图；重启脚本先找回原回执。证据文件包含 version/actor/taskId/attemptId/providerTaskId/usage/costStatus/assetId/objectKey/本地 hash/媒体检查结果。

- [ ] 脚本先用假服务测试默认无 create、缺固定意图拒绝 create、已有 taskId 只查询、completed 无可下载文件不能 PASS。
- [ ] 发布前记录本地/远端 SHA、三包测试、迁移、有效规格、预算设置（不含密钥）；备份数据库并验证隔离恢复。保留旧客户端与镜像回滚点。
- [ ] 部署期间 ProductionGate 暂停、白名单保持受控；执行迁移和健康/鉴权检查。失败时停止新准入，保留新增资金表及已有 Provider 查询能力，不能直接回滚到无额度限制旧版本后继续开放。
- [ ] 在目标同事主 ComfyUI 安装并重启，验证新增模块/五节点/展示扩展/两份模板；确认读到实际 output。
- [ ] 告警测试由责任人确认收到；签收前确认支持时段、人工审核素材与用途、账期核实责任。随后仅按批准范围启用生产开关与该 actor。
- [ ] 同事独立提交一条真实业务样片，等待并播放；研发只观察，不在正常链路后台补数据。保留从生成意图到本地文件的全部关联 ID。
- [ ] 经批准，在 Provider ID 已持久化且仍执行时重启 Worker，核对恢复同一 ID；若时机错过，单独约定验证，不静默新增付费任务。
- [ ] 断开客户端后凭 taskId 重取；记录 create 没有增加，播放/解码、时长/尺寸/音轨符合批准规格。质量判断单列“技术可交付”和“创意是否可用”。
- [ ] 保存费用估算、usage 推算和账单状态；账单未出允许标待核实，但有明确负责人及后续准入约束，不标 billed。
- [ ] 将下方交付签收表全部填证据后才关闭任务；失败留原因/已有 Task ID，不通过重新生成掩盖失败。

脚本离线测试示例（新增 `validate_acceptance_options`，从验收脚本导出）：

```python
import pytest

def test_create_requires_persisted_intent():
    from seedance_production_acceptance import validate_acceptance_options
    with pytest.raises(ValueError, match="INTENT_REQUIRED"):
        validate_acceptance_options(create=True, task_id=None, intent_id=None)
```

测试模块通过 importlib 按路径载入脚本或在 scripts/tests 中固定脚本导入目录；不得在 import 时读取生产 token 或发网络请求。运行：仓库根 `packages/worker/venv/bin/python -m pytest scripts/tests/test_acceptance_cli.py -q`。实际付费命令仅在批准后按更新的 runbook 执行，不把本计划示例当作授权。

| 签收项 | 必须附上的证据 |
| --- | --- |
| 部署版本一致 | Backend/Worker SHA、镜像/迁移、客户端版本 |
| 安全与预算可拒绝 | 鉴权/越权/超额实际返回与无新 Provider 调用证据 |
| 同事真实独立出片 | actor、taskId、Provider ID、时间、主 ComfyUI 结果 |
| 文件可交付 | 本地实际路径、大小/hash、播放与媒体检查 |
| 重启/重取未重提 | 前后同一 Provider ID、关联 Attempt 与 create 日志 |
| 失败有迹可查 | task report、日志/journal、至少一个告警收到的回执 |
| 支持与费用责任明确 | 支持人/渠道/时段、审核说明、费用状态与账期核实责任 |

建议最后分别提交脚本/手册与验收证据：`test: require real artifacts for production acceptance`、`docs: record creative MVP acceptance evidence`。没有真实证据时，禁止使用第二条提交信息宣称验收完成。

### 5.3 每个任务的完成记录

开发者在 PROJECT_STATUS 中写执行事实，本计划只勾验收项/维护剩余任务。每次交接需区分：代码已写、目标测试已过、三包已过、合同已过、已提交/推送、已部署、真实生成已验收。建议证据字段为：

```text
task=Txx
commit=未提交（实际提交后替换为真实 SHA）
checks=命令、退出码、通过/失败数量、证据路径
scope=改动文件和未覆盖分支
production=未操作 / 已获批操作及对应 taskId
remaining=尚未满足的验收项
```

这张记录不代替运行测试，也不代表任务默认完成；本节所有开发任务初始均未勾选。

## 6. 最小监控清单

下列时间/阈值是试点建议值，按生成规格调整，不是 Provider SLA。检查频率建议 1 分钟；通知渠道和响应人上线前确认。

| 检查 | 初始触发建议 | 处置 |
| --- | --- | --- |
| Backend / Worker 不可用或工作心跳停止 | 连续 2 次检查失败 | 告警；检查进程/数据库/通信，不直接重提 Provider |
| pending 无领取 | 超过 2 分钟 | 查 Worker、队列和准入；有正常在途任务时说明排队原因 |
| 生成长时间未结束 | 超过 15 分钟 | 标记超时关注并查询原任务；不宣告免费失败、不自动再生成 |
| requires_review | 任意 1 条 | 即时通知责任人，保留预占；核实 Provider 后再处置 |
| Provider 成功但产物不可交付 | 超过 5 分钟 | 查下载、OSS、Asset、回写，修复原产物 |
| usage 缺失、实际推算超预占、额度异常 | 任意 1 条 | 标记费用待核实，暂停后续准入，人工对账 |
| 日志/输出磁盘 | 80% 告警，90% 停止新准入 | 清理策略须保护未归档产物与未结案证据 |
| 巡检/备份本身失效 | 缺少预期执行回执 | 由宿主定时任务检查；整机失联用外部可用性检查通知责任人 |

无需为了 MVP 先做成功率仪表盘；先保证“卡住有人知道、报 taskId 有处可查”。正式试点开放时段必须有人响应；下班无人处理可关闭新准入，继续完成已提交任务。

## 7. 排期、验收层级与停止条件

建议按 M1 → M2 → M3 → M4 → M5 顺序推进。已有基线不重做；每包保留独立验证与回滚。

| 里程碑 | 交付物 | 是否允许称创意可用 |
| --- | --- | --- |
| M1–M2 | 受控准入、恢复、费用与交付状态正确 | 否，只有服务端边界验证 |
| M3–M4 | 可执行模板、回执、监控与异常处置 | 否，仍需真实生成 |
| M5 | 同事真实出片、播放、恢复与追溯证据 | 是，仅限验收过的规格与试点范围 |
| 后续扩展 | 根据试点问题扩到 2–3 人，观察实际失败与支持量 | 单独评估，不自动开放全员 |

详细拆分约 44 小时，建议按 **6 个每天有效投入 8 小时的工程工作日** 安排；每天投入 6 小时则约 7–8 天。相比上一轮 4–6 天粗估，使用其上沿排期；不是承诺日期，不包含账号权限等待、Provider 服务异常和试点协调。不得通过删除真实验收或额度/恢复控制来压缩排期。若发现迁移、账号或规格限制扩大范围，先汇报影响，不自行扩建平台。

验证必须分层，不能互相替代：

1. 三包 build/test：证明单元与回归。
2. 真实 Backend / PostgreSQL / Worker + 可控假 Provider：证明鉴权、额度、恢复、异常契约；仍未证明真实模型生成。
3. 真实 Provider + 同事主 ComfyUI + 实际视频：证明这条批准路径能交付。

三包命令见 [PROJECT_STATUS.md 第 5 节](./PROJECT_STATUS.md#5-验证命令与实测结果)。真实验收前完成 API runbook、配置/迁移/备份说明；部署、提交推送、离线验证、远端验证、付费调用分别记录。

安全停止条件：身份/素材越权，重复提交风险，未知费用无人核实，额度未生效，关键 ID 无法保存，监控无人接收。停止新准入，不抹掉历史，不把“回滚应用”当作撤销 Provider 任务。

## 8. 上线前由 Steven 确认的事项

规划可以先完成；下列事项确认前不执行付费开放：

- 试点人员与素材范围：建议 1 位创意、公司自有且人工审核的商品图，不开放真人/任意外部素材。
- 批准规格与费用：实际 model、duration、ratio、resolution/audio、单次预算依据、日/月额度和次数；本规划不擅自设定人民币金额。
- 运营责任：谁接告警、谁处理 requires_review、哪个渠道与开放时段；账单何时核对，核实前如何限制继续提交。

推荐下一步按批次 A（T00–T02）开始离线实现；实际生产规格和预算确认前使用测试规格，保持真实 Production 关闭。自动重试、完整账单接入、多角色后台和全量监控，只有试点暴露明确需要后才纳入后续计划。

## 9. 规划修订记录

- 2026-09-11：由原 Phase 0–3 大阶段规划收敛为 M1–M5；移除 Preview 作为创意交付、已完成安全基线的重复施工、3 条样片硬指标和平台化前置要求。保留真实出片、额度与不确定提交保护；将最小监控/追溯提前到首次交付。现状更正只见 PROJECT_STATUS。

- 2026-09-11：进一步拆成 T00–T12 共 13 项任务，补齐共享状态/接口合同、数据库迁移、测试示例、E01–E13 故障矩阵、安装资源清单与真实交付签收；详细工时参考约 44 小时。

## 10. Seedance 2.5 工作流目录扩展计划（2026-09-14）

> **实施前提：** 本节以 Seedance 2.5 的“一个异步创建接口、`content` 多模态输入、任务状态轮询”为基础扩展目录；不因 SDK 或文档出现某能力就开放 Production。实现前先逐条取得当前火山方舟账号与模型版本的字段证据，部署和真实生成仍须单独授权。
>
> **现有实测状态：** 只把已完成真实任务验收的 `seedance.reference-image-to-video.v1` 标为 `production_verified`。所有新增目录项初始为 `preview_only` 或 `disabled`；Preview 只校验、冻结意图、记录 Task，绝不进入 pending 或调用 Provider。

### 10.1 契约来源与证据等级

| 来源 | 可作为依据的内容 | 不能据此推断的内容 |
| --- | --- | --- |
| 火山方舟官方 quickstart 与 Steven 提供的官方原始 SDK/HTTP 示例；索引见 [契约证据](architecture/seedance-2-5-contract-evidence.md#8-steven-提供的火山方舟官方原始示例2026-09-14) | Ark SDK、异步 `id` / `get(task_id)`；`reference_image`、`first_frame`、`last_frame`、`reference_video`；`reference` / `edit` / `extend`、`adaptive`、`duration=-1`、`output_format="mov"` 的已列示组合 | 无媒体纯文生、纯音频参考、未列示的素材数量限制、错误码和默认值 |
| Steven 提供的 Seedance 2.5 能力表 | 产品目录、素材/时长/ratio 的待核对范围、当前业务优先级 | 可直接复制到本账号请求体的 JSON 字段、错误码或默认值 |
| 当前官方 BytePlus ModelArk 文档（仅作同系列交叉参考） | 统一 `content` 输入、异步 `id`、素材类型与上限、`adaptive` 行为、返回末帧概念 | 火山方舟账户必然支持同名字段或相同地区/计费规则 |
| 本项目真实 Production 记录与测试 | 本账号、当前模型和当前部署实际已验证的调用路径 | 未执行模式的生产可用性或最终计费 |

**字段证据规则：** 每个新增 Provider 字段必须记录“官方 URL/SDK 示例 + 摘录位置 + 请求/响应 fixture + 当前模型验收状态”。未取得火山方舟原始证据时，Registry 可以展示为 `disabled`，但 Worker 编译器不得发送该字段。

### 10.2 目标目录与阶段状态

| workflowKey | 创作目的 | 必需媒体角色 | 生成约束 | 初始状态 | 进入 Production 的额外证据 |
| --- | --- | --- | --- | --- | --- |
| `seedance.text-to-video.v1` | 纯文本生成 | 无 | 明确 ratio；时长仅允许当前批准值 | `preview_only` | 当前账号一次成功任务、结果归档、usage/费用记录 |
| `seedance.reference-image-to-video.v1` | 将图片作为创作参考 | `reference_image` ×1 | 当前固定 `5s/720p/16:9` | `production_verified` | 已有真实任务证据；规格变更须重新验收 |
| `seedance.first-frame-to-video.v1` | 指定输出起始画面 | `first_frame` ×1 | `ratio=adaptive`；时长须由 Registry 固定为已取证值 | `disabled` | 素材上传验证、一次真实验收 |
| `seedance.first-last-frame-to-video.v1` | 指定起止画面 | `first_frame` ×1、`last_frame` ×1 | `ratio=adaptive`；两图角色不可互换 | `disabled` | 两图尺寸验证、一次真实验收 |
| `seedance.omni-reference.v1` | 图片/视频/音频作为新片的多模态参考 | `reference_image` 0–30、`reference_video` 0–10、`reference_audio` 0–10；至少一项 | `ratio` 与 `duration` 由已取证的模式策略决定 | `disabled` | 当前账号多素材组合成功、总时长/数量限制测试、成本预占规则 |
| `seedance.video-edit.v1` | 以原视频为基础修改内容 | `reference_video` 至少 1；可附参考图/音频 | `ratio=adaptive`、`duration=-1`；意图必须为 edit | `disabled` | 视频元信息校验、一次真实验收 |
| `seedance.video-extend.v1` | 向前或向后续写视频 | `reference_video` 至少 1 | `ratio=adaptive`；时长由 Registry 固定为已取证值；意图必须为 extend | `disabled` | 方向提示词规则、一次真实验收 |
| `seedance.audio-reference-to-video.v1` | 用音频驱动/参考新视频 | `reference_audio` 1–10；可选图片/视频 | 音频时长、总时长、ratio 均按已取证策略 | `disabled` | 纯音频与图/音组合的原始示例、音频上传验证、一次真实验收 |

“参考图片”与“首帧”是两个不同工作流：前者的角色是 `reference_image`，用于创作参考；后者必须显式是 `first_frame`，用于约束输出开头。不得根据图片数量或节点名称猜测其语义。

### 10.3 统一任务与冻结执行计划

对外请求保持一个入口，不增加“每个工作流一个 HTTP endpoint”。Registry 是唯一允许的 workflow key、媒体角色、数量、文件类型和生成策略来源。

```json
{
  "workflowKey": "seedance.first-last-frame-to-video.v1",
  "mode": "preview",
  "prompt": {"positive": "从@图片1平滑过渡到@图片2"},
  "generation": {
    "ratio": "adaptive",
    "duration": 5,
    "resolution": "720p",
    "generateAudio": false
  },
  "media": [
    {"assetId": "asset-start", "role": "first_frame"},
    {"assetId": "asset-end", "role": "last_frame"}
  ]
}
```

Backend 只接受用户意图，按 Registry 生成并冻结 `executionPlan`：workflow key/version/hash、Provider model、媒体角色与 Asset hash、规范化 generation、已批准的可选输出字段、价格版本和预占金额。Worker 只消费该快照，并把已签发的短期素材 URL 编译为 Ark `content`；不得从前端请求中直传模型、URL、价格或未注册参数。

### 10.4 分批开发任务

#### W1：官方契约取证与 fixture 库

- [x] 建立 `docs/architecture/seedance-2-5-contract-evidence.md`，每个模式记录官方 URL、SDK/HTTP 请求、创建响应、终态响应、错误示例和取证日期；以“火山方舟当前模型证据 / 同系列交叉参考 / 本项目实测”标记来源等级。首份矩阵已明确未取证字段。
- [x] 将官方 quickstart 的编辑请求脱敏后保存为测试 fixture；不得保存 API Key、真实临时 URL、真实人物素材或可重放的生产 taskId。
- [x] 已将 Steven 提供的官方示例固化为脱敏 fixture：`first_frame` / `last_frame`、`omni_reference_task_type=reference|edit|extend`、`output_format="mov"`、编辑 `duration=-1` 和延长数值时长。
- [x] 已从 Steven 提供的火山方舟官网 PDF 补齐无媒体纯文生、纯音频参考、`return_last_frame`、素材数量/时长限制、延长方向提示词与 `InvalidParameter.TaskTypeConstraint` / `InvalidParameter.TaskTypeMismatch` 的字段证据；摘要见 [官网 PDF 整理](architecture/seedance-2-5-official-pdf-digest-2026-09-14.md)。
- [ ] 为每个 workflow 补齐当前账号的受控真实验收、项目 Asset 预检与可归档失败样例；未完成前保持 `preview_only` 或 `disabled`。
- [ ] 验收：每个目录项在 Evidence 文档中都有明确“已取证 / 未取证 / 不适用”；任何未取证字段在 Registry/编译器测试中都不可进入 Provider payload。

#### W2：媒体资产能力与上传票据策略

- [~] Backend upload ticket 已支持官网列示的图片/MP4/MOV/WAV/MP3 MIME 与单文件上限，并写入 `mediaType`；尚未完成像素、时长、帧率、数量、总大小/总时长和按 workflow role 的预检。证据：`packages/backend/src/v1/assets/v1-assets.controller.ts`、`v1-assets.controller.spec.ts`。
- [ ] 在 `/complete` 后提取并保存可信媒体元数据；视频编辑/延长在 Provider 调用前验证源视频时长和编码，音频工作流验证格式和时长。无法解析或不符合策略的 Asset 不得进入 Production。
- [ ] 保持 actor 所有权、内容 hash、上传完成校验和 Worker 临时下载 URL；媒体临时 URL 绝不进入 requestSnapshot、回执或日志。
- [ ] 验收：图片、视频、音频的边界值、跨 actor Asset、未完成上传、超数量/超总时长、错误 MIME 均有 Backend 单测与 Worker 契约测试。

#### W3：Registry 与 generation policy

- [x] 已完成基础 Registry：对外创建任务必须提交 `workflowKey`，现有 `seedance.reference-image-to-video.v1` 与 `seedance.text-to-video.v1` 均由服务端注册；旧 `capability/profile/params` 合同已拒绝。当前代码状态见 [PROJECT_STATUS.md](PROJECT_STATUS.md)，该基础不代表新增模式已开放。
- [ ] 将现有 Registry 拆为 `WorkflowDefinition`、`MediaPolicy`、`GenerationPolicy` 和 `ProviderFieldPolicy`；支持固定值、枚举范围、`adaptive`、按模式必填/禁止字段以及 `preview_only` / `disabled` / `production_verified` 生命周期。
- [ ] 先注册第 10.2 节八个键。`disabled` 只可被目录读取，不允许创建 Preview 或 Production Task；`preview_only` 可创建不可执行 Preview；`production_verified` 才可经白名单和额度创建 pending Task。
- [ ] 禁止框架外的 role 组合：首帧/尾帧工作流不能混用 `reference_*`；视频编辑必须有 `reference_video`；音频参考工作流按证据规则限制是否允许纯音频。
- [ ] 验收：每个 workflow 的合法/非法媒体组合、`adaptive` 约束、时长边界、状态转换、旧 task 快照恢复全部由纯函数单测覆盖。

#### W4：Seedance Provider 编译与结果标准化

- [ ] 把 Worker 中的 `media_urls` 临时映射改为按 Registry 冻结角色输出 Ark `content`，并只发送 W1 已证实的 Provider 字段。
- [ ] 为每个已取证模式建立 payload fixture：文生、参考图、首帧、首尾帧、全模态参考、编辑、延长、参考音频。Fixture 只验证 JSON shape，不调用 Ark。
- [ ] 统一读取创建响应 `id` 和终态响应中的状态、视频 URL、可选尾帧、usage/错误；未被 W1 证实的返回字段保留原始受限 payload，不对外编造结构。
- [ ] 验收：Worker 单测验证每个 Registry 快照只产生预期 `content` 项；未知字段、URL 失效、Provider 4xx、5xx/超时均维持当前“不可判定即 requires_review、不自动重提”的规则。

#### W5：ComfyUI 节点与模板

- [ ] 共用一个“创建工作流任务”节点内部实现，按 `workflowKey` 暴露八个名称明确的节点；节点输入只展示该目录项允许的媒体插槽和 generation 参数。
- [ ] Production 节点只展示 `production_verified` 工作流；Preview 节点不得连接 `Wait` / `LoadResult` 的交付链，避免用户把不可执行预览当成出片任务。
- [ ] 生成真实 ComfyUI 导出格式的模板：文生、参考图、首帧、首尾帧、全模态参考、编辑、延长、音频参考、恢复下载各一份。只为当前 Production Verified 项提供完整 `Create → Wait → LoadResult` 模板。
- [ ] 验收：节点 payload、幂等键、generation version、工作流模板连线及 Production 可见性均有客户端 pytest；实际 ComfyUI 导入验收只在目标实例上执行。

#### W6：逐项 Production 验收与发布

- [ ] 每个 workflow 独立走：Preview 契约 → 隔离 Fake Provider → 单次、明确额度上限的真实任务 → 成片/末帧/费用/归档核对 → 将状态改为 `production_verified`。
- [ ] 真实视频编辑、延长、音频参考在测试前单独确认素材来源与真人肖像授权；不使用未获授权的真人图像、视频或声音。
- [ ] 每次只开放一个新工作流和一个固定规格；发现 Provider 约束与文档不一致时立即退回 `disabled`，保留证据，不用客户端兼容代码掩盖差异。
- [ ] 验收：创意人员只在可见目录中看到已批准的 Production 节点；每个生产任务具备 taskId、冻结快照、Provider ID、交付 Asset 和费用状态。

### 10.5 建议实施顺序与停止线

1. 先完成 W1、W2、W3；此阶段不创建真实任务。
2. 完成 W4、W5 后，所有已取证但未验收的能力最多进入 Preview。
3. 按创意部门优先级依次验收：文生视频 → 首帧 → 首尾帧 → 视频编辑 → 视频延长 → 全模态参考 → 音频参考。参考图片保持现有已验收路径。
4. 任一模式没有火山方舟原始字段证据、对应 Asset 校验或明确的单次预算批准，即停在 `disabled`，不进入 Provider 调用。

**本计划不承诺：** 自动把所有 8 种模式当天开放、沿用旧请求字段、仅凭官方宣传参数估算最终账单、或以 BytePlus 文档替代火山方舟账号验收。
