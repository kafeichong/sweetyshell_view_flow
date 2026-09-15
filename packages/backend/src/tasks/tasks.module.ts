import { Module } from '@nestjs/common';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { PrismaService } from '../prisma.service';
import { TaskClaimService } from './task-claim.service';
import { TaskBudgetService } from './task-budget.service';
import { TaskReportService } from './task-report.service';
import { AuthModule } from '../auth/auth.module';
import { PreflightService } from './preflight.service';
import { WorkflowCatalogService } from './workflow-catalog.service';
import { PricingCatalog } from './pricing-catalog';
import { TaskQuoteService } from './task-quote.service';
import { ProductionSubmissionService } from './production-submission.service';
import { AssetsModule } from '../assets/assets.module';

@Module({
  imports: [AuthModule, AssetsModule],
  controllers: [TasksController],
  providers: [
    TasksService,
    PrismaService,
    TaskClaimService,
    TaskBudgetService,
    TaskReportService,
    WorkflowCatalogService,
    PricingCatalog,
    TaskQuoteService,
    PreflightService,
    ProductionSubmissionService,
  ],
  exports: [TasksService, TaskBudgetService, TaskReportService, WorkflowCatalogService, TaskQuoteService, PreflightService, ProductionSubmissionService],
})
export class TasksModule {}
