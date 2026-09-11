jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target,
  ServiceUnavailableException: class ServiceUnavailableException extends Error {},
}));
jest.mock('ali-oss', () => class OSS {});

import { AssetPresignService } from './asset-presign.service';

describe('AssetPresignService object verification', () => {
  it('signs and returns the SHA-256 metadata header required by completion', () => {
    const service = new AssetPresignService();
    const signatureUrl = jest.fn().mockReturnValue('https://oss.test/signed');
    (service as any).client = { signatureUrl };
    const hash = 'a'.repeat(64);

    const ticket = service.createUploadTicket(
      'asset-1',
      'inputs/actor-a/file.png',
      'image/png',
      10,
      hash,
    );

    expect(ticket.uploadHeaders).toEqual({
      'Content-Type': 'image/png',
      'Content-Length': '10',
      'x-oss-meta-sha256': hash,
    });
    expect(signatureUrl).toHaveBeenCalledWith(
      'inputs/actor-a/file.png',
      expect.objectContaining({
        method: 'PUT',
        'Content-Type': 'image/png',
        'x-oss-meta-sha256': hash,
      }),
    );
  });

  it('normalizes OSS HEAD metadata used by upload completion', async () => {
    const service = new AssetPresignService();
    (service as any).client = {
      head: jest.fn().mockResolvedValue({
        res: {
          headers: {
            'content-length': '10',
            'content-type': 'image/png',
            'x-oss-meta-sha256': 'A'.repeat(64),
          },
        },
      }),
    };

    await expect(service.inspectObject('inputs/actor-a/file.png')).resolves.toEqual({
      sizeBytes: 10,
      mimeType: 'image/png',
      fileHash: 'a'.repeat(64),
    });
  });
});
