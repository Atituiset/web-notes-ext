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

【笔记分级：本页 / 本站】
笔记默认跟随单个页面（自动识别 ?id= 等正文参数，丢弃 utm 等跟踪参数，
不再出现"换了个页面参数笔记就串了"的问题）。也可以一键设为「本站」——
在同域名所有页面的侧栏都能看到，问 AI 时同样注入上下文。
整页与整站随时切换，侧栏分组展示一目了然。

【AI 就地问答】
选中读不懂的段落点「问 AI」，侧栏自动带着选中原文、页面正文和你的笔记向 LLM
提问——模型回答的是"你正在读的这一页"，而不是泛泛而谈。支持流式输出、
多轮会话、会话历史管理。

【本地 Obsidian 落盘】
一次授权 vault 目录，之后一键把整页笔记 + AI 问答导出为带 frontmatter 的
Markdown。产物是标准 Markdown 文件，也可以导出到任何 Markdown 笔记目录
（Logseq、Foam 等通用）。长期记忆自动写入 Markpilot-Memory/，
跨会话提问时按需注入。

【备份与迁移】
设置页一键导出全部笔记为 JSON；换浏览器、换设备（或从开发版切换到商店版）
时导入即恢复，数据主权完全在你手里。

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
| optional host（http/https 通配，运行时按需请求） | 扩展不声明任何固定 host 权限，全部走可选权限在用户手势内当场请求：① 保存设置时，按所选服务商请求对应 LLM API 域名（BYOK 问答与模型列表拉取）、本地 Ollama（localhost:11434）/ Obsidian Local REST 插件（127.0.0.1:27123）、以及本地向量模型通道的 huggingface.co（首次使用仅下载公开模型权重，纯下载不上传）；② 用户主动提问但正文提取失败时（如页面先于扩展打开），经确认后按需注入提取脚本。CWS 推荐的可选权限模式 |

## 数据使用披露（Data safety 表单）

- 是否收集用户数据：**否**（无自有服务器；一切存储在用户本机）
- 页面内容是否传输给第三方：**是，但仅在用户主动发起问答时**，接收方是用户
  自行配置的 LLM 服务商；传输目的仅为生成当次回答
- 本地向量模型（语义召回）：首次启用时从 HuggingFace 下载公开模型权重到用户
  设备，为纯下载，不上传任何用户数据
- API Key：仅存用户本机，不传输给开发者
- 加密传输：全部 HTTPS

## 商店素材清单

- [x] 图标 128×128：`icons/icon128.png`
- [x] 截图（`docs/store/`，1280×800）：
  - `01-selection-toolbar.png` 划词工具条
  - `02-note-popover.png` 笔记弹窗（含「整个站点可见」选项）
  - `03-panel-chat.png` 侧栏 AI 问答（合成图：网页 + 侧栏）
  - `04-options.png` 设置页（含模型测试）
  - `05-notes-levels.png` 笔记分级列表（本页 / 本站）
- [x] 宣传磁贴 440×280：`docs/store/promo-tile-440x280.png`

截图重拍：`npm run build && node scripts/make-screenshots.cjs`
磁贴更新：`node scripts/make-promo-tile.cjs`

## 扩展 ID 与 manifest key（重要）

`manifest.json` 内含 `"key"` 字段（公钥），对应私钥在仓库根目录
`markpilot-key.pem`（已 gitignore，**切勿提交或泄露**）。

- **固定扩展 ID**：`pfkejpdbaikhknckilankommnlhmhigm`（由该 key 决定）
- 本地加载（load unpacked）与商店版因此共享同一 ID，用户数据（IndexedDB）互通
- **首次上传商店时务必保留 manifest 中的 key 字段**，商店会用它确定永久 ID；
  若删掉，商店版 ID 会变，老用户笔记将"不可见"（数据没丢，但读取不到）
- 私钥仅在需要本地打 .crx 自测时用到；商店签名由 Google 托管，无需上传私钥
