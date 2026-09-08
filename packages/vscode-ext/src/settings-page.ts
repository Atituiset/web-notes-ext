/**
 * 统一设置页（markpilot.openSettings）— WebviewPanel（编辑器整页，非侧栏）。
 * 对齐 Chrome 扩展 options 页的字段：平台 / API Key / Base URL / 模型（含在线拉取）
 * / 测试连接 / vault 路径 / 记忆与召回开关。
 *
 * 消息协议（webview ↔ host）：
 *   webview → host: init | set{key,value} | setApiKey{provider,key} | fetchModels | testConnection | pickVault
 *   host → webview: state（全量快照）| models{models,error?} | testResult{ok,detail}
 * 所有改动即改即存（Global 配置 / SecretStorage），host 回发最新 state 让 UI 始终与落盘一致。
 * API Key 只回传「是否存在」标志 —— 密钥本体永不下发 webview。
 *
 * 写路径复用：密钥 = setup-wizard 的 saveApiKey；设置合并读取 = platform/settings-store
 * 的 makeSettingsStore（本模块不新开写入通道）。
 */
import * as vscode from 'vscode';
import { PROVIDERS, listModels } from '../../core/src/llm/index.js';
import { makeSettingsStore } from './platform/settings-store.js';
import { saveApiKey } from './setup-wizard.js';

const GLOBAL = vscode.ConfigurationTarget.Global;

/** 可经 set 消息写入的配置键白名单（其余一律拒绝） */
const SETTABLE_KEYS = ['provider', 'model', 'baseUrl', 'vaultPath', 'memoryInject', 'exportAiQA', 'semanticRecall'];

export interface SettingsDeps {
  secrets: vscode.SecretStorage;
  post: (msg: any) => void;
}

/** 全量状态快照（含 provider 元数据与各平台密钥存在标志） */
export async function buildState(secrets: vscode.SecretStorage): Promise<any> {
  const s = await makeSettingsStore(secrets).getSettings();
  const apiKeySet: Record<string, boolean> = {};
  for (const p of Object.keys(PROVIDERS)) {
    apiKeySet[p] = !!(await secrets.get('markpilot.apiKey.' + p));
  }
  return {
    type: 'state',
    settings: {
      provider: s.provider,
      model: s.model, // 含读时回退（空 → 首个预设），与生效值一致
      baseUrl: s.baseUrl || '',
      vaultPath: s.vaultPath || '',
      memoryInject: s.memoryInject !== false,
      exportAiQA: !!s.exportAiQA,
      semanticRecall: s.semanticRecall || 'off',
    },
    apiKeySet,
    providers: Object.entries(PROVIDERS).map(([key, p]: [string, any]) => ({
      key,
      label: p.label,
      needsKey: !!p.needsKey,
      presetBase: p.presetBase || '',
      models: p.models || [],
    })),
  };
}

/** 消息处理（设置页主体；测试可直接驱动本函数） */
export async function handleSettingsMessage(msg: any, deps: SettingsDeps): Promise<void> {
  const { secrets, post } = deps;
  const cfg = vscode.workspace.getConfiguration('markpilot');
  switch (msg && msg.type) {
    case 'init':
      post(await buildState(secrets));
      break;
    case 'set': {
      if (!SETTABLE_KEYS.includes(msg.key)) return;
      await cfg.update(msg.key, msg.value, GLOBAL);
      post(await buildState(secrets));
      break;
    }
    case 'setApiKey': {
      const provider = String(msg.provider || '');
      if (!(PROVIDERS as Record<string, any>)[provider]) return;
      await saveApiKey(secrets, provider, String(msg.key || '').trim());
      post(await buildState(secrets));
      break;
    }
    case 'fetchModels':
    case 'testConnection': {
      try {
        const settings = await makeSettingsStore(secrets).getSettings();
        // 不回退预设：设置页必须能分辨真实错误（401/断网）与陈旧预设
        const models: { id: string; free: boolean }[] = await listModels(settings, { fallbackToPresets: false });
        if (msg.type === 'fetchModels') {
          post({ type: 'models', models });
        } else {
          post({ type: 'testResult', ok: true, detail: `连接正常 — ${models.length} 个模型可用` });
        }
      } catch (e) {
        const detail = String((e as Error)?.message || e);
        if (msg.type === 'fetchModels') post({ type: 'models', models: [], error: detail });
        else post({ type: 'testResult', ok: false, detail });
      }
      break;
    }
    case 'pickVault': {
      const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        title: '选择 Obsidian vault 目录',
      });
      if (picked && picked[0]) await cfg.update('vaultPath', picked[0].fsPath, GLOBAL);
      post(await buildState(secrets));
      break;
    }
  }
}

/** 单例面板：重复触发聚焦已有标签页 */
export class SettingsPanel {
  private static current: vscode.WebviewPanel | null = null;

  static createOrShow(secrets: vscode.SecretStorage): void {
    if (SettingsPanel.current) {
      SettingsPanel.current.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'markpilot.settings',
      'Markpilot 设置',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    SettingsPanel.current = panel;
    panel.onDidDispose(() => (SettingsPanel.current = null));
    panel.webview.html = settingsHtml();
    panel.webview.onDidReceiveMessage((msg) =>
      handleSettingsMessage(msg, { secrets, post: (m) => void panel.webview.postMessage(m) })
    );
  }
}

function settingsHtml(): string {
  const nonce = String(Date.now()) + String(Math.random()).slice(2, 8);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); max-width: 640px; margin: 0 auto; padding: 24px 16px; }
  h1 { font-size: 18px; } h2 { font-size: 13px; color: var(--vscode-descriptionForeground); margin: 24px 0 8px; text-transform: uppercase; letter-spacing: .05em; }
  .row { margin: 10px 0; }
  label { display: block; margin-bottom: 4px; color: var(--vscode-descriptionForeground); }
  input[type=text], input[type=password], select { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 4px 8px; }
  input:disabled, select:disabled { opacity: .5; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; border-radius: 3px; padding: 4px 12px; cursor: pointer; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button:disabled { opacity: .5; cursor: default; }
  .inline { display: flex; gap: 8px; align-items: center; }
  .inline input, .inline select { flex: 1; }
  .hint { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
  .ok { color: var(--vscode-testing-iconPassed, #059669); }
  .err { color: var(--vscode-errorForeground); }
  .toggles label { display: inline-flex; gap: 6px; align-items: center; margin-right: 16px; color: var(--vscode-foreground); }
</style>
</head>
<body>
  <h1>Markpilot 设置</h1>

  <h2>LLM</h2>
  <div class="row">
    <label>平台</label>
    <select id="provider"></select>
  </div>
  <div class="row">
    <label>API Key</label>
    <div class="inline">
      <input type="password" id="apiKey" placeholder="粘贴 API Key 后点保存">
      <button id="btn-key">保存</button>
    </div>
    <div class="hint" id="key-status"></div>
  </div>
  <div class="row">
    <label>Base URL（仅 OpenAI 兼容）</label>
    <input type="text" id="baseUrl" placeholder="http://localhost:11434/v1">
  </div>
  <div class="row">
    <label>模型</label>
    <div class="inline">
      <input type="text" id="model" list="model-list" placeholder="模型 ID">
      <datalist id="model-list"></datalist>
      <button class="secondary" id="btn-fetch" title="拉取在线模型列表">⟳ 在线列表</button>
      <button class="secondary" id="btn-test">测试连接</button>
    </div>
    <div class="hint"><span id="fetch-hint"></span></div>
    <div class="hint" id="model-status"></div>
  </div>

  <h2>Obsidian</h2>
  <div class="row">
    <label>vault 路径（记忆 / 笔记导出落盘位置；留空则记忆功能停用）</label>
    <div class="inline">
      <input type="text" id="vaultPath" placeholder="/path/to/vault">
      <button class="secondary" id="btn-browse">浏览…</button>
    </div>
  </div>

  <h2>记忆与召回</h2>
  <div class="row toggles">
    <label><input type="checkbox" id="memoryInject"> 提问时注入长期记忆</label>
    <label><input type="checkbox" id="exportAiQA"> 导出包含 AI 问答</label>
  </div>
  <div class="row">
    <label>语义召回</label>
    <select id="semanticRecall">
      <option value="off">off — 仅词法检索</option>
      <option value="local">local — 端侧 MiniLM（首次下载模型）</option>
    </select>
  </div>

<script nonce="${nonce}">
  // 变量名不能叫 vscode：新版 VS Code 的 webview 全局已有 vscode 绑定，
  // const vscode 会整脚本 SyntaxError（静默死屏的根因）
  const vs = acquireVsCodeApi();
  const el = (id) => document.getElementById(id);
  let meta = [];
  // 模型列表来源标签：用户必须能分辨「预设（未拉取）」与「在线列表」
  let srcLabel = '预设列表（未拉取）';
  let sticky = false; // 错误/测试结果停留时不被 state 重渲染覆盖
  let lastProvider = '';

  function setStatus(text, cls) {
    const s = el('model-status');
    s.textContent = text;
    s.className = 'hint' + (cls ? ' ' + cls : '');
  }

  function presetOf(provider) {
    const p = meta.find((x) => x.key === provider);
    return (p && p.models) || [];
  }
  function fillDatalist(ids, frees) {
    const dl = el('model-list');
    dl.textContent = '';
    for (const id of ids) {
      const o = document.createElement('option');
      o.value = id;
      o.label = frees && frees.has(id) ? '免费' : '';
      dl.appendChild(o);
    }
  }
  function render(st) {
    meta = st.providers;
    const sel = el('provider');
    if (!sel.options.length) {
      for (const p of st.providers) sel.add(new Option(p.label, p.key));
    }
    sel.value = st.settings.provider;
    if (lastProvider !== st.settings.provider) {
      lastProvider = st.settings.provider;
      srcLabel = '预设列表（未拉取）';
      sticky = false;
    }
    el('model').value = st.settings.model;
    fillDatalist(presetOf(st.settings.provider), null);
    el('baseUrl').value = st.settings.baseUrl;
    el('baseUrl').disabled = st.settings.provider !== 'openai-compatible';
    el('vaultPath').value = st.settings.vaultPath;
    el('memoryInject').checked = st.settings.memoryInject;
    el('exportAiQA').checked = st.settings.exportAiQA;
    el('semanticRecall').value = st.settings.semanticRecall;
    const m = meta.find((x) => x.key === st.settings.provider) || {};
    const ks = el('key-status');
    const needKey = !!m.needsKey && !st.apiKeySet[st.settings.provider];
    // 无 key 的平台拉在线列表注定 401 —— 直接禁用并提示，不放行无效请求
    el('btn-fetch').disabled = needKey;
    el('fetch-hint').textContent = needKey ? '先保存 API Key 再拉取在线列表' : '';
    if (!sticky) setStatus(srcLabel, '');
    if (!m.needsKey) {
      ks.textContent = '该平台无需 API Key';
      el('apiKey').disabled = true;
      el('btn-key').disabled = true;
    } else {
      el('apiKey').disabled = false;
      el('btn-key').disabled = false;
      ks.textContent = st.apiKeySet[st.settings.provider] ? '已保存 ✓（更换直接粘贴新 Key 保存）' : '未设置';
    }
  }

  el('provider').addEventListener('change', () => vs.postMessage({ type: 'set', key: 'provider', value: el('provider').value }));
  el('model').addEventListener('change', () => vs.postMessage({ type: 'set', key: 'model', value: el('model').value.trim() }));
  el('baseUrl').addEventListener('change', () => vs.postMessage({ type: 'set', key: 'baseUrl', value: el('baseUrl').value.trim() }));
  el('vaultPath').addEventListener('change', () => vs.postMessage({ type: 'set', key: 'vaultPath', value: el('vaultPath').value.trim() }));
  el('memoryInject').addEventListener('change', () => vs.postMessage({ type: 'set', key: 'memoryInject', value: el('memoryInject').checked }));
  el('exportAiQA').addEventListener('change', () => vs.postMessage({ type: 'set', key: 'exportAiQA', value: el('exportAiQA').checked }));
  el('semanticRecall').addEventListener('change', () => vs.postMessage({ type: 'set', key: 'semanticRecall', value: el('semanticRecall').value }));
  el('btn-key').addEventListener('click', () => {
    vs.postMessage({ type: 'setApiKey', provider: el('provider').value, key: el('apiKey').value });
    el('apiKey').value = '';
  });
  el('btn-fetch').addEventListener('click', () => {
    sticky = true;
    setStatus('拉取中…', '');
    vs.postMessage({ type: 'fetchModels' });
  });
  el('btn-test').addEventListener('click', () => {
    sticky = true;
    setStatus('测试连接中…', '');
    vs.postMessage({ type: 'testConnection' });
  });
  el('btn-browse').addEventListener('click', () => vs.postMessage({ type: 'pickVault' }));

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'state') {
      render(m);
    } else if (m.type === 'models') {
      if (m.error) {
        sticky = true;
        setStatus('拉取失败: ' + m.error, 'err');
      } else {
        sticky = false;
        fillDatalist(m.models.map((x) => x.id), new Set(m.models.filter((x) => x.free).map((x) => x.id)));
        srcLabel = '在线列表 ✓ ' + m.models.length + ' 个模型';
        setStatus(srcLabel, 'ok');
      }
    } else if (m.type === 'testResult') {
      sticky = true;
      setStatus((m.ok ? '✓ ' : '✗ ') + m.detail, m.ok ? 'ok' : 'err');
    }
  });

  vs.postMessage({ type: 'init' });
</script>
</body>
</html>`;
}
