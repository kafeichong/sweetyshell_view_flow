# 创意同事一键脚本状态

> 更新日期：2026-09-15。
> 当前结论：`scripts/seedance_cli_smoke.sh` 仍发送旧 `capability/profile/params` 和 `mode=preview|production` 协议，不兼容当前 v2 Preview，也不具备 v2 Production 冻结快照确认流程。

## 当前禁止用于新任务

不要使用该脚本创建 Preview 或 Production 任务，包括：

```bash
./scripts/seedance_cli_smoke.sh
MODE=production ./scripts/seedance_cli_smoke.sh
```

旧脚本默认 Preview 仍会调用已经退休的 Task 创建语义；Production 缺少 v2 `PreflightRecord`、内容/报价摘要确认和冻结执行快照。修改环境变量不能使它变成合规的 v2 客户端。

历史操作说明已归档为 [v1 一键脚本手册](../archive/2026-09-15-creative-one-click-script-v1-superseded.md)，只能用于追溯，不能照做。

## 后续恢复条件

脚本只有在以下事项完成后才能重新作为受支持入口：

- 使用 v2 `POST /api/v1/tasks/preflight` 获取完整报告；
- 显示唯一 effectiveRequest、Production blockers 和 Quote；
- Production 只提交已确认的预检引用、摘要和素材映射；
- 已有 taskId 优先进入只读查询/取片，不先要求新预检；
- 默认不创建付费任务，且没有隐式时间戳导致重复生成；
- 自动化测试覆盖 Preview 零副作用、幂等、恢复和 Provider create 次数；
- 对应 Backend 版本完成部署和实际验收。

改造计划属于 [ROADMAP R5、R7](../ROADMAP.md#4-逐阶段实施清单)。当前创意同事可执行的安全操作只看 [v2 重构期间使用说明](./creative-user-guide.md)。
