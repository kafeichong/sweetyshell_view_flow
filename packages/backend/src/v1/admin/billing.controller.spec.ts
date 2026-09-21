import { BillingController } from './billing.controller';
import { BillingImportService } from './billing-import.service';
import { Decimal } from '@prisma/client/runtime/library';

describe('BillingController', () => {
  let controller: BillingController;
  let mockImportService: any;

  beforeEach(() => {
    mockImportService = {
      importAndPreview: jest.fn(),
      confirm: jest.fn(),
    };

    controller = new BillingController(mockImportService);
  });

  describe('POST /import', () => {
    it('calls importService.importAndPreview and returns preview', async () => {
      const preview = {
        monthKey: '2026-09',
        provider: 'volcengine',
        billTotal: new Decimal('100.00'),
        allocations: [],
        unallocatedCny: new Decimal('100.00'),
        existingBillId: 'bill-123',
        isAlreadyImported: true,
      };

      mockImportService.importAndPreview.mockResolvedValue(preview);

      const result = await controller.importAndPreview({
        monthKey: '2026-09',
        provider: 'volcengine',
      });

      expect(result).toEqual(preview);
      expect(mockImportService.importAndPreview).toHaveBeenCalledWith(
        '2026-09',
        'volcengine',
      );
    });
  });

  describe('POST /confirm', () => {
    it('calls importService.confirm and returns result', async () => {
      const confirmResult = {
        billId: 'bill-123',
        allocationCount: 5,
      };

      mockImportService.confirm.mockResolvedValue(confirmResult);

      const result = await controller.confirm({
        monthKey: '2026-09',
        provider: 'volcengine',
        userId: 'admin-1',
      });

      expect(result).toEqual(confirmResult);
      expect(mockImportService.confirm).toHaveBeenCalledWith(
        '2026-09',
        'volcengine',
        'admin-1',
      );
    });
  });
});
