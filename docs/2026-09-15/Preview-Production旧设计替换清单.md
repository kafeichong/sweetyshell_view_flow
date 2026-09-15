# Preview / Production 旧设计替换清单

> 日期：2026-09-15。本文是 R0 调用者与替换边界快照，不维护当前完成状态；实施结果只写入 [PROJECT_STATUS](../PROJECT_STATUS.md)，顺序只写入 [ROADMAP](../ROADMAP.md)。

## 1. 总体决定

项目未正式上线，新建任务链不为错误设计继续增加兼容补丁。保留真实历史数据和恢复能力，冲突的接口、节点、状态和编译路径直接替换。

| 对象 | 决定 | 边界 |
| --- | --- | --- |
| Task / Attempt / Asset / ActorCredential | 保留 | 不清库、不改写 Provider ID、usage、预算或交付证据 |
| 身份、Actor 所有权、原子预算、对象真实哈希 | 保留并回归 | 迁移到 v2 合同，不复制第二套实现 |
| Preview Task | 停止用于新预检 | 历史记录只读；新增独立 PreflightRecord |
| 旧 `mode=preview` 创建 Task | 移除 | 改用 `/preflight`；旧客户端收到明确升级错误 |
| 固定 Production spec/金额 | 从新任务路径移除 | 仅可保留历史任务解释所需只读兼容 |
| 单一工作流 status | 替换 | 拆为 capability / implementation / admission / validation |
| 两个 Seedance 编译器 | 收敛为一个 | 正式 Worker 和测试必须走同一编译器 |
| 已有任务查询/下载 | 保留并前置 | 不重新检查新任务白名单、额度、预检或价格 |

## 2. Backend 调用者

| 文件/入口 | 当前角色 | 目标处理 |
| --- | --- | --- |
| `packages/backend/src/v1/tasks/v1-tasks.controller.ts` | 同时承担旧 Preview Task、预检、正式创建、固定金额回退 | 拆分调用 `PreflightService`、`TaskQuoteService` 和正式创建服务；`POST /tasks` 只创建 Production |
| `packages/backend/src/v1/tasks/workflow-preflight.ts` | 用 Task requestSnapshot 模拟预检记录，固定版本摘要 | 替换为独立 PreflightRecord、完整 contract/intent/quote digest |
| `packages/backend/src/tasks/workflow-registry.ts` | 内嵌规则且单状态混合成熟度 | 改为消费生成的 v2 合同资源；四维状态分别返回 |
| `packages/backend/src/tasks/production-spec.ts` | 环境变量固定模型、规格、价格和预占 | 新任务不再消费固定 duration/ratio/resolution/reserveCny；运行策略与账户定价分离 |
| `packages/backend/src/tasks/task-cost.ts` | 部分参数估算、输入视频固定 30 秒、固定价表 | 由统一报价服务替换；历史 usage 解释单独保留必要分支 |
| `packages/backend/src/tasks/task-budget.service.ts` | 额度检查、任务和预占原子创建 | 保留原子能力，输入改为已确认 Quote/ExecutionPlan |
| `packages/backend/src/assets/media-inspector.service.ts` | 实际媒体识别受 expected MIME 影响 | R2 改为先识别实际内容，再比较声明和角色 |
| `packages/backend/prisma/schema.prisma` | 没有独立 PreflightRecord | R1 增表和迁移，不重写旧 migration |

主要 Backend 测试调用者：

- `src/v1/tasks/v1-tasks.controller.spec.ts`
- `src/v1/tasks/workflow-preflight.spec.ts`
- `src/tasks/workflow-registry.spec.ts`
- `src/tasks/task-cost.spec.ts`
- `src/tasks/production-spec.spec.ts`
- `test/preflight.contract-spec.ts`
- `test/production-input.contract-spec.ts`
- `test/budget.contract-spec.ts`
- `test/claim-recovery.contract-spec.ts`
- `test/artifact-delivery.contract-spec.ts`
- `test/provider-outcome.contract-spec.ts`
- `test/preflight-http.smoke.cjs`
- `test/contract-harness.ts`

这些测试不能简单改期望让旧行为继续通过；应按 R1–R7 将 F01–F15 转成新合同的行为回归。

## 3. Worker 调用者

| 文件 | 当前角色 | 目标处理 |
| --- | --- | --- |
| `packages/worker/executor.py` | 正式执行调用 `compile_seedance_payload`，并承担 Provider 恢复和归档 | 保留执行与恢复边界；只消费冻结 execution plan |
| `packages/worker/providers/seedance_execution_policy.py` | 当前正式编译器，缺文本/音频且规则不完整 | 作为唯一编译入口重构，读取同步 v2 合同，覆盖 8 类 |
| `packages/worker/providers/seedance_compiler.py` | 另一套编译器，已有部分 4–30 测试但非正式入口 | 迁移有价值的校验和测试后移除 |
| `packages/worker/providers/seedance_adapter.py` | 正式 Ark 提交/查询/usage | 保留；只接收编译完成 payload，不猜工作流 |
| `packages/worker/tests/test_seedance_execution_policy.py` | 正式编译器定向测试 | 扩为 8 类和边界测试 |
| `packages/worker/tests/test_workflow_contracts.py` | 测试另一编译器 | 合并到唯一入口后删除重复测试 |
| `packages/worker/tests/test_provider_submission_recovery.py` | Provider ID 恢复 | 保留并增加“恢复不重提”回归 |

## 4. ComfyUI 客户端调用者

| 文件/节点 | 当前角色 | 目标处理 |
| --- | --- | --- |
| `packages/comfyui-video-flow-client/nodes.py` | 注册旧独立 Preview/Production/OneClick/Text Preview；旧 Preview 会上传 | 移除旧生成节点注册和上传式 Preview；保留或迁移通用配置/恢复能力 |
| `packages/comfyui-video-flow-client/preflight_nodes.py` | 新同画布链，但请求类型分散、媒体检查不完整、恢复顺序错误 | 收敛为共用策略、素材检查、请求、预检、确认、恢复、下载节点 |
| `packages/comfyui-video-flow-client/client.py` | 上传、预检、任务、回执和下载调用 | 明确分离无上传 preflight、确认后上传、新任务创建和原任务恢复 |
| `packages/comfyui-video-flow-client/install.sh` | 安装节点和模板 | R7 只发布 v2 节点、合同资源和 8 类模板 |
| `packages/comfyui-video-flow-client/workflows/*.json` | 新旧模板并存，部分仅 Preview | 按同一结构重新生成/校验；修复链接并删除被取代模板 |
| `packages/comfyui-video-flow-client/tests/test_preflight_nodes.py` | 主要覆盖现有节点和少量静态连线 | 增加实际本地媒体检查、8 类模板、恢复优先和 Preview 出站边界 |

## 5. 配置和脚本调用者

| 配置/脚本 | 目标处理 |
| --- | --- |
| `.env.example` 的 `VIDEO_FLOW_PRODUCTION_SPEC_JSON` | 标记旧新建任务配置；由合同版本、启用策略和定价来源替代 |
| `scripts/run_mvp_contract.sh` | 从固定 5 秒 production spec 迁移到 v2 合同和 Fake Provider 8 类场景 |
| `scripts/seedance_cli_smoke.sh` | 不再调用旧 `mode=preview` Task；改用 `/preflight` 和明确确认结构 |
| `scripts/seedance_production_acceptance.py` | R8 保留为受控真实验收工具，但必须消费正式 v2 流程并显示估价/授权范围 |
| 容器构建和客户端安装 | 加入 `contracts/seedance-workflows.v2.json` 同步产物及摘要检查 |

## 6. 历史数据兼容

只保留以下读取/恢复兼容：

- 按 actor 查询旧 Task；
- 读取旧 ExecutionAttempt 的 `providerTaskId`、提交证据和状态；
- 继续轮询已提交 Provider 任务；
- 读取/补齐已有生成 Asset 和下载链接；
- 按旧任务冻结字段解释历史费用，无法确认时保持 `unavailable` 或待核查。

不保留以下写入兼容：

- 用旧 Preview Task 创建新的正式任务；
- 用旧固定 spec 覆盖用户 4–30 秒参数；
- 用旧固定 `reserveCny` 填补未知报价；
- 用旧状态值绕过 v2 实现和启用检查；
- 因恢复失败自动重提 Provider。

## 7. F01–F15 责任映射

| 发现 | 新责任单元 | 主要阶段 |
| --- | --- | --- |
| F01 新旧 Preview 行为冲突 | 客户端统一节点链 + `/preflight` 唯一入口 | R1、R5、R7 |
| F02 Preview 被生产权限阻断 | PreflightService 双结果报告 | R1 |
| F03 报告与生效请求矛盾 | effectiveRequest + 独立 PreflightRecord | R1 |
| F04 角色与媒体类型未绑定 | 工作流合同 + 共用媒体检查 | R1、R2 |
| F05 adaptive/-1 固定金额回退 | TaskQuoteService 的 bounded/unavailable | R3 |
| F06 输入视频固定 30 秒 | 实际媒体时长求和 + 最低 Token | R2、R3 |
| F07 三阶段金额不一致 | 单一 Quote/quoteDigest | R3、R4 |
| F08 价格适用条件和结算缺失 | pricingSnapshot + usage/账单分态 | R3、R4 |
| F09 规则/价格未绑定 | contractDigest + quoteDigest | R1、R3 |
| F10 视频/音频本地输入缺失 | 通用 media_inspection + 8 类模板 | R2、R5、R6 |
| F11 状态混合、工作流未实现 | 四维状态 + 8 类纵向链 | R1、R6 |
| F12 测试与正式编译器不同 | 唯一 Worker 编译器 | R4、R6、R7 |
| F13 实际媒体误识别 | 服务端内容优先识别 | R2 |
| F14 原任务恢复被新准入阻断 | 回执优先恢复服务 | R5 |
| F15 模板连线错误 | 合同生成模板 + 全模板图校验 | R5、R7 |

所有发现均已有唯一责任单元和阶段，不再以局部条件分支继续补旧设计。
