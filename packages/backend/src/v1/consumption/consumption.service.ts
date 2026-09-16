import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';

export interface ConsumptionOverview {
  daily: {
    settled: string;
    reserved: string;
    taskCount: number;
    limit: string | null;
    remaining: string | null;
  };
  monthly: {
    settled: string;
    reserved: string;
    taskCount: number;
    limit: string | null;
    remaining: string | null;
  };
}

export interface ConsumptionTrend {
  date: string;
  amount: string;
  taskCount: number;
}

@Injectable()
export class ConsumptionService {
  constructor(private readonly prisma: PrismaService) {}

  async getOverview(actorId: string): Promise<ConsumptionOverview> {
    const now = new Date();
    const shanghaiTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
    const dayKey = shanghaiTime.toISOString().split('T')[0];
    const monthKey = `${shanghaiTime.getFullYear()}-${String(shanghaiTime.getMonth() + 1).padStart(2, '0')}`;

    // 获取用户额度配置
    const credential = await this.prisma.actorCredential.findUnique({
      where: { actorId },
    });

    // 并行查询日消费和月消费
    const [dailySettled, dailyReserved, monthlySettled, monthlyReserved] = await Promise.all([
      // 日已结算
      this.prisma.taskBudgetReservation.aggregate({
        where: { actorId, dayKey, state: 'settled' },
        _sum: { settledCny: true },
        _count: true,
      }),
      // 日预占中
      this.prisma.taskBudgetReservation.aggregate({
        where: { actorId, dayKey, state: { in: ['reserved', 'review'] } },
        _sum: { reservedCny: true },
      }),
      // 月已结算
      this.prisma.taskBudgetReservation.aggregate({
        where: { actorId, monthKey, state: 'settled' },
        _sum: { settledCny: true },
        _count: true,
      }),
      // 月预占中
      this.prisma.taskBudgetReservation.aggregate({
        where: { actorId, monthKey, state: { in: ['reserved', 'review'] } },
        _sum: { reservedCny: true },
      }),
    ]);

    // 计算日消费
    const dailySettledAmount = dailySettled._sum.settledCny || new Prisma.Decimal(0);
    const dailyReservedAmount = dailyReserved._sum.reservedCny || new Prisma.Decimal(0);
    const dailyTotal = dailySettledAmount.add(dailyReservedAmount);

    // 计算月消费
    const monthlySettledAmount = monthlySettled._sum.settledCny || new Prisma.Decimal(0);
    const monthlyReservedAmount = monthlyReserved._sum.reservedCny || new Prisma.Decimal(0);
    const monthlyTotal = monthlySettledAmount.add(monthlyReservedAmount);

    // 计算剩余额度
    const dailyRemaining = credential?.dailyLimitCny
      ? credential.dailyLimitCny.sub(dailyTotal).toFixed(6)
      : null;
    const monthlyRemaining = credential?.monthlyLimitCny
      ? credential.monthlyLimitCny.sub(monthlyTotal).toFixed(6)
      : null;

    return {
      daily: {
        settled: dailySettledAmount.toFixed(6),
        reserved: dailyReservedAmount.toFixed(6),
        taskCount: dailySettled._count,
        limit: credential?.dailyLimitCny?.toFixed(6) || null,
        remaining: dailyRemaining,
      },
      monthly: {
        settled: monthlySettledAmount.toFixed(6),
        reserved: monthlyReservedAmount.toFixed(6),
        taskCount: monthlySettled._count,
        limit: credential?.monthlyLimitCny?.toFixed(6) || null,
        remaining: monthlyRemaining,
      },
    };
  }

  async getTrends(actorId: string, days: number): Promise<{ trends: ConsumptionTrend[] }> {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startDayKey = startDate.toISOString().split('T')[0];

    const trends = await this.prisma.taskBudgetReservation.groupBy({
      by: ['dayKey'],
      where: {
        actorId,
        state: 'settled',
        dayKey: { gte: startDayKey },
      },
      _sum: { settledCny: true },
      _count: true,
      orderBy: { dayKey: 'asc' },
    });

    return {
      trends: trends.map((t) => ({
        date: t.dayKey,
        amount: (t._sum.settledCny || new Prisma.Decimal(0)).toFixed(6),
        taskCount: t._count,
      })),
    };
  }
}
