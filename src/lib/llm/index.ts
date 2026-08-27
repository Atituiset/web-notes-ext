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
  opencode: { label: 'OpenCode 免费模型 (零配置)', needsKey: false, presetBase: 'https://opencode.ai/zen/v1', models: ['mimo-v2.5-free', 'nemotron-3.5-lightning-free', 'hy3-free'] },
  'openai-compatible': { label: 'OpenAI 兼容 (自定义 baseUrl)', needsKey: false },
  ollama: { label: 'Ollama 本地 (localhost:11434)', needsKey: false, presetBase: 'http://localhost:11434/v1' },
  openrouter: { label: 'OpenRouter', needsKey: true, presetBase: 'https://openrouter.ai/api/v1' },
  anthropic: { label: 'Anthropic', needsKey: true },
  deepseek: { label: 'DeepSeek 深度求索', needsKey: true, presetBase: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
  zhipu: { label: '智谱 GLM', needsKey: true, presetBase: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash', 'glm-4-flashx'] },
  moonshot: { label: '月之暗面 Kimi', needsKey: true, presetBase: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'] },
  qwen: { label: '阿里通义千问 (兼容模式)', needsKey: true, presetBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-turbo', 'qwen-max'] },
};

/**
 * 拉取模型列表（/models 端点，OpenAI 兼容格式）。
 * - openrouter: 无 key 也可列；标记出免费模型（pricing 全 0）
 * - 其他 OpenAI 兼容 provider: 需要 key
 * 返回 [{id, free}]
 */
export async function listModels(settings) {
  const p = settings.provider;
  if (p === 'anthropic') {
    const key = (settings.apiKeys && settings.apiKeys.anthropic) || '';
    const resp = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
    });
    if (!resp.ok) throw new Error('拉取模型列表失败 HTTP ' + resp.status);
    const data = await resp.json();
    return (data.data || []).map((m) => ({ id: m.id, free: false }));
  }
  // OpenAI 兼容系
  const base = ((PROVIDERS[p] && PROVIDERS[p].presetBase) || settings.baseUrl || '').replace(/\/+$/, '');
  const presetModels = (PROVIDERS[p] && PROVIDERS[p].models) || [];
  if (!base) throw new Error('未配置 Base URL，无法拉取模型列表');
  const key = (settings.apiKeys && settings.apiKeys[p]) || '';
  const headers = {};
  if (key) headers['Authorization'] = 'Bearer ' + key;
  let models: string[];
  let freeData: any = null;
  try {
    const resp = await fetch(base + '/models', { headers });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    models = (data.data || []).map((m) => m.id).filter(Boolean).sort();
    freeData = data;
  } catch (e: any) {
    // 拉取失败回退到预置列表（零配置 provider 网络抖动时不阻塞设置）
    if (presetModels.length) return presetModels.map((id) => ({ id, free: true }));
    throw new Error('拉取模型列表失败: ' + (e?.message || e));
  }
  if (p === 'openrouter') {
    // 免费模型判定：pricing.prompt/completion 均为 "0"
    const freeSet = new Set(
      (freeData.data || [])
        .filter((m) => m.pricing && String(m.pricing.prompt) === '0' && String(m.pricing.completion) === '0')
        .map((m) => m.id)
    );
    return models.map((id) => ({ id, free: freeSet.has(id) }));
  }
  return models.map((id) => ({ id, free: false }));
}

function endpointFor(settings) {
  if (settings.provider === 'anthropic') return 'https://api.anthropic.com/v1/messages';
  if (settings.provider === 'openrouter') return 'https://openrouter.ai/api/v1/chat/completions';
  // 有预设端点的 provider 强制走预设；仅 openai-compatible 使用用户自定义 baseUrl
  const preset = PROVIDERS[settings.provider] && PROVIDERS[settings.provider].presetBase;
  const base = (preset || settings.baseUrl || 'http://localhost:11434/v1').replace(/\/+$/, '');
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

export async function streamChat({ settings, messages, signal, onToken, onReasoning }: {
  settings: any;
  messages: { role: string; content: string }[];
  signal?: AbortSignal;
  onToken?: (tok: string) => void;
  onReasoning?: (tok: string) => void;
}) {
  const model = settings.model;
  if (!model) throw new Error((globalThis.chrome?.i18n?.getMessage?.('modelNotConfiguredError')) || 'No model configured — set it in the settings page');
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
  let reasoning = '';
  await consumeSSE(resp, (data) => {
    let tok = null;
    let rtok = null;
    if (settings.provider === 'anthropic') {
      if (data.type === 'content_block_delta' && data.delta && data.delta.text) tok = data.delta.text;
      // Anthropic extended thinking
      if (data.type === 'content_block_delta' && data.delta && data.delta.thinking) rtok = data.delta.thinking;
    } else {
      const d = data.choices && data.choices[0] && data.choices[0].delta;
      if (d) {
        tok = d.content;
        // DeepSeek R1 / OpenCode free reasoning models: delta.reasoning_content
        // OpenAI o-series style: delta.reasoning
        rtok = d.reasoning_content || d.reasoning || null;
        if (typeof rtok !== 'string') rtok = null;
      }
    }
    if (rtok) {
      reasoning += rtok;
      if (onReasoning) onReasoning(rtok);
    }
    if (tok) {
      full += tok;
      if (onToken) onToken(tok);
    }
  });
  return { text: full, reasoning };
}
