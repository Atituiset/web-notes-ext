/**
 * Service worker: 消息网关（存储/页面记录）。
 *
 * 设计约束：
 * - 自包含（不 import）：esbuild 会把依赖打进单文件，bundle 后无 import 语句
 * - LLM 流式请求不经过 SW（DESIGN.md 坑 #3）—— panel 侧直接 fetch，规避 30s 休眠
 * - IndexedDB 逻辑统一走 lib/db.js（连接复用，与 panel/options 同一份实现）
 */

import {
  putNote, deleteNote, getNotesForUrl, getAllNotes, touchPage, getSettings,
} from '../lib/db.js';
import { streamChat } from '../lib/llm/index.js';

chrome.runtime.onInstalled.addListener((details) => {
  // 点击工具栏图标打开 side panel
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  // 首次安装打开设置页（选 provider/模型），降低上手门槛
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case 'notes:get': {
          // 分级检索：本页 key（含 query 白名单）+ 旧裸 path + 本站 site key
          const notes = await getNotesForUrl(msg.url);
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
          // 页面档案用真实页面 URL（site 级笔记的 url 是裸域名，不入 pages 表）
          const pageUrl = msg.note.originUrl || msg.note.url;
          if (pageUrl && /^https?:/.test(pageUrl)) {
            const page = msg.page || {};
            await touchPage(pageUrl, page.title || '', page.host || '');
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
        case 'translate:run': {
          // 划词一键翻译：文本短（≤2000 字符），流式几秒内结束，SW 休眠风险低；
          // 仍加保活心跳覆盖推理模型的长 TTFB。token 经 tabs.sendMessage 回推页面。
          const tabId = sender && sender.tab && sender.tab.id;
          const reqId = String(msg.reqId || '');
          const text = String(msg.text || '').slice(0, 2000);
          const notify = (payload: any) => {
            if (tabId != null) chrome.tabs.sendMessage(tabId, payload).catch(() => {});
          };
          if (!text || tabId == null) {
            sendResponse({ ok: false, error: 'empty text' });
            break;
          }
          // 保活：每次 chrome API 调用都会重置 SW 的 30s 空闲计时
          const keepAlive = setInterval(() => {
            chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
          }, 20000);
          try {
            const settings = await getSettings();
            const uiLang = chrome.i18n.getUILanguage();
            let langName = uiLang;
            try {
              langName = new Intl.DisplayNames([uiLang], { type: 'language' }).of(uiLang) || uiLang;
            } catch { /* 未知语言码时直接用码本身，模型同样认 */ }
            await streamChat({
              settings,
              messages: [
                {
                  role: 'system',
                  content:
                    `You are a translation engine. Translate the user's text into ${langName} (${uiLang}). ` +
                    'Preserve the original meaning and formatting. Output only the translation — no explanations, no quotes.',
                },
                { role: 'user', content: text },
              ],
              onToken: (tok) => notify({ type: 'translate:chunk', reqId, tok }),
            });
            notify({ type: 'translate:done', reqId });
            sendResponse({ ok: true });
          } catch (e) {
            const err = String((e as Error)?.message || e);
            notify({ type: 'translate:error', reqId, error: err });
            sendResponse({ ok: false, error: err });
          } finally {
            clearInterval(keepAlive);
          }
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
