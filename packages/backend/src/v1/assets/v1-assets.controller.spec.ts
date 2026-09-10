jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target,
  createParamDecorator: () => () => () => {},
  Controller: () => (target: unknown) => target,
  UseGuards: () => (target: unknown) => target,
  Post: () => () => {},
  Get: () => () => {},
  Body: () => () => {},
  Param: () => () => {},
  NotFoundException: class NotFoundException extends Error { status = 404; },
}));
jest.mock('ali-oss', () => class OSS {});

import { V1AssetsController } from './v1-assets.controller';

describe('V1AssetsController ownership', () => {
  it('does not create a download URL for an asset owned by another actor', async () => {
    const assets = { findOwned: jest.fn().mockResolvedValue(null), registerInput: jest.fn() };
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
    const presign = { isConfigured: jest.fn().mockReturnValue(true), createUploadTicket: jest.fn().mockReturnValue({ assetId: 'asset-1' }) };
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
    );
  });
});
