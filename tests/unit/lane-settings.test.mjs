// laneSettings 双模型路由单测（node:test + esbuild bundle）
// 覆盖: aux 车道有辅助模型时替换 / 未配置回落主模型 / main 车道永不替换 / 不改原对象
import assert from 'node:assert';
import { test } from 'node:test';

const { laneSettings } = await import('../../packages/core/src/llm/index.js');

const base = { provider: 'deepseek', model: 'deepseek-chat', apiKeys: { deepseek: 'k' } };

test('laneSettings: aux 车道配置了 auxModel → 换用辅助模型', () => {
  const s = laneSettings({ ...base, auxModel: 'glm-4-flash' }, 'aux');
  assert.strictEqual(s.model, 'glm-4-flash');
  assert.strictEqual(s.provider, 'deepseek'); // 其余字段保持不变
});

test('laneSettings: aux 车道未配置 auxModel（空串/缺字段）→ 回落主模型', () => {
  assert.strictEqual(laneSettings({ ...base, auxModel: '' }, 'aux').model, 'deepseek-chat');
  assert.strictEqual(laneSettings(base, 'aux').model, 'deepseek-chat');
});

test('laneSettings: main 车道即使配了 auxModel 也不替换', () => {
  assert.strictEqual(laneSettings({ ...base, auxModel: 'glm-4-flash' }, 'main').model, 'deepseek-chat');
});

test('laneSettings: 替换走拷贝，不改原 settings 对象', () => {
  const s = { ...base, auxModel: 'glm-4-flash' };
  laneSettings(s, 'aux');
  assert.strictEqual(s.model, 'deepseek-chat');
});
