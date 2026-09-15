jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target,
}));

import { PricingCatalog } from './pricing-catalog';
import { TaskQuoteService } from './task-quote.service';
import { WorkflowIntent } from './workflow-contract';

const MODEL = 'doubao-seedance-2-5-260628';

function intent(overrides: Partial<WorkflowIntent> = {}): WorkflowIntent {
  return {
    contractVersion: 2,
    workflowKey: 'seedance.text-to-video.v1',
    prompt: { positive: '雨后的街道' },
    generation: {
      duration: 5,
      ratio: '16:9',
      resolution: '720p',
      generateAudio: true,
      watermark: false,
      outputFormat: 'mp4',
    },
    media: [],
    ...overrides,
  };
}

function video(slotId: string, durationSeconds: number) {
  return {
    slotId,
    role: 'reference_video' as const,
    sha256: 'a'.repeat(64),
    mimeType: 'video/mp4',
    sizeBytes: 1024,
    metadata: {
      kind: 'video' as const,
      width: 1280,
      height: 720,
      durationSeconds,
      frameRate: 24,
      videoCodec: 'h264',
    },
  };
}

describe('TaskQuoteService', () => {
  it('quotes the literal 5s 720p 16:9 formula with the public no-video rate', () => {
    const service = new TaskQuoteService(new PricingCatalog());

    const quote = service.quote(intent(), MODEL, new Date('2026-09-15T00:00:00.000Z'));

    expect(quote).toMatchObject({
      status: 'estimated',
      estimatedCny: '7.560000',
      reserveCny: '7.560000',
      pricingVersion: 'seedance-2.5-public-catalog-2026-09-15',
      basis: {
        output: { durationSeconds: 5, width: 1280, height: 720, frameRate: 24 },
        inputVideoSeconds: '0.000000',
        formulaTokens: 108000,
        billedTokens: 108000,
        ratePerMillion: '70.00',
        rateSource: 'public_catalog',
        minimumTokensApplied: false,
      },
      missing: [],
    });
    expect(quote.quoteDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('uses the official dimensions for every fixed ratio instead of recomputing rounded pixels', () => {
    const service = new TaskQuoteService(new PricingCatalog());

    const quote = service.quote(intent({ generation: { ...intent().generation, duration: 5, ratio: '4:3', resolution: '480p' } }), MODEL, new Date('2026-09-15T00:00:00.000Z'));

    expect(quote.basis).toEqual(expect.objectContaining({
      output: { durationSeconds: 5, width: 752, height: 560, frameRate: 24 },
      formulaTokens: 49350,
    }));
    expect(quote.reserveCny).toBe('3.454500');
  });

  it('derives adaptive first-frame output from the checked first-frame ratio', () => {
    const service = new TaskQuoteService(new PricingCatalog());
    const firstFrame = {
      slotId: 'first-frame', role: 'first_frame' as const, sha256: 'b'.repeat(64), mimeType: 'image/png', sizeBytes: 100,
      metadata: { kind: 'image' as const, width: 900, height: 1600 },
    };

    const quote = service.quote(intent({
      workflowKey: 'seedance.first-frame-to-video.v1',
      generation: { ...intent().generation, ratio: 'adaptive' },
      media: [firstFrame],
    }), MODEL, new Date('2026-09-15T00:00:00.000Z'));

    expect(quote.status).toBe('estimated');
    expect(quote.basis).toEqual(expect.objectContaining({
      output: { durationSeconds: 5, width: 720, height: 1280, frameRate: 24 },
      adaptiveBasis: 'first_frame',
    }));
  });

  it('uses a documented resolution pixel upper bound when adaptive output cannot be locked', () => {
    const service = new TaskQuoteService(new PricingCatalog());

    const quote = service.quote(intent({ generation: { ...intent().generation, ratio: 'adaptive' } }), MODEL, new Date('2026-09-15T00:00:00.000Z'));

    expect(quote.status).toBe('bounded');
    expect(quote.estimatedCny).toBeNull();
    expect(quote.reserveCny).toBe('7.607670');
    expect(quote.basis).toEqual(expect.objectContaining({
      outputPixelUpperBound: 927408,
      billedTokens: 108681,
    }));
  });

  it('uses actual 2s, 30s and multi-video totals but refuses to under-reserve without the minimum-token table', () => {
    const service = new TaskQuoteService(new PricingCatalog());

    const twoSeconds = service.quote(intent({
      workflowKey: 'seedance.omni-reference.v1',
      media: [video('v1', 2)],
    }), MODEL, new Date('2026-09-15T00:00:00.000Z'));
    const thirtySeconds = service.quote(intent({
      workflowKey: 'seedance.omni-reference.v1',
      media: [video('v1', 30)],
    }), MODEL, new Date('2026-09-15T00:00:00.000Z'));
    const multiple = service.quote(intent({
      workflowKey: 'seedance.omni-reference.v1',
      media: [video('v1', 2), video('v2', 28)],
    }), MODEL, new Date('2026-09-15T00:00:00.000Z'));

    expect(twoSeconds).toMatchObject({
      status: 'unavailable',
      estimatedCny: null,
      reserveCny: null,
      pricingVersion: null,
      basis: {
        inputVideoSeconds: '2.000000',
        formulaTokens: 151200,
        ratePerMillion: '42.00',
        minimumTokensApplied: null,
      },
      missing: ['INPUT_VIDEO_MINIMUM_TOKENS_UNRESOLVED'],
    });
    expect(thirtySeconds.basis).toEqual(expect.objectContaining({ inputVideoSeconds: '30.000000', formulaTokens: 756000 }));
    expect(multiple.basis).toEqual(expect.objectContaining({ inputVideoSeconds: '30.000000', formulaTokens: 756000 }));
  });

  it('derives video-edit automatic output duration from the only selected input video', () => {
    const service = new TaskQuoteService(new PricingCatalog());

    const quote = service.quote(intent({
      workflowKey: 'seedance.video-edit.v1',
      generation: { ...intent().generation, duration: -1, ratio: 'adaptive' },
      media: [video('edit-source', 12)],
    }), MODEL, new Date('2026-09-15T00:00:00.000Z'));

    expect(quote.missing).toEqual(['INPUT_VIDEO_MINIMUM_TOKENS_UNRESOLVED']);
    expect(quote.basis).toEqual(expect.objectContaining({
      inputVideoSeconds: '12.000000',
      outputDurationBasis: 'single_reference_video',
      output: expect.objectContaining({ durationSeconds: 12 }),
    }));
  });

  it('applies the 1080p promotion only when account applicability is explicitly confirmed and caps expiry', () => {
    const service = new TaskQuoteService(new PricingCatalog({
      confirmedPromotionIds: ['seedance-2.5-1080p-2026-08-14-2026-09-17'],
    }));

    const active = service.quote(intent({ generation: { ...intent().generation, resolution: '1080p' } }), MODEL, new Date('2026-09-17T05:45:00.000Z'));
    const ended = service.quote(intent({ generation: { ...intent().generation, resolution: '1080p' } }), MODEL, new Date('2026-09-17T06:01:00.000Z'));

    expect(active.basis).toEqual(expect.objectContaining({ ratePerMillion: '55.44', promotionId: 'seedance-2.5-1080p-2026-08-14-2026-09-17' }));
    expect(active.expiresAt).toBe('2026-09-17T06:00:00.000Z');
    expect(ended.basis).toEqual(expect.objectContaining({ ratePerMillion: '77.00', promotionId: null }));
  });

  it('uses a confirmed account rate snapshot instead of silently applying the public catalog', () => {
    const service = new TaskQuoteService(new PricingCatalog({
      accountPricing: {
        pricingVersion: 'ark-order-2026-09-15',
        source: 'volcengine_order',
        validFrom: '2026-09-15T00:00:00.000Z',
        validUntil: '2026-10-01T00:00:00.000Z',
        rates: {
          withoutVideo: { '480p': '60.00', '720p': '60.00', '1080p': '65.00' },
          withVideo: { '480p': '36.00', '720p': '36.00', '1080p': '40.00' },
        },
      },
    }));

    const quote = service.quote(intent(), MODEL, new Date('2026-09-15T00:00:00.000Z'));

    expect(quote.pricingVersion).toBe('ark-order-2026-09-15');
    expect(quote.reserveCny).toBe('6.480000');
    expect(quote.basis).toEqual(expect.objectContaining({ ratePerMillion: '60.00', rateSource: 'volcengine_order' }));
  });

  it('fails closed when declared account pricing omits a required resolution', () => {
    const catalog = new PricingCatalog({
      accountPricing: {
        pricingVersion: 'incomplete-order',
        source: 'volcengine_order',
        validFrom: '2026-09-15T00:00:00.000Z',
        validUntil: '2026-10-01T00:00:00.000Z',
        rates: {
          withoutVideo: { '480p': '60.00', '720p': '60.00' },
          withVideo: { '480p': '36.00', '720p': '36.00' },
        },
      },
    });

    expect(() => catalog.select(MODEL, '1080p', false, new Date('2026-09-15T00:00:00.000Z')))
      .toThrow('ACCOUNT_PRICING_CONFIG_INVALID');
  });

  it('never substitutes zero or a fixed fallback for an unknown model or automatic duration', () => {
    const service = new TaskQuoteService(new PricingCatalog());

    const unknownModel = service.quote(intent(), 'unknown-model', new Date('2026-09-15T00:00:00.000Z'));
    const automatic = service.quote(intent({ generation: { ...intent().generation, duration: -1 } }), MODEL, new Date('2026-09-15T00:00:00.000Z'));

    expect(unknownModel).toMatchObject({ status: 'unavailable', estimatedCny: null, reserveCny: null, missing: ['PRICING_MODEL_UNSUPPORTED'] });
    expect(automatic).toMatchObject({ status: 'unavailable', estimatedCny: null, reserveCny: null, missing: ['OUTPUT_DURATION_UNRESOLVED'] });
  });
});
