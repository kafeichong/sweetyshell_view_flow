import { Injectable, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';

export interface ReconciliationInput {
  monthKey: string;
  actorId?: string;
  providerBillCny: string;
  evidenceUrl?: string;
  notes?: string;
  reconciledBy: string;
}

export interface ReconciliationRecord {
  id: string;
  monthKey: string;
  actorId: string | null;
  systemTotalCny: string;
  providerBillCny: string;
  varianceCny: string;
  variancePercent: string;
  evidenceUrl: string | null;
  notes: string | null;
  reconciledBy: string;
  reconciledAt: Date;
  createdAt: Date;
}

@Injectable()
export class ReconciliationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 提交对账记录
   */
  async submitReconciliation(input: ReconciliationInput): Promise<ReconciliationRecord> {
    // 验证月份格式 (YYYY-MM)
    if (!/^\d{4}-\d{2}$/.test(input.monthKey)) {
      throw new BadRequestException('monthKey must be in format YYYY-MM');
    }

    // 验证月份范围 (01-12)
    const month = parseInt(input.monthKey.split('-')[1], 10);
    if (month < 1 || month > 12) {
      throw new BadRequestException('monthKey must be in format YYYY-MM');
    }

    // 计算系统总额
    const systemTotal = await this.calculateSystemTotal(input.monthKey, input.actorId);

    // 计算差异
    const providerBill = new Prisma.Decimal(input.providerBillCny);
    const variance = providerBill.sub(systemTotal);
    const variancePercent = systemTotal.isZero()
      ? new Prisma.Decimal(0)
      : variance.div(systemTotal).mul(100).abs();

    // 创建或更新对账记录
    const record = await this.prisma.costReconciliation.upsert({
      where: {
        monthKey_actorId: {
          monthKey: input.monthKey,
          actorId: input.actorId || null,
        },
      },
      create: {
        monthKey: input.monthKey,
        actorId: input.actorId || null,
        systemTotalCny: systemTotal,
        providerBillCny: providerBill,
        varianceCny: variance,
        variancePercent: variancePercent,
        evidenceUrl: input.evidenceUrl || null,
        notes: input.notes || null,
        reconciledBy: input.reconciledBy,
        reconciledAt: new Date(),
      },
      update: {
        systemTotalCny: systemTotal,
        providerBillCny: providerBill,
        varianceCny: variance,
        variancePercent: variancePercent,
        evidenceUrl: input.evidenceUrl || null,
        notes: input.notes || null,
        reconciledBy: input.reconciledBy,
        reconciledAt: new Date(),
      },
    });

    return this.mapToRecord(record);
  }

  /**
   * 获取对账记录
   */
  async getReconciliation(monthKey: string, actorId?: string): Promise<ReconciliationRecord | null> {
    const record = actorId
      ? await this.prisma.costReconciliation.findUnique({
          where: {
            monthKey_actorId: {
              monthKey,
              actorId,
            },
          },
        })
      : await this.prisma.costReconciliation.findFirst({
          where: {
            monthKey,
            actorId: null,
          },
        });

    return record ? this.mapToRecord(record) : null;
  }

  /**
   * 获取月份的所有对账记录
   */
  async getReconciliationsByMonth(monthKey: string): Promise<ReconciliationRecord[]> {
    const records = await this.prisma.costReconciliation.findMany({
      where: { monthKey },
      orderBy: { actorId: 'asc' },
    });

    return records.map((r) => this.mapToRecord(r));
  }

  /**
   * 获取所有对账记录
   */
  async getAllReconciliations(): Promise<{ records: ReconciliationRecord[] }> {
    const records = await this.prisma.costReconciliation.findMany({
      orderBy: [
        { monthKey: 'desc' },
        { actorId: 'asc' }
      ],
      take: 100, // 限制返回最近100条记录
    });

    return {
      records: records.map((r) => this.mapToRecord(r))
    };
  }

  /**
   * 计算系统总额
   */
  private async calculateSystemTotal(monthKey: string, actorId?: string): Promise<Prisma.Decimal> {
    const result = await this.prisma.taskBudgetReservation.aggregate({
      where: {
        monthKey,
        state: 'settled',
        ...(actorId ? { actorId } : {}),
      },
      _sum: { settledCny: true },
    });

    return result._sum.settledCny || new Prisma.Decimal(0);
  }

  /**
   * 映射到返回格式
   */
  private mapToRecord(record: any): ReconciliationRecord {
    return {
      id: record.id,
      monthKey: record.monthKey,
      actorId: record.actorId,
      systemTotalCny: record.systemTotalCny.toFixed(6),
      providerBillCny: record.providerBillCny.toFixed(6),
      varianceCny: record.varianceCny.toFixed(6),
      variancePercent: record.variancePercent.toFixed(2),
      evidenceUrl: record.evidenceUrl,
      notes: record.notes,
      reconciledBy: record.reconciledBy,
      reconciledAt: record.reconciledAt,
      createdAt: record.createdAt,
    };
  }
}
