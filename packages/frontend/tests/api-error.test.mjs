import assert from 'node:assert/strict';
import test from 'node:test';
import { getApiErrorMessage } from '../lib/api.ts';

const apiError = (message) => ({ isAxiosError: true, response: { data: { message } } });

test('API failures retain server messages and validation details', () => {
  assert.equal(getApiErrorMessage(apiError('额度不足'), '加载失败'), '额度不足');
  assert.equal(getApiErrorMessage(apiError(['月份无效', 'Provider 必填']), '加载失败'), '月份无效, Provider 必填');
});

test('network and malformed failures use a safe caller fallback', () => {
  for (const error of [null, new Error('network'), apiError(undefined), apiError(''), apiError({ detail: 'bad' }), apiError(['bad', 42])]) {
    assert.equal(getApiErrorMessage(error, '加载失败'), '加载失败');
  }
});
