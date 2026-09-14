jest.mock('@nestjs/common', () => ({ Injectable: () => () => undefined, Inject: () => () => undefined }));

import { MediaInspectorService } from './media-inspector.service';

describe('MediaInspectorService', () => {
  it('normalizes a video ffprobe response into durable metadata', async () => {
    const inspect = new MediaInspectorService(async () => JSON.stringify({
      format: { duration: '12.5' },
      streams: [
        { codec_type: 'video', width: 1280, height: 720, codec_name: 'h264', r_frame_rate: '30000/1001' },
        { codec_type: 'audio', codec_name: 'aac' },
      ],
    }));

    await expect(inspect.inspect('https://oss.example/signed.mp4')).resolves.toEqual({
      kind: 'video', width: 1280, height: 720, durationSeconds: 12.5,
      frameRate: 29.97002997002997, videoCodec: 'h264', audioCodec: 'aac',
    });
  });

  it('rejects an ffprobe response without a media stream', async () => {
    const inspect = new MediaInspectorService(async () => JSON.stringify({ format: {}, streams: [] }));
    await expect(inspect.inspect('https://oss.example/invalid')).rejects.toThrow('MEDIA_INSPECTION_FAILED');
  });
  it('classifies a probed raster stream as an image when the uploaded MIME is image/*', async () => {
    const service = new MediaInspectorService(async () => JSON.stringify({ streams: [{ codec_type: 'video', width: 1280, height: 1280, codec_name: 'png' }] }));
    await expect(service.inspect('https://signed/image.png', 'image/png')).resolves.toEqual({ kind: 'image', width: 1280, height: 1280 });
  });

});
