import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { AssetPresignService } from '../../assets/asset-presign.service';

export interface ShowcaseTask {
  id: string;
  creatorName: string;
  workflowName: string;
  status: string;
  promptPreview: string;
  promptFull: string;
  parameters: {
    duration?: number;
    resolution?: string;
    ratio?: string;
    model?: string;
  };
  hasOutput: boolean;
  outputAssetId?: string;
  createdAt: Date;
  completedAt: Date | null;
}

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

@Injectable()
export class TaskShowcaseService {
  private readonly logger = new Logger(TaskShowcaseService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly presign: AssetPresignService,
  ) {}

  async getShowcaseTasks(page: number = 1, limit: number = 20) {
    const skip = (page - 1) * limit;

    // 只展示已完成的任务
    const [tasks, total] = await Promise.all([
      this.prisma.task.findMany({
        where: {
          status: 'completed',
          deliveryStatus: 'ready',
        },
        orderBy: { completedAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.task.count({
        where: {
          status: 'completed',
          deliveryStatus: 'ready',
        },
      }),
    ]);

    // 获取任务的输出资产
    const taskIds = tasks.map(t => t.id);
    const assets = await this.prisma.asset.findMany({
      where: {
        taskId: { in: taskIds },
        role: 'output',
      },
      select: {
        id: true,
        taskId: true,
        objectKey: true,
      },
    });

    // 创建taskId到asset的映射
    const assetMap = new Map(assets.map(a => [a.taskId, a]));

    this.logger.debug(`Found ${assets.length} output assets for ${tasks.length} tasks`);

    // 获取所有涉及的 actorId
    const actorIds = [...new Set(tasks.map(t => t.actorId).filter(Boolean))];
    const credentials = await this.prisma.actorCredential.findMany({
      where: { actorId: { in: actorIds as string[] } },
      select: { actorId: true, name: true },
    });

    const actorNameMap = new Map(credentials.map(c => [c.actorId, c.name]));

    return {
      tasks: tasks.map((task) => this.formatShowcaseTask(task, actorNameMap, assetMap)),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  private formatShowcaseTask(task: any, actorNameMap: Map<string, string>, assetMap: Map<string, any>): ShowcaseTask {
    const plan = task.executionPlan as any;
    const outputAsset = assetMap.get(task.id);

    return {
      id: task.id,
      creatorName: actorNameMap.get(task.actorId) || '未知用户',
      workflowName: this.getWorkflowDisplayName(plan?.workflowKey),
      status: task.status,
      promptPreview: this.truncatePrompt(task.prompt, 100),
      promptFull: task.prompt,
      parameters: {
        duration: plan?.duration,
        resolution: plan?.resolution,
        ratio: plan?.ratio,
        model: plan?.model,
      },
      hasOutput: !!outputAsset,
      outputAssetId: outputAsset?.id,
      createdAt: task.createdAt,
      completedAt: task.completedAt,
    };
  }

  private getWorkflowDisplayName(key: string | null): string {
    if (!key) return '未知工作流';
    return WORKFLOW_DISPLAY_NAMES[key] || key;
  }

  private truncatePrompt(prompt: string, maxLength: number): string {
    if (!prompt) return '';
    if (prompt.length <= maxLength) return prompt;
    return prompt.substring(0, maxLength) + '...';
  }

  async getTaskDetail(taskId: string) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: {
        assets: {
          where: { role: 'output' },
          select: {
            id: true,
            objectKey: true,
            mimeType: true,
            sizeBytes: true,
          },
        },
      },
    });

    if (!task) {
      throw new NotFoundException('Task not found');
    }

    const credential = await this.prisma.actorCredential.findUnique({
      where: { actorId: task.actorId },
      select: { name: true },
    });

    const plan = task.executionPlan as any;
    const outputAsset = task.assets[0];

    return {
      id: task.id,
      creatorName: credential?.name || '未知用户',
      workflowName: this.getWorkflowDisplayName(plan?.workflowKey),
      status: task.status,
      prompt: task.prompt,
      parameters: {
        duration: plan?.duration,
        resolution: plan?.resolution,
        ratio: plan?.ratio,
        model: plan?.model,
      },
      hasOutput: !!outputAsset,
      outputAsset: outputAsset ? {
        id: outputAsset.id,
        objectKey: outputAsset.objectKey,
        mimeType: outputAsset.mimeType,
        sizeBytes: outputAsset.sizeBytes === null ? null : Number(outputAsset.sizeBytes),
        ...this.presign.createDownloadUrl(outputAsset.objectKey),
      } : null,
      createdAt: task.createdAt,
      completedAt: task.completedAt,
    };
  }

  async getVideoPreviewUrl(assetId: string) {
    const asset = await this.prisma.asset.findUnique({
      where: { id: assetId },
      select: {
        id: true,
        objectKey: true,
        mimeType: true,
        sizeBytes: true,
      },
    });

    if (!asset) {
      throw new NotFoundException('Asset not found');
    }

    return {
      assetId: asset.id,
      objectKey: asset.objectKey,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes === null ? null : Number(asset.sizeBytes),
      ...this.presign.createDownloadUrl(asset.objectKey),
    };
  }
}
