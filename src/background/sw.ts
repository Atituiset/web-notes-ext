/**
 * Service worker: 消息网关（存储/页面记录）。
 *
 * 设计约束：
 * - 自包含（不 import）：esbuild 会把依赖打进单文件，bundle 后无 import 语句
 * - LLM 流式请求不经过 SW（DESIGN.md 坑 #3）—— panel 侧直接 fetch，规避 30s 休眠
 * - IndexedDB 逻辑统一走 lib/db.js（连接复用，与 panel/options 同一份实现）
 */

import {
  putNote, deleteNote, getNotesByUrl, getAllNotes, touchPage,
} from '../lib/db.js';

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
        case 'panel:focus-chat': {
          // 页面「问 AI」入口。content script → side panel 直发不可靠
          // （panel 未开时丢失），统一由 SW 接手：
          //   1. 缓冲 pendingAsk —— panel 启动时消费（兜底）
          //   2. 打开侧栏 —— 用户点击的手势 activation 随消息传递到此
          //   3. 转发 panel:ask —— SW → panel 的投递始终可达
          const ask = {
            askId: msg.askId || '',
            selection: msg.selection || '',
            ts: msg.ts || Date.now(),
          };
          await chrome.storage.session.set({ pendingAsk: ask });
          try {
            const winId = sender && sender.tab && sender.tab.windowId;
            if (winId != null) await chrome.sidePanel.open({ windowId: winId });
          } catch { /* 已打开或手势上下文失效 */ }
          // 无接收者时（panel 未加载）sendMessage 会 reject，属预期，启动消费兜底
          chrome.runtime.sendMessage({ type: 'panel:ask', ...ask }).catch(() => {});
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'unknown message type' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String((e as Error)?.message || e) });
    }
  })();
  return true; // async response
});
