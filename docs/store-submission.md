# Chrome Web Store 提交材料

提交入口：https://chrome.google.com/webstore/devconsole
按表单项整理，直接复制即可。

## 基本信息

- **名称**：Markpilot — Web Notes to Obsidian & AI
- **分类**：效率工具（Productivity）
- **语言**：中文（简体）
- **隐私政策 URL**：`https://github.com/Atituiset/web-notes-ext/blob/main/PRIVACY.md`
  （或开启 GitHub Pages 后填 Pages 链接，更正式）

## 简短说明（≤132 字符）

```
划词记笔记，AI 就地问答。笔记和问答导出到本地 Obsidian，支持 DeepSeek/Kimi/GLM/OpenRouter/本地 Ollama，数据只存在你自己的设备上。
```

## 详细说明

```
Markpilot 把「读到 → 划下 → 记住 → 问透」压缩进浏览器侧栏。

【划词笔记】
在任意网页选中文字，一键记下心得。笔记按页面归档，刷新后自动恢复高亮。

【AI 就地问答】
选中读不懂的段落点「问 AI」，侧栏自动带着选中原文、页面正文和你的笔记向 LLM
提问——模型回答的是"你正在读的这一页"，而不是泛泛而谈。支持流式输出、
多轮会话、会话历史管理。

【本地 Obsidian 落盘】
一次授权 vault 目录，之后一键把整页笔记 + AI 问答导出为带 frontmatter 的
Markdown。长期记忆自动写入 Markpilot-Memory/，跨会话提问时按需注入。

【你的 Key，你的数据】
· 支持 DeepSeek / 智谱 GLM / 月之暗面 Kimi / 通义千问 / OpenRouter /
  Anthropic / OpenAI 兼容端点 / opencode 免费模型 / 本地 Ollama
· API Key 只存本机浏览器，没有账号体系，没有任何分析统计
· 页面内容仅在你主动提问时发送给你自己选择的服务商
· 用本地 Ollama 时，数据完全不离开你的设备

【开源】
源码与隐私政策：https://github.com/Atituiset/web-notes-ext
```

## 权限用途说明（审核表单逐条填写）

| 权限 | 填写理由 |
|---|---|
| `storage` | 保存用户设置（provider、模型、界面状态）与跨页面会话的临时缓冲 |
| `sidePanel` | 本扩展的主界面就是 Chrome 侧栏（笔记列表与 AI 问答） |
| `activeTab` | 用户主动点击导出/提问时，提取当前标签页的正文与 URL（仅在用户手势触发时使用） |
| `scripting` | 与 activeTab 配合，在用户手势下向当前页注入正文提取脚本（兜底通道） |
| 内容脚本 `<all_urls>` | 核心功能是在任意网页上划词弹出笔记工具条、并对已记笔记的文本恢复高亮，必须在所有页面注入 |
| host：各 LLM API 域名 | 调用用户自己配置的服务商 API 进行问答与模型列表拉取（BYOK） |
| host：`localhost` / `127.0.0.1` | 连接本机 Ollama 模型（localhost:11434）与 Obsidian Local REST 插件（127.0.0.1:27123） |

## 数据使用披露（Data safety 表单）

- 是否收集用户数据：**否**（无自有服务器；一切存储在用户本机）
- 页面内容是否传输给第三方：**是，但仅在用户主动发起问答时**，接收方是用户
  自行配置的 LLM 服务商；传输目的仅为生成当次回答
- API Key：仅存用户本机，不传输给开发者
- 加密传输：全部 HTTPS

## 商店素材清单

- [x] 图标 128×128：`icons/icon128.png`
- [x] 截图（`docs/store/`，1280×800）：
  - `01-selection-toolbar.png` 划词工具条
  - `02-note-popover.png` 笔记弹窗
  - `03-panel-chat.png` 侧栏 AI 问答（合成图：网页 + 侧栏）
  - `04-options.png` 设置页（含模型测试）
- [ ] 宣传磁贴 440×280（可选，想进精选位再做）
