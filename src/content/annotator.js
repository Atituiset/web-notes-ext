/**
 * 划词标注 content script — notes.js 原型移植
 *
 * 变更点 vs 原型：
 *   - 存储: localStorage → chrome.runtime.sendMessage → SW → IndexedDB
 *   - 容器: #content (mdBook) → article/main 或 body（通用站点）
 *   - 新增: URL 变化监听 (patch pushState + popstate)，SPA 切页时重载高亮 (D5)
 */
import { extractArticle } from '../lib/page-extract.js';
import { msg as t } from '../lib/i18n.js';
import { pageKey, siteKey, matchesPage } from '../lib/url-key.js';

(() => {
  'use strict';

  const ROOT_ID = 'wne-root';
  const MARK_CLASS = 'wne-mark';

  // ---------- panel 侧回读通道（不依赖 activeTab/scripting 授权） ----------
  // tabs.sendMessage 只送达本 tab 的 content script，SW 收不到，无抢答问题
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'page:get-selection') {
      // url/title 一并返回：panel 的 tabs.query 在未授予 activeTab 的站点上
      // 拿不到 url/title（返回空串），content script 不受此限
      sendResponse({
        ok: true,
        selection: String(window.getSelection() || ''),
        url: location.href,
        title: document.title || '',
      });
    } else if (msg.type === 'page:get-text') {
      try {
        sendResponse({ ok: true, text: extractArticle(document).text });
      } catch {
        sendResponse({ ok: false });
      }
    } else if (msg.type === 'translate:chunk') {
      const body = transBubbles.get(msg.reqId);
      if (body && !body.dataset.err) {
        if (body.dataset.streaming !== '1') { body.textContent = ''; body.dataset.streaming = '1'; }
        body.textContent += msg.tok;
      }
    } else if (msg.type === 'translate:error') {
      const body = transBubbles.get(msg.reqId);
      if (body) {
        body.dataset.err = '1';
        body.textContent = t('translateFailed', String(msg.error || ''));
      }
    }
  });

  // ---------- 页面容器与标识 ----------

  function contentEl() {
    return (
      document.getElementById('content') || // mdBook
      document.querySelector('article, main') ||
      document.body
    );
  }

  function pageUrl() {
    return pageKey(location.href);
  }

  function pageTitle() {
    return (
      (document.title || t('untitledPage')).replace(/\s*[-–—|·].*$/, '').trim() ||
      t('untitledPage')
    );
  }

  function uid() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    const p = (n) => (n < 10 ? '0' : '') + n;
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // ---------- 与 SW 的消息通道 ----------

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          void chrome.runtime.lastError; // 扩展重载等场景静默失败
          resolve(r || { ok: false });
        });
      } catch {
        resolve({ ok: false });
      }
    });
  }

  async function loadNotes() {
    const r = await send({ type: 'notes:get', url: location.href });
    return (r && r.ok && r.notes) || [];
  }

  // 高亮只画与当前页同 page key 的笔记（本站笔记回源页才画，靠 originUrl 匹配）
  function highlightable(notes) {
    return notes.filter(
      (n) => matchesPage(n.url, location.href) || (n.originUrl && matchesPage(n.originUrl, location.href))
    );
  }

  function saveNote(note) {
    return send({
      type: 'notes:put',
      note,
      page: { title: pageTitle(), host: location.hostname },
    });
  }

  function removeNote(id) {
    return send({ type: 'notes:delete', id });
  }

  // ---------- 选中文本 <-> 字符偏移（继承 notes.js）----------

  function textLengthUpTo(boundaryNode, boundaryOffset) {
    const container = contentEl();
    if (boundaryNode.nodeType === 3) {
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      let total = 0, n;
      while ((n = walker.nextNode())) {
        if (n === boundaryNode) return total + Math.min(boundaryOffset, n.nodeValue.length);
        total += n.nodeValue.length;
      }
      return total;
    }
    let prefix = 0;
    for (let i = 0; i < boundaryOffset && i < boundaryNode.childNodes.length; i++) {
      const c = boundaryNode.childNodes[i];
      if (c.nodeType === 1) prefix += c.textContent.length;
      else if (c.nodeType === 3) prefix += c.nodeValue.length;
    }
    let total2 = 0, m;
    const walker2 = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    while ((m = walker2.nextNode())) {
      if (boundaryNode.contains(m)) return total2 + prefix;
      total2 += m.nodeValue.length;
    }
    return total2 + prefix;
  }

  function captureSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const container = contentEl();
    if (!container.contains(range.commonAncestorContainer)) return null;
    let start = textLengthUpTo(range.startContainer, range.startOffset);
    let end = textLengthUpTo(range.endContainer, range.endOffset);
    if (start > end) { const t = start; start = end; end = t; }
    if (end <= start) return null;
    const text = range.toString().replace(/\s+/g, ' ').trim();
    if (!text) return null;
    return { start, end, text: text.slice(0, 300) };
  }

  function applyHighlight(note) {
    if (!note.sel || typeof note.sel.start !== 'number') return;
    const { start, end } = note.sel;
    if (end <= start) return;
    // 快照全部文本节点再包裹，避免活 TreeWalker 重访刚包裹的节点（原型经验）
    const walker = document.createTreeWalker(contentEl(), NodeFilter.SHOW_TEXT);
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    let pos = 0;
    for (const node of nodes) {
      const len = node.nodeValue.length;
      const nodeStart = pos;
      pos += len;
      if (pos <= start || nodeStart >= end) continue;
      const s = Math.max(0, start - nodeStart);
      const e = Math.min(len, end - nodeStart);
      if (e <= s) continue;
      try {
        const mark = document.createElement('mark');
        mark.className = MARK_CLASS;
        mark.dataset.id = note.id;
        mark.title = (note.content || '').slice(0, 100);
        const r = document.createRange();
        r.setStart(node, s);
        r.setEnd(node, e);
        r.surroundContents(mark);
      } catch {
        /* 无法包裹的节点跳过；笔记数据无损 (D5) */
      }
    }
  }

  function unwrapMarks(id) {
    const marks = document.querySelectorAll('.' + MARK_CLASS);
    for (let i = marks.length - 1; i >= 0; i--) {
      const m = marks[i];
      if (id && m.dataset.id !== id) continue;
      const parent = m.parentNode;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
    }
  }

  async function applyAllMarks() {
    unwrapMarks();
    const notes = await loadNotes();
    highlightable(notes).forEach(applyHighlight);
  }

  // ---------- UI ----------

  let pendingSel = null;
  let pendingTranslate = null; // { text, rect } — 划词翻译用（原文上限比笔记引用长）
  let popState = null; // { id }

  // ---------- 划词翻译浮窗 ----------

  let transSeq = 0;
  const transBubbles = new Map(); // reqId -> 正文元素

  function openTranslateBubble(info) {
    const reqId = 't' + (++transSeq) + '-' + Date.now().toString(36);
    const box = el('div', 'wne-trans');
    const head = el('div', 'wt-head');
    head.appendChild(el('b', '', t('btnTranslate')));
    const closeBtn = el('button', '', '✕');
    closeBtn.addEventListener('click', () => {
      box.remove();
      transBubbles.delete(reqId);
    });
    head.appendChild(closeBtn);
    const body = el('div', 'wt-body', t('translating'));
    box.appendChild(head);
    box.appendChild(body);
    const r = info.rect;
    box.style.left = Math.max(4, Math.min(r.left, window.innerWidth - 380)) + 'px';
    box.style.top = r.bottom + 8 + 'px';
    document.getElementById(ROOT_ID).appendChild(box);
    // 底部溢出视口时翻到选区上方
    const bh = box.offsetHeight;
    if (r.bottom + 8 + bh > window.innerHeight) {
      box.style.top = Math.max(4, r.top - bh - 8) + 'px';
    }
    transBubbles.set(reqId, body);
    return reqId;
  }

  async function runTranslate() {
    if (!pendingTranslate) return;
    const info = pendingTranslate;
    hideSelbar();
    const reqId = openTranslateBubble(info);
    const r = await send({ type: 'translate:run', reqId, text: info.text });
    // 流式错误经 translate:error 推送；此处仅兜底消息通道本身的失败（如 SW 未就绪）
    const body = transBubbles.get(reqId);
    if ((!r || !r.ok) && body && body.dataset.streaming !== '1' && !body.dataset.err) {
      body.dataset.err = '1';
      body.textContent = t('translateFailed', (r && r.error) || '');
    }
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    // 一律 textContent：页面标题等是不可信输入，innerHTML 会被注入（CWS 审核也查这个）
    if (text !== undefined) n.textContent = text;
    return n;
  }

  let toastTimer = null;
  function toast(msg) {
    let t = document.getElementById('wne-toast');
    if (!t) {
      t = el('div');
      t.id = 'wne-toast';
      t.style.cssText =
        'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#111827;color:#f9fafb;padding:8px 16px;border-radius:8px;font-size:13px;z-index:2147483646;box-shadow:0 4px 12px rgba(0,0,0,.35);opacity:0;transition:opacity .25s;pointer-events:none;max-width:80vw;';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.style.opacity = '0'), 2200);
  }

  function openPopover(id, selInfo) {
    popState = { id: id || null };
    const pop = document.getElementById('wne-pop');
    const quote = document.getElementById('wne-pop-quote');
    const ta = document.getElementById('wne-pop-input');
    ta.value = '';
    ta.dataset.editing = id ? '1' : '';
    document.getElementById('wne-pop-site').checked = false;
    const selText = selInfo && selInfo.text;
    if (selText) {
      quote.style.display = 'block';
      quote.textContent = t('selQuotePrefix', selText);
    } else {
      quote.style.display = 'none';
    }
    pop.classList.add('open');
    ta.focus();
  }

  // 编辑已有笔记：先取内容填入（site 级勾选态同步）
  async function openPopoverForEdit(id) {
    const notes = await loadNotes();
    const note = notes.find((x) => x.id === id);
    openPopover(id, note && note.sel);
    if (note) {
      document.getElementById('wne-pop-input').value = note.content;
      document.getElementById('wne-pop-site').checked = note.scope === 'site';
    }
  }

  function closePopover() {
    document.getElementById('wne-pop').classList.remove('open');
    popState = null;
  }

  async function savePopover() {
    if (!popState) return;
    const ta = document.getElementById('wne-pop-input');
    const content = ta.value.trim();
    if (!content) { toast(t('noteEmptyWarn')); return; }
    const now = Date.now();
    const scope = document.getElementById('wne-pop-site').checked ? 'site' : 'page';
    const url = scope === 'site' ? siteKey(location.href) : pageUrl();
    if (popState.id) {
      const notes = await loadNotes();
      const note = notes.find((x) => x.id === popState.id);
      if (note) {
        await saveNote(Object.assign({}, note, {
          content, updatedAt: now, scope, url,
          // 回源页信息只增不改：site 级笔记靠它在原页面恢复高亮
          originUrl: note.originUrl || pageUrl(),
        }));
      }
    } else {
      await saveNote({
        id: uid(),
        ts: now,
        updatedAt: now,
        scope,
        url,
        originUrl: pageUrl(),
        content,
        sel: pendingSel || null,
        kind: 'manual',
        aiMeta: null,
      });
      pendingSel = null;
    }
    closePopover();
    applyAllMarks();
    toast(t('noteSaved'));
  }

  function hideSelbar() {
    const bar = document.getElementById('wne-selbar');
    if (bar) bar.style.display = 'none';
  }

  // ---------- SPA URL 监听 (D5) ----------

  function onUrlChange() {
    unwrapMarks(); // 先卸载旧高亮
    setTimeout(applyAllMarks, 300); // 等 DOM 稳定后重载对应页笔记
  }

  function patchHistory() {
    const origPush = history.pushState;
    history.pushState = function () {
      origPush.apply(this, arguments);
      onUrlChange();
    };
    window.addEventListener('popstate', onUrlChange);
  }

  // ---------- init ----------

  function init() {
    if (document.getElementById(ROOT_ID)) return;

    const style = document.createElement('style');
    style.textContent = [
      '.wne-mark{background:rgba(250,204,21,.30);color:inherit;border-bottom:2px solid rgba(250,204,21,.9);border-radius:2px;padding:0 1px;cursor:pointer;transition:background .15s;}',
      '.wne-mark:hover{background:rgba(250,204,21,.55);}',
      '#wne-selbar{position:fixed;z-index:2147483647;display:none;align-items:center;background:rgba(17,24,39,.92);backdrop-filter:blur(8px);border-radius:12px;padding:5px 7px;box-shadow:0 8px 24px rgba(0,0,0,.35);font-size:12px;}',
      '#wne-selbar button{background:#2563eb;color:#fff;border:none;border-radius:8px;padding:5px 12px;cursor:pointer;font-size:12px;font-weight:600;transition:background .15s;}',
      '#wne-selbar button:hover{background:#1d4ed8;}',
      '#wne-pop{position:fixed;left:50%;top:22%;transform:translateX(-50%);width:min(520px,calc(100vw - 32px));background:#fff;color:#1f2937;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.30);z-index:2147483647;display:none;flex-direction:column;font-family:system-ui,sans-serif;font-size:13px;overflow:hidden;}',
      '#wne-pop.open{display:flex;}',
      '#wne-pop .wp-head{padding:12px 14px;background:#f8fafc;border-bottom:1px solid #eef0f4;display:flex;align-items:center;gap:8px;}',
      '#wne-pop .wp-head b{flex:1;font-size:14px;color:#111827;}',
      '#wne-pop .wp-head button{border:none;background:none;cursor:pointer;font-size:16px;color:#98a0ad;border-radius:6px;padding:0 4px;}',
      '#wne-pop .wp-head button:hover{color:#374151;background:#eef0f4;}',
      '#wne-pop .wp-quote{display:none;background:#fdf6e3;border-left:3px solid #f0c96a;color:#92400e;font-size:12px;padding:6px 10px;margin:10px 14px 0;max-height:72px;overflow:auto;white-space:pre-wrap;border-radius:0 8px 8px 0;}',
      '#wne-pop textarea{width:calc(100% - 28px);box-sizing:border-box;min-height:110px;margin:10px 14px 0;border:1px solid #d3d8e0;border-radius:10px;padding:9px 10px;font:inherit;color:#111827;resize:vertical;transition:border-color .15s,box-shadow .15s;}',
      '#wne-pop textarea:focus{outline:none;border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.15);}',
      '#wne-pop .wp-ops{display:flex;justify-content:flex-end;align-items:center;gap:8px;padding:12px 14px 14px;}',
      '#wne-pop .wp-site{margin-right:auto;display:flex;align-items:center;gap:5px;font-size:12.5px;color:#67707f;cursor:pointer;user-select:none;}',
      '#wne-pop .wp-site input{accent-color:#2563eb;margin:0;cursor:pointer;}',
      '#wne-pop .wp-ops button{border:1px solid #e4e7ec;background:#fff;color:#67707f;border-radius:10px;padding:7px 16px;cursor:pointer;font-size:13px;transition:all .15s;}',
      '#wne-pop .wp-ops button:hover{color:#2563eb;border-color:#c2d6fb;background:#eaf1fe;}',
      '#wne-pop .wp-ops button.wp-save{background:#2563eb;color:#fff;border-color:#2563eb;font-weight:600;}',
      '#wne-pop .wp-ops button.wp-save:hover{background:#1d4ed8;border-color:#1d4ed8;}',
      '.wne-trans{position:fixed;z-index:2147483647;width:min(360px,calc(100vw - 24px));background:#fff;color:#1f2937;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.28);font-family:system-ui,sans-serif;font-size:13px;overflow:hidden;}',
      '.wne-trans .wt-head{display:flex;align-items:center;padding:7px 12px;background:#f0f9ff;border-bottom:1px solid #e5eef6;}',
      '.wne-trans .wt-head b{flex:1;font-size:12.5px;color:#0369a1;}',
      '.wne-trans .wt-head button{border:none;background:none;cursor:pointer;font-size:14px;color:#98a0ad;border-radius:6px;padding:0 4px;}',
      '.wne-trans .wt-head button:hover{color:#374151;background:#e0f2fe;}',
      '.wne-trans .wt-body{padding:10px 12px;line-height:1.65;white-space:pre-wrap;max-height:300px;overflow:auto;}',
      '.wne-trans .wt-body[data-err]{color:#b91c1c;}'
    ].join('\n');
    document.head.appendChild(style);

    const root = el('div');
    root.id = ROOT_ID;

    // 划词工具条
    const selbar = el('div');
    selbar.id = 'wne-selbar';
    const btnNote = el('button', '', t('btnNote'));
    btnNote.addEventListener('click', () => {
      if (pendingSel) { openPopover(null, pendingSel); hideSelbar(); }
    });
    const btnAsk = el('button', '', t('btnAsk'));
    btnAsk.style.marginLeft = '6px';
    btnAsk.addEventListener('click', async () => {
      if (!pendingSel) return;
      const selText = pendingSel.text;
      hideSelbar();
      // 发给 SW：缓冲 pendingAsk（panel 未开时的兜底）+ 打开侧栏 + 转发给 panel。
      // 直接发给 panel 不可靠——panel 未开时消息丢失，且部分版本
      // content script → side panel 的消息投递不到（SW 转发则始终可达）。
      const r = await send({
        type: 'panel:focus-chat',
        selection: selText,
        askId: uid(),
        ts: Date.now(),
      });
      toast(r && r.ok ? t('sentToPanel') : t('sendFailedHint'));
    });
    selbar.appendChild(btnNote);
    selbar.appendChild(btnAsk);
    const btnTranslate = el('button', '', t('btnTranslate'));
    btnTranslate.style.marginLeft = '6px';
    btnTranslate.addEventListener('click', runTranslate);
    selbar.appendChild(btnTranslate);

    // 笔记弹窗
    const pop = el('div');
    pop.id = 'wne-pop';
    const head = el('div', 'wp-head');
    head.appendChild(el('b', '', pageTitle()));
    const closeBtn = el('button', '', '✕');
    closeBtn.addEventListener('click', closePopover);
    head.appendChild(closeBtn);
    const quote = el('div', 'wp-quote');
    quote.id = 'wne-pop-quote';
    const ta = document.createElement('textarea');
    ta.id = 'wne-pop-input';
    ta.placeholder = t('notePlaceholder');
    const ops = el('div', 'wp-ops');
    const scopeLbl = el('label', 'wp-site');
    const siteChk = document.createElement('input');
    siteChk.type = 'checkbox';
    siteChk.id = 'wne-pop-site';
    scopeLbl.appendChild(siteChk);
    scopeLbl.appendChild(el('span', '', t('scopeSiteChk')));
    ops.appendChild(scopeLbl);
    const btnCancel = el('button', '', t('btnCancel'));
    btnCancel.addEventListener('click', closePopover);
    const btnSave = el('button', 'wp-save', t('btnSave'));
    btnSave.addEventListener('click', savePopover);
    ops.appendChild(btnCancel);
    ops.appendChild(btnSave);
    pop.appendChild(head);
    pop.appendChild(quote);
    pop.appendChild(ta);
    pop.appendChild(ops);

    root.appendChild(selbar);
    root.appendChild(pop);
    document.body.appendChild(root);

    // 事件
    document.addEventListener('mouseup', (e) => {
      if (e.target && e.target.closest && e.target.closest('#' + ROOT_ID)) return;
      const sel = window.getSelection();
      const container = contentEl();
      if (!sel || sel.isCollapsed) { hideSelbar(); return; }
      if (!container.contains(sel.anchorNode) || !container.contains(sel.focusNode)) { hideSelbar(); return; }
      const cap = captureSelection();
      if (!cap) { hideSelbar(); return; }
      pendingSel = cap;
      let rect = null;
      try { rect = sel.getRangeAt(0).getBoundingClientRect(); } catch { rect = null; }
      if (rect && rect.width > 0) {
        // 翻译用原文：不压空白、上限 2000（笔记引用的 300 字上限对段落翻译太短）
        const rawText = String(sel).trim();
        pendingTranslate = rawText ? { text: rawText.slice(0, 2000), rect } : null;
        selbar.style.display = 'flex';
        let x = Math.max(4, Math.min(rect.left, window.innerWidth - 260));
        let y = rect.bottom + 6;
        if (y + 34 > window.innerHeight) y = Math.max(4, rect.top - 34);
        selbar.style.left = x + 'px';
        selbar.style.top = y + 'px';
      }
    });

    document.addEventListener('mousedown', (e) => {
      if (!(e.target && e.target.closest && e.target.closest('#' + ROOT_ID))) hideSelbar();
    });
    window.addEventListener('scroll', hideSelbar, true);
    window.addEventListener('resize', hideSelbar);

    document.addEventListener('click', (e) => {
      if (e.target && e.target.closest && e.target.closest('#' + ROOT_ID)) return;
      const mark = e.target && e.target.closest ? e.target.closest('.' + MARK_CLASS) : null;
      if (mark) {
        e.preventDefault();
        openPopoverForEdit(mark.dataset.id);
        return;
      }
      closePopover();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closePopover();
    });

    patchHistory();

    // 首次加载应用高亮（等动态渲染完成）
    const applyAfterLoad = () => setTimeout(applyAllMarks, 400);
    if (document.readyState === 'complete') applyAfterLoad();
    else window.addEventListener('load', applyAfterLoad);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
