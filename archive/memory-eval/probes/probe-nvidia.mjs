// NVIDIA NIM embedding 探针（多模型对照难例集）
// 用法：NV_KEY=nvapi-... node probe-nvidia.mjs [model1,model2,...]   （key 只走环境变量）
import { memories, queries } from '../../../tests/eval/dataset.mjs';

const KEY = process.env.NV_KEY;
if (!KEY) { console.error('需要 NV_KEY 环境变量'); process.exit(1); }
const MODELS = (process.argv[2] || 'nvidia/llama-3.2-nv-embedqa-1b-v1,nvidia/nemotron-3-embed-1b,nvidia/nv-embedqa-mistral-7b-v2').split(',');

async function embedBatch(model, inputs, inputType) {
  const resp = await fetch('https://integrate.api.nvidia.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify({ model, input: inputs, input_type: inputType, encoding_format: 'float' }),
  });
  if (!resp.ok) throw new Error(model + ' HTTP ' + resp.status + ': ' + (await resp.text()).slice(0, 150));
  return (await resp.json()).data.map((d) => d.embedding);
}
const norm = (v) => { const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1; return v.map((x) => x / n); };
const cosine = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

const qs = queries.filter((x) => ['q26', 'q35', 'q28', 'q33', 'q17', 'q18', 'q20', 'q1', 'q9'].includes(x.id));
for (const model of MODELS) {
  console.log('==', model);
  try {
    const memVecs = (await embedBatch(model, memories.map((m) => m.body), 'passage')).map(norm);
    for (const q of qs) {
      const [qv] = (await embedBatch(model, [q.q], 'query')).map(norm);
      const hits = memories.map((m, i) => ({ id: m.id, sim: cosine(qv, memVecs[i]) })).sort((a, b) => b.sim - a.sim);
      const rank = hits.findIndex((h) => q.expect.includes(h.id));
      console.log('  ' + q.id, 'expect=' + (q.expect.join('/') || '-'), 'rank=' + rank, 'top3=' + hits.slice(0, 3).map((h) => h.id + '(' + h.sim.toFixed(3) + ')').join(' '));
    }
  } catch (e) { console.log('  ERR:', e.message.slice(0, 120)); }
}
