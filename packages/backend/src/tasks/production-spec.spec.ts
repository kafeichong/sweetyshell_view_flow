import {
  loadProductionSpec,
  normalizeProductionParams,
  ProductionSpec,
} from './production-spec';

const spec: ProductionSpec = {
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

describe('production spec', () => {
  test('normalizes an approved request into a frozen execution plan', () => {
    expect(
      normalizeProductionParams(
        {
          prompt: 'product on water',
          image_asset_id: 'asset-1',
          duration: 5,
          ratio: '16:9',
        },
        spec,
      ),
    ).toEqual({
      specVersion: 'test-v1',
      pricingVersion: 'test-price-v1',
      reserveCny: '2.000000',
      model: 'test-model',
      prompt: 'product on water',
      imageAssetId: 'asset-1',
      duration: 5,
      ratio: '16:9',
      resolution: 'test-resolution',
      generateAudio: false,
      watermark: true,
    });
  });

  test('rejects a duration outside the approved spec', () => {
    expect(() =>
      normalizeProductionParams(
        {
          prompt: 'product',
          image_asset_id: 'asset-1',
          duration: 60,
          ratio: '16:9',
        },
        spec,
      ),
    ).toThrow('PRODUCTION_SPEC_MISMATCH');
  });

  test('rejects a direct image URL and unknown generation fields', () => {
    expect(() =>
      normalizeProductionParams(
        {
          prompt: 'product',
          image_asset_id: 'asset-1',
          image_url: 'https://example.test/input.png',
          duration: 5,
          ratio: '16:9',
          seed: 7,
        },
        spec,
      ),
    ).toThrow('PRODUCTION_PARAM_NOT_ALLOWED');
  });

  test('returns null when production configuration is absent or incomplete', () => {
    expect(loadProductionSpec(undefined)).toBeNull();
    expect(loadProductionSpec('{"version":"test-v1"}')).toBeNull();
  });
});
