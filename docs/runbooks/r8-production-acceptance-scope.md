# R8 受控正式验收：授权范围清单（模板）

> 用途：R8 会用**真实火山引擎账号**发起付费生成。本清单把这批验收限定在明确的账号、素材、参数与金额上限内，让执行是"照单跑"而不是临场决定。
> 现状见 [PROJECT_STATUS](../PROJECT_STATUS.md)，路线图见 [ROADMAP](../ROADMAP.md#4-逐阶段实施清单)。
> **本清单未填写、未授权前，不执行任何真实付费任务。**

## 1. 授权信息（执行前必须填写）

| 项 | 值 |
| --- | --- |
| 授权人 / 日期 | kafeichong / 2026-09-15 |
| 执行账号（火山方舟） | 生产服务器 `8.140.49.56` 上 Worker 所用的账号（账号名未单独记录） |
| 使用的 Actor ID | `creative-pilot` |
| Production 白名单确认方式 | `VIDEO_FLOW_PRODUCTION_ACTORS=creative-pilot`（部署时已确认生效） |
| **本次金额上限** | **100 元/日**（= `creative-pilot` 的 `dailyLimitCny`，由服务端强制，客户端改不了） |
| 允许的时间窗 | 2026-09-15 当天 |
| 允许的分辨率 | 720p |
| 是否允许 1080p | 否 |

**本次范围：只开第 1 行（文生视频）。** 合同里 `seedance.text-to-video.v1` 被置为
`implementation=ready` / `admission.enabled=true`，其余七类保持关闭；两处不变量测试
（`scripts/tests/workflow_contract_v2.test.mjs`、`workflow-catalog.service.spec.ts`）
同步改为断言"**恰好**声明列表里的工作流是开启的"，任何未声明的开启仍会被抓住。

**收口要求**：跑完后把该工作流改回 `enabled=false`、`reason` 恢复，清空测试里的声明列表，
并把本次的验证记录写进 `validation.records`（工作流 / 模型 / 参数组合 / 软件版本 / 证据引用），
再部署一次。

## 2. 前置动作（按顺序，缺一不可）

1. **先暂停再操作**：`PATCH /api/v1/admin/operations/production-gate {"paused": true, "reason": "...", "operator": "...", "evidenceRef": "..."}`，确认现在没有任何新准入。
2. **备份数据库并验证可恢复**：`bash scripts/run_db_backup_restore.sh`（默认为本机隔离库；发布时把 `VIDEO_FLOW_BACKUP_SOURCE_URL` 指向真实备份）。
3. **记录放行范围**：确认这个账号当前**只能**跑本次要验收的工作流。注意发货源合同是**八类全部 `admission.enabled=false`**——为本次验收放行意味着一次显式的合同改动，必须单独提交、单独记录，验收结束后按第 6 节收口。历史上曾出现单个工作流被悄悄改成 `enabled=true` 而 `validation` 仍为 `not_run` 的情况，本步骤就是为了留痕。
4. **记录基线**：`action` 账号的当日/当月额度、既有预占。

## 3. 验收矩阵与预估费用

预估按已取证的官方口径计算：`token = (输入视频时长 + 输出视频时长) × 长边 × 短边 × 帧率 / 1024`，含输入视频时取与最低用量 `ceil(输出时长 × 5/3) × 像素 × 帧率 / 1024` 的较大者；720p 无视频 70 元/百万 token、含视频 42 元/百万 token。**公开刊例价，非账号成交价**；实际以 Provider 返回的 `usage.completion_tokens` 为准。

| # | 工作流 | 素材 | 输出 | 720p 预估 |
| --- | --- | --- | --- | --- |
| 1 | 文生视频 | 无 | 4s / 30s | 6.05 / 45.36 |
| 2 | 参考图 | 1 张图 | 4s / 30s | 6.05 / 45.36 |
| 3 | 首帧 | 1 张图 | 4s / 30s | 6.05 / 45.36 |
| 4 | 首尾帧 | 2 张不同图 | 4s / 30s | 6.05 / 45.36 |
| 5 | 多模态·图+音 | 图 + 音频 | 4s / 30s | 6.05 / 45.36 |
| 6 | 多模态·含视频 | 图 + 视频(5s) + 音频 | 4s / 30s | 8.16 / 45.36 |
| 7 | 视频编辑 | 1 段视频(5s)，`duration=-1` | 自动解析 | 9.07 |
| 8 | 视频延长 | 1 段视频(5s) | 4s / 30s | 8.16 / 45.36 |
| 9 | 音频参考 | 1–2 段音频 | 4s / 30s | 6.05 / 45.36 |
| | **合计** | | 全部最短 | **约 61.69 元** |
| | | | 全部 30 秒 | **约 371.95 元** |

**建议的收敛做法**：先只跑每项的**最短时长**（合计约 61.69 元）确认链路与计费口径，再按第 5 节决定要不要补 30 秒边界。若只验收部分工作流，按行累加即可。

## 4. 执行方式

工具与退出码见 [deploy-and-rollback.md](./deploy-and-rollback.md) §6.3。逐项流程：

**用客户端的解释器运行本工具**（`preflight` 的素材检查需要 Pillow/ffprobe，那是客户端包的依赖；用错解释器会明确报 `CLIENT_DEPENDENCY_MISSING`）：

```bash
PY=packages/comfyui-video-flow-client/.venv/bin/python
export VIDEO_FLOW_BACKEND_URL=https://ai.sweetyshell.com
export VIDEO_FLOW_TOKEN_FILE=~/.video-flow/acceptance.token

# 1) 上传素材拿 assetId（不付费；同内容会复用已有 Asset）
$PY scripts/seedance_production_acceptance.py upload \
  --file /path/to/reference.webp --out r8-<工作流>-upload.json

# 2) 提交预检拿报价与 preflightId（不付费；只新增一条 PreflightRecord）
#    确认 requestCheck=passed、canSubmit=true，且 reserve 与第 3 节预估一致
$PY scripts/seedance_production_acceptance.py preflight \
  --workflow-key seedance.reference-image-to-video.v1 \
  --prompt "R8 验收：<工作流> <时长>s" \
  --duration 4 --ratio 16:9 --resolution 720p \
  --media reference_image:reference-image:/path/to/reference.webp \
  --out r8-<工作流>-<时长>-preflight.json
# 视频编辑用 --duration -1 --ratio adaptive --output-format mov

# 3) 放行生产后提交下一版（唯一会付费的命令，三道闸门）
$PY scripts/seedance_production_acceptance.py next \
  --slot-id r8-<工作流>-<时长> --preflight-id <上一步的 preflightId> \
  --media <slotId>=<assetId> [--media ...] \
  --idempotency-key r8-<工作流>-<时长> --confirm-spend

# 4) 等完成后取证（只读）
$PY scripts/seedance_production_acceptance.py verify   --task-id <TASK_ID>
$PY scripts/seedance_production_acceptance.py evidence --task-id <TASK_ID> --out r8-<工作流>-<时长>.json
```

- 每个工作流用**各自的执行槽**，不要复用。
- 幂等键由操作者提供并在重试时沿用**同一个**；工具不会自动生成时间戳键。
- 提交结果不确定时**先查原任务**，不要重跑。

## 5. 每项必须记录的证据

对齐 R8 的完成定义，逐项记录：

| 字段 | 来源 |
| --- | --- |
| `taskId` / `attemptId` / `providerTaskId` | `evidence` 命令输出 |
| 冻结执行参数（时长、比例、分辨率、格式、角色顺序） | `executionPlan` |
| 原始 `usage.completion_tokens` | `cost` 与 Worker 日志 |
| 费用状态（`usage_calculated` / `unavailable` / `billed`） | `cost.status`，明确区分推算与账单确认 |
| 产物：对象键、大小、SHA-256、MIME | `artifact` |
| 媒体探测与实际播放 | `artifact.probe` + 客户端播放 |
| 实际测试的时长/比例/分辨率 | 显式写下，**不得把一次 5 秒样片写成"全规格已验证"** |

判定：`evidence` 命令退出码为 0（产物**真的下载并解码通过**、扩展名与 MIME 与冻结 `outputFormat` 一致）。仅 `status=completed` 不算通过。

## 6. 收口（验收结束必须做）

1. **恢复暂停**：按原值把 `production-gate` 设回暂停状态。
2. **收回归纳放行**：把本次为验收打开的工作流改回 `admission.enabled=false`，`validation` 写入本次具体的验证记录（工作流 / 模型 / 参数组合 / 软件版本 / 证据引用），**不允许用一个 `production_verified` 概括整个模型和所有规格**。改动单独提交并记录。
3. **对账**：把每项的实际 `completion_tokens` 与预估值对照，差异写入 PROJECT_STATUS；这正是验证计费口径的机会。
4. **清理**：确认没有残留的进行中任务与未结案预占。

## 7. 明确不做的事

- 不在验收中放宽任何预检、素材验证或预算检查。
- 不使用固定金额兜底、不猜测素材。
- 不批量重跑失败任务；失败先查证据。
- 不在同一次授权里顺带调整其他工作流的状态。
