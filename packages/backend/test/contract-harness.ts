import { createHash, randomBytes, randomUUID } from 'crypto';
import { ChildProcess, spawn } from 'child_process';
import { createServer } from 'net';
import { PrismaClient } from '@prisma/client';

type ContractEnvironment = Record<string, string | undefined>;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', 'postgres']);

export function assertContractEnvironment(env: ContractEnvironment): void {
  if (env.VIDEO_FLOW_TEST_MODE !== '1') {
    throw new Error('VIDEO_FLOW_TEST_MODE_REQUIRED');
  }

  const databaseUrl = new URL(env.DATABASE_URL ?? '');
  if (
    databaseUrl.pathname !== '/video_flow_contract' ||
    !LOOPBACK_HOSTS.has(databaseUrl.hostname)
  ) {
    throw new Error('CONTRACT_DATABASE_REQUIRED');
  }

  if (env.VOLCENGINE_ACCESS_KEY?.trim()) {
    throw new Error('REAL_PROVIDER_CREDENTIAL_FORBIDDEN');
  }

  const providerUrl = new URL(env.VIDEO_FLOW_PROVIDER_BASE_URL ?? '');
  if (!LOOPBACK_HOSTS.has(providerUrl.hostname)) {
    throw new Error('CONTRACT_PROVIDER_REQUIRED');
  }
}

export type ContractHarness = {
  appUrl: string;
  prisma: PrismaClient;
  actorToken: string;
  workerToken: string;
  adminToken: string;
  close(): Promise<void>;
};

async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('CONTRACT_LISTEN_FAILED'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function waitForBackend(appUrl: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`CONTRACT_BACKEND_EXITED_${child.exitCode}`);
    }
    try {
      const response = await fetch(`${appUrl}/api/tasks`);
      if (response.status === 401) {
        return;
      }
    } catch {
      // The process has not started listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('CONTRACT_BACKEND_START_TIMEOUT');
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 2000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function createContractHarness(): Promise<ContractHarness> {
  assertContractEnvironment(process.env);

  const workerToken = `contract-worker-${randomUUID()}`;
  const adminToken = `contract-admin-${randomUUID()}`;
  const actorId = `contract-${randomUUID()}`;
  const actorToken = `vf_${randomBytes(32).toString('hex')}`;
  const tokenHash = createHash('sha256').update(actorToken).digest('hex');
  const port = await reserveLoopbackPort();
  const appUrl = `http://127.0.0.1:${port}`;
  const prisma = new PrismaClient();

  await prisma.actorCredential.create({
    data: {
      actorId,
      name: 'contract actor',
      tokenHash,
    },
  });

  const child = spawn(process.execPath, ['dist/src/main.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      VIDEO_FLOW_ADMIN_TOKEN: adminToken,
      VIDEO_FLOW_WORKER_TOKEN: workerToken,
      VIDEO_FLOW_PRODUCTION_ACTORS: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr = (stderr + String(chunk)).slice(-4000);
  });

  try {
    await waitForBackend(appUrl, child);
  } catch (error) {
    await stopChild(child);
    await prisma.actorCredential.deleteMany({ where: { actorId } });
    await prisma.$disconnect();
    throw new Error(`${String(error)}\n${stderr}`);
  }

  return {
    appUrl,
    prisma,
    actorToken,
    workerToken,
    adminToken,
    async close() {
      await prisma.task.deleteMany({ where: { actorId } });
      await prisma.actorCredential.deleteMany({ where: { actorId } });
      await prisma.$disconnect();
      await stopChild(child);
    },
  };
}
