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

describe('T02: Budget reservation and admission', () => {
  let harness: Awaited<ReturnType<typeof createContractHarness>>;
  let actorToken: string;
  let actorId: string;

  beforeAll(async () => {
    harness = await createContractHarness({ productionSpec: testSpec });
    actorToken = harness.actorToken;
    actorId = harness.actorId;

    // Set budget limits
    await harness.prisma.actorCredential.update({
      where: { actorId },
      data: {
        dailyLimitCny: new Prisma.Decimal('100.000000'),
        monthlyLimitCny: new Prisma.Decimal('1000.000000'),
      },
    });

    // Enable production gate
    await harness.prisma.productionGate.upsert({
      where: { id: 'production' },
      create: { id: 'production', paused: false },
      update: { paused: false },
    });

    // Create test assets for production tasks
    await harness.prisma.asset.createMany({
      data: [
        {
          ownerId: actorId,
          role: 'input',
          objectKey: 'test/asset-1.jpg',
          fileHash: 'a'.repeat(64),
          inspectionStatus: 'uploaded',
        },
        {
          ownerId: actorId,
          role: 'input',
          objectKey: 'test/asset-2.jpg',
          fileHash: 'b'.repeat(64),
          inspectionStatus: 'uploaded',
        },
      ],
    });

    // Get created asset IDs
    const assets = await harness.prisma.asset.findMany({
      where: { ownerId: actorId },
      select: { id: true },
    });

    // Store asset IDs globally for tests to use
    (global as any).testAssetIds = assets.map(a => a.id);
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    // Clean up tasks and reservations before each test
    await harness.prisma.taskBudgetReservation.deleteMany({});
    await harness.prisma.task.deleteMany({});
  });

  it('reserves budget atomically with task creation', async () => {
    const assetIds = (global as any).testAssetIds || [];
    const response = await fetch(`${harness.appUrl}/api/v1/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${actorToken}`,
        'Idempotency-Key': 'test-reserve-1',
      },
      body: JSON.stringify({
        mode: 'production',
        capability: 'IMAGE_TO_VIDEO',
        profile: 'seedance',
        params: {
          prompt: 'test reservation',
          image_asset_id: assetIds[0],
          duration: 5,
          ratio: '16:9',
        },
      }),
    });

    expect(response.status).toBe(201);
    const task = await response.json();

    const reservation = await harness.prisma.taskBudgetReservation.findUnique({
      where: { taskId: task.id },
    });

    expect(reservation).toBeTruthy();
    expect(reservation!.state).toBe('reserved');
    expect(reservation!.actorId).toBe(actorId);
  });

  it('rejects when daily budget exceeded', async () => {
    const assetIds = (global as any).testAssetIds || [];
    // testSpec.reserveCny is 2.000000; set a limit that allows exactly one task
    await harness.prisma.actorCredential.update({
      where: { actorId },
      data: { dailyLimitCny: new Prisma.Decimal('2.000000') },
    });

    // First task should succeed (2 CNY estimate)
    const response1 = await fetch(`${harness.appUrl}/api/v1/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${actorToken}`,
        'Idempotency-Key': 'test-daily-limit-1',
      },
      body: JSON.stringify({
        mode: 'production',
        capability: 'IMAGE_TO_VIDEO',
        profile: 'seedance',
        params: {
          prompt: 'first task',
          image_asset_id: assetIds[0],
          duration: 5,
          ratio: '16:9',
        },
      }),
    });

    expect(response1.status).toBe(201);

    // Second task should fail: another 2 CNY reservation would exceed the 2 CNY limit
    const response2 = await fetch(`${harness.appUrl}/api/v1/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${actorToken}`,
        'Idempotency-Key': 'test-daily-limit-2',
      },
      body: JSON.stringify({
        mode: 'production',
        capability: 'IMAGE_TO_VIDEO',
        profile: 'seedance',
        params: {
          prompt: 'second task',
          image_asset_id: assetIds[1],
          duration: 5,
          ratio: '16:9',
        },
      }),
    });

    expect(response2.status).toBe(429);
    const error = await response2.json();
    expect(error.message).toContain('Daily budget limit exceeded');

    // Restore limit for other tests
    await harness.prisma.actorCredential.update({
      where: { actorId },
      data: { dailyLimitCny: new Prisma.Decimal('100.000000') },
    });
  });

  it('allows same idempotency key without double reservation', async () => {
    const assetIds = (global as any).testAssetIds || [];
    const body = {
      mode: 'production',
      capability: 'IMAGE_TO_VIDEO',
      profile: 'seedance',
      params: {
        prompt: 'idempotent task',
        image_asset_id: assetIds[0],
        duration: 5,
        ratio: '16:9',
      },
    };

    // First request
    const response1 = await fetch(`${harness.appUrl}/api/v1/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${actorToken}`,
        'Idempotency-Key': 'test-idempotent-1',
      },
      body: JSON.stringify(body),
    });

    expect(response1.status).toBe(201);
    const task1 = await response1.json();

    // Second request with same key
    const response2 = await fetch(`${harness.appUrl}/api/v1/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${actorToken}`,
        'Idempotency-Key': 'test-idempotent-1',
      },
      body: JSON.stringify(body),
    });

    expect(response2.status).toBe(201);
    const task2 = await response2.json();

    expect(task1.id).toBe(task2.id);

    // Should only have one reservation
    const reservations = await harness.prisma.taskBudgetReservation.findMany({
      where: { taskId: task1.id },
    });

    expect(reservations.length).toBe(1);
  });

  it('handles concurrent requests with same key correctly', async () => {
    const assetIds = (global as any).testAssetIds || [];
    const body = {
      mode: 'production',
      capability: 'IMAGE_TO_VIDEO',
      profile: 'seedance',
      params: {
        prompt: 'concurrent task',
        image_asset_id: assetIds[0],
        duration: 5,
        ratio: '16:9',
      },
    };

    // Send two concurrent requests
    const [response1, response2] = await Promise.all([
      fetch(`${harness.appUrl}/api/v1/tasks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${actorToken}`,
          'Idempotency-Key': 'test-concurrent-1',
        },
        body: JSON.stringify(body),
      }),
      fetch(`${harness.appUrl}/api/v1/tasks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${actorToken}`,
          'Idempotency-Key': 'test-concurrent-1',
        },
        body: JSON.stringify(body),
      }),
    ]);

    expect(response1.status).toBe(201);
    expect(response2.status).toBe(201);

    const task1 = await response1.json();
    const task2 = await response2.json();

    expect(task1.id).toBe(task2.id);

    // Should only have one task and one reservation
    const tasks = await harness.prisma.task.findMany({
      where: { clientRequestId: 'test-concurrent-1' },
    });
    const reservations = await harness.prisma.taskBudgetReservation.findMany({});

    expect(tasks.length).toBe(1);
    expect(reservations.length).toBe(1);
  });

  it('rejects when production gate is paused', async () => {
    const assetIds = (global as any).testAssetIds || [];
    await harness.prisma.productionGate.update({
      where: { id: 'production' },
      data: { paused: true, reason: 'Testing pause' },
    });

    const response = await fetch(`${harness.appUrl}/api/v1/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${actorToken}`,
        'Idempotency-Key': 'test-paused-1',
      },
      body: JSON.stringify({
        mode: 'production',
        capability: 'IMAGE_TO_VIDEO',
        profile: 'seedance',
        params: {
          prompt: 'test pause',
          image_asset_id: assetIds[0],
          duration: 5,
          ratio: '16:9',
        },
      }),
    });

    expect(response.status).toBe(503);
    const error = await response.json();
    expect(error.message).toContain('Production is paused');

    // Re-enable for other tests
    await harness.prisma.productionGate.update({
      where: { id: 'production' },
      data: { paused: false },
    });
  });

  it('rejects when no budget limits configured', async () => {
    const assetIds = (global as any).testAssetIds || [];
    await harness.prisma.actorCredential.update({
      where: { actorId },
      data: {
        dailyLimitCny: null,
        monthlyLimitCny: null,
      },
    });

    const response = await fetch(`${harness.appUrl}/api/v1/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${actorToken}`,
        'Idempotency-Key': 'test-no-limits-1',
      },
      body: JSON.stringify({
        mode: 'production',
        capability: 'IMAGE_TO_VIDEO',
        profile: 'seedance',
        params: {
          prompt: 'test no limits',
          image_asset_id: assetIds[0],
          duration: 5,
          ratio: '16:9',
        },
      }),
    });

    expect(response.status).toBe(429);
    const error = await response.json();
    expect(error.message).toContain('Budget limits not configured');

    // Restore limits for other tests
    await harness.prisma.actorCredential.update({
      where: { actorId },
      data: {
        dailyLimitCny: new Prisma.Decimal('100.000000'),
        monthlyLimitCny: new Prisma.Decimal('1000.000000'),
      },
    });
  });

  it('admits only one of two different idempotency keys racing for the last budget slot', async () => {
    const assetIds = (global as any).testAssetIds || [];
    // testSpec.reserveCny is 2.000000; a 2.000000 daily limit allows exactly one task.
    await harness.prisma.actorCredential.update({
      where: { actorId },
      data: { dailyLimitCny: new Prisma.Decimal('2.000000') },
    });

    const makeRequest = (key: string, assetId: string) =>
      fetch(`${harness.appUrl}/api/v1/tasks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${actorToken}`,
          'Idempotency-Key': key,
        },
        body: JSON.stringify({
          mode: 'production',
          capability: 'IMAGE_TO_VIDEO',
          profile: 'seedance',
          params: {
            prompt: 'race for budget',
            image_asset_id: assetId,
            duration: 5,
            ratio: '16:9',
          },
        }),
      });

    const [response1, response2] = await Promise.all([
      makeRequest('test-race-key-1', assetIds[0]),
      makeRequest('test-race-key-2', assetIds[1]),
    ]);

    const statuses = [response1.status, response2.status].sort();
    expect(statuses).toEqual([201, 429]);

    const winner = response1.status === 201 ? response1 : response2;
    const loser = response1.status === 429 ? response1 : response2;
    const winnerTask = await winner.json();
    const loserError = await loser.json();
    expect(loserError.message).toMatch(/budget|limit/i);

    // The rejected request must not leave a task or an orphan reservation behind.
    const tasks = await harness.prisma.task.findMany({
      where: { clientRequestId: { in: ['test-race-key-1', 'test-race-key-2'] } },
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(winnerTask.id);

    const reservations = await harness.prisma.taskBudgetReservation.findMany({});
    expect(reservations).toHaveLength(1);
    expect(reservations[0].taskId).toBe(winnerTask.id);

    // Restore limit for other tests
    await harness.prisma.actorCredential.update({
      where: { actorId },
      data: { dailyLimitCny: new Prisma.Decimal('100.000000') },
    });
  });

  it('computes reservation dayKey/monthKey from Asia/Shanghai time', async () => {
    const assetIds = (global as any).testAssetIds || [];
    const response = await fetch(`${harness.appUrl}/api/v1/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${actorToken}`,
        'Idempotency-Key': 'test-period-keys-1',
      },
      body: JSON.stringify({
        mode: 'production',
        capability: 'IMAGE_TO_VIDEO',
        profile: 'seedance',
        params: {
          prompt: 'period keys',
          image_asset_id: assetIds[0],
          duration: 5,
          ratio: '16:9',
        },
      }),
    });

    expect(response.status).toBe(201);
    const task = await response.json();

    const reservation = await harness.prisma.taskBudgetReservation.findUnique({
      where: { taskId: task.id },
    });

    expect(reservation).toBeTruthy();
    expect(reservation!.dayKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(reservation!.monthKey).toMatch(/^\d{4}-\d{2}$/);
    expect(reservation!.dayKey.startsWith(reservation!.monthKey)).toBe(true);
  });

  it('rejects new production tasks once the daily task count limit is reached', async () => {
    // The backend process reads VIDEO_FLOW_DAILY_TASK_LIMIT at startup, so this
    // needs a dedicated harness spawned with the override, not the shared one.
    const limitedHarness = await createContractHarness({
      productionSpec: testSpec,
      env: { VIDEO_FLOW_DAILY_TASK_LIMIT: '1' },
    });
    try {
      await limitedHarness.prisma.actorCredential.update({
        where: { actorId: limitedHarness.actorId },
        data: {
          dailyLimitCny: new Prisma.Decimal('100.000000'),
          monthlyLimitCny: new Prisma.Decimal('1000.000000'),
        },
      });
      await limitedHarness.prisma.productionGate.upsert({
        where: { id: 'production' },
        create: { id: 'production', paused: false },
        update: { paused: false },
      });
      const asset = await limitedHarness.prisma.asset.create({
        data: {
          ownerId: limitedHarness.actorId,
          role: 'input',
          objectKey: `contract/${limitedHarness.actorId}/daily-count.jpg`,
          fileHash: 'c'.repeat(64),
          inspectionStatus: 'uploaded',
        },
      });
      const asset2 = await limitedHarness.prisma.asset.create({
        data: {
          ownerId: limitedHarness.actorId,
          role: 'input',
          objectKey: `contract/${limitedHarness.actorId}/daily-count-2.jpg`,
          fileHash: 'd'.repeat(64),
          inspectionStatus: 'uploaded',
        },
      });

      const first = await fetch(`${limitedHarness.appUrl}/api/v1/tasks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${limitedHarness.actorToken}`,
          'Idempotency-Key': 'test-daily-count-1',
        },
        body: JSON.stringify({
          mode: 'production',
          capability: 'IMAGE_TO_VIDEO',
          profile: 'seedance',
          params: {
            prompt: 'first of the day',
            image_asset_id: asset.id,
            duration: 5,
            ratio: '16:9',
          },
        }),
      });
      expect(first.status).toBe(201);

      const second = await fetch(`${limitedHarness.appUrl}/api/v1/tasks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${limitedHarness.actorToken}`,
          'Idempotency-Key': 'test-daily-count-2',
        },
        body: JSON.stringify({
          mode: 'production',
          capability: 'IMAGE_TO_VIDEO',
          profile: 'seedance',
          params: {
            prompt: 'second of the day',
            image_asset_id: asset2.id,
            duration: 5,
            ratio: '16:9',
          },
        }),
      });
      expect(second.status).toBe(429);
      const error = await second.json();
      expect(error.message).toMatch(/task count/i);
    } finally {
      await limitedHarness.close();
    }
  });
});
