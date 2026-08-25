/**
 * Provider 抽象 + SSE 流式解析
 *
 * 统一接口: streamChat({ settings, messages, onToken }) -> Promise<{text}>
 * - openai-compatible / openrouter / ollama: OpenAI chat completions 格式
 *   (ollama 跑在 http://localhost:11434/v1)
 * - anthropic: 顶层 system 字段、max_tokens 必填、
 *   header 'anthropic-dangerous-direct-browser-access': 'true'
 *
 * 设计说明（DESIGN.md 坑 #3）：fetch+SSE 解析放在 panel 页面侧执行，
 * 不经过 service worker，规避 MV3 SW 休眠打断长流。
 */

export const PROVIDERS = {
  'openai-compatible': { label: 'OpenAI 兼容 (含 Ollama/vLLM)', needsKey: false },
  openrouter: { label: 'OpenRouter', needsKey: true },
  anthropic: { label: 'Anthropic', needsKey: true },
};

function endpointFor(settings) {
  if (settings.provider === 'ollama') return 'http://localhost:11434/v1/chat/completions';
  if (settings.provider === 'anthropic') return 'https://api.anthropic.com/v1/messages';
  if (settings.provider === 'openrouter') return 'https://openrouter.ai/api/v1/chat/completions';
  // openai-compatible：用户自定义 baseUrl（默认 Ollama）
  const base = (settings.baseUrl || 'http://localhost:11434/v1').replace(/\/+$/, '');
  return base + '/chat/completions';
}

/**
 * 解析 SSE 字节流，回调每个 data payload（非 [DONE]）。
 */
async function consumeSSE(response, onData) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
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
        onData(JSON.parse(payload));
      } catch {
        /* 忽略不完整/非 JSON 行 */
      }
    }
  }
}

export async function streamChat({ settings, messages, signal, onToken }) {
  const model = settings.model;
  if (!model) throw new Error('未配置模型 — 请到设置页填写');
  const url = endpointFor(settings);
  const key = (settings.apiKeys && settings.apiKeys[settings.provider]) || '';
  const headers = { 'Content-Type': 'application/json' };
  let body;

  if (settings.provider === 'anthropic') {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
    const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    body = {
      model,
      max_tokens: 2048,
      stream: true,
      system: sys || undefined,
      messages: messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role, content: m.content })),
    };
  } else {
    if (key) headers['Authorization'] = 'Bearer ' + key;
    body = { model, stream: true, messages };
  }

  const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`LLM 请求失败 HTTP ${resp.status}: ${detail.slice(0, 300)}`);
  }

  let full = '';
  await consumeSSE(resp, (data) => {
    let tok = null;
    if (settings.provider === 'anthropic') {
      if (data.type === 'content_block_delta' && data.delta && data.delta.text) tok = data.delta.text;
    } else {
      tok = data.choices && data.choices[0] && data.choices[0].delta && data.choices[0].delta.content;
    }
    if (tok) {
      full += tok;
      if (onToken) onToken(tok);
    }
  });
  return { text: full };
}
