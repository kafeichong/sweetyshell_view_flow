import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { TasksModule } from '../../tasks/tasks.module';
import { V1TasksController } from './v1-tasks.controller';
import { AssetsModule } from '../../assets/assets.module';

@Module({
  imports: [AuthModule, TasksModule, AssetsModule],
  controllers: [V1TasksController],
})
export class V1TasksModule {}
