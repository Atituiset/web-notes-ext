/**
 * Service worker: 消息网关（存储/页面记录）。
 *
 * 注意 (DESIGN.md 坑 #3)：LLM 流式请求不经过 SW —— panel 侧直接 fetch，
 * 避免 MV3 SW 30s 休眠打断长流。SW 只做轻量存储协调。
 */
import { putNote, deleteNote, getNotesByUrl, getAllNotes, touchPage } from '../lib/db.js';

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
