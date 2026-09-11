# 迁移 vs 重写：决策分析

> 决策时间：2026-09-09  
> 核心问题：是迁移旧代码，还是基于论证重新写？

---

## 一、两个方案对比

### 方案 A：迁移旧代码

```text
操作：
1. 复制 /Users/steven/mylab/video_works/ 到新目录
2. 删除不需要的部分
3. 修复问题（CORS、路径等）
4. 部署

优点：
✅ 快速（2-3天）
✅ 代码已跑通（风险低）
✅ 创意立即能用
✅ 边用边优化

缺点：
❌ 可能有技术债
❌ 可能有冗余代码
❌ 架构可能不是最优
❌ 后续维护可能麻烦
```

---

### 方案 B：重新写

```text
操作：
1. 按照 11 篇文档设计搭建
2. 参考旧代码实现关键逻辑（Worker）
3. Backend/Web 重新写
4. 部署

优点：
✅ 架构清晰（按设计文档）
✅ 代码干净（无技术债）
✅ 易于维护
✅ 学习深入

缺点：
❌ 慢（2-3周）
❌ 风险高（未知问题多）
❌ 创意要等
❌ 可能重复犯错
```

---

## 二、关键考量因素

### 1. 旧代码质量评估

让我检查旧代码的实际质量：

**Backend 代码**：
```typescript
// packages/backend/src/main.ts
✅ 结构清晰
✅ 使用 NestJS 标准模式
✅ Prisma ORM
⚠️ CORS 配置需要改
⚠️ 可能有些功能不需要
```

**Worker 代码**：
```python
# packages/worker/executor.py
✅ 已实现火山引擎 API 调用
✅ 已实现 OSS 上传
✅ 已实现任务轮询
⚠️ 路径硬编码需要改
⚠️ ComfyUI 相关代码可以删除
```

**数据模型**：
```prisma
// packages/backend/prisma/schema.prisma
✅ 设计合理（Job, ProviderProfile, Asset）
⚠️ 可能有些字段不需要
```

**评分**：70 分

---

### 2. 你的 11 篇文档设计

**文档质量**：
```text
✅ 需求分析完整
✅ 架构设计详细
✅ 数据模型清晰
✅ 文件去重方案完善
✅ 性能优化考虑周全

评分：95 分（设计很好）
```

**但问题是**：
```text
❌ 文档是"完整系统"的设计
❌ MVP 不需要这么复杂
❌ 11 个表太多了
❌ 很多功能现在不需要
```

---

### 3. 时间紧迫度

**你的需求**：
> "让创意人员先快速跑起来能用"

**时间对比**：
```text
方案 A（迁移）：3天
方案 B（重写）：2-3周

差距：6-8 倍
```

---

### 4. 技术债权衡

**旧代码的技术债**（预估）：
```text
🔴 严重问题：0个
🟡 中等问题：3个（CORS、硬编码、端口）
🟢 小问题：5个（冗余代码、注释不全）

修复成本：2-3小时
```

**重写的风险**：
```text
🔴 严重风险：
- 可能遇到未知问题（调试 1-2周）
- 可能重复犯旧代码已解决的错误
- 可能实现不完整

⚠️ 中等风险：
- 时间超预期
- 创意人员等太久
```

---

## 三、我的建议（混合方案）⭐⭐⭐⭐⭐

### 方案 C：渐进式重构

```text
阶段 1（现在 - Week 1）：迁移核心
├── 迁移 Worker（100%复用，只改路径）
├── 迁移 Backend API（简化，删冗余）
├── 简化数据模型（4个表 → 2个表）
└── 快速部署

阶段 2（Week 2-4）：边用边优化
├── 创意使用，收集反馈
├── 识别真正需要的功能
├── 逐步重构不好的部分
└── 记录技术债

阶段 3（Month 2-3）：参考文档完善
├── 根据实际使用情况
├── 参考 11 篇文档
├── 逐步实现高级功能（文件去重、数据分析等）
└── 重构有问题的模块
```

---

### 为什么推荐混合方案？

#### 1. 符合敏捷开发原则

```text
"先跑起来，再迭代优化"

❌ 错误做法：
等所有功能都完美 → 3个月后上线 → 发现需求变了

✅ 正确做法：
快速上线简化版 → 收集反馈 → 针对性优化
```

---

#### 2. 降低风险

```text
方案 A（纯迁移）：
- 风险：可能背一堆技术债 ❌

方案 B（纯重写）：
- 风险：时间长，未知问题多 ❌

方案 C（混合）：
- 风险：最低，灵活调整 ✅
```

---

#### 3. 保护已有价值

```text
旧代码的价值：
✅ Worker 已跑通火山引擎 API（核心价值）
✅ OSS 上传已实现
✅ 任务轮询机制已验证

这些不需要重写！
```

---

#### 4. 利用文档价值

```text
11 篇文档的价值：
✅ 作为"北极星"（目标架构）
✅ 作为重构指南
✅ 作为扩展参考

但不是现在立即实现！
```

---

## 四、具体实施计划（方案 C）

### Phase 1：快速迁移（3天）

#### Day 1：核心代码迁移

```bash
# 1. 创建新项目结构
mkdir -p /Users/steven/works/20260909video_flow/{packages,docs,scripts}

# 2. 迁移 Worker（100% 复用）
cp -r /Users/steven/mylab/video_works/packages/worker \
      /Users/steven/works/20260909video_flow/packages/

# 3. 简化 Backend
# 只迁移核心文件：
# - src/main.ts
# - src/app.module.ts
# - src/jobs/ （任务模块）
# - prisma/schema.prisma（简化到 2 个表）

# 4. 删除不需要的
# - Web（暂时不要，直接用 API）
# - ComfyUI 相关代码
# - 多余的模块
```

---

#### Day 2：修复和测试

```bash
# 1. 修复问题
# - CORS 配置
# - 硬编码路径
# - 端口号

# 2. 简化数据模型
# 从 4 个表 → 2 个表：
# - Task（任务）
# - Config（配置）

# 3. 本地测试
docker compose up -d
# 测试创建任务、查询任务
```

---

#### Day 3：部署

```bash
# 1. 创建 Dockerfile
# 2. 创建 docker-compose.yml
# 3. 上传服务器
# 4. 启动服务
# 5. 让创意试用
```

---

### Phase 2：迭代优化（Week 2-4）

```text
根据创意反馈，优先级排序：

P0（必须）：
- 任务失败重试
- 视频下载功能

P1（重要）：
- 简单的 Web 界面
- 任务列表查询

P2（可选）：
- 费用统计
- 任务历史
```

---

### Phase 3：参考文档完善（Month 2-3）

```text
根据实际使用情况，逐步实现 11 篇文档中的功能：

Month 2：
- 文件去重（如果素材多了）
- 素材库管理

Month 3：
- 数据追踪分析
- 质量打分
- Workflow 管理
```

---

## 五、数据模型简化对比

### 文档设计（11个表）

```prisma
✗ User
✗ MediaLibrary
✗ Task
✗ TaskMediaReference
✗ TaskRevisionHistory
✗ TaskFeedback
✗ WorkflowLibrary
✗ WorkflowPerformance
✗ ProviderProfile
✗ ProviderCostLog
✗ Config
```

**问题**：太复杂，现在不需要

---

### 旧代码（4个表）

```prisma
✓ ProviderProfile
✓ Job
✓ Asset
✓ Workflow
✗ User（暂时不需要）
```

**问题**：有些字段不需要

---

### MVP 版本（2个表）⭐推荐

```prisma
model Task {
  id          String   @id @default(uuid())
  
  // 输入
  createdBy   String   // "张三"
  prompt      String
  imageUrl    String?
  
  // 输出
  videoUrl    String?
  
  // 状态
  status      String   // pending/running/completed/failed
  errorMsg    String?
  
  // 费用
  cost        Float?
  
  // 时间
  createdAt   DateTime @default(now())
  completedAt DateTime?
}

model Config {
  id                  String @id @default("default")
  volcengineApiKey    String
  ossAccessKeyId      String
  ossAccessKeySecret  String
}
```

**优点**：
- ✅ 够用
- ✅ 简单
- ✅ 易于理解
- ✅ 后续可扩展

---

## 六、最终建议

### 🎯 推荐方案 C（混合方案）

**执行顺序**：

```text
Week 1：迁移 + 简化
├── 复用 Worker（核心价值）
├── 简化 Backend（2个表）
├── 删除冗余功能
└── 快速部署

Week 2-4：迭代
├── 创意使用
├── 收集反馈
├── 针对性优化
└── 小步重构

Month 2-3：完善
├── 参考 11 篇文档
├── 逐步实现高级功能
└── 重构有问题的部分
```

---

### 📊 对比总结

| 维度 | 方案A（纯迁移） | 方案B（纯重写） | 方案C（混合）⭐ |
|------|----------------|----------------|----------------|
| 时间 | 3天 | 2-3周 | 3天上线 + 渐进优化 |
| 风险 | 中（技术债） | 高（未知问题） | 低（灵活调整） |
| 代码质量 | 60分 | 95分 | 70分 → 90分 |
| 创意体验 | 快速可用 | 等待时间长 | 快速可用 + 持续改进 |
| 维护成本 | 中（有技术债） | 低（新代码） | 低（逐步重构） |
| 利用旧代码 | 100% | 0% | 核心部分（Worker） |
| 利用文档 | 0% | 100% | 渐进式应用 |

---

## 七、立即行动

### 如果选择方案 C，我现在帮你：

1. ✅ 迁移核心代码（Worker 全部 + Backend 简化）
2. ✅ 简化数据模型（2个表）
3. ✅ 修复已知问题（CORS、路径）
4. ✅ 创建 Dockerfile
5. ✅ 创建 docker-compose.yml
6. ✅ 写部署脚本

**3天内让创意能用！**

---

**你的决定？**
- A: 纯迁移（最快，但有技术债）
- B: 纯重写（最慢，但代码最干净）
- C: 混合方案（平衡，我推荐）⭐
