import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Prisma } from '@prisma/client';

export interface ExecutionPlan {
  version: string;
  model: string;
  duration: number;
  ratio: string;
  resolution: string;
  generate_audio: boolean;
  watermark: boolean;
  pricingVersion: string;
  reserveCny: string;
}

export interface ProductionTaskData {
  actorId: string;
  clientRequestId: string;
  estimatedCny: string;
  executionPlan: ExecutionPlan;
  task: {
    createdBy: string;
    prompt: string;
    status: string;
    capability?: string;
    workflowName?: string;
    requestSnapshot?: object;
    imageUrl?: string;
  };
}

export function fitsBudget(limit: string, used: string, reserve: string): boolean {
  return new Prisma.Decimal(used).add(reserve).lte(new Prisma.Decimal(limit));
}

@Injectable()
export class TaskBudgetService {
  private readonly logger = new Logger(TaskBudgetService.name);

  constructor(private readonly prisma: PrismaService) {}

  async createTaskWithReservation(data: ProductionTaskData) {
    return this.prisma.$transaction(async (tx) => {
      if (typeof (tx as any).$executeRaw === 'function') {
        await (tx as any).$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${data.actorId}, 0))`;
      }
      const gate = await tx.productionGate.findUnique({ where: { id: 'production' } });
      if (gate?.paused !== false) {
        throw new Error('PRODUCTION_PAUSED');
      }

      const budget = await this.checkBudgetAvailability(tx, data.actorId, data.estimatedCny);
      if (!budget.canProceed) {
        throw new Error(budget.reason ?? 'BUDGET_REJECTED');
      }

      const task = await tx.task.create({
        data: {
          ...data.task,
          actorId: data.actorId,
          clientRequestId: data.clientRequestId,
          executionPlan: data.executionPlan as unknown as Prisma.InputJsonValue,
          deliveryStatus: 'pending',
        },
      });

      await this.reserveInTransaction(tx, task.id, data.actorId, data.executionPlan);
      return task;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async reserveInTransaction(
    tx: Prisma.TransactionClient,
    taskId: string,
    actorId: string,
    executionPlan: ExecutionPlan,
  ): Promise<void> {
    const now = new Date();
    const shanghaiTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
    const dayKey = shanghaiTime.toISOString().split('T')[0];
    const monthKey = `${shanghaiTime.getFullYear()}-${String(shanghaiTime.getMonth() + 1).padStart(2, '0')}`;

    await tx.taskBudgetReservation.create({
      data: {
        taskId,
        actorId,
        reservedCny: new Prisma.Decimal(executionPlan.reserveCny),
        state: 'reserved',
        dayKey,
        monthKey,
        pricingVersion: executionPlan.pricingVersion,
      },
    });

    this.logger.log(`Reserved ${executionPlan.reserveCny} CNY for task ${taskId}, actor ${actorId}`);
  }

  async settleInTransaction(
    tx: Prisma.TransactionClient,
    taskId: string,
    amountCny: string,
  ): Promise<void> {
    const reservation = await tx.taskBudgetReservation.findUnique({
      where: { taskId },
    });

    if (!reservation) {
      throw new Error(`No reservation found for task ${taskId}`);
    }

    if (reservation.state === 'settled') {
      const existing = reservation.settledCny?.toString();
      if (existing === amountCny) {
        this.logger.log(`Task ${taskId} already settled with same amount, idempotent`);
        return;
      }
      throw new Error(`Task ${taskId} already settled with different amount`);
    }

    await tx.taskBudgetReservation.update({
      where: { taskId },
      data: {
        settledCny: new Prisma.Decimal(amountCny),
        state: 'settled',
        updatedAt: new Date(),
      },
    });

    this.logger.log(`Settled ${amountCny} CNY for task ${taskId}`);
  }

  async holdForReviewInTransaction(
    tx: Prisma.TransactionClient,
    taskId: string,
  ): Promise<void> {
    await tx.taskBudgetReservation.update({
      where: { taskId },
      data: {
        state: 'review',
        updatedAt: new Date(),
      },
    });

    this.logger.log(`Held task ${taskId} for review`);
  }

  async releaseInTransaction(
    tx: Prisma.TransactionClient,
    taskId: string,
    reason: string,
  ): Promise<void> {
    await tx.taskBudgetReservation.update({
      where: { taskId },
      data: {
        state: 'released',
        updatedAt: new Date(),
      },
    });

    this.logger.log(`Released reservation for task ${taskId}, reason: ${reason}`);
  }

  async checkBudgetAvailability(
    tx: Prisma.TransactionClient,
    actorId: string,
    reserveCny: string,
  ): Promise<{ canProceed: boolean; reason?: string }> {
    const credential = await tx.actorCredential.findUnique({
      where: { actorId },
    });

    if (!credential) {
      return { canProceed: false, reason: 'NO_CREDENTIAL' };
    }

    if (credential.status !== 'active') {
      return { canProceed: false, reason: 'CREDENTIAL_INACTIVE' };
    }

    const now = new Date();
    const shanghaiTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
    const dayKey = shanghaiTime.toISOString().split('T')[0];
    const monthKey = `${shanghaiTime.getFullYear()}-${String(shanghaiTime.getMonth() + 1).padStart(2, '0')}`;

    if (!credential.dailyLimitCny || !credential.monthlyLimitCny) {
      return { canProceed: false, reason: 'NO_LIMITS_CONFIGURED' };
    }

    const dailyReservations = await tx.taskBudgetReservation.findMany({
      where: {
        actorId,
        state: { in: ['reserved', 'review'] },
      },
    });

    const dailySettled = await tx.taskBudgetReservation.aggregate({
      where: {
        actorId,
        dayKey,
        state: 'settled',
      },
      _sum: { settledCny: true },
    });

    const monthlyReservations = await tx.taskBudgetReservation.findMany({
      where: {
        actorId,
        state: { in: ['reserved', 'review'] },
      },
    });

    const monthlySettled = await tx.taskBudgetReservation.aggregate({
      where: {
        actorId,
        monthKey,
        state: 'settled',
      },
      _sum: { settledCny: true },
    });

    const dailyUsed = new Prisma.Decimal(dailySettled._sum.settledCny?.toString() || '0')
      .add(
        dailyReservations.reduce(
          (sum, r) => sum.add(r.reservedCny),
          new Prisma.Decimal(0),
        ),
      )
      .toString();

    const monthlyUsed = new Prisma.Decimal(monthlySettled._sum.settledCny?.toString() || '0')
      .add(
        monthlyReservations.reduce(
          (sum, r) => sum.add(r.reservedCny),
          new Prisma.Decimal(0),
        ),
      )
      .toString();

    const dailyLimit = credential.dailyLimitCny.toString();
    const monthlyLimit = credential.monthlyLimitCny.toString();

    if (!fitsBudget(dailyLimit, dailyUsed, reserveCny)) {
      return { canProceed: false, reason: 'DAILY_LIMIT_EXCEEDED' };
    }

    if (!fitsBudget(monthlyLimit, monthlyUsed, reserveCny)) {
      return { canProceed: false, reason: 'MONTHLY_LIMIT_EXCEEDED' };
    }

    return { canProceed: true };
  }
}
