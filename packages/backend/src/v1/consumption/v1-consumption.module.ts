import { Module } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { AuthModule } from '../../auth/auth.module';
import { ConsumptionService } from './consumption.service';
import { V1ConsumptionController } from './v1-consumption.controller';

@Module({
  imports: [AuthModule],
  controllers: [V1ConsumptionController],
  providers: [ConsumptionService, PrismaService],
  exports: [ConsumptionService],
})
export class V1ConsumptionModule {}
