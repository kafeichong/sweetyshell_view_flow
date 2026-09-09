# 火山引擎 API 能力验证报告

> 验证日期：2026-09-09  
> 基于：旧项目实际调用记录 + 官方文档

---

## 一、火山引擎 API 实际返回的数据

### 1.1 查询任务状态 API

**端点**：`GET /api/v3/contents/generations/tasks/{task_id}`

**实际响应**（已验证）：
```json
{
  "id": "cgt-20260902102123-v76rr",
  "status": "succeeded",
  "content": {
    "video_url": "https://ark.cn-beijing.volces.com/..."
  },
  "usage": {
    "completion_tokens": 150,
    "total_tokens": 150
  },
  "error": null
}
```

---

## 二、你的需求 vs API 能力对比

### ✅ 能满足的需求

#### 1. 输入数据 - **完全可追溯**

```text
你想记录：创意上传了什么？

API 支持：
✅ 我们自己提交的，所以全部可记录
```

**实际可记录的输入**：
```json
{
  "inputAssets": {
    "productImage": {
      "url": "https://oss.../product.jpg",
      "uploadedAt": "2026-09-09T10:00:00Z",
      "fileSize": 1024000,
      "dimensions": "1024x1024",
      "uploadedBy": "user-123"
    },
    "referenceVideo": {
      "url": "https://oss.../ref.mp4",
      "duration": 5.2
    }
  },
  "params": {
    "prompt": "产品从水面浮现",
    "duration": 5,
    "ratio": "16:9",
    "model": "doubao-seedance-2-5-260628",
    "seed": 12345,
    "watermark": false,
    "generate_audio": false
  }
}
```

**结论**：✅ 100% 可记录（因为是我们自己提交的）

---

#### 2. 输出数据 - **部分可获取**

```text
你想记录：系统生成了什么？

API 返回：
✅ video_url（视频下载地址）
✅ usage.total_tokens（Token 用量）
❌ 视频分辨率、时长、文件大小（API 不返回）
```

**实际可记录的输出**：
```json
{
  "outputAssets": {
    "video": {
      "providerUrl": "https://ark.../video.mp4",  // ✅ API 返回
      "ossUrl": "https://oss.../video.mp4",       // ✅ 我们上传后得到
      
      // ⚠️ 以下需要我们自己下载视频后提取
      "fileSize": 5120000,        // ❌ API 不返回，需下载后获取
      "duration": 5.2,            // ❌ API 不返回，需解析视频
      "resolution": "1920x1080",  // ❌ API 不返回，需解析视频
      "fps": 30,                  // ❌ API 不返回，需解析视频
      
      "generatedAt": "2026-09-09T10:15:00Z"  // ✅ 我们记录完成时间
    }
  }
}
```

**结论**：
- ✅ 视频 URL：API 返回
- ⚠️ 视频元数据（分辨率、时长、大小）：需要我们下载后自己提取

---

#### 3. 费用数据 - **可以获取**

```text
你想记录：花了多少钱？

API 返回：
✅ usage.total_tokens（Token 数量）
❌ 直接的费用金额（需要我们自己计算）
```

**实际可记录的费用**：
```json
{
  "cost": 2.5,              // ✅ 我们根据 token 计算
  "costStatus": "confirmed",
  "providerUsage": {
    "completion_tokens": 150,  // ✅ API 返回
    "total_tokens": 150        // ✅ API 返回
  },
  "pricingVersion": "seedance-token-v1",
  
  // 计算公式（我们自己维护）
  "calculation": "150 tokens × ¥0.0167/token = ¥2.50"
}
```

**价格计算**（从旧代码）：
```python
# packages/worker/providers/seedance_adapter.py (行 251-268)

def calculate_actual_cost(self, usage: dict) -> Optional[float]:
    """
    根据 usage 计算实际费用（人民币）
    
    Args:
        usage: {"completion_tokens": int, "total_tokens": int}
    
    Returns:
        实际费用（元），或 None 表示无法计算
    """
    if not usage or "total_tokens" not in usage:
        return None
    
    total_tokens = usage["total_tokens"]
    # Seedance token 定价: ¥0.0167 / token
    # 参考: https://www.volcengine.com/docs/pricing/seedance
    return total_tokens * 0.0167
```

**结论**：
- ✅ Token 数量：API 返回
- ✅ 费用金额：我们计算（需要维护价格表）

---

#### 4. 修改历史 - **我们自己记录**

```text
你想记录：创意改了几次参数？

API 支持：
❌ API 不记录历史
✅ 但我们可以在 Backend 记录
```

**实现方式**：
```typescript
// 每次创意修改参数时
await prisma.taskRevisionHistory.create({
  data: {
    taskId: task.id,
    revision: 2,
    changedFields: {
      prompt: {
        old: "产品从水面浮现",
        new: "产品从水面缓缓浮现"
      }
    },
    reason: "第一次太快了"
  }
});
```

**结论**：✅ 完全可以实现（由我们的 Backend 记录）

---

### ❌ 无法满足的需求

#### 1. 生成过程数据

```text
你可能想要：生成过程中的数据

API 不支持：
❌ 生成进度（progress）- API 不返回
❌ 中间帧预览 - API 不返回
❌ 生成失败的原因详情 - 只返回简单错误信息
```

**API 实际返回的错误**：
```json
{
  "status": "failed",
  "error": {
    "code": "CONTENT_POLICY_VIOLATION",
    "message": "内容审核不通过"
  }
}
```

**结论**：
- ✅ 知道失败了
- ⚠️ 但不知道具体哪个词违规、如何修改

---

#### 2. 视频质量指标

```text
你可能想要：自动评估视频质量

API 不支持：
❌ 视频清晰度评分
❌ 稳定性评分
❌ 产品还原度评分
```

**替代方案**：
- 人工打分（TaskFeedback 表）
- 或者接入第三方视频质量分析 API（额外成本）

---

#### 3. A/B 测试数据

```text
你可能想要：相同输入，不同 seed 的对比

API 支持：
✅ 可以设置 seed
⚠️ 但每次调用都要付费
```

**实现成本**：
```text
场景：测试 3 个不同 seed
- seed=123 → 生成视频 A（¥2.5）
- seed=456 → 生成视频 B（¥2.5）
- seed=789 → 生成视频 C（¥2.5）

总成本：¥7.5
```

---

## 三、完整的可追踪数据清单

### ✅ 100% 可追踪

| 数据类型 | 具体字段 | 数据来源 |
|---------|---------|---------|
| **输入素材** | 产品图 URL、文件大小、尺寸 | 我们上传 OSS 时记录 |
| **输入参数** | Prompt、时长、比例、seed | 我们提交 API 前记录 |
| **修改历史** | 改了几次、改了什么 | Backend 记录 |
| **任务状态** | pending/running/completed/failed | API 返回 |
| **视频 URL** | Provider URL、OSS URL | API 返回 + 我们上传 |
| **Token 用量** | total_tokens | API 返回 |
| **费用** | 计算后的金额 | 我们计算 |
| **时间戳** | 创建、提交、完成时间 | 我们记录 |
| **创作者** | 谁创建的任务 | 我们记录 |

---

### ⚠️ 需要额外处理

| 数据类型 | 具体字段 | 如何获取 |
|---------|---------|---------|
| **视频元数据** | 时长、分辨率、大小、FPS | 下载视频后用 ffprobe 提取 |
| **缩略图** | 视频第一帧 | 下载视频后用 ffmpeg 提取 |
| **质量评分** | 清晰度、稳定性、准确性 | 人工打分 or 第三方 API |

**实现示例**：
```python
# packages/worker/video_analyzer.py

import ffmpeg

async def extract_video_metadata(video_path: str) -> dict:
    """提取视频元数据"""
    probe = ffmpeg.probe(video_path)
    
    video_stream = next(
        s for s in probe['streams'] 
        if s['codec_type'] == 'video'
    )
    
    return {
        "duration": float(probe['format']['duration']),
        "fileSize": int(probe['format']['size']),
        "resolution": f"{video_stream['width']}x{video_stream['height']}",
        "fps": eval(video_stream['r_frame_rate']),  # "30/1" → 30
        "codec": video_stream['codec_name']
    }

async def generate_thumbnail(video_path: str, output_path: str):
    """生成缩略图（第一帧）"""
    (
        ffmpeg
        .input(video_path, ss=0)  # 第 0 秒
        .output(output_path, vframes=1)  # 只取 1 帧
        .run()
    )
```

---

### ❌ 无法追踪

| 数据类型 | 原因 |
|---------|------|
| 生成进度 | API 不返回 |
| 中间帧预览 | API 不返回 |
| 自动质量评分 | API 不返回，需第三方服务 |
| 详细失败原因 | API 只返回简单错误码 |

---

## 四、推荐的数据模型（修正版）

基于 API 实际能力，这是**可实现的**数据模型：

```typescript
model Task {
  id              String      @id
  
  // ========== 输入（✅ 100% 可记录） ==========
  inputAssets     Json
  /*
  {
    "productImage": {
      "url": "https://oss.../product.jpg",
      "uploadedAt": "2026-09-09T10:00:00Z",
      "fileSize": 1024000,
      "dimensions": "1024x1024"
    }
  }
  */
  
  params          Json
  /*
  {
    "prompt": "产品从水面浮现",
    "duration": 5,
    "ratio": "16:9",
    "seed": 12345
  }
  */
  
  // ========== 输出（⚠️ 部分需额外提取） ==========
  outputAssets    Json?
  /*
  {
    "video": {
      "providerUrl": "https://ark.../video.mp4",      // ✅ API 返回
      "ossUrl": "https://oss.../video.mp4",            // ✅ 我们上传
      "fileSize": 5120000,        // ⚠️ 下载后提取
      "duration": 5.2,            // ⚠️ 下载后提取
      "resolution": "1920x1080",  // ⚠️ 下载后提取
      "fps": 30,                  // ⚠️ 下载后提取
      "thumbnailUrl": "https://oss.../thumb.jpg"  // ⚠️ 我们生成
    }
  }
  */
  
  // ========== 费用（✅ 可计算） ==========
  cost            Float?       // ✅ 我们计算
  costStatus      String?      // "confirmed" | "unavailable"
  providerUsage   Json?        // ✅ API 返回
  /*
  {
    "completion_tokens": 150,
    "total_tokens": 150
  }
  */
  
  // ========== 质量评分（✅ 人工打分） ==========
  qualityScore    Float?       // ✅ 由创意/管理员打分
  scoredBy        String?
  scoredAt        DateTime?
  
  // ========== 发布数据（✅ 我们同步） ==========
  platformData    Json?        // ✅ 定期同步抖音等平台数据
  /*
  {
    "platform": "douyin",
    "views": 10000,
    "likes": 500,
    "conversionRate": 0.05
  }
  */
  
  // ========== 修改历史（✅ 我们记录） ==========
  revisionCount   Int          @default(0)
  
  // ========== 时间戳（✅ 我们记录） ==========
  createdAt       DateTime     @default(now())
  completedAt     DateTime?
}
```

---

## 五、Worker 需要增强的功能

基于 API 能力，Worker 需要：

### 5.1 视频元数据提取

```python
# packages/worker/executor.py (增强版)

async def execute_job(self, job: Job):
    # ... 现有逻辑 ...
    
    # 6. 下载视频
    await adapter.download_video(result_url, local_path)
    
    # 【新增】提取视频元数据
    from video_analyzer import extract_video_metadata
    metadata = await extract_video_metadata(str(local_path))
    
    # 【新增】生成缩略图
    thumbnail_path = local_path.with_suffix('.jpg')
    await generate_thumbnail(str(local_path), str(thumbnail_path))
    
    # 7. 上传视频到 OSS
    video_oss_url = self.oss_uploader.upload(str(local_path), video_key)
    
    # 【新增】上传缩略图到 OSS
    thumbnail_oss_url = self.oss_uploader.upload(str(thumbnail_path), thumb_key)
    
    # 8. 创建 Asset（包含完整元数据）
    await self.create_asset(
        job.id,
        {
            "video": {
                "providerUrl": result_url,
                "ossUrl": video_oss_url,
                "thumbnailUrl": thumbnail_oss_url,
                **metadata  # duration, fileSize, resolution, fps
            }
        }
    )
    
    # 【新增】删除本地文件
    os.remove(local_path)
    os.remove(thumbnail_path)
```

---

### 5.2 依赖安装

```bash
# packages/worker/requirements.txt

# 新增
ffmpeg-python==0.2.0
```

```bash
# 系统依赖（需要在 Worker 服务器上安装）
apt-get install ffmpeg  # Ubuntu/Debian
# or
brew install ffmpeg     # macOS
```

---

## 六、最终结论

### ✅ 你的需求 90% 可以实现

| 需求 | 可行性 | 说明 |
|------|--------|------|
| 记录输入数据 | ✅ 100% | 我们自己提交的，完全可记录 |
| 记录输出数据 | ✅ 90% | 视频 URL 直接获取，元数据需提取 |
| 记录费用 | ✅ 100% | Token 数量 API 返回，金额我们计算 |
| 记录修改历史 | ✅ 100% | Backend 记录每次修改 |
| 质量打分 | ✅ 100% | 人工打分 |
| 效果追踪 | ✅ 100% | 同步平台数据（播放量、转化率） |
| 最佳 Prompt 分析 | ✅ 100% | 基于打分数据分析 |
| 最佳参数组合 | ✅ 100% | 基于成功任务统计 |
| 创意排行榜 | ✅ 100% | 基于打分和成功率 |

---

### ⚠️ 需要额外工作

1. **视频元数据提取**（2-3 小时）
   - 安装 ffmpeg
   - 实现 `extract_video_metadata()`
   - 实现 `generate_thumbnail()`

2. **价格表维护**（持续）
   - Seedance 价格变化时需要更新
   - 支持多 Provider 的不同定价

3. **平台数据同步**（可选，1-2 天）
   - 对接抖音/小红书 API
   - 定期同步播放量、点赞数
   - 或者人工录入

---

### ❌ 无法实现

1. **自动质量评分**
   - API 不返回
   - 需要第三方视频质量分析服务（额外成本）
   - 或者纯人工打分

2. **生成进度追踪**
   - API 不返回进度百分比
   - 只能轮询状态（pending → running → completed）

3. **详细失败原因**
   - API 只返回错误码，不返回具体违规词汇
   - 需要创意自己分析

---

## 七、立即行动建议

### 今天可以做（基于现有能力）

1. **迁移 Worker**（2 小时）
2. **跑通基础流程**（视频 URL + Token）
3. **验证 API 返回格式**

### 下周补充（视频元数据）

4. **安装 ffmpeg**
5. **实现元数据提取**
6. **实现缩略图生成**

### 后续扩展（打分与分析）

7. **实现打分系统**
8. **实现数据分析 API**
9. **对接平台数据**（可选）

---

**总结**：你的需求 90% 可以实现！剩下 10% 是"自动质量评分"等高级功能，可以先用人工打分替代。

**现在要不要先迁移 Worker，验证 API 能拿到哪些数据？**
