import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ApiCredentialGuard } from '../../auth/api-credential.guard';
import { CurrentActor } from '../../auth/current-actor.decorator';
import { ConsumptionService } from './consumption.service';

@ApiTags('consumption')
@ApiBearerAuth('actor-token')
@Controller('v1/consumption')
@UseGuards(ApiCredentialGuard)
export class V1ConsumptionController {
  constructor(private readonly consumptionService: ConsumptionService) {}

  @Get('overview')
  async getOverview(@CurrentActor() actor: { actorId: string }) {
    return this.consumptionService.getOverview(actor.actorId);
  }

  @Get('trends')
  async getTrends(
    @CurrentActor() actor: { actorId: string },
    @Query('days') days?: string,
  ) {
    const daysCount = days ? Math.min(Math.max(parseInt(days, 10) || 30, 1), 90) : 30;
    return this.consumptionService.getTrends(actor.actorId, daysCount);
  }
}
