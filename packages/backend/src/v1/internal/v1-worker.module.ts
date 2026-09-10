import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { ExecutionsModule } from '../../executions/executions.module';
import { AssetsModule } from '../../assets/assets.module';
import { TasksModule } from '../../tasks/tasks.module';
import { WorkerServiceGuard } from '../../auth/worker-service.guard';
import { V1WorkerController } from './v1-worker.controller';

@Module({
  imports: [AuthModule, ExecutionsModule, AssetsModule, TasksModule],
  providers: [WorkerServiceGuard],
  controllers: [V1WorkerController],
})
export class V1WorkerModule {}
