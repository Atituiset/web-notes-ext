/** KVStore 端口 chrome 实现 — IndexedDB embeddings store（向量缓存） */
import type { KVStore } from '../../../core/src/ports.js';
import { idbGet, idbPut, idbDelete, idbKeys } from '../lib/db.js';

const STORE = 'embeddings';

export const chromeKV: KVStore = {
  get: (key) => idbGet(STORE, key),
  set: async (key, value) => {
    await idbPut(STORE, key, value);
  },
  delete: (key) => idbDelete(STORE, key),
  listKeys: async (prefix) =>
    ((await idbKeys(STORE)) || []).map(String).filter((k) => k.startsWith(prefix)),
};
