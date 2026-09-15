import { validateSeedanceMediaMetadata, validateSeedanceMediaTotals } from './media-policy';

describe('validateSeedanceMediaMetadata', () => {
  it('accepts an official 16:9 image within pixel bounds', () => {
    expect(() => validateSeedanceMediaMetadata('image/png', { kind: 'image', width: 1280, height: 720 })).not.toThrow();
  });
  it('rejects an image outside the official aspect-ratio range', () => {
    expect(() => validateSeedanceMediaMetadata('image/png', { kind: 'image', width: 300, height: 1000 })).toThrow('IMAGE_ASPECT_RATIO_INVALID');
  });
  it('accepts an official video stream and rejects an unsupported frame rate', () => {
    expect(() => validateSeedanceMediaMetadata('video/mp4', { kind: 'video', width: 1280, height: 720, durationSeconds: 5, frameRate: 24, videoCodec: 'h264' })).not.toThrow();
    expect(() => validateSeedanceMediaMetadata('video/mp4', { kind: 'video', width: 1280, height: 720, durationSeconds: 5, frameRate: 20, videoCodec: 'h264' })).toThrow('VIDEO_FRAME_RATE_INVALID');
  });
  it('rejects an audio reference shorter than two seconds', () => {
    expect(() => validateSeedanceMediaMetadata('audio/wav', { kind: 'audio', durationSeconds: 1.9, audioCodec: 'pcm_s16le' })).toThrow('AUDIO_DURATION_INVALID');
  });

  it.each([
    ['image/svg+xml', { kind: 'image' as const, width: 640, height: 480 }, 'IMAGE_FORMAT_INVALID'],
    ['video/webm', { kind: 'video' as const, width: 1280, height: 720, durationSeconds: 5, frameRate: 24, videoCodec: 'h264' }, 'VIDEO_CONTAINER_INVALID'],
    ['audio/ogg', { kind: 'audio' as const, durationSeconds: 5, audioCodec: 'opus' }, 'AUDIO_FORMAT_INVALID'],
  ])('rejects unsupported MIME %s', (mimeType, metadata, code) => {
    expect(() => validateSeedanceMediaMetadata(mimeType, metadata)).toThrow(code);
  });

  it('rejects an unsupported audio codec carried by an otherwise valid video', () => {
    expect(() => validateSeedanceMediaMetadata('video/mp4', {
      kind: 'video', width: 1280, height: 720, durationSeconds: 5,
      frameRate: 24, videoCodec: 'h264', audioCodec: 'opus',
    })).toThrow('VIDEO_AUDIO_CODEC_INVALID');
  });

  it('treats the official image limit as exclusive and audio/video limits as inclusive', () => {
    expect(() => validateSeedanceMediaMetadata(
      'image/png', { kind: 'image', width: 640, height: 480 }, 30 * 1024 * 1024,
    )).toThrow('IMAGE_SIZE_INVALID');
    expect(() => validateSeedanceMediaMetadata(
      'audio/wav', { kind: 'audio', durationSeconds: 2, audioCodec: 'pcm_s16le' }, 15 * 1024 * 1024,
    )).not.toThrow();
    expect(() => validateSeedanceMediaMetadata(
      'video/mp4', { kind: 'video', width: 1280, height: 720, durationSeconds: 2, frameRate: 24, videoCodec: 'h264' }, 200 * 1024 * 1024,
    )).not.toThrow();
  });

  it('rejects video and audio totals above the official 30 second limits', () => {
    expect(() => validateSeedanceMediaTotals([
      { role: 'reference_video', metadata: { kind: 'video', durationSeconds: 16 } },
      { role: 'reference_video', metadata: { kind: 'video', durationSeconds: 15 } },
    ])).toThrow('VIDEO_TOTAL_DURATION_INVALID');
    expect(() => validateSeedanceMediaTotals([
      { role: 'reference_audio', metadata: { kind: 'audio', durationSeconds: 20 } },
      { role: 'reference_audio', metadata: { kind: 'audio', durationSeconds: 11 } },
    ])).toThrow('AUDIO_TOTAL_DURATION_INVALID');
  });

  it('accepts exact 30 second video and audio totals', () => {
    expect(() => validateSeedanceMediaTotals([
      { role: 'reference_video', metadata: { kind: 'video', durationSeconds: 12.25 } },
      { role: 'reference_video', metadata: { kind: 'video', durationSeconds: 17.75 } },
      { role: 'reference_audio', metadata: { kind: 'audio', durationSeconds: 30 } },
    ])).not.toThrow();
  });
});
