# MVP 开发计划（6-8 周）

> 制定日期：2026-09-09  
> 项目：AI 创意生产工作流平台  
> 目标：创意人员能够稳定使用系统完成生产

---

## 总体目标

> 一个普通创意人员能够在共享电脑上独立完成一次真实 AI 视频生产。

**核心链路**：
```text
产品图 → ComfyUI → Scene Image → Image Review ✅ → First Frame → 
Video → Asset 注册 → AI Studio 可查询
```

**第一批实现的 4 个 Workflow**：
1. Text → Image
2. Product Image → Scene Image
3. Image → Video
4. First Frame → Video

---

## 时间规划总览

| 阶段 | 周数 | 核心目标 | 关键里程碑 |
|------|------|---------|-----------|
| **Week 1-2** | 2 周 | 解决 P0 阻塞 | ComfyUI Runtime 正常 + dry-run 契约明确 |
| **Week 3-4** | 2 周 | 跑通完整链路 | 端到端链路验证通过 |
| **Week 5-6** | 2 周 | 完善可靠性 | Worker 重启不重复提交 + quarantine 持久化 |
| **Week 7-8** | 1-2 周 | 用户验收 | 创意人员独立完成生产 |

**总计：6-8 周**

---

## Week 1-2：解决 P0 阻塞

### 目标
恢复 ComfyUI Runtime + 确定 dry-run 输出契约

### 任务清单

#### Day 1-2：恢复 ComfyUI Runtime
- [ ] 启动本机 ComfyUI Runtime
  ```bash
  cd /path/to/ComfyUI
  python main.py --listen 127.0.0.1 --port 8188
  ```
- [ ] 验证服务正常
  ```bash
  curl http://127.0.0.1:8188/system_stats
  # 期待返回：{"devices": [...], "system": {...}}
  ```
- [ ] 安装必需的 ComfyUI 插件
  ```bash
  cd ComfyUI/custom_nodes
  git clone [seedance-plugin-repo]
  # 重启 ComfyUI
  ```

#### Day 3-4：确认节点注册状态
- [ ] 运行只读检查脚本
  ```bash
  cd /Users/steven/mylab/video_works
  ./scripts/check-comfyui-runtime.sh
  ```
- [ ] 验证必需节点已注册
  ```text
  SeedanceArkExecutionPolicy
  SeedanceArkPromptBuilder
  SeedanceArkPreviewSaveVideo
  SeedanceArkCreateTask
  SeedanceArkWaitTask
  SeedanceArkDownloadVideo
  SeedanceArkMediaInput
  SeedanceArkMediaValidator
  SeedanceArkUploadImage
  SeedanceArkUploadVideo
  ```
- [ ] 如有缺失，安装对应插件并重启

#### Day 5-7：确定 dry-run 输出契约
- [ ] 与 ComfyUI 节点开发方对齐输出格式
- [ ] 选择方案并文档化：
  - **方案 A**：dry-run 生成本地占位文件（推荐）
    ```text
    /output/preview/{timestamp}/placeholder.mp4
    + metadata.json
    ```
  - **方案 B**：dry-run 不产生文件，只验证参数
    ```text
    返回：{"status": "validated", "params": {...}}
    ```
- [ ] 更新 Worker 代码以支持选定方案
- [ ] 编写测试验证

#### Day 8-10：检查真实 Workflow
- [ ] 加载 Seedance 2.5 First Frame Workflow
  ```bash
  # 在 ComfyUI UI 中导入
  /Users/steven/mylab/video_works/workflows/seedance-2.5-first-last-frame-v1.comfy.json
  ```
- [ ] 手动执行 Preview（不触发付费 API）
- [ ] 确认：
  - [ ] Workflow 可以正常加载
  - [ ] 所有节点都能识别
  - [ ] 执行策略 = preview
  - [ ] confirm_live_submission = false
  - [ ] 输出路径符合预期

### 验收标准

#### ✅ P0.1：Runtime 健康检查通过
```bash
curl http://127.0.0.1:8188/system_stats
# HTTP 200, 返回系统信息
```

#### ✅ P0.2：必需节点全部注册
```bash
curl http://127.0.0.1:8188/object_info | jq 'keys'
# 包含所有 Seedance 节点类型
```

#### ✅ P0.3：Workflow 可以加载
在 ComfyUI UI 中成功导入 Workflow，无错误提示

#### ✅ P0.4：Dry-run 输出契约已明确
文档化的契约规范 + Worker 代码已适配

---

## Week 3-4：跑通完整链路

### 目标
ComfyUI → Worker → AI Studio 端到端验证

### 任务清单

#### Day 11-13：迁移 Worker 核心代码
- [ ] 创建新项目 Worker 目录
  ```bash
  mkdir -p /Users/steven/works/20260909video_flow/packages/worker
  ```
- [ ] 复制旧项目 Worker 代码
  ```bash
  cp -r /Users/steven/mylab/video_works/packages/worker/* \
        /Users/steven/works/20260909video_flow/packages/worker/
  ```
- [ ] 安装依赖
  ```bash
  cd /Users/steven/works/20260909video_flow/packages/worker
  python -m venv venv
  source venv/bin/activate
  pip install -r requirements.txt
  ```
- [ ] 运行测试验证
  ```bash
  pytest tests/ -v
  # 期待：67 项测试全部通过
  ```

#### Day 14-16：搭建新 Backend
- [ ] 设计新数据模型（Prisma Schema）
  ```prisma
  model Project {
    id        String    @id @default(uuid())
    name      String
    campaigns Campaign[]
  }
  
  model Campaign {
    id        String    @id @default(uuid())
    name      String
    projectId String
    project   Project   @relation(fields: [projectId], references: [id])
    tasks     Task[]
  }
  
  model Task {
    id              String      @id @default(uuid())
    campaignId      String
    campaign        Campaign    @relation(fields: [campaignId], references: [id])
    workflowId      String
    status          TaskStatus
    providerTaskId  String?
    promptId        String?
    assets          Asset[]
  }
  
  enum TaskStatus {
    DRAFT
    READY
    PREVIEWING
    PREVIEW_COMPLETED
    AWAITING_REVIEW
    APPROVED
    REJECTED
    PRODUCTION_RUNNING
    COMPLETED
    FAILED
  }
  
  model WorkflowLibrary {
    id          String    @id
    name        String
    category    String    // L1, L2, L3, L4
    version     String
    inputSchema Json
    outputSchema Json
  }
  ```
- [ ] 运行数据库迁移
  ```bash
  cd packages/backend
  pnpm prisma migrate dev --name init_mvp
  ```
- [ ] 实现核心 API
  ```typescript
  POST   /api/tasks                    # 创建任务
  GET    /api/tasks?status=pending     # 查询任务
  GET    /api/tasks/:id                # 任务详情
  PATCH  /api/tasks/:id                # 更新状态
  POST   /api/tasks/:id/review         # Image Review ✅
  POST   /api/assets                   # 创建资产
  GET    /api/assets?taskId=:id        # 查询资产
  ```

#### Day 17-19：Worker 接入完整链路
- [ ] 更新 Worker 的 Backend URL
  ```bash
  # packages/worker/.env
  BACKEND_URL=http://localhost:3000
  ```
- [ ] 适配新的数据模型（Job → Task）
  ```python
  # executor.py
  async def fetch_pending_tasks():  # 改名
      response = await self.client.get(
          f"{self.backend_url}/api/tasks",  # 改路径
          params={"status": "pending"}
      )
      return [Task(**task) for task in data.get("tasks", [])]
  ```
- [ ] 实现 Asset 自动注册
  ```python
  async def register_asset(self, task_id, output_path):
      asset_data = {
          "taskId": task_id,
          "type": "video",
          "filePath": str(output_path),
          "provider": job.providerProfile,
          "model": job.params.get("model"),
          "cost": self._extract_cost(result),
      }
      response = await self.client.post(
          f"{self.backend_url}/api/assets",
          json=asset_data
      )
  ```
- [ ] 完成 Output Type Mapping
  ```python
  def _map_output_type(self, output_path: Path) -> str:
      suffix = output_path.suffix.lower()
      mapping = {
          ".mp4": "video",
          ".webm": "video",
          ".png": "image",
          ".jpg": "image",
          ".jpeg": "image",
      }
      return mapping.get(suffix, "unknown")
  ```

#### Day 20-22：跑通 Image → Video
- [ ] 准备测试素材
  ```bash
  mkdir -p /Users/steven/works/20260909video_flow/test_assets
  # 放入一张产品图
  ```
- [ ] 在 ComfyUI UI 中导入 Workflow
  ```text
  workflows/seedance-2.5-first-last-frame-v1.comfy.json
  ```
- [ ] 手动执行 Preview
- [ ] 启动 Backend + Worker
  ```bash
  # Terminal 1
  cd packages/backend
  pnpm dev
  
  # Terminal 2
  cd packages/worker
  source venv/bin/activate
  python main.py
  ```
- [ ] 通过 API 创建任务
  ```bash
  curl -X POST http://localhost:3000/api/tasks \
    -H "Content-Type: application/json" \
    -d '{
      "workflowId": "seedance-2.5-first-frame",
      "params": {
        "prompt": "产品从水面浮现",
        "firstFramePath": "/path/to/product.jpg",
        "duration": 5
      }
    }'
  # 返回 task_id
  ```
- [ ] 观察 Worker 日志
  ```text
  [Worker] Fetched 1 pending task
  [Worker] Executing task {task_id}
  [Worker] Submitting to ComfyUI...
  [Worker] prompt_id: {prompt_id}
  [Worker] Polling status...
  [Worker] Task completed
  [Worker] Downloading output...
  [Worker] Registering asset...
  [Worker] Task {task_id} completed
  ```
- [ ] 验证结果
  ```bash
  curl http://localhost:3000/api/tasks/{task_id}
  # status: "completed"
  # assets: [{ type: "video", filePath: "..." }]
  ```

#### Day 23：记录真实费用
- [ ] 从 Provider 响应中提取费用
  ```python
  def _extract_cost(self, provider_result):
      if "usage" in provider_result:
          return {
              "status": "confirmed",
              "amount": provider_result["usage"]["total_tokens"],
              "currency": "token"
          }
      else:
          return {
              "status": "unavailable",
              "amount": None
          }
  ```
- [ ] 保存到 Task 记录
  ```typescript
  // Backend
  await prisma.task.update({
    where: { id: taskId },
    data: {
      cost: cost,
      costStatus: cost.status
    }
  })
  ```

### 验收标准

#### ✅ P1.1：Worker 测试全部通过
```bash
cd packages/worker
pytest tests/ -v
# 67/67 tests passed
```

#### ✅ P1.2：Backend API 正常
```bash
curl http://localhost:3000/api/tasks
# HTTP 200, 返回任务列表
```

#### ✅ P1.3：端到端链路跑通
```text
POST /api/tasks → Worker 拉取 → ComfyUI 执行 → 
输出下载 → Asset 注册 → GET /api/tasks/:id 可查询
```

#### ✅ P1.4：Asset 自动注册成功
```bash
curl http://localhost:3000/api/assets?taskId={id}
# 返回生成的视频资产记录
```

#### ✅ P1.5：费用记录完整
Task 记录包含 `cost` 字段，状态为 `confirmed` 或 `unavailable`

---

## Week 5-6：完善可靠性

### 目标
Worker 重启不重复提交 + quarantine 持久化

### 任务清单

#### Day 24-26：补齐 Required Nodes 检查
- [ ] 定义完整的节点清单
  ```python
  # comfyui_workflow.py
  _REQUIRED_NODE_TYPES_2_5 = {
      "SeedanceArkExecutionPolicy",
      "SeedanceArkMediaInput",
      "SeedanceArkMediaValidator",
      "SeedanceArkUploadImage",
      "SeedanceArkUploadVideo",
      "SeedanceArkReferenceEditRequestBuilder",
      "SeedanceArkReferenceEditCreateTask",
      "SeedanceArkWaitTask",
      "SeedanceArkDownloadVideo",
      "SeedanceArkPreviewSaveVideo",
  }
  ```
- [ ] 在 Worker 启动时检查
  ```python
  async def startup_check(self):
      object_info = await self.comfyui_client.object_info()
      registered_nodes = set(object_info.keys())
      
      missing = _REQUIRED_NODE_TYPES_2_5 - registered_nodes
      if missing:
          raise RuntimeError(f"Missing ComfyUI nodes: {missing}")
      
      print(f"✅ All required nodes registered: {len(registered_nodes)}")
  ```
- [ ] 编写测试验证

#### Day 27-29：持久化 prompt_id
- [ ] 设计持久化方案
  ```typescript
  // Backend: Task 模型已有 promptId 字段
  model Task {
    promptId  String?  @unique
  }
  ```
- [ ] Worker 提交前检查
  ```python
  async def execute_task(self, task):
      # 检查是否已有 prompt_id
      if task.promptId:
          print(f"Task {task.id} already has promptId={task.promptId}, query only")
          return await self._poll_existing_prompt(task.promptId)
      
      # 提交新任务
      prompt_id = await self.comfyui_executor.execute_workflow(...)
      
      # 立即持久化 prompt_id
      await self.update_task_prompt_id(task.id, prompt_id)
      
      return await self._poll_until_complete(prompt_id)
  ```
- [ ] 测试重启场景
  ```bash
  # 1. 启动 Worker，提交任务
  # 2. Worker 提交后立即 Ctrl+C
  # 3. 重启 Worker
  # 4. 验证：不会重复提交，只查询状态
  ```

#### Day 30-32：持久化 quarantine 状态
- [ ] 设计 quarantine 表
  ```prisma
  model QuarantineRecord {
    id            String    @id @default(uuid())
    taskId        String    @unique
    task          Task      @relation(fields: [taskId], references: [id])
    reason        String
    errorMessage  String?
    quarantinedAt DateTime  @default(now())
    resolvedAt    DateTime?
    resolvedBy    String?
  }
  ```
- [ ] Worker 失败时写入
  ```python
  async def quarantine_task(self, task_id, reason, error_message):
      await self.client.post(
          f"{self.backend_url}/api/quarantine",
          json={
              "taskId": task_id,
              "reason": reason,
              "errorMessage": error_message
          }
      )
      print(f"Task {task_id} quarantined: {reason}")
  ```
- [ ] Worker 启动时加载
  ```python
  async def load_quarantine_list(self):
      response = await self.client.get(
          f"{self.backend_url}/api/quarantine?resolved=false"
      )
      self._quarantined_task_ids = {
          record["taskId"] for record in response.json()
      }
      print(f"Loaded {len(self._quarantined_task_ids)} quarantined tasks")
  ```
- [ ] 实现人工解除
  ```typescript
  // Backend API
  POST /api/quarantine/:id/resolve
  {
    "resolvedBy": "admin_user_id",
    "action": "retry" | "cancel"
  }
  ```

#### Day 33-35：完成幂等验证
- [ ] 编写幂等测试
  ```python
  # tests/test_idempotency.py
  async def test_duplicate_submission_prevented():
      task = Task(id="test-1", promptId="prompt-123")
      
      # 第一次执行：应该只查询
      result1 = await executor.execute_task(task)
      
      # 验证：没有调用 POST /prompt
      assert mock_comfyui.post_called == False
      assert mock_comfyui.get_called == True  # 只查询
      
  async def test_worker_restart_recovery():
      # 模拟：任务已提交但 Worker 重启
      task = Task(id="test-2", status="submitted", promptId="prompt-456")
      
      # Worker 重启后恢复
      executor = JobExecutor()
      await executor.startup_check()
      
      inflight = await executor.fetch_inflight_tasks()
      assert len(inflight) == 1
      
      # 应该继续轮询，不重复提交
      await executor.execute_task(inflight[0])
      assert mock_comfyui.post_called == False
  ```
- [ ] 运行压力测试
  ```bash
  # 连续重启 Worker 10 次，验证无重复提交
  for i in {1..10}; do
    python main.py &
    PID=$!
    sleep 5
    kill $PID
    sleep 2
  done
  
  # 检查数据库：每个 Task 只有一个 promptId
  ```

### 验收标准

#### ✅ P2.1：Required Nodes 检查完整
Worker 启动时自动检查，缺失节点则报错退出

#### ✅ P2.2：prompt_id 已持久化
```sql
SELECT id, promptId FROM tasks WHERE promptId IS NOT NULL;
-- 所有已提交任务都有 promptId
```

#### ✅ P2.3：Quarantine 已持久化
```sql
SELECT COUNT(*) FROM quarantine_records WHERE resolvedAt IS NULL;
-- Worker 重启后仍能识别 quarantined 任务
```

#### ✅ P2.4：幂等测试通过
```bash
pytest tests/test_idempotency.py -v
# 所有幂等测试通过
```

#### ✅ P2.5：Worker 重启恢复正常
```text
1. 提交任务 A（status=pending）
2. Worker 拉取并提交到 ComfyUI（status=submitted, promptId=xxx）
3. 强制 kill Worker
4. 重启 Worker
5. Worker 恢复任务 A，继续轮询 promptId=xxx
6. 任务 A 正常完成，无重复提交
```

---

## Week 7-8：用户验收

### 目标
创意人员独立完成生产

### 任务清单

#### Day 36-38：编写用户文档
- [ ] 创意人员使用说明
  ```markdown
  # AI 创意生产平台使用指南
  
  ## 1. 准备工作
  - 准备产品图（PNG/JPG，建议 1024x1024）
  - 明确视频需求（时长、风格、运动方式）
  
  ## 2. 选择 Workflow
  打开 ComfyUI（http://127.0.0.1:8188）
  加载 Workflow：产品图 → Scene Image
  
  ## 3. 上传素材
  - 点击"Load Image"节点
  - 选择产品图
  
  ## 4. 修改 Prompt
  - 找到"Prompt"节点
  - 输入：产品从水面缓缓浮现，水花飞溅，柔和光线
  
  ## 5. 设置参数
  - 时长：5 秒
  - 比例：16:9
  - 模型：Seedance 2.5
  
  ## 6. Preview
  - 点击"Queue Prompt"（Preview 模式）
  - 等待生成（约 30 秒）
  - 查看预览图
  
  ## 7. 人工审核
  - 检查构图、产品准确性、光影
  - 如不满意，修改 Prompt 重新 Preview
  - 满意后进入下一步
  
  ## 8. 锁定 First Frame
  - 保存预览图为 First Frame
  - 加载 Workflow：First Frame → Video
  
  ## 9. Production
  - 切换到 Production 模式
  - 确认费用预估
  - 点击"Queue Prompt"（Production 模式）
  - 等待生成（约 2-5 分钟）
  
  ## 10. 查看结果
  打开 AI Studio（http://localhost:3001）
  - 任务列表 → 找到刚才的任务
  - 查看生成的视频
  - 下载视频文件
  
  ## 11. 追溯信息
  在 AI Studio 中可以看到：
  - Workflow：First Frame → Video
  - Provider：Seedance 2.5
  - Prompt：[完整 Prompt]
  - 输入素材：product.jpg
  - 输出资产：video_xxx.mp4
  - 费用：XX tokens
  ```

- [ ] 故障排查手册
  ```markdown
  # 常见问题
  
  ## Q1：ComfyUI 无法访问
  检查：http://127.0.0.1:8188/system_stats
  解决：联系技术人员重启 ComfyUI
  
  ## Q2：Workflow 加载失败
  检查：节点是否全部显示绿色
  解决：缺失节点需要安装插件
  
  ## Q3：Preview 一直卡住
  检查：Worker 是否运行（http://localhost:8001/health）
  解决：联系技术人员检查 Worker 日志
  
  ## Q4：视频生成失败
  检查：AI Studio 任务状态
  可能原因：
  - 内容审核不通过（修改 Prompt）
  - API 限流（等待 5 分钟重试）
  - 参数错误（检查时长、比例）
  
  ## Q5：找不到生成的视频
  检查：AI Studio → 任务详情 → 资产列表
  解决：如果 Asset 为空，联系技术人员
  ```

#### Day 39-41：使用真实素材测试
- [ ] 准备 5 组真实产品素材
  ```text
  产品 A：化妆品瓶（50ml）
  产品 B：手机壳
  产品 C：运动鞋
  产品 D：咖啡杯
  产品 E：书籍封面
  ```
- [ ] 对每个产品执行完整流程
  ```text
  1. Product Image → Scene Image (Preview)
  2. Image Review（自己审核）
  3. Scene Image → First Frame
  4. First Frame → Video (Production)
  5. 验证 Asset 注册
  ```
- [ ] 记录每次执行的数据
  ```csv
  产品,Workflow,Preview时长,Production时长,费用,是否成功
  化妆品瓶,Image→Video,32s,2m15s,150 tokens,✅
  手机壳,Image→Video,28s,2m08s,140 tokens,✅
  运动鞋,First Frame→Video,35s,2m30s,160 tokens,✅
  咖啡杯,Image→Video,30s,Failed,0,❌ 内容审核
  书籍封面,Image→Video,33s,2m20s,155 tokens,✅
  ```
- [ ] 验证追溯能力
  ```bash
  # 对于成功的任务，能否追溯到：
  - Workflow ID 和 Version
  - Provider 和 Model
  - 完整 Prompt
  - 输入素材路径
  - 输出资产路径
  - 实际费用
  ```

#### Day 42-44：邀请非研发人员测试
- [ ] 选择 1-2 名创意人员
- [ ] 进行 30 分钟培训
  - 演示完整流程
  - 讲解 Workflow 选择
  - 说明 Preview vs Production
- [ ] 独立执行
  - 给他们真实任务：为新品生成 3 个视频
  - 不提供技术支持（除非系统故障）
  - 观察他们的操作流程
- [ ] 收集反馈
  ```text
  易用性：
  - Workflow 选择是否清晰？
  - Prompt 编写是否困难？
  - Preview 结果是否满意？
  
  困惑点：
  - 哪些步骤不清楚？
  - 哪些错误提示看不懂？
  - 哪些操作需要重复多次？
  
  期望功能：
  - 希望增加什么功能？
  - 哪些流程可以简化？
  ```
- [ ] 根据反馈改进
  - 优化 UI 提示文案
  - 补充使用文档
  - 简化操作步骤

#### Day 45：完成 MVP 验收
按照新文档 15.1-15.7 标准验收：

**15.1 Runtime**
- [x] ComfyUI Runtime 正常启动
- [x] Worker 可进行 Runtime Check
- [x] Required Nodes 校验通过
- [x] Workflow 可正常加载

**15.2 Workflow**
- [x] Text → Video（已验证）
- [x] Image → Video（已验证）
- [x] Text → Image（已完成）
- [x] Product Image → Scene Image（已完成）

**15.3 Preview**
- [x] Preview 可以独立执行
- [x] Preview 不会触发正式付费调用
- [x] Preview 输出类型明确
- [x] Preview 可以被创意人员查看

**15.4 Production**
- [x] 必须显式确认
- [x] 可以调用真实 Provider
- [x] 能获得真实输出
- [x] 能获得实际费用或显示 unavailable

**15.5 Output**
- [x] 输出 video / image
- [x] 输出 sidecar metadata
- [x] stable output directory

**15.6 Asset**
- [x] 自动登记 output file
- [x] 记录 task
- [x] 记录 workflow
- [x] 记录 provider
- [x] 记录 model
- [x] 记录 parameters
- [x] 记录 cost

**15.7 Reliability**
- [x] Worker 重启后不会重复提交
- [x] 已存在 prompt_id 时只查询
- [x] 异常任务可以进入 quarantine
- [x] quarantine 状态可持久化
- [x] 支持人工处理

### 验收标准

#### ✅ P3.1：用户文档完整
- 使用说明覆盖完整流程
- 故障排查手册包含常见问题
- 文档语言面向非技术人员

#### ✅ P3.2：真实素材测试通过
- 5 组产品素材全部测试
- 至少 4 组成功生成视频
- 追溯信息完整

#### ✅ P3.3：非研发人员能够独立操作
- 培训后能够独立完成生产
- 无需技术支持（除系统故障）
- 反馈收集完整

#### ✅ P3.4：MVP 验收标准全部满足
15.1-15.7 所有条目都打勾

---

## 关键里程碑

| 里程碑 | 日期 | 标志 |
|--------|------|------|
| **M1: ComfyUI Runtime 正常** | Week 2 结束 | curl 127.0.0.1:8188 返回正常 |
| **M2: 端到端链路跑通** | Week 4 结束 | 产品图 → 视频 → Asset 全链路成功 |
| **M3: Worker 重启不重复提交** | Week 6 结束 | 幂等测试全部通过 |
| **M4: 创意人员独立完成生产** | Week 8 结束 | 非研发人员独立生成 3 个视频 |

---

## 风险与应对

### 风险 1：ComfyUI Runtime 无法恢复
**概率**：中  
**影响**：高  
**应对**：
- 备选方案：使用 Docker 容器运行 ComfyUI
- 提前准备：安装脚本、插件清单

### 风险 2：Dry-run 契约无法统一
**概率**：中  
**影响**：中  
**应对**：
- 优先方案 A（生成占位文件）
- 如果方案 A 不可行，立即切换方案 B

### 风险 3：Seedance API 不稳定
**概率**：低  
**影响**：高  
**应对**：
- 准备降级方案（先测 MiniMax）
- 记录每次调用的完整日志
- 预留手动干预接口

### 风险 4：创意人员学习成本高
**概率**：中  
**影响**：中  
**应对**：
- 提供详细的图文教程
- 录制操作视频
- 安排多次培训

### 风险 5：范围蔓延
**概率**：高  
**影响**：高  
**应对**：
- **严格按照 MVP 范围**
- 新需求放入 Backlog
- 优先级评审

---

## 资源需求

### 人力
- **后端开发**：1 人（Backend API + 数据模型）
- **Python 开发**：1 人（Worker 适配 + 测试）
- **前端开发**：0.5 人（简单 Dashboard）
- **测试**：0.5 人（端到端测试）
- **创意人员**：2 人（用户验收）

### 环境
- **开发环境**：MacBook Pro（本机）
- **ComfyUI 机器**：共享创作机（127.0.0.1:8188）
- **数据库**：PostgreSQL（Docker）
- **OSS**：阿里云 OSS

### 成本
- **开发成本**：6-8 周人力
- **API 成本**：Seedance 测试费用（预估 ¥500）
- **服务器成本**：本地开发，¥0

---

## 成功标准

只有以下条件**全部满足**，才认为 MVP 完成：

### ✅ 核心链路稳定
```text
产品图 → ComfyUI → Scene Image → Image Review → 
First Frame → Video → Asset → AI Studio 可查询
```

### ✅ 追溯能力完整
半年以后看到一个视频，能够回答：
- 是谁生成的？
- 用什么 Workflow？
- 用了哪个模型？
- 用了什么 Prompt？
- 输入素材是什么？
- 参数是什么？
- 花了多少钱？

### ✅ 创意人员能够独立操作
非研发人员经过培训后，能够独立完成：
- 选择 Workflow
- 上传素材
- 修改 Prompt
- Preview 并审核
- Production 生成
- 查看结果

### ✅ 系统稳定可靠
- Worker 重启不重复提交
- 异常任务进入 quarantine
- 失败可以恢复或人工处理
- 日志完整可追溯

---

## 下一阶段规划（Phase 2）

MVP 完成后，优先级排序：

1. **多 Provider 支持**（MiniMax、Kling）
2. **Storyboard 生成**（AI Planning）
3. **Workflow Library 管理**（UI 化管理）
4. **Project / Campaign 管理**
5. **高级报表**（成本分析、效率统计）
6. **权限管理**（多角色、审批流）

---

## 附录：检查清单

### 每周检查
- [ ] 本周任务全部完成
- [ ] 里程碑达成
- [ ] 无技术债务积压
- [ ] 代码已提交并通过测试

### 每日站会
- 昨天完成了什么？
- 今天计划做什么？
- 有什么阻塞？

### 风险评审（每周五）
- 本周遇到了什么风险？
- 应对措施是否有效？
- 是否需要调整计划？

---

**记住：核心目标只有一个**

> 先证明创意人员真的可以稳定地使用这套系统完成生产。

不要被功能清单迷惑，不要范围蔓延，只做 MVP 必需的事情。
