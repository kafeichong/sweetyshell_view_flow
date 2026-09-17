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
// §8 text-to-video、§9 first-frame、§10 first-last-frame、§11 omni-reference、§12 video-extend，
// 都是同一口径的长期开放（同一 Actor、100 元/日 上限、全部参数）；§13 是 2026-09-16 的
// "剩余两条全部放行"（audio-reference、video-edit），授权口径相同。再打开任何其他
// 工作流都必须先有一条对应授权，并在这里显式声明——这是本测试存在的意义：
// 未声明的开放会被抓住。当前唯一关闭的是已退休的 reference-image（单图入口并入全模态）。
const DECLARED_OPEN_WORKFLOWS: string[] = [
  'seedance.text-to-video.v1',
  'seedance.first-frame-to-video.v1',
  'seedance.first-last-frame-to-video.v1',
  'seedance.omni-reference.v1',
  'seedance.video-extend.v1',
  'seedance.audio-reference-to-video.v1',
  'seedance.video-edit.v1',
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
      contractRevision: '2026-09-17.1',
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
    // 刻意挑合同里**仍处于关闭**的那条（已退休的单图入口）：被授权开放的那些
    // 无法用来验证"环境变量越不过合同"。
    process.env.VIDEO_FLOW_TEST_READY_WORKFLOWS = 'seedance.reference-image-to-video.v1';
    try {
      const evaluated = new WorkflowCatalogService().evaluate(textIntent('seedance.reference-image-to-video.v1'));
      expect(evaluated.workflow.state).toMatchObject({
        implementation: 'incomplete',
        admission: { enabled: false, reason: 'RETIRED_USE_OMNI_REFERENCE' },
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

  it('enforces the workflow-level reference rules the client explains to users', () => {
    const referenceImage = (index: number) => ({
      slotId: `image-${index}`, role: 'reference_image' as const, sha256: String(index % 10).repeat(64),
      mimeType: 'image/png', sizeBytes: 1024, metadata: { kind: 'image' as const, width: 1280, height: 720 },
    });

    // 官方要求全模态参考的 content 至少含一个 reference_* 素材——合同用 minimumTotal=1 表达，
    // 客户端「一个都没选」的排队前校验对应的就是这一条。
    const none = catalog.evaluate({ ...textIntent(), workflowKey: 'seedance.omni-reference.v1', media: [] });
    expect(none.requestCheck.status).toBe('failed');
    expect(none.requestCheck.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'WORKFLOW_MEDIA_COUNT_INVALID', path: 'media' }),
    ]));

    // 「首帧 / 首尾帧 / 全模态参考三类互斥」的落点：每个工作流只声明自己的角色，
    // 往全模态参考里塞 first_frame 会被角色白名单拒掉。
    const mixed = catalog.evaluate({
      ...textIntent(), workflowKey: 'seedance.omni-reference.v1',
      media: [{ ...referenceImage(1), slotId: 'frame-1', role: 'first_frame' as const }],
    });
    expect(mixed.requestCheck.status).toBe('failed');
    expect(mixed.requestCheck.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'WORKFLOW_MEDIA_ROLE_INVALID', path: 'media[0].role' }),
    ]));

    // 每类素材的数量上限：参考图 30 张是上限本身，31 张才越界。
    const overflowing = catalog.evaluate({
      ...textIntent(), workflowKey: 'seedance.omni-reference.v1',
      media: Array.from({ length: 31 }, (_, index) => referenceImage(index + 1)),
    });
    expect(overflowing.requestCheck.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'WORKFLOW_MEDIA_ROLE_COUNT_INVALID', path: 'media' }),
    ]));
    const exactlyThirty = catalog.evaluate({
      ...textIntent(), workflowKey: 'seedance.omni-reference.v1',
      media: Array.from({ length: 30 }, (_, index) => referenceImage(index + 1)),
    });
    expect(exactlyThirty.requestCheck.items).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'WORKFLOW_MEDIA_ROLE_COUNT_INVALID' }),
    ]));

    // 首尾帧的角色顺序固定为 first_frame → last_frame。
    const frame = (role: 'first_frame' | 'last_frame', index: number) => ({
      slotId: `${role}-${index}`, role, sha256: String(index).repeat(64), mimeType: 'image/png', sizeBytes: 1024,
      metadata: { kind: 'image' as const, width: 1280, height: 720 },
    });
    const reversed = catalog.evaluate({
      ...textIntent(), workflowKey: 'seedance.first-last-frame-to-video.v1',
      generation: { ...textIntent().generation, ratio: 'adaptive' },
      media: [frame('last_frame', 1), frame('first_frame', 2)],
    });
    expect(reversed.requestCheck.status).toBe('failed');
    expect(reversed.requestCheck.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'WORKFLOW_MEDIA_ORDER_INVALID', path: 'media[0].role' }),
    ]));
  });

  it('requires a non-empty prompt instead of accepting an empty request', () => {
    // 官方对全模态参考把文本列为可选，我们更严：没有提示词直接拒。
    expect(() => catalog.evaluate({ ...textIntent(), prompt: { positive: '   ' } })).toThrow(
      expect.objectContaining<Partial<WorkflowContractError>>({ code: 'WORKFLOW_PROMPT_INVALID', path: 'prompt.positive' }),
    );
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

  // ---- 私域素材库（asset://）----
  // 含真人人脸的参考素材**只能**走这条路：直传 URL 会被方舟输入审核拦下。所以这里的
  // 每条断言都对应一种会花钱才发现的失败，要拦在预检阶段。

  const arkImage = (overrides: Record<string, unknown> = {}) => ({
    slotId: 'reference-1',
    role: 'reference_image',
    sha256: 'a'.repeat(64),
    mimeType: 'image/png',
    sizeBytes: 1024,
    metadata: { kind: 'image', width: 1024, height: 1024 },
    arkAssetId: 'asset-20260917115246-cgmtw',
    ...overrides,
  });

  const evaluateOrThrow = (intent: unknown) => {
    try {
      catalog.evaluate(intent);
    } catch (error) {
      return error as WorkflowContractError;
    }
    throw new Error('expected the catalog to refuse this intent');
  };

  it('accepts an asset-library asset alongside the ordinary OSS-shaped fields', () => {
    const result = catalog.evaluate({
      ...textIntent('seedance.omni-reference.v1'),
      media: [arkImage()],
    });

    expect(result.requestCheck.status).toBe('passed');
    // arkAssetId 是**加法**：其余六个键照旧是真值（那份文件入库时我方检查器看过），
    // 所以 production-submission 的逐字段比对不用为素材库开特例。
    expect(result.effectiveRequest.media[0]).toMatchObject({
      arkAssetId: 'asset-20260917115246-cgmtw',
      sha256: 'a'.repeat(64),
      sizeBytes: 1024,
      mimeType: 'image/png',
    });
  });

  it('keeps an intent without an asset id byte-identical, so frozen digests stay valid', () => {
    // 这条是给"加法设计"上的锁：不带 arkAssetId 的历史 intent 必须算出一模一样的对象，
    // 否则已冻结的 task.execution_plan 会在 Worker 侧报 contract digest 失配、进人工核查。
    // 用 toStrictEqual 而不是 toEqual——后者会放过"键存在但值是 undefined"。
    const descriptor = arkImage();
    delete (descriptor as Record<string, unknown>).arkAssetId;

    const result = catalog.evaluate({
      ...textIntent('seedance.omni-reference.v1'),
      media: [descriptor],
    });

    expect(result.effectiveRequest.media[0]).toStrictEqual({
      slotId: 'reference-1',
      role: 'reference_image',
      sha256: 'a'.repeat(64),
      mimeType: 'image/png',
      sizeBytes: 1024,
      metadata: { kind: 'image', width: 1024, height: 1024 },
    });
  });

  it('refuses the asset library on roles the contract has no official example for', () => {
    // 官方只对 reference_* 给了 asset:// 示例，首帧/尾帧没有依据，所以合同把它们放在
    // assetLibrary.unverifiedRoles 而不是 roles 里。白名单在这里生效——用户在建槽位时
    // 就被告知，而不是提交后花了钱才被方舟打回。
    const error = evaluateOrThrow({
      ...textIntent('seedance.first-frame-to-video.v1'),
      media: [arkImage({ role: 'first_frame' })],
    });

    expect(error).toBeInstanceOf(WorkflowContractError);
    expect(error.code).toBe('MEDIA_ARK_ROLE_UNSUPPORTED');
    expect(error.path).toBe('media[0].role');
  });

  it('rejects a malformed asset id instead of forwarding it to the provider', () => {
    const error = evaluateOrThrow({
      ...textIntent('seedance.omni-reference.v1'),
      media: [arkImage({ arkAssetId: 'https://example.invalid/not-an-asset.png' })],
    });

    expect(error).toBeInstanceOf(WorkflowContractError);
    expect(error.code).toBe('MEDIA_ARK_ASSET_ID_INVALID');
    expect(error.path).toBe('media[0].arkAssetId');
  });
});
