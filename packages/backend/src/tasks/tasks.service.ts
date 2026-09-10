import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

type AttemptUpdatePayload = {
  status?: string;
  attemptId?: string;
  attemptStatus?: string;
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
  finishedAt?: Date;
  taskStatus?: string;
};

@Injectable()
export class TasksService {
  constructor(private prisma: PrismaService) {}

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
    requestSnapshot: object;
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
        requestSnapshot: data.requestSnapshot,
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
    finishedAt?: Date;
  }) {
    const {
      attemptId,
      attemptStatus,
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
      finishedAt,
      taskStatus,
      ...taskPayload
    } = data as AttemptUpdatePayload & { [key: string]: unknown };

    if (!attemptId) {
      if (actualCostCny !== undefined) {
        taskPayload.cost = actualCostCny;
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

    if (finishedAt !== undefined) {
      attemptPayload.finishedAt = finishedAt;
    }

    if (taskStatus !== undefined) {
      taskPayload.taskStatus = taskStatus;
    }

    return this.prisma.$transaction(async (tx: any) => {
      const taskResult = await tx.task.update({
        where: { id },
        data: taskPayload,
      });

      await tx.executionAttempt.update({
        where: { id: attemptId },
        data: attemptPayload,
      });

      return taskResult;
    });
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
}
