# 消费和任务历史 API 测试结果

测试时间：2026-09-15

## 测试环境

- 数据库：PostgreSQL (localhost:5433)
- 后端：NestJS (localhost:3000)
- 测试用户：test-consumer
- Token: vf_88e571c7acae8200ae958d234758117b85b9e8632b5579e5b97391ffe49e0676

## API 测试结果

### 1. 消费概览 API ✅

**端点**: `GET /api/v1/consumption/overview`

**响应示例**:
```json
{
  "daily": {
    "settled": "0.000000",
    "reserved": "0.000000",
    "taskCount": 0,
    "limit": "100.000000",
    "remaining": "100.000000"
  },
  "monthly": {
    "settled": "0.000000",
    "reserved": "0.000000",
    "taskCount": 0,
    "limit": "1000.000000",
    "remaining": "1000.000000"
  }
}
```

**状态**: 通过 ✅

---

### 2. 消费趋势 API ✅

**端点**: `GET /api/v1/consumption/trends?days=7`

**响应示例**:
```json
{
  "trends": []
}
```

**说明**: test-consumer 账户没有消费记录，返回空数组是正确的。

**状态**: 通过 ✅

---

### 3. 任务列表 API ✅

**端点**: `GET /api/v1/tasks?limit=3`

**响应示例**:
```json
{
  "tasks": [
    {
      "id": "9cc8a7aa-197b-4b05-82f0-7cdac7e51cb2",
      "workflowKey": null,
      "workflowName": null,
      "status": "failed",
      "deliveryStatus": null,
      "parameters": {},
      "promptPreview": "parallel check task",
      "cost": {
        "reserved": null,
        "settled": null,
        "status": null
      },
      "createdAt": "2026-09-09T11:18:27.318Z",
      "completedAt": "2026-09-09T11:18:27.411Z",
      "hasOutput": false,
      "outputReady": false
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 3,
    "total": 3,
    "totalPages": 1
  }
}
```

**功能**:
- ✅ 分页查询
- ✅ 显示任务基本信息
- ✅ 显示成本信息
- ✅ 显示输出状态

**状态**: 通过 ✅

---

### 4. 任务详情 API ✅

**端点**: `GET /api/v1/tasks/:id/detail`

**响应示例**:
```json
{
  "task": {
    "id": "9cc8a7aa-197b-4b05-82f0-7cdac7e51cb2",
    "actorId": "test-consumer",
    "status": "failed",
    "deliveryStatus": null,
    "createdAt": "2026-09-09T11:18:27.318Z",
    "updatedAt": "2026-09-10T07:08:39.341Z",
    "completedAt": "2026-09-09T11:18:27.411Z",
    "errorMsg": "unknown: task failed"
  },
  "submissionDetails": {
    "workflow": {
      "key": null,
      "name": null,
      "version": null,
      "contractDigest": null
    },
    "generation": {},
    "prompt": {
      "text": "parallel check task",
      "length": 19
    },
    "media": [],
    "pricing": {
      "version": null,
      "reserveCny": null
    },
    "execution": {
      "slotId": null,
      "slotSequence": null,
      "preflightId": null
    }
  },
  "attempts": [],
  "assets": [],
  "budget": null,
  "correlation": {
    "taskId": "9cc8a7aa-197b-4b05-82f0-7cdac7e51cb2",
    "clientRequestId": null,
    "attemptIds": [],
    "providerTaskIds": [],
    "objectKeys": []
  }
}
```

**功能**:
- ✅ 显示任务完整信息
- ✅ 显示提交详情（工作流、参数、提示词等）
- ✅ 显示执行尝试记录
- ✅ 显示关联资源
- ✅ 显示预算信息
- ✅ 显示关联ID追踪

**状态**: 通过 ✅

---

## 数据库修改记录

为了支持新API，对数据库进行了以下修改：

### docker-compose.yml
- 添加 PostgreSQL 端口映射：`127.0.0.1:5433:5432`

### tasks 表
```sql
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS execution_slot_id TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS slot_sequence INTEGER;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS preflight_id TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS contract_digest TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS intent_digest TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS quote_digest TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS client_delivery_status TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS client_delivered_at TIMESTAMP(3);
```

### task_budget_reservations 表
```sql
ALTER TABLE task_budget_reservations ADD COLUMN IF NOT EXISTS review_decision TEXT;
ALTER TABLE task_budget_reservations ADD COLUMN IF NOT EXISTS review_amount_cny NUMERIC(18,6);
ALTER TABLE task_budget_reservations ADD COLUMN IF NOT EXISTS review_evidence_ref TEXT;
ALTER TABLE task_budget_reservations ADD COLUMN IF NOT EXISTS review_operator TEXT;
ALTER TABLE task_budget_reservations ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP(3);
```

### assets 表
```sql
ALTER TABLE assets ADD COLUMN IF NOT EXISTS media_metadata JSONB;
```

---

## 测试凭证

为测试创建了专用的 API 凭证：

```sql
INSERT INTO actor_credentials (actor_id, name, token_hash, status, daily_limit_cny, monthly_limit_cny) 
VALUES ('test-consumer', 'Test Consumer', 'ca5b5f19c7537179129ad61f6679f3f770b64bc709d323666c96d29c9fe08f66', 'active', 100, 1000);
```

Token 保存在：`/Users/steven/works/20260909video_flow/.test-token`

---

## 下一步

### Phase 2: ComfyUI 前端实现 (3-4天)
1. 创建消费概览面板组件
2. 实现任务历史列表组件
3. 实现任务详情弹窗
4. 集成到 ComfyUI 扩展

### Phase 3: 样式和交互优化 (1-2天)
1. 响应式布局优化
2. 加载状态和错误处理
3. 数据刷新机制

### Phase 4: 测试和验证 (1-2天)
1. 端到端测试
2. 边界情况测试
3. 性能测试

### Phase 5: 部署和文档 (1天)
1. 生产环境部署
2. API 文档更新
3. 用户手册编写
