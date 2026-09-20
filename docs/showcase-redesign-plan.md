# Showcase 页面重新设计实施计划

## 概述

将 showcase 页面从 `@appica/ui-react` 迁移到 `shadcn/ui`,参考 sweetyshell-map 的设计风格和 shadcn/ui blocks 的布局。

## 一、项目准备阶段

### 1.1 安装和配置 shadcn/ui
- 安装依赖: `tailwindcss`, `@radix-ui/react-*` 等
- 初始化 shadcn/ui: `npx shadcn@latest init`
- 配置 `components.json` 文件
- 更新 `tailwind.config.ts` 添加 shadcn 主题配置

### 1.2 安装需要的 shadcn/ui 组件
```bash
npx shadcn@latest add card
npx shadcn@latest add badge
npx shadcn@latest add button
npx shadcn@latest add separator
npx shadcn@latest add avatar
npx shadcn@latest add skeleton
```

## 二、设计系统定义

### 2.1 色彩系统 (参考 sweetyshell-map)
```css
/* 主题色 - 紫色系 */
--primary: 262 83% 58%        /* #8666d7 */
--primary-foreground: 0 0% 100%

/* 渐变背景 */
radial-gradient(circle at 82% 0%, #eee5ff 0, transparent 28%)
radial-gradient(circle at 30% 5%, #ffedf4 0, transparent 22%)
```

### 2.2 视觉风格特点
- **圆角**: 卡片使用 12-16px 圆角
- **阴影**: 柔和的阴影效果 `shadow-lg` / `shadow-xl`
- **间距**: 宽松的内边距和外边距
- **排版**: 
  - 标题使用大写 + letter-spacing
  - 清晰的信息层次
  - 使用小标签(eyebrow)突出类别

## 三、页面重新设计

### 3.1 Showcase 列表页 (`/showcase/page.tsx`)

**布局结构** (参考 shadcn/ui blocks - Dashboard)
```
┌─────────────────────────────────────────┐
│  Header Section                         │
│  - Eyebrow (小标签)                      │
│  - Title + Description                  │
│  - Stats (展示总数等)                    │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│  Filter Bar (可选)                      │
│  - 按工作流筛选                          │
│  - 按创建者筛选                          │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│  Masonry Grid (瀑布流)                  │
│  ┌──────┐ ┌──────┐ ┌──────┐            │
│  │Card 1│ │Card 2│ │Card 3│            │
│  │      │ │      │ │      │            │
│  └──────┘ └──────┘ └──────┘            │
│  ┌──────┐ ┌──────┐ ┌──────┐            │
│  │Card 4│ │Card 5│ │Card 6│            │
│  └──────┘ └──────┘ └──────┘            │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│  Pagination                             │
└─────────────────────────────────────────┘
```

**Card 设计** (参考 sweetyshell-map 的卡片风格)
```tsx
<Card className="group overflow-hidden border-purple-100 hover:border-purple-300 hover:shadow-xl transition-all duration-300">
  {/* Video Thumbnail */}
  <div className="relative aspect-video bg-gradient-to-br from-purple-50 to-pink-50">
    <video />
    <Badge className="absolute bottom-2 right-2">5s</Badge>
  </div>
  
  {/* Card Content */}
  <CardHeader>
    {/* Creator Info */}
    <div className="flex items-center gap-2 mb-3">
      <Avatar />
      <span className="text-sm font-medium">Creator Name</span>
      <Badge variant="outline" className="ml-auto text-xs">
        文生视频
      </Badge>
    </div>
    
    {/* Prompt Preview */}
    <CardTitle className="text-base line-clamp-2 leading-snug">
      Prompt text here...
    </CardTitle>
    
    {/* Metadata */}
    <div className="flex gap-2 mt-3 text-xs text-muted-foreground">
      <span>Kling 1.6</span>
      <Separator orientation="vertical" />
      <span>1920x1080</span>
      <Separator orientation="vertical" />
      <span>16:9</span>
    </div>
  </CardHeader>
</Card>
```

### 3.2 Showcase 详情页 (`/showcase/[taskId]/page.tsx`)

**布局结构** (参考 sweetyshell-map 工单页 + shadcn/ui blocks)
