// requiredOrigins 单测（node:test + esbuild bundle）
// 覆盖: 各 provider 预设端点 / 端口剥离 / embedding 通道 / Obsidian rest-api 通道
import assert from 'node:assert';
import { test } from 'node:test';

const { requiredOrigins } = await import('../../src/lib/llm/index.js');

test('requiredOrigins: preset provider 取 presetBase origin', () => {
  assert.deepStrictEqual(requiredOrigins({ provider: 'deepseek' }), ['https://api.deepseek.com/*']);
});

test('requiredOrigins: anthropic 无 presetBase，走硬编码端点', () => {
  assert.deepStrictEqual(requiredOrigins({ provider: 'anthropic' }), ['https://api.anthropic.com/*']);
});

test('requiredOrigins: ollama 展开 localhost + 127.0.0.1', () => {
  assert.deepStrictEqual(
    requiredOrigins({ provider: 'ollama' }),
    ['http://localhost/*', 'http://127.0.0.1/*']
  );
});

test('requiredOrigins: openai-compatible 用 baseUrl 且剥离端口（match pattern 不含端口）', () => {
  assert.deepStrictEqual(
    requiredOrigins({ provider: 'openai-compatible', baseUrl: 'http://192.168.1.5:8080/v1' }),
    ['http://192.168.1.5/*']
  );
});

test('requiredOrigins: opencode 附带文档页 origin（别名增强）', () => {
  const o = requiredOrigins({ provider: 'opencode' });
  assert.ok(o.includes('https://opencode.ai/*'));
});

test('requiredOrigins: embedding local 通道加 huggingface 两条', () => {
  const o = requiredOrigins({ provider: 'deepseek', semanticRecall: 'local' });
  assert.ok(o.includes('https://huggingface.co/*'));
  assert.ok(o.includes('https://*.huggingface.co/*'));
});

test('requiredOrigins: obsidianExportMode rest-api 加 127.0.0.1（Local REST API 插件）', () => {
  const o = requiredOrigins({ provider: 'deepseek', obsidianExportMode: 'rest-api' });
  assert.ok(o.includes('http://127.0.0.1/*'));
});

test('requiredOrigins: fs-access（默认）不加 127.0.0.1', () => {
  const o = requiredOrigins({ provider: 'deepseek', obsidianExportMode: 'fs-access' });
  assert.ok(!o.includes('http://127.0.0.1/*'));
});

test('requiredOrigins: ollama + rest-api 时 127.0.0.1 去重', () => {
  const o = requiredOrigins({ provider: 'ollama', obsidianExportMode: 'rest-api' });
  assert.strictEqual(o.filter((x) => x === 'http://127.0.0.1/*').length, 1);
});

test('requiredOrigins: 非法 baseUrl 静默忽略', () => {
  assert.deepStrictEqual(
    requiredOrigins({ provider: 'openai-compatible', baseUrl: 'not a url' }),
    []
  );
});
