# Video Flow 项目现状（权威）

> 最后核验：2026-09-11
> 本轮核验方式：只读代码、接口调用链与测试走查；测试、部署和真实生成结果沿用下文注明的前轮核验快照，本轮未重跑、未部署、未创建付费任务。
> 本文是**唯一**描述"系统现在是什么样"的文档。任何历史文档与本文冲突时，以本文为准；如果本文与代码冲突，以代码为准并立即更新本文。

---

## 0. 本轮交付判断

**尚不能宣告可交付创意人员独立使用；也不是重新从零开发。** 已有任务、鉴权、上传、Provider 调用和下载接口，但“有这些组件”不等于“同事从 ComfyUI 一次执行能拿到成片”。此前将 R4 / R7 关闭的口径过宽，本轮重新打开其未完成部分。

| 问题 | 本轮源码证据（仓库根相对路径） | 判断 |
| --- | --- | --- |
| Wait 是否真的等待？ | `packages/comfyui-video-flow-client/nodes.py:105`：只 GET 一次，输出 `task_json` 而不是完成后的 `task_id` | 未形成提交 → 等待 → 下载的执行依赖；节点注册不证明工作流跑通 |
| 视频是否进入用户实际 output？ | `packages/comfyui-video-flow-client/nodes.py:119`：按安装路径推导，没有读取 ComfyUI 运行时 output 设置 | 自定义输出目录可能不一致；结果只返回路径字符串，未证明用户能找到并播放 |
| 重启能否接续原任务？ | `packages/backend/src/tasks/task-claim.service.ts:110` 未展平 Attempt 的 `providerTaskId`；`packages/worker/executor.py:107` 读取展平字段 | 恢复逻辑与真实返回契约不匹配，不能称“恢复已完成” |
| completed 是否必有可取视频？ | `packages/worker/executor.py:525` 起：无 URL 可继续完成；Asset 登记与最终状态回写返回值未检查 | Provider 成功、归档成功、客户端拿到文件三种成功未严密区分 |
| 生成成功但归档失败，费用还在吗？ | `packages/worker/executor.py:554`：usage / 成本在下载、OSS 上传之后才回写 | 中途失败会遗漏已发生的 Provider usage；不能仅靠成功 Task 汇总消耗 |
| 有额度字段是否等于有额度控制？ | `packages/backend/prisma/schema.prisma:161`；`packages/backend/src/v1/tasks/v1-tasks.controller.ts:95` | 字段存在，生产创建路径未执行额度占用和拦截 |
| 能否使用任意输入 Asset？ | `packages/backend/src/v1/tasks/preview-plan.ts:97` 只检查标识存在；`packages/backend/src/v1/internal/v1-worker.controller.ts:26` 按 ID 查询 uploaded Asset | 生产入口缺输入 Asset 与 actor 的归属校验；已知他人 Asset ID 不能仅靠 ID 难猜来保护 |
| 是否完全没有记录？ | `packages/backend/prisma/schema.prisma`；`docker-compose.yml:48`、`:77` | 已有 Task / Attempt / Asset 与 Docker 日志；缺的是可靠写入、关键阶段串联、保留期与有人处理的告警 |

本表属于静态调用链结论，不声称故障已在生产注入复现。核验命令见第 5 节。交付门槛和整改顺序只在 [ROADMAP.md](./ROADMAP.md) 维护。

### 外部能力与本地实现不能混为一谈

2026-09-11 查阅的[火山官方 SDK 任务资源源码](https://raw.githubusercontent.com/volcengine/volcengine-python-sdk/master/volcenginesdkarkruntime/resources/content_generation/tasks.py)具有 create / get / list / delete，并暴露 `resolution`、`callback_url` 等字段。它证明接口入口存在，**不证明当前账号、模型都支持，也不证明 delete 等于免费取消**。

本地 `packages/worker/providers/seedance_adapter.py` 实现提交、查询、轮询与 usage 推算，但未转发 `resolution`，没有列表/删除调用，也没有经核实的 Provider 幂等约定。精确完成百分比、提交前最终账单金额、取消计费语义、无 ID 时的可靠请求匹配，本轮均未建立足够证据；不能将它们写成可保证能力，也不能武断写成平台不支持。创意效果与产品还原度仍需看实际视频，接口返回成功不能代替判断。

---

## 1. 系统定位

让创意同事继续使用自己电脑上的 ComfyUI 与本地模型，通过公司服务器统一调用公司已充值的火山引擎 Seedance，并为身份、任务记录、检测、费用、限额和审计保留稳定扩展点。

```text
同事电脑：ComfyUI + 本地模型 + Video Flow 客户端节点
                        │ HTTPS + 可撤销凭证
                        ▼
公司服务器：Backend(NestJS) + PostgreSQL + Worker(Python) + OSS
                        │
                        ▼
                火山引擎 Seedance
```

冻结边界（见 [architecture/seedance-integration-baseline.md](./architecture/seedance-integration-baseline.md)）：

- 火山生产密钥只在 Worker；OSS 凭证限受信任的服务器组件：Worker 上传，Backend 签发上传/下载 URL 与 HEAD 校验（`docker-compose.yml`、`packages/backend/src/assets/asset-presign.service.ts`）。历史“只有 Worker 持有 OSS 密钥”的文字与实现不符。
- 同事电脑只有 Video Flow 的可撤销凭证，永不接触 Ark / OSS 密钥。
- PostgreSQL 是任务与执行状态的权威数据源；数据库只永久保存 `objectKey`，签名 URL 按需生成。
- 不在服务器上集中部署 ComfyUI 或 Seedance 模型。

---

## 2. 代码结构与规模

| 包 | 技术栈 | 职责 | 受版本控制文件数 |
| --- | --- | --- | --- |
| `packages/backend` | NestJS 12 + Prisma 5.22 + PostgreSQL 16 | v1 对外接口、Worker 私有接口、管理接口 | 55 |
| `packages/worker` | Python 3.13 + FastAPI | 轮询领取任务、调用 Provider、OSS 归档、状态回写 | 36 |
| `packages/comfyui-video-flow-client` | Python（ComfyUI 自定义节点） | 同事本机节点：上传素材、提交任务、查询与下载结果 | 12 |

开发跨度 2026-09-09 → 2026-09-11。前轮生产核验快照为版本 `6d3582e`，包含安全收敛与输出登记/下载接口；不能据此称产物交付闭环验收完成。Production 白名单在该快照中为空，本轮未重新查询远端。

---

## 3. 已经具备的能力（附证据）

### 3.0 当前开发分支进度（尚未部署）

- 2026-09-14：Seedance 2.5 工作流目录的后端请求策略继续收敛。`workflow-registry.ts` 已为八个键声明媒体角色/数量/顺序、generation 约束，以及已取证的 `omniReferenceTaskType` / `outputFormat`；`disabled` 工作流无法再创建 Preview；Production 在预算预占前复验已检查 Asset 的 role 与 MIME/媒体类型匹配。冻结字段已由 `packages/worker/models.py` 保留，但 Ark payload 编译器尚未消费。验证：Backend `npx jest --runInBand && npm run build`（22 suites / 205 tests）、Worker `venv/bin/python -m pytest -q`（189 passed / 26 skipped / 12 deselected）、ComfyUI 客户端 `.venv/bin/python -m pytest -q`（58 passed）。该变更未调用 Ark、未部署、未改变任何 workflow 的 `production_verified` 状态；详见 [ROADMAP W3–W4](./ROADMAP.md#W3registry-与-generation-policy)。
- 2026-09-14：Worker 新增 `seedance_execution_policy.py`，将已冻结的 reference-image、首尾帧、全模态参考、视频编辑和视频延长意图编译为 Ark `content` payload，并在提交前复验角色、顺序、数量、`adaptive` / `duration=-1` 与 `reference/edit/extend` 字段。`executor.py` 已在素材 URL 解析后调用编译器，并通过 `SeedanceAdapter.create_task_payload()` 原样运输；编译失败进入 `requires_review` 且不调用 Provider，已有 `providerTaskId` 的恢复分支不重新提交。验证：`cd packages/worker && venv/bin/python -m pytest -q`（199 passed / 26 skipped / 12 deselected）。未调用 Ark、未部署、未改变任何 workflow 的 `production_verified` 状态。

- `feat/creative-mvp` 隔离 worktree 已完成 ROADMAP T00：新增真实编译 Backend + PostgreSQL 的合同测试入口、仅 loopback 的假 Provider、Provider 测试环境 fail-closed 校验，并修正 `start:prod` 指向实际构建入口 `dist/src/main`。
- ROADMAP T01 已在本分支实现：Production 只接受固定规格和本人已上传的 input Asset，Task 保存 `executionPlan` / `deliveryStatus`，Worker 新提交缺少批准快照时转 `requires_review`，已有 Provider ID 的恢复路径不因此重建任务。证据：`packages/backend/src/tasks/production-spec.ts`、`packages/backend/src/v1/tasks/v1-tasks.controller.ts`、`packages/worker/executor.py`。
- 2026-09-11 只读查询生产 `_prisma_migrations` 确认四个旧 migration 均已登记，实际顺序为 init → execution domain → attempt model → asset hash index。未修改这些旧 migration；新增 `20260910190000_prepare_assets_for_hash_index` 与 `20260911000030_repair_asset_foreign_keys` 后，隔离测试已分别验证全新空库和模拟现有库都能执行 `prisma migrate deploy`，旧 Task 的新增字段保持 null。验证入口：`scripts/run_mvp_contract.sh`。
- 2026-09-11 T01 提交前复验：Backend build + 75/75；Worker 86 通过 / 26 预期跳过；ComfyUI 客户端 19/19；合同测试 10/10、Fake Provider 2/2。合同脚本同时验证空库 migration、模拟现有库升级，以及 Fake Provider 隔离地址。
- 上述仅是开发分支离线证据，未推送、未部署、未开放 Production、未创建真实 Provider 任务。

#### 2026-09-12 ~ 09-13 第二轮执行事实（T02–T11）

按 ROADMAP 逐任务推进，每项单独提交；证据字段沿用 task / commit / checks / scope / production / remaining。
**production 一栏全部为"未操作"**：本轮没有部署、没有开放白名单、没有创建真实 Provider 任务。

| task | commit | checks（命令与结果） | scope |
| --- | --- | --- | --- |
| T02 额度预占 | `0d30d36` | 后端单测 105→含预算 22 用例；合同 `budget` 10 场景 | 全局/actor 双 advisory lock、日任务数上限、`limits` 接口白名单字段 |
| T03 领取边界 | `a1544ab` | `jest task-claim tasks.service legacy-tasks-auth`；合同 `claim-recovery` 9 用例 | claim 在途锁、actor 授权、`ATTEMPT_TASK_MISMATCH`、拒重置 pending |
| T04 提交不确定 | `bc0c1b3` | Worker `test_submission_journal` 13 用例 + 重启对账 | `submission_journal.py`、journal 白名单、启动对账保持暂停 |
| （缺陷修复） | `ecc1497` | `prisma validate` / `generate` | Task 的 `executionPlan`/`deliveryStatus` 重复定义 |
| T05 终态与结算 | `461d791` | `jest task-cost executions`；合同 `provider-outcome` 10 用例 | `task-cost.ts`、outcome 接口原子结算、admin `budget-review` |
| T06 可恢复归档 | `b2483f8` | 合同 `artifact-delivery`；Worker `artifact_delivery` | 稳定产物键、Asset 登记幂等、delivery CAS、`resume-delivery` |
| T07 生成意图回执 | `7acf9c1` | 客户端 56 用例 | 回执命名空间、重试沿用原 key/原 body、`ReceiptUpdateError` |
| T08 等待与模板 | `610ebfe` | 客户端 56 用例（含状态序列） | `wait_for_task`、节点只输出 taskId、`IS_CHANGED`、稳定下载 |
| T09 持久日志 | `3da7e2a` | Worker 165；后端 179；脚本 8 | `audit_log.py` 脱敏、`GET .../report` 只读报表、人工处置留痕 |
| T10 心跳与巡检 | `7eb5fad` | Worker 182；后端 185；脚本 21 | `health_state.py`、`/ready`、`operations/health`、`production-gate`、monitor |
| T11 跨包回归 | `8077d29` `bf76a5d` `ae7e1b8` `7276a94` `f55d43b` `caa35c5` `3d47893`（当前工作树未提交） | 合同 6 specs/48 tests + Fake Provider 5 + 跨包 10 通过 / 2 跳过 | 跨包用例、对象存储替身、Worker 重启恢复、Docker 寻址、CI 分层、手册；E03/E05/E08/E10/E11 已补 |

**本轮在实现过程中发现并修复的真实缺陷**（都不是测试问题，都会影响生产行为）：

1. 预算准入事务用 Serializable 隔离级别与 advisory lock 冲突：后拿到锁的事务用旧快照做预算检查，COMMIT 时才报 serialization 失败，被当成 500 而不是 429。
2. Worker 的「submitted 无 ID 拒绝重提」分支没检查执行快照，短路了带快照任务经 journal 保护的受控重提。
3. `prisma/schema.prisma` 里 Task 的 `executionPlan` / `deliveryStatus` 重复定义，`prisma generate` 完全无法执行（构建一直沿用旧生成产物）。
4. `findRecoverable` 不含 `archiving`，Worker 从 recover 拿到归档中的任务会落进 create 分支**重复扣费**。
5. `Asset.sizeBytes` 是 BigInt 列而 Worker 传 JSON number，产物登记必然 500（此前无测试覆盖）。
6. advisory lock 参数需显式 `::int`，否则 Prisma 按 bigint 传参直接报 42883。
7. 适配器在密钥为空时仍拼出 `Authorization: Bearer `（非法头），httpx 本地拒绝 → **每次提交都被误判成"结果不确定"**，真实原因"没配密钥"被完全掩盖。
8. Fake Provider 在容器内只监听 `127.0.0.1`，同网络的其它容器能解析服务名却永远连不上。

**当前实测（本轮实跑，非历史数字）**：

```bash
cd packages/backend && npx jest --runInBand          # 19 套件 / 185 通过
cd packages/worker && venv/bin/python -m pytest -q   # 常规单测；live_contract marker 默认排除
cd packages/comfyui-video-flow-client && .venv/bin/python -m pytest -q   # 57 通过
packages/worker/venv/bin/python -m pytest scripts/tests -q               # 22 通过
VIDEO_FLOW_CONTRACT_DB_PORT=55433 VIDEO_FLOW_CONTRACT_PROVIDER_PORT=19092 bash scripts/run_mvp_contract.sh  # 6 specs/48 + Fake Provider 5 + 跨包 10 通过/2 跳过
bash scripts/run_docker_provider_addressing.sh       # Docker 服务名寻址
```

**remaining（未完成，且不能靠开发环境完成）**：

- T08 三项：节点展示扩展未经真实 ComfyUI 验证；两份模板目前是 API 格式而非真实导出的 UI 格式；未在自定义 output 路径与重启后的主实例做导入/执行/重新取片。**卡点**：需要一个可运行、可安装节点、可重启的 ComfyUI（本机 Comfy Desktop 的数据根 `~/mylab/ComfyUI` 没有 `.venv`，`install.sh` 需要 ComfyUI 自带 Python；且安装会改动正在使用的环境，待 Steven 确认目标环境与授权）。
- T10 两项：宿主计划任务检查巡检/备份回执超时、外部可用性渠道验证"整机失联可告警"——依赖实际宿主与通知渠道；"上线时触发一条无付费测试告警并由责任人确认收到"同属部署动作。
- T11 两项：E04 需要独立的白名单 Actor、专属输入 Asset 和精确额度 fixture，才能验证两个新意图争抢最后预算；E12 需要真实容器重建与外部告警通道。其余 E03/E05/E08/E10/E11 已做成跨包合同并实跑通过。
- T12 全部：部署与真实创意验收，需生产操作授权。

**本轮所有提交均未推送、未部署。** main 领先 origin/main 41 个提交。

### 3.1 Backend

| 能力 | 证据 |
| --- | --- |
| Preview / Production 双模式：`mode` 缺省为 `preview`；Production 按 actor 白名单 fail-closed | `src/v1/tasks/v1-tasks.controller.ts:62-72`、`src/v1/tasks/production-policy.ts` |
| Preview 结构上不可执行：落 `status='preview'`，而 Worker 只 claim `status='pending'` | `src/tasks/tasks.service.ts:84-106`、`src/tasks/task-claim.service.ts:13-16` |
| 幂等：`Idempotency-Key` 必填 + `(actorId, clientRequestId)` 唯一约束 + 请求体稳定序列化比对 + P2002 并发回读 | `src/v1/tasks/v1-tasks.controller.ts:27-43,79-140` |
| 请求校验：只接受注册的 `workflowKey`、结构化 `prompt/generation/media`；旧 `capability/profile/params` 返回 `WORKFLOW_KEY_REQUIRED` | `src/tasks/workflow-registry.ts`、`src/v1/tasks/v1-tasks.controller.ts`；验证：`cd packages/backend && npm test -- --runInBand` |
| 原子 claim + 5 分钟租约 + 自动创建 ExecutionAttempt | `src/tasks/task-claim.service.ts:22-84` |
| 凭证鉴权：token 只存 `sha256`、可撤销、记录 `lastUsedAt` | `src/auth/credentials.service.ts`、`src/auth/api-credential.guard.ts` |
| Worker / Admin 内部接口用独立服务令牌，`timingSafeEqual` 比对 | `src/auth/worker-service.guard.ts`、`src/auth/admin-token.guard.ts` |
| 素材预签名直传：内容寻址复用 Asset、`/complete` 时用 OSS HEAD 校验 size / mime / sha256；ticket 支持官网列示图片、MP4/MOV、WAV/MP3 和各自单文件上限，记录 `mediaType` | `src/v1/assets/v1-assets.controller.ts`、`src/assets/asset-presign.service.ts`；验证：`npx jest src/v1/assets/v1-assets.controller.spec.ts --runInBand` |
| Worker 登记输出时继承 Task actor，写入 `ownerId`、`inspectionStatus='uploaded'` 与永久 `objectKey`；actor 可按 Task 获取新签名下载 URL | `src/v1/internal/v1-worker.controller.ts`、`src/v1/assets/v1-assets.controller.ts`、`src/assets/assets.service.ts` |
| 数据模型分域：Task / ExecutionAttempt / Asset / ActorCredential；费用四态 `estimated / usage_calculated / billed / unavailable` | `prisma/schema.prisma` |

### 3.2 Worker

| 能力 | 证据 |
| --- | --- |
| Seedance 适配器：提交、轮询、下载、usage 计费 | `providers/seedance_adapter.py` |
| 网络请求异常有 `requires_review` 分支；但 5xx、成功响应缺 ID 等不确定情况未统一归类 | `executor.py:584-601`、`providers/seedance_adapter.py:135` |
| 存在按 `providerTaskId` 恢复轮询的代码；Backend 返回映射缺字段，真实恢复未通过 | `executor.py:104-200`、`src/tasks/task-claim.service.ts:110`（Backend） |
| 有 OSS 归档、Asset 登记、含 `pricingVersion` 的成本审计代码；归档失败与回写失败存在缺口 | `executor.py:524-578`、`recovery.py` |
| ComfyUI 本地 dry-run 通道（生产环境关闭：`COMFYUI_ENABLED=false`） | `executor.py:63-72,376-392` |
| HTTP 探针：`/`、`/health` | `main.py` |

### 3.3 ComfyUI 客户端

| 能力 | 证据 |
| --- | --- |
| 五个节点：`Video Flow Config`、`Seedance Preview`、`Seedance Production`、`Wait Video Flow Task`、`Load Video Flow Result` | `nodes.py` |
| token 来源优先级：`VIDEO_FLOW_TOKEN` > `VIDEO_FLOW_TOKEN_FILE` > `~/.video-flow/token` | `config.py` |
| Preview / Production 使用不同作用域的幂等键，profile / duration / ratio 也纳入稳定键 | `client.py` 的 `stable_idempotency_key()`、`mode_scoped_idempotency_key()` |
| 素材上传带 SHA-256，服务端据此复用 Asset | `client.py:25-72` |
| 结果节点按 Task 请求新签名 URL，流式下载并清理失败的 `.part`；目录按安装路径推导，未适配运行时 output 覆盖 | `client.py` 的 `download_task_result()`、`nodes.py:119` |

### 3.4 部署现状

以下均为前轮核验/历史记录，不是本轮重新执行的远端检查；正式验收前须刷新版本、白名单、主实例与任务状态。

- 服务器：`8.140.49.56:/data/video-flow`，容器 `video-flow-backend` / `video-flow-worker` / `video-flow-postgres`。
- 公网入口：`https://ai.sweetyshell.com/api/` → `127.0.0.1:3100`（Nginx，见 [runbooks/domain-and-https.md](./runbooks/domain-and-https.md)）。
- 旧 `/api/tasks` 的 create / list / pending / findOne 已要求 Admin token，claim / recover / update 要求 Worker token；2026-09-11 公网无凭证验收均返回 401。
- Backend 只监听宿主 `127.0.0.1:3100`；Worker 与 PostgreSQL 不发布宿主端口。生产 `.env` 权限为 `600`，历史 `.env.backup-token-*` 已清理。
- Production 白名单当前为空（对所有人关闭）。
- 版本 `6d3582e` 部署后，5 个历史输出已补齐 owner 与 `inspectionStatus='uploaded'`，Task 中遗留的过期签名 URL 已全部替换为永久 `objectKey`；该回填没有创建 Provider 任务。
- 主 ComfyUI 的客户端文件已更新；隔离运行实例在 `127.0.0.1:8190` 验证五个节点全部注册。当前 Comfy Desktop 主实例启动早于安装，仍需重启后才会在 UI 显示两个新增节点。
- 2026-09-10 完成过一次真实付费出片：Task `e9a0903e-bf99-4c71-b4f1-de4b41436632`，费用 ¥7.623（`usage_calculated`，非账单确认）。该次验收**未**覆盖重启恢复、并发上传、历史迁移与账单对账。
- 2026-09-11 完成 Preview 零付费验收：Task `054a6e53-86f8-4f84-8db4-b5539133b0b9` 落 `status='preview'`、Attempt 为 0；Production 请求返回 403。详见 [runbooks/preview-acceptance.md](./runbooks/preview-acceptance.md)。

---

## 4. 风险登记册

严重度：**P0 = 资金或数据边界缺口，开放前必须解决；P1 = 阻断业务目标或异常处理；P2 = 按需改进。** 所有阶段与处置顺序见 [ROADMAP.md](./ROADMAP.md)，下表不代表已实施。

### P0

| ID | 风险 | 证据 | 影响 | 处置 |
| --- | --- | --- | --- | --- |
| R3 | 额度字段未参与生产准入；无预占、结算与并发原子校验 | `packages/backend/prisma/schema.prisma:161`、`packages/backend/src/v1/tasks/v1-tasks.controller.ts` | 连续提交消耗不可控；仅白名单不足以控制已授权用户费用 | ROADMAP M1 |
| R14 | 生产参数与输入权限校验不足：未限定 duration / ratio / model，也未校验输入 Asset 归属 | `packages/backend/src/v1/tasks/preview-plan.ts`、`packages/backend/src/v1/internal/v1-worker.controller.ts` | 可绕过客户端限制，提交非预期成本参数或使用他人已知素材 ID | ROADMAP M1 |

### P1

| ID | 风险 | 证据 | 影响 | 处置 |
| --- | --- | --- | --- | --- |
| R4 | 输出归属/下载接口已补，但无 URL 仍可完成、Asset/状态回写失败未阻断；输出秒级命名、登记非幂等 | `packages/worker/executor.py:525`、`packages/backend/src/assets/assets.service.ts:65` | completed 可能无可交付视频，修复归档可能新增重复记录 | ROADMAP M2 |
| R6 | 无可持久化自动重试；提交不确定类型覆盖不全 | `packages/worker/executor.py:585`、`packages/worker/providers/seedance_adapter.py:135` | 错误若被当作可重新生成，可能额外付费；人工也缺安全恢复入口 | ROADMAP M2；自动重提不作为 MVP 要求 |
| R7 | Wait 只查一次、输出不衔接、目录硬编码；相同参数无明确“再生成一版”标识 | `packages/comfyui-video-flow-client/nodes.py:83`、`:105`、`:119` | 客户端节点齐全不等于可自助出片；重取与新生成意图不清 | ROADMAP M3 |
| R8 | 已有数据库记录与滚动日志，缺持久结构化事件、有效心跳、告警处置；日志输出签名 URL | `docker-compose.yml:48`、`:77`；`packages/worker/main.py:50`、`executor.py:525`、`:543` | 日志最多按每服务 3 × 10 MB 轮换，不能保证保留天数；healthy 不证明执行循环工作 | ROADMAP M4 |
| R9 | 有请求快照、Prompt 与素材记录，但没有内容审核结论/处置记录；uploaded 只表示上传完成 | `packages/backend/prisma/schema.prisma`、`packages/backend/src/v1/assets/v1-assets.controller.ts` | 素材来源与审核通过不能由上传状态推断 | ROADMAP 试点素材边界与人工审核 |
| R11 | 已有 usage 推算及费用状态，但归档失败前 usage 尚未保存；单价硬编码；无本轮账单核对证据 | `packages/worker/executor.py:554`、`packages/worker/providers/seedance_adapter.py` | 消耗可能漏记，推算不能称最终账单 | ROADMAP M1 / M2 / M4 |
| R13 | PostgreSQL 已持久化任务，但恢复响应未展平 `providerTaskId`，且租约过期未参与领取判断 | `packages/backend/src/tasks/task-claim.service.ts:86`、`:110`；`packages/worker/executor.py:107` | 已存在的 Provider 任务不能可靠接续；不能据此扩容多 Worker | ROADMAP M2；MVP 单 Worker |

### 2026-09-11 已关闭

| 原 ID | 已完成处置 | 验证 |
| --- | --- | --- |
| R1 | 旧任务接口按用途加 `AdminTokenGuard` / `WorkerServiceGuard` | decorator metadata 测试；公网 GET / POST 无凭证均为 401 |
| R2 | Backend 改为 `127.0.0.1:3100`；Worker / PostgreSQL 删除宿主端口 | Compose 配置核对；生产 `ss` 与容器端口核对 |
| R5 | 新增三包 GitHub Actions；客户端增加稳定的包根测试入口 | Backend、Worker、Client 本地全绿；远端 CI 以最新 run 为准 |
| R10 | 删除唯一 `.env.backup-token-*`，生产 `.env` 改为 `600` | 文件名计数为 0；权限检查为 `600` |
| R12 | profile / duration / ratio 纳入稳定幂等键，mode 保持独立作用域 | 客户端幂等测试 |

### 2026-09-13 仍未完成（阻塞在开发环境之外）

- **T08 三项**：节点展示扩展未经真实 ComfyUI 验证；两份模板是 API 格式而非真实导出的 UI 格式；自定义 output 路径与重启后主实例的导入/执行/重新取片未验证。需要一台可运行、可安装节点、可重启的 ComfyUI。
- **T10 两项**：宿主计划任务检查巡检/备份回执超时、外部可用性渠道验证"整机失联可告警"；以及"上线时触发一条无付费测试告警并由责任人确认收到"。需要实际宿主与通知渠道。
- **T11 两项**：E04 仍缺独立白名单 Actor/输入 Asset/精确额度 fixture；E12 仍缺真实容器重建和外部告警通道。E03/E05/E08/E10/E11 已做成跨包合同并实跑通过。
- **T12 全部**：部署与真实创意验收，需生产操作授权。

其中 T08 的三项是本轮唯一"有环境就能立刻做"的：本机 Comfy Desktop 的数据根为 `~/mylab/ComfyUI`，但没有 `.venv`（`install.sh` 要求 ComfyUI 自带 Python），且安装会改动正在使用的环境，需先确认目标环境与授权。

### P2（工程债，按需清理）

- 双状态源 `status` / `taskStatus` 可能漂移（completed 后仍留 `in_progress`）。
- `leaseExpiresAt` 只写不读，多 Worker 可能重复轮询同一 Provider 任务。
- `src/main.ts` 无全局 `ValidationPipe`，v1 DTO 形同未启用。
- `GET /api/tasks` 无分页。
- `v1/admin/credentials` 创建失败 `throw new Error` → 500 而非 400。
- `PrismaService` 被多模块重复 provide。
- Worker 26 项测试跳过，因为 `packages/worker/workflows/` 不存在（仓库外资产）。
- 部分 spec 用 `jest.mock('@nestjs/common')` 替换装饰器，不覆盖真实 Guard 装配。
- `backfill_video_urls.py` 硬编码生产 task id。

---

## 5. 验证命令与实测结果

本轮静态复核（仓库根执行）：

```bash
git status --short --branch
rg -n 'providerTaskId|attachAttempt|findRecoverable' packages/backend/src/tasks/task-claim.service.ts packages/worker/executor.py packages/worker/models.py
rg -n 'class VideoFlowWaitTask|def wait|default_output_dir|stable_idempotency_key' packages/comfyui-video-flow-client/nodes.py
rg -n 'dailyLimitCny|monthlyLimitCny' packages/backend/src packages/backend/prisma/schema.prisma
rg -n 'result_url|create_asset|cost_audit|Completed successfully' packages/worker/executor.py
rg -n 'max-size|max-file' docker-compose.yml
```

以下测试结果是 2026-09-11 **前轮实跑记录**，本轮仅修改文档，未重新执行。历史通过数字不是下一版的固定期望数量。

在提交修复前后都应运行这三条；AGENTS.md 要求三包全绿。

```bash
# Backend：构建 + 单测（期望 13 套件 / 68 测试通过）
cd packages/backend && npm run build && npx jest

# Worker：单测（期望 80 通过 / 26 跳过）
cd packages/worker && venv/bin/python -m pytest -q

# ComfyUI 客户端：使用自己的依赖环境，可从包根运行
cd packages/comfyui-video-flow-client && python -m pip install -r requirements.txt pytest && python -m pytest -q
```

| 命令 | 2026-09-11 实测 |
| --- | --- |
| Backend `npm run build && npx jest` | 13 套件 / 68 测试通过 |
| Worker `pytest -q` | 80 通过 / 26 跳过（6 个既有 deprecation warning） |
| Client（包根、安装自身依赖） | 19 通过 |
| `git ls-files \| grep -iE "token\|\.env"` | 仅为敏感文件名检查；不能据此证明文件内容或整个 Git 历史无泄露 |

> 客户端依赖在 `packages/comfyui-video-flow-client/requirements.txt` 中声明为 `httpx[socks]`。运行客户端测试前必须在客户端自己的环境安装该文件；不要借用 Worker venv。

---

## 6. 测试覆盖的局限（重要）

- **测试全绿 ≠ 链路可用。** 2026-09-10 的评审报告已证明：29 个后端测试全绿时，三条主链路仍然互不匹配。关键路径必须靠端到端契约验证，不能只看单测。
- 鉴权相关改动不能只依赖单测：部分 spec 用 `jest.mock('@nestjs/common')` 替换装饰器，绕过了真实 Guard 装配。涉及鉴权的改动必须补集成验证（真实 HTTP 请求 + 期望 401/403）。
- Worker 的 26 项 skip 覆盖了真实 ComfyUI workflow 解析；这些路径目前**没有**自动回归保护。
- `packages/comfyui-video-flow-client/tests/test_nodes.py` 使用假客户端与临时目录，不证明真实节点图等待、ComfyUI 自定义 output、下载后播放可用。
- `scripts/seedance_production_acceptance.py` 以 completed 与非空 `videoUrl` 判断通过，不足以证明视频已下载并可解码；默认时间戳幂等键也不能用于不加区分地重跑付费验收。
- 跨包用例已经覆盖"预览不创建 Provider 任务""同意图只创建一次""重跑沿用原 ID""完整交付链路""准入被拒不产生费用""Worker 重启恢复""Docker 服务名寻址"，但**仍未覆盖真实 ComfyUI 与真实 Provider**：对象存储与 Provider 都是替身，真实网络、真实配额、真实计费均未验证。
- 合同环境按规约不得持有真实 Provider 凭证（脚本与 CI 都有硬闸门），因此"用真实凭证跑一次"这件事**只能**在 T12 的授权下进行。
