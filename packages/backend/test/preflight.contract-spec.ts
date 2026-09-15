import { createContractHarness } from './contract-harness';
import { inspectedImageFixture, referenceImageWorkflowRequest } from './workflow-fixtures';

test('authenticated metadata preflight stays nonexecutable and binds confirmed submission to actual stored bytes', async () => {
  const h = await createContractHarness({ allowProduction: true });
  try {
    await h.prisma.productionGate.upsert({ where: { id: 'production' }, create: { id: 'production', paused: false }, update: { paused: false } });
    await h.prisma.actorCredential.update({ where: { actorId: h.actorId }, data: { dailyLimitCny: '100', monthlyLimitCny: '1000' } });
    const asset = await h.prisma.asset.create({ data: {
      ownerId: h.actorId, role: 'input', objectKey: `contract/${h.actorId}/preflight.jpg`, inspectionStatus: 'uploaded', ...inspectedImageFixture,
    } });
    const seeded = await referenceImageWorkflowRequest(h, 'product preflight', asset.id);
    const seedId = (seeded as { preflightId: string }).preflightId;
    const seed = await h.prisma.preflightRecord.findUniqueOrThrow({ where: { id: seedId } });
    const intent = seed.effectiveRequest;
    const post = (path: string, body: unknown, auth = true) => fetch(`${h.appUrl}/api/v1/tasks${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'confirmed-contract', ...(auth ? { Authorization: `Bearer ${h.actorToken}` } : {}) }, body: JSON.stringify(body),
    });
    expect((await post('/preflight', intent, false)).status).toBe(401);
    const preview = await post('/preflight', intent);
    const report = await preview.json();
    expect({ status: preview.status, message: report.message }).toEqual({ status: 201, message: undefined });
    expect(report).toMatchObject({ willCallProvider: false, willUploadMedia: false });
    const stored = await h.prisma.preflightRecord.findUniqueOrThrow({ where: { id: report.preflightId } });
    expect(stored.effectiveRequest).toEqual(intent);
    expect(await h.prisma.task.count({ where: { actorId: h.actorId } })).toBe(0);
    expect(await h.prisma.taskBudgetReservation.count({ where: { actorId: h.actorId } })).toBe(0);
    expect(await h.prisma.executionAttempt.count({ where: { task: { actorId: h.actorId } } })).toBe(0);
    const body = { ...seeded, preflightId: report.preflightId };
    expect((await post('', { ...body, confirmLiveSubmission: false })).status).toBe(400);
    expect((await post('', { ...body, prompt: { positive: 'changed' } })).status).toBe(400);
    // Preserve declared hash/metadata but change storage key -> transport returns different bytes.
    await h.prisma.asset.update({ where: { id: asset.id }, data: { objectKey: `contract/${h.actorId}/changed.jpg` } });
    const mismatch = await post('', body);
    expect(mismatch.status).toBe(400);
    expect((await mismatch.json()).message).toBe('PREFLIGHT_ACTUAL_CONTENT_MISMATCH');
    await h.prisma.asset.update({ where: { id: asset.id }, data: { objectKey: asset.objectKey } });
    const created = await post('', body);
    expect(created.status).toBe(201);
    const task = await created.json();
    expect(task.status).toBe('pending');
    expect((await (await post('', body)).json()).id).toBe(task.id);
    expect(await h.prisma.taskBudgetReservation.count({ where: { taskId: task.id } })).toBe(1);
  } finally { await h.close(); }
});
