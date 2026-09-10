import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { V1CredentialsController } from './v1-credentials.controller';

@Module({
  imports: [AuthModule],
  controllers: [V1CredentialsController],
})
export class V1AdminModule {}
