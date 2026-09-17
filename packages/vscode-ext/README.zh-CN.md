# Markpilot — 代码笔记同步 Obsidian & AI 问答（VS Code）

**[从 VS Code 市场安装](https://marketplace.visualstudio.com/items?itemName=atituiset.markpilot-code)** · **[English](README.md)**

代码笔记/高亮同步到 Obsidian vault,BYOK 多平台 LLM 问答（带长期记忆注入），选区流式翻译。核心管线与 [Markpilot Chrome 扩展](https://chromewebstore.google.com/detail/markpilot-%E2%80%94-web-notes-to/llcenacclhcfkjanoaglkkbphgikeiin)（网页笔记/页面问答）共享,记忆与画像在浏览器和编辑器之间互通。

## 功能

- **Add Note on Selection**（编辑器右键）— 给选区写笔记：选区高亮（黄底），编辑代码时行号锚点自动平移
- **Ask AI about Selection** — 选区作为上下文挂到侧栏 Chat，提问时连同当前文件正文、本文件笔记、长期记忆（需配 vaultPath）一起注入
- **Translate Selection** — 选区流式翻译到侧栏（目标语言跟随 VS Code 界面语言），完成后可一键「替换选区」
- **Export File Notes to Obsidian** — 本文件笔记写入 `<vaultPath>/Markpilot-Code/code-<文件>.md`（幂等，frontmatter source 匹配整文件重写）
- **长期记忆** — 问答时注入 `<vaultPath>/Markpilot-Memory/` 的检索结果（与 Chrome 版同一套混合召回）；用户画像 `_profile.md` 若存在同样注入
- **BYOK** — 9 个平台预设（OpenCode 免费模型、OpenAI 兼容、Ollama、OpenRouter、Anthropic、DeepSeek、智谱 GLM、月之暗面 Kimi、通义千问）。密钥存 VS Code SecretStorage，不落 `settings.json`
- **思考过程展示 & 提问模板** — 推理模型（如 deepseek-flash）的思考流式进可折叠块；聊天输入框敲 `/` 呼出预设模板（`/explain`、`/review`、`/doc`、`/test`)

## 快速上手

零配置路径——无需 API Key:

1. 命令面板 → **Markpilot: 快速配置**
2. 平台选 **opencode**，模型选 `mimo-v2.5-free` 等免费模型
3. 选中一段代码 → 右键 → **Ask AI about Selection**

精细调整走 **Markpilot: 打开设置**（侧栏 Chat 标题栏齿轮）：整页设置 UI，平台切换、Key 状态指示、在线拉取模型列表、测试连接，即改即存。

## 设置

所有设置以 `markpilot.` 为前缀（设置页会替你改）:

| 键 | 默认 | 说明 |
|---|---|---|
| `provider` | `openai-compatible` | `opencode` / `openai-compatible` / `ollama` / `openrouter` / `anthropic` / `deepseek` / `zhipu` / `moonshot` / `qwen` |
| `model` | `""` | 模型 ID；留空回退到该平台首个预设 |
| `baseUrl` | `""` | 仅 `openai-compatible` 需要 |
| `vaultPath` | `""` | Obsidian vault 绝对路径；留空则记忆/导出停用（问答仍可用） |
| `memoryInject` | `true` | 提问时注入长期记忆 |
| `exportAiQA` | `false` | 导出笔记时包含 AI 问答记录 |
| `semanticRecall` | `off` | `local` = 端侧 MiniLM 语义召回（见下） |

## 语义召回（可选）

`semanticRecall: "local"` 走端侧 `Xenova/all-MiniLM-L6-v2`（模型缓存到扩展 globalStorage)。`@xenova/transformers` 是懒加载的可选依赖，**不在 vsix 里**——需要该功能时在扩展目录 `npm i @xenova/transformers`。装不上时静默降级为词法单路检索，不影响其他功能。

## 隐私

- API Key 存 VS Code SecretStorage；设置页只显示是否存在，永不下发密钥本体
- 笔记与记忆全部本地存储（VS Code globalState + 你自己的 Obsidian vault),Markpilot 没有服务器
- 网络请求只发往你配置的 LLM 平台。详见 [PRIVACY.md](https://github.com/Atituiset/web-notes-ext/blob/main/PRIVACY.md)

## 链接

- 源码与 issue:[github.com/Atituiset/web-notes-ext](https://github.com/Atituiset/web-notes-ext)(`packages/vscode-ext`)
- 姊妹 Chrome 扩展（网页笔记 → Obsidian，同一套记忆）:[Chrome Web Store](https://chromewebstore.google.com/detail/markpilot-%E2%80%94-web-notes-to/llcenacclhcfkjanoaglkkbphgikeiin)
- 开发/贡献:[CONTRIBUTING.md](CONTRIBUTING.md)
