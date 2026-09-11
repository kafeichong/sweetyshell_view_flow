import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

type ClaimMode = 'preview' | 'production' | 'comfyui';
const CLAIM_LEASE_MS = 5 * 60 * 1000;

// 可领取条件：旧接口创建的 Task 的 taskStatus 为 null，v1 创建的为 'pending'。
// 两者都必须能被 claim，否则 v1 任务会永久停留在 pending。
//
// 安全不变量：只有 status='pending' 的任务可被领取。Preview 任务以
// status='preview' 落库（见 TasksService.createPreview），因此永远不会进入
// 这里，也就永远不会调用 Provider 产生费用。放宽这个条件等于放开免费预览的闸门。
const CLAIMABLE_TASK_WHERE = {
  status: 'pending',
  OR: [{ taskStatus: null }, { taskStatus: 'pending' }],
} as const;

@Injectable()
export class TaskClaimService {
  constructor(private readonly prisma: PrismaService) {}

  async claimNext(workerId: string = 'worker', mode: ClaimMode = 'production') {
    // 以事务完成状态抢占，避免同一 pending 任务被多个 worker 同时领取。
    for (let retry = 0; retry < 3; retry += 1) {
      const claimed = await this.prisma.$transaction(async (tx: any) => {
        const candidate = await tx.task.findFirst({
          where: { ...CLAIMABLE_TASK_WHERE },
          orderBy: { createdAt: 'asc' },
        });

        if (!candidate) {
          return null;
        }

        const claimedStatus = {
          status: 'submitted',
          taskStatus: 'in_progress',
          leaseOwner: workerId,
          leaseExpiresAt: new Date(Date.now() + CLAIM_LEASE_MS),
        };

        const updateResult = await tx.task.updateMany({
          where: {
            id: candidate.id,
            ...CLAIMABLE_TASK_WHERE,
          },
          data: {
            ...claimedStatus,
            updatedAt: new Date(),
          },
        });

        if (!updateResult.count) {
          return null;
        }

        const previousAttempt = await tx.executionAttempt.findFirst({
          where: { taskId: candidate.id },
          orderBy: { attemptNo: 'desc' },
          select: { attemptNo: true },
        });

        const attempt = await tx.executionAttempt.create({
          data: {
            taskId: candidate.id,
            attemptNo: (previousAttempt?.attemptNo || 0) + 1,
            mode: this.normalizeMode(mode),
            provider: this.normalizeProvider(candidate.workflowName),
            status: 'pending',
            costStatus: 'unavailable',
          },
        });

        // 返回领取后的真实状态：candidate 是 updateMany 之前读到的快照。
        return this.attachAttempt({ ...candidate, ...claimedStatus }, attempt);
      });

      if (claimed) {
        return claimed;
      }
    }

    return null;
  }

  async findRecoverable() {
    const tasks = await this.prisma.task.findMany({
      where: {
        taskStatus: 'in_progress',
        status: {
          in: ['submitted', 'running'],
        },
      },
      orderBy: { createdAt: 'asc' },
      include: {
        executionAttempts: {
          orderBy: { attemptNo: 'desc' },
          take: 1,
        },
      },
    });

    return tasks.map((task: any) => {
      const attempt = task.executionAttempts?.[0];

      return this.attachAttempt(task, attempt ?? null);
    });
  }

  private attachAttempt(task: any, attempt: any) {
    if (!attempt) {
      return {
        ...task,
        attemptId: null,
        attemptNo: null,
        attemptStatus: null,
        attemptSubmittedAt: null,
      };
    }

    return {
      ...task,
      attemptId: attempt.id,
      attemptNo: attempt.attemptNo,
      attemptStatus: attempt.status,
      attemptProvider: attempt.provider,
      attemptModel: attempt.model,
      attemptSubmittedAt: attempt.submittedAt ? attempt.submittedAt.toISOString() : null,
    };
  }

  private normalizeProvider(profile: string | null | undefined) {
    // Task 表没有独立的 provider 列，v1 的 profile 落在 workflowName 上，
    // 例如 "seedance" / "seedance-main"；取首段作为 provider。
    if (!profile || typeof profile !== 'string') {
      return 'seedance';
    }

    const normalized = profile.split('-')[0].trim();
    return normalized || 'seedance';
  }

  private normalizeMode(mode: ClaimMode) {
    if (mode === 'preview') {
      return 'preview';
    }

    if (mode === 'comfyui') {
      return 'comfyui';
    }

    return 'production';
  }
}
