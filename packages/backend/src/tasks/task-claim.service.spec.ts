jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target,
}));

import { TaskClaimService } from './task-claim.service';

describe('TaskClaimService contract', () => {
  const prisma = {
    task: {
      findFirst: jest.fn(),
      updateMany: jest.fn(),
      findMany: jest.fn(),
    },
    executionAttempt: {
      findFirst: jest.fn(),
      create: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  let service: TaskClaimService;

  beforeEach(() => {
    service = new TaskClaimService(prisma as never);
    prisma.task.findFirst.mockReset();
    prisma.task.updateMany.mockReset();
    prisma.task.findMany.mockReset();
    prisma.executionAttempt.findFirst.mockReset();
    prisma.executionAttempt.create.mockReset();
    prisma.$transaction.mockReset();
  });

  it('claimNext 返回已写入 attempt 的任务', async () => {
    const candidate = {
      id: 'task-1',
      status: 'pending',
      taskStatus: null,
      workflowName: 'seedance-main',
      createdAt: new Date('2026-09-10T00:00:00.000Z'),
      updatedAt: new Date('2026-09-10T00:00:00.000Z'),
      createdBy: 'alice',
      prompt: 'test prompt',
    } as any;

    prisma.$transaction.mockImplementation(async (cb: any) => cb(prisma));
    prisma.task.findFirst.mockResolvedValue(candidate);
    prisma.task.updateMany.mockResolvedValue({ count: 1 });
    prisma.executionAttempt.findFirst.mockResolvedValue({ attemptNo: 1 });
    prisma.executionAttempt.create.mockResolvedValue({
      id: 'attempt-1',
      attemptNo: 2,
      status: 'pending',
      provider: 'seedance',
      model: null,
      submittedAt: new Date('2026-09-10T00:00:01.000Z'),
    });

    const result = await service.claimNext('worker-1', 'production');

    expect(prisma.task.findFirst).toHaveBeenCalledWith({
      where: {
        status: 'pending',
        OR: [{ taskStatus: null }, { taskStatus: 'pending' }],
      },
      orderBy: { createdAt: 'asc' },
    });
    expect(prisma.task.updateMany).toHaveBeenCalledWith({
      where: {
        id: candidate.id,
        status: 'pending',
        OR: [{ taskStatus: null }, { taskStatus: 'pending' }],
      },
      data: {
        status: 'submitted',
        taskStatus: 'in_progress',
        leaseOwner: 'worker-1',
        leaseExpiresAt: expect.any(Date),
        updatedAt: expect.any(Date),
      },
    });
    expect(prisma.executionAttempt.create).toHaveBeenCalledWith({
      data: {
        taskId: candidate.id,
        attemptNo: 2,
        mode: 'production',
        provider: 'seedance',
        status: 'pending',
        costStatus: 'unavailable',
      },
    });
    expect(result).toMatchObject({
      id: 'task-1',
      attemptId: 'attempt-1',
      attemptNo: 2,
      attemptStatus: 'pending',
      attemptProvider: 'seedance',
      attemptModel: null,
      attemptSubmittedAt: '2026-09-10T00:00:01.000Z',
    });
  });

  it('claimNext 找不到任务时返回 null', async () => {
    prisma.$transaction.mockImplementation(async (cb: any) => cb(prisma));
    prisma.task.findFirst.mockResolvedValue(null);
    prisma.task.updateMany.mockResolvedValue({ count: 0 });

    const result = await service.claimNext();

    expect(result).toBeNull();
  });

  it('findRecoverable 会携带最新 attempt 字段', async () => {
    prisma.task.findMany.mockResolvedValue([
      {
        id: 'task-r1',
        status: 'submitted',
        taskStatus: 'in_progress',
        executionAttempts: [
          {
            id: 'attempt-r1',
            attemptNo: 1,
            status: 'running',
            provider: 'seedance',
            model: 'doubao-seedance-2-5',
            submittedAt: new Date('2026-09-10T00:00:00.000Z'),
          },
        ],
      },
    ] as any);

    const result = await service.findRecoverable();

    expect(prisma.task.findMany).toHaveBeenCalledWith({
      where: {
        taskStatus: 'in_progress',
        status: {
          in: ['submitted', 'running'],
        },
      },
      orderBy: { createdAt: 'asc' },
      include: {
        executionAttempts: {
          orderBy: { attemptNo: 'desc' },
          take: 1,
        },
      },
    });
    expect(result[0]).toMatchObject({
      id: 'task-r1',
      attemptId: 'attempt-r1',
      attemptStatus: 'running',
      attemptProvider: 'seedance',
      attemptModel: 'doubao-seedance-2-5',
      attemptSubmittedAt: '2026-09-10T00:00:00.000Z',
    });
  });
});
