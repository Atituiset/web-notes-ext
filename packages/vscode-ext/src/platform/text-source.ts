/**
 * TextSource 端口 VS Code 实现 — 活动编辑器正文。
 * markdown 全文；代码文件截断到 chat-pipeline 的页正文预算。
 * 选区不在这里拼 —— 由聊天流程经 buildLlmMessages 的 selection 参数注入。
 */
import * as vscode from 'vscode';
import type { TextSource } from '../../../core/src/ports.js';
import { BUDGET } from '../../../core/src/chat-pipeline.js';
import { fileKey } from '../../../core/src/file-key.js';

export const vscodeTextSource: TextSource = {
  async getPageText() {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.isUntitled) return null;
    const doc = ed.document;
    let text = doc.getText();
    if (doc.languageId !== 'markdown' && text.length > BUDGET.pageTextMaxChars) {
      text = text.slice(0, BUDGET.pageTextMaxChars);
    }
    return text;
  },
};

/** 当前编辑器的上下文标识：title = workspace 相对路径，url = vscode://<fileKey>（稳定 key） */
export function activeEditorContext(): { title: string; url: string; file: string; project: string } | null {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.isUntitled) return null;
  const ws = vscode.workspace.getWorkspaceFolder(ed.document.uri);
  const root = ws ? ws.uri.fsPath : '';
  const project = ws ? ws.name : '';
  const file = fileKey(ed.document.uri.fsPath, root);
  if (!file) return null;
  return { title: file, url: 'vscode://' + file, file, project };
}
