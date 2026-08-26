// 模型选择器纯函数单测：别名匹配 / 排序（免费优先、新模型靠前）/ 模糊匹配
// 从 options.ts 抽出的逻辑以源码内联复制方式测试核心算法，防止回归
import assert from 'node:assert';
import { test } from 'node:test';

// 与 src/options/options.ts 保持一致的三个函数（若改动需同步）
function fuzzyMatch(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let i = 0;
  for (const ch of q) {
    i = t.indexOf(ch, i);
    if (i < 0) return false;
    i++;
  }
  return true;
}

const MODEL_ALIASES = {
  'x-preview-f-free': 'ox alpha free stealth',
};

function sortModels(models) {
  const recencyRe = /(gpt-5|claude-(opus-4|sonnet-4|haiku-4)|gemini-2|glm-5|glm-4\.?[6-9]|deepseek-v[3-9]|deepseek-r\d|qwen-?max|qwen3|kimi-k?\d|moonshot-v1-128|llama-?[4-9]|mistral-large|nemotron-[3-9])/i;
  return [...models].sort((a, b) => {
    if (a.free !== b.free) return a.free ? -1 : 1;
    const ra = recencyRe.test(a.id) ? 0 : 1;
    const rb = recencyRe.test(b.id) ? 0 : 1;
    if (ra !== rb) return ra - rb;
    return a.id.localeCompare(b.id);
  });
}

function matchModel(query, m) {
  const alias = MODEL_ALIASES[m.id] || '';
  return fuzzyMatch(query, m.id) || (alias ? fuzzyMatch(query, alias) : false);
}

test('fuzzyMatch: 子序列命中', () => {
  assert.ok(fuzzyMatch('mimo', 'mimo-v2.5-free'));
  assert.ok(fuzzyMatch('m25', 'mimo-v2.5-free'));
  assert.ok(!fuzzyMatch('xyz', 'mimo-v2.5-free'));
});

test('matchModel: 别名 "ox alpha" 命中 x-preview-f-free', () => {
  const m = { id: 'x-preview-f-free', free: true };
  assert.ok(matchModel('ox alpha', m));
  assert.ok(matchModel('oxalpha', m)); // 无空格子序列也命中
  assert.ok(matchModel('stealth', m));
});

test('sortModels: 免费模型排在最前', () => {
  const sorted = sortModels([
    { id: 'gpt-5.6-sol', free: false },
    { id: 'hy3-free', free: true },
    { id: 'claude-opus-5', free: false },
    { id: 'mimo-v2.5-free', free: true },
  ]);
  // 免费 → 新一代(gpt-5/claude-4+ 均命中 recency，按字母序) 
  assert.deepStrictEqual(sorted.map((m) => m.id), ['hy3-free', 'mimo-v2.5-free', 'gpt-5.6-sol', 'claude-opus-5']);
});

test('sortModels: 同为付费时新一代模型靠前', () => {
  const sorted = sortModels([
    { id: 'glm-4-air', free: false },
    { id: 'glm-5', free: false },
    { id: 'deepseek-chat', free: false },
  ]);
  assert.strictEqual(sorted[0].id, 'glm-5');
});
