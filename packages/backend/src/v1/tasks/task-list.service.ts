import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';

// 工作流显示名称映射
const WORKFLOW_DISPLAY_NAMES: Record<string, string> = {
  'seedance.text-to-video.v1': '文生视频',
  'seedance.reference-image-to-video.v1': '参考图生视频',
  'seedance.first-frame-to-video.v1': '首帧图生视频',
  'seedance.first-last-frame-to-video.v1': '首尾帧生视频',
  'seedance.omni-reference.v1': '多模态参考',
  'seedance.video-edit.v1': '视频编辑',
  'seedance.video-extend.v1': '视频延长',
  'seedance.audio-reference.v1': '音频参考',
};

export interface TaskListQuery {
  page: number;
  limit: number;
  status?: string;
  workflowKey?: string;
  startDate?: string;
  endDate?: string;
}

export interface TaskSummary {
  id: string;
  workflowKey: string | null;
  workflowName: string | null;
  status: string;
  deliveryStatus: string | null;
  parameters: {
    duration?: number;
    resolution?: string;
    ratio?: string;
    model?: string;
  };
  promptPreview: string;
  cost: {
    reserved: string | null;
    settled: string | null;
    status: string | null;
  };
  createdAt: Date;
  completedAt: Date | null;
  hasOutput: boolean;
  outputReady: boolean;
}

export interface TaskDetail {
  id: string;
  actorId: string | null;
  status: string;
  deliveryStatus: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  submissionDetails: {
    workflow: {
      key: string | null;
      name: string | null;
      version: string | null;
      contractDigest: string | null;
    };
    generation: {
      model?: string;
      duration?: number;
      resolution?: string;
      ratio?: string;
      outputFormat?: string;
      generateAudio?: boolean;
      watermark?: boolean;
      frameRate?: number;
    };
    prompt: {
      text: string;
      length: number;
    };
    media: Array<{
      role: string;
      assetId: string;
      mimeType?: string;
      sizeBytes?: number;
      metadata?: Record<string, unknown>;
    }>;
    pricing: {
      version: string | null;
      reserveCny: string | null;
      estimatedTokens?: number;
      ratePerMillion?: string;
      basis?: string;
      snapshot?: Record<string, unknown>;
    };
    execution: {
      slotId: string | null;
      slotSequence: number | null;
      preflightId: string | null;
    };
  };
  attempts: Array<{
    attemptId: string;
    attemptNo: number;
    provider: string;
    model: string | null;
    status: string;
    providerTaskId: string | null;
    costStatus: string;
    estimatedCostCny: string | null;
    usageCalculatedCostCny: string | null;
    billedCostCny: string | null;
    submittedAt: Date | null;
    startedAt: Date | null;
    finishedAt: Date | null;
  }>;
  assets: Array<{
    id: string;
    role: string;
    mediaType: string;
    objectKey: string;
    mimeType: string | null;
    sizeBytes: number | null;
    inspectionStatus: string | null;
    createdAt: Date;
  }>;
  budget: {
    state: string;
    reservedCny: string;
    settledCny: string | null;
    dayKey: string;
    monthKey: string;
    pricingVersion: string;
  } | null;
  correlation: {
    taskId: string;
    clientRequestId: string | null;
    attemptIds: string[];
    providerTaskIds: string[];
    objectKeys: string[];
  };
}

@Injectable()
export class TaskListService {
  constructor(private readonly prisma: PrismaService) {}

  async listTasks(actorId: string, query: TaskListQuery) {
    return this.listTasksWithScope(query, actorId);
  }

  async listAllTasks(query: TaskListQuery) {
    return this.listTasksWithScope(query);
  }

  private async listTasksWithScope(query: TaskListQuery, actorId?: string) {
    const { page, limit, status, workflowKey, startDate, endDate } = query;
    const skip = (page - 1) * limit;

    // 构建查询条件
    const where: Prisma.TaskWhereInput = {
      ...(actorId ? { actorId } : {}),
      ...(status && { status }),
      ...(startDate &&
        endDate && {
          createdAt: {
            gte: new Date(startDate),
            lte: new Date(endDate),
          },
        }),
    };

    // 如果需要按workflowKey筛选，使用executionPlan的JSON查询
    if (workflowKey) {
      where.executionPlan = {
        path: ['workflowKey'],
        equals: workflowKey,
      };
    }

    // 并行查询任务列表和总数
    const [tasks, total] = await Promise.all([
      this.prisma.task.findMany({
        where,
        include: {
          budgetReservation: true,
          executionAttempts: {
            orderBy: { attemptNo: 'desc' },
            take: 1,
          },
          assets: {
            where: { role: 'output' },
            take: 1,
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.task.count({ where }),
    ]);

    return {
      tasks: tasks.map((task) => this.formatTaskSummary(task)),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getTaskDetail(actorId: string, taskId: string): Promise<TaskDetail> {
    const task = await this.findTaskDetail(taskId);

    if (!task || task.actorId !== actorId) {
      throw new NotFoundException('Task not found');
    }

    return this.formatTaskDetail(task);
  }

  async getAnyTaskDetail(taskId: string): Promise<TaskDetail> {
    const task = await this.findTaskDetail(taskId);
    if (!task) throw new NotFoundException('Task not found');
    return this.formatTaskDetail(task);
  }

  private findTaskDetail(taskId: string) {
    return this.prisma.task.findUnique({
      where: { id: taskId },
      include: {
        executionAttempts: { orderBy: { attemptNo: 'desc' } },
        assets: { orderBy: { createdAt: 'asc' } },
        budgetReservation: true,
      },
    });

  }

  private formatTaskSummary(task: any): TaskSummary {
    const plan = task.executionPlan as any;
    const reservation = task.budgetReservation;
    const attempt = task.executionAttempts?.[0];
    const output = task.assets?.[0];

    return {
      id: task.id,
      workflowKey: plan?.workflowKey || null,
      workflowName: this.getWorkflowDisplayName(plan?.workflowKey),
      status: task.status,
      deliveryStatus: task.deliveryStatus,
      parameters: {
        duration: plan?.duration,
        resolution: plan?.resolution,
        ratio: plan?.ratio,
        model: plan?.model,
      },
      promptPreview: this.truncatePrompt(task.prompt, 100),
      cost: {
        reserved: reservation?.reservedCny?.toFixed(6) || null,
        settled: reservation?.settledCny?.toFixed(6) || null,
        status: attempt?.costStatus || null,
      },
      createdAt: task.createdAt,
      completedAt: task.completedAt,
      hasOutput: !!output,
      outputReady: task.deliveryStatus === 'ready',
    };
  }

  private formatTaskDetail(task: any): TaskDetail {
    const plan = task.executionPlan as any;

    return {
      id: task.id,
      actorId: task.actorId,
      status: task.status,
      deliveryStatus: task.deliveryStatus,
      errorMessage: task.errorMsg,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      completedAt: task.completedAt,
      submissionDetails: {
        workflow: {
          key: plan?.workflowKey || null,
          name: this.getWorkflowDisplayName(plan?.workflowKey),
          version: plan?.workflowVersion || null,
          contractDigest: task.contractDigest,
        },
        generation: {
          model: plan?.model,
          duration: plan?.duration,
          resolution: plan?.resolution,
          ratio: plan?.ratio,
          outputFormat: plan?.outputFormat,
          generateAudio: plan?.generateAudio ?? plan?.generate_audio,
          watermark: plan?.watermark,
          frameRate: plan?.frameRate,
        },
        prompt: {
          text: task.prompt,
          length: task.prompt?.length || 0,
        },
        media: (plan?.media || []).map((m: any) => ({
          role: m.role,
          assetId: m.assetId,
          mimeType: m.mimeType,
          sizeBytes: m.sizeBytes,
          metadata: m.metadata,
        })),
        pricing: {
          version: plan?.pricingVersion || null,
          reserveCny: plan?.reserveCny || null,
          estimatedTokens: plan?.estimatedTokens,
          ratePerMillion: plan?.pricingRatePerMillion,
          basis: plan?.pricingBasis,
          snapshot: plan?.pricingSnapshot,
        },
        execution: {
          slotId: task.executionSlotId,
          slotSequence: task.slotSequence,
          preflightId: task.preflightId,
        },
      },
      attempts: task.executionAttempts.map((attempt: any) => ({
        attemptId: attempt.id,
        attemptNo: attempt.attemptNo,
        provider: attempt.provider,
        model: attempt.model,
        status: attempt.status,
        providerTaskId: attempt.providerTaskId,
        costStatus: attempt.costStatus,
        estimatedCostCny: attempt.estimatedCostCny?.toFixed(6) || null,
        usageCalculatedCostCny: attempt.usageCalculatedCostCny?.toFixed(6) || null,
        billedCostCny: attempt.billedCostCny?.toFixed(6) || null,
        submittedAt: attempt.submittedAt,
        startedAt: attempt.startedAt,
        finishedAt: attempt.finishedAt,
      })),
      assets: task.assets.map((asset: any) => ({
        id: asset.id,
        role: asset.role,
        mediaType: asset.mediaType,
        objectKey: asset.objectKey,
        mimeType: asset.mimeType,
        sizeBytes: typeof asset.sizeBytes === 'bigint' ? Number(asset.sizeBytes) : asset.sizeBytes,
        inspectionStatus: asset.inspectionStatus,
        createdAt: asset.createdAt,
      })),
      budget: task.budgetReservation
        ? {
            state: task.budgetReservation.state,
            reservedCny: task.budgetReservation.reservedCny.toFixed(6),
            settledCny: task.budgetReservation.settledCny?.toFixed(6) || null,
            dayKey: task.budgetReservation.dayKey,
            monthKey: task.budgetReservation.monthKey,
            pricingVersion: task.budgetReservation.pricingVersion,
          }
        : null,
      correlation: {
        taskId: task.id,
        clientRequestId: task.clientRequestId,
        attemptIds: task.executionAttempts.map((a: any) => a.id),
        providerTaskIds: task.executionAttempts
          .map((a: any) => a.providerTaskId)
          .filter((id: any): id is string => typeof id === 'string'),
        objectKeys: task.assets.map((a: any) => a.objectKey),
      },
    };
  }

  private getWorkflowDisplayName(key: string | null): string | null {
    if (!key) return null;
    return WORKFLOW_DISPLAY_NAMES[key] || key;
  }

  private truncatePrompt(prompt: string, maxLength: number): string {
    if (!prompt) return '';
    if (prompt.length <= maxLength) return prompt;
    return prompt.substring(0, maxLength) + '...';
  }
}
