import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { ApiCredentialGuard } from './api-credential.guard';
import { CredentialsService } from './credentials.service';
import { WorkerServiceGuard } from './worker-service.guard';
import { AdminTokenGuard } from './admin-token.guard';

@Module({
  providers: [PrismaService, CredentialsService, ApiCredentialGuard, WorkerServiceGuard, AdminTokenGuard],
  exports: [CredentialsService, ApiCredentialGuard, WorkerServiceGuard, AdminTokenGuard],
})
export class AuthModule {}
