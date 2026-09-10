import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // 全局前缀
  app.setGlobalPrefix('api');

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
}

bootstrap();
