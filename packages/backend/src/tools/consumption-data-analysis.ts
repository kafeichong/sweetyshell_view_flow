import { PrismaClient, Prisma } from '@prisma/client';

interface BackfillStats {
  totalActors: number;
  totalMonths: number;
  totalDays: number;
  totalSettledRecords: number;
  totalReservedRecords: number;
  totalSettledAmount: string;
  oldestRecord: string;
  newestRecord: string;
  actorBreakdown: Array<{
    actorId: string;
    name: string;
    recordCount: number;
    totalAmount: string;
    earliestDate: string;
    latestDate: string;
  }>;
}

async function validateDataIntegrity(prisma: PrismaClient): Promise<void> {
  const duplicates = await prisma.$queryRaw<Array<{ task_id: string; count: number }>>`
    SELECT task_id, COUNT(*) as count
    FROM task_budget_reservations
    GROUP BY task_id
    HAVING COUNT(*) > 1
  `;

  if (duplicates.length > 0) {
    process.stderr.write('❌ 发现重复的task_id：\n');
    duplicates.forEach((dup) => {
      process.stderr.write(`  - ${dup.task_id}: ${dup.count}条记录\n`);
    });
    throw new Error('数据完整性验证失败：存在重复的task_id');
  }

  process.stdout.write('✅ 数据完整性验证通过：无重复记录\n\n');
}

async function analyzeHistoricalData(prisma: PrismaClient): Promise<BackfillStats> {
  const settledStats = await prisma.taskBudgetReservation.aggregate({
    where: { state: 'settled' },
    _count: true,
    _sum: { settledCny: true },
  });

  const reservedStats = await prisma.taskBudgetReservation.aggregate({
    where: { state: 'reserved' },
    _count: true,
  });

  const timeRange = await prisma.$queryRaw<
    Array<{ oldest: string; newest: string }>
  >`
    SELECT
      MIN(day_key) as oldest,
      MAX(day_key) as newest
    FROM task_budget_reservations
    WHERE state = 'settled'
  `;

  const monthDayStats = await prisma.$queryRaw<
    Array<{ unique_months: bigint; unique_days: bigint }>
  >`
    SELECT
      COUNT(DISTINCT month_key) as unique_months,
      COUNT(DISTINCT day_key) as unique_days
    FROM task_budget_reservations
    WHERE state = 'settled'
  `;

  const actorStats = await prisma.$queryRaw<
    Array<{
      actor_id: string;
      record_count: bigint;
      total_amount: Prisma.Decimal;
      earliest_date: string;
      latest_date: string;
    }>
  >`
    SELECT
      tbr.actor_id,
      COUNT(*) as record_count,
      SUM(tbr.settled_cny) as total_amount,
      MIN(tbr.day_key) as earliest_date,
      MAX(tbr.day_key) as latest_date
    FROM task_budget_reservations tbr
    WHERE tbr.state = 'settled'
    GROUP BY tbr.actor_id
    ORDER BY total_amount DESC
  `;

  const actorIds = actorStats.map((s) => s.actor_id);
  const credentials = await prisma.actorCredential.findMany({
    where: { actorId: { in: actorIds } },
    select: { actorId: true, name: true },
  });
  const nameMap = new Map(credentials.map((c) => [c.actorId, c.name]));

  const stats: BackfillStats = {
    totalActors: actorStats.length,
    totalMonths: Number(monthDayStats[0]?.unique_months || 0),
    totalDays: Number(monthDayStats[0]?.unique_days || 0),
    totalSettledRecords: settledStats._count,
    totalReservedRecords: reservedStats._count,
    totalSettledAmount: (settledStats._sum.settledCny || new Prisma.Decimal(0)).toFixed(2),
    oldestRecord: timeRange[0]?.oldest || 'N/A',
    newestRecord: timeRange[0]?.newest || 'N/A',
    actorBreakdown: actorStats.map((s) => ({
      actorId: s.actor_id,
      name: nameMap.get(s.actor_id) || 'Unknown',
      recordCount: Number(s.record_count),
      totalAmount: s.total_amount.toFixed(2),
      earliestDate: s.earliest_date,
      latestDate: s.latest_date,
    })),
  };

  return stats;
}

function printReport(stats: BackfillStats): void {
  process.stdout.write('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  process.stdout.write('📋 历史消费数据分析报告\n');
  process.stdout.write('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n');

  process.stdout.write('📊 总体统计\n');
  process.stdout.write('────────────────────────────────────────────────\n');
  process.stdout.write(`  活跃用户数：      ${stats.totalActors}\n`);
  process.stdout.write(`  覆盖月份数：      ${stats.totalMonths}\n`);
  process.stdout.write(`  覆盖天数：        ${stats.totalDays}\n`);
  process.stdout.write(`  已结算记录数：    ${stats.totalSettledRecords}\n`);
  process.stdout.write(`  预占中记录数：    ${stats.totalReservedRecords}\n`);
  process.stdout.write(`  已结算总额：      ¥${stats.totalSettledAmount}\n`);
  process.stdout.write(`  最早记录日期：    ${stats.oldestRecord}\n`);
  process.stdout.write(`  最新记录日期：    ${stats.newestRecord}\n`);
  process.stdout.write('\n');

  process.stdout.write('👥 用户消费排行（Top 10）\n');
  process.stdout.write('────────────────────────────────────────────────\n');
  process.stdout.write('排名  用户名                记录数    总消费(¥)    首次-最后\n');
  process.stdout.write('────────────────────────────────────────────────\n');

  const top10 = stats.actorBreakdown.slice(0, 10);
  top10.forEach((actor, index) => {
    const rank = String(index + 1).padStart(2);
    const name = actor.name.padEnd(20).slice(0, 20);
    const count = String(actor.recordCount).padStart(6);
    const amount = String(actor.totalAmount).padStart(12);
    const dateRange = `${actor.earliestDate}~${actor.latestDate}`;
    process.stdout.write(`${rank}    ${name}  ${count}    ${amount}    ${dateRange}\n`);
  });

  if (stats.actorBreakdown.length > 10) {
    process.stdout.write(`... 还有 ${stats.actorBreakdown.length - 10} 个用户\n`);
  }

  process.stdout.write('\n');
  process.stdout.write('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n');
}

async function checkDataAvailability(prisma: PrismaClient): Promise<void> {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const sevenDaysKey = sevenDaysAgo.toISOString().slice(0, 10);

  const recentData = await prisma.taskBudgetReservation.count({
    where: {
      state: 'settled',
      dayKey: { gte: sevenDaysKey },
    },
  });

  process.stdout.write(`  最近7天已结算记录：${recentData}条\n`);

  if (recentData === 0) {
    process.stdout.write('⚠️  警告：最近7天没有已结算记录\n');
  } else {
    process.stdout.write('✅ 最近数据正常\n\n');
  }

  const orphanedRecords = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*) as count
    FROM task_budget_reservations tbr
    LEFT JOIN tasks t ON tbr.task_id = t.id
    WHERE t.id IS NULL
  `;

  const orphanedCount = Number(orphanedRecords[0]?.count || 0);
  if (orphanedCount > 0) {
    process.stdout.write(`⚠️  发现 ${orphanedCount} 条孤立记录（关联任务已被删除）\n`);
  } else {
    process.stdout.write('✅ 无孤立记录\n\n');
  }
}

async function main() {
  const prisma = new PrismaClient();

  try {
    process.stdout.write('🚀 开始历史消费数据分析\n\n');

    process.stdout.write('📊 验证数据完整性...\n\n');
    await validateDataIntegrity(prisma);

    process.stdout.write('📈 分析历史数据...\n\n');
    const stats = await analyzeHistoricalData(prisma);

    printReport(stats);

    process.stdout.write('🔍 检查数据可用性...\n\n');
    await checkDataAvailability(prisma);

    process.stdout.write('✅ 分析完成！\n\n');
    process.stdout.write('💡 说明：\n');
    process.stdout.write('   - TaskBudgetReservation表已包含完整历史数据\n');
    process.stdout.write('   - ConsumptionService.getTrends()直接从该表查询\n');
    process.stdout.write('   - 无需额外回填，数据已可用于趋势展示\n');
    process.stdout.write('   - 本脚本主要用于数据验证和报告生成\n\n');
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
