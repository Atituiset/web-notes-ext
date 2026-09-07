/**
 * VS Code 平台装配 — activate() 时调用一次，把端口适配器注入 core。
 * 本扩展只有一个 bundle（esbuild cjs 单文件），模块级注册表只此一份。
 * PermissionGate / I18n 不配置：默认 no-op / 空串兜底即所需语义。
 */
import type * as vscode from 'vscode';
import { configurePlatform } from '../../../core/src/ports.js';
import { vscodeVaultFS } from './vault-fs.js';
import { makeKVStore } from './kv-store.js';
import { makeSettingsStore } from './settings-store.js';
import { vscodeTextSource } from './text-source.js';

export function setupVsCodePlatform(context: vscode.ExtensionContext): void {
  configurePlatform({
    vaultFS: vscodeVaultFS,
    kv: makeKVStore(context.globalState),
    settings: makeSettingsStore(context.secrets),
    textSource: vscodeTextSource,
  });
}
