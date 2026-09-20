import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiSecurity, ApiTags } from '@nestjs/swagger';
import { AdminTokenGuard } from '../../auth/admin-token.guard';
import {
  CredentialHasDataError,
  CredentialNotFoundError,
  CredentialsService,
} from '../../auth/credentials.service';
import { PrismaService } from '../../prisma.service';
import { Prisma } from '@prisma/client';
import { CreateCredentialDto } from './dto/create-credential.dto';
import { UpdateLimitsDto } from './dto/update-limits.dto';

@ApiTags('admin')
@ApiSecurity('admin-token')
@Controller('v1/admin/credentials')
@UseGuards(AdminTokenGuard)
export class V1CredentialsController {
  constructor(
    private readonly credentials: CredentialsService,
    private readonly prisma: PrismaService,
  ) {}

  @Post()
  create(@Body() body: CreateCredentialDto) {
    if (!body?.actorId?.trim() || !body?.name?.trim()) {
      throw new Error('actorId and name are required');
    }
    return this.credentials.create(body.actorId.trim(), body.name.trim());
  }

  @Patch(':actorId/revoke')
  revoke(@Param('actorId') actorId: string) {
    return this.credentials.revoke(actorId);
  }

  @Patch(':actorId/activate')
  activate(@Param('actorId') actorId: string) {
    return this.credentials.activate(actorId);
  }

  @Post(':actorId/rotate-token')
  rotateToken(
    @Param('actorId') actorId: string,
    @Body() body: { confirmActorId?: string },
  ) {
    if (body?.confirmActorId !== actorId) {
      throw new BadRequestException('confirmActorId must exactly match actorId');
    }
    return this.credentials.rotateToken(actorId);
  }

  @Delete(':actorId')
  async deleteUnused(
    @Param('actorId') actorId: string,
    @Body() body: { confirmActorId?: string },
  ) {
    if (body?.confirmActorId !== actorId) {
      throw new BadRequestException('confirmActorId must exactly match actorId');
    }

    try {
      return await this.credentials.deleteUnused(actorId);
    } catch (error) {
      if (error instanceof CredentialNotFoundError) {
        throw new NotFoundException('Credential not found');
      }
      if (error instanceof CredentialHasDataError) {
        throw new ConflictException('User has historical data and can only be disabled');
      }
      throw error;
    }
  }

  @Patch(':actorId/limits')
  async updateLimits(
    @Param('actorId') actorId: string,
    @Body() body: UpdateLimitsDto,
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
      select: {
        actorId: true,
        dailyLimitCny: true,
        monthlyLimitCny: true,
        updatedAt: true,
      },
    });
  }
}
