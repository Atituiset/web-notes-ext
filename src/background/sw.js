/**
 * Service worker: 消息网关（存储/页面记录）。
 *
 * 设计约束：
 * - 自包含（不 import）：MV3 SW 默认按 classic script 注册，避免 module 兼容性问题
 * - LLM 流式请求不经过 SW（DESIGN.md 坑 #3）—— panel 侧直接 fetch，规避 30s 休眠
 *
 * 与 src/lib/db.js 保持同一 schema：
 *   db web-notes-ext v1 / stores: pages(url) notes(id,idx:url) handles(name) settings(key)
 */

const DB_NAME = 'web-notes-ext';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
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
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function putNote(note) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction('notes', 'readwrite');
        t.objectStore('notes').put(note);
        t.oncomplete = resolve;
        t.onerror = () => reject(t.error);
      })
  );
}

function deleteNote(id) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction('notes', 'readwrite');
        t.objectStore('notes').delete(id);
        t.oncomplete = resolve;
        t.onerror = () => reject(t.error);
      })
  );
}

function getNotesByUrl(url) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const out = [];
        const idx = db.transaction('notes', 'readonly').objectStore('notes').index('url');
        const req = idx.openCursor(IDBKeyRange.only(url));
        req.onsuccess = () => {
          const cur = req.result;
          if (cur) {
            out.push(cur.value);
            cur.continue();
          } else {
            out.sort((a, b) => a.ts - b.ts); // 时间序，上下文构建器依赖
            resolve(out);
          }
        };
        req.onerror = () => reject(req.error);
      })
  );
}

function getAllNotes() {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const r = db.transaction('notes', 'readonly').objectStore('notes').getAll();
        r.onsuccess = () => resolve(r.result || []);
        r.onerror = () => reject(r.error);
      })
  );
}

function touchPage(url, title, host) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction('pages', 'readwrite');
        t.objectStore('pages').put({ url, title, host, lastVisited: Date.now() });
        t.oncomplete = resolve;
        t.onerror = () => reject(t.error);
      })
  );
}

chrome.runtime.onInstalled.addListener(() => {
  // 点击工具栏图标打开 side panel
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case 'notes:get': {
          const notes = await getNotesByUrl(msg.url);
          sendResponse({ ok: true, notes });
          break;
        }
        case 'notes:all': {
          const notes = await getAllNotes();
          sendResponse({ ok: true, notes });
          break;
        }
        case 'notes:put': {
          await putNote(msg.note);
          if (msg.note.url) {
            const page = msg.page || {};
            await touchPage(msg.note.url, page.title || '', page.host || '');
          }
          sendResponse({ ok: true });
          break;
        }
        case 'notes:delete': {
          await deleteNote(msg.id);
          sendResponse({ ok: true });
          break;
        }
        case 'page:touch': {
          await touchPage(msg.page.url, msg.page.title || '', msg.page.host || '');
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'unknown message type' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message) });
    }
  })();
  return true; // async response
});
