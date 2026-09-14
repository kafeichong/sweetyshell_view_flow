# 视频工作流与统一接口调研

> 日期：2026-09-14  
> 性质：架构研究与待决策材料，不描述当前系统现状，也不构成上线或付费调用授权。  
> 当前系统事实见：[PROJECT_STATUS.md](../PROJECT_STATUS.md)。当前实施计划见：[ROADMAP.md](../ROADMAP.md)。

## 1. 要解决的问题

创意部需要的能力不止单图图生视频，还包括文生视频、首帧图生、首尾帧、多个参考图、图片加参考视频、文字加参考视频，以及后续可能的音频参考。

如果按能力组合分别增加 `/text-to-video`、`/first-last-frame`、`/reference-video` 等生产接口，每条接口都会复制鉴权、额度、幂等、任务状态、Provider 恢复、费用结算和成片下载逻辑。能力组合越多，行为越容易分叉，无法保证同一套成本和交付边界。

目标是让创意人员在 ComfyUI 中看到多个清晰工作流，同时让后端保持一条稳定的受控任务链路。

## 2. 调研结论

### 2.1 业务工作流不应等同于后端接口

推荐分成三层：

| 层级 | 含义 | 例子 | 稳定性 |
| --- | --- | --- | --- |
| Capability | 创作意图与输入语义 | `TEXT_TO_VIDEO`、`FIRST_FRAME_TO_VIDEO`、`FIRST_LAST_FRAME_TO_VIDEO`、`REFERENCE_TO_VIDEO` | 稳定领域概念 |
| Workflow | 创意人员可导入的节点图、字段说明、默认值和准入规则 | `seedance.text-to-video.v1`、`seedance.first-last-frame.v1` | 可版本化迭代 |
| Provider Profile | 具体模型的请求字段、限制、计费口径与状态映射 | Seedance 或 MiniMax 的指定模型 | 随厂商版本变化 |

每条 Workflow 可以有独立的 ComfyUI 模板和创意操作说明，但不应有一套独立的后端任务接口。

### 2.2 外部平台的共同调用形态

MiniMax 官方文档把文生、图生、首尾帧和主体参考视频都作为异步视频生成任务：创建任务取得 `task_id`，轮询任务，再按输出文件标识下载。不同模式由提交内容中的文本和媒体字段区分，而不是不同的任务生命周期接口。见：[MiniMax 视频生成指南](https://platform.minimax.cn/docs/guides/video-generation)。

BytePlus 的 Seedance 增强视频生成文档使用一个 `content` 数组接收文本、图片、视频和音频输入，并通过统一的任务状态接口查询结果。该文档还说明不同模型对音频、媒体输入和引用方式有不同限制。见：[BytePlus 视频生成文档](https://docs.byteplus.com/en/docs/Byteplus_LAS/video_gen_enhanced)。

这说明应统一任务、资产和结果接口；Provider 特有字段只留在编译器中。外部平台的支持能力不能自动视为当前账号、模型或地区已开通能力。

## 3. 建议的统一领域请求

```json
{
  "workflowKey": "seedance.text-to-video.v1",
  "mode": "production",
  "prompt": {
    "positive": "一支护肤精华从透明水面缓慢升起，干净棚拍光影，镜头缓慢推进"
  },
  "generation": {
    "duration": 5,
    "ratio": "16:9",
    "resolution": "720p"
  },
  "media": []
}
```

同一入口也用于首尾帧；区别只在 `workflowKey` 和结构化媒体角色：

```json
{
  "workflowKey": "seedance.first-last-frame.v1",
  "mode": "production",
  "prompt": {
    "positive": "镜头从产品静置画面平滑推进到打开包装后的展示画面"
  },
  "generation": {
    "duration": 5,
    "resolution": "720p"
  },
  "media": [
    { "assetId": "asset-start", "role": "first_frame" },
    { "assetId": "asset-end", "role": "last_frame" }
  ]
}
```

客户端永远不提交 Ark、Seedance 或 MiniMax 的原始请求体，不自行指定模型、价格或任意 URL。所有媒体必须先经 Asset 上传与归属校验，再用 `assetId` 引用。

## 4. 服务端职责

建议保留单一生产任务入口 `POST /api/v1/tasks`，并逐步把它的请求升级为统一结构。稳定的资源接口分工如下：

| 接口职责 | 建议资源 | 责任 |
| --- | --- | --- |
| 上传与复用媒体 | `/api/v1/assets/*` | 上传、哈希、归属、MIME、大小、短期签名 URL |
| 创建受控生成意图 | `POST /api/v1/tasks` | 鉴权、幂等、Workflow 校验、额度预占、执行计划固化 |
| 查询任务 | `GET /api/v1/tasks/:id` | 任务、尝试、费用和交付状态 |
| 获取成片 | `GET /api/v1/assets/tasks/:id/result` | 本人任务的短期下载 URL |
| 浏览可用工作流 | `GET /api/v1/workflows` | 返回当前 actor 可用的 Workflow、输入 schema、固定规格和状态；不返回 Provider 密钥或内部价格规则 |

创建任务时，Backend 根据 `workflowKey` 解析服务端 Workflow Definition，再检查：

1. 当前 actor 是否获准使用该工作流；
2. `media[]` 的角色、数量、类型和互斥组合是否合规；
3. 每个 Asset 是否属于当前 actor 且已通过上传检查；
4. 该 Workflow 的模型、时长、比例、分辨率、音频、水印和预算预占是否固定；
5. 同一 `Idempotency-Key` 是否为同一完整意图；
6. Provider 能力是否已被当前模型、账号和地区的真实证据确认。

检查通过后，服务端把实际批准的 Workflow 版本、媒体角色、Asset 哈希、Provider Profile、规格和价格版本固化为 `executionPlan`。Worker 只执行这个快照，不能以客户端任意参数覆盖它。

## 5. 统一媒体角色

仓库已有的 `packages/worker/contracts.py` 定义可作为统一语义层：

| 角色 | 表达的创意含义 | 典型工作流 |
| --- | --- | --- |
| `first_frame` | 输出视频必须从该画面开始 | 单图首帧、首尾帧 |
| `last_frame` | 输出视频必须以该画面结束 | 首尾帧 |
| `reference_image` | 参考主体、风格、场景或物品 | 多图参考 |
| `subject_reference` | 需要保持特定主体特征 | 主体一致性工作流 |
| `style_reference` | 只约束视觉风格 | 风格参考工作流 |
| `reference_video` | 参考运动、镜头、节奏或素材 | 图加参考视频、文字加参考视频 |
| `reference_audio` | 参考声音、节奏或音频条件 | 音频驱动或音频参考 |

首帧和参考图不能混为一个通用 `image_asset_id`。首帧约束开场画面；参考图是引导信息。Provider 不支持某个组合时，由对应 Workflow Definition 在提交前拒绝，而不是让 Worker 发送后才猜测失败原因。

## 6. 第一批工作流目录

以下目录是建议的产品边界，不代表全部已生产可用。每项开放前必须有官方模型证据、离线合同测试和受控真实验收。

| 优先级 | Workflow Key | 创意输入 | 统一媒体角色 | 当前处理建议 |
| --- | --- | --- | --- | --- |
| P0 | `seedance.text-to-video.v1` | 提示词 | 无 | 先补齐生产规格、节点和真实验收 |
| P0 | `seedance.first-frame.v1` | 提示词 + 一张起始图 | `first_frame` | 把现有单图能力明确为首帧或参考图之一，不能继续语义模糊 |
| P1 | `seedance.first-last-frame.v1` | 提示词 + 两张帧图 | `first_frame` + `last_frame` | 独立校验两图尺寸/比例和模型支持 |
| P1 | `seedance.multi-reference.v1` | 提示词 + 多张图 | 多个 `reference_image`，可带主体/风格标签 | 先为当前模型建立数量和角色限制 |
| P2 | `seedance.image-video-reference.v1` | 提示词 + 图 + 参考视频 | `reference_image` + `reference_video` | 必须先验证当前账号的模型限制与素材政策 |
| P2 | `seedance.video-reference.v1` | 提示词 + 参考视频 | `reference_video` | 同上 |
| P3 | `seedance.multimodal-reference.v1` | 图、视频、音频、文字 | 多种 `reference_*` | 不与首批创意试点混做 |

## 7. 当前仓库的复用点与缺口

可复用：

- Task、ExecutionAttempt、Asset、ActorCredential 的身份、幂等、预算、轮询、归档和下载生命周期；
- `PromptSpec`、`GenerationSpec`、`MediaSpec`、`GenerationRequest` 的 Provider 无关表达；
- Seedance / MiniMax 编译器可以继续各自生成 Provider 请求；
- ComfyUI 的等待、恢复和结果下载节点可被所有 Workflow 复用。

需要补齐：

- Backend 公开请求仍以单个 `image_asset_id` 为中心，未接受结构化 `media[]`；
- 生产 `executionPlan` 当前把图片 Asset 设为必填，不能表达纯文生视频；
- `workflowName`、`workflowVersion`、`workflowHash` 已在数据模型预留，尚未成为受控 Workflow Registry；
- ComfyUI 客户端只有单图生成节点和两份单图/恢复模板；
- 当前线上 Seedance 模型的文生、首尾帧、多参考和视频参考能力尚未逐项完成账号级生产验收。

## 8. 明确不采用的方案

### 每个工作流一个独立生产接口

例如 `/text-to-video`、`/image-to-video`、`/first-last-frame`、`/reference-video`。该方案会让每种能力重复 Task 生命周期和资金控制，新增工作流时容易遗漏鉴权、幂等、额度、恢复或交付约束。

只有当不同工作流拥有完全独立的账号体系、计费主体、素材库和交付系统时才适合拆接口；当前系统的资产、账号、预算与任务追踪都应共享，因此不采用。

### 客户端直接传 Provider 原始字段

这会把 `content[]`、模型名、媒体 URL、价格或厂商限制泄露到 ComfyUI 节点和 Workflow JSON，导致无法安全升级 Provider 或限制高成本参数。客户端只能提交统一意图和本人 Asset ID。

## 9. 决策与下一步

待 Steven 确认的核心决策：采用“统一任务接口 + 版本化 `workflowKey` + 结构化 `media[]` + 服务端 Workflow Registry”。

确认后，应先形成能力矩阵：对每个 Workflow 记录 Provider、模型、账号/区域、官方来源、媒体限制、固定规格、预占依据、状态（`draft` / `preview_only` / `production_verified` / `disabled`）和验收 taskId。再按 P0、P1、P2 分批实施，不能因为编译器有代码就把能力直接标为生产可用。

## 10. 资料来源

1. [MiniMax 视频生成指南](https://platform.minimax.cn/docs/guides/video-generation)：文生、图生、首尾帧和参考生成的异步任务形态与媒体角色示例。
2. [MiniMax 文生视频 API](https://platform.minimax.cn/docs/api-reference/video-generation-t2v)：统一视频创建接口的文生请求、模型和参数示例。
3. [BytePlus Seedance 增强视频生成](https://docs.byteplus.com/en/docs/Byteplus_LAS/video_gen_enhanced)：`content` 多媒体输入、任务创建与查询、模型输入限制。
4. [火山引擎开发者社区 Seedance 视频 Skill 示例](https://developer.volcengine.com/articles/7615547765435432996)：历史 Seedance 模型的文生、首帧、首尾帧和参考图模式示例。该来源用于模式对照，不作为当前生产账号能力证明。
5. 仓库：`packages/worker/contracts.py`、`packages/worker/providers/capabilities.py`、`packages/worker/providers/seedance_compiler.py`。其中本地能力表和编译器代码不能替代官方/账号级验收。
