// esbuild 构建：src/extension.ts → dist/extension.js（cjs 单文件，VS Code 扩展宿主加载）
// core 是 ESM，esbuild 一并打进 cjs bundle —— 端口注册表随单 bundle 只有一份，
// activate() 里 configurePlatform 一次即可（多 bundle 才需要重复装配）。
// vscode 由宿主提供必须 external；@xenova/transformers 懒加载（dynamic import），
// 打包为可选外部依赖 —— 装不上时语义召回静默降级为词法单路。
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const ctx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  logLevel: 'info',
  external: ['vscode', '@xenova/transformers', 'onnxruntime-node'],
});

if (watch) {
  await ctx.watch();
  console.log('watching...');
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
