/**
 * 语义召回（dense embedding）通道抽象 —— 产品侧实现。
 *
 * 设计（与评测环境同一接口，见 docs/plans/memory-opt-roadmap.md）：
 *   - 稠密排序经 setDenseRanker 注入 memory.ts，本模块只负责「怎么算向量」
 *   - 三通道优先级：nvidia（BYOK 效果最优）> local（端侧零成本零外传，默认）
 *     > openrouter（BYOK 备选）；off = 关闭（词法单路）
 *   - 向量缓存进 IndexedDB embeddings store，键 = `${model}|${type}|${hash(body)}`
 *     —— e5 系模型（nvidia）query/passage 非对称，键必须带类型（踩坑记录见 MEMORY-EVAL §8）
 *   - local 通道：transformers.js 预构建 ESM（dist/lib/transformers.js）+
 *     本包内 wasm（dist/lib/wasm/），模型运行时从 HuggingFace 下载（数据非代码）
 *
 * 面板启动时 initEmbedding(settings) 一次性接线；失败静默降级为词法单路。
 */

import { setDenseRanker, setDenseSimFloor } from './memory.js';
import { idbGet, idbPut } from './db.js';

export type EmbedFn = (texts: string[], type: 'query' | 'passage') => Promise<number[][]>;

const LOCAL_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';

const CHANNEL_FLOOR: Record<string, number> = {
  local: 0.33, // MiniLM 判别力下的实测最优（roadmap Phase 3/4）
  nvidia: 0.2, // nemotron-3-embed 噪声上限 0.147，安全边际完整
  openrouter: 0.33,
};

// ---------- 向量缓存 ----------

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function cosine(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

const norm = (v: number[]) => {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
};

// ---------- 通道实现 ----------

async function localEmbedder(): Promise<{ embed: EmbedFn; model: string }> {
  const mod: any = await import(chrome.runtime.getURL('lib/transformers.js'));
  mod.env.allowLocalModels = false;
  // wasm 在扩展包内（构建时拷自 onnxruntime-web），不走 CDN（MV3 CSP 禁远程代码）
  mod.env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('lib/wasm/');
  mod.env.backends.onnx.wasm.numThreads = 1; // 单线程：线程后端要起 blob worker，受扩展页 CSP 限制
  const pipe = await mod.pipeline('feature-extraction', LOCAL_MODEL, { quantized: true });
  return {
    model: LOCAL_MODEL,
    embed: async (texts) => {
      const out: number[][] = [];
      for (const t of texts) {
        const r = await pipe(t, { pooling: 'mean', normalize: true });
        out.push(Array.from(r.data));
      }
      return out;
    },
  };
}

function nvidiaEmbedder(apiKey: string): { embed: EmbedFn; model: string } {
  const model = 'nvidia/nemotron-3-embed-1b';
  return {
    model,
    embed: async (texts, type) => {
      const resp = await fetch('https://integrate.api.nvidia.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        body: JSON.stringify({ model, input: texts, input_type: type, encoding_format: 'float' }),
      });
      if (!resp.ok) throw new Error('NVIDIA embedding HTTP ' + resp.status);
      return (await resp.json()).data.map((d: any) => norm(d.embedding));
    },
  };
}

function openrouterEmbedder(apiKey: string): { embed: EmbedFn; model: string } {
  const model = 'liquid/lfm-2.5-embedding-350m:free';
  return {
    model,
    embed: async (texts) => {
      const resp = await fetch('https://openrouter.ai/api/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        body: JSON.stringify({ model, input: texts }),
      });
      if (!resp.ok) throw new Error('OpenRouter embedding HTTP ' + resp.status);
      return (await resp.json()).data.map((d: any) => norm(d.embedding));
    },
  };
}

// ---------- 对外：初始化与接线 ----------

let _embed: EmbedFn | null = null;
let _modelTag = '';

/**
 * 按设置初始化语义召回并接线到 searchMemories。
 * @returns 实际生效的通道（'off' = 未启用或初始化失败降级）
 */
export async function initEmbedding(settings: any): Promise<string> {
  const channel = settings.semanticRecall || 'off';
  if (channel === 'off') {
    setDenseRanker(null);
    return 'off';
  }
  try {
    let impl: { embed: EmbedFn; model: string };
    if (channel === 'local') impl = await localEmbedder();
    else if (channel === 'nvidia') impl = nvidiaEmbedder(settings.embedApiKey || '');
    else if (channel === 'openrouter') impl = openrouterEmbedder(settings.embedApiKey || '');
    else return 'off';
    if (channel !== 'local' && !settings.embedApiKey) return 'off';

    _embed = impl.embed;
    _modelTag = impl.model;
    setDenseSimFloor(CHANNEL_FLOOR[channel] ?? 0.33);
    setDenseRanker(denseRank);
    return channel;
  } catch (e: any) {
    console.warn('[embedding] 初始化失败，降级为词法单路:', e && e.message || e);
    setDenseRanker(null);
    return 'off';
  }
}

async function embedCached(texts: string[], type: 'query' | 'passage'): Promise<number[][]> {
  const out: (number[] | null)[] = [];
  const missingIdx: number[] = [];
  for (let i = 0; i < texts.length; i++) {
    const key = `${_modelTag}|${type}|${hash(texts[i])}`;
    const cached = await idbGet('embeddings', key).catch(() => null);
    if (cached) out.push(cached);
    else {
      out.push(null);
      missingIdx.push(i);
    }
  }
  for (let i = 0; i < missingIdx.length; i += 50) {
    const idxs = missingIdx.slice(i, i + 50);
    const vecs = await _embed!(idxs.map((j) => texts[j]), type);
    for (let k = 0; k < idxs.length; k++) {
      const j = idxs[k];
      out[j] = vecs[k];
      idbPut('embeddings', `${_modelTag}|${type}|${hash(texts[j])}`, vecs[k]).catch(() => {});
    }
  }
  return out as number[][];
}

/** 注入 memory.ts 的稠密排序器（与评测接口一致）；导出便于测试直调 */
export async function denseRank(query: string, candidates: { file: string; body: string }[]) {
  const [qv] = await embedCached([query], 'query');
  const bodyVecs = await embedCached(candidates.map((c) => c.body), 'passage');
  return candidates
    .map((c, i) => ({ file: c.file, sim: cosine(qv, bodyVecs[i]) }))
    .sort((a, b) => b.sim - a.sim);
}
