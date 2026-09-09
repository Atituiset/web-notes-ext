# Markpilot — Web Notes to Obsidian & AI

Highlight, take notes, and ask AI right on any web page. Notes and AI Q&A export to your local Obsidian vault; everything stays on your own device.

**[Install from the Chrome Web Store](https://chromewebstore.google.com/detail/markpilot-%E2%80%94-web-notes-to/llcenacclhcfkjanoaglkkbphgikeiin)** · **[中文文档](README.zh-CN.md)**

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![manifest v3](https://img.shields.io/badge/manifest-v3-green.svg)](manifest.json)
[![chrome >= 114](https://img.shields.io/badge/chrome-%3E%3D114-orange.svg)](https://www.google.com/chrome/)
[![CI](https://github.com/Atituiset/web-notes-ext/actions/workflows/ci.yml/badge.svg)](https://github.com/Atituiset/web-notes-ext/actions/workflows/ci.yml)

## Engineering TL;DR

- [On-device vector search under MV3 CSP constraints](#technical-highlights) — transformers.js + ONNX wasm bundled in-package, nothing loaded from a CDN
- [Zero-install-warning runtime permission architecture](#technical-highlights) — no `host_permissions`; origins computed from settings, granted inside a user gesture
- [Memory retrieval with automated evals](README.zh-CN.md#memory-系统与检索评测) — recall@5 97.0% (NVIDIA channel) / 93.9% (key-free on-device channel); reproduction notes in the Chinese README

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

## Quick start (Chrome/Edge, unpacked)

For everyday use, install from the [Chrome Web Store](https://chromewebstore.google.com/detail/markpilot-%E2%80%94-web-notes-to/llcenacclhcfkjanoaglkkbphgikeiin). The steps below are for development:

1. `npm install && npm run package` (produces a loadable `release/markpilot/` directory)
2. Open `chrome://extensions` → enable "Developer mode" → "Load unpacked" → select the `release/markpilot/` directory
3. Click the toolbar icon to open the side panel; ⚙ opens settings: configure provider/model/key, and grant the Obsidian vault folder (or choose the Local REST API plugin export mode)
4. Select text on any page → "📝 Note" or "🤖 Ask AI"

## Project structure

Monorepo (npm workspaces): `packages/core` is the platform-agnostic core (LLM / memory retrieval / obsidian / translation, with platform capabilities injected via the `src/ports.ts` ports); `packages/chrome-ext` and `packages/vscode-ext` are the two platform shells. See [docs/DESIGN.md](docs/DESIGN.md) §10 for details.

- `packages/core/src/llm/` — provider abstraction + SSE streaming + context builder
- `packages/core/src/memory.ts` — long-term memory hybrid retrieval (lexical sparse + vector dense fusion)
- `packages/core/src/embedding.ts` — on-device vector recall channel abstraction (local / NVIDIA / OpenRouter)
- `packages/core/src/chat-pipeline.ts` — Q&A business logic (budgets, memory/profile injection, AI-QA note saving)
- `packages/chrome-ext/src/content/annotator.js` — selection capture / char-offset anchoring / re-highlighting, also the primary page-text extraction message path
- `packages/chrome-ext/src/content/extract.js` — executeScript fallback for page-text extraction (MAIN world injection; simplified Readability in `lib/page-extract.js`)
- `packages/chrome-ext/src/lib/db.js` — IndexedDB (pages/notes/handles/settings/embeddings/threads)
- `packages/core/src/url-key.js` — two-level page/site key for notes
- `packages/chrome-ext/src/platform/` — Chrome adapters (FS Access vault, IDB KV, chrome.i18n, host permissions, tab text extraction)
- `packages/chrome-ext/src/panel/` — side panel note list + chat
- `packages/vscode-ext/` — VS Code extension MVP (selection notes / ask AI / translate, see the README inside the package)

## Technical highlights

- **On-device vector search under MV3 CSP** — transformers.js ships as a prebuilt ESM inside the extension bundle, with the ONNX wasm binaries packed alongside (`dist/lib/wasm/`), so no remote code ever loads (MV3 CSP forbids it). Embeddings run single-threaded because the threaded backend would spawn blob workers, which extension-page CSP blocks. See [`src/lib/embedding.ts`](packages/core/src/embedding.ts).
- **Zero-install-warning permissions** — no `host_permissions` at all. Host access is computed from your settings ([`requiredOrigins`](packages/core/src/llm/index.ts)) and requested at runtime inside a user gesture (`chrome.permissions.request`), with a friendly guard ([`ensureHostPermission`](packages/core/src/llm/index.ts)) before every fetch. Installing the extension shows no "read all your data on all websites" prompt for host access.
- **Two-channel page-text extraction** — the primary path is a `page:get-text` message to the isolated-world content script ([`packages/chrome-ext/src/content/annotator.js`](packages/chrome-ext/src/content/annotator.js)); the fallback injects the extractor into the MAIN world on demand via `chrome.scripting.executeScript` for tabs that predate the extension. See [`extractPageText`](packages/core/src/chat-pipeline.ts).
- **Memory retrieval with automated evals** — the hybrid retriever is regression-tested against a 40-memory corpus with 37 labeled queries: **recall@5 97.0% / precision@5 66.7% / abstention 100%** (NVIDIA embedding channel; the key-free on-device MiniLM channel scores 93.9% — reproduction notes in [README.zh-CN.md](README.zh-CN.md#memory-系统与检索评测)). Methodology and full engineering journal: [docs/MEMORY-EVAL.md](docs/MEMORY-EVAL.md), [docs/MEMORY-EVAL-PLAYBOOK.md](docs/MEMORY-EVAL-PLAYBOOK.md), [archive/memory-eval/JOURNAL.md](archive/memory-eval/JOURNAL.md).

Design deep-dive: [docs/DESIGN.md](docs/DESIGN.md) · Memory system status: [docs/MEMORY-STATUS.md](docs/MEMORY-STATUS.md)

## Known limitations

- The one-click translation stream has no abort path yet — closing the floating bubble does not cancel the in-flight request.
- `packages/chrome-ext/src/panel/panel.ts` has grown large and is due for a split (UI rendering vs. chat logic).
- The e2e scripts under `tests/` require a headed Chromium on the local machine; they are not part of CI.

## Contributing

Contributions welcome! Bug reports, feature ideas, and PRs are all appreciated. For anything bigger than a small fix, please open an issue first so we can align on direction before you invest the time.

## License

[MIT](LICENSE)
