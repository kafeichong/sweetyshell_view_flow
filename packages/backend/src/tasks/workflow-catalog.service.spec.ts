jest.mock('@nestjs/common', () => ({ Injectable: () => (target: unknown) => target }));

import {
  workflowDigest,
  workflowExecutionDigest,
  WorkflowCatalogService,
  WorkflowContractError,
} from './workflow-catalog.service';
import { WorkflowContractCatalog } from './workflow-contract';

const rawContract = require('./resources/seedance-workflows.v2.json') as WorkflowContractCatalog;

// **允许**处于开启状态的付费工作流。没列在这里却被打开 = 回归。
// 唯一依据是 docs/runbooks/r8-production-acceptance-scope.md 的授权记录：
// §8 text-to-video、§9 first-frame、§10 first-last-frame、§11 omni-reference，
// 都是同一口径的长期开放（同一 Actor、100 元/日 上限、全部参数）。再打开任何其他
// 工作流都必须先有一条对应授权，并在这里显式声明——这是本测试存在的意义：
// 未声明的开放会被抓住。
const DECLARED_OPEN_WORKFLOWS: string[] = [
  'seedance.text-to-video.v1',
  'seedance.first-frame-to-video.v1',
  'seedance.first-last-frame-to-video.v1',
  'seedance.omni-reference.v1',
];

function textIntent(workflowKey = 'seedance.text-to-video.v1') {
  return {
    contractVersion: 2,
    workflowKey,
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
    // 只有明确声明受控验收的工作流可以开启；其余必须全部关闭。任何没列在
    // DECLARED_OPEN_WORKFLOWS 里却被打开的工作流都会被下面两条断言抓住。
    const open = workflows
      .filter((item) => item.state.admission.enabled)
      .map((item) => item.key)
      .sort();
    expect(open).toEqual([...DECLARED_OPEN_WORKFLOWS].sort());
    const closed = workflows.filter((item) => !DECLARED_OPEN_WORKFLOWS.includes(item.key));
    expect(closed.every((item) => item.state.admission.enabled === false)).toBe(true);
    // 关闭原因会作为预检 blocker 详情回到客户端，所以不允许为空。
    expect(closed.every((item) => (item.state.admission.reason ?? '').length > 0)).toBe(true);
    // 有验证记录就说明这批参数组合是 passed；未完成的工作流不允许留下记录。
    // **implementation=ready 不要求已有真实验收记录**：受控验收的放行先于真实出片
    // （两条开放的工作流都是这么开的），记录在跑完后补。真正的付费闸门是上面的
    // 声明列表——没写进授权就开不了。
    const withRecords = workflows.filter((item) => item.state.validation.records.length > 0);
    expect(withRecords.every((item) => item.state.validation.status === 'passed')).toBe(true);
    const incomplete = workflows.filter((item) => item.state.implementation === 'incomplete');
    expect(incomplete.every((item) => item.state.validation.status === 'not_run')).toBe(true);
    expect(incomplete.every((item) => item.state.validation.records.length === 0)).toBe(true);
  });

  it('publishes the exact contract revision, digest and server-selected model with the directory', () => {
    expect(catalog.directory()).toMatchObject({
      contractVersion: 2,
      contractRevision: '2026-09-15.4',
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
    // 刻意挑一条合同里仍处于关闭的工作流：被授权开放的那些无法用于验证
    // "环境变量越不过合同"。
    process.env.VIDEO_FLOW_TEST_READY_WORKFLOWS = 'seedance.video-edit.v1';
    try {
      const evaluated = new WorkflowCatalogService().evaluate(textIntent('seedance.video-edit.v1'));
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
