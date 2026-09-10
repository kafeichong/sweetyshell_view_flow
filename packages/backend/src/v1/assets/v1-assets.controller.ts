import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ApiCredentialGuard } from '../../auth/api-credential.guard';
import { CurrentActor } from '../../auth/current-actor.decorator';
import { AssetsService } from '../../assets/assets.service';
import { AssetPresignService } from '../../assets/asset-presign.service';

@Controller('v1/assets')
@UseGuards(ApiCredentialGuard)
export class V1AssetsController {
  constructor(
    private readonly assets: AssetsService,
    private readonly presign: AssetPresignService,
  ) {}

  @Post('upload-ticket')
  async createUploadTicket(
    @CurrentActor() actor: { actorId: string },
    @Body() body: { filename: string; mimeType: string; sizeBytes: number },
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
    const safeFilename = body.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const objectKey = `inputs/${actor.actorId}/${randomUUID()}-${safeFilename}`;
    const asset = await this.assets.registerInput({
      ownerId: actor.actorId,
      objectKey,
      mimeType: body.mimeType,
      sizeBytes: body.sizeBytes,
      inspectionStatus: 'pending_upload',
    });
    return this.presign.createUploadTicket(asset.id, asset.objectKey, body.mimeType, body.sizeBytes);
  }

  @Get(':id/download')
  async download(@CurrentActor() actor: { actorId: string }, @Param('id') id: string) {
    const asset = await this.assets.findOwned(id, actor.actorId);
    if (!asset) {
      throw new NotFoundException('Asset not found');
    }
    return this.presign.createDownloadUrl(asset.objectKey);
  }
}
