import { BillingImportService } from './billing-import.service';
import { VolcengineBillingClient } from './volcengine-billing.client';
import { BillingAllocationService } from './billing-allocation.service';
import { Decimal } from '@prisma/client/runtime/library';

describe('BillingImportService', () => {
  let service: BillingImportService;
  let mockPrisma: any;
  let mockBillingClient: any;
  let mockAllocationService: any;

  beforeEach(() => {
    mockPrisma = {
      monthlyProviderBill: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
    };

    mockBillingClient = {
      fetchMonth: jest.fn(),
    };

    mockAllocationService = {
      preview: jest.fn(),
      confirm: jest.fn(),
    };

    service = new BillingImportService(
      mockPrisma,
      mockBillingClient,
      mockAllocationService,
    );
  });

  describe('importAndPreview', () => {
    it('returns existing bill preview when already imported', async () => {
      mockPrisma.monthlyProviderBill.findUnique.mockResolvedValue({
        id: 'existing-bill-123',
        provider: 'volcengine',
        monthKey: '2026-09',
        detailCount: 5,
        totalCny: new Decimal('100.00'),
        sourceDigest: 'abc123',
        snapshotJson: {},
        confirmedAt: null,
        confirmedBy: null,
        createdAt: new Date(),
      });

      mockAllocationService.preview.mockResolvedValue({
        monthKey: '2026-09',
        provider: 'volcengine',
        billTotal: new Decimal('100.00'),
        allocations: [],
        unallocatedCny: new Decimal('100.00'),
      });

      const result = await service.importAndPreview('2026-09', 'volcengine');

      expect(result.existingBillId).toBe('existing-bill-123');
      expect(result.isAlreadyImported).toBe(true);
      expect(mockBillingClient.fetchMonth).not.toHaveBeenCalled();
    });

    it('imports new bill and creates database records', async () => {
      mockPrisma.monthlyProviderBill.findUnique.mockResolvedValue(null);

      mockBillingClient.fetchMonth.mockResolvedValue({
        provider: 'volcengine',
        monthKey: '2026-09',
        detailCount: 2,
        includedLines: [
          {
            billDetailId: 'detail-001',
            product: '视频生成-豆包',
            configuration: 'config-1',
            instanceId: 'inst-1',
            billingUnit: 'calls',
            payableCny: new Decimal('50.00'),
          },
          {
            billDetailId: 'detail-002',
            product: '视频生成-豆包',
            configuration: 'config-2',
            instanceId: 'inst-2',
            billingUnit: 'calls',
            payableCny: new Decimal('30.00'),
          },
        ],
        detailPayableCny: '80.000000',
        billPayableCny: '80.000000',
        sourceDigest: 'computed-digest',
      });

      mockPrisma.monthlyProviderBill.create.mockResolvedValue({
        id: 'new-bill-456',
        provider: 'volcengine',
        monthKey: '2026-09',
        detailCount: 2,
        totalCny: new Decimal('80.00'),
        sourceDigest: expect.any(String),
        snapshotJson: expect.any(Object),
        confirmedAt: null,
        confirmedBy: null,
        createdAt: new Date(),
      });

      mockAllocationService.preview.mockResolvedValue({
        monthKey: '2026-09',
        provider: 'volcengine',
        billTotal: new Decimal('80.00'),
        allocations: [],
        unallocatedCny: new Decimal('80.00'),
      });

      const result = await service.importAndPreview('2026-09', 'volcengine');

      expect(result.existingBillId).toBe('new-bill-456');
      expect(result.isAlreadyImported).toBe(false);
      expect(mockBillingClient.fetchMonth).toHaveBeenCalledWith('2026-09');
      expect(mockPrisma.monthlyProviderBill.create).toHaveBeenCalledWith({
        data: {
          provider: 'volcengine',
          monthKey: '2026-09',
          detailCount: 2,
          totalCny: new Decimal('80.00'),
          sourceDigest: expect.any(String),
          snapshotJson: expect.any(String),
          lines: {
            create: [
              {
                billDetailId: 'detail-001',
                product: '视频生成-豆包',
                configuration: 'config-1',
                instanceId: 'inst-1',
                billingUnit: 'calls',
                payableCny: new Decimal('50.00'),
              },
              {
                billDetailId: 'detail-002',
                product: '视频生成-豆包',
                configuration: 'config-2',
                instanceId: 'inst-2',
                billingUnit: 'calls',
                payableCny: new Decimal('30.00'),
              },
            ],
          },
        },
      });
    });

    it('throws PROVIDER_MISMATCH when snapshot provider does not match', async () => {
      mockPrisma.monthlyProviderBill.findUnique.mockResolvedValue(null);

      mockBillingClient.fetchMonth.mockResolvedValue({
        provider: 'aliyun',
        monthKey: '2026-09',
        detailCount: 0,
        includedLines: [],
        detailPayableCny: '0.000000',
        billPayableCny: '0.000000',
        sourceDigest: 'digest',
      });

      await expect(
        service.importAndPreview('2026-09', 'volcengine'),
      ).rejects.toThrow('PROVIDER_MISMATCH:expected=volcengine,actual=aliyun');
    });
  });

  describe('confirm', () => {
    it('delegates to allocation service confirm', async () => {
      mockAllocationService.confirm.mockResolvedValue({
        billId: 'bill-123',
        allocationCount: 5,
      });

      const result = await service.confirm('2026-09', 'volcengine', 'admin-1');

      expect(result.billId).toBe('bill-123');
      expect(result.allocationCount).toBe(5);
      expect(mockAllocationService.confirm).toHaveBeenCalledWith(
        '2026-09',
        'volcengine',
        'admin-1',
      );
    });
  });
});
