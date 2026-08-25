/**
 * 正文提取 — 简化版 Readability 算法（零依赖）
 *
 * MVP 自写：候选容器打分（按 <p> 文本量）+ 清洗（去 nav/script/广告类节点）。
 * 覆盖不了的长尾再考虑引入 @mozilla/readability。
 */

const NOISE_SELECTOR = [
  'script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside', 'form',
  'iframe', 'svg', 'canvas', 'button',
  '[role=navigation]', '[role=banner]', '[role=complementary]',
  '.nav', '.sidebar', '.menu', '.footer', '.header', '.comment', '.comments',
  '.ad', '.ads', '.advert', '#sidebar', '#comments',
].join(',');

function scoreCandidate(el) {
  let score = 0;
  for (const p of el.querySelectorAll('p')) {
    const len = (p.textContent || '').trim().length;
    if (len > 40) score += len;
  }
  return score;
}

function findArticleRoot(doc) {
  const candidates = new Set();
  for (const p of doc.querySelectorAll('p')) {
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
function extractArticle(rootDoc) {
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
      const tag = child.tagName.toLowerCase();
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
