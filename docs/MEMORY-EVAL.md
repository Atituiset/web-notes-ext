# Markpilot Memory 检索评测体系

> 状态：v1（2026-08-28）· 配套 `tests/eval-memory.mjs`
> 上游文档：`docs/MEMORY-DESIGN.md`（记忆系统设计）
> 目标：给记忆检索/召回层一套**可重复、可进 CI 的自动化评测**——检索算法的每次迭代（阈值、分词、混合检索、遗忘参数）都用同一把尺子对比，用数据说话而不是凭感觉。

---

## 1. 评什么 / 不评什么

| 范围 | 说明 |
|---|---|
| ✅ 检索召回层 | `searchMemories` 全链路：listMemories → 打分 → 过滤 → top-K → hits++ |
| ✅ 指标 | recall@1 / recall@5 / precision@5 / MRR / 拒答正确率 / 知识更新正确率 / 延迟（p50/p95/max + 规模曲线） |
| ❌ LLM 提取/压缩质量 | 已由 `tests/e2e-opencode.mjs`（真实模型）覆盖；强不确定性、不进 CI |

全程**零 LLM 调用**，结果确定（同一数据集两次运行指标一致，允许 ±1% 的浮点噪声）。

## 2. 架构：在真实代码路径上评测

```
dataset.mjs (40 记忆 + 25 查询 + 噪声生成器)
      │
Playwright 启动扩展（staging = dist + manifest + icons + _locales + eval/memory.mjs）
      │
扩展页上下文内（未经修改的线上代码）：
      │  1. OPFS root 句柄写入 IndexedDB handles/vault  ← OPFS 充当 vault
      │  2. esbuild 单文件 import src/lib/memory.ts（bundle 自动带入 obsidian/db/markdown 依赖）
      │  3. saveMemory ×40（按 daysOld 回填 frontmatter 日期）
      │  4. searchMemories ×25（performance.now 逐条计时）
      │  5. 注入噪声至 100/500/1000 条，固定 5 查询测延迟-规模曲线
      │
node 侧：指标计算 → console 表格 + /tmp/memory-eval-report.json → 基线回归对比
```

关键决策：

- **OPFS 当 vault，不抽象存储后端**——`obsidian.js` 的 vault 句柄本来就持久化在 IndexedDB（FileSystemDirectoryHandle 可结构化克隆），OPFS root 写进去后，`saveMemory`/`listMemories`/`searchMemories` 全链路就是生产代码，无一行改动、无"测试专用替身"。
- **基线对比模式**：首次 `--write-baseline` 把指标写入 `tests/eval/baseline.json`；后续运行自动对比，任一指标下降超过 1% 即 FAIL——评测的意义是**防回归**，不是追求绝对数值。

## 3. 数据集设计

### 3.1 记忆语料（40 条）

preference / fact / correction / conclusion 四类均衡，**中文 70% + 英文 30%**（覆盖 bigram 与英文分词两条 tokenize 路径）。内含：

- **3 组知识更新对**：同一事实的新旧两版（旧版 daysOld 大、置信度低），测更新场景排名
- **2 条 pinned**：测「pinned 永远注入且排最前」的设计行为
- **hits / daysOld 分布**：覆盖复述效应与 recency 衰减两个排序因子

### 3.2 查询（25 条，带标准答案）

| 类别 | 数量 | 测什么 |
|---|---|---|
| fact-recall | 7 | 单事实命中（含 CSS 标签检索） |
| preference-recall | 4 | 偏好类记忆（多答案） |
| knowledge-update | 3 | 新版必须排在旧版前 |
| tag-boost | 3 | 正文无关键词、靠 tags 命中 |
| abstain | 4 | 语料无相关记忆 → 期望零注入（**排除 pinned 后判定**，pinned 必注入是设计特性） |
| en-mixed | 3 | 英文分词路径 |
| noise-robust | 1 | 词面高重合但语义无关，不应误导 |

### 3.3 噪声池

`makeNoise(n)`：确定性 LCG 生成（模板 × 词表），只用于延迟-规模曲线，不进 recall 评测。每次运行全新浏览器 profile + 全新 OPFS，天然隔离。

## 4. 指标定义

- **recall@K**：expect 中至少一条出现在 top-K 的比例
- **precision@5**：top5 中属于 expect 的比例（可答查询）
- **MRR**：首个命中答案的排名倒数均值
- **拒答正确率**：expect 为空的查询中，排除 pinned 后零注入的比例
- **知识更新正确率**：更新对中新版排名 < 旧版排名的比例
- **延迟**：单查询 `searchMemories(k=5)` 的 p50 / p95 / max

## 5. 基线

### v4（2026-08-28，混合召回 · NVIDIA nemotron-3-embed-1b 通道，floor 0.2）—— 全部达标线达成

| 指标 | 数值 | 达标线 |
|---|---|---|
| recall@5 | **97.0%** | ≥95% ✅ |
| precision@5 | **66.7%** | ≥60% ✅ |
| 拒答正确率 | **100%** | ≥90% ✅ |
| 知识更新正确率 | **100%** | =100% ✅ |
| paraphrase 子集 | **11/12 (91.7%)** | ≥90% ✅ |
| MRR | 0.46 | — |

唯一失败 q26（语义跳跃——MiniLM/e5-small/mpnet/liquid/nemotron 五个模型一致失败，确证为数据级难例）。
工程教训：e5 系模型的 query/passage 非对称嵌入要求缓存键带类型前缀，否则噪声全面失真。
通道对比与选型见 `docs/plans/memory-opt-roadmap.md` 补充 2。

### v3（2026-08-28，混合召回：sparse 词法 + dense 端侧向量，真空门控加和融合）

### v3（2026-08-28，混合召回：sparse 词法 + dense 端侧向量，真空门控加和融合）

| 指标 | 数值 | 对比 v2 |
|---|---|---|
| recall@5 | **93.9%** | +11.1%（改述子集 3/8→10/12 驱动） |
| precision@5 | **59.9%** | 口径 v2 下可比值大幅提升（dense 真空门限 + 名次帽 TOP_N=2） |
| 拒答正确率 | **100%** | +25%（tag 感知过滤：正文单 bigram 偶然命中不再算证据） |
| 知识更新正确率 | **100%** | 持平（加和融合保留 recency/hits 量级，RRF 已被数据否决） |
| MRR | 0.45 | -0.04（dense 注入改变榜首构成的预期波动） |
| 延迟（p50） | 40 条 ≈50ms；1000 条 ≈400ms（含评测桥 RPC 开销） | 达标线边缘 |

架构与模型选型（三轮探针实证，详见 `docs/plans/memory-opt-roadmap.md` Phase 3/4）：
- `setDenseRanker` 注入接口解耦稠密排序与 embedding 通道；模型 Xenova/paraphrase-multilingual-MiniLM-L12-v2（384d）——e5-small 与 mpnet-base-v2 均因「拒答噪声与真实命中 sim 不可分」被数据否决
- 融合：真空门控加和（`maxSparse≥20` 时 dense 静默；词面真空时 dense 名次分档增益主导）
- 已知模型边界：q26（语义跳跃）、q35（跨语种）在三个候选模型下均与拒答噪声不可分，非 embedding 可解

### v2（2026-08-28，词法增强：停用词 + 词干归一 + IDF + mtime 缓存）

### v2（2026-08-28，词法增强：停用词 + 词干归一 + IDF + mtime 缓存）

| 指标 | 数值 | 对比 v1 |
|---|---|---|
| recall@5 | **100%** | 持平 |
| recall@1 | 4.8% | 持平（pinned 永远占第一，设计行为） |
| precision@5 | 24.8% | 持平 |
| MRR | 0.49 | -0.01（IDF 重排的浮点噪声级波动） |
| 拒答正确率 | **75%** | **+25%**（停用词消灭了 the/to/do 伪相关） |
| 知识更新正确率 | **100%** | **+50%**（词干归一对齐 json/json1、query/querying） |
| 延迟（p50） | 40 条 ≈24ms；1000 条 **≈337ms** | **3.4× 提速**（mtime 缓存，1000 条从 1.1s 降下来） |

### v1（2026-08-28，sparse 词面检索，首次基线）

| 指标 | 数值 |
|---|---|
| recall@5 | 100% |
| 拒答正确率 | 50% |
| 知识更新正确率 | 50% |
| 延迟 | 1000 条 p50≈1.1s |

## 6. 评测发现的系统短板与迭代状态

| # | 短板 | 状态 |
|---|---|---|
| 1 | 无词形归一（json/json1、query/querying 互不匹配） | ✅ 已修（`naiveStem`，knowledgeUpdate 50%→100%） |
| 2 | 无停用词过滤（the/to/do 蒙混过 overlap>0） | ✅ 已修（停用词表 + IDF 加权，拒答 50%→75%） |
| 3 | 延迟随规模线性恶化（全量读文件） | ✅ 已修（mtime 缓存，1000 条 p50 1.1s→0.34s） |
| 4 | 单 bigram 误命中：「世界杯」经「世界」命中「隔离世界」（q19） | ⚠️ 已知词法极限——单 token 重叠无法区分；路线：相关性阈值替代 count 阈值，或等改述查询证明需要语义检索 |

已知非问题（设计行为，勿误报）：pinned 记忆在所有结果中排第一——pinned 语义就是"永远注入"，评测口径已排除其对拒答与 recall@1 的干扰。

## 7. 使用方式

```bash
npm run build
node tests/eval-memory.mjs                  # 跑评测 + 基线回归对比
node tests/eval-memory.mjs --write-baseline # 检索算法变更验证后，记录新基线
# 或
npm run eval:memory
```

明细报告（逐 query 命中/耗时）输出到 `/tmp/memory-eval-report.json`。

## 8. 环境坑（排查记录）

- **OPFS 不接受非 ASCII 文件名**：Chromium 在进程 locale 未安装时（如 WSL 缺 `zh_CN.UTF-8`，`locale -a` 查无此项），OPFS 对 CJK 文件名抛 `TypeMismatchError: The path supplied exists, but was not an entry of requested type`——错误信息极具误导性（实际含义是"名字不合法"）。评测 harness 不能注入 `LANG=zh_CN.UTF-8`（e2e UI 语言脚本需要，但本 harness 不依赖 UI 语言，已移除）。真实用户的 vault 是普通文件系统，无此限制。
