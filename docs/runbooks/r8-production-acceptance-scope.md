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

## 9. 第二条工作流的长期开放：首帧（2026-09-15）

授权人按 §8 的同一口径（同一 Actor、同样 100 元/日 上限、全部参数、长期有效）开放 `seedance.first-frame-to-video.v1`，供创意同事在生产里直接使用首帧工作流。

| 项 | 值 |
| --- | --- |
| 授权人 / 日期 | kafeichong / 2026-09-15 |
| 工作流 | `seedance.first-frame-to-video.v1`（其余六类保持 `enabled=false`） |
| 可用 Actor | `creative-pilot`（生产白名单内） |
| **允许的参数范围** | 该工作流合同允许的全部组合：480p / 720p / 1080p × adaptive（首帧锁定比例）× 4–30 秒 × mp4 / mov × 有声 / 无声 × 水印可有可无 |
| 金额上限 | 沿用 `creative-pilot` 自身的 `dailyLimitCny` = 100 元/日（服务端强制） |
| 时间窗 | **长期有效，另行通知** |
| 放行时的状态 | `implementation=ready`、`admission.enabled=true`、`validation=not_run`（**真实出片记录要等这轮跑完再补**） |

**必须同时记下的差距**：

1. **这条工作流的真实验收还没开始。** R8 矩阵第 3 行（首帧，4s / 30s）仍然空缺；已跑通的是隔离环境里的 R6.3（真实 ComfyUI Queue + Fake Provider），它证明链路与客户端可用，但**没有任何真实 Ark 出片**。`validation` 保持 `not_run` 是照实写的，不是遗漏。
2. **预占金额取决于首帧图的画幅。** 首帧工作流的输出比例是 `adaptive`，服务端拿首帧实际宽高到合同像素表里找匹配（容差 0.005）：命中 16:9 / 9:16 / 1:1 / 4:3 / 3:4 / 21:9 之一即可锁定尺寸，5 秒 720p 预占 **7.623000** 元；**不命中则退化为按该分辨率像素上界预占**（5 秒 720p 为 **7.671090** 元），偏高但在安全方向。用前建议把首帧裁成标准比例附近，既省预占也少一次拉伸。
3. **准入仍是工作流级**：打开即意味着上表全部参数组合都能提交，而这一条连"已验证的那一档"都还没有。
4. 费用状态仍是推算（`cost.status=usage_calculated`、`billedCny=null`）。

**首轮真实验收已完成（2026-09-15）**：任务 `f6b3732f-d314-4263-81a6-8a96e8218876`（4 秒 / adaptive / 480p / 有声 / 无水印，首帧为本机 769×1163 webp），Provider 任务 `cgt-20260915194409-mw10a`。产物 **528×798 / 97 帧 / 4.064 秒 / 2,677,725 字节**，SHA-256 `e6dd5028…`（OSS 下载件 = 本机成片 = 客户端收据**三方一致**），`verify` 12 项全过、退出码 0。预占 2.841650（`bounded`）→ 结算 **2.793840**（39,912 tokens），**多预留 0.048 元**，安全方向。已写入该工作流的 `validation.records` 并把 `status` 改为 `passed`。

同时记下两条与计费模型有关的观察（写进合同 `pricing.estimate.adaptiveOutputBound`）：

- **锁不住画幅时，Provider 不吸附到我们的像素表**：本例输出 528×798 是首帧自身画幅的等比缩放，**不是表内任何一种尺寸**；`bounded` 的上界（480p 表内最大 21:9 = 428,544 px）这次刚好兜住实际值 421,344 px。
- **未证实的风险**：首帧画幅比 21:9 更宽（>2.33）时，表内最大像素是否仍是上界，**没有验证过**；若否，`bounded` 预占会低估。
- "+1 帧"口径在 adaptive 输出上同样成立（97 帧 = `4×24+1`；`97 × 528×798/1024 = 39,912.47` → Provider 截断记 39,912），这已是第五条真实样本。

要关闭时按 §8 的同一套动作（改回 `admission.enabled=false` 并写明理由、清空测试里的声明项、再部署）。

## 10. 第三条工作流的长期开放：首尾帧（2026-09-15）

授权人按 §8/§9 的同一口径（同一 Actor、同样 100 元/日 上限、全部参数、长期有效）开放 `seedance.first-last-frame-to-video.v1`。

| 项 | 值 |
| --- | --- |
| 授权人 / 日期 | kafeichong / 2026-09-15 |
| 工作流 | `seedance.first-last-frame-to-video.v1`（其余五类保持 `enabled=false`） |
| 可用 Actor | `creative-pilot`（生产白名单内） |
| **允许的参数范围** | 该工作流合同允许的全部组合：480p / 720p / 1080p × adaptive × 4–30 秒 × mp4 / mov × 有声 / 无声 × 水印可有可无 |
| 素材要求 | **恰好两张图**：`first_frame` + `last_frame`，顺序固定 |
| 金额上限 | 沿用 `creative-pilot` 自身的 `dailyLimitCny` = 100 元/日（服务端强制） |
| 时间窗 | **长期有效，另行通知** |
| 放行时的状态 | `implementation=ready`、`admission.enabled=true`、`validation=not_run`（**真实出片记录等这轮跑完再补**） |

**必须同时记下的差距**：

1. **这条工作流的真实验收还没开始**（R8 矩阵第 4 行，4s / 30s）。跑通的是隔离环境里的 R6.4：两张内容与哈希都不同的图（769×1163 与 710×1065）生成两个角色，Provider payload 保持两个不同 URL 与角色顺序，产物落盘可解析——但没有真实 Ark 出片。
2. **输出比例只按首帧锁定**：官方说明首尾帧只锁首帧，**尾帧画幅不一致时会被拉伸**。报价与预占同样只看首帧——首帧命中合同比例表（16:9 / 9:16 / 1:1 / 4:3 / 3:4 / 21:9，容差 0.005）就锁定尺寸（5 秒 720p 预占 `7.623000`），不命中则退化为该分辨率的像素上界（5 秒 720p 为 `7.671090`）。**选图时首帧比例比尾帧重要**。
3. **准入仍是工作流级**：打开即意味着上表全部参数组合都能提交。
4. 费用状态仍是推算（`cost.status=usage_calculated`、`billedCny=null`）。

**首轮真实验收已完成（2026-09-15，两条独立任务）**：`1614cd62-…`（20:03）与 `141babe3-…`（20:05），同一 intent（intentDigest 相同，两次独立出片），5 秒 / 720p / adaptive，首帧 611×917 + 尾帧 717×1051。两条产物均为 **786×1180 / 121 帧 / 5.056 秒**，SHA-256 `f2a6dba7…`、`79007caf…` 各自三方一致，`verify` 均 12 项全过。预占 `7.671090` → 结算 **`7.671580`**（109,594 tokens），两条合计 **15.343160 元**。已写入 `validation.records`，`status=passed`。

三条实测结论：

1. **"+1 帧"口径成立**（第 6、7 条样本）：`121 = 5×24+1`，`floor(121 × 786×1180/1024) = 109,594`，与 Provider 返回逐位吻合。
2. **输出画幅跟随首帧**：首帧 0.6663、尾帧 0.6822、产物 **0.6661** —— 尾帧不参与定画幅（按官方说明会被拉伸，画面是否失真需肉眼确认）。
3. **⚠️ `bounded` 的"表内最大像素即上界"被推翻**：产物 786×1180 = **927,480 px 超过**表内最大 927,408，按旧口径预占少了 7 tokens。合同 `adaptiveOutputBound` 已由 `assumed_sufficient` 改成 `falsified_needs_margin`，代码改为按「表内最大像素 × 1.01」预留（`ADAPTIVE_BOUND_MARGIN`），并把这两条样本钉成回归用例。改后 5s/720p 的 `bounded` 预占为 **`7.747810`**（比实测多留约 1.1%，安全方向）。

## 11. 第四条工作流的长期开放：多模态参考（2026-09-15）

授权人按 §8–§10 的同一口径开放 `seedance.omni-reference.v1`（客户端模板 `seedance-multi-reference-preflight-v1.comfy.json`）。

| 项 | 值 |
| --- | --- |
| 授权人 / 日期 | kafeichong / 2026-09-15 |
| 工作流 | `seedance.omni-reference.v1`（其余四类保持 `enabled=false`） |
| 可用 Actor | `creative-pilot`（生产白名单内） |
| **允许的参数范围** | 该工作流合同允许的全部组合：480p / 720p / 1080p × 21:9、16:9、4:3、1:1、3:4、9:16、adaptive × 4–30 秒 × mp4 / mov × 有声 / 无声 × 水印可有可无 |
| 素材要求 | 参考**至少 1 个**：`reference_image` ≤30、`reference_video` ≤10、`reference_audio` ≤10，合计 ≤50 |
| 金额上限 | 沿用 `creative-pilot` 自身的 `dailyLimitCny` = 100 元/日（服务端强制） |
| 时间窗 | **长期有效，另行通知** |
| 放行时的状态 | `implementation=ready`、`admission.enabled=true`、`validation=not_run`（真实出片记录等跑完再补） |

**这条与前三条最大的不同：单价随「是否含输入视频」切换，且这套算法里的最低用量规则至今没有被任何真实结算验证过。**

| 5 秒 / 720p 的组合 | 预占 | 口径 |
| --- | --- | --- |
| 无输入视频（图 / 图+音） | `7.623000` | 70 元/百万，公式值 |
| 含 2 秒输入视频 | `8.164800` | 42 元/百万，**最低值生效**（`ceil(5×5/3)=9` 秒） |
| 含 5 秒输入视频 | `9.109800` | 42 元/百万，公式值 `(5+5+1/24)` 秒 |
| 30 秒输出 + 5 秒输入视频 | `45.360000` | 42 元/百万，最低值 `ceil(30×5/3)=50` 秒 |

1. **"最低 token 规则"是外推的、尚未实测**：`billedTokens = max(公式值, ceil(输出时长×5/3) 秒 × 像素 × 帧率 / 1024)` 是对着官方快查表 96 个数据点逐位核对出来的（见合同 `pricing.inputVideoMinimumTokens`），但**没有一条真实结算验证过它**。本轮含视频的那几条就是它的第一次真实验证。
2. **这条工作流的真实验收也还没开始**（R8 矩阵第 5、6 行）。跑通的是隔离环境的 R6.5：无视频的图+音组合走完 4 秒与 30 秒两条纵向合同；含视频组合当时因最低用量规则未落地只允许 Preview——该阻塞已解除，报价现在可用。
3. **准入仍是工作流级**，打开即意味着上表全部组合都能提交，包括单价更高、规则未实测的含视频路径。
4. 费用状态仍是推算（`cost.status=usage_calculated`、`billedCny=null`）。

**跑完之后要做的**：把真实 `taskId` / `providerTaskId` / SHA-256 / 帧数 / 预占与结算写进 `validation.records`（`status` 改 `passed`）；含视频的样本要**单独核对最低用量是否真的生效**（对比 `billedTokens`、`minimumTokens` 与 Provider 返回的 `completion_tokens`）。

## 12. 第五条工作流的长期开放：视频延长（2026-09-16）

授权人按 §8–§11 的同一口径开放 `seedance.video-extend.v1`（客户端模板 `seedance-video-extend-preflight-v1.comfy.json`）。

| 项 | 值 |
| --- | --- |
| 授权人 / 日期 | kafeichong / 2026-09-16 |
| 工作流 | `seedance.video-extend.v1`（其余三类保持 `enabled=false`：参考图、视频编辑、音频参考） |
| 可用 Actor | `creative-pilot`、`creative-zhuyang` |
| **允许的参数范围** | 合同允许的全部组合：480p / 720p / 1080p × **adaptive（固定，画幅跟随输入视频）** × 4–30 秒（延长时长）× **mov**（客户端固定，官方要求延长输出用 MOV） |
| 素材要求 | **至少 1 段参考视频**（≤10 段、总时长 ≤30 秒），另可带参考图/音频 |
| 金额上限 | 沿用各 actor 自身的 `dailyLimitCny`（`creative-pilot` 100 / `creative-zhuyang` 300 元/日） |
| 时间窗 | **长期有效，另行通知** |
| 放行时的状态 | `implementation=ready`、`admission.enabled=true`、`validation=not_run`（真实出片记录等这轮跑完再补） |

**必须同时记下的差距与待确认项**：

1. **这条工作流没有真实出片**（R8 矩阵第 8 行）。跑通的是隔离环境的 R6.7：三段参考视频串联、Worker 编译、Fake Provider 收到 `omni_reference_task_type=extend`、产物落盘可解析。
2. **本轮要确认一个语义**：官方「视频延长」范例里，输入一段视频、"续写 5 秒"，而**"拼接后的视频"是单独列出的成品**——也就是说**接口可能只返回延长出来的那一段**，需要用户自己拼到原视频后面。实测时必须记录"输出片长 vs 输入视频时长"，据实写入 `validation.records`；如果确实只返回延长段，创意手册要写明拼接这一步。
3. **计费走含输入视频那一档**：单价 42 元/百万，公式值 `(输入视频秒数 + 延长秒数 + 1 帧)` × 像素 × 帧率 / 1024，并受最低用量下限约束（下限路径至今没有真实结算触发过，见 §11）。

**首轮真实验收已完成（2026-09-16）**：任务 `5b1b2f2c-a5d8-4770-927e-05b95203e6f7`（槽内第 3 版），Provider 任务 `cgt-20260916142151-11ick`，5 秒 / 480p / adaptive / mov / 有声，输入为一段 786×1180 / 5.041667 秒的参考视频。产物 **530×794 / 120 帧 / 5.000 秒 / 2,131,354 字节**，SHA-256 `eec338f8…` 三方一致（OSS 重下 = 本机成片 = 客户端收据），`verify` 12 项全过。预占 `4.296180` → 结算 **`4.142418`**（98,629 tokens），**预占偏高**、安全方向。已写入 `validation.records`（`status=passed`）。

**上面第 2 条待确认项已确认，并且额外发现一条口径差异**：

1. **接口只返回"延长出来的那一段"**：输入 5.041667 秒、输出 **5.000 秒**（不是 10 秒）——**必须自己拼到原视频后面**。与官方范例里"拼接后的视频"是单独一件完全一致。创意手册已写明这一步。
2. **延长按整帧计费，与生成类不同**：结算 `98,629 = (输入 5.0 + 输出 5.0) 秒 × 530×794 × 24 / 1024` 逐位吻合，而成片恰好 **120 帧 = 5×24**——**没有**生成类那多出的一帧。本实现统一加一帧，所以延长类只会高估（本例多预留 0.154 元），方向安全；**不据单一样本改计费**，已记进合同 `pricing.estimate.reservationAdjustment.note` 作为一条件待复核的差异。

**过程备注**：同一段输入连续两次被平台判为"可能含真人"而拒（`UNRETRYABLE_FAILURE`），换素材后一次通过；另有一次提交因"客户端与后端 ffprobe 版本不同导致容器时长不一致"被拒（`PREFLIGHT_ACTUAL_CONTENT_MISMATCH`），已改为两边都取**流时长**并部署。

## 13. 剩余两条工作流的一次性放行：音频参考 + 视频编辑（2026-09-16）

授权人对当时仍未开放的两条工作流给出"全部放行"的授权，口径沿用 §8–§12：**长期开放、全部参数、长期有效**。

| 项 | 值 |
| --- | --- |
| 授权人 / 日期 | kafeichong / 2026-09-16 |
| 工作流 | `seedance.audio-reference-to-video.v1`、`seedance.video-edit.v1` |
| 可用 Actor | `creative-pilot`、`creative-zhuyang` |
| **允许的参数范围** | 合同允许的全部组合。音频参考：480p / 720p / 1080p × 七档比例（含 `adaptive`）× 4–30 秒 × mp4/mov；视频编辑：客户端固定 `duration=-1`、`ratio=adaptive`、`outputFormat=mov`（官方对编辑任务的硬要求） |
| 素材要求 | 音频参考：**只接受 `reference_audio`**（1–10 段、单段 2–30 秒、合计 ≤30 秒），要组合图/视频请改走全模态参考。视频编辑：**至少 1 段参考视频**（4–30 秒） |
| 金额上限 | 沿用各 actor 自身的 `dailyLimitCny`（`creative-pilot` 100 / `creative-zhuyang` 300 元/日） |
| 时间窗 | **长期有效，另行通知** |
| 放行时的状态 | 两条都是 `implementation=ready`、`admission.enabled=true`、**`validation=not_run`（0 条真实记录）** |

**放行先于验收是既定做法**：合同的付费闸门是 `DECLARED_OPEN_WORKFLOWS`（backend spec 与 `scripts/tests/workflow_contract_v2.test.mjs` 各一份），授权写入清单后即可跑真实验收，`validation.records` 在跑完之后补。**但这次两条的 records 都是空的，意味着放行瞬间等于把"从没人跑通过的付费路径"对创意开放**——所以本轮必须紧接着各跑一次真实验收，不要留给创意去踩。

**本轮要专门确认的点**：

1. **音频参考没有输入视频**：不触发输入视频最低用量规则（`minimumTokens=null`），单价走 72 元/百万那一档的公式值；同时要**实测确认"成片音轨是模型生成的、不是你传进去的音频"**（官方口径：生成的有声视频均为单声道，与传入音频的声道数无关）——这条已写进客户端 README 与节点说明，实测要记录实际听到的结果。
2. **视频编辑是 `duration=-1`**：时长由模型结合提示词定，输出可能略短于输入视频（官方约 0.4 秒误差），计费走**含输入视频**那一档（42 元/百万），并受最低用量下限约束；下限路径至今没有真实结算触发过（见 §11 与 §12 的待复核差异）。

**首轮真实验收（音频参考，2026-09-16 已完成）**：放行并部署后立刻跑通。任务 `eb605c34-0c38-4a1d-b807-98fa52ddcd94`、Provider 任务 `cgt-20260916162205-ze5ge`，槽 `r8-audio-reference-5`，5 秒 / 720p / 16:9 / mp4 / 有声，输入一段 10.0 秒 mp3（纯音频，无输入视频）。产物 **1280×720 / h264 / 6,585,443 字节 / 121 帧（探针 5.056 秒，含音轨）**，`verify` 12 项全过，SHA-256 `95eed059…`。预占 `7.623000` → 结算 **`7.623000`**（108,900 tokens × 70 元/百万），**逐位吻合**，"+1 帧"口径在纯音频输出上同样成立。已写入 `validation.records`（`status=passed`）。

**上面第 1 条的实测结论**：成片音轨是 **AAC / 32kHz / 立体声 / 5.056 秒**，与输入 mp3（44.1kHz / 10 秒）不同——与官方"生成的有声视频均为单声道、与传入音频声道数无关"的口径一致（实测是立体声，应以实测为准）；**听感是否与输入音频一致仍需人耳确认**。纯音频确实不触发输入视频最低用量规则：报价 `minimumTokens=null`、`inputVideoSeconds=0.000000`。

**放行当场暴露并修复的一个缺陷（影响全部含音频的工作流）**：首次用真实 mp3 提交正式任务时被 `PREFLIGHT_ACTUAL_CONTENT_MISMATCH` 拒掉——**同一个 10 秒 mp3，容器里的 ffprobe 5.1.9 报 10.03102 秒、本机 8.0.1 报 10.0**（mp3 时长靠帧计数，版本间算法不同）。视频那条 9/15 靠"改读流时长"解决了，音频不行（流时长本身随版本变），因此两边都把**音频时长按 0.1 秒归一**后再比对；音频时长不进入计费公式，粒度足够。已提交 `9f42dd7` 并部署。**注意**：内容寻址的资产复用不会重新检查，按旧代码检查过的音频资产仍带未归一的时长，用同一文件重试会再次被拒——需要换一份内容不同的文件，或另做一次资产重检/数据修复。

**视频编辑**：放行已生效，首轮真实验收按 §3 表格约 9.07 元，**待跑**。
