// Isolated contract bootstrap only. Never imported by production main.ts.
const { Readable } = require('node:stream');
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

async function main() {
  assertContractEnvironment(process.env);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(WorkflowCatalogService)
    .useClass(ReadyWorkflowCatalogFixture)
    .compile();
  const app = moduleRef.createNestApplication({ logger: ['error'] });
  const presign = app.select(AssetsModule).get(AssetPresignService, { strict: true });
  // Keep real streaming verification and signing; replace storage transport only.
  presign.client = presign.client || {};
  presign.client.getStream = async key => ({ stream: Readable.from([Buffer.from(`contract-object:${key}`)]) });
  app.setGlobalPrefix('api');
  await app.listen(Number(process.env.PORT), '127.0.0.1');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
