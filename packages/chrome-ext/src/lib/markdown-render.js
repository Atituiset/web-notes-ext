/**
 * 轻量 Markdown → DOM 渲染（零依赖，安全转义）
 * 支持: 标题/粗斜体/行内代码/代码块(带复制)/列表/引用/表格/链接/分隔线
 */
import { msg as t } from './i18n.js';

export function renderMarkdown(md) {
  const frag = document.createDocumentFragment();
  const lines = String(md || '').split('\n');
  let i = 0;

  // HTML 转义
  const esc = (s) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // 行内格式：code → 粗斜 → 链接
  const inline = (s) => {
    let out = esc(s);
    const codes = [];
    out = out.replace(/`([^`]+)`/g, (_, c) => {
      codes.push(c);
      return '\x00' + (codes.length - 1) + '\x00';
    });
    out = out
      .replace(/\*\*\*([^*]+)\*\*\*/g, '<b><i>$1</i></b>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/\*([^*]+)\*/g, '<i>$1</i>')
      .replace(/_([^_]+)_/g, '<i>$1</i>')
      .replace(/~~([^~]+)~~/g, '<s>$1</s>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return out.replace(/\x00(\d+)\x00/g, (_, n) => '<code>' + codes[+n] + '</code>');
  };

  function makePre(codeText, lang) {
    const pre = document.createElement('pre');
    if (lang) {
      const tag = document.createElement('span');
      tag.className = 'lang-tag';
      tag.textContent = lang;
      pre.appendChild(tag);
    }
    const btn = document.createElement('button');
    btn.className = 'copy-code';
    btn.type = 'button';
    btn.textContent = t('copyBtn');
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(codeText).then(() => {
        btn.textContent = '✓';
        setTimeout(() => (btn.textContent = t('copyBtn')), 1200);
      });
    });
    const code = document.createElement('code');
    code.textContent = codeText;
    pre.appendChild(btn);
    pre.appendChild(code);
    return pre;
  }

  while (i < lines.length) {
    const line = lines[i];

    // 代码块 ```
    if (/^```/.test(line)) {
      const lang = line.replace(/^```/, '').trim().toLowerCase();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // skip closing ```
      frag.appendChild(makePre(buf.join('\n'), lang));
      continue;
    }
    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = Math.min(h[1].length + 1, 5); // 侧栏里 h1 太大，降一级
      const elh = document.createElement('h' + level);
      elh.innerHTML = inline(h[2]);
      frag.appendChild(elh);
      i++;
      continue;
    }
    // 分隔线
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      frag.appendChild(document.createElement('hr'));
      i++;
      continue;
    }
    // 表格: | a | b | / | - | - |
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const headerCells = line.split('|').slice(1, -1).map((s) => s.trim());
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(lines[i].split('|').slice(1, -1).map((s) => s.trim()));
        i++;
      }
      const table = document.createElement('table');
      const thead = document.createElement('thead');
      const trh = document.createElement('tr');
      for (const c of headerCells) {
        const th = document.createElement('th');
        th.innerHTML = inline(c);
        trh.appendChild(th);
      }
      thead.appendChild(trh);
      table.appendChild(thead);
      const tbody = document.createElement('tbody');
      for (const row of rows) {
        const tr = document.createElement('tr');
        for (const c of row) {
          const td = document.createElement('td');
          td.innerHTML = inline(c);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      frag.appendChild(table);
      continue;
    }
    // 引用块
    if (/^>\s?/.test(line)) {
      const bq = document.createElement('blockquote');
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        const p = document.createElement('p');
        p.innerHTML = inline(lines[i].replace(/^>\s?/, ''));
        bq.appendChild(p);
        i++;
      }
      frag.appendChild(bq);
      continue;
    }
    // 无序 / 有序列表
    const ulm = /^\s*[-*+]\s+/;
    const olm = /^\s*(\d+)[.)]\s+/;
    if (ulm.test(line) || olm.test(line)) {
      const ordered = olm.test(line);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      while (i < lines.length && (ordered ? olm : ulm).test(lines[i])) {
        const li = document.createElement('li');
        li.innerHTML = inline(lines[i].replace(ordered ? olm : ulm, ''));
        list.appendChild(li);
        i++;
      }
      frag.appendChild(list);
      continue;
    }
    // 空行
    if (!line.trim()) { i++; continue; }
    // 普通段落（连续非空非特殊行合并）
    const buf = [line];
    i++;
    while (
      i < lines.length && lines[i].trim() &&
      !/^(#{1,6}\s|```|>|\s*[-*+]\s|\s*\d+[.)]\s|\s*\|)/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    const p = document.createElement('p');
    p.innerHTML = inline(buf.join('\n')).replace(/\n/g, '<br>');
    frag.appendChild(p);
  }
  return frag;
}
