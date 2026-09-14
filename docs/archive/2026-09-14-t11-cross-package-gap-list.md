# T11 跨包回归残缺项清单（我先执行版）

> 来源：`docs/ROADMAP.md` 与 `docs/PROJECT_STATUS.md`

## 当前结论
T11 的主干跨包闭环中，E01、E02、E06、E07、E09、E13 已有跨包覆盖；E03/E04/E05/E08/E10/E11/E12 仍未形成跨包用例。

## 未做成跨包用例的项

- E03：同意图并发两次（Cross package）
  - 当前：各包内用例覆盖
  - 风险：未验证真实跨包“同一意图并发”下 `provider create = 1`
  - 处理建议：新增跨包用例，固定 `Idempotency-Key + clientRequestId + 并发请求`，断言 Task 不重复、预占一次、Provider create=1

- E04：两个新意图抢最后预算（Cross package）
  - 当前：各包内用例覆盖
  - 风险：仅预算服务层面验证，缺少跨包“预算拒绝 + 没有 Provider 落库”联动
  - 处理建议：跨包并发提交两新意图，断言仅一个成功，另一个 429，`provider create` 只增长 1 次

- E05：Provider 已受理但提交/响应断链（Cross package）
  - 当前：各包内用例覆盖
  - 风险：真实链路对 `requires_review` 与恢复路径可能偏差
  - 处理建议：在 fake provider 注入提交侧异常，断言不再次提交，不再重建新 Attempt；原 taskId 与 providerTaskId 可恢复

- E08：无 usage 或 usage 无效（Cross package）
  - 当前：各包内用例覆盖
  - 风险：跨包下费用状态与准入联动未压实
  - 处理建议：fake provider 返回 usage 缺失/非法，断言 `costSummary.status=unavailable|review`，`usageCalculated` 不误写 0，新准入受限

- E10：自定义 output / 下载中断 / 签名过期（Cross package）
  - 当前：各包内用例覆盖（含部分 T08 对齐）
  - 风险：下载与目录恢复在跨服务层面仍未全链路验证
  - 处理建议：跨包用例覆盖 COMFY 输出目录切换、下载中断恢复、签名刷新；同一 taskId 下 `create` 不重复

- E11：越权 Task/Asset / 错配 Attempt（Cross package）
  - 当前：各包内用例覆盖
  - 风险：权限穿透有可能只在跨服务组合时出现
  - 处理建议：跨包脚本加场景：他人 Task/Asset 访问+Attempt mismatch，断言 403/404，delivery 不被污染

- E12：容器重建 / 日志轮换 / 告警通道失败（Cross package）
  - 当前：各包内用例覆盖
  - 风险：journal 与告警失败状态缺少 end-to-end 可观测性验证
  - 处理建议：跨包模拟容器重建，验证关键 journal 保留，告警发送失败不会误报 success

## 我先做（当前可执行）

- 我先落：
  1. 将上述 7 项以“最小用例骨架”方式补到 `packages/worker/tests/test_mvp_live_contract.py`。
  2. 同步更新 `scripts/run_mvp_contract.sh` 的跨包测试收集校验，不再硬编码 `5 tests`，改为“当前测试文件收集数量自动读取”。
  3. 在文档里同步每项状态（待办/进行中/已补齐），便于你逐条验收。

- 我不做（本轮）:
  - 真实 ComfyUI 环境验证（T08）
  - 外部告警通道和生产断链演练（T10/T12）

## 跨包用例骨架（下发级）

### E03：`test_same_intent_concurrent_requests_create_once`
- 入口：`packages/worker/tests/test_mvp_live_contract.py`
- 逻辑：同一 `prompt + Idempotency-Key` 并发提交 2~3 次
- 断言：
  - 任务最终收敛到单条 Task（允许 201/409）
  - `provider_stats(createCount)` 只增 1
  - 第二次开始与恢复取片都不触发新 create

### E04：`test_concurrent_new_intents_budget_race_one_success`
- 逻辑：给 actor 提交两个新意图，在余额或日额度接近上限（通过环境配置或请求设计）条件下并发触发
- 断言：
  - 一条成功，一条 429
  - `provider create` 不重复
  - 失败任务无 `providerTaskId`

### E05：`test_submit_response_lost_does_not_double_submit`
- 逻辑：用 fake provider 设置提交侧行为，模拟“已受理但客户端没拿到/提交响应异常”
- 断言：
  - 无重复 create
  - 任务进入可恢复状态（`requires_review` 或已存在 `providerTaskId`）
  - 恢复流程不改写为新任务

### E08：`test_usage_missing_keeps_cost_unknown`
- 逻辑：fake provider 返回 `usage` 缺失或非法
- 断言：
  - `costSummary.status` 为不可计费状态
  - 不用 0 作成功计费填充
  - 新任务准入触发预算复核时不因 usage 误判放开

### E10：`test_custom_output_resume_and_signature_refresh`
- 逻辑：设置自定义输出目录，模拟下载中断、重试、签名刷新
- 断言：
  - 文件仍在预期目录内留痕可追溯
  - 同 taskId 下再次取片不再触发 Provider create

### E11：`test_unauthorized_cross_owner_access_is_forbidden`
- 逻辑：新建第二个 Actor Token，尝试读取/恢复他人 task 或 mismatch attempt
- 断言：
  - 只返回 403 或 404
  - 不泄露 `providerTaskId / objectKey / assetId`

### E12：`test_rebuild_retain_journal_and_alert_state_is_truthful`
- 逻辑：执行任务后模拟容器重建或日志路径轮换边界
- 断言：
  - 关键 journal 文件可检索
  - 告警失败状态可见（不误报成功）
  - 失败恢复路径仍以原 task/taskId 为锚点

## 对应脚本改动建议

- 在 `scripts/run_mvp_contract.sh` 把收集数校验从固定字符串改为：
  - 运行 `pytest tests/test_mvp_live_contract.py -m live_contract --collect-only`
  - 解析 `collected` 行为 N（当前应为可变）
  - 仅校验 `N >= 5` 且 < 20（避免测试新增后误报）
  - 这样每次我补测试都不需要同步改脚本阈值

## 备注

- 当前 `docs/PROJECT_STATUS.md` 已把 T08/T10/T12 标记为外部环境项；本文件是把 T11 剩余的跨包缺口拆成可执行清单。
