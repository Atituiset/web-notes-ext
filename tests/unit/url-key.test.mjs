// url-key 分级 key 单测（node:test + esbuild bundle）
// 覆盖: pageKey 白名单/排序/幂等、siteKey、matchesPage 新旧数据兼容、lookupKeys
import assert from 'node:assert';
import { test } from 'node:test';

const { pageKey, siteKey, matchesPage, lookupKeys } = await import('../../src/lib/url-key.js');

// ---- pageKey ----

test('pageKey: 无 query 时返回 origin+pathname', () => {
  assert.equal(pageKey('https://example.com/a/b'), 'https://example.com/a/b');
});

test('pageKey: 丢弃跟踪参数（utm*/ref 等）', () => {
  assert.equal(
    pageKey('https://example.com/a?utm_source=tw&ref=x'),
    'https://example.com/a'
  );
});

test('pageKey: 保留内容区分参数（id）', () => {
  assert.equal(
    pageKey('https://forum.com/thread?id=123'),
    'https://forum.com/thread?id=123'
  );
});

test('pageKey: 混合参数=保留白名单+丢弃其余', () => {
  assert.equal(
    pageKey('https://forum.com/t?id=9&utm_source=x#sec'),
    'https://forum.com/t?id=9'
  );
});

test('pageKey: 多个保留参数按名排序（稳定性）', () => {
  const a = pageKey('https://x.com/p?page=2&id=7');
  const b = pageKey('https://x.com/p?id=7&page=2');
  assert.equal(a, 'https://x.com/p?id=7&page=2');
  assert.equal(a, b);
});

test('pageKey: 幂等（对已是 key 的输入原样返回）', () => {
  const k = pageKey('https://x.com/a?id=1&utm_m=z');
  assert.equal(pageKey(k), k);
});

test('pageKey: 非法输入原样返回', () => {
  assert.equal(pageKey('chrome://extensions'), 'chrome://extensions');
});

// ---- siteKey ----

test('siteKey: 返回 hostname 并去 www.', () => {
  assert.equal(siteKey('https://www.example.com/a/b'), 'example.com');
  assert.equal(siteKey('https://en.example.com/a'), 'en.example.com');
});

test('siteKey: 非法输入原样返回', () => {
  assert.equal(siteKey('not a url'), 'not a url');
});

// ---- matchesPage ----

test('matchesPage: 精确 page key 匹配', () => {
  assert.ok(matchesPage('https://f.com/t?id=1', 'https://f.com/t?id=1'));
});

test('matchesPage: 同 key 仅差跟踪参数视为同页', () => {
  assert.ok(matchesPage('https://f.com/t?id=1', 'https://f.com/t?id=1&utm_s=x'));
});

test('matchesPage: 旧数据（裸 path）对同 path 的 query 变体可见（升级兼容）', () => {
  assert.ok(matchesPage('https://f.com/t', 'https://f.com/t?id=1'));
  assert.ok(matchesPage('https://f.com/t', 'https://f.com/t?id=2'));
});

test('matchesPage: 反向不回漏 —— 带 id 的新 key 不出现在裸 path 页', () => {
  assert.ok(!matchesPage('https://f.com/t?id=1', 'https://f.com/t'));
});

test('matchesPage: 不同 id 互相不可见', () => {
  assert.ok(!matchesPage('https://f.com/t?id=1', 'https://f.com/t?id=2'));
});

test('matchesPage: 不同 path 不匹配', () => {
  assert.ok(!matchesPage('https://f.com/a', 'https://f.com/b'));
});

test('matchesPage: site key（裸域名）永不匹配页面', () => {
  assert.ok(!matchesPage('example.com', 'https://example.com/a'));
});

// ---- lookupKeys ----

test('lookupKeys: 含 site key + page key + 裸 path；无 query 时去重', () => {
  const noQuery = lookupKeys('https://f.com/t');
  assert.deepStrictEqual(new Set(noQuery), new Set(['f.com', 'https://f.com/t']));

  const withQuery = lookupKeys('https://f.com/t?id=3&utm_s=m');
  assert.deepStrictEqual(
    new Set(withQuery),
    new Set(['f.com', 'https://f.com/t?id=3', 'https://f.com/t'])
  );
});
