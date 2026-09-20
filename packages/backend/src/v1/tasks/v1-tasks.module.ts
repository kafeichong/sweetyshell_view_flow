import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { TasksModule } from '../../tasks/tasks.module';
import { V1TasksController } from './v1-tasks.controller';
import { TaskShowcaseController } from './task-showcase.controller';
import { AssetsModule } from '../../assets/assets.module';
import { TaskListService } from './task-list.service';
import { TaskShowcaseService } from './task-showcase.service';
import { PrismaService } from '../../prisma.service';

@Module({
  imports: [AuthModule, TasksModule, AssetsModule],
  controllers: [V1TasksController, TaskShowcaseController],
  providers: [TaskListService, TaskShowcaseService, PrismaService],
  exports: [TaskListService],
})
export class V1TasksModule {}
