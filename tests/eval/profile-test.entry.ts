// 评测入口（e2e-profile）：memory/profile/chat-pipeline 共享模块状态（记忆缓存、
// 端口注册表），必须打进同一 bundle，页面侧 import 一次后三个名字都用它。
export * from '../../packages/core/src/memory.js';
export * from '../../packages/core/src/profile.js';
export * from '../../packages/core/src/chat-pipeline.js';
export { setupChromePlatform } from '../../packages/chrome-ext/src/platform/index.js';
