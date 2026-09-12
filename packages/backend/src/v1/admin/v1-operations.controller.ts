import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { AuditLogService } from '../../audit/audit-log.service';
import { AdminTokenGuard } from '../../auth/admin-token.guard';
import { PrismaService } from '../../prisma.service';

type GateBody = {
  paused: boolean;
  reason?: string;
  operator?: string;
  evidenceRef?: string;
};

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** 队列"卡住"的判定线：与第 6 节监控清单一致（pending 超过 2 分钟）。 */
const PENDING_ALERT_SECONDS = 120;

@Controller('v1/admin/operations')
@UseGuards(AdminTokenGuard)
export class V1OperationsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * 运维健康：DB 是否可用、队列是否卡住、有多少待人工处理、以及全局暂停原因。
   *
   * 只读。监控脚本据此决定是否暂停准入；查询本身不改任何状态。
   */
  @Get('health')
  async health() {
    const db = await this.databaseStatus();

    const gate = await this.prisma.productionGate.findUnique({
      where: { id: 'production' },
      select: { paused: true, reason: true, updatedAt: true },
    });

    if (db.status !== 'ok') {
      return {
        status: 'degraded',
        database: db,
        queue: null,
        backlog: null,
        productionGate: gate
          ? { paused: gate.paused, reason: gate.reason, updatedAt: gate.updatedAt }
          : null,
      };
    }

    const now = Date.now();
    const [oldestPending, pendingCount, reviewCount, deliveryFailedCount, settledUnknown] =
      await Promise.all([
        this.prisma.task.findFirst({
          where: { status: 'pending' },
          orderBy: { createdAt: 'asc' },
          select: { id: true, createdAt: true },
        }),
        this.prisma.task.count({ where: { status: 'pending' } }),
        this.prisma.taskBudgetReservation.count({ where: { state: 'review' } }),
        this.prisma.task.count({ where: { deliveryStatus: 'failed' } }),
        // 费用不确定：预占仍在 review，意味着这次生成花了多少还没核实。
        this.prisma.taskBudgetReservation.count({ where: { state: 'review' } }),
      ]);

    const oldestPendingAgeSeconds = oldestPending
      ? Math.max(0, Math.round((now - oldestPending.createdAt.getTime()) / 1000))
      : null;

    return {
      status: 'ok',
      database: db,
      queue: {
        pendingCount,
        oldestPendingTaskId: oldestPending?.id ?? null,
        oldestPendingAgeSeconds,
        // 只是"超过阈值"的事实，是否告警由监控脚本按连续次数判断。
        pendingStalled: oldestPendingAgeSeconds !== null
          && oldestPendingAgeSeconds > PENDING_ALERT_SECONDS,
      },
      backlog: {
        requiresReview: reviewCount,
        deliveryFailed: deliveryFailedCount,
        costUnverified: settledUnknown,
      },
      productionGate: gate
        ? { paused: gate.paused, reason: gate.reason, updatedAt: gate.updatedAt }
        : { paused: true, reason: 'production gate row missing', updatedAt: null },
    };
  }

  /**
   * 全局生产开关。暂停只拦新准入与未提交的领取，不阻断已有任务的查询与归档——
   * 出问题时最不该做的就是让在途任务也失去可见性。
   */
  @Patch('production-gate')
  async setProductionGate(@Body() body: GateBody) {
    if (typeof body?.paused !== 'boolean') {
      throw new BadRequestException('paused must be a boolean');
    }
    // 恢复生产必须有原因与依据：解除暂停是花钱的动作，不能无痕。
    if (body.paused === false) {
      if (!nonEmptyString(body.reason)) {
        throw new BadRequestException('reason is required when resuming production');
      }
      if (!nonEmptyString(body.operator)) {
        throw new BadRequestException('operator is required when resuming production');
      }
      if (!nonEmptyString(body.evidenceRef)) {
        throw new BadRequestException('evidenceRef is required when resuming production');
      }
    }

    const previous = await this.prisma.productionGate.findUnique({
      where: { id: 'production' },
      select: { paused: true, reason: true },
    });

    const gate = await this.prisma.productionGate.upsert({
      where: { id: 'production' },
      create: {
        id: 'production',
        paused: body.paused,
        reason: body.reason?.trim() ?? null,
      },
      update: {
        paused: body.paused,
        reason: body.reason?.trim() ?? null,
      },
      select: { paused: true, reason: true, updatedAt: true },
    });

    await this.audit.emit({
      event: body.paused ? 'production_gate_paused' : 'production_gate_resumed',
      level: 'warning',
      stage: 'manual',
      code: body.paused ? 'PAUSE' : 'RESUME',
      reason: body.reason?.trim() ?? null,
      evidenceRef: body.evidenceRef?.trim() ?? null,
      operator: body.operator?.trim() ?? null,
      operatorIsDeclaredClaim: body.operator ? true : false,
      before: previous ?? null,
      after: { paused: gate.paused, reason: gate.reason },
    });

    return {
      paused: gate.paused,
      reason: gate.reason,
      updatedAt: gate.updatedAt,
      // 声明值：调用方自报的操作者，未经身份验证。
      operator: body.operator?.trim() ?? null,
      operatorIsDeclaredClaim: Boolean(body.operator),
    };
  }

  private async databaseStatus(): Promise<{ status: string; error?: string }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok' };
    } catch (error) {
      // 数据库不通时健康端点必须仍然返回：否则监控只能看到 5xx，
      // 分不清"服务挂了"和"库连不上"。
      return { status: 'unavailable', error: String(error).slice(0, 200) };
    }
  }
}
