import { getSettings, saveSettings } from '../lib/db.js';
import { pickVault, vaultPermissionState } from '../lib/obsidian.js';
import { PROVIDERS, listModels, streamChat } from '../lib/llm/index.js';
import { DEFAULT_SYSTEM_PROMPT } from '../lib/llm/context.js';
import { listMemories, deleteMemory, pinMemory, saveMemory, isCold } from '../lib/memory.js';

const $ = (id: string): any => document.getElementById(id);

// provider 下拉由 PROVIDERS 生成
function fillProviders() {
  const sel = $('provider');
  sel.textContent = '';
  for (const [value, p] of Object.entries(PROVIDERS)) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = p.label;
    sel.appendChild(opt);
  }
}

async function load() {
  fillProviders();
  const s = await getSettings();
  $('provider').value = s.provider;
  if (!$('provider').value) $('provider').value = 'openai-compatible';
  $('baseUrl').value = s.baseUrl || '';
  $('model').value = s.model || '';
  $('apiKey').value = (s.apiKeys && s.apiKeys[s.provider]) || '';
  $('vaultDirTemplate').value = s.vaultDirTemplate || 'Clippings';
  $('exportAiQA').checked = !!s.exportAiQA;
  $('memoryInject').checked = s.memoryInject !== false;
  $('autoMemory').checked = !!s.autoMemory;
  // 未设置过则展示默认 prompt；设置过（含清空成 ''）按原值展示
  $('systemPrompt').value = s.systemPrompt !== undefined && s.systemPrompt !== null
    ? s.systemPrompt
    : DEFAULT_SYSTEM_PROMPT;
  // 有预设模型的 provider 直接填 datalist
  const presetModels = (PROVIDERS[$('provider').value] && PROVIDERS[$('provider').value].models) || [];
  fillModelList(presetModels.map((id) => ({ id, free: false })));
  refreshVaultState();
}

// ---------- 模型下拉（自定义，支持模糊过滤；免费/最新排序靠前）----------

let allModels = []; // [{id, free}]

/** 排序：免费优先 → 新一代模型关键词优先 → 字母序 */
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

/** 简单模糊匹配：所有子序列片段按顺序命中即可 */
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

/**
 * 模型展示名别名：搜索时同时匹配别名（如输 "ox alpha" 命中 x-preview-f-free）。
 * 下拉中仍显示真实模型 ID，保证选中值可直接请求。
 * 来源两层：
 *   1. MODEL_ALIASES 内置兜底（OpenCode 文档页结构变更时仍可用）
 *   2. fetchDisplayNameAliases() 从 OpenCode 文档页解析全量映射（见下）
 */
const MODEL_ALIASES = {
  'x-preview-f-free': 'ox alpha free stealth',
  'mimo-v2.5-free': 'mimo xiaomi',
  'hy3-free': 'hy3 hunyuan tencent',
  'nemotron-3-ultra-free': 'nemotron nvidia ultra',
  'nemotron-3.5-lightning-free': 'nemotron nvidia lightning',
  'laguna-s-2.1-free': 'laguna',
  'big-pickle': 'big pickle stealth',
  'muse-spark-1.2-contributor-free': 'muse spark contributor',
};

// 运行时别名表（文档页解析结果覆盖/补充内置兜底）
let dynamicAliases: Record<string, string> = {};

function aliasFor(id: string): string {
  return dynamicAliases[id] || (MODEL_ALIASES as Record<string, string>)[id] || '';
}

/**
 * 从 OpenCode Zen 文档页抓「展示名 ↔ 模型 ID」对照表。
 * 页面表格结构：<tr><td>Ox Alpha Free</td><td>x-preview-f-free</td><td>…
 * 失败静默返回 {} —— 别名是增强功能，不能阻塞拉取模型列表。
 */
export async function fetchDisplayNameAliases(): Promise<Record<string, string>> {
  try {
    const resp = await fetch('https://opencode.ai/docs/zen');
    if (!resp.ok) return {};
    const html = await resp.text();
    const out: Record<string, string> = {};
    const re = /<tr><td>([^<]+)<\/td><td>([a-z0-9._-]+)<\/td><td>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      const [, name, id] = m;
      if (!out[id]) out[id] = name.toLowerCase();
    }
    return out;
  } catch {
    return {}; // 网络失败/页面改版 — 静默降级到内置兜底
  }
}

/** 拉取模型列表后调用，用文档页映射增强别名搜索 */
async function enrichAliases() {
  if (Object.keys(dynamicAliases).length) return; // 只抓一次
  dynamicAliases = await fetchDisplayNameAliases();
}

function matchModel(query, m) {
  const alias = aliasFor(m.id);
  return fuzzyMatch(query, m.id) || (alias ? fuzzyMatch(query, alias) : false);
}

function renderModelDropdown() {
  clearTimeout(hideDdTimer); // 取消 blur 调度的隐藏（快速端点竞态）
  const dd = $('model-dropdown');
  const query = $('model').value.trim();
  dd.textContent = '';
  let list = sortModels(allModels);
  if (query) list = list.filter((m) => matchModel(query, m));
  if (!list.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = allModels.length ? '无匹配模型' : '暂无列表 — 点「获取模型」或直接手填';
    dd.appendChild(e);
  }
  for (const m of list.slice(0, 100)) {
    const o = document.createElement('div');
    o.className = 'opt';
    const name = document.createElement('span');
    name.textContent = m.id;
    name.title = aliasFor(m.id);
    o.appendChild(name);
    if (m.free) {
      const f = document.createElement('span');
      f.className = 'free';
      f.textContent = '⭐ 免费';
      o.appendChild(f);
    }
    o.addEventListener('mousedown', (e) => {
      // mousedown 抢在 blur 前选中
      e.preventDefault();
      $('model').value = m.id;
      hideModelDropdown();
      testModel(); // 选中即测，坏模型提前暴露
    });
    dd.appendChild(o);
  }
  dd.style.display = 'block';
}

function hideModelDropdown() {
  $('model-dropdown').style.display = 'none';
}

function fillModelList(models) {
  allModels = models || [];
}

// blur 的延迟隐藏 vs 快速渲染的竞态：本地端点（Ollama/mock）拉取极快，
// render 后 120ms 的 hide 才把下拉误隐藏 —— render 时取消 pending hide
let hideDdTimer: any = null;

$('model').addEventListener('focus', () => { if (allModels.length) renderModelDropdown(); });
$('model').addEventListener('input', () => { if (allModels.length) renderModelDropdown(); });
$('model').addEventListener('blur', () => {
  hideDdTimer = setTimeout(hideModelDropdown, 120);
});

async function refreshVaultState() {
  const state = await vaultPermissionState();
  $('vault-state').textContent =
    state === 'no-handle' ? '未授权'
    : state === 'granted' ? '✓ 已授权'
    : '已选目录，需点击一次恢复权限';
}

$('provider').addEventListener('change', async () => {
  const s = await getSettings();
  const p = $('provider').value;
  $('apiKey').value = (s.apiKeys && s.apiKeys[p]) || '';
  const preset = PROVIDERS[p];
  $('model-status').textContent = '';
  // 预设模型先垫上；baseUrl 显示预设提示
  fillModelList((preset && preset.models || []).map((id) => ({ id, free: false })));
  if (!s.baseUrl && preset && preset.presetBase && p !== 'openai-compatible') {
    $('baseUrl').placeholder = '默认 ' + preset.presetBase;
  }
});

$('btn-models').addEventListener('click', async () => {
  const btn = $('btn-models');
  btn.disabled = true;
  $('model-status').textContent = '拉取中…';
  try {
    const models = await listModels({
      provider: $('provider').value,
      baseUrl: $('baseUrl').value.trim(),
      apiKeys: { [$('provider').value]: $('apiKey').value.trim() },
    });
    fillModelList(models);
    const freeCount = models.filter((m) => m.free).length;
    $('model-status').innerHTML =
      `已拉取 ${models.length} 个模型` +
      (freeCount ? `，其中 <b>${freeCount}</b> 个免费（标 ⭐）` : '') +
      ' — 在模型输入框点击即可选择。';
    // 免费模型排前面方便选：自动带上第一个免费模型作为建议
    if (freeCount && !$('model').value) $('model').value = models.find((m) => m.free).id;
    // 别名增强（文档页解析，失败静默）— 不阻塞下拉展示
    void enrichAliases();
    // 拉取后立即展示下拉（聚焦输入框），方便直接换模型
    if (models.length) {
      renderModelDropdown();
      $('model').focus();
    }
  } catch (e: any) {
    $('model-status').textContent = '拉取失败: ' + e.message + '（可手动填模型名）';
  }
  btn.disabled = false;
});

// ---------- 模型连通性测试 ----------

let testing = false;

/** 用表单当前值发一条真实请求验证模型可用性（选中模型后自动调用，也可点「测试」手动触发） */
async function testModel() {
  if (testing) return;
  const status = $('model-test-status');
  const model = $('model').value.trim();
  if (!model) { status.textContent = ''; return; }
  const provider = $('provider').value;
  testing = true;
  status.style.color = '#6b7280';
  status.textContent = `正在测试 ${model} …`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000); // 有的上游只发 keep-alive 不出 token，30s 判死
  const t0 = Date.now();
  try {
    const { text } = await streamChat({
      settings: {
        provider,
        baseUrl: $('baseUrl').value.trim(),
        model,
        apiKeys: { [provider]: $('apiKey').value.trim() },
      },
      messages: [{ role: 'user', content: '回复 ok 即可' }],
      signal: ctrl.signal,
    });
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    if (text.trim()) {
      status.style.color = '#059669';
      status.textContent = `✓ ${model} 可用（${sec}s）`;
    } else {
      status.style.color = '#b45309';
      status.textContent = `⚠ ${model} 连接成功但未返回内容，换一个试试`;
    }
  } catch (e: any) {
    status.style.color = '#dc2626';
    status.textContent = ctrl.signal.aborted
      ? `✗ ${model} 30s 无响应（上游可能挂起，换个模型试试）`
      : `✗ ${model} 不可用: ${String(e.message || e).slice(0, 150)}`;
  } finally {
    clearTimeout(timer);
    testing = false;
  }
}

$('btn-test').addEventListener('click', testModel);

$('btn-pick').addEventListener('click', async () => {
  try {
    await pickVault();
    await refreshVaultState();
  } catch (e: any) {
    if (e && e.name !== 'AbortError') $('vault-state').textContent = '授权失败: ' + e.message;
  }
});

$('btn-save').addEventListener('click', async () => {
  const prev = await getSettings();
  const apiKeys = Object.assign({}, prev.apiKeys);
  apiKeys[$('provider').value] = $('apiKey').value.trim();
  await saveSettings({
    provider: $('provider').value,
    baseUrl: $('baseUrl').value.trim(),
    model: $('model').value.trim(),
    apiKeys,
    vaultDirTemplate: $('vaultDirTemplate').value.trim() || 'Clippings',
    exportAiQA: $('exportAiQA').checked,
    memoryInject: $('memoryInject').checked,
    autoMemory: $('autoMemory').checked,
    systemPrompt: $('systemPrompt').value.trim(), // 空串 = 不带 system 消息
  });
  $('save-status').textContent = '已保存 ✓';
  setTimeout(() => ($('save-status').textContent = ''), 2000);
});

$('btn-prompt-reset').addEventListener('click', () => {
  $('systemPrompt').value = DEFAULT_SYSTEM_PROMPT;
});

// ---------- 记忆管理 ----------

async function renderMemories() {
  const listEl = $('mem-list');
  listEl.textContent = '';
  let memories;
  try {
    memories = await listMemories();
  } catch {
    $('mem-count').textContent = '';
    return;
  }
  $('mem-count').textContent = memories.length ? `${memories.length} 条记忆` : '';
  if (!memories.length) return;

  for (const m of memories.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated.localeCompare(a.updated))) {
    const item = document.createElement('div');
    item.className = 'mem-item' + (isCold(m) ? ' cold' : '');

    const meta = document.createElement('div');
    meta.className = 'meta';
    // 记忆文件的 domain/tags 等来自 LLM 输出，不可信 —— 一律 textContent，不用 innerHTML
    const appendBit = (node: Node | string) => {
      if (meta.childNodes.length) meta.appendChild(document.createTextNode(' · '));
      meta.appendChild(typeof node === 'string' ? document.createTextNode(node) : node);
    };
    if (m.pinned) appendBit('📌');
    if (isCold(m)) {
      const cold = document.createElement('span');
      cold.className = 'cold-tag';
      cold.textContent = '冷（90天未用）';
      appendBit(cold);
    }
    appendBit(m.domain ? m.domain : 'user');
    appendBit(String(m.confidence));
    appendBit('hits:' + m.hits);
    appendBit(String(m.updated));
    if (m.tags.length) appendBit('#' + m.tags.join(' #'));
    item.appendChild(meta);

    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = m.body;
    item.appendChild(body);

    const ops = document.createElement('div');
    ops.className = 'ops';
    const mkBtn = (text: string, fn: () => void, cls?: string) => {
      const b = document.createElement('button');
      if (cls) b.className = cls;
      b.textContent = text;
      b.addEventListener('click', fn);
      return b;
    };
    ops.appendChild(mkBtn(m.pinned ? '取消钉选' : '📌 钉选', async () => {
      await pinMemory(m.file, !m.pinned);
      renderMemories();
    }));
    // 编辑：prompt 简易实现
    ops.appendChild(mkBtn('编辑', async () => {
      const v = prompt('编辑记忆内容:', m.body);
      if (v === null || !v.trim() || v.trim() === m.body) return;
      await saveMemory({
        scope: m.scope, domain: m.domain, source: m.source,
        body: v.trim(), tags: m.tags, confidence: m.confidence,
        pinned: m.pinned, file: m.file,
      });
      renderMemories();
    }));
    ops.appendChild(mkBtn('删除', async () => {
      if (!confirm('删除这条记忆？')) return;
      await deleteMemory(m.file);
      renderMemories();
    }, 'danger'));
    item.appendChild(ops);
    listEl.appendChild(item);
  }
}

$('btn-mem-mgr').addEventListener('click', () => {
  const listEl = $('mem-list');
  if (listEl.style.display === 'none') {
    listEl.style.display = 'block';
    renderMemories();
  } else {
    listEl.style.display = 'none';
  }
});

load();
