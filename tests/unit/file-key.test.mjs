// file-key 文件/项目分级 key 单测（node:test + esbuild bundle）
// 覆盖: fileKey 归一/幂等/越界回退、projectKey、lookupKeys 两级集合
import assert from 'node:assert';
import { test } from 'node:test';

const { fileKey, projectKey, isProjectKey, lookupKeys } = await import('../../packages/core/src/file-key.js');

test('fileKey: 绝对路径归一为 workspace 相对 posix 路径', () => {
  assert.equal(fileKey('/home/u/proj/src/a/b.ts', '/home/u/proj'), 'src/a/b.ts');
  assert.equal(fileKey('/home/u/proj/README.md', '/home/u/proj/'), 'README.md'); // 根带尾斜杠
});

test('fileKey: Windows 反斜杠路径归一', () => {
  assert.equal(fileKey('C:\\work\\proj\\src\\main.ts', 'C:\\work\\proj'), 'src/main.ts');
});

test('fileKey: 幂等 — 已是相对 key 的输入原样返回（去 ./ 前缀）', () => {
  assert.equal(fileKey('src/a/b.ts', '/home/u/proj'), 'src/a/b.ts');
  assert.equal(fileKey('./src/a/b.ts', '/home/u/proj'), 'src/a/b.ts');
});

test('fileKey: 越出根的路径按 posix 化原样回退（不可作相对 key）', () => {
  assert.equal(fileKey('/etc/hosts', '/home/u/proj'), '/etc/hosts');
  assert.equal(fileKey('/home/u/other/x.ts', '/home/u/proj'), '/home/u/other/x.ts');
});

test('fileKey: 路径即根本身返回空串', () => {
  assert.equal(fileKey('/home/u/proj', '/home/u/proj'), '');
});

test('projectKey: 带前缀且与 file key 命名空间隔离', () => {
  assert.equal(projectKey('my-proj'), 'project:my-proj');
  assert.ok(isProjectKey(projectKey('my-proj')));
  assert.ok(!isProjectKey('src/a.ts'));
});

test('lookupKeys: file key + project key 两级集合', () => {
  assert.deepEqual(lookupKeys('/p/src/a.ts', '/p', 'p'), ['src/a.ts', 'project:p']);
  // 无文件名时只有 project key
  assert.deepEqual(lookupKeys('/p', '/p', 'p'), ['project:p']);
});
