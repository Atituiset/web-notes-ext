// 生成扩展图标 icons/icon{16,48,128}.png —— 纯 SVG（无字体依赖外字形），
// 用本机 Playwright Chromium 截图导出。运行：node scripts/make-icons.cjs
const fs = require('fs');
const path = require('path');
const { chromium } = require('/home/atituiset/.nvm/versions/node/v24.14.1/lib/node_modules/@playwright/cli/node_modules/playwright');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'icons');
fs.mkdirSync(OUT, { recursive: true });

function svg(size) {
  const r = Math.round(size * 0.22); // 圆角
  const fontSize = Math.round(size * 0.58);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#3b82f6"/>
      <stop offset="1" stop-color="#1d4ed8"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${r}" fill="url(#g)"/>
  <text x="50%" y="54%" text-anchor="middle" dominant-baseline="central"
        font-family="Arial, Helvetica, sans-serif" font-weight="bold"
        font-size="${fontSize}" fill="#ffffff">M</text>
  <rect x="${size * 0.24}" y="${size * 0.76}" width="${size * 0.52}" height="${Math.max(1.5, size * 0.045)}"
        rx="${size * 0.02}" fill="#fbbf24"/>
</svg>`;
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: '/home/atituiset/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome',
  });
  const page = await browser.newPage({ viewport: { width: 128, height: 128 } });
  for (const size of [128, 48, 16]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(svg(size));
    const el = await page.$('svg');
    await el.screenshot({ path: path.join(OUT, `icon${size}.png`), omitBackground: true });
    console.log(`icons/icon${size}.png`);
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
