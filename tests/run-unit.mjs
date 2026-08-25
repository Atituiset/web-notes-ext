import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 用 esbuild 把 TS 测试目标打成 CJS 单文件，再交给 node:test 跑
const out = '/tmp/wne-mem-test.mjs';
execSync(
  `npx esbuild tests/unit/memory.test.mjs --bundle --format=esm --platform=node --outfile=${out}`,
  { stdio: 'inherit' }
);
execSync(`node --test ${out}`, { stdio: 'inherit' });
