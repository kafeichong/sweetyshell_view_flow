jest.mock('@nestjs/common', () => ({ Injectable: () => () => undefined, Inject: () => () => undefined }));

import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { defaultMediaProbeRunner, MediaInspectorService } from './media-inspector.service';

const hasTools = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0
  && spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0
  && spawnSync('cwebp', ['-version'], { stdio: 'ignore' }).status === 0;
const describeWithMediaTools = hasTools ? describe : describe.skip;

describeWithMediaTools('MediaInspectorService real ffprobe boundary', () => {
  let directory: string;
  const inspector = new MediaInspectorService(defaultMediaProbeRunner);

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'video-flow-media-'));
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it.each([
    ['png', 'image/png'],
    ['jpg', 'image/jpeg'],
    ['webp', 'image/webp'],
  ])('detects real %s image bytes', async (extension, mimeType) => {
    const path = join(directory, `image.${extension}`);
    if (extension === 'webp') {
      const source = join(directory, 'webp-source.png');
      execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=640x480', '-frames:v', '1', source]);
      execFileSync('cwebp', ['-quiet', source, '-o', path]);
    } else {
      execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=640x480', '-frames:v', '1', path]);
    }

    await expect(inspector.inspect(path, mimeType)).resolves.toEqual({
      kind: 'image', width: 640, height: 480,
    });
  });

  it.each([
    ['mp4', 'video/mp4'],
    ['mov', 'video/quicktime'],
  ])('detects real %s video container and streams', async (extension, mimeType) => {
    const path = join(directory, `clip.${extension}`);
    execFileSync('ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=720x576:r=24:d=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path,
    ]);

    await expect(inspector.inspect(path, mimeType)).resolves.toMatchObject({
      kind: 'video', width: 720, height: 576, durationSeconds: 2,
      frameRate: 24, videoCodec: 'h264',
    });
  });

  it.each([
    ['wav', 'audio/wav'],
    ['mp3', 'audio/mpeg'],
  ])('detects real %s audio format and duration', async (extension, mimeType) => {
    const path = join(directory, `audio.${extension}`);
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', path]);

    await expect(inspector.inspect(path, mimeType)).resolves.toMatchObject({
      kind: 'audio', durationSeconds: expect.closeTo(2, 3),
    });
  });
});
