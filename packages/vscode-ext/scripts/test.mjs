// 扩展宿主集成测试 runner：esbuild 打测试入口 → @vscode/test-electron 下载并启动
// VS Code（headed，WSLg），在真实扩展宿主里跑 dist/test/suite.js。
// 运行：npm run test:vscode（根或本包）。不纳入 npm test —— 需要显示与 ~100MB 下载。
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 1. 扩展 bundle + 测试入口 bundle（mocha 外置：运行时从根 node_modules 解析）
execSync('node build.mjs', { cwd: pkgRoot, stdio: 'inherit' });
execSync(
  'npx esbuild src/test/suite.ts --bundle --format=cjs --platform=node ' +
    '--outfile=dist/test/suite.js --sourcemap ' +
    '--external:vscode --external:mocha --external:@xenova/transformers --external:onnxruntime-node',
  { cwd: pkgRoot, stdio: 'inherit' }
);

// 2. 测试工作区（笔记平移用例需要 workspace folder + 样本文件）
const ws = path.join(os.tmpdir(), 'markpilot-test-ws');
fs.rmSync(ws, { recursive: true, force: true });
fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
fs.writeFileSync(path.join(ws, 'src', 'sample.md'), 'l0\nl1\nl2\nl3\n');

// 3. 启动扩展宿主（WSLg headed；--no-sandbox 兼容受限环境）
await runTests({
  extensionDevelopmentPath: pkgRoot,
  extensionTestsPath: path.join(pkgRoot, 'dist', 'test', 'suite.js'),
  launchArgs: [ws, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});
