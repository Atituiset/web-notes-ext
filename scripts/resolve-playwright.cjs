// 共享 Playwright 解析：e2e/eval 脚本与资源生成脚本统一从这里拿 chromium。
// 解析顺序：
//   1. require('playwright')（本地 node_modules，或 NODE_PATH 可及的全局安装）
//   2. npm 全局 root 下的 playwright / @playwright/cli 内置 playwright
//   3. 报清晰错误
const { execSync } = require('node:child_process');
const path = require('node:path');

function tryRequire(id) {
  try {
    return require(id);
  } catch {
    return null;
  }
}

function resolvePlaywright() {
  const direct = tryRequire('playwright');
  if (direct) return direct;
  // 全局安装（npm i -g）默认不在 require 搜索路径里，手动拼 global root
  const roots = [];
  try {
    roots.push(execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch { /* npm 不可用时走下面的常见路径 */ }
  roots.push('/usr/local/lib/node_modules', '/usr/lib/node_modules');
  for (const root of roots) {
    for (const cand of ['playwright', '@playwright/cli/node_modules/playwright']) {
      const pw = tryRequire(path.join(root, cand));
      if (pw) return pw;
    }
  }
  throw new Error('Playwright not found: npm i -D playwright 或 npm i -g @playwright/cli');
}

module.exports = resolvePlaywright();
