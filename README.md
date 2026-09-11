# Video Flow - AI 视频生成系统

基于火山引擎 Seedance 的统一视频生成系统：创意同事在本机 ComfyUI 中调参与上传素材，通过公司服务器统一调用火山引擎完成出片，Ark / OSS 密钥不下发到个人电脑。

## 项目结构

```
video-flow/
├── packages/
│   ├── backend/                        # NestJS API 服务（v1 对外接口 + Worker 私有接口）
│   ├── worker/                         # Python Worker（唯一持有 Ark/OSS 密钥的组件）
│   └── comfyui-video-flow-client/      # ComfyUI 自定义节点（同事本机安装）
├── docs/                               # 文档（入口：docs/README.md）
├── scripts/                            # 部署与联调脚本
└── docker-compose.yml                  # Docker 编排
```

## 技术栈

- **Backend**: NestJS 12 + Prisma 5.22 + PostgreSQL 16
- **Worker**: Python 3.13 + FastAPI
- **Storage**: 阿里云 OSS（数据库只存 `objectKey`，签名 URL 按需生成）
- **API**: 火山引擎 Ark (Seedance)

## 文档入口

| 想了解 | 看这里 |
| --- | --- |
| 文档总索引 | [`docs/README.md`](docs/README.md) |
| 系统现在能做什么、有哪些已知缺口 | [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md) |
| 接下来做什么、怎么验收 | [`docs/ROADMAP.md`](docs/ROADMAP.md) |
| 系统边界与技术约束 | [`docs/architecture/seedance-integration-baseline.md`](docs/architecture/seedance-integration-baseline.md) |
| 部署与回滚 | [`docs/runbooks/deploy-and-rollback.md`](docs/runbooks/deploy-and-rollback.md) |
| 创意同事怎么用 | [`docs/runbooks/creative-user-guide.md`](docs/runbooks/creative-user-guide.md) |

## 快速开始

### 1. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 填入真实的 API Key、数据库密码与各类 token
```

### 2. 启动服务

```bash
# 启动所有服务
docker compose up -d

# 查看日志
docker compose logs -f

# 运行数据库迁移
docker compose exec video-backend npx prisma migrate deploy
```

### 3. 调用 v1 API（唯一受支持的外部入口）

`/api/v1` 只接受 Video Flow actor token。token 不应写入仓库，也不应把 Ark / OSS 密钥下发到任何客户端。

管理员先签发凭证：

```bash
curl -X POST http://localhost:3100/api/v1/admin/credentials \
  -H "X-Admin-Token: $VIDEO_FLOW_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"actorId":"creator-demo","name":"Demo"}'
# → { "actorId": "creator-demo", "token": "vf_..." }
```

再以该 token 创建任务（`mode` 缺省为 `preview`，不产生付费调用）：

```bash
curl -X POST http://localhost:3100/api/v1/tasks \
  -H "Authorization: Bearer $VIDEO_FLOW_TOKEN" \
  -H "Idempotency-Key: preview-demo-001" \
  -H "X-Video-Flow-Protocol: 1" \
  -H "Content-Type: application/json" \
  -d '{"capability":"IMAGE_TO_VIDEO","profile":"seedance","mode":"preview","params":{"prompt":"产品从水面浮现"}}'
```

> **真实出片**需显式传 `"mode":"production"`，且该 actor 必须已在服务端 `VIDEO_FLOW_PRODUCTION_ACTORS` 白名单中，否则返回 403。
> ComfyUI 客户端见 [`packages/comfyui-video-flow-client/README.md`](packages/comfyui-video-flow-client/README.md)。

### 旧的 `/api/tasks` 接口

09-09 遗留的 `/api/tasks` 系列接口仅为兼容 Worker 与历史管理操作保留。公共 create/list/pending/findOne 已要求管理员 token，claim/recover/update 要求 Worker token；创意客户端仍只能使用 `/api/v1`。

## 服务端口

| 服务 | 端口 | 说明 |
| --- | --- | --- |
| Backend API | `127.0.0.1:3100`（容器内 3000） | 仅供本机 Nginx 代理 |
| Worker | 容器内 8001 | 仅 Docker 网络 |
| PostgreSQL | 容器内 5432 | 仅 Docker 网络 |

> 公网只开放 HTTPS 443（`ai.sweetyshell.com` → `127.0.0.1:3100`）。Worker 与 PostgreSQL 不发布宿主端口。生产部署请参考 [`docs/runbooks/deploy-and-rollback.md`](docs/runbooks/deploy-and-rollback.md)。

## 测试

提交前三个包都要绿：

```bash
cd packages/backend && npm run build && npx jest
cd packages/worker && venv/bin/python -m pytest -q

# 客户端：必须在该包 tests/ 目录下运行，且该 venv 需先装 requirements.txt
cd packages/comfyui-video-flow-client
python -m pip install -r requirements.txt pytest
python -m pytest -q
```

客户端必须使用安装了自身 `requirements.txt` 的环境，不要复用未安装 `numpy` / `Pillow` / `socksio` 的 Worker venv。

## License

Private
