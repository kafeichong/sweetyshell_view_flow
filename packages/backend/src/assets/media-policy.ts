import { MediaMetadata } from './assets.service';

export type SeedanceInputMediaPolicy = {
  mediaType: 'image' | 'video' | 'audio';
  maxSizeBytes: number;
  maximumInclusive: boolean;
};

export const SEEDANCE_INPUT_MEDIA_POLICIES: Readonly<Record<string, SeedanceInputMediaPolicy>> = {
  'image/jpeg': { mediaType: 'image', maxSizeBytes: 30 * 1024 * 1024, maximumInclusive: false },
  'image/png': { mediaType: 'image', maxSizeBytes: 30 * 1024 * 1024, maximumInclusive: false },
  'image/webp': { mediaType: 'image', maxSizeBytes: 30 * 1024 * 1024, maximumInclusive: false },
  'image/bmp': { mediaType: 'image', maxSizeBytes: 30 * 1024 * 1024, maximumInclusive: false },
  'image/tiff': { mediaType: 'image', maxSizeBytes: 30 * 1024 * 1024, maximumInclusive: false },
  'image/gif': { mediaType: 'image', maxSizeBytes: 30 * 1024 * 1024, maximumInclusive: false },
  'image/heic': { mediaType: 'image', maxSizeBytes: 30 * 1024 * 1024, maximumInclusive: false },
  'image/heif': { mediaType: 'image', maxSizeBytes: 30 * 1024 * 1024, maximumInclusive: false },
  'video/mp4': { mediaType: 'video', maxSizeBytes: 200 * 1024 * 1024, maximumInclusive: true },
  'video/quicktime': { mediaType: 'video', maxSizeBytes: 200 * 1024 * 1024, maximumInclusive: true },
  'audio/wav': { mediaType: 'audio', maxSizeBytes: 15 * 1024 * 1024, maximumInclusive: true },
  'audio/mpeg': { mediaType: 'audio', maxSizeBytes: 15 * 1024 * 1024, maximumInclusive: true },
};

function invalid(code: string): never { throw new Error(code); }
function within(value: number | undefined, min: number, max: number, code: string) {
  if (!Number.isFinite(value) || value! < min || value! > max) invalid(code);
}
function validateImageDimensions(width: number | undefined, height: number | undefined, prefix: string) {
  within(width, 300, 6000, `${prefix}_DIMENSIONS_INVALID`);
  within(height, 300, 6000, `${prefix}_DIMENSIONS_INVALID`);
  within(width! / height!, 0.4, 2.5, `${prefix}_ASPECT_RATIO_INVALID`);
}

export type SeedanceMediaForTotals = {
  role: string;
  metadata: MediaMetadata;
};

export function seedanceMediaSizeAllowed(policy: SeedanceInputMediaPolicy, sizeBytes: number): boolean {
  return Number.isInteger(sizeBytes)
    && sizeBytes > 0
    && (policy.maximumInclusive ? sizeBytes <= policy.maxSizeBytes : sizeBytes < policy.maxSizeBytes);
}

export function validateSeedanceMediaTotals(media: SeedanceMediaForTotals[]): void {
  const durationFor = (role: string) => media
    .filter((item) => item.role === role)
    .reduce((total, item) => total + (item.metadata.durationSeconds ?? 0), 0);
  if (durationFor('reference_video') > 30) invalid('VIDEO_TOTAL_DURATION_INVALID');
  if (durationFor('reference_audio') > 30) invalid('AUDIO_TOTAL_DURATION_INVALID');
}

export function validateSeedanceMediaMetadata(mimeType: string, metadata: MediaMetadata, sizeBytes?: number): void {
  const normalizedMime = mimeType.split(';')[0].trim().toLowerCase();
  const policy = SEEDANCE_INPUT_MEDIA_POLICIES[normalizedMime];
  if (!policy) {
    if (normalizedMime.startsWith('image/')) invalid('IMAGE_FORMAT_INVALID');
    if (normalizedMime.startsWith('video/')) invalid('VIDEO_CONTAINER_INVALID');
    if (normalizedMime.startsWith('audio/')) invalid('AUDIO_FORMAT_INVALID');
    invalid('MEDIA_MIME_INVALID');
  }
  if (sizeBytes !== undefined && !seedanceMediaSizeAllowed(policy, sizeBytes)) {
    invalid(`${policy.mediaType.toUpperCase()}_SIZE_INVALID`);
  }
  if (policy.mediaType === 'image') {
    if (metadata.kind !== 'image') invalid('MEDIA_KIND_MISMATCH');
    validateImageDimensions(metadata.width, metadata.height, 'IMAGE');
    return;
  }
  if (policy.mediaType === 'video') {
    if (metadata.kind !== 'video') invalid('MEDIA_KIND_MISMATCH');
    validateImageDimensions(metadata.width, metadata.height, 'VIDEO');
    within(metadata.width! * metadata.height!, 407696, 8295044, 'VIDEO_PIXELS_INVALID');
    within(metadata.durationSeconds, 2, 30, 'VIDEO_DURATION_INVALID');
    within(metadata.frameRate, 24, 60, 'VIDEO_FRAME_RATE_INVALID');
    if (!['h264', 'hevc', 'h265'].includes((metadata.videoCodec ?? '').toLowerCase())) invalid('VIDEO_CODEC_INVALID');
    const audioCodec = (metadata.audioCodec ?? '').toLowerCase();
    if (audioCodec && !['aac', 'mp3'].includes(audioCodec) && !audioCodec.startsWith('pcm')) invalid('VIDEO_AUDIO_CODEC_INVALID');
    return;
  }
  if (policy.mediaType === 'audio') {
    if (metadata.kind !== 'audio') invalid('MEDIA_KIND_MISMATCH');
    within(metadata.durationSeconds, 2, 30, 'AUDIO_DURATION_INVALID');
    return;
  }
  invalid('MEDIA_MIME_INVALID');
}
