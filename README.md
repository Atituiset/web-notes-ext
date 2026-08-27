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

## Memory 系统与检索评测

长期记忆（Markdown 文件存 vault）+ 混合检索（词法 sparse + 端侧向量 dense）。设计文档见 [docs/MEMORY-DESIGN.md](docs/MEMORY-DESIGN.md) / [docs/MEMORY-EVAL.md](docs/MEMORY-EVAL.md)。

> **一页总览：[docs/MEMORY-STATUS.md](docs/MEMORY-STATUS.md)**（已上线 / 已验证 / 指标 / 下一步）

检索系统带一套**自动化评测体系**（40 条记忆语料 + 37 条标注查询，recall@5 97.0% / precision@5 66.7% / 拒答 100%）：

- [docs/MEMORY-EVAL-PLAYBOOK.md](docs/MEMORY-EVAL-PLAYBOOK.md) — 评测方法论与复刻指南（怎么建数据集、怎么跑、指标口径）
- [archive/memory-eval/JOURNAL.md](archive/memory-eval/JOURNAL.md) — **全程工程日志**：优化过程的完整回放（每个决策的证据、被数据否决的 6 个方案）
- [docs/plans/memory-opt-roadmap.md](docs/plans/memory-opt-roadmap.md) — 分阶段优化路线图与达标记录
- [archive/memory-eval/](archive/memory-eval/) — 执行报告与模型选型探针脚本

复跑评测：`npm run build && node tests/eval-memory.mjs`（端侧模型免 key；A/B 通道见 PLAYBOOK）
