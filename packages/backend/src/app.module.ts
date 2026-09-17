import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TasksModule } from './tasks/tasks.module';
import { PrismaService } from './prisma.service';
import { ExecutionsModule } from './executions/executions.module';
import { AssetsModule } from './assets/assets.module';
import { AuthModule } from './auth/auth.module';
import { V1TasksModule } from './v1/tasks/v1-tasks.module';
import { V1AssetsModule } from './v1/assets/v1-assets.module';
import { V1WorkerModule } from './v1/internal/v1-worker.module';
import { V1AdminModule } from './v1/admin/v1-admin.module';
import { V1ConsumptionModule } from './v1/consumption/v1-consumption.module';
import { V1TokensModule } from './v1/tokens/v1-tokens.module';
import { TokenUsageMiddleware } from './auth/token-usage.middleware';

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
    V1AdminModule,
    V1ConsumptionModule,
    V1TokensModule,
  ],
  providers: [PrismaService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // 对所有/api/v1路由应用Token使用日志中间件
    consumer.apply(TokenUsageMiddleware).forRoutes('v1/*');
  }
}
