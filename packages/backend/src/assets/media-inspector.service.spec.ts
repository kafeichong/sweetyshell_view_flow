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

  it('prefers the stream duration over the container duration, which varies by ffprobe version', async () => {
    // 同一个 mp4：容器 ffprobe 5.1.9 报 5.077333、8.0.1 报 5.041667，而**流的时长**两边都是
    // 5.041667。预检元数据要按内容摘要逐字段比对，用容器时长会让客户端与后端对不上，
    // 提交被 PREFLIGHT_ACTUAL_CONTENT_MISMATCH 拒掉（2026-09-16 真实踩过）。
    const inspect = new MediaInspectorService(async () => JSON.stringify({
      format: { duration: '5.077333', format_name: 'mov,mp4,m4a,3gp,3g2,mj2', tags: { major_brand: 'isom' } },
      streams: [
        { codec_type: 'video', width: 1280, height: 720, codec_name: 'h264', duration: '5.041667', r_frame_rate: '24/1' },
        { codec_type: 'audio', codec_name: 'aac', duration: '5.041667' },
      ],
    }));

    await expect(inspect.inspect('https://oss.example/tea.mp4')).resolves.toMatchObject({
      kind: 'video', durationSeconds: 5.041667,
    });
  });

  it('normalizes an audio duration to a tenth of a second, which mp3 frame counting varies by version', async () => {
    // 同一个 mp3：容器里的 ffprobe 5.1.9 报 10.03102、本机 8.0.1 报 10.0（mp3 的时长靠帧计数，
    // 版本间算法不同）。音频时长按 0.1 秒归一，两边的摘要才对得上；它不进入计费公式，
    // 只用于官方 2–30 秒的限制，这个粒度足够（2026-09-16 首次提交纯音频任务时真实踩到）。
    const inspect = new MediaInspectorService(async () => JSON.stringify({
      format: { duration: '10.03102', format_name: 'mp3' },
      streams: [{ codec_type: 'audio', codec_name: 'mp3', duration: '10.03102' }],
    }));

    await expect(inspect.inspect('https://oss.example/song.mp3')).resolves.toEqual({
      kind: 'audio', durationSeconds: 10, audioCodec: 'mp3',
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

  // ffprobe 9.0 起 `major_brand` 会给分号拼起来的品牌列表（同一个文件 8.x 是 `qt`、9.x 是
  // `isom;qt`）。只看开头会把后者判成 mp4，与客户端对不上——同事机上真实踩到：随包的 ffprobe
  // 是 9.0.1、服务端是 8.x，同一份素材两边判出不同 mime，正式提交被 400 拒掉。
  it.each([
    ['qt  ', 'video/quicktime'],
    ['isom;qt  ', 'video/quicktime'],
    ['isom', 'video/mp4'],
    ['mp42', 'video/mp4'],
  ])('reads the container brand list %j as %s', async (majorBrand, mimeType) => {
    const service = new MediaInspectorService(async () => JSON.stringify({
      format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', tags: { major_brand: majorBrand } },
      streams: [{ codec_type: 'video', width: 720, height: 576, codec_name: 'h264', avg_frame_rate: '30/1', duration: '5' }],
    }));

    await expect(service.inspect('https://signed/clip.mp4', mimeType)).resolves.toMatchObject({ kind: 'video' });
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
