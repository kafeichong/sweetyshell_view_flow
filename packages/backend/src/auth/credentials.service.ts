import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma.service';

@Injectable()
export class CredentialsService {
  constructor(private readonly prisma: PrismaService) {}

  hashToken(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  async create(actorId: string, name: string) {
    const token = `vf_${randomBytes(32).toString('hex')}`;
    await this.prisma.actorCredential.create({
      data: {
        actorId,
        name,
        tokenHash: this.hashToken(token),
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
}
