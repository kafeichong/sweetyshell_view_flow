jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target,
  Inject: () => () => undefined,
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
  ConflictException: class ConflictException extends Error {
    status = 409;
    constructor(public response: unknown) {
      super(typeof response === 'string' ? response : (response as { message: string })?.message);
    }
  },
}));
jest.mock('ali-oss', () => class OSS {});

import { V1AssetsController } from './v1-assets.controller';
import { MEDIA_INSPECTOR_VERSION } from '../../assets/media-inspector.service';
import { Prisma } from '@prisma/client';

describe('V1AssetsController ownership', () => {
  it('returns the latest owned output with a fresh download URL', async () => {
    const assets = {
      findLatestOwnedOutputForTask: jest.fn().mockResolvedValue({
        id: 'asset-output',
        objectKey: 'videos/2026/09/11/output.mp4',
        mimeType: 'video/mp4',
        sizeBytes: BigInt(12),
      }),
    };
    const presign = {
      createDownloadUrl: jest.fn().mockReturnValue({
        downloadUrl: 'https://oss.test/signed',
        expiresIn: 300,
      }),
    };
    const tasks = {
      findOneForActor: jest
        .fn()
        .mockResolvedValue({ id: 'task-1', deliveryStatus: 'ready' }),
    };
    const controller = new V1AssetsController(
      assets as never,
      presign as never,
      tasks as never,
    );

    const result = await controller.taskResult(
      { actorId: 'actor-a' },
      'task-1',
    );

    expect(tasks.findOneForActor).toHaveBeenCalledWith('task-1', 'actor-a');
    expect(assets.findLatestOwnedOutputForTask).toHaveBeenCalledWith(
      'task-1',
      'actor-a',
    );
    expect(result).toEqual({
      taskId: 'task-1',
      assetId: 'asset-output',
      objectKey: 'videos/2026/09/11/output.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 12,
      downloadUrl: 'https://oss.test/signed',
      expiresIn: 300,
    });
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('does not expose another actor task result', async () => {
    const assets = { findLatestOwnedOutputForTask: jest.fn() };
    const presign = { createDownloadUrl: jest.fn() };
    const tasks = { findOneForActor: jest.fn().mockResolvedValue(null) };
    const controller = new V1AssetsController(
      assets as never,
      presign as never,
      tasks as never,
    );

    await expect(
      controller.taskResult({ actorId: 'actor-a' }, 'task-other'),
    ).rejects.toMatchObject({ status: 404 });
    expect(assets.findLatestOwnedOutputForTask).not.toHaveBeenCalled();
    expect(presign.createDownloadUrl).not.toHaveBeenCalled();
  });

  it('distinguishes still-generating, delivery-failed and review results', async () => {
    const buildController = (task: Record<string, unknown>) =>
      new V1AssetsController(
        { findLatestOwnedOutputForTask: jest.fn() } as never,
        { createDownloadUrl: jest.fn() } as never,
        { findOneForActor: jest.fn().mockResolvedValue(task) } as never,
      );

    const cases: Array<[Record<string, unknown>, string]> = [
      [{ id: 'task-1', deliveryStatus: 'archiving', taskStatus: 'in_progress' }, 'RESULT_NOT_READY'],
      [{ id: 'task-1', deliveryStatus: 'not_started', taskStatus: 'pending' }, 'RESULT_NOT_READY'],
      [{ id: 'task-1', deliveryStatus: 'failed', taskStatus: 'failed' }, 'DELIVERY_FAILED'],
      [
        { id: 'task-1', deliveryStatus: 'not_started', taskStatus: 'requires_review' },
        'RESULT_REQUIRES_REVIEW',
      ],
    ];

    for (const [task, expectedCode] of cases) {
      await expect(
        buildController(task).taskResult({ actorId: 'actor-a' }, 'task-1'),
      ).rejects.toMatchObject({ status: 409, response: { message: expectedCode } });
    }
  });

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
      alignPendingUpload: jest.fn(),
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
      alignPendingUpload: jest.fn(),
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
    // 复用时要先把行上的 mime/size 对齐到新票据，否则 complete 拿 OSS 的新 Content-Type 跟行里
    // 的旧值比，会恒定报"与票据不符"（踩过：ffprobe 升到 9.0 后同一个 mov 的判定从 mp4 变 quicktime）。
    expect(assets.alignPendingUpload).toHaveBeenCalledWith('asset-existing', 'image/png', 10);
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
        inspectionStatus: 'verified',
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
      inspectionStatus: 'verified',
    });
    expect(presign.createUploadTicket).not.toHaveBeenCalled();
  });

  it('requires actual-content inspection before reusing a legacy uploaded asset', async () => {
    const hash = '9'.repeat(64);
    const assets = {
      findByOwnerHash: jest.fn().mockResolvedValue({
        id: 'asset-legacy', objectKey: 'inputs/actor-a/legacy.png', inspectionStatus: 'uploaded',
      }),
      registerInput: jest.fn(),
    };
    const presign = { isConfigured: jest.fn().mockReturnValue(true), createUploadTicket: jest.fn() };
    const controller = new V1AssetsController(assets as never, presign as never);

    await expect(controller.createUploadTicket(
      { actorId: 'actor-a' },
      { filename: 'same.png', mimeType: 'image/png', sizeBytes: 10, sha256: hash },
    )).resolves.toEqual({
      assetId: 'asset-legacy', objectKey: 'inputs/actor-a/legacy.png', alreadyUploaded: true,
      requiresInspection: true, inspectionStatus: 'uploaded',
    });
    expect(presign.createUploadTicket).not.toHaveBeenCalled();
  });

  it('records the content hash when creating a new asset', async () => {
    const hash = 'b'.repeat(64);
    const assets = {
      findOwned: jest.fn(),
      alignPendingUpload: jest.fn(),
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
        inspectionStatus: 'verified',
      }),
    };
    const presign = {
      inspectObject: jest.fn().mockResolvedValue({
        sizeBytes: 10,
        mimeType: 'image/png',
        fileHash: hash,
      }),
      getBucketName: jest.fn().mockReturnValue('sweetyshell-ai-assets'),
      createDownloadUrl: jest.fn().mockReturnValue({ downloadUrl: 'https://oss/signed-image' }),
    };
    const inspector = { inspect: jest.fn().mockResolvedValue({ kind: 'image', width: 500, height: 500 }) };
    const controller = new V1AssetsController(assets as never, presign as never, undefined, inspector as never);

    const result = await controller.completeUpload({ actorId: 'actor-a' }, 'asset-1');

    expect(result).toMatchObject({
      assetId: 'asset-1',
      sizeBytes: 10,
      inspectionStatus: 'verified',
    });
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(assets.markUploaded).toHaveBeenCalledWith('asset-1', 'actor-a', {
      bucket: 'sweetyshell-ai-assets',
      sizeBytes: 10,
      mimeType: 'image/png',
      mediaMetadata: { kind: 'image', width: 500, height: 500 },
      // 落版本号：内容寻址复用不会重检旧资产，没有它就没法判断哪些资产需要重检。
      inspectorVersion: MEDIA_INSPECTOR_VERSION,
      inspectionStatus: 'verified',
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

describe('V1AssetsController official Seedance media ticket policy', () => {
  function buildTicketController() {
    const assets = {
      findByOwnerHash: jest.fn().mockResolvedValue(null),
      registerInput: jest.fn().mockResolvedValue({ id: 'asset-media', objectKey: 'inputs/actor-a/media' }),
    };
    const presign = {
      isConfigured: jest.fn().mockReturnValue(true),
      getBucketName: jest.fn().mockReturnValue('sweetyshell-ai-assets'),
      createUploadTicket: jest.fn().mockReturnValue({ assetId: 'asset-media' }),
    };
    return { assets, presign, controller: new V1AssetsController(assets as never, presign as never) };
  }

  it.each([
    ['video', 'source.mov', 'video/quicktime', 200 * 1024 * 1024],
    ['audio', 'voice.wav', 'audio/wav', 15 * 1024 * 1024],
  ])('issues an official %s input ticket within its per-file size limit', async (mediaType, filename, mimeType, sizeBytes) => {
    const { assets, controller } = buildTicketController();

    await controller.createUploadTicket({ actorId: 'actor-a' }, { filename, mimeType, sizeBytes });

    expect(assets.registerInput).toHaveBeenCalledWith(expect.objectContaining({
      mediaType,
      mimeType,
      sizeBytes,
    }));
  });

  it('rejects a video ticket over the official 200MB per-file limit', async () => {
    const { controller } = buildTicketController();

    await expect(controller.createUploadTicket(
      { actorId: 'actor-a' },
      { filename: 'oversized.mp4', mimeType: 'video/mp4', sizeBytes: 200 * 1024 * 1024 + 1 },
    )).rejects.toMatchObject({ status: 400, message: 'sizeBytes must be between 1 and 209715200 for video' });
  });

  it('rejects an image ticket at the exclusive 30MB boundary', async () => {
    const { controller } = buildTicketController();

    await expect(controller.createUploadTicket(
      { actorId: 'actor-a' },
      { filename: 'boundary.png', mimeType: 'image/png', sizeBytes: 30 * 1024 * 1024 },
    )).rejects.toMatchObject({ status: 400 });
  });
});

describe('V1AssetsController media inspection', () => {
  const asset = { id: 'asset-1', ownerId: 'actor-a', objectKey: 'inputs/a.mp4', sizeBytes: BigInt(10), mimeType: 'video/mp4', fileHash: null };
  const actual = { sizeBytes: 10, mimeType: 'video/mp4', fileHash: undefined };
  it('persists inspected metadata before marking an upload complete', async () => {
    const assets = { findOwned: jest.fn().mockResolvedValue(asset), markUploaded: jest.fn().mockResolvedValue({ ...asset, bucket: 'bucket', inspectionStatus: 'verified' }) };
    const presign = { inspectObject: jest.fn().mockResolvedValue(actual), getBucketName: jest.fn().mockReturnValue('bucket'), createDownloadUrl: jest.fn().mockReturnValue({ downloadUrl: 'https://oss/signed' }) };
    const inspector = { inspect: jest.fn().mockResolvedValue({ kind: 'video', width: 1280, height: 720, durationSeconds: 5, frameRate: 24, videoCodec: 'h264' }) };
    const controller = new V1AssetsController(assets as never, presign as never, undefined, inspector as never);
    await controller.completeUpload({ actorId: 'actor-a' }, 'asset-1');
    expect(inspector.inspect).toHaveBeenCalledWith('https://oss/signed', 'video/mp4');
    expect(assets.markUploaded).toHaveBeenCalledWith('asset-1', 'actor-a', expect.objectContaining({
      mediaMetadata: expect.objectContaining({ kind: 'video', width: 1280 }),
      inspectionStatus: 'verified',
    }));
  });
  it('does not mark an upload complete when media inspection fails', async () => {
    const assets = { findOwned: jest.fn().mockResolvedValue(asset), markUploaded: jest.fn() };
    const presign = { inspectObject: jest.fn().mockResolvedValue(actual), getBucketName: jest.fn().mockReturnValue('bucket'), createDownloadUrl: jest.fn().mockReturnValue({ downloadUrl: 'https://oss/signed' }) };
    const inspector = { inspect: jest.fn().mockRejectedValue(new Error('MEDIA_INSPECTION_FAILED')) };
    const controller = new V1AssetsController(assets as never, presign as never, undefined, inspector as never);
    await expect(controller.completeUpload({ actorId: 'actor-a' }, 'asset-1')).rejects.toMatchObject({ status: 400 });
    expect(assets.markUploaded).not.toHaveBeenCalled();
  });

  it('does not verify an image whose actual size reaches the exclusive 30MB boundary', async () => {
    const boundaryAsset = { ...asset, objectKey: 'inputs/a.png', sizeBytes: BigInt(30 * 1024 * 1024), mimeType: 'image/png' };
    const assets = { findOwned: jest.fn().mockResolvedValue(boundaryAsset), markUploaded: jest.fn() };
    const presign = {
      inspectObject: jest.fn().mockResolvedValue({ sizeBytes: 30 * 1024 * 1024, mimeType: 'image/png', fileHash: undefined }),
      getBucketName: jest.fn().mockReturnValue('bucket'),
      createDownloadUrl: jest.fn().mockReturnValue({ downloadUrl: 'https://oss/signed' }),
    };
    const inspector = { inspect: jest.fn().mockResolvedValue({ kind: 'image', width: 640, height: 480 }) };
    const controller = new V1AssetsController(assets as never, presign as never, undefined, inspector as never);

    await expect(controller.completeUpload({ actorId: 'actor-a' }, 'asset-1')).rejects.toMatchObject({ status: 400 });
    expect(assets.markUploaded).not.toHaveBeenCalled();
  });

  it('fails closed when the actual-content inspector is unavailable', async () => {
    const assets = { findOwned: jest.fn().mockResolvedValue(asset), markUploaded: jest.fn() };
    const presign = {
      inspectObject: jest.fn().mockResolvedValue(actual),
      getBucketName: jest.fn().mockReturnValue('bucket'),
      createDownloadUrl: jest.fn(),
    };
    const controller = new V1AssetsController(assets as never, presign as never);

    await expect(controller.completeUpload({ actorId: 'actor-a' }, 'asset-1')).rejects.toMatchObject({ status: 503 });
    expect(assets.markUploaded).not.toHaveBeenCalled();
  });
});
