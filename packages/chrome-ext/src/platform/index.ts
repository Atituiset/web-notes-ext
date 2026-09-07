/**
 * chrome 平台装配 — 启动时调用一次（panel/options/sw），把全部端口适配器注入 core。
 * 必须在触碰 core 业务模块前调用（端口被使用时才发现未配置会抛错）。
 */
import { configurePlatform } from '../../../core/src/ports.js';
import { chromeVaultFS } from './vault-fs.js';
import { chromeKV } from './kv-store.js';
import { chromeSettings } from './settings-store.js';
import { chromePermissions } from './permissions.js';
import { chromeI18n } from './i18n.js';
import { chromeAssets } from './assets.js';
import { chromeTextSource } from './text-source.js';

export function setupChromePlatform(): void {
  configurePlatform({
    vaultFS: chromeVaultFS,
    kv: chromeKV,
    settings: chromeSettings,
    permissions: chromePermissions,
    i18n: chromeI18n,
    assets: chromeAssets,
    textSource: chromeTextSource,
  });
}
