// 本仓的 spec 一律**直接构造**被测服务、手写依赖替身（见 production-submission.service.spec.ts
// 等），不用 @nestjs/testing：它 v12 是**纯 ESM**、没有 CJS 产物，而 Jest 跑在 CJS 模式，
// 连 `export * from './interfaces/index.js'` 都解析不了，整个 suite 一个断言都到不了。
jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target,
}));

import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { ConsumptionService } from './consumption.service';

describe('ConsumptionService', () => {
  let service: ConsumptionService;
  let prisma: any;

  beforeEach(() => {
    prisma = {
      actorCredential: { findUnique: jest.fn() },
      taskBudgetReservation: {
        aggregate: jest.fn(),
        groupBy: jest.fn(),
      },
    };

    service = new ConsumptionService(prisma as unknown as PrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getOverview', () => {
    it('should return consumption overview with settled and reserved amounts', async () => {
      // Mock credential with limits
      prisma.actorCredential.findUnique.mockResolvedValue({
        actorId: 'actor-1',
        dailyLimitCny: new Prisma.Decimal('100.000000'),
        monthlyLimitCny: new Prisma.Decimal('1000.000000'),
      });

      // Mock daily settled
      prisma.taskBudgetReservation.aggregate
        .mockResolvedValueOnce({
          _sum: { settledCny: new Prisma.Decimal('10.500000') },
          _count: 5,
        })
        // Mock daily reserved
        .mockResolvedValueOnce({
          _sum: { reservedCny: new Prisma.Decimal('5.250000') },
        })
        // Mock monthly settled
        .mockResolvedValueOnce({
          _sum: { settledCny: new Prisma.Decimal('50.000000') },
          _count: 20,
        })
        // Mock monthly reserved
        .mockResolvedValueOnce({
          _sum: { reservedCny: new Prisma.Decimal('15.000000') },
        });

      const result = await service.getOverview('actor-1');

      expect(result.daily.settled).toBe('10.500000');
      expect(result.daily.reserved).toBe('5.250000');
      expect(result.daily.taskCount).toBe(5);
      expect(result.daily.limit).toBe('100.000000');
      expect(result.daily.remaining).toBe('84.250000'); // 100 - 10.5 - 5.25

      expect(result.monthly.settled).toBe('50.000000');
      expect(result.monthly.reserved).toBe('15.000000');
      expect(result.monthly.taskCount).toBe(20);
      expect(result.monthly.limit).toBe('1000.000000');
      expect(result.monthly.remaining).toBe('935.000000'); // 1000 - 50 - 15
    });

    it('should return zero values when no consumption exists', async () => {
      prisma.actorCredential.findUnique.mockResolvedValue({
        actorId: 'actor-1',
        dailyLimitCny: new Prisma.Decimal('100.000000'),
        monthlyLimitCny: new Prisma.Decimal('1000.000000'),
      });

      // All aggregates return null
      prisma.taskBudgetReservation.aggregate
        .mockResolvedValueOnce({ _sum: { settledCny: null }, _count: 0 })
        .mockResolvedValueOnce({ _sum: { reservedCny: null } })
        .mockResolvedValueOnce({ _sum: { settledCny: null }, _count: 0 })
        .mockResolvedValueOnce({ _sum: { reservedCny: null } });

      const result = await service.getOverview('actor-1');

      expect(result.daily.settled).toBe('0.000000');
      expect(result.daily.reserved).toBe('0.000000');
      expect(result.daily.taskCount).toBe(0);
      expect(result.daily.remaining).toBe('100.000000');

      expect(result.monthly.settled).toBe('0.000000');
      expect(result.monthly.reserved).toBe('0.000000');
      expect(result.monthly.taskCount).toBe(0);
      expect(result.monthly.remaining).toBe('1000.000000');
    });

    it('should return null limits when credential has no limits configured', async () => {
      prisma.actorCredential.findUnique.mockResolvedValue({
        actorId: 'actor-1',
        dailyLimitCny: null,
        monthlyLimitCny: null,
      });

      prisma.taskBudgetReservation.aggregate
        .mockResolvedValueOnce({ _sum: { settledCny: new Prisma.Decimal('5.000000') }, _count: 2 })
        .mockResolvedValueOnce({ _sum: { reservedCny: null } })
        .mockResolvedValueOnce({ _sum: { settledCny: new Prisma.Decimal('10.000000') }, _count: 5 })
        .mockResolvedValueOnce({ _sum: { reservedCny: null } });

      const result = await service.getOverview('actor-1');

      expect(result.daily.limit).toBeNull();
      expect(result.daily.remaining).toBeNull();
      expect(result.monthly.limit).toBeNull();
      expect(result.monthly.remaining).toBeNull();
    });

    it('should handle credential not found', async () => {
      prisma.actorCredential.findUnique.mockResolvedValue(null);

      prisma.taskBudgetReservation.aggregate
        .mockResolvedValueOnce({ _sum: { settledCny: new Prisma.Decimal('5.000000') }, _count: 2 })
        .mockResolvedValueOnce({ _sum: { reservedCny: null } })
        .mockResolvedValueOnce({ _sum: { settledCny: new Prisma.Decimal('10.000000') }, _count: 5 })
        .mockResolvedValueOnce({ _sum: { reservedCny: null } });

      const result = await service.getOverview('actor-1');

      expect(result.daily.limit).toBeNull();
      expect(result.monthly.limit).toBeNull();
    });
  });

  describe('getTrends', () => {
    it('should return consumption trends for specified days', async () => {
      prisma.taskBudgetReservation.groupBy.mockResolvedValue([
        {
          dayKey: '2026-09-13',
          _sum: { settledCny: new Prisma.Decimal('10.500000') },
          _count: 3,
        },
        {
          dayKey: '2026-09-14',
          _sum: { settledCny: new Prisma.Decimal('15.750000') },
          _count: 5,
        },
        {
          dayKey: '2026-09-15',
          _sum: { settledCny: new Prisma.Decimal('8.250000') },
          _count: 2,
        },
      ]);

      const result = await service.getTrends('actor-1', 7);

      expect(result.trends).toHaveLength(3);
      expect(result.trends[0]).toEqual({
        date: '2026-09-13',
        amount: '10.500000',
        taskCount: 3,
      });
      expect(result.trends[1]).toEqual({
        date: '2026-09-14',
        amount: '15.750000',
        taskCount: 5,
      });
      expect(result.trends[2]).toEqual({
        date: '2026-09-15',
        amount: '8.250000',
        taskCount: 2,
      });

      // Verify the query was called with correct parameters
      expect(prisma.taskBudgetReservation.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          by: ['dayKey'],
          where: expect.objectContaining({
            actorId: 'actor-1',
            state: 'settled',
            dayKey: expect.objectContaining({ gte: expect.any(String) }),
          }),
          orderBy: { dayKey: 'asc' },
        }),
      );
    });

    it('should return empty trends when no data exists', async () => {
      prisma.taskBudgetReservation.groupBy.mockResolvedValue([]);

      const result = await service.getTrends('actor-1', 30);

      expect(result.trends).toEqual([]);
    });

    it('should handle null settled amounts', async () => {
      prisma.taskBudgetReservation.groupBy.mockResolvedValue([
        {
          dayKey: '2026-09-15',
          _sum: { settledCny: null },
          _count: 0,
        },
      ]);

      const result = await service.getTrends('actor-1', 7);

      expect(result.trends[0].amount).toBe('0.000000');
      expect(result.trends[0].taskCount).toBe(0);
    });
  });
});
