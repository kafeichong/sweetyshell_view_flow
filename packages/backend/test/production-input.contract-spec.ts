import { createContractHarness, ContractHarness } from './contract-harness';
import { inspectedImageFixture, referenceImageWorkflowRequest } from './workflow-fixtures';

async function createProduction(
  harness: ContractHarness,
  token: string,
  key: string,
  assetId: string,
  paramsOverride: Record<string, unknown> = {},
) {
  const body = { ...await referenceImageWorkflowRequest(harness, 'contract product', assetId), ...paramsOverride };
  return submitProduction(harness, token, key, body);
}

async function submitProduction(
  harness: ContractHarness,
  token: string,
  key: string,
  body: Record<string, unknown>,
) {
  return fetch(`${harness.appUrl}/api/v1/tasks`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    body: JSON.stringify(body),
  });
}

describe('production input contract', () => {
  test('freezes approved parameters for an owned uploaded input', async () => {
    const harness = await createContractHarness({ allowProduction: true });
    try {
      await harness.prisma.productionGate.upsert({
        where: { id: 'production' },
        create: { id: 'production', paused: false },
        update: { paused: false },
      });
      await harness.prisma.actorCredential.update({
        where: { actorId: harness.actorId },
        data: {
          dailyLimitCny: '1000.000000',
          monthlyLimitCny: '10000.000000',
        },
      });
      const input = await harness.prisma.asset.create({
        data: {
          ownerId: harness.actorId,
          role: 'input',
          objectKey: `contract/${harness.actorId}/input.png`,
          mimeType: 'image/png',
          mediaMetadata: { kind: 'image', width: 1280, height: 720 },
          sizeBytes: 10,
          fileHash: 'a'.repeat(64),
          inspectionStatus: 'uploaded',
          ...inspectedImageFixture,
        },
      });
      const body = await referenceImageWorkflowRequest(harness, 'contract product', input.id);
      const response = await submitProduction(harness, harness.actorToken, 'contract-production-owned', body);
      const task = await response.json();

      expect({ status: response.status, message: task.message }).toEqual({ status: 201, message: undefined });
      expect(task.executionPlan).toMatchObject({
        specVersion: 'workflow-production-v2',
        model: 'doubao-seedance-2-5-260628',
        workflowKey: 'seedance.reference-image-to-video.v1',
        resolution: '720p',
        media: [expect.objectContaining({
          assetId: input.id,
          role: 'reference_image',
          fileHash: (await harness.prisma.asset.findUnique({ where: { id: input.id } }))!.fileHash,
        })],
      });
      expect(task.deliveryStatus).toBe('not_started');

      const repeated = await submitProduction(harness, harness.actorToken, 'contract-production-owned', body);
      expect(repeated.status).toBe(201);
      expect((await repeated.json()).id).toBe(task.id);
      expect(
        await harness.prisma.task.count({
          where: { actorId: harness.actorId, status: { not: 'preview' } },
        }),
      ).toBe(1);
    } finally {
      await harness.close();
    }
  });

  test('rejects an uploaded input owned by another actor', async () => {
    const harness = await createContractHarness({ allowProduction: true });
    try {
      const input = await harness.prisma.asset.create({
        data: {
          ownerId: 'another-actor',
          role: 'input',
          objectKey: `contract/${harness.actorId}/other.png`,
          inspectionStatus: 'uploaded',
        },
      });
      const response = await createProduction(
        harness,
        harness.actorToken,
        'contract-production-forbidden',
        input.id,
      );

      expect(response.status).toBe(400);
      expect(
        await harness.prisma.task.count({
          where: { actorId: harness.actorId },
        }),
      ).toBe(0);
    } finally {
      await harness.close();
    }
  });

  test.each([
    ['output', 'uploaded'],
    ['input', 'pending_upload'],
  ])('rejects a %s asset in %s state', async (role, inspectionStatus) => {
    const harness = await createContractHarness({ allowProduction: true });
    try {
      const input = await harness.prisma.asset.create({
        data: {
          ownerId: harness.actorId,
          role,
          objectKey: `contract/${harness.actorId}/${role}-${inspectionStatus}.png`,
          inspectionStatus,
        },
      });
      const response = await createProduction(
        harness,
        harness.actorToken,
        `contract-production-${role}-${inspectionStatus}`,
        input.id,
      );
      expect(response.status).toBe(400);
    } finally {
      await harness.close();
    }
  });

  test.each([
    ['duration mismatch', { duration: 60 }],
    ['direct image URL', { image_url: 'https://example.test/input.png' }],
    ['unknown media field', { audio_urls: ['https://example.test/a.mp3'] }],
  ])('rejects %s before creating a task', async (_name, override) => {
    const harness = await createContractHarness({ allowProduction: true });
    try {
      const input = await harness.prisma.asset.create({
        data: {
          ownerId: harness.actorId,
          role: 'input',
          objectKey: `contract/${harness.actorId}/${randomName(override)}.png`,
          inspectionStatus: 'uploaded',
        },
      });
      const response = await createProduction(
        harness,
        harness.actorToken,
        `contract-production-invalid-${randomName(override)}`,
        input.id,
        override,
      );
      expect(response.status).toBe(400);
      expect(
        await harness.prisma.task.count({ where: { actorId: harness.actorId } }),
      ).toBe(0);
    } finally {
      await harness.close();
    }
  });
});

function randomName(value: Record<string, unknown>): string {
  return Object.keys(value)[0].replace(/[^a-z0-9]+/gi, '-');
}
