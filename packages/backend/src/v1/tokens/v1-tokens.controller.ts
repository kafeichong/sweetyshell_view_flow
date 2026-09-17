import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { ApiCredentialGuard } from '../../auth/api-credential.guard';
import { CurrentActor } from '../../auth/current-actor.decorator';
import { TokenManagementService } from './token-management.service';

@ApiTags('tokens')
@ApiBearerAuth('actor-token')
@Controller('v1/tokens')
@UseGuards(ApiCredentialGuard)
export class V1TokensController {
  constructor(private readonly tokenManagement: TokenManagementService) {}

  @Get('current')
  @ApiOperation({ summary: '获取当前Token信息' })
  async getCurrentToken(@CurrentActor() actor: { actorId: string }) {
    const info = await this.tokenManagement.getTokenInfo(actor.actorId);
    if (!info) {
      return { error: 'Token not found' };
    }
    return info;
  }

  @Get('usage-logs')
  @ApiOperation({ summary: '获取Token使用日志' })
  async getUsageLogs(
    @CurrentActor() actor: { actorId: string },
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const limitNum = limit ? Math.min(parseInt(limit, 10), 500) : 100;
    return this.tokenManagement.getUsageLogs(actor.actorId, limitNum, cursor);
  }
}
