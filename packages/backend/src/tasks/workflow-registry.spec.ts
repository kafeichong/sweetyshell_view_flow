import { normalizeWorkflowTaskRequest } from './workflow-registry';

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
