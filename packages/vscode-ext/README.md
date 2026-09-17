# Markpilot — Code Notes to Obsidian & AI

**[Install from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=atituiset.markpilot-code)** · **[中文文档](README.zh-CN.md)**

[![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/v/atituiset.markpilot-code)](https://marketplace.visualstudio.com/items?itemName=atituiset.markpilot-code)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Code notes & highlights synced to an Obsidian vault, BYOK multi-provider LLM Q&A with long-term memory, and streaming selection translation. The core pipeline is shared with the [Markpilot Chrome extension](https://chromewebstore.google.com/detail/markpilot-%E2%80%94-web-notes-to/llcenacclhcfkjanoaglkkbphgikeiin) (web notes / page Q&A), so your memory and profile carry over between browser and editor.

## Features

- **Add Note on Selection** (editor context menu) — attach a note to any selection; the selection gets a yellow highlight, and the note's line anchor shifts automatically as you edit the code above it.
- **Ask AI about Selection** — sends the selection to the sidebar Chat as context; questions are answered with the current file, your notes on the file, and long-term memory (when a vault is configured) injected.
- **Translate Selection** — streams a translation of the selection into the sidebar (target language follows your VS Code display language), with one-click **Replace Selection**.
- **Export File Notes to Obsidian** — writes this file's notes to `<vaultPath>/Markpilot-Code/code-<file>.md` (idempotent, full-file rewrite matched by frontmatter source).
- **Long-term memory** — Q&A is augmented with retrieval results from `<vaultPath>/Markpilot-Memory/` (same hybrid recall as the Chrome version); a `_profile.md` user profile, if present, is injected too.
- **Bring Your Own Key** — 9 provider presets (OpenCode free models, OpenAI-compatible, Ollama, OpenRouter, Anthropic, DeepSeek, Zhipu GLM, Moonshot Kimi, Qwen). Keys are stored in VS Code SecretStorage, never in `settings.json`.
- **Reasoning display & prompt templates** — thinking models (e.g. deepseek-flash) stream their reasoning into a collapsible block; type `/` in the chat input for preset prompts (`/explain`, `/review`, `/doc`, `/test`).

## Quick start

Zero-config path — no API key needed:

1. Command Palette → **Markpilot: 快速配置** (Quick Setup)
2. Pick **opencode** as the provider, then a free model such as `mimo-v2.5-free`
3. Select some code → right-click → **Ask AI about Selection**

For fine-tuning, use **Markpilot: 打开设置** (Open Settings — gear icon in the Chat view title): a full-page settings UI with provider picker, API key status, live model list fetching, and a connection test. Changes apply immediately.

## Settings

All settings live under the `markpilot.` prefix (the settings page edits them for you):

| Key | Default | Description |
|---|---|---|
| `provider` | `openai-compatible` | `opencode` / `openai-compatible` / `ollama` / `openrouter` / `anthropic` / `deepseek` / `zhipu` / `moonshot` / `qwen` |
| `model` | `""` | Model ID; falls back to the provider's first preset when empty |
| `baseUrl` | `""` | Only needed for `openai-compatible` |
| `vaultPath` | `""` | Absolute path to your Obsidian vault; memory/export disabled when empty (Q&A still works) |
| `memoryInject` | `true` | Inject long-term memory into questions |
| `exportAiQA` | `false` | Include AI Q&A history when exporting notes |
| `semanticRecall` | `off` | `local` = on-device MiniLM semantic recall (see below) |

## Semantic recall (optional)

`semanticRecall: "local"` runs an on-device `Xenova/all-MiniLM-L6-v2` ranker (model cached in the extension's globalStorage). `@xenova/transformers` is a lazily-loaded optional dependency and is **not** bundled in the vsix — if you want this feature, run `npm i @xenova/transformers` in the extension directory. When unavailable, recall silently degrades to lexical-only retrieval; everything else is unaffected.

## Privacy

- API keys live in VS Code SecretStorage; the settings UI only shows whether a key exists, never the key itself.
- Notes and memory are stored locally (VS Code globalState + your own Obsidian vault). Nothing is uploaded to any Markpilot server — there is none.
- Network traffic goes only to the LLM provider you configured. See [PRIVACY.md](https://github.com/Atituiset/web-notes-ext/blob/main/PRIVACY.md) for details.

## Links

- Source code & issues: [github.com/Atituiset/web-notes-ext](https://github.com/Atituiset/web-notes-ext) (`packages/vscode-ext`)
- Sibling Chrome extension (web notes → Obsidian, same memory): [Chrome Web Store](https://chromewebstore.google.com/detail/markpilot-%E2%80%94-web-notes-to/llcenacclhcfkjanoaglkkbphgikeiin)
- Development / contributing: [CONTRIBUTING.md](CONTRIBUTING.md)
