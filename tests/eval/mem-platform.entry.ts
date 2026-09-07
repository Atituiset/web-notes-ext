// 评测入口（eval-memory）：memory + chrome 平台装配。
// 端口注册表是模块级状态、随 bundle 隔离 —— setup 必须与 core 模块打进同一 bundle。
export * from '../../packages/core/src/memory.js';
export { setupChromePlatform } from '../../packages/chrome-ext/src/platform/index.js';
