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

## 7. 风险与跟进

- 运行风险：
- 观察点：任务延迟、回写失败率、错误码分布、worker 队列积压
- 跟进人：
- 结项确认：

---

## 8. 旧接口兼容边界

旧 `/api/tasks` 仅为 Worker 与历史管理操作保留：create / list / pending / findOne 使用 Admin token，claim / recover / update 使用 Worker token。创意客户端只能使用 `/api/v1`；每次部署仍需用第 3 节的无凭证请求确认旧接口返回 401 / 403。
