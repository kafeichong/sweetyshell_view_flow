import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AdminTokenGuard } from '../../auth/admin-token.guard';
import { AuditLogService } from '../../audit/audit-log.service';
import { PrismaService } from '../../prisma.service';
import { TaskBudgetService } from '../../tasks/task-budget.service';
import { TaskReportService } from '../../tasks/task-report.service';
import { TasksService } from '../../tasks/tasks.service';

type BudgetReviewBody = {
  decision: 'settle' | 'release';
  amountCny?: string | null;
  evidenceRef: string;
  operator: string;
};

/** 与生产规格一致的十进制金额写法：非负、最多 6 位小数，不接受科学计数法。 */
function isMoneyString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(0|[1-9]\d*)(\.\d{1,6})?$/.test(value) &&
    Number(value) > 0
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

@Controller('v1/admin/tasks')
@UseGuards(AdminTokenGuard)
export class V1TaskOperationsController {
  private readonly logger = new Logger(V1TaskOperationsController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly budget: TaskBudgetService,
    private readonly tasks: TasksService,
    private readonly audit: AuditLogService,
    private readonly reports: TaskReportService,
  ) {}

  /**
   * 只读报表：按 taskId 汇总 Task/Attempt/Asset/预算/最后错误与事件关联键。
   *
   * 只读是有意为之——排障动作本身不能改变现场，修复必须走显式的受控接口。
   */
  @Get(':taskId/report')
  taskReport(@Param('taskId') taskId: string) {
    return this.reports.buildReport(taskId);
  }

  /**
   * 人工恢复归档：只让"Provider 已成功、交付失败"的任务重新进入 archiving。
   *
   * 不创建新的 Attempt 或 Provider 任务——产物在 Provider 侧已经存在，
   * 重跑的是搬运而不是生成。归档仍在进行中的任务由 Worker 自动重试，
   * 这里会拒绝，避免两边同时搬运同一份产物。
   */
  @Post(':taskId/resume-delivery')
  @HttpCode(HttpStatus.OK)
  async resumeDelivery(
    @Param('taskId') taskId: string,
    @Body() body: { reason?: string; operator?: string; evidenceRef?: string },
  ) {
    if (!nonEmptyString(body?.reason)) {
      throw new BadRequestException('reason is required');
    }
    if (!nonEmptyString(body?.operator)) {
      throw new BadRequestException('operator is required');
    }
    if (!nonEmptyString(body?.evidenceRef)) {
      throw new BadRequestException('evidenceRef is required');
    }

    const before = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { deliveryStatus: true, status: true },
    });
    const result = await this.tasks.resumeDelivery(taskId);

    this.logger.log(
      `Artifact delivery resumed for task ${taskId} by ${body.operator.trim()} ` +
        `(reason: ${body.reason.trim()}, evidence: ${body.evidenceRef.trim()})`,
    );
    // 人工处置必须留痕：谁、依据什么、把状态从什么改成了什么。
    await this.audit.emit({
      event: 'delivery_resumed',
      level: 'warning',
      taskId,
      stage: 'manual',
      code: 'RESUME_DELIVERY',
      operator: body.operator.trim(),
      reason: body.reason.trim(),
      evidenceRef: body.evidenceRef.trim(),
      before: before ?? null,
      after: result,
      operatorIsDeclaredClaim: true,
    });

    return {
      ...result,
      reason: body.reason.trim(),
      evidenceRef: body.evidenceRef.trim(),
      // 声明值：管理员自报的操作者，未经身份验证。
      operator: body.operator.trim(),
      operatorIsDeclaredClaim: true,
    };
  }

  /**
   * 账单核实后的受控动作：把 review 中的预占结算或释放。
   *
   * MVP 不做自动账单抓取，所以金额由人工核实后提交，但必须留下依据引用与
   * 操作者声明。`operator` 是管理员自报的身份，不是 token 识别出的员工，
   * 任何展示都不应把它当成已认证的人员身份。
   */
  @Patch(':taskId/budget-review')
  async reviewBudget(
    @Param('taskId') taskId: string,
    @Body() body: BudgetReviewBody,
  ) {
    if (body?.decision !== 'settle' && body?.decision !== 'release') {
      throw new BadRequestException('decision must be settle or release');
    }

    if (!nonEmptyString(body?.evidenceRef)) {
      throw new BadRequestException('evidenceRef is required');
    }

    if (!nonEmptyString(body?.operator)) {
      throw new BadRequestException('operator is required');
    }

    const amountCny = body?.amountCny ?? null;
    if (body.decision === 'settle' && !isMoneyString(amountCny)) {
      throw new BadRequestException('amountCny must be a positive decimal with at most 6 places');
    }
    if (body.decision === 'release' && amountCny !== null && amountCny !== undefined) {
      throw new BadRequestException('amountCny is only allowed for settle');
    }

    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { id: true },
    });
    if (!task) {
      throw new NotFoundException('Task not found');
    }

    return this.prisma.$transaction(async (tx: any) => {
      const review = await this.budget.applyReviewDecisionInTransaction(tx, taskId, {
        decision: body.decision,
        amountCny,
        evidenceRef: body.evidenceRef.trim(),
        operator: body.operator.trim(),
      });

      // 核实后的金额同时更新到 Attempt 的 billed 字段，供费用展示使用；
      // 预算准入仍然只看预占表的 Decimal 金额。
      const latestAttempt = await tx.executionAttempt.findFirst({
        where: { taskId },
        orderBy: { attemptNo: 'desc' },
        select: { id: true },
      });

      if (latestAttempt && body.decision === 'settle' && amountCny) {
        await tx.executionAttempt.update({
          where: { id: latestAttempt.id },
          data: {
            billedCostCny: Number(amountCny),
            costStatus: 'billed',
          },
        });
      }

      await this.audit.emit({
        event: 'budget_reviewed',
        level: 'warning',
        taskId,
        stage: 'manual',
        code: body.decision === 'settle' ? 'SETTLE' : 'RELEASE',
        operator: body.operator.trim(),
        reason: body.evidenceRef.trim(),
        evidenceRef: body.evidenceRef.trim(),
        after: { state: review.state, settledCny: review.settledCny },
        operatorIsDeclaredClaim: true,
      });

      return {
        taskId,
        decision: body.decision,
        reservationState: review.state,
        settledCny: review.settledCny,
        evidenceRef: body.evidenceRef.trim(),
        // 声明值：调用方自报的操作者，未经身份验证。
        operator: body.operator.trim(),
        operatorIsDeclaredClaim: true,
        reviewedAt: review.reviewedAt,
      };
    });
  }
}
