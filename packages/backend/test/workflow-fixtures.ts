/** 当前 v2 工作流合同的测试夹具；必须经过真实 Preview HTTP 入口。 */
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { ContractHarness } from './contract-harness';

/** Deterministic isolated object bytes; image metadata is separately seeded, not decoded here. */
export function contractObjectBytes(objectKey: string) {
  return Buffer.from(`contract-object:${objectKey}`);
}

/** Create a real independent PreflightRecord, then return the minimal Production submission. */
export async function referenceImageWorkflowRequest(harness: ContractHarness, prompt: string, assetId: string, resolution = '720p') {
  const asset = await harness.prisma.asset.findUnique({ where: { id: assetId } });
  const objectKey = asset?.objectKey ?? `missing/${assetId}`;
  const bytes = contractObjectBytes(objectKey);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const mimeType = asset?.mimeType ?? 'image/jpeg';
  const metadata = (asset?.mediaMetadata as Record<string, unknown> | null) ?? { kind: 'image', width: 1280, height: 720 };
  if (asset?.ownerId === harness.actorId && asset.role === 'input' && asset.inspectionStatus === 'uploaded') {
    await harness.prisma.asset.update({
      where: { id: assetId },
      data: {
        fileHash: sha256, sizeBytes: bytes.length, mimeType,
        mediaMetadata: metadata as Prisma.InputJsonValue,
        inspectionStatus: 'verified',
      },
    });
  }
  const intent = {
    contractVersion: 2,
    workflowKey: 'seedance.reference-image-to-video.v1',
    prompt: { positive: prompt },
    generation: {
      duration: 5, ratio: '16:9', resolution,
      generateAudio: true, watermark: false, outputFormat: 'mp4',
    },
    media: [{
      slotId: 'reference-image-1', role: 'reference_image', sha256,
      mimeType, sizeBytes: bytes.length, metadata,
    }],
  };
  const preview = await fetch(`${harness.appUrl}/api/v1/tasks/preflight`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${harness.actorToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(intent),
  });
  if (preview.status !== 201) {
    throw new Error(`CONTRACT_PREFLIGHT_FAILED:${preview.status}:${await preview.text()}`);
  }
  const report = await preview.json() as { preflightId: string };
  return {
    mode: 'production',
    preflightId: report.preflightId,
    executionSlotId: `slot-reference-${assetId}`,
    media: [{ slotId: 'reference-image-1', assetId }],
  };
}

export function textPreviewWorkflowRequest(prompt: string, resolution = '720p') {
  return {
    contractVersion: 2,
    workflowKey: 'seedance.text-to-video.v1',
    prompt: { positive: prompt },
    generation: {
      duration: 5, ratio: '16:9', resolution,
      generateAudio: true, watermark: false, outputFormat: 'mp4',
    },
    media: [],
  };
}

export const inspectedImageFixture = {
  mimeType: 'image/jpeg',
  mediaMetadata: { kind: 'image', width: 1280, height: 720 },
};
