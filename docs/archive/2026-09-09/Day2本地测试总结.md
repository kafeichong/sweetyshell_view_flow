# 🎯 Day 2 本地测试总结

> 时间：2026-09-09  
> 状态：✅ 基础设施已完成，需要调整数据模型映射

---

## ✅ 已完成

### 1. Docker 环境搭建成功
- ✅ Backend（NestJS + Prisma）
- ✅ Worker（Python + FastAPI）
- ✅ PostgreSQL 数据库
- ✅ 所有服务正常运行

### 2. 数据库
- ✅ 数据库迁移成功
- ✅ 创建了 Task 和 Config 两个表

### 3. API 测试
- ✅ Backend API 正常工作
  - `POST /api/tasks` - 创建任务 ✅
  - `GET /api/tasks` - 查询任务 ✅
  - `GET /api/tasks/pending` - 查询待处理任务 ✅
  
- ✅ Worker API 正常工作
  - `GET /health` - 健康检查 ✅
  
### 4. Worker 轮询机制
- ✅ Worker 后台轮询已启动
- ✅ 每 5 秒轮询一次 Backend API
- ✅ 能够获取到 pending 任务列表

---

## ⚠️ 发现的问题

### 数据模型不匹配

**Worker 期望的字段**（旧项目）：
```python
class Job:
    id: str
    workflow_hash: str      # ❌ Task 表没有
    capability: str         # ❌ Task 表没有
    provider_profile: str   # ❌ Task 表没有
    params: dict           # ❌ Task 表没有
    status: str
    ...
```

**MVP Task 表字段**（简化版）：
```prisma
model Task {
  id          String
  createdBy   String
  prompt      String
  imageUrl    String?
  videoUrl    String?
  status      String
  errorMsg    String?
  cost        Float?
  createdAt   DateTime
  completedAt DateTime?
}
```

**问题**：Worker 无法解析 Task 数据，抛出 Pydantic 验证错误。

---

## 🔧 解决方案

### 方案 A：修改 Worker 模型（推荐）⭐

**优点**：
- 保持 MVP 数据模型简单
- 修改量小（只改 Worker 的 models.py）
- 快速（10 分钟）

**步骤**：
1. 修改 `packages/worker/models.py` 中的 `Job` 模型
2. 将旧字段改为可选或删除
3. 添加新字段映射（`prompt`, `imageUrl`, `createdBy`）
4. 重新构建 Worker

**示例**：
```python
class Job(BaseModel):
    id: str
    # MVP 字段
    createdBy: str
    prompt: str
    imageUrl: Optional[str] = None
    videoUrl: Optional[str] = None
    
    # 旧字段（兼容，但设为可选）
    workflow_hash: Optional[str] = None
    capability: Optional[str] = "IMAGE_TO_VIDEO"  # 默认值
    provider_profile: Optional[str] = "seedance"
    params: Optional[dict] = None
    
    status: str
    errorMsg: Optional[str] = None
    cost: Optional[float] = None
    createdAt: datetime
    completedAt: Optional[datetime] = None
```

---

### 方案 B：扩展 Task 表

**优点**：
- Worker 代码不用改
- 完整保留旧功能

**缺点**：
- ❌ 背离 MVP 原则（增加复杂度）
- ❌ 需要重新设计数据库迁移
- ❌ 时间长（1-2 小时）

---

## 📋 下一步计划

### 立即执行（方案 A）

```bash
# 1. 修改 Worker 的 Job 模型
vim packages/worker/models.py

# 2. 修改 executor.py 中的任务执行逻辑
#    适配新的字段名（prompt, imageUrl, createdBy）

# 3. 重新构建并测试
docker compose up -d --build video-worker

# 4. 创建新任务并验证
curl -X POST http://localhost:3100/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"createdBy":"测试","prompt":"测试视频生成"}'

# 5. 查看 Worker 日志
docker compose logs video-worker --follow
```

预计时间：**20-30 分钟**

---

## 📊 当前服务状态

```bash
$ docker compose ps

NAME                  STATUS
video-flow-backend    Up (healthy)
video-flow-postgres   Up (healthy)
video-flow-worker     Up (轮询中，但有验证错误)
```

**端口映射**：
- Backend: http://localhost:3100/api
- Worker: http://localhost:8101
- PostgreSQL: localhost:5433

---

## 🧪 测试记录

### 测试 1：创建任务 ✅
```bash
$ curl -X POST http://localhost:3100/api/tasks \
  -d '{"createdBy":"张三","prompt":"产品从水面浮现"}'

{
  "id": "ce522a72-0eea-41d5-8427-38450d2637e6",
  "status": "pending",
  ...
}
```

### 测试 2：查询任务 ✅
```bash
$ curl http://localhost:3100/api/tasks

[
  {
    "id": "ce522a72-0eea-41d5-8427-38450d2637e6",
    "status": "pending",
    ...
  }
]
```

### 测试 3：Worker 轮询 ⚠️
```
Worker 正在轮询，但因模型不匹配导致解析失败：

Failed to fetch jobs: 4 validation errors for Job
- workflow_hash: Field required
- capability: Field required
- provider_profile: Field required
- params: Field required
```

---

## 💡 经验总结

### 成功的地方
1. ✅ Docker 环境搭建顺利
2. ✅ 数据库迁移成功
3. ✅ Backend API 设计合理
4. ✅ Worker 轮询机制正常工作

### 遇到的问题
1. ⚠️ pnpm 的构建脚本批准机制太严格 → 改用 npm
2. ⚠️ Alpine 镜像缺少 OpenSSL → 改用 Debian slim
3. ⚠️ Docker 缓存冲突 → 添加 .dockerignore
4. ⚠️ 数据模型不匹配 → 需要适配

### 学到的教训
1. MVP 应该更彻底 - 不仅简化数据模型，也应该简化 Worker 代码
2. 复用旧代码时要充分评估兼容性
3. 应该先统一数据模型，再进行集成测试

---

## 🎯 明天的工作

### Day 2 延续：完成本地测试
1. 修改 Worker Job 模型（20 分钟）
2. 测试完整流程（10 分钟）
3. 验证视频生成（需要真实 API Key）

### Day 3：部署到服务器
1. 上传代码到服务器
2. 配置生产环境变量
3. 运行部署脚本
4. 让创意人员试用

---

**Day 2 完成度：90%**  
**剩余工作：修改 Worker 模型映射（预计 20-30 分钟）**
