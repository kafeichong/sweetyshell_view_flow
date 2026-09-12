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
  BadRequestException: class BadRequestException extends Error { status = 400; },
  ConflictException: class ConflictException extends Error { status = 409; },
}));
jest.mock('ali-oss', () => class OSS {});

import { V1WorkerController } from './v1-worker.controller';

describe('V1WorkerController output ownership', () => {
  const buildController = (
    overrides: { executions?: unknown; tasks?: unknown; assets?: unknown } = {},
  ) =>
    new V1WorkerController(
      (overrides.executions ?? {}) as never,
      (overrides.tasks ?? {}) as never,
      (overrides.assets ?? {}) as never,
      {} as never,
    );

  it('lets the task decide ownership and reports idempotent registration', async () => {
    const assets = {
      registerOutputOnce: jest.fn().mockResolvedValue({
        asset: { id: 'asset-output', objectKey: 'videos/task-1/attempt-1/result.mp4' },
        deduplicated: true,
      }),
    };
    const controller = buildController({ assets });

    const result = await controller.registerAsset({
      taskId: 'task-1',
      attemptId: 'attempt-1',
      objectKey: 'videos/task-1/attempt-1/result.mp4',
      bucket: 'bucket',
      mediaType: 'video',
      mimeType: 'video/mp4',
      sizeBytes: 12,
    });

    // owner 不再由调用方传入：归属由 Task 决定，越权挂靠无从发生。
    expect(assets.registerOutputOnce).toHaveBeenCalledWith({
      taskId: 'task-1',
      attemptId: 'attempt-1',
      objectKey: 'videos/task-1/attempt-1/result.mp4',
      bucket: 'bucket',
      mediaType: 'video',
      mimeType: 'video/mp4',
      sizeBytes: 12,
    });
    expect(result).toEqual({
      assetId: 'asset-output',
      objectKey: 'videos/task-1/attempt-1/result.mp4',
      deduplicated: true,
    });
  });

  it('rejects output registration for an unknown task', async () => {
    const assets = {
      registerOutputOnce: jest
        .fn()
        .mockRejectedValue(Object.assign(new Error('Task not found'), { status: 404 })),
    };
    const controller = buildController({ assets });

    await expect(
      controller.registerAsset({
        taskId: 'missing',
        objectKey: 'videos/output.mp4',
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('confirms delivery only when the artifact is registered', async () => {
    const executions = {
      findAttemptTask: jest.fn().mockResolvedValue({ id: 'attempt-1', taskId: 'task-1' }),
    };
    const assets = { findOutputForAttempt: jest.fn().mockResolvedValue(null) };
    const tasks = { completeDelivery: jest.fn() };
    const controller = buildController({ executions, tasks, assets });

    // 没有登记产物就说交付成功，等于指向空气。
    await expect(
      controller.recordDelivery('attempt-1', {
        status: 'ready',
        objectKey: 'videos/task-1/attempt-1/result.mp4',
      }),
    ).rejects.toThrow('DELIVERY_ASSET_NOT_REGISTERED');

    expect(tasks.completeDelivery).not.toHaveBeenCalled();
  });

  it('completes delivery for a registered artifact', async () => {
    const executions = {
      findAttemptTask: jest.fn().mockResolvedValue({ id: 'attempt-1', taskId: 'task-1' }),
    };
    const assets = { findOutputForAttempt: jest.fn().mockResolvedValue({ id: 'asset-1' }) };
    const tasks = {
      completeDelivery: jest
        .fn()
        .mockResolvedValue({ deliveryStatus: 'ready', applied: true }),
    };
    const controller = buildController({ executions, tasks, assets });

    const result = await controller.recordDelivery('attempt-1', {
      status: 'ready',
      objectKey: 'videos/task-1/attempt-1/result.mp4',
    });

    expect(tasks.completeDelivery).toHaveBeenCalledWith(
      'task-1',
      'videos/task-1/attempt-1/result.mp4',
    );
    expect(result).toEqual({ deliveryStatus: 'ready', applied: true });
  });

  it('records staged delivery failures without touching provider evidence', async () => {
    const executions = {
      findAttemptTask: jest.fn().mockResolvedValue({ id: 'attempt-1', taskId: 'task-1' }),
    };
    const tasks = {
      failDelivery: jest.fn().mockResolvedValue({ deliveryStatus: 'failed', applied: true }),
    };
    const controller = buildController({ executions, tasks, assets: {} });

    await controller.recordDelivery('attempt-1', {
      status: 'failed',
      errorCode: 'ARTIFACT_UPLOAD_FAILED',
      stage: 'upload',
    });

    expect(tasks.failDelivery).toHaveBeenCalledWith(
      'task-1',
      'ARTIFACT_UPLOAD_FAILED',
      'upload',
    );
  });

  it('rejects unknown attempts', async () => {
    const executions = { findAttemptTask: jest.fn().mockResolvedValue(null) };
    const controller = buildController({ executions, tasks: {}, assets: {} });

    await expect(
      controller.recordDelivery('missing', { status: 'ready', objectKey: 'k' }),
    ).rejects.toThrow('Attempt not found');
  });
});
