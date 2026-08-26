// chat-pipeline / llm 纯函数单测（node:test + esbuild bundle）
// 覆盖: buildContext 材料注入、reasoning SSE 解析、模型别名/排序/模糊匹配
import assert from 'node:assert';
import { test } from 'node:test';

// ---- buildContext: 材料组装 ----
const { buildContext } = await import('../../src/lib/llm/context.js');

test('buildContext: pageText 注入【页面正文】', () => {
  const { messages } = buildContext({
    question: '总结',
    pageText: '# 标题\n这是正文内容，足够长的一段话用来测试提取是否进入上下文。',
    notes: [],
    selection: null,
  });
  const user = messages[1].content;
  assert.ok(user.includes('【页面正文】'));
  assert.ok(user.includes('这是正文内容'));
  assert.ok(user.includes('总结'));
});

test('buildContext: pageText 为 null 时无【页面正文】段（空材料场景）', () => {
  const { messages } = buildContext({ question: 'q', pageText: null, notes: [], selection: null });
  assert.ok(!messages[1].content.includes('【页面正文】'));
});

test('buildContext: notes 与 selection 均注入', () => {
  const { messages } = buildContext({
    question: 'q',
    pageText: null,
    notes: [{ content: '我的笔记内容', kind: 'note' }],
    selection: '选中的原文片段',
  });
  const user = messages[1].content;
  assert.ok(user.includes('【用户在该页的笔记】'));
  assert.ok(user.includes('我的笔记内容'));
  assert.ok(user.includes('【选中原文】'));
  assert.ok(user.includes('选中的原文片段'));
});

test('buildContext: 超长 pageText 头尾保留并标注省略', () => {
  const longText = 'A'.repeat(100000);
  const { messages } = buildContext({ question: 'q', pageText: longText, notes: [], selection: null });
  assert.ok(messages[1].content.includes('[……中间内容因长度限制省略……]'));
  assert.ok(messages[1].content.length < longText.length);
});

// ---- streamChat reasoning 解析：模拟 SSE 流 ----
globalThis.fetch = async () => ({
  ok: true,
  body: {
    getReader: () => {
      const chunks = [
        'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"思考A"}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"思考B"}}]}\n\ndata: {"choices":[{"delta":{"content":"答案"}}]}\n\n',
        'data: [DONE]\n\n',
      ];
      let i = 0;
      return {
        read: async () =>
          i < chunks.length
            ? { done: false, value: new TextEncoder().encode(chunks[i++]) }
            : { done: true, value: undefined },
      };
    },
  },
  text: async () => '',
});

const { streamChat } = await import('../../src/lib/llm/index.js');

test('streamChat: delta.reasoning_content 单独回调，不混入 text', async () => {
  const tokens = [];
  const reasonings = [];
  const r = await streamChat({
    settings: { provider: 'opencode', model: 'hy3-free' },
    messages: [{ role: 'user', content: 'hi' }],
    onToken: (t) => tokens.push(t),
    onReasoning: (t) => reasonings.push(t),
  });
  assert.deepStrictEqual(tokens, ['答案']);
  assert.strictEqual(r.text, '答案');
  assert.strictEqual(r.reasoning, '思考A思考B');
  assert.deepStrictEqual(reasonings, ['思考A', '思考B']);
});
