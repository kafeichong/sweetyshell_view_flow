# ComfyUI Video Flow Client

这是 Video Flow 的 ComfyUI 自定义节点包。客户端只访问公司 Backend，不持有 Ark、OSS、数据库或 Worker 服务密钥。

## 交付判定

本 README 不记录阶段完成度。是否允许安装、创建新任务或使用 Production，只看 [PROJECT_STATUS](../../docs/PROJECT_STATUS.md) 的当前结论；后续任务和开放门禁只看 [ROADMAP](../../docs/ROADMAP.md)。在权威现状明确记录客户端交付包已经验收前，**本目录不能作为创意同事的新任务安装包或操作手册**。

当前代码只注册统一入口：

- `preflight_nodes.py`：v2 参数、本地素材检查、Preview、按执行槽正式提交、等待、下载和交付确认；
- `nodes.py`：只保留 Config 以及按已有 `taskId` 等待、下载的独立恢复入口；
- `workflows/`：保留当前**七份** Preview/Production 画布，覆盖七类产品工作流；旧上传式 Preview、无预检 Production、固定规格 OneClick 和对应模板已经退出注册与安装包；参考图那条工作流已退休（见下），它的 `seedance-product-preflight-v1.comfy.json` 一并撤出；
- `examples/seedance-resume.json`：只查询和下载已有 Task，不创建新任务。

全模态参考不使用固定数量的大节点。`参考图片`、`参考视频`、`参考音频`节点都可以接入上一节点输出的 `reference_media` 并追加一个素材，因此按需要串联即可；仓库模板示范“图片 → 视频 → 音频”，不表示必须同时提供三种素材。**槽位可以留在「不给素材」**：下拉第一项就是它，选它的节点不读文件、不追加，只把上游列表原样传下去——所以多摆的槽位不需要删除连线，也不需要右键旁路节点，创意想加素材直接选、不想加就晾着（每个输入项的悬停提示与节点说明都写了这条约定）。**下拉只能看到 `input` 目录里已有的文件**，要把本机别处的文件放进来：图片、视频槽用 ComfyUI 自带的上传按钮（节点上的 `image_upload` / `video_upload` 标志），音频槽用本包的 `web/audio_upload.js` 挂的「选择音频文件上传」按钮——音频不能沿用那个标志，因为前端那条路是写给自带 `LoadAudio` 家族的，我们的自定义节点接进去会取不到它要的 `audioUI` 而报错。客户端先按官方合同检查图片最多 30 张、视频最多 10 段、音频最多 10 段、总数最多 50 个及视频/音频各自总时长不超过 30 秒；**官方要求至少有一个参考素材**，一个都没选时请求节点会在**执行到它时**报出可操作提示——ComfyUI 的自定义校验（`VALIDATE_INPUTS`）在排队阶段拿不到连线输入的值，只能在这一步拦。完整 Preview 仍必须由 Backend 使用同一合同复验。

**产品图 / 参考图一律用这个模板**：`seedance.reference-image-to-video.v1`（单参考图）已**退休**——它在 provider 侧与全模态参考是同一种任务类型（`omni_reference_task_type=reference`），不重复开第二条入口；对应的 `seedance-product-preflight-v1.comfy.json` 不再交付，注册表里的 `VideoFlowProductInput` / `VideoFlowProductRequest` 两个节点保留但说明已写明退化到哪个入口。单图场景就是只放一张参考图、其余槽位留在「不给素材」；要「图严格当第一帧」则改用首帧模板。

官方（火山方舟创建视频生成任务 API）另有一条硬规则：**图生视频-首帧、图生视频-首尾帧、全模态参考生视频是三种互斥场景，不可混用**——`first_frame` / `last_frame` 与 `reference_image` 不能出现在同一个请求里。需要首尾帧就整条走首尾帧模板；全模态参考里想让某张参考图当首帧，只能在提示词里指定。

视频编辑模板使用同一个参考视频集合节点，编辑请求固定提交 `duration=-1`、`ratio=adaptive`、`omni_reference_task_type=edit` 和 `outputFormat=mov`（输出时长由模型按提示词定，官方口径可能比输入略短约 0.4 秒）。输入视频必须为 4–30 秒，计费走**含输入视频**那一档（42 元/百万）。该工作流已按 [§13](../../docs/runbooks/r8-production-acceptance-scope.md) 长期开放。

视频延长模板示范串联三段参考视频，仍可按需增删图片、视频或音频追加节点。延长请求向用户开放输出时长 4–30 秒，固定提交 `ratio=adaptive`、`omni_reference_task_type=extend` 和 `outputFormat=mov`。**接口只返回"延长出来的那一段"**（输入 5 秒 + 延长 5 秒 → 成片 5 秒），要拼到原视频上需自己后期处理；延长按**整帧**计费（成片帧数 = 时长 × 24，没有生成类那多出的一帧）。该工作流已按 §12 长期开放并完成真实验收。

音频参考模板示范串联两段音频，实际可使用 1–10 段、每段 2–30 秒、总时长不超过 30 秒。该专用入口只接受 `reference_audio`，并映射到官方 `omni_reference_task_type=reference`；**需要图片或视频参与时改用全模态参考模板**（音频参考这条刻意不放开素材角色：同一种 provider 任务类型不重复开两条入口）。它的产品语义是**用音频驱动画面**——口型、动作、节奏与音频对齐；**成片音轨不是创意传进去的那几段音频**，而是模型按提示词与画面生成的声音（官方：生成的有声视频均为单声道，与传入音频的声道数无关），要保留原音必须自己后期替换。纯音频不触发输入视频最低 Token 规则，自动化合同已覆盖 4 秒和 30 秒正式预占、Fake Provider、usage 结算和 MP4 交付，但源工作流仍须等真实 ComfyUI 与发布验收后开放。

因此，“节点已注册”“模板可导入”或“客户端测试通过”均不等于已经开放 Preview 或 Production。权威现状未关闭客户端交付门禁前，不要在创意主实例安装本目录，也不要用旧节点创建新任务。

创意同事在重构期间只查询、等待或重新下载已有任务，见 [v2 重构期间使用说明](../../docs/runbooks/creative-user-guide.md)。

## 开发边界

所有工作流改造必须遵守 [Preview 与 Production 统一需求规范 v2](../../docs/requirements/2026-09-15/workflow-preview-production-spec-v2.md)：

- 同一画布默认 Preview；用户切换 Production 后保持该模式，没有一次性确认开关；缺少有效预检时本次 Queue 只 Preview，再次 Queue 才请求正式提交；
- Preview 只发送参数、素材元信息与内容哈希，不上传素材，不调用生成 Provider，不创建可执行任务、付费 Attempt 或预算预占；
- Production 必须消费与当前内容匹配的有效预检记录，并由服务端完成身份、准入、额度、冻结请求和实际素材复验；
- 已有任务的查询、等待和重新下载不得依赖新预检、新额度或重新提交 Provider；
- 客户端开关、节点名称和本地回执都不能替代服务端校验。

阶段接口状态不在本 README 重复维护，开发和联调前必须先核对 [PROJECT_STATUS](../../docs/PROJECT_STATUS.md) 与对应 runbook，不得把某一子包单独部署给创意人员使用。

## 目录说明

| 路径 | 作用 | 当前注意事项 |
| --- | --- | --- |
| `preflight_nodes.py` | v2 请求、预检、恢复优先的正式提交、等待、下载和交付确认 | 未完成项与阶段归属只看 ROADMAP |
| `media_inspection.py` | 本地素材检查与哈希 | 需与服务端实际媒体复验共同形成边界 |
| `client.py` | Backend API、回执、查询和下载客户端 | 旧 Task 创建方法仍为迁移期代码，不代表当前可用入口 |
| `nodes.py` | Config 与已有 taskId 的等待/下载恢复节点 | 不包含新任务创建入口 |
| `workflows/` | v2 开发中画布模板 | 逐工作流验收完成前不得整体标记为可交付 |
| `tests/` | 客户端单元与模板检查 | 不替代真实 ComfyUI Queue Prompt 验收 |
| `install.sh`、`install_creative.command` | 历史安装入口 | 当前存在不等于获准安装；达到 ROADMAP 的包装门禁后再恢复使用 |

## 本地开发与验证

使用客户端自己的 Python 环境，不要复用 Worker venv：

```bash
cd packages/comfyui-video-flow-client
python -m pip install -r requirements.txt pytest
python -m pytest -q
```

图片检查使用 Pillow 读取实际内容；视频和音频检查需要系统命令 `ffprobe`。缺少该命令时节点返回明确的 `FFPROBE_NOT_AVAILABLE`，不会按扩展名或声明 MIME 猜测。macOS 开发机可通过 Homebrew 的 `ffmpeg` 包提供 `ffprobe`；正式安装环境是否具备该依赖仍以发布前检查为准。

涉及节点、模板或 API 合同的修改，除单测外还必须验证：

1. Workflow JSON 双向连线一致；
2. Preview 没有媒体上传、Provider 调用、Task/Attempt 创建或预算变化；
3. Production 槽为空时未经有效预检无法提交；槽内已有任务时优先恢复，不重新准入或提交；
4. 原 `taskId` 能独立查询、等待和重新下载；
5. 在目标 ComfyUI 版本完成安装、重启、导入、Queue Prompt 和结果展示验收。

完整开发流程见 [DEVELOPMENT_WORKFLOW](../../docs/DEVELOPMENT_WORKFLOW.md)。需要真实 Provider 验收时，必须单独说明将创建的任务、预计费用和批准范围；普通本地开发只使用 Fake Provider。

## 重新开放安装的条件

安装指南只在 [ROADMAP](../../docs/ROADMAP.md) 规定的客户端包装出口门禁关闭，且 [PROJECT_STATUS](../../docs/PROJECT_STATUS.md) 记录对应验收证据后恢复。至少需要旧节点和错误模板退出交付包、三包回归与隔离合同通过、目标 ComfyUI 完成真实操作验收、三端版本配套发布，并由管理员明确账号、工作流和预算授权。

**当前允许范围以 PROJECT_STATUS 为准。** 2026-09-16 起有一次**受控测试期交付**（对应上面"目标 ComfyUI 完成真实操作验收"这条），门禁本身仍未关闭；交付时必须用 `git archive` 导出干净副本，不要把工作目录（可能含未提交的界面改动）直接交给同事——原因见 PROJECT_STATUS 同日条目。交付版本号在 `__init__.py` 的 `CLIENT_VERSION`，安装器会打印出来。

此前的 v1 安装和节点说明已归档为 [历史快照](../../docs/archive/2026-09-15-comfyui-client-readme-v1-superseded.md)，不得照此操作。
