/**
 * 笔记存储 — context.globalState 持久化（单 key 数组，个人规模足够）。
 * 记录分级与 file-key.ts 对应：file 级锚定行列范围（装饰高亮用），project 级预留。
 */
import * as vscode from 'vscode';
import { projectKey } from '../../core/src/file-key.js';

export interface CodeNote {
  id: string;
  kind: 'note' | 'ai-qa';
  scope: 'file' | 'project';
  text: string;
  /** fileKey（workspace 相对 posix 路径） */
  file: string;
  /** projectKey（'project:' + 文件夹名） */
  project: string;
  startLine: number;
  endLine: number;
  selectedText: string;
  createdAt: number;
}

const STATE_KEY = 'markpilot.notes';

function uid(): string {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

export class NotesStore {
  constructor(private state: vscode.Memento) {}

  all(): CodeNote[] {
    return this.state.get<CodeNote[]>(STATE_KEY, []);
  }

  /** 某文件可见的笔记：本文件 file 级 + 本项目 project 级 */
  forFile(file: string, project: string): CodeNote[] {
    return this.all().filter(
      (n) => n.file === file || (n.scope === 'project' && n.project === project)
    );
  }

  async add(n: Omit<CodeNote, 'id' | 'createdAt' | 'project'> & { project?: string }, folderName: string): Promise<CodeNote> {
    const note: CodeNote = {
      ...n,
      id: uid(),
      project: projectKey(folderName),
      createdAt: Date.now(),
    };
    await this.state.update(STATE_KEY, [...this.all(), note]);
    return note;
  }

  /** 编辑后行号平移（onDidChangeTextDocument 驱动，仅整段在笔记之前的改动触发） */
  async shiftLines(file: string, afterLine: number, delta: number): Promise<void> {
    if (!delta) return;
    const notes = this.all();
    let dirty = false;
    for (const n of notes) {
      if (n.file !== file) continue;
      if (n.startLine > afterLine) {
        n.startLine += delta;
        n.endLine += delta;
        dirty = true;
      } else if (n.endLine > afterLine) {
        // 改动落在笔记范围内：扩/缩尾部锚点，尽力保住高亮
        n.endLine = Math.max(n.startLine, n.endLine + delta);
        dirty = true;
      }
    }
    if (dirty) await this.state.update(STATE_KEY, notes);
  }

  async delete(id: string): Promise<void> {
    await this.state.update(STATE_KEY, this.all().filter((n) => n.id !== id));
  }
}

/** 编辑器装饰：笔记选区高亮（黄底，对齐 chrome 侧划词高亮语义） */
export const noteDecoration = vscode.window.createTextEditorDecorationType({
  backgroundColor: 'rgba(250, 204, 21, 0.22)',
  borderRadius: '2px',
  overviewRulerColor: 'rgba(250, 204, 21, 0.7)',
  overviewRulerLane: vscode.OverviewRulerLane.Right,
});

/** 刷新某编辑器上的笔记高亮（行号越界时按文档长度收敛） */
export function refreshDecorations(editor: vscode.TextEditor, store: NotesStore, file: string, project: string): void {
  const lineCount = editor.document.lineCount;
  const ranges = store
    .forFile(file, project)
    .filter((n) => n.file === file && n.startLine < lineCount)
    .map((n) => {
      const end = Math.min(n.endLine, lineCount - 1);
      return new vscode.Range(n.startLine, 0, end, editor.document.lineAt(end).text.length);
    });
  editor.setDecorations(noteDecoration, ranges);
}
