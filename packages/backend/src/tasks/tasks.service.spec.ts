jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target,
}));

import { TasksService } from './tasks.service';

describe('TasksService contract', () => {
  const prisma = {
    task: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    executionAttempt: {
      update: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  let service: TasksService;

  beforeEach(() => {
    service = new TasksService(prisma as never);
    prisma.task.create.mockReset();
    prisma.task.findMany.mockReset();
    prisma.task.findUnique.mockReset();
    prisma.task.update.mockReset();
    prisma.executionAttempt.update.mockReset();
    prisma.$transaction.mockReset();
    prisma.$transaction.mockImplementation(async (callback: any) => callback(prisma));
  });

  it('创建任务默认 pending', async () => {
    const createdAt = new Date('2026-09-10T00:00:00.000Z');
    prisma.task.create.mockResolvedValue({ id: '1', createdAt });

    await service.create({
      createdBy: 'zhangsan',
      prompt: 'test prompt',
      imageUrl: 'https://example.com/input.png',
    });

    expect(prisma.task.create).toHaveBeenCalledWith({
      data: {
        createdBy: 'zhangsan',
        prompt: 'test prompt',
        imageUrl: 'https://example.com/input.png',
        status: 'pending',
      },
    });
  });

  it('按状态/创建人查询任务列表', async () => {
    prisma.task.findMany.mockResolvedValue([]);

    await service.findAll({ status: 'pending', createdBy: 'zhangsan' });

    expect(prisma.task.findMany).toHaveBeenCalledWith({
      where: { status: 'pending', createdBy: 'zhangsan' },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('查询单个任务按 ID 读取', async () => {
    prisma.task.findUnique.mockResolvedValue({ id: 'task-1', status: 'completed' });

    await service.findOne('task-1');

    expect(prisma.task.findUnique).toHaveBeenCalledWith({
      where: { id: 'task-1' },
    });
  });

  // 安全回归：Preview 任务必须落成 status='preview'，而 Worker 的 claim 只领
  // status='pending'，因此这条记录在结构上不可能被执行或计费。
  it('createPreview 落库为 preview 状态，不可被 Worker 领取', async () => {
    prisma.task.create.mockResolvedValue({ id: 'task-preview', status: 'preview' });

    await service.createPreview({
      actorId: 'actor-1',
      clientRequestId: 'request-1',
      capability: 'TEXT_TO_VIDEO',
      workflowName: 'seedance',
      requestSnapshot: { capability: 'TEXT_TO_VIDEO' },
      prompt: 'hello',
    });

    expect(prisma.task.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'actor-1',
        clientRequestId: 'request-1',
        status: 'preview',
      }),
    });

    const payload = prisma.task.create.mock.calls[0][0].data;
    expect(payload.status).not.toBe('pending');
    // taskStatus 保持 null：安全闸门只依赖 status，不依赖枚举新值。
    expect(payload.taskStatus).toBeUndefined();
  });

  it('Attempt 更新会持久化实际模型和生命周期时间', async () => {
    const startedAt = new Date('2026-09-10T10:00:00.000Z');
    const finishedAt = new Date('2026-09-10T10:03:00.000Z');
    prisma.task.update.mockResolvedValue({ id: 'task-1' });
    prisma.executionAttempt.update.mockResolvedValue({ id: 'attempt-1' });

    await service.update('task-1', {
      status: 'completed',
      attemptId: 'attempt-1',
      attemptStatus: 'completed',
      attemptModel: 'doubao-seedance-2-5-260628',
      startedAt,
      finishedAt,
    });

    expect(prisma.executionAttempt.update).toHaveBeenCalledWith({
      where: { id: 'attempt-1' },
      data: expect.objectContaining({
        status: 'completed',
        model: 'doubao-seedance-2-5-260628',
        startedAt,
        finishedAt,
      }),
    });
    expect(prisma.task.update).toHaveBeenCalledWith({
      where: { id: 'task-1' },
      data: { status: 'completed' },
    });
  });
});
