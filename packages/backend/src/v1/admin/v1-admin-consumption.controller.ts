import { Controller, Get, Post, Body, Query, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiSecurity, ApiOperation } from '@nestjs/swagger';
import { AdminTokenGuard } from '../../auth/admin-token.guard';
import { ReconciliationService } from './reconciliation.service';
import { TokenManagementService } from '../tokens/token-management.service';
import { PrismaService } from '../../prisma.service';
import { Prisma } from '@prisma/client';

class SubmitReconciliationDto {
  monthKey: string;
  actorId?: string;
  providerBillCny: string;
  evidenceUrl?: string;
  notes?: string;
  reconciledBy: string;
}

@ApiTags('admin')
@ApiSecurity('admin-token')
@Controller('v1/admin')
@UseGuards(AdminTokenGuard)
export class V1AdminConsumptionController {
  constructor(
    private readonly reconciliation: ReconciliationService,
    private readonly tokenManagement: TokenManagementService,
    private readonly prisma: PrismaService,
  ) {}

  // ============ 对账管理 ============

  @Get('reconciliation/records')
  @ApiOperation({ summary: '获取所有对账记录' })
  async getAllReconciliations() {
    return this.reconciliation.getAllReconciliations();
  }

  @Post('reconciliation')
  @ApiOperation({ summary: '提交对账记录' })
  async submitReconciliation(@Body() body: SubmitReconciliationDto) {
    return this.reconciliation.submitReconciliation(body);
  }

  @Get('reconciliation/:monthKey')
  @ApiOperation({ summary: '获取月度对账记录' })
  async getReconciliation(
    @Param('monthKey') monthKey: string,
    @Query('actorId') actorId?: string,
  ) {
    return this.reconciliation.getReconciliation(monthKey, actorId);
  }

  @Get('reconciliation/:monthKey/all')
  @ApiOperation({ summary: '获取月度所有对账记录' })
  async getReconciliationsByMonth(@Param('monthKey') monthKey: string) {
    return this.reconciliation.getReconciliationsByMonth(monthKey);
  }

  // ============ 费用汇总 ============

  @Get('consumption/summary')
  @ApiOperation({ summary: '全局费用汇总' })
  async getConsumptionSummary(@Query('monthKey') monthKey?: string) {
    const month = monthKey || this.getCurrentMonthKey();

    // 获取所有用户的消费数据
    const byActor = await this.prisma.taskBudgetReservation.groupBy({
      by: ['actorId'],
      where: {
        monthKey: month,
        state: 'settled',
      },
      _sum: { settledCny: true },
      _count: true,
    });

    // 获取用户信息
    const actorIds = byActor.map((item) => item.actorId);
    const credentials = await this.prisma.actorCredential.findMany({
      where: { actorId: { in: actorIds } },
      select: { actorId: true, name: true },
    });

    const credentialMap = new Map(credentials.map((c) => [c.actorId, c.name]));

    // 计算总计
    const totalSettled = byActor.reduce(
      (sum, item) => sum.add(item._sum.settledCny || new Prisma.Decimal(0)),
      new Prisma.Decimal(0),
    );
    const totalTasks = byActor.reduce((sum, item) => sum + item._count, 0);

    // 获取对账记录
    const reconciliationRecord = await this.reconciliation.getReconciliation(month);

    return {
      monthKey: month,
      totalSettled: totalSettled.toFixed(6),
      totalReserved: '0.000000', // 预占已结算不再统计
      totalTasks,
      byActor: byActor.map((item) => ({
        actorId: item.actorId,
        name: credentialMap.get(item.actorId) || 'Unknown',
        settled: (item._sum.settledCny || new Prisma.Decimal(0)).toFixed(6),
        taskCount: item._count,
      })),
      reconciliation: reconciliationRecord,
    };
  }

  // ============ Token管理 ============

  @Get('tokens')
  @ApiOperation({ summary: '列出所有Token' })
  async listAllTokens() {
    return this.tokenManagement.listAllTokens();
  }

  @Get('tokens/:actorId/usage-logs')
  @ApiOperation({ summary: '获取指定用户的Token使用日志' })
  async getTokenUsageLogs(
    @Param('actorId') actorId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const limitNum = limit ? Math.min(parseInt(limit, 10), 500) : 100;
    return this.tokenManagement.getUsageLogs(actorId, limitNum, cursor);
  }

  // ============ 辅助方法 ============

  private getCurrentMonthKey(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
  }
}
