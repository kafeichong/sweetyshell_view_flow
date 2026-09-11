# Creative MVP T00–T01 工作归档

> 归档日期：2026-09-11
> 归档性质：开发过程与验证证据快照，不是当前现状或后续计划的唯一依据。
> 当前现状请看 [PROJECT_STATUS.md](../PROJECT_STATUS.md)，后续计划请看 [ROADMAP.md](../ROADMAP.md)。

## 1. 本轮目标

把“Preview 调试”与“真实可交付生成”拆开，先建立一个不会误付费、能留下证据、可以继续扩展到创意人员使用的 MVP 基线：

- Preview 只验证请求结构和准入计划，不创建 Provider 任务。
- Production 只能使用服务端批准的固定规格和本人已上传的素材。
- Worker 不能从客户端任意参数恢复或覆盖计费规格。
- 合同测试必须运行真实编译后的 Backend、真实 PostgreSQL 和隔离 Fake Provider。
- 个人电脑、公司服务器、Docker 容器的网络地址必须按运行位置区分。

## 2. 完成内容

### T00：隔离合同测试与零付费门禁

提交：`add17c5 test: add isolated production contract harness`

- 新增真实 Nest HTTP + PostgreSQL 合同测试 harness。
- 新增仅绑定 loopback 的 Fake Provider，提供 create/get、计数和故障测试接口。
- 合同环境要求独立数据库、测试标记和非生产 Provider 地址；测试模式下拒绝真实 Provider 密钥。
- `scripts/run_mvp_contract.sh` 负责启动隔离 PostgreSQL 和 Fake Provider，并在退出时清理测试资源。
- 修正 Backend 生产入口为实际构建产物 `dist/src/main`。
- CI 增加合同测试和 Fake Provider 测试入口。

### T01：固定 Production 规格、素材权限和执行快照

提交：`df25a27 feat: enforce owned input and frozen production spec`

- 新增 `ProductionSpec` 解析和参数归一化：只允许 `prompt`、`image_asset_id`、固定 `duration`、固定 `ratio`。
- Production 只允许 `IMAGE_TO_VIDEO + seedance`，必须使用当前 actor 所有且已完成上传校验的 `input Asset`。
- Task 新增可空 `executionPlan` 和 `deliveryStatus`；旧任务不根据历史状态推断交付完成。
- Worker 的 `Job.get_params()` 优先使用 `executionPlan`，Seedance adapter 转发批准的 `resolution`。
- 新的付费提交缺少批准执行快照时写入 `requires_review`，不调用 Provider；已有 Provider ID 的任务仍可恢复轮询。
- 新增本人输入、越权素材、output/pending 素材、自由 URL、多媒体字段、规格越界、幂等重放等合同用例。

## 3. Migration 决策与证据

只读查询公司服务器 `_prisma_migrations` 得到已登记 migration：

```text
20260909000000_init
20260910_expand_execution_domain
20260911000000_add_attempt_model
20260910193000_add_asset_owner_role_hash_unique
```

旧 migration 的登记顺序与目录字典序存在差异，因此没有重命名或修改任何已登记文件。新增：

- `20260910190000_prepare_assets_for_hash_index`：在历史索引 migration 之前为空库预建 `assets`。
- `20260911000030_repair_asset_foreign_keys`：待 `execution_attempts` 创建后补齐外键。
- `202609110001_mvp_execution_plan`：增加 `tasks.execution_plan` 与 `tasks.delivery_status` 可空字段。

合同脚本验证了两条路径：

1. 全新空库直接执行完整 `prisma migrate deploy`。
2. 模拟生产已按历史顺序登记四个 migration，再执行新增 migration；旧 Task 的新字段保持 `NULL`。

## 4. 地址归属

| 组件/位置 | 正确地址 | 说明 |
| --- | --- | --- |
| 创意人员电脑上的 ComfyUI | `https://ai.sweetyshell.com` | 只访问公司 Backend，不持有 Ark/OSS 密钥 |
| 公司服务器上的 Worker | `https://ark.cn-beijing.volces.com/api/v3` | 生产默认地址，Worker 持有 Provider/OSS 凭证 |
| 本机合同脚本 + 本机 Fake Provider | `http://127.0.0.1:19091/api/v3` | 仅同一宿主机测试有效 |
| Docker Worker + Docker Fake Provider | `http://fake-provider:19091/api/v3` | 使用 Docker 服务名，不能用容器内 `127.0.0.1` |
| Backend 与客户端都在个人电脑 | `http://localhost:3100` | 仅本地开发 |

结论：`http://127.0.0.1:19091/api/v3` 是测试地址，不是创意人员使用地址，也不是生产 Worker 地址。

## 5. 验证记录

在隔离 worktree `/private/tmp/video-flow-creative-mvp`、分支 `feat/creative-mvp` 上完成：

```text
Backend build + Jest       75/75 passed
Worker pytest              86 passed, 26 expected skipped
ComfyUI client pytest      19/19 passed
Contract tests              10/10 passed
Fake Provider tests          2/2 passed
```

合同测试未调用真实 Ark，没有生产 Provider 任务、没有生产部署、没有开放 Production 白名单。

## 6. 交付边界

本轮完成的是安全准入和可追溯执行基础，不等于创意人员已经完成真实出片验收。仍需后续完成：

- T02：额度预占、原子准入和全局暂停闸门。
- T03–T06：领取、恢复、Provider 提交回写和费用状态合同。
- T07–T11：交付文件闭环、日志、告警、安装包和跨包故障回归。
- T12：使用真实创意素材和实际客户端完成可播放视频验收。

本归档不代表已授权真实付费调用；Production 规格中的模型、价格和预算仍须上线前由负责人确认。
