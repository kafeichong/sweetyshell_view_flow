jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target,
  Controller: () => (target: unknown) => target,
  UseGuards: () => (target: unknown) => target,
  Patch: () => () => {},
  Post: () => () => {},
  Get: () => () => {},
  HttpCode: () => () => {},
  HttpStatus: { OK: 200 },
  Param: () => () => {},
  Body: () => () => {},
  Logger: class Logger { log() {} warn() {} error() {} },
  BadRequestException: class BadRequestException extends Error { status = 400; },
  NotFoundException: class NotFoundException extends Error { status = 404; },
  ConflictException: class ConflictException extends Error { status = 409; },
}));

import { V1TaskOperationsController } from './v1-task-operations.controller';

const prisma: any = {
  task: { findUnique: jest.fn() },
  executionAttempt: { findFirst: jest.fn(), update: jest.fn() },
  $transaction: jest.fn(),
};

const budget = {
  applyReviewDecisionInTransaction: jest.fn(),
};

const tasks = {
  resumeDelivery: jest.fn(),
};

const audit = {
  emit: jest.fn().mockResolvedValue({}),
};

const reports = {
  buildReport: jest.fn(),
};

const validBody = {
  decision: 'settle' as const,
  amountCny: '12.500000',
  evidenceRef: 'ark-bill-2026-09',
  operator: 'steven',
};

describe('V1TaskOperationsController budget review', () => {
  let controller: V1TaskOperationsController;

  beforeEach(() => {
    controller = new V1TaskOperationsController(
      prisma,
      budget as never,
      tasks as never,
      audit as never,
      reports as never,
    );
    prisma.task.findUnique.mockReset();
    prisma.executionAttempt.findFirst.mockReset();
    prisma.executionAttempt.update.mockReset();
    prisma.$transaction.mockReset();
    budget.applyReviewDecisionInTransaction.mockReset();

    tasks.resumeDelivery.mockReset();
    audit.emit.mockReset();
    audit.emit.mockResolvedValue({});
    reports.buildReport.mockReset();
    prisma.task.findUnique.mockResolvedValue({ id: 'task-1' });
    prisma.executionAttempt.findFirst.mockResolvedValue({ id: 'attempt-1' });
    prisma.executionAttempt.update.mockResolvedValue({ id: 'attempt-1' });
    prisma.$transaction.mockImplementation(async (callback: any) => callback(prisma));
    budget.applyReviewDecisionInTransaction.mockResolvedValue({
      state: 'settled',
      settledCny: '12.500000',
      reviewedAt: new Date('2026-09-12T00:00:00Z'),
    });
  });

  it('records the operator declaration and evidence with the decision', async () => {
    const result = await controller.reviewBudget('task-1', validBody);

    expect(budget.applyReviewDecisionInTransaction).toHaveBeenCalledWith(
      prisma,
      'task-1',
      {
        decision: 'settle',
        amountCny: '12.500000',
        evidenceRef: 'ark-bill-2026-09',
        operator: 'steven',
      },
    );
    expect(result).toMatchObject({
      taskId: 'task-1',
      decision: 'settle',
      reservationState: 'settled',
      settledCny: '12.500000',
      evidenceRef: 'ark-bill-2026-09',
      operator: 'steven',
      // 明确标注这是声明值，不能被当成 token 识别出的员工身份。
      operatorIsDeclaredClaim: true,
    });
  });

  it('updates the billed amount on the latest attempt when settling', async () => {
    await controller.reviewBudget('task-1', validBody);

    expect(prisma.executionAttempt.update).toHaveBeenCalledWith({
      where: { id: 'attempt-1' },
      data: { billedCostCny: 12.5, costStatus: 'billed' },
    });
    // 额度复核同样要留操作者与依据。
    expect(audit.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'budget_reviewed',
        taskId: 'task-1',
        operator: 'steven',
        evidenceRef: 'ark-bill-2026-09',
        operatorIsDeclaredClaim: true,
      }),
    );
  });

  it('releases without claiming a billed amount', async () => {
    budget.applyReviewDecisionInTransaction.mockResolvedValue({
      state: 'released',
      settledCny: null,
      reviewedAt: new Date('2026-09-12T00:00:00Z'),
    });

    const result = await controller.reviewBudget('task-1', {
      decision: 'release',
      evidenceRef: 'provider-trace-42',
      operator: 'steven',
    });

    expect(result.reservationState).toBe('released');
    expect(result.settledCny).toBeNull();
    expect(prisma.executionAttempt.update).not.toHaveBeenCalled();
  });

  it('rejects settle decisions without a valid amount', async () => {
    await expect(
      controller.reviewBudget('task-1', { ...validBody, amountCny: undefined }),
    ).rejects.toThrow('amountCny must be a positive decimal with at most 6 places');

    await expect(
      controller.reviewBudget('task-1', { ...validBody, amountCny: '-1' }),
    ).rejects.toThrow('amountCny must be a positive decimal with at most 6 places');

    await expect(
      controller.reviewBudget('task-1', { ...validBody, amountCny: '1e3' }),
    ).rejects.toThrow('amountCny must be a positive decimal with at most 6 places');

    expect(budget.applyReviewDecisionInTransaction).not.toHaveBeenCalled();
  });

  it('rejects an amount on release decisions', async () => {
    await expect(
      controller.reviewBudget('task-1', {
        decision: 'release',
        amountCny: '5.000000',
        evidenceRef: 'ref',
        operator: 'steven',
      }),
    ).rejects.toThrow('amountCny is only allowed for settle');
  });

  it('requires a decision, evidence and operator', async () => {
    await expect(
      controller.reviewBudget('task-1', { ...validBody, decision: 'ignore' as never }),
    ).rejects.toThrow('decision must be settle or release');

    await expect(
      controller.reviewBudget('task-1', { ...validBody, evidenceRef: '   ' }),
    ).rejects.toThrow('evidenceRef is required');

    await expect(
      controller.reviewBudget('task-1', { ...validBody, operator: '' }),
    ).rejects.toThrow('operator is required');
  });

  it('rejects reviews for unknown tasks', async () => {
    prisma.task.findUnique.mockResolvedValue(null);

    await expect(controller.reviewBudget('missing', validBody)).rejects.toThrow(
      'Task not found',
    );
    expect(budget.applyReviewDecisionInTransaction).not.toHaveBeenCalled();
  });

  describe('task report', () => {
    it('returns the read-only report assembled by the report service', async () => {
      reports.buildReport.mockResolvedValue({ task: { id: 'task-1' }, evidence: { sources: [] } });

      const report = await controller.taskReport('task-1');

      expect(reports.buildReport).toHaveBeenCalledWith('task-1');
      expect(report.task.id).toBe('task-1');
    });
  });

  describe('resume-delivery', () => {
    const resumeBody = {
      reason: 'worker crashed mid-archiving',
      operator: 'steven',
      evidenceRef: 'incident-2026-09-12',
    };

    it('resumes delivery through the task CAS without creating provider work', async () => {
      tasks.resumeDelivery.mockResolvedValue({
        taskId: 'task-1',
        deliveryStatus: 'archiving',
        status: 'archiving',
      });

      const result = await controller.resumeDelivery('task-1', resumeBody);

      expect(tasks.resumeDelivery).toHaveBeenCalledWith('task-1');
      expect(result).toMatchObject({
        taskId: 'task-1',
        deliveryStatus: 'archiving',
        reason: 'worker crashed mid-archiving',
        evidenceRef: 'incident-2026-09-12',
        operator: 'steven',
        operatorIsDeclaredClaim: true,
      });
    });

    it('requires a reason, operator and evidence reference', async () => {
      await expect(
        controller.resumeDelivery('task-1', { ...resumeBody, reason: '  ' }),
      ).rejects.toThrow('reason is required');
      await expect(
        controller.resumeDelivery('task-1', { ...resumeBody, operator: '' }),
      ).rejects.toThrow('operator is required');
      await expect(
        controller.resumeDelivery('task-1', { ...resumeBody, evidenceRef: '' }),
      ).rejects.toThrow('evidenceRef is required');

      expect(tasks.resumeDelivery).not.toHaveBeenCalled();
    });

    it('records who resumed delivery and the before/after state', async () => {
      prisma.task.findUnique.mockResolvedValue({ deliveryStatus: 'failed', status: 'failed' });
      tasks.resumeDelivery.mockResolvedValue({
        taskId: 'task-1',
        deliveryStatus: 'archiving',
        status: 'archiving',
      });

      await controller.resumeDelivery('task-1', resumeBody);

      expect(audit.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'delivery_resumed',
          level: 'warning',
          taskId: 'task-1',
          operator: 'steven',
          evidenceRef: 'incident-2026-09-12',
          before: { deliveryStatus: 'failed', status: 'failed' },
          after: expect.objectContaining({ deliveryStatus: 'archiving' }),
          // 管理员共享 token 不能假装识别出个人：声明值必须标注。
          operatorIsDeclaredClaim: true,
        }),
      );
    });

    it('propagates refusals for tasks that are not resumable', async () => {
      tasks.resumeDelivery.mockRejectedValue(
        Object.assign(new Error('PROVIDER_SUCCESS_REQUIRED'), { status: 409 }),
      );

      await expect(controller.resumeDelivery('task-1', resumeBody)).rejects.toMatchObject({
        status: 409,
      });
    });
  });
});
