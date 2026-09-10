"""
AI Studio Worker - Python FastAPI Service

负责：
1. 从 Backend API 轮询 pending 状态的 Job
2. 调用 Provider API (Seedance/MiniMax/Kling)
3. 轮询任务状态直到完成
4. 下载生成的视频到本地
5. 更新 Backend Job 状态和 Asset 记录

## 快速启动

```bash
# 安装依赖
pip install -r requirements.txt

# 配置环境变量
cp .env.example .env
# 编辑 .env 填写 API Key

# 启动服务
python main.py
```

开发/测试环境额外安装：

```bash
pip install -r requirements-dev.txt
```

生产 Docker 镜像只安装 `requirements.txt`，不包含 pytest；Docker 构建默认使用阿里云 PyPI 镜像加速 ARM64 依赖下载。

## 架构

- `main.py` - FastAPI 应用入口和健康检查接口
- `executor.py` - 任务执行器，负责轮询和执行
- `config.py` - 配置管理
- `models.py` - Pydantic 数据模型
- `providers/` - Provider 适配器
  - `seedance_adapter.py` - Seedance API 封装

## 工作流程

```
Worker 启动
  ↓
每 5s 轮询一次 Backend
  ↓
发现 pending Job
  ↓
调用 Provider API 创建任务
  ↓
更新 Job 状态为 submitted
  ↓
轮询 Provider 任务状态
  ↓
任务完成后下载视频
  ↓
创建 Asset 记录
  ↓
更新 Job 状态为 completed
```

## 失败分类

- `rate_limit` - API 限流，可退避重试
- `content_policy` - 内容审核失败，不重试
- `invalid_input` - 参数错误，不重试
- `timeout` - 超时，可重试
- `network_error` - 网络错误，可重试
- `unknown` - 未知错误

## TODO

- [ ] 实现 OSS 自动上传
- [ ] 实现 ComfyUI API 调用
- [ ] 实现 MiniMax 和 Kling 适配器
- [ ] 实现重试逻辑
- [ ] 实现 output 目录 watchdog 监听
"""
