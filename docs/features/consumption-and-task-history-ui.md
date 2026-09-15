# 用户消费和任务数据查看UI实施计划

> **文档版本：** v1.0  
> **创建时间：** 2026-09-15  
> **作者：** AI Assistant  
> **状态：** 规划中

---

## 📋 整体目标

让用户能够在 ComfyUI 界面中查看：
1. **消费概览**：日/月消费金额、剩余额度、任务数量
2. **任务历史列表**：所有提交过的任务，带筛选和分页
3. **任务详细信息**：每个任务的完整提交数据、执行参数、费用明细
4. **消费趋势**：按天统计的消费走势图

---

## 📐 技术架构

```
┌─────────────────────────────────────────────────┐
│          ComfyUI 前端界面                        │
│  ┌──────────────────────────────────────────┐  │
│  │  菜单按钮："💰 查看消费与任务"            │  │
│  └──────────────────────────────────────────┘  │
│                     │                           │
│                     ▼                           │
│  ┌──────────────────────────────────────────┐  │
│  │         弹窗模态框                        │  │
│  │  ┌────────────────────────────────────┐  │  │
│  │  │  Tab 1: 消费概览                   │  │  │
│  │  │  Tab 2: 任务历史                   │  │  │
│  │  │  Tab 3: 消费趋势                   │  │  │
│  │  └────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
                     │
                     │ HTTP API
                     ▼
┌─────────────────────────────────────────────────┐
│         Backend NestJS API                       │
│  ┌──────────────────────────────────────────┐  │
│  │  GET /v1/consumption/overview            │  │
│  │  GET /v1/consumption/trends              │  │
│  │  GET /v1/tasks (列表+筛选+分页)          │  │
│  │  GET /v1/tasks/:id (详情)               │  │
│  └──────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────┐
│         PostgreSQL 数据库                        │
│  • Task (任务记录)                               │
│  • TaskBudgetReservation (预算预占)             │
│  • ExecutionAttempt (执行尝试)                  │
│  • Asset (素材/产物)                            │
│  • ActorCredential (用户额度)                   │
└─────────────────────────────────────────────────┘
```

---

## 🎯 第一阶段：后端 API 开发（2-3天）

### 1.1 消费统计 API

**新建文件：** `packages/backend/src/v1/consumption/v1-consumption.controller.ts`

**接口清单：**

#### `GET /v1/consumption/overview`

**功能：** 获取当前用户的消费概览

**返回数据结构：**
```json
{
  "daily": {
    "settled": "7.623000",
    "reserved": "15.120000",
    "taskCount": 5,
    "limit": "100.000000",
    "remaining": "77.257000"
  },
  "monthly": {
    "settled": "45.680000",
    "reserved": "30.240000",
    "taskCount": 28,
    "limit": "1000.000000",
    "remaining": "924.080000"
  }
}
```

**数据来源：**
- `TaskBudgetReservation` 表按 `dayKey`/`monthKey` 聚合
- `ActorCredential` 表获取额度配置

**查询逻辑：**
1. 获取上海时区当前日期作为 `dayKey` 和 `monthKey`
2. 聚合 `state='settled'` 的已结算金额
3. 聚合 `state='reserved'` 的预占金额
4. 计算剩余额度 = 配置额度 - 已结算 - 预占中

---

#### `GET /v1/consumption/trends?days=30`

**功能：** 获取消费趋势数据（用于绘图）

**查询参数：**
- `days`: 查询天数（默认30，最大90）

**返回数据结构：**
```json
{
  "trends": [
    {
      "date": "2026-09-01",
      "amount": "12.345000",
      "taskCount": 8
    },
    {
      "date": "2026-09-02",
      "amount": "8.760000",
      "taskCount": 5
    }
  ]
}
```

**查询逻辑：**
- 按 `dayKey` 分组
- 只统计 `state='settled'` 的记录
- 按日期升序排列

---

### 1.2 任务列表与详情 API

**修改文件：** `packages/backend/src/v1/tasks/v1-tasks.controller.ts`

#### `GET /v1/tasks`

**功能：** 分页查询当前用户的任务列表

**查询参数：**
- `page`: 页码（默认1）
- `limit`: 每页数量（默认20，最大100）
- `status`: 状态筛选（可选：pending, completed, failed）
- `workflowKey`: 工作流类型筛选（可选）
- `startDate`: 开始日期（ISO 8601格式）
- `endDate`: 结束日期（ISO 8601格式）

**返回数据结构：**
```json
{
  "tasks": [
    {
      "id": "bd5c5d7d-3683-436c-bb06-cbe403af820f",
      "workflowKey": "seedance.text-to-video.v1",
      "workflowName": "文生视频",
      "status": "completed",
      "deliveryStatus": "ready",
      "parameters": {
        "duration": 5,
        "resolution": "720p",
        "ratio": "16:9",
        "model": "doubao-seedance-2-5-260628"
      },
      "promptPreview": "一只小猫在花园里玩耍...",
      "cost": {
        "reserved": "7.560000",
        "settled": "7.623000",
        "status": "usage_calculated"
      },
      "createdAt": "2026-09-15T10:30:00Z",
      "completedAt": "2026-09-15T10:32:15Z",
      "hasOutput": true,
      "outputReady": true
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 156,
    "totalPages": 8
  }
}
```

**查询逻辑：**
1. 只查询 `actorId` 等于当前用户的任务
2. 应用筛选条件
3. 关联查询 `budgetReservation`（1条）、`executionAttempts`（最新1条）、`assets`（输出1条）
4. 按 `createdAt` 降序排列
5. 分页返回

**性能优化：**
- 在 `Task` 表上添加复合索引：`(actorId, createdAt DESC)`
- 在 `Task` 表上添加索引：`(actorId, status)`

---

#### `GET /v1/tasks/:id`

**功能：** 获取单个任务的完整详情

**权限验证：** 验证任务归属（`task.actorId === currentUser.actorId`）

**返回数据结构：**
```json
{
  "task": {
    "id": "bd5c5d7d-3683-436c-bb06-cbe403af820f",
    "actorId": "actor-123",
    "status": "completed",
    "createdAt": "2026-09-15T10:30:00Z",
    "completedAt": "2026-09-15T10:32:15Z"
  },
  "submissionDetails": {
    "workflow": {
      "key": "seedance.text-to-video.v1",
      "name": "文生视频",
      "version": "v1",
      "contractDigest": "2e95034c..."
    },
    "generation": {
      "model": "doubao-seedance-2-5-260628",
      "duration": 5,
      "resolution": "720p",
      "ratio": "16:9",
      "outputFormat": "mp4",
      "generateAudio": true,
      "watermark": false,
      "frameRate": 24
    },
    "prompt": {
      "text": "一只小猫在花园里玩耍，阳光明媚...",
      "length": 45
    },
    "media": [
      {
        "role": "reference_image",
        "assetId": "asset-abc",
        "mimeType": "image/webp",
        "sizeBytes": 52644,
        "metadata": {
          "width": 769,
          "height": 1163
        }
      }
    ],
    "pricing": {
      "version": "seedance-2.5-public-2026-09-15",
      "reserveCny": "7.560000",
      "estimatedTokens": 108000,
      "ratePerMillion": "70.000000",
      "basis": "output tokens calculation",
      "snapshot": { /* 完整定价快照 */ }
    },
    "execution": {
      "slotId": "slot-template-text-v1",
      "slotSequence": 1,
      "preflightId": "80af152a-..."
    }
  },
  "attempts": [
    {
      "attemptId": "attempt-1",
      "attemptNo": 1,
      "provider": "seedance",
      "model": "doubao-seedance-2-5-260628",
      "status": "completed",
      "providerTaskId": "cgt-20260915183853-isazs",
      "costStatus": "usage_calculated",
      "estimatedCostCny": "7.560000",
      "usageCalculatedCostCny": "7.623000",
      "billedCostCny": null,
      "submittedAt": "2026-09-15T10:31:00Z",
      "finishedAt": "2026-09-15T10:32:00Z"
    }
  ],
  "assets": [
    {
      "assetId": "output-xyz",
      "role": "output",
      "objectKey": "videos/2026/09/15/task-id/attempt-1/result.mp4",
      "mimeType": "video/mp4",
      "sizeBytes": 8023991,
      "inspectionStatus": "verified"
    }
  ],
  "budget": {
    "state": "settled",
    "reservedCny": "7.560000",
    "settledCny": "7.623000",
    "dayKey": "2026-09-15",
    "monthKey": "2026-09",
    "pricingVersion": "seedance-2.5-public-2026-09-15"
  },
  "correlation": {
    "taskId": "bd5c5d7d-3683-436c-bb06-cbe403af820f",
    "clientRequestId": "intent-1",
    "attemptIds": ["attempt-1"],
    "providerTaskIds": ["cgt-20260915183853-isazs"],
    "objectKeys": ["videos/2026/09/15/.../result.mp4"]
  }
}
```

**实现方式：**
- 复用已有的 `TaskReportService.buildReport()` 获取基础报告
- 新增 `extractSubmissionDetails()` 方法从 `executionPlan` 提取结构化数据

---

### 1.3 数据解析服务

**新建文件：** `packages/backend/src/tasks/task-detail.service.ts`（可选，或集成到 Controller）

**职责：**
1. 从 `Task.executionPlan` (JSON) 中提取结构化信息
2. 工作流类型到显示名称的映射
3. 参数标准化和格式化

**工作流名称映射：**
```typescript
const WORKFLOW_NAMES: Record<string, string> = {
  'seedance.text-to-video.v1': '文生视频',
  'seedance.reference-image-to-video.v1': '参考图生视频',
  'seedance.first-frame-to-video.v1': '首帧图生视频',
  'seedance.first-last-frame-to-video.v1': '首尾帧生视频',
  'seedance.omni-reference.v1': '多模态参考',
  'seedance.video-edit.v1': '视频编辑',
  'seedance.video-extend.v1': '视频延长',
  'seedance.audio-reference.v1': '音频参考',
};
```

---

## 🎨 第二阶段：ComfyUI 前端 UI（3-4天）

### 2.1 菜单入口

**新建文件：** `packages/comfyui-video-flow-client/web/js/menu_extension.js`

**功能：** 在 ComfyUI 菜单栏添加"查看消费与任务"按钮

**实现方式：**
```javascript
app.registerExtension({
  name: "VideoFlow.MenuBar",
  async setup() {
    const menu = document.querySelector(".comfy-menu");
    const button = document.createElement("button");
    button.textContent = "💰 查看消费与任务";
    button.onclick = () => window.videoFlowHistory.show();
    menu.appendChild(button);
  }
});
```

---

### 2.2 核心UI组件

**新建文件：** `packages/comfyui-video-flow-client/web/js/task_history_ui.js`

**组件结构：**

```
TaskHistoryModal (主容器)
├── Header (标题 + 关闭按钮)
├── Tabs (三个标签页)
│   ├── OverviewTab (消费概览)
│   │   ├── DailySummaryCard (今日消费卡片)
│   │   └── MonthlySummaryCard (本月消费卡片)
│   │
│   ├── TaskListTab (任务历史)
│   │   ├── FilterBar (筛选器：工作流类型、状态、日期)
│   │   ├── TaskTable (任务列表表格)
│   │   │   └── TaskRow → 点击展开 TaskDetailPanel
│   │   └── Pagination (分页控件)
│   │
│   └── TrendsTab (消费趋势)
│       └── ConsumptionChart (折线图/柱状图)
└── Footer
```

**核心类：**
```javascript
class TaskHistoryManager {
  constructor() {
    this.modal = null;
    this.currentPage = 1;
    this.currentTab = 'overview';
    this.filters = {
      status: null,
      workflowKey: null,
      startDate: null,
      endDate: null,
    };
  }

  async show() { /* 显示弹窗 */ }
  close() { /* 关闭弹窗 */ }
  
  async fetchTasks(page) { /* 获取任务列表 */ }
  async fetchTaskDetail(taskId) { /* 获取任务详情 */ }
  async fetchConsumptionOverview() { /* 获取消费概览 */ }
  async fetchConsumptionTrends(days) { /* 获取消费趋势 */ }
  
  renderOverviewTab() { /* 渲染消费概览 */ }
  renderTaskListTab() { /* 渲染任务列表 */ }
  renderTrendsTab() { /* 渲染趋势图表 */ }
  renderTaskDetail(taskId) { /* 渲染任务详情 */ }
}
```

---

### 2.3 任务详情面板

**功能：** 点击任务列表中的某一行，在右侧或下方展开详情面板

**展示内容布局：**

```
┌─────────────────────────────────────────────┐
│ 任务详情 - bd5c5d7d-3683-436c-bb06...       │
├─────────────────────────────────────────────┤
│ 【基本信息】                                │
│  • 工作流：文生视频 (text-to-video.v1)      │
│  • 状态：已完成                             │
│  • 创建时间：2026-09-15 18:30:00            │
│  • 完成时间：2026-09-15 18:32:15            │
│                                             │
│ 【提交参数】                                │
│  • 模型：doubao-seedance-2-5-260628         │
│  • 时长：5秒                                │
│  • 分辨率：720p (1280×720)                  │
│  • 宽高比：16:9                             │
│  • 输出格式：MP4                            │
│  • 音频：开启                               │
│  • 水印：关闭                               │
│  • 帧率：24 FPS                             │
│                                             │
│ 【提示词】                                  │
│  一只小猫在花园里玩耍，阳光明媚...          │
│                                             │
│ 【输入素材】(如果有)                        │
│  • 参考图：image.webp (52.6 KB, 769×1163)   │
│  • 参考视频：clip.mp4 (2.3 MB, 5.2秒)      │
│                                             │
│ 【费用明细】                                │
│  • 预占金额：¥7.560000                     │
│  • 实际结算：¥7.623000                     │
│  • Token用量：108,900                       │
│  • 定价版本：seedance-2.5-public-2026-09-15│
│  • 状态：usage_calculated                   │
│                                             │
│ 【执行信息】                                │
│  • Provider任务ID：cgt-20260915183853...    │
│  • 提交时间：2026-09-15 18:31:00            │
│  • 开始时间：2026-09-15 18:31:10            │
│  • 完成时间：2026-09-15 18:32:00            │
│                                             │
│ 【输出产物】                                │
│  • 文件：result.mp4 (8.0 MB)               │
│  • 本地路径：~/ComfyUI/output/video-flow/...│
│  • SHA-256：65d04429...                     │
│                                             │
│ [下载成片] [重新生成] [复制任务ID]          │
└─────────────────────────────────────────────┘
```

**交互行为：**
- 详情面板支持折叠/展开各个区块
- 点击任务ID自动复制到剪贴板
- "下载成片"按钮调用已有的下载逻辑
- "重新生成"按钮预填充参数到新的工作流节点

---

### 2.4 消费趋势图表

**图表库选择：** Chart.js（轻量，约 200KB）或纯 Canvas 手绘

**图表类型：**

#### 折线图：每日消费金额走势
- X轴：日期
- Y轴：金额（CNY）
- 数据点：可hover显示具体金额和任务数

#### 柱状图：每日任务数量
- X轴：日期
- Y轴：任务数
- 颜色区分：已完成（绿色）、失败（红色）

**实现方式（Chart.js示例）：**
```javascript
async renderTrendsChart() {
  const trends = await this.fetchConsumptionTrends(30);
  
  const ctx = document.getElementById('trendsChart').getContext('2d');
  new Chart(ctx, {
    type: 'line',
    data: {
      labels: trends.trends.map(t => t.date),
      datasets: [{
        label: '每日消费（元）',
        data: trends.trends.map(t => parseFloat(t.amount)),
        borderColor: '#4CAF50',
        backgroundColor: 'rgba(76, 175, 80, 0.1)',
        tension: 0.3
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: true },
        tooltip: { mode: 'index' }
      },
      scales: {
        y: { beginAtZero: true }
      }
    }
  });
}
```

---

## 🎨 第三阶段：样式与交互优化（1-2天）

### 3.1 视觉设计

**配色方案（适配 ComfyUI 暗色主题）：**

| 用途 | 颜色值 | 说明 |
|------|--------|------|
| 主背景 | `#1e1e1e` | 深灰色 |
| 次背景 | `#2a2a2a` | 稍浅灰色 |
| 卡片背景 | `#252525` | 中间灰 |
| 文字主色 | `#e0e0e0` | 浅灰色 |
| 文字次要 | `#888888` | 中灰色 |
| 边框 | `#333333` | 深灰边框 |
| 边框hover | `#444444` | 浅灰边框 |
| 成功/已完成 | `#4CAF50` | 绿色 |
| 进行中 | `#2196F3` | 蓝色 |
| 失败/错误 | `#dc3545` | 红色 |
| 警告/预占 | `#ff9800` | 橙色 |
| 主按钮 | `#007bff` | 蓝色 |

**字体：**
- 主字体：系统默认无衬线字体
- 代码/ID：等宽字体 `Consolas, Monaco, monospace`

**圆角与阴影：**
- 卡片圆角：`6px`
- 按钮圆角：`4px`
- 阴影：`0 2px 8px rgba(0, 0, 0, 0.3)`

---

### 3.2 交互细节

#### 加载状态
- 显示骨架屏（灰色占位块）
- 加载动画：旋转的 Spinner
- 禁用操作按钮直到数据加载完成

#### 空状态
- 无任务时显示居中的空状态插图
- 文案："暂无任务记录，快去创建第一个视频吧！"
- 提供"创建任务"按钮跳转到工作流

#### 错误处理
- API失败时显示Toast提示："加载失败，请稍后重试"
- 401错误：提示"登录已过期，请重新登录"
- 403错误：提示"无权限访问此任务"
- 网络错误：显示重试按钮

#### 响应式布局
- 弹窗宽度：90%，最大 1200px
- 小屏幕（<768px）：标签页纵向堆叠，表格横向滚动
- 大屏幕（>1200px）：详情面板右侧展开

#### 键盘支持
- `ESC` 键：关闭弹窗
- `Tab` 键：在表单元素间导航
- `Enter` 键：在筛选器中触发查询

#### 动画效果
- 弹窗淡入淡出：300ms
- 列表项加载渐显：stagger 50ms
- hover效果：transition 200ms
- 详情面板展开：slide down 300ms

---

### 3.3 性能优化

#### 前端优化
- **虚拟滚动**：任务列表超过100条时启用虚拟滚动
- **懒加载**：详情面板点击时才请求，不预加载
- **缓存策略**：已加载的任务详情缓存5分钟
- **防抖**：筛选和搜索输入防抖300ms
- **分页预加载**：当前页显示时，预加载下一页数据

#### 后端优化
- **数据库索引**：
  - `Task(actorId, createdAt DESC)`
  - `Task(actorId, status)`
  - `TaskBudgetReservation(actorId, dayKey, state)`
  - `TaskBudgetReservation(actorId, monthKey, state)`
  
- **查询优化**：
  - 任务列表只查询必要字段，不加载完整 `executionPlan`
  - 使用 `SELECT DISTINCT` 避免重复数据
  - 限制单次查询最大 100 条

- **缓存策略**：
  - 消费概览数据缓存 1 分钟（Redis）
  - 任务列表缓存 30 秒
  - 任务详情不缓存（确保实时性）

---

## 🧪 第四阶段：测试与验证（1-2天）

### 4.1 后端测试

#### 单元测试

**文件：** `packages/backend/src/v1/consumption/v1-consumption.controller.spec.ts`

**测试用例：**
- ✅ 获取消费概览 - 正常情况
- ✅ 获取消费概览 - 无任务时返回零值
- ✅ 获取消费趋势 - 指定天数
- ✅ 获取消费趋势 - 超出最大天数限制
- ✅ 日消费计算正确（已结算 + 预占中）
- ✅ 月消费计算正确
- ✅ 剩余额度计算正确

**文件：** `packages/backend/src/v1/tasks/v1-tasks.controller.spec.ts`

**测试用例：**
- ✅ 任务列表分页正确
- ✅ 按状态筛选任务
- ✅ 按工作流类型筛选任务
- ✅ 按日期范围筛选任务
- ✅ 获取任务详情 - 成功
- ✅ 获取任务详情 - 不存在的任务返回404
- ✅ 获取任务详情 - 无权限访问返回404
- ✅ executionPlan解析正确

---

#### 集成测试

**文件：** `packages/backend/test/consumption.contract-spec.ts`

**测试场景：**
1. 创建真实任务 → 获取消费概览 → 验证金额正确
2. 创建多个任务 → 按状态筛选 → 验证结果正确
3. 预占未结算 → 消费概览显示预占金额
4. 跨月任务 → 月消费统计正确
5. 并发创建任务 → 消费统计无重复计算

---

### 4.2 前端测试

#### 功能测试清单

**消费概览Tab：**
- [ ] 正确显示日/月消费金额
- [ ] 正确显示剩余额度
- [ ] 金额格式化正确（6位小数）
- [ ] 无额度配置时显示"N/A"
- [ ] 刷新按钮能更新数据

**任务列表Tab：**
- [ ] 任务列表正确显示
- [ ] 分页功能正常（上一页/下一页）
- [ ] 工作流类型筛选生效
- [ ] 状态筛选生效
- [ ] 日期范围筛选生效
- [ ] 清空筛选恢复默认
- [ ] 点击任务行展开详情
- [ ] 空状态正确显示

**任务详情面板：**
- [ ] 所有字段正确显示
- [ ] 复制任务ID功能正常
- [ ] 下载成片按钮可用
- [ ] 输入素材列表显示完整
- [ ] 费用明细计算正确
- [ ] 关闭详情面板恢复列表

**消费趋势Tab：**
- [ ] 图表正确渲染
- [ ] 数据点可hover显示详情
- [ ] 切换天数范围重新加载数据
- [ ] 无数据时显示空状态

**通用交互：**
- [ ] ESC键关闭弹窗
- [ ] 点击遮罩关闭弹窗
- [ ] Tab切换正常
- [ ] 加载状态显示正确
- [ ] 错误提示显示正确

---

#### 兼容性测试

**浏览器：**
- [ ] Chrome 120+
- [ ] Firefox 120+
- [ ] Safari 17+
- [ ] Edge 120+

**分辨率：**
- [ ] 1920×1080 (常见桌面)
- [ ] 1366×768 (小屏笔记本)
- [ ] 2560×1440 (高分屏)

---

### 4.3 端到端测试

#### 测试流程

**场景1：首次使用**
1. 用户打开 ComfyUI
2. 点击"查看消费与任务"按钮
3. 显示空状态（无任务）
4. 消费概览显示零值
5. 关闭弹窗

**场景2：创建任务后查看**
1. 创建一个文生视频任务
2. 等待任务完成
3. 打开消费查看弹窗
4. 验证任务出现在列表中
5. 点击任务查看详情
6. 验证所有字段与提交时一致
7. 验证费用已结算

**场景3：筛选和分页**
1. 创建多个不同类型的任务
2. 打开消费查看弹窗
3. 按工作流类型筛选
4. 验证筛选结果正确
5. 翻页查看更多任务
6. 验证分页逻辑正确

**场景4：权限隔离**
1. 用户A创建任务
2. 用户B登录
3. 用户B打开消费查看弹窗
4. 验证只能看到自己的任务
5. 尝试访问用户A的任务ID
6. 验证返回404

---

## 📦 第五阶段：部署与文档（1天）

### 5.1 部署清单

#### 后端部署步骤

1. **代码提交**
   ```bash
   git add packages/backend/src/v1/consumption/
   git add packages/backend/src/v1/tasks/v1-tasks.controller.ts
   git commit -m "feat: add consumption and task history APIs"
   ```

2. **运行测试**
   ```bash
   cd packages/backend
   npm run test
   npm run build
   ```

3. **数据库迁移（如需要）**
   ```bash
   # 检查是否需要新增索引
   # 在生产环境执行前先在测试环境验证
   ```

4. **部署到服务器**
   ```bash
   # 拉取最新代码
   git pull origin main
   
   # 重启服务
   pm2 restart video-flow-backend
   ```

5. **验证接口**
   ```bash
   curl -H "Authorization: Bearer $TOKEN" \
     https://ai.sweetyshell.com/api/v1/consumption/overview
   ```

---

#### 前端部署步骤

1. **代码提交**
   ```bash
   git add packages/comfyui-video-flow-client/web/js/
   git commit -m "feat: add task history and consumption UI"
   ```

2. **安装到 ComfyUI**
   ```bash
   cd packages/comfyui-video-flow-client
   bash install.sh
   ```

3. **重启 ComfyUI**
   - 重启 Comfy Desktop 或 ComfyUI 服务

4. **验证UI**
   - 打开 ComfyUI
   - 查看菜单栏是否出现"查看消费与任务"按钮
   - 点击按钮验证弹窗正常显示

---

### 5.2 用户文档

#### 新增用户手册章节

**文件：** `docs/user-guide/consumption-tracking.md`

**章节结构：**

##### 1. 查看消费概览
- 如何打开消费查看界面
- 理解日/月消费金额
- 理解预占与结算的区别
- 查看剩余额度

##### 2. 查看任务历史
- 任务列表说明
- 筛选任务（按类型、状态、日期）
- 分页浏览
- 排序规则

##### 3. 查看任务详情
- 如何展开任务详情
- 理解各个字段的含义
- 提交参数说明
- 费用明细解读

##### 4. 费用状态说明

| 状态 | 含义 | 说明 |
|------|------|------|
| `estimated` | 预估 | 创建任务时的预估金额 |
| `usage_calculated` | 已计算 | 根据Provider返回的usage计算的金额 |
| `billed` | 已确认 | Provider账单确认的最终金额 |
| `unavailable` | 不可用 | 无法计算或获取费用信息 |

##### 5. 预占与结算

**预占金额（Reserved）：**
- 创建任务时根据参数估算并冻结的金额
- 确保用户有足够额度执行任务
- 任务完成前一直占用额度

**结算金额（Settled）：**
- Provider返回实际usage后计算的金额
- 可能与预占金额略有差异
- 结算后释放预占，只扣除实际金额

**差异原因：**
- 预占使用估算公式（偏保守）
- 结算使用Provider实际返回的token数
- 通常差异在1-2%以内

---

### 5.3 运维监控

#### 日志记录

**后端日志：**
```typescript
// 记录消费查询
this.logger.log(`User ${actorId} fetched consumption overview`);

// 记录任务列表查询
this.logger.log(`User ${actorId} fetched task list, page=${page}, filters=${JSON.stringify(filters)}`);

// 记录任务详情访问
this.logger.log(`User ${actorId} fetched task detail, taskId=${taskId}`);
```

**前端错误上报：**
```javascript
window.addEventListener('unhandledrejection', (event) => {
  if (event.reason?.message?.includes('consumption')) {
    console.error('Consumption UI error:', event.reason);
    // 可选：上报到错误追踪服务
  }
});
```

---

#### 性能监控

**关键指标：**

| 指标 | 目标 | 监控方式 |
|------|------|---------|
| API响应时间（P95） | < 500ms | APM工具 |
| 任务列表加载时间 | < 1s | 前端Performance API |
| 消费概览加载时间 | < 300ms | 前端Performance API |
| 数据库查询时间 | < 200ms | Prisma日志 |
| UI渲染时间 | < 100ms | Chrome DevTools |

**告警规则：**
- API错误率 > 5%：立即告警
- API响应时间 P95 > 1s：警告
- 数据库慢查询 > 500ms：记录日志

---

#### 数据库维护

**索引监控：**
```sql
-- 检查索引使用情况
SELECT
  schemaname,
  tablename,
  indexname,
  idx_scan,
  idx_tup_read,
  idx_tup_fetch
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
  AND tablename IN ('tasks', 'task_budget_reservations')
ORDER BY idx_scan;
```

**定期优化：**
- 每周执行 `VACUUM ANALYZE tasks`
- 每月检查索引碎片率
- 监控表大小增长趋势

---

#### 缓存策略（可选）

**Redis缓存配置：**

```typescript
// 消费概览缓存1分钟
const cacheKey = `consumption:overview:${actorId}`;
const cached = await redis.get(cacheKey);
if (cached) return JSON.parse(cached);

const data = await this.fetchFromDB();
await redis.setex(cacheKey, 60, JSON.stringify(data));
return data;
```

**缓存失效规则：**
- 用户创建新任务：清除该用户的消费概览缓存
- 任务状态变更：清除该用户的任务列表缓存
- 手动刷新：忽略缓存直接查询数据库

---

## 📊 数据展示优先级

### P0（必须有）- MVP版本
- ✅ 日/月消费金额和剩余额度
- ✅ 任务列表（ID、工作流类型、状态、费用、时间）
- ✅ 任务详情（提交参数、提示词、费用明细）
- ✅ 基本筛选（按状态、工作流类型）
- ✅ 分页功能

### P1（应该有）- 增强版本
- ✅ 按日期范围筛选
- ✅ 输入素材信息展示
- ✅ 费用计算依据（Token、定价快照）
- ✅ 任务数量统计
- ✅ 复制任务ID功能

### P2（可以有）- 完整版本
- ⏳ 消费趋势图表（折线图/柱状图）
- ⏳ 导出功能（CSV/JSON）
- ⏳ 任务对比功能（选择2个任务对比参数差异）
- ⏳ 搜索功能（按提示词、任务ID搜索）
- ⏳ 高级筛选（按费用范围、执行时长筛选）

### P3（未来考虑）
- 消费预警（接近额度限制时提醒）
- 批量操作（批量删除、批量导出）
- 自定义视图（用户可自定义显示哪些列）
- 任务标签和分组
- 月度账单生成

---

## ⏱️ 总体时间估算

| 阶段 | 工作内容 | 预计时间 | 关键里程碑 |
|------|---------|---------|-----------|
| 1 | 后端 API 开发 | 2-3 天 | API接口全部通过测试 |
| 2 | 前端 UI 开发 | 3-4 天 | 三个Tab全部可用 |
| 3 | 样式与交互优化 | 1-2 天 | UI美化完成，交互流畅 |
| 4 | 测试与验证 | 1-2 天 | 所有测试用例通过 |
| 5 | 部署与文档 | 1 天 | 生产环境可用，文档完整 |
| **总计** | | **8-12 天** | **MVP版本上线** |

---

## 🎯 里程碑与发布计划

### Week 1：后端API + 基础UI
**目标：** 完成所有后端接口，前端能显示基础数据

**交付物：**
- ✅ 消费统计API（overview + trends）
- ✅ 任务列表API（带分页和筛选）
- ✅ 任务详情API
- ✅ 前端弹窗框架
- ✅ 消费概览Tab（基础版）
- ✅ 任务列表Tab（基础版）

**验收标准：**
- 用户能打开弹窗看到消费金额
- 用户能看到任务列表
- 点击任务能看到详情

---

### Week 2：详情完善 + 样式优化
**目标：** 详情展示完整，UI美观易用

**交付物：**
- ✅ 任务详情面板（所有字段）
- ✅ 筛选和分页功能
- ✅ 消费趋势Tab（含图表）
- ✅ 样式优化和动画
- ✅ 错误处理和加载状态
- ✅ 所有测试用例

**验收标准：**
- 任务详情显示完整（参数、素材、费用）
- 筛选和分页正常工作
- UI流畅美观，无明显bug
- 所有自动化测试通过

---

### Week 3：部署上线 + 收集反馈
**目标：** 生产环境可用，持续优化

**交付物：**
- ✅ 生产环境部署
- ✅ 用户文档
- ✅ 运维监控配置
- ✅ 性能优化
- ⏳ 用户反馈收集
- ⏳ Bug修复和改进

**验收标准：**
- 生产环境稳定运行
- 用户能正常使用所有功能
- 文档清晰完整
- 无P0/P1级别bug

---

## 📝 附录：技术决策记录

### 为什么选择弹窗而不是独立页面？
- ComfyUI是单页应用，用户习惯在当前页面操作
- 弹窗可以快速查看后关闭，不打断工作流
- 实现简单，不需要路由和页面管理

### 为什么不使用React/Vue框架？
- ComfyUI原生是Vanilla JS，引入框架增加复杂度
- 功能相对简单，不需要复杂的状态管理
- 减小打包体积，提升加载速度
- 保持与ComfyUI核心代码风格一致

### 为什么任务列表不显示完整executionPlan？
- executionPlan是大JSON对象，会显著增加网络传输和渲染时间
- 列表场景只需要摘要信息（类型、状态、费用）
- 详情场景才需要完整数据，可按需加载

### 为什么使用dayKey/monthKey而不是日期范围查询？
- 等值查询可以充分利用索引
- 上海时区的天/月边界在数据写入时已确定
- 聚合查询性能更好
- 避免时区转换的复杂性

---

## 🔗 相关文档

- [PROJECT_STATUS.md](../PROJECT_STATUS.md) - 项目当前状态
- [ROADMAP.md](../ROADMAP.md) - 项目路线图
- [task-budget.service.ts](../../packages/backend/src/tasks/task-budget.service.ts) - 预算服务实现
- [task-report.service.ts](../../packages/backend/src/tasks/task-report.service.ts) - 任务报告服务
- [ComfyUI Extensions Guide](https://docs.comfy.org/essentials/custom_node_gettingstarted) - ComfyUI扩展开发指南

---

**文档维护：** 本文档随功能开发进度实时更新，任何设计变更需同步修改此文档。

**版本历史：**
- v1.0 (2026-09-15): 初始版本，完整实施计划
