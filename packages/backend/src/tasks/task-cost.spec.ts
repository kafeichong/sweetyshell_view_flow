jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target,
}));

import {
  INVALID_USAGE,
  findTokenPricingRule,
  interpretUsage,
  tokenCostCny,
} from './task-cost';

const verifiedPlan = {
  pricingVersion: 'seedance-token-v1',
  model: 'doubao-seedance-2-5-260628',
};

describe('tokenCostCny', () => {
  it('uses decimal arithmetic for the budget ledger', () => {
    expect(tokenCostCny(123456, '1.25')).toBe('0.154320');
  });

  it('rounds up to six decimal places instead of truncating', () => {
    // 1 token * 1 元 / 百万 = 0.000001，但 1 token * 0.0000001 必须向上取到 1e-6
    expect(tokenCostCny(1, '0.0000001')).toBe('0.000001');
  });

  it('keeps exact values stable across repeated conversions', () => {
    expect(tokenCostCny(1_000_000, '70')).toBe('70.000000');
    expect(tokenCostCny(0, '70')).toBe('0.000000');
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['negative', -1],
    ['fraction', 1.5],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['string', '100' as unknown as number],
  ])('rejects %s usage instead of guessing', (_label, tokens) => {
    expect(() => tokenCostCny(tokens, '70')).toThrow(INVALID_USAGE);
  });
});

describe('findTokenPricingRule', () => {
  it('requires both a known pricing version and a matching model', () => {
    expect(findTokenPricingRule('seedance-token-v1', 'doubao-seedance-2-5-260628')).toBeTruthy();
    expect(findTokenPricingRule('seedance-token-v1', 'other-model')).toBeNull();
    expect(findTokenPricingRule('unknown-version', 'doubao-seedance-2-5-260628')).toBeNull();
    expect(findTokenPricingRule(undefined, 'doubao-seedance-2-5-260628')).toBeNull();
  });
});

describe('interpretUsage', () => {
  it('computes the settlement amount from frozen provider usage', () => {
    const result = interpretUsage({ total_tokens: 10000 }, verifiedPlan);

    expect(result).toEqual({
      status: 'usage_calculated',
      amountCny: '0.700000',
      pricingVersion: 'seedance-token-v1',
      usage: { total_tokens: 10000 },
    });
  });

  it('keeps the raw usage as evidence for later billing review', () => {
    const result = interpretUsage(
      { total_tokens: 10000, extra_field: 'kept' },
      verifiedPlan,
    );

    expect(result.status).toBe('usage_calculated');
    expect((result as { usage: Record<string, unknown> }).usage).toEqual({
      total_tokens: 10000,
      extra_field: 'kept',
    });
  });

  it.each([
    ['missing usage', null, verifiedPlan, 'MISSING_USAGE'],
    ['non-object usage', 'nope', verifiedPlan, 'MISSING_USAGE'],
    ['array usage', [1, 2], verifiedPlan, 'MISSING_USAGE'],
    ['missing total_tokens', { completion_tokens: 5 }, verifiedPlan, 'MISSING_TOTAL_TOKENS'],
    ['negative tokens', { total_tokens: -5 }, verifiedPlan, 'INVALID_TOTAL_TOKENS'],
    ['fractional tokens', { total_tokens: 1.5 }, verifiedPlan, 'INVALID_TOTAL_TOKENS'],
    ['NaN tokens', { total_tokens: Number.NaN }, verifiedPlan, 'INVALID_TOTAL_TOKENS'],
    ['string tokens', { total_tokens: '100' }, verifiedPlan, 'INVALID_TOTAL_TOKENS'],
    ['missing plan', { total_tokens: 100 }, null, 'MISSING_PRICING_VERSION'],
    [
      'unknown pricing version',
      { total_tokens: 100 },
      { pricingVersion: 'not-verified', model: 'doubao-seedance-2-5-260628' },
      'UNKNOWN_PRICING_VERSION',
    ],
    [
      'model mismatch',
      { total_tokens: 100 },
      { pricingVersion: 'seedance-token-v1', model: 'test-model' },
      'MODEL_PRICING_MISMATCH',
    ],
  ])('marks %s as unavailable rather than applying a wrong formula', (
    _label,
    usage,
    plan,
    reason,
  ) => {
    const result = interpretUsage(usage, plan as never);

    expect(result.status).toBe('unavailable');
    expect((result as { reason: string }).reason).toBe(reason);
  });

  it('never reports an unavailable amount as zero', () => {
    const result = interpretUsage({ total_tokens: Number.NaN }, verifiedPlan);

    expect(result).not.toHaveProperty('amountCny');
  });
});
