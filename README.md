# Video Flow - AI 视频生成系统

基于火山引擎 Seedance API 的视频生成系统。

## 项目结构

```
video-flow/
├── packages/
│   ├── backend/          # NestJS API 服务
│   └── worker/           # Python Worker（调用火山引擎API）
├── docs/                 # 设计文档
├── scripts/              # 部署脚本
└── docker-compose.yml    # Docker 编排
```

## 技术栈

- **Backend**: NestJS + Prisma + PostgreSQL
- **Worker**: Python 3.13 + FastAPI
- **Database**: PostgreSQL 16
- **Storage**: 阿里云 OSS
- **API**: 火山引擎 Ark (Seedance)

## 快速开始

### 1. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 填入真实的 API Key 和密码
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

### 3. 测试 API

```bash
# 创建任务
curl -X POST http://localhost:3100/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "createdBy": "张三",
    "prompt": "产品从水面浮现，水花飞溅",
    "imageUrl": "https://example.com/product.jpg"
  }'

# 查询任务
curl http://localhost:3100/api/tasks
```

## 服务端口

| 服务 | 端口 | 说明 |
|------|------|------|
| Backend API | 3100 | HTTP API |
| Worker | 8101 | 内部服务 |
| PostgreSQL | 5433 | 数据库（避免端口冲突） |

## 部署到服务器

详见 `docs/2026-09-09/服务器部署可行性分析报告.md`

## 开发文档

- [迁移 vs 重写决策分析](docs/2026-09-09/迁移vs重写决策分析.md)
- [服务器部署可行性分析](docs/2026-09-09/服务器部署可行性分析报告.md)
- [MVP 快速跑起来方案](docs/2026-09-09/MVP快速跑起来方案.md)

## License

Private
