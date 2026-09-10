# Preview 联调验收记录

## 配置检查

- [ ] Backend 已配置 `VIDEO_FLOW_WORKER_TOKEN`
- [ ] Worker 已配置同一 service token
- [ ] Backend 已配置 `OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET`、`OSS_BUCKET`、`OSS_REGION`
- [ ] ComfyUI 只配置 `VIDEO_FLOW_BACKEND_URL`、`VIDEO_FLOW_TOKEN`、协议版本
- [ ] ComfyUI 电脑不存在 Ark/OSS 密钥

## 无付费 Smoke Test

- [ ] 无 token 请求 `/api/v1/tasks` 返回 401
- [ ] 停用 token 请求返回 403
- [ ] 相同 actor 和 `Idempotency-Key` 返回同一 Task
- [ ] 相同 key 不同请求体返回 409
- [ ] 上传票据创建 `Asset`，永久记录 `objectKey`
- [ ] 不同 actor 不能下载该 Asset
- [ ] OSS 配置缺失时上传/下载返回 503，不生成裸 OSS URL
- [ ] Preview 请求不调用 Ark create endpoint

## 结果与回滚

- 验收人：
- 验收时间：
- Backend 镜像 tag：
- Worker 镜像 tag：
- 数据库 migration：
- 失败现象：
- 回滚动作：关闭 `/api/v1` 或移除 ComfyUI custom node；不删除数据库新表。
