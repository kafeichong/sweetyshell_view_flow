jest.mock('ali-oss', () => class OSS {});
jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target,
}));

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

function dependencies() {
  const value = snapshot();
  const asset = {
    id: 'asset-1', ownerId: 'actor-1', role: 'input', objectKey: 'inputs/asset.png',
    inspectionStatus: 'verified', fileHash: sha256, sizeBytes: BigInt(12),
    mimeType: 'image/png', mediaMetadata: { kind: 'image', width: 1280, height: 720 },
  };
  const prisma = {
    task: { findFirst: jest.fn().mockResolvedValue(null) },
    asset: { findFirst: jest.fn().mockResolvedValue(asset) },
  };
  const preflight = {
    prepareSubmission: jest.fn().mockResolvedValue(value),
  };
  const presign = { verifyObjectContent: jest.fn().mockResolvedValue(undefined) };
  const tx = { marker: 'transaction', asset: { findFirst: jest.fn().mockResolvedValue(asset) } };
  const budget = {
    createTaskWithReservation: jest.fn(async (data, validate) => {
      await validate(tx);
      return { task: { id: 'task-1', ...data.task, executionPlan: data.executionPlan }, created: true };
    }),
  };
  return { value, asset, prisma, preflight, presign, budget, tx };
}

describe('ProductionSubmissionService', () => {
  it('freezes the confirmed preflight, slot-bound Asset and quote in one reserved task', async () => {
    const deps = dependencies();
    const service = new ProductionSubmissionService(
      deps.prisma as never, deps.preflight as never, deps.presign as never, deps.budget as never,
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
    );

    await expect(service.submit('actor-1', 'request-1', confirmed(override))).rejects.toMatchObject({ code });
    expect(deps.prisma.asset.findFirst).not.toHaveBeenCalled();
    expect(deps.budget.createTaskWithReservation).not.toHaveBeenCalled();
  });

  it('rejects a missing, duplicate or unverified slot binding without reserving budget', async () => {
    const deps = dependencies();
    const service = new ProductionSubmissionService(
      deps.prisma as never, deps.preflight as never, deps.presign as never, deps.budget as never,
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
    );
    await expect(service.submit('actor-1', 'request-1', confirmed()))
      .rejects.toMatchObject({ code: 'PREFLIGHT_ACTUAL_CONTENT_MISMATCH' });
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
    );

    await expect(service.submit('actor-1', 'request-1', confirmed()))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('maps a concurrent idempotency conflict raised under the transaction lock', async () => {
    const deps = dependencies();
    deps.budget.createTaskWithReservation.mockRejectedValueOnce(new Error('IDEMPOTENCY_KEY_REUSED'));
    const service = new ProductionSubmissionService(
      deps.prisma as never, deps.preflight as never, deps.presign as never, deps.budget as never,
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
    );

    await expect(service.submit('actor-1', 'request-1', confirmed()))
      .rejects.toMatchObject({ code: 'PREFLIGHT_EXPIRED', path: 'preflightId' });
    expect(deps.presign.verifyObjectContent).toHaveBeenCalledTimes(1);
  });
});
