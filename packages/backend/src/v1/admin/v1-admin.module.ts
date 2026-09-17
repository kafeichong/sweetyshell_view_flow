import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { PrismaService } from '../../prisma.service';
import { AuditModule } from '../../audit/audit.module';
import { TasksModule } from '../../tasks/tasks.module';
import { V1TokensModule } from '../tokens/v1-tokens.module';
import { V1CredentialsController } from './v1-credentials.controller';
import { V1OperationsController } from './v1-operations.controller';
import { V1TaskOperationsController } from './v1-task-operations.controller';
import { V1AdminConsumptionController } from './v1-admin-consumption.controller';
import { ReconciliationService } from './reconciliation.service';

@Module({
  // TasksModule 提供 TaskBudgetService 单例，账单复核与准入共用同一份预算状态。
  imports: [AuthModule, AuditModule, TasksModule, V1TokensModule],
  controllers: [
    V1CredentialsController,
    V1TaskOperationsController,
    V1OperationsController,
    V1AdminConsumptionController,
  ],
  providers: [PrismaService, ReconciliationService],
})
export class V1AdminModule {}
