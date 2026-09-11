# 域名与 HTTPS（ai.sweetyshell.com）

> 最后更新：2026-09-11
> 本文只记录**当前生效的事实**与必须保持的不变量。完整的历史配置教程见 `archive/2026-09-09/域名配置方案-ai.sweetyshell.com.md`（已归档，其中包含已废弃的 `/health` 代理到 Worker 的写法，不要照抄）。

---

## 1. 当前事实

| 项 | 值 | 最近核验 |
| --- | --- | --- |
| 域名 | `ai.sweetyshell.com` | 2026-09-11 |
| DNS 解析 | → `8.140.49.56` | 2026-09-11 |
| 证书目录 | `/etc/letsencrypt/live/ai.sweetyshell.com/` | 2026-09-11 |
| Nginx 配置 | `/etc/nginx/sites-enabled/ai.sweetyshell.com` | 2026-09-11 |
| API 代理 | `location /api/` → `http://127.0.0.1:3100`（**保留 `/api/` 原路径**） | 2026-09-11 |
| 业务 API | `api.sweetyshell.com` → `127.0.0.1:3000`，**属于其他业务，不得改动** | 2026-09-11 |

核验命令：

```bash
getent ahostsv4 ai.sweetyshell.com
nginx -T | sed -n '/server_name ai.sweetyshell.com/,/^}/p'
ls /etc/letsencrypt/live/ai.sweetyshell.com/
```

---

## 2. 必须保持的安全不变量

来自 [architecture/seedance-integration-baseline.md](../architecture/seedance-integration-baseline.md) §7，以及 [PROJECT_STATUS.md](../PROJECT_STATUS.md) R2：

1. **对外只开放 HTTPS（443 / 80）**，不得暴露 3100 / 8101 / 5433。
2. **不要把 Worker 代理到公网。** 归档教程里的 `location /health { proxy_pass http://127.0.0.1:8101; }` 违反此边界，必须删除；Worker 健康检查只在服务器内网或 Docker 网络内做。
3. **不要把 PostgreSQL 代理出去**，也不要给它发布宿主端口。
4. **`/api/` 只转发到 Backend（3100）**，路径保持原样，便于客户端统一使用 `/api/v1/*`。
5. CORS 由 Backend 通过 `CORS_ORIGIN` 控制（未配置时不开放跨域）。**不要**在 Nginx 层加 `Access-Control-Allow-Origin: *`，否则会绕过这层白名单。
6. 日志不得记录 API Key、OSS Secret、完整签名 URL 或明文 token。

检查暴露面：

```bash
ssh root@8.140.49.56 "ss -lntp | grep -E ':(3100|8101|5433)\b' || echo 'OK: no app ports on public interfaces'"
ss -lntp | grep -E ':(80|443)\b'   # 期望只有这两个
```

期望：App 端口只监听 `127.0.0.1` 或 Docker 网络内部，公网不可达。

---

## 3. 证书续期

```bash
certbot renew --dry-run
crontab -l | grep certbot
```

---

## 4. 变更流程

1. 修改前先 `nginx -T` 备份当前配置。
2. 改完 `nginx -t` 通过后再 `nginx -s reload`。
3. 变更后跑一次 [deploy-and-rollback.md](./deploy-and-rollback.md) 第 3 节的安全门禁。
4. **不要**改动 `api.sweetyshell.com` 对应的 server 块。
