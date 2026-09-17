import { Controller, Get, Post, Body, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { ApiCredentialGuard } from '../../auth/api-credential.guard';
import { CurrentActor } from '../../auth/current-actor.decorator';
import { ConsumptionService } from './consumption.service';
import { CostAlertService, AlertConfig } from './cost-alert.service';

class ConfigureAlertsDto {
  daily?: { enabled: boolean; thresholdCny: string };
  monthly?: { enabled: boolean; thresholdCny: string };
}

@ApiTags('consumption')
@ApiBearerAuth('actor-token')
@Controller('v1/consumption')
@UseGuards(ApiCredentialGuard)
export class V1ConsumptionController {
  constructor(
    private readonly consumptionService: ConsumptionService,
    private readonly costAlert: CostAlertService,
  ) {}

  @Get('overview')
  @ApiOperation({ summary: '获取费用概览（日/月消费、额度、预警）' })
  async getOverview(@CurrentActor() actor: { actorId: string }) {
    return this.consumptionService.getOverview(actor.actorId);
  }

  @Get('trends')
  @ApiOperation({ summary: '获取消费趋势' })
  async getTrends(
    @CurrentActor() actor: { actorId: string },
    @Query('days') days?: string,
  ) {
    const daysCount = days ? Math.min(Math.max(parseInt(days, 10) || 30, 1), 90) : 30;
    return this.consumptionService.getTrends(actor.actorId, daysCount);
  }

  @Get('alerts')
  @ApiOperation({ summary: '获取预警配置' })
  async getAlerts(@CurrentActor() actor: { actorId: string }) {
    const alerts = await this.costAlert.getAlertConfigs(actor.actorId);
    const result: any = {};

    for (const alert of alerts) {
      if (alert.type === 'daily_threshold') {
        result.daily = { enabled: alert.enabled, thresholdCny: alert.thresholdCny };
      } else if (alert.type === 'monthly_threshold') {
        result.monthly = { enabled: alert.enabled, thresholdCny: alert.thresholdCny };
      }
    }

    return result;
  }

  @Post('alerts')
  @ApiOperation({ summary: '配置预警阈值' })
  async configureAlerts(
    @CurrentActor() actor: { actorId: string },
    @Body() body: ConfigureAlertsDto,
  ) {
    const alerts: AlertConfig[] = [];

    if (body.daily) {
      alerts.push({
        type: 'daily_threshold',
        thresholdCny: body.daily.thresholdCny,
        enabled: body.daily.enabled,
      });
    }

    if (body.monthly) {
      alerts.push({
        type: 'monthly_threshold',
        thresholdCny: body.monthly.thresholdCny,
        enabled: body.monthly.enabled,
      });
    }

    await this.costAlert.configureAlerts(actor.actorId, alerts);

    return { success: true, message: '预警配置已更新' };
  }
}
