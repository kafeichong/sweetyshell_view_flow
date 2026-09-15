import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const source = new URL('contracts/seedance-workflows.v2.json', root);
const targets = [
  new URL('packages/backend/src/tasks/resources/seedance-workflows.v2.json', root),
  new URL('packages/worker/resources/seedance-workflows.v2.json', root),
];

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('sync check requires byte-identical backend and worker contract resources', async () => {
  const command = spawnSync(process.execPath, ['scripts/sync_workflow_contracts.mjs', '--check'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(command.status, 0, command.stderr || command.stdout);

  const expected = digest(await readFile(source));
  for (const target of targets) {
    assert.equal(digest(await readFile(target)), expected);
  }
});

test('Nest copies the backend contract beside the compiled catalog service', async () => {
  const nestConfig = JSON.parse(await readFile(new URL('packages/backend/nest-cli.json', root), 'utf8'));
  const asset = nestConfig.compilerOptions.assets.find((item) => item.include === 'tasks/resources/*.json');
  assert.equal(asset.outDir, 'dist');
});
