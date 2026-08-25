# Markpilot (web-notes-ext)

网页划词笔记 → 本地 Obsidian → LLM 问答 浏览器插件。Chrome 商店名：**Markpilot — Web Notes to Obsidian & AI**。设计见 [docs/DESIGN.md](docs/DESIGN.md)。

## MVP 加载（Chrome/Edge）

1. 打开 `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择本目录
2. 点击工具栏图标打开侧栏；⚙ 进入设置：配置 provider/model/key，并授权 Obsidian vault 目录
3. 在任意网页选中文字 → 「📝 记笔记」或「🤖 问 AI」

## 结构

- `src/content/annotator.js` — 划词捕获 / 字符偏移锚定 / 重高亮（notes.js 移植）
- `src/content/extract.js` — 简化 Readability 正文提取
- `src/lib/db.js` — IndexedDB（pages/notes/handles/settings）
- `src/lib/obsidian.js` — 三通道导出（fs-access 主 / obsidian:// 兜底 / REST API）
- `src/lib/llm/` — provider 抽象 + SSE 流式 + 上下文构建器
- `src/panel/` — side panel 笔记列表 + 聊天
