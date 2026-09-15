# 上线检查与回滚记录（Runbook + 模板）

> 最后更新：2026-09-11
> 用法：每次上线**复制本文件到 `docs/archive/` 之外的发布记录**（或直接在 PR 描述中填写），逐项打勾后归档。
> 事实依据：[PROJECT_STATUS.md](../PROJECT_STATUS.md)、[ROADMAP.md](../ROADMAP.md)

---

## 1. 基本信息

- 任务 / 迭代编号：
- 版本 / 镜像 tag：
- 部署环境：`8.140.49.56:/data/video-flow`
- 负责人：
- 开始时间 / 完成时间：

---

## 2. 上线前检查

- [ ] 数据库备份完成（记录时间与路径）：`________________`
- [ ] 迁移文件与数据库版本核对（migration name / checksum）：`________________`
- [ ] 镜像 tag 与依赖清单确认：`________________`
- [ ] 环境变量核查（只列新增项，不输出密钥值）：`________________`
- [ ] 本地三包测试全绿（见第 5 节命令）
- [ ] 回滚方案已确认，且回滚不需要删表 / 删列

---

## 3. 安全门禁（每次上线必查）

这是防止"公网可直接花钱"的硬门禁。未通过不得上线。

- [ ] 未带凭证访问旧任务接口应被拒绝：

```bash
for p in "" "pending"; do
  curl -sS -o /dev/null -w "GET  /api/tasks/$p -> %{http_code}\n" \
    "https://ai.sweetyshell.com/api/tasks/$p"
done
curl -sS -o /dev/null -w "POST /api/tasks -> %{http_code}\n" \
  -X POST -H 'Content-Type: application/json' \
  -d '{"createdBy":"probe","prompt":"probe"}' \
  https://ai.sweetyshell.com/api/tasks
```

**期望：全部返回 401 或 403。若出现 200/201，说明 PROJECT_STATUS R1 仍未修复，立即停止上线。**

- [ ] 外部端口暴露面检查（期望只剩 443 / 80）：

```bash
ssh root@8.140.49.56 "ss -lntp | grep -E ':(3100|8101|5433)\b' || echo 'OK: no app ports on public interfaces'"
```

- [ ] Worker 与 PostgreSQL 未发布宿主端口（`docker-compose.yml` 中不应存在 `3100:3000` / `8101:8001` / `5433:5432` 形式的全网卡映射）
- [ ] Production 白名单符合本次计划（默认应为空）：

```bash
ssh root@8.140.49.56 "cd /data/video-flow && grep -c '^VIDEO_FLOW_PRODUCTION_ACTORS=.\+' .env || true"
```

---

## 4. 上线步骤

1. 构建并推送镜像，记录 tag 与 image ID。
2. 更新 `video-flow-backend` 容器。
3. 执行迁移：`docker compose exec video-backend npx prisma migrate deploy`。
4. 更新 `video-flow-worker` 容器。
5. 复核 `video-flow-postgres` 与网络连通。
6. 查看启动日志，确认无异常关键字。

---

## 5. 上线后 Smoke Test

### 5.1 接口可用性（v1 为准）

```bash
BASE=https://ai.sweetyshell.com/api/v1

# 1) 无凭证必须拒绝
curl -sS -o /dev/null -w 'no-token v1/tasks -> %{http_code}\n' -X POST "$BASE/tasks" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: smoke-1' \
  -d '{"capability":"TEXT_TO_VIDEO","profile":"seedance","params":{"prompt":"smoke"}}'
# 期望 401

# 2) 带 actor token 的 Preview：不得产生付费执行
curl -sS -X POST "$BASE/tasks" \
  -H "Authorization: Bearer $VIDEO_FLOW_TOKEN" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: smoke-preview-1' \
  -d '{"capability":"TEXT_TO_VIDEO","profile":"seedance","mode":"preview","params":{"prompt":"smoke preview"}}'
# 期望 status=preview、preview.willCallProvider=false

# 3) 幂等：同 key 同请求体返回同一 task id；同 key 不同请求体返回 409

# 4) Production 未授权应 403（白名单为空时）
curl -sS -o /dev/null -w 'production -> %{http_code}\n' -X POST "$BASE/tasks" \
  -H "Authorization: Bearer $VIDEO_FLOW_TOKEN" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: smoke-prod-1' \
  -d '{"capability":"TEXT_TO_VIDEO","profile":"seedance","mode":"production","params":{"prompt":"smoke"}}'
# 期望 403（当前阶段 Production 默认关闭）
```

### 5.2 数据不变量（零付费验收）

```bash
ssh root@8.140.49.56 "cd /data/video-flow && \
docker compose exec -T video-postgres psql -U video_user -d video_flow \
  -v task_id='<PREVIEW_TASK_ID>' \
  -c \"SELECT id, status, task_status FROM tasks WHERE id = :'task_id'::uuid;\" \
  -c \"SELECT count(*) AS attempts FROM execution_attempts WHERE task_id = :'task_id'::uuid;\""
```

- [ ] Preview 任务：`status='preview'`、`task_status IS NULL`、`attempts = 0`
- [ ] 没有新增 Provider Task ID、视频产物或费用记录

### 5.3 服务健康

- [ ] Backend 容器运行中，启动日志无异常
- [ ] Worker `/health` 返回 200，且空 claim 队列不会记录 `Expecting value: line 1 column 1`
- [ ] 本地测试口径：

```bash
cd packages/backend && npm run build && npx jest
cd packages/worker && venv/bin/python -m pytest -q
cd packages/comfyui-video-flow-client && python -m pip install -r requirements.txt pytest && python -m pytest -q
```

---

## 6. 回退方案

```bash
cd /data/video-flow
docker compose down
# 切换到上一个版本 / 上一个镜像 tag
docker compose up -d
```

回滚验证项：

- [ ] 服务启动正常，`/api/v1` 可用
- [ ] 数据库未异常新增字段；如需回退结构，优先停止使用新结构，**不删表 / 不删列**
- [ ] 关键链路可继续读写（创建 Preview 任务 → 查询）

**不要**用回滚去恢复一个已经提交给 Provider 的任务：如果 Task 已有 `providerTaskId`，只允许查询或恢复轮询，不允许重新提交。

---

## 6.1 巡检与准入开关（T10）

**健康端点分工**（都是只读的）：

| 端点 | 含义 | 说明 |
| --- | --- | --- |
| Worker `/health` | 进程存活 | 只返回 `{"status":"alive"}`，不回报配置 |
| Worker `/ready` | 主循环 + 执行进展 | `ready`、`loopAlive`、`backendLastOkAt`、`providerPollLastOkAt`、`activeTaskId`、`admissionPaused` |
| Backend `GET /api/v1/admin/operations/health` | 库状态、队列年龄、待处置数量、全局暂停原因 | Admin Guard |

`/ready` 只允许内部访问：Worker 不发布宿主端口。巡检脚本默认走 compose 网络内的
`http://video-worker:8001/ready`；若巡检必须从宿主机执行，请**只绑定回环**
（`127.0.0.1:8101:8001`，与 backend 的 `127.0.0.1:3100:3000` 一致），
不要做全网卡映射。

**巡检脚本** `scripts/video_flow_monitor.py`（建议每分钟由宿主计划任务执行）：

```bash
export VIDEO_FLOW_ADMIN_TOKEN_FILE=~/.video-flow/admin-token   # 600，内容为 Admin token
export VIDEO_FLOW_ALERT_WEBHOOK_FILE=~/.video-flow/alert-webhook  # 600，内容为通知渠道 URL
python3 scripts/video_flow_monitor.py --base-url https://ai.sweetyshell.com
```

- 未配置 `VIDEO_FLOW_ALERT_WEBHOOK_FILE` 时**只做 dry-run**，不能据此签收真实告警（脚本会明确提示）。
- 阈值见 ROADMAP 第 6 节：连续 2 次检查失败、pending > 2 分钟、生成 > 15 分钟、
  requires_review ≥ 1、交付失败、费用不确定、磁盘 80% 告警 / 90% 停止准入。
- **脚本只自动暂停，绝不自动解除**：`PATCH /api/v1/admin/operations/production-gate`
  解除暂停必须带 `reason`/`operator`/`evidenceRef` 并会写审计。
- 通知失败时脚本非零退出，并把待通知记录留在
  `VIDEO_FLOW_MONITOR_STATE`（默认 `~/.video-flow/monitor-state.json`）里，下一轮继续重试；
  **非零退出必须有人看**，否则等于没有告警。

**暂停的边界**：暂停只拦新准入与未提交的领取，已有任务的查询、轮询与归档不受影响。

**宿主计划任务**：巡检/备份本身失效要靠宿主的定时任务检查回执是否超时；
整机失联必须另用已有的外部可用性渠道，不能靠机器自己的巡检发现。

## 6.2 管理员查询、恢复与暂停（T09/T10）

```bash
# 一条 taskId 的完整报表（只读；默认脱敏，不含完整 Prompt 与签名地址）
export VIDEO_FLOW_ADMIN_TOKEN_FILE=~/.video-flow/admin-token
python3 scripts/video_flow_task_report.py --task-id <TASK_ID> --base-url https://ai.sweetyshell.com

# 运维健康与全局开关
curl -s -H "X-Admin-Token: $ADMIN" https://ai.sweetyshell.com/api/v1/admin/operations/health
curl -s -X PATCH -H "X-Admin-Token: $ADMIN" -H 'Content-Type: application/json' \
  -d '{"paused":true,"reason":"provider incident-42"}' \
  https://ai.sweetyshell.com/api/v1/admin/operations/production-gate

# 恢复生产必须带依据（会写审计）
curl -s -X PATCH -H "X-Admin-Token: $ADMIN" -H 'Content-Type: application/json' \
  -d '{"paused":false,"reason":"provider quota confirmed","operator":"steven","evidenceRef":"ticket-42"}' \
  https://ai.sweetyshell.com/api/v1/admin/operations/production-gate

# 归档失败的受控恢复（只对"Provider 已成功且交付失败"的任务有效，不新建 Provider 任务）
curl -s -X POST -H "X-Admin-Token: $ADMIN" -H 'Content-Type: application/json' \
  -d '{"reason":"oss incident","operator":"steven","evidenceRef":"incident-2026-09-13"}' \
  https://ai.sweetyshell.com/api/v1/admin/tasks/<TASK_ID>/resume-delivery

# 费用人工核实（settle 需金额，release 禁止带金额）
curl -s -X PATCH -H "X-Admin-Token: $ADMIN" -H 'Content-Type: application/json' \
  -d '{"decision":"settle","amountCny":"3.500000","evidenceRef":"ark-bill-2026-09","operator":"steven"}' \
  https://ai.sweetyshell.com/api/v1/admin/tasks/<TASK_ID>/budget-review
```

- `operator` 是**管理员自报**的操作者，接口会明确标注 `operatorIsDeclaredClaim`，
  不能当成 token 识别出的个人身份。
- 所有人工动作都会写审计事件（谁、依据、前后状态）。
- 报表是不可读/被轮换的日志会明确标注 `evidence_missing`：**查不到不等于没发生**。

### 迁移、备份与回滚

- 迁移：`npx prisma migrate deploy`（合同脚本已验证"从空库全量"与"历史库向前升级"两条链路）。
- 回滚的优先顺序：先 `PATCH production-gate {paused:true}` 停止新准入，
  再回滚应用镜像；**保留新增表与资金记录**，不要用 `migrate reset` 抹掉预占与结算。
- 备份：数据库每日备份并定期恢复到隔离库验证；审计目录与未结案 journal 单独保留，
  清理策略必须先保护未归档产物与未结案证据。
- 备份恢复验证（发布前跑一次；默认源库是本机验收库，发布时用
  `VIDEO_FLOW_BACKUP_SOURCE_URL` 指向真实备份）：

  ```bash
  bash scripts/run_db_backup_restore.sh
  ```

  它把源库 `pg_dump` 后恢复到全新隔离库，再比对**行数与内容指纹**——金额按
  `::text` 精确比对（恢复后被静默取整会被抓住）、jsonb 取 `md5`、并含
  `_prisma_migrations`。只比行数是不够的：实测"某个任务金额改 1e-6"时行数不变而指纹已变。
- 容器重建后证据可恢复验证：

  ```bash
  bash scripts/run_container_evidence_recovery.sh
  ```

  用真实 worker 镜像跨不同容器写入再读回审计事件、submission journal 与产物，
  并确认 `AuditLog.rotate()` 不会删掉未结案的 `submissions.jsonl` 与 `SUBMISSIONS_BLOCKED`。

## 6.3 R8 受控验收取证（默认只读）

R8 要在正式环境逐项验收，而**每次 Queue 都可能产生火山引擎费用**。`scripts/seedance_production_acceptance.py` 把验收拆成显式子命令，默认动作是"查询已有任务"：

```bash
export VIDEO_FLOW_BACKEND_URL=https://ai.sweetyshell.com
export VIDEO_FLOW_TOKEN_FILE=~/.video-flow/token

# 只读：查询已有任务 / 按执行槽恢复 / 校验预算 / 下载产物并解码 / 导出证据
python3 scripts/seedance_production_acceptance.py query    --task-id <TASK_ID>
python3 scripts/seedance_production_acceptance.py slot     --slot-id <SLOT_ID>
python3 scripts/seedance_production_acceptance.py budget   --task-id <TASK_ID>
python3 scripts/seedance_production_acceptance.py verify   --task-id <TASK_ID>
python3 scripts/seedance_production_acceptance.py evidence --task-id <TASK_ID> --out acceptance-<TASK_ID>.json

# 会写状态但不花钱：上传素材拿 assetId、提交预检拿报价与 preflightId
# 这两步要用**客户端的解释器**（素材检查依赖 Pillow/ffprobe）
python3 scripts/seedance_production_acceptance.py upload    --file <本地素材>
python3 scripts/seedance_production_acceptance.py preflight --workflow-key <KEY> --prompt <TEXT> \
  --duration <秒> --ratio <比例> --resolution <分辨率> \
  --media <角色>:<slotId>:<本地素材> [--media ...] --out preflight.json

# 唯一会付费的命令：在同一执行槽创建下一版。三道闸门缺一不可。
python3 scripts/seedance_production_acceptance.py next \
  --slot-id <SLOT_ID> --preflight-id <PREFLIGHT_ID> \
  --media <SLOT_ID>=<ASSET_ID> [--media ...] \
  --idempotency-key <操作者自备的稳定键> --confirm-spend
```

- 判定不看单一状态字段：`execution.status` 与 `delivery.status` 只是必要条件，产物必须**真的下载下来并通过 `ffprobe` 解码**才算通过；扩展名与 MIME 还必须与冻结的 `executionPlan.outputFormat` 一致——MOV 工作流被归档成 MP4 会判失败。
- 费用未核实**不算失败**（已生成的片不该被扣住），但会在证据里记为待核查。
- `next` 会拒绝三种情况：没有 `--confirm-spend`、没有操作者自备的幂等键、槽内仍有未完成本地交付的任务（此时正确动作是恢复原任务，不是新建下一版）。
- 幂等键必须由操作者提供并在重试时沿用**同一个键**。工具不会自动生成时间戳键，否则一次"结果不确定"的重试就会变成第二次付费。
- 退出码：`0` 通过、`1` 失败、`2` 用法或环境不完整、`3` 主动拒绝执行。
- 产物与证据默认落在系统临时目录（可用 `VIDEO_FLOW_ACCEPTANCE_WORKDIR` 覆盖），不会写进仓库。

**执行真实验收前先填** [R8 受控正式验收授权范围清单](./r8-production-acceptance-scope.md)：它限定账号、素材、参数与金额上限，并给出逐项的预估费用（全部最短时长 720p 约 61.69 元）、每项必须记录的证据字段，以及验收结束后的收口动作（恢复暂停、把为验收打开的工作流改回关闭并写入具体验证记录）。**清单未填写、未授权前不执行任何真实付费任务。**

---

## 7. 风险与跟进

- 运行风险：
- 观察点：任务延迟、回写失败率、错误码分布、worker 队列积压
- 跟进人：
- 结项确认：

---

## 8. 旧接口兼容边界

旧 `/api/tasks` 仅为 Worker 与历史管理操作保留：create / list / pending / findOne 使用 Admin token，claim / recover / update 使用 Worker token。创意客户端只能使用 `/api/v1`；每次部署仍需用第 3 节的无凭证请求确认旧接口返回 401 / 403。
