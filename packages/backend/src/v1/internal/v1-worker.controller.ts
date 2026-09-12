import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { WorkerServiceGuard } from '../../auth/worker-service.guard';
import { ExecutionsService } from '../../executions/executions.service';
import { TasksService } from '../../tasks/tasks.service';
import { AssetsService } from '../../assets/assets.service';
import { AssetPresignService } from '../../assets/asset-presign.service';

@Controller('v1/internal/attempts')
@UseGuards(WorkerServiceGuard)
export class V1WorkerController {
  constructor(
    private readonly executions: ExecutionsService,
    private readonly tasks: TasksService,
    private readonly assets: AssetsService,
    private readonly presign: AssetPresignService,
  ) {}

  @Patch('tasks/:taskId/status')
  updateTaskStatus(@Param('taskId') taskId: string, @Body() body: Record<string, unknown>) {
    return this.tasks.update(taskId, body as any);
  }

  @Get('assets/:assetId/download')
  async resolveAsset(@Param('assetId') assetId: string) {
    const asset = await this.assets.findUploadedById(assetId);
    if (!asset) throw new NotFoundException('Asset not found');
    return this.presign.createDownloadUrl(asset.objectKey);
  }

  @Post('assets')
  async registerAsset(
    @Body()
    body: {
      taskId: string;
      attemptId?: string;
      objectKey: string;
      bucket?: string;
      mediaType?: string;
      mimeType?: string;
      sizeBytes?: number;
    },
  ) {
    // Worker 生成产物后登记 Asset；此前 Worker 调用的 /api/assets 并不存在，
    // 导致产物完全没有素材记录。owner 由 Task 决定，同 key 重复登记幂等返回。
    const result = await this.assets.registerOutputOnce({
      taskId: body.taskId,
      attemptId: body.attemptId,
      objectKey: body.objectKey,
      bucket: body.bucket,
      mediaType: body.mediaType ?? 'video',
      mimeType: body.mimeType,
      sizeBytes: body.sizeBytes,
    });

    return {
      assetId: result.asset.id,
      objectKey: result.asset.objectKey,
      deduplicated: result.deduplicated,
    };
  }

  @Patch(':attemptId/submission')
  recordSubmission(@Param('attemptId') attemptId: string, @Body() body: { providerTaskId: string }) {
    return this.executions.recordProviderSubmission(attemptId, body.providerTaskId);
  }

  @Patch(':attemptId/usage')
  recordUsage(@Param('attemptId') attemptId: string, @Body() body: { usage: Record<string, unknown> }) {
    return this.executions.recordUsage(attemptId, body.usage);
  }

  /**
   * Provider 终态回写：Backend 用固化执行快照解释 usage 并结算预算。
   * 请求体只带原始事实，不接受任何单价/结算金额。
   */
  @Patch(':attemptId/outcome')
  recordOutcome(
    @Param('attemptId') attemptId: string,
    @Body()
    body: {
      providerTaskId?: string;
      status: 'succeeded' | 'failed' | 'cancelled';
      usage?: Record<string, unknown> | null;
      errorCode?: string;
    },
  ) {
    return this.executions.recordProviderOutcome(attemptId, body);
  }

  @Patch(':attemptId/requires-review')
  requiresReview(@Param('attemptId') attemptId: string, @Body() body: { code: string; message: string }) {
    return this.executions.markRequiresReview(attemptId, body.code, body.message);
  }

  /**
   * 交付结果回写：归档是独立分支，只改交付状态与产物指向。
   * 成功必须已经有登记好的产物，失败必须带阶段错误。
   */
  @Patch(':attemptId/delivery')
  async recordDelivery(
    @Param('attemptId') attemptId: string,
    @Body()
    body: {
      status: 'ready' | 'failed';
      objectKey?: string;
      errorCode?: string;
      stage?: string;
    },
  ) {
    const attempt = await this.executions.findAttemptTask(attemptId);
    if (!attempt) {
      throw new NotFoundException('Attempt not found');
    }

    if (body?.status === 'ready') {
      if (!body.objectKey) {
        throw new BadRequestException('objectKey is required for a ready delivery');
      }
      const asset = await this.assets.findOutputForAttempt(
        attempt.taskId,
        attemptId,
        body.objectKey,
      );
      if (!asset) {
        // 没有登记产物就说交付成功，等于指向空气。
        throw new ConflictException('DELIVERY_ASSET_NOT_REGISTERED');
      }
      return this.tasks.completeDelivery(attempt.taskId, body.objectKey);
    }

    if (body?.status === 'failed') {
      if (!body.errorCode) {
        throw new BadRequestException('errorCode is required for a failed delivery');
      }
      return this.tasks.failDelivery(attempt.taskId, body.errorCode, body.stage);
    }

    throw new BadRequestException('status must be ready or failed');
  }
}
