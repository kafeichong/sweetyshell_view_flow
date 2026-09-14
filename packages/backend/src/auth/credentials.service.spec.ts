jest.mock('@nestjs/common', () => ({ Injectable: () => () => undefined }));

import { CredentialsService } from './credentials.service';

describe('CredentialsService', () => {
  it('reissues a revoked actor credential by replacing its token hash and restoring active status', async () => {
    const prisma = { actorCredential: { upsert: jest.fn().mockResolvedValue({}) } };
    const service = new CredentialsService(prisma as never);
    const result = await service.create('creative-pilot', 'Creative Pilot');
    expect(result.actorId).toBe('creative-pilot');
    expect(result.token).toMatch(/^vf_/);
    expect(prisma.actorCredential.upsert).toHaveBeenCalledWith({
      where: { actorId: 'creative-pilot' },
      create: expect.objectContaining({ actorId: 'creative-pilot', name: 'Creative Pilot', status: 'active' }),
      update: expect.objectContaining({ name: 'Creative Pilot', status: 'active', tokenHash: expect.any(String), lastUsedAt: null }),
    });
  });
});
