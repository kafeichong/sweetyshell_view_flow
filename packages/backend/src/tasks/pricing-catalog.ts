import { Prisma } from '@prisma/client';
import { workflowDigest } from './workflow-catalog.service';

const contract = require('./resources/seedance-workflows.v2.json') as any;

export type AccountPricing = {
  pricingVersion: string;
  source: string;
  validFrom: string;
  validUntil: string;
  rates: {
    withoutVideo: Record<string, string>;
    withVideo: Record<string, string>;
  };
};

export type PricingCatalogOptions = {
  confirmedPromotionIds?: string[];
  accountPricing?: AccountPricing;
};

export type PricingSelection = {
  pricingVersion: string;
  model: string;
  ratePerMillion: string;
  rateSource: string;
  validFrom: string | null;
  validUntil: string | null;
  promotionId: string | null;
  pricingDigest: string;
};

export function isValidPricingSelection(value: unknown): value is PricingSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const { pricingDigest, ...unsigned } = candidate;
  return typeof pricingDigest === 'string'
    && pricingDigest === workflowDigest(unsigned)
    && typeof candidate.pricingVersion === 'string'
    && typeof candidate.model === 'string'
    && validRate(candidate.ratePerMillion)
    && typeof candidate.rateSource === 'string'
    && (candidate.validFrom === null || (typeof candidate.validFrom === 'string' && validDate(candidate.validFrom)))
    && (candidate.validUntil === null || (typeof candidate.validUntil === 'string' && validDate(candidate.validUntil)))
    && (candidate.promotionId === null || typeof candidate.promotionId === 'string');
}

function parseOptions(): PricingCatalogOptions {
  const accountRaw = process.env.VIDEO_FLOW_SEEDANCE_25_ACCOUNT_PRICING_JSON;
  const promotionsRaw = process.env.VIDEO_FLOW_SEEDANCE_25_CONFIRMED_PROMOTION_IDS;
  let accountPricing: AccountPricing | undefined;
  if (accountRaw) {
    try {
      accountPricing = JSON.parse(accountRaw) as AccountPricing;
    } catch {
      throw new Error('ACCOUNT_PRICING_CONFIG_INVALID');
    }
  }
  return {
    accountPricing,
    confirmedPromotionIds: promotionsRaw?.split(',').map((item) => item.trim()).filter(Boolean) ?? [],
  };
}

function validDate(value: string): boolean {
  return Number.isFinite(new Date(value).getTime());
}

function validRate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new Prisma.Decimal(value).gt(0);
  } catch {
    return false;
  }
}

export class PricingCatalog {
  private readonly options: PricingCatalogOptions;

  constructor(options?: PricingCatalogOptions) {
    this.options = options ?? parseOptions();
  }

  select(model: string, resolution: string, hasInputVideo: boolean, now: Date): PricingSelection | null {
    if (model !== contract.model.id || !contract.model.resolutions.includes(resolution)) return null;

    const account = this.options.accountPricing;
    if (account && this.validAccountPricing(account, resolution, now)) {
      const rate = (hasInputVideo ? account.rates.withVideo : account.rates.withoutVideo)[resolution];
      return this.selection({
        pricingVersion: account.pricingVersion,
        model,
        ratePerMillion: rate,
        rateSource: account.source,
        validFrom: new Date(account.validFrom).toISOString(),
        validUntil: new Date(account.validUntil).toISOString(),
        promotionId: null,
      });
    }

    const group = resolution === '1080p' ? '1080p' : '480p_or_720p';
    const catalogRate = contract.pricing.catalogRates.find((item: any) =>
      item.resolutionGroup === group && item.hasInputVideo === hasInputVideo,
    );
    if (!catalogRate || !validRate(catalogRate.cnyPerMillionTokens)) return null;

    let rate = new Prisma.Decimal(catalogRate.cnyPerMillionTokens);
    let promotionId: string | null = null;
    let validFrom: string | null = null;
    let validUntil: string | null = null;
    const promotion = contract.pricing.promotions.find((item: any) =>
      item.resolution === resolution
      && this.options.confirmedPromotionIds?.includes(item.id)
      && new Date(item.startsAt).getTime() <= now.getTime()
      && now.getTime() < new Date(item.endsAt).getTime(),
    );
    if (promotion) {
      rate = rate.mul(promotion.multiplier);
      promotionId = promotion.id;
      validFrom = new Date(promotion.startsAt).toISOString();
      validUntil = new Date(promotion.endsAt).toISOString();
    }
    return this.selection({
      pricingVersion: `seedance-2.5-public-catalog-${contract.contractRevision.slice(0, 10)}`,
      model,
      ratePerMillion: rate.toFixed(2),
      rateSource: 'public_catalog',
      validFrom,
      validUntil,
      promotionId,
    });
  }

  private validAccountPricing(account: AccountPricing, resolution: string, now: Date): boolean {
    if (
      !account.pricingVersion
      || !account.source
      || !validDate(account.validFrom)
      || !validDate(account.validUntil)
      || !account.rates?.withoutVideo
      || !account.rates?.withVideo
    ) {
      throw new Error('ACCOUNT_PRICING_CONFIG_INVALID');
    }
    const start = new Date(account.validFrom).getTime();
    const end = new Date(account.validUntil).getTime();
    const requiredRates = contract.model.resolutions.flatMap((item: string) => [
      account.rates.withoutVideo[item],
      account.rates.withVideo[item],
    ]);
    if (end <= start || !requiredRates.every(validRate)) throw new Error('ACCOUNT_PRICING_CONFIG_INVALID');
    return start <= now.getTime() && now.getTime() < end
      && validRate(account.rates.withoutVideo[resolution])
      && validRate(account.rates.withVideo[resolution]);
  }

  private selection(value: Omit<PricingSelection, 'pricingDigest'>): PricingSelection {
    return { ...value, pricingDigest: workflowDigest(value) };
  }
}
