# Phase 3 (未来规划): 任务质量评分与智能推荐系统

## 概述

基于任务执行历史数据，构建质量反馈循环和智能推荐系统，帮助用户选择最佳配置，提升成功率，降低成本。

## 核心需求

### 用户故事
作为用户，我想要：
1. 查看任务执行历史（谁+工作流+素材+提示词+生成视频）
2. 对生成的视频进行质量评分
3. 基于历史数据，获得配置推荐（什么组合成功率高）
4. 查看工作流质量分析报告

### 业务价值
- **提升用户体验**：新用户无需trial-and-error，直接使用最佳配置
- **降低成本**：避免失败尝试，减少无效支出
- **数据资产**：积累的质量数据成为核心竞争力
- **用户粘性**：用得越多数据越准确，形成护城河

## 可行性分析

### 现有数据完整性 ✅

从现有schema验证，所需数据完整可用：

**Task表**：
- ✅ 用户身份：`actorId` (通过ActorCredential获取用户名)
- ✅ 工作流信息：`workflowName`, `workflowVersion`, `workflowHash`
- ✅ 提示词：`prompt`
- ✅ 生成视频：`videoUrl`
- ✅ 完整快照：`requestSnapshot`, `executionPlan`
- ✅ 状态追踪：`status`, `taskStatus`, `deliveryStatus`

**Asset表**：
- ✅ 输入图片：`role='input'` + `mediaType='image'`
- ✅ 输入视频：`role='input'` + `mediaType='video'`
- ✅ 素材详情：`objectKey`, `mimeType`, `sizeBytes`, `mediaMetadata`

**ExecutionAttempt表**：
- ✅ 执行细节：`provider`, `model`, 多次尝试记录
- ✅ 费用明细：`estimatedCostCny`, `usageCalculatedCostCny`, `billedCostCny`

**TaskBudgetReservation表**：
- ✅ 最终费用：`settledCny`

### 需要新增的数据表

#### VideoRating（视频质量评分表）

```prisma
model VideoRating {
  id          String   @id @default(uuid()) @db.Uuid
  taskId      String   @map("task_id") @db.Uuid
  task        Task     @relation(fields: [taskId], references: [id], onDelete: Cascade)
  
  // 评分者信息
  ratedBy     String   @map("rated_by")      // actorId
  raterRole   String   @map("rater_role")    // creator(创建者) / reviewer(审核员) / viewer(观看者)
  
  // 评分维度（1-5星）
  overallScore      Int     @map("overall_score")       // 整体质量（必填）
  visualQuality     Int?    @map("visual_quality")      // 视觉质量
  promptAdherence   Int?    @map("prompt_adherence")    // 提示词符合度
  smoothness        Int?    @map("smoothness")          // 流畅度
  creativity        Int?    @map("creativity")          // 创意度
  
  // 文本反馈
  feedback    String?  // 文字评价（可选）
  tags        String[] // 标签：["模糊", "卡顿", "完美", "色彩好"] 等
  
  // 隐私控制
  isPublic    Boolean  @default(false) @map("is_public") // 是否公开到数据集
  
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")
  
  @@unique([taskId, ratedBy]) // 每人每任务只能打一次分
  @@index([taskId])
  @@index([ratedBy])
  @@index([overallScore])
  @@index([createdAt])
  @@map("video_ratings")
}
```

## 功能模块设计

### 模块1: 任务执行历史看板

#### 任务列表视图
展示所有任务的概览：

**表格列**：
- 创建时间
- 用户名
- 工作流名称
- 提示词（前50字）
- 状态（完成/失败/进行中）
- 评分（平均分）
- 费用

**功能**：
- 分页（默认20条/页）
- 过滤：按用户、工作流、状态、日期范围
- 排序：按时间、评分、费用
- 搜索：按提示词关键词搜索

#### 任务详情视图
点击任务行后展开抽屉/弹窗，显示：

**基本信息卡片**：
```
┌─────────────────────────────────┐
│ 任务ID: abc-123                 │
│ 用户: 张三                      │
│ 工作流: text2video v1.2        │
│ 创建: 2026-09-17 14:30         │
│ 完成: 2026-09-17 14:35         │
│ 状态: ✅ 完成                   │
│ 费用: ¥2.50                    │
└─────────────────────────────────┘
```

**输入素材区域**：
- **提示词**：完整文本展示，支持复制
- **参考图片**：缩略图网格，点击查看大图
- **参考视频**：内嵌视频播放器

**输出结果区域**：
- **生成视频**：视频播放器 + 下载按钮
- **评分信息**：当前评分 + 评分详情

**执行历史区域**：
时间线展示多次尝试：
```
Attempt 1: ✅ 完成
  Provider: Volcengine
  Model: doubao-video-pro
  时长: 5分12秒
  费用: ¥2.50

Attempt 0: ❌ 失败
  Provider: Volcengine
  Model: doubao-video-lite
  失败原因: 提示词不符合规范
```

#### API设计

```typescript
// 获取任务历史列表
GET /v1/tasks/history
Query Parameters:
  - page: number (默认1)
  - limit: number (默认20)
  - actorId?: string
  - workflowName?: string
  - status?: 'completed' | 'failed' | 'in_progress'
  - startDate?: string (ISO 8601)
  - endDate?: string (ISO 8601)
  - search?: string (提示词关键词)

Response: {
  tasks: [
    {
      id: string,
      actorId: string,
      actorName: string,
      workflowName: string,
      workflowVersion: string,
      prompt: string,              // 前50字
      promptFull: string,          // 完整提示词
      status: string,
      averageRating: number,       // 平均评分
      ratingCount: number,         // 评分人数
      cost: number,
      createdAt: string,
      completedAt: string,
      hasVideo: boolean,
      hasInputImages: boolean,
      hasInputVideos: boolean
    }
  ],
  total: number,
  page: number,
  limit: number
}

// 获取任务详情（含所有素材和执行历史）
GET /v1/tasks/:taskId/details

Response: {
  task: {
    id: string,
    actorId: string,
    actorName: string,
    workflowName: string,
    workflowVersion: string,
    workflowHash: string,
    prompt: string,
    status: string,
    videoUrl: string,
    createdAt: string,
    completedAt: string,
    cost: number,
    requestSnapshot: object,      // 完整请求快照
    executionPlan: object         // 执行计划
  },
  inputAssets: {
    images: [
      {
        id: string,
        url: string,              // OSS签名URL，有效期1小时
        mimeType: string,
        sizeBytes: number,
        metadata: object
      }
    ],
    videos: [...]
  },
  outputAssets: {
    video: {
      url: string,
      mimeType: string,
      sizeBytes: number,
      metadata: object
    }
  },
  executionAttempts: [
    {
      attemptNo: number,
      provider: string,
      model: string,
      status: string,
      cost: number,
      startedAt: string,
      finishedAt: string,
      duration: number,            // 秒
      failureMessage?: string
    }
  ],
  ratings: {
    averageScore: number,
    count: number,
    myRating?: {
      overallScore: number,
      visualQuality: number,
      promptAdherence: number,
      smoothness: number,
      creativity: number,
      feedback: string,
      tags: string[]
    }
  }
}
```

### 模块2: 视频质量评分

#### 评分界面设计

在任务详情页，视频播放器下方显示评分区域：

```
┌─────────────────────────────────────────┐
│  [视频播放器]                           │
│                                         │
│  对这个视频打分：                       │
│  ─────────────────────────────────────  │
│                                         │
│  整体质量 *                             │
│  ⭐ ⭐ ⭐ ⭐ ☆                          │
│                                         │
│  提示词符合度                           │
│  ⭐ ⭐ ⭐ ⭐ ⭐                          │
│                                         │
│  视觉质量                               │
│  ⭐ ⭐ ⭐ ⭐ ☆                          │
│                                         │
│  流畅度                                 │
│  ⭐ ⭐ ⭐ ⭐ ⭐                          │
│                                         │
│  创意度                                 │
│  ⭐ ⭐ ⭐ ☆ ☆                          │
│                                         │
│  添加标签（可选）：                     │
│  [✓ 高质量] [ 模糊] [ 卡顿]            │
│  [ 色彩鲜艳] [ 转场生硬] [+ 自定义]    │
│                                         │
│  文字评价（可选）：                     │
│  ┌───────────────────────────────────┐  │
│  │                                   │  │
│  └───────────────────────────────────┘  │
│                                         │
│  ☐ 分享到公共数据集（帮助改进推荐）    │
│                                         │
│  [ 提交评分 ]  [ 取消 ]                │
└─────────────────────────────────────────┘
```

#### 评分规则

**评分维度说明**：
- **整体质量** (必填)：综合评价视频质量
  - 1星：完全不可用
  - 2星：质量差，有严重问题
  - 3星：一般，勉强可用
  - 4星：良好，符合预期
  - 5星：优秀，超出预期

- **提示词符合度**：生成内容与提示词的匹配程度
- **视觉质量**：画面清晰度、色彩、光影等
- **流畅度**：动作连贯性、帧率、是否卡顿
- **创意度**：画面构图、创意表现

**评分限制**：
- 每人每任务只能评分一次
- 可以修改自己的评分（在提交后24小时内）
- 评分需要完整观看视频（前端埋点验证）

#### API设计

```typescript
// 提交评分
POST /v1/tasks/:taskId/rating
Body: {
  overallScore: number,          // 必填，1-5
  visualQuality?: number,        // 可选，1-5
  promptAdherence?: number,      // 可选，1-5
  smoothness?: number,           // 可选，1-5
  creativity?: number,           // 可选，1-5
  feedback?: string,             // 可选文字评价，最多500字
  tags?: string[],               // 可选标签
  isPublic?: boolean             // 是否公开，默认false
}

Response: {
  ratingId: string,
  taskId: string,
  averageScore: number,          // 任务的新平均分
  ratingCount: number            // 总评分数
}

// 获取任务的所有评分
GET /v1/tasks/:taskId/ratings
Query Parameters:
  - includePrivate?: boolean     // 是否包含私有评分（仅管理员）

Response: {
  averageScore: number,
  ratingCount: number,
  myRating?: {
    id: string,
    overallScore: number,
    visualQuality: number,
    promptAdherence: number,
    smoothness: number,
    creativity: number,
    feedback: string,
    tags: string[],
    createdAt: string
  },
  publicRatings: [               // 公开的评分
    {
      ratedBy: string,           // 用户名（匿名化）
      overallScore: number,
      feedback: string,
      tags: string[],
      createdAt: string
    }
  ]
}

// 获取我的评分历史
GET /v1/ratings/my-ratings
Query Parameters:
  - page?: number
  - limit?: number

Response: {
  ratings: [
    {
      id: string,
      taskId: string,
      taskPreview: {
        workflowName: string,
        prompt: string,
        videoUrl: string
      },
      overallScore: number,
      createdAt: string
    }
  ],
  total: number
}

// 修改评分（24小时内）
PUT /v1/ratings/:ratingId
Body: { 同POST /v1/tasks/:taskId/rating }

// 删除评分
DELETE /v1/ratings/:ratingId
```

### 模块3: 工作流质量分析看板

#### 概览统计卡片

```
┌────────────────────────────────────────────────┐
│  工作流: text2video                            │
│  ─────────────────────────────────────────────│
│                                                │
│  ┌────────┐  ┌────────┐  ┌────────┐         │
│  │ 1,500  │  │ ⭐3.8  │  │  78%   │         │
│  │ 总任务 │  │ 平均分 │  │ 成功率 │         │
│  └────────┘  └────────┘  └────────┘         │
│                                                │
│  ┌────────┐  ┌────────┐                      │
│  │ ¥2.35  │  │  450   │                      │
│  │ 平均成本│  │ 评分数 │                      │
│  └────────┘  └────────┘                      │
└────────────────────────────────────────────────┘
```

#### 评分分布图表

柱状图展示评分分布：
```
5⭐ ████████░░░░░░░░ 200 (13%)
4⭐ ████████████████ 500 (33%)
3⭐ ████████████░░░░ 400 (27%)
2⭐ ██████░░░░░░░░░░ 250 (17%)
1⭐ ████░░░░░░░░░░░░ 150 (10%)
```

#### 最佳配置排行

展示不同Provider+Model组合的表现：

```
┌─────────────────────────────────────────────────────────┐
│  配置           │ 平均分 │ 成功率 │ 平均成本 │ 样本量  │
├─────────────────────────────────────────────────────────┤
│ Volcengine      │  4.2   │  85%   │  ¥2.50  │  120   │
│ doubao-video-pro│        │        │         │        │
├─────────────────────────────────────────────────────────┤
│ Volcengine      │  3.9   │  80%   │  ¥1.80  │   80   │
│ doubao-video    │        │        │         │        │
├─────────────────────────────────────────────────────────┤
│ Volcengine      │  3.5   │  72%   │  ¥1.20  │   45   │
│ doubao-video-lite│       │        │         │        │
└─────────────────────────────────────────────────────────┘
```

#### 常见问题标签统计

饼图或柱状图展示用户标注的问题：
```
问题标签分布：
模糊      ████████████ 125
卡顿      ██████████░░  98
转场生硬  ████████░░░░  76
色彩暗淡  ████░░░░░░░░  42
```

#### 评分趋势图

折线图展示平均评分随时间的变化：
```
平均评分趋势（按周）
4.5 ┤     ╭─╮
4.0 ┤   ╭─╯ ╰╮
3.5 ┤ ╭─╯    ╰─╮
3.0 ┤─╯        ╰─
    └─────────────
     W1 W2 W3 W4
```

#### API设计

```typescript
// 获取工作流质量报告
GET /v1/analytics/workflow-quality
Query Parameters:
  - workflowName: string
  - startDate?: string
  - endDate?: string

Response: {
  workflowName: string,
  statistics: {
    totalTasks: number,
    averageScore: number,
    successRate: number,
    avgCost: number,
    ratedTaskCount: number,
    ratingCount: number
  },
  scoreDistribution: {
    "5": number,
    "4": number,
    "3": number,
    "2": number,
    "1": number
  },
  topConfigs: [
    {
      provider: string,
      model: string,
      averageScore: number,
      successRate: number,
      avgCost: number,
      sampleCount: number,
      confidence: 'high' | 'medium' | 'low'  // 基于样本量
    }
  ],
  commonIssues: [
    {
      tag: string,
      count: number,
      percentage: number
    }
  ],
  trendData: [
    {
      weekKey: string,          // "2026-W38"
      averageScore: number,
      taskCount: number
    }
  ]
}

// 获取所有工作流的概览
GET /v1/analytics/workflows-overview

Response: {
  workflows: [
    {
      workflowName: string,
      totalTasks: number,
      averageScore: number,
      successRate: number,
      ratingCount: number
    }
  ]
}
```

### 模块4: 智能配置推荐

#### 推荐算法设计

**输入维度**：
1. 工作流名称 (workflowName)
2. 提示词特征：
   - 长度（字符数）
   - 关键词（场景、风格、动作等）
   - 语言（中文/英文）
3. 输入素材情况：
   - 是否有参考图片
   - 是否有参考视频
4. 历史使用偏好（可选）

**推荐策略**：
1. **基于统计的推荐**（Phase 3.1）
   - 按工作流分组
   - 计算各配置的平均评分、成功率
   - 按综合得分排序
   - 综合得分 = 评分 × 0.6 + 成功率 × 0.3 - 归一化成本 × 0.1

2. **基于相似度的推荐**（Phase 3.2）
   - 找到与当前提示词相似的历史任务
   - 提取这些任务的高分配置
   - 提示词相似度计算：
     - 简单版：关键词重叠度
     - 高级版：embedding余弦相似度

3. **个性化推荐**（Phase 3.3，可选）
   - 分析用户历史使用的配置
   - 推荐用户偏好的provider/model
   - 考虑用户预算约束

**置信度计算**：
- 样本量 >= 50：高置信度
- 样本量 20-49：中置信度
- 样本量 < 20：低置信度

#### 推荐界面

在新建任务页面，输入提示词后显示推荐：

```
┌─────────────────────────────────────────────┐
│  新建任务                                   │
│  ─────────────────────────────────────────  │
│  工作流：[text2video ▼]                    │
│  提示词：[一只猫在草地上奔跑...]            │
│                                             │
│  💡 智能推荐（基于234个相似任务）          │
│  ─────────────────────────────────────────  │
│                                             │
│  推荐配置 1：Volcengine + doubao-video-pro │
│  ⭐ 平均评分: 4.2/5.0                      │
│  ✅ 成功率: 85%                            │
│  💰 预计费用: ¥2.50                        │
│  📊 置信度: 高（120个样本）                │
│  [ 使用此配置 ]                            │
│                                             │
│  推荐配置 2：Volcengine + doubao-video     │
│  ⭐ 平均评分: 3.9/5.0                      │
│  ✅ 成功率: 80%                            │
│  💰 预计费用: ¥1.80                        │
│  📊 置信度: 中（80个样本）                 │
│  [ 使用此配置 ]                            │
│                                             │
│  [ 自定义配置 ]                            │
└─────────────────────────────────────────────┘
```

#### API设计

```typescript
// 获取配置推荐
POST /v1/recommendations/best-config
Body: {
  workflowName: string,
  prompt: string,
  hasReferenceImage: boolean,
  hasReferenceVideo: boolean,
  maxCost?: number              // 预算上限（可选）
}

Response: {
  recommendations: [
    {
      provider: string,
      model: string,
      averageScore: number,
      successRate: number,
      avgCost: number,
      sampleCount: number,
      confidence: 'high' | 'medium' | 'low',
      reasoning: string         // 推荐理由："基于120个相似任务的统计..."
    }
  ],
  insights: {
    mostUsedProvider: string,
    bestValueConfig: {          // 性价比最高
      provider: string,
      model: string
    },
    highestRatedConfig: {       // 评分最高
      provider: string,
      model: string
    }
  },
  similarTasks: [               // 参考的相似任务样例
    {
      taskId: string,
      prompt: string,
      score: number,
      config: string
    }
  ]
}

// 获取推荐效果追踪（A/B测试用）
POST /v1/recommendations/track-usage
Body: {
  recommendationSessionId: string,
  selectedConfig: {
    provider: string,
    model: string
  },
  wasRecommended: boolean,
  recommendationRank?: number   // 如果是推荐配置，排第几
}
```

## 风险与挑战

### 1. 冷启动问题
**问题**：初期没有评分数据，无法生成推荐

**解决方案**：
- 基于技术指标推荐（成功率、平均成本）
- 管理员预先标注一批高质量任务作为种子数据
- 鼓励早期用户评分（积分、徽章等激励机制）
- 使用默认推荐（基于provider文档的最佳实践）

### 2. 评分偏差
**问题**：不同用户打分标准不一致

**解决方案**：
- 提供清晰的评分标准说明和示例
- 使用相对评分（比该用户的平均评分高/低）
- 检测并过滤异常评分（远离均值3个标准差）
- 引入评分者权重（活跃用户、专业审核员权重更高）

### 3. 数据稀疏性
**问题**：某些工作流/配置组合样本量少，推荐不可靠

**解决方案**：
- 显示样本量和置信度，让用户知情
- 样本少时降低推荐权重或不推荐
- 使用Exploration vs Exploitation策略（偶尔推荐样本少的配置以获取数据）
- 跨工作流借鉴数据（相似工作流的数据可参考）

### 4. 隐私问题
**问题**：用户可能不想公开评分和任务详情

**解决方案**：
- 默认评分私有，用户可选择公开
- 公开数据匿名化（不显示真实用户名）
- 聚合统计不暴露个人信息
- 敏感提示词不参与推荐（如涉及人物肖像）

### 5. 刷分风险
**问题**：恶意用户刷高分/低分影响推荐准确性

**解决方案**：
- 每人每任务只能评分一次（数据库唯一约束）
- 检测异常评分模式（短时间大量评分、全5星或全1星）
- 要求完整观看视频才能评分（前端埋点验证）
- 管理员审核异常评分，必要时封禁作弊用户

### 6. 提示词相似度计算
**问题**：简单的关键词匹配不准确，embedding需要额外服务

**解决方案**：
- Phase 3.1使用简单的关键词匹配（TF-IDF）
- Phase 3.2引入embedding（使用OpenAI/通义千问API）
- 缓存常见提示词的embedding减少API调用
- 定期批量预计算历史任务的embedding

## 实施计划

### Phase 3.1: 任务历史 + 基础评分（2.5天）

**后端开发（1.5天）**：
- [ ] 添加VideoRating表到schema
- [ ] 创建TaskHistoryService
  - 任务列表查询（分页、过滤）
  - 任务详情查询（含素材、执行历史）
  - OSS签名URL生成
- [ ] 创建RatingService
  - 提交评分
  - 查询评分
  - 评分统计
- [ ] 编写单元测试

**前端开发（1天）**：
- [ ] 创建 `tasks/history` 页面
- [ ] 任务列表表格（TanStack Table）
- [ ] 任务详情抽屉组件
- [ ] 视频/图片查看器组件
- [ ] 评分界面组件
- [ ] 集成API

### Phase 3.2: 质量分析看板（1.5天）

**后端开发（0.5天）**：
- [ ] 创建AnalyticsService
  - 工作流质量统计
  - 评分分布计算
  - 配置排行
  - 趋势数据生成
- [ ] 优化查询性能（添加索引、缓存）

**前端开发（1天）**：
- [ ] 创建 `analytics/quality` 页面
- [ ] 统计卡片组件
- [ ] 评分分布图表（Recharts柱状图）
- [ ] 配置排行表格
- [ ] 问题标签统计（饼图）
- [ ] 评分趋势图（折线图）

### Phase 3.3: 基础推荐系统（2天）

**后端开发（1.5天）**：
- [ ] 创建RecommendationService
  - 基于统计的配置推荐
  - 推荐得分计算
  - 置信度计算
  - 相似任务查找（简单关键词匹配）
- [ ] 推荐效果追踪API
- [ ] 缓存推荐结果（Redis）

**前端开发（0.5天）**：
- [ ] 在新建任务页集成推荐
- [ ] 推荐卡片组件
- [ ] 一键应用推荐配置
- [ ] 推荐效果埋点

### Phase 3.4: 智能推荐（3-5天，可选）

**后端开发（2-3天）**：
- [ ] 引入向量数据库（Qdrant/Milvus）或使用pg_vector
- [ ] 提示词embedding生成
  - 接入embedding API（OpenAI/通义千问）
  - 批量预计算历史任务embedding
  - 定时任务更新embedding
- [ ] 基于语义相似度的推荐
- [ ] 协同过滤算法实现
- [ ] 个性化推荐（基于用户偏好）

**前端开发（1天）**：
- [ ] 增强推荐展示（显示相似任务样例）
- [ ] 推荐解释性（为什么推荐这个配置）
- [ ] A/B测试框架集成

**基础设施（1天）**：
- [ ] 向量数据库部署
- [ ] Embedding API密钥配置
- [ ] 定时任务调度（Cron）

## 时间与资源估算

### 总体时间线

| 阶段 | 内容 | 后端 | 前端 | 总计 |
|-----|------|-----|------|-----|
| Phase 3.1 | 任务历史 + 基础评分 | 1.5天 | 1天 | 2.5天 |
| Phase 3.2 | 质量分析看板 | 0.5天 | 1天 | 1.5天 |
| Phase 3.3 | 基础推荐系统 | 1.5天 | 0.5天 | 2天 |
| Phase 3.4 | 智能推荐（可选） | 2-3天 | 1天 | 4-5天 |
| **总计** | | **5.5-6.5天** | **3.5天** | **10-11天** |

### 建议实施顺序

**方案A：分步实施（推荐）**
1. **Release 1**: Phase 2（消费/Token/对账/预警）- 8天
2. **Release 2**: Phase 3.1 + 3.2（任务历史+评分+分析）- 4天
3. **Release 3**: Phase 3.3（基础推荐）- 2天
4. **Release 4**: Phase 3.4（智能推荐，根据数据量和ROI决定）- 4-5天

**方案B：快速验证**
1. **MVP版本**: Phase 3.1简化版（只做任务历史和基础评分）- 1.5天
2. 观察用户使用情况和评分数据积累速度
3. 根据反馈决定是否继续Phase 3.2-3.4

## 成功指标

### 数据指标
- 评分覆盖率：>30%的已完成任务被评分
- 评分活跃度：每周新增评分 >50条
- 推荐采纳率：>60%的用户使用推荐配置
- 推荐准确率：使用推荐配置的任务平均评分 >4.0

### 业务指标
- 任务成功率提升：+10%
- 用户平均成本降低：-15%
- 新用户首次成功率：>70%（有推荐 vs 无推荐对比）
- 用户留存率提升：+20%

### 用户满意度
- 推荐有用性评分：>4.0/5.0
- 功能使用意愿：>80%用户愿意继续使用
- NPS（净推荐值）：>50

## 技术依赖

### 后端
- Prisma ORM（已有）
- NestJS（已有）
- PostgreSQL（已有）
- Redis（推荐缓存，可选）
- 向量数据库（Phase 3.4需要）
- Embedding API（Phase 3.4需要）

### 前端
- Next.js（已选）
- shadcn/ui（已选）
- TanStack Table（已选）
- Recharts（已选）
- 视频播放器库（video.js / Plyr）

## 未来扩展方向

### 1. 多维度推荐
- 按成本优先推荐（预算敏感用户）
- 按速度优先推荐（时效性需求）
- 按质量优先推荐（质量第一）

### 2. 社区功能
- 用户可分享高分作品
- 优秀提示词模板库
- 用户排行榜（贡献评分数量）

### 3. 自动化评分
- 使用视觉质量检测模型自动打分
- 结合人工评分和AI评分
- 减少人工评分负担

### 4. 实时推荐
- 用户输入提示词时实时给出建议
- 提示词优化建议（"加上XX关键词可能更好"）

### 5. 对比实验
- 支持同一提示词使用不同配置生成
- 并排对比视频质量
- A/B测试工具化

## 附录

### 评分标签参考列表

**质量类**：
- 高质量、优秀、完美
- 清晰、模糊、像素低
- 色彩鲜艳、色彩暗淡、过曝

**流畅度类**：
- 流畅、卡顿、掉帧
- 转场自然、转场生硬
- 动作连贯、动作断裂

**内容类**：
- 符合提示词、偏离主题
- 创意十足、平庸
- 构图好、构图差

**问题类**：
- 畸变、抖动、闪烁
- 物体消失、穿帮
- 逻辑错误

### 数据库索引建议

```sql
-- VideoRating表索引
CREATE INDEX idx_video_ratings_task_id ON video_ratings(task_id);
CREATE INDEX idx_video_ratings_rated_by ON video_ratings(rated_by);
CREATE INDEX idx_video_ratings_overall_score ON video_ratings(overall_score);
CREATE INDEX idx_video_ratings_created_at ON video_ratings(created_at);
CREATE INDEX idx_video_ratings_is_public ON video_ratings(is_public) WHERE is_public = true;

-- Task表索引（推荐查询优化）
CREATE INDEX idx_tasks_workflow_status ON tasks(workflow_name, status);
CREATE INDEX idx_tasks_actor_workflow ON tasks(actor_id, workflow_name);
CREATE INDEX idx_tasks_created_completed ON tasks(created_at, completed_at);

-- 复合索引（评分统计查询优化）
CREATE INDEX idx_ratings_task_score ON video_ratings(task_id, overall_score);
CREATE INDEX idx_tasks_workflow_completed ON tasks(workflow_name, completed_at) WHERE status = 'completed';
```

### 缓存策略

**推荐结果缓存**：
- Key: `recommendation:{workflowName}:{promptHash}`
- TTL: 1小时
- 条件：样本量>50时缓存

**质量统计缓存**：
- Key: `analytics:workflow:{workflowName}`
- TTL: 15分钟
- 条件：统计数据变化不频繁

**配置排行缓存**：
- Key: `ranking:config:{workflowName}`
- TTL: 30分钟
- 条件：每小时更新一次即可

## 总结

这个任务质量评分与智能推荐系统是一个**高价值、可行性强**的功能模块。

**核心优势**：
1. 数据完整，现有schema支持所有需求
2. 分阶段实施，可快速验证价值
3. 形成数据护城河，增强竞争力
4. 直接降低用户成本，提升满意度

**实施建议**：
- 先做Phase 3.1（任务历史+评分），快速启动数据积累
- 根据评分数据量决定Phase 3.2-3.3的优先级
- Phase 3.4（智能推荐）等数据量充足后再评估ROI

预计**10-11天**可完成完整功能（不含智能推荐），**6天**可完成MVP版本。
