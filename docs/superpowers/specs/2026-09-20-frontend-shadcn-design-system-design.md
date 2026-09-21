# Video Flow 前端 shadcn/ui 单一设计系统改造规格

日期：2026-09-20
状态：已实施
适用范围：`packages/frontend`

## 1. 背景

当前前端已经通过 `components.json` 配置为 shadcn/ui `new-york` 风格、`zinc` 基础色和 CSS Variables，但业务页面仍混用旧视觉规则，包括：

- 页面级蓝紫渐变、彩色固定色阶和玻璃效果；
- `rounded-lg`、`rounded-xl` 等页面自行决定的圆角；
- `shadow-md`、`shadow-lg`、`shadow-xl` 等装饰性阴影；
- 原生 `button`、`input`、`select` 与 shadcn/ui 组件并存；
- 不同页面各自实现标题、筛选、空状态、错误状态和分页；
- `page-old.tsx`、`page-appica.tsx` 等不再参与正式路由的旧页面实现仍保留在源码中。

结果是 `/history` 与侧边栏、Dashboard 等页面在圆角、颜色、间距、层级和交互反馈上不一致。

## 2. 目标

前端只保留一套视觉语言：shadcn/ui New York v4。

完成后应满足：

1. 所有正式页面只使用 shadcn/ui 的语义色、圆角、边框和组件状态。
2. 页面不再定义独立品牌渐变、玻璃效果、大阴影或随意圆角。
3. 相同用途的内容在不同页面使用相同组件和布局模式。
4. Light/Dark token 均由 `app/globals.css` 统一控制，不在业务页面写死颜色。
5. 业务请求、鉴权、分页、导航和数据展示行为保持不变。
6. 未被正式路由引用的旧页面实现被清理，避免以后继续复制旧样式。

## 3. 非目标

- 不修改 Backend、Worker、数据库或 API 合约。
- 不重新设计产品信息架构和业务流程。
- 不在本轮引入新的品牌色、图表库或动画系统。
- 不以视觉改造为由重写稳定的数据获取逻辑。
- 不承诺暗色模式入口；只保证现有 token 在 `.dark` 下结构完整。

## 4. 唯一设计源

### 4.1 配置

- `components.json` 保持 `style: "new-york"`。
- `baseColor` 保持 `zinc`。
- 使用 CSS Variables；页面不得绕过 token 写死视觉颜色。
- 全局圆角来源只允许为 `--radius` 及其 shadcn 派生值。

### 4.2 语义颜色

业务页面允许使用：

- `bg-background` / `text-foreground`
- `bg-card` / `text-card-foreground`
- `bg-muted` / `text-muted-foreground`
- `bg-primary` / `text-primary-foreground`
- `bg-secondary` / `text-secondary-foreground`
- `bg-accent` / `text-accent-foreground`
- `bg-destructive` / `text-destructive`
- `border-border`、`border-input`、`ring-ring`

页面不得继续使用 `gray-*`、`blue-*`、`purple-*`、`pink-*`、`green-*`、`orange-*`、`red-*` 等固定视觉色。业务状态必须通过统一 Badge/Alert 变体表达；必要的新状态变体集中定义在公共组件中。

### 4.3 圆角、阴影和动效

- 容器圆角由 `Card`、`Input`、`Button` 等组件默认样式决定。
- 业务页面不得用 `rounded-lg/xl/2xl` 改写普通容器外观。
- 圆形头像、状态点、加载环等语义上必须为圆形的元素可使用 `rounded-full`。
- 删除装饰性 `shadow-md/lg/xl/2xl`；浮层只使用 shadcn 对应组件自带阴影。
- 删除渐变、透明玻璃和悬浮位移效果。
- 交互动效限于 shadcn 默认颜色、边框、透明度和 focus ring 过渡。

## 5. 页面结构规范

所有 App 页面使用同一内容骨架：

1. App Shell：`SidebarProvider`、`AppSidebar`、统一 Header 与 `SidebarTrigger`。
2. Page Header：标题、简短说明、可选右侧主操作。
3. Page Body：按业务需要使用 `Card`、`Table`、Tabs、筛选栏和分页。
4. 状态：加载、空数据、错误和无权限状态使用公共模式。

页面内容区采用一致的宽度、`gap` 和 `padding`。业务页面不再使用 `min-h-screen`、独立全屏背景或自行覆盖 App Shell 背景。

## 6. 公共组件边界

优先复用或补齐以下 `components/ui` 组件：

- `Button`、`Card`、`Badge`、`Avatar`
- `Input`、`Select`、`Textarea`、`Label`
- `Table`、`Separator`、`Skeleton`
- `Alert`、`Dialog`、`DropdownMenu`、`Tooltip`
- `Pagination` 或基于 `Button` 的统一分页组合

只在至少两个页面重复出现且语义稳定时新增业务公共组件，例如：

- `PageHeader`
- `PageState`
- `StatusBadge`
- `DataPagination`

公共组件负责视觉规则；页面负责数据、文案和事件处理。

## 7. 页面迁移范围

| 路由 | 主要收口内容 |
| --- | --- |
| `/login` | 表单、错误提示、背景、Card 与按钮 |
| `/dashboard` | 指标卡、提示卡、趋势区域、时间筛选 |
| `/history` | 双栏布局、任务选择态、媒体预览、参数 Badge、错误状态、分页 |
| `/showcase` | 卡片、媒体占位、作者信息、分页、去除紫粉渐变与悬浮位移 |
| `/showcase/[taskId]` | 视频容器、信息 Card、参数区域、返回操作 |
| `/alerts` | 筛选、状态、列表或表格、空错误状态 |
| `/reconciliation` | 汇总卡、筛选、数据表和异常状态 |
| `/tokens` | 原生输入与选择器替换、状态 Badge、统计 Card、记录表格 |
| `/users` | 用户列表、操作按钮、对话框和状态展示 |

根路由与 App Layout 同步检查，确保没有旧背景和局部布局覆盖。

## 8. 旧实现清理规则

以下文件只有在确认没有 import、路由引用或功能差异后才删除：

- `app/(app)/history/page-old.tsx`
- `app/(app)/history/page-appica.tsx`
- 其他盘点出的纯旧版页面副本

删除前必须以 `rg` 检查引用，并对正式 `page.tsx` 做功能项对照。清理不包含用户截图、测试证据或仓库外资产。

## 9. 实施策略

改造按以下边界推进：

1. 建立可执行的样式约束测试，覆盖禁止的旧视觉模式和允许的语义例外。
2. 收口全局 token 与基础 shadcn/ui 组件。
3. 建立最少必要的公共页面模式组件。
4. 优先迁移 `/history`，作为整站参考实现。
5. 迁移其他 App 页面和详情页。
6. 迁移 `/login` 和根路由。
7. 核对并清理未引用旧实现。
8. 做静态、构建和浏览器逐页验证。

每一步保持 API 与业务状态逻辑不变。若迁移过程中发现功能缺陷，单独记录，不与视觉改造混合修复，除非该缺陷直接阻断页面渲染。

## 10. 测试与验收

### 10.1 自动检查

- 样式约束测试先失败，再由迁移使其通过。
- `npm test`
- `npx tsc --noEmit`
- `npx eslint`，需区分本次引入问题与既有问题。
- `npm run build -- --webpack`
- `git diff --check`

样式约束测试至少检查正式路由文件中：

- 不存在旧渐变和玻璃效果；
- 不存在装饰性大阴影；
- 不存在固定视觉色阶；
- 不存在绕过公共组件的常见原生表单样式；
- 允许 `rounded-full` 等明确语义例外。

### 10.2 浏览器验收

在桌面和窄屏下逐页检查：

- Sidebar 展开与收起；
- 页面标题、间距、边界和背景一致；
- loading、empty、error、disabled、selected、focus 状态；
- 表格横向滚动和长文本；
- `/history` 任务切换、分页、媒体预览和详情；
- `/showcase` 列表、视频预览、详情跳转和分页；
- 表单和对话框的键盘焦点可见。

需要真实数据的页面只有在 Backend/数据库可用时标记为运行时通过；否则只报告静态与构建结果。

## 11. 完成标准

以下条件同时满足才算完成：

1. 所有正式页面采用同一 shadcn/ui New York v4 视觉体系。
2. `/history` 不再包含旧渐变、大阴影、固定色阶和独立圆角体系。
3. 全站正式页面通过样式约束测试。
4. 测试、TypeScript 和生产构建通过。
5. ESLint 没有本次改造新增的问题；既有问题被明确列出或在改造触及文件中一并消除。
6. 未引用的旧页面实现已完成引用核对并清理。
7. 浏览器验收证据与未验证边界分别记录，不以构建成功代替真实数据验收。

## 12. 风险与控制

- **大范围视觉 diff**：按公共基础、参考页、其他页面分批修改和验证。
- **误伤业务逻辑**：页面数据请求与事件处理尽量原样保留，视觉重构与行为变更分离。
- **过度抽象**：公共模式至少出现两次且语义稳定才抽取。
- **误删旧代码**：删除前做引用检查和功能对照，不使用批量破坏性删除。
- **运行时证据不足**：Backend 不可用时明确标记，待服务启动后补真实页面验收。
