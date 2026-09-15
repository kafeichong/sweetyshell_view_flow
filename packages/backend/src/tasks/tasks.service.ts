import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { isExecutionSlotLocked, TaskBudgetService } from './task-budget.service';
import { Prisma } from '@prisma/client';

type AttemptUpdatePayload = {
  status?: string;
  attemptId?: string;
  attemptStatus?: string;
  attemptModel?: string;
  providerTaskId?: string;
  failureType?: string;
  failureCode?: string;
  failureMessage?: string;
  providerUsage?: object | null;
  costStatus?: string;
  actualCostCny?: number | null;
  pricingVersion?: string;
  estimatedCostCny?: number | null;
  usageCalculatedCostCny?: number | null;
  billedCostCny?: number | null;
  startedAt?: Date;
  submittedAt?: Date;
  finishedAt?: Date;
  taskStatus?: string;
};

@Injectable()
export class TasksService {
  constructor(
    private prisma: PrismaService,
    private budget: TaskBudgetService,
  ) {}

  async create(data: {
    createdBy: string;
    prompt: string;
    imageUrl?: string;
  }) {
    return this.prisma.task.create({
      data: {
        ...data,
        status: 'pending',
      },
    });
  }

  async findByActorRequest(actorId: string, clientRequestId: string) {
    return this.prisma.task.findFirst({
      where: { actorId, clientRequestId },
    });
  }

  async createV1(data: {
    actorId: string;
    clientRequestId: string;
    capability: string;
    workflowName: string;
    workflowVersion?: string;
    workflowHash?: string;
    requestSnapshot: object;
    executionPlan: object;
    prompt: string;
    imageUrl?: string;
  }) {
    return this.prisma.task.create({
      data: {
        createdBy: data.actorId,
        actorId: data.actorId,
        clientRequestId: data.clientRequestId,
        capability: data.capability,
        workflowName: data.workflowName,
        workflowVersion: data.workflowVersion,
        workflowHash: data.workflowHash,
        requestSnapshot: data.requestSnapshot,
        executionPlan: data.executionPlan,
        deliveryStatus: 'not_started',
        prompt: data.prompt,
        imageUrl: data.imageUrl,
        status: 'pending',
        taskStatus: 'pending',
      },
    });
  }

  async findOneForActor(id: string, actorId: string) {
    return this.prisma.task.findFirst({ where: { id, actorId } });
  }

  async findCurrentForSlot(actorId: string, executionSlotId: string) {
    const [latest] = await this.prisma.task.findMany({
      where: { actorId, executionSlotId },
      orderBy: { slotSequence: 'desc' },
      take: 1,
      include: { executionAttempts: { orderBy: { attemptNo: 'desc' }, take: 1 } },
    });
    return latest && isExecutionSlotLocked(latest) ? latest : null;
  }

  async confirmClientDelivery(taskId: string, actorId: string) {
    const clientDeliveredAt = new Date();
    const applied = await this.prisma.task.updateMany({
      where: {
        id: taskId,
        actorId,
        deliveryStatus: 'ready',
        clientDeliveryStatus: { not: 'delivered' },
      },
      data: { clientDeliveryStatus: 'delivered', clientDeliveredAt },
    });
    if (applied.count) {
      return { taskId, clientDeliveryStatus: 'delivered', clientDeliveredAt, applied: true };
    }
    const current = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!current || current.actorId !== actorId) throw new NotFoundException('Task not found');
    if (current.deliveryStatus !== 'ready') throw new ConflictException('RESULT_NOT_READY');
    if (current.clientDeliveryStatus !== 'delivered') throw new ConflictException('CLIENT_DELIVERY_NOT_APPLICABLE');
    return {
      taskId,
      clientDeliveryStatus: 'delivered',
      clientDeliveredAt: current.clientDeliveredAt,
      applied: false,
    };
  }

  /**
   * 用户可见的任务摘要：保留既有字段，另外给出执行、交付与费用三段。
   *
   * 三段分开是刻意的：Provider 成功不代表交付成功（archiving/failed），
   * 交付成功也不代表费用已知（usage 缺失时仍是 review）。客户端要能分辨
   * "还在生成""归档失败""需核查"，而不是只看一个 status 猜。
   */
  async findSummaryForActor(id: string, actorId: string) {
    const task = (await this.prisma.task.findFirst({
      where: { id, actorId },
      include: {
        executionAttempts: { orderBy: { attemptNo: 'desc' }, take: 1 },
        budgetReservation: true,
      },
    })) as any;

    if (!task) return null;

    const attempt = task.executionAttempts?.[0] ?? null;
    const reservation = task.budgetReservation ?? null;
    const amount = (value: unknown) =>
      value === null || value === undefined ? null : Number(value).toFixed(6);

    // 只有交付就绪才回传产物标识；还在归档时给 null，让客户端知道"还没有可下载的片"。
    const output =
      task.deliveryStatus === 'ready'
        ? await (this.prisma as any).asset.findFirst({
            where: { taskId: id, role: 'output' },
            orderBy: { createdAt: 'desc' },
            select: { id: true },
          })
        : null;

    return {
      ...task,
      execution: attempt
        ? {
            attemptId: attempt.id,
            provider: attempt.provider ?? null,
            model: attempt.model ?? null,
            providerTaskId: attempt.providerTaskId ?? null,
            status: attempt.status ?? null,
          }
        : null,
      delivery: {
        status: task.deliveryStatus ?? 'not_started',
        assetId: output?.id ?? null,
        errorCode: task.deliveryStatus === 'failed' ? (task.errorMsg ?? null) : null,
      },
      costSummary: {
        status: attempt?.costStatus ?? 'unavailable',
        estimatedCny: amount(attempt?.estimatedCostCny),
        usageCalculatedCny: amount(attempt?.usageCalculatedCostCny),
        billedCny: amount(attempt?.billedCostCny),
        pricingVersion: attempt?.pricingVersion ?? null,
        reservedCny: reservation ? reservation.reservedCny?.toFixed(6) ?? null : null,
        settledCny: reservation ? reservation.settledCny?.toFixed(6) ?? null : null,
        reservationState: reservation?.state ?? null,
      },
    };
  }

  async findAll(filters?: { status?: string; createdBy?: string }) {
    return this.prisma.task.findMany({
      where: filters,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    return this.prisma.task.findUnique({
      where: { id },
    });
  }

  async update(id: string, data: {
    status?: string;
    cost?: number;
    completedAt?: Date;
    taskStatus?: string;
    attemptId?: string;
    attemptStatus?: string;
    attemptModel?: string;
    providerTaskId?: string;
    failureType?: string;
    failureCode?: string;
    failureMessage?: string;
    providerUsage?: object | null;
    costStatus?: string;
    actualCostCny?: number;
    pricingVersion?: string;
    estimatedCostCny?: number;
    usageCalculatedCostCny?: number;
    billedCostCny?: number;
    startedAt?: Date;
    submittedAt?: Date;
    finishedAt?: Date;
  }) {
    const {
      attemptId,
      attemptStatus,
      attemptModel,
      providerTaskId,
      failureType,
      failureCode,
      failureMessage,
      providerUsage,
      costStatus,
      actualCostCny,
      pricingVersion,
      estimatedCostCny,
      usageCalculatedCostCny,
      billedCostCny,
      startedAt,
      submittedAt,
      finishedAt,
      taskStatus,
      ...taskPayload
    } = data as AttemptUpdatePayload & { [key: string]: unknown };

    if (taskStatus !== undefined) {
      taskPayload.taskStatus = taskStatus;
    }

    const requestsPendingReset =
      taskPayload.status === 'pending' || taskPayload.taskStatus === 'pending';

    if (!attemptId) {
      if (actualCostCny !== undefined) {
        taskPayload.cost = actualCostCny;
      }

      if (requestsPendingReset) {
        const current = await this.prisma.task.findUnique({
          where: { id },
          select: { status: true },
        });
        if (current && current.status !== 'pending') {
          throw new ConflictException('CANNOT_RESET_TASK_TO_PENDING');
        }
      }

      return this.prisma.task.update({
        where: { id },
        data: {
          ...taskPayload,
        },
      });
    }

    const attemptPayload: Record<string, unknown> = {};

    if (attemptStatus) {
      attemptPayload.status = attemptStatus;
    }

    if (attemptModel !== undefined) {
      attemptPayload.model = attemptModel;
    }

    if (providerTaskId) {
      attemptPayload.providerTaskId = providerTaskId;
    }

    if (failureType !== undefined) {
      attemptPayload.failureType = failureType;
    }

    if (failureCode !== undefined) {
      attemptPayload.failureCode = failureCode;
    }

    if (failureMessage !== undefined) {
      attemptPayload.failureMessage = failureMessage;
    }

    if (providerUsage !== undefined) {
      attemptPayload.providerUsage = providerUsage;
    }

    if (costStatus !== undefined) {
      attemptPayload.costStatus = this.normalizeCostStatus(costStatus);
    }

    if (actualCostCny !== undefined) {
      attemptPayload.usageCalculatedCostCny = actualCostCny;
      taskPayload.cost = actualCostCny;
      if (costStatus === undefined) {
        attemptPayload.costStatus = 'usage_calculated';
      }
    }

    if (estimatedCostCny !== undefined) {
      attemptPayload.estimatedCostCny = estimatedCostCny;
    }

    if (usageCalculatedCostCny !== undefined) {
      attemptPayload.usageCalculatedCostCny = usageCalculatedCostCny;
    }

    if (billedCostCny !== undefined) {
      attemptPayload.billedCostCny = billedCostCny;
    }

    if (pricingVersion !== undefined) {
      attemptPayload.pricingVersion = pricingVersion;
    }

    if (startedAt !== undefined) {
      attemptPayload.startedAt = startedAt;
    }

    if (submittedAt !== undefined) {
      attemptPayload.submittedAt = submittedAt;
    }

    if (finishedAt !== undefined) {
      attemptPayload.finishedAt = finishedAt;
    }

    return this.prisma.$transaction(async (tx: any) => {
      const attempt = await tx.executionAttempt.findUnique({
        where: { id: attemptId },
        select: { taskId: true, status: true, providerTaskId: true },
      });

      if (!attempt || attempt.taskId !== id) {
        throw new BadRequestException('ATTEMPT_TASK_MISMATCH');
      }

      if (requestsPendingReset) {
        const current = await tx.task.findUnique({
          where: { id },
          select: { status: true },
        });
        const isAlreadyPending = current?.status === 'pending';
        const isLegitimateAbandon = attempt.status === 'pending';
        if (!isAlreadyPending && !isLegitimateAbandon) {
          throw new ConflictException('CANNOT_RESET_TASK_TO_PENDING');
        }
      }

      const taskResult = await tx.task.update({
        where: { id },
        data: taskPayload,
      });

      await tx.executionAttempt.update({
        where: { id: attemptId },
        data: attemptPayload,
      });

      if (failureCode === 'EXECUTION_PLAN_COMPILE_FAILED' && !attempt.providerTaskId) {
        await this.budget.releaseInTransaction(tx, id, failureCode);
      }

      return taskResult;
    });
  }

  /**
   * 交付就绪：只有产物登记成功后才能调用。
   *
   * 用 CAS（deliveryStatus 必须仍是 archiving）保证人工恢复与 Worker 自动恢复
   * 只有一个能真正把任务推进到 completed；重复调用按幂等成功处理。Provider 的
   * 成功与费用证据不在这个路径上，任何交付失败都不会回头改写它们。
   */
  async completeDelivery(taskId: string, objectKey: string) {
    const completedAt = new Date();
    const applied = await this.prisma.task.updateMany({
      where: { id: taskId, deliveryStatus: 'archiving' },
      data: {
        status: 'completed',
        taskStatus: 'completed',
        deliveryStatus: 'ready',
        videoUrl: objectKey,
        errorMsg: null,
        completedAt,
      },
    });

    if (applied.count > 0) {
      return { deliveryStatus: 'ready', applied: true };
    }

    const current = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { deliveryStatus: true, videoUrl: true },
    });

    if (current?.deliveryStatus === 'ready' && current.videoUrl === objectKey) {
      return { deliveryStatus: 'ready', applied: false };
    }

    throw new ConflictException('DELIVERY_NOT_APPLICABLE');
  }

  /**
   * 交付失败：写清阶段错误，让用户能区分"还在生成"和"归档失败"。
   *
   * 只动交付相关字段：Attempt 的 Provider 终态、usage 与预占结算保持原样，
   * 归档失败不能把已经确认的花费抹掉。
   */
  async failDelivery(
    taskId: string,
    errorCode: string,
    stage?: string,
  ) {
    const message = stage ? `${stage}:${errorCode}` : errorCode;
    const applied = await this.prisma.task.updateMany({
      where: { id: taskId, deliveryStatus: 'archiving' },
      data: {
        status: 'failed',
        taskStatus: 'failed',
        deliveryStatus: 'failed',
        errorMsg: message,
        completedAt: new Date(),
      },
    });

    if (applied.count > 0) {
      return { deliveryStatus: 'failed', applied: true };
    }

    const current = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { deliveryStatus: true, errorMsg: true },
    });

    if (current?.deliveryStatus === 'failed' && current.errorMsg === message) {
      return { deliveryStatus: 'failed', applied: false };
    }

    throw new ConflictException('DELIVERY_NOT_APPLICABLE');
  }

  /**
   * 人工恢复归档：只针对"Provider 已成功但交付失败"的任务重新进入 archiving。
   *
   * 不创建新的 Attempt 或 Provider 任务——产物已经存在，重跑的是搬运而不是生成。
   */
  async resumeDelivery(taskId: string) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        status: true,
        deliveryStatus: true,
        executionAttempts: {
          orderBy: { attemptNo: 'desc' },
          take: 1,
          select: { status: true },
        },
      },
    });

    if (!task) {
      throw new NotFoundException('Task not found');
    }

    const providerSucceeded = task.executionAttempts?.[0]?.status === 'completed';
    if (!providerSucceeded) {
      throw new ConflictException('PROVIDER_SUCCESS_REQUIRED');
    }

    // 只有交付已经停下（failed）才需要人工恢复；仍在 archiving 的任务
    // 由 Worker 自动重试，抢同一个归档会让两边重复搬运。
    const applied = await this.prisma.task.updateMany({
      where: { id: taskId, deliveryStatus: 'failed' },
      data: {
        status: 'archiving',
        taskStatus: 'in_progress',
        deliveryStatus: 'archiving',
        errorMsg: null,
        completedAt: null,
      },
    });

    if (!applied.count) {
      throw new ConflictException('DELIVERY_NOT_RESUMABLE');
    }

    return { taskId, deliveryStatus: 'archiving', status: 'archiving' };
  }

  async findPending() {
    return this.prisma.task.findMany({
      where: { status: 'pending' },
      orderBy: { createdAt: 'asc' },
      take: 10,
    });
  }

  private normalizeCostStatus(
    rawCostStatus?: string,
  ): 'estimated' | 'usage_calculated' | 'billed' | 'unavailable' {
    if (!rawCostStatus || typeof rawCostStatus !== 'string') {
      return 'unavailable';
    }

    const normalized = rawCostStatus.toLowerCase().trim();
    if (normalized === 'confirmed') {
      return 'usage_calculated';
    }

    if (
      normalized === 'estimated' ||
      normalized === 'usage_calculated' ||
      normalized === 'billed' ||
      normalized === 'unavailable'
    ) {
      return normalized;
    }

    return 'unavailable';
  }

  async checkAndReserve(
    actorId: string,
    estimatedCny: string,
    taskData: {
      actorId: string;
      clientRequestId: string;
      capability: string;
      workflowName: string;
      requestSnapshot: object;
      prompt: string;
      imageUrl?: string;
    },
  ): Promise<
    | { canProceed: true; task: any }
    | { canProceed: false; reason: string }
  > {
    return this.prisma.$transaction(async (tx) => {
      const budgetCheck = await this.budget.checkBudgetAvailability(
        tx,
        actorId,
        estimatedCny,
      );

      if (!budgetCheck.canProceed) {
        return { canProceed: false, reason: budgetCheck.reason || 'BUDGET_CHECK_FAILED' };
      }

      const task = await tx.task.create({
        data: {
          createdBy: taskData.actorId,
          actorId: taskData.actorId,
          clientRequestId: taskData.clientRequestId,
          capability: taskData.capability,
          workflowName: taskData.workflowName,
          requestSnapshot: taskData.requestSnapshot,
          prompt: taskData.prompt,
          imageUrl: taskData.imageUrl,
          status: 'pending',
          taskStatus: 'pending',
        },
      });

      const executionPlan = {
        version: 'mvp-v1',
        model: 'seedance-v1',
        duration: 5,
        ratio: '16:9',
        resolution: '720p',
        generate_audio: false,
        watermark: true,
        pricingVersion: '2026-09-mvp',
        reserveCny: estimatedCny,
      };

      await this.budget.reserveInTransaction(
        tx,
        task.id,
        actorId,
        executionPlan,
      );

      return { canProceed: true, task };
    });
  }
}
