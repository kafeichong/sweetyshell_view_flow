import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AssetsService } from './assets.service';
import { AssetPresignService } from './asset-presign.service';

@Module({
  providers: [PrismaService, AssetsService, AssetPresignService],
  exports: [AssetsService, AssetPresignService],
})
export class AssetsModule {}
