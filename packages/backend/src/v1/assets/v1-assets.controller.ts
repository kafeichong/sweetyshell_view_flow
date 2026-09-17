import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, Param, Post, Query, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { ApiCredentialGuard } from '../../auth/api-credential.guard';
import { CurrentActor } from '../../auth/current-actor.decorator';
import { AssetsService } from '../../assets/assets.service';
import { ArkAssetIngestService, ArkIngestError } from '../../assets/ark-asset-ingest.service';
import { ArkAssetLibraryService } from '../../assets/ark-asset-library.service';
import { AssetPresignService } from '../../assets/asset-presign.service';
import { MEDIA_INSPECTOR_VERSION, MediaInspectorService } from '../../assets/media-inspector.service';
import {
  SEEDANCE_INPUT_MEDIA_POLICIES,
  seedanceMediaSizeAllowed,
  validateSeedanceMediaMetadata,
} from '../../assets/media-policy';
import { TasksService } from '../../tasks/tasks.service';
import { UploadTicketDto } from './dto/upload-ticket.dto';


@ApiTags('assets')
@ApiBearerAuth('actor-token')
@Controller('v1/assets')
@UseGuards(ApiCredentialGuard)
export class V1AssetsController {
  constructor(
    private readonly assets: AssetsService,
    private readonly presign: AssetPresignService,
    private readonly arkLibrary: ArkAssetLibraryService,
    private readonly arkIngest: ArkAssetIngestService,
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

  /**
   * 私域素材库里、当前账号可用的素材。
   *
   * 客户端据此让用户挑素材；挑中的那一份再走 `POST /v1/assets/ark` 登记。
   * 返回的是方舟侧的元信息（asset ID、类型、状态），不是我方 Asset——登记之前
   * 我方还没有对应的行，这正是"选"和"绑定"分开的原因。
   */
  @Get('ark')
  async listArkAssets(@Query('groupId') groupId?: string) {
    try {
      const assets = await this.arkLibrary.listAssets({
        groupType: 'AIGC',
        groupId: groupId?.trim() || undefined,
      });
      // url 不外发：那是方舟签的地址，客户端不需要它，拿到了反而多一处泄露面。
      return {
        assets: assets.map(({ url, ...rest }) => rest),
      };
    } catch (error) {
      throw this.arkError(error);
    }
  }

  /**
   * 把素材库里的一份素材登记成我方 Asset，返回 assetId 供正式提交绑定。
   *
   * 登记会把它取回来检查（尺寸、时长、编码）并在我方存储留一份副本——GetAsset 不返回这些，
   * 而视频时长直接进计费公式，拿不到就是预占低估。生成时送的仍是 `asset://<asset ID>`。
   */
  @Post('ark')
  async registerArkAsset(
    @CurrentActor() actor: { actorId: string },
    @Body() body: { arkAssetId?: string },
  ) {
    const arkAssetId = typeof body?.arkAssetId === 'string' ? body.arkAssetId.trim() : '';
    if (!arkAssetId) throw new BadRequestException('arkAssetId is required');
    try {
      const asset = await this.arkIngest.materialize(actor.actorId, arkAssetId);
      // 返回的字段刚好够客户端拼出一个 descriptor：它必须和我方 Asset 行的值逐字段一致，
      // 否则正式提交会被 PREFLIGHT_ACTUAL_CONTENT_MISMATCH 拒掉。sha256 尤其不能少。
      return {
        assetId: asset.id,
        arkAssetId: asset.arkAssetId,
        sha256: asset.fileHash,
        mimeType: asset.mimeType,
        sizeBytes: Number(asset.sizeBytes),
        metadata: asset.mediaMetadata,
      };
    } catch (error) {
      throw this.arkError(error);
    }
  }

  /**
   * 把一份**已经在本人名下**的素材推给方舟素材库入库。
   *
   * 客户端先走既有的上传票据把文件放到我方存储，再调这里——这样"从 ComfyUI 上传素材
   * 到素材库"复用的仍是同一条上传链路，不额外开一条收字节的口子。
   *
   * 入过库的素材之后就能用 `asset://` 送进生成请求；含真人人脸的素材**只有**这条路能走。
   */
  @Post('ark/publish')
  async publishArkAsset(
    @CurrentActor() actor: { actorId: string },
    @Body() body: { assetId?: string; groupId?: string },
  ) {
    const assetId = typeof body?.assetId === 'string' ? body.assetId.trim() : '';
    if (!assetId) throw new BadRequestException('assetId is required');
    try {
      const asset = await this.arkIngest.publish(actor.actorId, assetId, { groupId: body?.groupId });
      return {
        assetId: asset.id,
        arkAssetId: asset.arkAssetId,
        arkGroupId: asset.arkGroupId,
      };
    } catch (error) {
      throw this.arkError(error);
    }
  }

  /**
   * 素材库的错误码要原样带给用户：`ARK_ASSET_NOT_ACTIVE`（还没处理完）与
   * `ARK_ASSET_PROJECT_MISMATCH`（项目不对）让用户做的事完全不同。
   * 但**不要把方舟的原始报文透出去**——里面可能有带签名的地址。
   */
  private arkError(error: unknown) {
    if (error instanceof ArkIngestError) {
      return new BadRequestException({ code: error.code, message: error.message });
    }
    if (error instanceof ServiceUnavailableException) {
      return error;
    }
    return new ServiceUnavailableException('ARK_ASSET_LIBRARY_UNAVAILABLE');
  }

  @Post('upload-ticket')
  async createUploadTicket(
    @CurrentActor() actor: { actorId: string },
    @Body() body: UploadTicketDto,
  ) {
    const mimeType = typeof body?.mimeType === 'string' ? body.mimeType.trim().toLowerCase() : '';
    const policy = SEEDANCE_INPUT_MEDIA_POLICIES[mimeType];
    if (!body?.filename?.trim() || !policy) {
      throw new BadRequestException('filename and supported Seedance input mimeType are required');
    }
    if (!seedanceMediaSizeAllowed(policy, body.sizeBytes)) {
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
            ...(existing.inspectionStatus === 'uploaded' ? { requiresInspection: true } : {}),
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

    if (!this.inspector) {
      throw new ServiceUnavailableException('Media inspection service is not configured');
    }
    let mediaMetadata;
    try {
      const signed = this.presign.createDownloadUrl(asset.objectKey);
      mediaMetadata = await this.inspector.inspect(signed.downloadUrl, expectedMime);
      validateSeedanceMediaMetadata(expectedMime, mediaMetadata, actual.sizeBytes);
    } catch {
      throw new BadRequestException('Uploaded media could not be inspected');
    }
    const uploaded = await this.assets.markUploaded(id, actor.actorId, {
      bucket: this.presign.getBucketName(),
      sizeBytes: actual.sizeBytes,
      mimeType: actual.mimeType,
      mediaMetadata,
      inspectorVersion: MEDIA_INSPECTOR_VERSION,
      inspectionStatus: 'verified',
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
