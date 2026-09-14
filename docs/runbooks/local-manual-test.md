# 本地手动测试指南（Fake Provider，非生产验收）

> 最后更新：2026-09-14
> 适用阶段：T11 收尾期，**T12（部署与真实创意验收）尚未获得生产操作确认**。
> 现状与验证命令的权威出处见 [PROJECT_STATUS.md](../PROJECT_STATUS.md)；计划与出口门禁见 [ROADMAP.md](../ROADMAP.md)。

## 0. 这份文档解决什么问题

`scripts/run_mvp_contract.sh` 能自动跑完 Preview + 跨包合同并给出一个通过/失败结果，但出错时不方便逐步查看中间状态，也不方便手工探索某个分支（比如故意让 Provider 返回失败）。这份文档把同样的链路拆成可以一步步手动执行、逐步用 `curl` 检查的步骤，每一步都说明**在做什么、为什么这么做、怎么判断这步成功**。

Backend 现在挂载了 Swagger（`@nestjs/swagger`），步骤 4 起完服务后，浏览器打开 `http://127.0.0.1:3100/docs` 就能看到步骤 5–12 里除签发凭证外几乎所有接口（`/v1/tasks`、`/v1/assets/*`、`/v1/admin/*`）的交互式文档，可以直接在网页上填参数点 "Try it out"，不用每次都手写/改 curl。下面仍然保留完整 curl 命令，方便自动化、脚本化或需要精确核对请求头（如 `Idempotency-Key`）的场景；日常探索可以优先用 `/docs`，遇到需要固定复现步骤或截图取证的场景再回到 curl。

**安全边界（不可绕过）：** 全程使用 `scripts/fake_provider.py` 模拟 Ark 与 OSS，**不配置 `VOLCENGINE_ACCESS_KEY`、真实 OSS 密钥**。这套手测验证的是代码路径是否符合合同，不构成真实出片的验收证据；真实验收属于 T12，需要 Steven 明确批准范围后才能执行，且要用 [creative-user-guide.md](./creative-user-guide.md) 里的真实域名流程。

## 1. 前置条件

- Docker 可用（跑隔离 Postgres）。
- `packages/worker/venv` 已按 `requirements.txt` 装好依赖（Fake Provider 和本地 Worker 都用这个 venv）。
- `packages/backend` 已 `pnpm install`（这个包由 pnpm 管理，`node_modules` 是 `.pnpm` 虚拟存储布局；用 `npm install` 会报 `Cannot read properties of null (reading 'matches')` 之类的错误，改依赖也要用 `pnpm add`，不要用 `npm install --save`）。
- 默认端口空闲：`55432`（隔离 Postgres）、`19091`（Fake Provider）、`3100`（本地 Backend，**如果宿主机上有 `docker compose up` 起的真实栈占用了 3100，先 `docker compose down` 停掉，避免连错实例）、`8001`（本地 Worker）。合同脚本可用 `VIDEO_FLOW_CONTRACT_DB_PORT` 与 `VIDEO_FLOW_CONTRACT_PROVIDER_PORT` 改用空闲端口；手工步骤仍需把后续 URL 同步改为对应端口。
- 建议每个前台服务单独开一个终端标签页；下面命令里用 `&` 后台跑的，请记下 `$!`（进程号），第 13 步清理要用。

## 2. 步骤一览

| 步骤 | 做什么 | 验证点 |
| --- | --- | --- |
| 1 | 起隔离 Postgres | 容器 healthy |
| 2 | 起 Fake Provider | `/api/v3/__test__/stats` 返回 200 |
| 3 | 迁移 + 编译 Backend | migrate 无报错，`dist/` 生成 |
| 4 | 启动 Backend | 无 token 请求返回 401 |
| 5 | 签发 actor 凭证 | 拿到 `vf_` 开头的 token |
| 6 | 提交 Preview 任务 | `willCallProvider:false`，Provider 调用计数不变 |
| 7 | 上传素材（图生视频可选） | `complete` 返回 200 |
| 8 | 启动 Worker | `/ready` 返回 `ready:true` |
| 9 | 提交 Production 任务 | 201，进入 pending |
| 10 | 轮询状态、取成片 | `status=completed`、`delivery.status=ready`、可下载 |
| 11 | 重放同一意图（可选） | 同一 taskId，Provider create 计数不增加 |
| 12 | 故障注入（可选） | Provider 返回失败时任务走失败分支 |
| 13 | 清理 | 所有端口释放 |

## 3. 分步详解

### 步骤 1：启动隔离 Postgres

```bash
docker compose -f scripts/compose.contract.yml up -d postgres
```

**做什么：** 用 `scripts/compose.contract.yml` 里定义的一次性容器起一个专用测试库 `video_flow_contract`，用户名密码固定为 `video_contract`/`video_contract`，只绑定在 `127.0.0.1:55432`。它和你本机或生产的 Postgres 完全隔离，不会读写真实数据。

**预期结果：**

```bash
docker compose -f scripts/compose.contract.yml ps
# postgres 一列状态为 healthy
```

**排查：** 如果报端口占用，说明有上次没清理干净的合同测试容器，先执行第 13 步的清理命令再重试。

### 步骤 2：启动 Fake Provider

```bash
packages/worker/venv/bin/python scripts/fake_provider.py &
FAKE_PID=$!
curl --fail --silent http://127.0.0.1:19091/api/v3/__test__/stats
```

**做什么：** `scripts/fake_provider.py` 一个进程模拟两件事：① Ark 的 `POST /api/v3/contents/generations/tasks`（创建生成任务）和 `GET /api/v3/contents/generations/tasks/{id}`（查询状态），固定在几次轮询后返回成功和一个 `video_url`；② 一个极简 OSS 替身（`PUT/HEAD/GET` 任意 object key），让 Worker 的下载归档链路也能在本地跑通，不需要真实阿里云凭证。`/api/v3/__test__/stats` 是它额外暴露的测试接口，返回当前的调用计数（比如 `createCount`），后面第 6、11 步会用它验证"有没有真的打到 Provider"。

**预期结果：** 返回 200，body 是一段 JSON，含调用计数字段，此时应该都是 0。

**排查：** 19091 被占用，用 `lsof -i :19091` 找到残留进程 kill 掉。

### 步骤 3：迁移数据库 + 编译 Backend

```bash
cd packages/backend
export DATABASE_URL="postgresql://video_contract:video_contract@127.0.0.1:55432/video_flow_contract"
VIDEO_FLOW_TEST_MODE=1 VIDEO_FLOW_PROVIDER_BASE_URL="http://127.0.0.1:19091/api/v3" \
  npx prisma migrate deploy
npm run build
```

**做什么：** `prisma migrate deploy` 把刚起的空库升到当前 schema 最新版本（和生产用的是同一条 migration 链，验证的是"新环境能不能从零跑通"）。`npm run build` 把 TypeScript 编译到 `dist/`，接下来用 `node dist/src/main.js` 启动，这样跑的是接近生产部署形态的产物，而不是 `ts-node` 的开发模式。

**预期结果：** migrate 命令打印 "All migrations have been successfully applied" 或提示无待执行迁移；`dist/src/main.js` 存在。

**排查：** 报 `P1001` 连接失败，检查 `DATABASE_URL` 端口是否写成了 `55432`（不是默认的 `5432`）。

### 步骤 4：启动 Backend

```bash
VIDEO_FLOW_TEST_MODE=1 \
DATABASE_URL="$DATABASE_URL" \
VIDEO_FLOW_PROVIDER_BASE_URL="http://127.0.0.1:19091/api/v3" \
VIDEO_FLOW_ADMIN_TOKEN="local-admin-token" \
VIDEO_FLOW_WORKER_TOKEN="local-worker-token" \
VIDEO_FLOW_PRODUCTION_ACTORS="tester-1" \
VIDEO_FLOW_PRODUCTION_SPEC_JSON='{"version":"local-v1","model":"doubao-seedance-2-5-260628","duration":5,"ratio":"16:9","resolution":"720p","generateAudio":false,"watermark":true,"pricingVersion":"seedance-token-v1","reserveCny":"2.000000"}' \
OSS_ACCESS_KEY_ID="local-oss" OSS_ACCESS_KEY_SECRET="local-oss-secret" \
OSS_BUCKET="local-bucket" OSS_REGION="oss-cn-beijing" \
PORT=3100 node dist/src/main.js &
BACKEND_PID=$!
```

**每个变量做什么：**

- `VIDEO_FLOW_TEST_MODE=1`：放开"Provider 地址必须是 Ark 官方 HTTPS"的限制，生产环境这条是 fail-closed 的，只有显式声明测试模式才允许指向 `127.0.0.1`。
- `VIDEO_FLOW_PROVIDER_BASE_URL`：指向步骤 2 起的 Fake Provider。
- `VIDEO_FLOW_ADMIN_TOKEN` / `VIDEO_FLOW_WORKER_TOKEN`：随手挑的本地测试口令，分别用于签发 actor 凭证（第 5 步）和放通 Worker 私有接口（第 8 步）。
- `VIDEO_FLOW_PRODUCTION_ACTORS=tester-1`：只给待会要创建的这一个 actor 开 Production 白名单，其余人仍然 fail-closed。
- `VIDEO_FLOW_PRODUCTION_SPEC_JSON`：冻结的生成规格（`ProductionSpec`，见 `packages/backend/src/tasks/production-spec.ts`）。字段结构必须对齐代码，值本身是假的，不代表真实模型/价格。
- `OSS_*`：假凭证，配合 Fake Provider 内置的 OSS 替身，让归档链路能跑通签名 URL 生成/HEAD 校验。
- `PORT=3100`：本地测试端口，和 `docker-compose.yml` 里真实栈的宿主映射端口相同，两者不能同时占用。

**预期结果：**

```bash
curl -i http://127.0.0.1:3100/api/v1/tasks
# HTTP/1.1 401 ...
```
不带 token 返回 401，说明服务起来了，而且鉴权 fail-closed（这是最简单的存活探针）。

**Swagger UI（可选，非生产环境默认开启）：** 浏览器打开 `http://127.0.0.1:3100/docs`，可以看到 `tasks`/`assets`/`admin` 三组接口的交互式文档，点右上角 "Authorize" 分别填入 actor token（`Bearer vf_...`，第 5 步签发后填）和 admin token（`local-admin-token`）就能在网页上直接 "Try it out"，替代下面大部分 curl 命令。这个功能只在非 `NODE_ENV=production` 时默认开启（可用 `VIDEO_FLOW_ENABLE_SWAGGER=true|false` 强制覆盖），生产部署（`docker-compose.yml` 里 `NODE_ENV=production`）默认不暴露，不用担心手测习惯带到生产环境。

### 步骤 5：签发 actor 凭证

```bash
BASE_URL="http://127.0.0.1:3100/api/v1" VIDEO_FLOW_ADMIN_TOKEN="local-admin-token" \
  ./scripts/video_flow_credential.sh issue tester-1 "Local Tester" /tmp/tester-token
TOKEN="$(cat /tmp/tester-token)"
```

**做什么：** 脚本内部就是一次 `POST /api/v1/admin/credentials`（带 `X-Admin-Token` 头，body `{"actorId":"tester-1","name":"Local Tester"}`），拿到形如 `vf_<64位hex>` 的 token 后写入本地文件并 `chmod 600`，不在终端打印明文，避免留在 shell history。如果想直接看响应结构也可以手动执行等价的 curl：

```bash
curl -sS -X POST http://127.0.0.1:3100/api/v1/admin/credentials \
  -H "X-Admin-Token: local-admin-token" -H "Content-Type: application/json" \
  -d '{"actorId":"tester-1","name":"Local Tester"}'
# → {"actorId":"tester-1","token":"vf_..."}
```

**预期结果：** 脚本打印 `credential issued: actor=tester-1 token_file=/tmp/tester-token`，文件存在且权限 `600`。

### 步骤 6：提交 Preview 任务（验证零费用路径）

```bash
curl -sS -X POST http://127.0.0.1:3100/api/v1/tasks \
  -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: local-preview-001" \
  -H "Content-Type: application/json" \
  -d '{"capability":"TEXT_TO_VIDEO","profile":"seedance","mode":"preview","params":{"prompt":"studio product shot","duration":5}}'
```

**做什么：** `Idempotency-Key` 是必填头，缺失会返回 409（消息 `Idempotency-Key is required`）；同一 actor + 同一 key 但请求体不同也会返回 409（`Idempotency-Key payload mismatch`），这是"同一意图只处理一次"合同的一部分，值得手工试一次错误路径看看。`mode` 缺省就是 `preview`，这条路径**不会**调用 Provider。

**预期结果：** 响应里 `preview.willCallProvider` 为 `false`。更关键的验证是回头看 Fake Provider 的调用计数没有变化：

```bash
curl -sS http://127.0.0.1:19091/api/v3/__test__/stats
# createCount 应该仍是 0 —— 光看 201 状态码不能证明没调用 Provider，必须核对这个计数
```

### 步骤 7：上传素材（只有测试图生视频才需要）

```bash
# 7.1 申请上传票据
curl -sS -X POST http://127.0.0.1:3100/api/v1/assets/upload-ticket \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"filename":"product.png","mimeType":"image/png","sizeBytes":524288}'
# → {"assetId":..., "objectKey":..., "uploadUrl":..., "uploadHeaders":{...}, "expiresIn":900}

# 7.2 直传到（假）OSS —— sizeBytes 必须和实际文件字节数完全一致，否则 7.3 会 400
curl -sS -X PUT '<uploadUrl>' -H 'Content-Type: image/png' --data-binary '@product.png'

# 7.3 确认上传完成
curl -sS -X POST http://127.0.0.1:3100/api/v1/assets/<assetId>/complete \
  -H "Authorization: Bearer $TOKEN"
```

**做什么：** 7.1 生成一张有效期 900 秒的直传票据；7.2 把文件真正传到 Fake Provider 模拟的 OSS；7.3 触发服务端用 `HEAD` 校验实际大小/MIME/（如果提供了）sha256 是否与票据一致，一致才把 Asset 标记为 `uploaded`，之后才能被 `image_asset_id` 引用。三者任一不一致（大小、MIME、sha256）都返回 **400**，不是 409。

**预期结果：** 7.3 返回 200，body 含 `inspectionStatus`（应为已上传完成的状态）。记下 `assetId`，第 9 步图生视频要用。

### 步骤 8：启动 Worker

```bash
cd packages/worker
VIDEO_FLOW_TEST_MODE=1 \
BACKEND_URL="http://127.0.0.1:3100" \
WORKER_SERVICE_TOKEN="local-worker-token" \
VIDEO_FLOW_PROVIDER_BASE_URL="http://127.0.0.1:19091/api/v3" \
OSS_ENDPOINT="http://127.0.0.1:19091/oss" OSS_CNAME=1 \
OSS_ACCESS_KEY_ID="local-oss" OSS_ACCESS_KEY_SECRET="local-oss-secret" \
OSS_BUCKET="local-bucket" OSS_REGION="oss-cn-beijing" \
COMFYUI_OUTPUT_DIR="$(mktemp -d)" VIDEO_FLOW_AUDIT_DIR="$(mktemp -d)" \
venv/bin/uvicorn main:app --host 0.0.0.0 --port 8001 &
WORKER_PID=$!
```

**做什么：** Worker 是个常驻 FastAPI 进程，`main.py` 的 `lifespan` 在启动时就 `asyncio.create_task(executor.poll_loop())`，所以只要进程起来，后台轮询就自动开始抓取 pending 任务，不需要额外触发。`BACKEND_URL`/`WORKER_SERVICE_TOKEN` 对应步骤 4 里 Backend 配的 worker token，两边必须一致，否则 claim 接口会 403。`COMFYUI_OUTPUT_DIR`/`VIDEO_FLOW_AUDIT_DIR` 在容器里默认是 `/app/output`、`/app/audit`，本机跑用临时目录代替。

**预期结果：**

```bash
curl -sS http://127.0.0.1:8001/health   # {"status":"alive"}
curl -sS http://127.0.0.1:8001/ready    # {"ready":true,"loopAlive":true,...}
```
`/ready` 的 `ready` 字段为 `true` 说明轮询循环正常在转；`reasons` 数组为空。

### 步骤 9：提交 Production 任务

```bash
curl -sS -X POST http://127.0.0.1:3100/api/v1/tasks \
  -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: local-prod-001" \
  -H "Content-Type: application/json" \
  -d '{"capability":"TEXT_TO_VIDEO","profile":"seedance","mode":"production","params":{"prompt":"studio product shot","duration":5}}'
```

**做什么：** 这次带 `mode:"production"`，且 `tester-1` 在白名单里，Backend 会在一个事务里依次做：额度预占（按 `VIDEO_FLOW_PRODUCTION_SPEC_JSON` 里的 `reserveCny`）→ 创建 Task → 状态置 `pending`。**注意换了一个新的 `Idempotency-Key`**——如果沿用步骤 6 的 key，请求体里 `mode` 不同会被判定为"同 key 不同请求"，返回 409，这也顺带验证了幂等合同的另一面。

**预期结果：** 201，`status` 为 `pending` 或很快变为 `submitted`/`running`（Worker 轮询间隔很短，可能你还没看完响应它已经在推进了）。

### 步骤 10：轮询状态、取得成片

```bash
TASK_ID=<上一步返回的 id>
curl -sS http://127.0.0.1:3100/api/v1/tasks/$TASK_ID -H "Authorization: Bearer $TOKEN"
```

**做什么：** 观察 `status` 从 `pending` → `running`/`submitted` → `archiving` → `completed` 的流转（对照 `docs/ROADMAP.md` §5.2 的状态表）。响应里三个子对象分别是：

- `execution: {attemptId, provider, model, providerTaskId, status}` —— 这次真实调用的执行记录。
- `delivery: {status, assetId, errorCode}` —— 产物归档状态；`status` 从 `not_started` → `archiving` → `ready`（或 `failed`）。
- `costSummary: {status, estimatedCny, usageCalculatedCny, billedCny, pricingVersion, reservedCny, settledCny, reservationState}` —— 预占与结算金额，全部是 `string|null`，未知值不能是 `0`。

等 `delivery.status` 变成 `ready` 后：

```bash
curl -sS http://127.0.0.1:3100/api/v1/assets/tasks/$TASK_ID/result -H "Authorization: Bearer $TOKEN"
# → {"taskId","assetId","objectKey","mimeType","sizeBytes","downloadUrl","expiresIn"}
```

**排查：** 在 `delivery.status` 还没到 `ready` 前调用 `result` 接口会返回 **409**，body 里错误码分三种：`RESULT_NOT_READY`（默认，还没好）、`RESULT_REQUIRES_REVIEW`（任务进入人工复核）、`DELIVERY_FAILED`（Provider 成功但归档失败）。看到 409 先看这个错误码再决定要不要继续等。

**预期结果：** 拿到 `downloadUrl` 后 `curl -I '<downloadUrl>'` 应该 200，`Content-Length` 大于 0；本地跑的话产物是 Fake Provider 生成的假视频文件（用于验证链路，不代表真实画面质量）。

### 步骤 11（可选）：重放同一意图，验证不变量

```bash
# 用完全相同的 Idempotency-Key 和 body 再发一次
curl -sS -X POST http://127.0.0.1:3100/api/v1/tasks \
  -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: local-prod-001" \
  -H "Content-Type: application/json" \
  -d '{"capability":"TEXT_TO_VIDEO","profile":"seedance","mode":"production","params":{"prompt":"studio product shot","duration":5}}'
curl -sS http://127.0.0.1:19091/api/v3/__test__/stats
```

**做什么：** 验证 ROADMAP 第 4 节不变量 2——"同一 actor + 生成意图只创建一个 Task、只占一次额度"。第二次请求应该返回**同一个 taskId**，且 Fake Provider 的 `createCount` 不应该增加。

### 步骤 12（可选）：故障注入

```bash
curl -sS "http://127.0.0.1:19091/__test__/task-status?value=failed"
```

**做什么：** Fake Provider 提供了这个测试专用接口，把后续 `GET /api/v3/contents/generations/tasks/{id}` 的返回状态改成指定值（比如 `failed`），用于手工验证失败分支：Task 应该走到 `failed`，`costSummary`/`delivery` 该怎么标记不确定值而不是编造 0 或成功。**测完记得改回 `succeeded`**（或者直接重启 Fake Provider 进程），否则会影响后面还想测的成功路径。

### 步骤 13：清理

```bash
kill "$BACKEND_PID" "$WORKER_PID" "$FAKE_PID" 2>/dev/null
docker compose -f scripts/compose.contract.yml down -v
```

**做什么：** 依次结束三个前台进程、销毁隔离 Postgres 容器和数据卷。**这一步不能省略**——上次踩过的坑：残留的 Fake Provider 占着 19091、合同库里的脏数据会导致下次手测/跑 `run_mvp_contract.sh` 出现莫名其妙的假失败，且很难第一时间联想到是端口/数据没清干净。

## 4. 常见问题

- **看到 500 错误：** 先看步骤 4 起 Backend 的终端输出（前台进程日志最直接）；需要再深挖就用 `psql postgresql://video_contract:video_contract@127.0.0.1:55432/video_flow_contract` 直连查表复现，复现完记得回到步骤 13 清理。
- **手测中途改了 Backend 代码想重试：** 重新 `npm run build` 后 `kill $BACKEND_PID` 再重新执行步骤 4，数据库和 Fake Provider 不需要重启。
- **端口冲突排查：** `lsof -i :3100`、`lsof -i :8001`、`lsof -i :19091`、`lsof -i :55432` 分别查是不是上次的手测/合同脚本没清理干净。

## 5. 和自动化脚本的关系

`scripts/run_mvp_contract.sh` 就是把本文档步骤 1–10（不含可选的 11/12）自动化并加上断言，跑完无论成败都自动清理。日常验证优先跑这个脚本拿到明确的通过/失败结论；这份手测文档用于脚本失败时定位问题、或者需要手工验证某个未覆盖的分支（比如故障注入）。两者不能互相替代成对方的证据——脚本失败务必以脚本输出为准，不能因为手测走通了就认为脚本的失败可以忽略。

## 6. 边界重申

以上全部步骤使用 Fake Provider，验证的是代码路径是否符合 [ROADMAP.md](../ROADMAP.md) 第 4 节的执行边界，**不构成 T12 真实生产验收的证据**。真实创意人员用 ComfyUI 客户端出片需要生产操作确认，按项目约定不自行执行；届时请使用 [creative-user-guide.md](./creative-user-guide.md) 面向真实域名 `https://ai.sweetyshell.com` 的流程。
