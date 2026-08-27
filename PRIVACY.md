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
| 各 LLM 域名 | 调用你配置的服务商 API |
| `localhost` / `127.0.0.1` | 本地 Ollama 模型与 Obsidian Local REST 插件 |

## 六、联系

问题与反馈：https://github.com/Atituiset/web-notes-ext/issues

---

## English Summary

Markpilot stores everything (notes, threads, API keys, settings) **locally** — in your browser's IndexedDB and your own Obsidian vault. We operate **no servers** and collect **nothing**. Page content, your notes, and your question are transmitted over HTTPS **only when you explicitly ask the AI**, and only to the LLM provider **you** configured (or to a local model like Ollama, in which case nothing leaves your machine). No analytics, no tracking, no accounts. Uninstalling removes all local data.
