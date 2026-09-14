# Seedance 2.5 官网 PDF 整理（2026-09-14）

> 用途：将 Steven 下载的火山方舟官网 PDF 转为本项目可审查的字段、限制、任务生命周期和创意提示词规则。它是参考与证据索引，不描述系统当前开放状态；当前状态见 [PROJECT_STATUS.md](../PROJECT_STATUS.md)，实施计划见 [ROADMAP.md](../ROADMAP.md)。Provider 字段的采用结论同步见 [seedance-2-5-contract-evidence.md](seedance-2-5-contract-evidence.md)。

## 1. 来源与读取范围

本次读取了六份唯一文件；教程和提示词指南在用户提供的路径中各出现两次，按一份来源处理。

| 官网 PDF | 页数 | 本次用途 |
| --- | ---: | --- |
| `/Users/steven/Downloads/火山方舟_Doubao Seedance 2.5 教程_1789111197.pdf` | 78 | 能力、各任务示例、素材限制、限流与保留期 |
| `/Users/steven/Downloads/火山方舟_Doubao Seedance 2.5 提示词指南_1788801645.pdf` | 42 | 创意提示词写法、素材编号和任务触发语义 |
| `/Users/steven/Downloads/火山方舟_创建视频生成任务_1788952111.pdf` | 21 | `POST` 请求、字段合同、媒体限制、回调与错误机制 |
| `/Users/steven/Downloads/火山方舟_查询视频生成任务_1788952109.pdf` | 7 | `GET /{id}` 的终态、产物与 usage 合同 |
| `/Users/steven/Downloads/火山方舟_查询视频生成任务列表_1788952109.pdf` | 8 | 列表筛选、分页与恢复查询边界 |
| `/Users/steven/Downloads/火山方舟_取消或删除视频生成任务_1788952115.pdf` | 4 | `DELETE /{id}` 的状态机 |

源 PDF 保持在 Downloads，未复制入仓库、未修改。文本由 `pypdf` 提取；系统没有 Poppler，因此没有逐页渲染。所有写入下文的参数均另以创建/查询 API PDF 的字段表复核。

## 2. 对项目最重要的结论

1. **一个异步创建接口足够承载全部工作流。** 使用 `POST /api/v3/contents/generations/tasks`，通过 `content[]` 的类型和 `role`、再配合 `omni_reference_task_type` 区分工作流；不应为每种工作流新增一个 Provider endpoint。
2. **当前本项目应继续使用一个对外 `workflowKey` 入口。** Registry 负责把创作意图、素材角色和规格冻结为 execution plan；Worker 只编译已注册且已取证的 Ark 字段。
3. **官方字段证据不等于 Production 验收。** PDF 证明可以实现与校验的合同；每个新增 workflow 仍须经过资产校验、受控真实任务、费用与交付归档后才可标为 `production_verified`。
4. **必须转存产物。** 任务记录只可查询最近 7 天，视频/尾帧 URL 有效期 24 小时；Seedance 2.5 每个产物 URL 最多下载 100 次。

## 3. 创建任务合同

### 3.1 基础请求

```http
POST https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks
Authorization: Bearer $ARK_API_KEY
Content-Type: application/json
```

必填字段是 `model` 与 `content[]`。创建成功只返回任务 `id`，必须再查询或接收 callback 才能取得终态和视频 URL。

`content[]` 支持以下组合：纯文本；文本可选加图片、视频、音频；图片/视频/音频可任意组合。Seedance 2.5 支持只传参考音频，无需图片或视频。

| 媒体 | `type` | role | 官方输入方式 |
| --- | --- | --- | --- |
| 文本 | `text` | 无 | `text` 必填 |
| 首帧图片 | `image_url` | `first_frame` 或仅一张时不填 | URL、Base64、`asset://` |
| 尾帧图片 | `image_url` | `last_frame` | URL、Base64、`asset://` |
| 参考图片 | `image_url` | `reference_image` | URL、Base64、`asset://` |
| 参考视频 | `video_url` | `reference_video` | URL、`asset://` |
| 参考音频 | `audio_url` | `reference_audio` | URL、Base64、`asset://` |

首帧/首尾帧、全模态参考、视频编辑/延长是互斥场景，不能在一个请求中混用 `first_frame` / `last_frame` 与 `reference_*`。若业务需要“首尾帧 + 其他参考”，官方建议用全模态参考并在 prompt 中说明；只有严格固定起止画面才使用首尾帧工作流。

### 3.2 Generation 与输出字段

| 字段 | Seedance 2.5 官方规则 | 项目采用原则 |
| --- | --- | --- |
| `resolution` | 默认 `720p`；可用 `480p`、`720p`、`1080p` | 由每个 Registry generation policy 白名单控制 |
| `ratio` | `16:9`、`4:3`、`1:1`、`3:4`、`9:16`、`21:9`、`adaptive` | 首帧/首尾帧、编辑、延长只能 `adaptive`；其余不能借用该约束 |
| `duration` | `[4,30]` 或 `-1`；`frames` 与 `duration` 二选一且 `frames` 优先 | 编辑只能 `-1`；新增 workflow 先固定已验收规格 |
| `generate_audio` | 默认 `true`；生成有声或无声视频 | 作为显式 workflow 输入，不能依赖默认值 |
| `watermark` | 默认 `false` | 作为显式 policy，不能由前端任意提交 |
| `output_format` | 默认 `mp4`；可选 `mov` | `mov` 适合编辑/延长后期；`mp4` 适合网页和分发 |
| `return_last_frame` | 默认 `false`；成功结果返回无水印 PNG 尾帧 | 需要连续镜头时才启用；同视频一起及时转存 |
| `callback_url` | 状态变化 POST 回调，正文与查询结果同构 | 未来可替代频繁轮询；必须校验来源、幂等和状态倒退 |
| `safety_identifier` | 最长 64 字符；建议传稳定匿名哈希 | Backend 从 actor 派生，前端不得自填 |
| `priority` | `0–9`，只影响同 Endpoint 队列顺序 | 不作为创意用户可见参数 |

`1080p` 为 10-bit H.265/HEVC；`mov` 为 H.264 + yuv444p + PCM，适合调色、抠像和合成，但播放端兼容性较弱。生成音频为单声道。

## 4. 八类工作流的官方规则

| workflowKey | Provider 组合与关键限制 | 仍需项目侧完成 |
| --- | --- | --- |
| `seedance.text-to-video.v1` | `text` 即可；可指定 ratio 或使用 `adaptive` | 当前仅 Preview；做一次受控真实验收才可开放 |
| `seedance.reference-image-to-video.v1` | `reference_image` 1–30 张；文本可选 | 已有固定规格真实验收；扩大规格或素材数需重验 |
| `seedance.first-frame-to-video.v1` | 一张 `first_frame` 或未填 role 的单图；ratio 必须 `adaptive` | 上传 metadata 与真实验收 |
| `seedance.first-last-frame-to-video.v1` | 两张图，分别 `first_frame` 和 `last_frame`；ratio 必须 `adaptive` | 两图尺寸/裁剪预检与真实验收 |
| `seedance.omni-reference.v1` | `reference_image` / `reference_video` / `reference_audio`；`omni_reference_task_type=reference` 时 ratio、duration 无特殊限制 | 实现素材总量和总时长校验，再真实验收 |
| `seedance.video-edit.v1` | 至少一段 `reference_video`；`omni_reference_task_type=edit`；视频 4–30 秒；ratio=`adaptive`，duration=`-1` | 识别编辑意图、视频 metadata 预检、真实验收 |
| `seedance.video-extend.v1` | 至少一段 `reference_video`；`omni_reference_task_type=extend`；ratio=`adaptive` | 识别延长意图、视频 metadata 预检、真实验收 |
| `seedance.audio-reference-to-video.v1` | `reference_audio` 可单独传入，也可结合图片/视频 | 音频上传、时长校验和真实验收 |

`omni_reference_task_type` 默认 `auto`。显式 `reference`、`edit` 或 `extend` 会在提交时做对应的前置校验；模型之后仍会按 prompt 判定，意图不一致时可能异步失败 `InvalidParameter.TaskTypeMismatch`。`auto` 下参数约束不兼容可能异步失败 `InvalidParameter.TaskTypeConstraint`。

## 5. 上传票据和媒体预检的直接依据

| 媒体 | 格式与单项限制 | 数量/总量 |
| --- | --- | --- |
| 图片 | jpeg/png/webp/bmp/tiff/gif/heic/heif；宽高比 `[0.4,2.5]`；边长 `[300,6000]` px；单张 `<30MB` | 首帧 1，首尾帧 2，全模态参考 1–30；请求体 `<64MB` |
| 视频 | mp4/mov；H.264/AVC 或 H.265/HEVC；480p/720p/1080p/4k；比例 `[0.4,2.5]`；边长 `[300,6000]`；像素总数 `[407696,8295044]`；24–60 FPS；单段 `<200MB` | 非编辑单段 2–30 秒，编辑单段 4–30 秒；最多 10 段，总时长不超过 30 秒 |
| 音频 | wav/mp3；单段 `<15MB` | 单段 2–30 秒；最多 10 段，总时长不超过 30 秒；请求体 `<64MB` |

Seedance 2.5 不支持直接上传含真人人脸的参考图片或视频。需要使用官方允许的原始模型产物二创、预置虚拟人像，或已授权真人素材。此限制必须在创意界面、资产上传和真实验收前同时提示。

## 6. 查询、恢复与删除

| 操作 | 官方接口与行为 | 项目要求 |
| --- | --- | --- |
| 查询单任务 | `GET /contents/generations/tasks/{id}` | 保存 Provider ID，轮询 `queued` / `running`；终态读取 `content.video_url`、可选 `content.last_frame_url`、`usage`、`error` |
| 查询列表 | `GET /contents/generations/tasks` | 可按 model、service tier、status、重复的 `filter.task_ids` 筛选；`page_num`、`page_size` 范围均为 1–500。用于恢复已知任务，不用于猜测重提 |
| 删除/取消 | `DELETE /contents/generations/tasks/{id}` | `queued` 可取消并变为 `cancelled`；`succeeded` / `failed` / `expired` 可删除记录；`running`、`cancelled` 不支持 DELETE |

查询结果的状态包括 `queued`、`running`、`cancelled`、`succeeded`、`failed`；文档还定义了超时后的 `expired`。`usage.completion_tokens` 和 `usage.total_tokens` 是费用对账依据，视频生成中输入 token 为 0，故 `total_tokens = completion_tokens`。

## 7. 创意提示词落地规则

提示词指南的可执行原则如下：

1. 使用“主体 + 动作/事件 + 场景 + 视觉风格 + 运镜 + 声音”的顺序，长视频再按时间段拆分镜头与动作。
2. 多素材必须显式写出职责，如“参考@图像1的人物外观、@视频2的环绕运镜、@音频1的音色”；不要把素材映射只藏在图片中的文字里。
3. 编辑任务写清 `A -> B` 和“其余内容不变”；延长任务要明确“向前/向后延长、延续、续写”等意图。这样既提高结果稳定性，也和 `edit` / `extend` 的任务判定一致。
4. 声音使用约定：`()` 音乐、`<>` 音效、`{}` 台词、`【】`字幕；不需要时直接写“不要任何声音”“不要字幕”。
5. 纯文本可用中英及官方列示的其他语言；中文建议不超过 500 字，英文不超过 1000 词。超长 prompt 会分散重点、导致细节被忽略。

这些规则应进入创意端的 prompt helper 和 ComfyUI 节点说明，而不是硬编码为 Provider 参数。

## 8. 运行保护与实现优先级

- 企业限流：600 RPM、最大并发 10；个人限流：180 RPM、最大并发 3。非推理 API：单任务查询 QPS 20、列表 QPS 1、取消/删除 QPS 20。
- 当前项目应继续把并发、额度预占、`requires_review` 与“不确定提交不自动重试”作为自身安全层；不能把官方限流视作项目的预算控制。
- W2 应先实现第 5 节的 Asset ticket 与 metadata 检查；W3/W4 再为八类 workflow 冻结 role 与允许字段；W6 逐项在明确预算内做一次真实验收。
- 每次 `succeeded` 后立刻由 Worker 下载并转存视频、可选尾帧，再以自有 Asset URL 向创意端交付；不得把 24 小时临时 URL 作为长期产物。
