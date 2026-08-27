// OpenRouter embedding 探针：liquid/lfm-2.5-embedding-350m:free (1024d)
// 用法：OR_KEY=sk-... node probe-openrouter.mjs   （key 只走环境变量）
import { memories, queries } from '../../../tests/eval/dataset.mjs';

const KEY = process.env.OR_KEY;
if (!KEY) { console.error('需要 OR_KEY 环境变量'); process.exit(1); }
const MODEL = 'liquid/lfm-2.5-embedding-350m:free';

async function embedBatch(inputs) {
  const resp = await fetch('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify({ model: MODEL, input: inputs }),
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ': ' + (await resp.text()).slice(0, 200));
  const data = await resp.json();
  return data.data.map((d) => d.embedding);
}
const norm = (v) => { const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1; return v.map((x) => x / n); };
const cosine = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

const memVecs = (await embedBatch(memories.map((m) => m.body))).map(norm);
const qs = queries.filter((x) => ['q26', 'q35', 'q28', 'q17', 'q18', 'q20', 'q1', 'q33', 'q9'].includes(x.id));
for (const q of qs) {
  const [qvRaw] = await embedBatch([q.q]);
  const qvn = norm(qvRaw);
  const hits = memories.map((m, i) => ({ id: m.id, sim: cosine(qvn, memVecs[i]) })).sort((a, b) => b.sim - a.sim);
  const rank = hits.findIndex((h) => q.expect.includes(h.id));
  console.log(q.id, 'expect=' + (q.expect.join('/') || '-'), 'rank=' + rank, 'top4=' + hits.slice(0, 4).map((h) => h.id + '(' + h.sim.toFixed(3) + ')').join(' '));
}
