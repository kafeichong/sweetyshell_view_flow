import { Body, Controller, Param, Patch, Post, UseGuards, BadRequestException } from '@nestjs/common';
import { AdminTokenGuard } from '../../auth/admin-token.guard';
import { CredentialsService } from '../../auth/credentials.service';
import { PrismaService } from '../../prisma.service';
import { Prisma } from '@prisma/client';

@Controller('v1/admin/credentials')
@UseGuards(AdminTokenGuard)
export class V1CredentialsController {
  constructor(
    private readonly credentials: CredentialsService,
    private readonly prisma: PrismaService,
  ) {}

  @Post()
  create(@Body() body: { actorId: string; name: string }) {
    if (!body?.actorId?.trim() || !body?.name?.trim()) {
      throw new Error('actorId and name are required');
    }
    return this.credentials.create(body.actorId.trim(), body.name.trim());
  }

  @Patch(':actorId/revoke')
  revoke(@Param('actorId') actorId: string) {
    return this.credentials.revoke(actorId);
  }

  @Patch(':actorId/limits')
  async updateLimits(
    @Param('actorId') actorId: string,
    @Body() body: { dailyLimitCny?: string; monthlyLimitCny?: string },
  ) {
    const credential = await this.prisma.actorCredential.findUnique({
      where: { actorId },
    });

    if (!credential) {
      throw new BadRequestException('Credential not found');
    }

    if (body.dailyLimitCny !== undefined) {
      const daily = new Prisma.Decimal(body.dailyLimitCny);
      if (daily.isNegative() || !daily.isFinite()) {
        throw new BadRequestException('dailyLimitCny must be non-negative and finite');
      }
    }

    if (body.monthlyLimitCny !== undefined) {
      const monthly = new Prisma.Decimal(body.monthlyLimitCny);
      if (monthly.isNegative() || !monthly.isFinite()) {
        throw new BadRequestException('monthlyLimitCny must be non-negative and finite');
      }
    }

    const updateData: any = {};
    if (body.dailyLimitCny !== undefined) {
      updateData.dailyLimitCny = new Prisma.Decimal(body.dailyLimitCny);
    }
    if (body.monthlyLimitCny !== undefined) {
      updateData.monthlyLimitCny = new Prisma.Decimal(body.monthlyLimitCny);
    }

    return this.prisma.actorCredential.update({
      where: { actorId },
      data: updateData,
    });
  }
}
