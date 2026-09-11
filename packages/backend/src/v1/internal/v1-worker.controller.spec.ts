jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target,
  Controller: () => (target: unknown) => target,
  UseGuards: () => (target: unknown) => target,
  Patch: () => () => {},
  Get: () => () => {},
  Post: () => () => {},
  Param: () => () => {},
  Body: () => () => {},
  NotFoundException: class NotFoundException extends Error { status = 404; },
}));
jest.mock('ali-oss', () => class OSS {});

import { V1WorkerController } from './v1-worker.controller';

describe('V1WorkerController output ownership', () => {
  it('copies task actor ownership and marks a worker-uploaded output delivered', async () => {
    const executions = {};
    const tasks = {
      findOne: jest.fn().mockResolvedValue({
        id: 'task-1',
        actorId: 'actor-a',
        createdBy: 'actor-a',
      }),
    };
    const assets = {
      registerOutput: jest.fn().mockResolvedValue({ id: 'asset-output' }),
    };
    const presign = {};
    const controller = new V1WorkerController(
      executions as never,
      tasks as never,
      assets as never,
      presign as never,
    );

    await controller.registerAsset({
      taskId: 'task-1',
      attemptId: 'attempt-1',
      objectKey: 'videos/output.mp4',
      bucket: 'bucket',
      mediaType: 'video',
      mimeType: 'video/mp4',
      sizeBytes: 12,
    });

    expect(assets.registerOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'actor-a',
        taskId: 'task-1',
        inspectionStatus: 'uploaded',
      }),
    );
  });

  it('rejects output registration for an unknown task', async () => {
    const tasks = { findOne: jest.fn().mockResolvedValue(null) };
    const assets = { registerOutput: jest.fn() };
    const controller = new V1WorkerController(
      {} as never,
      tasks as never,
      assets as never,
      {} as never,
    );

    await expect(
      controller.registerAsset({
        taskId: 'missing',
        objectKey: 'videos/output.mp4',
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(assets.registerOutput).not.toHaveBeenCalled();
  });
});
