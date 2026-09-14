import { validateSeedanceMediaMetadata } from './media-policy';

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
});
