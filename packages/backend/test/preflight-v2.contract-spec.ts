import { createContractHarness } from './contract-harness';

const intent = {
  contractVersion: 2,
  workflowKey: 'seedance.text-to-video.v1',
  prompt: { positive: '雨后的街道，镜头缓慢推进' },
  generation: {
    duration: 4,
    ratio: '16:9',
    resolution: '720p',
    generateAudio: true,
    watermark: false,
    outputFormat: 'mp4',
  },
  media: [],
};

test('authenticated v2 Preview creates only an independent preflight record and reports admission blockers', async () => {
  const h = await createContractHarness();
  try {
    await h.prisma.productionGate.upsert({
      where: { id: 'production' },
      create: { id: 'production', paused: true, reason: 'contract fail-closed check' },
      update: { paused: true, reason: 'contract fail-closed check' },
    });
    const before = {
      tasks: await h.prisma.task.count({ where: { actorId: h.actorId } }),
      attempts: await h.prisma.executionAttempt.count({ where: { task: { actorId: h.actorId } } }),
      reservations: await h.prisma.taskBudgetReservation.count({ where: { actorId: h.actorId } }),
    };
    const request = (authorization = true) => fetch(`${h.appUrl}/api/v1/tasks/preflight`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: `Bearer ${h.actorToken}` } : {}) },
      body: JSON.stringify(intent),
    });

    expect((await request(false)).status).toBe(401);
    const response = await request();
    expect(response.status).toBe(201);
    const report = await response.json();
    expect(report).toMatchObject({
      requestCheck: { status: 'passed' },
      productionAdmission: { canSubmit: false },
      quote: {
        status: 'estimated',
        estimatedCny: '6.111000',
        reserveCny: '6.111000',
        pricingVersion: 'seedance-2.5-public-catalog-2026-09-15',
      },
      willUploadMedia: false,
      willCallProvider: false,
      effectiveRequest: intent,
      model: 'doubao-seedance-2-5-260628',
    });
    // text-to-video 已验收完链路（implementation=ready），但 R8 收口后准入关闭，
    // 所以这里只剩"未准入"而没有 WORKFLOW_NOT_READY；那条 blocker 由其余七类
    // 仍处 incomplete 的工作流覆盖（见 PreflightService 单测）。
    expect(report.productionAdmission.blockers.map((item: { code: string }) => item.code)).toEqual(expect.arrayContaining([
      'PRODUCTION_NOT_ALLOWED', 'WORKFLOW_NOT_ENABLED', 'PRODUCTION_PAUSED',
    ]));
    expect(await h.prisma.preflightRecord.count({ where: { actorId: h.actorId } })).toBe(1);
    expect(await h.prisma.task.count({ where: { actorId: h.actorId } })).toBe(before.tasks);
    expect(await h.prisma.executionAttempt.count({ where: { task: { actorId: h.actorId } } })).toBe(before.attempts);
    expect(await h.prisma.taskBudgetReservation.count({ where: { actorId: h.actorId } })).toBe(before.reservations);

    const check = await fetch(`${h.appUrl}/api/v1/tasks/preflight/${report.preflightId}/check`, {
      headers: { Authorization: `Bearer ${h.actorToken}` },
    });
    expect(check.status).toBe(200);
    await expect(check.json()).resolves.toMatchObject({
      preflightId: report.preflightId,
      requestCheck: { status: 'passed' },
      willUploadMedia: false,
      willCallProvider: false,
    });

    const directory = await fetch(`${h.appUrl}/api/v1/tasks/workflows`, {
      headers: { Authorization: `Bearer ${h.actorToken}` },
    });
    const catalog = await directory.json();
    expect(directory.status).toBe(200);
    expect(catalog.contractVersion).toBe(2);
    expect(catalog.contractRevision).toBe('2026-09-15.4');
    expect(catalog.contractDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(catalog.model).toBe('doubao-seedance-2-5-260628');
    expect(catalog.workflows).toHaveLength(8);
    // 目录里第一条是 text-to-video：链路已验收（validation 有记录），但 R8 第一轮
    // 验收未走完 30 秒边界，所以准入仍然关闭。
    expect(catalog.workflows[0].state).toEqual(expect.objectContaining({
      capability: 'confirmed', implementation: 'ready',
      admission: { enabled: false, reason: 'R8_ACCEPTANCE_INCOMPLETE' },
    }));

    const retired = await fetch(`${h.appUrl}/api/v1/tasks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${h.actorToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'retired-preview' },
      body: JSON.stringify({ ...intent, mode: 'preview' }),
    });
    expect(retired.status).toBe(400);
    await expect(retired.json()).resolves.toMatchObject({
      code: 'PREVIEW_TASK_CREATION_RETIRED',
      path: 'mode',
      message: 'Use POST /api/v1/tasks/preflight for Preview',
    });
  } finally {
    await h.prisma.productionGate.updateMany({ where: { id: 'production' }, data: { paused: true, reason: 'contract cleanup' } });
    await h.close();
  }
});

test('confirmed v2 text submission creates one frozen Task and one reservation without a Provider call', async () => {
  const h = await createContractHarness({
    allowProduction: true,
    readyWorkflows: 'seedance.text-to-video.v1',
  });
  try {
    await h.prisma.actorCredential.update({
      where: { actorId: h.actorId },
      data: { dailyLimitCny: '100.000000', monthlyLimitCny: '1000.000000' },
    });
    await h.prisma.productionGate.upsert({
      where: { id: 'production' },
      create: { id: 'production', paused: false },
      update: { paused: false, reason: null },
    });
    const headers = { Authorization: `Bearer ${h.actorToken}`, 'Content-Type': 'application/json' };
    const preview = await fetch(`${h.appUrl}/api/v1/tasks/preflight`, {
      method: 'POST', headers, body: JSON.stringify(intent),
    });
    expect(preview.status).toBe(201);
    const report = await preview.json();
    expect(report.productionAdmission).toMatchObject({ canSubmit: true, blockers: [] });

    const submission = {
      mode: 'production', preflightId: report.preflightId, executionSlotId: 'slot-text-main', media: [],
    };
    const submit = () => fetch(`${h.appUrl}/api/v1/tasks`, {
      method: 'POST', headers: { ...headers, 'Idempotency-Key': 'r4-text-4s' },
      body: JSON.stringify(submission),
    });
    const concurrentSubmit = () => fetch(`${h.appUrl}/api/v1/tasks`, {
      method: 'POST', headers: { ...headers, 'Idempotency-Key': 'r4-text-concurrent' },
      body: JSON.stringify(submission),
    });
    const [first, concurrent] = await Promise.all([submit(), concurrentSubmit()]);
    expect(first.status).toBe(201);
    expect(concurrent.status).toBe(201);
    const task = await first.json();
    const concurrentTask = await concurrent.json();
    expect(concurrentTask.id).toBe(task.id);
    expect([task.recovered, concurrentTask.recovered]).toContain(true);
    expect(task).toMatchObject({ status: 'pending' });
    expect([task.deduplicated, concurrentTask.deduplicated].sort()).toEqual([false, true]);
    expect(task.executionPlan).toMatchObject({
      specVersion: 'workflow-production-v2', workflowKey: 'seedance.text-to-video.v1',
      duration: 4, ratio: '16:9', resolution: '720p', reserveCny: '6.111000',
      quoteDigest: report.quote.quoteDigest,
    });
    expect(task.executionSlotId).toBe('slot-text-main');
    expect(task.slotSequence).toBe(1);
    expect(task.clientDeliveryStatus).toBe('pending');
    expect(task.executionPlan.pricingSnapshot).toEqual(report.quote.basis.pricingSnapshot);

    const repeated = await submit();
    expect(repeated.status).toBe(201);
    await expect(repeated.json()).resolves.toMatchObject({ id: task.id, deduplicated: true });

    const recover = await fetch(`${h.appUrl}/api/v1/tasks`, {
      method: 'POST', headers: { ...headers, 'Idempotency-Key': 'r4-text-current-recovery' },
      body: JSON.stringify({ ...submission, preflightId: '00000000-0000-0000-0000-000000000000' }),
    });
    expect(recover.status).toBe(201);
    await expect(recover.json()).resolves.toMatchObject({ id: task.id, recovered: true });

    await h.prisma.task.update({ where: { id: task.id }, data: { deliveryStatus: 'ready' } });
    const delivery = await fetch(`${h.appUrl}/api/v1/tasks/${task.id}/client-delivery`, {
      method: 'POST', headers,
    });
    expect(delivery.status).toBe(201);
    await expect(delivery.json()).resolves.toMatchObject({ clientDeliveryStatus: 'delivered', applied: true });

    const second = await fetch(`${h.appUrl}/api/v1/tasks`, {
      method: 'POST', headers: { ...headers, 'Idempotency-Key': 'r4-text-4s-v2' },
      body: JSON.stringify(submission),
    });
    expect(second.status).toBe(201);
    await expect(second.json()).resolves.toMatchObject({ slotSequence: 2, deduplicated: false });
    expect(await h.prisma.task.count({ where: { actorId: h.actorId } })).toBe(2);
    expect(await h.prisma.taskBudgetReservation.count({ where: { actorId: h.actorId } })).toBe(2);
    expect(await h.prisma.executionAttempt.count({ where: { taskId: task.id } })).toBe(0);
  } finally {
    await h.prisma.productionGate.updateMany({ where: { id: 'production' }, data: { paused: true, reason: 'contract cleanup' } });
    await h.close();
  }
});
