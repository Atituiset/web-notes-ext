/**
 * IndexedDB 封装 (web-notes-ext v1)
 *
 * stores:
 *   pages    keyPath=url
 *   notes    keyPath=id, index:url
 *   handles  key=name      (vault FileSystemDirectoryHandle 持久化)
 *   settings key=key
 *
 * 在 service worker 与扩展页面 (panel/options) 中均可使用。
 */
const DB_NAME = 'web-notes-ext';
const DB_VERSION = 2;

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

export function getAllNotes() {
  return tx('notes', 'readonly', (os) => {
    const r = os.getAll();
    return { _req: r };
  });
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

export function listThreads() {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const out = [];
        const idx = db.transaction('threads', 'readonly').objectStore('threads').index('updatedAt');
        const req = idx.openCursor(null, 'prev'); // 最新在前
        req.onsuccess = () => {
          const cur = req.result;
          if (cur) {
            out.push(cur.value);
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
