/**
 * Markpilot Memory — Semantic Memory 层 (docs/MEMORY-DESIGN.md)
 *
 * 记忆 = Obsidian vault 中的 Markdown 文件（<vault>/Markpilot-Memory/<domain>-<slug>.md）
 * frontmatter: type/scope/domain/source/created/updated/confidence/pinned/hits/tags
 * 检索: 词面重叠评分 + pin/hits/recency 排序（个人规模 <1000 条无需向量）
 *
 * 本文件是纯 vault 存取层，不依赖 chrome.* API，可在单测中直接跑。
 */

import { getVaultHandle, vaultPermissionState, ensureVaultPermission } from './obsidian.js';
import { parseFrontmatter } from './markdown.js';

export interface MemoryMeta {
  type: 'memory';
  scope: 'user' | 'domain';
  domain?: string;
  source?: string;
  created: string;
  updated: string;
  confidence: 'high' | 'medium' | 'low';
  pinned: boolean;
  hits: number;
  tags: string[];
}

export interface MemoryEntry extends MemoryMeta {
  file: string;       // 文件名
  body: string;       // 正文
}

export const MEM_DIR = 'Markpilot-Memory';
const COLD_DAYS = 90;

function slugify(text, maxLen = 40) {
  const s = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (s || 'memo').slice(0, maxLen).replace(/-+$/, '');
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function memDir(): Promise<FileSystemDirectoryHandle | null> {
  if ((await vaultPermissionState()) !== 'granted') return null;
  const root = await ensureVaultPermission();
  return root.getDirectoryHandle(MEM_DIR, { create: true });
}

function renderMemoryFile(meta: MemoryMeta, body: string): string {
  const lines = [
    '---',
    'type: memory',
    'scope: ' + meta.scope,
    ...(meta.domain ? ['domain: ' + meta.domain] : []),
    ...(meta.source ? ['source: "' + String(meta.source).replace(/"/g, '\\"') + '"'] : []),
    'created: ' + meta.created,
    'updated: ' + meta.updated,
    'confidence: ' + meta.confidence,
    'pinned: ' + meta.pinned,
    'hits: ' + meta.hits,
    'tags:' + (meta.tags.length ? '' : ' []'),
    ...meta.tags.map((t) => '  - ' + t),
    '---',
    '',
    body,
    '',
  ];
  return lines.join('\n');
}

/** 写入或更新一条记忆（按文件名幂等）。返回文件名。 */
export async function saveMemory(entry: {
  scope: 'user' | 'domain';
  domain?: string;
  source?: string;
  body: string;
  tags?: string[];
  confidence?: 'high' | 'medium' | 'low';
  pinned?: boolean;
  file?: string; // 提供则更新该文件（保留 created/hits）
}): Promise<string> {
  const dir = await memDir();
  if (!dir) throw new Error('vault 未授权 — 请到设置页授权目录');

  const file = entry.file || `${entry.domain || 'user'}-${slugify(entry.body)}.md`;
  let created = today();
  let hits = 0;

  // 更新已有：保留 created/hits
  try {
    const fh = await dir.getFileHandle(file, { create: false });
    const existing = parseFrontmatter(await (await fh.getFile()).text());
    if (existing.attrs.type === 'memory') {
      created = String(existing.attrs.created || created);
      hits = Number(existing.attrs.hits) || 0;
    }
  } catch { /* 新文件 */ }

  const meta: MemoryMeta = {
    type: 'memory',
    scope: entry.scope,
    domain: entry.domain,
    source: entry.source,
    created,
    updated: today(),
    confidence: entry.confidence || 'medium',
    pinned: entry.pinned ?? false,
    hits,
    tags: entry.tags || [],
  };

  const fh = await dir.getFileHandle(file, { create: true });
  const w = await fh.createWritable();
  await w.write(renderMemoryFile(meta, entry.body));
  await w.close();
  return file;
}

/** 列出全部记忆。vault 未授权返回 []。 */
export async function listMemories(): Promise<MemoryEntry[]> {
  const dir = await memDir();
  if (!dir) return [];
  const out: MemoryEntry[] = [];
  for await (const [name, handle] of (dir as any).entries()) {
    if (handle.kind !== 'file' || !name.endsWith('.md')) continue;
    try {
      const text = await (await (handle as FileSystemFileHandle).getFile()).text();
      const parsed = parseFrontmatter(text);
      if (parsed.attrs.type !== 'memory') continue;
      out.push({
        type: 'memory',
        scope: (parsed.attrs.scope as any) || 'user',
        domain: parsed.attrs.domain || undefined,
        source: parsed.attrs.source || undefined,
        created: String(parsed.attrs.created || ''),
        updated: String(parsed.attrs.updated || ''),
        confidence: (parsed.attrs.confidence as any) || 'medium',
        pinned: parsed.attrs.pinned === true || parsed.attrs.pinned === 'true',
        hits: Number(parsed.attrs.hits) || 0,
        tags: Array.isArray((parsed.attrs as any)._tags) ? (parsed.attrs as any)._tags : [],
        file: name,
        body: parsed.body.trim(),
      });
    } catch { /* 跳过坏文件 */ }
  }
  return out;
}

/** 删除一条记忆 */
export async function deleteMemory(file: string): Promise<void> {
  const dir = await memDir();
  if (!dir) throw new Error('vault 未授权');
  await dir.removeEntry(file);
}

/** 钉选/取消钉选 */
export async function pinMemory(file: string, pinned: boolean): Promise<void> {
  const all = await listMemories();
  const m = all.find((x) => x.file === file);
  if (!m) throw new Error('记忆不存在: ' + file);
  await saveMemory({
    scope: m.scope, domain: m.domain, source: m.source,
    body: m.body, tags: m.tags, confidence: m.confidence,
    pinned, file,
  });
}

// ---------- 检索 ----------

/** 中文按字、英文按词的极简分词（导出供单测） */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const w of String(text || '').toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/)) {
    if (!w) continue;
    if (/^[\u4e00-\u9fff]+$/.test(w) && w.length > 2) {
      // 中文二元组
      for (let i = 0; i < w.length - 1; i++) tokens.push(w.slice(i, i + 2));
    } else if (w.length > 1) {
      tokens.push(w);
    }
  }
  return tokens;
}

/**
 * 检索 top-K 记忆（词面重叠 + pin/hits/recency 排序）。
 * 命中的记忆后台 hits++（复述效应）。
 */
export async function searchMemories(
  query: string,
  opts: { k?: number; tokenBudget?: number } = {}
): Promise<{ memories: MemoryEntry[]; touchedFiles: string[] }> {
  const k = opts.k ?? 5;
  const qTokens = new Set(tokenize(query));
  const now = Date.now();

  const scored = (await listMemories())
    .map((m) => ({ m, score: scoreMemory(m, qTokens, now) }))
    .filter((x) => x.score > 5 || x.m.pinned)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  // token 预算截断（chars/2.5 折算）
  let budget = opts.tokenBudget ?? 1500;
  const picked: MemoryEntry[] = [];
  const touched: string[] = [];
  for (const { m } of scored) {
    const cost = Math.ceil(m.body.length / 2.5);
    if (cost > budget) continue;
    budget -= cost;
    picked.push(m);
    touched.push(m.file);
  }

  if (touched.length) void bumpHits(touched);

  return { memories: picked, touchedFiles: touched };
}

/** 单条记忆打分（导出供单测） */
export function scoreMemory(
  m: Pick<MemoryEntry, 'body' | 'tags' | 'domain' | 'pinned' | 'hits' | 'updated'>,
  queryTokens: Set<string>,
  now: number
): number {
  const mTokens = new Set([
    ...tokenize(m.body),
    ...tokenize(m.tags.join(' ')),
    ...tokenize(m.domain || ''),
  ]);
  let overlap = 0;
  for (const t of queryTokens) if (mTokens.has(t)) overlap++;
  const relevance = queryTokens.size ? overlap / Math.sqrt(queryTokens.size) : 0;
  const ageDays = Math.max(0, (now - new Date(m.updated).getTime()) / 86400000);
  const recency = Math.exp(-ageDays / 30);
  return (m.pinned ? 1000 : 0) + m.hits * 2 + recency * 10 + relevance * 50;
}

/** hits 自增（直接改文件 frontmatter，避免整条重写竞态） */
async function bumpHits(files: string[]): Promise<void> {
  const dir = await memDir();
  if (!dir) return;
  for (const f of files) {
    try {
      const fh = await dir.getFileHandle(f, { create: false });
      const text = await (await fh.getFile()).text();
      const cur = Number(/(^|\n)hits:\s*(\d+)/.exec(text)?.[2] ?? 0);
      const updated = text.replace(/(^|\n)hits:\s*\d+/, `$1hits: ${cur + 1}`);
      const w = await fh.createWritable();
      await w.write(updated);
      await w.close();
    } catch { /* ignore */ }
  }
}

/** 冷记忆判定（管理面板用） */
export function isCold(m: MemoryEntry): boolean {
  if (m.pinned || m.hits > 0) return false;
  const age = (Date.now() - new Date(m.updated).getTime()) / 86400000;
  return age > COLD_DAYS;
}
