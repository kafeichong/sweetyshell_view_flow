# MVP 版本 - 快速跑起来方案

> 核心原则：先跑起来，让创意人员能用，别过度设计

---

## 一、MVP 的核心目标

### 唯一目标：创意人员能用 ComfyUI 生成视频

```text
创意人员的基本流程：
1. 打开 ComfyUI
2. 上传产品图
3. 输入 Prompt
4. 点击生成
5. 看到视频
6. 下载视频

就这么简单！
```

---

## 二、砍掉的"过度设计"

### ❌ 不需要（MVP 阶段）

| 功能 | 为什么不需要 | 什么时候加 |
|------|------------|-----------|
| **文件哈希去重** | 前期文件少，重复少 | 1-2 个月后，素材多了再加 |
| **素材库管理** | 创意直接从本地选文件就行 | 素材多到难找时再加 |
| **后台管理系统** | 你自己能直接看数据库 | 需要给老板看数据时再加 |
| **用户权限管理** | 就几个创意，信任他们 | 团队扩大到 10+ 人再加 |
| **费用统计分析** | 前期看数据库就行 | 老板要控制成本时再加 |
| **质量打分系统** | 前期口头反馈就够 | 需要优化 Workflow 时再加 |
| **审批流程** | 前期直接生成就好 | 开始花大钱时再加 |
| **Workflow 版本管理** | 前期就一个版本 | Workflow 稳定后再加 |
| **数据追踪分析** | 前期数据少，没必要 | 积累 1000+ 任务后再分析 |
| **OSS 自动上传** | 本地存储就行 | 存储空间不够时再加 |

---

## 三、MVP 最小架构

### 3.1 真正需要的组件

```text
核心三件套：
1. ComfyUI（已有）
2. Worker（已有，迁移旧代码）
3. 简单的 Backend（只做任务记录）
```

**就这三个！**

---

### 3.2 数据模型（极简版）

```prisma
// 只要 2 个表！

// 1. 任务表
model Task {
  id              String      @id @default(uuid())
  
  // 谁创建的（手动输入名字就行）
  createdBy       String      // "张三"
  
  // 输入
  prompt          String
  imageUrl        String?     // 产品图的 URL（先用本地文件路径）
  
  // 输出
  videoUrl        String?     // 生成的视频路径
  
  // 状态
  status          String      // pending, running, completed, failed
  
  // 时间
  createdAt       DateTime    @default(now())
  completedAt     DateTime?
}

// 2. Provider 配置（就一条记录）
model Config {
  id              String      @id @default("default")
  
  seedanceApiKey  String
  ossAccessKey    String?     // 可选，后面再用
  ossSecret       String?
  
  updatedAt       DateTime    @updatedAt
}
```

**就这 2 个表！**

---

### 3.3 API（极简版）

```typescript
// 只要 3 个 API！

// 1. 创建任务
POST /api/tasks
{
  "createdBy": "张三",
  "prompt": "产品从水面浮现",
  "imageUrl": "/path/to/product.jpg"  // 本地文件路径
}

// 2. 查询任务
GET /api/tasks/:id

// 3. 列出所有任务
GET /api/tasks
```

**就这 3 个 API！**

---

## 四、MVP 工作流程（实际的）

### 方案 A：最简单版（推荐）

```text
1. 创意在自己电脑运行 ComfyUI Desktop
2. 本地选择产品图文件
3. 输入 Prompt
4. ComfyUI 调用火山引擎 API（你的 API Key）
5. 生成完成后，视频保存在创意电脑本地
6. 创意手动拖到共享文件夹（或者不管）

完全不需要后端！
```

**优点**：
- ✅ 最快（今天就能跑）
- ✅ 不需要开发后端
- ✅ 不需要 OSS
- ✅ 创意直接能用

**缺点**：
- ❌ 没有任务记录
- ❌ 无法追踪费用
- ❌ 视频散落在各处

**适用时机**：
- 前 1-2 周，验证流程
- 积累初步经验

---

### 方案 B：加个记录系统（平衡）

```text
1. 创意在 ComfyUI 操作（同方案 A）
2. ComfyUI 自定义节点调用你的 Backend
   POST /api/tasks { createdBy, prompt, imageUrl }
3. Backend 记录到数据库
4. Worker 监听数据库，调用火山引擎
5. 视频生成完成，保存到服务器某个目录
6. 创意从共享目录下载

需要简单的后端
```

**优点**：
- ✅ 有任务记录
- ✅ 可以追踪费用
- ✅ 视频集中存储

**缺点**：
- ⚠️ 需要开发简单后端（1-2 天）

**适用时机**：
- 第 2-4 周，开始正式使用

---

### 方案 C：完整流程（后期）

```text
方案 B + OSS + 后台管理 + 其他功能
```

**时机**：1-2 个月后

---

## 五、推荐的实施路线

### Week 1：验证可行性（方案 A）

**目标**：创意能用 ComfyUI 生成视频

**步骤**：
```bash
1. 在创意电脑上安装 ComfyUI Desktop
2. 安装火山引擎插件（如果有）
3. 配置你的 API Key
4. 导入一个简单 Workflow
5. 测试：产品图 → 视频

时间：1 天
```

**验收标准**：
- ✅ 创意能自己生成视频
- ✅ 视频质量可接受
- ✅ 能调整 Prompt 参数

**这一周完全不需要写代码！**

---

### Week 2-3：加个记录系统（方案 B）

**目标**：知道谁生成了什么，花了多少钱

**步骤**：
```bash
1. 搭建简单 Backend（NestJS）
   - 2 个表（Task, Config）
   - 3 个 API（create, get, list）

2. 迁移 Worker 代码
   - 复制旧代码
   - 改 API 端点
   - 跑通测试

3. ComfyUI 自定义节点（可选）
   - 调用 Backend API
   - 或者手动在后台创建任务

时间：3-5 天
```

**验收标准**：
- ✅ 数据库有任务记录
- ✅ 能看到每个任务的费用
- ✅ 能看到所有生成的视频

---

### Week 4-6：优化体验

**按需添加**：
- 需要啥加啥
- 不需要就不加

**可能的优化**：
```text
- 创意反馈：生成太慢 → 加个状态通知
- 你的反馈：不知道花了多少钱 → 加个费用统计页面
- 老板反馈：视频找不到 → 加个搜索功能
- 创意反馈：同样的图片总是上传 → 加文件去重
```

---

### Month 2-3：扩展功能

**根据实际使用情况决定**：
```text
问题：素材太多，难找
→ 加素材库管理

问题：不知道哪个 Prompt 效果好
→ 加打分系统

问题：费用太高
→ 加审批流程

问题：创意越来越多
→ 加权限管理
```

---

## 六、对比：你之前的设计 vs MVP

### 你之前考虑的功能

| 功能 | MVP 需要吗 | 什么时候加 |
|------|-----------|-----------|
| 文件哈希去重 | ❌ | Month 2（素材多时） |
| MediaLibrary 表 | ❌ | Month 2 |
| TaskMediaReference 表 | ❌ | Month 2 |
| TaskRevisionHistory 表 | ❌ | Month 3（需要分析时） |
| TaskFeedback 表 | ❌ | Month 2（需要优化时） |
| WorkflowPerformance 表 | ❌ | Month 3 |
| User 表 | ❌ | Month 2（团队扩大时） |
| 后台管理 UI | ❌ | Week 3-4（简单版） |
| 数据分析 | ❌ | Month 3 |
| 审批流程 | ❌ | 需要时再说 |

**MVP 只需要**：
- ✅ Task 表
- ✅ Config 表（1 条记录）
- ✅ 3 个 API

---

## 七、实际代码（MVP 版）

### 7.1 Backend（极简版）

```typescript
// src/tasks/tasks.controller.ts

@Controller('tasks')
export class TasksController {
  constructor(private prisma: PrismaService) {}
  
  // 1. 创建任务
  @Post()
  async create(@Body() dto: CreateTaskDto) {
    return this.prisma.task.create({
      data: {
        createdBy: dto.createdBy,
        prompt: dto.prompt,
        imageUrl: dto.imageUrl,
        status: 'pending'
      }
    });
  }
  
  // 2. 查询任务
  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.prisma.task.findUnique({ where: { id } });
  }
  
  // 3. 列出所有任务
  @Get()
  async findAll() {
    return this.prisma.task.findMany({
      orderBy: { createdAt: 'desc' }
    });
  }
  
  // 4. 更新状态（Worker 用）
  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateTaskDto) {
    return this.prisma.task.update({
      where: { id },
      data: dto
    });
  }
}
```

**就这 50 行代码！**

---

### 7.2 Worker（复用旧代码）

```python
# 直接复制旧代码
cp -r /Users/steven/mylab/video_works/packages/worker/* \
      /Users/steven/works/20260909video_flow/packages/worker/

# 改 2 个地方：
# 1. API 端点：/api/jobs → /api/tasks
# 2. 字段名：job → task

# 其他完全不变
```

---

### 7.3 前端（可选，或者直接用 curl）

```bash
# 手动创建任务（测试用）
curl -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "createdBy": "张三",
    "prompt": "产品从水面浮现",
    "imageUrl": "/path/to/product.jpg"
  }'

# 查询任务
curl http://localhost:3000/api/tasks/task-123

# 列出所有任务
curl http://localhost:3000/api/tasks
```

---

## 八、MVP 时间线（实际的）

### Day 1：验证 ComfyUI

```text
上午：
- 安装 ComfyUI Desktop（创意电脑）
- 配置火山引擎 API Key

下午：
- 导入 Workflow
- 测试生成一个视频

晚上：
- 让创意试用，收集反馈

交付物：创意能用 ComfyUI 生成视频
```

---

### Day 2-3：搭建 Backend

```text
Day 2：
- 初始化 NestJS 项目
- 设计 2 个表（Task, Config）
- 实现 4 个 API

Day 3：
- 迁移 Worker 代码
- 改 API 端点
- 跑通端到端测试

交付物：任务能自动执行并记录
```

---

### Day 4-5：优化体验

```text
- 添加简单的状态查询页面
- 添加费用统计（SQL 查询就行）
- 让创意试用，收集反馈

交付物：基本能用的系统
```

---

### Week 2-4：根据反馈迭代

```text
- 创意说什么不方便，就优化什么
- 不要提前猜测需求
- 一次解决一个问题
```

---

## 九、关键建议

### ✅ 应该做的

1. **快速验证**
   - Week 1 就让创意能用
   - 别等所有功能都做完

2. **从最简单的开始**
   - 先 2 个表，后面再加
   - 先 3 个 API，后面再扩展

3. **复用旧代码**
   - Worker 直接复制
   - 改 API 端点就行

4. **根据反馈迭代**
   - 别猜测需求
   - 用户说需要才加

---

### ❌ 不应该做的

1. **过度设计**
   - ❌ 10 个表（MVP 只要 2 个）
   - ❌ 完整的权限系统
   - ❌ 复杂的数据分析

2. **提前优化**
   - ❌ 文件去重（前期文件少）
   - ❌ 性能优化（前期用户少）
   - ❌ 高可用部署（前期可以挂）

3. **完美主义**
   - ❌ 等所有功能都完美再上线
   - ❌ 纠结技术选型
   - ❌ 过度抽象

---

## 十、总结

### MVP 的本质

```text
不是"做一个小版本的完整系统"
而是"做能解决核心问题的最小东西"

核心问题：创意需要生成视频
最小方案：ComfyUI + 火山引擎 API

其他都是锦上添花
```

---

### 你之前的设计

```text
11 篇文档，12 万字，11 个数据表...

适合：完整的生产系统（3-6 个月后）
不适合：MVP（现在）
```

---

### MVP 的设计

```text
2 个表，3 个 API，50 行代码

适合：现在（Week 1-2）
目标：让创意能用起来
```

---

### 推荐路线

```text
Week 1: ComfyUI + 手动操作（0 行代码）
Week 2-3: 加 Backend + Worker（200 行代码）
Week 4+: 根据反馈迭代

Month 2-3: 逐步加功能（参考之前的 11 篇文档）
```

---

**你觉得这个思路如何？先用最简单的方式跑起来，让创意能用，然后再慢慢完善？**
