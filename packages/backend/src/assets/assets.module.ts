import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AssetsService } from './assets.service';
import { AssetPresignService } from './asset-presign.service';
import { MediaInspectorService } from './media-inspector.service';

@Module({
  providers: [PrismaService, AssetsService, AssetPresignService, MediaInspectorService],
  exports: [AssetsService, AssetPresignService, MediaInspectorService],
})
export class AssetsModule {}
