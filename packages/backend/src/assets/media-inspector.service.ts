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

@Injectable()
export class MediaInspectorService {
  constructor(@Inject(MEDIA_PROBE_RUNNER) private readonly runProbe: ProbeRunner) {}

  async inspect(url: string, expectedMime?: string): Promise<MediaMetadata> {
    let data: ProbeResponse;
    try { data = JSON.parse(await this.runProbe(url)) as ProbeResponse; } catch { throw new Error('MEDIA_INSPECTION_FAILED'); }
    const streams = data.streams ?? [];
    const video = streams.find((stream) => stream.codec_type === 'video');
    const audio = streams.find((stream) => stream.codec_type === 'audio');
    const duration = Number(data.format?.duration);
    const durationSeconds = Number.isFinite(duration) && duration > 0 ? rounded(duration) : undefined;
    const formatName = data.format?.format_name?.toLowerCase() ?? '';
    if (video && Number.isInteger(video.width) && Number.isInteger(video.height)) {
      const brand = data.format?.tags?.major_brand?.trim().toLowerCase() ?? '';
      const heifMime = ['heic', 'heix', 'hevc', 'hevx'].includes(brand)
        ? 'image/heic'
        : ['mif1', 'msf1'].includes(brand) ? 'image/heif' : null;
      if (heifMime && durationSeconds === undefined) {
        assertExpectedMime(heifMime, expectedMime);
        return { kind: 'image', width: video.width, height: video.height };
      }
      const imageMime: Record<string, string> = { png: 'image/png', mjpeg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp', tiff: 'image/tiff', gif: 'image/gif' };
      const detectedImageMime = imageMime[(video.codec_name ?? '').toLowerCase()];
      if (detectedImageMime && (formatName.includes('image2') || formatName.includes('gif') || durationSeconds === undefined)) {
        assertExpectedMime(detectedImageMime, expectedMime);
        return { kind: 'image', width: video.width, height: video.height };
      }
      if (!formatName.includes('mov') && !formatName.includes('mp4')) {
        throw new Error('MEDIA_FORMAT_UNSUPPORTED');
      }
      const detectedVideoMime = brand.startsWith('qt') ? 'video/quicktime' : 'video/mp4';
      assertExpectedMime(detectedVideoMime, expectedMime);
      const codec = video.codec_name?.toLowerCase();
      return {
        kind: 'video', width: video.width, height: video.height, durationSeconds,
        frameRate: frameRate(video.avg_frame_rate ?? video.r_frame_rate),
        videoCodec: codec === 'hevc' ? 'h265' : codec,
        ...(audio?.codec_name ? { audioCodec: audio.codec_name.toLowerCase() } : {}),
      };
    }
    if (audio && durationSeconds) {
      const detectedAudioMime = formatName.includes('wav') ? 'audio/wav' : formatName.includes('mp3') ? 'audio/mpeg' : null;
      if (!detectedAudioMime) throw new Error('MEDIA_FORMAT_UNSUPPORTED');
      assertExpectedMime(detectedAudioMime, expectedMime);
      return { kind: 'audio', durationSeconds, ...(audio.codec_name ? { audioCodec: audio.codec_name.toLowerCase() } : {}) };
    }
    throw new Error('MEDIA_INSPECTION_FAILED');
  }
}
