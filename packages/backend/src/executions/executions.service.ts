import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { TaskBudgetService } from '../tasks/task-budget.service';
import { interpretUsage } from '../tasks/task-cost';

export enum ExecutionMode {
  PREVIEW = 'preview',
  PRODUCTION = 'production',
  COMFYUI = 'comfyui',
}

export type ProviderOutcomeStatus = 'succeeded' | 'failed' | 'cancelled';

export type ProviderOutcomeInput = {
  providerTaskId?: string;
  status: ProviderOutcomeStatus;
  usage?: Record<string, unknown> | null;
  errorCode?: string;
};

export type ProviderOutcomeResult = {
  outcome: 'applied' | 'idempotent' | 'review';
  attemptId: string;
  taskId: string;
  attemptStatus: string;
  taskStatus: string | null;
  deliveryStatus: string | null;
  cost: {
    status: string;
    amountCny: string | null;
    pricingVersion: string | null;
    reason?: string;
  };
};

const TERMINAL_ATTEMPT_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function normalizeOutcomeStatus(status: unknown): ProviderOutcomeStatus {
  if (status === 'succeeded' || status === 'failed' || status === 'cancelled') {
    return status;
  }
  throw new BadRequestException('INVALID_OUTCOME_STATUS');
}

function sameUsage(
  stored: unknown,
  incoming: Record<string, unknown> | null | undefined,
): boolean {
  if (stored === null || stored === undefined) {
    return incoming === null || incoming === undefined;
  }
  return JSON.stringify(stored) === JSON.stringify(incoming ?? null);
}

export enum AttemptStatus {
  PENDING = 'pending',
  SUBMITTED = 'submitted',
  RUNNING = 'running',
  REQUIRES_REVIEW = 'requires_review',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export enum CostStatus {
  ESTIMATED = 'estimated',
  USAGE_CALCULATED = 'usage_calculated',
  BILLED = 'billed',
  UNAVAILABLE = 'unavailable',
}

export interface CreateAttemptOptions {
  provider?: string;
  model?: string;
}

@Injectable()
export class ExecutionsService {
  constructor(
    private prisma: PrismaService,
    private readonly budget: TaskBudgetService,
  ) {}

  /**
   * 记录 Provider 终态：这是唯一会写 Provider 终态与结算金额的入口。
   *
   * 金额由 Backend 用任务固化 executionPlan 里的 pricingVersion 解释原始
   * usage 得出，请求体里的任何单价/结算金额都不参与计算。Attempt、Task
   * 阶段与预占在同一个事务里落库，Worker 只有收到成功响应才允许进入归档。
   */
  async recordProviderOutcome(
    attemptId: string,
    input: ProviderOutcomeInput,
  ): Promise<ProviderOutcomeResult> {
    const outcome = normalizeOutcomeStatus(input.status);
    const incomingUsage = input.usage ?? null;

    return this.prisma.$transaction(async (tx: any) => {
      const attempt = await tx.executionAttempt.findUnique({
        where: { id: attemptId },
        include: { task: true },
      });

      if (!attempt) {
        throw new NotFoundException('ATTEMPT_NOT_FOUND');
      }

      const task = attempt.task;
      await this.assertProviderTaskOwnership(tx, attemptId, attempt, input.providerTaskId);

      const plan = (task.executionPlan ?? null) as
        | { pricingVersion?: unknown; model?: unknown }
        | null;
      const interpretation = interpretUsage(incomingUsage, plan);
      const amountCny =
        interpretation.status === 'usage_calculated' ? interpretation.amountCny : null;
      const pricingVersion =
        interpretation.status === 'usage_calculated' ? interpretation.pricingVersion : null;
      const reason =
        interpretation.status === 'unavailable' ? interpretation.reason : undefined;

      const cost = {
        status: amountCny ? 'usage_calculated' : 'unavailable',
        amountCny,
        pricingVersion,
        ...(reason ? { reason } : {}),
      };

      // 已经是终态的 Attempt：相同 outcome 幂等返回，冲突则交人工核查，
      // 两种情况都不覆盖既有证据，也不重复计费。
      if (TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) {
        const storedUsage = (attempt.providerUsage ?? null) as Record<string, unknown> | null;
        const matchesExisting =
          this.attemptMatchesOutcome(attempt.status, outcome) &&
          sameUsage(storedUsage, incomingUsage) &&
          (!input.providerTaskId ||
            !attempt.providerTaskId ||
            input.providerTaskId === attempt.providerTaskId);

        if (matchesExisting) {
          return this.buildOutcomeResult('idempotent', attempt, task, attempt.status, {
            status: attempt.costStatus,
            amountCny: attempt.usageCalculatedCostCny !== null
              ? attempt.usageCalculatedCostCny?.toFixed(6) ?? null
              : null,
            pricingVersion: attempt.pricingVersion,
          });
        }

        await this.budget.holdForReviewInTransaction(tx, task.id);
        return this.buildOutcomeResult('review', attempt, task, attempt.status, cost);
      }

      const finishedAt = new Date();
      await tx.executionAttempt.update({
        where: { id: attemptId },
        data: {
          status: this.attemptStatusFor(outcome),
          providerUsage: (incomingUsage ?? null) as Prisma.InputJsonValue,
          costStatus: cost.status,
          usageCalculatedCostCny: amountCny ? Number(amountCny) : null,
          pricingVersion,
          finishedAt,
          ...(input.providerTaskId && !attempt.providerTaskId
            ? { providerTaskId: input.providerTaskId }
            : {}),
          ...(outcome === 'succeeded'
            ? {}
            : {
                failureType: 'provider',
                failureCode: input.errorCode ?? null,
              }),
        },
      });

      // 收费证据存在就按证据结算；没有证据时保留预占交核查。
      // 不允许由 HTTP failed 推断"免费"，也不允许用归档成功掩盖未知费用。
      if (amountCny) {
        await this.budget.settleInTransaction(tx, task.id, amountCny);
      } else {
        await this.budget.holdForReviewInTransaction(tx, task.id);
      }

      if (outcome === 'succeeded') {
        // Provider 成功但尚未归档：进 archiving，等 Worker 交付产物。
        // 归档是否成功只影响 deliveryStatus，不改写这里的费用证据。
        await tx.task.update({
          where: { id: task.id },
          data: {
            status: 'archiving',
            taskStatus: 'in_progress',
            deliveryStatus: 'archiving',
            ...(amountCny ? { cost: Number(amountCny) } : {}),
          },
        });
      } else {
        await tx.task.update({
          where: { id: task.id },
          data: {
            status: 'failed',
            taskStatus: 'failed',
            deliveryStatus: 'not_started',
            errorMsg: input.errorCode ?? null,
            completedAt: finishedAt,
            ...(amountCny ? { cost: Number(amountCny) } : {}),
          },
        });
      }

      const updatedTask = await tx.task.findUnique({ where: { id: task.id } });
      return this.buildOutcomeResult('applied', attempt, updatedTask, this.attemptStatusFor(outcome), cost);
    });
  }

  /** Worker 只能回写属于自己的 Provider 任务，跨 attempt 的 ID 一律拒绝。 */
  private async assertProviderTaskOwnership(
    tx: any,
    attemptId: string,
    attempt: { providerTaskId: string | null },
    providerTaskId?: string,
  ): Promise<void> {
    if (!providerTaskId) return;

    if (attempt.providerTaskId && attempt.providerTaskId !== providerTaskId) {
      throw new ConflictException('PROVIDER_TASK_MISMATCH');
    }

    const owner = await tx.executionAttempt.findUnique({
      where: { providerTaskId },
      select: { id: true },
    });
    if (owner && owner.id !== attemptId) {
      throw new ConflictException('PROVIDER_TASK_OWNED_BY_ANOTHER_ATTEMPT');
    }
  }

  private attemptStatusFor(outcome: ProviderOutcomeStatus): AttemptStatus {
    if (outcome === 'succeeded') return AttemptStatus.COMPLETED;
    if (outcome === 'cancelled') return AttemptStatus.CANCELLED;
    return AttemptStatus.FAILED;
  }

  private attemptMatchesOutcome(storedStatus: string, outcome: ProviderOutcomeStatus): boolean {
    return storedStatus === this.attemptStatusFor(outcome);
  }

  private buildOutcomeResult(
    resultOutcome: ProviderOutcomeResult['outcome'],
    attempt: { id: string; taskId: string },
    task: { status?: string | null; taskStatus?: string | null; deliveryStatus?: string | null } | null,
    attemptStatus: string,
    cost: ProviderOutcomeResult['cost'],
  ): ProviderOutcomeResult {
    return {
      outcome: resultOutcome,
      attemptId: attempt.id,
      taskId: attempt.taskId,
      attemptStatus,
      taskStatus: task?.taskStatus ?? null,
      deliveryStatus: task?.deliveryStatus ?? null,
      cost,
    };
  }

  async createAttempt(taskId: string, mode: ExecutionMode, options: CreateAttemptOptions = {}) {
    const prismaExecutionAttempt = this.prisma as unknown as {
      executionAttempt: {
        findFirst: any;
        create: any;
      };
    };

    const attempts = prismaExecutionAttempt.executionAttempt;

    const lastAttempt = await attempts.findFirst({
      where: { taskId },
      orderBy: { attemptNo: 'desc' },
      select: { attemptNo: true },
    });

    const attemptNo = (lastAttempt?.attemptNo || 0) + 1;

    return attempts.create({
      data: {
        taskId,
        attemptNo,
        mode,
        provider: options.provider ?? 'seedance',
        model: options.model,
        status: AttemptStatus.PENDING,
        costStatus: CostStatus.UNAVAILABLE,
        estimatedCostCny: null,
        usageCalculatedCostCny: null,
        billedCostCny: null,
      },
    });
  }

  async recordProviderSubmission(attemptId: string, providerTaskId: string) {
    const prismaExecutionAttempt = this.prisma as unknown as {
      executionAttempt: {
        update: any;
      };
    };

    const attempts = prismaExecutionAttempt.executionAttempt;

    return attempts.update({
      where: { id: attemptId },
      data: {
        providerTaskId,
        status: AttemptStatus.SUBMITTED,
        submittedAt: new Date(),
      },
    });
  }

  async recordUsage(attemptId: string, usage: Record<string, unknown>) {
    const prismaExecutionAttempt = this.prisma as unknown as {
      executionAttempt: {
        update: any;
      };
    };

    const attempts = prismaExecutionAttempt.executionAttempt;

    return attempts.update({
      where: { id: attemptId },
      data: {
        providerUsage: usage,
        costStatus: CostStatus.USAGE_CALCULATED,
      },
    });
  }

  async markRequiresReview(attemptId: string, code: string, message: string) {
    const prismaExecutionAttempt = this.prisma as unknown as {
      executionAttempt: {
        update: any;
      };
    };

    const attempts = prismaExecutionAttempt.executionAttempt;

    return attempts.update({
      where: { id: attemptId },
      data: {
        status: AttemptStatus.REQUIRES_REVIEW,
        failureType: 'provider',
        failureCode: code,
        failureMessage: message,
      },
    });
  }
}
