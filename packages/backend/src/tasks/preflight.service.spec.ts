jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target,
  Logger: class Logger { log() {} },
}));

import { PreflightService } from './preflight.service';
import { PricingCatalog } from './pricing-catalog';
import { TaskQuoteService } from './task-quote.service';
import { WorkflowCatalogService, workflowDigest } from './workflow-catalog.service';

class ReadyWorkflowCatalogFixture extends WorkflowCatalogService {
  override evaluate(input: unknown): ReturnType<WorkflowCatalogService['evaluate']> {
    const evaluated = super.evaluate(input);
    evaluated.workflow.state.implementation = 'ready';
    evaluated.workflow.state.admission = { enabled: true, reason: null };
    return evaluated;
  }
}

function intent() {
  return {
    contractVersion: 2,
    workflowKey: 'seedance.text-to-video.v1',
    prompt: { positive: '雨后的街道，镜头缓慢推进' },
    generation: {
      duration: 4,
      ratio: '16:9',
      resolution: '720p',
      generateAudio: true,
      watermark: false,
      outputFormat: 'mp4',
    },
    media: [],
  };
}

function dependencies(budgetResult = { canProceed: false, reason: 'DAILY_LIMIT_EXCEEDED' }) {
  const records: any[] = [];
  const prisma = {
    preflightRecord: {
      create: jest.fn(async ({ data }) => {
        const value = { ...data, id: data.id ?? `preflight-${records.length + 1}` };
        records.push(value);
        return value;
      }),
      findFirst: jest.fn(async ({ where }) => records.find((item) => item.id === where.id && item.actorId === where.actorId) ?? null),
    },
    task: { create: jest.fn() },
    executionAttempt: { create: jest.fn() },
    taskBudgetReservation: { create: jest.fn() },
  };
  const budget = { preflightAvailability: jest.fn().mockResolvedValue(budgetResult) };
  return { prisma, budget, records };
}

describe('PreflightService', () => {
  const originalActors = process.env.VIDEO_FLOW_PRODUCTION_ACTORS;

  afterEach(() => {
    if (originalActors === undefined) delete process.env.VIDEO_FLOW_PRODUCTION_ACTORS;
    else process.env.VIDEO_FLOW_PRODUCTION_ACTORS = originalActors;
    jest.useRealTimers();
  });

  const quotes = (catalog = new PricingCatalog()) => new TaskQuoteService(catalog);

  it('returns request checks plus production blockers without creating paid-domain records', async () => {
    delete process.env.VIDEO_FLOW_PRODUCTION_ACTORS;
    const { prisma, budget } = dependencies();
    const service = new PreflightService(prisma as never, budget as never, new WorkflowCatalogService(), quotes());

    const report = await service.preview('creative-pilot', intent());

    expect(report.requestCheck.status).toBe('passed');
    expect(report.productionAdmission.canSubmit).toBe(false);
    expect(report.productionAdmission.blockers.map((item) => item.code)).toEqual(expect.arrayContaining([
      'PRODUCTION_NOT_ALLOWED',
      'DAILY_LIMIT_EXCEEDED',
    ]));
    expect(report.quote).toMatchObject({
      status: 'estimated', estimatedCny: '6.111000', reserveCny: '6.111000',
    });
    expect(report.willUploadMedia).toBe(false);
    expect(report.willCallProvider).toBe(false);
    expect(prisma.preflightRecord.create).toHaveBeenCalledTimes(1);
    expect(prisma.task.create).not.toHaveBeenCalled();
    expect(prisma.executionAttempt.create).not.toHaveBeenCalled();
    expect(prisma.taskBudgetReservation.create).not.toHaveBeenCalled();
    expect(budget.preflightAvailability).toHaveBeenCalledWith('creative-pilot', '6.111000');
  });

  it('reports an incomplete workflow as both not ready and not admitted', async () => {
    process.env.VIDEO_FLOW_PRODUCTION_ACTORS = 'creative-pilot';
    const { prisma, budget } = dependencies({ canProceed: true, reason: undefined });
    const service = new PreflightService(prisma as never, budget as never, new WorkflowCatalogService(), quotes());

    const report = await service.preview('creative-pilot', {
      ...intent(),
      workflowKey: 'seedance.first-frame-to-video.v1',
      generation: { ...intent().generation, ratio: 'adaptive' },
      media: [{
        slotId: 'first-frame', role: 'first_frame', sha256: 'd'.repeat(64), mimeType: 'image/png', sizeBytes: 10,
        metadata: { kind: 'image', width: 900, height: 1600 },
      }],
    });

    // 两道闸门互相独立：合同里仍是 incomplete 的工作流必须两个 blocker 都报，
    // 只有 implementation=ready 才轮到 admission 单独决定是否放行。
    expect(report.productionAdmission.canSubmit).toBe(false);
    expect(report.productionAdmission.blockers.map((item) => item.code)).toEqual(expect.arrayContaining([
      'WORKFLOW_NOT_READY',
      'WORKFLOW_NOT_ENABLED',
    ]));
  });

  it('stores semantic media failures as a failed request report instead of a production task', async () => {
    process.env.VIDEO_FLOW_PRODUCTION_ACTORS = 'creative-pilot';
    const { prisma, budget } = dependencies({ canProceed: true, reason: undefined });
    const service = new PreflightService(prisma as never, budget as never, new WorkflowCatalogService(), quotes());
    const report = await service.preview('creative-pilot', {
      ...intent(),
      workflowKey: 'seedance.reference-image-to-video.v1',
      media: [{
        slotId: 'reference-1', role: 'reference_image', sha256: 'c'.repeat(64), mimeType: 'audio/mpeg', sizeBytes: 10,
        metadata: { kind: 'audio', durationSeconds: 3 },
      }],
    });

    expect(report.requestCheck.status).toBe('failed');
    expect(report.productionAdmission.canSubmit).toBe(false);
    expect(report.productionAdmission.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'REQUEST_INVALID', path: 'requestCheck' }),
    ]));
    expect(prisma.preflightRecord.create).toHaveBeenCalledTimes(1);
  });

  it('rechecks current admission while preserving the stored request and quote', async () => {
    process.env.VIDEO_FLOW_PRODUCTION_ACTORS = 'creative-pilot';
    const { prisma, budget } = dependencies({ canProceed: true, reason: undefined });
    const service = new PreflightService(prisma as never, budget as never, new WorkflowCatalogService(), quotes());
    const created = await service.preview('creative-pilot', intent());
    budget.preflightAvailability.mockResolvedValue({ canProceed: false, reason: 'PRODUCTION_PAUSED' });

    const checked = await service.check('creative-pilot', created.preflightId);

    expect(checked.effectiveRequest).toEqual(created.effectiveRequest);
    expect(checked.quote.quoteDigest).toBe(created.quote.quoteDigest);
    expect(budget.preflightAvailability).toHaveBeenLastCalledWith('creative-pilot', created.quote.reserveCny);
    expect(checked.productionAdmission.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PRODUCTION_PAUSED' }),
    ]));
  });

  it('marks an expired record incomplete without deleting it or creating another record', async () => {
    process.env.VIDEO_FLOW_PRODUCTION_ACTORS = 'creative-pilot';
    jest.useFakeTimers().setSystemTime(new Date('2026-09-15T00:00:00.000Z'));
    const { prisma, budget } = dependencies({ canProceed: true, reason: undefined });
    const service = new PreflightService(prisma as never, budget as never, new WorkflowCatalogService(), quotes());
    const created = await service.preview('creative-pilot', intent());
    jest.setSystemTime(new Date('2026-09-15T01:00:00.000Z'));

    const checked = await service.check('creative-pilot', created.preflightId);

    expect(checked.requestCheck.status).toBe('incomplete');
    expect(checked.productionAdmission.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PREFLIGHT_EXPIRED' }),
    ]));
    expect(prisma.preflightRecord.create).toHaveBeenCalledTimes(1);
  });

  it('marks the record invalid when the independently stored quote snapshot changes', async () => {
    process.env.VIDEO_FLOW_PRODUCTION_ACTORS = 'creative-pilot';
    const { prisma, budget, records } = dependencies({ canProceed: true, reason: undefined });
    const service = new PreflightService(prisma as never, budget as never, new WorkflowCatalogService(), quotes());
    const created = await service.preview('creative-pilot', intent());
    records[0].quoteSnapshot = { ...records[0].quoteSnapshot, basis: { stage: 'tampered' } };

    const checked = await service.check('creative-pilot', created.preflightId);

    expect(checked.requestCheck.status).toBe('incomplete');
    expect(checked.productionAdmission.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PREFLIGHT_RECORD_INVALID', path: 'preflightId' }),
    ]));
  });

  it('requires a fresh Preview when a confirmed promotion expires', async () => {
    process.env.VIDEO_FLOW_PRODUCTION_ACTORS = 'creative-pilot';
    jest.useFakeTimers().setSystemTime(new Date('2026-09-17T05:45:00.000Z'));
    const { prisma, budget } = dependencies({ canProceed: true, reason: undefined });
    const catalog = new PricingCatalog({
      confirmedPromotionIds: ['seedance-2.5-1080p-2026-08-14-2026-09-17'],
    });
    const service = new PreflightService(prisma as never, budget as never, new WorkflowCatalogService(), quotes(catalog));
    const request = intent();
    request.generation.resolution = '1080p';
    const created = await service.preview('creative-pilot', request);
    jest.setSystemTime(new Date('2026-09-17T06:01:00.000Z'));

    const checked = await service.check('creative-pilot', created.preflightId);

    expect(checked.requestCheck.status).toBe('incomplete');
    expect(checked.productionAdmission.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PREFLIGHT_QUOTE_EXPIRED', path: 'quote.expiresAt' }),
      expect.objectContaining({ code: 'PREFLIGHT_QUOTE_CHANGED', path: 'quote.quoteDigest' }),
    ]));
    expect(checked.quote.quoteDigest).toBe(created.quote.quoteDigest);
  });

  it('returns the frozen submission snapshot only for the owning actor and matching current digests', async () => {
    process.env.VIDEO_FLOW_PRODUCTION_ACTORS = 'creative-pilot';
    const { prisma, budget } = dependencies({ canProceed: true, reason: undefined });
    const service = new PreflightService(prisma as never, budget as never, new ReadyWorkflowCatalogFixture(), quotes());
    const created = await service.preview('creative-pilot', intent());

    await expect(service.prepareSubmission('creative-pilot', created.preflightId, {
      intentDigest: created.intentDigest,
      quoteDigest: created.quote.quoteDigest,
    })).resolves.toMatchObject({
      actorId: 'creative-pilot',
      preflightId: created.preflightId,
      intentDigest: created.intentDigest,
      quote: { quoteDigest: created.quote.quoteDigest, reserveCny: '6.111000' },
      providerFields: {},
    });
    await expect(service.prepareSubmission('other', created.preflightId, {
      intentDigest: created.intentDigest,
      quoteDigest: created.quote.quoteDigest,
    })).rejects.toMatchObject({ code: 'PREFLIGHT_REQUIRED' });
    await expect(service.prepareSubmission('creative-pilot', created.preflightId, {
      intentDigest: 'wrong', quoteDigest: created.quote.quoteDigest,
    })).rejects.toMatchObject({ code: 'PREFLIGHT_INTENT_MISMATCH' });
    await expect(service.prepareSubmission('creative-pilot', created.preflightId, {
      intentDigest: created.intentDigest, quoteDigest: 'wrong',
    })).rejects.toMatchObject({ code: 'PREFLIGHT_QUOTE_MISMATCH' });
  });

  it('rechecks expiration and current price against the transaction store before submission', async () => {
    process.env.VIDEO_FLOW_PRODUCTION_ACTORS = 'creative-pilot';
    jest.useFakeTimers().setSystemTime(new Date('2026-09-15T00:00:00.000Z'));
    const { prisma, budget } = dependencies({ canProceed: true, reason: undefined });
    const service = new PreflightService(prisma as never, budget as never, new WorkflowCatalogService(), quotes());
    const created = await service.preview('creative-pilot', intent());
    jest.setSystemTime(new Date('2026-09-15T01:00:00.000Z'));

    await expect(service.prepareSubmission('creative-pilot', created.preflightId, {
      intentDigest: created.intentDigest,
      quoteDigest: created.quote.quoteDigest,
    }, prisma as never)).rejects.toMatchObject({ code: 'PREFLIGHT_EXPIRED' });
  });

  it('refuses a self-consistent quote row when it no longer matches the original report', async () => {
    process.env.VIDEO_FLOW_PRODUCTION_ACTORS = 'creative-pilot';
    const { prisma, budget, records } = dependencies({ canProceed: true, reason: undefined });
    const service = new PreflightService(prisma as never, budget as never, new WorkflowCatalogService(), quotes());
    const created = await service.preview('creative-pilot', intent());
    const { quoteDigest: _old, ...changed } = {
      ...records[0].quoteSnapshot,
      basis: { ...records[0].quoteSnapshot.basis, ratePerMillion: '1.00' },
    };
    const changedDigest = workflowDigest(changed);
    records[0].quoteSnapshot = { ...changed, quoteDigest: changedDigest };
    records[0].quoteDigest = changedDigest;

    await expect(service.prepareSubmission('creative-pilot', created.preflightId, {
      intentDigest: created.intentDigest, quoteDigest: changedDigest,
    })).rejects.toMatchObject({ code: 'PREFLIGHT_RECORD_INVALID' });
  });
});
