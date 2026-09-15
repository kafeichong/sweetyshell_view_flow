// Run after npm run build. Exercises real Nest routing and actor guard with no DB, OSS or Provider network.
const assert = require('node:assert/strict');
const { NestFactory } = require('@nestjs/core');
const { Module } = require('@nestjs/common');
const { V1TasksController } = require('../dist/src/v1/tasks/v1-tasks.controller');
const { TasksService } = require('../dist/src/tasks/tasks.service');
const { PreflightService } = require('../dist/src/tasks/preflight.service');
const {
  ProductionSubmissionError,
  ProductionSubmissionService,
} = require('../dist/src/tasks/production-submission.service');
const { WorkflowCatalogService } = require('../dist/src/tasks/workflow-catalog.service');
const { CredentialsService } = require('../dist/src/auth/credentials.service');
const { ApiCredentialGuard } = require('../dist/src/auth/api-credential.guard');

const intent = {
  contractVersion: 2,
  workflowKey: 'seedance.reference-image-to-video.v1',
  prompt: { positive: 'product' },
  generation: {
    duration: 5,
    ratio: '16:9',
    resolution: '720p',
    generateAudio: true,
    watermark: false,
    outputFormat: 'mp4',
  },
  media: [],
};

async function main() {
  let previewCalls = 0;
  let productionCalls = 0;
  const report = {
    preflightId: '00000000-0000-0000-0000-000000000001',
    requestCheck: { status: 'passed', items: [] },
    productionAdmission: { canSubmit: false, blockers: [{ code: 'WORKFLOW_NOT_READY' }] },
    effectiveRequest: intent,
    willUploadMedia: false,
    willCallProvider: false,
  };

  class HttpTestModule {}
  Module({
    controllers: [V1TasksController],
    providers: [
      ApiCredentialGuard,
      {
        provide: CredentialsService,
        useValue: { authenticate: async (token) => token === 'test-token' ? { actorId: 'actor-a' } : null },
      },
      { provide: TasksService, useValue: { findCurrentForSlot: async () => null } },
      {
        provide: PreflightService,
        useValue: {
          preview: async () => { previewCalls += 1; return report; },
          check: async () => report,
        },
      },
      { provide: WorkflowCatalogService, useValue: { directory: () => ({ contractVersion: 2, workflows: [] }) } },
      {
        provide: ProductionSubmissionService,
        useValue: {
          submit: async (_actorId, _key, submission) => {
            if (Object.keys(submission).some((key) => !['preflightId', 'executionSlotId', 'media'].includes(key))) {
              throw new ProductionSubmissionError('SUBMISSION_FIELDS_INVALID');
            }
            productionCalls += 1;
            return { id: 'task-id', status: 'pending' };
          },
        },
      },
    ],
  })(HttpTestModule);

  const app = await NestFactory.create(HttpTestModule, { logger: false });
  app.setGlobalPrefix('api');
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const post = (path, body, auth = true, key = 'request-id') => fetch(`${base}/api/v1/tasks${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { 'Idempotency-Key': key } : {}),
        ...(auth ? { Authorization: 'Bearer test-token' } : {}),
      },
      body: JSON.stringify(body),
    });

    assert.equal((await post('/preflight', intent, false)).status, 401);
    const preview = await post('/preflight', intent);
    assert.equal(preview.status, 201);
    assert.deepEqual(await preview.json(), report);
    assert.equal(previewCalls, 1);
    assert.equal(productionCalls, 0);

    assert.equal((await post('', { ...intent, mode: 'preview' })).status, 400);
    assert.equal((await post('', { mode: 'production' }, false)).status, 401);
    assert.equal((await post('', { mode: 'production' }, true, '')).status, 409);
    assert.equal(productionCalls, 0);

    const submission = {
      mode: 'production',
      preflightId: report.preflightId,
      executionSlotId: 'slot-reference-main',
      media: [],
    };
    assert.equal((await post('', { ...submission, prompt: { positive: 'changed' } })).status, 400);
    assert.equal(productionCalls, 0);
    const production = await post('', submission);
    assert.equal(production.status, 201);
    assert.deepEqual(await production.json(), { id: 'task-id', status: 'pending' });
    assert.equal(productionCalls, 1);

    console.log('PASS: real HTTP guard, independent Preview route, retired Preview Task path, minimal Production submission');
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
