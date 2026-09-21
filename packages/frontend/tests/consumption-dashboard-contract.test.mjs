import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const dashboardPath = new URL('../app/(app)/dashboard/page.tsx', import.meta.url);
const chartPath = new URL('../components/charts/TrendChart.tsx', import.meta.url);
const typesPath = new URL('../types/api.ts', import.meta.url);

test('dashboard uses the current nested consumption contract', async () => {
  const source = await readFile(dashboardPath, 'utf8');

  assert.match(source, /overview\.daily\.total/);
  assert.match(source, /overview\.monthly\.total/);
  assert.doesNotMatch(source, /overview\?\.todayCny/);
  assert.doesNotMatch(source, /overview\?\.monthCny/);
});

test('administrator dashboard requests real overview, trends, and ranking data', async () => {
  const source = await readFile(dashboardPath, 'utf8');

  assert.match(source, /\/v1\/admin\/consumption\/overview/);
  assert.match(source, /\/v1\/admin\/consumption\/trends/);
  assert.match(source, /\/v1\/admin\/consumption\/summary/);
  assert.doesNotMatch(source, /todayCny:\s*'0\.00'/);
});

test('trend chart reads date and amount from the backend response', async () => {
  const source = await readFile(chartPath, 'utf8');

  assert.match(source, /item\.date\.slice/);
  assert.match(source, /parseFloat\(item\.amount\)/);
  assert.doesNotMatch(source, /item\.dayKey/);
  assert.doesNotMatch(source, /item\.totalCny/);
});

test('frontend types mirror the backend response fields', async () => {
  const source = await readFile(typesPath, 'utf8');

  assert.match(source, /daily:\s*ConsumptionPeriod/);
  assert.match(source, /monthly:\s*ConsumptionPeriod/);
  assert.match(source, /date:\s*string/);
  assert.match(source, /amount:\s*string/);
  assert.doesNotMatch(source, /todayCny:\s*string/);
});
