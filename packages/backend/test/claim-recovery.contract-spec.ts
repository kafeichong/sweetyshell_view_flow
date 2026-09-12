import { createContractHarness } from './contract-harness';
import { Prisma } from '@prisma/client';

const testSpec = {
  version: 'test-v1',
  model: 'test-model',
  duration: 5,
  ratio: '16:9',
  resolution: 'test-resolution',
  generateAudio: false,
  watermark: true,
  pricingVersion: 'test-price-v1',
  reserveCny: '2.000000',
};

// Worker Job 模型的 TS 镜像：与 packages/worker/models.py 的 Job 字段一一对应
// （pydantic populate_by_name 允许直接按 camelCase 字段名解析 Backend 响应）。
// 合同测试必须用真实 recover 响应构造 Job，而不是手写一份不同的 fixture。
function parseWorkerJob(payload: Record<string, unknown>) {
  for (const key of ['id', 'status', 'createdBy', 'prompt', 'createdAt']) {
    if (!(key in payload)) {
      throw new Error(`MISSING_JOB_FIELD_${key}`);
    }
  }
  return {
    id: payload.id,
    status: payload.status,
    createdBy: payload.createdBy,
    prompt: payload.prompt,
    createdAt: payload.createdAt,
    taskStatus: payload.taskStatus ?? null,
    deliveryStatus: payload.deliveryStatus ?? null,
    executionPlan: payload.executionPlan ?? null,
    attemptId: payload.attemptId ?? null,
    attemptNo: payload.attemptNo ?? null,
    attemptStatus: payload.attemptStatus ?? null,
    attemptProvider: payload.attemptProvider ?? null,
    attemptModel: payload.attemptModel ?? null,
    attemptSubmittedAt: payload.attemptSubmittedAt ?? null,
    providerTaskId: payload.providerTaskId ?? null,
    providerUsage: payload.providerUsage ?? null,
    pricingVersion: payload.pricingVersion ?? null,
  };
}

async function createProductionTask(
  harness: Awaited<ReturnType<typeof createContractHarness>>,
  assetId: string,
  idempotencyKey: string,
) {
  const response = await fetch(`${harness.appUrl}/api/v1/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${harness.actorToken}`,
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({
      mode: 'production',
      capability: 'IMAGE_TO_VIDEO',
      profile: 'seedance',
      params: {
        prompt: 'claim contract',
        image_asset_id: assetId,
        duration: 5,
        ratio: '16:9',
      },
    }),
  });
  expect(response.status).toBe(201);
  return response.json();
}

async function claimNext(harness: Awaited<ReturnType<typeof createContractHarness>>) {
  return fetch(`${harness.appUrl}/api/tasks/claim`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Worker-Token': harness.workerToken,
    },
    body: JSON.stringify({ mode: 'production', workerId: 'contract-worker' }),
  });
}

async function recoverAll(harness: Awaited<ReturnType<typeof createContractHarness>>) {
  const response = await fetch(`${harness.appUrl}/api/tasks/recover`, {
    headers: { 'X-Worker-Token': harness.workerToken },
  });
  expect(response.status).toBe(200);
  return response.json();
}

describe('T03: Claim admission and recovery contract', () => {
  let harness: Awaited<ReturnType<typeof createContractHarness>>;
  let assetIds: string[];

  beforeAll(async () => {
    harness = await createContractHarness({ productionSpec: testSpec });

    await harness.prisma.productionGate.upsert({
      where: { id: 'production' },
      create: { id: 'production', paused: false },
      update: { paused: false },
    });
    await harness.prisma.actorCredential.update({
      where: { actorId: harness.actorId },
      data: {
        dailyLimitCny: new Prisma.Decimal('100.000000'),
        monthlyLimitCny: new Prisma.Decimal('1000.000000'),
      },
    });

    await harness.prisma.asset.createMany({
      data: [
        {
          ownerId: harness.actorId,
          role: 'input',
          objectKey: `contract/${harness.actorId}/claim-1.jpg`,
          fileHash: 'e'.repeat(64),
          inspectionStatus: 'uploaded',
        },
        {
          ownerId: harness.actorId,
          role: 'input',
          objectKey: `contract/${harness.actorId}/claim-2.jpg`,
          fileHash: 'f'.repeat(64),
          inspectionStatus: 'uploaded',
        },
      ],
    });
    const assets = await harness.prisma.asset.findMany({
      where: { ownerId: harness.actorId },
      select: { id: true },
    });
    assetIds = assets.map((a) => a.id);
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.prisma.executionAttempt.deleteMany({});
    await harness.prisma.taskBudgetReservation.deleteMany({});
    await harness.prisma.task.deleteMany({});
  });

  it('claims a real pending task with an attempt inside the transaction', async () => {
    const task = await createProductionTask(harness, assetIds[0], 'claim-basic-1');

    const response = await claimNext(harness);
    expect(response.status).toBe(201);
    const claimed = await response.json();

    expect(claimed.id).toBe(task.id);
    expect(claimed.status).toBe('submitted');
    expect(claimed.taskStatus).toBe('in_progress');
    expect(claimed.attemptId).toBeTruthy();
    expect(claimed.attemptNo).toBe(1);
    expect(claimed.attemptStatus).toBe('pending');
    expect(claimed.executionPlan).toBeTruthy();
    expect(claimed.deliveryStatus).toBe('not_started');

    const attempt = await harness.prisma.executionAttempt.findUnique({
      where: { id: claimed.attemptId },
    });
    expect(attempt!.taskId).toBe(task.id);
  });

  it('never claims historical pending tasks without execution plan or reservation', async () => {
    // 模拟旧链路遗留：status='pending' 但没有执行快照/预占的历史任务。
    await harness.prisma.task.create({
      data: {
        createdBy: 'legacy-actor',
        actorId: harness.actorId,
        prompt: 'legacy pending',
        status: 'pending',
        taskStatus: null,
      },
    });

    const response = await claimNext(harness);
    expect(response.status).toBe(201);
    expect(await response.text()).toBe('');

    const stillThere = await harness.prisma.task.findFirst({
      where: { prompt: 'legacy pending' },
    });
    expect(stillThere).toBeTruthy();
    expect(stillThere!.status).toBe('pending');
  });

  it('does not claim while the production gate is paused', async () => {
    const task = await createProductionTask(harness, assetIds[0], 'claim-gate-1');

    await harness.prisma.productionGate.update({
      where: { id: 'production' },
      data: { paused: true, reason: 'contract test pause' },
    });

    const response = await claimNext(harness);
    expect(response.status).toBe(201);
    expect(await response.text()).toBe('');

    const untouched = await harness.prisma.task.findUnique({ where: { id: task.id } });
    expect(untouched!.status).toBe('pending');

    await harness.prisma.productionGate.update({
      where: { id: 'production' },
      data: { paused: false },
    });
  });

  it('does not claim when the actor credential is no longer active', async () => {
    const task = await createProductionTask(harness, assetIds[0], 'claim-cred-1');

    await harness.prisma.actorCredential.update({
      where: { actorId: harness.actorId },
      data: { status: 'revoked' },
    });

    const response = await claimNext(harness);
    expect(response.status).toBe(201);
    expect(await response.text()).toBe('');

    const untouched = await harness.prisma.task.findUnique({ where: { id: task.id } });
    expect(untouched!.status).toBe('pending');

    await harness.prisma.actorCredential.update({
      where: { actorId: harness.actorId },
      data: { status: 'active' },
    });
  });

  it('holds at most one in-flight generation at a time', async () => {
    await createProductionTask(harness, assetIds[0], 'claim-inflight-1');
    const first = await claimNext(harness);
    expect((await first.json()).id).toBeTruthy();

    // 第二个任务可被创建，但第一个在途生成未结束前不能被领取。
    await createProductionTask(harness, assetIds[1], 'claim-inflight-2');
    const second = await claimNext(harness);
    expect(second.status).toBe(201);
    expect(await second.text()).toBe('');
  });

  it('recover flattens attempt fields into a worker-consumable job', async () => {
    const task = await createProductionTask(harness, assetIds[0], 'recover-flat-1');
    const claimedResponse = await claimNext(harness);
    const claimed = await claimedResponse.json();
    expect(claimed.id).toBe(task.id);

    // Worker 侧 Provider 已接受：回写 attempt 状态与 providerTaskId。
    const patchResponse = await fetch(`${harness.appUrl}/api/tasks/${task.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-Worker-Token': harness.workerToken,
      },
      body: JSON.stringify({
        status: 'running',
        taskStatus: 'in_progress',
        attemptId: claimed.attemptId,
        attemptStatus: 'running',
        providerTaskId: 'provider-contract-1',
        startedAt: new Date().toISOString(),
      }),
    });
    expect(patchResponse.status).toBe(200);

    const recovered = await recoverAll(harness);
    expect(recovered).toHaveLength(1);

    const raw = recovered[0];
    expect(raw.id).toBe(task.id);
    expect(raw.attemptId).toBe(claimed.attemptId);
    expect(raw.attemptStatus).toBe('running');
    expect(raw.providerTaskId).toBe('provider-contract-1');
    expect(raw.taskStatus).toBe('in_progress');

    // 真实 recover 响应必须能直接构造 Worker Job（models.py 的字段合同）。
    const job = parseWorkerJob(raw);
    expect(job.providerTaskId).toBe('provider-contract-1');
    expect(job.attemptId).toBe(claimed.attemptId);
    expect(job.executionPlan).toBeTruthy();
  });

  it('rejects attempt write-backs whose taskId does not match the path task', async () => {
    const task1 = await createProductionTask(harness, assetIds[0], 'mismatch-1');
    const claimedResponse = await claimNext(harness);
    const claimed = await claimedResponse.json();
    expect(claimed.id).toBe(task1.id);

    // 第二个任务保持 pending，Worker 拿 task1 的 attemptId 回写 task2 必须被拒绝。
    const task2 = await createProductionTask(harness, assetIds[1], 'mismatch-2');

    const response = await fetch(`${harness.appUrl}/api/tasks/${task2.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-Worker-Token': harness.workerToken,
      },
      body: JSON.stringify({
        attemptId: claimed.attemptId,
        attemptStatus: 'completed',
      }),
    });
    expect(response.status).toBe(400);
    const error = await response.json();
    expect(error.message).toContain('ATTEMPT_TASK_MISMATCH');
  });

  it('rejects resetting a submitted task back to pending', async () => {
    const task = await createProductionTask(harness, assetIds[0], 'reset-1');
    const claimedResponse = await claimNext(harness);
    const claimed = await claimedResponse.json();

    // 先让 attempt 离开 pending（Provider 已接受），此后再重置 pending 即为非法。
    await fetch(`${harness.appUrl}/api/tasks/${task.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-Worker-Token': harness.workerToken,
      },
      body: JSON.stringify({
        attemptId: claimed.attemptId,
        attemptStatus: 'running',
        providerTaskId: 'provider-reset-1',
      }),
    });

    const response = await fetch(`${harness.appUrl}/api/tasks/${task.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-Worker-Token': harness.workerToken,
      },
      body: JSON.stringify({
        status: 'pending',
        taskStatus: 'pending',
        attemptId: claimed.attemptId,
      }),
    });
    expect(response.status).toBe(409);
    const error = await response.json();
    expect(error.message).toContain('CANNOT_RESET_TASK_TO_PENDING');
  });

  it('retires the legacy creation endpoint with 410 after authentication', async () => {
    const unauthenticated = await fetch(`${harness.appUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ createdBy: 'probe', prompt: 'probe' }),
    });
    expect(unauthenticated.status).toBe(401);

    const authenticated = await fetch(`${harness.appUrl}/api/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': harness.adminToken,
      },
      body: JSON.stringify({ createdBy: 'probe', prompt: 'probe' }),
    });
    expect(authenticated.status).toBe(410);
    const body = await authenticated.json();
    expect(body.message).toContain('USE_V1_TASKS');
  });
});
