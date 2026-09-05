// 生成 Chrome 商店宣传图块（小磁贴 440×280 / 顶部图块 1400×560）
//   node scripts/make-promo-tile.cjs                      → docs/store/promo-tile-440x280.png
//   SHOT_MARQUEE=1 node scripts/make-promo-tile.cjs       → docs/store/promo-marquee-1400x560.png
//   英文版加 SHOT_LOCALE=en，输出到 docs/store-en/
const path = require('path');
const fs = require('fs');
const { chromium } = require('/home/atituiset/.nvm/versions/node/v24.14.1/lib/node_modules/@playwright/cli/node_modules/playwright');

const LOCALE = process.env.SHOT_LOCALE === 'en' ? 'en' : 'zh';
const MARQUEE = process.env.SHOT_MARQUEE === '1';
const ROOT = '/home/atituiset/Projects/web-notes-ext';
const iconB64 = fs.readFileSync(path.join(ROOT, 'icons/icon128.png')).toString('base64');
const shotDir = path.join(ROOT, 'docs', LOCALE === 'en' ? 'store-en' : 'store');
const panelShotB64 = fs.readFileSync(path.join(shotDir, '03-panel-chat.png')).toString('base64');

const COPY = LOCALE === 'en'
  ? {
      tag: 'Highlight & note → Local Markdown → Ask AI',
      feats: ['📝 Highlight & jot', '🤖 Ask AI in context', '🔒 100% local'],
    }
  : {
      tag: '划词笔记 → 本地 Obsidian → AI 就地问答',
      feats: ['📝 划词即记', '🤖 带着页面问 AI', '🔒 数据只在本机'],
    };

const TILE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  * { margin:0; box-sizing:border-box; }
  body { width:440px; height:280px; display:flex; align-items:center; justify-content:center;
         background: linear-gradient(135deg, #1e3a8a 0%, #2563eb 55%, #3b82f6 100%);
         font-family: "PingFang SC", "Noto Sans CJK SC", system-ui, sans-serif; color:#fff; overflow:hidden; position:relative; }
  .glow { position:absolute; width:360px; height:360px; border-radius:50%; filter:blur(70px); opacity:.25; }
  .g1 { background:#fbbf24; right:-80px; bottom:-140px; }
  .g2 { background:#93c5fd; left:-120px; top:-140px; }
  .inner { display:flex; flex-direction:column; align-items:center; gap:14px; z-index:1; }
  .brand { display:flex; align-items:center; gap:14px; }
  .brand img { width:56px; height:56px; filter:drop-shadow(0 4px 12px rgba(0,0,0,.35)); }
  .brand b { font-size:34px; letter-spacing:1px; text-shadow:0 2px 10px rgba(0,0,0,.25); }
  .tag { font-size:${LOCALE === 'en' ? '15px' : '16.5px'}; opacity:.95; letter-spacing:.5px; text-align:center; }
  .feats { display:flex; gap:8px; font-size:12px; }
  .feats span { background:rgba(255,255,255,.14); border:1px solid rgba(255,255,255,.30);
                padding:4px 12px; border-radius:999px; backdrop-filter:blur(4px); }
</style></head><body>
  <div class="glow g1"></div><div class="glow g2"></div>
  <div class="inner">
    <div class="brand"><img src="data:image/png;base64,${iconB64}"><b>Markpilot</b></div>
    <div class="tag">${COPY.tag}</div>
    <div class="feats">${COPY.feats.map((f) => `<span>${f}</span>`).join('')}</div>
  </div>
</body></html>`;

const MARQUEE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  * { margin:0; box-sizing:border-box; }
  body { width:1400px; height:560px; display:flex; align-items:center;
         background: linear-gradient(120deg, #17255f 0%, #1e3a8a 35%, #2563eb 75%, #3b82f6 100%);
         font-family: "PingFang SC", "Noto Sans CJK SC", system-ui, sans-serif; color:#fff; overflow:hidden; position:relative; }
  .glow { position:absolute; border-radius:50%; filter:blur(90px); opacity:.22; }
  .g1 { background:#fbbf24; width:520px; height:520px; right:60px; bottom:-260px; }
  .g2 { background:#93c5fd; width:480px; height:480px; left:-160px; top:-220px; }
  .left { margin-left:110px; z-index:1; display:flex; flex-direction:column; gap:26px; max-width:560px; }
  .brand { display:flex; align-items:center; gap:22px; }
  .brand img { width:92px; height:92px; filter:drop-shadow(0 6px 18px rgba(0,0,0,.4)); }
  .brand b { font-size:58px; letter-spacing:1.5px; text-shadow:0 3px 14px rgba(0,0,0,.3); }
  .tag { font-size:${LOCALE === 'en' ? '24px' : '26px'}; opacity:.95; letter-spacing:1px; white-space:nowrap; }
  .feats { display:flex; gap:12px; font-size:17px; }
  .feats span { background:rgba(255,255,255,.14); border:1px solid rgba(255,255,255,.32);
                padding:7px 16px; border-radius:999px; backdrop-filter:blur(4px); white-space:nowrap; }
  .shot { position:absolute; right:90px; top:50%; transform:translateY(-50%) rotate(1.5deg); z-index:1;
          width:640px; border-radius:14px; overflow:hidden;
          box-shadow:0 30px 80px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.18); }
  .shot img { display:block; width:640px; height:400px; object-fit:cover; object-position:top; }
</style></head><body>
  <div class="glow g1"></div><div class="glow g2"></div>
  <div class="left">
    <div class="brand"><img src="data:image/png;base64,${iconB64}"><b>Markpilot</b></div>
    <div class="tag">${COPY.tag}</div>
    <div class="feats">${COPY.feats.map((f) => `<span>${f}</span>`).join('')}</div>
  </div>
  <div class="shot"><img src="data:image/png;base64,${panelShotB64}"></div>
</body></html>`;

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage(MARQUEE
    ? { viewport: { width: 1400, height: 560 } }
    : { viewport: { width: 440, height: 280 } });
  await page.setContent(MARQUEE ? MARQUEE_HTML : TILE_HTML);
  await page.waitForTimeout(400);
  fs.mkdirSync(shotDir, { recursive: true });
  const out = path.join(shotDir, MARQUEE ? 'promo-marquee-1400x560.png' : 'promo-tile-440x280.png');
  await page.screenshot({ path: out });
  await browser.close();
  console.log('done →', out);
})().catch((e) => { console.error(e); process.exit(1); });
