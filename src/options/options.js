import { getSettings, saveSettings } from '../lib/db.js';
import { pickVault, vaultPermissionState } from '../lib/obsidian.js';
import { PROVIDERS, listModels } from '../lib/llm/index.js';

const $ = (id) => document.getElementById(id);

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
  } catch (e) {
    $('model-status').textContent = '拉取失败: ' + e.message + '（可手动填模型名）';
  }
  btn.disabled = false;
});

$('btn-pick').addEventListener('click', async () => {
  try {
    await pickVault();
    await refreshVaultState();
  } catch (e) {
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
  });
  $('save-status').textContent = '已保存 ✓';
  setTimeout(() => ($('save-status').textContent = ''), 2000);
});

load();
