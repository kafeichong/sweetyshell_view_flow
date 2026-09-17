import { Module, forwardRef } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { TokenManagementService } from './token-management.service';
import { V1TokensController } from './v1-tokens.controller';
import { AuthModule } from '../../auth/auth.module';

@Module({
  imports: [forwardRef(() => AuthModule)],
  controllers: [V1TokensController],
  providers: [TokenManagementService, PrismaService],
  exports: [TokenManagementService],
})
export class V1TokensModule {}
