// esbuild 构建：src/*.ts(js) -> dist/ 单文件 bundle
// content script 不能 bundle 成 ESM（classic script），sw 同理 —— 全部打为 iife/cjs 单文件
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  minify: false,
  sourcemap: 'inline',
  logLevel: 'info',
  target: 'chrome120',
};

const entries = [
  // [entry, outfile, format]
  ['src/background/sw.ts', 'dist/background/sw.js', 'iife'],
  ['src/content/extract.js', 'dist/content/extract.js', 'iife'],
  ['src/content/annotator.js', 'dist/content/annotator.js', 'iife'],
  ['src/panel/panel.ts', 'dist/panel/panel.js', 'iife'],
  ['src/options/options.ts', 'dist/options/options.js', 'iife'],
];

const builds = entries.map(([entry, outfile, format]) =>
  esbuild.context({
    ...common,
    entryPoints: [entry],
    outfile,
    format,
  })
);

// 语义召回运行时资源：transformers.js 预构建 ESM + onnx wasm（包内加载，不走 CDN）
import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('dist/lib/wasm', { recursive: true });
cpSync('node_modules/@xenova/transformers/dist/transformers.min.js', 'dist/lib/transformers.js');
for (const f of ['ort-wasm.wasm', 'ort-wasm-simd.wasm', 'ort-wasm-threaded.wasm', 'ort-wasm-simd-threaded.wasm']) {
  cpSync(`node_modules/onnxruntime-web/dist/${f}`, `dist/lib/wasm/${f}`);
}
// 静态 HTML 不进 bundle，但 dist 的 html 是被 git 跟踪的打包资产，
// 每次构建同步源文件，避免 zip 里 HTML 与 JS 版本错位（曾靠手动拷贝维持）
cpSync('src/panel/panel.html', 'dist/panel/panel.html');

const ctxs = await Promise.all(builds);
if (watch) {
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('watching...');
} else {
  await Promise.all(ctxs.map((c) => c.rebuild()));
  await Promise.all(ctxs.map((c) => c.dispose()));
}
