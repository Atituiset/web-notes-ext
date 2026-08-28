# Memory 系统现状总览（2026-08-28）

> 一页看懂 Memory 目前做到哪、结果如何、下一步是什么。
> 深入阅读：设计 `docs/MEMORY-DESIGN.md` · 基线与评测 `docs/MEMORY-EVAL.md` · 过程日志 `archive/memory-eval/JOURNAL.md` · 决策记录 `docs/plans/memory-opt-roadmap.md`

## 已上线在产品里

**四层记忆**：working（提问时上下文组装）→ short-term（线程最近 8 轮）→ episodic（线程 + AI 问答笔记持久化）→ semantic（vault 里的 Markdown 长期记忆文件）。

| 模块 | 实现 |
|---|---|
| 写入 | LLM 压缩提取（手动「记住」= high 置信；自动候选 = medium 走角标确认流）；去重合并——正文相似度 ≥0.7 时 enrich 原文件而非新建 |
| 检索 | 三因子排序（pin / hits 复述效应 / recency 衰减）+ IDF 加权词面重叠 + 英文停用词 + 词干归一 + tag 感知过滤 + listMemories mtime 缓存 |
| 生命周期 | recency 指数衰减 + 90 天冷记忆标记（管理面板手动清理，不自动删） |
| 存储 | 一条记忆一个 Markdown 文件（frontmatter 全字段），存用户自己的 Obsidian vault，零服务器、零账号 |
| 用户画像（Phase 5） | LLM 聚合既有记忆自动生成 `Markpilot-Memory/_profile.md`（角色与领域带置信度/知识背景/偏好/活跃主题），注入优先级等同 pinned；options 手动生成 + 「新增 N 条记忆可更新」stale 提示；type=profile 不污染检索 |

## 语义召回（已接线进产品，2026-08-28）

**混合向量召回已上线**：`src/lib/embedding.ts` 通道抽象 + IndexedDB 向量缓存（`${model}|${type}|${hash(body)}` 三键，e5 非对称安全）+ panel 启动自动接线（失败静默降级词法）。

- 设置页「语义召回」开关：`off（仅词法）/ local（端侧 MiniLM，默认推荐，零外传）/ NVIDIA API / OpenRouter API` + Embedding API Key 输入
- 端侧通道：transformers.js 预构建包 + 包内 wasm（`dist/lib/`，CSP `wasm-unsafe-eval` + `numThreads=1` 规避 blob worker 限制），模型运行时从 HuggingFace 下载（约 60MB，数据非代码）
- e2e 实测 4/4：改述查询（词面零重叠）被 dense 正确召回、向量落 IDB、对照组确认召回确来自 dense

## 指标结果（自动化评测，37 条标注查询）

| 指标 | 结果 | 达标线 |
|---|---|---|
| recall@5 | **97.0%** | ≥95% ✅ |
| precision@5 | **66.7%** | ≥60% ✅ |
| 拒答正确率 | **100%** | ≥90% ✅ |
| 知识更新正确率 | **100%** | =100% ✅ |
| paraphrase 子集 | **91.7%** | ≥90% ✅ |
| 延迟（1000 条规模 p50） | ~0.4s | ≤400ms ✅ |

- 最优通道：NVIDIA nemotron-3-embed-1b（BYOK API）；端侧 MiniLM-L12 也有 93.9% / 59.9% 的可用成绩（零成本零外传）
- 唯一失败 q26（语义跳跃）——五个候选模型一致失败，确证为数据级难例而非系统缺陷
- 复跑：`npm run build && node tests/eval-memory.mjs`（端侧免 key；A/B 通道见 playbook）

## 工程资产（全部 git 管理）

| 资产 | 位置 |
|---|---|
| 记忆系统设计 | `docs/MEMORY-DESIGN.md` |
| 评测设计 + v1-v4 基线 | `docs/MEMORY-EVAL.md` |
| 评测方法论复刻手册 | `docs/MEMORY-EVAL-PLAYBOOK.md` |
| 分阶段优化决策记录 | `docs/plans/memory-opt-roadmap.md` |
| 全程工程日志（过程回放） | `archive/memory-eval/JOURNAL.md` |
| 执行报告 + 模型选型探针 | `archive/memory-eval/` |
| 评测 harness（数据集/runner/基线回归） | `tests/eval/`、`tests/eval-memory.mjs` |

## 下一步（按优先级）

1. **画像自动演化**——生成触发从手动按钮升级为「新增 N 条记忆自动提示」；画像信号用于消歧 q26/q35 类查询（已有设计，未验证）
2. **API 通道实测**——NVIDIA/OpenRouter 通道在真实扩展里各跑一次（端侧通道已 e2e 验证 4/4）
3. OpenRouter 全量 A/B 复跑（免费日限额重置后，命令已就绪）
