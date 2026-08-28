// E2E：页面划词「问 AI」→ SW 中转 → 侧栏自动提问 全链路实测
//   1. 本地测试页 + mock OpenAI SSE 端点（localhost:8899）
//   2. 加载扩展（/tmp/wne-ext-staging = dist + manifest）
//   3. 真实鼠标拖选 → 点「🤖 问 AI」
//   4. 断言 SW 缓冲了 pendingAsk；panel 启动消费后自动发问
//   5. 断言 mock 收到的请求体含【选中原文】+ 选中文字；panel 渲染出 mock 回答
//   6. 附加断言 page:get-selection / page:get-text 消息回读通道
// 运行：node tests/e2e-ask-flow.cjs   （需先 npm run build；headed，走 WSLg）
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('/home/atituiset/.nvm/versions/node/v24.14.1/lib/node_modules/@playwright/cli/node_modules/playwright');

const ROOT = path.resolve(__dirname, '..');
// 加载的扩展目录 = dist 产物 + manifest（仓库根没有构建产物，不能直接加载）
const EXT_DIR = '/tmp/wne-ext-staging';
fs.rmSync(EXT_DIR, { recursive: true, force: true });
fs.mkdirSync(EXT_DIR, { recursive: true });
fs.cpSync(path.join(ROOT, 'dist'), EXT_DIR, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'manifest.json'), path.join(EXT_DIR, 'manifest.json'));
fs.cpSync(path.join(ROOT, 'icons'), path.join(EXT_DIR, 'icons'), { recursive: true });
fs.cpSync(path.join(ROOT, '_locales'), path.join(EXT_DIR, '_locales'), { recursive: true });
const PORT = 8899;

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
  cond ? pass++ : fail++;
};

const llmRequests = [];

function startServer() {
  const testPage = `<!DOCTYPE html><html><head><title>Test Page - Demo</title></head>
<body><article id="content">
<h1>第一章 简介</h1>
<p>${'Alpha paragraph about transformers and attention mechanisms in modern networks. '.repeat(2)}</p>
<p>Beta paragraph discusses memory systems in browsers at length, with many useful words here for testing.</p>
</article></body></html>`;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/v1/chat/completions')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try { llmRequests.push(JSON.parse(body)); } catch {}
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const words = ['Mock', ' 回答：', '选中内容', '已送达', '。'];
        let i = 0;
        const timer = setInterval(() => {
          if (i < words.length) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: words[i++] } }] })}\n\n`);
          } else {
            res.write('data: [DONE]\n\n');
            clearInterval(timer);
            res.end();
          }
        }, 15);
      });
      return;
    }
    if (req.url === '/' || req.url.startsWith('/page')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(testPage);
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const server = await startServer();
process.env.LANG = process.env.LC_ALL = 'zh_CN.UTF-8'; // 扩展 i18n 解析跟随进程 locale
  const ctx = await chromium.launchPersistentContext('/tmp/wne-ask-profile-' + Date.now(), {
    headless: false,
    locale: 'zh-CN',
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, '--no-first-run', '--lang=zh-CN'],
  });

  // 扩展 ID（从 service worker URL 取）
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 10000 });
  const extId = new URL(sw.url()).host;
  console.log('extension id:', extId);

  // ---- 测试页 + 真实划词 ----
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/page`, { waitUntil: 'load' });
  await page.waitForSelector('#wne-root', { state: 'attached', timeout: 8000 });
  check('content script 注入', true);

  const box = await page.evaluate(() => {
    const p = document.querySelector('#content p');
    p.scrollIntoView({ block: 'center' });
    const r = p.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  await page.mouse.move(box.x + 5, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 15; i++) {
    await page.mouse.move(box.x + 5 + Math.min(500, box.width - 10) * i / 15, box.y + box.height / 2);
  }
  await page.mouse.up();
  await sleep(400);

  const selState = await page.evaluate(() => {
    const bar = document.getElementById('wne-selbar');
    const sel = window.getSelection();
    return {
      selText: sel ? sel.toString().trim() : '',
      barVisible: bar && bar.style.display === 'flex',
    };
  });
  check('划词后工具条出现', selState.barVisible, JSON.stringify(selState.selText.slice(0, 40)));
  const selectedText = selState.selText;

  // ---- 点「🤖 问 AI」----
  await page.click('#wne-selbar button:nth-child(2)');
  await sleep(800);

  // ---- 断言 SW 缓冲了 pendingAsk（用 options 页读 storage.session，不触发消费）----
  const optPage = await ctx.newPage();
  await optPage.goto(`chrome-extension://${extId}/options/options.html`);
  const pending = await optPage.evaluate(async () => {
    const r = await chrome.storage.session.get('pendingAsk');
    return r.pendingAsk || null;
  });
  check('SW 缓冲 pendingAsk（panel 未开时的兜底）',
    !!(pending && pending.selection && selectedText.includes(pending.selection.slice(0, 20))),
    JSON.stringify(pending).slice(0, 120));

  // 预置 mock provider 设置（openai-compatible → localhost mock）
  await optPage.evaluate(async (port) => {
    const req = indexedDB.open('web-notes-ext', 3);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('pages')) db.createObjectStore('pages', { keyPath: 'url' });
      if (!db.objectStoreNames.contains('notes')) {
        const s = db.createObjectStore('notes', { keyPath: 'id' });
        s.createIndex('url', 'url', { unique: false });
      }
      if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles', { keyPath: 'name' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('threads')) {
        const t = db.createObjectStore('threads', { keyPath: 'id' });
        t.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
    };
    await new Promise((res, rej) => { req.onsuccess = res; req.onerror = rej; });
    const db = req.result;
    await new Promise((res, rej) => {
      const t = db.transaction('settings', 'readwrite');
      t.objectStore('settings').put({
        key: 'app',
        value: {
          provider: 'openai-compatible',
          baseUrl: `http://localhost:${port}/v1`,
          model: 'mock-model',
          apiKeys: {},
          memoryInject: false,
          autoMemory: false,
        },
      });
      t.oncomplete = res; t.onerror = rej;
    });
  }, PORT);
  await optPage.close();

  // ---- 打开 panel（模拟侧栏），启动消费 pendingAsk → 应自动发问 ----
  const panel = await ctx.newPage();
  await page.bringToFront(); // 保持测试页为活动 tab，activeTabInfo 才能指到它
  await panel.goto(`chrome-extension://${extId}/panel/panel.html`);

  // 等 mock 收到请求
  let req0 = null;
  for (let i = 0; i < 40 && !llmRequests.length; i++) await sleep(250);
  req0 = llmRequests[0];
  check('panel 自动向 LLM 发问（无需手动点发送）', !!req0);

  if (req0) {
    const allContent = (req0.messages || []).map((m) => m.content || '').join('\n');
    check('请求体含【选中原文】材料', allContent.includes('【选中原文】'));
    check('请求体含实际选中文字', allContent.includes(selectedText.slice(0, 30)),
      JSON.stringify(selectedText.slice(0, 30)));
    check('请求体含自动问题「解释这段话」', allContent.includes('解释这段话'));
  }

  // panel 渲染出 mock 回答
  let answerText = '';
  try {
    await panel.waitForSelector('.msg.assistant.done', { timeout: 12000 });
    answerText = await panel.evaluate(() => {
      const d = document.querySelector('.msg.assistant.done .body');
      return d ? d.textContent : '';
    });
  } catch {}
  check('panel 渲染 mock 回答', answerText.includes('选中内容') && answerText.includes('已送达'),
    JSON.stringify(answerText.slice(0, 60)));

  // scope 应被锁到「仅当前选区」
  const scopeVal = await panel.evaluate(() => document.getElementById('chat-scope').value);
  check('chat-scope 自动切到 selection', scopeVal === 'selection', scopeVal);

  // ---- 附加：page:get-text / page:get-selection 回读通道 ----
  const readback = await panel.evaluate(async () => {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    const out = { tabUrl: t && t.url };
    try {
      const r = await chrome.tabs.sendMessage(t.id, { type: 'page:get-text' });
      out.text = r && r.ok ? r.text : null;
    } catch (e) { out.textErr = String(e).slice(0, 80); }
    try {
      const r2 = await chrome.tabs.sendMessage(t.id, { type: 'page:get-selection' });
      out.selection = r2 && r2.selection;
    } catch (e) { out.selErr = String(e).slice(0, 80); }
    return out;
  });
  check('page:get-text 回读正文', !!(readback.text && readback.text.includes('Alpha paragraph')),
    (readback.text || readback.textErr || '').slice(0, 60));
  check('page:get-selection 回读选区', !!(readback.selection && selectedText.includes(readback.selection.slice(0, 20))),
    JSON.stringify(readback.selection || readback.selErr || '').slice(0, 60));

  await page.screenshot({ path: '/tmp/wne-ask-page.png' });
  await panel.screenshot({ path: '/tmp/wne-ask-panel.png' });
  console.log('screenshots: /tmp/wne-ask-page.png /tmp/wne-ask-panel.png');

  await ctx.close();
  server.close();
  console.log(`\n== ${pass}/${pass + fail} passed ==`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR:', e); process.exit(1); });
