import { Module } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { ConsumptionService } from './consumption.service';
import { V1ConsumptionController } from './v1-consumption.controller';

@Module({
  controllers: [V1ConsumptionController],
  providers: [ConsumptionService, PrismaService],
  exports: [ConsumptionService],
})
export class V1ConsumptionModule {}
