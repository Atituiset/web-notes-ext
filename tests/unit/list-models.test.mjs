// listModels 预置回退单测（node:test + esbuild bundle）
// 覆盖: 默认回退 / fallbackToPresets:false 抛错 / 在线成功返回在线列表 / 无预设始终抛错
import assert from 'node:assert';
import { test } from 'node:test';

const { listModels } = await import('../../packages/core/src/llm/index.js');

const jsonResp = (data, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => data,
  text: async () => JSON.stringify(data),
});

test('listModels: fetch 失败且有预设 → 默认回退预设列表（兼容既有调用方）', async () => {
  globalThis.fetch = async () => {
    throw new Error('network down');
  };
  const models = await listModels({ provider: 'deepseek', apiKeys: { deepseek: 'k' } });
  assert.deepStrictEqual(
    models.map((m) => m.id),
    ['deepseek-chat', 'deepseek-reasoner']
  );
});

test('listModels: fallbackToPresets:false → 401 直接抛出（设置页须分辨真实错误）', async () => {
  globalThis.fetch = async () => jsonResp({ error: 'unauthorized' }, false, 401);
  await assert.rejects(
    () => listModels({ provider: 'deepseek', apiKeys: {} }, { fallbackToPresets: false }),
    /401/
  );
});

test('listModels: fetch 成功 → 返回在线列表而非预设', async () => {
  globalThis.fetch = async () => jsonResp({ data: [{ id: 'v4-pro' }, { id: 'v4-flash' }] });
  const models = await listModels({ provider: 'deepseek', apiKeys: {} }, { fallbackToPresets: false });
  assert.deepStrictEqual(
    models.map((m) => m.id),
    ['v4-flash', 'v4-pro']
  );
});

test('listModels: 无预设 provider fetch 失败 → 两种模式都抛出', async () => {
  globalThis.fetch = async () => {
    throw new Error('conn refused');
  };
  const settings = { provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKeys: {} };
  await assert.rejects(() => listModels(settings), /拉取模型列表失败/);
  await assert.rejects(() => listModels(settings, { fallbackToPresets: false }), /拉取模型列表失败/);
});
