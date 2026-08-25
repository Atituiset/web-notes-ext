import { getSettings, saveSettings } from '../lib/db.js';
import { pickVault, vaultPermissionState } from '../lib/obsidian.js';
import { PROVIDERS, listModels } from '../lib/llm/index.js';
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
  // 有预设模型的 provider 直接填 datalist
  const presetModels = (PROVIDERS[$('provider').value] && PROVIDERS[$('provider').value].models) || [];
  fillModelList(presetModels.map((id) => ({ id, free: false })));
  refreshVaultState();
}

function fillModelList(models) {
  const dl = $('model-list');
  dl.textContent = '';
  for (const m of models) {
    const o = document.createElement('option');
    o.value = m.id;
    o.label = m.free ? '⭐ 免费' : m.id;
    dl.appendChild(o);
  }
}

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
  } catch (e: any) {
    $('model-status').textContent = '拉取失败: ' + e.message + '（可手动填模型名）';
  }
  btn.disabled = false;
});

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
  });
  $('save-status').textContent = '已保存 ✓';
  setTimeout(() => ($('save-status').textContent = ''), 2000);
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
    const bits = [
      m.pinned ? '📌' : '',
      isCold(m) ? '<span class="cold-tag">冷（90天未用）</span>' : '',
      m.domain ? m.domain : 'user',
      m.confidence,
      'hits:' + m.hits,
      m.updated,
      m.tags.length ? '#' + m.tags.join(' #') : '',
    ].filter(Boolean);
    meta.innerHTML = bits.join(' · ');
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
