/**
 * SettingsStore 端口 VS Code 实现 — workspace 配置（markpilot.*）+ 默认值与 chrome 侧 db.js 对齐。
 * API keys 不落 settings.json —— 存 context.secrets（markpilot.apiKey.<provider>），
 * 读时合并成 chrome 侧的 apiKeys 形状（{ [provider]: key }）。
 */
import * as vscode from 'vscode';
import type { SettingsStore } from '../../../core/src/ports.js';
import { PROVIDERS } from '../../../core/src/llm/index.js';

// 默认值对齐 chrome db.js getSettings；semanticRecall 默认关（VS Code 侧通道见 embedding-node.ts）
const DEFAULTS: Record<string, any> = {
  provider: 'openai-compatible',
  model: '',
  baseUrl: '',
  vaultDirTemplate: 'Clippings',
  exportAiQA: false,
  obsidianExportMode: 'fs-access',
  obsidianRestKey: '',
  memoryInject: true,
  autoMemory: false,
  semanticRecall: 'off',
  embedApiKey: '',
};

// settings 键 → workspace 配置键
const CONFIG_KEY: Record<string, string> = {
  provider: 'provider',
  model: 'model',
  baseUrl: 'baseUrl',
  vaultPath: 'vaultPath',
  memoryInject: 'memoryInject',
  exportAiQA: 'exportAiQA',
  semanticRecall: 'semanticRecall',
};

const SECRET_KEY = (provider: string) => 'markpilot.apiKey.' + provider;

export function makeSettingsStore(secrets: vscode.SecretStorage): SettingsStore {
  return {
    async getSettings() {
      const cfg = vscode.workspace.getConfiguration('markpilot');
      const s: Record<string, any> = { ...DEFAULTS, apiKeys: {} };
      for (const [k, ck] of Object.entries(CONFIG_KEY)) {
        const v = cfg.get(ck);
        if (v !== undefined && v !== null && v !== '') s[k] = v;
      }
      for (const p of Object.keys(PROVIDERS)) {
        const key = await secrets.get(SECRET_KEY(p));
        if (key) s.apiKeys[p] = key;
      }
      // 未显式配模型且 provider 有预设模型：读时回退到第一个预设（非破坏性，不写配置）
      if (!s.model) {
        const preset = (PROVIDERS as Record<string, any>)[s.provider]?.models;
        if (preset && preset.length) s.model = preset[0];
      }
      return s;
    },
    async saveSettings(patch) {
      const cfg = vscode.workspace.getConfiguration('markpilot');
      for (const [k, v] of Object.entries(patch || {})) {
        if (k === 'apiKeys') {
          for (const [p, key] of Object.entries(v as Record<string, string>)) {
            if (key) await secrets.store(SECRET_KEY(p), String(key));
            else await secrets.delete(SECRET_KEY(p));
          }
        } else if (CONFIG_KEY[k]) {
          await cfg.update(CONFIG_KEY[k], v, vscode.ConfigurationTarget.Global);
        }
        // 无对应配置键的补丁（如 profileMemoryCount）MVP 静默忽略
      }
    },
  };
}
