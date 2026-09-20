import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { hasActorBusinessData } from '../../auth/actor-data';

export interface TokenInfo {
  actorId: string;
  name: string;
  status: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  lastIpAddress: string | null;
  usageCount: number;
  dailyLimitCny: string | null;
  monthlyLimitCny: string | null;
}

export interface AdminTokenInfo extends TokenInfo {
  canDelete: boolean;
  businessUsage: {
    totalTasks: number;
    monthlyTasks: number;
    successfulTasks: number;
  };
  spending: {
    dailySettled: string;
    monthlySettled: string;
    reserved: string;
    review: string;
  };
}

export interface TokenUsageLogEntry {
  id: string;
  endpoint: string;
  method: string;
  statusCode: number;
  ipAddress: string | null;
  createdAt: Date;
}

@Injectable()
export class TokenManagementService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 记录Token使用日志
   */
  async logTokenUsage(
    actorId: string,
    endpoint: string,
    method: string,
    statusCode: number,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<void> {
    // 使用事务同时记录日志和更新使用统计
    await this.prisma.$transaction([
      // 创建使用日志
      this.prisma.tokenUsageLog.create({
        data: {
          actorId,
          endpoint,
          method,
          statusCode,
          ipAddress: ipAddress || null,
          userAgent: userAgent || null,
        },
      }),
      // 更新Token统计信息
      this.prisma.actorCredential.update({
        where: { actorId },
        data: {
          lastUsedAt: new Date(),
          lastIpAddress: ipAddress || null,
          usageCount: { increment: 1 },
        },
      }),
    ]);
  }

  /**
   * 获取Token信息
   */
  async getTokenInfo(actorId: string): Promise<TokenInfo | null> {
    const credential = await this.prisma.actorCredential.findUnique({
      where: { actorId },
    });

    if (!credential) {
      return null;
    }

    return {
      actorId: credential.actorId,
      name: credential.name,
      status: credential.status,
      createdAt: credential.createdAt,
      lastUsedAt: credential.lastUsedAt,
      lastIpAddress: credential.lastIpAddress,
      usageCount: credential.usageCount,
      dailyLimitCny: credential.dailyLimitCny?.toFixed(6) || null,
      monthlyLimitCny: credential.monthlyLimitCny?.toFixed(6) || null,
    };
  }

  /**
   * 获取Token使用日志（分页）
   */
  async getUsageLogs(
    actorId: string,
    limit: number = 100,
    cursor?: string,
  ): Promise<{ logs: TokenUsageLogEntry[]; nextCursor: string | null; hasMore: boolean }> {
    const logs = await this.prisma.tokenUsageLog.findMany({
      where: { actorId },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = logs.length > limit;
    const items = hasMore ? logs.slice(0, limit) : logs;
    const nextCursor = hasMore ? items[items.length - 1].id : null;

    return {
      logs: items.map((log) => ({
        id: log.id,
        endpoint: log.endpoint,
        method: log.method,
        statusCode: log.statusCode,
        ipAddress: log.ipAddress,
        createdAt: log.createdAt,
      })),
      nextCursor,
      hasMore,
    };
  }

  /**
   * 管理员：列出所有Token
   */
  async listAllTokens(): Promise<AdminTokenInfo[]> {
    const now = new Date();
    const shanghaiTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
    const dayKey = shanghaiTime.toISOString().split('T')[0];
    const monthKey = `${shanghaiTime.getFullYear()}-${String(shanghaiTime.getMonth() + 1).padStart(2, '0')}`;
    const monthStart = new Date(Date.UTC(
      shanghaiTime.getFullYear(),
      shanghaiTime.getMonth(),
      1,
    ) - 8 * 60 * 60 * 1000);
    const monthEnd = new Date(Date.UTC(
      shanghaiTime.getFullYear(),
      shanghaiTime.getMonth() + 1,
      1,
    ) - 8 * 60 * 60 * 1000);

    const [
      credentials,
      dailySettled,
      monthlySettled,
      outstanding,
      actorTotals,
      legacyTotals,
      actorMonthly,
      legacyMonthly,
      actorSuccessful,
      legacySuccessful,
    ] = await Promise.all([
      this.prisma.actorCredential.findMany({ orderBy: { createdAt: 'desc' } }),
      this.prisma.taskBudgetReservation.groupBy({
        by: ['actorId'],
        where: { dayKey, state: 'settled' },
        _sum: { settledCny: true },
      }),
      this.prisma.taskBudgetReservation.groupBy({
        by: ['actorId'],
        where: { monthKey, state: 'settled' },
        _sum: { settledCny: true },
      }),
      this.prisma.taskBudgetReservation.groupBy({
        by: ['actorId', 'state'],
        where: { state: { in: ['reserved', 'review'] } },
        _sum: { reservedCny: true },
      }),
      this.prisma.task.groupBy({
        by: ['actorId'],
        where: { actorId: { not: null }, status: { not: 'preview' } },
        _count: { _all: true },
      }),
      this.prisma.task.groupBy({
        by: ['createdBy'],
        where: { actorId: null, status: { not: 'preview' } },
        _count: { _all: true },
      }),
      this.prisma.task.groupBy({
        by: ['actorId'],
        where: {
          actorId: { not: null },
          status: { not: 'preview' },
          createdAt: { gte: monthStart, lt: monthEnd },
        },
        _count: { _all: true },
      }),
      this.prisma.task.groupBy({
        by: ['createdBy'],
        where: {
          actorId: null,
          status: { not: 'preview' },
          createdAt: { gte: monthStart, lt: monthEnd },
        },
        _count: { _all: true },
      }),
      this.prisma.task.groupBy({
        by: ['actorId'],
        where: {
          actorId: { not: null },
          status: { not: 'preview' },
          OR: [{ status: 'completed' }, { taskStatus: 'completed' }],
        },
        _count: { _all: true },
      }),
      this.prisma.task.groupBy({
        by: ['createdBy'],
        where: {
          actorId: null,
          status: { not: 'preview' },
          OR: [{ status: 'completed' }, { taskStatus: 'completed' }],
        },
        _count: { _all: true },
      }),
    ]);

    const dailyMap = new Map(dailySettled.map((item) => [item.actorId, item._sum.settledCny]));
    const monthlyMap = new Map(monthlySettled.map((item) => [item.actorId, item._sum.settledCny]));
    const outstandingMap = new Map(
      outstanding.map((item) => [`${item.actorId}:${item.state}`, item._sum.reservedCny]),
    );
    const totalTasksMap = mergeTaskCounts(actorTotals, legacyTotals);
    const monthlyTasksMap = mergeTaskCounts(actorMonthly, legacyMonthly);
    const successfulTasksMap = mergeTaskCounts(actorSuccessful, legacySuccessful);
    const deletableByActor = new Map(await Promise.all(
      credentials.map(async (credential) => [
        credential.actorId,
        credential.usageCount === 0 && !await hasActorBusinessData(this.prisma, credential.actorId),
      ] as const),
    ));
    const zero = new Prisma.Decimal(0);

    return credentials.map((cred) => ({
      actorId: cred.actorId,
      name: cred.name,
      status: cred.status,
      createdAt: cred.createdAt,
      lastUsedAt: cred.lastUsedAt,
      lastIpAddress: cred.lastIpAddress,
      usageCount: cred.usageCount,
      dailyLimitCny: cred.dailyLimitCny?.toFixed(6) || null,
      monthlyLimitCny: cred.monthlyLimitCny?.toFixed(6) || null,
      canDelete: deletableByActor.get(cred.actorId) ?? false,
      businessUsage: {
        totalTasks: totalTasksMap.get(cred.actorId) ?? 0,
        monthlyTasks: monthlyTasksMap.get(cred.actorId) ?? 0,
        successfulTasks: successfulTasksMap.get(cred.actorId) ?? 0,
      },
      spending: {
        dailySettled: (dailyMap.get(cred.actorId) || zero).toFixed(6),
        monthlySettled: (monthlyMap.get(cred.actorId) || zero).toFixed(6),
        reserved: (outstandingMap.get(`${cred.actorId}:reserved`) || zero).toFixed(6),
        review: (outstandingMap.get(`${cred.actorId}:review`) || zero).toFixed(6),
      },
    }));
  }

  /**
   * 清理旧日志（保留最近90天）
   */
  async cleanupOldLogs(daysToKeep: number = 90): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    const result = await this.prisma.tokenUsageLog.deleteMany({
      where: {
        createdAt: { lt: cutoffDate },
      },
    });

    return result.count;
  }
}

function mergeTaskCounts(
  actorRows: Array<{ actorId: string | null; _count: { _all: number } }>,
  legacyRows: Array<{ createdBy: string; _count: { _all: number } }>,
) {
  const result = new Map<string, number>();
  for (const row of actorRows) {
    if (row.actorId) result.set(row.actorId, (result.get(row.actorId) ?? 0) + row._count._all);
  }
  for (const row of legacyRows) {
    result.set(row.createdBy, (result.get(row.createdBy) ?? 0) + row._count._all);
  }
  return result;
}
