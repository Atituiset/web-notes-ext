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

## 已验证、尚未接进产品

**混合向量召回**（sparse 词法 + dense 向量，`setDenseRanker` 注入接口 + 真空门控加和融合）：代码与三通道（NVIDIA / 端侧 MiniLM / OpenRouter）已在评测环境完整验证。**产品内目前仍跑词法单路**——embedding 产品化接线（provider 抽象、IndexedDB 向量缓存、设置开关）是明确的下一步。

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

1. **embedding 产品化接线**——provider 抽象按 NVIDIA > 端侧 MiniLM > OpenRouter 优先级；向量缓存复用 query/passage 双键（坑已记录）；设置页开关
2. **Phase 5 用户画像**——自动抽取的派生画像（LLM 聚合既有记忆生成 Profile.md，注入等同 pinned）；也是解 q26/q35 类歧义所需的上下文信号
3. OpenRouter 全量 A/B 复跑（免费日限额重置后，命令已就绪）
