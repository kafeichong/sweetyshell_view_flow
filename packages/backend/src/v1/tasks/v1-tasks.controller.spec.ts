jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target,
  createParamDecorator: () => () => () => {},
  Controller: () => (target: unknown) => target,
  UseGuards: () => (target: unknown) => target,
  Post: () => () => {},
  Get: () => () => {},
  Body: () => () => {},
  Headers: () => () => {},
  Param: () => () => {},
  ConflictException: class ConflictException extends Error { status = 409; },
  BadRequestException: class BadRequestException extends Error { status = 400; },
  ForbiddenException: class ForbiddenException extends Error { status = 403; },
}));

import { V1TasksController } from './v1-tasks.controller';

describe('V1TasksController idempotency', () => {
  const tasks = {
    findByActorRequest: jest.fn(),
    createV1: jest.fn(),
    createPreview: jest.fn(),
    findOneForActor: jest.fn(),
  };

  beforeEach(() => {
    tasks.findByActorRequest.mockReset();
    tasks.createV1.mockReset();
    tasks.createPreview.mockReset();
    tasks.findOneForActor.mockReset();
    delete process.env.VIDEO_FLOW_PRODUCTION_ACTORS;
  });

  it('reuses an existing task for the same actor and request payload', async () => {
    const body = { capability: 'IMAGE_TO_VIDEO', profile: 'seedance', params: { prompt: 'test', image_url: 'https://x/1.png' } };
    const existing = { id: 'task-1', requestSnapshot: body };
    tasks.findByActorRequest.mockResolvedValue(existing);

    const result = await new V1TasksController(tasks as never).create(
      { actorId: 'actor-1' },
      'request-1',
      body,
    );

    expect(result).toMatchObject({ id: 'task-1', preview: { mode: 'preview', willCallProvider: false } });
    expect(tasks.createV1).not.toHaveBeenCalled();
    expect(tasks.createPreview).not.toHaveBeenCalled();
  });

  it('rejects a reused idempotency key with a different payload', async () => {
    tasks.findByActorRequest.mockResolvedValue({
      id: 'task-1',
      requestSnapshot: { capability: 'IMAGE_TO_VIDEO', params: { prompt: 'old' } },
    });

    await expect(
      new V1TasksController(tasks as never).create(
        { actorId: 'actor-1' },
        'request-1',
        {
          capability: 'IMAGE_TO_VIDEO',
          profile: 'seedance',
          params: { prompt: 'new', image_url: 'https://x/1.png' },
        },
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('treats the same payload with a different key order as the same request', async () => {
    const existing = {
      id: 'task-1',
      requestSnapshot: {
        capability: 'IMAGE_TO_VIDEO',
        profile: 'seedance',
        params: { prompt: 'test', image_url: 'https://x/1.png' },
      },
    };
    tasks.findByActorRequest.mockResolvedValue(existing);

    const reordered = {
      params: { image_url: 'https://x/1.png', prompt: 'test' },
      profile: 'seedance',
      capability: 'IMAGE_TO_VIDEO',
    };

    const result = await new V1TasksController(tasks as never).create(
      { actorId: 'actor-1' },
      'request-1',
      reordered as never,
    );

    expect(result).toMatchObject({ id: 'task-1' });
    expect(tasks.createV1).not.toHaveBeenCalled();
    expect(tasks.createPreview).not.toHaveBeenCalled();
  });

  it('未列入白名单的 actor 请求 production 时被拒绝，且不落库', async () => {
    await expect(
      new V1TasksController(tasks as never).create(
        { actorId: 'actor-not-whitelisted' },
        'request-1',
        {
          capability: 'IMAGE_TO_VIDEO',
          profile: 'seedance',
          params: { prompt: 'x', image_url: 'https://x/1.png' },
          mode: 'production',
        },
      ),
    ).rejects.toMatchObject({ status: 403 });

    expect(tasks.findByActorRequest).not.toHaveBeenCalled();
    expect(tasks.createV1).not.toHaveBeenCalled();
    expect(tasks.createPreview).not.toHaveBeenCalled();
  });

  it('白名单 actor 的 production 请求创建真实任务，且不带 preview 标记', async () => {
    process.env.VIDEO_FLOW_PRODUCTION_ACTORS = 'actor-allowed, other-actor';
    tasks.findByActorRequest.mockResolvedValue(null);
    tasks.createV1.mockResolvedValue({ id: 'task-real', status: 'pending' });

    const result = await new V1TasksController(tasks as never).create(
      { actorId: 'actor-allowed' },
      'request-real-1',
      {
        capability: 'IMAGE_TO_VIDEO',
        profile: 'seedance',
        params: { prompt: 'real run', image_asset_id: 'asset-1' },
        mode: 'production',
      },
    );

    expect(tasks.createV1).toHaveBeenCalledTimes(1);
    expect(tasks.createPreview).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: 'task-real', status: 'pending' });
    expect((result as Record<string, unknown>).preview).toBeUndefined();
  });

  it('白名单为空时 production 对所有人关闭', async () => {
    process.env.VIDEO_FLOW_PRODUCTION_ACTORS = '   ';

    await expect(
      new V1TasksController(tasks as never).create(
        { actorId: 'actor-allowed' },
        'request-2',
        {
          capability: 'TEXT_TO_VIDEO',
          profile: 'seedance',
          params: { prompt: 'x' },
          mode: 'production',
        },
      ),
    ).rejects.toMatchObject({ status: 403 });

    expect(tasks.createV1).not.toHaveBeenCalled();
  });

  // 安全回归：以下三条锁定"Preview 永远不会变成付费任务"。
  it('缺省 mode 按 preview 处理，并且只走 createPreview', async () => {
    tasks.findByActorRequest.mockResolvedValue(null);
    tasks.createPreview.mockResolvedValue({ id: 'task-preview', status: 'preview' });

    const result = await new V1TasksController(tasks as never).create(
      { actorId: 'actor-1' },
      'request-1',
      { capability: 'TEXT_TO_VIDEO', profile: 'seedance', params: { prompt: 'hello' } },
    );

    expect(tasks.createPreview).toHaveBeenCalledTimes(1);
    expect(tasks.createV1).not.toHaveBeenCalled();
    expect(tasks.createPreview.mock.calls[0][0]).toMatchObject({
      actorId: 'actor-1',
      clientRequestId: 'request-1',
      capability: 'TEXT_TO_VIDEO',
    });
    expect(result).toMatchObject({
      id: 'task-preview',
      status: 'preview',
      preview: { mode: 'preview', willCallProvider: false, costStatus: 'unavailable' },
    });
  });

  it('显式 mode=preview 不会创建付费 Attempt', async () => {
    tasks.findByActorRequest.mockResolvedValue(null);
    tasks.createPreview.mockResolvedValue({ id: 'task-preview-2', status: 'preview' });

    await new V1TasksController(tasks as never).create(
      { actorId: 'actor-1' },
      'request-2',
      {
        capability: 'TEXT_TO_VIDEO',
        profile: 'seedance',
        params: { prompt: 'hello' },
        mode: 'preview',
      },
    );

    expect(tasks.createPreview).toHaveBeenCalledTimes(1);
    expect(tasks.createV1).not.toHaveBeenCalled();
  });

  it('未知 mode 被拒绝，不会落库', async () => {
    await expect(
      new V1TasksController(tasks as never).create(
        { actorId: 'actor-1' },
        'request-3',
        {
          capability: 'TEXT_TO_VIDEO',
          profile: 'seedance',
          params: { prompt: 'hello' },
          mode: 'comfyui' as never,
        },
      ),
    ).rejects.toMatchObject({ status: 400 });

    expect(tasks.createPreview).not.toHaveBeenCalled();
    expect(tasks.createV1).not.toHaveBeenCalled();
  });

  it('IMAGE_TO_VIDEO 缺少参考图时被拒绝，不会落库', async () => {
    await expect(
      new V1TasksController(tasks as never).create(
        { actorId: 'actor-1' },
        'request-4',
        { capability: 'IMAGE_TO_VIDEO', profile: 'seedance', params: { prompt: 'hello' } },
      ),
    ).rejects.toMatchObject({ status: 400 });

    expect(tasks.createPreview).not.toHaveBeenCalled();
  });
});
