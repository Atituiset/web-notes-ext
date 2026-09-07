# Markpilot — Web Notes to Obsidian & AI

Highlight, take notes, and ask AI right on any web page. Notes and AI Q&A export to your local Obsidian vault; everything stays on your own device.

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![manifest v3](https://img.shields.io/badge/manifest-v3-green.svg)](manifest.json)
[![chrome >= 114](https://img.shields.io/badge/chrome-%3E%3D114-orange.svg)](https://www.google.com/chrome/)
[![CI](https://github.com/Atituiset/web-notes-ext/actions/workflows/ci.yml/badge.svg)](https://github.com/Atituiset/web-notes-ext/actions/workflows/ci.yml)

## Engineering TL;DR

- [On-device vector search under MV3 CSP constraints](#technical-highlights) — transformers.js + ONNX wasm bundled in-package, nothing loaded from a CDN
- [Zero-install-warning runtime permission architecture](#technical-highlights) — no `host_permissions`; origins computed from settings, granted inside a user gesture
- [Memory retrieval with automated evals](#memory-系统与检索评测) — recall@5 97.0% (NVIDIA channel) / 93.9% (key-free on-device channel); reproduction notes in the Chinese section

## Screenshots

| Selection toolbar | AI chat in the side panel | Page-level / site-level notes |
|---|---|---|
| ![Select any text to take a note or ask AI](docs/store/01-selection-toolbar.png) | ![AI answers with your notes and the page as context](docs/store/03-panel-chat.png) | ![Notes grouped by page and by site](docs/store/05-notes-levels.png) |

## Features

- **Highlight & note anywhere** — select text on any page, jot a thought in one click; highlights restore on reload
- **Page-level / site-level notes** — notes stick to a single page (tracking params stripped, content params kept) or go site-wide in one click
- **Ask AI in context (BYOK)** — the selected text, page content, and your notes go to the LLM you configured: DeepSeek, Zhipu GLM, Moonshot Kimi, Alibaba Qwen, OpenRouter, Anthropic, OpenAI-compatible endpoints, opencode free models, or local Ollama
- **Obsidian / Markdown export** — one click to a vault folder (File System Access), the Local REST API plugin, or a plain `.md` download
- **Long-term memory** — Markdown memory files in your vault, hybrid retrieval (lexical + on-device embeddings) injected into future questions
- **10 languages** — UI follows your browser locale

## Technical highlights

- **On-device vector search under MV3 CSP** — transformers.js ships as a prebuilt ESM inside the extension bundle, with the ONNX wasm binaries packed alongside (`dist/lib/wasm/`), so no remote code ever loads (MV3 CSP forbids it). Embeddings run single-threaded because the threaded backend would spawn blob workers, which extension-page CSP blocks. See [`src/lib/embedding.ts`](packages/core/src/embedding.ts).
- **Zero-install-warning permissions** — no `host_permissions` at all. Host access is computed from your settings ([`requiredOrigins`](packages/core/src/llm/index.ts)) and requested at runtime inside a user gesture (`chrome.permissions.request`), with a friendly guard ([`ensureHostPermission`](packages/core/src/llm/index.ts)) before every fetch. Installing the extension shows no "read all your data on all websites" prompt for host access.
- **Two-channel page-text extraction** — the primary path is a `page:get-text` message to the isolated-world content script ([`packages/chrome-ext/src/content/annotator.js`](packages/chrome-ext/src/content/annotator.js)); the fallback injects the extractor into the MAIN world on demand via `chrome.scripting.executeScript` for tabs that predate the extension. See [`extractPageText`](packages/core/src/chat-pipeline.ts).
- **Memory retrieval with automated evals** — the hybrid retriever is regression-tested against a 40-memory corpus with 37 labeled queries: **recall@5 97.0% / precision@5 66.7% / abstention 100%** (NVIDIA embedding channel; the key-free on-device MiniLM channel scores 93.9% — see the reproduction notes in the Chinese section below). Methodology and full engineering journal: [docs/MEMORY-EVAL.md](docs/MEMORY-EVAL.md), [docs/MEMORY-EVAL-PLAYBOOK.md](docs/MEMORY-EVAL-PLAYBOOK.md), [archive/memory-eval/JOURNAL.md](archive/memory-eval/JOURNAL.md).

Design deep-dive: [docs/DESIGN.md](docs/DESIGN.md) · Memory system status: [docs/MEMORY-STATUS.md](docs/MEMORY-STATUS.md)

---

# Markpilot（中文）

网页划词笔记 → 本地 Obsidian → LLM 问答 浏览器扩展。Chrome 商店名：**Markpilot — Web Notes to Obsidian & AI**。设计见 [docs/DESIGN.md](docs/DESIGN.md)。

## MVP 加载（Chrome/Edge）

1. `npm install && npm run package`（产出可直接加载的 `release/markpilot/` 目录）
2. 打开 `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择 `release/markpilot/` 目录
3. 点击工具栏图标打开侧栏；⚙ 进入设置：配置 provider/model/key，并授权 Obsidian vault 目录（或选择 Local REST API 插件导出方式）
4. 在任意网页选中文字 → 「📝 记笔记」或「🤖 问 AI」

## 结构

monorepo（npm workspaces）：`packages/core` 为平台无关核心（LLM / memory 检索 / obsidian / 翻译，经 `src/ports.ts` 端口注入平台能力），`packages/chrome-ext` 与 `packages/vscode-ext` 为两个平台壳。详见 [docs/DESIGN.md](docs/DESIGN.md) 第 10 节。

- `packages/core/src/llm/` — provider 抽象 + SSE 流式 + 上下文构建器
- `packages/core/src/memory.ts` — 长期记忆混合检索（词法 sparse + 向量 dense 融合）
- `packages/core/src/embedding.ts` — 端侧向量召回通道抽象（local / NVIDIA / OpenRouter）
- `packages/core/src/chat-pipeline.ts` — 问答业务逻辑（预算、memory/profile 注入、AI-QA 笔记保存）
- `packages/chrome-ext/src/content/annotator.js` — 划词捕获 / 字符偏移锚定 / 重高亮，兼正文提取消息主路径
- `packages/chrome-ext/src/content/extract.js` — 正文提取的 executeScript 兜底（MAIN world 注入，简化版 Readability 在 `lib/page-extract.js`）
- `packages/chrome-ext/src/lib/db.js` — IndexedDB（pages/notes/handles/settings/embeddings/threads）
- `packages/chrome-ext/src/lib/url-key.js` → 已迁至 `packages/core/src/url-key.js` — 笔记「本页 / 本站」两级 key
- `packages/chrome-ext/src/platform/` — Chrome 适配器（FS Access vault、IDB KV、chrome.i18n、host 权限、tab 正文提取）
- `packages/chrome-ext/src/panel/` — side panel 笔记列表 + 聊天
- `packages/vscode-ext/` — VS Code 扩展 MVP（选区笔记 / 问 AI / 翻译，见包内 README）

## Memory 系统与检索评测

长期记忆（Markdown 文件存 vault）+ 混合检索（词法 sparse + 端侧向量 dense）。设计文档见 [docs/MEMORY-DESIGN.md](docs/MEMORY-DESIGN.md) / [docs/MEMORY-EVAL.md](docs/MEMORY-EVAL.md)。

> **一页总览：[docs/MEMORY-STATUS.md](docs/MEMORY-STATUS.md)**（已上线 / 已验证 / 指标 / 下一步）

检索系统带一套**自动化评测体系**（40 条记忆语料 + 37 条标注查询）：最优成绩 recall@5 97.0% / precision@5 66.7% / 拒答 100%（NVIDIA embedding 通道，即 `tests/eval/baseline.json` 记录的基线）；默认免 key 的端侧 MiniLM 通道为 recall@5 93.9% / precision@5 59.9% / 拒答 100%。

- [docs/MEMORY-EVAL-PLAYBOOK.md](docs/MEMORY-EVAL-PLAYBOOK.md) — 评测方法论与复刻指南（怎么建数据集、怎么跑、指标口径）
- [archive/memory-eval/JOURNAL.md](archive/memory-eval/JOURNAL.md) — **全程工程日志**：优化过程的完整回放（每个决策的证据、被数据否决的 6 个方案）
- [docs/plans/memory-opt-roadmap.md](docs/plans/memory-opt-roadmap.md) — 分阶段优化路线图与达标记录
- [archive/memory-eval/](archive/memory-eval/) — 执行报告与模型选型探针脚本

复跑评测（通道由 `DENSE_CHANNEL` 环境变量切换，默认 `minilm`）：

```bash
npm run build && node tests/eval-memory.mjs          # 默认 minilm 端侧通道，免 key，成绩约 93.9% recall@5
DENSE_CHANNEL=nvidia NV_KEY=<你的 key> node tests/eval-memory.mjs   # NVIDIA 通道，复现 97.0% 基线（baseline.json 的 channel 即 nvidia）
DENSE_CHANNEL=openrouter OR_KEY=<你的 key> node tests/eval-memory.mjs  # OpenRouter 备选通道
```

## Known limitations / 已知限制

- The one-click translation stream has no abort path yet — closing the floating bubble does not cancel the in-flight request.
- `packages/chrome-ext/src/panel/panel.ts` has grown large and is due for a split (UI rendering vs. chat logic).
- The e2e scripts under `tests/` require a headed Chromium on the local machine; they are not part of CI.

- 划词一键翻译的流式请求尚无 abort 机制——关掉浮窗不会中断正在进行的请求。
- `packages/chrome-ext/src/panel/panel.ts` 体量偏大，待拆分（渲染与聊天逻辑分离）。
- `tests/` 下的 e2e 脚本依赖本机 headed Chromium 运行，不在 CI 内。

## Contributing

Contributions welcome! Bug reports, feature ideas, and PRs are all appreciated. For anything bigger than a small fix, please open an issue first so we can align on direction before you invest the time.

欢迎贡献！报 bug、提想法、发 PR 都欢迎。超过小修复的改动，建议先开 issue 对齐方向再动手。

## License

[MIT](LICENSE)
