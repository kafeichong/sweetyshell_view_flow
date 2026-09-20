// 本仓的 spec 一律**直接构造**被测服务、手写依赖替身
jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target,
}));

import { PrismaService } from '../../prisma.service';
import { TokenManagementService } from './token-management.service';
import { Prisma } from '@prisma/client';

describe('TokenManagementService', () => {
  let service: TokenManagementService;
  let prisma: any;

  beforeEach(() => {
    prisma = {
      tokenUsageLog: {
        create: jest.fn(),
        findMany: jest.fn(),
        deleteMany: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
      },
      actorCredential: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
      },
      taskBudgetReservation: {
        groupBy: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
      },
      task: {
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn(),
      },
      asset: { count: jest.fn().mockResolvedValue(0) },
      preflightRecord: { count: jest.fn().mockResolvedValue(0) },
      costAlert: { count: jest.fn().mockResolvedValue(0) },
      costReconciliation: { count: jest.fn().mockResolvedValue(0) },
      $transaction: jest.fn((operations) => Promise.all(operations)),
    };

    service = new TokenManagementService(prisma as unknown as PrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('logTokenUsage', () => {
    it('should create usage log and update credential stats', async () => {
      const actorId = 'actor-1';
      const endpoint = '/v1/consumption/overview';
      const method = 'GET';
      const statusCode = 200;
      const ipAddress = '192.168.1.100';
      const userAgent = 'Mozilla/5.0';

      prisma.tokenUsageLog.create.mockResolvedValue({});
      prisma.actorCredential.update.mockResolvedValue({});
      prisma.$transaction.mockImplementation((ops) => Promise.all(ops));

      await service.logTokenUsage(actorId, endpoint, method, statusCode, ipAddress, userAgent);

      expect(prisma.$transaction).toHaveBeenCalledWith([
        expect.anything(),
        expect.anything(),
      ]);
      expect(prisma.tokenUsageLog.create).toHaveBeenCalledWith({
        data: {
          actorId,
          endpoint,
          method,
          statusCode,
          ipAddress,
          userAgent,
        },
      });
      expect(prisma.actorCredential.update).toHaveBeenCalledWith({
        where: { actorId },
        data: {
          lastUsedAt: expect.any(Date),
          lastIpAddress: ipAddress,
          usageCount: { increment: 1 },
        },
      });
    });

    it('should handle missing optional fields', async () => {
      const actorId = 'actor-1';
      const endpoint = '/v1/tasks';
      const method = 'POST';
      const statusCode = 201;

      prisma.$transaction.mockImplementation((ops) => Promise.all(ops));

      await service.logTokenUsage(actorId, endpoint, method, statusCode);

      expect(prisma.tokenUsageLog.create).toHaveBeenCalledWith({
        data: {
          actorId,
          endpoint,
          method,
          statusCode,
          ipAddress: null,
          userAgent: null,
        },
      });
    });
  });

  describe('getTokenInfo', () => {
    it('should return token information', async () => {
      const credential = {
        actorId: 'actor-1',
        name: 'creative-pilot',
        status: 'active',
        createdAt: new Date('2026-09-01'),
        lastUsedAt: new Date('2026-09-17'),
        lastIpAddress: '192.168.1.100',
        usageCount: 1523,
        dailyLimitCny: new Prisma.Decimal('100.000000'),
        monthlyLimitCny: new Prisma.Decimal('500.000000'),
      };

      prisma.actorCredential.findUnique.mockResolvedValue(credential);

      const result = await service.getTokenInfo('actor-1');

      expect(result).toEqual({
        actorId: 'actor-1',
        name: 'creative-pilot',
        status: 'active',
        createdAt: credential.createdAt,
        lastUsedAt: credential.lastUsedAt,
        lastIpAddress: '192.168.1.100',
        usageCount: 1523,
        dailyLimitCny: '100.000000',
        monthlyLimitCny: '500.000000',
      });
    });

    it('should return null if credential not found', async () => {
      prisma.actorCredential.findUnique.mockResolvedValue(null);

      const result = await service.getTokenInfo('non-existent');

      expect(result).toBeNull();
    });

    it('should handle null limits', async () => {
      const credential = {
        actorId: 'actor-1',
        name: 'test-user',
        status: 'active',
        createdAt: new Date(),
        lastUsedAt: null,
        lastIpAddress: null,
        usageCount: 0,
        dailyLimitCny: null,
        monthlyLimitCny: null,
      };

      prisma.actorCredential.findUnique.mockResolvedValue(credential);

      const result = await service.getTokenInfo('actor-1');

      expect(result?.dailyLimitCny).toBeNull();
      expect(result?.monthlyLimitCny).toBeNull();
    });
  });

  describe('getUsageLogs', () => {
    it('should return paginated usage logs', async () => {
      const logs = [
        {
          id: 'log-1',
          actorId: 'actor-1',
          endpoint: '/v1/consumption/overview',
          method: 'GET',
          statusCode: 200,
          ipAddress: '192.168.1.100',
          createdAt: new Date('2026-09-17T10:00:00Z'),
        },
        {
          id: 'log-2',
          actorId: 'actor-1',
          endpoint: '/v1/tasks',
          method: 'POST',
          statusCode: 201,
          ipAddress: '192.168.1.101',
          createdAt: new Date('2026-09-17T09:00:00Z'),
        },
      ];

      prisma.tokenUsageLog.findMany.mockResolvedValue(logs);

      const result = await service.getUsageLogs('actor-1', 100);

      expect(result.logs).toHaveLength(2);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
      expect(result.logs[0]).toEqual({
        endpoint: '/v1/consumption/overview',
        method: 'GET',
        statusCode: 200,
        ipAddress: '192.168.1.100',
        createdAt: logs[0].createdAt,
      });
    });

    it('should handle cursor pagination', async () => {
      const logs = Array.from({ length: 11 }, (_, i) => ({
        id: `log-${i}`,
        actorId: 'actor-1',
        endpoint: '/v1/test',
        method: 'GET',
        statusCode: 200,
        ipAddress: null,
        createdAt: new Date(),
      }));

      prisma.tokenUsageLog.findMany.mockResolvedValue(logs);

      const result = await service.getUsageLogs('actor-1', 10);

      expect(result.logs).toHaveLength(10);
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBe('log-9');
    });

    it('should pass cursor to prisma query', async () => {
      prisma.tokenUsageLog.findMany.mockResolvedValue([]);

      await service.getUsageLogs('actor-1', 50, 'cursor-123');

      expect(prisma.tokenUsageLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          cursor: { id: 'cursor-123' },
          skip: 1,
        }),
      );
    });
  });

  describe('listAllTokens', () => {
    it('should return all tokens for admin', async () => {
      const credentials = [
        {
          actorId: 'actor-1',
          name: 'user-1',
          status: 'active',
          createdAt: new Date('2026-09-01'),
          lastUsedAt: new Date('2026-09-17'),
          lastIpAddress: '192.168.1.100',
          usageCount: 100,
          dailyLimitCny: new Prisma.Decimal('100.000000'),
          monthlyLimitCny: new Prisma.Decimal('500.000000'),
        },
        {
          actorId: 'actor-2',
          name: 'user-2',
          status: 'active',
          createdAt: new Date('2026-09-10'),
          lastUsedAt: null,
          lastIpAddress: null,
          usageCount: 0,
          dailyLimitCny: null,
          monthlyLimitCny: null,
        },
      ];

      prisma.actorCredential.findMany.mockResolvedValue(credentials);
      prisma.taskBudgetReservation.groupBy
        .mockResolvedValueOnce([
          { actorId: 'actor-1', _sum: { settledCny: new Prisma.Decimal('3.250000') } },
        ])
        .mockResolvedValueOnce([
          { actorId: 'actor-1', _sum: { settledCny: new Prisma.Decimal('42.500000') } },
        ])
        .mockResolvedValueOnce([
          { actorId: 'actor-1', state: 'reserved', _sum: { reservedCny: new Prisma.Decimal('5.000000') } },
          { actorId: 'actor-1', state: 'review', _sum: { reservedCny: new Prisma.Decimal('7.500000') } },
        ]);
      prisma.task.groupBy
        .mockResolvedValueOnce([
          { actorId: 'actor-1', _count: { _all: 10 } },
          { actorId: 'actor-2', _count: { _all: 2 } },
        ])
        .mockResolvedValueOnce([
          { createdBy: 'actor-1', _count: { _all: 1 } },
        ])
        .mockResolvedValueOnce([
          { actorId: 'actor-1', _count: { _all: 3 } },
          { actorId: 'actor-2', _count: { _all: 1 } },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { actorId: 'actor-1', _count: { _all: 8 } },
          { actorId: 'actor-2', _count: { _all: 1 } },
        ])
        .mockResolvedValueOnce([
          { createdBy: 'actor-1', _count: { _all: 1 } },
        ]);

      const result = await service.listAllTokens();

      expect(result).toHaveLength(2);
      expect(result[0].actorId).toBe('actor-1');
      expect(result[1].actorId).toBe('actor-2');
      expect(result[0].canDelete).toBe(false);
      expect(result[1].canDelete).toBe(true);
      expect(result[0].businessUsage).toEqual({
        totalTasks: 11,
        monthlyTasks: 3,
        successfulTasks: 9,
      });
      expect(result[1].businessUsage).toEqual({
        totalTasks: 2,
        monthlyTasks: 1,
        successfulTasks: 1,
      });
      expect(result[0].spending).toEqual({
        dailySettled: '3.250000',
        monthlySettled: '42.500000',
        reserved: '5.000000',
        review: '7.500000',
      });
      expect(result[1].spending).toEqual({
        dailySettled: '0.000000',
        monthlySettled: '0.000000',
        reserved: '0.000000',
        review: '0.000000',
      });
    });
  });

  describe('cleanupOldLogs', () => {
    it('should delete logs older than specified days', async () => {
      prisma.tokenUsageLog.deleteMany.mockResolvedValue({ count: 1523 });

      const result = await service.cleanupOldLogs(90);

      expect(result).toBe(1523);
      expect(prisma.tokenUsageLog.deleteMany).toHaveBeenCalledWith({
        where: {
          createdAt: { lt: expect.any(Date) },
        },
      });
    });

    it('should use default 90 days if not specified', async () => {
      prisma.tokenUsageLog.deleteMany.mockResolvedValue({ count: 500 });

      await service.cleanupOldLogs();

      expect(prisma.tokenUsageLog.deleteMany).toHaveBeenCalled();
    });

    it('should calculate correct cutoff date', async () => {
      const now = new Date('2026-09-17T00:00:00Z');
      jest.useFakeTimers();
      jest.setSystemTime(now);

      prisma.tokenUsageLog.deleteMany.mockResolvedValue({ count: 0 });

      await service.cleanupOldLogs(30);

      const expectedCutoff = new Date('2026-08-18T00:00:00Z');
      expect(prisma.tokenUsageLog.deleteMany).toHaveBeenCalledWith({
        where: {
          createdAt: { lt: expectedCutoff },
        },
      });

      jest.useRealTimers();
    });
  });
});
