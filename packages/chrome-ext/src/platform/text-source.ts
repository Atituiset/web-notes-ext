/**
 * TextSource 端口 chrome 实现 — 页面正文提取（逻辑自 chat-pipeline.ts 原样迁入）。
 *
 * 主路径：tabs.sendMessage → annotator.js（isolated world）的 page:get-text，
 * 不依赖 activeTab/scripting 授权（切 tab 后授权常失效，曾导致静默拿不到正文）。
 *
 * 兜底：executeScript 注入 MAIN world 调 __wneExtract（extract.js 挂载），
 * 覆盖 content script 尚未注入的旧标签页。isolated world 看不到 MAIN world
 * window 上的 __wneExtract，所以兜底必须 world: 'MAIN'。
 */
import type { TextSource } from '../../../core/src/ports.js';

export const chromeTextSource: TextSource = {
  async getPageText(tabId) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'page:get-text' });
      if (r && r.ok && r.text) return String(r.text);
    } catch { /* content script 未注入，走注入兜底 */ }
    try {
      const call = () => chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN', // 与页面 window 同世界才能看到 __wneExtract
        func: () => ((window as any).__wneExtract ? (window as any).__wneExtract() : null),
      });
      let [res] = await call();
      if (!res || !res.result) {
        // 页面先于扩展安装/更新打开：__wneExtract 不存在。
        // activeTab 授权下按需注入 extract.js 再取（自愈，省去手动刷新页面）
        await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          files: ['content/extract.js'],
        });
        [res] = await call();
      }
      return res && res.result ? String(res.result.text || '') : null;
    } catch {
      return null; /* 受限页面 / 无 activeTab 授权 */
    }
  },
};
