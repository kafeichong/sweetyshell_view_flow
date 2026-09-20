# 消费看板口径与接口

## 页面职责

- 普通用户 `/dashboard`：只展示当前 Actor 的今日、本月消费、额度、预警及已结算趋势。
- 管理员 `/dashboard`：展示全站今日、本月汇总、已结算趋势和本月用户消费排行。
- 单个用户的 Token、当前费用及调用日志由管理员“用户 Token”页面负责。

## 金额口径

- `settled`：状态为 `settled` 的预算记录，以 `settledCny` 汇总，代表已确认的实际费用。
- `reserved`：状态为 `reserved` 或 `review` 的预算记录，以 `reservedCny` 汇总，代表预占或待复核金额。
- `total`：`settled + reserved`，页面明确标注“含预占”，不能直接称为实际花费。
- 趋势和用户排行仅统计 `settled`，避免处理中金额在日期和用户排行中反复波动。

## 接口

用户接口使用 Bearer Actor Token：

- `GET /api/v1/consumption/overview`
- `GET /api/v1/consumption/trends?days=7|30|90`

管理员接口使用 `x-admin-token`：

- `GET /api/v1/admin/consumption/overview`
- `GET /api/v1/admin/consumption/trends?days=7|30|90`
- `GET /api/v1/admin/consumption/summary`（本月已结算用户排行）

概览统一返回 `daily`、`monthly` 两个周期，每个周期至少包含 `settled`、`reserved`、`total` 和 `taskCount`。用户概览另外返回 `limit`、`remaining`、`alerts`；管理员全局概览不返回个人额度或预警。

趋势统一返回：

```json
{
  "trends": [
    { "date": "2026-09-21", "amount": "12.500000", "taskCount": 3 }
  ]
}
```

## 本地验证

```bash
cd packages/backend
npx jest src/v1/consumption/consumption.service.spec.ts --runInBand
npm run build

cd ../frontend
npm test
npx tsc --noEmit
npm run build -- --webpack
```

本地构建通过不代表 Docker、测试环境或生产环境已经部署。
