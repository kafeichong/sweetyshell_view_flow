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

**收口要求**：跑完后把该工作流改回 `enabled=false` 并写明 `reason`，清空测试里的声明列表，
并把本次的验证记录写进 `validation.records`（工作流 / 模型 / 参数组合 / 软件版本 / 证据引用），
再部署一次。**第一轮收口已于 2026-09-15 执行**（结果见第 6.5 节），并在同一天被
**第 8 节的长期开放授权**取代：最终以"开放 + 新计费公式"一次部署，而不是关闭。以后再要
关闭，仍按本节走。

## 2. 前置动作（按顺序，缺一不可）

1. **先暂停再操作**：`PATCH /api/v1/admin/operations/production-gate {"paused": true, "reason": "...", "operator": "...", "evidenceRef": "..."}`，确认现在没有任何新准入。
2. **备份数据库并验证可恢复**：`bash scripts/run_db_backup_restore.sh`（默认为本机隔离库；发布时把 `VIDEO_FLOW_BACKUP_SOURCE_URL` 指向真实备份）。
3. **记录放行范围**：确认这个账号当前**只能**跑本次要验收的工作流。注意发货源合同是**八类全部 `admission.enabled=false`**——为本次验收放行意味着一次显式的合同改动，必须单独提交、单独记录，验收结束后按第 6 节收口。历史上曾出现单个工作流被悄悄改成 `enabled=true` 而 `validation` 仍为 `not_run` 的情况，本步骤就是为了留痕。
4. **记录基线**：`action` 账号的当日/当月额度、既有预占。

## 3. 验收矩阵与预估费用

预估按已取证的官方口径计算：`token = (输入视频时长 + 输出视频时长) × 长边 × 短边 × 帧率 / 1024`，含输入视频时取与最低用量 `ceil(输出时长 × 5/3) × 像素 × 帧率 / 1024` 的较大者；720p 无视频 70 元/百万 token、含视频 42 元/百万 token。**公开刊例价，非账号成交价**；实际以 Provider 返回的 `usage.completion_tokens` 为准。

> **2026-09-15 收口轮起，上表的 4 秒档已整体上移约 0.04–0.06 元/项**：实测真实结算按出片帧数（`输出时长 × 帧率 + 1`）计，预占公式已补上这一帧（见 [PROJECT_STATUS](../PROJECT_STATUS.md) 顶部）。含输入视频的 30 秒档由官方最低用量决定，不受影响；合计随之约 +0.49 元（全部最短）。

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

### 4.2 通过 ComfyUI 客户端执行（人工操作）

也可以走创意同事真实使用的路径：在 ComfyUI 里 Preview → 切 Production → 再次 Queue。
**前提是本机客户端必须从验收环境切到生产**，否则会打到隔离环境、拿不到真实成片。

本机若曾按 [local-manual-test.md](./local-manual-test.md) §3 注入过验收配置，先清掉：

```bash
launchctl unsetenv VIDEO_FLOW_BACKEND_URL
launchctl unsetenv VIDEO_FLOW_TOKEN_FILE
launchctl unsetenv VIDEO_FLOW_RECEIPT_DIR
launchctl unsetenv VIDEO_FLOW_SPEC_VERSION
```

清掉后客户端回落到各自的生产默认值：

| 项 | 回落目标 | 说明 |
| --- | --- | --- |
| token | `~/.video-flow/token` | 即本次授权的 Actor 凭证 |
| 回执目录 | `~/.video-flow/receipts` | 与验收环境的回执分开 |
| backend | `https://ai.sweetyshell.com` | 仅在配置节点没有 widget 值时生效 |

**完全退出并重启 Comfy Desktop**（`launchctl` 的改动只在进程启动时生效）。

⚠️ **必须导入仓库里的模板**，不要用验收环境的副本：

```text
packages/comfyui-video-flow-client/workflows/<工作流>-preflight-v1.comfy.json
```

配置节点的 `backend_url` 取自**画布上的 widget 值**而不是环境变量——`/private/tmp/video-flow-comfy-acceptance/workflows/` 里那些副本写死了 `127.0.0.1:3400`，导入它们会打到隔离环境。仓库模板的 widget 是 `https://ai.sweetyshell.com`。

验收后若要回到隔离环境，按 [local-manual-test.md](./local-manual-test.md) §3 重新注入并重启即可（§7 有清除步骤）。

**人工操作时同样要留意**：Preview 不产生费用；切到 Production 后再次 Queue 才正式提交；客户端显示的是服务端报价。**2026-09-15 收口轮起报价与结算应当一致**（预占已按实测补上出片多出的那一帧，只在 480p 这类非整数像素上多留 1 token）；此前"结算比报价高一帧"的记录见 [PROJECT_STATUS](../PROJECT_STATUS.md)。

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

### 6.5 第一轮收口记录（2026-09-15）

| 收口项 | 结果 |
| --- | --- |
| 放行回归 | `seedance.text-to-video.v1` → `admission={enabled:false, reason:"R8_ACCEPTANCE_INCOMPLETE"}`；`implementation` 保持 `ready`（链路已实测打通，不退回 `incomplete`） |
| 验证记录 | `validation.status=passed`，两条：**4s/720p**（`3614cb63…`）与 **5s/720p**（`d4d41580…`），含模型、参数组合、合同版本与 digest、taskId / providerTaskId / SHA-256 / 帧数 / 预占与结算 / 证据文件路径 |
| 不变量测试 | 两处声明列表清空，并改为断言"**implementation=ready 必须有 validation 记录支撑**"；关闭原因不再钉死单串但必须非空 |
| 计费对账 | 四条真实结算（含 9/14 两条历史付费任务）全部等于 `(输出时长 × 帧率 + 1) × 宽 × 高 / 1024`，预占公式据此修正；旧公式系统性少算一帧 |
| 部署 | 收口本身**未单独部署**；同日按 §8 重新授权开放后，以"开放 + 新公式"一次部署（见 §8 收尾） |
| 未完成 | 矩阵第 1 行的 **30 秒边界**（本轮未跑）、其余七类工作流未验收 |

## 7. 明确不做的事

- 不在验收中放宽任何预检、素材验证或预算检查。
- 不使用固定金额兜底、不猜测素材。
- 不批量重跑失败任务；失败先查证据。
- 不在同一次授权里顺带调整其他工作流的状态。

## 8. 长期开放授权（2026-09-15，第一轮验收收口后）

第一轮验收收口（§6.5）完成后，授权人当天决定把 `seedance.text-to-video.v1` 作为**正式产能开放**，而不是等整个矩阵跑完。**本条是这次开放的授权依据**，也是两处不变量测试（`scripts/tests/workflow_contract_v2.test.mjs`、`workflow-catalog.service.spec.ts`）里声明列表的出处。

| 项 | 值 |
| --- | --- |
| 授权人 / 日期 | kafeichong / 2026-09-15 |
| 工作流 | `seedance.text-to-video.v1`（仍只此一类，其余七类保持 `enabled=false`） |
| 可用 Actor | `creative-pilot`（生产白名单内） |
| **允许的参数范围** | **该工作流合同允许的全部组合**：480p / 720p / 1080p × 21:9、16:9、4:3、1:1、3:4、9:16、adaptive × 4–30 秒 × mp4 / mov × 有声 / 无声 × 有水印 / 无水印 |
| 金额上限 | 沿用 `creative-pilot` 自身的 `dailyLimitCny` = 100 元/日（服务端强制，客户端改不了） |
| 时间窗 | **长期有效，另行通知** |

**必须同时记下的差距**（这是本条授权的真实边界，不是免责声明）：

1. **准入是工作流级的，系统管不住参数。** `admission.enabled` 是布尔量，打开即意味着上表全部组合都能提交——包括 §1 里曾写"否"的 1080p。
2. **真实出片证据只覆盖了很窄的一面**：720p / 16:9 / 4 秒与 5 秒 / mp4 / 有声 / 无水印，共两条任务（见 §6.5）。4–30 秒中的其余时长、其他分辨率、其他比例、mov、无声、水印**都没有真实出片证据**。
3. **计费公式是外推的**：预占按 `出片帧数 = 输出时长 × 帧率 + 1` 计算，依据是四条真实结算（4s/5s/6s，480p 与 720p）；30 秒边界未实测，偏差方向是**多预留**，不会低估。
4. **费用状态仍是推算**：`cost.status = usage_calculated`、`billedCny = null`——"按冻结价格推算的 usage"不等于 Provider 账单确认。

**维持本条授权的条件**：后续验收应把 30 秒边界与常用参数补齐并写进 `validation.records`。要关闭时，把 `admission.enabled` 改回 `false` 并写明理由、同步清空两处测试里的声明列表，再部署一次。

**本条授权已在 2026-09-15 生效**：`main`（`2f5c3e8`）推送后，生产 `8.140.49.56:/data/video-flow` 执行 `git pull --ff-only` + `docker compose build/up video-backend video-worker`（零 migration）。上线 smoke：无凭证入口 401；生产目录 text-to-video = `implementation=ready / admission.enabled=true / validation=passed`（2 条记录）；免费预检 5s/720p 返回 `reserve=7.623000`（补帧后的新公式）；数据不变量 tasks/attempts/reservations 无增量、未结案预占 0；Worker `/health` 正常。
