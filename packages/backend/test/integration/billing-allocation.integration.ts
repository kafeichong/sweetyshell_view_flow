/**
 * 账单分配 MVP 集成测试
 *
 * 测试完整流程：
 * 1. 从火山引擎拉取账单
 * 2. 持久化到数据库
 * 3. 计算分配预览
 * 4. 确认分配
 *
 * 环境要求：
 * - 需要真实的火山引擎凭证 (VOLCENGINE_ACCESS_KEY_ID, VOLCENGINE_SECRET_ACCESS_KEY)
 * - 需要数据库连接
 * - 建议使用测试环境，避免污染生产数据
 */

import { PrismaService } from '../../src/prisma.service';
import { VolcengineBillingClient } from '../../src/v1/admin/volcengine-billing.client';
import { BillingAllocationService } from '../../src/v1/admin/billing-allocation.service';
import { BillingImportService } from '../../src/v1/admin/billing-import.service';

async function runIntegrationTest() {
  console.log('=== 账单分配 MVP 集成测试 ===\n');

  // 1. 初始化依赖
  console.log('1. 初始化依赖...');
  const prisma = new PrismaService();
  await prisma.onModuleInit();

  const accessKeyId = process.env.VOLCENGINE_ACCESS_KEY_ID;
  const secretAccessKey = process.env.VOLCENGINE_SECRET_ACCESS_KEY;

  if (!accessKeyId || !secretAccessKey) {
    console.error('❌ 缺少火山引擎凭证环境变量');
    console.log('请设置: VOLCENGINE_ACCESS_KEY_ID, VOLCENGINE_SECRET_ACCESS_KEY');
    process.exit(1);
  }

  const billingClient = new VolcengineBillingClient();
  const allocationService = new BillingAllocationService(prisma);
  const importService = new BillingImportService(
    prisma,
    billingClient,
    allocationService,
  );

  console.log('✅ 依赖初始化完成\n');

  // 2. 导入账单并预览分配
  const testMonthKey = process.env.TEST_MONTH_KEY || '2026-09';
  const testProvider = 'volcengine';

  console.log(`2. 导入账单: ${testProvider} ${testMonthKey}...`);

  try {
    const preview = await importService.importAndPreview(testMonthKey, testProvider);

    console.log('✅ 账单导入成功');
    console.log(`   - 账单ID: ${preview.existingBillId}`);
    console.log(`   - 总金额: ¥${preview.billTotal}`);
    console.log(`   - 任务数: ${preview.allocations.length}`);
    console.log(`   - 未分配: ¥${preview.unallocatedCny}`);
    console.log(`   - 是否已导入: ${preview.isAlreadyImported ? '是' : '否'}\n`);

    // 3. 显示分配详情
    console.log('3. 分配详情:');
    if (preview.allocations.length > 0) {
      console.log('   前 5 条分配记录:');
      preview.allocations.slice(0, 5).forEach((allocation, idx) => {
        console.log(`   ${idx + 1}. 任务 ${allocation.taskId.slice(0, 8)}...`);
        console.log(`      用户: ${allocation.actorId || '未知'}`);
        console.log(`      时长: ${allocation.durationSeconds}秒`);
        console.log(`      金额: ¥${allocation.allocatedCny}`);
        console.log(`      占比: ${allocation.proportionPercent.toFixed(2)}%`);
      });
      if (preview.allocations.length > 5) {
        console.log(`   ... 还有 ${preview.allocations.length - 5} 条记录\n`);
      }
    } else {
      console.log('   当月无已完成任务\n');
    }

    // 4. 验证数据一致性
    console.log('4. 验证数据一致性...');
    const bill = await prisma.monthlyProviderBill.findUnique({
      where: {
        provider_monthKey: {
          provider: testProvider,
          monthKey: testMonthKey,
        },
      },
      include: {
        lines: true,
      },
    });

    if (!bill) {
      throw new Error('账单未找到');
    }

    console.log(`✅ 账单记录验证通过`);
    console.log(`   - 明细行数: ${bill.lines.length}`);
    console.log(`   - 源摘要: ${bill.sourceDigest.slice(0, 16)}...`);
    console.log(`   - 创建时间: ${bill.createdAt.toISOString()}`);
    console.log(`   - 已确认: ${bill.confirmedAt ? '是' : '否'}\n`);

    // 5. 确认分配（仅在测试环境且未确认时执行）
    if (!bill.confirmedAt && process.env.ALLOW_CONFIRM === 'true') {
      console.log('5. 确认分配...');
      const result = await importService.confirm(
        testMonthKey,
        testProvider,
        'integration-test',
      );
      console.log('✅ 分配已确认');
      console.log(`   - 账单ID: ${result.billId}`);
      console.log(`   - 分配数: ${result.allocationCount}\n`);
    } else {
      console.log('5. 跳过确认（账单已确认或未设置 ALLOW_CONFIRM=true）\n');
    }

    console.log('=== 集成测试完成 ===');
    console.log('✅ 所有测试通过');

  } catch (error: any) {
    console.error('❌ 测试失败:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runIntegrationTest();
