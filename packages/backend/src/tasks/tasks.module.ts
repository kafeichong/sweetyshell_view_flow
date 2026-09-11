import { Module } from '@nestjs/common';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { PrismaService } from '../prisma.service';
import { TaskClaimService } from './task-claim.service';
import { TaskBudgetService } from './task-budget.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [TasksController],
  providers: [TasksService, PrismaService, TaskClaimService, TaskBudgetService],
  exports: [TasksService, TaskBudgetService],
})
export class TasksModule {}
