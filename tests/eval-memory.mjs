// Memory 检索评测 harness — 在真实代码路径上评测（OPFS 当 vault，零 LLM 调用）
//
// 指标：recall@1/@5、precision@5、MRR、拒答正确率、知识更新正确率、
//       检索延迟（p50/p95/max + 100/500/1000 条规模曲线）
// 报告：console 表格 + /tmp/memory-eval-report.json（逐 query 明细）
//
// 运行：node tests/eval-memory.cjs（需先 npm run build；headed）
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { chromium } from '/home/atituiset/.nvm/versions/node/v24.14.1/lib/node_modules/@playwright/cli/node_modules/playwright/index.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

// ---- staging：dist + manifest + icons + _locales + memory.ts 的 ESM 单文件 ----
const EXT_DIR = '/tmp/wne-ext-staging';
fs.rmSync(EXT_DIR, { recursive: true, force: true });
fs.mkdirSync(EXT_DIR, { recursive: true });
fs.cpSync(path.join(ROOT, 'dist'), EXT_DIR, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'manifest.json'), path.join(EXT_DIR, 'manifest.json'));
fs.cpSync(path.join(ROOT, 'icons'), path.join(EXT_DIR, 'icons'), { recursive: true });
fs.cpSync(path.join(ROOT, '_locales'), path.join(EXT_DIR, '_locales'), { recursive: true });
fs.mkdirSync(path.join(EXT_DIR, 'eval'), { recursive: true });
execSync(
  `npx esbuild ${path.join(ROOT, 'src/lib/memory.ts')} --bundle --format=esm --outfile=${path.join(EXT_DIR, 'eval/memory.mjs')}`,
  { stdio: 'inherit' }
);

const { memories, queries, makeNoise } = await import('./eval/dataset.mjs');

// ---- node 侧 dense ranker（Phase 3 混合召回评测；产品侧走浏览器端侧 embedding，接口一致）----
// A/B 通道：DENSE_CHANNEL=minilm（端侧，默认）| openrouter（liquid-350m，需 OR_KEY 环境变量）
const DENSE_CHANNEL = process.env.DENSE_CHANNEL || 'minilm';
const _vecCache = new Map(); // body → vector
const norm = (v) => { const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1; return v.map((x) => x / n); };

let embed;
if (DENSE_CHANNEL === 'openrouter') {
  const OR_KEY = process.env.OR_KEY;
  if (!OR_KEY) { console.error('DENSE_CHANNEL=openrouter 需要 OR_KEY 环境变量'); process.exit(2); }
  const OR_MODEL = 'liquid/lfm-2.5-embedding-350m:free';
  console.log('[dense] 通道 OpenRouter:', OR_MODEL);
  // 批量 + 429 退避：免费模型有速率限制，input 数组一次最多 50 条
  async function embedBatchApi(texts) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const resp = await fetch('https://openrouter.ai/api/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + OR_KEY },
        body: JSON.stringify({ model: OR_MODEL, input: texts }),
      });
      if (resp.ok) return (await resp.json()).data.map((d) => norm(d.embedding));
      if (resp.status === 429 && attempt < 2) {
        console.log('  [dense] 429 限流，退避重试', attempt + 1);
        await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
        continue;
      }
      throw new Error('OpenRouter embedding HTTP ' + resp.status);
    }
  }
  embed = async (text) => {
    if (_vecCache.has(text)) return _vecCache.get(text);
    const [v] = await embedBatchApi([text]);
    _vecCache.set(text, v);
    return v;
  };
  // 批量补缓存：denseRankNode 每轮先把未缓存的候选一次批量嵌入
  var prefetch = async (candidates) => {
    const missing = candidates.map((c) => c.body).filter((b) => !_vecCache.has(b));
    for (let i = 0; i < missing.length; i += 50) {
      const vecs = await embedBatchApi(missing.slice(i, i + 50));
      vecs.forEach((v, j) => _vecCache.set(missing[i + j], v));
    }
  };
} else {
  const { pipeline, env } = await import('@xenova/transformers');
  env.cacheDir = '/tmp/hf-cache';
  console.log('[dense] 通道端侧: paraphrase-multilingual-MiniLM-L12-v2');
  const embedder = await pipeline('feature-extraction', 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', { quantized: true });
  embed = async (text) => {
    if (_vecCache.has(text)) return _vecCache.get(text);
    const v = Array.from((await embedder(text, { pooling: 'mean', normalize: true })).data);
    _vecCache.set(text, v);
    return v;
  };
}

async function denseRankNode(query, candidates) {
  if (typeof prefetch === 'function') await prefetch(candidates);
  const qv = await embed(query);
  const bodyVecs = await Promise.all(candidates.map((c) => embed(c.body)));
  return candidates
    .map((c, i) => ({ file: c.file, sim: qv.reduce((s, x, j) => s + x * bodyVecs[i][j], 0) }))
    .sort((a, b) => b.sim - a.sim);
}

const LATENCY_SCALES = [100, 500, 1000];
const LATENCY_QUERIES = ['clangd 的 Protocol.h', '我的回答风格偏好', 'SQLite JSON 查询', '怎么做酸面包', 'memory hits ranking'];

(async () => {
  const ctx = await chromium.launchPersistentContext('/tmp/wne-eval-profile-' + Date.now(), {
    headless: false,
    locale: 'zh-CN',
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, '--no-first-run', '--lang=zh-CN'],
  });
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 10000 });
  const extOrigin = 'chrome-extension://' + new URL(sw.url()).host;

  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 300)));
  await page.goto(extOrigin + '/panel/panel.html');

  // 噪声在 node 侧生成（函数无法穿越 evaluate 边界），页面内按需切片
  const noiseAll = makeNoise(Math.max(...LATENCY_SCALES) - memories.length);

  if (process.env.SKIP_LATENCY === '1') await page.addInitScript(() => { globalThis.__skipLatency = true; });
  // OpenRouter 通道：预热全部向量（批量 2 次调用），评测过程零 API；
  // API 通道的延迟数据无意义（网络主导），默认跳过噪声延迟段
  if (DENSE_CHANNEL === 'openrouter') {
    console.log('[dense] 预热向量（语料+查询，批量调用）…');
    await prefetch(memories.map((m) => ({ body: m.body })));
    await prefetch(queries.map((q) => ({ body: q.q })));
    if (process.env.SKIP_LATENCY !== '0') process.env.SKIP_LATENCY = '1';
    console.log('[dense] 预热完成');
  }
  await page.exposeFunction('__denseRankNode', (q, c) => denseRankNode(q, c));

  // 注入 OPFS 当 vault + 写入语料 + 跑全部查询（全部在页面内、走真实 memory.ts 管线）
  const evalResult = await page.evaluate(async ({ memories, queries, LATENCY_SCALES, LATENCY_QUERIES, noiseAll }) => {
    // 1. IDB：建库 + OPFS root 写入 handles/vault
    await new Promise((res, rej) => {
      const req = indexedDB.open('web-notes-ext', 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('pages')) db.createObjectStore('pages', { keyPath: 'url' });
        if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' }).createIndex('url', 'url');
        if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles', { keyPath: 'name' });
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('threads')) db.createObjectStore('threads', { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt');
      };
      req.onsuccess = res; req.onerror = rej;
    });
    const opfsRoot = await navigator.storage.getDirectory();
    await new Promise((res, rej) => {
      const req = indexedDB.open('web-notes-ext', 2);
      req.onsuccess = () => {
        const t = req.result.transaction('handles', 'readwrite');
        t.objectStore('handles').put({ name: 'vault', handle: opfsRoot });
        t.oncomplete = res; t.onerror = rej;
      };
      req.onerror = rej;
    });

    const mem = await import(chrome.runtime.getURL('eval/memory.mjs'));
    mem.setDenseRanker((q, c) => window.__denseRankNode(q, c));


    // 2. 写入语料并按 daysOld 回填日期
    const dateOf = (daysOld) => new Date(Date.now() - daysOld * 86400000).toISOString().slice(0, 10);
    const fileToId = {};
    const idToFile = {};
    async function seedOne(m, id) {
      const file = await mem.saveMemory({
        scope: m.scope, body: m.body, tags: m.tags,
        confidence: m.confidence, pinned: m.pinned,
      });
      if (m.daysOld > 0) {
        const dir = await opfsRoot.getDirectoryHandle('Markpilot-Memory');
        const fh = await dir.getFileHandle(file);
        let text = await (await fh.getFile()).text();
        const d = dateOf(m.daysOld);
        text = text.replace(/^created: .*$/m, 'created: ' + d).replace(/^updated: .*$/m, 'updated: ' + d);
        const w = await fh.createWritable();
        await w.write(text);
        await w.close();
      }
      if (id) { fileToId[file] = id; idToFile[id] = file; }
    }
    for (const m of memories) await seedOne(m, m.id);

    // 3. 逐条查询（计时）
    const queryResults = [];
    for (const q of queries) {
      const t0 = performance.now();
      const { memories: hits } = await mem.searchMemories(q.q, { k: 5 });
      const ms = performance.now() - t0;
      queryResults.push({
        id: q.id, category: q.category,
        hitIds: hits.map((h) => fileToId[h.file] || h.file),
        ms,
      });
    }

    // 4. 延迟-规模曲线：注入噪声到各规模档，跑固定 query
    if (!globalThis.__skipLatency) {
    const latency = [{ scale: memories.length, results: queryResults.map((r) => r.ms) }];
    let noiseCount = 0;
    for (const scale of LATENCY_SCALES) {
      const need = scale - memories.length - noiseCount;
      if (need > 0) {
        for (const nm of noiseAll.slice(noiseCount, noiseCount + need)) await seedOne(nm, null);
        noiseCount += need;
      }
      const rs = [];
      for (const q of LATENCY_QUERIES) {
        const t0 = performance.now();
        await mem.searchMemories(q, { k: 5 });
        rs.push(performance.now() - t0);
      }
      latency.push({ scale, results: rs });
    }

    }
    return { queryResults, latency, idToFile };
  }, { memories, queries, LATENCY_SCALES, LATENCY_QUERIES, noiseAll });

  await ctx.close();

  // 调试：paraphrase 失败案例的 dense top5 相似度
  for (const q of queries.filter((x) => x.category === 'paraphrase')) {
    const hits = await denseRankNode(q.q, memories.map((m) => ({ file: m.id, body: m.body })));
    console.log(`  [dense-debug] ${q.id} expect=${q.expect.join('/')} top5=${hits.slice(0, 5).map((h) => `${h.file}(${h.sim.toFixed(3)})`).join(' ')}`);
  }

  // ---------- 指标计算（node 侧）----------
  const expectMap = Object.fromEntries(queries.map((q) => [q.id, q]));
  const ranked = evalResult.queryResults.map((r) => ({
    ...r,
    expect: expectMap[r.id].expect,
    relevant: expectMap[r.id].relevant || expectMap[r.id].expect,
    expectBefore: expectMap[r.id].expectBefore,
  }));
  const answerable = ranked.filter((r) => r.expect.length > 0);

  const recallAt = (k) =>
    answerable.filter((r) => r.hitIds.slice(0, k).some((id) => r.expect.includes(id))).length / answerable.length;
  // precision@5 口径 v2：命中 relevant（expect 的超集）/ top5 中非 pinned 席位数。
  // pinned 是设计注入（永远占一席），分母含它会结构性压低数值，无法指导优化。
  const isPinnedId = (id) => !!memories.find((m) => m.id === id && m.pinned);
  const precisionRows = answerable
    .map((r) => {
      const top5np = r.hitIds.slice(0, 5).filter((id) => !isPinnedId(id));
      if (!top5np.length) return null;
      return top5np.filter((id) => r.relevant.includes(id)).length / top5np.length;
    })
    .filter((x) => x !== null);
  const precision5 = precisionRows.reduce((a, b) => a + b, 0) / precisionRows.length;
  const mrr = answerable.reduce((acc, r) => {
    const idx = r.hitIds.findIndex((id) => r.expect.includes(id));
    return acc + (idx >= 0 ? 1 / (idx + 1) : 0);
  }, 0) / answerable.length;
  // 拒答口径：pinned 记忆永远注入是设计特性（MEMORY-DESIGN §1.4），不计入拒答失败
  const abstainQs = ranked.filter((r) => r.expect.length === 0);
  const nonPinned = (r) => r.hitIds.filter((id) => !memories.find((m) => m.id === id && m.pinned));
  const abstain = abstainQs.filter((r) => nonPinned(r).length === 0).length / abstainQs.length;
  const kuQs = ranked.filter((r) => r.expectBefore);
  const ku = kuQs.filter((r) => {
    const n = r.hitIds.indexOf(r.expectBefore.newer);
    const o = r.hitIds.indexOf(r.expectBefore.older);
    return n >= 0 && (o < 0 || n < o);
  }).length / kuQs.length;

  const pct = (arr, p) => {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(1);
  };

  // ---------- 报告 ----------
  const line = (k, v) => console.log('  ' + k.padEnd(28) + v);
  console.log('\n======== Memory 检索评测报告 ========');
  console.log(`语料 ${memories.length} 条 / 查询 ${queries.length} 条（可答 ${answerable.length} / 拒答 ${abstainQs.length}）\n`);
  line('recall@1', (recallAt(1) * 100).toFixed(1) + '%');
  line('recall@5', (recallAt(5) * 100).toFixed(1) + '%' + ``);
  line('precision@5', (precision5 * 100).toFixed(1) + '%');
  line('MRR', mrr.toFixed(3));
  line('拒答正确率', (abstain * 100).toFixed(1) + '%' + ``);
  line('知识更新正确率', (ku * 100).toFixed(1) + '%');
  console.log('\n延迟（searchMemories k=5）:');
  for (const l of evalResult.latency) {
    line(`  ${l.scale} 条规模`, `p50=${pct(l.results, 0.5)}ms  p95=${pct(l.results, 0.95)}ms  max=${Math.max(...l.results).toFixed(1)}ms`);
  }

  const byCat = {};
  for (const r of ranked) {
    byCat[r.category] = byCat[r.category] || { total: 0, hit: 0 };
    byCat[r.category].total++;
    if (r.expect.length === 0 ? nonPinned(r).length === 0 : r.hitIds.slice(0, 5).some((id) => r.expect.includes(id))) byCat[r.category].hit++;
  }
  console.log('\n分类明细:');
  for (const [c, v] of Object.entries(byCat)) line('  ' + c, `${v.hit}/${v.total}`);
  console.log('\n失败 query 明细（拒答类已排除 pinned）:');
  for (const r of ranked) {
    const ok = r.expect.length === 0 ? nonPinned(r).length === 0 : r.hitIds.slice(0, 5).some((id) => r.expect.includes(id));
    if (!ok) console.log(`  ${r.id} [${r.category}] expect=${JSON.stringify(r.expect)} got=${JSON.stringify(r.hitIds)}`);
  }

  fs.writeFileSync('/tmp/memory-eval-report.json', JSON.stringify({
    ts: new Date().toISOString(),
    corpus: memories.length,
    metrics: {
      recall1: recallAt(1), recall5: recallAt(5), precision5, mrr,
      abstain, knowledgeUpdate: ku,
      latency: evalResult.latency.map((l) => ({
        scale: l.scale,
        p50: +pct(l.results, 0.5), p95: +pct(l.results, 0.95), max: +Math.max(...l.results).toFixed(1),
      })),
    },
    queries: ranked,
  }, null, 2));
  console.log('\n明细报告: /tmp/memory-eval-report.json');

  // 基线对比：node tests/eval-memory.mjs --write-baseline 记录基线；之后自动做回归对比
  const BASELINE = path.join(ROOT, 'tests/eval/baseline.json');
  const METRIC_VERSION = 2; // v2: precision@5 分母排除 pinned、分子用 relevant 标注
  const metricsNow = { metricVersion: METRIC_VERSION, recall1: recallAt(1), recall5: recallAt(5), precision5, mrr, abstain, knowledgeUpdate: ku };
  if (process.argv.includes('--write-baseline')) {
    fs.writeFileSync(BASELINE, JSON.stringify(metricsNow, null, 2));
    console.log('\n基线已写入 tests/eval/baseline.json');
    process.exit(0);
  }
  let pass = true;
  if (fs.existsSync(BASELINE)) {
    const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
    if ((base.metricVersion || 1) !== METRIC_VERSION) {
      console.log(`\n基线口径过旧（metricVersion ${base.metricVersion || 1} ≠ ${METRIC_VERSION}），请先 --write-baseline 重记`);
      process.exit(2);
    }
    console.log('\n对比基线:');
    for (const [k, v] of Object.entries(metricsNow)) {
      if (k === 'metricVersion') continue;
      const b = base[k] ?? 0;
      const d = v - b;
      const flag = d < -0.01 ? ' ← 回归!' : '';
      if (d < -0.01) pass = false;
      line('  ' + k, `${(v * 100).toFixed(1)}%  (基线 ${(b * 100).toFixed(1)}%, ${d >= 0 ? '+' : ''}${(d * 100).toFixed(1)}%)${flag}`);
    }
  } else {
    console.log('\n（无基线，--write-baseline 可记录）');
  }
  console.log(`\n== ${pass ? 'PASS' : 'FAIL'}${fs.existsSync(BASELINE) ? '（基线回归对比）' : ''} ==`);
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('ERR:', e); process.exit(2); });
