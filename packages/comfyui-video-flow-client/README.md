# ComfyUI Video Flow Client

这是 Video Flow 的 ComfyUI 自定义节点包。客户端只访问公司 Backend，不持有 Ark、OSS、数据库或 Worker 服务密钥。

## 交付判定

本 README 不记录阶段完成度。是否允许安装、创建新任务或使用 Production，只看 [PROJECT_STATUS](../../docs/PROJECT_STATUS.md) 的当前结论；后续任务和开放门禁只看 [ROADMAP](../../docs/ROADMAP.md)。在权威现状明确记录客户端交付包已经验收前，**本目录不能作为创意同事的新任务安装包或操作手册**。

当前代码同时包含两代入口：

- `preflight_nodes.py`：v2 预检、确认、等待和下载节点的开发中实现；
- `nodes.py`：仍注册 v1 Preview、Production、OneClick 等旧节点；其中旧 Preview 会上传素材，不能满足 v2 的 Preview 零上传要求；
- `workflows/` 与 `examples/`：包含不同阶段的模板，尚未完成全量清理和真实 ComfyUI 验收。

因此，“节点已注册”“模板可导入”或“客户端测试通过”均不等于已经开放 Preview 或 Production。权威现状未关闭客户端交付门禁前，不要在创意主实例安装本目录，也不要用旧节点创建新任务。

创意同事在重构期间只查询、等待或重新下载已有任务，见 [v2 重构期间使用说明](../../docs/runbooks/creative-user-guide.md)。

## 开发边界

所有工作流改造必须遵守 [Preview 与 Production 统一需求规范 v2](../../docs/requirements/2026-09-15/workflow-preview-production-spec-v2.md)：

- 同一画布默认 Preview，由用户明确切换并确认后才可请求 Production；
- Preview 只发送参数、素材元信息与内容哈希，不上传素材，不调用生成 Provider，不创建可执行任务、付费 Attempt 或预算预占；
- Production 必须消费与当前内容匹配的有效预检记录，并由服务端完成身份、准入、额度、冻结请求和实际素材复验；
- 已有任务的查询、等待和重新下载不得依赖新预检、新额度或重新提交 Provider；
- 客户端开关、节点名称和本地回执都不能替代服务端校验。

阶段接口状态不在本 README 重复维护，开发和联调前必须先核对 [PROJECT_STATUS](../../docs/PROJECT_STATUS.md) 与对应 runbook，不得把某一子包单独部署给创意人员使用。

## 目录说明

| 路径 | 作用 | 当前注意事项 |
| --- | --- | --- |
| `preflight_nodes.py` | v2 请求、预检、确认、等待、下载节点 | 未完成项与阶段归属只看 ROADMAP |
| `media_inspection.py` | 本地素材检查与哈希 | 需与服务端实际媒体复验共同形成边界 |
| `client.py` | Backend API、回执、查询和下载客户端 | 旧 Task 创建方法仍为迁移期代码，不代表当前可用入口 |
| `nodes.py` | v1 节点注册 | 待 R5/R7 替换或移除，不得用于新任务 |
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
3. Production 未经有效预检和明确确认无法提交；
4. 原 `taskId` 能独立查询、等待和重新下载；
5. 在目标 ComfyUI 版本完成安装、重启、导入、Queue Prompt 和结果展示验收。

完整开发流程见 [DEVELOPMENT_WORKFLOW](../../docs/DEVELOPMENT_WORKFLOW.md)。需要真实 Provider 验收时，必须单独说明将创建的任务、预计费用和批准范围；普通本地开发只使用 Fake Provider。

## 重新开放安装的条件

安装指南只在 [ROADMAP](../../docs/ROADMAP.md) 规定的客户端包装出口门禁关闭，且 [PROJECT_STATUS](../../docs/PROJECT_STATUS.md) 记录对应验收证据后恢复。至少需要旧节点和错误模板退出交付包、三包回归与隔离合同通过、目标 ComfyUI 完成真实操作验收、三端版本配套发布，并由管理员明确账号、工作流和预算授权。

此前的 v1 安装和节点说明已归档为 [历史快照](../../docs/archive/2026-09-15-comfyui-client-readme-v1-superseded.md)，不得照此操作。
