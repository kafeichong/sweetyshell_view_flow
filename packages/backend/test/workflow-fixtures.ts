/** 当前 v1 工作流合同的测试夹具；禁止再在合同测试中构造旧 capability/profile/params 请求。 */
import { createHash } from 'crypto';
import { ContractHarness } from './contract-harness';
import { preflightSnapshot } from '../src/v1/tasks/workflow-preflight';
import { ProductionSpec } from '../src/tasks/production-spec';

/** Deterministic isolated object bytes; image metadata is separately seeded, not decoded here. */
export function contractObjectBytes(objectKey: string) {
  return Buffer.from(`contract-object:${objectKey}`);
}

/** Seed an earlier successful preflight so budget/gate tests can change admission state afterwards.
 * The dedicated HTTP preflight test covers creation through the authenticated endpoint.
 */
export async function referenceImageWorkflowRequest(harness: ContractHarness, prompt: string, assetId: string, resolution = 'test-resolution') {
  const body = {
    mode: 'production',
    workflowKey: 'seedance.reference-image-to-video.v1',
    prompt: { positive: prompt },
    generation: { duration: 5, ratio: '16:9', resolution },
    media: [{ assetId, role: 'reference_image' }],
    confirmLiveSubmission: true,
  };
  const asset = await harness.prisma.asset.findUnique({ where: { id: assetId } });
  if (!asset || asset.ownerId !== harness.actorId || asset.role !== 'input' || asset.inspectionStatus !== 'uploaded' || !asset.mediaMetadata) return body;
  const bytes = contractObjectBytes(asset.objectKey);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await harness.prisma.asset.update({ where: { id: assetId }, data: { fileHash: sha256, sizeBytes: bytes.length } });
  const intent = { workflowKey: body.workflowKey, prompt: body.prompt, generation: body.generation,
    media: [{ sha256, sizeBytes: bytes.length, mimeType: asset.mimeType, metadata: asset.mediaMetadata, role: 'reference_image' }] };
  const snapshot = preflightSnapshot(intent, harness.productionSpec as ProductionSpec);
  const clientRequestId = `preflight-fixture:${createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')}`;
  const record = await harness.prisma.task.upsert({
    where: { actorId_clientRequestId: { actorId: harness.actorId, clientRequestId } },
    create: { actorId: harness.actorId, createdBy: harness.actorId, clientRequestId, status: 'preview',
      capability: 'image_to_video', workflowName: body.workflowKey, prompt, requestSnapshot: snapshot },
    update: {},
  });
  return { ...body, preflightId: record.id };
}

export function textPreviewWorkflowRequest(prompt: string, resolution = 'test-resolution') {
  return {
    mode: 'preview',
    workflowKey: 'seedance.text-to-video.v1',
    prompt: { positive: prompt },
    generation: { duration: 5, ratio: '16:9', resolution },
    media: [],
  };
}

export const inspectedImageFixture = {
  mimeType: 'image/jpeg',
  mediaMetadata: { kind: 'image', width: 1280, height: 720 },
};
