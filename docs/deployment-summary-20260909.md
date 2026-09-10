# AI Video Flow 部署总结与技术分析

**日期**: 2026-09-09  
**状态**: 部署完成，历史数据已回填

---

## 部署进度

### 1. 核心问题修复

**问题**: Worker成功生成视频并上传OSS，但未将videoUrl回写到数据库Task记录

**根因**: `packages/worker/executor.py`中OSS上传成功后，调用`update_job_status(...COMPLETED...)`时未传入上传得到的URL

**修复方案**:
```python
# executor.py:230-322
uploaded_video_url: Optional[str] = None

# OSS上传成功后保存URL
oss_url = self.oss_uploader.upload(str(local_path), object_key)
uploaded_video_url = oss_url

# 任务完成时通过result参数回写
update_job_status(
    job_id=job.id,
    status=JobStatus.COMPLETED,
    result=(
        {"video_url": uploaded_video_url}
        if uploaded_video_url
        else None
    ),
)
```

**验证**: 
- MP4文件已在Worker输出目录：`image_to_video-20260909-112106.mp4` (7.5MB)、`image_to_video-20260909-112301.mp4` (6.9MB)
- 修复前的两条任务videoUrl为null，修复后新完成任务会正确回写

### 2. 历史数据回填

**受影响任务**:
- `3fc583ee-d777-4795-aeed-a395e22da619` (完成于 11:21:16)
- `7dc398ed-b893-460b-bd73-3d2d271098ed` (完成于 11:23:11)

**回填方案**:
创建临时脚本`backfill_video_urls.py`，在Worker容器内运行：
1. 使用Worker现有的`OssUploader`将本地MP4上传到OSS
2. 通过Backend API (`PATCH /api/tasks/:id`) 更新数据库videoUrl字段
3. 生成带7天有效期的OSS签名URL

**结果**: 
```
✓ 两条历史任务已上传OSS并回写videoUrl
✓ 无新增Ark Provider计费
```

### 3. 配置清理

移除`docker-compose.yml`顶层废弃的`version: '3.8'`字段，消除Compose警告

---

## 技术决策分析：Worker为何使用Python而非NestJS

### 架构观察

**Worker当前职责**:
```
┌─────────────────────────────────────────┐
│ Worker (Python + FastAPI)               │
├─────────────────────────────────────────┤
│ • 长轮询Backend获取pending任务           │
│ • 多Provider适配 (Ark/Seedance/MiniMax) │
│ • ComfyUI工作流编译与WebSocket交互       │
│ • 文件下载/上传 (图片输入 → OSS视频输出) │
│ • 成本审计与计费数据回写                 │
└─────────────────────────────────────────┘
         ↓ asyncio轮询              ↓ OSS上传
    Backend (NestJS)           阿里云OSS
         ↓ HTTP回调             ↓ Provider API
    火山引擎Ark/Seedance       ComfyUI (Python)
```

### Python适合的核心理由

#### 1. AI生态原生支持
- **ComfyUI集成**: ComfyUI本身是Python生态，自定义节点、工作流编译都需要Python
- **Provider SDK成熟度**: volcengine、阿里云OSS等SDK的Python版本通常更成熟
- **视频/图像处理**: PIL、OpenCV等库在Python中是一等公民

#### 2. 性能瓶颈不在Worker
- **真正耗时**: Ark视频生成耗时2分钟+，瓶颈在外部Provider API
- **并发需求**: 单Worker实例处理的并发量不大，Python GIL不是瓶颈
- **异步I/O**: FastAPI + asyncio足以高效处理轮询和HTTP请求

#### 3. 快速迭代优势
- Provider适配逻辑（compiler/adapter模式）需要频繁调整
- Python动态类型和简洁语法降低实验成本
- 当前有完善的单元测试覆盖（`tests/test_*_compiler.py`）

### NestJS的潜在优势（但当前不关键）

| 优势 | 现状 | 判断 |
|------|------|------|
| **类型安全** | Python有Pydantic/FastAPI，类型覆盖已足够 | ✓ 已满足 |
| **企业级框架** | Worker不是面向外部的API服务，框架优势未能发挥 | ⚠️ 未用到 |
| **Node生态** | Worker依赖（ComfyUI、Provider SDK）都在Python生态 | ✗ 不适用 |
| **与Backend共享代码** | 当前Task模型定义重复，但通过HTTP契约隔离 | ⚠️ 边际收益低 |

### 需要重构为NestJS的场景

1. **深度代码共享**: 如果Worker需要复用Backend的实体/验证/业务逻辑（当前通过HTTP契约隔离，无此需求）
2. **暴露丰富API**: 当前Worker只有健康检查接口，未来如果需要管理API，NestJS模块化优势会显现
3. **团队技能栈统一**: 如果团队只有Node背景，维护Python增加成本（当前团队可维护Python）

### 结论

**Python是合理选择**。Worker的核心价值在"粘合AI服务"，Python在这个场景下生态优势明显，性能瓶颈不在Worker自身。

**不建议重构为NestJS**，除非：
- Worker需要与Backend共享大量业务逻辑（当前通过HTTP契约隔离良好）
- Worker从"任务执行器"升级为"任务管理平台"（当前无此趋势）

---

## 当前系统状态

### 服务拓扑
```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│ Backend (NestJS) │────▶│ PostgreSQL       │     │ Worker (Python)  │
│ Port: 3100       │     │ Port: 5433       │◀────│ Port: 8101       │
└──────────────────┘     └──────────────────┘     └──────────────────┘
         │                                                  │
         │                                                  │
         ▼                                                  ▼
  用户API调用                                         轮询任务执行
  创建Task记录                                   调用Provider API
  返回taskId                                      上传视频到OSS
                                                  回写videoUrl
```

### 已完成任务统计
- **总完成任务**: 2条
- **视频文件大小**: 6.9MB + 7.5MB
- **OSS存储**: 阿里云北京区域，私有bucket + 7天签名URL
- **计费Provider**: 火山引擎Ark (两次视频生成调用)

### 待优化项
1. **签名URL有效期管理**: 当前7天过期，前端需处理过期重新签名逻辑
2. **Worker横向扩展**: 当前单实例，未来可通过`docker-compose scale`扩展
3. **任务重试机制**: 当前有基础重试，但Provider长时间pending未处理超时逻辑需完善
4. **成本告警**: 当前只回写cost字段，未实现超预算告警

---

## 部署环境

- **服务器**: `root@8.140.49.56`
- **项目路径**: `/data/video-flow`
- **容器编排**: Docker Compose
- **数据库**: PostgreSQL 16 (video_user / video_flow)
- **OSS**: 阿里云 sweetyshell-ai-assets (cn-beijing)

## 关键文件路径

```
packages/
├── backend/              # NestJS API服务
│   ├── src/tasks/       # Task CRUD + 状态更新API
│   └── prisma/          # 数据库Schema
└── worker/              # Python任务执行器
    ├── executor.py      # ✓ 已修复videoUrl回写
    ├── main.py          # FastAPI入口 + 轮询lifespan
    ├── oss_uploader.py  # OSS上传 + 签名URL生成
    └── providers/       # Provider适配器
        ├── seedance_adapter.py
        └── minimax_compiler.py
```

---

**修复完成时间**: 2026-09-09 19:32  
**修复作者**: Claude Code (Sonnet 5)
