# Memory 生产级优化路线图（recall / precision 达标计划）

> 状态：进行中（2026-08-28 启动）
> 上游：`docs/MEMORY-DESIGN.md`、`docs/MEMORY-EVAL.md`
> 方法：**评测驱动**——每个阶段先落计划（本文件分节记录）、实现、跑 `tests/eval-memory.mjs` 对比基线、达标后写新基线并 commit，全程可回放。
> 测试 LLM 资源：需要真实模型时（提取/embedding）用 OpenRouter 与 OpenCode 的免费模型，避免引入密钥依赖。

## 达标定义（验收线）

| 指标 | 口径 | 目标 |
|---|---|---|
| recall@5 | 标准答案至少一条进 top5 | **≥ 95%**（且每个类别 ≥ 90%） |
| precision@5 | top5 中相关记忆占比，**分母排除 pinned**（pinned 是设计注入） | **≥ 60%** |
| 拒答正确率 | 无相关记忆时零注入（排除 pinned） | **≥ 90%** |
| 知识更新正确率 | 新版排在旧版前 | **= 100%**（保持） |
| 延迟 | searchMemories(k=5) 1000 条规模 p50 | **≤ 400ms**（保持） |

当前起点（v2 基线）：recall@5 100% / abstain 75% / knowledgeUpdate 100% / 延迟 337ms。
precision 口径在 Phase 1 修正后才能测量（旧口径分母含 pinned 且期望集过窄，24.8% 是口径假象）。

## 阶段计划

### Phase 1 — 测量基础：precision 口径修正 + 相关性标注（本阶段）

- 问题：旧 precision@5 = |top5∩expect|/5，分母含 pinned（永远占 1 席）、expect 只标"必须命中"而非"全部可接受"，导致数值被结构性压扁，无法指导优化。
- 动作：
  1. `tests/eval/dataset.mjs` 每条查询增加 `relevant` 字段（该查询下所有算"相关"的记忆 id，expect ⊆ relevant）
  2. runner 的 precision@5 改为 |top5∩relevant| / |top5 中非 pinned|；报告同步标注口径
  3. 重记基线（baseline.json 加 metricVersion 字段，v2=新口径）
- 验收：跑通，输出新口径 precision，基线落盘，commit。

### Phase 2 — 语义天花板探测：改述查询集（✅ 已完成，结论：需要向量）

- 动作（已做）：数据集新增 8 条 paraphrase 查询（q26-q33，查询与记忆措辞完全不同、语义相同）。
- **结果：paraphrase 子集 recall 仅 3/8（37.5%）**，整体 recall@5 从 100% 掉到 82.8%——词法检索的语义天花板被数据证实（典型：f2「SW 休眠断长连接」应答不了「流式回答中途断掉」；k3「主动阅读提取动作」应答不了「怎样读书记得牢」）。
- 结论：**触发 Phase 3**。当前 82.8% 的 recall@5 作为向量混合召回要击败的参照点（目标 ≥95%，paraphrase 子集 ≥90%）。
- 测试 LLM 通道：OpenRouter / OpenCode 免费模型（embedding 可用性在 Phase 3 探测）。

### Phase 3 — 混合召回（✅ 已确认启动）

- 方案：OpenRouter 免费 embedding 模型（先探测可用性；备选 Ollama 本地 embedding）→ 记忆向量缓存进 IndexedDB（文件 mtime 失效，复用 listMemories 缓存模式）→ 查询向量 cosine + 词法分数 **RRF 融合** → 混合检索跑全量评测对比基线。
- 不引入重型浏览器向量库组件——<1000 条规模下 IDB 平面向量 + JS 暴力余弦就是"轻量级向量数据库"的合理形态。
- 验收：paraphrase 子集 recall 回到 ≥90% 且其余指标无回归（>1%）。

### Phase 4 — 精确率收紧：相关性阈值 + 拒答治理

- 动作：注入过滤从 `overlap>0` 升级为 IDF 相关性阈值（治理 q19「世界杯」类单 token 误命中）；必要时多 token 重叠要求按查询长度分级。
- 验收：拒答 ≥90%、precision@5 ≥60%、recall@5 ≥95% 全部达标，写最终基线，更新 MEMORY-EVAL.md，commit。

## 回放指引

每个 Phase 一个 commit（message 带 `memory-opt phase-N`），阶段结论与本文件同步更新；基线变迁记录在 `tests/eval/baseline.json` 与 `docs/MEMORY-EVAL.md` §5。
