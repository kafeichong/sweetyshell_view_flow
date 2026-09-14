import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, Param, Post, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { ApiCredentialGuard } from '../../auth/api-credential.guard';
import { CurrentActor } from '../../auth/current-actor.decorator';
import { AssetsService } from '../../assets/assets.service';
import { AssetPresignService } from '../../assets/asset-presign.service';
import { MediaInspectorService } from '../../assets/media-inspector.service';
import { TasksService } from '../../tasks/tasks.service';
import { UploadTicketDto } from './dto/upload-ticket.dto';


type InputMediaPolicy = { mediaType: 'image' | 'video' | 'audio'; maxSizeBytes: number };

// Seedance 2.5 官网创建任务文档的单文件 MIME 与大小限制。时长、分辨率、帧率
// 和多素材总量必须读取文件本体，不能在签发 PUT ticket 时凭客户端声明判断。
const INPUT_MEDIA_POLICIES: Readonly<Record<string, InputMediaPolicy>> = {
  'image/jpeg': { mediaType: 'image', maxSizeBytes: 30 * 1024 * 1024 },
  'image/png': { mediaType: 'image', maxSizeBytes: 30 * 1024 * 1024 },
  'image/webp': { mediaType: 'image', maxSizeBytes: 30 * 1024 * 1024 },
  'image/bmp': { mediaType: 'image', maxSizeBytes: 30 * 1024 * 1024 },
  'image/tiff': { mediaType: 'image', maxSizeBytes: 30 * 1024 * 1024 },
  'image/gif': { mediaType: 'image', maxSizeBytes: 30 * 1024 * 1024 },
  'image/heic': { mediaType: 'image', maxSizeBytes: 30 * 1024 * 1024 },
  'image/heif': { mediaType: 'image', maxSizeBytes: 30 * 1024 * 1024 },
  'video/mp4': { mediaType: 'video', maxSizeBytes: 200 * 1024 * 1024 },
  'video/quicktime': { mediaType: 'video', maxSizeBytes: 200 * 1024 * 1024 },
  'audio/wav': { mediaType: 'audio', maxSizeBytes: 15 * 1024 * 1024 },
  'audio/mpeg': { mediaType: 'audio', maxSizeBytes: 15 * 1024 * 1024 },
};

@ApiTags('assets')
@ApiBearerAuth('actor-token')
@Controller('v1/assets')
@UseGuards(ApiCredentialGuard)
export class V1AssetsController {
  constructor(
    private readonly assets: AssetsService,
    private readonly presign: AssetPresignService,
    private readonly tasks?: TasksService,
    private readonly inspector?: MediaInspectorService,
  ) {}

  /**
   * 结果查询：本人任务的产物下载入口。
   *
   * 错误语义按第 5.2 节区分三种"暂时拿不到"，让用户能分辨还在生成、归档失败
   * 还是需要人工核查；不存在的任务和别人的任务一律 404，不泄漏任务是否存在。
   * 下载链接按需签发，不作为永久产物标识返回。
   */
  @Get('tasks/:taskId/result')
  async taskResult(
    @CurrentActor() actor: { actorId: string },
    @Param('taskId') taskId: string,
  ) {
    const task = (await this.tasks?.findOneForActor(taskId, actor.actorId)) as
      | { deliveryStatus?: string | null; taskStatus?: string | null; status?: string | null }
      | null
      | undefined;
    if (!task) {
      throw new NotFoundException('Task result not found');
    }

    if (task.deliveryStatus === 'failed') {
      throw new ConflictException({
        statusCode: 409,
        message: 'DELIVERY_FAILED',
        error: 'Conflict',
      });
    }

    if (task.deliveryStatus !== 'ready') {
      const requiresReview =
        task.taskStatus === 'requires_review' || task.status === 'requires_review';
      throw new ConflictException({
        statusCode: 409,
        message: requiresReview ? 'RESULT_REQUIRES_REVIEW' : 'RESULT_NOT_READY',
        error: 'Conflict',
      });
    }

    const asset = await this.assets.findLatestOwnedOutputForTask(
      taskId,
      actor.actorId,
    );
    if (!asset) {
      // 交付标记为 ready 却没有产物记录：这是内部不一致，不能让用户拿到空结果。
      throw new ConflictException({
        statusCode: 409,
        message: 'DELIVERY_FAILED',
        error: 'Conflict',
      });
    }

    return {
      taskId,
      assetId: asset.id,
      objectKey: asset.objectKey,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes === null ? null : Number(asset.sizeBytes),
      ...this.presign.createDownloadUrl(asset.objectKey),
    };
  }

  @Post('upload-ticket')
  async createUploadTicket(
    @CurrentActor() actor: { actorId: string },
    @Body() body: UploadTicketDto,
  ) {
    const mimeType = typeof body?.mimeType === 'string' ? body.mimeType.trim().toLowerCase() : '';
    const policy = INPUT_MEDIA_POLICIES[mimeType];
    if (!body?.filename?.trim() || !policy) {
      throw new BadRequestException('filename and supported Seedance input mimeType are required');
    }
    if (!Number.isInteger(body.sizeBytes) || body.sizeBytes <= 0 || body.sizeBytes > policy.maxSizeBytes) {
      throw new BadRequestException(`sizeBytes must be between 1 and ${policy.maxSizeBytes} for ${policy.mediaType}`);
    }
    if (!this.presign.isConfigured()) {
      throw new ServiceUnavailableException('OSS presign service is not configured');
    }

    const sha256 =
      typeof body.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(body.sha256.trim())
        ? body.sha256.trim().toLowerCase()
        : undefined;

    // 内容寻址：同一 actor 已上传过相同内容时复用原 Asset 与 objectKey。
    // 这保证 asset_id 对相同图片是稳定的，从而让"同 prompt + 同图片"的重复
    // 提交真正幂等，而不是因为换了 asset_id 被判成 409 冲突。
    if (sha256) {
      const existing = await this.assets.findByOwnerHash(actor.actorId, sha256);
      if (existing) {
        if (['uploaded', 'verified'].includes(existing.inspectionStatus ?? '')) {
          return {
            assetId: existing.id,
            objectKey: existing.objectKey,
            alreadyUploaded: true,
            inspectionStatus: existing.inspectionStatus,
          };
        }
        return this.presign.createUploadTicket(
          existing.id,
          existing.objectKey,
          mimeType,
          body.sizeBytes,
          sha256,
        );
      }
    }

    const safeFilename = body.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const objectKey = `inputs/${actor.actorId}/${randomUUID()}-${safeFilename}`;
    let asset;
    try {
      asset = await this.assets.registerInput({
        ownerId: actor.actorId,
        bucket: this.presign.getBucketName(),
        objectKey,
        mediaType: policy.mediaType,
        mimeType,
        sizeBytes: body.sizeBytes,
        fileHash: sha256,
        inspectionStatus: 'pending_upload',
      });
    } catch (error) {
      // 两个并发请求可能同时通过前面的 find。数据库唯一约束决定胜者，
      // 失败方回读 canonical Asset，不能把正常幂等竞争暴露成 500。
      if (
        sha256 &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const concurrent = await this.assets.findByOwnerHash(actor.actorId, sha256);
        if (concurrent) {
          return this.presign.createUploadTicket(
            concurrent.id,
            concurrent.objectKey,
            mimeType,
            body.sizeBytes,
            sha256,
          );
        }
      }
      throw error;
    }
    return this.presign.createUploadTicket(
      asset.id,
      asset.objectKey,
      mimeType,
      body.sizeBytes,
      sha256,
    );
  }

  @Post(':id/complete')
  async completeUpload(
    @CurrentActor() actor: { actorId: string },
    @Param('id') id: string,
  ) {
    const asset = await this.assets.findOwned(id, actor.actorId);
    if (!asset) {
      throw new NotFoundException('Asset not found');
    }

    let actual;
    try {
      actual = await this.presign.inspectObject(asset.objectKey);
    } catch {
      throw new BadRequestException('Uploaded OSS object is missing or unavailable');
    }
    if (asset.sizeBytes !== null && Number(asset.sizeBytes) !== actual.sizeBytes) {
      throw new BadRequestException('Uploaded object size does not match upload ticket');
    }

    const expectedMime = asset.mimeType?.split(';')[0].trim().toLowerCase();
    if (!actual.mimeType || (expectedMime && actual.mimeType !== expectedMime)) {
      throw new BadRequestException('Uploaded object MIME type does not match upload ticket');
    }

    if (asset.fileHash && actual.fileHash !== asset.fileHash.toLowerCase()) {
      throw new BadRequestException('Uploaded object SHA-256 does not match upload ticket');
    }

    let mediaMetadata;
    if (this.inspector) {
      try {
        const signed = this.presign.createDownloadUrl(asset.objectKey);
        mediaMetadata = await this.inspector.inspect(signed.downloadUrl);
      } catch {
        throw new BadRequestException('Uploaded media could not be inspected');
      }
    }
    const uploaded = await this.assets.markUploaded(id, actor.actorId, {
      bucket: this.presign.getBucketName(),
      sizeBytes: actual.sizeBytes,
      mimeType: actual.mimeType,
      mediaMetadata,
    });
    if (!uploaded) {
      throw new NotFoundException('Asset not found');
    }
    return {
      assetId: uploaded.id,
      objectKey: uploaded.objectKey,
      bucket: uploaded.bucket,
      mimeType: uploaded.mimeType,
      sizeBytes: uploaded.sizeBytes === null ? null : Number(uploaded.sizeBytes),
      inspectionStatus: uploaded.inspectionStatus,
    };
  }

  @Get(':id/download')
  async download(@CurrentActor() actor: { actorId: string }, @Param('id') id: string) {
    const asset = await this.assets.findOwnedUploaded(id, actor.actorId);
    if (!asset) {
      throw new NotFoundException('Asset not found');
    }
    return this.presign.createDownloadUrl(asset.objectKey);
  }
}
