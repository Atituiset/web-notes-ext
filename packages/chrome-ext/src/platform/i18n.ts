/** I18n 端口 chrome 实现 — chrome.i18n（_locales，跟随浏览器 UI 语言） */
import type { I18n } from '../../../core/src/ports.js';

export const chromeI18n: I18n = {
  msg: (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String)),
};
