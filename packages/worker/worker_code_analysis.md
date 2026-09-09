# Worker 服务代码分析（可阅读版）

这份分析按“服务做什么、怎么做、哪里会失败”三步写。文件对应仓库 `packages/worker`。

## 一句话结论

Worker 是一个常驻服务：它每 5 秒从 Backend 拉取任务，按 provider 或 ComfyUI 路径执行视频生成，并把结果/失败状态回写给 Backend，同时处理重试、超时和计费字段。

## 入口与启动（`main.py`）

- 用 `FastAPI` 提供：
  - `GET /`：服务元信息
  - `GET /health`：健康检查
  - `POST /tasks/execute`：当前是测试/占位接口，返回“已启动任务”并不触发真正执行
- 生命周期 `lifespan`：启动时创建 `executor = JobExecutor()` 并启动后台任务 `executor.poll_loop()`。
- 真正工作来自后端循环，不依赖外部请求触发。

## 核心执行器（`executor.py`）

### 1）构造

`JobExecutor.__init__` 做四件核心事：

- 读取配置（`config.py`）
- 建立与 Backend 的 httpx 客户端
- 初始化 provider 适配器映射（目前有 `seedance`）
- 初始化 ComfyUI（如果 `comfyui_enabled=True`）客户端与 dry-run executor

### 2）轮询循环 `poll_loop`

每次循环：

1. 拉 `pending` 任务
2. 拉取 `submitted/running` 任务做恢复（`fetch_inflight_jobs`）
3. 并发执行所有待处理任务（`asyncio.gather`）
4. 异常时记录日志并休眠重试

### 3）单任务执行 `execute_job`

分两条线：

- ComfyUI 路线：可选 dry-run，本地提交 + 本地文件输出，结果标记为不可计费（`unavailable`）
- 普通 provider 路线（当前主要是 Seedance）：
  1) 解析 provider（`provider_profile` 的前缀）  
  2) 无历史 provider 任务则创建任务并更新 `submitted`  
  3) 更新 `running`  
  4) 轮询完成（成功/失败/超时）  
  5) 成功则下载、本地保存、上传 OSS、创建 asset、回写 `completed`  
  6) 失败按分类决定是否重试（`rate_limit/network_error/timeout`）或直接失败

### 4）恢复与稳定性

- `should_resume_job`：有 `submitted/running` 且有 `provider_task_id` 才可恢复
- `is_stale_job`：按 `submitted_at` 与超时分钟判断是否作废并失败
- 若恢复任务缺少 `provider_task_id`，会尝试更新为失败；更新失败则记录人工干预集合

## 配置与模型（`config.py`, `models.py`）

- `config.py`：核心配置项包括 backend 地址、轮询间隔、ComfyUI 地址/开关、Ark Key、OSS 配置等
- `models.py`：定义 Job/状态/失败类型，支持字段 alias（如 `provider_profile` 与 `providerProfile` 兼容）

## ComfyUI 流程（`comfyui_*.py`）

- `comfyui_workflow.py`：校验工作流，确保是预览模式、execution policy 安全值正确，并验证输出 metadata 结构
- `comfyui_client.py`：封装 `/prompt`、`/history/{id}`、`/system_stats` 等接口调用
- `comfyui_executor.py`：提交后轮询历史，解析状态，校验输出文件存在性，返回 `ComfyUIExecutionResult`
- `comfyui_status.py`：把 ComfyUI 历史状态映射为 `pending/running/completed/failed`

## Provider 与能力层（`providers/*`）

- `seedance_adapter.py`：Ark API 真实执行链（建任务、查状态、下载视频、费用估算和失败归类）
- `seedance_compiler.py`/`minimax_compiler.py`：统一能力请求转厂商 payload 的编译器（目前与 `executor.py` 的直接执行路径耦合度不高）
- `capabilities.py`：能力与模型能力矩阵（确认/待确认）和参数约束说明

## 成本与持久化（`recovery.py`, `oss_uploader.py`）

- `recovery.py` 决定：
  - usage 是否可确认计费
  - 是否可恢复
  - 是否超时作废
- `oss_uploader.py`：上传文件到 OSS，返回 7 天签名 URL

## 与文档的不一致点（容易误解）

- `README.md` 仍写“未实现 ComfyUI / MiniMax / Kling”，但代码中 ComfyUI 已有实装，MiniMax 目前主要在编译/能力定义层，不是主要执行入口。
- `executor` 里真正的主执行链目前是 Seedance + 可选 ComfyUI。

## 风险与关注点（建议优先看）

1. `seedance_adapter.get_task_status` 依赖的 Ark 响应字段和状态映射要持续对齐真实返回  
2. `fetch_inflight_jobs` 恢复逻辑与 `job.status` 的幂等性要注意，避免重复提交  
3. 计费字段目前以 `usage.total_tokens` 为主，缺失时写 `unavailable`，和账单显示策略要对齐  
4. ComfyUI 分支标记为 dry-run，适合前置验证，不应当当成线上计费产线处理
