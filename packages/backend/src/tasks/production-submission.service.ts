import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AssetPresignService } from '../assets/asset-presign.service';
import { PrismaService } from '../prisma.service';
import { PreflightRecordError, PreflightService } from './preflight.service';
import { isExecutionSlotLocked, TaskBudgetService } from './task-budget.service';
import { MediaDescriptor } from './workflow-contract';
import { workflowDigest } from './workflow-catalog.service';

export type ProductionSubmission = {
  preflightId: string;
  executionSlotId: string;
  media: { slotId: string; assetId: string }[];
};

export class ProductionSubmissionError extends Error {
  constructor(public readonly code: string, public readonly path = 'submission') {
    super(code);
    this.name = 'ProductionSubmissionError';
  }
}

type AssetRow = {
  id: string;
  ownerId: string | null;
  role: string;
  objectKey: string;
  inspectionStatus: string | null;
  fileHash: string | null;
  sizeBytes: bigint | null;
  mimeType: string | null;
  mediaMetadata: unknown;
};

type AssetStore = {
  asset: {
    findFirst(args: unknown): Promise<AssetRow | null>;
  };
};

function stringField(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ProductionSubmissionError('SUBMISSION_FIELD_REQUIRED', path);
  return value.trim();
}

function normalizeSubmission(value: unknown): ProductionSubmission {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProductionSubmissionError('SUBMISSION_INVALID');
  }
  const raw = value as Record<string, unknown>;
  const allowed = ['preflightId', 'executionSlotId', 'media'];
  const unknown = Object.keys(raw).find((key) => !allowed.includes(key));
  if (unknown) throw new ProductionSubmissionError('SUBMISSION_FIELDS_INVALID', unknown);
  if (!Array.isArray(raw.media)) throw new ProductionSubmissionError('SUBMISSION_MEDIA_BINDINGS_INVALID', 'media');
  const media = raw.media.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ProductionSubmissionError('SUBMISSION_MEDIA_BINDINGS_INVALID', `media[${index}]`);
    }
    const binding = item as Record<string, unknown>;
    if (Object.keys(binding).some((key) => !['slotId', 'assetId'].includes(key))) {
      throw new ProductionSubmissionError('SUBMISSION_MEDIA_BINDINGS_INVALID', `media[${index}]`);
    }
    return {
      slotId: stringField(binding.slotId, `media[${index}].slotId`),
      assetId: stringField(binding.assetId, `media[${index}].assetId`),
    };
  });
  if (new Set(media.map((item) => item.slotId)).size !== media.length) {
    throw new ProductionSubmissionError('SUBMISSION_MEDIA_BINDINGS_MISMATCH', 'media');
  }
  return {
    preflightId: stringField(raw.preflightId, 'preflightId'),
    executionSlotId: stringField(raw.executionSlotId, 'executionSlotId'),
    media,
  };
}

@Injectable()
export class ProductionSubmissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly preflight: PreflightService,
    private readonly presign: AssetPresignService,
    private readonly budget: TaskBudgetService,
  ) {}

  async submit(actorId: string, idempotencyKey: string, input: unknown) {
    const submission = normalizeSubmission(input);
    const requestDigest = workflowDigest(submission);
    const existing = await this.prisma.task.findFirst({
      where: { actorId, clientRequestId: idempotencyKey },
    });
    if (existing) return this.idempotentResult(existing, requestDigest);

    const currentSlotTask = await this.prisma.task.findFirst({
      where: { actorId, executionSlotId: submission.executionSlotId },
      orderBy: { slotSequence: 'desc' },
      include: { executionAttempts: { orderBy: { attemptNo: 'desc' }, take: 1 } },
    });
    if (currentSlotTask && isExecutionSlotLocked(currentSlotTask)) {
      return { ...currentSlotTask, recovered: true, deduplicated: true };
    }

    let snapshot;
    try {
      snapshot = await this.preflight.prepareSubmission(actorId, submission.preflightId);
    } catch (error) {
      this.rethrow(error);
    }
    const boundMedia = await this.validateAssets(actorId, snapshot.effectiveRequest.media, submission.media, this.prisma, true);
    const quote = snapshot.quote;
    const pricingSnapshot = quote.basis.pricingSnapshot;
    if (!pricingSnapshot || typeof pricingSnapshot !== 'object') {
      throw new ProductionSubmissionError('QUOTE_UNAVAILABLE', 'quote');
    }

    const generation = snapshot.effectiveRequest.generation;
    const executionPlan = {
      specVersion: 'workflow-production-v2',
      contractVersion: snapshot.effectiveRequest.contractVersion,
      contractDigest: snapshot.contractDigest,
      intentDigest: snapshot.intentDigest,
      quoteDigest: quote.quoteDigest,
      workflowKey: snapshot.effectiveRequest.workflowKey,
      workflowVersion: snapshot.workflowVersion,
      model: snapshot.model,
      prompt: snapshot.effectiveRequest.prompt.positive,
      duration: generation.duration,
      ratio: generation.ratio,
      resolution: generation.resolution,
      generateAudio: generation.generateAudio,
      watermark: generation.watermark,
      outputFormat: generation.outputFormat,
      ...snapshot.providerFields,
      pricingVersion: quote.pricingVersion!,
      reserveCny: quote.reserveCny!,
      estimatedTokens: typeof quote.basis.estimatedTokens === 'number' ? quote.basis.estimatedTokens : undefined,
      pricingSnapshot,
      media: boundMedia.map(({ descriptor, asset }) => ({
        slotId: descriptor.slotId,
        assetId: asset.id,
        role: descriptor.role,
        fileHash: descriptor.sha256,
        mimeType: descriptor.mimeType,
        sizeBytes: descriptor.sizeBytes,
        metadata: descriptor.metadata,
      })),
    };

    let created;
    try {
      created = await this.budget.createTaskWithReservation({
        actorId,
        clientRequestId: idempotencyKey,
        requestDigest,
        executionSlotId: submission.executionSlotId,
        estimatedCny: quote.reserveCny!,
        executionPlan,
        task: {
          createdBy: actorId,
          prompt: snapshot.effectiveRequest.prompt.positive,
          status: 'pending',
          capability: snapshot.effectiveRequest.workflowKey,
          workflowName: snapshot.effectiveRequest.workflowKey,
          workflowVersion: snapshot.workflowVersion,
          workflowHash: snapshot.contractDigest,
          requestSnapshot: {
            submissionDigest: requestDigest,
            preflightId: submission.preflightId,
            executionSlotId: submission.executionSlotId,
            intentDigest: snapshot.intentDigest,
            quoteDigest: quote.quoteDigest,
            effectiveRequest: snapshot.effectiveRequest,
            media: submission.media,
          },
          preflightId: submission.preflightId,
          contractDigest: snapshot.contractDigest,
          intentDigest: snapshot.intentDigest,
          quoteDigest: quote.quoteDigest,
        },
      }, async (tx) => {
        const current = await this.preflight.prepareSubmission(actorId, submission.preflightId, undefined, tx);
        if (workflowDigest(current.effectiveRequest) !== workflowDigest(snapshot.effectiveRequest)) {
          throw new ProductionSubmissionError('PREFLIGHT_RECORD_INVALID', 'preflightId');
        }
        await this.validateAssets(actorId, current.effectiveRequest.media, submission.media, tx as unknown as AssetStore, false);
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'IDEMPOTENCY_KEY_REUSED') {
        throw new ProductionSubmissionError('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key');
      }
      if (error instanceof PreflightRecordError) this.rethrow(error);
      throw error;
    }

    return {
      ...created.task,
      recovered: Boolean(created.recovered),
      deduplicated: !created.created,
    };
  }

  private async validateAssets(
    actorId: string,
    descriptors: MediaDescriptor[],
    bindings: { slotId: string; assetId: string }[],
    store: AssetStore,
    verifyBytes: boolean,
  ) {
    const expectedSlots = [...descriptors.map((item) => item.slotId)].sort();
    const actualSlots = [...bindings.map((item) => item.slotId)].sort();
    if (workflowDigest(expectedSlots) !== workflowDigest(actualSlots)) {
      throw new ProductionSubmissionError('SUBMISSION_MEDIA_BINDINGS_MISMATCH', 'media');
    }
    const bySlot = new Map(bindings.map((item) => [item.slotId, item.assetId]));
    const result: { descriptor: MediaDescriptor; asset: AssetRow }[] = [];
    for (const descriptor of descriptors) {
      const assetId = bySlot.get(descriptor.slotId)!;
      const asset = await store.asset.findFirst({
        where: { id: assetId, ownerId: actorId, role: 'input', inspectionStatus: 'verified' },
      });
      if (!asset) throw new ProductionSubmissionError('SUBMISSION_ASSET_NOT_VERIFIED', `media.${descriptor.slotId}`);
      const matches = asset.fileHash === descriptor.sha256
        && asset.sizeBytes !== null && Number(asset.sizeBytes) === descriptor.sizeBytes
        && asset.mimeType?.toLowerCase() === descriptor.mimeType
        && workflowDigest(asset.mediaMetadata) === workflowDigest(descriptor.metadata);
      if (!matches) throw new ProductionSubmissionError('PREFLIGHT_ACTUAL_CONTENT_MISMATCH', `media.${descriptor.slotId}`);
      if (verifyBytes) {
        try {
          await this.presign.verifyObjectContent(asset.objectKey, descriptor.sha256, descriptor.sizeBytes);
        } catch {
          throw new ProductionSubmissionError('PREFLIGHT_ACTUAL_CONTENT_MISMATCH', `media.${descriptor.slotId}`);
        }
      }
      result.push({ descriptor, asset });
    }
    return result;
  }

  private idempotentResult(existing: any, requestDigest: string) {
    const snapshot = existing.requestSnapshot as { submissionDigest?: unknown } | null;
    if (snapshot?.submissionDigest !== requestDigest) {
      throw new ProductionSubmissionError('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key');
    }
    return { ...existing, deduplicated: true };
  }

  private rethrow(error: unknown): never {
    if (error instanceof ProductionSubmissionError) throw error;
    if (error instanceof PreflightRecordError) throw new ProductionSubmissionError(error.code, 'preflightId');
    throw error;
  }
}
