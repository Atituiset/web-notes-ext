// embedding 探针：paraphrase-multilingual-MiniLM-L12-v2 对评测集 paraphrase 失败对的区分度
// 直接复用 tests/eval/dataset.mjs —— 每条 paraphrase 查询，期望记忆在全部 40 条中的余弦排名
import { pipeline } from '@xenova/transformers';
import { memories, queries } from '../../../tests/eval/dataset.mjs';

const MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';

const embed = await pipeline('feature-extraction', MODEL, { quantized: true });

const texts = memories.map((m) => m.body);
const embs = [];
for (const t of texts) {
  const out = await embed(t, { pooling: 'mean', normalize: true });
  embs.push(Array.from(out.data));
}
const cosine = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

const paraphraseQueries = queries.filter((q) => q.category === 'paraphrase');
let top1 = 0, top5 = 0;
for (const q of paraphraseQueries) {
  const qe = Array.from((await embed(q.q, { pooling: 'mean', normalize: true })).data);
  const ranked = memories
    .map((m, i) => ({ id: m.id, sim: cosine(qe, embs[i]) }))
    .sort((a, b) => b.sim - a.sim);
  const hitRank = ranked.findIndex((r) => q.expect.includes(r.id));
  const ok5 = hitRank >= 0 && hitRank < 5;
  if (hitRank === 0) top1++;
  if (ok5) top5++;
  console.log(
    `${q.id} expect=${q.expect.join('/')} → rank=${hitRank} ${ok5 ? '✓' : '✗'}  top3=${ranked.slice(0, 3).map((r) => `${r.id}(${r.sim.toFixed(2)})`).join(' ')}`
  );
}
console.log(`\nparaphrase 子集: top1=${top1}/${paraphraseQueries.length}  top5=${top5}/${paraphraseQueries.length}`);
