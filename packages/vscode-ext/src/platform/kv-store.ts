/** KVStore 端口 VS Code 实现 — context.globalState（键加前缀，listKeys 经 keys() 过滤） */
import type * as vscode from 'vscode';
import type { KVStore } from '../../../core/src/ports.js';

const PREFIX = 'markpilot.kv.';

export function makeKVStore(state: vscode.Memento): KVStore {
  return {
    get: async (key) => state.get(PREFIX + key) ?? null,
    set: async (key, value) => {
      await state.update(PREFIX + key, value);
    },
    delete: async (key) => {
      await state.update(PREFIX + key, undefined);
    },
    listKeys: async (prefix) =>
      state.keys().filter((k) => k.startsWith(PREFIX + prefix)).map((k) => k.slice(PREFIX.length)),
  };
}
