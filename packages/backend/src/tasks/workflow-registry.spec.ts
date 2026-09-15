import { normalizeWorkflowTaskRequest, validateWorkflowInputAssets } from './workflow-registry';

const spec = {
  version: 'seedance-approved-v1', model: 'test-model', duration: 5,
  ratio: '16:9', resolution: '720p', generateAudio: false, watermark: true,
  pricingVersion: 'test-price-v1', reserveCny: '2.000000',
};

describe('workflow registry request normalization', () => {
  it('normalizes the registered reference-image workflow into a role-based execution intent', () => {
    expect(normalizeWorkflowTaskRequest({
      workflowKey: 'seedance.reference-image-to-video.v1',
      prompt: { positive: 'product orbit' },
      generation: { duration: 5, ratio: '16:9', resolution: '720p' },
      media: [{ assetId: 'asset-1', role: 'reference_image' }],
    }, spec)).toMatchObject({
      workflowKey: 'seedance.reference-image-to-video.v1', workflowVersion: 'v1',
      capability: 'IMAGE_TO_VIDEO', media: [{ assetId: 'asset-1', role: 'reference_image' }],
    });
  });

  it('accepts the creative generation range for the verified reference-image workflow', () => {
    expect(normalizeWorkflowTaskRequest({
      workflowKey: 'seedance.reference-image-to-video.v1',
      prompt: { positive: 'product orbit' },
      generation: { duration: 30, ratio: '9:16', resolution: '1080p' },
      media: [{ assetId: 'asset-1', role: 'reference_image' }],
    }, spec).generation).toEqual({ duration: 30, ratio: '9:16', resolution: '1080p' });
  });

  it('requires workflowKey instead of accepting the retired capability/profile contract', () => {
    expect(() => normalizeWorkflowTaskRequest({
      capability: 'IMAGE_TO_VIDEO', profile: 'seedance',
      params: { prompt: 'product orbit', image_asset_id: 'asset-1', duration: 5, ratio: '16:9' },
    }, spec)).toThrow('WORKFLOW_KEY_REQUIRED');
  });

  it('keeps text-to-video preview-only and rejects input media for it', () => {
    const text = normalizeWorkflowTaskRequest({
      workflowKey: 'seedance.text-to-video.v1', prompt: { positive: 'a glass bottle rotates' },
      generation: { duration: 5, ratio: '16:9', resolution: '720p' }, media: [],
    }, spec);
    expect(text.status).toBe('preview_only');
    expect(() => normalizeWorkflowTaskRequest({
      workflowKey: 'seedance.text-to-video.v1', prompt: { positive: 'x' },
      generation: { duration: 5, ratio: '16:9', resolution: '720p' },
      media: [{ assetId: 'asset-1', role: 'reference_image' }],
    }, spec)).toThrow('WORKFLOW_MEDIA_NOT_ALLOWED');
  });

  it('requires both frames in first-to-last order for the first-and-last-frame workflow', () => {
    const body = {
      workflowKey: 'seedance.first-last-frame-to-video.v1', prompt: { positive: 'a flower blooms' },
      generation: { duration: 5, ratio: 'adaptive', resolution: '720p' },
      media: [
        { assetId: 'asset-first', role: 'first_frame' },
        { assetId: 'asset-last', role: 'last_frame' },
      ],
    };
    expect(normalizeWorkflowTaskRequest(body, spec)).toMatchObject({
      media: body.media, generation: { duration: 5, ratio: 'adaptive', resolution: '720p' },
    });
    expect(() => normalizeWorkflowTaskRequest({ ...body, media: [body.media[1], body.media[0]] }, spec)).toThrow('WORKFLOW_MEDIA_ORDER_INVALID');
    expect(() => normalizeWorkflowTaskRequest({ ...body, media: [body.media[0]] }, spec)).toThrow('WORKFLOW_MEDIA_COUNT_INVALID');
  });

  it('requires at least one referenced asset for omni reference and preserves the declared media order', () => {
    const body = {
      workflowKey: 'seedance.omni-reference.v1', prompt: { positive: 'bright biscuit commercial' },
      generation: { duration: 15, ratio: '16:9', resolution: '720p' },
      media: [
        { assetId: 'image-1', role: 'reference_image' },
        { assetId: 'video-1', role: 'reference_video' },
        { assetId: 'audio-1', role: 'reference_audio' },
      ],
    };
    expect(normalizeWorkflowTaskRequest(body, spec)).toMatchObject({ media: body.media });
    expect(() => normalizeWorkflowTaskRequest({ ...body, media: [] }, spec)).toThrow('WORKFLOW_MEDIA_REQUIRED');
    expect(() => normalizeWorkflowTaskRequest({ ...body, media: [body.media[1], body.media[0]] }, spec)).toThrow('WORKFLOW_MEDIA_ORDER_INVALID');
  });

  it('keeps adaptive-only generation constraints explicit for video editing', () => {
    const body = {
      workflowKey: 'seedance.video-edit.v1', prompt: { positive: 'remove all people except the hero from @video1' },
      generation: { duration: -1, ratio: 'adaptive', resolution: '720p' },
      media: [{ assetId: 'video-1', role: 'reference_video' }],
    };
    expect(normalizeWorkflowTaskRequest(body, spec)).toMatchObject({ generation: body.generation });
    expect(() => normalizeWorkflowTaskRequest({ ...body, generation: { ...body.generation, ratio: '16:9' } }, spec)).toThrow('WORKFLOW_GENERATION_MISMATCH');
  });

  it('freezes official Provider fields by workflow instead of deriving them from a prompt', () => {
    const normalized = normalizeWorkflowTaskRequest({
      workflowKey: 'seedance.video-extend.v1', prompt: { positive: 'extend @video1 into @video2' },
      generation: { duration: 11, ratio: 'adaptive', resolution: '720p' },
      media: [{ assetId: 'video-1', role: 'reference_video' }],
    }, spec);
    expect(normalized.providerFields).toEqual({ omniReferenceTaskType: 'extend', outputFormat: 'mov' });
  });

  it('binds every role in a production plan to inspected asset metadata', () => {
    expect(() => validateWorkflowInputAssets(
      [{ assetId: 'video-1', role: 'reference_video' }],
      [{ id: 'video-1', mimeType: 'video/mp4', mediaMetadata: { kind: 'video' } }],
    )).not.toThrow();
    expect(() => validateWorkflowInputAssets(
      [{ assetId: 'image-1', role: 'reference_video' }],
      [{ id: 'image-1', mimeType: 'image/png', mediaMetadata: { kind: 'image' } }],
    )).toThrow('WORKFLOW_ASSET_KIND_MISMATCH');
  });
});

it('lists every official workflow while keeping unvalidated modes disabled', () => {
  const { listWorkflows } = require('./workflow-registry');
  const workflows = listWorkflows();
  expect(workflows).toEqual(expect.arrayContaining([
    expect.objectContaining({ key: 'seedance.first-frame-to-video.v1', status: 'disabled', media: [{ role: 'first_frame', min: 1, max: 1 }] }),
    expect.objectContaining({ key: 'seedance.first-last-frame-to-video.v1', status: 'disabled' }),
    expect.objectContaining({ key: 'seedance.omni-reference.v1', status: 'disabled' }),
    expect.objectContaining({ key: 'seedance.video-edit.v1', status: 'disabled' }),
    expect.objectContaining({ key: 'seedance.video-extend.v1', status: 'disabled' }),
    expect.objectContaining({ key: 'seedance.audio-reference-to-video.v1', status: 'disabled' }),
  ]));
});
