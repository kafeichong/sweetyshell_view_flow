jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target,
  Inject: () => () => undefined,
  Logger: class Logger { warn() {} error() {} log() {} },
}));
jest.mock('ali-oss', () => class OSS {});

import { Prisma } from '@prisma/client';
import { ArkAssetIngestService } from './ark-asset-ingest.service';

const ARK_ASSET_ID = 'asset-20260917115246-cgmtw';
const IMAGE_METADATA = { kind: 'image' as const, width: 1024, height: 1024 };

function build(overrides: {
  remote?: Record<string, unknown>;
  existing?: unknown;
  metadata?: unknown;
  mimeType?: string;
  createError?: unknown;
} = {}) {
  const created = {
    id: 'asset-row-1', ownerId: 'actor-1', role: 'input', objectKey: `inputs/actor-1/ark-${ARK_ASSET_ID}`,
    mimeType: 'image/png', sizeBytes: BigInt(9), mediaMetadata: IMAGE_METADATA, arkAssetId: ARK_ASSET_ID,
  };
  const prisma = {
    asset: {
      findFirst: jest.fn().mockResolvedValue(overrides.existing ?? null),
      create: overrides.createError
        ? jest.fn().mockRejectedValue(overrides.createError)
        : jest.fn().mockResolvedValue(created),
    },
  };
  const ark = {
    getAsset: jest.fn().mockResolvedValue({
      id: ARK_ASSET_ID, name: '005', assetType: 'Image', status: 'Active',
      groupId: 'group-1', projectName: 'default', url: 'https://ark.example.invalid/x.jpg',
      ...overrides.remote,
    }),
  };
  const inspector = {
    inspectWithMime: jest.fn().mockResolvedValue({
      metadata: overrides.metadata ?? IMAGE_METADATA,
      mimeType: overrides.mimeType ?? 'image/png',
    }),
  };
  const presign = {
    putObject: jest.fn().mockResolvedValue({ sizeBytes: 9, fileHash: 'a'.repeat(64) }),
    getBucketName: jest.fn().mockReturnValue('bucket'),
  };
  const service = new ArkAssetIngestService(
    prisma as never, ark as never, inspector as never, presign as never,
  );
  return { service, prisma, ark, inspector, presign, created };
}

const mockFetchBytes = (bytes = Buffer.from('ark-image'), headers: Record<string, string> = {}) =>
  jest.spyOn(global, 'fetch' as never).mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    arrayBuffer: async () => bytes,
  } as never);

describe('ArkAssetIngestService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('fetches, inspects and stores a library asset as one of ours', async () => {
    mockFetchBytes();
    const { service, prisma, ark, presign } = build();

    const asset = await service.materialize('actor-1', ARK_ASSET_ID);

    expect(asset.id).toBe('asset-row-1');
    expect(ark.getAsset).toHaveBeenCalledWith(ARK_ASSET_ID, 'default');
    // 对象键由 arkAssetId 决定（不是随机值）：并发的重复登记会写同一个键，
    // 失败方不会在桶里留下垃圾对象。
    expect(presign.putObject).toHaveBeenCalledWith(`inputs/actor-1/ark-${ARK_ASSET_ID}`, expect.any(Buffer), 'image/png');
    expect(prisma.asset.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ownerId: 'actor-1',
        role: 'input',
        arkAssetId: ARK_ASSET_ID,
        arkGroupId: 'group-1',
        arkAssetStatus: 'Active',
        inspectionStatus: 'verified',
        fileHash: 'a'.repeat(64),
      }),
    });
    // 字节取回来是为了检查：GetAsset 不返回尺寸与时长，而视频时长直接进计费公式。
    expect(asset).toMatchObject({ arkAssetId: ARK_ASSET_ID });
  });

  it('reuses the row we already have without touching the network', async () => {
    const existing = { id: 'asset-row-existing', arkAssetId: ARK_ASSET_ID };
    const { service, ark, prisma, presign } = build({ existing });
    const fetchSpy = mockFetchBytes();

    await expect(service.materialize('actor-1', ARK_ASSET_ID)).resolves.toBe(existing);
    expect(ark.getAsset).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(presign.putObject).not.toHaveBeenCalled();
    expect(prisma.asset.create).not.toHaveBeenCalled();
  });

  it.each([
    ['ARK_ASSET_NOT_ACTIVE', { status: 'Processing' }],
    ['ARK_ASSET_PROJECT_MISMATCH', { projectName: 'someone-else' }],
    ['ARK_ASSET_TYPE_UNSUPPORTED', { assetType: 'Hologram' }],
  ])('refuses an asset Ark would not accept: %s', async (code, remote) => {
    mockFetchBytes();
    const { service, presign } = build({ remote });

    await expect(service.materialize('actor-1', ARK_ASSET_ID)).rejects.toMatchObject({ code });
    // 拦在取字节、写桶之前：这些素材送上去必被方舟拒。
    expect(presign.putObject).not.toHaveBeenCalled();
  });

  it('refuses when what Ark declares does not match what the bytes actually are', async () => {
    mockFetchBytes();
    // 素材库标着 Image，探出来却是视频——照收的话，后面按图片比例报价会全错。
    const { service } = build({ metadata: { kind: 'video', width: 1280, height: 720, durationSeconds: 5 } });

    await expect(service.materialize('actor-1', ARK_ASSET_ID)).rejects.toMatchObject({
      code: 'ARK_ASSET_TYPE_MISMATCH',
    });
  });

  it('refuses an asset that breaks the same official limits an upload must satisfy', async () => {
    mockFetchBytes();
    // 2000×2000 的图本身合法，但宽度 2000 超了合同的 6000 上限之外的另一条……
    // 这里用宽高比 3:1 触发官方 0.4–2.5 的比例限制。
    const { service } = build({ metadata: { kind: 'image', width: 3000, height: 1000 } });

    await expect(service.materialize('actor-1', ARK_ASSET_ID)).rejects.toMatchObject({
      code: 'ARK_ASSET_METADATA_INVALID',
    });
  });

  it('refuses an over-large asset before reading it into memory', async () => {
    mockFetchBytes(Buffer.from('x'), { 'content-length': String(500 * 1024 * 1024) });
    const { service } = build();

    await expect(service.materialize('actor-1', ARK_ASSET_ID)).rejects.toMatchObject({
      code: 'ARK_ASSET_TOO_LARGE',
    });
  });

  it('returns the winner when two registrations race', async () => {
    mockFetchBytes();
    // 并发竞争由唯一约束裁决，失败方回读胜者——正常的幂等竞争不该暴露成 500。
    const winner = { id: 'asset-row-winner', arkAssetId: ARK_ASSET_ID };
    const conflict = new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: '5.22.0' });
    const { service, prisma } = build({ createError: conflict });
    prisma.asset.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);

    await expect(service.materialize('actor-1', ARK_ASSET_ID)).resolves.toBe(winner);
  });

  it('fails closed when the library cannot be reached', async () => {
    const { service, ark, presign } = build();
    ark.getAsset.mockRejectedValue(new Error('network down'));

    await expect(service.materialize('actor-1', ARK_ASSET_ID)).rejects.toMatchObject({
      code: 'ARK_ASSET_UNREACHABLE',
    });
    expect(presign.putObject).not.toHaveBeenCalled();
  });
});

describe('ArkAssetIngestService publish', () => {
  afterEach(() => jest.restoreAllMocks());

  const OURS = {
    id: 'ours-1', ownerId: 'actor-1', role: 'input', mediaType: 'image',
    objectKey: 'inputs/actor-1/11111111-2222-3333-4444-555555555555-我的形象.png',
    mimeType: 'image/png', sizeBytes: BigInt(9), arkAssetId: null, arkGroupId: null, arkAssetStatus: null,
  };

  function buildPublish(assetOverrides: Record<string, unknown> = {}) {
    const asset = { ...OURS, ...assetOverrides };
    const prisma = {
      asset: { findFirst: jest.fn().mockResolvedValue(asset), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const ark = {
      createAssetGroup: jest.fn().mockResolvedValue('group-new'),
      createAsset: jest.fn().mockResolvedValue('asset-new'),
      waitForAssetActive: jest.fn().mockResolvedValue({
        id: 'asset-new', name: '我的形象', assetType: 'Image', status: 'Active',
        groupId: 'group-new', projectName: 'default', url: null,
      }),
    };
    const presign = { createDownloadUrl: jest.fn().mockReturnValue({ downloadUrl: 'https://oss/signed', expiresIn: 300 }) };
    const service = new ArkAssetIngestService(prisma as never, ark as never, {} as never, presign as never);
    return { service, prisma, ark, presign, asset };
  }

  it('hands Ark a signed url for an asset we already hold, then polls it to Active', async () => {
    const { service, ark, presign, prisma } = buildPublish();

    const published = await service.publish('actor-1', 'ours-1');

    expect(presign.createDownloadUrl).toHaveBeenCalledWith(expect.stringContaining('inputs/actor-1/'));
    expect(ark.createAsset).toHaveBeenCalledWith(expect.objectContaining({
      groupId: 'group-new', url: 'https://oss/signed', assetType: 'Image', name: '我的形象',
    }));
    expect(ark.waitForAssetActive).toHaveBeenCalledWith('asset-new');
    expect(prisma.asset.updateMany).toHaveBeenCalledWith({
      where: { id: 'ours-1' },
      data: expect.objectContaining({ arkAssetId: 'asset-new', arkGroupId: 'group-new', arkAssetStatus: 'Active' }),
    });
    expect(published).toMatchObject({ arkAssetId: 'asset-new' });
  });

  it('is idempotent: an already-published asset is not published twice', async () => {
    // 重复入库会白占配额、还会在素材库里灌重复素材，而且不好清理。
    const { service, ark, presign } = buildPublish({ arkAssetId: 'asset-already' });

    await expect(service.publish('actor-1', 'ours-1')).resolves.toMatchObject({ arkAssetId: 'asset-already' });
    expect(ark.createAsset).not.toHaveBeenCalled();
    expect(presign.createDownloadUrl).not.toHaveBeenCalled();
  });

  it('refuses to publish someone else’s or unverified material', async () => {
    const { service, ark } = buildPublish();
    (service as any).prisma.asset.findFirst.mockResolvedValue(null);

    await expect(service.publish('actor-1', 'ours-1')).rejects.toMatchObject({ code: 'ARK_PUBLISH_ASSET_NOT_FOUND' });
    expect(ark.createAsset).not.toHaveBeenCalled();
  });

  it('does not claim success while Ark still says the asset is processing', async () => {
    // 把"还在处理"当成能用了，用户会拿一份尚未入库的素材去生成，方舟拦下，钱白花。
    const { service, ark, prisma } = buildPublish();
    ark.waitForAssetActive.mockRejectedValue(
      new (class extends Error { code = 'ARK_ASSET_LIBRARY_ERROR:AssetStillProcessing:Processing' })('still processing'),
    );

    await expect(service.publish('actor-1', 'ours-1')).rejects.toMatchObject({ code: 'ARK_ASSET_LIBRARY_ERROR:AssetStillProcessing:Processing' });
    expect(prisma.asset.updateMany).not.toHaveBeenCalled();
  });
});
