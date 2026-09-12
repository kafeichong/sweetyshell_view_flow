import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { PrismaService } from '../../prisma.service';
import { AuditModule } from '../../audit/audit.module';
import { TasksModule } from '../../tasks/tasks.module';
import { V1CredentialsController } from './v1-credentials.controller';
import { V1OperationsController } from './v1-operations.controller';
import { V1TaskOperationsController } from './v1-task-operations.controller';

@Module({
  // TasksModule 提供 TaskBudgetService 单例，账单复核与准入共用同一份预算状态。
  imports: [AuthModule, AuditModule, TasksModule],
  controllers: [V1CredentialsController, V1TaskOperationsController, V1OperationsController],
  providers: [PrismaService],
})
export class V1AdminModule {}
