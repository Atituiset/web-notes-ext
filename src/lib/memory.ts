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

// ---------- 去重 / 合并（MEMORY-DESIGN §1.2）----------

/** 两条记忆正文的词面相似度：重叠 token / 较小 token 集（导出供单测） */
export function bodySimilarity(a: string, b: string): number {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / Math.min(sa.size, sb.size);
}

/**
 * enrich 合并决策（纯函数，导出供单测）：
 * 新内容的所有 token 已被旧正文覆盖 → 不追加（仅调用方刷新 updated）；
 * 否则把新正文作为补充追加到旧正文后。
 */
export function enrichBody(oldBody: string, newBody: string): { body: string; novel: boolean } {
  const oldTokens = new Set(tokenize(oldBody));
  const novel = [...new Set(tokenize(newBody))].some((t) => !oldTokens.has(t));
  return { body: novel ? oldBody + '\n' + newBody : oldBody, novel };
}

/** 相似度阈值：达到则视为同一记忆的复述/补充 */
const SIMILARITY_THRESHOLD = 0.7;

/** 在同 scope 记忆里找与 body 最相似的一条（达到阈值才返回） */
export async function findSimilar(
  body: string,
  scope: 'user' | 'domain' = 'user'
): Promise<MemoryEntry | null> {
  let best: MemoryEntry | null = null;
  let bestSim = 0;
  for (const m of await listMemories()) {
    if (m.scope !== scope) continue;
    const s = bodySimilarity(body, m.body);
    if (s > bestSim) { bestSim = s; best = m; }
  }
  return bestSim >= SIMILARITY_THRESHOLD ? best : null;
}

/**
 * 去重写入（记忆提取管线专用；pin/编辑走 saveMemory 显式 file 路径，不经此）：
 * 存在高度重叠的已有记忆 → enrich 原文件（合并 tags、保留 created/hits/pinned），
 * 否则新建。返回写入的文件名。
 */
export async function saveMemoryDedup(entry: {
  scope: 'user' | 'domain';
  domain?: string;
  source?: string;
  body: string;
  tags?: string[];
  confidence?: 'high' | 'medium' | 'low';
}): Promise<string> {
  const sim = await findSimilar(entry.body, entry.scope);
  if (!sim) return saveMemory(entry);
  const { body } = enrichBody(sim.body, entry.body);
  return saveMemory({
    scope: sim.scope,
    domain: sim.domain,
    source: entry.source || sim.source,
    body,
    tags: [...new Set([...sim.tags, ...(entry.tags || [])])],
    confidence: entry.confidence || sim.confidence,
    pinned: sim.pinned,
    file: sim.file,
  });
}

/**
 * 列出全部记忆。vault 未授权返回 []。
 * mtime 缓存：评测发现 #3——每次查询全量读文件+解析是延迟大头（1000 条 p50>1s）。
 * getFile() 只取元数据不读全文，mtime 未变直接用缓存条目；
 * 写入侧（saveMemory/bumpHits/delete）靠 mtime 变化与目录核对自然失效，无需显式清缓存。
 */
const _entryCache = new Map<string, { mtime: number; entry: MemoryEntry }>();

export async function listMemories(): Promise<MemoryEntry[]> {
  const dir = await memDir();
  if (!dir) { _entryCache.clear(); return []; }
  const out: MemoryEntry[] = [];
  const seen = new Set<string>();
  for await (const [name, handle] of (dir as any).entries()) {
    if (handle.kind !== 'file' || !name.endsWith('.md')) continue;
    seen.add(name);
    try {
      const f = await (handle as FileSystemFileHandle).getFile(); // 元数据，不读全文
      const cached = _entryCache.get(name);
      if (cached && cached.mtime === f.lastModified) { out.push(cached.entry); continue; }
      const parsed = parseFrontmatter(await f.text());
      if (parsed.attrs.type !== 'memory') { _entryCache.delete(name); continue; }
      const entry: MemoryEntry = {
        type: 'memory',
        scope: (parsed.attrs.scope as any) || 'user',
        domain: parsed.attrs.domain || undefined,
        source: parsed.attrs.source || undefined,
        created: String(parsed.attrs.created || ''),
        updated: String(parsed.attrs.updated || ''),
        confidence: (parsed.attrs.confidence as any) || 'medium',
        pinned: parsed.attrs.pinned === true || parsed.attrs.pinned === 'true',
        hits: Number(parsed.attrs.hits) || 0,
        tags: Array.isArray(parsed.attrs.tags) ? parsed.attrs.tags.map(String) : [],
        file: name,
        body: parsed.body.trim(),
      };
      _entryCache.set(name, { mtime: f.lastModified, entry });
      out.push(entry);
    } catch { /* 跳过坏文件 */ }
  }
  // 清理已删除文件的缓存
  for (const key of _entryCache.keys()) if (!seen.has(key)) _entryCache.delete(key);
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

/** 英文停用词：零区分度，不过滤会让任何共享 the/to/do 的记忆蒙混过 overlap>0（评测发现 #2） */
const STOPWORDS_EN = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with', 'at', 'by',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its', 'this', 'that', 'these', 'those',
  'do', 'does', 'did', 'how', 'what', 'when', 'where', 'who', 'why', 'which',
  'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must',
  'not', 'no', 'yes', 'right', 'ok',
  'i', 'you', 'he', 'she', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'their', 'our', 'as', 'so', 'if', 'than', 'then', 'there', 'here',
]);

/**
 * 极简词干归一（导出供单测）：
 * 覆盖评测发现 #1 的失配类型（json/json1、query/querying），不做完整 Porter——
 * 个人语料规模下收益/复杂度比最高的几条规则，查询与记忆两侧一致应用即可对齐。
 */
export function naiveStem(w: string): string {
  if (!/^[a-z0-9]+$/.test(w)) return w;
  // 尾数字：json1 → json（剩余不足 4 字符不动，避免误伤）
  if (w.length > 4 && /\d+$/.test(w)) {
    const s = w.replace(/\d+$/, '');
    if (s.length >= 4) return s;
  }
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);      // querying → query
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);       // needed → need
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) {
    return w.slice(0, -1);                                            // functions → function
  }
  return w;
}

/** 中文 bigram、英文按词 + 停用词过滤 + 词干归一（导出供单测） */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const w of String(text || '').toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/)) {
    if (!w) continue;
    if (/^[\u4e00-\u9fff]+$/.test(w) && w.length > 2) {
      // 中文二元组
      for (let i = 0; i < w.length - 1; i++) tokens.push(w.slice(i, i + 2));
    } else if (w.length > 1 && !STOPWORDS_EN.has(w)) {
      tokens.push(naiveStem(w));
    }
  }
  return tokens;
}

// ---------- 混合召回（sparse 词法 + dense 向量，RRF 名次融合） ----------

export interface DenseHit { file: string; sim: number; }
export interface DenseCandidate { file: string; body: string; }
/**
 * 稠密排序器：由 embedding 通道（浏览器端侧模型 / Ollama / API）注入。
 * 返回按相似度降序的命中；sim 用于地板过滤（DENSE_SIM_FLOOR）。
 */
export type DenseRanker = (query: string, candidates: DenseCandidate[]) => Promise<DenseHit[]>;

let _denseRanker: DenseRanker | null = null;

/** 注入稠密排序器；传 null 退回纯词法检索 */
export function setDenseRanker(fn: DenseRanker | null): void {
  _denseRanker = fn;
}

/** dense 相似度地板：实测拒答类 top sim 最高 ~0.25、真实命中 ≥0.34 居多，
 *  0.33 是当前模型判别力下的最优平衡（0.2 已验证会冲垮拒答与 precision） */
export const DENSE_SIM_FLOOR = 0.33;
/** dense 注入名次帽：只给 top-N 语义命中加分，rank 4+ 的边缘命中是 precision 噪声源 */
export const DENSE_TOP_N = 2;
/** dense 加成分档：top1/2/3 分别得 GAIN × (3/3, 2/3, 1/3) */
export const DENSE_GAIN = 40;

/**
 * 融合（纯函数，导出供单测）：
 *   final = pinned 置顶 + sparseScore + denseGain(rank) × sparseVacuum
 *   sparseVacuum = 1 / (1 + maxSparseScore / 20)
 * 候选集 = pinned ∪ 词面重叠 ∪ dense 过地板命中。
 *
 * 设计要点（均由评测数据驱动）：
 * - 不用 RRF 名次融合：RRF 抹掉 sparse 分里的 recency/hits 量级，知识更新场景
 *   新旧版仅凭语义排错序（实测 knowledgeUpdate 100%→0%）。加和保留时间信号。
 * - dense 加分按名次分档而非 sim 差值：该模型 sim 分布压缩（相关 0.34-0.58、
 *   零相关 <0.2），top1 真实命中与地板只差 0.01，差值量纲不可靠。
 * - sparseVacuum 真空门控：词面证据强时 dense 只作确认（小加分），词面真空
 *   （改述场景）时 dense 主导——防止语义邻近噪声顶掉强词面命中（precision 保护）。
 * @param sparseScored 词法打分后的全量列表（未过滤，含 score/overlap）
 * @param denseHits    dense 命中（file → sim，已过地板且名次在 DENSE_TOP_N 内）
 */
/** dense 激活门限：maxSparse ≥ 20 时 dense 完全静默（词面证据足够，dense 只添噪声） */
export const DENSE_VACUUM_MAX_SPARSE = 20;

export function fuseWeighted(
  sparseScored: { m: MemoryEntry; score: number; overlap: number; tagOverlap: number }[],
  denseHits: Map<string, number>
): { m: MemoryEntry; score: number; overlap: number; tagOverlap: number; final: number }[] {
  const maxSparse = Math.max(0, ...sparseScored.map((x) => x.score));
  const vacuum = 1 / (1 + maxSparse / 20);
  const denseActive = maxSparse < DENSE_VACUUM_MAX_SPARSE;
  // dense 名次（sim 降序）
  const ranked = [...denseHits.entries()].sort((a, b) => b[1] - a[1]);
  const gainOf = new Map(ranked.map(([f], i) => [f, (DENSE_GAIN * (DENSE_TOP_N - i)) / DENSE_TOP_N]));
  return sparseScored
    // 过滤：重叠 ≥2（词面证据足）∪ 单重叠但命中 tags/domain（人工标注信号强）
    // —— 正文单 bigram 偶然命中（「世界杯」撞「隔离世界」）不再算证据
    .filter((x) => x.m.pinned || x.overlap >= 2 || x.tagOverlap >= 1 || denseHits.has(x.m.file))
    .map((x) => ({
      ...x,
      final: (x.m.pinned ? 1e9 : 0) + x.score + (denseActive ? (gainOf.get(x.m.file) || 0) * vacuum : 0),
    }))
    .sort((a, b) => b.final - a.final);
}

/**
 * 检索 top-K 记忆（词法 sparse + 可选 dense 混合，RRF 融合）。
 * 命中的记忆后台 hits++（复述效应）。
 */
export async function searchMemories(
  query: string,
  opts: { k?: number; tokenBudget?: number } = {}
): Promise<{ memories: MemoryEntry[]; touchedFiles: string[] }> {
  const k = opts.k ?? 5;
  const qTokens = new Set(tokenize(query));
  const now = Date.now();

  const all = await listMemories();
  // IDF：稀有 token 的区分度高（"模型"vs"json1"），抑制语料高频词的伪相关（评测发现 #2）
  const df = new Map<string, number>();
  const tokenSets = all.map((m) => memoryTokenSet(m));
  for (const ts of tokenSets) for (const t of ts) df.set(t, (df.get(t) || 0) + 1);
  const N = Math.max(1, all.length);
  const idf = (t: string) => Math.log(1 + N / (df.get(t) || 1));

  const tagSets = all.map((m) => new Set([...tokenize(m.tags.join(' ')), ...tokenize(m.domain || '')]));
  const scored = all.map((m, i) => ({
    m,
    score: scoreMemory(m, qTokens, now, idf),
    overlap: overlapCount(m, qTokens, tokenSets[i]),
    tagOverlap: overlapCount(m, qTokens, tagSets[i] as Set<string>),
  }));
  // dense 命中（注入的 ranker 不可用时静默退回纯词法）
  let denseSim = new Map<string, number>();
  if (_denseRanker && all.length) {
    try {
      const hits = await _denseRanker(query, all.map((m) => ({ file: m.file, body: m.body })));
      denseSim = new Map(
        hits
          .filter((h, i) => h.sim >= DENSE_SIM_FLOOR && i < DENSE_TOP_N)
          .map((h) => [h.file, h.sim] as [string, number])
      );
    } catch { /* embedding 不可用 → 纯词法 */ }
  }

  const fused = fuseWeighted(scored, denseSim).slice(0, k);

  // token 预算截断（chars/2.5 折算）
  let budget = opts.tokenBudget ?? 1500;
  const picked: MemoryEntry[] = [];
  const touched: string[] = [];
  for (const { m } of fused) {
    const cost = Math.ceil(m.body.length / 2.5);
    if (cost > budget) continue;
    budget -= cost;
    picked.push(m);
    touched.push(m.file);
  }

  if (touched.length) void bumpHits(touched);

  return { memories: picked, touchedFiles: touched };
}

/** 记忆的全部可检索 token（正文 + tags + domain） */
function memoryTokenSet(m: Pick<MemoryEntry, 'body' | 'tags' | 'domain'>): Set<string> {
  return new Set([
    ...tokenize(m.body),
    ...tokenize(m.tags.join(' ')),
    ...tokenize(m.domain || ''),
  ]);
}

/** 查询与记忆的词面重叠数（导出供单测）；tokenSets 复用外部算好的记忆 token 集 */
export function overlapCount(
  m: Pick<MemoryEntry, 'body' | 'tags' | 'domain'>,
  queryTokens: Set<string>,
  mTokens?: Set<string>
): number {
  const ts = mTokens || memoryTokenSet(m);
  let n = 0;
  for (const t of queryTokens) if (ts.has(t)) n++;
  return n;
}

/**
 * 单条记忆打分（导出供单测）。
 * idfFn 提供时相关性按 IDF 加权（Σidf(重叠) / Σidf(查询)，0..1），
 * 否则退化为重叠数 / √查询大小（保持旧行为与单测兼容）。
 */
export function scoreMemory(
  m: Pick<MemoryEntry, 'body' | 'tags' | 'domain' | 'pinned' | 'hits' | 'updated'>,
  queryTokens: Set<string>,
  now: number,
  idfFn?: (t: string) => number
): number {
  let relevance: number;
  if (idfFn) {
    const mTokens = memoryTokenSet(m);
    let hit = 0, total = 0;
    for (const t of queryTokens) {
      const w = idfFn(t);
      total += w;
      if (mTokens.has(t)) hit += w;
    }
    relevance = total ? hit / total : 0;
  } else {
    const overlap = overlapCount(m, queryTokens);
    relevance = queryTokens.size ? overlap / Math.sqrt(queryTokens.size) : 0;
  }
  const ageDays = Math.max(0, (now - new Date(m.updated).getTime()) / 86400000);
  const recency = Math.exp(-ageDays / 30);
  return (m.pinned ? 1000 : 0) + m.hits * 2 + recency * 10 + relevance * 50;
}

/**
 * hits 自增（直接改文件 frontmatter 的 hits 行，避免整条重写竞态）。
 * 注意：这是「读-改-写」非原子操作 —— 多个 panel 同时检索同一批文件时可能丢失
 * 个别自增；个人规模下可接受。若用户恰好在 Obsidian 中编辑同一文件，写回可能
 * 覆盖其未保存改动（Obsidian 会检测外部变更并提示，风险可控）。
 */
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
