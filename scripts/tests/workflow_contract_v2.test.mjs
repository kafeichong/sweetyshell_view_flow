import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const contractUrl = new URL('../../contracts/seedance-workflows.v2.json', import.meta.url);

// 受控验收期间**允许**处于开启状态的工作流。没列在这里却被打开 = 回归。
// 依据：docs/runbooks/r8-production-acceptance-scope.md（2026-09-15 授权的 R8 验收）。
// 验收收口时必须把这里清空，并把该工作流改回关闭。
const DECLARED_OPEN_WORKFLOWS = ['seedance.text-to-video.v1'];

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
      assert.equal(workflow.state.implementation, 'ready');
      assert.equal(workflow.state.admission.enabled, true);
      assert.equal(workflow.state.admission.reason, null);
    } else {
      assert.equal(workflow.state.implementation, 'incomplete');
      assert.equal(workflow.state.admission.enabled, false);
      assert.equal(workflow.state.admission.reason, 'V2_FULL_CHAIN_NOT_COMPLETE');
    }
    assert.equal(workflow.state.validation.status, 'not_run');
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
