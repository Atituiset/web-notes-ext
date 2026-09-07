/** SettingsStore 端口 chrome 实现 — IndexedDB settings store（形状/默认值逻辑在 db.js） */
import type { SettingsStore } from '../../../core/src/ports.js';
import { getSettings, saveSettings } from '../lib/db.js';

export const chromeSettings: SettingsStore = {
  getSettings: () => getSettings(),
  saveSettings: (patch) => saveSettings(patch),
};
