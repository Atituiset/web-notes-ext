/**
 * IndexedDB 封装 (web-notes-ext v1)
 *
 * stores:
 *   pages    keyPath=url
 *   notes    keyPath=id, index:url
 *            note.url 为分级 key（见 lib/url-key.js）：page=页面 key，site=hostname
 *   handles  key=name      (vault FileSystemDirectoryHandle 持久化)
 *   settings key=key
 *
 * 在 service worker 与扩展页面 (panel/options) 中均可使用。
 */
import { lookupKeys } from './url-key.js';

const DB_NAME = 'web-notes-ext';
const DB_VERSION = 3;

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('pages')) {
        db.createObjectStore('pages', { keyPath: 'url' });
      }
      if (!db.objectStoreNames.contains('notes')) {
        const s = db.createObjectStore('notes', { keyPath: 'id' });
        s.createIndex('url', 'url', { unique: false });
      }
      if (!db.objectStoreNames.contains('handles')) {
        db.createObjectStore('handles', { keyPath: 'name' });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('embeddings')) {
        // 语义召回向量缓存 { key: `${model}|${type}|${hash(body)}`, value: number[] }
        db.createObjectStore('embeddings', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('threads')) {
        // 会话线程: { id, title, url, createdAt, updatedAt, messages:[{role,content}] }
        const t = db.createObjectStore('threads', { keyPath: 'id' });
        t.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function tx(store, mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const os = t.objectStore(store);
        let result;
        try {
          result = fn(os);
        } catch (e) {
          reject(e);
          return;
        }
        t.oncomplete = () => resolve(result && '_req' in result ? result._req.result : undefined);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('transaction aborted'));
      })
  );
}

// ---- notes ----

export function putNote(note) {
  return tx('notes', 'readwrite', (os) => os.put(note));
}

export function deleteNote(id) {
  return tx('notes', 'readwrite', (os) => os.delete(id));
}

export function getNote(id) {
  return tx('notes', 'readonly', (os) => {
    const r = os.get(id);
    return { _req: r };
  });
}

export function getNotesByUrl(url) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const out = [];
        const t = db.transaction('notes', 'readonly');
        const idx = t.objectStore('notes').index('url');
        const req = idx.openCursor(IDBKeyRange.only(url));
        req.onsuccess = () => {
          const cur = req.result;
          if (cur) {
            out.push(cur.value);
            cur.continue();
          } else {
            // 按 ts 升序（时间序，上下文构建器依赖）
            out.sort((a, b) => a.ts - b.ts);
            resolve(out);
          }
        };
        req.onerror = () => reject(req.error);
      })
  );
}

/**
 * 取某页面可见的全部笔记：本页 page key + 旧裸 path key + 本站 site key。
 * 调用方传原始 URL（或任一 key），key 归一与集合组装见 lib/url-key.js。
 */
export function getNotesForUrl(url) {
  const keys = lookupKeys(url);
  if (!keys.length) return Promise.resolve([]);
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const byId = new Map();
        const t = db.transaction('notes', 'readonly');
        const idx = t.objectStore('notes').index('url');
        for (const k of keys) {
          const req = idx.openCursor(IDBKeyRange.only(k));
          req.onsuccess = () => {
            const cur = req.result;
            if (cur) {
              byId.set(cur.value.id, cur.value);
              cur.continue();
            }
          };
        }
        t.oncomplete = () =>
          resolve([...byId.values()].sort((a, b) => a.ts - b.ts));
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('transaction aborted'));
      })
  );
}

export function getAllNotes() {
  return tx('notes', 'readonly', (os) => {
    const r = os.getAll();
    return { _req: r };
  });
}

// ---- 备份（全部笔记的 JSON 导出/导入）----

const BACKUP_KIND = 'notes-backup';

/** 导出全部笔记为可 JSON.stringify 的备份对象 */
export async function exportNotesData() {
  return {
    app: 'markpilot',
    kind: BACKUP_KIND,
    version: 1,
    exportedAt: Date.now(),
    notes: await getAllNotes(),
  };
}

/**
 * 导入备份：按 id 覆盖写（put 语义）
 * @returns { total, imported, skipped }  — total 为备份内条目数，skipped 为格式非法跳过数
 */
export async function importNotesData(json) {
  const arr = json && Array.isArray(json.notes) ? json.notes : null;
  if (!arr) throw new Error('invalid backup: notes[] missing');
  let imported = 0, skipped = 0;
  for (const raw of arr) {
    if (
      !raw ||
      typeof raw.id !== 'string' || !raw.id ||
      typeof raw.url !== 'string' || !raw.url ||
      typeof raw.content !== 'string'
    ) {
      skipped++;
      continue;
    }
    const now = Date.now();
    await putNote({ ...raw, ts: +raw.ts || now, updatedAt: +raw.updatedAt || now });
    imported++;
  }
  return { total: arr.length, imported, skipped };
}

// ---- pages ----

export function touchPage(url, title, host) {
  return tx('pages', 'readwrite', (os) =>
    os.put({ url, title, host, lastVisited: Date.now() })
  );
}

export function getPage(url) {
  return tx('pages', 'readonly', (os) => {
    const r = os.get(url);
    return { _req: r };
  });
}

// ---- handles (FileSystemDirectoryHandle 等 Structured Cloneable 值) ----

export function idbPut(store, key, value) {
  if (store === 'handles') return tx('handles', 'readwrite', (os) => os.put({ name: key, handle: value }));
  return tx(store, 'readwrite', (os) => os.put({ key, value }));
}

export function idbGet(store, key) {
  return tx(store, 'readonly', (os) => {
    const r = store === 'handles' ? os.get(key) : os.get(key);
    return { _req: r };
  }).then((row) => {
    if (!row) return null;
    return store === 'handles' ? row.handle : row.value;
  });
}

// ---- settings ----

export async function getSettings() {
  const defaults = {
    provider: 'openai-compatible',
    model: '',
    apiKeys: {},
    baseUrl: '', // 留空 = 用 provider 预设端点；仅 openai-compatible 需手填
    vaultDirTemplate: 'Clippings',
    exportAiQA: false,
    obsidianExportMode: 'fs-access', // 'fs-access' 目录授权 | 'rest-api' Local REST API 插件
    obsidianRestKey: '',             // Local REST API 插件的 API Key
    memoryInject: true,  // 提问时注入长期记忆
    autoMemory: false,   // 自动提取记忆（确认流）
  };
  const stored = (await idbGet('settings', 'app')) || {};
  return Object.assign(defaults, stored);
}

export function saveSettings(patch) {
  return getSettings().then((s) =>
    tx('settings', 'readwrite', (os) => os.put({ key: 'app', value: Object.assign(s, patch) }))
  );
}

// ---- threads (会话历史) ----

export function putThread(thread) {
  return tx('threads', 'readwrite', (os) => os.put(thread));
}

export function getThread(id) {
  return tx('threads', 'readonly', (os) => {
    const r = os.get(id);
    return { _req: r };
  });
}

/**
 * 线程列表（仅元数据，最新在前）。
 * 列表渲染只需 id/title/时间；messages 正文点开线程时走 getThread 单条取。
 * cursor 仍会瞬态反序列化整条记录，但只保留元数据字段，驻留内存与线程体积脱钩。
 */
export function listThreadMeta() {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const out = [];
        const idx = db.transaction('threads', 'readonly').objectStore('threads').index('updatedAt');
        const req = idx.openCursor(null, 'prev'); // 最新在前
        req.onsuccess = () => {
          const cur = req.result;
          if (cur) {
            const v = cur.value;
            out.push({
              id: v.id,
              title: v.title,
              url: v.url,
              createdAt: v.createdAt,
              updatedAt: v.updatedAt,
              msgCount: (v.messages || []).length,
            });
            cur.continue();
          } else resolve(out);
        };
        req.onerror = () => reject(req.error);
      })
  );
}

export function deleteThread(id) {
  return tx('threads', 'readwrite', (os) => os.delete(id));
}
