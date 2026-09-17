jest.mock('ali-oss', () => class OSS {});
jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target,
}));

import { MEDIA_INSPECTOR_VERSION } from '../assets/media-inspector-version';
import { workflowDigest } from './workflow-catalog.service';
import { PreflightRecordError } from './preflight.service';
import {
  ProductionSubmissionError,
  ProductionSubmissionService,
} from './production-submission.service';

const sha256 = 'a'.repeat(64);

function confirmed(overrides: Record<string, unknown> = {}) {
  return {
    preflightId: 'preflight-1',
    executionSlotId: 'slot-1',
    media: [{ slotId: 'reference-1', assetId: 'asset-1' }],
    ...overrides,
  };
}

function snapshot() {
  const effectiveRequest = {
    contractVersion: 2 as const,
    workflowKey: 'seedance.reference-image-to-video.v1',
    prompt: { positive: '产品缓慢旋转' },
    generation: {
      duration: 4,
      ratio: '16:9',
      resolution: '720p',
      generateAudio: true,
      watermark: false,
      outputFormat: 'mp4' as const,
    },
    media: [{
      slotId: 'reference-1', role: 'reference_image' as const, sha256,
      mimeType: 'image/png', sizeBytes: 12,
      metadata: { kind: 'image' as const, width: 1280, height: 720 },
    }],
  };
  return {
    preflightId: 'preflight-1',
    actorId: 'actor-1',
    effectiveRequest,
    workflowVersion: '2026-09-15.3',
    contractDigest: 'contract-1',
    intentDigest: 'intent-1',
    model: 'doubao-seedance-2-5-260628',
    providerFields: {},
    quote: {
      status: 'estimated' as const,
      currency: 'CNY' as const,
      estimatedCny: '6.048000',
      reserveCny: '6.048000',
      pricingVersion: 'public-list-2026-09-15',
      quoteDigest: 'quote-1',
      expiresAt: '2099-01-01T00:00:00.000Z',
      missing: [],
      basis: {
        estimatedTokens: 86400,
        pricingSnapshot: {
          pricingVersion: 'public-list-2026-09-15',
          model: 'doubao-seedance-2-5-260628',
          ratePerMillion: '70.00',
          source: 'public_catalog',
          validFrom: '2026-09-15T00:00:00.000Z',
          validUntil: '2099-01-01T00:00:00.000Z',
          promotionId: null,
          pricingDigest: 'price-1',
        },
      },
    },
  };
}

// ---- 私域素材库（asset://）----
// 这些断言各自对应一种"不拦就会白花钱"的失败：方舟会拒掉状态不对、或与生成 Key
// 不同项目的素材，而那时任务已经建好了。

const ARK_ASSET_ID = 'asset-20260917115246-cgmtw';

function arkSnapshot() {
  const value = snapshot();
  // descriptor 带上 arkAssetId，并且双方（descriptor 与 Asset 行）必须一致
  (value.effectiveRequest.media[0] as Record<string, unknown>).arkAssetId = ARK_ASSET_ID;
  return value;
}

function arkAssetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'asset-1', ownerId: 'actor-1', role: 'input', objectKey: 'inputs/ark-copy.png',
    inspectionStatus: 'verified', fileHash: sha256, sizeBytes: BigInt(12),
    mimeType: 'image/png', mediaMetadata: { kind: 'image', width: 1280, height: 720 },
    inspectorVersion: MEDIA_INSPECTOR_VERSION,
    arkAssetId: ARK_ASSET_ID, arkAssetStatus: null, arkAssetStatusCheckedAt: null,
    ...overrides,
  };
}

/** 让整条链变成"素材库素材"：descriptor 与 Asset 行都带上同一个 arkAssetId。 */
function arkDependencies({ asset = {}, remote = {} } = {}) {
  const deps = dependencies({ asset: { ...arkAssetRow(asset) }, value: arkSnapshot() });
  deps.arkLibrary.getAsset.mockResolvedValue(arkRemote(remote));
  return deps;
}

function arkRemote(overrides: Record<string, unknown> = {}) {
  return {
    id: ARK_ASSET_ID, name: '005', assetType: 'Image', status: 'Active',
    groupId: 'group-20260917115246-vr2hh', projectName: 'default', url: 'https://ark.example.invalid/x.jpg',
    ...overrides,
  };
}

function dependencies({
  asset: assetOverrides = {},
  value: valueOverride,
}: { asset?: Record<string, unknown>; value?: unknown } = {}) {
  const value = (valueOverride ?? snapshot()) as ReturnType<typeof snapshot>;
  const asset = {
    id: 'asset-1', ownerId: 'actor-1', role: 'input', objectKey: 'inputs/asset.png',
    inspectionStatus: 'verified', fileHash: sha256, sizeBytes: BigInt(12),
    mimeType: 'image/png', mediaMetadata: { kind: 'image', width: 1280, height: 720 },
    inspectorVersion: MEDIA_INSPECTOR_VERSION,
    // 默认是普通上传件：不在素材库里，走 OSS 字节复验那条路。
    arkAssetId: null, arkAssetStatus: null, arkAssetStatusCheckedAt: null,
    ...assetOverrides,
  };
  const prisma = {
    task: { findFirst: jest.fn().mockResolvedValue(null) },
    asset: { findFirst: jest.fn().mockResolvedValue(asset), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const preflight = {
    prepareSubmission: jest.fn().mockResolvedValue(value),
  };
  const presign = { verifyObjectContent: jest.fn().mockResolvedValue(undefined) };
  const arkLibrary = { getAsset: jest.fn() };
  const tx = { marker: 'transaction', asset: { findFirst: jest.fn().mockResolvedValue(asset) } };
  const budget = {
    createTaskWithReservation: jest.fn(async (data, validate) => {
      await validate(tx);
      return { task: { id: 'task-1', ...data.task, executionPlan: data.executionPlan }, created: true };
    }),
  };
  return { value, asset, prisma, preflight, presign, budget, tx, arkLibrary };
}

describe('ProductionSubmissionService', () => {
  it('freezes the confirmed preflight, slot-bound Asset and quote in one reserved task', async () => {
    const deps = dependencies();
    const service = new ProductionSubmissionService(
      deps.prisma as never, deps.preflight as never, deps.presign as never, deps.budget as never,
      deps.arkLibrary as never,
    );

    const result = await service.submit('actor-1', 'request-1', confirmed());

    expect(result).toMatchObject({ id: 'task-1', status: 'pending', deduplicated: false });
    expect(deps.presign.verifyObjectContent).toHaveBeenCalledWith('inputs/asset.png', sha256, 12);
    expect(deps.preflight.prepareSubmission).toHaveBeenNthCalledWith(
      1, 'actor-1', 'preflight-1',
    );
    expect(deps.preflight.prepareSubmission).toHaveBeenNthCalledWith(
      2, 'actor-1', 'preflight-1', undefined, deps.tx,
    );
    const data = deps.budget.createTaskWithReservation.mock.calls[0][0];
    expect(data.estimatedCny).toBe('6.048000');
    expect(data.executionPlan).toMatchObject({
      specVersion: 'workflow-production-v2',
      contractDigest: 'contract-1', intentDigest: 'intent-1', quoteDigest: 'quote-1',
      model: 'doubao-seedance-2-5-260628', duration: 4, ratio: '16:9', resolution: '720p',
      pricingVersion: 'public-list-2026-09-15', reserveCny: '6.048000', estimatedTokens: 86400,
      media: [{ slotId: 'reference-1', assetId: 'asset-1', role: 'reference_image', fileHash: sha256 }],
    });
    expect(data.executionPlan.pricingSnapshot).toEqual(deps.value.quote.basis.pricingSnapshot);
    expect(data.executionSlotId).toBe('slot-1');
    expect(data.requestDigest).toBe(workflowDigest({
      preflightId: 'preflight-1', executionSlotId: 'slot-1',
      media: [{ slotId: 'reference-1', assetId: 'asset-1' }],
    }));
  });

  it.each([
    [{ executionSlotId: '' }, 'SUBMISSION_FIELD_REQUIRED'],
    [{ quoteDigest: 'client-price-digest' }, 'SUBMISSION_FIELDS_INVALID'],
  ])('rejects a malformed or client-overridable request before reading Assets: %s', async (override, code) => {
    const deps = dependencies();
    const service = new ProductionSubmissionService(
      deps.prisma as never, deps.preflight as never, deps.presign as never, deps.budget as never,
      deps.arkLibrary as never,
    );

    await expect(service.submit('actor-1', 'request-1', confirmed(override))).rejects.toMatchObject({ code });
    expect(deps.prisma.asset.findFirst).not.toHaveBeenCalled();
    expect(deps.budget.createTaskWithReservation).not.toHaveBeenCalled();
  });

  it('rejects a missing, duplicate or unverified slot binding without reserving budget', async () => {
    const deps = dependencies();
    const service = new ProductionSubmissionService(
      deps.prisma as never, deps.preflight as never, deps.presign as never, deps.budget as never,
      deps.arkLibrary as never,
    );
    await expect(service.submit('actor-1', 'request-1', confirmed({ media: [] })))
      .rejects.toMatchObject({ code: 'SUBMISSION_MEDIA_BINDINGS_MISMATCH' });

    deps.prisma.asset.findFirst.mockResolvedValueOnce(null);
    await expect(service.submit('actor-1', 'request-2', confirmed()))
      .rejects.toMatchObject({ code: 'SUBMISSION_ASSET_NOT_VERIFIED' });
    expect(deps.budget.createTaskWithReservation).not.toHaveBeenCalled();
  });

  it('rejects Asset bytes or inspected metadata that differ from Preview', async () => {
    const deps = dependencies();
    deps.asset.mediaMetadata = { kind: 'image', width: 720, height: 1280 };
    const service = new ProductionSubmissionService(
      deps.prisma as never, deps.preflight as never, deps.presign as never, deps.budget as never,
      deps.arkLibrary as never,
    );
    await expect(service.submit('actor-1', 'request-1', confirmed()))
      .rejects.toMatchObject({ code: 'PREFLIGHT_ACTUAL_CONTENT_MISMATCH' });
    expect(deps.presign.verifyObjectContent).not.toHaveBeenCalled();
  });

  it('names the stale inspection instead of leaving an unexplained mismatch', async () => {
    const deps = dependencies();
    // 元数据**看起来**与提交声明完全一致，只是按旧版检查器算的——这正是真实形态：重检一批
    // 资产时绝大多数行的内容是逐字节不变的，变的只有版本号。光看摘要是查不出问题的。
    deps.asset.inspectorVersion = '2026-09-15.1';
    const service = new ProductionSubmissionService(
      deps.prisma as never, deps.preflight as never, deps.presign as never, deps.budget as never,
      deps.arkLibrary as never,
    );

    await expect(service.submit('actor-1', 'request-1', confirmed())).rejects.toMatchObject({
      code: 'ASSET_INSPECTION_STALE',
      path: 'media.reference-1',
      // 用户拿到码也没用，得知道该找谁做什么——所以这条错误带 message。
      message: expect.stringContaining('assets:reinspect'),
    });
    expect(deps.budget.createTaskWithReservation).not.toHaveBeenCalled();
    expect(deps.presign.verifyObjectContent).not.toHaveBeenCalled();
  });

  it('returns an existing identical idempotent task before rechecking expired Preview or OSS', async () => {
    const deps = dependencies();
    const request = confirmed();
    const requestDigest = workflowDigest(request);
    deps.prisma.task.findFirst.mockResolvedValueOnce({
      id: 'task-existing', status: 'running', requestSnapshot: { submissionDigest: requestDigest },
    });
    const service = new ProductionSubmissionService(
      deps.prisma as never, deps.preflight as never, deps.presign as never, deps.budget as never,
      deps.arkLibrary as never,
    );

    await expect(service.submit('actor-1', 'request-1', request)).resolves.toMatchObject({
      id: 'task-existing', status: 'running', deduplicated: true,
    });
    expect(deps.preflight.prepareSubmission).not.toHaveBeenCalled();
    expect(deps.presign.verifyObjectContent).not.toHaveBeenCalled();
  });

  it('recovers the current undelivered slot Task before checking new content or admission', async () => {
    const deps = dependencies();
    deps.prisma.task.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'task-current', status: 'running', clientDeliveryStatus: 'pending', executionAttempts: [] });
    const service = new ProductionSubmissionService(
      deps.prisma as never, deps.preflight as never, deps.presign as never, deps.budget as never,
      deps.arkLibrary as never,
    );

    await expect(service.submit('actor-1', 'request-new', confirmed({ preflightId: 'expired-preflight' })))
      .resolves.toMatchObject({ id: 'task-current', recovered: true, deduplicated: true });
    expect(deps.preflight.prepareSubmission).not.toHaveBeenCalled();
    expect(deps.presign.verifyObjectContent).not.toHaveBeenCalled();
  });

  it('rejects reuse of an idempotency key for a different confirmed request', async () => {
    const deps = dependencies();
    deps.prisma.task.findFirst.mockResolvedValueOnce({
      id: 'task-existing', requestSnapshot: { submissionDigest: 'different' },
    });
    const service = new ProductionSubmissionService(
      deps.prisma as never, deps.preflight as never, deps.presign as never, deps.budget as never,
      deps.arkLibrary as never,
    );

    await expect(service.submit('actor-1', 'request-1', confirmed()))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('maps a concurrent idempotency conflict raised under the transaction lock', async () => {
    const deps = dependencies();
    deps.budget.createTaskWithReservation.mockRejectedValueOnce(new Error('IDEMPOTENCY_KEY_REUSED'));
    const service = new ProductionSubmissionService(
      deps.prisma as never, deps.preflight as never, deps.presign as never, deps.budget as never,
      deps.arkLibrary as never,
    );

    await expect(service.submit('actor-1', 'request-1', confirmed()))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', path: 'Idempotency-Key' });
  });

  it('maps a preflight that expires during final transaction validation to a stable submission error', async () => {
    const deps = dependencies();
    deps.preflight.prepareSubmission
      .mockResolvedValueOnce(deps.value)
      .mockRejectedValueOnce(new PreflightRecordError('PREFLIGHT_EXPIRED'));
    const service = new ProductionSubmissionService(
      deps.prisma as never, deps.preflight as never, deps.presign as never, deps.budget as never,
      deps.arkLibrary as never,
    );

    await expect(service.submit('actor-1', 'request-1', confirmed()))
      .rejects.toMatchObject({ code: 'PREFLIGHT_EXPIRED', path: 'preflightId' });
    expect(deps.presign.verifyObjectContent).toHaveBeenCalledTimes(1);
  });

  // 素材库素材的字节在方舟手里，复验我方 OSS 那份副本证明不了方舟还认它。
  it('confirms a library asset with Ark instead of re-hashing our own copy', async () => {
    const deps = arkDependencies();
    const service = new ProductionSubmissionService(
      deps.prisma as never, deps.preflight as never, deps.presign as never, deps.budget as never,
      deps.arkLibrary as never,
    );

    await service.submit('actor-1', 'request-1', confirmed());

    expect(deps.arkLibrary.getAsset).toHaveBeenCalledWith(ARK_ASSET_ID, 'default');
    expect(deps.presign.verifyObjectContent).not.toHaveBeenCalled();
    // 事务外查到的状态要写回缓存，事务内那一遍只读它——在事务里发 HTTP 会把行锁
    // 持有一个网络往返，方舟抖动就变成数据库事务失败。
    expect(deps.prisma.asset.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'asset-1' },
      data: expect.objectContaining({ arkAssetStatus: 'Active' }),
    }));
  });

  it.each([
    ['ARK_ASSET_PROJECT_MISMATCH', { projectName: 'other-project' }],
    ['ARK_ASSET_NOT_ACTIVE', { status: 'Failed' }],
  ])('refuses a library asset that Ark would not accept: %s', async (code, remote) => {
    const deps = arkDependencies({ remote });
    const service = new ProductionSubmissionService(
      deps.prisma as never, deps.preflight as never, deps.presign as never, deps.budget as never,
      deps.arkLibrary as never,
    );

    await expect(service.submit('actor-1', 'request-1', confirmed()))
      .rejects.toMatchObject({ code });
    // 拦在预占之前：这类素材送上去必被方舟拒，不该先建任务再白花一次钱。
    expect(deps.budget.createTaskWithReservation).not.toHaveBeenCalled();
  });

  it('fails closed when Ark cannot be reached at all', async () => {
    const deps = arkDependencies();
    deps.arkLibrary.getAsset.mockRejectedValue(new Error('network down'));
    const service = new ProductionSubmissionService(
      deps.prisma as never, deps.preflight as never, deps.presign as never, deps.budget as never,
      deps.arkLibrary as never,
    );

    await expect(service.submit('actor-1', 'request-1', confirmed()))
      .rejects.toMatchObject({ code: 'ARK_ASSET_UNREACHABLE' });
  });

  it('refuses a library asset whose inspection was never confirmed before submitting', async () => {
    // 第二遍（事务内）只能读缓存。缓存从不新鲜时**不能**当作还活着放行——
    // 素材可能在预检之后被人从素材库里删掉。
    const deps = arkDependencies({ asset: { arkAssetStatus: 'Active', arkAssetStatusCheckedAt: null } });
    const service = new ProductionSubmissionService(
      deps.prisma as never, deps.preflight as never, deps.presign as never, deps.budget as never,
      deps.arkLibrary as never,
    );
    // 让事务外那一遍查不到（模拟两遍之间缓存被清掉）——直接把 tx 的 asset 换成陈旧副本
    deps.tx.asset.findFirst.mockResolvedValue({ ...deps.asset, arkAssetStatusCheckedAt: null });
    deps.arkLibrary.getAsset.mockResolvedValue(arkRemote());

    await expect(service.submit('actor-1', 'request-1', confirmed()))
      .rejects.toMatchObject({ code: 'ARK_ASSET_STATUS_NOT_FRESH' });
  });

  it('rejects a descriptor whose asset id disagrees with the bound Asset', async () => {
    // 换绑：descriptor 说是 A，绑的却是 B。逐字段比对必须抓住它。
    const deps = arkDependencies({ asset: { arkAssetId: 'asset-20260917115246-other' } });
    const service = new ProductionSubmissionService(
      deps.prisma as never, deps.preflight as never, deps.presign as never, deps.budget as never,
      deps.arkLibrary as never,
    );

    await expect(service.submit('actor-1', 'request-1', confirmed()))
      .rejects.toMatchObject({ code: 'PREFLIGHT_ACTUAL_CONTENT_MISMATCH' });
  });

  it('keeps ordinary uploads on the OSS byte check', async () => {
    // 加法设计不能把普通素材也带进 ark 分支：它们没有 arkAssetId，仍必须走字节复验。
    const deps = dependencies();
    const service = new ProductionSubmissionService(
      deps.prisma as never, deps.preflight as never, deps.presign as never, deps.budget as never,
      deps.arkLibrary as never,
    );

    await service.submit('actor-1', 'request-1', confirmed());

    expect(deps.presign.verifyObjectContent).toHaveBeenCalledWith('inputs/asset.png', sha256, 12);
    expect(deps.arkLibrary.getAsset).not.toHaveBeenCalled();
  });
});
