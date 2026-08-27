# Chrome Web Store Listing — English

配合 `store-submission.md`（中文版）使用。CWS 后台可添加多个语言版本的 listing。

## Name

```
Markpilot — Web Notes to Obsidian & AI
```

## Short description (≤132 chars)

```
Highlight, take notes, and ask AI right on any page. Export to local Obsidian. BYOK: DeepSeek, Kimi, GLM, OpenRouter, Ollama & more.
```

（128 字符，达标）

## Detailed description

```
Markpilot compresses "read → highlight → remember → understand" into your
browser's side panel.

HIGHLIGHT & NOTE ANYWHERE
Select text on any webpage and jot down your thoughts in one click. Notes are
filed per page and their highlights are restored automatically on reload.

ASK AI IN CONTEXT
Stuck on a paragraph? Select it and hit "Ask AI". The side panel sends the
selected text, the page content, and your own notes to the LLM — so the model
answers about the page you are actually reading, not generic chatter.
Streaming replies, multi-turn threads, and thread history included.

LOCAL OBSIDIAN EXPORT
Authorize your vault once, then export a page's notes and AI Q&A as Markdown
with frontmatter in one click. Long-term memories are written to
Markpilot-Memory/ and injected into future conversations when relevant.

YOUR KEYS, YOUR DATA
· Works with DeepSeek, Zhipu GLM, Moonshot Kimi, Alibaba Qwen, OpenRouter,
  Anthropic, OpenAI-compatible endpoints, opencode free models, and local
  Ollama
· API keys live only in your browser. No accounts, no analytics, no tracking
· Page content is sent only when you explicitly ask, and only to the provider
  you chose
· With local Ollama, nothing ever leaves your machine

OPEN SOURCE
Source code & privacy policy: https://github.com/Atituiset/web-notes-ext

Note: the extension UI is currently Simplified Chinese only. English UI is
planned — follow the GitHub repo for updates.
```

## 权限用途说明（英文版，审核表单用）

| Permission | Justification (paste into form) |
|---|---|
| `storage` | Persists user settings (provider, model, UI state) and a short-lived handoff buffer between the page and the side panel. |
| `sidePanel` | The extension's main UI (notes list and AI chat) lives in the Chrome side panel. |
| `activeTab` | Used only on explicit user action (export / ask) to read the active tab's URL and extract its main text. |
| `scripting` | Companion to activeTab: injects the text-extraction fallback into the current page, only after a user gesture. |
| Content scripts on all URLs | Core functionality — the selection toolbar and note highlights must work on any page the user reads. |
| Host: LLM API domains | Calls the AI providers the user configures (BYOK) for chat completions and model listing. |
| Host: `localhost` / `127.0.0.1` | Connects to a local Ollama instance (localhost:11434) and the Obsidian Local REST plugin (127.0.0.1:27123). |

## Data safety（英文答案）

- Does the extension collect user data? **No.** The developer operates no
  servers; all data stays on the user's device.
- Is page content transferred to third parties? **Only upon explicit user
  action** (asking the AI), and only to the LLM provider the user configured,
  solely to generate that answer.
- API keys: stored locally on the user's device only; never transmitted to the
  developer.
- All network traffic uses HTTPS.

## 截图说明（英文 caption，可选）

1. `01-selection-toolbar.png` — "Select any text to take a note or ask AI"
2. `02-note-popover.png` — "Notes with the original quote, saved per page"
3. `03-panel-chat.png` — "AI answers with your notes and the page as context"
4. `04-options.png` — "BYOK: major providers and local Ollama supported"

注：截图 UI 为中文。如之后做了 UI i18n，用同一脚本
（`scripts/make-screenshots.cjs`）换英文文案重拍即可。
