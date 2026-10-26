import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AdminTokenGuard } from './admin-token.guard';

describe('AdminTokenGuard', () => {
  const originalToken = process.env.VIDEO_FLOW_ADMIN_TOKEN;
  const guard = new AdminTokenGuard();
  const context = (token: unknown): ExecutionContext => ({
    switchToHttp: () => ({ getRequest: () => ({ headers: { 'x-admin-token': token } }) }),
  }) as ExecutionContext;

  beforeEach(() => { process.env.VIDEO_FLOW_ADMIN_TOKEN = 'test-admin'; });
  afterEach(() => {
    if (originalToken === undefined) delete process.env.VIDEO_FLOW_ADMIN_TOKEN;
    else process.env.VIDEO_FLOW_ADMIN_TOKEN = originalToken;
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['incorrect', 'wrong-admn'],
    ['multiple values', ['test-admin', 'test-admin']],
    ['non-string', 123],
    ['same character length with different UTF-8 byte length', 'éest-admin'],
  ])('returns 401 for a %s token', (_description, token) => {
    expect(() => guard.canActivate(context(token))).toThrow(UnauthorizedException);
    try {
      guard.canActivate(context(token));
    } catch (error) {
      expect((error as UnauthorizedException).getStatus()).toBe(401);
    }
  });

  it.each([undefined, ''])('rejects when the configured token is %s', configured => {
    if (configured === undefined) delete process.env.VIDEO_FLOW_ADMIN_TOKEN;
    else process.env.VIDEO_FLOW_ADMIN_TOKEN = configured;
    expect(() => guard.canActivate(context('test-admin'))).toThrow(UnauthorizedException);
  });

  it('accepts the configured token', () => {
    expect(guard.canActivate(context('test-admin'))).toBe(true);
  });
});
