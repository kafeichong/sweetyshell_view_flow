import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';

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
  async listAllTokens(): Promise<TokenInfo[]> {
    const credentials = await this.prisma.actorCredential.findMany({
      orderBy: { createdAt: 'desc' },
    });

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
