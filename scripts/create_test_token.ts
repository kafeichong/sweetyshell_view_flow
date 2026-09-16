import { PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';

const prisma = new PrismaClient();

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

async function main() {
  const actorId = 'test-consumer';
  const name = 'Test Consumer Token';
  const token = `vf_${randomBytes(32).toString('hex')}`;

  await prisma.actorCredential.upsert({
    where: { actorId },
    create: {
      actorId,
      name,
      tokenHash: hashToken(token),
      status: 'active',
      dailyLimitCny: 100,
      monthlyLimitCny: 1000,
    },
    update: {
      name,
      tokenHash: hashToken(token),
      status: 'active',
      lastUsedAt: null,
    },
  });

  console.log(`Created credential for actor: ${actorId}`);
  console.log(`Token: ${token}`);
  console.log(`\nSave this to .test-token file:`);
  console.log(token);

  await prisma.$disconnect();
}

main().catch(console.error);
