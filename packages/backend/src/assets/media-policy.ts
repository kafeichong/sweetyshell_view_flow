import { MediaMetadata } from './assets.service';

function invalid(code: string): never { throw new Error(code); }
function within(value: number | undefined, min: number, max: number, code: string) {
  if (!Number.isFinite(value) || value! < min || value! > max) invalid(code);
}
function validateImageDimensions(width: number | undefined, height: number | undefined, prefix: string) {
  within(width, 300, 6000, `${prefix}_DIMENSIONS_INVALID`);
  within(height, 300, 6000, `${prefix}_DIMENSIONS_INVALID`);
  within(width! / height!, 0.4, 2.5, `${prefix}_ASPECT_RATIO_INVALID`);
}

export function validateSeedanceMediaMetadata(mimeType: string, metadata: MediaMetadata): void {
  if (mimeType.startsWith('image/')) {
    if (metadata.kind !== 'image') invalid('MEDIA_KIND_MISMATCH');
    validateImageDimensions(metadata.width, metadata.height, 'IMAGE');
    return;
  }
  if (mimeType.startsWith('video/')) {
    if (metadata.kind !== 'video') invalid('MEDIA_KIND_MISMATCH');
    validateImageDimensions(metadata.width, metadata.height, 'VIDEO');
    within(metadata.durationSeconds, 2, 30, 'VIDEO_DURATION_INVALID');
    within(metadata.frameRate, 24, 60, 'VIDEO_FRAME_RATE_INVALID');
    if (!['h264', 'hevc', 'h265'].includes((metadata.videoCodec ?? '').toLowerCase())) invalid('VIDEO_CODEC_INVALID');
    return;
  }
  if (mimeType.startsWith('audio/')) {
    if (metadata.kind !== 'audio') invalid('MEDIA_KIND_MISMATCH');
    within(metadata.durationSeconds, 2, 30, 'AUDIO_DURATION_INVALID');
    return;
  }
  invalid('MEDIA_MIME_INVALID');
}
