import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Prisma } from '@prisma/client';
import type { PricingSelection } from './pricing-catalog';

export interface ExecutionPlan {
  specVersion?: string;
  version?: string;
  contractVersion?: number;
  contractDigest?: string;
  intentDigest?: string;
  model: string;
  duration: number;
  ratio: string;
  resolution: string;
  generateAudio?: boolean;
  generate_audio?: boolean;
  watermark: boolean;
  pricingVersion: string;
  reserveCny: string;
  estimatedTokens?: number;
  pricingRatePerMillion?: string;
  pricingBasis?: string;
  pricingSnapshot?: PricingSelection;
  quoteDigest?: string;
  prompt?: string;
  imageAssetId?: string;
  inputFileHash?: string | null;
  workflowKey?: string;
  workflowVersion?: string;
  outputFormat?: string;
  omni_reference_task_type?: string;
  media?: {
    slotId?: string;
    assetId: string;
    role: string;
    fileHash?: string | null;
    mimeType?: string;
    sizeBytes?: number;
    metadata?: Record<string, unknown>;
  }[];
}

export interface ProductionTaskData {
  actorId: string;
  clientRequestId: string;
  requestDigest?: string;
  executionSlotId?: string;
  estimatedCny: string;
  executionPlan: ExecutionPlan;
  task: {
    createdBy: string;
    prompt: string;
    status: string;
    capability?: string;
    workflowName?: string;
    workflowVersion?: string;
    workflowHash?: string;
    requestSnapshot?: object;
    imageUrl?: string;
    preflightId?: string;
    contractDigest?: string;
    intentDigest?: string;
    quoteDigest?: string;
  };
}

type SlotTask = {
  slotSequence?: number | null;
  clientDeliveryStatus?: string | null;
  deliveryStatus?: string | null;
  executionAttempts?: { status?: string | null; providerTaskId?: string | null }[];
};

export function isExecutionSlotLocked(task: SlotTask): boolean {
  if (task.clientDeliveryStatus === 'delivered') return false;
  const attempt = task.executionAttempts?.[0];
  const definitelyNoResult = task.deliveryStatus === 'not_started'
    && (attempt?.status === 'failed' || attempt?.status === 'cancelled');
  return !definitelyNoResult;
}

export function fitsBudget(limit: string, used: string, reserve: string): boolean {
  return new Prisma.Decimal(used).add(reserve).lte(new Prisma.Decimal(limit));
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}

@Injectable()
export class TaskBudgetService {
  private readonly logger = new Logger(TaskBudgetService.name);

  constructor(private readonly prisma: PrismaService) {}

  async preflightAvailability(actorId: string, reserveCny: string) {
    const gate = await this.prisma.productionGate.findUnique({ where: { id: 'production' } });
    if (!gate || gate.paused) return { canProceed: false, reason: 'PRODUCTION_PAUSED' };
    return this.checkBudgetAvailability(this.prisma as unknown as Prisma.TransactionClient, actorId, reserveCny);
  }

  async createTaskWithReservation(
    data: ProductionTaskData,
    validateBeforeCreate?: (tx: Prisma.TransactionClient) => Promise<void>,
  ) {
    return this.prisma.$transaction(async (tx) => {
      if (typeof (tx as any).$executeRaw === 'function') {
        // 固定顺序：先拿全局准入锁（用于全局 pending 数校验），再拿 actor 锁；
        // 两把锁使用不同的 classid（0 / 1）命名空间，不会与彼此的 key 冲突。
        await (tx as any).$executeRaw`SELECT pg_advisory_xact_lock(0, 0)`;
        await (tx as any).$executeRaw`SELECT pg_advisory_xact_lock(1, hashtext(${data.actorId}))`;
      }

      if (data.requestDigest) {
        const existing = await tx.task.findFirst({
          where: { actorId: data.actorId, clientRequestId: data.clientRequestId },
        });
        if (existing) {
          const snapshot = existing.requestSnapshot as { submissionDigest?: unknown } | null;
          if (snapshot?.submissionDigest !== data.requestDigest) throw new Error('IDEMPOTENCY_KEY_REUSED');
          return { task: existing, created: false };
        }
      }

      let slotSequence: number | undefined;
      if (data.executionSlotId) {
        if (typeof (tx as any).$executeRaw === 'function') {
          await (tx as any).$executeRaw`SELECT pg_advisory_xact_lock(4, hashtext(${`${data.actorId}:${data.executionSlotId}`}))`;
        }
        const current = await tx.task.findFirst({
          where: { actorId: data.actorId, executionSlotId: data.executionSlotId },
          orderBy: { slotSequence: 'desc' },
          include: { executionAttempts: { orderBy: { attemptNo: 'desc' }, take: 1 } },
        });
        if (current && isExecutionSlotLocked(current)) {
          return { task: current, created: false, recovered: true };
        }
        slotSequence = (current?.slotSequence ?? 0) + 1;
      }

      if (validateBeforeCreate) await validateBeforeCreate(tx);
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
          deliveryStatus: 'not_started',
          executionSlotId: data.executionSlotId,
          slotSequence,
          clientDeliveryStatus: data.executionSlotId ? 'pending' : undefined,
        },
      });

      await this.reserveInTransaction(tx, task.id, data.actorId, data.executionPlan);
      return { task, created: true, recovered: false };
    });
    // 注意：不要用 Serializable 隔离级别。advisory lock 已经串行化了整个
    // 检查+写入的关键区；Serializable 事务的 snapshot 在第一条语句（拿锁）
    // 时就已经固定，锁释放后 unblock 时不会刷新，会导致后拿到锁的事务用
    // 旧 snapshot 做预算检查（看不到刚提交的预占），到 commit 时才因
    // serialization_failure 报错——而这个错误不在 reasonMap 里，会被
    // controller 当成未知错误抛成 500，而不是预期的 429。默认的
    // ReadCommitted 每条语句都会取新 snapshot，解锁后能看到最新数据。
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

  /**
   * 人工账单复核：只有 Admin 受控动作能改动 review 中的预占，且必须记录
   * 操作者声明与依据引用，便于事后追溯是谁根据什么凭据改了金额。
   */
  async applyReviewDecisionInTransaction(
    tx: Prisma.TransactionClient,
    taskId: string,
    decision: {
      decision: 'settle' | 'release';
      amountCny?: string | null;
      evidenceRef: string;
      operator: string;
    },
  ): Promise<{
    state: string;
    settledCny: string | null;
    reviewedAt: Date;
  }> {
    const reviewedAt = new Date();
    const settledCny =
      decision.decision === 'settle' && decision.amountCny
        ? new Prisma.Decimal(decision.amountCny)
        : null;

    const updated = await tx.taskBudgetReservation.update({
      where: { taskId },
      data: {
        state: decision.decision === 'settle' ? 'settled' : 'released',
        settledCny,
        reviewDecision: decision.decision,
        reviewAmountCny: settledCny,
        reviewEvidenceRef: decision.evidenceRef,
        reviewOperator: decision.operator,
        reviewedAt,
        updatedAt: reviewedAt,
      },
    });

    this.logger.log(
      `Budget review ${decision.decision} for task ${taskId} by ${decision.operator} (evidence: ${decision.evidenceRef})`,
    );

    return {
      state: updated.state,
      settledCny: updated.settledCny?.toFixed(6) ?? null,
      reviewedAt,
    };
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

    const dailyTaskLimit = readPositiveIntEnv('VIDEO_FLOW_DAILY_TASK_LIMIT', 10);
    const dailyTaskCount = await tx.taskBudgetReservation.count({
      where: { actorId, dayKey, state: { not: 'released' } },
    });
    if (dailyTaskCount >= dailyTaskLimit) {
      return { canProceed: false, reason: 'DAILY_TASK_COUNT_EXCEEDED' };
    }

    const maxPendingTasks = readPositiveIntEnv('VIDEO_FLOW_MAX_PENDING_TASKS', 5);
    const globalPendingCount = await tx.task.count({ where: { status: 'pending' } });
    if (globalPendingCount >= maxPendingTasks) {
      return { canProceed: false, reason: 'GLOBAL_PENDING_LIMIT_EXCEEDED' };
    }

    return { canProceed: true };
  }
}
