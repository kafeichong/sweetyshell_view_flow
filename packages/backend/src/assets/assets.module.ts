import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AssetsService } from './assets.service';
import { AssetPresignService } from './asset-presign.service';
import { ArkAssetLibraryService } from './ark-asset-library.service';
import { defaultMediaProbeRunner, MediaInspectorService, MEDIA_PROBE_RUNNER } from './media-inspector.service';

@Module({
  providers: [
    PrismaService,
    AssetsService,
    AssetPresignService,
    ArkAssetLibraryService,
    { provide: MEDIA_PROBE_RUNNER, useValue: defaultMediaProbeRunner },
    MediaInspectorService,
  ],
  exports: [AssetsService, AssetPresignService, ArkAssetLibraryService, MediaInspectorService],
})
export class AssetsModule {}
