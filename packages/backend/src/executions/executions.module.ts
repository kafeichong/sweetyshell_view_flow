import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { TasksModule } from '../tasks/tasks.module';
import { ExecutionsService } from './executions.service';

@Module({
  // 终态结算要复用 TaskBudgetService：用导入的模块拿同一个单例，
  // 而不是自己 new 一个持有独立状态的实例。
  imports: [TasksModule],
  providers: [PrismaService, ExecutionsService],
  exports: [ExecutionsService],
})
export class ExecutionsModule {}
