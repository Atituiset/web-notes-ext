import { execSync } from 'node:child_process';

// 用 esbuild 把 TS 测试目标打成 ESM 单文件，再交给 node:test 跑
const cases = [
  ['tests/unit/memory.test.mjs', '/tmp/wne-mem-test.mjs'],
  ['tests/unit/markdown-xss.test.mjs', '/tmp/wne-xss-test.mjs'],
  ['tests/unit/pipeline.test.mjs', '/tmp/wne-pipeline-test.mjs'],
  ['tests/unit/model-picker.test.mjs', '/tmp/wne-picker-test.mjs'],
];
for (const [src, out] of cases) {
  execSync(
    `npx esbuild ${src} --bundle --format=esm --platform=node --outfile=${out}`,
    { stdio: 'inherit' }
  );
  execSync(`node --test ${out}`, { stdio: 'inherit' });
}
