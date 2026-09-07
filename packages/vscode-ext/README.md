# Markpilot — Code Notes to Obsidian & AI (VS Code)

代码笔记/高亮同步到 Obsidian vault，BYOK 多 provider LLM 问答（带长期记忆注入），选区流式翻译。核心逻辑复用 `@markpilot/core`（与 Chrome 扩展同一份检索/消息组装代码），经 ports & adapters 接入 VS Code 平台。

## 功能

- **Markpilot: Add Note on Selection**（`markpilot.note`，编辑器右键）— 给选区写笔记：选区高亮（黄底），笔记记录存 globalState，编辑代码时行号锚点自动平移
- **Markpilot: Ask AI about Selection**（`markpilot.ask`）— 选区作为上下文挂到侧栏 Chat，提问时连同当前文件正文、本文件笔记、长期记忆（需配 vaultPath）一起注入
- **Markpilot: Translate Selection**（`markpilot.translate`）— 选区流式翻译到侧栏（目标语言 = VS Code 界面语言），完成后可一键「替换选区」
- **Markpilot: Export File Notes to Obsidian**（`markpilot.exportNotes`，或侧栏「导出本文件笔记」按钮）— 本文件笔记写入 `<vaultPath>/Markpilot-Code/code-<文件slug>.md`（幂等，frontmatter source 匹配整文件重写）
- **Markpilot: Set LLM API Key**（`markpilot.setApiKey`）— API Key 存 SecretStorage，不落 settings.json
- 长期记忆：问答时注入 `<vaultPath>/Markpilot-Memory/` 下的记忆检索结果（与 Chrome 版同一套混合召回）；用户画像 `_profile.md` 若存在（由 Chrome 版生成）同样注入

## 设置（settings.json，前缀 `markpilot.`）

| 键 | 默认 | 说明 |
|---|---|---|
| `provider` | `openai-compatible` | opencode / openai-compatible / ollama / openrouter / anthropic / deepseek / zhipu / moonshot / qwen |
| `model` | `""` | 模型 ID |
| `baseUrl` | `""` | 仅 openai-compatible 需要 |
| `vaultPath` | `""` | Obsidian vault 绝对路径；留空则记忆/导出停用（问答仍可用） |
| `memoryInject` | `true` | 提问时注入长期记忆 |
| `exportAiQA` | `false` | 导出时包含 AI 问答记录 |
| `semanticRecall` | `off` | `local` = 端侧 MiniLM 语义召回（见下） |

零配置上手：provider 选 `opencode` + 模型 `mimo-v2.5-free` 等免费模型，无需 API Key。

## 语义召回（可选）

`semanticRecall: "local"` 走 Node 端侧 `Xenova/all-MiniLM-L6-v2`，模型缓存到扩展 globalStorage 目录。
`@xenova/transformers` 是**懒加载的可选依赖**（esbuild external，不进 vsix）：

- 仓库内 F5 调试：依赖已在 workspace 根 hoisting，开箱即用
- 打包安装的 vsix：如需此功能，在扩展目录 `npm i @xenova/transformers`；装不上时静默降级为词法单路检索，不影响其他功能

## 调试（F5）

1. 仓库根 `npm install`，然后 `npm run compile -w @markpilot/vscode-ext`
2. 在 VS Code 打开**仓库根目录**，Run and Debug → 「Run Extension」（或按 F5）启动扩展开发宿主
   - 若无 launch 配置，用 `extensionHost` 类型、`args: ["--extensionDevelopmentPath=${workspaceFolder}/packages/vscode-ext"]`
3. 开发宿主窗口里打开任意项目，先 `Markpilot: Set LLM API Key`（或用 opencode 免费模型），再试三个选区命令

## 手动验证清单（扩展宿主内）

1. 选中一段代码 → 右键 Add Note on Selection → 输入笔记 → 选区出现黄底高亮；在笔记上方插入/删除行，高亮跟随平移
2. 选中一段 → Ask AI about Selection → 侧栏出现选区上下文卡片 → 提问 → 流式回答；点「存为笔记」
3. 配置 `vaultPath` 指向一个 Obsidian vault → 再提问（长期记忆注入不报错即降级正确）；侧栏「导出本文件笔记」→ vault 下出现 `Markpilot-Code/code-*.md`
4. 选中一段中文 → Translate Selection → 侧栏流式出译文 → 「替换选区」→ 编辑器内选区被译文替换

## 打包

```bash
npm run package -w @markpilot/vscode-ext
```

产出 `packages/vscode-ext/markpilot-code-<version>.vsix`（vsce 不接受 npm scope 包名，打包脚本会临时改写 name 为 `markpilot-code` 再恢复；`--no-dependencies` 跳过 monorepo hoisted 依赖收集）。

## 结构

```
src/
  extension.ts        入口：平台装配 + 命令注册 + 高亮恢复/平移
  chat-view.ts        侧栏 webview（问答/翻译/导出 UI 与消息桥）
  notes-store.ts      笔记存储（globalState）+ 装饰高亮
  embedding-node.ts   Node 端侧 dense ranker（setDenseRanker 接线 core memory.ts）
  platform/           core 端口适配器（VaultFS/KVStore/SettingsStore/TextSource）
```

核心复用 `packages/core/src/`：chat-pipeline（消息组装）、memory（混合召回）、llm（provider/SSE）、translate（翻译 prompt）、markdown（frontmatter/callout）、file-key（文件/项目两级 key）。
