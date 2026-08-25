// 记忆纯函数单测（node:test + esbuild bundle 后运行）
// 运行方式: npm test （见 package.json，走 build.mjs 里的 test 步骤或直接 node --test）
import assert from 'node:assert';
import { test } from 'node:test';
import { tokenize, scoreMemory, isCold } from '../../src/lib/memory.js';
import { shouldIgnore, guessTags } from '../../src/lib/memory-extract.js';

test('tokenize: english words', () => {
  const t = tokenize('clangd protocol header file');
  assert.ok(t.includes('clangd'));
  assert.ok(t.includes('protocol'));
});

test('tokenize: chinese bigrams', () => {
  const t = tokenize('用户偏好简洁回答');
  assert.ok(t.length > 0);
  assert.ok(t.includes('用户'));
  assert.ok(t.includes('偏好'));
});

test('scoreMemory: pinned beats relevance', () => {
  const now = Date.now();
  const pinned = { body: '完全无关的内容 xyz', tags: [], domain: undefined, pinned: true, hits: 0, updated: new Date(now - 100 * 86400000).toISOString() };
  const relevant = { body: '用户喜欢简洁的 clangd 回答', tags: ['preference'], domain: 'clangd', pinned: false, hits: 3, updated: new Date(now).toISOString() };
  const q = new Set(tokenize('clangd 简洁'));
  assert.ok(scoreMemory(pinned, q, now) > scoreMemory(relevant, q, now));
});

test('scoreMemory: relevance ranks higher than irrelevant', () => {
  const now = Date.now();
  const a = { body: '用户偏好中文回答', tags: ['preference'], domain: undefined, pinned: false, hits: 0, updated: new Date(now).toISOString() };
  const b = { body: '完全不相关的一条旧记录', tags: [], domain: undefined, pinned: false, hits: 0, updated: new Date(now).toISOString() };
  const q = new Set(tokenize('偏好 中文'));
  assert.ok(scoreMemory(a, q, now) > scoreMemory(b, q, now));
});

test('isCold logic', () => {
  const old = { type: 'memory', scope: 'user', created: '', updated: new Date(Date.now() - 120 * 86400000).toISOString(), confidence: 'medium', pinned: false, hits: 0, tags: [], file: 'a.md', body: 'x' };
  const recent = { ...old, updated: new Date().toISOString() };
  const pinned = { ...old, pinned: true };
  const used = { ...old, hits: 2 };
  assert.ok(isCold(old));
  assert.ok(!isCold(recent));
  assert.ok(!isCold(pinned));
  assert.ok(!isCold(used));
});

test('shouldIgnore: greetings & empty', () => {
  assert.ok(shouldIgnore('你好', '你好！有什么可以帮你？'));
  assert.ok(shouldIgnore('hi', 'hello'));
  assert.ok(shouldIgnore('任意问题', ''));
  assert.ok(!shouldIgnore('clangd 的 Protocol.h 结构是什么', '它定义了 LSP 数据结构…'));
});

test('guessTags heuristics', () => {
  assert.ok(guessTags('我喜欢简洁的回答').includes('preference'));
  assert.ok(guessTags('我之前理解错了，正确的是X').includes('correction'));
  assert.ok(guessTags('这个协议的结论是Y').includes('conclusion'));
});
