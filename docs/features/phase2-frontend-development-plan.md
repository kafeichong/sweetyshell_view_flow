# Phase 2: 前端开发计划

## 技术栈选型

### 核心框架
- **Next.js 15** (App Router)
  - 现代化React框架
  - App Router提供更好的开发体验
  - 内置路由、API Routes支持
  - TypeScript原生支持

- **shadcn/ui** (Radix UI + Tailwind CSS)
  - 组件代码完全可控（复制到项目中）
  - 基于Radix UI，可访问性优秀
  - Tailwind CSS样式系统，定制灵活
  - 避免"千篇一律"的UI设计

### 数据处理
- **TanStack Table v8** (React Table)
  - 强大的表格功能库
  - 支持排序、过滤、分页、虚拟滚动
  - 无样式设计，与shadcn/ui完美配合
  - TypeScript类型支持完善

### 数据可视化
- **Recharts**
  - React组件化图表库
  - 与shadcn/ui风格统一
  - 支持折线图、柱状图、饼图等
  - 响应式设计

### 表单处理
- **React Hook Form**
  - 性能优秀的表单库
  - 与shadcn/ui表单组件集成
  - 减少re-render，提升性能

- **Zod**
  - TypeScript优先的模式验证库
  - 与React Hook Form完美配合
  - 类型安全的表单验证

### HTTP客户端
- **fetch API** 或 **axios**
  - 简单直接的HTTP请求
  - 配合Next.js的Server/Client Components

### 状态管理
- **React Context** + **useState/useReducer**
  - 对于管理后台足够用
  - 避免过度工程化
  - 如需全局状态，可按需引入Zustand

## 项目结构

```
packages/frontend/
├── app/                          # Next.js App Router
│   ├── layout.tsx               # 根布局
│   ├── page.tsx                 # 首页（重定向到dashboard）
│   ├── dashboard/               # 消费看板
│   │   ├── page.tsx
│   │   └── components/
│   ├── tokens/                  # Token管理
│   │   ├── page.tsx
│   │   └── components/
│   ├── reconciliation/          # 对账管理
│   │   ├── page.tsx
│   │   └── components/
│   └── alerts/                  # 预警管理
│       ├── page.tsx
│       └── components/
├── components/                   # 共享组件
│   ├── ui/                      # shadcn/ui组件
│   ├── charts/                  # 图表组件封装
│   ├── tables/                  # 表格组件封装
│   └── layout/                  # 布局组件（侧边栏、导航）
├── lib/                         # 工具函数
│   ├── api.ts                   # API客户端
│   ├── utils.ts                 # 通用工具
│   └── validators.ts            # Zod验证模式
├── types/                       # TypeScript类型定义
│   └── api.ts                   # API响应类型
└── hooks/                       # 自定义Hooks
    ├── useConsumption.ts
    ├── useTokens.ts
    └── useReconciliation.ts
```

## 开发计划

### 第1阶段：项目初始化与基础设施（0.5天）

#### 任务清单
- [ ] 创建Next.js项目
  ```bash
  npx create-next-app@latest frontend --typescript --tailwind --app
  ```
- [ ] 初始化shadcn/ui
  ```bash
  npx shadcn@latest init
  ```
- [ ] 安装核心依赖
  ```bash
  npm install @tanstack/react-table recharts react-hook-form @hookform/resolvers zod axios date-fns
  ```
- [ ] 添加基础shadcn/ui组件
  ```bash
  npx shadcn@latest add button card input label select table
  npx shadcn@latest add form dropdown-menu avatar badge
  npx shadcn@latest add dialog alert toast tabs
  ```
- [ ] 配置API客户端
  - 创建 `lib/api.ts`
  - 配置baseURL指向backend API
  - 添加请求/响应拦截器
  - 错误处理封装

- [ ] 创建布局组件
  - 顶部导航栏（TopNav）
  - 侧边栏（Sidebar）
  - 主布局容器（MainLayout）

- [ ] 配置TypeScript类型
  - 定义API响应类型
  - 定义业务实体类型

### 第2阶段：消费看板页面（2.5天）

#### 2.1 总览卡片（0.5天）
- [ ] 创建 `dashboard/page.tsx`
- [ ] 实现StatCard组件
  - 本月消费金额（大数字展示）
  - 账户余额
  - 预警状态（正常/警告/超限）
  - 环比增长/下降
- [ ] 接入API
  - `GET /v1/consumption/overview`
- [ ] 添加骨架屏加载状态

#### 2.2 消费趋势图（1天）
- [ ] 创建TrendChart组件
- [ ] 集成Recharts
  - 折线图/柱状图切换
  - 日度/月度数据切换
  - 工具提示（Tooltip）显示详细数据
  - 响应式图表尺寸
- [ ] 接入API
  - `GET /v1/consumption/trends?granularity=day&startDate=...&endDate=...`
- [ ] 添加日期范围选择器
  - 最近7天
  - 最近30天
  - 本月
  - 自定义范围

#### 2.3 Top消费者排行（0.5天）
- [ ] 创建TopConsumersTable组件
- [ ] 使用TanStack Table
  - 排名列
  - 用户名列
  - 消费金额列
  - 任务数列
- [ ] 接入API
  - `GET /v1/consumption/top-consumers?limit=10`
- [ ] 添加简单排序功能

#### 2.4 优化与细节（0.5天）
- [ ] 响应式布局调整
- [ ] 加载状态优化
- [ ] 错误处理与重试
- [ ] 数据刷新机制（手动刷新按钮）

### 第3阶段：Token管理页面（2天）

#### 3.1 Token统计概览（0.5天）
- [ ] 创建 `tokens/page.tsx`
- [ ] Token统计卡片
  - 总Token使用量
  - 本月Token使用量
  - 平均每任务Token数
- [ ] 接入API
  - `GET /v1/tokens/info`

#### 3.2 Token使用记录表格（1天）
- [ ] 创建TokenLogsTable组件
- [ ] 使用TanStack Table
  - 时间列（日期时间）
  - 任务ID列（可点击跳转）
  - 用户列
  - Token数量列（输入/输出分别显示）
  - 费用列
  - 模型列
- [ ] 实现功能
  - 分页（Cursor分页）
  - 排序（按时间、Token数、费用）
  - 过滤（按用户、日期范围、模型）
- [ ] 接入API
  - `GET /v1/tokens/logs?limit=50&cursor=...`
  - `GET /v1/tokens/logs?actorId=...&startDate=...&endDate=...`

#### 3.3 搜索与过滤（0.5天）
- [ ] 创建FilterBar组件
  - 用户选择器（下拉）
  - 日期范围选择器
  - 模型选择器
  - 重置按钮
- [ ] 实现搜索逻辑
- [ ] URL参数同步（便于分享链接）

### 第4阶段：对账功能（1.5天）

#### 4.1 对账记录提交（0.5天）
- [ ] 创建 `reconciliation/page.tsx`
- [ ] 创建ReconciliationForm组件
- [ ] 表单字段
  - 月份选择器（YYYY-MM格式）
  - 用户选择（可选，全局对账时留空）
  - 第三方平台金额（CNY）
  - 备注（可选）
- [ ] 使用React Hook Form + Zod验证
- [ ] 接入API
  - `POST /v1/admin/reconciliation/submit`
- [ ] 表单提交成功后显示Toast通知

#### 4.2 对账历史查询（0.5天）
- [ ] 创建ReconciliationHistoryTable组件
- [ ] 使用TanStack Table
  - 月份列
  - 用户列（全局对账显示"全局"）
  - 平台金额列
  - 系统消费列
  - 差异列（高亮显示超过阈值的差异）
  - 差异率列（百分比）
  - 提交时间列
  - 备注列
- [ ] 接入API
  - `GET /v1/admin/reconciliation/records?monthKey=...`
  - `GET /v1/admin/reconciliation/records?actorId=...`

#### 4.3 差异分析展示（0.5天）
- [ ] 差异统计卡片
  - 总对账次数
  - 平均差异率
  - 异常对账次数（差异率>5%）
- [ ] 差异趋势图（按月）
- [ ] 差异高亮与警告提示

### 第5阶段：预警管理（0.5天）

#### 5.1 预警配置界面（0.3天）
- [ ] 创建 `alerts/page.tsx`
- [ ] 创建AlertConfigForm组件
- [ ] 表单字段
  - 用户选择
  - 阈值金额
  - 启用/禁用开关
- [ ] 接入API
  - `POST /v1/consumption/alerts/config`
  - `GET /v1/consumption/alerts/config`

#### 5.2 预警历史记录（0.2天）
- [ ] 创建AlertHistoryList组件
- [ ] 显示触发的预警
  - 触发时间
  - 用户
  - 消费金额
  - 阈值
  - 状态（已读/未读）
- [ ] 接入API
  - `GET /v1/consumption/alerts/triggered`

### 第6阶段：集成与优化（1天）

#### 6.1 导航与路由（0.2天）
- [ ] 完善侧边栏导航
  - Dashboard（消费看板）
  - Tokens（Token管理）
  - Reconciliation（对账管理）
  - Alerts（预警设置）
- [ ] 激活状态高亮
- [ ] 面包屑导航

#### 6.2 主题与样式（0.2天）
- [ ] 统一颜色方案
- [ ] 暗色模式支持（可选）
- [ ] 响应式断点调整
- [ ] 动画与过渡效果

#### 6.3 性能优化（0.2天）
- [ ] 图片懒加载
- [ ] 表格虚拟滚动（长列表）
- [ ] API请求去重与缓存
- [ ] React.memo优化重渲染

#### 6.4 错误处理与用户体验（0.2天）
- [ ] 全局错误边界（Error Boundary）
- [ ] API错误统一处理
- [ ] 空状态设计（无数据时）
- [ ] 加载骨架屏
- [ ] Toast通知系统

#### 6.5 测试与文档（0.2天）
- [ ] 基础端到端测试（关键流程）
- [ ] API集成测试
- [ ] README文档
  - 项目启动说明
  - 环境变量配置
  - 开发规范

## API端点清单

### 消费相关
- `GET /v1/consumption/overview` - 获取消费总览
- `GET /v1/consumption/trends` - 获取消费趋势
- `GET /v1/consumption/top-consumers` - 获取Top消费者

### Token相关
- `GET /v1/tokens/info` - 获取Token统计信息
- `GET /v1/tokens/logs` - 获取Token使用记录

### 对账相关
- `POST /v1/admin/reconciliation/submit` - 提交对账记录
- `GET /v1/admin/reconciliation/records` - 查询对账记录

### 预警相关
- `POST /v1/consumption/alerts/config` - 配置预警
- `GET /v1/consumption/alerts/config` - 获取预警配置
- `GET /v1/consumption/alerts/triggered` - 获取触发的预警

## 环境配置

### 环境变量
```env
# .env.local
NEXT_PUBLIC_API_BASE_URL=http://localhost:3000
NEXT_PUBLIC_APP_NAME=Video Flow Console
```

### 开发命令
```bash
# 安装依赖
npm install

# 开发服务器
npm run dev

# 构建生产版本
npm run build

# 启动生产服务器
npm start

# 类型检查
npm run type-check

# Lint检查
npm run lint
```

## 时间预估总结

| 阶段 | 任务 | 预估时间 |
|-----|------|---------|
| 1 | 项目初始化与基础设施 | 0.5天 |
| 2 | 消费看板页面 | 2.5天 |
| 3 | Token管理页面 | 2天 |
| 4 | 对账功能 | 1.5天 |
| 5 | 预警管理 | 0.5天 |
| 6 | 集成与优化 | 1天 |
| **总计** | | **8天** |

## 风险与应对

### 风险1：TanStack Table学习曲线
- **应对**：提前查阅文档，使用官方示例代码
- **预留时间**：已在表格任务中多预留0.5天

### 风险2：Recharts图表定制复杂
- **应对**：使用shadcn/ui社区的图表模板
- **预留时间**：趋势图任务预留1天

### 风险3：shadcn/ui组件组合耗时
- **应对**：使用shadcn/ui官方blocks（预构建组件组合）
- **预留时间**：各阶段已分别预留buffer

### 风险4：API对接问题
- **应对**：提前与backend开发确认API契约，使用mock数据并行开发
- **预留时间**：集成阶段预留1天

## 下一步行动

1. ✅ 技术栈选型完成
2. ✅ 开发计划制定完成
3. ⏳ 开始执行第1阶段：项目初始化

## 附录

### shadcn/ui组件清单
```bash
# 基础组件
button, card, input, label, select, textarea, checkbox, radio-group

# 表单组件
form, calendar, date-picker, combobox

# 数据展示
table, badge, avatar, separator, tooltip

# 反馈组件
dialog, alert, alert-dialog, toast, skeleton

# 导航组件
tabs, dropdown-menu, menubar, navigation-menu

# 布局组件
sheet, scroll-area, aspect-ratio
```

### 参考资源
- [Next.js文档](https://nextjs.org/docs)
- [shadcn/ui文档](https://ui.shadcn.com)
- [TanStack Table文档](https://tanstack.com/table/latest)
- [Recharts文档](https://recharts.org)
- [React Hook Form文档](https://react-hook-form.com)
