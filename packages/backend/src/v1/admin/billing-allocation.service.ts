import { PrismaService } from '../../prisma.service';
import { Decimal } from '@prisma/client/runtime/library';

export interface AllocationPreview {
  monthKey: string;
  provider: string;
  billTotal: Decimal;
  allocations: TaskAllocation[];
  unallocatedCny: Decimal;
}

export interface TaskAllocation {
  taskId: string;
  actorId: string | null;
  durationSeconds: number;
  allocatedCny: Decimal;
  proportionPercent: number;
}

export class BillingAllocationService {
  constructor(private readonly prisma: PrismaService) {}

  async preview(monthKey: string, provider: string): Promise<AllocationPreview> {
    const bill = await this.prisma.monthlyProviderBill.findUnique({
      where: { provider_monthKey: { provider, monthKey } },
    });

    if (!bill) {
      throw new Error(`BILL_NOT_FOUND:${provider}:${monthKey}`);
    }

    if (bill.confirmedAt) {
      throw new Error(`BILL_ALREADY_CONFIRMED:${bill.id}`);
    }

    const [year, month] = monthKey.split('-').map(Number);
    const startDate = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
    const endDate = new Date(Date.UTC(year, month, 1, 0, 0, 0));

    const tasks = await this.prisma.task.findMany({
      where: {
        createdAt: { gte: startDate, lt: endDate },
        completedAt: { not: null },
        status: 'completed',
      },
      select: {
        id: true,
        actorId: true,
        createdAt: true,
        completedAt: true,
      },
    });

    let totalSeconds = 0;
    const taskDurations: Array<{
      taskId: string;
      actorId: string | null;
      durationSeconds: number;
    }> = [];

    for (const task of tasks) {
      if (!task.completedAt) continue;
      const durationMs = task.completedAt.getTime() - task.createdAt.getTime();
      const durationSeconds = Math.max(1, Math.floor(durationMs / 1000));
      totalSeconds += durationSeconds;
      taskDurations.push({
        taskId: task.id,
        actorId: task.actorId,
        durationSeconds,
      });
    }

    if (totalSeconds === 0) {
      return {
        monthKey,
        provider,
        billTotal: bill.totalCny,
        allocations: [],
        unallocatedCny: bill.totalCny,
      };
    }

    const allocations: TaskAllocation[] = [];
    let allocatedTotal = new Decimal(0);

    for (const { taskId, actorId, durationSeconds } of taskDurations) {
      const proportion = durationSeconds / totalSeconds;
      const allocatedCny = bill.totalCny.mul(proportion);
      allocations.push({
        taskId,
        actorId,
        durationSeconds,
        allocatedCny,
        proportionPercent: proportion * 100,
      });
      allocatedTotal = allocatedTotal.add(allocatedCny);
    }

    const unallocatedCny = bill.totalCny.sub(allocatedTotal);

    return {
      monthKey,
      provider,
      billTotal: bill.totalCny,
      allocations,
      unallocatedCny,
    };
  }

  async confirm(
    monthKey: string,
    provider: string,
    userId: string,
  ): Promise<{ billId: string; allocationCount: number }> {
    const preview = await this.preview(monthKey, provider);

    const bill = await this.prisma.monthlyProviderBill.update({
      where: { provider_monthKey: { provider, monthKey } },
      data: {
        confirmedAt: new Date(),
        confirmedBy: userId,
      },
    });

    return {
      billId: bill.id,
      allocationCount: preview.allocations.length,
    };
  }
}
