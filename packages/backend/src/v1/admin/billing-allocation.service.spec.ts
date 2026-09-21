import { BillingAllocationService } from './billing-allocation.service';
import { Decimal } from '@prisma/client/runtime/library';

describe('BillingAllocationService', () => {
  let service: BillingAllocationService;
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      monthlyProviderBill: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      task: {
        findMany: jest.fn(),
      },
    };
    service = new BillingAllocationService(mockPrisma);
  });

  describe('preview', () => {
    it('throws BILL_NOT_FOUND when bill does not exist', async () => {
      mockPrisma.monthlyProviderBill.findUnique.mockResolvedValue(null);

      await expect(service.preview('2026-09', 'volcengine')).rejects.toThrow(
        'BILL_NOT_FOUND:volcengine:2026-09',
      );
    });

    it('throws BILL_ALREADY_CONFIRMED when bill is already confirmed', async () => {
      mockPrisma.monthlyProviderBill.findUnique.mockResolvedValue({
        id: 'bill-123',
        provider: 'volcengine',
        monthKey: '2026-09',
        detailCount: 10,
        totalCny: new Decimal('100.00'),
        sourceDigest: 'abc123',
        snapshotJson: {},
        confirmedAt: new Date('2026-09-15T10:00:00Z'),
        confirmedBy: 'user-1',
        createdAt: new Date('2026-09-01T00:00:00Z'),
      });

      await expect(service.preview('2026-09', 'volcengine')).rejects.toThrow(
        'BILL_ALREADY_CONFIRMED:bill-123',
      );
    });

    it('returns zero allocations when no completed tasks exist', async () => {
      mockPrisma.monthlyProviderBill.findUnique.mockResolvedValue({
        id: 'bill-123',
        provider: 'volcengine',
        monthKey: '2026-09',
        detailCount: 10,
        totalCny: new Decimal('100.00'),
        sourceDigest: 'abc123',
        snapshotJson: {},
        confirmedAt: null,
        confirmedBy: null,
        createdAt: new Date('2026-09-01T00:00:00Z'),
      });

      mockPrisma.task.findMany.mockResolvedValue([]);

      const result = await service.preview('2026-09', 'volcengine');

      expect(result.allocations).toEqual([]);
      expect(result.unallocatedCny.toString()).toBe('100');
    });

    it('allocates bill proportionally by task duration', async () => {
      mockPrisma.monthlyProviderBill.findUnique.mockResolvedValue({
        id: 'bill-123',
        provider: 'volcengine',
        monthKey: '2026-09',
        detailCount: 10,
        totalCny: new Decimal('120.00'),
        sourceDigest: 'abc123',
        snapshotJson: {},
        confirmedAt: null,
        confirmedBy: null,
        createdAt: new Date('2026-09-01T00:00:00Z'),
      });

      mockPrisma.task.findMany.mockResolvedValue([
        {
          id: 'task-1',
          actorId: 'actor-1',
          createdAt: new Date('2026-09-10T10:00:00Z'),
          completedAt: new Date('2026-09-10T10:01:00Z'),
        },
        {
          id: 'task-2',
          actorId: 'actor-2',
          createdAt: new Date('2026-09-10T11:00:00Z'),
          completedAt: new Date('2026-09-10T11:02:00Z'),
        },
      ]);

      const result = await service.preview('2026-09', 'volcengine');

      expect(result.allocations).toHaveLength(2);
      expect(result.allocations[0].taskId).toBe('task-1');
      expect(result.allocations[0].durationSeconds).toBe(60);
      expect(result.allocations[0].proportionPercent).toBeCloseTo(33.33, 1);

      expect(result.allocations[1].taskId).toBe('task-2');
      expect(result.allocations[1].durationSeconds).toBe(120);
      expect(result.allocations[1].proportionPercent).toBeCloseTo(66.67, 1);

      const totalAllocated = result.allocations.reduce(
        (sum, a) => sum.add(a.allocatedCny),
        new Decimal(0),
      );
      expect(totalAllocated.add(result.unallocatedCny).toString()).toBe('120');
    });
  });

  describe('confirm', () => {
    it('marks bill as confirmed and returns allocation count', async () => {
      mockPrisma.monthlyProviderBill.findUnique.mockResolvedValue({
        id: 'bill-123',
        provider: 'volcengine',
        monthKey: '2026-09',
        detailCount: 10,
        totalCny: new Decimal('100.00'),
        sourceDigest: 'abc123',
        snapshotJson: {},
        confirmedAt: null,
        confirmedBy: null,
        createdAt: new Date('2026-09-01T00:00:00Z'),
      });

      mockPrisma.task.findMany.mockResolvedValue([
        {
          id: 'task-1',
          actorId: 'actor-1',
          createdAt: new Date('2026-09-10T10:00:00Z'),
          completedAt: new Date('2026-09-10T10:01:00Z'),
        },
      ]);

      mockPrisma.monthlyProviderBill.update.mockResolvedValue({
        id: 'bill-123',
        provider: 'volcengine',
        monthKey: '2026-09',
        detailCount: 10,
        totalCny: new Decimal('100.00'),
        sourceDigest: 'abc123',
        snapshotJson: {},
        confirmedAt: new Date(),
        confirmedBy: 'admin-1',
        createdAt: new Date('2026-09-01T00:00:00Z'),
      });

      const result = await service.confirm('2026-09', 'volcengine', 'admin-1');

      expect(result.billId).toBe('bill-123');
      expect(result.allocationCount).toBe(1);
      expect(mockPrisma.monthlyProviderBill.update).toHaveBeenCalledWith({
        where: { provider_monthKey: { provider: 'volcengine', monthKey: '2026-09' } },
        data: {
          confirmedAt: expect.any(Date),
          confirmedBy: 'admin-1',
        },
      });
    });
  });
});
