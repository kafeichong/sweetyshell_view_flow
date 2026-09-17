# 费用管理与Token管理增强方案

> 创建日期：2026-09-17
> 状态：方案设计
> 依据：用户决策 - 用户级预算、Web显示预警、永久Token、手工对账、统一权限、需要历史回填

## 1. 目标与约束

**目标：**
- 为创意同事提供费用消费可视化界面
- 为管理员提供Token管理和费用对账工具
- 保持轻量级，不新增独立系统

**明确约束：**
- 只做用户级预算（不做部门级）
- 预警只在Web界面显示（不发送通知）
- Token永久有效（但支持管理员手动吊销）
- 对账手工录入（不自动拉取Provider账单）
- Token权限统一（不细分读写权限）
- 需要回填历史任务费用数据

## 2. 数据库Schema变更

### 2.1 新增表

```prisma
// 费用预警配置表
model CostAlert {
  id              String   @id @default(uuid()) @db.Uuid
  actorId         String   @map("actor_id")
  alertType       String   @map("alert_type") // daily_threshold, monthly_threshold
  thresholdCny    Decimal  @map("threshold_cny") @db.Decimal(18, 6)
  enabled         Boolean  @default(true)
  lastTriggeredAt DateTime? @map("last_triggered_at")
  createdAt       DateTime @default(now()) @map("created_at")
  updatedAt       DateTime @updatedAt @map("updated_at")

  @@unique([actorId, alertType])
  @@index([actorId, enabled])
  @@map("cost_alerts")
}

// 费用对账记录表
model CostReconciliation {
  id              String   @id @default(uuid()) @db.Uuid
  monthKey        String   @map("month_key") // YYYY-MM
  actorId         String?  @map("actor_id") // null表示全局对账
  systemTotalCny  Decimal  @map("system_total_cny") @db.Decimal(18, 6)
  providerBillCny Decimal  @map("provider_bill_cny") @db.Decimal(18, 6)
  varianceCny     Decimal  @map("variance_cny") @db.Decimal(18, 6)
  variancePercent Decimal  @map("variance_percent") @db.Decimal(5, 2)
  evidenceUrl     String?  @map("evidence_url")
  notes           String?
  reconciledBy    String   @map("reconciled_by")
  reconciledAt    DateTime @map("reconciled_at")
  createdAt       DateTime @default(now()) @map("created_at")

  @@unique([monthKey, actorId])
  @@index([monthKey])
  @@map("cost_reconciliations")
}

// Token使用日志表
model TokenUsageLog {
  id              String   @id @default(uuid()) @db.Uuid
  actorId         String   @map("actor_id")
  endpoint        String   // API路径
  method          String   // HTTP方法
  statusCode      Int      @map("status_code")
  ipAddress       String?  @map("ip_address")
  userAgent       String?  @map("user_agent")
  createdAt       DateTime @default(now()) @map("created_at")

  @@index([actorId, createdAt])
  @@index([createdAt]) // 用于定期清理
  @@map("token_usage_logs")
}
```

### 2.2 扩展现有表

```prisma
// ActorCredential 表增加字段
model ActorCredential {
  // ... 现有字段
  lastIpAddress   String?   @map("last_ip_address")
  usageCount      Int       @default(0) @map("usage_count")
  // 注：Token永久有效，不添加 expiresAt 字段
}
```

## 3. 后端接口设计

### 3.1 用户端接口（ApiCredentialGuard）

#### 费用查询接口

```typescript
// GET /api/v1/consumption/overview
// 返回日/月消费概览
{
  daily: {
    settled: "12.500000",      // 已结算
    reserved: "3.200000",      // 预占中
    total: "15.700000",        // 总计
    taskCount: 5,
    limit: "100.000000",       // 日额度
    remaining: "84.300000",    // 剩余
    alerts: [{                 // 触发的预警
      type: "daily_threshold",
      threshold: "80.000000",
      message: "日消费已达80%"
    }]
  },
  monthly: { /* 同结构 */ }
}

// GET /api/v1/consumption/trends?days=30
// 返回最近N天的消费趋势
{
  trends: [{
    date: "2026-09-17",
    settled: "12.500000",
    reserved: "3.200000",
    taskCount: 5
  }]
}

// GET /api/v1/consumption/tasks?cursor=xxx&limit=20
// 返回任务成本明细（分页）
{
  tasks: [{
    id: "uuid",
    createdAt: "2026-09-17T10:00:00Z",
    workflowName: "seedance.text-to-video.v1",
    status: "completed",
    deliveryStatus: "ready",
    cost: {
      status: "usage_calculated",
      estimated: "2.500000",
      usageCalculated: "2.450000",
      billed: null
    },
    reservation: {
      state: "settled",
      reserved: "2.500000",
      settled: "2.450000"
    }
  }],
  nextCursor: "xxx",
  hasMore: true
}

// POST /api/v1/consumption/alerts
// 配置预警阈值
{
  daily: { enabled: true, thresholdCny: "80.00" },
  monthly: { enabled: true, thresholdCny: "300.00" }
}
```

#### Token管理接口

```typescript
// GET /api/v1/tokens/current
// 获取当前Token信息
{
  actorId: "user-001",
  name: "creative-pilot",
  status: "active",
  createdAt: "2026-09-01T00:00:00Z",
  lastUsedAt: "2026-09-17T10:00:00Z",
  lastIpAddress: "192.168.1.100",
  usageCount: 1523
}

// GET /api/v1/tokens/usage-logs?limit=100&cursor=xxx
// 获取当前Token的使用日志（最近100条）
{
  logs: [{
    endpoint: "/api/v1/tasks",
    method: "POST",
    statusCode: 201,
    ipAddress: "192.168.1.100",
    createdAt: "2026-09-17T10:00:00Z"
  }],
  nextCursor: "xxx",
  hasMore: true
}
```

### 3.2 管理员接口（AdminTokenGuard）

```typescript
// GET /api/v1/admin/tokens
// 列出所有Token
{
  tokens: [{
    actorId: "user-001",
    name: "creative-pilot",
    status: "active",
    dailyLimitCny: "100.000000",
    monthlyLimitCny: "500.000000",
    createdAt: "2026-09-01T00:00:00Z",
    lastUsedAt: "2026-09-17T10:00:00Z",
    usageCount: 1523
  }]
}

// POST /api/v1/admin/reconciliation
// 提交对账记录
{
  monthKey: "2026-09",
  actorId: "user-001",  // null表示全局对账
  providerBillCny: "123.45",
  evidenceUrl: "https://...",
  notes: "火山账单截图"
}
// 返回：自动计算systemTotalCny和variance

// GET /api/v1/admin/consumption/summary?monthKey=2026-09
// 全局费用汇总
{
  monthKey: "2026-09",
  totalSettled: "456.780000",
  totalReserved: "23.450000",
  totalTasks: 234,
  byActor: [{
    actorId: "user-001",
    name: "creative-pilot",
    settled: "123.450000",
    taskCount: 89
  }],
  reconciliation: {
    systemTotal: "456.780000",
    providerBill: "460.000000",
    variance: "3.220000",
    variancePercent: "0.70",
    reconciledAt: "2026-10-05T10:00:00Z"
  }
}

// POST /api/v1/admin/consumption/backfill
// 回填历史数据（一次性操作）
{
  fromDate: "2026-09-01",
  toDate: "2026-09-17",
  dryRun: false
}
// 返回：回填的任务数、预算记录数
```

## 4. Web界面设计

### 4.1 用户端页面

**费用中心页面** (`/app/consumption`)

布局：
```
┌─────────────────────────────────────┐
│ 费用中心                             │
├─────────────────────────────────────┤
│ 今日消费: ¥15.70 / ¥100.00 (16%)   │
│ ████░░░░░░░░░░░░                     │
│ 本月消费: ¥123.45 / ¥500.00 (25%)  │
│ █████░░░░░░░░░░░                     │
├─────────────────────────────────────┤
│ ⚠️ 预警: 日消费已达80% (配置: ¥80) │
├─────────────────────────────────────┤
│ 消费趋势 (最近30天)                  │
│ [折线图: 日期 vs 金额]               │
├─────────────────────────────────────┤
│ 任务明细                             │
│ ┌───┬──────┬────────┬────────────┐ │
│ │时间│工作流│状态    │费用        │ │
│ ├───┼──────┼────────┼────────────┤ │
│ │... │文生视频│已完成  │¥2.45 (已结)││
│ └───┴──────┴────────┴────────────┘ │
│ [显示更多]                           │
└─────────────────────────────────────┘
```

**Token管理页面** (`/app/tokens`)

布局：
```
┌─────────────────────────────────────┐
│ Token 管理                           │
├─────────────────────────────────────┤
│ 当前 Token                           │
│ • 名称: creative-pilot               │
│ • 状态: 活跃                         │
│ • 创建时间: 2026-09-01               │
│ • 最后使用: 2026-09-17 10:00        │
│ • 使用次数: 1,523                    │
│ • 最后IP: 192.168.1.100             │
├─────────────────────────────────────┤
│ 使用记录 (最近100条)                 │
│ ┌─────────┬───────┬────┬──────────┐ │
│ │时间     │接口   │状态│IP        │ │
│ ├─────────┼───────┼────┼──────────┤ │
│ │10:00:15│POST /tasks│201│192...  │ │
│ └─────────┴───────┴────┴──────────┘ │
└─────────────────────────────────────┘
```

### 4.2 管理员页面

**管理后台** (`/app/admin`)

包含4个tab：
1. Token管理：列表、创建、吊销、修改额度
2. 费用汇总：按用户/月度统计
3. 对账工具：提交对账记录、查看差异
4. 系统监控：全局消费趋势、Top消费用户

## 5. 实施步骤

### Phase 1: 数据库与后端（5天）

- [ ] Day 1: 编写migration，创建3个新表
- [ ] Day 2: 实现 `ConsumptionService` 的增强方法（trends, tasks分页）
- [ ] Day 3: 实现 `CostAlertService` 和预警逻辑
- [ ] Day 4: 实现 `TokenManagementService` 和使用日志记录
- [ ] Day 5: 实现 `ReconciliationService` 和管理员接口

### Phase 2: 历史数据回填（1天）

- [ ] Day 6: 编写并测试回填脚本，执行生产回填

### Phase 3: Web前端（6天）

- [ ] Day 7-8: 费用中心页面（图表库选型、API集成）
- [ ] Day 9: Token管理页面
- [ ] Day 10-11: 管理后台页面（4个tab）
- [ ] Day 12: 集成测试、UI调优

### Phase 4: 测试与文档（2天）

- [ ] Day 13: 单元测试、接口测试
- [ ] Day 14: 更新使用文档、部署验证

**总工期：14天（约3周）**

## 6. 技术选型

### 前端技术栈
- 零构建方案（纯ESM，与现有 `/app/` 一致）
- 图表库：Chart.js（轻量，CDN可用）
- 样式：TailwindCSS CDN
- 状态管理：sessionStorage + 简单的响应式封装

### 后端中间件
- 在 `ApiCredentialGuard` 中增加日志记录逻辑
- 在 `ConsumptionService` 中实现预警检查（每次查询overview时触发）

## 7. 数据回填策略

```sql
-- 回填脚本逻辑
-- 1. 从 Task 表提取所有已完成的任务
-- 2. 从 TaskBudgetReservation 表获取费用数据
-- 3. 按 dayKey/monthKey 分组聚合
-- 4. 生成历史消费趋势数据（存储在应用层或缓存）

-- 注意：不创建新的聚合表，直接从现有表查询
-- 历史趋势查询性能优化通过索引实现
```

## 8. 验收标准

### 功能验收
- [ ] 用户能看到日/月消费、剩余额度、消费趋势图
- [ ] 用户能看到任务明细、每个任务的费用状态
- [ ] 用户能配置预警阈值，触发时页面显示预警
- [ ] 用户能查看当前Token信息和使用记录
- [ ] 管理员能看到所有Token列表和使用统计
- [ ] 管理员能提交对账记录，系统自动计算差异
- [ ] 管理员能查看全局费用汇总和Top用户
- [ ] 历史数据（9月1日至今）能正确显示

### 性能验收
- [ ] 消费概览查询 < 500ms
- [ ] 趋势图查询（30天）< 1s
- [ ] 任务明细分页查询 < 800ms
- [ ] Token使用日志查询 < 500ms

### 安全验收
- [ ] 用户只能查看自己的消费和Token信息
- [ ] Token使用日志不泄露其他用户信息
- [ ] 管理员接口必须有AdminTokenGuard
- [ ] 越权访问返回404（不泄露存在性）

## 9. 风险与应对

| 风险 | 应对 |
|------|------|
| 历史数据回填耗时长 | 分批处理，先回填最近30天 |
| 消费趋势查询慢 | 增加复合索引 `(actorId, dayKey)` |
| Token日志表快速膨胀 | 定期清理90天前的日志 |
| 预警逻辑影响查询性能 | 预警检查异步化，不阻塞主查询 |

## 10. 后续优化方向

（当前不做，留待未来需求驱动）

- 部门级预算管理
- 费用预警推送（邮件/企业微信）
- Token细粒度权限控制
- 自动化对账（定期拉取Provider账单）
- 费用预测（基于历史趋势）
- 导出报表功能

---

**参考文档：**
- [UI调研与分期方案](../2026-09-15/UI调研与分期方案.md)
- [项目现状分析与未来规划](../archive/2026-09-11/项目现状分析与未来规划.md)
- [ROADMAP](../ROADMAP.md)

---

## 11. 开发进度记录

### Phase 2: 前端开发 (已完成 - 2026-09-17)

**技术栈选型：**
- Next.js 15 + App Router
- TypeScript
- Tailwind CSS v4 + shadcn/ui
- Recharts
- Axios

**已完成功能：**

1. **认证系统**
   - 双模式认证（用户模式：API Key + Credential；管理员模式：Admin Token）
   - localStorage持久化
   - 统一的API拦截器
   - 登录页面（/login）

2. **消费看板** (/dashboard)
   - 今日/本月消费卡片
   - 预警状态显示
   - 7/30/90天消费趋势图表
   - 趋势摘要（总消费、日均、峰值）
   - 响应式布局（移动端/平板/桌面）

3. **Token管理** (/tokens)
   - Token统计（总请求/24小时/7天）
   - 使用记录表格
   - 搜索和筛选（接口、HTTP方法、状态码范围）
   - CSV导出功能（UTF-8 BOM）
   - 响应式表格（移动端横向滚动）

4. **对账管理** (/reconciliation) - 管理员专用
   - 对账表单（月份、用户ID、平台金额、备注）
   - 对账历史列表
   - 差异高亮显示（>5%）
   - 搜索和筛选（月份、用户、差异级别）
   - 响应式表单布局

5. **预警配置** (/alerts)
   - 日消费/月消费预警开关
   - 阈值设置
   - 当前状态显示
   - 响应式布局

6. **通用优化**
   - 移动端响应式侧边栏（汉堡菜单 + 遮罩层）
   - 自适应字体大小（sm:, md:, lg: 断点）
   - 表格横向滚动（overflow-x-auto）
   - 图表自适应Y轴格式化（≥1000显示k后缀）
   - 加载骨架屏
   - 错误处理和重试机制

**构建状态：**
- ✅ TypeScript类型检查通过
- ✅ Next.js生产构建成功
- ✅ 9个静态页面预渲染完成

**待测试：**
- 与后端API集成测试
- 真实设备响应式测试
- 用户体验测试

**已跳过功能：**
- Top消费者排行榜（内部使用，需求不明确）

**后续计划：**
- Phase 3: 任务历史 + 质量评价 + 推荐功能（按需开发）
- SSO集成（Keycloak统一认证）

