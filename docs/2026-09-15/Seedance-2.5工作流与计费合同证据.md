# Seedance 2.5 工作流与计费合同证据

> 日期：2026-09-15。本文是 R0 取证快照，不描述当前代码已具备的能力；当前事实只看 [PROJECT_STATUS](../PROJECT_STATUS.md)。可执行规则见 [seedance-workflows.v2.json](../../contracts/seedance-workflows.v2.json)。

## 1. 结论

- 八类目标工作流均有火山方舟 Seedance 2.5 官方能力或字段证据，可以按完整 Preview + Production 方向开发。
- Production 使用统一正式创建接口 `POST /api/v3/contents/generations/tasks`，模型 ID 为 `doubao-seedance-2-5-260628`；工作流差异由 `content[].role`、生成参数和 `omni_reference_task_type` 表达。
- 普通生成在产品层开放明确的整数 4–30 秒；视频编辑必须 `duration=-1`，不能让“4–30 秒”覆盖编辑的官方特殊合同。
- 费用可以按实际参数估算，但含输入视频时还有官方最低 Token 规则。仓库尚未保存该规则的具体表格，因此含视频输入的 Production 预占目前必须标记为不可用，不能拿简单公式或固定金额兜底。
- API 成功结果的 `usage.completion_tokens` 是准确用量依据；按冻结单价计算出的费用仍属于 usage 推算，不等于账单已确认。

## 2. 官方来源

| 来源 | 仓库快照/摘要 | 取证内容 |
| --- | --- | --- |
| [创建视频生成任务](https://docs.volcengine.com/docs/82379/1520758?lang=zh) | [官网 PDF 整理](../architecture/seedance-2-5-official-pdf-digest-2026-09-14.md) | 正式接口、字段、素材限制、异步错误 |
| [Seedance 2.5 教程](https://docs.volcengine.com/docs/82379/2607688?lang=zh) | [本地 Markdown](../arkdocs/Doubao%20Seedance%202.5%20教程.md) | 模型 ID、任务类型、示例、输出规格、媒体约束 |
| [视频生成教程](https://docs.volcengine.com/docs/82379/2298881?lang=zh) | [本地 Markdown](../arkdocs/视频生成教程.md) | 能力对照、24 fps、模型输出规格、结果结构 |
| [模型价格](https://docs.volcengine.com/docs/82379/1544106?lang=zh#02affcb8) | [本地 Markdown](../arkdocs/模型价格.md) | 单价、估算公式、促销、最低 Token、`completion_tokens` |
| [Seedance 2.5 提示词指南](https://docs.volcengine.com/docs/82379/2607689?lang=zh) | [本地 Markdown](../arkdocs/Doubao%20Seedance%202.5%20提示词指南.md) | 多素材职责、编辑/延长意图和任务类型 |

2026-09-15 通过网页检索确认官方创建 API 页面仍存在；动态文档正文需要 JavaScript，字段细节由上述仓库内官方页面快照和 PDF 摘要交叉核对。价格是否适用于当前账户仍必须在实际账户/下单结果确认。

## 3. 八类工作流

| 工作流 | 官方输入和参数 | 产品 v2 采用范围 | 证据结论 |
| --- | --- | --- | --- |
| 文生视频 | 仅 text；ratio 可六档或 adaptive；duration `[4,30]` 或 `-1` | 明确 4–30 秒；六档或 adaptive | 已确认 |
| 参考图片 | `reference_image`，1–30 张；普通 ratio/duration | 明确 4–30 秒；六档或 adaptive | 已确认，官方有 30 秒示例 |
| 首帧 | 一张 `first_frame`；ratio 只能 adaptive | 明确 4–30 秒 | 已确认 |
| 首尾帧 | 一张 `first_frame` + 一张 `last_frame`；ratio 只能 adaptive | 明确 4–30 秒，顺序固定 | 已确认 |
| 全模态参考 | image/video/audio 任意组合，总上限 50；`omni_reference_task_type=reference` | 明确 4–30 秒；至少一项参考素材 | 已确认 |
| 视频编辑 | 至少一段 `reference_video`，可有其他参考素材；type=edit、ratio=adaptive、duration=-1；待编辑视频 4–30 秒 | 保留特殊 `-1`，不显示普通时长选择 | 已确认 |
| 视频延长 | 至少一段 `reference_video`，可有其他参考素材；type=extend、ratio=adaptive；duration `[4,30]` 或 `-1` | 明确 4–30 秒；暂不开放自动时长 | 已确认 |
| 音频参考 | Seedance 2.5 支持只传 `reference_audio`；最多 10 段，总时长不超过 30 秒 | 音频专用入口 1–10 段，明确 4–30 秒输出 | 已确认 |

全模态入口与图片/音频专用入口存在能力重叠，这是产品入口分工，不是两个 Provider 接口：专用入口降低操作复杂度，全模态入口承担混合素材。

## 4. 输出和素材规则

### 输出

- 分辨率：480p、720p、1080p。
- 比例：21:9、16:9、4:3、1:1、3:4、9:16、adaptive。
- 输出帧率：24 fps。
- 时长：官方一般范围 `[4,30]` 或 `-1`；编辑只允许 `-1`。
- 格式：mp4、mov；官方建议编辑和延长使用 mov，但不是强制写死为唯一格式。
- 声音和水印必须进入生效请求与摘要，不能依赖客户端未展示的默认值。

### 输入素材

| 类型 | 主要限制 |
| --- | --- |
| 图片 | jpeg/png/webp/bmp/tiff/gif/heic/heif；边长 300–6000；比例 0.4–2.5；单张小于 30 MB；最多 30 张 |
| 视频 | mp4/mov；H.264/H.265；单段 2–30 秒，编辑素材 4–30 秒；24–60 FPS；单段不超过 200 MB；最多 10 段、总时长不超过 30 秒 |
| 音频 | wav/mp3；单段 2–30 秒；单段不超过 15 MB；最多 10 段、总时长不超过 30 秒 |

参考素材合计最多 50 个。首帧/首尾帧与 `reference_*` 属不同任务形状，不在一个正式请求中混用。真实人脸参考素材另受官方授权素材规则约束；本系统 `assetId` 不能充当方舟授权资产 ID。

## 5. 费用规则

### 5.1 公开刊例价

| 输出 | 无输入视频 | 有输入视频 |
| --- | ---: | ---: |
| 480p / 720p | 70.00 元/百万 token | 42.00 元/百万 token |
| 1080p | 77.00 元/百万 token | 46.00 元/百万 token |

官方页面记录：北京时间 2026-08-14 14:00 至 2026-09-17 14:00，Seedance 2.5 的 1080p 按刊例价 72 折；480p/720p 不参与。该活动不能被永久硬编码为默认价格，必须按时间并确认实际账户/下单适用性。

### 5.2 估算

```text
estimatedTokens =
  (sum(inputVideoDurationSeconds) + outputDurationSeconds)
  × outputWidth × outputHeight × 24 / 1024

estimatedCny = estimatedTokens × applicableRate / 1_000_000
```

- 输入视频时长必须按全部 `reference_video` 实际时长求和。
- 没有输入视频时，输入图片和音频不进入该公式的“输入视频时长”。
- 固定比例的宽高使用官方像素表。
- adaptive 的宽高若由首帧或待编辑/延长视频锁定，应从被锁定素材推导；无法确定时只能给有依据的上界或 `unavailable`。
- `duration=-1` 同理，不能假装是 5 秒或固定金额。

### 5.3 最低 Token 与最终账单

Seedance 2.0/2.5 在输入包含视频时存在最低 Token：当公式估算低于最低值时按最低值计费。最低值依赖分辨率、比例和输出时长，官方价格页指向独立表格/计算器；当前仓库没有该表的可执行数据。

因此 R0 的安全结论是：

- 无输入视频、规格确定且账户价格已确认：可以形成 estimated 报价；
- 有输入视频但最低 Token 规则未解析：Preview 显示公式结果仅供解释，Production 报价为 `unavailable`，不得预占并提交；
- Provider 返回后以 `usage.completion_tokens` 作为准确 Token 用量；冻结适用单价后可形成 `usage_calculated`；
- Provider 账单/订单结果确认后才是 `billed`。

## 6. 明确阻碍与后续输入

| 缺项 | 影响 | 后续动作 |
| --- | --- | --- |
| Seedance 2.5 输入视频最低 Token 明细表尚未结构化保存 | 视频参考、编辑、延长无法形成安全 Production 预占 | R3 前从官方表格或账户计算器取得可审计数据和版本 |
| 当前账户实际价格/活动适用性未读取 | 公开刊例不能冒充账户最终价 | R3 增加账户价格来源和有效期；R8 真实验收核对订单/账单 |
| 8 类工作流尚未逐项真实付费验收 | 官方能力不能冒充本系统可用 | R8 经明确授权逐项记录范围、任务、产物、usage 和费用 |

以上阻碍只影响启用和真实验收，不否定继续开发全部工作流。
