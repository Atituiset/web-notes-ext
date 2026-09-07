/**
 * 正文提取核心 — 简化版 Readability 算法（零依赖）
 *
 * 从 content/extract.js 抽出的共享实现，供两处使用：
 *   - content/extract.js：挂 window.__wneExtract，由 executeScript 兜底按需以 MAIN world 注入后调用
 *   - content/annotator.js（isolated world）：响应 page:get-text 消息（主路径）
 * 纯 DOM 操作，不依赖 chrome.* API，两个 world 均可运行。
 */

const NOISE_SELECTOR = [
  'script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside', 'form',
  'iframe', 'svg', 'canvas', 'button',
  '[role=navigation]', '[role=banner]', '[role=complementary]',
  '.nav', '.sidebar', '.menu', '.footer', '.header', '.comment', '.comments',
  '.ad', '.ads', '.advert', '#sidebar', '#comments',
].join(',');

// Mintlify 等站点用语义化自定义标签渲染正文（<span data-as="p">），
// 打分与遍历都要把 data-as 当作真实标签看待，否则正文段落计为 0 分
const P_SELECTOR = 'p, [data-as="p"]';

function effectiveTag(el) {
  const as = el.dataset && el.dataset.as;
  return as || el.tagName.toLowerCase();
}

function scoreCandidate(el) {
  let score = 0;
  for (const p of el.querySelectorAll(P_SELECTOR)) {
    const len = (p.textContent || '').trim().length;
    if (len > 40) score += len;
  }
  return score;
}

function findArticleRoot(doc) {
  const candidates = new Set();
  for (const p of doc.querySelectorAll(P_SELECTOR)) {
    let up = p.parentElement;
    for (let i = 0; i < 3 && up; i++) {
      candidates.add(up);
      up = up.parentElement;
    }
  }
  let best = null, bestScore = 0;
  for (const c of candidates) {
    const s = scoreCandidate(c);
    if (s > bestScore) { best = c; bestScore = s; }
  }
  return best || doc.body;
}

/** DOM → 结构化 markdown-ish 纯文本，保留标题层级 */
export function extractArticle(rootDoc) {
  const doc = rootDoc.cloneNode(true);
  // 去噪
  doc.querySelectorAll(NOISE_SELECTOR).forEach((n) => n.remove());

  const title =
    (doc.querySelector('h1') && doc.querySelector('h1').textContent.trim()) ||
    (rootDoc.title || '').replace(/\s*[-–—|·].*$/, '').trim() ||
    '未命名页面';

  const root = findArticleRoot(doc);
  const out = [];

  function walk(node, depth) {
    for (const child of node.children) {
      const tag = effectiveTag(child);
      if (/^h[1-6]$/.test(tag)) {
        out.push('\n' + '#'.repeat(+tag[1]) + ' ' + child.textContent.trim() + '\n');
      } else if (tag === 'p') {
        const t = child.textContent.replace(/\s+/g, ' ').trim();
        if (t.length > 1) out.push(t + '\n');
      } else if (tag === 'li') {
        out.push('- ' + child.textContent.replace(/\s+/g, ' ').trim());
        if (out.length) out[out.length - 1] += '\n';
      } else if (tag === 'pre' || tag === 'code') {
        const t = child.textContent.trim();
        if (t) out.push('\n```\n' + t.slice(0, 2000) + '\n```\n');
      } else if (tag === 'blockquote') {
        const t = child.textContent.replace(/\s+/g, ' ').trim();
        if (t) out.push('> ' + t + '\n');
      } else if (tag === 'br') {
        continue;
      } else {
        walk(child, depth + 1);
      }
    }
  }

  if (root.children.length) walk(root, 0);
  else out.push((root.textContent || '').replace(/\s+/g, ' ').trim());

  const text = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title: String(title), text };
}
