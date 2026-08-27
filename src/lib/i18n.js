/**
 * UI 文案 i18n — 基于 chrome.i18n（_locales），跟随浏览器 UI 语言自动切换。
 * manifest 声明 default_locale: zh_CN，浏览器非中文时回落到 en。
 *
 * 用法：
 *   msg('btnSave')            → 动态字符串
 *   msg('exportOk', file)     → 带占位符（$1/$2 按序传入）
 *   applyI18n()               → 静态 HTML：扫描 data-i18n / data-i18n-ph /
 *                               data-i18n-title 属性并替换
 */

export function msg(key, ...subs) {
  // 单测等无 chrome 环境下降级为返回 key
  const api = globalThis.chrome && globalThis.chrome.i18n;
  const m = api && api.getMessage(key, subs.map(String));
  return m || key;
}

export function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((n) => {
    n.textContent = msg(n.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-ph]').forEach((n) => {
    n.placeholder = msg(n.dataset.i18nPh);
  });
  root.querySelectorAll('[data-i18n-title]').forEach((n) => {
    n.title = msg(n.dataset.i18nTitle);
  });
}
