jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target,
  UnauthorizedException: class UnauthorizedException extends Error { status = 401; },
  ForbiddenException: class ForbiddenException extends Error { status = 403; },
}));

import { ApiCredentialGuard } from './api-credential.guard';

describe('ApiCredentialGuard', () => {
  const credentials = { authenticate: jest.fn() };
  const request = { headers: {}, actor: undefined as unknown };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as never;

  beforeEach(() => {
    credentials.authenticate.mockReset();
    request.headers = {};
    request.actor = undefined;
  });

  it('rejects requests without a bearer token', async () => {
    const guard = new ApiCredentialGuard(credentials as never);
    await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects inactive or unknown credentials', async () => {
    credentials.authenticate.mockResolvedValue(null);
    request.headers = { authorization: 'Bearer invalid' };

    const guard = new ApiCredentialGuard(credentials as never);
    await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 403 });
  });

  it('injects the authenticated actor into the request', async () => {
    const actor = { actorId: 'actor-1', credentialId: 'credential-1' };
    credentials.authenticate.mockResolvedValue(actor);
    request.headers = { authorization: 'Bearer token' };

    const guard = new ApiCredentialGuard(credentials as never);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.actor).toEqual(actor);
  });
});
