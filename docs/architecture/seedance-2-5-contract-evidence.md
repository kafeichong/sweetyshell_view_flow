# Seedance 2.5 Provider 契约证据库

> 日期：2026-09-14  
> 用途：记录工作流 Registry 和 Worker 编译器可以依赖的字段证据。它不是当前系统状态；当前状态见 [PROJECT_STATUS.md](../PROJECT_STATUS.md)，实施顺序见 [ROADMAP.md](../ROADMAP.md#10-seedance-25-工作流目录扩展计划2026-09-14)。
>
> 规则：只有“火山方舟原始官方示例”或“当前账号真实任务”可以让字段进入 Provider 编译器或使工作流进入 Production。相同模型系列、旧项目代码和第三方文章只能辅助发现模式，不能替代前两者。

## 1. 证据等级

| 等级 | 含义 | 可用于 |
| --- | --- | --- |
| A：官方原始示例 | 当前火山方舟文档、SDK 示例或 API Explorer 的完整请求/响应 | 写入 Preview 编译器 fixture；待账号验收后可进入 Production |
| B：当前账号真实验收 | 本项目受控任务已有 Provider ID、终态、交付 Asset 和费用证据 | 标记 `production_verified` 的唯一依据 |
| C：同系列交叉参考 | BytePlus ModelArk 等同系列官方文档 | 设计素材策略和待核对列表，不能照抄字段 |
| D：历史本地资产 | 旧项目 Builder、ComfyUI workflow、历史记录 | 迁移线索和回归素材，不能定义新 Provider payload |

## 2. 已取得的 A 级官方 quickstart：参考图 + 参考视频编辑

**来源：** `/Users/steven/Downloads/ark_seedance2.5_quickstart_package/python/demo_standard.py`，行 92–154。  
**模型：** `doubao-seedance-2-5-260628`。  
**创建：** `client.content_generation.tasks.create(...)`。  
**查询：** `client.content_generation.tasks.get(task_id=task_id)`。

已明确的请求字段：

```python
client.content_generation.tasks.create(
    model="doubao-seedance-2-5-260628",
    content=[
        {"type": "text", "text": "将视频1礼盒中的香水替换成图片1中的面霜，运镜不变"},
        {"type": "image_url", "image_url": {"url": "https://example.invalid/image.jpg"}, "role": "reference_image"},
        {"type": "video_url", "video_url": {"url": "https://example.invalid/video.mp4"}, "role": "reference_video"},
        # 可选音频示例：type="audio_url"、role="reference_audio"
    ],
    generate_audio=True,
    ratio="adaptive",
    duration=-1,
    watermark=True,
)
```

已明确的生命周期字段：创建结果取 `create_result.id`；轮询结果读 `get_result.status`；成功时读取 `get_result.content.video_url`；失败时读取 `get_result.error`。quickstart 没有展示 usage、尾帧、`output_format` 或 callback 的真实响应结构，因此这些字段不进入当前项目的稳定结果合同。

对应的脱敏 shape fixture 是 `packages/worker/tests/fixtures/seedance_2_5_reference_edit_official.json`。它只用于 JSON shape 测试，URL 使用 `.invalid`，不可调用。

## 3. 同系列官方交叉参考（C 级）

[BytePlus Seedance 增强视频生成文档](https://docs.byteplus.com/en/docs/Byteplus_LAS/video_gen_enhanced) 当前说明：

- `content` 接受 text、image、video、audio；创建响应为异步任务 `id`；
- Seedance 2.5 可使用 `adaptive` ratio，支持首帧、首尾帧、多模态参考、编辑、延长及音频参考；
- 文档列出 `return_last_frame`、`generate_audio`、`resolution`、`duration` 等概念和媒体限制。

该文档使用 BytePlus LAS 的端点和账户体系。它可以帮助我们设计 Registry 的媒体和 generation policy，不能证明火山方舟 `doubao-seedance-2-5-260628` 的同名字段、默认值、错误码、地区限制或计费规则完全相同。

## 4. 历史本地资产（D 级，禁止直接发布）

`/Users/steven/mylab/video_works/integrations/comfyui/ComfyUI-Seedance-Ark/ark_client.py` 有 `first_frame`、`last_frame` 和参考音频的 Builder；`workflows/seedance-2.5-first-last-frame-v1.api.json` 有对应节点图。这些文件表明历史项目曾按以下语义建模：

- 首帧：图片 role=`first_frame`；
- 首尾帧：两张图片分别为 `first_frame` 与 `last_frame`；
- 参考编辑：`reference_image` + `reference_video`；
- 音频参考：`reference_audio`。

它们不是当前官方来源，并且部分历史说明与 quickstart 的 ratio/duration 选择不同。因此当前仓库不得依据它们发送首帧/尾帧/延长的真实请求；它们仅用于设计 role 互斥测试与未来迁移参考。

## 5. 工作流证据矩阵

| workflowKey | 当前字段证据 | 允许状态 | W1 仍缺少的火山方舟原始证据 |
| --- | --- | --- | --- |
| `seedance.reference-image-to-video.v1` | B：本项目真实验收；当前实现 role=`reference_image` | `production_verified`（仅已验收固定规格） | 若扩多图、音频或改规格，重新取证和验收 |
| `seedance.text-to-video.v1` | C：同系列文档；无本账号原始请求 fixture | `preview_only` | 火山方舟 T2V SDK/HTTP 示例及创建/终态响应 |
| `seedance.first-frame-to-video.v1` | D：历史 Builder；C：同系列概念 | `disabled` | 首帧 role、ratio/duration 约束、错误样例 |
| `seedance.first-last-frame-to-video.v1` | D：历史 Builder；C：同系列概念 | `disabled` | 两帧 role、ratio/duration 约束、错误样例 |
| `seedance.omni-reference.v1` | A：quickstart 证明图+视频，音频项为注释；C：多模态概念 | `disabled` | 多图/纯音频上限、显式任务类型字段、真实终态响应 |
| `seedance.video-edit.v1` | A：quickstart 证明图+视频编辑形态 | `disabled` | `edit` 显式字段是否需要、源视频/输出时长和错误约束 |
| `seedance.video-extend.v1` | C/D：概念线索 | `disabled` | 延长方向、必填视频角色、ratio/duration 和结果字段 |
| `seedance.audio-reference-to-video.v1` | A：音频 content 项被官方 quickstart 注释展示；C：纯音频能力 | `disabled` | 纯音频是否可用、数量/时长、任务类型和结果字段 |

## 6. 不进入代码的待核对字段

以下名称来自 Steven 提供的能力表或同系列资料，尚无当前火山方舟原始请求证据：`omni_reference_task_type`、`return_last_frame`、`output_format`、延长方向字段、同步前置校验错误码 `InvalidParameter.TaskTypeMismatch` 与 `TaskTypeConstraint`。

在取得 A 级证据前：

1. Registry 不暴露能够发送这些字段的 Production 节点；
2. Worker 编译器不序列化这些字段；
3. 文档可以作为“待取证能力”提及，但不能列为本账号已支持；
4. 任何 Provider 4xx/5xx 仍遵循当前 `requires_review` 和不自动重提规则。

## 7. 下一份所需官方材料

优先顺序：首帧/首尾帧 → 文生 → 视频编辑/延长 → 纯音频/全模态参考。每份材料至少应包含 SDK 或 HTTP 创建请求、创建响应、轮询成功响应和一个错误示例；页面若动态加载或需登录，可由 Steven 提供原始导出、复制文本或截图。

## 8. Steven 提供的火山方舟官方原始示例（2026-09-14）

以下代码由 Steven 从火山方舟 Seedance 2.5 教程原样提供，按本文件规则列为 A 级请求字段证据。示例中的官方素材 URL 已在本仓库 fixture 中替换为 `example.invalid`，避免测试触发外部下载或生成。

### 8.1 文本 + 参考图片

Python SDK 示例使用 `content_generation.tasks.create`、模型 `doubao-seedance-2-5-260628`、一条 `text` 和一张 `image_url`，图片 role 为 `reference_image`；示例使用 `generate_audio=True`、`ratio="16:9"`、`duration=30`。提示词以 `@图像1` 引用素材。它证明的是**文本 + 参考图片生视频**，不证明无素材的纯文生视频。

轮询合同与第 2 节一致：创建结果读取 `id`，查询读取 `status`，成功读取结果对象，失败读取 `error`。

### 8.2 全模态参考

HTTP 示例证明：

- `content` 可同时包含 `text`、`image_url` role=`reference_image` 和多个 `video_url` role=`reference_video`；
- `omni_reference_task_type` 可取 `"reference"`；
- 请求可明确 `generate_audio=true`、`ratio="16:9"`、`duration=15`、`output_format="mov"`；
- 提示词以内联编号 `@图像1`、`@视频1` 等关联参考素材。

该示例展示了 1 张图片和 6 段视频。它证明“多参考可组合”，不把示例数量误写为产品允许的最小/最大值。

### 8.3 视频编辑

HTTP 示例为一条编辑意图 text 加一段 `video_url` role=`reference_video`，并明确：

```json
{
  "generate_audio": true,
  "ratio": "adaptive",
  "duration": -1,
  "omni_reference_task_type": "edit",
  "output_format": "mov"
}
```

因此编辑工作流的 `adaptive` 与 `duration=-1` 已有当前火山方舟直接示例。实际素材限制、错误响应和当前账号真实验收仍需在 W2/W6 取得证据。

### 8.4 视频延长

HTTP 示例为 text 加 3 段 `reference_video`，并明确：

```json
{
  "generate_audio": true,
  "ratio": "adaptive",
  "duration": 11,
  "omni_reference_task_type": "extend",
  "output_format": "mov"
}
```

它证明延长允许多个视频参考以及数值时长；不把该示例推导为“必须三段视频”或任何未提供的延长方向字段。

### 8.5 首帧与首尾帧

HTTP 示例明确图片角色 `first_frame` 和 `last_frame`，并使用：

```json
{
  "generate_audio": true,
  "ratio": "adaptive",
  "duration": 5
}
```

同一请求同时带两种 role 时即为首尾帧；只带 `first_frame` 的单首帧变体还需在实现时通过 Registry 的素材数量规则表达，不从该示例臆造额外 Provider 参数。

### 8.6 本次更新后的边界

已有 A 级请求字段证据的工作流：参考图片、首帧/首尾帧、全模态参考、视频编辑、视频延长。`output_format="mov"` 也已得到 A 级证据。

仍没有 Steven 提供的当前火山方舟原始示例：无媒体的纯文生视频、仅音频参考的生成。它们继续分别保留为 `preview_only` 和 `disabled`，不得借用“文本 + 图片”或 quickstart 的注释音频项推断真实请求合同。

## 9. 取代第 5、6 节的工作流证据矩阵（2026-09-14）

| workflowKey | 当前请求字段证据 | 允许状态 | 进入 Production 前仍缺少 |
| --- | --- | --- | --- |
| `seedance.reference-image-to-video.v1` | A：文本+`reference_image`；B：本项目真实验收 | `production_verified`（仅已验收固定规格） | 变更规格、多图、音频时重新验收 |
| `seedance.text-to-video.v1` | 无媒体的 A 级示例尚缺 | `preview_only` | 纯文本创建/终态原始示例及真实验收 |
| `seedance.first-frame-to-video.v1` | A：`first_frame`、`adaptive`、数值 duration | `disabled` | 当前账号真实验收、素材校验和错误合同 |
| `seedance.first-last-frame-to-video.v1` | A：`first_frame` + `last_frame`、`adaptive` | `disabled` | 当前账号真实验收、素材校验和错误合同 |
| `seedance.omni-reference.v1` | A：图 + 多视频、`omni_reference_task_type="reference"`、`mov` | `disabled` | 当前账号真实验收、素材数量/限制合同 |
| `seedance.video-edit.v1` | A：`reference_video`、`edit`、`adaptive`、`duration=-1`、`mov` | `disabled` | 当前账号真实验收、素材限制和错误合同 |
| `seedance.video-extend.v1` | A：多 `reference_video`、`extend`、`adaptive`、数值 duration、`mov` | `disabled` | 当前账号真实验收、素材限制和错误合同 |
| `seedance.audio-reference-to-video.v1` | 无纯音频 A 级示例 | `disabled` | 纯音频创建/终态原始示例及真实验收 |

第 6 节列出的 `omni_reference_task_type` 和 `output_format` 已不再属于待核对字段；其余未在本节证实的字段仍不得进入 Provider 编译器。

## 10. 官网 PDF 补充证据（2026-09-14）

**来源：** Steven 下载的 `创建视频生成任务`、`查询视频生成任务`、`查询视频生成任务列表`、`取消或删除视频生成任务`、`Doubao Seedance 2.5 教程` 与 `提示词指南` PDF；逐项摘要见 [官网 PDF 整理](seedance-2-5-official-pdf-digest-2026-09-14.md)。这些是当前火山方舟 API 字段表与教程，列为 A 级证据。

本批补齐了此前尚缺的合同：

- 纯文生：`content` 可以只有 `{"type":"text","text":"..."}`；因此 `seedance.text-to-video.v1` 已有 A 级请求字段证据，但仍仅 `preview_only`，等待本账号单次真实验收。
- 纯音频：Seedance 2.5 可只提交 `audio_url` role=`reference_audio`，也可与图片/视频组合；因此音频工作流已有 A 级字段与媒体限制证据，但仍 `disabled`，等待上传链路和真实验收。
- 素材数量与限制：参考图 1–30；参考视频最多 10 段、总时长不超过 30 秒；参考音频最多 10 段、总时长不超过 30 秒；视频编辑输入视频为 4–30 秒。
- 返回尾帧：`return_last_frame=true` 时，查询结果 `content.last_frame_url` 返回无水印 PNG 尾帧；视频与尾帧 URL 均 24 小时有效，Seedance 2.5 每 URL 下载最多 100 次。
- 任务终态：查询结果有 `content.video_url`、`usage.completion_tokens` / `total_tokens`、`error.code` / `message`、`output_format`、`ratio`、`resolution`、`duration` 或 `frames`。任务仅保留最近 7 天。
- 任务状态与删除：`queued` 可取消为 `cancelled`；`running` 不可 DELETE；`succeeded`、`failed`、`expired` 可删除记录。

第 7 节的“下一份所需官方材料”被上述 PDF 取代：目前 W1 缺的不是字段名称，而是各模式在当前账号的受控真实验收、项目 Asset 预检实现，以及可归档的失败样例。

## 11. 取代第 9 节的工作流证据矩阵（2026-09-14）

| workflowKey | 当前请求字段证据 | 允许状态 | 进入 Production 前仍缺少 |
| --- | --- | --- | --- |
| `seedance.reference-image-to-video.v1` | A：`reference_image` 及限制；B：本项目真实验收 | `production_verified`（仅已验收固定规格） | 变更规格、多图、音频时重新验收 |
| `seedance.text-to-video.v1` | A：纯 text 组合、ratio/duration 规则 | `preview_only` | 本账号一次受控真实验收、结果/费用归档 |
| `seedance.first-frame-to-video.v1` | A：`first_frame`、`adaptive`、单图规则 | `disabled` | Asset 预检、当前账号真实验收 |
| `seedance.first-last-frame-to-video.v1` | A：`first_frame` + `last_frame`、`adaptive`、两图规则 | `disabled` | Asset 预检、当前账号真实验收 |
| `seedance.omni-reference.v1` | A：三类 `reference_*`、1–30 图/10 视频/10 音频、`reference` | `disabled` | 项目总量校验、当前账号真实验收 |
| `seedance.video-edit.v1` | A：`reference_video`、`edit`、`adaptive`、`duration=-1`、4–30 秒 | `disabled` | 视频 metadata 校验、当前账号真实验收 |
| `seedance.video-extend.v1` | A：`reference_video`、`extend`、`adaptive` | `disabled` | 视频 metadata 校验、当前账号真实验收 |
| `seedance.audio-reference-to-video.v1` | A：纯 `reference_audio`、音频格式/时长/数量限制 | `disabled` | 音频上传与 metadata 校验、当前账号真实验收 |

## 12. 创建任务 API 核对：组合、互斥与返回值语义（2026-09-16）

**要查 Provider 接口规则，顺序是：** ① 先看 `contracts/seedance-workflows.v2.json`（`media` / `contentRules` / `pricing`，每条规则都带 evidence id）；② 再看本地官方快照 `docs/arkdocs/*.md`；③ 最后才开官网。官网页面 **WebFetch 会被域名策略挡住**（`docs.volcengine.com`、`www.volcengine.com`、`bytedance.larkoffice.com` 都不行），要用**本机浏览器**打开后逐段读——本轮就是这么核对的。

来源：[创建视频生成任务](https://docs.volcengine.com/docs/82379/1520757?lang=zh)（合同 evidence id `official-seedance-2.5-create-task-api`，本地快照 `docs/arkdocs/视频生成教程.md`）。

| 规则 | 内容 |
| --- | --- |
| content 组合 | 官方枚举 8 种：纯文本；文本（可选）+ 图片 / 视频 / 音频；+ 图音 / 图视频 / 视频音频 / 图视频音频。**文本提示词对全模态参考是可选字段** |
| 至少一个参考素材 | 全模态参考要求 content 中**至少有一个** `reference_image` / `reference_video` / `reference_audio`；三类可自由组合（图片 0-30、视频 0-10、音频 0-10） |
| **三类场景互斥** | 图生视频-首帧、图生视频-首尾帧、全模态参考生视频**不可混用**：`first_frame` / `last_frame` 与 `reference_*` 不能出现在同一个 content 里。全模态参考只能在提示词里指定某张参考图充当首帧/尾帧 |
| `omni_reference_task_type` | `auto`（默认，模型判定，冲突异步报错）/ `reference` / `edit` / `extend`；**显式指定会在提交时提前校验**，不符合立即报错且任务不创建 |
| `duration` 返回值 | 接口返回的 `duration` = **实际总帧数 / 24，向下取整**；官方举例"最终生成 133 帧 → 5.54 秒 → 返回 5" |

**为什么值得单独记**：最后一条是官方自己说明"帧数 ≠ 时长 × 帧率"，既解释了本项目在真实结算里实测到的"+1 帧"（见 `pricing.estimate.reservationAdjustment`），也说明计费按实际出片帧数计是官方口径；互斥规则则是客户端模板层面必须避开的坑（首尾帧模板与全模态模板不能互相混用角色）。

上述规则已写入合同 `contentRules` 并带官方证据指针；客户端侧对应实现是「不给素材」空槽约定、每个输入的 `tooltip`、节点 `DESCRIPTION`、以及 `MultiReferenceRequest.VALIDATE_INPUTS` 的排队前校验（`packages/comfyui-video-flow-client/preflight_nodes.py`），并由 `tests/test_contract_alignment.py` 断言客户端本地上限与合同一致。
