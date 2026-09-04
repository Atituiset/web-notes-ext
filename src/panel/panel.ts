/**
 * Side panel: 本页笔记列表 + LLM 流式问答
 *
 * LLM fetch 直接在 panel 侧执行（DESIGN.md 坑 #3：不经过 SW，规避休眠）。
 * 问答业务逻辑在 lib/chat-pipeline.ts，本文件只做渲染与事件绑定。
 */
import { getSettings, putThread, getThread, listThreads, deleteThread } from '../lib/db.js';
import {
  BUDGET,
  buildLlmMessages,
  recentHistory,
  extractPageText,
  requestSitePermission,
  saveAiQaNote,
  runStream,
} from '../lib/chat-pipeline.js';
import { renderMarkdown } from '../lib/markdown-render.js';
import { saveMemory, listMemories, deleteMemory, pinMemory, isCold } from '../lib/memory.js';
import { extractAndStore, proposeExtraction, storeProposed } from '../lib/memory-extract.js';
import {
  getVaultHandle, exportViaFsAccess, vaultPermissionState,
  ensureVaultPermission, exportViaUri, fileNameFor,
} from '../lib/obsidian.js';
import { renderPageMarkdown, noteToMarkdown } from '../lib/markdown.js';
import { pageKey, siteKey } from '../lib/url-key.js';
import { msg as t, applyI18n } from '../lib/i18n.js';
import { initEmbedding } from '../lib/embedding.js';

const $ = (id: string): any => document.getElementById(id);
let tab = 'notes';

function send(msg): Promise<any> {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

async function activeTabInfo() {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!t) return null;
  let selection = '', csUrl = '', csTitle = '';
  try {
    // 走 content script 回读，不依赖 activeTab/scripting 授权（切 tab 后授权常失效；
    // 未授权时 tabs.query 的 url/title 也是空串，同样由 content script 兜底）
    const r = await chrome.tabs.sendMessage(t.id!, { type: 'page:get-selection' });
    selection = (r && r.selection) || '';
    csUrl = (r && r.url) || '';
    csTitle = (r && r.title) || '';
  } catch { /* 受限页面或 content script 未注入 */ }
  return { tab: t, url: t.url || csUrl, title: t.title || csTitle, selection };
}

// ---------- 笔记列表（本页 / 本站 两级分组） ----------

async function renderNotes() {
  const main = $('main');
  main.textContent = '';
  const info = await activeTabInfo();
  if (!info) { main.appendChild(el('div', 'empty', t('noActiveTab'))); return; }
  // SW 侧按分级 key 检索（本页 + 旧裸 path + 本站），这里只负责分组展示
  const r = await send({ type: 'notes:get', url: info.url });
  const notes = (r && r.ok && r.notes) || [];
  const pageNotes = notes.filter((n) => n.scope !== 'site');
  const siteNotes = notes.filter((n) => n.scope === 'site');
  $('btn-export').textContent = t('exportPageCount', pageNotes.length);
  if (!notes.length) {
    main.appendChild(el('div', 'empty', t('noNotesYet')));
    return;
  }
  if (pageNotes.length) {
    main.appendChild(el('div', 'sec-h', t('pageNotesTitle', pageNotes.length)));
    for (const n of [...pageNotes].reverse()) main.appendChild(noteItem(n, info.url));
  }
  if (siteNotes.length) {
    main.appendChild(el('div', 'sec-h', t('siteNotesTitle', siteKey(info.url), siteNotes.length)));
    for (const n of [...siteNotes].reverse()) main.appendChild(noteItem(n, info.url));
  }
}

function el(tag: string, cls?: string, text?: string): any {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function noteItem(n, curUrl) {
  const d = el('div', 'item');
  const meta = el('div', 'meta');
  meta.appendChild(el('span', '', new Date(n.ts).toLocaleString()));
  if (n.kind === 'ai-qa') meta.appendChild(el('span', '', t('aiTag')));
  if (n.scope === 'site') meta.appendChild(el('span', 'scope-tag', t('siteTag')));
  d.appendChild(meta);
  if (n.sel && n.sel.text) d.appendChild(el('div', 'quote', '"' + n.sel.text + '"'));
  d.appendChild(el('div', 'text', n.content));
  const ops = el('div', 'ops');
  // 层级切换：page ↔ site（本站笔记回到某页时落回当前页/回源页）
  const btnScope = el('button', '', n.scope === 'site' ? t('scopeToPage') : t('scopeToSite'));
  btnScope.onclick = async () => {
    const updatedAt = Date.now();
    if (n.scope === 'site') {
      const page = (n.originUrl && siteKey(n.originUrl) === siteKey(curUrl)) ? n.originUrl : pageKey(curUrl);
      await send({ type: 'notes:put', note: Object.assign({}, n, { scope: 'page', url: page, originUrl: page, updatedAt }) });
    } else {
      await send({ type: 'notes:put', note: Object.assign({}, n, { scope: 'site', url: siteKey(n.url), originUrl: n.originUrl || n.url, updatedAt }) });
    }
    renderNotes();
  };
  const btnCopy = el('button', '', t('copyBtn'));
  btnCopy.onclick = () => navigator.clipboard.writeText(n.content).then(() => toast(t('copied')));
  const btnDel = el('button', 'danger', t('deleteBtn'));
  btnDel.onclick = async () => {
    await send({ type: 'notes:delete', id: n.id });
    renderNotes();
  };
  ops.appendChild(btnScope);
  ops.appendChild(btnCopy);
  ops.appendChild(btnDel);
  d.appendChild(ops);
  return d;
}

function toast(msg) {
  let t = $('wne-panel-toast');
  if (!t) {
    t = el('div');
    t.id = 'wne-panel-toast';
    t.style.cssText = 'position:absolute;bottom:110px;left:50%;transform:translateX(-50%);background:#111827;color:#fff;padding:6px 14px;border-radius:8px;font-size:12px;z-index:99;opacity:0;transition:opacity .25s;pointer-events:none;';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.style.opacity = '0'), 2000);
}

// ---------- 导出 ----------

/** 收集本页导出材料（url/笔记/正文），失败时 toast 并返回 null。导出仅含本页笔记，不带本站笔记（避免 vault 里逐页重复） */
async function gatherExportData() {
  const info = await activeTabInfo();
  if (!info || !/^https?:/.test(info.url)) { toast(t('pageNotExportable')); return null; }
  const pageUrl = pageKey(info.url);
  const r = await send({ type: 'notes:get', url: info.url });
  const notes = ((r && r.ok && r.notes) || []).filter((n) => n.scope !== 'site');

  let pageMarkdown = '';
  try {
    const text = await extractPageText(info.tab.id as number);
    pageMarkdown = (text || '').slice(0, BUDGET.pageTextMaxChars);
  } catch { /* 提取失败则只导笔记 */ }
  return { info, pageUrl, notes, pageMarkdown };
}

$('btn-export').addEventListener('click', async () => {
  const data = await gatherExportData();
  if (!data) return;
  const { info, pageUrl, notes, pageMarkdown } = data;

  const state = await vaultPermissionState();
  if (state === 'granted') {
    try {
      const out = await exportViaFsAccess({ url: pageUrl, title: info.title, notes, pageMarkdown });
      toast(t('exportOk', out.file));
      return;
    } catch (e: any) {
      appendError(t('exportFailed', e.message));
      return;
    }
  }
  if (state === 'no-handle' || state === 'prompt') {
    // 需要一次用户手势 → 此点击即是手势，直接请求授权
    try {
      if (state === 'no-handle') await import('../lib/obsidian.js').then((m) => m.pickVault());
      else await ensureVaultPermission();
      const out = await exportViaFsAccess({ url: pageUrl, title: info.title, notes, pageMarkdown });
      toast(t('exportOk', out.file));
    } catch (e: any) {
      appendError(t('exportAuthFailed', e.message));
    }
    return;
  }
});

// 直接下载为 .md 文件（与 Obsidian 导出同格式，无需 vault 授权）
$('btn-download').addEventListener('click', async () => {
  const data = await gatherExportData();
  if (!data) return;
  const notesMd = data.notes.map(noteToMarkdown).join('\n\n');
  const md = renderPageMarkdown('', {
    source: data.pageUrl,
    title: data.info.title || data.pageUrl,
    updated: Date.now(),
    tags: ['web-notes'],
  }, notesMd, data.pageMarkdown);
  const file = fileNameFor(data.pageUrl, data.info.title || data.pageUrl);
  const blobUrl = URL.createObjectURL(new Blob([md], { type: 'text/markdown;charset=utf-8' }));
  const a = el('a');
  a.href = blobUrl;
  a.download = file;
  a.click();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
  toast(t('downloadOk', file));
});

function appendError(msg) {
  const box = el('div', 'err', msg);
  $('main').prepend(box);
  setTimeout(() => box.remove(), 8000);
}

// ---------- 聊天（会话线程化）----------

const STARTERS = [
  { icon: '📄', text: t('starter1') },
  { icon: '❓', text: t('starter2') },
  { icon: '🤔', text: t('starter3') },
  { icon: '🧭', text: t('starter4') },
];

interface Thread { id: string; title: string; url: string; createdAt: number; updatedAt: number; messages: any[]; }
let currentThread: Thread | null = null;

function uid() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function ensureThread(): Thread {
  if (currentThread) return currentThread;
  const t: Thread = {
    id: uid(),
    title: '',
    url: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  };
  currentThread = t;
  return t;
}

async function persistThread() {
  if (!currentThread || !currentThread.messages.length) return;
  await putThread(JSON.parse(JSON.stringify(currentThread)));
}

async function renderChat() {
  const main = $('main');
  main.textContent = '';
  const settings = await getSettings();
  $('model-hint').textContent = settings.provider + ':' + (settings.model || t('modelNotConfigured'));
  $('btn-new-chat').style.display = chatStarted ? 'inline-block' : 'none';

  if (!chatStarted) {
    // 欢迎屏 + conversation starters
    const hero = el('div', 'empty');
    hero.appendChild(el('div', '', t('chatWelcome')));
    main.appendChild(hero);
    const grid = el('div', 'starters');
    for (const s of STARTERS) {
      const b = el('button', 'starter', s.icon + ' ' + s.text);
      b.addEventListener('click', () => askLLMWith(s.text, $('chat-scope').value));
      grid.appendChild(b);
    }
    main.appendChild(grid);
  }
}

async function loadThreadList() {
  // 会话历史下拉
  const wrap = $('thread-list');
  wrap.textContent = '';
  const threads = await listThreads();
  if (!threads.length) { wrap.style.display = 'none'; return; }
  for (const t of threads.slice(0, 15)) {
    const item = el('div', 'thread-item');
    item.appendChild(el('span', 'thread-title', t.title || t('untitledThread')));
    const btnDel = el('button', 'thread-del', '✕');
    btnDel.title = t('deleteThreadTitle');
    btnDel.onclick = async (e) => {
      e.stopPropagation();
      await deleteThread(t.id);
      if (currentThread && currentThread.id === t.id) { currentThread = null; chatStarted = false; renderChat(); }
      loadThreadList();
    };
    item.appendChild(btnDel);
    item.addEventListener('click', async () => {
      if (streaming) { toast(t('streamingWait')); return; }
      const full = await getThread(t.id);
      if (!full) return;
      currentThread = full;
      chatStarted = true;
      redrawThread();
      $('thread-list').style.display = 'none';
    });
    wrap.appendChild(item);
  }
  wrap.style.display = 'block';
}

function redrawThread() {
  const main = $('main');
  main.textContent = '';
  if (!currentThread) return;
  for (const m of currentThread.messages) {
    const d = addMsg(m.role, '');
    const bodyEl = d.querySelector('.body');
    if (m.role === 'assistant') {
      const bodyEl2 = d.querySelector('.body');
      bodyEl2.textContent = '';
      if (m.reasoning) {
        const think = el('details', 'thinking');
        think.appendChild(el('summary', '', t('thinkingSummary')));
        const tb = el('div', 'thinking-body');
        tb.textContent = m.reasoning;
        think.appendChild(tb);
        bodyEl2.appendChild(think);
      }
      const holder = el('div');
      bodyEl2.appendChild(holder);
      renderMarkdownInto(holder, m.content);
      d.classList.add('done');
      attachMsgOps(d, { answer: () => m.content, question: m.question || '', scope: 'page', readonly: true });
    } else {
      bodyEl.textContent = m.content;
    }
  }
  scrollBottom();
}

// ---------- 发送 / 停止（单 handler 状态机，无 listener 增删竞态）----------

let streaming = false;
let stopCurrent: (() => void) | null = null;

function setSendButton(mode: 'send' | 'stop') {
  const btn = $('btn-send');
  if (mode === 'stop') {
    btn.textContent = t('stopBtn');
    btn.classList.add('stop');
  } else {
    btn.textContent = t('sendBtn');
    btn.classList.remove('stop');
  }
}

$('btn-send').addEventListener('click', () => {
  if (streaming && stopCurrent) { stopCurrent(); return; }
  askLLMWith($('chat-q').value.trim(), $('chat-scope').value);
});
$('chat-q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (streaming) return;
    askLLMWith($('chat-q').value.trim(), $('chat-scope').value);
  }
});

async function askLLMWith(question, scope, selectionOverride?: string) {
  if (!question) return;
  if (streaming) return; // 流式中不接受新提问
  const qEl = $('chat-q');

  // 先备料再动 UI：材料提取失败要能在不产生气泡/线程脏数据的情况下拦下
  const wantPageText = scope !== 'selection';
  const gather = async () => {
    const info = await activeTabInfo();
    const pageUrl = info ? pageKey(info.url) : '';
    // 传原始 URL：SW 侧做分级 key 归一；本站笔记也注入，同域知识互通进上下文
    const r = info ? await send({ type: 'notes:get', url: info.url }) : { ok: true, notes: [] };
    const notes = (r && r.notes) || [];
    let pageText: string | null = null;
    if (wantPageText && info && /^https?:/.test(info.url)) {
      pageText = await extractPageText(info.tab.id as number);
    }
    return { info, pageUrl, notes, pageText };
  };

  let mat = await gather();
  if (wantPageText && !mat.pageText) {
    // 页面先于扩展打开（无 content script）或未授权：在点击手势内申请站点权限后
    // 自动重试 —— 授权后注入提取脚本即可完成，无需用户手动刷新页面。
    // url 可见则按站点申请（窄），不可见则申请 <all_urls>（一次性，装扩展时用户已接受过同等提示）
    const granted = await requestSitePermission(
      mat.info && /^https?:/.test(mat.info.url) ? mat.info.url : '<all_urls>'
    );
    if (granted) mat = await gather();
  }

  if (scope !== 'selection' && !mat.pageText) {
    // 提不到材料就裸问，模型只会回答"你没有给我材料"——不如当场说明原因
    appendError(t('extractFailed'));
    return;
  }

  const { info, pageUrl, notes } = mat;
  const pageText = scope === 'selection'
    ? null
    : (mat.pageText as string).slice(0, BUDGET.pageTextMaxChars * 6); // 提取层宽松截断，预算裁剪交给 buildContext
  // 页面「问 AI」带进来的选区优先（点击后页面选区可能已失焦清空，回读不可靠）
  const selection = scope === 'selection'
    ? ((selectionOverride || (info && info.selection) || '').trim() || null)
    : null;

  qEl.value = '';
  clearMainIfFirstChat();
  addMsg('user', question);

  const settings = await getSettings();
  // 多轮记忆：把本线程此前的问答一并送入上下文
  const history = recentHistory(currentThread && currentThread.messages);

  const thread = ensureThread();
  thread.messages.push({ role: 'user', content: question });
  if (!thread.title) thread.title = question.slice(0, 30);

  const bubble = addMsg('assistant', '');
  const bodyEl: any = bubble.querySelector('.body');
  bodyEl.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';

  streaming = true;
  setSendButton('stop');

  const abortCtrl = new AbortController();
  stopCurrent = () => abortCtrl.abort();

  // 流式期间：只在用户本来就在底部时才自动跟随，避免打断手动上滚
  let streamingText = '';
  let streamingReasoning = '';
  let rafPending = false;
  const nearBottom = () => $('main').scrollHeight - $('main').scrollTop - $('main').clientHeight < 60;

  // 思考过程折叠块（reasoning 模型才有内容）
  const thinkWrap = el('details', 'thinking');
  const thinkSummary = el('summary', '', t('thinkingSummary'));
  const thinkBody = el('div', 'thinking-body');
  thinkWrap.appendChild(thinkSummary);
  thinkWrap.appendChild(thinkBody);
  bodyEl.textContent = '';
  bodyEl.appendChild(thinkWrap);
  const answerHolder = el('div', 'answer-holder');
  bodyEl.appendChild(answerHolder);

  let lastThinkLen = -1;
  const flushAndFollow = () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      // 思考流式：只更新折叠块文本，不强制展开
      if (streamingReasoning.length !== lastThinkLen) {
        lastThinkLen = streamingReasoning.length;
        thinkBody.textContent = streamingReasoning;
      }
      renderMarkdownInto(answerHolder, streamingText);
      updateScrollBtn();
      if (nearBottom()) scrollBottom();
    });
  };

  let abortedByUser = false;
  try {
    const { messages } = await buildLlmMessages({
      settings, question, pageText, notes, selection, history,
    });
    await runStream({
      settings, messages, signal: abortCtrl.signal,
      onToken: (tok) => { streamingText += tok; flushAndFollow(); },
      onReasoning: (tok) => { streamingReasoning += tok; flushAndFollow(); },
    });

    // 正常完成：完整回答入 thread
    finishAssistant(thread, question, scope, streamingText, bubble, {
      info, pageUrl, notes, selection, pageText, settings,
      reasoning: streamingReasoning,
    });
    scrollBottom();
    renderFollowUps(bubble, question, streamingText);
  } catch (e: any) {
    abortedByUser = abortedByUser || e.name === 'AbortError';
    if (abortedByUser || abortCtrl.signal.aborted) {
      // 用户主动停止：保留已有内容（partial 也持久化，刷新不丢）
      if (streamingText || streamingReasoning) {
        finishAssistant(thread, question, scope, streamingText, bubble, {
          info, pageUrl, notes, selection, pageText, settings,
          reasoning: streamingReasoning,
          partial: true,
        });
        scrollBottom();
      } else {
        bubble.remove();
        thread.messages.pop(); // 移除没有回答的 user 消息
        appendError(t('stopped'));
      }
    } else {
      bubble.remove();
      thread.messages.pop();
      appendError(String(e.message || e));
    }
  }
  persistThread();
  // 恢复发送按钮
  stopCurrent = null;
  streaming = false;
  setSendButton('send');
}

/** 回答收尾：入 thread、渲染操作按钮、可选自动记忆/落盘 */
function finishAssistant(thread, question, scope, answer, bubble, extra: {
  info?, pageUrl?, notes?, selection?, pageText?, settings?,
  partial?: boolean,
  reasoning?: string,
}) {
  thread.messages.push({
    role: 'assistant',
    content: answer,
    question,
    ...(extra.reasoning ? { reasoning: extra.reasoning } : {}),
    ...(extra.partial ? { partial: true } : {}),
  });
  thread.updatedAt = Date.now();
  const bodyEl = bubble.querySelector('.body');
  // 重绘最终内容：思考折叠块（若有）+ 正文
  bodyEl.textContent = '';
  if (extra.reasoning) {
    const think = el('details', 'thinking');
    think.appendChild(el('summary', '', t('thinkingSummary')));
    const tb = el('div', 'thinking-body');
    tb.textContent = extra.reasoning;
    think.appendChild(tb);
    bodyEl.appendChild(think);
  }
  const holder = el('div');
  bodyEl.appendChild(holder);
  renderMarkdownInto(holder, answer);
  bubble.classList.add('done');
  attachMsgOps(bubble, {
    answer: () => answer,
    question,
    scope,
    info: extra.info,
    pageUrl: extra.pageUrl,
    notes: extra.notes,
    selection: extra.selection,
    pageText: extra.pageText,
  });
  const settings = extra.settings;
  // Phase 3: 自动记忆提取（设置开关，默认关；确认流防未授权写入）— 中断的 partial 不提取
  if (!extra.partial && settings.autoMemory && answer) {
    autoExtractMemory(settings, question, answer).catch(() => {});
  }
  // AI 问答存为该页笔记（kind=ai-qa），随导出一并落盘 — partial 不落盘
  if (!extra.partial && extra.pageUrl && answer) {
    saveAiQaNote({
      send,
      pageUrl: extra.pageUrl,
      title: extra.info ? extra.info.title : '',
      host: safeHost(extra.info),
      question,
      answer,
      provider: settings.provider,
      model: settings.model,
      pageNotes: extra.notes || [],
    }).catch(() => {});
  }
}

function safeHost(info) {
  try { return info ? new URL(info.url).hostname : ''; } catch { return ''; }
}

// ---------- 消息操作: 复制 / 重试 ----------

function attachMsgOps(bubble, ctxInfo) {
  const ops = bubble.querySelector('.ops');
  const btnCopy = el('button', '', t('copyBtn'));
  btnCopy.addEventListener('click', () => {
    navigator.clipboard.writeText(ctxInfo.answer()).then(() => toast(t('answerCopied')));
  });
  const btnRemember = el('button', '', t('rememberBtn'));
  btnRemember.title = t('rememberTitle');
  btnRemember.addEventListener('click', async () => {
    btnRemember.disabled = true;
    btnRemember.textContent = t('remembering');
    try {
      await extractAndStore(await getSettings(), ctxInfo.question, ctxInfo.answer(), currentThread?.url);
      btnRemember.textContent = t('remembered');
      toast(t('rememberOk'));
    } catch (e: any) {
      btnRemember.disabled = false;
      btnRemember.textContent = t('rememberBtn');
      toast(t('rememberFailed', e.message));
    }
  });
  const btnRetry = el('button', '', t('retryBtn'));
  btnRetry.addEventListener('click', () => retryQuestion(bubble, ctxInfo));
  if (!ctxInfo.readonly) ops.appendChild(btnRemember);
  ops.appendChild(btnCopy);
  ops.appendChild(btnRetry);
}

/** 重试：移除该轮 user+assistant 消息对后重新提问（避免 thread 出现重复问答） */
function retryQuestion(bubble, ctxInfo) {
  if (streaming) { toast(t('streamingShort')); return; }
  // 从 thread 里 pop 掉这对问答（assistant 及其前的 user）
  if (currentThread) {
    const idx = currentThread.messages.length - 1;
    if (idx >= 1 && currentThread.messages[idx].role === 'assistant' &&
        currentThread.messages[idx].content === ctxInfo.answer()) {
      currentThread.messages.splice(idx - 1, 2);
    }
  }
  bubble.remove();
  // 同时移除界面上紧邻的 user 气泡
  const prev = bubble.previousElementSibling;
  if (prev && prev.classList.contains('user')) prev.remove();
  askLLMWith(ctxInfo.question, ctxInfo.scope);
}

// ---------- 记忆：自动提取（Phase 3，走 memory-extract 模块）----------

/** 自动提取候选 → 角标确认（不直接写 vault） */
async function autoExtractMemory(settings, question, answer) {
  const summary = await proposeExtraction(settings, question, answer);
  if (!summary) return;
  pendingMemories.push(summary);
  updateMemoryBadge();
}

const pendingMemories: string[] = [];

function updateMemoryBadge() {
  const btn = $('btn-new-chat');
  if (!btn) return;
  const old = $('mem-badge');
  if (old) old.remove();
  if (pendingMemories.length) {
    const badge = el('span', '', t('memBadge', pendingMemories.length));
    badge.id = 'mem-badge';
    badge.style.cssText = 'cursor:pointer;color:#2563eb;font-size:11px;';
    badge.title = t('memBadgeTitle');
    badge.addEventListener('click', reviewPendingMemories);
    btn.parentElement.insertBefore(badge, btn);
  }
}

async function reviewPendingMemories() {
  for (const s of [...pendingMemories]) {
    if (confirm(t('confirmRemember', s))) {
      try {
        await storeProposed(s, currentThread?.url);
      } catch { /* vault 未授权等 */ }
    }
    pendingMemories.splice(pendingMemories.indexOf(s), 1);
  }
  updateMemoryBadge();
}

function renderMarkdownInto(container, md) {
  container.textContent = '';
  container.appendChild(renderMarkdown(md));
}

// ---------- Follow-up 建议问题（本地启发式生成，零额外 token）----------

function renderFollowUps(bubble, question, answer) {
  const old = $('main').querySelector('.followups');
  if (old) old.remove();
  const wrap = el('div', 'followups');
  const suggestions = buildFollowUps(question, answer);
  for (const s of suggestions) {
    const b = el('button', 'starter', s);
    b.addEventListener('click', () => askLLMWith(s, $('chat-scope').value));
    wrap.appendChild(b);
  }
  $('main').appendChild(wrap);
  scrollBottom();
}

function buildFollowUps(question: string, answer: string): string[] {
  const out: string[] = [];
  // 从回答中的标题提取深挖方向
  const headings = [...answer.matchAll(/^#{2,4}\s+(.+)$/gm)].map((m) => m[1].trim()).slice(0, 2);
  for (const h of headings) out.push(t('followupExpand', h.replace(/[**`]/g, '')));
  if (/代码|```/.test(answer)) out.push(t('followupCode'));
  if (/术语|概念/.test(question)) out.push(t('followupExample'));
  if (out.length < 3) out.push(t('followupSummarize'));
  if (out.length < 3) out.push(t('followupConflict'));
  return out.slice(0, 3);
}

let chatStarted = false;
function clearMainIfFirstChat() {
  if (chatStarted) return;
  $('main').textContent = '';
  chatStarted = true;
  // chatStarted 刚翻转时 renderChat 不会重跑，按钮显隐要在这里同步
  $('btn-new-chat').style.display = 'inline-block';
}

// 显式新会话（仅用户点击按钮触发；切 tab 不清空）
function newChat() {
  if (streaming) return; // 流式中不允许
  currentThread = null;
  $('main').textContent = '';
  chatStarted = false;
  renderChat();
}
$('btn-new-chat').addEventListener('click', () => {
  if (confirm(t('confirmNewChat'))) newChat();
});
function scrollBottom() { $('main').scrollTop = $('main').scrollHeight; }

// 离开底部时显示「↓ 回到底部」（对齐主流 chat）
function updateScrollBtn() {
  const m = $('main');
  const away = m.scrollHeight - m.scrollTop - m.clientHeight > 200;
  $('btn-scroll-bottom').style.display = away && chatStarted ? 'block' : 'none';
}
$('main').addEventListener('scroll', updateScrollBtn);
$('btn-scroll-bottom').addEventListener('click', () => {
  scrollBottom();
  updateScrollBtn();
});

function addMsg(role, text) {
  const d = el('div', 'msg ' + role);
  const who = el('div', 'who', role === 'user' ? t('roleYou') : 'AI');
  if (role === 'assistant') who.appendChild(el('span', 'ops'));
  d.appendChild(who);
  const body = el('div', 'body', text);
  d.appendChild(body);
  $('main').appendChild(d);
  scrollBottom();
  return d;
}

// ---------- tabs ----------

document.querySelectorAll('nav.tabs button').forEach((b: any) => {
  b.addEventListener('click', () => {
    tab = (b as HTMLElement).dataset.tab || 'notes';
    document.querySelectorAll('nav.tabs button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    // 切 tab 保留聊天记录，只切换视图与输入框显隐
    $('chat-input-wrap').style.display = tab === 'chat' ? 'block' : 'none';
    $('btn-new-chat').style.display = tab === 'chat' && chatStarted ? 'inline-block' : 'none';
    if (tab === 'notes') {
      renderNotes();
      updateScrollBtn();
    } else {
      if (!chatStarted) renderChat();
      else { updateScrollBtn(); scrollBottom(); }
    }
  });
});

$('btn-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('btn-threads').addEventListener('click', () => {
  const wrap = $('thread-list');
  if (wrap.style.display === 'block') { wrap.style.display = 'none'; return; }
  loadThreadList();
});
document.addEventListener('click', (e: any) => {
  const wrap = $('thread-list');
  if (wrap.style.display === 'block' && !wrap.contains(e.target) && e.target.id !== 'btn-threads') {
    wrap.style.display = 'none';
  }
});

applyI18n();
renderNotes();
// 语义召回接线：端侧模型后台下载/加载，就绪前自然降级为词法单路
getSettings()
  .then((s) => initEmbedding(s))
  .catch(() => {});

// ---------- 页面「问 AI」入口（SW 转发 + 缓冲消费）----------

let lastHandledAskId = '';

/** 处理页面划词「问 AI」：切到聊天页、锁定选区 scope、直接提问 */
function handleIncomingAsk(selection: string, askId?: string) {
  if (askId && askId === lastHandledAskId) return; // SW 转发与启动消费可能双触发
  if (askId) lastHandledAskId = askId;
  document.querySelectorAll('nav.tabs button').forEach((b: any) => {
    if (b.dataset.tab === 'chat') b.click();
  });
  if (!selection) return;
  $('chat-scope').value = 'selection';
  const q = t('askAboutSelection', selection);
  $('chat-q').value = q;
  if (!streaming) askLLMWith(q, 'selection', selection);
}

// SW 转发的实时消息（panel 已打开时走这里）
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'panel:ask') {
    handleIncomingAsk(msg.selection || '', msg.askId);
    chrome.storage.session.remove('pendingAsk').catch(() => {});
  }
});

// panel 未开时 SW 缓冲在 storage.session，启动时消费（兜底）
(async () => {
  try {
    const { pendingAsk } = await chrome.storage.session.get('pendingAsk');
    if (pendingAsk && pendingAsk.selection && Date.now() - pendingAsk.ts < 5 * 60 * 1000) {
      handleIncomingAsk(pendingAsk.selection, pendingAsk.askId);
    }
    chrome.storage.session.remove('pendingAsk').catch(() => {});
  } catch { /* session 存储不可用等 */ }
})();
