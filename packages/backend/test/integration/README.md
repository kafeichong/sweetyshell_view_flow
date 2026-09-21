# 账单分配 MVP 集成测试指南

## 概述

本集成测试验证从火山引擎拉取账单到完成分配的完整流程。

## 前置条件

### 1. 环境变量

需要设置以下环境变量：

```bash
# 火山引擎凭证（必需）
export VOLCENGINE_ACCESS_KEY_ID="your_access_key_id"
export VOLCENGINE_SECRET_ACCESS_KEY="your_secret_access_key"

# 测试月份（可选，默认 2026-09）
export TEST_MONTH_KEY="2026-09"

# 是否允许确认分配（可选，默认 false）
# 设置为 true 会将分配结果持久化到数据库
export ALLOW_CONFIRM="false"
```

### 2. 数据库

确保数据库已运行且迁移已应用：

```bash
npx prisma migrate deploy
```

### 3. 依赖安装

```bash
npm install
```

## 运行测试

### 方式 1: 使用脚本（推荐）

```bash
cd packages/backend
./test/integration/run-integration-test.sh
```

指定测试月份：

```bash
./test/integration/run-integration-test.sh 2026-08
```

### 方式 2: 直接运行

```bash
cd packages/backend
npx ts-node test/integration/billing-allocation.integration.ts
```

## 测试流程

集成测试执行以下步骤：

1. **初始化依赖**
   - 连接数据库
   - 初始化火山引擎客户端
   - 创建服务实例

2. **导入账单**
   - 从火山引擎 API 拉取指定月份账单
   - 验证账单数据完整性
   - 持久化到 MonthlyProviderBill 和 BillLine 表

3. **计算分配预览**
   - 查询月份内完成的任务
   - 按执行时长比例计算分配
   - 显示分配详情

4. **验证数据一致性**
   - 检查账单记录存在
   - 验证明细行数量
   - 检查源摘要和时间戳

5. **确认分配（可选）**
   - 仅当 `ALLOW_CONFIRM=true` 时执行
   - 标记账单为已确认
   - 返回分配统计

## 预期输出

成功运行时，输出示例：

```
=== 账单分配 MVP 集成测试 ===

1. 初始化依赖...
✅ 依赖初始化完成

2. 导入账单: volcengine 2026-09...
✅ 账单导入成功
   - 账单ID: 550e8400-e29b-41d4-a716-446655440000
   - 总金额: ¥1234.56
   - 任务数: 42
   - 未分配: ¥12.34
   - 是否已导入: 否

3. 分配详情:
   前 5 条分配记录:
   1. 任务 a1b2c3d4...
      用户: actor-123
      时长: 120秒
      金额: ¥45.67
      占比: 3.70%
   ...

4. 验证数据一致性...
✅ 账单记录验证通过
   - 明细行数: 15
   - 源摘要: 9f86d081884c7d65...
   - 创建时间: 2026-09-21T10:00:00.000Z
   - 已确认: 否

5. 跳过确认（账单已确认或未设置 ALLOW_CONFIRM=true）

=== 集成测试完成 ===
✅ 所有测试通过
```

## 故障排查

### 错误: "缺少火山引擎凭证环境变量"

确保已设置 `VOLCENGINE_ACCESS_KEY_ID` 和 `VOLCENGINE_SECRET_ACCESS_KEY`。

### 错误: "BILL_ALREADY_CONFIRMED"

账单已确认，无法重复确认。可以：
- 测试不同月份
- 手动删除数据库中的记录（仅测试环境）

### 错误: "REAL_PROVIDER_CREDENTIAL_FORBIDDEN"

客户端处于测试模式但提供了真实凭证。检查 `testMode` 配置。

### 错误: "账单未找到"

火山引擎 API 返回了空账单或网络错误。检查：
- 凭证是否有效
- 月份是否有账单数据
- 网络连接

## 安全注意事项

1. **凭证保护**
   - 不要将凭证提交到代码仓库
   - 使用环境变量或密钥管理系统
   - 测试完成后清理凭证

2. **测试环境**
   - 建议在测试环境运行集成测试
   - 避免污染生产数据
   - 不要对生产账单执行 `ALLOW_CONFIRM=true`

3. **数据清理**
   - 测试完成后可选择清理测试数据
   - 生产环境请谨慎操作

## 验收标准

集成测试通过需满足：

- ✅ 成功从火山引擎拉取账单
- ✅ 账单数据正确持久化到数据库
- ✅ 分配算法计算正确（总和 = 账单总额）
- ✅ 数据一致性验证通过
- ✅ 确认流程无错误（如果执行）

## 下一步

集成测试通过后，可以：

1. 在前端界面测试完整流程
2. 执行真实月份的账单导入
3. 验证分配结果准确性
4. 部署到生产环境
