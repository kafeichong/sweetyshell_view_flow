import { createHash } from 'crypto';
import { PrismaClient } from '@prisma/client';

export type AssetHashBackfillRow = {
  id: string;
  ownerId: string | null;
  role: string;
  bucket: string | null;
  objectKey: string;
  fileHash: string | null;
  inspectionStatus: string | null;
};

export type LoadedObject = {
  body: Buffer | AsyncIterable<Uint8Array>;
  mimeType?: string;
};

export type AssetHashUpdate = {
  bucket: string;
  fileHash: string;
  inspectionStatus: 'verified';
  mimeType: string;
  sizeBytes: number;
};

type BackfillOptions = {
  rows: AssetHashBackfillRow[];
  defaultBucket: string;
  loadObject: (bucket: string, objectKey: string) => Promise<LoadedObject>;
  updateAsset: (assetId: string, update: AssetHashUpdate) => Promise<unknown>;
  apply: boolean;
};

type HashedAsset = {
  assetId: string;
  ownerId: string | null;
  fileHash: string;
};

async function readAndHash(body: LoadedObject['body']) {
  const hash = createHash('sha256');
  let sizeBytes = 0;

  if (Buffer.isBuffer(body)) {
    hash.update(body);
    sizeBytes = body.length;
  } else {
    for await (const chunk of body) {
      const buffer = Buffer.from(chunk);
      hash.update(buffer);
      sizeBytes += buffer.length;
    }
  }

  return { fileHash: hash.digest('hex'), sizeBytes };
}

export async function runAssetHashBackfill(options: BackfillOptions) {
  const failures: Array<{ assetId: string; objectKey: string; error: string }> = [];
  const hashed: HashedAsset[] = [];
  let updated = 0;

  for (const row of options.rows) {
    const bucket = row.bucket || options.defaultBucket;
    try {
      const object = await options.loadObject(bucket, row.objectKey);
      const calculated = await readAndHash(object.body);
      hashed.push({
        assetId: row.id,
        ownerId: row.ownerId,
        fileHash: calculated.fileHash,
      });

      if (options.apply) {
        await options.updateAsset(row.id, {
          bucket,
          fileHash: calculated.fileHash,
          inspectionStatus: 'verified',
          mimeType: object.mimeType?.split(';')[0].trim().toLowerCase() || 'application/octet-stream',
          sizeBytes: calculated.sizeBytes,
        });
        updated += 1;
      }
    } catch (error) {
      failures.push({
        assetId: row.id,
        objectKey: row.objectKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const duplicateMap = new Map<string, HashedAsset[]>();
  for (const item of hashed) {
    const key = `${item.ownerId ?? '<null>'}:${item.fileHash}`;
    const group = duplicateMap.get(key) ?? [];
    group.push(item);
    duplicateMap.set(key, group);
  }
  const duplicates = [...duplicateMap.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({
      ownerId: group[0].ownerId,
      fileHash: group[0].fileHash,
      assetIds: group.map((item) => item.assetId).sort(),
    }));

  return {
    mode: options.apply ? 'apply' : 'dry-run',
    scanned: options.rows.length,
    hashable: hashed.length,
    updated,
    failures,
    duplicates,
  };
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(
      'Usage: npm run build && npm run assets:backfill -- [--apply]\n' +
      'Default is read-only dry-run. --apply updates verified input Asset metadata.\n',
    );
    return;
  }
  const apply = process.argv.includes('--apply');
  const defaultBucket = process.env.OSS_BUCKET?.trim();
  const region = process.env.OSS_REGION?.trim();
  const accessKeyId = process.env.OSS_ACCESS_KEY_ID?.trim();
  const accessKeySecret = process.env.OSS_ACCESS_KEY_SECRET?.trim();
  if (!defaultBucket || !region || !accessKeyId || !accessKeySecret) {
    throw new Error(
      'OSS_BUCKET, OSS_REGION, OSS_ACCESS_KEY_ID and OSS_ACCESS_KEY_SECRET are required',
    );
  }

  const OssConstructor = ((require('ali-oss') as { default?: unknown }).default ?? require('ali-oss')) as new (
    options: Record<string, unknown>,
  ) => {
    getStream: (objectKey: string) => Promise<{
      stream: AsyncIterable<Uint8Array>;
      res?: { headers?: Record<string, string | undefined> };
    }>;
  };
  const clients = new Map<string, InstanceType<typeof OssConstructor>>();
  const getClient = (bucket: string) => {
    let client = clients.get(bucket);
    if (!client) {
      client = new OssConstructor({
        region,
        accessKeyId,
        accessKeySecret,
        bucket,
        secure: true,
      });
      clients.set(bucket, client);
    }
    return client;
  };

  const prisma = new PrismaClient();
  try {
    const rows = await prisma.asset.findMany({
      where: {
        role: 'input',
        OR: [
          { fileHash: null },
          { inspectionStatus: null },
          { inspectionStatus: { notIn: ['uploaded', 'verified'] } },
        ],
      },
      select: {
        id: true,
        ownerId: true,
        role: true,
        bucket: true,
        objectKey: true,
        fileHash: true,
        inspectionStatus: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    const report = await runAssetHashBackfill({
      rows,
      defaultBucket,
      loadObject: async (bucket, objectKey) => {
        const result = await getClient(bucket).getStream(objectKey);
        return {
          body: result.stream,
          mimeType: result.res?.headers?.['content-type'],
        };
      },
      updateAsset: (assetId, update) => prisma.asset.update({
        where: { id: assetId },
        data: update,
      }),
      apply,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
