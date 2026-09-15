import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const contractUrl = new URL('../../contracts/seedance-workflows.v2.json', import.meta.url);

// **允许**处于开启状态的付费工作流。没列在这里却被打开 = 回归。
// 唯一依据是 docs/runbooks/r8-production-acceptance-scope.md 的授权记录：
// §8 text-to-video、§9 first-frame、§10 first-last-frame，都是同一口径的长期开放
// （同一 Actor、100 元/日 上限、全部参数）。再打开任何其他工作流都必须先有一条
// 对应授权，并在这里显式声明——这是本测试存在的意义：未声明的开放会被抓住。
const DECLARED_OPEN_WORKFLOWS = [
  'seedance.text-to-video.v1',
  'seedance.first-frame-to-video.v1',
  'seedance.first-last-frame-to-video.v1',
];

async function loadContract() {
  return JSON.parse(await readFile(contractUrl, 'utf8'));
}

test('v2 contract freezes the official Seedance 2.5 API and all eight workflows', async () => {
  const contract = await loadContract();

  assert.equal(contract.schemaVersion, 2);
  assert.equal(contract.provider, 'volcengine-ark');
  assert.equal(contract.model.id, 'doubao-seedance-2-5-260628');
  assert.equal(contract.model.createTaskPath, '/api/v3/contents/generations/tasks');
  assert.equal(contract.model.outputFrameRate, 24);

  const expectedKeys = [
    'seedance.audio-reference-to-video.v1',
    'seedance.first-frame-to-video.v1',
    'seedance.first-last-frame-to-video.v1',
    'seedance.omni-reference.v1',
    'seedance.reference-image-to-video.v1',
    'seedance.text-to-video.v1',
    'seedance.video-edit.v1',
    'seedance.video-extend.v1',
  ];
  assert.deepEqual(contract.workflows.map((item) => item.key).sort(), expectedKeys);

  for (const workflow of contract.workflows) {
    assert.equal(workflow.state.capability, 'confirmed');
    if (DECLARED_OPEN_WORKFLOWS.includes(workflow.key)) {
      assert.equal(workflow.state.admission.enabled, true);
      assert.equal(workflow.state.admission.reason, null);
    } else {
      // 发货源合同里的付费入口必须全部关闭，且必须写明关闭原因（该原因会作为
      // 预检 blocker 详情回到客户端）。
      assert.equal(workflow.state.admission.enabled, false);
      assert.equal(typeof workflow.state.admission.reason, 'string');
      assert.ok(workflow.state.admission.reason.length > 0);
    }
    // 验证记录只能描述自己，且必须写得完整；有记录就说明这批参数组合是 passed。
    // 未完成的工作流不允许留下记录。
    // **注意：implementation=ready 不要求已经有真实验收记录** —— 受控验收的放行本来
    // 就发生在真实出片之前（两条开放的工作流都是这么开的），记录在跑完之后补。
    // 真正的付费闸门是上面的 DECLARED_OPEN_WORKFLOWS：没写进授权就开不了。
    const records = workflow.state.validation.records;
    for (const record of records) {
      assert.equal(record.workflowKey, workflow.key);
      assert.ok(record.parameters && record.software && record.billing, `${workflow.key} record is missing a section`);
      assert.ok(record.artifact?.taskId);
      assert.ok(record.artifact?.providerTaskId);
      assert.match(record.artifact?.sha256 ?? '', /^[a-f0-9]{64}$/);
      assert.ok(record.evidenceRef);
    }
    if (records.length > 0) {
      assert.equal(workflow.state.validation.status, 'passed');
    }
    if (workflow.state.implementation === 'incomplete') {
      assert.equal(workflow.state.validation.status, 'not_run');
      assert.deepEqual(records, []);
    }
    assert.ok(workflow.evidence.length > 0);
    for (const evidenceId of workflow.evidence) {
      assert.ok(contract.evidence[evidenceId], `${workflow.key} references unknown evidence ${evidenceId}`);
      assert.match(contract.evidence[evidenceId].url, /^https:\/\/docs\.volcengine\.com\//);
    }
  }
});

test('v2 contract keeps ordinary 4-30 second generation separate from special modes', async () => {
  const contract = await loadContract();
  const workflows = new Map(contract.workflows.map((item) => [item.key, item]));
  const ordinaryKeys = [
    'seedance.text-to-video.v1',
    'seedance.reference-image-to-video.v1',
    'seedance.first-frame-to-video.v1',
    'seedance.first-last-frame-to-video.v1',
    'seedance.omni-reference.v1',
    'seedance.audio-reference-to-video.v1',
    'seedance.video-extend.v1',
  ];

  for (const key of ordinaryKeys) {
    assert.deepEqual(workflows.get(key).generation.productDuration, {
      kind: 'integer_range',
      minimum: 4,
      maximum: 30,
    });
  }

  assert.deepEqual(workflows.get('seedance.video-edit.v1').generation.productDuration, {
    kind: 'fixed',
    value: -1,
  });
  for (const key of [
    'seedance.first-frame-to-video.v1',
    'seedance.first-last-frame-to-video.v1',
    'seedance.video-edit.v1',
    'seedance.video-extend.v1',
  ]) {
    assert.deepEqual(workflows.get(key).generation.ratios, ['adaptive']);
  }
});

test('v2 contract captures mixed reference media and official per-kind limits', async () => {
  const contract = await loadContract();
  const workflows = new Map(contract.workflows.map((item) => [item.key, item]));
  const roleNames = (key) => workflows.get(key).media.roles.map((item) => item.role).sort();
  const allReferenceRoles = ['reference_audio', 'reference_image', 'reference_video'];

  assert.deepEqual(roleNames('seedance.omni-reference.v1'), allReferenceRoles);
  assert.deepEqual(roleNames('seedance.video-edit.v1'), allReferenceRoles);
  assert.deepEqual(roleNames('seedance.video-extend.v1'), allReferenceRoles);
  assert.equal(workflows.get('seedance.video-edit.v1').media.roles.find((item) => item.role === 'reference_video').minimum, 1);
  assert.equal(workflows.get('seedance.video-extend.v1').media.roles.find((item) => item.role === 'reference_video').minimum, 1);

  assert.equal(contract.media.image.maximumCount, 30);
  assert.equal(contract.media.image.maximumSizeBytesExclusive, 30 * 1024 * 1024);
  assert.equal(contract.media.video.maximumCount, 10);
  assert.equal(contract.media.video.maximumSizeBytesInclusive, 200 * 1024 * 1024);
  assert.equal(contract.media.video.maximumSizeBytesExclusive, undefined);
  assert.equal(contract.media.video.maximumTotalDurationSeconds, 30);
  assert.equal(contract.media.audio.maximumCount, 10);
  assert.equal(contract.media.audio.maximumSizeBytesInclusive, 15 * 1024 * 1024);
  assert.equal(contract.media.audio.maximumSizeBytesExclusive, undefined);
  assert.equal(contract.media.audio.maximumTotalDurationSeconds, 30);
  assert.equal(contract.media.maximumReferenceCount, 50);
});

test('only the workflows declared for controlled acceptance are open', async () => {
  const contract = await loadContract();

  const open = contract.workflows
    .filter((workflow) => workflow.state.admission.enabled)
    .map((workflow) => workflow.key)
    .sort();

  assert.deepEqual(open, [...DECLARED_OPEN_WORKFLOWS].sort());
});

test('v2 pricing contract distinguishes an estimate, reservation blocker, and final usage', async () => {
  const contract = await loadContract();
  const pricing = contract.pricing;

  assert.equal(pricing.currency, 'CNY');
  assert.equal(pricing.estimate.outputFrameRate, 24);
  assert.equal(pricing.estimate.formula, '(inputVideoSeconds + outputVideoSeconds) * width * height * outputFrameRate / 1024');
  assert.equal(pricing.finalUsage.field, 'usage.completion_tokens');
  assert.equal(pricing.inputVideoMinimumTokens.status, 'resolved');
  assert.equal(pricing.inputVideoMinimumTokens.productionQuotePolicy, 'reserve_the_max_of_formula_and_minimum');

  const base = new Map(pricing.catalogRates.map((item) => [`${item.resolutionGroup}:${item.hasInputVideo}`, item.cnyPerMillionTokens]));
  assert.equal(base.get('480p_or_720p:false'), '70.00');
  assert.equal(base.get('480p_or_720p:true'), '42.00');
  assert.equal(base.get('1080p:false'), '77.00');
  assert.equal(base.get('1080p:true'), '46.00');

  assert.deepEqual(pricing.promotions, [{
    id: 'seedance-2.5-1080p-2026-08-14-2026-09-17',
    resolution: '1080p',
    multiplier: '0.72',
    startsAt: '2026-08-14T14:00:00+08:00',
    endsAt: '2026-09-17T14:00:00+08:00',
    accountApplicability: 'must_be_confirmed_from_actual_account_or_order',
  }]);
});
