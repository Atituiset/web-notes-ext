// E2E：设置页「测试」按钮 + 下拉选中自动测
//   mock /v1/models 返回 mock-model / mock-503；
//   chat/completions 对 mock-503 回 503，其余回 SSE 'ok'
// 运行：node tests/e2e-model-test.cjs（需先 npm run build；headed）
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('/home/atituiset/.nvm/versions/node/v24.14.1/lib/node_modules/@playwright/cli/node_modules/playwright');

const ROOT = path.resolve(__dirname, '..');
const EXT_DIR = '/tmp/wne-ext-staging';
fs.rmSync(EXT_DIR, { recursive: true, force: true });
fs.mkdirSync(EXT_DIR, { recursive: true });
fs.cpSync(path.join(ROOT, 'dist'), EXT_DIR, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'manifest.json'), path.join(EXT_DIR, 'manifest.json'));
fs.cpSync(path.join(ROOT, 'icons'), path.join(EXT_DIR, 'icons'), { recursive: true });
const PORT = 8898;

let pass = 0, fail = 0;
const check = (n, c, extra) => {
  console.log((c ? 'PASS' : 'FAIL') + ' | ' + n + (extra ? ' | ' + extra : ''));
  c ? pass++ : fail++;
};

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model' }, { id: 'mock-503' }] }));
      return;
    }
    if (req.url.startsWith('/v1/chat/completions')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let model = '';
        try { model = JSON.parse(body).model; } catch {}
        if (model === 'mock-503') {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'server_error', message: 'Endpoint is unavailable.' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

(async () => {
  const server = await startServer();
  const ctx = await chromium.launchPersistentContext('/tmp/wne-mtest-profile-' + Date.now(), {
    headless: false,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, '--no-first-run'],
  });
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 10000 });
  const extId = new URL(sw.url()).host;

  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE-ERR:', m.text().slice(0, 200)); });
  await page.goto(`chrome-extension://${extId}/options/options.html`);
  await page.selectOption('#provider', 'openai-compatible');
  await page.fill('#baseUrl', `http://localhost:${PORT}/v1`);

  const statusOf = () => page.evaluate(() => document.getElementById('model-test-status').textContent);
  const waitStatus = (re) => page.waitForFunction(
    (pattern) => new RegExp(pattern).test(document.getElementById('model-test-status').textContent),
    re.source, { timeout: 15000 }
  ).catch(() => null);

  // 1. 手动点「测试」— 可用模型
  await page.fill('#model', 'mock-model');
  await page.click('#btn-test');
  await waitStatus(/[✓✗⚠]/);
  let s = await statusOf();
  check('可用模型显示 ✓', s.includes('✓') && s.includes('mock-model'), s);

  // 2. 手动点「测试」— 上游 503
  await page.fill('#model', 'mock-503');
  await page.click('#btn-test');
  await waitStatus(/[✓✗⚠]/);
  s = await statusOf();
  check('503 模型显示 ✗ 且含错误详情', s.includes('✗') && s.includes('503'), s.slice(0, 100));

  // 3. 下拉选中自动触发测试
  await page.fill('#model', '');
  await page.click('#btn-models'); // 拉模型列表并展开下拉
  const ddVisible = await page.waitForSelector('#model-dropdown .opt', { timeout: 8000 }).catch(() => null);
  if (!ddVisible) {
    console.log('DEBUG dd state:', JSON.stringify(await page.evaluate(() => {
      const dd = document.getElementById('model-dropdown');
      return { display: dd.style.display, opts: dd.querySelectorAll('.opt').length,
               status: document.getElementById('model-status').textContent.slice(0, 80),
               active: document.activeElement && document.activeElement.id };
    })));
  }
  // 直接派发 mousedown（与真实用户行为一致，handler 监听的就是 mousedown）
  await page.locator('#model-dropdown .opt', { hasText: 'mock-model' }).first()
    .dispatchEvent('mousedown', {}, { timeout: 8000 });
  await waitStatus(/[✓✗⚠]/);
  s = await statusOf();
  const modelVal = await page.evaluate(() => document.getElementById('model').value);
  check('下拉选中即自动测试', modelVal === 'mock-model' && s.includes('✓'), `model=${modelVal} status=${s}`);

  await ctx.close();
  server.close();
  console.log(`\n== ${pass}/${pass + fail} passed ==`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR:', e); process.exit(1); });
