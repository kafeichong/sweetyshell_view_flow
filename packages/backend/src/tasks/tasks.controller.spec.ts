jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target,
  Controller: () => (target: unknown) => target,
  Get: () => () => {},
  Post: () => () => {},
  Patch: () => () => {},
  Param: () => () => {},
  Body: () => () => {},
  Query: () => () => {},
  UseGuards: () => () => {},
}));

import { TasksController } from './tasks.controller';

describe('TasksController contract', () => {
  const service = {
    create: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    findPending: jest.fn(),
  };

  const taskClaimService = {
    claimNext: jest.fn(),
    findRecoverable: jest.fn(),
  };

  let controller: TasksController;

  beforeEach(() => {
    controller = new TasksController(service as never, taskClaimService as never);
    service.create.mockReset();
    service.findAll.mockReset();
    service.findOne.mockReset();
    service.update.mockReset();
    service.findPending.mockReset();
    taskClaimService.claimNext.mockReset();
    taskClaimService.findRecoverable.mockReset();
  });

  it('更新 completed 时回写 completedAt', async () => {
    service.update.mockResolvedValue({ id: 'task-1', status: 'completed' });

    await controller.update('task-1', {
      status: 'completed',
      cost: 0.7,
    });

    const payload = service.update.mock.calls[0][1];
    expect(payload).toMatchObject({
      status: 'completed',
      cost: 0.7,
    });
    expect(payload.completedAt).toBeInstanceOf(Date);
  });

  it('按状态和创建人过滤查询', async () => {
    service.findAll.mockResolvedValue([]);

    await controller.findAll('pending', 'zhangsan');

    expect(service.findAll).toHaveBeenCalledWith({
      status: 'pending',
      createdBy: 'zhangsan',
    });
  });

  it('失败回写也应设置 completedAt', async () => {
    service.update.mockResolvedValue({ id: 'task-1', status: 'failed' });

    await controller.update('task-1', { status: 'failed' });

    expect(service.update).toHaveBeenCalledWith('task-1', {
      status: 'failed',
      completedAt: expect.any(Date),
    });
  });

  it('回写实际成本与成本状态', async () => {
    service.update.mockResolvedValue({ id: 'task-1', status: 'completed' });

    await controller.update('task-1', {
      status: 'completed',
      actualCostCny: 0.58,
      costStatus: 'usage_calculated',
    });

    expect(service.update).toHaveBeenCalledWith('task-1', {
      status: 'completed',
      actualCostCny: 0.58,
      costStatus: 'usage_calculated',
      completedAt: expect.any(Date),
    });
  });

  it('claim 接口透传 mode 与 workerId', async () => {
    taskClaimService.claimNext.mockResolvedValue({ id: 'task-1', status: 'submitted' });

    const body = { mode: 'comfyui' as const, workerId: 'worker-a' };
    const response = await controller.claim(body);

    expect(taskClaimService.claimNext).toHaveBeenCalledWith('worker-a', 'comfyui');
    expect(response).toMatchObject({ id: 'task-1' });
  });

  it('recover 接口返回可恢复任务列表', async () => {
    const payload = [{ id: 'task-1', status: 'running', taskStatus: 'in_progress' }];
    taskClaimService.findRecoverable.mockResolvedValue(payload);

    await expect(controller.recover()).resolves.toBe(payload);
    expect(taskClaimService.findRecoverable).toHaveBeenCalledTimes(1);
  });
});
