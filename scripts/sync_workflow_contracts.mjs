import { constants } from 'node:fs';
import { access, copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const source = new URL('contracts/seedance-workflows.v2.json', root);
const targets = [
  new URL('packages/backend/src/tasks/resources/seedance-workflows.v2.json', root),
  new URL('packages/worker/resources/seedance-workflows.v2.json', root),
];
const checkOnly = process.argv.includes('--check');

async function exists(url) {
  try {
    await access(url, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

const sourceBytes = await readFile(source);
let failed = false;

for (const target of targets) {
  const label = relative(fileURLToPath(root), fileURLToPath(target));
  if (checkOnly) {
    if (!(await exists(target)) || !sourceBytes.equals(await readFile(target))) {
      console.error(`workflow contract out of sync: ${label}`);
      failed = true;
    }
    continue;
  }

  await mkdir(dirname(fileURLToPath(target)), { recursive: true });
  await copyFile(source, target);
  console.log(`synced ${label}`);
}

if (failed) process.exitCode = 1;
