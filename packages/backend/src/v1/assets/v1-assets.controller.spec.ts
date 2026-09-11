jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target,
  createParamDecorator: () => () => () => {},
  Controller: () => (target: unknown) => target,
  UseGuards: () => (target: unknown) => target,
  Post: () => () => {},
  Get: () => () => {},
  Body: () => () => {},
  Param: () => () => {},
  BadRequestException: class BadRequestException extends Error { status = 400; },
  NotFoundException: class NotFoundException extends Error { status = 404; },
  ServiceUnavailableException: class ServiceUnavailableException extends Error { status = 503; },
}));
jest.mock('ali-oss', () => class OSS {});

import { V1AssetsController } from './v1-assets.controller';
import { Prisma } from '@prisma/client';

describe('V1AssetsController ownership', () => {
  it('does not create a download URL for an asset owned by another actor', async () => {
    const assets = { findOwnedUploaded: jest.fn().mockResolvedValue(null), registerInput: jest.fn() };
    const presign = { isConfigured: jest.fn().mockReturnValue(true), createDownloadUrl: jest.fn() };
    const controller = new V1AssetsController(assets as never, presign as never);

    await expect(controller.download({ actorId: 'actor-a' }, 'asset-1')).rejects.toMatchObject({ status: 404 });
    expect(presign.createDownloadUrl).not.toHaveBeenCalled();
  });

  it('persists an input asset before returning its upload ticket', async () => {
    const assets = {
      findOwned: jest.fn(),
      registerInput: jest.fn().mockResolvedValue({ id: 'asset-1', objectKey: 'inputs/actor-a/file.png' }),
    };
    const presign = {
      isConfigured: jest.fn().mockReturnValue(true),
      getBucketName: jest.fn().mockReturnValue('sweetyshell-ai-assets'),
      createUploadTicket: jest.fn().mockReturnValue({ assetId: 'asset-1' }),
    };
    const controller = new V1AssetsController(assets as never, presign as never);

    await controller.createUploadTicket(
      { actorId: 'actor-a' },
      { filename: 'file.png', mimeType: 'image/png', sizeBytes: 10 },
    );

    expect(assets.registerInput).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: 'actor-a',
      mimeType: 'image/png',
      sizeBytes: 10,
      inspectionStatus: 'pending_upload',
    }));
    expect(presign.createUploadTicket).toHaveBeenCalledWith(
      'asset-1',
      'inputs/actor-a/file.png',
      'image/png',
      10,
      undefined,
    );
  });

  // 幂等前提：相同内容必须复用同一条 Asset，否则每次重复提交都会换 asset_id，
  // 任务层就会把"同 key"判成"不同请求体"并返回 409。
  it('reuses the existing asset when the same content hash is uploaded again', async () => {
    const hash = 'a'.repeat(64);
    const assets = {
      findOwned: jest.fn(),
      findByOwnerHash: jest.fn().mockResolvedValue({
        id: 'asset-existing',
        objectKey: 'inputs/actor-a/reused.png',
      }),
      registerInput: jest.fn(),
    };
    const presign = {
      isConfigured: jest.fn().mockReturnValue(true),
      createUploadTicket: jest.fn().mockReturnValue({ assetId: 'asset-existing' }),
    };
    const controller = new V1AssetsController(assets as never, presign as never);

    const ticket = await controller.createUploadTicket(
      { actorId: 'actor-a' },
      { filename: 'file.png', mimeType: 'image/png', sizeBytes: 10, sha256: hash },
    );

    expect(assets.findByOwnerHash).toHaveBeenCalledWith('actor-a', hash);
    // 不能新建 Asset，否则幂等会失效。
    expect(assets.registerInput).not.toHaveBeenCalled();
    expect(ticket).toMatchObject({ assetId: 'asset-existing' });
    expect(presign.createUploadTicket).toHaveBeenCalledWith(
      'asset-existing',
      'inputs/actor-a/reused.png',
      'image/png',
      10,
      hash,
    );
  });

  it('does not issue another PUT ticket for an already uploaded canonical asset', async () => {
    const hash = 'e'.repeat(64);
    const assets = {
      findByOwnerHash: jest.fn().mockResolvedValue({
        id: 'asset-uploaded',
        objectKey: 'inputs/actor-a/original.png',
        inspectionStatus: 'uploaded',
        mimeType: 'image/png',
        sizeBytes: BigInt(10),
      }),
      registerInput: jest.fn(),
    };
    const presign = {
      isConfigured: jest.fn().mockReturnValue(true),
      createUploadTicket: jest.fn(),
    };
    const controller = new V1AssetsController(assets as never, presign as never);

    const result = await controller.createUploadTicket(
      { actorId: 'actor-a' },
      { filename: 'same.png', mimeType: 'image/png', sizeBytes: 10, sha256: hash },
    );

    expect(result).toEqual({
      assetId: 'asset-uploaded',
      objectKey: 'inputs/actor-a/original.png',
      alreadyUploaded: true,
      inspectionStatus: 'uploaded',
    });
    expect(presign.createUploadTicket).not.toHaveBeenCalled();
  });

  it('records the content hash when creating a new asset', async () => {
    const hash = 'b'.repeat(64);
    const assets = {
      findOwned: jest.fn(),
      findByOwnerHash: jest.fn().mockResolvedValue(null),
      registerInput: jest.fn().mockResolvedValue({ id: 'asset-new', objectKey: 'inputs/actor-a/new.png' }),
    };
    const presign = {
      isConfigured: jest.fn().mockReturnValue(true),
      getBucketName: jest.fn().mockReturnValue('sweetyshell-ai-assets'),
      createUploadTicket: jest.fn().mockReturnValue({}),
    };
    const controller = new V1AssetsController(assets as never, presign as never);

    await controller.createUploadTicket(
      { actorId: 'actor-a' },
      { filename: 'file.png', mimeType: 'image/png', sizeBytes: 10, sha256: hash },
    );

    expect(assets.registerInput).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'actor-a',
        fileHash: hash,
        bucket: 'sweetyshell-ai-assets',
      }),
    );
  });

  it('confirms an uploaded object before marking the asset uploaded', async () => {
    const hash = 'c'.repeat(64);
    const assets = {
      findOwned: jest.fn().mockResolvedValue({
        id: 'asset-1',
        ownerId: 'actor-a',
        objectKey: 'inputs/actor-a/file.png',
        sizeBytes: BigInt(10),
        mimeType: 'image/png',
        fileHash: hash,
      }),
      markUploaded: jest.fn().mockResolvedValue({
        id: 'asset-1',
        objectKey: 'inputs/actor-a/file.png',
        bucket: 'sweetyshell-ai-assets',
        mimeType: 'image/png',
        sizeBytes: BigInt(10),
        inspectionStatus: 'uploaded',
      }),
    };
    const presign = {
      inspectObject: jest.fn().mockResolvedValue({
        sizeBytes: 10,
        mimeType: 'image/png',
        fileHash: hash,
      }),
      getBucketName: jest.fn().mockReturnValue('sweetyshell-ai-assets'),
    };
    const controller = new V1AssetsController(assets as never, presign as never);

    const result = await controller.completeUpload({ actorId: 'actor-a' }, 'asset-1');

    expect(result).toMatchObject({
      assetId: 'asset-1',
      sizeBytes: 10,
      inspectionStatus: 'uploaded',
    });
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(assets.markUploaded).toHaveBeenCalledWith('asset-1', 'actor-a', {
      bucket: 'sweetyshell-ai-assets',
      sizeBytes: 10,
      mimeType: 'image/png',
    });
  });

  it('rejects upload completion when OSS size does not match the ticket', async () => {
    const assets = {
      findOwned: jest.fn().mockResolvedValue({
        id: 'asset-1',
        ownerId: 'actor-a',
        objectKey: 'inputs/actor-a/file.png',
        sizeBytes: BigInt(10),
        mimeType: 'image/png',
      }),
      markUploaded: jest.fn(),
    };
    const presign = {
      inspectObject: jest.fn().mockResolvedValue({ sizeBytes: 9, mimeType: 'image/png' }),
      getBucketName: jest.fn().mockReturnValue('sweetyshell-ai-assets'),
    };
    const controller = new V1AssetsController(assets as never, presign as never);

    await expect(controller.completeUpload({ actorId: 'actor-a' }, 'asset-1')).rejects.toMatchObject({ status: 400 });
    expect(assets.markUploaded).not.toHaveBeenCalled();
  });

  it.each([
    ['MIME type', { sizeBytes: 10, mimeType: 'image/jpeg', fileHash: 'f'.repeat(64) }],
    ['SHA-256', { sizeBytes: 10, mimeType: 'image/png', fileHash: '0'.repeat(64) }],
  ])('rejects upload completion when OSS %s does not match', async (_label, actual) => {
    const assets = {
      findOwned: jest.fn().mockResolvedValue({
        id: 'asset-1',
        ownerId: 'actor-a',
        objectKey: 'inputs/actor-a/file.png',
        sizeBytes: BigInt(10),
        mimeType: 'image/png',
        fileHash: 'f'.repeat(64),
      }),
      markUploaded: jest.fn(),
    };
    const presign = {
      inspectObject: jest.fn().mockResolvedValue(actual),
      getBucketName: jest.fn().mockReturnValue('sweetyshell-ai-assets'),
    };
    const controller = new V1AssetsController(assets as never, presign as never);

    await expect(controller.completeUpload({ actorId: 'actor-a' }, 'asset-1')).rejects.toMatchObject({ status: 400 });
    expect(assets.markUploaded).not.toHaveBeenCalled();
  });

  it('reports an unavailable OSS object as an invalid completion', async () => {
    const assets = {
      findOwned: jest.fn().mockResolvedValue({
        id: 'asset-1',
        ownerId: 'actor-a',
        objectKey: 'inputs/actor-a/missing.png',
        sizeBytes: BigInt(10),
        mimeType: 'image/png',
      }),
      markUploaded: jest.fn(),
    };
    const presign = {
      inspectObject: jest.fn().mockRejectedValue(new Error('NoSuchKey')),
      getBucketName: jest.fn().mockReturnValue('sweetyshell-ai-assets'),
    };
    const controller = new V1AssetsController(assets as never, presign as never);

    await expect(controller.completeUpload({ actorId: 'actor-a' }, 'asset-1')).rejects.toMatchObject({ status: 400 });
    expect(assets.markUploaded).not.toHaveBeenCalled();
  });

  it('does not issue a download URL for an unconfirmed upload', async () => {
    const assets = { findOwnedUploaded: jest.fn().mockResolvedValue(null) };
    const presign = { createDownloadUrl: jest.fn() };
    const controller = new V1AssetsController(assets as never, presign as never);

    await expect(controller.download({ actorId: 'actor-a' }, 'asset-pending')).rejects.toMatchObject({ status: 404 });
    expect(presign.createDownloadUrl).not.toHaveBeenCalled();
  });

  it('recovers the canonical asset when concurrent hash creation hits P2002', async () => {
    const hash = 'd'.repeat(64);
    const concurrentAsset = {
      id: 'asset-winner',
      objectKey: 'inputs/actor-a/winner.png',
    };
    const assets = {
      findByOwnerHash: jest.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(concurrentAsset),
      registerInput: jest.fn().mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique asset hash', {
          code: 'P2002',
          clientVersion: '5.22.0',
          meta: { target: ['owner_id', 'role', 'file_hash'] },
        }),
      ),
    };
    const presign = {
      isConfigured: jest.fn().mockReturnValue(true),
      getBucketName: jest.fn().mockReturnValue('sweetyshell-ai-assets'),
      createUploadTicket: jest.fn().mockReturnValue({ assetId: 'asset-winner' }),
    };
    const controller = new V1AssetsController(assets as never, presign as never);

    const result = await controller.createUploadTicket(
      { actorId: 'actor-a' },
      { filename: 'same.png', mimeType: 'image/png', sizeBytes: 10, sha256: hash },
    );

    expect(result).toMatchObject({ assetId: 'asset-winner' });
    expect(assets.findByOwnerHash).toHaveBeenCalledTimes(2);
    expect(presign.createUploadTicket).toHaveBeenCalledWith(
      'asset-winner',
      'inputs/actor-a/winner.png',
      'image/png',
      10,
      hash,
    );
  });
});
