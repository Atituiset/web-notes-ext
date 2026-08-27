# Memory Eval 实操手册（复刻指南）

> 这份文档记录 Markpilot 记忆评测体系的**完整工作方式与运行方法**，目的是让你能把同一套「评测驱动迭代」方法复刻到任何检索/召回系统上。
> 配套：`docs/MEMORY-EVAL.md`（设计文档）、`docs/plans/memory-opt-roadmap.md`（各阶段决策记录）。

---

## 1. 方法论闭环（这套方式的本质）

```
写数据集（语料+带标准答案的查询）
   → harness 驱动【未经修改的线上代码】跑检索
   → 出指标（recall/precision/拒答/延迟）
   → 记录基线
   → 每次改动后重跑，与基线对比
   → 达标就写新基线，不达标就用失败明细定位下一刀切哪
```

三条铁律：

1. **评真代码，不评替身**——harness 里跑的是生产那份 `memory.ts`，一行不改。指标才有意义。
2. **数据集先于优化**——先把"什么叫对"标注出来（expect/relevant），再谈改进。否则所有"感觉变好了"都是幻觉。
3. **每个决策都要有失败明细撑腰**——harness 输出逐 query 的 expect vs got，所有调参（阈值/融合算法/模型选型）都由它裁决，全程 git 可回放。

## 2. 架构解剖（harness 怎么让浏览器跑真代码）

```
node tests/eval-memory.mjs
│
├─ staging（/tmp/wne-ext-staging）
│    ├─ dist + manifest + icons + _locales（扩展本体）
│    └─ eval/memory.mjs ← esbuild 把 src/lib/memory.ts 打成 ESM 单文件
│         （依赖 obsidian.js/db.js/markdown.js 自动带入，就是生产代码）
│
├─ Playwright launchPersistentContext（headed Chromium，加载扩展）
│    └─ 打开扩展页 panel.html 作为执行上下文，page.evaluate 内：
│         1. OPFS root 句柄写进 IndexedDB 的 handles/vault
│            → 记忆管线以为自己拿到了用户授权的 vault，实际写的是 OPFS 沙箱
│            → saveMemory / listMemories / searchMemories 全链路真实执行
│         2. import(chrome.runtime.getURL('eval/memory.mjs')) 拿到生产模块
│         3. 逐条 saveMemory 灌语料（按 daysOld 回填 frontmatter 日期）
│         4. 逐条 searchMemories(q, {k:5})，performance.now() 计时
│
├─ dense（向量）通道：page.exposeFunction('__denseRankNode', fn)
│    页面里 mem.setDenseRanker((q, c) => window.__denseRankNode(q, c))
│    → 检索时页面通过 RPC 调 node 侧的 embedding（minilm 端侧 / OpenRouter / NVIDIA 三通道）
│
└─ node 侧：收 queryResults → 算指标 → console 表格
            → /tmp/memory-eval-report.json（逐 query 明细）
            → 与 tests/eval/baseline.json 回归对比（任一指标掉 >1% 即 exit 1）
```

复刻时的关键技巧：

- **OPFS 当存储沙箱**：FileSystemDirectoryHandle 可结构化克隆存进 IndexedDB，`queryPermission` 天然 granted。任何基于 File System Access 的存储层都能这样被无感替换。
- **esbuild ESM 单文件**：生产代码是 iife bundle 没法 import，单独为评测打一个 ESM 入口文件放 staging 里 `import()`，保证测的是同一份源码。
- **exposeFunction 桥**：检索在页面里跑、重型资源（embedding 模型/API）在 node 跑，RPC 桥接。生产环境换成浏览器端侧通道时，接口（`setDenseRanker`）不变。

## 3. 数据集设计（tests/eval/dataset.mjs）

### 3.1 语料（40 条记忆）

字段：`{ id, scope, body, tags, confidence, pinned, hits, daysOld }`

- **类别均衡**：preference / fact / correction / conclusion 各 1/4——对应真实记忆里最常见的四种语义
- **中英 70/30**：覆盖中文 bigram 与英文分词两条 tokenize 路径（复刻时按你的语种分布调）
- **daysOld**：runner 换算成 created/updated 回填，测 recency 衰减
- **3 组知识更新对**：同一事实的新旧两版（旧版 daysOld 大、confidence 低），测"新版必须排在旧版前"
- **2 条 pinned**：测"pinned 永远注入"的设计行为

### 3.2 查询（37 条，带标注）

字段：`{ id, q, expect, relevant, expectBefore?, category }`

- `expect`：必须召回的（recall 判定）
- `relevant`：所有算相关的（precision 判定，expect 的超集——标注时把"也可接受"的都列上，否则 precision 是口径假象）
- `expectBefore`：知识更新对的新旧 id（排序判定）

类别即能力面，按你想验证的系统短板设计：

| 类别 | 测什么 |
|---|---|
| fact-recall / preference-recall | 基本召回 |
| knowledge-update | 新旧版排序（时间信号是否被保留） |
| tag-boost | 正文无关键词时 tags 能否补上 |
| abstain | 语料里没有 → 必须零注入（拒答能力） |
| en-mixed / paraphrase | 分词路径 / 语义改述（词法 vs 向量的分水岭） |
| noise-robust | 词面高重合但语义无关，不被误导 |

### 3.3 噪声池

`makeNoise(n)` 用确定性 LCG（固定种子）生成，只进延迟-规模曲线，不进质量指标。每次运行结果可复现。

## 4. 怎么跑

```bash
npm run build                        # 先构建扩展

# 默认（端侧 MiniLM，免 key，模型缓存在 /tmp/hf-cache）
node tests/eval-memory.mjs
npm run eval:memory                  # 等价

# OpenRouter 通道（key 只走环境变量）
DENSE_CHANNEL=openrouter OR_KEY=sk-or-... node tests/eval-memory.mjs

# NVIDIA 通道（e5 系模型，地板要按模型调）
DENSE_CHANNEL=nvidia NV_KEY=nvapi-... DENSE_FLOOR=0.2 node tests/eval-memory.mjs

# 写基线（检索算法变更验证后）
node tests/eval-memory.mjs --write-baseline

# 跳过延迟-规模段（快速出质量指标；API 通道默认自动跳）
SKIP_LATENCY=1 node tests/eval-memory.mjs
```

判读输出：

- 指标总表 + 分类明细（哪个能力面掉了）
- **失败 query 明细**（expect vs got——所有优化决策的弹药）
- 基线对比表（±%，>1% 判回归；通道或口径不一致时只展示不判）
- `/tmp/memory-eval-report.json`：逐 query 的命中/耗时，调参分析用

## 5. 指标口径（复刻时抄这个定义）

| 指标 | 定义 | 备注 |
|---|---|---|
| recall@K | expect 至少一条进 top-K 的比例 | 只统计可答查询 |
| precision@5 | top5 命中 relevant ÷ **top5 中非 pinned 席位数** | pinned 是设计注入，分母含它数值会被结构性压扁 |
| MRR | 首个命中的排名倒数均值 | |
| 拒答正确率 | expect 为空的查询零注入的比例 | **排除 pinned 后判定**（pinned 永远注入是特性） |
| 知识更新正确率 | 更新对里新版排名 < 旧版的比例 | |
| 延迟 | 单次检索 p50/p95/max + 规模曲线 | |

## 6. 复刻到其他系统要换什么、留什么

**换掉（你的系统侧）**：

- 存储接入：把"OPFS 当 vault"换成你系统的存储沙箱（内存替身也行，但优先真实后端）
- 数据集：语料主题换成你的领域，**类别框架照搬**（fact/preference/correction/conclusion + 知识更新对 + pinned 类特殊条目）
- 检索调用：把 `searchMemories` 换成你的检索函数（harness 只要求输入 query、输出有序结果列表）
- dense 通道：换成你的 embedding 来源

**留下（方法论本体）**：

- staging + esbuild ESM + OPFS/沙箱的「真代码」执行结构
- 指标口径（尤其 precision 分母排除设计注入项、拒答排除永远注入项）
- 基线文件 + 回归对比 + `--write-baseline` 流程
- 失败明细驱动的调参纪律：每轮改动必须说出"哪个 query 从 ✗ 变 ✓ 了"

## 7. 踩坑记录（都是真撞过的）

1. **OPFS 拒绝非 ASCII 文件名**：进程 locale 未安装时（WSL 缺 `zh_CN.UTF-8`），CJK 文件名抛 `TypeMismatchError: path exists but was not an entry of requested type`——报错文案完全误导。harness 别乱设 `LANG`。
2. **e5 系模型 query/passage 非对称**：预热把查询文本以 passage 类型缓存，非对称被破坏后噪声全面失真（abstain 0/4）。**向量缓存键必须带类型前缀**（`type + '\n' + text`）。
3. **API 通道限流**：免费 embedding 有日限额（OpenRouter ~50 req/日）。批量调用（50 条/次）+ 429 退避 + 评测前预热（全量仅 ~2 次调用）。所谓"浏览器崩溃"实为 API 慢调用撞上命令超时。
4. **sim 地板是模型相关的**：换 embedding 模型必须重测噪声上限（MiniLM 0.33 / liquid 0.33 / nemotron-3 0.2），别抄常数。
5. **RAG 融合别用 RRF 名次融合**：它会抹掉 sparse 分里的 recency/hits 量级，知识更新场景新旧版排错序（实测 100%→0%）。用加和融合保留时间信号。
6. **改述/跨语种是词法检索与向量检索的分水岭**：词法在 paraphrase 子集只有 37.5%，这是向量通道的入场证据；缺这组查询你会永远以为词法够用。

## 8. 本次实战的指标轨迹（复刻时的参照系）

| 阶段 | recall@5 | precision@5 | 拒答 | 关键动作 |
|---|---|---|---|---|
| 词面检索 v1 | 100%* | 24.8%（口径假象） | 50% | 停用词/词干/IDF/缓存 |
| 词面检索 v2 | 100%* | 60.3%（新口径） | 75% | *未含改述集 |
| +paraphrase 探测 | 82.8% | 53.6% | 75% | 词法天花板实证 |
| +混合向量（MiniLM） | 93.9% | 59.9% | 100% | tag 过滤+真空门限+名次帽 |
| +NVIDIA 通道 | **97.0%** | **66.7%** | **100%** | e5 系模型+类型化缓存键 |
