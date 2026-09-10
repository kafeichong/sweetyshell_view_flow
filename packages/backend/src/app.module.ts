import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TasksModule } from './tasks/tasks.module';
import { PrismaService } from './prisma.service';
import { ExecutionsModule } from './executions/executions.module';
import { AssetsModule } from './assets/assets.module';
import { AuthModule } from './auth/auth.module';
import { V1TasksModule } from './v1/tasks/v1-tasks.module';
import { V1AssetsModule } from './v1/assets/v1-assets.module';
import { V1WorkerModule } from './v1/internal/v1-worker.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    TasksModule,
    ExecutionsModule,
    AssetsModule,
    AuthModule,
    V1TasksModule,
    V1AssetsModule,
    V1WorkerModule,
  ],
  providers: [PrismaService],
})
export class AppModule {}
