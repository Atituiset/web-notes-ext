# Markpilot Memory 设计文档

> 状态：设计稿 v1.0（2026-08-25）
> 上游文档：`docs/DESIGN.md`（主设计）
> 理论依据：业界通行的 LLM Agent Memory 分层体系（Working / Short-term / Episodic / Semantic / Long-term，参见 Generative Agents、Mem0、Letta/MemGPT、Claude memory 等公开系统）
> 目标：给 Markpilot 加**跨会话、跨页面的长期记忆**——记住用户的知识背景、偏好、结论，让 AI 回答随使用越来越"懂你"。

---

## 0. 理论依据

业界通行五层记忆体系中，Markpilot 是浏览器插件、单用户、本地优先，裁剪如下：

| 业界分层 | Markpilot 对应 | 现状 |
|---|---|---|
| Working | LLM context window（context.js 组装） | ✅ 已有 |
| Short-term | 当前会话线程（threads store，最近 8 条） | ✅ 已有（多轮记忆） |
| Episodic | threads 持久化 + ai-qa 笔记 | ✅ 已有 |
| **Semantic** | **从笔记/问答中提取的用户知识资产** | ❌ 本期核心 |
| Procedural | 不做（无工具执行场景） | 跳过 |

**关键架构决策（Claude memory 的 Markdown 文件模式）**：记忆用 **Markdown 文件存进 Obsidian vault**，而不是向量库。理由：
1. 与产品灵魂一致——数据归用户的 vault，可读可改可在 Obsidian 图谱里看
2. 插件本地无 embedding 服务依赖；检索用关键词/标签/frontmatter 过滤即可起步（记忆量级：个人用户 <1000 条，BM25 式匹配够用）
3. 该取舍"牺牲检索效率换透明性和可操作性"，个人规模下是正收益
4. 向量检索列为 V2（可选接 Ollama embedding，本地模型已有）

## 1. 记忆模型

### 1.1 记忆条目类型（Semantic Memory 落地形态）

```markdown
---
type: memory            # memory 固定
scope: user | domain    # user=全局偏好；domain=某领域知识
domain: clangd          # domain 型必填，如 clangd / rust / cpp
source: https://...     # 记忆来源页面（溯源）
created: 2026-08-25
updated: 2026-08-25
confidence: high        # high | medium | low（质量信号，供管理面板审阅）
pinned: false           # 钉选，永不遗忘/压缩
hits: 0                 # 检索命中次数（复述效应）
tags: [preference]      # preference | fact | conclusion | correction
---
用户偏好简洁的中文回答，代码注释保留英文原文。
```

存储位置：`<vault>/Markpilot-Memory/` 目录（与 Clippings 平级），一条记忆一个文件，文件名 `<domain>-<slug>.md`。

### 1.2 写入管线（Write Pipeline）

```
AI 回答完成 ──► 提取候选 ──► 打分 ──► 去重/合并 ──► 写入 vault
   (Q&A对)      (LLM 结构化输出)  (规则)    (frontmatter 匹配)
```

- **提取时机**：问答完成后异步进行（不阻塞 UI），用当前对话模型发一次结构化提取请求（JSON mode 或 prompt 约定），prompt 要求只提取"值得跨会话记住的内容"
- **忽略规则**（存储决策树）：寒暄不记；纯页面转述不记；只记——用户显式表达的偏好/纠正、跨页面有价值的结论、"我原来理解错了→现在对了"这类认知修正
- **打分**：MVP 用规则不用 LLM 打分——用户手动点「记住这条」直接入库（importance=max）；自动提取的默认 confidence=medium
- **去重/合并**：写入前扫描同 domain 的已有记忆 frontmatter + 正文关键词重叠；命中则 enrich（追加+更新 updated），矛盾时保留两条并标 `contested: true`

### 1.3 读取管线（Read Pipeline → context.js 扩展）

```
用户提问 ──► 关键词抽取(question) ──► 记忆匹配 ──► 排序 ──► 注入 system/user
              (分词+domain识别)        (vault 扫描)   (recency×hits×pin)
```

- 匹配：问题分词后与记忆 tags/domain/正文做词面重叠评分（TF 式），取 top-K（预算 1500 tokens 内）
- 排序：`score = pin×1000 + hits×2 + recency_boost`，命中即 `hits++`（复述效应）
- 注入位置：context builder 的【材料0】用户长期记忆（在页面正文之前——它是"用户是谁"，优先级最高）
- 用户可在设置里关闭记忆注入（隐私开关）

### 1.4 遗忘与生命周期

- 无自动删除。`pinned: false` 且 `hits === 0` 且 `updated` 超 90 天的记忆在「记忆管理」面板标记为"冷"，供用户手动清理
- pinned 记忆永远注入且排最前（Pinned Memory 模式）

## 2. 功能与交互

| 功能 | 入口 | 行为 |
|---|---|---|
| 手动记忆 | 回答操作栏加「🧠 记住」按钮 | 把该 Q&A 结论存为一条记忆（用户手势，importance 最高）|
| 自动提取 | 设置开关，默认关 | 问答完成后异步提取候选，panel 角标提示"发现 N 条可记忆"，用户确认后写入 |
| 记忆管理面板 | options 页新 tab | 列表/搜索/编辑/钉选/删除记忆文件 |
| 记忆注入 | 设置开关，默认开 | 提问时自动带上 top-K 记忆 |

## 3. 实施计划（Phase 划分，每 Phase 一次 commit + 验证）

### Phase 1 — 记忆读写基础（vault 层）
- `src/lib/memory.js`：listMemories / readMemory / writeMemory / deleteMemory / pinMemory（基于 obsidian.js 的 fs-access 通道 + markdown.js frontmatter 解析）
- 文件格式按 1.1；vault 未授权时报错降级（记忆功能整体禁用并提示）
- **验证**：Playwright 加载扩展，mock vault（临时目录 showDirectoryPicker 无法自动化——用 JS 直连 OPFS 或手工授权目录），写→读→改→删往返一致；Obsidian 中打开显示正常

### Phase 2 — 手动记忆 + 注入
- panel 回答操作栏加「🧠 记住」：把当前 Q&A 经模板化为一条记忆（LLM 二次调用压缩成 1-2 句，OpenRouter 免费模型即可）写入 vault
- context.js 增加 memories 参数，注入【材料0】；askLLMWith 读 vault 匹配 top-K 并 hits++
- **验证**：OpenRouter 免费模型（如 `*:free` 系列）真实调用——第一问告知一个事实，点记住，新会话第二问验证模型能引用该事实

### Phase 3 — 自动提取（默认关）
- 问答完成后的后台提取请求 + 角标确认流（防未经同意写 vault）
- 忽略规则 + 去重合并逻辑
- **验证**：构造含明确偏好的对话，确认提取候选出现且垃圾对话不产生候选；重复问同类问题验证合并不重复建文件

### Phase 4 — 记忆管理面板 + 生命周期
- options 新 tab：列表（按 domain 分组）/ 搜索 / 编辑 / 钉选 / 删除 / 冷记忆提示
- **验证**：面板 CRUD 全链路 + Obsidian 同步查看

### 测试策略
- 单元：memory.js 纯函数（匹配评分、frontmatter 合并）用 node:test 直接跑
- E2E：现有 Playwright harness 扩展；LLM 用 OpenRouter `meta-llama/llama-3.3-70b-instruct:free` 或同期可用免费模型（免费模型不稳定，测试代码里模型名走 settings 可配）
- 每 Phase 结束：commit message 带 `[memory-phase-N]`，跑全量语法检查 + 该 Phase 验证脚本通过才推送

## 4. 风险与开放问题

- **showDirectoryPicker 无法在 Playwright 自动化**：Phase 1 验证需人工授权一次，或先用 OPFS (origin-private fs) 做 CI 替身——倾向后者，OPFS 实现与 File System Access 同接口
- **免费模型的结构化输出能力参差**：提取 prompt 要宽容解析（正则兜底 JSON）
- **vault 未授权时记忆功能整体不可用**：可接受（与导出同一前提），UI 明确提示而非静默失败
- 开放：是否把 ai-qa 笔记也纳入检索源（当前只查 Markpilot-Memory/）——倾向 V2
