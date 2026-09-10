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
}));

import { V1TasksController } from './v1-tasks.controller';

describe('V1TasksController idempotency', () => {
  const tasks = {
    findByActorRequest: jest.fn(),
    createV1: jest.fn(),
    findOneForActor: jest.fn(),
  };

  beforeEach(() => {
    tasks.findByActorRequest.mockReset();
    tasks.createV1.mockReset();
    tasks.findOneForActor.mockReset();
  });

  it('reuses an existing task for the same actor and request payload', async () => {
    const body = { capability: 'IMAGE_TO_VIDEO', profile: 'seedance', params: { prompt: 'test' } };
    const existing = { id: 'task-1', requestSnapshot: body };
    tasks.findByActorRequest.mockResolvedValue(existing);

    const result = await new V1TasksController(tasks as never).create(
      { actorId: 'actor-1' },
      'request-1',
      body,
    );

    expect(result).toBe(existing);
    expect(tasks.createV1).not.toHaveBeenCalled();
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
        { capability: 'IMAGE_TO_VIDEO', profile: 'seedance', params: { prompt: 'new' } },
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('treats the same payload with a different key order as the same request', async () => {
    const existing = {
      id: 'task-1',
      requestSnapshot: {
        capability: 'IMAGE_TO_VIDEO',
        profile: 'seedance',
        params: { prompt: 'test' },
      },
    };
    tasks.findByActorRequest.mockResolvedValue(existing);

    const reordered = {
      params: { prompt: 'test' },
      profile: 'seedance',
      capability: 'IMAGE_TO_VIDEO',
    };

    const result = await new V1TasksController(tasks as never).create(
      { actorId: 'actor-1' },
      'request-1',
      reordered as never,
    );

    expect(result).toBe(existing);
    expect(tasks.createV1).not.toHaveBeenCalled();
  });

  it('rejects production mode before creating any task', async () => {
    await expect(
      new V1TasksController(tasks as never).create(
        { actorId: 'actor-1' },
        'request-1',
        {
          capability: 'IMAGE_TO_VIDEO',
          profile: 'seedance',
          params: { prompt: 'x' },
          mode: 'production',
        },
      ),
    ).rejects.toMatchObject({ status: 400 });

    expect(tasks.findByActorRequest).not.toHaveBeenCalled();
    expect(tasks.createV1).not.toHaveBeenCalled();
  });
});
