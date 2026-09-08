/**
 * Markpilot VS Code 扩展 — 入口。
 * activate 只做装配：平台端口 → 笔记存储/装饰 → chat webview → 命令注册。
 * 业务逻辑在 core（chat-pipeline / memory / llm / translate / markdown）。
 */
import * as vscode from 'vscode';
import { setupVsCodePlatform } from './platform/index.js';
import { settingsStore } from '../../core/src/ports.js';
import { PROVIDERS } from '../../core/src/llm/index.js';
import { fileKey } from '../../core/src/file-key.js';
import { NotesStore, refreshDecorations } from './notes-store.js';
import { ChatViewProvider, exportNotes } from './chat-view.js';
import { initNodeEmbedding } from './embedding-node.js';
import { runSetupWizard, saveApiKey } from './setup-wizard.js';
import { SettingsPanel } from './settings-page.js';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // 平台端口装配：单 bundle 一次，须在任何 core 业务调用前完成
  setupVsCodePlatform(context);

  const store = new NotesStore(context.globalState);
  const chat = new ChatViewProvider(store);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('markpilot.chat', chat)
  );

  // 语义召回接线（端侧 MiniLM，后台下载/加载；失败降级词法单路）
  const settings = await settingsStore().getSettings();
  void initNodeEmbedding(context, settings);

  const currentFileKey = (ed: vscode.TextEditor): { file: string; project: string } => {
    const ws = vscode.workspace.getWorkspaceFolder(ed.document.uri);
    return {
      file: fileKey(ed.document.uri.fsPath, ws ? ws.uri.fsPath : ''),
      project: ws ? ws.name : '',
    };
  };

  const refreshAll = () => {
    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document.isUntitled) continue;
      const { file, project } = currentFileKey(ed);
      refreshDecorations(ed, store, file, project);
    }
  };

  // ---------- 命令 ----------

  context.subscriptions.push(
    vscode.commands.registerCommand('markpilot.note', async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.selection.isEmpty) {
        vscode.window.showWarningMessage('请先选中一段文本再记笔记');
        return;
      }
      const text = await vscode.window.showInputBox({
        prompt: '笔记内容',
        placeHolder: '给这段选区写一条笔记…',
      });
      if (!text || !text.trim()) return;
      const { file, project } = currentFileKey(ed);
      await store.add(
        {
          kind: 'note',
          scope: 'file',
          text: text.trim(),
          file,
          startLine: ed.selection.start.line,
          endLine: ed.selection.end.line,
          selectedText: ed.document.getText(ed.selection).slice(0, 500),
        },
        project
      );
      refreshAll();
    }),

    vscode.commands.registerCommand('markpilot.ask', async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.selection.isEmpty) {
        vscode.window.showWarningMessage('请先选中一段文本再提问');
        return;
      }
      const { file, project } = currentFileKey(ed);
      await chat.attachContext({
        selection: ed.document.getText(ed.selection),
        file,
        project,
      });
    }),

    vscode.commands.registerCommand('markpilot.translate', async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.selection.isEmpty) {
        vscode.window.showWarningMessage('请先选中要翻译的文本');
        return;
      }
      await chat.runTranslate(ed);
    }),

    vscode.commands.registerCommand('markpilot.exportNotes', async () => {
      try {
        const f = await exportNotes(store);
        vscode.window.showInformationMessage('已导出到 vault: ' + f);
      } catch (e) {
        vscode.window.showErrorMessage('导出失败: ' + String((e as Error)?.message || e));
      }
    }),

    vscode.commands.registerCommand('markpilot.setup', async () => {
      await runSetupWizard(context.secrets);
    }),

    vscode.commands.registerCommand('markpilot.openSettings', () => {
      SettingsPanel.createOrShow(context.secrets);
    }),

    vscode.commands.registerCommand('markpilot.setApiKey', async () => {
      const provider = await vscode.window.showQuickPick(Object.keys(PROVIDERS), {
        placeHolder: '为哪个 provider 设置 API Key？',
      });
      if (!provider) return;
      const key = await vscode.window.showInputBox({
        prompt: provider + ' 的 API Key（存于 SecretStorage，不写 settings.json；留空清除）',
        password: true,
      });
      if (key === undefined) return;
      await saveApiKey(context.secrets, provider, key.trim());
      vscode.window.showInformationMessage(key.trim() ? 'API Key 已保存' : 'API Key 已清除');
    })
  );

  // ---------- 笔记高亮：打开/切换编辑器时恢复，编辑时行号平移 ----------

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => refreshAll()),
    vscode.workspace.onDidOpenTextDocument(() => refreshAll()),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.isUntitled || !e.contentChanges.length) return;
      const ws = vscode.workspace.getWorkspaceFolder(e.document.uri);
      const file = fileKey(e.document.uri.fsPath, ws ? ws.uri.fsPath : '');
      for (const ch of e.contentChanges) {
        // 行级平移：改动净增/净减行数，作用于其后的笔记锚点（落在笔记范围内的改动只伸缩尾锚）
        const delta = (ch.text.match(/\n/g) || []).length - (ch.range.end.line - ch.range.start.line);
        if (delta) void store.shiftLines(file, ch.range.end.line, delta);
      }
      // 等平移落盘后重绘
      setTimeout(refreshAll, 50);
    })
  );

  refreshAll();

  // 测试钩子：extension host 内共享 globalThis，自动化测试经此取真实 context（globalState 等）
  (globalThis as any).__markpilotContext = context;
}

export function deactivate(): void {}
