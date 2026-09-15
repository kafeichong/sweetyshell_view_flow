jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target,
  BadRequestException: class BadRequestException extends Error { status = 400; },
  ConflictException: class ConflictException extends Error { status = 409; },
  NotFoundException: class NotFoundException extends Error { status = 404; },
}));

import { TasksService } from './tasks.service';

describe('TasksService contract', () => {
  const prisma = {
    task: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    executionAttempt: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  let service: TasksService;
  const budget = { releaseInTransaction: jest.fn() };

  beforeEach(() => {
    service = new TasksService(prisma as never, budget as never);
    prisma.task.create.mockReset();
    prisma.task.findMany.mockReset();
    prisma.task.findUnique.mockReset();
    prisma.task.update.mockReset();
    prisma.executionAttempt.findUnique.mockReset();
    prisma.executionAttempt.update.mockReset();
    prisma.$transaction.mockReset();
    budget.releaseInTransaction.mockReset();
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

  it('Attempt 更新会持久化实际模型和生命周期时间', async () => {
    const startedAt = new Date('2026-09-10T10:00:00.000Z');
    const finishedAt = new Date('2026-09-10T10:03:00.000Z');
    prisma.executionAttempt.findUnique.mockResolvedValue({
      taskId: 'task-1',
      status: 'running',
    });
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

  it('不带 attemptId 但带 taskStatus 的更新会持久化 taskStatus', async () => {
    prisma.task.update.mockResolvedValue({ id: 'task-1' });

    await service.update('task-1', {
      taskStatus: 'archiving',
    } as any);

    expect(prisma.task.update).toHaveBeenCalledWith({
      where: { id: 'task-1' },
      data: { taskStatus: 'archiving' },
    });
    expect(prisma.executionAttempt.findUnique).not.toHaveBeenCalled();
  });

  it('attemptId 关联的 taskId 与路径不符时拒绝写入', async () => {
    prisma.executionAttempt.findUnique.mockResolvedValue({
      taskId: 'other-task',
      status: 'running',
    });

    await expect(
      service.update('task-1', {
        attemptId: 'attempt-1',
        attemptStatus: 'completed',
      }),
    ).rejects.toThrow('ATTEMPT_TASK_MISMATCH');

    expect(prisma.task.update).not.toHaveBeenCalled();
    expect(prisma.executionAttempt.update).not.toHaveBeenCalled();
  });

  it('拒绝把已提交任务非法重置为 pending', async () => {
    prisma.executionAttempt.findUnique.mockResolvedValue({
      taskId: 'task-1',
      status: 'running',
    });
    prisma.task.findUnique.mockResolvedValue({ status: 'submitted' });

    await expect(
      service.update('task-1', {
        status: 'pending',
        taskStatus: 'pending',
        attemptId: 'attempt-1',
      }),
    ).rejects.toThrow('CANNOT_RESET_TASK_TO_PENDING');

    expect(prisma.task.update).not.toHaveBeenCalled();
    expect(prisma.executionAttempt.update).not.toHaveBeenCalled();
  });

  it('允许 worker 合法 abandon 路径把任务放回 pending', async () => {
    prisma.executionAttempt.findUnique.mockResolvedValue({
      taskId: 'task-1',
      status: 'pending',
    });
    prisma.task.findUnique.mockResolvedValue({ status: 'submitted' });
    prisma.task.update.mockResolvedValue({ id: 'task-1', status: 'pending' });
    prisma.executionAttempt.update.mockResolvedValue({ id: 'attempt-1' });

    await service.update('task-1', {
      status: 'pending',
      taskStatus: 'pending',
      attemptId: 'attempt-1',
      attemptStatus: 'failed',
      failureCode: 'ABANDONED_BEFORE_SUBMIT',
    } as any);

    expect(prisma.task.update).toHaveBeenCalledWith({
      where: { id: 'task-1' },
      data: expect.objectContaining({ status: 'pending', taskStatus: 'pending' }),
    });
    expect(prisma.executionAttempt.update).toHaveBeenCalledWith({
      where: { id: 'attempt-1' },
      data: expect.objectContaining({ status: 'failed', failureCode: 'ABANDONED_BEFORE_SUBMIT' }),
    });
  });

  it('编译失败且 Provider 未被调用时释放预占', async () => {
    prisma.executionAttempt.findUnique.mockResolvedValue({
      taskId: 'task-1', status: 'pending', providerTaskId: null,
    });
    prisma.task.update.mockResolvedValue({ id: 'task-1', status: 'failed' });
    prisma.executionAttempt.update.mockResolvedValue({ id: 'attempt-1', status: 'failed' });

    await service.update('task-1', {
      status: 'failed', taskStatus: 'failed', attemptId: 'attempt-1', attemptStatus: 'failed',
      failureType: 'invalid_input', failureCode: 'EXECUTION_PLAN_COMPILE_FAILED',
    });

    expect(budget.releaseInTransaction).toHaveBeenCalledWith(
      prisma, 'task-1', 'EXECUTION_PLAN_COMPILE_FAILED',
    );
  });

  it('按 actor 与执行槽返回仍锁定的最新 Task，已交付槽返回空', async () => {
    prisma.task.findMany.mockResolvedValueOnce([
      { id: 'task-2', clientDeliveryStatus: 'pending', deliveryStatus: 'ready', executionAttempts: [{ status: 'completed' }] },
    ]);
    await expect(service.findCurrentForSlot('actor-1', 'slot-1')).resolves.toMatchObject({ id: 'task-2' });
    expect(prisma.task.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { actorId: 'actor-1', executionSlotId: 'slot-1' },
      orderBy: { slotSequence: 'desc' }, take: 1,
    }));

    prisma.task.findMany.mockResolvedValueOnce([
      { id: 'task-2', clientDeliveryStatus: 'delivered', deliveryStatus: 'ready', executionAttempts: [{ status: 'completed' }] },
    ]);
    await expect(service.findCurrentForSlot('actor-1', 'slot-1')).resolves.toBeNull();
  });

  it('仅允许本人对已归档就绪 Task 幂等确认客户端交付', async () => {
    prisma.task.updateMany.mockResolvedValueOnce({ count: 1 });
    await expect(service.confirmClientDelivery('task-1', 'actor-1')).resolves.toMatchObject({
      taskId: 'task-1', clientDeliveryStatus: 'delivered', applied: true,
    });
    expect(prisma.task.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'task-1', actorId: 'actor-1', deliveryStatus: 'ready' }),
      data: expect.objectContaining({ clientDeliveryStatus: 'delivered', clientDeliveredAt: expect.any(Date) }),
    }));

    prisma.task.updateMany.mockResolvedValueOnce({ count: 0 });
    prisma.task.findUnique.mockResolvedValueOnce({ id: 'task-1', actorId: 'actor-1', deliveryStatus: 'ready', clientDeliveryStatus: 'delivered' });
    await expect(service.confirmClientDelivery('task-1', 'actor-1')).resolves.toMatchObject({ applied: false });
  });

  it('拒绝越权或尚未归档就绪的客户端交付确认', async () => {
    prisma.task.updateMany.mockResolvedValue({ count: 0 });
    prisma.task.findUnique.mockResolvedValueOnce(null);
    await expect(service.confirmClientDelivery('task-1', 'other')).rejects.toMatchObject({ status: 404 });

    prisma.task.findUnique.mockResolvedValueOnce({ id: 'task-1', actorId: 'actor-1', deliveryStatus: 'archiving', clientDeliveryStatus: 'pending' });
    await expect(service.confirmClientDelivery('task-1', 'actor-1')).rejects.toMatchObject({ status: 409 });
  });

  describe('delivery transitions', () => {
    beforeEach(() => {
      prisma.task.updateMany.mockReset();
      prisma.task.findUnique.mockReset();
    });

    it('completes delivery only from the archiving state', async () => {
      prisma.task.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.completeDelivery(
        'task-1',
        'videos/task-1/attempt-1/result.mp4',
      );

      expect(prisma.task.updateMany).toHaveBeenCalledWith({
        where: { id: 'task-1', deliveryStatus: 'archiving' },
        data: expect.objectContaining({
          status: 'completed',
          taskStatus: 'completed',
          deliveryStatus: 'ready',
          videoUrl: 'videos/task-1/attempt-1/result.mp4',
        }),
      });
      expect(result).toEqual({ deliveryStatus: 'ready', applied: true });
    });

    it('treats a repeated ready delivery as idempotent', async () => {
      prisma.task.updateMany.mockResolvedValue({ count: 0 });
      prisma.task.findUnique.mockResolvedValue({
        deliveryStatus: 'ready',
        videoUrl: 'videos/task-1/attempt-1/result.mp4',
      });

      const result = await service.completeDelivery(
        'task-1',
        'videos/task-1/attempt-1/result.mp4',
      );

      expect(result).toEqual({ deliveryStatus: 'ready', applied: false });
    });

    it('refuses to mark a task ready when its delivery is not archiving', async () => {
      prisma.task.updateMany.mockResolvedValue({ count: 0 });
      prisma.task.findUnique.mockResolvedValue({
        deliveryStatus: 'not_started',
        videoUrl: null,
      });

      // CAS 失败且不是幂等重放：说明有人越过了 Provider 结算直接要求交付。
      await expect(
        service.completeDelivery('task-1', 'videos/task-1/attempt-1/result.mp4'),
      ).rejects.toThrow('DELIVERY_NOT_APPLICABLE');
    });

    it('records the failing stage so users can tell archiving apart from generating', async () => {
      prisma.task.updateMany.mockResolvedValue({ count: 1 });

      await service.failDelivery('task-1', 'ARTIFACT_UPLOAD_FAILED', 'upload');

      expect(prisma.task.updateMany).toHaveBeenCalledWith({
        where: { id: 'task-1', deliveryStatus: 'archiving' },
        data: expect.objectContaining({
          status: 'failed',
          taskStatus: 'failed',
          deliveryStatus: 'failed',
          errorMsg: 'upload:ARTIFACT_UPLOAD_FAILED',
        }),
      });
    });

    it('keeps a delivery failure idempotent for the same stage error', async () => {
      prisma.task.updateMany.mockResolvedValue({ count: 0 });
      prisma.task.findUnique.mockResolvedValue({
        deliveryStatus: 'failed',
        errorMsg: 'upload:ARTIFACT_UPLOAD_FAILED',
      });

      const result = await service.failDelivery(
        'task-1',
        'ARTIFACT_UPLOAD_FAILED',
        'upload',
      );

      expect(result).toEqual({ deliveryStatus: 'failed', applied: false });
    });

    it('resumes only provider-succeeded tasks whose delivery already failed', async () => {
      prisma.task.findUnique.mockResolvedValue({
        id: 'task-1',
        status: 'failed',
        deliveryStatus: 'failed',
        executionAttempts: [{ status: 'completed' }],
      });
      prisma.task.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.resumeDelivery('task-1');

      expect(prisma.task.updateMany).toHaveBeenCalledWith({
        where: { id: 'task-1', deliveryStatus: 'failed' },
        data: expect.objectContaining({
          status: 'archiving',
          taskStatus: 'in_progress',
          deliveryStatus: 'archiving',
          errorMsg: null,
        }),
      });
      expect(result).toMatchObject({ taskId: 'task-1', deliveryStatus: 'archiving' });
    });

    it('refuses to resume a task whose provider run never succeeded', async () => {
      prisma.task.findUnique.mockResolvedValue({
        id: 'task-1',
        status: 'failed',
        deliveryStatus: 'failed',
        executionAttempts: [{ status: 'failed' }],
      });

      // 没有 Provider 产物可搬运，恢复归档只会制造替代品。
      await expect(service.resumeDelivery('task-1')).rejects.toThrow(
        'PROVIDER_SUCCESS_REQUIRED',
      );
      expect(prisma.task.updateMany).not.toHaveBeenCalled();
    });

    it('refuses to resume a delivery that is still archiving', async () => {
      prisma.task.findUnique.mockResolvedValue({
        id: 'task-1',
        status: 'archiving',
        deliveryStatus: 'archiving',
        executionAttempts: [{ status: 'completed' }],
      });
      prisma.task.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.resumeDelivery('task-1')).rejects.toThrow(
        'DELIVERY_NOT_RESUMABLE',
      );
    });
  });
});
