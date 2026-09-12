jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target,
  NotFoundException: class NotFoundException extends Error { status = 404; },
}));

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TaskReportService } from './task-report.service';

const taskRecord = (overrides: Record<string, unknown> = {}) => ({
  id: 'task-1',
  actorId: 'actor-a',
  createdBy: 'actor-a',
  status: 'failed',
  taskStatus: 'failed',
  deliveryStatus: 'failed',
  createdAt: new Date('2026-09-13T00:00:00Z'),
  updatedAt: new Date('2026-09-13T00:05:00Z'),
  completedAt: new Date('2026-09-13T00:05:00Z'),
  errorMsg: 'upload:ARTIFACT_UPLOAD_FAILED https://oss.test/x?Signature=secret',
  clientRequestId: 'intent-1',
  executionAttempts: [
    {
      id: 'attempt-1',
      attemptNo: 1,
      mode: 'production',
      provider: 'seedance',
      model: 'doubao-seedance-2-5-260628',
      status: 'completed',
      providerTaskId: 'provider-1',
      costStatus: 'usage_calculated',
      pricingVersion: 'seedance-token-v1',
      estimatedCostCny: null,
      usageCalculatedCostCny: 0.7,
      billedCostCny: null,
      failureCode: null,
      failureMessage: null,
      submittedAt: new Date('2026-09-13T00:01:00Z'),
      startedAt: new Date('2026-09-13T00:01:10Z'),
      finishedAt: new Date('2026-09-13T00:03:00Z'),
      updatedAt: new Date('2026-09-13T00:03:00Z'),
    },
  ],
  budgetReservation: {
    state: 'review',
    reservedCny: { toFixed: () => '2.000000' },
    settledCny: null,
    dayKey: '2026-09-13',
    monthKey: '2026-09',
    pricingVersion: 'seedance-token-v1',
    reviewDecision: null,
    reviewAmountCny: null,
    reviewEvidenceRef: null,
    reviewOperator: null,
    reviewedAt: null,
  },
  assets: [
    {
      id: 'asset-1',
      role: 'output',
      objectKey: 'videos/task-1/attempt-1/result.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 2048n,
      inspectionStatus: 'uploaded',
      createdAt: new Date('2026-09-13T00:04:00Z'),
    },
  ],
  ...overrides,
});

describe('TaskReportService', () => {
  const prisma: any = { task: { findUnique: jest.fn() } };
  let service: TaskReportService;
  const originalWorkerAuditDir = process.env.VIDEO_FLOW_WORKER_AUDIT_DIR;

  beforeEach(() => {
    service = new TaskReportService(prisma);
    prisma.task.findUnique.mockReset();
    delete process.env.VIDEO_FLOW_WORKER_AUDIT_DIR;
  });

  afterEach(() => {
    if (originalWorkerAuditDir === undefined) {
      delete process.env.VIDEO_FLOW_WORKER_AUDIT_DIR;
    } else {
      process.env.VIDEO_FLOW_WORKER_AUDIT_DIR = originalWorkerAuditDir;
    }
  });

  it('aggregates task, attempt, asset, budget and correlation records', async () => {
    prisma.task.findUnique.mockResolvedValue(taskRecord());

    const report = await service.buildReport('task-1');

    expect(report.task.id).toBe('task-1');
    expect(report.attempts).toHaveLength(1);
    expect(report.attempts[0]).toMatchObject({
      attemptId: 'attempt-1',
      providerTaskId: 'provider-1',
      status: 'completed',
    });
    expect(report.assets[0]).toMatchObject({
      objectKey: 'videos/task-1/attempt-1/result.mp4',
      sizeBytes: 2048,
    });
    expect(report.budget).toMatchObject({ state: 'review', reservedCny: '2.000000' });
    expect(report.correlation).toMatchObject({
      taskId: 'task-1',
      attemptIds: ['attempt-1'],
      providerTaskIds: ['provider-1'],
      objectKeys: ['videos/task-1/attempt-1/result.mp4'],
    });
  });

  it('never returns signed urls in free-form error text', async () => {
    prisma.task.findUnique.mockResolvedValue(taskRecord());

    const report = await service.buildReport('task-1');

    expect(JSON.stringify(report)).not.toContain('Signature');
    expect(report.lastError?.message).toContain('upload:ARTIFACT_UPLOAD_FAILED');
  });

  it('explains where evidence lives instead of claiming nothing happened', async () => {
    prisma.task.findUnique.mockResolvedValue(taskRecord());

    const report = await service.buildReport('task-1');
    const sources = report.evidence.sources;

    expect(sources.find((source) => source.source === 'database')).toMatchObject({
      available: true,
      records: { tasks: 1, attempts: 1, assets: 1, budgetReservations: 1 },
    });
    // 没有事件表不等于没有记录：未配置时明确说明原因。
    expect(sources.find((source) => source.source === 'worker-audit')).toMatchObject({
      available: false,
      reason: 'audit_dir_not_configured',
    });
  });

  it('reports missing worker evidence when the directory is absent', async () => {
    process.env.VIDEO_FLOW_WORKER_AUDIT_DIR = join(tmpdir(), 'video-flow-audit-does-not-exist');
    prisma.task.findUnique.mockResolvedValue(taskRecord());

    const report = await service.buildReport('task-1');

    expect(report.evidence.sources.find((source) => source.source === 'worker-audit')).toMatchObject({
      available: false,
      reason: 'evidence_missing',
    });
  });

  it('links matching worker events when the audit directory is readable', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'video-flow-audit-'));
    try {
      writeFileSync(
        join(directory, 'events-2026-09-13.jsonl'),
        [
          JSON.stringify({ at: '2026-09-13T00:04:00Z', event: 'artifact_upload_failed', taskId: 'task-1' }),
          JSON.stringify({ at: '2026-09-13T00:04:10Z', event: 'artifact_uploaded', taskId: 'task-other' }),
          'not-json',
        ].join('\n'),
      );
      process.env.VIDEO_FLOW_WORKER_AUDIT_DIR = directory;
      prisma.task.findUnique.mockResolvedValue(taskRecord());

      const report = await service.buildReport('task-1');

      expect(report.evidence.sources.find((source) => source.source === 'worker-audit')).toMatchObject({
        available: true,
        eventFiles: ['events-2026-09-13.jsonl'],
        matchingRecords: 1,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('surfaces declared operator claims from the budget review', async () => {
    prisma.task.findUnique.mockResolvedValue(
      taskRecord({
        budgetReservation: {
          ...taskRecord().budgetReservation,
          state: 'settled',
          reviewDecision: 'settle',
          reviewAmountCny: { toFixed: () => '3.500000' },
          reviewEvidenceRef: 'ark-bill-2026-09',
          reviewOperator: 'steven',
          reviewedAt: new Date('2026-09-13T00:10:00Z'),
        },
      }),
    );

    const report = await service.buildReport('task-1');

    expect(report.budget).toMatchObject({
      reviewOperator: 'steven',
      reviewEvidenceRef: 'ark-bill-2026-09',
      operatorIsDeclaredClaim: true,
    });
  });

  it('rejects unknown tasks without inventing a report', async () => {
    prisma.task.findUnique.mockResolvedValue(null);

    await expect(service.buildReport('missing')).rejects.toThrow('Task not found');
  });
});
