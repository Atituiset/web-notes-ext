/**
 * 扩展宿主内集成测试（@vscode/test-electron 驱动，WSLg headed）。
 * 覆盖：激活与命令注册 / VaultFS+记忆检索回路 / 笔记锚点平移 / mock LLM 的翻译与问答管线。
 *
 * 测试 bundle 与扩展 bundle 是两份 core 拷贝（模块级注册表各自独立）——
 * 本文件自己 configurePlatform({ vaultFS }) 即可，vaultFS 适配器直读 workspace 配置；
 * 真实 globalState 经扩展 activate 时挂在 globalThis.__markpilotContext 上获取。
 */
import * as vscode from 'vscode';
import * as assert from 'node:assert';
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import Mocha from 'mocha';
import { configurePlatform } from '../../../core/src/ports.js';
import { vscodeVaultFS } from '../platform/vault-fs.js';
import { saveMemory, searchMemories } from '../../../core/src/memory.js';
import { runTranslate } from '../../../core/src/translate.js';
import { buildLlmMessages } from '../../../core/src/chat-pipeline.js';
import { streamChat } from '../../../core/src/llm/index.js';
import { fileKey } from '../../../core/src/file-key.js';
import { PROVIDERS } from '../../../core/src/llm/index.js';
import { NotesStore, refreshDecorations } from '../notes-store.js';
import { makeSettingsStore } from '../platform/settings-store.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MARKER = 'markeralpha77'; // 记忆正文/查询共用标记（tokenize 两侧一致）
const MOCK_REPLY = '这是一段来自模拟模型的流式回答。';

// ---------- mock LLM：OpenAI 兼容 SSE ----------

let mock: http.Server | null = null;
let mockPort = 0;
const capturedBodies: any[] = [];

function ssePayload(text: string, chunk = 4): string {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += chunk) parts.push(text.slice(i, i + chunk));
  return (
    parts.map((p) => `data: {"choices":[{"delta":{"content":${JSON.stringify(p)}}}]}\n\n`).join('') +
    'data: [DONE]\n\n'
  );
}

function startMock(): Promise<void> {
  return new Promise((resolve, reject) => {
    mock = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          capturedBodies.push(JSON.parse(body));
        } catch { /* 忽略非 JSON */ }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(ssePayload(MOCK_REPLY));
      });
    });
    mock.once('error', reject);
    mock.listen(0, '127.0.0.1', () => {
      mockPort = (mock!.address() as any).port;
      resolve();
    });
  });
}

function mockSettings(): any {
  return {
    provider: 'openai-compatible',
    baseUrl: `http://127.0.0.1:${mockPort}/v1`,
    model: 'mock-model',
    apiKeys: { 'openai-compatible': 'dummy' },
    memoryInject: true,
  };
}

// ---------- 测试定义 ----------

function defineTests(): void {
  describe('markpilot vscode-ext', function () {
    this.timeout(30000);

    before(async () => {
      // 本 bundle 的 core 注册表：记忆回路只需 VaultFS（适配器直读 markpilot.vaultPath）
      configurePlatform({ vaultFS: vscodeVaultFS });
      const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'markpilot-vault-'));
      (globalThis as any).__testVaultDir = vaultDir;
      await vscode.workspace
        .getConfiguration('markpilot')
        .update('vaultPath', vaultDir, vscode.ConfigurationTarget.Global);
      await startMock();
      // 确保扩展已激活（__markpilotContext 就绪）
      const ext = vscode.extensions.all.find((e) =>
        (e.packageJSON?.contributes?.commands || []).some((c: any) => c.command === 'markpilot.note')
      );
      assert.ok(ext, '扩展应已加载');
      await ext!.activate();
    });

    after(async () => {
      if (mock) await new Promise((r) => mock!.close(r));
      await fs.rm((globalThis as any).__testVaultDir, { recursive: true, force: true });
    });

    it('激活并注册全部命令', async () => {
      const ctx = (globalThis as any).__markpilotContext;
      assert.ok(ctx, 'activate 应暴露 __markpilotContext');
      const cmds = await vscode.commands.getCommands(true);
      for (const c of ['markpilot.note', 'markpilot.ask', 'markpilot.translate', 'markpilot.setApiKey', 'markpilot.exportNotes', 'markpilot.setup']) {
        assert.ok(cmds.includes(c), '命令未注册: ' + c);
      }
    });

    it('配置贡献：provider 为 9 平台下拉（enum + 中文描述）', () => {
      const ext = vscode.extensions.all.find((e) =>
        (e.packageJSON?.contributes?.commands || []).some((c: any) => c.command === 'markpilot.note')
      );
      const props = ext!.packageJSON.contributes.configuration.properties;
      const p = props['markpilot.provider'];
      assert.ok(Array.isArray(p.enum), 'provider 应有 enum');
      assert.equal(p.enum.length, 9, 'enum 应含 9 个平台');
      for (const k of ['opencode', 'openai-compatible', 'ollama', 'openrouter', 'anthropic', 'deepseek', 'zhipu', 'moonshot', 'qwen']) {
        assert.ok(p.enum.includes(k), 'enum 缺平台: ' + k);
      }
      assert.equal(p.enumDescriptions.length, 9, 'enumDescriptions 数量应与 enum 对齐');
      assert.ok(p.enumDescriptions[0].includes('零配置'), 'opencode 应标注零配置');
    });

    it('settings-store：未配模型时读时回退到 provider 首个预设（非破坏性）', async () => {
      const cfg = vscode.workspace.getConfiguration('markpilot');
      const fakeSecrets: any = { get: async () => undefined, store: async () => {}, delete: async () => {} };
      const store = makeSettingsStore(fakeSecrets);
      const prevProvider = cfg.get('provider');
      const prevModel = cfg.get('model');
      try {
        await cfg.update('provider', 'opencode', vscode.ConfigurationTarget.Global);
        await cfg.update('model', '', vscode.ConfigurationTarget.Global);
        const s1 = await store.getSettings();
        assert.equal(s1.provider, 'opencode');
        assert.equal(s1.model, (PROVIDERS as any).opencode.models[0], '空模型应回退首个预设');
        // 显式配置优先，不被回退覆盖
        await cfg.update('model', 'custom-model-x', vscode.ConfigurationTarget.Global);
        const s2 = await store.getSettings();
        assert.equal(s2.model, 'custom-model-x');
        // 无预设模型的 provider 不回退
        await cfg.update('provider', 'openai-compatible', vscode.ConfigurationTarget.Global);
        await cfg.update('model', '', vscode.ConfigurationTarget.Global);
        const s3 = await store.getSettings();
        assert.equal(s3.model, '');
        // 配置未被回退写脏（非破坏性验证）
        assert.equal(cfg.get('model'), '');
      } finally {
        await cfg.update('provider', prevProvider, vscode.ConfigurationTarget.Global);
        await cfg.update('model', prevModel, vscode.ConfigurationTarget.Global);
      }
    });

    it('VaultFS + 记忆检索回路（node 适配器 + core 混合召回）', async () => {
      await saveMemory({ scope: 'user', body: MARKER + ' 配置解析用 json1 方案处理', tags: ['fact', 'marker'], confidence: 'high' });
      await saveMemory({ scope: 'user', body: '用户偏好简洁的中文回答', tags: ['preference'], confidence: 'medium' });
      await saveMemory({ scope: 'user', body: 'SQLite JSON 查询用 json_extract 函数', tags: ['fact'], confidence: 'medium' });
      const { memories } = await searchMemories(MARKER + ' json1 怎么解析', { k: 5 });
      assert.ok(memories.length > 0, '检索应非空');
      assert.ok(memories[0].body.includes(MARKER), 'top1 应是标记记忆: ' + memories[0].body.slice(0, 40));
      // hits 自增经 VaultFS 落盘
      await sleep(100);
      const again = await searchMemories(MARKER + ' json1 怎么解析', { k: 5 });
      assert.ok(again.memories[0].hits >= 1, 'bumpHits 应写回: hits=' + again.memories[0].hits);
    });

    it('笔记：添加记录 + 编辑后行号锚点平移', async () => {
      const wsFolder = vscode.workspace.workspaceFolders![0];
      assert.ok(wsFolder, '测试工作区应已打开');
      const ctx = (globalThis as any).__markpilotContext as vscode.ExtensionContext;
      const store = new NotesStore(ctx.globalState);
      await ctx.globalState.update('markpilot.notes', []);

      const uri = vscode.Uri.joinPath(wsFolder.uri, 'src', 'sample.md');
      const doc = await vscode.workspace.openTextDocument(uri);
      const ed = await vscode.window.showTextDocument(doc);
      const fk = fileKey(doc.uri.fsPath, wsFolder.uri.fsPath);
      assert.equal(fk, 'src/sample.md');

      await store.add(
        { kind: 'note', scope: 'file', text: '锚点测试笔记', file: fk, startLine: 2, endLine: 3, selectedText: 'l2' },
        wsFolder.name
      );
      refreshDecorations(ed, store, fk, wsFolder.name); // 不抛即高亮路径可用（装饰无读取 API）
      assert.equal(store.forFile(fk, wsFolder.name).length, 1);

      // 在锚点上方插入一行 → 扩展的 onDidChangeTextDocument 应平移行号
      const edit = new vscode.WorkspaceEdit();
      edit.insert(uri, new vscode.Position(0, 0), '插入行\n');
      assert.ok(await vscode.workspace.applyEdit(edit));
      await sleep(400); // shiftLines 是事件驱动的异步落盘
      const after = store.forFile(fk, wsFolder.name);
      assert.equal(after[0].startLine, 3, 'startLine 应 +1');
      assert.equal(after[0].endLine, 4, 'endLine 应 +1');
    });

    it('翻译：mock LLM SSE 流式端到端', async () => {
      capturedBodies.length = 0;
      let acc = '';
      const { text } = await runTranslate({
        settings: mockSettings(),
        text: 'This is a streaming translation test.',
        langTag: 'zh-CN',
        onToken: (tok) => (acc += tok),
      });
      assert.equal(acc, MOCK_REPLY, 'onToken 累计应等于 mock 流');
      assert.equal(text, MOCK_REPLY, '返回全文应等于 mock 流');
      assert.equal(capturedBodies.length, 1, 'mock 应收到一次请求');
      const sys = capturedBodies[0].messages.find((m: any) => m.role === 'system');
      assert.ok(sys && sys.content.includes('translation engine'), 'system prompt 应为翻译引擎指令');
      assert.ok(sys.content.includes('zh-CN'), 'system prompt 应含目标语言 tag');
    });

    it('问答管线：buildLlmMessages 注入长期记忆 + mock 流式回答', async () => {
      capturedBodies.length = 0;
      const settings = mockSettings();
      const { messages } = await buildLlmMessages({
        settings,
        question: MARKER + ' json1 是什么',
        pageText: null,
        notes: [],
        selection: null,
        history: [],
      });
      const memMsg = messages.find((m) => m.content.includes('【用户长期记忆】'));
      assert.ok(memMsg, '应注入【用户长期记忆】消息');
      assert.ok(memMsg!.content.includes(MARKER), '注入内容应含标记记忆');

      let acc = '';
      const r = await streamChat({ settings, messages, onToken: (t) => (acc += t) });
      assert.equal(acc, MOCK_REPLY);
      assert.equal(r.text, MOCK_REPLY);
      // mock 侧请求体应含注入的记忆文本（证明整条 fetch+SSE 链路带上了记忆）
      assert.equal(capturedBodies.length, 1);
      const sent = JSON.stringify(capturedBodies[0].messages);
      assert.ok(sent.includes('【用户长期记忆】') && sent.includes(MARKER), '请求体应含记忆注入');
    });
  });
}

// ---------- @vscode/test-electron 入口 ----------

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 30000 });
  // bdd 接口挂到 globalThis（describe/it/before/after），与 mocha 加载测试文件同机制
  mocha.suite.emit('pre-require', globalThis, 'suite.js', mocha);
  defineTests();
  return new Promise((resolve, reject) => {
    mocha.run((failures) =>
      failures ? reject(new Error(failures + ' 个测试失败')) : resolve()
    );
  });
}
