/**
 * Obsidian 导出器：三通道
 *   1. fs-access  主通道 — vault 文件读写，经 VaultFS 端口（句柄/权限细节在宿主适配器）
 *   2. uri        兜底 — obsidian://new URL 构造（大内容受限；打开动作由调用方做）
 *   3. rest-api   高级 — Obsidian Local REST API 插件 (127.0.0.1:27123)
 *
 * 幂等 (DESIGN.md D4)：
 *   文件名 <vault>/<dirTemplate>/<域名>-<slug>.md；
 *   写入前读取已有文件 frontmatter source: 命中则整文件重写。
 */
import { vaultFS, settingsStore, permissionGate, i18n } from './ports.js';
import { renderPageMarkdown, noteToMarkdown, slugify } from './markdown.js';

export function fileNameFor(url, title) {
  let host = 'unknown';
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch { /* keep */ }
  return `${host}-${slugify(title || url)}.md`;
}

/**
 * 主通道导出。@returns {{file: string}}
 */
export async function exportViaFsAccess({ url, title, notes, pageMarkdown }) {
  const vfs = vaultFS();
  await vfs.ensureAccess();
  const settings = await settingsStore().getSettings();
  const dirName = settings.vaultDirTemplate || 'Clippings';

  const fileName = fileNameFor(url, title);
  const existingText = await vfs.readText(dirName + '/' + fileName);
  if (existingText != null) {
    // source 不匹配（同名不同页）→ 换带序号的新文件名，避免覆盖他人文件
    if (/^source:\s*"/m.test(existingText)) {
      const m = /source:\s*"([^"]*)"/.exec(existingText);
      if (m && m[1] !== url) {
        const alt = fileName.replace(/\.md$/, '-' + slugify(url, 10) + '.md');
        return writePage(vfs, dirName, alt, { url, title, notes, pageMarkdown });
      }
    }
  }
  return writePage(vfs, dirName, fileName, { url, title, notes, pageMarkdown }, existingText || '');
}

async function writePage(vfs, dirName, fileName, { url, title, notes, pageMarkdown }, existingText = '') {
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
  await vfs.writeText(dirName + '/' + fileName, md);
  return { file: fileName };
}

/**
 * URI 兜底：>~2KB 内容会失败/截断，调用方应先提示走主通道。
 * 纯构造 obsidian:// URL 返回 — 打开（window.open 等）由调用方按平台做。
 */
export function exportViaUri(vaultName, fileName, markdown) {
  if (markdown.length > 2000) throw new Error('内容过大 (>2KB)，请使用主通道 (目录授权) 导出');
  return (
    'obsidian://new?vault=' + encodeURIComponent(vaultName) +
    '&file=' + encodeURIComponent(fileName) +
    '&content=' + encodeURIComponent(markdown)
  );
}

/**
 * 高级通道：Local REST API 插件（127.0.0.1:27123）。
 * 尊重 vaultDirTemplate：写到 <dir>/<fileName>，路径段分别 encode、斜杠保留
 * （dirTemplate 可含子目录，如 Clippings/AI）。
 */
export async function exportViaRestApi({ url, title, notes, pageMarkdown, apiKey }) {
  const now = Date.now();
  const md = renderPageMarkdown('', { source: url, title, clipped: now, updated: now, tags: ['web-notes'] },
    (notes || []).map(noteToMarkdown).join('\n\n'), pageMarkdown || '');
  const settings = await settingsStore().getSettings();
  const dirName = String(settings.vaultDirTemplate || 'Clippings').replace(/^\/+|\/+$/g, '');
  const fileName = fileNameFor(url, title);
  const dirPath = dirName ? dirName.split('/').filter(Boolean).map(encodeURIComponent).join('/') + '/' : '';
  // 可选 host 权限（保存设置选 rest-api 时请求）；未授权抛引导性错误
  await permissionGate().ensureHost('http://127.0.0.1:27123/vault/');
  let resp;
  try {
    resp = await fetch('http://127.0.0.1:27123/vault/' + dirPath + encodeURIComponent(fileName), {
      method: 'PUT',
      headers: {
        'Content-Type': 'text/markdown',
        Authorization: 'Bearer ' + (apiKey || ''),
      },
      body: md,
    });
  } catch (e) {
    // 连接拒绝/超时：Obsidian 未启动或插件未启用
    throw new Error(
      i18n().msg('restApiConnFailed') ||
      '无法连接 Obsidian Local REST API——请确认 Obsidian 已启动且 Local REST API 插件已启用'
    );
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new Error(
      i18n().msg('restApiAuthFailed') ||
      'Local REST API 拒绝了请求（HTTP ' + resp.status + '）——请检查设置页的 API Key 是否正确'
    );
  }
  if (!resp.ok) throw new Error('Local REST API 写入失败 HTTP ' + resp.status);
  return { file: (dirName ? dirName + '/' : '') + fileName };
}
