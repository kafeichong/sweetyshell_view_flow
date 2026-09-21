# 用户 Token 管理

`GET /api/v1/admin/tokens` 仅接受 Admin Token，用于管理员查看用户调用凭证、额度和费用状态。普通用户不在前端使用该页面；直接访问 `/tokens` 会跳转 `/dashboard`。

## 用户访问状态

管理员可在 `/users` 使用“访问权限”开关临时停用或重新启用用户：

- `PATCH /api/v1/admin/credentials/:actorId/revoke`：状态改为 `revoked`，原 Token 暂停访问。
- `PATCH /api/v1/admin/credentials/:actorId/activate`：状态恢复为 `active`，原 Token 重新生效。

以上操作都不会生成或替换 `tokenHash`。如果 Token 可能已经泄露，不要重新启用旧 Token；应使用下方独立轮换操作。

## 独立轮换 Token

管理员可在 `/users` 对任意账号执行“轮换 Token”。页面要求输入完整 Actor ID，随后调用：

```bash
curl -X POST \
  -H "x-admin-token: $VIDEO_FLOW_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"confirmActorId":"test-actor"}' \
  http://localhost:3100/api/v1/admin/credentials/test-actor/rotate-token
```

轮换只替换 `tokenHash` 并清空旧的最近使用时间/IP，不修改账号 `status`：停用账号轮换后仍然停用。旧 Token 在接口成功时立即失效，新 Token 只在响应中显示一次。

## 永久删除空账号

`GET /api/v1/admin/tokens` 为每个账号返回 `canDelete`。只有同时满足以下条件时才为 `true`：`usageCount=0`，并且没有任务、素材、预算预占、预检、消费预警、对账或 Token 使用日志。

前端只为 `canDelete=true` 的账号显示“删除用户”，并要求输入完整 Actor ID。最终删除仍由后端在同一事务中重新检查，防止页面加载后账号又产生数据：

```bash
curl -X DELETE \
  -H "x-admin-token: $VIDEO_FLOW_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"confirmActorId":"test-actor"}' \
  http://localhost:3100/api/v1/admin/credentials/test-actor
```

- 空账号：HTTP 200，返回被删除的 `actorId`。
- Actor ID 确认不一致：HTTP 400，不删除。
- 存在任一历史数据：HTTP 409，不删除，应改为停用。

## 费用字段

`spending` 中的金额均为 CNY 字符串，保留 6 位小数：

- `dailySettled`：上海时区当日 `state=settled` 的 `settledCny` 合计，即今日实际花费。
- `monthlySettled`：上海时区当月 `state=settled` 的 `settledCny` 合计，即本月实际花费。
- `reserved`：所有当前 `state=reserved` 记录的 `reservedCny` 合计，即尚未结算的预占。
- `review`：所有当前 `state=review` 记录的 `reservedCny` 合计，即待人工核实金额。

## 用户业务指标

`GET /api/v1/admin/tokens` 的 `businessUsage` 用于 `/users` 用户卡片：

- `totalTasks`：累计正式生成任务数，包含成功和失败任务，排除 `status=preview`。
- `monthlyTasks`：上海时区本月创建的正式生成任务数，包含成功和失败任务，排除 Preview。
- `successfulTasks`：累计正式任务中 `status=completed` 或 `taskStatus=completed` 的数量。
- 本月实际花费直接使用 `spending.monthlySettled`，只包含 `state=settled` 的 `settledCny`，不包含预占或待复核金额。

历史任务可能只有 `createdBy`、没有 `actorId`；统计会使用 `actorId`，并对 `actorId IS NULL` 的历史数据回退到 `createdBy`，避免重复计数。

## 验收

```bash
curl -H "x-admin-token: $VIDEO_FLOW_ADMIN_TOKEN" \
  http://localhost:3100/api/v1/admin/tokens
```

期望：HTTP 200，每个用户对象包含 `spending`。用用户 Token 请求同一接口应返回 401。

状态开关验收（使用测试账号，避免误停正式用户）：

```bash
curl -X PATCH -H "x-admin-token: $VIDEO_FLOW_ADMIN_TOKEN" \
  http://localhost:3100/api/v1/admin/credentials/test-actor/revoke

curl -X PATCH -H "x-admin-token: $VIDEO_FLOW_ADMIN_TOKEN" \
  http://localhost:3100/api/v1/admin/credentials/test-actor/activate
```

期望：两次请求分别返回 `status=revoked` 和 `status=active`；原 Token 在停用时被拒绝，重新启用后恢复访问。
