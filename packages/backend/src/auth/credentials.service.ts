import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma.service';
import { hasActorBusinessData } from './actor-data';

export class CredentialHasDataError extends Error {
  constructor() {
    super('CREDENTIAL_HAS_DATA');
    this.name = 'CredentialHasDataError';
  }
}

export class CredentialNotFoundError extends Error {
  constructor() {
    super('CREDENTIAL_NOT_FOUND');
    this.name = 'CredentialNotFoundError';
  }
}

@Injectable()
export class CredentialsService {
  constructor(private readonly prisma: PrismaService) {}

  hashToken(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  async create(actorId: string, name: string) {
    const token = `vf_${randomBytes(32).toString('hex')}`;
    await this.prisma.actorCredential.upsert({
      where: { actorId },
      create: {
        actorId,
        name,
        tokenHash: this.hashToken(token),
        status: 'active',
      },
      update: {
        name,
        tokenHash: this.hashToken(token),
        status: 'active',
        lastUsedAt: null,
      },
    });
    return { actorId, token };
  }

  async authenticate(token: string) {
    const credential = await this.prisma.actorCredential.findFirst({
      where: { tokenHash: this.hashToken(token) },
    });

    if (!credential || credential.status !== 'active') {
      return null;
    }

    await this.prisma.actorCredential.update({
      where: { id: credential.id },
      data: { lastUsedAt: new Date() },
    });

    return { actorId: credential.actorId, credentialId: credential.id };
  }

  async revoke(actorId: string) {
    return this.prisma.actorCredential.update({
      where: { actorId },
      data: { status: 'revoked' },
      select: { actorId: true, status: true, updatedAt: true },
    });
  }

  async activate(actorId: string) {
    return this.prisma.actorCredential.update({
      where: { actorId },
      data: { status: 'active' },
      select: { actorId: true, status: true, updatedAt: true },
    });
  }

  async rotateToken(actorId: string) {
    const token = `vf_${randomBytes(32).toString('hex')}`;
    await this.prisma.actorCredential.update({
      where: { actorId },
      data: {
        tokenHash: this.hashToken(token),
        lastUsedAt: null,
        lastIpAddress: null,
      },
      select: { actorId: true },
    });
    return { actorId, token };
  }

  async deleteUnused(actorId: string) {
    return this.prisma.$transaction(async (tx) => {
      const credential = await tx.actorCredential.findUnique({
        where: { actorId },
        select: { actorId: true, usageCount: true },
      });
      if (!credential) throw new CredentialNotFoundError();

      if (credential.usageCount > 0 || await hasActorBusinessData(tx, actorId)) {
        throw new CredentialHasDataError();
      }

      return tx.actorCredential.delete({
        where: { actorId },
        select: { actorId: true },
      });
    });
  }
}
