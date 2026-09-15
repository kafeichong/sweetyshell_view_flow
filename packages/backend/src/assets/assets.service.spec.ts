jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target,
  BadRequestException: class BadRequestException extends Error { status = 400; },
  NotFoundException: class NotFoundException extends Error { status = 404; },
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
  task: { findUnique: jest.fn() },
  executionAttempt: { findUnique: jest.fn() },
  $executeRaw: jest.fn(),
  $transaction: jest.fn(),
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
    prisma.task.findUnique.mockReset();
    prisma.executionAttempt.findUnique.mockReset();
    prisma.$executeRaw.mockReset();
    prisma.$transaction.mockReset();
    prisma.$transaction.mockImplementation(async (callback: any) => callback(prisma));
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
    mockAsset.findUnique.mockResolvedValue({ id: 'asset-1', inspectionStatus: 'verified' });

    const result = await service.markUploaded('asset-1', 'actor-a', {
      bucket: 'sweetyshell-ai-assets',
      sizeBytes: 10,
      mimeType: 'image/png',
      mediaMetadata: { kind: 'image', width: 1280, height: 720 },
      inspectionStatus: 'verified',
    });

    expect(mockAsset.updateMany).toHaveBeenCalledWith({
      where: { id: 'asset-1', ownerId: 'actor-a' },
      data: {
        bucket: 'sweetyshell-ai-assets',
        sizeBytes: 10,
        mimeType: 'image/png',
        mediaMetadata: { kind: 'image', width: 1280, height: 720 },
        inspectionStatus: 'verified',
      },
    });
    expect(result).toMatchObject({ id: 'asset-1', inspectionStatus: 'verified' });
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

  it('findOwnedUploadedInput requires actor ownership and input role', async () => {
    mockAsset.findFirst.mockResolvedValue({ id: 'asset-1' });

    await service.findOwnedUploadedInput('asset-1', 'actor-a');

    expect(mockAsset.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'asset-1',
        ownerId: 'actor-a',
        role: AssetRole.INPUT,
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

  describe('registerOutputOnce', () => {
    const outputInput = {
      taskId: 'task-1',
      attemptId: 'attempt-1',
      objectKey: 'videos/task-1/attempt-1/result.mp4',
      bucket: 'bucket',
      mediaType: 'video',
      sizeBytes: 12,
    };

    beforeEach(() => {
      prisma.task.findUnique.mockResolvedValue({
        id: 'task-1',
        actorId: 'actor-a',
        createdBy: 'actor-a',
      });
      prisma.executionAttempt.findUnique.mockResolvedValue({ taskId: 'task-1' });
    });

    it('inherits ownership from the task instead of the caller', async () => {
      mockAsset.findFirst.mockResolvedValue(null);
      mockAsset.create.mockResolvedValue({
        id: 'asset-1',
        ownerId: 'actor-a',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        objectKey: outputInput.objectKey,
        inspectionStatus: 'uploaded',
      });

      const result = await service.registerOutputOnce(outputInput);

      expect(mockAsset.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            ownerId: 'actor-a',
            role: AssetRole.OUTPUT,
            attemptId: 'attempt-1',
            inspectionStatus: 'uploaded',
          }),
        }),
      );
      expect(result.deduplicated).toBe(false);
    });

    it('returns the existing row for the same object key', async () => {
      mockAsset.findFirst.mockResolvedValue({
        id: 'asset-existing',
        ownerId: 'actor-a',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        objectKey: outputInput.objectKey,
        inspectionStatus: 'uploaded',
      });

      const result = await service.registerOutputOnce(outputInput);

      // 归档重跑不得产生第二条产物记录。
      expect(result.deduplicated).toBe(true);
      expect(result.asset.id).toBe('asset-existing');
      expect(mockAsset.create).not.toHaveBeenCalled();
    });

    it('serializes concurrent registrations on the task+attempt lock', async () => {
      mockAsset.findFirst.mockResolvedValue(null);
      mockAsset.create.mockResolvedValue({ id: 'asset-1' });

      await service.registerOutputOnce(outputInput);

      expect(prisma.$executeRaw).toHaveBeenCalled();
      const [strings, ...values] = prisma.$executeRaw.mock.calls[0];
      expect(String(strings.join('?'))).toContain('pg_advisory_xact_lock');
      expect(values).toContain('task-1:attempt-1');
    });

    it('converts the worker-reported size into the BigInt column type', async () => {
      mockAsset.findFirst.mockResolvedValue(null);
      mockAsset.create.mockResolvedValue({ id: 'asset-1' });

      await service.registerOutputOnce(outputInput);

      const data = mockAsset.create.mock.calls[0][0].data;
      expect(data.sizeBytes).toBe(12n);
    });

    it('rejects size values that cannot be stored as bytes', async () => {
      for (const sizeBytes of [1.5, -1, Number.NaN]) {
        await expect(
          service.registerOutputOnce({ ...outputInput, sizeBytes }),
        ).rejects.toThrow('sizeBytes must be a non-negative integer');
      }
      expect(mockAsset.create).not.toHaveBeenCalled();
    });

    it('rejects an attempt that belongs to another task', async () => {
      prisma.executionAttempt.findUnique.mockResolvedValue({ taskId: 'other-task' });

      await expect(service.registerOutputOnce(outputInput)).rejects.toThrow(
        'ATTEMPT_TASK_MISMATCH',
      );
      expect(mockAsset.create).not.toHaveBeenCalled();
    });

    it('rejects registration for an unknown task', async () => {
      prisma.task.findUnique.mockResolvedValue(null);

      await expect(service.registerOutputOnce(outputInput)).rejects.toThrow(
        'Task not found',
      );
    });
  });
});
