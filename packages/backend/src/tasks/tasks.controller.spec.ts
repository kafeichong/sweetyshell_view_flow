jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target,
  Controller: () => (target: unknown) => target,
  Get: () => () => {},
  Post: () => () => {},
  Patch: () => () => {},
  Param: () => () => {},
  Body: () => () => {},
  Query: () => () => {},
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

  let controller: TasksController;

  beforeEach(() => {
    controller = new TasksController(service as never);
    service.create.mockReset();
    service.findAll.mockReset();
    service.findOne.mockReset();
    service.update.mockReset();
    service.findPending.mockReset();
  });

  it('更新 completed 时回写 completedAt', async () => {
    service.update.mockResolvedValue({ id: 'task-1', status: 'completed' });

    await controller.update('task-1', {
      status: 'completed',
      videoUrl: 'https://oss.local/videos/task-1.mp4',
      errorMsg: 'old field',
      cost: 0.7,
    });

    const payload = service.update.mock.calls[0][1];
    expect(payload).toMatchObject({
      status: 'completed',
      videoUrl: 'https://oss.local/videos/task-1.mp4',
      errorMsg: 'old field',
      cost: 0.7,
    });
    expect(payload.completedAt).toBeInstanceOf(Date);
  });

  it('按状态和创建人查询旧字段过滤', async () => {
    service.findAll.mockResolvedValue([]);

    await controller.findAll('pending', 'zhangsan');

    expect(service.findAll).toHaveBeenCalledWith({
      status: 'pending',
      createdBy: 'zhangsan',
    });
  });

  it('失败回写保留旧错误字段名 errorMsg', async () => {
    service.update.mockResolvedValue({ id: 'task-1', status: 'failed' });

    await controller.update('task-1', {
      status: 'failed',
      errorMsg: 'provider failed',
    });

    expect(service.update).toHaveBeenCalledWith('task-1', {
      status: 'failed',
      errorMsg: 'provider failed',
      completedAt: expect.any(Date),
    });
  });
});
