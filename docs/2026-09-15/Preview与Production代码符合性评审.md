# Preview 与 Production 规则符合性评审

- 评审与归档日期：2026-09-15。
- 依据：[Preview 与 Production 职责界定](./Preview与Production职责界定.md)。
- 范围：当日包含未提交修改的本地工作区；客户端、Backend、Worker 的实际执行路径、已有测试和本地定向复现。
- 性质：固定日期的评审快照，不随修复回填，不代表线上状态。最新实现与验证只看 [PROJECT_STATUS](../PROJECT_STATUS.md)，修正计划只看 [ROADMAP](../ROADMAP.md)。
- 本轮评审未修改业务代码，未调用付费 Provider，未验收线上部署或实际 ComfyUI 出片。

## 1. 结论

代码部分满足职责定义，尚不能认定 Preview 和各工作流的 Production 完整实现。

可保留的基础包括鉴权、预算事务、实际文件 SHA-256 校验、Provider 任务恢复、提交不确定处理和交付分离。缺口集中在 Preview 入口不统一、报告与估价不完整、各工作流覆盖不足、媒体识别及客户端恢复流程。

按完整职责评判，参考图片路径最接近完成，其他工作流仍需实质开发。模板或编译器存在不等于完整工作流完成，已有测试全绿也不代表新职责全部满足。

## 2. Preview 逐项判断

| 规则 | 当日判断 | 代码表现 / 发现编号 |
| --- | --- | --- |
| 同一画布默认 Preview，明确切换 Production | 部分满足 | 新模板遵循；旧独立节点和模板仍注册，F01 |
| Preview 不上传素材 | 不满足 | 旧 Preview 会调用 upload_media，F01 |
| 不调用生成 Provider、不预占、不创建可执行任务 | 满足已检查路径 | Preview 保存为不可执行状态；正式 claim 排除 Preview |
| 本地检查素材并计算哈希 | 部分满足 | 图片实现；视频/音频输入与首帧文件刷新缺口，F10 |
| 服务端统一检查参数和角色、数量、顺序 | 部分满足 | 角色与媒体类型未关联检查，F04 |
| 请求检查和正式提交资格分开报告 | 不满足 | 生产权限/暂停直接阻断；工作流禁用原因未完整展示，F02、F03 |
| 能估价则展示依据，不能则明确未知 | 不满足 | 估算失败回退固定金额，F05、F06 |
| 展示唯一、实际生效的请求摘要 | 部分满足 | request 和 effectiveSpec 可能包含相互矛盾的生成规格，F03 |
| 绑定账号、内容、规则、价格和有效期 | 部分满足 | 基础绑定存在；工作流规则与价格表内容绑定不完整，F09 |

## 3. 费用规则逐项判断

| 规则 | 当日判断 | 代码表现 / 发现编号 |
| --- | --- | --- |
| 按本次请求参数估算 | 部分满足 | 指定价格版本、普通比例、无输入视频的请求已有计算；其他场景缺口，F05、F06 |
| 输入视频按实际时长参与估算 | 不满足 | 只要存在视频就按 30 秒，不读取真实时长或累计多段，F06 |
| 自适应比例、编辑和延长正确估算或明确未知 | 不满足 | adaptive / duration=-1 不支持，Preview 固定回退，F05 |
| Preview、检查和正式预占金额一致 | 不满足 | checkPreflight 使用固定 reserveCny，F07 |
| 包含适用优惠、账户价格及特殊计费规则 | 不满足 | 硬编码价格缺生效期、账户价格、输入视频最低用量规则，F08 |
| 真实 usage 结算，未知费用不伪装为确定费用 | 部分满足 | Backend 已实现 usage 计算与待核查；适用价格仍不完整，F08 |

## 4. Production 逐项判断

| 规则 | 当日判断 | 代码表现 / 发现编号 |
| --- | --- | --- |
| 身份、生产权限、暂停和额度校验 | 满足代码层面 | 服务端负责，客户端开关不能直接放行 |
| 有效预检记录和明确确认 | 满足基础要求 | 检查账号、有效期、内容和确认字段；规则绑定待补，F09 |
| 上传后校验归属和实际文件哈希 | 满足已检查路径 | 实际读取对象字节计算 SHA-256 |
| 独立识别实际媒体类型 | 部分满足 | 图片判断依赖预期 MIME，F13 |
| 创建任务与预算预占一起完成 | 满足代码层面 | 同事务、并发锁、最终额度复验 |
| 按确认参数调用正式接口 | 部分满足 | 已开放路径可透传；其他工作流未全部实现，F11、F12 |
| 重复提交复用原任务 | 满足基础机制 | 客户端持久回执、Backend 同键同内容检查 |
| 原任务等待和取片不要求新预检 | 部分满足 | 底层支持，但新画布在找回任务前检查预检和预算，F14 |
| 提交不确定时不自动重复生成 | 满足已检查路径 | Provider ID 恢复、提交日志、待核查处理 |
| 生成和交付分离，交付失败不重新生成 | 满足基础机制 | 独立归档恢复分支与 delivery 状态 |
| 能力支持、启用和验证记录分开 | 不满足 | 一个工作流状态混合表达三个维度，F11 |

## 5. 发现清单与代码证据

路径相对于仓库根；行号对应当日工作区，后续修复可能移动。下表是当日发现，不是当前待办状态。

| 编号 | 发现与影响 | 源码证据 |
| --- | --- | --- |
| F01 | 旧 Preview 仍上传素材且仍被注册；新旧入口共存导致同名模式行为不同。旧 Production 节点也没有接入完整预检确认流程 | `packages/comfyui-video-flow-client/nodes.py:81`、`:134`、`:304` |
| F02 | 预检要求生产白名单和生产配置，暂停直接报错；不能在请求检查后单独报告正式提交阻止原因 | `packages/backend/src/v1/tasks/v1-tasks.controller.ts:65` |
| F03 | 报告没有完整的请求检查/正式准入双结果；禁用工作流可得到 valid=true 的记录检查结果；effectiveSpec 可能仍显示与请求不同的固定参数 | `packages/backend/src/v1/tasks/v1-tasks.controller.ts:89`、`:98`；`packages/comfyui-video-flow-client/preflight_nodes.py:268` |
| F04 | Preview 分别验证媒体自身信息与角色数量，却未核对角色对应的媒体类型；音频冒充 reference_image 可通过预检，Production 才拒绝 | `packages/backend/src/v1/tasks/workflow-preflight.ts:23`；`packages/backend/src/tasks/workflow-registry.ts:161` |
| F05 | adaptive 和 duration=-1 无法估算，Preview 静默回退 reserveCny；若只开放首帧状态，正式创建仍会在估算处失败 | `packages/backend/src/tasks/task-cost.ts:35`、`:48`；`packages/backend/src/v1/tasks/v1-tasks.controller.ts:74`、`:206` |
| F06 | 输入视频时长固定为 30 秒；不累计多视频、不处理最低 Token，用固定 24 FPS 和推导尺寸计算，缺完整适用条件与依据展示 | `packages/backend/src/tasks/task-cost.ts:33` |
| F07 | Preview 动态估算、checkPreflight 固定金额、正式提交动态估算，三个阶段口径不一致 | `packages/backend/src/v1/tasks/v1-tasks.controller.ts:74`、`:105`、`:206` |
| F08 | 价格表硬编码且缺优惠/账户价/有效期；结算重新查静态价格表，未消费执行计划里的 pricingRatePerMillion；估算也未核对模型与价格规则是否匹配 | `packages/backend/src/tasks/task-cost.ts:18`、`:43`、`:179` |
| F09 | 预检快照包含固定 PREFLIGHT_VERSION、specDigest 和 intent，未包含工作流版本及实际规则/价格表摘要；这些内容变化未必令旧凭证失效 | `packages/backend/src/v1/tasks/workflow-preflight.ts:37` |
| F10 | 新多参考输入最多三张图片；缺视频/音频本地检查节点和编辑/延长/音频模板。首帧、首尾帧输入没有 ProductInput 的 IS_CHANGED 刷新机制 | `packages/comfyui-video-flow-client/preflight_nodes.py:95`、`:142`、`:177`、`:187`、`:373` |
| F11 | Registry 状态混合开发/启用/验收；仅参考图正式开放；实际 Worker 编译策略缺文本与音频参考，不能仅改状态完成开发 | `packages/backend/src/tasks/workflow-registry.ts:3`；`packages/backend/src/v1/tasks/v1-tasks.controller.ts:157`；`packages/worker/providers/seedance_execution_policy.py:14` |
| F12 | 正式 Worker 使用 compile_seedance_payload；此前 4–30 秒测试针对另一编译器。正式编译器缺普通时长等完整复验，31 秒可原样输出 | `packages/worker/executor.py:956`；`packages/worker/providers/seedance_execution_policy.py:93` |
| F13 | 媒体检查器遇到视频流时按 expectedMime=image/* 返回 image；未独立识别图片格式与真实容器 | `packages/backend/src/assets/media-inspector.service.ts:31` |
| F14 | 新画布先检查预检有效期/权限/预算，之后才查已有任务回执；过期或额度不足可能阻止原任务恢复 | `packages/comfyui-video-flow-client/preflight_nodes.py:255`、`:290` |
| F15 | 文本预检模板节点输入与全局 links 表不一致：节点6 task 引用 link7，节点7 config 引用 link9；现有连线测试主要覆盖产品图模板 | `packages/comfyui-video-flow-client/workflows/seedance-text-to-video-preflight-v1.comfy.json`；`packages/comfyui-video-flow-client/tests/test_preflight_nodes.py:169` |

### 5.1 本地定向复现结果

使用内存替身和测试配置，不连接真实数据库、OSS 或 Provider；固定回退金额为 2 元。

| 输入或触发 | 当日输出 |
| --- | --- |
| 30 秒、16:9、1080p、参考图，创建预检后检查同一记录 | 预算服务先收到 112.266000，再收到 2 |
| 首帧、adaptive、1080p，创建预检 | 估算失败后报告 estimatedCostCny=2，parameters=passed |
| 检查上述禁用首帧预检记录 | valid=true；实际 Production 创建仍会拒绝 |
| 已鉴权但不在生产白名单 | 预检返回 403 |
| 已鉴权、在白名单，但生产暂停 | 预检返回 400 PRODUCTION_PAUSED |
| reference_image 角色配合法 audio/mpeg 音频元信息 | preflightIntent 接受 |
| 输入视频分别为2秒与30秒，输出固定5秒、16:9、720p | 两次 estimateSeedanceCost 均返回 31.752000 |
| 正式编译器接收普通参考图 duration=31 | 输出 payload.duration=31；Backend 正常入口仍会拒绝此参数 |
| 正式编译器接收文本或音频参考工作流 | 抛出 unsupported workflow |
| 注入 MP4/H.264/5秒探测结果，expectedMime=image/png | MediaInspectorService 返回 kind=image |
| 执行计划带1080p、pricingRatePerMillion=55.44，usage=100000 | interpretUsage 按静态77计算为7.700000，未消费冻结单价 |

以上金额是复现代码行为的测试结果，不是官方实际账单。媒体类型复现使用注入的探测结果，不冒充真实文件上传验收。

### 5.2 对此前口头判断的更正

1. “Preview 都不上传”只适用于新预检链；旧节点仍上传。
2. “Worker 已二次检查4–30秒”不适用于实际正式执行编译器。
3. Worker 固定70元辅助方法属于旧任务兼容分支。新任务在 `executor.py:1054` 先向 Backend 报告 usage、进行交付并返回，不能把旧方法直接认定为新任务的正式结算错误。

## 6. 各工作流的当日覆盖

| 工作流 | Preview | Production | 完成判断 |
| --- | --- | --- | --- |
| 参考图片 | 有新模板与图片检查 | 已有正式链路 | 部分满足，仍受公共估价、报告与恢复缺口影响 |
| 文本生视频 | 有模板，但连线引用错误 | 准入拦截且实际编译器缺少策略 | 未完成 |
| 首帧 | 有模板；自适应估价、文件刷新有缺口 | 有编译策略；准入及估价未闭合 | 未完成 |
| 首尾帧 | 有模板；同类缺口 | 有编译策略；正式链路未闭合 | 未完成 |
| 多模态参考 | 客户端仅最多三张图片 | 有部分策略；视频/音频输入及估价未闭合 | 未完成 |
| 视频编辑 | 有后端规则；缺新客户端输入与模板 | 有策略；特殊时长和估价未闭合 | 未完成 |
| 视频延长 | 有后端规则；缺新客户端输入与模板 | 有策略；特殊时长和估价未闭合 | 未完成 |
| 音频参考 | 有后端规则；缺新客户端输入与模板 | 实际编译器缺少该工作流 | 未完成 |

## 7. 已验证并可保留的基础

- Preview Task 不可被正式 Worker 领取：`packages/backend/src/tasks/task-claim.service.ts:17`。
- 正式接口服务端鉴权与准入、账号/预检/内容复验：`packages/backend/src/v1/tasks/v1-tasks.controller.ts:185`。
- 读取实际 OSS 字节核验 SHA-256：`packages/backend/src/assets/asset-presign.service.ts:107`。
- 创建 Task 与预占在同一事务内执行：`packages/backend/src/tasks/task-budget.service.ts:67`。
- 精确请求与幂等键持久回执：`packages/comfyui-video-flow-client/client.py:191`。
- Provider ID 恢复与不确定提交日志：`packages/worker/executor.py:831`。
- Backend 原始 usage 解释、费用未知待核查：`packages/backend/src/executions/executions.service.ts:117`。
- 生成和交付分离：`packages/worker/executor.py:1054`；已有任务可恢复归档。
- 正式地址配置约束：`packages/worker/config.py:7`，测试 Provider 地址必须显式处于隔离测试模式。

## 8. 验证命令与证据范围

| 命令（标明执行目录） | 当日结果 |
| --- | --- |
| Backend：`npm run build && npx jest --runInBand` | 通过，24 suites / 223 tests |
| Worker：`venv/bin/python -m pytest -q` | 202 passed / 26 skipped / 12 deselected |
| 客户端：`.venv/bin/python -m pytest -q` | 80 passed |
| Backend：`node test/preflight-http.smoke.cjs` | 通过，真实本地 HTTP/Nest Guard，存储/额度/OSS 为替身 |
| 仓库根：`git diff --check` | 通过 |
| 五份新预检模板的双向连线静态检查 | 四份一致，文本模板发现两处输入引用错误 |

本轮没有重新执行完整 Docker/数据库跨包合同，也未在真实 ComfyUI 中运行全部画布。历史成功结果不能替代本轮证据。Worker 预期外部资产 skip 和未运行的 live contract 不计为已覆盖。

定向复现为内联只读诊断，未新增业务测试文件。后续修正应将 F01–F15 转化为新合同下的持久回归用例，具体安排见 ROADMAP。

## 9. 归档后的设计方向

Steven 明确：产品尚未正式上线，错误设计可以在此阶段替换，不必为延续错误设计不断叠加兼容补丁。

据此，修正应先梳理统一入口、预检与正式任务、工作流能力与启用、报价与结算、创建与恢复的职责，再逐项实现。保留已有可靠执行和资金基础；存在的任务、Provider ID、产物和费用证据仍需保护。新的实施阶段、依赖与验收出口只在 [ROADMAP](../ROADMAP.md) 维护。
