// E2E：流式中切 tab 的页面跟随与线程隔离（针对三个线上反馈）
//   症状1: 流式中切 tab，A 的会话「漏」到 B —— 面板应立即跟随到 B 的视图
//   症状2: 切回 A 后聊天内容没了 —— 完成后切回应看到完整问答（后台落存储 + 视图归位）
//   症状3: 在 B 直接提问，B 的内容答进 A 的线程 —— 提问前归属校验，另起线程
// 场景：
//   1. A 页慢速 SSE 流式提问中 bringToFront(B) → 断言面板视图切走（欢迎屏回来）
//   2. 流式中在 B 提问 → 断言被拦（toast，无第二个 LLM 请求）
//   3. 流式结束后（人在 B）在 B 提问 → 断言新请求带 B 页正文，且 threads 库里 A 线程未被污染
//   4. 切回 A → 断言 A 的完整问答重新可见
// 运行：node tests/e2e-tab-switch.cjs   （需先 npm run build；headed，走 WSLg）
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('../scripts/resolve-playwright.cjs');

const ROOT = path.resolve(__dirname, '..');
const EXT_DIR = '/tmp/wne-ext-staging-tab';
fs.rmSync(EXT_DIR, { recursive: true, force: true });
fs.mkdirSync(EXT_DIR, { recursive: true });
fs.cpSync(path.join(ROOT, 'dist'), EXT_DIR, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'manifest.json'), path.join(EXT_DIR, 'manifest.json'));
fs.cpSync(path.join(ROOT, 'icons'), path.join(EXT_DIR, 'icons'), { recursive: true });
fs.cpSync(path.join(ROOT, '_locales'), path.join(EXT_DIR, '_locales'), { recursive: true });
const PORT = 8898;

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
  cond ? pass++ : fail++;
};

const llmRequests = [];

const PAGE_A = `<!DOCTYPE html><html><head><title>Page A</title></head>
<body><article id="content"><h1>Alpha 页面</h1>
<p>${'Alpha content about transformers and attention. '.repeat(4)}</p></article></body></html>`;
const PAGE_B = `<!DOCTYPE html><html><head><title>Page B</title></head>
<body><article id="content"><h1>Beta 页面</h1>
<p>${'Gamma content about cooking recipes and kitchen tools. '.repeat(4)}</p></article></body></html>`;

function startServer() {
  const server = http.createServer((req, res) => {
    // 测试不经设置页授权：面板 fetch 走 CORS 放行（ensureHost 由 panel.addInitScript 打桩）
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      res.end();
      return;
    }
    if (req.url.startsWith('/v1/chat/completions')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try { llmRequests.push(JSON.parse(body)); } catch {}
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' });
        // 慢速流：20 片 × 150ms ≈ 3s，留出切 tab 窗口
        let i = 0;
        const timer = setInterval(() => {
          if (i < 20) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'tok' + i++ + ' ' } }] })}\n\n`);
          } else {
            res.write('data: [DONE]\n\n');
            clearInterval(timer);
            res.end();
          }
        }, 150);
      });
      return;
    }
    if (req.url.startsWith('/pageA')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE_A);
      return;
    }
    if (req.url.startsWith('/pageB')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE_B);
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const server = await startServer();
  process.env.LANG = process.env.LC_ALL = 'zh_CN.UTF-8';
  const ctx = await chromium.launchPersistentContext('/tmp/wne-tab-profile-' + Date.now(), {
    headless: false,
    locale: 'zh-CN',
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, '--no-first-run', '--lang=zh-CN'],
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 10000 });
  const extId = new URL(sw.url()).host;
  console.log('extension id:', extId);

  const pageA = await ctx.newPage();
  await pageA.goto(`http://localhost:${PORT}/pageA`, { waitUntil: 'load' });
  const pageB = await ctx.newPage();
  await pageB.goto(`http://localhost:${PORT}/pageB`, { waitUntil: 'load' });

  // 预置 mock provider（经 options 页写 IndexedDB settings）
  const optPage = await ctx.newPage();
  await optPage.goto(`chrome-extension://${extId}/options/options.html`);
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

  // 打开 panel（模拟侧栏），激活页切回 A
  const panel = await ctx.newPage();
  // 测试不经设置页授权：打桩 ensureHost 依赖的 chrome.permissions.contains（CORS 由 mock 服务端放行）
  await panel.addInitScript(() => {
    try {
      chrome.permissions.contains = () => Promise.resolve(true);
    } catch { /* chrome.permissions 不可写时忽略（会暴露为 ensureHost 报错） */ }
  });
  await panel.goto(`chrome-extension://${extId}/panel/panel.html`);
  await pageA.bringToFront();
  await sleep(600); // 等启动 sync 完成

  // ---- A 页提问（scope=page），进入慢速流式 ----
  await panel.evaluate(() => {
    document.querySelector('nav.tabs button[data-tab="chat"]').click();
    document.getElementById('chat-q').value = '总结这个页面';
    document.getElementById('btn-send').click();
  });
  for (let i = 0; i < 40 && !llmRequests.length; i++) await sleep(250);
  if (!llmRequests.length) {
    const dump = await panel.evaluate(() => ({
      err: (document.querySelector('.err') || {}).textContent || '',
      main: (document.getElementById('main') || {}).textContent || '',
      scope: (document.getElementById('chat-scope') || {}).value,
    }));
    console.log('panel dump:', JSON.stringify(dump).slice(0, 400));
  }
  check('A 页提问已发到 LLM', llmRequests.length === 1);
  const reqA = llmRequests[0];
  const allA = (reqA.messages || []).map((m) => m.content || '').join('\n');
  check('A 请求带 A 页正文', allA.includes('Alpha content'));

  // ---- 症状1：流式中切到 B —— 面板应立即跟随，不再显示 A 的会话 ----
  await sleep(400); // 让流跑起来（已有气泡）
  await pageB.bringToFront();
  await sleep(900); // onActivated → syncWithActiveTab
  const viewOnB = await panel.evaluate(() => ({
    hasAiBubble: !!document.querySelector('.msg.assistant'),
    hasWelcome: !!document.querySelector('.starters'),
  }));
  check('流式中切到 B：A 的会话从视图消失', !viewOnB.hasAiBubble, JSON.stringify(viewOnB));
  check('流式中切到 B：显示 B 的视图（欢迎屏）', viewOnB.hasWelcome, JSON.stringify(viewOnB));

  // ---- 症状3a：流式中在 B 提问 —— 应被拦截，不产生第二个请求 ----
  await panel.evaluate(() => {
    document.getElementById('chat-q').value = '流式中插队提问';
    document.getElementById('btn-send').click();
  });
  await sleep(700);
  check('流式中在 B 提问被拦截（无第二个 LLM 请求）', llmRequests.length === 1,
    'requests=' + llmRequests.length);

  // ---- 等流式在后台完成 ----
  await sleep(3200);

  // ---- 症状3b：流式结束后（人在 B）在 B 提问 —— 带 B 正文、不污染 A 线程 ----
  await panel.evaluate(() => {
    document.getElementById('chat-q').value = '这个页面讲什么';
    document.getElementById('btn-send').click();
  });
  for (let i = 0; i < 40 && llmRequests.length < 2; i++) await sleep(250);
  check('B 页提问发出第二个请求', llmRequests.length === 2);
  if (llmRequests[1]) {
    const allB = (llmRequests[1].messages || []).map((m) => m.content || '').join('\n');
    check('B 请求带 B 页正文（Gamma）', allB.includes('Gamma content'));
    check('B 请求不带 A 页正文（Alpha）', !allA.includes('Gamma') || !allB.includes('Alpha content'));
  }
  // 等 B 的回答完成
  await sleep(3200);

  // 线程隔离：A 线程应只有 1 轮问答，B 线程独立存在
  const threads = await panel.evaluate(async () => {
    const req = indexedDB.open('web-notes-ext', 3);
    await new Promise((res, rej) => { req.onsuccess = res; req.onerror = rej; });
    const db = req.result;
    return new Promise((res, rej) => {
      const t = db.transaction('threads', 'readonly');
      const rq = t.objectStore('threads').getAll();
      rq.onsuccess = () => res(rq.result.map((x) => ({ url: x.url, msgs: (x.messages || []).length, roles: (x.messages || []).map((m) => m.role).join(',') })));
      rq.onerror = rej;
    });
  });
  console.log('threads:', JSON.stringify(threads));
  const aThread = threads.find((x) => (x.url || '').includes('pageA'));
  const bThread = threads.find((x) => (x.url || '').includes('pageB'));
  check('A 线程独立存在且只有 1 轮问答', !!aThread && aThread.msgs === 2, JSON.stringify(aThread));
  check('B 线程独立存在', !!bThread && bThread.msgs === 2, JSON.stringify(bThread));

  // ---- 症状2：切回 A —— 完整问答重新可见 ----
  await pageA.bringToFront();
  await sleep(900);
  const viewBackA = await panel.evaluate(() => {
    const ai = document.querySelector('.msg.assistant.done .body');
    const user = document.querySelector('.msg.user .body');
    return {
      aiText: ai ? ai.textContent : '',
      userText: user ? user.textContent : '',
    };
  });
  check('切回 A：完整问答可见（问题）', viewBackA.userText.includes('总结这个页面'), JSON.stringify(viewBackA.userText.slice(0, 40)));
  check('切回 A：完整问答可见（回答）', viewBackA.aiText.includes('tok0'), JSON.stringify(viewBackA.aiText.slice(0, 40)));

  await panel.screenshot({ path: '/tmp/wne-tab-panel.png' });
  console.log('screenshot: /tmp/wne-tab-panel.png');

  await ctx.close();
  server.close();
  console.log(`\n== ${pass}/${pass + fail} passed ==`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR:', e); process.exit(1); });
