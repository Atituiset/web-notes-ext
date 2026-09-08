/**
 * 快速配置向导（markpilot.setup）— 对齐 Chrome 设置页的「选平台 → 预设端点/模型」体验。
 * 三步：provider QuickPick（core PROVIDERS 注册表）→ API Key（needsKey 时，存 SecretStorage）
 * → 模型 QuickPick（预设模型 / 拉取在线列表 / 手动输入）。
 * 每步 Escape 静默中止，已保存的部分不回滚。
 */
import * as vscode from 'vscode';
import { PROVIDERS, listModels } from '../../core/src/llm/index.js';
import { settingsStore } from '../../core/src/ports.js';

/** setup 与 setApiKey 共用的密钥落盘助手（空串 = 清除） */
export async function saveApiKey(
  secrets: vscode.SecretStorage,
  provider: string,
  key: string
): Promise<void> {
  if (key) await secrets.store('markpilot.apiKey.' + provider, key);
  else await secrets.delete('markpilot.apiKey.' + provider);
}

const GLOBAL = vscode.ConfigurationTarget.Global;

interface ProviderItem extends vscode.QuickPickItem {
  key: string;
}

export async function runSetupWizard(secrets: vscode.SecretStorage): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('markpilot');

  // ---- Step 1: provider ----
  const items: ProviderItem[] = Object.entries(PROVIDERS).map(([key, p]: [string, any]) => ({
    key,
    label: p.label,
    description: key === 'opencode' ? '零配置' : key === 'ollama' ? '本地' : p.needsKey ? '需要 API Key' : '',
    detail: p.presetBase || undefined,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: '选择 LLM 平台（1/3）',
  });
  if (!picked) return;
  const provider = picked.key;
  const meta: any = (PROVIDERS as Record<string, any>)[provider];
  await cfg.update('provider', provider, GLOBAL);

  // ---- Step 2: API Key（needsKey 时）----
  if (meta.needsKey) {
    const key = await vscode.window.showInputBox({
      prompt: `${meta.label} 的 API Key — 存于 SecretStorage，不写 settings.json（2/3）`,
      password: true,
    });
    if (key === undefined) return; // Esc：provider 已保存，密钥暂不设置
    await saveApiKey(secrets, provider, key.trim());
  }

  // ---- Step 3: baseUrl（仅 openai-compatible 且未配置）+ 模型 ----
  let baseUrl = String(cfg.get('baseUrl') || '').trim();
  if (!meta.presetBase && !baseUrl) {
    const input = await vscode.window.showInputBox({
      prompt: 'Base URL（OpenAI 兼容端点）（3/3）',
      placeHolder: 'http://localhost:11434/v1',
    });
    if (input === undefined) return;
    baseUrl = input.trim();
    await cfg.update('baseUrl', baseUrl, GLOBAL);
  }

  const FETCH = '$(cloud-download) 拉取在线模型列表…';
  const MANUAL = '$(pencil) 手动输入…';
  const preset: string[] = meta.models || [];
  const choice = await vscode.window.showQuickPick([...preset, FETCH, MANUAL], {
    placeHolder: '选择模型（3/3）',
  });
  if (choice === undefined) return;
  let model: string | undefined;
  if (choice === FETCH) model = await pickOnlineModel();
  else if (choice === MANUAL) model = await inputManualModel();
  else model = choice;
  if (!model) return;
  await cfg.update('model', model, GLOBAL);

  vscode.window.showInformationMessage(`Markpilot 配置完成：${meta.label || provider} / ${model}`);
}

/** 拉取在线模型列表（core listModels，读刚保存的设置）；openrouter 免费模型带标记 */
async function pickOnlineModel(): Promise<string | undefined> {
  try {
    const settings = await settingsStore().getSettings();
    const models: { id: string; free: boolean }[] = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: '拉取模型列表…' },
      () => listModels(settings)
    );
    if (!models.length) {
      vscode.window.showWarningMessage('在线模型列表为空，请手动输入');
      return inputManualModel();
    }
    const picked = await vscode.window.showQuickPick(
      models.map((m) => ({ label: m.id, description: m.free ? '免费' : '' })),
      { placeHolder: '在线模型列表' }
    );
    return picked ? picked.label : undefined;
  } catch (e) {
    vscode.window.showErrorMessage('拉取模型列表失败: ' + String((e as Error)?.message || e));
    return undefined;
  }
}

async function inputManualModel(): Promise<string | undefined> {
  const input = await vscode.window.showInputBox({ prompt: '模型 ID' });
  if (input === undefined || !input.trim()) return undefined;
  return input.trim();
}
