import { Body, Controller, Get, NotFoundException, Param, Patch, Post, UseGuards } from '@nestjs/common';
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
    // 导致产物完全没有素材记录。
    const task = await this.tasks.findOne(body.taskId);
    const ownerId = task?.actorId ?? task?.createdBy;
    if (!task || !ownerId) {
      throw new NotFoundException('Task not found');
    }
    return this.assets.registerOutput({
      ownerId,
      taskId: body.taskId,
      attemptId: body.attemptId,
      objectKey: body.objectKey,
      bucket: body.bucket,
      mediaType: body.mediaType ?? 'video',
      mimeType: body.mimeType,
      sizeBytes: body.sizeBytes,
      inspectionStatus: 'uploaded',
    });
  }

  @Patch(':attemptId/submission')
  recordSubmission(@Param('attemptId') attemptId: string, @Body() body: { providerTaskId: string }) {
    return this.executions.recordProviderSubmission(attemptId, body.providerTaskId);
  }

  @Patch(':attemptId/usage')
  recordUsage(@Param('attemptId') attemptId: string, @Body() body: { usage: Record<string, unknown> }) {
    return this.executions.recordUsage(attemptId, body.usage);
  }

  @Patch(':attemptId/requires-review')
  requiresReview(@Param('attemptId') attemptId: string, @Body() body: { code: string; message: string }) {
    return this.executions.markRequiresReview(attemptId, body.code, body.message);
  }
}
