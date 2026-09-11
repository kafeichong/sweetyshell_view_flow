import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { ApiCredentialGuard } from '../../auth/api-credential.guard';
import { CurrentActor } from '../../auth/current-actor.decorator';
import { AssetsService } from '../../assets/assets.service';
import { AssetPresignService } from '../../assets/asset-presign.service';
import { TasksService } from '../../tasks/tasks.service';

@Controller('v1/assets')
@UseGuards(ApiCredentialGuard)
export class V1AssetsController {
  constructor(
    private readonly assets: AssetsService,
    private readonly presign: AssetPresignService,
    private readonly tasks?: TasksService,
  ) {}

  @Get('tasks/:taskId/result')
  async taskResult(
    @CurrentActor() actor: { actorId: string },
    @Param('taskId') taskId: string,
  ) {
    const task = await this.tasks?.findOneForActor(taskId, actor.actorId);
    if (!task) {
      throw new NotFoundException('Task result not found');
    }
    const asset = await this.assets.findLatestOwnedOutputForTask(
      taskId,
      actor.actorId,
    );
    if (!asset) {
      throw new NotFoundException('Task result not found');
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
    @Body() body: { filename: string; mimeType: string; sizeBytes: number; sha256?: string },
  ) {
    const allowedMimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
    if (!body?.filename?.trim() || !allowedMimeTypes.has(body.mimeType)) {
      throw new BadRequestException('filename and supported image mimeType are required');
    }
    if (!Number.isInteger(body.sizeBytes) || body.sizeBytes <= 0 || body.sizeBytes > 20 * 1024 * 1024) {
      throw new BadRequestException('sizeBytes must be between 1 and 20971520');
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
          body.mimeType,
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
        mimeType: body.mimeType,
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
            body.mimeType,
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
      body.mimeType,
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

    const uploaded = await this.assets.markUploaded(id, actor.actorId, {
      bucket: this.presign.getBucketName(),
      sizeBytes: actual.sizeBytes,
      mimeType: actual.mimeType,
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
