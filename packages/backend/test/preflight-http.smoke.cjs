// Run after npm run build. Real Nest routes/guard; no DB, OSS or Provider network.
const assert = require('node:assert/strict');
const { NestFactory } = require('@nestjs/core');
const { Module } = require('@nestjs/common');
const { V1TasksController } = require('../dist/src/v1/tasks/v1-tasks.controller');
const { TasksService } = require('../dist/src/tasks/tasks.service');
const { TaskBudgetService } = require('../dist/src/tasks/task-budget.service');
const { AssetsService } = require('../dist/src/assets/assets.service');
const { AssetPresignService } = require('../dist/src/assets/asset-presign.service');
const { CredentialsService } = require('../dist/src/auth/credentials.service');
const { ApiCredentialGuard } = require('../dist/src/auth/api-credential.guard');
const spec = { version: 'v1', model: 'fake', duration: 5, ratio: '16:9', resolution: '720p', generateAudio: false, watermark: false, pricingVersion: 'p1', reserveCny: '1' };
const descriptor = { role: 'reference_image', sha256: 'a'.repeat(64), mimeType: 'image/png', sizeBytes: 100, metadata: { kind: 'image', width: 500, height: 500 } };
const intent = { workflowKey: 'seedance.reference-image-to-video.v1', prompt: { positive: 'product' }, generation: { duration: 5, ratio: '16:9', resolution: '720p' }, media: [descriptor] };
async function main() {
  process.env.VIDEO_FLOW_PRODUCTION_ACTORS = 'actor-a';
  process.env.VIDEO_FLOW_PRODUCTION_SPEC_JSON = JSON.stringify(spec);
  const records = new Map(); let paid = 0, contentChecks = 0, mismatch = false, budgetAvailable = true;
  const tasks = {
    findByActorRequest: async () => null,
    createPreview: async data => { const r = { ...data, id: 'preview-id', status: 'preview', createdAt: new Date() }; records.set(r.id,r); return r; },
    findOneForActor: async (id,actor) => records.get(id)?.actorId === actor ? records.get(id) : null,
  };
  class HttpTestModule {}
  Module({ controllers: [V1TasksController], providers: [ApiCredentialGuard,
    { provide: CredentialsService, useValue: { authenticate: async token => token === 'test-token' ? { actorId: 'actor-a' } : null } },
    { provide: TasksService, useValue: tasks },
    { provide: TaskBudgetService, useValue: { preflightAvailability: async () => budgetAvailable ? ({ canProceed: true }) : ({ canProceed: false, reason: 'DAILY_LIMIT_EXCEEDED' }), createTaskWithReservation: async () => { paid++; return {id:'task-id'}; } } },
    { provide: AssetsService, useValue: { findOwnedUploadedInput: async () => ({ id: 'asset-id', objectKey: 'input', fileHash: descriptor.sha256, mimeType: descriptor.mimeType, sizeBytes: 100, mediaMetadata: descriptor.metadata }) } },
    { provide: AssetPresignService, useValue: { verifyObjectContent: async () => { contentChecks++; if(mismatch) throw Error('different bytes'); } } },
  ] })(HttpTestModule);
  const app = await NestFactory.create(HttpTestModule, {logger:false});
  app.setGlobalPrefix('api');
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const post = (path, body, auth=true) => fetch(base + '/api/v1/tasks' + path, {method:'POST', headers:{'Content-Type':'application/json', 'Idempotency-Key':'request-id', ...(auth ? {Authorization:'Bearer test-token'} : {})}, body:JSON.stringify(body)});
    const prod = {...intent, media:[{role:'reference_image',assetId:'asset-id'}], mode:'production',confirmLiveSubmission:true,preflightId:'preview-id'};
    assert.equal((await post('/preflight',intent,false)).status,401);
    assert.equal((await post('',prod,false)).status,401);
    assert.equal((await post('',prod)).status,400);
    assert.equal(paid,0); assert.equal(contentChecks,0);
    const preview = await post('/preflight',intent); assert.equal(preview.status,201);
    const report = await preview.json(); assert.equal(report.willCallProvider,false); assert.equal(report.willUploadMedia,false);
    assert.equal(paid,0); assert.equal(contentChecks,0);
    budgetAvailable = false;
    const warningPreview = await post('/preflight', intent); assert.equal(warningPreview.status,201);
    const warningReport = await warningPreview.json(); assert.equal(warningReport.checks.budget, 'warning'); assert.equal(warningReport.checks.budgetWarning, 'DAILY_LIMIT_EXCEEDED');
    assert.equal(paid,0); assert.equal(contentChecks,0);
    budgetAvailable = true;
    assert.equal((await post('',{...prod,prompt:{positive:'changed'}})).status,400);
    mismatch=true; assert.equal((await post('',prod)).status,400); assert.equal(paid,0);
    mismatch=false; assert.equal((await post('',prod)).status,201); assert.equal(paid,1);
    console.log('PASS: real HTTP guard, metadata-only preview, skipped/changed preflight rejection, actual-content rejection, confirmed submission');
  } finally { await app.close(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
