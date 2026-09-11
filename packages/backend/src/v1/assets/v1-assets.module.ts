import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { AssetsModule } from '../../assets/assets.module';
import { AssetPresignService } from '../../assets/asset-presign.service';
import { V1AssetsController } from './v1-assets.controller';
import { TasksModule } from '../../tasks/tasks.module';

@Module({
  imports: [AuthModule, AssetsModule, TasksModule],
  providers: [AssetPresignService],
  controllers: [V1AssetsController],
})
export class V1AssetsModule {}
