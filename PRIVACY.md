# 隐私政策 / Privacy Policy

**生效日期：2026-08-27**

Markpilot（以下简称"本扩展"）是一款划词笔记 + AI 问答工具。本政策说明我们如何处理你的数据。核心原则：**你的数据默认只存在你自己的设备上，我们没有任何服务器，不收集任何信息。**

## 一、数据存储（全部在本地）

以下数据仅存储在你本机的浏览器 IndexedDB 和你自己授权的 Obsidian vault 目录中：

- 你的划词笔记、笔记对应的网页 URL 与标题
- AI 问答的会话记录
- 长期记忆文件（写入你自己选择的 vault 目录）
- 扩展设置，包括 **API Key**（仅存本机，绝不上传到任何我们控制的服务器——我们也没有服务器）

## 二、数据外传（仅在你主动发起时）

只有在你**主动点击"问 AI"或发送提问**时，以下内容会通过 HTTPS 发送给**你自己在设置中选择的 LLM 服务商**，用于生成回答：

- 当前页面的正文提取文本（或仅你选中的文字，取决于你选择的上下文范围）
- 你在该页的笔记
- 你的提问内容

可能的第三方服务商包括（以你实际配置为准）：DeepSeek、智谱 GLM、月之暗面 Kimi、阿里通义千问、OpenRouter、Anthropic、OpenAI 兼容端点、opencode.ai，或你自建的本地模型（Ollama，数据不出本机）。这些传输遵循相应服务商的隐私政策，我们不经手、不留存这些数据。

此外，设置页拉取模型列表时会向你配置的服务商端点发起只读请求；为增强模型搜索，会抓取 opencode.ai 的公开文档页（纯数据，不执行任何远程代码）。

首次启用本地向量模型（语义召回）时，扩展会从 HuggingFace（huggingface.co）下载公开的模型权重到你的设备——这是纯下载，不会上传任何你的数据。

## 三、我们不做的事

- 不收集、不传输任何数据到我们自己的服务器（我们没有服务器）
- 不做任何分析统计、行为追踪、广告画像
- 不要求注册账号
- 不在后台静默读取或上传页面内容——页面内容只在你主动提问时被读取和发送

## 四、你的控制权

- 笔记、会话可随时在侧栏逐条删除
- 长期记忆文件就是你 vault 里的普通 Markdown 文件，可直接管理
- 卸载扩展即清除全部本地数据（IndexedDB 随卸载删除；vault 中的文件由你自行保留或删除）

## 五、权限用途

| 权限 | 用途 |
|---|---|
| `storage` | 保存设置与临时状态 |
| `sidePanel` | 提供侧栏界面 |
| `activeTab` + `scripting` | 你主动提问/导出时提取当前页正文（兜底通道） |
| 内容脚本（所有网站） | 划词工具条、笔记高亮需要在任意页面工作 |
| 可选主机权限：各 LLM 域名 | 调用你配置的服务商 API；在你保存设置选择对应服务商时按需请求授权，非声明的固定权限 |
| 可选主机权限：`localhost` / `127.0.0.1` | 本地 Ollama 模型与 Obsidian Local REST 插件；在你保存设置选择本地模型时按需请求授权 |
| 可选主机权限：huggingface.co | 首次使用本地向量模型（语义召回）时下载公开模型权重（纯下载）；在你保存设置启用该通道时按需请求授权 |
| 可选站点权限（可选） | 仅在你主动提问且正文提取失败时，经你当场确认后用于提取该站正文 |

## 六、联系

问题与反馈：https://github.com/Atituiset/web-notes-ext/issues

---

# Privacy Policy (English)

**Effective date: 2026-08-27**

Markpilot ("the extension") is a highlight-and-note tool with AI Q&A. Core principle: **your data stays on your device by default. We run no servers and collect nothing.**

## 1. Data storage (local only)

The following data is stored only in your browser's IndexedDB and in the Obsidian vault directory you explicitly authorize:

- Your notes, along with the URLs and titles of the pages they belong to
- AI conversation threads
- Long-term memory files (written to the vault directory you chose)
- Extension settings, including **API keys** (local only; never uploaded to any server — we have none)

## 2. Data transmission (only on your explicit action)

Only when **you actively click "Ask AI" or send a question** is the following transmitted over HTTPS to the LLM provider **you configured**, solely to generate that answer:

- Extracted text of the current page (or only your selection, depending on the context scope you choose)
- Your notes on that page
- Your question

Possible third-party providers (whichever you actually configure): DeepSeek, Zhipu GLM, Moonshot Kimi, Alibaba Qwen, OpenRouter, Anthropic, OpenAI-compatible endpoints, opencode.ai, or a self-hosted local model (Ollama — in which case nothing leaves your machine). These transfers are governed by the respective provider's privacy policy; we never touch or retain this data.

Additionally, the settings page makes read-only requests to your configured provider to list available models, and fetches a public documentation page from opencode.ai to enrich model search (data only — no remote code is ever executed).

The first time you enable the local embedding model (semantic recall), the extension downloads public model weights from HuggingFace (huggingface.co) to your device — a pure download; no data of yours is ever uploaded.

## 3. What we never do

- No data is collected or transmitted to any server of ours (we have none)
- No analytics, no behavioral tracking, no advertising profiles
- No accounts
- No silent background reading or uploading of page content — page content is read and sent only when you explicitly ask a question

## 4. Your control

- Delete any note or conversation individually in the side panel
- Long-term memories are plain Markdown files in your own vault — manage them directly
- Uninstalling the extension removes all local data (IndexedDB is deleted on uninstall; files in your vault remain yours to keep or delete)

## 5. Permissions

| Permission | Purpose |
|---|---|
| `storage` | Settings and transient state |
| `sidePanel` | The extension's side panel UI |
| `activeTab` + `scripting` | Extract current page text when you explicitly ask or export (fallback channel) |
| Content scripts (all sites) | The selection toolbar and note highlights must work on any page |
| Optional host access: LLM API domains | Calls to the provider you configured; requested on demand when you save settings with that provider selected — not a declared always-on permission |
| Optional host access: `localhost` / `127.0.0.1` | Local Ollama and the Obsidian Local REST plugin; requested on demand when you save settings with a local model selected |
| Optional host access: huggingface.co | One-time download of public model weights the first time you use the local embedding model (semantic recall); download only, nothing is uploaded; requested on demand when you enable that channel in settings |
| Optional site access | Only used to extract page text when you explicitly ask and extraction fails; granted per-site with your consent |

## 6. Contact

Issues and feedback: https://github.com/Atituiset/web-notes-ext/issues
