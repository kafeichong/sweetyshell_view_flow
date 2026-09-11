# Preview Delivery Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保持 Production 默认关闭的前提下，让创意同事通过 `https://ai.sweetyshell.com` 和真实 ComfyUI 稳定完成零付费 Preview，并补齐客户端交付、Worker 空队列处理和验收证据。

**Architecture:** `ai.sweetyshell.com` 保留为 Video Flow 独立 HTTPS 入口，Nginx 将 `/api/` 原路径转发到 NestJS `3100`；ComfyUI 客户端只持有 actor token，不持有 Ark/OSS 密钥。Preview 由 Backend 写成 `status='preview'`，Worker 仅 claim `status='pending'`，Production 继续受 `VIDEO_FLOW_PRODUCTION_ACTORS` 白名单控制。

**Tech Stack:** NestJS 12、Prisma 5.22、PostgreSQL 16、Python 3.13、FastAPI Worker、ComfyUI custom node、Nginx、Let's Encrypt、Docker Compose。

**Spec:** `docs/2026-09-10/真实出片后链路缺口分析.md`

## Global Constraints

- 不为验证创建 Ark/Seedance 付费任务。
- `VIDEO_FLOW_PRODUCTION_ACTORS` 在 Preview 验收完成前保持为空。
- Preview 必须满足：`status='preview'`、`taskStatus=NULL`、ExecutionAttempt 数量为 `0`、pending 数量不增加。
- ComfyUI 电脑只配置 Backend URL、actor token 和协议版本，不配置 Ark/OSS 密钥。
- 不改动 `api.sweetyshell.com`；它属于现有业务 API，当前代理到 `127.0.0.1:3000`。
- Video Flow 公网入口固定为 `https://ai.sweetyshell.com`，其 `/api/` 当前代理到 `127.0.0.1:3100`。
- 历史 Asset 工具默认只运行 dry-run；未经报告审核不得使用 `--apply`。
- 已部署提交 `6302eb2` 是服务器基线；客户端 review 修复当前仍是本地未提交改动。
- 保留用户现有未提交文档和脚本，不使用 `git add -A`。

---

### Task 1: 提交客户端 review 修复

**Files:**
- Modify: `.env.example`
- Modify: `packages/comfyui-video-flow-client/README.md`
- Modify: `packages/comfyui-video-flow-client/client.py`
- Test: `packages/comfyui-video-flow-client/tests/test_client.py`

**Interfaces:**
- Consumes: `VideoFlowClient.stable_idempotency_key(prompt: str, image_bytes: bytes) -> str` 生成内容基准键。
- Produces: `VideoFlowClient.mode_scoped_idempotency_key(idempotency_key: str, mode: str) -> str`，保证 Preview 与 Production 的最终 Header key 不同。
- Produces: `VIDEO_FLOW_TOKEN_FILE`，默认 `~/.video-flow/token`，优先级低于 `VIDEO_FLOW_TOKEN`。

- [x] **Step 1: 复核当前四个文件的精确差异**

Run:

```bash
git diff -- .env.example \
  packages/comfyui-video-flow-client/README.md \
  packages/comfyui-video-flow-client/client.py \
  packages/comfyui-video-flow-client/tests/test_client.py
```

Expected: 只包含模式作用域幂等键、token 文件说明及对应测试，不包含 token 值。

- [x] **Step 2: 运行客户端完整测试**

Run from `packages/comfyui-video-flow-client/tests`:

```bash
../../worker/venv/bin/python -m pytest test_client.py -q
```

Expected: `10 passed`；允许出现 `pytest_asyncio` fixture scope deprecation warning。

- [x] **Step 3: 运行语法检查**

Run from `packages/comfyui-video-flow-client`:

```bash
../worker/venv/bin/python -m py_compile client.py config.py
```

Expected: exit code `0`，无语法错误。

- [x] **Step 4: 精确提交客户端修复**

```bash
git add .env.example \
  packages/comfyui-video-flow-client/README.md \
  packages/comfyui-video-flow-client/client.py \
  packages/comfyui-video-flow-client/config.py \
  packages/comfyui-video-flow-client/tests/test_client.py
git diff --cached --check
git commit -m "fix: separate preview and production client requests"
```

Expected: 不包含 `docs/`、`scripts/` 或任何 token 文件。

---

### Task 2: 修复 Worker 空 claim 响应日志

**Files:**
- Modify: `packages/worker/executor.py`
- Test: `packages/worker/tests/test_mvp_backend_contract.py`

**Interfaces:**
- Consumes: `POST /api/tasks/claim`；队列为空时 Backend 可能返回空 body。
- Produces: `JobExecutor.fetch_pending_jobs() -> list[Job]`；空 body 或 HTTP `204` 返回空列表，不打印 JSON decode error。

- [x] **Step 1: 添加失败测试**

在 `test_mvp_backend_contract.py` 增加异步测试，使用 `httpx.MockTransport` 返回 HTTP `200` 和空 body：

```python
async def test_empty_claim_response_returns_no_jobs(self):
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"")

    executor = _new_executor()
    await executor.client.aclose()
    executor.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    executor.backend_url = "https://backend.local"

    with patch("builtins.print") as print_mock:
        jobs = await executor.fetch_pending_jobs()
    await executor.client.aclose()

    self.assertEqual(jobs, [])
    print_mock.assert_not_called()
```

并在文件头增加：

```python
from unittest.mock import patch
```

- [x] **Step 2: 确认测试先失败**

Run from `packages/worker`:

```bash
venv/bin/python -m pytest tests/test_mvp_backend_contract.py -k empty_claim -q
```

Expected: 在现有实现的 `response.json()` 处触发 JSON decode，并因错误日志断言或异常行为失败。

- [x] **Step 3: 最小处理空响应**

在 `fetch_pending_jobs()` 的 `response.raise_for_status()` 后、`response.json()` 前增加：

```python
if response.status_code == 204 or not response.content.strip():
    break
```

不要修改 claim URL、Worker token、重试次数或 Provider 执行代码。

- [x] **Step 4: 运行 Worker 完整测试**

```bash
cd packages/worker
venv/bin/python -m pytest
```

Expected: 当前 78 个测试和新增测试通过；外部 ComfyUI workflow JSON 缺失项继续显式 skip。

- [x] **Step 5: 单独提交 Worker 修复**

```bash
git add packages/worker/executor.py packages/worker/tests/test_mvp_backend_contract.py
git commit -m "fix: handle empty worker claim responses"
```

---

### Task 3: 验证独立公网 HTTPS 入口

**Files:**
- Runtime verify: `/etc/nginx/sites-enabled/ai.sweetyshell.com`
- Modify only if documentation differs: `packages/comfyui-video-flow-client/README.md`

**Interfaces:**
- Consumes: `https://ai.sweetyshell.com/api/*`。
- Produces: 保留原始 `/api/` 路径并代理到 `http://127.0.0.1:3100` 的 HTTPS 契约。

- [x] **Step 1: 确认 DNS、证书和 Nginx 目标**

```bash
getent ahostsv4 ai.sweetyshell.com
nginx -T | sed -n '/server_name ai.sweetyshell.com/,/^}/p'
```

Expected: DNS 指向 `8.140.49.56`；证书目录为 `/etc/letsencrypt/live/ai.sweetyshell.com/`；`location /api/` 代理到 `127.0.0.1:3100`。

- [x] **Step 2: 验证公网只读接口**

```bash
curl -fsS https://ai.sweetyshell.com/
curl -fsS -o /dev/null -w '%{http_code}\n' \
  https://ai.sweetyshell.com/api/tasks/pending
curl -sS -o /dev/null -w '%{http_code}\n' \
  https://ai.sweetyshell.com/api/v1/tasks/not-a-real-id
```

Expected: 根路径返回 Video Flow 标识；pending 返回 `200`；无凭证的 v1 请求返回 `401`。不发送 actor token 到 `api.sweetyshell.com`。

- [x] **Step 3: 更新客户端交付 URL**

确认创意电脑使用：

```bash
export VIDEO_FLOW_BACKEND_URL=https://ai.sweetyshell.com
```

如果 README 缺少该生产示例，将同一行加入配置章节并单独提交文档修改。

---

### Task 4: 恢复真实 ComfyUI 运行环境并安装客户端

**Files:**
- Source: `packages/comfyui-video-flow-client/`
- Runtime target: `/Volumes/lvmac/ai/ComfyUI/ComfyUI/custom_nodes/ComfyUI-Video-Flow`
- Runtime Python: `/Volumes/lvmac/ai/ComfyUI/ComfyUI/.venv/bin/python`
- Local credential: `~/.video-flow/token`

**Interfaces:**
- Consumes: Task 1 客户端代码和 Task 3 HTTPS URL。
- Produces: 可在真实 ComfyUI 中加载的 `VideoFlowSeedancePreview` 节点。

- [x] **Step 1: 挂载运行盘并确认真实根目录**

```bash
test -d /Volumes/lvmac/ai/ComfyUI/ComfyUI
test -x /Volumes/lvmac/ai/ComfyUI/ComfyUI/.venv/bin/python
```

Expected: 两条命令均为 exit code `0`。当前实测为 missing，因此挂载前停止本 Task，不猜测其他路径。

- [x] **Step 2: 检查 custom node 安装目标**

```bash
ls -ld /Volumes/lvmac/ai/ComfyUI/ComfyUI/custom_nodes/ComfyUI-Video-Flow
```

Expected: 目标是指向当前仓库客户端目录的软链接，或是明确版本的目录副本；不得指向旧项目 checkout。

- [x] **Step 3: 在真实 ComfyUI Python 中安装并测试依赖**

```bash
cd /Volumes/lvmac/ai/ComfyUI/ComfyUI
.venv/bin/python -m pip install -r \
  /Users/steven/works/20260909video_flow/packages/comfyui-video-flow-client/requirements.txt
.venv/bin/python -m pytest \
  /Users/steven/works/20260909video_flow/packages/comfyui-video-flow-client/tests/test_client.py -q
```

Expected: 客户端 10 个测试通过，且 `numpy`、`Pillow`、`httpx` 可导入。

- [x] **Step 4: 配置最小本地凭证**

```bash
mkdir -p ~/.video-flow
chmod 700 ~/.video-flow
chmod 600 ~/.video-flow/token
```

Expected: token 文件只对当前用户可读；Workflow JSON、custom node 目录和环境日志中不存在 token、Ark key 或 OSS key。

- [x] **Step 5: 重启 ComfyUI 并检查节点加载日志**

Expected: `ComfyUI-Video-Flow` 导入成功，无 `ImportError`；先不要点击 Production。

---

### Task 5: 完成真实 ComfyUI 零付费 Preview 验收

**Files:**
- Run: `scripts/comfyui_client_preview_check.py`
- Modify: `docs/2026-09-10/Preview联调验收记录.md`

**Interfaces:**
- Consumes: 已安装客户端、`https://ai.sweetyshell.com` 和有效 Preview actor token。
- Produces: 一条不可执行的 Preview Task 及完整验收记录。

- [x] **Step 1: 再次确认 Production 关闭**

```bash
docker compose exec -T video-backend sh -lc \
  'test -z "${VIDEO_FLOW_PRODUCTION_ACTORS:-}"'
```

Expected: exit code `0`。

- [x] **Step 2: 从真实 ComfyUI 环境运行 Preview 检查**

```bash
/Volumes/lvmac/ai/ComfyUI/ComfyUI/.venv/bin/python \
  scripts/comfyui_client_preview_check.py | \
  tee /tmp/video-flow-preview-acceptance.txt

PREVIEW_TASK_ID=$(sed -n 's/^TASK_ID=//p' \
  /tmp/video-flow-preview-acceptance.txt | tail -n 1)
test -n "$PREVIEW_TASK_ID"
```

Expected: HTTPS 上传和 Preview 创建成功，最终 Task 状态为 `preview`；脚本不包含 Production 分支。

- [x] **Step 3: 在数据库核对费用安全不变量**

从验收输出读取 Task ID，并通过 `psql` 变量查询，避免手工替换 SQL：

```bash
PREVIEW_TASK_ID=$(sed -n 's/^TASK_ID=//p' \
  /tmp/video-flow-preview-acceptance.txt | tail -n 1)

ssh root@8.140.49.56 "cd /data/video-flow && \
docker compose exec -T video-postgres psql \
  -U video_user -d video_flow \
  -v preview_task_id='$PREVIEW_TASK_ID' \
  -c \"SELECT id, status, task_status
      FROM tasks
      WHERE id = :'preview_task_id'::uuid;\" \
  -c \"SELECT count(*) AS attempt_count
      FROM execution_attempts
      WHERE task_id = :'preview_task_id'::uuid;\""
```

执行的两条 SQL 等价于：

```sql
SELECT id, status, task_status
FROM tasks
WHERE id = :'preview_task_id'::uuid;

SELECT count(*)
FROM execution_attempts
WHERE task_id = :'preview_task_id'::uuid;
```

Expected: `status='preview'`、`task_status IS NULL`、Attempt 数量为 `0`。

- [x] **Step 4: 核对 Worker 和 Provider 边界**

```bash
docker compose logs --since 10m video-worker
```

Expected: 没有该 Task ID、Provider Task ID、Ark create 或上传视频产物记录。

- [x] **Step 5: 验证 Production fail-closed**

使用同一个 actor 发送一条 `mode=production` 的文本请求，只检查 HTTP 状态，不重试：

Expected: HTTP `403`；数据库不新增 `pending` Task 或 ExecutionAttempt。

- [x] **Step 6: 填写验收记录**

在 `Preview联调验收记录.md` 记录：验收时间、Backend/Worker 镜像 tag、commit、Preview Task ID、数据库查询结果、Production `403`、回滚命令。不得记录 token。

---

### Task 6: 低风险运行收尾

**Files:**
- Run: `packages/backend/dist/tools/asset-hash-backfill.js`
- Runtime inspect: `/data/video-flow/.env.backup-token-1789028038`

**Interfaces:**
- Consumes: 已部署的 Asset hash 工具和现存 3 条历史 Asset。
- Produces: 只读历史数据报告与凭证清理决定。

- [x] **Step 1: 执行历史 Asset dry-run**

```bash
cd /data/video-flow/packages/backend
npm run build
npm run assets:backfill
```

Expected: 输出扫描、可回填、缺失对象和冲突统计；数据库写入数为 `0`。不要追加 `--apply`。

- [x] **Step 2: 只检查临时凭证备份的元数据**

```bash
stat /data/video-flow/.env.backup-token-1789028038
```

Expected: 只记录属主、权限和修改时间，不输出文件内容。确认不再需要后，另行获得删除授权。

- [x] **Step 3: 观察 Worker 空队列日志**

```bash
docker compose logs --since 15m video-worker
```

Expected: Task 2 部署后不再出现 `Expecting value: line 1 column 1`；Worker `/health` 返回 `200`。

---

## Release Gates

只有同时满足以下条件，才算 Preview 交付闭环：

- [x] 客户端 review 修复已提交并推送。
- [x] Worker 空 claim 响应不再产生 JSON decode 日志。
- [x] `https://ai.sweetyshell.com/api/` 可访问 Video Flow，而 `api.sweetyshell.com` 未被改动。
- [x] 真实 ComfyUI 节点加载成功。
- [x] Preview Task 数据库状态为 `preview/NULL`，Attempt 为 `0`。
- [x] Production 请求返回 `403`。
- [x] 没有新增 Ark Provider Task ID、视频产物或费用记录。
- [x] 验收记录不包含任何明文凭证。

## Deferred Production Gate

Production 不属于本计划的执行范围。只有出现真实业务出片需求，并由 Steven 明确批准一次付费调用和预算后，才临时将单一 actor 加入 `VIDEO_FLOW_PRODUCTION_ACTORS`。如果 Task 已有 Provider Task ID，只允许查询或恢复，不允许再次提交；完成后立即移出白名单并核对 usage 推算费用与火山账单费用。
