import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PricingCatalog, PricingSelection } from './pricing-catalog';
import { tokenCostCny } from './task-cost';
import { Quote, WorkflowIntent } from './workflow-contract';
import { workflowDigest } from './workflow-catalog.service';

const contract = require('./resources/seedance-workflows.v2.json') as any;
const QUOTE_TTL_MS = 30 * 60 * 1000;

type OutputBasis = {
  durationSeconds: number;
  width: number;
  height: number;
  frameRate: number;
};

function totalVideoSeconds(intent: WorkflowIntent): Prisma.Decimal {
  return intent.media
    .filter((item) => item.role === 'reference_video')
    .reduce((total, item) => total.add(item.metadata.durationSeconds ?? 0), new Prisma.Decimal(0));
}

function fixedDimensions(resolution: string, ratio: string): [number, number] | null {
  const value = contract.model.dimensions?.[resolution]?.[ratio];
  return Array.isArray(value) && value.length === 2 ? [value[0], value[1]] : null;
}

function adaptiveDimensions(intent: WorkflowIntent): { dimensions: [number, number] | null; basis: string | null } {
  const locked = intent.media.find((item) => item.role === 'first_frame')
    ?? (intent.workflowKey === 'seedance.video-edit.v1' || intent.workflowKey === 'seedance.video-extend.v1'
      ? intent.media.find((item) => item.role === 'reference_video')
      : undefined);
  const width = locked?.metadata.width;
  const height = locked?.metadata.height;
  if (!width || !height) return { dimensions: null, basis: null };
  const ratios = contract.model.dimensions?.[intent.generation.resolution] ?? {};
  const match = Object.entries(ratios).find(([ratio]) => {
    const [left, right] = ratio.split(':').map(Number);
    return Math.abs(width / height - left / right) <= 0.005;
  });
  return match
    ? { dimensions: match[1] as [number, number], basis: locked?.role ?? null }
    : { dimensions: null, basis: null };
}

function formulaTokens(seconds: Prisma.Decimal, width: number, height: number, frameRate: number): number {
  const value = seconds.mul(width).mul(height).mul(frameRate).div(1024)
    .toDecimalPlaces(0, Prisma.Decimal.ROUND_CEIL)
    .toNumber();
  if (!Number.isSafeInteger(value)) throw new Error('QUOTE_TOKEN_OVERFLOW');
  return value;
}

@Injectable()
export class TaskQuoteService {
  constructor(private readonly catalog: PricingCatalog) {}

  quote(intent: WorkflowIntent, model: string, now: Date): Quote {
    const hasInputVideo = intent.media.some((item) => item.role === 'reference_video');
    const pricing = this.catalog.select(model, intent.generation.resolution, hasInputVideo, now);
    if (!pricing) return this.unavailable(now, ['PRICING_MODEL_UNSUPPORTED'], {});
    let outputDuration = intent.generation.duration;
    let outputDurationBasis: string | null = null;
    if (outputDuration === -1 && intent.workflowKey === 'seedance.video-edit.v1') {
      const durations = intent.media
        .filter((item) => item.role === 'reference_video')
        .map((item) => item.metadata.durationSeconds)
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
      if (durations.length === 1) {
        outputDuration = durations[0];
        outputDurationBasis = 'single_reference_video';
      }
    }
    if (!Number.isFinite(outputDuration) || outputDuration <= 0) {
      return this.unavailable(now, ['OUTPUT_DURATION_UNRESOLVED'], this.pricingBasis(pricing));
    }

    const inputSeconds = totalVideoSeconds(intent);
    const outputSeconds = new Prisma.Decimal(outputDuration);
    let dimensions = fixedDimensions(intent.generation.resolution, intent.generation.ratio);
    let adaptiveBasis: string | null = null;
    let bounded = false;
    let outputPixelUpperBound: number | undefined;
    if (!dimensions && intent.generation.ratio === 'adaptive') {
      const adaptive = adaptiveDimensions(intent);
      dimensions = adaptive.dimensions;
      adaptiveBasis = adaptive.basis;
      if (!dimensions) {
        const candidates = Object.values(contract.model.dimensions?.[intent.generation.resolution] ?? {}) as [number, number][];
        outputPixelUpperBound = Math.max(...candidates.map(([width, height]) => width * height));
        const representative = candidates.find(([width, height]) => width * height === outputPixelUpperBound);
        dimensions = representative ?? null;
        bounded = true;
      }
    }
    if (!dimensions) return this.unavailable(now, ['OUTPUT_DIMENSIONS_UNRESOLVED'], this.pricingBasis(pricing));

    const [width, height] = dimensions;
    const frameRate = contract.model.outputFrameRate;
    const tokens = formulaTokens(inputSeconds.add(outputSeconds), width, height, frameRate);
    const output: OutputBasis = { durationSeconds: outputDuration, width, height, frameRate };
    const basis: Record<string, unknown> = {
      output,
      inputVideoSeconds: inputSeconds.toFixed(6),
      formulaTokens: tokens,
      billedTokens: tokens,
      ratePerMillion: pricing.ratePerMillion,
      rateSource: pricing.rateSource,
      promotionId: pricing.promotionId,
      minimumTokensApplied: hasInputVideo ? null : false,
      pricingSnapshot: pricing,
      ...(adaptiveBasis ? { adaptiveBasis } : {}),
      ...(outputDurationBasis ? { outputDurationBasis } : {}),
      ...(outputPixelUpperBound ? { outputPixelUpperBound } : {}),
      generation: {
        generateAudio: intent.generation.generateAudio,
        watermark: intent.generation.watermark,
        outputFormat: intent.generation.outputFormat,
      },
    };
    if (hasInputVideo) {
      return this.unavailable(now, ['INPUT_VIDEO_MINIMUM_TOKENS_UNRESOLVED'], basis);
    }

    const amount = tokenCostCny(tokens, pricing.ratePerMillion);
    const value = {
      status: bounded ? 'bounded' as const : 'estimated' as const,
      currency: 'CNY' as const,
      estimatedCny: bounded ? null : amount,
      reserveCny: amount,
      pricingVersion: pricing.pricingVersion,
      expiresAt: this.expiresAt(now, pricing.validUntil),
      basis,
      missing: [] as string[],
    };
    return { ...value, quoteDigest: workflowDigest(value) };
  }

  private unavailable(now: Date, missing: string[], basis: Record<string, unknown>): Quote {
    const value = {
      status: 'unavailable' as const,
      currency: 'CNY' as const,
      estimatedCny: null,
      reserveCny: null,
      pricingVersion: null,
      expiresAt: new Date(now.getTime() + QUOTE_TTL_MS).toISOString(),
      basis,
      missing,
    };
    return { ...value, quoteDigest: workflowDigest(value) };
  }

  private pricingBasis(pricing: PricingSelection): Record<string, unknown> {
    return {
      ratePerMillion: pricing.ratePerMillion,
      rateSource: pricing.rateSource,
      promotionId: pricing.promotionId,
      pricingSnapshot: pricing,
    };
  }

  private expiresAt(now: Date, pricingValidUntil: string | null): string {
    const ttl = now.getTime() + QUOTE_TTL_MS;
    return new Date(pricingValidUntil ? Math.min(ttl, new Date(pricingValidUntil).getTime()) : ttl).toISOString();
  }
}
