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
