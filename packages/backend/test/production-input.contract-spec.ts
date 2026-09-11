import { createContractHarness } from './contract-harness';

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

async function createProduction(
  appUrl: string,
  token: string,
  key: string,
  assetId: string,
  paramsOverride: Record<string, unknown> = {},
) {
  return fetch(`${appUrl}/api/v1/tasks`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    body: JSON.stringify({
      mode: 'production',
      capability: 'IMAGE_TO_VIDEO',
      profile: 'seedance',
      params: {
        prompt: 'contract product',
        image_asset_id: assetId,
        duration: 5,
        ratio: '16:9',
        ...paramsOverride,
      },
    }),
  });
}

describe('production input contract', () => {
  test('freezes approved parameters for an owned uploaded input', async () => {
    const harness = await createContractHarness({ productionSpec: testSpec });
    try {
      const input = await harness.prisma.asset.create({
        data: {
          ownerId: harness.actorId,
          role: 'input',
          objectKey: `contract/${harness.actorId}/input.png`,
          mimeType: 'image/png',
          sizeBytes: 10,
          fileHash: 'a'.repeat(64),
          inspectionStatus: 'uploaded',
        },
      });
      const response = await createProduction(
        harness.appUrl,
        harness.actorToken,
        'contract-production-owned',
        input.id,
      );
      const task = await response.json();

      expect(response.status).toBe(201);
      expect(task.executionPlan).toMatchObject({
        specVersion: 'test-v1',
        model: 'test-model',
        imageAssetId: input.id,
        inputFileHash: 'a'.repeat(64),
        resolution: 'test-resolution',
      });
      expect(task.deliveryStatus).toBe('not_started');

      const repeated = await createProduction(
        harness.appUrl,
        harness.actorToken,
        'contract-production-owned',
        input.id,
      );
      expect(repeated.status).toBe(201);
      expect((await repeated.json()).id).toBe(task.id);
      expect(
        await harness.prisma.task.count({
          where: { actorId: harness.actorId },
        }),
      ).toBe(1);
    } finally {
      await harness.close();
    }
  });

  test('rejects an uploaded input owned by another actor', async () => {
    const harness = await createContractHarness({ productionSpec: testSpec });
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
        harness.appUrl,
        harness.actorToken,
        'contract-production-forbidden',
        input.id,
      );

      expect(response.status).toBe(403);
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
    const harness = await createContractHarness({ productionSpec: testSpec });
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
        harness.appUrl,
        harness.actorToken,
        `contract-production-${role}-${inspectionStatus}`,
        input.id,
      );
      expect(response.status).toBe(403);
    } finally {
      await harness.close();
    }
  });

  test.each([
    ['duration mismatch', { duration: 60 }],
    ['direct image URL', { image_url: 'https://example.test/input.png' }],
    ['unknown media field', { audio_urls: ['https://example.test/a.mp3'] }],
  ])('rejects %s before creating a task', async (_name, override) => {
    const harness = await createContractHarness({ productionSpec: testSpec });
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
        harness.appUrl,
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
