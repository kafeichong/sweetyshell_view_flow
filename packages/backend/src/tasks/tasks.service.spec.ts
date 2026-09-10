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
  };

  let service: TasksService;

  beforeEach(() => {
    service = new TasksService(prisma as never);
    prisma.task.create.mockReset();
    prisma.task.findMany.mockReset();
    prisma.task.findUnique.mockReset();
    prisma.task.update.mockReset();
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
});
