// 生成 CWS 商店截图（docs/store/*.png，1280×800）
//   摆拍环境：精排中文文章页 + mock LLM（真实中文 markdown 回答）
//   01 划词工具条 / 02 笔记弹窗 / 03 侧栏问答（网页+侧栏合成）/ 04 设置页
// 运行：node scripts/make-screenshots.cjs（需先 npm run build）
// 英文版：SHOT_LOCALE=en node scripts/make-screenshots.cjs → docs/store-en/
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('/home/atituiset/.nvm/versions/node/v24.14.1/lib/node_modules/@playwright/cli/node_modules/playwright');

const LOCALE = process.env.SHOT_LOCALE === 'en' ? 'en' : 'zh';
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', LOCALE === 'en' ? 'store-en' : 'store');
fs.mkdirSync(OUT, { recursive: true });
const EXT_DIR = '/tmp/wne-ext-staging';
fs.rmSync(EXT_DIR, { recursive: true, force: true });
fs.mkdirSync(EXT_DIR, { recursive: true });
fs.cpSync(path.join(ROOT, 'dist'), EXT_DIR, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'manifest.json'), path.join(EXT_DIR, 'manifest.json'));
fs.cpSync(path.join(ROOT, 'icons'), path.join(EXT_DIR, 'icons'), { recursive: true });
fs.cpSync(path.join(ROOT, '_locales'), path.join(EXT_DIR, '_locales'), { recursive: true });
const PORT = 8897;

const ARTICLE_EN = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Active Reading: Why You Forget What You Read - Reading Methods</title>
<style>
  body { max-width: 720px; margin: 48px auto; padding: 0 24px; color: #1f2937;
         font: 17px/1.9 Georgia, "Times New Roman", serif; background: #fdfdfc; }
  h1 { font-size: 30px; line-height: 1.4; margin-bottom: 8px; }
  .meta { color: #9ca3af; font-size: 13px; margin-bottom: 32px; }
  h2 { font-size: 21px; margin-top: 36px; }
  p { margin: 16px 0; }
  blockquote { border-left: 3px solid #2563eb; margin: 20px 0; padding: 4px 16px; color: #475569; background: #f8fafc; }
</style></head><body><article id="content">
<h1>Active Reading: Why You Forget What You Read</h1>
<div class="meta">Reading Methods · August 2026 · 8 min read</div>
<p>Most people read by scanning line after line with their eyes, then expecting knowledge to stick on its own. Cognitive science keeps showing how poor the retention of this passive intake is: twenty-four hours later, you can usually recall less than a fifth. The problem is not memory — it is that the brain barely processes anything while reading passively.</p>
<p>The core of active reading is creating an act of retrieval while you take things in. Highlighting a sentence is an act of retrieval practice: judging that a line is worth keeping forces the brain to hook new information onto what you already know, which beats re-reading ten times over.</p>
<h2>Notes are external memory, and scaffolding for thought</h2>
<p>Good notes are not excerpts. Copying is just transport; writing in your own words what a passage means is what actually encodes it. The Feynman technique says the same thing: if you cannot explain it to someone else, you have not really understood it.</p>
<blockquote>Reading efficiency = retention × depth of understanding. A highlighter finds the key points for you; it cannot understand them for you.</blockquote>
<p>This is where AI reading assistants earn their keep: they cut the friction of getting stuck on a passage to nearly zero. Select the text you cannot parse, get an explanation grounded in the page you are reading, and keep going — flow unbroken, understanding deepened.</p>
<h2>Let tools fade into the background</h2>
<p>The best reading tool is the one you never notice. It does not judge for you; it simply puts your judgment somewhere it cannot be lost — a local notes library, not some cloud service that might shut down any day.</p>
</article></body></html>`;

const ANSWER_MD_EN = [
  '## Key takeaways',
  '',
  '1. **Passive reading retains almost nothing** — less than a fifth after 24 hours, because the brain never engages',
  '2. **Highlighting is retrieval practice** — judging "worth keeping" hooks new ideas onto existing knowledge',
  '3. **Take notes in your own words** — copying is transport; paraphrasing is encoding (Feynman technique)',
  '',
  '> Reading efficiency = retention × depth of understanding',
  '',
  'An AI assistant helps by removing the friction of getting stuck, so your reading flow never breaks.',
].join('\n');

const ARTICLE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>主动阅读：为什么你读完就忘 - 阅读方法论</title>
<style>
  body { max-width: 720px; margin: 48px auto; padding: 0 24px; color: #1f2937;
         font: 17px/1.9 "Noto Sans CJK SC", "PingFang SC", sans-serif; background: #fdfdfc; }
  h1 { font-size: 30px; line-height: 1.4; margin-bottom: 8px; }
  .meta { color: #9ca3af; font-size: 13px; margin-bottom: 32px; }
  h2 { font-size: 21px; margin-top: 36px; }
  p { margin: 16px 0; }
  blockquote { border-left: 3px solid #2563eb; margin: 20px 0; padding: 4px 16px; color: #475569; background: #f8fafc; }
</style></head><body><article id="content">
<h1>主动阅读：为什么你读完就忘</h1>
<div class="meta">阅读方法论 · 2026 年 8 月 · 8 分钟阅读</div>
<p>大多数人读书的方式，是用眼睛逐行扫描文字，然后期待知识自动留下来。认知科学的研究一再表明，这种被动输入的留存率低得惊人：24 小时后，你能回忆起的通常不到两成。问题不在记忆力，而在阅读时大脑几乎没有参与加工。</p>
<p>主动阅读的核心，是在输入的同时制造「提取动作」。划下一句话，本质是一次判断：这句话值得被记住。判断的过程强迫大脑把新信息和已有认知挂上钩，这比重复阅读十遍都有效。</p>
<h2>笔记是外部记忆，更是思考的脚手架</h2>
<p>好笔记不是摘抄。摘抄只是搬运，而用自己的话写下「这段话意味着什么」，才完成了真正的编码。费曼技巧说的也是同一件事：如果你不能把它讲给别人听，你就没有真正理解它。</p>
<blockquote>阅读的效率 = 留存率 × 理解深度。荧光笔只能帮你找到重点，不能帮你理解重点。</blockquote>
<p>这也是 AI 阅读助手真正的价值所在：它把「读不懂就卡住」的摩擦降到最低。选中一段读不懂的文字，立刻得到一个基于当前页面的解释，然后接着读下去——心流不被打断，理解却能加深。</p>
<h2>让工具回到后台</h2>
<p>最好的阅读工具是你感觉不到它存在的工具。它不替你做判断，只在你做出判断之后，帮你把结果安放到不会丢失的地方——本地的笔记库，而不是某个随时会关停的云端服务。</p>
</article></body></html>`;

const ANSWER_MD = [
  '## 核心观点',
  '',
  '1. **被动通读留存率极低**——24 小时后能回忆的通常不到两成，因为大脑没有参与加工',
  '2. **划线是一次提取动作**——判断"值得记住"的过程让新信息与已有认知挂钩',
  '3. **笔记要用自己的话写**——摘抄是搬运，复述才是编码（费曼技巧）',
  '',
  '> 阅读的效率 = 留存率 × 理解深度',
  '',
  'AI 助手的价值在于把"读不懂就卡住"的摩擦降到最低，让心流不被打断。',
].join('\n');

function startServer() {
  const article = LOCALE === 'en' ? ARTICLE_EN : ARTICLE;
  const answerMd = LOCALE === 'en' ? ANSWER_MD_EN : ANSWER_MD;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/v1/chat/completions')) {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const chunks = answerMd.match(/.{1,12}/gs) || [];
        let i = 0;
        const timer = setInterval(() => {
          if (i < chunks.length) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i++] } }] })}\n\n`);
          } else {
            res.write('data: [DONE]\n\n');
            clearInterval(timer);
            res.end();
          }
        }, 8);
      });
      return;
    }
    if (req.url.startsWith('/article')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(article);
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

(async () => {
  const server = await startServer();
process.env.LANG = process.env.LC_ALL = LOCALE === 'en' ? 'en_US.UTF-8' : 'zh_CN.UTF-8'; // 扩展 i18n 解析跟随进程 locale
  const ctx = await chromium.launchPersistentContext('/tmp/wne-shots-' + Date.now(), {
    headless: false,
    locale: LOCALE === 'en' ? 'en-US' : 'zh-CN',
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, '--no-first-run', `--lang=${LOCALE === 'en' ? 'en-US' : 'zh-CN'}`, '--font-render-hinting=none'],
  });
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 10000 });
  const extOrigin = 'chrome-extension://' + new URL(sw.url()).host;

  // 预置 mock provider 设置（在扩展源页面里写 IDB；schema 与 src/lib/db.js v3 保持一致）
  const seed = await ctx.newPage();
  await seed.goto(extOrigin + '/options/options.html');
  await seed.evaluate(async (port) => {
    const req = indexedDB.open('web-notes-ext', 3);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('pages')) db.createObjectStore('pages', { keyPath: 'url' });
      if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' }).createIndex('url', 'url');
      if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles', { keyPath: 'name' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('embeddings')) db.createObjectStore('embeddings', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('threads')) db.createObjectStore('threads', { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt');
    };
    await new Promise((res2, rej) => { req.onsuccess = res2; req.onerror = rej; });
    await new Promise((res2, rej) => {
      const t = req.result.transaction('settings', 'readwrite');
      t.objectStore('settings').put({ key: 'app', value: { provider: 'openai-compatible', baseUrl: `http://localhost:${port}/v1`, model: 'kimi-k2', apiKeys: {}, memoryInject: false, autoMemory: false } });
      t.oncomplete = res2; t.onerror = rej;
    });
  }, PORT);
  await seed.close();

  // ---- 文章页 ----
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/article`, { waitUntil: 'load' });
  await page.waitForSelector('#wne-root', { state: 'attached' });
  await page.waitForTimeout(600);

  // 程序化选中一句话（比鼠标拖拽稳定），触发工具条
  const SEL = LOCALE === 'en'
    ? { para: 'act of retrieval', phrase: 'Highlighting a sentence is an act of retrieval', len: 52 }
    : { para: '提取动作', phrase: '划下一句话', len: 40 };
  await page.evaluate((sel2) => {
    const ps = document.querySelectorAll('#content p');
    const target = [...ps].find((p) => p.textContent.includes(sel2.para));
    const text = target.firstChild;
    const start = text.textContent.indexOf(sel2.phrase);
    const sel = window.getSelection();
    const r = document.createRange();
    r.setStart(text, start);
    r.setEnd(text, start + sel2.len);
    sel.removeAllRanges();
    sel.addRange(r);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }, SEL);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, '01-selection-toolbar.png') });
  console.log('01-selection-toolbar.png');

  // 02 笔记弹窗
  await page.click('#wne-selbar button');
  await page.waitForSelector('#wne-pop.open');
  await page.fill('#wne-pop-input', LOCALE === 'en'
    ? 'Highlighting = retrieval practice. Perfect source material for Anki cards.'
    : '划线 = 提取动作，这正是 Anki 卡片最好的来源。');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, '02-note-popover.png') });
  console.log('02-note-popover.png');
  await page.click('#wne-pop .wp-save');
  await page.waitForTimeout(800);

  // ---- 05 笔记分组列表（本页 + 本站 分级展示）----
  // 造一条本站笔记，让面板出现两个分组
  const seed2 = await ctx.newPage();
  await seed2.goto(extOrigin + '/options/options.html');
  await seed2.evaluate(([port, locale]) => chrome.runtime.sendMessage({
    type: 'notes:put',
    note: {
      id: 'demo-site-1', ts: Date.now(), updatedAt: Date.now(), scope: 'site',
      url: 'localhost', originUrl: `http://localhost:${port}/article`,
      sel: null, kind: 'manual',
      content: locale === 'en'
        ? 'Site-wide: after finishing any article here, immediately recall three key points; re-read the highlights for anything you miss.'
        : '本栏目通用：读完立刻回想三个要点，想不起来就重读划线部分。',
    },
    page: {
      title: locale === 'en' ? 'Active Reading: Why You Forget What You Read' : '主动阅读：为什么你读完就忘',
      host: `localhost:${port}`,
    },
  }), [PORT, LOCALE]);
  await seed2.close();
  const panelLs = await ctx.newPage();
  await panelLs.setViewportSize({ width: 360, height: 800 });
  await panelLs.goto(extOrigin + '/panel/panel.html');
  await page.bringToFront(); // activeTab 指向文章页，面板按它检索笔记
  await panelLs.reload();
  await panelLs.waitForTimeout(700);
  const panelLsShot = await panelLs.screenshot();
  await panelLs.close();

  // 与文章页合成 1280×800（CWS 不收 360 宽的纯面板截图）
  await page.setViewportSize({ width: 920, height: 800 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  const pageShotLs = await page.screenshot();
  await page.setViewportSize({ width: 1280, height: 800 });
  const compLs = await ctx.newPage();
  await compLs.setViewportSize({ width: 1280, height: 800 });
  const b64ls = (b) => 'data:image/png;base64,' + b.toString('base64');
  await compLs.setContent(`<body style="margin:0;display:flex;background:#fff">
    <img src="${b64ls(pageShotLs)}" style="width:920px;height:800px;object-fit:cover;object-position:top">
    <div style="width:1px;background:#e5e7eb"></div>
    <img src="${b64ls(panelLsShot)}" style="width:359px;height:800px;object-fit:cover;object-position:top">
  </body>`);
  await compLs.waitForTimeout(400);
  await compLs.screenshot({ path: path.join(OUT, '05-notes-levels.png') });
  console.log('05-notes-levels.png');
  await compLs.close();

  // 03 侧栏问答（panel 360×800 + 文章页 920×800 合成 1280×800）
  const panel = await ctx.newPage();
  // 摆拍环境无法真正授予可选 host 权限（需要真实用户手势），
  // 打桩 chrome.permissions 绕过 ensureHostPermission 守卫（仅截图用）
  await panel.addInitScript(() => {
    if (chrome.permissions) {
      chrome.permissions.contains = async () => true;
      chrome.permissions.request = async () => true;
    }
  });
  await panel.setViewportSize({ width: 360, height: 800 });
  await panel.goto(extOrigin + '/panel/panel.html');
  await panel.click('nav.tabs button[data-tab="chat"]');
  await panel.fill('#chat-q', LOCALE === 'en' ? 'Summarize the key points of this article' : '总结这篇文章的核心观点');
  await page.bringToFront(); // activeTab 指向文章页（发问预检需要可提取的页面）
  await panel.click('#btn-send');
  await panel.waitForSelector('.msg.assistant.done', { timeout: 20000 });
  await panel.waitForTimeout(600);
  const panelShot = await panel.screenshot();

  await page.setViewportSize({ width: 920, height: 800 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  const pageShot = await page.screenshot();

  const comp = await ctx.newPage();
  await comp.setViewportSize({ width: 1280, height: 800 });
  const b64 = (b) => 'data:image/png;base64,' + b.toString('base64');
  await comp.setContent(`<body style="margin:0;display:flex;background:#fff">
    <img src="${b64(pageShot)}" style="width:920px;height:800px;object-fit:cover;object-position:top">
    <div style="width:1px;background:#e5e7eb"></div>
    <img src="${b64(panelShot)}" style="width:359px;height:800px;object-fit:cover;object-position:top">
  </body>`);
  await comp.waitForTimeout(400);
  await comp.screenshot({ path: path.join(OUT, '03-panel-chat.png') });
  console.log('03-panel-chat.png');
  await comp.close();
  await panel.close();

  // 04 设置页（摆成真实服务商形态，不暴露 mock 地址）
  const opt = await ctx.newPage();
  await opt.setViewportSize({ width: 1280, height: 800 });
  await opt.goto(extOrigin + '/options/options.html');
  await opt.selectOption('#provider', 'moonshot');
  await opt.fill('#baseUrl', '');
  await opt.fill('#model', 'kimi-k2');
  await opt.fill('#apiKey', 'sk-store-demo-key-not-real');
  await opt.waitForTimeout(600);
  await opt.screenshot({ path: path.join(OUT, '04-options.png') });
  console.log('04-options.png');

  await ctx.close();
  server.close();
  console.log('done →', OUT);
})().catch((e) => { console.error('ERR:', e); process.exit(1); });
