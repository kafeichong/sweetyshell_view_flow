# Creative MVP T04–T07 工作归档

> 归档日期：2026-09-11
> 归档性质：T04/T07 实施过程与验证证据快照，不是当前现状或后续计划的唯一依据。
> 当前现状请看 [PROJECT_STATUS.md](../PROJECT_STATUS.md)，后续计划请看 [ROADMAP.md](../ROADMAP.md)。
> 前一阶段归档见 [T00–T01 总结](./2026-09-11-creative-mvp-T00-T01-summary.md)。

## 1. 本轮定位

在额度系统 T02 尚未完成、ProductionGate 仍保持关闭的前提下，优先补齐两类不依赖真实付费调用的能力：

- T04：Provider 提交不确定或 Backend 回写失败时，禁止重复提交并保留可追溯证据。
- T07：创意人员客户端提交超时或断线后，保留原始意图、幂等 key 和 taskId，支持安全恢复。

## 2. T04：Provider 提交安全

提交：

- `ad51533 feat: quarantine provider submission journal failures`
- `a6092a0 test: cover provider writeback failure recovery`
- `94f3728 fix: block claims after recovery write failure`

已完成：

- Provider 返回 `providerTaskId` 后，先写脱敏 JSONL journal，再回写 Backend。
- journal 只保存时间、`taskId`、`attemptId`、`providerTaskId`、阶段，不保存 token、Prompt 或完整 URL。
- journal 目录/文件权限分别为 `700` / `600`。
- journal 写入失败时当前任务进入 `requires_review`，错误码为 `JOURNAL_WRITE_FAILED`。
- Backend 回写 Provider ID 失败时进入 `requires_review`，错误码为 `PAYLOAD_TIMEOUT`。
- 持久化写入 `SUBMISSIONS_BLOCKED`，阻止后续新 claim/create。
- Worker 重启后读取阻断标记，原 Provider create 次数保持为 1。
- 已有 Provider ID 的任务仍允许恢复查询，不会因缺少新快照而重新 create。

## 3. T07：客户端提交回执

提交：

- `5e67035 feat: persist creative task submission receipts`

已完成：

- 新增 `ReceiptStore`，使用哈希文件名隔离意图，防止路径穿越。
- 回执采用临时文件、`fsync`、原子替换，目录/文件权限为 `700` / `600`。
- Production POST 前保存原始 body、mode、稳定幂等 key 和 `taskId=null`。
- POST 成功后把 `taskId` 写回同一回执。
- POST 超时保留原回执，重试继续使用同一个 key，不自动生成新版本。
- 已有回执且包含 `taskId` 时优先查询原任务，不重复 POST。
- Production 节点增加 `generation_version`，默认值为 `1`。
- 生成版本参与稳定幂等 key；只有显式变更版本才表示生成新一版。
- `VIDEO_FLOW_RECEIPT_DIR` 已加入客户端配置和使用文档。

## 4. 验证记录

隔离 worktree：`/private/tmp/video-flow-creative-mvp`，分支：`feat/creative-mvp`。

```text
T04 Worker targeted tests：9 passed
Worker full pytest：90 passed，26 expected skipped
T07 client + receipts + nodes tests：23 passed
```

本轮未调用真实 Ark、未部署、未推送、未开放 Production 白名单。T04/T07 使用本地测试和 Fake Provider，不证明真实模型生成质量。

## 5. 地址边界

| 运行位置 | 地址 |
| --- | --- |
| 创意人员电脑 ComfyUI | `https://ai.sweetyshell.com` |
| 公司服务器 Worker → Ark | `https://ark.cn-beijing.volces.com/api/v3` |
| 宿主机合同测试 → Fake Provider | `http://127.0.0.1:19091/api/v3` |
| Docker Worker → Docker Fake Provider | `http://fake-provider:19091/api/v3` |

`127.0.0.1:19091` 只属于同机合同测试，不能填给创意人员电脑或生产 Worker。

## 6. 尚未完成

- T07：Backend 地址 + actor 凭证的不可逆回执命名空间；回执写入失败的更细错误合同；跨包提交超时合同测试。
- T02：额度预占、原子 Production 准入和 ProductionGate。
- T03/T05/T06：领取、费用结算、归档状态和结果合同。
- T08–T12：真实 ComfyUI 工作流、可播放视频、日志告警、安装包和真实创意验收。

因此，本归档只能证明提交安全和客户端回执基础已实现，不能作为“创意人员已经可以稳定生成并交付成片”的签收依据。
