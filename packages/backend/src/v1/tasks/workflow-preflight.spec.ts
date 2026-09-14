import { PREFLIGHT_TTL_MS, preflightSnapshot, verifyPreflightRecord } from './workflow-preflight';
const spec = { version: 'v1', model: 'test', duration: 5, ratio: '16:9', resolution: '720p', generateAudio: false, watermark: false, pricingVersion: 'p1', reserveCny: '1' };
const body = { workflowKey: 'seedance.reference-image-to-video.v1', prompt: { positive: 'product' }, generation: { duration: 5, ratio: '16:9', resolution: '720p' }, media: [{ sha256: 'a'.repeat(64), role: 'reference_image', mimeType: 'image/png', sizeBytes: 100, metadata: { kind: 'image', width: 500, height: 500 } }] };
const now = Date.now();
const record = () => ({ actorId: 'a', status: 'preview', createdAt: new Date(now), requestSnapshot: preflightSnapshot(body, spec) });
it('accepts metadata without an asset ID and binds the production spec', () => {
  expect(preflightSnapshot(body, spec).intent.media[0]).not.toHaveProperty('assetId');
  expect(() => verifyPreflightRecord(record(), 'a', body, spec, now)).not.toThrow();
});
it.each([
 ['prompt', { ...body, prompt: { positive: 'changed' } }],
 ['hash', { ...body, media: [{ ...body.media[0], sha256: 'b'.repeat(64) }] }],
 ['size', { ...body, media: [{ ...body.media[0], sizeBytes: 101 }] }],
])('rejects changed %s', (_, changed) => expect(() => verifyPreflightRecord(record(), 'a', changed, spec, now)).toThrow('PREFLIGHT_CONTENT_CHANGED'));
it('rejects actor changes, expiry and historical preview records', () => {
  expect(() => verifyPreflightRecord(record(), 'b', body, spec, now)).toThrow('PREFLIGHT_REQUIRED');
  expect(() => verifyPreflightRecord(record(), 'a', body, spec, now + PREFLIGHT_TTL_MS)).toThrow('PREFLIGHT_EXPIRED');
  expect(() => verifyPreflightRecord({ ...record(), requestSnapshot: body }, 'a', body, spec, now)).toThrow('PREFLIGHT_CONTENT_CHANGED');
});
it('rejects changed effective spec even when version name is unchanged', () => {
  expect(() => verifyPreflightRecord(record(), 'a', body, { ...spec, generateAudio: true }, now)).toThrow('PREFLIGHT_CONTENT_CHANGED');
});
it('rejects unknown fields and invalid image metadata', () => {
  expect(() => preflightSnapshot({ ...body, imageUrl: 'https://example.test/image' }, spec)).toThrow('PREFLIGHT_FIELDS_INVALID');
  expect(() => preflightSnapshot({ ...body, media: [{ ...body.media[0], metadata: { kind: 'image', width: 1, height: 500 } }] }, spec)).toThrow('IMAGE_DIMENSIONS_INVALID');
});
