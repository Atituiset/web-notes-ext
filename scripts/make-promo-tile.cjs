// 生成 Chrome 商店宣传磁贴 440×280（docs/store/promo-tile-440x280.png）
const path = require('path');
const fs = require('fs');
const { chromium } = require('/home/atituiset/.nvm/versions/node/v24.14.1/lib/node_modules/@playwright/cli/node_modules/playwright');

const ROOT = '/home/atituiset/Projects/web-notes-ext';
const iconB64 = fs.readFileSync(path.join(ROOT, 'icons/icon128.png')).toString('base64');

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
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
  .tag { font-size:16.5px; opacity:.95; letter-spacing:.5px; }
  .feats { display:flex; gap:8px; font-size:12px; }
  .feats span { background:rgba(255,255,255,.14); border:1px solid rgba(255,255,255,.30);
                padding:4px 12px; border-radius:999px; backdrop-filter:blur(4px); }
</style></head><body>
  <div class="glow g1"></div><div class="glow g2"></div>
  <div class="inner">
    <div class="brand"><img src="data:image/png;base64,${iconB64}"><b>Markpilot</b></div>
    <div class="tag">划词笔记 → 本地 Obsidian → AI 就地问答</div>
    <div class="feats"><span>📝 划词即记</span><span>🤖 带着页面问 AI</span><span>🔒 数据只在本机</span></div>
  </div>
</body></html>`;

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage({ viewport: { width: 440, height: 280 } });
  await page.setContent(HTML);
  await page.waitForTimeout(400);
  const out = path.join(ROOT, 'docs/store/promo-tile-440x280.png');
  await page.screenshot({ path: out });
  await browser.close();
  console.log('done →', out);
})().catch((e) => { console.error(e); process.exit(1); });
