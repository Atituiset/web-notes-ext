// E2E：端侧 embedding 产品接线 — 扩展页内 transformers.js + IDB 向量缓存 + 混合召回
//   词法零重叠的改述查询必须被 dense 召回（词法单路时做不到）
// 运行：node tests/e2e-embedding.mjs（需先 npm run build；headed；模型首跑从 HF 下载）
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { chromium } from '/home/atituiset/.nvm/versions/node/v24.14.1/lib/node_modules/@playwright/cli/node_modules/playwright/index.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXT_DIR = '/tmp/wne-ext-staging';
fs.rmSync(EXT_DIR, { recursive: true, force: true });
fs.mkdirSync(EXT_DIR, { recursive: true });
fs.cpSync(path.join(ROOT, 'dist'), EXT_DIR, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'manifest.json'), path.join(EXT_DIR, 'manifest.json'));
fs.cpSync(path.join(ROOT, 'icons'), path.join(EXT_DIR, 'icons'), { recursive: true });
fs.cpSync(path.join(ROOT, '_locales'), path.join(EXT_DIR, '_locales'), { recursive: true });
fs.mkdirSync(path.join(EXT_DIR, 'eval'), { recursive: true });
// memory+embedding 必须打进同一 bundle——分开打会让 setDenseRanker 写进
// 各自拷贝的模块状态（searchMemories 读到的是另一份的 null）
const entry = path.join(ROOT, 'tests/eval/mem-embed.entry.ts');
fs.writeFileSync(entry,
  "export * from '../../src/lib/memory.js';\nexport * from '../../src/lib/embedding.js';\n");
execSync(`npx esbuild ${entry} --bundle --format=esm --outfile=${path.join(EXT_DIR, 'eval', 'mem-embed.mjs')}`, { stdio: 'inherit' });

let pass = 0, fail = 0;
const check = (n, c, extra) => {
  console.log((c ? 'PASS' : 'FAIL') + ' | ' + n + (extra ? ' | ' + String(extra).slice(0, 140) : ''));
  c ? pass++ : fail++;
};

const TARGET = '艾宾浩斯遗忘曲线描述记忆保留率随时间指数衰减，间隔重复是对抗遗忘的有效手段。';
const PARAPHRASE = '学过的东西很快就忘，该怎么办？'; // 与目标零词面重叠（词法不可召回）
const NOISE = [
  '用户偏好简洁的中文回答，不喜欢长篇大论。',
  '代码注释希望保留英文原文。',
  'Chrome MV3 的 service worker 会在 30 秒空闲后休眠。',
];

(async () => {
  // 固定 profile：浏览器 Cache Storage 留住 HF 模型文件，复跑不再下载
  const ctx = await chromium.launchPersistentContext('/tmp/wne-embed-profile', {
    headless: false,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, '--no-first-run'],
  });
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 10000 });
  const extOrigin = 'chrome-extension://' + new URL(sw.url()).host;
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE-ERR:', m.text().slice(0, 160)); });
  await page.goto(extOrigin + '/panel/panel.html');

  const r = await page.evaluate(async ({ TARGET, PARAPHRASE, NOISE }) => {
    const out = { logs: [] };
    try {
      await new Promise((res, rej) => {
        const req = indexedDB.open('web-notes-ext', 3);
        req.onupgradeneeded = () => {
          const db = req.result;
          for (const n of ['pages', 'handles', 'settings', 'embeddings']) if (!db.objectStoreNames.contains(n)) db.createObjectStore(n, { keyPath: n === 'pages' ? 'url' : n === 'handles' ? 'name' : 'key' });
          if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' }).createIndex('url', 'url');
          if (!db.objectStoreNames.contains('threads')) db.createObjectStore('threads', { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt');
        };
        req.onsuccess = res; req.onerror = rej;
      });
      const root = await navigator.storage.getDirectory();
      await new Promise((res, rej) => {
        const req = indexedDB.open('web-notes-ext', 3);
        req.onsuccess = () => { const t = req.result.transaction('handles', 'readwrite'); t.objectStore('handles').put({ name: 'vault', handle: root }); t.oncomplete = res; t.onerror = rej; };
        req.onerror = rej;
      });
      const mem = await import(chrome.runtime.getURL('eval/mem-embed.mjs'));
      let targetFile = '';
      for (const body of [TARGET, ...NOISE]) {
        const f = await mem.saveMemory({ scope: 'user', body, tags: ['fact'], confidence: 'high' });
        if (body === TARGET) targetFile = f;
      }
      out.targetFile = targetFile;

      const emb = mem; // 同一 bundle，共享模块状态
      out.logs.push('initEmbedding…');
      out.channel = await emb.initEmbedding({ semanticRecall: 'local', memoryInject: true });
      out.logs.push('channel=' + out.channel);

      const { memories: hits } = await mem.searchMemories(PARAPHRASE, { k: 3 });
      out.hits = hits.map((h) => h.file);
      // 词面验证：PARAPHRASE 与 TARGET 零重叠（对照组——证明召回来自 dense）
      out.lexicalOverlap = mem.tokenize(PARAPHRASE).filter((t) => mem.tokenize(TARGET).includes(t));
      // 向量缓存验证
      const cnt = await new Promise((res) => {
        const req = indexedDB.open('web-notes-ext', 3);
        req.onsuccess = () => { const q = req.result.transaction('embeddings', 'readonly').objectStore('embeddings').count(); q.onsuccess = () => res(q.result); };
      });
      out.embedCount = cnt;
    } catch (e) { out.err = String(e && e.message || e) + ' | ' + String(e && e.stack || '').split('\n')[1]; }
    return out;
  }, { TARGET, PARAPHRASE, NOISE });

  if (r.err) console.log('ERR-DETAIL:', r.err);
  check('initEmbedding 返回 local 通道', r.channel === 'local', r.channel || r.err);
  check('改述查询 dense 召回到目标记忆', !!(r.hits && r.hits.includes(r.targetFile)), `expect ${r.targetFile} in ${JSON.stringify(r.hits)}`);
  check('对照：改述与目标词面零重叠（召回确来自 dense）', !!(r.lexicalOverlap && r.lexicalOverlap.length === 0), JSON.stringify(r.lexicalOverlap));
  check('向量已写入 IndexedDB 缓存', r.embedCount >= 4, 'embeddings=' + r.embedCount);

  await ctx.close();
  console.log(`\n== ${pass}/${pass + fail} passed ==`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR:', e); process.exit(1); });
