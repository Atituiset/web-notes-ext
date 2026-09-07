/** AssetResolver 端口 chrome 实现 — 扩展包内资源 URL（chrome-extension://…） */
import type { AssetResolver } from '../../../core/src/ports.js';

export const chromeAssets: AssetResolver = {
  resolveAssetUrl: (path) => chrome.runtime.getURL(path),
};
