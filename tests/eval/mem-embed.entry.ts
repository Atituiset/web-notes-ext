// 评测入口（e2e-embedding）：memory+embedding 必须打进同一 bundle——分开打会让
// setDenseRanker/端口注册表写进各自拷贝的模块状态（searchMemories 读到另一份）。
// 注意：tests/e2e-embedding.mjs 会重新生成本文件，两处内容须保持一致。
export * from '../../packages/core/src/memory.js';
export * from '../../packages/core/src/embedding.js';
export { setupChromePlatform } from '../../packages/chrome-ext/src/platform/index.js';
