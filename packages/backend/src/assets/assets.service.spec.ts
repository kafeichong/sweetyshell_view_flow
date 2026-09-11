jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target,
}));

import { AssetsService, AssetRole } from './assets.service';

const mockAsset = {
  create: jest.fn(),
  findMany: jest.fn(),
  findFirst: jest.fn(),
  findUnique: jest.fn(),
  updateMany: jest.fn(),
};

const prisma: any = {
  asset: mockAsset,
};

describe('AssetsService contract', () => {
  let service: AssetsService;

  beforeEach(() => {
    service = new AssetsService(prisma);
    mockAsset.create.mockReset();
    mockAsset.findMany.mockReset();
    mockAsset.findFirst.mockReset();
    mockAsset.findUnique.mockReset();
    mockAsset.updateMany.mockReset();
  });

  it('registerInput should persist objectKey as immutable identity', async () => {
    mockAsset.create.mockResolvedValue({ id: 'asset-1' });

    await service.registerInput({
      taskId: 'task-1',
      objectKey: 'inputs/task-1/image.png',
      bucket: 'sweetyshell-ai-assets',
    });

    expect(mockAsset.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          role: AssetRole.INPUT,
          objectKey: 'inputs/task-1/image.png',
          bucket: 'sweetyshell-ai-assets',
        }),
      }),
    );
  });

  it('registerOutput should persist role and objectKey', async () => {
    mockAsset.create.mockResolvedValue({ id: 'asset-2' });

    await service.registerOutput({
      taskId: 'task-1',
      objectKey: 'outputs/task-1/video.mp4',
      bucket: 'sweetyshell-ai-assets',
      mediaType: 'video/mp4',
    });

    expect(mockAsset.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          role: AssetRole.OUTPUT,
          objectKey: 'outputs/task-1/video.mp4',
          mediaType: 'video/mp4',
        }),
      }),
    );
  });

  it('findByTask should query task assets in stable order', async () => {
    mockAsset.findMany.mockResolvedValue([]);

    await service.findByTask('task-1');

    expect(mockAsset.findMany).toHaveBeenCalledWith({
      where: { taskId: 'task-1' },
      orderBy: { createdAt: 'asc' },
    });
  });

  it('markUploaded updates only an asset owned by the actor', async () => {
    mockAsset.updateMany.mockResolvedValue({ count: 1 });
    mockAsset.findUnique.mockResolvedValue({ id: 'asset-1', inspectionStatus: 'uploaded' });

    const result = await service.markUploaded('asset-1', 'actor-a', {
      bucket: 'sweetyshell-ai-assets',
      sizeBytes: 10,
      mimeType: 'image/png',
    });

    expect(mockAsset.updateMany).toHaveBeenCalledWith({
      where: { id: 'asset-1', ownerId: 'actor-a' },
      data: {
        bucket: 'sweetyshell-ai-assets',
        sizeBytes: 10,
        mimeType: 'image/png',
        inspectionStatus: 'uploaded',
      },
    });
    expect(result).toMatchObject({ id: 'asset-1', inspectionStatus: 'uploaded' });
  });

  it('findOwnedUploaded excludes pending uploads', async () => {
    mockAsset.findFirst.mockResolvedValue(null);

    await service.findOwnedUploaded('asset-1', 'actor-a');

    expect(mockAsset.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'asset-1',
        ownerId: 'actor-a',
        inspectionStatus: { in: ['uploaded', 'verified'] },
      },
    });
  });

  it('findLatestOwnedOutputForTask only returns delivered output owned by actor', async () => {
    mockAsset.findFirst.mockResolvedValue({ id: 'asset-output' });

    await service.findLatestOwnedOutputForTask('task-1', 'actor-a');

    expect(mockAsset.findFirst).toHaveBeenCalledWith({
      where: {
        taskId: 'task-1',
        ownerId: 'actor-a',
        role: AssetRole.OUTPUT,
        inspectionStatus: { in: ['uploaded', 'verified'] },
      },
      orderBy: { createdAt: 'desc' },
    });
  });
});
