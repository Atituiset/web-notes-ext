// E2E 冒烟测试：加载扩展 → 本地测试页划词 → 保存笔记 → 刷新重高亮 → mock LLM 流式
const path = require('path');
const http = require('http');
const { chromium } = require('/home/atituiset/.nvm/versions/node/v24.14.1/lib/node_modules/@playwright/cli/node_modules/playwright');

const ROOT = '/home/atituiset/Projects/web-notes-ext';

// ---- 简单静态服务器 + mock OpenAI SSE 端点 ----
function startServer(port) {
  const testPage = `<!DOCTYPE html><html><head><title>Test Page - Demo</title></head>
<body><article id="content">
<h1>第一章 简介</h1>
<p>${'Alpha paragraph about transformers and attention. '.repeat(3)}</p>
<p>Beta paragraph discusses memory systems in browsers at length, with many useful words here.</p>
</article></body></html>`;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/v1/chat/completions')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const words = ['Hello', ' from', ' mocked', ' model', '!', ' 上下文OK'];
        let i = 0;
        const timer = setInterval(() => {
          if (i < words.length) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: words[i++] } }] })}\n\n`);
          } else {
            res.write('data: [DONE]\n\n');
            clearInterval(timer);
            res.end();
          }
        }, 20);
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
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

(async () => {
  await startServer(8899);
  const userDataDir = '/tmp/wne-profile-' + Date.now();
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
      '--no-first-run',
    ],
  });

  const results = [];
  const check = (name, ok, extra) => {
    results.push({ name, ok, extra });
    console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
  };

  // 1. SW 注册成功
  let sw = ctx.serviceWorkers().find((w) => w.url().includes('sw.js'));
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 8000 }).catch(() => null);
  check('service worker registered', !!sw, sw && sw.url());

  // 2. 打开测试页，等待 content script 注入
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) console.log('NAV:', f.url()); });
  await page.goto('http://localhost:8899/');
  await page.waitForSelector('#wne-root', { timeout: 5000 }).catch(() => {});
  check('content script injected (#wne-root)', !!(await page.$('#wne-root')));

  // 3. 划词：选中 "Beta paragraph" 一段
  await page.evaluate(() => {
    const p = document.querySelectorAll('#content p')[1];
    const node = p.firstChild;
    const sel = window.getSelection();
    sel.removeAllRanges();
    const r = document.createRange();
    r.setStart(node, 0);
    r.setEnd(node, Math.min(30, node.length));
    sel.addRange(r);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.waitForTimeout(300);
  const selbarVisible = await page.evaluate(() => {
    const b = document.getElementById('wne-selbar');
    return b && b.style.display !== 'none';
  });
  check('selection toolbar appears', !!selbarVisible);

  // 4. 点记笔记 → 输入 → 保存
  await page.click('#wne-selbar button');
  await page.waitForSelector('#wne-pop.open', { timeout: 3000 }).catch(() => {});
  check('note popover opens', !!(await page.$('#wne-pop.open')));
  await page.fill('#wne-pop-input', '这是一条测试心得');
  await page.click('#wne-pop .wp-save');
  // 等待页面彻底稳定（保存路径可能触发导航/重载）
  for (let i = 0; i < 15; i++) {
    try { await page.evaluate(() => 1); await page.waitForTimeout(300); break; }
    catch { await page.waitForTimeout(500); }
  }
  // SW 收到消息了吗？直接查 IndexedDB（用独立页面，避免主页面导航干扰）
  let noteCount = -99;
  try {
    const idbPage = await ctx.newPage();
    idbPage.on('framenavigated', (f) => { if (f === idbPage.mainFrame()) console.log('IDBPAGE NAV:', f.url()); });
    await idbPage.goto('http://localhost:8899/');
    await idbPage.waitForLoadState('load');
    await idbPage.waitForTimeout(500);
    noteCount = -98;
    for (let i = 0; i < 5; i++) {
      try {
        noteCount = await idbPage.evaluate(() => new Promise((res) => {
          const r = indexedDB.open('web-notes-ext', 1);
          r.onsuccess = () => {
            const db = r.result;
            const t = db.transaction('notes', 'readonly');
            const q = t.objectStore('notes').getAll();
            q.onsuccess = () => res(q.result.length);
            q.onerror = () => res(-1);
          };
          r.onerror = () => res(-2);
        }));
        break;
      } catch (e) { await idbPage.waitForTimeout(500); }
    }
    await idbPage.close();
  } catch (e) {
    console.log('idb check error:', e.message.slice(0, 80));
  }
  check('note persisted to IndexedDB', noteCount === 1, 'count=' + noteCount);

  // 5. 刷新 → 重高亮
  await Promise.all([page.reload(), page.waitForTimeout(100)]).catch(() => {});
  await page.waitForTimeout(1500);
  const marks = await page.$$eval('.wne-mark', (ms) => ms.map((m) => m.textContent));
  check('highlight restored after reload', marks.length >= 1, JSON.stringify(marks).slice(0, 80));

  // 6. 配置 settings（provider openai-compatible 指向 mock）
  const sw2 = sw || (await ctx.waitForEvent('serviceworker', { timeout: 5000 }).catch(() => null));
  const settingsOk = await (sw2 || ctx.workers()[0] || page).evaluate(() => {
    return new Promise((res) => {
      const r = indexedDB.open('web-notes-ext', 1);
      r.onsuccess = () => {
        const db = r.result;
        try {
          const t = db.transaction('settings', 'readwrite');
          t.objectStore('settings').put({
            key: 'app',
            value: {
              provider: 'openai-compatible',
              baseUrl: 'http://localhost:8899/v1',
              model: 'mock-model',
              apiKeys: {},
              vaultDirTemplate: 'Clippings',
              exportAiQA: true,
            },
          });
          t.oncomplete = () => res(true);
          t.onerror = () => res(false);
        } catch { res(false); }
      };
      r.onerror = () => res(false);
    });
  }).catch(() => false);
  check('settings written', settingsOk);

  // 7. panel 聊天：打开 side panel 页面（作为普通标签页验证逻辑）
  const extOrigin = sw ? new URL(sw.url()).origin : ctx.serviceWorkers().map((w) => new URL(w.url()).origin).find((o) => o.startsWith('chrome-extension'));
  const panelPage = await ctx.newPage();
  await panelPage.goto('chrome-extension://' + extOrigin + '/src/panel/panel.html');
  await panelPage.waitForTimeout(800);
  await panelPage.fill('#chat-q', '这段讲了什么?');
  await panelPage.click('#btn-send');
  await panelPage.waitForTimeout(2500);
  const aiText = await panelPage.evaluate(() => {
    const msgs = document.querySelectorAll('.msg.assistant .body');
    return msgs.length ? msgs[msgs.length - 1].textContent : '';
  });
  check('LLM streamed reply', aiText.includes('mocked'), aiText.slice(0, 60));

  // AI-QA 笔记入库
  const counts = await panelPage.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('web-notes-ext', 1);
    r.onsuccess = () => {
      const t = r.result.transaction('notes', 'readonly');
      const q = t.objectStore('notes').getAll();
      q.onsuccess = () => res(q.result.map((n) => n.kind));
      q.onerror = () => res([]);
    };
  })).catch(() => []);
  check('ai-qa note saved', counts.includes('ai-qa'), JSON.stringify(counts));

  if (pageErrors.length) console.log('PAGE ERRORS:', pageErrors.slice(0, 5));
  const fails = results.filter((r) => !r.ok).length;
  console.log(`\n== ${results.length - fails}/${results.length} passed ==`);
  await ctx.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
