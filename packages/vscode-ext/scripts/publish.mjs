// 发布到 VS Code Marketplace：vsce 不接受 npm scope 包名（@markpilot/vscode-ext）
// 和 "private": true，发布时临时改写 package.json，结束（含失败）后恢复原文。
// 用法：node scripts/publish.mjs [版本号]（不传则发布 package.json 当前版本）
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const version = process.argv[2];
const original = readFileSync('package.json', 'utf8');
const pkg = JSON.parse(original);
pkg.name = 'markpilot-code';
delete pkg.private;
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
try {
  execSync(`npx vsce publish --no-dependencies${version ? ` ${version}` : ''}`, {
    stdio: 'inherit',
  });
} finally {
  writeFileSync('package.json', original);
}
