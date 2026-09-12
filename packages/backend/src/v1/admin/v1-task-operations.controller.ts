import {
  BadRequestException,
  Body,
  Controller,
  NotFoundException,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AdminTokenGuard } from '../../auth/admin-token.guard';
import { PrismaService } from '../../prisma.service';
import { TaskBudgetService } from '../../tasks/task-budget.service';

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly budget: TaskBudgetService,
  ) {}

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
