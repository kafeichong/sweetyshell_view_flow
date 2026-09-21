import { BillingImportService, ImportPreview } from './billing-import.service';
import { ImportBillingDto, ConfirmBillingDto } from './billing.dto';

export class BillingController {
  constructor(private readonly importService: BillingImportService) {}

  async importAndPreview(dto: ImportBillingDto): Promise<ImportPreview> {
    return this.importService.importAndPreview(dto.monthKey, dto.provider);
  }

  async confirm(
    dto: ConfirmBillingDto,
  ): Promise<{ billId: string; allocationCount: number }> {
    return this.importService.confirm(dto.monthKey, dto.provider, dto.userId);
  }
}
