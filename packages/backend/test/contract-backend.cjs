// Isolated contract bootstrap only. Never imported by production main.ts.
const { Readable } = require('node:stream');
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/src/app.module');
const { AssetsModule } = require('../dist/src/assets/assets.module');
const { AssetPresignService } = require('../dist/src/assets/asset-presign.service');
const { assertContractEnvironment } = require('../dist/test/contract-harness');
async function main() {
  assertContractEnvironment(process.env);
  const app = await NestFactory.create(AppModule, { logger: ['error'] });
  const presign = app.select(AssetsModule).get(AssetPresignService, { strict: true });
  // Keep real streaming verification and signing; replace storage transport only.
  presign.client = presign.client || {};
  presign.client.getStream = async key => ({ stream: Readable.from([Buffer.from(`contract-object:${key}`)]) });
  app.setGlobalPrefix('api');
  await app.listen(Number(process.env.PORT), '127.0.0.1');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
