// vsix 打包：vsce 不接受 npm scope 包名（@markpilot/vscode-ext），
// 打包时临时改写 package.json 的 name，结束（含失败）后恢复原文。
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const original = readFileSync('package.json', 'utf8');
const pkg = JSON.parse(original);
pkg.name = 'markpilot-code';
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
try {
  execSync('npx vsce package --no-dependencies', { stdio: 'inherit' });
} finally {
  writeFileSync('package.json', original);
}
