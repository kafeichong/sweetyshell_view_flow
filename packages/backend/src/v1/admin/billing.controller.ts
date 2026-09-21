import { Controller, Post, Body } from '@nestjs/common';
import { BillingImportService, ImportPreview } from './billing-import.service';
import { ImportBillingDto, ConfirmBillingDto } from './billing.dto';

@Controller('v1/admin/billing')
export class BillingController {
  constructor(private readonly importService: BillingImportService) {}

  @Post('import')
  async importAndPreview(
    @Body() dto: ImportBillingDto,
  ): Promise<ImportPreview> {
    return this.importService.importAndPreview(dto.monthKey, dto.provider);
  }

  @Post('confirm')
  async confirm(
    @Body() dto: ConfirmBillingDto,
  ): Promise<{ billId: string; allocationCount: number }> {
    return this.importService.confirm(dto.monthKey, dto.provider, dto.userId);
  }
}
