/**
 * PermissionGate 端口 chrome 实现 — chrome.permissions（optional_host_permissions）。
 * 逻辑与原 llm/index.ts ensureHostPermission、chat-pipeline.ts requestSitePermission 一致。
 */
import type { PermissionGate } from '../../../core/src/ports.js';

export const chromePermissions: PermissionGate = {
  /** fetch 前守卫：未授权抛引导性错误（i18n hostPermissionMissing + 英文兜底） */
  async ensureHost(url) {
    let origin: string;
    try {
      const u = new URL(url);
      origin = u.protocol + '//' + u.hostname + '/*';
    } catch {
      return; // 非法 url 直接放行
    }
    const granted = await chrome.permissions.contains({ origins: [origin] }).catch(() => false);
    if (!granted) {
      throw new Error(
        chrome.i18n.getMessage('hostPermissionMissing', origin) ||
        `Missing network access for ${origin} — re-save the settings page to grant it`
      );
    }
  },
  /** 用户手势内发起站点授权；非手势上下文或用户拒绝返回 false */
  async requestHost(url) {
    try {
      const origin = new URL(url).origin + '/*';
      if (await chrome.permissions.contains({ origins: [origin] })) return true;
      return await chrome.permissions.request({ origins: [origin] });
    } catch {
      return false;
    }
  },
};
