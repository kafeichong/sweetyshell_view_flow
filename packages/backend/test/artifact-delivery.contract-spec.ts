import { createHash } from 'crypto';
import { createContractHarness } from './contract-harness';
import { Prisma } from '@prisma/client';

const PRICING_VERSION = 'seedance-token-v1';
const VERIFIED_MODEL = 'doubao-seedance-2-5-260628';

const testSpec = {
  version: 'test-v1',
  model: VERIFIED_MODEL,
  duration: 5,
  ratio: '16:9',
  resolution: 'test-resolution',
  generateAudio: false,
  watermark: true,
  pricingVersion: PRICING_VERSION,
  reserveCny: '2.000000',
};

type Harness = Awaited<ReturnType<typeof createContractHarness>>;

// 产物在对象存储里的固定位置，必须与 Worker 的 artifact_delivery 一致。
function artifactObjectKey(taskId: string, attemptId: string): string {
  return `videos/${taskId}/${attemptId}/result.mp4`;
}

async function createProductionTask(
  harness: Harness,
  assetId: string,
  key: string,
): Promise<{ id: string }> {
  const response = await fetch(`${harness.appUrl}/api/v1/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${harness.actorToken}`,
      'Idempotency-Key': key,
    },
    body: JSON.stringify({
      mode: 'production',
      capability: 'IMAGE_TO_VIDEO',
      profile: 'seedance',
      params: {
        prompt: 'artifact delivery contract',
        image_asset_id: assetId,
        duration: 5,
        ratio: '16:9',
      },
    }),
  });
  expect(response.status).toBe(201);
  return response.json();
}

async function claimTask(harness: Harness): Promise<{ id: string; attemptId: string }> {
  const response = await fetch(`${harness.appUrl}/api/tasks/claim`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Worker-Token': harness.workerToken,
    },
    body: JSON.stringify({ mode: 'production', workerId: 'contract-worker' }),
  });
  expect(response.status).toBe(201);
  return response.json();
}

async function reportOutcome(
  harness: Harness,
  attemptId: string,
  providerTaskId: string,
): Promise<void> {
  const response = await fetch(
    `${harness.appUrl}/api/v1/internal/attempts/${attemptId}/outcome`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-Worker-Token': harness.workerToken,
      },
      body: JSON.stringify({
        providerTaskId,
        status: 'succeeded',
        usage: { total_tokens: 10000 },
      }),
    },
  );
  expect(response.status).toBe(200);
  expect((await response.json()).outcome).toBe('applied');
}

async function registerArtifact(
  harness: Harness,
  taskId: string,
  attemptId: string,
  overrides: Record<string, unknown> = {},
): Promise<Response> {
  return fetch(`${harness.appUrl}/api/v1/internal/attempts/assets`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Worker-Token': harness.workerToken,
    },
    body: JSON.stringify({
      taskId,
      attemptId,
      objectKey: artifactObjectKey(taskId, attemptId),
      bucket: 'contract-bucket',
      mediaType: 'video',
      mimeType: 'video/mp4',
      sizeBytes: 2048,
      ...overrides,
    }),
  });
}

async function reportDelivery(
  harness: Harness,
  attemptId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${harness.appUrl}/api/v1/internal/attempts/${attemptId}/delivery`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'X-Worker-Token': harness.workerToken,
    },
    body: JSON.stringify(body),
  });
}

async function fetchResult(harness: Harness, taskId: string): Promise<Response> {
  return fetch(`${harness.appUrl}/api/v1/assets/tasks/${taskId}/result`, {
    headers: { 'Authorization': `Bearer ${harness.actorToken}` },
  });
}

async function fetchSummary(
  harness: Harness,
  taskId: string,
  token: string = harness.actorToken,
): Promise<Response> {
  return fetch(`${harness.appUrl}/api/v1/tasks/${taskId}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
}

async function resumeDelivery(
  harness: Harness,
  taskId: string,
  body: Record<string, unknown> = {
    reason: 'worker crashed mid-archiving',
    operator: 'steven',
    evidenceRef: 'incident-2026-09-13',
  },
): Promise<Response> {
  return fetch(`${harness.appUrl}/api/v1/admin/tasks/${taskId}/resume-delivery`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Token': harness.adminToken,
    },
    body: JSON.stringify(body),
  });
}

describe('T06: Artifact delivery contract', () => {
  let harness: Harness;
  let assetIds: string[];

  beforeAll(async () => {
    harness = await createContractHarness({
      productionSpec: testSpec,
      // 下载链接按需签发，合同环境用假凭证即可（签名是本地计算，不访问 OSS）。
      env: {
        OSS_ACCESS_KEY_ID: 'contract-oss-key',
        OSS_ACCESS_KEY_SECRET: 'contract-oss-secret',
        OSS_BUCKET: 'contract-bucket',
        OSS_REGION: 'oss-cn-beijing',
      },
    });

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
      data: ['1', '2', '3', '4'].map((suffix) => ({
        ownerId: harness.actorId,
        role: 'input',
        objectKey: `contract/${harness.actorId}/delivery-${suffix}.jpg`,
        fileHash: suffix.repeat(64),
        inspectionStatus: 'uploaded',
      })),
    });

    const assets = await harness.prisma.asset.findMany({
      where: { ownerId: harness.actorId, role: 'input' },
      orderBy: { objectKey: 'asc' },
      select: { id: true },
    });
    assetIds = assets.map((asset) => asset.id);
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.prisma.executionAttempt.deleteMany({});
    await harness.prisma.taskBudgetReservation.deleteMany({});
    await harness.prisma.task.deleteMany({});
  });

  /** 走到"Provider 已成功、等待归档"这一步。 */
  async function arriveAtArchiving(assetIndex: number, key: string) {
    const task = await createProductionTask(harness, assetIds[assetIndex], key);
    const claimed = await claimTask(harness);
    await reportOutcome(harness, claimed.attemptId, `provider-${key}`);
    return { task, claimed };
  }

  it('delivers a registered artifact and exposes it through the result endpoint', async () => {
    const { task, claimed } = await arriveAtArchiving(0, 'delivery-happy');
    const objectKey = artifactObjectKey(task.id, claimed.attemptId);

    const registration = await registerArtifact(harness, task.id, claimed.attemptId);
    expect(registration.status).toBe(201);
    const registered = await registration.json();
    expect(registered.objectKey).toBe(objectKey);
    expect(registered.deduplicated).toBe(false);

    const delivery = await reportDelivery(harness, claimed.attemptId, {
      status: 'ready',
      objectKey,
    });
    expect(delivery.status).toBe(200);
    expect((await delivery.json()).deliveryStatus).toBe('ready');

    const updated = await harness.prisma.task.findUnique({ where: { id: task.id } });
    expect(updated!.status).toBe('completed');
    expect(updated!.taskStatus).toBe('completed');
    expect(updated!.deliveryStatus).toBe('ready');
    expect(updated!.videoUrl).toBe(objectKey);

    const result = await fetchResult(harness, task.id);
    expect(result.status).toBe(200);
    const resultBody = await result.json();
    expect(resultBody.assetId).toBe(registered.assetId);
    expect(resultBody.objectKey).toBe(objectKey);
    expect(typeof resultBody.downloadUrl).toBe('string');
    // 下载链接按需签发，不能把签名 URL 当成永久产物标识存下来。
    expect(JSON.stringify(await harness.prisma.task.findUnique({ where: { id: task.id } })))
      .not.toContain('Signature=');
  });

  it('registers the same object key once even when archiving is retried', async () => {
    const { task, claimed } = await arriveAtArchiving(0, 'delivery-retry');

    const first = await registerArtifact(harness, task.id, claimed.attemptId);
    const second = await registerArtifact(harness, task.id, claimed.attemptId);

    expect(second.status).toBe(201);
    const firstBody = await first.json();
    const secondBody = await second.json();
    expect(secondBody.deduplicated).toBe(true);
    expect(secondBody.assetId).toBe(firstBody.assetId);

    const outputs = await harness.prisma.asset.findMany({
      where: { taskId: task.id, role: 'output' },
    });
    expect(outputs).toHaveLength(1);
  });

  it('rejects a ready delivery that has no registered artifact', async () => {
    const { task, claimed } = await arriveAtArchiving(0, 'delivery-no-asset');
    const objectKey = artifactObjectKey(task.id, claimed.attemptId);

    const delivery = await reportDelivery(harness, claimed.attemptId, {
      status: 'ready',
      objectKey,
    });

    expect(delivery.status).toBe(409);
    expect((await delivery.json()).message).toContain('DELIVERY_ASSET_NOT_REGISTERED');
  });

  it('records a staged delivery failure without erasing the paid provider evidence', async () => {
    const { task, claimed } = await arriveAtArchiving(0, 'delivery-failed');

    const delivery = await reportDelivery(harness, claimed.attemptId, {
      status: 'failed',
      errorCode: 'ARTIFACT_UPLOAD_FAILED',
      stage: 'upload',
    });
    expect(delivery.status).toBe(200);

    const updated = await harness.prisma.task.findUnique({ where: { id: task.id } });
    expect(updated!.status).toBe('failed');
    expect(updated!.deliveryStatus).toBe('failed');
    expect(updated!.errorMsg).toBe('upload:ARTIFACT_UPLOAD_FAILED');

    // Provider 成功与费用证据保持不变：归档失败不等于没花钱。
    const attempt = await harness.prisma.executionAttempt.findUnique({
      where: { id: claimed.attemptId },
    });
    expect(attempt!.status).toBe('completed');
    expect(attempt!.providerUsage).toEqual({ total_tokens: 10000 });

    const reservation = await harness.prisma.taskBudgetReservation.findUnique({
      where: { taskId: task.id },
    });
    expect(reservation!.state).toBe('settled');

    const result = await fetchResult(harness, task.id);
    expect(result.status).toBe(409);
    expect((await result.json()).message).toBe('DELIVERY_FAILED');
  });

  it('tells the user apart not-ready, review and failed results', async () => {
    const pending = await createProductionTask(harness, assetIds[0], 'delivery-pending');
    const pendingResult = await fetchResult(harness, pending.id);
    expect(pendingResult.status).toBe(409);
    expect((await pendingResult.json()).message).toBe('RESULT_NOT_READY');

    const { task, claimed } = await arriveAtArchiving(0, 'delivery-review');
    await harness.prisma.executionAttempt.update({
      where: { id: claimed.attemptId },
      data: { status: 'requires_review' },
    });
    await harness.prisma.task.update({
      where: { id: task.id },
      data: { status: 'requires_review', taskStatus: 'requires_review', deliveryStatus: 'not_started' },
    });

    const reviewResult = await fetchResult(harness, task.id);
    expect(reviewResult.status).toBe(409);
    expect((await reviewResult.json()).message).toBe('RESULT_REQUIRES_REVIEW');
  });

  it('exposes execution, delivery and cost sections on the task summary', async () => {
    const { task, claimed } = await arriveAtArchiving(0, 'delivery-summary');
    await registerArtifact(harness, task.id, claimed.attemptId);
    await reportDelivery(harness, claimed.attemptId, {
      status: 'ready',
      objectKey: artifactObjectKey(task.id, claimed.attemptId),
    });

    const response = await fetchSummary(harness, task.id);
    expect(response.status).toBe(200);
    const summary = await response.json();

    expect(summary.execution).toMatchObject({
      attemptId: claimed.attemptId,
      providerTaskId: `provider-delivery-summary`,
      status: 'completed',
    });
    expect(summary.delivery).toMatchObject({ status: 'ready' });
    expect(summary.delivery.assetId).toBeTruthy();
    expect(summary.costSummary).toMatchObject({
      status: 'usage_calculated',
      pricingVersion: PRICING_VERSION,
      usageCalculatedCny: '0.700000',
      reservationState: 'settled',
    });
    // 金额一律以十进制字符串返回，不落回二进制浮点。
    expect(typeof summary.costSummary.settledCny).toBe('string');
  });

  it('resumes a failed delivery through the audited admin action', async () => {
    const { task, claimed } = await arriveAtArchiving(0, 'delivery-resume');

    await reportDelivery(harness, claimed.attemptId, {
      status: 'failed',
      errorCode: 'ARTIFACT_DOWNLOAD_FAILED',
      stage: 'download',
    });

    const attemptsBefore = await harness.prisma.executionAttempt.count({
      where: { taskId: task.id },
    });

    const resumed = await resumeDelivery(harness, task.id);
    expect(resumed.status).toBe(200);
    const resumedBody = await resumed.json();
    expect(resumedBody.deliveryStatus).toBe('archiving');
    expect(resumedBody.operatorIsDeclaredClaim).toBe(true);

    const updated = await harness.prisma.task.findUnique({ where: { id: task.id } });
    expect(updated!.status).toBe('archiving');
    expect(updated!.deliveryStatus).toBe('archiving');
    expect(updated!.errorMsg).toBeNull();

    // 恢复的是搬运，不是生成：Attempt 数量不变，Provider 侧没有被再次调用。
    expect(
      await harness.prisma.executionAttempt.count({ where: { taskId: task.id } }),
    ).toBe(attemptsBefore);

    // 重跑归档：同一个 key 只留一条产物记录。
    await registerArtifact(harness, task.id, claimed.attemptId);
    await reportDelivery(harness, claimed.attemptId, {
      status: 'ready',
      objectKey: artifactObjectKey(task.id, claimed.attemptId),
    });

    const outputs = await harness.prisma.asset.findMany({
      where: { taskId: task.id, role: 'output' },
    });
    expect(outputs).toHaveLength(1);
    expect((await fetchResult(harness, task.id)).status).toBe(200);
  });

  it('refuses to resume a delivery that never succeeded at the provider', async () => {
    const task = await createProductionTask(harness, assetIds[0], 'delivery-resume-unsafe');
    const claimed = await claimTask(harness);
    await reportDelivery(harness, claimed.attemptId, {
      status: 'failed',
      errorCode: 'NOTHING_TO_DELIVER',
      stage: 'provider_result',
    });

    const resumed = await resumeDelivery(harness, task.id);
    expect(resumed.status).toBe(409);
    expect((await resumed.json()).message).toContain('PROVIDER_SUCCESS_REQUIRED');
  });

  it('keeps task results private to their owner', async () => {
    const { task, claimed } = await arriveAtArchiving(0, 'delivery-private');
    await registerArtifact(harness, task.id, claimed.attemptId);
    await reportDelivery(harness, claimed.attemptId, {
      status: 'ready',
      objectKey: artifactObjectKey(task.id, claimed.attemptId),
    });

    const otherActorId = `contract-other-${task.id}`;
    const otherToken = `vf_${'a'.repeat(64)}`;
    await harness.prisma.actorCredential.create({
      data: {
        actorId: otherActorId,
        name: 'other actor',
        tokenHash: createHash('sha256').update(otherToken).digest('hex'),
      },
    });

    try {
      const anonymous = await fetch(
        `${harness.appUrl}/api/v1/assets/tasks/${task.id}/result`,
      );
      expect(anonymous.status).toBe(401);

      // 越权取片必须与"任务不存在"同样返回 404，不泄漏任务是否存在。
      const otherActor = await fetch(
        `${harness.appUrl}/api/v1/assets/tasks/${task.id}/result`,
        { headers: { 'Authorization': `Bearer ${otherToken}` } },
      );
      expect(otherActor.status).toBe(404);

      const otherSummary = await fetchSummary(harness, task.id, otherToken);
      expect(otherSummary.status).toBe(404);

      // 本人仍然拿得到。
      expect((await fetchResult(harness, task.id)).status).toBe(200);
    } finally {
      await harness.prisma.actorCredential.delete({ where: { actorId: otherActorId } });
    }
  });

  it('requires the worker token to report delivery', async () => {
    const unauthorized = await fetch(
      `${harness.appUrl}/api/v1/internal/attempts/00000000-0000-0000-0000-000000000000/delivery`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'ready', objectKey: 'videos/x/y/result.mp4' }),
      },
    );
    expect(unauthorized.status).toBe(401);
  });
});
