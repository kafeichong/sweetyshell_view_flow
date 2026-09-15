jest.mock('@nestjs/common', () => ({ Injectable: () => () => undefined, Inject: () => () => undefined }));

import { MediaInspectorService } from './media-inspector.service';

describe('MediaInspectorService', () => {
  it('normalizes a video ffprobe response into durable metadata', async () => {
    const inspect = new MediaInspectorService(async () => JSON.stringify({
      format: { duration: '12.5', format_name: 'mov,mp4,m4a,3gp,3g2,mj2', tags: { major_brand: 'isom' } },
      streams: [
        { codec_type: 'video', width: 1280, height: 720, codec_name: 'h264', r_frame_rate: '30000/1001' },
        { codec_type: 'audio', codec_name: 'aac' },
      ],
    }));

    await expect(inspect.inspect('https://oss.example/signed.mp4')).resolves.toEqual({
      kind: 'video', width: 1280, height: 720, durationSeconds: 12.5,
      frameRate: 29.97003, videoCodec: 'h264', audioCodec: 'aac',
    });
  });

  it('rejects an ffprobe response without a media stream', async () => {
    const inspect = new MediaInspectorService(async () => JSON.stringify({ format: {}, streams: [] }));
    await expect(inspect.inspect('https://oss.example/invalid')).rejects.toThrow('MEDIA_INSPECTION_FAILED');
  });
  it('classifies a probed raster stream as an image when the uploaded MIME is image/*', async () => {
    const service = new MediaInspectorService(async () => JSON.stringify({
      format: { format_name: 'image2' },
      streams: [{ codec_type: 'video', width: 1280, height: 1280, codec_name: 'png' }],
    }));
    await expect(service.inspect('https://signed/image.png', 'image/png')).resolves.toEqual({ kind: 'image', width: 1280, height: 1280 });
  });

  it('rejects a real video stream even when the caller declares image MIME', async () => {
    const service = new MediaInspectorService(async () => JSON.stringify({
      format: { duration: '5', format_name: 'mov,mp4,m4a,3gp,3g2,mj2', tags: { major_brand: 'isom' } },
      streams: [{ codec_type: 'video', width: 1280, height: 720, codec_name: 'h264', avg_frame_rate: '24/1' }],
    }));

    await expect(service.inspect('https://signed/not-an-image.png', 'image/png')).rejects.toThrow('MEDIA_MIME_MISMATCH');
  });

  it.each([
    ['matroska,webm', 'webm'],
    ['matroska', 'mkv'],
  ])('rejects an unsupported %s container instead of relabeling it as mp4', async (formatName, extension) => {
    const service = new MediaInspectorService(async () => JSON.stringify({
      format: { duration: '5', format_name: formatName },
      streams: [{ codec_type: 'video', width: 1280, height: 720, codec_name: 'h264', avg_frame_rate: '24/1' }],
    }));

    await expect(service.inspect(`https://signed/clip.${extension}`)).rejects.toThrow('MEDIA_FORMAT_UNSUPPORTED');
  });

  it('detects image MIME from the probed codec instead of the filename or declaration', async () => {
    const service = new MediaInspectorService(async () => JSON.stringify({
      format: { format_name: 'image2' },
      streams: [{ codec_type: 'video', width: 640, height: 480, codec_name: 'png' }],
    }));

    await expect(service.inspect('https://signed/fake.jpg', 'image/jpeg')).rejects.toThrow('MEDIA_MIME_MISMATCH');
  });

  it('normalizes floating metadata to six decimals and identifies QuickTime from its file brand', async () => {
    const service = new MediaInspectorService(async () => JSON.stringify({
      format: { duration: '2.0000004', format_name: 'mov,mp4,m4a,3gp,3g2,mj2', tags: { major_brand: 'qt  ' } },
      streams: [{ codec_type: 'video', width: 720, height: 576, codec_name: 'hevc', avg_frame_rate: '30000/1001' }],
    }));

    await expect(service.inspect('https://signed/clip.mov', 'video/quicktime')).resolves.toEqual({
      kind: 'video', width: 720, height: 576, durationSeconds: 2,
      frameRate: 29.97003, videoCodec: 'h265',
    });
  });

  it.each([
    ['heic', 'image/heic'],
    ['mif1', 'image/heif'],
  ])('identifies an HEVC still-image brand %s as %s', async (majorBrand, mimeType) => {
    const service = new MediaInspectorService(async () => JSON.stringify({
      format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', tags: { major_brand: majorBrand } },
      streams: [{ codec_type: 'video', width: 1280, height: 720, codec_name: 'hevc', avg_frame_rate: '0/0' }],
    }));

    await expect(service.inspect('https://signed/still', mimeType)).resolves.toEqual({
      kind: 'image', width: 1280, height: 720,
    });
  });

});
