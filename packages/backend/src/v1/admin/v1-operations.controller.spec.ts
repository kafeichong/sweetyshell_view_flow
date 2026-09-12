jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target,
  Controller: () => (target: unknown) => target,
  UseGuards: () => (target: unknown) => target,
  Get: () => () => {},
  Patch: () => () => {},
  Body: () => () => {},
  BadRequestException: class BadRequestException extends Error { status = 400; },
}));

import { V1OperationsController } from './v1-operations.controller';

const prisma: any = {
  task: { findFirst: jest.fn(), count: jest.fn() },
  taskBudgetReservation: { count: jest.fn() },
  productionGate: { findUnique: jest.fn(), upsert: jest.fn() },
  $queryRaw: jest.fn(),
};

const audit = { emit: jest.fn().mockResolvedValue({}) };

describe('V1OperationsController', () => {
  let controller: V1OperationsController;

  beforeEach(() => {
    controller = new V1OperationsController(prisma, audit as never);
    prisma.task.findFirst.mockReset();
    prisma.task.count.mockReset();
    prisma.taskBudgetReservation.count.mockReset();
    prisma.productionGate.findUnique.mockReset();
    prisma.productionGate.upsert.mockReset();
    prisma.$queryRaw.mockReset();
    audit.emit.mockReset();
    audit.emit.mockResolvedValue({});

    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    prisma.task.findFirst.mockResolvedValue(null);
    prisma.task.count.mockResolvedValue(0);
    prisma.taskBudgetReservation.count.mockResolvedValue(0);
    prisma.productionGate.findUnique.mockResolvedValue({
      paused: false,
      reason: null,
      updatedAt: new Date('2026-09-13T00:00:00Z'),
    });
  });

  it('reports queue age and backlog counts', async () => {
    prisma.task.findFirst.mockResolvedValue({
      id: 'task-old',
      createdAt: new Date(Date.now() - 300_000),
    });
    prisma.task.count
      .mockResolvedValueOnce(2)   // pending
      .mockResolvedValueOnce(1);  // delivery failed
    prisma.taskBudgetReservation.count.mockResolvedValue(1);

    const health = await controller.health();

    expect(health.status).toBe('ok');
    expect(health.database.status).toBe('ok');
    expect(health.queue).toMatchObject({
      pendingCount: 2,
      oldestPendingTaskId: 'task-old',
      pendingStalled: true,
    });
    expect(health.backlog).toEqual({
      requiresReview: 1,
      deliveryFailed: 1,
      costUnverified: 1,
    });
  });

  it('still answers when the database is unreachable', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const health = await controller.health();

    // 库不通时必须仍然返回结构，监控才能区分"服务挂了"和"库连不上"。
    expect(health.status).toBe('degraded');
    expect(health.database.status).toBe('unavailable');
    expect(health.queue).toBeNull();
  });

  it('pauses production without demanding a reason', async () => {
    prisma.productionGate.upsert.mockResolvedValue({
      paused: true,
      reason: 'monitor: disk above 90%',
      updatedAt: new Date('2026-09-13T01:00:00Z'),
    });

    const result = await controller.setProductionGate({
      paused: true,
      reason: 'monitor: disk above 90%',
    });

    expect(result.paused).toBe(true);
    expect(audit.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'production_gate_paused',
        level: 'warning',
        code: 'PAUSE',
        before: expect.objectContaining({ paused: false, reason: null }),
        after: { paused: true, reason: 'monitor: disk above 90%' },
      }),
    );
  });

  it('requires reason, operator and evidence to resume production', async () => {
    await expect(
      controller.setProductionGate({ paused: false }),
    ).rejects.toThrow('reason is required when resuming production');

    await expect(
      controller.setProductionGate({ paused: false, reason: 'checked' }),
    ).rejects.toThrow('operator is required when resuming production');

    await expect(
      controller.setProductionGate({ paused: false, reason: 'checked', operator: 'steven' }),
    ).rejects.toThrow('evidenceRef is required when resuming production');

    expect(prisma.productionGate.upsert).not.toHaveBeenCalled();
  });

  it('resumes with a declared operator and records the audit trail', async () => {
    prisma.productionGate.upsert.mockResolvedValue({
      paused: false,
      reason: 'provider quota confirmed',
      updatedAt: new Date('2026-09-13T02:00:00Z'),
    });

    const result = await controller.setProductionGate({
      paused: false,
      reason: 'provider quota confirmed',
      operator: 'steven',
      evidenceRef: 'ticket-42',
    });

    expect(result).toMatchObject({ paused: false, operator: 'steven', operatorIsDeclaredClaim: true });
    expect(audit.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'production_gate_resumed',
        evidenceRef: 'ticket-42',
        operator: 'steven',
        operatorIsDeclaredClaim: true,
      }),
    );
  });

  it('rejects non-boolean pause values', async () => {
    await expect(
      controller.setProductionGate({ paused: 'yes' as never }),
    ).rejects.toThrow('paused must be a boolean');
  });
});
