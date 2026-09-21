// 本仓的 spec 一律**直接构造**被测服务、手写依赖替身
jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target,
  BadRequestException: class BadRequestException extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'BadRequestException';
    }
  },
}));

import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { ReconciliationService } from './reconciliation.service';

describe('ReconciliationService', () => {
  let service: ReconciliationService;
  let prisma: any;

  beforeEach(() => {
    prisma = {
      costReconciliation: {
        upsert: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
      },
      taskBudgetReservation: {
        aggregate: jest.fn(),
      },
    };

    service = new ReconciliationService(prisma as unknown as PrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('submitReconciliation', () => {
    it('should create new reconciliation record', async () => {
      const input = {
        monthKey: '2026-09',
        actorId: 'actor-1',
        providerBillCny: '125.50',
        evidenceUrl: 'https://example.com/bill.pdf',
        notes: '9月账单',
        reconciledBy: 'admin',
      };

      // Mock系统总额查询
      prisma.taskBudgetReservation.aggregate.mockResolvedValue({
        _sum: { settledCny: new Prisma.Decimal('123.45') },
      });

      // Mock upsert
      const createdRecord = {
        id: 'recon-1',
        monthKey: '2026-09',
        actorId: 'actor-1',
        systemTotalCny: new Prisma.Decimal('123.450000'),
        providerBillCny: new Prisma.Decimal('125.500000'),
        varianceCny: new Prisma.Decimal('2.050000'),
        variancePercent: new Prisma.Decimal('1.66'),
        evidenceUrl: 'https://example.com/bill.pdf',
        notes: '9月账单',
        reconciledBy: 'admin',
        reconciledAt: new Date('2026-10-05'),
        createdAt: new Date('2026-10-05'),
      };
      prisma.costReconciliation.upsert.mockResolvedValue(createdRecord);

      const result = await service.submitReconciliation(input);

      expect(result.monthKey).toBe('2026-09');
      expect(result.systemTotalCny).toBe('123.450000');
      expect(result.providerBillCny).toBe('125.500000');
      expect(result.varianceCny).toBe('2.050000');
      expect(result.variancePercent).toBe('1.66');
    });

    it('should handle global reconciliation (no actorId)', async () => {
      const input = {
        monthKey: '2026-09',
        providerBillCny: '500.00',
        reconciledBy: 'admin',
      };

      prisma.taskBudgetReservation.aggregate.mockResolvedValue({
        _sum: { settledCny: new Prisma.Decimal('495.00') },
      });

      const createdRecord = {
        id: 'recon-1',
        monthKey: '2026-09',
        actorId: null,
        systemTotalCny: new Prisma.Decimal('495.000000'),
        providerBillCny: new Prisma.Decimal('500.000000'),
        varianceCny: new Prisma.Decimal('5.000000'),
        variancePercent: new Prisma.Decimal('1.01'),
        evidenceUrl: null,
        notes: null,
        reconciledBy: 'admin',
        reconciledAt: new Date(),
        createdAt: new Date(),
      };
      prisma.costReconciliation.upsert.mockResolvedValue(createdRecord);

      const result = await service.submitReconciliation(input);

      expect(result.actorId).toBeNull();
      expect(prisma.taskBudgetReservation.aggregate).toHaveBeenCalledWith({
        where: {
          monthKey: '2026-09',
          state: 'settled',
        },
        _sum: { settledCny: true },
      });
    });

    it('should calculate negative variance when system total exceeds bill', async () => {
      const input = {
        monthKey: '2026-09',
        providerBillCny: '100.00',
        reconciledBy: 'admin',
      };

      prisma.taskBudgetReservation.aggregate.mockResolvedValue({
        _sum: { settledCny: new Prisma.Decimal('110.00') },
      });

      const createdRecord = {
        id: 'recon-1',
        monthKey: '2026-09',
        actorId: null,
        systemTotalCny: new Prisma.Decimal('110.000000'),
        providerBillCny: new Prisma.Decimal('100.000000'),
        varianceCny: new Prisma.Decimal('-10.000000'),
        variancePercent: new Prisma.Decimal('9.09'),
        evidenceUrl: null,
        notes: null,
        reconciledBy: 'admin',
        reconciledAt: new Date(),
        createdAt: new Date(),
      };
      prisma.costReconciliation.upsert.mockResolvedValue(createdRecord);

      const result = await service.submitReconciliation(input);

      expect(result.varianceCny).toBe('-10.000000');
    });

    it('should handle zero system total', async () => {
      const input = {
        monthKey: '2026-09',
        providerBillCny: '0.00',
        reconciledBy: 'admin',
      };

      prisma.taskBudgetReservation.aggregate.mockResolvedValue({
        _sum: { settledCny: null }, // No settled transactions
      });

      const createdRecord = {
        id: 'recon-1',
        monthKey: '2026-09',
        actorId: null,
        systemTotalCny: new Prisma.Decimal('0.000000'),
        providerBillCny: new Prisma.Decimal('0.000000'),
        varianceCny: new Prisma.Decimal('0.000000'),
        variancePercent: new Prisma.Decimal('0.00'),
        evidenceUrl: null,
        notes: null,
        reconciledBy: 'admin',
        reconciledAt: new Date(),
        createdAt: new Date(),
      };
      prisma.costReconciliation.upsert.mockResolvedValue(createdRecord);

      const result = await service.submitReconciliation(input);

      expect(result.systemTotalCny).toBe('0.000000');
      expect(result.variancePercent).toBe('0.00');
    });

    it('should reject invalid monthKey format', async () => {
      const input = {
        monthKey: '2026-13', // Invalid month
        providerBillCny: '100.00',
        reconciledBy: 'admin',
      };

      // Mock aggregate to avoid undefined error
      prisma.taskBudgetReservation.aggregate.mockResolvedValue({
        _sum: { settledCny: new Prisma.Decimal('0') },
      });

      await expect(service.submitReconciliation(input)).rejects.toThrow(
        'monthKey must be in format YYYY-MM',
      );
    });

    it('should reject malformed monthKey', async () => {
      const input = {
        monthKey: '202609', // Missing dash
        providerBillCny: '100.00',
        reconciledBy: 'admin',
      };

      await expect(service.submitReconciliation(input)).rejects.toThrow();
    });

    it('should update existing reconciliation', async () => {
      const input = {
        monthKey: '2026-09',
        actorId: 'actor-1',
        providerBillCny: '130.00', // Updated amount
        reconciledBy: 'admin2',
      };

      prisma.taskBudgetReservation.aggregate.mockResolvedValue({
        _sum: { settledCny: new Prisma.Decimal('123.45') },
      });

      const updatedRecord = {
        id: 'recon-1',
        monthKey: '2026-09',
        actorId: 'actor-1',
        systemTotalCny: new Prisma.Decimal('123.450000'),
        providerBillCny: new Prisma.Decimal('130.000000'),
        varianceCny: new Prisma.Decimal('6.550000'),
        variancePercent: new Prisma.Decimal('5.31'),
        evidenceUrl: null,
        notes: null,
        reconciledBy: 'admin2',
        reconciledAt: new Date('2026-10-06'),
        createdAt: new Date('2026-10-05'),
      };
      prisma.costReconciliation.upsert.mockResolvedValue(updatedRecord);

      const result = await service.submitReconciliation(input);

      expect(result.reconciledBy).toBe('admin2');
      expect(prisma.costReconciliation.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            monthKey_actorId: {
              monthKey: '2026-09',
              actorId: 'actor-1',
            },
          },
          update: expect.anything(),
        }),
      );
    });
  });

  describe('getReconciliation', () => {
    it('should query a global reconciliation without passing null to a compound unique key', async () => {
      prisma.costReconciliation.findFirst.mockResolvedValue(null);

      const result = await service.getReconciliation('2026-09');

      expect(result).toBeNull();
      expect(prisma.costReconciliation.findFirst).toHaveBeenCalledWith({
        where: { monthKey: '2026-09', actorId: null },
      });
      expect(prisma.costReconciliation.findUnique).not.toHaveBeenCalled();
    });

    it('should return reconciliation record', async () => {
      const record = {
        id: 'recon-1',
        monthKey: '2026-09',
        actorId: 'actor-1',
        systemTotalCny: new Prisma.Decimal('123.450000'),
        providerBillCny: new Prisma.Decimal('125.500000'),
        varianceCny: new Prisma.Decimal('2.050000'),
        variancePercent: new Prisma.Decimal('1.66'),
        evidenceUrl: 'https://example.com/bill.pdf',
        notes: '9月账单',
        reconciledBy: 'admin',
        reconciledAt: new Date('2026-10-05'),
        createdAt: new Date('2026-10-05'),
      };

      prisma.costReconciliation.findUnique.mockResolvedValue(record);

      const result = await service.getReconciliation('2026-09', 'actor-1');

      expect(result).not.toBeNull();
      expect(result?.monthKey).toBe('2026-09');
      expect(result?.actorId).toBe('actor-1');
    });

    it('should return null if record not found', async () => {
      prisma.costReconciliation.findUnique.mockResolvedValue(null);

      const result = await service.getReconciliation('2026-08', 'actor-1');

      expect(result).toBeNull();
    });
  });

  describe('getReconciliationsByMonth', () => {
    it('should return all reconciliations for a month', async () => {
      const records = [
        {
          id: 'recon-1',
          monthKey: '2026-09',
          actorId: null,
          systemTotalCny: new Prisma.Decimal('500.000000'),
          providerBillCny: new Prisma.Decimal('505.000000'),
          varianceCny: new Prisma.Decimal('5.000000'),
          variancePercent: new Prisma.Decimal('1.00'),
          evidenceUrl: null,
          notes: null,
          reconciledBy: 'admin',
          reconciledAt: new Date(),
          createdAt: new Date(),
        },
        {
          id: 'recon-2',
          monthKey: '2026-09',
          actorId: 'actor-1',
          systemTotalCny: new Prisma.Decimal('123.450000'),
          providerBillCny: new Prisma.Decimal('125.500000'),
          varianceCny: new Prisma.Decimal('2.050000'),
          variancePercent: new Prisma.Decimal('1.66'),
          evidenceUrl: null,
          notes: null,
          reconciledBy: 'admin',
          reconciledAt: new Date(),
          createdAt: new Date(),
        },
      ];

      prisma.costReconciliation.findMany.mockResolvedValue(records);

      const result = await service.getReconciliationsByMonth('2026-09');

      expect(result).toHaveLength(2);
      expect(result[0].actorId).toBeNull();
      expect(result[1].actorId).toBe('actor-1');
    });

    it('should return empty array if no records', async () => {
      prisma.costReconciliation.findMany.mockResolvedValue([]);

      const result = await service.getReconciliationsByMonth('2026-08');

      expect(result).toEqual([]);
    });
  });
});
