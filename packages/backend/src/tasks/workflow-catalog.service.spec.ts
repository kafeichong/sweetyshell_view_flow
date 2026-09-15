jest.mock('@nestjs/common', () => ({ Injectable: () => (target: unknown) => target }));

import {
  workflowDigest,
  workflowExecutionDigest,
  WorkflowCatalogService,
  WorkflowContractError,
} from './workflow-catalog.service';
import { WorkflowContractCatalog } from './workflow-contract';

const rawContract = require('./resources/seedance-workflows.v2.json') as WorkflowContractCatalog;

function textIntent() {
  return {
    contractVersion: 2,
    workflowKey: 'seedance.text-to-video.v1',
    prompt: { positive: '雨后的街道，镜头缓慢推进' },
    generation: {
      duration: 4,
      ratio: '16:9',
      resolution: '720p',
      generateAudio: true,
      watermark: false,
      outputFormat: 'mp4',
    },
    media: [],
  };
}

describe('WorkflowCatalogService', () => {
  const catalog = new WorkflowCatalogService();

  it('loads all eight workflows with separate capability, implementation, admission and validation states', () => {
    const workflows = catalog.list();
    expect(workflows).toHaveLength(8);
    expect(workflows.every((item) => item.state.capability === 'confirmed')).toBe(true);
    expect(workflows.every((item) => item.state.implementation === 'incomplete')).toBe(true);
    expect(workflows.every((item) => item.state.admission.enabled === false)).toBe(true);
    expect(workflows.every((item) => item.state.admission.reason === 'V2_FULL_CHAIN_NOT_COMPLETE')).toBe(true);
    expect(workflows.every((item) => item.state.validation.status === 'not_run')).toBe(true);
  });

  it('publishes the exact contract revision, digest and server-selected model with the directory', () => {
    expect(catalog.directory()).toMatchObject({
      contractVersion: 2,
      contractRevision: '2026-09-15.3',
      model: 'doubao-seedance-2-5-260628',
      workflows: expect.any(Array),
    });
    expect(catalog.directory().contractDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(catalog.directory().catalogDigest).toBe(workflowDigest(rawContract));
    expect(catalog.directory().contractDigest).toBe(workflowExecutionDigest(rawContract));
    expect(catalog.directory().catalogDigest).not.toBe(catalog.directory().contractDigest);
  });

  it('keeps execution digest stable for admission changes but changes it for execution rules', () => {
    const admissionChanged = JSON.parse(JSON.stringify(rawContract)) as WorkflowContractCatalog;
    admissionChanged.workflows[0].state.implementation = 'ready';
    admissionChanged.workflows[0].state.admission = { enabled: true, reason: null };
    expect(workflowExecutionDigest(admissionChanged)).toBe(workflowExecutionDigest(rawContract));

    const executionChanged = JSON.parse(JSON.stringify(rawContract)) as WorkflowContractCatalog;
    const duration = executionChanged.workflows[0].generation.productDuration;
    if (duration.kind !== 'integer_range') throw new Error('fixture requires integer range');
    duration.maximum = 29;
    expect(workflowExecutionDigest(executionChanged)).not.toBe(workflowExecutionDigest(rawContract));
  });

  it('does not let runtime environment variables override fail-closed workflow admission', () => {
    const originalMode = process.env.VIDEO_FLOW_TEST_MODE;
    const originalReady = process.env.VIDEO_FLOW_TEST_READY_WORKFLOWS;
    process.env.VIDEO_FLOW_TEST_MODE = '1';
    process.env.VIDEO_FLOW_TEST_READY_WORKFLOWS = 'seedance.text-to-video.v1';
    try {
      const evaluated = new WorkflowCatalogService().evaluate(textIntent());
      expect(evaluated.workflow.state).toMatchObject({
        implementation: 'incomplete',
        admission: { enabled: false, reason: 'V2_FULL_CHAIN_NOT_COMPLETE' },
      });
    } finally {
      if (originalMode === undefined) delete process.env.VIDEO_FLOW_TEST_MODE;
      else process.env.VIDEO_FLOW_TEST_MODE = originalMode;
      if (originalReady === undefined) delete process.env.VIDEO_FLOW_TEST_READY_WORKFLOWS;
      else process.env.VIDEO_FLOW_TEST_READY_WORKFLOWS = originalReady;
    }
  });

  it('normalizes a valid intent and binds it to contract and intent digests', () => {
    const result = catalog.evaluate(textIntent());
    expect(result.requestCheck.status).toBe('passed');
    expect(result.effectiveRequest).toEqual(textIntent());
    expect(result.contractDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.intentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.workflow.key).toBe('seedance.text-to-video.v1');
  });

  it('reports role, metadata kind and MIME conflicts with a precise media path', () => {
    const result = catalog.evaluate({
      ...textIntent(),
      workflowKey: 'seedance.reference-image-to-video.v1',
      media: [{
        slotId: 'reference-1',
        role: 'reference_image',
        sha256: 'a'.repeat(64),
        mimeType: 'audio/mpeg',
        sizeBytes: 1024,
        metadata: { kind: 'audio', durationSeconds: 3 },
      }],
    });

    expect(result.requestCheck.status).toBe('failed');
    expect(result.requestCheck.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'MEDIA_ROLE_KIND_MISMATCH', path: 'media[0].metadata.kind', status: 'failed' }),
      expect.objectContaining({ code: 'MEDIA_MIME_KIND_MISMATCH', path: 'media[0].mimeType', status: 'failed' }),
    ]));
  });

  it('rejects unknown request fields before creating a fake report', () => {
    expect(() => catalog.evaluate({ ...textIntent(), model: 'client-model' })).toThrow(
      expect.objectContaining<Partial<WorkflowContractError>>({ code: 'WORKFLOW_FIELDS_INVALID', path: 'model' }),
    );
  });

  it('keeps special workflow parameter rules in the shared contract', () => {
    const result = catalog.evaluate({
      ...textIntent(),
      workflowKey: 'seedance.video-edit.v1',
      generation: { ...textIntent().generation, duration: 4, ratio: '16:9', outputFormat: 'mov' },
      media: [{
        slotId: 'video-1', role: 'reference_video', sha256: 'b'.repeat(64), mimeType: 'video/mp4', sizeBytes: 2048,
        metadata: { kind: 'video', width: 1280, height: 720, durationSeconds: 8, frameRate: 24, videoCodec: 'h264' },
      }],
    });
    expect(result.requestCheck.status).toBe('failed');
    expect(result.requestCheck.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'WORKFLOW_DURATION_INVALID', path: 'generation.duration' }),
      expect.objectContaining({ code: 'WORKFLOW_RATIO_INVALID', path: 'generation.ratio' }),
    ]));
  });

  it('rejects declared video metadata outside official pixel and stream bounds', () => {
    const result = catalog.evaluate({
      ...textIntent(),
      workflowKey: 'seedance.omni-reference.v1',
      media: [{
        slotId: 'video-1', role: 'reference_video', sha256: 'd'.repeat(64), mimeType: 'video/mp4', sizeBytes: 2048,
        metadata: { kind: 'video', width: 640, height: 480, durationSeconds: 3, frameRate: 20, videoCodec: 'vp9' },
      }],
    });

    expect(result.requestCheck.status).toBe('failed');
    expect(result.requestCheck.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'VIDEO_PIXELS_INVALID', path: 'media[0].metadata' }),
    ]));
  });

  it('enforces official per-file size inclusivity for Preview descriptors', () => {
    const image = catalog.evaluate({
      ...textIntent(), workflowKey: 'seedance.reference-image-to-video.v1',
      media: [{
        slotId: 'image-1', role: 'reference_image', sha256: 'e'.repeat(64), mimeType: 'image/png', sizeBytes: 30 * 1024 * 1024,
        metadata: { kind: 'image', width: 1280, height: 720 },
      }],
    });
    const video = catalog.evaluate({
      ...textIntent(), workflowKey: 'seedance.omni-reference.v1',
      media: [{
        slotId: 'video-1', role: 'reference_video', sha256: 'f'.repeat(64), mimeType: 'video/mp4', sizeBytes: 200 * 1024 * 1024,
        metadata: { kind: 'video', width: 1280, height: 720, durationSeconds: 2, frameRate: 24, videoCodec: 'h264' },
      }],
    });

    expect(image.requestCheck.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'IMAGE_SIZE_INVALID', path: 'media[0].sizeBytes' }),
    ]));
    expect(video.requestCheck.status).toBe('passed');
  });

  it('rejects combined reference video and audio durations above 30 seconds', () => {
    const media = [
      ...[16, 15].map((durationSeconds, index) => ({
        slotId: `video-${index + 1}`, role: 'reference_video', sha256: String(index + 1).repeat(64), mimeType: 'video/mp4', sizeBytes: 2048,
        metadata: { kind: 'video', width: 1280, height: 720, durationSeconds, frameRate: 24, videoCodec: 'h264' },
      })),
      ...[20, 11].map((durationSeconds, index) => ({
        slotId: `audio-${index + 1}`, role: 'reference_audio', sha256: String(index + 3).repeat(64), mimeType: 'audio/wav', sizeBytes: 1024,
        metadata: { kind: 'audio', durationSeconds, audioCodec: 'pcm_s16le' },
      })),
    ];
    const result = catalog.evaluate({ ...textIntent(), workflowKey: 'seedance.omni-reference.v1', media });

    expect(result.requestCheck.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'VIDEO_TOTAL_DURATION_INVALID', path: 'media' }),
      expect.objectContaining({ code: 'AUDIO_TOTAL_DURATION_INVALID', path: 'media' }),
    ]));
  });
});
