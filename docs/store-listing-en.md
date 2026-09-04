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

PAGE-LEVEL AND SITE-LEVEL NOTES
Notes stick to a single page by default — content-bearing query params like
?id= are respected, tracking params like utm_* are dropped, so notes never
bleed across article variants. Flip any note to "site-wide" and it appears in
the side panel on every page of that domain, and feeds the AI context too.

ASK AI IN CONTEXT
Stuck on a paragraph? Select it and hit "Ask AI". The side panel sends the
selected text, the page content, and your own notes to the LLM — so the model
answers about the page you are actually reading, not generic chatter.
Streaming replies, multi-turn threads, and thread history included.

LOCAL OBSIDIAN EXPORT
Authorize your vault once, then export a page's notes and AI Q&A as Markdown
with frontmatter in one click. The output is plain Markdown, so any
Markdown-based notes folder works too (Logseq, Foam, you name it).
Long-term memories are written to Markpilot-Memory/ and injected into
future conversations when relevant.

BACKUP & MIGRATION
Export all notes as JSON from the settings page in one click; import to
restore when switching browsers, devices, or moving from a dev build to the
store build. Your data sovereignty, end to end.

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

The UI speaks your language: Simplified Chinese and English are built in,
following your browser language automatically.
```

## 权限用途说明（英文版，审核表单用）

| Permission | Justification (paste into form) |
|---|---|
| `storage` | Persists user settings (provider, model, UI state) and a short-lived handoff buffer between the page and the side panel. |
| `sidePanel` | The extension's main UI (notes list and AI chat) lives in the Chrome side panel. |
| `activeTab` | Used only on explicit user action (export / ask) to read the active tab's URL and extract its main text. |
| `scripting` | Companion to activeTab: injects the text-extraction fallback into the current page, only after a user gesture. |
| Content scripts on all URLs | Core functionality — the selection toolbar and note highlights must work on any page the user reads. |
| Optional host access (http/https wildcard, requested at runtime) | The extension declares no fixed host permissions; everything is an optional permission requested inside a user gesture: ① on settings save, the origin of the configured LLM provider (BYOK chat and model listing), local Ollama (localhost:11434) / Obsidian Local REST plugin (127.0.0.1:27123), and huggingface.co for the local embedding channel (first use downloads public model weights only — nothing is uploaded); ② when page-text extraction fails after an explicit user question (e.g. the page predates the extension), per-site access is requested on confirmation to inject the extraction script on demand. |

## Data safety（英文答案）

- Does the extension collect user data? **No.** The developer operates no
  servers; all data stays on the user's device.
- Is page content transferred to third parties? **Only upon explicit user
  action** (asking the AI), and only to the LLM provider the user configured,
  solely to generate that answer.
- Local embedding model (semantic recall): on first use, public model weights
  are downloaded from HuggingFace to the user's device — a pure download; no
  user data is uploaded.
- API keys: stored locally on the user's device only; never transmitted to the
  developer.
- All network traffic uses HTTPS.

## 截图说明（英文 caption，可选）

1. `01-selection-toolbar.png` — "Select any text to take a note or ask AI"
2. `02-note-popover.png` — "Notes with the original quote, saved per page or site-wide"
3. `03-panel-chat.png` — "AI answers with your notes and the page as context"
4. `04-options.png` — "BYOK: major providers and local Ollama supported"
5. `05-notes-levels.png` — "Notes grouped by page and by site"

注：截图 UI 为中文。扩展 v0.2.7 起 UI 支持中英文（跟随浏览器语言自动切换），
英文版截图可用同一脚本（`scripts/make-screenshots.cjs`）在英文 locale 下重拍。
