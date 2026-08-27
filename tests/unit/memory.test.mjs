// 记忆纯函数单测（node:test + esbuild bundle 后运行）
// 运行方式: npm test （见 package.json，走 build.mjs 里的 test 步骤或直接 node --test）
import assert from 'node:assert';
import { test } from 'node:test';
import { tokenize, scoreMemory, isCold, overlapCount, bodySimilarity, enrichBody, naiveStem, fuseWeighted, DENSE_SIM_FLOOR, DENSE_GAIN, DENSE_TOP_N } from '../../src/lib/memory.js';
import { shouldIgnore, guessTags } from '../../src/lib/memory-extract.js';
import { parseFrontmatter } from '../../src/lib/markdown.js';

test('tokenize: english words', () => {
  const t = tokenize('clangd protocol header file');
  assert.ok(t.includes('clangd'));
  assert.ok(t.includes('protocol'));
});

test('tokenize: chinese bigrams', () => {
  const t = tokenize('用户偏好简洁回答');
  assert.ok(t.length > 0);
  assert.ok(t.includes('用户'));
  assert.ok(t.includes('偏好'));
});

test('scoreMemory: pinned beats relevance', () => {
  const now = Date.now();
  const pinned = { body: '完全无关的内容 xyz', tags: [], domain: undefined, pinned: true, hits: 0, updated: new Date(now - 100 * 86400000).toISOString() };
  const relevant = { body: '用户喜欢简洁的 clangd 回答', tags: ['preference'], domain: 'clangd', pinned: false, hits: 3, updated: new Date(now).toISOString() };
  const q = new Set(tokenize('clangd 简洁'));
  assert.ok(scoreMemory(pinned, q, now) > scoreMemory(relevant, q, now));
});

test('scoreMemory: relevance ranks higher than irrelevant', () => {
  const now = Date.now();
  const a = { body: '用户偏好中文回答', tags: ['preference'], domain: undefined, pinned: false, hits: 0, updated: new Date(now).toISOString() };
  const b = { body: '完全不相关的一条旧记录', tags: [], domain: undefined, pinned: false, hits: 0, updated: new Date(now).toISOString() };
  const q = new Set(tokenize('偏好 中文'));
  assert.ok(scoreMemory(a, q, now) > scoreMemory(b, q, now));
});

test('isCold logic', () => {
  const old = { type: 'memory', scope: 'user', created: '', updated: new Date(Date.now() - 120 * 86400000).toISOString(), confidence: 'medium', pinned: false, hits: 0, tags: [], file: 'a.md', body: 'x' };
  const recent = { ...old, updated: new Date().toISOString() };
  const pinned = { ...old, pinned: true };
  const used = { ...old, hits: 2 };
  assert.ok(isCold(old));
  assert.ok(!isCold(recent));
  assert.ok(!isCold(pinned));
  assert.ok(!isCold(used));
});

test('shouldIgnore: greetings & empty', () => {
  assert.ok(shouldIgnore('你好', '你好！有什么可以帮你？'));
  assert.ok(shouldIgnore('hi', 'hello'));
  assert.ok(shouldIgnore('任意问题', ''));
  assert.ok(!shouldIgnore('clangd 的 Protocol.h 结构是什么', '它定义了 LSP 数据结构…'));
});

test('guessTags heuristics', () => {
  assert.ok(guessTags('我喜欢简洁的回答').includes('preference'));
  assert.ok(guessTags('我之前理解错了，正确的是X').includes('correction'));
  assert.ok(guessTags('这个协议的结论是Y').includes('conclusion'));
});

test('guessTags: english patterns', () => {
  assert.ok(guessTags('I prefer concise answers').includes('preference'));
  assert.ok(guessTags('I was wrong, the correct answer is X').includes('correction'));
  assert.ok(guessTags('Therefore the protocol is Y').includes('conclusion'));
});

// 回归：记忆文件的 YAML 列表（tags）必须能被解析回来 —— 曾全部丢成 []
test('parseFrontmatter: YAML 列表 tags 往返', () => {
  const text = [
    '---',
    'type: memory',
    'scope: user',
    'created: 2026-08-25',
    'updated: ' + new Date().toISOString().slice(0, 10),
    'confidence: high',
    'pinned: false',
    'hits: 3',
    'tags:',
    '  - fact',
    '  - preference',
    '---',
    '',
    '用户偏好简洁回答。',
    '',
  ].join('\n');
  const { attrs, body } = parseFrontmatter(text);
  assert.deepEqual(attrs.tags, ['fact', 'preference']);
  assert.equal(attrs.type, 'memory');
  assert.equal(Number(attrs.hits), 3);
  assert.ok(body.includes('用户偏好简洁回答'));
  // 空列表写法 tags: [] 不报错
  const empty = parseFrontmatter('---\ntags: []\n---\nx');
  assert.ok(!Array.isArray(empty.attrs.tags));
});

test('overlapCount: tags 参与检索（tags 丢失曾导致此项恒为 0）', () => {
  const m = { body: '一条没有关键词的正文', tags: ['clangd', 'preference'], domain: undefined };
  assert.ok(overlapCount(m, new Set(tokenize('clangd'))) > 0);
  assert.equal(overlapCount(m, new Set(tokenize('xyzzy'))), 0);
});

test('bodySimilarity: 复述高分 / 无关零分', () => {
  assert.ok(bodySimilarity('用户偏好简洁的中文回答', '用户偏好简洁的中文回答') === 1);
  assert.ok(bodySimilarity('用户偏好简洁的中文回答', '用户偏好简洁中文回答风格') > 0.7);
  assert.equal(bodySimilarity('用户偏好简洁回答', 'clangd 的 Protocol.h 定义 LSP 结构'), 0);
  assert.equal(bodySimilarity('', '任意内容'), 0);
});

test('enrichBody: 全覆盖不追加 / 有新信息才追加', () => {
  const old = '用户偏好简洁的中文回答';
  const dup = enrichBody(old, '偏好简洁的中文回答'); // 子串，bigram 全覆盖
  assert.equal(dup.novel, false);
  assert.equal(dup.body, old);
  const add = enrichBody(old, '代码注释希望保留英文原文'); // 有新信息
  assert.equal(add.novel, true);
  assert.ok(add.body.includes('用户偏好简洁'));
  assert.ok(add.body.includes('英文原文'));
});

test('tokenize: 英文停用词被过滤', () => {
  const t = tokenize('the query is querying the json');
  assert.ok(!t.includes('the'));
  assert.ok(!t.includes('is'));
  assert.ok(t.includes('query'));
  assert.ok(t.includes('json'));
});

test('naiveStem: 词形归一对齐（评测发现 #1）', () => {
  assert.equal(naiveStem('querying'), 'query');
  assert.equal(naiveStem('functions'), 'function');
  assert.equal(naiveStem('json1'), 'json');
  assert.equal(naiveStem('needed'), 'need');
  // 查询与记忆两侧一致应用后能对齐
  assert.deepEqual(tokenize('querying'), tokenize('query'));
  assert.ok(tokenize('json1 functions').includes('json'));
});

test('scoreMemory: IDF 加权下稀有 token 得分更高', () => {
  const now = Date.now();
  const m = { body: 'sqlite json 查询', tags: [], domain: undefined, pinned: false, hits: 0, updated: new Date(now).toISOString() };
  const df = { sqlite: 1, json: 1, 模型: 40 }; // 模型在 40 条语料里出现 = 高频
  const idf = (t) => Math.log(1 + 40 / (df[t] || 1));
  const rare = scoreMemory(m, new Set(['sqlite']), now, idf);
  const common = scoreMemory(m, new Set(['模型']), now, idf);
  assert.ok(rare > common);
});

test('fuseWeighted: 真空门控融合 — 词面真空时 dense 主导，词面强时 dense 仅确认', () => {
  const mk = (file, pinned = false) => ({ type: 'memory', scope: 'user', created: '', updated: '', confidence: 'medium', pinned, hits: 0, tags: [], file, body: file });
  const dense = new Map([['c.md', 0.5], ['b.md', 0.45]]);
  // 场景1：词面真空（maxSparse 小）→ dense top1 的 c 得满分增益，压过弱词面
  const vacuumSet = fuseWeighted(
    [{ m: mk('a.md'), score: 8, overlap: 1 }, { m: mk('b.md'), score: 6, overlap: 1 }, { m: mk('c.md'), score: 1, overlap: 0 }, { m: mk('pin.md', true), score: 0, overlap: 0 }, { m: mk('d.md'), score: 0, overlap: 0 }],
    dense
  );
  const f1 = vacuumSet.map((x) => x.m.file);
  assert.equal(f1[0], 'pin.md');
  assert.equal(f1[1], 'c.md'); // 真空下 dense top1 排最前（ pinned 除外）
  assert.ok(!f1.includes('d.md'));
  // 场景2：词面证据强（maxSparse 大）→ 真空度低，dense 压不过强词面
  const strongSet = fuseWeighted(
    [{ m: mk('a.md'), score: 60, overlap: 3 }, { m: mk('b.md'), score: 6, overlap: 1 }, { m: mk('c.md'), score: 1, overlap: 0 }],
    dense
  );
  const f2 = strongSet.map((x) => x.m.file);
  assert.equal(f2[0], 'a.md'); // 强词面保持第一
  assert.ok(f2.indexOf('a.md') < f2.indexOf('c.md'));
});
  const scored = [
    { m: mk('a.md'), score: 10, overlap: 1 },
    { m: mk('b.md'), score: 8, overlap: 1 },
    { m: mk('c.md'), score: 1, overlap: 0 },  // 词面零重叠，dense 独有
    { m: mk('pin.md', true), score: 0, overlap: 0 },
    { m: mk('d.md'), score: 0, overlap: 0 },  // 两边都无 → 不进候选
  ];
  const denseSim = new Map([
    ['c.md', DENSE_SIM_FLOOR + 0.2],  // bonus = 0.2*100*W = 20
    ['b.md', DENSE_SIM_FLOOR + 0.05], // bonus = 5
  ]);
  const fused = fuseWeighted(scored, denseSim);
  const files = fused.map((x) => x.m.file);
  assert.equal(files[0], 'pin.md');           // pinned 强制置顶
  assert.ok(files.includes('c.md'));           // dense 独有召回
  assert.ok(!files.includes('d.md'));          // 两边都无，不注入
  // b: 8 + 5 = 13 > a: 10（dense 加分改变次序）
  assert.ok(files.indexOf('b.md') < files.indexOf('a.md'));
  const c = fused.find((x) => x.m.file === 'c.md');
  assert.ok(Math.abs(c.final - (1 + DENSE_WEIGHT * 0.2 * 100)) < 1e-9);
  // 期望次序：pin(1e9) > c(1+20=21) > b(8+5=13) > a(10)——dense 加分可让语义强命中压过弱词面
  assert.deepEqual(files, ['pin.md', 'c.md', 'b.md', 'a.md']);
});
