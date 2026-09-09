# ai.sweetyshell.com 域名配置方案

> 域名：ai.sweetyshell.com  
> 解析到：8.140.49.56 ✅  
> SSL 证书：需要申请

---

## 📋 配置概览

### 域名映射方案
```
ai.sweetyshell.com → Backend API (3100)
  ├── /api/tasks     → 任务管理
  ├── /api/config    → 配置管理
  └── /health        → 健康检查（Worker）
```

**优点**：
- ✅ 统一域名访问
- ✅ HTTPS 安全加密
- ✅ 可以配置 CORS
- ✅ 可以添加访问限制

---

## 🔧 Nginx 配置文件

### 1. 创建配置文件

```bash
# 创建配置文件
cat > /etc/nginx/sites-available/ai.sweetyshell.com << 'EOF'
# HTTP -> HTTPS 重定向
server {
    listen 80;
    server_name ai.sweetyshell.com;
    return 301 https://$host$request_uri;
}

# HTTPS 主配置
server {
    listen 443 ssl http2;
    server_name ai.sweetyshell.com;

    # SSL 证书配置（申请后更新路径）
    ssl_certificate /etc/letsencrypt/live/ai.sweetyshell.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ai.sweetyshell.com/privkey.pem;

    # SSL 优化配置
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;

    # 安全头
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    # 访问日志
    access_log /var/log/nginx/ai.sweetyshell.com.access.log;
    error_log /var/log/nginx/ai.sweetyshell.com.error.log;

    # API 限流配置
    limit_req_zone $binary_remote_addr zone=ai_api:10m rate=10r/s;
    limit_req_status 429;

    # Backend API 代理
    location /api/ {
        limit_req zone=ai_api burst=20 nodelay;
        
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # CORS 头（如果需要前端跨域访问）
        add_header Access-Control-Allow-Origin "*" always;
        add_header Access-Control-Allow-Methods "GET, POST, PUT, PATCH, DELETE, OPTIONS" always;
        add_header Access-Control-Allow-Headers "Content-Type, Authorization" always;
        
        # 处理 OPTIONS 预检请求
        if ($request_method = 'OPTIONS') {
            return 204;
        }

        # 超时设置
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 300s;
    }

    # Worker 健康检查
    location /health {
        proxy_pass http://127.0.0.1:8101;
        proxy_http_version 1.1;
        
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        
        access_log off;
    }

    # 根路径返回 API 信息
    location = / {
        default_type application/json;
        return 200 '{"service":"AI Video Flow API","version":"1.0.0","status":"running","docs":"https://ai.sweetyshell.com/api"}';
    }

    # 健康检查（用于负载均衡）
    location = /ping {
        access_log off;
        return 200 "pong\n";
        add_header Content-Type text/plain;
    }
}
EOF

# 创建软链接启用配置
ln -s /etc/nginx/sites-available/ai.sweetyshell.com /etc/nginx/sites-enabled/

# 测试配置
nginx -t

# 重载 Nginx
nginx -s reload
```

---

## 🔐 SSL 证书申请

### 方法 1：使用 Let's Encrypt（推荐，免费）

```bash
# 安装 certbot（如果还没安装）
apt install certbot python3-certbot-nginx -y

# 申请证书（自动配置 Nginx）
certbot --nginx -d ai.sweetyshell.com

# 或者手动申请
certbot certonly --nginx -d ai.sweetyshell.com

# 自动续期（crontab）
# certbot 会自动添加续期任务，查看：
crontab -l | grep certbot

# 手动测试续期
certbot renew --dry-run
```

### 方法 2：使用现有证书（如果有泛域名证书）

```bash
# 如果已有 *.sweetyshell.com 泛域名证书
# 直接使用现有证书路径
ssl_certificate /etc/letsencrypt/live/sweetyshell.com/fullchain.pem;
ssl_certificate_key /etc/letsencrypt/live/sweetyshell.com/privkey.pem;
```

---

## 📝 完整部署步骤

### 第一步：申请 SSL 证书

```bash
ssh root@8.140.49.56

# 先创建临时配置（HTTP only）
cat > /etc/nginx/sites-available/ai.sweetyshell.com << 'EOF'
server {
    listen 80;
    server_name ai.sweetyshell.com;
    
    location / {
        return 200 "AI Video Flow API - Setting up...";
        add_header Content-Type text/plain;
    }
}
EOF

# 启用配置
ln -s /etc/nginx/sites-available/ai.sweetyshell.com /etc/nginx/sites-enabled/
nginx -t && nginx -s reload

# 申请证书
certbot --nginx -d ai.sweetyshell.com
```

### 第二步：部署项目

```bash
# 克隆代码
cd /data
git clone <仓库地址> video-flow
cd video-flow

# 配置环境变量
cp .env.example .env
vim .env
```

**关键环境变量**：
```bash
# 数据库
DATABASE_URL="postgresql://postgres:你的密码@localhost:5433/video_flow?schema=public"
DB_PASSWORD=你的强密码

# 服务端口
BACKEND_PORT=3100
WORKER_PORT=8101

# 火山引擎
VOLCENGINE_ACCESS_KEY=你的火山引擎API_KEY

# 阿里云 OSS
OSS_ACCESS_KEY_ID=你的阿里云AccessKey_ID
OSS_ACCESS_KEY_SECRET=你的阿里云AccessKey_Secret
OSS_BUCKET=sweetyshell-ai-assets
OSS_REGION=oss-cn-beijing

# CORS（允许所有来源，生产环境可以限制）
CORS_ORIGIN=*
```

```bash
# 启动服务
./scripts/deploy.sh

# 等待容器启动
sleep 10

# 检查服务状态
docker compose ps
curl http://localhost:3100/api/tasks
curl http://localhost:8101/health
```

### 第三步：更新 Nginx 配置为完整版本

```bash
# 使用上面的完整 Nginx 配置替换临时配置
vim /etc/nginx/sites-available/ai.sweetyshell.com

# 测试配置
nginx -t

# 重载 Nginx
nginx -s reload
```

### 第四步：测试访问

```bash
# 测试 HTTPS 访问
curl https://ai.sweetyshell.com/
curl https://ai.sweetyshell.com/api/tasks
curl https://ai.sweetyshell.com/health

# 创建测试任务
curl -X POST https://ai.sweetyshell.com/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"createdBy":"测试","prompt":"测试任务","imageUrl":"https://example.com/test.jpg"}'

# 查看任务列表
curl https://ai.sweetyshell.com/api/tasks
```

---

## 🔒 安全加固（可选）

### 1. IP 白名单（限制访问）

```nginx
# 只允许特定 IP 访问
location /api/ {
    allow 192.168.1.0/24;  # 内网
    allow 1.2.3.4;         # 特定 IP
    deny all;
    
    proxy_pass http://127.0.0.1:3100;
}
```

### 2. API Key 认证

```nginx
# 简单的 API Key 验证
location /api/ {
    # 检查请求头
    if ($http_authorization != "Bearer your-secret-key") {
        return 401 "Unauthorized";
    }
    
    proxy_pass http://127.0.0.1:3100;
}
```

### 3. 限流配置

```nginx
# 更严格的限流
limit_req_zone $binary_remote_addr zone=ai_api:10m rate=5r/s;

location /api/tasks {
    limit_req zone=ai_api burst=10 nodelay;
    limit_req_status 429;
    
    proxy_pass http://127.0.0.1:3100;
}
```

---

## 📊 监控和日志

### 查看访问日志
```bash
# 实时查看访问日志
tail -f /var/log/nginx/ai.sweetyshell.com.access.log

# 查看错误日志
tail -f /var/log/nginx/ai.sweetyshell.com.error.log

# 统计 API 调用次数
grep "/api/tasks" /var/log/nginx/ai.sweetyshell.com.access.log | wc -l

# 查看 HTTP 状态码分布
awk '{print $9}' /var/log/nginx/ai.sweetyshell.com.access.log | sort | uniq -c | sort -rn
```

### 查看服务日志
```bash
# Backend 日志
docker compose logs video-backend -f --tail 100

# Worker 日志
docker compose logs video-worker -f --tail 100

# 所有服务日志
docker compose logs -f
```

---

## 🧪 完整测试流程

```bash
# 1. 健康检查
curl https://ai.sweetyshell.com/ping
# 预期：pong

curl https://ai.sweetyshell.com/health
# 预期：{"status":"healthy",...}

# 2. 查询任务列表（应该为空）
curl https://ai.sweetyshell.com/api/tasks
# 预期：[]

# 3. 创建任务
TASK_ID=$(curl -X POST https://ai.sweetyshell.com/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"createdBy":"测试用户","prompt":"一只可爱的猫咪在阳光下玩耍","imageUrl":"https://example.com/cat.jpg"}' \
  | jq -r '.id')

echo "任务 ID: $TASK_ID"

# 4. 查询任务状态
curl https://ai.sweetyshell.com/api/tasks/$TASK_ID | jq .

# 5. 等待 10 秒后再次查询（Worker 应该已处理）
sleep 10
curl https://ai.sweetyshell.com/api/tasks/$TASK_ID | jq .
```

---

## 🎯 API 端点文档

### 对外提供的 API

**基础 URL**: `https://ai.sweetyshell.com`

#### 1. 创建任务
```http
POST /api/tasks
Content-Type: application/json

{
  "createdBy": "用户名",
  "prompt": "视频描述文本",
  "imageUrl": "https://example.com/image.jpg"
}

响应：
{
  "id": "uuid",
  "status": "pending",
  "createdBy": "用户名",
  "prompt": "...",
  "imageUrl": "...",
  "videoUrl": null,
  "errorMsg": null,
  "cost": null,
  "createdAt": "2026-09-09T...",
  "completedAt": null
}
```

#### 2. 查询任务列表
```http
GET /api/tasks
GET /api/tasks?status=pending
GET /api/tasks?status=completed

响应：
[
  {
    "id": "uuid",
    "status": "completed",
    "videoUrl": "https://oss.../video.mp4",
    ...
  }
]
```

#### 3. 查询单个任务
```http
GET /api/tasks/{id}

响应：
{
  "id": "uuid",
  "status": "completed",
  "videoUrl": "https://oss.../video.mp4",
  ...
}
```

#### 4. 健康检查
```http
GET /health

响应：
{
  "status": "healthy",
  "backend_url": "http://video-backend:3000",
  "poll_interval": 5
}
```

---

## 📱 给创意人员的使用说明

### 快速调用示例

```bash
# 创建视频生成任务
curl -X POST https://ai.sweetyshell.com/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "createdBy": "小明",
    "prompt": "产品从水面缓缓浮现，水花飞溅，阳光照射",
    "imageUrl": "https://你的图片地址.jpg"
  }'

# 会返回任务 ID，记录下来
# 例如：ce522a72-0eea-41d5-8427-38450d2637e6

# 查询任务状态
curl https://ai.sweetyshell.com/api/tasks/ce522a72-0eea-41d5-8427-38450d2637e6

# 任务完成后会返回 videoUrl
```

### 在代码中调用（JavaScript）

```javascript
// 创建任务
async function createVideoTask(prompt, imageUrl) {
  const response = await fetch('https://ai.sweetyshell.com/api/tasks', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      createdBy: '用户名',
      prompt: prompt,
      imageUrl: imageUrl,
    }),
  });
  
  const task = await response.json();
  return task.id;
}

// 查询任务状态
async function getTaskStatus(taskId) {
  const response = await fetch(`https://ai.sweetyshell.com/api/tasks/${taskId}`);
  const task = await response.json();
  return task;
}

// 使用示例
const taskId = await createVideoTask(
  '产品从水面浮现',
  'https://example.com/product.jpg'
);

// 轮询任务状态
const checkInterval = setInterval(async () => {
  const task = await getTaskStatus(taskId);
  console.log('任务状态:', task.status);
  
  if (task.status === 'completed') {
    console.log('视频地址:', task.videoUrl);
    clearInterval(checkInterval);
  } else if (task.status === 'failed') {
    console.log('失败原因:', task.errorMsg);
    clearInterval(checkInterval);
  }
}, 5000); // 每 5 秒查询一次
```

---

## ✅ 配置完成检查清单

- [ ] DNS 解析正确（ai.sweetyshell.com → 8.140.49.56）✅
- [ ] SSL 证书申请成功
- [ ] Nginx 配置文件创建
- [ ] 项目代码部署到 /data/video-flow
- [ ] Docker 容器启动成功
- [ ] Backend API 可访问（https://ai.sweetyshell.com/api/tasks）
- [ ] Worker 健康检查通过（https://ai.sweetyshell.com/health）
- [ ] 创建测试任务成功
- [ ] Worker 能够处理任务

---

## 🚀 一键部署脚本

```bash
#!/bin/bash
# 一键部署脚本

set -e

echo "🚀 开始部署 AI Video Flow..."

# 1. 申请 SSL 证书
echo "📜 申请 SSL 证书..."
certbot --nginx -d ai.sweetyshell.com --non-interactive --agree-tos --email your@email.com

# 2. 创建 Nginx 配置
echo "⚙️ 配置 Nginx..."
cat > /etc/nginx/sites-available/ai.sweetyshell.com << 'EOF'
# [完整配置内容如上]
EOF

ln -sf /etc/nginx/sites-available/ai.sweetyshell.com /etc/nginx/sites-enabled/
nginx -t && nginx -s reload

# 3. 部署项目
echo "📦 部署项目..."
cd /data/video-flow
./scripts/deploy.sh

# 4. 等待服务启动
echo "⏳ 等待服务启动..."
sleep 15

# 5. 健康检查
echo "✅ 健康检查..."
curl -f https://ai.sweetyshell.com/health || {
  echo "❌ 健康检查失败"
  exit 1
}

echo "🎉 部署完成！"
echo "访问地址: https://ai.sweetyshell.com"
```

---

**配置完成后访问地址**：https://ai.sweetyshell.com
