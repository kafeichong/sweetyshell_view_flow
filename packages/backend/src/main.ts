import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // 全局前缀
  app.setGlobalPrefix('api');

  // 交互式 API 文档：默认只在非生产环境开放，避免额外暴露接口结构；
  // 显式设置 VIDEO_FLOW_ENABLE_SWAGGER=true 可在生产环境临时打开排障。
  const enableSwagger =
    process.env.VIDEO_FLOW_ENABLE_SWAGGER === 'true' ||
    (process.env.NODE_ENV !== 'production' &&
      process.env.VIDEO_FLOW_ENABLE_SWAGGER !== 'false');
  if (enableSwagger) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Video Flow API')
        .setDescription(
          '创意人员 /api/v1 接口。旧版 /api/tasks 仅供 Worker 与管理操作使用，未在此文档中列出。',
        )
        .setVersion('v1')
        .addBearerAuth(
          { type: 'http', scheme: 'bearer', description: 'actor token（vf_ 开头）' },
          'actor-token',
        )
        .addApiKey(
          { type: 'apiKey', name: 'X-Admin-Token', in: 'header' },
          'admin-token',
        )
        .build(),
    );
    SwaggerModule.setup('docs', app, document);
  }

  // CORS：origin '*' 与 credentials:true 组合会被浏览器拒绝，且过于宽松。
  // 未配置 CORS_ORIGIN 时不开放跨域，由部署方显式声明白名单。
  const allowedOrigins = process.env.CORS_ORIGIN?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.enableCors(
    allowedOrigins?.length
      ? { origin: allowedOrigins, credentials: true }
      : { origin: false },
  );

  const port = process.env.PORT || 3000;
  await app.listen(port, '0.0.0.0');
  console.log(`🚀 Video Flow Backend running on http://localhost:${port}/api`);
  if (enableSwagger) {
    console.log(`📖 Swagger UI: http://localhost:${port}/docs`);
  }
}

bootstrap();
