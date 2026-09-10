import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { ApiCredentialGuard } from './api-credential.guard';
import { CredentialsService } from './credentials.service';
import { WorkerServiceGuard } from './worker-service.guard';

@Module({
  providers: [PrismaService, CredentialsService, ApiCredentialGuard, WorkerServiceGuard],
  exports: [CredentialsService, ApiCredentialGuard, WorkerServiceGuard],
})
export class AuthModule {}
