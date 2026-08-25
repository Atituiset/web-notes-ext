/**
 * 划词标注 content script — notes.js 原型移植
 *
 * 变更点 vs 原型：
 *   - 存储: localStorage → chrome.runtime.sendMessage → SW → IndexedDB
 *   - 容器: #content (mdBook) → article/main 或 body（通用站点）
 *   - 新增: URL 变化监听 (patch pushState + popstate)，SPA 切页时重载高亮 (D5)
 */
(() => {
  'use strict';

  const ROOT_ID = 'wne-root';
  const MARK_CLASS = 'wne-mark';

  // ---------- 页面容器与标识 ----------

  function contentEl() {
    return (
      document.getElementById('content') || // mdBook
      document.querySelector('article, main') ||
      document.body
    );
  }

  function pageUrl() {
    return location.origin + location.pathname;
  }

  function pageTitle() {
    return (
      (document.title || '未命名页面').replace(/\s*[-–—|·].*$/, '').trim() ||
      '未命名页面'
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
    const r = await send({ type: 'notes:get', url: pageUrl() });
    return (r && r.ok && r.notes) || [];
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
    notes.forEach(applyHighlight);
  }

  // ---------- UI ----------

  let pendingSel = null;
  let popState = null; // { id }

  function el(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html !== undefined) n.innerHTML = html;
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
    const selText = selInfo && selInfo.text;
    if (selText) {
      quote.style.display = 'block';
      quote.textContent = '划选: "' + selText + '"';
    } else {
      quote.style.display = 'none';
    }
    pop.classList.add('open');
    ta.focus();
  }

  // 编辑已有笔记：先取内容填入
  async function openPopoverForEdit(id) {
    const notes = await loadNotes();
    const note = notes.find((x) => x.id === id);
    openPopover(id, note && note.sel);
    if (note) document.getElementById('wne-pop-input').value = note.content;
  }

  function closePopover() {
    document.getElementById('wne-pop').classList.remove('open');
    popState = null;
  }

  async function savePopover() {
    if (!popState) return;
    const ta = document.getElementById('wne-pop-input');
    const content = ta.value.trim();
    if (!content) { toast('先写点内容再保存'); return; }
    const now = Date.now();
    if (popState.id) {
      const notes = await loadNotes();
      const note = notes.find((x) => x.id === popState.id);
      if (note) await saveNote(Object.assign({}, note, { content, updatedAt: now }));
    } else {
      await saveNote({
        id: uid(),
        ts: now,
        updatedAt: now,
        url: pageUrl(),
        content,
        sel: pendingSel || null,
        kind: 'manual',
        aiMeta: null,
      });
      pendingSel = null;
    }
    closePopover();
    applyAllMarks();
    toast('已保存');
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
      '.wne-mark{background:rgba(250,204,21,.30);color:inherit;border-bottom:1px solid rgba(250,204,21,.9);border-radius:2px;padding:0 1px;cursor:pointer;}',
      '.wne-mark:hover{background:rgba(250,204,21,.55);}',
      '#wne-selbar{position:fixed;z-index:2147483647;display:none;align-items:center;background:#111827;border-radius:8px;padding:4px 6px;box-shadow:0 4px 14px rgba(0,0,0,.4);font-size:12px;}',
      '#wne-selbar button{background:#2563eb;color:#fff;border:none;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px;}',
      '#wne-selbar button:hover{background:#1d4ed8;}',
      '#wne-pop{position:fixed;left:50%;top:22%;transform:translateX(-50%);width:min(500px,calc(100vw - 32px));background:#fff;color:#1f2937;border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.35);z-index:2147483647;display:none;flex-direction:column;font-family:system-ui,sans-serif;font-size:13px;}',
      '#wne-pop.open{display:flex;}',
      '#wne-pop .wp-head{padding:10px 12px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;gap:8px;border-radius:12px 12px 0 0;}',
      '#wne-pop .wp-head b{flex:1;font-size:14px;color:#111827;}',
      '#wne-pop .wp-head button{border:none;background:none;cursor:pointer;font-size:16px;color:#6b7280;}',
      '#wne-pop .wp-quote{display:none;background:#fffbeb;border-left:3px solid #f59e0b;color:#92400e;font-size:12px;padding:6px 8px;margin:8px 12px 0;max-height:72px;overflow:auto;white-space:pre-wrap;}',
      '#wne-pop textarea{width:calc(100% - 24px);box-sizing:border-box;min-height:110px;margin:10px 12px 0;border:1px solid #d1d5db;border-radius:8px;padding:8px;font:inherit;color:#111827;resize:vertical;}',
      '#wne-pop .wp-ops{display:flex;justify-content:flex-end;gap:8px;padding:10px 12px 12px;}',
      '#wne-pop .wp-ops button{border:1px solid #d1d5db;background:#fff;color:#374151;border-radius:8px;padding:7px 14px;cursor:pointer;font-size:13px;}',
      '#wne-pop .wp-ops button.wp-save{background:#2563eb;color:#fff;border-color:#2563eb;}'
    ].join('\n');
    document.head.appendChild(style);

    const root = el('div');
    root.id = ROOT_ID;

    // 划词工具条
    const selbar = el('div');
    selbar.id = 'wne-selbar';
    const btnNote = el('button', '', '📝 记笔记');
    btnNote.addEventListener('click', () => {
      if (pendingSel) { openPopover(null, pendingSel); hideSelbar(); }
    });
    const btnAsk = el('button', '', '🤖 问 AI');
    btnAsk.style.marginLeft = '6px';
    btnAsk.addEventListener('click', async () => {
      if (!pendingSel) return;
      const selText = pendingSel.text;
      hideSelbar();
      try {
        // 通知 side panel 切到聊天页并预填问题；panel 未开时消息丢失，用户点工具栏图标即可
        chrome.runtime.sendMessage({ type: 'panel:focus-chat', selection: selText }, () => void chrome.runtime.lastError);
      } catch { }
      toast('已发送到侧栏（若侧栏未打开请点击工具栏图标）');
    });
    selbar.appendChild(btnNote);
    selbar.appendChild(btnAsk);

    // 笔记弹窗
    const pop = el('div');
    pop.id = 'wne-pop';
    const head = el('div', 'wp-head', '<b>' + pageTitle() + '</b>');
    const closeBtn = el('button', '', '✕');
    closeBtn.addEventListener('click', closePopover);
    head.appendChild(closeBtn);
    const quote = el('div', 'wp-quote');
    quote.id = 'wne-pop-quote';
    const ta = document.createElement('textarea');
    ta.id = 'wne-pop-input';
    ta.placeholder = '写下你的心得 / 补充… (Markdown 可用)';
    const ops = el('div', 'wp-ops');
    const btnCancel = el('button', '', '取消');
    btnCancel.addEventListener('click', closePopover);
    const btnSave = el('button', 'wp-save', '保存');
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
        selbar.style.display = 'flex';
        let x = Math.max(4, Math.min(rect.left, window.innerWidth - 190));
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
