jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target,
  UnauthorizedException: class UnauthorizedException extends Error { status = 401; },
}));

import { WorkerServiceGuard } from './worker-service.guard';

describe('WorkerServiceGuard', () => {
  const context = (token?: string) => ({
    switchToHttp: () => ({ getRequest: () => ({ headers: { 'x-worker-token': token } }) }),
  }) as never;

  const original = process.env.VIDEO_FLOW_WORKER_TOKEN;

  afterEach(() => {
    if (original === undefined) delete process.env.VIDEO_FLOW_WORKER_TOKEN;
    else process.env.VIDEO_FLOW_WORKER_TOKEN = original;
  });

  it('rejects missing or invalid worker token', () => {
    process.env.VIDEO_FLOW_WORKER_TOKEN = 'service-secret';
    const guard = new WorkerServiceGuard();
    expect(() => guard.canActivate(context('wrong'))).toThrow();
    expect(() => guard.canActivate(context())).toThrow();
  });

  it('accepts the configured worker token', () => {
    process.env.VIDEO_FLOW_WORKER_TOKEN = 'service-secret';
    expect(new WorkerServiceGuard().canActivate(context('service-secret'))).toBe(true);
  });
});
