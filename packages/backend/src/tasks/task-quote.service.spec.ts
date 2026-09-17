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
      estimatedCny: '7.623000',
      reserveCny: '7.623000',
      pricingVersion: 'seedance-2.5-public-catalog-2026-09-17',
      basis: {
        output: { durationSeconds: 5, width: 1280, height: 720, frameRate: 24 },
        inputVideoSeconds: '0.000000',
        formulaTokens: 108900,
        billedTokens: 108900,
        ratePerMillion: '70.00',
        rateSource: 'public_catalog',
        minimumTokensApplied: false,
      },
      missing: [],
    });
    expect(quote.quoteDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('matches the four real paid settlements, which all bill one frame beyond duration x frameRate', () => {
    const service = new TaskQuoteService(new PricingCatalog());
    const now = new Date('2026-09-15T00:00:00.000Z');

    // 四个真实付费任务的 usage.completion_tokens（见 docs/PROJECT_STATUS.md）：
    //   3614cb63 4s/720p 16:9 → 87,300     d4d41580、994e3fb6 5s/720p 16:9 → 108,900
    //   3bb48246 6s/480p 9:16 (480x854)   → 58,045
    // 前三个与「时长 × 帧率 + 1」帧完全相等；第四个的每帧 token 不是整数
    // (480×854/1024 = 400.3125)，Provider 截断到 58,045，这里向上取整到 58,046，
    // 多留 1 token 是刻意保守，与"不得低估预占"一致。
    const fourSeconds = service.quote(intent({ generation: { ...intent().generation, duration: 4 } }), MODEL, now);
    const fiveSeconds = service.quote(intent(), MODEL, now);
    const sixSecondsWide = service.quote(intent({
      generation: { ...intent().generation, duration: 6, ratio: '9:16', resolution: '480p' },
    }), MODEL, now);

    expect(fourSeconds.basis).toEqual(expect.objectContaining({ billedTokens: 87300 }));
    expect(fourSeconds.reserveCny).toBe('6.111000');
    expect(fiveSeconds.basis).toEqual(expect.objectContaining({ billedTokens: 108900 }));
    expect(fiveSeconds.reserveCny).toBe('7.623000');
    expect(sixSecondsWide.basis).toEqual(expect.objectContaining({
      output: { durationSeconds: 6, width: 480, height: 854, frameRate: 24 },
      billedTokens: 58046,
    }));
    expect(sixSecondsWide.reserveCny).toBe('4.063220');
  });

  it('uses the official dimensions for every fixed ratio instead of recomputing rounded pixels', () => {
    const service = new TaskQuoteService(new PricingCatalog());

    const quote = service.quote(intent({ generation: { ...intent().generation, duration: 5, ratio: '4:3', resolution: '480p' } }), MODEL, new Date('2026-09-15T00:00:00.000Z'));

    expect(quote.basis).toEqual(expect.objectContaining({
      output: { durationSeconds: 5, width: 752, height: 560, frameRate: 24 },
      formulaTokens: 49762,
    }));
    expect(quote.reserveCny).toBe('3.483340');
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
    expect(quote.reserveCny).toBe('7.623000');
  });

  it('uses a documented resolution pixel upper bound when adaptive output cannot be locked', () => {
    const service = new TaskQuoteService(new PricingCatalog());

    const quote = service.quote(intent({ generation: { ...intent().generation, ratio: 'adaptive' } }), MODEL, new Date('2026-09-15T00:00:00.000Z'));

    expect(quote.status).toBe('bounded');
    expect(quote.estimatedCny).toBeNull();
    expect(quote.reserveCny).toBe('7.747810');
    expect(quote.basis).toEqual(expect.objectContaining({
      // 表内最大像素照旧报出来，真正用于预留的是加过余量的 936,683。
      outputPixelUpperBound: 927408,
      outputReservedPixels: 936683,
      billedTokens: 110683,
    }));
  });

  it('keeps the adaptive pixel bound above what the provider actually bills', () => {
    const service = new TaskQuoteService(new PricingCatalog());

    // 两条真实付费任务（5s/720p/adaptive，首帧 611x917、尾帧 717x1051，taskId
    // 141babe3…/1614cd62…）：出片 786x1180 = 927,480 px，**比表内最大 927,408 多 72 px**，
    // 结算 floor(121 x 927480/1024) = 109,594 tokens。表内最大像素因此不是严格上界，
    // 预留要加余量才盖得住——这条用例把余量钉住，防止它被后来的人当冗余删掉。
    const bounded = service.quote(
      intent({ generation: { ...intent().generation, ratio: 'adaptive' } }), MODEL, new Date('2026-09-15T00:00:00.000Z'),
    );

    expect(bounded.status).toBe('bounded');
    expect(bounded.basis).toEqual(expect.objectContaining({
      outputPixelUpperBound: 927408,
      outputReservedPixels: 936683,
      billedTokens: 110683,
    }));
    // 110,683 > 109,594：预留盖得住实测结算。
    expect(bounded.reserveCny).toBe('7.747810');
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
    // 公式值 169 帧 = 152,100 低于最低值 9×21600=194,400，按最低值计费。
    expect(twoSeconds).toMatchObject({
      status: 'estimated',
      pricingVersion: 'seedance-2.5-public-catalog-2026-09-17',
      reserveCny: '8.164800',
      missing: [],
      basis: {
        inputVideoSeconds: '2.000000',
        formulaTokens: 152100,
        minimumTokens: 194400,
        billedTokens: 194400,
        minimumTokensApplied: true,
        ratePerMillion: '42.00',
      },
    });
    // 输入到 4 秒时公式值 217 帧 = 195,300 已经超过最低值，改按公式值计费。
    expect(fourSeconds).toMatchObject({ reserveCny: '8.202600' });
    expect(fourSeconds.basis).toEqual(expect.objectContaining({
      formulaTokens: 195300, billedTokens: 195300, minimumTokensApplied: false,
    }));
    // 公式值 841 帧 = 756,900 高于最低值，按公式值计费。
    expect(thirtySeconds).toMatchObject({ reserveCny: '31.789800', missing: [] });
    expect(thirtySeconds.basis).toEqual(expect.objectContaining({
      inputVideoSeconds: '30.000000', formulaTokens: 756900, billedTokens: 756900, minimumTokensApplied: false,
    }));
    expect(multiple).toMatchObject({ reserveCny: '31.789800' });
    expect(multiple.basis).toEqual(expect.objectContaining({ inputVideoSeconds: '30.000000', formulaTokens: 756900 }));
  });

  it('derives the input-video minimum from output duration alone, not from the resolution group', () => {
    const service = new TaskQuoteService(new PricingCatalog());

    // 480p 16:9 为 854×480，每秒 9,607.5 token。输出 4 秒 → 最低总秒数 ceil(20/3)=7
    // → 7×9607.5=67,252.5，向上取整 67,253（与方舟快查表 480p/4 秒行一致）。
    // 公式值 145 帧 × 400.3125 = 58,045.3125 → 58,046，仍低于最低值。
    const quote = service.quote(intent({
      workflowKey: 'seedance.omni-reference.v1',
      generation: { ...intent().generation, duration: 4, resolution: '480p' },
      media: [video('v1', 2)],
    }), MODEL, new Date('2026-09-15T00:00:00.000Z'));

    expect(quote.basis).toEqual(expect.objectContaining({
      formulaTokens: 58046,
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
    // 公式值 577 帧 × 900 = 519,300 更高，因此按公式值计费且不触发最低值。
    expect(quote).toMatchObject({ status: 'estimated', reserveCny: '21.810600', missing: [] });
    expect(quote.basis).toEqual(expect.objectContaining({
      inputVideoSeconds: '12.000000',
      outputDurationBasis: 'single_reference_video',
      formulaTokens: 519300,
      minimumTokens: 432000,
      billedTokens: 519300,
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
    expect(quote.reserveCny).toBe('6.534000');
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
