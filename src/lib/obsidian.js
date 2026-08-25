/**
 * Obsidian 导出器：三通道
 *   1. fs-access  主通道 — Filesystem Access API，句柄持久化在 IndexedDB
 *   2. uri        兜底 — obsidian://new（大内容受限）
 *   3. rest-api   高级 — Obsidian Local REST API 插件 (127.0.0.1:27123)
 *
 * 幂等 (DESIGN.md D4)：
 *   文件名 <vault>/<dirTemplate>/<域名>-<slug>.md；
 *   写入前读取已有文件 frontmatter source: 命中则整文件重写。
 */
import { idbGet, idbPut, getSettings } from './db.js';
import { renderPageMarkdown, noteToMarkdown, slugify } from './markdown.js';

export async function getVaultHandle() {
  const row = await idbGet('handles', 'vault');
  return row || null;
}

/** 必须在用户手势内调用 (坑 #2)。返回 handle。 */
export async function pickVault() {
  if (!window.showDirectoryPicker) throw new Error('当前浏览器不支持 Filesystem Access API');
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  await idbPut('handles', 'vault', handle);
  return handle;
}

/** 恢复权限；granted → true。needs-prompt 时 UI 需让用户点一次按钮调 ensureVaultPermission。 */
export async function vaultPermissionState() {
  const h = await getVaultHandle();
  if (!h) return 'no-handle';
  return (await h.queryPermission({ mode: 'readwrite' })) || 'prompt';
}

export async function ensureVaultPermission() {
  const h = await getVaultHandle();
  if (!h) throw new Error('未授权 vault 目录');
  if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return h;
  const r = await h.requestPermission({ mode: 'readwrite' });
  if (r !== 'granted') throw new Error('vault 权限被拒绝');
  return h;
}

function fileNameFor(url, title) {
  let host = 'unknown';
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch { /* keep */ }
  return `${host}-${slugify(title || url)}.md`;
}

async function findExistingFile(dir, fileName) {
  try {
    return await dir.getFileHandle(fileName, { create: false });
  } catch {
    return null;
  }
}

/**
 * 主通道导出。@returns {{file: string}}
 */
export async function exportViaFsAccess({ url, title, notes, pageMarkdown }) {
  const root = await ensureVaultPermission();
  const settings = await getSettings();
  const dirName = settings.vaultDirTemplate || 'Clippings';
  const dir = await root.getDirectoryHandle(dirName, { create: true });

  const fileName = fileNameFor(url, title);
  const existingFh = await findExistingFile(dir, fileName);
  let existingText = '';
  if (existingFh) {
    const f = await existingFh.getFile();
    existingText = await f.text();
    // source 不匹配（同名不同页）→ 换带序号的新文件名，避免覆盖他人文件
    if (/^source:\s*"/m.test(existingText)) {
      const m = /source:\s*"([^"]*)"/.exec(existingText);
      if (m && m[1] !== url) {
        const alt = fileName.replace(/\.md$/, '-' + slugify(url, 10) + '.md');
        return writePage(dir, alt, { url, title, notes, pageMarkdown });
      }
    }
  }
  return writePage(dir, fileName, { url, title, notes, pageMarkdown }, existingText);
}

async function writePage(dir, fileName, { url, title, notes, pageMarkdown }, existingText = '') {
  const now = Date.now();
  const md = renderPageMarkdown(
    existingText,
    {
      source: url,
      title,
      clipped: now,
      updated: now,
      tags: ['web-notes'],
    },
    (notes || []).map(noteToMarkdown).join('\n\n'),
    pageMarkdown || ''
  );
  const fh = await dir.getFileHandle(fileName, { create: true });
  const w = await fh.createWritable();
  await w.write(md);
  await w.close();
  return { file: fileName };
}

/** URI 兜底：>~2KB 内容会失败/截断，调用方应先提示走主通道 */
export function exportViaUri(vaultName, fileName, markdown) {
  if (markdown.length > 2000) throw new Error('内容过大 (>2KB)，请使用主通道 (目录授权) 导出');
  const u =
    'obsidian://new?vault=' + encodeURIComponent(vaultName) +
    '&file=' + encodeURIComponent(fileName) +
    '&content=' + encodeURIComponent(markdown);
  window.open(u, '_blank');
}

/** 高级通道：Local REST API 插件 */
export async function exportViaRestApi({ url, title, notes, pageMarkdown, apiKey }) {
  const now = Date.now();
  const md = renderPageMarkdown('', { source: url, title, clipped: now, updated: now, tags: ['web-notes'] },
    (notes || []).map(noteToMarkdown).join('\n\n'), pageMarkdown || '');
  const fileName = fileNameFor(url, title);
  const resp = await fetch('http://127.0.0.1:27123/vault/' + encodeURIComponent(fileName), {
    method: 'PUT',
    headers: {
      'Content-Type': 'text/markdown',
      Authorization: 'Bearer ' + (apiKey || ''),
    },
    body: md,
  });
  if (!resp.ok) throw new Error('Local REST API 写入失败 HTTP ' + resp.status);
  return { file: fileName };
}
