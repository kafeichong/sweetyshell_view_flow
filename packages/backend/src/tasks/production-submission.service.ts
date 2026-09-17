import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ArkAssetLibraryService } from '../assets/ark-asset-library.service';
import { ASSET_LIBRARY } from '../assets/asset-library-contract';
import { AssetPresignService } from '../assets/asset-presign.service';
import { MEDIA_INSPECTOR_VERSION } from '../assets/media-inspector-version';
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
  /**
   * `message` 不传时等于 `code`。只有"用户知道码也没用、必须知道下一步做什么"的错误才传它：
   * 控制器会把 `message` 原样交给客户端，而一个光秃秃的码正是 2026-09-16 那次"三处错误信息
   * 丢原因"的由来。
   */
  constructor(public readonly code: string, public readonly path = 'submission', message?: string) {
    super(message ?? code);
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
  inspectorVersion: string | null;
  /** 非空表示这是私域素材库素材：字节在方舟手里，生成时送 asset:// 而不是我方签名地址。 */
  arkAssetId: string | null;
  arkAssetStatus: string | null;
  arkAssetStatusCheckedAt: Date | null;
};

// 提交时会跑两遍素材校验：事务外那一遍可以发网络请求，事务里那一遍**绝不能**——
// 在事务里发 HTTP 会把行锁持有一个网络往返，方舟抖动就变成数据库事务失败。
// 所以事务内只读事务外刚写下的状态缓存，并用这个上限判定它还新不新鲜。
const ARK_STATUS_MAX_AGE_MS = 120_000;

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
    private readonly arkLibrary: ArkAssetLibraryService,
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
      // 资产是内容寻址复用的：同一个文件第二次上传直接复用旧行、不会再检查一次。所以检查器
      // 升级后，库里旧资产的 media_metadata 仍是按**旧口径**算的，下面按摘要逐字段比对必然
      // 对不上——而用户只会看到一个说不出原因的 PREFLIGHT_ACTUAL_CONTENT_MISMATCH（2026-09-16
      // 真实踩到，当时是手工逐行修的库）。版本对不上就先说清是哪一份、该跑什么命令。
      if (asset.inspectorVersion !== MEDIA_INSPECTOR_VERSION) {
        throw new ProductionSubmissionError(
          'ASSET_INSPECTION_STALE',
          `media.${descriptor.slotId}`,
          `素材 ${asset.id} 的媒体信息是按旧版检查器算的（记录了 ${asset.inspectorVersion ?? '未记录'}，当前是 `
          + `${MEDIA_INSPECTOR_VERSION}），与本次提交的口径对不上。这是资产复用机制造成的，素材本身没问题：`
          + `需要平台维护者跑一次资产重检（npm run assets:reinspect -- --apply）之后再提交。`,
        );
      }
      const matches = asset.fileHash === descriptor.sha256
        && asset.sizeBytes !== null && Number(asset.sizeBytes) === descriptor.sizeBytes
        && asset.mimeType?.toLowerCase() === descriptor.mimeType
        && workflowDigest(asset.mediaMetadata) === workflowDigest(descriptor.metadata)
        // 两边都归一成 null 再比：缺键与 null 指的是同一件事（"这份素材不在素材库里"），
        // 直接用 undefined === null 会把普通素材全判成不一致。
        && (asset.arkAssetId ?? null) === (descriptor.arkAssetId ?? null);
      if (!matches) throw new ProductionSubmissionError('PREFLIGHT_ACTUAL_CONTENT_MISMATCH', `media.${descriptor.slotId}`);
      if (asset.arkAssetId) {
        // 素材库素材的字节在方舟手里，我方 OSS 那份只是登记时取回来的副本——复验它的字节
        // 证明不了方舟那边还认这份素材。改成问方舟本人：还活着吗？在同一个项目里吗？
        if (verifyBytes) {
          await this.confirmArkAsset(asset, descriptor);
        } else {
          this.assertArkStatusFresh(asset, descriptor);
        }
      } else if (verifyBytes) {
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

  /**
   * 事务外那一遍：问方舟这份素材还在不在、还在不在同一个项目里，并把结果写回缓存列，
   * 供事务内那一遍读。
   */
  private async confirmArkAsset(asset: AssetRow, descriptor: MediaDescriptor) {
    const path = `media.${descriptor.slotId}`;
    const arkAssetId = asset.arkAssetId!;
    let remote;
    try {
      remote = await this.arkLibrary.getAsset(arkAssetId, ASSET_LIBRARY.projectName);
    } catch {
      // 查不到就不放行：方舟会拦下未入库的素材，那样等于白花一次钱。
      throw new ProductionSubmissionError(
        'ARK_ASSET_UNREACHABLE',
        path,
        `无法向方舟确认素材 ${arkAssetId} 的状态，本次提交不放行（素材库暂时不可用时宁可挡住，`
        + `也不要让一次注定被拦的生成白花钱）。请稍后重试。`,
      );
    }
    if (remote.status !== 'Active') {
      throw new ProductionSubmissionError(
        'ARK_ASSET_NOT_ACTIVE',
        path,
        `素材 ${arkAssetId} 在方舟侧的状态是 ${remote.status || '未知'}，只有 Active 才能用于生成。`
        + `素材被删掉、或还在处理中都会这样；请到素材库里确认后重新登记。`,
      );
    }
    if (remote.projectName !== ASSET_LIBRARY.projectName) {
      // 这一条断言一次抓住"素材传到了别的项目""AK 换了账号"整类事故。
      throw new ProductionSubmissionError(
        'ARK_ASSET_PROJECT_MISMATCH',
        path,
        `素材 ${arkAssetId} 属于项目 ${remote.projectName}，而生成用的是 ${ASSET_LIBRARY.projectName}。`
        + `方舟按项目隔离素材，跨项目根本用不了——不在这里查出来，就要等到生成任务才失败。`,
      );
    }
    await this.prisma.asset.updateMany({
      where: { id: asset.id },
      data: { arkAssetStatus: remote.status, arkAssetStatusCheckedAt: new Date() },
    });
    asset.arkAssetStatus = remote.status;
    asset.arkAssetStatusCheckedAt = new Date();
  }

  /**
   * 事务内那一遍：**绝不发网络请求**——在事务里发 HTTP 会把行锁持有一个网络往返，
   * 方舟抖动就变成数据库事务失败。只读事务外刚写下的缓存，并强制它还新鲜。
   *
   * 这条是防 fail-open 的：素材可能在预检之后、提交之前被人从素材库里删掉，
   * 光看缓存会以为它还活着。
   */
  private assertArkStatusFresh(asset: AssetRow, descriptor: MediaDescriptor) {
    const checkedAt = asset.arkAssetStatusCheckedAt?.getTime() ?? 0;
    if (asset.arkAssetStatus !== 'Active' || Date.now() - checkedAt > ARK_STATUS_MAX_AGE_MS) {
      throw new ProductionSubmissionError(
        'ARK_ASSET_STATUS_NOT_FRESH',
        `media.${descriptor.slotId}`,
        `素材 ${asset.arkAssetId} 的方舟侧状态没有在本次提交前确认过`
        + `（缓存于 ${checkedAt ? new Date(checkedAt).toISOString() : '从未'}）。请重新提交。`,
      );
    }
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
