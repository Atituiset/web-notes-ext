// 调试：真实页面 https://atituiset.github.io/book-llvm/ 上划词无反应问题
// 运行：node tests/debug-live-page.cjs（需先 npm run build；headed）
const fs = require('fs');
const path = require('path');
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

(async () => {
process.env.LANG = process.env.LC_ALL = 'zh_CN.UTF-8'; // 扩展 i18n 解析跟随进程 locale
  const ctx = await chromium.launchPersistentContext('/tmp/wne-debug-live-' + Date.now(), {
    headless: false,
    locale: 'zh-CN',
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, '--no-first-run', '--lang=zh-CN'],
  });
  const page = await ctx.newPage();
  page.on('console', (m) => console.log('CONSOLE[' + m.type() + ']:', m.text().slice(0, 150)));
  page.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 200)));

  await page.goto('https://atituiset.github.io/book-llvm/clangd/14-protocol.html', { waitUntil: 'load', timeout: 30000 });

  // 检查注入
  const injected = !!(await page.$('#wne-root'));
  console.log('content script injected:', injected);
  if (!injected) { console.log('=> 未注入。可能原因: 扩展加载时机 / matches 配置'); }

  // 检查容器判定
  const containerInfo = await page.evaluate(() => {
    const c = document.getElementById('content') || document.querySelector('article, main') || document.body;
    return { tag: c.tagName || c.nodeName, id: c.id };
  });
  console.log('container:', JSON.stringify(containerInfo));

  // 真实鼠标拖选一段文字（模拟用户操作）
  const box = await page.evaluate(() => {
    const c = document.getElementById('content') || document.querySelector('article, main') || document.body;
    const el = [...c.querySelectorAll('p, li, h2, h3')].find((e) => e.textContent.trim().length > 30) || c.firstElementChild;
    if (!el) return null;
    // 滚动到元素处再取视口坐标（mouse API 用的是视口坐标）
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  if (box) {
      await page.mouse.move(box.x + 5, box.y + 5);
      await page.mouse.down();
      for (let i = 1; i <= 15; i++) {
        await page.mouse.move(
          box.x + 5 + Math.min(400, box.width - 10) * i / 15,
          box.y + 8
        );
      }
      await page.mouse.up();
      await page.waitForTimeout(400);

      const state = await page.evaluate(() => {
        const bar = document.getElementById('wne-selbar');
        const sel = window.getSelection();
        return {
          selText: sel ? sel.toString().slice(0, 50) : '(none)',
          collapsed: sel ? sel.isCollapsed : null,
          selbarDisplay: bar ? bar.style.display : '(no bar)',
          anchorInContainer: (() => {
            const c = document.getElementById('content') || document.querySelector('article, main') || document.body;
            return c.contains(sel.anchorNode);
          })(),
        };
      }).catch((e) => ({ evalErr: String(e).slice(0, 120) }));
      console.log('after drag:', JSON.stringify(state));
  }
  await page.screenshot({ path: '/tmp/wne-live-debug.png' });
  console.log('screenshot: /tmp/wne-live-debug.png');
  await ctx.close();
  process.exit(0);
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
