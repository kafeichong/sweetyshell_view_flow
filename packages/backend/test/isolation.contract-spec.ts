import {
  assertContractEnvironment,
  createContractHarness,
} from './contract-harness';
import { textPreviewWorkflowRequest } from './workflow-fixtures';

describe('contract test isolation', () => {
  test('rejects a non-contract database before connecting', () => {
    expect(() =>
      assertContractEnvironment({
        VIDEO_FLOW_TEST_MODE: '1',
        DATABASE_URL: 'postgresql://test:test@127.0.0.1/video_flow',
        VIDEO_FLOW_PROVIDER_BASE_URL: 'http://127.0.0.1:19091/api/v3',
      }),
    ).toThrow('CONTRACT_DATABASE_REQUIRED');
  });

  test('rejects a real provider credential in contract mode', () => {
    expect(() =>
      assertContractEnvironment({
        VIDEO_FLOW_TEST_MODE: '1',
        DATABASE_URL:
          'postgresql://test:test@127.0.0.1/video_flow_contract',
        VIDEO_FLOW_PROVIDER_BASE_URL: 'http://127.0.0.1:19091/api/v3',
        VOLCENGINE_ACCESS_KEY: 'ark-real-looking-key',
      }),
    ).toThrow('REAL_PROVIDER_CREDENTIAL_FORBIDDEN');
  });
});

describe('real Nest and PostgreSQL contract harness', () => {
  test('creates an authenticated preflight record without Task, Attempt, reservation or Provider call', async () => {
    const harness = await createContractHarness();
    try {
      const before = {
        preflights: await harness.prisma.preflightRecord.count({ where: { actorId: harness.actorId } }),
        tasks: await harness.prisma.task.count({ where: { actorId: harness.actorId } }),
        attempts: await harness.prisma.executionAttempt.count({ where: { task: { actorId: harness.actorId } } }),
        reservations: await harness.prisma.taskBudgetReservation.count({ where: { actorId: harness.actorId } }),
      };
      const response = await fetch(`${harness.appUrl}/api/v1/tasks/preflight`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${harness.actorToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(textPreviewWorkflowRequest('contract test only', '720p')),
      });
      const report = await response.json();

      expect(response.status).toBe(201);
      expect(report).toMatchObject({ willUploadMedia: false, willCallProvider: false });
      expect(await harness.prisma.preflightRecord.count({ where: { actorId: harness.actorId } })).toBe(before.preflights + 1);
      expect(await harness.prisma.task.count({ where: { actorId: harness.actorId } })).toBe(before.tasks);
      expect(await harness.prisma.executionAttempt.count({ where: { task: { actorId: harness.actorId } } })).toBe(before.attempts);
      expect(await harness.prisma.taskBudgetReservation.count({ where: { actorId: harness.actorId } })).toBe(before.reservations);
      const providerStats = await fetch(
        `${process.env.VIDEO_FLOW_PROVIDER_BASE_URL}/__test__/stats`,
      ).then((result) => result.json());
      expect(providerStats.createCount).toBe(0);
    } finally {
      await harness.close();
    }
  });
});
