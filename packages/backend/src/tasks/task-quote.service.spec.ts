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

  it('prices first-last-frame output from the first frame when the last frame aspect differs', () => {
    const service = new TaskQuoteService(new PricingCatalog());
    const firstFrame = {
      slotId: 'first-frame', role: 'first_frame' as const, sha256: 'b'.repeat(64), mimeType: 'image/png', sizeBytes: 100,
      metadata: { kind: 'image' as const, width: 900, height: 1600 },
    };
    const lastFrame = {
      slotId: 'last-frame', role: 'last_frame' as const, sha256: 'c'.repeat(64), mimeType: 'image/png', sizeBytes: 100,
      metadata: { kind: 'image' as const, width: 1600, height: 900 },
    };

    const quote = service.quote(intent({
      workflowKey: 'seedance.first-last-frame-to-video.v1',
      generation: { ...intent().generation, ratio: 'adaptive' },
      media: [firstFrame, lastFrame],
    }), MODEL, new Date('2026-09-15T00:00:00.000Z'));

    expect(quote.status).toBe('estimated');
    expect(quote.basis).toEqual(expect.objectContaining({
      output: { durationSeconds: 5, width: 720, height: 1280, frameRate: 24 },
      adaptiveBasis: 'first_frame',
    }));
    expect(quote.reserveCny).toBe('7.560000');
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

  it('bills the official input-video minimum below the floor and the formula above it', () => {
    const service = new TaskQuoteService(new PricingCatalog());

    const twoSeconds = service.quote(intent({
      workflowKey: 'seedance.omni-reference.v1',
      media: [video('v1', 2)],
    }), MODEL, new Date('2026-09-15T00:00:00.000Z'));
    const fourSeconds = service.quote(intent({
      workflowKey: 'seedance.omni-reference.v1',
      media: [video('v1', 4)],
    }), MODEL, new Date('2026-09-15T00:00:00.000Z'));
    const thirtySeconds = service.quote(intent({
      workflowKey: 'seedance.omni-reference.v1',
      media: [video('v1', 30)],
    }), MODEL, new Date('2026-09-15T00:00:00.000Z'));
    const multiple = service.quote(intent({
      workflowKey: 'seedance.omni-reference.v1',
      media: [video('v1', 2), video('v2', 28)],
    }), MODEL, new Date('2026-09-15T00:00:00.000Z'));

    // 720p 16:9 每秒 21,600 token；输出 5 秒时最低计费总秒数为 ceil(5×5/3)=9。
    // 公式值 7×21600=151,200 低于最低值 9×21600=194,400，按最低值计费。
    expect(twoSeconds).toMatchObject({
      status: 'estimated',
      pricingVersion: 'seedance-2.5-public-catalog-2026-09-15',
      reserveCny: '8.164800',
      missing: [],
      basis: {
        inputVideoSeconds: '2.000000',
        formulaTokens: 151200,
        minimumTokens: 194400,
        billedTokens: 194400,
        minimumTokensApplied: true,
        ratePerMillion: '42.00',
      },
    });
    // 输入到 4 秒时公式值恰好追平最低值，两种口径同价。
    expect(fourSeconds).toMatchObject({ reserveCny: '8.164800' });
    expect(fourSeconds.basis).toEqual(expect.objectContaining({
      formulaTokens: 194400, billedTokens: 194400, minimumTokensApplied: false,
    }));
    // 公式值 35×21600=756,000 高于最低值，按公式值计费。
    expect(thirtySeconds).toMatchObject({ reserveCny: '31.752000', missing: [] });
    expect(thirtySeconds.basis).toEqual(expect.objectContaining({
      inputVideoSeconds: '30.000000', formulaTokens: 756000, billedTokens: 756000, minimumTokensApplied: false,
    }));
    expect(multiple).toMatchObject({ reserveCny: '31.752000' });
    expect(multiple.basis).toEqual(expect.objectContaining({ inputVideoSeconds: '30.000000', formulaTokens: 756000 }));
  });

  it('derives the input-video minimum from output duration alone, not from the resolution group', () => {
    const service = new TaskQuoteService(new PricingCatalog());

    // 480p 16:9 为 854×480，每秒 9,607.5 token。输出 4 秒 → 最低总秒数 ceil(20/3)=7
    // → 7×9607.5=67,252.5，向上取整 67,253（与方舟快查表 480p/4 秒行一致）。
    const quote = service.quote(intent({
      workflowKey: 'seedance.omni-reference.v1',
      generation: { ...intent().generation, duration: 4, resolution: '480p' },
      media: [video('v1', 2)],
    }), MODEL, new Date('2026-09-15T00:00:00.000Z'));

    expect(quote.basis).toEqual(expect.objectContaining({
      formulaTokens: 57645,
      minimumTokens: 67253,
      billedTokens: 67253,
      minimumTokensApplied: true,
    }));
  });

  it('derives video-edit automatic output duration from the only selected input video', () => {
    const service = new TaskQuoteService(new PricingCatalog());

    const quote = service.quote(intent({
      workflowKey: 'seedance.video-edit.v1',
      generation: { ...intent().generation, duration: -1, ratio: 'adaptive' },
      media: [video('edit-source', 12)],
    }), MODEL, new Date('2026-09-15T00:00:00.000Z'));

    // 输出 12 秒 → 最低计费总秒数 ceil(60/3)=20 → 20×21600=432,000；
    // 公式值 24×21600=518,400 更高，因此按公式值计费且不触发最低值。
    expect(quote).toMatchObject({ status: 'estimated', reserveCny: '21.772800', missing: [] });
    expect(quote.basis).toEqual(expect.objectContaining({
      inputVideoSeconds: '12.000000',
      outputDurationBasis: 'single_reference_video',
      formulaTokens: 518400,
      minimumTokens: 432000,
      billedTokens: 518400,
      minimumTokensApplied: false,
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
