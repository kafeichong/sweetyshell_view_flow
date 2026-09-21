jest.mock('ali-oss', () => class OSS {});
jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target,
  Logger: class Logger { debug() {} },
  NotFoundException: class NotFoundException extends Error { status = 404; },
}));

import { TaskShowcaseService } from './task-showcase.service';

describe('TaskShowcaseService', () => {
  it('publishes image and video inputs in frozen execution-plan order', async () => {
    const prisma = {
      task: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'task-1',
          actorId: 'actor-1',
          status: 'completed',
          prompt: 'prompt',
          executionPlan: {
            workflowKey: 'seedance.omni-reference.v1',
            media: [
              { assetId: 'image-1', role: 'reference_image', mimeType: 'image/png', metadata: { kind: 'image', width: 1280, height: 720 } },
              { assetId: 'video-1', role: 'reference_video', mimeType: 'video/mp4', metadata: { kind: 'video', width: 720, height: 1280, durationSeconds: 5 } },
              { assetId: 'audio-1', role: 'reference_audio', mimeType: 'audio/mpeg', metadata: { kind: 'audio', durationSeconds: 5 } },
              { assetId: 'missing-1', role: 'reference_image', mimeType: 'image/jpeg', metadata: { kind: 'image' } },
            ],
          },
          assets: [{ id: 'output-1', objectKey: 'outputs/result.mp4', mimeType: 'video/mp4', sizeBytes: BigInt(30) }],
          createdAt: new Date('2026-09-20T00:00:00Z'),
          completedAt: new Date('2026-09-20T00:01:00Z'),
        }),
      },
      actorCredential: {
        findUnique: jest.fn().mockResolvedValue({ name: '测试用户' }),
      },
      asset: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'video-1', objectKey: 'inputs/reference.mp4', mimeType: 'video/mp4', sizeBytes: BigInt(20), mediaMetadata: { kind: 'video', width: 720, height: 1280, durationSeconds: 5 } },
          { id: 'image-1', objectKey: 'inputs/reference.png', mimeType: 'image/png', sizeBytes: BigInt(10), mediaMetadata: { kind: 'image', width: 1280, height: 720 } },
        ]),
      },
    };
    const presign = {
      createDownloadUrl: jest.fn((objectKey: string) => ({ downloadUrl: `https://media.example/${objectKey}`, expiresIn: 900 })),
    };
    const service = new TaskShowcaseService(prisma as never, presign as never);

    const result = await service.getTaskDetail('task-1') as Record<string, unknown>;

    expect(prisma.asset.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['image-1', 'video-1', 'missing-1'] }, role: 'input' },
      select: { id: true, objectKey: true, mimeType: true, sizeBytes: true, mediaMetadata: true },
    });
    expect(result.inputAssets).toEqual([
      {
        id: 'image-1',
        role: 'reference_image',
        mimeType: 'image/png',
        sizeBytes: 10,
        metadata: { kind: 'image', width: 1280, height: 720 },
        downloadUrl: 'https://media.example/inputs/reference.png',
        expiresIn: 900,
      },
      {
        id: 'video-1',
        role: 'reference_video',
        mimeType: 'video/mp4',
        sizeBytes: 20,
        metadata: { kind: 'video', width: 720, height: 1280, durationSeconds: 5 },
        downloadUrl: 'https://media.example/inputs/reference.mp4',
        expiresIn: 900,
      },
    ]);
  });
});
