import { Module } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { AuthModule } from '../../auth/auth.module';
import { ConsumptionService } from './consumption.service';
import { CostAlertService } from './cost-alert.service';
import { V1ConsumptionController } from './v1-consumption.controller';

@Module({
  imports: [AuthModule],
  controllers: [V1ConsumptionController],
  providers: [ConsumptionService, CostAlertService, PrismaService],
  exports: [ConsumptionService, CostAlertService],
})
export class V1ConsumptionModule {}
