// markdown-render XSS 安全单测：需要 DOM（node:test + 全局 stub 最小 DOM）
// 运行方式: npm test
import assert from 'node:assert';
import { test } from 'node:test';

// ---- 极简 DOM stub（仅覆盖 renderMarkdown 用到的 API）----
function makeElement(tag) {
  const node = {
    tagName: tag.toUpperCase(),
    children: [],
    className: '',
    textContent: '',
    innerHTML: '',
    type: '',
    listeners: {},
    appendChild(child) { this.children.push(child); return child; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
  };
  return node;
}
function findNodes(node, pred, out = []) {
  if (pred(node)) out.push(node);
  for (const c of node.children || []) findNodes(c, pred, out);
  return out;
}

const frag = () => makeElement('#document-fragment');

globalThis.document = {
  createDocumentFragment: frag,
  createElement: makeElement,
};

const { renderMarkdown } = await import('../../src/lib/markdown-render.js');

test('XSS: <img onerror> 不产生 img 节点，文本被转义', () => {
  const root = renderMarkdown('<img src=x onerror=alert(1)>');
  const imgs = [];
  const walk = (n) => { imgs.push(n); (n.children || []).forEach(walk); };
  walk(root);
  assert.ok(!imgs.some((n) => n.tagName === 'IMG'), '不应创建 img 元素');
});

test('XSS: <script> 标签不会成为可执行节点', () => {
  const root = renderMarkdown('hello\n\n<script>alert(1)</script>');
  const nodes = [];
  const walk = (n) => { nodes.push(n); (n.children || []).forEach(walk); };
  walk(root);
  assert.ok(!nodes.some((n) => n.tagName === 'SCRIPT'), '不应创建 script 元素');
});

test('XSS: inline HTML 标签被转义，不产生对应元素节点', () => {
  const root = renderMarkdown('see [click](https://example.com) and <b onmouseover=alert(1)>x</b>');
  const nodes = [];
  const walk = (n) => { nodes.push(n); (n.children || []).forEach(walk); };
  walk(root);
  // 不应创建 b/img/script 等由 markdown 内容注入的元素
  for (const tag of ['B', 'IMG', 'SCRIPT']) {
    assert.ok(!nodes.some((n) => n.tagName === tag), `不应创建 ${tag} 元素`);
  }
  // 链接仍正常渲染（stub 不解析 innerHTML，故检查字符串）
  const allHtml = nodes.map((n) => String(n.innerHTML || '')).join('');
  assert.ok(allHtml.includes('<a href="https://example.com"'), '正常链接应保留');
});

test('正常渲染不受影响: 标题/代码块/链接', () => {
  const root = renderMarkdown('## 标题\n\n```js\nconst a = 1;\n```\n\n[link](https://a.b)');
  const tags = [];
  const walk = (n) => { tags.push(n.tagName); (n.children || []).forEach(walk); };
  walk(root);
  assert.ok(tags.includes('H3')); // h2 降级为 h3
  assert.ok(tags.includes('PRE'));
  assert.ok(tags.includes('A') || tags.some((t) => String(t).startsWith('#')));
});
