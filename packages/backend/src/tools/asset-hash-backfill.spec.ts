jest.mock('@nestjs/common', () => ({}));

import { runAssetHashBackfill } from './asset-hash-backfill';

describe('asset hash backfill', () => {
  const rows = [
    {
      id: 'asset-1',
      ownerId: 'actor-a',
      role: 'input',
      bucket: null,
      objectKey: 'inputs/actor-a/a.png',
      fileHash: null,
      inspectionStatus: 'pending_upload',
    },
    {
      id: 'asset-2',
      ownerId: 'actor-a',
      role: 'input',
      bucket: 'bucket-a',
      objectKey: 'inputs/actor-a/b.png',
      fileHash: null,
      inspectionStatus: 'pending_upload',
    },
  ];

  it('dry-run computes hashes and duplicates without writing', async () => {
    const update = jest.fn();
    const report = await runAssetHashBackfill({
      rows,
      defaultBucket: 'bucket-a',
      loadObject: async () => ({ body: Buffer.from('same'), mimeType: 'image/png' }),
      updateAsset: update,
      apply: false,
    });

    expect(update).not.toHaveBeenCalled();
    expect(report.scanned).toBe(2);
    expect(report.hashable).toBe(2);
    expect(report.updated).toBe(0);
    expect(report.duplicates).toEqual([
      expect.objectContaining({ ownerId: 'actor-a', assetIds: ['asset-1', 'asset-2'] }),
    ]);
  });

  it('apply verifies bytes and updates metadata without deleting or merging', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const report = await runAssetHashBackfill({
      rows: [rows[0]],
      defaultBucket: 'bucket-a',
      loadObject: async () => ({ body: Buffer.from('image'), mimeType: 'image/png' }),
      updateAsset: update,
      apply: true,
    });

    expect(update).toHaveBeenCalledWith('asset-1', {
      bucket: 'bucket-a',
      fileHash: '6105d6cc76af400325e94d588ce511be5bfdbb73b437dc51eca43917d7a43e3d',
      inspectionStatus: 'verified',
      mimeType: 'image/png',
      sizeBytes: 5,
    });
    expect(report.updated).toBe(1);
  });

  it('reports missing objects and performs no update for them', async () => {
    const update = jest.fn();
    const report = await runAssetHashBackfill({
      rows: [rows[0]],
      defaultBucket: 'bucket-a',
      loadObject: async () => {
        throw Object.assign(new Error('NoSuchKey'), { code: 'NoSuchKey' });
      },
      updateAsset: update,
      apply: true,
    });

    expect(update).not.toHaveBeenCalled();
    expect(report.failures).toEqual([
      { assetId: 'asset-1', objectKey: 'inputs/actor-a/a.png', error: 'NoSuchKey' },
    ]);
  });
});
