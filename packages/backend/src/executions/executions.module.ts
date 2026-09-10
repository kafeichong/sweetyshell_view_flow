import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { ExecutionsService } from './executions.service';

@Module({
  providers: [PrismaService, ExecutionsService],
  exports: [ExecutionsService],
})
export class ExecutionsModule {}
