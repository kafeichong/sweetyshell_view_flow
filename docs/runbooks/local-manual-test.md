# ComfyUI 本地隔离验收手册

> 最后更新：2026-09-15
> 本手册只验证本地代码链路。现状见 [PROJECT_STATUS.md](../PROJECT_STATUS.md)，后续计划见 [ROADMAP.md](../ROADMAP.md)。

## 1. 验收范围

这套环境实际运行：

```text
Comfy Desktop
  → 127.0.0.1:3400 测试 Backend
  → 127.0.0.1:55434 隔离 PostgreSQL
  → 127.0.0.1:8011 Worker
  → 127.0.0.1:19093 Fake Provider + Fake OSS
  → ComfyUI output/video-flow
```

它会真实执行 Queue、鉴权、Preflight、Production submit、预算预占、Worker 编译、模拟 Provider 调用、模拟 OSS 归档、客户端下载和播放，但不会连接服务器 Backend、Ark 或真实 OSS，也不会产生费用。

安全边界：

- `scripts/comfyui_acceptance_env.py` 只接受 loopback URL。
- 环境存在非空 `VOLCENGINE_ACCESS_KEY` 时拒绝启动。
- Backend 使用 `packages/backend/test/contract-backend.cjs`，8 类工作流只通过测试 fixture 临时 ready；正式合同文件不修改。
- actor token、回执、日志、临时模板和 Worker 输出只写入 `/private/tmp/video-flow-comfy-acceptance`。
- Fake Provider 的固定 MP4 是 1 秒、64×64，只能证明交付文件可解码和播放，不能证明真实模型的时长、画质或创意效果。

## 2. 启动环境

从仓库根目录执行：

```bash
packages/worker/venv/bin/python scripts/comfyui_acceptance_env.py start
```

默认端口：PostgreSQL `55434`、Fake Provider `19093`、Backend `3400`、Worker `8011`。脚本会：

1. 启动独立 PostgreSQL 并应用 migration；
2. 构建 Backend；
3. 创建高额度测试 actor 和测试 Production gate；
4. 启动 Fake Provider、测试 Backend 和 Worker；
5. 在临时目录复制 8 份默认 Preview 模板，不修改仓库原模板；
6. 生成权限为 `0600` 的临时 token。停止后再次启动会复用该 token，避免 ComfyUI 缓存旧配置。

查看状态：

```bash
packages/worker/venv/bin/python scripts/comfyui_acceptance_env.py status
```

主要路径：

```text
/private/tmp/video-flow-comfy-acceptance/actor.token
/private/tmp/video-flow-comfy-acceptance/workflows
/private/tmp/video-flow-comfy-acceptance/receipts
/private/tmp/video-flow-comfy-acceptance/logs
```

## 3. 安装客户端并给 GUI 注入测试配置

安装时不要传 token，不覆盖用户正式配置：

```bash
packages/comfyui-video-flow-client/install.sh \
  /Volumes/lvmac/ai/ComfyUI/ComfyUI/custom_nodes
```

给 macOS GUI 会话注入本地验收变量：

```bash
launchctl setenv VIDEO_FLOW_BACKEND_URL http://127.0.0.1:3400
launchctl setenv VIDEO_FLOW_TOKEN_FILE /private/tmp/video-flow-comfy-acceptance/actor.token
launchctl setenv VIDEO_FLOW_RECEIPT_DIR /private/tmp/video-flow-comfy-acceptance/receipts
launchctl setenv VIDEO_FLOW_SPEC_VERSION comfy-acceptance-v1
```

完全退出并重新启动 Comfy Desktop。客户端配置节点应读取上述四个值，不能把回执写入 `~/.video-flow/receipts`。

> ⚠️ **这四个变量只用于本手册描述的隔离验收。** 注入期间客户端指向的是测试 Backend，Preview 与 Production 都不产生真实费用。
> 要跑**真实付费验收**，必须先把它们清掉（§7）、重启 Comfy Desktop，并**导入仓库里的模板而不是本手册第 2 节生成的副本**——验收副本的配置节点写死了 `127.0.0.1:3400`。完整步骤见 [R8 授权范围清单](./r8-production-acceptance-scope.md) §4.2。

## 4. Preview 验收

从 `/private/tmp/video-flow-comfy-acceptance/workflows` 导入目标模板，保持 `Video Flow Execution Policy` 为 `preview`，点击 Queue。

通过标准：

- 报告显示 `requestCheck.status=passed`；
- `willUploadMedia=false`、`willCallProvider=false`；
- 请求合法但 Production 准入不可用时，仍应返回完整请求检查和明确 blocker；
- Preview 前后，正式 Task、ExecutionAttempt、预算预占和 Fake Provider `createCount` 增量均为 0。

检查 Fake Provider：

```bash
curl -fsS http://127.0.0.1:19093/api/v3/__test__/stats
```

## 5. Production 验收

只有 Preview 已通过且报告允许提交时，才把同一画布的执行策略切换为 `production` 并再次 Queue。不要修改 Prompt、参数或媒体；内容变化后必须先重新 Preview。

通过标准：

- 第一次 Production Queue 使用匹配当前内容的 Preflight，不绕过服务端准入；
- 同一执行槽只创建一个 Task，Fake Provider `createCount` 只增加一次；
- Worker 收到冻结的 model、工作流、媒体角色和生成参数；
- Task 最终 `completed`，delivery 为 `ready`，client delivery 为 `delivered`；
- 预算先按有效报价预占，再按 Fake Provider `usage.completion_tokens` 推算值结算；
- 文件下载到 ComfyUI `output/video-flow`，`ffprobe` 可解析，并能在 ComfyUI 中播放。

Production 会创建本地正式任务和本地预算记录，但不会创建 Ark 任务或产生真实费用。

## 6. 证据与排查

日志：

```bash
tail -n 100 /private/tmp/video-flow-comfy-acceptance/logs/backend.log
tail -n 100 /private/tmp/video-flow-comfy-acceptance/logs/worker.log
tail -n 100 /private/tmp/video-flow-comfy-acceptance/logs/fake-provider.log
```

数据库：

```bash
docker compose -p video-flow-comfy-acceptance -f scripts/compose.contract.yml \
  exec -T postgres psql -U video_contract -d video_flow_contract
```

常见问题：

- `PORT_ALREADY_IN_USE`：先确认不是另一个需要保留的服务，再停止旧验收环境。
- `REAL_PROVIDER_CREDENTIAL_FORBIDDEN`：清空当前 shell 的 Ark 凭证后重试，不要为测试放宽此检查。
- ComfyUI 返回 401：确认 Desktop 已在 token 生成后重启；脚本会在后续重启中复用 token。
- 下载 URL 指向真实 OSS：测试 Backend 的 Fake OSS override 没有生效，应立即停止，不要继续 Queue。
- Preview 产生 Task 或 Provider create：属于安全回归，立即停止验收并修复，不能继续 Production。

## 7. 停止与恢复 GUI 环境

停止本地服务和删除隔离数据库卷；日志与临时 token 保留：

```bash
packages/worker/venv/bin/python scripts/comfyui_acceptance_env.py stop
```

不再使用本地验收配置时，清除 GUI 环境变量并重启 Comfy Desktop：

```bash
launchctl unsetenv VIDEO_FLOW_BACKEND_URL
launchctl unsetenv VIDEO_FLOW_TOKEN_FILE
launchctl unsetenv VIDEO_FLOW_RECEIPT_DIR
launchctl unsetenv VIDEO_FLOW_SPEC_VERSION
```

停止环境不会撤销或修改服务器凭证，不会删除 ComfyUI 已下载的验收文件，也不会自动恢复插件备份。
