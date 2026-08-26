/**
 * 正文提取（MAIN world 入口）— 算法实现已抽到 lib/page-extract.js
 *
 * 本文件仅以 MAIN world 注入并挂 window.__wneExtract，
 * 作为 extractPageText 的 executeScript 兜底路径（content script
 * 未注入的旧标签页）；主路径是 annotator.js 的 page:get-text 消息。
 */
import { extractArticle } from '../lib/page-extract.js';

/**
 * 在页面上下文执行：返回 {title, url, host, text}
 * 以经典脚本加载（content script 不支持 ES module）→ 挂到 window.__wneExtract
 */
window.__wneExtract = function () {
  const r = extractArticle(document);
  return Object.assign(r, {
    url: location.href,
    host: location.hostname,
  });
};
