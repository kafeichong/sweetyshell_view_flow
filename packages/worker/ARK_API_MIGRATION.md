# 火山方舟 Ark API 迁移完成

## 变更摘要

已将 Worker 的 `seedance_adapter.py` 从"视觉智能 Visual API"（Signature V4 签名）改造为"火山方舟 Ark API"（Bearer Token 鉴权），匹配 PDF 文档《火山方舟_创建视频生成任务_1787292498.pdf》描述的真实接口。

## 主要变更

### 1. 认证方式
- **之前**: Volcengine Signature V4（需要 Access Key + Secret Key，HMAC-SHA256 签名）
- **现在**: Bearer API Key（火山方舟控制台生成，格式 `ark-...`）

### 2. API Endpoint
- **之前**: `https://visual.volcengineapi.com/?Action=Txt2Video&Version=2023-11-30`
- **现在**: `https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks`

### 3. 请求格式
#### 创建任务（POST）
**之前 (Visual API)**:
```json
{
  "model": "DouBao-seedance-v2-5",
  "prompt": "产品旋转展示",
  "duration": "5s",
  "ratio": "16:9",
  "watermark": false
}
```

**现在 (Ark API)** - 匹配 PDF 文档:
```json
{
  "model": "doubao-video-pro",
  "content": [
    {"type": "text", "text": "产品旋转展示"},
    {"type": "image_url", "image_url": {"url": "https://..."}}
  ],
  "resolution": "720P",
  "ratio": "16:9",
  "duration": 5,
  "camera_fixed": false,
  "seed": 12345,
  "watermark": {...}
}
```

#### 响应格式
**之前**:
```json
{
  "ResponseMetadata": {...},
  "Result": {"task_id": "xxx"}
}
```

**现在** (推测，PDF 未详细说明):
```json
{
  "id": "task-xxx"
}
```

### 4. 查询任务状态（⚠️ 待确认）
**之前**: `POST /?Action=GetVideoGenerateResult` + 签名

**现在** (推测，PDF 未包含此接口文档):
```
GET /api/v3/contents/generations/tasks/{task_id}
```

**推测响应格式**:
```json
{
  "id": "task-xxx",
  "status": "pending" | "processing" | "completed" | "failed",
  "result": {"video_url": "https://..."},
  "error": "...",
  "progress": 50
}
```

## 配置变更

### config.py
```python
# 之前
volcengine_access_key: str = ""
volcengine_secret_key: str = ""

# 现在
volcengine_access_key: str = ""  # Ark API Key
```

### .env
```bash
# 之前
VOLCENGINE_ACCESS_KEY=your-access-key
VOLCENGINE_SECRET_KEY=your-secret-key

# 现在
VOLCENGINE_ACCESS_KEY=你的火山方舟API_KEY  # 火山方舟 API Key
```

### 删除的文件
- `providers/volcengine_signer.py` - Signature V4 签名模块（不再需要）
- `API_UPDATE.md` - 旧版本文档（已过时）

## 后续操作清单

### 立即需要
1. **获取 Ark API Key**
   - 登录火山方舟控制台：https://console.volcengine.com/ark
   - 进入「API Key 管理」页面
   - 创建新的 API Key（格式：`ark-...`）
   - 将 API Key 填入 `packages/worker/.env` 的 `VOLCENGINE_ACCESS_KEY`

2. **配置 OSS 凭证**
   - 在阿里云 RAM 控制台创建子账号（最小权限原则）
   - 授予 `sweetyshell-ai-assets` bucket 的 `PutObject`/`GetObject` 权限
   - 将 Access Key ID 和 Secret 填入 `.env`:
     ```bash
     OSS_ACCESS_KEY_ID=LTAI5t...
     OSS_ACCESS_KEY_SECRET=...
     ```

### 测试前必须确认（Task #6）
3. **验证查询任务状态 API 的真实格式**
   
   当前 `get_task_status()` 方法基于 REST 惯例推测：
   ```
   GET /api/v3/contents/generations/tasks/{task_id}
   ```
   
   **需要确认**:
   - 真实 endpoint 路径是否正确？
   - 响应 JSON 字段名称：`status`/`result`/`error` 是否准确？
   - 状态值枚举：`pending`/`processing`/`completed`/`failed` 是否匹配？
   
   **如何确认**:
   - 查找火山方舟文档中「查询视频生成任务状态」接口说明
   - 或在控制台 API 调试工具中实际调用一次，复制真实响应格式
   - 或提供之前成功调用过的 Ark API Key，我可以用测试请求验证

4. **首次真实调用测试**
   ```bash
   cd packages/worker
   source venv/bin/activate
   python main.py
   ```
   
   同时在另一个终端调用 Backend 创建任务：
   ```bash
   curl -X POST http://localhost:3000/api/gateway/execute \
     -H "Content-Type: application/json" \
     -d '{
       "capability": "TEXT_TO_VIDEO",
       "profile": "seedance-main",
       "params": {
         "prompt": "一只猫在草地上奔跑",
         "duration": 5,
         "ratio": "16:9"
       }
     }'
   ```
   
   观察 Worker 日志，如果报错则根据实际响应调整代码。

## 风险提示

1. **查询接口格式未确认**: `get_task_status()` 基于推测实现，首次调用可能报错，需根据实际响应调整
2. **API Key 安全**: 请妥善保管火山方舟 API Key，不要提交到公开仓库
3. **费用记录边界**: 不再提供提交前费用预估；任务完成后仅依据 Provider 返回的 token usage 计算实际费用，无法取得 usage 时标记为 `unavailable`

## 兼容性

- `executor.py` 无需修改，接口方法签名保持不变
- `models.py` 中的 `ProviderTaskStatus` 适配新格式
- Python 依赖无变化（移除 `volcengine_signer.py`，无额外包需求）
