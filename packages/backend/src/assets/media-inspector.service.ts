import { Inject, Injectable } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { MediaMetadata } from './assets.service';

const execFileAsync = promisify(execFile);
type ProbeRunner = (url: string) => Promise<string>;
export const MEDIA_PROBE_RUNNER = 'MEDIA_PROBE_RUNNER';

type ProbeStream = { codec_type?: string; width?: number; height?: number; codec_name?: string; r_frame_rate?: string };
type ProbeResponse = { format?: { duration?: string }; streams?: ProbeStream[] };

function frameRate(value?: string): number | undefined {
  if (!value) return undefined;
  const [numerator, denominator] = value.split('/').map(Number);
  const result = denominator ? numerator / denominator : numerator;
  return Number.isFinite(result) && result > 0 ? result : undefined;
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
    const durationSeconds = Number.isFinite(duration) && duration > 0 ? duration : undefined;
    if (video && Number.isInteger(video.width) && Number.isInteger(video.height)) {
      if (expectedMime?.toLowerCase().startsWith('image/')) {
        return { kind: 'image', width: video.width, height: video.height };
      }
      return { kind: 'video', width: video.width, height: video.height, durationSeconds, frameRate: frameRate(video.r_frame_rate), videoCodec: video.codec_name, audioCodec: audio?.codec_name };
    }
    if (audio && durationSeconds) return { kind: 'audio', durationSeconds, audioCodec: audio.codec_name };
    throw new Error('MEDIA_INSPECTION_FAILED');
  }
}
