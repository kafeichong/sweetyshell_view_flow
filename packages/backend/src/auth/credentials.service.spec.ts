jest.mock('@nestjs/common', () => ({ Injectable: () => () => undefined }));

import {
  CredentialHasDataError,
  CredentialsService,
} from './credentials.service';

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

  it('reactivates an existing credential without replacing its token hash', async () => {
    const existing = {
      actorId: 'creative-pilot',
      status: 'active',
      updatedAt: new Date('2026-09-21T00:00:00.000Z'),
    };
    const prisma = {
      actorCredential: { update: jest.fn().mockResolvedValue(existing) },
    };
    const service = new CredentialsService(prisma as never);

    await expect(service.activate('creative-pilot')).resolves.toEqual(existing);
    expect(prisma.actorCredential.update).toHaveBeenCalledWith({
      where: { actorId: 'creative-pilot' },
      data: { status: 'active' },
      select: { actorId: true, status: true, updatedAt: true },
    });
  });

  it('permanently deletes a credential that has never produced business data', async () => {
    const tx = emptyActorDataStore({ actorId: 'unused-user', usageCount: 0 });
    const prisma = { $transaction: jest.fn((callback) => callback(tx)) };
    const service = new CredentialsService(prisma as never);

    await expect(service.deleteUnused('unused-user')).resolves.toEqual({ actorId: 'unused-user' });
    expect(tx.actorCredential.delete).toHaveBeenCalledWith({
      where: { actorId: 'unused-user' },
      select: { actorId: true },
    });
  });

  it('refuses to delete a credential when any historical task exists', async () => {
    const tx = emptyActorDataStore({ actorId: 'used-user', usageCount: 0 });
    tx.task.count.mockResolvedValue(1);
    const prisma = { $transaction: jest.fn((callback) => callback(tx)) };
    const service = new CredentialsService(prisma as never);

    await expect(service.deleteUnused('used-user')).rejects.toBeInstanceOf(CredentialHasDataError);
    expect(tx.actorCredential.delete).not.toHaveBeenCalled();
  });

  it('rotates the token without changing the credential access status', async () => {
    const prisma = {
      actorCredential: {
        update: jest.fn().mockResolvedValue({ actorId: 'stopped-user' }),
      },
    };
    const service = new CredentialsService(prisma as never);

    const result = await service.rotateToken('stopped-user');

    expect(result.actorId).toBe('stopped-user');
    expect(result.token).toMatch(/^vf_/);
    expect(prisma.actorCredential.update).toHaveBeenCalledWith({
      where: { actorId: 'stopped-user' },
      data: {
        tokenHash: expect.any(String),
        lastUsedAt: null,
        lastIpAddress: null,
      },
      select: { actorId: true },
    });
  });
});

function emptyActorDataStore(credential: { actorId: string; usageCount: number }) {
  return {
    actorCredential: {
      findUnique: jest.fn().mockResolvedValue(credential),
      delete: jest.fn().mockResolvedValue({ actorId: credential.actorId }),
    },
    task: { count: jest.fn().mockResolvedValue(0) },
    asset: { count: jest.fn().mockResolvedValue(0) },
    taskBudgetReservation: { count: jest.fn().mockResolvedValue(0) },
    preflightRecord: { count: jest.fn().mockResolvedValue(0) },
    costAlert: { count: jest.fn().mockResolvedValue(0) },
    costReconciliation: { count: jest.fn().mockResolvedValue(0) },
    tokenUsageLog: { count: jest.fn().mockResolvedValue(0) },
  };
}
