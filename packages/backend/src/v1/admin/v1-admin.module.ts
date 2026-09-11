import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { PrismaService } from '../../prisma.service';
import { V1CredentialsController } from './v1-credentials.controller';

@Module({
  imports: [AuthModule],
  controllers: [V1CredentialsController],
  providers: [PrismaService],
})
export class V1AdminModule {}
