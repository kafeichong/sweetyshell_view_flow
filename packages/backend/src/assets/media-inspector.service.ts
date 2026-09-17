import { Inject, Injectable } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { MediaMetadata } from './assets.service';

const execFileAsync = promisify(execFile);
type ProbeRunner = (url: string) => Promise<string>;
export const MEDIA_PROBE_RUNNER = 'MEDIA_PROBE_RUNNER';

type ProbeStream = {
  codec_type?: string;
  width?: number;
  height?: number;
  codec_name?: string;
  duration?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
};
type ProbeResponse = {
  format?: { duration?: string; format_name?: string; tags?: { major_brand?: string } };
  streams?: ProbeStream[];
};

function frameRate(value?: string): number | undefined {
  if (!value) return undefined;
  const [numerator, denominator] = value.split('/').map(Number);
  const result = denominator ? numerator / denominator : numerator;
  return Number.isFinite(result) && result > 0 ? rounded(result) : undefined;
}

// mp3 的时长靠帧计数，不同 ffprobe 版本会对**同一个文件**给出不同的值（实测同一个 10 秒
// mp3：容器里的 5.1.9 报 10.03102、本机 8.0.1 报 10.0）。预检元数据是按内容摘要与服务端
// 逐字段比对的，两边版本不同就会在正式提交时撞 PREFLIGHT_ACTUAL_CONTENT_MISMATCH——
// 2026-09-16 首次提交纯音频任务时真实踩到。所以音频时长统一按 0.1 秒归一；它不进入计费
// 公式（只用于官方 2–30 秒的限制），这个粒度足够。视频时长不归一：它跨版本一致，且进计费。
function stableAudioDuration(value: number): number {
  return Math.round(value * 10) / 10;
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function assertExpectedMime(actual: string, expected?: string): void {
  if (expected && actual !== expected.split(';')[0].trim().toLowerCase()) {
    throw new Error('MEDIA_MIME_MISMATCH');
  }
}

export const defaultMediaProbeRunner: ProbeRunner = async (url) => {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-show_format', '-show_streams', '-of', 'json', url,
    ], { timeout: 15_000, maxBuffer: 1024 * 1024 });
    return stdout;
};

// 版本号的定义搬去了 ./media-inspector-version（那里没有依赖，见该文件里写的理由）。这里
// 继续转出去，让既有的 `from './media-inspector.service'` 引用不用改。
export { MEDIA_INSPECTOR_VERSION } from './media-inspector-version';

@Injectable()
export class MediaInspectorService {
  constructor(@Inject(MEDIA_PROBE_RUNNER) private readonly runProbe: ProbeRunner) {}

  async inspect(url: string, expectedMime?: string): Promise<MediaMetadata> {
    return (await this.inspectWithMime(url, expectedMime)).metadata;
  }

  /**
   * 同 `inspect`，但把**探测出来的 MIME** 一并交出来。
   *
   * 常规上传路径用不上它：MIME 由客户端声明、服务端只做一致性约束。但私域素材库的
   * 素材是我们自己去取的，没有谁声明过 MIME，而 Asset 行需要它——所以那条路需要这个。
   *
   * 注意它不能并进 `MediaMetadata` 里：那个对象会原样存进 `assets.media_metadata`，
   * 再与客户端按字段摘要比对；多一个字段就会让所有既有上传件的比对失败。
   */
  async inspectWithMime(
    url: string,
    expectedMime?: string,
  ): Promise<{ metadata: MediaMetadata; mimeType: string }> {
    let data: ProbeResponse;
    try { data = JSON.parse(await this.runProbe(url)) as ProbeResponse; } catch { throw new Error('MEDIA_INSPECTION_FAILED'); }
    const streams = data.streams ?? [];
    const video = streams.find((stream) => stream.codec_type === 'video');
    const audio = streams.find((stream) => stream.codec_type === 'audio');
    // 时长取**流**的 duration，优先视频流、其次音频流，最后才退回容器。
    // 容器的 `format.duration` 在不同 ffprobe 版本间会给出不同的值（同一个 mp4：5.1.9 报
    // 5.077333、8.0.1 报 5.041667），而预检元数据要按内容摘要比对——客户端与后端用的
    // ffprobe 版本不同时，摘要就对不上，提交会被 PREFLIGHT_ACTUAL_CONTENT_MISMATCH 拒掉。
    // 流的 duration 跨版本一致，而且官方限制说的也是视频本身的时长。
    const streamDuration = Number(video?.duration ?? audio?.duration);
    const containerDuration = Number(data.format?.duration);
    const duration = Number.isFinite(streamDuration) && streamDuration > 0 ? streamDuration : containerDuration;
    const durationSeconds = Number.isFinite(duration) && duration > 0 ? rounded(duration) : undefined;
    const formatName = data.format?.format_name?.toLowerCase() ?? '';
    if (video && Number.isInteger(video.width) && Number.isInteger(video.height)) {
      const brand = data.format?.tags?.major_brand?.trim().toLowerCase() ?? '';
      const heifMime = ['heic', 'heix', 'hevc', 'hevx'].includes(brand)
        ? 'image/heic'
        : ['mif1', 'msf1'].includes(brand) ? 'image/heif' : null;
      if (heifMime && durationSeconds === undefined) {
        assertExpectedMime(heifMime, expectedMime);
        return { metadata: { kind: 'image', width: video.width, height: video.height }, mimeType: heifMime };
      }
      const imageMime: Record<string, string> = { png: 'image/png', mjpeg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp', tiff: 'image/tiff', gif: 'image/gif' };
      const detectedImageMime = imageMime[(video.codec_name ?? '').toLowerCase()];
      if (detectedImageMime && (formatName.includes('image2') || formatName.includes('gif') || durationSeconds === undefined)) {
        assertExpectedMime(detectedImageMime, expectedMime);
        return { metadata: { kind: 'image', width: video.width, height: video.height }, mimeType: detectedImageMime };
      }
      if (!formatName.includes('mov') && !formatName.includes('mp4')) {
        throw new Error('MEDIA_FORMAT_UNSUPPORTED');
      }
      const detectedVideoMime = brand.startsWith('qt') ? 'video/quicktime' : 'video/mp4';
      assertExpectedMime(detectedVideoMime, expectedMime);
      const codec = video.codec_name?.toLowerCase();
      return {
        metadata: {
          kind: 'video', width: video.width, height: video.height, durationSeconds,
          frameRate: frameRate(video.avg_frame_rate ?? video.r_frame_rate),
          videoCodec: codec === 'hevc' ? 'h265' : codec,
          ...(audio?.codec_name ? { audioCodec: audio.codec_name.toLowerCase() } : {}),
        },
        mimeType: detectedVideoMime,
      };
    }
    if (audio && durationSeconds) {
      const detectedAudioMime = formatName.includes('wav') ? 'audio/wav' : formatName.includes('mp3') ? 'audio/mpeg' : null;
      if (!detectedAudioMime) throw new Error('MEDIA_FORMAT_UNSUPPORTED');
      assertExpectedMime(detectedAudioMime, expectedMime);
      return {
        metadata: { kind: 'audio', durationSeconds: stableAudioDuration(durationSeconds), ...(audio.codec_name ? { audioCodec: audio.codec_name.toLowerCase() } : {}) },
        mimeType: detectedAudioMime,
      };
    }
    throw new Error('MEDIA_INSPECTION_FAILED');
  }
}
