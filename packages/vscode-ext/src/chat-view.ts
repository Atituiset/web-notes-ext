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

  constructor(private store: NotesStore) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = chatHtml();
    view.webview.onDidReceiveMessage((msg) => {
      switch (msg && msg.type) {
        case 'ask':
          this.handleAsk(String(msg.question || '')).catch((e) =>
            this.post({ type: 'error', message: String((e as Error)?.message || e) })
          );
          break;
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
            .catch((e) => this.post({ type: 'error', message: String((e as Error)?.message || e) }));
          break;
        case 'setup':
          vscode.commands.executeCommand('markpilot.setup');
          break;
      }
    });
  }

  private post(msg: any): void {
    this.view?.webview.postMessage(msg);
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
      this.post({ type: 'error', message: String((e as Error)?.message || e) });
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
    const r = await streamChat({
      settings,
      messages,
      onToken: (tok) => {
        answer += tok;
        this.post({ type: 'token', tok });
      },
    });
    answer = r.text;
    this.history.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
    this.post({ type: 'done', question, answer });
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

function chatHtml(): string {
  const nonce = String(Date.now()) + String(Math.random()).slice(2, 8);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
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
  #input { display: flex; gap: 6px; margin-top: 8px; }
  #q { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 4px 8px; }
  #bar { display: flex; gap: 6px; margin-top: 6px; }
</style>
</head>
<body>
  <div id="ctx"></div>
  <div id="log"></div>
  <div id="bar">
    <button class="secondary" id="btn-setup">快速配置</button>
    <button class="secondary" id="btn-export">导出本文件笔记</button>
  </div>
  <div id="input">
    <input id="q" placeholder="问 AI…（选区/当前文件为上下文）">
    <button id="btn-send">发送</button>
  </div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log');
  let cur = null; // 流式中的回答气泡
  let translateDone = false;

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

  function send() {
    const q = document.getElementById('q');
    if (!q.value.trim()) return;
    add('你', '').textContent = q.value;
    vscode.postMessage({ type: 'ask', question: q.value });
    q.value = '';
  }
  document.getElementById('btn-send').addEventListener('click', send);
  document.getElementById('q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send();
  });
  document.getElementById('btn-export').addEventListener('click', () => {
    vscode.postMessage({ type: 'exportNotes' });
  });
  document.getElementById('btn-setup').addEventListener('click', () => {
    vscode.postMessage({ type: 'setup' });
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    switch (m.type) {
      case 'context': {
        const c = document.getElementById('ctx');
        c.style.display = 'block';
        c.textContent = '📎 ' + m.file + '\n' + (m.selection || '').slice(0, 300);
        break;
      }
      case 'start':
        cur = add('AI', '');
        translateDone = false;
        break;
      case 'token':
        if (cur) { cur.textContent += m.tok; log.scrollTop = log.scrollHeight; }
        break;
      case 'done': {
        cur = null;
        const ops = document.createElement('div');
        ops.className = 'ops';
        const b = document.createElement('button');
        b.className = 'secondary';
        b.textContent = '存为笔记';
        b.addEventListener('click', () => {
          vscode.postMessage({ type: 'saveQa', question: m.question, answer: m.answer });
          b.disabled = true;
        });
        ops.appendChild(b);
        log.lastChild.appendChild(ops);
        break;
      }
      case 'translateStart':
        add('翻译', 'status').textContent = '原文：' + (m.source || '') + (m.source && m.source.length >= 200 ? '…' : '');
        cur = add('译文', '');
        break;
      case 'translateDone': {
        cur = null;
        const ops = document.createElement('div');
        ops.className = 'ops';
        const b = document.createElement('button');
        b.textContent = '替换选区';
        b.addEventListener('click', () => {
          vscode.postMessage({ type: 'replaceSelection' });
          b.disabled = true;
        });
        ops.appendChild(b);
        log.lastChild.appendChild(ops);
        break;
      }
      case 'error':
        add('错误', 'err').textContent = m.message;
        cur = null;
        break;
      case 'status':
        add('', 'status').textContent = m.text;
        break;
    }
  });
</script>
</body>
</html>`;
}
