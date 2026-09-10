import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

export enum ExecutionMode {
  PREVIEW = 'preview',
  PRODUCTION = 'production',
  COMFYUI = 'comfyui',
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
  constructor(private prisma: PrismaService) {}

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
