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
import { handleSettingsMessage, buildState } from '../settings-page.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await sleep(100);
  }
  return cond();
}

const MARKER = 'markeralpha77'; // 记忆正文/查询共用标记（tokenize 两侧一致）
const MOCK_REPLY = '这是一段来自模拟模型的流式回答。';

// ---------- mock LLM：OpenAI 兼容 SSE ----------

let mock: http.Server | null = null;
let mockPort = 0;
const capturedBodies: any[] = [];

// /models 端点的应答模式（fetchModels 测试用）
let mockModelsMode: 'ok' | '401' = 'ok';
const MOCK_MODELS = [{ id: 'v4-flash-mock' }, { id: 'v4-pro-mock' }];
// /chat/completions 的应答模式（错误路径测试用）
let mockChatMode: 'ok' | '401' = 'ok';

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
      // OpenAI 兼容 /models：按 mockModelsMode 回模型列表或 401
      if (req.url && req.url.endsWith('/models')) {
        if (mockModelsMode === '401') {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end('{"error":{"message":"Invalid API key"}}');
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: MOCK_MODELS }));
        }
        return;
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          capturedBodies.push(JSON.parse(body));
        } catch { /* 忽略非 JSON */ }
        if (mockChatMode === '401') {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end('{"error":{"message":"Invalid API key"}}');
          return;
        }
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
      for (const c of ['markpilot.note', 'markpilot.ask', 'markpilot.translate', 'markpilot.setApiKey', 'markpilot.exportNotes', 'markpilot.setup', 'markpilot.openSettings']) {
        assert.ok(cmds.includes(c), '命令未注册: ' + c);
      }
    });

    it('设置页：state 快照含 9 平台元数据与密钥存在标志', async () => {
      const ctx = (globalThis as any).__markpilotContext as vscode.ExtensionContext;
      const state = await buildState(ctx.secrets);
      assert.equal(state.providers.length, 9);
      assert.ok(state.providers.every((p: any) => p.label));
      assert.ok('apiKeySet' in state && typeof state.apiKeySet.deepseek === 'boolean');
      assert.ok(!JSON.stringify(state).includes('markpilot.apiKey.'), '快照不应含任何密钥本体/键名');
      assert.ok('memoryInject' in state.settings && 'semanticRecall' in state.settings);
    });

    it('设置页：set 消息写 Global 配置并回发真实 state', async () => {
      const ctx = (globalThis as any).__markpilotContext as vscode.ExtensionContext;
      const cfg = vscode.workspace.getConfiguration('markpilot');
      const replies: any[] = [];
      const deps = { secrets: ctx.secrets, post: (m: any) => replies.push(m) };
      const prev = cfg.get('provider');
      try {
        await handleSettingsMessage({ type: 'set', key: 'provider', value: 'deepseek' }, deps);
        // getConfiguration 是快照 —— 写入后须重新获取才能读到新值
        assert.equal(vscode.workspace.getConfiguration('markpilot').get('provider'), 'deepseek', 'Global 配置应已写入');
        const state = replies.find((r) => r.type === 'state');
        assert.ok(state, 'set 后应回发 state');
        assert.equal(state.settings.provider, 'deepseek');
        // deepseek 有预设模型 → 读时回退到首个预设
        assert.equal(state.settings.model, (PROVIDERS as any).deepseek.models[0]);
        // 白名单外的键被拒绝
        await handleSettingsMessage({ type: 'set', key: 'evil.key', value: 'x' }, deps);
        assert.equal(cfg.get('evil.key'), undefined);
      } finally {
        await cfg.update('provider', prev, vscode.ConfigurationTarget.Global);
      }
    });

    it('设置页 fetchModels：在线列表优先，401 报错且不回退预设', async () => {
      const ctx = (globalThis as any).__markpilotContext as vscode.ExtensionContext;
      const cfg = vscode.workspace.getConfiguration('markpilot');
      const replies: any[] = [];
      const deps = { secrets: ctx.secrets, post: (m: any) => replies.push(m) };
      const P = PROVIDERS as any;
      const prevBase = P.deepseek.presetBase;
      const prevProvider = cfg.get('provider');
      try {
        // 测试 bundle 与 handleSettingsMessage 共享同一份 core 模块状态 ——
        // 临时把 deepseek 端点指到 mock，验证「在线 vs 预设」分辨逻辑
        P.deepseek.presetBase = `http://127.0.0.1:${mockPort}/v1`;
        await cfg.update('provider', 'deepseek', vscode.ConfigurationTarget.Global);

        mockModelsMode = 'ok';
        await handleSettingsMessage({ type: 'fetchModels' }, deps);
        let m = replies.find((r) => r.type === 'models');
        assert.ok(m && !m.error, '在线拉取应成功');
        assert.deepStrictEqual(
          m.models.map((x: any) => x.id).sort(),
          MOCK_MODELS.map((x) => x.id).sort(),
          '应返回 mock 在线列表而非预设 deepseek-chat/reasoner'
        );

        mockModelsMode = '401';
        replies.length = 0;
        await handleSettingsMessage({ type: 'fetchModels' }, deps);
        m = replies.find((r) => r.type === 'models');
        assert.ok(m && m.error, '401 应回错误而非静默回退');
        assert.ok(m.error.includes('401'), '错误应含 401: ' + m.error);
        assert.equal(m.models.length, 0, '错误时不得附带预设列表');
      } finally {
        P.deepseek.presetBase = prevBase;
        mockModelsMode = 'ok';
        await cfg.update('provider', prevProvider, vscode.ConfigurationTarget.Global);
      }
    });

    it('设置页：setApiKey 存 SecretStorage 且不落配置，可清除', async () => {
      const ctx = (globalThis as any).__markpilotContext as vscode.ExtensionContext;
      const replies: any[] = [];
      const deps = { secrets: ctx.secrets, post: (m: any) => replies.push(m) };
      await handleSettingsMessage({ type: 'setApiKey', provider: 'deepseek', key: 'sk-test-9527' }, deps);
      assert.equal(await ctx.secrets.get('markpilot.apiKey.deepseek'), 'sk-test-9527', '密钥应存 SecretStorage');
      const state = replies.find((r) => r.type === 'state');
      assert.equal(state.apiKeySet.deepseek, true, 'state 应报告密钥已存在');
      assert.ok(!JSON.stringify(state).includes('sk-test-9527'), 'state 不应含密钥本体');
      const cfg = vscode.workspace.getConfiguration('markpilot');
      assert.ok(!JSON.stringify(cfg).includes('sk-test-9527'), '密钥不应写入任何配置');
      // 空串 = 清除
      await handleSettingsMessage({ type: 'setApiKey', provider: 'deepseek', key: '' }, deps);
      assert.equal(await ctx.secrets.get('markpilot.apiKey.deepseek'), undefined, '清除后密钥应不存在');
      // 未知 provider 拒绝
      await handleSettingsMessage({ type: 'setApiKey', provider: 'not-a-provider', key: 'x' }, deps);
      assert.equal(await ctx.secrets.get('markpilot.apiKey.not-a-provider'), undefined);
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
      // shiftLines 是事件驱动的异步落盘：轮询而非定长 sleep（400ms 在负载下会偶发不够）
      const shifted = await waitFor(() => {
        const ns = store.forFile(fk, wsFolder.name);
        return ns.length === 1 && ns[0].startLine === 3 && ns[0].endLine === 4;
      }, 8000);
      assert.ok(shifted, 'startLine/endLine 应 +1（当前: ' + JSON.stringify(store.forFile(fk, wsFolder.name)) + '）');

      // 收尾：撤销插入（缓冲区跨运行经 hot-exit 累积会污染后续运行）并清理笔记
      await vscode.commands.executeCommand('undo');
      await ctx.globalState.update('markpilot.notes', []);
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

    it('命令端到端：translate 冷启动（面板未打开）经 ready 握手流到 webview', async () => {
      const chat = (globalThis as any).__markpilotChat as any;
      assert.ok(chat, '扩展应暴露 __markpilotChat');
      const cfg = vscode.workspace.getConfiguration('markpilot');
      const prev = { provider: cfg.get('provider'), model: cfg.get('model'), baseUrl: cfg.get('baseUrl') };
      // spy provider 的出站通道（实例属性覆盖原型方法，this.post 全部经过）
      const posted: any[] = [];
      const origPost = chat.post.bind(chat);
      chat.post = (m: any) => {
        posted.push(m);
        return origPost(m);
      };
      try {
        await cfg.update('provider', 'openai-compatible', vscode.ConfigurationTarget.Global);
        await cfg.update('baseUrl', `http://127.0.0.1:${mockPort}/v1`, vscode.ConfigurationTarget.Global);
        await cfg.update('model', 'mock-model', vscode.ConfigurationTarget.Global);
        mockChatMode = 'ok';

        // 真实编辑器 + 真实选区；chat 视图此前从未 resolve（前面用例均不碰侧栏）—— 冷启动
        const wsFolder = vscode.workspace.workspaceFolders![0];
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(wsFolder.uri, 'src', 'sample.md'));
        const ed = await vscode.window.showTextDocument(doc);
        ed.selection = new vscode.Selection(1, 0, 2, 0);
        await vscode.commands.executeCommand('markpilot.translate');

        const done = await waitFor(() => posted.some((m) => m.type === 'translateDone'), 15000);
        assert.ok(done, 'translateDone 应到达（实际消息: ' + posted.map((m) => m.type).join(',') + ')');
        assert.equal(posted[0].type, 'translateStart', '首条消息应为 translateStart（队列保序）');
        assert.ok(posted.some((m) => m.type === 'token'), '应有流式 token');
        await waitFor(() => chat.ready === true, 5000);
        assert.ok(chat.ready, 'webview 应完成 ready 握手');
        assert.equal(chat.outbox.length, 0, '出站队列应排空');

        // warm 路径：直接 spy webview.postMessage 验证真实到达
        const received: any[] = [];
        const wv = chat.view.webview;
        const origWvPost = wv.postMessage.bind(wv);
        wv.postMessage = (m: any) => {
          received.push(m);
          return origWvPost(m);
        };
        try {
          await vscode.commands.executeCommand('markpilot.translate');
          const done2 = await waitFor(() => received.some((m) => m.type === 'translateDone'), 15000);
          assert.ok(done2, 'warm 路径 translateDone 应到达 webview');
          assert.ok(received.some((m) => m.type === 'token'), 'warm 路径应有 token 到达');
        } finally {
          wv.postMessage = origWvPost;
        }
      } finally {
        chat.post = origPost;
        await cfg.update('provider', prev.provider, vscode.ConfigurationTarget.Global);
        await cfg.update('model', prev.model, vscode.ConfigurationTarget.Global);
        await cfg.update('baseUrl', prev.baseUrl, vscode.ConfigurationTarget.Global);
      }
    });

    it('命令端到端：mock 401 → 错误气泡（含配置指引）到达 webview，不静默', async () => {
      const chat = (globalThis as any).__markpilotChat as any;
      const cfg = vscode.workspace.getConfiguration('markpilot');
      const prev = { provider: cfg.get('provider'), model: cfg.get('model'), baseUrl: cfg.get('baseUrl') };
      const posted: any[] = [];
      const origPost = chat.post.bind(chat);
      chat.post = (m: any) => {
        posted.push(m);
        return origPost(m);
      };
      try {
        await cfg.update('provider', 'openai-compatible', vscode.ConfigurationTarget.Global);
        await cfg.update('baseUrl', `http://127.0.0.1:${mockPort}/v1`, vscode.ConfigurationTarget.Global);
        await cfg.update('model', 'mock-model', vscode.ConfigurationTarget.Global);
        mockChatMode = '401';

        const wsFolder = vscode.workspace.workspaceFolders![0];
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(wsFolder.uri, 'src', 'sample.md'));
        const ed = await vscode.window.showTextDocument(doc);
        ed.selection = new vscode.Selection(0, 0, 1, 0);
        await vscode.commands.executeCommand('markpilot.translate');

        const got = await waitFor(() => posted.some((m) => m.type === 'error'), 15000);
        assert.ok(got, '401 应产生错误消息（实际消息: ' + posted.map((m) => m.type).join(',') + ')');
        const err = posted.find((m) => m.type === 'error');
        assert.ok(err.message.includes('401'), '错误应含 401: ' + err.message);
        assert.ok(/API Key/.test(err.message), '错误应含配置指引: ' + err.message);
        assert.equal(chat.outbox.length, 0, '错误消息不应滞留在队列（webview 已 ready）');
      } finally {
        chat.post = origPost;
        mockChatMode = 'ok';
        await cfg.update('provider', prev.provider, vscode.ConfigurationTarget.Global);
        await cfg.update('model', prev.model, vscode.ConfigurationTarget.Global);
        await cfg.update('baseUrl', prev.baseUrl, vscode.ConfigurationTarget.Global);
      }
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
