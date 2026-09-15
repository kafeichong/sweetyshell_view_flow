# 历史快照：Seedance Preview 目录扩展计划

> 归档日期：2026-09-15。原路径：docs/superpowers/plans/2026-09-14-seedance-workflow-expansion.md。
> 原计划以Preview扩展和旧状态门控为边界，已被[职责重整计划R0–R8](../ROADMAP.md)取代。原任务勾选仅为历史记录，不是完整工作流验收。当前事实见[PROJECT_STATUS](../PROJECT_STATUS.md)。

---

# Seedance 工作流目录扩展实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在已跑通的参考图生视频工作流基础上，按文生视频、首帧图生视频、首尾帧图生视频、多参考素材视频的顺序，建立可导入、可 Preview、可由服务端统一校验的独立 ComfyUI 工作流。

**Architecture:** 所有工作流继续使用同一套“本地素材检查 → Backend 预检 → 明确确认 → Production”边界。客户端只构造 Provider 无关的 `workflowKey + prompt + generation + media descriptors`；Backend Registry 决定媒体角色、数量、参数范围与 Production 状态；Worker 只消费服务端冻结的 execution plan。新工作流默认只做 Preview/离线合同验证，真实 Provider 生成不在本计划内。

**Tech Stack:** ComfyUI Python custom nodes、NestJS/TypeScript Backend、Python FastAPI Worker、pytest、Jest、ComfyUI workflow JSON。

**Spec:** `docs/requirements/2026-09-14/workflow-preview-production-spec.md`

## Global Constraints

- Preview 不上传素材、不创建可领取任务、不创建付费 Attempt、不预占额度、不调用 Provider。
- 正式提交必须绑定当前内容的有效预检记录、明确确认、素材实际内容复验和服务端生产准入。
- 本地客户端不得持有 Ark/OSS 密钥，不得把本机绝对路径发送给服务器。
- 未完成当前账号级真实验收的工作流保持 `preview_only` 或 `disabled`，不得因为节点和单测通过而开放 Production。
- 每种媒体角色必须使用 `reference_image`、`first_frame`、`last_frame`、`reference_video`、`reference_audio` 中的明确角色，不能用模糊的 image/video 字段替代。
- 每项任务先写失败测试、观察 RED，再写最小实现并回归；不执行付费测试。

## Task 1: 共用工作流请求与参数目录

**Files:**
- Modify: `packages/backend/src/tasks/workflow-registry.ts`
- Modify: `packages/backend/src/tasks/workflow-registry.spec.ts`
- Modify: `packages/comfyui-video-flow-client/preflight_nodes.py`
- Modify: `packages/comfyui-video-flow-client/tests/test_preflight_nodes.py`

**Interfaces:**
- Consumes: 当前 `normalizeWorkflowTaskRequest(body, spec)` 与 `ProductRequest` 请求构造器。
- Produces: 四种工作流共用的 generation 选项和明确 media role，供后续模板复用。

- [x] 先增加失败测试：验证文生请求允许空媒体，首帧/首尾帧/多参考的 role、数量、顺序和参数组合被 Registry 正确判断。
- [x] 运行 `cd packages/backend && npx jest src/tasks/workflow-registry.spec.ts --runInBand`，确认新增场景因缺少定义而失败。
- [x] 实现共用的参数常量与 Registry 校验，不改变现有参考图工作流的已验证合同。
- [x] 实现客户端请求节点的 generation 下拉项与媒体描述构造，Preview 只发送描述和哈希。
- [x] 运行 Backend Registry 测试和 `cd packages/comfyui-video-flow-client && .venv/bin/python -m pytest -q tests/test_preflight_nodes.py`，确认通过。

## Task 2: 文生视频工作流

**Files:**
- Create: `packages/comfyui-video-flow-client/workflows/seedance-text-to-video-preflight-v1.comfy.json`
- Modify: `packages/comfyui-video-flow-client/preflight_nodes.py`
- Modify: `packages/comfyui-video-flow-client/tests/test_preflight_nodes.py`
- Modify: `packages/backend/src/v1/tasks/workflow-preflight.ts`
- Modify: `packages/backend/src/v1/tasks/workflow-preflight.spec.ts`

**Interfaces:**
- Consumes: Task 1 的 `seedance.text-to-video.v1` 请求合同。
- Produces: Prompt-only ComfyUI 模板；Preview 返回完整参数报告并明确未生成视频。

- [ ] 添加模板连线与默认 Preview 的失败测试。
- [ ] 运行客户端模板测试，确认节点/模板尚未存在时 RED。
- [x] 增加文生请求节点和模板；保持 `media=[]`，不引入虚假素材。
- [x] Backend 只允许 Registry 声明的 generation 范围，并保持工作流 `preview_only`。
- [x] 回归客户端、Backend 单测和 JSON 连线校验。

## Task 3: 首帧图生视频工作流

**Files:**
- Create: `packages/comfyui-video-flow-client/workflows/seedance-first-frame-preflight-v1.comfy.json`
- Modify: `packages/comfyui-video-flow-client/preflight_nodes.py`
- Modify: `packages/comfyui-video-flow-client/tests/test_preflight_nodes.py`
- Modify: `packages/backend/src/tasks/workflow-preflight.ts`
- Modify: `packages/backend/src/v1/tasks/workflow-preflight.spec.ts`

**Interfaces:**
- Consumes: 本地单图检查结果和 `first_frame` media role。
- Produces: 一张首帧图 + Prompt 的 Preview 模板，当前状态保持 `disabled` 或 `preview_only`，不开放付费 Production。

- [ ] 先测试缺失首帧、错误 role、图片类型和参数越界的拒绝结果。
- [x] 实现首帧本地输入节点，保留文件哈希、MIME、尺寸等描述。
- [x] 实现模板和服务端 Preview 路由支持，禁止在 Preview 阶段上传图片本体。
- [x] 运行对应 pytest/Jest，并确认 Production 仍被状态门控拒绝。

## Task 4: 首尾帧图生视频工作流

**Files:**
- Create: `packages/comfyui-video-flow-client/workflows/seedance-first-last-frame-preflight-v1.comfy.json`
- Modify: `packages/comfyui-video-flow-client/preflight_nodes.py`
- Modify: `packages/comfyui-video-flow-client/tests/test_preflight_nodes.py`
- Modify: `packages/backend/src/tasks/workflow-preflight.ts`
- Modify: `packages/backend/src/v1/tasks/workflow-preflight.spec.ts`

**Interfaces:**
- Consumes: 两个本地图片描述，顺序固定为 `first_frame`、`last_frame`。
- Produces: 首尾帧 Preview 模板；服务端拒绝顺序互换、数量不符、尺寸/比例不合规则的请求。

- [ ] 先测试顺序互换和缺少任一帧的 RED 场景。
- [x] 实现两个独立图片输入和角色化请求构造。
- [x] 增加模板连线、Preview 报告和状态门控。
- [x] 回归模板连线、请求快照和无 Provider 调用证明。

## Task 5: 多参考素材工作流

**Files:**
- Create: `packages/comfyui-video-flow-client/workflows/seedance-multi-reference-preflight-v1.comfy.json`
- Modify: `packages/comfyui-video-flow-client/preflight_nodes.py`
- Modify: `packages/comfyui-video-flow-client/tests/test_preflight_nodes.py`
- Modify: `packages/backend/src/tasks/workflow-preflight.ts`
- Modify: `packages/backend/src/v1/tasks/workflow-preflight.spec.ts`
- Modify: `packages/worker/providers/seedance_compiler.py`
- Modify: `packages/worker/tests/test_workflow_contracts.py`

**Interfaces:**
- Consumes: 0–30 张 `reference_image`、0–10 段 `reference_video`、0–10 段 `reference_audio`，至少一种媒体，顺序和数量由 Registry 控制。
- Produces: 多参考 Preview 模板和 Provider 编译合同；在没有账号级生产验收前保持非 Production。

- [ ] 先测试空媒体、数量上限、角色顺序和混合媒体类型的 RED 场景。
- [x] 实现有限数量的可选媒体输入，不接受任意 URL 或本机路径透传。
- [x] 实现服务端 Preview 快照与 Worker 编译校验，编译失败不得调用 Provider。
- [x] 回归所有多参考合同测试，明确官方字段证据与本账号能力仍需单独验收。

## Task 6: 文档、模板清单与回归

**Files:**
- Modify: `packages/comfyui-video-flow-client/README.md`
- Modify: `docs/runbooks/product-preflight.md`
- Modify: `docs/PROJECT_STATUS.md`
- Modify: `docs/README.md`
- Modify: `packages/comfyui-video-flow-client/tests/test_delivery_scripts.py`

- [x] 为每个模板写明 Preview/Production 状态、媒体角色、参数范围和费用风险。
- [x] 验证 `install.sh` 会安装新模板与客户端代码，不携带凭证。
- [x] 运行完整三包回归：Backend `npm run build && npx jest --runInBand`、Worker `venv/bin/python -m pytest -q`、客户端 `.venv/bin/python -m pytest -q`。
- [x] 只更新文档中的本轮实现证据，不把离线/Fake Provider 测试写成真实 Provider 验收。

## 收尾边界

- [x] 不创建真实 Provider 任务，不执行 30 秒或其它新规格的付费生成。
- [x] 不因新增模板通过测试就修改工作流为 `production_verified`。
- [x] 线上部署、创意人员实际导入和正式出片另行记录，不与本地回归混写。
