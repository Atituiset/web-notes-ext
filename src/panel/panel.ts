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
  saveAiQaNote,
  runStream,
} from '../lib/chat-pipeline.js';
import { renderMarkdown } from '../lib/markdown-render.js';
import { saveMemory, listMemories, deleteMemory, pinMemory, isCold } from '../lib/memory.js';
import { extractAndStore, proposeExtraction, storeProposed } from '../lib/memory-extract.js';
import {
  getVaultHandle, exportViaFsAccess, vaultPermissionState,
  ensureVaultPermission, exportViaUri,
} from '../lib/obsidian.js';
import { renderPageMarkdown } from '../lib/markdown.js';

const $ = (id: string): any => document.getElementById(id);
let tab = 'notes';

function send(msg): Promise<any> {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

async function activeTabInfo() {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!t) return null;
  let selection = '';
  try {
    // activeTab 权限下可注入；失败则无选区
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: t.id! },
      func: () => String(window.getSelection() || ''),
    });
    selection = (r && r.result) || '';
  } catch { /* 受限页面 */ }
  return { tab: t, url: t.url || '', title: t.title || '', selection };
}

// ---------- 笔记列表 ----------

async function renderNotes() {
  const main = $('main');
  main.textContent = '';
  const info = await activeTabInfo();
  if (!info) { main.appendChild(el('div', 'empty', '无法获取当前标签页')); return; }
  const pageUrl = normalizeUrl(info.url);
  const r = await send({ type: 'notes:get', url: pageUrl });
  const notes = (r && r.ok && r.notes) || [];
  $('btn-export').textContent = '⬇ 导出本页 (' + notes.length + ')';
  if (!notes.length) {
    main.appendChild(el('div', 'empty', '本页还没有笔记 — 回到网页选中文字试试'));
    return;
  }
  for (const n of [...notes].reverse()) main.appendChild(noteItem(n));
}

function normalizeUrl(u) {
  try { const x = new URL(u); return x.origin + x.pathname; } catch { return u; }
}

function el(tag: string, cls?: string, text?: string): any {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function noteItem(n) {
  const d = el('div', 'item');
  const meta = el('div', 'meta');
  meta.appendChild(el('span', '', new Date(n.ts).toLocaleString()));
  if (n.kind === 'ai-qa') meta.appendChild(el('span', '', '[AI]'));
  d.appendChild(meta);
  if (n.sel && n.sel.text) d.appendChild(el('div', 'quote', '"' + n.sel.text + '"'));
  d.appendChild(el('div', 'text', n.content));
  const ops = el('div', 'ops');
  const btnCopy = el('button', '', '复制');
  btnCopy.onclick = () => navigator.clipboard.writeText(n.content).then(() => toast('已复制'));
  const btnDel = el('button', 'danger', '删除');
  btnDel.onclick = async () => {
    await send({ type: 'notes:delete', id: n.id });
    renderNotes();
  };
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

$('btn-export').addEventListener('click', async () => {
  const info = await activeTabInfo();
  if (!info || !/^https?:/.test(info.url)) { toast('该页面不可导出'); return; }
  const pageUrl = normalizeUrl(info.url);
  const r = await send({ type: 'notes:get', url: pageUrl });
  const notes = (r && r.ok && r.notes) || [];

  let pageMarkdown = '';
  try {
    const text = await extractPageText(info.tab.id as number);
    pageMarkdown = (text || '').slice(0, BUDGET.pageTextMaxChars);
  } catch { /* 提取失败则只导笔记 */ }

  const state = await vaultPermissionState();
  if (state === 'granted') {
    try {
      const out = await exportViaFsAccess({ url: pageUrl, title: info.title, notes, pageMarkdown });
      toast('已写入 vault: ' + out.file);
      return;
    } catch (e: any) {
      appendError('导出失败: ' + e.message);
      return;
    }
  }
  if (state === 'no-handle' || state === 'prompt') {
    // 需要一次用户手势 → 此点击即是手势，直接请求授权
    try {
      if (state === 'no-handle') await import('../lib/obsidian.js').then((m) => m.pickVault());
      else await ensureVaultPermission();
      const out = await exportViaFsAccess({ url: pageUrl, title: info.title, notes, pageMarkdown });
      toast('已写入 vault: ' + out.file);
    } catch (e: any) {
      appendError('目录授权/导出失败: ' + e.message + '\n（可改用 obsidian:// URI 兜底）');
    }
    return;
  }
});

function appendError(msg) {
  const box = el('div', 'err', msg);
  $('main').prepend(box);
  setTimeout(() => box.remove(), 8000);
}

// ---------- 聊天（会话线程化）----------

const STARTERS = [
  { icon: '📄', text: '总结这篇文章的核心观点' },
  { icon: '❓', text: '列出文中我不理解的术语并解释' },
  { icon: '🤔', text: '针对我的笔记，指出可能的误解' },
  { icon: '🧭', text: '用费曼方法向我讲解这个页面' },
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
  $('model-hint').textContent = settings.provider + ':' + (settings.model || '(未配置)');
  $('btn-new-chat').style.display = chatStarted ? 'inline-block' : 'none';

  if (!chatStarted) {
    // 欢迎屏 + conversation starters
    const hero = el('div', 'empty');
    hero.appendChild(el('div', '', '问点什么 — 自动带上页面正文、你的笔记和选区'));
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
    item.appendChild(el('span', 'thread-title', t.title || '(无标题会话)'));
    const btnDel = el('button', 'thread-del', '✕');
    btnDel.title = '删除此会话';
    btnDel.onclick = async (e) => {
      e.stopPropagation();
      await deleteThread(t.id);
      if (currentThread && currentThread.id === t.id) { currentThread = null; chatStarted = false; renderChat(); }
      loadThreadList();
    };
    item.appendChild(btnDel);
    item.addEventListener('click', async () => {
      if (streaming) { toast('流式回答中，先停止或等待完成'); return; }
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
        think.appendChild(el('summary', '', '💭 思考过程'));
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
    btn.textContent = '停止';
    btn.classList.add('stop');
  } else {
    btn.textContent = '发送';
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

async function askLLMWith(question, scope) {
  if (!question) return;
  if (streaming) return; // 流式中不接受新提问
  const qEl = $('chat-q');
  qEl.value = '';

  clearMainIfFirstChat();
  addMsg('user', question);

  const info = await activeTabInfo();
  const pageUrl = info ? normalizeUrl(info.url) : '';
  const r = pageUrl ? await send({ type: 'notes:get', url: pageUrl }) : { ok: true, notes: [] };
  const notes = (r && r.notes) || [];
  const selection = scope === 'selection' ? ((info && info.selection) || '').trim() : null;

  // 整页正文提取
  let pageText: string | null = null;
  if (scope !== 'selection' && info && /^https?:/.test(info.url)) {
    pageText = await extractPageText(info.tab.id as number);
    if (pageText) pageText = pageText.slice(0, BUDGET.pageTextMaxChars * 6); // 提取层宽松截断，预算裁剪交给 buildContext
  }

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
  const thinkSummary = el('summary', '', '💭 思考过程');
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
        appendError('已停止');
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
    think.appendChild(el('summary', '', '💭 思考过程'));
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
  const btnCopy = el('button', '', '复制');
  btnCopy.addEventListener('click', () => {
    navigator.clipboard.writeText(ctxInfo.answer()).then(() => toast('已复制回答'));
  });
  const btnRemember = el('button', '', '🧠 记住');
  btnRemember.title = '把这条结论存为长期记忆';
  btnRemember.addEventListener('click', async () => {
    btnRemember.disabled = true;
    btnRemember.textContent = '提取中…';
    try {
      await extractAndStore(await getSettings(), ctxInfo.question, ctxInfo.answer(), currentThread?.url);
      btnRemember.textContent = '✓ 已记忆';
      toast('已存入 Markpilot-Memory');
    } catch (e: any) {
      btnRemember.disabled = false;
      btnRemember.textContent = '🧠 记住';
      toast('记忆失败: ' + e.message);
    }
  });
  const btnRetry = el('button', '', '重试');
  btnRetry.addEventListener('click', () => retryQuestion(bubble, ctxInfo));
  if (!ctxInfo.readonly) ops.appendChild(btnRemember);
  ops.appendChild(btnCopy);
  ops.appendChild(btnRetry);
}

/** 重试：移除该轮 user+assistant 消息对后重新提问（避免 thread 出现重复问答） */
function retryQuestion(bubble, ctxInfo) {
  if (streaming) { toast('流式回答中'); return; }
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
    const badge = el('span', '', `🧠 ${pendingMemories.length} 条可记忆`);
    badge.id = 'mem-badge';
    badge.style.cssText = 'cursor:pointer;color:#2563eb;font-size:11px;';
    badge.title = '点击查看并保存自动发现的记忆';
    badge.addEventListener('click', reviewPendingMemories);
    btn.parentElement.insertBefore(badge, btn);
  }
}

async function reviewPendingMemories() {
  for (const s of [...pendingMemories]) {
    if (confirm('记住这条吗？\n\n' + s)) {
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
  for (const h of headings) out.push('详细展开「' + h.replace(/[**`]/g, '') + '」');
  if (/代码|```/.test(answer)) out.push('逐行解释上面代码的作用');
  if (/术语|概念/.test(question)) out.push('举一个具体的例子说明');
  if (out.length < 3) out.push('总结成 3 点要点');
  if (out.length < 3) out.push('这和我笔记里的理解有冲突吗？');
  return out.slice(0, 3);
}

let chatStarted = false;
function clearMainIfFirstChat() {
  if (chatStarted) return;
  $('main').textContent = '';
  chatStarted = true;
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
  if (confirm('清空当前会话？已保存的笔记不受影响。')) newChat();
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
  const who = el('div', 'who', role === 'user' ? '你' : 'AI');
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
    $('btn-new-chat').style.display = tab === 'chat' ? 'inline-block' : 'none';
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

renderNotes();

// 暴露给 annotator 的「问 AI」按钮：切到 chat 并预填选区
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'panel:focus-chat') {
    document.querySelectorAll('nav.tabs button').forEach((b: any) => {
      if (b.dataset.tab === 'chat') b.click();
    });
    if (msg.selection) $('chat-q').value = '解释这段话：“' + msg.selection + '”';
  }
});
