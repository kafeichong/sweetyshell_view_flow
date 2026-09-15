# Video Flow - 受控 AI 视频生成系统

Video Flow 让创意同事继续使用本机 ComfyUI，通过公司 Backend 与 Worker 统一调用 Seedance，并对身份、素材、费用、执行、恢复和交付进行服务端控制。Ark / OSS 密钥不下发到个人电脑。

当前本地工作区正在进行 Preview / Production v2 职责重构。新的 Preview 已进入独立 `PreflightRecord` 开发阶段，v2 Production 尚未完成；不要根据旧示例或历史样片判断当前版本已经可以交付创意人员使用。最新事实只看 [PROJECT_STATUS](docs/PROJECT_STATUS.md)。

## 项目结构

```text
video-flow/
├── packages/
│   ├── backend/                        # NestJS API、数据、鉴权、准入和任务
│   ├── worker/                         # Python Worker、Provider 执行和交付
│   └── comfyui-video-flow-client/      # 创意同事本机的 ComfyUI 自定义节点
├── contracts/                          # 跨包工作流合同
├── docs/                               # 产品、需求、架构、计划、现状和手册
├── scripts/                            # 合同验证、部署和运维脚本
└── docker-compose.yml
```

## 文档入口

| 想了解 | 看这里 |
| --- | --- |
| 文档总索引 | [`docs/README.md`](docs/README.md) |
| 产品用户、范围与非目标 | [`docs/PRODUCT.md`](docs/PRODUCT.md) |
| 从讨论到交付的开发流程 | [`docs/DEVELOPMENT_WORKFLOW.md`](docs/DEVELOPMENT_WORKFLOW.md) |
| 系统现在能做什么、有哪些缺口 | [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md) |
| 接下来做什么、怎么验收 | [`docs/ROADMAP.md`](docs/ROADMAP.md) |
| Preview / Production 强制规范 | [v2 规范](docs/requirements/2026-09-15/workflow-preview-production-spec-v2.md) |
| 系统边界与技术约束 | [架构基线](docs/architecture/seedance-integration-baseline.md) |
| 部署与回滚 | [部署手册](docs/runbooks/deploy-and-rollback.md) |
| 创意同事当前可以做什么 | [创意同事使用说明](docs/runbooks/creative-user-guide.md) |

## 当前开发边界

- `POST /api/v1/tasks/preflight` 是 v2 Preview 入口；Preview 不上传素材、不创建正式任务、不预占预算、不调用生成 Provider。
- 旧 `POST /api/v1/tasks` 的 `mode=preview` 创建语义已经退休。
- v2 Production 在冻结快照提交路径完成前保持关闭。
- 已有任务查询和结果下载与新任务准入分开，不能因恢复失败自动重新生成。
- 部署、生产开放和真实 Provider 调用必须分别获得授权。

接口和阶段细节见 [Preview v2 接口手册](docs/runbooks/product-preflight.md)。该手册标明本地实现与部署边界，不代表生产环境已经升级。

## 本地开发

三个包使用各自的依赖环境。

### Backend

```bash
cd packages/backend
npm install
npm run build
npx jest --runInBand
```

### Worker

```bash
cd packages/worker
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python -m pytest -q
```

### ComfyUI 客户端

```bash
cd packages/comfyui-video-flow-client
python -m pip install -r requirements.txt pytest
python -m pytest -q
```

关键链路变更还必须运行隔离跨包合同。完整命令和执行条件见 [ROADMAP](docs/ROADMAP.md) 与 [AGENTS.md](AGENTS.md)。

## 本地启动与部署

本地配置从 `.env.example` 开始，真实密钥只通过环境变量或受控 Secret 注入：

```bash
cp .env.example .env
docker compose up -d
docker compose exec video-backend npx prisma migrate deploy
```

以上命令只用于本地开发准备，不等于允许部署当前中间态。生产部署、备份、迁移和回滚必须遵守 [部署手册](docs/runbooks/deploy-and-rollback.md)，并在操作前重新核对当前分支、镜像、数据库和服务器状态。

## 安全边界

- 创意客户端只使用个人可撤销凭证，不持有 Ark、OSS、数据库或 Worker 服务密钥。
- 不得新增未鉴权或仅由客户端布尔值控制的付费执行路径。
- Preview 不得上传文件、缩略图或 Base64。
- 测试默认使用 Fake Provider；真实 Provider 任务必须单独确认账号、素材、规格、预计费用和授权范围。
- 不把本地测试、提交、推送、部署和真实用户验收合并成一个“完成”状态。

## License

Private
