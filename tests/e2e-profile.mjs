// E2E：用户画像生成与注入（opencode 免费模型 + OPFS 当 vault）
//   种子一组连贯记忆 → generateProfile → 断言画像文件/检索过滤/提问注入
// 运行：node tests/e2e-profile.mjs（需先 npm run build；headed）
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
// profile.ts + memory.ts 各打一个 ESM 入口
for (const [src, out] of [['src/lib/memory.ts', 'memory.mjs'], ['src/lib/profile.ts', 'profile.mjs'], ['src/lib/chat-pipeline.ts', 'chat-pipeline.mjs']]) {
  execSync(`npx esbuild ${path.join(ROOT, src)} --bundle --format=esm --outfile=${path.join(EXT_DIR, 'eval', out)}`, { stdio: 'inherit' });
}

let pass = 0, fail = 0;
const check = (n, c, extra) => {
  console.log((c ? 'PASS' : 'FAIL') + ' | ' + n + (extra ? ' | ' + String(extra).slice(0, 120) : ''));
  c ? pass++ : fail++;
};

const SEED = [
  { body: '用户偏好简洁的中文回答，不喜欢长篇大论的客套话。', tags: ['preference'] },
  { body: '代码注释希望保留英文原文，不要翻译成中文。', tags: ['preference', 'code'] },
  { body: '用户是浏览器扩展开发者，熟悉 Chrome MV3 的 service worker 与 content script 架构。', tags: ['fact', 'chrome'] },
  { body: '使用 Obsidian 管理笔记，导出格式要兼容 Dataview 查询。', tags: ['preference', 'obsidian'] },
  { body: '正在研究记忆检索算法，关注词面检索与向量召回的混合方案。', tags: ['fact', 'memory'] },
  { body: '偏好本地优先的开源方案，不喜欢被推荐云端付费服务。', tags: ['preference'] },
  { body: '最近在做 embedding 模型选型评测，用 recall/precision 指标驱动决策。', tags: ['fact', 'memory'] },
  { body: '习惯用 Ollama 跑本地模型，避免数据离开本机。', tags: ['fact', 'ollama'] },
];

(async () => {
  const ctx = await chromium.launchPersistentContext('/tmp/wne-profile-' + Date.now(), {
    headless: false,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, '--no-first-run'],
  });
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 10000 });
  const extOrigin = 'chrome-extension://' + new URL(sw.url()).host;
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 200)));
  await page.goto(extOrigin + '/panel/panel.html');

  const r = await page.evaluate(async (SEED) => {
    const out = {};
    // IDB + OPFS vault
    await new Promise((res, rej) => {
      const req = indexedDB.open('web-notes-ext', 3);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const n of ['pages', 'handles', 'settings']) if (!db.objectStoreNames.contains(n)) db.createObjectStore(n, { keyPath: n === 'pages' ? 'url' : n === 'handles' ? 'name' : 'key' });
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
    const mem = await import(chrome.runtime.getURL('eval/memory.mjs'));
    for (const m of SEED) await mem.saveMemory({ scope: 'user', body: m.body, tags: m.tags, confidence: 'high' });

    const prof = await import(chrome.runtime.getURL('eval/profile.mjs'));
    const settings = { provider: 'opencode', model: 'hy3-free', apiKeys: {}, baseUrl: '', memoryInject: true };
    try {
      const gen = await prof.generateProfile(settings);
      out.gen = gen;
      const dir = await root.getDirectoryHandle('Markpilot-Memory');
      const fh = await dir.getFileHandle(gen.file);
      out.fileText = await (await fh.getFile()).text();
      out.profile = await prof.getProfile();
      out.memCount = (await mem.listMemories()).length;
      // 注入验证
      const cp = await import(chrome.runtime.getURL('eval/chat-pipeline.mjs'));
      const { messages } = await cp.buildLlmMessages({
        settings, question: '我该用什么语言写注释？', pageText: null, notes: [], selection: null, history: [],
      });
      out.injected = messages.some((m) => m.content.includes('【用户画像】'));
      out.profileInMessages = messages.find((m) => m.content.includes('【用户画像】'))?.content.slice(0, 300) || '';
    } catch (e) { out.err = String(e.message || e); }
    return out;
  }, SEED);

  check('画像生成成功', !r.err && r.gen && r.gen.file === '_profile.md', r.err || JSON.stringify(r.gen));
  check('frontmatter type=profile 且记忆数正确', !!(r.fileText && r.fileText.includes('type: profile') && r.fileText.includes('memoryCount: 8')));
  check('画像含角色/偏好小节', !!(r.profile && /角色|偏好/.test(r.profile)), (r.profile || '').slice(0, 150));
  check('画像不被检索为记忆（type 过滤）', r.memCount === 8, 'listMemories=' + r.memCount);
  check('提问时画像注入【用户画像】', !!r.injected, r.profileInMessages.slice(0, 100));

  await ctx.close();
  console.log(`\n== ${pass}/${pass + fail} passed ==`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR:', e); process.exit(1); });
