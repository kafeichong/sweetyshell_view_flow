import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { VolcengineBillingClient } from './volcengine-billing.client';
import { BillingAllocationService, AllocationPreview } from './billing-allocation.service';
import { Decimal } from '@prisma/client/runtime/library';
import { createHash } from 'crypto';

export interface ImportPreview extends AllocationPreview {
  existingBillId: string | null;
  isAlreadyImported: boolean;
}

@Injectable()
export class BillingImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billingClient: VolcengineBillingClient,
    private readonly allocationService: BillingAllocationService,
  ) {}

  async importAndPreview(
    monthKey: string,
    provider: string,
  ): Promise<ImportPreview> {
    const existing = await this.prisma.monthlyProviderBill.findUnique({
      where: { provider_monthKey: { provider, monthKey } },
    });

    if (existing) {
      const preview = await this.allocationService.preview(monthKey, provider);
      return {
        ...preview,
        existingBillId: existing.id,
        isAlreadyImported: true,
      };
    }

    const snapshot = await this.billingClient.fetchMonth(monthKey);

    if (snapshot.provider !== provider) {
      throw new Error(
        `PROVIDER_MISMATCH:expected=${provider},actual=${snapshot.provider}`,
      );
    }

    const snapshotJson = JSON.stringify(snapshot);
    const sourceDigest = createHash('sha256')
      .update(snapshotJson)
      .digest('hex');

    const totalCny = new Decimal(snapshot.billPayableCny);

    const bill = await this.prisma.monthlyProviderBill.create({
      data: {
        provider,
        monthKey,
        detailCount: snapshot.detailCount,
        totalCny,
        sourceDigest,
        snapshotJson,
        lines: {
          create: snapshot.includedLines.map((line) => ({
            billDetailId: line.billDetailId,
            product: line.product,
            configuration: line.configuration,
            instanceId: line.instanceId,
            billingUnit: line.billingUnit,
            payableCny: line.payableCny,
          })),
        },
      },
    });

    const preview = await this.allocationService.preview(monthKey, provider);

    return {
      ...preview,
      existingBillId: bill.id,
      isAlreadyImported: false,
    };
  }

  async confirm(
    monthKey: string,
    provider: string,
    userId: string,
  ): Promise<{ billId: string; allocationCount: number }> {
    return this.allocationService.confirm(monthKey, provider, userId);
  }
}
