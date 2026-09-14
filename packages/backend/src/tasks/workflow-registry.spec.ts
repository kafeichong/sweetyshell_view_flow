import { normalizeWorkflowTaskRequest } from './workflow-registry';

const spec = {
  version: 'seedance-approved-v1',
  model: 'test-model',
  duration: 5,
  ratio: '16:9',
  resolution: '720p',
  generateAudio: false,
  watermark: true,
  pricingVersion: 'test-price-v1',
  reserveCny: '2.000000',
};

describe('workflow registry request normalization', () => {
  it('maps the legacy Seedance image request and new reference-image workflow to the same execution intent', () => {
    const legacy = normalizeWorkflowTaskRequest({
      capability: 'IMAGE_TO_VIDEO',
      profile: 'seedance',
      params: { prompt: 'product orbit', image_asset_id: 'asset-1', duration: 5, ratio: '16:9' },
    }, spec);
    const current = normalizeWorkflowTaskRequest({
      workflowKey: 'seedance.reference-image-to-video.v1',
      prompt: { positive: 'product orbit' },
      generation: { duration: 5, ratio: '16:9', resolution: '720p' },
      media: [{ assetId: 'asset-1', role: 'reference_image' }],
    }, spec);

    expect(legacy).toMatchObject({
      workflowKey: 'seedance.reference-image-to-video.v1',
      workflowVersion: 'v1',
      capability: 'IMAGE_TO_VIDEO',
      profile: 'seedance',
      prompt: 'product orbit',
      media: [{ assetId: 'asset-1', role: 'reference_image' }],
    });
    const { legacy: _legacy, ...legacyIntent } = legacy;
    const { legacy: _current, ...currentIntent } = current;
    expect(currentIntent).toEqual(legacyIntent);
  });

  it('keeps text-to-video preview-only and rejects input media for it', () => {
    const text = normalizeWorkflowTaskRequest({
      workflowKey: 'seedance.text-to-video.v1',
      prompt: { positive: 'a glass bottle rotates' },
      generation: { duration: 5, ratio: '16:9', resolution: '720p' },
      media: [],
    }, spec);

    expect(text.status).toBe('preview_only');
    expect(() => normalizeWorkflowTaskRequest({
      workflowKey: 'seedance.text-to-video.v1',
      prompt: { positive: 'x' },
      generation: { duration: 5, ratio: '16:9', resolution: '720p' },
      media: [{ assetId: 'asset-1', role: 'reference_image' }],
    }, spec)).toThrow('WORKFLOW_MEDIA_NOT_ALLOWED');
  });
});
