# Video Flow Worker

这是 Video Flow 的 Python Worker。它通过 Backend 私有接口领取已经通过服务端准入并冻结的任务，负责 Provider 提交与恢复、状态轮询、usage 回传，以及生成结果的独立归档交付。

当前能力与缺口只看 [PROJECT_STATUS](../../docs/PROJECT_STATUS.md)，实施顺序只看 [ROADMAP](../../docs/ROADMAP.md)。本 README 只说明模块职责和开发方法，不宣称任一工作流已经完成 Production 验收。

## 边界判定

阶段完成度和 Production 开放状态不在本 README 重复维护。开发或部署前必须先核对 [PROJECT_STATUS](../../docs/PROJECT_STATUS.md)；Worker 中存在 Provider 适配器或编译策略，不代表对应工作流已经获准正式执行。

Worker 必须遵守以下不变量：

- 只领取 Backend 已创建的可执行 Production 任务；Preview 不进入 Worker；
- 不提供面向创意客户端的任务创建入口，`POST /tasks/execute` 只是占位回显，不触发真实执行；
- Provider 提交结果不确定时保留审计记录和恢复状态，不自动再次 create；
- 已有 `providerTaskId` 时恢复同一 Provider 任务；
- Provider 生成成功与 OSS 归档交付分开记录，交付失败不重新生成；
- usage 不足以核价时报告未知或待核查，不伪装成确定费用；
- 真实 Provider 测试必须获得单独的任务与预算授权；常规开发使用本机 Fake Provider。

统一职责要求见 [Preview 与 Production 统一需求规范 v2](../../docs/requirements/2026-09-15/workflow-preview-production-spec-v2.md)。

## 主要模块

| 路径 | 作用 |
| --- | --- |
| `main.py` | FastAPI 进程入口，启动轮询循环并提供 `/health`、`/ready` |
| `executor.py` | claim、Provider 提交/恢复、状态回写、usage 和交付编排 |
| `config.py` | Backend、Provider、OSS、轮询和测试模式配置 |
| `models.py` | Worker 任务与 Provider 状态模型 |
| `providers/seedance_adapter.py` | Ark Seedance Provider 调用与状态适配 |
| `providers/seedance_execution_policy.py` | 当前正式执行路径使用的 Seedance payload 编译策略 |
| `workflow_contract.py`、`contracts/` | 从仓库根合同同步的 v2 工作流定义与本地读取 |
| `recovery.py` | Provider 恢复、超时和 usage 判定辅助逻辑 |
| `oss_uploader.py` | 生成结果归档到 OSS |
| `tests/` | 单元、恢复、合同和执行器测试 |

其他 compiler 或 capability 文件可能属于研究、兼容或未接入路径；判断实际执行链时从 `executor.py` 的调用点追踪，不能只凭文件存在下结论。

## 本地开发

```bash
cd packages/worker
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
pip install -r requirements-dev.txt
python main.py
```

配置项以 `config.py` 和部署环境为准。密钥只通过环境变量或未提交的本地配置注入，不写入代码、示例或日志。

安全保护：

- `VIDEO_FLOW_TEST_MODE=true` 时禁止配置真实 Provider Key；
- 非官方 Provider 地址只允许在测试模式下指向本机或隔离的 `fake-provider`；
- 生产 Worker 需要 `WORKER_SERVICE_TOKEN` 调用 Backend 私有接口；
- `/health` 只表示进程存活，业务就绪应检查 `/ready` 和 Backend/Worker 版本匹配。

## 测试

```bash
cd packages/worker
pytest
```

仓库没有 `packages/worker/workflows/` 外部 Workflow JSON 时，相关测试会显式 `skip`，属预期；skip 不能作为 ComfyUI 工作流已经验证的证据。

涉及正式执行路径时，验证至少包括：

1. Worker 全量 pytest；
2. 根合同同步检查；
3. Backend → claim → Fake Provider → 回写 → OSS 测试替身的隔离合同；
4. Provider create 超时、已有 `providerTaskId`、Worker 重启和归档失败恢复；
5. 对应工作流 payload 与确认后的冻结请求一致。

三包集成门禁和独立审查要求见 [DEVELOPMENT_WORKFLOW](../../docs/DEVELOPMENT_WORKFLOW.md)。
