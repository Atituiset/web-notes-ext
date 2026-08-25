// OpenCode 免费模型 E2E：验证插件对 opencode.ai/zen/v1 的完整调用链
// 模拟 panel.ts 的真实路径: streamChat(压缩) + buildContext(注入) + streamChat(回答)
const BASE = 'https://opencode.ai/zen/v1';
const MODEL = 'nemotron-3.5-lightning-free';

async function streamChat(messages, onToken) {
  const resp = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }, // 无 key — 零配置验证
    body: JSON.stringify({ model: MODEL, messages, max_tokens: 2000, stream: true }),
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ': ' + (await resp.text()).slice(0, 150));
  // SSE 解析（复刻 src/lib/llm/index.ts 的 consumeSSE）
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const d = JSON.parse(payload);
        const delta = d.choices?.[0]?.delta || {};
        // 推理模型: content 可能在 reasoning_content/reasoning；普通模型: content
        const tok = delta.content ?? delta.reasoning_content ?? delta.reasoning ?? '';
        if (tok) { full += tok; if (onToken) onToken(tok); }
      } catch {}
    }
  }
  return full;
}

const SYS = '你是记忆压缩器。从问答对中提炼值得跨会话记住的结论/偏好/事实，输出1-2句中文陈述句。只输出内容本身，不要任何前缀或解释。若无值得记的内容，只输出 NONE。';

let pass = 0, fail = 0;
const check = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' | ' + n); c ? pass++ : fail++; };

// 1. 流式压缩
console.log('模型:', MODEL, '(无 key 零配置)');
const compressed = await streamChat([
  { role: 'system', content: SYS },
  { role: 'user', content: 'Q: clangd 的 Protocol.h 是干什么的？\n\nA: 它定义了 clangd 的 LSP 协议 C++ 数据结构，重点是 Position/Range/TextEdit 的 JSON 映射。' },
], (t) => process.stdout.write(t));
console.log('\n压缩结果:', compressed.trim());
check('流式压缩成功', compressed.trim().length > 5);

// 2. 寒暄忽略
const none = await streamChat([
  { role: 'system', content: SYS },
  { role: 'user', content: 'Q: 你好\n\nA: 你好！' },
]);
check('寒暄忽略', /none/i.test(none.trim()) || none.trim().length < 4);

// 3. 记忆注入后回答引用
const answer = await streamChat([
  { role: 'user', content: `【用户长期记忆】\n- (fact) ${compressed.trim()}\n\n以上是用户过往的记忆，回答时请衔接这些背景。\n\n【问题】\nclangd 源码该从哪读起？` },
]);
console.log('\n注入后回答:', answer.replace(/\s+/g, ' ').slice(0, 180));
check('回答引用记忆 (Protocol.h)', /protocol\.h/i.test(answer));

console.log(`\n== ${pass}/${pass + fail} passed (${MODEL}, zero-config) ==`);
process.exit(fail ? 1 : 0);
