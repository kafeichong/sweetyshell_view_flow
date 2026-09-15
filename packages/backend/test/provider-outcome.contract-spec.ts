import { createContractHarness } from './contract-harness';
import { Prisma } from '@prisma/client';
import { inspectedImageFixture, referenceImageWorkflowRequest } from './workflow-fixtures';

// 计费规则与 task-cost.ts 登记的一致：价格版本 + 模型都要匹配，
// 否则终态只会进人工核查，不会套一个错公式结算。
const PRICING_VERSION = 'seedance-2.5-public-catalog-2026-09-15';
const VERIFIED_MODEL = 'doubao-seedance-2-5-260628';
const RATE_PER_MILLION = 70;

function expectedCost(tokens: number): string {
  // 与 Backend 的 tokenCostCny 同构（Decimal 向上取整到 6 位）：
  // 测试用整数 tokens 时结果精确，可直接比较字符串。
  return new Prisma.Decimal(tokens)
    .mul(RATE_PER_MILLION)
    .div(1_000_000)
    .toDecimalPlaces(6, Prisma.Decimal.ROUND_UP)
    .toFixed(6);
}

type Harness = Awaited<ReturnType<typeof createContractHarness>>;

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
    body: JSON.stringify(await referenceImageWorkflowRequest(harness, 'provider outcome contract', assetId, '720p')),
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
  const claimed = await response.json();
  expect(claimed.attemptId).toBeTruthy();
  return claimed;
}

async function reportOutcome(
  harness: Harness,
  attemptId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${harness.appUrl}/api/v1/internal/attempts/${attemptId}/outcome`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'X-Worker-Token': harness.workerToken,
    },
    body: JSON.stringify(body),
  });
}

async function reviewBudget(
  harness: Harness,
  taskId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${harness.appUrl}/api/v1/admin/tasks/${taskId}/budget-review`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Token': harness.adminToken,
    },
    body: JSON.stringify(body),
  });
}

describe('T05: Provider outcome settlement contract', () => {
  let harness: Harness;
  let assetIds: string[];

  beforeAll(async () => {
    harness = await createContractHarness({ allowProduction: true });

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
          objectKey: `contract/${harness.actorId}/outcome-1.jpg`,
          fileHash: '1'.repeat(64),
          inspectionStatus: 'uploaded',
          ...inspectedImageFixture,
        },
        {
          ownerId: harness.actorId,
          role: 'input',
          objectKey: `contract/${harness.actorId}/outcome-2.jpg`,
          fileHash: '2'.repeat(64),
          inspectionStatus: 'uploaded',
          ...inspectedImageFixture,
        },
        {
          ownerId: harness.actorId,
          role: 'input',
          objectKey: `contract/${harness.actorId}/outcome-3.jpg`,
          fileHash: '3'.repeat(64),
          inspectionStatus: 'uploaded',
          ...inspectedImageFixture,
        },
        {
          ownerId: harness.actorId,
          role: 'input',
          objectKey: `contract/${harness.actorId}/outcome-4.jpg`,
          fileHash: '4'.repeat(64),
          inspectionStatus: 'uploaded',
          ...inspectedImageFixture,
        },
      ],
    });

    const assets = await harness.prisma.asset.findMany({
      where: { ownerId: harness.actorId },
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

  it('settles the budget from frozen usage and moves the task into archiving', async () => {
    const task = await createProductionTask(harness, assetIds[0], 'outcome-basic');
    const claimed = await claimTask(harness);

    const response = await reportOutcome(harness, claimed.attemptId, {
      providerTaskId: 'provider-outcome-1',
      status: 'succeeded',
      usage: { completion_tokens: 10000 },
    });

    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.outcome).toBe('applied');
    expect(result.cost).toMatchObject({
      status: 'usage_calculated',
      amountCny: expectedCost(10000),
      pricingVersion: PRICING_VERSION,
    });

    const attempt = await harness.prisma.executionAttempt.findUnique({
      where: { id: claimed.attemptId },
    });
    expect(attempt!.status).toBe('completed');
    expect(attempt!.providerUsage).toEqual({ completion_tokens: 10000 });
    expect(attempt!.pricingVersion).toBe(PRICING_VERSION);

    const reservation = await harness.prisma.taskBudgetReservation.findUnique({
      where: { taskId: task.id },
    });
    expect(reservation!.state).toBe('settled');
    expect(reservation!.settledCny!.toFixed(6)).toBe(expectedCost(10000));

    const updatedTask = await harness.prisma.task.findUnique({ where: { id: task.id } });
    expect(updatedTask!.status).toBe('archiving');
    expect(updatedTask!.taskStatus).toBe('in_progress');
    expect(updatedTask!.deliveryStatus).toBe('archiving');
  });

  it('is idempotent when the same terminal outcome is reported twice', async () => {
    await createProductionTask(harness, assetIds[0], 'outcome-repeat');
    const claimed = await claimTask(harness);
    const body = {
      providerTaskId: 'provider-outcome-repeat',
      status: 'succeeded',
      usage: { completion_tokens: 10000 },
    };

    const first = await reportOutcome(harness, claimed.attemptId, body);
    expect(first.status).toBe(200);
    expect((await first.json()).outcome).toBe('applied');

    const second = await reportOutcome(harness, claimed.attemptId, body);
    expect(second.status).toBe(200);
    expect((await second.json()).outcome).toBe('idempotent');

    const reservations = await harness.prisma.taskBudgetReservation.findMany({});
    expect(reservations).toHaveLength(1);
    expect(reservations[0].settledCny!.toFixed(6)).toBe(expectedCost(10000));
    expect(reservations[0].state).toBe('settled');
  });

  it('sends conflicting usage to review without overwriting the first evidence', async () => {
    const task = await createProductionTask(harness, assetIds[0], 'outcome-conflict');
    const claimed = await claimTask(harness);

    await reportOutcome(harness, claimed.attemptId, {
      providerTaskId: 'provider-outcome-conflict',
      status: 'succeeded',
      usage: { completion_tokens: 10000 },
    });

    const conflict = await reportOutcome(harness, claimed.attemptId, {
      providerTaskId: 'provider-outcome-conflict',
      status: 'succeeded',
      usage: { completion_tokens: 20000 },
    });
    expect(conflict.status).toBe(200);
    expect((await conflict.json()).outcome).toBe('review');

    // 第一次的 usage 与结算金额是既有依据，冲突回写不许覆盖。
    const attempt = await harness.prisma.executionAttempt.findUnique({
      where: { id: claimed.attemptId },
    });
    expect(attempt!.providerUsage).toEqual({ completion_tokens: 10000 });

    const reservation = await harness.prisma.taskBudgetReservation.findUnique({
      where: { taskId: task.id },
    });
    expect(reservation!.state).toBe('review');
    expect(reservation!.settledCny!.toFixed(6)).toBe(expectedCost(10000));
  });

  it('keeps the reservation in review but still allows archiving when usage is missing', async () => {
    const task = await createProductionTask(harness, assetIds[1], 'outcome-no-usage');
    const claimed = await claimTask(harness);

    const response = await reportOutcome(harness, claimed.attemptId, {
      providerTaskId: 'provider-outcome-no-usage',
      status: 'succeeded',
      usage: null,
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.outcome).toBe('applied');
    expect(result.cost.status).toBe('unavailable');
    expect(result.cost.amountCny).toBeNull();

    const reservation = await harness.prisma.taskBudgetReservation.findUnique({
      where: { taskId: task.id },
    });
    expect(reservation!.state).toBe('review');
    expect(reservation!.settledCny).toBeNull();

    // 费用未知不能拦住已生成的视频。
    const updatedTask = await harness.prisma.task.findUnique({ where: { id: task.id } });
    expect(updatedTask!.status).toBe('archiving');
    expect(updatedTask!.deliveryStatus).toBe('archiving');
  });

  it('treats a failed generation as charged when usage proves it', async () => {
    const task = await createProductionTask(harness, assetIds[2], 'outcome-failed-usage');
    const claimed = await claimTask(harness);

    const response = await reportOutcome(harness, claimed.attemptId, {
      providerTaskId: 'provider-outcome-failed',
      status: 'failed',
      usage: { completion_tokens: 5000 },
      errorCode: 'CONTENT_POLICY',
    });
    expect(response.status).toBe(200);
    expect((await response.json()).outcome).toBe('applied');

    const reservation = await harness.prisma.taskBudgetReservation.findUnique({
      where: { taskId: task.id },
    });
    expect(reservation!.state).toBe('settled');
    expect(reservation!.settledCny!.toFixed(6)).toBe(expectedCost(5000));

    const updatedTask = await harness.prisma.task.findUnique({ where: { id: task.id } });
    expect(updatedTask!.status).toBe('failed');
    expect(updatedTask!.taskStatus).toBe('failed');
    expect(updatedTask!.deliveryStatus).toBe('not_started');
  });

  it('never treats a provider failure as free without evidence', async () => {
    const task = await createProductionTask(harness, assetIds[3], 'outcome-failed-no-usage');
    const claimed = await claimTask(harness);

    const response = await reportOutcome(harness, claimed.attemptId, {
      providerTaskId: 'provider-outcome-failed-nousage',
      status: 'failed',
      errorCode: 'UPSTREAM_ERROR',
    });
    expect(response.status).toBe(200);

    const reservation = await harness.prisma.taskBudgetReservation.findUnique({
      where: { taskId: task.id },
    });
    // 保留预占等人工核实：HTTP failed 不等于没花钱。
    expect(reservation!.state).toBe('review');
    expect(reservation!.settledCny).toBeNull();
  });

  it('rejects an outcome reported against another attempt provider task', async () => {
    await createProductionTask(harness, assetIds[0], 'outcome-owner-1');
    const claimed = await claimTask(harness);

    await reportOutcome(harness, claimed.attemptId, {
      providerTaskId: 'provider-owned',
      status: 'succeeded',
      usage: { completion_tokens: 1000 },
    });

    const response = await reportOutcome(harness, claimed.attemptId, {
      providerTaskId: 'provider-someone-else',
      status: 'succeeded',
      usage: { completion_tokens: 1000 },
    });

    expect(response.status).toBe(409);
    const error = await response.json();
    expect(error.message).toContain('PROVIDER_TASK_MISMATCH');
  });

  it('settles or releases a reviewed reservation only through the audited admin action', async () => {
    const task = await createProductionTask(harness, assetIds[0], 'outcome-review-action');
    const claimed = await claimTask(harness);

    await reportOutcome(harness, claimed.attemptId, {
      providerTaskId: 'provider-review-action',
      status: 'succeeded',
      usage: null,
    });

    const settled = await reviewBudget(harness, task.id, {
      decision: 'settle',
      amountCny: '3.500000',
      evidenceRef: 'ark-bill-2026-09',
      operator: 'steven',
    });
    expect(settled.status).toBe(200);
    const settledBody = await settled.json();
    expect(settledBody.reservationState).toBe('settled');
    expect(settledBody.settledCny).toBe('3.500000');
    expect(settledBody.operatorIsDeclaredClaim).toBe(true);

    const reservation = await harness.prisma.taskBudgetReservation.findUnique({
      where: { taskId: task.id },
    });
    expect(reservation!.state).toBe('settled');
    expect(reservation!.settledCny!.toFixed(6)).toBe('3.500000');
    expect(reservation!.reviewOperator).toBe('steven');
    expect(reservation!.reviewEvidenceRef).toBe('ark-bill-2026-09');

    const attempt = await harness.prisma.executionAttempt.findUnique({
      where: { id: claimed.attemptId },
    });
    expect(attempt!.costStatus).toBe('billed');
    expect(attempt!.billedCostCny!.toFixed(6)).toBe('3.500000');
  });

  it('releases a reviewed reservation without claiming a billed amount', async () => {
    await createProductionTask(harness, assetIds[1], 'outcome-release-action');
    const claimed = await claimTask(harness);

    await reportOutcome(harness, claimed.attemptId, {
      providerTaskId: 'provider-release-action',
      status: 'failed',
      errorCode: 'UPSTREAM_ERROR',
    });

    const task = await harness.prisma.task.findFirst({
      where: { actorId: harness.actorId, clientRequestId: 'outcome-release-action' },
    });

    const released = await reviewBudget(harness, task!.id, {
      decision: 'release',
      evidenceRef: 'provider-trace-42',
      operator: 'steven',
    });
    expect(released.status).toBe(200);
    expect((await released.json()).reservationState).toBe('released');

    const reservation = await harness.prisma.taskBudgetReservation.findUnique({
      where: { taskId: task!.id },
    });
    expect(reservation!.state).toBe('released');
    expect(reservation!.settledCny).toBeNull();
  });

  it('requires the worker token and validates the review payload', async () => {
    const unauthorized = await fetch(`${harness.appUrl}/api/v1/internal/attempts/00000000-0000-0000-0000-000000000000/outcome`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'succeeded' }),
    });
    expect(unauthorized.status).toBe(401);

    await createProductionTask(harness, assetIds[2], 'outcome-validation');
    const claimed = await claimTask(harness);

    const badStatus = await reportOutcome(harness, claimed.attemptId, {
      providerTaskId: 'provider-validation',
      status: 'maybe',
    });
    expect(badStatus.status).toBe(400);

    const task = await harness.prisma.task.findFirst({
      where: { actorId: harness.actorId, clientRequestId: 'outcome-validation' },
    });
    const badReview = await reviewBudget(harness, task!.id, {
      decision: 'settle',
      evidenceRef: 'ref',
      operator: 'steven',
    });
    expect(badReview.status).toBe(400);
  });
});
