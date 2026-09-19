/**
 * Chat webview（侧栏 markpilot.chat）— 极简聊天 UI + 与扩展宿主的消息桥。
 * 问答逻辑全部在 core：buildLlmMessages（记忆/画像注入）→ streamChat 流式回推。
 * vaultPath 未配置时记忆层静默降级（core 内部 try/catch + VaultFS 'no-handle'）。
 */
import * as vscode from 'vscode';
import { settingsStore, textSource, vaultFS } from '../../core/src/ports.js';
import { buildLlmMessages, recentHistory } from '../../core/src/chat-pipeline.js';
import { streamChat } from '../../core/src/llm/index.js';
import { runTranslate } from '../../core/src/translate.js';
import { renderPageMarkdown, noteToMarkdown, slugify } from '../../core/src/markdown.js';
import { activeEditorContext } from './platform/text-source.js';
import { NotesStore } from './notes-store.js';

/** markpilot.ask 带入的选区上下文 */
interface PendingContext {
  selection: string;
  file: string;
  project: string;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private pendingContext: PendingContext | null = null;
  private history: { role: string; content: string }[] = [];
  /** 最近一次翻译结果与其来源选区（「替换选区」用） */
  private lastTranslation = '';
  private translateOrigin: { uri: vscode.Uri; range: vscode.Range } | null = null;
  /** 当前流式问答的中止器（webview 'stop' 消息触发） */
  private currentAbort: AbortController | null = null;
  /**
   * webview 就绪握手：脚本加载完成后发 {type:'ready'}，此前所有出站消息进队列。
   * 没有这层时，命令首次打开面板后立刻 post 的消息会被静默丢弃
   * （postMessage 在 webview 加载完成前不排队）——表现为「点了翻译/问 AI 毫无反应」。
   */
  private ready = false;
  private outbox: any[] = [];

  constructor(
    private store: NotesStore,
    private extensionUri: vscode.Uri
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false; // （重）加载即重新武装握手
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')],
    };
    view.webview.html = chatHtml({
      scriptUri: view.webview
        .asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'markdown-view.js'))
        .toString(),
      cspSource: view.webview.cspSource,
    });
    view.webview.onDidReceiveMessage((msg) => {
      switch (msg && msg.type) {
        case 'ready':
          this.ready = true;
          this.flush();
          break;
        case 'ask':
          this.handleAsk(String(msg.question || '')).catch((e) => {
            if (e && (e as Error).name === 'AbortError') return; // handleAsk 内部已收尾
            this.post({ type: 'error', message: describeError(e) });
          });
          break;
        case 'stop':
          this.currentAbort?.abort();
          break;
        case 'revertLast': {
          // 撤销最近一轮问答：历史弹出 user+assistant，问题回填输入框
          const n = this.history.length;
          if (n >= 2 && this.history[n - 2].role === 'user' && this.history[n - 1].role === 'assistant') {
            const q = this.history[n - 2].content;
            this.history.length = n - 2;
            this.post({ type: 'reverted', question: q });
          } else {
            this.post({ type: 'reverted', question: null });
          }
          break;
        }
        case 'saveQa':
          this.saveQa(String(msg.question || ''), String(msg.answer || '')).catch(() => {});
          break;
        case 'replaceSelection':
          this.replaceSelection().catch((e) =>
            vscode.window.showErrorMessage('替换失败: ' + String((e as Error)?.message || e))
          );
          break;
        case 'exportNotes':
          exportNotes(this.store)
            .then((f) => this.post({ type: 'status', text: '已导出: ' + f }))
            .catch((e) => this.post({ type: 'error', message: describeError(e) }));
          break;
        case 'setup':
          vscode.commands.executeCommand('markpilot.setup');
          break;
      }
    });
  }

  private post(msg: any): void {
    if (this.view && this.ready) this.view.webview.postMessage(msg);
    else {
      this.outbox.push(msg);
      if (this.outbox.length > 500) this.outbox.shift(); // 面板始终未打开时防无限积压
    }
  }

  private flush(): void {
    if (!this.view) return;
    while (this.outbox.length) this.view.webview.postMessage(this.outbox.shift());
  }

  /** markpilot.ask：聚焦侧栏并把选区挂为提问上下文 */
  async attachContext(ctx: PendingContext): Promise<void> {
    this.pendingContext = ctx;
    await vscode.commands.executeCommand('markpilot.chat.focus');
    this.post({ type: 'context', file: ctx.file, selection: ctx.selection });
  }

  /** markpilot.translate：流式翻译进 webview，完成后可一键替换选区 */
  async runTranslate(editor: vscode.TextEditor): Promise<void> {
    const text = editor.document.getText(editor.selection);
    if (!text) return;
    this.translateOrigin = { uri: editor.document.uri, range: editor.selection };
    this.lastTranslation = '';
    await vscode.commands.executeCommand('markpilot.chat.focus');
    this.post({ type: 'translateStart', source: text.slice(0, 200) });
    try {
      const settings = await settingsStore().getSettings();
      const { text: out } = await runTranslate({
        settings,
        text,
        langTag: vscode.env.language,
        onToken: (tok) => {
          this.lastTranslation += tok;
          this.post({ type: 'token', tok });
        },
      });
      this.lastTranslation = out;
      this.post({ type: 'translateDone' });
    } catch (e) {
      this.post({ type: 'error', message: describeError(e) });
    }
  }

  private async replaceSelection(): Promise<void> {
    if (!this.translateOrigin || !this.lastTranslation) return;
    const { uri, range } = this.translateOrigin;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, range, this.lastTranslation);
    await vscode.workspace.applyEdit(edit);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    this.post({ type: 'status', text: '已替换选区' });
  }

  private async handleAsk(question: string): Promise<void> {
    if (!question) return;
    const settings = await settingsStore().getSettings();
    const ctx = activeEditorContext();
    const pending = this.pendingContext;
    const file = ctx?.file || pending?.file || '';
    const project = ctx?.project || pending?.project || '';
    const pageText = await textSource().getPageText(0); // tabId 在 VS Code 无意义，取活动编辑器
    const notes = file
      ? this.store.forFile(file, project).map((n) => ({ content: n.text, kind: n.kind }))
      : [];
    const { messages } = await buildLlmMessages({
      settings,
      question,
      pageText,
      notes,
      selection: pending?.selection || null,
      history: recentHistory(this.history),
    });
    this.post({ type: 'start' });
    let answer = '';
    const ctrl = new AbortController();
    this.currentAbort = ctrl;
    try {
      const r = await streamChat({
        settings,
        messages,
        signal: ctrl.signal,
        onToken: (tok) => {
          answer += tok;
          this.post({ type: 'token', tok });
        },
        onReasoning: (tok) => this.post({ type: 'reasoningToken', tok }),
      });
      answer = r.text;
      this.history.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
      this.post({ type: 'done', question, answer });
    } catch (e) {
      if (ctrl.signal.aborted) {
        // 用户停止：部分回答照常落历史（对齐 Chrome 侧 partial 语义），气泡定格已有内容
        if (answer) {
          this.history.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
        }
        this.post({ type: 'done', question, answer });
        this.post({ type: 'status', text: '已停止' });
        return;
      }
      throw e;
    } finally {
      this.currentAbort = null;
    }
  }

  /** AI 问答存为本文件笔记（kind=ai-qa，语义对齐 core saveAiQaNote 的 content 形状） */
  private async saveQa(question: string, answer: string): Promise<void> {
    if (!answer) return;
    const ctx = activeEditorContext() || this.pendingContext;
    const ws = vscode.workspace.workspaceFolders?.[0];
    await this.store.add(
      {
        kind: 'ai-qa',
        scope: 'file',
        text: 'Q: ' + question + '\n\nA: ' + answer,
        file: ctx?.file || '',
        startLine: 0,
        endLine: 0,
        selectedText: this.pendingContext?.selection || '',
      },
      ws?.name || ''
    );
    this.post({ type: 'status', text: '已存为笔记' });
  }
}

/** 错误文本 + 已知场景的配置指引（全部经 post 进聊天 UI，绝不静默） */
export function describeError(e: any): string {
  const msg = String((e as Error)?.message || e);
  if (/HTTP 40[13]/.test(msg)) return msg + ' — 请检查 API Key 是否正确（Markpilot: 打开设置）';
  if (/No model configured|modelNotConfigured|未配置模型/i.test(msg)) {
    return msg + ' — 请先在设置页选择平台与模型（Markpilot: 打开设置）';
  }
  if (/HTTP 404|model.*not.*found|does not exist/i.test(msg)) {
    return msg + ' — 模型可能不存在或已下线，请到设置页用 ⟳ 在线列表重选模型';
  }
  return msg;
}

/** 导出当前文件笔记到 vault：Markpilot-Code/code-<slug>.md（幂等，source 匹配整文件重写） */
export async function exportNotes(store: NotesStore): Promise<string> {
  const ctx = activeEditorContext();
  if (!ctx) throw new Error('无活动编辑器（ Untitled 不支持）');
  const settings = await settingsStore().getSettings();
  const all = store.forFile(ctx.file, ctx.project).filter((n) => n.file === ctx.file);
  const notes = settings.exportAiQA ? all : all.filter((n) => n.kind !== 'ai-qa');
  if (!notes.length) throw new Error('本文件暂无可导出笔记');
  const dirName = 'Markpilot-Code';
  const fileName = 'code-' + slugify(ctx.file) + '.md';
  const vfs = vaultFS();
  const existingText = await vfs.readText(dirName + '/' + fileName);
  const notesMd = notes
    .map((n) =>
      noteToMarkdown({
        ts: n.createdAt,
        kind: n.kind,
        sel: n.selectedText ? { text: n.selectedText } : null,
        content: n.text,
      })
    )
    .join('\n\n');
  const md = renderPageMarkdown(
    existingText || '',
    { source: ctx.url, title: ctx.title, clipped: Date.now(), updated: Date.now(), tags: ['code-notes'] },
    notesMd,
    ''
  );
  await vfs.writeText(dirName + '/' + fileName, md);
  return dirName + '/' + fileName;
}

export function chatHtml(opts?: { scriptUri?: string; cspSource?: string }): string {
  const nonce = String(Date.now()) + String(Math.random()).slice(2, 8);
  // markdown 渲染器走独立 webview 资源：内联脚本里写渲染正则要双重转义，极易炸（历史教训）
  const mdScript = opts && opts.scriptUri ? '<script src="' + opts.scriptUri + '"></script>' : '';
  const scriptSrc = "'nonce-" + nonce + "'" + (opts && opts.cspSource ? ' ' + opts.cspSource : '');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src ${scriptSrc};">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); margin: 0; padding: 8px; display: flex; flex-direction: column; height: 100vh; box-sizing: border-box; }
  #ctx { display: none; border-left: 3px solid var(--vscode-textLink-foreground); padding: 4px 8px; margin-bottom: 6px; color: var(--vscode-descriptionForeground); font-size: 12px; white-space: pre-wrap; word-break: break-all; }
  #log { flex: 1; overflow-y: auto; }
  .msg { margin: 8px 0; white-space: pre-wrap; word-break: break-word; }
  .who { font-weight: bold; font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 2px; }
  .err { color: var(--vscode-errorForeground); }
  .status { color: var(--vscode-descriptionForeground); font-size: 12px; }
  .ops { margin-top: 4px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; border-radius: 3px; padding: 3px 10px; cursor: pointer; font-size: 12px; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  #input { display: flex; gap: 6px; margin-top: 8px; align-items: flex-end; }
  #tpls { display: none; margin-top: 6px; border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; overflow: hidden; }
  .tpl { padding: 4px 8px; cursor: pointer; font-size: 12px; }
  .tpl.sel { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  #q { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 4px 8px; resize: none; font-family: inherit; font-size: inherit; line-height: 1.4; max-height: 140px; box-sizing: border-box; }
  #bar { display: flex; gap: 6px; margin-top: 6px; }
  .think { font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
  .think summary { cursor: pointer; user-select: none; }
  .think .t-body { white-space: pre-wrap; word-break: break-word; border-left: 2px solid var(--vscode-descriptionForeground); padding-left: 6px; opacity: .85; margin-top: 4px; }
  /* AI 气泡的 markdown 渲染：正文正常排版，代码块保留空白 */
  .msg.ai .body { white-space: normal; }
  .msg.ai .body p { margin: 6px 0; }
  .msg.ai .body h1, .msg.ai .body h2, .msg.ai .body h3, .msg.ai .body h4, .msg.ai .body h5 { margin: 8px 0 4px; font-size: 13px; }
  .msg.ai .body ul, .msg.ai .body ol { margin: 4px 0; padding-left: 20px; }
  .msg.ai .body a { color: var(--vscode-textLink-foreground); }
  .msg.ai .body blockquote { border-left: 3px solid var(--vscode-descriptionForeground); margin: 6px 0; padding-left: 8px; opacity: .85; }
  .msg.ai .body blockquote p { margin: 2px 0; }
  .msg.ai .body code { background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.15)); border-radius: 3px; padding: 0 3px; font-family: var(--vscode-editor-font-family, monospace); font-size: .92em; }
  .msg.ai .body pre { position: relative; background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.12)); border-radius: 4px; padding: 8px; margin: 6px 0; overflow-x: auto; }
  .msg.ai .body pre code { background: none; padding: 0; white-space: pre; }
  .msg.ai .body pre .lang-tag { position: absolute; top: 2px; right: 44px; font-size: 10px; opacity: .6; }
  .msg.ai .body pre .copy-code { position: absolute; top: 2px; right: 4px; font-size: 10px; padding: 1px 6px; }
  .msg.ai .body table { border-collapse: collapse; margin: 6px 0; font-size: 12px; }
  .msg.ai .body th, .msg.ai .body td { border: 1px solid var(--vscode-input-border, rgba(128,128,128,.4)); padding: 3px 8px; }
  .msg.ai .body hr { border: 0; border-top: 1px solid var(--vscode-input-border, rgba(128,128,128,.4)); margin: 8px 0; }
</style>
</head>
<body>
  <div id="ctx"></div>
  <div id="log"></div>
  <div id="bar">
    <button class="secondary" id="btn-setup">快速配置</button>
    <button class="secondary" id="btn-export">导出本文件笔记</button>
    <button class="secondary" id="btn-revert" title="删除最近一轮问答，问题回填输入框">↩ 撤销上轮</button>
  </div>
  <div id="tpls"></div>
  <div id="input">
    <textarea id="q" rows="1" placeholder="问 AI…（/ 模板，Enter 发送，Shift+Enter 换行，Esc 停止）"></textarea>
    <button id="btn-send">发送</button>
  </div>
${mdScript}
<script nonce="${nonce}">
  const vs = acquireVsCodeApi();
  const log = document.getElementById('log');
  const qEl = document.getElementById('q');
  const tplBox = document.getElementById('tpls');
  let cur = null; // 流式中的回答气泡
  let thinkEl = null; // 流式中的思考块（<details>，回答开始时自动折叠）
  let thinkBody = null;
  let translateDone = false;
  let streaming = false; // 流式中（问答/翻译）：Esc 停止、发送与撤销禁用
  let lastUserEl = null; // 最近一条用户气泡（.msg 元素）
  let pendingAiEl = null; // 流式中的 AI 气泡（.msg 元素）
  const pairs = []; // 已完成问答的 DOM 对（撤销时移除）
  const sentHistory = []; // 发送过的原文（↑ 召回）
  let recallIdx = -1;
  function autogrow() {
    qEl.style.height = 'auto';
    qEl.style.height = Math.min(qEl.scrollHeight, 140) + 'px';
  }
  let curText = ''; // 当前气泡的 markdown 原文（渲染基于此累积串）
  let mdRaf = false;
  const hasMd = typeof renderMd === 'function'; // 渲染器资源加载失败时降级纯文本
  function renderCur() {
    if (!cur || mdRaf) return;
    mdRaf = true;
    requestAnimationFrame(() => {
      mdRaf = false;
      if (!cur) return;
      if (hasMd) { cur.textContent = ''; cur.appendChild(renderMd(curText)); }
      else cur.textContent = curText;
      log.scrollTop = log.scrollHeight;
    });
  }
  function renderCurSync() {
    if (!cur) return;
    if (hasMd) { cur.textContent = ''; cur.appendChild(renderMd(curText)); }
    else cur.textContent = curText;
  }

  function add(who, cls) {
    const d = document.createElement('div');
    d.className = 'msg ' + (cls || '');
    const w = document.createElement('div');
    w.className = 'who';
    w.textContent = who;
    const b = document.createElement('div');
    b.className = 'body';
    d.appendChild(w);
    d.appendChild(b);
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return b;
  }

  // prompt 模板：/ 开头呼出，发送时展开为完整提示词（气泡仍显示用户原文）
  const TPLS = [
    { cmd: 'explain', label: '/explain — 解释代码功能与意图', prompt: '请解释以下代码的功能与关键逻辑，并指出其设计意图：' },
    { cmd: 'review', label: '/review — code review 找问题', prompt: '请以 code review 视角审查以下代码，指出潜在 bug、可维护性问题与改进建议：' },
    { cmd: 'doc', label: '/doc — 生成文档注释', prompt: '请为以下代码生成简洁的文档注释（与代码语言匹配的 JSDoc/docstring 风格），并简要说明：' },
    { cmd: 'test', label: '/test — 设计单元测试', prompt: '请为以下代码设计单元测试：列出测试用例（含边界情况）并给出关键实现：' }
  ];
  let tplIdx = -1;

  function tplMatches() {
    const v = qEl.value;
    if (v.charAt(0) !== '/') return [];
    const frag = v.slice(1).toLowerCase();
    if (frag.indexOf(' ') >= 0) return []; // 命令后已带参数，不再弹
    return TPLS.filter((t) => t.cmd.indexOf(frag) === 0);
  }
  function hideTpls() { tplBox.style.display = 'none'; tplIdx = -1; }
  function renderTpls() {
    const list = tplMatches();
    if (!list.length) { hideTpls(); return; }
    tplBox.textContent = '';
    list.forEach((t, i) => {
      const d = document.createElement('div');
      d.className = 'tpl' + (i === tplIdx ? ' sel' : '');
      d.textContent = t.label;
      d.addEventListener('click', () => pickTpl(t));
      tplBox.appendChild(d);
    });
    tplBox.style.display = 'block';
  }
  function pickTpl(t) {
    qEl.value = '/' + t.cmd + ' ';
    hideTpls();
    qEl.focus();
  }
  function expandTpl(text) {
    for (const t of TPLS) {
      if (text === '/' + t.cmd || text.indexOf('/' + t.cmd + ' ') === 0) {
        const rest = text.slice(t.cmd.length + 1).trim();
        return t.prompt + (rest ? '\\n\\n补充要求：' + rest : '');
      }
    }
    return text;
  }

  function send() {
    if (streaming) return;
    const raw = qEl.value;
    if (!raw.trim()) return;
    hideTpls();
    const ub = add('你', '');
    ub.textContent = raw;
    lastUserEl = ub.parentElement;
    sentHistory.push(raw);
    if (sentHistory.length > 50) sentHistory.shift();
    recallIdx = -1;
    vs.postMessage({ type: 'ask', question: expandTpl(raw) });
    qEl.value = '';
    autogrow();
  }
  document.getElementById('btn-send').addEventListener('click', send);
  document.getElementById('btn-revert').addEventListener('click', () => {
    if (!streaming) vs.postMessage({ type: 'revertLast' });
  });
  qEl.addEventListener('input', () => { autogrow(); renderTpls(); });
  qEl.addEventListener('keydown', (e) => {
    if (tplBox.style.display === 'block') {
      const n = tplBox.children.length;
      if (e.key === 'ArrowDown') { tplIdx = (tplIdx + 1) % n; renderTpls(); e.preventDefault(); return; }
      if (e.key === 'ArrowUp') { tplIdx = (tplIdx - 1 + n) % n; renderTpls(); e.preventDefault(); return; }
      if (e.key === 'Escape') { hideTpls(); e.preventDefault(); return; }
      if (e.key === 'Tab') {
        const m = tplMatches();
        if (m.length) pickTpl(m[Math.max(tplIdx, 0)]);
        e.preventDefault(); return;
      }
      if (e.key === 'Enter' && tplIdx >= 0) {
        const m = tplMatches();
        if (m[tplIdx]) { pickTpl(m[tplIdx]); e.preventDefault(); return; }
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); return; }
    if (e.key === 'Escape' && streaming) { vs.postMessage({ type: 'stop' }); e.preventDefault(); return; }
    // CLI 风格历史召回：空输入（或召回中）时 ↑↓ 翻发送历史
    if (e.key === 'ArrowUp' && sentHistory.length && (!qEl.value || recallIdx >= 0)) {
      recallIdx = recallIdx < 0 ? sentHistory.length - 1 : Math.max(0, recallIdx - 1);
      qEl.value = sentHistory[recallIdx];
      autogrow();
      e.preventDefault(); return;
    }
    if (e.key === 'ArrowDown' && recallIdx >= 0) {
      recallIdx++;
      if (recallIdx >= sentHistory.length) { recallIdx = -1; qEl.value = ''; } else qEl.value = sentHistory[recallIdx];
      autogrow();
      e.preventDefault(); return;
    }
  });
  document.getElementById('btn-export').addEventListener('click', () => {
    vs.postMessage({ type: 'exportNotes' });
  });
  document.getElementById('btn-setup').addEventListener('click', () => {
    vs.postMessage({ type: 'setup' });
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    switch (m.type) {
      case 'context': {
        const c = document.getElementById('ctx');
        c.style.display = 'block';
        c.textContent = '\\u{1F4CE} ' + m.file + '\\n' + (m.selection || '').slice(0, 300);
        break;
      }
      case 'start':
        cur = add('AI', 'ai');
        pendingAiEl = cur.parentElement;
        curText = '';
        thinkEl = null;
        thinkBody = null;
        translateDone = false;
        streaming = true;
        break;
      case 'reasoningToken':
        if (cur) {
          if (!thinkEl) {
            thinkEl = document.createElement('details');
            thinkEl.className = 'think';
            thinkEl.setAttribute('open', '');
            const sm = document.createElement('summary');
            sm.textContent = '思考过程';
            thinkBody = document.createElement('div');
            thinkBody.className = 't-body';
            thinkEl.appendChild(sm);
            thinkEl.appendChild(thinkBody);
            cur.parentElement.insertBefore(thinkEl, cur);
          }
          thinkBody.textContent += m.tok;
          log.scrollTop = log.scrollHeight;
        }
        break;
      case 'token':
        if (cur) {
          if (thinkEl) thinkEl.removeAttribute('open'); // 正文开始，折叠思考
          curText += m.tok;
          renderCur();
        }
        break;
      case 'done': {
        renderCurSync();
        streaming = false;
        if (pendingAiEl) pairs.push({ u: lastUserEl, a: pendingAiEl });
        pendingAiEl = null;
        const answerText = m.answer || '';
        cur = null;
        const ops = document.createElement('div');
        ops.className = 'ops';
        const b = document.createElement('button');
        b.className = 'secondary';
        b.textContent = '存为笔记';
        b.addEventListener('click', () => {
          vs.postMessage({ type: 'saveQa', question: m.question, answer: m.answer });
          b.disabled = true;
        });
        ops.appendChild(b);
        if (answerText) {
          const cp = document.createElement('button');
          cp.className = 'secondary';
          cp.textContent = '复制';
          cp.addEventListener('click', () => {
            navigator.clipboard.writeText(answerText).then(() => {
              cp.textContent = '✓';
              setTimeout(() => { cp.textContent = '复制'; }, 1200);
            });
          });
          ops.appendChild(cp);
        }
        log.lastChild.appendChild(ops);
        break;
      }
      case 'translateStart':
        add('翻译', 'status').textContent = '原文：' + (m.source || '') + (m.source && m.source.length >= 200 ? '…' : '');
        cur = add('译文', 'ai');
        curText = '';
        streaming = true;
        break;
      case 'translateDone': {
        renderCurSync();
        streaming = false;
        const tText = curText;
        cur = null;
        const ops = document.createElement('div');
        ops.className = 'ops';
        const b = document.createElement('button');
        b.textContent = '替换选区';
        b.addEventListener('click', () => {
          vs.postMessage({ type: 'replaceSelection' });
          b.disabled = true;
        });
        ops.appendChild(b);
        if (tText) {
          const cp = document.createElement('button');
          cp.className = 'secondary';
          cp.textContent = '复制';
          cp.addEventListener('click', () => {
            navigator.clipboard.writeText(tText).then(() => {
              cp.textContent = '✓';
              setTimeout(() => { cp.textContent = '复制'; }, 1200);
            });
          });
          ops.appendChild(cp);
        }
        log.lastChild.appendChild(ops);
        break;
      }
      case 'error':
        add('错误', 'err').textContent = m.message;
        cur = null;
        streaming = false;
        break;
      case 'reverted': {
        if (m.question === null || m.question === undefined) {
          add('', 'status').textContent = '没有可撤销的问答';
          break;
        }
        const pair = pairs.pop();
        if (pair) {
          if (pair.a && pair.a.parentNode) pair.a.parentNode.removeChild(pair.a);
          if (pair.u && pair.u.parentNode) pair.u.parentNode.removeChild(pair.u);
        }
        qEl.value = m.question;
        autogrow();
        qEl.focus();
        break;
      }
      case 'status':
        add('', 'status').textContent = m.text;
        break;
    }
  });

  // 就绪握手：宿主在此之前的出站消息会排队，收到 ready 后才 flush
  vs.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
