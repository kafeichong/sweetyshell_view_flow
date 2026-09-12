import { Prisma } from '@prisma/client';

/**
 * 已核实的按 tokens 计费规则。
 *
 * 只有在这里登记过的 pricingVersion（且模型匹配）才允许换算金额；其余一律
 * 标为 unavailable 交人工核查。宁可让费用未知，也不能套一个错公式把预占
 * 结算成看似可信的数字。
 */
export type TokenPricingRule = {
  pricingVersion: string;
  ratePerMillion: string; // 元 / 百万 tokens
  models: string[];
};

const TOKEN_PRICING_RULES: TokenPricingRule[] = [
  {
    pricingVersion: 'seedance-token-v1',
    ratePerMillion: '70',
    models: ['doubao-seedance-2-5-260628'],
  },
];

export const INVALID_USAGE = 'INVALID_USAGE';

export function findTokenPricingRule(
  pricingVersion: unknown,
  model: unknown,
): TokenPricingRule | null {
  if (typeof pricingVersion !== 'string' || !pricingVersion.trim()) {
    return null;
  }

  return (
    TOKEN_PRICING_RULES.find(
      (rule) =>
        rule.pricingVersion === pricingVersion &&
        typeof model === 'string' &&
        rule.models.includes(model),
    ) ?? null
  );
}

/**
 * 按 tokens 与单价换算金额，定点小数向上取整到 6 位。
 *
 * 用 Decimal 而不是二进制浮点：预算台账的每一次累加都必须可复现。
 * 非安全整数（NaN、小数、负数、字符串）直接拒绝，不猜测调用方意图。
 */
export function tokenCostCny(tokens: number, ratePerMillion: string): string {
  if (!Number.isSafeInteger(tokens) || tokens < 0) {
    throw new Error(INVALID_USAGE);
  }

  return new Prisma.Decimal(tokens)
    .mul(ratePerMillion)
    .div(1_000_000)
    .toDecimalPlaces(6, Prisma.Decimal.ROUND_UP)
    .toFixed(6);
}

export type UsageInterpretation =
  | {
      status: 'usage_calculated';
      amountCny: string;
      pricingVersion: string;
      usage: Record<string, unknown>;
    }
  | {
      status: 'unavailable';
      reason: string;
      usage: Record<string, unknown> | null;
    };

/**
 * 用固化在执行快照里的 pricingVersion 解释 Provider 返回的 usage。
 *
 * 只认 total_tokens 一个字段（与已核实规则一致）；缺字段、类型不对、
 * 负数、NaN、非整数、价格版本未知或模型不匹配都返回 unavailable，
 * 由调用方保留预占并转入人工核查。
 */
export function interpretUsage(
  usage: unknown,
  plan: { pricingVersion?: unknown; model?: unknown } | null | undefined,
): UsageInterpretation {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    return { status: 'unavailable', reason: 'MISSING_USAGE', usage: null };
  }

  const providerUsage = usage as Record<string, unknown>;

  if (!('total_tokens' in providerUsage)) {
    return {
      status: 'unavailable',
      reason: 'MISSING_TOTAL_TOKENS',
      usage: providerUsage,
    };
  }

  const totalTokens = providerUsage.total_tokens;
  if (
    typeof totalTokens !== 'number' ||
    !Number.isSafeInteger(totalTokens) ||
    totalTokens < 0
  ) {
    return {
      status: 'unavailable',
      reason: 'INVALID_TOTAL_TOKENS',
      usage: providerUsage,
    };
  }

  const pricingVersion = plan?.pricingVersion;
  if (typeof pricingVersion !== 'string' || !pricingVersion.trim()) {
    return {
      status: 'unavailable',
      reason: 'MISSING_PRICING_VERSION',
      usage: providerUsage,
    };
  }

  const rule = TOKEN_PRICING_RULES.find(
    (candidate) => candidate.pricingVersion === pricingVersion,
  );
  if (!rule) {
    return {
      status: 'unavailable',
      reason: 'UNKNOWN_PRICING_VERSION',
      usage: providerUsage,
    };
  }

  if (typeof plan?.model !== 'string' || !rule.models.includes(plan.model)) {
    return {
      status: 'unavailable',
      reason: 'MODEL_PRICING_MISMATCH',
      usage: providerUsage,
    };
  }

  return {
    status: 'usage_calculated',
    amountCny: tokenCostCny(totalTokens, rule.ratePerMillion),
    pricingVersion: rule.pricingVersion,
    usage: providerUsage,
  };
}
