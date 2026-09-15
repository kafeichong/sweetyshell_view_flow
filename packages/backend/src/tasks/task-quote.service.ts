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

function pixelTokens(pixelFrames: Prisma.Decimal): number {
  const value = pixelFrames.div(1024)
    .toDecimalPlaces(0, Prisma.Decimal.ROUND_CEIL)
    .toNumber();
  if (!Number.isSafeInteger(value)) throw new Error('QUOTE_TOKEN_OVERFLOW');
  return value;
}

function frameTokens(frames: Prisma.Decimal, width: number, height: number): number {
  return pixelTokens(frames.mul(width).mul(height));
}

function formulaTokens(seconds: Prisma.Decimal, width: number, height: number, frameRate: number): number {
  return frameTokens(seconds.mul(frameRate), width, height);
}

/**
 * Provider 实际按**出片帧数**结算，而官方"估算值"公式按秒数计算，两者差一帧：
 * 四个真实付费任务（4s/720p 结算 87,300、5s/720p 结算 108,900 各一条、
 * 6s/480p 9:16 结算 58,045，见 docs/PROJECT_STATUS.md）的 completion_tokens
 * 全部等于「输出时长 × 帧率 + 1」帧乘以 宽 × 高 / 1024，且下载下来的成片帧数与
 * 此完全一致——编码器把起始那一帧也计了费。少算这一帧会让预占系统性低于真实
 * 结算，与项目"不得低估预占"的要求冲突，因此在输出部分补上。
 * 最低 token 口径不跟着动：它是官方表里逐行核对过的下限，且恒大于补帧后的公式值。
 */
const OUTPUT_EXTRA_FRAMES = 1;

/**
 * 自适应输出锁不住比例时（首帧画幅不在官方像素表内），用「该分辨率表内最大像素」预留。
 * **实测这个上界不是严格上界**：Provider 按最接近的表内比例的**面积**给预算，再用首帧
 * 比例取整，取整会略微越过表内最大像素——720p 实测 786×1180 = 927,480（表内最大
 * 1112×834 = 927,408，超 72），480p 实测 528×798 = 421,344（表内最大 421,120，超 224）。
 * 少预留与"不得低估预占"冲突，因此统一加一个余量；两次实测溢出分别为 0.008% 与 0.053%，
 * 取 1% 是留足整数量级的余量，代价只是这几档多预留不到 0.1 元。
 * 可锁定尺寸的路径不加余量：那几档的实际出片与表内尺寸逐位一致。
 * 证据见 contract.pricing.estimate.adaptiveOutputBound。
 */
const ADAPTIVE_BOUND_MARGIN = new Prisma.Decimal('1.01');

/**
 * 官方对「输入包含视频」的请求设有最低计费用量：公式值低于最低值时按最低值计费。
 * 最低值等价于把计费总秒数按 ceil(输出时长 × 5/3) 代入同一个 token 公式，因此它随
 * 分辨率、宽高比和输出时长变化，与官方说明的三个自变量一致。
 * 见 contract.pricing.inputVideoMinimumTokens 的验证证据。
 */
function minimumTotalSeconds(outputSeconds: Prisma.Decimal): Prisma.Decimal {
  return outputSeconds.mul(5).div(3).toDecimalPlaces(0, Prisma.Decimal.ROUND_CEIL);
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
    let outputReservedPixels: number | undefined;
    if (!dimensions && intent.generation.ratio === 'adaptive') {
      const adaptive = adaptiveDimensions(intent);
      dimensions = adaptive.dimensions;
      adaptiveBasis = adaptive.basis;
      if (!dimensions) {
        const candidates = Object.values(contract.model.dimensions?.[intent.generation.resolution] ?? {}) as [number, number][];
        outputPixelUpperBound = Math.max(...candidates.map(([width, height]) => width * height));
        outputReservedPixels = outputPixelUpperBound === undefined
          ? undefined
          : Math.ceil(new Prisma.Decimal(outputPixelUpperBound).mul(ADAPTIVE_BOUND_MARGIN).toNumber());
        const representative = candidates.find(([width, height]) => width * height === outputPixelUpperBound);
        dimensions = representative ?? null;
        bounded = true;
      }
    }
    if (!dimensions) return this.unavailable(now, ['OUTPUT_DIMENSIONS_UNRESOLVED'], this.pricingBasis(pricing));

    const [width, height] = dimensions;
    const frameRate = contract.model.outputFrameRate;
    const frames = inputSeconds.add(outputSeconds).mul(frameRate).add(OUTPUT_EXTRA_FRAMES);
    const tokens = outputReservedPixels === undefined
      ? frameTokens(frames, width, height)
      : pixelTokens(frames.mul(outputReservedPixels));
    const minimumTokens = hasInputVideo
      ? formulaTokens(minimumTotalSeconds(outputSeconds), width, height, frameRate)
      : null;
    const billedTokens = minimumTokens === null ? tokens : Math.max(tokens, minimumTokens);
    const output: OutputBasis = { durationSeconds: outputDuration, width, height, frameRate };
    const basis: Record<string, unknown> = {
      output,
      inputVideoSeconds: inputSeconds.toFixed(6),
      formulaTokens: tokens,
      minimumTokens,
      billedTokens,
      ratePerMillion: pricing.ratePerMillion,
      rateSource: pricing.rateSource,
      promotionId: pricing.promotionId,
      minimumTokensApplied: minimumTokens !== null && minimumTokens > tokens,
      pricingSnapshot: pricing,
      ...(adaptiveBasis ? { adaptiveBasis } : {}),
      ...(outputDurationBasis ? { outputDurationBasis } : {}),
      ...(outputPixelUpperBound ? { outputPixelUpperBound } : {}),
      ...(outputReservedPixels ? { outputReservedPixels } : {}),
      generation: {
        generateAudio: intent.generation.generateAudio,
        watermark: intent.generation.watermark,
        outputFormat: intent.generation.outputFormat,
      },
    };
    const amount = tokenCostCny(billedTokens, pricing.ratePerMillion);
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
