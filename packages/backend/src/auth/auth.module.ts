import { Module, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { ApiCredentialGuard } from './api-credential.guard';
import { CredentialsService } from './credentials.service';
import { WorkerServiceGuard } from './worker-service.guard';
import { AdminTokenGuard } from './admin-token.guard';
import { TokenUsageMiddleware } from './token-usage.middleware';
import { V1TokensModule } from '../v1/tokens/v1-tokens.module';

@Module({
  imports: [forwardRef(() => V1TokensModule)],
  providers: [
    PrismaService,
    CredentialsService,
    ApiCredentialGuard,
    WorkerServiceGuard,
    AdminTokenGuard,
    TokenUsageMiddleware,
  ],
  exports: [
    CredentialsService,
    ApiCredentialGuard,
    WorkerServiceGuard,
    AdminTokenGuard,
    TokenUsageMiddleware,
  ],
})
export class AuthModule {}
