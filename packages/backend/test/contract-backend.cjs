// Isolated contract bootstrap only. Never imported by production main.ts.
const { Readable } = require('node:stream');
const { createHash } = require('node:crypto');
const { Test } = require('@nestjs/testing');
const { AppModule } = require('../dist/src/app.module');
const { AssetsModule } = require('../dist/src/assets/assets.module');
const { AssetPresignService } = require('../dist/src/assets/asset-presign.service');
const { WorkflowCatalogService } = require('../dist/src/tasks/workflow-catalog.service');
const { assertContractEnvironment } = require('../dist/test/contract-harness');

class ReadyWorkflowCatalogFixture extends WorkflowCatalogService {
  evaluate(input) {
    const evaluated = super.evaluate(input);
    const ready = new Set(
      String(process.env.VIDEO_FLOW_CONTRACT_READY_WORKFLOWS || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean),
    );
    if (ready.has(evaluated.workflow.key)) {
      evaluated.workflow.state.implementation = 'ready';
      evaluated.workflow.state.admission = { enabled: true, reason: null };
    }
    return evaluated;
  }
}

class LoopbackAssetPresignFixture {
  constructor() {
    this.baseUrl = String(process.env.VIDEO_FLOW_FAKE_OSS_BASE_URL || '').replace(/\/$/, '');
    const parsed = new URL(this.baseUrl);
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
      throw new Error('LOOPBACK_FAKE_OSS_REQUIRED');
    }
  }

  objectUrl(key) {
    const bucket = encodeURIComponent(this.getBucketName());
    const objectKey = String(key).split('/').map(encodeURIComponent).join('/');
    return `${this.baseUrl}/${bucket}/${objectKey}`;
  }

  isConfigured() { return true; }
  getBucketName() { return process.env.OSS_BUCKET || 'fake-oss-bucket'; }

  createUploadTicket(assetId, objectKey, mimeType, sizeBytes, fileHash) {
    const uploadHeaders = {
      'Content-Type': mimeType,
      'Content-Length': String(sizeBytes),
    };
    if (fileHash) uploadHeaders['x-oss-meta-sha256'] = fileHash;
    return {
      assetId,
      objectKey,
      uploadUrl: this.objectUrl(objectKey),
      uploadHeaders,
      expiresIn: 900,
    };
  }

  async inspectObject(objectKey) {
    const response = await fetch(this.objectUrl(objectKey), { method: 'HEAD' });
    if (!response.ok) throw new Error(`FAKE_OSS_HEAD_FAILED_${response.status}`);
    return {
      sizeBytes: Number(response.headers.get('content-length')),
      mimeType: response.headers.get('content-type')?.split(';')[0].trim().toLowerCase(),
      fileHash: response.headers.get('x-oss-meta-sha256')?.trim().toLowerCase(),
    };
  }

  async verifyObjectContent(objectKey, expectedHash, expectedSize) {
    const response = await fetch(this.objectUrl(objectKey));
    if (!response.ok) throw new Error(`FAKE_OSS_GET_FAILED_${response.status}`);
    const content = Buffer.from(await response.arrayBuffer());
    if (content.length !== expectedSize) throw new Error('CONTENT_SIZE_MISMATCH');
    if (createHash('sha256').update(content).digest('hex') !== expectedHash) {
      throw new Error('CONTENT_HASH_MISMATCH');
    }
  }

  createDownloadUrl(objectKey) {
    return { downloadUrl: this.objectUrl(objectKey), expiresIn: 300 };
  }
}

async function main() {
  assertContractEnvironment(process.env);
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(WorkflowCatalogService)
    .useClass(ReadyWorkflowCatalogFixture);
  const fakeOssBaseUrl = String(process.env.VIDEO_FLOW_FAKE_OSS_BASE_URL || '').trim();
  if (fakeOssBaseUrl) {
    builder = builder
      .overrideProvider(AssetPresignService)
      .useClass(LoopbackAssetPresignFixture);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ logger: ['error'] });
  if (!fakeOssBaseUrl) {
    const presign = app.select(AssetsModule).get(AssetPresignService, { strict: true });
    // Legacy contract suites inject only a deterministic stream and do not exercise OSS transport.
    presign.client = presign.client || {};
    presign.client.getStream = async key => ({ stream: Readable.from([Buffer.from(`contract-object:${key}`)]) });
  }
  app.setGlobalPrefix('api');
  await app.listen(Number(process.env.PORT), '127.0.0.1');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
