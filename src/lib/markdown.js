/**
 * Markdown frontmatter 渲染/解析 (幂等导出用)
 *
 * frontmatter 固定字段: source / title / clipped / updated / tags
 * 幂等匹配依据 source 字段 (页面 URL)。
 */

export function slugify(text, maxLen = 48) {
  let s = String(text || '')
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '') // strip scheme
    .replace(/[?#].*$/, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!s) s = 'untitled';
  return s.slice(0, maxLen).replace(/-+$/, '');
}

function yamlEscape(v) {
  return JSON.stringify(String(v));
}

export function renderFrontmatter(meta) {
  const lines = ['---'];
  lines.push('source: ' + yamlEscape(meta.source));
  lines.push('title: ' + yamlEscape(meta.title));
  lines.push('clipped: ' + yamlEscape(new Date(meta.clipped).toISOString()));
  lines.push('updated: ' + yamlEscape(new Date(meta.updated).toISOString()));
  lines.push(
    'tags:' +
      (meta.tags && meta.tags.length ? '' : ' []')
  );
  for (const t of meta.tags || []) lines.push('  - ' + yamlEscape(t));
  lines.push('---');
  return lines.join('\n');
}

/** 解析 `--- ... ---` frontmatter；无则返回 { attrs:{}, body:text }。
 *  标量 → 字符串（带引号的 JSON 反转义）；`key:` 后跟 `  - item` 行 → 字符串数组 */
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { attrs: {}, body: text };
  const attrs = {};
  let listKey = null;
  const unquote = (v) => (/^".*"$/.test(v) ? JSON.parse(v) : v);
  for (const line of m[1].split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) {
      attrs[listKey].push(unquote(item[1].trim()));
      continue;
    }
    listKey = null;
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const v = kv[2].trim();
    if (v === '') {
      // 可能是 YAML 列表的开头（tags: 后跟 - 行），先按数组收集
      attrs[kv[1]] = [];
      listKey = kv[1];
    } else {
      attrs[kv[1]] = unquote(v);
    }
  }
  return { attrs, body: text.slice(m[0].length) };
}

/**
 * 幂等渲染整页笔记文件：
 * 已有文件且 source 匹配 → 以本地为准整文件重写（保留 clipped 时间）；
 * 否则新建。
 */
export function renderPageMarkdown(existingText, meta, notesMd, pageBodyMd) {
  let clipped = meta.updated;
  if (existingText) {
    const parsed = parseFrontmatter(existingText);
    if (parsed.attrs.source === meta.source && parsed.attrs.clipped) {
      clipped = parsed.attrs.clipped;
    }
  }
  const fm = renderFrontmatter({
    source: meta.source,
    title: meta.title,
    clipped,
    updated: meta.updated,
    tags: meta.tags || ['web-notes'],
  });
  const parts = [fm, '', '# ' + meta.title, ''];
  if (pageBodyMd) parts.push(pageBodyMd, '');
  parts.push('## 笔记', '');
  parts.push(notesMd.length ? notesMd : '> （本页暂无笔记）');
  parts.push('');
  return parts.join('\n');
}

/** 单条笔记 → markdown 块（callout 风格，Obsidian 可正常渲染） */
export function noteToMarkdown(note) {
  const time = new Date(note.ts).toISOString().replace('T', ' ').slice(0, 16);
  const lines = [];
  lines.push('> [!note] ' + time + (note.kind === 'ai-qa' ? ' · AI 问答' : ''));
  if (note.sel && note.sel.text) {
    lines.push('> 划词: “' + note.sel.text + '”');
    lines.push('>');
  }
  for (const l of String(note.content || '').split('\n')) lines.push('> ' + l);
  return lines.join('\n');
}
