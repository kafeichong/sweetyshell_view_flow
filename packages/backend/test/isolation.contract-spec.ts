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
  test('creates an authenticated Preview task without a Provider attempt', async () => {
    const harness = await createContractHarness();
    try {
      const response = await fetch(`${harness.appUrl}/api/v1/tasks`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${harness.actorToken}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'contract-preview-1',
        },
        body: JSON.stringify(textPreviewWorkflowRequest('contract test only', '720p')),
      });
      const task = await response.json();

      expect(response.status).toBe(201);
      expect(task.status).toBe('preview');
      expect(
        await harness.prisma.executionAttempt.count({
          where: { taskId: task.id },
        }),
      ).toBe(0);
      const providerStats = await fetch(
        `${process.env.VIDEO_FLOW_PROVIDER_BASE_URL}/__test__/stats`,
      ).then((result) => result.json());
      expect(providerStats.createCount).toBe(0);
    } finally {
      await harness.close();
    }
  });
});
