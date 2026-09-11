# Video Flow 项目现状（权威）

> 最后核验：2026-09-11
> 核验方式：只读代码走查 + 实跑三个包的测试 + 交叉核对历史文档
> 本文是**唯一**描述"系统现在是什么样"的文档。任何历史文档与本文冲突时，以本文为准；如果本文与代码冲突，以代码为准并立即更新本文。

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

- Server Worker 是**唯一**允许持有火山 / OSS 生产密钥的组件。
- 同事电脑只有 Video Flow 的可撤销凭证，永不接触 Ark / OSS 密钥。
- PostgreSQL 是任务与执行状态的权威数据源；数据库只永久保存 `objectKey`，签名 URL 按需生成。
- 不在服务器上集中部署 ComfyUI 或 Seedance 模型。

---

## 2. 代码结构与规模

| 包 | 技术栈 | 职责 | 受版本控制文件数 |
| --- | --- | --- | --- |
| `packages/backend` | NestJS 12 + Prisma 5.22 + PostgreSQL 16 | v1 对外接口、Worker 私有接口、管理接口 | 53 |
| `packages/worker` | Python 3.13 + FastAPI | 轮询领取任务、调用 Provider、OSS 归档、状态回写 | 36 |
| `packages/comfyui-video-flow-client` | Python（ComfyUI 自定义节点） | 同事本机节点：上传素材、提交任务、查询结果 | 8 |

开发跨度 2026-09-09 → 2026-09-11。生产环境已部署安全收敛版本 `67beb6c`；后续文档与交付脚本提交不改变服务运行逻辑。

---

## 3. 已经具备的能力（附证据）

### 3.1 Backend

| 能力 | 证据 |
| --- | --- |
| Preview / Production 双模式：`mode` 缺省为 `preview`；Production 按 actor 白名单 fail-closed | `src/v1/tasks/v1-tasks.controller.ts:62-72`、`src/v1/tasks/production-policy.ts` |
| Preview 结构上不可执行：落 `status='preview'`，而 Worker 只 claim `status='pending'` | `src/tasks/tasks.service.ts:84-106`、`src/tasks/task-claim.service.ts:13-16` |
| 幂等：`Idempotency-Key` 必填 + `(actorId, clientRequestId)` 唯一约束 + 请求体稳定序列化比对 + P2002 并发回读 | `src/v1/tasks/v1-tasks.controller.ts:27-43,79-140` |
| 请求校验：capability 白名单、profile 前缀、prompt 长度、IMAGE_TO_VIDEO 必须有图 | `src/v1/tasks/preview-plan.ts:59-111` |
| 原子 claim + 5 分钟租约 + 自动创建 ExecutionAttempt | `src/tasks/task-claim.service.ts:22-84` |
| 凭证鉴权：token 只存 `sha256`、可撤销、记录 `lastUsedAt` | `src/auth/credentials.service.ts`、`src/auth/api-credential.guard.ts` |
| Worker / Admin 内部接口用独立服务令牌，`timingSafeEqual` 比对 | `src/auth/worker-service.guard.ts`、`src/auth/admin-token.guard.ts` |
| 素材预签名直传：内容寻址复用 Asset、`/complete` 时用 OSS HEAD 校验 size / mime / sha256 | `src/v1/assets/v1-assets.controller.ts`、`src/assets/asset-presign.service.ts` |
| 数据模型分域：Task / ExecutionAttempt / Asset / ActorCredential；费用四态 `estimated / usage_calculated / billed / unavailable` | `prisma/schema.prisma` |

### 3.2 Worker

| 能力 | 证据 |
| --- | --- |
| Seedance 适配器：提交、轮询、下载、usage 计费 | `providers/seedance_adapter.py` |
| 提交不确定时进入 `requires_review`，禁止自动重新提交 | `executor.py:584-596`、`providers/seedance_adapter.py` |
| 重启后按 `providerTaskId` 恢复轮询；未提交成功的任务放回 pending | `executor.py:104-200`、`recovery.py` |
| 产物归档 OSS 并登记 Asset；成本审计带 `pricingVersion` | `executor.py:524-573`、`recovery.py` |
| ComfyUI 本地 dry-run 通道（生产环境关闭：`COMFYUI_ENABLED=false`） | `executor.py:63-72,376-392` |
| HTTP 探针：`/`、`/health` | `main.py` |

### 3.3 ComfyUI 客户端

| 能力 | 证据 |
| --- | --- |
| 三个节点：`Video Flow Config`、`Seedance Preview`、`Wait Video Flow Task` | `nodes.py` |
| token 来源优先级：`VIDEO_FLOW_TOKEN` > `VIDEO_FLOW_TOKEN_FILE` > `~/.video-flow/token` | `config.py` |
| Preview / Production 使用不同作用域的幂等键，避免 Preview 后正式提交 409 | `client.py:117-126` |
| 素材上传带 SHA-256，服务端据此复用 Asset | `client.py:25-72` |

### 3.4 部署现状

- 服务器：`8.140.49.56:/data/video-flow`，容器 `video-flow-backend` / `video-flow-worker` / `video-flow-postgres`。
- 公网入口：`https://ai.sweetyshell.com/api/` → `127.0.0.1:3100`（Nginx，见 [runbooks/domain-and-https.md](./runbooks/domain-and-https.md)）。
- 旧 `/api/tasks` 的 create / list / pending / findOne 已要求 Admin token，claim / recover / update 要求 Worker token；2026-09-11 公网无凭证验收均返回 401。
- Backend 只监听宿主 `127.0.0.1:3100`；Worker 与 PostgreSQL 不发布宿主端口。生产 `.env` 权限为 `600`，历史 `.env.backup-token-*` 已清理。
- Production 白名单当前为空（对所有人关闭）。
- 2026-09-10 完成过一次真实付费出片：Task `e9a0903e-bf99-4c71-b4f1-de4b41436632`，费用 ¥7.623（`usage_calculated`，非账单确认）。该次验收**未**覆盖重启恢复、并发上传、历史迁移与账单对账。
- 2026-09-11 完成 Preview 零付费验收：Task `054a6e53-86f8-4f84-8db4-b5539133b0b9` 落 `status='preview'`、Attempt 为 0；Production 请求返回 403。详见 [runbooks/preview-acceptance.md](./runbooks/preview-acceptance.md)。

---

## 4. 风险登记册

严重度：**P0 = 可造成资金损失或数据泄露，必须当周解决；P1 = 阻断业务目标或造成大量人工；P2 = 工程债。**

### P0

| ID | 风险 | 证据 | 影响 | 处置 |
| --- | --- | --- | --- | --- |
| R3 | 无任何额度 / 计费闸门：`ActorCredential.dailyLimitCny` / `monthlyLimitCny` 是死字段，无代码读取；无提交前预估与拦截 | `prisma/schema.prisma:139-140`；全仓无引用 | 开放给多人后共享火山账号消耗不可控，出事只能事后反推 | 额度校验上线（ROADMAP Phase 1） |
| R4 | 产物交付闭环断裂：输出 Asset 未写 `ownerId` / `inspectionStatus`，而客户端下载接口要求 `findOwnedUploaded` → 必然 404；`Task.videoUrl` 存的是 7 天有效签名 URL | `src/v1/internal/v1-worker.controller.ts:30-54`、`src/assets/assets.service.ts`（`registerOutput`）、`packages/worker/oss_uploader.py:6,23`、`executor.py:536-537,570` | 出片后无法在 ComfyUI 内直接查看 / 复用；历史 URL 7 天后失效，同事会以为文件被删 | 补 ownerId / inspectionStatus、新增结果节点、`videoUrl` 改存 objectKey（ROADMAP Phase 1） |

### P1

| ID | 风险 | 证据 | 影响 | 处置 |
| --- | --- | --- | --- | --- |
| R6 | 重试不可持久化：schema 无 `retry_count` / `next_retry_at`，限流 / 超时 / 网络类失败统一落 `failed`，标记 `RETRY_NOT_PERSISTED` | `executor.py:598-619`、`prisma/schema.prisma` | 一次瞬时抖动 = 一次永久失败 + 人工重提（可能再次付费） | 补迁移 + 有限自动重试（ROADMAP Phase 1） |
| R7 | 无 Production 客户端路径：客户端无 Production 提交节点，也无真实视频输出节点 | `nodes.py` 仅 3 个节点 | 即使打开白名单，同事也无法自助完成正式出片 | 新增 Production 与结果加载节点（ROADMAP Phase 1） |
| R8 | 可观测性为零：无 metrics / 告警 / 结构化日志 / TaskEvent，失败仅 `print` + docker logs | `executor.py` 全篇 `print` | 排障只能登服务器翻日志；无法回答失败率与消耗 | TaskEvent + `/metrics` + 核心告警（ROADMAP Phase 2） |
| R9 | 无内容安全审核：`inspectionStatus` 只会是 `pending_upload` / `uploaded`，prompt 与图片无合规留痕 | `src/v1/assets/v1-assets.controller.ts`、`assets.service.ts` | 公司账号被用于生成违规内容的合规风险，事后无法举证 | 接入内容安全审核（ROADMAP Phase 2） |
| R11 | 成本只有 usage 推算，从未与火山账单对账；pricing 为代码内硬编码 | `providers/seedance_adapter.py` | 预算与报价不可信，无法交代真实单位成本 | 月度对账流程（ROADMAP Phase 1 首次 / Phase 2 常态化） |
| R12 | 幂等键不含生成参数：`stable_idempotency_key(prompt, image_bytes)` 未含 profile / duration / ratio | `client.py:117-119` | 同图同 prompt 换时长会命中错误任务或误判 409 | 参数纳入幂等键（ROADMAP Phase 1） |
| R13 | 单 Worker、无持久队列；ComfyUI 隔离区仅内存集合，重启即丢 | `executor.py:55-60` | 重启可能重放已提交 prompt；无法安全横向扩容 | 先做"重启不重复计费"验收（ROADMAP Phase 1） |

### 2026-09-11 已关闭

| 原 ID | 已完成处置 | 验证 |
| --- | --- | --- |
| R1 | 旧任务接口按用途加 `AdminTokenGuard` / `WorkerServiceGuard` | decorator metadata 测试；公网 GET / POST 无凭证均为 401 |
| R2 | Backend 改为 `127.0.0.1:3100`；Worker / PostgreSQL 删除宿主端口 | Compose 配置核对；生产 `ss` 与容器端口核对 |
| R5 | 新增三包 GitHub Actions；客户端增加稳定的包根测试入口 | Backend、Worker、Client 本地全绿；远端 CI 以最新 run 为准 |
| R10 | 删除唯一 `.env.backup-token-*`，生产 `.env` 改为 `600` | 文件名计数为 0；权限检查为 `600` |

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

在提交修复前后都应运行这三条；AGENTS.md 要求三包全绿。

```bash
# Backend：构建 + 单测（期望 12 套件 / 63 测试通过）
cd packages/backend && npm run build && npx jest

# Worker：单测（期望 79 通过 / 26 跳过）
cd packages/worker && venv/bin/python -m pytest -q

# ComfyUI 客户端：使用自己的依赖环境，可从包根运行
cd packages/comfyui-video-flow-client && python -m pip install -r requirements.txt pytest && python -m pytest -q
```

| 命令 | 2026-09-11 实测 |
| --- | --- |
| Backend `npm run build && npx jest` | ✅ 12 套件 / 63 测试通过 |
| Worker `pytest -q` | ✅ 79 通过 / 26 跳过 |
| Client（包根、安装自身依赖） | ✅ 14 通过 |
| `git ls-files \| grep -iE "token\|\.env"` | ✅ 无凭证入库（`.env`、`*-actor-token` 已 gitignore） |

> 客户端依赖在 `packages/comfyui-video-flow-client/requirements.txt` 中声明为 `httpx[socks]`。运行客户端测试前必须在客户端自己的环境安装该文件；不要借用 Worker venv。

---

## 6. 测试覆盖的局限（重要）

- **测试全绿 ≠ 链路可用。** 2026-09-10 的评审报告已证明：29 个后端测试全绿时，三条主链路仍然互不匹配。关键路径必须靠端到端契约验证，不能只看单测。
- 鉴权相关改动不能只依赖单测：部分 spec 用 `jest.mock('@nestjs/common')` 替换装饰器，绕过了真实 Guard 装配。涉及鉴权的改动必须补集成验证（真实 HTTP 请求 + 期望 401/403）。
- Worker 的 26 项 skip 覆盖了真实 ComfyUI workflow 解析；这些路径目前**没有**自动回归保护。
