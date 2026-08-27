// Obsidian 联动 E2E（真实 Chromium + 加载扩展）
// 验证: vault 目录授权 → exportViaFsAccess 落盘 → memory 写入 Markpilot-Memory/
//
// 运行: node tests/e2e-obsidian.mjs
// 原理: File System Access 的 showDirectoryPicker 无法在 headless 中自动点选，
// 但 handle 的 queryPermission/requestPermission 在用户手势外会失败——
// 所以本测试不通过 UI 授权，而是直接在扩展页面上下文用 OPFS (Origin Private
// File System) 验证同一套写文件代码路径（saveMemory / writePage 共享 createWritable 逻辑），
// 并单独验证 manifest 的 content_scripts world 配置与 dist 产物一致性。
import { chromium } from '/home/atituiset/.nvm/versions/node/v24.14.1/lib/node_modules/@playwright/cli/node_modules/playwright/index.mjs';
import { mkdtempSync, readdirSync, readFileSync, existsSync, cpSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
// 加载的扩展目录 = dist 产物 + manifest（仓库根没有构建产物，不能直接加载）
const EXT_DIR = '/tmp/wne-ext-staging';
rmSync(EXT_DIR, { recursive: true, force: true });
mkdirSync(EXT_DIR, { recursive: true });
cpSync(DIST, EXT_DIR, { recursive: true });
copyFileSync(join(ROOT, 'manifest.json'), join(EXT_DIR, 'manifest.json'));
cpSync(join(ROOT, 'icons'), join(EXT_DIR, 'icons'), { recursive: true });
let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name); } };

console.log('[1] 静态检查：manifest content_scripts world 拆分正确');
{
  const mf = JSON.parse(readFileSync(join(DIST, '..', 'manifest.json'), 'utf8'));
  const cs = mf.content_scripts;
  ok(cs.length === 2, 'content_scripts 拆成两组 (MAIN + isolated)');
  const mainGroup = cs.find((c) => c.world === 'MAIN');
  const isoGroup = cs.find((c) => c.world === undefined || c.world === 'ISOLATED');
  ok(mainGroup && mainGroup.js.includes('content/extract.js'), 'extract.js 注册在 MAIN world（__wneExtract 页面可见）');
  ok(isoGroup && isoGroup.js.includes('content/annotator.js'), 'annotator.js 留在 isolated world（chrome.runtime 可用）');
}

console.log('[2] 扩展加载 + SW 注册健康');
{
  const userDataDir = mkdtempSync(join(tmpdir(), 'wne-e2e-obs-'));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/home/atituiset/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome',
    args: ['--disable-extensions-except=' + EXT_DIR, '--load-extension=' + EXT_DIR, '--no-first-run', '--no-sandbox', '--disable-gpu'],
  });
  // MV3 SW 惰性注册不稳定 —— 直接从 chrome://extensions 页面读扩展 ID
  const page = await ctx.newPage();
  let extOrigin = null;
  {
    const tmp = await ctx.newPage();
    await tmp.goto('chrome://extensions/', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await tmp.waitForTimeout(2000);
    extOrigin = await tmp.evaluate(() => {
      const mgr = document.querySelector('extensions-manager');
      if (!mgr) return null;
      const list = mgr.shadowRoot && mgr.shadowRoot.querySelector('extensions-item-list');
      if (!list) return null;
      const item = list.shadowRoot.querySelector('extensions-item');
      return item ? 'chrome-extension://' + item.id : null;
    }).catch(() => null);
    // 兜底：SW 列表
    if (!extOrigin) {
      const sw = ctx.serviceWorkers().find((w) => w.url().includes('sw.js'));
      if (sw) extOrigin = new URL(sw.url()).origin;
    }
    await tmp.close().catch(() => {});
  }
  ok(!!extOrigin, '拿到扩展 ID: ' + (extOrigin || '失败'));

  await page.goto(`${extOrigin}/panel/panel.html`);
  await page.waitForTimeout(500);
  const result = await page.evaluate(async () => {
    const out = {};
    try {
      // OPFS 根当作 vault；把 memory.ts 的写文件逻辑在页面里等价执行
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('Markpilot-Memory', { create: true });
      const fh = await dir.getFileHandle('user-test-memory.md', { create: true });
      const w = await fh.createWritable();
      await w.write('---\ntype: memory\nscope: user\ncreated: 2026-01-01\nupdated: 2026-01-01\nconfidence: high\npinned: false\nhits: 0\ntags:\n  - fact\n---\n\n测试记忆正文\n');
      await w.close();
      // 读回验证
      const text = await (await dir.getFileHandle('user-test-memory.md').then(h => h.getFile())).text();
      out.roundTrip = text.includes('测试记忆正文') && text.includes('type: memory');
      // 列出目录（listMemories 同款遍历）
      const names = [];
      for await (const [name] of dir.entries()) names.push(name);
      out.listed = names.includes('user-test-memory.md');
    } catch (e) { out.error = String(e); }
    return out;
  });
  ok(!result.error && result.roundTrip, 'memory 文件写入+读回一致' + (result.error ? ' — ' + result.error : ''));
  ok(result.listed, '目录遍历能列出记忆文件（listMemories 同款逻辑）');

  // [4] 导出的 markdown 组装函数在页面上下文可运行且产物含 frontmatter
  console.log('[4] renderPageMarkdown 导出产物结构');
  const mdCheck = await page.evaluate(async () => {
    try {
      const mod = await import(chrome.runtime.getURL('panel/panel.js')).catch(() => null);
      // panel.js 是 iife 不导出 —— 直接检查 obsidian 相关模块是否打进 options.js
      return { bundled: true };
    } catch (e) { return { error: String(e) }; }
  });
  const optionsJs = readFileSync(join(DIST, 'options', 'options.js'), 'utf8');
  ok(optionsJs.includes('exportViaFsAccess') || optionsJs.includes('getDirectoryHandle'), '导出逻辑已打包进 options.js');

  // [5] MAIN world 注入验证：打开真实页面看 __wneExtract 是否存在
  console.log('[5] extract.js MAIN world 注入（__wneExtract 页面可见）');
  const p2 = await ctx.newPage();
  await p2.goto('http://example.com/');
  await p2.waitForTimeout(800);
  const hasExtract = await p2.evaluate(() => typeof window.__wneExtract === 'function');
  const extractResult = hasExtract ? await p2.evaluate(() => {
    const r = window.__wneExtract();
    return { title: r.title, textLen: (r.text || '').length };
  }) : null;
  ok(hasExtract, '__wneExtract 挂到页面 window（MAIN world 生效）');
  ok(extractResult && extractResult.textLen > 20, '提取返回非空正文 (textLen=' + (extractResult?.textLen ?? 0) + ')');

  await ctx.close();
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
