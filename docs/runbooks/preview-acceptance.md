# Preview 联调验收记录

> 本文件既是**可复用的验收清单**，也是 **2026-09-11 的实测记录**。清单部分可重复执行。
> 记录部分属于历史快照，不要据此判断当前状态；现状见 [PROJECT_STATUS.md](../PROJECT_STATUS.md)。
>
> 本记录执行时客户端测试套件为 **11 项**；后续已增加交付、Production、结果下载和安装备份测试。当前数字见 [PROJECT_STATUS](../PROJECT_STATUS.md)。SOCKS 用例要求客户端环境按自身 `requirements.txt` 安装 `httpx[socks]`，不要借用 Worker venv。

## 配置检查

- [x] Backend 已配置 `VIDEO_FLOW_WORKER_TOKEN`
- [x] Worker 已配置同一 service token（2026-09-11 对比哈希一致，未输出明文）
- [x] Backend 已配置 `OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET`、`OSS_BUCKET`、`OSS_REGION`
- [x] ComfyUI 只配置 `VIDEO_FLOW_BACKEND_URL`、actor token 文件和协议版本
- [x] ComfyUI 电脑不存在 Ark/OSS Provider 密钥环境变量

## 无付费 Smoke Test

- [x] 无 token 请求 `/api/v1/tasks` 返回 401
- [x] 停用 token 请求返回 403
- [ ] 相同 actor 和 `Idempotency-Key` 返回同一 Task
- [ ] 相同 key 不同请求体返回 409
- [x] 上传票据成功，ComfyUI 节点完成随机 64×64 PNG 上传并创建 Preview Task
- [ ] 不同 actor 不能下载该 Asset
- [ ] OSS 配置缺失时上传/下载返回 503，不生成裸 OSS URL
- [x] Preview 请求不调用 Ark create endpoint：Task 未进入 pending，ExecutionAttempt 为 0

## 2026-09-11 真实 ComfyUI Preview 验收

- Backend URL：`https://ai.sweetyshell.com`
- ComfyUI：Desktop `1.0.47`，ComfyUI `0.35.1`，Python `3.13.12`
- 客户端安装：`custom_nodes/video_flow_client` 指向当前仓库客户端目录
- 节点加载：UI 可见 `Video Flow Config`、`Seedance Preview`、`Wait Video Flow Task`
- 客户端测试：`11 passed`
- actorId：`steven-comfyui-preview`（普通 actor，未加入 Production 白名单）
- Preview Task ID：`054a6e53-86f8-4f84-8db4-b5539133b0b9`
- 数据库结果：`status='preview'`、`task_status IS NULL`、`cost IS NULL`、`video_url IS NULL`
- 执行结果：ExecutionAttempt `0`、Provider Task ID `0`、账单字段记录 `0`
- Production fail-closed：同一 actor 显式请求 `mode=production` 返回 HTTP `403`；Production Task `0`、pending `[]`
- Worker：`/health` 返回 healthy；日志无该 Preview Task ID、无 `Expecting value: line 1 column 1`
- Asset backfill：`dry-run`，`scanned=0`、`updated=0`；3 条无 hash 历史记录均为 `role=output`，不在 input 回填范围
- 凭证检查：验收记录、仓库与 custom node 中均无明文 token；本机 token 文件权限为 `600`

## 结果与回滚

- 验收人：Steven / Codex
- 验收时间：2026-09-11（Asia/Shanghai）
- Server commit：`be8751c75958954258336e2757e8820bd55f8747`
- Backend 镜像：`video-flow-video-backend:6302eb2`，image ID `fd70c21e1d452dd1e2fd5fb89ccf5b35b3efb7ce05ca1946261397d031d01231`
- Worker 镜像：`video-flow-video-worker:latest`，image ID `236e939fa736f53584198cd67a11658f28699ba5dc180cd1b19fed9514ea97d6`
- 数据库 migration：4 个 migration 全部 applied；包含 `20260910193000_add_asset_owner_role_hash_unique`
- 已解决问题：ComfyUI SOCKS 环境缺少 `socksio`；旧临时 actor credential 已撤销。客户端依赖修复为 commit `8987f10`，新 Preview-only credential 已签发。
- 回滚动作：移除 `custom_nodes/video_flow_client` 软链接或关闭 `/api/v1`；如需停用本次客户端权限，撤销 actor `steven-comfyui-preview`。不删除数据库新表。
- Production：不属于本次验收范围，`VIDEO_FLOW_PRODUCTION_ACTORS` 保持为空。
