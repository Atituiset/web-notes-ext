// 记忆功能 E2E：真实调用 DeepSeek 验证「压缩→寒暄忽略→记忆注入引用」闭环
// 运行: source ~/.hermes/.env 后 node tests/e2e-memory.mjs
const KEY = process.env.DEEPSEEK_API_KEY;
if (!KEY) { console.error('需要 DEEPSEEK_API_KEY'); process.exit(1); }

const MODEL = 'deepseek-chat';

async function chat(messages) {
  const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: 200 }),
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ': ' + (await resp.text()).slice(0, 200));
  const data = await resp.json();
  return data.choices[0].message.content;
}

let pass = 0, fail = 0;
function check(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name);
  cond ? pass++ : fail++;
}

const SYS = '你是记忆压缩器。从问答对中提炼值得跨会话记住的结论/偏好/事实，输出1-2句中文陈述句。只输出内容本身，不要任何前缀或解释。若无值得记的内容，只输出 NONE。';

// 1. 正常压缩
const qa = {
  q: 'clangd 的 Protocol.h 是干什么的？我该重点关注哪些部分？',
  a: 'Protocol.h 定义了 clangd 的 LSP 协议 C++ 数据结构。重点看 Position/Range/TextEdit 三件套的 fromJSON/toJSON 映射，这是所有 LSP 功能的基础。',
};
const compressed = (await chat([
  { role: 'system', content: SYS },
  { role: 'user', content: `Q: ${qa.q}\n\nA: ${qa.a}` },
])).trim();
console.log('压缩结果:', compressed);
check('压缩产出非空且非 NONE', compressed && !/^none$/i.test(compressed));

// 2. 寒暄 → NONE
const noneResp = (await chat([
  { role: 'system', content: SYS },
  { role: 'user', content: 'Q: 你好\n\nA: 你好！有什么可以帮你？' },
])).trim();
console.log('寒暄结果:', noneResp.slice(0, 30));
check('寒暄被忽略(NONE)', /^none$/i.test(noneResp));

// 3. 记忆注入后回答引用记忆
const memoryMd = `- (fact) ${compressed}`;
const answer = (await chat([
  { role: 'user', content: `【用户长期记忆】\n${memoryMd}\n\n以上是用户过往的记忆，回答时请衔接这些背景。\n\n【问题】\n我在读 clangd 源码，应该先从哪个文件入手？` },
])).trim();
console.log('\n注入记忆后的回答:\n' + answer.slice(0, 250));
check('回答引用了记忆中的 Protocol.h', /protocol\.h/i.test(answer));
check('回答衔接了 Position/Range/TextEdit', /position|range|textedit/i.test(answer));

// 4. 偏好类记忆影响行为
const prefCompressed = (await chat([
  { role: 'system', content: SYS },
  { role: 'user', content: 'Q: 以后回答我尽量用英文术语、中文解释\n\nA: 好的，之后我会用英文术语加中文解释的方式回答你。' },
])).trim();
const prefAnswer = (await chat([
  { role: 'user', content: `【用户长期记忆】\n- (preference) ${prefCompressed}\n\n【问题】\n解释一下什么是 LSP？` },
])).trim();
console.log('\n偏好注入后的回答:\n' + prefAnswer.slice(0, 200));
check('偏好生效（含英文术语）', /language server protocol|lsp/i.test(prefAnswer));

console.log(`\n== ${pass}/${pass + fail} passed ==`);
process.exit(fail ? 1 : 0);
