jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target, createParamDecorator: () => () => () => {},
  Controller: () => (target: unknown) => target, UseGuards: () => (target: unknown) => target,
  Post: () => () => {}, Get: () => () => {}, Body: () => () => {}, Headers: () => () => {}, Param: () => () => {},
  ConflictException: class ConflictException extends Error { status = 409; },
  BadRequestException: class BadRequestException extends Error { status = 400; },
  ForbiddenException: class ForbiddenException extends Error { status = 403; },
  HttpException: class HttpException extends Error { constructor(message: string, public status: number) { super(message); } },
  HttpStatus: { SERVICE_UNAVAILABLE: 503, TOO_MANY_REQUESTS: 429 },
  ServiceUnavailableException: class ServiceUnavailableException extends Error { status = 503; },
}));
import { V1TasksController } from './v1-tasks.controller';

const spec = JSON.stringify({ version: 'test-v1', model: 'test-model', duration: 5, ratio: '16:9', resolution: '720p', generateAudio: false, watermark: true, pricingVersion: 'price-v1', reserveCny: '2.000000' });
const referenceRequest = { workflowKey: 'seedance.reference-image-to-video.v1', prompt: { positive: 'product orbit' }, generation: { duration: 5, ratio: '16:9', resolution: '720p' }, media: [{ assetId: 'asset-1', role: 'reference_image' }] };

describe('V1TasksController workflow-only task API', () => {
  const tasks = { findByActorRequest: jest.fn(), createPreview: jest.fn(), findSummaryForActor: jest.fn() };
  const budget = { createTaskWithReservation: jest.fn() };
  const assets = { findOwnedUploadedInput: jest.fn() };
  beforeEach(() => {
    process.env.VIDEO_FLOW_PRODUCTION_ACTORS = 'creative-pilot'; process.env.VIDEO_FLOW_PRODUCTION_SPEC_JSON = spec;
    tasks.findByActorRequest.mockResolvedValue(null); tasks.createPreview.mockReset(); budget.createTaskWithReservation.mockReset();
    budget.createTaskWithReservation.mockResolvedValue({ id: 'task-1', status: 'pending' }); assets.findOwnedUploadedInput.mockResolvedValue({ id: 'asset-1', fileHash: 'a'.repeat(64), mimeType: 'image/png', mediaMetadata: { kind: 'image' } });
  });
  it('rejects the retired capability/profile request shape before it can create a task', async () => {
    await expect(new V1TasksController(tasks as never, budget as never, assets as never).create({ actorId: 'creative-pilot' }, 'old-1', { capability: 'IMAGE_TO_VIDEO', profile: 'seedance', params: { prompt: 'x' } } as never)).rejects.toMatchObject({ status: 400, message: 'WORKFLOW_KEY_REQUIRED' });
    expect(budget.createTaskWithReservation).not.toHaveBeenCalled(); expect(tasks.createPreview).not.toHaveBeenCalled();
  });
  it('creates a preview task without a paid attempt', async () => {
    tasks.createPreview.mockResolvedValue({ id: 'preview-1', status: 'preview' });
    const result = await new V1TasksController(tasks as never, budget as never, assets as never).create({ actorId: 'creative-pilot' }, 'preview-1', referenceRequest);
    expect(result).toMatchObject({ id: 'preview-1', preview: { workflowKey: referenceRequest.workflowKey, willCallProvider: false } }); expect(budget.createTaskWithReservation).not.toHaveBeenCalled();
  });
  it('creates the production-verified reference workflow with frozen role-based media', async () => {
    await new V1TasksController(tasks as never, budget as never, assets as never).create({ actorId: 'creative-pilot' }, 'production-1', { ...referenceRequest, mode: 'production' });
    expect(budget.createTaskWithReservation).toHaveBeenCalledWith(expect.objectContaining({ task: expect.objectContaining({ workflowName: referenceRequest.workflowKey, workflowVersion: 'v1' }), executionPlan: expect.objectContaining({ media: [{ assetId: 'asset-1', role: 'reference_image', fileHash: 'a'.repeat(64) }] }) }));
  });
  it('returns a prior task for the same actor, idempotency key and body', async () => {
    tasks.findByActorRequest.mockResolvedValue({ id: 'existing', requestSnapshot: referenceRequest });
    await expect(new V1TasksController(tasks as never, budget as never, assets as never).create({ actorId: 'creative-pilot' }, 'same-1', referenceRequest)).resolves.toMatchObject({ id: 'existing' });
  });
  it('rejects preview-only text-to-video from Production', async () => {
    await expect(new V1TasksController(tasks as never, budget as never, assets as never).create({ actorId: 'creative-pilot' }, 'text-1', { workflowKey: 'seedance.text-to-video.v1', mode: 'production', prompt: { positive: 'product orbit' }, generation: { duration: 5, ratio: '16:9', resolution: '720p' }, media: [] })).rejects.toMatchObject({ status: 400, message: 'WORKFLOW_NOT_PRODUCTION_VERIFIED' });
  });
});

describe('V1TasksController workflow-only safety regressions', () => {
  const tasks = { findByActorRequest: jest.fn(), createPreview: jest.fn(), findSummaryForActor: jest.fn() };
  const budget = { createTaskWithReservation: jest.fn() };
  const assets = { findOwnedUploadedInput: jest.fn() };
  const body = { workflowKey: 'seedance.reference-image-to-video.v1', prompt: { positive: 'product orbit' }, generation: { duration: 5, ratio: '16:9', resolution: '720p' }, media: [{ assetId: 'asset-1', role: 'reference_image' }] };
  beforeEach(() => { process.env.VIDEO_FLOW_PRODUCTION_ACTORS = 'creative-pilot'; process.env.VIDEO_FLOW_PRODUCTION_SPEC_JSON = spec; tasks.findByActorRequest.mockResolvedValue(null); assets.findOwnedUploadedInput.mockResolvedValue({ id: 'asset-1', fileHash: null, mimeType: 'image/png', mediaMetadata: { kind: 'image' } }); budget.createTaskWithReservation.mockResolvedValue({ id: 'task-1' }); });
  it('requires an idempotency key', async () => {
    await expect(new V1TasksController(tasks as never, budget as never, assets as never).create({ actorId: 'creative-pilot' }, '', body)).rejects.toMatchObject({ status: 409 });
  });
  it('rejects a reused idempotency key with a different request', async () => {
    tasks.findByActorRequest.mockResolvedValue({ id: 'old', requestSnapshot: body });
    await expect(new V1TasksController(tasks as never, budget as never, assets as never).create({ actorId: 'creative-pilot' }, 'same', { ...body, prompt: { positive: 'changed' } })).rejects.toMatchObject({ status: 409 });
  });
  it('does not permit a non-whitelisted actor to create Production work', async () => {
    await expect(new V1TasksController(tasks as never, budget as never, assets as never).create({ actorId: 'other' }, 'denied', { ...body, mode: 'production' })).rejects.toMatchObject({ status: 403 });
    expect(budget.createTaskWithReservation).not.toHaveBeenCalled();
  });
  it('requires a Production input Asset owned by the actor', async () => {
    assets.findOwnedUploadedInput.mockResolvedValue(null);
    await expect(new V1TasksController(tasks as never, budget as never, assets as never).create({ actorId: 'creative-pilot' }, 'asset-denied', { ...body, mode: 'production' })).rejects.toMatchObject({ status: 403 });
  });
  it('fails closed if the approved Production spec is absent', async () => {
    delete process.env.VIDEO_FLOW_PRODUCTION_SPEC_JSON;
    await expect(new V1TasksController(tasks as never, budget as never, assets as never).create({ actorId: 'creative-pilot' }, 'no-spec', { ...body, mode: 'production' })).rejects.toMatchObject({ status: 503 });
  });
  it('allows a non-executing text preview without a Production spec', async () => {
    delete process.env.VIDEO_FLOW_PRODUCTION_SPEC_JSON;
    tasks.createPreview.mockResolvedValue({ id: 'preview-text', status: 'preview' });
    await expect(new V1TasksController(tasks as never, budget as never, assets as never).create({ actorId: 'creative-pilot' }, 'preview-no-spec', {
      workflowKey: 'seedance.text-to-video.v1', mode: 'preview', prompt: { positive: 'a glass bottle rotates' },
      generation: { duration: 5, ratio: '16:9', resolution: '720p' }, media: [],
    })).resolves.toMatchObject({ id: 'preview-text', preview: { willCallProvider: false } });
    expect(budget.createTaskWithReservation).not.toHaveBeenCalled();
  });
  it('does not reserve a paid task when an inspected asset does not match its workflow role', async () => {
    assets.findOwnedUploadedInput.mockResolvedValue({ id: 'asset-1', fileHash: null, mimeType: 'video/mp4', mediaMetadata: { kind: 'video' } });
    await expect(new V1TasksController(tasks as never, budget as never, assets as never).create({ actorId: 'creative-pilot' }, 'wrong-kind', { ...body, mode: 'production' })).rejects.toMatchObject({ status: 400, message: 'WORKFLOW_ASSET_KIND_MISMATCH' });
    expect(budget.createTaskWithReservation).not.toHaveBeenCalled();
  });
});

it('does not create a preview task for a disabled workflow', async () => {
  process.env.VIDEO_FLOW_PRODUCTION_SPEC_JSON = spec;
  const tasks = { findByActorRequest: jest.fn().mockResolvedValue(null), createPreview: jest.fn() };
  const assets = {};
  await expect(new V1TasksController(tasks as never, undefined, assets as never).create(
    { actorId: 'creative-pilot' }, 'disabled-1', {
      workflowKey: 'seedance.first-frame-to-video.v1', mode: 'preview',
      prompt: { positive: 'product orbit' }, generation: { duration: 5, ratio: 'adaptive', resolution: '720p' },
      media: [{ assetId: 'asset-1', role: 'first_frame' }],
    },
  )).rejects.toMatchObject({ status: 400, message: 'WORKFLOW_DISABLED' });
  expect(tasks.createPreview).not.toHaveBeenCalled();
});
